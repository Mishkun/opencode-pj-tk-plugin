import type { Task } from "./contract"

export type TaskGraphLayout = {
  width: number
  height: number
  nodes: { task: Task; x: number; y: number; width: number; height: number }[]
  lines: string[]
  warnings: string[]
}

type Edge = { from: number; to: number }

/**
 * Coordinates are terminal cells, not viewport-relative positions. Boxes have
 * a border, one title row and one status row (height 4), or two title rows
 * when the title exceeds the padded inner width (height 5). The caller
 * renders/clips labels, overlays boxes on `lines`, and scrolls the whole canvas.
 *
 * Every edge has separate ports and routing tracks. ╪ is a non-connecting
 * crossover, never a junction; connectors touch the appropriate box borders.
 * Every arrival has its own ▼ immediately above the dependent. Neither
 * parent nor links imply dependency edges. Cyclic edges are explicitly listed
 * in warnings rather than rendered as invented top-to-bottom relationships.
 */
export function layoutTaskGraph(tasks: Task[], width: number): TaskGraphLayout {
  const warnings: string[] = []
  const unique: Task[] = []
  const ids = new Map<string, number>()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      warnings.push(`Duplicate task ID ignored: ${task.id} (first record retained).`)
    } else {
      ids.set(task.id, unique.length)
      unique.push(task)
    }
  }
  if (!unique.length) return { width: 0, height: 0, nodes: [], lines: [], warnings }

  const edges: Edge[] = []
  unique.forEach((task, to) => {
    for (const dep of new Set(task.deps)) {
      const from = ids.get(dep)
      if (from === undefined) warnings.push(`Missing prerequisite: ${dep} → ${task.id}.`)
      else edges.push({ from, to })
    }
  })
  const outgoing = unique.map(() => [] as number[])
  const incoming = unique.map(() => [] as number[])
  edges.forEach(({ from, to }) => { outgoing[from].push(to); incoming[to].push(from) })

  // Iterative Kosaraju avoids recursion limits on long task chains.
  const visited = new Set<number>()
  const finish: number[] = []
  for (let start = 0; start < unique.length; start++) {
    if (visited.has(start)) continue
    visited.add(start)
    const stack = [{ node: start, next: 0 }]
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = outgoing[top.node][top.next++]
      if (next === undefined) { finish.push(top.node); stack.pop() }
      else if (!visited.has(next)) { visited.add(next); stack.push({ node: next, next: 0 }) }
    }
  }
  const component = unique.map(() => -1)
  let componentID = 0
  for (const start of finish.reverse()) {
    if (component[start] !== -1) continue
    component[start] = componentID
    const stack = [start]
    while (stack.length) {
      const node = stack.pop()!
      for (const next of incoming[node]) {
        if (component[next] !== -1) continue
        component[next] = componentID
        stack.push(next)
      }
    }
    componentID++
  }
  const drawable = edges.filter(({ from, to }) => {
    if (component[from] !== component[to]) return true
    warnings.push(`Cycle edge not drawn: ${unique[from].id} → ${unique[to].id}.`)
    return false
  })
  const ins = unique.map(() => [] as number[])
  const outs = unique.map(() => [] as number[])
  drawable.forEach(({ from, to }, i) => { outs[from].push(i); ins[to].push(i) })
  const pending = ins.map(list => list.length)
  const rank = unique.map(() => 0)
  const queue = pending.flatMap((count, i) => count === 0 ? [i] : [])
  for (let head = 0; head < queue.length; head++) {
    const from = queue[head]
    for (const index of outs[from]) {
      const to = drawable[index].to
      rank[to] = Math.max(rank[to], rank[from] + 1)
      if (--pending[to] === 0) queue.push(to)
    }
  }
  const layers: number[][] = []
  rank.forEach((r, i) => { (layers[r] ??= []).push(i) })
  // Stable barycentre ordering makes ordinary forks/joins readable.
  const positions = unique.map(() => 0)
  layers.forEach(layer => layer.forEach((node, i) => { positions[node] = i }))
  for (const layer of layers) {
    const barycentre = (node: number) => ins[node].length
      ? ins[node].reduce((sum, edge) => sum + positions[drawable[edge].from], 0) / ins[node].length
      : positions[node]
    layer.sort((a, b) => barycentre(a) - barycentre(b) || a - b)
    layer.forEach((node, i) => { positions[node] = i })
  }

  const viewport = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 72
  const gap = 3
  const nodeWidths = unique.map(() => 0)
  const rowWidths = layers.map(layer => {
    const preferred = Math.max(18, Math.min(32, Math.floor((viewport - gap * (layer.length - 1)) / layer.length)))
    for (const node of layer) nodeWidths[node] = Math.max(preferred, 2 * Math.max(ins[node].length, outs[node].length) + 3)
    return layer.reduce((sum, node) => sum + nodeWidths[node], 0) + gap * (layer.length - 1)
  })
  const boxAreaWidth = Math.max(...rowWidths)
  // Each gap has one horizontal track per adjacent edge or long-edge endpoint.
  const tracks = layers.slice(1).map(() => [] as { edge: number; end: boolean }[])
  const lanes = new Map<number, number>()
  drawable.forEach(({ from, to }, edge) => {
    tracks[rank[from]].push({ edge, end: false })
    if (rank[to] > rank[from] + 1) {
      lanes.set(edge, boxAreaWidth + 2 + lanes.size * 2)
      tracks[rank[to] - 1].push({ edge, end: true })
    }
  })
  const nodeHeights = unique.map((task, i) => Bun.stringWidth(task.title) > nodeWidths[i] - 4 ? 5 : 4)
  const rowHeights = layers.map(layer => Math.max(...layer.map(node => nodeHeights[node])))
  const rowY = [0]
  // Keep arrivals on a separate row: the final horizontal track must never
  // replace an arrowhead with a corner. Source stubs start at the box border.
  for (let r = 1; r < layers.length; r++) rowY[r] = rowY[r - 1] + rowHeights[r - 1] + tracks[r - 1].length + 1
  const nodes: TaskGraphLayout["nodes"] = unique.map((task, i) => ({ task, x: 0, y: 0, width: 0, height: nodeHeights[i] }))
  layers.forEach((layer, r) => {
    let x = Math.floor((boxAreaWidth - rowWidths[r]) / 2)
    for (const i of layer) {
      Object.assign(nodes[i], { x, y: rowY[r], width: nodeWidths[i] })
      x += nodeWidths[i] + gap
    }
  })
  // Outgoing ports use odd columns, incoming even: unrelated vertical
  // segments can cross, but can never overlap and falsely merge.
  const port = (node: number, edge: number, source: boolean) => {
    const list = source ? outs[node] : ins[node]
    const box = nodes[node]
    let start = box.x + Math.floor((box.width - (2 * list.length - 1)) / 2)
    if (start % 2 !== (source ? 1 : 0)) start++
    return start + 2 * list.indexOf(edge)
  }
  const trackY = new Map<string, number>()
  tracks.forEach((list, r) => list.forEach(({ edge, end }, i) => {
    trackY.set(`${edge}:${end}`, rowY[r] + rowHeights[r] + i)
  }))
  const canvasWidth = lanes.size ? boxAreaWidth + 2 * lanes.size + 1 : boxAreaWidth
  const height = rowY[rowY.length - 1] + rowHeights[rowHeights.length - 1]
  // Directions: north=1 east=2 south=4 west=8. Retain edge ownership so a
  // crossover is distinguished from a bend, rather than manufacturing joins.
  const cells = new Map<number, Map<number, number>>()
  const arrows = new Set<number>()
  const mark = (x: number, y: number, edge: number, direction: number) => {
    const key = y * canvasWidth + x
    let cell = cells.get(key)
    if (!cell) { cell = new Map(); cells.set(key, cell) }
    cell.set(edge, (cell.get(edge) ?? 0) | direction)
  }
  const segment = (ax: number, ay: number, bx: number, by: number, edge: number) => {
    const dx = Math.sign(bx - ax), dy = Math.sign(by - ay)
    const direction = dx > 0 ? 2 : dx < 0 ? 8 : dy > 0 ? 4 : 1
    const opposite = dx > 0 ? 8 : dx < 0 ? 2 : dy > 0 ? 1 : 4
    while (ax !== bx || ay !== by) {
      mark(ax, ay, edge, direction)
      ax += dx; ay += dy
      mark(ax, ay, edge, opposite)
    }
  }
  drawable.forEach(({ from, to }, edge) => {
    const sx = port(from, edge, true), tx = port(to, edge, false)
    const sy = nodes[from].y + nodes[from].height, ty = nodes[to].y - 1
    const firstY = trackY.get(`${edge}:false`)!
    mark(sx, sy, edge, 1)
    mark(tx, ty, edge, 4)
    segment(sx, sy, sx, firstY, edge)
    const lane = lanes.get(edge)
    if (lane === undefined) {
      segment(sx, firstY, tx, firstY, edge)
      segment(tx, firstY, tx, ty, edge)
    } else {
      const lastY = trackY.get(`${edge}:true`)!
      segment(sx, firstY, lane, firstY, edge)
      segment(lane, firstY, lane, lastY, edge)
      segment(lane, lastY, tx, lastY, edge)
      segment(tx, lastY, tx, ty, edge)
    }
    arrows.add(ty * canvasWidth + tx)
  })
  const glyphs: Record<number, string> = { 1: "│", 2: "─", 4: "│", 8: "─", 5: "│", 10: "─", 3: "└", 6: "┌", 9: "┘", 12: "┐" }
  let crossed = false
  const lines = Array.from({ length: height }, (_, y) => Array.from({ length: canvasWidth }, (_, x) => {
    const key = y * canvasWidth + x
    const cell = cells.get(key)
    if (!cell) return " "
    if (cell.size > 1) { crossed = true; return "╪" }
    const directions = cell.values().next().value!
    if (arrows.has(key) && directions === 5) return "▼"
    return glyphs[directions] ?? "│"
  }).join(""))
  if (crossed) warnings.push("╪ is a crossover: horizontal and vertical edges do not connect.")
  return { width: canvasWidth, height, nodes, lines, warnings }
}
