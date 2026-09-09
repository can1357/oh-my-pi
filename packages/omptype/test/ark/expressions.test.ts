import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("tuple expressions", () => {
	it("nested", () => {
		const T = type(["string|bigint", "|", ["number", "|", "boolean"]]);
		const _1: Eq<typeof T.infer, string | number | bigint | boolean> = true;
	});

	it.todo("autocompletion");

	it("missing right operand", () => {
		expect(() => type(["string", "|"])).toThrow();
		expect(() => type(["string", "&"])).toThrow();
		expect(() => type(["string", "|>"])).toThrow();
	});

	it("nested parse error", () => {
		expect(() => {
			type(["string", "|", "numbr"]);
		}).toThrow();
	});

	it("nested object parse error", () => {
		expect(() => {
			type([{ s: "strng" }, "|", "number"]);
		}).toThrow();
	});
});

describe("root expression", () => {
	it("=== single", () => {
		const T = type("===", 5);
		const _2: Eq<typeof T.infer, 5> = true;
		expect(T.json).toEqual(type("5").json);
	});

	it("=== branches", () => {
		const T = type("===", "foo", "bar", "baz");
		const _3: Eq<typeof T.infer, "foo" | "bar" | "baz"> = true;
		expect(T.json).toEqual([{ unit: "foo" }, { unit: "bar" }, { unit: "baz" }]);
	});

	it("instanceof single", () => {
		const T = type("instanceof", RegExp);
		const _4: Eq<typeof T.infer, RegExp> = true;
		const value = /omptype/;
		expect(T(value)).toBe(value);
		expect(T.allows({})).toBe(false);
	});

	it("instanceof branches", () => {
		const T = type("instanceof", Array, Date);
		const _5: Eq<typeof T.infer, unknown[] | Date> = true;
		const date = new Date();
		const array: unknown[] = [];
		expect(T(date)).toBe(date);
		expect(T(array)).toBe(array);
		expect(T.allows(/not-a-branch/)).toBe(false);
	});

	it("postfix", () => {
		const T = type({ a: "string" }, "[]");
		const _6: Eq<typeof T.infer, { a: string }[]> = true;
		expect(T.json).toEqual(type({ a: "string" }).array().json);
	});

	it("infix", () => {
		const T = type({ a: "string" }, "|", { b: "boolean" });
		const _7: Eq<
			typeof T.infer,
			| {
					a: string;
			  }
			| {
					b: boolean;
			  }
		> = true;

		expect(T.json).toEqual(type({ a: "string" }).or({ b: "boolean" }).json);
	});

	it("morph", () => {
		const T = type({ a: "string" }, "=>", In => ({ b: In.a }));

		expect(T.expression).toEqual("(In: { a: string }) => Out<unknown>");
	});

	it("narrow", () => {
		const T = type({ a: "string" }, ":", (In): In is { a: "foo" } => In.a === "foo");
		const _8: Eq<typeof T.infer, { a: "foo" }> = true;
	});

	it("tuple as second arg", () => {
		// this case is not fundamentally unique but TS has a hard time
		// narrowing tuples in contexts like this
		const T = type("keyof", [{ a: "string" }, "&", { b: "boolean" }]);
		const Expected = type("'a' | 'b'");
		const _9: Eq<typeof T.infer, typeof Expected.infer> = true;
		expect(T.json).toEqual(Expected.json);
	});
});
