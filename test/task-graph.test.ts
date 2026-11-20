import { describe, expect, test } from "bun:test"
import type { Task } from "../src/contract"
import { layoutTaskGraph, type TaskGraphLayout } from "../src/task-graph"

const task = (id: string, deps: string[] = [], title = id): Task => ({
  id, deps, title, status: "open", parent: null, links: [], claimed_by_sessions: [],
  ready: !deps.length, body: "", path: `.tickets/${id}.md`,
})
const box = (graph: TaskGraphLayout, id: string) => graph.nodes.find(n => n.task.id === id)!

function geometry(graph: TaskGraphLayout) {
  expect(graph.lines.length).toBe(graph.height)
  for (const line of graph.lines) {
    expect(line.length).toBe(graph.width)
    expect(line).toMatch(/^[ │─└┌┘┐╪▼]*$/)
  }
  for (const node of graph.nodes) {
    expect(node.x).toBeGreaterThanOrEqual(0)
    expect(node.x + node.width).toBeLessThanOrEqual(graph.width)
    expect(node.y + node.height).toBeLessThanOrEqual(graph.height)
    expect([4, 5]).toContain(node.height)
    for (let y = node.y; y < node.y + node.height; y++) {
      expect(graph.lines[y].slice(node.x, node.x + node.width)).toBe(" ".repeat(node.width))
    }
    for (const other of graph.nodes) {
      if (other === node) continue
      expect(node.x + node.width <= other.x || other.x + other.width <= node.x ||
        node.y + node.height <= other.y || other.y + other.height <= node.y).toBe(true)
    }
  }
}

// Follow each source port, keeping direction at ╪. This checks actual edge
// identity, including absence of false branches, rather than just arrow counts.
function drawnEdges(graph: TaskGraphLayout): string[] {
  const result: string[] = []
  const directions: Record<string, number[][]> = {
    "│": [[0, -1], [0, 1]], "─": [[-1, 0], [1, 0]],
    "└": [[0, -1], [1, 0]], "┌": [[1, 0], [0, 1]],
    "┘": [[0, -1], [-1, 0]], "┐": [[-1, 0], [0, 1]],
  }
  for (const source of graph.nodes) {
    const y0 = source.y + source.height
    for (let x0 = source.x + 1; x0 < source.x + source.width - 1; x0++) {
      if (!["│", "└", "┘", "╪", "▼"].includes(graph.lines[y0]?.[x0] ?? "")) continue
      let x = x0, y = y0, dx = 0, dy = 1
      let reached = false
      for (let step = 0; step < graph.width * graph.height * 2; step++) {
        const char = graph.lines[y]?.[x]
        if (char === "▼") { dx = 0; dy = 1 }
        else if (char !== "╪") {
          const next = directions[char!]?.filter(([nx, ny]) => nx !== -dx || ny !== -dy)
          expect(next?.length).toBe(1)
          ;[dx, dy] = next![0]
        }
        if (dy === 1) {
          const target = graph.nodes.find(n => n.y === y + 1 && x > n.x && x < n.x + n.width - 1)
          if (target) {
            result.push(`${source.task.id}->${target.task.id}`)
            reached = true
            break
          }
        }
        x += dx; y += dy
      }
      expect(reached).toBe(true)
    }
  }
  return result.sort()
}

describe("layoutTaskGraph", () => {
  test("empty input and isolated nodes have no invented connectors", () => {
    expect(layoutTaskGraph([], 65)).toEqual({ width: 0, height: 0, nodes: [], lines: [], warnings: [] })
    const graph = layoutTaskGraph([{ ...task("A"), parent: "B", links: ["B"] }, task("B")], 65)
    geometry(graph)
    expect(graph.lines.every(line => !line.trim())).toBe(true)
  })

  test("chain is top to bottom regardless of input order", () => {
    const graph = layoutTaskGraph([task("C", ["B"]), task("A"), task("B", ["A"])], 65)
    geometry(graph)
    expect(box(graph, "A").y).toBeLessThan(box(graph, "B").y)
    expect(box(graph, "B").y).toBeLessThan(box(graph, "C").y)
    expect(drawnEdges(graph)).toEqual(["A->B", "B->C"])
    expect(graph.width).toBeLessThanOrEqual(65)
  })

  test("diamond preserves fork and join and deduplicates dependency declarations", () => {
    const tasks = [task("A"), task("B", ["A", "A"]), task("C", ["A"]), task("D", ["B", "C", "B"])]
    const graph = layoutTaskGraph(tasks, 60)
    geometry(graph)
    expect(box(graph, "B").y).toBe(box(graph, "C").y)
    expect(drawnEdges(graph)).toEqual(["A->B", "A->C", "B->D", "C->D"])
    expect(graph.width).toBeLessThanOrEqual(60)
    expect(graph.height).toBe(18)
    expect(graph.lines.join("").match(/▼/g)).toHaveLength(4)
    expect(graph).toEqual(layoutTaskGraph(tasks, 60))
  })

  test("crossed fan-in/out does not manufacture extra edges", () => {
    const graph = layoutTaskGraph([
      task("A"), task("B"), task("C"), task("D", ["A", "B"]),
      task("E", ["B", "C"]), task("F", ["A", "C"]),
    ], 75)
    geometry(graph)
    expect(drawnEdges(graph)).toEqual(["A->D", "A->F", "B->D", "B->E", "C->E", "C->F"])
    expect(graph.width).toBeLessThanOrEqual(75)
    expect(graph.warnings.some(w => w.includes("crossover"))).toBe(true)
  })

  test("long edges bypass intervening nodes without dropping transitive edges", () => {
    const graph = layoutTaskGraph([
      task("A"), task("B", ["A"]), task("C", ["B", "A"]), task("D", ["C", "A", "B"]),
    ], 60)
    geometry(graph)
    expect(drawnEdges(graph)).toEqual(["A->B", "A->C", "A->D", "B->C", "B->D", "C->D"])
  })

  test("cycles and missing dependencies are explicit; valid surrounding edges remain", () => {
    const graph = layoutTaskGraph([
      task("root"), task("A", ["B", "root"]), task("B", ["A"]),
      task("end", ["B", "missing"]), task("self", ["self"]),
    ], 65)
    geometry(graph)
    expect(drawnEdges(graph)).toEqual(["B->end", "root->A"])
    expect(graph.warnings).toContain("Cycle edge not drawn: B → A.")
    expect(graph.warnings).toContain("Cycle edge not drawn: A → B.")
    expect(graph.warnings).toContain("Cycle edge not drawn: self → self.")
    expect(graph.warnings).toContain("Missing prerequisite: missing → end.")
    expect(graph.nodes).toHaveLength(5)
  })

  test("wide layers and high degrees expand scrollable geometry, not clip edges", () => {
    const leaves = Array.from({ length: 12 }, (_, i) => task(`leaf${i}`, ["root"]))
    const graph = layoutTaskGraph([task("root"), ...leaves, task("join", leaves.map(t => t.id))], 60)
    geometry(graph)
    expect(graph.width).toBeGreaterThan(60)
    expect(drawnEdges(graph)).toEqual([
      ...leaves.map(t => `root->${t.id}`), ...leaves.map(t => `${t.id}->join`),
    ].sort())
  })

  test("reserves two title rows, tolerates invalid viewport widths, and does not mutate tasks", () => {
    const tasks = [task("A", [], "Большая задача с длинным названием ".repeat(5)), task("B", ["A"])]
    const before = JSON.stringify(tasks)
    for (const width of [0, -10, 1, 60.5, NaN, Infinity]) {
      const graph = layoutTaskGraph(tasks, width)
      geometry(graph)
      expect(box(graph, "A").height).toBe(5)
      expect(drawnEdges(graph)).toEqual(["A->B"])
    }
    expect(JSON.stringify(tasks)).toBe(before)
  })

  test("duplicate IDs are reported instead of silently conflated", () => {
    const graph = layoutTaskGraph([task("A"), task("A", ["B"]), task("B")], 60)
    geometry(graph)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.warnings).toContain("Duplicate task ID ignored: A (first record retained).")
  })

  test("title height measures terminal cells with border and horizontal padding", () => {
    // A solitary node is 32 cells wide, leaving 28 cells for padded text.
    expect(box(layoutTaskGraph([task("A", [], "a".repeat(28))], 60), "A").height).toBe(4)
    expect(box(layoutTaskGraph([task("A", [], "a".repeat(29))], 60), "A").height).toBe(5)
    expect(box(layoutTaskGraph([task("A", [], "界".repeat(14))], 60), "A").height).toBe(4)
    expect(box(layoutTaskGraph([task("A", [], "界".repeat(15))], 60), "A").height).toBe(5)
    expect(box(layoutTaskGraph([task("A", [], "e\u0301".repeat(28))], 60), "A").height).toBe(4)
  })

  test("deterministic generated DAGs preserve every exact dependency", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i}`,
        Array.from({ length: i }, (_, j) => j).filter(j => (seed * (j + 3) + i * 7 + j * i) % 5 < 2).map(j => `t${j}`)))
      const graph = layoutTaskGraph(tasks, 65)
      geometry(graph)
      const expectedCount = tasks.reduce((count, task) => count + task.deps.length, 0)
      expect(graph.lines.join("").match(/▼/g)?.length ?? 0).toBe(expectedCount)
      for (let y = 0; y < graph.height; y++) {
        for (let x = 0; x < graph.width; x++) {
          if (graph.lines[y][x] !== "▼") continue
          expect(graph.nodes.some(n => n.y === y + 1 && x > n.x && x < n.x + n.width - 1)).toBe(true)
        }
      }
      expect(drawnEdges(graph)).toEqual(tasks.flatMap(t => t.deps.map(dep => `${dep}->${t.id}`)).sort())
    }
  })
})
