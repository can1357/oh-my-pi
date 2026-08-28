import { type OmpErrors, OmpTypeError } from "./errors";
import {
	type EmbeddableSchema,
	type Extras,
	embed,
	type IR,
	IR_BRAND,
	isStructurallyExportable,
	type PropIR,
} from "./ir";
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
	describe(description: string): ZodLikeSchema<Out>;
	refine(predicate: (value: Out) => unknown, messageOrOptions?: string | RefineOptions): ZodLikeSchema<Out>;
	transform<Next>(transformer: (value: Out) => Next): ZodLikeSchema<Next>;
	catch(fallback: Out | (() => Out)): ZodLikeSchema<Out>;
	strict(): ZodLikeSchema<Out>;
	passthrough(): ZodLikeSchema<Out & Record<string, unknown>>;
	strip(): ZodLikeSchema<Out>;
	partial(): Out extends object ? ZodLikeSchema<Partial<Out>> : ZodLikeSchema<Out>;
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
	fallback: (() => Out) | undefined,
): Decoratable<Out | undefined> {
	return schemaFromIR<Out | undefined>({
		k: "morph",
		input: { k: "unknown" },
		fn: (input, ctx) => {
			if (input === undefined) {
				return fallback === undefined ? undefined : fallback();
			}
			const result = schema(input);
			if (!(result instanceof type.errors)) return result;
			return ctx.error(fallback === undefined ? "the schema or undefined" : "the default or a valid value");
		},
	});
}

function restrictBase<Out>(source: Decoratable<Out>, ir: IR): Decoratable<Out> {
	let next = source.hasSteps
		? schemaFromIR<Out>({ k: "morph", input: ir, fn: value => source(value) })
		: schemaFromIR<Out>(ir);
	if (source.ir.desc !== undefined) next = next.describe(source.ir.desc);
	if (source.hasDefault) next = next.default(source.defaultValue as Out | (() => Out));
	return next;
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
			// Structurally exportable inner schemas keep a real union so structural
			// metadata (JSON Schema export, descriptions) survives the widening.
			// Anything carrying a runtime pipeline takes the dispatch morph below:
			// `isStructurallyExportable(ir)` rejects in-IR morphs and stepped
			// embedded schemas, and `hasSteps` covers Type-attached
			// `.transform()`/`.refine()` steps the IR alone cannot see — rebuilding
			// from `schema.ir` would silently DROP those steps, not just degrade
			// the emitted JSON Schema.
			if (!schema.hasSteps && isStructurallyExportable(schema.ir)) {
				return decorate(
					schemaFromIR<Out | undefined>({ k: "union", members: [schema.ir, { k: "undefined" }] }),
					true,
				) as ZodLikeSchema<Out | undefined> & OptionalSchemaMarker;
			}
			return decorate(undefinedDispatch<Out>(schema, undefined), true) as ZodLikeSchema<Out | undefined> &
				OptionalSchemaMarker;
		},
		nullable(): ZodLikeSchema<Out | null> {
			// Structurally exportable inner schemas keep a real union so structural
			// metadata (JSON Schema export for provider tool definitions) survives
			// the widening — the dispatcher morph below erases the IR, emitting
			// `{}` for the member. Same pipeline gate as optional() above.
			if (!schema.hasSteps && isStructurallyExportable(schema.ir)) {
				return decorate(
					schemaFromIR<Out | null>({ k: "union", members: [schema.ir, { k: "lit", v: null }] }),
					optional,
				) as ZodLikeSchema<Out | null>;
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
			// Structurally exportable inner schemas keep the original union+pipe
			// composition so structural metadata survives JSON-Schema export.
			if (isStructurallyExportable(schema.ir)) {
				const widened = schema.or(type.raw("undefined")) as Decoratable<Out | undefined>;
				const pipedPlain = widened.pipe(output => {
					if (output !== undefined) return output as DefaultOut;
					return typeof value === "function" ? (value as () => DefaultOut)() : value;
				}) as unknown as Decoratable<DefaultOut>;
				const plain = decorate(pipedPlain);
				Object.defineProperty(plain, "hasDefault", { value: true, enumerable: false });
				Object.defineProperty(plain, "defaultValue", { value, enumerable: false });
				return plain;
			}
			const fallback = value;
			const piped = decorate(
				schemaFromIR<DefaultOut>({
					k: "morph",
					input: { k: "unknown" },
					fn: (input, ctx) => {
						if (input === undefined) {
							return typeof fallback === "function" ? (fallback as () => DefaultOut)() : fallback;
						}
						const result = schema(input);
						if (!(result instanceof type.errors)) return result;
						return ctx.error("the default or a valid value");
					},
				}),
			) as unknown as Decoratable<DefaultOut>;
			const result = decorate(piped);
			// Stamp the default metadata objectSchema() reads when embedding this
			// schema as a property: the prop must stay optional with this fallback.
			Object.defineProperty(result, "hasDefault", { value: true, enumerable: false });
			Object.defineProperty(result, "defaultValue", { value, enumerable: false });
			return result;
		},
		describe(description: string): ZodLikeSchema<Out> {
			return next(restrictBase(schema, { ...schema.ir, desc: description }).describe(description));
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
		 * cast, it shallow-freezes successful parse output (`Object.freeze`,
		 * one level deep — a nested object is left mutable, exactly like Zod).
		 *
		 * Zod freezes its own freshly constructed parse output; omptype's
		 * parsing shares structure with the input (a parent copy keeps child
		 * references), so freezing in place would freeze the CALLER's input
		 * graph — e.g. a persisted session entry schema-validated before blob
		 * hydration must stay mutable. Shallow-clone first (object spread uses
		 * define semantics, so an own `__proto__` key survives), then freeze
		 * the clone.
		 *
		 * Only plain objects and arrays are cloned+frozen. A non-plain object
		 * (a Date/Map/class instance reachable via `z.unknown()`/`z.any()`/a
		 * transform) has no non-destructive shallow clone — spreading it would
		 * produce a prototype-less husk with no internal slots — and freezing
		 * it in place would mutate the caller's value, so it passes through
		 * untouched: never-freeze-the-input outranks freeze-the-output for the
		 * shim's JSON-oriented use. Primitives and functions pass through for
		 * the same reason.
		 */
		readonly(): ZodLikeSchema<Readonly<Out>> {
			return next(
				schema.pipe(value => {
					if (typeof value !== "object" || value === null) return value;
					const proto = Object.getPrototypeOf(value);
					if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
					const clone = Array.isArray(value) ? [...(value as unknown[])] : { ...(value as object) };
					return Object.freeze(clone) as Out;
				}),
			) as ZodLikeSchema<Readonly<Out>>;
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
	return decorateUnknown(schemaFromIR<unknown>({ k: "object", props, extras })) as unknown as ZodLikeSchema<
		ObjectOutput<S>
	>;
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
// The dispatcher is reserved for unions that actually carry a pipeline: a
// structurally exportable union stays structural, because the morph wrapper
// erases the IR and `toJsonSchema()` then emits `{}` for the member — a
// provider-facing tool parameter would appear unconstrained. For pure
// validators any-match equals first-match, so zod's ordering is not
// observable there.
export const union = <
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> => {
	const members = schemas.map(schema => schema);
	const irs = members.map(member => member.ir);
	// Same pipeline gate as optional()/nullable(): `hasSteps` covers
	// Type-attached transform/refine steps the member IR cannot see.
	if (members.every(member => !member.hasSteps) && irs.every(ir => isStructurallyExportable(ir))) {
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
				for (const member of members) {
					const result = member(value);
					if (!(result instanceof type.errors)) return result;
				}
				return ctx.error(`a union of ${members.length} variants`);
			},
		}),
	);
};
const NO_DISCRIMINANT = Symbol("omptype.zod.noDiscriminant");

/**
 * Literal value a discriminated-union variant pins the discriminator to, read
 * straight off its structural IR; {@link NO_DISCRIMINANT} when unknowable.
 */
function discriminantLiteral(ir: IR, key: string): unknown {
	if (ir.k !== "object") return NO_DISCRIMINANT;
	for (const prop of ir.props) {
		if (prop.key === key) return prop.val.k === "lit" ? prop.val.v : NO_DISCRIMINANT;
	}
	return NO_DISCRIMINANT;
}

/**
 * Union dispatched on a literal discriminator property. Variants whose IR pins
 * the discriminator to the input's value are tried first; when nothing matches
 * (or no variant declares a usable literal), every variant is attempted in
 * order so failures still report against the full union.
 */
export const discriminatedUnion = <
	const Discriminator extends string,
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	discriminator: Discriminator,
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> => {
	const variantIrs = schemas.map(schema => schema.ir);
	// Same pipeline gate as union() above: a structurally exportable variant
	// set keeps a real structural union so JSON Schema export (provider tool
	// definitions) survives — distinct discriminator literals make the
	// variants disjoint, so any-match equals discriminator-dispatch for pure
	// validators. The literal dispatcher below is reserved for variant sets
	// carrying morphs or Type-attached steps.
	if (schemas.every(schema => !schema.hasSteps) && variantIrs.every(ir => isStructurallyExportable(ir))) {
		try {
			return decorate(schemaFromIR<UnionOutput<Schemas>>({ k: "union", members: variantIrs }));
		} catch (error) {
			// Same fallback as union(): variants whose discriminators do not
			// disjointly pin literals (e.g. optional discriminators overlapping
			// another variant) are order-dependent — keep the literal dispatcher.
			if (!isIndeterminateUnionError(error)) throw error;
		}
	}
	const variants = schemas.map(schema => ({
		schema: schema as ZodLikeSchema<unknown>,
		literal: discriminantLiteral(schema.ir, discriminator),
	}));
	const dispatch = type.unknown.pipe((value, ctx) => {
		if (typeof value !== "object" || value === null) {
			return ctx.error(`an object with a "${discriminator}" discriminator`);
		}
		let candidates = variants;
		const disc = (value as Record<string, unknown>)[discriminator];
		if (disc !== undefined) {
			const matched = variants.filter(variant => variant.literal === disc);
			if (matched.length > 0) candidates = matched;
		}
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
	return decorate(
		schemaFromIR<Out>({
			k: "morph",
			input: { k: "unknown" },
			fn: value => {
				resolved ??= getter();
				return resolved(value);
			},
		}),
	);
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
	const checked = base.narrow((value, ctx: NarrowContext) => {
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
