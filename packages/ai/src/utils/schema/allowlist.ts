/**
 * Factory Gemini accepts a restricted Schema shape. Keep this projection
 * separate from shared normalizers, which preserve unsupported keywords in
 * description text instead of dropping them.
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

/**
 * How `required` combines when two schemas merge: `"union"` for conjunctions
 * (`allOf`, a parent absorbing its collapsed union) where every side's
 * constraints hold; `"intersection"` for alternatives (`anyOf`/`oneOf`
 * branches), where a field is only guaranteed when every branch requires it.
 */
type RequiredMerge = "union" | "intersection";

function dedupe(values: unknown[]): unknown[] {
	return values.filter((entry, index, array) => array.indexOf(entry) === index);
}

function mergeFactoryDroidSchemas(left: JsonObject, right: JsonObject, requiredMerge: RequiredMerge): JsonObject {
	const merged: JsonObject = { ...left };
	for (const [key, value] of Object.entries(right)) {
		if (key === "properties") {
			const leftProperties = isJsonObject(merged.properties) ? (merged.properties as JsonObject) : {};
			const rightProperties = isJsonObject(value) ? value : {};
			const properties: JsonObject = { ...leftProperties };
			for (const [name, schema] of Object.entries(rightProperties)) {
				if (isJsonObject(leftProperties[name]) && isJsonObject(schema)) {
					properties[name] = mergeFactoryDroidSchemas(leftProperties[name] as JsonObject, schema, requiredMerge);
				} else {
					properties[name] = schema;
				}
			}
			merged.properties = properties;
		} else if (key === "required") {
			// Combined below: intersection must also see a missing right-hand `required`.
		} else if (key === "enum" && Array.isArray(left.enum) && Array.isArray(value)) {
			merged.enum = dedupe([...(left.enum as unknown[]), ...(value as unknown[])]);
		} else if (!(key in merged)) {
			merged[key] = value;
		}
	}

	const leftRequired = Array.isArray(left.required) ? (left.required as unknown[]) : [];
	const rightRequired = Array.isArray(right.required) ? (right.required as unknown[]) : [];
	if (requiredMerge === "union") {
		if (Array.isArray(left.required) || Array.isArray(right.required)) {
			merged.required = dedupe([...leftRequired, ...rightRequired]);
		}
	} else {
		const shared = dedupe(leftRequired.filter(entry => rightRequired.includes(entry)));
		if (shared.length > 0) merged.required = shared;
		else delete merged.required;
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

	// anyOf/oneOf unions: merge the non-null branches (a field stays required
	// only when every branch requires it), marking the result nullable when a
	// `type: "null"` branch is present, then fold that into this node so its
	// own properties/required survive.
	const unionKey = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
	if (unionKey) {
		const branches = (node[unionKey] as unknown[])
			.map(copyFactoryDroidSchema)
			.filter((branch): branch is JsonObject => branch !== undefined);
		const nonNull = branches.filter(branch => !typeIncludesNull(branch));
		let collapsed: JsonObject | undefined;
		for (const branch of nonNull) {
			collapsed = collapsed ? mergeFactoryDroidSchemas(collapsed, branch, "intersection") : { ...branch };
		}
		if (collapsed) {
			collapsed.nullable = nonNull.length < branches.length;
			Object.assign(out, mergeFactoryDroidSchemas(out, collapsed, "union"));
		}
	}

	// allOf: merge every branch into this node's own copy.
	if (Array.isArray(node.allOf)) {
		for (const branch of node.allOf) {
			const copied = copyFactoryDroidSchema(branch);
			if (copied) Object.assign(out, mergeFactoryDroidSchemas(out, copied, "union"));
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

/** Project a dereferenced JSON Schema onto Factory Gemini's allowed fields. */
export function normalizeSchemaForFactoryDroid(value: unknown): unknown {
	if (!isJsonObject(value)) return value;
	return copyFactoryDroidSchema(value) ?? {};
}
