/**
 * Detects tool-parameter schemas that pass structural JSON-Schema validation
 * (so {@link isValidJsonSchema} accepts them) yet make OpenAI-style providers
 * reject the whole request with HTTP 400 — namely an `enum`/`const` whose
 * value(s) cannot satisfy the node's declared `type`. MCP servers emit these
 * when a nullable/array branch is built incorrectly (e.g. a non-null `enum`
 * copied onto a `type: "null"` branch, or an `enum` placed on an `array`
 * schema instead of its `items`). One such tool 400s the entire turn, so
 * callers quarantine just the offending tool. See issue #2652.
 *
 * xAI additionally rejects a leftover *root* `anyOf`/`oneOf` whose branches
 * are not objects ("tool parameter root must be an object type"). That class
 * is opt-in via {@link FindStrictToolSchemaViolationOptions.rejectRootObjectUnion}
 * so OpenAI/Azure/Codex keep valid object-root unions.
 */

export interface FindStrictToolSchemaViolationOptions {
	/** Reject leftover object-root unions; xAI (paid + OAuth) 400s the whole turn when they remain. */
	rejectRootObjectUnion?: boolean;
}

type JsonRecord = Record<string, unknown>;

const SCHEMA_TYPE_NAMES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

function jsonValueMatchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			// Unknown type keyword — don't flag (forward compatibility).
			return true;
	}
}

function declaredTypes(node: JsonRecord): string[] {
	const t = node.type;
	if (typeof t === "string") return t in SCHEMA_TYPE_NAMES ? [t] : [];
	if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string" && x in SCHEMA_TYPE_NAMES);
	return [];
}

const CHILD_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const CHILD_SCHEMA_KEYS = [
	"items",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
] as const;
const CHILD_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * Walk a tool parameter schema for OpenAI-strict `enum`/`const`-vs-`type`
 * contradictions. Returns a JSON-pointer-ish path to the first offending node,
 * or `null` when the schema is safe to emit.
 */
export function findStrictToolSchemaViolation(
	schema: unknown,
	path = "#",
	options?: FindStrictToolSchemaViolationOptions,
): string | null {
	if (Array.isArray(schema)) {
		for (let i = 0; i < schema.length; i++) {
			const hit = findStrictToolSchemaViolation(schema[i], `${path}/${i}`, options);
			if (hit) return hit;
		}
		return null;
	}
	if (typeof schema !== "object" || schema === null) return null;
	const node = schema as JsonRecord;

	const types = declaredTypes(node);
	if (types.length > 0) {
		if (Array.isArray(node.enum) && node.enum.some(v => !types.some(t => jsonValueMatchesType(v, t)))) {
			return `${path}/enum`;
		}
		if ("const" in node && !types.some(t => jsonValueMatchesType(node.const, t))) {
			return `${path}/const`;
		}
	}

	// xAI rejects the whole request when the *root* schema is typed as object
	// (or has properties) AND still carries an anyOf/oneOf with a typeless or
	// non-object branch. Nested unions and pure root unions are not this error.
	if (
		options?.rejectRootObjectUnion &&
		path === "#" &&
		(types.includes("object") || (node.properties !== undefined && typeof node.properties === "object"))
	) {
		for (const key of ["anyOf", "oneOf"] as const) {
			const arr = node[key];
			if (!Array.isArray(arr) || arr.length === 0) continue;
			const hasNonObjectBranch = arr.some(branch => {
				if (typeof branch !== "object" || branch === null || Array.isArray(branch)) return true;
				const branchTypes = declaredTypes(branch as JsonRecord);
				return !branchTypes.includes("object");
			});
			if (hasNonObjectBranch) return `${path}/${key}`;
		}
	}

	for (const key of CHILD_MAP_KEYS) {
		const sub = node[key];
		if (sub && typeof sub === "object" && !Array.isArray(sub)) {
			for (const k of Object.keys(sub as JsonRecord)) {
				const hit = findStrictToolSchemaViolation((sub as JsonRecord)[k], `${path}/${key}/${k}`, options);
				if (hit) return hit;
			}
		}
	}
	for (const key of CHILD_SCHEMA_KEYS) {
		if (key in node) {
			const hit = findStrictToolSchemaViolation(node[key], `${path}/${key}`, options);
			if (hit) return hit;
		}
	}
	for (const key of CHILD_ARRAY_KEYS) {
		const arr = node[key];
		if (Array.isArray(arr)) {
			const hit = findStrictToolSchemaViolation(arr, `${path}/${key}`, options);
			if (hit) return hit;
		}
	}
	return null;
}
