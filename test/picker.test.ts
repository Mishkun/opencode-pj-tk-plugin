import { expect, test } from "bun:test"
import { fitLabel, fuzzyItems, pickerItems, projectSymbol } from "../src/picker"
import { project, session, task } from "./fixtures"
import { projectTaskBuckets, taskTree } from "../src/projection"

test("fuzzy ranking is exact, prefix, substring, subsequence; aliases and Cyrillic are searchable", () => {
  const items = ["alphabet", "zAlphaZ", "a long pleasant hotel address", "ALPHA", "Быстрая проверка"].map((title, index) => ({ title, value: String(index), aliases: index === 4 ? ["ses_Проверка"] : [] }))
  expect(fuzzyItems("alpha", items).map(item => item.value)).toEqual(["3", "0", "1", "2"])
  expect(fuzzyItems("ПРОВЕРКА", items).map(item => item.value)).toEqual(["4"])
  expect(fuzzyItems("бпр", items).map(item => item.value)).toEqual(["4"])
  expect(fuzzyItems("no match", items)).toEqual([])
  expect(fuzzyItems("", items)).toEqual(items)
})

test("picker includes active tasks, native roots/forks including archived memberships, and explicit children once", () => {
  const projects = [project(), project("projects/Q"), project(".archived/Old", { sessions: [{ id: "ses_Archived", title: "Old" }] }), project("projects/Child", { sessions: [{ id: "ses_Child", title: "Explicit child" }] })]
  const native = [session(), session("ses_Archived"), session("ses_Child", { parentID: "ses_A" }), session("ses_Hidden", { parentID: "ses_A" }), session("ses_Fork", { parentID: "ses_A", fork: { sessionID: "ses_A", boundary: { type: "through", messageID: "msg_test" } } }), session("ses_Foreign", { location: { directory: "/other" } })]
  const items = pickerItems(projects, native, "/vault", "ses_A")
  expect(items.filter(item => item.kind === "project")).toHaveLength(3)
  expect(items.filter(item => item.kind === "task")).toHaveLength(3)
  expect(items.filter(item => item.kind === "session").map(item => item.sessionID).sort()).toEqual(["ses_A", "ses_Archived", "ses_Child", "ses_Fork"])
  expect(fuzzyItems("p-1234", items).filter(item => item.kind === "task")).toHaveLength(3)
  expect(fuzzyItems("projects/Q", items).length).toBeGreaterThan(0)
  expect(fuzzyItems("ses_Archived", items)[0].value).toBe("session:ses_Archived")
})

test("compact typography preserves Unicode graphemes and all project status symbols", () => {
  expect(fitLabel("abcdef", 4)).toBe("abc…")
  expect(fitLabel("JSX syntax", 5)).toBe("JSX…")
  expect(fitLabel("Привет мир", 7)).toBe("Привет…")
  expect(fitLabel("界界界", 4)).toBe("界…")
  expect(fitLabel("x", 0)).toBe("")
  expect(["backlog", "in-progress", "waiting", "blocked", "done", "unknown"].map(projectSymbol)).toEqual(["○", "◐", "◷", "!", "✓", "?"])
})

test("cross-claim task hierarchy promotes missing bucket parents and loses no nodes", () => {
  const A = task({ id: "A", title: "Unassigned", claimed_by_sessions: [] })
  const B = task({ id: "B", parent: "A", claimed_by_sessions: ["ses_A", "ses_B"] })
  const C = task({ id: "C", parent: "B", claimed_by_sessions: ["ses_Hidden"] })
  const p = project("projects/P", { sessions: [{ id: "ses_A", title: "A" }, { id: "ses_B", title: "B" }], tasks: [A, B, C] })
  const buckets = projectTaskBuckets(p)
  expect(buckets.tasks.map(task => task.id)).toEqual(["A", "C"])
  expect(taskTree(buckets.tasks).map(node => node.task.id)).toEqual(["A", "C"])
  expect([...buckets.sessions.values()].map(tasks => taskTree(tasks).map(node => node.task.id))).toEqual([["B"], ["B"]])
  expect(B.claimed_by_sessions).toEqual(["ses_A", "ses_B"])
})
