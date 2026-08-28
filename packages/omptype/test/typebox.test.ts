import { describe, expect, test } from "bun:test";
import { type } from "../src/type";
import { type Static, Type } from "../src/typebox";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

function valid(schema: (value: unknown) => unknown, value: unknown): boolean {
	return !(schema(value) instanceof type.errors);
}

describe("TypeBox adapter", () => {
	test("primitive, literal, union, enum, nullable and never builders validate", () => {
		expect(valid(Type.String(), "x")).toBe(true);
		expect(valid(Type.String(), 1)).toBe(false);
		expect(valid(Type.Number(), 1.5)).toBe(true);
		expect(valid(Type.Number(), "1")).toBe(false);
		expect(valid(Type.Integer(), 2)).toBe(true);
		expect(valid(Type.Integer(), 2.5)).toBe(false);
		expect(valid(Type.Boolean(), true)).toBe(true);
		expect(valid(Type.Boolean(), 1)).toBe(false);
		expect(valid(Type.Null(), null)).toBe(true);
		expect(valid(Type.Null(), undefined)).toBe(false);
		expect(valid(Type.Literal("ok"), "ok")).toBe(true);
		expect(valid(Type.Literal("ok"), "no")).toBe(false);
		expect(valid(Type.Union([Type.Literal("a"), Type.Number()]), 3)).toBe(true);
		expect(valid(Type.Union([Type.Literal("a"), Type.Number()]), false)).toBe(false);
		expect(valid(Type.Enum(["red", "blue"] as const), "red")).toBe(true);
		expect(valid(Type.Enum(["red", "blue"] as const), "green")).toBe(false);
		expect(valid(Type.Nullable(Type.String()), null)).toBe(true);
		expect(valid(Type.Nullable(Type.String()), false)).toBe(false);
		expect(valid(Type.Never(), "anything")).toBe(false);
		expect(valid(Type.Any(), { anything: true })).toBe(true);
		expect(valid(Type.Unknown(), Symbol("anything"))).toBe(true);
		expect(valid(Type.Unsafe({ type: "string" }), 42)).toBe(true);
	});

	test("string and number constraints validate", () => {
		const string = Type.String({ minLength: 2, maxLength: 4, pattern: "^[a-z]+$", format: "email" });
		expect(valid(string, "a@b.co")).toBe(false);
		const pattern = Type.String({ minLength: 2, maxLength: 4, pattern: "^[a-z]+$" });
		expect(valid(pattern, "ab")).toBe(true);
		expect(valid(pattern, "a")).toBe(false);
		expect(valid(pattern, "ABCDE")).toBe(false);
		expect(valid(pattern, "a1")).toBe(false);
		expect(valid(Type.String({ format: "email" }), "a@b.co")).toBe(true);
		expect(valid(Type.String({ format: "email" }), "nope")).toBe(false);
		expect(Type.String({ format: "url" }).toJsonSchema()).toEqual({ type: "string", format: "uri" });
		expect(Type.String({ pattern: "^[a-z]+$", format: "email" }).toJsonSchema()).toEqual({
			type: "string",
			pattern: "^[a-z]+$",
			format: "email",
		});

		const number = Type.Number({ minimum: 1, maximum: 10, multipleOf: 2 });
		expect(valid(number, 4)).toBe(true);
		expect(valid(number, 0)).toBe(false);
		expect(valid(number, 3)).toBe(false);
		expect(number.toJsonSchema()).toEqual({ type: "number", minimum: 1, maximum: 10, multipleOf: 2 });
		const exclusive = Type.Number({ exclusiveMinimum: 1, exclusiveMaximum: 3 });
		expect(valid(exclusive, 2)).toBe(true);
		expect(valid(exclusive, 1)).toBe(false);
		expect(valid(exclusive, 3)).toBe(false);
		expect(exclusive.toJsonSchema()).toEqual({ type: "number", exclusiveMinimum: 1, exclusiveMaximum: 3 });

		const minOnly = Type.Integer({ minimum: 1 });
		expect(valid(minOnly, 1)).toBe(true);
		expect(valid(minOnly, 0)).toBe(false);
		expect(valid(minOnly, 1.5)).toBe(false);
		expect(minOnly.toJsonSchema()).toEqual({ type: "integer", minimum: 1 });
		const exclusiveMinOnly = Type.Number({ exclusiveMinimum: 0 });
		expect(valid(exclusiveMinOnly, 0)).toBe(false);
		expect(valid(exclusiveMinOnly, 0.5)).toBe(true);
		const maxOnly = Type.Number({ maximum: 5 });
		expect(valid(maxOnly, 5)).toBe(true);
		expect(valid(maxOnly, 6)).toBe(false);
		const minWithMultiple = Type.Integer({ minimum: 1, multipleOf: 2 });
		expect(valid(minWithMultiple, 4)).toBe(true);
		expect(valid(minWithMultiple, 3)).toBe(false);
		expect(valid(minWithMultiple, 0)).toBe(false);
	});

	test("arrays, tuples, objects, records and intersections validate", () => {
		const array = Type.Array(Type.Number(), { minItems: 1, maxItems: 3, uniqueItems: true });
		expect(valid(array, [1, 2])).toBe(true);
		expect(valid(array, [])).toBe(false);
		expect(valid(array, [1, 1])).toBe(false);
		expect(valid(array, [1, "2"])).toBe(false);

		const tuple = Type.Tuple([Type.String(), Type.Number()] as const);
		expect(valid(tuple, ["x", 1])).toBe(true);
		expect(valid(tuple, ["x"])).toBe(false);
		expect(valid(tuple, ["x", "1"])).toBe(false);

		const object = Type.Object(
			{ name: Type.String(), age: Type.Optional(Type.Integer()) },
			{ additionalProperties: false },
		);
		expect(valid(object, { name: "Ada" })).toBe(true);
		expect(valid(object, { name: "Ada", age: 37 })).toBe(true);
		expect(valid(object, { age: 37 })).toBe(false);
		expect(valid(object, { name: "Ada", extra: true })).toBe(false);
		const indexed = Type.Object({ known: Type.Number() }, { additionalProperties: Type.Number() });
		expect(valid(indexed, { known: 1, extra: 2 })).toBe(true);
		expect(valid(indexed, { known: 1, extra: "bad" })).toBe(false);

		const record = Type.Record(Type.String({ pattern: "^[a-z]+$" }), Type.Number());
		expect(valid(record, { a: 1, b: 2 })).toBe(true);
		expect(valid(record, { A: 1 })).toBe(false);
		expect(valid(record, { a: "1" })).toBe(false);

		const intersection = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]);
		expect(valid(intersection, { a: "x", b: 1 })).toBe(true);
		expect(valid(intersection, { a: "x" })).toBe(false);
	});

	test("object transforms preserve property validation", () => {
		const base = Type.Object({ a: Type.String(), b: Type.Number() }, { additionalProperties: false });
		expect(valid(Type.Partial(base), {})).toBe(true);
		expect(valid(Type.Partial(base), { a: 1 })).toBe(false);
		expect(valid(Type.Pick(base, ["a"] as const), { a: "x" })).toBe(true);
		expect(valid(Type.Pick(base, ["a"] as const), { b: 1 })).toBe(false);
		expect(valid(Type.Omit(base, ["b"] as const), { a: "x" })).toBe(true);
		const composite = Type.Composite([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]);
		expect(valid(composite, { a: "x", b: 1 })).toBe(true);
		expect(valid(composite, { a: "x" })).toBe(false);
		expect(Type.Readonly(base)).toBe(base);
	});

	test("metadata and object JSON Schema are emitted", () => {
		const schema = Type.Object(
			{
				name: Type.String({ description: "Display name" }),
				nick: Type.Optional(Type.String()),
				score: Type.Number({ default: 0 }),
			},
			{ description: "A person", additionalProperties: false },
		);
		expect(schema({ name: "Ada" })).toEqual({ name: "Ada", score: 0 });
		expect(schema.toJsonSchema()).toEqual({
			type: "object",
			properties: {
				name: { type: "string", description: "Display name" },
				nick: { type: "string" },
				score: { type: "number", default: 0 },
			},
			required: ["name"],
			additionalProperties: false,
			description: "A person",
		});
	});

	test("legacy validation helpers are non-enumerable and return compatibility results", () => {
		const schema = Type.Object({ name: Type.String(), score: Type.Number({ default: 1 }) });
		expect(schema.safeParse({ name: "Ada" })).toEqual({
			success: true,
			data: { name: "Ada", score: 1 },
		});
		const failure = schema.safeParse({ name: 42 });
		expect(failure.success).toBe(false);
		if (!failure.success) expect(failure.error.message).toContain("name");

		expect(schema.__validator({ name: "Ada" })).toEqual({ name: "Ada", score: 1 });
		const validationFailure = schema.__validator({});
		expect(validationFailure).toEqual({ message: expect.any(String) });
		expect(Object.keys(schema)).not.toContain("safeParse");
		expect(Object.keys(schema)).not.toContain("__validator");
		expect(Object.getOwnPropertyDescriptor(schema, "safeParse")?.enumerable).toBe(false);
		expect(Object.getOwnPropertyDescriptor(schema, "__validator")?.enumerable).toBe(false);
	});

	test("Static infers builder outputs", () => {
		const literal = Type.Literal("yes");
		const tuple = Type.Tuple([Type.String(), Type.Number()] as const);
		const object = Type.Object({ id: Type.Number(), label: Type.Optional(Type.String()) });
		type _Literal = Assert<Eq<Static<typeof literal>, "yes">>;
		type _Tuple = Assert<Eq<Static<typeof tuple>, [string, number]>>;
		type ExpectedObject = { id: number } & { label?: string };
		type _Object = Assert<Eq<Static<typeof object>, ExpectedObject>>;
		expect(valid(object, { id: 1 })).toBe(true);
	});
});
