import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("allows and apply", () => {
	const T = type("string[]");
	const _0: Eq<typeof T.infer, string[]> = true;
	expect(T.allows([])).toBe(true);
	expect(T([])).toEqual([]);
	expect(T.allows(["foo", "bar"])).toBe(true);
	expect(T(["foo", "bar"])).toEqual(["foo", "bar"]);
	expect(T.allows(["foo", "bar", 5])).toBe(false);
	expect(String(T(["foo", "bar", 5]))).toBe("[2] must be a string (was a number)");
	expect(T.allows([5, "foo", "bar"])).toBe(false);
	expect(String(T([5, "foo", "bar"]))).toBe("[0] must be a string (was a number)");
});

it("nested", () => {
	const T = type("string[][]");
	const _0: Eq<typeof T.infer, string[][]> = true;
	expect(T.allows([])).toBe(true);
	expect(T([])).toEqual([]);
	expect(T.allows([["foo"]])).toBe(true);
	expect(T([["foo"]])).toEqual([["foo"]]);
	expect(T.allows(["foo"])).toBe(false);
	expect(String(T(["foo"]))).toBe("[0] must be an array (was a string)");
	expect(T.allows([["foo", 5]])).toBe(false);
	expect(String(T([["foo", 5]]))).toBe("[0][1] must be a string (was a number)");
});

it("tuple expression", () => {
	const T = type(["string", "[]"]);
	const _0: Eq<typeof T.infer, string[]> = true;
	expect(T.json).toEqual(type("string[]").json);
});

it("root expression", () => {
	const T = type("string", "[]");
	const _0: Eq<typeof T.infer, string[]> = true;
	expect(T.json).toEqual(type("string[]").json);
});

it("chained", () => {
	const T = type({ a: "string" }).array();
	const _0: Eq<typeof T.infer, { a: string }[]> = true;

	expect(() => type({ a: "hmm" }).array()).toThrow('unknown keyword "hmm" in "hmm"');
});

it("incomplete token", () => {
	expect(() => type("string[")).toThrow("expected ']' in \"string[\"");
});

it("multiple errors", () => {
	const StringArray = type("string[]");
	expect(StringArray([1, 2]).toString()).toBe(`[0] must be a string (was a number)
[1] must be a string (was a number)`);
});
