/**
 * The public `type()` parser and `Type` schema surface — an ArkType-compatible
 * validator with a lazy JIT:
 *
 * - calls 1-2 run the tree-walking interpreter (near-zero setup cost, so
 *   schemas built per-request or validated once stay cheap)
 * - the third call compiles a specialized validator via `new Function` and
 *   swaps it in; hot schemas validate in tens of nanoseconds
 *
 * A schema is a callable: `schema(data)` returns the (possibly morphed)
 * output, or an `OmpErrors` on failure (`result instanceof type.errors`).
 */
import { compile, compileAllows } from "./compile";
import { type ErrorConfig, OmpErrors, OmpTypeError, TraversalError } from "./errors";
import type { InferDef, InferDefIn, InferObjectLiteral, InferObjectLiteralIn, InferString } from "./infer";
import { walk } from "./interp";
import {
	type AliasResolver,
	type Constructor,
	type Def,
	distributeFilter,
	type EmbeddableSchema,
	embed,
	expectedOf,
	hasMorph,
	type IR,
	IR_BRAND,
	isSimpleIR,
	keyOf,
	markThisOnlyResolver,
	type PropIR,
	parseDef,
	type TupleIR,
	useAssignability,
} from "./ir";
import { irToJsonSchema, type JsonSchemaOptions } from "./json-schema";
import { keywordIR, patternIR } from "./keywords";

// `Extract`/`Exclude` in the string DSL need assignability, which is defined here.
useAssignability(isSubtype);

export interface NarrowErrorInput {
	readonly expected: string;
	readonly actual?: unknown;
	readonly path?: readonly PropertyKey[];
	readonly relativePath?: readonly PropertyKey[];
}

/** Context passed to `.narrow()` / `.pipe()` callbacks. */
export interface NarrowContext {
	readonly path: readonly PropertyKey[];
	error(error: string | NarrowErrorInput): OmpErrors;
	mustBe(expectation: string): false;
	reject(problem: string | NarrowErrorInput): OmpErrors | false;
}

/** Schema metadata and validation-message overrides accepted by `.configure()`. */
export interface SchemaConfig extends ErrorConfig {
	readonly description?: string;
}

/** Options accepted by `Type.toJsonSchema`. */
export interface ToJsonSchemaOptions extends JsonSchemaOptions {}

declare const brand: unique symbol;

/** Inference-only nominal brand attached by `.brand(name)`. */
export type Brand<t, name extends string> = t & { readonly [brand]: name };

interface SchemaInference<out t, i = t> {
	readonly [IR_BRAND]: true;
	readonly infer: t;
	readonly inferIn: i;
}

/** Property descriptor exposed by object schemas and consumed by `.map()`. */
export interface TypeProperty {
	readonly kind: "required" | "optional";
	readonly key: PropertyKey;
	readonly value: FluentType<unknown>;
	readonly default?: unknown;
	readonly meta: Readonly<Record<string, unknown>>;
}

/** Structural node returned by `.select()`. */
export interface SelectedNode {
	readonly kind: string;
	readonly node: IR;
	readonly unit?: unknown;
}

/**
 * Standard Schema V1 (https://standardschema.dev) — the cross-library
 * validation interface consumed by tools like @t3-oss/env, tRPC, and
 * Hono validators. Inlined per the spec's recommendation; no dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
	export interface Props<Input = unknown, Output = Input> {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
		readonly types?: Types<Input, Output> | undefined;
		readonly jsonSchema: {
			readonly input: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
			readonly output: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
		};
	}
	export type Result<Output> = SuccessResult<Output> | FailureResult;
	export interface SuccessResult<Output> {
		readonly value: Output;
		readonly issues?: undefined;
	}
	export interface FailureResult {
		readonly issues: readonly Issue[];
	}
	export interface Issue {
		readonly message: string;
		readonly path?: readonly PropertyKey[] | undefined;
	}
	export interface Types<Input = unknown, Output = Input> {
		readonly input: Input;
		readonly output: Output;
	}
}

export interface StandardJsonSchemaOptions {
	readonly target: "draft-2020-12" | "draft-07" | string;
	readonly libraryOptions?: {
		readonly dialect?: string | null;
		readonly fallback?: JsonSchemaOptions["fallback"];
	};
}

/** A compiled schema: callable validator plus composition methods. */
export interface Type<out t = unknown, i = t> {
	(data: unknown): t | OmpErrors;
	readonly [IR_BRAND]: true;
	/** Structural IR (base type; runtime steps live in `steps`). */
	readonly ir: IR;
	/** `.pipe()` / `.narrow()` steps applied after structural validation. */
	readonly hasSteps: boolean;
	readonly hasDefault: boolean;
	readonly defaultValue?: unknown;
	readonly description?: string;
	/** Canonical ArkType-compatible expression for diagnostics. */
	readonly expression: string;
	/** Canonical structural node representation. */
	readonly json: unknown;
	/** Full validate+morph pipeline; identical to calling the schema. */
	readonly run: (data: unknown) => unknown;
	/** ArkType-compatible inference alias (type-only; undefined at runtime). */
	readonly t: t;
	/** Scope that parsed this schema (or the ambient Ark-compatible scope). */
	readonly $: TypeScope | { readonly internal: { readonly name: "ark" } };

	/** Inference-only output type (no runtime value). */
	readonly infer: t;
	/** Standalone validator for the schema's accepted input. */
	readonly in: FluentType<i>;
	/** Standalone validator for its known output, or `unknown` after an opaque morph. */
	readonly out: FluentType<t>;
	/** Inference-only input type (no runtime value). */
	readonly inferIn: i;

	/** Structural + narrow check without running pipes. */
	allows(data: unknown): data is i;
	/** Validate and return output, throwing `TraversalError` on failure. */
	assert(data: unknown): t;
	/** Validate a statically typed input and return its output. */
	from(data: i): t;
	/** JSON Schema for this schema's structural base. */
	toJsonSchema(options?: ToJsonSchemaOptions): Record<string, unknown>;
	/** Standard Schema V1 interop (synchronous validation). */
	readonly "~standard": StandardSchemaV1.Props<i, t>;
}

type MergeTypes<left, right> = left extends object
	? right extends object
		? Omit<left, keyof right> & right
		: right
	: right;

type SimplifyNary<t> = t extends object ? { [key in keyof t]: t[key] } : t;
type UnionToIntersection<union> = (union extends unknown ? (value: union) => void : never) extends (
	value: infer intersection,
) => void
	? intersection
	: never;

type NaryOrOutput<definitions extends readonly unknown[]> = InferDef<definitions[number]>;
type NaryOrInput<definitions extends readonly unknown[]> = InferDefIn<definitions[number]>;
type NaryAndOutput<definitions extends readonly unknown[]> = definitions extends readonly []
	? unknown
	: SimplifyNary<UnionToIntersection<InferDef<definitions[number]>>>;
type NaryAndInput<definitions extends readonly unknown[]> = definitions extends readonly []
	? unknown
	: SimplifyNary<UnionToIntersection<InferDefIn<definitions[number]>>>;
type ReduceNaryMergeOutput<definitions extends readonly unknown[], result = {}> = definitions extends readonly [
	infer head,
	...infer tail,
]
	? ReduceNaryMergeOutput<tail, SimplifyNary<MergeTypes<result, InferDef<head>>>>
	: definitions extends readonly []
		? result
		: {};
type ReduceNaryMergeInput<definitions extends readonly unknown[], result = {}> = definitions extends readonly [
	infer head,
	...infer tail,
]
	? ReduceNaryMergeInput<tail, SimplifyNary<MergeTypes<result, InferDefIn<head>>>>
	: definitions extends readonly []
		? result
		: {};
type NaryMergeOutput<definitions extends readonly unknown[]> = definitions extends readonly []
	? object
	: ReduceNaryMergeOutput<definitions>;
type NaryMergeInput<definitions extends readonly unknown[]> = definitions extends readonly []
	? object
	: ReduceNaryMergeInput<definitions>;

type PipeItemOutput<item> =
	item extends SchemaInference<infer output, unknown>
		? output
		: item extends (data: never, ...arguments_: never[]) => infer output
			? Exclude<output, OmpErrors>
			: InferDef<item>;
type NaryPipeOutput<items extends readonly unknown[]> = items extends readonly [...(readonly unknown[]), infer last]
	? PipeItemOutput<last>
	: unknown;
type NaryPipeInput<items extends readonly unknown[]> = items extends readonly [infer first, ...(readonly unknown[])]
	? first extends SchemaInference<unknown, infer input>
		? input
		: first extends (data: infer input, ...arguments_: never[]) => unknown
			? input
			: InferDefIn<first>
	: unknown;

interface FluentMethods<t, i> {
	describe(description: string): FluentType<t, i>;
	configure(config: SchemaConfig, selector?: "self" | ConfigureSelector): FluentType<t, i>;

	default(value: i | (() => i)): FluentType<t, i | undefined>;
	optional(): readonly [SchemaInference<t, i>, "?"];
	or<r, ri>(def: SchemaInference<r, ri>): FluentType<t | r, i | ri>;
	or<const def extends string>(def: def): FluentType<t | InferString<def>, i | InferString<def>>;
	or<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<t | InferObjectLiteral<def>, i | InferObjectLiteralIn<def>>;
	or(def: Def): FluentType<unknown>;
	and<r, ri>(def: SchemaInference<r, ri>): FluentType<t & r, i & ri>;
	and<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<t & InferObjectLiteral<def>, i & InferObjectLiteralIn<def>>;
	and(def: Def): FluentType<unknown>;
	equals(def: Def): boolean;
	ifEquals(def: Def): FluentType<t, i> | undefined;
	ifExtends(def: Def): FluentType<t, i> | undefined;
	extends(def: Def): boolean;
	overlaps(def: Def): boolean;
	distribute<r>(
		mapper: (branch: FluentType<unknown>) => SchemaInference<r>,
		reducer?: (branches: readonly SchemaInference<r>[]) => SchemaInference<unknown>,
	): FluentType<r>;
	select(kind: string): readonly SelectedNode[];
	array(): FluentType<t[], i[]>;
	atLeastLength(bound: number): FluentType<t, i>;
	atMostLength(bound: number): FluentType<t, i>;
	moreThanLength(bound: number): FluentType<t, i>;
	lessThanLength(bound: number): FluentType<t, i>;
	exactlyLength(bound: number): FluentType<t, i>;
	atLeast(bound: number): FluentType<t, i>;
	atMost(bound: number): FluentType<t, i>;
	moreThan(bound: number): FluentType<t, i>;
	lessThan(bound: number): FluentType<t, i>;
	divisibleBy(divisor: number): FluentType<t, i>;
	positive(): FluentType<t, i>;
	negative(): FluentType<t, i>;
	nonNegative(): FluentType<t, i>;
	nonPositive(): FluentType<t, i>;
	matching(pattern: RegExp): FluentType<t, i>;
	atOrAfter(bound: Date | number): FluentType<t, i>;
	atOrBefore(bound: Date | number): FluentType<t, i>;
	laterThan(bound: Date | number): FluentType<t, i>;
	earlierThan(bound: Date | number): FluentType<t, i>;
	readonly pipe: PipeMethod<t, i>;
	to<const def>(def: def): FluentType<InferDef<def>, i>;
	filter<narrowed extends i>(fn: (data: i, ctx: NarrowContext) => data is narrowed): FluentType<t, narrowed>;
	filter(fn: (data: i, ctx: NarrowContext) => boolean | OmpErrors): FluentType<t, i>;
	narrow<narrowed extends t>(fn: (data: t, ctx: NarrowContext) => data is narrowed): FluentType<narrowed, i>;
	narrow(fn: (data: t, ctx: NarrowContext) => boolean | OmpErrors): FluentType<t, i>;
	brand<const name extends string>(name: name): FluentType<Brand<t, name>, i>;
	as<castTo>(): FluentType<castTo, i>;
	readonly(): FluentType<Readonly<t>, i>;
	extract<r, ri>(def: SchemaInference<r, ri>): FluentType<Extract<t, r>, Extract<i, ri>>;
	extract<const def extends string>(def: def): FluentType<Extract<t, InferString<def>>, Extract<i, InferString<def>>>;
	extract(def: Def): FluentType<unknown>;
	exclude<r, ri>(def: SchemaInference<r, ri>): FluentType<Exclude<t, r>, Exclude<i, ri>>;
	exclude<const def extends string>(def: def): FluentType<Exclude<t, InferString<def>>, Exclude<i, InferString<def>>>;
	exclude(def: Def): FluentType<unknown>;
	onUndeclaredKey(behavior: "ignore" | "reject" | "delete"): FluentType<t, i>;
	onDeepUndeclaredKey(behavior: "ignore" | "reject" | "delete"): FluentType<t, i>;
}

interface PipeMethod<t, i> {
	<r>(fn: (data: t, ctx: NarrowContext) => r): FluentType<Exclude<r, OmpErrors>, i>;
	<r, ri>(schema: SchemaInference<r, ri>): FluentType<r, i>;
	(...steps: readonly unknown[]): FluentType<unknown, i>;
	readonly try: {
		<r>(fn: (data: t, ctx: NarrowContext) => r): FluentType<Exclude<r, OmpErrors>, i>;
		(...steps: readonly unknown[]): FluentType<unknown, i>;
	};
}

type InputObject<i> = i extends object ? i : object;

interface ObjectMethods<t extends object, i> {
	readonly props: readonly TypeProperty[];
	map(
		mapper: (property: TypeProperty) => TypeProperty | readonly TypeProperty[],
	): FluentType<Record<PropertyKey, unknown>>;
	keyof(): FluentType<Extract<keyof t, PropertyKey>, Extract<keyof InputObject<i>, PropertyKey>>;
	get<const path extends readonly PropertyKey[]>(...path: path): FluentType<unknown>;
	pick<const keys extends readonly (keyof t)[]>(
		...keys: keys
	): FluentType<Pick<t, keys[number]>, Pick<InputObject<i>, Extract<keys[number], keyof InputObject<i>>>>;
	omit<const keys extends readonly (keyof t)[]>(
		...keys: keys
	): FluentType<Omit<t, keys[number]>, Omit<InputObject<i>, Extract<keys[number], keyof InputObject<i>>>>;
	partial(): FluentType<Partial<t>, Partial<InputObject<i>>>;
	required(): FluentType<Required<t>, Required<InputObject<i>>>;
	merge<r, ri>(def: SchemaInference<r, ri>): FluentType<MergeTypes<t, r>, MergeTypes<i, ri>>;
	merge<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<MergeTypes<t, InferObjectLiteral<def>>, MergeTypes<i, InferObjectLiteralIn<def>>>;
	merge(def: Def): FluentType<unknown>;
}

type ObjectMethodsFor<t, i> = [t] extends [never]
	? unknown
	: [t] extends [readonly unknown[]]
		? unknown
		: [t] extends [object]
			? ObjectMethods<t & object, i>
			: unknown;
/** Callable schema with fluent methods specialized to its output and input. */
export type FluentType<t = unknown, i = t> = Type<t, i> & FluentMethods<t, i> & ObjectMethodsFor<t, i>;

type FnDefinition = Def | SchemaInference<unknown, unknown>;

/** Function returned by `type.fn`: arguments and an optional return are validated at every call. */
export type TypedFunction<
	parameters extends readonly unknown[] = readonly unknown[],
	returns = unknown,
	declaredReturns = returns,
> = ((...arguments_: parameters) => returns) & {
	readonly params: FluentType<parameters>;
	readonly returns: FluentType<declaredReturns>;
	readonly expression: string;
	readonly raw: (...arguments_: parameters) => returns;
};

type InferFnDefinition<definition> =
	definition extends SchemaInference<infer output, unknown> ? output : InferDef<definition>;

type InferFnParameters<
	definitions extends readonly unknown[],
	accumulator extends readonly unknown[] = [],
> = definitions extends readonly [infer head, ...infer tail]
	? head extends ":"
		? accumulator
		: InferFnParameters<tail, readonly [...accumulator, InferFnDefinition<head>]>
	: accumulator;

type InferFnReturn<definitions extends readonly unknown[], inferred> = definitions extends readonly [
	...(readonly unknown[]),
	":",
	infer returns,
]
	? InferFnDefinition<returns>
	: inferred;

type DeclaredFnReturn<definitions extends readonly unknown[]> = definitions extends readonly [
	...(readonly unknown[]),
	":",
	infer returns,
]
	? InferFnDefinition<returns>
	: unknown;

type FnFactory<definitions extends readonly FnDefinition[]> = <result>(
	implementation: (...arguments_: InferFnParameters<definitions>) => InferFnReturn<definitions, result>,
) => TypedFunction<InferFnParameters<definitions>, InferFnReturn<definitions, result>, DeclaredFnReturn<definitions>>;

/** Parses function parameter schemas and validates calls and declared returns. */
export interface FnParser {
	<const definitions extends readonly FnDefinition[]>(...definitions: definitions): FnFactory<definitions>;
	raw<const definitions extends readonly FnDefinition[]>(...definitions: definitions): FnFactory<definitions>;
}
interface Step {
	kind: "pipe" | "narrow" | "filter";
	fn: (data: unknown, ctx: NarrowContext) => unknown;
	/** Convert thrown callback exceptions into validation errors. */
	try?: boolean;
	/** Output IR when the step validates its output; drives public `.out`. */
	out?: IR;
}
/** Runtime constructor-like value used by ArkType-compatible `instanceof Type` checks. */
export const Type = Object.defineProperty(function Type(): void {}, Symbol.hasInstance, {
	value: (value: unknown): boolean =>
		(typeof value === "function" || (typeof value === "object" && value !== null)) && IR_BRAND in value,
});

interface TypeMeta {
	description?: string;
	defaultValue?: unknown;
	hasDefault?: boolean;
	defaultOutput?: unknown;
	hasDefaultOutput?: boolean;
	errorConfig?: ErrorConfig;
	clone?: false | ((input: unknown) => unknown);
}
function descriptionOf(ir: IR, seen: Set<IR> = new Set()): string {
	if (ir.desc !== undefined) return ir.desc;
	if (seen.has(ir)) return ir.k === "alias" ? ir.name : expectedOf(ir);
	seen.add(ir);
	if (ir.k === "alias") return descriptionOf(ir.resolve(), seen);
	if (ir.k === "object") {
		return `{ ${ir.props.map(prop => `${String(prop.key)}${prop.opt ? "?" : ""}: ${descriptionOf(prop.val, seen)}`).join(", ")} }`;
	}
	return expectedOf(ir);
}

export interface ConfigureSelector {
	readonly kind?: string;
	readonly where?: (node: { readonly domain?: string; readonly kind: string }) => boolean;
}

function errorConfigOf(config: SchemaConfig): ErrorConfig {
	return {
		...(config.description === undefined || config.expected !== undefined ? {} : { expected: config.description }),
		...(config.expected === undefined ? {} : { expected: config.expected }),
		...(config.actual === undefined ? {} : { actual: config.actual }),
		...(config.problem === undefined ? {} : { problem: config.problem }),
		...(config.message === undefined ? {} : { message: config.message }),
	};
}

function configureNode(ir: IR, config: SchemaConfig): IR {
	return {
		...ir,
		cfg: { ...ir.cfg, ...errorConfigOf(config) },
		...(config.description === undefined ? {} : { desc: config.description }),
	};
}

function configureSelected(ir: IR, config: SchemaConfig, selector: ConfigureSelector): IR {
	const domain =
		ir.k === "string" || ir.k === "number" || ir.k === "boolean" || ir.k === "bigint" || ir.k === "symbol"
			? ir.k
			: ir.k === "object" || ir.k === "array" || ir.k === "tuple" || ir.k === "instance" || ir.k === "anyobject"
				? "object"
				: undefined;
	const kind = ir.k === "number" && ir.divisor !== undefined ? "divisor" : "domain";
	if (
		(selector.kind === undefined || selector.kind === kind) &&
		(selector.where === undefined || selector.where({ kind, domain }))
	) {
		return configureNode(ir, config);
	}
	switch (ir.k) {
		case "array":
			return { ...ir, el: configureSelected(ir.el, config, selector) };
		case "tuple":
			return {
				...ir,
				prefix: ir.prefix.map(item => ({ ...item, val: configureSelected(item.val, config, selector) })),
				...(ir.variadic === undefined ? {} : { variadic: configureSelected(ir.variadic, config, selector) }),
				postfix: ir.postfix.map(item => configureSelected(item, config, selector)),
			};
		case "object":
			return {
				...ir,
				props: ir.props.map(prop => ({ ...prop, val: configureSelected(prop.val, config, selector) })),
				...(ir.index === undefined ? {} : { index: configureSelected(ir.index, config, selector) }),
				symbolIndex: ir.symbolIndex === undefined ? undefined : configureSelected(ir.symbolIndex, config, selector),
				patternIndexes: ir.patternIndexes?.map(index => ({
					key: configureSelected(index.key, config, selector),
					val: configureSelected(index.val, config, selector),
				})),
			};
		case "union":
		case "intersection":
			return { ...ir, members: ir.members.map(member => configureSelected(member, config, selector)) };
		case "refine":
			return { ...ir, base: configureSelected(ir.base, config, selector) };
		case "morph":
			return {
				...ir,
				input: configureSelected(ir.input, config, selector),
				...(ir.out === undefined ? {} : { out: configureSelected(ir.out, config, selector) }),
			};
		default:
			return ir;
	}
}

class Ctx implements NarrowContext {
	expectation: string | undefined;
	errors: OmpErrors | undefined;
	readonly path: readonly PropertyKey[];
	#data: unknown;

	constructor(data: unknown, path: readonly PropertyKey[] = []) {
		this.#data = data;
		this.path = path.map(key => (typeof key === "symbol" ? String(key) : key));
	}

	error(input: string | NarrowErrorInput): OmpErrors {
		const detail = typeof input === "string" ? { expected: input } : input;
		const error = OmpErrors.single([...(detail.path ?? detail.relativePath ?? [])], detail.expected, this.#data, {
			preserveActual: true,
			...(Object.hasOwn(detail, "actual") ? { actual: String(detail.actual) } : {}),
		});
		if (this.errors) this.errors.append(error);
		else this.errors = error;
		return error;
	}

	mustBe(expectation: string): false {
		this.expectation = expectation;
		return false;
	}

	reject(input: string | NarrowErrorInput): OmpErrors | false {
		if (typeof input === "string") {
			this.expectation = input;
			return false;
		}
		this.error(input);
		return false;
	}
}

type Validator = (data: unknown, path?: readonly PropertyKey[]) => unknown;
type Allows = (data: unknown) => data is unknown;

const kBase = Symbol("omptype.base");
const kSteps = Symbol("omptype.steps");

const EMPTY_STEPS: Step[] = [];
const EMPTY_META: TypeMeta = {};
const ARK_COMPAT_SCOPE = Object.freeze({ internal: Object.freeze({ name: "ark" as const }) });

interface InternalType
	extends
		Type<unknown, unknown>,
		FluentMethods<unknown, unknown>,
		ObjectMethods<Record<PropertyKey, unknown>, unknown> {
	(data: unknown): unknown;
	[IR_BRAND]: true;
	[kBase]: Validator;
	[kSteps]: Step[];
	clone?: false | ((input: unknown) => unknown);
	allows: Allows;
	ir: IR;
	hasSteps: boolean;
	hasDefault: boolean;
	/** Output IR of the last `.to(target)` step, when any. */
	stepOut?: IR;
	/** True when the last pipe step is bare — output shape statically unknown. */
	opaqueOutput?: boolean;
	defaultValue?: unknown;
	defaultOutput?: unknown;
	hasDefaultOutput?: boolean;
	description?: string;
	errorConfig?: ErrorConfig;
	$: typeof ARK_COMPAT_SCOPE;
	resolver?: AliasResolver;
	run: Validator;
}

/** Calls before the JIT compiles a schema (first two run the interpreter). */
const JIT_THRESHOLD = 3;

function metaOf(schema: InternalType): TypeMeta {
	return {
		description: schema.description,
		defaultValue: schema.defaultValue,
		hasDefault: schema.hasDefault,
		defaultOutput: schema.defaultOutput,
		hasDefaultOutput: schema.hasDefaultOutput,
		errorConfig: schema.errorConfig,
		clone: schema.clone,
	};
}
function inheritScope(source: InternalType, target: InternalType): InternalType {
	if (source.resolver === undefined) return target;
	target.resolver = source.resolver;
	Reflect.set(target, "$", source.$);
	return target;
}
function invalidDefault(label: string, errors: OmpErrors): never {
	const error = errors[0];
	let heading = label;
	for (let index = 0; index < error.path.length; index++) {
		const segment = error.path[index];
		if (typeof segment === "number") {
			if (label === "Default" && index === 0) heading = "Default value";
			heading += ` at [${segment}]`;
		} else if (label === "Default" && index === 0) {
			heading += ` ${String(segment)}`;
		} else {
			heading += `.${String(segment)}`;
		}
	}
	throw new OmpTypeError(`ParseError: ${heading} ${error.problem}`);
}

function rejectMutableStaticDefault(value: unknown): void {
	if (value !== null && typeof value === "object" && !(value instanceof Date)) {
		throw new OmpTypeError("ParseError: A mutable default value must be specified as a factory");
	}
}

function normalizeDefaults(ir: IR, seen = new WeakSet<object>()): void {
	if (seen.has(ir)) return;
	seen.add(ir);
	switch (ir.k) {
		case "object":
			for (const prop of ir.props) {
				normalizeDefaults(prop.val, seen);
				if (!prop.hasDefault || prop.defValidated) continue;
				let candidate: unknown;
				let factory = false;
				if (prop.defFactory && typeof prop.def === "function") {
					candidate = prop.def();
					factory = true;
				} else {
					rejectMutableStaticDefault(prop.def);
					candidate = prop.def;
				}
				const output = walk(prop.val, candidate);
				if (output instanceof OmpErrors) invalidDefault(`Default for ${String(prop.key)}`, output);
				if (!factory) prop.def = output;
				prop.defValidated = true;
			}
			if (ir.index) normalizeDefaults(ir.index, seen);
			if (ir.symbolIndex) normalizeDefaults(ir.symbolIndex, seen);
			if (ir.patternIndexes) {
				for (const index of ir.patternIndexes) {
					normalizeDefaults(index.key, seen);
					normalizeDefaults(index.val, seen);
				}
			}
			return;
		case "tuple":
			for (let index = 0; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				normalizeDefaults(item.val, seen);
				if (!item.hasDefault || item.defValidated) continue;
				let candidate: unknown;
				let factory = false;
				if (item.defFactory && typeof item.def === "function") {
					candidate = item.def();
					factory = true;
				} else {
					rejectMutableStaticDefault(item.def);
					candidate = item.def;
				}
				const output = walk(item.val, candidate);
				if (output instanceof OmpErrors) invalidDefault(`Default for [${index}]`, output);
				if (!factory) item.def = output;
				item.defValidated = true;
			}
			if (ir.variadic) normalizeDefaults(ir.variadic, seen);
			for (const item of ir.postfix) normalizeDefaults(item, seen);
			return;
		case "array":
			normalizeDefaults(ir.el, seen);
			return;
		case "union":
		case "intersection":
			for (const member of ir.members) normalizeDefaults(member, seen);
			return;
		case "refine":
			normalizeDefaults(ir.base, seen);
			return;
		case "morph":
			normalizeDefaults(ir.input, seen);
			if (ir.out) normalizeDefaults(ir.out, seen);
			return;
		default:
			return;
	}
}

/** Emitted for `io: 'output'` when a bare pipe makes the output unknowable. */
const OPAQUE_OUTPUT_IR: IR = { k: "unknown" };
const typeMethods = {
	describe(this: InternalType, description: string): InternalType {
		const ir = { ...this.ir, desc: description, cfg: { ...this.ir.cfg, expected: description } };
		return makeType(ir, this[kSteps], { ...metaOf(this), description });
	},

	configure(this: InternalType, config: SchemaConfig, selector: "self" | ConfigureSelector = "self"): InternalType {
		const selected =
			selector === "self" ? configureNode(this.ir, config) : configureSelected(this.ir, config, selector);
		return makeType(selected, this[kSteps], {
			...metaOf(this),
			errorConfig: { ...this.errorConfig, ...errorConfigOf(config) },
			...(config.description === undefined ? {} : { description: config.description }),
		});
	},

	default(this: InternalType, value: unknown): InternalType {
		const factory = typeof value === "function";
		if (!factory) rejectMutableStaticDefault(value);
		const candidate = factory ? value() : value;
		const output = this.run(candidate);
		if (output instanceof OmpErrors) invalidDefault("Default", output);
		return makeType(this.ir, this[kSteps], {
			...metaOf(this),
			defaultValue: value,
			hasDefault: true,
			...(factory ? {} : { defaultOutput: output, hasDefaultOutput: true }),
		});
	},

	optional(this: InternalType): readonly [InternalType, "?"] {
		return [this, "?"];
	},

	or(this: InternalType, def: Def): InternalType {
		const other = parseDef(def, this.resolver);
		const a = embed(this);
		const members = [...(a.k === "union" ? a.members : [a]), ...(other.k === "union" ? other.members : [other])];
		return inheritScope(this, makeType({ k: "union", members }, [], {}));
	},

	equals(this: InternalType, def: Def): boolean {
		return irEquals(embed(this), parseDef(def, this.resolver));
	},

	ifEquals(this: InternalType, def: Def): InternalType | undefined {
		return irEquals(embed(this), parseDef(def, this.resolver)) ? this : undefined;
	},

	ifExtends(this: InternalType, def: Def): InternalType | undefined {
		return isSubtype(embed(this), parseDef(def, this.resolver)) ? this : undefined;
	},

	extends(this: InternalType, def: Def): boolean {
		return isSubtype(embed(this), parseDef(def, this.resolver));
	},

	overlaps(this: InternalType, def: Def): boolean {
		try {
			intersect(embed(this), parseDef(def, this.resolver));
			return true;
		} catch (error) {
			if (error instanceof OmpTypeError) return false;
			throw error;
		}
	},

	distribute(
		this: InternalType,
		mapper: (branch: BaseType) => InternalType,
		reducer?: (branches: readonly InternalType[]) => InternalType,
	): InternalType {
		const branches = this.ir.k === "union" ? this.ir.members : [embed(this)];
		const mapped = branches.map(branch => mapper(makeType(branch, [], {}) as unknown as BaseType));
		if (reducer !== undefined) return reducer(mapped);
		const members = mapped.map(branch => embed(branch));
		return makeType(members.length === 1 ? members[0] : { k: "union", members }, [], {});
	},

	select(this: InternalType, kind: string): readonly SelectedNode[] {
		return selectNodes(this.ir, kind);
	},

	and(this: InternalType, def: Def): InternalType {
		return inheritScope(this, makeType(intersect(embed(this), parseDef(def, this.resolver)), [], {}));
	},

	array(this: InternalType): InternalType {
		return inheritScope(this, makeType({ k: "array", el: embed(this) }, [], {}));
	},

	atLeastLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "min", bound), this[kSteps], metaOf(this));
	},

	atMostLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "max", bound), this[kSteps], metaOf(this));
	},

	moreThanLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "min", bound + 1), this[kSteps], metaOf(this));
	},

	lessThanLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "max", bound - 1), this[kSteps], metaOf(this));
	},

	exactlyLength(this: InternalType, bound: number): InternalType {
		const bounded = withLengthBound(withLengthBound(this.ir, "min", bound), "max", bound);
		return makeType(bounded, this[kSteps], metaOf(this));
	},

	atLeast(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "min", bound), this[kSteps], metaOf(this));
	},

	atMost(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "max", bound), this[kSteps], metaOf(this));
	},

	moreThan(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "min", bound, true), this[kSteps], metaOf(this));
	},

	lessThan(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "max", bound, true), this[kSteps], metaOf(this));
	},

	divisibleBy(this: InternalType, divisor: number): InternalType {
		if (this.ir.k !== "number") throw new OmpTypeError(`cannot apply divisibility to ${this.ir.k}`);
		if (!Number.isFinite(divisor) || divisor === 0) throw new OmpTypeError("divisor must be non-zero");
		return makeType({ ...this.ir, divisor }, this[kSteps], metaOf(this));
	},

	positive(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "min", 0, true), this[kSteps], metaOf(this));
	},

	negative(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "max", 0, true), this[kSteps], metaOf(this));
	},

	nonNegative(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "min", 0), this[kSteps], metaOf(this));
	},

	nonPositive(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "max", 0), this[kSteps], metaOf(this));
	},

	matching(this: InternalType, pattern: RegExp): InternalType {
		return makeType(intersect(this.ir, patternIR(pattern)), this[kSteps], metaOf(this));
	},

	atOrAfter(this: InternalType, bound: Date | number): InternalType {
		const timestamp = bound instanceof Date ? bound.valueOf() : bound;
		return dateRefinement(this, timestamp, "at or after", value => value >= timestamp);
	},

	atOrBefore(this: InternalType, bound: Date | number): InternalType {
		const timestamp = bound instanceof Date ? bound.valueOf() : bound;
		return dateRefinement(this, timestamp, "at or before", value => value <= timestamp);
	},

	laterThan(this: InternalType, bound: Date | number): InternalType {
		const timestamp = bound instanceof Date ? bound.valueOf() : bound;
		return dateRefinement(this, timestamp, "later than", value => value > timestamp);
	},

	earlierThan(this: InternalType, bound: Date | number): InternalType {
		const timestamp = bound instanceof Date ? bound.valueOf() : bound;
		return dateRefinement(this, timestamp, "earlier than", value => value < timestamp);
	},

	pipe(this: InternalType, ...pipes: readonly unknown[]): InternalType {
		return appendPipes(this, pipes, false);
	},

	to(this: InternalType, def: unknown): InternalType {
		return appendPipes(this, [makeType(parseDef(def, this.resolver), [], {})], false, true);
	},

	filter(this: InternalType, fn: Step["fn"]): InternalType {
		return makeType(this.ir, [{ kind: "filter", fn }, ...this[kSteps]], metaOf(this));
	},

	narrow(this: InternalType, fn: Step["fn"]): InternalType {
		return makeType(this.ir, [...this[kSteps], { kind: "narrow", fn }], metaOf(this));
	},

	brand(this: InternalType): InternalType {
		return this;
	},

	as(this: InternalType): InternalType {
		return this;
	},

	readonly(this: InternalType): InternalType {
		return this;
	},

	keyof(this: InternalType): InternalType {
		return makeType(keyOf(this.ir), [], {});
	},

	get(this: InternalType, ...path: PropertyKey[]): InternalType {
		if (path.length === 0) return this;
		let result = this.ir;
		for (const key of path) result = getPathIR(result, key);
		return makeType(result, [], {});
	},

	pick(this: InternalType, ...keys: PropertyKey[]): InternalType {
		return makeType(selectObjectProps(this.ir, keys, true, "pick"), [], {});
	},

	omit(this: InternalType, ...keys: PropertyKey[]): InternalType {
		return makeType(selectObjectProps(this.ir, keys, false, "omit"), [], {});
	},

	partial(this: InternalType): InternalType {
		return makeType(setObjectOptionality(this.ir, true, "partial"), [], {});
	},

	required(this: InternalType): InternalType {
		return makeType(setObjectOptionality(this.ir, false, "required"), [], {});
	},

	map(this: InternalType, mapper: (property: TypeProperty) => TypeProperty | readonly TypeProperty[]): InternalType {
		const object = requireObject(this.ir, "map");
		const props = object.props.flatMap(prop => {
			const original = propertyFromIR(prop);
			const mapped = mapper(original);
			return (Array.isArray(mapped) ? mapped : [mapped]).map(property =>
				propertyToIR(
					(property.kind === "required" || property.kind === "optional"
						? property
						: { ...property, kind: original.kind }) as TypeProperty,
				),
			);
		});
		return makeType({ ...object, props }, [], {});
	},

	merge(this: InternalType, def: unknown): InternalType {
		const merged = mergeObjectDefinition(this.ir, def, this.resolver);
		return inheritScope(this, makeType(merged, [], {}));
	},

	extract(this: InternalType, def: unknown): InternalType {
		return inheritScope(this, makeType(distributeFilter(this.ir, parseDef(def, this.resolver), true), [], {}));
	},

	exclude(this: InternalType, def: unknown): InternalType {
		return inheritScope(this, makeType(distributeFilter(this.ir, parseDef(def, this.resolver), false), [], {}));
	},

	onUndeclaredKey(this: InternalType, behavior: "ignore" | "reject" | "delete"): InternalType {
		const extras = behavior === "ignore" ? "keep" : behavior;
		const ir = withShallowExtras(this.ir, extras);
		if (extras === "delete" && ir.k === "union") {
			const objects = ir.members.filter((member): member is ObjectIR => member.k === "object");
			for (let left = 0; left < objects.length; left++) {
				for (let right = left + 1; right < objects.length; right++) {
					const sharedRequired = objects[left].props.some(
						leftProp =>
							!leftProp.opt &&
							objects[right].props.some(rightProp => !rightProp.opt && rightProp.key === leftProp.key),
					);
					if (!sharedRequired) {
						const leftExpression = expressionOf(objects[left]).replace(/ }$/, ", + (undeclared): delete }");
						const rightExpression = expressionOf(objects[right]).replace(/ }$/, ", + (undeclared): delete }");
						throw new OmpTypeError(
							`ParseError: An unordered union of a type including a morph and a type with overlapping input is indeterminate:\nLeft: ${leftExpression}\nRight: ${rightExpression}`,
						);
					}
				}
			}
		}
		return makeType(ir, this[kSteps], metaOf(this));
	},

	onDeepUndeclaredKey(this: InternalType, behavior: "ignore" | "reject" | "delete"): InternalType {
		return makeType(withDeepExtras(this.ir, behavior === "ignore" ? "keep" : behavior), this[kSteps], metaOf(this));
	},

	allows(this: InternalType, data: unknown): data is unknown {
		const steps = this[kSteps];
		let needsPredicates = false;
		for (const step of steps) {
			if (step.kind !== "pipe") {
				needsPredicates = true;
				break;
			}
		}
		if (!needsPredicates) {
			const allows = compileAllows(this.ir);
			// Shadow the shared dispatcher once this schema has its specialized check.
			this.allows = allows;
			return allows(data);
		}
		for (const step of steps) {
			if (step.kind === "filter" && !step.fn(data, new Ctx(data))) return false;
		}
		const out = this[kBase](data);
		if (out instanceof OmpErrors) return false;
		for (const step of steps) {
			if (step.kind === "narrow" && !step.fn(out, new Ctx(out))) return false;
		}
		return true;
	},

	assert(this: InternalType, data: unknown): unknown {
		const out = this.run(data);
		if (out instanceof OmpErrors) throw new TraversalError(out);
		return out;
	},

	from(this: InternalType, data: unknown): unknown {
		const out = this.run(data);
		if (out instanceof OmpErrors) throw new TraversalError(out);
		return out;
	},

	toJsonSchema(this: InternalType, options?: ToJsonSchemaOptions): Record<string, unknown> {
		const ir =
			options?.io === "output" ? (this.opaqueOutput ? OPAQUE_OUTPUT_IR : (this.stepOut ?? this.ir)) : this.ir;
		const description = options?.description ?? this.ir.desc;
		if (description === undefined) return irToJsonSchema(ir, options);
		return irToJsonSchema(ir, { ...options, description });
	},
};

Object.defineProperty(typeMethods, "expression", {
	get(this: InternalType): string {
		const input = expressionOf(this.ir);
		if (!this.hasSteps) return input;
		if (this.opaqueOutput) return `(In: ${input}) => Out<unknown>`;
		return `(In: ${input}) => To<${expressionOf(this.stepOut ?? this.ir)}>`;
	},
});

Object.defineProperty(typeMethods, "json", {
	get(this: InternalType): unknown {
		return arkJsonOf(this.ir);
	},
});

Object.defineProperty(typeMethods, "props", {
	get(this: InternalType): readonly TypeProperty[] {
		const object = requireObject(this.ir, "props");
		return object.props.map(prop => propertyFromIR(prop));
	},
});

Object.defineProperty(typeMethods, "~standard", {
	get(this: InternalType): StandardSchemaV1.Props {
		const jsonSchema = (io: "input" | "output", options: StandardJsonSchemaOptions) => {
			if (options.target !== "draft-2020-12" && options.target !== "draft-07") {
				throw new OmpTypeError(
					`JSONSchema target '${options.target}' is not supported (must be "draft-2020-12" or "draft-07")`,
				);
			}
			return this.toJsonSchema({ ...options.libraryOptions, target: options.target, io });
		};
		return {
			version: 1,
			vendor: "omptype",
			validate: (value: unknown): StandardSchemaV1.Result<unknown> => {
				const out = this.run(value);
				return out instanceof OmpErrors
					? { issues: out as unknown as readonly StandardSchemaV1.Issue[] }
					: { value: out };
			},
			jsonSchema: {
				input: options => jsonSchema("input", options),
				output: options => jsonSchema("output", options),
			},
		};
	},
});

Object.defineProperty(typeMethods, "in", {
	get(this: InternalType): InternalType {
		return makeType(projectIO(this.ir, "in"), [], {});
	},
});

Object.defineProperty(typeMethods, "out", {
	get(this: InternalType): InternalType {
		if (this.opaqueOutput) return makeType({ k: "unknown" }, [], {});
		return makeType(projectIO(this.stepOut ?? this.ir, "out"), [], {});
	},
});

const allowsMethod = typeMethods.allows;
const assertMethod = typeMethods.assert;
const fromMethod = typeMethods.from;
Object.defineProperties(typeMethods, {
	description: {
		get(this: InternalType): string {
			return descriptionOf(this.ir);
		},
	},
	allows: {
		get(this: InternalType): Allows {
			const allows = (data: unknown): data is unknown => allowsMethod.call(this, data);
			Object.defineProperty(this, "allows", { value: allows, writable: true });
			return allows;
		},
	},
	assert: {
		get(this: InternalType): Validator {
			const assert = assertMethod.bind(this);
			Object.defineProperty(this, "assert", { value: assert });
			return assert;
		},
	},
	from: {
		get(this: InternalType): Validator {
			const from = fromMethod.bind(this);
			Object.defineProperty(this, "from", { value: from });
			return from;
		},
	},
	pipe: {
		get(this: InternalType) {
			const pipe = Object.assign((...pipes: readonly unknown[]): InternalType => appendPipes(this, pipes, false), {
				try: (...pipes: readonly unknown[]): InternalType => appendPipes(this, pipes, true),
			});
			Object.defineProperty(this, "pipe", { value: pipe });
			return pipe;
		},
	},
});

// Share the fluent surface without per-schema method allocations or copies.
// Function.prototype remains in the chain, except bind is intentionally hidden
// so generic tool wrappers recognize callable schemas rather than rebinding them.
Object.setPrototypeOf(typeMethods, Function.prototype);
Object.defineProperty(typeMethods, "bind", { value: undefined });

function makeType(ir: IR, steps: Step[], meta: TypeMeta): InternalType;
function makeType<t = unknown, i = t>(ir: IR, steps: Step[], meta: TypeMeta): FluentType<t, i>;
function makeType(ir: IR, steps: Step[], meta: TypeMeta): unknown {
	let morph = false;
	if (!isSimpleIR(ir)) {
		ir = normalizeIR(ir);
		morph = hasMorph(ir);
		if (morph) {
			normalizeDefaults(ir);
			assertDeterminateMorphUnions(ir);
		}
	}
	let calls = 0;
	let impl: Validator = (data: unknown): unknown => {
		if (++calls >= JIT_THRESHOLD) {
			impl = compile(ir);
			return impl(data);
		}
		return walk(ir, data);
	};

	const base: Validator = (data: unknown): unknown => impl(data);
	const errorConfig = meta.errorConfig ?? ir.cfg;

	const filterInput = steps.some(step => step.kind === "filter") ? projectIO(ir, "in") : undefined;
	const validate: Validator =
		steps.length === 0
			? base
			: (data: unknown, contextPath: readonly PropertyKey[] = []): unknown => {
					if (filterInput !== undefined) {
						const inputResult = walk(filterInput, data);
						if (inputResult instanceof OmpErrors) return inputResult;
					}
					for (const step of steps) {
						if (step.kind !== "filter") continue;
						const ctx = new Ctx(data, contextPath);
						const result = step.fn(data, ctx);
						if (result instanceof OmpErrors)
							return errorConfig === undefined ? result : result.configure(errorConfig);
						if (ctx.errors) return errorConfig === undefined ? ctx.errors : ctx.errors.configure(errorConfig);
						if (!result) {
							return OmpErrors.single(
								[],
								ctx.expectation ??
									(step.fn.name ? `valid according to ${step.fn.name}` : "valid (input predicate failed)"),
								data,
								errorConfig,
							);
						}
					}
					let out = base(data);
					if (out instanceof OmpErrors) return out;
					for (const step of steps) {
						if (step.kind === "filter") continue;
						const ctx = new Ctx(out, contextPath);
						if (step.kind === "narrow") {
							const result = step.fn(out, ctx);
							if (result instanceof OmpErrors) {
								return errorConfig === undefined ? result : result.configure(errorConfig);
							}
							if (ctx.errors) return errorConfig === undefined ? ctx.errors : ctx.errors.configure(errorConfig);
							if (!result) {
								return OmpErrors.single(
									[],
									ctx.expectation ??
										(step.fn.name ? `valid according to ${step.fn.name}` : "valid (narrow predicate failed)"),
									out,
									errorConfig,
								);
							}
						} else {
							try {
								out = step.fn(out, ctx);
							} catch (error) {
								if (!step.try) throw error;
								const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
								return OmpErrors.single([], `valid (morph threw ${detail})`, out, errorConfig);
							}
							if (out instanceof OmpErrors) {
								return errorConfig === undefined ? out : out.configure(errorConfig);
							}
						}
					}
					return out;
				};
	const needsClone = morph || steps.some(step => step.kind === "pipe");
	const clone = meta.clone;
	let callable: Validator = validate;
	if (needsClone && clone !== undefined) {
		if (clone === false) {
			callable = (data: unknown, path?: readonly PropertyKey[]): unknown => {
				const out = validate(data, path);
				if (
					out instanceof OmpErrors ||
					out === data ||
					typeof data !== "object" ||
					data === null ||
					typeof out !== "object" ||
					out === null
				) {
					return out;
				}
				if (Array.isArray(data) && Array.isArray(out)) {
					data.splice(0, data.length, ...out);
				} else {
					const target = data as Record<PropertyKey, unknown>;
					const source = out as Record<PropertyKey, unknown>;
					for (const key of Reflect.ownKeys(target)) {
						if (!Object.hasOwn(source, key)) Reflect.deleteProperty(target, key);
					}
					for (const key of Reflect.ownKeys(source)) target[key] = source[key];
				}
				return data;
			};
		} else {
			callable = (data: unknown, path?: readonly PropertyKey[]): unknown => validate(clone(data), path);
		}
	}

	// Root defaults materialize for absent input: `schema(undefined)` and the
	// Standard Schema boundary (`~standard.validate(undefined)`) both yield the
	// default instead of a base-IR rejection. Factories run per call; static
	// defaults reuse the precomputed validated output (mutable statics are
	// rejected at `.default()` time).
	if (meta.hasDefault === true) {
		const inner = callable;
		const value = meta.defaultValue;
		callable = (data: unknown, path?: readonly PropertyKey[]): unknown => {
			if (data !== undefined) return inner(data, path);
			if (meta.hasDefaultOutput === true) return meta.defaultOutput;
			return inner(typeof value === "function" ? (value as () => unknown)() : value, path);
		};
	}

	const self = callable as InternalType;
	self[IR_BRAND] = true;
	self[kBase] = base;
	self[kSteps] = steps;
	self.ir = ir;
	self.hasSteps = steps.length > 0;
	self.hasDefault = meta.hasDefault === true;
	self.defaultValue = meta.defaultValue;
	self.defaultOutput = meta.defaultOutput;
	self.hasDefaultOutput = meta.hasDefaultOutput === true;
	self.errorConfig = meta.errorConfig ?? ir.cfg;
	self.clone = meta.clone;
	self.run = callable;
	self.$ = ARK_COMPAT_SCOPE;
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step.kind !== "pipe") continue;
		self.stepOut = step.out;
		self.opaqueOutput = step.out === undefined;
		break;
	}
	Object.setPrototypeOf(self, typeMethods);
	return self;
}

function appendPipes(
	source: InternalType,
	pipes: readonly unknown[],
	catchErrors: boolean,
	forcePipeline = false,
): InternalType {
	let schema = source;
	for (const candidate of pipes) {
		const isSchema =
			(typeof candidate === "function" || (typeof candidate === "object" && candidate !== null)) &&
			IR_BRAND in candidate;
		if (isSchema) {
			const target = candidate as InternalType;
			if (
				!forcePipeline &&
				schema[kSteps].length === 0 &&
				!target.hasSteps &&
				!hasMorph(schema.ir) &&
				!hasMorph(target.ir)
			) {
				schema = makeType(intersect(schema.ir, target.ir), [], metaOf(schema));
				continue;
			}
			const out = target.opaqueOutput ? undefined : (target.stepOut ?? target.ir);
			schema = makeType(
				schema.ir,
				[...schema[kSteps], { kind: "pipe", fn: value => target.run(value), out, try: catchErrors }],
				metaOf(schema),
			);
			continue;
		}
		if (typeof candidate !== "function") throw new OmpTypeError("pipe operands must be functions or Types");
		schema = makeType(
			schema.ir,
			[...schema[kSteps], { kind: "pipe", fn: candidate as Step["fn"], try: catchErrors }],
			metaOf(schema),
		);
	}
	return inheritScope(source, schema);
}

function projectIO(ir: IR, io: "in" | "out"): IR {
	switch (ir.k) {
		case "morph":
			return projectIO(io === "in" || ir.out === undefined ? ir.input : ir.out, io);
		case "sub":
			if (io === "out" && ir.schema.opaqueOutput) return { k: "unknown" };
			return projectIO(io === "out" ? (ir.schema.stepOut ?? ir.schema.ir) : ir.schema.ir, io);
		case "array":
			return { ...ir, el: projectIO(ir.el, io) };
		case "tuple":
			return {
				...ir,
				prefix: ir.prefix.map(item => ({
					...item,
					opt: io === "in" ? item.opt || item.hasDefault === true : item.opt && !item.hasDefault,
					val: projectIO(item.val, io),
					hasDefault: false,
					def: undefined,
					defFactory: false,
					defValidated: false,
				})),
				variadic: ir.variadic === undefined ? undefined : projectIO(ir.variadic, io),
				postfix: ir.postfix.map(item => projectIO(item, io)),
			};
		case "object":
			return {
				...ir,
				props: ir.props.map(prop => ({
					...prop,
					opt: io === "in" ? prop.opt || prop.hasDefault === true : prop.opt && !prop.hasDefault,
					val: projectIO(prop.val, io),
					hasDefault: false,
					def: undefined,
					defFactory: false,
					defValidated: false,
				})),
				index: ir.index === undefined ? undefined : projectIO(ir.index, io),
				symbolIndex: ir.symbolIndex === undefined ? undefined : projectIO(ir.symbolIndex, io),
				patternIndexes: ir.patternIndexes?.map(index => ({
					key: projectIO(index.key, io),
					val: projectIO(index.val, io),
				})),
				extras: ir.extras === "delete" ? (io === "in" ? "keep" : "reject") : ir.extras,
			};
		case "union":
		case "intersection":
			return { ...ir, members: ir.members.map(member => projectIO(member, io)) };
		case "refine":
			return { ...ir, base: projectIO(ir.base, io) };
		case "alias":
			return { ...ir, resolve: () => projectIO(ir.resolve(), io) };
		default:
			return ir;
	}
}

function morphIdentities(ir: IR, identities: unknown[] = [], seen = new Set<IR>()): unknown[] {
	if (seen.has(ir)) return identities;
	seen.add(ir);
	switch (ir.k) {
		case "morph":
			identities.push(
				ir.out === undefined
					? ir.fn
					: `declared:${expressionOf(projectIO(ir.input, "in"))}=>${expressionOf(projectIO(ir.out, "out"))}`,
			);
			morphIdentities(ir.input, identities, seen);
			if (ir.out !== undefined) morphIdentities(ir.out, identities, seen);
			break;
		case "sub": {
			const schema = ir.schema as InternalType;
			for (const step of schema[kSteps]) if (step.kind === "pipe") identities.push(step.fn);
			morphIdentities(schema.ir, identities, seen);
			break;
		}
		case "array":
			morphIdentities(ir.el, identities, seen);
			break;
		case "tuple":
			for (const item of ir.prefix) morphIdentities(item.val, identities, seen);
			if (ir.variadic !== undefined) morphIdentities(ir.variadic, identities, seen);
			for (const item of ir.postfix) morphIdentities(item, identities, seen);
			break;
		case "object":
			if (ir.extras === "delete") identities.push(ir);
			for (const prop of ir.props) morphIdentities(prop.val, identities, seen);
			if (ir.index !== undefined) morphIdentities(ir.index, identities, seen);
			if (ir.symbolIndex !== undefined) morphIdentities(ir.symbolIndex, identities, seen);
			for (const index of ir.patternIndexes ?? []) morphIdentities(index.val, identities, seen);
			break;
		case "union":
		case "intersection":
			for (const member of ir.members) morphIdentities(member, identities, seen);
			break;
		case "refine":
			morphIdentities(ir.base, identities, seen);
			break;
		case "alias":
			morphIdentities(ir.resolve(), identities, seen);
			break;
	}
	return identities;
}

function assertDeterminateMorphUnions(ir: IR, seen = new Set<IR>()): void {
	if (seen.has(ir)) return;
	seen.add(ir);
	if (ir.k === "union") {
		for (let leftIndex = 0; leftIndex < ir.members.length; leftIndex++) {
			const left = ir.members[leftIndex];
			const leftMorphs = morphIdentities(left);
			for (let rightIndex = leftIndex + 1; rightIndex < ir.members.length; rightIndex++) {
				const right = ir.members[rightIndex];
				const rightMorphs = morphIdentities(right);
				if (leftMorphs.length === 0 && rightMorphs.length === 0) continue;
				if (
					leftMorphs.length === rightMorphs.length &&
					leftMorphs.every((identity, index) => identity === rightMorphs[index])
				) {
					continue;
				}
				// Unwrap one alias level eagerly: the disjointness probe relies on
				// intersect() throwing, and deferred alias intersections resolve lazily.
				let leftInput = projectIO(left, "in");
				let rightInput = projectIO(right, "in");
				if (leftInput.k === "alias") leftInput = leftInput.resolve();
				if (rightInput.k === "alias") rightInput = rightInput.resolve();
				if (leftInput.k === "object" && rightInput.k === "object") {
					const leftKeys = new Set(leftInput.props.map(prop => prop.key));
					const rightKeys = new Set(rightInput.props.map(prop => prop.key));
					const leftRejectsRequiredRight =
						leftInput.extras === "reject" &&
						rightInput.props.some(prop => !prop.opt && !prop.hasDefault && !leftKeys.has(prop.key));
					const rightRejectsRequiredLeft =
						rightInput.extras === "reject" &&
						leftInput.props.some(prop => !prop.opt && !prop.hasDefault && !rightKeys.has(prop.key));
					if (leftRejectsRequiredRight || rightRejectsRequiredLeft) continue;
				}
				try {
					intersect(leftInput, rightInput);
				} catch (error) {
					if (error instanceof OmpTypeError) continue;
					throw error;
				}
				throw new OmpTypeError("an unordered union with overlapping morph inputs is indeterminate");
			}
		}
	}
	switch (ir.k) {
		case "alias":
			assertDeterminateMorphUnions(ir.resolve(), seen);
			break;
		case "morph":
			assertDeterminateMorphUnions(ir.input, seen);
			if (ir.out !== undefined) assertDeterminateMorphUnions(ir.out, seen);
			break;
		case "sub":
			assertDeterminateMorphUnions(ir.schema.ir, seen);
			break;
		case "array":
			assertDeterminateMorphUnions(ir.el, seen);
			break;
		case "tuple":
			for (const item of ir.prefix) assertDeterminateMorphUnions(item.val, seen);
			if (ir.variadic !== undefined) assertDeterminateMorphUnions(ir.variadic, seen);
			for (const item of ir.postfix) assertDeterminateMorphUnions(item, seen);
			break;
		case "object":
			for (const prop of ir.props) assertDeterminateMorphUnions(prop.val, seen);
			if (ir.index !== undefined) assertDeterminateMorphUnions(ir.index, seen);
			if (ir.symbolIndex !== undefined) assertDeterminateMorphUnions(ir.symbolIndex, seen);
			for (const index of ir.patternIndexes ?? []) assertDeterminateMorphUnions(index.val, seen);
			break;
		case "union":
		case "intersection":
			for (const member of ir.members) assertDeterminateMorphUnions(member, seen);
			break;
		case "refine":
			assertDeterminateMorphUnions(ir.base, seen);
			break;
	}
}

function getPathIR(ir: IR, requestedKey: unknown): IR {
	let key = requestedKey;
	if ((typeof key === "function" || (typeof key === "object" && key !== null)) && IR_BRAND in key) {
		const keySchema = key as InternalType;
		if (keySchema.ir.k === "symbol") key = Symbol.for("omptype.index");
		else {
			const arrayIndex: unknown = type.arrayIndex;
			if (keySchema === arrayIndex) key = 0;
			else {
				throw new OmpTypeError(
					`${keySchema.expression} is not allowed as an array or object index; use a concrete property key`,
				);
			}
		}
	}
	if (typeof key !== "string" && typeof key !== "number" && typeof key !== "symbol") {
		throw new OmpTypeError(`get keys must be strings, numbers, or symbols`);
	}
	if (ir.k === "alias") return getPathIR(ir.resolve(), key);
	if (ir.k === "sub") return getPathIR(ir.schema.ir, key);
	if (ir.k === "union") {
		return unionOf(ir.members.map(member => getPathIR(member, key)));
	}
	if (ir.k === "array") {
		const index = typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : -1;
		if (!Number.isSafeInteger(index) || index < 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
		return unionOf([ir.el, { k: "undefined" }]);
	}
	if (ir.k === "tuple") {
		const index = typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : -1;
		if (!Number.isSafeInteger(index) || index < 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
		if (index < ir.prefix.length) {
			const item = ir.prefix[index];
			return item.opt ? unionOf([{ k: "undefined" }, item.val]) : item.val;
		}
		if (ir.variadic === undefined) throw new OmpTypeError(`key ${String(key)} is not declared`);
		return unionOf([{ k: "undefined" }, ir.variadic, ...ir.postfix]);
	}
	if (ir.k === "undefined") return ir;
	if (ir.k !== "object") throw new OmpTypeError("get requires an object schema");

	const matches: IR[] = [];
	const prop = ir.props.find(candidate => candidate.key === String(key));
	if (prop !== undefined) matches.push(prop.val);
	if (typeof key === "string") {
		if (ir.index !== undefined) matches.push(ir.index);
		for (const index of ir.patternIndexes ?? []) {
			if (!(walk(index.key, key) instanceof OmpErrors)) matches.push(index.val);
		}
	} else if (typeof key === "symbol" && ir.symbolIndex !== undefined) {
		matches.push(ir.symbolIndex);
	}
	if (matches.length === 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
	const value = matches.reduce((left, right) => intersect(left, right));
	return prop !== undefined && !prop.opt ? value : unionOf([value, { k: "undefined" }]);
}

function unionOf(members: IR[]): IR {
	const flattened = members.flatMap(member => (member.k === "union" ? member.members : [member]));
	return flattened.length === 1 ? flattened[0] : { k: "union", members: flattened };
}

function expressionOf(ir: IR, ancestors = new Set<IR>()): string {
	if (ancestors.has(ir)) return ir.k === "alias" ? ir.name : ir.k;
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(ir);
	const child = (node: IR): string => expressionOf(node, nextAncestors);
	switch (ir.k) {
		case "alias":
			return child(ir.resolve());
		case "sub":
			return child(ir.schema.ir);
		case "unknown":
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "never":
			return ir.k;
		case "anyobject":
			return "object";
		case "string":
			return "string";
		case "number":
			return ir.divisor !== undefined ? `number % ${ir.divisor}` : ir.int ? "number % 1" : "number";
		case "lit":
			return typeof ir.v === "string" ? JSON.stringify(ir.v) : String(ir.v);
		case "array": {
			const element = child(ir.el);
			return `${ir.el.k === "union" || ir.el.k === "intersection" ? `(${element})` : element}[]`;
		}
		case "tuple": {
			const items = ir.prefix.map(item => {
				const value = child(item.val);
				if (item.hasDefault) return `${value} = ${child({ k: "lit", v: item.def })}`;
				return `${value}${item.opt ? "?" : ""}`;
			});
			if (ir.variadic !== undefined) items.push(`...${child(ir.variadic)}[]`);
			items.push(...ir.postfix.map(child));
			return `[${items.join(", ")}]`;
		}
		case "object": {
			const properties = ir.props.map(prop => `${String(prop.key)}${prop.opt ? "?" : ""}: ${child(prop.val)}`);
			if (ir.index !== undefined) properties.unshift(`[string]: ${child(ir.index)}`);
			if (ir.symbolIndex !== undefined) properties.unshift(`[symbol]: ${child(ir.symbolIndex)}`);
			return `{ ${properties.join(", ")} }`;
		}
		case "union":
			return [...new Set(ir.members.map(child))].join(" | ");
		case "intersection":
			return ir.members.map(child).join(" & ");
		case "refine":
			return child(ir.base);
		case "morph":
			return `(In: ${child(ir.input)}) => Out<${child(ir.out ?? { k: "unknown" })}>`;
		case "instance":
			return ir.ctor.name || "object";
	}
}

function arkJsonOf(ir: IR, ancestors = new Set<IR>()): unknown {
	if (ancestors.has(ir)) return ir.k === "alias" ? { alias: ir.name } : { cyclic: ir.k };
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(ir);
	const child = (node: IR): unknown => arkJsonOf(node, nextAncestors);
	switch (ir.k) {
		case "alias":
			return child(ir.resolve());
		case "sub":
			return child(ir.schema.ir);
		case "lit":
			return {
				unit: ir.v === undefined ? "undefined" : typeof ir.v === "bigint" ? `${ir.v}n` : ir.v,
			};
		case "null":
			return { unit: null };
		case "undefined":
			return { unit: "undefined" };
		case "boolean":
			return [{ unit: false }, { unit: true }];
		case "union":
		case "intersection":
			return ir.members.map(child);
		case "array":
			return { proto: "Array", sequence: child(ir.el) };
		case "tuple":
			return {
				proto: "Array",
				sequence: {
					prefix: ir.prefix.map(item => child(item.val)),
					...(ir.variadic === undefined ? {} : { variadic: child(ir.variadic) }),
					...(ir.postfix.length === 0 ? {} : { postfix: ir.postfix.map(child) }),
				},
			};
		case "object":
			return {
				domain: "object",
				required: ir.props
					.filter(prop => !prop.opt && !prop.hasDefault)
					.map(prop => ({ key: prop.key, value: child(prop.val) })),
				optional: ir.props
					.filter(prop => prop.opt || prop.hasDefault)
					.map(prop => ({
						key: prop.key,
						value: child(prop.val),
						...(prop.hasDefault
							? {
									default:
										prop.defFactory && typeof prop.def === "function"
											? `$ark.${prop.def.name || "default"}`
											: prop.def,
								}
							: {}),
					})),
			};
		case "refine":
			return child(ir.base);
		case "morph":
			return { in: child(ir.input), ...(ir.out === undefined ? {} : { declaredOut: child(ir.out) }) };
		case "instance":
			return { proto: ir.ctor.name };
		case "anyobject":
			return { domain: "object" };
		default:
			return ir.k;
	}
}

type ObjectIR = Extract<IR, { k: "object" }>;

function requireObject(ir: IR, operation: string): ObjectIR {
	if (ir.k !== "object") throw new OmpTypeError(`${operation} requires an object schema`);
	return ir;
}
function selectObjectProps(ir: IR, keys: readonly PropertyKey[], keepSelected: boolean, operation: string): ObjectIR {
	const object = requireObject(ir, operation);
	const selected = new Set(keys);
	for (const key of selected) {
		if (!object.props.some(prop => prop.key === key)) throw new OmpTypeError(`key ${String(key)} does not exist`);
	}
	return { ...object, props: object.props.filter(prop => selected.has(prop.key) === keepSelected) };
}

function setObjectOptionality(ir: IR, optional: boolean, operation: string): ObjectIR {
	const object = requireObject(ir, operation);
	return { ...object, props: object.props.map(prop => ({ ...prop, opt: optional })) };
}

function mergeObjectDefinition(ir: IR, definition: unknown, resolve?: AliasResolver): ObjectIR {
	return mergeObjects(requireObject(ir, "merge"), requireObject(parseDef(definition, resolve), "merge"));
}

function propertyFromIR(prop: PropIR): TypeProperty {
	return {
		kind: prop.opt ? "optional" : "required",
		key: prop.key,
		value: makeType(prop.val, [], {}) as unknown as FluentType<unknown>,
		...(prop.hasDefault ? { default: prop.def } : {}),
		meta: {},
	};
}

function propertyToIR(property: TypeProperty): PropIR {
	if (property.kind !== "required" && property.kind !== "optional") {
		throw new OmpTypeError(`mapped property ${String(property.key)} has invalid kind`);
	}
	if (!(IR_BRAND in property.value)) {
		throw new OmpTypeError(`mapped property ${String(property.key)} must contain a schema value`);
	}
	const hasDefault = Object.hasOwn(property, "default");
	return {
		key: property.key,
		opt: property.kind === "optional",
		val: embed(property.value),
		...(hasDefault
			? { def: property.default, defFactory: typeof property.default === "function", hasDefault: true }
			: {}),
	};
}

function acceptsDateIR(ir: IR): boolean {
	if (ir.k === "instance") return ir.ctor === Date;
	if (ir.k === "refine") return acceptsDateIR(ir.base);
	if (ir.k === "union") return ir.members.every(acceptsDateIR);
	return false;
}

function dateRefinement(
	schema: InternalType,
	timestamp: number,
	relation: string,
	predicate: (value: number) => boolean,
): InternalType {
	if (!Number.isFinite(timestamp)) throw new OmpTypeError("date bound must be valid");
	if (!acceptsDateIR(schema.ir)) throw new OmpTypeError("date bounds require a Date type");
	const bound = new Date(timestamp);
	return makeType(
		{
			k: "refine",
			base: schema.ir,
			pred: value => value instanceof Date && predicate(value.valueOf()),
			expected: `a Date ${relation} ${bound.toISOString()}`,
			json: relation.includes("after") ? { minimum: bound.toISOString() } : { maximum: bound.toISOString() },
		},
		schema[kSteps],
		metaOf(schema),
	);
}

function selectNodes(root: IR, kind: string): readonly SelectedNode[] {
	const selected: SelectedNode[] = [];
	const seen = new Set<IR>();
	const visit = (node: IR): void => {
		if (seen.has(node)) return;
		seen.add(node);
		const nodeKind = node.k === "lit" ? "unit" : node.k;
		if (kind === nodeKind || kind === node.k) {
			selected.push(node.k === "lit" ? { kind: nodeKind, node, unit: node.v } : { kind: nodeKind, node });
		}
		switch (node.k) {
			case "alias":
				visit(node.resolve());
				break;
			case "array":
				visit(node.el);
				break;
			case "tuple":
				for (const item of node.prefix) visit(item.val);
				if (node.variadic !== undefined) visit(node.variadic);
				for (const item of node.postfix) visit(item);
				break;
			case "object":
				for (const prop of node.props) visit(prop.val);
				if (node.index !== undefined) visit(node.index);
				if (node.symbolIndex !== undefined) visit(node.symbolIndex);
				for (const index of node.patternIndexes ?? []) {
					visit(index.key);
					visit(index.val);
				}
				break;
			case "union":
			case "intersection":
				for (const member of node.members) visit(member);
				break;
			case "refine":
				visit(node.base);
				break;
			case "morph":
				visit(node.input);
				if (node.out !== undefined) visit(node.out);
				break;
			case "sub":
				visit(node.schema.ir);
				break;
		}
	};
	visit(root);
	return selected;
}

function mergeObjects(left: ObjectIR, right: ObjectIR): ObjectIR {
	const props = [...left.props];
	for (const prop of right.props) {
		const index = props.findIndex(candidate => candidate.key === prop.key);
		if (index < 0) props.push(prop);
		else props[index] = prop;
	}
	return {
		k: "object",
		props,
		index: right.index ?? left.index,
		symbolIndex: right.symbolIndex ?? left.symbolIndex,
		patternIndexes:
			left.patternIndexes === undefined && right.patternIndexes === undefined
				? undefined
				: [...(left.patternIndexes ?? []), ...(right.patternIndexes ?? [])],
		extras: right.extras === "keep" ? left.extras : right.extras,
	};
}

function withShallowExtras(ir: IR, extras: ObjectIR["extras"]): IR {
	if (ir.k === "object") return { ...ir, extras };
	if (ir.k === "union") return { ...ir, members: ir.members.map(member => withShallowExtras(member, extras)) };
	if (ir.k === "alias") return withShallowExtras(ir.resolve(), extras);
	throw new OmpTypeError("onUndeclaredKey requires an object schema");
}

function withDeepExtras(ir: IR, extras: ObjectIR["extras"]): IR {
	switch (ir.k) {
		case "object":
			return {
				...ir,
				extras,
				props: ir.props.map(prop => ({ ...prop, val: withDeepExtras(prop.val, extras) })),
				index: ir.index === undefined ? undefined : withDeepExtras(ir.index, extras),
				symbolIndex: ir.symbolIndex === undefined ? undefined : withDeepExtras(ir.symbolIndex, extras),
				patternIndexes: ir.patternIndexes?.map(index => ({
					key: withDeepExtras(index.key, extras),
					val: withDeepExtras(index.val, extras),
				})),
			};
		case "array":
			return { ...ir, el: withDeepExtras(ir.el, extras) };
		case "tuple":
			return {
				...ir,
				prefix: ir.prefix.map(item => ({ ...item, val: withDeepExtras(item.val, extras) })),
				variadic: ir.variadic === undefined ? undefined : withDeepExtras(ir.variadic, extras),
				postfix: ir.postfix.map(item => withDeepExtras(item, extras)),
			};
		case "union":
		case "intersection":
			return { ...ir, members: ir.members.map(member => withDeepExtras(member, extras)) };
		case "refine":
			return { ...ir, base: withDeepExtras(ir.base, extras) };
		case "morph":
			return {
				...ir,
				input: withDeepExtras(ir.input, extras),
				out: ir.out === undefined ? undefined : withDeepExtras(ir.out, extras),
			};
		default:
			return ir;
	}
}

function intersectTupleWithArray(tuple: TupleIR, array: Extract<IR, { k: "array" }>): IR {
	if (array.min !== undefined || array.max !== undefined) {
		return { k: "intersection", members: [tuple, array] };
	}
	return {
		...tuple,
		prefix: tuple.prefix.map(item => ({ ...item, val: intersect(item.val, array.el) })),
		variadic: tuple.variadic === undefined ? undefined : intersect(tuple.variadic, array.el),
		postfix: tuple.postfix.map(item => intersect(item, array.el)),
	};
}

function intersectTuples(left: TupleIR, right: TupleIR): IR {
	if (
		left.postfix.length !== 0 ||
		right.postfix.length !== 0 ||
		left.prefix.some(item => item.hasDefault) ||
		right.prefix.some(item => item.hasDefault)
	) {
		return { k: "intersection", members: [left, right] };
	}
	const leftRequired = left.prefix.filter(item => !item.opt).length;
	const rightRequired = right.prefix.filter(item => !item.opt).length;
	const minimum = Math.max(leftRequired, rightRequired);
	const leftMaximum = left.variadic === undefined ? left.prefix.length : Number.POSITIVE_INFINITY;
	const rightMaximum = right.variadic === undefined ? right.prefix.length : Number.POSITIVE_INFINITY;
	const maximum = Math.min(leftMaximum, rightMaximum);
	if (minimum > maximum) throw new OmpTypeError("tuple length intersection is unsatisfiable");

	const prefixLength = Number.isFinite(maximum) ? maximum : Math.max(left.prefix.length, right.prefix.length);
	const prefix: TupleIR["prefix"] = [];
	for (let index = 0; index < prefixLength; index++) {
		const leftItem = left.prefix[index];
		const rightItem = right.prefix[index];
		const leftNode = leftItem?.val ?? left.variadic;
		const rightNode = rightItem?.val ?? right.variadic;
		if (leftNode === undefined || rightNode === undefined) break;
		const required = (leftItem !== undefined && !leftItem.opt) || (rightItem !== undefined && !rightItem.opt);
		try {
			prefix.push({ val: intersect(leftNode, rightNode), opt: !required });
		} catch (error) {
			if (required || !(error instanceof OmpTypeError)) throw error;
			break;
		}
	}
	const variadic =
		leftMaximum === Number.POSITIVE_INFINITY && rightMaximum === Number.POSITIVE_INFINITY
			? intersect(left.variadic!, right.variadic!)
			: undefined;
	return { k: "tuple", prefix, variadic, postfix: [] };
}

const kIntersections = Symbol("omptype.intersections");

/** Deferred alias-pair intersections cached on the left node; cyclic references resolve to one node. */
interface AliasIntersections {
	[kIntersections]?: WeakMap<IR, IR>;
}

/** Intersect two IR nodes, rejecting statically disjoint domains. */
function intersect(a: IR, b: IR): IR {
	if (a.k === "alias" || b.k === "alias") {
		// Defer through a lazy alias so cyclic references terminate: revisiting
		// the same pair while it is being resolved returns the same node instead
		// of recursing forever.
		const target = a as IR & AliasIntersections;
		target[kIntersections] ??= new WeakMap<IR, IR>();
		const cache = target[kIntersections];
		const existing = cache.get(b);
		if (existing !== undefined) return existing;
		let resolved: IR | undefined;
		const reference: IR = {
			k: "alias",
			name: a.k === "alias" ? a.name : b.k === "alias" ? b.name : "intersection",
			resolve: () =>
				(resolved ??= intersectResolved(a.k === "alias" ? a.resolve() : a, b.k === "alias" ? b.resolve() : b)),
		};
		cache.set(b, reference);
		return reference;
	}
	return intersectResolved(a, b);
}

function intersectResolved(a: IR, b: IR): IR {
	if (a.k === "never" || b.k === "never") throw new OmpTypeError("intersection with never is unsatisfiable");
	if (a.k === "unknown") return b;
	if (b.k === "unknown") return a;
	if (a === b) return a;
	if (a.k === "morph" && b.k === "morph") {
		if (a.fn !== b.fn || a.out !== b.out) {
			throw new OmpTypeError("intersection of distinct morphs is indeterminate");
		}
		return { ...a, input: intersect(a.input, b.input) };
	}
	if (a.k === "morph") return { ...a, input: intersect(a.input, b) };
	if (b.k === "morph") return { ...b, input: intersect(a, b.input) };
	if (a.k === "sub" && a.schema.hasSteps) {
		if (b.k === "sub" && b.schema.hasSteps) {
			if (a.schema === b.schema) return a;
			throw new OmpTypeError("intersection of distinct morphs is indeterminate");
		}
		const schema = a.schema as InternalType;
		return embed(makeType(intersect(schema.ir, b), schema[kSteps], metaOf(schema)));
	}
	if (b.k === "sub" && b.schema.hasSteps) return intersect(b, a);
	if (a.k === "union" || b.k === "union") {
		const union = a.k === "union" ? a : b.k === "union" ? b : undefined;
		if (union === undefined) throw new OmpTypeError("union intersection invariant failed");
		const branches = union.members;
		const other = a.k === "union" ? b : a;
		const members: IR[] = [];
		for (const branch of branches) {
			try {
				members.push(intersect(branch, other));
			} catch (error) {
				if (!(error instanceof OmpTypeError)) throw error;
			}
		}
		if (members.length === 0) throw new OmpTypeError("intersection has no satisfiable branches");
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (a.k === "lit") {
		if (walk(b, a.v) instanceof OmpErrors) throw new OmpTypeError("literal is excluded by the intersection");
		return a;
	}
	if (b.k === "lit") return intersect(b, a);
	if (a.k === "object" && b.k === "object") {
		const props = [...a.props];
		for (const bp of b.props) {
			const index = props.findIndex(prop => prop.key === bp.key);
			if (index < 0) props.push(bp);
			else {
				const ap = props[index];
				const required = (!ap.opt && !ap.hasDefault) || (!bp.opt && !bp.hasDefault);
				if (ap.hasDefault && bp.hasDefault && !Object.is(ap.def, bp.def)) {
					throw new OmpTypeError(
						`ParseError: Invalid intersection of default values ${String(ap.def)} & ${String(bp.def)}`,
					);
				}
				const defaulted = required ? undefined : ap.hasDefault ? ap : bp.hasDefault ? bp : undefined;
				props[index] = {
					key: ap.key,
					opt: ap.opt && bp.opt,
					val: intersect(ap.val, bp.val),
					...(defaulted
						? {
								def: defaulted.def,
								defFactory: defaulted.defFactory,
								hasDefault: true,
								defValidated: defaulted.defValidated,
							}
						: {}),
				};
			}
		}
		const extras =
			a.extras === "reject" || b.extras === "reject"
				? "reject"
				: a.extras === "delete" || b.extras === "delete"
					? "delete"
					: "keep";
		const index = a.index && b.index ? intersect(a.index, b.index) : (a.index ?? b.index);
		return { k: "object", props, index, extras };
	}
	if (a.k === "string" && b.k === "string") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		if (min !== undefined && max !== undefined && min > max) {
			throw new OmpTypeError("string length intersection is unsatisfiable");
		}
		return { k: "string", min, max, url: a.url || b.url };
	}
	if (a.k === "number" && b.k === "number") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		const xmin = min !== undefined && ((a.min === min && a.xmin === true) || (b.min === min && b.xmin === true));
		const xmax = max !== undefined && ((a.max === max && a.xmax === true) || (b.max === max && b.xmax === true));
		if (min !== undefined && max !== undefined && (min > max || (min === max && (xmin || xmax)))) {
			throw new OmpTypeError("numeric range intersection is unsatisfiable");
		}
		if (a.divisor !== undefined && b.divisor !== undefined && a.divisor !== b.divisor) {
			return { k: "intersection", members: [a, b] };
		}
		return {
			k: "number",
			int: a.int || b.int,
			divisor: a.divisor ?? b.divisor,
			min,
			max,
			xmin,
			xmax,
		};
	}
	if (a.k === "array" && b.k === "array") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		if (min !== undefined && max !== undefined && min > max) {
			throw new OmpTypeError("array length intersection is unsatisfiable");
		}
		return { k: "array", el: intersect(a.el, b.el), min, max };
	}
	if (a.k === "tuple" && b.k === "tuple") return intersectTuples(a, b);
	if (a.k === "tuple" && b.k === "array") return intersectTupleWithArray(a, b);
	if (a.k === "array" && b.k === "tuple") return intersectTupleWithArray(b, a);
	if (a.k === "instance" && b.k === "instance") {
		if (a.ctor === b.ctor || a.ctor.prototype instanceof b.ctor) return a;
		if (b.ctor.prototype instanceof a.ctor) return b;
		throw new OmpTypeError(`intersection of ${a.expected} and ${b.expected} is unsatisfiable`);
	}
	if (a.k === b.k && ["null", "undefined", "boolean", "bigint", "symbol", "anyobject"].includes(a.k)) return a;
	if (
		(a.k === "object" && (b.k === "array" || b.k === "tuple")) ||
		(b.k === "object" && (a.k === "array" || a.k === "tuple"))
	) {
		return { k: "intersection", members: [a, b] };
	}
	const leftDomain = domainOf(a);
	const rightDomain = domainOf(b);
	if (leftDomain !== undefined && rightDomain !== undefined && leftDomain !== rightDomain) {
		throw new OmpTypeError(`intersection of ${leftDomain} and ${rightDomain} is unsatisfiable`);
	}
	if (a.k === "anyobject" && rightDomain === "object") return b;
	if (b.k === "anyobject" && leftDomain === "object") return a;
	const members = [...(a.k === "intersection" ? a.members : [a]), ...(b.k === "intersection" ? b.members : [b])];
	return { k: "intersection", members };
}

/** Reduce parsed unions/intersections to their observable semantic form. */
function normalizeIR(ir: IR): IR {
	switch (ir.k) {
		case "intersection": {
			const members = ir.members.map(normalizeIR);
			if (members.length === 0) return { k: "unknown" };
			return members.slice(1).reduce(intersect, members[0]);
		}
		case "union": {
			const members: IR[] = [];
			let changed = false;
			for (let index = 0; index < ir.members.length; index++) {
				const original = ir.members[index];
				const member = normalizeIR(original);
				changed ||= member !== original;
				if (member.k === "union") {
					members.push(...member.members);
					changed = true;
				} else if (member.k === "never") {
					changed = true;
				} else if (member.k === "unknown") {
					return { k: "unknown" };
				} else {
					members.push(member);
				}
			}
			if (
				members.every(
					member =>
						member.k === "lit" &&
						(member.v === null || (typeof member.v !== "object" && typeof member.v !== "function")),
				)
			) {
				const pruned: IR[] = [];
				for (const member of members) {
					if (member.k === "lit" && pruned.some(candidate => candidate.k === "lit" && candidate.v === member.v)) {
						changed = true;
					} else {
						pruned.push(member);
					}
				}
				if (pruned.length === 0) return { k: "never" };
				if (pruned.length === 1) return pruned[0];
				if (pruned.length === 2 && pruned.every(member => member.k === "lit" && typeof member.v === "boolean")) {
					return { k: "boolean" };
				}
				return changed ? { ...ir, members: pruned } : ir;
			}
			const pruned = members.filter(
				(member, index) =>
					!members.some(
						(candidate, candidateIndex) =>
							candidateIndex !== index &&
							!hasMorph(member) &&
							!hasMorph(candidate) &&
							isSubtype(member, candidate) &&
							(!isSubtype(candidate, member) || candidateIndex < index),
					),
			);
			if (pruned.length === 0) return { k: "never" };
			if (pruned.length === 1) return pruned[0];
			if (pruned.length === 2 && pruned.every(member => member.k === "lit" && typeof member.v === "boolean")) {
				return { k: "boolean" };
			}
			if (
				!changed &&
				!pruned.some(member => member.k === "alias") &&
				pruned.length === ir.members.length &&
				pruned.every((member, index) => member === ir.members[index])
			) {
				return ir;
			}
			return { ...ir, members: pruned };
		}
		case "array": {
			const element = normalizeIR(ir.el);
			return element === ir.el && ir.el.k !== "alias" ? ir : { ...ir, el: element };
		}
		case "tuple": {
			const prefix = ir.prefix.map(item => {
				const value = normalizeIR(item.val);
				return value === item.val ? item : { ...item, val: value };
			});
			const variadic = ir.variadic === undefined ? undefined : normalizeIR(ir.variadic);
			const postfix = ir.postfix.map(normalizeIR);
			if (
				!ir.prefix.some(item => item.val.k === "alias") &&
				ir.variadic?.k !== "alias" &&
				!ir.postfix.some(item => item.k === "alias") &&
				prefix.every((item, index) => item === ir.prefix[index]) &&
				variadic === ir.variadic &&
				postfix.every((item, index) => item === ir.postfix[index])
			) {
				return ir;
			}
			return { ...ir, prefix, variadic, postfix };
		}
		case "object": {
			let props: PropIR[] | undefined;
			for (let index = 0; index < ir.props.length; index++) {
				const prop = ir.props[index];
				const value = normalizeIR(prop.val);
				if (value === prop.val) continue;
				props ??= [...ir.props];
				props[index] = { ...prop, val: value };
			}
			const index = ir.index === undefined ? undefined : normalizeIR(ir.index);
			const symbolIndex = ir.symbolIndex === undefined ? undefined : normalizeIR(ir.symbolIndex);
			const patternIndexes = ir.patternIndexes?.map(pattern => {
				const key = normalizeIR(pattern.key);
				const val = normalizeIR(pattern.val);
				return key === pattern.key && val === pattern.val ? pattern : { key, val };
			});
			if (
				props === undefined &&
				!ir.props.some(prop => prop.val.k === "alias") &&
				ir.index?.k !== "alias" &&
				ir.symbolIndex?.k !== "alias" &&
				!ir.patternIndexes?.some(pattern => pattern.key.k === "alias" || pattern.val.k === "alias") &&
				index === ir.index &&
				symbolIndex === ir.symbolIndex &&
				patternIndexes?.every((pattern, patternIndex) => pattern === ir.patternIndexes?.[patternIndex]) !== false
			) {
				return ir;
			}
			return { ...ir, props: props ?? ir.props, index, symbolIndex, patternIndexes };
		}
		case "refine": {
			const base = normalizeIR(ir.base);
			return base === ir.base && ir.base.k !== "alias" ? ir : { ...ir, base };
		}
		case "morph": {
			const input = normalizeIR(ir.input);
			const out = ir.out === undefined ? undefined : normalizeIR(ir.out);
			return input === ir.input && out === ir.out && ir.input.k !== "alias" && ir.out?.k !== "alias"
				? ir
				: { ...ir, input, out };
		}
		case "alias":
			return ir;
		default:
			return ir;
	}
}

function domainOf(ir: IR): string | undefined {
	switch (ir.k) {
		case "null":
			return "null";
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "string":
		case "number":
			return ir.k;
		case "array":
		case "tuple":
			return "array";
		case "object":
		case "anyobject":
		case "instance":
			return "object";
		case "lit":
			return ir.v === null ? "null" : Array.isArray(ir.v) ? "array" : typeof ir.v;
		case "refine":
			return domainOf(ir.base);
		case "morph":
			return domainOf(ir.input);
		case "sub":
			return domainOf(ir.schema.ir);
		case "alias":
			return domainOf(ir.resolve());
		case "union":
		case "intersection": {
			const first = domainOf(ir.members[0] ?? { k: "never" });
			return ir.members.every(member => domainOf(member) === first) ? first : undefined;
		}
		default:
			return undefined;
	}
}
function lowerBoundWithin(source: Extract<IR, { k: "number" }>, target: Extract<IR, { k: "number" }>): boolean {
	if (target.min === undefined) return true;
	if (source.min === undefined || source.min < target.min) return false;
	return source.min !== target.min || target.xmin !== true || source.xmin === true;
}

function upperBoundWithin(source: Extract<IR, { k: "number" }>, target: Extract<IR, { k: "number" }>): boolean {
	if (target.max === undefined) return true;
	if (source.max === undefined || source.max > target.max) return false;
	return source.max !== target.max || target.xmax !== true || source.xmax === true;
}

function lengthWithin(
	source: Extract<IR, { k: "string" | "array" }>,
	target: Extract<IR, { k: "string" | "array" }>,
): boolean {
	return (
		(target.min === undefined || (source.min !== undefined && source.min >= target.min)) &&
		(target.max === undefined || (source.max !== undefined && source.max <= target.max))
	);
}

function isSubtype(source: IR, target: IR, seen = new WeakMap<IR, Set<IR>>()): boolean {
	if (source === target || target.k === "unknown" || source.k === "never") return true;
	let targets = seen.get(source);
	if (targets?.has(target)) return true;
	if (targets === undefined) {
		targets = new Set();
		seen.set(source, targets);
	}
	targets.add(target);
	if (source.k === "alias") return isSubtype(source.resolve(), target, seen);
	if (target.k === "alias") return isSubtype(source, target.resolve(), seen);
	if (source.k === "union") return source.members.every(member => isSubtype(member, target, seen));
	if (target.k === "union") return target.members.some(member => isSubtype(source, member, seen));
	if (target.k === "intersection") return target.members.every(member => isSubtype(source, member, seen));
	if (source.k === "intersection") return source.members.some(member => isSubtype(member, target, seen));
	if (source.k === "lit") return !(walk(target, source.v) instanceof OmpErrors);
	if (source.k === "refine") return isSubtype(source.base, target, seen);
	if (source.k === "morph") return isSubtype(source.out ?? source.input, target, seen);
	if (source.k === "sub") return isSubtype(source.schema.ir, target, seen);
	if (target.k === "refine" || target.k === "morph" || target.k === "sub") return false;
	if (source.k === "string" && target.k === "string") {
		return lengthWithin(source, target) && (!target.url || source.url === true);
	}
	if (source.k === "number" && target.k === "number") {
		return (
			lowerBoundWithin(source, target) &&
			upperBoundWithin(source, target) &&
			(!target.int || source.int === true) &&
			(target.divisor === undefined || (source.divisor !== undefined && source.divisor % target.divisor === 0))
		);
	}
	if (source.k === "array" && target.k === "array") {
		return lengthWithin(source, target) && isSubtype(source.el, target.el, seen);
	}
	if (source.k === "object" && target.k === "object") {
		for (const targetProp of target.props) {
			const sourceProp = source.props.find(prop => prop.key === targetProp.key);
			if (sourceProp === undefined) {
				if (!targetProp.opt) return false;
				continue;
			}
			if (!targetProp.opt && sourceProp.opt) return false;
			if (!isSubtype(sourceProp.val, targetProp.val, seen)) return false;
		}
		if (target.extras === "reject") {
			if (source.extras !== "reject") return false;
			if (
				target.index === undefined &&
				source.props.some(sourceProp => !target.props.some(targetProp => targetProp.key === sourceProp.key))
			) {
				return false;
			}
		}
		return true;
	}
	if (source.k === "instance" && target.k === "instance") {
		return source.ctor === target.ctor || source.ctor.prototype instanceof target.ctor;
	}
	if (source.k === "object" && target.k === "anyobject") return true;
	if (source.k === "instance" && target.k === "anyobject") return true;
	if (source.k === "tuple" && target.k === "array") {
		return (
			source.prefix.every(item => isSubtype(item.val, target.el, seen)) &&
			source.postfix.every(item => isSubtype(item, target.el, seen)) &&
			(source.variadic === undefined || isSubtype(source.variadic, target.el, seen))
		);
	}
	if (source.k !== target.k) return false;
	switch (source.k) {
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "anyobject":
			return true;
		case "tuple":
			return target.k === "tuple" && expectedTuple(source) === expectedTuple(target);
		case "instance":
			return target.k === "instance" && source.ctor === target.ctor;
		default:
			return false;
	}
}

function expectedTuple(tuple: Extract<IR, { k: "tuple" }>): string {
	return JSON.stringify({
		prefix: tuple.prefix.map(item => [item.opt, item.hasDefault, expectedOf(item.val)]),
		variadic: tuple.variadic === undefined ? undefined : expectedOf(tuple.variadic),
		postfix: tuple.postfix.map(expectedOf),
	});
}

function irEquals(left: IR, right: IR): boolean {
	return isSubtype(left, right) && isSubtype(right, left);
}

function maxOf(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

function minOf(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.min(a, b);
}

function withLengthBound(ir: IR, side: "min" | "max", bound: number): IR {
	if (ir.k === "array" || ir.k === "string") {
		return side === "min" ? { ...ir, min: bound } : { ...ir, max: bound };
	}
	throw new OmpTypeError(`cannot apply length bound to ${ir.k}`);
}

function withNumericBound(ir: IR, side: "min" | "max", bound: number, exclusive = false): IR {
	if (!Number.isFinite(bound)) throw new OmpTypeError("numeric bound must be finite");
	if (ir.k === "number") {
		return side === "min" ? { ...ir, min: bound, xmin: exclusive } : { ...ir, max: bound, xmax: exclusive };
	}
	if (ir.k === "union") {
		return { ...ir, members: ir.members.map(member => withNumericBound(member, side, bound, exclusive)) };
	}
	throw new OmpTypeError(`cannot apply numeric bound to ${ir.k}`);
}
interface GenericParameter {
	readonly name: string;
	readonly constraintDef?: unknown;
}

interface GenericMeta {
	readonly parameters: readonly GenericParameter[];
	instantiateIR(arguments_: readonly IR[]): IR;
}

const GENERIC_META = Symbol("omptype.generic");

/** Callable runtime generic returned by `type("<t>", def)` and `type.generic(...)`. */
export type Generic = (...arguments_: readonly unknown[]) => BaseType;

interface RuntimeGeneric extends Generic {
	readonly [GENERIC_META]: GenericMeta;
}

/** Schema arguments passed to a callback-bodied runtime generic. */
export interface GenericArguments {
	readonly [name: string]: BaseType;
}

export interface GenericBuilder {
	(definition: (arguments_: GenericArguments) => unknown, hkt?: unknown): Generic;
	(definition: unknown, hkt?: unknown): Generic;
}

function validateGenericParameters(parameters: readonly GenericParameter[]): void {
	const names = new Set<string>();
	for (const parameter of parameters) {
		if (!/^[A-Za-z_$]\w*$/.test(parameter.name)) {
			throw new OmpTypeError(`invalid generic parameter "${parameter.name}"`);
		}
		if (names.has(parameter.name)) throw new OmpTypeError(`duplicate generic parameter "${parameter.name}"`);
		names.add(parameter.name);
	}
	if (parameters.length === 0) throw new OmpTypeError("generic declarations require at least one parameter");
}

function parseGenericParameters(source: string): GenericParameter[] {
	const trimmed = source.trim();
	const body = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (quote !== "") {
			if (char === quote && body[index - 1] !== "\\") quote = "";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "<" || char === "(" || char === "[") depth++;
		else if (char === ">" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			parts.push(body.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(body.slice(start).trim());
	const parameters = parts.map(part => {
		const constrained = part.match(/^([A-Za-z_$]\w*)\s+extends\s+(.+)$/s);
		return constrained === null ? { name: part } : { name: constrained[1], constraintDef: constrained[2].trim() };
	});
	validateGenericParameters(parameters);
	return parameters;
}

function parseGenericDeclaration(source: string): { name: string; parameters: GenericParameter[] } | undefined {
	const match = source.trim().match(/^([A-Za-z_$]\w*)\s*(<.*>)$/s);
	if (match === null) return undefined;
	return { name: match[1], parameters: parseGenericParameters(match[2]) };
}

function isRuntimeGeneric(value: unknown): value is RuntimeGeneric {
	return typeof value === "function" && GENERIC_META in value;
}

function genericResolver(
	parameters: readonly GenericParameter[],
	arguments_: readonly IR[],
	outer?: AliasResolver,
): AliasResolver {
	const byName = new Map<string, IR>();
	for (let index = 0; index < parameters.length; index++) byName.set(parameters[index].name, arguments_[index]);
	const resolve = ((name: string) => byName.get(name) ?? outer?.(name)) as AliasResolver;
	resolve.hasGeneric = outer?.hasGeneric;
	resolve.generic = outer?.generic;
	return resolve;
}

function parseGenericArgument(definition: unknown, outer?: AliasResolver): IR {
	if (outer === undefined) {
		try {
			return parseDef(definition);
		} catch (error) {
			if (!(error instanceof OmpTypeError) || !error.message.includes('unknown keyword "this"')) throw error;
		}
	}
	const root: { current?: IR } = {};
	const self: IR = {
		k: "alias",
		name: "this",
		resolve: () => {
			if (root.current === undefined || root.current === self)
				throw new OmpTypeError('"this" cannot be used as a root definition');
			return root.current;
		},
	};
	const resolve = ((name: string) => (name === "this" ? self : outer?.(name))) as AliasResolver;
	if (outer !== undefined) {
		resolve.hasGeneric = outer.hasGeneric;
		resolve.generic = outer.generic;
	} else {
		// The retry only exists to serve "this"; parses of this-free member
		// strings inside the definition may still share the string cache.
		markThisOnlyResolver(resolve);
	}
	root.current = parseDef(definition, resolve);
	if (root.current === self) throw new OmpTypeError('"this" cannot be used as a root definition');
	return root.current;
}

function genericBodyIR(
	parameters: readonly GenericParameter[],
	definition: unknown,
	arguments_: readonly IR[],
	outer?: AliasResolver,
): IR {
	const resolve = genericResolver(parameters, arguments_, outer);
	const body =
		typeof definition === "function" && !(IR_BRAND in definition)
			? definition(
					Object.fromEntries(
						parameters.map((parameter, index) => [
							parameter.name,
							makeType(arguments_[index], EMPTY_STEPS, EMPTY_META) as unknown as BaseType,
						]),
					) as unknown as GenericArguments,
				)
			: definition;
	return parseDef(body, resolve);
}

function createRuntimeGeneric(
	parameters: readonly GenericParameter[],
	definition: unknown,
	outer?: AliasResolver,
	validateBody = true,
): RuntimeGeneric {
	const constraintResolve = ((name: string) => outer?.(name)) as AliasResolver;
	constraintResolve.hasGeneric = outer?.hasGeneric;
	constraintResolve.generic = outer?.generic;
	validateGenericParameters(parameters);
	const placeholders = parameters.map(parameter =>
		parameter.constraintDef === undefined
			? ({ k: "unknown" } as IR)
			: parseDef(parameter.constraintDef, constraintResolve),
	);
	if (validateBody) genericBodyIR(parameters, definition, placeholders, outer);
	const meta: GenericMeta = {
		parameters,
		instantiateIR(arguments_) {
			if (arguments_.length !== parameters.length) {
				throw new OmpTypeError(`generic expects ${parameters.length} arguments (received ${arguments_.length})`);
			}
			for (let index = 0; index < parameters.length; index++) {
				const parameter = parameters[index];
				if (parameter.constraintDef === undefined) continue;
				const constraint = parseDef(parameter.constraintDef, constraintResolve);
				if (!isSubtype(arguments_[index], constraint)) {
					throw new OmpTypeError(`${parameter.name} must be assignable to its constraint`);
				}
			}
			return genericBodyIR(parameters, definition, arguments_, outer);
		},
	};
	const generic = Object.assign(
		(...arguments_: readonly unknown[]) =>
			makeType(
				meta.instantiateIR(arguments_.map(argument => parseGenericArgument(argument, outer))),
				EMPTY_STEPS,
				EMPTY_META,
			),
		{ [GENERIC_META]: meta },
	);
	Object.defineProperty(generic, GENERIC_META, { value: meta });
	return generic;
}

export function type<const definition>(parameters: `<${string}>`, definition: definition): Generic;
export function type<const def>(def: def): FluentType<InferDef<def>, InferDefIn<def>>;
export function type<input, output>(
	def: SchemaInference<input> | string,
	operator: "=>",
	morph: (data: input, ctx: NarrowContext) => output,
): FluentType<Exclude<output, OmpErrors>, input>;
export function type<const input, const output>(
	def: input,
	operator: "|>",
	out: output,
): FluentType<InferDef<output>, InferDefIn<input>>;
export function type<const expression extends readonly unknown[]>(
	...definition: expression
): FluentType<InferDef<expression>, InferDefIn<expression>>;
export function type(first?: unknown): FluentType<unknown> | Generic {
	const count = arguments.length;
	if (count === 2 && typeof first === "string" && first.trimStart().startsWith("<")) {
		return createRuntimeGeneric(parseGenericParameters(first), arguments[1]);
	}
	let definition: unknown = first;
	if (count !== 1) {
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const expression: unknown[] = new Array(count);
		for (let index = 0; index < count; index++) {
			expression[index] = arguments[index];
		}
		definition = expression;
	}
	return makeType<unknown>(parseGenericArgument(definition), EMPTY_STEPS, EMPTY_META);
}

/** String keyword with a parser that morphs validated text to another output. */
export interface ParsedStringKeyword<parsed> extends FluentType<string> {
	readonly parse: FluentType<parsed, string>;
}

/** Morphing string keyword paired with its non-morphing preformatted validator. */
export interface PreformattedKeyword extends FluentType<string, string> {
	readonly preformatted: FluentType<string>;
}

/** Base64 keyword with its URL-safe alphabet variant. */
export interface Base64Keyword extends FluentType<string> {
	readonly url: FluentType<string>;
}

/** Date-string keyword family. */
export interface DateStringKeyword extends ParsedStringKeyword<Date> {
	readonly iso: ParsedStringKeyword<Date>;
	readonly epoch: ParsedStringKeyword<Date>;
}

/** IP address keyword family. */
export interface IpKeyword extends FluentType<string> {
	readonly v4: FluentType<string>;
	readonly v6: FluentType<string>;
}

/** UUID keyword family. */
export interface UuidKeyword extends FluentType<string> {
	readonly v1: FluentType<string>;
	readonly v2: FluentType<string>;
	readonly v3: FluentType<string>;
	readonly v4: FluentType<string>;
	readonly v5: FluentType<string>;
	readonly v6: FluentType<string>;
	readonly v7: FluentType<string>;
	readonly v8: FluentType<string>;
}

/** String normalization keyword family. */
export interface NormalizeKeyword extends PreformattedKeyword {
	readonly NFC: PreformattedKeyword;
	readonly NFD: PreformattedKeyword;
	readonly NFKC: PreformattedKeyword;
	readonly NFKD: PreformattedKeyword;
}

/** Runtime string parsers exposed under `type.parse`. */
export interface ParseKeyword {
	readonly number: FluentType<number, string>;
	readonly integer: FluentType<number, string>;
	readonly json: FluentType<unknown, string>;
	readonly date: FluentType<Date, string>;
	readonly url: FluentType<URL, string>;
	readonly boolean: FluentType<boolean, string>;
	readonly bigint: FluentType<bigint, string>;
}

/** Full string keyword module attached to `type.string`. */
export interface StringKeyword extends FluentType<string> {
	readonly alpha: FluentType<string>;
	readonly alphanumeric: FluentType<string>;
	readonly base64: Base64Keyword;
	readonly capitalize: PreformattedKeyword;
	readonly creditCard: FluentType<string>;
	readonly date: DateStringKeyword;
	readonly digits: FluentType<string>;
	readonly email: FluentType<string>;
	readonly hex: FluentType<string>;
	readonly integer: ParsedStringKeyword<number>;
	readonly ip: IpKeyword;
	readonly json: ParsedStringKeyword<unknown>;
	readonly lower: PreformattedKeyword;
	readonly normalize: NormalizeKeyword;
	readonly numeric: ParsedStringKeyword<number>;
	readonly regex: FluentType<string>;
	readonly semver: FluentType<string>;
	readonly trim: PreformattedKeyword;
	readonly upper: PreformattedKeyword;
	readonly url: ParsedStringKeyword<URL>;
	readonly uuid: UuidKeyword;
}

/** Number keyword module attached to `type.number`. */
export interface NumberKeyword extends FluentType<number> {
	readonly integer: FluentType<number>;
}

type Constructed<ctor> = ctor extends abstract new (...args: never[]) => infer instance ? instance : never;

function keywordSchema<output = string, input = output>(name: string): FluentType<output, input> {
	const ir = keywordIR(name);
	if (ir === undefined) throw new OmpTypeError(`missing built-in keyword ${name}`);
	return makeType<output, input>(ir, [], {});
}

function parsedKeyword<parsed>(name: string): ParsedStringKeyword<parsed> {
	return Object.assign(keywordSchema<string>(name), {
		parse: keywordSchema<parsed, string>(`${name}.parse`),
	});
}

function preformattedKeyword(name: string): PreformattedKeyword {
	return Object.assign(keywordSchema<string, string>(name), {
		preformatted: keywordSchema(`${name}.preformatted`),
	});
}

type MatchDefault<input = unknown, output = unknown> =
	| "assert"
	| "never"
	| "reject"
	| ((input: input, ...args: readonly unknown[]) => output);

type MatchCaseOutput<cases> = {
	[key in keyof cases]: cases[key] extends (...args: never[]) => infer output ? output : never;
}[keyof cases];

/** A finalized matcher. Like a schema, it returns structured errors unless finalized with `"assert"`. */
export type Matcher<input = unknown, output = unknown> = FluentType<output, input> &
	(<const value extends input>(value: value, ...args: readonly unknown[]) => output | OmpErrors);

/** Fluent first-match parser exposed as `match` and `type.match`. */
export interface MatchParser<input = unknown, output = never> {
	<const cases extends Record<PropertyKey, unknown>>(
		cases: cases,
	): MatchParser<input, output | MatchCaseOutput<cases>> | Matcher<input, output | MatchCaseOutput<cases>>;
	case<const definition, result>(
		definition: definition,
		resolver: (value: InferDef<definition>, ...args: readonly unknown[]) => result,
	): MatchParser<input, output | result>;
	match<const cases extends Record<PropertyKey, unknown>>(
		cases: cases,
	): MatchParser<input, output | MatchCaseOutput<cases>> | Matcher<input, output | MatchCaseOutput<cases>>;
	default<const result>(fallback: MatchDefault<input, result>): Matcher<input, output | result>;
	at<const key extends PropertyKey>(key: key): MatchParser<input, output>;
	at<const key extends PropertyKey, cases extends Record<PropertyKey, unknown>>(
		key: key,
		cases: cases,
	): MatchParser<input, output | MatchCaseOutput<cases>> | Matcher<input, output | MatchCaseOutput<cases>>;
	strings<const cases extends Record<PropertyKey, unknown>>(
		cases: cases,
	): MatchParser<input, output | MatchCaseOutput<cases>> | Matcher<input, output | MatchCaseOutput<cases>>;
	in<narrowed>(): MatchParser<narrowed, output>;
	in<const definition>(definition: definition): MatchParser<InferDef<definition>, output>;
}

interface MatchBranch {
	readonly definition: unknown;
	readonly schema: BaseType;
	readonly resolve: (input: unknown, ...args: readonly unknown[]) => unknown;
}

interface MatchState {
	readonly parse: (definition: unknown) => BaseType;
	readonly branches: readonly MatchBranch[];
	readonly input?: BaseType;
	readonly key?: PropertyKey;
}

function caseResolver(value: unknown): (input: unknown, ...args: readonly unknown[]) => unknown {
	if (typeof value !== "function") throw new OmpTypeError("match case values must be functions");
	return (input, ...args) => Reflect.apply(value, undefined, [input, ...args]);
}

function unionIR(branches: readonly MatchBranch[]): IR {
	const members = branches.map(branch => branch.schema.ir);
	if (members.length === 0) return { k: "never" };
	if (members.length === 1) return members[0];
	return { k: "union", members };
}

function publicMatcher<input, output>(
	state: MatchState,
	fallback: MatchDefault<input, output>,
): Matcher<input, output> {
	const fallbackResolver = typeof fallback === "function" ? caseResolver(fallback) : undefined;
	const casesIR = unionIR(state.branches);
	let casesSchema: BaseType;
	if (state.key === undefined || state.branches.length === 0) {
		casesSchema =
			state.key === undefined
				? (makeType(casesIR, EMPTY_STEPS, EMPTY_META) as unknown as BaseType)
				: state.parse({ [state.key]: "never" });
	} else {
		const first = state.branches[0].schema.ir;
		if (first.k !== "object") throw new OmpTypeError("match.at cases must define object schemas");
		const propertyKey = String(state.key);
		const values: IR[] = [];
		for (const branch of state.branches) {
			if (branch.schema.ir.k !== "object") throw new OmpTypeError("match.at cases must define object schemas");
			const property = branch.schema.ir.props.find(candidate => candidate.key === propertyKey);
			if (property === undefined) throw new OmpTypeError(`match.at case is missing ${propertyKey}`);
			values.push(property.val);
		}
		const value = values.length === 1 ? values[0] : { k: "union" as const, members: values };
		casesSchema = makeType(
			{
				...first,
				props: first.props.map(property => (property.key === propertyKey ? { ...property, val: value } : property)),
			},
			EMPTY_STEPS,
			EMPTY_META,
		) as unknown as BaseType;
	}
	const execute = (input: unknown, args: readonly unknown[]): unknown => {
		let matchedInput = input;
		if (state.input !== undefined) {
			const validated = state.input.run(input);
			if (validated instanceof OmpErrors) return validated;
			matchedInput = validated;
		}
		for (const branch of state.branches) {
			const matched = branch.schema.run(matchedInput);
			if (!(matched instanceof OmpErrors)) return branch.resolve(matched, ...args);
		}
		if (fallbackResolver !== undefined) return fallbackResolver(matchedInput, ...args);
		return casesSchema.run(matchedInput);
	};
	const schema = makeType({ k: "unknown" }, [{ kind: "pipe", fn: input => execute(input, []) }], EMPTY_META);
	const callable = ((value: unknown, ...args: readonly unknown[]): unknown => {
		const result = execute(value, args);
		if ((fallback === "assert" || fallback === "never") && result instanceof OmpErrors) {
			throw new TraversalError(result);
		}
		return result;
	}) as unknown as InternalType;
	Object.assign(callable, schema);
	Object.setPrototypeOf(callable, typeMethods);
	return callable as unknown as Matcher<input, output>;
}

function addMatchCases(state: MatchState, cases: Record<PropertyKey, unknown>): MatchParser {
	const branches = [...state.branches];
	let fallback: MatchDefault | undefined;
	for (const rawDefinition of Reflect.ownKeys(cases)) {
		const value = Reflect.get(cases, rawDefinition);
		if (rawDefinition === "default") {
			if (value !== "assert" && value !== "never" && value !== "reject" && typeof value !== "function") {
				throw new OmpTypeError('match default must be "assert", "never", "reject" or a function');
			}
			fallback = value as MatchDefault;
			continue;
		}
		const definition = typeof rawDefinition === "symbol" ? rawDefinition : String(rawDefinition);
		const caseDefinition = state.key === undefined ? definition : { [state.key]: definition };
		branches.push({
			definition,
			schema: state.parse(caseDefinition),
			resolve: caseResolver(value),
		});
	}
	const next = { ...state, branches };
	return fallback === undefined ? createMatchParser(next) : (publicMatcher(next, fallback) as unknown as MatchParser);
}

function createMatchParser(state: MatchState): MatchParser {
	const parser = ((cases: Record<PropertyKey, unknown>) => addMatchCases(state, cases)) as MatchParser;
	parser.case = (definition, resolver) => {
		const caseDefinition = state.key === undefined ? definition : { [state.key]: definition };
		return createMatchParser({
			...state,
			branches: [
				...state.branches,
				{
					definition,
					schema: state.parse(caseDefinition),
					resolve: caseResolver(resolver),
				},
			],
		});
	};
	parser.match = cases => addMatchCases(state, cases);
	parser.default = fallback => publicMatcher(state, fallback);
	function at<const key extends PropertyKey>(key: key): MatchParser<unknown, never>;
	function at<const key extends PropertyKey, cases extends Record<PropertyKey, unknown>>(
		key: key,
		cases: cases,
	): MatchParser<unknown, MatchCaseOutput<cases>> | Matcher<unknown, MatchCaseOutput<cases>>;
	function at(key: PropertyKey, cases?: Record<PropertyKey, unknown>): unknown {
		if (state.key !== undefined) throw new OmpTypeError("match.at may only be specified once");
		const next = createMatchParser({ ...state, key });
		return cases === undefined ? next : next.match(cases);
	}
	parser.at = at;
	parser.strings = cases => {
		if (state.key === undefined) throw new OmpTypeError("match.strings requires match.at(key)");
		const definitions: Record<PropertyKey, unknown> = {};
		for (const key of Reflect.ownKeys(cases)) {
			definitions[key === "default" ? key : JSON.stringify(String(key))] = Reflect.get(cases, key);
		}
		return addMatchCases(state, definitions);
	};
	parser.in = (...args: unknown[]) => {
		if (state.input !== undefined) throw new OmpTypeError("match.in may only be specified once");
		return createMatchParser({
			...state,
			...(args.length === 0 ? {} : { input: state.parse(args[0]) }),
		});
	};
	return parser;
}

/** Build a fluent first-match dispatcher from schema definitions. */
const matchBuilder: MatchParser = createMatchParser({
	parse: definition => type.raw(definition),
	branches: [],
});

export { matchBuilder as match };

function fnExpression(ir: IR): string {
	switch (ir.k) {
		case "unknown":
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "never":
		case "string":
		case "number":
			return ir.k;
		case "anyobject":
			return "object";
		case "lit":
			return typeof ir.v === "string" ? JSON.stringify(ir.v) : String(ir.v);
		case "union":
			return ir.members.map(fnExpression).join(" | ");
		case "intersection":
			return ir.members.map(fnExpression).join(" & ");
		case "array": {
			const element = fnExpression(ir.el);
			return ir.el.k === "unknown" ? "Array" : `${element.includes(" | ") ? `(${element})` : element}[]`;
		}
		case "tuple": {
			const elements = ir.prefix.map(item => {
				const expression = fnExpression(item.val);
				if (item.hasDefault) return `${expression} = ${String(item.def)}`;
				return item.opt ? `${expression}?` : expression;
			});
			if (ir.variadic !== undefined) elements.push(`...${fnExpression({ k: "array", el: ir.variadic })}`);
			elements.push(...ir.postfix.map(fnExpression));
			return `[${elements.join(", ")}]`;
		}
		case "object":
			return `{ ${ir.props
				.map(property => `${String(property.key)}${property.opt ? "?" : ""}: ${fnExpression(property.val)}`)
				.join(", ")} }`;
		case "refine":
			return fnExpression(ir.base);
		case "morph":
			return `(In: ${fnExpression(ir.input)}) => To<${fnExpression(ir.out ?? { k: "unknown" })}>`;
		case "instance":
			return ir.ctor.name || "object";
		case "alias":
			return fnExpression(ir.resolve());
		case "sub": {
			const schema = ir.schema;
			if (!schema.hasSteps) return fnExpression(schema.ir);
			return `(In: ${fnExpression(schema.ir)}) => To<${fnExpression(schema.stepOut ?? { k: "unknown" })}>`;
		}
	}
}

function normalizeFnParameter(definition: unknown): unknown {
	if (typeof definition !== "string") return definition;
	const optional = definition.match(/^(.*[^\s])\?$/);
	if (optional) return [optional[1], "?"];
	const defaulted = definition.match(/^(.*?)\s*=\s*(.+)$/);
	if (defaulted) {
		const source = defaulted[2];
		const value =
			source === "true"
				? true
				: source === "false"
					? false
					: source === "null"
						? null
						: Number.isNaN(Number(source))
							? source
							: Number(source);
		return [defaulted[1], "=", value];
	}
	return definition;
}

function makeFn(resolve?: AliasResolver): FnParser {
	function parser<const definitions extends readonly FnDefinition[]>(
		...definitions: definitions
	): FnFactory<definitions>;
	function parser(...definitions: readonly unknown[]): unknown {
		const marker = definitions.indexOf(":");
		if (marker !== -1 && (marker !== definitions.length - 2 || definitions.lastIndexOf(":") !== marker)) {
			throw new OmpTypeError(
				'":" must be followed by exactly one return type e.g:\nfn("string", ":", "number")(s => s.length)',
			);
		}
		const spreadIndexes: number[] = [];
		for (let index = 0; index < definitions.length; index++) {
			if (definitions[index] === "...") spreadIndexes.push(index);
		}
		if (spreadIndexes.length > 1) {
			const secondSpread = definitions[spreadIndexes[1] + 1];
			if (
				Array.isArray(secondSpread) &&
				secondSpread.some(
					element => typeof element === "string" && (element.endsWith("?") || element.includes("=")),
				)
			) {
				throw new OmpTypeError("An optional element may not follow a variadic element");
			}
			throw new OmpTypeError("A tuple may have at most one variadic element");
		}
		if (spreadIndexes.length === 1 && spreadIndexes[0] + 2 < (marker === -1 ? definitions.length : marker)) {
			const preceding = definitions.slice(0, spreadIndexes[0]);
			if (
				preceding.some(element => typeof element === "string" && (element.endsWith("?") || /\s=\s/.test(element)))
			) {
				throw new OmpTypeError("A postfix required element cannot follow an optional or defaultable element");
			}
		}
		const parameterDefinitions = (marker === -1 ? definitions : definitions.slice(0, marker)).map(
			normalizeFnParameter,
		);
		const params = makeType<readonly unknown[], readonly unknown[]>(parseDef(parameterDefinitions, resolve), [], {});
		const returns =
			marker === -1
				? makeType<unknown>({ k: "unknown" }, [], {})
				: makeType<unknown>(parseDef(definitions[marker + 1], resolve), [], {});
		const parameterExpression = fnExpression(params.ir);
		const returnsExpression = fnExpression(returns.ir);
		return (implementation: (...arguments_: readonly unknown[]) => unknown) => {
			if (typeof implementation !== "function") throw new OmpTypeError("type.fn requires a function implementation");
			const raw = (...arguments_: readonly unknown[]): unknown => {
				const validatedArguments = params.assert(arguments_);
				const result = Reflect.apply(implementation, undefined, validatedArguments);
				return returns.assert(result);
			};
			const typed = raw.bind(undefined) as TypedFunction<readonly unknown[], unknown>;
			Object.defineProperties(typed, {
				name: { value: `bound typed ${implementation.name}`, configurable: true },
				raw: { value: implementation, enumerable: true },
				params: { value: params, enumerable: true },
				returns: { value: returns, enumerable: true },
				expression: {
					value: `(${parameterExpression.slice(1, -1)}) => ${returnsExpression}`,
					enumerable: true,
				},
			});
			return typed;
		};
	}
	return Object.assign(parser, { raw: parser });
}
/** Declares a schema output type while preserving its inferred input. */
export interface DeclaredParser<declared> {
	type<const definition>(definition: definition): FluentType<declared, InferDefIn<definition>>;
}

/** Fix a schema's externally declared static type without changing its runtime validation. */
export function declare<declared, _options = {}>(): DeclaredParser<declared> {
	return {
		type: definition => type(definition) as unknown as FluentType<declared, InferDefIn<typeof definition>>,
	};
}

function isTypeValue(value: unknown): value is InternalType {
	return (typeof value === "function" || (typeof value === "object" && value !== null)) && IR_BRAND in value;
}

function resolveAlias(ir: IR): IR {
	const seen = new Set<IR>();
	let current = ir;
	while (current.k === "alias" && !seen.has(current)) {
		seen.add(current);
		current = current.resolve();
	}
	return current;
}

function sameUnionMember(left: IR, right: IR): boolean {
	const a = resolveAlias(left);
	const b = resolveAlias(right);
	if (a.k === "lit" && b.k === "lit") return Object.is(a.v, b.v);
	if (a.k !== b.k) return false;
	switch (a.k) {
		case "unknown":
		case "never":
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "anyobject":
			return true;
		default:
			return false;
	}
}

function buildOr(definitions: readonly unknown[], resolve?: AliasResolver): InternalType;
function buildOr<output, input>(definitions: readonly unknown[], resolve?: AliasResolver): FluentType<output, input>;
function buildOr(definitions: readonly unknown[], resolve?: AliasResolver): InternalType {
	const members: IR[] = [];
	const add = (candidate: IR): boolean => {
		const resolved = resolveAlias(candidate);
		if (resolved.k === "unknown") {
			members.length = 0;
			members.push(resolved);
			return false;
		}
		if (resolved.k === "never") return true;
		if (resolved.k === "union") {
			for (const member of resolved.members) {
				if (!add(member)) return false;
			}
			return true;
		}
		if (!members.some(member => sameUnionMember(member, candidate))) members.push(candidate);
		return true;
	};
	for (const definition of definitions) {
		if (!add(parseDef(definition, resolve))) break;
	}
	const ir: IR = members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
	return makeType(ir, [], {});
}

function buildAnd(definitions: readonly unknown[], resolve?: AliasResolver): InternalType;
function buildAnd<output, input>(definitions: readonly unknown[], resolve?: AliasResolver): FluentType<output, input>;
function buildAnd(definitions: readonly unknown[], resolve?: AliasResolver): InternalType {
	if (definitions.length === 0) return makeType({ k: "unknown" }, [], {});
	let ir = parseDef(definitions[0], resolve);
	for (let index = 1; index < definitions.length; index++) {
		ir = intersect(ir, parseDef(definitions[index], resolve));
	}
	return makeType(ir, [], {});
}

function requireNaryObject(ir: IR): ObjectIR {
	const resolved = resolveAlias(ir);
	if (resolved.k !== "object") throw new OmpTypeError("merge requires an object schema");
	return resolved;
}

function buildMerge(definitions: readonly unknown[], resolve?: AliasResolver): InternalType;
function buildMerge<output, input>(definitions: readonly unknown[], resolve?: AliasResolver): FluentType<output, input>;
function buildMerge(definitions: readonly unknown[], resolve?: AliasResolver): InternalType {
	if (definitions.length === 0) return makeType({ k: "anyobject" }, [], {});
	let object = requireNaryObject(parseDef(definitions[0], resolve));
	for (let index = 1; index < definitions.length; index++) {
		object = mergeObjects(object, requireNaryObject(parseDef(definitions[index], resolve)));
	}
	return makeType(object, [], {});
}

function buildPipe(definitions: readonly unknown[], resolve?: AliasResolver): InternalType;
function buildPipe<output, input>(definitions: readonly unknown[], resolve?: AliasResolver): FluentType<output, input>;
function buildPipe(definitions: readonly unknown[], resolve?: AliasResolver): InternalType {
	if (definitions.length === 0) return makeType({ k: "unknown" }, [], {});
	const first = definitions[0];
	let schema =
		typeof first === "function" && !isTypeValue(first)
			? appendPipes(makeType({ k: "unknown" }, [], {}), [first], false, true)
			: isTypeValue(first)
				? first
				: makeType(parseDef(first, resolve), [], {});
	for (let index = 1; index < definitions.length; index++) {
		const definition = definitions[index];
		const pipe =
			typeof definition === "function" && !isTypeValue(definition)
				? definition
				: isTypeValue(definition)
					? definition
					: makeType(parseDef(definition, resolve), [], {});
		schema = appendPipes(schema, [pipe], false, true);
	}
	return schema;
}

function naryStatics(resolve?: AliasResolver) {
	return {
		or: (...definitions: readonly unknown[]) => buildOr(definitions, resolve),
		and: (...definitions: readonly unknown[]) => buildAnd(definitions, resolve),
		merge: (...definitions: readonly unknown[]) => buildMerge(definitions, resolve),
		pipe: (...definitions: readonly unknown[]) => buildPipe(definitions, resolve),
	};
}

export namespace type {
	/** Error aggregate returned by failed validations (`result instanceof type.errors`). */
	export const errors = OmpErrors;
	export type errors = OmpErrors;

	/** Build a union from zero or more definitions. */
	export function or<const definitions extends readonly unknown[]>(
		...definitions: definitions
	): FluentType<NaryOrOutput<definitions>, NaryOrInput<definitions>> {
		return buildOr<NaryOrOutput<definitions>, NaryOrInput<definitions>>(definitions);
	}

	/** Build an array schema from an element definition. */
	export function array<const definition>(
		definition: definition,
	): FluentType<InferDef<definition>[], InferDefIn<definition>[]> {
		return type(definition).array();
	}

	/** Build a union from a runtime array of definitions. */
	export function union<const definitions extends readonly unknown[]>(
		definitions: definitions,
	): FluentType<NaryOrOutput<definitions>, NaryOrInput<definitions>> {
		return buildOr<NaryOrOutput<definitions>, NaryOrInput<definitions>>(definitions);
	}

	/** Build a tuple schema from a runtime array of definitions. */
	export function tuple<const definitions extends readonly unknown[]>(
		definitions: definitions,
	): FluentType<InferDef<definitions>, InferDefIn<definitions>> {
		return type(definitions);
	}

	/** Build an open record schema from key and value definitions. */
	export function record<const key, const value>(
		key: key,
		value: value,
	): FluentType<
		Record<Extract<InferDef<key>, PropertyKey>, InferDef<value>>,
		Record<Extract<InferDefIn<key>, PropertyKey>, InferDefIn<value>>
	> {
		return keywords.Record(key, value);
	}

	/** Build an intersection from zero or more definitions. */
	export function and<const definitions extends readonly unknown[]>(
		...definitions: definitions
	): FluentType<NaryAndOutput<definitions>, NaryAndInput<definitions>> {
		return buildAnd<NaryAndOutput<definitions>, NaryAndInput<definitions>>(definitions);
	}

	/** Right-biased object merge over zero or more definitions. */
	export function merge<const definitions extends readonly unknown[]>(
		...definitions: definitions
	): FluentType<NaryMergeOutput<definitions>, NaryMergeInput<definitions>> {
		return buildMerge<NaryMergeOutput<definitions>, NaryMergeInput<definitions>>(definitions);
	}

	/** Compose Types, definitions, and morph callbacks from left to right. */
	export function pipe<const definitions extends readonly unknown[]>(
		...definitions: definitions
	): FluentType<NaryPipeOutput<definitions>, NaryPipeInput<definitions>> {
		return buildPipe<NaryPipeOutput<definitions>, NaryPipeInput<definitions>>(definitions);
	}

	const normalize: NormalizeKeyword = Object.assign(keywordSchema<string, string>("string.normalize"), {
		preformatted: keywordSchema("string.normalize.NFC.preformatted"),
		NFC: preformattedKeyword("string.normalize.NFC"),
		NFD: preformattedKeyword("string.normalize.NFD"),
		NFKC: preformattedKeyword("string.normalize.NFKC"),
		NFKD: preformattedKeyword("string.normalize.NFKD"),
	});
	const base64: Base64Keyword = Object.assign(keywordSchema("string.base64"), {
		url: keywordSchema("string.base64.url"),
	});
	const date: DateStringKeyword = Object.assign(parsedKeyword<Date>("string.date"), {
		iso: parsedKeyword<Date>("string.date.iso"),
		epoch: parsedKeyword<Date>("string.date.epoch"),
	});
	const ip: IpKeyword = Object.assign(keywordSchema("string.ip"), {
		v4: keywordSchema("string.ip.v4"),
		v6: keywordSchema("string.ip.v6"),
	});
	const uuid: UuidKeyword = Object.assign(keywordSchema("string.uuid"), {
		v1: keywordSchema("string.uuid.v1"),
		v2: keywordSchema("string.uuid.v2"),
		v3: keywordSchema("string.uuid.v3"),
		v4: keywordSchema("string.uuid.v4"),
		v5: keywordSchema("string.uuid.v5"),
		v6: keywordSchema("string.uuid.v6"),
		v7: keywordSchema("string.uuid.v7"),
		v8: keywordSchema("string.uuid.v8"),
	});

	/** String validator and its refinement/morph keyword module. */
	export const string: StringKeyword = Object.defineProperties(
		makeType<string>({ k: "string" }, [], {}),
		Object.getOwnPropertyDescriptors({
			alpha: keywordSchema("string.alpha"),
			alphanumeric: keywordSchema("string.alphanumeric"),
			base64,
			capitalize: preformattedKeyword("string.capitalize"),
			creditCard: keywordSchema("string.creditCard"),
			date,
			digits: keywordSchema("string.digits"),
			email: keywordSchema("string.email"),
			hex: keywordSchema("string.hex"),
			integer: parsedKeyword<number>("string.integer"),
			ip,
			json: parsedKeyword<unknown>("string.json"),
			lower: preformattedKeyword("string.lower"),
			normalize,
			numeric: parsedKeyword<number>("string.numeric"),
			regex: keywordSchema("string.regex"),
			semver: keywordSchema("string.semver"),
			trim: preformattedKeyword("string.trim"),
			upper: preformattedKeyword("string.upper"),
			url: parsedKeyword<URL>("string.url"),
			uuid,
		}),
	) as unknown as StringKeyword;

	/** Runtime parser keyword family. */
	export const parse: ParseKeyword = {
		number: keywordSchema<number, string>("parse.number"),
		integer: keywordSchema<number, string>("parse.integer"),
		json: keywordSchema<unknown, string>("parse.json"),
		date: keywordSchema<Date, string>("parse.date"),
		url: keywordSchema<URL, string>("parse.url"),
		boolean: keywordSchema<boolean, string>("parse.boolean"),
		bigint: keywordSchema<bigint, string>("parse.bigint"),
	};

	/** Number validator with integer refinement. */
	export const number: NumberKeyword = Object.assign(makeType<number>({ k: "number" }, [], {}), {
		integer: makeType<number>({ k: "number", int: true }, [], {}),
	});

	/** Schema-valued key representing any non-negative integer array index. */
	export const arrayIndex = makeType<string>(
		{
			k: "refine",
			base: { k: "string" },
			pred: value => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value),
			expected: "a non-negative integer string",
		},
		[],
		{},
	);

	/** Boolean validator. */
	export const boolean = makeType<boolean>({ k: "boolean" }, [], {});
	/** Bigint validator. */
	export const bigint = makeType<bigint>({ k: "bigint" }, [], {});
	/** Symbol validator. */
	export const symbol = makeType<symbol>({ k: "symbol" }, [], {});
	/** Non-null object validator. */
	export const object = makeType<object>({ k: "anyobject" }, [], {});
	/** Unknown validator. */
	export const unknown = makeType<unknown>({ k: "unknown" }, [], {});
	/** Alias of the unknown validator. */
	export const any = unknown;
	/** Validator that rejects every value. */
	export const never = makeType<never>({ k: "never" }, [], {});

	/** ArkType's built-in keyword namespace, including invokable utility generics. */
	export const keywords = {
		number: { integer: number.integer },
		Map: keywordSchema<Map<unknown, unknown>>("Map"),
		Set: keywordSchema<Set<unknown>>("Set"),
		RegExp: keywordSchema<RegExp>("RegExp"),
		File: keywordSchema<File>("File"),
		Error: keywordSchema<Error>("Error"),
		Function: keywordSchema<Function>("Function"),
		Array: {
			liftFrom<const definition>(
				definition: definition,
			): FluentType<InferDef<definition>[], InferDefIn<definition> | InferDefIn<definition>[]> {
				const element = parseDef(definition);
				const array: IR = { k: "array", el: element, desc: "an object" };
				return makeType<InferDef<definition>[], InferDefIn<definition> | InferDefIn<definition>[]>(
					{
						k: "morph",
						input: { k: "union", members: [element, array] },
						fn: value => (globalThis.Array.isArray(value) ? value : [value]),
						out: array,
					},
					[],
					{},
				);
			},
		},
		Record<const key, const value>(
			key: key,
			value: value,
		): FluentType<
			Record<Extract<InferDef<key>, PropertyKey>, InferDef<value>>,
			Record<Extract<InferDefIn<key>, PropertyKey>, InferDefIn<value>>
		> {
			const keyIR = parseDef(key);
			if (keyIR.k !== "string" && keyIR.k !== "symbol") {
				throw new OmpTypeError("Record key must be assignable to string or symbol");
			}
			const valueIR = parseDef(value);
			const ir: IR =
				keyIR.k === "symbol"
					? { k: "object", props: [], symbolIndex: valueIR, extras: "keep" }
					: { k: "object", props: [], index: valueIR, extras: "keep" };
			return makeType<
				Record<Extract<InferDef<key>, PropertyKey>, InferDef<value>>,
				Record<Extract<InferDefIn<key>, PropertyKey>, InferDefIn<value>>
			>(ir, [], {});
		},
		Partial<const definition>(
			definition: definition,
		): FluentType<Partial<InferDef<definition>>, Partial<InputObject<InferDefIn<definition>>>> {
			return makeType<Partial<InferDef<definition>>, Partial<InputObject<InferDefIn<definition>>>>(
				setObjectOptionality(parseDef(definition), true, "partial"),
				[],
				{},
			);
		},
		Required<const definition>(
			definition: definition,
		): FluentType<Required<InferDef<definition>>, Required<InputObject<InferDefIn<definition>>>> {
			return makeType<Required<InferDef<definition>>, Required<InputObject<InferDefIn<definition>>>>(
				setObjectOptionality(parseDef(definition), false, "required"),
				[],
				{},
			);
		},
		Pick<const definition, const keys extends readonly PropertyKey[]>(
			definition: definition,
			...keys: keys
		): FluentType<
			Pick<InferDef<definition>, Extract<keys[number], keyof InferDef<definition>>>,
			Pick<InputObject<InferDefIn<definition>>, Extract<keys[number], keyof InputObject<InferDefIn<definition>>>>
		> {
			return makeType<
				Pick<InferDef<definition>, Extract<keys[number], keyof InferDef<definition>>>,
				Pick<InputObject<InferDefIn<definition>>, Extract<keys[number], keyof InputObject<InferDefIn<definition>>>>
			>(selectObjectProps(parseDef(definition), keys, true, "pick"), [], {});
		},
		Omit<const definition, const keys extends readonly PropertyKey[]>(
			definition: definition,
			...keys: keys
		): FluentType<
			Omit<InferDef<definition>, Extract<keys[number], keyof InferDef<definition>>>,
			Omit<InputObject<InferDefIn<definition>>, Extract<keys[number], keyof InputObject<InferDefIn<definition>>>>
		> {
			return makeType<
				Omit<InferDef<definition>, Extract<keys[number], keyof InferDef<definition>>>,
				Omit<InputObject<InferDefIn<definition>>, Extract<keys[number], keyof InputObject<InferDefIn<definition>>>>
			>(selectObjectProps(parseDef(definition), keys, false, "omit"), [], {});
		},
		Merge<const left, const right>(
			left: left,
			right: right,
		): FluentType<MergeTypes<InferDef<left>, InferDef<right>>, MergeTypes<InferDefIn<left>, InferDefIn<right>>> {
			return makeType<MergeTypes<InferDef<left>, InferDef<right>>, MergeTypes<InferDefIn<left>, InferDefIn<right>>>(
				mergeObjectDefinition(parseDef(left), right),
				[],
				{},
			);
		},
		object: {
			json: Object.defineProperties(keywordSchema<unknown>("object.json"), {
				stringify: {
					value: keywordSchema<string, unknown>("object.json.stringify"),
					enumerable: true,
				},
			}),
		},
		unknown: { any: keywordSchema<unknown>("unknown.any") },
	};
	/** Date instance validator. */
	export const Date = makeType<globalThis.Date>({ k: "instance", ctor: globalThis.Date, expected: "a Date" }, [], {});

	/** Validate instances of `ctor`. */
	export function instanceOf<const ctor extends Constructor>(ctor: ctor): FluentType<Constructed<ctor>> {
		if (typeof ctor !== "function" || ctor.prototype === undefined) {
			throw new OmpTypeError("instanceof operands must be constructors");
		}
		const name = Reflect.get(ctor, "name");
		const expected =
			ctor.prototype === Error.prototype
				? "an Error"
				: typeof name === "string" && name.length > 0
					? `an instance of ${name}`
					: "an instance";
		return makeType<Constructed<ctor>>({ k: "instance", ctor, expected }, [], {});
	}

	/** Validate one exact unit value. */
	export function unit<const value>(value: value): FluentType<value> {
		return makeType<value>({ k: "lit", v: value }, [], {});
	}

	/** Union of literal values from a runtime array. */
	export function enumerated<const values extends readonly unknown[]>(...values: values): FluentType<values[number]> {
		const members: IR[] = values.map(value => ({ k: "lit", v: value }));
		const ir: IR =
			members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
		return makeType<values[number]>(ir, [], {});
	}

	/** Build a literal union from a runtime array. */
	export function enumeration<const values extends readonly unknown[]>(values: values): FluentType<values[number]> {
		return enumerated(...values);
	}

	/** Enumerate an enum-like object's forward values, excluding numeric reverse mappings. */
	export function valueOf<const values extends Record<PropertyKey, unknown>>(
		values: values,
	): FluentType<values[keyof values]> {
		const members: IR[] = [];
		for (const key in values) {
			if (/^(?:0|[1-9]\d*)$/.test(key)) continue;
			members.push({ k: "lit", v: values[key] });
		}
		const ir: IR =
			members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
		return makeType<values[keyof values]>(ir, [], {});
	}

	/** Fluent first-match dispatcher, also exported as standalone `match`. */
	export const match: MatchParser = matchBuilder;
	/** Preserve a definition's literal type while authoring reusable modules. */
	export function define<const definition>(definition: definition): definition {
		return definition;
	}

	/** Build a function whose arguments and optional declared return are validated. */
	export const fn: FnParser = makeFn();

	/** Fix an externally declared static type while retaining runtime validation. */
	export const declare = <declared, _options = {}>(): DeclaredParser<declared> =>
		({
			type: definition => type(definition) as unknown as FluentType<declared, InferDefIn<typeof definition>>,
		}) as DeclaredParser<declared>;

	/** Build a lazy named scope from aliases and recursive definitions. */
	export function scope(aliases: Record<string, unknown>, options?: ScopeOptions): TypeScope {
		return buildScope(aliases, options);
	}

	/** Compile a named schema module whose definitions may reference each other. */
	export function module<const definitions extends Record<string, unknown>>(
		definitions: definitions,
		options?: ScopeOptions,
	): { [name in keyof definitions]: Type<InferDef<definitions[name]>, InferDefIn<definitions[name]>> } {
		return scope(definitions, options).export() as unknown as {
			[name in keyof definitions]: Type<InferDef<definitions[name]>, InferDefIn<definitions[name]>>;
		};
	}

	type GenericParameterSpec = string | readonly [name: string, constraint: unknown];

	/** Build a generic directly from an angle-bracket declaration. */
	export function generic<const definition>(parameters: `<${string}>`, definition: definition): Generic;
	/** Build a curried generic from named, optionally constrained parameters. */
	export function generic(...parameters: readonly GenericParameterSpec[]): GenericBuilder;
	export function generic(...arguments_: readonly (GenericParameterSpec | unknown)[]): Generic | GenericBuilder {
		if (arguments_.length === 2 && typeof arguments_[0] === "string" && arguments_[0].trimStart().startsWith("<")) {
			return createRuntimeGeneric(parseGenericParameters(arguments_[0]), arguments_[1]);
		}
		const parameters: GenericParameter[] = arguments_.map(parameter => {
			if (typeof parameter === "string") return { name: parameter.trim() };
			if (Array.isArray(parameter) && typeof parameter[0] === "string") {
				return { name: parameter[0].trim(), constraintDef: parameter[1] };
			}
			throw new OmpTypeError("generic parameters must be names or [name, constraint] pairs");
		});
		validateGenericParameters(parameters);
		return (definition: unknown) => createRuntimeGeneric(parameters, definition);
	}

	/** Untyped builder for runtime-assembled definitions. */
	export function raw(def: unknown): BaseType {
		return makeType(parseDef(def), [], {}) as unknown as BaseType;
	}

	/**
	 * Return a validation-only schema that emits `json` verbatim — even when
	 * embedded in an object, array, or union.
	 *
	 * A `.toJsonSchema()` method override cannot survive nesting: a parent schema
	 * emits each child's IR directly and never calls the child's method, so the
	 * override silently disappears from the wire schema. This stores the override
	 * on the IR instead.
	 *
	 * # Errors
	 *
	 * Throws when `schema` has a default or output-changing morph/pipe. A refine
	 * can preserve validation and the input value, but silently discarding a
	 * transformed output would violate the returned {@link Type}.
	 */
	export function withJsonSchema<t, i = t>(schema: Type<t, i>, json: Record<string, unknown>): Type<t, i> {
		const internal = schema as unknown as InternalType;
		if (internal.hasDefault || hasMorph(internal.ir) || internal[kSteps].some(step => step.kind === "pipe")) {
			throw new OmpTypeError("type.withJsonSchema cannot wrap schemas with defaults or output-changing morphs");
		}
		return makeType<t, i>(
			{
				k: "refine",
				base: { k: "unknown" },
				pred: value => {
					const result = schema(value);
					return result instanceof OmpErrors ? result : true;
				},
				expected: schema.expression,
				json: { ...json },
			},
			[],
			{},
		);
	}
}

// Reserved words cannot be declared as namespace bindings, but ArkType exposes
// them as runtime keyword properties.
Object.assign(type, {
	null: makeType<null>({ k: "null" }, [], {}),
	undefined: makeType<undefined>({ k: "undefined" }, [], {}),
	true: makeType<true>({ k: "lit", v: true }, [], {}),
	false: makeType<false>({ k: "lit", v: false }, [], {}),
});

export interface ScopeOptions {
	jitless?: boolean;
	clone?: false | ((input: unknown) => unknown);
	divisor?: SchemaConfig;
}

/** Callable builder bound to one alias scope. */
export type ScopedBuilder = (<const definition>(
	definition: definition,
) => FluentType<InferDef<definition>, InferDefIn<definition>>) &
	typeof type;

const MODULE_SCOPE = Symbol("omptype.moduleScope");

interface RuntimeModule extends Record<string, BaseType | RuntimeModule> {
	readonly [MODULE_SCOPE]: TypeScope;
}

/** Named schema scope with scoped parsing, imports, and bound module exports. */
export interface TypeScope {
	readonly type: ScopedBuilder;
	readonly match: MatchParser;
	readonly json: Record<string, unknown>;
	define<const definition>(definition: definition): definition;
	resolve(name: string): BaseType;
	import(...names: readonly string[]): Record<string, unknown>;
	export(...names: readonly string[]): Record<string, BaseType>;
}

/** Build a scope whose aliases resolve lazily, including recursive cycles. */
export function scope(aliases: Record<string, unknown>, options?: ScopeOptions): TypeScope {
	return buildScope(aliases, options);
}

export namespace scope {
	/** Preserve a scope definition's literal shape without constructing it. */
	export function define<const aliases>(definitions: aliases): aliases {
		return definitions;
	}
}

interface ScopeAlias {
	readonly name: string;
	readonly sourceName: string;
	readonly private: boolean;
	readonly genericParameters?: readonly GenericParameter[];
	definition: unknown;
	generic?: RuntimeGeneric;
	materialized: boolean;
}

function isRuntimeModule(value: unknown): value is RuntimeModule {
	return typeof value === "object" && value !== null && MODULE_SCOPE in value;
}

function buildScope(aliases: Record<string, unknown>, options?: ScopeOptions): TypeScope {
	const scopeMeta: TypeMeta = options?.clone === undefined ? EMPTY_META : { clone: options.clone };
	const withScopeConfig = (ir: IR): IR =>
		options?.divisor === undefined ? ir : configureSelected(ir, options.divisor, { kind: "divisor" });
	const entries = new Map<string, ScopeAlias>();
	for (const sourceName in aliases) {
		const isPrivate = sourceName.startsWith("#");
		const visibleName = isPrivate ? sourceName.slice(1) : sourceName;
		const declaration = parseGenericDeclaration(visibleName);
		const external = isRuntimeGeneric(aliases[sourceName]) ? aliases[sourceName] : undefined;
		const name = declaration?.name ?? visibleName;
		if (entries.has(name)) throw new OmpTypeError(`alias "${name}" is declared as both public and private`);
		entries.set(name, {
			name,
			sourceName,
			private: isPrivate,
			genericParameters: declaration?.parameters ?? external?.[GENERIC_META].parameters,
			definition: aliases[sourceName],
			generic: external,
			materialized: false,
		});
	}

	const references = new Map<string, IR>();
	const targets = new Map<string, IR>();
	const scopeValue: { current?: TypeScope } = {};

	const materialize = (entry: ScopeAlias): unknown => {
		if (entry.materialized) return entry.definition;
		entry.materialized = true;
		if (
			entry.genericParameters === undefined &&
			typeof entry.definition === "function" &&
			!(IR_BRAND in entry.definition)
		) {
			entry.definition = Reflect.apply(entry.definition, undefined, []);
		}
		return entry.definition;
	};

	const moduleSchema = (module: RuntimeModule, parts: readonly string[]): EmbeddableSchema | undefined => {
		let current: BaseType | RuntimeModule = module;
		for (const part of parts) {
			if (!isRuntimeModule(current)) return undefined;
			const next: BaseType | RuntimeModule | undefined = current[part];
			if (next === undefined) return undefined;
			current = next;
		}
		if (isRuntimeModule(current)) {
			const root = current.root;
			return root !== undefined && !isRuntimeModule(root) ? root : undefined;
		}
		return current;
	};

	const resolve = ((path: string): IR | undefined => {
		const [name, ...parts] = path.split(".");
		const entry = entries.get(name);
		if (entry === undefined || entry.genericParameters !== undefined) return undefined;
		const definition = materialize(entry);
		if (isRuntimeModule(definition)) {
			const schema = moduleSchema(definition, parts);
			return schema === undefined ? undefined : embed(schema);
		}
		if (parts.length !== 0) return undefined;
		const existing = references.get(name);
		if (existing !== undefined) return existing;
		const reference: IR = {
			k: "alias",
			name,
			resolve: () => {
				const target = targets.get(name);
				if (target !== undefined) return target;
				const parsed = parseDef(definition, resolve);
				targets.set(name, parsed);
				return parsed;
			},
		};
		references.set(name, reference);
		return reference;
	}) as AliasResolver;

	const genericFor = (entry: ScopeAlias): RuntimeGeneric => {
		if (entry.generic !== undefined) return entry.generic;
		const parameters = entry.genericParameters;
		if (parameters === undefined) throw new OmpTypeError(`alias "${entry.name}" is not generic`);
		entry.generic = createRuntimeGeneric(parameters, entry.definition, resolve, false);
		return entry.generic;
	};
	const genericInstantiations = new Map<string, IR>();
	resolve.hasGeneric = name => entries.get(name)?.genericParameters !== undefined;
	resolve.generic = (name, arguments_) => {
		const entry = entries.get(name);
		if (entry === undefined || entry.genericParameters === undefined) return undefined;
		const key = `${name}<${arguments_.map(expectedOf).join(",")}>`;
		const existing = genericInstantiations.get(key);
		if (existing !== undefined) return existing;
		let target: IR | undefined;
		const reference: IR = {
			k: "alias",
			name: key,
			resolve: () => {
				target ??= genericFor(entry)[GENERIC_META].instantiateIR(arguments_);
				return target;
			},
		};
		genericInstantiations.set(key, reference);
		target = genericFor(entry)[GENERIC_META].instantiateIR(arguments_);
		return target;
	};

	const bind = (schema: InternalType): InternalType => {
		Reflect.set(schema, "$", scopeValue.current);
		Reflect.set(schema, "resolver", resolve);
		return schema;
	};
	const parseScoped = (definition: unknown): InternalType =>
		bind(makeType(withScopeConfig(parseDef(definition, resolve)), EMPTY_STEPS, scopeMeta));
	const scopedMatch = createMatchParser({
		parse: definition => parseScoped(definition) as unknown as BaseType,
		branches: [],
	});
	const scoped = Object.assign((definition: unknown) => parseScoped(definition), type, {
		fn: makeFn(resolve),
		match: scopedMatch,
		...naryStatics(resolve),
	}) as unknown as ScopedBuilder;

	const targetFor = (name: string): IR => {
		const resolved = resolve(name);
		if (resolved === undefined) throw new OmpTypeError(`unknown alias "${name}"`);
		return resolved.k === "alias" ? resolved.resolve() : resolved;
	};
	const schemaFor = (name: string): BaseType =>
		bind(makeType(withScopeConfig(targetFor(name)), EMPTY_STEPS, scopeMeta)) as unknown as BaseType;

	const bindModule = (names: readonly string[]): RuntimeModule => {
		const module = {} as RuntimeModule;
		Object.defineProperty(module, MODULE_SCOPE, { value: scopeValue.current });
		for (const name of names) {
			const entry = entries.get(name);
			if (entry === undefined) continue;
			if (entry.genericParameters !== undefined) {
				module[name] = genericFor(entry) as unknown as BaseType;
				continue;
			}
			const definition = materialize(entry);
			module[name] = isRuntimeModule(definition) ? definition : schemaFor(name);
		}
		return module;
	};

	scopeValue.current = {
		type: scoped,
		match: scopedMatch,
		define<const definition>(definition: definition): definition {
			return definition;
		},
		resolve(name: string) {
			return schemaFor(name);
		},
		import(...names: readonly string[]) {
			const selected =
				names.length === 0
					? [...entries.values()].filter(entry => !entry.private)
					: names.map(name => {
							const entry = entries.get(name);
							if (entry === undefined) throw new OmpTypeError(`unknown alias "${name}"`);
							return entry;
						});
			const imported: Record<string, unknown> = {};
			for (const entry of selected) {
				imported[`#${entry.sourceName.startsWith("#") ? entry.sourceName.slice(1) : entry.sourceName}`] =
					entry.genericParameters === undefined ? schemaFor(entry.name) : genericFor(entry);
			}
			return imported;
		},
		export(...names: readonly string[]) {
			const selected =
				names.length === 0 ? [...entries.values()].filter(entry => !entry.private).map(entry => entry.name) : names;
			// Export is the eager boundary: malformed aliases and bad thunks fail here,
			// while recursive references inside valid definitions stay lazy.
			for (const entry of entries.values()) {
				if (entry.genericParameters !== undefined) genericFor(entry);
				else if (!isRuntimeModule(materialize(entry))) targetFor(entry.name);
			}
			return bindModule(selected) as unknown as Record<string, BaseType>;
		},
		get json() {
			const json: Record<string, unknown> = {};
			const add = (prefix: string, module: RuntimeModule): void => {
				for (const name of Object.keys(module)) {
					const value = module[name];
					const path = prefix === "" ? name : `${prefix}.${name}`;
					if (isRuntimeModule(value)) add(path, value);
					else json[path] = Reflect.get(value, "json");
				}
			};
			add("", bindModule([...entries.values()].filter(entry => !entry.private).map(entry => entry.name)));
			return json;
		},
	};
	return scopeValue.current;
}

/** A schema whose output type is not statically known (`type.raw` results). */
export type BaseType = FluentType<unknown, unknown>;

/**
 * Minimal structural constraint matching any omptype schema.
 *
 * `FluentType`'s recursive fluent surface makes `T extends FluentType<...>`
 * checks descend until TypeScript's depth limiter reports spurious
 * incompatibilities, and its invariant input parameter rejects concrete
 * schemas outright. This interface exposes only the schema marker plus the
 * members generic helpers commonly need — method syntax keeps parameter
 * positions bivariant, and returns recurse shallowly through `AnyType`.
 */
export interface AnyType {
	(data: unknown): unknown;
	readonly [IR_BRAND]: true;
	readonly ir: IR;
	readonly infer: unknown;
	readonly inferIn: unknown;
	readonly hasDefault: boolean;
	readonly description?: string;
	run(data: unknown): unknown;
	assert(data: unknown): unknown;
	allows(data: unknown): boolean;
	toJsonSchema(options?: ToJsonSchemaOptions): Record<string, unknown>;
	describe(description: string): AnyType;
	default(value: unknown): AnyType;
	or(def: Def): AnyType;
	and(def: Def): AnyType;
	pipe(fn: (data: never, ctx: NarrowContext) => unknown): AnyType;
	narrow(fn: (data: never, ctx: NarrowContext) => unknown): AnyType;
	array(): AnyType;
}
declare const submoduleType: unique symbol;

type BoundAlias<value> = value extends Submodule<infer aliases> ? Submodule<aliases> : FluentType<value>;

/** Exported aliases from a scope, each bound to that scope's resolver. */
export type Module<aliases extends Record<string, unknown>> = {
	readonly [name in keyof aliases]: BoundAlias<aliases[name]>;
};

/** A module nested under an alias rather than directly parseable as a schema. */
export type Submodule<aliases extends Record<string, unknown>> = {
	readonly [submoduleType]?: aliases;
} & {
	readonly [name in keyof aliases]: BoundAlias<aliases[name]>;
};

/** A selected module export whose schemas retain access to the full scope. */
export type BoundModule<
	exports extends Record<string, unknown>,
	_allAliases extends Record<string, unknown> = exports,
> = Module<exports>;

/** Type-level view of a named scope. */
export type Scope<aliases extends Record<string, unknown>> = TypeScope & {
	readonly t: aliases;
};

/** `hasMorph` re-export for diagnostics/tooling. */
export { hasMorph };
