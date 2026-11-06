import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo, SessionListInput, SessionsResponse } from "@opencode/client"
import { loadNativeSessions, onNativeInventoryChanged } from "../src/native-inventory"
import { inboxSessions } from "../src/projection"
import { project, session } from "./fixtures"

test("cold cache only A still discovers unlinked C from complete official pages and excludes archived-only B", async () => {
  const A = session(), B = session("ses_B", { title: "Archived project conversation" }), C = session("ses_C", { title: "Cold inventory C" })
  const pages = [
    { data: [A, B], cursor: { next: "page-2" } },
    { data: [C], cursor: { next: "page-3" } },
    { data: [], cursor: { next: null } },
  ]
  let reads = 0, cacheReads = 0
  const context = {
    data: { session: { list: () => { cacheReads++; return [A] }, get: () => A } },
    client: { session: { get: async () => A, list: async () => pages[reads++] } },
  } as unknown as Pick<Context, "client" | "data">
  const native = await loadNativeSessions(context, "ses_A", new AbortController().signal)
  const projects = [project(), project(".archived/P", { sessions: [{ id: "ses_B", title: "B" }] })]
  expect(inboxSessions(projects, native, "/vault", "ses_A").map(s => ({ id: s.id, title: s.title }))).toEqual([{ id: "ses_C", title: "Cold inventory C" }])
  expect(reads).toBe(3)
  expect(cacheReads).toBe(0)
})

function inventory(options: {
  cached?: SessionInfo | null
  get?: (signal: AbortSignal) => Promise<SessionInfo>
  list: (input: SessionListInput, signal: AbortSignal) => Promise<SessionsResponse>
}) {
  const calls: { input: SessionListInput; signal: AbortSignal }[] = []
  const gets: { sessionID: string; signal: AbortSignal }[] = []
  const context = {
    data: { session: { list: () => { throw new Error("cache must not be enumerated") }, get: () => options.cached === null ? undefined : options.cached ?? session() } },
    client: { session: {
      get: async ({ sessionID }: { sessionID: string }, { signal }: { signal: AbortSignal }) => { gets.push({ sessionID, signal }); return options.get ? options.get(signal) : session() },
      list: async (input: SessionListInput, { signal }: { signal: AbortSignal }) => { calls.push({ input, signal }); return options.list(input, signal) },
    } },
  } as unknown as Pick<Context, "client" | "data">
  return { context, calls, gets }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("all pages keep project scope and signal, deduplicate SIDs and read the empty terminal page", async () => {
  const A = session(), C = session("ses_C", { title: "Inventory title", location: { directory: "/vault/projects/Q/docs" }, time: { created: 1, updated: 2, archived: 3 } })
  const pages: SessionsResponse[] = [
    { data: [A, C], cursor: { next: "two" } },
    { data: [session("ses_C", { title: "Concurrent duplicate" })], cursor: { next: "end" } },
    { data: [], cursor: { next: "end" } },
  ]
  const { context, calls, gets } = inventory({ list: async () => pages[calls.length - 1]! })
  const { signal } = new AbortController()
  const result = await loadNativeSessions(context, "ses_A", signal)
  expect(result).toEqual([A, C])
  expect(gets).toEqual([])
  expect(calls).toEqual([undefined, "two", "end"].map(cursor => ({ input: { project: A.projectID, limit: 200, order: "desc", cursor }, signal })))
  expect(inboxSessions([project()], result, "/vault", "ses_A")).toEqual([C])
})

test.each([undefined, null])("an absent or null next cursor terminates a populated official page (%s)", async next => {
  const { context, calls } = inventory({ list: async () => ({ data: [session()], cursor: { next } }) })
  expect(await loadNativeSessions(context, "ses_A", new AbortController().signal)).toEqual([session()])
  expect(calls).toHaveLength(1)
})

test("an initially empty inventory stops after one request", async () => {
  const { context, calls } = inventory({ list: async () => ({ data: [], cursor: {} }) })
  expect(await loadNativeSessions(context, "ses_A", new AbortController().signal)).toEqual([])
  expect(calls).toHaveLength(1)
})

test("a cold current session uses authenticated get before project-wide listing", async () => {
  const A = session("ses_A", { projectID: "prj_cold" })
  const { context, calls, gets } = inventory({ cached: null, get: async () => A, list: async () => ({ data: [A], cursor: {} }) })
  const { signal } = new AbortController()
  expect(await loadNativeSessions(context, "ses_A", signal)).toEqual([A])
  expect(gets).toEqual([{ sessionID: "ses_A", signal }])
  expect(calls).toEqual([{ input: { project: "prj_cold", limit: 200, order: "desc", cursor: undefined }, signal }])
})

test("missing cached project ID also uses authenticated current metadata", async () => {
  const { context, gets } = inventory({ cached: session("ses_A", { projectID: "" }), list: async () => ({ data: [session()], cursor: {} }) })
  await loadNativeSessions(context, "ses_A", new AbortController().signal)
  expect(gets).toHaveLength(1)
})

test("wrong current identity, missing project and failed get stop before listing", async () => {
  for (const get of [async () => session("ses_Other"), async () => session("ses_A", { projectID: "" }), async () => { throw new Error("current read denied") }]) {
    const { context, calls } = inventory({ cached: null, get, list: async () => { throw new Error("unexpected list") } })
    await expect(loadNativeSessions(context, "ses_A", new AbortController().signal)).rejects.toThrow()
    expect(calls).toEqual([])
  }
})

test("a repeated cursor rejects the entire inventory with no retry", async () => {
  const { context, calls } = inventory({ list: async () => ({ data: [session()], cursor: { next: "same" } }) })
  await expect(loadNativeSessions(context, "ses_A", new AbortController().signal)).rejects.toThrow("cursor repeated")
  expect(calls).toHaveLength(2)
})

test("a multi-page cursor cycle also rejects completeness", async () => {
  const next = ["two", "three", "two"]
  const { context, calls } = inventory({ list: async () => ({ data: [session()], cursor: { next: next[calls.length - 1] } }) })
  await expect(loadNativeSessions(context, "ses_A", new AbortController().signal)).rejects.toThrow("cursor repeated")
  expect(calls).toHaveLength(3)
})

test("a failed later page exposes no partial inventory and performs no retry", async () => {
  const { context, calls } = inventory({ list: async () => {
    if (calls.length === 1) return { data: [session()], cursor: { next: "two" } }
    throw new Error("inventory read denied")
  } })
  await expect(loadNativeSessions(context, "ses_A", new AbortController().signal)).rejects.toThrow("inventory read denied")
  expect(calls).toHaveLength(2)
})

test("malformed later pages and incomplete records reject the entire inventory", async () => {
  for (const page of [
    { data: undefined, cursor: {} }, { data: [], cursor: undefined },
    { data: [session()], cursor: { next: "" } }, { data: [session()], cursor: { next: 2 } },
    { data: [{ id: "ses_B" }], cursor: {} },
    { data: [session("ses_B", { location: { directory: "relative" } })], cursor: {} },
  ]) {
    const { context, calls } = inventory({ list: async () => calls.length === 1 ? { data: [session()], cursor: { next: "two" } } : page as SessionsResponse })
    await expect(loadNativeSessions(context, "ses_A", new AbortController().signal)).rejects.toThrow("Native session inventory")
    expect(calls).toHaveLength(2)
  }
})

test("a pre-aborted request reads neither current metadata nor pages", async () => {
  const { context, calls, gets } = inventory({ cached: null, list: async () => { throw new Error("unexpected list") } })
  const controller = new AbortController(); controller.abort()
  await expect(loadNativeSessions(context, "ses_A", controller.signal)).rejects.toThrow()
  expect(calls).toEqual([]); expect(gets).toEqual([])
})

test("cancellation while current get is pending rejects a late success before listing", async () => {
  const pending = deferred<SessionInfo>()
  const { context, calls, gets } = inventory({ cached: null, get: () => pending.promise, list: async () => { throw new Error("unexpected list") } })
  const controller = new AbortController()
  const result = loadNativeSessions(context, "ses_A", controller.signal)
  expect(gets).toHaveLength(1)
  controller.abort(); pending.resolve(session())
  await expect(result).rejects.toThrow()
  expect(calls).toEqual([])
})

test("cancellation on a later page rejects a late terminal response instead of publishing partial data", async () => {
  const pending = deferred<SessionsResponse>(), reached = deferred<void>()
  const { context, calls } = inventory({ list: async () => {
    if (calls.length === 1) return { data: [session()], cursor: { next: "two" } }
    reached.resolve(); return pending.promise
  } })
  const controller = new AbortController()
  const result = loadNativeSessions(context, "ses_A", controller.signal)
  await reached.promise
  controller.abort(); pending.resolve({ data: [session("ses_C")], cursor: {} })
  await expect(result).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

test("a newer inventory can finish while the cancelled older request returns late", async () => {
  const oldPage = deferred<SessionsResponse>()
  const { context, calls } = inventory({ list: async () => calls.length === 1 ? oldPage.promise : { data: [session(), session("ses_C")], cursor: {} } })
  const old = new AbortController()
  const older = loadNativeSessions(context, "ses_A", old.signal)
  old.abort()
  expect(await loadNativeSessions(context, "ses_A", new AbortController().signal)).toEqual([session(), session("ses_C")])
  oldPage.resolve({ data: [session(), session("ses_Stale")], cursor: {} })
  await expect(older).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

test("native inventory change subscriptions refresh for all required events and unsubscribe together", () => {
  const listeners = new Map<string, () => void>()
  const stopped: string[] = []
  const context = { data: { on: (type: string, run: () => void) => {
    listeners.set(type, run)
    return () => { stopped.push(type); listeners.delete(type) }
  } } } as unknown as Pick<Context, "data">
  let refreshes = 0
  const stop = onNativeInventoryChanged(context, () => { refreshes++ })
  const events = ["server.connected", "session.created", "session.forked", "session.deleted", "session.archived", "session.unarchived", "session.renamed", "session.moved"]
  expect([...listeners.keys()]).toEqual(events)
  for (const event of events) listeners.get(event)!()
  expect(refreshes).toBe(8)
  stop()
  expect(stopped).toEqual(events)
  expect(listeners.size).toBe(0)
})

test("session.forked alone discovers a new unlinked fork through official inventory with a cold cache", async () => {
  const C = session("ses_C", { title: "Unlinked source" })
  const fork = session("ses_Fork", { title: "New fork", parentID: "ses_C", fork: { sessionID: "ses_C", boundary: { type: "through", messageID: "msg_boundary" } } })
  let native = [session(), C]
  const api = inventory({ list: async () => ({ data: native, cursor: {} }) })
  const listeners = new Map<string, () => void>()
  const context = { ...api.context, data: { ...api.context.data, on: (type: string, run: () => void) => {
    listeners.set(type, run)
    return () => { listeners.delete(type) }
  } } } as unknown as Pick<Context, "client" | "data">
  const read = async () => inboxSessions([project()], await loadNativeSessions(context, "ses_A", new AbortController().signal), "/vault", "ses_A").map(s => s.id)
  expect(await read()).toEqual(["ses_C"])
  let refreshed: Promise<string[]> | undefined
  const stop = onNativeInventoryChanged(context, () => { refreshed = read() })
  native = [session(), C, fork]
  listeners.get("session.forked")!()
  expect(await refreshed).toEqual(["ses_Fork", "ses_C"])
  expect(api.calls).toHaveLength(2)
  stop()
})
