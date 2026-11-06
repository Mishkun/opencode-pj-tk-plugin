import { Plugin } from "@opencode/plugin"
import { resolve } from "node:path"
import { HostPjBridge, parseOperation, mutation, type HostRequest } from "./bridge"
import { errorMessage, projectArchiveDestination, projectPath, projectsFrom, sid, text } from "./contract"
import { attachFork } from "./lifecycle"
import { WorkspaceRPC, hostRpcInput } from "./rpc"

export function projectShellInstructions(root: string, sessionID: string, executable = process.env.OPENCODE_PJ_BIN || "pj"): string {
  const quote = (value: string) => `'${text(value).replaceAll("'", "'\\''")}'`
  const pj = quote(executable), current = quote(sid(sessionID))
  return [
    "Project workspace: use native shell directly for pj commands. Native Todo is a separate session scratchpad.",
    `Vault root: ${quote(root)}. Projects live under projects/ and .archived/. Set the shell working directory to the vault root for list, or to the project folder (or its docs subfolder) for local commands; pj resolves the nearest project.`,
    `From vault root: ${pj} list --json`,
    `From vault root: ${pj} list --session ${current} --json`,
    `From project cwd: ${pj} show --json`,
    `From project cwd: ${pj} context --json`,
    `From project cwd: ${pj} session link ${current} --json`,
    `From project cwd: ${pj} tk claim TASK_ID ${current} --json`,
    `From project cwd: ${pj} tk close TASK_ID --json`,
    `From project cwd: ${pj} log 'Project result' --session ${current} --json`,
    `Archive projects/P from its cwd: ${pj} move '.archived/P' --json. For projects/<relative>, use .archived/<relative>; the entire nested branch moves with its status, tasks and memberships preserved. Open conversations and native execution continue.`,
    "Use context's material inventory to select documents, then read them with native read. Task checklists stay plain Markdown; task close and project status are explicit operations.",
    "Inspect the version:1 JSON envelope and command exit status. Successful mutations report write.state committed with a verified commit, or unchanged. Report errors with write.state, saved paths, checks and confirmed commit. For dirty_target, review and commit existing target edits before an explicit retry. After saved_uncommitted, unknown, timeout or cancellation, inspect current state before explicit recovery; keep retry, rollback and push explicit.",
    "The sidebar shows active projects/ only. Inbox contains native root/fork sessions in this vault with zero memberships across the complete pj list, including .archived/. Sessions linked only to archived projects stay outside Inbox. Access archived projects through pj or files.",
  ].join("\n")
}

/** HOST-only service. Explicit project paths select data scope, never an agent. */
export function hostWorkspaceService(bridge: HostPjBridge, changed: () => Promise<void>) {
  const list = async (request: HostRequest = {}) => projectsFrom(await bridge.call({ kind: "list" }, undefined, request))
  const operate = async (input: unknown, request: HostRequest = {}) => {
    const data = hostRpcInput(input, ["project", "operation"])
    const operation = parseOperation(data.operation)
    if (operation.kind === "list" || operation.kind === "fork") throw new Error("HOST operate requires a project-local operation; fork is owned by native session.forked")
    const path = projectPath(data.project)
    if (operation.kind === "project-archive") projectArchiveDestination(path)
    if (!(await list(request)).some(p => p.path === path)) throw new Error("Project is absent from pj discovery")
    try { return await bridge.call(operation, path, request) }
    finally {
      if (mutation(operation)) await changed().catch(error => console.error("pj workspace refresh notification failed", error))
    }
  }
  return { list, operate }
}

export default Plugin.define({
  id: "pj.workspace.server",
  async setup(ctx) {
    // OpenCode's project directory is the containing Git checkout, not a second vault setting.
    const root = resolve(ctx.location.project.directory)
    const hostBridge = new HostPjBridge(root)
    const controller = new AbortController()
    let changed = async () => {}
    const hostService = hostWorkspaceService(hostBridge, () => changed())
    const rpc = await ctx.rpc.register(WorkspaceRPC, {
      // RPC is an authenticated HOST capability, like native client APIs.
      // Agent project-file commands run directly through native shell.
      snapshot: async (input, context) => { hostRpcInput(input, []); return { projects: await hostService.list({ signal: context.signal }), vaultRoot: root, complete: true } },
      operate: async (input, context) => hostService.operate(input, { signal: context.signal }),
    })
    changed = () => rpc.events.emit("changed", {})
    await ctx.session.hook("context", event => {
      event.system.push({ type: "text", text: projectShellInstructions(root, event.sessionID) })
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["session.forked", "filesystem.changed"], signal: controller.signal })) {
          if (event.type === "filesystem.changed") { await changed(); continue }
          if (event.location && event.location.directory !== ctx.location.directory) continue
          try {
            const result = await attachFork(hostBridge, ctx, event, ctx.location.directory, controller.signal)
            await rpc.events.emit("forkResult", { sessionID: result.sessionID, source: result.source, status: result.status, ...(result.error ? { error: result.error } : {}) })
            await changed()
            if (result.status === "incomplete") await ctx.session.synthetic({ sessionID: result.sessionID, text: `Project fork attachment incomplete. ${result.error}` })
          } catch (error) {
            const message = errorMessage(error)
            await rpc.events.emit("forkResult", { sessionID: event.data.sessionID, source: event.data.parentID, status: "incomplete", error: message })
            await ctx.session.synthetic({ sessionID: event.data.sessionID, text: `Project fork attachment incomplete. ${message}. Inspect pj state before an explicit recovery action.` })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("pj workspace native event stream stopped", error)
      }
    })()
    return () => controller.abort()
  },
})
