import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { HostPjBridge, runProcess } from "../src/bridge"
import { envelope, project, record, projectsFrom } from "../src/contract"
import { attachFork } from "../src/lifecycle"
import { hostWorkspaceService } from "../src/server"
import { forkEvent, session, testHost } from "./fixtures"

const executable = process.env.PJ_INTEGRATION_BIN
test.skipIf(!executable)("real pj: fork/claim/readiness, then branch archive preserves data, staging and collision safety", async () => {
  const verification = resolve(import.meta.dir, "../verification")
  await mkdir(verification, { recursive: true })
  const root = await mkdtemp(join(verification, "cli-"))
  const git = async (...args: string[]) => {
    const result = await runProcess({ executable: "git", args, cwd: root, timeoutMs: 5_000 })
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const pj = async (args: string[], cwd: string, mutation = false) => {
    const result = await runProcess({ executable: executable!, args: [...args, "--json"], cwd, timeoutMs: 30_000 })
    const parsed = envelope(JSON.parse(result.stdout), mutation)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed))
    return parsed
  }
  try {
    await git("init")
    await git("config", "user.name", "Synthetic plugin test")
    await git("config", "user.email", "plugin-test@example.invalid")
    await git("config", "commit.gpgsign", "false")
    await git("commit", "--allow-empty", "-m", "Synthetic baseline")
    const P = join(root, "projects/P"), Q = join(root, "projects/Q"), child = join(P, "Child")
    for (const path of [P, Q, child]) { await mkdir(path, { recursive: true }); await pj(["init"], path, true) }
    await mkdir(join(P, "docs"), { recursive: true })
    await writeFile(join(P, "docs/spec.md"), "Synthetic material\n")
    await git("add", "projects/P/docs/spec.md"); await git("commit", "-m", "Synthetic material")
    const bridge = new HostPjBridge(root, runProcess, executable)
    for (const path of ["projects/P", "projects/Q"]) await bridge.call({ kind: "link", sessionID: "ses_A", title: "A" }, path)
    const checklist = "- [ ] First check\n- [ ] Second check"
    const created = await pj(["tk", "create", "T", "-d", checklist], P, true)
    const T = String(created.data.taskId)
    const U = String((await pj(["tk", "create", "U"], P, true)).data.taskId)
    await pj(["tk", "dep", U, T], P, true)
    await bridge.call({ kind: "task-claim", taskID: T, sessionID: "ses_A" }, "projects/P")
    const initial = project((await bridge.call({ kind: "show" }, "projects/P")).data.project)
    expect(initial.tasks.find(t => t.id === U)?.ready).toBe(false)
    expect(initial.tasks.find(t => t.id === T)?.body).toContain(checklist)
    const context = await pj(["context"], join(P, "docs"))
    expect(context.project).toBe("projects/P"); expect(JSON.stringify(context.data.materials)).toContain("spec.md")
    const before = await git("rev-list", "--count", "HEAD")
    const event = forkEvent(); event.location = { directory: P }
    const host = testHost({ session: { get: async ({ sessionID }: { sessionID: string }) => session(sessionID, { title: "Fork B", location: { directory: P }, ...(sessionID === "ses_B" ? { fork: { sessionID: "ses_A", boundary: event.data.boundary } } : {}) }) } })
    const fork = await attachFork(bridge, host, event, P)
    expect(fork.status).toBe("attached")
    expect(Number(await git("rev-list", "--count", "HEAD")) - Number(before)).toBe(1)
    const snapshots = projectsFrom(await bridge.call({ kind: "list" }))
    expect(snapshots.filter(p => p.sessions.some(s => s.id === "ses_B")).map(p => p.path)).toEqual(["projects/P", "projects/Q"])
    expect(snapshots.find(p => p.path === "projects/P")?.tasks.find(t => t.id === T)?.claimed_by_sessions).toEqual(["ses_A"])
    await bridge.call({ kind: "task-claim", taskID: T, sessionID: "ses_B" }, "projects/P")
    const claimed = project((await bridge.call({ kind: "show" }, "projects/P")).data.project)
    expect(claimed.tasks.find(t => t.id === T)).toMatchObject({ status: "open", claimed_by_sessions: ["ses_B"], body: initial.tasks.find(t => t.id === T)!.body })
    await bridge.call({ kind: "task-close", taskID: T }, "projects/P")
    await bridge.call({ kind: "task-note", taskID: T, text: "Task result" }, "projects/P")
    await bridge.call({ kind: "log", text: "Project result", sessionID: "ses_B" }, "projects/P")
    const final = project((await bridge.call({ kind: "show" }, "projects/P")).data.project)
    expect(final.tasks.find(t => t.id === U)).toMatchObject({ status: "open", ready: true })
    expect(final.tasks.find(t => t.id === T)).toMatchObject({ status: "closed", claimed_by_sessions: ["ses_B"] })
    expect(final.tasks.find(t => t.id === T)?.body).toContain(checklist)
    expect(final.tasks.find(t => t.id === T)?.body).toContain("Task result")
    const note = String((await bridge.call({ kind: "context" }, "projects/P")).data.note)
    expect(note).toContain("Project result"); expect(note).not.toContain("Task result")
    expect(await git("status", "--porcelain")).toBe("")

    await bridge.call({ kind: "status", status: "waiting" }, "projects/P")
    await bridge.call({ kind: "link", sessionID: "ses_C", title: "Child project session" }, "projects/P/Child")
    await bridge.call({ kind: "task-create", title: "Child task" }, "projects/P/Child")
    const sourceNote = String((await bridge.call({ kind: "context" }, "projects/P")).data.note)
    const childNote = String((await bridge.call({ kind: "context" }, "projects/P/Child")).data.note)
    const sourceProjects = projectsFrom(await bridge.call({ kind: "list" })).filter(p => p.path === "projects/P" || p.path.startsWith("projects/P/"))
    const collision = join(root, ".archived/P")
    await mkdir(collision, { recursive: true }); await pj(["init"], collision, true)
    const collisionNote = String((await bridge.call({ kind: "context" }, ".archived/P")).data.note)
    await writeFile(join(root, "foreign.txt"), "baseline\n")
    await git("add", "foreign.txt"); await git("commit", "-m", "Synthetic unrelated baseline")
    await writeFile(join(root, "foreign.txt"), "foreign staged change\n"); await git("add", "foreign.txt")
    await writeFile(join(root, "foreign.txt"), "foreign staged change\nforeign unstaged change\n")
    const staged = await git("diff", "--cached", "--", "foreign.txt"), unstaged = await git("diff", "--", "foreign.txt")
    const service = hostWorkspaceService(bridge, async () => {})
    const beforeCollision = await git("rev-parse", "HEAD")
    const rejected = await service.operate({ project: "projects/P", operation: { kind: "project-archive" } })
    expect(rejected).toMatchObject({ ok: false, error: { code: "destination_exists" }, write: { state: "not_written", commit: null } })
    expect(await git("rev-parse", "HEAD")).toBe(beforeCollision)
    expect(String((await bridge.call({ kind: "context" }, "projects/P")).data.note)).toBe(sourceNote)
    expect(String((await bridge.call({ kind: "context" }, ".archived/P")).data.note)).toBe(collisionNote)
    // Free the synthetic collision using the existing managed CLI move.
    await pj(["move", ".archived/Collision"], collision, true)
    const beforeArchive = Number(await git("rev-list", "--count", "HEAD"))
    const moved = await service.operate({ project: "projects/P", operation: { kind: "project-archive" } })
    expect(moved).toMatchObject({ ok: true, project: ".archived/P", write: { state: "committed" } })
    expect(Number(await git("rev-list", "--count", "HEAD")) - beforeArchive).toBe(1)
    expect(moved.write?.commit).toBe(await git("rev-parse", "HEAD"))
    expect(await git("diff", "--cached", "--", "foreign.txt")).toBe(staged)
    expect(await git("diff", "--", "foreign.txt")).toBe(unstaged)
    expect((await git("show", "--format=", "--name-only", "HEAD")).split("\n")).not.toContain("foreign.txt")
    const archived = projectsFrom(await bridge.call({ kind: "list" }))
    expect(archived.some(p => p.path === "projects/P" || p.path.startsWith("projects/P/"))).toBe(false)
    for (const previous of sourceProjects) {
      const next = archived.find(p => p.path === previous.path.replace(/^projects\//, ".archived/"))!
      expect(next.status).toBe(previous.status)
      expect(next.sessions).toEqual(previous.sessions)
      expect(next.tasks.map(({ path, ...task }) => task)).toEqual(previous.tasks.map(({ path, ...task }) => task))
    }
    expect(archived.find(p => p.path === ".archived/P/Child")?.parent).toBe(".archived/P")
    expect(archived.find(p => p.path === "projects/Q")?.sessions.map(s => s.id)).toEqual(["ses_A", "ses_B"])
    expect(String((await bridge.call({ kind: "context" }, ".archived/P")).data.note)).toBe(sourceNote)
    expect(String((await bridge.call({ kind: "context" }, ".archived/P/Child")).data.note)).toBe(childNote)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
