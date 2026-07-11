/**
 * Tool-call argument validation pipeline.
 *
 * Tools may declare their parameters as either Zod schemas (canonical) or
 * plain JSON Schema (legacy / extensions). This module is the single
 * entrypoint the agent calls before dispatching a tool — it:
 *
 *   1. Builds (or fetches from cache) a `ValidationContext` for the tool —
 *      the Zod schema if available plus the equivalent wire JSON Schema, or
 *      just the JSON Schema for non-Zod tools.
 *   2. Normalizes LLM quirks (null / "null" → omit-or-default substitution)
 *      against the JSON Schema before validation.
 *   3. Validates with the Zod or JSON-Schema validator.
 *   4. On failure, walks the resulting issues and coerces common LLM type
 *      drift (JSON-stringified values, boolean/number/string scalar drift),
 *      drops unrecognized keys, and retries up to `MAX_COERCION_PASSES` times.
 *   5. Throws a formatted error if reconciliation fails; otherwise returns
 *      the parsed arguments with original unknown root fields preserved (so
 *      hallucinated top-level keys still surface to the caller).
 *
 * The goal is to be conservative: every coercion is a structural rewrite that
 * keeps the schema in charge of acceptance — we never invent values, only
 * massage shapes the LLM almost got right.
 */
import { structuredCloneJSON } from "@pk-nerdsaver-ai/pi-utils";
import { type Type, type } from "arktype";
import type { ZodType } from "zod/v4";
import type { $ZodIssue as ZodIssue } from "zod/v4/core";
import * as AIError from "../error";
import type { Tool, ToolCall } from "../types";
import { upgradeJsonSchemaTo202012 } from "./schema/draft";
import {
	isJsonSchemaValueValid,
	type JsonSchemaValidationIssue,
	validateJsonSchemaValue,
} from "./schema/json-schema-validator";
import { stamp } from "./schema/stamps";
import { arkToWireSchema, isArkSchema, isZodSchema, zodToWireSchema } from "./schema/wire";

// ============================================================================
// Type Coercion Utilities
// ============================================================================
//
// LLMs sometimes produce tool arguments where a value has the right meaning but
// the wrong JSON type. For example, an array parameter might arrive as
// `"[1, 2, 3]"`, a boolean as `"yes"` or `1`, or a string field as a structured
// object that should be embedded verbatim.
//
// Rather than rejecting these outright, we attempt automatic coercion:
//   1. Validate against the tool's schema (Zod, derived from TypeBox when the
//      tool was authored with TypeBox).
//   2. For each type error, perform only the schema-directed rewrite that
//      matches the expected type.
//   3. Re-validate the full argument object after each coercion pass.
//
// This is intentionally conservative: each rewrite is small and validation
// remains the source of truth for whether the result is accepted.
// ============================================================================

/** Regex matching valid JSON number literals (integers, decimals, scientific notation) */
const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Regex matching numeric strings (allows leading zeros) */
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Checks if a value matches any of the expected JSON Schema types.
 * Used to verify that a parsed JSON value is actually what the schema wants.
 */
function matchesExpectedType(value: unknown, expectedTypes: string[]): boolean {
	return expectedTypes.some(type => {
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

function tryParseNumberString(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}

	const trimmed = value.trim();
	if (!trimmed || !NUMERIC_STRING_PATTERN.test(trimmed)) {
		return { value, changed: false };
	}

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { value, changed: false };
	}

	if (!matchesExpectedType(parsed, expectedTypes)) {
		return { value, changed: false };
	}

	return { value: parsed, changed: true };
}

function tryCoerceBoolean(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("boolean")) {
		return { value, changed: false };
	}

	if (typeof value === "number") {
		if (value === 0) return { value: false, changed: true };
		if (value === 1) return { value: true, changed: true };
		return { value, changed: false };
	}

	if (typeof value !== "string") {
		return { value, changed: false };
	}

	switch (value.trim().toLowerCase()) {
		case "true":
		case "1":
		case "yes":
		case "on":
			return { value: true, changed: true };
		case "false":
		case "0":
		case "no":
		case "off":
			return { value: false, changed: true };
		default:
			return { value, changed: false };
	}
}

function tryCoerceBooleanToNumber(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}
	if (typeof value !== "boolean") {
		return { value, changed: false };
	}
	return { value: value ? 1 : 0, changed: true };
}

function tryCoerceString(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("string") || typeof value === "string" || value === null || value === undefined) {
		return { value, changed: false };
	}

	if (Array.isArray(value) || typeof value === "object") {
		try {
			const stringified = JSON.stringify(value);
			if (stringified === undefined) return { value, changed: false };
			return { value: stringified, changed: true };
		} catch {
			return { value, changed: false };
		}
	}

	if (typeof value === "function") {
		return { value, changed: false };
	}

	return { value: String(value), changed: true };
}

function tryCoerceForExpectedTypes(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (typeof value === "string") {
		const parsed = tryParseJsonForTypes(value, expectedTypes);
		if (parsed.changed) return parsed;
		return tryCoerceBoolean(value, expectedTypes);
	}

	const booleanCoercion = tryCoerceBoolean(value, expectedTypes);
	if (booleanCoercion.changed) return booleanCoercion;

	const numericCoercion = tryCoerceBooleanToNumber(value, expectedTypes);
	if (numericCoercion.changed) return numericCoercion;

	return tryCoerceString(value, expectedTypes);
}

function tryParseLeadingJsonContainer(value: string): unknown | undefined {
	const firstChar = value[0];
	const closingChar = firstChar === "{" ? "}" : firstChar === "[" ? "]" : undefined;
	if (!closingChar) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === firstChar) {
			depth += 1;
			continue;
		}

		if (char !== closingChar) continue;
		depth -= 1;
		if (depth !== 0) continue;

		const prefix = value.slice(0, index + 1);
		try {
			return JSON.parse(prefix) as unknown;
		} catch {
			// LLMs sometimes emit literal `\n` or `\t` between JSON tokens
			// (e.g. `[{...}\n]`). Convert these to real whitespace and retry.
			const cleaned = cleanLiteralEscapes(prefix);
			if (cleaned !== prefix) {
				try {
					return JSON.parse(cleaned) as unknown;
				} catch {}
			}
			// Try escaping raw control chars that appear inside string literals.
			const escapedControls = escapeRawControlsInJsonStrings(prefix);
			if (escapedControls !== prefix) {
				try {
					return JSON.parse(escapedControls) as unknown;
				} catch {}
			}
			// Also try single-char healing on the extracted prefix.
			return tryHealMalformedJson(prefix);
		}
	}

	return undefined;
}

/**
 * Replace literal `\n`, `\t`, `\r` sequences that appear OUTSIDE of JSON
 * strings with actual whitespace.  LLMs sometimes produce these when they
 * confuse the tool-call encoding with the content encoding.
 */
function cleanLiteralEscapes(value: string): string {
	let result = "";
	let inString = false;
	let i = 0;
	while (i < value.length) {
		const ch = value[i];
		if (inString) {
			if (ch === "\\" && i + 1 < value.length) {
				result += ch + value[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			result += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			i += 1;
			continue;
		}
		// Outside a string: replace literal \n, \t, \r with whitespace
		if (ch === "\\" && i + 1 < value.length) {
			const next = value[i + 1];
			if (next === "n" || next === "t" || next === "r") {
				result += " ";
				i += 2;
				continue;
			}
		}
		result += ch;
		i += 1;
	}
	return result;
}

/**
 * Escape raw control characters (0x00–0x1F) that appear *inside* JSON string
 * literals. LLMs sometimes emit literal newlines/tabs/etc. inside string
 * content instead of `\n` / `\t` escape sequences, which `JSON.parse` rejects
 * even though the surrounding structure is valid.
 *
 * This function only rewrites characters while inside a string; structural
 * whitespace outside of strings is preserved unchanged.
 */
function escapeRawControlsInJsonStrings(value: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	let changed = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (inString) {
			if (escaped) {
				result += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				result += ch;
				inString = false;
				continue;
			}
			const code = ch.charCodeAt(0);
			if (code < 0x20) {
				changed = true;
				switch (ch) {
					case "\n":
						result += "\\n";
						break;
					case "\r":
						result += "\\r";
						break;
					case "\t":
						result += "\\t";
						break;
					case "\b":
						result += "\\b";
						break;
					case "\f":
						result += "\\f";
						break;
					default:
						result += `\\u${code.toString(16).padStart(4, "0")}`;
				}
				continue;
			}
			result += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
		}
		result += ch;
	}
	return changed ? result : value;
}

/** Maximum single-character edits to attempt when healing malformed JSON. */
const MAX_HEAL_DISTANCE = 3;
const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

/**
 * Attempts to heal near-valid JSON by applying single-character edits near the
 * end of the string. LLMs (especially smaller ones) sometimes produce JSON with
 * a single misplaced, extra, or wrong bracket at the end — e.g. `"}]"` becomes
 * `"]}"` or gets an extra `}` appended. This function tries:
 *   1. Removing a single character from the last few positions
 *   2. Replacing a single character in the last few positions with each bracket type
 *
 * Returns the parsed value on success, undefined on failure.
 */
function tryHealMalformedJson(value: string): unknown | undefined {
	// Verify it actually fails to parse
	try {
		return JSON.parse(value) as unknown;
	} catch {}

	// Only attempt edits within the last few characters — the error is always
	// a bracket issue at the tail for the class of LLM mistakes this targets.
	const tailStart = Math.max(0, value.length - (MAX_HEAL_DISTANCE * 2 + 1));

	// Strategy 1: remove a single character from the tail
	for (let i = tailStart; i < value.length; i += 1) {
		const candidate = value.slice(0, i) + value.slice(i + 1);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {}
	}

	// Strategy 2: replace a single character in the tail with each bracket type
	for (let i = tailStart; i < value.length; i += 1) {
		const original = value[i];
		for (const replacement of BRACKET_CHARS) {
			if (replacement === original) continue;
			const candidate = value.slice(0, i) + replacement + value.slice(i + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {}
		}
	}

	return undefined;
}

const MAX_NESTED_JSON_STRING_PARSE_DEPTH = 3;

function acceptParsedJsonForTypes(
	parsed: unknown,
	source: string,
	expectedTypes: string[],
	depth: number,
): { value: unknown; changed: boolean } {
	if (parsed === null && source.trim() === "null") {
		return { value: null, changed: true };
	}
	if (matchesExpectedType(parsed, expectedTypes)) {
		return { value: parsed, changed: true };
	}
	if (typeof parsed === "string" && !expectedTypes.includes("string") && depth < MAX_NESTED_JSON_STRING_PARSE_DEPTH) {
		return tryParseJsonForTypes(parsed, expectedTypes, depth + 1);
	}
	return { value: source, changed: false };
}

function looksLikeJsonContainerString(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trimStart();
	if (trimmed.startsWith("{")) {
		const body = trimmed.slice(1);
		return body.trimStart().startsWith('"') || body.includes(":") || body.trimStart().startsWith("}");
	}
	if (!trimmed.startsWith("[")) return false;
	const firstItem = trimmed.slice(1).trimStart();
	return (
		firstItem.startsWith("{") ||
		firstItem.startsWith("[") ||
		firstItem.startsWith('"') ||
		firstItem.startsWith("]") ||
		firstItem.startsWith("true") ||
		firstItem.startsWith("false") ||
		firstItem.startsWith("null") ||
		/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\s*(?:,|\]|$))/.test(firstItem)
	);
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
function tryParseJsonForTypes(value: string, expectedTypes: string[], depth = 0): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	const numberCoercion = tryParseNumberString(trimmed, expectedTypes);
	if (numberCoercion.changed) {
		return numberCoercion;
	}

	// Quick syntactic checks to avoid unnecessary parse attempts
	const looksJsonObject = trimmed.startsWith("{") && looksLikeJsonContainerString(trimmed);
	const looksJsonArray = trimmed.startsWith("[") && looksLikeJsonContainerString(trimmed);
	const looksJsonString = trimmed.startsWith('"') && !expectedTypes.includes("string");
	const looksJsonLiteral =
		trimmed === "true" || trimmed === "false" || trimmed === "null" || JSON_NUMBER_PATTERN.test(trimmed);

	if (!looksJsonObject && !looksJsonArray && !looksJsonString && !looksJsonLiteral) {
		return { value, changed: false };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const accepted = acceptParsedJsonForTypes(parsed, trimmed, expectedTypes, depth);
		if (accepted.changed) return accepted;
	} catch {
		if (looksJsonObject || looksJsonArray) {
			// Try escaping raw control chars inside string literals (LLMs sometimes
			// emit literal newlines/tabs inside string content rather than `\n`/`\t`).
			const escapedControls = escapeRawControlsInJsonStrings(trimmed);
			if (escapedControls !== trimmed) {
				try {
					const parsed = JSON.parse(escapedControls) as unknown;
					const accepted = acceptParsedJsonForTypes(parsed, escapedControls, expectedTypes, depth);
					if (accepted.changed) return accepted;
				} catch {}
			}
			// Try extracting a valid JSON prefix (handles trailing junk after balanced container)
			const leading = tryParseLeadingJsonContainer(trimmed);
			if (leading !== undefined) {
				const accepted = acceptParsedJsonForTypes(leading, trimmed, expectedTypes, depth);
				if (accepted.changed) return accepted;
			}
			// Try healing single-character bracket errors near the end of the string
			const healed = tryHealMalformedJson(trimmed);
			if (healed !== undefined) {
				const accepted = acceptParsedJsonForTypes(healed, trimmed, expectedTypes, depth);
				if (accepted.changed) return accepted;
			}
		}
		return { value, changed: false };
	}

	return { value, changed: false };
}

// ============================================================================
// JSON Pointer Utilities (RFC 6901)
// ============================================================================
//
// Internally we still address error locations using JSON Pointer syntax
// (e.g., `/foo/0/bar`).  These utilities let coercion read and write values at
// those paths regardless of whether the original error came from Zod or
// from JSON-Schema-shaped normalization.
// ============================================================================

/** Encode a structured Zod issue path as a JSON Pointer. */
function pathToPointer(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "";
	return `/${path.map(seg => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/**
 * Decodes a JSON Pointer string into path segments.
 * Handles RFC 6901 escape sequences: ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
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
 * Returns a new structure with the key at `pointer` removed. Only the
 * containers along the path are shallow-cloned (`O(depth)` allocations);
 * every sibling subtree is shared with the input. Returns the input
 * reference unchanged when the pointer is empty, the path is invalid, or
 * the final key is absent — so callers can detect a no-op via identity.
 */
function deleteValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	if (segments.length === 0) return root;
	return deleteAtSegment(root, segments, 0);
}

function deleteAtSegment(node: unknown, segments: string[], depth: number): unknown {
	const segment = segments[depth];
	const isLeaf = depth === segments.length - 1;

	if (Array.isArray(node)) {
		const index = Number(segment);
		if (!Number.isInteger(index) || index < 0 || index >= node.length) return node;
		if (isLeaf) {
			const next = node.slice();
			next.splice(index, 1);
			return next;
		}
		const child = deleteAtSegment(node[index], segments, depth + 1);
		if (child === node[index]) return node;
		const next = node.slice();
		next[index] = child;
		return next;
	}

	if (typeof node !== "object" || node === null) return node;
	const obj = node as Record<string, unknown>;
	if (!Object.hasOwn(obj, segment)) return node;
	if (isLeaf) {
		const { [segment]: _omit, ...rest } = obj;
		return rest;
	}
	const child = deleteAtSegment(obj[segment], segments, depth + 1);
	if (child === obj[segment]) return node;
	return { ...obj, [segment]: child };
}

// ============================================================================
// JSON-Schema-driven normalization passes (LLM quirks).
// ============================================================================

/**
 * Test a JSON-Schema branch during nullable normalization. Kept deliberately
 * small and synchronous so validation does not need to compile legacy schemas
 * into another schema language.
 */
function branchMatchesSchema(branch: unknown, value: unknown): boolean {
	return isJsonSchemaValueValid(branch, value);
}

function normalizeOptionalNullsForSchema(
	schema: unknown,
	value: unknown,
	isRoot = true,
): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	const normalizeAnyOfLike = (keyword: "anyOf" | "oneOf"): { value: unknown; changed: boolean } => {
		const branches = schemaObject[keyword];
		if (!Array.isArray(branches)) return { value, changed: false };

		let changedCandidate: { value: unknown; changed: true } | null = null;

		for (const branch of branches) {
			const normalized = normalizeOptionalNullsForSchema(branch, value, isRoot);
			if (!normalized.changed) continue;

			if (branchMatchesSchema(branch, normalized.value)) {
				return normalized;
			}

			if (!changedCandidate) {
				changedCandidate = { value: normalized.value, changed: true };
			}
		}

		return changedCandidate ?? { value, changed: false };
	};

	const anyOfNormalization = normalizeAnyOfLike("anyOf");
	if (anyOfNormalization.changed) return anyOfNormalization;

	const oneOfNormalization = normalizeAnyOfLike("oneOf");
	if (oneOfNormalization.changed) return oneOfNormalization;

	if (Array.isArray(schemaObject.allOf)) {
		let changed = false;
		let nextValue: unknown = value;
		for (const branch of schemaObject.allOf) {
			const normalized = normalizeOptionalNullsForSchema(branch, nextValue, isRoot);
			if (!normalized.changed) continue;
			nextValue = normalized.value;
			changed = true;
		}
		if (changed) return { value: nextValue, changed: true };
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (itemSchema === null || typeof itemSchema !== "object" || Array.isArray(itemSchema)) {
			return { value, changed: false };
		}

		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeOptionalNullsForSchema(itemSchema, value[i], false);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = [...value];
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	// Coerce string → number/integer when the schema branch declares those types.
	// This fixes anyOf:[{type:"number"},{type:"null"}] (i.e. Optional<number>) where
	// the validator reports an "anyOf" error rather than a "type" error.
	if ((schemaObject.type === "number" || schemaObject.type === "integer") && typeof value === "string") {
		return tryParseNumberString(value, [schemaObject.type as string]);
	}

	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	if (Array.isArray(value)) return { value, changed: false };
	if (schemaObject.properties === null || typeof schemaObject.properties !== "object") {
		return { value, changed: false };
	}

	const properties = schemaObject.properties as Record<string, unknown>;
	const required = new Set(Array.isArray(schemaObject.required) ? (schemaObject.required as string[]) : []);

	let changed = false;
	let nextValue = value as Record<string, unknown>;

	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in nextValue)) continue;
		const currentValue = nextValue[key];
		const isNullish = currentValue === null || currentValue === "null";
		const isInvalidEmptyString =
			currentValue === "" && !required.has(key) && !branchMatchesSchema(propertySchema, currentValue);

		// Strip null/string "null" from optional fields, and strip empty
		// strings only when the property schema would reject the explicit value.
		// LLMs sometimes output these placeholders to mean "no value".
		if ((isNullish || isInvalidEmptyString) && !required.has(key)) {
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
			continue;
		}

		// Substitute the schema-supplied default when a required field arrives
		// as null/"null". LLMs commonly emit null for "I have nothing to say
		// here"; if the schema documents a default, honor it instead of
		// rejecting the whole call. The default is cloned so mutations on the
		// validated value never bleed back into the schema.
		if (isNullish && propertySchema && typeof propertySchema === "object") {
			const propertyObject = propertySchema as Record<string, unknown>;
			if ("default" in propertyObject) {
				if (!changed) {
					nextValue = { ...nextValue };
					changed = true;
				}
				nextValue[key] = structuredCloneJSON(propertyObject.default);
				continue;
			}
		}
		const normalized = normalizeOptionalNullsForSchema(propertySchema, currentValue, false);
		if (!normalized.changed) continue;

		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}

	// Strip unknown keys with null/"null" values when the schema forbids extras.
	// LLMs sometimes hallucinate verbs alongside valid ones (e.g. `split: null`,
	// `original: null`). Rejecting the entire tool call wastes a turn; treating
	// these the same as null on known optional fields is a safer fallback. Keys
	// with non-null unknown values are left intact so genuine schema mistakes
	// still surface as validation errors.
	//
	// At the ROOT level we deliberately keep unknown null-valued keys intact:
	// Zod-emitted wire schemas always set `additionalProperties: false`, but the
	// post-validation `preserveUnknownRootFields` pass re-attaches root extras
	// so callers can observe (and reject) hallucinated fields. Stripping here
	// would erase the field before that snapshot, hiding the rejection signal.
	if (!isRoot && schemaObject.additionalProperties === false) {
		const knownKeys = new Set(Object.keys(properties));
		for (const key of Object.keys(nextValue)) {
			if (knownKeys.has(key)) continue;
			const v = nextValue[key];
			if (v !== null && v !== "null") continue;
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
		}
	}

	return { value: changed ? nextValue : value, changed };
}

// ============================================================================
// Double-encoded object-key normalization (LLM quirk).
// ============================================================================
//
// LLMs occasionally serialize an object key one time too many, so the property
// NAME arrives as the JSON encoding of the real name — literal quote characters
// and all (e.g. `{ "\"op\"": "done" }` decodes to the JS key `"op"`). The
// schema never matches such a key, so it reads as an unrecognized extra and is
// dropped by the unrecognized-key repair, later surfacing as a spurious
// missing-required error. We walk the whole value (arrays + nested objects)
// and rename any key that is itself the JSON encoding of a plain string back to
// that string.
// ============================================================================

/** Max layers of accidental JSON-encoding to peel off a single object key. */
const MAX_KEY_DECODE_DEPTH = 3;

/**
 * If `key` is the JSON encoding of a plain string (quote-wrapped and
 * `JSON.parse`s to a string), return the decoded string; otherwise null. Peels
 * up to {@link MAX_KEY_DECODE_DEPTH} nested encodings so multiply-encoded keys
 * collapse in one pass. Conservative: any key that is not a quote-wrapped JSON
 * string literal is left untouched.
 */
function decodeDoubleEncodedKey(key: string): string | null {
	let current = key;
	let decoded: string | null = null;
	for (let depth = 0; depth < MAX_KEY_DECODE_DEPTH; depth += 1) {
		if (current.length < 2 || current[0] !== '"' || current[current.length - 1] !== '"') break;
		let parsed: unknown;
		try {
			parsed = JSON.parse(current);
		} catch {
			break;
		}
		if (typeof parsed !== "string") break;
		current = parsed;
		decoded = current;
	}
	return decoded;
}

/**
 * Recursively unwrap object keys that were accidentally JSON-encoded an extra
 * time. Schema-agnostic by design: such keys are dropped before any schema pass
 * can map them, so this runs first. A key is only renamed when the decoded name
 * differs and does not already exist on the same object — renaming would
 * otherwise clobber a sibling and silently lose data.
 */
function normalizeDoubleEncodedKeys(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		let next = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeDoubleEncodedKeys(value[i]);
			if (!normalized.changed) continue;
			if (!changed) {
				next = [...value];
				changed = true;
			}
			next[i] = normalized.value;
		}
		return { value: changed ? next : value, changed };
	}

	if (value === null || typeof value !== "object") return { value, changed: false };

	const source = value as Record<string, unknown>;
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		const normalizedChild = normalizeDoubleEncodedKeys(entry);
		const nextChild = normalizedChild.changed ? normalizedChild.value : entry;

		const decodedKey = decodeDoubleEncodedKey(key);
		// `Object.hasOwn` (not `in`) so a decoded `constructor`/`toString` is not
		// mistaken for a collision via the prototype chain.
		const targetKey =
			decodedKey !== null &&
			decodedKey !== key &&
			!Object.hasOwn(source, decodedKey) &&
			!Object.hasOwn(out, decodedKey)
				? decodedKey
				: key;

		if (targetKey !== key || normalizedChild.changed) changed = true;
		// `defineProperty` so a decoded `__proto__` key becomes an own property
		// instead of mutating the result object's prototype.
		Object.defineProperty(out, targetKey, {
			value: nextChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	return { value: changed ? out : value, changed };
}

// ============================================================================
// String-encoded array coercion for union(string, array) schemas.
// ============================================================================

/**
 * Detects whether a schema node accepts BOTH the `string` and `array` JSON
 * Schema types. Recognizes:
 *   - `{ "type": ["string", "array"] }` (multi-type),
 *   - `{ "anyOf": [...] }` / `{ "oneOf": [...] }` with at least one string
 *     branch and one array branch.
 */
function schemaAcceptsStringAndArray(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("string") && schema.type.includes("array")) {
		return true;
	}

	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		let hasString = false;
		let hasArray = false;
		for (const branch of branches) {
			if (!branch || typeof branch !== "object") continue;
			const branchType = (branch as Record<string, unknown>).type;
			if (branchType === "string" || (Array.isArray(branchType) && branchType.includes("string"))) {
				hasString = true;
			}
			if (branchType === "array" || (Array.isArray(branchType) && branchType.includes("array"))) {
				hasArray = true;
			}
			if (hasString && hasArray) return true;
		}
	}
	return false;
}

function schemaNodeAcceptsArray(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object") return false;
	const schemaObject = schema as Record<string, unknown>;
	const schemaType = schemaObject.type;
	return schemaType === "array" || (Array.isArray(schemaType) && schemaType.includes("array"));
}

function parsedArrayMatchesArrayBranch(schema: Record<string, unknown>, value: unknown[]): boolean {
	if (schemaNodeAcceptsArray(schema)) {
		return isJsonSchemaValueValid(schema, value);
	}

	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		const branchList: unknown[] = branches;
		for (const branch of branchList) {
			if (!schemaNodeAcceptsArray(branch)) continue;
			if (isJsonSchemaValueValid(branch, value)) return true;
		}
	}
	return false;
}

/**
 * Pre-validation normalization: when a schema field accepts BOTH `string` and
 * `array`, providers that double-serialize tool arguments (e.g. Z.AI / GLM)
 * deliver array values as JSON-encoded strings like `'["a","b"]'`. Zod's
 * `union([string, array])` happily accepts that string against the string
 * branch, so the type-error driven coercion in {@link coerceArgsFromIssues}
 * never fires, and downstream tools treat the literal `["a","b"]` as a path
 * (silently producing zero matches or glob parse errors).
 *
 * Walk the schema; when both shapes are accepted AND the incoming value is a
 * JSON-array-shaped string, substitute the parsed array only if it validates
 * against the schema's array branch. Conservative: array-shaped strings like
 * `"[1]"` stay on the string branch when the array branch is `string[]`.
 *
 * See https://github.com/can1357/oh-my-pi/issues/1788.
 */
function normalizeStringEncodedArrayUnions(schema: unknown, value: unknown): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	// Leaf case: this schema node accepts both string and array.
	if (typeof value === "string" && schemaAcceptsStringAndArray(schemaObject)) {
		const trimmed = value.trim();
		if (!trimmed.startsWith("[")) return { value, changed: false };
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				// Unwrap any double-encoded object keys inside the parsed array
				// before the branch-match check; otherwise an `array<object>`
				// branch fails to validate and the value silently stays on the
				// string branch.
				const candidate = normalizeDoubleEncodedKeys(parsed).value as unknown[];
				if (parsedArrayMatchesArrayBranch(schemaObject, candidate)) {
					return { value: candidate, changed: true };
				}
			}
		} catch {
			// Not valid JSON — leave the string alone for the validator to handle.
		}
		return { value, changed: false };
	}

	// Recurse into array items.
	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (!itemSchema || typeof itemSchema !== "object" || Array.isArray(itemSchema)) {
			return { value, changed: false };
		}
		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeStringEncodedArrayUnions(itemSchema, value[i]);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = [...value];
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	// Recurse into object properties.
	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	const properties = schemaObject.properties;
	if (!properties || typeof properties !== "object") return { value, changed: false };

	const propsObject = properties as Record<string, unknown>;
	const valueObject = value as Record<string, unknown>;
	let changed = false;
	let nextValue = valueObject;
	for (const [key, propertySchema] of Object.entries(propsObject)) {
		if (!(key in nextValue)) continue;
		const normalized = normalizeStringEncodedArrayUnions(propertySchema, nextValue[key]);
		if (!normalized.changed) continue;
		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}
	return { value: changed ? nextValue : valueObject, changed };
}

// ============================================================================
// Zod issue → coercion bridge
// ============================================================================

interface FlatIssue {
	keyword: "type" | "unrecognized" | "other";
	instancePath: string;
	expectedTypes: string[];
	unionBranch: boolean;
}

/**
 * Translate the Zod expected-type marker into the JSON-Schema type name our
 * coercion helpers already understand.
 */
function mapZodExpectedToJsonSchemaType(expected: unknown): string | null {
	if (typeof expected !== "string") return null;
	switch (expected) {
		case "string":
		case "number":
		case "boolean":
		case "array":
		case "object":
		case "null":
			return expected;
		case "record":
			return "object";
		case "int":
		case "bigint":
			return "integer";
		case "nan":
			return "number";
		default:
			return null;
	}
}

/**
 * Flatten Zod issues into a list of (path, expected-types) records suitable
 * for the coercion pass. Recurses through `invalid_union` so each inner
 * candidate produces independent coercion attempts.
 */
function flattenIssues(issues: ReadonlyArray<ZodIssue>): FlatIssue[] {
	const out: FlatIssue[] = [];
	const walk = (issue: ZodIssue, prefix: ReadonlyArray<PropertyKey>, unionBranch: boolean): void => {
		const fullPath = prefix.length === 0 ? issue.path : [...prefix, ...issue.path];
		if (issue.code === "invalid_type") {
			const mapped = mapZodExpectedToJsonSchemaType((issue as { expected?: unknown }).expected);
			if (mapped) {
				out.push({ keyword: "type", instancePath: pathToPointer(fullPath), expectedTypes: [mapped], unionBranch });
				return;
			}
		}
		if (issue.code === "unrecognized_keys") {
			const keys = (issue as { keys?: ReadonlyArray<string> }).keys ?? [];
			for (const key of keys) {
				out.push({
					keyword: "unrecognized",
					instancePath: pathToPointer([...fullPath, key]),
					expectedTypes: [],
					unionBranch,
				});
			}
			return;
		}
		if (issue.code === "invalid_union") {
			const inner = (issue as unknown as { errors?: ReadonlyArray<ReadonlyArray<ZodIssue>> }).errors;
			if (inner) {
				// A union-branch issue only competes with a sibling branch when it
				// sits at the union node's own path. Issues whose own path is
				// non-empty live on a deeper field that an already-identified
				// branch owns, so the singleton-array repair should still apply.
				for (const branch of inner) {
					for (const child of branch) {
						walk(child, fullPath, child.path.length === 0);
					}
				}
			}
			return;
		}
		out.push({ keyword: "other", instancePath: pathToPointer(fullPath), expectedTypes: [], unionBranch });
	};
	for (const issue of issues) walk(issue, [], false);
	return out;
}

/**
 * Repair issues raised by the validator before we surface them to the caller.
 *
 * Two kinds of repair are applied:
 *  - **type**: when a value has a common LLM-produced shape mismatch, rewrite
 *    it only in the direction requested by the schema: parse JSON strings,
 *    accept boolean spellings, stringify non-null values for string fields,
 *    map booleans to numeric 0/1, and wrap singleton array values for non-union
 *    array expectations.
 *  - **unrecognized**: when a strict object received an extra key (Zod's
 *    `unrecognized_keys` or JSON Schema's `additionalProperties: false`),
 *    drop that key so re-validation succeeds. This effectively coerces every
 *    object schema to loose semantics recursively without rebuilding the
 *    underlying Zod tree.
 *
 * The function is safe and conservative:
 *   - Only processes "type" and "unrecognized" issues
 *   - Only attempts schema-directed coercions for the expected type
 *   - Only wraps singleton array values for non-union type expectations
 *   - Clones the args object before mutation (copy-on-write)
 */
function coerceArgsFromIssues(args: unknown, issues: FlatIssue[]): { value: unknown; changed: boolean } {
	if (issues.length === 0) return { value: args, changed: false };

	let changed = false;
	// Tracks whether `nextArgs` is a fully owned deep copy (safe to mutate
	// leaves). The unrecognized-key path uses path-shallow immutable updates
	// and does NOT require ownership, so we only pay for the deep clone when
	// a type coercion actually needs to write into a leaf.
	let owned = false;
	let nextArgs: unknown = args;

	for (const issue of issues) {
		if (issue.keyword === "unrecognized") {
			const previous = nextArgs;
			nextArgs = deleteValueAtPointer(nextArgs, issue.instancePath);
			if (nextArgs !== previous) changed = true;
			continue;
		}
		if (issue.keyword !== "type") continue;
		if (issue.expectedTypes.length === 0) continue;

		const currentValue = getValueAtPointer(nextArgs, issue.instancePath);
		const result = tryCoerceForExpectedTypes(currentValue, issue.expectedTypes);
		let coercedValue = result.changed ? result.value : undefined;
		if (
			coercedValue === undefined &&
			issue.expectedTypes.includes("array") &&
			!issue.unionBranch &&
			currentValue !== undefined &&
			!Array.isArray(currentValue)
		) {
			const objectCoercion =
				typeof currentValue === "string"
					? tryParseJsonForTypes(currentValue, ["object"])
					: { value: currentValue, changed: false };
			if (objectCoercion.changed || !looksLikeJsonContainerString(currentValue)) {
				coercedValue = [objectCoercion.changed ? objectCoercion.value : currentValue];
			}
		}
		if (coercedValue === undefined) continue;

		if (!owned) {
			nextArgs = structuredCloneJSON(nextArgs);
			owned = true;
			changed = true;
		}
		nextArgs = setValueAtPointer(nextArgs, issue.instancePath, coercedValue);
	}

	return { value: changed ? nextArgs : args, changed };
}

// ============================================================================
// Public API
// ============================================================================

type ValidationContext =
	| {
			kind: "zod";
			zod: ZodType;
			json: Record<string, unknown>;
	  }
	| {
			kind: "arktype";
			ark: Type;
			json: Record<string, unknown>;
	  }
	| {
			kind: "json";
			json: Record<string, unknown>;
	  };

/**
 * Cache the validation context derived from a tool's parameters schema.
 * Keyed by the parameters object identity (stable across tool registrations),
 * via {@link stamp} so callable ArkType schemas — and any frozen host — degrade
 * to recompute-on-call instead of throwing on assignment.
 */
const kValidationContext = Symbol("ai.validationContext");
function getValidationContext(tool: Tool): ValidationContext {
	return stamp(tool.parameters as object, kValidationContext, params =>
		isArkSchema(params)
			? { kind: "arktype", ark: params, json: arkToWireSchema(params) }
			: isZodSchema(params)
				? { kind: "zod", zod: params, json: zodToWireSchema(params) }
				: { kind: "json", json: upgradeJsonSchemaTo202012(params) as Record<string, unknown> },
	);
}

type ContextValidationResult =
	| { success: true; value: unknown }
	| { success: false; flatIssues: FlatIssue[]; messages: string[] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preserveUnknownRootFields(input: unknown, parsed: unknown): unknown {
	if (!isPlainRecord(input) || !isPlainRecord(parsed)) return parsed;
	return { ...input, ...parsed };
}

function flattenJsonSchemaIssues(issues: ReadonlyArray<JsonSchemaValidationIssue>): FlatIssue[] {
	return issues.map(issue => {
		const unionBranch = issue.fromUnionBranch === true;
		if (issue.keyword === "additionalProperties") {
			return {
				keyword: "unrecognized",
				instancePath: pathToPointer(issue.path),
				expectedTypes: [],
				unionBranch,
			};
		}
		return {
			keyword: issue.keyword === "type" ? "type" : "other",
			instancePath: pathToPointer(issue.path),
			expectedTypes: issue.expectedTypes ?? [],
			unionBranch,
		};
	});
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "root" : path.map(seg => String(seg)).join("/");
}

function validateContext(ctx: ValidationContext, value: unknown): ContextValidationResult {
	if (ctx.kind === "zod") {
		const result = ctx.zod.safeParse(value);
		if (result.success) {
			return { success: true, value: preserveUnknownRootFields(value, result.data) };
		}
		return {
			success: false,
			flatIssues: flattenIssues(result.error.issues),
			messages: result.error.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
		};
	}

	if (ctx.kind === "arktype") {
		const out = ctx.ark(value);
		if (!(out instanceof type.errors)) {
			return { success: true, value: preserveUnknownRootFields(value, out) };
		}
		// A `.narrow()`/cross-field failure can have ArkType reject while the wire
		// JSON (its predicate dropped by the toJsonSchema fallback) accepts — then
		// there are no json issues to coerce and we fall through to the formatted
		// error built from ArkType's own messages.
		const jr = validateJsonSchemaValue(ctx.json, value);
		const flatIssues = jr.success ? [] : flattenJsonSchemaIssues(jr.issues);
		return {
			success: false,
			flatIssues,
			messages: out.map(e => `  - ${formatIssuePath(e.path)}: ${e.message}`),
		};
	}

	const result = validateJsonSchemaValue(ctx.json, value);
	if (result.success) return { success: true, value };
	return {
		success: false,
		flatIssues: flattenJsonSchemaIssues(result.issues),
		messages: result.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
	};
}

const MAX_COERCION_PASSES = 5;

/**
 * Finds a tool by name and validates the tool call arguments against its schema.
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): ToolCall["arguments"] {
	const tool = tools.find(t => t.name === toolCall.name);
	if (!tool) {
		throw new AIError.ToolNotFoundError(toolCall.name);
	}
	return validateToolArguments(tool, toolCall);
}

/** Cap per-field string lengths when embedding received args in an error message. */
const MAX_ERROR_ARG_STRING_LENGTH = 256;

function truncateArgsForError(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_ERROR_ARG_STRING_LENGTH) return value;
		return `${value.slice(0, MAX_ERROR_ARG_STRING_LENGTH)}… [truncated ${value.length - MAX_ERROR_ARG_STRING_LENGTH} chars]`;
	}
	if (Array.isArray(value)) return value.map(truncateArgsForError);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = truncateArgsForError(entry);
		return out;
	}
	return value;
}

/**
 * Validates tool call arguments against the tool's schema (Zod or plain JSON
 * Schema). Applies LLM-quirk coercions (numeric strings, JSON-string
 * containers, null/invalid-empty-string-for-optional, null-for-default) before
 * declaring failure.
 *
 * @throws Error with a formatted message when validation cannot be reconciled.
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): ToolCall["arguments"] {
	const originalArgs = toolCall.arguments;
	if (originalArgs && typeof originalArgs === "object" && "__parseError" in originalArgs) {
		const parseError = originalArgs.__parseError;
		const rawJson = String(originalArgs.__rawJson ?? "");
		const maxLen = 512;
		const truncatedRawJson =
			rawJson.length <= maxLen
				? rawJson
				: `${rawJson.slice(0, maxLen)}… [truncated ${rawJson.length - maxLen} chars]`;
		throw new AIError.ValidationError(
			`Validation failed for tool "${toolCall.name}": Tool call arguments are not valid JSON.\nParse Error: ${parseError}\nRaw JSON:\n${truncatedRawJson}`,
		);
	}
	const ctx = getValidationContext(tool);
	const { json } = ctx;

	// Always normalize first — strip null/string "null" from optional fields,
	// strip optional empty strings only when their property schema rejects the
	// explicit value, and substitute defaults. Handles LLM outputting
	// placeholders for "no value" even when validation would otherwise pass.
	let normalizedArgs: unknown = originalArgs;
	let changed = false;

	// Unwrap accidentally double-JSON-encoded object keys before any schema
	// pass. LLMs sometimes emit `{ "\"op\"": "done" }`, so the property name
	// arrives quote-wrapped; left alone it reads as an unrecognized key, gets
	// dropped by the coercion repair, and re-surfaces as a missing-required
	// error. Running first means every later pass sees the corrected names.
	const keyNormalization = normalizeDoubleEncodedKeys(normalizedArgs);
	if (keyNormalization.changed) {
		normalizedArgs = keyNormalization.value;
		changed = true;
	}

	const initialNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
	if (initialNormalization.changed) {
		normalizedArgs = initialNormalization.value;
		changed = true;
	}

	// Then re-shape JSON-stringified arrays whose schema accepts both string
	// and array (e.g. `paths: string | string[]`). Without this, zod accepts
	// the literal `'["a","b"]'` as a string and downstream tools treat it as
	// a single path with embedded glob brackets — silent zero results.
	const stringEncodedArrayNorm = normalizeStringEncodedArrayUnions(json, normalizedArgs);
	if (stringEncodedArrayNorm.changed) {
		normalizedArgs = stringEncodedArrayNorm.value;
		changed = true;
	}

	let result = validateContext(ctx, normalizedArgs);
	if (result.success) return result.value as ToolCall["arguments"];

	for (let pass = 0; pass < MAX_COERCION_PASSES; pass += 1) {
		const coercion = coerceArgsFromIssues(normalizedArgs, result.flatIssues);
		if (!coercion.changed) break;

		normalizedArgs = coercion.value;
		changed = true;

		// `coerceArgsFromIssues` may have just parsed a JSON-string container at
		// the root or a nested field, exposing double-encoded keys the initial
		// pass could not reach. Re-unwrap before the unrecognized-key repair on
		// the next validation pass would delete them.
		const keyNormalizationPass = normalizeDoubleEncodedKeys(normalizedArgs);
		if (keyNormalizationPass.changed) {
			normalizedArgs = keyNormalizationPass.value;
		}

		const nullNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
		if (nullNormalization.changed) {
			normalizedArgs = nullNormalization.value;
		}

		// Re-run the union-string coercion because `coerceArgsFromIssues` may
		// have just unwrapped a JSON-stringified object at the root or inside a
		// nested field — exposing `string | string[]` descendants the initial
		// pre-validation pass could not reach.
		const stringEncodedArrayNormPass = normalizeStringEncodedArrayUnions(json, normalizedArgs);
		if (stringEncodedArrayNormPass.changed) {
			normalizedArgs = stringEncodedArrayNormPass.value;
		}

		result = validateContext(ctx, normalizedArgs);
		if (result.success) return result.value as ToolCall["arguments"];
	}

	// Format validation errors nicely. The header phrase is asserted by
	// existing tests; the detailed body is informational.
	const errors = result.messages.join("\n") || "Unknown validation error";

	// Truncate long per-field strings: the full payload (potentially hundreds
	// of KB for write/edit-class calls) would otherwise round-trip back to the
	// model inside the tool error.
	const receivedArgs = changed
		? {
				original: truncateArgsForError(originalArgs),
				normalized: truncateArgsForError(normalizedArgs),
			}
		: truncateArgsForError(originalArgs);

	const errorMessage = `Validation failed for tool "${
		toolCall.name
	}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(receivedArgs, null, 2)}`;

	throw new AIError.ValidationError(errorMessage);
}
