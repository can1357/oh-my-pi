import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it.todo("autocompletion");

it("root expression", () => {
	const T = type("keyof", { foo: "string" });
	const _1: Eq<typeof T.t, "foo"> = true;
	const Expected = type("===", "foo");
	expect(T.expression).toEqual(Expected.expression);
});

it("object literal", () => {
	const T = type({ a: "123", b: "123" }).keyof();
	const _2: Eq<typeof T.infer, "a" | "b"> = true;
	expect(T.json).toEqual(type("'a'|'b'").json);
});

it("overlapping union", () => {
	const T = type({ a: "number", b: "boolean" }).or({ b: "number", c: "string" }).keyof();
	const _3: Eq<typeof T.infer, "b"> = true;
	expect(T.json).toEqual(type("'b'").json);
});

it("non-overlapping union", () => {
	expect(() => type({ a: "number" }).or({ b: "number" }).keyof()).toThrow();
});

it("tuple expression", () => {
	const T = type(["keyof", { a: "string" }]);
	const _4: Eq<typeof T.infer, "a"> = true;
	expect(T.json).toEqual(type("'a'").json);
});

it("keyof non-object in union", () => {
	expect(() => type({ a: "number" }).or("bigint").keyof()).toThrow();
});

it("non-object", () => {
	expect(() => type("keyof undefined")).toThrow();
});

it("missing operand", () => {
	expect(() => type("keyof ")).toThrow();
	// it tries to autocomplete, so this is just a possible completion that would be included;
});

it("invalid operand", () => {
	expect(() => type("keyof nope")).toThrow();
});

describe("scoped", () => {
	const $ = scope({
		ab: {
			a: "1",
			"b?": "1",
		},
		bc: {
			b: "1",
			"c?": "1",
		},
	});
	it("multiple keyofs", () => {
		expect(() => $.type("keyof keyof ab")).toThrow("keyof operand must be an object");
	});

	it("groupable", () => {
		const T = $.type("(keyof ab & string)[]");
		const _5: Eq<typeof T.t, ("a" | "b")[]> = true;
		expect(T.json).toEqual(type("===", "a", "b").array().json);
	});

	it("intersection precedence", () => {
		const T = $.type("keyof bc & string");
		const _6: Eq<typeof T.t, "b" | "c"> = true;
		expect(T.json).toEqual(type("===", "b", "c").json);
	});

	it("union precedence", () => {
		const T = $.type("keyof ab | bc");
		const _7: Eq<typeof T.t, "a" | "b" | { b: 1; c?: 1 }> = true;
		expect(T.expression).toEqual('"a" | "b" | { b: 1, c?: 1 }');
	});
});
