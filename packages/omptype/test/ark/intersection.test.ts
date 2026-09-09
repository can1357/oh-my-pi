import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("two types", () => {
	const T = type("boolean&true");
	const _1: Eq<typeof T.infer, true> = true;
	expect(T.json).toEqual(type("true").json);
});

it("intersection parsed before union", () => {
	// Should be parsed as:
	// 1. "0" | ("1"&"string") | "2"
	// 2. "0" | "1" | "2"
	const T = type("'0'|'1'&string|'2'");
	const _2: Eq<typeof T.infer, "0" | "1" | "2"> = true;
	expect(T.json).toEqual(type("===", "0", "1", "2").json);
});

it("tuple expression", () => {
	const T = type([{ a: "string" }, "&", { b: "number" }]);
	const _3: Eq<typeof T.infer, { a: string; b: number }> = true;
	expect(T.json).toEqual(type({ a: "string", b: "number" }).json);
});

it("several types", () => {
	const T = type("unknown&boolean&false");
	const _4: Eq<typeof T.infer, false> = true;
	expect(T.json).toEqual(type("false").json);
});

it("method", () => {
	const T = type({ a: "string" }).and({ b: "boolean" });
	const _5: Eq<typeof T.infer, { a: string; b: boolean }> = true;
	expect(T.json).toEqual(type({ a: "string", b: "boolean" }).json);
});

it("chained deep intersections", () => {
	const B = type({ b: "boolean" }, "=>", o => [o.b]);
	const T = type({
		a: ["string", "=>", s => s.length],
	})
		.and({
			// unable to inline this due to:
			// https://github.com/arktypeio/arktype/issues/806
			b: B,
		})
		.and({
			b: { b: "true" },
			c: "'hello'",
		});
	const _6: Eq<
		typeof T.in.infer,
		{
			a: string;
			b: {
				b: true;
			};
			c: "hello";
		}
	> = true;

	const _7: Eq<typeof T.infer, { a: number; b: boolean[]; c: "hello" }> = true;
});

it("bad reference", () => {
	expect(() => type("boolean&tru")).toThrow();
});

it("double and", () => {
	expect(() => type("boolean&&true")).toThrow();
});

it("implicit never", () => {
	expect(() => type("string&number")).toThrow("intersection of string and number is unsatisfiable");
});

it("intersection with never", () => {
	expect(() => type("string&never")).toThrow();
});

it("left semantic error", () => {
	expect(() => type("string%2&'foo'")).toThrow();
});

it("right semantic error", () => {
	expect(() => type("'foo'&string%2")).toThrow();
});

it("chained validation error", () => {
	expect(() => type({ a: "string" }).and({ b: "what" })).toThrow();
});

it("error at path", () => {
	expect(() => type({ a: "string" }).and({ a: "number" })).toThrow(
		"intersection of string and number is unsatisfiable",
	);
});

it("never subtype comparisons", () => {
	const MyType = type({
		something: "string",
	});

	expect(type.never.extends(MyType)).toEqual(true);

	expect(MyType.extends(type.never)).toEqual(false);
});
