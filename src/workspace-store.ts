import type { Context } from "@opencode/plugin/tui/context"
import type { LocationRef, SessionInfo } from "@opencode/client"
import { isAbsolute, relative } from "node:path"
import { errorMessage, project, record, type Project } from "./contract"
import { loadNativeSessions, onNativeInventoryChanged } from "./native-inventory"
import { sessionActivity, type ActivityGroupLabel } from "./projection"
import { WorkspaceRPC } from "./rpc"
import { SessionState, type PendingRequest } from "./session-state"

export type WorkspaceEntry = {
  key: string; location: LocationRef; sessionID: string; projectID?: string; root?: string
  projects?: Project[]; sessions?: SessionInfo[]; error?: string; loading: boolean
  activity: Map<string, number>; expanded: Map<string, boolean>; groups: Map<ActivityGroupLabel, boolean>; buckets: Map<string, boolean>
  visual: SessionState; flight?: Promise<void>; timer?: ReturnType<typeof setTimeout>; dirty: boolean; request: number
}
const contains = (root: string, directory: string) => { const path = relative(root, directory); return path !== ".." && !path.startsWith("../") && !isAbsolute(path) }

/** One plugin-lifetime owner for complete snapshots, in-flight reads and native
 * events. Sidebar mounts only subscribe; hiding a view never cancels its load. */
export class WorkspaceStore {
  readonly entries = new Map<string, WorkspaceEntry>()
  readonly controllers = new Set<AbortController>()
  disposed = false
  private listeners = new Set<() => void>()
  private stops: (() => void)[]
  private activityTimer?: ReturnType<typeof setTimeout>
  private request = 0
  constructor(private ctx: Context) {
    const rpc = ctx.client.rpc(WorkspaceRPC)
    this.stops = [
      onNativeInventoryChanged(ctx, () => { for (const entry of this.values()) this.schedule(entry) }),
      rpc.events.on("changed", event => { for (const entry of this.values()) if (entry.root ? contains(entry.root, event.location.directory) : entry.location.directory === event.location.directory) this.schedule(entry) }),
      rpc.events.on("forkResult", event => {
        const entries = this.values().filter(entry => entry.root ? contains(entry.root, event.location.directory) : entry.location.directory === event.location.directory)
        if (!entries.length) return
        const data = record(event.data)
        if (data.status === "incomplete") ctx.ui.toast.show({ title: "Fork attachment incomplete", message: errorMessage(data.error ?? "Inspect pj state before recovery"), variant: "error", duration: 20_000, sessionID: String(data.sessionID) })
        entries.forEach(entry => this.schedule(entry))
      }),
      ctx.data.listen(({ details }) => {
        // This runtime notification is omitted from the 2.2.5 SDK event union.
        const event = details as unknown as { type: string; created?: unknown; data?: Record<string, unknown> }
        if (this.disposed || !event.data || typeof event.created !== "number") return
        let changed = false
        for (const entry of this.values()) {
          const native = new Map((entry.sessions ?? []).map(session => [session.id, session]))
          const known = (id: string) => native.has(id) || id === entry.sessionID
          if (entry.visual.event(event.type, event.data, event.created, known)) {
            changed = true
            if (event.type.startsWith("permission.") || event.type.startsWith("form.")) this.schedule(entry)
          }
          const id = event.data.sessionID, at = event.created
          if (event.type !== "session.message.content.updated" || typeof id !== "string" || !known(id) || !Number.isFinite(at) || at < 0 || at > 8_640_000_000_000_000) continue
          if (at <= Math.max(sessionActivity(native.get(id)) ?? -1, entry.activity.get(id) ?? -1)) continue
          entry.activity = new Map(entry.activity).set(id, at)
          if (this.activityTimer === undefined) this.activityTimer = setTimeout(() => { this.activityTimer = undefined; this.changed() }, 1000)
        }
        if (changed) this.changed()
      }),
    ]
  }
  private values(): WorkspaceEntry[] { return [...new Set(this.entries.values())] }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  changed(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  entry(sessionID: string): WorkspaceEntry {
    const location = { ...(this.ctx.location ?? this.ctx.data.location.default()) }
    const current = this.ctx.data.session.get(sessionID) ?? this.values().filter(entry => entry.root && contains(entry.root, location.directory)).flatMap(entry => entry.sessions ?? []).find(session => session.id === sessionID)
    const projectID = current?.projectID
    const existing = this.values().filter(entry => projectID && entry.projectID === projectID && entry.root && contains(entry.root, location.directory) && (!current || contains(entry.root, current.location.directory))).sort((a, b) => b.root!.length - a.root!.length)[0]
    if (existing) { existing.sessionID = sessionID; return existing }
    // Until a native project and vault root are verified, keep cold scopes apart.
    const key = JSON.stringify([location.directory, projectID ?? null, projectID ? null : sessionID])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { key, location, sessionID, projectID, loading: false, activity: new Map(), expanded: new Map(), groups: new Map(), buckets: new Map(), visual: new SessionState(), dirty: false, request: 0 }
      this.entries.set(key, entry)
    }
    return entry
  }
  ensure(sessionID: string): Promise<void> {
    const entry = this.entry(sessionID)
    return entry.projects && entry.sessions && entry.root ? Promise.resolve() : this.load(entry)
  }
  refresh(sessionID: string): Promise<void> { return this.load(this.entry(sessionID)) }
  private schedule(entry: WorkspaceEntry): void {
    if (this.disposed) return
    if (entry.flight) { entry.dirty = true; return }
    if (entry.timer === undefined) entry.timer = setTimeout(() => { entry.timer = undefined; void this.load(entry) }, 100)
  }
  private load(entry: WorkspaceEntry): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (entry.flight) return entry.flight
    clearTimeout(entry.timer); entry.timer = undefined
    const route = this.ctx.ui.router.current()
    const active = route.type === "session" ? this.ctx.data.session.get(route.sessionID) : undefined
    const sessionID = active && entry.root && active.projectID === entry.projectID && contains(entry.root, active.location.directory) ? active.id : entry.sessionID
    const location = { ...entry.location }, started = entry.visual.revision
    const request = ++this.request; entry.request = request
    const controller = new AbortController(), { signal } = controller
    this.controllers.add(controller)
    entry.loading = !entry.projects || !entry.sessions || !entry.root
    this.changed()
    entry.flight = (async () => {
      try {
        const snapshot = record(await this.ctx.client.rpc(WorkspaceRPC).snapshot({}, { location, signal }))
        signal.throwIfAborted()
        if (snapshot.complete !== true || !Array.isArray(snapshot.projects) || typeof snapshot.vaultRoot !== "string" || !isAbsolute(snapshot.vaultRoot)) throw new Error("Complete pj membership snapshot and vault scope are unavailable")
        const projects = snapshot.projects.map(project)
        const native = await loadNativeSessions(this.ctx, sessionID, signal)
        const current = native.find(session => session.id === sessionID) ?? this.ctx.data.session.get(sessionID)
        if (current && !contains(snapshot.vaultRoot, current.location.directory)) throw new Error("Current session is outside this vault scope")
        const pending = await Promise.allSettled([this.ctx.client.permission.request.list({ location }, { signal }), this.ctx.client.form.list({ location }, { signal })])
        signal.throwIfAborted()
        if (this.disposed || entry.request !== request) return
        const projectID = native.find(session => session.id === sessionID)?.projectID ?? entry.projectID
        if (!projectID) throw new Error("Native project scope is unavailable")
        const key = JSON.stringify([snapshot.vaultRoot, projectID]), existing = this.entries.get(key)
        if (existing && existing !== entry && existing.request > request) return
        const known = new Set(native.map(session => session.id))
        entry.activity = new Map([...entry.activity].filter(([id]) => known.has(id)))
        const requests: { permissions?: PendingRequest[]; forms?: PendingRequest[] } = {}
        if (pending[0].status === "fulfilled") requests.permissions = pending[0].value.data
        if (pending[1].status === "fulfilled") requests.forms = pending[1].value.data
        entry.visual.reconcile(native, requests, started)
        const errors = pending.flatMap(result => result.status === "rejected" ? [errorMessage(result.reason)] : [])
        entry.error = errors.length ? `Session attention unavailable: ${errors.join("; ")}` : undefined
        Object.assign(entry, { root: snapshot.vaultRoot, projectID, projects, sessions: native.map(session => ({ ...session, time: { ...session.time }, location: { ...session.location } })) })
        if (key !== entry.key) this.entries.delete(entry.key)
        entry.key = key; this.entries.set(key, entry)
      } catch (error) { if (!this.disposed && entry.request === request) entry.error = errorMessage(error) }
      finally {
        this.controllers.delete(controller); entry.flight = undefined; entry.loading = false
        this.changed()
        if (entry.dirty) { entry.dirty = false; this.schedule(entry) }
      }
    })()
    return entry.flight
  }
  dispose(): void {
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const entry of this.values()) clearTimeout(entry.timer)
    clearTimeout(this.activityTimer)
    for (const controller of this.controllers) controller.abort()
    this.listeners.clear(); this.entries.clear()
  }
}
