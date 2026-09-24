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
	"find",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
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

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([["search", "grep"]]);

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
 * Tools that are unusable without their sister, so any list naming one must
 * name the other. `createTools` auto-registers the pair from either name, but a
 * caller-supplied allowlist would otherwise drop the sister from the ACTIVE
 * set — leaving an agent able to checkpoint yet unable to rewind (or vice
 * versa). Shared by the SDK's session construction and the cold-revive clamp so
 * a replayed allowlist cannot lose the pairing the original run had.
 *
 * Registration is not consulted: every consumer filters against its own
 * registry afterwards (`setActiveToolsByName` ignores unknown names), and the
 * revive path has no registry to consult before the session rebuild.
 */
const SIBLING_TOOL_PAIRS: readonly (readonly [string, string])[] = [["checkpoint", "rewind"]] as const;

/**
 * Add each sibling pair's sister for every member already named. Returns a new
 * array (input order, then added sisters), or the input when no pair applies.
 */
export function withSiblingTools(names: readonly string[]): string[] {
	let out: string[] | undefined;
	for (const [a, b] of SIBLING_TOOL_PAIRS) {
		for (const [present, sister] of [
			[a, b],
			[b, a],
		] as const) {
			if (names.includes(present) && !names.includes(sister)) {
				out ??= [...names];
				out.push(sister);
			}
		}
	}
	return out ?? [...names];
}

/**
 * The reverse of {@link withSiblingTools}: if either member of a pair is
 * disallowed, both are — half a pair is unusable, so honouring a deny on just
 * one would leave a tool whose sibling call is guaranteed to fail. Returns the
 * filtered list.
 */
export function withoutSiblingTools(names: readonly string[], isDisallowed: (name: string) => boolean): string[] {
	return names.filter(name => {
		if (isDisallowed(name)) return false;
		for (const [a, b] of SIBLING_TOOL_PAIRS) {
			if (name === a || name === b) return !isDisallowed(name === a ? b : a);
		}
		return true;
	});
}

/**
 * Expand the `exec` tool alias into its concrete backends: `eval` (kept only
 * when at least one eval backend is allowed per `backends`) and `bash`. A deny
 * on the alias itself blocks the whole expansion; a deny on a child is applied
 * by the caller's later disallow filter (or by {@link isToolDisallowed} here
 * under an explicit `patterns`). Shared by the executor spawn path and
 * read-only classification so both see the same effective set.
 */
export function expandDisallowedTools(patterns: readonly string[]): string[] {
	// Case-insensitive alias: `Exec`/`EXEC` must expand like `exec`, or the
	// execution tier silently survives (normalizeToolName preserves the case
	// of non-canonical names, so the later exact checks would miss too).
	if (!patterns.some(pattern => pattern.toLowerCase() === "exec")) return [...patterns];
	const set = new Set(patterns);
	set.add("eval");
	set.add("bash");
	return Array.from(set);
}

export function expandExecToolAlias(
	names: readonly string[],
	patterns: readonly string[],
	backends: EvalBackendsAllowance,
): string[] {
	if (!names.some(name => name.toLowerCase() === "exec"))
		return names.filter(name => !isToolDisallowed(name, patterns));
	const withoutAlias = names.filter(name => name.toLowerCase() !== "exec");
	// `exec` is an alias for eval+bash: a deny on the alias blocks the whole
	// expansion; an explicit deny on either child still wins downstream.
	if (isToolDisallowed("exec", patterns)) return withoutAlias.filter(name => !isToolDisallowed(name, patterns));
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
 * Sanitize an MCP server/tool name into the lowercase `[a-z0-9_]` fragment used by
 * minted tool names (`createMCPToolName`). Canonical definition:
 * `isToolDisallowed`'s ownership fallback matches a pattern's server segment
 * against this, so raw config server names (registry `mcpServerName` metadata)
 * map to the exact segment a user writes in `mcp__<server>_*`.
 * `keepDigits: false` reproduces the pre-rename mint for the legacy-name fallback.
 */
export function sanitizeMCPToolNamePart(value: string, fallback: string, keepDigits = true): string {
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
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
 * sanitized tool-name prefix (`createMCPToolName` lowercases, keeps digits,
 * and collapses other non-`[a-z0-9_]` characters), not the raw config server
 * name — a server named `db-2` mints `mcp__db_2_query`, so the pattern is
 * `mcp__db_2_*`.
 *
 * Minted names over 64 chars are length-capped (`capMCPToolNameLength`), so the
 * `mcp__<server>_` prefix is truncated and hash-suffixed — a plain prefix match
 * then silently retains that server's tools. When the caller knows the tool's
 * raw `mcpServerName` (registry metadata), pass it as `mcpServerName`: each
 * `mcp__<server>_*` pattern then also disallows when the pattern's server
 * segment equals {@link sanitizeMCPToolNamePart} of the raw name, matching by
 * ownership instead of the lossy prefix.
 */
export interface ToolDisallowOptions {
	mcpServerName?: string;
	isBuiltIn?: boolean;
}

export function isToolDisallowed(
	name: string,
	patterns: readonly string[],
	options?: string | ToolDisallowOptions,
): boolean {
	const mcpServerName = typeof options === "string" ? options : options?.mcpServerName;
	const isBuiltIn = typeof options === "object" ? options?.isBuiltIn : undefined;
	if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName) && isBuiltIn !== false) return false;
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			// When the tool's raw server is known, ownership decides a
			// `mcp__<server>_*` pattern BEFORE the name-prefix fallback. The prefix is
			// lossy — server `foo` and server `foo_bar` both produce names starting
			// `mcp__foo_`, so the prefix test would strip an unrelated server's tools,
			// resources, and instructions with them.
			const serverSegment = mcpWildcardServerSegment(pattern);
			if (mcpServerName !== undefined && serverSegment !== undefined) {
				// Decided by ownership: a match denies, a mismatch moves on to the
				// remaining patterns WITHOUT the lossy prefix test.
				if (sanitizeMCPToolNamePart(mcpServerName, "server") === serverSegment) return true;
				continue;
			}
			if (name.startsWith(pattern.slice(0, -1))) return true;
		} else if (name === pattern || (pattern.toLowerCase() === "exec" && (name === "eval" || name === "bash"))) {
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
	options: { enforceToolAllowlist?: boolean; allowedToolNames?: ReadonlySet<string>; isBuiltIn?: boolean },
	mcpServerName?: string,
): boolean {
	if (isToolDisallowed(name, disallowedPatterns, { mcpServerName, isBuiltIn: options.isBuiltIn })) return false;
	if (!options.enforceToolAllowlist) return true;
	const isCanonicalHidden = options.isBuiltIn !== false && HIDDEN_TOOL_NAMES.includes(name as HiddenToolName);
	return isCanonicalHidden || options.allowedToolNames?.has(name) === true;
}
