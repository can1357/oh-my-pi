/**
 * Validates `mcp-schema.json` (mcp.json, .mcp.json, .omp/mcp.json,
 * ~/.omp/agent/mcp.json) against the contract it exists to enforce, not the
 * particular JSON-Schema constructs it happens to use internally.
 *
 * The schema uses `allOf` to combine a shared `serverBase` (enabled, lazy,
 * timeout, requestIdFormat, auth, oauth) with a transport-specific branch,
 * closed off with `unevaluatedProperties: false` on the combined schema
 * (rather than `additionalProperties: false` on the transport branch, which
 * would reject every `serverBase` field as "additional" since `allOf`
 * branches validate independently). That's an implementation detail; what
 * matters is that real configs validate and malformed ones don't.
 *
 * This file implements a small local validator covering only the
 * JSON-Schema (2020-12) keywords `mcp-schema.json` actually uses: `type`,
 * `properties`, `required`, `additionalProperties`, `propertyNames`,
 * `items`, `uniqueItems`, `minLength`, `pattern`, `minimum`, `maximum`,
 * `enum`, `allOf`, `oneOf`, `not`, `unevaluatedProperties`, and `$ref`
 * (resolved only within `#/$defs/...`). No schema-validation dependency is
 * added; this is intentionally scoped to this one file's schema.
 */
import { describe, expect, test } from "bun:test";
import schema from "../src/config/mcp-schema.json" with { type: "json" };

interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	unevaluatedProperties?: boolean;
	propertyNames?: JsonSchema;
	items?: JsonSchema;
	uniqueItems?: boolean;
	minLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	enum?: unknown[];
	allOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	not?: JsonSchema;
	$ref?: string;
	$defs?: Record<string, JsonSchema>;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
	const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
	if (!match) throw new Error(`local validator only supports "#/$defs/<name>" refs, got: ${ref}`);
	const target = root.$defs?.[match[1]];
	if (!target) throw new Error(`unknown $ref target: ${ref}`);
	return target;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
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
		default:
			return true;
	}
}

/** Validates `value` against `schema`. Returns the object keys "evaluated" by this
 * schema (own `properties`/`additionalProperties` plus everything evaluated by
 * `allOf`/`oneOf`/`$ref`), which `unevaluatedProperties` at an outer level needs. */
function validateSchema(
	schema: JsonSchema,
	value: unknown,
	root: JsonSchema,
): { valid: boolean; evaluated: Set<string> } {
	if (schema.$ref !== undefined) {
		return validateSchema(resolveRef(schema.$ref, root), value, root);
	}

	let valid = true;
	const evaluated = new Set<string>();

	if (schema.type !== undefined && !matchesType(value, schema.type)) valid = false;
	if (schema.enum !== undefined && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) {
		valid = false;
	}

	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) valid = false;
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) valid = false;
	}

	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) valid = false;
		if (schema.maximum !== undefined && value > schema.maximum) valid = false;
	}

	if (Array.isArray(value)) {
		if (schema.items !== undefined) {
			for (const item of value) {
				if (!validateSchema(schema.items, item, root).valid) valid = false;
			}
		}
		if (schema.uniqueItems) {
			const seen = new Set(value.map(item => JSON.stringify(item)));
			if (seen.size !== value.length) valid = false;
		}
	}

	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;

		for (const key of schema.required ?? []) {
			if (!(key in obj)) valid = false;
		}

		for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
			if (!(key in obj)) continue;
			evaluated.add(key);
			if (!validateSchema(propSchema, obj[key], root).valid) valid = false;
		}

		if (schema.propertyNames !== undefined) {
			for (const key of Object.keys(obj)) {
				if (!validateSchema(schema.propertyNames, key, root).valid) valid = false;
			}
		}

		if (schema.additionalProperties !== undefined) {
			const extraKeys = Object.keys(obj).filter(key => !evaluated.has(key));
			if (schema.additionalProperties === false) {
				if (extraKeys.length > 0) valid = false;
			} else {
				for (const key of extraKeys) {
					evaluated.add(key);
					if (
						schema.additionalProperties !== true &&
						!validateSchema(schema.additionalProperties, obj[key], root).valid
					) {
						valid = false;
					}
				}
			}
		}
	}

	for (const branch of schema.allOf ?? []) {
		const result = validateSchema(branch, value, root);
		if (!result.valid) valid = false;
		for (const key of result.evaluated) evaluated.add(key);
	}

	if (schema.oneOf !== undefined) {
		const results = schema.oneOf.map(branch => validateSchema(branch, value, root));
		const matches = results.filter(result => result.valid);
		if (matches.length !== 1) {
			valid = false;
		} else {
			for (const key of matches[0].evaluated) evaluated.add(key);
		}
	}

	if (schema.not !== undefined && validateSchema(schema.not, value, root).valid) valid = false;

	if (
		schema.unevaluatedProperties !== undefined &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		const extraKeys = Object.keys(value as Record<string, unknown>).filter(key => !evaluated.has(key));
		if (schema.unevaluatedProperties === false) {
			if (extraKeys.length > 0) valid = false;
		} else {
			for (const key of extraKeys) evaluated.add(key);
		}
	}

	return { valid, evaluated };
}

function validate(document: unknown): boolean {
	return validateSchema(schema as JsonSchema, document, schema as JsonSchema).valid;
}

describe("mcp-schema.json", () => {
	test("validates a stdio server config with lazy, enabled, timeout, and auth", () => {
		expect(
			validate({
				mcpServers: {
					example: {
						command: "my-server",
						lazy: true,
						enabled: false,
						timeout: 5000,
						auth: { type: "apikey", credentialId: "cred-1" },
					},
				},
			}),
		).toBe(true);
	});

	test("validates an http server config with a url", () => {
		expect(
			validate({
				mcpServers: {
					example: { type: "http", url: "https://example.com/mcp" },
				},
			}),
		).toBe(true);
	});

	test("rejects an unknown top-level property", () => {
		expect(
			validate({
				mcpServers: {
					example: { command: "my-server" },
				},
				notARealField: true,
			}),
		).toBe(false);
	});

	test("rejects a stdio server that also sets url", () => {
		expect(
			validate({
				mcpServers: {
					example: { command: "my-server", url: "https://example.com/mcp" },
				},
			}),
		).toBe(false);
	});

	test("rejects an http server without a url", () => {
		expect(
			validate({
				mcpServers: {
					example: { type: "http" },
				},
			}),
		).toBe(false);
	});
});
