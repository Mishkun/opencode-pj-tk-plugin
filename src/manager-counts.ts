import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { envelope, projectPath, record, sid } from "./contract"

const exec = promisify(execFile)
// Shell jobs include long-lived dev servers. Counting tickets doesn't depend
// on their output. Only defer for owned non-shell jobs that return agent work.
export function deferForBackground(owner: string, jobs: ReadonlyArray<{sessionID:string;kind:string}>): boolean {
  return jobs.some(job => job.sessionID === owner && job.kind !== "shell")
}
export async function readCounts(root: string, id: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await exec(process.env.OPENCODE_PJ_BIN || "pj",
    ["list", "--session", sid(id), "--fields", "path,tasks", "--json"],
    { cwd: root, signal, timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
  return stdout
}
export function idleSummary(raw: string, owner: string) {
  const response = envelope(JSON.parse(raw), false)
  if (!response.ok || !Array.isArray(response.data.projects)) throw new Error("Missing pj snapshot")
  let eligible = 0
  const rows = response.data.projects.map(value => {
    const p = record(value), path = projectPath(p.path)
    if (!Array.isArray(p.tasks)) throw new Error("Missing tasks")
    let remaining = 0, available = 0
    const ids: string[] = []
    for (const rawTask of p.tasks) {
      const t = record(rawTask)
      if (!["open", "in_progress", "closed"].includes(String(t.status)) || typeof t.ready !== "boolean" ||
        !Array.isArray(t.claimed_by_sessions) || typeof t.id !== "string") throw new Error("Invalid task snapshot")
      if (t.status !== "closed") remaining++
      if (t.status !== "open" || !t.ready) continue
      if (t.claimed_by_sessions.length && !t.claimed_by_sessions.includes(owner)) continue
      available++; eligible++
      if (ids.length < 6) ids.push(t.id)
    }
    return { path, remaining, available, ids }
  }).sort((a,b)=>a.path.localeCompare(b.path))
  if (!eligible) return null
  return {
    signature: JSON.stringify(rows.map(r=>[r.path,r.available])),
    text: ["Сводка pj/tk перед остановкой менеджера (состояние реестра, не новое поручение).",
      ...rows.map(r=>`${JSON.stringify(r.path)}: незакрытых задач всего ${r.remaining}; готовы к старту и доступны этой сессии: ${r.available}${r.ids.length ? ` (${r.ids.join(", ")}${r.available>r.ids.length ? ", …" : ""})` : ""}.`),
      "Если среди них есть разрешённый следующий шаг по текущему поручению, можешь продолжить. Иначе закончи ход; эта сводка не расширяет согласованный объём работы."].join("\n"),
  }
}
export type IdleMemo = { signature: string; execution: number }
export async function remindBeforeIdle(id: string, execution: number, read: ()=>Promise<string>,
  load: ()=>Promise<unknown>, save: (m: IdleMemo | null)=>Promise<void>, send: (text:string)=>Promise<void>) {
  const summary = idleSummary(await read(), id)
  const memo = await load() as Partial<IdleMemo> | null
  if (!summary) { if (memo) await save(null); return }
  if (memo?.signature === summary.signature) return
  // A model continuation can itself go idle: at most one chance in a single drain.
  if (memo?.execution === execution) return
  // Reserve before admission: never loop/retry an uncertain synthetic send.
  await save({signature:summary.signature, execution})
  await send(summary.text)
}
