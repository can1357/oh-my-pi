import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("binary", () => {
	const Binary = type("number|string");
	const _1: Eq<typeof Binary.infer, number | string> = true;
	expect(Binary.json).toEqual(["number", "string"]);
});

it("nary", () => {
	const Nary = type("false|null|undefined|0|''");
	const _2: Eq<typeof Nary.infer, false | "" | 0 | null | undefined> = true;
	const Expected = type("===", false, null, undefined, 0, "");
	expect(Nary.json).toEqual(Expected.json);
});

it("subtype pruning", () => {
	const T = type({ a: "string" }, "|", { a: "'foo'" });
	const Expected = type({ a: "string" });
	const _3: Eq<typeof T, typeof Expected> = true;
	expect(T.json).toEqual(Expected.json);
});

it("multiple subtypes pruned", () => {
	const T = type("'foo'|'bar'|string|'baz'|/.*/");
	const Expected = type("string");
	const _4: Eq<typeof T.infer, string> = true;
	expect(T.json).toEqual(Expected.json);
});

it("boolean is a union of true | false", () => {
	const T = type("true|false");

	expect(T.json).toEqual(type("boolean").json);
});

it("nested tuple union", () => {
	const T = type(["string|bigint", "|", ["number", "|", "boolean"]]);
	const _5: Eq<typeof T.infer, string | number | bigint | boolean> = true;
	expect(T.json).toEqual(type("string|bigint|number|boolean").json);
});

it("length stress", () => {
	// as of TS 5.1, can handle a max of 46 branches before an inifinitely
	// deep error not the end of the world if this changes slightly, but
	// wanted to make those changes explicit if something reduces it it's
	// also still very responsive up until it hits the limit, so it is
	// likely a safeguard rather than a limitation of the parser
	const T = type(
		"0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45",
	);
	// prettier-ignore
	const _6: Eq<
		typeof T.infer,
		| 0
		| 1
		| 2
		| 3
		| 4
		| 5
		| 6
		| 7
		| 8
		| 9
		| 10
		| 11
		| 12
		| 13
		| 14
		| 15
		| 16
		| 17
		| 18
		| 19
		| 20
		| 21
		| 22
		| 23
		| 24
		| 25
		| 26
		| 27
		| 28
		| 29
		| 30
		| 31
		| 32
		| 33
		| 34
		| 35
		| 36
		| 37
		| 38
		| 39
		| 40
		| 41
		| 42
		| 43
		| 44
		| 45
	> = true;

	expect(T.json).toEqual([
		{ unit: 0 },
		{ unit: 1 },
		{ unit: 2 },
		{ unit: 3 },
		{ unit: 4 },
		{ unit: 5 },
		{ unit: 6 },
		{ unit: 7 },
		{ unit: 8 },
		{ unit: 9 },
		{ unit: 10 },
		{ unit: 11 },
		{ unit: 12 },
		{ unit: 13 },
		{ unit: 14 },
		{ unit: 15 },
		{ unit: 16 },
		{ unit: 17 },
		{ unit: 18 },
		{ unit: 19 },
		{ unit: 20 },
		{ unit: 21 },
		{ unit: 22 },
		{ unit: 23 },
		{ unit: 24 },
		{ unit: 25 },
		{ unit: 26 },
		{ unit: 27 },
		{ unit: 28 },
		{ unit: 29 },
		{ unit: 30 },
		{ unit: 31 },
		{ unit: 32 },
		{ unit: 33 },
		{ unit: 34 },
		{ unit: 35 },
		{ unit: 36 },
		{ unit: 37 },
		{ unit: 38 },
		{ unit: 39 },
		{ unit: 40 },
		{ unit: 41 },
		{ unit: 42 },
		{ unit: 43 },
		{ unit: 44 },
		{ unit: 45 },
	]);
});

it("tuple", () => {
	const T = type([{ a: "string" }, "|", { b: "number" }]);
	const _7: Eq<typeof T.infer, { a: string } | { b: number }> = true;
	expect(T.allows({ a: "ok" })).toBe(true);
	expect(T.allows({ b: 1 })).toBe(true);
	expect(T.allows({ a: 1 })).toBe(false);
});

it("root", () => {
	const T = type({ a: "string" }, "|", { b: "number" });
	const _8: Eq<typeof T.infer, { a: string } | { b: number }> = true;
	expect(T.allows({ a: "ok" })).toBe(true);
	expect(T.allows({ b: 1 })).toBe(true);
	expect(T.allows({ b: "bad" })).toBe(false);
});

it("chained", () => {
	const T = type({ a: "string" }).or({ b: "number" });
	const _9: Eq<
		typeof T.infer,
		| {
				a: string;
		  }
		| {
				b: number;
		  }
	> = true;
	expect(T.allows({ a: "ok" })).toBe(true);
	expect(T.allows({ b: 1 })).toBe(true);
	expect(T.allows({ a: 1, b: "bad" })).toBe(false);
});

it.todo("root autocompletion");

it("bad reference", () => {
	expect(() => type("number|strng")).toThrow();
});

it("consecutive tokens", () => {
	expect(() => type("boolean||null")).toThrow();
});

it("ends with |", () => {
	expect(() => type("boolean|")).toThrow();
});

it("long missing union member", () => {
	expect(() => type("boolean[]|(string|number|)|object")).toThrow();
});

it("left semantic error", () => {
	expect(() => type("symbol%2|string")).toThrow();
});

it("right semantic error", () => {
	expect(() => type("string|symbol%2")).toThrow();
});

it("chained bad reference", () => {
	expect(() => type("string").or("nummer")).toThrow();
});

it("chained description", () => {
	const T = type("number|string").describe("My custom type");
	expect(T.description).toBe("My custom type");
	expect(T.toJsonSchema().description).toBe("My custom type");
	expect(T.allows(1)).toBe(true);
	expect(T.allows("one")).toBe(true);
});
