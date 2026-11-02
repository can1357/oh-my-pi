/**
 * Lowers tool JSON Schemas into the dialect Apple's `GenerationSchema` Codable
 * decoder accepts (Foundation Models, `apple-fm` provider).
 *
 * The decoder is strict: every object needs `title`, `x-order` (which also
 * selects the generated properties), `required`, and
 * `additionalProperties: false`; `anyOf` needs a `title`; a node must carry
 * `type`, `const`, `$ref`, or `anyOf`. Constructs it cannot express — free-form
 * maps, open `{}` subschemas, tuples, mixed-type enums, `allOf` — are generated
 * as JSON-encoded strings instead, and {@link decodeFoundationModelsArguments}
 * parses those back so tools receive the arguments their schema describes.
 *
 * @example
 * const { schema, encodedPaths } = toFoundationModelsSchema(toolWireSchema(tool), tool.name);
 * // …model responds with arguments…
 * const args = decodeFoundationModelsArguments(rawArgs, encodedPaths);
 */
import { dereferenceJsonSchema } from "./dereference";
import { isJsonObject, type JsonObject } from "./types";

/** Tool parameters in Foundation Models' `GenerationSchema` dialect. */
export interface FoundationModelsSchema {
	/** Root object schema accepted by `GenerationSchema`'s decoder. */
	schema: JsonObject;
	/**
	 * Argument paths whose values the model emits as JSON-encoded strings; `"*"`
	 * matches every array element.
	 */
	encodedPaths: string[][];
}

const ENCODED_SUFFIX = "(JSON-encoded value)";

/** Converts a tool's wire JSON Schema into Foundation Models' dialect. */
export function toFoundationModelsSchema(schema: unknown, name: string): FoundationModelsSchema {
	const encodedPaths: string[][] = [];
	const root = dereferenceJsonSchema(schema);
	const lowered = lower(root, titleOf(name), [], encodedPaths);
	if (lowered?.type === "object") return { schema: lowered, encodedPaths };
	// Only objects are valid tool parameters; an open root takes no arguments.
	return { schema: object(titleOf(name), {}, [], describe(root)), encodedPaths: [] };
}

/** Parses the JSON-encoded argument values produced for {@link FoundationModelsSchema.encodedPaths}. */
export function decodeFoundationModelsArguments(
	args: Record<string, unknown>,
	encodedPaths: readonly string[][],
): Record<string, unknown> {
	for (const path of encodedPaths) decodeAt(args, path, 0);
	return args;
}

function decodeAt(container: unknown, path: readonly string[], index: number): void {
	const key = path[index];
	const last = index === path.length - 1;
	if (key === "*") {
		if (!Array.isArray(container)) return;
		for (let i = 0; i < container.length; i++) {
			if (last) container[i] = parseEncoded(container[i]);
			else decodeAt(container[i], path, index + 1);
		}
		return;
	}
	if (!isJsonObject(container) || !Object.hasOwn(container, key)) return;
	if (last) container[key] = parseEncoded(container[key]);
	else decodeAt(container[key], path, index + 1);
}

function parseEncoded(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * Lowers one subschema. Returns `undefined` when the node is not expressible;
 * the caller then encodes it as a JSON string when `encoded` is non-null, or
 * propagates the failure (inside `anyOf`, where an encoded branch would make
 * decoding ambiguous).
 */
function lower(node: unknown, title: string, path: string[], encoded: string[][] | null): JsonObject | undefined {
	if (!isJsonObject(node)) return undefined;
	const description = describe(node);
	const lowered = lowerShape(node, title, path, encoded);
	if (lowered && description !== undefined && lowered.description === undefined) {
		lowered.description = description;
	}
	return lowered;
}

function lowerShape(
	node: JsonObject,
	title: string,
	path: string[],
	encoded: string[][] | null,
): JsonObject | undefined {
	if (Object.hasOwn(node, "const")) {
		return typeof node.const === "string" ? { const: node.const } : undefined;
	}
	if (Array.isArray(node.enum)) {
		return node.enum.length > 0 && node.enum.every(value => typeof value === "string")
			? { type: "string", enum: node.enum }
			: undefined;
	}
	const branches = [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(Array.isArray(node.oneOf) ? node.oneOf : []),
	];
	if (branches.length > 0) return lowerUnion(node, branches, title, path, encoded);
	if (Array.isArray(node.allOf)) {
		if (node.allOf.length !== 1 || !isJsonObject(node.allOf[0])) return undefined;
		const { allOf: _, ...rest } = node;
		return lower({ ...rest, ...node.allOf[0] }, title, path, encoded);
	}
	if (Array.isArray(node.type)) {
		const types = [...new Set(node.type.filter(type => type !== "null"))];
		if (types.length === 0) return { type: "null" };
		if (types.length === 1) return lowerShape({ ...node, type: types[0] }, title, path, encoded);
		return lowerUnion(
			node,
			types.map(type => ({ ...node, type })),
			title,
			path,
			encoded,
		);
	}
	const type = node.type ?? (isJsonObject(node.properties) ? "object" : undefined);
	switch (type) {
		case "string":
		case "boolean":
		case "null":
			return { type };
		case "integer":
		case "number": {
			const out: JsonObject = { type };
			if (typeof node.minimum === "number") out.minimum = node.minimum;
			if (typeof node.maximum === "number") out.maximum = node.maximum;
			return out;
		}
		case "array":
			return lowerArray(node, title, path, encoded);
		case "object":
			return lowerObject(node, title, path, encoded);
		default:
			return undefined;
	}
}

function lowerUnion(
	node: JsonObject,
	branches: unknown[],
	title: string,
	path: string[],
	encoded: string[][] | null,
): JsonObject | undefined {
	const { anyOf: _a, oneOf: _o, type: _t, ...shared } = node;
	const options = branches.filter(branch => !(isJsonObject(branch) && branch.type === "null"));
	if (options.length === 0) return { type: "null" };
	if (options.length === 1) {
		return isJsonObject(options[0]) ? lower({ ...shared, ...options[0] }, title, path, encoded) : undefined;
	}
	const literals = options.flatMap(option => stringLiterals(option) ?? [null]);
	if (!literals.includes(null)) return { type: "string", enum: [...new Set(literals)] };
	const anyOf: JsonObject[] = [];
	for (let i = 0; i < options.length; i++) {
		const option = options[i];
		const lowered = lower(isJsonObject(option) ? { ...shared, ...option } : option, `${title}_${i}`, path, null);
		if (!lowered) return undefined;
		delete lowered.description;
		anyOf.push(lowered);
	}
	return { title, anyOf };
}

function stringLiterals(node: unknown): string[] | undefined {
	if (!isJsonObject(node)) return undefined;
	if (typeof node.const === "string") return [node.const];
	if (Array.isArray(node.enum) && node.enum.every(value => typeof value === "string")) return node.enum;
	return undefined;
}

function lowerArray(
	node: JsonObject,
	title: string,
	path: string[],
	encoded: string[][] | null,
): JsonObject | undefined {
	if (Array.isArray(node.items) || Array.isArray(node.prefixItems)) return undefined;
	const items = child(node.items ?? true, `${title}_item`, [...path, "*"], encoded);
	if (!items) return undefined;
	const out: JsonObject = { type: "array", items };
	if (typeof node.minItems === "number") out.minItems = node.minItems;
	if (typeof node.maxItems === "number") out.maxItems = node.maxItems;
	return out;
}

function lowerObject(
	node: JsonObject,
	title: string,
	path: string[],
	encoded: string[][] | null,
): JsonObject | undefined {
	const properties = isJsonObject(node.properties) ? node.properties : {};
	const keys = Object.keys(properties);
	// A property-less object that is not explicitly closed is a free-form map.
	if (keys.length === 0 && node.additionalProperties !== false) return undefined;
	const lowered: JsonObject = {};
	for (const key of keys) {
		const property = child(properties[key], `${title}_${titleOf(key)}`, [...path, key], encoded);
		if (!property) return undefined;
		lowered[key] = property;
	}
	const required = Array.isArray(node.required)
		? node.required.filter((key): key is string => typeof key === "string" && Object.hasOwn(lowered, key))
		: [];
	return object(title, lowered, required, undefined);
}

/** Lowers a nested subschema, falling back to a JSON-encoded string when allowed. */
function child(node: unknown, title: string, path: string[], encoded: string[][] | null): JsonObject | undefined {
	const lowered = lower(node, title, path, encoded);
	if (lowered || !encoded) return lowered;
	encoded.push(path);
	const description = isJsonObject(node) ? describe(node) : undefined;
	return { type: "string", description: description ? `${description} ${ENCODED_SUFFIX}` : ENCODED_SUFFIX };
}

function object(
	title: string,
	properties: JsonObject,
	required: string[],
	description: string | undefined,
): JsonObject {
	const out: JsonObject = {
		type: "object",
		title,
		properties,
		required,
		"x-order": Object.keys(properties),
		additionalProperties: false,
	};
	if (description !== undefined) out.description = description;
	return out;
}

function describe(node: unknown): string | undefined {
	return isJsonObject(node) && typeof node.description === "string" ? node.description : undefined;
}

function titleOf(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_");
}
