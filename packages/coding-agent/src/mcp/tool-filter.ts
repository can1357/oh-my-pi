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
 *
 * Entries come from the operator's own config, and a pathological one is
 * matched with the backtracking an equivalent hand-written regex would have:
 * a stack of `{*a,*}` alternations over a long non-matching name takes seconds.
 * That cost is the engine's (picomatch's own matcher is slower still) and
 * unchanged by this module; the patterns a real config uses cost microseconds.
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
 *
 * Each surrogate alternative carries the boundary check that makes it a whole
 * character: the high one only when no low follows, and the low one only when
 * no high PRECEDES it. Without the preceding check a lone high surrogate in the
 * pattern could consume the high half of a name whose low half the following
 * wildcard then claimed — `"\uD83D?"` admitted the single character `😀`.
 */
const RAW_CHAR =
	"(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF])";
/** Zero or more RAW characters, so a star cannot stop between the halves of a pair. */
const RAW_STAR = `(?:${RAW_CHAR})*`;

/**
 * Characters picomatch reads structurally, and the one-character escape that
 * defuses each. A `.` is included so that a brace range cannot be detected, and
 * a NUL because picomatch drops it while tokenizing.
 */
const STRUCTURAL: Record<string, string> = {
	"/": "\\x2F",
	".": "\\x2E",
	"|": "\\x7C",
	'"': "\\x22",
	"(": "\\x28",
	")": "\\x29",
	"\u0000": "\\x00",
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
 * Spell a pattern so that picomatch's structural reading cannot engage, and so
 * that every character keeps its literal meaning.
 *
 * A `\X` is a glob escape: it names the literal character `X`, whatever `X` is.
 * Forwarding the pair into the regex instead would let JavaScript's own escapes
 * take over — `\d` would mean "any digit" and select a tool named `5` rather
 * than the literal `d`, `\n` a newline rather than `n`, `\x41` the character
 * `A` rather than the text `x41`. Each escaped character is therefore spelled as
 * a `\xNN` escape of its own: one character wide, unambiguous to the parser,
 * and literal to the engine. A `\` with nothing after it names a literal
 * backslash.
 *
 * An unescaped structural character is spelled the same way, so `/`, `.`, `|`,
 * `(`, `)`, `"` and NUL cannot engage the machinery they drive — no `/` means no
 * separator handling, and no `|` means no alternation.
 */
function prepare(pattern: string): string {
	const characters = [...pattern];
	let out = "";
	for (let i = 0; i < characters.length; i++) {
		const ch = characters[i];
		if (ch === "\\") {
			// A trailing backslash names one literal backslash; otherwise the
			// character it escapes does, whatever that character is.
			const next = characters[i + 1];
			out += next === undefined ? escapeLiteral("\\") : escapeLiteral(next);
			if (next !== undefined) i++;
			continue;
		}
		out += STRUCTURAL[ch] ?? ch;
	}
	return out;
}

/**
 * Spell one literal character so the engine reads it as itself.
 *
 * Used for an escaped character, whose meaning is its literal spelling even when
 * that character is a glob metacharacter (`\*` names a literal star rather than
 * a wildcard) or a regex escape (`\d` names `d`).
 *
 * The escape has to be as wide as the character: a `\xNN` above Latin-1 would be
 * read as two characters by the engine (`\x3042` is `0` followed by `42`), and
 * the compiled regex carries no `u` flag, so an astral character is spelled as
 * the surrogate pair it occupies.
 */
function escapeLiteral(ch: string): string {
	const code = ch.codePointAt(0)!;
	if (code <= 0xff) return `\\x${hex(code, 2)}`;
	if (code <= 0xffff) return `\\u${hex(code, 4)}`;
	const offset = code - 0x10000;
	return `\\u${hex(0xd800 + (offset >> 10), 4)}\\u${hex(0xdc00 + (offset & 0x3ff), 4)}`;
}

/** Format a code unit as a fixed-width regex escape body. */
function hex(value: number, width: number): string {
	return value.toString(16).toUpperCase().padStart(width, "0");
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
	let body = token.value;
	// Picomatch appends `/` to a negated class; `/` is an ordinary member here,
	// so that injected member is dropped.
	if (body.startsWith("[^") && body.endsWith("/]")) body = `${body.slice(0, -2)}]`;
	return emitAstralClass(body) ?? body;
}

/** A surrogate pair, as the two code units the engine sees. */
const ASTRAL_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;

/**
 * Spell a class body so one class member is one RAW character.
 *
 * The compiled regex carries no `u` flag, so a class body is read by code unit:
 * `[\u{1F600}]` is the two members U+D83D and U+DE00, which admits half of an
 * astral character while rejecting the character itself, and a negated class
 * refuses the character it should admit. Every other member reads correctly by
 * code unit, so only the pairs are lifted out — into an alternation for a
 * positive class, and into exclusions for a negated one, leaving the rest of the
 * body as the engine's to read.
 *
 * Returns null when the body has no pair (the common case, left exactly as
 * written) or holds a range, whose endpoints are the engine's to interpret.
 */
function emitAstralClass(body: string): string | null {
	const negated = body.startsWith("[^");
	const members = negated ? body.slice(2, -1) : body.slice(1, -1);
	// `prepare` spells an escaped character as a `\xNN`/`\uNNNN` escape of its
	// own, so a member the user escaped arrives in that form; reading the
	// spellings back is what lets an escaped pair be recognised as one too.
	const spelling = decodeGlobEscapes(unescapePatternText(members));
	// A positive class only needs the rewrite when a member is a pair; every
	// other member already reads correctly by code unit.
	if (!negated && !ASTRAL_PAIR.test(spelling)) return null;
	// A negated class always needs it: reading by code unit would let one member
	// claim half of an astral character, which the class must refuse, and would
	// refuse the whole character where it should admit it.
	if (members.includes("-")) return null;
	const rewritten = unescapePatternText(members);
	if (rewritten.includes("-")) return null;
	// A leading `]` is a member, not the terminator; it is already escaped by
	// the time a token value is visible, which is why the slice above is safe.
	const pairs: string[] = [];
	let units = "";
	for (const member of [...rewritten]) {
		if (member.length === 2) pairs.push(member);
		else units += member;
	}
	if (!negated) {
		const alternatives = [...pairs, ...(units ? [`[${units}]`] : [])];
		return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join("|")})`;
	}
	// Every member is excluded, so the class admits exactly one raw character
	// that is none of them — an astral character included, which a code-unit
	// reading would have refused.
	const guards = [...pairs.map(pair => `(?!${pair})`), ...(units ? [`(?![${units}])`] : [])].join("");
	if (guards === "") return RAW_CHAR;
	return `(?:${guards}${RAW_CHAR})`;
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
				// A literal brace (`\(`/`\}` inside an alternation, or the escaped
				// spelling picomatch gives a pair without a comma) never touches the
				// stack: only a paired delimiter brackets a real branch list.
				case "brace": {
					if (!paired.has(token)) return emitText(token.value);
					if (token.value === "{") {
						open.push(token);
						return "(";
					}
					open.pop();
					return ")";
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
 * Only a `{` whose matching `}` follows opens one, so `a{b` stays literal while
 * an alternation nested after it still alternates. A pair that closes without a
 * comma at its own level never reaches here as a group — picomatch has already
 * spelled it escaped.
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
 * Does this brace token carry an alternation expression's spelling?
 *
 * Picomatch commits to an expression as soon as it reads a `{`, so an unmatched
 * one still carries a group's spelling; pairing them is what tells the two
 * apart.
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

/**
 * Characters a class is probed against when its members must be enumerated.
 *
 * The printable ASCII range covers every tool name in practice. A class that
 * reaches outside it cannot be enumerated from this alphabet, so it is declined
 * rather than reported as the members that happen to fall inside.
 */
const CLASS_ALPHABET = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));

/**
 * The characters a class token admits, or null when it cannot be enumerated.
 *
 * A token value may carry picomatch's own spelling as well as the raw one, so
 * the members are read from the engine rather than from the spelling: the class
 * is compiled and each candidate asked. A negated member list admits nearly
 * every character, a range may reach outside the probe alphabet, and a value
 * spelling any character outside it may admit one, so each of those is declined
 * — the caller then treats the pattern as selecting something it cannot name
 * rather than concluding it selects nothing.
 */
function classMembers(token: Token): string[] | null {
	if (token.value.startsWith("[^") || token.value.includes("-")) return null;
	if ([...token.value].some(ch => !CLASS_ALPHABET.includes(ch))) return null;
	let regex: RegExp;
	try {
		regex = new RegExp(`^(?:${token.value})$`);
	} catch {
		// A class the engine rejects — an unclosed one such as `[]?` — names
		// nothing this walk can state, so the caller stays conservative.
		return null;
	}
	const members = CLASS_ALPHABET.filter(ch => regex.test(ch));
	return members.length === 0 ? null : members;
}

/** What one token contributes to the names a pattern can match, or null if unbounded. */
function enumerateToken(token: Token): string[] | null {
	switch (token.type) {
		case "bos":
		case "eos":
		case "maybe_slash":
			return [];
		// `*` spans any run and `?` any character, so neither has a nameable set.
		case "star":
		case "globstar":
		case "qmark":
			return null;
		case "bracket":
			return classMembers(token);
		case "brace":
			// An alternation selects among branches, which this flat walk does
			// not model; a brace that does not alternate is a literal character.
			if (isAlternationDelimiter(token)) return null;
			return [token.value.endsWith("}") ? "}" : "{"];
		default:
			// A text token may carry picomatch's own escaping for a character
			// that is special to a regex (`\+`, `\^`). Reading those candidates
			// against the matcher, rather than trusting the spelling here, is
			// what keeps a mis-decoded candidate from being reported as a name.
			return [...new Set([token.value, unescapePatternText(token.value), decodeGlobEscapes(token.value)])];
	}
}

/**
 * Turn a `\xNN`/`\uNNNN` spelling back into the character it names.
 *
 * A candidate only; the caller verifies each one against the matcher, so a
 * spelling that was never one of this module's escapes simply fails that check.
 */
function unescapePatternText(value: string): string {
	return value.replaceAll(/\\x([0-9A-F]{2})|\\u([0-9A-F]{4})/g, (_match, byte: string, unit: string) =>
		String.fromCharCode(Number.parseInt(byte ?? unit, 16)),
	);
}

/**
 * Read a glob escape's character: `\\+` names `+`, `\\d` names `d`.
 *
 * Only a candidate; the matcher confirms it, so a backslash that was not an
 * escape in the original pattern is rejected rather than reported.
 */
function decodeGlobEscapes(value: string): string {
	return value.replaceAll(/\\(.)/g, "$1");
}

/**
 * The concrete names a pattern can match, when it can match few enough to name.
 *
 * Returns null when the pattern reaches beyond enumeration: `*` and `?` match an
 * unbounded set, an alternation picks among branches this walk does not model,
 * and a class may admit characters the probe alphabet cannot show. A caller
 * asking whether a filter selects something outside a known name set must read
 * null as "it can" — that is the answer that keeps a server rather than
 * dropping one whose tools were merely not enumerable.
 *
 * Every candidate this walk builds is confirmed against the pattern's own
 * matcher before it is reported, so a mis-read token can only narrow the result
 * to nothing — and an empty result is reported as "cannot enumerate" — never
 * widen it to a name the pattern does not actually match. A pattern the parser
 * rejects cannot be enumerated either.
 */
export function enumeratePatternNames(pattern: string, limit = 64): string[] | null {
	let matcher: ToolMatcher;
	let tokens: Token[];
	try {
		matcher = compilePattern(pattern);
		tokens = parseTokens(prepare(pattern), PARSE_OPTIONS);
	} catch {
		// A pattern the parser rejects (an over-long one included) names nothing
		// this walk can state; the caller stays conservative.
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
				if (next.length >= limit) return null;
				next.push(name + part);
			}
		}
		names = next;
	}
	const matched = names.filter(name => matcher(name));
	return matched.length === 0 ? null : matched;
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
