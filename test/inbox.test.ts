import { expect, test } from "bun:test"
import { inboxSessions, projectTree } from "../src/projection"
import { project, session } from "./fixtures"

test("moving P into project archive hides P while shared A stays in active Q", () => {
  const before = [project("projects/P"), project("projects/Q")]
  expect(projectTree(before, "ses_A").map(n => n.project.path)).toEqual(["projects/P", "projects/Q"])
  const after = [project(".archived/P", { status: "waiting" }), project("projects/Q")]
  const tree = projectTree(after, "ses_A")
  expect(tree.map(n => n.project.path)).toEqual(["projects/Q"])
  expect(tree[0].project.sessions.map(s => s.id)).toEqual(["ses_A"])
  expect(inboxSessions(after, [session()], "/vault", "ses_A")).toEqual([])
  expect(after[0].status).toBe("waiting")
})

test("A linked only to archived P never becomes Inbox", () => {
  const projects = [project(".archived/P")]
  expect(projectTree(projects, "ses_A")).toEqual([])
  expect(inboxSessions(projects, [session(), session("ses_Unlinked")], "/vault", "ses_A").map(s => s.id)).toEqual(["ses_Unlinked"])
})

test("Inbox includes unlinked roots and forks, excludes native child subagents", () => {
  const sessions = [session(), session("ses_Root"), session("ses_Fork", { parentID: "ses_Parent", fork: { sessionID: "ses_A", boundary: { type: "through", messageID: "msg_boundary" } } }), session("ses_Child", { parentID: "ses_A" })]
  expect(inboxSessions([project()], sessions, "/vault", "ses_A").map(s => s.id)).toEqual(["ses_Fork", "ses_Root"])
})

test("native archived flag is retained as data and never filters Inbox", () => {
  const legacy = session("ses_Legacy", { time: { created: 1, updated: 2, archived: 2 } })
  expect(inboxSessions([project()], [session(), legacy], "/vault", "ses_A")).toEqual([legacy])
  expect(legacy.time.archived).toBe(2)
})

test("Inbox scope excludes foreign locations, sibling-prefix paths and project IDs", () => {
  const sessions = [session(), session("ses_Local", { location: { directory: "/vault/projects/Q/docs" } }), session("ses_Elsewhere", { location: { directory: "/other" } }), session("ses_Prefix", { location: { directory: "/vault-other/projects/P" } }), session("ses_Traversal", { location: { directory: "/vault/../other" } }), session("ses_Foreign", { projectID: "prj_foreign" })]
  expect(inboxSessions([project()], sessions, "/vault", "ses_A").map(s => s.id)).toEqual(["ses_Local"])
})

test("Inbox search matches native session title or exact SID fragments", () => {
  const sessions = [session(), session("ses_B", { title: "Review payment" }), session("ses_C", { title: "Write report" })]
  expect(inboxSessions([project()], sessions, "/vault", "ses_A", "PAYMENT").map(s => s.id)).toEqual(["ses_B"])
  expect(inboxSessions([project()], sessions, "/vault", "ses_A", "ses_c").map(s => s.id)).toEqual(["ses_C"])
})

test("unknown membership/native data is an error, never a claim of no memberships", () => {
  expect(() => inboxSessions(undefined, [session()], "/vault", "ses_A")).toThrow("Complete project memberships")
  expect(() => inboxSessions([], undefined, "/vault", "ses_A")).toThrow("Native session data")
  expect(() => inboxSessions([], [], "/vault", "ses_A")).toThrow("Current native session data")
  expect(() => inboxSessions([], [session("ses_Other")], "/vault", "ses_A")).toThrow("Current native session data")
  expect(() => inboxSessions([], [session("ses_A", { location: { directory: "/foreign" } })], "/vault", "ses_A")).toThrow("Current native session data")
  expect(() => inboxSessions([], [session("ses_A", { location: { directory: "relative" } })], "/vault", "ses_A")).toThrow("Native session data")
})

test("a complete empty project list can establish a genuinely unlinked current root", () => {
  expect(inboxSessions([], [session()], "/vault", "ses_A").map(s => s.id)).toEqual(["ses_A"])
})
