import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("undefined", () => {
	expect(() => type({ bad: undefined })).toThrow();
});

it("null", () => {
	expect(() => type({ bad: null })).toThrow();
});

it("boolean", () => {
	expect(() => type({ bad: true })).toThrow();
});

it("number", () => {
	expect(() => type({ bad: 5 })).toThrow();
});

it("bigint", () => {
	expect(() => type({ bad: 99999n })).toThrow();
});

it("symbol", () => {
	expect(() => type({ bad: Symbol() })).toThrow();
});

it("any", () => {
	type Any = typeof type.any.infer;
	const T = type({ bad: {} as Any });
	const _any: Eq<typeof T.infer, { bad: Any }> = true;
});

it("never", () => {
	const T = type({ bad: {} as never });
	const _never: Eq<typeof T.infer, { bad: never }> = true;
});
