import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		base: {
			"foo?": "0",
			"bar?": "0",
		},
		merged: {
			bar: "1",
			"baz?": "1",
		},
		actual: "Merge<base, merged>",
		expected: {
			"foo?": "0",
			bar: "1",
			"baz?": "1",
		},
	}).export();

	const _0: Eq<typeof types.actual.t, typeof types.expected.t> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("invoked", () => {
	const s = Symbol();
	const T = type.keywords.Merge(
		{
			"[string]": "number | bigint",
			foo: "0",
			[s]: "true",
		},
		{
			"[string]": "bigint",
			"foo?": "1n",
		},
	);

	const Expected = type({
		"[string]": "bigint",
		"foo?": "1n",
		[s]: "true",
	});

	const _0: Eq<typeof T.t, typeof Expected.t> = true;
	expect(T.expression).toEqual(Expected.expression);
});

it("chained", () => {
	const T = type({
		"[string]": "number",
		"bar?": "0",
		foo: "0",
	}).merge({
		"foo?": "1",
		baz: "1",
	});

	const Expected = type({
		"[string]": "number",
		"bar?": "0",
		"foo?": "1",
		baz: "1",
	});

	const _0: Eq<typeof T.t, typeof Expected.t> = true;
	expect(T.expression).toEqual(Expected.expression);
});

it("non-object operand", () => {
	expect(() =>
		type({
			foo: "0",
			// @ts-expect-error -- invalid operand
		}).merge("string" as never),
	).toThrow("merge requires an object schema");
});
