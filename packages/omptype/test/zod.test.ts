import { describe, expect, it } from "bun:test";
import { OmpTypeError } from "../src/errors";
import { Type, type } from "../src/type";
import * as zod from "../src/zod";
import { z } from "../src/zod";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const typedUser = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	score: z.number().optional().default(10),
	tags: z.array(z.string()),
});
type _UserInference = Assert<
	Eq<z.infer<typeof typedUser>, { name: string; nickname?: string | undefined; score: number; tags: string[] }>
>;
const optionalText = z.string().optional();
type _OptionalInference = Assert<Eq<z.infer<typeof optionalText>, string | undefined>>;
const transformed = z.string().transform(value => value.length);
type _TransformInference = Assert<Eq<z.infer<typeof transformed>, number>>;
const nullableOptional = z.number().nullable().optional();
type _NullableOptionalInference = Assert<Eq<z.infer<typeof nullableOptional>, number | null | undefined>>;

describe("zod-like parsing", () => {
	it("exposes callable omptype schemas with JSON Schema metadata", () => {
		const text = z.string().min(1);
		const schema = z.object({
			name: z.string().default("Ada"),
			website: z.string().url().describe("Public profile").optional(),
		});
		for (const candidate of [z.string(), text, schema]) {
			expect(typeof candidate).toBe("function");
			expect(candidate).toBeInstanceOf(Type);
			expect(typeof candidate.toJsonSchema).toBe("function");
			expect(typeof candidate.assert).toBe("function");
		}
		expect(schema({ website: "https://omp.sh" })).toEqual({
			name: "Ada",
			website: "https://omp.sh",
		});
		expect(schema({ website: 42 })).toBeInstanceOf(type.errors);
		expect(schema.toJsonSchema()).toEqual({
			type: "object",
			properties: {
				name: { type: "string", default: "Ada" },
				website: { type: "string", format: "uri", description: "Public profile" },
			},
		});
		expect(zod.object({ value: zod.string() }).parse({ value: "top-level export" })).toEqual({
			value: "top-level export",
		});
	});

	it("parses valid values and reports nested safeParse issues", () => {
		const schema = z.object({ profile: z.object({ age: z.number().int().positive() }) });
		expect(schema.parse({ profile: { age: 42 } })).toEqual({ profile: { age: 42 } });

		const result = schema.safeParse({ profile: { age: -1 } });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).toContain("profile.age");
			expect(result.error.issues).toHaveLength(1);
			expect(result.error.issues[0]?.path).toEqual(["profile", "age"]);
			expect(result.error.issues[0]?.message).toContain("must be");
		}
		expect(() => schema.parse({ profile: { age: "old" } })).toThrow("profile.age");
	});

	it("supports optional properties, defaults, and object key modes", () => {
		const base = z.object({
			name: z.string(),
			nickname: z.string().optional(),
			score: z.number().default(7),
		});
		expect(base.parse({ name: "Ada", ignored: true })).toEqual({ name: "Ada", score: 7 });
		expect(base.parse({ name: "Ada", nickname: undefined })).toEqual({
			name: "Ada",
			nickname: undefined,
			score: 7,
		});
		expect(z.string().default("fallback").parse(undefined)).toBe("fallback");
		expect(base.strict().safeParse({ name: "Ada", extra: 1 }).success).toBe(false);
		expect(base.passthrough().parse({ name: "Ada", extra: 1 })).toEqual({ name: "Ada", score: 7, extra: 1 });
		expect(base.strip().parse({ name: "Ada", extra: 1 })).toEqual({ name: "Ada", score: 7 });
		expect(z.object({ left: z.string(), right: z.number() }).partial().parse({ left: "x" })).toEqual({ left: "x" });
	});

	it("refines, transforms, and catches every invalid inner result", () => {
		const evenLength = z
			.string()
			.refine(value => value.length % 2 === 0, "an even-length string")
			.transform(value => value.length);
		expect(evenLength.parse("four")).toBe(4);
		const invalid = evenLength.safeParse("odd");
		expect(invalid.success).toBe(false);
		if (!invalid.success) expect(invalid.error.issues[0]?.message).toContain("an even-length string");

		const resilient = z
			.number()
			.positive()
			.transform(value => value * 2)
			.catch(12);
		expect(resilient.parse(3)).toBe(6);
		expect(resilient.parse(-3)).toBe(12);
		expect(resilient.parse("bad")).toBe(12);
		expect(resilient.safeParse("bad")).toEqual({ success: true, data: 12 });
		const catchesThrownTransform = z
			.string()
			.transform((): string => {
				throw new Error("boom");
			})
			.catch("recovered");
		expect(() => catchesThrownTransform.parse("x")).not.toThrow();
		expect(catchesThrownTransform.parse("x")).toBe("recovered");
	});

	it("supports literals, enums, and unions", () => {
		const status = z.enum(["queued", "done"] as const);
		expect(status.parse("queued")).toBe("queued");
		expect(status.safeParse("failed").success).toBe(false);

		const choice = z.union([z.literal("auto"), z.number()] as const);
		expect(choice.parse("auto")).toBe("auto");
		expect(choice.parse(3)).toBe(3);
		expect(choice.safeParse(false).success).toBe(false);
		expect(z.literal(null).parse(null)).toBeNull();
	});

	it("dispatches min and max by string, number, and array kind", () => {
		const text = z.string().min(2).max(4);
		expect(text.parse("good")).toBe("good");
		expect(text.safeParse("x").success).toBe(false);
		expect(text.safeParse("lengthy").success).toBe(false);

		const amount = z.number().min(2).max(4);
		expect(amount.parse(3)).toBe(3);
		expect(amount.safeParse(1).success).toBe(false);
		expect(amount.safeParse(5).success).toBe(false);
		expect(z.number().min(3).min(2).safeParse(2.5).success).toBe(false);
		expect(z.number().max(3).max(4).safeParse(3.5).success).toBe(false);
		expect(z.number().min(3).positive().safeParse(2).success).toBe(false);

		const list = z.array(z.boolean()).min(1).max(2);
		expect(list.parse([true, false])).toEqual([true, false]);
		expect(list.safeParse([]).success).toBe(false);
		expect(list.safeParse([true, false, true]).success).toBe(false);
		expect(() => z.boolean().min(1)).toThrow(OmpTypeError);
	});

	it("supports string and number refinements plus nullable and optional values", () => {
		expect(z.string().regex(/^omp$/).url().safeParse("omp").success).toBe(false);
		expect(z.string().url().parse("https://omp.sh")).toBe("https://omp.sh");
		expect(z.number().int().nonnegative().parse(0)).toBe(0);
		expect(z.number().int().safeParse(1.5).success).toBe(false);
		expect(z.number().positive().safeParse(0).success).toBe(false);
		expect(nullableOptional.parse(null)).toBeNull();
		expect(nullableOptional.parse(undefined)).toBeUndefined();
	});

	it("validates records with string key and value schemas", () => {
		const env = z.record(z.string().regex(/^[A-Z]+$/), z.string());
		expect(env.parse({ HOME: "/tmp" })).toEqual({ HOME: "/tmp" });
		expect(env.safeParse({ home: "/tmp" }).success).toBe(false);
		expect(env.safeParse({ HOME: 1 }).success).toBe(false);
		expect(() => z.record(z.number() as never, z.string())).toThrow(OmpTypeError);
		const flags = z.record(z.enum(["A", "B"] as const), z.boolean());
		expect(flags.parse({ A: true, B: false })).toEqual({ A: true, B: false });
		expect(flags.safeParse({ C: true }).success).toBe(false);
	});
});
