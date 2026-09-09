import { areJsonValuesEqual } from "./equality";
import { epochNext, once } from "./stamps";
import { isJsonObject, type JsonObject } from "./types";

export const JSON_SCHEMA_DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

/** Draft-07 schema URIs we recognise as needing an upgrade. The trailing `#` is the canonical form in the JSON Schema spec, but providers (and Zod) emit both. */
const DRAFT_07_SCHEMA_URIS: Record<string, true> = {
	"http://json-schema.org/draft-07/schema#": true,
	"https://json-schema.org/draft-07/schema#": true,
	"http://json-schema.org/draft-07/schema": true,
	"https://json-schema.org/draft-07/schema": true,
};

/**
 * Keys whose values are property-name → schema maps. We recurse into each map
 * entry rather than the map object itself so legacy `definitions`-style refs
 * inside property schemas get rewritten.
 */
const SCHEMA_MAP_KEYS: Record<string, true> = { properties: true, patternProperties: true, dependentSchemas: true };
/**
 * Keys whose values are JSON-Schema *values*, not nested schemas. The upgrade
 * walker must NOT descend into these — `type: ["string","null"]` is not a
 * schema, and recursing would corrupt `enum`/`const`/`default` payloads.
 */
const NON_SCHEMA_VALUE_KEYS: Record<string, true> = {
	const: true,
	default: true,
	enum: true,
	example: true,
	examples: true,
	required: true,
	dependentRequired: true,
	type: true,
};

/** Rewrite draft-07's `#/definitions/Foo` ref form to draft 2020-12's `#/$defs/Foo`. External refs (`http://…`) pass through. */
function convertRef(value: string): string {
	return value.startsWith("#/definitions/") ? `#/$defs/${value.slice("#/definitions/".length)}` : value;
}

/** Get-or-create a child object map on `target[key]`. Used to lazily build up `$defs`/`dependentRequired`/`dependentSchemas` during conversion. */
function getObjectMap(target: JsonObject, key: string): JsonObject {
	const existing = target[key];
	if (isJsonObject(existing)) return existing;
	const next: JsonObject = {};
	target[key] = next;
	return next;
}

/** Recursively upgrade every entry of a schema-map (e.g. `properties`) and merge into `target[key]`. */
function mergeSchemaMap(target: JsonObject, key: string, value: JsonObject, cache: WeakMap<object, unknown>): void {
	const map = getObjectMap(target, key);
	for (const name in value) {
		map[name] = upgradeJsonSchemaTo202012Impl(value[name], cache);
	}
}
/** Copy a schema-map field with upgrade; non-object values are passed through verbatim. */
function copySchemaMap(target: JsonObject, key: string, value: unknown, cache: WeakMap<object, unknown>): void {
	if (!isJsonObject(value)) {
		target[key] = value;
		return;
	}
	mergeSchemaMap(target, key, value, cache);
}

/**
 * Intersect two schemas. Used when draft-07 `dependencies` map keys collide
 * with each other or with existing `dependentSchemas` entries.
 * - `true`/undefined is the identity (matches anything).
 * - `false` is the absorbing element (matches nothing).
 * - Equal schemas collapse. Otherwise wrap in `allOf` so both still apply.
 */
function combineSchemas(left: unknown, right: unknown): unknown {
	if (left === undefined || left === true) return right;
	if (right === undefined || right === true) return left;
	if (left === false || right === false) return false;
	if (areJsonValuesEqual(left, right)) return left;
	return { allOf: [left, right] };
}

/** Union two arrays of JSON values, deduping by deep equality. Used to merge `dependentRequired` arrays. */
function mergeArrayValues(left: unknown[], right: unknown[]): unknown[] {
	const merged = [...left];
	for (const value of right) {
		if (!merged.some(existing => areJsonValuesEqual(existing, value))) {
			merged.push(value);
		}
	}
	return merged;
}

/**
 * Merge converted tuple items into an existing `prefixItems` array. When the
 * same index already has a schema (e.g. from a prior recursive pass via the
 * cache), intersect the two so both constraints survive.
 */
function mergePrefixItems(existing: unknown, convertedItems: unknown[]): unknown[] {
	if (!Array.isArray(existing)) return convertedItems;
	const merged = [...existing];
	for (let index = 0; index < convertedItems.length; index += 1) {
		merged[index] = index in merged ? combineSchemas(merged[index], convertedItems[index]) : convertedItems[index];
	}
	return merged;
}

/** Record `key → deps` in `dependentRequired`, unioning with any existing array. */
function mergeDependentRequired(target: JsonObject, key: string, deps: unknown[]): void {
	const dependentRequired = getObjectMap(target, "dependentRequired");
	const existing = dependentRequired[key];
	if (existing === undefined) {
		dependentRequired[key] = deps;
		return;
	}
	if (Array.isArray(existing)) {
		dependentRequired[key] = mergeArrayValues(existing, deps);
	}
}

/** Record `key → schema` in `dependentSchemas`, intersecting with any existing entry. */
function mergeDependentSchema(target: JsonObject, key: string, schema: unknown): void {
	const dependentSchemas = getObjectMap(target, "dependentSchemas");
	dependentSchemas[key] = combineSchemas(dependentSchemas[key], schema);
}

/**
 * Convert draft-07's `dependencies` keyword (which mixes array deps and schema
 * deps under one key) into the draft 2020-12 split:
 *   - array value → `dependentRequired`
 *   - schema value → `dependentSchemas`
 */
function convertDependencies(source: JsonObject, target: JsonObject, cache: WeakMap<object, unknown>): void {
	const dependencies = source.dependencies;
	if (!isJsonObject(dependencies)) return;
	for (const key in dependencies) {
		const dependency = dependencies[key];
		const converted = upgradeJsonSchemaTo202012Impl(dependency, cache);
		if (Array.isArray(converted)) {
			mergeDependentRequired(target, key, converted);
		} else {
			mergeDependentSchema(target, key, converted);
		}
	}
}

/** True if `type` is `"null"` or an array that includes `"null"`. */
function hasNullType(type: unknown): boolean {
	return type === "null" || (Array.isArray(type) && type.includes("null"));
}

/** True if any variant in `anyOf` declares (only) a null type. Used to avoid double-adding `{type:"null"}`. */
function hasNullVariant(variants: unknown[]): boolean {
	return variants.some(variant => isJsonObject(variant) && hasNullType(variant.type));
}

/**
 * Mutate `schema` in place to accept `null`. Strategy depends on existing shape:
 *   - scalar type → expand to `[type, "null"]`.
 *   - type array → append `"null"` if missing.
 *   - existing `anyOf` → append `{type:"null"}` branch if missing.
 *   - otherwise → wrap the whole schema in `anyOf:[schema, {type:"null"}]`.
 * Returns the resulting object (which may be a new wrapper).
 */
function makeNullable(schema: JsonObject): JsonObject {
	const type = schema.type;
	if (typeof type === "string") {
		if (type !== "null") schema.type = [type, "null"];
		return schema;
	}
	if (Array.isArray(type)) {
		if (!type.includes("null")) schema.type = [...type, "null"];
		return schema;
	}
	if (Array.isArray(schema.anyOf)) {
		if (!hasNullVariant(schema.anyOf)) schema.anyOf = [...schema.anyOf, { type: "null" }];
		return schema;
	}
	return { anyOf: [schema, { type: "null" }] };
}

/** True if any entry in a schema-map needs upgrading. Shortcut used during pre-check to skip the full clone when nothing has changed. */
function schemaMapNeedsDraft202012Upgrade(value: unknown, epoch: number): boolean {
	if (!isJsonObject(value)) return false;
	for (const k in value) {
		if (schemaNeedsDraft202012UpgradeImpl(value[k], epoch)) return true;
	}
	return false;
}

/**
 * Cheap pre-check: walk the schema looking for any keyword/value that the
 * upgrade pass would have to rewrite. Lets the public entrypoint short-circuit
 * and return the input identity-unchanged when there is nothing to do.
 *
 * Uses `once(value, epoch)` to break cycles without allocating a per-call set.
 */
function schemaNeedsDraft202012UpgradeImpl(value: unknown, epoch: number): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => schemaNeedsDraft202012UpgradeImpl(entry, epoch));
	}
	if (!isJsonObject(value)) return false;
	if (!once(value, epoch)) return false;

	for (const key in value) {
		const entry = value[key];
		if (key === "$schema") {
			if (typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS) return true;
			continue;
		}
		if (key === "definitions" || key === "dependencies" || key === "additionalItems" || key === "nullable") {
			return true;
		}
		if (key === "$ref") {
			if (typeof entry === "string" && entry.startsWith("#/definitions/")) return true;
			continue;
		}
		if (key === "items" && Array.isArray(entry)) return true;
		if (key === "$defs" || key in SCHEMA_MAP_KEYS) {
			if (schemaMapNeedsDraft202012Upgrade(entry, epoch)) return true;
			continue;
		}
		if (key in NON_SCHEMA_VALUE_KEYS) continue;
		if (schemaNeedsDraft202012UpgradeImpl(entry, epoch)) return true;
	}

	return false;
}

/**
 * Recursive upgrade core. The `cache` WeakMap keys input objects to their
 * converted output so shared subgraphs are converted once and cycles terminate
 * — we insert the empty result into the cache *before* recursing so back-edges
 * resolve to a (later-populated) reference rather than infinite-looping.
 */
function upgradeJsonSchemaTo202012Impl(value: unknown, cache: WeakMap<object, unknown>): unknown {
	if (Array.isArray(value)) {
		const cached = cache.get(value);
		if (cached !== undefined) return cached;
		const result: unknown[] = [];
		cache.set(value, result);
		for (const entry of value) {
			result.push(upgradeJsonSchemaTo202012Impl(entry, cache));
		}
		return result;
	}
	if (!isJsonObject(value)) return value;

	const cached = cache.get(value);
	if (cached !== undefined) return cached;

	const result: JsonObject = {};
	// Seed cache before recursion so back-edges in cyclic graphs resolve.
	cache.set(value, result);
	for (const key in value) {
		const entry = value[key];
		// `definitions` is the draft-07 name; merge under the canonical `$defs`.
		// `$defs` may appear pre-upgraded — still walk entries to upgrade their bodies.
		if (key === "definitions" || key === "$defs") {
			if (isJsonObject(entry)) mergeSchemaMap(result, "$defs", entry, cache);
			continue;
		}
		// Recurse into each entry; the map shape itself is preserved.
		if (key in SCHEMA_MAP_KEYS) {
			copySchemaMap(result, key, entry, cache);
			continue;
		}
		// JSON-Schema *value* keywords — copy verbatim.
		if (key in NON_SCHEMA_VALUE_KEYS) {
			result[key] = entry;
			continue;
		}
		// Draft-07-only keywords with no draft 2020-12 spelling — drop entirely.
		// `items` arrays are handled below via `prefixItems` conversion.
		if (key === "dependencies" || key === "additionalItems" || key === "nullable") {
			continue;
		}
		// Rewrite `$schema` URI to the 2020-12 form; non-draft-07 URIs pass through.
		if (key === "$schema") {
			result.$schema =
				typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS ? JSON_SCHEMA_DRAFT_2020_12_URI : entry;
			continue;
		}
		// `#/definitions/Foo` → `#/$defs/Foo`.
		if (key === "$ref" && typeof entry === "string") {
			result.$ref = convertRef(entry);
			continue;
		}
		// Array-valued `items` is the draft-07 tuple form — handled after the loop.
		if (key === "items" && Array.isArray(entry)) {
			continue;
		}
		result[key] = upgradeJsonSchemaTo202012Impl(entry, cache);
	}

	// Draft-07 tuple form: `items: [a, b]` (+ optional `additionalItems`) becomes
	// draft 2020-12 `prefixItems: [a, b]` (+ optional `items` for the rest).
	if (Array.isArray(value.items)) {
		const convertedItems = upgradeJsonSchemaTo202012Impl(value.items, cache) as unknown[];
		result.prefixItems = mergePrefixItems(result.prefixItems, convertedItems);
		if (value.additionalItems !== undefined && value.additionalItems !== true) {
			result.items = upgradeJsonSchemaTo202012Impl(value.additionalItems, cache);
		} else {
			// `additionalItems: true` (or absent) in draft-07 == no `items` in 2020-12.
			delete result.items;
		}
	}

	convertDependencies(value, result, cache);

	// OpenAPI 3.0 `nullable: true` → 2020-12 nullability. `makeNullable` may
	// return a fresh wrapper object, in which case update the cache so callers
	// referring to the same input see the wrapper instead of the inner result.
	if (value.nullable === true) {
		const nullable = makeNullable(result);
		if (nullable !== result) cache.set(value, nullable);
		return nullable;
	}

	return result;
}

/** Pre-check entrypoint. Exposed so callers can decide whether to take the upgrade path at all. */
export function schemaNeedsDraft202012Upgrade(schema: unknown): boolean {
	return schemaNeedsDraft202012UpgradeImpl(schema, epochNext());
}

/**
 * Upgrade legacy JSON Schema shapes to the draft 2020-12 form emitted by Zod.
 *
 * This keeps extension/MCP/TypeBox schemas compatible with providers whose tool
 * validators reject draft-07 tuple and dependency keywords.
 */
// `WeakMap` is intentional: this cache is per-call and seeded *before* recursion
// (see `cache.set(value, result)` in `upgradeJsonSchemaTo202012Impl`) so cyclic
// graphs resolve to a knot-tied reference. A symbol stamp would either cache
// across calls (unsafe under input mutation) or require an epoch indirection.
export function upgradeJsonSchemaTo202012(schema: unknown): unknown {
	if (!schemaNeedsDraft202012Upgrade(schema)) return schema;
	return upgradeJsonSchemaTo202012Impl(schema, new WeakMap<object, unknown>());
}
