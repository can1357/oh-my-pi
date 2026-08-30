import { describe, expect, it, vi } from "bun:test";
import { applyMCPToolFilter, filterMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/tool-filter";
import { logger } from "@oh-my-pi/pi-utils";

// `filterMCPTools`/`applyMCPToolFilter` implement the per-server
// `enabledTools`/`disabledTools` contract from issue #6299: filter before
// tools reach the model context, fnmatch globs, denylist subtracts from
// allowlist, unknown entries warn-and-drop, all-excluding filters return no tools.

describe("filterMCPTools", () => {
	const tools = ["search", "read", "schedule_message", "create_canvas", "channel_read", "channel_write"];

	it("allowlists literal names and glob patterns against raw advertised names", () => {
		expect(filterMCPTools({ toolNames: tools, enabledTools: ["search", "channel_*"] }).allowed).toEqual([
			"search",
			"channel_read",
			"channel_write",
		]);
	});

	it("denylist excludes literal names and glob patterns", () => {
		expect(filterMCPTools({ toolNames: tools, disabledTools: ["schedule_message", "create_*"] }).allowed).toEqual([
			"search",
			"read",
			"channel_read",
			"channel_write",
		]);
	});

	it("denylist subtracts from the allowlist when both are set", () => {
		const result = filterMCPTools({
			toolNames: tools,
			enabledTools: ["*_*", "search"],
			disabledTools: ["schedule_*"],
		});
		// "search" matches the literal allowlist entry; schedule_* is denied.
		expect(result.allowed).toEqual(["search", "create_canvas", "channel_read", "channel_write"]);
	});

	it("reports config entries that matched no advertised tool, keeping config order", () => {
		const result = filterMCPTools({
			toolNames: tools,
			enabledTools: ["search", "typo_tool", "nope_*"],
			disabledTools: ["missing_*"],
		});
		expect(result.allowed).toEqual(["search"]);
		expect(result.unmatched).toEqual(["typo_tool", "nope_*", "missing_*"]);
	});

	it("does not treat an unset filter as an allowlist of zero entries", () => {
		expect(filterMCPTools({ toolNames: tools, enabledTools: [] }).allowed).toEqual(tools);
		expect(filterMCPTools({ toolNames: tools, disabledTools: [] }).allowed).toEqual(tools);
	});

	it("matches a tool name even when another entry is an invalid glob", () => {
		const result = filterMCPTools({ toolNames: ["search"], enabledTools: ["[", "search"] });
		expect(result.allowed).toEqual(["search"]);
		expect(result.unmatched).toEqual(["["]);
	});

	// MCP tool names are opaque strings, not filesystem paths: `*` and `?`
	// must cross `/` so a denylist like ["*"] cannot leak a tool named "admin/delete".
	it("globs match `/` in opaque tool names (not path semantics)", () => {
		const namespaced = ["search", "admin/delete", "admin/create", "a/c"];
		// denylist `*` removes everything including slash-bearing names
		expect(filterMCPTools({ toolNames: namespaced, disabledTools: ["*"] }).allowed).toEqual([]);
		// allowlist `admin*` admits slash-bearing names
		expect(filterMCPTools({ toolNames: namespaced, enabledTools: ["admin*"] }).allowed).toEqual([
			"admin/delete",
			"admin/create",
		]);
		// `?` crosses `/`
		expect(filterMCPTools({ toolNames: namespaced, enabledTools: ["a?c"] }).allowed).toEqual(["a/c"]);
		// brace alternation and char classes still work
		expect(filterMCPTools({ toolNames: namespaced, enabledTools: ["{search,admin/*}"] }).allowed).toEqual([
			"search",
			"admin/delete",
			"admin/create",
		]);
	});

	it("braces without a comma are literal, not regex groups", () => {
		// `{delete}` has no comma, so it must NOT become a regex group `(?:delete)`
		// that matches `admin_delete`. It should match the literal `admin_{delete}`.
		expect(
			filterMCPTools({
				toolNames: ["admin_{delete}", "admin_delete"],
				enabledTools: ["admin_{delete}"],
			}).allowed,
		).toEqual(["admin_{delete}"]);
	});
	// fnmatch negates a class only on a leading `!`; a leading `^` is a literal
	// member. Emitting `[^a]` verbatim would let JavaScript negate the class and
	// admit nearly every name.
	it("a leading caret in a class is a literal member, not negation", () => {
		const names = ["^search", "archive", "search", "beta"];
		// `[^a]*` = first char is ^ or a
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[^a]*"] }).allowed).toEqual(["^search", "archive"]);
		// `[!a]*` = negation: first char is anything but a
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[!a]*"] }).allowed).toEqual([
			"^search",
			"search",
			"beta",
		]);
		// caret-only classes: `[!^]*` negates just ^; `[^]*` matches literal ^
		// (a leading `]` after `^`/members is the class terminator, not literal)
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[!^]*"] }).allowed).toEqual([
			"archive",
			"search",
			"beta",
		]);
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[^]*"] }).allowed).toEqual(["^search"]);
	});

	// fnmatch treats a `]` as a literal member when it is the FIRST class body
	// char — including in negated classes, where the body starts after `[!`.
	// Regression: the leading-`]`-literal rule was guarded on `cls === ""`,
	// which the `!` negation prefix had already overwritten, so `[!]]*`
	// translated to a class that admitted nearly every name a denylist meant
	// to exclude. Expectations verified pattern-for-pattern against Python
	// fnmatch.fnmatchcase.
	it("a leading ] is a literal class member even in negated classes", () => {
		const names = ["ax", "]ax", "abc", "]abc", "b1"];
		// `[!]]?` = one char that is not `]`, then any char
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[!]]?"] }).allowed).toEqual(["ax", "b1"]);
		// `[!]]*` = first char is not `]`
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[!]]*"] }).allowed).toEqual(["ax", "abc", "b1"]);
		// `[]]*` = first char IS `]` (positive class with leading literal member)
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[]]*"] }).allowed).toEqual(["]ax", "]abc"]);
		// in a denylist, `[!]]*` must therefore exclude exactly the `]`-prefixed names
		expect(filterMCPTools({ toolNames: names, disabledTools: ["[!]]*"] }).allowed).toEqual(["]ax", "]abc"]);
	});

	// fnmatch treats a descending range (`z-a`) as an EMPTY class: a positive
	// empty class matches nothing, a negated empty class matches everything.
	// Regression: interpolating `z-a` verbatim into the regex threw
	// "range out of order", so `matches()` reported false for every name —
	// an allowlist entry silently disabled the server and a denylist entry
	// excluded nothing. Expectations verified against Python
	// fnmatch.fnmatchcase.
	it("a descending range is an empty class (positive matches nothing, negated matches everything)", () => {
		const names = ["ax", "zx", "beta"];
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[z-a]*"] }).allowed).toEqual([]);
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[!z-a]*"] }).allowed).toEqual(names);
		expect(filterMCPTools({ toolNames: names, disabledTools: ["[!z-a]*"] }).allowed).toEqual([]);
		expect(filterMCPTools({ toolNames: names, disabledTools: ["[z-a]*"] }).allowed).toEqual(names);
		// ascending ranges and fnmatch hyphen-literal rules are unaffected
		expect(filterMCPTools({ toolNames: names, enabledTools: ["[a-z]*"] }).allowed).toEqual(names);
		expect(filterMCPTools({ toolNames: ["ax", "1x", "beta"], enabledTools: ["[!a-z]*"] }).allowed).toEqual(["1x"]);
		expect(filterMCPTools({ toolNames: ["a-", "ax"], enabledTools: ["[a-]*"] }).allowed).toEqual(["a-", "ax"]);
		expect(filterMCPTools({ toolNames: ["-x", "ax"], enabledTools: ["[-a]*"] }).allowed).toEqual(["-x", "ax"]);
		// a literal-dash member mixed with an ascending range still matches
		expect(filterMCPTools({ toolNames: ["z-a", "ax"], enabledTools: ["[a-z0-9-]*"] }).allowed).toEqual(["z-a", "ax"]);
	});
});

describe("applyMCPToolFilter", () => {
	it("warns about unknown entries but keeps the server usable", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const allowed = applyMCPToolFilter("slack", {
				toolNames: ["search", "read"],
				enabledTools: ["search", "renamed_tool"],
			});
			expect(allowed).toEqual(["search"]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn when every filter entry matches", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const allowed = applyMCPToolFilter("slack", {
				toolNames: ["search", "read"],
				enabledTools: ["search", "read"],
			});
			expect(allowed).toEqual(["search", "read"]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("returns [] without throwing when the filter excludes every advertised tool", () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		try {
			expect(applyMCPToolFilter("slack", { toolNames: ["search"], enabledTools: ["read"] })).toEqual([]);
			expect(applyMCPToolFilter("slack", { toolNames: ["search", "read"], disabledTools: ["*"] })).toEqual([]);
		} finally {
			error.mockRestore();
		}
	});

	it("marks the result filter-empty when a configured filter excludes every tool", () => {
		expect(filterMCPTools({ toolNames: ["search"], enabledTools: ["read"] }).filterEmpty).toBe(true);
		expect(filterMCPTools({ toolNames: ["search", "read"], disabledTools: ["*"] }).filterEmpty).toBe(true);
	});

	it("is not filter-empty when no filter is configured or some tools pass", () => {
		expect(filterMCPTools({ toolNames: ["search", "read"] }).filterEmpty).toBe(false);
		expect(filterMCPTools({ toolNames: ["search", "read"], enabledTools: ["search"] }).filterEmpty).toBe(false);
		expect(
			filterMCPTools({ toolNames: ["search", "read"], enabledTools: ["*"], disabledTools: ["read"] }).filterEmpty,
		).toBe(false);
	});

	it("is not filter-empty for a zero-tool server even with a filter configured", () => {
		expect(filterMCPTools({ toolNames: [], enabledTools: ["search"] }).filterEmpty).toBe(false);
		expect(filterMCPTools({ toolNames: [], disabledTools: ["*"] }).filterEmpty).toBe(false);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		try {
			expect(applyMCPToolFilter("slack", { toolNames: [], enabledTools: ["search"] })).toEqual([]);
			// entries match no advertised tool, so the warn fires — but the
			// error message must never claim a filter excluded 0 tools
			expect(warn).toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			error.mockRestore();
		}
	});
});
