import type {Context} from "@opencode/plugin/tui/context"
import type {BoxRenderable, MouseEvent, ScrollBoxRenderable} from "@opentui/core"
import {useKeyboard,useTerminalDimensions} from "@opentui/solid"
import {For,Show,createMemo,createSignal} from "solid-js"
import type {Project,Task} from "./contract"
import {layoutTaskGraph} from "./task-graph"

export function taskLanes(tasks:Task[]) {
  return (["open","in_progress","closed"] as const).map((status,i)=>({
    title:["Open","In progress","Closed"][i], tasks:tasks.filter(t=>t.status===status),
  }))
}
const state=(t:Task)=>t.status==="closed"?"Closed":t.status==="in_progress"?"In progress":t.ready?"Ready":"Blocked"
function release(action:()=>void) {
  let armed=false
  return {
    onMouseDown:(e:MouseEvent)=>{armed=e.button===0&&!e.isDragging;if(armed){e.preventDefault();e.stopPropagation()}},
    onMouseDrag:()=>{armed=false},
    onMouseUp:(e:MouseEvent)=>{const fire=armed&&e.button===0&&!e.isDragging;armed=false;if(fire){e.preventDefault();e.stopPropagation();action()}},
  }
}
function View(props:{ctx:Context;p:Project;mode:"graph"|"kanban";open:(t:Task)=>void}){
  const {ctx,p,mode}=props
  const terminal=useTerminalDimensions(), [width,setWidth]=createSignal(70), [selected,setSelected]=createSignal<string>(),[hover,setHover]=createSignal<string>()
  let outer:BoxRenderable,scroll:ScrollBoxRenderable,closing=false
  const close=()=>{if(!closing){closing=true;ctx.ui.dialog.clear()}}
  const enter=(task:Task)=>{if(closing)return;close();queueMicrotask(()=>props.open(task))}
  const lanes=taskLanes(p.tasks)
  // Unconnected work has no edges to draw. Keep it visible in a wrapping
  // grid instead of stretching the first rank many screens to the right.
  const referenced=new Set(p.tasks.flatMap(t=>t.deps)),connected=p.tasks.filter(t=>t.deps.length||referenced.has(t.id))
  const isolated=p.tasks.filter(t=>!t.deps.length&&!referenced.has(t.id))
  const graph=createMemo(()=>mode==="graph"?layoutTaskGraph(connected,Math.max(22,width()-5)):null)
  const isolatedCols=()=>Math.max(1,Math.min(3,Math.floor((width()-4)/22)))
  const order=()=>graph()?[...graph()!.nodes.slice().sort((a,b)=>a.y-b.y||a.x-b.x).map(n=>n.task),...isolated]:lanes.flatMap(l=>l.tasks)
  const current=()=>selected()??order()[0]?.id
  const move=(delta:number)=>{const tasks=order();if(!tasks.length)return;const idx=tasks.findIndex(t=>t.id===current());const next=tasks[Math.max(0,Math.min(tasks.length-1,idx+delta))];setSelected(next.id);scroll?.scrollChildIntoView(`pj-card-${next.id}`)}
  useKeyboard(e=>{
    if(closing || !["escape","up","down","left","right","return","enter"].includes(e.name))return
    e.preventDefault();e.stopPropagation()
    if(e.name==="escape"){close();return}
    if(e.name==="return"||e.name==="enter"){const task=order().find(t=>t.id===current());if(task)enter(task);return}
    move(e.name==="up"||e.name==="left"?-1:1)
  })
  const card=(t:Task,g?:{x:number;y:number;width:number;height:number},flowWidth?:number)=>{
    const emphasis=()=>current()===t.id||hover()===t.id
    const blocked=t.status==="open"&&!t.ready
    return <box id={`pj-card-${t.id}`} position={g?"absolute":"relative"} left={g?.x} top={g?.y} width={g?.width??flowWidth??"100%"} height={g?.height}
      border borderStyle={current()===t.id?"double":"rounded"} borderColor={emphasis()?ctx.theme.text.base:ctx.theme.text.muted} flexShrink={0} flexDirection="column" paddingX={1}
      onMouseOver={()=>setHover(t.id)} onMouseOut={()=>setHover(undefined)} {...release(()=>enter(t))}>
      <text fg={t.status==="closed"&&!emphasis()?ctx.theme.text.muted:ctx.theme.text.base} wrapMode="word" selectable={false} flexShrink={1}><b>{t.title}</b></text>
      <text fg={blocked?ctx.theme.text.feedback.error.base:ctx.theme.text.muted} wrapMode="none" selectable={false} flexShrink={0}>{mode==="graph"?state(t):[t.id,t.status==="open"?state(t):null].filter(Boolean).join(" · ")}</text>
    </box>
  }
  const height=()=>{
    const g=graph(),stack=width()<52,colWidth=Math.max(5,Math.floor((width()-6)/(stack?1:3))-4)
    const laneHeights=lanes.map(l=>1+l.tasks.reduce((n,t)=>n+3+Math.max(1,Math.ceil(Bun.stringWidth(t.title)/colWidth)),0))
    const content=g?g.height+g.warnings.length+(g.width>width()-4?1:0)+(isolated.length?2+5*Math.ceil(isolated.length/isolatedCols()):0):stack?laneHeights.reduce((a,b)=>a+b,2):Math.max(...laneHeights)
    return Math.max(2,Math.min(content,32,terminal().height-7))
  }
  return <box ref={el=>{outer=el}} onSizeChange={()=>{if(outer.width>0)setWidth(outer.width)}} flexDirection="column" paddingX={1}>
    <box flexDirection="row" justifyContent="space-between" height={1}>
      <text fg={ctx.theme.text.base} selectable={false}><b>{mode==="graph"?"Task graph":"Task kanban"}</b> · {p.name}</text>
      <box paddingX={1} {...release(close)}><text fg={ctx.theme.text.base} selectable={false}>Esc · Close</text></box>
    </box>
    <text fg={ctx.theme.text.muted} selectable={false}>{mode==="graph"?"Arrows point to dependent tasks":"Tasks by status"} · Click or ↑↓ Enter to open</text>
    <Show when={p.tasks.length} fallback={<text>No tasks in this project.</text>}>
      <scrollbox ref={el=>{scroll=el}} height={height()} scrollX={mode==="graph"} scrollY viewportCulling={false}>
        <Show when={graph()} fallback={<box flexDirection={width()<52?"column":"row"} gap={1}>
          <For each={lanes}>{lane=><box flexDirection="column" minWidth={0} flexGrow={1} flexBasis={width()<52?undefined:0}>
            <text fg={ctx.theme.text.base} selectable={false}><b>{lane.title} ({lane.tasks.length})</b></text>
            <For each={lane.tasks}>{t=>card(t)}</For>
          </box>}</For>
        </box>}>{g=><box flexDirection="column">
          <For each={g().warnings}>{w=><text fg={ctx.theme.text.muted}>{w}</text>}</For>
          <Show when={g().nodes.length}><box width={g().width} height={g().height} flexShrink={0} alignSelf="center">
            <text position="absolute" left={0} top={0} fg={ctx.theme.text.base} width={g().width} height={g().height} wrapMode="none" selectable={false}>{g().lines.join("\n")}</text>
            <For each={g().nodes}>{n=>card(n.task,n)}</For>
          </box></Show>
          <Show when={isolated.length}>
            <text fg={ctx.theme.text.muted} marginTop={g().height?1:0} selectable={false}>Independent tasks ({isolated.length})</text>
            <box width={Math.max(18,width()-4)} flexWrap="wrap" flexDirection="row" columnGap={1}>
              <For each={isolated}>{t=>card(t,undefined,Math.floor((width()-4-isolatedCols()+1)/isolatedCols()))}</For>
            </box>
          </Show>
        </box>}</Show>
      </scrollbox>
    </Show>
  </box>
}
export function showProjectView(ctx:Context,p:Project,mode:"graph"|"kanban",open:(t:Task)=>void) {
  ctx.ui.dialog.show(()=> <View ctx={ctx} p={p} mode={mode} open={open}/>)
  ctx.ui.dialog.set({size:"large",centered:true})
}
