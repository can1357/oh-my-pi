/**
 * Provider-specific JSON Schema normalization used in the request path.
 *
 * Google's Schema proto, Cloud Code Assist's Claude bridge, and MCP/AJV
 * validation all reject different subsets of standard JSON Schema. This module
 * exposes one option-driven core plus thin dispatchers that pin the option set
 * for each target.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "./equality";
import {
	ALL_CCA_TYPE_SPECIFIC_KEYS,
	CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS,
	CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS,
	COMBINATOR_KEYS,
	LIFTABLE_TO_DESCRIPTION_FIELDS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { type DescriptionSpillFormat, spillToDescription } from "./spill";
import { enter, epochNext, exit, once, stamp } from "./stamps";
import { isJsonObject, isJsonObjectEmpty, type JsonObject } from "./types";

export type ResidualSchemaIncompatibility = "type-array" | "type-null" | "nullable" | "combiners" | "not";

export interface NormalizeSchemaOptions {
	/**
	 * Coerce boolean subschemas to object forms. `standard` preserves `false`
	 * with `not`; `permissive` uses `{}` when the provider cannot express it.
	 */
	coerceBooleanSubschemas?: "standard" | "permissive";
	unsupportedFields: (key: string) => boolean;
	normalizeFieldNames: boolean;
	collapseNullFields: boolean;
	normalizeTypeArrayToNullable: boolean;
	stripNullableKeyword: boolean;
	autoPropertyOrdering: boolean;
	ensureObjectProperties: boolean;
	liftStrippedToDescription:
		| false
		| {
				keys?: (key: string) => boolean;
				format?: DescriptionSpillFormat;
		  };
	mergeObjectCombiners: boolean;
	collapseSameTypeCombiners: boolean;
	collapseMixedTypeCombiners: boolean;
	stripResidualCombinersFixpoint: boolean;
	extractNullableFromUnions: boolean;
	inferTypeForBareEnum: boolean;
	foldOneOfIntoAnyOf: boolean;
	dropNonScalarEnum: boolean;
	stringEnumsOnly?: boolean;
	rejectResidualIncompatibilities?: ReadonlyArray<ResidualSchemaIncompatibility>;
	validateAndFallback?: { fallback: unknown };
}

interface NormalizeSchemaWalkOptions extends NormalizeSchemaOptions {
	insideSchemaMap: boolean;
	/**
	 * True when the value currently being walked occupies a JSON Schema
	 * *subschema* slot (root, combiner branch, `items`, a property value, …).
	 * Only then is a bare `true`/`false` a boolean subschema to coerce; in a
	 * keyword slot (`nullable`, `enum` entries, `additionalProperties`) it stays.
	 */
	booleanIsSubschema: boolean;
}

interface ResidualIncompatibilityChecks {
	typeArray: boolean;
	typeNull: boolean;
	nullable: boolean;
	combiners: boolean;
	not: boolean;
}

const SNAKE_TO_CAMEL_RENAMES = new Map<string, string>([
	["additional_properties", "additionalProperties"],
	["any_of", "anyOf"],
	["prefix_items", "prefixItems"],
	["property_ordering", "propertyOrdering"],
]);

const JSON_SCHEMA_COMBINERS = ["anyOf", "oneOf"] as const;
/** The three JSON Schema composition keywords: `anyOf`, `oneOf`, `allOf`. */
const SCHEMA_COMPOSITION_COMBINERS = ["allOf", "anyOf", "oneOf"] as const;
type SchemaCombiner = (typeof SCHEMA_COMPOSITION_COMBINERS)[number];

/**
 * Keywords whose value is a single subschema (draft 2020-12). A bare `true` /
 * `false` in one of these slots is a boolean subschema to coerce (issue #5604).
 */
const SUBSCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	unevaluatedItems: true,
	not: true,
	if: true,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword
	then: true,
	else: true,
	contains: true,
	propertyNames: true,
	contentSchema: true,
};

/**
 * Keywords whose value is either a boolean keyword value or an object
 * subschema. Object values must be walked, while bare booleans stay literal.
 */
const BOOLEAN_OR_SCHEMA_VALUE_KEYS: Record<string, true> = {
	additionalProperties: true,
	unevaluatedProperties: true,
};

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYS: Record<string, true> = {
	anyOf: true,
	oneOf: true,
	allOf: true,
	prefixItems: true,
};

/** Keywords whose object value maps arbitrary names to subschemas. */
const SUBSCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependencies: true,
	dependentSchemas: true,
	$defs: true,
	definitions: true,
};

type SchemaChildKind = "schema" | "map";

/** Classify only JSON Schema-valued children; instance payloads remain opaque. */
function classifySchemaChild(key: string, value: unknown, insideSchemaMap: boolean): SchemaChildKind | undefined {
	if (insideSchemaMap) return "schema";
	const normalizedKey = SNAKE_TO_CAMEL_RENAMES.get(key) ?? key;
	if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, normalizedKey)) return "map";
	if (Object.hasOwn(SUBSCHEMA_VALUE_KEYS, normalizedKey) || Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, normalizedKey)) {
		return "schema";
	}
	if (Object.hasOwn(BOOLEAN_OR_SCHEMA_VALUE_KEYS, normalizedKey) && isJsonObject(value)) return "schema";
	return undefined;
}

function hasUnrepresentableGoogleEnumConstraint(
	value: unknown,
	insideSchemaMap = false,
	seen = new Set<object>(),
): boolean {
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		return value.some(entry => hasUnrepresentableGoogleEnumConstraint(entry, false, seen));
	}
	if (!isJsonObject(value)) return false;
	if (seen.has(value)) return false;
	seen.add(value);

	if (insideSchemaMap) {
		for (const key in value) {
			if (Object.hasOwn(value, key) && hasUnrepresentableGoogleEnumConstraint(value[key], false, seen)) {
				return true;
			}
		}
		return false;
	}

	if (
		Array.isArray(value.enum) &&
		(value.enum.length === 0 || value.enum.some(enumValue => typeof enumValue !== "string"))
	) {
		return true;
	}
	if (Object.hasOwn(value, "const") && typeof value.const !== "string") return true;

	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const childKind = classifySchemaChild(key, value[key], false);
		if (childKind && hasUnrepresentableGoogleEnumConstraint(value[key], childKind === "map", seen)) {
			return true;
		}
	}
	return false;
}

const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
	type: "object",
	properties: {},
} as const;

function isGoogleUnsupportedSchemaField(key: string): boolean {
	return Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key);
}

function isMcpUnsupportedSchemaField(key: string): boolean {
	return key === "$schema";
}

function isMoonshotUnsupportedSchemaField(key: string): boolean {
	// `default` is an MFJS Meta Data field (kept); everything else here is a
	// validation/decorative keyword or tuple form MFJS rejects.
	if (key === "default") return false;
	return Object.hasOwn(NON_STRUCTURAL_SCHEMA_KEYS, key) || key === "prefixItems";
}

function isDefaultLiftableToDescriptionField(key: string): boolean {
	return Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key);
}

/**
 * Returns `obj` unchanged when no renamable key is present; otherwise returns
 * a fresh shallow-copy with snake_case keys rewritten. The collision rule
 * matches upstream (`pop(from)` → `set(to)`): snake_case wins over an
 * existing camelCase entry, matching python-genai/_transformers.py:751.
 */
function applySnakeCaseRenames(obj: JsonObject): JsonObject {
	let needsRename = false;
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		if (SNAKE_TO_CAMEL_RENAMES.has(k)) {
			needsRename = true;
			break;
		}
	}
	if (!needsRename) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		const renamed = SNAKE_TO_CAMEL_RENAMES.get(k);
		if (renamed !== undefined) {
			out[renamed] = obj[k];
		} else if (!outHasOwn(out, k)) {
			out[k] = obj[k];
		}
	}
	return out;
}

/**
 * `handle_null_fields` (python-genai/_transformers.py:584-640) applied at the
 * parent level BEFORE child recursion — matches upstream's call order at
 * `process_schema` line 768. Returns a new object when changes apply, the
 * original reference otherwise (zero-allocation fast path).
 */
function preHandleNullFields(obj: JsonObject): JsonObject {
	if (obj.type === "null") {
		const out: JsonObject = {};
		for (const k in obj) {
			if (!Object.hasOwn(obj, k) || k === "type") continue;
			out[k] = obj[k];
		}
		out.nullable = true;
		return out;
	}
	if (!Array.isArray(obj.anyOf)) return obj;
	const variants = obj.anyOf as unknown[];
	let sawNull = false;
	const kept: unknown[] = [];
	for (const v of variants) {
		if (isJsonObject(v) && v.type === "null") {
			sawNull = true;
			continue;
		}
		kept.push(v);
	}
	if (!sawNull) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) out[k] = obj[k];
	}
	out.nullable = true;
	if (kept.length === 0) {
		delete out.anyOf;
	} else if (kept.length === 1 && isJsonObject(kept[0])) {
		delete out.anyOf;
		const only = kept[0];
		for (const k in only) {
			if (Object.hasOwn(only, k) && !outHasOwn(out, k)) out[k] = only[k];
		}
	} else {
		out.anyOf = kept;
	}
	return out;
}

function outHasOwn(obj: JsonObject, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return undefined;
	}
}

function pushEnumValue(values: unknown[], value: unknown): void {
	if (!values.some(existing => areJsonValuesEqual(existing, value))) {
		values.push(value);
	}
}

function pushStrippedDescriptionEntry(
	spill: Array<[string, unknown]> | undefined,
	key: string,
	value: unknown,
	options: NormalizeSchemaWalkOptions,
): Array<[string, unknown]> | undefined {
	const lift = options.liftStrippedToDescription;
	if (!lift) return spill;
	const isLiftable = lift.keys ?? isDefaultLiftableToDescriptionField;
	if (!isLiftable(key)) return spill;
	const next = spill ?? [];
	next.push([key, value]);
	return next;
}

function applyDescriptionSpill(
	result: JsonObject,
	spill: Array<[string, unknown]> | undefined,
	options: NormalizeSchemaWalkOptions,
): void {
	const lift = options.liftStrippedToDescription;
	if (!lift || spill === undefined) return;
	spillToDescription(result, spill, lift.format ?? "spill");
}

function normalizeSchemaNode(value: unknown, options: NormalizeSchemaWalkOptions): unknown {
	if (Array.isArray(value)) {
		if (!enter(value)) return [];
		try {
			return value.map(entry => normalizeSchemaNode(entry, options));
		} finally {
			exit(value);
		}
	}
	if (typeof value === "boolean") {
		// A bare boolean is a JSON Schema subschema only in a subschema slot.
		// Some provider wires have no boolean-schema representation: `true`
		// becomes `{}`; `false` uses `not` when supported, or the permissive
		// `{}` fallback when the provider cannot express an impossible schema.
		const mode = options.coerceBooleanSubschemas;
		if (!mode || !options.booleanIsSubschema) return value;
		return value || mode === "permissive" ? {} : { not: {} };
	}
	if (!isJsonObject(value)) {
		return value;
	}
	// `enter`/`exit` path-tracking (not a visited-set): DAG-shared subtrees are
	// normalized at every occurrence; only true cycles short-circuit to `{}`.
	if (!enter(value)) return {};
	try {
		return normalizeSchemaObjectNode(value, options);
	} finally {
		exit(value);
	}
}

function normalizeSchemaObjectNode(value: JsonObject, options: NormalizeSchemaWalkOptions): unknown {
	let obj = options.normalizeFieldNames && !options.insideSchemaMap ? applySnakeCaseRenames(value) : value;
	if (options.collapseNullFields && !options.insideSchemaMap) {
		obj = preHandleNullFields(obj);
	}
	const result: JsonObject = {};
	let spill: Array<[string, unknown]> | undefined;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (!Array.isArray(obj[combiner])) continue;
		const variants = obj[combiner] as JsonObject[];
		const allHaveConst = variants.every(v => isJsonObject(v) && "const" in v);
		if (!allHaveConst || variants.length === 0) continue;

		const dedupedEnum: unknown[] = [];
		for (const variant of variants) {
			pushEnumValue(dedupedEnum, variant.const);
		}
		result.enum = dedupedEnum;

		const explicitTypes = variants
			.map(variant => variant.type)
			.filter((variantType): variantType is string => typeof variantType === "string");
		const allHaveSameExplicitType =
			explicitTypes.length === variants.length &&
			explicitTypes.every(variantType => variantType === explicitTypes[0]);
		if (allHaveSameExplicitType && explicitTypes[0]) {
			result.type = explicitTypes[0];
		} else {
			const inferredTypes = dedupedEnum
				.map(enumValue => inferJsonSchemaTypeFromValue(enumValue))
				.filter((inferredType): inferredType is string => inferredType !== undefined);
			const inferredTypeSet = new Set(inferredTypes);
			if (inferredTypeSet.size === 1) {
				result.type = inferredTypes[0];
			} else {
				const nonNullInferredTypes = inferredTypes.filter(inferredType => inferredType !== "null");
				const nonNullTypeSet = new Set(nonNullInferredTypes);
				if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
					result.type = nonNullInferredTypes[0];
					if (!options.stripNullableKeyword) {
						result.nullable = true;
					}
				}
			}
		}

		for (const key in obj) {
			if (!Object.hasOwn(obj, key) || key === combiner || outHasOwn(result, key)) continue;
			const entry = obj[key];
			if (!options.insideSchemaMap && options.unsupportedFields(key)) {
				spill = pushStrippedDescriptionEntry(spill, key, entry, options);
				continue;
			}
			if (options.stripNullableKeyword && key === "nullable") continue;
			if (
				options.stringEnumsOnly &&
				!options.insideSchemaMap &&
				key === "not" &&
				hasUnrepresentableGoogleEnumConstraint(entry)
			) {
				continue;
			}
			const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
			result[key] = childKind
				? normalizeSchemaNode(entry, {
						...options,
						insideSchemaMap: childKind === "map",
						booleanIsSubschema: childKind === "schema",
					})
				: entry;
		}
		applyDescriptionSpill(result, spill, options);
		return applyNodePostProcessing(result, options);
	}

	let constValue: unknown;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const entry = obj[key];
		if (!options.insideSchemaMap && options.unsupportedFields(key)) {
			spill = pushStrippedDescriptionEntry(spill, key, entry, options);
			continue;
		}
		if (options.stripNullableKeyword && key === "nullable") continue;
		if (key === "const") {
			constValue = entry;
			continue;
		}
		if (
			options.stringEnumsOnly &&
			!options.insideSchemaMap &&
			key === "not" &&
			hasUnrepresentableGoogleEnumConstraint(entry)
		) {
			continue;
		}
		const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
		result[key] = childKind
			? normalizeSchemaNode(entry, {
					...options,
					insideSchemaMap: childKind === "map",
					booleanIsSubschema: childKind === "schema",
				})
			: entry;
	}

	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
	if (constValue !== undefined) {
		const existingEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(existingEnum, constValue);
		result.enum = existingEnum;
		if (!result.type) {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}

	if (
		options.inferTypeForBareEnum &&
		!result.type &&
		!Array.isArray(result.anyOf) &&
		!Array.isArray(result.oneOf) &&
		Array.isArray(result.enum) &&
		result.enum.length > 0
	) {
		const enumTypes = (result.enum as unknown[]).map(inferJsonSchemaTypeFromValue);
		if (enumTypes.every((t): t is string => typeof t === "string") && new Set(enumTypes).size === 1) {
			result.type = enumTypes[0];
		}
	}

	if (options.collapseNullFields && result.type === "null") {
		delete result.type;
		if (!options.stripNullableKeyword) result.nullable = true;
	}

	if (
		options.autoPropertyOrdering &&
		result.type === "object" &&
		!outHasOwn(result, "propertyOrdering") &&
		isJsonObject(result.properties)
	) {
		const props = result.properties;
		const keys: string[] = [];
		for (const k in props) {
			if (Object.hasOwn(props, k)) keys.push(k);
		}
		if (keys.length > 1) result.propertyOrdering = keys;
	}

	if (options.ensureObjectProperties && result.type === "object" && !outHasOwn(result, "properties")) {
		result.properties = {};
	}

	applyDescriptionSpill(result, spill, options);
	return applyNodePostProcessing(result, options);
}

function applyNodePostProcessing(schema: JsonObject, options: NormalizeSchemaWalkOptions): JsonObject {
	let current = schema;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (options.mergeObjectCombiners) current = mergeObjectCombinerVariants(current, combiner);
		if (options.collapseMixedTypeCombiners) current = collapseMixedTypeCombinerVariants(current, combiner);
		if (options.collapseSameTypeCombiners) current = collapseSameTypeCombinerVariants(current, combiner);
	}
	if (options.foldOneOfIntoAnyOf) current = foldOneOfIntoAnyOf(current);
	if (options.dropNonScalarEnum) current = dropNonScalarEnumForMfjs(current);
	if (options.stringEnumsOnly && options.booleanIsSubschema) current = dropNonStringEnumForGoogle(current);
	return current;
}

/** MFJS recognizes only `anyOf`; fold any residual `oneOf` into it (merging when both are present). */
function foldOneOfIntoAnyOf(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.oneOf)) return schema;
	const rest = copySchemaWithout(schema, "oneOf");
	const existing = Array.isArray(rest.anyOf) ? (rest.anyOf as unknown[]) : [];
	rest.anyOf = [...existing, ...(schema.oneOf as unknown[])];
	return rest;
}

/** MFJS `enum` admits only string/number literals; drop an enum carrying other types, keeping the inferred `type`. */
function dropNonScalarEnumForMfjs(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.enum)) return schema;
	const allScalar = (schema.enum as unknown[]).every(v => typeof v === "string" || typeof v === "number");
	if (allScalar) return schema;
	return copySchemaWithout(schema, "enum");
}

/** Google's Schema enum field accepts string values only; omit unsupported enums without dropping the node's type. */
function dropNonStringEnumForGoogle(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.enum)) return schema;
	const isStringEnum = schema.enum.length > 0 && schema.enum.every(value => typeof value === "string");
	return isStringEnum ? schema : copySchemaWithout(schema, "enum");
}

/** Copy all keys from a schema except the specified combiner key. */
export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
	const { [combiner]: _, ...rest } = schema;
	return rest;
}

function mergeObjectCombinerVariants(schema: JsonObject, combiner: SchemaCombiner): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry)) {
			return schema;
		}
		const variantType = entry.type;
		const hasObjectShape =
			isJsonObject(entry.properties) ||
			Array.isArray(entry.required) ||
			Object.hasOwn(entry, "additionalProperties");
		if (variantType === undefined && !hasObjectShape) {
			return schema;
		}
		if (variantType !== undefined && variantType !== "object") {
			return schema;
		}
		if (entry.properties !== undefined && !isJsonObject(entry.properties)) {
			return schema;
		}
		if (entry.required !== undefined && !Array.isArray(entry.required)) {
			return schema;
		}
		variants.push(entry);
	}

	const mergedProperties: JsonObject = {};
	const ownProperties = isJsonObject(schema.properties) ? schema.properties : {};
	for (const name in ownProperties) {
		if (Object.hasOwn(ownProperties, name)) mergedProperties[name] = ownProperties[name];
	}

	for (const variant of variants) {
		const properties = isJsonObject(variant.properties) ? variant.properties : {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const propertySchema = properties[name];
			const existingSchema = mergedProperties[name];
			mergedProperties[name] =
				existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
		}
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	nextSchema.type = "object";
	nextSchema.properties = mergedProperties;

	const branchRequired = variants.map(variant =>
		Array.isArray(variant.required) ? variant.required.filter((r): r is string => typeof r === "string") : [],
	);
	let combinedRequired: string[];
	if (combiner === "allOf") {
		// allOf demands every branch, so the canonical `required` is the union of
		// branch requirements — carrying that union does not narrow acceptance.
		const union = new Set<string>();
		for (const required of branchRequired) {
			for (const name of required) union.add(name);
		}
		combinedRequired = [...union];
	} else {
		// anyOf/oneOf accept any single branch, so only fields every branch
		// requires stay required in the widened projection.
		let intersection: string[] | undefined;
		for (const required of branchRequired) {
			if (intersection === undefined) {
				intersection = [...required];
			} else {
				const reqSet = new Set(required);
				intersection = intersection.filter(r => reqSet.has(r));
			}
		}
		combinedRequired = intersection ?? [];
	}
	const parentRequired = Array.isArray(schema.required)
		? schema.required.filter((r): r is string => typeof r === "string")
		: [];
	const safeRequired = new Set<string>();
	for (const name of combinedRequired) {
		if (Object.hasOwn(mergedProperties, name)) safeRequired.add(name);
	}
	for (const name of parentRequired) {
		if (Object.hasOwn(ownProperties, name) && Object.hasOwn(mergedProperties, name)) {
			safeRequired.add(name);
		}
	}
	const requiredInPropertyOrder: string[] = [];
	for (const name in mergedProperties) {
		if (Object.hasOwn(mergedProperties, name) && safeRequired.has(name)) requiredInPropertyOrder.push(name);
	}
	if (requiredInPropertyOrder.length > 0) {
		nextSchema.required = requiredInPropertyOrder;
	} else {
		delete nextSchema.required;
	}

	return nextSchema;
}

function collapseMixedTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const seenTypes = new Set<string>();
	const variantTypes: string[] = [];
	const mergedVariantFields: JsonObject = {};
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") {
			return schema;
		}

		const variantType = entry.type;
		if (seenTypes.has(variantType)) {
			return schema;
		}

		const allowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[variantType];
		if (!allowedKeys) {
			return schema;
		}

		for (const key in entry) {
			if (!Object.hasOwn(entry, key)) continue;
			const variantValue = entry[key];
			if (key === "type") continue;
			if (!Object.hasOwn(allowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
				return schema;
			}

			const existingValue = mergedVariantFields[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, variantValue)) {
				if (key !== "description") return schema;
				// Descriptions are annotations, so merge branch-local spill text instead of
				// treating it as a structural incompatibility.
				mergedVariantFields[key] = mergeSchemaDescriptions(existingValue, variantValue);
				continue;
			}
			mergedVariantFields[key] = variantValue;
		}

		seenTypes.add(variantType);
		variantTypes.push(variantType);
	}

	if (variantTypes.length < 2 || variantTypes.every(type => type === "object")) {
		return schema;
	}
	const nextSchema = copySchemaWithout(schema, combiner);
	const nonNullTypes = variantTypes.filter(t => t !== "null");
	const chosenType: string = nonNullTypes[0] ?? variantTypes[0];
	nextSchema.type = chosenType;
	const chosenTypeAllowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[chosenType] ?? {};

	// Strip sibling keys that were copied from the parent and belong to a
	// different type (e.g. `items` sibling on a now-string-typed schema).
	for (const key in nextSchema) {
		if (!Object.hasOwn(nextSchema, key)) continue;
		if (key === "type") continue;
		if (
			Object.hasOwn(ALL_CCA_TYPE_SPECIFIC_KEYS, key) &&
			!Object.hasOwn(chosenTypeAllowedKeys, key) &&
			!Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)
		) {
			delete nextSchema[key];
		}
	}

	for (const key in mergedVariantFields) {
		if (!Object.hasOwn(mergedVariantFields, key)) continue;
		// Drop type-specific keys that don't belong to the chosen type
		if (!Object.hasOwn(chosenTypeAllowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
			continue;
		}
		const value = mergedVariantFields[key];
		const existingValue = nextSchema[key];
		if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
			if (key !== "description") return schema;
			nextSchema[key] = mergeSchemaDescriptions(existingValue, value);
			continue;
		}
		if (existingValue === undefined) {
			nextSchema[key] = value;
		}
	}
	return nextSchema;
}

function mergeSchemaDescriptions(existing: unknown, incoming: unknown): string {
	if (typeof existing !== "string") return typeof incoming === "string" ? incoming : "";
	if (typeof incoming !== "string" || incoming.length === 0 || existing === incoming) return existing;
	if (existing.length === 0) return incoming;
	return `${existing}\n\n${incoming}`;
}

function collapseSameTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return schema;
	let commonType: string | undefined;
	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") return schema;
		if (commonType === undefined) commonType = entry.type;
		else if (entry.type !== commonType) return schema;
		variants.push(entry);
	}
	const firstEntry = variants[0];
	if (!firstEntry) return schema;

	// Same-type collapse otherwise keeps only the first variant's keys, silently
	// dropping the other branches' `enum` members (e.g. an anyOf of two string
	// enums collapsing to just the first).
	const enumVariantCount = variants.reduce((n, variant) => n + (Array.isArray(variant.enum) ? 1 : 0), 0);

	let collapsed: JsonObject;
	if (enumVariantCount === variants.length) {
		// Every branch is an `enum` schema: fold them with
		// `mergeCompatibleEnumSchemas`, which unions the members only when the
		// branches agree on `type` and every non-`enum` field, returning null
		// otherwise. Bail to the untouched schema on any disagreement so the
		// residual-combiner fallback handles it instead of mislabeling.
		let merged: JsonObject | null = firstEntry;
		for (let i = 1; i < variants.length && merged !== null; i++) {
			merged = mergeCompatibleEnumSchemas(merged, variants[i]);
		}
		if (merged === null) return schema;
		collapsed = merged;
	} else if (enumVariantCount > 0) {
		// Mixed branches: at least one is unconstrained by `enum` and is therefore
		// broader. Collapse onto the first such branch so the result keeps its
		// (broader) keys — never narrowing to an enum branch's members or leaking
		// its metadata (description/default).
		collapsed = variants.find(variant => !Array.isArray(variant.enum)) ?? firstEntry;
	} else {
		// No `enum` branches: keep the original first-wins behavior.
		collapsed = firstEntry;
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	for (const key in collapsed) {
		if (Object.hasOwn(collapsed, key) && !outHasOwn(nextSchema, key)) nextSchema[key] = collapsed[key];
	}
	return nextSchema;
}

/**
 * Recursively strip any remaining anyOf/oneOf that same-type or mixed-type
 * collapse can handle. This is needed because object-combiner merging can
 * create new anyOf in merged subtrees after child normalization already ran.
 */
export function stripResidualCombiners(value: unknown, epoch: number = epochNext()): unknown {
	return stripResidualCombinersNode(value, epoch, false);
}

function stripResidualCombinersNode(value: unknown, epoch: number, insideSchemaMap: boolean): unknown {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return [];
		return value.map(entry => stripResidualCombinersNode(entry, epoch, false));
	}
	if (!isJsonObject(value)) return value;
	if (!once(value, epoch)) return {};
	const result: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		result[key] = childKind ? stripResidualCombinersNode(entry, epoch, childKind === "map") : entry;
	}
	if (insideSchemaMap) return result;

	let current: JsonObject = result;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of JSON_SCHEMA_COMBINERS) {
			const sameType = collapseSameTypeCombinerVariants(current, combiner);
			if (sameType !== current) {
				current = sameType;
				changed = true;
			}
			const mixed = collapseMixedTypeCombinerVariants(current, combiner);
			if (mixed !== current) {
				current = mixed;
				changed = true;
			}
		}
	}
	return current;
}

interface NullableExtractionResult {
	schema: unknown;
	nullable: boolean;
}

function extractNullableUnionSchema(schema: unknown): NullableExtractionResult {
	if (!isJsonObject(schema)) {
		return { schema, nullable: false };
	}

	if (schema.nullable === true) {
		const nextSchema = { ...schema };
		delete nextSchema.nullable;
		return { schema: nextSchema, nullable: true };
	}

	if (Array.isArray(schema.type)) {
		const typeVariants = schema.type.filter((entry): entry is string => typeof entry === "string");
		const nonNullTypes = typeVariants.filter(entry => entry !== "null");
		if (typeVariants.includes("null") && nonNullTypes.length === 1) {
			const nextSchema = { ...schema, type: nonNullTypes[0] };
			return { schema: nextSchema, nullable: true };
		}
	}

	for (const combiner of JSON_SCHEMA_COMBINERS) {
		const variantsRaw = schema[combiner];
		if (!Array.isArray(variantsRaw)) continue;

		let hasNullVariant = false;
		const nonNullVariants: unknown[] = [];
		for (const variant of variantsRaw) {
			if (isJsonObject(variant) && variant.type === "null") {
				let keyCount = 0;
				for (const k in variant) {
					if (!Object.hasOwn(variant, k)) continue;
					if (++keyCount > 1) break;
				}
				if (keyCount === 1) {
					hasNullVariant = true;
					continue;
				}
			}
			nonNullVariants.push(variant);
		}

		if (!hasNullVariant || nonNullVariants.length !== 1 || !isJsonObject(nonNullVariants[0])) {
			continue;
		}

		const nextSchema = copySchemaWithout(schema, combiner);
		const nonNullVariant = nonNullVariants[0];
		for (const key in nonNullVariant) {
			if (!Object.hasOwn(nonNullVariant, key)) continue;
			const value = nonNullVariant[key];
			const existingValue = nextSchema[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
				return { schema, nullable: false };
			}
			if (existingValue === undefined) {
				nextSchema[key] = value;
			}
		}
		return { schema: nextSchema, nullable: true };
	}

	return { schema, nullable: false };
}

interface NullableNormalizationResult {
	schema: unknown;
	nullable: boolean;
}

function normalizeNullablePropertiesForCloudCodeAssist(
	value: unknown,
	isPropertySchema = false,
	epoch: number = epochNext(),
	insideSchemaMap = false,
): NullableNormalizationResult {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) {
			return { schema: [], nullable: false };
		}
		return {
			schema: value.map(entry => normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch).schema),
			nullable: false,
		};
	}
	if (!isJsonObject(value)) {
		return { schema: value, nullable: false };
	}
	if (!once(value, epoch)) {
		return { schema: {}, nullable: false };
	}

	const normalized: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		normalized[key] = childKind
			? normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch, childKind === "map").schema
			: entry;
	}
	if (insideSchemaMap) return { schema: normalized, nullable: false };

	if (isJsonObject(normalized.properties)) {
		const properties = normalized.properties;
		const required = new Set(
			Array.isArray(normalized.required)
				? normalized.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const nextProperties: JsonObject = {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(properties[name], true, epoch);
			nextProperties[name] = normalizedProperty.schema;
			if (normalizedProperty.nullable) {
				required.delete(name);
			}
		}
		normalized.properties = nextProperties;
		if (Array.isArray(normalized.required)) {
			normalized.required = Array.from(required);
		}
	}

	if (!isPropertySchema) {
		return { schema: normalized, nullable: false };
	}

	return extractNullableUnionSchema(normalized);
}

function createResidualIncompatibilityChecks(
	checks: ReadonlyArray<ResidualSchemaIncompatibility> | undefined,
): ResidualIncompatibilityChecks | undefined {
	if (!checks || checks.length === 0) return undefined;
	const result: ResidualIncompatibilityChecks = {
		typeArray: false,
		typeNull: false,
		nullable: false,
		combiners: false,
		not: false,
	};
	for (const check of checks) {
		switch (check) {
			case "type-array":
				result.typeArray = true;
				break;
			case "type-null":
				result.typeNull = true;
				break;
			case "nullable":
				result.nullable = true;
				break;
			case "not":
				result.not = true;
				break;
			case "combiners":
				result.combiners = true;
				break;
		}
	}
	return result;
}

function hasResidualSchemaIncompatibilities(
	value: unknown,
	checks: ResidualIncompatibilityChecks,
	epoch: number = epochNext(),
	insideSchemaMap = false,
): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => hasResidualSchemaIncompatibilities(entry, checks, epoch, false));
	}
	if (!isJsonObject(value)) {
		return false;
	}
	if (!once(value, epoch)) {
		return false;
	}

	if (!insideSchemaMap) {
		if (checks.typeArray && Array.isArray(value.type)) return true;
		if (checks.typeNull && value.type === "null") return true;
		if (checks.nullable && Object.hasOwn(value, "nullable")) return true;
		if (checks.not && Object.hasOwn(value, "not")) return true;
		if (checks.combiners) {
			for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
				if (Array.isArray(value[combiner])) return true;
			}
		}
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		if (childKind && hasResidualSchemaIncompatibilities(entry, checks, epoch, childKind === "map")) {
			return true;
		}
	}
	return false;
}

/**
 * True when a JSON Schema subtree carries any composition keyword (`anyOf`,
 * `oneOf`, `allOf`) in a schema position. Property *names* that happen to equal
 * a combiner keyword (living under `properties`/`patternProperties`) are not
 * combiners and do not count.
 */
function containsSchemaCombiner(value: unknown, insideSchemaMap: boolean, epoch: number): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => containsSchemaCombiner(entry, false, epoch));
	}
	if (!isJsonObject(value)) return false;
	if (!once(value, epoch)) return false;
	if (!insideSchemaMap) {
		for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
			if (Array.isArray(value[combiner])) return true;
		}
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const childKind = classifySchemaChild(key, value[key], insideSchemaMap);
		if (childKind && containsSchemaCombiner(value[key], childKind === "map", epoch)) return true;
	}
	return false;
}

/**
 * Fold every composition keyword out of one already child-projected node while
 * only ever widening acceptance. Object-shaped `anyOf`/`oneOf`/`allOf` branches
 * merge into the node's own `properties` via {@link mergeObjectCombinerVariants}
 * (union properties, combiner-appropriate `required`); any combiner whose
 * branches are not all object-shaped — scalar unions especially — is dropped so
 * the node widens to accept-all rather than narrowing to one branch. Merging can
 * itself synthesize a fresh `anyOf` inside a shared property (see
 * {@link mergePropertySchemas}), so property values are re-projected until the
 * node is combiner-free.
 */
function projectNodeCombinersForCursor(node: JsonObject): JsonObject {
	let current = node;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
			if (!Array.isArray(current[combiner])) continue;
			const source = current;
			const merged = mergeObjectCombinerVariants(current, combiner);
			if (merged !== current) {
				current = merged;
				const properties = current.properties;
				if (isJsonObject(properties)) {
					if (combiner !== "allOf") {
						const sourceProperties = isJsonObject(source.properties) ? source.properties : {};
						const sourceVariants = source[combiner] as JsonObject[];
						for (const name in properties) {
							if (!Object.hasOwn(properties, name)) continue;
							if (Object.hasOwn(sourceProperties, name)) {
								properties[name] = sourceProperties[name];
								continue;
							}
							let widenedProperty: unknown;
							for (const variant of sourceVariants) {
								const variantProperties = isJsonObject(variant.properties) ? variant.properties : {};
								let constraint: unknown;
								if (Object.hasOwn(variantProperties, name)) {
									constraint = variantProperties[name];
								} else if (variant.additionalProperties === false) {
									continue;
								} else if (isJsonObject(variant.additionalProperties)) {
									constraint = variant.additionalProperties;
								} else {
									constraint = {};
								}
								widenedProperty =
									widenedProperty === undefined
										? constraint
										: mergePropertySchemas(widenedProperty, constraint);
							}
							properties[name] = widenedProperty ?? {};
						}
					}
					for (const name in properties) {
						if (Object.hasOwn(properties, name)) {
							properties[name] = projectSchemaForCursor(properties[name], false);
						}
					}
				}
			} else {
				current = copySchemaWithout(current, combiner);
			}
			changed = true;
		}
	}
	return current;
}

function projectSchemaForCursor(value: unknown, insideSchemaMap: boolean, epoch: number = epochNext()): unknown {
	if (Array.isArray(value)) {
		if (!enter(value)) return [];
		try {
			return value.map(entry => projectSchemaForCursor(entry, false, epoch));
		} finally {
			exit(value);
		}
	}
	if (!isJsonObject(value)) return value;
	if (!enter(value)) return {};
	try {
		const result: JsonObject = {};
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const entry = value[key];
			// A `not` subschema is a negative constraint: widening its contents
			// would make the negation reject a superset of the canonical schema.
			// Cursor cannot carry the combiner, and no faithful widening exists, so
			// drop the whole negation — always sound, since removing a restriction
			// only broadens acceptance (fixes the `not: {}` inversion, issue #10432).
			if (!insideSchemaMap && key === "not" && containsSchemaCombiner(entry, false, epochNext())) {
				continue;
			}
			const childKind = classifySchemaChild(key, entry, insideSchemaMap);
			result[key] = childKind ? projectSchemaForCursor(entry, childKind === "map", epoch) : entry;
		}
		return insideSchemaMap ? result : projectNodeCombinersForCursor(result);
	} finally {
		exit(value);
	}
}

/**
 * Project a tool's wire schema onto the subset Cursor's MCP tool catalog
 * accepts. Cursor rejects the entire request with a provider 400 when any
 * advertised schema carries a composition keyword (issue #10432); this removes
 * `anyOf`/`oneOf`/`allOf` everywhere while preserving representable guidance and
 * only ever widening acceptance, so every input the canonical schema accepts is
 * still accepted by the advertised projection. The canonical schema (used for
 * execution-time argument validation) is never mutated.
 */
export function sanitizeSchemaForCursor(schema: JsonObject): JsonObject {
	return projectSchemaForCursor(dereferenceJsonSchema(schema), false) as JsonObject;
}

export function normalizeSchema(value: unknown, options: NormalizeSchemaOptions): unknown {
	const upgraded = upgradeJsonSchemaTo202012(value);
	const dereferenced = dereferenceJsonSchema(upgraded);
	let normalized = normalizeSchemaNode(dereferenced, {
		...options,
		insideSchemaMap: false,
		booleanIsSubschema: true,
	});
	if (options.stripResidualCombinersFixpoint) {
		normalized = stripResidualCombiners(normalized);
	}
	if (options.extractNullableFromUnions) {
		normalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
	}
	const residualChecks = createResidualIncompatibilityChecks(options.rejectResidualIncompatibilities);
	if (residualChecks && hasResidualSchemaIncompatibilities(normalized, residualChecks)) {
		logger.debug("Schema has residual provider incompatibilities, using fallback");
		return options.validateAndFallback?.fallback ?? normalized;
	}
	if (options.validateAndFallback && !isValidJsonSchema(normalized)) {
		logger.debug("Schema failed validation, using fallback");
		return options.validateAndFallback.fallback;
	}
	return normalized;
}

export function normalizeSchemaForGoogle(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "standard",
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: true,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: false,
		autoPropertyOrdering: true,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		stringEnumsOnly: true,
		foldOneOfIntoAnyOf: false,
	});
}

export function normalizeSchemaForCCA(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "standard",
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: true,
		collapseSameTypeCombiners: true,
		collapseMixedTypeCombiners: true,
		stripResidualCombinersFixpoint: true,
		extractNullableFromUnions: true,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		foldOneOfIntoAnyOf: false,
		rejectResidualIncompatibilities: ["type-array", "type-null", "nullable", "combiners", "not"],
		validateAndFallback: { fallback: CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA },
	});
}

export function normalizeSchemaForMCP(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isMcpUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: false,
		foldOneOfIntoAnyOf: false,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: false,
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: false,
		dropNonScalarEnum: false,
	});
}

/**
 * Moonshot Flavored JSON Schema (MFJS) — the stricter subset Moonshot/Kimi
 * native hosts (api.moonshot.ai, api.kimi.com) validate
 * `tools.function.parameters` against. It rejects standard JSON Schema
 * constructs that OpenAI-compatible hosts accept, returning HTTP 400
 * `tools.function.parameters is not a valid moonshot flavored json schema`.
 * Differences this normalizer reconciles:
 *
 *  - `const` (incl. `anyOf`/`oneOf` whose every branch is a bare `const`) is
 *    rejected; collapse to `enum` with an inferred scalar `type`.
 *  - `oneOf` is not an MFJS combinator (only `anyOf` is); residual `oneOf` is
 *    folded into `anyOf`.
 *  - `type` must be a scalar string; `type: [...]` arrays are reduced to a
 *    single scalar (the `null` branch is dropped — `nullable` is unsupported).
 *  - Enum-bearing nodes get an inferred `type` (the idiomatic MFJS form; a bare
 *    `enum` is valid too) so `anyOf` branches always carry a `type`.
 *  - Validation/decorative keywords (`minItems`, `maxItems`, `maxLength`,
 *    `pattern`, `format`, `title`, …) and tuple `prefixItems` are rejected and
 *    stripped, spilling human-meaningful ones into the sibling `description`.
 *    `default` and `description` are MFJS Meta Data fields and are preserved.
 *  - `additionalProperties` (boolean or schema) and `type: "null"` (incl.
 *    inside `anyOf`) are kept.
 *  - Boolean subschemas are object-coerced; MFJS has no exact `false` schema,
 *    so both values become the permissive empty schema while local tool
 *    validation remains authoritative.
 *
 * Out of scope (absent from the built-in tool surface, spec-ambiguous to
 * rewrite blindly): `allOf` intersection merging, external/recursive `$ref`,
 * and the depth-10 limit.
 */
export function normalizeSchemaForMoonshot(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "permissive",
		unsupportedFields: isMoonshotUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: true,
		foldOneOfIntoAnyOf: true,
	});
}

// ---------------------------------------------------------------------------
// Ollama — Go schema parser compatibility
// ---------------------------------------------------------------------------

const OLLAMA_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

/**
 * Widened stand-in for a `true` / `{}` open subschema on a tool bound for a
 * backend whose wire cannot encode a bare boolean subschema.
 *
 * `toolWireSchema()` normalizes empty schemas to boolean `true` upstream so
 * grammar-constrained samplers don't treat `{}` as "generate an empty object"
 * (issue #1179). Two backends then choke on the bare boolean: Ollama's Go tool
 * parser can't unmarshal it into its object-shaped `Schema` struct, and
 * llama.cpp's JSON-schema→GBNF converter has no case for a boolean schema
 * (issue #5914). Both sanitizers replace the open subschema with an explicit
 * union of every primitive JSON type — the wire has no boolean subschema, and
 * a grammar sampler sees a real value union rather than a closed empty object.
 */
const OPEN_SUBSCHEMA_WIDENING = Object.freeze({
	anyOf: [
		{ type: "string" },
		{ type: "number" },
		{ type: "boolean" },
		{ type: "object" },
		{ type: "array" },
		{ type: "null" },
	],
});

/**
 * Rewrites standard JSON Schema forms that Ollama's Go `/api/chat` tool parser
 * cannot unmarshal into its object-shaped `Schema` struct.
 */
export function sanitizeSchemaForOllama(schema: JsonObject): JsonObject {
	const normalizeNode = (value: unknown): unknown => {
		if (value === true) return OPEN_SUBSCHEMA_WIDENING;
		if (value === false) return { not: OPEN_SUBSCHEMA_WIDENING };
		if (!isJsonObject(value)) {
			if (!Array.isArray(value)) return value;
			let changed = false;
			const output = value.map(item => {
				const next = normalizeNode(item);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? output : value;
		}

		let changed = false;
		const output: JsonObject = {};
		let typeAlternatives: JsonObject[] | undefined;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const child = value[key];
			if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") {
				changed = true;
				continue;
			}
			if (key === "type" && Array.isArray(child)) {
				const variants = child.filter((entry): entry is string => typeof entry === "string");
				const uniqueVariants = [...new Set(variants)];
				const nonNull = uniqueVariants.filter(entry => entry !== "null");
				if (nonNull.length <= 1) {
					output.type = nonNull[0] ?? uniqueVariants[0] ?? child[0];
				} else {
					typeAlternatives = uniqueVariants.map(entry => ({ type: entry }));
				}
				changed = true;
				continue;
			}

			let next = child;
			if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
				let mapChanged = false;
				const mapOutput: JsonObject = {};
				for (const childKey in child) {
					if (!Object.hasOwn(child, childKey)) continue;
					const mapChild = child[childKey];
					const normalizedChild = normalizeNode(mapChild);
					if (normalizedChild !== mapChild) mapChanged = true;
					mapOutput[childKey] = normalizedChild;
				}
				next = mapChanged ? mapOutput : child;
			} else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
				let arrayChanged = false;
				const arrayOutput = child.map(item => {
					const normalizedItem = normalizeNode(item);
					if (normalizedItem !== item) arrayChanged = true;
					return normalizedItem;
				});
				next = arrayChanged ? arrayOutput : child;
			} else if (OLLAMA_SCHEMA_VALUE_KEYS.has(key)) {
				next = normalizeNode(child);
			}
			if (next !== child) changed = true;
			output[key] = next;
		}

		if (typeAlternatives) {
			const existingAllOf = output.allOf;
			const typeUnion = { anyOf: typeAlternatives };
			output.allOf = Array.isArray(existingAllOf) ? [typeUnion, ...existingAllOf] : [typeUnion];
		}

		return changed ? output : value;
	};
	return normalizeNode(schema) as JsonObject;
}

/**
 * Schema-valued keywords whose bare boolean value must be widened for a
 * grammar-constrained backend. Excludes `additionalProperties` and
 * `unevaluatedProperties`: llama.cpp's `_build_object_rule` reads their boolean
 * form as meaningful closed/open-object semantics, and `additionalProperties:
 * false` is exactly what `toolWireSchema` emits to pin a strict object shape.
 */
const GRAMMAR_SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	contains: true,
	contentSchema: true,
	propertyNames: true,
	if: true,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword
	then: true,
	else: true,
	not: true,
	unevaluatedItems: true,
};

/**
 * Rewrites the one JSON Schema form that grammar-constrained OpenAI-compatible
 * backends (llama.cpp, LM Studio, vLLM) cannot compile to GBNF: a bare boolean
 * subschema. `toolWireSchema` normalizes `{}` open subschemas to boolean `true`
 * (issue #1179); llama.cpp's `json-schema-to-grammar.cpp` `visit()` has no case
 * for a boolean schema and throws `Unrecognized schema: true` → HTTP 400 before
 * the model is consulted (issue #5914).
 *
 * Narrower than {@link sanitizeSchemaForOllama}: only genuine subschema slots
 * are widened. Boolean `additionalProperties`/`unevaluatedProperties` stay
 * intact because the converter reads those as closed/open-object grammar
 * semantics, and dropping `additionalProperties: false` would silently reopen
 * every declared object.
 */
export function sanitizeSchemaForGrammar(schema: JsonObject): JsonObject {
	const normalizeNode = (value: unknown, isSubschema: boolean): unknown => {
		if (value === true) return isSubschema ? OPEN_SUBSCHEMA_WIDENING : value;
		if (value === false) return isSubschema ? { not: OPEN_SUBSCHEMA_WIDENING } : value;
		if (Array.isArray(value)) {
			let changed = false;
			const output = value.map(item => {
				const next = normalizeNode(item, isSubschema);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? output : value;
		}
		if (!isJsonObject(value)) return value;

		let changed = false;
		const output: JsonObject = {};
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const child = value[key];
			let next = child;
			if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
				let mapChanged = false;
				const mapOutput: JsonObject = {};
				for (const childKey in child) {
					if (!Object.hasOwn(child, childKey)) continue;
					const mapChild = child[childKey];
					const normalizedChild = normalizeNode(mapChild, true);
					if (normalizedChild !== mapChild) mapChanged = true;
					mapOutput[childKey] = normalizedChild;
				}
				next = mapChanged ? mapOutput : child;
			} else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
				let arrayChanged = false;
				const arrayOutput = child.map(item => {
					const normalizedItem = normalizeNode(item, true);
					if (normalizedItem !== item) arrayChanged = true;
					return normalizedItem;
				});
				next = arrayChanged ? arrayOutput : child;
			} else if (Object.hasOwn(GRAMMAR_SCHEMA_VALUE_KEYS, key)) {
				next = normalizeNode(child, true);
			} else if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child !== "boolean") {
				// Boolean form is meaningful closed/open-object grammar semantics and
				// stays intact; the object form is a genuine subschema whose interior
				// may still hold bare booleans emitted by `toolWireSchema`.
				next = normalizeNode(child, true);
			}
			if (next !== child) changed = true;
			output[key] = next;
		}
		return changed ? output : value;
	};
	return normalizeNode(schema, true) as JsonObject;
}

// ---------------------------------------------------------------------------
// OpenAI Responses — schema-valued normalization
// ---------------------------------------------------------------------------

const OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const OPENAI_RESPONSES_SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	// `dependencies` is the Draft-04..07 schema-valued form; older MCP servers
	// still emit `{ dependencies: { foo: { type: "object" } } }`. String-array
	// branches per key pass through `normalizeOpenAIResponsesSchemaNode`
	// untouched because non-objects return as-is.
	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);
const OPENAI_RESPONSES_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

/**
 * OpenAI Responses rejects `oneOf` in tool schemas even when strict mode is
 * disabled, and rejects every schema node with `type: "object"` unless it has
 * a `properties` member. Normalize only schema-valued positions so literal
 * payloads under `enum`, `const`, `default`, and `examples` remain unchanged.
 *
 * Identity-preserving: returns the input reference unchanged when no rewrite
 * occurred so callers can dedupe via reference equality (and the strict-mode
 * cache stays warm). If a node has both `oneOf` and `anyOf`, the two are
 * concatenated (the wire payload accepts a single union; preserving both
 * would not survive).
 */
export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
	return normalizeOpenAIResponsesSchemaNode(schema, new WeakMap()) as JsonObject;
}

/**
 * Alias for {@link sanitizeSchemaForOpenAIResponses} matching the
 * `normalizeSchemaFor*` dispatcher naming used elsewhere in this module.
 */
export const normalizeSchemaForOpenAIResponses: (schema: JsonObject) => JsonObject = sanitizeSchemaForOpenAIResponses;
const OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS = new Set(["=", "!", "<=", "<!"]);
const OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK = ".*";

function hasOpenAIUnsupportedRegexLookaround(pattern: string): boolean {
	let groupStart = pattern.indexOf("(?");
	while (groupStart !== -1) {
		let escapes = 0;
		for (let i = groupStart - 1; i >= 0 && pattern[i] === "\\"; i--) escapes++;
		if (escapes % 2 === 0) {
			const operator =
				pattern[groupStart + 2] === "<" ? pattern.slice(groupStart + 2, groupStart + 4) : pattern[groupStart + 2];
			if (OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has(operator)) return true;
		}
		groupStart = pattern.indexOf("(?", groupStart + 2);
	}
	return false;
}

function normalizeOpenAIResponsesSchemaNode(value: unknown, cache: WeakMap<JsonObject, unknown>): unknown {
	if (!isJsonObject(value)) return value;

	// `{}` (empty JSON Schema) ≡ `true` (JSON Schema draft 2020-12 §4.3.1).
	// Grammar-constrained samplers (llama.cpp, etc.) treat the object form as
	// "generate an empty object" rather than "any JSON value" (issue #1179).
	// `toolWireSchema` already runs `normalizeEmptySchemas` upstream, but this
	// guard remains as a safety net for callers that invoke
	// `sanitizeSchemaForOpenAIResponses` directly on a schema that bypassed
	// the wire-schema pipeline (e.g. provider-specific fixtures, debug paths).
	if (isJsonObjectEmpty(value)) return true;

	const cached = cache.get(value);
	if (cached) return cached;

	// Seed the cache with the in-flight `output` BEFORE recursing so that a
	// child re-entering this node mid-walk gets the partial back instead of
	// triggering an infinite recursion. A cycle hitting this seeded entry
	// forces `changed = true` below (the cached partial is referentially
	// distinct from `value`), which is why the final `cache.set(value, result)`
	// never silently overwrites the seed with `value` on a cyclic input.
	const output: JsonObject = {};
	cache.set(value, output);

	let changed = false;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		// Drop only well-formed `oneOf` arrays here; they are re-emitted as
		// `anyOf` after the loop so any neighboring `anyOf` entries can be
		// concatenated. A non-array `oneOf` is malformed for the wire but
		// still preserved verbatim so callers can see the original payload
		// instead of having it silently disappear.
		if (key === "oneOf" && Array.isArray(value.oneOf)) {
			changed = true;
			continue;
		}
		if (
			key === "pattern" &&
			typeof value.pattern === "string" &&
			hasOpenAIUnsupportedRegexLookaround(value.pattern)
		) {
			changed = true;
			continue;
		}

		const child = value[key];
		let next: unknown = child;
		if (key === "patternProperties" && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, true);
		} else if (OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has(key) && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, false);
		} else if (OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
			next = normalizeOpenAIResponsesSchemaArray(child, cache);
		} else if (OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has(key) && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaNode(child, cache);
		}

		if (next !== child) changed = true;
		output[key] = next;
	}

	if (Array.isArray(value.oneOf)) {
		const rewrittenOneOf = normalizeOpenAIResponsesSchemaArray(value.oneOf, cache);
		const existingAnyOf = output.anyOf;
		output.anyOf = Array.isArray(existingAnyOf)
			? [...existingAnyOf, ...(rewrittenOneOf as unknown[])]
			: rewrittenOneOf;
	}

	// Draft 2020-12 lets `type` be an array (e.g. `["object", "null"]`); treat
	// any variant that includes "object" as an object position for the
	// properties requirement.
	if (declaresObjectType(value.type) && !Object.hasOwn(value, "properties")) {
		output.properties = {};
		changed = true;
	}

	// Safe to overwrite the seed: any cyclic re-entry above already observed
	// the seeded partial and set `changed = true` for that node, so a node
	// that finishes with `changed === false` is provably non-cyclic and
	// referentially equal to its input.
	const result = changed ? (isJsonObjectEmpty(output) ? true : output) : value;
	cache.set(value, result);
	return result;
}

function declaresObjectType(type: unknown): boolean {
	if (type === "object") return true;
	if (!Array.isArray(type)) return false;
	for (const variant of type) {
		if (variant === "object") return true;
	}
	return false;
}

function normalizeOpenAIResponsesSchemaArray(value: unknown[], cache: WeakMap<JsonObject, unknown>): unknown[] {
	let changed = false;
	const output = value.map(item => {
		const next = normalizeOpenAIResponsesSchemaNode(item, cache);
		if (next !== item) changed = true;
		return next;
	});
	return changed ? output : value;
}

function normalizeOpenAIResponsesSchemaMap(
	schemaMap: JsonObject,
	cache: WeakMap<JsonObject, unknown>,
	stripUnsupportedRegexKeys: boolean,
): JsonObject {
	let changed = false;
	const output: JsonObject = {};
	for (const key in schemaMap) {
		if (!Object.hasOwn(schemaMap, key)) continue;
		const child = schemaMap[key];
		const next = normalizeOpenAIResponsesSchemaNode(child, cache);
		if (next !== child) changed = true;
		if (stripUnsupportedRegexKeys && hasOpenAIUnsupportedRegexLookaround(key)) {
			changed = true;
			appendOpenAIResponsesFallbackPatternProperty(output, next);
			continue;
		}
		output[key] = next;
	}
	return changed ? output : schemaMap;
}

function appendOpenAIResponsesFallbackPatternProperty(output: JsonObject, schema: unknown): void {
	const existing = output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK];
	if (existing === undefined) {
		output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = schema;
		return;
	}
	if (isJsonObject(existing) && Array.isArray(existing.anyOf) && Object.keys(existing).length === 1) {
		existing.anyOf = [...existing.anyOf, schema];
		return;
	}
	output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = { anyOf: [existing, schema] };
}

// ---------------------------------------------------------------------------
// OpenAI strict mode — sanitize + enforce
// ---------------------------------------------------------------------------

/**
 * Single primitive JSON Schema `type` keyword. Strict mode treats these
 * scalar types as concrete-enough; aggregate shapes (object, array) are not
 * included because they're not derivable from a single `enum`/`const` value.
 */
type StrictPrimitiveType = "null" | "string" | "number" | "boolean";

function primitiveJsonTypeOf(value: unknown): StrictPrimitiveType | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return undefined;
	}
}
function jsonSchemaTypeAcceptsValue(type: string, value: unknown): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isJsonObject(value);
		default:
			return true;
	}
}

function narrowEnumToType(schema: Record<string, unknown>, type: string): boolean {
	const enumValues = schema.enum;
	if (!Array.isArray(enumValues)) return true;

	const narrowed = enumValues.filter(value => jsonSchemaTypeAcceptsValue(type, value));
	if (narrowed.length === 0) return false;
	if (narrowed.length !== enumValues.length) schema.enum = narrowed;
	return true;
}

/**
 * Returns the primitive `type` keyword that fully describes the constraint
 * expressed by this node's `enum` (or `const`), or `undefined` when the
 * constraint cannot be reduced to a single primitive type.
 *
 * Strict mode requires every schema node to declare a concrete `type`. When
 * the author wrote `{enum:[...]}` or `{const:X}` without a `type`, we can
 * infer one — but only when every value reduces to the same primitive type.
 * Mixed-primitive enums (`[1, "two", null]`), enums containing non-primitives
 * (`[{a:1}]`), and non-primitive consts (`{a:1}`, `[1,2,3]`) all return
 * undefined: those shapes cannot be described by a single `type` keyword, so
 * strict mode cannot represent them and the caller must fall back.
 */
function inferStrictPrimitiveTypeFromEnumOrConst(node: Record<string, unknown>): StrictPrimitiveType | undefined {
	const values: unknown[] = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];
	if (values.length === 0) return undefined;
	let inferred: StrictPrimitiveType | undefined;
	for (const value of values) {
		const t = primitiveJsonTypeOf(value);
		if (t === undefined) return undefined; // non-primitive (object/array) — strict can't represent
		if (inferred === undefined) inferred = t;
		else if (inferred !== t) return undefined; // mixed primitives
	}
	return inferred;
}

/**
 * Per-schema-object memoization slot. The result of `tryEnforceStrictSchema`
 * is stamped directly onto the input via `stamp(target, kStrictSchema, …)`
 * so repeated calls (different providers, retries, batching) reuse the same
 * computed pair without re-walking the tree.
 */
const kStrictSchema = Symbol("pi.schema.strict");

/**
 * A boolean schema (`true`/`false`) or the empty object schema `{}`: an
 * unconstrained branch with no declared type. Strict providers (OpenAI/Codex)
 * reject these, and `enforceStrictSchema` would otherwise wave a non-object
 * branch through as `strict: true`, so they disqualify a schema from strict mode
 * wherever they sit in a combinator or `items`/`prefixItems` position.
 */
function isUnrepresentableStrictBranch(value: unknown): boolean {
	return typeof value === "boolean" || (isJsonObject(value) && isJsonObjectEmpty(value));
}

/**
 * Detect schemas that strict mode *cannot* represent.
 *
 * Strict mode requires closed object shapes — every property is declared in
 * `properties` and listed in `required`. That is incompatible with:
 *  - `patternProperties` (open keyset matched by regex),
 *  - `additionalProperties: true` or `additionalProperties: <schema>` (open
 *    keyset with optional further constraint).
 *  - boolean schemas (`true`/`false`) inside `anyOf`/`oneOf`/`allOf`/`items`/
 *    `prefixItems` — strict providers (OpenAI/Codex) reject the unconstrained
 *    branch, and `enforceStrictSchema` would otherwise wave the non-object
 *    branch through as `strict: true` (the `T | undefined` → `anyOf: [<T>, {}]`
 *    → `[<T>, true]` encoding is the canonical offender).
 *
 * This check recurses into every place a child schema may live (properties,
 * items/prefixItems, combinator branches, $defs) so a single offender deep
 * in the tree disqualifies the whole schema. Used to fail-open early in
 * `tryEnforceStrictSchema` rather than throwing during enforcement.
 */
function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, epoch: number = epochNext()): boolean {
	if (!once(schema, epoch)) return false;

	let hasPatternProperties = false;
	if (isJsonObject(schema.patternProperties)) {
		for (const _ in schema.patternProperties) {
			hasPatternProperties = true;
			break;
		}
	}
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isJsonObject(schema.properties)) {
		const properties = schema.properties;
		for (const k in properties) {
			const propertySchema = properties[k];
			if (isUnrepresentableStrictBranch(propertySchema)) return true;
			if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
				return true;
			}
		}
	}

	if (isUnrepresentableStrictBranch(schema.items)) {
		return true;
	}
	if (isJsonObject(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}
	if (Array.isArray(schema.prefixItems)) {
		for (const itemSchema of schema.prefixItems) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isUnrepresentableStrictBranch(variant)) return true;
			if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isJsonObject(defs)) continue;
		for (const k in defs) {
			const defSchema = defs[k];
			if (isUnrepresentableStrictBranch(defSchema)) return true;
			if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * First pass of strict-mode preparation.
 *
 * Rewrites everything strict mode forbids into something it accepts:
 *  - Drops non-structural keywords (`format`, `pattern`, `examples`, …),
 *    `const`, `nullable`, and `additionalProperties` (re-added by
 *    `enforceStrictSchema` as `false`).
 *  - `type: [a, b]` → `anyOf: [{type: a, …}, {type: b, …}]`, copying only the
 *    keywords each variant can use (e.g. `properties` stays only on the
 *    object variant).
 *  - `const` → single-entry `enum`.
 *  - Description carries a `(default: X)` suffix so the model still sees the
 *    documented default after the keyword is stripped.
 *  - `nullable: true` wraps the whole node in `anyOf:[T,{type:"null"}]`.
 *
 * Recurses into properties, items, prefixItems, combinators, and $defs. The
 * `cache` WeakMap dedupes shared subgraphs; the `epoch` is the cycle guard.
 */
export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
	root: Record<string, unknown> = schema,
): Record<string, unknown> {
	const cached = cache.get(schema);
	if (cached) return cached;
	if (!once(schema, epoch)) return {};

	// Pre-pass: unravel `$ref` with sibling keys by inlining the resolved def.
	// OpenAI strict mode forbids `{$ref, description, ...}`; the SDK resolves
	// and merges, with sibling keys taking precedence over the ref'd def.
	// Cite: openai-python/src/openai/lib/_pydantic.py:96-110 (`_ensure_strict_json_schema`)
	if (typeof schema.$ref === "string") {
		let hasSibling = false;
		for (const k in schema) {
			if (k !== "$ref" && Object.hasOwn(schema, k)) {
				hasSibling = true;
				break;
			}
		}
		if (hasSibling) {
			const resolved = resolveStrictRef(root, schema.$ref);
			if (resolved !== undefined) {
				// Sibling keys on the schema override keys from the resolved def.
				const merged: Record<string, unknown> = { ...resolved };
				for (const k in schema) {
					if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
					merged[k] = schema[k];
				}
				const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
				cache.set(schema, result);
				return result;
			}
		}
	}

	// Pre-pass: collapse single-element `allOf` by inlining its sole entry.
	// SDK semantics: `json_schema.update(ensured(all_of[0]))` — the inlined
	// entry's keys WIN over original sibling keys, then `allOf` is dropped.
	// Cite: openai-python/src/openai/lib/_pydantic.py:79-83
	{
		const allOf = schema.allOf;
		if (Array.isArray(allOf) && allOf.length === 1 && isJsonObject(allOf[0])) {
			const merged: Record<string, unknown> = { ...schema };
			delete merged.allOf;
			const sole = allOf[0] as Record<string, unknown>;
			for (const k in sole) {
				if (Object.hasOwn(sole, k)) merged[k] = sole[k];
			}
			const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
			cache.set(schema, result);
			return result;
		}
	}

	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}
		// Build one variant schema per type. Each variant keeps only the keywords
		// relevant to that type — object-only keywords stay on the object variant,
		// array-only keywords on the array variant, etc.
		//
		// `description` is metadata that applies to the whole union, not to any
		// single type variant, so hoist it to the wrapper so both branches share
		// it without duplication. Matches the optional-property wrap in
		// `enforceStrictSchema` and the typical OpenAI strict-mode "description
		// on the union" shape.
		const { description, ...variantBase } = sanitizedWithoutType;
		const variants: Record<string, unknown>[] = [];
		for (const variantType of typeVariants) {
			const variantSchema: Record<string, unknown> = { ...variantBase, type: variantType };
			if (variantType !== "object") {
				delete variantSchema.properties;
				delete variantSchema.required;
				delete variantSchema.additionalProperties;
			}
			if (variantType !== "array") {
				delete variantSchema.items;
			}
			if (!narrowEnumToType(variantSchema, variantType)) continue;
			variants.push(sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root));
		}

		if (variants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}

		if (variants.length === 1) {
			const sole = variants[0] as Record<string, unknown>;
			if (description !== undefined && !Object.hasOwn(sole, "description")) {
				sole.description = description;
			}
			cache.set(schema, sole);
			return sole;
		}

		const result: JsonObject = { anyOf: variants };
		if (description !== undefined) result.description = description;
		cache.set(schema, result);
		return result;
	}
	// Scalar `type`: walk the keys, rewriting or stripping per strict-mode rules.

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const key in schema) {
		const value = schema[key];
		if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
			continue;
		}
		// `properties` map — recurse into each property schema.

		if (key === "properties" && isJsonObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const propertyName in value) {
				const propertySchema = value[propertyName];
				properties[propertyName] = isJsonObject(propertySchema)
					? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
					: propertySchema;
			}
			sanitized.properties = properties;
			continue;
		}
		// `items` can be schema, tuple-array, or scalar boolean — recurse where applicable.

		if (key === "items") {
			if (isJsonObject(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}
		// `prefixItems` is always an array of schemas (draft 2020-12).

		if (key === "prefixItems" && Array.isArray(value)) {
			sanitized.prefixItems = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// `anyOf`/`oneOf`/`allOf` arrays — recurse into each branch.

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// Definition maps — recurse into each named schema.

		if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
			const defs: Record<string, unknown> = {};
			for (const definitionName in value) {
				const definitionSchema = value[definitionName];
				defs[definitionName] = isJsonObject(definitionSchema)
					? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
					: definitionSchema;
			}
			sanitized[key] = defs;
			continue;
		}
		// `additionalProperties` is owned by `enforceStrictSchema`, which sets it to false.

		if (key === "additionalProperties") {
			continue;
		}

		if (key === "description" && typeof value === "string" && schema.default !== undefined) {
			// Preserve `default:` info for strict-mode providers that strip the keyword.
			// Inline as `(default: X)` text in the description, matching the convention for
			// runtime-placeholder defaults (e.g. `cwd`) that cannot live in the keyword form.
			const defaultVal = schema.default;
			const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
			sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
			continue;
		}

		sanitized[key] = value;
	}
	// Post-pass: re-derive `type` and turn dropped keywords into a representable shape.

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	// Preserve the original scalar type after the strip-and-rebuild loop.
	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
		sanitized.type = "array";
	}

	// Last-resort inference: a bare `enum`/`const` with homogeneous primitives gets a `type`.
	if (sanitized.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(sanitized);
		if (inferred !== undefined) sanitized.type = inferred;
	}

	// `nullable: true` was stripped above — re-introduce it as an `anyOf` wrapper.
	// `description` hoists to the wrapper so both branches share it without
	// duplication — matches the optional-property wrap in `enforceStrictSchema`
	// and the typical OpenAI strict-mode "description on the union" shape.
	if (schema.nullable === true) {
		const { nullable: _, description, ...withoutNullable } = sanitized;
		const wrapper: JsonObject = { anyOf: [withoutNullable, { type: "null" }] };
		if (description !== undefined) wrapper.description = description;
		return wrapper;
	}

	return sanitized;
}

/**
 * A node whose only constraining keyword is `anyOf` (annotations like
 * `description` aside). Only such nodes can be merged into an enclosing
 * union without changing semantics: sibling keywords (`type`, `enum`,
 * `properties`, …) apply conjunctively with `anyOf`, so spreading the
 * branches of a non-pure node would drop those constraints.
 */
function isPureAnyOfNode(value: unknown): value is Record<string, unknown> & { anyOf: unknown[] } {
	if (!isJsonObject(value) || !Array.isArray(value.anyOf)) return false;
	for (const key in value) {
		if (key !== "anyOf" && key !== "description") return false;
	}
	return true;
}

/**
 * Recursively enforces JSON Schema constraints required by OpenAI/Codex strict mode:
 *   - `additionalProperties: false` on every object node
 *   - every key in `properties` present in `required`
 *
 * Properties absent from the original `required` array were TypeBox-optional.
 * They are made nullable (`anyOf: [T, { type: "null" }]`) so the model can
 * signal omission by outputting null rather than omitting the key entirely.
 *
 * @throws {Error} When a schema node has no `type`, array-based combinator
 *   (`anyOf`/`allOf`/`oneOf`), object-based combinator (`not`), or `$ref` —
 *   i.e. the node is not representable in strict mode. Prefer
 *   {@link tryEnforceStrictSchema} which catches this and degrades gracefully.
 */
export function enforceStrictSchema(
	schema: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
	if (!enter(schema)) {
		throw new AIError.ValidationError("Schema contains a circular object graph — cannot enforce strict mode");
	}
	try {
		const cached = cache.get(schema);
		if (cached) return cached;
		const result = { ...schema };
		cache.set(schema, result);
		return enforceStrictSchemaBody(schema, result, cache);
	} finally {
		exit(schema);
	}
}

function enforceStrictSchemaBody(
	_schema: Record<string, unknown>,
	result: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set<string>(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties: Record<string, unknown> = {};
		for (const key in props) {
			const value = props[key];
			const processed =
				value != null && typeof value === "object" && !Array.isArray(value)
					? enforceStrictSchema(value as Record<string, unknown>, cache)
					: value;
			// Optional property — wrap as nullable so strict mode accepts it
			if (!originalRequired.has(key)) {
				// Don't double-wrap if already nullable
				if (
					isJsonObject(processed) &&
					Array.isArray(processed.anyOf) &&
					processed.anyOf.some(v => isJsonObject(v) && v.type === "null")
				) {
					strictProperties[key] = processed;
					continue;
				}
				if (isPureAnyOfNode(processed)) {
					strictProperties[key] = { ...processed, anyOf: [...processed.anyOf, { type: "null" }] };
					continue;
				}
				if (isJsonObject(processed) && typeof processed.description === "string") {
					const { description, ...withoutDescription } = processed;
					strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
					continue;
				}
				strictProperties[key] = { anyOf: [processed, { type: "null" }] };
				continue;
			}
			strictProperties[key] = processed;
		}
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
		}
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(entry =>
			entry != null && typeof entry === "object" && !Array.isArray(entry)
				? enforceStrictSchema(entry as Record<string, unknown>, cache)
				: entry,
		);
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		}
	}
	// Splice nested pure unions into the parent `anyOf`: `(A ∨ B) ∨ C` ≡ `A ∨ B ∨ C`.
	// Some strict-mode validators (e.g. DeepSeek behind OpenRouter) reject anyOf
	// branches that carry no `type`, which is exactly what a nested combinator
	// node looks like (#2270). Branch recursion above already flattened deeper
	// levels bottom-up, so a single pass suffices.
	if (Array.isArray(result.anyOf) && result.anyOf.some(isPureAnyOfNode)) {
		const flattened: unknown[] = [];
		for (const branch of result.anyOf) {
			if (!isPureAnyOfNode(branch)) {
				flattened.push(branch);
				continue;
			}
			flattened.push(...branch.anyOf);
			// Keep the inner annotation when the parent has none.
			if (typeof branch.description === "string" && result.description === undefined) {
				result.description = branch.description;
			}
		}
		result.anyOf = flattened;
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			const nextDefs: Record<string, unknown> = {};
			for (const name in defs) {
				const def = defs[name];
				nextDefs[name] =
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, cache)
						: def;
			}
			result[defsKey] = nextDefs;
		}
	}
	// Strict mode requires every schema node to declare a concrete type (or
	// combinator / `$ref` / `not`). When `type` is missing, try to infer it
	// from a homogeneous-primitive `enum` / `const` so direct calls to
	// `enforceStrictSchema` (which bypass `sanitizeSchemaForStrictMode`'s own
	// inference pass) still produce wire-valid output.
	if (result.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(result);
		if (inferred !== undefined) result.type = inferred;
	}
	// Schemas like `{}`, `{items: {}}`, mixed-primitive enums, and non-primitive
	// consts are not representable in strict mode — `enum`/`const` are not
	// accepted as type substitutes here because they did not yield a single
	// inferable type above.
	if (
		result.type === undefined &&
		result.$ref === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isJsonObject(result.not)
	) {
		throw new AIError.ValidationError("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict: boolean;
} {
	return stamp(schema, kStrictSchema, s => {
		const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
		if (hasUnrepresentableStrictObjectMap(upgraded)) {
			return { schema: upgraded, strict: false };
		}
		try {
			const sanitized = sanitizeSchemaForStrictMode(upgraded);
			return { schema: enforceStrictSchema(sanitized), strict: true };
		} catch {
			return { schema: upgraded, strict: false };
		}
	});
}

/**
 * Resolve a JSON-pointer-style `$ref` against the root schema. Mirrors the
 * OpenAI SDK's `resolve_ref` helper: only local refs starting with `#/` are
 * supported, and each segment must dereference to a dictionary.
 * Cite: openai-python/src/openai/lib/_pydantic.py:118-129
 */
function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	if (!ref.startsWith("#/")) return undefined;
	const segments = ref.slice(2).split("/");
	let cursor: unknown = root;
	for (const raw of segments) {
		if (!isJsonObject(cursor)) return undefined;
		// JSON Pointer unescape: ~1 → "/", ~0 → "~" (must run in that order).
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		cursor = cursor[segment];
	}
	return isJsonObject(cursor) ? cursor : undefined;
}
