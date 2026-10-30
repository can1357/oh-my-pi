import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("number", () => {
	const parseNum = type("string.numeric.parse");
	expect(parseNum("5")).toEqual(5);
	expect(parseNum(".5")).toEqual(0.5);
	expect(parseNum("5.5")).toEqual(5.5);
	expect(String(parseNum("five"))).toBe('must be a well-formed numeric string (was "five")');
});
