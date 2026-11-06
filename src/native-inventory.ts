import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { isAbsolute } from "node:path"

export function onNativeInventoryChanged(context: Pick<Context, "data">, refresh: () => void): () => void {
  const stops = (["server.connected", "session.created", "session.forked", "session.deleted", "session.archived", "session.unarchived", "session.renamed", "session.moved"] as const)
    .map(type => context.data.on(type, refresh))
  return () => { stops.forEach(stop => stop()) }
}

export async function loadNativeSessions(context: Pick<Context, "client" | "data">, sessionID: string, signal: AbortSignal): Promise<SessionInfo[]> {
  signal.throwIfAborted()
  const cached = context.data.session.get(sessionID)
  const current = cached?.projectID ? cached : await context.client.session.get({ sessionID }, { signal })
  signal.throwIfAborted()
  if (current.id !== sessionID || !current.projectID) throw new Error("Current native session project is unavailable")

  const sessions = new Map<string, SessionInfo>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    signal.throwIfAborted()
    // Omit directory (exact equality) and archived (both native states belong).
    const page = await context.client.session.list({ project: current.projectID, limit: 200, order: "desc", cursor }, { signal })
    signal.throwIfAborted()
    if (!Array.isArray(page.data) || !page.cursor || typeof page.cursor !== "object") throw new Error("Native session inventory page is unavailable")
    for (const session of page.data) {
      if (!session?.id || !session.projectID || !session.location?.directory || !isAbsolute(session.location.directory)) throw new Error("Native session inventory contains incomplete session data")
      if (!sessions.has(session.id)) sessions.set(session.id, session)
    }
    // The installed server returns next even on its final populated page.
    // Other official implementations may omit it to mark the terminal page.
    const next = page.cursor.next
    if (page.data.length === 0 || next == null) return [...sessions.values()]
    if (typeof next !== "string" || !next) throw new Error("Native session inventory cursor is invalid")
    if (cursors.has(next)) throw new Error("Native session inventory cursor repeated; completeness is unknown")
    cursors.add(next)
    cursor = next
  }
}
