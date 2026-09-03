import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

const parseNumber = (s: string) => Number(s);

it("applies to input", () => {
	const stringIsLong = (s: string) => s.length > 5;
	const ParseLongNumber = type("string").pipe(parseNumber).filter(stringIsLong);

	const _t: Eq<typeof ParseLongNumber.t, (In: string) => number> = true;

	expect(ParseLongNumber("123456")).toEqual(123456);
	expect(String(ParseLongNumber("123"))).toBe('must be valid according to stringIsLong (was "123")');
	expect(String(ParseLongNumber(123456))).toBe("must be a string (was a number)");
});

it("predicate inferred on input", () => {
	const stringIsIntegerLike = (s: string): s is `${bigint}` => /^-?\d+$/.test(s);
	const ParseIntegerLike = type("string").pipe(parseNumber).filter(stringIsIntegerLike);

	const _t: Eq<typeof ParseIntegerLike.t, (In: `${bigint}`) => number> = true;

	expect(ParseIntegerLike("123456")).toEqual(123456);
	expect(String(ParseIntegerLike("3.14159"))).toBe('must be valid according to stringIsIntegerLike (was "3.14159")');
	expect(String(ParseIntegerLike(123456))).toBe("must be a string (was a number)");
});
