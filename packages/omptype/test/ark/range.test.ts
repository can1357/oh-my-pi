import { describe, expect, it } from "bun:test";
import { type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("string expressions", () => {
	it(">", () => {
		const T = type("number>0");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
	});

	it("<", () => {
		const T = type("number<10");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = {
			domain: "number",
			max: { rule: 10, exclusive: true },
		};
		expect(Expected).toBeDefined();
	});

	it("<=", () => {
		const T = type("number<=-49");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = {
			domain: "number",
			max: { rule: -49, exclusive: false },
		};
		expect(Expected).toBeDefined();
	});

	it("==", () => {
		const T = type("number==3211993");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = { unit: 3211993 };
		expect(Expected).toBeDefined();
	});

	it("== length", () => {
		const T = type({ code: "string==6" });

		expect(T({ code: "123456" })).toEqual({ code: "123456" });
		expect(String(T({ code: "foo" }))).toBe("code must be at least length 6 (was 3)");
	});

	it("<,<=", () => {
		const T = type("-5<number<=5");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = {
			domain: "number",
			min: { rule: -5, exclusive: true },
			max: 5,
		};
		expect(Expected).toBeDefined();
	});

	it("<=,<", () => {
		const T = type("-3.23<=number<4.654");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = {
			domain: "number",
			min: { rule: -3.23 },
			max: { rule: 4.654, exclusive: true },
		};
		expect(Expected).toBeDefined();
	});

	it("whitespace following comparator", () => {
		const T = type("number > 3");
		const _type: Eq<typeof T.infer, number> = true;
		const _schema: Eq<typeof T, Type<number, {}>> = true;
		const Expected = {
			domain: "number",
			min: { rule: 3, exclusive: true },
		};
		expect(Expected).toBeDefined();
	});

	it("single Date", () => {
		const T = type("Date<d'2023/1/12'");
		const _type: Eq<typeof T.infer, Date> = true;
		const _schema: Eq<typeof T, Type<Date, {}>> = true;
	});

	it("Date equality", () => {
		const T = type("Date==d'2020-1-1'");
		const _type: Eq<typeof T.infer, Date> = true;
		const _schema: Eq<typeof T, Type<Date, {}>> = true;
		expect(T.allows(new Date("2020/01/01"))).toEqual(true);
		expect(T.allows(new Date("2020/01/02"))).toEqual(false);
	});

	it("double Date", () => {
		const T = type("d'2001/10/10'< Date < d'2005/10/10'");
		const _type: Eq<typeof T.infer, Date> = true;
		const _t: Eq<typeof T.t, Date> = true;
		expect(T.allows(new Date("2003/10/10"))).toEqual(true);
		expect(T.allows(new Date("2001/10/10"))).toEqual(false);
		expect(T.allows(new Date("2005/10/10"))).toEqual(false);
	});

	it("dynamic Date", () => {
		const now = new Date();
		const T = type(`d'2000'< Date <=d'${now.toISOString()}'`);
		const _type: Eq<typeof T.infer, Date> = true;
		const _schema: Eq<typeof T, Type<Date, {}>> = true;
		expect(T.allows(new Date(now.valueOf() - 1000))).toEqual(true);
		expect(T.allows(now)).toEqual(true);
		expect(T.allows(new Date(now.valueOf() + 1000))).toEqual(false);
	});

	it("exclusive length normalized", () => {
		const T = type("string > 0");
		const Expected = type("string >= 1");
		expect(T.json).toEqual(Expected.json);
	});

	it("trivially satisfied length normalized", () => {
		const T = type("string >= 0");
		const Expected = type("string");
		expect(T.json).toEqual(Expected.json);
	});

	it("invalid left comparator", () => {
		expect(() => type("3>number<5")).toThrow();
	});

	it("invalid right double-bound comparator", () => {
		expect(() => type("3<number==5")).toThrow();
	});

	it("unpaired left", () => {
		expect(() => type("3<number")).toThrow();
	});

	it("unpaired left group", () => {
		expect(() => type("(-1<=number)")).toThrow();
	});

	it("double left", () => {
		expect(() => type("3<5<8")).toThrow();
	});

	it("empty range", () => {
		expect(() => type("3<=number<2")).toThrow('numeric range is unsatisfiable in "3<=number<2"');
	});

	it.todo("double right bound");

	it("negative-length", () => {
		expect(() => type("string < 0")).toThrow();
	});

	it("non-integer length", () => {
		expect(() => type("string >= 2.5")).toThrow();
	});

	it("non-narrowed bounds", () => {
		const a = 5 as number;
		const b = 7 as number;
		const T = type(`${a}<number<${b}`);
		const _type: Eq<typeof T.infer, number> = true;
	});

	it("fails at runtime on malformed right", () => {
		expect(() => type("number<07")).toThrow();
	});

	it("fails at runtime on malformed lower", () => {
		expect(() => type("3.0<number<5")).toThrow();
	});

	it("number", () => {
		const T = type("number==-3.14159");
		const _type: Eq<typeof T.infer, number> = true;
	});

	it("string", () => {
		const T = type("string<=5");
		const _type: Eq<typeof T.infer, string> = true;
	});

	it("array", () => {
		const T = type("87<=boolean[]<89");
		const _type: Eq<typeof T.infer, boolean[]> = true;
	});

	it("multiple bound kinds", () => {
		expect(() => type("(number | boolean[])>0")).toThrow();
	});

	it("unknown", () => {
		expect(() => type("unknown<10")).toThrow();
	});

	it("unboundable", () => {
		expect(() => type("object>10")).toThrow();
	});

	it("morph", () => {
		expect(() => type("string.trim > 2")).toThrow('cannot bound morph in "string.trim > 2"');
	});

	it("same bound kind union", () => {
		const T = type("1<(number[]|object[])<10");
		const _type: Eq<typeof T.infer, number[] | object[]> = true;
		const Expected = type("1<number[]<10 | 1<object[]<10");
		expect(T.json).toEqual(Expected.json);
	});

	it("number with right Date bound", () => {
		expect(() => type("number<d'2001/01/01'")).toThrow();
	});

	it("number with left Date bound", () => {
		expect(() => type("d'2001/01/01'<number<2")).toThrow();
	});
});

describe("chained", () => {
	it("atLeast", () => {
		const T = type("number").atLeast(5);
		const Expected = type("number>=5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid min operand", () => {
		expect(() => type("string").atLeast(5)).toThrow();
	});

	it("moreThan", () => {
		const T = type("number").moreThan(5);
		const Expected = type("number>5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("atMost", () => {
		const T = type("number").atMost(10);
		const Expected = type("number<=10");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("lessThan", () => {
		const T = type("number").lessThan(10);
		const Expected = type("number<10");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid max operand", () => {
		expect(() => type("string").lessThan(5)).toThrow();
	});

	it("atLeastLength", () => {
		const T = type("string").atLeastLength(5);
		const Expected = type("string>=5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("moreThanLength", () => {
		const T = type("string[]").moreThanLength(5);
		const Expected = type("string[]>5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid minLength operand", () => {
		expect(() => type("bigint").atLeastLength(5)).toThrow();
	});

	it("atMostLength", () => {
		const T = type("string").atMostLength(10);
		const Expected = type("string<=10");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("lessThanLength", () => {
		const T = type("string[]").lessThanLength(10);
		const Expected = type("string[]<10");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid maxLength operand", () => {
		expect(() => type("null").lessThanLength(5)).toThrow();
	});

	it("atOrAfter", () => {
		const T = type("Date").atOrAfter(new Date("2022-01-01"));
		// widen the input to a string so both are non-narrowed
		const Expected = type(`Date>=d'${"2022-01-01" as string}'`);
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("laterThan", () => {
		const T = type("Date").laterThan(new Date("2022-01-01"));
		const Expected = type(`Date>d'${"2022-01-01" as string}'`);
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid after operand", () => {
		expect(() => type("false").laterThan(new Date())).toThrow();
	});

	it("atOrBefore", () => {
		const T = type("Date").atOrBefore(5);
		const Expected = type("Date<=5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("earlierThan", () => {
		const T = type("Date").earlierThan(5);
		const Expected = type("Date<5");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid before operand", () => {
		expect(() => type("unknown").atOrBefore(new Date())).toThrow();
	});
});

it("unit overlap", () => {
	const five = type("5 <= number < 10").and("0 < number <= 5");
	expect(five.allows(5)).toBe(true);
});
