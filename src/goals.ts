import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { projectPath, record } from "./contract"
const exec=promisify(execFile)
const object={type:"object",additionalProperties:true} as const
const native=Rpc.define({id:"opencode.goal",methods:{get:{input:{type:"object",properties:{sessionID:{type:"string"}},required:["sessionID"]},output:{anyOf:[object,{type:"null"}]}}},events:{}})
export function taskGate(tasks:unknown){
  if(!Array.isArray(tasks)) throw Error("Missing task inventory")
  let open=0,inProgress=0
  for(const raw of tasks){const t=record(raw);if(t.status==="open")open++;else if(t.status==="in_progress")inProgress++;else if(t.status!=="closed")throw Error("Unknown task state")}
  return {open,inProgress,remaining:open+inProgress,passed:!open&&!inProgress}
}
export function chooseProject(paths:string[],at:string|null,explicit?:string){
  if(explicit){const p=projectPath(explicit);if(paths.includes(p)||p===at)return p;throw Error("Project is not linked to this session or its working directory")}
  if(at)return at
  if(paths.length===1)return paths[0]
  throw Error(paths.length?`Specify the project: ${paths.join(", ")}`:"No linked project. Run in a pj project or explicitly link the session first.")
}
export async function registerGoals(ctx:Plugin.Context,vault:string){
  const pj=async(cwd:string,args:string[])=>{
    const {stdout}=await exec(process.env.OPENCODE_PJ_BIN||"pj",[...args,"--json"],{cwd,timeout:5000,maxBuffer:8*1024*1024})
    const x=JSON.parse(stdout);if(!x.ok)throw Error("pj lookup failed");return x.data
  }
  const read=async(sessionID:string)=>{
    const raw=await ctx.rpc(native).get({sessionID})
    if(raw==null)return null
    const g=record(raw);if(!["active","paused","complete"].includes(String(g.status)))throw Error("Unknown native goal state")
    return {id:String(g.id),status:String(g.status),objective:String(g.objective)}
  }
  const gate=async(p:string)=>{
    const d=await pj(`${vault}/${projectPath(p)}`,["show"])
    if(d.project?.path!==p)throw Error("pj returned another project")
    return taskGate(d.project.tasks)
  }
  const select=async(id:string,explicit?:string)=>{
    const d=await pj(vault,["list","--session",id,"--fields","path"])
    const paths=d.projects.map((p:{path:string})=>projectPath(p.path))
    const dir=(await ctx.session.get({sessionID:id})).location.directory
    let at:null|string=null
    if(dir.startsWith(vault+"/projects/")){const s=await pj(dir,["show"]);at=projectPath(s.project.path)}
    return chooseProject(paths,at,explicit)
  }
  const run=async(id:string,action:string,objective?:string,p?:string)=>{
    const current=await read(id),key=`goal-project:${id}`
    const saved=await ctx.storage.get(key)
    const b=saved&&typeof saved==="object"&&!Array.isArray(saved)?record(saved):null
    const binding=b&&current&&b.id===current.id?projectPath(b.path):null
    if(action==="status"){
      const g=binding?await gate(binding):null
      return {goal:current,project:binding,gate:g,complete:current?.status==="complete"&&(!g||g.passed)}
    }
    if(action==="resume"){
      if(current?.status!=="paused")return {goal:current,changed:false}
      if(binding)await gate(binding)
      await ctx.session.command({sessionID:id,name:"goal",text:"resume"})
      return {goal:await read(id),changed:true}
    }
    if(current?.status==="active"||current?.status==="paused")throw Error("Goal already exists; resume it or explicitly clear it before replacing it")
    let text=(objective??"").trim()
    let path:string|null=null
    if(action==="project"){
      path=await select(id,p); await gate(path)
      text=`${text||"Доведи выбранный проект до результата."}\nПроект pj: ${path}. Работай в этом конкретном проекте. Дополнительный обязательный критерий: перед итогом вызови goal.manage(status) и покажи свежий gate.passed=true (open=0, inProgress=0). Не закрывай задачи ради счётчика. При настоящем блокере остановись с конкретным запросом, не объявляй завершение. Ноль задач сам по себе не доказывает результат.`
    }else if(action!=="start")throw Error("Unknown goal action")
    if(!text||/^(pause|resume|clear)$/i.test(text)||/^["'“‘]/.test(text)&&/["'”’]$/.test(text))throw Error("Use a plain, nonempty objective")
    await ctx.session.command({sessionID:id,name:"goal",text})
    const goal=await read(id);if(!goal||goal.objective!==text)throw Error("Goal readback mismatch; inspect status before retry")
    if(path)await ctx.storage.set(key,{id:goal.id,path});else if(saved)await ctx.storage.remove(key)
    return {goal,project:path,gate:path?await gate(path):null,changed:true}
  }
  await ctx.tool.transform(editor=>{
    editor.namespace({name:"goal",description:"Manage the native goal of this calling session, with optional pj finish checks."})
    editor.add({name:"manage",description:"Set, read or resume your own native goal. project pins a linked pj project. status rereads open and in-progress tasks. Resume only when user input cleared the blocker; do not resume a user stop without permission. On an unknown mutation result inspect status, do not retry automatically.",
      input:{type:"object",properties:{action:{type:"string",enum:["status","start","resume","project"]},objective:{type:"string",maxLength:3000},project:{type:"string"}},required:["action"],additionalProperties:false},output:object,options:{namespace:"goal",codemode:true},
      execute:async(input,c)=>{const v=input as {action:string;objective?:string;project?:string};const output=await run(c.sessionID,v.action,v.objective,v.project);return {output,content:JSON.stringify(output)}}})
  })
  await ctx.command.transform(e=>e.add({name:"goal-pj",description:"Native project goal: [projects/path] [objective], or pause|resume|clear",execute:async c=>{
    const t=c.prompt.text.trim()
    if(["pause","resume","clear"].includes(t)){
      const s=await run(c.sessionID,"status");if(!s.project)throw Error("No project goal for this session")
      if(t==="resume")await run(c.sessionID,"resume");else await ctx.session.command({sessionID:c.sessionID,name:"goal",text:t})
      return
    }
    const match=/^(projects\/\S+)(?:\s+([\s\S]*))?$/.exec(t)
    await run(c.sessionID,"project",match?match[2]:t,match?.[1])
  }}))
  await ctx.session.hook("context",async event=>{
    const saved=await ctx.storage.get(`goal-project:${event.sessionID}`)
    if(!saved||Array.isArray(saved)||typeof saved!=="object")return
    try{
      const b=record(saved),g=await read(event.sessionID)
      if(!g||g.id!==b.id||g.status!=="active")return
      const path=projectPath(b.path),state=await gate(path)
      event.system.push({type:"text",text:`/goal-pj ${path}: fresh pj state open=${state.open}, in_progress=${state.inProgress}, project gate ${state.passed?"PASS":"NOT MET"}. On a human blocker stop and report it, never close tasks just to pass.`})
    }catch{event.system.push({type:"text",text:"/goal-pj: project state unavailable; do not claim completion."})}
  })
}
