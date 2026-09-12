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
 * Compiling an `enabledTools` / `disabledTools` entry into a matcher over raw
 * tool names.
 *
 * Tool names are opaque strings, not paths: `/` is an ordinary character, `*`
 * and `?` cross it, and a class member list is read against raw characters.
 * Picomatch's tokenizer already implements the whole documented glob grammar —
 * class bodies and POSIX classes, brace alternation, escapes, quotes — so its
 * tokens are what this module consumes. Its matcher assembly is never used:
 * every decoration picomatch adds while assembling one (`[^/]` for a star,
 * `/` appended to a negated class, dot-segment guards, the trailing `\/?`)
 * encodes path semantics that do not apply here.
 *
 * Two hazards are handled by rewriting the pattern before it is parsed:
 *
 * - Characters picomatch would read structurally are folded into `\xNN`
 *   escapes (`/`, `|`, `(`, `)`, `"`). Each escape is one character wide and
 *   matches its character exactly, so the pattern's meaning is unchanged while
 *   the structural machinery cannot engage at all: no `/` means no separator
 *   handling, and no grouping, quote or alternation reading is available to
 *   distort a pattern that means those characters literally.
 * - A run of `\\` becomes `\u005C`. Picomatch's parser never returns once its
 *   input carries a class followed by four or more consecutive backslashes —
 *   an infinite loop that no `try`/`catch` can rescue, so a config entry could
 *   pin the event loop instead of degrading to an unmatched entry.
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
 * One RAW character: an astral pair, one non-surrogate code unit, an unpaired
 * high surrogate, or a lone low surrogate.
 *
 * Spelled as an alternation rather than a bare negated class because the
 * compiled regex carries no `u` flag — class bodies keep picomatch's Annex-B
 * spellings, which `u` rejects, and `u` would also reject the descending range
 * a user is allowed to write. Without `u` a negated class consumes one UTF-16
 * code unit, so `?` would claim half of an astral character: `tool_?` would
 * miss `tool_😀` while `tool_??` matched it.
 */
const RAW_CHAR =
	"(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|[\\uDC00-\\uDFFF])";
/** Zero or more RAW characters, so a star cannot stop between the halves of a pair. */
const RAW_STAR = `(?:${RAW_CHAR})*`;

/** Characters picomatch reads structurally, and the one-character escape that defuses each. */
const NEUTRALIZE: Record<string, string> = {
	"/": "\\x2F",
	".": "\\x2E",
	"|": "\\x7C",
	'"': "\\x22",
	"(": "\\x28",
	")": "\\x29",
};

/** Regex syntax a literal tool-name character must not leave live in the pattern. */
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;

interface Token {
	type: string;
	value: string;
	output?: string;
}

/** The option set `parse` consumes; `strictBrackets` is used for re-reads. */
type ParseOptions = typeof PARSE_OPTIONS & { strictBrackets?: boolean };

/**
 * Parse a pattern into tokens.
 *
 * `@types/picomatch` declares `parse` as taking `{ maxLength?: number }` only,
 * although the runtime accepts the full option set; the cast is that declaration
 * gap and nothing more.
 */
function parseTokens(pattern: string, options: ParseOptions): Token[] {
	const state = picomatch.parse(pattern, options as unknown as { maxLength?: number }) as unknown as {
		tokens: Token[];
	};
	return state.tokens;
}

/**
 * Defuse the characters picomatch would read structurally, keeping a user's own
 * escape in front of one meaningful: `\/` and `/` both mean the literal slash.
 */
function prepare(pattern: string): string {
	return pattern
		.replaceAll("\\\\", "\\u005C")
		.replaceAll(/\\([./|"()])|([./|"()])/g, (_match, escaped: string, bare: string) => NEUTRALIZE[escaped ?? bare]);
}

/**
 * Emit text in its raw spelling as regex source.
 *
 * Text tokens come back in raw glob spelling, so regex syntax among them is
 * escaped here: `a{b` stays literal, a literal `(` does not group, and a
 * literal `.` does not become "any character". A `\` the user wrote is regex
 * syntax already, so it passes through with the character it escapes — which
 * also keeps the `\u005C` spelling of a literal backslash intact.
 */
function emitText(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch !== "\\") {
			out += REGEX_SYNTAX.test(ch) ? `\\${ch}` : ch;
			continue;
		}
		const next = value[i + 1];
		if (next === undefined) {
			// A trailing backslash addresses one literal backslash.
			out += "\\\\";
			break;
		}
		out += `\\${next}`;
		i++;
	}
	return out;
}

/** Emit one token that carries no brace or class structure. */
function emitSimple(token: Token): string {
	switch (token.type) {
		// Pattern boundaries, and picomatch's optional trailing separator.
		case "bos":
		case "eos":
		case "maybe_slash":
			return "";
		case "star":
		case "globstar":
			// Any run of stars is one star: both cross `/`, so `**` carries no
			// extra meaning for an opaque name.
			return RAW_STAR;
		case "qmark":
			return RAW_CHAR;
		default:
			return emitText(token.value);
	}
}

/**
 * Emit a class body as regex source.
 *
 * The body is emitted verbatim: the engine's own reading of its members
 * (negation, escapes, ranges, Annex-B corners) is what a user expects, and a `/`
 * member reaches the tool as a slash. Picomatch appends `/` to a negated class,
 * where `/` is an ordinary member here, so that injected member is dropped.
 */
function emitClass(token: Token): string {
	if (!token.value.startsWith("[^")) return token.value;
	return token.value.endsWith("/]") ? `${token.value.slice(0, -2)}]` : token.value;
}

/**
 * Re-read a class that its own scan never closed.
 *
 * Picomatch reads a `]` directly after `[` or `[^` as a MEMBER, so `[]?` leaves
 * the class open and swallows the rest of the pattern into that one token,
 * whose own repair then escapes the `[` and treats the trailing `?` as a member.
 * A glob's `[` with no closing bracket is a literal that swallows nothing: the
 * `?` stays a one-character wildcard and the entry addresses `[]` followed by
 * any character. Reparsing the token's spelling with its `[` spelled `\x5B`
 * restores that, and the remainder parses as ordinary glob syntax.
 */
function reparseUnclosedClass(token: Token): string {
	return emitTokens(parseTokens(`\\x5B${token.value.slice(1)}`, PARSE_OPTIONS));
}

/**
 * Emit a token stream as regex source in the raw-character domain.
 *
 * Picomatch commits to an expression as soon as it reads a `{`, so an unmatched
 * one still carries a group's spelling — the delimiters are therefore paired
 * here before anything is emitted, and only a matched pair alternates.
 */
function emitTokens(tokens: Token[]): string {
	const paired = pairedBraceTokens(tokens);
	const open: Token[] = [];
	return tokens
		.map(token => {
			switch (token.type) {
				case "brace": {
					if (token.value === "{") {
						open.push(token);
						return paired.has(token) ? "(" : emitText(token.value);
					}
					const start = open.pop();
					return start !== undefined && paired.has(start) ? ")" : emitText(token.value);
				}
				// A comma separates branches only at the top level of a real
				// alternation; anywhere else it is an ordinary character.
				case "comma": {
					const start = open.at(-1);
					return start !== undefined && paired.has(start) ? "|" : emitText(token.value);
				}
				case "bracket":
					return isClosedClass(token) ? emitClass(token) : reparseUnclosedClass(token);
				default:
					return emitSimple(token);
			}
		})
		.join("");
}

/**
 * The brace tokens that really delimit a `{a,b}` alternation.
 *
 * Only a `{` whose matching `}` follows opens one; a pair without a comma at its
 * own level is already spelled escaped by the time tokens are visible, which is
 * what keeps `{a}` and `{1..3}` literal while `a{b` stays literal and a nested
 * alternation inside it still works.
 */
function pairedBraceTokens(tokens: Token[]): Set<Token> {
	const paired = new Set<Token>();
	const open: Token[] = [];
	for (const token of tokens) {
		if (token.type !== "brace") continue;
		if (token.value === "{" && isAlternationDelimiter(token)) {
			open.push(token);
		} else if (token.value === "}" && isAlternationDelimiter(token) && open.length > 0) {
			paired.add(open.pop()!);
			paired.add(token);
		}
	}
	return paired;
}

/**
 * Does this brace token delimit a real `{a,b}` alternation?
 *
 * Picomatch commits to an expression as soon as it reads a `{`, so an unmatched
 * one still carries a group's spelling in `output`. A pair without a comma at
 * its own level is already spelled escaped by the time tokens are visible, which
 * is what makes `{a}` and `{1..3}` literal while `{a,b}` alternates.
 */
function isAlternationDelimiter(token: Token): boolean {
	return (token.value === "{" && token.output === "(") || (token.value === "}" && token.output === ")");
}

/**
 * Was this class token closed by a bracket of its own?
 *
 * Picomatch's repair pass leaves its bracket count back at zero, so the token is
 * the only evidence. Asking the parser with `strictBrackets` applies the same
 * boundary rule the class was scanned with: an unclosed class raises where a
 * closed one does not.
 */
function isClosedClass(token: Token): boolean {
	try {
		parseTokens(token.value, { ...PARSE_OPTIONS, strictBrackets: true });
		return true;
	} catch {
		return false;
	}
}

/** Per-pattern matcher over raw tool names; cached across filter calls. */
type ToolMatcher = (name: string) => boolean;

const compiledPatterns = new Map<string, ToolMatcher>();

/** Compile one filter entry into a matcher over raw tool names. */
function compilePattern(pattern: string): ToolMatcher {
	const cached = compiledPatterns.get(pattern);
	if (cached !== undefined) return cached;

	let matcher: ToolMatcher;
	if (/[*?[\]{}\\]/.test(pattern)) {
		try {
			matcher = compileGlobMatcher(pattern);
		} catch {
			// A pattern the engine rejects — a descending class range such as
			// `[z-a]` never matches anything — degrades to an unmatched entry
			// instead of disabling the server.
			matcher = () => false;
		}
	} else {
		// A pattern with no glob metacharacter addresses its own spelling.
		matcher = (name: string) => name === pattern;
	}

	compiledPatterns.set(pattern, matcher);
	return matcher;
}

/** Build the matcher for an entry that contains glob metacharacters. */
function compileGlobMatcher(pattern: string): ToolMatcher {
	const body = emitTokens(parseTokens(prepare(pattern), PARSE_OPTIONS));
	const regex = new RegExp(`^(?:${body})$`);
	return (name: string) => regex.test(name);
}

/**
 * Apply a per-server tool filter.
 *
 * Literal entries match exactly; entries containing glob metacharacters
 * (`*`, `?`, `[...]`, `{a,b}`) are matched with fnmatch semantics over the raw
 * name — `/` is an ordinary character, and both `*` and `?` cross it. Denylist
 * entries subtract from the allowlist when both are set.
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
