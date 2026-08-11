import {
	type Output,
	type OutputUnit,
	registerSchema,
	type SchemaObject,
	unregisterSchema,
	type Validator,
	validate,
} from "@hyperjump/json-schema/draft-2020-12";
import type { MCPJsonValue, MCPToolDefinition } from "./types";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_2020_12_WITH_FRAGMENT = `${DRAFT_2020_12}#`;
const RETRIEVAL_URI_PREFIX = "urn:ompk:mcp-output-schema:";

let nextRetrievalUri = 0;
const validators = new WeakMap<Record<string, unknown>, Promise<Validator>>();

/**
 * Hyperjump installs HTTP, HTTPS, and file retrieval handlers by default. MCP
 * schemas are server-provided data, so their references must resolve only to
 * resources embedded in the registered schema document; validation must never
 * fetch the network or read the local filesystem.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		return Array.isArray(value)
			? value.every(item => isJsonValue(item, ancestors))
			: Object.values(value).every(item => isJsonValue(item, ancestors));
	} finally {
		ancestors.delete(value);
	}
}

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!isJsonValue(schema)) return undefined;
	try {
		const clone = JSON.parse(JSON.stringify(schema)) as unknown;
		return isRecord(clone) ? clone : undefined;
	} catch {
		return undefined;
	}
}

type SchemaNode = boolean | Record<string, unknown>;

function resolveSchemaUri(reference: string, baseUri: string): string | undefined {
	try {
		return new URL(reference, baseUri).href;
	} catch {
		return undefined;
	}
}

function schemaDocumentUri(uri: string): string {
	const fragmentStart = uri.indexOf("#");
	return fragmentStart === -1 ? uri : uri.slice(0, fragmentStart);
}

function forEachChildSchema(
	node: Record<string, unknown>,
	visit: (child: SchemaNode, path: string) => string | undefined,
	path: string,
): string | undefined {
	const mapKeywords = ["$defs", "properties", "patternProperties", "dependentSchemas"];
	for (const keyword of mapKeywords) {
		const value = node[keyword];
		if (!isRecord(value)) continue;
		for (const [name, child] of Object.entries(value)) {
			if (child === true || child === false || isRecord(child)) {
				const problem = visit(child, `${path}/${keyword}/${name}`);
				if (problem) return problem;
			}
		}
	}

	const arrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
	for (const keyword of arrayKeywords) {
		const value = node[keyword];
		if (!Array.isArray(value)) continue;
		for (let index = 0; index < value.length; index += 1) {
			const child = value[index];
			if (child === true || child === false || isRecord(child)) {
				const problem = visit(child, `${path}/${keyword}/${index}`);
				if (problem) return problem;
			}
		}
	}

	const schemaKeywords = [
		"additionalProperties",
		"contains",
		"contentSchema",
		"else",
		"if",
		"items",
		"not",
		"propertyNames",
		"then",
		"unevaluatedItems",
		"unevaluatedProperties",
	];
	for (const keyword of schemaKeywords) {
		const child = node[keyword];
		if (child === true || child === false || isRecord(child)) {
			const problem = visit(child, `${path}/${keyword}`);
			if (problem) return problem;
		}
	}
	return undefined;
}

function inspectSchemaReferences(schema: Record<string, unknown>, retrievalUri: string): string | undefined {
	const resourceUris = new Set<string>([schemaDocumentUri(retrievalUri)]);
	const collectResources = (node: SchemaNode, baseUri: string, path: string): string | undefined => {
		if (node === true || node === false) return undefined;
		if (Object.hasOwn(node, "$vocabulary")) {
			return `${path}/$vocabulary is not permitted in server-provided outputSchema`;
		}
		if (Object.hasOwn(node, "$schema")) {
			const dialect = node.$schema;
			if (dialect !== DRAFT_2020_12 && dialect !== DRAFT_2020_12_WITH_FRAGMENT) {
				return `${path}/$schema declares an unsupported JSON Schema dialect`;
			}
		}
		let nodeBaseUri = baseUri;
		if (Object.hasOwn(node, "$id")) {
			if (typeof node.$id !== "string") return `${path}/$id must be a string`;
			const resolvedId = resolveSchemaUri(node.$id, baseUri);
			if (!resolvedId) return `${path}/$id is not a valid absolute or relative URI`;
			nodeBaseUri = resolvedId;
			resourceUris.add(schemaDocumentUri(resolvedId));
		}
		return forEachChildSchema(node, (child, childPath) => collectResources(child, nodeBaseUri, childPath), path);
	};
	const resourceProblem = collectResources(schema, retrievalUri, "(root)");
	if (resourceProblem) return resourceProblem;

	const inspectReferences = (node: SchemaNode, baseUri: string, path: string): string | undefined => {
		if (node === true || node === false) return undefined;
		let nodeBaseUri = baseUri;
		if (typeof node.$id === "string") {
			const resolvedId = resolveSchemaUri(node.$id, baseUri);
			if (!resolvedId) return `${path}/$id is not a valid absolute or relative URI`;
			nodeBaseUri = resolvedId;
		}
		for (const keyword of ["$ref", "$dynamicRef"]) {
			if (!Object.hasOwn(node, keyword)) continue;
			const reference = node[keyword];
			if (typeof reference !== "string") return `${path}/${keyword} must be a string`;
			if (reference.startsWith("#")) continue;
			const resolvedReference = resolveSchemaUri(reference, nodeBaseUri);
			if (!resolvedReference || !resourceUris.has(schemaDocumentUri(resolvedReference))) {
				return `${path}/${keyword} references a resource not embedded in this outputSchema`;
			}
		}
		return forEachChildSchema(node, (child, childPath) => inspectReferences(child, nodeBaseUri, childPath), path);
	};
	return inspectReferences(schema, retrievalUri, "(root)");
}

function normalizeDialect(schema: Record<string, unknown>): string | undefined {
	if (!Object.hasOwn(schema, "$schema")) return DRAFT_2020_12;
	const dialect = schema.$schema;
	if (dialect === DRAFT_2020_12 || dialect === DRAFT_2020_12_WITH_FRAGMENT) return DRAFT_2020_12;
	return undefined;
}

function compileOutputSchema(schema: Record<string, unknown>): Promise<Validator> {
	const existing = validators.get(schema);
	if (existing) return existing;

	const compilation = (async (): Promise<Validator> => {
		const clonedSchema = cloneSchema(schema);
		if (!clonedSchema) throw new Error("outputSchema is not a finite acyclic JSON object");
		const dialect = normalizeDialect(clonedSchema);
		if (!dialect) throw new Error("outputSchema declares an unsupported JSON Schema dialect");

		const retrievalUri = `${RETRIEVAL_URI_PREFIX}${nextRetrievalUri++}`;
		const referenceProblem = inspectSchemaReferences(clonedSchema, retrievalUri);
		if (referenceProblem) throw new Error(referenceProblem);
		clonedSchema.$schema = dialect;
		try {
			registerSchema(clonedSchema as SchemaObject, retrievalUri, dialect);
			return await validate(retrievalUri);
		} finally {
			unregisterSchema(retrievalUri);
		}
	})();
	validators.set(schema, compilation);
	void compilation.catch(() => validators.delete(schema));
	return compilation;
}

function formatValidationIssues(output: Output): string {
	if (output.valid || !output.errors || output.errors.length === 0) return "unknown validation failure";
	const issues: string[] = [];
	const visit = (error: OutputUnit): void => {
		if (error.errors && error.errors.length > 0) {
			for (const child of error.errors) visit(child);
			return;
		}
		const location = error.instanceLocation === "" ? "(root)" : error.instanceLocation;
		issues.push(`${location}: failed ${error.keyword}`);
	};
	for (const error of output.errors) visit(error);
	return issues.length > 0 ? issues.join("; ") : "unknown validation failure";
}

/**
 * Validate MCP structured content against the complete Draft 2020-12 dialect.
 * Only schemas embedded in the advertised outputSchema document can resolve;
 * missing external resources fail closed without ambient I/O.
 */
export async function validateMCPStructuredContent(
	outputSchema: MCPToolDefinition["outputSchema"],
	structuredContent: MCPJsonValue | undefined,
): Promise<string | undefined> {
	if (!outputSchema) return undefined;
	if (structuredContent === undefined) return "the tool advertised outputSchema but omitted structuredContent";

	let validator: Validator;
	try {
		validator = await compileOutputSchema(outputSchema);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("Unable to load resource")) {
			return `the tool advertised an outputSchema that could not be safely resolved: ${message}`;
		}
		return `the tool advertised an invalid or unsafe outputSchema: ${message}`;
	}

	try {
		const output = validator(structuredContent, { outputFormat: "BASIC" });
		return output.valid
			? undefined
			: `structuredContent does not match outputSchema: ${formatValidationIssues(output)}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `the tool advertised an outputSchema that could not be safely resolved: ${message}`;
	}
}
