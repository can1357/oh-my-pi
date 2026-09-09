import { expect, it } from "bun:test";
import { type Brand, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

it("fluent", () => {
	const T = type("string").brand("foo");
	const _t: Eq<typeof T.t, Brand<string, "foo">> = true;
	const _infer: Eq<typeof T.infer, Brand<string, "foo">> = true;
	const _inferIn: Eq<typeof T.inferIn, string> = true;

	expect(T.expression).toEqual("string");

	const out = T("moo");
	const _out: Eq<typeof out, Brand<string, "foo"> | type.errors> = true;
});

it("string", () => {
	const T = type("number#cool");
	const _t: Eq<typeof T.t, Brand<number, "cool">> = true;
	const _infer: Eq<typeof T.infer, Brand<number, "cool">> = true;
	const _inferIn: Eq<typeof T.inferIn, number> = true;

	expect(T.expression).toEqual("number");

	const out = T(5);
	const _out: Eq<typeof out, Brand<number, "cool"> | type.errors> = true;
});

it("in object", () => {
	const T = type({
		foo: "string#foo",
		bar: "string.json.parse#json",
	});

	const _infer: Eq<typeof T.infer, { foo: Brand<string, "foo">; bar: Brand<Json, "json"> }> = true;
	const _inferIn: Eq<typeof T.inferIn, { foo: string; bar: string }> = true;
});

it("in union", () => {
	const T = type("string#foo | boolean");
	const _infer: Eq<typeof T.infer, boolean | Brand<string, "foo">> = true;
	const _inferIn: Eq<typeof T.inferIn, boolean | string> = true;
});

it("from morph", () => {
	const Fluent = type("string.numeric.parse").brand("num");
	const _infer: Eq<typeof Fluent.infer, Brand<number, "num">> = true;
	const _inferIn: Eq<typeof Fluent.inferIn, string> = true;

	const StringType = type("string.numeric.parse#num");
	expect(StringType.json).toEqual(Fluent.json);
	const _t: Eq<typeof StringType.t, typeof Fluent.t> = true;
});

it("docs example", () => {
	const Fluent = type.number.divisibleBy(2).brand("even");
	const _t: Eq<typeof Fluent.t, Brand<number, "even">> = true;
	const _inferIn: Eq<typeof Fluent.inferIn, number> = true;
	const _infer: Eq<typeof Fluent.infer, Brand<number, "even">> = true;

	const StringType = type("(number % 2)#even");
	const _same: Eq<typeof StringType.t, typeof Fluent.t> = true;
	expect(StringType.json).toEqual(Fluent.json);
	expect(StringType(4)).toBe(4);
});
