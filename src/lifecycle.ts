import type { Plugin } from "@opencode/plugin"
import type { SessionForked } from "@opencode/client"
import { HostPjBridge } from "./bridge"
import { isAbsolute, relative } from "node:path"
import { failureMessage, sid, type Envelope } from "./contract"

export type ForkResult = { sessionID: string; source: string; status: "attached" | "incomplete"; result?: Envelope; error?: string }
export async function attachFork(bridge: HostPjBridge, host: Pick<Plugin.Context, "session">, event: SessionForked, expectedDirectory: string, signal?: AbortSignal): Promise<ForkResult> {
  const within = relative(bridge.root, expectedDirectory)
  if (!isAbsolute(expectedDirectory) || within === ".." || within.startsWith("../") || isAbsolute(within) || event.type !== "session.forked" || (event.location && event.location.directory !== expectedDirectory)) throw new Error("Native fork event is outside this host location")
  const source = sid(event.data.parentID), target = sid(event.data.sessionID)
  // parentID here belongs specifically to session.forked, not child ancestry.
  const [sourceInfo, info] = await Promise.all([
    host.session.get({ sessionID: source }, { signal }),
    host.session.get({ sessionID: target }, { signal }),
  ])
  if (source === target || sourceInfo.id !== source || sourceInfo.location.directory !== expectedDirectory || info.id !== target || info.fork?.sessionID !== source || info.fork.boundary.type !== event.data.boundary.type || info.fork.boundary.messageID !== event.data.boundary.messageID || info.location.directory !== expectedDirectory) throw new Error("Native fork metadata does not agree with session.forked")
  // The native host lifecycle owns this write. No agent SID selects authority.
  const result = await bridge.call({ kind: "fork", source, target, ...(info.title ? { title: info.title } : {}) }, undefined, { signal })
  return { source, sessionID: target, status: result.ok ? "attached" : "incomplete", result, ...(!result.ok ? { error: failureMessage(result) } : {}) }
}
/** Native focus changes both the conversation and its composer target. */
export function focusSession(host: { tabs: { enabled(): boolean; focus(id: string): void }; router: { navigate(destination: { type: "session"; sessionID: string }): void } }, sessionID: string): void {
  sid(sessionID)
  if (host.tabs.enabled()) host.tabs.focus(sessionID)
  else host.router.navigate({ type: "session", sessionID })
}
