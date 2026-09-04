/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`).
 *
 * Contracts defended here:
 * - Deny subtracts from allow, deny wins when both sides are set — mirroring
 *   the server-level `disabledServers` > `enabledServers` pair.
 * - Entries are matched against RAW server-advertised names via picomatch,
 *   with `dot: true` because tool names are opaque strings, not paths.
 * - Unknown entries are surfaced in `unmatched` (a typo is loud), and a
 *   filter that excludes every advertised tool reports `filterEmpty`.
 * - Literal entries never go through the matcher, so a tool name containing
 *   glob metacharacters still matches its literal spelling.
 * - applyMCPToolFilter filters MCPToolDefinition[] while preserving schema,
 *   description, annotations, and original ordering.
 */
import { expect, test } from "bun:test";
import { applyMCPToolFilter, filterMCPTools, mcpToolFilterKey } from "../../src/mcp/tool-filter";
import type { MCPToolDefinition } from "../../src/mcp/types";

const NAMES = ["search", "read_channel", "send_message", "create_doc", "admin/delete"];

function run(toolNames: string[], enabledTools?: string[], disabledTools?: string[]) {
	return filterMCPTools({ toolNames, enabledTools, disabledTools });
}

test("allowlist keeps only matching tools in advertised order", () => {
	const result = run(NAMES, ["read_channel", "send_*"]);
	expect(result.allowed).toEqual(["read_channel", "send_message"]);
	expect(result.unmatched).toEqual([]);
	expect(result.filterEmpty).toBe(false);
});

test("wildcards cross slashes: tool names are opaque, not paths", () => {
	expect(run(NAMES, ["*"]).allowed).toEqual(NAMES);
	expect(run(NAMES, ["admin*"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["admin/*"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["a?min/delete"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["other/*"]).allowed).toEqual([]);
});

test("denylist subtracts from allowlist when both are set", () => {
	const result = run(NAMES, ["read_channel", "send_message", "search"], ["send_*"]);
	expect(result.allowed).toEqual(["search", "read_channel"]);
});

test("denied entry that matches nothing is still reported as unmatched", () => {
	const result = run(NAMES, undefined, ["zzz_typo"]);
	expect(result.allowed).toEqual(NAMES);
	expect(result.unmatched).toEqual(["zzz_typo"]);
});

test("glob metacharacters: star, question, brace alternation", () => {
	expect(run(NAMES, ["*_message"]).allowed).toEqual(["send_message"]);
	expect(run(NAMES, ["read_???nnel"]).allowed).toEqual(["read_channel"]);
	expect(run(NAMES, ["{search,send_message}"]).allowed).toEqual(["search", "send_message"]);
	// A brace token that is itself a tool name still only matches its exact
	// spelling — braces expand alternatives, so `{delete}` matches neither
	// `delete` nor `admin_delete`.
	expect(run(["admin_{delete}", "admin_delete", "delete"], ["{delete}"]).allowed).toEqual([]);
	// Escapes suppress the brace and match literally.
	expect(run(["{delete}", "admin_delete"], ["\\{delete\\}"]).allowed).toEqual(["{delete}"]);
});

test("a filter entry matching no tool is reported in config order", () => {
	const result = run(NAMES, ["search", "zzz_typo", "read_*"]);
	expect(result.unmatched).toEqual(["zzz_typo"]);
});

test("filter that excludes every advertised tool reports filterEmpty", () => {
	const result = run(NAMES, ["zzz_nonexistent"]);
	expect(result.allowed).toEqual([]);
	expect(result.filterEmpty).toBe(true);
});

test("a denylist excluding everything also reports filterEmpty", () => {
	const result = run(NAMES, undefined, ["*"]);
	expect(result.allowed).toEqual([]);
	expect(result.filterEmpty).toBe(true);
});

test("malformed glob entries degrade to unmatched instead of disabling the server", () => {
	// picomatch compiles a syntactically broken class to a never-matching
	// regex — the entry surfaces as unmatched, other entries still apply.
	const result = run(NAMES, ["read_*", "[z-a]*"]);
	expect(result.allowed).toEqual(["read_channel"]);
	expect(result.unmatched).toEqual(["[z-a]*"]);
});

test("literal entries with glob metacharacters match only their exact spelling", () => {
	const result = run(["a.b", "axb"], ["a.b"]);
	expect(result.allowed).toEqual(["a.b"]);
});

test("picomatch classes agree with standard glob semantics", () => {
	expect(run(["file_1", "file_a"], ["file_[0-9]"]).allowed).toEqual(["file_1"]);
	expect(run(["file_!"], ["file_[!a]"]).allowed).toEqual(["file_!"]);
	expect(run(["}ax", "ax"], ["[}]].*"]).allowed).toEqual([]);
});

test("normalized filter key collapses alias filter sets for connection dedup", () => {
	expect(mcpToolFilterKey(["b", "a"], undefined)).toBe(mcpToolFilterKey(["a", "b", "a"], undefined));
	expect(mcpToolFilterKey(undefined, ["x"])).toBe(mcpToolFilterKey(undefined, ["x"]));
	expect(mcpToolFilterKey(["a"], undefined)).not.toBe(mcpToolFilterKey(undefined, ["a"]));
});

test("filter key treats absent and empty filters as equal", () => {
	expect(mcpToolFilterKey(undefined, undefined)).toBe(mcpToolFilterKey([], undefined));
	expect(mcpToolFilterKey(undefined, undefined)).toBe(mcpToolFilterKey(undefined, []));
});

test("applyMCPToolFilter preserves tool definitions and schemas", () => {
	const defs: MCPToolDefinition[] = [
		{
			name: "read_file",
			description: "Reads a file",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		},
		{ name: "delete_file", description: "Deletes a file", inputSchema: { type: "object" } },
		{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } },
	];
	const filtered = applyMCPToolFilter("test-server", defs, { enabledTools: ["read_*", "write_*"] });
	expect(filtered).toHaveLength(2);
	expect(filtered[0]).toEqual(defs[0]);
	expect(filtered[1]).toEqual(defs[2]);
});
