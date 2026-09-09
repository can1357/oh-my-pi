import type { InferDef, InferDefIn } from "../src/infer";

type Eq<a, b> = (<t>() => t extends a ? 1 : 2) extends <t>() => t extends b ? 1 : 2 ? true : false;

const _string: Eq<InferDef<"string">, string> = true;
const _number: Eq<InferDef<"number">, number> = true;
const _integer: Eq<InferDef<"number.integer">, number> = true;
const _boolean: Eq<InferDef<"boolean">, boolean> = true;
const _null: Eq<InferDef<"null">, null> = true;
const _undefined: Eq<InferDef<"undefined">, undefined> = true;
const _unknown: Eq<InferDef<"unknown">, unknown> = true;
const _absent: Eq<InferDef, unknown> = true;
const _object: Eq<InferDef<"object">, object> = true;
const _bigint: Eq<InferDef<"bigint">, bigint> = true;
const _url: Eq<InferDef<"string.url">, string> = true;
const _singleQuoted: Eq<InferDef<"'x'">, "x"> = true;
const _doubleQuoted: Eq<InferDef<'"x"'>, "x"> = true;
const _digit: Eq<InferDef<"5">, 5> = true;
const _true: Eq<InferDef<"true">, true> = true;
const _false: Eq<InferDef<"false">, false> = true;
const _literalUnion: Eq<InferDef<"'a' | 'b'">, "a" | "b"> = true;
const _nullableUnion: Eq<InferDef<"string | null">, string | null> = true;
const _spacedUnion: Eq<InferDef<"  string\t|\n null  ">, string | null> = true;
const _array: Eq<InferDef<"string[]">, string[]> = true;
const _unionArray: Eq<InferDef<"(string | number)[]">, (string | number)[]> = true;
const _nestedArray: Eq<InferDef<"string[][]">, string[][]> = true;
const _lowerBound: Eq<InferDef<"number >= 0">, number> = true;
const _stringBounds: Eq<InferDef<"1 <= string <= 10">, string> = true;
const _numberBounds: Eq<InferDef<"0 < number <= 3600">, number> = true;
const _numberDefault: Eq<InferDef<"number = 5">, number> = true;
const _stringDefault: Eq<InferDef<"string='eve'">, string> = true;
const _booleanDefault: Eq<InferDef<"boolean = false">, boolean> = true;
const _garbage: Eq<InferDef<"not valid">, unknown> = true;
const _dateBound: Eq<InferDef<"Date >= d'2020-01-01'">, Date> = true;
const _parseDateOutput: Eq<InferDef<"string.date.iso.parse">, Date> = true;
const _parseDateInput: Eq<InferDefIn<"string.date.iso.parse">, string> = true;
const _parseUrlOutput: Eq<InferDef<"parse.url">, URL> = true;
const _parseUrlInput: Eq<InferDefIn<"parse.url">, string> = true;
const _partialRecord: Eq<InferDef<"Partial<Record<string, number>>">, Partial<Record<string, number>>> = true;

type ObjectDef = {
	a: "string";
	"b?": "number";
	"withDefault?": "number = 5";
	"+": "reject";
	nested: { enabled: "boolean"; list: readonly ["string", "[]"] };
};
type ObjectOut = {
	a: string;
	b?: number;
	withDefault: number;
	nested: { enabled: boolean; list: string[] };
};
type ObjectIn = {
	a: string;
	b?: number;
	withDefault?: number;
	nested: { enabled: boolean; list: string[] };
};
const _objectDefinition: Eq<InferDef<ObjectDef>, ObjectOut> = true;
const _mutableTupleArray: Eq<InferDef<["number", "[]"]>, number[]> = true;
const _readonlyTupleArray: Eq<InferDef<readonly ["number", "[]"]>, number[]> = true;
const _record: Eq<InferDef<{ "[string]": "boolean" }>, Record<string, boolean>> = true;
const _recordWithProps: Eq<
	InferDef<{ name: "string"; "[string]": "unknown" }>,
	{ name: string } & Record<string, unknown>
> = true;

type Embedded = { infer: { id: number } };
type DefaultedEmbedded = { infer: string; readonly hasDefault: true };
const _embedded: Eq<InferDef<Embedded>, { id: number }> = true;
const _embeddedUnionMember: Eq<
	InferDef<{ value: Embedded | { infer: null } }>,
	{ value: { id: number } | null }
> = true;
const _embeddedDefault: Eq<InferDef<{ "name?": DefaultedEmbedded }>, { name: string }> = true;
const _inputAlias: Eq<InferDefIn<ObjectDef>, ObjectIn> = true;
const _badProperty: Eq<InferDef<{ value: symbol }>, { value: unknown }> = true;
type MorphTuple = readonly ["string.numeric.parse", readonly ["number", "=", 1]];
const _morphTupleOutput: Eq<InferDef<MorphTuple>, [number, number]> = true;
const _morphTupleInput: Eq<InferDefIn<MorphTuple>, [string, number?]> = true;

// Representative definitions checked against explicit expected output inference.
type FlatTool = { command: "string"; timeout: "number"; "cwd?": "string" };
type EnumObject = { mode: "'fast' | 'safe'"; "verbose?": "boolean" };
type NestedTuple = { matrix: readonly [readonly ["number", "[]"], "[]"] };
type StringRecord = { "[string]": "string" };
const _arkFlat: Eq<InferDef<FlatTool>, { command: string; timeout: number; cwd?: string }> = true;
const _arkEnum: Eq<InferDef<EnumObject>, { mode: "fast" | "safe"; verbose?: boolean }> = true;
const _arkNested: Eq<InferDef<NestedTuple>, { matrix: number[][] }> = true;
const _arkRecord: Eq<InferDef<StringRecord>, Record<string, string>> = true;
const _arkBounds: Eq<InferDef<" 0 < number <= 3600 ">, number> = true;
// Definition-level default output is number.
const _arkDefaultOutput: Eq<InferDef<"number = 5">, number> = true;
