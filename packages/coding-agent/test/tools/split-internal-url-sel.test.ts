import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { peelWriteUrlSelector } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

const split = (input: string) => InternalUrlRouter.instance().split(input);

describe("InternalUrlRouter.split", () => {
	it("returns the input unchanged when there is no selector tail", () => {
		expect(split("artifact://3")).toEqual({ path: "artifact://3" });
		expect(split("agent://reviewer_0")).toEqual({ path: "agent://reviewer_0" });
		expect(split("memory://root")).toEqual({ path: "memory://root" });
	});

	it("peels a single line-range selector", () => {
		expect(split("artifact://3:1-100")).toEqual({ path: "artifact://3", sel: "1-100" });
		expect(split("artifact://3:50+150")).toEqual({ path: "artifact://3", sel: "50+150" });
		expect(split("artifact://3:50-")).toEqual({ path: "artifact://3", sel: "50-" });
	});

	it("peels a `raw` selector", () => {
		expect(split("artifact://3:raw")).toEqual({ path: "artifact://3", sel: "raw" });
	});

	it("peels compound `raw:range` selectors in either order", () => {
		expect(split("artifact://3:raw:1-100")).toEqual({
			path: "artifact://3",
			sel: "raw:1-100",
		});
		expect(split("artifact://3:1-100:raw")).toEqual({
			path: "artifact://3",
			sel: "1-100:raw",
		});
	});

	it("peels the malformed `:-N` selector that the strict splitter misses (the original bug)", () => {
		expect(split("artifact://3:raw:-100")).toEqual({
			path: "artifact://3",
			sel: "raw:-100",
		});
		expect(split("artifact://3:-100")).toEqual({ path: "artifact://3", sel: "-100" });
	});

	it("peels selectors from skill URLs with namespaced hosts", () => {
		expect(split("skill://superpowers:brainstorming:1-5")).toEqual({
			path: "skill://superpowers:brainstorming",
			sel: "1-5",
		});
	});

	it("does not peel chunks that are not selector-shaped", () => {
		// `name` is part of the host, not a selector.
		expect(split("skill://plugin:name")).toEqual({ path: "skill://plugin:name" });
	});

	it("stops at the scheme separator `://`", () => {
		expect(split("agent://1-50")).toEqual({ path: "agent://1-50" });
	});

	it("keeps bare-integer suffixes on mcp:// URLs (could be a port)", () => {
		expect(split("mcp://some/resource:1234")).toEqual({
			path: "mcp://some/resource:1234",
		});
	});

	it("treats mcp:// URIs as opaque by default — selector-shaped suffixes are NOT peeled", () => {
		// MCP resource URIs are server-defined and may legitimately end with `:raw`,
		// `:1-50`, etc. Without an explicit escape the URI must be forwarded verbatim
		// to the protocol handler so server-defined resources remain reachable.
		expect(split("mcp://server/resource:1-50")).toEqual({
			path: "mcp://server/resource:1-50",
		});
		expect(split("mcp://server/resource:raw")).toEqual({
			path: "mcp://server/resource:raw",
		});
		expect(split("mcp://server/resource:L10")).toEqual({
			path: "mcp://server/resource:L10",
		});
		expect(split("mcp://server/resource:conflicts")).toEqual({
			path: "mcp://server/resource:conflicts",
		});
	});

	it("keeps escaped selector-shaped mcp:// suffixes opaque too", () => {
		// MCP resource URIs are exact server-defined IDs. A resource may
		// legitimately end in `/:raw` or `/:1-50`; splitting before resolution
		// would make that resource unreachable with no exact-URI escape hatch.
		expect(split("mcp://server/resource/:1-50")).toEqual({
			path: "mcp://server/resource/:1-50",
		});
		expect(split("mcp://server/resource/:raw")).toEqual({
			path: "mcp://server/resource/:raw",
		});
		expect(split("mcp://server/resource/:L10")).toEqual({
			path: "mcp://server/resource/:L10",
		});
		expect(split("mcp://server/resource/:conflicts")).toEqual({
			path: "mcp://server/resource/:conflicts",
		});
	});

	it("keeps `mcp://:1-50`-shaped degenerate inputs opaque", () => {
		// All mcp:// inputs are forwarded verbatim (its spec declares `opaque`
		// selectors). This covers the edge case where the only `:` candidate
		// for peeling sits next to the scheme's own `://`, so any peeler that ever
		// replaces the opaque-scheme guard must still refuse these inputs.
		expect(split("mcp://:1-50")).toEqual({ path: "mcp://:1-50" });
		expect(split("mcp://:raw")).toEqual({ path: "mcp://:raw" });
	});

	it("keeps mcp:// trailing-slash bare-integer suffixes opaque", () => {
		// `:1234` could be a port number after a path. The opaque-scheme rule keeps
		// it verbatim either way; if mcp ever moves to selector-aware peeling, a
		// richer selector form should be required before treating `:N` as a tail.
		expect(split("mcp://server/resource/:1234")).toEqual({
			path: "mcp://server/resource/:1234",
		});
	});

	it("returns the input unchanged for non-URL strings", () => {
		expect(split("/abs/path:1-50")).toEqual({ path: "/abs/path:1-50" });
		expect(split("plain-text")).toEqual({ path: "plain-text" });
	});

	it("does not peel for unknown schemes", () => {
		expect(split("http://example.com:1-50")).toEqual({
			path: "http://example.com:1-50",
		});
	});

	it("keeps a `portAuthority` port (`ssh://host:port`) out of selector peeling", () => {
		expect(split("ssh://host:2222")).toEqual({ path: "ssh://host:2222" });
	});

	it("peels a read selector after an `ssh://host:port/path`", () => {
		expect(split("ssh://host:2222/etc/hosts:1-5")).toEqual({
			path: "ssh://host:2222/etc/hosts",
			sel: "1-5",
		});
	});

	it("still peels authority-trailing selectors for schemes without a port authority (artifact://5:1-50)", () => {
		expect(split("artifact://5:1-50")).toEqual({ path: "artifact://5", sel: "1-50" });
	});
});

describe("peelWriteUrlSelector (write/read selector parity)", () => {
	it("peels whole-file display selectors so write targets the same file read does", () => {
		expect(peelWriteUrlSelector("ssh://h/f:raw")).toBe("ssh://h/f");
		expect(peelWriteUrlSelector("ssh://h/f:conflicts")).toBe("ssh://h/f");
	});

	it("matches read's case-insensitive selector grammar", () => {
		expect(peelWriteUrlSelector("ssh://h/f:RAW")).toBe("ssh://h/f");
		expect(peelWriteUrlSelector("ssh://h/f:Conflicts")).toBe("ssh://h/f");
	});

	it("passes through paths with no peelable selector", () => {
		expect(peelWriteUrlSelector("ssh://h/f")).toBe("ssh://h/f");
		expect(peelWriteUrlSelector("vault://note")).toBe("vault://note");
		// A real filesystem path with a colon is not a scheme:// URL, so it is never peeled.
		expect(peelWriteUrlSelector("/tmp/local:1-20")).toBe("/tmp/local:1-20");
	});

	it("applies the same peel to every write-capable internal scheme (intentional, matches read's target)", () => {
		// vault:// and local:// writes peel display selectors too — write targets
		// the base resource read resolves, not a note/file literally named `note:raw`.
		expect(peelWriteUrlSelector("vault://note:raw")).toBe("vault://note");
		expect(peelWriteUrlSelector("local://foo.txt:conflicts")).toBe("local://foo.txt");
		expect(() => peelWriteUrlSelector("vault://note:1-20")).toThrow(/whole file/);
	});

	it("rejects line-range and malformed selectors instead of silently stripping them", () => {
		expect(() => peelWriteUrlSelector("ssh://h/f:1-20")).toThrow(/whole file/);
		expect(() => peelWriteUrlSelector("ssh://h/f:-10")).toThrow(/whole file/);
		expect(() => peelWriteUrlSelector("ssh://h/f:raw:1-20")).toThrow(/whole file/);
		expect(() => peelWriteUrlSelector("ssh://h/f:conflicts:1-20")).toThrow(/whole file/);
	});
});
