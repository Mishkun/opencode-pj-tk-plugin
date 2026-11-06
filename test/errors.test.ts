import { expect, test } from "bun:test"
import { errorMessage } from "../src/contract"

test("RPC errors show their declared type and message instead of object coercion", () => {
  const error = { _tag: "RpcError", type: "authority_unavailable", message: "Project view is unavailable.", data: { private: "must not be printed" } }
  expect(errorMessage(error)).toBe("authority_unavailable: Project view is unavailable.")
  expect(errorMessage(error)).not.toContain("[object Object]")
  expect(errorMessage(error)).not.toContain("must not be printed")
})
test("native errors, strings and malformed responses have bounded readable messages", () => {
  expect(errorMessage(new Error("Stopped"))).toBe("Stopped")
  expect(errorMessage("Stopped")).toBe("Stopped")
  expect(errorMessage({ code: "permission_boundary_unavailable", message: "permission_boundary_unavailable: blocked" })).toBe("permission_boundary_unavailable: blocked")
  expect(errorMessage({ data: { private: "secret" } })).toBe("Project operation failed; no readable error was provided.")
  expect(errorMessage({ message: "x".repeat(5000) })).toHaveLength(2000)
})
