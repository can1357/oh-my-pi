import {
	CCA_UNSUPPORTED_SCHEMA_FIELDS,
	COMBINATOR_KEYS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { isJsonObject, type JsonObject } from "./types";

/**
 * Schema compatibility audits.
 *
 * Each provider has a different idea of what JSON Schema features it accepts
 * for tool definitions. The normalizers in `normalize.ts`, `strict-mode`,
 * and `adapt.ts` rewrite incoming schemas to fit. This module is the
 * *audit* counterpart: it walks a (presumably already-sanitized) schema and
 * reports any feature the target provider would reject. Tests use it to lock
 * down the contract; the runtime uses it to fail-open with diagnostic logs
 * rather than silently shipping a broken tool definition.
 */
export type SchemaCompatibilityProvider = "openai-strict" | "google" | "cloud-code-assist-claude";

export interface SchemaCompatibilityViolation {
	path: string;
	rule: string;
	message: string;
	key?: string;
	value?: unknown;
}

export interface SchemaCompatibilityResult {
	provider: SchemaCompatibilityProvider;
	compatible: boolean;
	violations: SchemaCompatibilityViolation[];
}

export interface StrictSchemaEnforcementResult {
	schema: Record<string, unknown>;
	strict: boolean;
}

// Per-provider forbidden-key sets. Subsets of the shared `fields.ts` constants
// plus a few provider-specific extras (`const`, `nullable`) folded in here so
// each rule is defined in exactly one place.
const STRICT_FORBIDDEN_KEYS: Record<string, true> = { ...NON_STRUCTURAL_SCHEMA_KEYS, const: true, nullable: true };
const GOOGLE_FORBIDDEN_KEYS: Record<string, true> = { ...UNSUPPORTED_SCHEMA_FIELDS, const: true };
const CCA_FORBIDDEN_KEYS: Record<string, true> = { ...CCA_UNSUPPORTED_SCHEMA_FIELDS, const: true };

// Keys whose values are JSON-Schema *containers* (arrays of values, scalars,
// etc.) rather than nested schemas. The traversal must skip these — recursing
// would walk into `enum` strings or `default` objects and emit spurious
// violations against keys that happen to share JSON-Schema keyword names.
const NON_SCHEMA_CONTAINER_ARRAY_KEYS: Record<string, true> = {
	enum: true,
	required: true,
	examples: true,
	type: true,
};
const NON_SCHEMA_CONTAINER_OBJECT_KEYS: Record<string, true> = { const: true, default: true, example: true };

interface TraversalState {
	path: string;
}

function createViolation(
	path: string,
	rule: string,
	message: string,
	key?: string,
	value?: unknown,
): SchemaCompatibilityViolation {
	return {
		path,
		rule,
		message,
		...(key === undefined ? {} : { key }),
		...(value === undefined ? {} : { value }),
	};
}

/**
 * Recursively visit every schema node in a JSON Schema tree.
 *
 * The walker is *structural*, not type-aware: it knows which keywords contain
 * nested schemas vs. plain values, so it descends into `properties.*`,
 * `$defs.*`, `items`, combinator arrays, etc. but never into `enum`, `const`,
 * `default`, or `type` arrays.
 */
function walkSchema(
	value: unknown,
	state: TraversalState,
	visitNode: (node: JsonObject, state: TraversalState) => void,
): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			walkSchema(value[index], { path: `${state.path}[${index}]` }, visitNode);
		}
		return;
	}

	if (!isJsonObject(value)) {
		return;
	}

	visitNode(value, state);

	for (const key in value) {
		// Schema-map keywords: value is `{ name: schema, … }`. Recurse into each
		// entry's schema rather than the map object itself.
		const entry = value[key];
		if (key === "properties" || key === "$defs" || key === "definitions" || key === "dependentSchemas") {
			if (isJsonObject(entry)) {
				for (const name in entry) {
					const child = entry[name];
					walkSchema(child, { path: `${state.path}.${key}.${name}` }, visitNode);
				}
			}
			continue;
		}
		// Non-schema container keywords — values are not schemas, do not descend.

		if (key in NON_SCHEMA_CONTAINER_ARRAY_KEYS || key in NON_SCHEMA_CONTAINER_OBJECT_KEYS) {
			continue;
		}
		// Array-of-schemas keywords (e.g. `allOf`, `anyOf`, `oneOf`, `prefixItems`).

		if (Array.isArray(entry)) {
			for (let index = 0; index < entry.length; index++) {
				walkSchema(entry[index], { path: `${state.path}.${key}[${index}]` }, visitNode);
			}
			continue;
		}

		if (isJsonObject(entry)) {
			walkSchema(entry, { path: `${state.path}.${key}` }, visitNode);
		}
	}
}

/**
 * Strict-mode audit (OpenAI Responses / Codex `strict: true`):
 *  1. Forbid keywords that strict mode disallows (`format`, `pattern`, `const`,
 *     `nullable`, etc. — see `STRICT_FORBIDDEN_KEYS`).
 *  2. Every node must declare *something* concrete: a `type`, a combinator,
 *     a `$ref`, or a `not` branch. Empty `{}` is rejected.
 *  3. Object nodes must set `additionalProperties: false`, declare a real
 *     `properties` map, and require every property in that map. Required
 *     properties not in `properties` are also rejected — strict mode demands
 *     a closed object shape.
 */
function validateStrictNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const key in node) {
		const value = node[key];
		if (!(key in STRICT_FORBIDDEN_KEYS)) {
			continue;
		}

		violations.push(
			createViolation(
				`${state.path}.${key}`,
				"strict-forbidden-key",
				`Strict schema contains forbidden key "${key}"`,
				key,
				value,
			),
		);
	}
	// Rule 2: node must declare at least one concrete shape descriptor.

	const hasCombinator = COMBINATOR_KEYS.some(key => Array.isArray(node[key]));
	const hasRef = typeof node.$ref === "string";
	const hasNot = isJsonObject(node.not);
	if (node.type === undefined && !hasCombinator && !hasRef && !hasNot) {
		violations.push(
			createViolation(
				state.path,
				"strict-unrepresentable-node",
				"Strict schema node must declare type, combinator, $ref, or not",
			),
		);
	}
	// Rules 3a-3d apply only to object-shaped nodes.

	const isObjectNode = node.type === "object" || isJsonObject(node.properties);
	if (!isObjectNode) {
		return violations;
	}

	if (node.additionalProperties !== false) {
		violations.push(
			createViolation(
				`${state.path}.additionalProperties`,
				"strict-object-additional-properties",
				"Strict object schema must set additionalProperties to false",
				"additionalProperties",
				node.additionalProperties,
			),
		);
	}
	// 3b: `properties` must exist and be an object — without it strict mode has nothing to validate.

	if (!isJsonObject(node.properties)) {
		violations.push(
			createViolation(
				`${state.path}.properties`,
				"strict-object-properties",
				"Strict object schema must provide an object-valued properties map",
				"properties",
				node.properties,
			),
		);
		return violations;
	}

	const propertyNames = Object.keys(node.properties);
	const requiredValues = Array.isArray(node.required)
		? node.required.filter((entry): entry is string => typeof entry === "string")
		: [];
	const requiredSet = new Set(requiredValues);

	for (const propertyName of propertyNames) {
		if (requiredSet.has(propertyName)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.required`,
				"strict-object-required",
				`Strict object schema must require property "${propertyName}"`,
				"required",
				node.required,
			),
		);
	}
	// 3d: any property declared in `required` but missing from `properties` is unrepresentable.

	const propertyNameSet = new Set(propertyNames);
	for (const requiredKey of requiredValues) {
		if (propertyNameSet.has(requiredKey)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.required`,
				"strict-object-required-extra",
				`Strict object schema requires non-existent property "${requiredKey}"`,
				"required",
				node.required,
			),
		);
	}

	return violations;
}

function validateGoogleNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const key in node) {
		const value = node[key];
		if (!(key in GOOGLE_FORBIDDEN_KEYS)) {
			continue;
		}
		violations.push(
			createViolation(
				`${state.path}.${key}`,
				"google-forbidden-key",
				`Google schema contains unsupported key "${key}"`,
				key,
				value,
			),
		);
	}

	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"google-type-array",
				"Google schema type must be a scalar string, not an array",
				"type",
				node.type,
			),
		);
	}

	return violations;
}

function validateCloudCodeAssistNode(node: JsonObject, state: TraversalState): SchemaCompatibilityViolation[] {
	const violations: SchemaCompatibilityViolation[] = [];

	for (const key in node) {
		const value = node[key];
		if (key in CCA_FORBIDDEN_KEYS) {
			violations.push(
				createViolation(
					`${state.path}.${key}`,
					"cca-forbidden-key",
					`Cloud Code Assist schema contains unsupported key "${key}"`,
					key,
					value,
				),
			);
		}
	}

	if (Array.isArray(node.type)) {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"cca-type-array",
				"Cloud Code Assist schema forbids array-valued type",
				"type",
				node.type,
			),
		);
	}

	if (node.type === "null") {
		violations.push(
			createViolation(
				`${state.path}.type`,
				"cca-null-type",
				'Cloud Code Assist schema forbids type: "null"',
				"type",
				node.type,
			),
		);
	}

	if (Object.hasOwn(node, "nullable")) {
		violations.push(
			createViolation(
				`${state.path}.nullable`,
				"cca-nullable-key",
				"Cloud Code Assist schema forbids nullable keyword",
				"nullable",
				node.nullable,
			),
		);
	}

	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(node[key])) {
			violations.push(
				createViolation(
					`${state.path}.${key}`,
					"cca-combiner",
					`Cloud Code Assist schema forbids ${key}`,
					key,
					node[key],
				),
			);
		}
	}

	return violations;
}

function validateCloudCodeAssistSchema(schema: unknown): SchemaCompatibilityViolation[] {
	if (isValidJsonSchema(schema)) {
		return [];
	}
	return [
		createViolation(
			"root",
			"cca-meta-schema-validation",
			"Cloud Code Assist schema is not a structurally valid JSON Schema",
		),
	];
}

export function validateSchemaCompatibility(
	schema: unknown,
	provider: SchemaCompatibilityProvider,
): SchemaCompatibilityResult {
	const violations: SchemaCompatibilityViolation[] = [];

	switch (provider) {
		case "openai-strict": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateStrictNode(node, state));
			});
			break;
		}
		case "google": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateGoogleNode(node, state));
			});
			break;
		}
		case "cloud-code-assist-claude": {
			walkSchema(schema, { path: "root" }, (node, state) => {
				violations.push(...validateCloudCodeAssistNode(node, state));
			});
			violations.push(...validateCloudCodeAssistSchema(schema));
			break;
		}
	}

	return {
		provider,
		compatible: violations.length === 0,
		violations,
	};
}

export function validateStrictSchemaEnforcement(
	originalSchema: Record<string, unknown>,
	result: StrictSchemaEnforcementResult,
): SchemaCompatibilityResult {
	if (result.strict) {
		return validateSchemaCompatibility(result.schema, "openai-strict");
	}

	const violations: SchemaCompatibilityViolation[] = [];
	if (result.schema !== originalSchema) {
		violations.push(
			createViolation(
				"root",
				"strict-fail-open-original-schema",
				"Strict fail-open must return the original schema object when strict=false",
			),
		);
	}

	return {
		provider: "openai-strict",
		compatible: violations.length === 0,
		violations,
	};
}
