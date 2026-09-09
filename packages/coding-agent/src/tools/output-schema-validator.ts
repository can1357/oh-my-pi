/**
 * Shared output-schema validation for subagent yield + executor finalization.
 *
 * Both the in-process `yield` tool (subagent side) and the executor's post-mortem
 * finalize path (parent side) need to validate yield payloads against the agent's
 * declared output schema. This module is the single source of truth for that
 * pipeline — keeping the two callsites in lockstep so a schema accepted in-tool
 * cannot be rejected post-mortem (or vice versa).
 */
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationIssue,
	type JsonSchemaValidationResult,
	validateJsonSchemaValue,
} from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

/** A validator bound to a specific output schema. */
export interface OutputValidator {
	/** Run JSON Schema validation; returns the raw `success`/`issues` shape so callers may inspect every failure. */
	validate(value: unknown): JsonSchemaValidationResult;
	/** Top-level required property names. Empty if the schema has no `required` array at root. */
	readonly requiredFields: readonly string[];
	/**
	 * Per-label validators for incremental yields (`type: ["<label>"]`). Each entry validates the
	 * `data` payload of a single section against the matching top-level property's sub-schema —
	 * array-typed properties (e.g. `findings`) use the items schema since each yield contributes
	 * one element, while scalar properties use the property schema directly.
	 */
	readonly validateSection: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult>;
	/** Whether top-level schema closure makes unknown incremental yield labels invalid. */
	readonly rejectUnknownSections: boolean;
	/** Finite top-level section labels declared directly by the schema. Pattern-backed labels are accepted via `isKnownSection`. */
	readonly knownSectionLabels: readonly string[];
	/** Whether an incremental yield label is accepted by the top-level schema declaration. */
	isKnownSection(label: string): boolean;
}

export interface BuildOutputValidatorResult {
	/** Present when the schema produced a usable validator (i.e. constraining schemas). Absent for missing/unconstrained schemas. */
	validator?: OutputValidator;
	/** Raw JSON Schema produced by `jtdToJsonSchema`. Available alongside the validator so callers can derive related artifacts (strict-mode probe, dereference, hint text). */
	jsonSchema?: Record<string, unknown>;
	/**
	 * Normalized schema (post-`normalizeSchema`). Surfaced so callers can distinguish
	 * "no schema provided" (`undefined`) from "intentionally unconstrained" (`true`)
	 * when both produce no validator.
	 */
	normalized?: unknown;
	/** Set when the schema cannot be used. Callers should treat this as a "no validation" case (loose acceptance) and surface the message in diagnostics. */
	error?: string;
}

/**
 * Build the canonical validator for a JTD-or-JSON-Schema output declaration.
 *
 * Returns:
 * - `{ validator, jsonSchema, normalized }` for constraining schemas — both callers use this path.
 * - `{ normalized: true }` for an intentionally unconstrained schema (the JSON Schema literal `true`).
 *   No validator, but distinguishable from "no schema provided".
 * - `{}` for an absent schema (`undefined`).
 * - `{ error, normalized? }` when the schema cannot be honored (invalid syntax, `false`, malformed JTD).
 */
export function buildOutputValidator(schema: unknown): BuildOutputValidatorResult {
	const { normalized, error: normalizeError } = normalizeSchema(schema);
	if (normalizeError) return { error: normalizeError, normalized };
	if (normalized === undefined) return {};
	if (normalized === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (normalized === true) return { normalized };

	const jsonSchema = jtdToJsonSchema(normalized);
	if (jsonSchema === undefined) return { normalized };
	if (jsonSchema === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (jsonSchema === true) return { normalized };
	if (typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
		return { error: "invalid JSON schema", normalized };
	}
	if (!isValidJsonSchema(jsonSchema)) return { error: "invalid JSON schema", normalized };

	const jsonSchemaRecord = jsonSchema as Record<string, unknown>;
	// Resolve a root `$ref` (e.g. caller schemas exported as `{ $ref: "#/$defs/Closed", $defs: ... }`)
	// before deriving incremental-label metadata. AJV-style validation chases the ref at runtime, so
	// `validate()` accepts the resolved object — but `properties` and `additionalProperties` live on
	// the inlined node, not the wrapper. Without this, unknown labels slipped past the yield gate and
	// only fired as parent-side schema_violations.
	const dereferenced = dereferenceJsonSchema(jsonSchemaRecord);
	const labelSchema =
		dereferenced && typeof dereferenced === "object" && !Array.isArray(dereferenced)
			? (dereferenced as Record<string, unknown>)
			: jsonSchemaRecord;
	const required = extractRequiredFields(labelSchema);
	const sectionLabels = buildSectionLabelMetadata(labelSchema);
	return {
		normalized,
		jsonSchema: jsonSchemaRecord,
		validator: {
			requiredFields: required,
			validate: value => validateJsonSchemaValue(jsonSchemaRecord, value),
			validateSection: buildSectionValidators(labelSchema),
			rejectUnknownSections: sectionLabels.rejectUnknownSections,
			knownSectionLabels: sectionLabels.labels,
			isKnownSection: sectionLabels.isKnown,
		},
	};
}

/**
 * Build per-top-level-property validators for incremental yields.
 *
 * Each entry validates the `data` payload of one `type: ["<label>"]` section against the
 * matching property's sub-schema — array-typed properties (e.g. `findings`, derived from JTD
 * `elements`) use the items schema since each yield contributes one element, while scalar
 * properties use the property schema directly. Closed top-level schemas reject labels that are
 * not declared as properties.
 */
function buildSectionValidators(
	jsonSchema: Record<string, unknown>,
): ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult> {
	const validators = new Map<string, (value: unknown) => JsonSchemaValidationResult>();
	const properties = jsonSchema.properties;
	if (!isRecord(properties)) return validators;
	for (const label in properties) {
		const raw = properties[label];
		const propRecord = isRecord(raw) ? raw : undefined;
		const sectionSchema =
			propRecord?.type === "array" && propRecord.items !== undefined && propRecord.items !== null
				? propRecord.items
				: raw;
		validators.set(label, value => validateJsonSchemaValue(sectionSchema, value));
	}
	return validators;
}

interface SectionLabelMetadata {
	readonly labels: readonly string[];
	readonly rejectUnknownSections: boolean;
	isKnown(label: string): boolean;
}

/**
 * Derive incremental-label metadata from top-level schema closure.
 *
 * The unknown-label gate (`rejectUnknownSections`) engages when the schema constrains top-level
 * property names anywhere: a closed conjunct (root or recursive `allOf` child with
 * `additionalProperties: false`) or a `oneOf`/`anyOf` union whose EVERY variant is closed. A label
 * is known iff every closed conjunct accepts it AND, per closed union, at least one variant
 * accepts it (union semantics are disjunctive — the assembled output only has to match one
 * variant). Unions containing any open variant never gate: the open variant accepts arbitrary
 * labels, so rejection would be a false positive.
 */
function buildSectionLabelMetadata(jsonSchema: Record<string, unknown>): SectionLabelMetadata {
	const closedConjuncts = collectClosedTopLevelSchemas(jsonSchema);
	const closedUnions = collectClosedTopLevelUnions(jsonSchema);
	const closed = closedConjuncts.length > 0 || closedUnions.length > 0;
	const acceptedByAll = (conjuncts: readonly Record<string, unknown>[], label: string): boolean =>
		conjuncts.every(schema => schemaAcceptsSectionLabel(schema, label));
	const labels = [
		...new Set([
			...closedConjuncts.flatMap(schema => declaredPropertyLabels(schema)),
			...closedUnions.flatMap(variants =>
				variants.flatMap(conjuncts => conjuncts.flatMap(schema => declaredPropertyLabels(schema))),
			),
		]),
	];
	return {
		labels,
		rejectUnknownSections: closed,
		isKnown: label =>
			!closed ||
			(acceptedByAll(closedConjuncts, label) &&
				closedUnions.every(variants => variants.some(conjuncts => acceptedByAll(conjuncts, label)))),
	};
}

function collectClosedTopLevelSchemas(jsonSchema: Record<string, unknown>): Record<string, unknown>[] {
	const schemas: Record<string, unknown>[] = [];
	if (jsonSchema.additionalProperties === false) schemas.push(jsonSchema);
	const allOf = jsonSchema.allOf;
	if (Array.isArray(allOf)) {
		for (const raw of allOf) {
			if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
				schemas.push(...collectClosedTopLevelSchemas(raw as Record<string, unknown>));
			}
		}
	}
	return schemas;
}

/** One fully-closed `oneOf`/`anyOf` union: per variant, that variant's closed conjunct schemas. */
type ClosedUnionVariants = Record<string, unknown>[][];

/**
 * Collect top-level `oneOf`/`anyOf` unions in which EVERY variant is closed — i.e. each variant
 * (or one of its `allOf` conjuncts, resolved via `collectClosedTopLevelSchemas`) carries
 * `additionalProperties: false`. JTD discriminator output schemas compile to exactly this shape:
 * a root `oneOf` of closed object variants. Unions with any open (or non-object) variant are
 * skipped entirely so the unknown-label gate cannot fire false rejections. Unions nested under
 * `allOf` conjuncts gate identically (intersection semantics).
 */
function collectClosedTopLevelUnions(jsonSchema: Record<string, unknown>): ClosedUnionVariants[] {
	const unions: ClosedUnionVariants[] = [];
	for (const key of ["oneOf", "anyOf"] as const) {
		const rawVariants = jsonSchema[key];
		if (!Array.isArray(rawVariants) || rawVariants.length === 0) continue;
		const variants: ClosedUnionVariants = [];
		let allClosed = true;
		for (const raw of rawVariants) {
			const conjuncts = isRecord(raw) ? collectClosedTopLevelSchemas(raw) : [];
			if (conjuncts.length === 0) {
				allClosed = false;
				break;
			}
			variants.push(conjuncts);
		}
		if (allClosed) unions.push(variants);
	}
	const allOf = jsonSchema.allOf;
	if (Array.isArray(allOf)) {
		for (const raw of allOf) {
			if (isRecord(raw)) unions.push(...collectClosedTopLevelUnions(raw));
		}
	}
	return unions;
}

function declaredPropertyLabels(jsonSchema: Record<string, unknown>): string[] {
	const properties = jsonSchema.properties;
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return [];
	const labels: string[] = [];
	for (const label in properties) labels.push(label);
	return labels;
}

function schemaAcceptsSectionLabel(jsonSchema: Record<string, unknown>, label: string): boolean {
	const properties = jsonSchema.properties;
	if (properties !== null && typeof properties === "object" && !Array.isArray(properties) && label in properties) {
		return true;
	}
	const patternProperties = jsonSchema.patternProperties;
	if (patternProperties !== null && typeof patternProperties === "object" && !Array.isArray(patternProperties)) {
		for (const pattern in patternProperties) {
			try {
				if (new RegExp(pattern).test(label)) return true;
			} catch {
				// `isValidJsonSchema` already rejected malformed regexes; ignore any unexpected runtime mismatch.
			}
		}
	}
	return jsonSchema.additionalProperties !== false;
}

/** Produce the executor's headline+missing-required summary from a failed validation. */
export function summarizeValidationFailure(
	result: JsonSchemaValidationResult,
	value: unknown,
	requiredFields: readonly string[],
): { message: string; missingRequired: string[] } {
	if (result.success) return { message: "", missingRequired: [] };
	const missing = computeMissingRequired(requiredFields, value);
	const message = formatValidationIssueHeadline(result.issues[0]) ?? "schema validation failed";
	return { message, missingRequired: missing };
}

export function extractRequiredFields(jsonSchema: unknown): string[] {
	if (!jsonSchema || typeof jsonSchema !== "object") return [];
	const required = (jsonSchema as { required?: unknown }).required;
	return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

export function computeMissingRequired(required: readonly string[], value: unknown): string[] {
	if (required.length === 0) return [];
	if (value === null || value === undefined) return [...required];
	if (typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	return required.filter(key => !(key in record) || record[key] === undefined);
}

/**
 * Format a single validation issue as `path.with.dots: message`.
 *
 * Used by the executor's post-mortem `schema_violation` headline — one line, dot-separated path,
 * since the executor's error format already lists missing-required fields separately.
 */
export function formatValidationIssueHeadline(issue: JsonSchemaValidationIssue | undefined): string | undefined {
	if (!issue) return undefined;
	const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
	return `${path}: ${issue.message}`;
}

/**
 * Format every validation issue as `path/with/slashes: message; ...`.
 *
 * Used by the yield tool's model-facing retry feedback — the model gets every problem at once so it
 * can fix the entire output in one retry instead of iterating issue-by-issue. The slash separator
 * mirrors JSON Pointer convention and disambiguates against fields whose names contain dots.
 */
export function formatAllValidationIssues(issues: ReadonlyArray<JsonSchemaValidationIssue> | undefined): string {
	if (!issues || issues.length === 0) return "Unknown schema validation error.";
	return issues
		.map(issue => {
			const path = issue.path.length === 0 ? "" : `${issue.path.map(seg => String(seg)).join("/")}: `;
			return `${path}${issue.message}`;
		})
		.join("; ");
}
