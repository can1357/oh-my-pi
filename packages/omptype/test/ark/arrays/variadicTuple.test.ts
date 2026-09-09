import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("spreads simple arrays", () => {
	const WellRested = type(["string", "...", "number[]"]);
	const _0: Eq<typeof WellRested.infer, [string, ...number[]]> = true;
	expect(WellRested(["foo"])).toEqual(["foo"]);
	expect(WellRested(["foo", 1, 2])).toEqual(["foo", 1, 2]);
});

it("spreads array expressions", () => {
	const GreatSpread = type(["0", "...", "(Date|RegExp)[]"]);
	const _0: Eq<typeof GreatSpread.infer, [0, ...(RegExp | Date)[]]> = true;
});

it("distributes spread unions", () => {
	const T = type(["1", "...", "(Date[] | RegExp[])"]);
	const _0: Eq<typeof T.infer, [1, ...(Date[] | RegExp[])]> = true;
	expect(T.allows([1, new Date(), new Date()])).toBe(true);
	expect(T.allows([1, /foo/])).toBe(true);
	expect(T.allows([1, new Date(), /foo/])).toBe(false);
});

it("distributes spread union tuples", () => {
	const counting = ["2", "3", "4"] as const;
	const fibbing = ["1", "2", "3", "5", "8"] as const;
	const CountOrFib = type(counting, "|", fibbing);
	const _0: Eq<typeof CountOrFib.infer, [2, 3, 4] | [1, 2, 3, 5, 8]> = true;
	const T = type(["1", "...", CountOrFib]);
	const _1: Eq<typeof T.infer, [1, 2, 3, 4] | [1, 1, 2, 3, 5, 8]> = true;
	expect(T.allows([1, 2, 3, 4])).toBe(true);
	expect(T.allows([1, 1, 2, 3, 5, 8])).toBe(true);
	expect(T.allows([1, 2, 3])).toBe(false);
});

it("allows array keyword", () => {
	const types = scope({
		myArrayKeyword: "boolean[]",
		myVariadicKeyword: ["string", "...", "myArrayKeyword"],
	}).export();
	const _0: Eq<typeof types.myVariadicKeyword.infer, [string, ...boolean[]]> = true;
});

it("errors on non-array", () => {
	expect(() => type(["number", "...", "string"])).toThrow("tuple spread element must be an array");
});

it("allows multiple fixed spreads", () => {
	const T = type(["string", "...", "number[]", "...", ["boolean", "bigint"], "...", ["symbol"]]);
	const _0: Eq<typeof T.infer, [string, ...number[], boolean, bigint, symbol]> = true;
	expect(T.allows(["foo", 1, 2, true, 3n, Symbol.iterator])).toBe(true);
	expect(T.allows(["foo", true, 3n, Symbol.iterator])).toBe(true);
	expect(T.allows(["foo", 1, true, Symbol.iterator])).toBe(false);
});

it("errors on multiple variadic", () => {
	expect(() => type(["...", "string[]", "...", "number[]"])).toThrow(
		"a tuple may have one spread followed by an array definition",
	);
});

it("error on optional post-variadic in spread", () => {
	expect(() => type(["...", "string[]", "...", ["string?"]])).toThrow(
		"An optional element may not follow a variadic element",
	);
});

it("errors on postfix following optional", () => {
	expect(() => type(["number?", "...", "boolean[]", "symbol"])).toThrow(
		"A postfix required element cannot follow an optional or defaultable element",
	);
});

it("errors on postfix following defaultable", () => {
	expect(() => type(["number = 0", "...", "boolean[]", "symbol"])).toThrow(
		"A postfix required element cannot follow an optional or defaultable element",
	);
});

it("doesn't mistake a string literal containing '=' for defaultable", () => {
	const T = type(["'='", "number"]);

	const _0: Eq<typeof T.t, ["=", number]> = true;
	expect(T(["=", 5])).toEqual(["=", 5]);
});
