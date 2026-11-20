import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { WorkspaceRPC } from "./rpc"
import { projectPath, record } from "./contract"
import { fitLabel } from "./picker"

export function footerText(paths:string[]) {
  const names=paths.map(p=>projectPath(p).replace(/^(projects|\.archived)\//,"").replace(/[\p{Cc}\p{Cf}]/gu,""))
  return names.length?`Project: ${fitLabel(names[0],32)}${names.length>1?` +${names.length-1}`:""}`:"Project: —"
}
export function PjFooter(props:{ctx:Context;sessionID?:string}){
  const [label,setLabel]=createSignal(""),[paths,setPaths]=createSignal<string[]>([])
  const rpc=props.ctx.client.rpc(WorkspaceRPC)
  createEffect(()=>{
    const id=props.sessionID;setLabel("");setPaths([])
    if(!id)return
    let closed=false,controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined
    const read=async()=>{
      controller?.abort();const own=controller=new AbortController()
      try{
        const r=record(await rpc.memberships({sessionID:id},{location:props.ctx.location??props.ctx.data.location.default(),signal:AbortSignal.any([own.signal,AbortSignal.timeout(7000)])}))
        if(r.sessionID!==id||!Array.isArray(r.paths))throw Error("Invalid membership result")
        const list=r.paths.map(projectPath);if(!closed&&!own.signal.aborted){setPaths(list);setLabel(footerText(list))}
      }catch{if(!closed&&!own.signal.aborted){setPaths([]);setLabel("Project: ?")}}
    }
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void read(),200)}
    const stops=[rpc.events.on("changed",schedule),props.ctx.data.on("server.connected",schedule)]
    // An external pj invocation in the configured vault may not emit an event
    // at the location of a different checkout's TUI.
    const periodic=setInterval(schedule,30_000);void read()
    onCleanup(()=>{closed=true;controller?.abort();clearTimeout(timer);clearInterval(periodic);stops.forEach(stop=>stop())})
  })
  return <Show when={label()}><text fg={props.ctx.theme.text.muted} selectable={false} wrapMode="none"
    onMouseUp={e=>{if(e.button===0&&!e.isDragging&&paths().length)void props.ctx.ui.dialog.alert({title:"Project memberships",message:paths().join("\n")})}}>{label()}</text></Show>
}
