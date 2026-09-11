import { describe, expect, it } from "bun:test";
import { type ParsedReadUrlTarget, parseReadUrlTarget } from "@oh-my-pi/pi-coding-agent/tools/fetch";

describe("parseReadUrlTarget", () => {
	it("returns null for non-URL paths", () => {
		expect(parseReadUrlTarget("/etc/hosts")).toBeNull();
		expect(parseReadUrlTarget("relative/file.ts")).toBeNull();
	});

	it("returns a bare URL with no selectors", () => {
		expect(parseReadUrlTarget("https://example.com/foo")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "none" },
		});
	});

	it("peels :raw", () => {
		expect(parseReadUrlTarget("https://example.com/foo:raw")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "raw" },
		});
	});

	it("peels a single line range", () => {
		expect(parseReadUrlTarget("https://example.com/foo:50-100")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: false },
		});
		expect(parseReadUrlTarget("https://example.com/foo:50+10")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 59 }], raw: false },
		});
		expect(parseReadUrlTarget("https://example.com/foo:50")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "lines", ranges: [{ startLine: 50, endLine: undefined }], raw: false },
		});
	});

	it("peels a tail selector, alone or with :raw", () => {
		expect(parseReadUrlTarget("https://example.com/foo:-60")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "tail", count: 60, raw: false },
		});
		expect(parseReadUrlTarget("https://example.com/foo:raw:-60")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "tail", count: 60, raw: true },
		});
	});

	it("peels multi-range selectors into ranges (regression: was stuck on URL → 404)", () => {
		// Direct repro of bug report 6234.
		const result = parseReadUrlTarget("https://raw.githubusercontent.com/oven-sh/bun/main/README.md:5-10,20-30");
		expect(result).toEqual({
			path: "https://raw.githubusercontent.com/oven-sh/bun/main/README.md",
			sel: {
				kind: "lines",
				ranges: [
					{ startLine: 5, endLine: 10 },
					{ startLine: 20, endLine: 30 },
				],
				raw: false,
			},
		});
	});

	it("peels raw + range combos in both orders (regression: was stuck on URL → 404)", () => {
		// Direct repro of bug report 6230.
		const expected: ParsedReadUrlTarget = {
			path: "https://example.com/foo",
			sel: { kind: "lines", ranges: [{ startLine: 1, endLine: 120 }], raw: true },
		};
		expect(parseReadUrlTarget("https://example.com/foo:raw:1-120")).toEqual(expected);
		expect(parseReadUrlTarget("https://example.com/foo:1-120:raw")).toEqual(expected);
	});

	it("rejects two range groups on the same URL", () => {
		expect(() => parseReadUrlTarget("https://example.com/foo:5-10:20-30")).toThrow(/range groups/);
		expect(() => parseReadUrlTarget("https://example.com/foo:5-10:-30")).toThrow(/range groups/);
	});

	it("leaves URL ports intact", () => {
		// `:8080` after the host has no trailing selector character — port stays put.
		expect(parseReadUrlTarget("https://example.com:8080/foo")).toEqual({
			path: "https://example.com:8080/foo",
			sel: { kind: "none" },
		});
		// Port + selector combo still works because the selector sits on a path segment.
		expect(parseReadUrlTarget("https://example.com:8080/foo:raw")).toEqual({
			path: "https://example.com:8080/foo",
			sel: { kind: "raw" },
		});
	});

	it("treats trailing-colon selectors that don't parse as part of the URL", () => {
		// `:abc` is not a selector token; the parser leaves it on the URL.
		expect(parseReadUrlTarget("https://example.com/foo:abc")).toEqual({
			path: "https://example.com/foo:abc",
			sel: { kind: "none" },
		});
	});

	it("supports the documented `host:port/` escape for naked-host selectors", () => {
		// `https://example.com/:80` is the documented form to read line 80 of the homepage.
		expect(parseReadUrlTarget("https://example.com/:80")).toEqual({
			path: "https://example.com/",
			sel: { kind: "lines", ranges: [{ startLine: 80, endLine: undefined }], raw: false },
		});
	});

	it("repairs a collapsed scheme `https:/` → `https://` (regression: path.normalize → 404)", () => {
		// A URL run through Node's path.normalize/path.resolve loses one slash from the scheme.
		// Without the repair it falls through to filesystem resolution → "Path not found".
		expect(
			parseReadUrlTarget(
				"https:/github.com/kovidgoyal/kitty/blob/8996aa798c774ca48432c55f7d5135ebbd9390c3/kitty/graphics.c",
			),
		).toEqual({
			path: "https://github.com/kovidgoyal/kitty/blob/8996aa798c774ca48432c55f7d5135ebbd9390c3/kitty/graphics.c",
			sel: { kind: "none" },
		});
		expect(parseReadUrlTarget("http:/example.com/foo")).toEqual({
			path: "http://example.com/foo",
			sel: { kind: "none" },
		});
	});

	it("repairs a collapsed scheme while still peeling selectors", () => {
		expect(parseReadUrlTarget("https:/example.com/foo:50-100")).toEqual({
			path: "https://example.com/foo",
			sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: false },
		});
	});
});
