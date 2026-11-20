import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/tui/context"

// OpenCode can switch sessions inside the same process. Its launch arguments
// and Rex tab title no longer identify what that pane is showing.
function routeFile(session:string,block:string,pid:number) {
  const uuid="[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
  if(!new RegExp(`^session:${uuid}$`,"i").test(session)||!new RegExp(`^block:${uuid}$`,"i").test(block)||!Number.isSafeInteger(pid)||pid<1)return
  const dir=join(tmpdir(),`pj-rex-routes-${process.getuid?.()??"local"}`)
  return {dir,path:join(dir,`${session}.${block}.${pid}.json`)}
}
export function readRexRoute(session:string,block:string,pid:number):string|undefined {
  const file=routeFile(session,block,pid)
  try{if(file){const {id,at}=JSON.parse(readFileSync(file.path,"utf8"))
    if(typeof id==="string"&&/^ses_[A-Za-z0-9]{1,124}$/.test(id)&&at<=Date.now()&&Date.now()-at<12_000)return id
  }}catch{/* absent or stale is not an identity */}
}
export function publishRexRoute(ctx:Context){
  const file=routeFile(process.env.REX_SESSION??"",process.env.REX_BLOCK??"",process.pid)
  if(!file||!process.stdout.isTTY)return ()=>{}
  let prev="",at=0
  const tick=()=>{try{
    const r=ctx.ui.router.current(),id=r.type==="session"?r.sessionID:"",now=Date.now()
    if(id===prev&&now-at<4000)return
    mkdirSync(file.dir,{recursive:true,mode:0o700})
    writeFileSync(`${file.path}.tmp`,JSON.stringify({id,at:now}),{mode:0o600})
    renameSync(`${file.path}.tmp`,file.path);prev=id;at=now
  }catch{/* navigation must still work if local state is unavailable */}}
  tick();const timer=setInterval(tick,350)
  return ()=>{clearInterval(timer);try{rmSync(file.path,{force:true})}catch{}}
}
