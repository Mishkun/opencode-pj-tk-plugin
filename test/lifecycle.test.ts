import { expect, test } from "bun:test"
import { HostPjBridge, type RunInput } from "../src/bridge"
import { attachFork, focusSession } from "../src/lifecycle"
import { session, forkEvent, testHost } from "./fixtures"

const directory = "/vault/projects/P"
const forkSession = (id: string, overrides: Partial<ReturnType<typeof session>> = {}) => session(id, id === "ses_B" ? { fork: { sessionID: "ses_A", boundary: forkEvent().data.boundary }, ...overrides } : {})

test("native fork without optional event.location verifies source and target before one write", async () => {
  const calls: string[] = []
  const event = forkEvent(); delete event.location
  const bridge = new HostPjBridge("/vault", async () => { calls.push("write"); return { code: 0, stderr: "", stdout: JSON.stringify({ version: 1, ok: true, project: null, data: {}, write: { state: "unchanged", paths: [], commit: null } }) } })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => {
    calls.push(sessionID)
    return session(sessionID, sessionID === event.data.sessionID ? { fork: { sessionID: event.data.parentID, boundary: event.data.boundary } } : {})
  } } })
  expect(await attachFork(bridge, host, event, directory)).toMatchObject({ status: "attached", source: "ses_A", sessionID: "ses_B" })
  expect(calls).toEqual(["ses_A", "ses_B", "write"])
})

test("real fork event metadata copies all relationships in one pj invocation", async () => {
  const calls: RunInput[] = []
  const response = { version: 1, ok: true, project: null, data: { linked: ["projects/P", "projects/Q"] }, write: { state: "committed", paths: ["projects/P/README.md", "projects/Q/README.md"], commit: "a".repeat(40) } }
  const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return { code: 0, stdout: JSON.stringify(response), stderr: "" } })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => forkSession(sessionID, { title: "Fork B" }) } })
  expect(await attachFork(bridge, host, forkEvent(), directory)).toMatchObject({ status: "attached", source: "ses_A", sessionID: "ses_B" })
  expect(calls).toHaveLength(1); expect(calls[0].args).toEqual(["session", "fork", "ses_A", "ses_B", "--title", "Fork B", "--json"])
  expect(bridge.authority).toBe("host")
})
test("generic child parentID is never accepted as fork evidence", async () => {
  let calls = 0
  const bridge = new HostPjBridge("/vault", async () => { calls++; throw new Error("must not spawn") })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => forkSession(sessionID, { fork: undefined, parentID: "ses_A" }) } })
  await expect(attachFork(bridge, host, forkEvent(), directory)).rejects.toThrow("fork metadata")
  expect(calls).toBe(0)
})
test("partial fork attachment remains visible and is not retried", async () => {
  let calls = 0
  const bridge = new HostPjBridge("/vault", async () => { calls++; return { code: 1, stderr: "commit failure", stdout: JSON.stringify({ version: 1, ok: false, project: null, data: {}, error: { code: "commit_failed" }, write: { state: "saved_uncommitted", paths: ["projects/P/README.md"], commit: null } }) } })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => forkSession(sessionID) } })
  const result = await attachFork(bridge, host, forkEvent(), directory)
  expect(result.status).toBe("incomplete"); expect(result.error).toContain("saved_uncommitted"); expect(calls).toBe(1)
})
test("native host fork does not ask agent permissions or borrow source identity", async () => {
  let permissions = 0, writes = 0
  const bridge = new HostPjBridge("/vault", async () => { writes++; return { code: 0, stderr: "", stdout: JSON.stringify({ version: 1, ok: true, project: null, data: {}, write: { state: "unchanged", paths: [], commit: null } }) } })
  const host = testHost({ permission: { assert: async () => { permissions++; throw new Error("agent policy is not host authority") } }, session: { get: async ({ sessionID }: { sessionID: string }) => forkSession(sessionID) } })
  const result = await attachFork(bridge, host, forkEvent(), directory)
  expect(result).toMatchObject({ status: "attached", sessionID: "ses_B", source: "ses_A" })
  expect(permissions).toBe(0); expect(writes).toBe(1)
})
test("fork event location and native boundary must agree before the CLI", async () => {
  let writes = 0, reads = 0
  const bridge = new HostPjBridge("/vault", async () => { writes++; throw new Error("must not spawn") })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => { reads++; return forkSession(sessionID, { fork: { sessionID: "ses_A", boundary: { type: "before", messageID: "msg_wrong" } } }) } } })
  const outside = forkEvent(); outside.location = { directory: "/other" }
  await expect(attachFork(bridge, host, outside, directory)).rejects.toThrow("outside")
  expect(reads).toBe(0)
  await expect(attachFork(bridge, host, forkEvent(), directory)).rejects.toThrow("fork metadata")
  expect(writes).toBe(0)
})
test("a forked session moved outside the host location stops persistence", async () => {
  let writes = 0
  const bridge = new HostPjBridge("/vault", async () => { writes++; throw new Error("must not spawn") })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => forkSession(sessionID, { location: { directory: "/other" } }) } })
  const event = forkEvent(); delete event.location
  await expect(attachFork(bridge, host, event, directory)).rejects.toThrow("fork metadata")
  expect(writes).toBe(0)
})
test.each(["foreign source location", "wrong source SID"])("fork without event.location rejects %s before writing", async mismatch => {
  let writes = 0
  const reads: string[] = []
  const bridge = new HostPjBridge("/vault", async () => { writes++; throw new Error("must not spawn") })
  const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => {
    reads.push(sessionID)
    if (sessionID === "ses_A") return mismatch === "foreign source location" ? session("ses_A", { location: { directory: "/other" } }) : session("ses_Other")
    return forkSession(sessionID)
  } } })
  const event = forkEvent(); delete event.location
  await expect(attachFork(bridge, host, event, directory)).rejects.toThrow("fork metadata")
  expect(reads).toEqual(["ses_A", "ses_B"])
  expect(writes).toBe(0)
})
test("native navigation focuses actual target tab, or routes with that exact SID", () => {
  const focused: string[] = [], routes: unknown[] = []
  let tabs = true
  const host = { tabs: { enabled: () => tabs, focus: (id: string) => { focused.push(id) } }, router: { navigate: (value: unknown) => { routes.push(value) } } }
  focusSession(host, "ses_B")
  expect(focused).toEqual(["ses_B"]); expect(routes).toHaveLength(0)
  tabs = false; focusSession(host, "ses_A")
  expect(routes).toEqual([{ type: "session", sessionID: "ses_A" }])
})
