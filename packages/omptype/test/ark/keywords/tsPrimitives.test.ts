import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("string strings", () => {
	const StringType = type("string");
	const _0: Eq<typeof StringType.infer, string> = true;
	expect(StringType("string")).toBe("string");
});

it("any", () => {
	const Any = type("unknown.any");
	expect(Any.json).toEqual(type.unknown.json);
	const _0: Eq<typeof Any.infer, any> = true;
});

it("any in expression", () => {
	const T = type("string", "&", "unknown.any");
	const _0: Eq<typeof T.infer, any> = true;
	expect(T.allows("value")).toBe(true);
	expect(T.allows(1)).toBe(false);
});

it("boolean", () => {
	const BooleanType = type("boolean");
	const _0: Eq<typeof BooleanType.infer, boolean> = true;
	expect(BooleanType.allows(true)).toBe(true);
	expect(BooleanType.allows(false)).toBe(true);
	expect(BooleanType.allows(0)).toBe(false);
});

it("never", () => {
	const Never = type("never");
	const _0: Eq<typeof Never.infer, never> = true;
	expect(Never.allows(undefined)).toBe(false);
});

it("never in union", () => {
	const T = type("string|never");
	const _0: Eq<typeof T.infer, string> = true;
	expect(T.allows("value")).toBe(true);
	expect(T.allows(null)).toBe(false);
});

it("unknown", () => {
	const Unknown = type("unknown");
	expect(Unknown.allows(undefined)).toBe(true);
	expect(Unknown.allows({})).toBe(true);
});
