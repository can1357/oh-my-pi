/**
 * Inline `$ref` / `$defs` in a JSON Schema so every consumer sees
 * the full definition without needing a resolver.
 *
 * Handles:
 * - Local `$ref` pointers (`#/$defs/Foo`, `#/definitions/Foo`)
 * - Nested `$defs` / `definitions` blocks
 * - Circular references (breaks the cycle by emitting `{}`)
 *
 * After dereferencing, `$defs` and `definitions` are stripped from the root.
 */
import { isJsonObject, type JsonObject } from "./types";

// Only schema-valued keywords may contain references; literal JSON is opaque.
const SCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependencies: true,
	dependentSchemas: true,
};
const SCHEMA_ARRAY_KEYS: Record<string, true> = { anyOf: true, oneOf: true, allOf: true, prefixItems: true };
const SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	contains: true,
	contentSchema: true,
	propertyNames: true,
	if: true,
	// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword
	then: true,
	else: true,
	not: true,
	additionalProperties: true,
	unevaluatedItems: true,
	unevaluatedProperties: true,
};

function dereferenceKeyword(key: string, value: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (Object.hasOwn(SCHEMA_MAP_KEYS, key) && isJsonObject(value)) {
		const result: JsonObject = {};
		for (const name in value) result[name] = dereferenceNode(value[name], root, visiting);
		return result;
	}
	if ((Object.hasOwn(SCHEMA_ARRAY_KEYS, key) || key === "items") && Array.isArray(value)) {
		return value.map(item => dereferenceNode(item, root, visiting));
	}
	if (Object.hasOwn(SCHEMA_VALUE_KEYS, key)) return dereferenceNode(value, root, visiting);
	return value;
}

/**
 * Resolve a JSON-pointer-style `$ref` against the root schema's `$defs`
 * or `definitions` block. Returns `undefined` for external or unresolvable refs.
 */
function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
	// Only handle local refs: #/$defs/Name or #/definitions/Name
	const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
	if (!match) return undefined;

	const [, defsKey, name] = match;
	const defs = root[defsKey!];
	if (!isJsonObject(defs)) return undefined;

	const resolved = defs[name!];
	return isJsonObject(resolved) ? resolved : undefined;
}

/**
 * Recursively dereference a JSON Schema node, inlining all local `$ref` pointers.
 */
function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (!isJsonObject(node)) return node;

	const ref = node.$ref;
	if (typeof ref === "string") {
		// Break circular references
		if (visiting.has(ref)) return {};
		const resolved = resolveLocalRef(ref, root);
		if (!resolved) return node; // External ref — leave as-is
		visiting.add(ref);
		const inlined = dereferenceNode(resolved, root, visiting);
		visiting.delete(ref);

		// Merge sibling keywords (e.g. description, default) from the
		// referencing node. In draft 2020-12 these are valid alongside $ref.
		let hasSiblings = false;
		for (const k in node) {
			if (k !== "$ref" && k !== "$defs" && k !== "definitions") {
				hasSiblings = true;
				break;
			}
		}
		if (!hasSiblings || !isJsonObject(inlined)) return inlined;
		const merged: JsonObject = { ...inlined };
		for (const key in node) {
			if (key === "$ref" || key === "$defs" || key === "definitions") continue;
			merged[key] = dereferenceKeyword(key, node[key], root, visiting);
		}
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];
		// Skip $defs/definitions — they get inlined into consumers
		if (key === "$defs" || key === "definitions") continue;

		result[key] = dereferenceKeyword(key, value, root, visiting);
	}
	return result;
}

/**
 * Dereference all local `$ref` pointers in a JSON Schema, inlining definitions
 * from `$defs` / `definitions`. The `$defs` block is stripped from the output.
 *
 * Non-local refs (e.g. `http://...`) are left untouched.
 * Circular references are broken with `{}`.
 *
 * @returns A new schema object with all local refs inlined, or the input unchanged
 *          if it's not an object or has no `$defs`/`definitions`.
 */
export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isJsonObject(schema)) return schema;

	// Fast path: nothing to dereference
	const hasDefs = schema.$defs !== undefined || schema.definitions !== undefined;
	if (!hasDefs) return schema;

	return dereferenceNode(schema, schema, new Set());
}
