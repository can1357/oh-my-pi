import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("can parse an undeclared restriction", () => {
	const T = type({ "+": "reject" });
	const _type1: Eq<typeof T.infer, {}> = true;
	expect(T({ extra: true }).toString()).toBe("extra must be removed");
});

it("fails on type definition for undeclared", () => {
	// @ts-expect-error
	expect(() => type({ "+": "string" })).toThrow("string");
});

it("can escape undeclared meta key", () => {
	const T = type({ "\\+": "string" });
	const _type4: Eq<typeof T.infer, { "+": string }> = true;
	expect(T({ "+": "ok" })).toEqual({ "+": "ok" });
});

describe("traversal", () => {
	const getExtraneousB = () => ({ a: "ok", b: "why?" });

	it("loose by default", () => {
		const T = type({
			a: "string",
		});

		const dataWithExtraneousB = getExtraneousB();
		expect(T(dataWithExtraneousB)).toEqual(dataWithExtraneousB);
	});

	it("delete keys", () => {
		const T = type({
			a: "string",
		}).onUndeclaredKey("delete");
		expect(T({ a: "ok" })).toEqual({ a: "ok" });
		expect(T(getExtraneousB())).toEqual({ a: "ok" });
	});

	it("applies shallowly", () => {
		const T = type({
			a: "string",
			nested: {
				a: "string",
			},
		}).onUndeclaredKey("delete");

		expect(
			T({
				...getExtraneousB(),
				nested: getExtraneousB(),
			}),
		).toEqual({ a: "ok", nested: { a: "ok", b: "why?" } as never });
	});

	it("can apply deeply", () => {
		const T = type({
			a: "string",
			nested: {
				a: "string",
			},
		}).onDeepUndeclaredKey("delete");

		expect(
			T({
				...getExtraneousB(),
				nested: getExtraneousB(),
			}),
		).toEqual({ a: "ok", nested: { a: "ok" } });
	});

	it("delete union key", () => {
		const O = type([{ a: "string" }, "|", { a: "boolean", b: "true" }]).onUndeclaredKey("delete");
		// can distill to first branch
		expect(O({ a: "to", z: "bra" })).toEqual({ a: "to" });
		// can distill to second branch
		expect(O({ a: true, b: true, c: false })).toEqual({ a: true, b: true });
		// can handle missing keys
		expect(O({ a: true }).toString()).toBe("a must be a string (was true) or b must be true (was missing)");
	});

	it("fails on delete indiscriminable union key", () => {
		expect(() => type([{ a: "string" }, "|", { b: "boolean" }]).onUndeclaredKey("delete"))
			.toThrow(`ParseError: An unordered union of a type including a morph and a type with overlapping input is indeterminate:
Left: { a: string, + (undeclared): delete }
Right: { b: boolean, + (undeclared): delete }`);
	});

	it("reject key", () => {
		const T = type({
			a: "string",
		}).onUndeclaredKey("reject");
		expect(T({ a: "ok" })).toEqual({ a: "ok" });
		expect(T(getExtraneousB()).toString()).toBe("b must be removed");
	});

	it("reject array key", () => {
		const O = type({ "+": "reject", a: "string[]" });
		expect(O({ a: ["shawn"] })).toEqual({ a: ["shawn"] });
		expect(O({ a: [2] }).toString()).toBe("a[0] must be a string (was a number)");
		expect(O({ b: ["shawn"] }).toString()).toBe(`a must be an array (was missing)
b must be removed`);
	});

	it("reject key from union", () => {
		const O = type([{ a: "string" }, "|", { b: "boolean" }]).onUndeclaredKey("reject");
		expect(O({ a: 2, b: true }).toString()).toBe("a must be a string or removed (was 2)");
	});
});
