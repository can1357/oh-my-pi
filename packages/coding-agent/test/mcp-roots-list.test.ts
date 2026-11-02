import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "@oh-my-pi/pi-coding-agent/mcp/types";

describe("toJsonRpcError", () => {
	it("extracts code from Error with .code property", () => {
		const err = Object.assign(new Error("not found"), { code: -32601 });
		const result = toJsonRpcError(err);
		expect(result).toEqual({ code: -32601, message: "not found" });
	});

	it("defaults to -32603 when Error has no code", () => {
		const result = toJsonRpcError(new Error("boom"));
		expect(result).toEqual({ code: -32603, message: "boom" });
	});

	it("handles non-Error values", () => {
		const result = toJsonRpcError("string error");
		expect(result).toEqual({ code: -32603, message: "Internal error" });
	});

	it("ignores non-numeric code", () => {
		const err = Object.assign(new Error("bad"), { code: "ENOENT" });
		expect(toJsonRpcError(err).code).toBe(-32603);
	});

	it("preserves code and message from plain objects", () => {
		const result = toJsonRpcError({ code: -32601, message: "Method not found" });
		expect(result).toEqual({ code: -32601, message: "Method not found" });
	});

	it("falls back for plain objects missing code or message", () => {
		expect(toJsonRpcError({ code: 42 })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError({ message: "hi" })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(null)).toEqual({ code: -32603, message: "Internal error" });
	});
});
