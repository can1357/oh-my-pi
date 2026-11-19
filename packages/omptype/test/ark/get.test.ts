import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("can get shallow roots by path", () => {
	const T = type({
		foo: "string",
		bar: "number|bigint",
	});

	const a = T.get("bar");
	const _type1: Eq<typeof a.infer, number | bigint> = true;
	expect(a.expression).toEqual("number | bigint");
});

it("can get deep roots by path", () => {
	const T = type({
		foo: {
			baz: "1",
		},
		bar: {
			quux: "2",
		},
	});

	const a = T.get("foo", "baz");
	const _type2: Eq<typeof a.t, 1> = true;
	expect(a.expression).toEqual("1");

	const b = T.get("bar", "quux");
	const _type3: Eq<typeof b.t, 2> = true;
	expect(b.expression).toEqual("2");
});

it("can merge across a deep union", () => {
	const Base = type(
		{
			foo: {
				bar: "0",
			},
		},
		"|",
		{
			foo: {
				bar: "1",
			},
		},
	);

	const T = Base.get("foo", "bar");

	const _type4: Eq<typeof T.infer, 0 | 1> = true;
	expect(T.expression).toEqual("0 | 1");
});

it("can get index keys", () => {
	const T = type({
		"[/^f/]": "0",
		named: "1",
	});

	const a = T.get("foo");
	const _type5: Eq<typeof a.t, 0> = true;
	expect(a.expression).toEqual("0 | undefined");

	expect(() => T.get("bar")).toThrow("key bar is not declared");
});

it("named and multiple indices", () => {
	const T = type({
		"[/^f/]": {
			a: "1",
		},
		"[/f$/]": { b: "1" },
		foof: { c: "1" },
	});

	const a = T.get("foo");

	const _type6: Eq<typeof a.infer, { a: 1 }> = true;
	expect(a.expression).toEqual("{ a: 1 } | undefined");

	const b = T.get("oof");
	const _type7: Eq<typeof b.infer, { b: 1 }> = true;
	expect(b.expression).toEqual("{ b: 1 } | undefined");

	const c = T.get("fof");
	const _type8: Eq<typeof c.infer, { a: 1 } & { b: 1 }> = true;
	expect(c.expression).toEqual("{ a: 1, b: 1 } | undefined");

	const d = T.get("foof");

	const _type9: Eq<typeof d.infer, { c: 1 }> = true;
	expect(d.expression).toEqual("{ c: 1, a: 1, b: 1 }");

	expect(() => T.get("goog").expression).toThrow("key goog is not declared");
});

it("optional key adds undefined", () => {
	const T = type({
		"foo?": "null",
	});

	const a = T.get("foo");
	const _type10: Eq<typeof a.t, null | undefined> = true;
	expect(a.expression).toEqual("null | undefined");
});

it("non-fixed array", () => {
	const T = type("string[]");

	const a = T.get("0");
	const _type11: Eq<typeof a.infer, string> = true;
	expect(a.expression).toEqual("string | undefined");

	expect(() => T.get("-1")).toThrow("key -1 is not declared");
	expect(() => T.get("5.5")).toThrow("key 5.5 is not declared");

	expect(T.get(type.arrayIndex).expression).toEqual("string | undefined");
});

it("array specific-index access access on non-tuple", () => {
	const T = type({ foo: "number" }).array();

	expect(T.get(0).expression).toEqual("{ foo: number } | undefined");
});

// https://github.com/arktypeio/arktype/issues/1261
it("nested index access on non-tuple", () => {
	const Simple = type({
		id: "number",
		array: type({
			name: "string",
			age: "number",
		}).array(),
	});

	const Arr = Simple.get("array");
	const InnerArr = Arr.get(0);

	expect(InnerArr.expression).toEqual("{ name: string, age: number } | undefined");
	InnerArr.assert({ name: "Rico", age: 25 });
});

it("number access on non-tuple", () => {
	const T = type({ foo: "number" }).array();

	// Schema-valued keys are rejected with an actionable message.
	expect(() => T.get(type.number as never)).toThrow("is not allowed as an array or object index");
});

it("tuple", () => {
	const T = type(["1", "2?"]);

	// fixed
	const a = T.get(0);
	const _type12: Eq<typeof a.infer, 1> = true;
	expect(a.expression).toEqual("1");
	const b = T.get(1);
	const _type13: Eq<typeof b.infer, 2 | undefined> = true;
	expect(b.expression).toEqual("undefined | 2");

	expect(() => T.get(2)).toThrow("key 2 is not declared");
});

it("variadic tuple", () => {
	const T = type(["1", "2", "...", "3[]", "4", "5"]);

	// fixed
	const a = T.get(0);
	const _type14: Eq<typeof a.t, 1> = true;
	expect(a.expression).toEqual("1");

	const b = T.get(1);
	const _type15: Eq<typeof b.t, 2> = true;
	expect(b.expression).toEqual("2");

	// variadic
	// based on length, we could narrow this to remove undefined in the future
	expect(T.get("2").expression).toEqual("undefined | 3 | 4 | 5");
	expect(T.get("100").expression).toEqual("undefined | 3 | 4 | 5");
});

it("deep", () => {
	const T = type({
		foo: {
			"[symbol]": {
				bar: "1",
				"baz?": "2",
			},
		},
	});

	const bar = T.get("foo", type.symbol as never, "bar");
	const _type16: Eq<typeof bar.t, 1> = true;
	expect(bar.expression).toEqual("1 | undefined");

	const baz = T.get("foo", type.symbol as never, "baz");
	const _type17: Eq<typeof baz.t, 2 | undefined> = true;
	expect(baz.expression).toEqual("2 | undefined");
});
