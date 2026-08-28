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
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: unknown;
	anyOf?: unknown[];
	enum?: unknown[];
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

	it("widens objects containing stepped or defaulted properties structurally", () => {
		// The widened union is disjoint from undefined/null unless the member
		// itself accepts them, so these shapes must NOT fall back to the
		// dispatcher: a defaulted enum prop (the shipped api-demo example's
		// exact shape) erased to `{}` before the gate relaxed.
		const apiDemo = z
			.object({
				message: z.string(),
				logLevel: z.enum(["error", "warn", "debug"]).default("debug"),
			})
			.optional();
		const apiDemoJson = asObjectSchema(apiDemo.toJsonSchema());
		const logLevel = propSchema(apiDemoJson, "logLevel");
		expect(logLevel?.enum).toEqual(["error", "warn", "debug"]);
		expect(logLevel?.default).toBe("debug");
		expect(apiDemo.parse(undefined)).toBeUndefined();
		expect(apiDemo.parse({ message: "m", logLevel: "warn" })).toEqual({ message: "m", logLevel: "warn" });

		const stepped = z.object({ v: z.string().transform(value => value.length) }).nullable();
		const steppedJson = asObjectSchema(stepped.toJsonSchema());
		const steppedMember = asObjectSchema((steppedJson.anyOf as ObjectSchema[])[0]);
		expect(propSchema(steppedMember, "v")?.type).toBe("string");
		expect(stepped.parse(null)).toBeNull();
		expect(stepped.parse({ v: "abc" })).toEqual({ v: 3 });

		// A z.lazy property inside the widened object keeps the dispatcher:
		// the determinism probe cannot see through the deferred alias.
		const lazyProp = z.object({ t: z.lazy(() => z.string()) }).optional();
		expect(lazyProp.toJsonSchema()).toEqual({});
		expect(lazyProp.parse({ t: "x" })).toEqual({ t: "x" });
	});

	it("keeps plain object nesting fully structural", () => {
		const nested = z.object({ list: z.array(z.object({ name: z.string() })) });
		const json = asObjectSchema(nested.toJsonSchema());
		const items = itemsSchema(propSchema(json, "list"))?.properties?.name;
		expect(items).toEqual({ type: "string" });
		expect(nested.parse({ list: [{ name: "x" }] })).toEqual({ list: [{ name: "x" }] });
	});

	it("exports required recursive edges and pins optional recursive edges on the dispatcher", () => {
		// The emission boundary for recursion: REQUIRED array/record edges
		// export as $ref; OPTIONAL or NULLABLE recursive edges keep the
		// ordered dispatcher and erase, because the union determinism probe
		// cannot see through a deferred alias. `.optional()` is the common
		// authoring spelling for a recursive edge, so this pins the boundary
		// instead of letting it silently regress or silently widen.
		type LinkedList = { name: string; next?: LinkedList };
		const list: z.ZodType<LinkedList> = z.lazy(() => z.object({ name: z.string(), next: list.optional() }));
		const json = asObjectSchema(list.toJsonSchema());
		const def = resolveRef(json, json.$ref);
		expect(def?.properties?.name).toEqual({ type: "string" });
		expect(def?.properties?.next).toEqual({});
		expect(list.parse({ name: "a", next: { name: "b" } })).toEqual({ name: "a", next: { name: "b" } });
		expect(list.parse({ name: "a" })).toEqual({ name: "a" });
	});
});

describe("z.lazy deferred alias", () => {
	it("constructs and parses directly self-referential schemas without TDZ", () => {
		// Regression: construction-time scans resolved the alias eagerly, so a
		// getter closing over the const being defined threw
		// "Cannot access 'jsonValue' before initialization".
		type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
		const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
			z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
		);
		const deep = { b: [2, { c: "d" }] };
		expect(jsonValue.parse(["a", 1, true, null, deep])).toEqual(["a", 1, true, null, deep]);
		expect(jsonValue.safeParse([() => {}]).success).toBe(false);
	});

	it("emits self-consistent $ref/$defs for plainly nested recursive schemas", () => {
		// Regression: lazy used to be a runtime morph, so a recursive
		// parameter schema reached the model as an unconstrained `{}`. The
		// emitted document must carry real definitions and every `$ref` must
		// resolve within them.
		type Tree = { name: string; children?: Tree[] };
		const tree: z.ZodType<Tree> = z.lazy(() => z.object({ name: z.string(), children: z.array(tree) }));
		const json = asObjectSchema(tree.toJsonSchema());
		const def = resolveRef(json, json.$ref);
		expect(def?.properties?.name).toEqual({ type: "string" });
		const children = asObjectSchema(def?.properties?.children);
		// The self-reference cycles back through the same definition instead
		// of recursing — this terminating is the point of the assertion.
		expect(resolveRef(json, asObjectSchema(children.items)?.$ref)).toBe(def);
		expect(tree.parse({ name: "a", children: [{ name: "b", children: [{ name: "c", children: [] }] }] })).toEqual({
			name: "a",
			children: [{ name: "b", children: [{ name: "c", children: [] }] }],
		});
	});

	it("invokes the getter exactly once across parses and exports", () => {
		// A re-invoking getter would rebuild the IR per parse and silently
		// kill throughput; memoization is part of the contract.
		let calls = 0;
		const schema = z.lazy(() => {
			calls++;
			return z.object({ v: z.string() });
		});
		schema.parse({ v: "a" });
		schema.parse({ v: "b" });
		const exported = asObjectSchema(schema.toJsonSchema());
		expect(resolveRef(exported, exported.$ref)).toBeDefined();
		expect(calls).toBe(1);
	});

	it("gives distinct lazies distinct $defs entries", () => {
		// Regression: a fixed "$defs" key made one lazy silently win the
		// collision and the other $ref dangle.
		const a = z.lazy(() => z.object({ x: z.string() }));
		const b = z.lazy(() => z.object({ y: z.number() }));
		const both = z.object({ a, b });
		const json = asObjectSchema(both.toJsonSchema());
		const refA = asObjectSchema(json.properties?.a)?.$ref;
		const refB = asObjectSchema(json.properties?.b)?.$ref;
		expect(typeof refA).toBe("string");
		expect(refB).not.toBe(refA);
		expect(resolveRef(json, refA)?.properties?.x).toEqual({ type: "string" });
		expect(resolveRef(json, refB)?.properties?.y).toEqual({ type: "number" });
		expect(both.parse({ a: { x: "1" }, b: { y: 2 } })).toEqual({ a: { x: "1" }, b: { y: 2 } });
	});

	it("keeps pipeline-unknown lazies on the ordered dispatcher without changing runtime", () => {
		// Conservative consequence of deferral: a union whose members may
		// carry unseen morphs must not become an unordered native union (the
		// determinism check cannot see through the alias), and widening over a
		// lazy keeps the dispatcher. Runtime must stay zod-first-match.
		const first = z.lazy(() => z.object({ v: z.string() }));
		const second = z.lazy(() => z.object({ n: z.number() }));
		const union = z.union([first, second]);
		expect(union.parse({ n: 1 })).toEqual({ n: 1 });
		expect(union.safeParse("nope").success).toBe(false);

		const widened = z.object({ t: first.optional() });
		expect(widened.parse({})).toEqual({});
		expect(widened.parse({ t: { v: "x" } })).toEqual({ t: { v: "x" } });
	});
});
