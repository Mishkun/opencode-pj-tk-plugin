import type { Project, Task, Envelope } from "../src/contract"
import type { SessionInfo, SessionForked } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"

export function task(overrides: Partial<Task> = {}): Task {
  return { id: "p-1234", title: "Work", status: "open", parent: null, deps: [], links: [], claimed_by_sessions: ["ses_A"], ready: true, body: "# Work\n\n- [ ] Check result\n", path: "projects/P/.tickets/p-1234.md", ...overrides }
}
export function project(path = "projects/P", overrides: Partial<Project> = {}): Project {
  return { path, name: path.split("/").at(-1)!, parent: null, status: "in-progress", sessions: [{ id: "ses_A", title: "Session A" }], tasks: [task()], notePath: `${path}/README.md`, ...overrides }
}
export function listResult(projects = [project()]): Envelope { return { version: 1, ok: true, project: null, data: { projects } } }
export function session(id = "ses_A", overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id, projectID: "prj_test", title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, location: { directory: "/vault/projects/P" }, ...overrides } as SessionInfo
}
export function forkEvent(): SessionForked {
  return { id: "evt_fork", created: 1, type: "session.forked", durable: { aggregateID: "ses_B", seq: 1, version: 2 }, location: { directory: "/vault/projects/P" }, data: { sessionID: "ses_B", parentID: "ses_A", boundary: { type: "through", messageID: "msg_test" } } } as SessionForked
}
export function testHost(overrides: Record<string, unknown> = {}): Plugin.Context {
  return {
    location: { directory: "/vault/projects/P", project: { id: "prj_test", directory: "/vault", canonical: "/vault" } },
    command: { transform: async () => {} }, tool: { transform: async () => {} }, storage:{get:async()=>undefined},
    session: { get: async ({ sessionID }: { sessionID: string }) => session(sessionID) },
    permission: { assert: async () => {} }, ...overrides,
  } as unknown as Plugin.Context
}
