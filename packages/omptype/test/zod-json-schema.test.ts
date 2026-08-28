import { describe, expect, it } from "bun:test";
import * as z from "../src/zod";

/**
 * Every assertion here defends what a provider sees: `toolWireSchema` lowers
 * these schemas to the parameter JSON Schema sent to the model on all 11
 * provider adapters. A combinator that erases its structure ships a tool the
 * model perceives as unconstrained — the failure presents as "the model gets
 * it wrong", so the emitted document, not just parse behaviour, is the
 * contract under test.
 */

interface ObjectSchema {
	type?: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: unknown;
	anyOf?: unknown[];
	$ref?: string;
	$defs?: Record<string, unknown>;
	const?: unknown;
	items?: unknown;
	default?: unknown;
}

const asObjectSchema = (value: unknown): ObjectSchema => value as ObjectSchema;

/** Read one property's emitted subschema. */
const propSchema = (parent: ObjectSchema | undefined, key: string): ObjectSchema | undefined =>
	asObjectSchema(parent?.properties?.[key]);
/** Read an array's emitted item subschema. */
const itemsSchema = (parent: ObjectSchema | undefined): ObjectSchema | undefined => asObjectSchema(parent?.items);
/** Resolve one `$ref` within the emitted document's `$defs`. */
const resolveRef = (document: ObjectSchema, ref: unknown): ObjectSchema | undefined =>
	typeof ref === "string" && ref.startsWith("#/$defs/")
		? asObjectSchema(document.$defs?.[ref.slice("#/$defs/".length)])
		: undefined;

describe("zod shim JSON Schema structure", () => {
	it("keeps first-match dispatcher semantics (and documents the erasure) for overlapping stripping objects", () => {
		// Two plain z.objects both accept overlapping inputs and strip
		// different keys, so omptype's unordered union cannot represent zod's
		// first-match semantics: the native build throws
		// "unordered union ... indeterminate" and the shim must fall back to
		// the ordered dispatcher WITHOUT surfacing the construction error.
		// Failure modes guarded: the naive predicate split crashed here
		// (OmpTypeError at construction); a bare catch would mask real errors.
		const union = z.union([z.object({ name: z.string() }), z.object({ id: z.number() })]);
		expect(union.parse({ name: "x", id: 1 })).toEqual({ name: "x" });
		expect(union.parse({ id: 2 })).toEqual({ id: 2 });
		expect(union.safeParse("nope").success).toBe(false);
		// Documented erasure: the dispatcher morph emits `{}` until a
		// first-class ordered-choice IR node exists (named follow-up).
		expect(union.toJsonSchema()).toEqual({});
	});

	it("emits full anyOf for disjoint strictObject union members", () => {
		const union = z.union([z.strictObject({ name: z.string() }), z.strictObject({ id: z.number() })]);
		const json = asObjectSchema(union.toJsonSchema());
		const variants = json.anyOf as ObjectSchema[];
		expect(variants).toHaveLength(2);
		expect(variants[0]).toMatchObject({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
			additionalProperties: false,
		});
		expect(variants[1]?.properties?.id).toEqual({ type: "number" });
		expect(union.parse({ id: 1 })).toEqual({ id: 1 });
		expect(union.safeParse({ id: 1, name: "x" }).success).toBe(false);
	});

	it("emits anyOf with discriminator consts for z.object discriminated-union variants", () => {
		// Distinct required discriminator literals make the variants disjoint,
		// so the structural union is order-independent and must not fall back
		// to the dispatcher: the model needs the variants and their `const`
		// discriminators to pick one.
		const event = z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("append"), n: z.number() }),
			z.object({ kind: z.literal("gap"), s: z.string() }),
		]);
		const json = asObjectSchema(event.toJsonSchema());
		const variants = json.anyOf as ObjectSchema[];
		expect(variants).toHaveLength(2);
		expect(variants[0]?.properties?.kind).toEqual({ const: "append" });
		expect(variants[1]?.properties?.kind).toEqual({ const: "gap" });
		// Runtime contract unchanged: key stripping preserved, dispatch exact.
		expect(event.parse({ kind: "gap", s: "x", junk: 1 })).toEqual({ kind: "gap", s: "x" });
		expect(event.parse({ kind: "append", n: 1 })).toEqual({ kind: "append", n: 1 });
		expect(event.safeParse({ kind: "nope" }).success).toBe(false);
	});

	it("emits structural anyOf for distinct-literal z.object union members", () => {
		// Disjointness comes from conflicting required literal props (the
		// generic probe, not the strictObject fast path), so this must take
		// the structural path: a dispatcher here would erase the variants.
		const union = z.union([
			z.object({ kind: z.literal("a"), x: z.string() }),
			z.object({ kind: z.literal("b"), y: z.number() }),
		]);
		const json = asObjectSchema(union.toJsonSchema());
		const variants = json.anyOf as ObjectSchema[];
		expect(variants).toHaveLength(2);
		expect(variants[0]?.properties?.kind).toEqual({ const: "a" });
		expect(union.parse({ kind: "b", y: 2, junk: 1 })).toEqual({ kind: "b", y: 2 });
		expect(union.safeParse({ kind: "a", y: 2 }).success).toBe(false);
	});

	it("preserves inner object schemas through nullable, optional, and default widening", () => {
		// The dispatcher morph erases the wrapped member to `{}`; the
		// structural widening union must keep the inner schema visible.
		const nullable = z.object({ inner: z.object({ name: z.string() }).nullable() });
		const nullableJson = asObjectSchema(nullable.toJsonSchema());
		const nullableVariants = propSchema(nullableJson, "inner")?.anyOf as ObjectSchema[];
		expect(nullableVariants[1]).toEqual({ const: null });
		expect(nullable.parse({ inner: null })).toEqual({ inner: null });
		expect(nullable.parse({ inner: { name: "x" } })).toEqual({ inner: { name: "x" } });
		expect(nullable.safeParse({ inner: 4 }).success).toBe(false);

		const optional = z.object({ inner: z.object({ name: z.string() }).optional() });
		const optionalJson = asObjectSchema(optional.toJsonSchema());
		expect(propSchema(optionalJson, "inner")?.properties?.name).toEqual({ type: "string" });
		expect(optional.parse({})).toEqual({});
		expect(optional.parse({ inner: { name: "x" } })).toEqual({ inner: { name: "x" } });

		const defaulted = z.object({ inner: z.object({ name: z.string() }).default(() => ({ name: "d" })) });
		const defaultedJson = asObjectSchema(defaulted.toJsonSchema());
		expect(propSchema(defaultedJson, "inner")?.properties?.name).toEqual({ type: "string" });
		expect(propSchema(defaultedJson, "inner")?.default).toEqual({ name: "d" });
	});

	it("keeps plain object nesting fully structural", () => {
		const nested = z.object({ list: z.array(z.object({ name: z.string() })) });
		const json = asObjectSchema(nested.toJsonSchema());
		const items = itemsSchema(propSchema(json, "list"))?.properties?.name;
		expect(items).toEqual({ type: "string" });
		expect(nested.parse({ list: [{ name: "x" }] })).toEqual({ list: [{ name: "x" }] });
	});
});
