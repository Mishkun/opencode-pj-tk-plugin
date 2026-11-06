import { expect, test } from "bun:test"
import { HostPjBridge, type RunInput } from "../src/bridge"

test("HOST bridge has no session/agent authority argument and preserves separate argv", async () => {
  const calls: RunInput[] = []
  const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return { code: 0, stdout: JSON.stringify({ version: 1, ok: true, project: "projects/P", data: {}, write: { state: "unchanged", paths: [], commit: null } }), stderr: "" } }, "/explicit/pj")
  const note = "Host note; $(false)\n- [ ] plain text"
  await bridge.call({ kind: "log", text: note, sessionID: "ses_DataTarget" }, "projects/P")
  expect(bridge.authority).toBe("host")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ executable: "/explicit/pj", cwd: "/vault/projects/P", args: ["log", note, "--session", "ses_DataTarget", "--json"] })
})

test("HOST bridge retains bounded path, operation and SID validation", async () => {
  let spawns = 0
  const bridge = new HostPjBridge("/vault", async () => { spawns++; throw new Error("must not spawn") })
  for (const path of ["../P", "/vault/projects/P", "10_Projects/P", "projects/../../P"]) {
    expect(() => bridge.call({ kind: "show" }, path)).toThrow()
  }
  expect(() => bridge.call({ kind: "list", sessionID: "" })).toThrow()
  expect(() => bridge.call({ kind: "link", sessionID: "ses_B;bad" }, "projects/P")).toThrow()
  expect(() => bridge.call({ kind: "task-close", taskID: "--all" }, "projects/P")).toThrow()
  expect(spawns).toBe(0)
})

test("HOST cancellation stops before spawn and CLI errors retain partial evidence", async () => {
  let spawns = 0
  const partial = { version: 1 as const, ok: false, project: "projects/P", data: {}, write: { state: "saved_uncommitted" as const, paths: ["projects/P/README.md"], commit: null }, error: { code: "commit_failed" } }
  const bridge = new HostPjBridge("/vault", async () => { spawns++; return { code: 1, stdout: JSON.stringify(partial), stderr: "commit_failed" } })
  const controller = new AbortController(); controller.abort()
  await expect(bridge.call({ kind: "list" }, undefined, { signal: controller.signal })).rejects.toThrow()
  expect(spawns).toBe(0)
  expect(await bridge.call({ kind: "status", status: "done" }, "projects/P")).toEqual(partial)
  expect(spawns).toBe(1)
})
