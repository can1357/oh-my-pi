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
 *   exists in the encoded domain). picomatch's path-shaped dot-segment guard is
 *   stripped after compilation: tool names are opaque, so a wildcard may match a
 *   name the server literally called `.` or `..`.
 * - Character classes compile their body VERBATIM — the engine's own class
 *   semantics (negation, escapes, ranges, Annex-B corners) are already right
 *   for every member but the three reserved code points. Those are decided in
 *   the RAW domain (whether the class admits `/`, `§` or `¤`) and then spelled
 *   as their encoded units: `/` → `§`, `§` → `¤§`, `¤` → `¤¤`. The verbatim
 *   class is guarded so it can never consume a bare sentinel or escape marker,
 *   which in an encoded name always belong to a raw `/`, `§` or `¤`. A class
 *   range therefore never widens into the code points between its endpoints,
 *   and a negated class stays exact even when a member is two characters wide.
 *   `[!a]` is a literal `!` and `a` (picomatch reads `!` as negation only under
 *   its `posix` option, which is off).
 * - `(`, `)`, `|` and `+` are escaped, so grouping, alternation and extglob
 *   prefixes stay literal even beside a wildcard: `+(a|b)*` matches the literal
 *   `+(a|b)foo`, not `+afoo`. `+` is always escaped because emitted forms end in
 *   `)`/`]`, which a following `+` would otherwise quantify. A leading `!`, an
 *   extglob prefix and braces outside the supported surface
 *   behave likewise: only `*`, `?`, `[...]` and `{a,b}` carry meaning.
 */
const MATCH_OPTIONS = { dot: true, nonegate: true, noextglob: true, windows: false } as const;

/** Character a transliterated `/` is replaced with. */
const SLASH_CODE = "§";
/** Escape marker for the two encoding characters (`§`, `¤`). */
const ESCAPE_MARK = "¤";
/**
 * Matches exactly one RAW character of an encoded name: one of the two-char
 * escape units (`¤§`, `¤¤`), or one character that is not the escape marker.
 *
 * The non-unit alternatives are spelled per UTF-16 width rather than as the
 * bare `[^¤]` the encoded domain would suggest. The compiled regex is not a
 * `u`-mode one (its classes carry picomatch's own Annex-B spellings, which `u`
 * rejects), so a bare negated class consumes one UTF-16 code unit and a `?`
 * would claim half of an astral character — `tool_?` missed `tool_😀` while
 * `tool_??` matched it. One raw character is one BMP character, one surrogate
 * PAIR, or one UNPAIRED surrogate (the high one only when no low follows, so a
 * pair can never be consumed as two characters). Written as a group alternation
 * rather than `{…}` so a user's own brace alternation in the same pattern cannot
 * be merged with it by picomatch.
 */
const RAW_CHAR = `(?:${ESCAPE_MARK}${SLASH_CODE}|${ESCAPE_MARK}${ESCAPE_MARK}|[^${ESCAPE_MARK}\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|[\\uDC00-\\uDFFF])`;

/** Translate one literal (non-glob) character into the encoded domain. */
function translateLiteral(ch: string): string {
	if (ch === "/") return SLASH_CODE;
	if (ch === SLASH_CODE) return ESCAPE_MARK + SLASH_CODE;
	if (ch === ESCAPE_MARK) return ESCAPE_MARK + ESCAPE_MARK;
	return ch;
}

/**
 * Locate the `}` closing a `{a,b}` alternation opened at `open`, or -1 when the
 * braces do not form one.
 *
 * Only a brace group that contains a comma at its own nesting level alternates;
 * `{a}` and `a{b` are literal text with braces, and picomatch itself treats the
 * unmatched forms as literal only when they do not reach its parser as an
 * expression. Nested groups count (`{a,{b,c}}` alternates), and `a{b,c}d` does
 * not alternate because the group is not the whole entry.
 */
function findAlternationEnd(pattern: string, open: number): number {
	let depth = 0;
	let hasComma = false;
	for (let i = open; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "[") {
			// A class is opaque here: its members are not braces or commas, so
			// `{[}],a}` alternates the class `[}]` with `a` rather than ending at
			// the class's own `}`. An unclosed class runs to the end of the
			// pattern, where no alternation can close — the caller then treats the
			// brace as literal, matching how the class itself degrades.
			const end = findClassEnd(pattern, i);
			if (end < 0) return -1;
			i = end;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return hasComma ? i : -1;
		} else if (ch === "," && depth === 1) hasComma = true;
	}
	return -1;
}

/**
 * picomatch's POSIX bracket-class table, read from the library rather than
 * copied: a hand-maintained duplicate is a second source of truth that drifts
 * silently whenever picomatch changes a class.
 */
const POSIX_CLASS_SOURCE: Record<string, string> = picomatch.constants.POSIX_REGEX_SOURCE;

/**
 * Locate the `]` closing the class opened at `open`, following picomatch's own
 * boundary rules: a `]` directly after `[` or `[^` is a literal member, an
 * escaped `]` never closes, `!` is an ordinary member, and a POSIX bracket
 * class is one member whose expansion swallows its own brackets.
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
		// picomatch's `posix` is on by default, so `[:name:]` is expanded before
		// the class is compiled: its `[` becomes the table's source and its `]`
		// disappears, which leaves the NEXT `]` to close the class —
		// `[[:alpha:]]` compiles as `[a-zA-Z]`. Consume the whole group here so
		// the inner `]` is not mistaken for the terminator. An unknown name is
		// literal, matching picomatch, and falls through to the plain scan.
		const posix = pattern.slice(i).match(/^\[:[a-z]+:\]/);
		if (posix && POSIX_CLASS_SOURCE[pattern.slice(i + 2, i + posix[0].length - 2)]) {
			i += posix[0].length - 1;
			continue;
		}
		if (pattern[i] === "]") return i;
	}
	return -1;
}

/** Code point a transliterated `/` occupies in the encoded domain. */
const SLASH_CODEPOINT = 0x2f;
/** Code point of the escape marker, and of the sentinel it escapes. */
const ESCAPE_MARK_CODEPOINT = ESCAPE_MARK.codePointAt(0)!;
const SENTINEL_CODEPOINT = SLASH_CODE.codePointAt(0)!;
/**
 * Rewrite a class body into the spelling the `RegExp` constructor reads the
 * same way picomatch's class compiler does.
 *
 * The two readings diverge in exactly one place: a `]` immediately after `[` or
 * `[^` is a literal MEMBER, but a bare `new RegExp("[^]]")` reads `[^]` as
 * Annex B's empty negated class and takes the second `]` as a stray literal —
 * so `[^]]` ("everything but `]`") instead means "any one character, then `]`".
 * Escaping that single member is the whole normalization.
 */
function normalizeClassBody(body: string): string {
	return body.replace(/^(\^?)\]/, "$1\\]");
}

/**
 * Does this class body admit the raw code point `cp`?
 *
 * The regex engine is the oracle, not a hand-rolled class parser: a class body
 * is full of engine-specific corners (a leading `]` member, escapes, a trailing
 * `-`, and Annex-B range quirks like `[\--^]`), and re-deriving them is how a
 * glob translator silently changes meaning. picomatch itself compiles the body
 * verbatim elsewhere in this module; here the engine answers one question.
 *
 * No `u` flag, matching picomatch's own `new RegExp(source, opts.flags || "")`:
 * a class is compiled the same way in both places, so Annex-B leniency such as
 * `\a` or a descending range resolves identically.
 */
function classAdmits(body: string, cp: number): boolean {
	try {
		return new RegExp(`^[${normalizeClassBody(body)}]$`).test(String.fromCodePoint(cp));
	} catch {
		return false;
	}
}

/**
 * Translate a character-class body (`[`…`]` contents) into the encoded domain.
 *
 * The body is compiled VERBATIM: every member except the three reserved code
 * points maps 1:1, so the engine's own class semantics (escapes, ranges, the
 * Annex-B corners) are already correct for them. `classAdmits` answers, in the
 * RAW domain, whether a reserved code point is in the class's membership set —
 * which is what decides how that member must be spelled on the encoded side:
 *
 * - a raw `/` is the sentinel `§`,
 * - a raw `§` is the two-character unit `¤§`,
 * - a raw `¤` is the two-character unit `¤¤`.
 *
 * Those units are unioned into the member set. A positive class also guards its
 * verbatim form against consuming a bare sentinel or escape character, since
 * `§` in an encoded name is somebody's `/` and `¤` only ever prefixes a unit.
 * A negated class is a negative lookahead over the same member set, which keeps
 * negation exact in the raw domain instead of on encoded text.
 */
function translateClassBody(body: string): string {
	// picomatch's `posix` is on by default, so it rewrites `[:name:]` to the
	// table's source before compiling. Spell the body the same way here, or the
	// membership oracle and the verbatim emission would read the raw `[:name:]`
	// as a literal member list instead. An unknown name is left alone —
	// picomatch treats it literally too, and both readings then agree.
	body = body.replaceAll(/\[:([a-z]+):\]/g, (whole, name: string) => POSIX_CLASS_SOURCE[name] ?? whole);
	// `!` is an ordinary member; a leading `^` negates (picomatch only reads `!`
	// as negation under its `posix` option, which is off).
	const negated = body.startsWith("^");
	const members = negated ? body.slice(1) : body;
	// An empty member list (`[^]`) admits every raw character.
	if (members === "" && negated) return RAW_CHAR;
	if (members === "") return NEVER_MATCH;

	// Is this raw code point in the class's membership set? `classAdmits` already
	// accounts for negation, so this holds for both polarities.
	const included = (cp: number): boolean => classAdmits(body, cp);

	// The verbatim class covers the unreserved characters (1:1 in both domains).
	// A leading `^` among the members would negate it again, so escape it. The
	// guard keeps it from ever consuming a bare sentinel or escape marker: in an
	// encoded name those always belong to a reserved character's unit.
	const verbatimBody = members.startsWith("^") && !negated ? `\\${members}` : members;
	const alts = [`(?![${SLASH_CODE}${ESCAPE_MARK}])[${negated ? "^" : ""}${verbatimBody}]`];
	if (included(SLASH_CODEPOINT)) alts.push(SLASH_CODE);
	if (included(SENTINEL_CODEPOINT)) alts.push(ESCAPE_MARK + SLASH_CODE);
	if (included(ESCAPE_MARK_CODEPOINT)) alts.push(ESCAPE_MARK + ESCAPE_MARK);

	return alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`;
}

/** A group that never matches any name. */
const NEVER_MATCH = "(?!)";

/**
 * Translate a glob pattern into the encoded domain, emitting raw-character
 * semantics for `?`, keeping grouping characters literal, and collapsing every
 * run of `*` to a single star.
 *
 * Collapsing matters because picomatch compiles `**` to a globstar that leans
 * on `.` and on `/` as a separator (e.g. `(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)`),
 * neither of which survives into the encoded domain; one star, re-quantified by
 * `compileGlobMatcher`, is both sufficient and correct here.
 */
function translatePattern(pattern: string): string {
	let out = "";
	// Close indices of the alternations emitted so far, so a `}` that terminates
	// one is not escaped as a literal brace.
	const openAlternations: number[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			const next = pattern[i + 1];
			// `\\` is one literal backslash, spelled `\u005C` rather than `\\`:
			// picomatch's compiler never returns on four or more consecutive
			// backslashes (an infinite loop, so the `try`/`catch` around `makeRe`
			// cannot rescue it), and every literal backslash written as `\\` would
			// halve the distance to that limit. The unicode escape is one character
			// wide, identical to `\\` under the engine, and cannot chain.
			if (next === undefined || next === "\\") {
				out += "\\u005C";
				i++;
				continue;
			}
			// `\/`, `\§` and `\¤` become the plain encoded literal; every other
			// escape (`\*`, `\?`, …) must survive as an escape.
			if (next === "/" || next === SLASH_CODE || next === ESCAPE_MARK) out += translateLiteral(next);
			else out += "\\" + next;
			i++;
			continue;
		}
		if (ch === "{" || ch === "}") {
			// Only `{a,b}` alternation is special; a brace that does not open such
			// an expression is an ordinary character. picomatch compiles an
			// unmatched `{` to a matcher that never matches, so leaving `{` alone
			// would make the literal tool name `{` unselectable and turn `a{b*`
			// into an unmatched entry. Escaping the brace keeps it literal.
			if (ch === "}") {
				// A `}` closes the alternation opened for it, or is itself literal.
				if (openAlternations.at(-1) === i) {
					openAlternations.pop();
					out += "}";
				} else {
					out += "\\}";
				}
				continue;
			}
			const close = findAlternationEnd(pattern, i);
			if (close >= 0) {
				openAlternations.push(close);
				out += "{";
			} else {
				out += "\\{";
			}
			continue;
		}
		if (ch === "*") {
			// Any run of stars is one star: both cross `/`, so `**` has no extra
			// meaning here. Consuming the run keeps picomatch from seeing `**`.
			while (pattern[i + 1] === "*") i++;
			out += "*";
			continue;
		}
		if (ch === "[") {
			const end = findClassEnd(pattern, i);
			if (end < 0) {
				out += "\\[";
				continue;
			}
			const body = pattern.slice(i + 1, end);
			out += translateClassBody(body);
			i = end;
			continue;
		}
		if (ch === "?") {
			out += RAW_CHAR;
			continue;
		}
		if (
			ch === "(" ||
			ch === ")" ||
			ch === "|" ||
			ch === "+" ||
			ch === "@" ||
			ch === "!" ||
			// `"` is an ordinary character, but picomatch's parser reads it as a
			// quote and derails: `*"` compiles as a bare `*` (matching everything)
			// and `"*` as a never-match. Escaped, both spell the literal.
			ch === '"'
		) {
			// Escaped so grouping, alternation and extglob prefixes stay literal
			// even beside a wildcard: `+(a|b)*` matches the literal `+(a|b)foo`,
			// not `+afoo`. `+` is escaped unconditionally because the emitted
			// `?`/class forms end in `)` and `]`, which a following `+` would
			// otherwise quantify.
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

/**
 * Matches zero or more RAW characters, spelled as a repetition of
 * {@link RAW_CHAR} so the star shares its cardinality rules: an astral character
 * counts once, and the star can never stop between the halves of a surrogate
 * pair (a following lone-surrogate literal would otherwise consume the low half
 * and match a name whose high half it had eaten).
 *
 * The star cannot be delegated to picomatch, which compiles it to `[^/]*?` —
 * a character-wise wildcard that may stop between the two characters of an
 * encoded unit. A following literal would then consume the orphaned second half
 * as if it were a whole unit: a star followed by a raw slash wrongly admitted
 * the name `a` + U+00A7 (whose encoded form is `a` + U+00A4 + U+00A7).
 */
const ENCODED_STAR = `(?:${RAW_CHAR})*`;

/**
 * picomatch's path-shaped dot-segment guards, removed after compilation.
 *
 * Even with `dot: true` picomatch keeps a wildcard from matching a `.` or `..`
 * path segment: an anchored `(?!…)` on the pattern's first segment and an
 * unanchored one on every later segment. Tool names are opaque strings, not
 * paths — a server may legitimately advertise a tool named `.` — so both
 * spellings are stripped to leave the wildcard matching every name.
 */
const DOT_SEGMENT_GUARDS = [
	"(?!(?:^|\\/)\\.{1,2}(?:\\/|$))",
	"(?!\\.{1,2}(?:\\/|$))",
	"(?!\\.{0,1}(?:\\/|$))",
] as const;

/**
 * picomatch's "at least one character here" assertion, removed after compilation.
 *
 * The compiler emits `(?=.)` before a star that follows a literal `.` (so `.*`
 * does not match a bare `.`), carrying over a path-shaped reading of dotfiles.
 * Tool names are opaque strings and `*` matches zero characters, so `.*` must
 * address a tool named exactly `.` and `*.*` a name like `report.`.
 */
const NONEMPTY_GUARD = "(?=.)";

/**
 * Compile one filter entry into a raw-name matcher.
 *
 * `picomatch.makeRe` is used rather than the matcher factory so the emitted
 * RegExp can be driven directly. The factory re-checks `input === glob` and
 * falls back to literal matching when the two agree, which the encoding can
 * make true by accident: `\?` translates to a two-character `\?` that equals
 * the encoded form of a name reading `\?`. The regex is also the only way to
 * re-quantify `*` (see {@link ENCODED_STAR}).
 */
function compilePattern(pattern: string): ToolMatcher {
	const cached = compiledPatterns.get(pattern);
	if (cached !== undefined) return cached;
	let matcher: ToolMatcher;
	if (/[*?[\]{}\\]/.test(pattern)) {
		let regex: RegExp | null = null;
		try {
			const source = picomatch.makeRe(translatePattern(pattern), MATCH_OPTIONS);
			// `*` is re-quantified: picomatch emitted `[^/]*?` for each one. Any
			// dot-segment guard goes too — MCP tool names are opaque strings.
			let body = source.source.replaceAll("[^/]*?", ENCODED_STAR);
			for (const guard of DOT_SEGMENT_GUARDS) body = body.replaceAll(guard, "");
			body = body.replaceAll(NONEMPTY_GUARD, "");
			regex = new RegExp(body);
		} catch {
			// A syntactically broken pattern never matches: it degrades to an
			// unmatched entry instead of disabling the server.
			regex = null;
		}
		const compiled = regex;
		matcher = compiled ? (name: string) => compiled.test(encodeName(name)) : () => false;
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
 * (`* `, ` ? `, `[...]`, `{... }`) are matched with fnmatch semantics over the raw
 * name — `/ ` is an ordinary character, and ` * `/` ?` cross it. Denylist entries
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
