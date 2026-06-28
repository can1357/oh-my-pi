/**
 * Compute the wire (JSON Schema) representation of a tool's parameters.
 *
 * Tools may author parameters in three shapes:
 *   1. Zod (canonical) — converted to JSON Schema on demand.
 *   2. ArkType — converted to JSON Schema via its native `toJsonSchema`.
 *   3. TypeBox / plain JSON Schema (legacy + extension compat) — upgraded to
 *      draft 2020-12 without converting.
 *
 * All three are normalized at the boundary so providers and validators see the same
 * JSON Schema dialect.
 */

import type { Type } from "arktype";
// We import the Zod *value* (z) for runtime APIs. Marker checks rely on the
// `_zod` symbol that every Zod v4 schema instance carries.
import { type ZodType, z } from "zod/v4";
import type { Tool, TSchema } from "../../types";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { stamp } from "./stamps";

/**
 * True when `value` is a live Zod schema instance.
 *
 * The check is stricter than "has a `_zod` property" because a JSON
 * round-trip preserves the `_zod` key as a plain object and would otherwise
 * fool the predicate — see issue #1101, where MCP servers ship
 * `JSON.stringify(zodSchemaInstance)` as a tool's `inputSchema` and the
 * resulting plain object then explodes `z.toJSONSchema` because the prototype
 * (and every Zod parsing method) is gone.
 *
 * Live Zod instances always carry a `.parse` function on the prototype;
 * impostors do not.
 */
export function isZodSchema(value: unknown): value is ZodType {
	return (
		typeof value === "object" &&
		value !== null &&
		// Zod v4 instances expose a `_zod` internal property with a `def` object.
		// Tagging on this marker keeps the check stable across Zod minor versions.
		// (`_zod` is part of Zod's documented internal contract used by introspection.)
		// We avoid checking constructor name because Zod ships multiple variants
		// (`ZodObject`, `ZodOptional`, etc.) and a tagged-union style check would
		// have to enumerate them all.
		"_zod" in value &&
		typeof (value as { _zod?: { def?: unknown } })._zod === "object" &&
		// Reject JSON-roundtripped objects that kept the `_zod` key but lost the
		// prototype. Real instances have `.parse` on the prototype chain.
		typeof (value as { parse?: unknown }).parse === "function"
	);
}

/**
 * True when `value` is a live ArkType schema instance.
 *
 * ArkType schemas are callable functions carrying `toJsonSchema`/`assert`
 * methods. Zod v4 instances are non-callable objects (keyed off `_zod`), and
 * raw JSON Schema is a plain object — the three are disjoint. We deliberately
 * avoid the Standard Schema `~standard` marker because Zod v4 implements it too.
 */
export function isArkSchema(value: unknown): value is Type {
	return (
		typeof value === "function" &&
		typeof (value as { toJsonSchema?: unknown }).toJsonSchema === "function" &&
		typeof (value as { assert?: unknown }).assert === "function"
	);
}

function isArkJsonAst(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(isArkJsonAst);
	if (!isSchemaRecord(value)) return false;
	if (typeof value.domain === "string" || Object.hasOwn(value, "unit")) return true;
	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) return true;
	const required = value.required;
	return (
		Array.isArray(required) &&
		required.some(entry => isSchemaRecord(entry) && typeof entry.key === "string" && "value" in entry)
	);
}

function parseArkObjectKey(key: string): { name: string; description?: string } {
	const match = /^(.*?)\s*\/\*\*\s*([\s\S]*?)\s*\*\/\s*$/.exec(key);
	if (!match) return { name: key };
	return { name: match[1].trim(), description: match[2].trim() };
}

function withArkKeyDescription(schema: unknown, description: string | undefined): unknown {
	if (!description) return schema;
	if (isSchemaRecord(schema)) {
		if (typeof schema.description !== "string") schema.description = description;
		return schema;
	}
	return { anyOf: [schema], description };
}

function arkJsonAstToWire(value: unknown): unknown {
	if (typeof value === "string") {
		switch (value) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "object":
				return { type: value };
			case "unknown":
				return {};
			default:
				return {};
		}
	}

	if (Array.isArray(value)) {
		if (value.every(item => isSchemaRecord(item) && Object.hasOwn(item, "unit"))) {
			return { enum: value.map(item => (item as { unit: unknown }).unit) };
		}
		return { anyOf: value.map(arkJsonAstToWire) };
	}

	if (!isSchemaRecord(value)) return {};

	if (Object.hasOwn(value, "unit")) return { const: value.unit };

	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) {
		return { type: "array", items: arkJsonAstToWire(value.sequence) };
	}

	if (value.domain === "object") {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		const addEntry = (entry: unknown, isRequired: boolean): void => {
			if (!isSchemaRecord(entry) || typeof entry.key !== "string" || !("value" in entry)) return;
			const key = parseArkObjectKey(entry.key);
			properties[key.name] = withArkKeyDescription(arkJsonAstToWire(entry.value), key.description);
			if (isRequired) required.push(key.name);
		};
		if (Array.isArray(value.required)) {
			for (const entry of value.required) addEntry(entry, true);
		}
		if (Array.isArray(value.optional)) {
			for (const entry of value.optional) addEntry(entry, false);
		}
		const schema: Record<string, unknown> = { type: "object", properties };
		if (required.length > 0) schema.required = required;
		return schema;
	}

	if (typeof value.domain === "string") return { type: value.domain };
	return {};
}

/** Symbol-stamped caches keyed by schema object identity. */
const kZodWireSchema = Symbol("pi.schema.zod.wire");
const kJsonWireSchema = Symbol("pi.schema.json.wire");
const kArkWireSchema = Symbol("pi.schema.ark.wire");
const kStrippedSchema = Symbol("pi.schema.descriptions.stripped");

/**
 * Post-process Zod-emitted JSON Schema so it matches the wire shape providers
 * already expect from TypeBox-authored tools:
 *
 *   - Drop the `$schema` URL (providers parse the body, not the metadata).
 *   - Make fields with a `default` non-required (TypeBox/JSON-Schema semantics
 *     treat defaulted fields as optional; Zod inverts this and keeps them
 *     required at the input boundary, then materializes the default).
 *   - Strip the noisy safe-integer bounds Zod injects for `z.number().int()`.
 *
 * The empty-schema normalization (`{}` → `true`, see `normalizeEmptySchemas`)
 * runs separately from `toolWireSchema` so both Zod and TypeBox tools get it.
 */
function postProcess(schema: Record<string, unknown>): Record<string, unknown> {
	delete schema.$schema;
	walk(schema, true);
	normalizeArkPropertyComments(schema);
	normalizeEmptySchemas(schema);
	return schema;
}

function postProcessJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	walk(schema, false);
	normalizeArkPropertyComments(schema);
	normalizeEmptySchemas(schema);
	return schema;
}

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER_MIN = Number.MIN_SAFE_INTEGER;
const NULLABLE_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

const SCHEMA_DEFINING_SIBLING_KEYS = new Set([
	"$ref",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"enum",
	"if",
	"items",
	"not",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDefiningSibling(schema: Record<string, unknown>): boolean {
	for (const key in schema) {
		if (key !== "anyOf" && SCHEMA_DEFINING_SIBLING_KEYS.has(key)) return true;
	}
	return false;
}

function isNullVariant(schema: Record<string, unknown>): boolean {
	return schema.type === "null" && Object.keys(schema).length === 1;
}

function isScalarVariant(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: string } {
	return typeof schema.type === "string" && NULLABLE_SCALAR_TYPES.has(schema.type);
}

function hasIntegerType(type: unknown): boolean {
	return type === "integer" || (Array.isArray(type) && type.includes("integer"));
}

function copyNullableScalarConstraints(schema: Record<string, unknown>, scalarVariant: Record<string, unknown>): void {
	for (const key in scalarVariant) {
		if (key === "type" || key === "enum" || key === "const" || Object.hasOwn(schema, key)) continue;
		schema[key] = scalarVariant[key];
	}

	if (Object.hasOwn(scalarVariant, "const")) {
		schema.enum = [scalarVariant.const, null];
		return;
	}

	const enumValues = scalarVariant.enum;
	if (Array.isArray(enumValues)) {
		schema.enum = enumValues.includes(null) ? enumValues : [...enumValues, null];
	}
}

function rewriteNullableScalarAnyOf(schema: Record<string, unknown>): void {
	if (hasSchemaDefiningSibling(schema)) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return;

	let scalarVariant: Record<string, unknown> | undefined;
	let scalarType: string | undefined;
	let sawNull = false;
	for (const variant of variants) {
		if (!isSchemaRecord(variant)) return;
		if (isNullVariant(variant)) {
			if (sawNull) return;
			sawNull = true;
			continue;
		}
		if (!isScalarVariant(variant) || scalarVariant) return;
		scalarVariant = variant;
		scalarType = variant.type;
	}
	if (!sawNull || !scalarVariant || !scalarType) return;

	delete schema.anyOf;
	copyNullableScalarConstraints(schema, scalarVariant);
	schema.type = [scalarType, "null"];
}

/** Keys whose values are a single JSON Schema (not an array or map). */
const SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

/** Keys whose values are a map of `{ key: Schema }` entries. */
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** Keys whose values are an array of schemas. */
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

function normalizeArkPropertyComments(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeArkPropertyComments(child);
		return;
	}
	if (!isSchemaRecord(node)) return;
	const obj = node as Record<string, unknown>;

	const properties = obj.properties;
	if (isSchemaRecord(properties)) {
		const required = Array.isArray(obj.required) ? obj.required : undefined;
		if (required) {
			obj.required = required.map(key => (typeof key === "string" ? parseArkObjectKey(key).name : key));
		}
		for (const key of Object.keys(properties)) {
			const parsed = parseArkObjectKey(key);
			const targetKey = parsed.name;
			let propertySchema = properties[key];
			if (parsed.description) {
				propertySchema = withArkKeyDescription(propertySchema, parsed.description);
				delete properties[key];
				properties[targetKey] = propertySchema;
			}
			normalizeArkPropertyComments(propertySchema);
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) normalizeArkPropertyComments(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		if (mapKey === "properties") continue;
		const map = obj[mapKey];
		if (isSchemaRecord(map)) {
			for (const key in map) normalizeArkPropertyComments(map[key]);
		}
	}
	for (const arrayKey of SCHEMA_ARRAY_KEYS) {
		const array = obj[arrayKey];
		if (Array.isArray(array)) {
			for (const child of array) normalizeArkPropertyComments(child);
		}
	}
}

/** True when `val` is a plain empty object `{}`. */
function isEmptyObject(val: unknown): val is Record<string, never> {
	if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
	return Object.keys(val).length === 0;
}

/**
 * The single JSON Schema scalar `type` that describes every member of a
 * homogeneous primitive enum, or `undefined` when the members are mixed,
 * non-scalar (`null`/object/array), or the list is empty.
 */
function homogeneousEnumScalarType(values: readonly unknown[]): string | undefined {
	if (values.length === 0) return undefined;
	let inferred: string | undefined;
	for (const value of values) {
		let scalar: string | undefined;
		switch (typeof value) {
			case "string":
				scalar = "string";
				break;
			case "boolean":
				scalar = "boolean";
				break;
			case "number":
				scalar = "number";
				break;
			default:
				return undefined; // null / object / array — not a single scalar type
		}
		if (inferred === undefined) inferred = scalar;
		else if (inferred !== scalar) return undefined; // mixed primitives
	}
	return inferred;
}

/**
 * ArkType emits string-literal unions (and raw JSON-Schema tools can declare
 * enums) as a bare `{ enum: [...] }` with no `type`. That is valid JSON Schema
 * and accepted by OpenAI/Anthropic, but Gemini/Vertex — including the
 * OpenAI-compatible gateways fronting it — reject a function-declaration enum
 * that omits `type` ("schema didn't specify the schema type field"). Complete
 * the node by inferring the scalar `type` when every member shares one.
 */
function inferBareEnumScalarType(obj: Record<string, unknown>): void {
	if ("type" in obj || !Array.isArray(obj.enum)) return;
	const inferred = homogeneousEnumScalarType(obj.enum);
	if (inferred !== undefined) obj.type = inferred;
}

/**
 * ArkType serializes a *described* literal union — `type.enumerated(...).describe(d)`
 * or a `"a" | "b"` union carrying a description — as an `anyOf` of
 * `{ const, description }` branches that repeat the description on every branch
 * *and* the union root. The meta is distributed across the union's constituents
 * at the type level (each `unit` node inherits it), so the duplication is baked
 * in before serialization rather than added by this pipeline.
 *
 * Collapse such a homogeneous all-`const` union into one typed
 * `{ type, enum, description }` node: a shorter wire and a single description in
 * the place providers expect it. The collapse is conservative — applied only
 * when it is lossless:
 *   - every branch is a bare `{ const }` (optionally `{ const, description }`),
 *   - all branch values share one scalar JSON type (so `enum` gets a `type`,
 *     which Gemini/Vertex require),
 *   - branch descriptions are either all absent or all identical,
 * so a union whose branches carry *distinct* per-variant descriptions is left
 * untouched (a flat `enum` has nowhere to keep them). The union root's own
 * description wins when present; otherwise the shared branch description is kept.
 */
function collapseConstUnionAnyOf(obj: Record<string, unknown>): void {
	// `hasSchemaDefiningSibling` already rejects a sibling `enum`/`const`/etc.; it
	// does not list `type`, so guard it here — collapsing would overwrite a
	// wrapper `type` constraint paired with the `anyOf`.
	if (hasSchemaDefiningSibling(obj) || "type" in obj) return;
	const variants = obj.anyOf;
	if (!Array.isArray(variants) || variants.length < 2) return;

	const values: unknown[] = [];
	let branchDescription: string | undefined;
	let describedCount = 0;
	for (const variant of variants) {
		if (!isSchemaRecord(variant) || !Object.hasOwn(variant, "const")) return;
		for (const key in variant) {
			if (key !== "const" && key !== "description") return; // extra constraints — not a bare const
		}
		const desc = variant.description;
		if (typeof desc === "string") {
			if (describedCount === 0) branchDescription = desc;
			else if (desc !== branchDescription) return; // distinct per-variant descriptions — preserve them
			describedCount++;
		}
		values.push(variant.const);
	}
	if (describedCount !== 0 && describedCount !== variants.length) return; // mixed described/undescribed
	// A shared branch description that disagrees with the union root's own
	// description would be silently dropped by the collapse — keep the anyOf so
	// neither annotation is lost. (Equal descriptions, the ArkType case, collapse.)
	if (
		describedCount === variants.length &&
		typeof obj.description === "string" &&
		obj.description !== branchDescription
	) {
		return;
	}

	const scalarType = homogeneousEnumScalarType(values);
	if (scalarType === undefined) return; // mixed / non-scalar (incl. null) — leave as anyOf

	delete obj.anyOf;
	obj.type = scalarType;
	obj.enum = values;
	if (typeof obj.description !== "string" && branchDescription !== undefined) {
		obj.description = branchDescription;
	}
}

function walk(node: unknown, zodCleanup: boolean): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, zodCleanup);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	rewriteNullableScalarAnyOf(obj);
	inferBareEnumScalarType(obj);
	collapseConstUnionAnyOf(obj);

	if (zodCleanup) {
		// Drop noise injected for `z.number().int()`.
		if (hasIntegerType(obj.type)) {
			if (obj.minimum === SAFE_INTEGER_MIN) delete obj.minimum;
			if (obj.maximum === SAFE_INTEGER_MAX) delete obj.maximum;
		}

		// Make defaulted properties non-required.
		if (Array.isArray(obj.required) && obj.properties && typeof obj.properties === "object") {
			const properties = obj.properties as Record<string, unknown>;
			const required = obj.required as string[];
			const filtered = required.filter(name => {
				const propertySchema = properties[name];
				if (!propertySchema || typeof propertySchema !== "object") return true;
				return !("default" in (propertySchema as Record<string, unknown>));
			});
			if (filtered.length !== required.length) {
				if (filtered.length === 0) {
					delete obj.required;
				} else {
					obj.required = filtered;
				}
			}
		}
	}

	for (const k in obj) walk(obj[k], zodCleanup);
}

/**
 * Normalize `{}` (empty JSON Schema = `z.unknown()` / unconstrained value) to
 * boolean `true` in every schema-valued position. JSON Schema draft 2020-12
 * §4.3.1: `{}` and `true` are semantically equivalent ("any JSON value").
 * Grammar-constrained samplers (llama.cpp, etc.) treat the object form as
 * "generate an empty object" rather than "any JSON value", causing open-typed
 * fields like `extra.title` (from `z.record(z.string(), z.unknown())`) to
 * always emit `{}` instead of the intended string/number/etc. (issue #1179).
 *
 * Mutates in place. Provider-agnostic — applied to every tool wire schema so
 * Anthropic, Google, OpenAI, Ollama, Bedrock, and Cursor all see the
 * normalized form, regardless of whether the source was Zod or TypeBox.
 */
export function normalizeEmptySchemas(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeEmptySchemas(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key) && isEmptyObject(obj[key])) obj[key] = true;
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const k in map as Record<string, unknown>) {
				if (isEmptyObject((map as Record<string, unknown>)[k])) (map as Record<string, unknown>)[k] = true;
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) {
			for (let i = 0; i < arr.length; i++) {
				if (isEmptyObject(arr[i])) arr[i] = true;
			}
		}
	}

	for (const k in obj) normalizeEmptySchemas(obj[k]);
}

/** Convert a Zod schema into the JSON Schema shape providers consume. */
export function zodToWireSchema(schema: ZodType): Record<string, unknown> {
	return stamp(schema, kZodWireSchema, s => {
		// `target: "draft-2020-12"` matches what Anthropic's `input_schema` validator
		// requires out of the box; our other provider sanitizers (OpenAI strict,
		// Google, Anthropic CCA) already handle the superset structurally.
		const raw = z.toJSONSchema(s, { target: "draft-2020-12" }) as Record<string, unknown>;
		return postProcess(raw);
	});
}

/**
 * Recursively set `additionalProperties: false` on declared object nodes so the
 * model-facing wire matches Zod's closed emission. Only nodes that declare
 * `properties` and carry neither `additionalProperties` nor `patternProperties`
 * are closed — open record/index nodes (which already carry one of those, e.g.
 * `additionalProperties: true` after empty-schema normalization) stay open.
 *
 * Traverses only schema-valued positions via the shared traversal-key constants
 * so it never descends into `default`/`examples`/`enum`/`const` instance data.
 */
function closeDeclaredObjects(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) closeDeclaredObjects(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	const isObjectType = obj.type === "object" || (Array.isArray(obj.type) && obj.type.includes("object"));
	if (
		isObjectType &&
		obj.properties !== undefined &&
		!("additionalProperties" in obj) &&
		!("patternProperties" in obj)
	) {
		obj.additionalProperties = false;
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) closeDeclaredObjects(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const k in map as Record<string, unknown>) closeDeclaredObjects((map as Record<string, unknown>)[k]);
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) closeDeclaredObjects(child);
	}
}

/** A subschema admitting any JSON value: `{}` or boolean `true` (draft 2020-12 §4.3.1). */
function isUnconstrainedSchema(val: unknown): boolean {
	return val === true || isEmptyObject(val);
}

/**
 * ArkType-only: prune the unconstrained branch ArkType emits for a `T | undefined`
 * value-union (e.g. `{ id: "string | undefined" }`).
 *
 * `undefined` has no JSON Schema form, so `arkToWireSchema`'s `fallback` degrades the
 * `undefined` arm to the unconstrained empty schema, producing
 * `{ anyOf: [{ type: "string" }, {}] }`. That bare `{}`/`true` combiner branch makes
 * the property match any value; strict providers (OpenAI/Codex) reject it ("Invalid
 * schema for function ..."), and `enforceStrictSchema` waves the non-object `true`
 * branch straight through, so the break only surfaces server-side. This drops the
 * unconstrained branch(es) from every ArkType-emitted `anyOf`/`oneOf` and inlines the
 * lone remaining concrete branch (keeping sibling keywords like `description`).
 *
 * `required` is deliberately left untouched: ArkType validates a `T | undefined` key
 * as required-present (an absent key is rejected at runtime), so the wire must keep the
 * key required to stay consistent with runtime validation — demoting it to optional
 * would let the model omit the key (or, under strict-mode nullable wrapping, send
 * `null`) and then fail ArkType validation.
 *
 * Scoped to `arkToWireSchema` and run before `normalizeEmptySchemas` so the
 * provider-agnostic `{}`→`true` pass (issue #1179) still preserves intentional open
 * unions in Zod / raw-JSON tools. Traverses only schema-valued positions so it never
 * descends into `default`/`examples`/`enum`/`const` instance data.
 */
function pruneArkUndefinedUnionBranches(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) pruneArkUndefinedUnionBranches(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const unionKey of ["anyOf", "oneOf"] as const) {
		const branches = obj[unionKey];
		if (!Array.isArray(branches)) continue;
		const concrete = branches.filter(branch => !isUnconstrainedSchema(branch));
		if (concrete.length === branches.length || concrete.length === 0) continue;
		const only = concrete.length === 1 ? concrete[0] : undefined;
		if (only !== undefined && isSchemaRecord(only)) {
			delete obj[unionKey];
			for (const key in only) {
				if (!(key in obj)) obj[key] = only[key];
			}
		} else {
			obj[unionKey] = concrete;
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) pruneArkUndefinedUnionBranches(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const key in map as Record<string, unknown>) {
				pruneArkUndefinedUnionBranches((map as Record<string, unknown>)[key]);
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) pruneArkUndefinedUnionBranches(child);
	}
}

/**
 * Convert an ArkType schema into the JSON Schema shape providers consume.
 *
 * Mirrors {@link zodToWireSchema}: emit draft-2020-12, drop the `$schema`
 * metadata, run the JSON-schema post-process (NOT the Zod-only cleanup), then
 * close declared objects so the wire is `additionalProperties: false` like Zod.
 *
 * The `fallback` degrades any un-emittable node (a `.narrow()` predicate or a
 * morph) to its underlying base schema instead of throwing — matching Zod,
 * whose `.refine()`/`.transform()` likewise never appear in the wire schema.
 */
export function arkToWireSchema(schema: Type): Record<string, unknown> {
	return stamp(schema, kArkWireSchema, s => {
		const raw = s.toJsonSchema({ target: "draft-2020-12", fallback: ctx => ctx.base }) as Record<string, unknown>;
		delete raw.$schema;
		pruneArkUndefinedUnionBranches(raw);
		const upgraded = postProcessJsonSchema(upgradeJsonSchemaTo202012(raw) as Record<string, unknown>);
		closeDeclaredObjects(upgraded);
		return upgraded;
	});
}

/**
 * Resolve a tool's parameters to a JSON Schema object suitable for sending
 * over the wire. Zod schemas are converted (and cached); legacy TypeBox / raw
 * JSON Schema parameters are upgraded to draft 2020-12 (and cached).
 *
 * Zod schemas also receive Zod-artifact cleanup; both branches normalize
 * schema-valued positions and nullable scalar unions.
 */
export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params: TSchema = tool.parameters;
	if (isArkSchema(params)) return arkToWireSchema(params);
	if (isZodSchema(params)) return zodToWireSchema(params);
	return stamp(params as Record<string, unknown>, kJsonWireSchema, p => {
		const raw = isArkJsonAst(p) ? arkJsonAstToWire(p) : p;
		const upgraded = upgradeJsonSchemaTo202012(raw) as Record<string, unknown>;
		return postProcessJsonSchema(upgraded);
	});
}

/**
 * Schema-valued keywords whose value is a single subschema (or an array of
 * subschemas — the recursion dispatches on array-ness, so tuple forms like
 * draft-07 `items: []` are handled too). Covers the draft 2020-12 surface plus
 * the legacy `additionalItems` that may survive an incomplete upgrade.
 */
const STRIP_SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"additionalItems",
	"contains",
	"propertyNames",
	"contentSchema",
	"if",
	"then",
	"else",
	"not",
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
] as const;

/** Keywords whose value is a `{ name: Schema }` map — names are NOT annotations. */
const STRIP_SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

/**
 * Recursively strip human-readable `description` annotations from a JSON Schema,
 * descending only through schema-valued keywords so a property literally named
 * `"description"` inside a `properties`/`$defs` map keeps its schema (only its own
 * annotation is dropped), and data-bearing keywords (`default`/`const`/`examples`)
 * are never traversed. Mutates `node` in place — callers pass a clone.
 */
function stripSchemaDescriptionsInPlace(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) stripSchemaDescriptionsInPlace(child);
		return;
	}
	if (!isSchemaRecord(node)) return;
	delete node.description;
	for (const key of STRIP_SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(node, key)) stripSchemaDescriptionsInPlace(node[key]);
	}
	for (const mapKey of STRIP_SCHEMA_MAP_KEYS) {
		const map = node[mapKey];
		if (isSchemaRecord(map)) {
			for (const key in map) stripSchemaDescriptionsInPlace(map[key]);
		}
	}
}

/**
 * Return a deep clone of `schema` with every `description` annotation removed.
 * The result is memoized on the input via a non-enumerable symbol (`stamp`) so
 * repeated provider requests reuse the same stripped object; the input is never
 * mutated, so the stamped `toolWireSchema` cache stays intact for
 * system-prompt/UI rendering.
 */
export function stripSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
	return stamp(schema, kStrippedSchema, source => {
		const clone = structuredClone(source);
		stripSchemaDescriptionsInPlace(clone);
		return clone;
	});
}

/**
 * Strip a tool's human-readable text from its provider-bound spec: empties the
 * top-level `description` and removes nested schema `description` annotations.
 * Used when the full tool catalog is rendered into the system prompt instead, so
 * the descriptions ride the wire once (in the prompt) rather than duplicated on
 * every tool definition. Parameters are resolved to wire JSON Schema and cloned,
 * leaving the original tool objects and the stamped schema cache untouched.
 */
export function stripToolDescriptions(tools: readonly Tool[]): Tool[] {
	return tools.map(tool => ({
		...tool,
		description: "",
		parameters: stripSchemaDescriptions(toolWireSchema(tool)),
	}));
}
