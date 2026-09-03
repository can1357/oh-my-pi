import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("implicit problem", () => {
	function isOdd(n: number): boolean {
		return n % 2 === 1;
	}
	const Odd = type(["number", ":", isOdd]);
	const _infer: Eq<typeof Odd.infer, number> = true;
	expect(Odd(1)).toEqual(1);
	expect(String(Odd(2))).toBe("must be valid according to isOdd (was 2)");
});

it("implicit problem anonymous", () => {
	const Even = type("number", ":", n => n % 2 === 0);
	expect(String(Even(1))).toBe("must be valid according to an anonymous predicate (was 1)");
});

it("explicit problem", () => {
	const DivisibleBy3 = type(["number", ":", (n, ctx) => n % 3 === 0 || ctx.reject("divisible by 3")]);
	expect(String(DivisibleBy3(1))).toBe("must be divisible by 3 (was 1)");
});

it("chained narrows", () => {
	const A = type("number").narrow((n, ctx) => n % 2 === 0 || ctx.reject("divisible by 2"));
	const b = A.narrow((n, ctx) => n % 3 === 0 || ctx.reject("divisible by 3"));
	const DivisibleBy30 = b.narrow((n, ctx) => n % 5 === 0 || ctx.reject("divisible by 5"));
	const _t: Eq<typeof DivisibleBy30.t, number> = true;
	expect(String(DivisibleBy30(1))).toBe("must be divisible by 2 (was 1)");
	expect(String(DivisibleBy30(2))).toBe("must be divisible by 3 (was 2)");
	expect(String(DivisibleBy30(6))).toBe("must be divisible by 5 (was 6)");
	expect(DivisibleBy30(30)).toEqual(30);
});

it("problem at path", () => {
	const AbEqual = type([
		{ a: "number", b: "number" },
		":",
		({ a, b }, ctx) => {
			if (a === b) return true;
			ctx.error({ expected: "equal to b", path: ["a"] });
			ctx.error({ expected: "equal to a", path: ["b"] });
			return false;
		},
	]);
	const _t: Eq<typeof AbEqual.t, { a: number; b: number }> = true;
	const _infer: Eq<typeof AbEqual.infer, { a: number; b: number }> = true;
	expect(AbEqual({ a: 1, b: 1 })).toEqual({ a: 1, b: 1 });
	expect(String(AbEqual({ a: 1, b: 2 }))).toBe(
		'a must be equal to b (was {"a":1,"b":2})\nb must be equal to a (was {"a":1,"b":2})',
	);
});

it("functional predicate", () => {
	const One = type(["number", ":", (n): n is 1 => n === 1]);
	const _infer: Eq<typeof One.infer, 1> = true;
});

it("functional parameter inference", () => {
	type Expected = number | boolean[];
	const validateNumberOrBooleanList = <T>(_value: T & Expected) => true;
	const T = type(["number|boolean[]", ":", data => validateNumberOrBooleanList(data)]);
	const _infer: Eq<typeof T.infer, number | boolean[]> = true;
	type(["number|boolean[]", ":", (data: number | string[]) => !!data]);
});

it("narrow problem", () => {
	const Palindrome = type([
		"string",
		":",
		(s, ctx) => (s === [...s].reverse().join("") ? true : ctx.reject("a palindrome")),
	]);
	const _t: Eq<typeof Palindrome.t, string> = true;
	expect(Palindrome("dad")).toEqual("dad");
	expect(String(Palindrome("david"))).toBe('must be a palindrome (was "david")');
});

it("narrows the output type of a morph", () => {
	const T = type("string")
		.pipe(function _narrowMorphOutputMorph(s) {
			return s.length;
		})
		.narrow(function _narrowMorphOutputNarrow(n): n is 5 {
			return n === 5;
		});
	const _t: Eq<typeof T.t, (In: string) => 5> = true;
	expect(T("12345")).toEqual(5);
	expect(String(T("1234"))).toBe("must be valid according to _narrowMorphOutputNarrow (was 4)");
});

it("expression", () => {
	const T = type("string", ":", (s): s is `f${string}` => s[0] === "f");
	const _infer: Eq<typeof T.infer, `f${string}`> = true;
});

it("narrows the output type of an morph within a single type", () => {
	const T = type("string")
		.pipe(s => `${s}!`)
		.narrow((s): s is "foo!" => s === "foo!");
	const _t: Eq<typeof T.t, (In: string) => "foo!"> = true;
	const _inferIn: Eq<typeof T.inferIn, string> = true;
	const _infer: Eq<typeof T.infer, "foo!"> = true;
});

it("narrow then pipe", () => {
	const stringify = (bigint: bigint) => bigint.toString();
	const predicate = () => true;
	const A = type("bigint").narrow(predicate).pipe(stringify);
	const _t: Eq<typeof A.t, (In: bigint) => string> = true;
	const _in: Eq<typeof A.in.infer, bigint> = true;
	const _inferIn: Eq<typeof A.inferIn, bigint> = true;
	const _infer: Eq<typeof A.infer, string> = true;
});

it("can distill constrained built-ins", () => {
	const N = type("number")
		.narrow(() => true)
		.pipe(() => true);
	const _n1: Eq<typeof N.inferIn, number> = true;
	const _n2: Eq<typeof N.in.infer, number> = true;
	const S = type("string")
		.narrow(() => true)
		.pipe(() => true);
	const _s1: Eq<typeof S.inferIn, string> = true;
	const _s2: Eq<typeof S.in.infer, string> = true;
	const B = type("bigint")
		.narrow(() => true)
		.pipe(() => true);
	const _b1: Eq<typeof B.inferIn, bigint> = true;
	const _b2: Eq<typeof B.in.infer, bigint> = true;
	const Sym = type("symbol")
		.narrow(() => true)
		.pipe(() => true);
	const _sym1: Eq<typeof Sym.inferIn, symbol> = true;
	const _sym2: Eq<typeof Sym.in.infer, symbol> = true;
	const D = type("Date")
		.narrow(() => true)
		.pipe(() => true);
	const _d: Eq<typeof D.inferIn, Date> = true;
});

it("can distill constrained objects", () => {
	const Obj = type({ foo: "number" })
		.narrow(() => true)
		.pipe(() => true);
	const _obj1: Eq<typeof Obj.inferIn, { foo: number }> = true;
	const _obj2: Eq<typeof Obj.in.infer, { foo: number }> = true;
	const Nested = type({ foo: ["number.integer", "=>", n => n++] });
	const _nested1: Eq<typeof Nested.inferIn, { foo: number }> = true;
	const _nested2: Eq<typeof Nested.in.infer, { foo: number }> = true;
	const MapType = type("Map")
		.narrow(() => true)
		.pipe(m => m);
	const _mapOut: Eq<typeof MapType.infer, Map<unknown, unknown>> = true;
	const _mapIn: Eq<typeof MapType.inferIn, Map<unknown, unknown>> = true;
});

it("can distill constrained arrays", () => {
	const Arr = type("string[]")
		.narrow(() => true)
		.pipe(() => true);
	const _arr1: Eq<typeof Arr.inferIn, string[]> = true;
	const _arr2: Eq<typeof Arr.in.infer, string[]> = true;
	const ObjArr = type({ foo: "string.date.parse" })
		.array()
		.narrow(() => true)
		.pipe(d => d);
	const _objArr1: Eq<typeof ObjArr.inferIn, { foo: string }[]> = true;
	const _objArr2: Eq<typeof ObjArr.in.infer, { foo: string }[]> = true;
});

it("can distill units", () => {
	const T = type("5").narrow(() => true);
	const _t: Eq<typeof T.t, 5> = true;
	const _infer: Eq<typeof T.infer, 5> = true;
	const _inferIn: Eq<typeof T.inferIn, 5> = true;
});

it("unknown is narrowable", () => {
	const unknownPredicate854 = () => true;
	const T = type("unknown").narrow(unknownPredicate854);
	const _t: Eq<typeof T.t, unknown> = true;
});
