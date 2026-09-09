import { describe, expect, it } from "bun:test";
import { sortMCPToolsByName } from "@oh-my-pi/pi-coding-agent/mcp/manager";

// `sortMCPToolsByName` is the cache-stability invariant: Anthropic prompt caching
// keys on byte-identical tool definitions, so the tools array sent to the API
// must be byte-stable across MCP server connect / reconnect / refresh cycles.
// These tests defend that invariant directly because the production call sites
// (initial discovery and `#replaceServerTools`) are heavy to exercise without
// mock transports.

describe("sortMCPToolsByName", () => {
	it("orders tools lexicographically by name", () => {
		const tools = [
			{ name: "mcp__nucleus_searchCode" },
			{ name: "mcp__glean_chat" },
			{ name: "mcp__atlassian_get_issue" },
		];
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.name)).toEqual([
			"mcp__atlassian_get_issue",
			"mcp__glean_chat",
			"mcp__nucleus_searchCode",
		]);
	});

	it("produces identical output regardless of insertion order", () => {
		// Simulates the multi-server reconnect bug: depending on which MCP server
		// reconnected most recently, the same set of tools could land in different
		// orders in `#tools`. After sorting, the array bytes are identical.
		const orderA = sortMCPToolsByName([
			{ name: "mcp__nucleus_a" },
			{ name: "mcp__nucleus_b" },
			{ name: "mcp__glean_x" },
			{ name: "mcp__glean_y" },
		]);
		const orderB = sortMCPToolsByName([
			{ name: "mcp__glean_x" },
			{ name: "mcp__glean_y" },
			{ name: "mcp__nucleus_a" },
			{ name: "mcp__nucleus_b" },
		]);
		expect(orderA.map(t => t.name)).toEqual(orderB.map(t => t.name));
	});

	it("mutates the input array in place and returns the same reference", () => {
		const tools = [{ name: "b" }, { name: "a" }];
		const result = sortMCPToolsByName(tools);
		expect(result).toBe(tools);
		expect(tools.map(t => t.name)).toEqual(["a", "b"]);
	});

	it("preserves total order under repeated sorts", () => {
		// Reconnects re-sort an already-sorted array. The output must be byte-stable
		// across repeated sorts so the tools cache breakpoint keeps hitting; ES2019+
		// guarantees a stable sort, and MCP tool names are globally unique within a
		// session, so the comparator's strict total order yields one canonical result.
		const tools = sortMCPToolsByName([{ name: "c" }, { name: "a" }, { name: "b" }]);
		const before = tools.map(t => t.name);
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.name)).toEqual(before);
	});

	it("handles empty arrays and single-element arrays", () => {
		expect(sortMCPToolsByName([])).toEqual([]);
		expect(sortMCPToolsByName([{ name: "only" }]).map(t => t.name)).toEqual(["only"]);
	});
});
