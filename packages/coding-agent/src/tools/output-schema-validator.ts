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
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

/** A validator bound to a specific output schema. */
export interface OutputValidator {
	/** Run JSON Schema validation; returns the raw `success`/`issues` shape so callers may inspect every failure. */
	validate(value: unknown): JsonSchemaValidationResult;
	/** Treat strict-provider nulls for optional non-nullable properties as omitted before validation and delivery. */
	normalize(value: unknown): unknown;
	/** Apply the same normalization to one incremental section item or batch. */
	normalizeSection(label: string, value: unknown): unknown;
	/** Whether the payload is a single section item after strict optional-null normalization. */
	isSectionItem(label: string, value: unknown): boolean;
	/** Whether this payload is an array-branch item or batch, rather than a scalar alternative. */
	isArraySectionValue(label: string, value: unknown): boolean;
	/** Top-level required property names. Empty if the schema has no `required` array at root. */
	readonly requiredFields: readonly string[];
	/**
	 * Per-label validators for incremental yields. Array-typed properties accept
	 * an item or a batch; whole-array constraints apply at finalization.
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
 * Builds keyed by the declaration's content (JSON strings verbatim, objects by
 * their serialization), so a reused schema object that was edited in place
 * gets a fresh validator.
 */
const schemaResults = new LRUCache<string, BuildOutputValidatorResult>({ max: 32 });

/**
 * Build the canonical validator for a JTD-or-JSON-Schema output declaration.
 *
 * Returns:
 * - `{ validator, jsonSchema, normalized }` for constraining schemas — both callers use this path.
 * - `{ normalized: true }` for an intentionally unconstrained schema (the JSON Schema literal `true`).
 *   No validator, but distinguishable from "no schema provided".
 * - `{}` for an absent schema (`undefined`).
 * - `{ error, normalized? }` when the schema cannot be honored (invalid syntax, `false`, malformed JTD).
 *
 * Results are memoized per schema content and shared across calls: the
 * validator holds no per-call state, and callers MUST NOT mutate the returned result.
 */
export function buildOutputValidator(schema: unknown): BuildOutputValidatorResult {
	let key: string | undefined;
	if (typeof schema === "string") key = `s${schema}`;
	else if (schema !== null && typeof schema === "object") {
		try {
			key = `o${JSON.stringify(schema)}`;
		} catch {
			// Unserializable (cyclic) declarations are rejected by the build itself.
		}
	}
	if (key === undefined) return buildOutputValidatorUncached(schema);
	let cached = schemaResults.get(key);
	if (!cached) {
		// Build from a private copy: the cached result must not alias an object the caller may edit later.
		cached = buildOutputValidatorUncached(typeof schema === "string" ? schema : JSON.parse(key.slice(1)));
		schemaResults.set(key, cached);
	}
	return cached;
}

function buildOutputValidatorUncached(schema: unknown): BuildOutputValidatorResult {
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
	const sectionSchemas = buildSectionSchemas(labelSchema);
	const sectionItemSchemas = new Map<string, unknown>();
	const sectionBatchSchemas = new Map<string, unknown>();
	const arraySections = new Set<string>();
	for (const [label, schema] of sectionSchemas) {
		if (yieldSectionShape(schema) !== "array") {
			sectionItemSchemas.set(label, schema);
			continue;
		}
		arraySections.add(label);
		const itemSchema = buildSectionItemSchema(buildArraySectionSchema(schema));
		sectionItemSchemas.set(label, itemSchema);
		sectionBatchSchemas.set(label, { type: "array", items: itemSchema });
	}
	const acceptsSectionItem = (label: string, value: unknown): boolean => {
		const itemSchema = sectionItemSchemas.get(label);
		if (itemSchema === undefined) return false;
		return validateJsonSchemaValue(itemSchema, normalizeStrictOutput(value, itemSchema)).success;
	};
	const acceptsArrayValue = (label: string, value: unknown): boolean => {
		if (!arraySections.has(label)) return false;
		if (acceptsSectionItem(label, value)) return true;
		const batchSchema = sectionBatchSchemas.get(label);
		return (
			Array.isArray(value) && validateJsonSchemaValue(batchSchema, normalizeStrictOutput(value, batchSchema)).success
		);
	};
	const sectionValidators = new Map<string, (value: unknown) => JsonSchemaValidationResult>();
	for (const [label, sectionSchema] of sectionSchemas) {
		sectionValidators.set(label, value => {
			if (!arraySections.has(label)) return validateJsonSchemaValue(sectionSchema, value);
			const itemResult = validateJsonSchemaValue(sectionItemSchemas.get(label), value);
			if (itemResult.success) return itemResult;
			const batchResult = Array.isArray(value)
				? validateJsonSchemaValue(sectionBatchSchemas.get(label), value)
				: undefined;
			if (batchResult?.success) return batchResult;
			const sectionResult = validateJsonSchemaValue(sectionSchema, value);
			if (sectionResult.success) return sectionResult;
			return batchResult ?? itemResult;
		});
	}
	return {
		normalized,
		jsonSchema: jsonSchemaRecord,
		validator: {
			requiredFields: required,
			validate: value => validateJsonSchemaValue(jsonSchemaRecord, value),
			normalize: value => normalizeStrictOutput(value, labelSchema),
			normalizeSection: (label, value) =>
				normalizeStrictOutput(
					value,
					arraySections.has(label) && acceptsSectionItem(label, value)
						? sectionItemSchemas.get(label)
						: acceptsArrayValue(label, value)
							? sectionBatchSchemas.get(label)
							: sectionSchemas.get(label),
				),
			isSectionItem: acceptsSectionItem,
			isArraySectionValue: acceptsArrayValue,
			validateSection: sectionValidators,
			rejectUnknownSections: sectionLabels.rejectUnknownSections,
			knownSectionLabels: sectionLabels.labels,
			isKnownSection: sectionLabels.isKnown,
		},
	};
}

/**
 * Project each declared label's value domain through every composition branch.
 * A branch without a declaration still participates via patterns/additionalProperties;
 * oneOf projects as anyOf because exclusivity concerns the complete object.
 */
export function buildSectionSchemas(jsonSchema: Record<string, unknown>): ReadonlyMap<string, unknown> {
	const labels = new Set<string>();
	const collect = (schema: Record<string, unknown>): void => {
		if (isRecord(schema.properties)) {
			for (const label in schema.properties) labels.add(label);
		}
		for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
			const branches = schema[keyword];
			if (!Array.isArray(branches)) continue;
			for (const branch of branches) if (isRecord(branch)) collect(branch);
		}
	};
	collect(jsonSchema);
	const schemas = new Map<string, unknown>();
	for (const label of labels) schemas.set(label, projectSectionSchema(jsonSchema, label));
	return schemas;
}

function projectSectionSchema(schema: unknown, label: string): unknown {
	if (!isRecord(schema)) return schema;
	if (
		(typeof schema.type === "string" && schema.type !== "object") ||
		(Array.isArray(schema.type) && !schema.type.includes("object"))
	) {
		return false;
	}
	const constraints: unknown[] = [];
	let declared = false;
	if (isRecord(schema.properties) && Object.hasOwn(schema.properties, label)) {
		constraints.push(schema.properties[label]);
		declared = true;
	}
	if (isRecord(schema.patternProperties)) {
		for (const pattern in schema.patternProperties) {
			if (!new RegExp(pattern).test(label)) continue;
			constraints.push(schema.patternProperties[pattern]);
			declared = true;
		}
	}
	if (!declared) constraints.push(schema.additionalProperties ?? true);
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) constraints.push(projectSectionSchema(branch, label));
	}
	for (const keyword of ["oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		const variants = branches.map(branch => projectSectionSchema(branch, label));
		const possible = variants.filter(variant => variant !== false);
		// Retain permissive alternatives: their array/scalar ambiguity also guides assembly.
		constraints.push(possible.length === 0 ? false : possible.length === 1 ? possible[0] : { anyOf: possible });
	}
	if (constraints.includes(false)) return false;
	const constraining = constraints.filter(constraint => constraint !== true);
	if (constraining.length === 0) return true;
	return constraining.length === 1 ? constraining[0] : { allOf: constraining };
}

/** Array-capable labels retain array assembly, with payload metadata selecting scalar alternatives. */
export function yieldSectionShape(schema: unknown): "array" | "scalar" {
	return isArraySectionSchema(schema) && (sectionShapeMask(schema) & 1) !== 0 ? "array" : "scalar";
}

/** Possibility bits: array = 1, non-array = 2; unions combine and conjuncts intersect. */
function sectionShapeMask(schema: unknown): number {
	if (schema === false) return 0;
	if (!isRecord(schema)) return 3;
	let mask = 3;
	if (schema.type === "array") mask = 1;
	else if (schema.type === "null") mask = 0;
	else if (typeof schema.type === "string") mask = 2;
	else if (Array.isArray(schema.type)) {
		mask =
			(schema.type.includes("array") ? 1 : 0) |
			(schema.type.some(type => type !== "array" && type !== "null") ? 2 : 0);
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) mask &= sectionShapeMask(branch);
	}
	for (const keyword of ["oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		let variants = 0;
		for (const branch of branches) variants |= sectionShapeMask(branch);
		mask &= variants;
	}
	return mask;
}

/** Array-declared section schema, shared by validation and consumer shape collection. */
export function isArraySectionSchema(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"))) return true;
	for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (Array.isArray(branches) && branches.some(isArraySectionSchema)) return true;
	}
	return false;
}

/** Keep declared array alternatives without letting an open/scalar branch become an unconstrained item. */
function buildArraySectionSchema(schema: unknown, arrayConstrained = false): unknown {
	if (!isRecord(schema)) return schema;
	arrayConstrained ||= sectionShapeMask(schema) === 1;
	let arrays = schema;
	if (Array.isArray(schema.type) && schema.type.includes("array")) arrays = { ...arrays, type: "array" };
	for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		const applicable =
			keyword === "allOf"
				? branches
				: branches.filter(branch =>
						arrayConstrained ? (sectionShapeMask(branch) & 1) !== 0 : isArraySectionSchema(branch),
					);
		arrays = {
			...arrays,
			[keyword === "oneOf" ? "anyOf" : keyword]: applicable.map(branch =>
				buildArraySectionSchema(branch, arrayConstrained),
			),
		};
		if (keyword === "oneOf") delete arrays.oneOf;
	}
	return arrays;
}

/** Strip only the outer array layer, combining item constraints but deferring whole-array constraints. */
function buildSectionItemSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	const constraints: unknown[] = [];
	if (schema.items !== undefined) constraints.push(schema.items);
	for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		constraints.push({ [keyword === "oneOf" ? "anyOf" : keyword]: branches.map(buildSectionItemSchema) });
	}
	if (constraints.length === 0) return true;
	return constraints.length === 1 ? constraints[0] : { allOf: constraints };
}

/** Required fields remain required across all conjuncts during optional-null normalization. */
function collectConjunctRequiredFields(
	schema: Record<string, unknown>,
	inherited?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
	let fields = inherited;
	let own: Set<string> | undefined;
	if (Array.isArray(schema.required)) {
		for (const field of schema.required) {
			if (typeof field !== "string" || fields?.has(field)) continue;
			own ??= new Set(fields);
			own.add(field);
			fields = own;
		}
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) {
			if (isRecord(branch)) fields = collectConjunctRequiredFields(branch, fields);
		}
	}
	return fields;
}

// Remove provider-injected nulls only when the declared property schema rejects null.
function normalizeStrictOutput(value: unknown, schema: unknown, requiredFields?: ReadonlySet<string>): unknown {
	if (!isRecord(schema)) return value;
	if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
		const [first, second] = schema.anyOf;
		if (isRecord(first) && first.type === "null") {
			return normalizeStrictOutput(value, second, collectConjunctRequiredFields(schema, requiredFields));
		}
		if (isRecord(second) && second.type === "null") {
			return normalizeStrictOutput(value, first, collectConjunctRequiredFields(schema, requiredFields));
		}
	}
	if (Array.isArray(schema.allOf)) {
		if (isRecord(value)) requiredFields = collectConjunctRequiredFields(schema, requiredFields);
		for (const branch of schema.allOf) value = normalizeStrictOutput(value, branch, requiredFields);
	}
	// For unions, accept a candidate only when it satisfies the entire original schema.
	for (const keyword of ["oneOf", "anyOf"]) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (validateJsonSchemaValue(schema, value).success) return value;
		for (const branch of branches) {
			const candidate = normalizeStrictOutput(value, branch, collectConjunctRequiredFields(schema, requiredFields));
			if (candidate !== value && validateJsonSchemaValue(schema, candidate).success) return candidate;
		}
	}
	const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
	if (Array.isArray(value) && (prefixItems !== undefined || schema.items !== undefined)) {
		let normalized: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const itemSchema = prefixItems && index < prefixItems.length ? prefixItems[index] : schema.items;
			const item = normalizeStrictOutput(value[index], itemSchema);
			if (item === value[index]) continue;
			normalized ??= value.slice();
			normalized[index] = item;
		}
		return normalized ?? value;
	}
	if (!isRecord(value) || !isRecord(schema.properties)) return value;
	let normalized: Record<string, unknown> | undefined;
	for (const key in schema.properties) {
		if (!Object.hasOwn(value, key)) continue;
		const propertySchema = schema.properties[key];
		if (
			value[key] === null &&
			!requiredFields?.has(key) &&
			!(Array.isArray(schema.required) && schema.required.includes(key)) &&
			!validateJsonSchemaValue(propertySchema, null).success
		) {
			normalized ??= { ...value };
			delete normalized[key];
			continue;
		}
		const property = normalizeStrictOutput(value[key], propertySchema);
		if (property === value[key]) continue;
		normalized ??= { ...value };
		normalized[key] = property;
	}
	return normalized ?? value;
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
