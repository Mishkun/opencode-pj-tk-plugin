import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import { envelope, projectArchiveDestination, projectPath, record, sid, text, projectStatuses, type Envelope } from "./contract"

export type Operation =
  | { kind: "list"; sessionID?: string }
  | { kind: "show" | "context" }
  | { kind: "link" | "unlink"; sessionID: string; title?: string }
  | { kind: "fork"; source: string; target: string; title?: string }
  | { kind: "status"; status: string }
  | { kind: "log"; text: string; sessionID?: string }
  | { kind: "task-create"; title: string }
  | { kind: "task-start" | "task-close"; taskID: string }
  | { kind: "task-note"; taskID: string; text: string }
  | { kind: "task-claim"; taskID: string; sessionID: string }
  | { kind: "project-archive" }
export function mutation(operation: Operation): boolean { return !["list", "show", "context"].includes(operation.kind) }
function positional(value: unknown, max = 100_000): string {
  const v = text(value, max)
  if (!v.trim() || v.startsWith("-")) throw new Error("Positional values must be nonempty and start with a non-option character")
  return v
}
function taskID(value: unknown): string {
  const id = positional(value, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error("Invalid local task ID")
  return id
}
export function parseOperation(value: unknown): Operation {
  const input = record(value)
  const keys: Record<string, string[]> = {
    list: ["sessionID"], show: [], context: [], link: ["sessionID", "title"], unlink: ["sessionID"],
    fork: ["source", "target", "title"], status: ["status"], log: ["text", "sessionID"],
    "task-create": ["title"], "task-start": ["taskID"], "task-close": ["taskID"],
    "task-note": ["taskID", "text"], "task-claim": ["taskID", "sessionID"],
    "project-archive": [],
  }
  const kind = text(input.kind)
  if (!Object.hasOwn(keys, kind) || Object.keys(input).some(key => key !== "kind" && !keys[kind].includes(key))) throw new Error("Unsupported operation or field")
  const operation = input as Operation
  if (operation.kind !== "project-archive") argsFor(operation)
  return operation
}
export function argsFor(op: Operation, project?: string): string[] {
  let args: string[]
  switch (op.kind) {
    case "list": args = ["list", "-a", "--archived", ...(op.sessionID === undefined ? [] : ["--session", sid(op.sessionID)])]; break
    case "show": case "context": args = [op.kind]; break
    case "link": case "unlink": args = ["session", op.kind, sid(op.sessionID), ...(op.title === undefined ? [] : ["--title", positional(op.title, 512)])]; break
    case "fork": args = ["session", "fork", sid(op.source), sid(op.target), ...(op.title === undefined ? [] : ["--title", positional(op.title, 512)])]; break
    case "status": if (!projectStatuses.includes(op.status as never)) throw new Error("Invalid project status"); args = ["status", op.status]; break
    case "log": args = ["log", positional(op.text), ...(op.sessionID === undefined ? [] : ["--session", sid(op.sessionID)])]; break
    case "task-create": args = ["tk", "create", positional(op.title, 512)]; break
    case "task-start": case "task-close": args = ["tk", op.kind === "task-start" ? "start" : "close", taskID(op.taskID)]; break
    case "task-note": args = ["tk", "add-note", taskID(op.taskID), positional(op.text)]; break
    case "task-claim": args = ["tk", "claim", taskID(op.taskID), sid(op.sessionID)]; break
    case "project-archive": args = ["move", projectArchiveDestination(project)]; break
    default: throw new Error("Unsupported operation")
  }
  return [...args, "--json"]
}
export type RunInput = { executable: string; args: string[]; cwd: string; signal?: AbortSignal; timeoutMs: number }
export type RunResult = { code: number | null; stdout: string; stderr: string; interrupted?: boolean }
export type Runner = (input: RunInput) => Promise<RunResult>
export const runProcess: Runner = input => new Promise((resolveResult, reject) => {
  input.signal?.throwIfAborted()
  const child = spawn(input.executable, input.args, { cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = "", interrupted = false
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (interrupted) return
    interrupted = true; child.kill("SIGTERM")
    force = setTimeout(() => child.kill("SIGKILL"), 2_000)
  }
  const timer = setTimeout(stop, input.timeoutMs)
  input.signal?.addEventListener("abort", stop, { once: true })
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", chunk => { if (interrupted) return; stdout += chunk; if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) { stdout = ""; stop() } })
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16_384) })
  child.on("error", reject)
  child.on("close", code => {
    clearTimeout(timer); clearTimeout(force); input.signal?.removeEventListener("abort", stop)
    resolveResult({ code, stdout, stderr, interrupted })
  })
})
export class BridgeError extends Error {
  constructor(message: string, readonly outcome: "not_written" | "unknown", readonly diagnostic?: string) { super(message) }
}
export type HostRequest = { signal?: AbortSignal }
type PreparedCommand = { args: string[]; cwd: string }

/** CLI transport for installed HOST UI and fork lifecycle operations.
 * Agents invoke pj directly through native shell. */
export class HostPjBridge {
  readonly authority = "host" as const
  constructor(readonly root: string, private readonly runner: Runner = runProcess, private readonly executable = process.env.OPENCODE_PJ_BIN || "pj") {
    if (!isAbsolute(root) || root.includes("\0")) throw new Error("Vault root must be absolute")
    if (!executable || executable.includes("\0")) throw new Error("Invalid pj executable")
  }
  private prepare(op: Operation, project?: string): PreparedCommand {
    const args = argsFor(op, project)
    if (["list", "fork"].includes(op.kind) && project !== undefined) throw new Error("List and fork run from the vault root")
    if (!["list", "fork"].includes(op.kind) && !project) throw new Error("Explicit project cwd required")
    const cwd = project ? resolve(this.root, projectPath(project)) : this.root
    return { args, cwd }
  }
  private async execute(op: Operation, command: PreparedCommand, signal?: AbortSignal): Promise<Envelope> {
    signal?.throwIfAborted()
    let result: RunResult
    try { result = await this.runner({ executable: this.executable, ...command, signal, timeoutMs: 30_000 }) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new BridgeError(`pj process failed: ${String(error)}`, code === "ENOENT" || code === "EACCES" || !mutation(op) ? "not_written" : "unknown")
    }
    if (result.interrupted) throw new BridgeError("pj execution interrupted; inspect saved state before taking another action", mutation(op) ? "unknown" : "not_written", result.stderr)
    try {
      const response = envelope(JSON.parse(result.stdout), mutation(op))
      if ((result.code === 0) !== response.ok) throw new Error("pj exit status contradicts its envelope")
      return response // Keep partial outcomes intact. Never retry, roll back or push.
    } catch (error) {
      throw new BridgeError(`Invalid pj response: ${String(error)}`, mutation(op) ? "unknown" : "not_written", result.stderr)
    }
  }
  call(op: Operation, project?: string, request: HostRequest = {}): Promise<Envelope> {
    return this.execute(op, this.prepare(op, project), request.signal)
  }
}
