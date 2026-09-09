import { describe, expect, it } from "bun:test";

const badFnReturnTypeMessage =
	'":" must be followed by exactly one return type e.g:\nfn("string", ":", "number")(s => s.length)';
const multipleVariadicMesage = "A tuple may have at most one variadic element";
const optionalOrDefaultableAfterVariadicMessage = "An optional element may not follow a variadic element";
const postfixAfterOptionalOrDefaultableMessage =
	"A postfix required element cannot follow an optional or defaultable element";

import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("0 params implicit return", () => {
	const f = type.fn()(() => 5);

	expect(f()).toEqual(5);

	expect(f.expression).toBe("() => unknown");
});

it("0 params explicit return", () => {
	const f = type.fn(":", "5")(() => 5);

	expect(f()).toEqual(5);

	expect(f.expression).toBe("() => 5");
});

it("1 param implicit return", () => {
	const len = type.fn("string | number[]")(s => s.length);

	expect(len.expression).toBe("(string | number[]) => unknown");

	expect(len("foo")).toEqual(3);

	// @ts-expect-error
	expect(() => len(1)).toThrow("[0] must be a string or an array (was a number)");
});

it("1 param explicit return", () => {
	const len = type.fn("string | unknown[]", ":", "number")(s => s.length);

	expect(len.expression).toBe("(string | Array) => number");
	expect(len("foo")).toEqual(3);

	// @ts-expect-error
	expect(() => len(1)).toThrow("[0] must be a string or an array (was a number)");
});

it("2 params implicit return", () => {
	const isNumericEquivalent = type.fn("string", "number")((s, n) => s === `${n}`);

	expect(isNumericEquivalent.expression).toBe("(string, number) => unknown");
	expect(isNumericEquivalent("5", 5)).toEqual(true);
});

it("2 params explicit return", () => {
	const isNumericEquivalent = type.fn("string", "number", ":", "boolean")((s, n) => s === `${n}`);

	expect(isNumericEquivalent.expression).toBe("(string, number) => boolean");
	expect(isNumericEquivalent("5", 5)).toEqual(true);
});

it("morphs", () => {
	const stringToLength = type.string.pipe(function _fnStringToLength(s) {
		return s.length;
	}, type.number);

	const f = type.fn(stringToLength, ":", stringToLength)(n => n.toFixed(2));
	expect(f.expression).toBe("((In: string) => To<number>) => (In: string) => To<number>");
});

it("nary inferred return", () => {
	const f = type.fn(
		{ a: "1" },
		{ b: "2" },
		{ c: "3" },
		{ d: "4" },
		{ e: "5" },
		{ f: "6" },
		{ g: "7" },
		{ h: "8" },
		{ i: "9" },
		{ j: "10" },
		{ k: "11" },
		{ l: "12" },
		{ m: "13" },
		{ n: "14" },
		{ o: "15" },
		{ p: "16" },
		{ q: "17" },
	)((a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q) => ({
		...a,
		...b,
		...c,
		...d,
		...e,
		...f,
		...g,
		...h,
		...i,
		...j,
		...k,
		...l,
		...m,
		...n,
		...o,
		...p,
		...q,
	}));

	expect(f.expression).toBe(
		"({ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }, { f: 6 }, { g: 7 }, { h: 8 }, { i: 9 }, { j: 10 }, { k: 11 }, { l: 12 }, { m: 13 }, { n: 14 }, { o: 15 }, { p: 16 }, { q: 17 }) => unknown",
	);
});

it("nary declared return", () => {
	const f = type.fn(
		{ a: "1" },
		{ b: "2" },
		{ c: "3" },
		{ d: "4" },
		{ e: "5" },
		{ f: "6" },
		{ g: "7" },
		{ h: "8" },
		{ i: "9" },
		{ j: "10" },
		{ k: "11" },
		{ l: "12" },
		{ m: "13" },
		{ n: "14" },
		{ o: "15" },
		":",
		{ p: "16" },
	)((a, b, c, d, e, f, g, h, i, j, k, l, m, n, o) => ({
		...a,
		...b,
		...c,
		...d,
		...e,
		...f,
		...g,
		...h,
		...i,
		...j,
		...k,
		...l,
		...m,
		...n,
		...o,
		p: 16,
	}));

	expect(f.expression).toBe(
		"({ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }, { f: 6 }, { g: 7 }, { h: 8 }, { i: 9 }, { j: 10 }, { k: 11 }, { l: 12 }, { m: 13 }, { n: 14 }, { o: 15 }) => { p: 16 }",
	);
});

it.todo("signature precedence implicit return");

it.todo("signature precedence explicit return");

it("attached params", () => {
	const len = type.fn("string | unknown[]")(s => s.length);

	const expectedParams = type(["string | unknown[]"]);

	const _params: Eq<typeof len.params, typeof expectedParams> = true;
	expect(len.params.expression).toEqual(expectedParams.expression);
});

it("inferred returns", () => {
	const len = type.fn("string | unknown[]")(s => s.length);

	const Expected = type.unknown;
	const _inferredReturns: Eq<typeof len.returns, typeof Expected> = true;
	expect(len.returns.expression).toEqual(Expected.expression);
});

it("introspectable returns", () => {
	const len = type.fn("string | unknown[]", ":", "number")(s => s.length);

	const Expected = type.number;
	const _introspectableReturns: Eq<typeof len.returns, typeof Expected> = true;
	expect(len.returns.expression).toEqual(Expected.expression);
});

it("missing return", () => {
	// the type message just ends up being some overload nonsense
	// but hopefully people will not try to do this and get confused
	// @ts-expect-error
	expect(() => type.fn("string", ":")).toThrow(badFnReturnTypeMessage);
});

it("name", () => {
	const f = type.fn("string")(function originalName() {});
	expect(f.name).toBe("bound typed originalName");
});

it("raw", () => {
	// raw has no type-level inference, so it's returned as an untyped parser
	const len = type.fn.raw("string | unknown[]")((s: string) => s.length) as (data: unknown) => number;

	expect(len("foo")).toEqual(3);
	expect(() => len(1)).toThrow("[0] must be a string or an array (was a number)");
});

it.todo("arg submodule completions");

it.todo("arg object completions");

it.todo("returns submodule completions");

it.todo("returns object completions");

describe("scoped", () => {
	it("scoped param and return", () => {
		const $ = type.scope({
			xxx: "string",
			zzz: "number",
		});

		const f = $.type.fn("xxx", ":", "zzz")(s => s.length);

		expect(f("foo")).toEqual(3);

		expect(f.expression).toBe("(string) => number");

		// @ts-expect-error
		expect(() => f(null)).toThrow("[0] must be a string (was null)");
	});

	it.todo("completions");
});

describe("tuple elements", () => {
	it("defaultable and optional", () => {
		const f = type.fn("string", "number = 5", "boolean?")((s, n, b) => `${s}${n}${b}`);

		expect(f.expression).toBe("(string, number = 5, boolean?) => unknown");
	});

	it("non-variadic array", () => {
		const join = type.fn("string[]")((...parts) => parts.join(","));

		expect(join.expression).toBe("(string[]) => unknown");
	});

	it("variadic array", () => {
		const join = type.fn("...", "string[]", ":", "string")((...parts) => parts.join(","));

		expect(join.expression).toBe("(...string[]) => string");
	});

	it("intro example", () => {
		const safe = type.fn("string", "number = 0.1")((name, version) => `${name}@${version} is safe AF.`);

		expect(safe("arktype", 2.2)).toBe("arktype@2.2 is safe AF.");
		expect(() => safe("shitescript", "*" as unknown as number)).toThrow("[1] must be a number (was a string)");
	});

	describe("errors", () => {
		it("errors on multiple variadic", () => {
			expect(() =>
				// @ts-expect-error
				type.fn("...", "string[]", "...", "number[]")(() => {}),
			).toThrow(multipleVariadicMesage);
		});

		it("error on optional post-variadic in spread", () => {
			// no type error yet, ideally would have one if tuple
			// parsing were more precise for nested spread tuples
			expect(() => type.fn("...", "string[]", "...", ["string?"])(() => {})).toThrow(
				optionalOrDefaultableAfterVariadicMessage,
			);
		});

		it("errors on postfix following optional", () => {
			expect(() =>
				// @ts-expect-error
				type.fn("number?", "...", "boolean[]", "symbol")(() => {}),
			).toThrow(postfixAfterOptionalOrDefaultableMessage);
		});

		it("errors on postfix following defaultable", () => {
			expect(() =>
				// @ts-expect-error
				type.fn("number = 0", "...", "boolean[]", "symbol")(() => {}),
			).toThrow(postfixAfterOptionalOrDefaultableMessage);
		});
	});
});
