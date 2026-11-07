import type { SessionInfo } from "@opencode/client"
import type { Project, Task } from "./contract"
import { inboxSessions } from "./projection"

export type PickerItem = { value: string; title: string; category: "Projects" | "Tasks" | "Sessions"; description: string; aliases: string[] } & (
  { kind: "project"; project: Project } | { kind: "task"; project: Project; task: Task } | { kind: "session"; sessionID: string }
)
export function pickerItems(projects: Project[], sessions: SessionInfo[], root: string, current: string): PickerItem[] {
  const active = projects.filter(project => project.path.startsWith("projects/"))
  const items: PickerItem[] = active.flatMap(project => [
    { kind: "project", value: `project:${project.path}`, title: project.name, category: "Projects", description: `${project.path} · ${project.status}`, aliases: [project.path], project } as PickerItem,
    ...project.tasks.map(task => ({ kind: "task", value: `task:${project.path}:${task.id}`, title: task.title, category: "Tasks", description: `${project.path} · ${task.id} · ${task.status}`, aliases: [project.path, task.id], project, task } as PickerItem)),
  ])
  const memberships = new Map<string, { title: string; paths: string[] }>()
  for (const project of active) for (const session of project.sessions) {
    const previous = memberships.get(session.id)
    memberships.set(session.id, { title: session.title || previous?.title || session.id, paths: [...(previous?.paths ?? []), project.path] })
  }
  const candidates = new Set([...inboxSessions([], sessions, root, current).map(session => session.id), ...memberships.keys()])
  const native = new Map(sessions.map(session => [session.id, session]))
  for (const id of candidates) {
    const member = memberships.get(id)
    items.push({ kind: "session", value: `session:${id}`, sessionID: id, title: native.get(id)?.title ?? member?.title ?? id, category: "Sessions", description: member?.paths.join(", ") ?? "", aliases: [id, ...(member?.paths ?? [])] })
  }
  // Add identity only where the title and category would otherwise be ambiguous.
  const counts = new Map<string, number>()
  for (const item of items) { const key = `${item.category}:${item.title}`; counts.set(key, (counts.get(key) ?? 0) + 1) }
  return items.map(item => counts.get(`${item.category}:${item.title}`)! > 1 ? { ...item, title: `${item.title} (${item.kind === "session" ? item.sessionID : item.kind === "task" ? `${item.project.path}/${item.task.id}` : item.project.path})` } : item)
}
function match(query: string, text: string): number {
  const value = text.toLocaleLowerCase()
  if (value === query) return 0
  if (value.startsWith(query)) return 1
  if (value.includes(query)) return 2
  let at = 0
  for (const char of value) if (char === query[at]) at++
  return at === query.length ? 3 : Infinity
}
export function fuzzyItems<T extends { title: string; aliases?: string[]; value: string }>(query: string, items: readonly T[]): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...items]
  return items.map((item, index) => ({ item, index, score: Math.min(...[item.title, ...(item.aliases ?? [])].map(text => match(needle, text))) }))
    .filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.item)
}

export function projectSymbol(status: string): string {
  return ({ backlog: "○", "in-progress": "◐", waiting: "◷", blocked: "!", done: "✓" } as Record<string, string>)[status] ?? "?"
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export function fitLabel(label: string, width: number): string {
  if (Bun.stringWidth(label) <= width) return label
  if (width < 1) return ""
  let text = "", used = 0
  for (const { segment } of graphemes.segment(label)) {
    const size = Bun.stringWidth(segment)
    if (used + size > width - 1) break
    text += segment; used += size
  }
  return `${text.trimEnd()}…`
}
