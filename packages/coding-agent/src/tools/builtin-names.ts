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

/** Canonicalize built-in IDs, legacy aliases, and MCP minted names. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return (
		LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ??
		(Object.hasOwn(CANONICAL_TOOL_NAMES, lower) || lower.startsWith("mcp__") ? lower : name)
	);
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
 * Expand the `exec` tool alias into its concrete backends: `eval` (kept only
 * when at least one eval backend is allowed per `backends`) and `bash`. A deny
 * on the alias itself blocks the whole expansion; a deny on a child is applied
 * by the caller's later disallow filter (or by {@link isToolDisallowed} here
 * under an explicit `patterns`). Shared by the executor spawn path and
 * read-only classification so both see the same effective set.
 */
export function expandExecToolAlias(
	names: readonly string[],
	patterns: readonly string[],
	backends: EvalBackendsAllowance,
): string[] {
	if (!names.includes("exec")) return [...names];
	const withoutAlias = names.filter(name => name !== "exec");
	// `exec` is an alias for eval+bash: a deny on the alias blocks the whole
	// expansion; an explicit deny on either child still wins downstream.
	if (isToolDisallowed("exec", patterns)) return withoutAlias;
	const expanded = [...withoutAlias];
	if (backends.python || backends.js) expanded.push("eval");
	expanded.push("bash");
	return Array.from(new Set(expanded)).filter(name => !isToolDisallowed(name, patterns));
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

/**
 * Sanitize an MCP server/tool name into the lowercase `[a-z_]` fragment used by
 * minted tool names (`createMCPToolName`). Canonical definition:
 * `isToolDisallowed`'s ownership fallback matches a pattern's server segment
 * against this, so raw config server names (registry `mcpServerName` metadata)
 * map to the exact segment a user writes in `mcp__<server>_*`.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Server segment of an `mcp__<server>_*` wildcard pattern (text after `mcp__`
 * up to the trailing `_` before the `*`). A pattern not starting with `mcp__`
 * has no server segment.
 */
function mcpWildcardServerSegment(pattern: string): string | undefined {
	const base = pattern.slice(0, -1);
	if (!base.startsWith("mcp__")) return undefined;
	// Only the bare `mcp__<server>_*` form (pattern ends with `_` before the
	// `*`) applies the ownership fallback. A tool-prefix wildcard like
	// `mcp__foo_query*` matches by name prefix alone — its last underscore is a
	// tool-name separator, not the server/tool boundary, and the fallback must
	// not overmatch the server's whole tool set.
	if (!base.endsWith("_")) return undefined;
	const afterPrefix = base.slice("mcp__".length);
	const sep = afterPrefix.lastIndexOf("_");
	return sep < 0 ? undefined : afterPrefix.slice(0, sep);
}

/**
 * Whether a disallow pattern set targets a whole MCP server by name: the
 * blanket `mcp__*` or a bare `mcp__<server>_*` wildcard whose server segment
 * matches {@link sanitizeMCPToolNamePart} of the raw server name. Used to
 * decide whether a resource-only server (advertises resources, no tools — no
 * registry tool to gate on) is scoped out: an unrelated disallow
 * (`disallowedTools: [bash]`) or a pattern for a different server must not
 * strip its resources/instructions, while `mcp__*` or `mcp__<server>_*`
 * naming it must.
 */
export function mcpDisallowTargetsServer(patterns: readonly string[], serverName: string): boolean {
	const sanitized = sanitizeMCPToolNamePart(serverName, "server");
	for (const pattern of patterns) {
		if (pattern === "mcp__*" || pattern === "*") return true; // `mcp__*` = all MCP tools; bare `*` is deny-all and must close resource-only servers too.
		const serverSegment = mcpWildcardServerSegment(pattern);
		if (serverSegment !== undefined && serverSegment === sanitized) return true;
	}
	return false;
}

/**
 * Match a tool name against disallow patterns: a trailing `*` is a prefix
 * wildcard (`mcp__*` = all MCP tools, `mcp__<server>_*` = one server), any
 * other pattern matches the exact name.
 *
 * Hidden protocol tools (`yield`, `goal`, `think`) are never disallowable:
 * stripping the subagent terminator would leave a `requireYieldTool` session
 * unable to yield. The `<server>` in an `mcp__<server>_*` pattern is the
 * sanitized tool-name prefix (`createMCPToolName` lowercases and collapses
 * non-`[a-z_]` characters), not the raw config server name — a server named
 * `db2` mints `mcp__db_query`, so the pattern is `mcp__db_*`.
 *
 * Minted names over 64 chars are length-capped (`capMCPToolNameLength`), so the
 * `mcp__<server>_` prefix is truncated and hash-suffixed — a plain prefix match
 * then silently retains that server's tools. When the caller knows the tool's
 * raw `mcpServerName` (registry metadata), pass it as `mcpServerName`: each
 * `mcp__<server>_*` pattern then also disallows when the pattern's server
 * segment equals {@link sanitizeMCPToolNamePart} of the raw name, matching by
 * ownership instead of the lossy prefix.
 */
export function isToolDisallowed(name: string, patterns: readonly string[], mcpServerName?: string): boolean {
	if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName)) return false;
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			if (name.startsWith(pattern.slice(0, -1))) return true;
			if (mcpServerName !== undefined) {
				const serverSegment = mcpWildcardServerSegment(pattern);
				if (serverSegment !== undefined && sanitizeMCPToolNamePart(mcpServerName, "server") === serverSegment) {
					return true;
				}
			}
		} else if (name === pattern) {
			return true;
		}
	}
	return false;
}

/**
 * Single scope predicate for subagent tool grants: a tool is effectively scoped
 * in when it is not disallowed and, under an enforced `tools:` allowlist, is
 * either a hidden protocol tool (`yield`, `goal`, `think`) or named in the
 * allowlist. Hidden protocol tools are never removable by scoping — stripping
 * the subagent terminator would leave a `requireYieldTool` session unable to
 * yield. Shared by the session active-set invariant, the Cursor bridge grant,
 * and the MCP-instructions prompt filter so all three cannot drift apart.
 * `mcpServerName` (raw server of the tool, when known) is forwarded to
 * {@link isToolDisallowed} so capped minted names still match `mcp__<server>_*`.
 */
export function isToolScopedIn(
	name: string,
	disallowedPatterns: readonly string[],
	options: { enforceToolAllowlist?: boolean; allowedToolNames?: ReadonlySet<string> },
	mcpServerName?: string,
): boolean {
	if (isToolDisallowed(name, disallowedPatterns, mcpServerName)) return false;
	if (!options.enforceToolAllowlist) return true;
	return HIDDEN_TOOL_NAMES.includes(name as HiddenToolName) || options.allowedToolNames?.has(name) === true;
}
