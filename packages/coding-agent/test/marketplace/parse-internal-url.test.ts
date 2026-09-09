import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";

// ── Basic parsing (URLs that new URL() handles fine) ─────────────────

describe("parseInternalUrl — standard URLs", () => {
	it("parses a simple skill:// URL", () => {
		const u = parseInternalUrl("skill://brainstorming");
		expect(u.rawHost).toBe("brainstorming");
		expect(u.protocol).toBe("skill:");
	});

	it("parses skill:// with path", () => {
		const u = parseInternalUrl("skill://my-skill/subdir/file.md");
		expect(u.rawHost).toBe("my-skill");
		expect(u.rawPathname).toBe("/subdir/file.md");
	});

	it("parses agent:// URL", () => {
		const u = parseInternalUrl("agent://reviewer_0");
		expect(u.rawHost).toBe("reviewer_0");
		expect(u.protocol).toBe("agent:");
	});

	it("parses agent:// with path extraction", () => {
		const u = parseInternalUrl("agent://output_id/field");
		expect(u.rawHost).toBe("output_id");
		expect(u.rawPathname).toBe("/field");
	});

	it("parses memory:// URL", () => {
		const u = parseInternalUrl("memory://root");
		expect(u.rawHost).toBe("root");
		expect(u.protocol).toBe("memory:");
	});

	it("parses local:// URL", () => {
		const u = parseInternalUrl("local://PLAN.md");
		expect(u.rawHost).toBe("PLAN.md");
		expect(u.protocol).toBe("local:");
	});

	it("preserves query parameters when URL parses normally", () => {
		const u = parseInternalUrl("agent://output_id?q=foo.bar");
		expect(u.rawHost).toBe("output_id");
		expect(u.searchParams.get("q")).toBe("foo.bar");
	});

	it("preserves href", () => {
		const input = "skill://my-skill/path";
		const u = parseInternalUrl(input);
		expect(u.href).toContain("skill://");
	});
});

// ── Namespaced URLs (colons in host — new URL() fails) ───────────────

describe("parseInternalUrl — namespaced host (colon in host)", () => {
	it("parses skill://plugin:name (colon as namespace separator)", () => {
		const u = parseInternalUrl("skill://superpowers:brainstorming");
		expect(u.rawHost).toBe("superpowers:brainstorming");
		expect(u.protocol).toBe("skill:");
		expect(u.rawPathname).toBe("");
	});

	it("parses skill://plugin:name/path", () => {
		const u = parseInternalUrl("skill://superpowers:brainstorming/subdir/file.md");
		expect(u.rawHost).toBe("superpowers:brainstorming");
		expect(u.rawPathname).toBe("/subdir/file.md");
	});

	it("parses skill://plugin:name:suffix (multiple colons)", () => {
		const u = parseInternalUrl("skill://superpowers:brainstorming:1-5");
		expect(u.rawHost).toBe("superpowers:brainstorming:1-5");
		expect(u.protocol).toBe("skill:");
	});

	it("parses namespaced URL with path after multiple colons", () => {
		const u = parseInternalUrl("skill://superpowers:brainstorming:1-5/extra");
		expect(u.rawHost).toBe("superpowers:brainstorming:1-5");
		expect(u.rawPathname).toBe("/extra");
	});

	it("provides empty searchParams for fallback-parsed URLs", () => {
		const u = parseInternalUrl("skill://superpowers:brainstorming");
		// searchParams should exist and be empty (not throw)
		expect(u.searchParams.get("q")).toBeNull();
	});
});

// ── Percent-encoded colons ───────────────────────────────────────────

describe("parseInternalUrl — percent-encoded host", () => {
	it("decodes %3A in host to colon", () => {
		const u = parseInternalUrl("skill://superpowers%3Abrainstorming");
		expect(u.rawHost).toBe("superpowers:brainstorming");
	});

	it("decodes %3A with path", () => {
		const u = parseInternalUrl("skill://superpowers%3Abrainstorming/file.md");
		expect(u.rawHost).toBe("superpowers:brainstorming");
		expect(u.rawPathname).toBe("/file.md");
	});

	it("decodes multiple %3A segments", () => {
		const u = parseInternalUrl("skill://a%3Ab%3Ac");
		expect(u.rawHost).toBe("a:b:c");
	});

	it("decodes mixed %3A and literal colons consistently", () => {
		// literal colon triggers fallback; %3A is decoded in rawHost
		const u1 = parseInternalUrl("skill://plugin:name");
		const u2 = parseInternalUrl("skill://plugin%3Aname");
		expect(u1.rawHost).toBe(u2.rawHost);
	});
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("parseInternalUrl — edge cases", () => {
	it("throws on completely invalid input", () => {
		expect(() => parseInternalUrl("not-a-url")).toThrow(/Invalid URL/);
	});

	it("throws on empty string", () => {
		expect(() => parseInternalUrl("")).toThrow(/Invalid URL/);
	});

	it("parses empty host", () => {
		const u = parseInternalUrl("skill:///path/to/file");
		expect(u.rawHost).toBe("");
		expect(u.rawPathname).toBe("/path/to/file");
	});

	it("handles host with only valid port (new URL succeeds)", () => {
		// skill://host:8080 — new URL() parses this with hostname=host, port=8080
		// rawHost should still capture the full "host:8080" via regex
		const u = parseInternalUrl("skill://host:8080");
		expect(u.rawHost).toBe("host:8080");
	});

	it("handles host with hyphens and dots", () => {
		const u = parseInternalUrl("skill://my-plugin.v2");
		expect(u.rawHost).toBe("my-plugin.v2");
	});

	it("handles uppercase scheme", () => {
		const u = parseInternalUrl("SKILL://my-skill");
		expect(u.rawHost).toBe("my-skill");
		expect(u.protocol).toBe("skill:");
	});

	it("preserves hash fragment when URL parses", () => {
		const u = parseInternalUrl("agent://output#section");
		expect(u.rawHost).toBe("output");
	});

	it("does not include query in rawHost", () => {
		const u = parseInternalUrl("agent://output?q=test");
		expect(u.rawHost).toBe("output");
	});

	it("does not include path in rawHost", () => {
		const u = parseInternalUrl("agent://output/deep/path");
		expect(u.rawHost).toBe("output");
		expect(u.rawPathname).toBe("/deep/path");
	});

	it("rawHost does not include fragment", () => {
		const u = parseInternalUrl("skill://name#frag");
		expect(u.rawHost).toBe("name");
	});
});

// ── Protocol extraction ──────────────────────────────────────────────

describe("parseInternalUrl — protocol field", () => {
	it("extracts skill: protocol", () => {
		expect(parseInternalUrl("skill://x").protocol).toBe("skill:");
	});

	it("extracts agent: protocol", () => {
		expect(parseInternalUrl("agent://x").protocol).toBe("agent:");
	});

	it("extracts memory: protocol", () => {
		expect(parseInternalUrl("memory://x").protocol).toBe("memory:");
	});

	it("extracts local: protocol", () => {
		expect(parseInternalUrl("local://x").protocol).toBe("local:");
	});

	it("extracts protocol from fallback-parsed URL", () => {
		// This URL fails new URL() due to colon-as-port
		expect(parseInternalUrl("skill://a:b").protocol).toBe("skill:");
	});
});
