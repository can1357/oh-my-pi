/**
 * Factory droid Gemini tool-schema copier (allowlist semantics).
 *
 * The droid CLI translates tool parameters for the gemini wire with an
 * ALLOWLIST copier: it copies a fixed set of JSON Schema keywords per node and
 * silently drops everything else ($ref, additionalProperties, exclusive*,
 * multipleOf, ...). It never emits `propertyOrdering`, never edits
 * descriptions, stringifies enum values, converts `const` to a single-entry
 * `enum`, merges `allOf` branches, and collapses `anyOf`/`oneOf` unions that
 * contain a `type: "null"` branch into `nullable: true`. This is the opposite
 * strategy of the shared normalizers (which strip keywords and fold the
 * overflow into description text), so it lives here as a wire-local copier
 * instead of an option on the shared engine.
 */
import { isJsonObject, type JsonObject } from "./types";

/** Schema keywords the CLI copies through verbatim. */
const FACTORY_DROID_ALLOWED_KEYS: Record<string, true> = {
	type: true,
	title: true,
	description: true,
	required: true,
	format: true,
	minimum: true,
	maximum: true,
	minLength: true,
	maxLength: true,
	pattern: true,
	minItems: true,
	maxItems: true,
	default: true,
	example: true,
};

function stringifySchemaValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** True when the node's `type` (string or array form) includes "null". */
function typeIncludesNull(node: JsonObject): boolean {
	if (node.type === "null") return true;
	return Array.isArray(node.type) && (node.type as unknown[]).includes("null");
}

function mergeFactoryDroidSchemas(left: JsonObject, right: JsonObject): JsonObject {
	const merged: JsonObject = { ...left };
	for (const [key, value] of Object.entries(right)) {
		if (key === "properties") {
			const leftProperties = isJsonObject(merged.properties) ? (merged.properties as JsonObject) : {};
			const rightProperties = isJsonObject(value) ? value : {};
			const properties: JsonObject = { ...leftProperties };
			for (const [name, schema] of Object.entries(rightProperties)) {
				if (isJsonObject(leftProperties[name]) && isJsonObject(schema)) {
					properties[name] = mergeFactoryDroidSchemas(leftProperties[name] as JsonObject, schema);
				} else {
					properties[name] = schema;
				}
			}
			merged.properties = properties;
		} else if (key === "required" && Array.isArray(left.required) && Array.isArray(value)) {
			merged.required = [...(left.required as unknown[]), ...(value as unknown[])].filter(
				(entry, index, array) => array.indexOf(entry) === index,
			);
		} else if (key === "enum" && Array.isArray(left.enum) && Array.isArray(value)) {
			merged.enum = [...(left.enum as unknown[]), ...(value as unknown[])].filter(
				(entry, index, array) => array.indexOf(entry) === index,
			);
		} else if (!(key in merged)) {
			merged[key] = value;
		}
	}
	return merged;
}

function copyFactoryDroidSchema(node: unknown): JsonObject | undefined {
	if (!isJsonObject(node)) return undefined;

	const out: JsonObject = {};
	for (const key of Object.keys(FACTORY_DROID_ALLOWED_KEYS)) {
		if (key in node) out[key] = node[key];
	}
	if ("const" in node) out.enum = [stringifySchemaValue(node.const)];
	if (Array.isArray(node.enum)) out.enum = node.enum.map(stringifySchemaValue);

	if (isJsonObject(node.properties)) {
		const properties: JsonObject = {};
		for (const [name, schema] of Object.entries(node.properties)) {
			const copied = copyFactoryDroidSchema(schema);
			if (copied !== undefined) properties[name] = copied;
		}
		out.properties = properties;
	}
	if (isJsonObject(node.items)) {
		const copied = copyFactoryDroidSchema(node.items);
		if (copied !== undefined) out.items = copied;
	}

	// anyOf/oneOf unions: merge the non-null branches, marking the result
	// nullable when a `type: "null"` branch is present.
	const unionKey = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
	if (unionKey) {
		const branches = (node[unionKey] as unknown[])
			.map(copyFactoryDroidSchema)
			.filter((branch): branch is JsonObject => branch !== undefined);
		const nonNull = branches.filter(branch => !typeIncludesNull(branch));
		let collapsed: JsonObject | undefined;
		for (const branch of nonNull) {
			collapsed = collapsed ? mergeFactoryDroidSchemas(collapsed, branch) : { ...branch };
		}
		if (collapsed) {
			collapsed.nullable = nonNull.length < branches.length;
			Object.assign(out, collapsed);
		}
	}

	// allOf: merge every branch into this node's own copy.
	if (Array.isArray(node.allOf)) {
		for (const branch of node.allOf) {
			const copied = copyFactoryDroidSchema(branch);
			if (copied) Object.assign(out, mergeFactoryDroidSchemas(out, copied));
		}
	}

	// The Schema proto takes a single string `type`: collapse draft-2020-12
	// type unions the way the shared normalizer does — a null branch becomes
	// `nullable: true`, the first non-null type wins.
	if (Array.isArray(out.type)) {
		const types = (out.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null")) out.nullable = true;
		out.type = nonNull[0] ?? types[0];
	}
	// The proxy's Schema proto requires a type; infer one when the source
	// omitted it, the same way the CLI's copier does.
	if (!("type" in out)) {
		if (isJsonObject(out.properties)) out.type = "object";
		else if ("items" in out) out.type = "array";
		else if ("enum" in out) out.type = "string";
	}
	return out;
}

/**
 * Normalize a JSON Schema tool parameter into the droid CLI's gemini
 * allowlist shape: preserved keywords only, merged combiners, stringified
 * enums, `nullable` from null unions, never `propertyOrdering`.
 */
export function normalizeSchemaForFactoryDroid(value: unknown): unknown {
	if (!isJsonObject(value)) return value;
	return copyFactoryDroidSchema(value) ?? {};
}
