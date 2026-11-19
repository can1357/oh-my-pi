import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("Function", () => {
	// should not be treated as a morph
	const fnType = type("Function");
	const _0: Eq<typeof fnType.infer, Function> = true;
});

it("Date", () => {
	// should not expand built-in classes
	const dateType = type("Date");
	const _1: Eq<typeof dateType.infer, Date> = true;
});

describe("json", () => {
	it("root", () => {
		const Json = type("object.json");

		const _2: Eq<typeof Json.infer, unknown> = true;

		expect(Json({})).toEqual({});
		expect(Json([])).toEqual([]);
		expect(String(Json(5))).toBe("must be an object (was a number)");
		expect(String(Json({ foo: [5n] }))).toBe(
			"foo[0] must be an object, a number, a string, false, null or true (was a bigint)",
		);
	});

	it("stringify", () => {
		const stringify = type("object.json.stringify");

		const out = stringify.assert({ foo: "bar" });

		expect(out).toBe('{"foo":"bar"}');

		// this error kind of sucks, should have more discriminant context
		expect(String(stringify({ foo: undefined }))).toBe(
			"foo must be an object, a number, a string, false, null or true (was undefined)",
		);

		// has declared out
		const _3: Eq<typeof stringify.out.infer, string> = true;
		expect(stringify.out.expression).toBe("string");
	});
});

describe("liftArray", () => {
	it("parsed", () => {
		const liftNumberArray = type("Array.liftFrom<number>");

		expect(liftNumberArray(5)).toEqual([5]);
		expect(liftNumberArray([5])).toEqual([5]);
		expect(String(liftNumberArray("five"))).toBe("must be a number or an object (was a string)");
		expect(String(liftNumberArray(["five"]))).toBe("[0] must be a number (was a string)");
	});

	it("invoked", () => {
		const T = type.keywords.Array.liftFrom({ data: "number" });

		expect(T.expression).toBe("(In: { data: number } | { data: number }[]) => Out<{ data: number }[]>");
	});
});
