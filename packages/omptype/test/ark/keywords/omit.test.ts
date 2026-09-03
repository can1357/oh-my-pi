import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		from: {
			foo: "1",
			"bar?": "1",
			baz: "1",
			"quux?": "1",
		},
		actual: "Omit<from, 'foo' | 'bar'>",
		expected: {
			baz: "1",
			"quux?": "1",
		},
	}).export();

	const _0: Eq<typeof types.actual.t, typeof types.expected.t> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("chained", () => {
	const User = type({
		name: "string",
		"age?": "number",
		isAdmin: "boolean",
		"isActive?": "boolean",
	});

	const extras = User.omit("name", "age");

	const Expected = type({
		isAdmin: "boolean",
		"isActive?": "boolean",
	});

	const _0: Eq<typeof extras.t, typeof Expected.t> = true;

	expect(extras.expression).toEqual(Expected.expression);
});
