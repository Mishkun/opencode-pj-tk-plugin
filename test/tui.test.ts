import { expect, spyOn, test } from "bun:test"
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import type { Project } from "../src/contract"
import type { JSX } from "solid-js"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { project, session, task } from "./fixtures"

ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const { RGBA, TextAttributes } = await import("@opentui/core")
const { createSignal, createComponent, Show } = await import("solid-js")
const { default: plugin } = await import("../src/tui")
const { SessionState } = await import("../src/session-state")

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function sidebar(options: { native?: SessionInfo[]; projects?: Project[]; hidden?: boolean; light?: boolean; initialNativeRead?: () => Promise<SessionInfo[]>; waitReady?: boolean } = {}) {
  const dialogs: any[] = [], focused: string[] = [], navigated: unknown[] = [], operations: unknown[] = [], toasts: any[] = [], layers: KeymapLayer[] = []
  let snapshots = 0, pendingReads = 0
  const [current, setCurrent] = createSignal("ses_A"), [mounted, setMounted] = createSignal(!options.hidden)
  let select: (input: any) => string | undefined | Promise<string | undefined> = () => undefined
  let prompt = async (): Promise<string | undefined> => undefined, confirm = async (): Promise<boolean | undefined> => undefined
  const listeners = new Map<string, () => void>(), allListeners = new Set<(event: { details: unknown }) => void>()
  const updated = Date.now() - 30_000
  const native = options.native ?? [session("ses_A", { title: "Current session", time: { created: updated, updated } }), session("ses_B", { title: "Other session", time: { created: updated, updated } }), session("ses_C", { title: "Child session", time: { created: updated, updated } })]
  const projects = options.projects ?? [
    project("projects/P", { name: "Parent project", sessions: [{ id: "ses_A", title: "Current session" }, { id: "ses_B", title: "Other session" }], tasks: [task({ claimed_by_sessions: [] }), task({ id: "p-done", title: "Finished task", status: "closed", claimed_by_sessions: [] })] }),
    project("projects/P/Child", { name: "Child project", parent: "projects/P", sessions: [{ id: "ses_C", title: "Child session" }], tasks: [] }),
  ]
  let nativeRead = options.initialNativeRead ?? (async () => native)
  let permissions = async (): Promise<{ id: string; sessionID: string }[]> => []
  const base = RGBA.fromHex(options.light ? "#111111" : "#eeeeee"), muted = RGBA.fromHex("#888888"), error = RGBA.fromHex(options.light ? "#a01010" : "#ff7777")
  let render!: () => JSX.Element
  const ctx = {
    location: { directory: "/vault/projects/P" }, theme: { text: { base, muted, feedback: { error: { base: error } } } },
    client: {
      rpc: () => ({ snapshot: async () => { snapshots++; return { projects, vaultRoot: "/vault", complete: true } }, operate: async (input: unknown) => { operations.push(input); return { ok: true, write: { state: "unchanged" } } }, events: { on: () => () => {} } }),
      session: { get: async ({ sessionID }: { sessionID: string }) => native.find(session => session.id === sessionID), list: async () => ({ data: await nativeRead(), cursor: {} }) },
      permission: { request: { list: async () => { pendingReads++; return { data: await permissions() } } } },
      form: { list: async () => { pendingReads++; return { data: [] } } },
    },
    data: { on: (type: string, run: () => void) => { listeners.set(type, run); return () => { listeners.delete(type) } }, listen: (run: (event: { details: unknown }) => void) => { allListeners.add(run); return () => { allListeners.delete(run) } }, session: { get: (id: string) => native.find(s => s.id === id) } },
    keymap: { layer: (factory: () => KeymapLayer) => { layers.push(factory()) } },
    ui: {
      slot: (slot: { render: (input: { sessionID: string }) => JSX.Element }) => { render = () => slot.render({ get sessionID() { return current() } }); return () => {} },
      dialog: { select: async (input: any) => { dialogs.push(input); return select(input) }, prompt: () => prompt(), confirm: () => confirm() }, toast: { show: (input: unknown) => { toasts.push(input) } },
      tabs: { enabled: () => true, focus: (id: string) => { focused.push(id) }, list: () => [] },
      router: { current: () => current() ? { type: "session", sessionID: current() } : { type: "home" }, navigate: (input: unknown) => { navigated.push(input) } },
    },
  } as unknown as Context
  const cleanup = await plugin.setup(ctx)
  const view = await testRender(() => createComponent(Show, { keyed: true, get when() { return mounted() }, get children() { return render() } }), { width: 48, height: 36 })
  if (!options.hidden && options.waitReady !== false) await view.waitForFrame(frame => /Today|Yesterday|Last 7 days|Earlier/.test(frame) && !frame.includes("Reading project"))
  const lines = () => view.captureCharFrame().split("\n")
  const position = (label: string) => { const y = lines().findIndex(line => line.includes(label)); if (y < 0) throw new Error(`Missing rendered label: ${label}\n${view.captureCharFrame()}`); return { x: lines()[y].indexOf(label), y } }
  const click = async (label: string) => { const { x, y } = position(label); await view.mockMouse.click(x, y); await view.flush() }
  const span = (label: string) => { const { x, y } = position(label); let column = 0; for (const span of view.captureSpans().lines[y].spans) { column += span.width; if (column > x) return span } throw new Error(`Missing span: ${label}`) }
  const emit = (type: string, data: unknown = {}, created = Date.now()) => { listeners.get(type)?.(); for (const run of allListeners) run({ details: { type, created, data } }) }
  const refresh = async () => { emit("server.connected"); await Bun.sleep(115); await view.flush() }
  const dispose = async () => { await view.dispose(); await cleanup?.() }
  return { ...view, dispose, [Symbol.asyncDispose]: dispose, ctx, native, projects, lines, position, click, span, dialogs, focused, navigated, operations, base, muted, error, emit, refresh, toasts, layers, listeners, allListeners, snapshots: () => snapshots, pendingReads: () => pendingReads,
    remount: async () => { setMounted(false); await view.flush(); setMounted(true); await view.flush() },
    visible: async (value: boolean) => { setMounted(value); await view.flush() }, prompt: (handler: typeof prompt) => { prompt = handler }, confirm: (handler: typeof confirm) => { confirm = handler },
    select: (handler: typeof select) => { select = handler }, route: setCurrent, nativeRead: (handler: typeof nativeRead) => { nativeRead = handler }, permissions: (handler: typeof permissions) => { permissions = handler } }
}

test("compact sidebar keeps project typography and project/session/task hierarchy without extra controls", async () => {
  await using view = await sidebar()
  const lines = view.lines().map(line => line.trimEnd())
  expect(lines[0]).toBe("▾ Today")
  for (const obsolete of ["Projects", "Refresh", "↻", "Search Inbox", "Actions", "Sessions", "Last session activity", "No matching unlinked sessions"]) expect(lines).not.toContain(obsolete)
  expect(lines).toContain("▾ Parent project ◐")
  expect(lines).toContain("  ▾ Child project ◐")
  expect(lines).toContain("  ▾ tasks")
  expect(lines).toContain("    Work · open · ready")
  expect(view.position("Current session").x).toBe(2)
  expect(view.position("Other session").x).toBe(2)
  expect(view.lines()[view.position("Current session").y].startsWith("• ")).toBe(true)
  expect(view.span("Parent project").attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
  expect(view.span("◐").attributes & TextAttributes.BOLD).toBe(0)
  expect(view.span("Current session").attributes & TextAttributes.BOLD).toBe(0)
})

test("independent project triangle and name retain action menu, current bullet and focus/router semantics", async () => {
  await using view = await sidebar()
  await view.click("▾ Parent project")
  expect(view.lines().some(line => line.includes("Current session"))).toBe(false)
  expect(view.dialogs).toHaveLength(0)
  await view.click("Parent project")
  expect(view.dialogs).toHaveLength(1)
  expect(view.dialogs[0].title).toBe("projects/P · in-progress")
  expect(view.dialogs[0].options.map((option: any) => option.value)).toEqual(["context", "log", "create", "link", "status", "archive"])
  await view.click("▸ Parent project")
  await view.click("Other session")
  expect(view.focused).toEqual(["ses_B"])
  view.ctx.ui.tabs.enabled = () => false
  await view.click("Current session")
  expect(view.navigated).toEqual([{ type: "session", sessionID: "ses_A" }])
  const { x, y } = view.position("Parent project")
  await view.mockMouse.click(x, y, 2)
  await view.mockMouse.drag(x, y, 0, 35)
  await view.flush()
  expect(view.dialogs).toHaveLength(1)
  expect(view.operations).toEqual([])
})

test("four local calendar groups collapse as wholes, projects precede Inbox and groups have blank separators", async () => {
  const now = new Date(2026, 10, 7, 12).getTime(), clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    const at = (id: string, title: string, days: number) => session(id, { title, time: { created: now - days * 86_400_000, updated: now - days * 86_400_000 } })
    await using view = await sidebar({ native: [at("ses_A", "Current session", 0), at("ses_B", "Yesterday member", 1), at("ses_C", "Week member", 3), at("ses_D", "Old member", 30), at("ses_T", "Today orphan", 0), at("ses_Y", "Yesterday orphan", 1), at("ses_W", "Week orphan", 4), at("ses_E", "Old orphan", 40)], projects: [project("projects/Today", { tasks: [] }), ...[["Yesterday", "ses_B"], ["Week", "ses_C"], ["Old", "ses_D"]].map(([name, id]) => project(`projects/${name}`, { sessions: [{ id, title: id }], tasks: [] }))] })
    expect(view.lines().some(line => line.includes("Yesterday member"))).toBe(false)
    for (const label of ["Yesterday", "Last 7 days", "Earlier"]) { expect(view.position(`▸ ${label}`).y).toBeGreaterThan(0); await view.click(`▸ ${label}`) }
    for (const [before, after] of [["▾ Today", "Today orphan"], ["▾ Yesterday", "Yesterday orphan"], ["▾ Week", "Week orphan"], ["▾ Old", "Old orphan"]]) expect(view.position(before).y).toBeLessThan(view.position(after).y)
    for (const label of ["Yesterday", "Last 7 days", "Earlier"]) expect(view.lines()[view.position(`▾ ${label}`).y - 1].trim()).toBe("")
    expect(view.lines()[view.position("Yesterday member").y].slice(0, 2)).toBe("  ")
    expect(view.position("Yesterday orphan").x).toBe(2)
  } finally { clock.mockRestore() }
})

test.each([false, true])("selected M:N projects/ancestors and sessions use semantic base (light=%s)", async light => {
  const updated = Date.now() - 30_000
  await using view = await sidebar({ light, native: [session("ses_A", { title: "Current session", time: { created: updated, updated } }), session("ses_B", { title: "Other session", time: { created: updated, updated } })], projects: [project("projects/Parent", { sessions: [], tasks: [] }), project("projects/Parent/Child", { parent: "projects/Parent", tasks: [] }), project("projects/Shared", { tasks: [] }), project("projects/Other", { sessions: [{ id: "ses_B", title: "Other" }], tasks: [] })] })
  for (const label of ["Parent ◐", "Child ◐", "Shared ◐", "Current session"]) expect(view.span(label).fg).toEqual(view.base)
  for (const label of ["Other ◐", "Other session"]) expect(view.span(label).fg).toEqual(view.muted)
  const { x, y } = view.position("Other ◐"), bg = view.span("Other ◐").bg
  await view.mockMouse.moveTo(x, y); await view.flush()
  expect(view.span("Other ◐").fg).toEqual(view.base)
  expect(view.span("Other ◐").bg).toEqual(bg)
  await view.mockMouse.moveTo(0, 35); await view.flush()
  expect(view.span("Other ◐").fg).toEqual(view.muted)
})

test("end ellipsis preserves compact session age and gutter at 48/24 columns; projects have no age", async () => {
  const now = Date.now()
  await using view = await sidebar({ native: [session("ses_A", { title: "Very long session title that must truncate", time: { created: now - 300_000, updated: now - 300_000 } })], projects: [project("projects/Long", { name: "Very long project name that also truncates", tasks: [] })] })
  for (const width of [48, 24]) {
    view.resize(width, 36); await view.flush()
    const rows = view.lines().filter(line => line.trimEnd().endsWith("5m"))
    expect(rows).toHaveLength(1)
    expect(rows[0].indexOf("5m")).toBe(width - 3)
    expect(rows[0].endsWith("5m ")).toBe(true)
    expect(rows[0]).toContain("…")
    expect(rows[0]).not.toContain("...")
  }
})

test("tasks sit under claiming sessions; cross-claim tasks repeat and hidden claims remain in tasks", async () => {
  const tasks = [task({ id: "A", title: "Unassigned", claimed_by_sessions: [] }), task({ id: "B", title: "Shared task", parent: "A", claimed_by_sessions: ["ses_A", "ses_B"] }), task({ id: "C", title: "Hidden claim", parent: "B", claimed_by_sessions: ["ses_Hidden"] }), task({ id: "D", title: "Done task", status: "closed", claimed_by_sessions: ["ses_A"] })]
  await using view = await sidebar({ projects: [project("projects/P", { name: "Parent project", sessions: [{ id: "ses_A", title: "A" }, { id: "ses_B", title: "B" }], tasks })] })
  expect(view.lines().filter(line => line.includes("Shared task"))).toHaveLength(2)
  expect(view.position("Current session").y).toBeLessThan(view.position("Shared task").y)
  expect(view.position("Other session").y).toBeLessThan(view.position("▾ tasks").y)
  expect(view.position("▾ tasks").y).toBeLessThan(view.position("Hidden claim").y)
  await view.click("Completed (1)")
  expect(view.lines().some(line => line.includes("Done task · closed"))).toBe(true)
  await view.click("Hidden claim")
  expect(view.dialogs[0].title).toBe("C: Hidden claim")
  expect(view.dialogs[0].options[0].description).toContain("parent: B")
  expect(tasks.map(task => [task.id, task.parent])).toEqual([["A", null], ["B", "A"], ["C", "B"], ["D", null]])
  expect(view.dialogs[0].options.map((option: any) => option.value)).toEqual(["read", "start", "close", "claim", "note"])
  await view.click("▾ tasks")
  expect(view.lines().some(line => line.includes("Unassigned"))).toBe(false)
  expect(view.lines().filter(line => line.includes("Shared task"))).toHaveLength(2)
  expect(tasks[1].claimed_by_sessions).toEqual(["ses_A", "ses_B"])
})

test("background refresh keeps rows and errors separate while native inventory is pending", async () => {
  await using view = await sidebar()
  const before = view.captureCharFrame(), pending = deferred<SessionInfo[]>()
  view.nativeRead(() => pending.promise)
  const refreshing = view.refresh()
  await Bun.sleep(120); await view.flush()
  expect(view.captureCharFrame()).toBe(before)
  expect(view.captureCharFrame()).not.toContain("Reading")
  pending.resolve(view.native); await refreshing; await view.flush()
  expect(view.captureCharFrame()).toBe(before)
  view.nativeRead(async () => { throw new Error("Synthetic read failure") })
  await view.refresh()
  expect(view.captureCharFrame()).toContain("Synthetic read failure")
  expect(view.captureCharFrame()).toContain("Parent project")
})

test.each(["Parent project", "Child project"])("held click on %s survives unrelated streaming", async label => {
  const timeouts = spyOn(globalThis, "setTimeout")
  try {
    await using view = await sidebar()
    const { x, y } = view.position(label)
    await view.mockMouse.pressDown(x, y)
    view.emit("session.message.content.updated", { sessionID: "ses_B" }, Date.now())
    const index = timeouts.mock.calls.findLastIndex(([, delay]) => delay === 1_000)
    expect(index).toBeGreaterThanOrEqual(0)
    clearTimeout(timeouts.mock.results[index].value as ReturnType<typeof setTimeout>)
    const callback = timeouts.mock.calls[index][0]; if (typeof callback === "function") callback()
    await view.flush()
    expect(view.position(label)).toEqual({ x, y })
    await view.mockMouse.release(x, y); await view.flush()
    expect(view.dialogs).toHaveLength(1)
    expect(view.snapshots()).toBe(1)
    expect(view.pendingReads()).toBe(2)
  } finally { timeouts.mockRestore() }
})

test("minute tick preserves unselected hover, updates ages locally, and all subscriptions/timers clean up", async () => {
  const now = Date.now(), clock = spyOn(Date, "now").mockReturnValue(now), intervals = spyOn(globalThis, "setInterval"), clear = spyOn(globalThis, "clearInterval")
  try {
    await using view = await sidebar()
    const { x, y } = view.position("Child project")
    await view.mockMouse.moveTo(x, y); await view.flush()
    expect(view.span("Child project").fg).toEqual(view.base)
    clock.mockReturnValue(now + 60_000)
    const index = intervals.mock.calls.findIndex(([, delay]) => delay === 60_000), callback = intervals.mock.calls[index][0]
    if (typeof callback === "function") callback(); await view.flush()
    expect(view.span("Child project").fg).toEqual(view.base)
    expect(view.lines().filter(line => line.trimEnd().endsWith("1m"))).toHaveLength(3)
    expect(view.snapshots()).toBe(1)
    await view.dispose()
    expect(clear).toHaveBeenCalledWith(intervals.mock.results[index].value)
    expect(view.listeners.size).toBe(0); expect(view.allListeners.size).toBe(0)
  } finally { clock.mockRestore(); intervals.mockRestore(); clear.mockRestore() }
})

test("group/project/tasks toggles survive background refresh and movement between local date groups", async () => {
  const now = new Date(2026, 10, 7, 12).getTime(), clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    await using view = await sidebar()
    await view.click("Completed (1)"); await view.click("▾ Child project"); await view.click("▾ Parent project")
    view.native.forEach(native => { native.time.created = now - 20 * 86_400_000; native.time.updated = native.time.created })
    await view.refresh(); await view.click("▸ Earlier")
    expect(view.captureCharFrame()).toContain("▸ Parent project")
    await view.click("▸ Parent project")
    expect(view.captureCharFrame()).toContain("Finished task · closed")
    expect(view.captureCharFrame()).toContain("▸ Child project")
    view.native[1].time.updated = now
    await view.refresh()
    expect(view.captureCharFrame()).toContain("▾ Parent project")
    expect(view.position("Other session").y).toBeLessThan(view.position("Current session").y)
    expect(view.captureCharFrame()).toContain("Finished task · closed")
  } finally { clock.mockRestore() }
})

test("markers align names and show authoritative working/finished/attention/selected/empty states", async () => {
  const now = Date.now(), intervals = spyOn(globalThis, "setInterval")
  try {
    const item = (id: string, title: string, outcome?: "succeeded" | "failed", busy = now - 1000, idle = now) => session(id, { title, outcome, time: { created: 1, updated: now, busy, idle, viewed: 0 } })
    const native = [item("ses_A", "Selected working", undefined, now + 1), item("ses_B", "Finished", "succeeded"), item("ses_C", "Attention", "failed"), item("ses_D", "Empty")]
    await using view = await sidebar({ native, projects: [project("projects/P", { sessions: native.map(session => ({ id: session.id, title: session.title! })), tasks: [] })] })
    for (const title of ["Selected working", "Finished", "Attention", "Empty"]) expect(view.position(title).x).toBe(2)
    expect(view.lines()[view.position("Finished").y][0]).toBe("✓")
    expect(view.lines()[view.position("Attention").y][0]).toBe("!")
    expect(view.lines()[view.position("Empty").y][0]).toBe(" ")
    expect(view.span("Selected working").fg).toEqual(view.base)
    const before = view.lines()[view.position("Selected working").y][0]
    const callback = intervals.mock.calls.find(([, delay]) => delay === 120)![0]
    if (typeof callback === "function") callback(); await view.flush()
    expect(view.lines()[view.position("Selected working").y][0]).not.toBe(before)
    view.emit("session.execution.interrupted", { sessionID: "ses_A" }, now + 2); await view.flush()
    expect(view.lines()[view.position("Selected working").y][0]).toBe("•")
    view.emit("session.viewed", { sessionID: "ses_B", idle: now }, now + 3); await view.flush()
    expect(view.lines()[view.position("Finished").y][0]).toBe(" ")
  } finally { intervals.mockRestore() }
})

test("permission closed and new busy state survive a stale background snapshot; overlapping refresh is discarded", async () => {
  const now = Date.now()
  await using view = await sidebar()
  const pending = deferred<{ id: string; sessionID: string }[]>()
  view.permissions(() => pending.promise)
  const first = view.refresh(); await Bun.sleep(120)
  view.emit("permission.replied", { sessionID: "ses_A", requestID: "r1" }, now + 1)
  view.emit("session.status", { sessionID: "ses_A", status: { type: "busy" } }, now + 2)
  pending.resolve([{ id: "r1", sessionID: "ses_A" }]); await first; await view.flush()
  expect(view.lines()[view.position("Current session").y][0]).not.toBe("!")
  expect(view.lines()[view.position("Current session").y][0]).not.toBe("•")
  view.permissions(async () => [])
  const old = deferred<SessionInfo[]>(); view.nativeRead(() => old.promise)
  const older = view.refresh(); await Bun.sleep(120)
  view.nativeRead(async () => view.native.map(session => ({ ...session, title: session.id === "ses_B" ? "Fresh title" : session.title })))
  await view.refresh(); old.resolve(view.native); await older; await Bun.sleep(120); await view.flush()
  expect(view.captureCharFrame()).toContain("Fresh title")
})

test("global leader-p picker works with hidden sidebar, reads fresh scope, cancels safely and focuses sessions", async () => {
  await using view = await sidebar({ hidden: true })
  expect(view.layers).toHaveLength(1)
  expect(view.layers[0]).toMatchObject({ mode: "global", bindings: ["pj.workspace.search"] })
  const command = view.layers[0].commands![0]
  expect(command).toMatchObject({ id: "pj.workspace.search", title: "Find project, task or session", palette: true, bind: "<leader>p" })
  expect(view.snapshots()).toBe(0)
  await command.run()
  expect(view.toasts.some(toast => toast.message === "Loading workspace search…")).toBe(false)
  expect(view.dialogs[0].options.some((item: any) => item.category === "Tasks")).toBe(true)
  expect(view.focused).toEqual([]); expect(view.operations).toEqual([])
  view.select(input => input.title === "Find project, task or session" ? "session:ses_B" : undefined)
  view.route("ses_B"); await command.run()
  expect(view.focused).toEqual(["ses_B"])
  expect(view.snapshots()).toBe(2)
  expect(view.pendingReads()).toBe(0)
  view.route(""); await command.run()
  expect(view.toasts.at(-1).message).toContain("Open a session")
})

test.each(["project:projects/P", "task:projects/P:p-1234"])("picker %s reuses existing action dialogs without direct mutation", async value => {
  await using view = await sidebar({ hidden: true })
  view.select(input => input.title === "Find project, task or session" ? value : undefined)
  await view.layers[0].commands![0].run()
  expect(view.dialogs).toHaveLength(2)
  expect(view.dialogs[1].title).toBe(value.startsWith("project:") ? "projects/P · in-progress" : "p-1234: Work")
  expect(view.operations).toEqual([])
  expect(view.focused).toEqual([])
})

test.each(["location", "projectID"])("picker rejects same-SID %s drift before opening a stale action menu", async drift => {
  await using view = await sidebar({ hidden: true })
  view.select(input => {
    if (input.title === "Find project, task or session") {
      if (drift === "location") view.ctx.location!.directory = "/other-vault"
      else view.native[0].projectID = "prj_other"
      return "task:projects/P:p-1234"
    }
    return "claim"
  })
  await view.layers[0].commands![0].run()
  expect(view.operations).toEqual([])
  expect(view.dialogs).toHaveLength(1)
  expect(view.toasts.at(-1)?.message).toContain("reopen")
})

test("cached rows survive same-scope A/B/A switching and sidebar remounts during one deferred flight", async () => {
  await using view = await sidebar()
  await view.click("▾ Child project")
  const pending = deferred<SessionInfo[]>(), original = view.snapshots()
  let concurrent = 0, maximum = 0
  view.nativeRead(async () => { maximum = Math.max(maximum, ++concurrent); try { return await pending.promise } finally { concurrent-- } })
  view.native[1].location.directory = "/vault/projects/Q"
  Object.assign(view.ctx.location!, { directory: "/vault/projects/Q" })
  view.route("ses_B"); await view.flush()
  expect(view.captureCharFrame()).not.toContain("Reading")
  expect(view.span("Other session").fg).toEqual(view.base)
  expect(view.span("Current session").fg).toEqual(view.muted)
  expect(view.captureCharFrame()).toContain("▸ Child project")
  for (let i = 0; i < 20; i++) {
    view.route(i % 2 ? "ses_B" : "ses_A")
    await view.remount()
    view.emit("server.connected")
    expect(view.captureCharFrame()).toContain("Parent project")
    expect(view.captureCharFrame()).not.toContain("Reading")
  }
  expect(view.snapshots()).toBe(original + 1)
  expect(maximum).toBe(1)
  expect(view.allListeners.size).toBe(1)
  expect(view.listeners.size).toBe(14)
  view.route("ses_A"); await view.flush()
  expect(view.span("Current session").fg).toEqual(view.base)
  pending.resolve(view.native); await view.flush(); await Bun.sleep(120); await view.flush()
  expect(view.captureCharFrame()).toContain("▸ Child project")
})

test("cross-project scope clears old tree; late A response cannot overwrite B, and project blocks are separated", async () => {
  const updated = Date.now() - 30_000
  await using view = await sidebar({ native: [session("ses_A", { title: "Current session", time: { created: updated, updated } }), session("ses_B", { title: "Other scope", projectID: "prj_other", time: { created: updated, updated } })], projects: [project("projects/First", { tasks: [] }), project("projects/Second", { tasks: [] })] })
  expect(view.lines()[view.position("▾ Second").y - 1].trim()).toBe("")
  const pending = deferred<SessionInfo[]>(), lateA = view.refresh()
  // Start a new A fetch whose result will be held until after B has rendered.
  await lateA
  view.nativeRead(() => pending.promise)
  const older = view.refresh(); await Bun.sleep(120)
  view.projects.splice(0, view.projects.length, project("projects/NewScope", { sessions: [{ id: "ses_B", title: "B" }], tasks: [] }))
  view.nativeRead(async () => view.native)
  view.route("ses_B"); await view.flush()
  expect(view.captureCharFrame()).not.toContain("First")
  await view.waitForFrame(frame => frame.includes("NewScope"))
  pending.resolve(view.native); await older; await view.flush()
  expect(view.captureCharFrame()).toContain("NewScope")
  expect(view.captureCharFrame()).not.toContain("First")
  expect(view.span("Other scope").fg).toEqual(view.base)
})

test("all project symbols are muted/regular and unknown status stays available in its action dialog", async () => {
  await using view = await sidebar({ projects: ["backlog", "in-progress", "waiting", "blocked", "done", "custom-state"].map((status, index) => project(`projects/P${index}`, { name: `Project ${index}`, status, tasks: [] })) })
  for (const symbol of ["○", "◐", "◷", "!", "✓", "?"]) {
    expect(view.span(symbol).fg).toEqual(symbol === "!" ? view.error : view.muted)
    expect(view.span(symbol).attributes & TextAttributes.BOLD).toBe(0)
  }
  for (let index = 0; index < 6; index++) expect(view.position(`Project ${index}`).x).toBe(2)
  await view.click("Project 5")
  expect(view.dialogs[0].title).toContain("custom-state")
})

test("a cold host session cache can reuse its complete scoped native snapshot on remount", async () => {
  await using view = await sidebar()
  const pending = deferred<SessionInfo[]>()
  view.nativeRead(() => pending.promise)
  view.ctx.data.session.get = () => undefined
  await view.remount()
  expect(view.captureCharFrame()).toContain("Parent project")
  expect(view.captureCharFrame()).not.toContain("Reading")
  expect(view.span("Current session").fg).toEqual(view.base)
  pending.resolve(view.native); await view.flush()
})

test("stream activity uses event time, keeps max across replay, excludes foreign SIDs and prunes deletion", async () => {
  const now = new Date(2026, 10, 7, 12).getTime(), clock = spyOn(Date, "now").mockReturnValue(now), timeouts = spyOn(globalThis, "setTimeout")
  try {
    await using view = await sidebar()
    view.native.forEach(session => { session.time.created = now - 600_000; session.time.updated = now - 600_000 })
    await view.refresh()
    const reads = view.snapshots()
    view.emit("session.message.content.updated", { sessionID: "ses_B" }, now - 60_000)
    view.emit("session.message.content.updated", { sessionID: "ses_B" }, now - 300_000)
    view.emit("session.message.content.updated", { sessionID: "ses_Foreign" }, now + 100_000)
    const index = timeouts.mock.calls.findLastIndex(([, delay]) => delay === 1000)
    expect(timeouts.mock.calls.filter(([, delay]) => delay === 1000)).toHaveLength(1)
    clearTimeout(timeouts.mock.results[index].value as ReturnType<typeof setTimeout>)
    const callback = timeouts.mock.calls[index][0]; if (typeof callback === "function") callback()
    await view.flush()
    expect(view.lines()[view.position("Other session").y].trimEnd().endsWith("1m")).toBe(true)
    expect(view.snapshots()).toBe(reads)
    view.emit("session.message.content.updated", { sessionID: "ses_B" }, now - 120_000)
    expect(timeouts.mock.calls.filter(([, delay]) => delay === 1000)).toHaveLength(1)
    const removed = view.native.splice(1, 1)[0]
    await view.refresh()
    expect(view.lines()[view.position("Other session").y].trimEnd().endsWith("—")).toBe(true)
    view.native.push(removed); await view.refresh()
    expect(view.lines()[view.position("Other session").y].trimEnd().endsWith("10m")).toBe(true)
    view.emit("session.message.content.updated", { sessionID: "ses_B" }, now)
    const clear = spyOn(globalThis, "clearTimeout")
    try { await view.dispose(); expect(clear).toHaveBeenCalledWith(timeouts.mock.results.at(-1)!.value) } finally { clear.mockRestore() }
  } finally { clock.mockRestore(); timeouts.mockRestore() }
})

test("initial load commits while sidebar is hidden and showing it needs neither a new load nor Loading", async () => {
  const pending = deferred<SessionInfo[]>(), updated = Date.now() - 1000
  const native = [session("ses_A", { title: "Loaded while hidden", time: { created: updated, updated } })]
  await using view = await sidebar({ native, initialNativeRead: () => pending.promise, waitReady: false })
  await view.flush(); expect(view.snapshots()).toBe(1)
  await view.visible(false)
  pending.resolve(native); await view.flush()
  view.nativeRead(() => new Promise(() => {}))
  await view.visible(true)
  expect(view.captureCharFrame()).toContain("Loaded while hidden")
  expect(view.captureCharFrame()).not.toContain("Reading")
  expect(view.snapshots()).toBe(1)
})

test("warm hidden cache receives native events once and cleans subscriptions only on plugin disposal", async () => {
  await using view = await sidebar()
  await view.visible(false)
  expect(view.allListeners.size).toBe(1); expect(view.listeners.size).toBe(14)
  view.native[1].title = "Updated while hidden"
  await view.refresh()
  view.emit("session.execution.started", { sessionID: "ses_A" }, Date.now() + 1)
  await view.visible(true)
  expect(view.captureCharFrame()).toContain("Updated while hidden")
  expect(view.lines()[view.position("Current session").y][0]).not.toBe("•")
  expect(view.allListeners.size).toBe(1)
  await view.dispose()
  expect(view.allListeners.size).toBe(0); expect(view.listeners.size).toBe(0)
})

test("sidebar task dialog pins claim SID across route drift; unchanged dialog still claims its original SID", async () => {
  await using view = await sidebar()
  const pending = deferred<string | undefined>()
  view.select(() => pending.promise)
  await view.click("Work ·")
  expect(view.dialogs.at(-1).options.find((option: any) => option.value === "claim").description).toBe("ses_A")
  view.route("ses_B"); await view.flush(); pending.resolve("claim"); await view.flush()
  expect(view.operations).toEqual([])
  expect(view.toasts.at(-1).message).toContain("reopen")
  view.route("ses_A"); await view.flush(); view.select(() => "claim")
  await view.click("Work ·")
  expect(view.operations).toEqual([{ project: "projects/P", operation: { kind: "task-claim", taskID: "p-1234", sessionID: "ses_A" } }])
})

test.each(["log", "create", "archive", "status"])("project %s nested dialog aborts contextual write after session/scope drift", async action => {
  await using view = await sidebar()
  const value = deferred<string | undefined>(), answer = deferred<boolean | undefined>()
  let selected = false
  view.select(() => { if (!selected) { selected = true; return action } return value.promise })
  view.prompt(() => value.promise); view.confirm(() => answer.promise)
  await view.click("Parent project")
  view.route("ses_B"); await view.flush()
  value.resolve(action === "status" ? "done" : "Synthetic input"); answer.resolve(true); await view.flush()
  expect(view.operations).toEqual([])
  expect(view.toasts.at(-1).message).toContain("reopen")
})

test.each([false, true])("attention glyphs use semantic error color and retain it on hover (light=%s)", async light => {
  const now = Date.now()
  await using view = await sidebar({ light, native: [session("ses_A", { title: "Current session", outcome: "failed", time: { created: 1, updated: now, busy: now - 1000, idle: now, viewed: 0 } })], projects: [project("projects/P", { name: "Parent project", status: "blocked", tasks: [] })] })
  expect(view.span("!").fg).toEqual(view.error)
  expect(view.span("! Current session").fg).toEqual(view.error)
  expect(view.span("Current session").fg).toEqual(view.base)
  for (const label of ["Parent project", "Current session"]) { const { x, y } = view.position(label); await view.mockMouse.moveTo(x, y); await view.flush(); expect(view.span("!").fg).toEqual(view.error); expect(view.span("! Current session").fg).toEqual(view.error) }
})

test("session age reserves four columns plus one gap and preserves 12mo at narrow width", async () => {
  const now = Date.now()
  await using view = await sidebar({ native: [session("ses_A", { title: "Long session title to truncate", time: { created: now - 360 * 86_400_000, updated: now - 360 * 86_400_000 } })], projects: [project("projects/P", { tasks: [] })] })
  await view.click("▸ Earlier")
  view.resize(24, 36); await view.flush()
  const row = view.lines().find(line => line.includes("12mo"))!
  expect(row.indexOf("12mo")).toBe(19)
  expect(row.indexOf("…")).toBe(17)
  expect(row.endsWith("12mo ")).toBe(true)
})

test("same-SID scope drift in a nested task-note prompt aborts the write", async () => {
  await using view = await sidebar()
  const pending = deferred<string | undefined>()
  view.select(() => "note"); view.prompt(() => pending.promise)
  await view.click("Work ·")
  Object.assign(view.ctx.location!, { directory: "/other-vault" })
  pending.resolve("Synthetic task note"); await view.flush()
  expect(view.operations).toEqual([])
  expect(view.toasts.at(-1).message).toContain("reopen")
})

test("idle parent aggregates hidden native subagents and spinner frames reuse a memoized family map", async () => {
  const now = Date.now(), intervals = spyOn(globalThis, "setInterval"), aggregate = spyOn(SessionState.prototype, "familyMarkers")
  try {
    const parent = session("ses_A", { title: "Idle parent", time: { created: now, updated: now, busy: now - 100, idle: now, viewed: now } })
    const children = Array.from({ length: 2652 }, (_, index) => session(`ses_Child${index}`, { parentID: "ses_A", time: { created: now, updated: now, idle: now } }))
    const grandchild = session("ses_Grandchild", { parentID: "ses_Child0", time: { created: now, updated: now, busy: now + 1, idle: now } })
    const fork = session("ses_Fork", { parentID: "ses_A", fork: { sessionID: "ses_A", boundary: { type: "through", messageID: "msg_test" } }, time: { created: now, updated: now, busy: now + 1 } })
    await using view = await sidebar({ native: [parent, ...children, grandchild, fork], projects: [project("projects/P", { tasks: [] })] })
    expect(view.captureCharFrame()).not.toContain("ses_Grandchild")
    expect(view.lines()[view.position("Idle parent").y][0]).not.toBe("•")
    const before = aggregate.mock.calls.length, callback = intervals.mock.calls.find(([, delay]) => delay === 120)![0]
    for (let frame = 0; frame < 3; frame++) { if (typeof callback === "function") callback(); await view.flush() }
    expect(aggregate.mock.calls.length).toBe(before)
    view.emit("session.execution.interrupted", { sessionID: "ses_Grandchild" }, now + 2); await view.flush()
    expect(view.lines()[view.position("Idle parent").y][0]).toBe("•")
    view.emit("permission.asked", { sessionID: "ses_Child0", id: "r-child" }, now + 3); await view.flush()
    expect(view.lines()[view.position("Idle parent").y][0]).toBe("!")
    view.emit("permission.replied", { sessionID: "ses_Child0", requestID: "r-child" }, now + 4); await view.flush()
    expect(view.lines()[view.position("Idle parent").y][0]).toBe("•")
    view.native.splice(view.native.indexOf(grandchild), 1); await view.refresh()
    expect(view.lines()[view.position("Idle parent").y][0]).toBe("•")
  } finally { intervals.mockRestore(); aggregate.mockRestore() }
})

test("same native project ID never reuses a vault cache for a session outside that vault", async () => {
  const updated = Date.now() - 1000
  await using view = await sidebar({ native: [session("ses_A", { title: "Current session", time: { created: updated, updated } }), session("ses_B", { location: { directory: "/other-vault" }, time: { created: updated, updated } })] })
  view.route("ses_B"); await view.flush()
  expect(view.captureCharFrame()).not.toContain("Parent project")
  expect(view.captureCharFrame()).toContain("outside this vault scope")
})
