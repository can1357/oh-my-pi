/**
 * `omp -p --output-schema <file>`: opt-in JSON Schema enforcement for the final answer of a headless run.
 *
 * Contract: stdout carries exactly one schema-valid JSON value and the process exits 0, or stdout stays empty
 * and the process exits nonzero with a diagnostic on stderr. The schema is read and checked before any model
 * call. Validation is always local and strict: there is no permissive fallback.
 *
 * Supported dialect: the JSON Schema keywords enforced by the in-tree validator (`type`, `enum`, `const`,
 * `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`, object/array/string/number constraints, `prefixItems`,
 * `contains`, `propertyNames`, `patternProperties`, `dependentRequired`/`dependentSchemas`, local `$ref`).
 * `format` is an annotation only (draft 2020-12 default): it is never asserted. Keywords the validator would
 * silently ignore are rejected up front instead: `unevaluatedProperties`, `unevaluatedItems`, `dependencies`,
 * `additionalItems`, `$dynamicRef`, `$recursiveRef`, `contentSchema`, and any `$ref` that is not local (`#...`).
 */
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isValidJsonSchema, type JsonSchemaValidationIssue, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "../cli/usage-error";

/** In-session correction turns allowed after the first answer fails validation (so at most 3 model answers). */
export const OUTPUT_SCHEMA_MAX_CORRECTIONS = 2;

export interface LoadedOutputSchema {
	/** Parsed JSON Schema object, already checked for syntax and supported keywords. */
	schema: Record<string, unknown>;
	/** Path the schema was read from. */
	source: string;
}

const UNSUPPORTED_KEYWORDS: ReadonlyMap<string, string> = new Map([
	["unevaluatedProperties", "needs evaluation tracking that the validator does not implement"],
	["unevaluatedItems", "needs evaluation tracking that the validator does not implement"],
	["dependencies", "legacy keyword the validator ignores; use dependentRequired or dependentSchemas"],
	["additionalItems", "legacy keyword the validator ignores; use prefixItems with items"],
	["$dynamicRef", "dynamic references are not supported"],
	["$dynamicAnchor", "dynamic references are not supported"],
	["$recursiveRef", "recursive references are not supported"],
	["$recursiveAnchor", "recursive references are not supported"],
	["contentSchema", "content schemas are not enforced"],
]);

/** Keys whose value is a map of name to subschema (the names are data, not keywords). */
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keys whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** Keys whose value is one subschema (`items` may also be an array). */
const SCHEMA_KEYS = new Set([
	"items",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"additionalProperties",
	"propertyNames",
]);

function collectUnsupported(node: unknown, pointer: string, problems: string[]): void {
	if (Array.isArray(node)) {
		node.forEach((entry, index) => collectUnsupported(entry, `${pointer}/${index}`, problems));
		return;
	}
	if (!isRecord(node)) return;
	for (const [keyword, why] of UNSUPPORTED_KEYWORDS) {
		if (Object.hasOwn(node, keyword)) problems.push(`${pointer}/${keyword}: unsupported (${why})`);
	}
	if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
		problems.push(`${pointer}/$ref: unsupported (only local "#..." references resolve)`);
	}
	if (typeof node.pattern === "string") {
		try {
			new RegExp(node.pattern);
		} catch (error) {
			problems.push(`${pointer}/pattern: invalid regular expression (${(error as Error).message})`);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
			for (const [name, sub] of Object.entries(value)) collectUnsupported(sub, `${pointer}/${key}/${name}`, problems);
		} else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			value.forEach((sub, index) => collectUnsupported(sub, `${pointer}/${key}/${index}`, problems));
		} else if (SCHEMA_KEYS.has(key)) {
			collectUnsupported(value, `${pointer}/${key}`, problems);
		}
	}
}

/** Check a parsed schema: object form, structurally valid, and inside the supported dialect. Throws {@link CliUsageError}. */
export function assertSupportedOutputSchema(schema: unknown, source: string): Record<string, unknown> {
	if (!isRecord(schema)) {
		throw new CliUsageError(`--output-schema ${source}: the schema must be a JSON object.`);
	}
	if (!isValidJsonSchema(schema)) {
		throw new CliUsageError(`--output-schema ${source}: not a valid JSON Schema.`);
	}
	const problems: string[] = [];
	collectUnsupported(schema, "", problems);
	if (problems.length > 0) {
		throw new CliUsageError(`--output-schema ${source}: unsupported schema.\n${problems.map(p => `  ${p}`).join("\n")}`);
	}
	return schema;
}

/** Read and check the schema file before any model call. Throws {@link CliUsageError}. */
export async function loadOutputSchema(source: string): Promise<LoadedOutputSchema> {
	let raw: string;
	try {
		raw = await fs.readFile(source, "utf8");
	} catch (error) {
		throw new CliUsageError(`--output-schema ${source}: cannot read the schema file (${(error as Error).message}).`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new CliUsageError(`--output-schema ${source}: not valid JSON (${(error as Error).message}).`);
	}
	return { schema: assertSupportedOutputSchema(parsed, source), source };
}

export type StructuredOutcome =
	| { ok: true; json: string }
	| { ok: false; reason: string; /** A correction turn may fix it: the model answered, the answer was wrong. */ retryable: boolean };

function formatIssues(issues: readonly JsonSchemaValidationIssue[]): string {
	return issues
		.slice(0, 10)
		.map(issue => `${issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/"}: ${issue.message}`)
		.join("; ");
}

/**
 * Turn the run's last assistant message into the one JSON result, or a reason it cannot be one.
 * The whole answer text must be a single JSON value: fences and surrounding prose are failures.
 */
export function resolveStructuredOutput(
	message: AssistantMessage | undefined,
	schema: Record<string, unknown>,
): StructuredOutcome {
	if (message === undefined) return { ok: false, reason: "the model produced no response", retryable: false };
	switch (message.stopReason) {
		case "length":
			return { ok: false, reason: "response truncated at the output token limit", retryable: false };
		case "error":
			return { ok: false, reason: message.errorMessage || "provider failure", retryable: false };
		case "aborted":
			return { ok: false, reason: message.errorMessage || "request aborted", retryable: false };
		case "toolUse":
			return { ok: false, reason: "the run ended on a tool call without a final answer", retryable: false };
		case "stop":
			break;
	}
	const text = message.content
		.flatMap(part => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
	if (text.length === 0) return { ok: false, reason: "the final response has no text", retryable: true };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			reason: `the final response is not a single JSON value (${(error as Error).message})`,
			retryable: true,
		};
	}
	const result = validateJsonSchemaValue(schema, value);
	if (!result.success) {
		return { ok: false, reason: `the result does not match the schema: ${formatIssues(result.issues)}`, retryable: true };
	}
	return { ok: true, json: JSON.stringify(value) };
}

/** Appended to every model-bound prompt of an `--output-schema` run. The contract is enforced by validation, not by this text. */
export function outputContractPrompt(schema: Record<string, unknown>): string {
	return [
		"<output-contract>",
		"Your final answer MUST be exactly one JSON value that validates against this JSON Schema.",
		"No prose, no code fences, no commentary before or after it.",
		JSON.stringify(schema, null, 2),
		"</output-contract>",
	].join("\n");
}

/** Correction turn text. Tools are deactivated for these turns, so nothing earlier is replayed. */
export function correctionPrompt(reason: string): string {
	return [
		`Your previous answer was rejected: ${reason}.`,
		"Do not call any tool. Reply with only the corrected JSON value that satisfies the schema.",
	].join(" ");
}
