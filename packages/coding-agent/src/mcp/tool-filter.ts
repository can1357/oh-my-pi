import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeNamePart } from "./name-sanitize";
import type { MCPToolDefinition } from "./types";

/** A tool filter rule set for one server, with the raw advertised tool names. */
export interface MCPToolFilterInput {
	toolNames: string[];
	enabledTools?: unknown;
	disabledTools?: unknown;
}

/** Result of applying a tool filter. */
export interface MCPToolFilterResult {
	/** Advertised names that survive the filter, in roster order. */
	allowed: string[];
	/** Allowlist entries that matched no advertised name (typo/rename diagnostic). */
	unmatched: string[];
	/** True when the filter excluded every advertised tool. */
	filterEmpty: boolean;
}

/**
 * Matching a config entry against an advertised tool name.
 *
 * Each entry compiles once to `Bun.Glob` — the same matcher the rule `agents`
 * scope and skill include/ignore lists use — and is tested against the raw
 * name and its filter-domain sanitized spelling. The raw name is kept
 * everywhere else: the filter is a filter, not a renamer. Entries are never
 * environment-expanded.
 */
/**
 * A leading `!` negates in Bun.Glob, so `!foo` would silently invert an
 * allowlist instead of tripping the unmatched-entry diagnostic. Filters have
 * no negation syntax (deny is the separate `disabledTools` field), so a
 * leading bang is always escaped to its literal reading.
 */
function escapeLeadingBang(pattern: string): string {
	return pattern.startsWith("!") ? `\\${pattern}` : pattern;
}

function sanitizeToolName(name: string): string {
	return sanitizeNamePart(name, name, { domain: "filter" });
}

/**
 * Normalize one filter list: a strict array of non-empty strings. Anything
 * else degrades to "filter off" so a config typo cannot throw out of
 * `listTools` or hand the session a skewed filter.
 */
function asFilterList(list: unknown): string[] | undefined {
	if (!Array.isArray(list)) return undefined;
	const filtered = list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return filtered.length > 0 ? filtered : undefined;
}

/**
 * Apply a per-server tool filter.
 *
 * Denylist entries subtract from the allowlist when both are set. Only
 * unmatched allowlist entries are reported: silence there means
 * over-permission (the opposite of the allowlist intent), while an unmatched
 * denylist entry is harmless — deny subtracts, so a defensive entry kept
 * across servers/versions legitimately matches nothing and must not produce
 * recurring log noise.
 */
export function filterMCPTools(input: MCPToolFilterInput): MCPToolFilterResult {
	const { toolNames } = input;
	const enabledTools = asFilterList(input.enabledTools);
	const disabledTools = asFilterList(input.disabledTools);

	const filterConfigured = Boolean(enabledTools?.length || disabledTools?.length);
	if (!filterConfigured) {
		return { allowed: [...toolNames], unmatched: [], filterEmpty: false };
	}

	const enabled = enabledTools?.map(pattern => ({ pattern, glob: new Bun.Glob(escapeLeadingBang(pattern)) }));
	const disabled = disabledTools?.map(pattern => ({ pattern, glob: new Bun.Glob(escapeLeadingBang(pattern)) }));
	// Exact equality first (as `ruleAppliesToAgent` does): a tool literally
	// named `a{b` is addressable even though Bun.Glob never matches unbalanced
	// braces, and a glob reading never steals a literal name.
	const matches = (entry: { pattern: string; glob: Bun.Glob }, name: string) =>
		entry.pattern === name || entry.glob.match(name) || entry.glob.match(sanitizeToolName(name));

	let allowed: string[];
	let unmatched: string[];
	if (enabled) {
		allowed = toolNames.filter(name => enabled.some(glob => matches(glob, name)));
		unmatched = enabledTools!.filter((_pattern, i) => !toolNames.some(name => matches(enabled[i], name)));
	} else {
		allowed = [...toolNames];
		unmatched = [];
	}
	if (disabled) {
		allowed = allowed.filter(name => !disabled.some(glob => matches(glob, name)));
	}

	return { allowed, unmatched, filterEmpty: allowed.length === 0 && toolNames.length > 0 };
}

/**
 * Filter an array of advertised MCP tool definitions based on the server's
 * configured `enabledTools` / `disabledTools`, plus reception diagnostics.
 *
 * Applied at the network reception boundary (`listTools`), so that all
 * downstream consumers (tool cache, custom tools, `/session`, `/mcp test`,
 * runtime snapshots) automatically observe only the allowed tools. Preserves
 * each matching tool's original definition, schema, and order. Logs warnings
 * for unmatched allowlist patterns (typos / renames); if the filter excludes
 * all advertised tools, logs a warning and returns an empty array.
 *
 * The diagnostics need the raw advertised roster — the filtered list alone
 * cannot distinguish a deny that matched from a typo that matched nothing —
 * so they are computed from the same pass rather than by filtering twice.
 */
export function applyMCPToolFilterWithDiagnostics(
	serverName: string,
	tools: MCPToolDefinition[],
	config?: { enabledTools?: string[]; disabledTools?: string[] },
): { filtered: MCPToolDefinition[]; diagnostics?: { unmatched: string[]; excluded: number } } {
	if (!config?.enabledTools?.length && !config?.disabledTools?.length) {
		return { filtered: tools };
	}

	const toolNames = tools.map(t => t.name);
	const { allowed, unmatched, filterEmpty } = filterMCPTools({
		toolNames,
		enabledTools: config.enabledTools,
		disabledTools: config.disabledTools,
	});

	if (unmatched.length > 0) {
		logger.warn(`MCP server "${serverName}": tool filter entries matched no advertised tool; ignoring them`, {
			path: `mcp:${serverName}`,
			unmatched,
			advertised:
				toolNames.length <= 20 ? toolNames : [...toolNames.slice(0, 20), `… (+${toolNames.length - 20} more)`],
		});
	}

	if (filterEmpty) {
		logger.warn(
			`MCP server "${serverName}": tool filter(enabledTools = ${JSON.stringify(config.enabledTools)}, disabledTools = ${JSON.stringify(config.disabledTools)}) excluded all ${tools.length} advertised tools; 0 tools will be contributed to the session.`,
			{
				path: `mcp:${serverName}`,
				advertised:
					toolNames.length <= 20 ? toolNames : [...toolNames.slice(0, 20), `… (+${toolNames.length - 20} more)`],
			},
		);
		return { filtered: [], diagnostics: { unmatched, excluded: tools.length } };
	}

	const allowedSet = new Set(allowed);
	return {
		filtered: tools.filter(t => allowedSet.has(t.name)),
		diagnostics: { unmatched, excluded: tools.length - allowedSet.size },
	};
}
