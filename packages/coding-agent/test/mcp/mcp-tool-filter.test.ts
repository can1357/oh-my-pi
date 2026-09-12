/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`).
 *
 * Contracts defended here:
 * - Deny subtracts from allow, deny wins when both sides are set — mirroring
 *   the server-level `disabledServers` > `enabledServers` pair.
 * - Entries are matched against RAW server-advertised names via picomatch,
 *   with `dot: true` because tool names are opaque strings, not paths.
 * - Unknown entries are surfaced in `unmatched` (a typo is loud), and a
 *   filter that excludes every advertised tool reports `filterEmpty`.
 * - Literal entries never go through the matcher, so a tool name containing
 *   glob metacharacters still matches its literal spelling.
 * - applyMCPToolFilter filters MCPToolDefinition[] while preserving schema,
 *   description, annotations, and original ordering.
 */
import { expect, test } from "bun:test";
import { applyMCPToolFilter, filterMCPTools } from "../../src/mcp/tool-filter";
import type { MCPToolDefinition } from "../../src/mcp/types";

const NAMES = ["search", "read_channel", "send_message", "create_doc", "admin/delete"];

function run(toolNames: string[], enabledTools?: string[], disabledTools?: string[]) {
	return filterMCPTools({ toolNames, enabledTools, disabledTools });
}

test("allowlist keeps only matching tools in advertised order", () => {
	const result = run(NAMES, ["read_channel", "send_*"]);
	expect(result.allowed).toEqual(["read_channel", "send_message"]);
	expect(result.unmatched).toEqual([]);
	expect(result.filterEmpty).toBe(false);
});

test("wildcards cross slashes: tool names are opaque, not paths", () => {
	expect(run(NAMES, ["*"]).allowed).toEqual(NAMES);
	expect(run(NAMES, ["admin*"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["admin/*"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["a?min/delete"]).allowed).toEqual(["admin/delete"]);
	expect(run(NAMES, ["other/*"]).allowed).toEqual([]);
});

test("denylist subtracts from allowlist when both are set", () => {
	const result = run(NAMES, ["read_channel", "send_message", "search"], ["send_*"]);
	expect(result.allowed).toEqual(["search", "read_channel"]);
});

test("a denylist entry matching nothing is harmless and stays out of unmatched", () => {
	// Deny subtracts, so an unmatched deny entry fails open: harmless, and a
	// defensive denylist kept across servers/versions legitimately matches
	// nothing — it must not produce recurring unmatched-warn noise.
	const result = run(NAMES, undefined, ["zzz_typo"]);
	expect(result.allowed).toEqual(NAMES);
	expect(result.unmatched).toEqual([]);
});

test("glob metacharacters: star, question, brace alternation", () => {
	expect(run(NAMES, ["*_message"]).allowed).toEqual(["send_message"]);
	expect(run(NAMES, ["read_???nnel"]).allowed).toEqual(["read_channel"]);
	expect(run(NAMES, ["{search,send_message}"]).allowed).toEqual(["search", "send_message"]);
	// A brace token that is itself a tool name still only matches its exact
	// spelling — braces expand alternatives, so `{delete}` matches neither
	// `delete` nor `admin_delete`.
	expect(run(["admin_{delete}", "admin_delete", "delete"], ["{delete}"]).allowed).toEqual([]);
	// Escapes suppress the brace and match literally.
	expect(run(["{delete}", "admin_delete"], ["\\{delete\\}"]).allowed).toEqual(["{delete}"]);
});

test("a filter entry matching no tool is reported in config order", () => {
	const result = run(NAMES, ["search", "zzz_typo", "read_*"]);
	expect(result.unmatched).toEqual(["zzz_typo"]);
});

test("filter that excludes every advertised tool reports filterEmpty", () => {
	const result = run(NAMES, ["zzz_nonexistent"]);
	expect(result.allowed).toEqual([]);
	expect(result.filterEmpty).toBe(true);
});

test("a denylist excluding everything also reports filterEmpty", () => {
	const result = run(NAMES, undefined, ["*"]);
	expect(result.allowed).toEqual([]);
	expect(result.filterEmpty).toBe(true);
});

test("malformed glob entries degrade to unmatched instead of disabling the server", () => {
	// picomatch compiles a syntactically broken class to a never-matching
	// regex — the entry surfaces as unmatched, other entries still apply.
	const result = run(NAMES, ["read_*", "[z-a]*"]);
	expect(result.allowed).toEqual(["read_channel"]);
	expect(result.unmatched).toEqual(["[z-a]*"]);
});

test("literal entries with glob metacharacters match only their exact spelling", () => {
	const result = run(["a.b", "axb"], ["a.b"]);
	expect(result.allowed).toEqual(["a.b"]);
});

test("picomatch classes agree with standard glob semantics", () => {
	expect(run(["file_1", "file_a"], ["file_[0-9]"]).allowed).toEqual(["file_1"]);
	expect(run(["file_!"], ["file_[!a]"]).allowed).toEqual(["file_!"]);
	expect(run(["}ax", "ax"], ["[}]].*"]).allowed).toEqual([]);
});

test("applyMCPToolFilter preserves tool definitions and schemas", () => {
	const defs: MCPToolDefinition[] = [
		{
			name: "read_file",
			description: "Reads a file",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		},
		{ name: "delete_file", description: "Deletes a file", inputSchema: { type: "object" } },
		{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } },
	];
	const filtered = applyMCPToolFilter("test-server", defs, { enabledTools: ["read_*", "write_*"] });
	expect(filtered).toHaveLength(2);
	expect(filtered[0]).toEqual(defs[0]);
	expect(filtered[1]).toEqual(defs[2]);
});

test("leading ! and extglob prefixes are literals (matcher surface pinned to documented globs)", () => {
	// `!foo*` must NOT invert into a picomatch negation — otherwise a denylist
	// entry `["!admin*"]` would silently exclude everything EXCEPT admin*.
	expect(run(NAMES, ["!search*"]).allowed).toEqual([]);
	// Deny side: the pinned literal `!search*` matches nothing, subtracts
	// nothing (deny fails open), and stays out of unmatched.
	expect(run(NAMES, undefined, ["!search*"]).allowed).toEqual(NAMES);
	expect(run(NAMES, undefined, ["!search*"]).unmatched).toEqual([]);
	expect(run(NAMES, ["+(a|b)"]).unmatched).toEqual(["+(a|b)"]);
});

test("negated classes treat the slash as an ordinary member", () => {
	// `admin[^/]delete` does NOT match `admin/delete` while `admin[^a]*` does —
	// the slash is a member like any other, and picomatch's auto-injected `/`
	// member is dropped so it cannot exclude what the class never named.
	expect(run(["admin/delete", "adminXdelete"], ["admin[^/]*"]).allowed).toEqual(["adminXdelete"]);
	expect(run(["admin/delete", "adminXdelete"], ["admin[^a]*"]).allowed).toEqual(["admin/delete", "adminXdelete"]);
	expect(run(NAMES, ["[^/]*"]).allowed).toEqual(NAMES);
});

test("single-char wildcard matches exactly one RAW character, slash included", () => {
	// A slash is one character, so `?` spans a slash position:
	expect(run(NAMES, ["a?min/delete"]).allowed).toEqual(["admin/delete"]);
	// `?` is emitted as an alternation over raw characters rather than a bare
	// negated class: it spans exactly one of them — a literal `§` included — and
	// `??` spans two.
	expect(run(["admin§delete"], ["admin?delete"]).allowed).toEqual(["admin§delete"]);
	expect(run(["admin§delete"], ["admin??delete"]).allowed).toEqual([]);
	expect(run(NAMES, ["admin??delete"]).allowed).toEqual([]);
});

test("positive classes with slash members match (admin[/]delete matches admin/delete)", () => {
	// A class body is emitted verbatim, so a slash member stays a member:
	// `[/]` matches a slash, `[a/]` matches `a` or a slash.
	expect(run(["admin/delete", "adminXdelete"], ["admin[/]delete"]).allowed).toEqual(["admin/delete"]);
	expect(run(["xay", "x/y", "xby"], ["x[a/]y"]).allowed).toEqual(["xay", "x/y"]);
	expect(run(["file_1", "file/1"], ["file[/_]1"]).allowed).toEqual(["file_1", "file/1"]);
});

test("class ranges that span the slash keep it as a member", () => {
	// `/` (0x2F) lies between `.` (0x2E) and `0` (0x30), so a raw `[.-0]` admits
	// it — the translator splits the range around the reserved code point
	// instead of widening it into `§` (U+00A7), which would swallow every
	// letter between.
	expect(run(["admin/delete", "admin.delete", "admin0delete"], ["admin[.-0]delete"]).allowed).toEqual([
		"admin/delete",
		"admin.delete",
		"admin0delete",
	]);
	expect(run(["adminXdelete"], ["admin[.-0]delete"]).allowed).toEqual([]);
	// The negated form excludes exactly the spanned members.
	expect(run(["admin/delete", "adminAdelete"], ["admin[^.-0]delete"]).allowed).toEqual(["adminAdelete"]);
});

test("a range may not widen into the reserved code points between its endpoints", () => {
	// `[.-/]` is `.`, `/` only. Treating it as one code-point range would run
	// through `0`–`§` and admit letters.
	expect(run(["x.y", "x/y"], ["x[.-/]y"]).allowed).toEqual(["x.y", "x/y"]);
	expect(run(["xmy", "x0y"], ["x[.-/]y"]).allowed).toEqual([]);
	// `[/-z]` spans `/` up to `z`, so it admits the plain letters and the slash
	// but never `-`.
	expect(run(["x/y", "xmy", "x-y"], ["x[/-z]y"]).allowed).toEqual(["x/y", "xmy"]);
	// `[+-0]` spans `/` between `+` and `0`: `+`, `/`, `-`, `.`, `0` — not `m`.
	expect(run(["x+y", "x/y", "x0y", "xmy"], ["x[+-0]y"]).allowed).toEqual(["x+y", "x/y", "x0y"]);
	// A descending range is empty, as in POSIX classes.
	expect(run(["xby", "x/y"], ["x[a-/]y"]).allowed).toEqual([]);
});

test("a class addresses a name's own characters, not a rewritten domain", () => {
	// A literal `§` in a class addresses a tool name's `§`, not a slash;
	// `/` is spelled `/`.
	expect(run(["x§y"], ["x[§]y"]).allowed).toEqual(["x§y"]);
	expect(run(["x/y"], ["x[§]y"]).allowed).toEqual([]);
	expect(run(["x/y"], ["x[/]y"]).allowed).toEqual(["x/y"]);
	expect(run(["x¤y"], ["x[¤]y"]).allowed).toEqual(["x¤y"]);
});

test("`?` matches one raw character, astral ones included", () => {
	// The compiled regex is not a `u`-mode one, so a bare negated class would
	// consume a single UTF-16 code unit and a `?` would claim half of an astral
	// character: `tool_?` missed `tool_😀` while `tool_??` matched it. One raw
	// character is one BMP character, one surrogate pair, or one lone surrogate.
	expect(run(["tool_😀", "tool_x"], ["tool_?"]).allowed).toEqual(["tool_😀", "tool_x"]);
	expect(run(["tool_😀", "tool_x"], ["tool_??"]).allowed).toEqual([]);
	expect(run(["😀", "a"], ["?"]).allowed).toEqual(["😀", "a"]);
	// The deny direction mirrors it.
	expect(run(["tool_😀", "tool_x"], []).allowed).toEqual(["tool_😀", "tool_x"]);
	expect(filterMCPTools({ toolNames: ["tool_😀", "tool_x"], disabledTools: ["tool_?"] }).allowed).toEqual([]);
	// A star may not stop between the halves of a pair either: `*` followed by a
	// lone low surrogate used to eat the high half of 😀 and let the literal take
	// the rest, admitting a name it had already taken apart.
	expect(run(["😀", "a\uDE00", "x"], ["*\uDE00"]).allowed).toEqual(["a\uDE00"]);
	expect(run(["😀", "😀x", "a/b"], ["*"]).allowed).toEqual(["😀", "😀x", "a/b"]);
});

test("a double quote stays an ordinary character", () => {
	// picomatch's parser reads a bare `"` as a quote and derails: `*"` compiled
	// as a bare `*` and matched everything, `"*` compiled to a never-match. It is
	// escaped so both spell the literal.
	expect(run(['x"', '"', "x"], ['*"']).allowed).toEqual(['x"', '"']);
	expect(run(['x"', "x"], ['?"']).allowed).toEqual(['x"']);
	expect(run(['"', "x"], ['"*']).allowed).toEqual(['"']);
	expect(run(['x"', '"', "a"], ['"']).allowed).toEqual(['"']);
	expect(run(['a"b', "ab"], ['a"b']).allowed).toEqual(['a"b']);
});

test("a class body keeps the engine's own reading of its members", () => {
	// Class bodies are compiled verbatim with the regex engine as the membership
	// oracle, which is what makes escapes, ranges and Annex-B corners come out
	// exactly as a user expects them to. That reading is the engine's, so a class
	// holding an astral character sees two code units rather than one raw
	// character — unlike the `?` wildcard, whose cardinality this module emits
	// itself. Rewriting astral members would mean hand-parsing class bodies,
	// which is precisely the source of silent meaning changes the verbatim rule
	// avoids. Pinned so the difference between the two surfaces stays deliberate.
	expect(run(["😀", "a"], ["[😀]"]).allowed).toEqual([]);
	expect(run(["😀", "a"], ["[a😀]"]).allowed).toEqual(["a"]);
	expect(run(["😀", "a"], ["[^😀]"]).allowed).toEqual(["a"]);
});

test("a star matches zero characters even after a literal dot", () => {
	// picomatch emits `(?=.)` before a star following a literal `.`, so `.*` did
	// not match a tool named exactly `.` and `*.*` missed `report.`. Tool names
	// are opaque and `*` spans zero characters, so the assertion is stripped and
	// `.*` addresses a literal dot followed by nothing.
	expect(run([".", ".a", "a"], [".*"]).allowed).toEqual([".", ".a"]);
	expect(run(["report.", "report", ".."], ["*.*"]).allowed).toEqual(["report.", ".."]);
	expect(run([".", "a.", "a"], ["*."]).allowed).toEqual([".", "a."]);
	// The same applies to a literal leading dot followed by a wildcard that is
	// itself followed by more pattern: `.*?` is a dot, any run, and one more
	// character, so a two-dot name qualifies.
	expect(run(["..", "..."], [".*?"]).allowed).toEqual(["..", "..."]);
	expect(run(["..", "a"], [".*[.]"]).allowed).toEqual([".."]);
	expect(run(["..", "a"], [".*{.,b}"]).allowed).toEqual([".."]);
});

test("braces outside `{a,b}` alternation are literal", () => {
	// Only `{a,b}` alternates. picomatch compiles an unmatched `{` to a matcher
	// that never matches, so the literal tool name `{` became unselectable and
	// `a{b*` turned into an unmatched entry. Those braces must stay literal,
	// while still matching only the spelling they name.
	expect(run(["{", "a"], ["{"]).allowed).toEqual(["{"]);
	expect(run(["a{bX", "aX"], ["a{b*"]).allowed).toEqual(["a{bX"]);
	expect(run(["a{b", "ab"], ["a{b"]).allowed).toEqual(["a{b"]);
	expect(run(["}b", "b"], ["}b"]).allowed).toEqual(["}b"]);
	// Real alternation still works, nesting included.
	expect(run(["a", "b", "{a,b}"], ["{a,b}"]).allowed).toEqual(["a", "b"]);
	expect(run(["xay", "xby"], ["x{a,b}y"]).allowed).toEqual(["xay", "xby"]);
	expect(run(["a", "b", "c"], ["{a,{b,c}}"]).allowed).toEqual(["a", "b", "c"]);
	// A class is opaque to the brace scan too: `{[}],a}` alternates the class
	// `[}]` with `a`, so the class's own `}` must not be read as the terminator.
	expect(run(["}", "b", "a", "x"], ["{[}b],a}"]).allowed).toEqual(["}", "b", "a"]);
	// `{a..c}` is a RANGE to picomatch, which collapses it to `[a-c]` and makes
	// the brace spelling unaddressable — the opposite of the documented surface,
	// where a brace pair without a top-level comma is literal. The same holds
	// for a range with no endpoint, and for one ending the entry.
	expect(run(["{a..c}", "a", "b", "c"], ["{a..c}"]).allowed).toEqual(["{a..c}"]);
	expect(run(["{1..3}", "1", "2"], ["{1..3}"]).allowed).toEqual(["{1..3}"]);
	expect(run(["{a..c}x", "ax", "cx"], ["{a..c}x"]).allowed).toEqual(["{a..c}x"]);
	expect(run(["{..}", ".", ".."], ["{..}"]).allowed).toEqual(["{..}"]);
	// A literal brace INSIDE an alternation must not close it: `{b}` has no
	// top-level comma, so the branch it names is the literal name `{b}`, and the
	// enclosing alternation still has all three branches.
	expect(run(["a", "{b}", "c", "b}"], ["{a,{b},c}"]).allowed).toEqual(["a", "{b}", "c"]);
	expect(run(["read_file", "write_file", "{list}_file", "list_file"], ["{read,{list},write}_file"]).allowed).toEqual([
		"read_file",
		"write_file",
		"{list}_file",
	]);
	// Branches nest, so the inner `{b,{c}}` is itself an alternation: it admits
	// `b`, and `{c}` only as the literal name — a bare `c` is not a branch.
	expect(run(["a", "b", "{c}", "c", "d"], ["{a,{b,{c}},d}"]).allowed).toEqual(["a", "b", "{c}", "d"]);
});

test("POSIX bracket classes expand the way picomatch expands them", () => {
	// picomatch leaves `posix` on by default, so `[:punct:]` is rewritten to its
	// table source before compiling and its brackets disappear — `[[:punct:]]`
	// compiles as `[-!"#$%&'()*+,./:;<=>?@[\]^_`{|}~]`. A class scan that
	// stopped at the POSIX group's own `]` truncated the body, so the class
	// lost every member after it and never admitted `/`.
	expect(run(["x/y", "x:y", "xay", "x]y"], ["x[[:punct:]]y"]).allowed).toEqual(["x/y", "x:y", "x]y"]);
	expect(run(["xay", "x9y", "x/y"], ["x[[:alpha:]]y"]).allowed).toEqual(["xay"]);
	// A POSIX group is one member of the enclosing class: `[[:alpha:]b]` admits
	// `a`–`z` and `b`, and the class still ends at the LAST bracket.
	expect(run(["xay", "xby", "x/y"], ["x[[:alpha:]b]y"]).allowed).toEqual(["xay", "xby"]);
	// A POSIX class admits `/` exactly when its table source names it, and a
	// negated one excludes it just as exactly.
	expect(run(["x/y", "x:y"], ["x[^[:punct:]]y"]).allowed).toEqual([]);
	expect(run(["xay", "x:y"], ["x[^[:punct:]]y"]).allowed).toEqual(["xay"]);
	// An unknown class name is not expanded by picomatch either: `[:foo:` stays
	// literal members and the class still ends at the third bracket, which is an
	// unclosed class and so matches nothing.
	expect(run(["x[[:foo:]]y", "xay", "x[y", "x:y"], ["x[[:foo:]]y"]).allowed).toEqual([]);
});

test("a class with a literal leading `]` member keeps its negated meaning", () => {
	// `[^]]` is "every character except `]`" — a leading `]` after `[^` is a
	// member, not the closer. The membership oracle must spell that member
	// escaped, or the bare `new RegExp("^[^]]$")` reads an Annex-B empty class
	// and reports `/` absent, wrongly excluding it from `admin[^]]delete`.
	expect(run(["x]y", "xay", "x/y", "xmy"], ["x[^]]y"]).allowed).toEqual(["xay", "x/y", "xmy"]);
	expect(run(["x]y", "xay"], ["x[]a]y"]).allowed).toEqual(["x]y", "xay"]);
	expect(run(["x]y", "xay"], ["x[]]y"]).allowed).toEqual(["x]y"]);
	// The same member in the deny direction: only the slash survives.
	expect(run(["x]y", "xay", "x/y"], ["x[^]a]y"]).allowed).toEqual(["x/y"]);
});

test("an unclosed class bracket is a literal, and the rest keeps its glob meaning", () => {
	// `[]?` has no closing bracket under the class rules (a leading `]` after `[`
	// is a member, and no second `]` follows), so the `[` is a literal and `?`
	// remains a one-character wildcard: the entry addresses `[]` followed by any
	// single character. picomatch instead compiles this as a quantifier on a
	// class, which is the `quantifier` corner `noextglob` does not cover; the
	// literal reading follows the documented surface.
	expect(run(["[]a", "[]", "[", "]"], ["[]?"]).allowed).toEqual(["[]a"]);
	expect(run(["[^]", "[^]?", "x"], ["[^]*"]).allowed).toEqual(["[^]", "[^]?"]);
	// A well-formed class still behaves normally next to the same characters.
	expect(run(["]a", "]b"], ["[]]a"]).allowed).toEqual(["]a"]);
	expect(run(["[", "x"], ["\\["]).allowed).toEqual(["["]);
});

test("grouping and extglob syntax stay literal beside a supported wildcard", () => {
	// `noextglob` disables the `+()` operator, but picomatch would still compile
	// `(a|b)` as grouping — so the translator escapes it. A denylist entry
	// `["!(a)"]` must not become a negation, and `+(a|b)*` must address the
	// literal tool name rather than admitting `+afoo`.
	expect(run(["+(a|b)foo", "+afoo"], ["+(a|b)*"]).allowed).toEqual(["+(a|b)foo"]);
	expect(run(["(a|b)foo", "afoo"], ["(a|b)*"]).allowed).toEqual(["(a|b)foo"]);
	expect(run(["(a|b)foo", "afoo"], ["a(b)c*"]).allowed).toEqual([]);
	expect(run(NAMES, ["!(search)"]).unmatched).toEqual(["!(search)"]);
});

test("a run of literal backslashes compiles instead of hanging the compiler", () => {
	// picomatch's compiler never returns once its input carries a class followed
	// by four consecutive backslashes, and an infinite loop is not something the
	// `try`/`catch` around `makeRe` can rescue — parsing such a config entry would
	// pin the event loop instead of degrading to an unmatched entry. Spelling each
	// literal backslash as `\u005C` keeps them from chaining, so the pattern is
	// compiled, matches nothing, and reports the entry as unmatched.
	const four = "\\\\\\\\";
	const eight = four + four;
	const result = run(["a", "\\\\"], ["[a]" + eight]);
	expect(result.allowed).toEqual([]);
	expect(result.unmatched).toEqual(["[a]" + eight]);
});

test("a trailing backslash addresses one literal backslash", () => {
	// picomatch compiles a trailing `\` through its matcher-factory fast path, so
	// the translated form must spell it out: a bare `\` compiles to `$^` (never
	// matching) when the RegExp is driven directly.
	expect(run(["\\", "a"], ["\\"]).allowed).toEqual(["\\"]);
	expect(run(["a\\", "a"], ["a\\"]).allowed).toEqual(["a\\"]);
});

test("a wildcard matches dot-segment names, which are opaque here", () => {
	// picomatch's compiler keeps a wildcard from matching a `.`/`..` PATH
	// SEGMENT even under `dot: true`. Tool names are opaque strings, so the
	// guard is stripped: `*` must admit a tool the server literally named `.`,
	// and the deny direction must subtract it.
	expect(run([".", "..", "...", "a"], ["*"]).allowed).toEqual([".", "..", "...", "a"]);
	expect(run([".", "..", "a"], ["*/*"]).allowed).toEqual([]);
	expect(filterMCPTools({ toolNames: [".", "..", "a"], disabledTools: ["*"] }).allowed).toEqual([]);
	expect(run(["a/.b"], ["a/*"]).allowed).toEqual(["a/.b"]);
});

test("a wildcard never stops between the halves of a character", () => {
	// A star counts raw characters, so it may not split a name in a way that
	// lets a following literal consume a fragment as if it were a whole
	// character: `*/` must not admit a name that has no slash at all.
	expect(run(["a§", "a/", "a"], ["*/"]).allowed).toEqual(["a/"]);
	expect(run(["§", "/"], ["**/"]).allowed).toEqual(["/"]);
	expect(run(["§", "/", "x/"], ["{*,x}/"]).allowed).toEqual(["/", "x/"]);
	expect(run(["9,§9", "/9"], ["*/9"]).allowed).toEqual(["/9"]);
	// The same hazard against the escape marker, in the deny direction: `*§`
	// asked for a raw `§` and admitted `}¤/`, which contains none.
	expect(run(["}¤/", " §"], ["*§"]).allowed).toEqual([" §"]);
});

test("a slash pattern never matches the sentinel character", () => {
	// Tool names are matched in their own domain, so a pattern spelling a slash
	// addresses a slash: `admin/*` must NOT admit `admin§delete`.
	expect(run(["admin/delete", "admin§delete"], ["admin/*"]).allowed).toEqual(["admin/delete"]);
	// A star is opaque over every character, so admin* DOES match admin§delete.
	expect(run(["admin§delete"], ["admin*"]).allowed).toEqual(["admin§delete"]);
	// A literal pattern matching a sentinel-carrying name still works.
	expect(run(["admin§delete"], ["admin/delete"]).allowed).toEqual([]);
	expect(run(["admin§delete"], ["admin§delete"]).allowed).toEqual(["admin§delete"]);
	// The sentinel character (¤) is distinct too: admin¤delete ≠ admin§delete.
	expect(run(["admin¤delete", "admin§delete"], ["admin§delete"]).allowed).toEqual(["admin§delete"]);
});

test("a NUL in a pattern addresses a NUL character", () => {
	// picomatch drops NUL while tokenizing, so `*\0` compiled as a bare `*` and
	// matched every advertised tool — an allowlist entry meant to select one
	// name-wide class would over-permit, and the same denylist entry would
	// exclude everything. Both JSON and the unchecked tool-name type permit the
	// character, so the pattern must address it rather than lose it.
	expect(run(["admin\u0000", "admin", "x\u0000"], ["*\u0000"]).allowed).toEqual(["admin\u0000", "x\u0000"]);
	expect(run(["admin\u0000", "admin"], ["admin\u0000"]).allowed).toEqual(["admin\u0000"]);
	// The deny direction subtracts exactly the NUL-carrying names.
	expect(filterMCPTools({ toolNames: ["admin\u0000", "admin"], disabledTools: ["*\u0000"] }).allowed).toEqual([
		"admin",
	]);
});

test("an escaped character is that literal character, whatever it spells in a regex", () => {
	// A glob escape names the character it escapes: the documented surface is
	// that only `*`, `?`, `[...]` and `{a,b}` carry meaning, so `\d` addresses a
	// tool named `d` — not "any digit", which is what forwarding the pair into
	// the regex would mean (`\d` selected a tool named `5`). The same holds for
	// the letter escapes and for `\xNN`, which must stay the text `xNN` rather
	// than the character that escape denotes.
	expect(run(["d", "5", "a"], ["\\d"]).allowed).toEqual(["d"]);
	expect(run(["b", "a\\b"], ["\\b"]).allowed).toEqual(["b"]);
	expect(run(["n", "\n"], ["\\n"]).allowed).toEqual(["n"]);
	expect(run(["x41", "A"], ["\\x41"]).allowed).toEqual(["x41"]);
	expect(run(["5", "a"], ["\\5"]).allowed).toEqual(["5"]);
	// The deny direction subtracts the same literal.
	expect(filterMCPTools({ toolNames: ["d", "5"], disabledTools: ["\\d"] }).allowed).toEqual(["5"]);
	// A metacharacter's own escape keeps meaning the literal metacharacter.
	expect(run(["*", "a"], ["\\*"]).allowed).toEqual(["*"]);
	expect(run(["{", "a"], ["\\{"]).allowed).toEqual(["{"]);
	// And a class member escapes the same way.
	expect(run(["d", "5"], ["[\\d]"]).allowed).toEqual(["d"]);
});
test("matching is host-independent: windows separators never alter semantics", () => {
	// picomatch auto-injects `windows: true` on win32 hosts when the option is
	// unset, making `*`/`?`/negated classes treat `\` as a path separator. Tool
	// names are opaque strings, so the matcher must behave identically there:
	expect(run(["a\\b"], ["a*"]).allowed).toEqual(["a\\b"]);
	expect(run(["a\\b"], ["a?b"]).allowed).toEqual(["a\\b"]);
	expect(run(["a\\b"], ["a[^x]b"]).allowed).toEqual(["a\\b"]);
});

test("a literal slash between classes routes (class, literal /, class)", () => {
	expect(run(["a/1", "a/b"], ["a/[12]"]).allowed).toEqual(["a/1"]);
	expect(run(["x/y"], ["[a-z]/[a-z]"]).allowed).toEqual(["x/y"]);
});

test("an escaped open bracket is a literal, so a slash after it is outside any class", () => {
	// `foo\[/bar*` must match `foo[/bar1` — \[ is a literal char, the slash is
	// outside any class, and picomatch's own parser resolves the escape.
	expect(run(["foo[/bar1", "foo[/bar2"], ["foo\\[/bar*"]).allowed).toEqual(["foo[/bar1", "foo[/bar2"]);
});
