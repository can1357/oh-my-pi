import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("shallow array intersection", () => {
	const T = type("string[]&'foo'[]");
	const Expected = type("'foo'[]");
	expect(T.json).toEqual(Expected.json);
});

it("deep array intersection", () => {
	const T = type([{ a: "string" }, "[]"]).and([{ b: "number" }, "[]"]);
	const Expected = type([{ a: "string", b: "number" }, "[]"]);
	expect(T.json).toEqual(Expected.json);
});

it("tuple intersection", () => {
	const T = type([[{ a: "string" }], "&", [{ b: "boolean" }]]);
	const Expected = type([{ a: "string", b: "boolean" }]);
	const _0: Eq<typeof T, typeof Expected> = true;
	expect(T.json).toEqual(Expected.json);
});

it("tuple and array", () => {
	const TupleAndArray = type([[{ a: "string" }], "&", [{ b: "boolean" }, "[]"]]);
	const ArrayAndTuple = type([[{ b: "boolean" }, "[]"], "&", [{ a: "string" }]]);

	const Expected = type([{ a: "string", b: "boolean" }]);
	const _0: Eq<typeof TupleAndArray, typeof Expected> = true;

	const _1: Eq<typeof ArrayAndTuple, typeof Expected> = true;

	expect(TupleAndArray.json).toEqual(Expected.json);
	expect(ArrayAndTuple.json).toEqual(Expected.json);
});

it("variadic and tuple", () => {
	const B = type([{ b: "boolean" }, "[]"]);
	const T = type([{ a: "string" }, "...", B]).and([{ c: "number" }, { d: "Date" }]);
	const Expected = type([
		{ a: "string", c: "number" },
		{ b: "boolean", d: "Date" },
	]);
	expect(T.json).toEqual(Expected.json);
});

it("variadic and array", () => {
	const B = type({ b: "boolean" }, "[]");
	const T = type([{ a: "string" }, "...", B]).and([{ c: "number" }, "[]"]);
	const Expected = type([{ a: "string", c: "number" }, "...", [{ b: "boolean", c: "number" }, "[]"]]);
	const _0: Eq<typeof T.infer, typeof Expected.infer> = true;
	expect(T.json).toEqual(Expected.json);
});

it("kitchen sink", () => {
	const L = type([{ a: "0" }, [{ b: "1" }, "?"], [{ c: "2" }, "?"], "...", [{ d: "3" }, "[]"]]);
	const R = type([[{ e: "4" }, "?"], [{ f: "5" }, "?"], "...", [{ g: "6" }, "[]"]]);
	const T = L.and(R);

	const Expected = type([
		{ a: "0", e: "4" },
		[{ b: "1", f: "5" }, "?"],
		[{ c: "2", g: "6" }, "?"],
		"...",
		[{ d: "3", g: "6" }, "[]"],
	]);

	expect(T.expression).toBe("[{ a: 0, e: 4 }, { b: 1, f: 5 }?, { c: 2, g: 6 }?, ...{ d: 3, g: 6 }[]]");

	const _0: Eq<typeof T, typeof Expected> = true;
	expect(T.expression).toEqual(Expected.expression);
});

it("prefix and postfix", () => {
	const L = type(["...", [{ a: "0" }, "[]"], { b: "0" }, { c: "0" }]);
	const R = type([{ x: "0" }, { y: "0" }, "...", [{ z: "0" }, "[]"]]);

	const Expected = type([
		{ a: "0", x: "0" },
		{ a: "0", y: "0" },
		"...",
		[{ a: "0", z: "0" }, "[]"],
		{ b: "0", z: "0" },
		{ c: "0", z: "0" },
	])
		.or([
			{ a: "0", x: "0" },
			{ b: "0", y: "0" },
			{ c: "0", z: "0" },
		])
		.or([
			{ b: "0", x: "0" },
			{ c: "0", y: "0" },
		]);

	const lrResult = L.and(R);
	const rlResult = R.and(L);
	const validLong = [
		{ a: 0, x: 0 },
		{ a: 0, y: 0 },
		{ b: 0, z: 0 },
		{ c: 0, z: 0 },
	];
	const validFixed = [
		{ a: 0, x: 0 },
		{ b: 0, y: 0 },
		{ c: 0, z: 0 },
	];
	const validShort = [
		{ b: 0, x: 0 },
		{ c: 0, y: 0 },
	];
	const invalid = [
		{ a: 0, x: 0 },
		{ c: 0, y: 0 },
	];
	for (const schema of [lrResult, rlResult, Expected]) {
		expect(schema.allows(validLong)).toBe(true);
		expect(schema.allows(validFixed)).toBe(true);
		expect(schema.allows(validShort)).toBe(true);
		expect(schema.allows(invalid)).toBe(false);
	}
});

it("reduces minLength", () => {
	const T = type(["number", "number", "...", "number[]", "number"]);
	expect(T.allows([1, 2, 3])).toBe(true);
	expect(T.allows([1, 2])).toBe(false);
	expect(T.allows([1, 2, "3"])).toBe(false);
});

it("array with props", () => {
	const T = type("Array").and({ name: "string" });

	const _0: Eq<
		typeof T.t,
		unknown[] & {
			name: string;
		}
	> = true;

	expect(String(T({ name: "foo" }))).toBe("must be an array (was an object)");
	const arrayWithProps = Object.assign([], { name: "foo" });
	expect(T(arrayWithProps)).toEqual(arrayWithProps);
});

it("shallow array intersection", () => {
	const T = type("string[]&'foo'[]");
	const Expected = type("'foo'[]");
	expect(T.json).toEqual(Expected.json);
});

it("deep array intersection", () => {
	const T = type([{ a: "string" }, "[]"]).and([{ b: "number" }, "[]"]);
	const Expected = type([{ a: "string", b: "number" }, "[]"]);
	expect(T.json).toEqual(Expected.json);
});

it("tuple intersection", () => {
	const T = type([[{ a: "string" }], "&", [{ b: "boolean" }]]);
	const Expected = type([{ a: "string", b: "boolean" }]);
	const _0: Eq<typeof T, typeof Expected> = true;
	expect(T.json).toEqual(Expected.json);
});

it("tuple and array", () => {
	const TupleAndArray = type([[{ a: "string" }], "&", [{ b: "boolean" }, "[]"]]);
	const ArrayAndTuple = type([[{ b: "boolean" }, "[]"], "&", [{ a: "string" }]]);

	const Expected = type([{ a: "string", b: "boolean" }]);
	const _0: Eq<typeof TupleAndArray, typeof Expected> = true;

	const _1: Eq<typeof ArrayAndTuple, typeof Expected> = true;

	expect(TupleAndArray.json).toEqual(Expected.json);
	expect(ArrayAndTuple.json).toEqual(Expected.json);
});

it("variadic and tuple", () => {
	const B = type([{ b: "boolean" }, "[]"]);
	const T = type([{ a: "string" }, "...", B]).and([{ c: "number" }, { d: "Date" }]);
	const Expected = type([
		{ a: "string", c: "number" },
		{ b: "boolean", d: "Date" },
	]);
	expect(T.json).toEqual(Expected.json);
});

it("variadic and array", () => {
	const B = type({ b: "boolean" }, "[]");
	const T = type([{ a: "string" }, "...", B]).and([{ c: "number" }, "[]"]);
	const Expected = type([{ a: "string", c: "number" }, "...", [{ b: "boolean", c: "number" }, "[]"]]);
	const _0: Eq<typeof T.infer, typeof Expected.infer> = true;
	expect(T.json).toEqual(Expected.json);
});

it("kitchen sink", () => {
	const L = type([{ a: "0" }, [{ b: "1" }, "?"], [{ c: "2" }, "?"], "...", [{ d: "3" }, "[]"]]);
	const R = type([[{ e: "4" }, "?"], [{ f: "5" }, "?"], "...", [{ g: "6" }, "[]"]]);
	const T = L.and(R);

	const Expected = type([
		{ a: "0", e: "4" },
		[{ b: "1", f: "5" }, "?"],
		[{ c: "2", g: "6" }, "?"],
		"...",
		[{ d: "3", g: "6" }, "[]"],
	]);

	expect(T.expression).toBe("[{ a: 0, e: 4 }, { b: 1, f: 5 }?, { c: 2, g: 6 }?, ...{ d: 3, g: 6 }[]]");

	const _0: Eq<typeof T, typeof Expected> = true;
	expect(T.expression).toEqual(Expected.expression);
});

it("prefix and postfix", () => {
	const L = type(["...", [{ a: "0" }, "[]"], { b: "0" }, { c: "0" }]);
	const R = type([{ x: "0" }, { y: "0" }, "...", [{ z: "0" }, "[]"]]);

	const Expected = type([
		{ a: "0", x: "0" },
		{ a: "0", y: "0" },
		"...",
		[{ a: "0", z: "0" }, "[]"],
		{ b: "0", z: "0" },
		{ c: "0", z: "0" },
	])
		.or([
			{ a: "0", x: "0" },
			{ b: "0", y: "0" },
			{ c: "0", z: "0" },
		])
		.or([
			{ b: "0", x: "0" },
			{ c: "0", y: "0" },
		]);

	const LrResult = L.and(R);
	const RlResult = R.and(L);
	const validLong = [
		{ a: 0, x: 0 },
		{ a: 0, y: 0 },
		{ b: 0, z: 0 },
		{ c: 0, z: 0 },
	];
	const validFixed = [
		{ a: 0, x: 0 },
		{ b: 0, y: 0 },
		{ c: 0, z: 0 },
	];
	const validShort = [
		{ b: 0, x: 0 },
		{ c: 0, y: 0 },
	];
	const invalid = [
		{ a: 0, x: 0 },
		{ c: 0, y: 0 },
	];
	for (const schema of [LrResult, RlResult, Expected]) {
		expect(schema.allows(validLong)).toBe(true);
		expect(schema.allows(validFixed)).toBe(true);
		expect(schema.allows(validShort)).toBe(true);
		expect(schema.allows(invalid)).toBe(false);
	}
});
