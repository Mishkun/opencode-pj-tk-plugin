import { expect, test } from "bun:test"
import { HostPjBridge, argsFor, parseOperation, type RunInput } from "../src/bridge"
import { projectArchiveDestination } from "../src/contract"
import { hostWorkspaceService } from "../src/server"
import { listResult } from "./fixtures"

test("project archive derives the branch destination from its active folder only", () => {
  expect(projectArchiveDestination("projects/P")).toBe(".archived/P")
  expect(projectArchiveDestination("projects/P/Child")).toBe(".archived/P/Child")
  expect(argsFor({ kind: "project-archive" }, "projects/P/Child")).toEqual(["move", ".archived/P/Child", "--json"])
  for (const path of [".archived/P", "projects/../P", "/vault/projects/P"]) expect(() => projectArchiveDestination(path)).toThrow()
  expect(() => parseOperation({ kind: "project-archive", sessionID: "ses_Target" })).toThrow()
  expect(() => parseOperation({ kind: "project-archive", destination: "/foreign" })).toThrow()
})

test("HOST project archive invokes bounded pj move from explicit project cwd once", async () => {
  const calls: RunInput[] = []
  let changes = 0
  const bridge = new HostPjBridge("/vault", async input => {
    calls.push(input)
    return { code: 0, stderr: "", stdout: JSON.stringify(input.args[0] === "list" ? listResult() : { version: 1, ok: true, project: ".archived/P", data: {}, write: { state: "committed", paths: ["projects/P/README.md", ".archived/P/README.md"], commit: "a".repeat(40) } }) }
  })
  const service = hostWorkspaceService(bridge, async () => { changes++ })
  const result = await service.operate({ project: "projects/P", operation: { kind: "project-archive" } })
  expect(result).toMatchObject({ ok: true, project: ".archived/P", write: { state: "committed" } })
  expect(calls.map(c => [c.cwd, c.args])).toEqual([["/vault", ["list", "-a", "--archived", "--json"]], ["/vault/projects/P", ["move", ".archived/P", "--json"]]])
  expect(changes).toBe(1)
})
