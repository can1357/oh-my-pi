import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("number", () => {
	const parseNum = type("string.numeric.parse");
	expect(parseNum("5")).toEqual(5);
	expect(parseNum(".5")).toEqual(0.5);
	expect(parseNum("5.5")).toEqual(5.5);
	expect(String(parseNum("five"))).toBe('must be a well-formed numeric string (was "five")');
});

it("integer", () => {
	const parseIntType = type("string.integer.parse");
	expect(parseIntType("5", 10)).toEqual(5);
	expect(String(parseIntType("5.5", 10))).toBe('must be a well-formed integer string (was "5.5")');
	expect(String(parseIntType("five", 10))).toBe('must be a well-formed integer string (was "five")');
	expect(String(parseIntType(5, 10))).toBe("must be a string (was a number)");
	expect(String(parseIntType("9007199254740992", 10))).toBe('must be a safe integer string (was "9007199254740992")');
});

it("date", () => {
	const parseDate = type("string.date.parse");
	expect(parseDate("5/21/1993")).toEqual(new Date("5/21/1993"));
	expect(String(parseDate("foo"))).toBe('must be a parsable date (was "foo")');
	expect(String(parseDate(5))).toBe("must be a string (was a number)");
});
