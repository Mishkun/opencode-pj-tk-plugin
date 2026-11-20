import { runProcess, type Runner } from "./bridge"
import { readRexRoute } from "./rex-route"

/** One pj member session, as resolved by the TUI from the native inventory. */
export type RevealSession = { id: string; title: string; directory: string }
export type RevealInput = { rexSession: string; sessions: RevealSession[] }
export type RevealResult = { existing: number; opened: number; failed: string[] }
export type RevealDeps = {
  run?: Runner
  executable?: string
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** PID-bound live TUI route. Injectable so tests never touch the filesystem. */
  route?: (session: string, block: string, pid: number) => string | undefined
}

const REX_SESSION = /^session:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const NATIVE_SESSION = /^ses_[A-Za-z0-9]+$/
const BLOCK_ID = /^block:/
const WINDOW_ID = /^window:/
const MAX_LABEL = 128
const OPEN_CODE = /^opencode(?:\.exe)?$/i
const MAX_FOREIGN_BLOCKS = 200

type Placement = "placed" | "detached"
type ProgramInfo = { pid?: number; name?: string; path?: string; argv0?: string; cwd?: string }
type Proc = { foreground?: ProgramInfo | null; child?: ProgramInfo | null } | null
type Block = { block_id: string; label: string; placement: Placement; window_id?: string; creator?: string }
type Pane = Block & { active: boolean; windowLabel?: string; proc: Proc | undefined; identity?: string }
type Caller = Required<Pick<RevealDeps, "run" | "executable" | "timeoutMs">>

function text(value: unknown, max = 2048): string {
  return typeof value === "string" && !value.includes("\0") ? value.slice(0, max) : ""
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function message(error: unknown, max = 500): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Rex call failed"
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) || "Rex call failed"
}
function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false
  const trim = (value: string) => value.length > 1 ? value.replace(/\/+$/, "") : value
  return trim(a) === trim(b)
}
function executableName(process: ProgramInfo | null | undefined): string {
  if (!process) return ""
  const name = text(process.name, 256)
  if (name) return name
  const path = text(process.path, 4096)
  if (path) return path.slice(path.lastIndexOf("/") + 1)
  return text(process.argv0, 256)
}
function isOpenCode(proc: Proc | undefined): boolean {
  return OPEN_CODE.test(executableName(proc?.foreground)) || OPEN_CODE.test(executableName(proc?.child))
}
function placement(value: unknown): Placement {
  // Unknown placements are treated as detached, as Rex documents.
  return value === "placed" ? "placed" : "detached"
}

/** Window/tab name only. It is never used to infer a session identity. */
export function tabLabel(title: string, fallback: string): string {
  const clean = title.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  const value = clean || fallback
  return Array.from(value).slice(0, MAX_LABEL).join("")
}

class RexCallError extends Error {
  constructor(readonly action: string, readonly detail: string) {
    super(`${action}: ${detail}`)
  }
}

function rex(args: string[], context: Caller): Promise<unknown> {
  const label = args.slice(0, 2).join(" ")
  return (async () => {
    let result
    try {
      result = await context.run({ executable: context.executable, args, cwd: process.cwd(), timeoutMs: context.timeoutMs })
    } catch (error) {
      throw new RexCallError(label, message(error))
    }
    if (result.interrupted) throw new RexCallError(label, "interrupted; state must be inspected before another attempt")
    if (result.code !== 0) throw new RexCallError(label, text(result.stderr, 500).trim() || `exit status ${result.code ?? "unknown"}`)
    try { return JSON.parse(result.stdout) } catch { throw new RexCallError(label, "returned unreadable JSON") }
  })()
}

const TERMINAL = "com.superlogical.terminal"

async function listBlocks(rexSession: string, context: Caller): Promise<Block[]> {
  const payload = object(await rex(["block", "ls", "-s", rexSession, "--json"], context))
  if (!Array.isArray(payload.blocks)) throw new RexCallError("block ls", "response has no block list")
  return payload.blocks.map((value): Block => {
    const block = object(value)
    const id = text(block.block_id, 128), label = text(block.label, MAX_LABEL)
    if (!BLOCK_ID.test(id)) throw new RexCallError("block ls", "a block has no usable ID")
    return {
      block_id: id, label, placement: placement(block.placement),
      ...(typeof block.window_id === "string" ? { window_id: block.window_id } : {}),
      ...(typeof block.creator_name === "string" ? { creator: text(block.creator_name, 256) } : {}),
    }
  })
}

async function listWindows(rexSession: string, context: Caller): Promise<{ active?: string; labels: Map<string, string> }> {
  const payload = object(await rex(["window", "ls", "-s", rexSession, "--json"], context))
  const labels = new Map<string, string>()
  for (const value of array(payload.windows)) {
    const window = object(value)
    const id = text(window.window_id, 128)
    if (WINDOW_ID.test(id)) labels.set(id, text(window.label, 128) || id)
  }
  const active = text(payload.active_window_id, 128)
  return { ...(WINDOW_ID.test(active) ? { active } : {}), labels }
}

/** Every block call names its owning Rex session explicitly, including blocks
 * this client does not own; nothing depends on the ambient default session. */
async function readProcess(rexSession: string, blockID: string, context: Caller): Promise<Proc | undefined> {
  const info = (value: unknown): ProgramInfo | null => {
    if (!value || typeof value !== "object") return null
    const source = object(value)
    return {
      ...(typeof source.pid === "number" && Number.isSafeInteger(source.pid) && source.pid > 0 ? { pid: source.pid } : {}),
      ...(typeof source.name === "string" ? { name: text(source.name, 256) } : {}),
      ...(typeof source.path === "string" ? { path: text(source.path, 4096) } : {}),
      ...(typeof source.argv0 === "string" ? { argv0: text(source.argv0, 256) } : {}),
      ...(typeof source.cwd === "string" ? { cwd: text(source.cwd, 4096) } : {}),
    }
  }
  try {
    const payload = object(await rex(["block", "call", "-s", rexSession, "-b", blockID, "process"], context))
    return { foreground: info(payload.foreground), child: info(payload.child) }
  } catch { return undefined }
}

/** Terminal program reports are a fallback only: a native ID counts when the
 * foreground process owns exactly one distinct `ses_` record. */
async function statusIdentity(rexSession: string, blockID: string, foreground: ProgramInfo, context: Caller): Promise<string | undefined> {
  let payload: Record<string, unknown>
  try {
    payload = object(await rex(["block", "call", "-s", rexSession, "-b", blockID, "com.superlogical.terminal.program_status"], context))
  } catch { return undefined }
  const ids = new Set<string>()
  for (const value of array(payload.records)) {
    const record = object(value), id = text(record.id, 128), owner = object(record.owner)
    if (!NATIVE_SESSION.test(id)) continue
    if (owner.pid !== foreground.pid || text(owner.name, 256) !== text(foreground.name, 256)) continue
    ids.add(id)
  }
  // Two native IDs for one process cannot identify the visible conversation.
  return ids.size === 1 ? [...ids][0] : undefined
}

async function identify(rexSession: string, block: Block, proc: Proc | undefined, context: Caller, route: NonNullable<RevealDeps["route"]>): Promise<string | undefined> {
  const foreground = proc?.foreground
  if (!isOpenCode(proc) || !foreground) return undefined
  if (foreground.pid !== undefined) {
    // Fresh PID-bound route is authoritative: a stale label or an old report
    // must never override what the live TUI now shows.
    const live = route(rexSession, block.block_id, foreground.pid)
    if (live !== undefined) return NATIVE_SESSION.test(live) ? live : undefined
  }
  return statusIdentity(rexSession, block.block_id, foreground, context)
}

function pick(...candidates: Pane[]): Pane {
  // Deterministic and never destructive: active window first, then placed,
  // then the lexicographically smallest block ID.
  return [...candidates].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (a.placement !== b.placement) return a.placement === "placed" ? -1 : 1
    return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0
  })[0]
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Reveal every member session in one Rex invocation. Identity comes from a
 * fresh PID-bound route (or one uniquely owned native status record); labels,
 * window names and terminal titles are display only. Existing panes are
 * reused, missing sessions are opened once as tabs in the given Rex session,
 * and an unverifiable foreign inventory refuses new launches. */
export async function revealProjectSessions(input: RevealInput): Promise<RevealResult> {
  return revealProjectSessionsWith({}, input)
}

export async function revealProjectSessionsWith(deps: RevealDeps, input: RevealInput): Promise<RevealResult> {
  const rexSession = typeof input?.rexSession === "string" ? input.rexSession : ""
  if (!REX_SESSION.test(rexSession)) throw new Error("Reveal requires the current Rex session (session:<uuid>)")
  const context: Caller = { run: deps.run ?? runProcess, executable: deps.executable ?? process.env.REX_BIN ?? "rex", timeoutMs: deps.timeoutMs ?? 15_000 }
  const route = deps.route ?? readRexRoute
  const sleep = deps.sleep ?? defaultSleep
  const failed: string[] = []

  const members: RevealSession[] = []
  const seen = new Set<string>()
  for (const value of Array.isArray(input.sessions) ? input.sessions : []) {
    const session = object(value)
    const id = text(session.id, 128), title = text(session.title, 512) || id, directory = text(session.directory, 4096)
    if (!NATIVE_SESSION.test(id)) { failed.push(`${id || "unnamed session"}: not a native OpenCode session ID`); continue }
    if (seen.has(id)) continue
    if (!directory.startsWith("/")) { failed.push(`${id}: invalid session directory`); continue }
    seen.add(id)
    members.push({ id, title, directory })
  }
  let existing = 0, opened = 0
  if (members.length === 0) return { existing, opened, failed }

  const blocks = await listBlocks(rexSession, context)
  const view: { active?: string; labels: Map<string, string> } = await listWindows(rexSession, context).catch(() => ({ labels: new Map<string, string>() }))
  const panes: Pane[] = []
  // Only terminal blocks can host a TUI. Other block types are not candidates
  // and their missing process state is not uncertainty.
  for (const block of blocks.filter(block => block.creator === TERMINAL)) {
    const proc = await readProcess(rexSession, block.block_id, context)
    panes.push({
      ...block,
      active: view.active !== undefined && block.window_id === view.active,
      ...(block.window_id ? { windowLabel: view.labels.get(block.window_id) } : {}),
      proc,
      identity: await identify(rexSession, block, proc, context, route),
    })
  }

  const memberByID = new Map(members.map(member => [member.id, member]))
  const confirmed = new Map<string, Pane[]>()
  for (const pane of panes) if (pane.identity && memberByID.has(pane.identity)) {
    const list = confirmed.get(pane.identity) ?? []
    list.push(pane)
    confirmed.set(pane.identity, list)
  }

  // Unreadable process state is uncertainty, not absence: no launch may guess.
  const unreadable = panes.find(pane => pane.proc === undefined)
  let inventoryError: string | undefined = unreadable ? `process state for ${unreadable.block_id} could not be read` : undefined
  if (unreadable) failed.push(`Rex process state could not be read (${unreadable.block_id}); no new pane was opened`)

  // Foreign Rex sessions are inventoried fail-closed: a launch is only safe
  // when we know the conversation is not already open somewhere else.
  const elsewhere = new Map<string, string>()
  const pending = members.filter(member => (confirmed.get(member.id) ?? []).length === 0)
  if (pending.length > 0) {
    let foreignBlocks = 0
    try {
      const listing = object(await rex(["session", "ls", "--json"], context))
      for (const value of array(listing.sessions)) {
        const session = object(value)
        const id = text(session.session_id, 128), label = text(session.label, 128) || id
        if (!REX_SESSION.test(id) || id === rexSession) continue
        const foreign = (await listBlocks(id, context)).filter(block => block.creator === TERMINAL)
        foreignBlocks += foreign.length
        if (foreignBlocks > MAX_FOREIGN_BLOCKS) throw new RexCallError("foreign inventory", "too many blocks to verify")
        for (const block of foreign) {
          if (elsewhere.size >= pending.length && pending.every(member => elsewhere.has(member.id))) break
          const proc = await readProcess(id, block.block_id, context)
          if (proc === undefined) throw new RexCallError("foreign inventory", `process state for ${block.block_id} could not be read`)
          const identity = await identify(id, block, proc, context, route)
          if (!identity || !pending.some(member => member.id === identity) || elsewhere.has(identity)) continue
          elsewhere.set(identity, label)
        }
      }
    } catch (error) {
      inventoryError ??= message(error)
      failed.push(`other Rex sessions could not be verified (${inventoryError}); no new pane was opened`)
    }
  }

  for (const member of members) {
    const resident = confirmed.get(member.id) ?? []
    if (resident.length > 0) {
      existing++
      const chosen = pick(...resident)
      if (chosen.placement === "detached") failed.push(`${member.id}: resident but unmounted (${chosen.block_id}); place it with rex move`)
      else if (view.active !== undefined && chosen.window_id !== view.active) failed.push(`${member.id}: already open in another window (${chosen.windowLabel ?? chosen.window_id})`)
      if (resident.length > 1) failed.push(`${member.id}: ${resident.length} panes show this session; reused ${chosen.block_id} deterministically`)
      continue
    }
    const other = elsewhere.get(member.id)
    if (other) { failed.push(`${member.id}: already open in Rex session ${other}; not duplicated here`); continue }
    if (inventoryError) { failed.push(`${member.id}: not opened because the available panes could not all be verified`); continue }

    // An unidentifiable live OpenCode pane in the same directory might be this
    // session. Opening another tab would guess; report it instead.
    const unknown = panes.find(pane => {
      if (pane.identity !== undefined) return false
      if (!isOpenCode(pane.proc)) return false
      const cwd = pane.proc?.foreground?.cwd ?? pane.proc?.child?.cwd
      return sameDirectory(cwd, member.directory)
    })
    if (unknown) {
      failed.push(`${member.id}: an OpenCode pane in ${member.directory} has no fresh route (${unknown.block_id}); identity unconfirmed, not opening a duplicate`)
      continue
    }

    const label = tabLabel(member.title, member.id)
    const before = new Set(panes.map(pane => pane.block_id))
    try {
      const created = object(await rex(["window", "new", "-s", rexSession, "--json", "--focus=false", "--shell=none", "-c", member.directory, label, "--", "opencode", "--session", member.id, member.directory], context))
      const window = text(created.window_id, 128)
      const blockID = array(created.block_ids).map(value => text(value, 128)).find(value => BLOCK_ID.test(value)) ?? ""
      const verified = await confirmOpened(rexSession, member.id, { blockID, window, before }, context, route, sleep)
      if (verified.ok) opened++
      else failed.push(`${member.id}: ${verified.error}`)
    } catch (error) {
      // The launch is uncertain: read state before deciding. Never retry.
      const recovered = await confirmOpened(rexSession, member.id, { blockID: "", window: "", before }, context, route, sleep)
      if (recovered.ok) {
        opened++
        failed.push(`${member.id}: launch response was uncertain (${message(error)}), but one verified pane is present`)
      } else failed.push(`${member.id}: ${message(error)}; no verified pane was found`)
    }
  }
  return { existing, opened, failed }
}

async function confirmOpened(
  rexSession: string,
  nativeID: string,
  expected: { blockID: string; window: string; before: Set<string> },
  context: Caller,
  route: NonNullable<RevealDeps["route"]>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  let pane: Block | undefined
  for (let attempt = 0; attempt < 3 && !pane; attempt++) {
    if (attempt > 0) await sleep(150)
    let blocks: Block[]
    try { blocks = await listBlocks(rexSession, context) }
    catch (error) { return { ok: false, error: `${message(error)}; opened state unknown` } }
    pane = blocks.find(block => (expected.blockID !== "" && block.block_id === expected.blockID) || (block.block_id !== "" && !expected.before.has(block.block_id) && block.placement === "placed" && expected.blockID === "" && expected.window === ""))
  }
  if (!pane) return { ok: false, error: "the new pane was not found in Rex state" }
  if (pane.placement !== "placed") return { ok: false, error: `the new pane is not placed in a window (${pane.block_id})` }
  if (expected.window && pane.window_id !== expected.window) return { ok: false, error: `the new pane was placed in an unexpected window (${pane.block_id})` }
  // The block must show the requested conversation in the live TUI, not just
  // carry a name. Poll the PID-bound route until the new TUI publishes it.
  for (let attempt = 0; attempt < 16; attempt++) {
    if (attempt > 0) await sleep(250)
    const proc = await readProcess(rexSession, pane.block_id, context)
    const pid = proc?.foreground?.pid
    if (!proc || !isOpenCode(proc) || pid === undefined) continue
    const live = route(rexSession, pane.block_id, pid)
    if (live === nativeID) return { ok: true }
    if (live !== undefined) return { ok: false, error: `the new pane shows ${live}, not ${nativeID} (${pane.block_id})` }
  }
  return { ok: false, error: `pane ${pane.block_id} was created but its live route was not confirmed` }
}
