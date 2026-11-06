import type { Project, Task } from "./contract"
import type { SessionInfo } from "@opencode/client"
import { isAbsolute, relative, resolve } from "node:path"

export type ProjectNode = { project: Project; children: ProjectNode[]; related: boolean }
export function projectTree(projects: Project[], sessionID: string): ProjectNode[] {
  const nodes = new Map(projects.filter(project => project.path.startsWith("projects/")).map(project => [project.path, { project, children: [] as ProjectNode[], related: project.sessions.some(s => s.id === sessionID) }]))
  const roots: ProjectNode[] = []
  for (const node of nodes.values()) {
    const parent = node.project.parent && nodes.get(node.project.parent)
    // Require real enclosing folder ancestry. Malformed cycles cannot swallow nodes.
    if (parent && node.project.path.startsWith(`${parent.project.path}/`)) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (items: ProjectNode[]) => {
    items.sort((a, b) => a.project.path.localeCompare(b.project.path))
    for (const node of items) sort(node.children)
  }
  sort(roots)
  return roots
}
export type TaskNode = { task: Task; children: TaskNode[] }
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
    .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id) || a.id.localeCompare(b.id))
}
