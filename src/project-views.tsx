import type { Context } from "@opencode/plugin/tui/context"
import { For, Show } from "solid-js"
import type { Project, Task } from "./contract"

export function taskLanes(tasks: Task[]) {
  return (["open", "in_progress", "closed"] as const).map((status,i)=>({
    title:["Open","In progress","Closed"][i], tasks:tasks.filter(t=>t.status===status),
  }))
}
// Dependencies point from prerequisites to dependents. Keep cycles and missing
// references visible rather than pretending such tasks belong to a ready layer.
export function taskLevels(tasks: Task[]) {
  const pending=new Map(tasks.map(t=>[t.id,t])),done=new Set<string>(),levels:{title:string;tasks:Task[]}[]=[]
  while(pending.size){
    const next=[...pending.values()].filter(t=>t.deps.every(d=>done.has(d)))
    if(!next.length){levels.push({title:"Unresolved dependencies / cycles",tasks:[...pending.values()]});break}
    levels.push({title:levels.length?`Layer ${levels.length+1}`:"No prerequisites",tasks:next})
    for(const t of next){pending.delete(t.id);done.add(t.id)}
  }
  return levels
}
export function showProjectView(ctx: Context,p:Project,mode:"graph"|"kanban",open:(t:Task)=>void) {
  const lanes=mode==="graph"?taskLevels(p.tasks):taskLanes(p.tasks)
  ctx.ui.dialog.show(()=> <box flexDirection="column" padding={1} gap={1}>
    <text><b>{p.name} · {mode==="graph"?"Task graph":"Task kanban"}</b></text>
    <text fg={ctx.theme.text.muted}>{mode==="graph"?"Prerequisites → task · click a task for details":"Tasks by status · click to inspect or change status"}</text>
    <Show when={p.tasks.length} fallback={<text>No tasks in this project.</text>}>
      <scrollbox height={Math.max(4,Math.min(23,ctx.renderer.height-9))}>
        <box flexDirection={mode==="graph"?"column":"row"} gap={1}>
          <For each={lanes}>{lane=><box flexDirection="column" flexGrow={1} flexBasis={mode==="kanban"?0:undefined} minWidth={0} gap={1}>
            <text fg={ctx.theme.text.muted}><b>{lane.title} ({lane.tasks.length})</b></text>
            <For each={lane.tasks}>{task=><box flexDirection="column" onMouseUp={e=>{if(e.button===0&&!e.isDragging){e.stopPropagation();ctx.ui.dialog.clear();open(task)}}}>
              <text wrapMode="word">{mode==="graph"&&task.deps.length?`${task.deps.join(", ")} → `:""}<b>{task.id}</b></text>
              <text wrapMode="word">{task.title}</text>
              <Show when={mode==="graph"||(!task.ready&&task.status!=="closed")}><text fg={ctx.theme.text.muted}>{task.status}{!task.ready&&task.status!=="closed"?" · blocked":""}</text></Show>
            </box>}</For>
          </box>}</For>
        </box>
      </scrollbox>
    </Show>
  </box>)
  ctx.ui.dialog.set({size:"large"})
}
