/**
 * Per-server MCP tool filtering (`enabledTools` / `disabledTools`).
 *
 * Contracts defended here:
 * - A name is matched in two domains: its raw advertised spelling and its
 *   sanitized spelling (every character outside `[A-Za-z0-9_-]` becomes one
 *   `_`). The sanitized domain is how a pattern reaches a name with a slash,
 *   a dot, or any other non-identifier character; the raw domain keeps
 *   literal and class entries pointing at the exact advertised spelling.
 * - Entries are picomatch globs (`*`, `?`, `[...]`, `{a,b}`) with `dot: true`
 *   because a tool name is an opaque string, not a path.
 * - Deny subtracts from allow, deny wins when both sides are set — mirroring
 *   the server-level `disabledServers` > `enabledServers` pair.
 * - Unknown entries are surfaced in `unmatched` (a typo is loud), and a
 *   filter that excludes every advertised tool reports `filterEmpty`.
 * - applyMCPToolFilter filters MCPToolDefinition[] while preserving schema,
 *   description, annotations, original ordering, and the raw name.
 */
import { expect, test } from "bun:test";
import { applyMCPToolFilter, enumeratePatternNames, filterMCPTools } from "../../src/mcp/tool-filter";
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
	// spelling — `{delete}` alternates nothing, so neither `delete` nor
	// `admin_delete` is admitted.
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

test("names are matched in two domains: the raw spelling and the sanitized spelling", () => {
	// Sanitization replaces every character outside `[A-Za-z0-9_-]` with one
	// `_`, so a pattern written for the identifier spelling reaches a name the
	// server advertised with other characters.
	expect(run(["web.search", "webXsearch"], ["web_search"]).allowed).toEqual(["web.search"]);
	expect(run(["web search"], ["web_search"]).allowed).toEqual(["web search"]);
	expect(run(["admin/delete"], ["admin_delete", "admin?delete", "admin*"]).allowed).toEqual(["admin/delete"]);
	// A pattern spelling the non-identifier character itself reaches the raw
	// name directly: the dot is NOT collapsed in the raw domain.
	expect(run(["a.b", "axb"], ["a.b"]).allowed).toEqual(["a.b"]);
	// A pattern holding a slash addresses the name through its sanitized
	// spelling, not a literal slash in the name.
	expect(run(["admin/delete"], ["admin/*"]).allowed).toEqual(["admin/delete"]);
	// Distinct raw names that sanitize to the same spelling collide by design:
	// one pattern addresses both.
	expect(run(["foo.bar", "foo bar"], ["foo_bar"]).allowed).toEqual(["foo.bar", "foo bar"]);
	// The filter is a filter, not a renamer: applyMCPToolFilter keeps the raw
	// advertised name, schema, and annotations.
	const defs: MCPToolDefinition[] = [
		{
			name: "admin/delete",
			description: "Administrative deletion",
			inputSchema: { type: "object" },
			annotations: { title: "Delete" },
		},
	];
	const filtered = applyMCPToolFilter("srv", defs, { enabledTools: ["admin_delete"] });
	expect(filtered).toHaveLength(1);
	expect(filtered[0].name).toBe("admin/delete");
	expect(filtered[0].inputSchema).toEqual({ type: "object" });
	expect(filtered[0].annotations).toEqual({ title: "Delete" });
});

test("a wildcard matches dot-segment names, which are identifier-domain", () => {
	// The harness sanitizer leaves only [a-z0-9_-] (lowercased, runs collapsed,
	// leading/trailing `_` stripped, empty falling back to the server name), so
	// a bare `.` or `..` does not spell a filterable name: it can only be named
	// literally, and `*` never matches the fallback spelling.
	expect(run(["...", "a"], ["*"]).allowed).toEqual(["...", "a"]);
	// The raw domain regex `.` matches both spellings; the sanitized fallback
	// name is only `"."`.
	expect(run([".", ".."], ["."]).allowed).toEqual(["."]);
	expect(run([".", "..", "a"], ["*/*"]).allowed).toEqual([]);
	expect(run(["a/.b"], ["a/*"]).allowed).toEqual(["a/.b"]);
});

test("a star matches zero characters, and picomatch's own dot guards stand", () => {
	// picomatch emits a `(?=.)` lookahead before a star that follows a literal
	// dot, so `.*` addresses a dot followed by at least one character: a name
	// that is only the dot does not qualify, and neither does `..` under
	// picomatch's `(?!\.{1,2}(?:\/|$))` segment guard.
	expect(run([".", ".a", "a"], [".*"]).allowed).toEqual([".a"]);
	expect(run(["report.", "report", "..", "report.x"], ["*.*"]).allowed).toEqual(["report.", "report.x"]);
	expect(run([".", "a.", "a", "report."], ["*."]).allowed).toEqual(["a.", "report."]);
});

test("double quotes are ordinary characters", () => {
	// picomatch's parser reads a bare `"` as a quote and derails (a lone one
	// compiles to an empty match); the pattern is quoted-escaped so both sides
	// spell the literal.
	expect(run(['x"', '"', "x"], ['*"']).allowed).toEqual(['x"', '"']);
	expect(run(['x"'], ['?"']).allowed).toEqual(['x"']);
	expect(run(['"', "x"], ['"*']).allowed).toEqual(['"']);
	expect(run(['x"', '"', "a"], ['"']).allowed).toEqual(['"']);
	expect(run(['a"b', "ab"], ['a"b']).allowed).toEqual(['a"b']);
	// A quote works as a class member too.
	expect(run(['x"y'], ['x["]y']).allowed).toEqual(['x"y']);
});

test("POSIX bracket classes expand the way picomatch expands them", () => {
	// picomatch leaves `posix` on by default, so `[:punct:]` is rewritten to
	// its table source before compiling.
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

test("class ranges span the code points their endpoints name", () => {
	// A class is passed to the regex engine verbatim, so a range runs through
	// every code point between its endpoints: `[.-0]` covers `.` `/` `-` and
	// `0` (0x2E through 0x30), admitting the slash a narrower reading would
	// drop, and `[a-c]` does not widen to `d`.
	expect(run(["admin/delete", "admin.delete", "admin0delete", "adminXdelete"], ["admin[.-0]delete"]).allowed).toEqual([
		"admin/delete",
		"admin.delete",
		"admin0delete",
	]);
	// The negated form excludes exactly the spanned members — the slash
	// directly (raw domain) and the sanitized `_` too, since `_` (0x5F) lies
	// outside the range.
	expect(run(["admin/delete", "adminAdelete"], ["admin[^.-0]delete"]).allowed).toEqual([
		"admin/delete",
		"adminAdelete",
	]);
	// `[.-/]` is `.` and `/` only, not the letters between on a wider table.
	expect(run(["x.y", "x/y", "xmy", "x0y"], ["x[.-/]y"]).allowed).toEqual(["x.y", "x/y"]);
	// `[/-z]` spans `/` up to `z`, so it admits the plain letters and the slash
	// but never `-`.
	// The sanitizer maps `.`/`,`-adjacent spelling to `_`, and the raw domain
	// still matches the literal name; `-` never reaches a class endpoint.
	expect(run(["x/y", "xmy", "x-y"], ["x[/-z]y"]).allowed).toEqual(["x/y", "xmy", "x-y"]);
	// `[+-0]` spans `/` between `+` and `0`: `+`, `/`, `-`, `.`, `0` — not `m`.
	expect(run(["x+y", "x/y", "x0y", "xmy"], ["x[+-0]y"]).allowed).toEqual(["x+y", "x/y", "x0y"]);
	// A descending range is empty, as in POSIX classes.
	expect(run(["xby", "x/y"], ["x[a-/]y"]).allowed).toEqual([]);
});

test("a class addresses a name's own characters, not a rewritten domain", () => {
	// A literal `§` in a class addresses a tool name's `§`, not a slash; `/` is
	// spelled `/` — and a name holding no identifier character is reached by
	// its own spelling via the raw domain.
	expect(run(["x§y"], ["x[§]y"]).allowed).toEqual(["x§y"]);
	expect(run(["x/y"], ["x[§]y"]).allowed).toEqual([]);
	expect(run(["x/y"], ["x[/]y"]).allowed).toEqual(["x/y"]);
	expect(run(["x¤y"], ["x[¤]y"]).allowed).toEqual(["x¤y"]);
});

test("tool names are matched as ordinary characters, with no exotic fidelity", () => {
	// The MCP servers OMP connects to advertise identifier-like names in
	// practice ([a-zA-Z0-9_.-], occasionally a slash or unicode letter). A
	// name outside that alphabet is still matched character by character —
	// `?` spans an astral character as one character — but shapes the engine
	// cannot spell (a lone surrogate half, an astral character inside a class,
	// a NUL in the pattern) get no special handling.
	// `?` is one character as picomatch reads it: one code unit. An astral
	// character is out of the identifier domain (the sanitized spelling is
	// `tool__`), so `tool_?` reaches only `tool_x`:
	expect(run(["tool_😀", "tool_x"], ["tool_?"]).allowed).toEqual(["tool_x"]);
	// `?` is one code unit; an astral name does not admit a unit wildcard.
	expect(run(["😀", "a"], ["?"]).allowed).toEqual(["a"]);
	// An astral character inside a CLASS is out of scope: the class body is
	// read by code unit, so it admits the halves, not the character.
	expect(run(["x😀y", "xay"], ["x[😀]y"]).allowed).toEqual([]);
	// A pattern spelling a lone surrogate half compiles to a one-code-unit
	// spelling: it reaches `😀` only as a fragment (the high half matches the
	// first unit), never as the whole character, and a half that names no unit
	// of the name matches nothing.
	expect(run(["😀", "😀😀"], ["\uD83D?"]).allowed).toEqual(["😀"]);
	expect(run(["😀"], ["\uDE00?"]).allowed).toEqual([]);
	// The deny direction subtracts exactly what the entry matches.
	expect(filterMCPTools({ toolNames: ["😀", "a"], disabledTools: ["\uD83D?"] }).allowed).toEqual(["a"]);
	// A NUL is dropped by the engine while reading a pattern, but a NUL in a
	// NAME is still addressable through the sanitized spelling.
	expect(run(["admin\u0000x"], ["admin_x"]).allowed).toEqual(["admin\u0000x"]);
	// Both spellings normalize to the fallback identifier, so the pattern
	// addresses both; collisions are accepted by design.
	expect(run(["admin\u0000", "admin"], ["admin\u0000"]).allowed).toEqual(["admin\u0000", "admin"]);
});

test("braces: alternation, literal pairs, and picomatch's own reading", () => {
	// `{a}` has no top-level comma, so it alternates nothing: the compiled
	// regex spells the literal, and it matches only the exact spelling.
	expect(run(["{a}", "a"], ["{a}"]).allowed).toEqual(["{a}"]);
	// `{a..c}` is a brace RANGE to picomatch, which collapses it to `[a-c]` —
	// the brace spelling itself is not addressable.
	expect(run(["a", "b", "c", "{a..c}"], ["{a..c}"]).allowed).toEqual(["a", "b", "c"]);
	expect(run(["{a..c}x", "ax", "cx"], ["{a..c}x"]).allowed).toEqual(["ax", "cx"]);
	// An unmatched brace compiles to a matcher that never matches, so `a{b*`
	// degrades to an unmatched entry rather than addressing anything.
	expect(run(["a{bX", "aX", "a{b"], ["a{b*"]).allowed).toEqual([]);
	expect(run(["a{b", "ab"], ["a{b"]).allowed).toEqual([]);
	// `}` outside a brace pair is an ordinary character.
	expect(run(["}b", "b"], ["}b"]).allowed).toEqual(["}b"]);
	// Real alternation works, nesting included.
	expect(run(["a", "b", "{a,b}"], ["{a,b}"]).allowed).toEqual(["a", "b"]);
	expect(run(["xay", "xby"], ["x{a,b}y"]).allowed).toEqual(["xay", "xby"]);
	expect(run(["a", "b", "c"], ["{a,{b,c}}"]).allowed).toEqual(["a", "b", "c"]);
	// A class is opaque to the brace scan: `{[}b],a}` alternates the class
	// `[}b]` with `a`.
	expect(run(["}", "b", "a", "x"], ["{[}b],a}"]).allowed).toEqual(["}", "b", "a"]);
	// A literal brace INSIDE an alternation does not close it: `{b}` is the
	// literal branch it names, and the enclosing alternation keeps all three
	// branches.
	expect(run(["a", "{b}", "c", "b}"], ["{a,{b},c}"]).allowed).toEqual(["a", "{b}", "c"]);
	expect(run(["read_file", "write_file", "{list}_file", "list_file"], ["{read,{list},write}_file"]).allowed).toEqual([
		"read_file",
		"write_file",
		"{list}_file",
	]);
	// Branches nest: the inner `{b,{c}}` is itself an alternation.
	expect(run(["a", "b", "{c}", "c", "d"], ["{a,{b,{c}},d}"]).allowed).toEqual(["a", "b", "{c}", "d"]);
});

test("a class with a literal leading `]` member keeps its reading", () => {
	// `[^]]` is "every character except `]`" — a leading `]` after `[^` is a
	// member, not the closer. The raw domain keeps that reading: `x]y` is not
	// admitted directly, but the sanitized spelling `x_y` is (the class is
	// ordinary on identifier characters).
	expect(run(["x]y", "xay"], ["x[^]]y"]).allowed).toEqual(["x]y", "xay"]);
	expect(run(["x]y", "xay"], ["x[]a]y"]).allowed).toEqual(["x]y", "xay"]);
	expect(run(["x]y", "xay"], ["x[]]y"]).allowed).toEqual(["x]y"]);
	expect(run(["x]y", "xay"], ["x[^]a]y"]).allowed).toEqual(["x]y"]);
	expect(run(["]a", "]b"], ["[]]a"]).allowed).toEqual(["]a"]);
	expect(run(["[", "x"], ["\\["]).allowed).toEqual(["["]);
});

test("an unclosed class bracket compiles as picomatch reads it", () => {
	// `[]?` has no closing bracket under the class rules (a leading `]` after
	// `[` is a member, and no second `]` follows). picomatch compiles it as a
	// literal `[` plus a `?` quantifier, so the entry addresses `[]` and the
	// bare `[`; `[^]*` compiles as a quantified class that matches nothing a
	// name is spelled with.
	expect(run(["[]", "[", "[]a"], ["[]?"]).allowed).toEqual(["[]", "["]);
	expect(run(["[^]", "[^]?", "x"], ["[^]*"]).allowed).toEqual([]);
	// A well-formed class still behaves normally next to the same characters.
	expect(run(["]a", "]b"], ["[]]a"]).allowed).toEqual(["]a"]);
});

test("grouping compiles the way picomatch reads it, and extglob prefixes degrade", () => {
	// `noextglob` leaves `+`/`@`/`!` prefixes literal, but picomatch still
	// compiles `(a|b)` as regex grouping: `(a|b)*` addresses `afoo` and
	// `bfoo`, and `+(a|b)*` is a literal `+` followed by that grouping. A name
	// spelled with the prefix characters is not addressed by any of these.
	// The sanitized domain collapses the raw name to `(a|b)foo` -> `(a|b)foo`
	// unchanged (all chars are already `a-z0-9_-`? no: `(` is not) — the raw
	// name sanitizes to `_a|b_foo`… whichever, the matcher admits it:
	expect(run(["afoo", "bfoo", "(a|b)foo"], ["(a|b)*"]).allowed).toEqual(["afoo", "bfoo", "(a|b)foo"]);
	// extglob `+(a|b)` compiles: `+afoo` matches; the paren-spelled name does not.
	expect(run(["+afoo", "+(a|b)foo"], ["+(a|b)*"]).allowed).toEqual(["+afoo"]);
	// picomatch reads `(b)` as a group, but `c*` requires the literal `c`
	// afterward, so `a(b)c*` does not admit `afoo`.
	expect(run(["afoo"], ["a(b)c*"]).allowed).toEqual([]);
	expect(run(["@(a|b)foo", "afoo"], ["@(a|b)*"]).allowed).toEqual([]);
	// `noextglob` keeps `!(search)` a literal prefix, so neither name matches.
	expect(run(["!(search)x", "x"], ["!(search)*"]).allowed).toEqual([]);
	// picomatch reads a bare `!(search)` as an extglob negation too: it admits
	// every name that is not the literal `(search)`, so it is matched, not
	// unmatched.
	expect(run(NAMES, ["!(search)"]).unmatched).toEqual([]);
});

test("a run of literal backslashes cannot hang the compiler", () => {
	// picomatch's compiler never returns once its input carries four or more
	// consecutive backslashes — an infinite loop no `try`/`catch` can rescue.
	// The matcher rejects such a pattern before the parser is entered, so it
	// degrades to a never-matching, unmatched entry.
	const four = "\\\\\\\\";
	const eight = four + four;
	const result = run(["a", "\\\\"], ["[a]" + eight]);
	expect(result.allowed).toEqual([]);
	expect(result.unmatched).toEqual(["[a]" + eight]);
});

test("a trailing backslash addresses one literal backslash", () => {
	// picomatch compiles a trailing `\` through its matcher-factory fast path,
	// so the translated form must spell it out: a bare `\` compiles to `$^`
	// (never matching) when the RegExp is driven directly.
	expect(run(["\\", "a"], ["\\"]).allowed).toEqual(["\\"]);
	expect(run(["a\\", "a"], ["a\\"]).allowed).toEqual(["a\\"]);
});

test("a backslash in a name is an ordinary character on every host", () => {
	// picomatch auto-injects `windows: true` on win32 hosts when the option is
	// unset, making `*`/`?`/negated classes treat `\` as a path separator. Tool
	// names are opaque strings, so the matcher must behave identically there:
	expect(run(["a\\b"], ["a*"]).allowed).toEqual(["a\\b"]);
	expect(run(["a\\b"], ["a?b"]).allowed).toEqual(["a\\b"]);
	expect(run(["a\\b"], ["a[^x]b"]).allowed).toEqual(["a\\b"]);
});

test("escapes mean what they mean in a glob", () => {
	// A glob escape is forwarded to the regex engine: `\d` is the digit class,
	// `\x41` is `A`, a metacharacter's escape is the literal metacharacter, and
	// a dead escape (`\5`, a backref no match can fill) never matches.
	expect(run(["5", "d", "a"], ["\\d"]).allowed).toEqual(["5"]);
	expect(filterMCPTools({ toolNames: ["d", "5"], disabledTools: ["\\d"] }).allowed).toEqual(["d"]);
	expect(run(["A", "x41"], ["\\x41"]).allowed).toEqual(["A"]);
	expect(run(["*", "a"], ["\\*"]).allowed).toEqual(["*"]);
	expect(run(["{", "a"], ["\\{"]).allowed).toEqual(["{"]);
	expect(run(["5", "a"], ["\\5"]).allowed).toEqual([]);
});

test("enumerated names are always names the pattern actually matches", () => {
	// The enumerator reads a pattern's tokens to say which concrete names it
	// can select. A candidate is only ever reported after the pattern's matcher
	// has admitted it, so a mis-read token can narrow the result to nothing —
	// reported as "cannot enumerate" — but never widen it to a name the
	// pattern does not match. Both the raw and the sanitized spelling of a
	// token are offered, which is how a `+` in a name is enumerated alongside
	// its sanitized `_` spelling.
	// The matcher admits the raw spelling and the sanitized spelling, not the
	// backslash spelling the token carries (the soundness filter rejects it).
	// `+` is not an identifier character: the soundness filter admits the
	// raw spelling only through its escaped candidate, and both are kept.
	expect(enumeratePatternNames("a+")).toEqual(["a\\+", "a", "a+"]);
	expect(enumeratePatternNames("foo_bar")).toEqual(["foo_bar"]);
	expect(enumeratePatternNames("read_channel")).toEqual(["read_channel"]);
	// A class reaching outside the identifier alphabet a sanitized name can
	// hold cannot be enumerated, so it declines rather than reporting only the
	// members that happen to fall inside — the caller then keeps a server
	// instead of dropping one whose selection it merely could not name.
	expect(enumeratePatternNames("web_search_ex[a]")).toEqual(["web_search_exa"]);
	expect(enumeratePatternNames("web_search_ex[aà]")).toBeNull();
	// The class reaches outside the probe alphabet only in part; a positive
	// class is enumerated over what it admits and the soundness filter keeps
	// the name the matcher agrees on.
	expect(enumeratePatternNames("[aé]")).toEqual(["[aé]", "a"]);
	// An escape whose meaning is a regex class, not a character (`\d`), has no
	// nameable spelling either.
	expect(enumeratePatternNames("\\d")).toBeNull();
	expect(enumeratePatternNames("\\x41")).toBeNull();
	// An unbounded pattern (`*`, `?`) has no nameable set; a top-level
	// alternation is enumerated branch by branch.
	for (const pattern of ["*", "?", "send_*"]) {
		expect(enumeratePatternNames(pattern)).toBeNull();
	}
	expect(enumeratePatternNames("{a,b}")).toEqual(["a", "b"]);
	// Every reported name is one the pattern's matcher admits.
	for (const pattern of ["a+", "foo_bar", "read_channel", "web_search_ex[a]"]) {
		const names = enumeratePatternNames(pattern)!;
		for (const name of names) {
			expect(run([name], [pattern]).allowed).toEqual([name]);
		}
	}
});

test("an over-long pattern cannot make enumeration throw", () => {
	// The parser rejects a pattern past its input limit; enumerating one must
	// decline rather than raise, because the Exa path calls it while loading
	// config — a single pasted entry must not take down config loading.
	expect(enumeratePatternNames("a".repeat(70000))).toBeNull();
});

test("a literal slash between classes routes (class, literal /, class)", () => {
	expect(run(["a/1", "a/b"], ["a/[12]"]).allowed).toEqual(["a/1"]);
	expect(run(["x/y"], ["[a-z]/[a-z]"]).allowed).toEqual(["x/y"]);
});

test("an escaped open bracket is a literal, so a slash after it is outside any class", () => {
	// `foo\[/bar*` matches `foo[/bar1` — \[ is a literal char, the slash is
	// outside any class, and picomatch's own parser resolves the escape.
	expect(run(["foo[/bar1", "foo[/bar2"], ["foo\\[/bar*"]).allowed).toEqual(["foo[/bar1", "foo[/bar2"]);
});
