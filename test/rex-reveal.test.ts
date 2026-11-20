import { expect, test } from "bun:test"
import type { RunInput, Runner } from "../src/bridge"
import { revealProjectSessionsWith, tabLabel, type RevealInput } from "../src/rex-reveal"

const REX = "session:11111111-2222-3333-4444-555555555555"
const OTHER_REX = "session:99999999-8888-7777-6666-555555555555"
const DIRECTORY = "/vault/projects/P"
const PID = 4242

type MockProc = { pid: number; name: string; cwd: string }
type MockBlock = { block_id: string; label: string; placement: "placed" | "detached"; window_id?: string; proc: MockProc | null; status?: string[] }
type MockSession = { label: string; active?: string; windows: Map<string, string>; blocks: MockBlock[] }

/** Minimal in-memory Rex: block/window/session listings, process state,
 * program status and window creation. Routes are keyed by session+block+pid,
 * exactly like the PID-bound live route files. */
class RexMock {
  sessions = new Map<string, MockSession>()
  routes = new Map<string, string>()
  calls: string[][] = []
  behavior: "ok" | "error-created" | "error-none" | "ok-missing" = "ok"
  publishRoute: string | "expected" | "none" = "expected"
  failSessionList = false
  failForeignBlocks = false
  failWindows = false
  failProcess = false
  private sequence = 0
  readonly run: Runner = async (input: RunInput) => {
    this.calls.push(input.args)
    return this.respond(input.args)
  }
  addSession(id: string, label: string): MockSession {
    const session = { label, windows: new Map<string, string>(), blocks: [] as MockBlock[] }
    this.sessions.set(id, session)
    return session
  }
  addWindow(session: MockSession, label = "Window"): string {
    const id = `window:${++this.sequence}`
    session.windows.set(id, label)
    session.active ??= id
    return id
  }
  addBlock(session: MockSession, block: Omit<MockBlock, "block_id">): string {
    const id = `block:${String(++this.sequence).padStart(4, "0")}`
    session.blocks.push({ ...block, block_id: id })
    return id
  }
  routeKey(session: string, block: string, pid: number) { return `${session}|${block}|${pid}` }
  private respond(args: string[]): { code: number; stdout: string; stderr: string } {
    const target = this.sessions.get(REX)!
    const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
    const own = (session: string) => this.sessions.get(session)
    if (args[0] === "session" && args[1] === "ls") {
      if (this.failSessionList) return { code: 2, stdout: "", stderr: "session inventory unavailable" }
      return json({ sessions: [...this.sessions].map(([session_id, value]) => ({ session_id, label: value.label })) })
    }
    if (args[0] === "block" && args[1] === "ls") {
      const session = own(args[3])
      if (!session) return { code: 2, stdout: "", stderr: "no such session" }
      if (args[3] !== REX && this.failForeignBlocks) return { code: 2, stdout: "", stderr: "foreign block inventory unavailable" }
      return json({ blocks: session.blocks.map(({ block_id, label, placement, window_id }) => ({ block_id, label, placement, creator_name: "com.superlogical.terminal", ...(window_id ? { window_id } : {}) })) })
    }
    if (args[0] === "window" && args[1] === "ls") {
      if (this.failWindows) return { code: 2, stdout: "", stderr: "window listing unavailable" }
      const session = own(args[3])
      if (!session) return { code: 2, stdout: "", stderr: "no such session" }
      return json({ revision: 1, session_id: args[3], label: session.label, active_window_id: session.active, windows: [...session.windows].map(([window_id, label]) => ({ window_id, label })) })
    }
    if (args[0] === "block" && args[1] === "call") {
      const sessionID = args[3], blockID = args[5], method = args[6]
      const block = own(sessionID)?.blocks.find(value => value.block_id === blockID)
      if (!block) return { code: 2, stdout: "", stderr: "no such block" }
      if (method === "process" && this.failProcess) return { code: 2, stdout: "", stderr: "process state unavailable" }
      if (method === "process") return json({ last_exit: null, foreground: block.proc, child: block.proc, ancestors: [] })
      if (method === "com.superlogical.terminal.program_status") {
        return json({ records: (block.status ?? []).map(id => ({ id, state: "working", app: "opencode", owner: { pid: block.proc?.pid, name: block.proc?.name } })) })
      }
      return { code: 2, stdout: "", stderr: `unexpected method ${method}` }
    }
    if (args[0] === "window" && args[1] === "new") {
      if (this.behavior === "error-none") return { code: 1, stdout: "", stderr: "rex window new: timeout" }
      if (this.behavior === "ok-missing") return json({ window_id: "window:missing", block_ids: ["block:missing"], revision: 2 })
      const separator = args.indexOf("--"), label = args[separator - 1], cwd = args[args.indexOf("-c") + 1]
      const command = args.slice(separator + 1), nativeID = command[command.indexOf("--session") + 1]
      const window = this.addWindow(target, label)
      const id = this.addBlock(target, { label: "shell", placement: "placed", window_id: window, proc: { pid: PID, name: "opencode.exe", cwd } })
      if (this.publishRoute === "expected") this.routes.set(this.routeKey(REX, id, PID), nativeID)
      if (this.publishRoute !== "none" && this.publishRoute !== "expected") this.routes.set(this.routeKey(REX, id, PID), this.publishRoute)
      if (this.behavior === "error-created") return { code: 1, stdout: JSON.stringify({ window_id: window, block_ids: [id], revision: 2 }), stderr: "rex window new: connection closed" }
      return json({ window_id: window, block_ids: [id], revision: 2 })
    }
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` }
  }
  windowsCreated() { return this.calls.filter(args => args[0] === "window" && args[1] === "new") }
  processCalls() { return this.calls.filter(args => args[0] === "block" && args[1] === "call" && args[6] === "process") }
}

function mock(): RexMock {
  const rex = new RexMock()
  const session = rex.addSession(REX, "Onboarding")
  rex.addWindow(session, "Window A")
  return rex
}

function input(sessions: RevealInput["sessions"]): RevealInput {
  return { rexSession: REX, sessions }
}

const reveal = (rex: RexMock, value: RevealInput) =>
  revealProjectSessionsWith({ run: rex.run, executable: "/opt/rex", sleep: async () => {}, route: (session, block, pid) => rex.routes.get(rex.routeKey(session, block, pid)) }, value)

function resident(rex: RexMock, session: MockSession, identity: string, options: { placement?: "placed" | "detached"; label?: string; window?: string; pid?: number } = {}): { id: string; pid: number } {
  const pid = options.pid ?? PID
  const id = rex.addBlock(session, {
    label: options.label ?? "shell",
    placement: options.placement ?? "placed",
    ...(options.placement === "detached" ? {} : { window_id: options.window ?? session.active }),
    proc: { pid, name: "opencode.exe", cwd: DIRECTORY },
  })
  rex.routes.set(rex.routeKey(REX, id, pid), identity)
  return { id, pid }
}

test("tab labels are display-only and bounded, never identity", () => {
  expect(tabLabel("Session A", "ses_A")).toBe("Session A")
  expect(tabLabel("line\nbreak", "ses_A")).toBe("line break")
  expect(Array.from(tabLabel("x".repeat(400), "ses_A"))).toHaveLength(128)
  expect(tabLabel("", "ses_A")).toBe("ses_A")
})

test("a fresh PID-bound route is reused without launching or focusing", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  resident(rex, session, "ses_A", { label: "anything" })
  const result = await reveal(rex, input([{ id: "ses_A", title: "Session A", directory: DIRECTORY }]))
  expect(result).toEqual({ existing: 1, opened: 0, failed: [] })
  expect(rex.windowsCreated()).toHaveLength(0)
})

test("every process call names its Rex session explicitly", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  const { id } = resident(rex, session, "ses_A")
  await reveal(rex, input([{ id: "ses_A", title: "Session A", directory: DIRECTORY }]))
  expect(rex.processCalls().find(args => args[5] === id)).toEqual(["block", "call", "-s", REX, "-b", id, "process"])
})

test("a stale label never overrides the live route; a known-different pane permits opening", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  resident(rex, session, "ses_B", { label: "Session A [ses_A]" })
  const result = await reveal(rex, input([
    { id: "ses_A", title: "A", directory: DIRECTORY },
    { id: "ses_B", title: "B", directory: DIRECTORY },
  ]))
  expect(result).toMatchObject({ existing: 1, opened: 1 })
  expect(rex.windowsCreated()).toHaveLength(1)
  expect(rex.windowsCreated()[0]).toContain("A")
  expect(rex.windowsCreated()[0]).toContain("ses_A")
})

test("without a route, one uniquely owned native status record identifies the pane", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  const id = rex.addBlock(session, { label: "shell", placement: "placed", window_id: session.active, proc: { pid: PID, name: "opencode.exe", cwd: DIRECTORY }, status: ["rex-report", "ses_A"] })
  expect(id).toBeTruthy()
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toEqual({ existing: 1, opened: 0, failed: [] })
})

test("two native status records for one process are ambiguous and refuse a launch", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  rex.addBlock(session, { label: "shell", placement: "placed", window_id: session.active, proc: { pid: PID, name: "opencode.exe", cwd: DIRECTORY }, status: ["ses_A", "ses_B"] })
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result.opened).toBe(0)
  expect(result.failed.join("\n")).toContain("identity unconfirmed")
  expect(rex.windowsCreated()).toHaveLength(0)
})

test("an OpenCode pane with no route and no usable status record blocks duplication", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  rex.addBlock(session, { label: "ses_A [ses_A]", placement: "placed", window_id: session.active, proc: { pid: PID, name: "opencode.exe", cwd: DIRECTORY }, status: ["rex-report"] })
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("identity unconfirmed")
})

test("a resident but detached pane counts as existing and is reported as unmounted", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  const { id } = resident(rex, session, "ses_A", { placement: "detached" })
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 1, opened: 0 })
  expect(result.failed.join("\n")).toContain(`resident but unmounted (${id})`)
})

test("multiple panes showing one session choose deterministically and open nothing", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  const other = rex.addWindow(session, "Window B")
  resident(rex, session, "ses_A", { window: other, pid: 5001 })
  const active = resident(rex, session, "ses_A", { window: session.active, pid: 5002 })
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 1, opened: 0 })
  expect(result.failed.join("\n")).toContain(`2 panes show this session; reused ${active.id} deterministically`)
  expect(rex.windowsCreated()).toHaveLength(0)
})

test("a session verified in another Rex session is reported instead of duplicated", async () => {
  const rex = mock()
  const other = rex.addSession(OTHER_REX, "Elsewhere")
  const window = rex.addWindow(other, "Window")
  const id = rex.addBlock(other, { label: "shell", placement: "placed", window_id: window, proc: { pid: 7001, name: "opencode.exe", cwd: DIRECTORY } })
  rex.routes.set(rex.routeKey(OTHER_REX, id, 7001), "ses_A")
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("already open in Rex session Elsewhere")
  expect(rex.windowsCreated()).toHaveLength(0)
  expect(rex.processCalls().some(args => args[3] === OTHER_REX)).toBe(true)
})

test("failed foreign inventory refuses every new launch", async () => {
  for (const configure of [(rex: RexMock) => { rex.failSessionList = true }, (rex: RexMock) => { rex.failForeignBlocks = true }]) {
    const rex = mock()
    const other = rex.addSession(OTHER_REX, "Elsewhere")
    rex.addWindow(other, "Window")
    configure(rex)
    const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
    expect(result).toMatchObject({ existing: 0, opened: 0 })
    expect(result.failed.join("\n")).toContain("could not be verified")
    expect(rex.windowsCreated()).toHaveLength(0)
  }
})

test("missing sessions open one tab named by title, with a separate argument vector", async () => {
  const rex = mock()
  const result = await reveal(rex, input([{ id: "ses_B", title: "Session B", directory: DIRECTORY }]))
  expect(result).toEqual({ existing: 0, opened: 1, failed: [] })
  expect(rex.windowsCreated()[0]).toEqual([
    "window", "new", "-s", REX, "--json", "--focus=false", "--shell=none", "-c", DIRECTORY,
    "Session B", "--", "opencode", "--session", "ses_B", DIRECTORY,
  ])
  const created = rex.sessions.get(REX)!.blocks.at(-1)!
  expect(created.label).toBe("shell")
  expect(created.window_id).toBe([...rex.sessions.get(REX)!.windows.keys()].at(-1)!)
  expect(rex.sessions.get(REX)!.windows.get(created.window_id!)).toBe("Session B")
})

test("a created pane is counted only when its live route confirms the session", async () => {
  const rex = mock()
  rex.publishRoute = "none"
  const result = await reveal(rex, input([{ id: "ses_B", title: "B", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("live route was not confirmed")
})

test("a pane that navigated elsewhere right after launch is not counted", async () => {
  const rex = mock()
  rex.publishRoute = "ses_C"
  const result = await reveal(rex, input([{ id: "ses_B", title: "B", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("shows ses_C, not ses_B")
})

test("an uncertain launch is verified from state once and never retried", async () => {
  const rex = mock()
  rex.behavior = "error-created"
  const result = await reveal(rex, input([{ id: "ses_B", title: "B", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 1 })
  expect(result.failed.join("\n")).toContain("one verified pane is present")
  expect(rex.windowsCreated()).toHaveLength(1)
})

test("a launch that left no state reports one failure without a retry", async () => {
  const rex = mock()
  rex.behavior = "error-none"
  const result = await reveal(rex, input([{ id: "ses_B", title: "B", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("no verified pane was found")
  expect(rex.windowsCreated()).toHaveLength(1)
})

test("a success response without a pane in state is not counted as opened", async () => {
  const rex = mock()
  rex.behavior = "ok-missing"
  const result = await reveal(rex, input([{ id: "ses_B", title: "B", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("not found in Rex state")
})

test("invalid members are reported before launch; window listing failure is not fatal", async () => {
  const rex = mock()
  rex.failWindows = true
  const result = await reveal(rex, input([
    { id: "bad", title: "Bad", directory: DIRECTORY },
    { id: "ses_B", title: "B", directory: "relative" },
    { id: "ses_C", title: "C", directory: DIRECTORY },
  ]))
  expect(result).toMatchObject({ existing: 0, opened: 1 })
  expect(result.failed.join("\n")).toContain("not a native OpenCode session ID")
  expect(result.failed.join("\n")).toContain("invalid session directory")
})

test("one invocation reveals several members in input order and deduplicates IDs", async () => {
  const rex = mock()
  const session = rex.sessions.get(REX)!
  resident(rex, session, "ses_A")
  const result = await reveal(rex, input([
    { id: "ses_A", title: "A", directory: DIRECTORY },
    { id: "ses_B", title: "B", directory: DIRECTORY },
    { id: "ses_B", title: "B", directory: DIRECTORY },
  ]))
  expect(result).toEqual({ existing: 1, opened: 1, failed: [] })
  expect(rex.windowsCreated()).toHaveLength(1)
})

test("unreadable process state is uncertainty and refuses new launches", async () => {
  const rex = mock()
  rex.failProcess = true
  rex.addBlock(rex.sessions.get(REX)!, { label: "shell", placement: "placed", window_id: rex.sessions.get(REX)!.active, proc: { pid: PID, name: "opencode.exe", cwd: DIRECTORY } })
  const result = await reveal(rex, input([{ id: "ses_A", title: "A", directory: DIRECTORY }]))
  expect(result).toMatchObject({ existing: 0, opened: 0 })
  expect(result.failed.join("\n")).toContain("Rex process state could not be read")
  expect(rex.windowsCreated()).toHaveLength(0)
})

test("an invalid Rex session is rejected before spawning", async () => {
  const rex = mock()
  await expect(revealProjectSessionsWith({ run: rex.run, sleep: async () => {} }, { rexSession: "sessions/x", sessions: [] })).rejects.toThrow("Rex session")
  expect(rex.calls).toHaveLength(0)
})
