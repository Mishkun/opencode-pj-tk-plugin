import { expect, test } from "bun:test"
import { activityGroup, activityGroups, inboxSessions, projectTree, relativeAge, sessionActivity } from "../src/projection"
import { project, session } from "./fixtures"

test("activity uses valid created/updated/busy/idle timestamps, excluding viewed/archived", () => {
  expect(sessionActivity(session("ses_A", { time: { created: 10, updated: 20, busy: 40, idle: 30, viewed: 100, archived: 200 } }))).toBe(40)
  expect(sessionActivity(session("ses_A", { time: { created: 0, updated: NaN, busy: Infinity, idle: -1 } }))).toBe(0)
  expect(sessionActivity(session("ses_A", { time: { created: NaN, updated: -1, busy: 9e15 } }))).toBeUndefined()
  expect(sessionActivity()).toBeUndefined()
})

test("local midnight, yesterday and the previous six local dates define four groups", () => {
  const now = new Date(2026, 10, 7, 12).getTime(), today = new Date(2026, 10, 7).getTime(), week = new Date(2026, 10, 1).getTime()
  expect(activityGroup(today, now)).toBe("Today")
  expect(activityGroup(today - 1, now)).toBe("Yesterday")
  expect(activityGroup(new Date(2026, 10, 6).getTime(), now)).toBe("Yesterday")
  expect(activityGroup(new Date(2026, 10, 6).getTime() - 1, now)).toBe("Last 7 days")
  expect(activityGroup(week, now)).toBe("Last 7 days")
  expect(activityGroup(week - 1, now)).toBe("Earlier")
  expect(activityGroup(undefined, now)).toBe("Earlier")
  expect(activityGroup(now + 86_400_000, now)).toBe("Today")
})

test("calendar boundaries cross spring/fall DST with setDate rather than elapsed days", () => {
  // Fix the local timezone in a child process, leaving the other tests untouched.
  const result = Bun.spawnSync([process.execPath, "-e", `
    import { activityGroup } from ${JSON.stringify(new URL("../src/projection.ts", import.meta.url).pathname)};
    for (const [month, day] of [[2, 9], [2, 12], [10, 2], [10, 5]]) {
      const now = new Date(2026, month, day, 12).getTime();
      const boundary = new Date(2026, month, day - 6).getTime();
      if (activityGroup(boundary, now) !== "Last 7 days" || activityGroup(boundary - 1, now) !== "Earlier") process.exit(1);
      const yesterday = new Date(2026, month, day - 1).getTime();
      if (activityGroup(yesterday, now) !== "Yesterday" || activityGroup(yesterday - 1, now) !== "Last 7 days") process.exit(2);
    }
  `], { env: { ...process.env, TZ: "America/New_York" } })
  expect(result.exitCode).toBe(0)
})

test("relative ages are compact, handle unknown timestamps and clamp future activity", () => {
  const now = 1_800_000_000_000
  expect(relativeAge(undefined, now)).toBe("—")
  expect(relativeAge(now + 100_000, now)).toBe("now")
  expect(relativeAge(now - 59_999, now)).toBe("now")
  expect(relativeAge(now - 5 * 60_000, now)).toBe("5m")
  expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h")
  expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d")
  expect(relativeAge(now - 360 * 86_400_000, now)).toBe("12mo")
})

test("descendant maximum sorts projects/siblings and memberships, ties use path/SID", () => {
  const native = [session("ses_A", { time: { created: 10, updated: 10 } }), session("ses_B", { time: { created: 20, updated: 20 } }), session("ses_C", { time: { created: 100, updated: 100 } })]
  const memberships = [{ id: "ses_Unknown", title: "unknown" }, { id: "ses_B", title: "B" }, { id: "ses_A", title: "A" }]
  const projects = [
    project("projects/Q", { sessions: [{ id: "ses_B", title: "B" }] }),
    project("projects/P", { sessions: memberships }),
    project("projects/P/Old", { parent: "projects/P", sessions: [{ id: "ses_A", title: "A" }] }),
    project("projects/P/New", { parent: "projects/P", sessions: [{ id: "ses_C", title: "C" }] }),
    project("projects/Empty", { sessions: [] }), project("projects/Unknown", { sessions: [memberships[0]] }),
    project(".archived/Hidden", { sessions: [{ id: "ses_C", title: "C" }] }),
  ]
  const tree = projectTree(projects, "ses_C", native)
  expect(tree.map(node => [node.project.path, node.activity])).toEqual([["projects/P", 100], ["projects/Q", 20], ["projects/Empty", undefined], ["projects/Unknown", undefined]])
  expect(tree[0].children.map(node => node.project.path)).toEqual(["projects/P/New", "projects/P/Old"])
  expect(tree[0].project.sessions.map(s => s.id)).toEqual(["ses_B", "ses_A", "ses_Unknown"])
  expect(tree[0].related).toBe(true)
  expect(tree[0].children[0].related).toBe(true)
  expect(memberships.map(s => s.id)).toEqual(["ses_Unknown", "ses_B", "ses_A"])
  expect(projectTree([project("projects/Q"), project("projects/P")], "ses_A", native).map(node => node.project.path)).toEqual(["projects/P", "projects/Q"])
})

test("groups mix eligible Inbox after projects, sort each type DESC, and omit empty groups", () => {
  const now = new Date(2026, 10, 7, 12).getTime(), old = new Date(2026, 9, 1).getTime()
  const native = [
    session("ses_A", { time: { created: now, updated: now } }),
    session("ses_B", { title: "Older orphan", time: { created: now - 1000, updated: now - 1000 } }),
    session("ses_C", { title: "Newest orphan", time: { created: now + 1000, updated: now + 1000 } }),
    session("ses_D", { time: { created: old, updated: old } }),
    session("ses_E", { time: { created: NaN, updated: NaN } }),
    session("ses_F", { time: { created: old, updated: old } }),
    session("ses_ArchivedMember", { time: { created: now, updated: now } }),
    session("ses_Child", { parentID: "ses_A", time: { created: now, updated: now } }),
  ]
  const projects = [project(), project("projects/Unknown", { sessions: [] }), project(".archived/P", { sessions: [{ id: "ses_ArchivedMember", title: "Archived" }] })]
  const groups = activityGroups(projectTree(projects, "ses_A", native), inboxSessions(projects, native, "/vault", "ses_A"), now)
  expect(groups.map(group => [group.label, group.entries.map(entry => entry.kind === "project" ? entry.node.project.path : entry.session.id)])).toEqual([
    ["Today", ["projects/P", "ses_C", "ses_B"]],
    ["Earlier", ["projects/Unknown", "ses_D", "ses_F", "ses_E"]],
  ])
})
