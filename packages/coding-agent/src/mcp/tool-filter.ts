/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`).
 *
 * Tool names are matched against the raw names the server advertises via
 * `tools/list` (not the `mcp__server_`-prefixed session names). Entries may be
 * literal tool names or glob patterns (`"search"`, `"channel_*"`), matched by
 * [`picomatch`](https://github.com/micromatch/picomatch).
 *
 * Semantics, mirroring the server-level `enabledServers` / `disabledServers`
 * pair: an allowlist registers only matching tools, a denylist registers
 * everything except matching tools, and when both are set the denylist wins
 * (deny subtracts from allow).
 */

import { logger } from "@oh-my-pi/pi-utils";
import picomatch from "picomatch";

/** A tool filter rule set for one server, with the raw advertised tool names. */
export interface MCPToolFilterInput {
	/** Raw tool names advertised by the server (from `tools/list`). */
	toolNames: string[];
	/** `enabledTools` from the server config, if any. */
	enabledTools?: readonly string[];
	/** `disabledTools` from the server config, if any. */
	disabledTools?: readonly string[];
}

/** Result of applying a tool filter. */
export interface MCPToolFilterResult {
	/** The subset of `toolNames` that passed the filter, in original order. */
	allowed: string[];
	/** Config entries that matched no advertised tool name, in config order. */
	unmatched: string[];
	/** True when a configured filter excluded every advertised tool; the healthy
	 * connection's stale tools must be cleared, not kept for transport-failure recovery. */
	filterEmpty: boolean;
}

/**
 * Picomatch treats `/` as a path separator: `*` and `?` never cross it and
 * `[^/]` classes stop at it. MCP tool names are opaque strings — a denylist
 * entry `*` must match a tool named `admin/delete` — so both the pattern and
 * the name are matched in a slash-free domain: every `/` is transliterated
 * to NUL (a character no glob metacharacter treats specially, and one that
 * cannot appear in a JSON config string). The transliteration collides only
 * for names containing a literal NUL (`a/b` ≡ `a\0b`) — pathological, since
 * NUL cannot appear in a JSON config string either.
 * Patterns containing explicit `/` classes (`[/]`) are not supported.
 */
const MATCH_OPTIONS = { dot: true } as const;

const SLASH_SENTINEL = "\0";

/**
 * A compiled pattern: a literal fast path plus a picomatch matcher built once
 * per filter application (not per name), so filtering a 10k-tool server is
 * O(tools × patterns) matcher lookups instead of O(tools × patterns) regex
 * compilations.
 */
class CompiledPattern {
	readonly #raw: string;
	readonly #isMatch: ((name: string) => boolean) | undefined;

	constructor(pattern: string) {
		this.#raw = pattern;
		if (/[*?[\]{}]/.test(pattern)) {
			this.#isMatch = picomatch(pattern.replaceAll("/", SLASH_SENTINEL), MATCH_OPTIONS);
		}
	}

	matches(name: string): boolean {
		if (this.#raw === name) return true;
		if (!this.#isMatch) return false;
		return this.#isMatch(name.replaceAll("/", SLASH_SENTINEL));
	}
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries containing glob metacharacters
 * (`*`, `?`, `[...]`, `{...}`) are matched with picomatch semantics (dotfiles
 * enabled, since MCP tool names are opaque strings, not paths). Denylist
 * entries subtract from the allowlist when both are set.
 */
export function filterMCPTools(input: MCPToolFilterInput): MCPToolFilterResult {
	const { toolNames, enabledTools, disabledTools } = input;
	const filterConfigured = Boolean(enabledTools?.length || disabledTools?.length);
	if (!filterConfigured) {
		return { allowed: [...toolNames], unmatched: [], filterEmpty: false };
	}

	// Compile each pattern once per call; matches(name, pattern) per pair
	// would recompile the picomatch regex for every tool × pattern.
	const enabled = enabledTools?.length ? enabledTools.map(pattern => new CompiledPattern(pattern)) : undefined;
	const disabled = disabledTools?.length ? disabledTools.map(pattern => new CompiledPattern(pattern)) : undefined;

	let allowed: string[];
	let unmatched: string[];

	if (enabled) {
		allowed = toolNames.filter(name => enabled.some(matcher => matcher.matches(name)));
		unmatched = enabledTools!.filter((_, i) => !toolNames.some(name => enabled[i].matches(name)));
	} else {
		allowed = [...toolNames];
		unmatched = [];
	}

	if (disabled) {
		allowed = allowed.filter(name => !disabled.some(matcher => matcher.matches(name)));
		unmatched = [
			...unmatched,
			...disabledTools!.filter((_, i) => !toolNames.some(name => disabled[i].matches(name))),
		];
	}

	return { allowed, unmatched, filterEmpty: allowed.length === 0 && toolNames.length > 0 };
}

/**
 * Single source for the filter-empty failure message, used verbatim in the
 * applyMCPToolFilter diagnostic and in every manager status/errors surface.
 */
export function mcpFilterEmptyMessage(toolCount: number): string {
	return `tool filter excludes all ${toolCount} advertised tools; the server would contribute nothing to the session. Remove the filter or widen it.`;
}

/**
 * Apply a per-server tool filter and surface diagnostics.
 *
 * Unknown entries (patterns matching no advertised tool) are warned about —
 * a typo is a config bug, but a server renaming tools upstream must degrade
 * to "filter ignored" rather than disabling an otherwise usable server.
 *
 * Never throws: an all-excluding filter logs once and returns `[]`, so callers
 * clear stale tools instead of treating a healthy connection as a failure.
 */
export function applyMCPToolFilter(serverName: string, input: MCPToolFilterInput): string[] {
	const { allowed, unmatched, filterEmpty } = filterMCPTools(input);

	if (unmatched.length > 0) {
		logger.warn(`MCP server "${serverName}": tool filter entries matched no advertised tool; ignoring them`, {
			path: `mcp:${serverName}`,
			unmatched,
			advertised:
				input.toolNames.length <= 20
					? input.toolNames
					: [...input.toolNames.slice(0, 20), `… (+${input.toolNames.length - 20} more)`],
		});
	}

	if (filterEmpty) {
		logger.error(
			`MCP server "${serverName}": tool filter (enabledTools=${JSON.stringify(input.enabledTools)}, disabledTools=${JSON.stringify(input.disabledTools)}) ${mcpFilterEmptyMessage(input.toolNames.length)}`,
			{ path: `mcp:${serverName}` },
		);
		return [];
	}

	return allowed;
}

/**
 * Normalized comparison key for the filter of a server: unique members, sorted.
 * Two alias configs with the same members in any order/duplicates have
 * identical filtering behavior and must dedup to a single connection.
 */
export function mcpToolFilterKey(
	enabledTools: readonly string[] | undefined,
	disabledTools: readonly string[] | undefined,
): string {
	return JSON.stringify([
		enabledTools?.length ? [...new Set(enabledTools)].sort() : null,
		disabledTools?.length ? [...new Set(disabledTools)].sort() : null,
	]);
}
