import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("string.json", () => {
	const parseJson = type("string.json");
	expect(parseJson('{"a": "hello"}')).toBe('{"a": "hello"}');
	expect(String(parseJson(123))).toBe("must be a string (was a number)");

	expect(String(parseJson("{"))).toBe('must be a JSON string (was "{")');
});

it("string.json.parse", () => {
	const parseJson = type("string.json.parse");

	expect(parseJson('{"a": "hello"}')).toEqual({ a: "hello" });
	expect(String(parseJson(123))).toBe("must be a string (was a number)");

	expect(String(parseJson("{"))).toBe('must be a JSON string (was "{")');
});
