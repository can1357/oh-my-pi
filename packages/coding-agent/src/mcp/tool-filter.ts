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
import type { MCPToolDefinition } from "./types";

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
	/** True when a configured filter excluded every advertised tool. */
	filterEmpty: boolean;
}

/**
 * Picomatch treats `/` as a path separator: `*` and `?` never cross it and
 * negated classes always exclude it (picomatch's compiler appends `/` to
 * negated-class output). MCP tool names are opaque strings — a denylist
 * entry `*` must match a tool named `admin/delete` — so both the pattern and
 * the name are matched in a slash-free domain: every `/` is transliterated
 * to `§` (an ordinary printable character that is not a glob metacharacter,
 * survives picomatch's class compilation, and is excluded from MCP tool-name
 * characters). Literal `§` in the input is escaped to `¤§` and literal `¤` to
 * `¤¤`; the units `§`, `¤§`, `¤¤` are prefix-free (verified exhaustively over
 * the {§, ¤, /} alphabet), so the encoding is injective — encoded strings
 * collide only when the originals do.
 *
 * Known limitations (documented, not guarded — the matching domain is
 * character-substituted, so picomatch sees encoded text):
 * - picomatch hardcodes `/` into NEGATED character classes (`[^a]` →
 *   `[^a/]`), so a negated class can never exclude the slash character —
 *   `[^/]` matches slash-containing names;
 * - `?` and class *ranges* resolve against encoded text, so they cannot span
 *   a slash position (`admin??delete` matches one-char `admin§delete`, and
 *   `[.-0]` does not span it) — use `*`, `**`, or an explicit `/` class
 *   member instead.
 * The common patterns (`*`, `**`, explicit `/` class members, braces,
 * literals) are unaffected and match as documented.
 *
 * `nonegate`/`noextglob` pin the applied surface to the documented globs
 * (`*`, `?`, `[...]`, `{a,b}`) — a leading `!` or extglob prefix (`+(a|b)`)
 * is treated as a literal by picomatch, keeping every entry's semantics
 * uniform regardless of whether it also contains `*`/`?`.
 */
const MATCH_OPTIONS = { dot: true, nonegate: true, noextglob: true } as const;

/** The code character a transliterated `/` is replaced with (see rationale above). */
const SLASH_CODE = "§";
/** The escape marker used for the two code characters above. */
const ESCAPE = "¤";

/**
 * Transliterate a pattern or name into the slash-free matching domain:
 * `/` → `§`, literal `§` → `¤§`, literal `¤` → `¤¤` (prefix-free, injective).
 */
function toSlashFreeDomain(text: string): string {
	let out = "";
	for (const ch of text) {
		if (ch === "/") out += SLASH_CODE;
		else if (ch === SLASH_CODE) out += ESCAPE + SLASH_CODE;
		else if (ch === ESCAPE) out += ESCAPE + ESCAPE;
		else out += ch;
	}
	return out;
}

class CompiledPattern {
	readonly #raw: string;
	readonly #isMatch: ((name: string) => boolean) | undefined;

	constructor(pattern: string) {
		this.#raw = pattern;
		if (/[*?[\]{}]/.test(pattern)) {
			this.#isMatch = picomatch(toSlashFreeDomain(pattern), MATCH_OPTIONS);
		}
	}

	matches(name: string): boolean {
		if (this.#raw === name) return true;
		if (!this.#isMatch) return false;
		return this.#isMatch(toSlashFreeDomain(name));
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
		// Only unmatched allowlist entries warn: silence there means
		// over-permission (the opposite of the allowlist intent). An unmatched
		// denylist entry is harmless — deny subtracts, so a defensive entry
		// kept across servers/versions legitimately matches nothing and must
		// not produce recurring log noise.
		unmatched = enabledTools!.filter((_, i) => !toolNames.some(name => enabled[i].matches(name)));
	} else {
		allowed = [...toolNames];
		unmatched = [];
	}

	if (disabled) {
		allowed = allowed.filter(name => !disabled.some(matcher => matcher.matches(name)));
	}

	return { allowed, unmatched, filterEmpty: allowed.length === 0 && toolNames.length > 0 };
}

/**
 * Filter an array of advertised MCP tool definitions based on the server's
 * configured `enabledTools` / `disabledTools`.
 *
 * Applied at the network reception boundary (`listTools`), so that all
 * downstream consumers (tool cache, custom tools, `/session`, `/mcp test`,
 * runtime snapshots) automatically observe only the allowed tools.
 *
 * Preserves each matching tool's original definition, schema, and order.
 * Logs warnings for unmatched patterns (typos / renames).
 * If the filter excludes all advertised tools, logs a warning and returns an empty array.
 */
export function applyMCPToolFilter(
	serverName: string,
	tools: MCPToolDefinition[],
	config?: { enabledTools?: string[]; disabledTools?: string[] },
): MCPToolDefinition[] {
	if (!config?.enabledTools?.length && !config?.disabledTools?.length) {
		return tools;
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
			`MCP server "${serverName}": tool filter (enabledTools=${JSON.stringify(config.enabledTools)}, disabledTools=${JSON.stringify(config.disabledTools)}) excluded all ${tools.length} advertised tools; 0 tools will be contributed to the session.`,
			{ path: `mcp:${serverName}` },
		);
		return [];
	}

	const allowedSet = new Set(allowed);
	return tools.filter(t => allowedSet.has(t.name));
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
