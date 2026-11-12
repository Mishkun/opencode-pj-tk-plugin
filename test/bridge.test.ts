import { describe, expect, test } from "bun:test"
import { HostPjBridge, argsFor, parseOperation, runProcess, BridgeError, type RunInput, type Runner } from "../src/bridge"
import { envelope, projectsFrom } from "../src/contract"
import { listResult, project } from "./fixtures"

const committed = { version: 1 as const, ok: true, project: "projects/P", data: {}, write: { state: "committed", paths: ["projects/P/README.md"], commit: "a".repeat(40) } }
function runner(value: unknown, code = 0): Runner { return async () => ({ code, stdout: JSON.stringify(value), stderr: "diagnostic" }) }

describe("structured CLI bridge", () => {
  test.each([false, null, "", 0, 1, [], {}])("list rejects supplied invalid SID %p instead of widening discovery", async sessionID => {
    let spawned = 0
    const bridge = new HostPjBridge("/vault", async input => { spawned++; return runner(listResult())(input) })
    expect(() => parseOperation({ kind: "list", sessionID })).toThrow()
    expect(() => bridge.call({ kind: "list", sessionID } as unknown as Parameters<typeof bridge.call>[0])).toThrow()
    expect(spawned).toBe(0)
  })
  test("list omits the session filter only for undefined", () => {
    expect(argsFor({ kind: "list" })).toEqual(["list", "-a", "--archived", "--json"])
    expect(argsFor({ kind: "list", sessionID: undefined })).toEqual(["list", "-a", "--archived", "--json"])
    expect(argsFor({ kind: "list", sessionID: "ses_A" })).toEqual(["list", "-a", "--archived", "--session", "ses_A", "--json"])
  })
  test("executes separate argv and explicit project cwd; no shell interpretation", async () => {
    const calls: RunInput[] = []
    const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return runner(committed)(input) }, "/custom/pj")
    const content = "Note; $(touch /bad)\n- [ ] Plain checklist"
    await bridge.call({ kind: "log", text: content, sessionID: "ses_A" }, "projects/P")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ executable: "/custom/pj", cwd: "/vault/projects/P", args: ["log", content, "--session", "ses_A", "--json"] })
  })
  test("list and multi-project fork run from root", async () => {
    const calls: RunInput[] = []
    const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return runner(input.args[0] === "list" ? listResult() : committed)(input) })
    expect(projectsFrom(await bridge.call({ kind: "list", sessionID: "ses_A" }))).toEqual([project()])
    await bridge.call({ kind: "fork", source: "ses_A", target: "ses_B" })
    expect(calls.map(c => c.cwd)).toEqual(["/vault", "/vault"])
    expect(calls[1].args).toEqual(["session", "fork", "ses_A", "ses_B", "--json"])
  })
  test("rejects paths, SIDs, task option injection and unknown operation fields before spawn", async () => {
    let count = 0
    const bridge = new HostPjBridge("/vault", async input => { count++; return runner(committed)(input) })
    for (const path of ["../P", "/vault/projects/P", "10_Projects/P", "projects/../../P", "projects/P/", "projects/P\\other"]) {
      expect(() => bridge.call({ kind: "show" }, path)).toThrow()
    }
    expect(() => argsFor({ kind: "link", sessionID: "ses_A;bad" })).toThrow()
    expect(() => argsFor({ kind: "task-close", taskID: "--all" })).toThrow()
    expect(() => argsFor({ kind: "task-note", taskID: "../P", text: "x" })).toThrow()
    expect(() => argsFor({ kind: "log", text: "--force" })).toThrow()
    expect(() => parseOperation({ kind: "list", command: "rm" })).toThrow()
    expect(() => parseOperation({ kind: "toString" })).toThrow()
    expect(count).toBe(0)
  })
  test("cancellation prevents the CLI", async () => {
    const controller = new AbortController()
    let calls = 0
    const bridge = new HostPjBridge("/vault", async input => { calls++; return runner(listResult())(input) })
    controller.abort()
    await expect(bridge.call({ kind: "list" }, undefined, { signal: controller.signal })).rejects.toThrow()
    expect(calls).toBe(0)
  })
  test.each(["saved_uncommitted", "unknown", "not_written"])("preserves nonzero %s output exactly without retry", async state => {
    const response = { ...committed, ok: false, write: { state, paths: ["projects/P/README.md"], commit: null, checks: ["saved"] }, error: { code: state === "saved_uncommitted" ? "commit_failed" : state, message: "Inspect state" } }
    let calls = 0
    const bridge = new HostPjBridge("/vault", async input => { calls++; return runner(response, 1)(input) })
    expect(await bridge.call({ kind: "link", sessionID: "ses_A" }, "projects/P")).toEqual(response)
    expect(calls).toBe(1)
  })
  test("invalid or interrupted mutation responses are unknown, never assumed unwritten", async () => {
    const bridge = new HostPjBridge("/vault", async () => ({ code: 0, stdout: "not-json", stderr: "diagnostic" }))
    try { await bridge.call({ kind: "status", status: "done" }, "projects/P"); throw new Error("expected failure") } catch (e) {
      expect(e).toBeInstanceOf(BridgeError); expect((e as BridgeError).outcome).toBe("unknown")
    }
    const interrupted = new HostPjBridge("/vault", async () => ({ code: null, stdout: "", stderr: "", interrupted: true }))
    await expect(interrupted.call({ kind: "status", status: "done" }, "projects/P")).rejects.toMatchObject({ outcome: "unknown" })
  })
  test("claim conflict exposes owners without a force retry or force field", async () => {
    const response = { ...committed, ok: false, write: { state: "not_written" as const, paths: [], commit: null }, error: { code: "claim_conflict", message: "Task is already claimed", owners: ["ses_A", "ses_B"], requested: "ses_C" } }
    const calls: RunInput[] = []
    const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return runner(response, 1)(input) })
    expect(await bridge.call({ kind: "task-claim", taskID: "p-1234", sessionID: "ses_C" }, "projects/P")).toEqual(response)
    expect(calls.map(c => c.args)).toEqual([["tk", "claim", "p-1234", "ses_C", "--json"]])
    expect(() => parseOperation({ kind: "task-claim", taskID: "p-1234", sessionID: "ses_C", force: true })).toThrow()
  })
  test("missing executable is explicitly not written", async () => {
    const bridge = new HostPjBridge("/vault", async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) })
    await expect(bridge.call({ kind: "log", text: "hello" }, "projects/P")).rejects.toMatchObject({ outcome: "not_written" })
  })
  test("a reported commit requires full verified evidence", () => {
    expect(() => envelope({ ...committed, write: { ...committed.write, commit: null } }, true)).toThrow()
    expect(() => envelope({ ...committed, write: { ...committed.write, state: "saved_uncommitted", commit: null } }, true)).toThrow()
    expect(() => envelope({ version: 1, ok: true, project: null, data: {} }, true)).toThrow()
    expect(envelope({ ...committed, write: { state: "unchanged", paths: [], commit: null } }, true).ok).toBe(true)
  })
  test("reads accept additive fields and expose actual multiassignment", () => {
    const p = project(); p.tasks[0].claimed_by_sessions = ["ses_A", "ses_B"]
    const result = projectsFrom(envelope({ ...listResult([p]), future: true }, false))
    expect(result[0].tasks[0].claimed_by_sessions).toEqual(["ses_A", "ses_B"])
    expect(() => projectsFrom(listResult([p, p]))).toThrow("Duplicate")
  })
  test("actual subprocess preserves Unicode and does not interpret shell text", async () => {
    const result = await runProcess({ executable: process.execPath, args: ["--eval", 'process.stdout.write(process.argv[1])', "Živeli; $(false)"], cwd: process.cwd(), timeoutMs: 2_000 })
    expect(result.code).toBe(0); expect(result.stdout).toBe("Živeli; $(false)")
  })
  test("actual subprocess timeout is bounded", async () => {
    const started = performance.now()
    const result = await runProcess({ executable: process.execPath, args: ["--eval", "setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 50 })
    expect(result.interrupted).toBe(true)
    expect(performance.now() - started).toBeLessThan(3_000)
  })
})
