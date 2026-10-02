import { logger } from "@oh-my-pi/pi-utils";
import picomatch from "picomatch";
import { sanitizeMCPToolNamePart } from "./name-sanitize";
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
 * Matching a config entry against an advertised tool name.
 *
 * A name is sanitized before matching: a run of characters outside
 * `[A-Za-z0-9_-]` collapses to a single `_` (edge underscores trimmed),
 * because every practical MCP server advertises identifier-like names and
 * picomatch's glob semantics are defined for such strings. The raw name is
 * kept everywhere else — the filter is a filter, not a renamer — and a name
 * outside the alphabet matches the pattern written for its sanitized
 * spelling. Distinct raw names sanitizing to the same spelling collide by
 * design: the same trade every major agent makes.
 *
 * Matching itself is picomatch's, on both spellings of a name (raw and
 * sanitized — a pattern written for a name's literal spelling addresses that
 * spelling, while the sanitized domain is how a name holding exotic characters
 * is reached), with path semantics harmless here (sanitized names hold no `/`
 * and no leading dot). Picomatch's glob semantics are the contract: an escape
 * means what it means in a glob (`\d` is a digit, `\n` a newline), a bare `|`
 * alternates, and a bare `"` is quoted before compiling so it stays ordinary.
 * A literal entry — holding none of `*?[]{}()|\\` (the `compilePattern`
 * metacharacter gate), so also none of the `{a,b}`/extglob/`(a|b)` spellings
 * picomatch would read as syntax — is exact equality on the sanitized
 * spellings, so a tool name containing glob metacharacters still matches
 * the pattern written for its look. A pattern the compiler rejects degrades
 * to a never-matching entry instead of disabling the server, and entries
 * are never environment-expanded. An entry carrying four or more consecutive
 * backslashes is refused before compiling (picomatch hangs on such runs)
 * and likewise never matches, surfacing as an unmatched entry.
 */

/**
 * The option set `makeRe`/`parse` consume: tool names are opaque strings, so
 * a leading dot is ordinary (`dot`), `!` never negates (`nonegate`, so
 * `!(a)` is literal), extglob syntax is literal (`noextglob`), `**` reads as
 * one star (`noglobstar`), and `\` is an ordinary character in a name
 * (`windows: false` on every host).
 */
const PARSE_OPTIONS = {
	dot: true,
	nonegate: true,
	noextglob: true,
	noglobstar: true,
	windows: false,
	// Without this a pattern with no leading wildcard takes picomatch's
	// fast path, which returns before tokenizing: the pattern would compile to
	// nothing and match every tool.
	fastpaths: false,
	// Keep a class token's value in its raw spelling, rather than picomatch's
	// literal-or-class alternation.
	literalBrackets: false,
} as const;

/**
 * A name as the matcher sees it: a filter-domain sanitization — every
 * character outside `[A-Za-z0-9_-]` collapses to a run of `_`, runs
 * collapsed, edge underscores trimmed — while case and hyphens are kept
 * verbatim. This is deliberately NOT the `mcp__…` mint spelling (the mint
 * folds case and hyphens): patterns address the raw advertised spelling and
 * this sanitized second domain, never the minted registry key.
 */
function sanitizeToolName(name: string): string {
	return sanitizeMCPToolNamePart(name, name, true);
}

/** Per-pattern matcher over sanitized tool names; cached across filter calls. */
type ToolMatcher = (name: string) => boolean;

const compiledPatterns = new Map<string, ToolMatcher>();

/**
 * Quote a BARE `"` in a pattern before compiling: picomatch's parser reads a
 * bare quote and derails (a lone one compiles to an empty match).
 *
 * "Bare" is decided by backslash PARITY, not by the immediately preceding
 * character: in `\\\\"` the first backslash escapes the second, so the quote is
 * bare and must be quoted, while in `\\"` the quote is already escaped (the glob
 * spelling for a literal quote) and escaping it again would yield `\\\\"` —
 * matching a backslash followed by a quote and silently missing the intended
 * name.
 */
function quoteBareDoubles(pattern: string): string {
	let out = "";
	let backslashes = 0;
	for (const char of pattern) {
		if (char === "\\") {
			backslashes++;
			out += char;
			continue;
		}
		if (char === '"' && backslashes % 2 === 0) out += '\\"';
		else out += char;
		backslashes = 0;
	}
	return out;
}

/** Does the pattern hold four or more consecutive backslashes? */
function backslashRun(pattern: string): boolean {
	return /\\{4}/.test(pattern);
}

/**
 * Match-time bounds mirroring the compile-time `backslashRun` refusal.
 *
 * Picomatch's compiled regex can stall at MATCH time instead, where neither
 * the guard nor the surrounding try/catch reaches: an unescaped run of
 * interleaved `*`+literal groups backtracks exponentially against a
 * homogeneous name (`*a*a*a*b` vs `"a".repeat(255)` measured 107 ms on
 * picomatch 4.0.7, six groups ~seconds, seven+ minutes — and the server owns
 * the advertised name, `listTools` re-runs the filter on every
 * `tools/list_changed`, and the regex is synchronous and unabortable on the
 * main thread). Two cheap discrete bounds close the class without touching a
 * pattern any real config writes: at most 6 unescaped wildcard tokens, and no
 * name longer than 64 characters reaches the regex (the mint itself caps
 * registry names at 64; longer names stay addressable through the exact
 * literal path). Measured worst case inside both bounds: ~65 ms per
 * (pattern, name).
 */
const MAX_WILDCARD_TOKENS = 6;
const MAX_GLOB_NAME_LENGTH = 64;

/** Count unescaped `*`, `?`, `[`, and `{` tokens in a pattern. */
function wildcardTokenCount(pattern: string): number {
	let count = 0;
	let escaped = false;
	for (const char of pattern) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "*" || char === "?" || char === "[" || char === "{") count++;
	}
	return count;
}

/** Compile one filter entry into a matcher over sanitized tool names. */
function compilePattern(pattern: string): ToolMatcher {
	const cached = compiledPatterns.get(pattern);
	if (cached !== undefined) return cached;

	let matcher: ToolMatcher;
	if (backslashRun(pattern)) {
		// Picomatch's parser never returns once a pattern carries a run of four or
		// more backslashes — measured to hang even for a run with no other glob
		// metacharacter, so the guard has to cover the whole class. An infinite
		// loop no `try`/`catch` can rescue, so the pattern is rejected before the
		// parser is entered. (Picomatch 4.0.7: `*\\\\`, `[a]\\\\`, `{a,b}\\\\`, `|\\\\`,
		// `/\\\\` and a bare `\\\\\\\\` all hang; every run of three compiles in
		// microseconds.)
		matcher = () => false;
	} else if (wildcardTokenCount(pattern) > MAX_WILDCARD_TOKENS) {
		// Beyond the wildcard bound the compiled regex can backtrack for seconds
		// at match time against a homogeneous server-chosen name (see the
		// constant's doc). The entry degrades to never-matching and surfaces as
		// unmatched, the same direction the backslash-run refusal takes.
		matcher = () => false;
	} else if (/[*?[\]{}\\|()]/.test(pattern)) {
		try {
			// picomatch's own matcher factory; the `picomatch()` wrapper is
			// avoided for its `input === glob` shortcut, and path decorations
			// (`[^/]*?`, dot guards, a trailing `\/?`) are inert here because a
			// sanitized name holds no `/` and no leading dot.
			//
			// The raw name is tested too: a pattern written for a name's literal
			// spelling (`a.b`, `\*`) addresses that spelling, while the
			// sanitized spelling is the second domain a name outside the
			// identifier alphabet is reached through.
			const regex = picomatch.makeRe(quoteBareDoubles(pattern), PARSE_OPTIONS);
			matcher = (name: string) =>
				(name.length <= MAX_GLOB_NAME_LENGTH && regex.test(name)) ||
				// The sanitized spelling is never longer than the raw name, so the
				// length bound covers the second domain without a second check.
				(name.length <= MAX_GLOB_NAME_LENGTH && regex.test(sanitizeToolName(name)));
		} catch {
			// A pattern the engine rejects — a descending class range such as
			// `[z-a]`, for instance — never matches anything, and degrading to
			// an unmatched entry beats disabling the server.
			matcher = () => false;
		}
	} else {
		// A pattern with no glob metacharacter is exact on the raw name —
		// `read_v1` stays `read_v1`, never `read_v` — and the sanitized
		// spelling is only a second domain for names outside the alphabet.
		matcher = (name: string) => name === pattern || sanitizeToolName(name) === sanitizeToolName(pattern);
	}

	compiledPatterns.set(pattern, matcher);
	return matcher;
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries holding any of `*?[]{}()|\\`
 * (the `compilePattern` metacharacter gate) are matched with picomatch's
 * glob semantics over the sanitized name. Denylist entries subtract from
 * the allowlist when both are set.
 */
export function filterMCPTools(input: MCPToolFilterInput): MCPToolFilterResult {
	const { toolNames } = input;
	// `connection.config` can reach here unnormalized: the `/mcp test` paths read
	// the config file with a bare JSON.parse and never pass through a discovery
	// loader's `parseMCPToolFilters`. Degrade a malformed value to "filter off"
	// exactly as `parseMCPToolFilterEntry` does at discovery time, so a config
	// typo cannot throw out of `listTools` or hand the session a skewed filter.
	const asFilterList = (list: unknown): string[] | undefined =>
		Array.isArray(list)
			? list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
			: undefined;
	const enabledTools = asFilterList(input.enabledTools);
	const disabledTools = asFilterList(input.disabledTools);

	const filterConfigured = Boolean(enabledTools?.length || disabledTools?.length);
	if (!filterConfigured) {
		return { allowed: [...toolNames], unmatched: [], filterEmpty: false };
	}

	const enabled = enabledTools?.length ? enabledTools.map(compilePattern) : undefined;
	const disabled = disabledTools?.length ? disabledTools.map(compilePattern) : undefined;

	let allowed: string[];
	let unmatched: string[];

	if (enabled) {
		allowed = toolNames.filter(name => enabled.some(matcher => matcher(name)));
		// Only unmatched allowlist entries warn: silence there means
		// over-permission (the opposite of the allowlist intent). An unmatched
		// denylist entry is harmless — deny subtracts, so a defensive entry
		// kept across servers/versions legitimately matches nothing and must
		// not produce recurring log noise.
		unmatched = enabledTools!.filter((_pattern, i) => !toolNames.some(name => enabled[i](name)));
	} else {
		allowed = [...toolNames];
		unmatched = [];
	}

	if (disabled) {
		allowed = allowed.filter(name => !disabled.some(matcher => matcher(name)));
	}

	return {
		allowed,
		unmatched,
		filterEmpty: allowed.length === 0 && toolNames.length > 0,
	};
}

/**
 * Filter an array of advertised MCP tool definitions based on the server's
 * configured `enabledTools` / `disabledTools`.
 *
 * Applied at the network reception boundary (`listTools`), so that all
 * downstream consumers (tool cache, custom tools, `/ session`, ` / mcp test`,
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
			`MCP server "${serverName}": tool filter(enabledTools = ${JSON.stringify(config.enabledTools)}, disabledTools = ${JSON.stringify(config.disabledTools)}) excluded all ${tools.length} advertised tools; 0 tools will be contributed to the session.`,
			{
				path: `mcp:${serverName}`,
				advertised:
					toolNames.length <= 20 ? toolNames : [...toolNames.slice(0, 20), `… (+${toolNames.length - 20} more)`],
			},
		);
		return [];
	}

	const allowedSet = new Set(allowed);
	return tools.filter(t => allowedSet.has(t.name));
}
