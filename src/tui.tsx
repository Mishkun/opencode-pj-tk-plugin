import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, batch, createComponent, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { errorMessage, project, projectArchiveDestination, projectStatuses, record, type Project, type Task } from "./contract"
import type { Operation } from "./bridge"
import { focusSession } from "./lifecycle"
import { inboxSessions, projectTree, taskTree, type ProjectNode, type TaskNode } from "./projection"
import { WorkspaceRPC } from "./rpc"
import { isAbsolute } from "node:path"
import { loadNativeSessions, onNativeInventoryChanged } from "./native-inventory"
import type { SessionInfo } from "@opencode/client"

function Row(props: { ctx: Context; label: string; indent?: number; run: () => void; current?: boolean }) {
  const [hover, setHover] = createSignal(false)
  let armed = false
  return <box height={1} minWidth={0} maxWidth="100%" paddingLeft={props.indent ?? 0}
    onMouseOver={() => setHover(true)} onMouseOut={() => { setHover(false); armed = false }}
    onMouseDown={e => { armed = e.button === 0 && !e.isDragging; if (armed) { e.preventDefault(); e.stopPropagation() } }}
    onMouseDrag={() => { armed = false }}
    onMouseUp={e => { const trigger = armed && e.button === 0 && !e.isDragging; armed = false; if (trigger) { e.preventDefault(); e.stopPropagation(); props.run() } }}>
    <text fg={hover() ? props.ctx.theme.text.base : props.ctx.theme.text.muted} wrapMode="none" selectable={false}>{props.label}</text>
  </box>
}

function ProjectSidebar(props: { ctx: Context; sessionID: string }) {
  const { ctx } = props
  const rpc = ctx.client.rpc(WorkspaceRPC)
  const location = ctx.location ?? ctx.data.location.default()
  const [projects, setProjects] = createSignal<Project[]>()
  const [vaultRoot, setVaultRoot] = createSignal<string>()
  const [sessions, setSessions] = createSignal<SessionInfo[]>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [inboxQuery, setInboxQuery] = createSignal("")
  let controller: AbortController | undefined
  let disposed = false
  let generation = 0
  const report = (e: unknown) => ctx.ui.toast.show({ title: "Projects", message: errorMessage(e), variant: "error", duration: 10_000 })
  const refresh = async () => {
    if (disposed) return
    const current = ++generation
    const sessionID = props.sessionID
    controller?.abort()
    const request = new AbortController()
    controller = request
    const { signal } = request
    setLoading(true)
    try {
      const snapshot = record(await rpc.snapshot({}, { location, signal }))
      signal.throwIfAborted()
      if (snapshot.complete !== true || !Array.isArray(snapshot.projects) || typeof snapshot.vaultRoot !== "string" || !isAbsolute(snapshot.vaultRoot)) throw new Error("Complete pj membership snapshot and vault scope are unavailable")
      const root = snapshot.vaultRoot
      const next = snapshot.projects.map(project)
      const native = await loadNativeSessions(ctx, sessionID, signal)
      signal.throwIfAborted()
      if (!disposed && current === generation) batch(() => { setProjects(next); setSessions(native); setVaultRoot(root); setError(undefined) })
    } catch (e) {
      if (!disposed && current === generation) batch(() => { setProjects(undefined); setSessions(undefined); setVaultRoot(undefined); setError(errorMessage(e)) })
    } finally { if (!disposed && current === generation) setLoading(false) }
  }
  const stopChanged = rpc.events.on("changed", event => { if (event.location.directory === location.directory) void refresh() })
  const stopFork = rpc.events.on("forkResult", event => {
    if (event.location.directory !== location.directory) return
    const data = record(event.data)
    if (data.status === "incomplete") ctx.ui.toast.show({ title: "Fork attachment incomplete", message: errorMessage(data.error ?? "Inspect pj state before recovery"), variant: "error", duration: 20_000, sessionID: String(data.sessionID) })
    void refresh()
  })
  const stopNative = onNativeInventoryChanged(ctx, () => { void refresh() })
  createEffect(() => { props.sessionID; untrack(() => { setProjects(undefined); setSessions(undefined); setVaultRoot(undefined); void refresh() }) })
  onCleanup(() => { disposed = true; generation++; controller?.abort(); stopChanged(); stopFork(); stopNative() })

  const run = async (p: Project, operation: Operation) => {
    try {
      const result = record(await rpc.operate({ project: p.path, operation }, { location }))
      if (!result.ok) {
        // Keep the full envelope visible, including paths and verified/unknown commit state.
        await ctx.ui.dialog.alert({ title: "pj write needs review", message: JSON.stringify(result, null, 2) })
      } else ctx.ui.toast.show({ message: `pj: ${operation.kind} (${record(result.write ?? {}).state ?? "read"})`, variant: "success" })
      await refresh()
    } catch (e) { report(e) }
  }
  const showTask = async (p: Project, task: Task) => {
    const action = await ctx.ui.dialog.select({ title: `${task.id}: ${task.title}`, options: [
      { title: "Read task text", value: "read", description: `${task.status}; ${task.ready ? "ready" : "not ready"}` },
      { title: "Start task", value: "start" }, { title: "Close task", value: "close" },
      { title: "Claim for current session", value: "claim", description: props.sessionID },
      { title: "Append task note", value: "note" },
    ] })
    if (action === "read") await ctx.ui.dialog.alert({ title: `${p.path}/${task.id}`, message: task.body })
    if (action === "start") await run(p, { kind: "task-start", taskID: task.id })
    if (action === "close") await run(p, { kind: "task-close", taskID: task.id })
    if (action === "claim") await run(p, { kind: "task-claim", taskID: task.id, sessionID: props.sessionID })
    if (action === "note") {
      const note = await ctx.ui.dialog.prompt({ title: `Note for ${task.id}` })
      if (note?.trim()) await run(p, { kind: "task-note", taskID: task.id, text: note })
    }
  }
  const actions = async (p: Project) => {
    const action = await ctx.ui.dialog.select({ title: p.path, options: [
      { title: "Read project context", value: "context" }, { title: "Append project note", value: "log" },
      { title: "Create task", value: "create" }, { title: "Link current session", value: "link" },
      { title: "Set project status", value: "status", description: p.status },
      { title: "Archive project", value: "archive", description: `Move branch to ${projectArchiveDestination(p.path)}` },
    ] })
    if (action === "context") {
      try { const data = await rpc.operate({ project: p.path, operation: { kind: "context" } }, { location }); await ctx.ui.dialog.alert({ title: p.path, message: JSON.stringify(data, null, 2) }) } catch (e) { report(e) }
    }
    if (action === "link") await run(p, { kind: "link", sessionID: props.sessionID, title: ctx.data.session.get(props.sessionID)?.title ?? props.sessionID })
    if (action === "status") {
      const status = await ctx.ui.dialog.select({ title: `Project status: ${p.path}`, current: p.status, options: projectStatuses.map(value => ({ title: value, value })) })
      if (status) await run(p, { kind: "status", status })
    }
    if (action === "log" || action === "create") {
      const value = await ctx.ui.dialog.prompt({ title: action === "log" ? "Project note" : "Task title" })
      if (value?.trim()) await run(p, action === "log" ? { kind: "log", text: value, sessionID: props.sessionID } : { kind: "task-create", title: value })
    }
    if (action === "archive") {
      const confirmed = await ctx.ui.dialog.confirm({ title: "Archive project", message: `Move ${p.path} and its nested branch to ${projectArchiveDestination(p.path)}? Project status, tasks and memberships stay intact. Open conversations and execution continue.`, label: { confirm: "Move to archive", cancel: "Cancel" } })
      if (confirmed) await run(p, { kind: "project-archive" })
    }
  }
  const sessionRow = (id: string, indent: number, title?: string) => <Row ctx={ctx} indent={indent} label={`${id === props.sessionID ? "• " : ""}${sessions()?.find(s => s.id === id)?.title ?? ctx.data.session.get(id)?.title ?? title ?? id}`} current={id === props.sessionID} run={() => focusSession(ctx.ui, id)} />
  const TaskView = (input: { p: Project; node: TaskNode; indent: number }) => <box flexDirection="column">
    <Row ctx={ctx} indent={input.indent} label={`${input.node.task.title} · ${input.node.task.status}${input.node.task.status === "open" ? input.node.task.ready ? " · ready" : " · blocked" : ""}`} run={() => { void showTask(input.p, input.node.task) }} />
    <For each={input.node.task.claimed_by_sessions}>{id => sessionRow(id, input.indent + 2, input.p.sessions.find(s => s.id === id)?.title)}</For>
    <For each={input.node.children}>{child => <TaskView p={input.p} node={child} indent={input.indent + 2} />}</For>
  </box>
  const ProjectView = (input: { node: ProjectNode; indent: number }) => {
    const [open, setOpen] = createSignal(true)
    const [closed, setClosed] = createSignal(false)
    const p = () => input.node.project
    return <box flexDirection="column">
      <Row ctx={ctx} indent={input.indent} current={input.node.related} label={`${open() ? "▾" : "▸"} ${p().name} · ${p().status}`} run={() => setOpen(v => !v)} />
      <Show when={open()}>
        <Row ctx={ctx} indent={input.indent + 2} label="Actions" run={() => { void actions(p()) }} />
        <For each={taskTree(p().tasks.filter(t => t.status !== "closed"))}>{node => <TaskView p={p()} node={node} indent={input.indent + 2} />}</For>
        <Show when={p().tasks.some(t => t.status === "closed")}>
          <Row ctx={ctx} indent={input.indent + 2} label={`${closed() ? "▾" : "▸"} Completed (${p().tasks.filter(t => t.status === "closed").length})`} run={() => setClosed(v => !v)} />
          <Show when={closed()}><For each={taskTree(p().tasks.filter(t => t.status === "closed"))}>{node => <TaskView p={p()} node={node} indent={input.indent + 4} />}</For></Show>
        </Show>
        <Show when={p().sessions.length}><text fg={ctx.theme.text.muted}>{" ".repeat(input.indent + 2)}Sessions</text></Show>
        <For each={p().sessions}>{session => sessionRow(session.id, input.indent + 4, session.title)}</For>
        <For each={input.node.children}>{node => <ProjectView node={node} indent={input.indent + 2} />}</For>
      </Show>
    </box>
  }
  const tree = createMemo(() => projectTree(projects() ?? [], props.sessionID))
  const inbox = createMemo(() => {
    if (loading()) return { sessions: [], error: "Reading project memberships and native sessions…" }
    if (!projects() || !sessions() || !vaultRoot()) return { sessions: [], error: "Inbox unavailable until complete project memberships and native sessions are read" }
    try { return { sessions: inboxSessions(projects(), sessions(), vaultRoot()!, props.sessionID, inboxQuery()), error: undefined } }
    catch (e) { return { sessions: [], error: errorMessage(e) } }
  })
  return <box flexDirection="column" marginBottom={1}>
    <text fg={ctx.theme.text.base}>Projects</text>
    <Row ctx={ctx} label={loading() ? "Refreshing…" : "Refresh"} run={() => { void refresh() }} />
    <Show when={error()}><text fg={ctx.theme.text.muted} wrapMode="word">{error()}</text></Show>
    <Show when={!loading() && !error() && tree().length === 0}><text fg={ctx.theme.text.muted}>No active projects</text></Show>
    <For each={tree()}>{node => <ProjectView node={node} indent={0} />}</For>
    <text fg={ctx.theme.text.base}>Inbox</text>
    <Row ctx={ctx} label={`Search Inbox${inboxQuery() ? `: ${inboxQuery()}` : ""}`} run={() => { void (async () => {
      const query = await ctx.ui.dialog.prompt({ title: "Search Inbox", placeholder: "Session title or SID; empty clears search" })
      if (query !== undefined) setInboxQuery(query)
    })().catch(report) }} />
    <Show when={inbox().error}><text fg={ctx.theme.text.muted} wrapMode="word">{inbox().error}</text></Show>
    <Show when={!inbox().error && inbox().sessions.length === 0}><text fg={ctx.theme.text.muted}>No matching unlinked sessions</text></Show>
    <For each={inbox().sessions}>{session => sessionRow(session.id, 2, session.title)}</For>
  </box>
}

export default Plugin.define({
  id: "pj.workspace.tui",
  setup(ctx) {
    // 2.2.5 exposes no granular native title/MCP/Context/Todo slots.
    // Additive placement keeps the actual native Todo, files, footer and remaining blocks.
    const stop = ctx.ui.slot({ prepend: "sidebar.content", render: input => createComponent(ProjectSidebar, { ctx, get sessionID() { return input.sessionID } }) })
    return stop
  },
})
