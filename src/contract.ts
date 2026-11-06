export type ProjectStatus = "backlog" | "in-progress" | "waiting" | "blocked" | "done"
export type TaskStatus = "open" | "in_progress" | "closed"
export type Task = {
  id: string; title: string; status: TaskStatus; parent: string | null; deps: string[]; links: string[]
  claimed_by_sessions: string[]; ready: boolean; body: string; path: string
}
export type Project = {
  path: string; name: string; parent: string | null; status: ProjectStatus
  sessions: { id: string; title: string }[]; tasks: Task[]; notePath: string
}
export type Write = {
  state: "committed" | "not_written" | "saved_uncommitted" | "unchanged" | "unknown"
  paths: string[]; commit: string | null; [key: string]: unknown
}
export type Envelope = {
  version: 1; ok: boolean; project: string | null; data: Record<string, unknown>
  write?: Write; error?: { code: string; message?: string; [key: string]: unknown }
}
export const projectStatuses: ProjectStatus[] = ["backlog", "in-progress", "waiting", "blocked", "done"]
export class ContractError extends Error {}
/** Render declared RPC errors without dumping arbitrary response data. */
export function errorMessage(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 2000)
  if (value && typeof value === "object") {
    const error = value as { message?: unknown; type?: unknown; code?: unknown }
    const code = typeof error.type === "string" ? error.type : typeof error.code === "string" ? error.code : ""
    if (typeof error.message === "string" && error.message) {
      return `${code && !error.message.startsWith(code) ? `${code}: ` : ""}${error.message}`.slice(0, 2000)
    }
    if (code) return code.slice(0, 2000)
  }
  return "Project operation failed; no readable error was provided."
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("Expected an object")
  return value as Record<string, unknown>
}
export function text(value: unknown, max = 100_000): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > max) throw new ContractError("Invalid text")
  return value
}
export function sid(value: unknown): string {
  const id = text(value, 128)
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new ContractError("Invalid session ID")
  return id
}
export function relativePath(value: unknown): string {
  const path = text(value, 4096)
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new ContractError("Expected a bounded relative path")
  return path
}
export function projectPath(value: unknown): string {
  const path = relativePath(value)
  if (!/^(projects|\.archived)\/.+/.test(path)) throw new ContractError("Project path must be inside projects/ or .archived/")
  return path
}
export function projectArchiveDestination(value: unknown): string {
  const path = projectPath(value)
  if (!path.startsWith("projects/")) throw new ContractError("Project archive requires an active projects/ path")
  return `.archived/${path.slice("projects/".length)}`
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new ContractError("Expected an array")
  return value.map(v => text(v))
}
export function task(value: unknown): Task {
  const t = record(value)
  const status = text(t.status)
  if (!["open", "in_progress", "closed"].includes(status) || typeof t.ready !== "boolean") throw new ContractError("Invalid task state")
  return {
    id: text(t.id, 256), title: text(t.title), status: status as TaskStatus,
    parent: t.parent === null ? null : text(t.parent, 256), deps: strings(t.deps), links: strings(t.links),
    claimed_by_sessions: strings(t.claimed_by_sessions).map(sid), ready: t.ready, body: text(t.body, 8_000_000), path: relativePath(t.path),
  }
}
export function project(value: unknown): Project {
  const p = record(value)
  const status = text(p.status) as ProjectStatus
  if (!projectStatuses.includes(status) || !Array.isArray(p.sessions) || !Array.isArray(p.tasks)) throw new ContractError("Invalid project state")
  return {
    path: projectPath(p.path), name: text(p.name), parent: p.parent === null ? null : projectPath(p.parent), status,
    sessions: p.sessions.map(s => { const x = record(s); return { id: sid(x.id), title: text(x.title) } }),
    tasks: p.tasks.map(task), notePath: relativePath(p.notePath),
  }
}
export function projectsFrom(envelope: Envelope): Project[] {
  if (!envelope.ok) throw new ContractError(envelope.error?.message ?? envelope.error?.code ?? "pj list failed")
  if (!Array.isArray(envelope.data.projects)) throw new ContractError("Missing data.projects")
  const projects = envelope.data.projects.map(project)
  if (new Set(projects.map(p => p.path)).size !== projects.length) throw new ContractError("Duplicate project paths")
  return projects
}
export function envelope(value: unknown, mutation: boolean): Envelope {
  const e = record(value)
  if (e.version !== 1 || typeof e.ok !== "boolean" || !(e.project === null || typeof e.project === "string")) throw new ContractError("Unsupported pj envelope")
  if (e.project !== null) projectPath(e.project)
  record(e.data)
  if (mutation && !e.write) throw new ContractError("Missing mutation write outcome")
  if (e.write) {
    const w = record(e.write)
    if (!["committed", "not_written", "saved_uncommitted", "unchanged", "unknown"].includes(text(w.state))) throw new ContractError("Invalid write state")
    strings(w.paths).forEach(relativePath)
    if (w.commit !== null && (typeof w.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(w.commit))) throw new ContractError("Invalid commit evidence")
    if (w.state === "committed" && !w.commit) throw new ContractError("Missing verified commit")
    if (["not_written", "saved_uncommitted"].includes(String(w.state)) && w.commit !== null) throw new ContractError("Contradictory commit evidence")
    if (e.ok && !["committed", "unchanged"].includes(String(w.state))) throw new ContractError("Success requires committed or unchanged state")
  }
  if (!e.ok) { const error = record(e.error); text(error.code); if (error.message !== undefined) text(error.message) }
  return e as Envelope
}
export function failureMessage(result: Envelope): string {
  const write = result.write
  return [result.error?.message ?? result.error?.code ?? "pj command failed", write && `write=${write.state}; saved=${write.paths.join(", ") || "none"}; commit=${write.commit ?? "unconfirmed"}`].filter(Boolean).join(". ")
}
