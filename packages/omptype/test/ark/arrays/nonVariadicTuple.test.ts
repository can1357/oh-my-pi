import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("empty", () => {
	const T = type([]);
	const _0: Eq<typeof T.infer, []> = true;
	expect(T([])).toEqual([]);
	expect(String(T([1]))).toBe("must be an array of at most length 0 (was an array)");
});

it("shallow", () => {
	const T = type(["string", "number"]);
	const _0: Eq<typeof T.infer, [string, number]> = true;
	expect(T.allows(["", 0])).toBe(true);
	expect(T(["", 0])).toEqual(["", 0]);
	expect(T.allows([true, 0])).toBe(false);
	expect(String(T([true, 0]))).toBe("[0] must be a string (was boolean)");
	expect(T.allows([0, false])).toBe(false);
	expect(String(T([0, false]))).toBe(`[0] must be a string (was a number)
[1] must be a number (was boolean)`);
	// too short
	expect(T.allows([""])).toBe(false);
	expect(String(T([""]))).toBe("must be an array of at least length 2 (was an array)");
	// too long
	expect(T.allows(["", 0, 1])).toBe(false);
	expect(String(T(["", 0, 1]))).toBe("must be an array of at most length 2 (was an array)");
	// non-array
	expect(
		T.allows({
			length: 2,
			0: "",
			1: 0,
		}),
	).toBe(false);
	expect(
		String(
			T({
				length: 2,
				0: "",
				1: 0,
			}),
		),
	).toBe("must be an array (was an object)");
});

it("nested", () => {
	const T = type([["string", "number"], [{ a: "bigint", b: ["null"] }]]);
	const _0: Eq<
		typeof T.infer,
		[
			[string, number],
			[
				{
					a: bigint;
					b: [null];
				},
			],
		]
	> = true;
	const valid: typeof T.infer = [["", 0], [{ a: 0n, b: [null] }]];
	expect(T.allows(valid)).toBe(true);
	expect(T(valid)).toEqual(valid);
	const invalid = [["", 0], [{ a: 0n, b: [undefined] }]];
	expect(T.allows(invalid)).toBe(false);
	expect(String(T(invalid))).toBe("[1][0].b[0] must be null (was undefined)");
});

it("optional tuple", () => {
	const T = type([["string", "?"]]);
	const _0: Eq<typeof T.infer, [string?]> = true;
	expect(T([])).toEqual([]);
	expect(T(["foo"])).toEqual(["foo"]);
	expect(String(T([5]))).toBe("[0] must be a string (was a number)");
	expect(String(T(["foo", "bar"]))).toBe("must be an array of at most length 1 (was an array)");
});

it("optional string-embedded tuple", () => {
	const T = type(["string?"]);

	const Expected = type([["string", "?"]]);
	const _0: Eq<typeof T, typeof Expected> = true;
	expect(T([])).toEqual([]);
	expect(T(["foo"])).toEqual(["foo"]);
});

it("optional object tuple", () => {
	const T = type([[{ foo: "string" }, "?"], "string?"]);
	const _0: Eq<
		typeof T.t,
		[
			{
				foo: string;
			}?,
			string?,
		]
	> = true;
	expect(T([])).toEqual([]);
	expect(T([{ foo: "bar" }])).toEqual([{ foo: "bar" }]);
});

it("optional nested object tuple", () => {
	const T = type([[[{ foo: "string" }, "?"]], ["string", "?"]]);
	const _0: Eq<
		typeof T.t,
		[
			[
				{
					foo: string;
				}?,
			],
			string?,
		]
	> = true;
	expect(T([[{ foo: "bar" }]])).toEqual([[{ foo: "bar" }]]);
	expect(T([[{ foo: "bar" }], "baz"])).toEqual([[{ foo: "bar" }], "baz"]);
});
