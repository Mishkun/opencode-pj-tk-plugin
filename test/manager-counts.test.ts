import { expect, test } from "bun:test"
import { idleSummary, remindBeforeIdle, type IdleMemo } from "../src/manager-counts"
import { listResult, project, task } from "./fixtures"
const snapshot=(tasks:ReturnType<typeof task>[])=>JSON.stringify(listResult([project("projects/P",{tasks})]))
test("remaining is project-wide; available excludes dependency, active, closed and foreign claim",()=>{
  const s=idleSummary(snapshot([task(),task({id:"free",claimed_by_sessions:[]}),task({ready:false}),
    task({status:"in_progress"}),task({claimed_by_sessions:["ses_other"]}),task({status:"closed"})]),"ses_A")
  expect(s?.text).toContain("всего 5; готовы к старту и доступны этой сессии: 2 (p-1234, free)")
  expect(idleSummary(snapshot([task({ready:false}),task({status:"in_progress"})]),"ses_A")).toBeNull()
  expect(()=>idleSummary("{}", "ses_A")).toThrow()
})
test("one continuation, unchanged count quiet, zero re-arms; no retry after uncertain send",async()=>{
  let memo:IdleMemo|null=null, calls=0
  const run=(n:number,at:number,fail=false)=>remindBeforeIdle("ses_A",at,async()=>snapshot(Array.from({length:n},(_,i)=>task({id:`p-${i}`}))),
    async()=>memo,async m=>{memo=m},async()=>{calls++;if(fail)throw Error("uncertain")})
  await run(2,1);await run(2,1);await run(1,1);expect(calls).toBe(1)
  await run(2,2);expect(calls).toBe(1)
  await run(1,3);await run(0,4);expect(calls).toBe(2)
  await expect(run(1,5,true)).rejects.toThrow()
  await run(1,6);expect(calls).toBe(3)
})
