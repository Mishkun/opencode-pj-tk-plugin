import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createComponent, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { errorMessage, project, projectArchiveDestination, projectStatuses, record, type Project, type Task } from "./contract"
import type { Operation } from "./bridge"
import { focusSession } from "./lifecycle"
import { activityGroups, inboxSessions, projectTaskBuckets, projectTree, relativeAge, sessionActivity, taskTree, type ProjectNode, type TaskNode, type ActivityGroupLabel } from "./projection"
import { fitLabel, fuzzyItems, pickerItems, projectSymbol } from "./picker"
import { WorkspaceRPC } from "./rpc"
import { isAbsolute } from "node:path"
import { loadNativeSessions } from "./native-inventory"
import { WorkspaceStore } from "./workspace-store"
import type { BoxRenderable } from "@opentui/core"

function Row(props: { ctx: Context; label: string; indent?: number; run: () => void; current?: boolean; bold?: boolean; suffix?: string; width?: number; flexGrow?: number; age?: string; marker?: string }) {
  const [hover, setHover] = createSignal(false), [width, setWidth] = createSignal(Infinity)
  let row: BoxRenderable, armed = false
  return <box ref={node => { row = node }} onSizeChange={() => setWidth(row.width - (props.indent ?? 0) - (props.marker !== undefined ? 2 : 0) - (props.age !== undefined ? 5 : 0))} height={1} minWidth={0} maxWidth="100%" width={props.width} flexGrow={props.flexGrow} flexShrink={props.flexGrow ? 1 : 0} flexBasis={props.flexGrow ? 0 : undefined} flexDirection="row" paddingLeft={props.indent ?? 0}
    onMouseOver={() => setHover(true)} onMouseOut={() => { setHover(false); armed = false }}
    onMouseDown={e => { armed = e.button === 0 && !e.isDragging; if (armed) { e.preventDefault(); e.stopPropagation() } }}
    onMouseDrag={() => { armed = false }}
    onMouseUp={e => { const trigger = armed && e.button === 0 && !e.isDragging; armed = false; if (trigger) { e.preventDefault(); e.stopPropagation(); props.run() } }}>
    <Show when={props.marker !== undefined}><text width={2} flexShrink={0} fg={props.marker === "!" ? props.ctx.theme.text.feedback.error.base : props.current || hover() ? props.ctx.theme.text.base : props.ctx.theme.text.muted} selectable={false}>{props.marker}</text></Show>
    <text fg={props.current || hover() ? props.ctx.theme.text.base : props.ctx.theme.text.muted} minWidth={0} flexGrow={1} flexShrink={1} flexBasis={0} wrapMode="none" selectable={false}>
      <Show when={props.bold} fallback={fitLabel(props.label, width() - Bun.stringWidth(props.suffix ?? ""))}><b>{fitLabel(props.label, width() - Bun.stringWidth(props.suffix ?? ""))}</b></Show>
      <Show when={props.suffix}><span style={{ fg: props.suffix?.trim() === "!" ? props.ctx.theme.text.feedback.error.base : props.ctx.theme.text.muted }}>{props.suffix}</span></Show>
    </text>
    <Show when={props.age !== undefined}><text fg={props.ctx.theme.text.muted} width={4} marginLeft={1} flexShrink={0} textAlign="right" wrapMode="none" selectable={false}>{props.age}</text></Show>
  </box>
}

function createActions(ctx: Context, currentSession: () => string, refresh: () => Promise<void>) {
  const rpc = ctx.client.rpc(WorkspaceRPC)
  const report = (e: unknown) => ctx.ui.toast.show({ title: "Projects", message: errorMessage(e), variant: "error", duration: 10_000 })
  const capture = () => { const sessionID = currentSession(), location = { ...(ctx.location ?? ctx.data.location.default()) }; return { sessionID, projectID: ctx.data.session.get(sessionID)?.projectID, location, scope: JSON.stringify(location), warned: false } }
  const valid = (origin: ReturnType<typeof capture>) => {
    try {
      const route = ctx.ui.router.current()
      if (route.type === "session" && route.sessionID === origin.sessionID && currentSession() === origin.sessionID && JSON.stringify(ctx.location ?? ctx.data.location.default()) === origin.scope && ctx.data.session.get(origin.sessionID)?.projectID === origin.projectID) return true
    } catch { /* The picker getter also rejects a changed session. */ }
    if (!origin.warned) ctx.ui.toast.show({ message: "Session or workspace changed; reopen the action dialog", variant: "warning" })
    origin.warned = true
    return false
  }
  const run = async (origin: ReturnType<typeof capture>, p: Project, operation: Operation) => {
    try {
      if (!valid(origin)) return
      const result = record(await rpc.operate({ project: p.path, operation }, { location: origin.location }))
      if (!result.ok) await ctx.ui.dialog.alert({ title: "pj write needs review", message: JSON.stringify(result, null, 2) })
      else ctx.ui.toast.show({ message: `pj: ${operation.kind} (${record(result.write ?? {}).state ?? "read"})`, variant: "success" })
      await refresh()
    } catch (e) { report(e) }
  }
  const showTask = async (p: Project, task: Task) => {
    const origin = capture()
    const action = await ctx.ui.dialog.select({ title: `${task.id}: ${task.title}`, options: [
      { title: "Read task text", value: "read", description: `${task.status}; ${task.ready ? "ready" : "not ready"}${task.parent ? `; parent: ${task.parent}` : ""}` },
      { title: "Start task", value: "start" }, { title: "Close task", value: "close" },
      { title: "Claim for current session", value: "claim", description: origin.sessionID }, { title: "Append task note", value: "note" },
    ] })
    if (!action || !valid(origin)) return
    if (action === "read") await ctx.ui.dialog.alert({ title: `${p.path}/${task.id}`, message: task.body })
    if (action === "start") await run(origin, p, { kind: "task-start", taskID: task.id })
    if (action === "close") await run(origin, p, { kind: "task-close", taskID: task.id })
    if (action === "claim") await run(origin, p, { kind: "task-claim", taskID: task.id, sessionID: origin.sessionID })
    if (action === "note") { const note = await ctx.ui.dialog.prompt({ title: `Note for ${task.id}` }); if (note?.trim()) await run(origin, p, { kind: "task-note", taskID: task.id, text: note }) }
  }
  const actions = async (p: Project) => {
    const origin = capture()
    const action = await ctx.ui.dialog.select({ title: `${p.path} · ${p.status}`, options: [
      { title: "Read project context", value: "context" }, { title: "Append project note", value: "log" },
      { title: "Create task", value: "create" }, { title: "Link current session", value: "link" },
      { title: "Set project status", value: "status", description: p.status },
      { title: "Archive project", value: "archive", description: `Move branch to ${projectArchiveDestination(p.path)}` },
    ] })
    if (!action || !valid(origin)) return
    if (action === "context") { try { const data = await rpc.operate({ project: p.path, operation: { kind: "context" } }, { location: origin.location }); await ctx.ui.dialog.alert({ title: p.path, message: JSON.stringify(data, null, 2) }) } catch (e) { report(e) } }
    if (action === "link") await run(origin, p, { kind: "link", sessionID: origin.sessionID, title: ctx.data.session.get(origin.sessionID)?.title ?? origin.sessionID })
    if (action === "status") { const status = await ctx.ui.dialog.select({ title: `Project status: ${p.path}`, current: p.status, options: projectStatuses.map(value => ({ title: value, value })) }); if (status) await run(origin, p, { kind: "status", status }) }
    if (action === "log" || action === "create") {
      const value = await ctx.ui.dialog.prompt({ title: action === "log" ? "Project note" : "Task title" })
      if (value?.trim()) await run(origin, p, action === "log" ? { kind: "log", text: value, sessionID: origin.sessionID } : { kind: "task-create", title: value })
    }
    if (action === "archive") {
      const confirmed = await ctx.ui.dialog.confirm({ title: "Archive project", message: `Move ${p.path} and its nested branch to ${projectArchiveDestination(p.path)}? Project status, tasks and memberships stay intact. Open conversations and execution continue.`, label: { confirm: "Move to archive", cancel: "Cancel" } })
      if (confirmed) await run(origin, p, { kind: "project-archive" })
    }
  }
  return { actions, showTask }
}

async function openWorkspacePicker(ctx: Context, store: WorkspaceStore) {
  const route = ctx.ui.router.current()
  if (route.type !== "session") { ctx.ui.toast.show({ message: "Open a session to establish the workspace search scope", variant: "info" }); return }
  const sessionID = route.sessionID, location = { ...(ctx.location ?? ctx.data.location.default()) }
  const scope = JSON.stringify(location), projectID = ctx.data.session.get(sessionID)?.projectID
  let warned = false
  const stillCurrent = () => {
    const route = ctx.ui.router.current()
    if (route.type === "session" && route.sessionID === sessionID && JSON.stringify(ctx.location ?? ctx.data.location.default()) === scope && ctx.data.session.get(sessionID)?.projectID === projectID) return true
    if (!warned) ctx.ui.toast.show({ message: "Session or workspace changed; reopen workspace search", variant: "warning" })
    warned = true
    return false
  }
  const controller = new AbortController(); store.controllers.add(controller)
  try {
    const snapshot = record(await ctx.client.rpc(WorkspaceRPC).snapshot({}, { location, signal: controller.signal }))
    if (snapshot.complete !== true || !Array.isArray(snapshot.projects) || typeof snapshot.vaultRoot !== "string" || !isAbsolute(snapshot.vaultRoot)) throw new Error("Complete workspace search snapshot is unavailable")
    const projects = snapshot.projects.map(project), native = await loadNativeSessions(ctx, sessionID, controller.signal)
    if (store.disposed || !stillCurrent()) return
    const options = pickerItems(projects, native, snapshot.vaultRoot, sessionID)
    const selected = await ctx.ui.dialog.select({ title: "Find project, task or session", options, search: (query, enabled) => fuzzyItems(query, enabled) })
    const item = options.find(item => item.value === selected)
    if (!item || store.disposed || !stillCurrent()) return
    const { actions, showTask } = createActions(ctx, () => {
      if (!stillCurrent()) throw new Error("Session changed; reopen workspace search")
      return sessionID
    }, async () => {})
    if (item.kind === "project") await actions(item.project)
    if (item.kind === "task") await showTask(item.project, item.task)
    if (item.kind === "session") focusSession(ctx.ui, item.sessionID)
  } catch (error) { if (!store.disposed) ctx.ui.toast.show({ title: "Workspace search", message: errorMessage(error), variant: "error" }) }
  finally { store.controllers.delete(controller) }
}

function ProjectSidebar(props: { ctx: Context; sessionID: string; store: WorkspaceStore }) {
  const { ctx, store } = props
  const [revision, setRevision] = createSignal(0), [now, setNow] = createSignal(Date.now()), [frame, setFrame] = createSignal(0)
  onCleanup(store.subscribe(() => setRevision(value => value + 1)))
  const entry = createMemo(() => { revision(); return store.entry(props.sessionID) }, undefined, { equals: false })
  const projects = createMemo(() => entry().projects), sessions = createMemo(() => entry().sessions), activity = createMemo(() => entry().activity)
  const activeSessions = createMemo(() => (sessions() ?? []).map(session => {
    const latest = activity().get(session.id)
    return latest !== undefined && latest > (sessionActivity(session) ?? -1) ? { ...session, time: { ...session.time, updated: latest } } : session
  }))
  const activeByID = createMemo(() => new Map(activeSessions().map(session => [session.id, session])))
  const expanded = () => entry().expanded, groupOpen = () => entry().groups, bucketOpen = () => entry().buckets
  const setExpanded = (update: (value: Map<string, boolean>) => Map<string, boolean>) => { entry().expanded = update(expanded()); store.changed() }
  const setGroupOpen = (update: (value: Map<ActivityGroupLabel, boolean>) => Map<ActivityGroupLabel, boolean>) => { entry().groups = update(groupOpen()); store.changed() }
  const setBucketOpen = (update: (value: Map<string, boolean>) => Map<string, boolean>) => { entry().buckets = update(bucketOpen()); store.changed() }
  const ageTimer = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(ageTimer))
  const familyMarkers = createMemo(() => entry().visual.familyMarkers(sessions() ?? [], props.sessionID))
  const working = createMemo(() => [...familyMarkers().values()].includes("working"))
  createEffect(() => { if (working()) { const timer = setInterval(() => setFrame(value => value + 1), 120); onCleanup(() => clearInterval(timer)) } })
  createEffect(() => { props.sessionID; untrack(() => { void store.ensure(props.sessionID) }) })
  const { actions, showTask } = createActions(ctx, () => props.sessionID, () => store.refresh(props.sessionID))
  const marker = (id: string) => {
    const state = familyMarkers().get(id) ?? (id === props.sessionID ? "selected" : "empty")
    return state === "working" ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame() % 10] : state === "attention" ? "!" : state === "finished" ? "✓" : state === "selected" ? "•" : ""
  }
  const sessionRow = (id: string, indent: number, title?: () => string | undefined) => <Row ctx={ctx} indent={indent} marker={marker(id)} label={activeByID().get(id)?.title ?? ctx.data.session.get(id)?.title ?? title?.() ?? id} age={relativeAge(sessionActivity(activeByID().get(id)), now())} current={id === props.sessionID} run={() => focusSession(ctx.ui, id)} />
  const TaskView = (input: { p: Project; node: TaskNode; indent: number }) => <box flexDirection="column">
    <Row ctx={ctx} indent={input.indent} label={`${input.node.task.title} · ${input.node.task.status}${input.node.task.status === "open" ? input.node.task.ready ? " · ready" : " · blocked" : ""}`} run={() => { void showTask(input.p, input.node.task) }} />
    <For each={input.node.children.map(child => child.task.id)}>{id => {
      const node = createMemo<TaskNode>(previous => input.node.children.find(child => child.task.id === id) ?? previous, input.node.children.find(child => child.task.id === id)!)
      return <TaskView p={input.p} node={node()} indent={input.indent + 2} />
    }}</For>
  </box>
  const TaskList = (input: { p: Project; tasks: Task[]; indent: number; key: string }) => {
    const opened = () => bucketOpen().get(input.key) ?? false
    const openTasks = createMemo(() => taskTree(input.tasks.filter(task => task.status !== "closed")))
    const closedTasks = createMemo(() => taskTree(input.tasks.filter(task => task.status === "closed")))
    return <box flexDirection="column">
      <For each={openTasks().map(node => node.task.id)}>{id => {
        const node = createMemo<TaskNode>(previous => openTasks().find(node => node.task.id === id) ?? previous, openTasks().find(node => node.task.id === id)!)
        return <TaskView p={input.p} node={node()} indent={input.indent} />
      }}</For>
      <Show when={closedTasks().length}>
        <Row ctx={ctx} indent={input.indent} label={`${opened() ? "▾" : "▸"} Completed (${input.tasks.filter(task => task.status === "closed").length})`} run={() => setBucketOpen(previous => new Map(previous).set(input.key, !opened()))} />
        <Show when={opened()}><For each={closedTasks().map(node => node.task.id)}>{id => {
          const node = createMemo<TaskNode>(previous => closedTasks().find(node => node.task.id === id) ?? previous, closedTasks().find(node => node.task.id === id)!)
          return <TaskView p={input.p} node={node()} indent={input.indent + 2} />
        }}</For></Show>
      </Show>
    </box>
  }
  const ProjectView = (input: { node: ProjectNode; indent: number }) => {
    const p = () => input.node.project, path = p().path
    const open = () => expanded().get(path) ?? true
    const toggle = () => setExpanded(previous => new Map(previous).set(path, !open()))
    const buckets = createMemo(() => projectTaskBuckets(p()))
    const tasksOpen = () => bucketOpen().get(`${path}:tasks`) ?? true
    return <box flexDirection="column">
      <box flexDirection="row" height={1} paddingLeft={input.indent}>
        <Row ctx={ctx} width={2} label={open() ? "▾" : "▸"} run={toggle} />
        <Row ctx={ctx} flexGrow={1} current={input.node.related} label={p().name} bold suffix={` ${projectSymbol(p().status)}`} run={() => { void actions(p()) }} />
      </box>
      <Show when={open()}>
        <For each={p().sessions.map(session => session.id)}>{id => <box flexDirection="column">
          {sessionRow(id, input.indent, () => p().sessions.find(session => session.id === id)?.title)}
          <TaskList p={p()} tasks={buckets().sessions.get(id) ?? []} indent={input.indent + 4} key={`${path}:${id}:completed`} />
        </box>}</For>
        <Show when={buckets().tasks.length}>
          <Row ctx={ctx} indent={input.indent + 2} label={`${tasksOpen() ? "▾" : "▸"} tasks`} run={() => setBucketOpen(previous => new Map(previous).set(`${path}:tasks`, !tasksOpen()))} />
          <Show when={tasksOpen()}><TaskList p={p()} tasks={buckets().tasks} indent={input.indent + 4} key={`${path}:tasks:completed`} /></Show>
        </Show>
        <For each={input.node.children.map(node => node.project.path)}>{(path, index) => {
          const node = createMemo<ProjectNode>(previous => input.node.children.find(node => node.project.path === path) ?? previous, input.node.children.find(node => node.project.path === path)!)
          return <box flexDirection="column"><Show when={index() > 0 || p().sessions.length || buckets().tasks.length}><box height={1} /></Show><ProjectView node={node()} indent={input.indent + 2} /></box>
        }}</For>
      </Show>
    </box>
  }
  const tree = createMemo(() => projectTree(projects() ?? [], props.sessionID, activeSessions()))
  const inbox = createMemo(() => {
    if (entry().loading) return { sessions: [], error: "Reading project memberships and native sessions…" }
    if (!projects() || !sessions() || !entry().root) return { sessions: [], error: "Inbox unavailable until complete project memberships and native sessions are read" }
    try { return { sessions: inboxSessions(projects(), activeSessions(), entry().root!, props.sessionID), error: undefined } }
    catch (e) { return { sessions: [], error: errorMessage(e) } }
  })
  const groups = createMemo(() => activityGroups(tree(), inbox().sessions, now()))
  return <box flexDirection="column" marginBottom={1} paddingRight={1}>
    <Show when={entry().error}><text fg={ctx.theme.text.muted} wrapMode="word">{entry().error}</text></Show>
    <Show when={!entry().loading && !entry().error && tree().length === 0}><text fg={ctx.theme.text.muted}>No active projects</text></Show>
    <Show when={inbox().error}><text fg={ctx.theme.text.muted} wrapMode="word">{inbox().error}</text></Show>
    <For each={groups().map(group => group.label)}>{label => {
      const entries = createMemo(() => groups().find(group => group.label === label)?.entries ?? [])
      const groupProjects = createMemo(() => entries().flatMap(entry => entry.kind === "project" ? [entry.node] : []))
      const groupSessions = createMemo(() => entries().flatMap(entry => entry.kind === "session" ? [entry.session.id] : []))
      const opened = () => groupOpen().get(label) ?? label === "Today"
      return <box flexDirection="column">
        <Row ctx={ctx} label={`${opened() ? "▾" : "▸"} ${label}`} run={() => setGroupOpen(previous => new Map(previous).set(label, !opened()))} />
        <Show when={opened()}>
          <For each={groupProjects().map(node => node.project.path)}>{(path, index) => {
            const node = createMemo<ProjectNode>(previous => groupProjects().find(node => node.project.path === path) ?? previous, groupProjects().find(node => node.project.path === path)!)
            return <box flexDirection="column"><Show when={index() > 0}><box height={1} /></Show><ProjectView node={node()} indent={0} /></box>
          }}</For>
          <Show when={groupProjects().length && groupSessions().length}><box height={1} /></Show>
          <For each={groupSessions()}>{id => sessionRow(id, 0)}</For>
        </Show>
        <box height={1} />
      </box>
    }}</For>
  </box>
}

export default Plugin.define({
  id: "pj.workspace.tui",
  setup(ctx) {
    const store = new WorkspaceStore(ctx)
    ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "pj.workspace.search", title: "Find project, task or session", group: "Projects", palette: true, bind: "<leader>p", run: () => openWorkspacePicker(ctx, store) }], bindings: ["pj.workspace.search"] }))
    // Additive placement preserves the native Todo, files, footer and other blocks.
    const stop = ctx.ui.slot({ prepend: "sidebar.content", render: input => createComponent(ProjectSidebar, { ctx, store, get sessionID() { return input.sessionID } }) })
    return () => { store.dispose(); stop() }
  },
})
