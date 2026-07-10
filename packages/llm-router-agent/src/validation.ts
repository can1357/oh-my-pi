import type {
	JsonSchemaLike,
	TaskSpawnConfig,
	TaskSpawnLabelMappings,
	ValidationIssue,
	ValidationPlan,
	ValidationRequirement,
	ValidationResult,
} from "./types.js";

export type RouteLabel = "light" | "mid" | "heavy";

const ROUTE_LABELS = new Set<RouteLabel>(["light", "mid", "heavy"]);
const CANDIDATE_TIERS = new Set(["light", "mid", "frontier"]);
const MIN_TASK_SPAWN_TIMEOUT_MS = 1;
const MAX_TASK_SPAWN_TIMEOUT_MS = 60_000;

const DEFAULT_UNSAFE_HINTS = [
	"steal credentials",
	"exfiltrate",
	"disable security",
	"bypass authentication",
	"malware",
	"phishing kit",
	"self-harm instructions",
];

/** Normalize classifier output to an exact route label, or undefined if invalid. */
export function normalizeRouteLabel(raw: string): RouteLabel | undefined {
	const normalized = raw.trim().toLowerCase();
	if (ROUTE_LABELS.has(normalized as RouteLabel)) return normalized as RouteLabel;
	return undefined;
}

/**
 * Validate optional task-spawn classifier config.
 * When disabled/missing, only structural label-mapping issues are reported if mappings are present.
 * When enabled, endpoint URL, positive bounded timeout, system prompt, and label mappings are required.
 */
export function validateTaskSpawnConfig(config: TaskSpawnConfig | undefined): string[] {
	if (!config) return [];
	const errors: string[] = [];
	if (config.labelMappings) {
		errors.push(...validateLabelMappings(config.labelMappings));
	}
	if (config.enabled !== true) return errors;

	const endpoint = config.endpoint?.trim() ?? "";
	if (!endpoint) {
		errors.push("taskSpawn.endpoint is required when taskSpawn.enabled is true");
	} else if (!isValidHttpUrl(endpoint)) {
		errors.push("taskSpawn.endpoint must be an absolute http(s) URL");
	}

	const timeoutMs = config.timeoutMs;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		errors.push("taskSpawn.timeoutMs must be a finite number when taskSpawn.enabled is true");
	} else if (timeoutMs < MIN_TASK_SPAWN_TIMEOUT_MS || timeoutMs > MAX_TASK_SPAWN_TIMEOUT_MS) {
		errors.push(`taskSpawn.timeoutMs must be between ${MIN_TASK_SPAWN_TIMEOUT_MS} and ${MAX_TASK_SPAWN_TIMEOUT_MS}`);
	}

	if (!config.systemPrompt?.trim()) {
		errors.push("taskSpawn.systemPrompt is required when taskSpawn.enabled is true");
	}

	if (!config.labelMappings) {
		errors.push("taskSpawn.labelMappings is required when taskSpawn.enabled is true");
	}

	return errors;
}

function validateLabelMappings(mappings: TaskSpawnLabelMappings): string[] {
	const errors: string[] = [];
	for (const label of ["light", "mid", "heavy"] as const) {
		const tier = mappings[label];
		if (tier === undefined) {
			errors.push(`taskSpawn.labelMappings.${label} is required`);
			continue;
		}
		if (!CANDIDATE_TIERS.has(tier)) {
			errors.push(`taskSpawn.labelMappings.${label} must be light|mid|frontier`);
		}
	}
	return errors;
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function validateOutput(output: string, plan: ValidationPlan, unsafeHints: string[] = []): ValidationResult {
	const issues: ValidationIssue[] = [];
	let parsedJson: unknown;
	for (const requirement of plan.requirements) {
		const result = validateRequirement(output, requirement, parsedJson, [...DEFAULT_UNSAFE_HINTS, ...unsafeHints]);
		if (result.parsedJson !== undefined) parsedJson = result.parsedJson;
		issues.push(...result.issues);
	}
	const passed = issues.length === 0;
	return {
		passed,
		issues,
		parsedJson,
		recommendedAction: passed ? "accept" : plan.onFailure,
	};
}

function validateRequirement(
	output: string,
	requirement: ValidationRequirement,
	parsedJson: unknown,
	unsafeHints: string[],
): { issues: ValidationIssue[]; parsedJson?: unknown } {
	switch (requirement.type) {
		case "non_empty":
			return output.trim().length > 0
				? { issues: [] }
				: { issues: [{ type: "non_empty", message: "Output is empty." }] };
		case "json": {
			const parse = parseJson(output);
			if (!parse.ok) return { issues: [{ type: "json", message: parse.error ?? "Invalid JSON." }] };
			const schemaIssues = requirement.schema ? validateJsonSchema(parse.value, requirement.schema) : [];
			return { issues: schemaIssues, parsedJson: parse.value };
		}
		case "required_fields": {
			const value = parsedJson ?? parseJson(output).value;
			if (!isRecord(value))
				return { issues: [{ type: "required_fields", message: "Output is not a JSON object." }] };
			const missing = requirement.fields.filter(field => value[field] === undefined);
			return {
				issues: missing.map(field => ({
					type: "required_fields",
					message: `Missing required field: ${field}`,
					path: field,
				})),
			};
		}
		case "regex": {
			const re = new RegExp(requirement.pattern, requirement.flags);
			return re.test(output)
				? { issues: [] }
				: {
						issues: [
							{
								type: "regex",
								message: `Output did not match /${requirement.pattern}/${requirement.flags ?? ""}.`,
							},
						],
					};
		}
		case "no_unsafe_content": {
			const lower = output.toLowerCase();
			const matched = unsafeHints.filter(hint => hint && lower.includes(hint.toLowerCase()));
			return matched.length === 0
				? { issues: [] }
				: {
						issues: matched.map(hint => ({
							type: "unsafe_hint",
							message: `Output contains unsafe hint: ${hint}`,
						})),
					};
		}
		case "max_length":
			return output.length <= requirement.characters
				? { issues: [] }
				: {
						issues: [
							{
								type: "max_length",
								message: `Output length ${output.length} exceeds ${requirement.characters} characters.`,
							},
						],
					};
		default:
			return {
				issues: [
					{
						type: "unknown_requirement",
						message: `Unknown validation requirement: ${(requirement as { type?: string }).type ?? "unknown"}`,
					},
				],
			};
	}
}

function parseJson(output: string): { ok: true; value: unknown } | { ok: false; error: string; value?: undefined } {
	const trimmed = output.trim();
	const jsonCandidate = trimmed.startsWith("```") ? stripCodeFence(trimmed) : trimmed;
	try {
		return { ok: true, value: JSON.parse(jsonCandidate) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "JSON parse failed" };
	}
}

function stripCodeFence(text: string): string {
	return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function validateJsonSchema(
	value: unknown,
	schema: JsonSchemaLike,
	path = "$",
	issues: ValidationIssue[] = [],
): ValidationIssue[] {
	if (schema.type !== undefined && !matchesType(value, schema.type)) {
		issues.push({ type: "schema_type", message: `Expected ${JSON.stringify(schema.type)} at ${path}.`, path });
		return issues;
	}
	if (schema.enum !== undefined && !schema.enum.some(item => deepEqual(item, value))) {
		issues.push({ type: "schema_enum", message: `Value at ${path} is not in enum.`, path });
	}
	if (schema.required && isRecord(value)) {
		for (const required of schema.required) {
			if (value[required] === undefined)
				issues.push({
					type: "schema_required",
					message: `Missing required field ${required}.`,
					path: `${path}.${required}`,
				});
		}
	}
	if (schema.properties && isRecord(value)) {
		for (const [key, childSchema] of Object.entries(schema.properties)) {
			if (value[key] !== undefined) validateJsonSchema(value[key], childSchema, `${path}.${key}`, issues);
		}
	}
	if (schema.items && Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			validateJsonSchema(item, schema.items as JsonSchemaLike, `${path}[${index}]`, issues);
		}
	}
	return issues;
}

function matchesType(value: unknown, type: string | string[]): boolean {
	const types = Array.isArray(type) ? type : [type];
	return types.some(t => {
		switch (t) {
			case "null":
				return value === null;
			case "array":
				return Array.isArray(value);
			case "object":
				return isRecord(value);
			case "integer":
				return Number.isInteger(value);
			case "number":
				return typeof value === "number";
			case "string":
				return typeof value === "string";
			case "boolean":
				return typeof value === "boolean";
			default:
				return true;
		}
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
