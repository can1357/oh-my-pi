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
 * negated-class output). MCP tool names are opaque strings — a denylist entry
 * `*` must match a tool named `admin/delete` — so both sides are matched in a
 * slash-free domain where every `/` is transliterated to `§` and the encoding
 * characters themselves (`§`, `¤`) are escaped (`§ → ¤§`, `¤ → ¤¤`). The units
 * `§`, `¤§`, `¤¤` are prefix-free, so the encoding is injective: encoded names
 * collide only when the originals do.
 *
 * The name side is encoded verbatim; the pattern side is translated node by
 * node so that raw-character semantics survive the encoding:
 *
 * - `?` matches ONE RAW CHARACTER. Escaping the sentinel makes an encoded name
 *   variable-width (`§` occupies two encoded characters), so `?` is emitted as
 *   an alternation over the encoded domain — an escaped pair (`¤§`/`¤¤`) or any
 *   character that is not the escape marker. `admin?delete` therefore matches
 *   both `admin/delete` and a name containing a literal `§`.
 * - `*`/`**` span any number of characters, `/` included (no path separator
 *   exists in the encoded domain).
 * - Character classes translate their members; a range that spans `/`
 *   (`[.-0]`, where `.` ≤ `/` ≤ `0`) gains the sentinel as an explicit member,
 *   so the slash stays an ordinary member exactly as it is in the raw name. A
 *   negated class needs no compensation: picomatch's injected `/` member never
 *   matches, because no encoded name contains a raw `/`. Only `/` needs a
 *   compensation — `§` and `¤` are outside every code range a user writes
 *   (`§` is U+00A7), so a raw class range over them keeps its meaning.
 * - `(`, `)` and `|` are escaped, so grouping and alternation stay literal even
 *   beside a wildcard: `+(a|b)*` matches the literal `+(a|b)foo`, not `+afoo`.
 *   A leading `!`, an extglob prefix and braces outside the supported surface
 *   behave likewise: only `*`, `?`, `[...]` and `{a,b}` carry meaning.
 */
const MATCH_OPTIONS = { dot: true, nonegate: true, noextglob: true, windows: false } as const;

/** Character a transliterated `/` is replaced with. */
const SLASH_CODE = "§";
/** Escape marker for the two encoding characters (`§`, `¤`). */
const ESCAPE_MARK = "¤";
/** Slash code point, used to detect ranges that span it. */
const SLASH_CODEPOINT = 0x2f;
/**
 * Matches exactly one RAW character of an encoded name: one of the two-char
 * escape units, or any character that is not the escape marker.
 */
const RAW_CHAR = `{${ESCAPE_MARK}${SLASH_CODE},${ESCAPE_MARK}${ESCAPE_MARK},[^${ESCAPE_MARK}]}`;

/** Translate one literal (non-glob) character into the encoded domain. */
function translateLiteral(ch: string): string {
	if (ch === "/") return SLASH_CODE;
	if (ch === SLASH_CODE) return ESCAPE_MARK + SLASH_CODE;
	if (ch === ESCAPE_MARK) return ESCAPE_MARK + ESCAPE_MARK;
	return ch;
}

/**
 * Locate the `]` closing the class opened at `open`, following picomatch's own
 * boundary rules: a `]` directly after `[` or `[^` is a literal member, an
 * escaped `]` never closes, and `!` is an ordinary member.
 */
function findClassEnd(pattern: string, open: number): number {
	let i = open + 1;
	if (pattern[i] === "^") i++;
	if (pattern[i] === "]") i++;
	for (; i < pattern.length; i++) {
		if (pattern[i] === "\\") {
			i++;
			continue;
		}
		if (pattern[i] === "]") return i;
	}
	return -1;
}

/**
 * Translate a class body (`[`…`]` contents), mapping `/` to the sentinel and
 * completing any range that spans it.
 */
function translateClassBody(body: string): string {
	let out = "";
	let spansSlash = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\") {
			const next = body[i + 1];
			if (next === undefined) {
				out += "\\\\";
				continue;
			}
			out += "\\" + translateClassMember(next);
			i++;
			continue;
		}
		if (ch === "/") {
			out += SLASH_CODE;
			continue;
		}
		const hi = body[i + 2];
		if (body[i + 1] === "-" && hi !== undefined) {
			// A trailing `-` (immediately before `]`) is a literal member, not a range.
			out += ch + "-" + translateClassMember(hi);
			if (ch.charCodeAt(0) <= SLASH_CODEPOINT && SLASH_CODEPOINT <= hi.charCodeAt(0)) spansSlash = true;
			i += 2;
			continue;
		}
		out += ch;
	}
	// A range spanning `/` gains it explicitly: the raw name's slash occupies a
	// single encoded character, so it must remain an ordinary class member.
	return spansSlash ? out + SLASH_CODE : out;
}

/** Translate one class member, keeping escapes that picomatch honours. */
function translateClassMember(ch: string): string {
	if (ch === "/") return SLASH_CODE;
	if (ch === SLASH_CODE) return SLASH_CODE;
	return ch;
}

/**
 * Translate a glob pattern into the encoded domain, emitting raw-character
 * semantics for `?` and keeping grouping characters literal.
 */
function translatePattern(pattern: string): string {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			const next = pattern[i + 1];
			if (next === undefined) {
				out += "\\\\";
				continue;
			}
			// `\/`, `\§` and `\¤` become the plain encoded literal; every other
			// escape (`\*`, `\?`, `\\`, …) must survive as an escape.
			if (next === "/" || next === SLASH_CODE || next === ESCAPE_MARK) out += translateLiteral(next);
			else out += "\\" + next;
			i++;
			continue;
		}
		if (ch === "[") {
			const end = findClassEnd(pattern, i);
			if (end < 0) {
				out += "\\[";
				continue;
			}
			out += "[" + translateClassBody(pattern.slice(i + 1, end)) + "]";
			i = end;
			continue;
		}
		if (ch === "?") {
			out += RAW_CHAR;
			continue;
		}
		if (ch === "(" || ch === ")" || ch === "|") {
			out += "\\" + ch;
			continue;
		}
		out += translateLiteral(ch);
	}
	return out;
}

/** Transliterate a raw tool name into the slash-free matching domain. */
function encodeName(name: string): string {
	if (!name.includes("/") && !name.includes(SLASH_CODE) && !name.includes(ESCAPE_MARK)) return name;
	let out = "";
	for (const ch of name)
		out +=
			ch === "/"
				? SLASH_CODE
				: ch === SLASH_CODE
					? ESCAPE_MARK + SLASH_CODE
					: ch === ESCAPE_MARK
						? ESCAPE_MARK + ESCAPE_MARK
						: ch;
	return out;
}

/** Per-pattern matcher over raw tool names; cached across filter calls. */
type ToolMatcher = (name: string) => boolean;

const compiledPatterns = new Map<string, ToolMatcher>();

/** Compile one filter entry into a raw-name matcher. */
function compilePattern(pattern: string): ToolMatcher {
	const cached = compiledPatterns.get(pattern);
	if (cached !== undefined) return cached;
	let matcher: ToolMatcher;
	if (/[*?[\]{}\\]/.test(pattern)) {
		let compiled: ((name: string) => boolean) | null = null;
		try {
			compiled = picomatch(translatePattern(pattern), MATCH_OPTIONS);
		} catch {
			// A syntactically broken pattern never matches: it degrades to an
			// unmatched entry instead of disabling the server.
			compiled = null;
		}
		const globMatch = compiled;
		matcher = globMatch ? (name: string) => globMatch(encodeName(name)) : () => false;
	} else {
		matcher = (name: string) => name === pattern;
	}
	compiledPatterns.set(pattern, matcher);
	return matcher;
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries containing glob metacharacters
 * (`*`, `?`, `[...]`, `{...}`) are matched with fnmatch semantics over the raw
 * name — `/` is an ordinary character, and `*`/`?` cross it. Denylist entries
 * subtract from the allowlist when both are set.
 */
export function filterMCPTools(input: MCPToolFilterInput): MCPToolFilterResult {
	const { toolNames, enabledTools, disabledTools } = input;
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
