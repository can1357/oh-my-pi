import { OmpTypeError } from "./errors";
import type { Def, EmbeddableSchema } from "./ir";
import { type NarrowContext, type Type as OmpType, type ToJsonSchemaOptions, type } from "./type";

export interface Meta {
	title?: string;
	description?: string;
	default?: unknown;
	examples?: unknown[];
	[key: string]: unknown;
}

export interface StringOpts extends Meta {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
}

export interface NumberOpts extends Meta {
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
}

export interface ArrayOpts extends Meta {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
}

export interface ObjectOpts extends Meta {
	additionalProperties?: boolean | AnySchema;
}
const OPTIONAL_INNER = Symbol("omptype.typebox.optionalInner");
const OBJECT_INFO = Symbol("omptype.typebox.objectInfo");

export interface TypeBoxValidationFailure {
	message: string;
}

export type TypeBoxSafeParseResult<T> =
	| { success: true; data: T }
	| { success: false; error: TypeBoxValidationFailure };

interface LegacyTypeBoxCompat<T> {
	/** TypeBox compatibility validator used by legacy extension loaders. */
	__validator(data: unknown): T | TypeBoxValidationFailure;
	/** Zod-style compatibility parser used by legacy extensions. */
	safeParse(input: unknown): TypeBoxSafeParseResult<T>;
}

/**
 * Erased schema surface accepted anywhere this facade takes a schema, native
 * omptype schemas included (those carry no legacy compat members).
 *
 * Members use method syntax so parameter positions stay bivariant: the typed
 * {@link TTyped} form is invariant in its static type (its `in`/`out`
 * validators are), so a concrete `TString` is not assignable to
 * `TTyped<unknown>`. Erasing here is what keeps `TString`, `TObject<…>` and
 * friends assignable to a plain schema annotation.
 */
export interface AnySchema extends EmbeddableSchema {
	(data: unknown): unknown;
	readonly infer: unknown;
	readonly hasSteps: boolean;
	toJsonSchema(options?: ToJsonSchemaOptions): Record<string, unknown>;
}

/**
 * Every schema this facade returns: the TypeBox `TSchema` analog. Erased like
 * {@link AnySchema}, plus the legacy compat members builder results carry.
 */
export interface TSchema extends AnySchema {
	/** TypeBox compatibility validator used by legacy extension loaders. */
	__validator(data: unknown): unknown;
	/** Zod-style compatibility parser used by legacy extensions. */
	safeParse(input: unknown): TypeBoxSafeParseResult<unknown>;
}

/** Schema carrying a statically known type; every `TXxx` alias resolves here. */
export type TTyped<T> = OmpType<T> & LegacyTypeBoxCompat<T>;
export type Static<T extends AnySchema> = T["infer"];
export type TAny = TTyped<unknown>;
export type TUnknown = TTyped<unknown>;
export type TNever = TTyped<never>;
export type TNull = TTyped<null>;
export type TString = TTyped<string>;
export type TNumber = TTyped<number>;
export type TInteger = TTyped<number>;
export type TBoolean = TTyped<boolean>;
export type TLiteral<V extends string | number | boolean | null> = TTyped<V>;
export type TArray<E extends AnySchema> = TTyped<Static<E>[]>;
export type TTuple<E extends readonly AnySchema[] = readonly AnySchema[]> = TTyped<{
	-readonly [K in keyof E]: Static<E[K]>;
}>;
export type TOptional<E extends AnySchema> = TTyped<Static<E> | undefined> & { readonly [OPTIONAL_INNER]: E };
export type TUnion<E extends readonly AnySchema[] = readonly AnySchema[]> = TTyped<Static<E[number]>>;
export type TIntersect<E extends readonly AnySchema[] = readonly AnySchema[]> = TTyped<
	UnionToIntersection<Static<E[number]>>
>;
export type TEnum<E extends readonly (string | number)[] = readonly (string | number)[]> = TTyped<E[number]>;
export type TRecord<K extends AnySchema, V extends AnySchema> = TTyped<
	Record<Extract<Static<K>, PropertyKey>, Static<V>>
>;
export type TNullable<E extends AnySchema> = TTyped<Static<E> | null>;
export type TReadonly<E extends AnySchema> = TTyped<Readonly<Static<E>>>;
export type TUnsafe<T = unknown> = TTyped<T>;

type OptionalKeys<P extends Record<string, AnySchema>> = {
	[K in keyof P]-?: P[K] extends { readonly [OPTIONAL_INNER]: AnySchema } ? K : never;
}[keyof P];
type RequiredKeys<P extends Record<string, AnySchema>> = Exclude<keyof P, OptionalKeys<P>>;
type ObjectStatic<P extends Record<string, AnySchema>> = {
	[K in RequiredKeys<P>]: Static<P[K]>;
} & {
	[K in OptionalKeys<P>]?: Exclude<Static<P[K]>, undefined>;
};
export type TObject<P extends Record<string, AnySchema> = Record<string, AnySchema>> = TTyped<ObjectStatic<P>>;
type RequiredProps<P extends Record<string, AnySchema>> = {
	[K in keyof P]: P[K] extends TOptional<infer E> ? E : P[K];
};

interface RuntimeType<T> extends OmpType<T> {
	[OPTIONAL_INNER]?: AnySchema;
	[OBJECT_INFO]?: ObjectInfo;
	describe(description: string): RuntimeType<T>;
	default(value: T | (() => T)): RuntimeType<T>;
	or<schema extends AnySchema>(schema: schema): RuntimeType<T | Static<schema>>;
	and<schema extends AnySchema>(schema: schema): RuntimeType<T & Static<schema>>;
	array(): RuntimeType<T[]>;
	atLeastLength(bound: number): RuntimeType<T>;
	atMostLength(bound: number): RuntimeType<T>;
	atLeast(bound: number): RuntimeType<T>;
	atMost(bound: number): RuntimeType<T>;
	narrow<N extends T>(predicate: (value: T, ctx: NarrowContext) => value is N): RuntimeType<N>;
	narrow(predicate: (value: T, ctx: NarrowContext) => boolean): RuntimeType<T>;
}
type CompatRuntime<T> = RuntimeType<T> & LegacyTypeBoxCompat<T>;

type ObjectInfo = {
	props: Record<string, AnySchema>;
	additionalProperties?: boolean | AnySchema;
};

function asRuntime<T>(schema: AnySchema): RuntimeType<T> {
	return schema as unknown as RuntimeType<T>;
}

function asSchema<T>(schema: AnySchema): TTyped<T> {
	return schema as unknown as TTyped<T>;
}

function validationFailure(message: string): TypeBoxValidationFailure {
	return { message };
}

function withLegacyCompat<T>(schema: OmpType<T>): CompatRuntime<T> {
	const compatSchema = schema as unknown as CompatRuntime<T>;
	if (!Object.hasOwn(compatSchema, "__validator")) {
		Object.defineProperty(compatSchema, "__validator", {
			value: (data: unknown): T | TypeBoxValidationFailure => {
				const result = schema(data);
				return result instanceof type.errors ? validationFailure(result.summary) : result;
			},
			configurable: true,
		});
	}
	if (!Object.hasOwn(compatSchema, "safeParse")) {
		Object.defineProperty(compatSchema, "safeParse", {
			value: (input: unknown): TypeBoxSafeParseResult<T> => {
				const result = schema(input);
				return result instanceof type.errors
					? { success: false, error: validationFailure(result.summary) }
					: { success: true, data: result };
			},
			configurable: true,
		});
	}
	return compatSchema;
}

function applyMeta<T>(schema: RuntimeType<T>, opts?: Meta): CompatRuntime<T> {
	let result = schema;
	const description = opts?.description ?? opts?.title;
	if (description !== undefined) result = result.describe(description);
	if (opts && Object.hasOwn(opts, "default")) result = result.default(opts.default as T);
	return withLegacyCompat(result);
}

function withJsonSchemaKeywords<T>(schema: CompatRuntime<T>, keywords: Record<string, unknown>): CompatRuntime<T> {
	const emitBase = schema.toJsonSchema.bind(schema);
	schema.toJsonSchema = options => ({ ...emitBase(options), ...keywords });
	return schema;
}

function checkFiniteOption(name: string, value: number | undefined): void {
	if (value !== undefined && !Number.isFinite(value)) throw new OmpTypeError(`${name} must be finite`);
}

function tString(opts?: StringOpts): TString {
	checkFiniteOption("minLength", opts?.minLength);
	checkFiniteOption("maxLength", opts?.maxLength);
	let schema = asRuntime<string>(type.raw(opts?.format === "url" || opts?.format === "uri" ? "string.url" : "string"));
	if (opts?.minLength !== undefined) schema = schema.atLeastLength(opts.minLength);
	if (opts?.maxLength !== undefined) schema = schema.atMostLength(opts.maxLength);
	if (opts?.pattern !== undefined) {
		let regex: RegExp;
		try {
			regex = new RegExp(opts.pattern);
		} catch {
			throw new OmpTypeError(`invalid regular expression pattern ${JSON.stringify(opts.pattern)}`);
		}
		schema = schema.narrow((value, ctx) => regex.test(value) || ctx.mustBe(`a string matching ${opts.pattern}`));
	}
	if (opts?.format !== undefined && opts.format !== "url" && opts.format !== "uri") {
		const format = opts.format;
		const valid = formatPredicate(format);
		schema = schema.narrow((value, ctx) => valid(value) || ctx.mustBe(`a string in ${format} format`));
	}
	const result = applyMeta(schema, opts);
	const keywords: Record<string, unknown> = {};
	if (opts?.pattern !== undefined) keywords.pattern = opts.pattern;
	if (opts?.format !== undefined) keywords.format = opts.format === "url" ? "uri" : opts.format;
	return opts?.pattern !== undefined || opts?.format !== undefined ? withJsonSchemaKeywords(result, keywords) : result;
}

function formatPredicate(format: string): (value: string) => boolean {
	switch (format) {
		case "url":
		case "uri":
			return value => {
				try {
					new URL(value);
					return true;
				} catch {
					return false;
				}
			};
		case "email":
			return value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
		case "uuid":
			return value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
		case "date-time":
			return value =>
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
				!Number.isNaN(Date.parse(value));
		case "date":
			return value => /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
		default:
			return () => true;
	}
}

function tNumber(opts?: NumberOpts, integer = false): TNumber {
	for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
		checkFiniteOption(key, opts?.[key]);
	}
	if (opts?.multipleOf !== undefined && opts.multipleOf <= 0)
		throw new OmpTypeError("multipleOf must be greater than zero");
	let lower: { value: number; exclusive: boolean } | undefined;
	if (opts?.minimum !== undefined) lower = { value: opts.minimum, exclusive: false };
	if (opts?.exclusiveMinimum !== undefined && (!lower || opts.exclusiveMinimum >= lower.value)) {
		lower = { value: opts.exclusiveMinimum, exclusive: true };
	}
	let upper: { value: number; exclusive: boolean } | undefined;
	if (opts?.maximum !== undefined) upper = { value: opts.maximum, exclusive: false };
	if (opts?.exclusiveMaximum !== undefined && (!upper || opts.exclusiveMaximum <= upper.value)) {
		upper = { value: opts.exclusiveMaximum, exclusive: true };
	}
	const keyword = integer ? "number.integer" : "number";
	// The `LO <= TYPE <= HI` range spelling requires both bounds; a min-only
	// bound must use the postfix `TYPE >= LO` form (see parseBounded in ir.ts).
	let src: string;
	if (lower && upper) {
		src = `${lower.value} ${lower.exclusive ? "<" : "<="} ${keyword} ${upper.exclusive ? "<" : "<="} ${upper.value}`;
	} else if (lower) {
		src = `${keyword} ${lower.exclusive ? ">" : ">="} ${lower.value}`;
	} else if (upper) {
		src = `${keyword} ${upper.exclusive ? "<" : "<="} ${upper.value}`;
	} else {
		src = keyword;
	}
	let schema = asRuntime<number>(type.raw(src));
	if (opts?.multipleOf !== undefined) {
		const divisor = opts.multipleOf;
		schema = schema.narrow((value, ctx) => {
			const quotient = value / divisor;
			return (
				Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) ||
				ctx.mustBe(`a multiple of ${divisor}`)
			);
		});
	}
	const result = applyMeta(schema, opts);
	return opts?.multipleOf !== undefined ? withJsonSchemaKeywords(result, { multipleOf: opts.multipleOf }) : result;
}

function tLiteral<const V extends string | number | boolean | null>(value: V, opts?: Meta): TLiteral<V> {
	return applyMeta(asRuntime<V>(type.enumerated(value)), opts);
}

function tNever(opts?: Meta): TNever {
	return applyMeta(
		asRuntime<unknown>(type.raw("unknown")).narrow((_value, ctx): _value is never => ctx.mustBe("never")),
		opts,
	);
}

function tUnion<const E extends readonly AnySchema[]>(schemas: E, opts?: Meta): TUnion<E> {
	if (schemas.length === 0) return asSchema<Static<E[number]>>(tNever(opts));
	let result = asRuntime<unknown>(schemas[0]);
	for (let i = 1; i < schemas.length; i++) result = result.or(schemas[i]);
	return asSchema<Static<E[number]>>(applyMeta(result, opts));
}

function tIntersect<const E extends readonly AnySchema[]>(
	schemas: E,
	opts?: Meta,
): TTyped<UnionToIntersection<Static<E[number]>>> {
	if (schemas.length === 0) {
		return applyMeta(asRuntime<UnionToIntersection<Static<E[number]>>>(type.raw("unknown")), opts);
	}
	const validateAll = (): RuntimeType<UnionToIntersection<Static<E[number]>>> => {
		const base = asRuntime<unknown>(type.raw("unknown"));
		return base.narrow((value, ctx): value is UnionToIntersection<Static<E[number]>> => {
			for (const schema of schemas) {
				if (schema(value) instanceof type.errors) return ctx.mustBe("a value satisfying every intersection member");
			}
			return true;
		});
	};
	if (schemas.some(schema => schema.hasSteps)) return applyMeta(validateAll(), opts);
	let result = asRuntime<unknown>(schemas[0]);
	try {
		for (let i = 1; i < schemas.length; i++) result = result.and(schemas[i]);
	} catch (error) {
		if (error instanceof OmpTypeError) return applyMeta(validateAll(), opts);
		throw error;
	}
	return asSchema<UnionToIntersection<Static<E[number]>>>(applyMeta(result, opts));
}
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
	? I
	: never;

function enumValues(values: Record<string, string | number> | readonly (string | number)[]): (string | number)[] {
	if (Array.isArray(values)) return [...values];
	const result: (string | number)[] = [];
	const record = values as Record<string, string | number>;
	for (const key in record) {
		const value = record[key];
		if (!(/^\d+$/.test(key) && typeof value === "string") && !result.includes(value)) result.push(value);
	}
	return result;
}

function tEnum<const E extends Record<string, string | number> | readonly (string | number)[]>(
	values: E,
	opts?: Meta,
): TTyped<E extends readonly (infer V)[] ? V : E[keyof E]> {
	return applyMeta(
		asRuntime<E extends readonly (infer V)[] ? V : E[keyof E]>(type.enumerated(...enumValues(values))),
		opts,
	);
}

function tArray<E extends AnySchema>(item: E, opts?: ArrayOpts): TArray<E> {
	checkFiniteOption("minItems", opts?.minItems);
	checkFiniteOption("maxItems", opts?.maxItems);
	let schema = asRuntime<Static<E>>(item).array();
	if (opts?.minItems !== undefined) schema = schema.atLeastLength(opts.minItems);
	if (opts?.maxItems !== undefined) schema = schema.atMostLength(opts.maxItems);
	if (opts?.uniqueItems) {
		schema = schema.narrow((values, ctx) => {
			for (let i = 0; i < values.length; i++) {
				for (let j = i + 1; j < values.length; j++) {
					if (jsonEqual(values[i], values[j])) return ctx.mustBe("an array with unique items");
				}
			}
			return true;
		});
	}
	const result = applyMeta(schema, opts);
	return opts?.uniqueItems ? withJsonSchemaKeywords(result, { uniqueItems: true }) : result;
}

function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function tTuple<const E extends readonly AnySchema[]>(items: E, opts?: Meta): TTuple<E> {
	const schema = asRuntime<unknown>(type.raw("unknown")).narrow(
		(value, ctx): value is { -readonly [K in keyof E]: Static<E[K]> } => {
			if (!Array.isArray(value) || value.length !== items.length)
				return ctx.mustBe(`a tuple of length ${items.length}`);
			for (let i = 0; i < items.length; i++)
				if (items[i](value[i]) instanceof type.errors) return ctx.mustBe(`a valid item at index ${i}`);
			return true;
		},
	);
	return applyMeta(schema, opts);
}

function tObject<const P extends Record<string, AnySchema>>(properties: P, opts?: ObjectOpts): TObject<P> {
	const def: Record<string, Def> = {};
	const props: Record<string, AnySchema> = {};
	for (const key in properties) {
		const schema = properties[key];
		const inner = asRuntime<unknown>(schema)[OPTIONAL_INNER];
		// A defaulted `Type.Optional(...)` maps to a plain defaulted key:
		// omptype (like ArkType) rejects `key?` with a default, and a default
		// already makes the key omittable on input.
		const optionalKey = inner !== undefined && !asRuntime<unknown>(inner).hasDefault;
		def[optionalKey ? `${key}?` : key] = inner ?? schema;
		props[key] = schema;
	}
	if (opts?.additionalProperties === false) def["+"] = "reject";
	else if (opts?.additionalProperties && opts.additionalProperties !== true)
		def["[string]"] = opts.additionalProperties;
	const schema = applyMeta(asRuntime<ObjectStatic<P>>(type.raw(def)), opts);
	schema[OBJECT_INFO] = { props, additionalProperties: opts?.additionalProperties };
	return schema;
}

function tRecord<K extends AnySchema, V extends AnySchema>(key: K, value: V, opts?: Meta): TRecord<K, V> {
	const base = asRuntime<Record<string, Static<V>>>(type.raw({ "[string]": value })).narrow((record, ctx) => {
		for (const name in record)
			if (key(name) instanceof type.errors) return ctx.mustBe("an object with valid record keys");
		return true;
	});
	return applyMeta(base, opts) as TRecord<K, V>;
}

function tOptional<E extends AnySchema>(schema: E, opts?: Meta): TOptional<E> {
	const marker = applyMeta(
		asRuntime<Static<E>>(schema).or(asRuntime<undefined>(type.raw("undefined"))),
		opts,
	) as RuntimeType<Static<E> | undefined>;
	marker[OPTIONAL_INNER] = schema;
	return marker as unknown as TOptional<E>;
}

function tNullable<E extends AnySchema>(schema: E, opts?: Meta): TTyped<Static<E> | null> {
	return applyMeta(asRuntime<Static<E>>(schema).or(asRuntime<null>(type.raw("null"))), opts);
}

function requireObject(schema: AnySchema, operation: string): ObjectInfo {
	const info = asRuntime<unknown>(schema)[OBJECT_INFO];
	if (!info) throw new OmpTypeError(`Type.${operation} requires a schema created by Type.Object`);
	return info;
}

function tPartial<P extends Record<string, AnySchema>>(schema: TObject<P>): TTyped<Partial<ObjectStatic<P>>> {
	const info = requireObject(schema, "Partial");
	const props: Record<string, AnySchema> = {};
	for (const key in info.props)
		props[key] = asRuntime<unknown>(info.props[key])[OPTIONAL_INNER] ? info.props[key] : tOptional(info.props[key]);
	return tObject(props, { additionalProperties: info.additionalProperties }) as TTyped<Partial<ObjectStatic<P>>>;
}

function tRequired<P extends Record<string, AnySchema>>(schema: TObject<P>): TObject<RequiredProps<P>> {
	const info = requireObject(schema, "Required");
	const props: Record<string, AnySchema> = {};
	for (const key in info.props) {
		props[key] = asRuntime<unknown>(info.props[key])[OPTIONAL_INNER] ?? info.props[key];
	}
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<RequiredProps<P>>;
}

function tPick<P extends Record<string, AnySchema>, const K extends readonly (keyof P)[]>(
	schema: TObject<P>,
	keys: K,
): TObject<Pick<P, K[number]>> {
	const info = requireObject(schema, "Pick");
	const props: Record<string, AnySchema> = {};
	for (const key of keys) if (typeof key === "string" && info.props[key]) props[key] = info.props[key];
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<Pick<P, K[number]>>;
}

function tOmit<P extends Record<string, AnySchema>, const K extends readonly (keyof P)[]>(
	schema: TObject<P>,
	keys: K,
): TObject<Omit<P, K[number]>> {
	const info = requireObject(schema, "Omit");
	const omitted = new Set<PropertyKey>(keys);
	const props: Record<string, AnySchema> = {};
	for (const key in info.props) if (!omitted.has(key)) props[key] = info.props[key];
	return tObject(props, { additionalProperties: info.additionalProperties }) as TObject<Omit<P, K[number]>>;
}

function tComposite<const E extends readonly TObject<Record<string, AnySchema>>[]>(
	schemas: E,
	opts?: ObjectOpts,
): TTyped<UnionToIntersection<Static<E[number]>>> {
	const props: Record<string, AnySchema> = {};
	for (const schema of schemas) Object.assign(props, requireObject(schema, "Composite").props);
	return asSchema<UnionToIntersection<Static<E[number]>>>(tObject(props, opts));
}

function tUnsafe<T = unknown>(_jsonSchema: Record<string, unknown> = {}): TUnsafe<T> {
	// Raw JSON Schema is accepted for source compatibility but is not retained or validated:
	// omptype cannot honestly implement that contract without importing a second validator.
	return withLegacyCompat(type.unknown as OmpType<T>);
}

export const Type = {
	String: tString,
	Number: (opts?: NumberOpts) => tNumber(opts),
	Integer: (opts?: NumberOpts) => tNumber(opts, true),
	Boolean: (opts?: Meta) => applyMeta(asRuntime<boolean>(type.raw("boolean")), opts),
	Null: (opts?: Meta) => applyMeta(asRuntime<null>(type.raw("null")), opts),
	Any: (opts?: Meta) => applyMeta(asRuntime<unknown>(type.raw("unknown")), opts),
	Unknown: (opts?: Meta) => applyMeta(asRuntime<unknown>(type.raw("unknown")), opts),
	Never: tNever,
	Literal: tLiteral,
	Union: tUnion,
	Intersect: tIntersect,
	Enum: tEnum,
	Array: tArray,
	Tuple: tTuple,
	Object: tObject,
	Record: tRecord,
	Optional: tOptional,
	Nullable: tNullable,
	Readonly: <E extends AnySchema>(schema: E): TReadonly<E> =>
		asSchema<Readonly<Static<E>>>(withLegacyCompat(asRuntime<Readonly<Static<E>>>(schema))),
	Partial: tPartial,
	Required: tRequired,
	Pick: tPick,
	Omit: tOmit,
	Composite: tComposite,
	Unsafe: tUnsafe,
} as const;

export type TypeBuilder = typeof Type;
export default { Type };
