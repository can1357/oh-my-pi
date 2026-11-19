import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("shallow type reference", () => {
	const T = type(type("boolean"));
	const _assert1: Eq<typeof T.infer, boolean> = true;
});

it("bad shallow type reference", () => {
	expect(() => {
		type(type("foolean"));
	}).toThrow();
});

it("deep type reference", () => {
	const T = type({ a: type("boolean") });
	const _assert2: Eq<typeof T.infer, { a: boolean }> = true;
});

it("type reference in scope", () => {
	const A = type({ a: "string" });
	const $ = scope({ a: A });
	const types = $.export();
	expect(types.a.json).toEqual(A.json);
	const _assert3: Eq<typeof types.a.infer, { a: string }> = true;
});

it("bad deep type reference", () => {
	expect(() => {
		type({ a: type("goolean") });
	}).toThrow();
});
