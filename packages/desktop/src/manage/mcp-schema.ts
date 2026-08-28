/**
 * Form fields derived from omp's own MCP config schema.
 *
 * The schema is imported by relative path rather than through the package's
 * exports map, whose `./config/*` entry appends `.ts` and so cannot resolve a
 * `.json` file. A relative import inside the monorepo means there is no
 * vendored copy to drift: the form always reflects the schema in this commit.
 *
 * The schema composes with `allOf` and `$ref` (each transport is
 * `serverBase` + its own object), so the fields have to be flattened before a
 * form can be generated from them.
 */

import schema from "../../../coding-agent/src/config/mcp-schema.json";

export type Transport = "stdio" | "http" | "sse";

export interface SchemaField {
	name: string;
	type: "string" | "number" | "boolean" | "array" | "record" | "unknown";
	description?: string;
	required: boolean;
	enum?: string[];
}

interface JsonSchemaNode {
	$ref?: string;
	allOf?: JsonSchemaNode[];
	type?: string;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	description?: string;
	enum?: unknown[];
	items?: JsonSchemaNode;
}

const ROOT = schema as unknown as { $defs: Record<string, JsonSchemaNode> };

function deref(node: JsonSchemaNode): JsonSchemaNode {
	if (!node.$ref) return node;
	const name = node.$ref.replace("#/$defs/", "");
	const target = ROOT.$defs[name];
	return target ? deref(target) : node;
}

/** Flatten `allOf` chains into one property bag plus a required set. */
function flatten(node: JsonSchemaNode): { properties: Record<string, JsonSchemaNode>; required: Set<string> } {
	const resolved = deref(node);
	const properties: Record<string, JsonSchemaNode> = { ...resolved.properties };
	const required = new Set(resolved.required ?? []);

	for (const member of resolved.allOf ?? []) {
		const inner = flatten(member);
		Object.assign(properties, inner.properties);
		for (const key of inner.required) required.add(key);
	}

	return { properties, required };
}

function fieldType(node: JsonSchemaNode): SchemaField["type"] {
	const resolved = deref(node);
	switch (resolved.type) {
		case "string":
		case "number":
		case "boolean":
		case "array":
			return resolved.type;
		case "object":
			return "record";
		default:
			return resolved.properties ? "record" : "unknown";
	}
}

export function fieldsFor(transport: Transport): SchemaField[] {
	const definition = ROOT.$defs[`${transport}Server`];
	if (!definition) return [];

	const { properties, required } = flatten(definition);

	return (
		Object.entries(properties)
			// `type` is the discriminant; the form owns it via the transport picker.
			.filter(([name]) => name !== "type")
			.map(([name, node]) => {
				const resolved = deref(node);
				return {
					name,
					type: fieldType(node),
					description: node.description ?? resolved.description,
					required: required.has(name),
					enum: Array.isArray(resolved.enum) ? resolved.enum.map(String) : undefined,
				};
			})
			.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
	);
}

export const TRANSPORTS: Transport[] = ["stdio", "http", "sse"];
