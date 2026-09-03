import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("string.numeric", () => {
	const NumericString = type("string.numeric");
	expect(NumericString("5")).toEqual("5");
	expect(NumericString("5.5")).toEqual("5.5");
	expect(String(NumericString("five"))).toBe('must be a well-formed numeric string (was "five")');
});

it("string.numeric.parse", () => {
	const parseNum = type("string.numeric.parse");
	expect(parseNum("5")).toEqual(5);
	expect(parseNum("5.5")).toEqual(5.5);
	expect(String(parseNum("five"))).toBe('must be a well-formed numeric string (was "five")');
});

it("string.integer", () => {
	const IntegerString = type("string.integer");
	expect(IntegerString("5")).toEqual("5");
	expect(String(IntegerString("5.5"))).toBe('must be a well-formed integer string (was "5.5")');
	expect(String(IntegerString("five"))).toBe('must be a well-formed integer string (was "five")');
	expect(String(IntegerString(5))).toBe("must be a string (was a number)");
	// unsafe integers are allowed within strings as long as they are not parsed
	expect(IntegerString("9007199254740992")).toEqual("9007199254740992");
});

it("string.integer.parse", () => {
	const parseIntType = type("string.integer.parse");
	expect(parseIntType("5", 10)).toEqual(5);
	expect(String(parseIntType("5.5", 10))).toBe('must be a well-formed integer string (was "5.5")');
	expect(String(parseIntType("five", 10))).toBe('must be a well-formed integer string (was "five")');
	expect(String(parseIntType(5, 10))).toBe("must be a string (was a number)");
	expect(String(parseIntType("9007199254740992", 10))).toBe('must be a safe integer string (was "9007199254740992")');
});
