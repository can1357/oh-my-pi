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
 * Matching a config entry against an advertised tool name.
 *
 * A name is sanitized before matching: every character outside
 * `[A-Za-z0-9_-]` becomes one `_`, because every practical MCP server
 * advertises identifier-like names and picomatch's glob semantics are defined
 * for such strings. The raw name is kept everywhere else — the filter is a
 * filter, not a renamer — and a name outside the alphabet matches the pattern
 * written for its sanitized spelling. Distinct raw names sanitizing to the
 * same spelling collide by design: the same trade every major agent makes.
 *
 * Matching itself is picomatch's, on both spellings of a name (raw and
 * sanitized — a pattern written for a name's literal spelling addresses that
 * spelling, while the sanitized domain is how a name holding exotic characters
 * is reached), with path semantics harmless here (sanitized names hold no `/`
 * and no leading dot). Picomatch's glob semantics are the contract: an escape
 * means what it means in a glob (`\d` is a digit, `\n` a newline), a bare `|`
 * alternates, and a bare `"` is quoted before compiling so it stays ordinary.
 * A literal entry — no glob metacharacter — is exact equality on the
 * sanitized spellings, so a tool name containing glob metacharacters still
 * matches the pattern written for its look. A pattern the compiler rejects
 * degrades to a never-matching entry instead of disabling the server, and
 * entries are never environment-expanded.
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
 * A name as the matcher sees it: one `_` per character outside the identifier
 * alphabet, counted by code point, so an astral character collapses to one
 * underscore and `?` spans one name character as it always did.
 */
function sanitizeToolName(name: string): string {
	return [...name].map(ch => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_")).join("");
}

/**
 * Picomatch's parser reads a bare `"` as a quote and derails (a lone one
 * compiles to an empty match); a quoted escape restores the ordinary
 * character. Applied to every compiled pattern.
 */
function quoteDoubles(pattern: string): string {
	return pattern.replaceAll('"', '\\"');
}

interface Token {
	type: string;
	value: string;
	output?: string;
}

/** Per-pattern matcher over sanitized tool names; cached across filter calls. */
type ToolMatcher = (name: string) => boolean;

const compiledPatterns = new Map<string, ToolMatcher>();

/** Compile one filter entry into a matcher over sanitized tool names. */
/** Does the pattern hold three or more consecutive backslashes? */
function backslashRun(pattern: string): boolean {
	return /\\{3}/.test(pattern);
}

/** Compile one filter entry into a matcher over sanitized tool names. */
function compilePattern(pattern: string): ToolMatcher {
	const cached = compiledPatterns.get(pattern);
	if (cached !== undefined) return cached;

	let matcher: ToolMatcher;
	if (backslashRun(pattern)) {
		// Picomatch's parser never returns once its input carries four or more
		// consecutive backslashes — an infinite loop no `try`/`catch` can
		// rescue — so such a pattern is rejected before the parser is entered.
		// A legitimate identifier entry never holds one: three backslashes
		// spell two escaped characters, and a backslash is never part of a
		// sanitized name anyway.
		matcher = () => false;
	} else if (/[*?[\]{}\\]/.test(pattern)) {
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
			const regex = picomatch.makeRe(quoteDoubles(pattern), PARSE_OPTIONS);
			matcher = (name: string) => regex.test(name) || regex.test(sanitizeToolName(name));
		} catch {
			// A pattern the engine rejects — a descending class range such as
			// `[z-a]`, for instance — never matches anything, and degrading to
			// an unmatched entry beats disabling the server.
			matcher = () => false;
		}
	} else {
		// A pattern with no glob metacharacter addresses its own spelling —
		// and the sanitized spelling of both sides, so a name holding a
		// metacharacter still matches the pattern written for its look.
		matcher = (name: string) => sanitizeToolName(name) === sanitizeToolName(pattern);
	}

	compiledPatterns.set(pattern, matcher);
	return matcher;
}

/**
 * The characters one class admits, or null when it cannot be enumerated: a
 * negated list, or a range whose endpoints are not single ASCII characters
 * (a small ASCII range is expanded; anything wider reaches beyond the walk's
 * alphabet). Picomatch's own regex escapes in the token value (`\+`) are
 * probed against the compiled class rather than decoded here, so a mis-read
 * spelling can only narrow the result, never widen it.
 */
function classCandidates(value: string): string[] | null {
	if (value.startsWith("[^")) return null;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
	if ([...value].some(ch => !alphabet.includes(ch) && !["\\", "-", "[", "]"].includes(ch))) return null;
	let regex: RegExp;
	try {
		regex = new RegExp(`^(?:${value})$`);
	} catch {
		// A class the engine rejects — an unclosed one, for instance — names
		// nothing this walk can state, so the caller stays conservative.
		return null;
	}
	const members = [...alphabet].filter(ch => regex.test(ch));
	return members.length === 0 ? null : members;
}

/**
 * Split a brace body on its top-level commas, with nested braces and classes
 * opaque; empty when the body holds none, which leaves the group literal.
 */
function splitBraceBody(body: string): string[] {
	const chars = [...body];
	const branches: string[] = [];
	let current = "";
	let depth = 0;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "\\") {
			current += ch + (chars[i + 1] ?? "");
			i++;
		} else if (ch === "{") {
			depth++;
			current += ch;
		} else if (ch === "}") {
			depth--;
			current += ch;
		} else if (ch === "[" && depth === 0) {
			let j = i + 1;
			if (chars[j] === "^") j++;
			if (chars[j] === "]") j++;
			let text = ch;
			while (j < chars.length) {
				if (chars[j] === "\\") {
					text += chars[j] + (chars[j + 1] ?? "");
					j += 2;
					continue;
				}
				text += chars[j];
				if (chars[j] === "]") break;
				j++;
			}
			current += text;
			i = j;
		} else if (ch === "," && depth === 0) {
			branches.push(current);
			current = "";
		} else current += ch;
	}
	branches.push(current);
	return branches.length === 1 ? [] : branches;
}

/**
 * Expand every brace group that holds a top-level comma into one pattern per
 * branch, or null when the product passes the limit. A group without one is
 * literal text and stays, as does an unmatched `{`; classes are opaque to
 * both scans.
 */
function expandBraces(pattern: string, limit: number): string[] | null {
	const chars = [...pattern];
	let i = 0;
	while (i < chars.length) {
		const ch = chars[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			if (chars[j] === "^") j++;
			if (chars[j] === "]") j++;
			while (j < chars.length) {
				if (chars[j] === "\\") {
					j += 2;
					continue;
				}
				if (chars[j] === "]") break;
				j++;
			}
			i = j + 1;
			continue;
		}
		if (ch !== "{") {
			i++;
			continue;
		}
		let depth = 0;
		let j = i + 1;
		let hasComma = false;
		while (j < chars.length) {
			if (chars[j] === "\\") {
				j += 2;
				continue;
			}
			if (chars[j] === "[") {
				let k = j + 1;
				if (chars[k] === "^") k++;
				if (chars[k] === "]") k++;
				while (k < chars.length) {
					if (chars[k] === "\\") {
						k += 2;
						continue;
					}
					if (chars[k] === "]") break;
					k++;
				}
				j = k + 1;
				continue;
			}
			if (chars[j] === "{") depth++;
			else if (chars[j] === "}") {
				if (depth === 0) break;
				depth--;
			} else if (chars[j] === "," && depth === 0) hasComma = true;
			j++;
		}
		if (j >= chars.length || !hasComma) {
			// An unmatched brace, or a literal group: keep scanning past it.
			i = j >= chars.length ? i + 1 : j + 1;
			continue;
		}
		const prefix = chars.slice(0, i).join("");
		const suffix = chars.slice(j + 1).join("");
		const results: string[] = [];
		for (const branch of splitBraceBody(chars.slice(i + 1, j).join(""))) {
			const expansions = expandBraces(`${prefix}${branch}${suffix}`, limit);
			if (expansions === null) return null;
			for (const expansion of expansions) {
				if (results.length >= limit) return null;
				results.push(expansion);
			}
		}
		return results;
	}
	return [pattern];
}

/**
 * What one token contributes to the names a pattern can match, or null when
 * it spans a set this flat walk does not name.
 *
 * A brace or comma token is offered as text: a real alternation's spelling
 * never survives the matcher's verification, so the walk can only narrow. A
 * bracket token offers its class members when enumerable, beside the same
 * text candidates — picomatch spells an escaped literal bracket (`\[]`) as a
 * bracket token too, and its spelling is text there.
 */
function enumerateToken(token: Token): string[] | null {
	switch (token.type) {
		case "bos":
		case "eos":
		case "maybe_slash":
			return [];
		// A star or question spans an unbounded set; an alternation picks among
		// branches this walk does not model.
		case "star":
		case "globstar":
		case "qmark":
			return null;
		case "bracket": {
			const members = classCandidates(token.value);
			return members === null
				? textCandidates(token.value)
				: [...new Set([...members, ...textCandidates(token.value)])];
		}
		default:
			return textCandidates(token.value);
	}
}

/**
 * The spellings one text token can address: its own value, and the value with
 * picomatch's regex escapes (`\+`) read back as the character they name.
 * Letting the matcher confirm the candidates keeps a mis-read spelling from
 * being reported as a name the pattern does not select.
 */
function textCandidates(value: string): string[] {
	return [...new Set([value, value.replaceAll(/\\(.)/g, "$1")])];
}

/**
 * The concrete names a pattern can match, when it can match few enough to
 * name.
 *
 * Returns null when the pattern reaches beyond enumeration: `*` and `?` match
 * an unbounded set, an alternation picks among branches this walk does not
 * model, and a class may admit characters outside the walk's alphabet. A
 * caller asking whether a filter selects something outside a known name set
 * must read null as "it can" — that is the answer that keeps a server rather
 * than dropping one whose tools were merely not enumerable.
 *
 * Every candidate is confirmed against the pattern's own matcher before it is
 * reported, so a mis-read token can only narrow the result to nothing — and an
 * empty result is reported as "cannot enumerate" — never widen it to a name
 * the pattern does not actually match. Both the raw and the sanitized spelling
 * of each candidate are offered, so enumeration and matching agree on the
 * domain.
 */
export function enumeratePatternNames(pattern: string, limit = 64): string[] | null {
	let matcher: ToolMatcher;
	try {
		matcher = compilePattern(pattern);
	} catch {
		return null;
	}
	const expansions = expandBraces(pattern, limit);
	if (expansions === null) return null;
	const candidates: string[] = [];
	for (const expansion of expansions) {
		let tokens: Token[];
		try {
			tokens = (picomatch.parse as unknown as (p: string, o: typeof PARSE_OPTIONS) => { tokens: Token[] })(
				quoteDoubles(expansion),
				PARSE_OPTIONS,
			).tokens;
		} catch {
			// A pattern the parser rejects (an over-long one included) names
			// nothing this walk can state; the caller stays conservative.
			return null;
		}
		let names = [""];
		for (const token of tokens) {
			const parts = enumerateToken(token);
			if (parts === null) return null;
			if (parts.length === 0) continue;
			const next: string[] = [];
			for (const name of names) {
				for (const part of parts) {
					// Sanitized candidates too: the matcher works on that domain.
					for (const candidate of new Set([name + part, sanitizeToolName(name + part)])) {
						if (next.length >= limit) return null;
						next.push(candidate);
					}
				}
			}
			names = next;
		}
		const matched = names.filter(name => matcher(name));
		for (const name of matched) {
			if (candidates.length >= limit) return null;
			candidates.push(name);
		}
	}
	const unique = [...new Set(candidates)];
	return unique.length === 0 ? null : unique;
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries containing glob metacharacters
 * (`*`, `?`, `[...]`, `{a,b}`) are matched with picomatch's glob semantics
 * over the sanitized name. Denylist entries subtract from the allowlist when
 * both are set.
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
			{ path: `mcp:${serverName}` },
		);
		return [];
	}

	const allowedSet = new Set(allowed);
	return tools.filter(t => allowedSet.has(t.name));
}
