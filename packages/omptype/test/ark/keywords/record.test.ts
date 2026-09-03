import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("parsed", () => {
	const Expected = type({ "[string]": "number" });

	const Expression = type("Record<string, number>");
	expect(Expression.json).toEqual(Expected.json);
	const _0: Eq<typeof Expression.t, typeof Expected.t> = true;
});

it("invoked", () => {
	const Expected = type({ "[string]": "number" });

	const T = type.keywords.Record("string", "number");

	expect(T.json).toEqual(Expected.json);
	const _0: Eq<typeof T.t, typeof Expected.t> = true;
});

it("invoked validation error", () => {
	expect(() => type.keywords.Record("string", "string % 2")).toThrow();
});

it("invoked constraint error", () => {
	expect(() => type.keywords.Record("boolean", "number")).toThrow();
});
