import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports (ESM/CJS interop)
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types";

// ============================================================================
// Type Coercion Utilities
// ============================================================================
//
// LLMs sometimes produce tool arguments where a value that should be a number,
// boolean, array, or object is instead passed as a JSON-encoded string. For
// example, an array parameter might arrive as `"[1, 2, 3]"` instead of `[1, 2, 3]`.
//
// Rather than rejecting these outright, we attempt automatic coercion:
//   1. AJV validates the arguments and reports type errors
//   2. For each type error where the actual value is a string, we check if
//      parsing it as JSON yields a value matching the expected type
//   3. If so, we replace the string with the parsed value and re-validate
//
// This is intentionally conservative: we only parse strings that look like
// valid JSON literals (objects, arrays, booleans, null, numbers) and only
// accept the result if it matches the schema's expected type.
// ============================================================================

/** Regex matching valid JSON number literals (integers, decimals, scientific notation) */
const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Normalizes AJV's `params.type` into a consistent string array.
 * AJV may report the expected type as a single string or an array of strings
 * (for union types like `["string", "null"]`).
 */
function normalizeExpectedTypes(typeParam: unknown): string[] {
	if (typeof typeParam === "string") return [typeParam];
	if (Array.isArray(typeParam)) {
		return typeParam.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

/**
 * Checks if a value matches any of the expected JSON Schema types.
 * Used to verify that a parsed JSON value is actually what the schema wants.
 */
function matchesExpectedType(value: unknown, expectedTypes: string[]): boolean {
	return expectedTypes.some((type) => {
		switch (type) {
			case "string":
				return typeof value === "string";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "integer":
				return typeof value === "number" && Number.isInteger(value);
			case "boolean":
				return typeof value === "boolean";
			case "null":
				return value === null;
			case "array":
				return Array.isArray(value);
			case "object":
				return value !== null && typeof value === "object" && !Array.isArray(value);
			default:
				return false;
		}
	});
}

/**
 * Attempts to parse a string as JSON if it looks like a JSON literal and
 * the parsed result matches one of the expected types.
 *
 * Only attempts parsing for strings that syntactically look like JSON:
 *   - Objects: `{...}`
 *   - Arrays: `[...]`
 *   - Literals: `true`, `false`, `null`, or numeric strings
 *
 * Returns `{ changed: true }` only if parsing succeeded AND the result
 * matches an expected type. This prevents false positives like parsing
 * the string `"123"` when the schema actually wants a string.
 */
function tryParseJsonForTypes(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	// Quick syntactic checks to avoid unnecessary parse attempts
	const looksJsonObject = trimmed.startsWith("{") && trimmed.endsWith("}");
	const looksJsonArray = trimmed.startsWith("[") && trimmed.endsWith("]");
	const looksJsonLiteral =
		trimmed === "true" || trimmed === "false" || trimmed === "null" || JSON_NUMBER_PATTERN.test(trimmed);

	if (!looksJsonObject && !looksJsonArray && !looksJsonLiteral) {
		return { value, changed: false };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		// Only accept if the parsed type matches what the schema expects
		if (matchesExpectedType(parsed, expectedTypes)) {
			return { value: parsed, changed: true };
		}
	} catch {
		// Invalid JSON - leave as-is
		return { value, changed: false };
	}

	return { value, changed: false };
}

// ============================================================================
// JSON Pointer Utilities (RFC 6901)
// ============================================================================
//
// AJV reports error locations using JSON Pointer syntax (e.g., `/foo/0/bar`).
// These utilities allow reading and writing values at those paths.
// ============================================================================

/**
 * Decodes a JSON Pointer string into path segments.
 * Handles RFC 6901 escape sequences: ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Retrieves a value from a nested object/array structure using a JSON Pointer.
 * Returns undefined if the path doesn't exist or traversal fails.
 */
function getValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Sets a value in a nested object/array structure using a JSON Pointer.
 * Mutates the structure in-place. Returns the root (possibly unchanged if
 * the path was invalid).
 */
function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
	if (!pointer) return value;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	// Navigate to the parent of the target location
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];
		if (current === null || current === undefined) return root;
		if (Array.isArray(current)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return root;
			current = current[arrayIndex];
			continue;
		}
		if (typeof current !== "object") return root;
		current = (current as Record<string, unknown>)[segment];
	}

	// Set the value at the final segment
	const lastSegment = segments[segments.length - 1];
	if (Array.isArray(current)) {
		const arrayIndex = Number(lastSegment);
		if (!Number.isInteger(arrayIndex)) return root;
		current[arrayIndex] = value;
		return root;
	}

	if (typeof current !== "object" || current === null) return root;
	(current as Record<string, unknown>)[lastSegment] = value;
	return root;
}

/**
 * Deep clones a JSON-serializable value.
 * Uses structuredClone when available (faster), falls back to JSON round-trip.
 */
function cloneJsonValue<T>(value: T): T {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Attempts to fix type errors by parsing JSON-encoded strings.
 *
 * When AJV reports type errors, this function checks if the offending values
 * are strings that contain valid JSON matching the expected type. If so, it
 * returns a new args object with those strings replaced by their parsed values.
 *
 * The function is designed to be safe and conservative:
 *   - Only processes "type" errors (not format, pattern, etc.)
 *   - Only attempts coercion on string values
 *   - Only accepts parsed results that match the expected type
 *   - Clones the args object before mutation (copy-on-write)
 */
function coerceArgsFromErrors(
	args: unknown,
	errors: Array<{ keyword?: string; instancePath?: string; params?: { type?: unknown } }> | null | undefined,
): { value: unknown; changed: boolean } {
	if (!errors || errors.length === 0) return { value: args, changed: false };

	let changed = false;
	let nextArgs: unknown = args;

	for (const error of errors) {
		// Only handle type mismatch errors
		if (error.keyword !== "type") continue;

		const instancePath = error.instancePath ?? "";
		const expectedTypes = normalizeExpectedTypes(error.params?.type);
		if (expectedTypes.length === 0) continue;

		// Get the current value at the error location
		const currentValue = getValueAtPointer(nextArgs, instancePath);
		if (typeof currentValue !== "string") continue;

		// Try to parse the string as JSON
		const result = tryParseJsonForTypes(currentValue, expectedTypes);
		if (!result.changed) continue;

		// Clone on first modification (copy-on-write)
		if (!changed) {
			nextArgs = cloneJsonValue(nextArgs);
			changed = true;
		}
		nextArgs = setValueAtPointer(nextArgs, instancePath, result.value);
	}

	return { value: changed ? nextArgs : args, changed };
}

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv: any = null;
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
		});
		addFormats(ajv);
	} catch (_e) {
		// AJV initialization failed (likely CSP restriction)
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const originalArgs = toolCall.arguments;

	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return originalArgs;
	}

	// Compile the schema
	const validate = ajv.compile(tool.parameters);

	// Validate the arguments
	if (validate(originalArgs)) {
		return originalArgs;
	}

	const { value: coercedArgs, changed } = coerceArgsFromErrors(originalArgs, validate.errors);
	if (changed && validate(coercedArgs)) {
		return coercedArgs;
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	const receivedArgs = changed
		? {
				original: originalArgs,
				normalized: coercedArgs,
			}
		: originalArgs;

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(receivedArgs, null, 2)}`;

	throw new Error(errorMessage);
}
