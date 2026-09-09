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
	if (Array.isArray(node)) return node.map(item => dereferenceNode(item, root, visiting));

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
			if (k !== "$ref") {
				hasSiblings = true;
				break;
			}
		}
		if (!hasSiblings || !isJsonObject(inlined)) return inlined;
		const merged: JsonObject = { ...inlined, ...node };
		delete merged.$ref;
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];
		// Skip $defs/definitions — they get inlined into consumers
		if (key === "$defs" || key === "definitions") continue;

		if (Array.isArray(value)) {
			result[key] = value.map(item => dereferenceNode(item, root, visiting));
		} else if (isJsonObject(value)) {
			result[key] = dereferenceNode(value, root, visiting);
		} else {
			result[key] = value;
		}
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
