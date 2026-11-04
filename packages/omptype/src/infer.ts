/** Type-level input and output inference for definitions accepted by omptype. */
import type { SchemaAcceptance, SchemaFacts, schemaFacts, schemaKeys } from "./schema-inference";

type Whitespace = " " | "\n" | "\r" | "\t";

type TrimLeft<s extends string> = s extends `${Whitespace}${infer rest}` ? TrimLeft<rest> : s;
type TrimRight<s extends string> = s extends `${infer rest}${Whitespace}` ? TrimRight<rest> : s;
type Trim<s extends string> = TrimLeft<TrimRight<s>>;

/**
 * Flat keyword lookup. An indexed access is one instantiation level, unlike a
 * nested conditional chain — this sits under every string-DSL property, so its
 * depth is multiplied by every layer of object nesting above it.
 * `never` is intentionally absent: the parser rejects it and the fallback in
 * `InferMember` treats a missing entry as "not a primitive".
 */
type ArkAny = ReturnType<typeof JSON.parse>;

interface PrimitiveMap {
	string: string;
	"string.url": string;
	number: number;
	"number.integer": number;
	"number.epoch": number;
	"number.safe": number;
	"number.NaN": number;
	"number.Infinity": number;
	"number.NegativeInfinity": number;
	boolean: boolean;
	null: null;
	undefined: undefined;
	unknown: unknown;
	"unknown.any": ArkAny;
	any: unknown;
	object: object;
	bigint: bigint;
	symbol: symbol;
	Key: PropertyKey;
	Date: Date;
	Array: unknown[];
	Function: Function;
	RegExp: RegExp;
	File: File;
	Error: Error;
	Set: Set<unknown>;
	Map: Map<unknown, unknown>;
	WeakSet: WeakSet<WeakKey>;
	WeakMap: WeakMap<WeakKey, unknown>;
	Promise: Promise<unknown>;
	FormData: FormData;
	"object.json": unknown;
	true: true;
	false: false;
}

type Merge<left, right> = left extends object
	? right extends object
		? Omit<left, keyof right> & right
		: never
	: never;

type InferUtility<s extends string> = s extends `Record<${string},${infer value}>`
	? Record<string, InferString<value>>
	: s extends `Array<${infer element}>` | `Array.liftFrom<${infer element}>`
		? InferString<element>[]
		: s extends `Partial<${infer value}>`
			? Partial<InferString<value>>
			: s extends `Required<${infer value}>`
				? Required<InferString<value>>
				: s extends `Pick<${infer value},${infer keys}>`
					? Pick<InferString<value>, Extract<InferString<keys>, keyof InferString<value>>>
					: s extends `Omit<${infer value},${infer keys}>`
						? Omit<InferString<value>, Extract<InferString<keys>, keyof InferString<value>>>
						: s extends `Merge<${infer left},${infer right}>`
							? Merge<InferString<left>, InferString<right>>
							: never;

/** Output types of morph (`.parse`) keywords; `never` when `s` is not one. */
type InferParse<s extends string> = s extends
	| "string.numeric.parse"
	| "string.integer.parse"
	| "parse.number"
	| "parse.integer"
	? number
	: s extends "string.date.parse" | "string.date.iso.parse" | "string.date.epoch.parse" | "parse.date"
		? Date
		: s extends "string.url.parse" | "parse.url"
			? URL
			: s extends "string.json.parse" | "parse.json"
				? unknown
				: s extends "object.json.stringify"
					? string
					: s extends "FormData.parse"
						? Record<string, Bun.FormDataEntryValue | Bun.FormDataEntryValue[]>
						: s extends "parse.boolean"
							? boolean
							: s extends "parse.bigint"
								? bigint
								: never;

/**
 * Member inference as a flat false-branch chain: TypeScript tail-evaluates
 * chained conditionals in the false position, so this stays at constant
 * instantiation depth where the previous `extends infer` ladder nested every
 * fallback inside a true branch and accumulated depth per step.
 */
type InferMember<member extends string> = Trim<member> extends infer s extends string ? InferMemberTrimmed<s> : unknown;

type InferMemberTrimmed<s extends string> = s extends `(${infer inner})`
	? InferString<inner>
	: s extends `${infer element}[]`
		? InferMember<element>[]
		: s extends `'${infer literal}'` | `"${infer literal}"`
			? literal
			: s extends `d'${string}'` | `d"${string}"`
				? Date
				: s extends `\`${string}\``
					? string
					: s extends `/${string}/${string}` | `/${string}/`
						? string
						: s extends `${infer literal extends number}`
							? literal
							: s extends keyof PrimitiveMap
								? PrimitiveMap[s]
								: [InferParse<s>] extends [never]
									? InferUtility<s> extends infer utility
										? [utility] extends [never]
											? InferMemberFallback<s>
											: utility
										: unknown
									: InferParse<s>;

type InferMemberFallback<s extends string> = s extends `string.${string}`
	? string
	: s extends `${string}Date${string}`
		? Date
		: s extends `${string}string${string}`
			? string
			: s extends `${string}number${string}`
				? number
				: unknown;

/** Split unions without distributing over the accumulated members. */
type InferUnion<s extends string, result = never> = s extends `${infer head}|${infer tail}`
	? InferUnion<tail, result | InferMember<head>>
	: result | InferMember<s>;

/** Input side of one union member: morph keywords accept their source type. */
type InferMemberIn<member extends string> =
	Trim<member> extends infer s extends string
		? s extends `${string}.parse` | `parse.${string}`
			? string
			: InferMemberTrimmed<s>
		: unknown;

/** Split unions on the input side without distributing over accumulated members. */
type InferUnionIn<s extends string, result = never> = s extends `${infer head}|${infer tail}`
	? InferUnionIn<tail, result | InferMemberIn<head>>
	: result | InferMemberIn<s>;

type HasInlineDefault<s extends string> = s extends `${string}=${string}`
	? s extends `${string}<${string}` | `${string}>${string}`
		? false
		: true
	: false;

type WithoutInlineDefault<s extends string> =
	HasInlineDefault<s> extends true ? (s extends `${infer base}=${string}` ? Trim<base> : s) : s;

type InferStringOutput<s extends string> = InferUnion<s>;

/** String-DSL output inference. */
export type InferString<s extends string> =
	WithoutInlineDefault<Trim<s>> extends infer trimmed extends string
		? trimmed extends `${infer base}?`
			? InferString<base>
			: trimmed extends `(${infer inner})[]`
				? InferUnion<inner>[]
				: InferStringOutput<trimmed>
		: unknown;

/** String-DSL input inference, preserving the source side of morph keywords. */
export type InferStringIn<s extends string> =
	WithoutInlineDefault<Trim<s>> extends infer trimmed extends string
		? trimmed extends `${infer base}?`
			? InferStringIn<base>
			: trimmed extends `(${infer inner})[]`
				? InferUnionIn<inner>[]
				: InferUnionIn<trimmed>
		: unknown;

type HasDefault<def> = def extends string
	? HasInlineDefault<def>
	: def extends readonly [unknown, "=", unknown]
		? true
		: def extends { readonly hasDefault: true }
			? true
			: false;

type DefinitionKeys<def extends object> = Exclude<keyof def, "+" | "[string]" | "...">;

type IsOptionalProp<key, def> = key extends `${string}?`
	? true
	: def extends string
		? Trim<def> extends `${string}?`
			? true
			: false
		: def extends readonly [unknown, "?"]
			? true
			: false;

type PropName<key extends PropertyKey> = key extends `${infer name}?` ? name : key;
type UnwrapProperty<def> = def extends readonly [infer value, "?" | "=", ...unknown[]] ? value : def;
type Simplify<t> = { [key in keyof t]: t[key] };

type OutputRequired<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? HasDefault<def[key]> extends true
				? PropName<key>
				: never
			: PropName<key>
	]-?: InferDef<UnwrapProperty<def[key]>>;
};

type OutputOptional<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? HasDefault<def[key]> extends true
				? never
				: PropName<key>
			: never
	]?: InferDef<UnwrapProperty<def[key]>>;
};

type InputRequired<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? never
			: HasDefault<def[key]> extends true
				? never
				: PropName<key>
	]-?: InferDefIn<UnwrapProperty<def[key]>>;
};

type InputOptional<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? PropName<key>
			: HasDefault<def[key]> extends true
				? PropName<key>
				: never
	]?: InferDefIn<UnwrapProperty<def[key]>>;
};

/**
 * CYCLE SAFETY: when a fluent generic method is called on a schema whose def
 * embeds other schemas, TypeScript instantiates `InferDef<def>` while `def`
 * is still generic. `"..." extends keyof def` resolves TRUE under permissive
 * instantiation (`keyof any` contains every literal), so spread/index members
 * cannot be deferred by wrapper conditionals — a bare `InferDef<def["..."]>`
 * member re-enters this expansion and instantiates without bound (TS2589).
 * Interface members only instantiate when resolved, so routing the recursive
 * reference through `DefBox` keeps generic instantiation shallow: it stops at
 * a type reference plus an indexed access instead of expanding `InferDef`.
 */
interface DefBox<def> {
	readonly out: InferDef<def>;
	readonly in: InferDefIn<def>;
	readonly keys: InferSchemaKeys<def>;
	readonly requiredOut: InferRequiredDef<def>;
	readonly requiredIn: InferRequiredDefIn<def>;
}

type OutputSpread<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["out"] : unknown;
type InputSpread<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["in"] : unknown;
type SpreadKeys<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["keys"] : never;

// Property order is not represented by an object type, so either side may replace a shared key.
type SpreadObject<local, spread, keys extends PropertyKey> = [keys] extends [never]
	? Simplify<local>
	: [Extract<keyof local, keys>] extends [never]
		? Simplify<local & spread>
		: Simplify<Omit<spread, keyof local> & local> | Simplify<Omit<local, keys> & spread>;
type OutputIndex<def extends object> = "[string]" extends keyof def
	? Record<string, DefBox<def["[string]"]>["out"]>
	: unknown;
type InputIndex<def extends object> = "[string]" extends keyof def
	? Record<string, DefBox<def["[string]"]>["in"]>
	: unknown;

type InferObject<def extends object> = "[string]" extends keyof def
	? [DefinitionKeys<def>] extends [never]
		? Record<string, DefBox<def["[string]"]>["out"]>
		: SpreadObject<OutputRequired<def> & OutputOptional<def>, OutputSpread<def>, SpreadKeys<def>> & OutputIndex<def>
	: SpreadObject<OutputRequired<def> & OutputOptional<def>, OutputSpread<def>, SpreadKeys<def>>;

type InferObjectIn<def extends object> = "[string]" extends keyof def
	? [DefinitionKeys<def>] extends [never]
		? Record<string, DefBox<def["[string]"]>["in"]>
		: SpreadObject<InputRequired<def> & InputOptional<def>, InputSpread<def>, SpreadKeys<def>> & InputIndex<def>
	: SpreadObject<InputRequired<def> & InputOptional<def>, InputSpread<def>, SpreadKeys<def>>;

/** Object-literal inference used by fluent composition overloads. */
export type InferObjectDef<def extends object> = InferObject<def>;

type InferLiteralDef<def> = def extends { readonly infer: infer output }
	? output
	: def extends string
		? InferString<def>
		: def extends object
			? InferObjectLiteral<def>
			: unknown;

type InferLiteralDefIn<def> = def extends { readonly inferIn: infer input }
	? input
	: def extends string
		? InferStringIn<def>
		: def extends object
			? InferObjectLiteralIn<def>
			: unknown;

type LiteralRequired<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? HasDefault<def[key]> extends true
				? PropName<key>
				: never
			: PropName<key>
	]-?: InferLiteralDef<UnwrapProperty<def[key]>>;
};

type LiteralOptional<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? HasDefault<def[key]> extends true
				? never
				: PropName<key>
			: never
	]?: InferLiteralDef<UnwrapProperty<def[key]>>;
};

type LiteralRequiredIn<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? never
			: HasDefault<def[key]> extends true
				? never
				: PropName<key>
	]-?: InferLiteralDefIn<UnwrapProperty<def[key]>>;
};

type LiteralOptionalIn<def extends object> = {
	-readonly [
		key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
			? PropName<key>
			: HasDefault<def[key]> extends true
				? PropName<key>
				: never
	]?: InferLiteralDefIn<UnwrapProperty<def[key]>>;
};

/** Object-literal inference that unwraps embedded schema values one level deep. */
export type InferObjectLiteral<def extends object> = SpreadObject<
	LiteralRequired<def> & LiteralOptional<def>,
	OutputSpread<def>,
	SpreadKeys<def>
>;

/** Input-side object-literal inference (embedded schemas contribute `inferIn`). */
export type InferObjectLiteralIn<def extends object> = SpreadObject<
	LiteralRequiredIn<def> & LiteralOptionalIn<def>,
	InputSpread<def>,
	SpreadKeys<def>
>;

type InstanceOf<ctor> = ctor extends abstract new (...args: never[]) => infer instance ? instance : never;
type SpreadOutput<def> = InferDef<def> extends readonly (infer element)[] ? element[] : never[];
type SpreadInput<def> = InferDefIn<def> extends readonly (infer element)[] ? element[] : never[];

type InferTupleOutput<defs extends readonly unknown[], result extends unknown[] = []> = defs extends readonly []
	? result
	: defs extends readonly ["...", infer spread, ...infer rest]
		? [...result, ...SpreadOutput<spread>, ...InferTupleOutput<rest>]
		: defs extends readonly [infer head, ...infer rest]
			? head extends readonly [infer value, "?"]
				? InferTupleOutput<rest, [...result, InferDef<value>?]>
				: head extends readonly [infer value, "=", unknown]
					? InferTupleOutput<rest, [...result, InferDef<value>]>
					: InferTupleOutput<rest, [...result, InferDef<head>]>
			: result;

type InferTupleInput<defs extends readonly unknown[], result extends unknown[] = []> = defs extends readonly []
	? result
	: defs extends readonly ["...", infer spread, ...infer rest]
		? [...result, ...SpreadInput<spread>, ...InferTupleInput<rest>]
		: defs extends readonly [infer head, ...infer rest]
			? head extends readonly [infer value, "?" | "=", ...unknown[]]
				? InferTupleInput<rest, [...result, InferDefIn<value>?]>
				: InferTupleInput<rest, [...result, InferDefIn<head>]>
			: result;

/**
 * True only for `any` (`1 & any` is `any`; `0 extends any` holds). During
 * relation checking TypeScript instantiates these aliases permissively with
 * every type parameter replaced by `any`, and under `any` the object branch
 * recurses forever (`any["..."]` is `any` again). Cutting `any` off up front
 * makes permissive instantiation terminate immediately, mirroring ArkType's
 * `anyOrNever` guards.
 */
type IsAny<def> = 0 extends 1 & def ? true : false;

/** Infer the validated output type produced by a definition. */
export type InferDef<def = unknown> =
	IsAny<def> extends true
		? unknown
		: def extends { readonly infer: infer output }
			? output
			: def extends string
				? InferString<def>
				: def extends RegExp
					? string
					: def extends readonly [infer element, "[]"]
						? InferDef<element>[]
						: def extends readonly [infer left, "|", infer right]
							? InferDef<left> | InferDef<right>
							: def extends readonly [infer left, "&", infer right]
								? InferDef<left> & InferDef<right>
								: def extends readonly [unknown, "=>", (...args: never[]) => infer output]
									? output
									: def extends readonly [unknown, "|>", infer output]
										? InferDef<output>
										: def extends readonly [infer base, ":", unknown] | readonly [infer base, "@", unknown]
											? InferDef<base>
											: def extends readonly ["keyof", infer base]
												? InferSchemaKeys<base>
												: def extends readonly ["instanceof", ...infer constructors]
													? InstanceOf<constructors[number]>
													: def extends readonly ["===", ...infer values]
														? values[number]
														: def extends readonly unknown[]
															? InferTupleOutput<def>
															: def extends object
																? InferObject<def>
																: unknown;

/** Infer values accepted before defaults and morphs are applied. */
export type InferDefIn<def = unknown> =
	IsAny<def> extends true
		? unknown
		: def extends { readonly inferIn: infer input }
			? input
			: def extends string
				? InferStringIn<def>
				: def extends RegExp
					? string
					: def extends readonly [infer element, "[]"]
						? InferDefIn<element>[]
						: def extends readonly [infer left, "|", infer right]
							? InferDefIn<left> | InferDefIn<right>
							: def extends readonly [infer left, "&", infer right]
								? InferDefIn<left> & InferDefIn<right>
								: def extends readonly [infer input, "=>", unknown] | readonly [infer input, "|>", unknown]
									? InferDefIn<input>
									: def extends readonly [infer base, ":", unknown] | readonly [infer base, "@", unknown]
										? InferDefIn<base>
										: def extends readonly ["keyof", infer base]
											? InferSchemaKeys<base>
											: def extends readonly ["instanceof", ...infer constructors]
												? InstanceOf<constructors[number]>
												: def extends readonly ["===", ...infer values]
													? values[number]
													: def extends readonly unknown[]
														? InferTupleInput<def>
														: def extends object
															? InferObjectIn<def>
															: unknown;

/** Required properties without discarding an explicitly accepted undefined value. */
export type RequiredValues<value> = { [key in keyof Required<value>]: value[key] };

type InferredSchema = { readonly infer: unknown; readonly inferIn: unknown };

/** Possible structural keys, including keys hidden by a schema annotation. */
export type InferSchemaKeys<def> =
	IsAny<def> extends true
		? PropertyKey
		: def extends InferredSchema & { readonly [schemaKeys]?: infer keys extends PropertyKey }
			? keys
			: def extends readonly [infer left, "|", infer right]
				? InferSchemaKeys<left> & InferSchemaKeys<right>
				: def extends readonly [infer left, "&", infer right]
					? InferSchemaKeys<left> | InferSchemaKeys<right>
					: def extends readonly [infer base, "=>" | "|>" | ":" | "@", unknown]
						? InferSchemaKeys<base>
						: def extends { readonly "...": infer base }
							? InferSchemaKeys<base> | keyof InferDefIn<def>
							: unknown extends InferDefIn<def>
								? PropertyKey
								: keyof InferDefIn<def>;

type RequiredProperties<def extends object> = {
	-readonly [key in DefinitionKeys<def> as PropName<key>]-?: InferDef<UnwrapProperty<def[key]>>;
};
type RequiredPropertiesIn<def extends object> = {
	-readonly [key in DefinitionKeys<def> as PropName<key>]-?: InferDefIn<UnwrapProperty<def[key]>>;
};
type RequiredSpread<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["requiredOut"] : unknown;
type RequiredSpreadIn<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["requiredIn"] : unknown;

/** Output of making a definition's structural properties required. */
export type InferRequiredDef<def> =
	IsAny<def> extends true
		? unknown
		: def extends InferredSchema & { readonly [schemaFacts]?: infer facts }
			? facts extends SchemaFacts<infer required, unknown, PropertyKey, unknown, unknown>
				? required
				: RequiredValues<InferDef<def>>
			: def extends readonly unknown[]
				? RequiredValues<InferDef<def>>
				: def extends object
					? SpreadObject<RequiredProperties<def>, RequiredSpread<def>, SpreadKeys<def>> & OutputIndex<def>
					: RequiredValues<InferDef<def>>;

/** Input of making a definition's structural properties required. */
export type InferRequiredDefIn<def> =
	IsAny<def> extends true
		? unknown
		: def extends InferredSchema & { readonly [schemaFacts]?: infer facts }
			? facts extends SchemaFacts<unknown, infer required, PropertyKey, unknown, unknown>
				? required
				: RequiredValues<InferDefIn<def>>
			: def extends readonly unknown[]
				? RequiredValues<InferDefIn<def>>
				: def extends object
					? SpreadObject<RequiredPropertiesIn<def>, RequiredSpreadIn<def>, SpreadKeys<def>> & InputIndex<def>
					: RequiredValues<InferDefIn<def>>;

type ExactString<text extends string> =
	Trim<text> extends infer value extends string
		? value extends `${infer left}|${infer right}`
			? ExactString<left> extends true
				? ExactString<right>
				: false
			: value extends
						| "string"
						| "number"
						| "boolean"
						| "bigint"
						| "symbol"
						| "null"
						| "undefined"
						| "unknown"
						| "object"
						| "true"
						| "false"
						| `'${string}'`
						| `"${string}"`
						| `${number}`
				? true
				: false
		: false;
type ExactDefinition<def> =
	IsAny<def> extends true
		? false
		: def extends InferredSchema & { readonly [schemaFacts]?: infer facts }
			? facts extends SchemaFacts<unknown, unknown, PropertyKey, SchemaAcceptance<infer _value>, unknown>
				? true
				: false
			: def extends string
				? ExactString<def>
				: def extends readonly unknown[]
					? false
					: def extends object
						? Extract<keyof def, "+" | "..." | "[string]" | `${string}?`> extends never
							? false extends { [key in keyof def]: ExactDefinition<def[key]> }[keyof def]
								? false
								: true
							: false
						: false;
type FactsOutputKeys<def> = def extends InferredSchema & { readonly [schemaFacts]?: infer facts }
	? facts extends SchemaFacts<unknown, unknown, infer keys, unknown, unknown>
		? keys
		: PropertyKey
	: def extends readonly [unknown, "=>", unknown]
		? PropertyKey
		: def extends readonly [unknown, "|>", infer target]
			? FactsOutputKeys<target>
			: def extends readonly [infer left, "|", infer right]
				? FactsOutputKeys<left> & FactsOutputKeys<right>
				: def extends readonly [infer left, "&", infer right]
					? FactsOutputKeys<left> | FactsOutputKeys<right>
					: InferSchemaKeys<def>;
type FactsOutputRequired<def> = def extends readonly [unknown, "=>", unknown]
	? unknown
	: def extends readonly [unknown, "|>", infer target]
		? InferRequiredDef<target>
		: InferRequiredDef<def>;

/** Concrete structural facts; annotations of a schema do not reconstruct erased knowledge. */
export type InferSchemaFacts<def> =
	IsAny<def> extends true
		? unknown
		: def extends InferredSchema & { readonly [schemaFacts]?: infer facts }
			? facts
			: SchemaFacts<
					InferRequiredDef<def>,
					InferRequiredDefIn<def>,
					FactsOutputKeys<def>,
					ExactDefinition<def> extends true
						? SchemaAcceptance<def extends string ? InferDef<def> : InferDef<def> & object>
						: unknown,
					FactsOutputRequired<def>
				>;
