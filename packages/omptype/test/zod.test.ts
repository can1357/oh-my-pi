import { describe, expect, it } from "bun:test";
import { OmpErrors, OmpTypeError } from "../src/errors";
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
// `.optional()` followed by a metadata/wrapper method must stay optional in the
// inferred type, matching the parse that accepts the key's absence.
const optionalThenDescribed = z.object({ note: z.string().optional().describe("d") });
type _OptionalDescribedInference = Assert<Eq<z.infer<typeof optionalThenDescribed>, { note?: string | undefined }>>;
const optionalThenReadonly = z.object({ note: z.string().optional().readonly() });
type _OptionalReadonlyInference = Assert<Eq<z.infer<typeof optionalThenReadonly>, { note?: string | undefined }>>;

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

	it("keeps member steps running through union, widening, and discriminated dispatch", () => {
		// Members carrying Type-attached steps (transform/refine) are invisible
		// in the member IR, so every combinator must EMBED them rather than
		// rebuild from `member.ir` — a rebuild silently drops the step and the
		// schema stops validating. (Emitted-document coverage for the same
		// shapes lives in zod-json-schema.test.ts.)
		const morphUnion = z.union([z.string().transform(value => value.length), z.number()]);
		expect(morphUnion.parse("abc")).toBe(3);
		expect(morphUnion.parse(7)).toBe(7);
		expect(
			z
				.string()
				.transform(value => value.length)
				.optional()
				.parse("abc"),
		).toBe(3);
		expect(
			z
				.string()
				.refine(value => value.startsWith("x"))
				.optional()
				.safeParse("abc").success,
		).toBe(false);
		expect(
			z
				.string()
				.refine(value => value.startsWith("x"))
				.nullable()
				.safeParse("abc").success,
		).toBe(false);
		expect(
			z
				.string()
				.refine(value => value.startsWith("x"))
				.nullable()
				.parse(null),
		).toBeNull();

		// Discriminated dispatch: stripping variants keep their strip semantics
		// and a stepped variant still transforms.
		const eventSchema = z.object({
			evt: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("append"), n: z.number() }),
				z.strictObject({ kind: z.literal("gap"), s: z.string() }),
			]),
		});
		expect(eventSchema.parse({ evt: { kind: "append", n: 1 } })).toEqual({ evt: { kind: "append", n: 1 } });
		expect(eventSchema.safeParse({ evt: { kind: "nope" } }).success).toBe(false);
		const steppedVariants = z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("len"), v: z.string().transform(value => value.length) }),
			z.strictObject({ kind: z.literal("raw"), v: z.number() }),
		]);
		expect(steppedVariants.parse({ kind: "len", v: "abc" })).toEqual({ kind: "len", v: 3 });
	});

	it("rejects discriminated-union variants that cannot be dispatched on", () => {
		// The public signature accepts any schema, so an accidental non-object
		// variant used to build a plain string/number union that answered
		// safeParse("x") with success — the dispatch contract the call
		// advertises, silently gone. It must fail at definition instead.
		const pinFailure = /variant \d+ does not pin "kind" to a literal or enum value/;
		expect(() => z.discriminatedUnion("kind", [z.string(), z.number()])).toThrow(pinFailure);
		expect(() =>
			z.discriminatedUnion("kind", [z.object({ kind: z.literal("a") }), z.object({ other: z.string() })]),
		).toThrow(pinFailure);
		// An open discriminator is the subtler shape: the property exists, but
		// every `kind` string would validate through this variant.
		expect(() =>
			z.discriminatedUnion("kind", [
				z.object({ kind: z.string(), value: z.string() }),
				z.object({ kind: z.literal("b"), n: z.number() }),
			]),
		).toThrow(pinFailure);

		// An enum or literal-union discriminator pins a finite value set, so it
		// dispatches like a single literal.
		const enumDiscriminated = z.discriminatedUnion("kind", [
			z.object({ kind: z.enum(["a", "b"]), v: z.string() }),
			z.object({ kind: z.literal("c"), n: z.number() }),
		]);
		expect(enumDiscriminated.parse({ kind: "b", v: "x" })).toEqual({ kind: "b", v: "x" });
		expect(enumDiscriminated.parse({ kind: "c", n: 1 })).toEqual({ kind: "c", n: 1 });
		expect(enumDiscriminated.safeParse({ kind: "a", n: 1 }).success).toBe(false);

		// Wrapping the same invalid definition in z.lazy must not launder it:
		// the variant is accepted unresolved at construction (running the getter
		// there breaks recursive definitions), then re-checked at first parse,
		// where it used to quietly match any object without a discriminator.
		const deferredInvalid = z.discriminatedUnion("kind", [
			z.lazy(() => z.object({ x: z.string() })),
			z.object({ kind: z.literal("a"), n: z.number() }),
		]);
		expect(() => deferredInvalid.parse({ x: "oops" })).toThrow(pinFailure);
		// Still throws on later parses rather than latching a one-time pass.
		expect(() => deferredInvalid.parse({ kind: "a", n: 1 })).toThrow(pinFailure);

		const deferredValid = z.discriminatedUnion("kind", [
			z.lazy(() => z.object({ kind: z.literal("lazy"), v: z.string() })),
			z.object({ kind: z.literal("a"), n: z.number() }),
		]);
		expect(deferredValid.parse({ kind: "lazy", v: "x" })).toEqual({ kind: "lazy", v: "x" });
		expect(deferredValid.parse({ kind: "a", n: 1 })).toEqual({ kind: "a", n: 1 });
		expect(deferredValid.safeParse({ kind: "lazy", v: 1 }).success).toBe(false);
	});

	it("rejects discriminated-union variants claiming the same discriminator value", () => {
		// Two variants pinning the same value make dispatch ambiguous: the
		// winner would be decided by declaration order, so the same input could
		// produce a different output after an innocuous reorder. zod rejects the
		// definition; so must this.
		expect(() =>
			z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("x"), a: z.string() }),
				z.object({ kind: z.literal("x"), b: z.number() }),
			]),
		).toThrow(/variants 0 and 1 both pin "kind" to "x"/);
		// Enum members count as claims, so an overlap with a later literal is
		// caught too — not just literal-vs-literal collisions.
		expect(() =>
			z.discriminatedUnion("kind", [
				z.object({ kind: z.enum(["a", "b"]) }),
				z.object({ kind: z.literal("b"), n: z.number() }),
			]),
		).toThrow(/variants 0 and 1 both pin "kind" to "b"/);
		// A z.lazy variant is claimed once its getter has run, so wrapping the
		// collision in z.lazy defers the error to first parse instead of hiding
		// it.
		const deferredCollision = z.discriminatedUnion("kind", [
			z.lazy(() => z.object({ kind: z.literal("x"), a: z.string() })),
			z.object({ kind: z.literal("x"), b: z.number() }),
		]);
		expect(() => deferredCollision.parse({ kind: "x", a: "1" })).toThrow(/variants 0 and 1 both pin "kind" to "x"/);
	});

	it("clones readonly output by descriptor instead of spreading it", () => {
		// `.readonly()` must hand back the value it validated, only frozen. A
		// spread silently rewrites it: non-enumerable own properties vanish,
		// accessors collapse into one-shot values, sparse array holes fill with
		// `undefined`, and custom array properties disappear.
		const input: Record<string, unknown> = { visible: 1 };
		Object.defineProperty(input, "token", { value: "secret", enumerable: false, writable: true });
		Object.defineProperty(input, "computed", { get: () => 42, enumerable: true, configurable: true });
		const frozen = z.unknown().readonly().parse(input) as Record<string, unknown>;
		expect(frozen.token).toBe("secret");
		expect(Object.getOwnPropertyDescriptor(frozen, "token")?.enumerable).toBe(false);
		expect(Object.getOwnPropertyDescriptor(frozen, "computed")?.get).toBeFunction();
		expect(frozen.computed).toBe(42);
		expect(Object.isFrozen(frozen)).toBe(true);
		// The caller's graph stays mutable — the reason a clone exists at all.
		expect(Object.isFrozen(input)).toBe(false);

		const sparse: unknown[] = [1];
		sparse[3] = 4;
		(sparse as unknown as Record<string, unknown>).custom = "kept";
		const frozenArray = z.unknown().readonly().parse(sparse) as unknown[];
		expect(Array.isArray(frozenArray)).toBe(true);
		expect(1 in frozenArray).toBe(false);
		expect(frozenArray.length).toBe(4);
		expect((frozenArray as unknown as Record<string, unknown>).custom).toBe("kept");
		expect(Object.isFrozen(frozenArray)).toBe(true);
	});

	it("holds object schemas to zod's object-input domain", () => {
		// Input outside that domain contradicts the emitted `{"type":"object"}`:
		// the tool would accept a shape the model was told was invalid. The guard
		// is a raw input-side filter, so it also covers the modes an output-side
		// check cannot — a key-stripping object has already turned `[]` into `{}`
		// by then — and zod classifies these built-ins as their own parsed types.
		for (const outside of [[], new Date(), new Map(), new Set(), Promise.resolve(1)]) {
			expect(z.object({}).safeParse(outside).success).toBe(false);
			expect(z.strictObject({}).safeParse(outside).success).toBe(false);
			expect(z.looseObject({}).safeParse(outside).success).toBe(false);
			expect(z.record(z.string(), z.string()).safeParse(outside).success).toBe(false);
		}
		// A class instance IS object input, in zod and here.
		class Point {
			x = "1";
		}
		expect(z.object({ x: z.string() }).parse(new Point())).toEqual({ x: "1" });
		// The guard runs once per parse: a prevalidating filter would walk the
		// input a second time and read every getter twice, at every depth.
		let reads = 0;
		const spy = {
			l1: {
				get v() {
					reads++;
					return "x";
				},
			},
		};
		expect(z.object({ l1: z.object({ v: z.string() }) }).parse(spy)).toEqual({ l1: { v: "x" } });
		expect(reads).toBe(1);
		// Mode changes keep the guard.
		expect(z.object({}).strict().safeParse([]).success).toBe(false);
		expect(z.object({}).passthrough().safeParse([1]).success).toBe(false);
		expect(z.object({ a: z.string() }).partial().safeParse([]).success).toBe(false);
		// A discriminated union is object-shaped by definition, and a stripping
		// variant whose discriminator carries a default would otherwise morph
		// `[]` into `{ kind: "a" }` — on the structural path and the dispatcher.
		const defaulted = z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("a").default("a") }),
			z.object({ kind: z.literal("b"), n: z.number() }),
		]);
		expect(defaulted.safeParse([]).success).toBe(false);
		expect(defaulted.describe("d").safeParse([]).success).toBe(false);
		expect(defaulted.parse({})).toEqual({ kind: "a" });
		const deferredVariant = z.discriminatedUnion("kind", [
			z.lazy(() => z.object({ kind: z.literal("a").default("a") })),
			z.object({ kind: z.literal("b"), n: z.number() }),
		]);
		expect(deferredVariant.safeParse([]).success).toBe(false);
		expect(deferredVariant.parse({ kind: "b", n: 2 })).toEqual({ kind: "b", n: 2 });
		// A plain union may legitimately accept arrays — the guard is scoped to
		// object-shaped combinators, not to unions in general.
		expect(z.union([z.array(z.string()), z.object({ a: z.string() })]).parse(["x"])).toEqual(["x"]);
		// Objects still parse, extras semantics intact.
		expect(z.object({ a: z.string() }).parse({ a: "x", b: 1 })).toEqual({ a: "x" });
		expect(z.strictObject({ a: z.string() }).parse({ a: "x" })).toEqual({ a: "x" });
		expect(z.looseObject({ a: z.string() }).parse({ a: "x", b: 1 })).toEqual({ a: "x", b: 1 });
		expect(z.strictObject({ a: z.string() }).safeParse({ a: "x", b: 1 }).success).toBe(false);
	});

	it("keeps the object-input domain through intersections and compiled parses", () => {
		// The IR merge behind `.and()` builds a NEW object node, so the domain has
		// to be carried over: an intersection accepts only what both sides accept,
		// and dropping the flag silently widened the result back to arrays and
		// built-ins. Reached through the omptype surface, since the shim's own
		// type does not expose `.and()`.
		const intersect = (schema: unknown, other: unknown): ((value: unknown) => unknown) =>
			(schema as { and(def: unknown): (value: unknown) => unknown }).and(other);

		const intersected = intersect(z.strictObject({}), type({}));
		expect(intersected([])).toBeInstanceOf(OmpErrors);
		expect(intersected(new Date())).toBeInstanceOf(OmpErrors);
		expect(intersected({})).toEqual({});

		const withProps = intersect(z.object({ x: z.string() }), type({}));
		const arrayWithProp: unknown[] = [];
		Object.assign(arrayWithProp, { x: "v" });
		expect(withProps(arrayWithProp)).toBeInstanceOf(OmpErrors);
		expect(withProps({ x: "v" })).toEqual({ x: "v" });

		// The compiled validator must agree with the walked one, or the JIT
		// threshold would be observable: same rejection, same message, always.
		const schema = z.object({ a: z.string() });
		const messages = new Set<string>();
		for (let index = 0; index < 12; index++) {
			const result = schema.safeParse([]);
			messages.add(result.success ? "accepted" : result.error.message);
		}
		expect([...messages]).toEqual(["must be a plain object (was an array)"]);

		// Union normalization must not prune the WIDER member: the domain bit is
		// part of what an object accepts, so ignoring it in the subtype check made
		// the union's accepted input depend on member order, and reported a plain
		// and an unrestricted object as equal.
		const unrestricted = type({ "+": "reject" });
		const plainFirst = (z.strictObject({}) as unknown as { or(def: unknown): (value: unknown) => unknown }).or(
			unrestricted,
		);
		const plainSecond = (unrestricted as unknown as { or(def: unknown): (value: unknown) => unknown }).or(
			z.strictObject({}),
		);
		expect(plainFirst([])).toEqual([]);
		expect(plainSecond([])).toEqual([]);
		expect((z.strictObject({}) as unknown as { equals(def: unknown): boolean }).equals(unrestricted)).toBe(false);
	});

	it("rejects discriminators pinned to values it cannot advertise", () => {
		// omptype compares object literals by reference, so emitting
		// `const: {"a":1}` would promise the model a structural match the runtime
		// refuses — the provider-valid `{ kind: { a: 1 } }` only parsed when it
		// carried the original reference. bigint has no JSON form at all.
		const objectLiteral = { a: 1 };
		expect(() =>
			z.discriminatedUnion("kind", [
				z.object({ kind: z.literal(objectLiteral), n: z.number() }),
				z.object({ kind: z.literal("b") }),
			]),
		).toThrow(/does not pin "kind" to a literal or enum value/);
		expect(() =>
			z.discriminatedUnion("kind", [z.object({ kind: z.literal(1n) }), z.object({ kind: z.literal("b") })]),
		).toThrow(/does not pin "kind" to a literal or enum value/);

		// Every literal kind that survives a JSON Schema `const` still dispatches.
		const numeric = z.discriminatedUnion("kind", [
			z.object({ kind: z.literal(1), a: z.string() }),
			z.object({ kind: z.literal(2), b: z.number() }),
		]);
		expect(numeric.parse({ kind: 2, b: 3 })).toEqual({ kind: 2, b: 3 });
		const nullish = z.discriminatedUnion("kind", [
			z.object({ kind: z.null(), a: z.string() }),
			z.object({ kind: z.literal("b") }),
		]);
		expect(nullish.parse({ kind: null, a: "x" })).toEqual({ kind: null, a: "x" });
	});

	it("lets later modifiers replace the object policy the array guard sits on", () => {
		// The guard is the shim's own step, so a naive wrapper made every guarded
		// object look stepped: a rebuild then re-validated through the OLD
		// policy, and `.strict().partial()` still demanded the now-optional key
		// while `z.strictObject({}).passthrough()` still rejected extras.
		expect(z.object({ a: z.string() }).strict().partial().parse({})).toEqual({});
		expect(z.strictObject({}).passthrough().parse({ extra: 1 })).toEqual({ extra: 1 });
		expect(z.strictObject({ a: z.string() }).describe("d").partial().parse({})).toEqual({});
		expect(z.object({ a: z.string() }).strict().strip().parse({ a: "x", b: 1 })).toEqual({ a: "x" });
		// The replaced policy is really gone, and the surviving one still holds.
		expect(z.object({ a: z.string() }).strict().partial().safeParse({ b: 1 }).success).toBe(false);
		expect(z.looseObject({ a: z.string() }).partial().parse({ b: 1 })).toEqual({ b: 1 });
		// …and the guard survives every chain that stays non-stripping.
		expect(z.object({ a: z.string() }).strict().partial().safeParse([]).success).toBe(false);
		expect(z.strictObject({ a: z.string() }).describe("d").safeParse([]).success).toBe(false);
		expect(z.looseObject({ a: z.string() }).partial().safeParse([]).success).toBe(false);
		// Descriptions and defaults survive the rebuild the guard forces.
		expect(z.strictObject({ a: z.string() }).describe("desc").toJsonSchema()).toMatchObject({
			additionalProperties: false,
			description: "desc",
		});
		expect(z.strictObject({ n: z.number().default(3) }).parse({})).toEqual({ n: 3 });
	});

	it("keeps the freeze and replaces the policy when readonly precedes a modifier", () => {
		// `.readonly()` is a shim wrapper too, so a rebuild after it must put the
		// freeze back on top of the NEW policy. Carrying it instead re-validated
		// through the pre-readonly schema: `.readonly().passthrough()` still
		// rejected extras and `.readonly().partial()` still required the key.
		const passthrough = z.strictObject({ a: z.string() }).readonly().passthrough();
		const kept = passthrough.parse({ a: "x", extra: 1 });
		expect(kept).toEqual({ a: "x", extra: 1 });
		expect(Object.isFrozen(kept)).toBe(true);

		const partial = z.object({ a: z.string() }).readonly().partial();
		expect(partial.parse({})).toEqual({});
		expect(Object.isFrozen(partial.parse({}))).toBe(true);
		expect(partial.safeParse([]).success).toBe(false);

		// Through a description, and applied twice, the chain still rebuilds.
		const described = z.strictObject({ a: z.string() }).readonly().describe("d").partial();
		expect(described.parse({})).toEqual({});
		expect(Object.isFrozen(described.parse({}))).toBe(true);
		expect(z.object({ a: z.string() }).readonly().readonly().partial().parse({})).toEqual({});

		// AUTHOR steps keep the opposite contract: a refinement must keep
		// running against the schema it was written for, so the rebuild
		// re-validates through it and the now-optional key is still required.
		expect(
			z
				.object({ a: z.string() })
				.refine(value => "a" in (value as object))
				.partial()
				.safeParse({}).success,
		).toBe(false);
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
	it("builds strict, loose, discriminated, readonly, and lazy schemas", () => {
		const strict = z.strictObject({ name: z.string() });
		expect(strict.parse({ name: "Ada" })).toEqual({ name: "Ada" });
		expect(strict.safeParse({ name: "Ada", extra: 1 }).success).toBe(false);

		const loose = z.looseObject({ name: z.string() });
		expect(loose.parse({ name: "Ada", extra: 1 })).toEqual({ name: "Ada", extra: 1 });
		expect(loose.safeParse({ name: 1 }).success).toBe(false);

		const termination = z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("interrupted") }),
			z.object({ kind: z.literal("timed_out"), timeoutMs: z.number() }),
		]);
		type Termination = z.infer<typeof termination>;
		const timedOut: Termination = termination.parse({ kind: "timed_out", timeoutMs: 5 });
		expect(timedOut).toEqual({ kind: "timed_out", timeoutMs: 5 });
		const interrupted: Termination = { kind: "interrupted" };
		expect(termination.parse(interrupted)).toEqual(interrupted);
		expect(termination.safeParse({ kind: "nope" }).success).toBe(false);
		expect(termination.safeParse({}).success).toBe(false);
		expect(termination.safeParse("str").success).toBe(false);

		const parsedFrozen = z
			.strictObject({ tags: z.array(z.string()) })
			.readonly()
			.parse({ tags: ["a"] });
		expect(parsedFrozen).toEqual({ tags: ["a"] });
		expect(Object.isFrozen(parsedFrozen)).toBe(true);
		// Shallow, matching Zod's own contract: a nested value is left mutable.
		expect(Object.isFrozen(parsedFrozen.tags)).toBe(false);
		expect(Reflect.set(parsedFrozen, "tags", [])).toBe(false);
		expect(z.array(z.string()).readonly().optional().parse(undefined)).toBeUndefined();

		// `.readonly()` freezes only its own parse output, NEVER the caller's
		// input graph: a persisted session entry is schema-validated (with
		// nested `.readonly()` arms) BEFORE blob hydration mutates it in place,
		// so a freeze leaking onto the input would make the session unloadable.
		const inputAttachment = { kind: "image", data: "blob:sha256:abc", mimeType: "image/png" };
		const inputEntry = { attachment: inputAttachment };
		const nestedReadonly = z.strictObject({
			attachment: z.strictObject({ kind: z.literal("image"), data: z.string(), mimeType: z.string() }).readonly(),
		});
		expect(nestedReadonly.safeParse(inputEntry).success).toBe(true);
		expect(Object.isFrozen(inputAttachment)).toBe(false);
		inputAttachment.data = "resolved-bytes"; // the hydration write must still work
		expect(inputAttachment.data).toBe("resolved-bytes");

		// Non-plain parse output (reachable via z.unknown()/z.any()/transforms)
		// has no non-destructive shallow clone: it passes through untouched —
		// identity, prototype, and internal slots intact, and NOT frozen (an
		// in-place freeze would mutate the caller's value).
		const map = new Map([[1, 2]]);
		const unknownReadonly = z.unknown().readonly();
		expect(unknownReadonly.parse(map)).toBe(map);
		expect(Object.isFrozen(map)).toBe(false);
		expect(map.get(1)).toBe(2);
		const date = new Date(0);
		expect(unknownReadonly.parse(date)).toBe(date);
		expect((unknownReadonly.parse(date) as Date).getTime()).toBe(0);

		type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
		const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
			z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
		);
		const deep = { b: [2, { c: "d" }] };
		expect(jsonValue.parse(["a", 1, true, null, deep])).toEqual(["a", 1, true, null, deep]);
		expect(jsonValue.safeParse([() => {}]).success).toBe(false);
	});
});
