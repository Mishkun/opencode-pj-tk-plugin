import { expect, test } from "bun:test"
import { SessionState } from "../src/session-state"
import { session } from "./fixtures"

const known = (id: string) => id === "ses_A"
const native = (outcome?: "failed" | "succeeded" | "interrupted") => session("ses_A", { outcome, time: { created: 1, updated: 100, busy: 50, idle: 100, viewed: 0 } })
test("marker priority: pending > working/retry > unread failure > unread success > selected > empty", () => {
  const state = new SessionState(), failed = native("failed")
  expect(state.marker(native(), false)).toBe("empty")
  expect(state.marker(session("ses_A", { outcome: "succeeded", time: { created: 1, updated: 1, busy: NaN, idle: Infinity } }), false)).toBe("empty")
  expect(state.marker(native(), true)).toBe("selected")
  expect(state.marker(native("interrupted"), false)).toBe("empty")
  expect(state.marker(native("succeeded"), false)).toBe("finished")
  expect(state.marker(failed, true)).toBe("attention")
  state.event("session.status", { sessionID: "ses_A", status: { type: "retry" } }, 200, known)
  expect(state.marker(failed, true)).toBe("working")
  state.event("permission.asked", { sessionID: "ses_A", id: "r1" }, 201, known)
  expect(state.marker(failed, true)).toBe("attention")
  state.event("permission.replied", { sessionID: "ses_A", requestID: "r1" }, 202, known)
  expect(state.marker(failed, true)).toBe("working")
  state.event("session.execution.interrupted", { sessionID: "ses_A" }, 203, known)
  expect(state.marker(failed, false)).toBe("empty")
  state.event("session.execution.failed", { sessionID: "ses_A" }, 120, known)
  expect(state.marker(failed, false)).toBe("empty")
})

test("overlapping stale snapshot cannot resurrect a closed permission or clear post-start busy", () => {
  const state = new SessionState(), item = native("succeeded")
  state.reconcile([item], { permissions: [{ id: "r1", sessionID: "ses_A" }], forms: [] }, state.revision)
  const started = state.revision
  state.event("permission.replied", { sessionID: "ses_A", requestID: "r1" }, 200, known)
  state.event("session.execution.started", { sessionID: "ses_A" }, 201, known)
  state.reconcile([item], { permissions: [{ id: "r1", sessionID: "ses_A" }], forms: [] }, started)
  expect(state.marker(item, true)).toBe("working")
  state.reconcile([item], { permissions: [{ id: "r1", sessionID: "ses_A" }], forms: [] }, state.revision)
  expect(state.marker(item, true)).toBe("working")
  const busy = session("ses_A", { time: { created: 1, updated: 201, busy: 201, idle: 100 } })
  state.reconcile([busy], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(busy, false)).toBe("working")
  expect(state.event("permission.asked", { sessionID: "ses_A", id: "r1" }, 199, known)).toBe(false)
  expect(state.marker(busy, false)).toBe("working")
})

test("new idle without an outcome clears working without inventing completed; viewed clears unread outcomes", () => {
  const state = new SessionState(), item = native("failed")
  state.event("session.execution.started", { sessionID: "ses_A" }, 200, known)
  state.event("session.idle", { sessionID: "ses_A" }, 210, known)
  expect(state.marker(item, false)).toBe("empty")
  state.event("session.execution.succeeded", { sessionID: "ses_A" }, 211, known)
  expect(state.marker(item, true)).toBe("finished")
  state.event("session.viewed", { sessionID: "ses_A", idle: 210 }, 212, known)
  expect(state.marker(item, true)).toBe("selected")
  state.event("form.created", { form: { id: "f1", sessionID: "ses_A" } }, 213, known)
  expect(state.marker(item, false)).toBe("attention")
  state.event("form.cancelled", { id: "f1", sessionID: "ses_A" }, 214, known)
  expect(state.marker(item, false)).toBe("empty")
  expect(state.event("permission.asked", { id: "x", sessionID: "ses_Foreign" }, 215, known)).toBe(false)
  state.reconcile([], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(item, false)).toBe("attention") // native failed remains authoritative after pruning
})

test("stale snapshots started after busy/idle events cannot resurrect an old outcome", () => {
  const state = new SessionState(), old = native("failed")
  state.event("session.execution.started", { sessionID: "ses_A" }, 200, known)
  state.event("session.idle", { sessionID: "ses_A" }, 210, known)
  expect(state.marker(old, false)).toBe("empty")
  state.reconcile([old], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(old, false)).toBe("empty")
  const confirmed = session("ses_A", { time: { created: 1, updated: 210, busy: 200, idle: 210 }, outcome: "interrupted" })
  state.reconcile([confirmed], { permissions: [], forms: [] }, state.revision)
  state.reconcile([old], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(old, false)).toBe("empty")
  state.event("session.execution.failed", { sessionID: "ses_A" }, 150, known)
  expect(state.marker(old, false)).toBe("empty")
})

test("confirmed native outcome/viewed timestamps retain their monotonic watermarks", () => {
  const state = new SessionState(), old = native("failed")
  state.event("session.execution.succeeded", { sessionID: "ses_A" }, 210, known)
  const confirmed = session("ses_A", { outcome: "succeeded", time: { created: 1, updated: 220, busy: 200, idle: 220, viewed: 220 } })
  state.reconcile([confirmed], { permissions: [], forms: [] }, state.revision)
  state.reconcile([old], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(old, false)).toBe("empty")
})

test("viewed event watermark survives confirmation when idle precedes the outcome event timestamp", () => {
  const state = new SessionState()
  state.event("session.execution.succeeded", { sessionID: "ses_A" }, 210, known)
  state.event("session.viewed", { sessionID: "ses_A", idle: 209 }, 211, known)
  const confirmed = session("ses_A", { outcome: "succeeded", time: { created: 1, updated: 209, busy: 200, idle: 209, viewed: 209 } })
  state.reconcile([confirmed], { permissions: [], forms: [] }, state.revision)
  expect(state.marker(confirmed, false)).toBe("empty")
})

test.each(["permission", "form"])("closed %s request survives empty then stale populated snapshots until SID deletion", kind => {
  const state = new SessionState(), item = native()
  state.event(kind === "permission" ? "permission.replied" : "form.replied", { sessionID: "ses_A", id: "r1", requestID: "r1" }, 200, known)
  state.reconcile([item], { permissions: [], forms: [] }, state.revision)
  const requests = { permissions: kind === "permission" ? [{ id: "r1", sessionID: "ses_A" }] : [], forms: kind === "form" ? [{ id: "r1", sessionID: "ses_A" }] : [] }
  state.reconcile([item], requests, state.revision)
  expect(state.marker(item, false)).toBe("empty")
  expect(state.event(kind === "permission" ? "permission.asked" : "form.created", { sessionID: "ses_A", id: "r1", form: { sessionID: "ses_A", id: "r1" } }, 250, known)).toBe(false)
  expect(state.marker(item, false)).toBe("empty")
  state.reconcile([], { permissions: [], forms: [] }, state.revision)
  state.reconcile([item], requests, state.revision)
  expect(state.marker(item, false)).toBe("attention")
})

test("family working includes nested native subagents, excludes forks, and clears on stop/deletion", () => {
  const state = new SessionState(), parent = native()
  const child = session("ses_Child", { parentID: "ses_A", time: { created: 1, updated: 200, busy: 200, idle: 100 } })
  const grandchild = session("ses_Grandchild", { parentID: "ses_Child", time: { created: 1, updated: 300, busy: 300, idle: 100 } })
  const fork = session("ses_Fork", { parentID: "ses_A", fork: { sessionID: "ses_A", boundary: { type: "through", messageID: "msg_test" } }, time: { created: 1, updated: 400, busy: 400 } })
  expect(state.familyMarkers([parent, child], "ses_A").get("ses_A")).toBe("working")
  state.event("session.execution.interrupted", { sessionID: "ses_Child" }, 250, id => id === "ses_Child")
  expect(state.familyMarkers([parent, child, grandchild, fork], "ses_A").get("ses_A")).toBe("working")
  state.event("session.execution.succeeded", { sessionID: "ses_Grandchild" }, 350, id => id === "ses_Grandchild")
  expect(state.familyMarkers([parent, child, grandchild, fork], "ses_A").get("ses_A")).toBe("selected")
  expect(state.familyMarkers([parent, fork], "ses_A").get("ses_A")).toBe("selected")
  expect(state.familyMarkers([parent, fork], "ses_A").get("ses_Fork")).toBe("working")
})

test("pending attention outranks family working and malformed parent cycles stay finite", () => {
  const state = new SessionState(), parent = native(), child = session("ses_Child", { parentID: "ses_A", time: { created: 1, updated: 200, busy: 200 } })
  parent.time.busy = 200
  expect(state.familyMarkers([parent, child], "ses_A").get("ses_A")).toBe("working")
  const known = (id: string) => ["ses_A", "ses_Child"].includes(id)
  state.event("permission.asked", { sessionID: "ses_Child", id: "r1" }, 220, known)
  expect(state.familyMarkers([parent, child], "ses_A").get("ses_A")).toBe("attention")
  state.event("permission.replied", { sessionID: "ses_Child", requestID: "r1" }, 221, known)
  state.event("form.created", { form: { sessionID: "ses_A", id: "f1" } }, 222, known)
  expect(state.familyMarkers([parent, child], "ses_A").get("ses_A")).toBe("attention")
  state.event("form.cancelled", { sessionID: "ses_A", id: "f1" }, 223, known)
  parent.parentID = "ses_Child"
  const markers = state.familyMarkers([parent, child], "ses_A")
  expect(markers.size).toBe(2)
  expect(markers.get("ses_A")).toBe("working")
})
