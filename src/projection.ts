import type { Project, Task } from "./contract"
import type { SessionInfo } from "@opencode/client"
import { isAbsolute, relative, resolve } from "node:path"

/** Native session activity includes execution boundaries; viewing and archiving
 * have their own timestamps and do not advance activity. */
export function sessionActivity(session?: Pick<SessionInfo, "time">): number | undefined {
  const time = session?.time
  return [time?.created, time?.updated, time?.busy, time?.idle].reduce<number | undefined>((latest, value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? Math.max(latest ?? value, value) : latest, undefined)
}
const recentFirst = (left: number | undefined, right: number | undefined) => (right ?? -1) - (left ?? -1)
const compareSessions = (left: SessionInfo, right: SessionInfo) => recentFirst(sessionActivity(left), sessionActivity(right)) || left.id.localeCompare(right.id)

export type ActivityGroupLabel = "Today" | "Yesterday" | "Last 7 days" | "Earlier"
export function activityGroup(activity: number | undefined, now: number): ActivityGroupLabel {
  if (activity === undefined) return "Earlier"
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const week = new Date(today)
  week.setDate(week.getDate() - 6)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  return activity >= today.getTime() ? "Today" : activity >= yesterday.getTime() ? "Yesterday" : activity >= week.getTime() ? "Last 7 days" : "Earlier"
}
export function relativeAge(activity: number | undefined, now: number): string {
  if (activity === undefined) return "—"
  const minutes = Math.floor(Math.max(0, now - activity) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  return hours < 24 ? `${hours}h` : days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}

export type ProjectNode = { project: Project; children: ProjectNode[]; related: boolean; activity?: number }
export function projectTree(projects: Project[], sessionID: string, sessions: readonly SessionInfo[] = []): ProjectNode[] {
  const activity = new Map(sessions.map(session => [session.id, sessionActivity(session)]))
  const nodes = new Map<string, ProjectNode>(projects.filter(project => project.path.startsWith("projects/")).map(project => [project.path, {
    project: { ...project, sessions: [...project.sessions].sort((a, b) => recentFirst(activity.get(a.id), activity.get(b.id)) || a.id.localeCompare(b.id)) },
    children: [], related: project.sessions.some(s => s.id === sessionID),
    activity: project.sessions.reduce<number | undefined>((latest, session) => {
      const value = activity.get(session.id)
      return value === undefined ? latest : Math.max(latest ?? value, value)
    }, undefined),
  }]))
  const roots: ProjectNode[] = []
  for (const node of nodes.values()) {
    const parent = node.project.parent && nodes.get(node.project.parent)
    // Require real enclosing folder ancestry. Malformed cycles cannot swallow nodes.
    if (parent && node.project.path.startsWith(`${parent.project.path}/`)) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (items: ProjectNode[]) => {
    for (const node of items) {
      sort(node.children)
      for (const child of node.children) {
        if (child.activity !== undefined) node.activity = Math.max(node.activity ?? child.activity, child.activity)
        node.related ||= child.related
      }
    }
    items.sort((a, b) => recentFirst(a.activity, b.activity) || a.project.path.localeCompare(b.project.path))
  }
  sort(roots)
  return roots
}
export type ActivityEntry = { kind: "project"; node: ProjectNode } | { kind: "session"; session: SessionInfo }
export function activityGroups(projects: readonly ProjectNode[], sessions: readonly SessionInfo[], now: number): { label: ActivityGroupLabel; entries: ActivityEntry[] }[] {
  const groups = (["Today", "Yesterday", "Last 7 days", "Earlier"] as const).map(label => ({ label, entries: [] as ActivityEntry[] }))
  const group = (activity: number | undefined) => groups.find(group => group.label === activityGroup(activity, now))!
  for (const node of [...projects].sort((a, b) => recentFirst(a.activity, b.activity) || a.project.path.localeCompare(b.project.path))) group(node.activity).entries.push({ kind: "project", node })
  for (const session of [...sessions].sort(compareSessions)) group(sessionActivity(session)).entries.push({ kind: "session", session })
  return groups.filter(group => group.entries.length)
}
export type TaskNode = { task: Task; children: TaskNode[] }
/** A task appears in each matching membership bucket. Claims outside the
 * project's memberships stay reachable in the unassigned/fallback bucket. */
export function projectTaskBuckets(project: Project): { sessions: Map<string, Task[]>; tasks: Task[] } {
  const sessions = new Map(project.sessions.map(session => [session.id, [] as Task[]]))
  const tasks: Task[] = []
  for (const task of project.tasks) {
    let assigned = false
    for (const id of new Set(task.claimed_by_sessions)) {
      const bucket = sessions.get(id)
      if (bucket) { bucket.push(task); assigned = true }
    }
    if (!assigned) tasks.push(task)
  }
  return { sessions, tasks }
}
export function taskTree(tasks: Task[]): TaskNode[] {
  const nodes = new Map(tasks.map(task => [task.id, { task, children: [] as TaskNode[] }]))
  const roots: TaskNode[] = []
  for (const node of nodes.values()) {
    let parent = node.task.parent ? nodes.get(node.task.parent) : undefined
    const seen = new Set([node.task.id])
    let ancestor = parent
    while (ancestor) {
      if (seen.has(ancestor.task.id)) { parent = undefined; break }
      seen.add(ancestor.task.id)
      ancestor = ancestor.task.parent ? nodes.get(ancestor.task.parent) : undefined
    }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
/** Only complete pj memberships and the paginated native client inventory can
 * establish Inbox membership. Native session archive flags play no role. */
export function inboxSessions(projects: Project[] | undefined, sessions: readonly SessionInfo[] | undefined, vaultRoot: string, currentSessionID: string, query = ""): SessionInfo[] {
  if (!projects) throw new Error("Complete project memberships are unavailable; Inbox cannot be determined")
  if (!sessions || sessions.some(s => !s?.id || !s.projectID || !s.location?.directory || !isAbsolute(s.location.directory))) throw new Error("Native session data is unavailable; Inbox cannot be determined")
  if (!isAbsolute(vaultRoot)) throw new Error("Project vault scope is unavailable")
  const inside = (directory: string) => {
    const path = relative(resolve(vaultRoot), resolve(directory))
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path)
  }
  const current = sessions.find(s => s.id === currentSessionID)
  if (!current || !inside(current.location.directory)) throw new Error("Current native session data is unavailable in this vault")
  const members = new Set(projects.flatMap(p => p.sessions.map(s => s.id)))
  const search = query.trim().toLocaleLowerCase()
  return sessions.filter(s => s.projectID === current.projectID && inside(s.location.directory) && !(s.parentID && !s.fork) && !members.has(s.id) && `${s.title ?? ""} ${s.id}`.toLocaleLowerCase().includes(search))
    .sort(compareSessions)
}
