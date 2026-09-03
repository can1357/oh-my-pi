import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		from: "0 | 1",
		actual: "Exclude<from, 1>",
		expected: "0",
	}).export();

	const _0: Eq<typeof types.actual.t, typeof types.expected.t> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("chained", () => {
	const Excluded = type("true | 0 | 'foo'").exclude("string");

	const Expected = type("true | 0");

	const _0: Eq<typeof Excluded.t, typeof Expected.t> = true;

	expect(Excluded.expression).toEqual(Expected.expression);
});
