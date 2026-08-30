import { type OmpErrors, OmpTypeError } from "./errors";
import { type EmbeddableSchema, type Extras, embed, hasDeferredAlias, type IR, IR_BRAND, type PropIR } from "./ir";
import { type NarrowContext, type Type, type } from "./type";

interface OptionalSchemaMarker {
	readonly _optional: true;
}

interface RefineOptions {
	message?: string;
	error?: string;
}

interface Decoratable<out Out> extends EmbeddableSchema {
	(value: unknown): Out | OmpErrors;
	narrow(predicate: (value: Out, context: NarrowContext) => unknown): Decoratable<Out>;
	/** Input-side predicate: runs on the raw value, before the base validates it. */
	filter(predicate: (value: unknown, context: NarrowContext) => unknown): Decoratable<Out>;
	pipe<Next>(transform: (value: Out, context: NarrowContext) => Next): Decoratable<Exclude<Next, OmpErrors>>;
	or(def: unknown): Decoratable<unknown>;
	describe(description: string): Decoratable<Out>;
	default(value: Out | (() => Out)): Decoratable<Out>;
}

export interface ZodLikeIssue {
	path: PropertyKey[];
	message: string;
}

export type ZodLikeSafeParseResult<Out> = { success: true; data: Out } | { success: false; error: ZodError };

/** A callable omptype schema carrying the Zod-v4-style fluent surface. */
export interface ZodLikeSchema<out Out> extends Type<Out, unknown> {
	readonly _output: Out;
	/** @internal Used while composing object property IR. */
	readonly isOptional: boolean;
	parse(value: unknown): Out;
	safeParse(value: unknown): ZodLikeSafeParseResult<Out>;
	min(bound: number): ZodLikeSchema<Out>;
	max(bound: number): ZodLikeSchema<Out>;
	int(): ZodLikeSchema<Out>;
	positive(): ZodLikeSchema<Out>;
	nonnegative(): ZodLikeSchema<Out>;
	regex(expression: RegExp, message?: string): ZodLikeSchema<Out>;
	url(): ZodLikeSchema<Out>;
	optional(): ZodLikeSchema<Out | undefined> & OptionalSchemaMarker;
	nullable(): ZodLikeSchema<Out | null>;
	default(value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>)): ZodLikeSchema<Exclude<Out, undefined>>;
	/**
	 * The `this`-typed overloads keep {@link OptionalSchemaMarker} attached: the
	 * runtime decorator already carries `isOptional` through both methods, and
	 * without them `z.infer` reports `z.string().optional().describe("…")` (or
	 * `.readonly()`) as a REQUIRED property whose value includes `undefined`,
	 * disagreeing with the parse that accepts the key's absence.
	 */
	describe(
		this: ZodLikeSchema<Out> & OptionalSchemaMarker,
		description: string,
	): ZodLikeSchema<Out> & OptionalSchemaMarker;
	describe(description: string): ZodLikeSchema<Out>;
	refine(predicate: (value: Out) => unknown, messageOrOptions?: string | RefineOptions): ZodLikeSchema<Out>;
	transform<Next>(transformer: (value: Out) => Next): ZodLikeSchema<Next>;
	catch(fallback: Out | (() => Out)): ZodLikeSchema<Out>;
	strict(): ZodLikeSchema<Out>;
	passthrough(): ZodLikeSchema<Out & Record<string, unknown>>;
	strip(): ZodLikeSchema<Out>;
	partial(): Out extends object ? ZodLikeSchema<Partial<Out>> : ZodLikeSchema<Out>;
	readonly(this: ZodLikeSchema<Out> & OptionalSchemaMarker): ZodLikeSchema<Readonly<Out>> & OptionalSchemaMarker;
	readonly(): ZodLikeSchema<Readonly<Out>>;
}

function schemaFromIR<Out>(ir: IR): Decoratable<Out> {
	const embedded: EmbeddableSchema = {
		[IR_BRAND]: true,
		ir,
		hasSteps: false,
		hasDefault: false,
		run: value => value,
	};
	return type.raw(embedded) as unknown as Decoratable<Out>;
}

/**
 * `value === undefined` short-circuit around an inner schema, as a dispatch
 * morph. Composing a real union (`schema | undefined`) instead would trip
 * omptype's unordered-union determinism check whenever the inner side carries
 * morphs (dispatcher-wrapped unions, parse schemas, stepped members).
 */
function undefinedDispatch<Out>(
	schema: Decoratable<Out>,
	fallback: Out | (() => Out) | undefined,
): Decoratable<Out | undefined> {
	return schemaFromIR<Out | undefined>({
		k: "morph",
		input: { k: "unknown" },
		fn: (input, ctx) => {
			if (input === undefined) {
				return typeof fallback === "function" ? (fallback as () => Out)() : fallback;
			}
			const result = schema(input);
			if (!(result instanceof type.errors)) return result;
			return ctx.error(fallback === undefined ? "the schema or undefined" : "the default or a valid value");
		},
	});
}

const kRebuild = Symbol("omptype.zod.rebuild");

/**
 * The shim's own wrappers around a structural schema, kept so a later
 * structural modifier can rebuild the structure and put them back.
 *
 * Author-supplied steps (`.refine()`, `.transform()`) are deliberately NOT
 * described here: they must keep running against the schema they were written
 * for, which is what {@link restrictBase}'s re-validating morph path does.
 */
interface RebuildInfo<Out> {
	/** Wrapper-free schema, the one a rebuild starts from. */
	base: Decoratable<Out>;
	/** Whether an array guard is part of the chain. */
	guarded: boolean;
	/** Re-applies the non-guard wrappers, currently `.readonly()`'s freeze. */
	rewrap?: (schema: Decoratable<Out>) => Decoratable<Out>;
}

/** A schema that may carry {@link RebuildInfo}. */
interface MaybeWrapped<Out> extends Decoratable<Out> {
	readonly [kRebuild]?: RebuildInfo<Out>;
}

function rebuildInfoOf<Out>(schema: Decoratable<Out>): RebuildInfo<Out> | undefined {
	const carrier: MaybeWrapped<Out> = schema;
	return carrier[kRebuild];
}

/** Configurable so a schema stamped by `guardArrays` can be re-stamped once its full wrapper chain is known. */
function stampRebuild<Out>(schema: Decoratable<Out>, info: RebuildInfo<Out>): Decoratable<Out> {
	Object.defineProperty(schema, kRebuild, { value: info, enumerable: false, configurable: true });
	return schema;
}

/**
 * Rebuild `source`'s structure as `ir`, keeping its description, default, and
 * any author steps.
 *
 * The shim's own wrappers are unwrapped and re-applied rather than carried: they
 * would make the source count as stepped, so the rebuilt schema would validate
 * `ir` and then re-validate through the OLD object policy — `.strict()
 * .partial()` would still demand the now-optional keys, `z.strictObject({})
 * .passthrough()` would still reject extras, and inserting `.readonly()` before
 * either would bring that back.
 */
function restrictBase<Out>(source: Decoratable<Out>, ir: IR): Decoratable<Out> {
	const info = rebuildInfoOf(source);
	const base = info?.base ?? source;
	let structural = base.hasSteps
		? schemaFromIR<Out>({ k: "morph", input: ir, fn: value => base(value) })
		: schemaFromIR<Out>(ir);
	if (base.ir.desc !== undefined) structural = structural.describe(base.ir.desc);
	if (base.hasDefault) structural = structural.default(base.defaultValue as Out | (() => Out));
	// Every object target is guarded, stripping included; any other target — a
	// discriminated union rebuilt by `.describe()` — keeps the guard it arrived
	// with.
	const guarded = ir.k === "object" || info?.guarded === true;
	let next = guarded ? guardArrays(structural) : structural;
	if (info?.rewrap !== undefined) next = info.rewrap(next);
	return guarded || info?.rewrap !== undefined
		? stampRebuild(next, { base: structural, guarded, rewrap: info?.rewrap })
		: next;
}

/**
 * Reject an array reaching an object schema, which zod does and the emitted
 * `{"type":"object"}` already promises.
 *
 * A `filter` step, not `narrow`: filters run against the RAW INPUT before the
 * base validates it, so this also catches the shapes an output-side check
 * cannot — a key-stripping object has already turned `[]` into `{}` by the time
 * a narrow runs, and so has a discriminated union whose matching variant strips.
 */
function guardArrays<Out>(base: Decoratable<Out>): Decoratable<Out> {
	const guarded = base.filter(
		(value, ctx: NarrowContext) => !Array.isArray(value) || ctx.mustBe("an object, not an array"),
	);
	return stampRebuild(guarded, { base, guarded: true });
}

/**
 * Keep the rebuild info reachable through a wrapper that adds no policy of its
 * own (`.describe()`), so a later `.partial()`/mode change still rebuilds from
 * the base instead of re-validating through the old object policy.
 */
function carryRebuild<Out>(source: Decoratable<Out>, wrapped: Decoratable<Out>): Decoratable<Out> {
	const info = rebuildInfoOf(source);
	return info === undefined ? wrapped : stampRebuild(wrapped, info);
}

/**
 * `.readonly()`'s value step: shallow-freeze a CLONE of the parse output.
 *
 * Zod freezes its own freshly constructed output; omptype's parsing shares
 * structure with the input (a parent copy keeps child references), so freezing
 * in place would freeze the CALLER's input graph — e.g. a persisted session
 * entry schema-validated before blob hydration must stay mutable.
 *
 * The clone copies property DESCRIPTORS onto a fresh object of the same
 * prototype (a fresh array for arrays). A spread would silently rewrite the
 * value it is supposed to hand back: non-enumerable own properties would
 * vanish, accessors would collapse into one-shot values, sparse array holes
 * would materialize as `undefined`, and custom array properties would be
 * dropped. Descriptors also keep an own `__proto__` key intact, since
 * `defineProperty` semantics never invoke the setter.
 *
 * Only plain objects and arrays are cloned+frozen. A non-plain object (a
 * Date/Map/class instance reachable via `z.unknown()`/`z.any()`/a transform) has
 * no non-destructive shallow clone — its internal slots do not travel with
 * descriptors — and freezing it in place would mutate the caller's value, so it
 * passes through untouched: never-freeze-the-input outranks freeze-the-output
 * for the shim's JSON-oriented use. Primitives and functions pass through for
 * the same reason. One level deep, exactly like Zod.
 */
function freezeParseOutput<Out>(schema: Decoratable<Out>): Decoratable<Out> {
	return schema.pipe(value => {
		if (typeof value !== "object" || value === null) return value;
		const proto = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const clone = Array.isArray(value)
			? Object.defineProperties([] as unknown[], descriptors)
			: Object.create(proto, descriptors);
		return Object.freeze(clone) as Out;
	});
}

function lengthBound(kind: "min" | "max", schema: Decoratable<unknown>, bound: number): void {
	if (schema.ir.k !== "string" && schema.ir.k !== "array") return;
	if (!Number.isSafeInteger(bound) || bound < 0) {
		throw new OmpTypeError(`${kind} length must be a nonnegative safe integer`);
	}
}

function refinementMessage(messageOrOptions: string | RefineOptions | undefined): string {
	if (typeof messageOrOptions === "string") return messageOrOptions;
	return messageOrOptions?.message ?? messageOrOptions?.error ?? "valid (refinement failed)";
}

function isStringKeyIR(ir: IR): boolean {
	switch (ir.k) {
		case "string":
			return true;
		case "lit":
			return typeof ir.v === "string";
		case "union":
			return ir.members.length > 0 && ir.members.every(isStringKeyIR);
		case "sub":
			return isStringKeyIR(ir.schema.ir);
		default:
			return false;
	}
}

function decorate<Out>(schema: Decoratable<Out>, optional = false): ZodLikeSchema<Out> {
	const next = (inner: Decoratable<Out>, nextOptional = optional): ZodLikeSchema<Out> => decorate(inner, nextOptional);
	const withObjectExtras = (extras: "keep" | "reject" | "delete"): ZodLikeSchema<Out> => {
		if (schema.ir.k !== "object") throw new OmpTypeError("object mode requires an object schema");
		// restrictBase re-applies the array guard for the non-stripping modes, so
		// `.strict()`/`.passthrough()` reject arrays exactly like
		// `z.strictObject`/`z.looseObject`.
		return next(restrictBase(schema, { ...schema.ir, extras }));
	};
	Object.defineProperty(schema, "isOptional", { value: optional, enumerable: false });

	return Object.assign(schema, {
		parse(value: unknown): Out {
			const result = schema(value);
			if (result instanceof type.errors) throw new Error(result.summary);
			return result;
		},
		safeParse(value: unknown): ZodLikeSafeParseResult<Out> {
			const result = schema(value);
			if (!(result instanceof type.errors)) return { success: true, data: result };
			return {
				success: false,
				error: {
					message: result.summary,
					issues: result.map(issue => ({ path: [...issue.path], message: issue.problem })),
				},
			};
		},
		min(bound: number): ZodLikeSchema<Out> {
			const ir = schema.ir;
			if (ir.k === "string" || ir.k === "array") {
				lengthBound("min", schema, bound);
				const min = ir.min === undefined ? bound : Math.max(ir.min, bound);
				return next(restrictBase(schema, { ...ir, min }));
			}
			if (ir.k === "number") {
				if (Number.isNaN(bound)) throw new OmpTypeError("number min must not be NaN");
				if (ir.min !== undefined && ir.min >= bound) return next(restrictBase(schema, ir));
				return next(restrictBase(schema, { ...ir, min: bound, xmin: false }));
			}
			throw new OmpTypeError(`cannot apply min to ${ir.k}`);
		},
		max(bound: number): ZodLikeSchema<Out> {
			const ir = schema.ir;
			if (ir.k === "string" || ir.k === "array") {
				lengthBound("max", schema, bound);
				const max = ir.max === undefined ? bound : Math.min(ir.max, bound);
				return next(restrictBase(schema, { ...ir, max }));
			}
			if (ir.k === "number") {
				if (Number.isNaN(bound)) throw new OmpTypeError("number max must not be NaN");
				if (ir.max !== undefined && ir.max <= bound) return next(restrictBase(schema, ir));
				return next(restrictBase(schema, { ...ir, max: bound, xmax: false }));
			}
			throw new OmpTypeError(`cannot apply max to ${ir.k}`);
		},
		int(): ZodLikeSchema<Out> {
			if (schema.ir.k !== "number") throw new OmpTypeError(`cannot apply int to ${schema.ir.k}`);
			return next(restrictBase(schema, { ...schema.ir, int: true }));
		},
		positive(): ZodLikeSchema<Out> {
			if (schema.ir.k !== "number") throw new OmpTypeError(`cannot apply positive to ${schema.ir.k}`);
			const ir = schema.ir;
			if (ir.min !== undefined && ir.min > 0) return next(restrictBase(schema, ir));
			return next(restrictBase(schema, { ...ir, min: 0, xmin: true }));
		},
		nonnegative(): ZodLikeSchema<Out> {
			if (schema.ir.k !== "number") throw new OmpTypeError(`cannot apply nonnegative to ${schema.ir.k}`);
			return this.min(0);
		},
		regex(expression: RegExp, message?: string): ZodLikeSchema<Out> {
			if (schema.ir.k !== "string") throw new OmpTypeError(`cannot apply regex to ${schema.ir.k}`);
			const expectation = message ?? `matching ${expression}`;
			const narrowed = schema.narrow((value, ctx) => {
				expression.lastIndex = 0;
				const matches = expression.test(value as string);
				expression.lastIndex = 0;
				return matches || ctx.mustBe(expectation);
			});
			return next(narrowed);
		},
		url(): ZodLikeSchema<Out> {
			if (schema.ir.k !== "string") throw new OmpTypeError(`cannot apply url to ${schema.ir.k}`);
			return next(restrictBase(schema, { ...schema.ir, url: true }));
		},
		optional(): ZodLikeSchema<Out | undefined> & OptionalSchemaMarker {
			// Widening keeps a real union whenever the member carries no
			// deferred alias, so structural metadata (JSON Schema export,
			// descriptions) survives. `or` EMBEDS the member: a member with
			// Type-attached `.transform()`/`.refine()` steps (`z.record`,
			// `.regex()`, `.refine()`, …) becomes a `sub` node, so its steps
			// keep running and its structural base still exports — rebuilding
			// from `schema.ir` instead would silently DROP those steps.
			// The widened union is disjoint from `undefined` unless the member
			// itself accepts `undefined`, and omptype's own determinism check
			// arbitrates that at construction (its indeterminacy error falls
			// back to the dispatcher below).
			// Deferred aliases are excluded up front: the determinism probe
			// cannot see through one, and resolving it here would break zod's
			// defer-to-first-parse contract.
			if (!hasDeferredAlias(schema.ir)) {
				try {
					return decorate(schema.or(type.raw("undefined")) as Decoratable<Out | undefined>, true) as ZodLikeSchema<
						Out | undefined
					> &
						OptionalSchemaMarker;
				} catch (error) {
					if (!isIndeterminateUnionError(error)) throw error;
				}
			}
			return decorate(undefinedDispatch<Out>(schema, undefined), true) as ZodLikeSchema<Out | undefined> &
				OptionalSchemaMarker;
		},
		nullable(): ZodLikeSchema<Out | null> {
			// Same gate as optional() above: the embedded widening union keeps
			// a stepped member's structure and steps alive, and is disjoint
			// from `null` unless the member itself accepts `null`, which
			// omptype's determinism check arbitrates at construction.
			if (!hasDeferredAlias(schema.ir)) {
				try {
					return decorate(schema.or(type.raw("null")) as Decoratable<Out | null>, optional);
				} catch (error) {
					if (!isIndeterminateUnionError(error)) throw error;
				}
			}
			const inner = schema;
			const nullable = schemaFromIR<Out | null>({
				k: "morph",
				input: { k: "unknown" },
				fn: (input, ctx) => {
					if (input === null) return null;
					const result = inner(input);
					if (!(result instanceof type.errors)) return result;
					return ctx.error("the schema or null");
				},
			});
			return decorate(nullable, optional) as ZodLikeSchema<Out | null>;
		},
		default(
			value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>),
		): ZodLikeSchema<Exclude<Out, undefined>> {
			type DefaultOut = Exclude<Out, undefined>;
			// Same gate as optional()/nullable(): the union+pipe composition
			// keeps structural metadata alive for members that carry no deferred
			// alias, with omptype's determinism check arbitrating disjointness
			// from `undefined` at construction.
			if (!hasDeferredAlias(schema.ir)) {
				try {
					const widened = schema.or(type.raw("undefined")) as Decoratable<Out | undefined>;
					const pipedPlain = widened.pipe(output => {
						if (output !== undefined) return output as DefaultOut;
						return typeof value === "function" ? (value as () => DefaultOut)() : value;
					}) as unknown as Decoratable<DefaultOut>;
					const plain = decorate(pipedPlain);
					Object.defineProperty(plain, "hasDefault", { value: true, enumerable: false });
					Object.defineProperty(plain, "defaultValue", { value, enumerable: false });
					return plain;
				} catch (error) {
					if (!isIndeterminateUnionError(error)) throw error;
				}
			}
			const result = decorate(
				undefinedDispatch<DefaultOut>(
					schema as unknown as Decoratable<DefaultOut>,
					value,
				) as unknown as Decoratable<DefaultOut>,
			);
			// Stamp the default metadata objectSchema() reads when embedding this
			// schema as a property: the prop must stay optional with this fallback.
			Object.defineProperty(result, "hasDefault", { value: true, enumerable: false });
			Object.defineProperty(result, "defaultValue", { value, enumerable: false });
			return result;
		},
		describe(description: string): ZodLikeSchema<Out> {
			const rebuilt = restrictBase(schema, { ...schema.ir, desc: description });
			return next(carryRebuild(rebuilt, rebuilt.describe(description)));
		},
		refine(predicate: (value: Out) => unknown, messageOrOptions?: string | RefineOptions): ZodLikeSchema<Out> {
			const expectation = refinementMessage(messageOrOptions);
			return next(schema.narrow((value, ctx) => Boolean(predicate(value)) || ctx.mustBe(expectation)));
		},
		transform<Next>(transformer: (value: Out) => Next): ZodLikeSchema<Next> {
			return decorate(
				schema.pipe(value => transformer(value)),
				optional,
			);
		},
		catch(fallback: Out | (() => Out)): ZodLikeSchema<Out> {
			const caught = type.unknown.pipe(input => {
				try {
					const result = schema(input);
					if (!(result instanceof type.errors)) return result;
				} catch {
					// A caught schema is deliberately total, including user refinement/transform exceptions.
				}
				return typeof fallback === "function" ? (fallback as () => Out)() : fallback;
			});
			return decorate(caught as Decoratable<Out>, optional);
		},
		strict(): ZodLikeSchema<Out> {
			return withObjectExtras("reject");
		},
		passthrough(): ZodLikeSchema<Out & Record<string, unknown>> {
			return withObjectExtras("keep") as ZodLikeSchema<Out & Record<string, unknown>>;
		},
		strip(): ZodLikeSchema<Out> {
			return withObjectExtras("delete");
		},
		partial(): Out extends object ? ZodLikeSchema<Partial<Out>> : ZodLikeSchema<Out> {
			if (schema.ir.k !== "object") throw new OmpTypeError(`cannot apply partial to ${schema.ir.k}`);
			const props = schema.ir.props.map(prop => ({ ...prop, opt: true }));
			return next(restrictBase(schema, { ...schema.ir, props })) as Out extends object
				? ZodLikeSchema<Partial<Out>>
				: ZodLikeSchema<Out>;
		},
		/**
		 * Matches Zod's runtime contract: `.readonly()` is not merely a type
		 * cast, it shallow-freezes successful parse output — see
		 * {@link freezeParseOutput} for why that is a descriptor-level clone
		 * rather than a freeze in place.
		 */
		readonly(): ZodLikeSchema<Readonly<Out>> {
			// Recorded as a shim wrapper, not just applied: a later structural
			// modifier (`.partial()`, `.passthrough()`) must rebuild the object
			// policy and put the freeze back on top, instead of re-validating
			// through the pre-readonly schema and its old policy.
			const info = rebuildInfoOf(schema);
			const rewrap = info?.rewrap;
			const frozen = freezeParseOutput(schema);
			stampRebuild(frozen, {
				base: info?.base ?? schema,
				guarded: info?.guarded === true,
				rewrap: rewrap === undefined ? freezeParseOutput : inner => freezeParseOutput(rewrap(inner)),
			});
			return next(frozen) as unknown as ZodLikeSchema<Readonly<Out>>;
		},
	}) as unknown as ZodLikeSchema<Out>;
}

function decorateUnknown(schema: Decoratable<unknown>): ZodLikeSchema<unknown> {
	return decorate(schema);
}

export type infer<T> = T extends { readonly _output: infer Out } ? Out : never;

type SchemaOutput<Schema> = Schema extends { readonly _output: infer Out } ? Out : never;
type Shape = Readonly<Record<string, ZodLikeSchema<unknown>>>;
type ObjectOutput<S extends Shape> = {
	-readonly [K in keyof S as S[K] extends OptionalSchemaMarker ? never : K]: SchemaOutput<S[K]>;
} & {
	-readonly [K in keyof S as S[K] extends OptionalSchemaMarker ? K : never]?: SchemaOutput<S[K]>;
};
type Simplify<T> = { [K in keyof T]: T[K] };
type UnionOutput<Schemas extends readonly ZodLikeSchema<unknown>[]> = SchemaOutput<Schemas[number]>;

function objectSchema<const S extends Shape>(shape: S, extras: Extras = "delete"): ZodLikeSchema<ObjectOutput<S>> {
	const props: PropIR[] = [];
	for (const key in shape) {
		const member = shape[key];
		const prop: PropIR = { key, opt: member.isOptional, val: embed(member) };
		if (member.hasDefault) {
			prop.hasDefault = true;
			prop.def = member.defaultValue;
			prop.defFactory = typeof member.defaultValue === "function";
		}
		props.push(prop);
	}
	const base = schemaFromIR<unknown>({ k: "object", props, extras });
	return decorateUnknown(guardArrays(base)) as unknown as ZodLikeSchema<ObjectOutput<S>>;
}

export const string = (): ZodLikeSchema<string> => decorate(schemaFromIR(type.string.ir));
export const number = (): ZodLikeSchema<number> => decorate(schemaFromIR(type.number.ir));
export const boolean = (): ZodLikeSchema<boolean> => decorate(schemaFromIR(type.boolean.ir));
export const literal = <const Value>(value: Value): ZodLikeSchema<Value> =>
	decorate(schemaFromIR<Value>(type.enumerated(value).ir));
const enumSchema = <const Values extends readonly [string, ...string[]]>(
	values: Values,
): ZodLikeSchema<Values[number]> => {
	if (values.length === 0) throw new OmpTypeError("enum requires at least one value");
	return decorate(schemaFromIR<Values[number]>(type.enumerated(...values).ir));
};

export { enumSchema as enum };

/**
 * Matches omptype's unordered-union indeterminacy error. The structural build
 * is only attempted for member sets that pass the exportability gate, so this
 * error alone may fall back to the ordered dispatcher; any other construction
 * error must surface. Deliberately text-matched and narrow: if omptype ever
 * rewords the message, this stops matching and fails loudly (construction
 * error) instead of silently erasing again.
 */
function isIndeterminateUnionError(error: unknown): boolean {
	return (
		error instanceof OmpTypeError &&
		error.message.includes("unordered union") &&
		error.message.includes("indeterminate")
	);
}
// Ordered first-match dispatcher rather than an omptype union: zod unions try
// branches in declaration order, while omptype's unordered unions reject
// overlapping morph inputs — a shape recursive schemas with morph-carrying
// members hit constantly. Wrapping the members in one unknown-input morph
// keeps zod's ordering and keeps member morphs invisible to the determinism
// check.
//
// The dispatcher is the last resort, not the default: it erases the IR, so
// `toJsonSchema()` emits `{}` and a provider-facing tool parameter appears
// unconstrained. Whenever omptype accepts the structural union, its output is
// order-independent — any-match equals first-match — so zod's ordering is not
// observable and the structural build wins.
export const union = <
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> => {
	// Members are EMBEDDED, not rebuilt from `member.ir`: a member carrying
	// Type-attached `.transform()`/`.refine()` steps survives as a `sub` node,
	// so its steps keep running and its structural base still exports. Only a
	// deferred alias is excluded up front — the determinism probe below cannot
	// see through one. Everything else attempts the structural build and lets
	// omptype's determinism check arbitrate: if construction succeeds the
	// union's output is order-independent, so `anyOf` faithfully describes the
	// accepted inputs.
	const irs = schemas.map(schema => embed(schema));
	if (schemas.every(schema => !hasDeferredAlias(schema.ir))) {
		try {
			return decorate(schemaFromIR<UnionOutput<Schemas>>({ k: "union", members: irs }));
		} catch (error) {
			// Overlapping morph-carrying members (e.g. two key-stripping
			// z.objects) have order-dependent output under omptype's unordered
			// union, so the native build is rejected there. zod's union is
			// first-match: keep the ordered dispatcher below — its JSON Schema
			// export erases (known, documented limitation).
			if (!isIndeterminateUnionError(error)) throw error;
		}
	}
	return decorate(
		schemaFromIR({
			k: "morph",
			input: { k: "unknown" },
			fn: (value, ctx) => {
				for (const member of schemas) {
					const result = member(value);
					if (!(result instanceof type.errors)) return result;
				}
				return ctx.error(`a union of ${schemas.length} variants`);
			},
		}),
	);
};
/**
 * The values `ir` can take when that set is finite — literals, `null`,
 * `undefined`, and unions of those (`z.enum`, a literal union). `undefined`
 * means the set is open, so nothing can be dispatched on it.
 */
function finiteValues(ir: IR, seen?: Set<IR>): unknown[] | undefined {
	switch (ir.k) {
		case "lit":
			return [ir.v];
		case "null":
			return [null];
		case "undefined":
			return [undefined];
		case "union": {
			const values: unknown[] = [];
			for (const member of ir.members) {
				const inner = finiteValues(member, seen);
				if (inner === undefined) return undefined;
				values.push(...inner);
			}
			return values.length > 0 ? values : undefined;
		}
		case "refine":
			return finiteValues(ir.base, seen);
		case "sub":
			return finiteValues(ir.schema.ir, seen);
		case "morph":
			return finiteValues(ir.input, seen);
		case "alias":
			return resolveAlias(ir, seen, (resolved, active) => finiteValues(resolved, active));
		default:
			return undefined;
	}
}

/**
 * Values a discriminated-union variant pins its discriminator to, or
 * `undefined` when the variant cannot be dispatched on at all: a non-object, an
 * object without the key, or a key whose value set is open (`kind: z.string()`,
 * which zod rejects — accepting it would validate arbitrary discriminators
 * through whichever variant happens to be tried first).
 *
 * Never called with an unresolved `z.lazy` inside: the caller skips those at
 * construction, where running the getter would break recursive definitions via
 * TDZ, and re-checks them at first parse when resolution is legal.
 */
function discriminatorValues(ir: IR, key: string, seen?: Set<IR>): unknown[] | undefined {
	switch (ir.k) {
		case "object": {
			const prop = ir.props.find(candidate => candidate.key === key);
			return prop === undefined ? undefined : finiteValues(prop.val, seen);
		}
		case "union": {
			const values: unknown[] = [];
			for (const member of ir.members) {
				const inner = discriminatorValues(member, key, seen);
				if (inner === undefined) return undefined;
				values.push(...inner);
			}
			return values.length > 0 ? values : undefined;
		}
		case "intersection": {
			for (const member of ir.members) {
				const inner = discriminatorValues(member, key, seen);
				if (inner !== undefined) return inner;
			}
			return undefined;
		}
		case "sub":
			return discriminatorValues(ir.schema.ir, key, seen);
		case "morph":
			// restrictBase wraps a stepped schema in a morph over its base IR.
			return discriminatorValues(ir.input, key, seen);
		case "alias":
			return resolveAlias(ir, seen, (resolved, active) => discriminatorValues(resolved, key, active));
		default:
			return undefined;
	}
}

/** Resolve an alias under a cycle guard; a re-entered alias yields nothing. */
function resolveAlias(
	ir: Extract<IR, { k: "alias" }>,
	seen: Set<IR> | undefined,
	visit: (resolved: IR, seen: Set<IR>) => unknown[] | undefined,
): unknown[] | undefined {
	if (seen?.has(ir)) return undefined;
	const active = seen ?? new Set<IR>();
	active.add(ir);
	return visit(ir.resolve(), active);
}

/**
 * Union dispatched on the discriminator property. Only the variants pinning the
 * discriminator to the input's value are attempted; if the input carries no
 * usable discriminator, every variant is attempted in order so failures still
 * report against the full union.
 *
 * A variant that cannot be dispatched on is rejected as a definition error,
 * matching zod: the public signature accepts any schema, so
 * `z.discriminatedUnion("kind", [z.string(), z.number()])` — or a variant
 * declaring `kind: z.string()` — would otherwise build a plain union that
 * validates arbitrary values through whichever variant is tried first,
 * silently dropping the dispatch contract the call advertises. Statically
 * inspectable variants throw at construction; a `z.lazy` variant is re-checked
 * once its getter has run, so wrapping the same invalid definition in `z.lazy`
 * cannot bypass the check.
 */
export const discriminatedUnion = <
	const Discriminator extends string,
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	discriminator: Discriminator,
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> => {
	const variantError = (index: number): OmpTypeError =>
		new OmpTypeError(
			`discriminatedUnion variant ${index} does not pin "${discriminator}" to a literal or enum value`,
		);
	// A variant carrying a deferred alias is accepted unresolved here and
	// re-checked at first parse: running the getter now would break recursive
	// definitions via TDZ.
	const variants = schemas.map(schema => ({
		schema: schema as ZodLikeSchema<unknown>,
		deferred: hasDeferredAlias(schema.ir),
		values: hasDeferredAlias(schema.ir) ? undefined : discriminatorValues(schema.ir, discriminator),
	}));
	/**
	 * Every discriminator value must be claimed by exactly one variant, as zod
	 * requires: two variants pinning `kind: "x"` make dispatch ambiguous, and
	 * the winner would be decided by declaration order alone.
	 *
	 * `resolved` says whether deferred getters have run: at construction a
	 * deferred variant's values are legitimately unknown and it is skipped,
	 * while afterwards every variant must have produced a value set.
	 */
	const claimDiscriminatorValues = (resolved: boolean): void => {
		const claims = new Map<unknown, number>();
		for (const [index, variant] of variants.entries()) {
			if (variant.values === undefined) {
				if (resolved || !variant.deferred) throw variantError(index);
				continue;
			}
			for (const value of variant.values) {
				const claimed = claims.get(value);
				if (claimed !== undefined) {
					throw new OmpTypeError(
						`discriminatedUnion variants ${claimed} and ${index} both pin "${discriminator}" to ${JSON.stringify(value) ?? String(value)}`,
					);
				}
				claims.set(value, index);
			}
		}
	};
	claimDiscriminatorValues(false);
	const variantIrs = schemas.map(schema => embed(schema));
	// Same gate as union() above: variants are embedded so stepped variants
	// keep their steps and their exported structure, only deferred aliases are
	// excluded up front, and omptype's determinism check arbitrates the rest —
	// distinct discriminator literals make the variants disjoint, so any-match
	// equals discriminator-dispatch. The dispatcher below is reserved for
	// variant sets omptype rejects as order-dependent.
	if (schemas.every(schema => !hasDeferredAlias(schema.ir))) {
		try {
			// Guarded at the combinator boundary, not per variant: a discriminated
			// union's input is an object by definition, yet a stripping variant
			// whose discriminator carries a default (`kind: z.literal("a")
			// .default("a")`) would otherwise morph `[]` into `{ kind: "a" }`.
			return decorate(guardArrays(schemaFromIR<UnionOutput<Schemas>>({ k: "union", members: variantIrs })));
		} catch (error) {
			// Same fallback as union(): variants whose discriminators do not
			// disjointly pin literals (e.g. optional discriminators overlapping
			// another variant) are order-dependent — keep the dispatcher.
			if (!isIndeterminateUnionError(error)) throw error;
		}
	}
	let checked = !variants.some(variant => variant.deferred);
	const dispatch = type.unknown.pipe((value, ctx) => {
		if (!checked) {
			// First parse: resolution is now legal, so a `z.lazy` variant that
			// never pins the discriminator — or collides with another variant's
			// value — surfaces as the same definition error instead of quietly
			// matching every object. The flag is set only after every variant
			// passes, so a broken definition keeps throwing.
			for (const variant of variants) {
				if (variant.deferred) variant.values = discriminatorValues(variant.schema.ir, discriminator);
			}
			claimDiscriminatorValues(true);
			checked = true;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return ctx.error(`an object with a "${discriminator}" discriminator`);
		}
		let candidates = variants;
		const disc = (value as Record<string, unknown>)[discriminator];
		const matched = variants.filter(variant => variant.values?.includes(disc) === true);
		if (matched.length > 0) candidates = matched;
		for (const variant of candidates) {
			const result = variant.schema(value);
			if (!(result instanceof type.errors)) return result;
		}
		return ctx.error(`a "${discriminator}" union variant`);
	});
	return decorate(dispatch as Decoratable<unknown>) as ZodLikeSchema<UnionOutput<Schemas>>;
};
/** Defer schema construction until first parse — required for recursive shapes. */
export const lazy = <Out>(getter: () => ZodLikeSchema<Out>): ZodLikeSchema<Out> => {
	let resolved: ZodLikeSchema<Out> | undefined;
	let resolving = false;
	const ir: IR = {
		k: "alias",
		// Deliberately NOT a globally counted name: `emit` uniquifies colliding
		// `$defs` keys per document, so distinct lazies still land on distinct
		// entries while the emitted key (and the schema's `description`) stays
		// a function of the document alone. A module-level counter would make
		// tool-definition bytes — and every prompt-cache hit keyed on them —
		// depend on plugin construction order.
		name: "lazy",
		deferred: true,
		resolve: () => {
			// `embed`, not `.ir`: a getter returning a stepped schema
			// (`z.string().refine(…)`, `.transform()`, `.catch()`,
			// `.readonly()`) keeps those steps on the schema wrapper, so
			// resolving to the bare base IR would drop them — the lazy schema
			// would accept values its own refinement rejects and hand back
			// untransformed output. A `sub` node keeps the steps and still
			// exports the structural base.
			if (resolved !== undefined) return embed(resolved);
			// Re-entrant resolve while the getter is still building the schema
			// (recursive definitions — the getter references this very schema):
			// resolve to the alias itself. Every walker is cycle-safe on alias
			// re-entry, and later resolves return the memoized real IR.
			if (resolving) return ir;
			resolving = true;
			try {
				resolved = getter();
			} finally {
				resolving = false;
			}
			return embed(resolved);
		},
	};
	// The IR's cycle-safe alias node, not a runtime morph closure: the emitter
	// registers the alias before recursing and emits `$ref: "#/$defs/<name>"`,
	// so recursive parameter schemas export as real `$ref`/`$defs` documents
	// instead of erasing to an unconstrained `{}`. `deferred` keeps
	// construction-time scans from calling the getter — resolving earlier
	// would break recursive `const` definitions (TDZ) and violate zod's
	// defer-to-first-parse contract.
	return decorate(schemaFromIR<Out>(ir));
};
export const array = <Element>(element: ZodLikeSchema<Element>): ZodLikeSchema<Element[]> =>
	decorate(schemaFromIR({ k: "array", el: embed(element) }));
export const object = <const S extends Shape>(shape: S): ZodLikeSchema<Simplify<ObjectOutput<S>>> =>
	objectSchema(shape);
/** Object that rejects undeclared keys (zod `z.strictObject`). */
export const strictObject = <const S extends Shape>(shape: S): ZodLikeSchema<Simplify<ObjectOutput<S>>> =>
	objectSchema(shape, "reject");
export const looseObject = <const S extends Shape>(
	shape: S,
): ZodLikeSchema<Simplify<ObjectOutput<S>> & Record<string, unknown>> =>
	objectSchema(shape, "keep") as ZodLikeSchema<Simplify<ObjectOutput<S>> & Record<string, unknown>>;
export const record = <Key extends string, Value>(
	keySchema: ZodLikeSchema<Key>,
	valueSchema: ZodLikeSchema<Value>,
): ZodLikeSchema<Record<string, Value>> => {
	if (!isStringKeyIR(keySchema.ir)) throw new OmpTypeError("record keys must use a string schema");
	const base = schemaFromIR<Record<string, Value>>({
		k: "object",
		props: [],
		index: embed(valueSchema),
		extras: "keep",
	});
	const checked = guardArrays(base).narrow((value, ctx: NarrowContext) => {
		for (const key in value) {
			if (keySchema(key) instanceof type.errors) return ctx.mustBe("a record with valid string keys");
		}
		return true;
	});
	return decorate(checked);
};
export const unknown = (): ZodLikeSchema<unknown> => decorate(schemaFromIR(type.unknown.ir));
export const any = (): ZodLikeSchema<unknown> => decorate(schemaFromIR(type.unknown.ir));
const nullSchema = (): ZodLikeSchema<null> => decorate(type.raw("null") as unknown as Decoratable<null>);
const undefinedSchema = (): ZodLikeSchema<undefined> =>
	decorate(type.raw("undefined") as unknown as Decoratable<undefined>);

export { nullSchema as null, undefinedSchema as undefined };

/** Runtime `z.*` facade, merged with the `z.infer` type namespace below. */
export const z = {
	string,
	number,
	boolean,
	literal,
	enum: enumSchema,
	union,
	array,
	object,
	strictObject,
	looseObject,
	discriminatedUnion,
	lazy,
	record,
	unknown,
	any,
	null: nullSchema,
	undefined: undefinedSchema,
};
export namespace z {
	/** Alias of {@link ZodLikeSchema} under zod's historical name; `Input` mirrors zod's two-parameter arity. */
	// biome-ignore lint/correctness/noUnusedVariables: Input exists only to mirror zod's ZodType<Out, Input> arity.
	export type ZodType<Out = unknown, Input = unknown> = ZodLikeSchema<Out>;
	export type infer<Schema> = Schema extends { readonly _output: infer Out } ? Out : never;
	/** Structural counterpart of zod's `ZodError`: the safeParse failure payload. */
	export interface ZodError<Out = unknown> {
		readonly message: string;
		readonly issues: ZodLikeIssue[];
		/** Phantom marker keeping zod's output type parameter attached. */
		readonly _output?: Out;
	}
}

/** Module-level aliases of the `z` namespace types under their bare names. */
// biome-ignore lint/correctness/noUnusedVariables: Input exists only to mirror zod's ZodType<Out, Input> arity.
export type ZodType<Out = unknown, Input = unknown> = z.ZodType<Out>;
export type ZodError<Out = unknown> = z.ZodError<Out>;
