import { describe, expect, it } from "bun:test";
import { match, scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("single object", () => {
	const sizeOf = type.match({
		"string|Array": v => v.length,
		number: v => v,
		bigint: v => v,
		default: "assert",
	});

	expect(sizeOf("abc")).toEqual(3);
	expect(sizeOf([1, 2, 3])).toEqual(3);
	expect(sizeOf(5n)).toEqual(5n);

	const getBad = () => sizeOf(true);
	expect(getBad).toThrow("must be a string, an array, a number or a bigint (was boolean)");
});

it("properly infers types of inputs/outputs based on chained", () => {
	const matcher = match({ string: s => s, number: n => n })
		.case("boolean", b => b)
		.default("assert");

	// properly infers the type of the output based on the input
	const _attestActual78 = matcher("abc");
	const _attestType78: Eq<typeof _attestActual78, string> = true;
	expect(_attestActual78).toEqual("abc");

	const _attestActual77 = matcher(4);
	const _attestType77: Eq<typeof _attestActual77, number> = true;
	expect(_attestActual77).toEqual(4);

	const _attestActual76 = matcher(true);
	const _attestType76: Eq<typeof _attestActual76, boolean> = true;
	expect(_attestActual76).toEqual(true);

	// and properly handles unions in the input type
	const _attestActual75 = matcher(0 as string | number);
	const _attestType75: Eq<typeof _attestActual75, string | number> = true;

	const getBad = () => matcher(null);
	const _attestActual74 = getBad;
	const _attestType74: Eq<typeof _attestActual74, () => never> = true;

	// this sucks and should be improved- result of discrimination
	expect(getBad).toThrow(/must be (?=[^(]*boolean)(?=[^(]*number)(?=[^(]*string).*\(was null\)/);
});

it("multiple case blocks", () => {
	const m = match({
		"1": n => n,
		"2": n => n + 2,
	}).match({
		"3": n => n + 3,
		default: "assert",
	});
	const _attestActual72 = m(1);
	const _attestType72: Eq<typeof _attestActual72, 1> = true;
	expect(_attestActual72).toEqual(1);

	const _attestActual71 = m(2);
	const _attestType71: Eq<typeof _attestActual71, number> = true;
	expect(_attestActual71).toEqual(4);

	const _attestActual70 = m(3);
	const _attestType70: Eq<typeof _attestActual70, number> = true;
	expect(_attestActual70).toEqual(6);
});

it("default value", () => {
	const m = type.match({
		string: s => s.length,
		default: v => v,
	});

	expect(m("foo")).toEqual(3);
	expect(m(5)).toEqual(5);
});

it("never", () => {
	const m = type.match({
		string: s => s.length,
		default: "never",
	});

	expect(m("foo")).toEqual(3);
});

it("within scope", () => {
	const threeSixtyNoScope = scope({ three: "3", sixty: "60", no: "'no'" });

	let threeCount = 0;
	let sixtyCount = 0;

	const matcher = threeSixtyNoScope
		.match({
			three: three => {
				threeCount++;
				const _attestActual68 = three;
				const _attestType68: Eq<typeof _attestActual68, 3> = true;

				return 3;
			},
		})
		.case("sixty", sixty => {
			sixtyCount++;
			const _attestActual67 = sixty;
			const _attestType67: Eq<typeof _attestActual67, 60> = true;

			return 60;
		})
		.default("assert");

	// for assertions
	matcher(3);
	matcher(60);
	expect(threeCount).toEqual(1);

	expect(sixtyCount).toEqual(1);
});

it.todo("properly propagates errors from invalid type definitions in `when`");

it.todo("properly propagates errors from invalid type definitions in `cases`");

it("semantic error in case", () => {
	expect(() =>
		match({
			// @ts-expect-error
			"boolean < 5": () => true,
		}),
	).toThrow();
});

it("does not accept invalid inputs at a type-level", () => {
	const matcher = match
		.in<string | number>()
		.case("string", s => s)
		.case("number", n => n)
		.default("never");

	// @ts-expect-error
	expect(() => matcher(true)).toThrow("must be a string or a number (was boolean)");
});

it("from exhaustive", () => {
	const matcher = match
		.in("string | number")
		.match({
			string: s => s,
			number: n => n,
		})
		.default("assert");

	// @ts-expect-error
	expect(() => matcher(true)).toThrow("must be a string or a number (was boolean)");
});

it.todo("argless `in` type error");

it("allows ordered overlapping", () => {
	const m = match({
		"0 < number < 10": function _matchOverlapping1(n) {
			return [0, n];
		},
		// this will never be hit since it is a subtype of a previous case
		"number > 0": function _matchOverlapping2(n) {
			return [1, n];
		},
		number: function _matchOverlapping3(n) {
			return [2, n];
		},
		default: function _matchOverlapping4(v) {
			return [3, v];
		},
	});

	expect(m(5)).toEqual([0, 5]);

	expect(m(11)).toEqual([1, 11]);

	expect(m(0)).toEqual([2, 0]);

	expect(m(undefined)).toEqual([3, undefined]);
});

it("prunes subtype cases", () => {
	const m = match({
		"0 < number < 10": function _matchPreservedOne(n) {
			return [0, n];
		},
		// this will never be hit since it is a subtype of a previous case
		"4 < number < 6": function _matchPrunedOne(n) {
			return [1, n];
		},
		number: function _matchPreservedTwo(n) {
			return [2, n];
		},
		default: function _matchPreservedDefault(v) {
			return [3, v];
		},
	});
	expect(m(5)).toEqual([0, 5]);
	expect(m(11)).toEqual([2, 11]);
	expect(m(null)).toEqual([3, null]);
});

describe("at", () => {
	it("unknown allows any key", () => {
		const m = match.at("n").match({
			"0": o => `${o.n} = 0` as const,
			"1": o => `${o.n} = 1` as const,
			default: "never",
		});
		const _attestActual51 = m({ n: 0 });
		const _attestType51: Eq<typeof _attestActual51, "0 = 0"> = true;
		expect(_attestActual51).toEqual("0 = 0");

		const _attestActual50 = m({ n: 1 });
		const _attestType50: Eq<typeof _attestActual50, "1 = 1"> = true;
		expect(_attestActual50).toEqual("1 = 1");

		// @ts-expect-error
		expect(() => m({})).toThrow("n must be 0 or 1 (was missing)");
	});

	it("in", () => {
		const m = match
			.in<{ kind: string }>()
			.at("kind")
			.case("'a'", o => {
				const _attestActual48 = o;
				const _attestType48: Eq<
					typeof _attestActual48,
					{
						kind: "a";
					}
				> = true;
				expect(_attestActual48).toEqual({ kind: "a" });

				return [o.kind];
			})
			.default(o => o.kind);
		expect(m({ kind: "a" })).toEqual(["a"]);

		expect(m({ kind: "b" })).toEqual("b");

		// @ts-expect-error
	});

	it("keyless in", () => {
		const m = match
			.in<object>()
			.at("foo")
			.match({
				true: t => t,
				default: "assert",
			});
		expect(m({ foo: true, extra: 1 })).toEqual({ foo: true, extra: 1 });
	});

	it("at with cases param", () => {
		const m = match.at("foo", {
			string: function _atCasesParam1(o) {
				return o.foo.length;
			},
			number: function _atCasesParam2(o) {
				return `${o.foo + 1}`;
			},
			default: "never",
		});
		expect(m({ foo: "abc" })).toEqual(3);
		expect(m({ foo: 1 })).toEqual("2");
	});

	it("at after in", () => {
		const m = match
			.in<{ id: 0 | 1 | 2 }>()
			.at("id")
			.match({
				"0": function _atAfterIn1(o) {
					return o.id;
				},
				// correctly inferred
				number: function _atAfterIn2(o) {
					return o.id;
				},
				default: "never",
			});
		expect(m({ id: 0 })).toEqual(0);
		expect(m({ id: 2 })).toEqual(2);
	});

	it("multiple ats", () => {
		expect(() => {
			match
				.at("foo", {
					string: o => o.foo.length,
				})
				// @ts-expect-error
				.at("bar");
		}).toThrow();
	});
});

it("attached to type", () => {
	const _attestActual37 = type.match;
	const _attestType37: Eq<typeof _attestActual37, typeof match> = true;
	expect(_attestActual37).toEqual(match);
});

it("initial case", () => {
	const Initial = match.case("string", Number.parseInt).default("assert");

	const Expected = match({
		string: Number.parseInt,
		default: "assert",
	});

	expect(Initial("42")).toEqual(42);
	expect(Expected("42")).toEqual(42);
});

it("reference in object", () => {
	const m = match({
		string: s => s.length,
		default: "assert",
	});

	const T = type({
		foo: m,
	});
	const _attestActual31 = T.t;
	const _attestType31: Eq<
		typeof _attestActual31,
		{
			foo: (In: string) => Out<number>;
		}
	> = true;

	expect(T({ foo: "foo" })).toEqual({ foo: 3 });

	expect(T({ foo: 5 }).toString()).toEqual("foo must be a string (was a number)");
});

it("morph key", () => {
	const parseNum = type.match({
		"string.numeric.parse": function _matchMorphKey1(valid) {
			return valid;
		},
		default: function _matchMorphKey2() {
			return null;
		},
	});

	expect(parseNum("12.34")).toEqual(12.34);
	expect(parseNum(12.34)).toEqual(null);
});

it("fluent morph", () => {
	const parseIntMatch = match
		.case("string.integer.parse", function _matchFluentMorph1(valid) {
			return valid;
		})
		.default(function _matchFluentMorph2() {
			return null;
		});
	const _attestActual27 = parseIntMatch("1234", 10);
	const _attestType27: Eq<typeof _attestActual27, number | null> = true;
	expect(_attestActual27).toEqual(1234);

	const _attestActual26 = parseIntMatch(1234, 10);
	const _attestType26: Eq<typeof _attestActual26, null> = true;
	expect(_attestActual26).toEqual(null);
});

it("accounts for ordering during discrimination", () => {
	const m = match
		.case(
			{
				id: "string",
			},
			function _matchOrderedDiscrimination1(o) {
				return o.id;
			},
		)
		.case(
			{
				kind: "'string'",
			},
			function _matchOrderedDiscrimination2(o) {
				return o.kind;
			},
		)
		.case(
			{
				kind: "'number'",
			},
			function _matchOrderedDiscrimination3(o) {
				return o.kind;
			},
		)
		.case(
			{
				id: "number",
			},
			function _matchOrderedDiscrimination4(o) {
				return o.id;
			},
		)
		.default("assert");
	expect(m({ id: "id", kind: "string" })).toEqual("id");
	expect(m({ id: 5, kind: "string" })).toEqual("string");
	expect(m({ id: 5, kind: "number" })).toEqual("number");
	expect(m({ id: 5, kind: "other" })).toEqual(5);
});

it("allows number keys", () => {
	const numeric = match({
		0: function numericZeroCase(n) {
			return `${n}` as const;
		},
		1: function numericOneCase(n) {
			return `${n}` as const;
		},
		default: "assert",
	});

	expect(numeric(0)).toEqual("0");
	expect(numeric(1)).toEqual("1");
	expect(() => numeric(2)).toThrow("must be 0 or 1");
});

it("union inputs", () => {
	const stringifyResponse = type.match({
		"true | 1": n => `${n}`,
		"false | 0": n => `${n}`,
		default: "assert",
	});

	expect(stringifyResponse(true)).toBe("true");
	expect(stringifyResponse(false)).toBe("false");
	expect(stringifyResponse(1)).toBe("1");
	expect(stringifyResponse(0)).toBe("0");
});

it("discriminated", () => {
	type Data =
		| {
				id: 1;
				oneValue: number;
		  }
		| {
				id: 2;
				twoValue: string;
		  };

	const discriminateValue = match
		.in<Data>()
		.at("id")
		.match({
			1: o => `${o.oneValue}!`,
			2: o => o.twoValue.length,
			default: "assert",
		});

	const a = discriminateValue({ id: 1, oneValue: 1 });
	expect(a).toEqual("1!");

	const b = discriminateValue({ id: 2, twoValue: "two" });
	expect(b).toEqual(3);

	// @ts-expect-error
	expect(() => discriminateValue({ oneValue: 3 })).toThrow("id must be 1 or 2 (was missing)");
});

it("default ArkErrors", () => {
	const m = type.match({
		string: s => s.length,
		number: n => n,
		default: "reject",
	});

	expect(m("foo")).toEqual(3);
	expect(m(3)).toEqual(3);
	expect(m(null).summary).toBe("must be a string or a number (was null)");
});

it("docs example 2", () => {
	const sizeOf = match({
		string: v => v.length,
		number: v => v,
		bigint: v => v,
		// match any object with a length property
	})
		.case({ length: "number" }, o => o.length)
		.default("assert");
	expect(sizeOf("abc")).toEqual(3);

	expect(sizeOf({ name: "David", length: 5 })).toEqual(5);

	expect(() => sizeOf(null)).toThrow("must be a string, a number, a bigint or an object (was null)");
});

it("validates in", () => {
	const exclaimFoo = match.in({ foo: "string" }).at("foo", {
		default: o => `${o.foo}!` as const,
	});

	const out = exclaimFoo({ foo: "foo" });

	// ensure ArkErrors is added as a possible outcome
	// since input is validated without assertion
	const _attestActual13 = out;
	const _attestType13: Eq<typeof _attestActual13, ArkErrors | `${string}!`> = true;
	expect(_attestActual13).toEqual("foo!");

	// @ts-expect-error
	const invalid = exclaimFoo({ foo: 5 });
	expect(invalid).toBeInstanceOf(type.errors);
	expect(invalid.summary).toEqual("foo must be a string (was a number)");
});

it("asserts in", () => {
	const fooToLength = match.in({ foo: "string" }).at("foo", {
		"string > 0": o => o.foo.length,
		default: "assert",
	});

	const out = fooToLength({ foo: "foo" });

	// ensure ArkErrors is not added to output
	// since result is asserted
	const _attestActual10 = out;
	const _attestType10: Eq<typeof _attestActual10, number> = true;
	expect(_attestActual10).toEqual(3);

	// @ts-expect-error
	expect(() => fooToLength({ foo: 5 })).toThrow("foo must be a string (was a number)");
});

it("string matcher no in", () => {
	const discriminate = match.at("kind").strings({
		a: o => o.kind,
		b: o => o.kind,
		c: o => o.kind,
		default: "assert",
	});

	const a = discriminate({ kind: "a", value: "a" });
	const b = discriminate({ kind: "b", value: "b" });
	const c = discriminate({ kind: "c", value: "c" });
	const _attestActual7 = [a, b, c];
	const _attestType7: Eq<typeof _attestActual7, ["a", "b", "c"]> = true;
	expect(_attestActual7).toEqual(["a", "b", "c"]);
});

type Discriminated =
	| {
			kind: "a";
			value: "a";
	  }
	| {
			kind: "b";
			value: "b";
	  }
	| {
			kind: "c";
			value: "c";
	  };

it("string literal matcher", () => {
	const discriminate = match
		.in<Discriminated>()
		.at("kind")
		.strings({
			a: o => o.value,
			b: o => o.value,
			c: o => o.value,
			default: "assert",
		});

	const a = discriminate({ kind: "a", value: "a" });
	const b = discriminate({ kind: "b", value: "b" });
	const c = discriminate({ kind: "c", value: "c" });
	const _attestActual6 = [a, b, c];
	const _attestType6: Eq<typeof _attestActual6, ["a", "b", "c"]> = true;
	expect(_attestActual6).toEqual(["a", "b", "c"]);

	// @ts-expect-error
	expect(() => discriminate({ kind: "d", value: "d" })).toThrow('kind must be "a", "b" or "c" (was "d")');
});

it.todo("invalid string key");

it.todo("lone invalid string key");

it("string cases no default", () => {
	const check = match
		.at("foo")
		.strings({
			value: o => o.foo,
		})
		.default("assert");

	const out = check({ foo: "value" });
	const _attestActual2 = out;
	const _attestType2: Eq<typeof _attestActual2, "value"> = true;
	expect(_attestActual2).toEqual("value");
});

it("string cases no default from in", () => {
	const check = match
		.in({ foo: "string" })
		.at("foo")
		.strings({
			value: o => o.foo,
		})
		.default("assert");

	const out = check({ foo: "value" });
	const _attestActual1 = out;
	const _attestType1: Eq<typeof _attestActual1, "value"> = true;
	expect(_attestActual1).toEqual("value");
});

it("union at input key", () => {
	type Data = {
		id: 1 | 2;
		value: number;
	};

	const discriminateValue = type.match
		.in<Data>()
		.at("id")
		.match({
			1: o => `${o.value}!`,
			2: o => o.value,
			default: "assert",
		});
	expect(discriminateValue({ id: 1, value: 42 })).toBe("42!");
});
