import { expect, it } from "bun:test";
import { TraversalError, type Type, type } from "@oh-my-pi/omptype/ark";

import assert = require("node:assert/strict");

import type { Eq } from "./type-assert";

it("root discriminates", () => {
	const T = type("string");
	const out = T("");
	if (out instanceof type.errors) out.throw();
	else expect<string>(out);
});

it("allows", () => {
	const T = type("number%2");
	const data: unknown = 4;
	if (T.allows(data)) {
		// narrows correctly
		expect<number>(data);
	} else throw new Error();

	expect(T.allows(5)).toEqual(false);
});

it("allows doc example", () => {
	const Numeric = type("number | bigint");
	const numerics = [0, "one", 2n].filter(Numeric.allows);
	expect(numerics).toEqual([0, 2n]);
});

it("extends doc example", () => {
	const N = type("boolean | string");
	expect(N.expression).toEqual("boolean | string");
	expect(N.ifExtends("boolean")).toBeUndefined();
});

it("errors can be thrown", () => {
	const T = type("number");
	try {
		const result = T("invalid");
		if (result instanceof type.errors) result.throw();
	} catch (e) {
		expect(e).toBeInstanceOf(TraversalError);
		expect((e as TraversalError).arkErrors instanceof type.errors);
		return;
	}
	throw new assert.AssertionError({ message: "Expected to throw" });
});

it("assert", () => {
	const T = type({ a: "string" });
	expect(T.assert({ a: "1" })).toEqual({ a: "1" });
	expect(() => T.assert({ a: 1 })).toThrow("a must be a string (was a number)");
});

it("distribute", () => {
	const T = type("===", 0, "1", "2", 3, "4", 5);

	const numbers = T.distribute(
		n => n.ifExtends(type.number) ?? type.raw(n.expression.slice(1, -1)).as<number>(),
		branches => type.raw(branches).as<number[]>(),
	);

	expect(numbers.expression).toEqual("[0, 1, 2, 3, 4, 5]");
});

it("ark attached", () => {
	expect<string>(type.keywords.number.integer.expression).toEqual("number % 1");
});

it("unit", () => {
	const T = type.unit(5);
	const _unitInference: Eq<typeof T.infer, 5> = true;
	expect(T.expression).toEqual("5");
});

it("enumerated", () => {
	const T = type.enumerated(5, true, null);
	const _enumeratedInference: Eq<typeof T.infer, 5 | true | null> = true;
	expect(T.expression).toEqual("5 | true | null");
});

it("ifEquals", () => {
	const T = type("string");
	expect(T.ifEquals("string")).toEqual(T);
	// subtype
	expect(T.ifEquals("'foo'")).toEqual(undefined);
	// supertype
	expect(T.ifEquals("string | number")).toEqual(undefined);
});

it("ifExtends", () => {
	const T = type("string");
	expect<type<string> | undefined>(T.ifExtends("string")).toEqual(T);
	// subtype
	expect<type<"foo"> | undefined>(T.ifExtends("'foo'")).toEqual(undefined);
	// supertype
	expect<type<string | number> | undefined>(T.ifExtends("string | number")).toEqual(T);
});

it("allows assignment to unparameterized Type", () => {
	const T = type({
		name: "string >= 2",
		email: "string.email",
	});

	T satisfies Type;
});

it("allows morph assignment to unparameterized Type", () => {
	const T = type("string").pipe(s => s.length);

	T satisfies Type;
});

it("assert callable as standalone function", () => {
	const { assert } = type("string");

	expect<(data: unknown) => string>(assert);
	expect(assert("foo")).toEqual("foo");
	expect(() => assert(5)).toThrow("must be a string (was a number)");
});

it("valueOf", () => {
	//    🪦R.I.P. TS enums🪦
	//         2012-2025
	// Killed by --erasableSyntaxOnly

	// enum TsEnum {
	// 	numeric = 1,
	// 	symmetrical = "symmetrical",
	// 	asymmetrical = "lacirtemmysa"
	// }

	const EquivalentObject = {
		numeric: 1,
		symmetrical: "symmetrical",
		asymmetrical: "lacirtemmysa",
	} as const;

	// TS reverse assigns numeric values
	// need to make sure we don't extract them at runtime

	// Object.assign avoids TS inferring this key (it wouldn't for an enum)
	Object.assign(EquivalentObject, {
		"1": "numeric",
	});

	const T = type.valueOf(EquivalentObject);

	const Expected = type.enumerated(1, "symmetrical", "lacirtemmysa");

	expect<typeof Expected>(T);
	expect(T.expression).toEqual(Expected.expression);
});

it("toJsonSchema docs", () => {
	const User = type({
		name: "string",
		email: "string.email",
		"age?": "number >= 18",
	});

	const schema = User.toJsonSchema({ target: "draft-2020-12" });

	const expected: JsonSchema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: {
			name: { type: "string" },
			email: {
				type: "string",
				format: "email",
				pattern: "^[\\w%+.-]+@[\\d.A-Za-z-]+\\.[A-Za-z]{2,}$",
			},
			age: { type: "number", minimum: 18 },
		},
		required: ["name", "email"],
	};

	expect(schema).toEqual(expected);
});
