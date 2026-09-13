import { describe, expect, it } from "bun:test";
import { parseSSE } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";

describe("parseSSE", () => {
	it("skips non-JSON data lines (keep-alives) and returns the first JSON payload", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("returns null when nothing parses", () => {
		expect(parseSSE("data: ping\nnot json either")).toBeNull();
	});
});
