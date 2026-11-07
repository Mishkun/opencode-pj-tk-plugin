import type { SessionInfo } from "@opencode/client"

type Timed<T> = { value: T; at: number; revision: number }
type SessionOverlay = { status?: Timed<"idle" | "busy" | "retry">; outcome?: Timed<"succeeded" | "failed" | "interrupted">; viewed?: Timed<number> }
type PendingOverlay = Timed<boolean | undefined> & { sessionID: string }
type NativeFacts = { busy: number; idle: number; viewed: number; outcome?: SessionInfo["outcome"] }
export type PendingRequest = { id: string; sessionID: string }
export type SessionMarker = "attention" | "working" | "finished" | "selected" | "empty"
const timestamp = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : -1

/** Only the latest event per session/request is retained. Pending tombstones
 * survive snapshots started before that event and contradictory stale snapshots. */
export class SessionState {
  revision = 0
  private sessions = new Map<string, SessionOverlay>()
  private requests = new Map<string, PendingOverlay>()
  private pending = new Map<string, string>()
  private observed = new Map<string, NativeFacts>()
  private nativeFacts(session: SessionInfo): NativeFacts {
    const previous = this.observed.get(session.id)
    const idle = timestamp(session.time.idle)
    return {
      busy: Math.max(previous?.busy ?? -1, timestamp(session.time.busy)), idle: Math.max(previous?.idle ?? -1, idle),
      viewed: Math.max(previous?.viewed ?? -1, timestamp(session.time.viewed)),
      outcome: idle >= 0 && (idle > (previous?.idle ?? -1) || idle === previous?.idle && previous.outcome === undefined) ? session.outcome : previous?.outcome,
    }
  }
  event(type: string, data: Record<string, unknown>, at: number, known: (id: string) => boolean): boolean {
    if (timestamp(at) < 0) return false
    const form = data.form as PendingRequest | undefined
    const sessionID = type === "form.created" ? form?.sessionID : data.sessionID
    if (typeof sessionID !== "string" || !known(sessionID)) return false
    const permission = type === "permission.asked" || type === "permission.replied"
    const isForm = type === "form.created" || type === "form.replied" || type === "form.cancelled"
    if (permission || isForm) {
      const id = type === "form.created" ? form?.id : type === "permission.replied" ? data.requestID : data.id
      if (typeof id !== "string") return false
      const key = `${permission ? "permission" : "form"}:${id}`, previous = this.requests.get(key)
      if (previous?.value === false && (type === "permission.asked" || type === "form.created")) return false
      if (previous && at < previous.at) return false
      if (previous && previous.value !== true && at === previous.at && (type === "permission.asked" || type === "form.created")) return false
      this.requests.set(key, { sessionID, at, revision: ++this.revision, value: type === "permission.asked" || type === "form.created" })
      return true
    }
    const overlay = this.sessions.get(sessionID) ?? {}
    let changed = false
    const status = type === "session.status" ? (data.status as { type?: string } | undefined)?.type
      : type === "session.execution.started" ? "busy" : ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"].includes(type) ? "idle" : undefined
    const observed = this.observed.get(sessionID)
    if ((status === "idle" || status === "busy" || status === "retry") && at >= Math.max(overlay.status?.at ?? -1, observed?.busy ?? -1, observed?.idle ?? -1)) {
      overlay.status = { value: status, at, revision: ++this.revision }; changed = true
    }
    const outcome = type === "session.execution.succeeded" ? "succeeded" : type === "session.execution.failed" ? "failed" : type === "session.execution.interrupted" ? "interrupted" : undefined
    if (outcome && at >= Math.max(overlay.outcome?.at ?? -1, observed?.busy ?? -1, observed?.idle ?? -1)) { overlay.outcome = { value: outcome, at, revision: ++this.revision }; changed = true }
    if (type === "session.viewed" && typeof data.idle === "number" && timestamp(data.idle) >= 0 && data.idle >= Math.max(overlay.viewed?.value ?? -1, observed?.viewed ?? -1)) {
      overlay.viewed = { value: data.idle, at, revision: ++this.revision }; changed = true
    }
    if (changed) this.sessions.set(sessionID, overlay)
    return changed
  }
  reconcile(native: readonly SessionInfo[], requests: { permissions?: PendingRequest[]; forms?: PendingRequest[] }, started: number): void {
    const known = new Map(native.map(session => [session.id, session]))
    for (const session of native) this.observed.set(session.id, this.nativeFacts(session))
    for (const id of this.observed.keys()) if (!known.has(id)) this.observed.delete(id)
    for (const id of this.sessions.keys()) if (!known.has(id)) this.sessions.delete(id)
    for (const kind of ["permissions", "forms"] as const) {
      const snapshot = requests[kind]
      if (!snapshot) continue
      const prefix = kind === "permissions" ? "permission:" : "form:"
      for (const key of this.pending.keys()) if (key.startsWith(prefix)) this.pending.delete(key)
      for (const request of snapshot) if (known.has(request.sessionID)) this.pending.set(`${prefix}${request.id}`, request.sessionID)
      for (const [key, overlay] of this.requests) {
        if (!known.has(overlay.sessionID)) this.requests.delete(key)
        // A closed ID remains a tombstone for the known session's lifetime:
        // these bulk snapshots carry no freshness/version evidence.
        else if (key.startsWith(prefix) && overlay.value === true && overlay.revision <= started && this.pending.has(key)) overlay.value = undefined
      }
    }
    for (const [id, overlay] of this.sessions) {
      const facts = this.observed.get(id)!
      if (overlay.status && overlay.status.revision <= started && (Math.max(facts.busy, facts.idle) > overlay.status.at || (overlay.status.value === "idle" ? facts.idle >= overlay.status.at : facts.busy >= overlay.status.at && facts.busy > facts.idle))) overlay.status = undefined
      if (overlay.outcome && overlay.outcome.revision <= started && facts.idle >= overlay.outcome.at && (facts.outcome === overlay.outcome.value || facts.idle > overlay.outcome.at)) overlay.outcome = undefined
      // Keep the latest viewed event's timestamp too: its idle watermark can
      // precede an outcome notification's created timestamp by milliseconds.
      if (!overlay.status && !overlay.outcome && !overlay.viewed) this.sessions.delete(id)
    }
    for (const [key, id] of this.pending) if (!known.has(id)) this.pending.delete(key)
    for (const [key, overlay] of this.requests) if (!known.has(overlay.sessionID)) this.requests.delete(key)
  }
  private pendingSessions(): Set<string> {
    const pending = new Map(this.pending)
    for (const [key, value] of this.requests) { if (value.value === true) pending.set(key, value.sessionID); if (value.value === false) pending.delete(key) }
    return new Set(pending.values())
  }
  marker(session: SessionInfo | undefined, current: boolean, pending = this.pendingSessions()): SessionMarker {
    if (!session) return current ? "selected" : "empty"
    const id = session.id, overlay = this.sessions.get(id)
    if (pending.has(id)) return "attention"
    const facts = this.nativeFacts(session), { busy, idle } = facts
    const authoritative = overlay?.status && overlay.status.at >= Math.max(busy, idle) ? overlay.status : undefined
    const running = authoritative ? authoritative.value !== "idle" : busy > idle
    if (running) return "working"
    const outcome = overlay?.outcome && overlay.outcome.at >= Math.max(busy, idle, authoritative?.at ?? -1) ? overlay.outcome.value
      : busy > idle || (authoritative?.at ?? -1) > idle ? undefined : facts.outcome
    const ended = Math.max(idle, overlay?.outcome?.at ?? -1)
    const viewed = Math.max(facts.viewed, overlay?.viewed?.value ?? -1)
    const seenEvent = overlay?.outcome && overlay.viewed && overlay.viewed.at >= overlay.outcome.at && overlay.viewed.value >= Math.max(busy, idle)
    if (!seenEvent && ended > viewed && outcome === "failed") return "attention"
    if (!seenEvent && ended > viewed && outcome === "succeeded") return "finished"
    return current ? "selected" : "empty"
  }
  /** A functional parent graph permits linear leaf propagation. Remaining
   * components are cycles; combine each once. Fork edges are independent roots. */
  familyMarkers(native: readonly SessionInfo[], current: string): Map<string, SessionMarker> {
    const pending = this.pendingSessions(), own = new Map(native.map(session => [session.id, this.marker(session, session.id === current, pending)]))
    const flags = new Map(native.map(session => [session.id, { working: own.get(session.id) === "working", pending: pending.has(session.id) }]))
    const parent = new Map<string, string>(), children = new Map(native.map(session => [session.id, 0]))
    for (const session of native) if (session.parentID && !session.fork && own.has(session.parentID)) {
      parent.set(session.id, session.parentID); children.set(session.parentID, children.get(session.parentID)! + 1)
    }
    const queue = [...children].filter(([, count]) => count === 0).map(([id]) => id), processed = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index], target = parent.get(id); processed.add(id)
      if (!target) continue
      const source = flags.get(id)!, destination = flags.get(target)!
      destination.working ||= source.working; destination.pending ||= source.pending
      children.set(target, children.get(target)! - 1)
      if (children.get(target) === 0) queue.push(target)
    }
    for (const id of own.keys()) if (!processed.has(id)) {
      const cycle: string[] = []; let cursor: string | undefined = id, working = false, needsAttention = false
      while (cursor && !processed.has(cursor)) {
        processed.add(cursor); cycle.push(cursor)
        working ||= flags.get(cursor)!.working; needsAttention ||= flags.get(cursor)!.pending
        cursor = parent.get(cursor)
      }
      for (const member of cycle) flags.set(member, { working, pending: needsAttention })
    }
    return new Map([...own].map(([id, marker]) => [id, flags.get(id)!.pending ? "attention" : flags.get(id)!.working ? "working" : marker]))
  }
  working(native: readonly SessionInfo[]): boolean { return [...this.familyMarkers(native, "").values()].includes("working") }
}
