import {expect,test} from "bun:test"
import {chooseProject,taskGate} from "../src/goals"
test("ready is not done; count all unfinished tasks",()=>{
  expect(taskGate([{status:"open",ready:false},{status:"in_progress",ready:false},{status:"closed"}])).toEqual({open:1,inProgress:1,remaining:2,passed:false})
  expect(taskGate([{status:"closed"}]).passed).toBe(true);expect(()=>taskGate(null)).toThrow();expect(()=>taskGate([{status:"typo"}])).toThrow()
})
test("select one project without silent expansion or arbitrary paths",()=>{
  expect(chooseProject(["projects/a","projects/b"],"projects/b")).toBe("projects/b")
  expect(chooseProject(["projects/a"],null)).toBe("projects/a")
  expect(()=>chooseProject(["projects/a","projects/b"],null)).toThrow()
  expect(()=>chooseProject(["projects/a"],null,"projects/elsewhere")).toThrow()
})
