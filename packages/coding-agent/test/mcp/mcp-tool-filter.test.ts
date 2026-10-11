/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`) via Bun.Glob.
 *
 * Observable contracts defended:
 * - Literal exact matching and Bun.Glob metacharacters (*, ?, [...], {a,b}).
 * - Raw + filter-domain sanitized dual matching (e.g. admin_delete reaches admin/delete).
 * - Case-sensitive matching across literal and glob patterns.
 * - Denylist subtracts from allowlist; unmatched denylist entries stay silent.
 * - Unmatched allowlist patterns are reported in config order.
 * - Total exclusion sets filterEmpty and triggers reception warnings.
 * - Non-array, empty, or invalid filter inputs degrade fail-open to filter-off.
 * - Reception preserves schemas, annotations, descriptions, raw names, and roster order, and logs diagnostics.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { afterEach, expect, test, vi } from "bun:test";
import { applyMCPToolFilterWithDiagnostics, filterMCPTools } from "../../src/mcp/tool-filter";
import type { MCPToolDefinition } from "../../src/mcp/types";

const NAMES = ["search", "read_channel", "send_message", "create_doc", "admin/delete"];

function run(toolNames: string[], enabledTools?: string[], disabledTools?: string[]) {
	return filterMCPTools({ toolNames, enabledTools, disabledTools });
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("literal exact match keeps only specified tools in advertised order", () => {
	const result = run(NAMES, ["read_channel", "create_doc"]);
	expect(result.allowed).toEqual(["read_channel", "create_doc"]);
	expect(result.unmatched).toEqual([]);
	expect(result.filterEmpty).toBe(false);
});

test("a leading bang stays literal and unbalanced-brace names stay addressable", () => {
	// Without the escape, `!foo` would negate and silently invert the allowlist
	// instead of tripping the unmatched-entry diagnostic.
	const bang = run(["search", "foo"], ["!foo"]);
	expect(bang.allowed).toEqual([]);
	expect(bang.unmatched).toEqual(["!foo"]);
	// Bun.Glob never matches unbalanced braces, so the literal fast path is the
	// only way a tool named `a{b` is addressable.
	expect(run(["a{b", "axb"], ["a{b"]).allowed).toEqual(["a{b"]);
});

test("glob metacharacters: star and brace alternation", () => {
	// Star wildcard crosses slashes because tool names are opaque strings
	expect(run(NAMES, ["send_*"]).allowed).toEqual(["send_message"]);
	expect(run(NAMES, ["admin/*"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["*"]).allowed).toEqual(NAMES);
	// Brace alternation expands branches (and justifies the no-CSV-split rule)
	expect(run(NAMES, ["{search,send_message}"]).allowed).toEqual(["search", "send_message"]);
});

test("names match in dual domains: raw advertised spelling and sanitized spelling", () => {
	// admin_delete reaches admin/delete via sanitized domain; admin* reaches it too
	expect(run(["admin/delete"], ["admin_delete"]).allowed).toEqual(["admin/delete"]);
	expect(run(["admin/delete"], ["admin*"]).allowed).toEqual(["admin/delete"]);
	expect(run(["admin/delete"], ["admin/*"]).allowed).toEqual(["admin/delete"]);
	expect(run(["web.search", "webXsearch"], ["web_search"]).allowed).toEqual(["web.search"]);
	expect(run(["web search"], ["web_search"]).allowed).toEqual(["web search"]);

	// Pattern with non-identifier characters reaches raw name directly
	expect(run(["a.b", "axb"], ["a.b"]).allowed).toEqual(["a.b"]);

	// Distinct raw names colliding under sanitization are both selected
	expect(run(["foo.bar", "foo bar"], ["foo_bar"]).allowed).toEqual(["foo.bar", "foo bar"]);
});

test("matching is case-sensitive and injective over underscore variants", () => {
	// Case-sensitive: literal and glob match only their specified case
	expect(run(["read", "READ"], ["read"]).allowed).toEqual(["read"]);
	expect(run(["read", "READ"], ["RE*"]).allowed).toEqual(["READ"]);

	// Underscore variants are distinct tools: filter sanitizer preserves [A-Za-z0-9_-] injectively
	expect(run(["read", "_read"], ["read"]).allowed).toEqual(["read"]);
	expect(run(["foo_bar", "foo__bar"], ["foo_bar"]).allowed).toEqual(["foo_bar"]);
});

test("denylist subtracts from allowlist when both are configured", () => {
	const result = run(NAMES, ["read_channel", "send_message", "search"], ["send_*"]);
	expect(result.allowed).toEqual(["search", "read_channel"]);

	// Denylist alone excludes matching tools from all advertised
	const denyOnly = run(NAMES, undefined, ["admin/*"]);
	expect(denyOnly.allowed).toEqual(["search", "read_channel", "send_message", "create_doc"]);

	// Denying an exact match leaves nothing
	expect(run(["read_channel"], ["read_channel"], ["read_channel"]).allowed).toEqual([]);
});

test("unmatched allowlist patterns are reported while unmatched denylist entries stay silent", () => {
	// Allowlist typos/renames are reported in config order
	const allowResult = run(NAMES, ["search", "zzz_typo", "read_*"]);
	expect(allowResult.unmatched).toEqual(["zzz_typo"]);

	// Unmatched denylist entry fails open and produces no warning noise
	const denyResult = run(NAMES, undefined, ["zzz_absent"]);
	expect(denyResult.allowed).toEqual(NAMES);
	expect(denyResult.unmatched).toEqual([]);
});

test("filter that excludes every advertised tool reports filterEmpty", () => {
	expect(run(NAMES, ["zzz_nonexistent"]).filterEmpty).toBe(true);
	expect(run(NAMES, undefined, ["*"]).filterEmpty).toBe(true);
	expect(run(NAMES, ["search"]).filterEmpty).toBe(false);
	expect(run([], ["search"]).filterEmpty).toBe(false);
});

test("non-array, empty, or invalid filter configs degrade fail-open to filter-off", () => {
	// Empty filter arrays contribute no constraints
	expect(run(NAMES, [], []).allowed).toEqual(NAMES);
	expect(run(NAMES, [], []).filterEmpty).toBe(false);
	expect(run(NAMES, undefined, undefined).allowed).toEqual(NAMES);

	// Non-array and invalid types degrade to filter-off
	expect(filterMCPTools({ toolNames: NAMES, enabledTools: "read" as unknown as string[] }).allowed).toEqual(NAMES);
	expect(filterMCPTools({ toolNames: NAMES, disabledTools: 42 as unknown as string[] }).allowed).toEqual(NAMES);
	expect(filterMCPTools({ toolNames: NAMES, enabledTools: [""] as unknown as string[] }).allowed).toEqual(NAMES);

	// Valid strings in mixed array still apply
	expect(filterMCPTools({ toolNames: NAMES, enabledTools: ["search", 123 as unknown as string] }).allowed).toEqual([
		"search",
	]);
});

test("reception preserves tool definitions, schema, annotations, raw name, and original order", () => {
	const defs: MCPToolDefinition[] = [
		{
			name: "read_file",
			description: "Reads a file",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		},
		{ name: "delete_file", description: "Deletes a file", inputSchema: { type: "object" } },
		{
			name: "admin/delete",
			description: "Administrative deletion",
			inputSchema: { type: "object" },
			annotations: { title: "Delete" },
		},
	];

	// Filter matches out-of-order, but advertised order and raw name are preserved
	const { filtered } = applyMCPToolFilterWithDiagnostics("test-server", defs, {
		enabledTools: ["admin_delete", "read_file"],
	});
	expect(filtered).toHaveLength(2);
	expect(filtered[0]).toEqual(defs[0]);
	expect(filtered[1]).toEqual(defs[2]);
	expect(filtered[1].name).toBe("admin/delete");
});

test("reception logs warnings on unmatched allowlist entries and empty filter", () => {
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const defs: MCPToolDefinition[] = [
		{ name: "read_file", description: "Reads a file", inputSchema: { type: "object" } },
		{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } },
	];

	// 1. Unmatched allowlist warning
	const { filtered } = applyMCPToolFilterWithDiagnostics("srv1", defs, { enabledTools: ["read_file", "typo_tool"] });
	expect(filtered).toHaveLength(1);
	expect(warnSpy).toHaveBeenCalledWith(
		expect.stringContaining('MCP server "srv1": tool filter entries matched no advertised tool'),
		expect.objectContaining({ path: "mcp:srv1", unmatched: ["typo_tool"] }),
	);

	warnSpy.mockClear();

	// 2. FilterEmpty warning when all tools are excluded
	const { filtered: emptyResult } = applyMCPToolFilterWithDiagnostics("srv2", defs, { enabledTools: ["nonexistent"] });
	expect(emptyResult).toHaveLength(0);
	expect(warnSpy).toHaveBeenCalledWith(
		expect.stringContaining('MCP server "srv2": tool filter('),
		expect.objectContaining({ path: "mcp:srv2" }),
	);
});
