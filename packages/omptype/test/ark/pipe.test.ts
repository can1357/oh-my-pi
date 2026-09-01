import { describe, expect, it } from "bun:test";
import { type ArkErrors, scope, type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

type Out<T> = T;
type To<T> = T;

it("base", () => {
	const T = type("number").pipe(data => `${data}`);
	const _type1: Eq<typeof T, Type<(In: number) => Out<string>>> = true;
	const _type2: Eq<typeof T.infer, string> = true;
	const _type3: Eq<typeof T.in.infer, number> = true;
	const out = T(5);
	const _type4: Eq<typeof out, string | type.errors> = true;
	expect(out).toEqual("5");
	const result = T("foo");
	expect(result.toString()).toEqual("must be a number (was a string)");
});

it("disjoint", () => {
	expect(() => type("number>5").pipe(type("number<3"))).toThrow("numeric range intersection is unsatisfiable");
});

it("to", () => {
	const T = type("string.json.parse").to({
		name: "string",
		age: "number",
	});

	const tOut = T.out;
	const Expected = type({
		name: "string",
		age: "number",
	});

	const _type5: Eq<typeof tOut.t, typeof Expected.t> = true;
	expect(tOut.expression).toEqual(Expected.expression);
});

describe("to string syntax", () => {
	it("to validator", () => {
		const trimToNonEmpty = type("string.trim |> string > 0");
		const Expected = type("string.trim").to("string > 0");

		const _type6: Eq<typeof trimToNonEmpty, typeof Expected> = true;
		expect(trimToNonEmpty(" ok ")).toEqual(Expected(" ok "));
		expect(trimToNonEmpty("   ").toString()).toEqual(Expected("   ").toString());
	});

	it("to morph", () => {
		const trimAndParseNumber = type("string.trim |> string.numeric.parse");
		const Expected = type("string.trim").to("string.numeric.parse");

		const _type7: Eq<typeof trimAndParseNumber, typeof Expected> = true;
		expect(trimAndParseNumber(" 42 ")).toEqual(Expected(" 42 "));
	});

	it("lower precedence than union", () => {
		const T = type("string.numeric.parse |> number.integer | number.safe");
		const Expected = type("string.numeric.parse").to("number.integer | number.safe");

		const _type8: Eq<typeof T, typeof Expected> = true;
		expect(T("2.5")).toEqual(Expected("2.5"));
		expect(T("2")).toEqual(Expected("2"));
	});

	it("lower precedence than union reversed", () => {
		const T = type("string.numeric.parse | number.integer |> number.safe");
		const Expected = type("string.numeric.parse | number.integer").to("number.safe");

		const _type9: Eq<typeof T, typeof Expected> = true;
		expect(T("2")).toEqual(Expected("2"));
		expect(T(2)).toEqual(Expected(2));
	});

	it("missing operand", () => {
		expect(() => type("string |>")).toThrow();
	});
});

it("to morph", () => {
	const restringifyUser = (o: object) => JSON.stringify(o);

	const T = type("string.json.parse").to([
		{
			name: "string",
			age: "number",
		},
		"=>",
		restringifyUser,
	]);

	const _type10: Eq<typeof T.infer, string> = true;
	expect(T('{"name":"Ada","age":37}')).toEqual('{"name":"Ada","age":37}');
});

describe("try", () => {
	it("can catch thrown errors", () => {
		const ParseJson = type("string").pipe.try((s): object => JSON.parse(s));

		const out = ParseJson("[]");

		const _type11: Eq<typeof out, ArkErrors | object> = true;
		expect(out).toEqual([]);

		const badOut = ParseJson("{ unquoted: true }");

		expect(badOut.toString()).toContain("morph threw SyntaxError");
	});

	it("preserves validated out", () => {
		const T = type("string").pipe.try(s => JSON.parse(s), type("unknown[]"));

		const tOut = T.out;
		const ExpectedOut = type("unknown[]");

		const _type12: Eq<typeof tOut.t, typeof ExpectedOut.t> = true;
		expect(tOut.expression).toEqual(ExpectedOut.expression);
	});
});

it("can't directly constrain morph", () => {
	expect(() => type("string.numeric.parse").atMostLength(5)).toThrow();
});

it("within type", () => {
	const T = type([
		"boolean",
		"=>",
		function notMorph(data) {
			return !data;
		},
	]);
	const _type13: Eq<typeof T, Type<(In: boolean) => Out<boolean>>> = true;

	const out = T(true);
	const _type14: Eq<typeof out, boolean | type.errors> = true;
	expect(out).toEqual(false);
	expect(T(1).toString()).toContain("must be boolean");
});

it("unit branches", () => {
	const T = type("0 | 1 | 2").pipe(n => n + 1);
	const _type15: Eq<typeof T.t, (In: 0 | 1 | 2) => Out<number>> = true;

	expect(T(0)).toEqual(1);
	expect(T(3).toString()).toContain("must be 0, 1 or 2");
});

it("type instance reference", () => {
	const User = type({
		name: "string",
		age: "number",
	});
	const parseUser = type("string").pipe(s => JSON.parse(s), User);

	const _type16: Eq<typeof parseUser.t, (In: string) => To<{ name: string; age: number }>> = true;

	const validUser = { name: "David", age: 30 };
	expect(parseUser(JSON.stringify(validUser))).toEqual(validUser);
	const missingKey = { name: "David" };
	expect(parseUser(JSON.stringify(missingKey)).toString()).toEqual("age must be a number (was missing)");
});

it("many pipes", () => {
	const pipeAlphabet = type("'a'").pipe(
		s => `${s}b` as const,
		s => `${s}c` as const,
		s => `${s}d` as const,
		s => `${s}e` as const,
		s => `${s}f` as const,
		s => `${s}g` as const,
		s => `${s}h` as const,
		s => `${s}i` as const,
		s => `${s}j` as const,
		s => `${s}k` as const,
		s => `${s}l` as const,
		s => `${s}m` as const,
		s => `${s}n` as const,
		s => `${s}o` as const,
		s => `${s}p` as const,
		s => `${s}q` as const,
		s => `${s}r` as const,
	);
	const _type17: Eq<typeof pipeAlphabet.infer, "abcdefghijklmnopqr"> = true;
	expect(pipeAlphabet("a")).toEqual("abcdefghijklmnopqr");
});

it("uses pipe for consecutive types", () => {
	const Bar = type({ bar: "number" });
	const T = type({ foo: "string" }).pipe(Bar);
	const _type18: Eq<
		typeof T.t,
		{
			foo: string;
			bar: number;
		}
	> = true;
	const Expected = type({ foo: "string", bar: "number" });
	expect(T.json).toEqual(Expected.json);
	expect(T({ foo: "ok", bar: 1 })).toEqual({ foo: "ok", bar: 1 });
});

it("disjoint", () => {
	expect(() => type("number>5").pipe(type("number<3"))).toThrow("numeric range intersection is unsatisfiable");
});

it("extract in/out at path", () => {
	const T = type({
		foo: type("number").pipe(n => `${n}`, type.string),
	});

	const _type19: Eq<typeof T.in.t, { foo: number }> = true;
	expect(T.in.expression).toEqual("{ foo: number }");

	const _type20: Eq<typeof T.out.t, { foo: string }> = true;
	expect(T.out.expression).toEqual("{ foo: string }");
});

it("uses pipe for many consecutive types", () => {
	const T = type({ a: "1" }).pipe(type({ b: "1" }), type({ c: "1" }), type({ d: "1" }));
	const _type21: Eq<
		typeof T,
		Type<{
			a: 1;
			b: 1;
			c: 1;
			d: 1;
		}>
	> = true;
	const Expected = type({ a: "1", b: "1", c: "1", d: "1" });
	expect(T.json).toEqual(Expected.json);
	expect(T({ a: 1, b: 1, c: 1, d: 1 })).toEqual({ a: 1, b: 1, c: 1, d: 1 });
});

it("two morphs", () => {
	const inefficientStringIsEmpty = type("string").pipe(
		s => s.length,
		length => length === 0,
	);

	const _type22: Eq<typeof inefficientStringIsEmpty.t, (In: string) => Out<boolean>> = true;
	expect(inefficientStringIsEmpty("")).toEqual(true);
	expect(inefficientStringIsEmpty("foo")).toEqual(false);
	expect(inefficientStringIsEmpty(0).toString()).toEqual("must be a string (was a number)");
});

it("any as out", () => {
	const T = type("string", "=>", s => s as any);
	const _type23: Eq<typeof T.in.infer, string> = true;
	// https://github.com/arktypeio/arktype/issues/1023
	// const _type24: Eq<typeof T.infer, any> = true;
});

it("never as out", () => {
	const T = type("string", "=>", s => s as never);
	const _type25: Eq<typeof T.in.infer, string> = true;
	const _type26: Eq<typeof T.infer, never> = true;
});

it("return error", () => {
	const divide100By = type("number", "=>", (n, ctx) => (n !== 0 ? 100 / n : ctx.error("non-zero")));
	const _type27: Eq<typeof divide100By.t, (In: number) => Out<number>> = true;
	expect(divide100By(5)).toEqual(20);
	expect(divide100By(0).toString()).toContain("must be non-zero");
});

it("at path", () => {
	const T = type({ a: ["string", "=>", data => data.length] });
	const _type28: Eq<typeof T.t, { a: (In: string) => Out<number> }> = true;

	const input = { a: "four" };

	const out = T(input);

	const _type29: Eq<typeof out, { a: number } | type.errors> = true;
	expect(out).toEqual({ a: 4 });
});

it("doesn't pipe on error", () => {
	const A = type({ a: "number" }).pipe(function addOne(o) {
		return o.a + 1;
	});

	const B = type({ a: "string" }, "=>", function appendExclamation(o) {
		return `${o.a}!`;
	});

	const T = B.or(A);

	const _type30: Eq<typeof T.t, ((In: { a: string }) => Out<string>) | ((In: { a: number }) => Out<number>)> = true;

	expect(T({ a: 2 })).toEqual(3);
});

it("in array", () => {
	const types = scope({
		lengthOfString: ["string", "=>", data => data.length],
		mapToLengths: "lengthOfString[]",
	}).export();
	const _type31: Eq<typeof types.mapToLengths.t, ((In: string) => Out<number>)[]> = true;
	const out = types.mapToLengths(["1", "22", "333"]);
	const _type32: Eq<typeof out, number[] | type.errors> = true;
	expect(out).toEqual([1, 2, 3]);
});

it("object to string", () => {
	const T = type([{ a: "string" }, "=>", data => JSON.stringify(data)]);
	const out = T({ a: "foo" });
	const _type33: Eq<typeof out, string | type.errors> = true;
	expect(out).toEqual('{"a":"foo"}');
});

it(".out inferred based on validatedOut", () => {
	const Unvalidated = type("string").pipe(s => s.length);

	const _type34: Eq<typeof Unvalidated.infer, number> = true;
	// .out won't be known at runtime
	const _type35: Eq<typeof Unvalidated.out, Type<unknown>> = true;

	const validated = Unvalidated.pipe(type("number"));
	// now that the output is a validated, type, out can be used standalone
	const _type36: Eq<typeof validated.out, Type<number>> = true;
});

it("intersection", () => {
	const $ = scope({
		b: "3.14",
		a: [
			"number",
			"=>",
			function stringifyNumberMorph(data) {
				return `${data}`;
			},
		],
		aAndB: () => $.type("a&b"),
		bAndA: () => $.type("b&a"),
	});
	const types = $.export();

	const _type37: Eq<typeof types.aAndB.t, (In: 3.14) => Out<string>> = true;
	expect(types.aAndB(3.14)).toBe("3.14");
	const _type38: Eq<typeof types.bAndA, typeof types.aAndB> = true;
	expect(types.bAndA(3.14)).toBe("3.14");
});

it("object intersection", () => {
	const $ = scope({
		a: [
			{ a: "1" },
			"=>",
			// as of TS 5.8, removing data's explicit annotation leads to
			// the output being inferred as `never`
			function _pipeScopedObjectIntersection(data: { a: 1 }) {
				return `${data}`;
			},
		],
		b: { b: "2" },
		c: "a&b",
	});
	const types = $.export();

	expect(types.c({ a: 1, b: 2 })).toBe("[object Object]");
});

it("union", () => {
	const types = scope({
		a: [
			"number",
			"=>",
			function _stringifyNumberUnionPipe(data) {
				return `${data}`;
			},
		],
		b: "boolean",
		aOrB: "a|b",
		bOrA: "b|a",
	}).export();
	const _type39: Eq<typeof types.aOrB.t, boolean | ((In: number) => Out<string>)> = true;

	expect(types.aOrB(2)).toBe("2");
	const _type40: Eq<typeof types.bOrA, typeof types.aOrB> = true;
	expect(types.bOrA(true)).toBe(true);
});

it("union with output", () => {
	const T = type("number|string.numeric.parse");
	const _type41: Eq<typeof T.infer, number> = true;
	const _type42: Eq<typeof T.inferIn, string | number> = true;
});

it("deep union", () => {
	const types = scope({
		a: {
			a: [
				"number>0",
				"=>",
				function _stringifyNumberUnionPipeDeep(data) {
					return `${data}`;
				},
			],
		},
		b: { a: "Function" },
		c: "a|b",
	}).export();
	const _type43: Eq<typeof types.c.t, { a: (In: number) => Out<string> } | { a: Function }> = true;

	expect(types.c({ a: 2 })).toEqual({ a: "2" });
	expect(types.c({ a() {} })).toHaveProperty("a");
});

it("chained reference", () => {
	const $ = scope({
		a: type("string").pipe(function stringToLength(s) {
			return s.length;
		}),
		b: () =>
			$.type("a").pipe(function isZeroLength(n) {
				return n === 0;
			}),
	});
	const types = $.export();
	const _type44: Eq<typeof types.b.t, (In: string) => Out<boolean>> = true;

	expect(types.b("")).toBe(true);
	expect(types.b("x")).toBe(false);
});

it("chained nested", () => {
	const $ = scope({
		a: type("string").pipe(function chainedNestedToLength(s) {
			return s.length;
		}),
		b: () =>
			$.type({ a: "a" }).pipe(function chainedNestedGetA({ a }) {
				return a === 0;
			}),
	});

	const types = $.export();
	const _type45: Eq<typeof types.b.t, (In: { a: string }) => Out<boolean>> = true;
	expect(types.b({ a: "" })).toBe(true);
});

it("directly nested", () => {
	const A = type("string", "=>", function _directlyNestedStringToLength(s) {
		return s.length;
	});
	const T = type(
		{
			// doesn't work with a nested tuple expression here due to a TS limitation
			A,
		},
		"=>",
		function _directlyNestedRoot({ A }) {
			return A === 0;
		},
	);
	const _type46: Eq<typeof T.t, (In: { A: string }) => Out<boolean>> = true;
	expect(T({ A: "" })).toBe(true);
});

it("discriminable tuple union", () => {
	const $ = scope({
		a: () =>
			$.type(["string"]).pipe(function _discriminableTupleUnionPipe(s) {
				return [...s, "!"];
			}),
		b: ["number"],
		c: () => $.type("a|b"),
	});
	const types = $.export();

	const _type47: Eq<typeof types.c.t, [number] | ((In: [string]) => Out<string[]>)> = true;

	expect(types.c(["x"])).toEqual(["x", "!"]);
	expect(types.c([1])).toEqual([1]);
});

it("ArkTypeError not included in return", () => {
	const ParsedInt = type([
		"string",
		"=>",
		(s, ctx) => {
			const result = Number.parseInt(s, 10);
			if (Number.isNaN(result)) return ctx.error("an integer string");

			return result;
		},
	]);
	const _type48: Eq<typeof ParsedInt.t, (In: string) => Out<number>> = true;
	expect(ParsedInt("5")).toEqual(5);
	expect(ParsedInt("five").toString()).toContain("must be an integer string");
});

it("nullable return", () => {
	const toNullableNumber = type(["string", "=>", s => s.length || null]);
	const _type49: Eq<typeof toNullableNumber.t, (In: string) => Out<number | null>> = true;
});

it("undefinable return", () => {
	const toUndefinableNumber = type(["string", "=>", s => s.length || undefined]);
	const _type50: Eq<typeof toUndefinableNumber.t, (In: string) => Out<number | undefined>> = true;
});

it("null or undefined return", () => {
	const toMaybeNumber = type(["string", "=>", s => (s.length === 0 ? undefined : s.length === 1 ? null : s.length)]);
	const _type51: Eq<typeof toMaybeNumber.t, (In: string) => Out<number | null | undefined>> = true;
});

it("deep intersection", () => {
	const types = scope({
		a: {
			a: [
				"number>0",
				"=>",
				function _deepIntersectionPipePlusOne(data) {
					return data + 1;
				},
			],
		},
		b: { a: "1" },
		c: "a&b",
	}).export();
	const _type52: Eq<typeof types.c.t, { a: (In: 1) => Out<number> }> = true;

	expect(types.c({ a: 1 })).toEqual({ a: 2 });
});

it("morph intersection", () => {
	expect(() =>
		scope({
			a: ["string", "=>", data => `${data}`],
			b: ["string", "=>", data => `${data}!!!`],
			c: "a&b",
		}).export(),
	).toThrow();
});

it("indiscriminable union", () => {
	expect(() => {
		scope({
			a: ["/.*/", "=>", s => s.trim()],
			b: "string",
			c: "a|b",
		}).export();
	}).toThrow();
});

it("deep morph intersection", () => {
	expect(() => {
		scope({
			a: { a: ["number", "=>", data => `${data}`] },
			b: { a: ["number", "=>", data => `${data}!!!`] },
			c: "a&b",
		}).export();
	}).toThrow();
});

it("deep indiscriminable", () => {
	const $ = scope({
		a: { foo: ["string", "=>", s => s.trim()] },
		b: { foo: "symbol" },
		c: { bar: "symbol" },
	});

	// this is fine as a | b can be discriminated via foo
	const T = $.type("a|b");
	const _type53: Eq<typeof T.t, { foo: (In: string) => Out<string> } | { foo: symbol }> = true;

	expect(() => $.type("a|c")).toThrow();
});

it("array double intersection", () => {
	expect(() => {
		scope({
			a: { a: ["number>0", "=>", data => data + 1] },
			b: { a: ["number>0", "=>", data => data + 2] },
			c: "a[]&b[]",
		}).export();
	}).toThrow();
});

it("undiscriminated morph at path", () => {
	expect(() => {
		scope({
			a: { a: ["string", "=>", s => s.trim()] },
			b: { b: "bigint" },
			c: { key: "a|b" },
		}).export();
	}).toThrow();
});

it("helper morph intersection", () => {
	expect(() =>
		type("string")
			.pipe(s => s.length)
			.and(type("string").pipe(s => s.length)),
	).toThrow();
});

it("union helper undiscriminated", () => {
	expect(() =>
		type("string")
			.pipe(s => s.length)
			.or("'foo'"),
	).toThrow();
});

it("allows undiscriminated union if morphs are equal", () => {
	const T = type({ foo: "1" })
		.or({ bar: "1" })
		.pipe(function getObjectValues(o) {
			return Object.values(o);
		});

	const _type54: Eq<typeof T.t, (In: { foo: 1 } | { bar: 1 }) => Out<1[]>> = true;

	expect(T({ foo: 1 })).toEqual([1]);
	expect(T({ bar: 1 })).toEqual([1]);
	expect(T({ baz: 2 }).toString()).toContain("bar must be 1");
});
it("allows undiscriminated union if morphs at path are equal", () => {
	const T = type({ l: "1", n: "string.numeric.parse" }, "|", {
		r: "1",
		n: "string.numeric.parse",
	});

	expect(T({ l: 1, n: "234" })).toEqual({ l: 1, n: 234 });
	expect(T({ r: 1, n: "234" })).toEqual({ r: 1, n: 234 });
	expect(T({ l: 1, r: 1, n: "234" })).toEqual({ l: 1, r: 1, n: 234 });
	expect(T({ n: "234" }).toString()).toContain("l must be 1 (was missing)");
	expect(T({ n: "234" }).toString()).toContain("r must be 1 (was missing)");
});
it("fails on indiscriminable morph in nested union", () => {
	const indiscriminable = () =>
		type({
			foo: "boolean | string.date.parse",
		}).or({
			foo: "boolean | string.json.parse",
		});

	expect(indiscriminable).toThrow("indeterminate");
});

it("multiple chained pipes", () => {
	const T = type("string.trim").to("string.lower");

	expect(T("Success")).toEqual("success");
	expect(T("success")).toEqual("success");
	expect(T("SUCCESS  ")).toEqual("success");
	expect(T("success  ")).toEqual("success");
});

// https://github.com/arktypeio/arktype/issues/1144
it("multiple chained pipes with literal output", () => {
	const Base = type("string.trim").to("string.lower");

	const T = Base.to("'success'");

	const _type55: Eq<typeof T.t, (In: string) => To<"success">> = true;

	expect(T("Success")).toEqual("success");
	expect(T("success")).toEqual("success");
	expect(T("SUCCESS  ")).toEqual("success");
	expect(T("success  ")).toEqual("success");
});

const appendLengthMorph = (s: string) => `${s}${s.length}`;

// https://discord.com/channels/957797212103016458/1291014543635517542
it("repeated Type pipe", () => {
	const appendLength = type("string", "=>", appendLengthMorph);
	const appendLengths = type("string").pipe(appendLength, appendLength);

	expect(appendLengths("a")).toEqual("a12");
});

// https://discord.com/channels/957797212103016458/1291014543635517542
it("repeated Type pipe with intermediate morph", () => {
	const appendLength = type("string", "=>", appendLengthMorph);

	const appendSeparatorMorph = (s: string) => `${s}|`;

	const appendSeparatedLengths = type("string").pipe(
		appendLength,
		appendLength,
		appendSeparatorMorph,
		appendLength,
		appendLength,
	);

	expect(appendSeparatedLengths("a")).toEqual("a12|45");
});

it("doesn't lose input prop morphs", () => {
	const T = type({
		foo: type("string").pipe(s => s.length),
	})
		.pipe(o => o)
		.to({
			foo: "number",
		});
	expect(T({ foo: "bar" })).toEqual({ foo: 3 });

	const types = scope({
		From: { a: ["1", "=>", () => 2] },
		Morph: ["From", "=>", e => e],
		To: { a: "2" },
	}).export();
	const U = types.Morph.pipe(e => e, types.To);
	const out = U({ a: 1 });
	const _type56: Eq<
		typeof out,
		| ArkErrors
		| {
				a: 2;
		  }
	> = true;
	expect(out).toEqual({ a: 2 });
});

// https://github.com/arktypeio/arktype/issues/1185
it("pipe doesn't run on rejected descendant prop", () => {
	let callCount = 0;
	const T = type({
		key: "string",
	}).pipe(v => {
		callCount++;
		return v;
	});

	const out = T({});

	expect(out.toString()).toEqual("key must be a string (was missing)");
	expect(callCount).toEqual(0);
});

it("to tuple expression", () => {
	const T = type(["string.json.parse", "|>", { name: "string" }]);

	const Expected = type("string.json.parse").to({ name: "string" });

	const _type57: Eq<typeof T, typeof Expected> = true;
	expect(T('{"name":"Ada"}')).toEqual({ name: "Ada" });
});

it("to args expression", () => {
	const T = type("string.json.parse", "|>", { name: "string" });

	const Expected = type("string.json.parse").to({ name: "string" });

	const _type58: Eq<typeof T, typeof Expected> = true;
	expect(T('{"name":"Ada"}')).toEqual({ name: "Ada" });
});

it("infers distributed pipes", () => {
	const T = type("string.numeric.parse | number").to("number > 0");
	expect(T("5")).toBe(5);
});

it("extracted from cyclic type", () => {
	const T = type({
		morphed: "string.numeric.parse",
		"nested?": "this",
	});

	const t = T.assert({ morphed: "5" });

	expect(t).toEqual({ morphed: 5 });
	const _type59: Eq<typeof t.morphed, number> = true;
	const nestedMorphed = t.nested?.morphed;
	const _type60: Eq<typeof nestedMorphed, number | undefined> = true;
});

it("extract in/out preserves undeclared rejection", () => {
	const T = type({
		"+": "reject",
		foo: "true",
	});

	expect(T.in({ foo: true, bar: 1 }).toString()).toContain("bar must be removed");
});

it("complex morphs are applied on correct path", () => {
	let c: null | 1;

	const M = type({
		list: type("object")
			.pipe(e => e)
			.pipe(
				type({
					z: type("unknown").pipe(() => c),
				}),
			)
			.array(),
		_: ["unknown", ":", () => true],
	});

	c = null;
	expect(() =>
		M.assert({
			list: [{ z: "" }, { z: "" }],
		}),
	).toThrow("_ must be valid according to an anonymous predicate (was missing)");

	c = 1;
	expect(() =>
		M.assert({
			list: [{ z: "" }, { z: "" }],
		}),
	).toThrow("_ must be valid according to an anonymous predicate (was missing)");
});

// https://github.com/arktypeio/arktype/pull/1464
it("branched optimistic pipe union", () => {
	class TypeA {
		type = "typeA";
	}

	class TypeB {
		type = "typeB";
	}

	const typeA = new TypeA();

	const Thing = type.or(
		type.instanceOf(TypeB),
		type.string.pipe(_value => new TypeB()),
		type.instanceOf(TypeA).pipe(_value => new TypeB()),
	);

	const out = Thing.assert(typeA);
	expect(out).toBeInstanceOf(TypeB);
});

// https://github.com/arktypeio/arktype/pull/1464
it("complex pipes", () => {
	const inputData = [
		{
			OuterKey: [
				{
					MiddleKey: [
						{
							InnerKey: [],
						},
					],
				},
			],
		},
	];

	const genericSchema = type("Record<string, unknown>[]")
		.pipe.try(arr =>
			arr.map(item => {
				const [kind, value] = Object.entries(item)[0];
				return { kind, value };
			}),
		)
		.pipe(
			type({ kind: "string", value: "unknown" })
				.pipe(item => ({ kind: item.kind, value: item.value }))
				.array(),
			arr =>
				arr.reduce<Record<string, { value: unknown }>>((acc, { kind, value }) => {
					acc[kind] = { value };
					return acc;
				}, {}),
			type({
				OuterKey: {
					value: type({
						MiddleKey: type({ InnerKey: type("object") })
							.array()
							.pipe(v => v[0]),
					}).array(),
				},
			}),
		);

	const result = genericSchema(inputData);
	expect(result).toEqual({
		OuterKey: {
			value: [
				{
					MiddleKey: { InnerKey: [] },
				},
			],
		},
	});
});

// https://github.com/arktypeio/arktype/pull/1464
it("nested pipes", () => {
	const parseFirstElementToNumber = type("string[]")
		.pipe(v => v[0])
		.to("string.numeric.parse");

	const extractAndParseFirstElement = type({
		Value: parseFirstElementToNumber,
	})
		.array()
		.pipe(v => v[0]);

	const Item = type({
		SubItem: extractAndParseFirstElement,
		Meta: {},
	});

	const T = type({
		Item: Item.array(),
	});

	const data = {
		Item: [
			{
				SubItem: [
					{
						Value: ["0"],
					},
				],
			},
			{
				SubItem: [
					{
						Value: ["0"],
					},
				],
			},
		],
	};

	const result = T(data);

	expect(result.toString()).toEqual(`Item[0].Meta must be an object (was missing)
Item[1].Meta must be an object (was missing)`);
});
