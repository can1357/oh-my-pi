import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		user: {
			name: "string",
			"age?": "number",
		},
		actual: "Required<user>",
		expected: {
			name: "string",
			age: "number",
		},
	}).export();

	const _0: Eq<typeof types.actual.infer, typeof types.expected.infer> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("chained", () => {
	const T = type({
		"[string]": "number",
		foo: "1",
		"bar?": "1",
	}).required();

	const _1: Eq<
		typeof T.infer,
		{
			[x: string]: number;
			foo: 1;
			bar: 1;
		}
	> = true;

	expect(T.expression).toEqual("{ [string]: number, foo: 1, bar: 1 }");
});

// https://github.com/arktypeio/arktype/issues/1156
it("with default", () => {
	const T = type({ foo: "string = 'bar'" }).required();

	const Expected = type({
		foo: "string",
	});

	// https://github.com/arktypeio/arktype/issues/1160

	expect(T.expression).toEqual(Expected.expression);
});
