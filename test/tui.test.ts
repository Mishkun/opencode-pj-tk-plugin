import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "solid-js"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { project, session, task } from "./fixtures"

ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const { RGBA, TextAttributes } = await import("@opentui/core")
const { default: plugin } = await import("../src/tui")

async function sidebar() {
  const dialogs: { title: string; options: { title: string; value: string }[] }[] = []
  const focused: string[] = [], navigated: unknown[] = [], operations: unknown[] = []
  let snapshots = 0
  const native = [session("ses_A", { title: "Current session" }), session("ses_B", { title: "Other session" }), session("ses_C", { title: "Child session" })]
  const projects = [
    project("projects/P", { name: "Parent project", sessions: [{ id: "ses_A", title: "Current session" }, { id: "ses_B", title: "Other session" }], tasks: [task({ claimed_by_sessions: [] }), task({ id: "p-done", title: "Finished task", status: "closed", claimed_by_sessions: [] })] }),
    project("projects/P/Child", { name: "Child project", parent: "projects/P", sessions: [{ id: "ses_C", title: "Child session" }], tasks: [] }),
  ]
  const base = RGBA.fromHex("#eeeeee"), muted = RGBA.fromHex("#888888")
  let render!: () => JSX.Element
  const ctx = {
    location: { directory: "/vault/projects/P" },
    theme: { text: { base, muted } },
    client: {
      rpc: () => ({ snapshot: async () => { snapshots++; return { projects, vaultRoot: "/vault", complete: true } }, operate: async (input: unknown) => { operations.push(input) }, events: { on: () => () => {} } }),
      session: { list: async () => ({ data: native, cursor: {} }) },
    },
    data: { on: () => () => {}, session: { get: (id: string) => native.find(s => s.id === id) } },
    ui: {
      slot: (slot: { render: (input: { sessionID: string }) => JSX.Element }) => { render = () => slot.render({ sessionID: "ses_A" }); return () => {} },
      dialog: { select: async (input: typeof dialogs[number]) => { dialogs.push(input) } },
      toast: { show: () => {} },
      tabs: { enabled: () => true, focus: (id: string) => { focused.push(id) } },
      router: { navigate: (input: unknown) => { navigated.push(input) } },
    },
  } as unknown as Context
  await plugin.setup(ctx)
  const view = await testRender(() => render(), { width: 48, height: 28 })
  await view.waitForFrame(frame => frame.includes("Parent project"))
  const lines = () => view.captureCharFrame().split("\n")
  const position = (label: string) => {
    const y = lines().findIndex(line => line.includes(label))
    if (y < 0) throw new Error(`Missing rendered label: ${label}`)
    return { x: lines()[y].indexOf(label), y }
  }
  const click = async (label: string, offset = 0) => {
    const { x, y } = position(label)
    await view.mockMouse.click(x + offset, y)
    await view.flush()
  }
  const span = (label: string) => {
    const { x, y } = position(label)
    let column = 0
    for (const span of view.captureSpans().lines[y].spans) {
      column += span.width
      if (column > x) return span
    }
    throw new Error(`Missing rendered span: ${label}`)
  }
  return { ...view, ctx, lines, position, click, span, dialogs, focused, navigated, operations, base, muted, snapshots: () => snapshots }
}

test("sidebar compacts headings and keeps project/session hierarchy", async () => {
  await using view = await sidebar()
  const lines = view.lines().map(line => line.trimEnd())
  expect(lines[0]).toBe(`Projects${" ".repeat(38)}↻`)
  expect(lines).not.toContain("Refresh")
  expect(lines.some(line => line.trim() === "Actions" || line.trim() === "Sessions")).toBe(false)
  expect(lines).toContain("▾ Parent project · in-progress")
  expect(lines).toContain("  • Current session")
  expect(lines).toContain("  Other session")
  expect(lines).toContain("  ▾ Child project · in-progress")
  expect(lines).toContain("    Child session")
  expect(lines).toContain("  Work · open · ready")
  expect(lines).toContain("  ▸ Completed (1)")
})

test("triangle only toggles; project label only opens the existing actions menu", async () => {
  await using view = await sidebar()
  await view.click("▾ Parent project")
  expect(view.lines().some(line => line.includes("Current session"))).toBe(false)
  expect(view.dialogs).toHaveLength(0)
  await view.click("Parent project")
  expect(view.dialogs).toHaveLength(1)
  expect(view.dialogs[0]).toMatchObject({ title: "projects/P" })
  expect(view.dialogs[0].options.map(option => option.value)).toEqual(["context", "log", "create", "link", "status", "archive"])
  expect(view.lines().some(line => line.includes("▸ Parent project"))).toBe(true)
  await view.click("▸ Parent project")
  expect(view.lines().some(line => line.includes("• Current session"))).toBe(true)
  expect(view.dialogs).toHaveLength(1)
  await view.click("in-progress")
  expect(view.dialogs).toHaveLength(2)
  expect(view.lines().some(line => line.includes("▾ Parent project"))).toBe(true)
  expect(view.operations).toEqual([])
})

test("inline refresh has its own hit zone with a scrollbar gutter", async () => {
  await using view = await sidebar()
  expect(view.snapshots()).toBe(1)
  await view.click("Projects")
  expect(view.snapshots()).toBe(1)
  await view.click("↻")
  await view.waitForFrame(frame => frame.includes("Parent project"))
  expect(view.snapshots()).toBe(2)
  expect(view.dialogs).toHaveLength(0)
  view.resize(24, 28)
  await view.flush()
  expect(view.position("↻")).toEqual({ x: 22, y: 0 })
  expect(view.position("Parent project").x).toBe(2)
  expect(view.position("Child project").x).toBe(4)
})

test("project name is bold, status/sessions regular, and each button hovers independently", async () => {
  await using view = await sidebar()
  expect(view.span("Parent project").attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
  for (const label of ["in-progress", "Current session", "Other session"]) expect(view.span(label).attributes & TextAttributes.BOLD).toBe(0)
  expect(view.span("Parent project").fg).toEqual(view.muted)
  const originalBackground = view.span("Parent project").bg
  const { x, y } = view.position("Parent project")
  await view.mockMouse.moveTo(x, y)
  await view.flush()
  expect(view.span("Parent project").fg).toEqual(view.base)
  expect(view.span("Parent project").bg).toEqual(originalBackground)
  expect(view.span("in-progress").fg).toEqual(view.muted)
  expect(view.span("▾ Parent project").fg).toEqual(view.muted)
  await view.mockMouse.moveTo(0, y)
  await view.flush()
  expect(view.span("▾ Parent project").fg).toEqual(view.base)
  expect(view.span("Parent project").fg).toEqual(view.muted)
  await view.mockMouse.moveTo(47, y)
  await view.flush()
  expect(view.span("Parent project").fg).toEqual(view.base)
  expect(view.span("▾ Parent project").fg).toEqual(view.muted)
  const refresh = view.position("↻")
  await view.mockMouse.moveTo(refresh.x, refresh.y)
  await view.flush()
  expect(view.span("↻").fg).toEqual(view.base)
  await view.mockMouse.moveTo(0, 25)
  await view.flush()
  expect(view.span("↻").fg).toEqual(view.muted)
})

test("completed/nested/session clicks and cancelled clicks keep their existing semantics", async () => {
  await using view = await sidebar()
  await view.click("Completed (1)")
  expect(view.lines().some(line => line.trimEnd() === "    Finished task · closed")).toBe(true)
  await view.click("▾ Child project")
  expect(view.lines().some(line => line.includes("Child session"))).toBe(false)
  expect(view.lines().some(line => line.includes("• Current session"))).toBe(true)
  expect(view.dialogs).toHaveLength(0)
  await view.click("Other session")
  expect(view.focused).toEqual(["ses_B"])
  view.ctx.ui.tabs.enabled = () => false
  await view.click("• Current session")
  expect(view.navigated).toEqual([{ type: "session", sessionID: "ses_A" }])
  const name = view.position("Parent project")
  await view.mockMouse.click(name.x, name.y, 2)
  await view.mockMouse.drag(name.x, name.y, 0, 25)
  await view.mockMouse.pressDown(0, name.y)
  await view.mockMouse.release(name.x, name.y)
  await view.flush()
  expect(view.dialogs).toHaveLength(0)
  expect(view.lines().some(line => line.includes("▾ Parent project"))).toBe(true)
  await view.click("Work · open")
  expect(view.dialogs[0]).toMatchObject({ title: "p-1234: Work" })
  expect(view.dialogs[0].options.map(option => option.value)).toEqual(["read", "start", "close", "claim", "note"])
})
