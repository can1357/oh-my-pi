import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		user: {
			name: "string",
			"age?": "number",
		},
		actual: "Partial<user>",
		expected: {
			"name?": "string",
			"age?": "number",
		},
	}).export();

	const _0: Eq<typeof types.actual.t, typeof types.expected.t> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("chained", () => {
	const T = type({
		"[string]": "number",
		foo: "1",
		"bar?": "1",
	}).partial();

	const _0: Eq<typeof T.t, { [x: string]: number | undefined; foo?: 1; bar?: 1 }> = true;

	expect(T.expression).toEqual("{ [string]: number, foo?: 1, bar?: 1 }");
});
