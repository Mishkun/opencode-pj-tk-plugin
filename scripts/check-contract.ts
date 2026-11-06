import { HostPjBridge } from "../src/bridge"
import { projectsFrom } from "../src/contract"

// Read-only verification hook for the parent's existing isolated synthetic vault.
const root = process.argv[2], sessionID = process.argv[3]
if (!root || !sessionID) throw new Error("Usage: bun scripts/check-contract.ts ABSOLUTE_SYNTHETIC_VAULT SID")
const bridge = new HostPjBridge(root)
const start = performance.now()
const projects = projectsFrom(await bridge.call({ kind: "list", sessionID }))
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - start), projects: projects.map(p => ({ path: p.path, parent: p.parent, status: p.status, sessions: p.sessions, tasks: p.tasks.map(t => ({ id: t.id, status: t.status, ready: t.ready, assigned: t.claimed_by_sessions })) })) }, null, 2))
