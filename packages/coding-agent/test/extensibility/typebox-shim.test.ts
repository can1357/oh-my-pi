import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { isValidJsonSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { type TSchema, Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";

/**
 * Exercise the legacy `__validator` failure-marker contract independently of
 * the facade's `safeParse` helper.
 */
function safeParse(schema: TSchema, value: unknown): { success: boolean; data?: unknown } {
	const result = schema.__validator(value);
	if (result && typeof result === "object" && "message" in result) {
		return { success: false };
	}
	return { success: true, data: result };
}

describe("pi.typebox compatibility shim", () => {
	it("rejects extra properties when additionalProperties is false", () => {
		const schema = Type.Object({ path: Type.String() }, { additionalProperties: false });

		expect(safeParse(schema, { path: "README.md" }).success).toBe(true);
		expect(safeParse(schema, { path: "README.md", mode: "delete" }).success).toBe(false);
	});

	it("preserves and enforces raw JSON Schema wrapped with Type.Unsafe", () => {
		const rawSchema = {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		};
		const schema = Type.Unsafe<{ path: string }>(rawSchema);
		const tool: Tool = { name: "unsafe-schema", description: "", parameters: schema };
		const validArgs = { path: "README.md" };

		expect(schema.__validator(validArgs)).toBe(validArgs);
		expect(schema.safeParse({}).success).toBe(false);
		const composed = Type.Object({ input: schema });
		expect(composed.safeParse({ input: validArgs }).success).toBe(true);
		expect(composed.safeParse({ input: {} }).success).toBe(false);
		expect(toolWireSchema(tool)).toEqual(rawSchema);
		expect(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "valid",
				name: tool.name,
				arguments: validArgs,
			}),
		).toEqual(validArgs);
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "invalid",
				name: tool.name,
				arguments: {},
			}),
		).toThrow('Validation failed for tool "unsafe-schema"');
	});

	it("composes optional Type.Unsafe schemas without making sibling properties required", () => {
		const schema = Type.Object({
			kind: Type.Unsafe({ type: "string", enum: ["question"] }),
			mode: Type.Optional(Type.Unsafe({ type: "string", enum: ["overlay", "inline"] })),
			label: Type.Optional(Type.String()),
		});

		const document = schema.toJsonSchema();
		expect(document.required).toEqual(["kind"]);
		expect(document).toMatchObject({
			properties: {
				mode: { type: "string", enum: ["overlay", "inline"] },
				label: { type: "string" },
			},
		});
		expect(schema.safeParse({ kind: "question", mode: "overlay" }).success).toBe(true);
		expect(schema.safeParse({ kind: "question", mode: "other" }).success).toBe(false);
	});

	it("preserves nested Type.Unsafe keywords fromJsonSchema cannot lower", () => {
		const raw = Type.Unsafe({
			type: "object",
			properties: { a: { type: "string" } },
			patternProperties: { "^x-": { type: "number" } },
			additionalProperties: false,
		});
		const nested = {
			type: "object",
			properties: { a: { type: "string" } },
			patternProperties: { "^x-": { type: "number" } },
			additionalProperties: false,
		};

		// The wire schema must keep patternProperties even when the Unsafe schema
		// is embedded inside Type.Object / Type.Optional — a `.toJsonSchema`
		// method override would vanish at these nested positions.
		expect((Type.Object({ cfg: raw }).toJsonSchema().properties as Record<string, unknown>).cfg).toEqual(nested);
		expect(
			(Type.Object({ cfg: Type.Optional(raw) }).toJsonSchema().properties as Record<string, unknown>).cfg,
		).toEqual(nested);

		// Runtime validation still enforces the nested keyword.
		const object = Type.Object({ cfg: raw });
		expect(object.safeParse({ cfg: { a: "ok", "x-n": 3 } }).success).toBe(true);
		expect(object.safeParse({ cfg: { a: "ok", "x-n": "bad" } }).success).toBe(false);
	});

	it("applies schema-valued additionalProperties only to undeclared raw-object keys", () => {
		const schema = Type.Object(
			{ known: { type: "number" } as unknown as TSchema },
			{ additionalProperties: { type: "string" } as unknown as TSchema },
		);

		expect(schema.safeParse({ known: 1, extra: "ok" }).success).toBe(true);
		expect(schema.safeParse({ known: "bad", extra: "ok" }).success).toBe(false);
		expect(schema.safeParse({ known: 1, extra: 2 }).success).toBe(false);
		expect(schema.toJsonSchema()).toEqual({
			type: "object",
			properties: { known: { type: "number" } },
			required: ["known"],
			additionalProperties: { type: "string" },
		});
	});

	it("validates Type.Unsafe draft-07 documents like the wire path", () => {
		const schema = Type.Unsafe({
			type: "object",
			properties: { xs: { type: "array", items: [{ type: "string" }] } },
			required: ["xs"],
		});

		expect(schema.safeParse({ xs: ["a"] }).success).toBe(true);
		expect(schema.safeParse({ xs: [1] }).success).toBe(false);
		expect(schema.safeParse({}).success).toBe(false);
	});

	it("preserves numeric enum values from TypeScript enum objects", () => {
		const schema = Type.Enum({ 0: "Fast", 1: "Slow", Fast: 0, Slow: 1 });

		expect(safeParse(schema, 0).success).toBe(true);
		expect(safeParse(schema, 1).success).toBe(true);
		expect(safeParse(schema, "Fast").success).toBe(false);
	});

	it("enforces and emits uniqueItems for arrays", () => {
		const schema = Type.Array(Type.String(), { uniqueItems: true });
		const wire = toolWireSchema({ name: "files", description: "", parameters: schema });

		expect(safeParse(schema, ["a.ts", "b.ts"]).success).toBe(true);
		expect(safeParse(schema, ["a.ts", "a.ts"]).success).toBe(false);
		expect(wire.uniqueItems).toBe(true);
	});

	it("respects record key schemas", () => {
		const schema = Type.Record(Type.Literal("target"), Type.String());

		expect(safeParse(schema, { target: "ok" }).success).toBe(true);
		expect(safeParse(schema, { other: "bad" }).success).toBe(false);
	});

	it("merges every object passed to Composite", () => {
		const schema = Type.Composite([
			Type.Object({ a: Type.String() }),
			Type.Object({ b: Type.String() }),
			Type.Object({ c: Type.String() }),
		]);

		expect(safeParse(schema, { a: "a", b: "b", c: "c" }).success).toBe(true);
		expect(safeParse(schema, { a: "a", b: "b" }).success).toBe(false);
	});

	it("applies minLength on top of a string format", () => {
		const schema = Type.String({ format: "email", minLength: 20 });

		expect(safeParse(schema, "a@b.co").success).toBe(false);
		expect(safeParse(schema, "longer-address@example.com").success).toBe(true);
	});

	it("applies pattern on top of a url format", () => {
		const schema = Type.String({ format: "url", pattern: "^https://" });

		expect(safeParse(schema, "http://example.com").success).toBe(false);
		expect(safeParse(schema, "https://example.com").success).toBe(true);
	});

	it("preserves unknown properties by default on Type.Object", () => {
		const schema = Type.Object({ a: Type.String() });
		const parsed = safeParse(schema, { a: "x", extra: 1 });

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data as { extra?: unknown }).extra).toBe(1);
		}
	});
	// Callable omptype schemas intentionally have no enumerable JSON Schema
	// keywords. Wire serialization consumes their explicit JSON Schema emitter.
	describe("toJsonSchema produces valid wire JSON Schema", () => {
		it("emits clean JSON Schema for a complex object", () => {
			const schema = Type.Object({
				direction: Type.Enum({ upstream: "upstream", downstream: "downstream" }),
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
				tags: Type.Array(Type.String()),
			});
			const round = schema.toJsonSchema();
			expect(isValidJsonSchema(round)).toBe(true);
			// No raw Zod internals leak through.
			expect(round).not.toHaveProperty("_zod");
			expect(round).not.toHaveProperty("def");
			expect(round.type).toBe("object");
		});

		it("emits valid JSON Schema for composition operators", () => {
			const base = Type.Object({ a: Type.String(), b: Type.Number() });
			for (const schema of [
				Type.Partial(base),
				Type.Required(base),
				Type.Pick(base, ["a"]),
				Type.Omit(base, ["a"]),
				Type.Composite([base, Type.Object({ c: Type.Boolean() })]),
			]) {
				const round = schema.toJsonSchema();
				expect(isValidJsonSchema(round)).toBe(true);
				expect(round).not.toHaveProperty("_zod");
			}
		});
	});

	// Issue #8420: legacy extensions build raw documents that embed omptype
	// schema builders. Those builders are callable values, so a document that
	// nests or spreads them is neither structured-cloneable nor a plain TypeBox
	// object; `Type.Unsafe` must lower them to wire JSON before use.
	describe("lowers embedded omptype schemas inside Type.Unsafe documents", () => {
		it("embeds sibling schema builders in an anyOf branch", () => {
			const item = Type.Object({ agent: Type.String() });
			const template = Type.Object({ agent: Type.String() }, { additionalProperties: false });
			const schema = Type.Unsafe({
				anyOf: [Type.Array(item, { minItems: 1 }), template],
				description: "static array or single template",
			});

			const document = schema.toJsonSchema();
			expect(() => structuredClone(document)).not.toThrow();
			expect(document).toEqual({
				anyOf: [
					{
						type: "array",
						minItems: 1,
						items: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
					},
					{
						type: "object",
						properties: { agent: { type: "string" } },
						required: ["agent"],
						additionalProperties: false,
					},
				],
				description: "static array or single template",
			});
			expect(schema.safeParse([{ agent: "scout" }]).success).toBe(true);
			expect(schema.safeParse({ agent: "scout" }).success).toBe(true);
			expect(schema.safeParse(42).success).toBe(false);
		});

		it("preserves a legitimate run property containing a schema builder", () => {
			const schema = Type.Unsafe({
				type: "object",
				properties: { run: Type.Boolean() },
				required: ["run"],
				additionalProperties: false,
			});

			expect(schema.toJsonSchema()).toEqual({
				type: "object",
				properties: { run: { type: "boolean" } },
				required: ["run"],
				additionalProperties: false,
			});
			expect(schema.safeParse({ run: true }).success).toBe(true);
			expect(schema.safeParse(true).success).toBe(false);
		});

		it("preserves wire-only constraints on embedded schema builders", () => {
			const schema = Type.Unsafe({
				type: "object",
				properties: {
					code: Type.String({ pattern: "^x" }),
					count: Type.Number({ multipleOf: 2 }),
				},
				required: ["code", "count"],
				additionalProperties: false,
			});

			expect(schema.toJsonSchema()).toEqual({
				type: "object",
				properties: {
					code: { type: "string", pattern: "^x" },
					count: { type: "number", multipleOf: 2 },
				},
				required: ["code", "count"],
				additionalProperties: false,
			});
			expect(schema.safeParse({ code: "xray", count: 4 }).success).toBe(true);
			expect(schema.safeParse({ code: "bad", count: 4 }).success).toBe(false);
			expect(schema.safeParse({ code: "xray", count: 3 }).success).toBe(false);
		});

		it("recovers the wire schema when a builder is spread into a new document", () => {
			const base = Type.Unsafe({
				anyOf: [
					{ type: "object", additionalProperties: true },
					{ type: "boolean", enum: [false] },
				],
			});
			// `{ ...base, description }` copies omptype's internal fields, not JSON
			// keywords; the shim must recover `anyOf` from the copied self-reference
			// and overlay the caller's added `description`.
			const schema = Type.Unsafe({ ...base, description: "mission object or false" });

			expect(schema.toJsonSchema()).toEqual({
				anyOf: [
					{ type: "object", additionalProperties: true },
					{ type: "boolean", enum: [false] },
				],
				description: "mission object or false",
			});
			expect(schema.safeParse(false).success).toBe(true);
			expect(schema.safeParse({ objective: "ship" }).success).toBe(true);
			expect(schema.safeParse("nope").success).toBe(false);
		});
	});
});
