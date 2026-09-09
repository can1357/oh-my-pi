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
		actual: "Pick<from, 'foo' | 'bar'>",
		expected: {
			foo: "1",
			"bar?": "1",
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
	});

	const BasicUser = User.pick("name", "age");

	const Expected = type({
		name: "string",
		"age?": "number",
	});

	const _0: Eq<typeof Expected.t, typeof BasicUser.t> = true;

	expect(BasicUser.expression).toEqual(Expected.expression);
});

it("invalid key", () => {
	const User = type({
		name: "string",
	});

	expect(() => User.pick("length")).toThrow();
});

it("non-structure", () => {
	expect(() => type("string").pick("length")).toThrow();
});
