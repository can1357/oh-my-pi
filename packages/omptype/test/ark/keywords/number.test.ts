import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("integer", () => {
	const Integer = type("number.integer");
	expect(Integer(123)).toEqual(123);
	expect(String(Integer("123"))).toBe('must be an integer (was "123")');
	expect(String(Integer(12.12))).toBe("must be an integer (was 12.12)");
});

it("epoch", () => {
	const Epoch = type("number.epoch");

	// valid
	expect(Epoch(1621530000)).toEqual(1621530000);
	expect(Epoch(8640000000000000)).toEqual(8640000000000000);
	expect(Epoch(-8640000000000000)).toEqual(-8640000000000000);

	// invalid
	expect(String(Epoch("foo"))).toBe("must be a number representing a Unix timestamp (was a string)");
	expect(String(Epoch(1.5))).toBe("must be an integer representing a Unix timestamp (was 1.5)");
	expect(String(Epoch(-8640000000000001))).toBe(
		"must be a Unix timestamp after -8640000000000000 (was -8640000000000001)",
	);
	expect(String(Epoch(8640000000000001))).toBe(
		"must be a Unix timestamp before 8640000000000000 (was 8640000000000001)",
	);
});

it("safe", () => {
	const Safe = type("number.safe");

	expect(Safe.allows(Number.MAX_SAFE_INTEGER)).toEqual(true);
	expect(Safe.allows(Number.MIN_SAFE_INTEGER)).toEqual(true);
	expect(Safe.allows(0)).toEqual(true);
	expect(Safe.allows(0.5)).toEqual(true);
	expect(String(Safe(Number.MAX_SAFE_INTEGER + 1))).toBe("must be at most 9007199254740991 (was 9007199254740992)");
	expect(String(Safe(Number.MIN_SAFE_INTEGER - 1))).toBe("must be at least -9007199254740991 (was -9007199254740992)");
	expect(String(Safe(Infinity))).toBe("must be at most 9007199254740991 (was Infinity)");
	expect(String(Safe(-Infinity))).toBe("must be at least -9007199254740991 (was -Infinity)");
	expect(String(Safe(NaN))).toBe("must be a number (was NaN)");
});

it("doesn't allow NaN by default", () => {
	expect(type.number.allows(Number.NaN)).toEqual(false);
	expect(String(type.number(Number.NaN))).toBe("must be a number (was NaN)");
});

it("NaN", () => {
	const Nan = type("number.NaN");

	expect(Nan.allows(Number.NaN)).toEqual(true);
	expect(String(Nan(0))).toBe("must be NaN (was 0)");
});

it("PositiveInfinity", () => {
	const Inf = type("number.Infinity");
	expect(Inf.allows(Number.POSITIVE_INFINITY)).toEqual(true);
	expect(String(Inf(0))).toBe("must be Infinity (was 0)");
	expect(String(Inf(Number.NEGATIVE_INFINITY))).toBe("must be Infinity (was -Infinity)");
});

it("NegativeInfinity", () => {
	const NegInf = type("number.NegativeInfinity");
	expect(NegInf.allows(Number.NEGATIVE_INFINITY)).toEqual(true);
	expect(String(NegInf(0))).toBe("must be -Infinity (was 0)");
	expect(String(NegInf(Number.POSITIVE_INFINITY))).toBe("must be -Infinity (was Infinity)");
});
