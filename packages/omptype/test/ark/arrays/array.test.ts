import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

describe("variadic tuple", () => {
	it("allows multiple fixed spreads", () => {
		const T = type(["string", "...", "number[]", "...", ["boolean", "bigint"], "...", ["symbol"]]);
		const Expected = type(["string", "...", "number[]", "boolean", "bigint", "symbol"]);
		const _0: Eq<typeof T.infer, [string, ...number[], boolean, bigint, symbol]> = true;
		const _1: Eq<typeof Expected.infer, typeof T.infer> = true;
		expect(T.allows(["foo", 1, 2, true, 3n, Symbol.iterator])).toBe(true);
		expect(T.allows(["foo", true, 3n, Symbol.iterator])).toBe(true);
		expect(T.allows(["foo", 1, true, Symbol.iterator])).toBe(false);
	});
});

it("readonly arrays and tuples", () => {
	const ReadonlyArray = type("string[]").readonly();
	const ReadonlyTuple = type(["string", "number"]).readonly();
	const _0: Eq<typeof ReadonlyArray.infer, readonly string[]> = true;
	const _1: Eq<typeof ReadonlyTuple.infer, readonly [string, number]> = true;
	expect(ReadonlyArray(["foo"])).toEqual(["foo"]);
	expect(ReadonlyTuple(["foo", 1])).toEqual(["foo", 1]);
});
