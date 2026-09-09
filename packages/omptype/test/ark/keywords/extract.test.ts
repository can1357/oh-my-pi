import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const types = scope({
		from: "0 | 1",
		actual: "Extract<from, 1>",
		expected: "1",
	}).export();

	const _0: Eq<typeof types.actual.infer, typeof types.expected.infer> = true;
	expect(types.actual.expression).toEqual(types.expected.expression);
});

it("chained", () => {
	const Extracted = type("true | 0 | 'foo'").extract("boolean | number");

	const Expected = type("true | 0");

	const _1: Eq<typeof Extracted.infer, typeof Expected.infer> = true;

	expect(Extracted.expression).toEqual(Expected.expression);
});
