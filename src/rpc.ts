import { Rpc } from "@opencode/plugin/rpc"
import { record } from "./contract"

const string = { type: "string", minLength: 1 } as const
const sessionID = { type: "string", minLength: 5, maxLength: 128 } as const
const object = { type: "object", additionalProperties: true } as const
/** Runtime validation also protects direct handler calls in supporting tests.
 * SID fields describe data targets inside operation; none selects authority. */
export function hostRpcInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = record(value)
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw new Error("Invalid HOST RPC fields; actorSessionID is not an authority input")
  return input
}
// HOST capability exposed through OpenCode's authenticated client/RPC boundary.
export const WorkspaceRPC = Rpc.define({
  id: "pj.workspace",
  methods: {
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: object,
    },
    operate: {
      input: { type: "object", properties: { project: string, operation: object }, required: ["project", "operation"], additionalProperties: false },
      output: object,
    },
  },
  events: {
    changed: { schema: { type: "object", properties: {}, additionalProperties: false } },
    forkResult: { schema: { type: "object", properties: { sessionID, source: sessionID, status: string, error: string }, required: ["sessionID", "source", "status"], additionalProperties: false } },
  },
})
