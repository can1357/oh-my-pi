import type { EvalBackendsAllowance } from "./eval-backends";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"github",
	"glob",
	"grep",
	"lsp",
	"checkpoint",
	"rewind",
	"security_scan",
	"task",
	"hub",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs and legacy aliases. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ?? (Object.hasOwn(CANONICAL_TOOL_NAMES, lower) ? lower : name);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/**
 * The `exec` shorthand maps to the concrete execution tools: `bash` always,
 * plus `eval` when an eval backend is available. Extracted from the executor's
 * child tool derivation (fr-vW/fo80l) so the persona grant and the child-side
 * capability intersect expand the shorthand through the SAME rule instead of
 * drifting copies.
 *
 * `backends === undefined` means "assume available": grant layers computed
 * before a session exists (the persona grant) cannot read eval settings — the
 * registry/`effective()` layer gates `eval` at use time, so expanding it here
 * never grants a tool the session cannot actually run.
 */
export function expandExecToolShorthand(names: readonly string[], backends?: EvalBackendsAllowance): string[] {
	if (!names.includes("exec")) return [...names];
	const expanded = names.filter(name => name !== "exec");
	if (!backends || backends.python || backends.js) expanded.push("eval");
	expanded.push("bash");
	return Array.from(new Set(expanded));
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
