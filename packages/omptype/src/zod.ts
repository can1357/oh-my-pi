import { type OmpErrors, OmpTypeError } from "./errors";
import { type EmbeddableSchema, embed, type IR, IR_BRAND, type PropIR } from "./ir";
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

export type ZodLikeSafeParseResult<Out> =
	| { success: true; data: Out }
	| { success: false; error: { message: string; issues: ZodLikeIssue[] } };

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
			const widened = schema.or(type.raw("undefined")) as Decoratable<Out | undefined>;
			return decorate(widened, true) as ZodLikeSchema<Out | undefined> & OptionalSchemaMarker;
		},
		nullable(): ZodLikeSchema<Out | null> {
			return decorate(schema.or(type.raw("null")) as Decoratable<Out | null>, optional);
		},
		default(
			value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>),
		): ZodLikeSchema<Exclude<Out, undefined>> {
			type DefaultOut = Exclude<Out, undefined>;
			const widened = schema.or(type.raw("undefined")) as Decoratable<Out | undefined>;
			const piped = widened.pipe(output => {
				if (output !== undefined) return output as DefaultOut;
				return typeof value === "function" ? (value as () => DefaultOut)() : value;
			}) as Decoratable<DefaultOut>;
			return decorate(piped.default(value as DefaultOut | (() => DefaultOut)));
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

function objectSchema<const S extends Shape>(shape: S): ZodLikeSchema<ObjectOutput<S>> {
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
	return decorateUnknown(schemaFromIR<unknown>({ k: "object", props, extras: "delete" })) as unknown as ZodLikeSchema<
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
export const union = <
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> =>
	decorate(schemaFromIR({ k: "union", members: schemas.map(schema => embed(schema)) }));
export const array = <Element>(element: ZodLikeSchema<Element>): ZodLikeSchema<Element[]> =>
	decorate(schemaFromIR({ k: "array", el: embed(element) }));
export const object = <const S extends Shape>(shape: S): ZodLikeSchema<Simplify<ObjectOutput<S>>> =>
	objectSchema(shape);
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
	record,
	unknown,
	any,
	null: nullSchema,
	undefined: undefinedSchema,
};

export namespace z {
	export type infer<Schema> = Schema extends { readonly _output: infer Out } ? Out : never;
}
