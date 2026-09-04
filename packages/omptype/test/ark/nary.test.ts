import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("union", () => {
	const $ = type.scope({
		a: "1",
		b: "2",
		c: "3",
		d: "4",
		e: "5",
		f: "6",
		g: "7",
		h: "8",
		i: "9",
		j: "10",
		k: "11",
		l: "12",
		m: "13",
		n: "14",
		o: "15",
		p: "16",
		q: "17",
	});

	it("nullary", () => {
		const T = type.or();
		const _1: Eq<typeof T.t, never> = true;

		expect(T.expression).toEqual("never");
		expect(T.$.internal.name).toEqual("ark");
	});

	it("unary", () => {
		const T = $.type.or("a");
		const _2: Eq<typeof T.t, 1> = true;
		expect(T.expression).toEqual("1");
	});

	it("binary", () => {
		const T = $.type.or("a", "b");
		const _3: Eq<typeof T.t, 1 | 2> = true;
		expect(T.expression).toEqual("1 | 2");
	});

	it("3-ary", () => {
		const T = $.type.or("a", "b", "c");
		const _4: Eq<typeof T.t, 1 | 2 | 3> = true;
		expect(T.expression).toEqual("1 | 2 | 3");
	});

	it("4-ary", () => {
		const T = $.type.or("a", "b", "c", "d");
		const _5: Eq<typeof T.t, 1 | 2 | 3 | 4> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4");
	});

	it("5-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e");
		const _6: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5");
	});

	it("6-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f");
		const _7: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6");
	});

	it("7-ary", () => {
		const T = $.type.or("1", "2", "3", "4", "5", "6", "7");
		const _8: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7");
	});

	it("8-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h");
		const _9: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8");
	});

	it("9-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i");
		const _10: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9");
	});

	it("10-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
		const _11: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10");
	});

	it("11-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
		const _12: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11");
	});

	it("12-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l");
		const _13: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12");
	});

	it("13-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m");
		const _14: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13");
	});

	it("14-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n");
		const _15: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14");
	});

	it("15-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o");
		const _16: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15");
	});

	it("16-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p");
		const _17: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16");
	});

	it("n-ary", () => {
		const T = $.type.or("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q");

		const _18: Eq<typeof T.t, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17> = true;
		expect(T.expression).toEqual("1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17");
	});

	it.todo("completions");

	it("spreadable", () => {
		const types: type[] = [];

		const T = type.or(...types);

		const _19: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("never");
	});

	it("spreadable scoped", () => {
		const types: { key: "a" }[] = [];

		const T = $.type.or(...types);

		const _20: Eq<typeof T.t, { key: 1 }> = true;
	});
});

describe("intersection", () => {
	const $ = type.scope({
		a: { a1: "1" },
		b: { a2: "2" },
		c: { a3: "3" },
		d: { a4: "4" },
		e: { a5: "5" },
	});

	it("nullary", () => {
		const T = type.and();
		const _21: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("unknown");
		expect(T.$.internal.name).toEqual("ark");
	});

	it("unary", () => {
		const T = $.type.and("a");
		const _22: Eq<typeof T.t, { a1: 1 }> = true;
		expect(T.expression).toEqual("{ a1: 1 }");
	});

	it("binary", () => {
		const T = $.type.and("a", "b");
		const _23: Eq<typeof T.t, { a1: 1; a2: 2 }> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2 }");
	});

	it("3-ary", () => {
		const T = $.type.and("a", "b", "c");
		const _24: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3 }");
	});

	it("4-ary", () => {
		const T = $.type.and("a", "b", "c", "d");
		const _25: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
				a4: 4;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3, a4: 4 }");
	});

	it("5-ary", () => {
		const T = $.type.and("a", "b", "c", "d", "e");
		const _26: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
				a4: 4;
				a5: 5;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3, a4: 4, a5: 5 }");
	});

	it.todo("completions");

	it("spreadable", () => {
		const types: type[] = [];

		const T = type.and(...types);

		const _27: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("unknown");
	});

	it("spreadable n-length", () => {
		const types: ({ a: { key: "1" } } | { "a?": { another: "1" }; "b?": "3" })[] = [];

		const T = $.type.and(...types);

		const _28: Eq<
			typeof T.t,
			{
				// should be required if one or branches is required
				a: {
					key: 1;
					another: 1;
				};
				// should be optional if all branches are optional
				b?: 3;
			}
		> = true;
	});
});

describe("merge", () => {
	const $ = type.scope({
		a: { a1: "1" },
		b: { a2: "2" },
		c: { a3: "3" },
		d: { a4: "4" },
		e: { a5: "5" },
	});

	it("nullary", () => {
		const T = type.merge();
		const _29: Eq<typeof T.t, object> = true;
		expect(T.expression).toEqual("object");
		expect(T.$.internal.name).toEqual("ark");
	});

	it("unary", () => {
		const T = $.type.merge("a");
		const _30: Eq<typeof T.t, { a1: 1 }> = true;
		expect(T.expression).toEqual("{ a1: 1 }");
	});

	it("binary", () => {
		const T = $.type.merge("a", "b");
		const _31: Eq<typeof T.t, { a1: 1; a2: 2 }> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2 }");
	});

	it("3-ary", () => {
		const T = $.type.merge("a", "b", "c");
		const _32: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3 }");
	});

	it("4-ary", () => {
		const T = $.type.merge("a", "b", "c", "d");
		const _33: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
				a4: 4;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3, a4: 4 }");
	});

	it("5-ary", () => {
		const T = $.type.merge("a", "b", "c", "d", "e");

		const _34: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
				a4: 4;
				a5: 5;
			}
		> = true;
		expect(T.expression).toEqual("{ a1: 1, a2: 2, a3: 3, a4: 4, a5: 5 }");
	});

	it("nary", () => {
		const T = type.merge(
			{ a1: "1" },
			{ a2: "2" },
			{ a3: "3" },
			{ a4: "4" },
			{ a5: "5" },
			{ a6: "6" },
			{ a7: "7" },
			{ a8: "8" },
			{ a9: "9" },
			{ a10: "10" },
			{ a11: "11" },
			{ a12: "12" },
			{ a13: "13" },
			{ a14: "14" },
			{ a15: "15" },
			{ a16: "16" },
			{ a17: "17" },
		);

		const _35: Eq<
			typeof T.t,
			{
				a1: 1;
				a2: 2;
				a3: 3;
				a4: 4;
				a5: 5;
				a6: 6;
				a7: 7;
				a8: 8;
				a9: 9;
				a10: 10;
				a11: 11;
				a12: 12;
				a13: 13;
				a14: 14;
				a15: 15;
				a16: 16;
				a17: 17;
			}
		> = true;

		expect(T.expression).toEqual(
			"{ a1: 1, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, a10: 10, a11: 11, a12: 12, a13: 13, a14: 14, a15: 15, a16: 16, a17: 17 }",
		);
	});

	// type-perf currently blows up here, investigation:
	// https://github.com/arktypeio/arktype/issues/1394

	it.todo("completions");

	it("spreadable", () => {
		const types: type<object>[] = [];

		const T = type.merge(...types);

		const _36: Eq<typeof T.t, {}> = true;
		expect(T.expression).toEqual("object");
	});

	it("spreadable scoped", () => {
		const types: { key: "a" }[] = [];

		const T = $.type.merge(...types);

		const _37: Eq<typeof T.t, { key: { a1: 1 } }> = true;
	});

	it("spreadable n-length", () => {
		const types: ({ a: "1" } | { a: "2?"; b: "3" })[] = [];

		const T = $.type.merge(...types);

		const _38: Eq<
			typeof T.t,
			{
				// should be optional if one or more branches are optional
				a?: 1 | 2;
				b: 3;
			}
		> = true;
	});
});

describe("pipe", () => {
	it("nullary", () => {
		const T = type.pipe();
		const _39: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("unknown");
		expect(T.$.internal.name).toEqual("ark");
	});

	it("unary Type", () => {
		const T = type.pipe(type.string);
		const _40: Eq<typeof T.t, string> = true;
		expect(T.expression).toEqual("string");
	});

	it("unary morph", () => {
		const T = type.pipe((u: unknown) => JSON.stringify(u));
		const _unaryMorph: Eq<typeof T.t, (In: unknown) => Out<string>> = true;
		expect(T.expression).toEqual("(In: unknown) => Out<unknown>");
	});

	it("binary", () => {
		const T = type.pipe(type.string, function _upper(s: string) {
			return s.toUpperCase();
		});
		const _binaryMorph: Eq<typeof T.t, (In: string) => Out<string>> = true;
		expect(T.expression).toEqual("(In: string) => Out<unknown>");
	});

	it("3-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
		);
		const _41: Eq<typeof T.infer, "abc"> = true;
		expect(T("a")).toEqual("abc");
	});

	it("4-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
		);
		const _42: Eq<typeof T.infer, "abcd"> = true;
		expect(T("a")).toEqual("abcd");
	});

	it("5-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
		);
		const _43: Eq<typeof T.infer, "abcde"> = true;
		expect(T("a")).toEqual("abcde");
	});

	it("6-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
			s => `${s}f` as const,
		);
		const _44: Eq<typeof T.infer, "abcdef"> = true;
		expect(T("a")).toEqual("abcdef");
	});

	it("7-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
			s => `${s}f` as const,
			s => `${s}g` as const,
		);
		const _45: Eq<typeof T.infer, "abcdefg"> = true;
		expect(T("a")).toEqual("abcdefg");
	});

	it("8-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
			s => `${s}f` as const,
			s => `${s}g` as const,
			s => `${s}h` as const,
		);
		const _46: Eq<typeof T.infer, "abcdefgh"> = true;
		expect(T("a")).toEqual("abcdefgh");
	});

	it("9-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
			s => `${s}f` as const,
			s => `${s}g` as const,
			s => `${s}h` as const,
			s => `${s}i` as const,
		);
		const _47: Eq<typeof T.infer, "abcdefghi"> = true;
		expect(T("a")).toEqual("abcdefghi");
	});

	it("10-ary", () => {
		const T = type.pipe(
			type.unit("a"),
			s => `${s}b` as const,
			s => `${s}c` as const,
			s => `${s}d` as const,
			s => `${s}e` as const,
			s => `${s}f` as const,
			s => `${s}g` as const,
			s => `${s}h` as const,
			s => `${s}i` as const,
			s => `${s}j` as const,
		);
		const _48: Eq<typeof T.infer, "abcdefghij"> = true;
		expect(T("a")).toEqual("abcdefghij");
	});

	it("11-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _49: Eq<typeof T.infer, "abcdefghijk"> = true;
		expect(T("a")).toEqual("abcdefghijk");
	});

	it("12-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _50: Eq<typeof T.infer, "abcdefghijkl"> = true;
		expect(T("a")).toEqual("abcdefghijkl");
	});

	it("13-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _51: Eq<typeof T.infer, "abcdefghijklm"> = true;
		expect(T("a")).toEqual("abcdefghijklm");
	});

	it("14-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _52: Eq<typeof T.infer, "abcdefghijklmn"> = true;
		expect(T("a")).toEqual("abcdefghijklmn");
	});

	it("15-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _53: Eq<typeof T.infer, "abcdefghijklmno"> = true;
		expect(T("a")).toEqual("abcdefghijklmno");
	});

	it("16-ary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _54: Eq<typeof T.infer, "abcdefghijklmnop"> = true;
		expect(T("a")).toEqual("abcdefghijklmnop");
	});

	it("nary", () => {
		const T = type.pipe(
			type.unit("a"),
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
		);
		const _55: Eq<typeof T.infer, "abcdefghijklmnopq"> = true;
		expect(T("a")).toEqual("abcdefghijklmnopq");
	});

	it("spreadable as Types", () => {
		const types: type[] = [];

		const T = type.pipe(...types);

		const _56: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("unknown");
	});

	it("spreadable as Morphs", () => {
		const morphs: Morph[] = [];

		const T = type.pipe(...morphs);

		const _57: Eq<typeof T.t, unknown> = true;
		expect(T.expression).toEqual("unknown");
	});
});

it("handles base scopes correctly", () => {
	// previously errored here because after the first intersection, this was a SchemaScope
	const T = type.and({ a1: "1" }).and({ a2: "2" });

	expect(T.expression).toEqual("{ a1: 1, a2: 2 }");
	expect(T.$.internal.name).toEqual("ark");
});
