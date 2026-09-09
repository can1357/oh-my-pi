import { describe, expect, it } from "bun:test";
import { classifyJsonPrefix, parseJsonWithRepair, parseStreamingJson, repairJson } from "@oh-my-pi/pi-utils/json-parse";

describe("JSON repair", () => {
	it("leaves valid string escapes unchanged", () => {
		const json = String.raw`{"text":"quote: \" unicode: \u2028 slash: \/ newline: \n"}`;

		expect(repairJson(json)).toBe(json);
		const expectedText = ['quote: " unicode: ', String.fromCharCode(0x2028), " slash: / newline: \n"].join("");
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: expectedText });
	});

	it("escapes raw control characters inside string literals", () => {
		const json = '{"text":"a\nb\u0001c"}';

		expect(repairJson(json)).toBe(String.raw`{"text":"a\nb\u0001c"}`);
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: "a\nb\u0001c" });
	});

	it("preserves invalid simple escapes as literal backslashes", () => {
		const json = String.raw`{"value":"a\qb"}`;

		expect(repairJson(json)).toBe(String.raw`{"value":"a\\qb"}`);
		expect(parseJsonWithRepair<{ value: string }>(json)).toEqual({ value: String.raw`a\qb` });
	});
	it("returns an empty object for whitespace-only streaming JSON", () => {
		expect(parseStreamingJson<Record<string, unknown>>(" \t\n\r")).toEqual({});
	});
});

describe("classifyJsonPrefix strict streaming classification", () => {
	it("classifies complete values, extendable prefixes, and unsalvageable buffers", () => {
		const cases: Array<{ name: string; input: string; expected: "complete" | "prefix" | "invalid" }> = [
			{ name: "empty buffer waits for a value", input: "", expected: "prefix" },
			{ name: "whitespace-only buffer waits for a value", input: " \t\n\r", expected: "prefix" },
			{
				name: "object with an unfinished string value is still extendable",
				input: '{"command":"echo ',
				expected: "prefix",
			},
			{
				name: "complete object with brace text inside a string is complete",
				input: '{"command":"echo {1..3}"}',
				expected: "complete",
			},
			{
				name: "complete nested arrays and objects are complete",
				input: '{"a":[1,{"b":true},null]}',
				expected: "complete",
			},
			{ name: "nested array value can stop mid-object", input: '{"a":[1,{"b":', expected: "prefix" },
			{
				name: "raw control character inside a string is invalid",
				input: '{"command":"echo hello\n',
				expected: "invalid",
			},
			{ name: "second top-level value after a complete object is invalid", input: '{"a":1}{', expected: "invalid" },
			{ name: "brace expansion syntax is not JSON object grammar", input: "{1..3}", expected: "invalid" },
			{ name: "escape sequence can split after the backslash", input: '{"a":"\\', expected: "prefix" },
			{ name: "unicode escape can split in the hex digits", input: '{"a":"\\u12', expected: "prefix" },
			{ name: "bad escape is invalid", input: '{"a":"\\q"}', expected: "invalid" },
			{ name: "leading-zero number is invalid strict JSON", input: '{"a":01}', expected: "invalid" },
			{ name: "top-level number at EOF is complete", input: "12", expected: "complete" },
		];

		for (const { name, input, expected } of cases) {
			expect(classifyJsonPrefix(input), name).toBe(expected);
		}
	});
});

describe("parseJsonWithRepair relaxed (final) parsing", () => {
	it("accepts single-quoted strings and keys", () => {
		expect(parseJsonWithRepair<{ path: string }>("{'path': 'a.ts'}")).toEqual({ path: "a.ts" });
	});

	it("accepts unquoted object keys", () => {
		expect(parseJsonWithRepair<{ path: string; count: number }>('{path: "a.ts", count: 2}')).toEqual({
			path: "a.ts",
			count: 2,
		});
	});

	it("strips trailing and stray commas", () => {
		expect(parseJsonWithRepair<{ a: number }>('{"a":1,}')).toEqual({ a: 1 });
		expect(parseJsonWithRepair<number[]>("[1, 2, ]")).toEqual([1, 2]);
	});

	it("coerces Python literals to JSON literals", () => {
		expect(
			parseJsonWithRepair<{ ok: boolean; no: boolean; nil: null }>('{"ok": True, "no": False, "nil": None}'),
		).toEqual({
			ok: true,
			no: false,
			nil: null,
		});
	});

	it("recovers an unescaped apostrophe inside a single-quoted string", () => {
		expect(parseJsonWithRepair<{ msg: string }>("{'msg': 'it's fine'}")).toEqual({ msg: "it's fine" });
	});

	it("ignores // and /* */ comments", () => {
		expect(parseJsonWithRepair<{ a: number; b: number }>('{"a":1 /* c */, "b":2 // trailing\n}')).toEqual({
			a: 1,
			b: 2,
		});
	});

	it("does NOT swallow structure through unescaped double quotes (throws)", () => {
		expect(() => parseJsonWithRepair('{"a":"x" "b":1}')).toThrow();
	});

	it("rejects JS-only NaN / Infinity rather than executing a non-finite arg", () => {
		expect(() => parseJsonWithRepair('{"a": NaN}')).toThrow();
		expect(() => parseJsonWithRepair('{"a": Infinity}')).toThrow();
	});

	it("throws on trailing garbage after a complete value", () => {
		expect(() => parseJsonWithRepair('{"a":1} then prose')).toThrow();
	});

	it("recovers an unquoted bareword string value (real-world input_json_delta malformation)", () => {
		expect(
			parseJsonWithRepair<{ paths: string; i: string }>(
				'{"paths": packages/coding-agent/src/stt/*, "i": "Listing stt module files"}',
			),
		).toEqual({ paths: "packages/coding-agent/src/stt/*", i: "Listing stt module files" });
	});

	it("recovers barewords in array position and trims trailing whitespace before the delimiter", () => {
		expect(parseJsonWithRepair<{ paths: string[]; n: number }>('{"paths": [src/a/*, src/b/* ], "n": 3}')).toEqual({
			paths: ["src/a/*", "src/b/*"],
			n: 3,
		});
		expect(parseJsonWithRepair<{ i: string; b: boolean }>('{"i": Listing stt files   , "b": true}')).toEqual({
			i: "Listing stt files",
			b: true,
		});
	});

	it("recovers URL / Windows-path colons and apostrophes inside barewords", () => {
		expect(parseJsonWithRepair<{ url: string }>('{"url": https://example.com/x?y=1}')).toEqual({
			url: "https://example.com/x?y=1",
		});
		expect(parseJsonWithRepair<{ p: string }>('{"p": C:\\Users\\x}')).toEqual({ p: "C:\\Users\\x" });
		expect(parseJsonWithRepair<{ msg: string; b: number }>('{"msg": it\'s fine, "b": 1}')).toEqual({
			msg: "it's fine",
			b: 1,
		});
	});

	it("still throws when a bareword is truncated or would swallow structure (missed comma)", () => {
		expect(() => parseJsonWithRepair('{"a": packages/foo')).toThrow();
		expect(() => parseJsonWithRepair('{"a": foo "b": 1}')).toThrow();
		expect(() => parseJsonWithRepair("{a: foo b: 1}")).toThrow();
		expect(() => parseJsonWithRepair('{"a": foo {"b": 1}}')).toThrow();
		expect(() => parseJsonWithRepair('{"a": foo [1]}')).toThrow();
	});

	it("still throws on key-like colons and JS undefined in value position", () => {
		expect(() => parseJsonWithRepair('{"addr": localhost:8080}')).toThrow();
		expect(() => parseJsonWithRepair('{"a": undefined}')).toThrow();
	});
});

describe("parseStreamingJson partial parsing", () => {
	it("auto-closes a truncated object and string", () => {
		expect(parseStreamingJson<{ a: number }>('{"a":1')).toEqual({ a: 1 });
		expect(parseStreamingJson<{ q: string }>('{"q":"hel')).toEqual({ q: "hel" });
	});

	it("rolls back an incomplete trailing keyword to the last valid prefix", () => {
		expect(parseStreamingJson<{ a: number }>('{"a":1,"b":tru')).toEqual({ a: 1 });
		expect(parseStreamingJson<Record<string, unknown>>('{"a":tru')).toEqual({});
	});

	it("never surfaces NaN from an incomplete or non-finite number", () => {
		expect(parseStreamingJson<Record<string, unknown>>('{"a":1.5e')).toEqual({});
		expect(parseStreamingJson<Record<string, unknown>>('{"a":NaN}')).toEqual({});
		expect(parseStreamingJson<Record<string, unknown>>('{"a":Truex}')).toEqual({});
	});

	it("rolls back a bareword at the streaming edge or mid-buffer instead of committing junk", () => {
		expect(parseStreamingJson<Record<string, unknown>>('{"paths": packages/coding-agent/src/stt/*')).toEqual({});
		expect(
			parseStreamingJson<Record<string, unknown>>('{"paths": packages/coding-agent/src/stt/*, "i": "Listing st'),
		).toEqual({});
	});
});
