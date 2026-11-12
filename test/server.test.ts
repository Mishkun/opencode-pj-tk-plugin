import { expect, spyOn, test } from "bun:test"
import plugin, { hostWorkspaceService, projectShellInstructions } from "../src/server"
import { HostPjBridge, type Operation, type RunInput } from "../src/bridge"
import { WorkspaceRPC } from "../src/rpc"
import { session, listResult, project, testHost, forkEvent } from "./fixtures"

test("tools and RPC register through actual SDK setup; native context hook retains Todo separation", async () => {
  const tools: any[] = [], hooks: any[] = [], methods: string[] = []
  const host = testHost({
    rpc: { register: async (_definition: unknown, handlers: Record<string, unknown>) => { methods.push(...Object.keys(handlers)); return { events: { emit: async () => {} } } } },
    tool: { transform: async (run: (editor: unknown) => void) => run({ namespace: () => {}, add: (tool: unknown) => tools.push(tool) }) },
    session: { hook: async (name: string, run: unknown) => { hooks.push({ name, run }) } },
    event: { subscribe: async function* () {} },
  })
  const cleanup = await plugin.setup(host)
  expect(methods).toEqual(["snapshot", "operate"])
  expect(tools).toHaveLength(0)
  const event = { sessionID: "ses_A", system: [] as any[] }
  hooks[0].run(event)
  expect(event.system[0].text).toContain("Native Todo is a separate session scratchpad")
  expect(event.system[0].text).toContain("zero memberships")
  expect(event.system[0].text).toContain("use native shell directly for pj commands")
  await cleanup?.()
})
test("HOST RPC schemas and handlers reject caller-chosen authority SID", async () => {
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
  let permissionCalls = 0, sessionReads = 0, prompts = 0
  const host = testHost({
    rpc: { register: async (_definition: unknown, value: typeof handlers) => { handlers = value; return { events: { emit: async () => {} } } } },
    tool: { transform: async () => {} },
    session: { hook: async () => {}, get: async () => { sessionReads++; throw new Error("identity borrowing") }, prompt: async () => { prompts++ } },
    permission: { assert: async () => { permissionCalls++ } },
    event: { subscribe: async function* () {} },
  })
  const cleanup = await plugin.setup(host)
  const context = { signal: new AbortController().signal }
  for (const actorSessionID of ["ses_Actual", "ses_Privileged"]) {
    await expect(handlers.snapshot({ actorSessionID }, context)).rejects.toThrow("actorSessionID")
    await expect(handlers.operate({ actorSessionID, project: "projects/P", operation: { kind: "task-close", taskID: "P" } }, context)).rejects.toThrow("actorSessionID")
  }
  for (const method of Object.values(WorkspaceRPC.methods)) {
    expect(method.input.additionalProperties).toBe(false)
    expect(Object.hasOwn(method.input.properties, "actorSessionID")).toBe(false)
  }
  expect(permissionCalls).toBe(0); expect(sessionReads).toBe(0); expect(prompts).toBe(0)
  expect(handlers.queueArchive).toBeUndefined()
  await cleanup?.()
})

test("HOST RPC remains functional while agent file commands use native shell", async () => {
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<any>> = {}
  const tools: any[] = [], operations: Operation[] = [], nativeReads: string[] = []
  let permissions = 0
  const call = spyOn(HostPjBridge.prototype, "call").mockImplementation(async op => {
    operations.push(op)
    return op.kind === "list" ? listResult() : { version: 1, ok: true, project: "projects/P", data: {}, write: { state: "unchanged", paths: [], commit: null } }
  })
  const host = testHost({
    rpc: { register: async (_definition: unknown, value: typeof handlers) => { handlers = value; return { events: { emit: async () => {} } } } },
    tool: { transform: async (run: (editor: unknown) => void) => run({ namespace: () => {}, add: (tool: unknown) => tools.push(tool) }) },
    permission: { assert: async () => { permissions++; throw new Error("HOST RPC must not select agent policy") } },
    session: { hook: async () => {}, get: async ({ sessionID }: { sessionID: string }) => { nativeReads.push(sessionID); return session(sessionID) }, update: async () => { throw new Error("project archive must not update native sessions") }, prompt: async () => { throw new Error("project archive must not queue native session messages") } },
    event: { subscribe: async function* () {} },
  })
  let cleanup: (() => void | Promise<void>) | void = undefined
  try {
    cleanup = await plugin.setup(host)
    const context = { signal: new AbortController().signal }
    expect(await handlers.snapshot({}, context)).toMatchObject({ projects: [project()], vaultRoot: "/vault", complete: true })
    for (const sessionID of ["ses_Actual", "ses_Privileged"]) await handlers.operate({ project: "projects/P", operation: { kind: "link", sessionID } }, context)
    expect(operations.filter(op => op.kind === "link")).toEqual([{ kind: "link", sessionID: "ses_Actual" }, { kind: "link", sessionID: "ses_Privileged" }])
    await handlers.operate({ project: "projects/P", operation: { kind: "project-archive" } }, context)
    expect(operations.at(-1)).toEqual({ kind: "project-archive" })
    const beforeInvalid = operations.length
    await expect(handlers.operate({ project: "projects/P", operation: { kind: "project-archive", sessionID: "ses_Target" } }, context)).rejects.toThrow("Unsupported operation or field")
    expect(operations).toHaveLength(beforeInvalid)
    expect(nativeReads).toEqual([])
    expect(permissions).toBe(0)
    expect(tools.find(tool => tool.name === "read")).toBeUndefined()
    expect(tools.find(tool => tool.name === "mutate")).toBeUndefined()
    expect(tools).toHaveLength(0)
  } finally { await cleanup?.(); call.mockRestore() }
})

test("HOST service requires explicit discovered project and rejects raw fork or list operations", async () => {
  const calls: RunInput[] = []
  const bridge = new HostPjBridge("/vault", async input => { calls.push(input); return { code: 0, stderr: "", stdout: JSON.stringify(listResult()) } })
  const service = hostWorkspaceService(bridge, async () => {})
  await expect(service.operate({ operation: { kind: "show" } })).rejects.toThrow("fields")
  await expect(service.operate({ project: "projects/P", operation: { kind: "fork", source: "ses_A", target: "ses_B" } })).rejects.toThrow("native session.forked")
  await expect(service.operate({ project: "projects/P", operation: { kind: "list" } })).rejects.toThrow("project-local")
  expect(calls).toHaveLength(0)
  await expect(service.operate({ project: "projects/Other", operation: { kind: "show" } })).rejects.toThrow("absent")
  expect(calls).toHaveLength(1)
})

test("failed or malformed archived-project reads cannot produce a complete membership snapshot", async () => {
  let handler: ((input: unknown, context: unknown) => Promise<unknown>) | undefined
  let response: any = { version: 1, ok: false, project: null, data: {}, error: { code: "permission_denied", message: "Project read denied" } }
  const call = spyOn(HostPjBridge.prototype, "call").mockImplementation(async () => response)
  const host = testHost({
    rpc: { register: async (_definition: unknown, handlers: any) => { handler = handlers.snapshot; return { events: { emit: async () => {} } } } },
    session: { hook: async () => {} }, event: { subscribe: async function* () {} },
  })
  let cleanup: (() => void | Promise<void>) | void = undefined
  try {
    cleanup = await plugin.setup(host)
    await expect(handler!({}, { signal: new AbortController().signal })).rejects.toThrow("Project read denied")
    response = listResult([project(), { ...project(".archived/P"), sessions: undefined } as any])
    await expect(handler!({}, { signal: new AbortController().signal })).rejects.toThrow("Invalid project state")
  } finally { await cleanup?.(); call.mockRestore() }
})

test("server native event subscription retains a valid fork without optional location", async () => {
  const event = forkEvent(); delete event.location
  const operations: Operation[] = [], reads: string[] = [], results: unknown[] = [], notices: unknown[] = []
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const call = spyOn(HostPjBridge.prototype, "call").mockImplementation(async op => {
    operations.push(op)
    return { version: 1, ok: true, project: null, data: {}, write: { state: "unchanged", paths: [], commit: null } }
  })
  const host = testHost({
    rpc: { register: async () => ({ events: { emit: async (name: string, data: unknown) => { if (name === "forkResult") results.push(data) } } }) },
    tool: { transform: async () => {} },
    session: {
      hook: async () => {},
      get: async ({ sessionID }: { sessionID: string }) => { reads.push(sessionID); return session(sessionID, sessionID === "ses_B" ? { fork: { sessionID: "ses_A", boundary: event.data.boundary } } : {}) },
      synthetic: async (input: unknown) => { notices.push(input) },
    },
    event: { subscribe: async function* () { try { yield event } finally { finish() } } },
  })
  let cleanup: (() => void | Promise<void>) | void = undefined
  try {
    cleanup = await plugin.setup(host)
    await finished
    expect(reads).toEqual(["ses_A", "ses_B"])
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ kind: "fork", source: "ses_A", target: "ses_B" })
    expect(results).toEqual([{ sessionID: "ses_B", source: "ses_A", status: "attached" }])
    expect(notices).toHaveLength(0)
  } finally { await cleanup?.(); call.mockRestore() }
})

test("agent instructions give direct native shell commands with safely quoted configured executable", () => {
  const instructions = projectShellInstructions("/vault with space", "ses_A", "/bin/pj's $(false)")
  expect(instructions).toContain("'/bin/pj'\\''s $(false)' list --json")
  expect(instructions).toContain("'/bin/pj'\\''s $(false)' list --archived --json")
  expect(instructions).toContain("'/bin/pj'\\''s $(false)' list --session 'ses_A' --archived --json")
  expect(instructions).toContain("tk close TASK_ID --result 'Result and verification' --json")
  expect(instructions).toContain("error.owners")
  expect(instructions).toContain("'/bin/pj'\\''s $(false)' tk claim TASK_ID 'ses_A' --json")
  expect(instructions).toContain("Vault root: '/vault with space'")
  expect(instructions).toContain("nearest project")
  expect(instructions).toContain("native read")
  expect(instructions).toContain("saved_uncommitted, unknown, timeout or cancellation")
  expect(instructions).toContain("move '.archived/P' --json")
  expect(instructions).toContain("including .archived/")
  expect(instructions).not.toContain("pj_read")
  expect(instructions).not.toContain("pj_mutate")
  expect(projectShellInstructions("/vault", "ses_A", "pj")).toContain("'pj' context --json")
})
test("mutation publishes a refresh even when pj returns a saved-uncommitted result", async () => {
  let changes = 0
  const response = { version: 1, ok: false, project: "projects/P", data: {}, write: { state: "saved_uncommitted", paths: ["projects/P/README.md"], commit: null }, error: { code: "commit_failed" } }
  const bridge = new HostPjBridge("/vault", async input => ({ code: input.args[0] === "list" ? 0 : 1, stderr: "", stdout: JSON.stringify(input.args[0] === "list" ? listResult() : response) }))
  const service = hostWorkspaceService(bridge, async () => { changes++ })
  expect(await service.operate({ project: "projects/P", operation: { kind: "status", status: "done" } })).toMatchObject({ ok: false, write: { state: "saved_uncommitted" } })
  expect(changes).toBe(1)
})
