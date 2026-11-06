import { expect, test } from "bun:test"
import { projectTree, taskTree } from "../src/projection"
import { project, task } from "./fixtures"

test("projects retain folder ancestry and all current-session relationships", () => {
  const projects = [project("projects/P"), project("projects/Q"), project("projects/P/Child", { parent: "projects/P" }), project("projects/Q/Child", { parent: "projects/Q" }), project(".archived/P", { status: "blocked" })]
  const tree = projectTree(projects, "ses_A")
  expect(tree.map(n => n.project.path)).toEqual(["projects/P", "projects/Q"])
  expect(tree.filter(n => n.related)).toHaveLength(2)
  expect(tree[0].children[0].project.path).toBe("projects/P/Child")
  expect(tree[1].children[0].project.path).toBe("projects/Q/Child")
  expect(projects[4].status).toBe("blocked")
})
test("task grouping distinguishes parentage, dependencies, closed state, project status", () => {
  const tasks = [task({ id: "T", status: "closed" }), task({ id: "U", deps: ["T"], ready: true }), task({ id: "C", parent: "U", ready: false })]
  const p = project("projects/P", { status: "waiting", tasks })
  expect(taskTree(p.tasks.filter(t => t.status !== "closed"))[0].children[0].task.id).toBe("C")
  expect(p.tasks.find(t => t.id === "U")?.status).toBe("open")
  expect(p.status).toBe("waiting")
  expect(p.tasks.filter(t => t.status === "closed").map(t => t.id)).toEqual(["T"])
  expect(p.tasks[0].body).toContain("- [ ] Check result")
})
test("malformed parent cycles stay finite and visible", () => {
  expect(taskTree([task({ id: "A", parent: "B" }), task({ id: "B", parent: "A" })])).toHaveLength(2)
  expect(projectTree([project("projects/P", { parent: "projects/P/Child" }), project("projects/P/Child", { parent: "projects/P" })], "ses_A")).toHaveLength(1)
})
