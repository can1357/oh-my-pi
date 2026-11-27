/**
 * Field classification sets for JSON Schema sanitization across providers.
 *
 * Each set serves a different provider need. They overlap intentionally —
 * co-locating them makes the overlap visible and maintainable.
 *
 * All keysets here are static and small (≤ ~40 entries) so they live as
 * `Record<string, true>` literals — `k in REC` resolves through hidden
 * class inline caches without the per-call hashtable cost of `Set.has`.
 */

/**
 * Google Generative AI unsupported schema fields.
 * Stripped during normalizeSchemaForGoogle.
 */
export const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
	$schema: true,
	$id: true,
	$anchor: true,
	$ref: true,
	$defs: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
	examples: true,
	prefixItems: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	additionalProperties: true,
	propertyNames: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	contains: true,
	minContains: true,
	maxContains: true,
	additionalItems: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	pattern: true,
	format: true,
	contentEncoding: true,
	contentMediaType: true,
	contentSchema: true,
	dependencies: true,
	dependentSchemas: true,
	dependentRequired: true,
	// MCP 2026-07-28 transport annotation (mirrors a param into an `Mcp-Param-*`
	// HTTP header on the Streamable HTTP transport); not a JSON Schema keyword.
	// Google 400s on the unknown field name, so strip it from
	// the wire schema. MCP transport/execution reads it from the raw tool schema.
	"x-mcp-header": true,
	// JSON Schema annotation keywords: pure metadata the Google wire
	// schema has no field for. protojson rejects unknown fields outright
	// ("Cannot find field"), so MCP servers annotating parameters with
	// `deprecated` / `readOnly` / `writeOnly` (e.g. Stitch's screen tools)
	// used to 400 the entire request.
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	$comment: true,
};

/**
 * Human-meaningful validation/decorative keywords that can be preserved in a
 * sibling description when a provider-specific normalizer strips them from the
 * wire schema.
 */
export const LIFTABLE_TO_DESCRIPTION_FIELDS: Record<string, true> = {
	pattern: true,
	format: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	minProperties: true,
	maxProperties: true,
	default: true,
	examples: true,
};

/**
 * Non-structural schema keys stripped during OpenAI strict mode sanitization.
 * These are decorative/validation-only keywords that don't affect the structural
 * shape OpenAI's strict mode enforces.
 */
export const NON_STRUCTURAL_SCHEMA_KEYS: Record<string, true> = {
	format: true,
	pattern: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	multipleOf: true,
	$schema: true,
	examples: true,
	default: true,
	title: true,
	$comment: true,
	if: true,
	// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword
	then: true,
	else: true,
	not: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	propertyNames: true,
	contains: true,
	minContains: true,
	maxContains: true,
	dependentRequired: true,
	dependentSchemas: true,
	contentEncoding: true,
	contentMediaType: true,
	contentSchema: true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	minProperties: true,
	maxProperties: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
};

/**
 * Keywords that constrain only one JSON Schema type, per type. Used when a
 * multi-type `type` array is split or scalarized, so each branch keeps only the
 * keywords that apply to its type.
 */
export const TYPE_SPECIFIC_SCHEMA_KEYS: Record<string, Record<string, true>> = {
	array: {
		items: true,
		prefixItems: true,
		contains: true,
		minContains: true,
		maxContains: true,
		minItems: true,
		maxItems: true,
		uniqueItems: true,
		unevaluatedItems: true,
	},
	object: {
		properties: true,
		required: true,
		additionalProperties: true,
		patternProperties: true,
		propertyNames: true,
		minProperties: true,
		maxProperties: true,
		dependentRequired: true,
		dependentSchemas: true,
		unevaluatedProperties: true,
	},
	string: {
		minLength: true,
		maxLength: true,
		pattern: true,
		format: true,
		contentEncoding: true,
		contentMediaType: true,
	},
	number: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
	integer: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
	boolean: {},
	null: {},
};

/**
 * Flat set of every type-specific key across all types.
 * Used to identify sibling keys that need filtering when a node's type narrows.
 */
export const ALL_TYPE_SPECIFIC_SCHEMA_KEYS: Record<string, true> = buildAllTypeSpecificSchemaKeys();

function buildAllTypeSpecificSchemaKeys(): Record<string, true> {
	const all: Record<string, true> = {};
	for (const type in TYPE_SPECIFIC_SCHEMA_KEYS) {
		const typeKeys = TYPE_SPECIFIC_SCHEMA_KEYS[type];
		for (const key in typeKeys) {
			all[key] = true;
		}
	}
	return all;
}

/**
 * Combinator keys used across schema sanitization modules.
 * Defined once to avoid duplication in strict-mode.ts and normalize.ts.
 */
export const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;
