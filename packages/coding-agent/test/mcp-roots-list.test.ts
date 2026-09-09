import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
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

describe("message classification", () => {
	// Specification test: pins the expected JSON-RPC message classification rules.
	// Does not exercise the actual transport methods — changes to #handleMessage
	// won't fail this test. Tests the contract shape, not the wiring.

	function classify(message: Record<string, unknown>): "request" | "response" | "notification" | "unknown" {
		// Mirrors the classification in StdioTransport.#handleMessage
		if ("method" in message && "id" in message && message.id != null) return "request";
		if ("id" in message && message.id != null) return "response";
		if ("method" in message) return "notification";
		return "unknown";
	}

	it("classifies server request (method + id)", () => {
		expect(classify({ jsonrpc: "2.0", method: "roots/list", id: 1 })).toBe("request");
		expect(classify({ jsonrpc: "2.0", method: "roots/list", id: "abc" })).toBe("request");
		expect(classify({ jsonrpc: "2.0", method: "roots/list", id: 0 })).toBe("request");
	});

	it("classifies response (id, no method)", () => {
		expect(classify({ jsonrpc: "2.0", id: 1, result: {} })).toBe("response");
		expect(classify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } })).toBe("response");
		expect(classify({ jsonrpc: "2.0", id: 0, result: {} })).toBe("response");
	});

	it("classifies notification (method, no id)", () => {
		expect(classify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe("notification");
	});

	it("treats id:null as notification, not request", () => {
		// Per JSON-RPC 2.0 spec, id MUST NOT be null in requests
		expect(classify({ jsonrpc: "2.0", method: "roots/list", id: null })).toBe("notification");
	});

	it("classifies message without id key as notification", () => {
		// When id key is absent entirely (vs present with null value)
		expect(classify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} })).toBe("notification");
	});

	it("classifies message with neither method nor id as unknown", () => {
		expect(classify({ jsonrpc: "2.0" })).toBe("unknown");
	});
});

describe("roots response shape", () => {
	// Specification test: pins the MCP roots/list response shape.
	// Does not exercise MCPManager.#getRoots — tests the contract, not the wiring.

	function getRoots(cwd: string): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(cwd).href,
					name: path.basename(cwd),
				},
			],
		};
	}

	it("returns a single root with file:// URI and directory name", () => {
		const result = getRoots("/home/user/project");
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].uri).toStartWith("file:///");
		expect(result.roots[0].name).toBe("project");
	});

	it("handles paths with spaces", () => {
		const result = getRoots("/home/user/my project");
		expect(result.roots[0].uri).toContain("my%20project");
		expect(result.roots[0].name).toBe("my project");
	});
});
