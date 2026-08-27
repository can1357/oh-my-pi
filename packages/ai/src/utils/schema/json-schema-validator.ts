/**
 * In-tree JSON Schema validator.
 *
 * Used by `validation.ts` for tools authored as plain JSON Schema (no Zod
 * runtime). Covers the keyword set tool authors actually rely on — type,
 * enum, const, combinators, if/then/else, object/array/string/number
 * constraints, $ref, prefixItems/items, contains, propertyNames, pattern &
 * dependent* — but treats `unevaluatedProperties` / `unevaluatedItems` as
 * permissive (with a one-shot warning) since those require evaluation
 * tracking we do not implement.
 *
 * Compared to AJV this is single-pass, synchronous, dependency-free, and
 * tolerates non-standard shapes (`nullable`) that LLM-emitted schemas carry.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { areJsonValuesEqual } from "./equality";

export interface JsonSchemaValidationIssue {
	path: PropertyKey[];
	message: string;
	expectedTypes?: string[];
	keyword?: string;
	/**
	 * Marks issues surfaced from a failed `anyOf` / `oneOf` branch (at any
	 * depth). Such a diagnosis is one candidate branch's guess, not
	 * authoritative: the tool-argument coercion layer keeps lossy repairs
	 * (container stringification, unrecognized-key deletion, singleton-array
	 * wrapping) off for these while still applying lossless ones.
	 */
	fromUnionBranch?: boolean;
}

export interface JsonSchemaValidationResult {
	success: boolean;
	issues: JsonSchemaValidationIssue[];
}

/**
 * Cycle bookkeeping for recursive `$ref` schemas. We track pairs of (resolved
 * ref, value identity) rather than refs alone: returning `true` for every
 * nested occurrence of a ref previously allowed recursive schemas to silently
 * validate values they should have rejected. For primitive values we fall back
 * to a depth counter capped at MAX_REF_DEPTH so a self-referential schema can
 * still bottom out without infinite recursion.
 */
interface ValidationContext {
	root: unknown;
	seenPairs: Set<string>;
	objectIds: WeakMap<object, number>;
	nextObjectId: { value: number };
	refDepth: number;
}

const MAX_REF_DEPTH = 64;

/** Module-level guard so the unevaluatedItems/unevaluatedProperties warning fires once per process. */
let seenUnevaluatedWarning = false;

function getValueIdentity(ctx: ValidationContext, value: object): number {
	let id = ctx.objectIds.get(value);
	if (id !== undefined) return id;
	id = ctx.nextObjectId.value;
	ctx.nextObjectId.value += 1;
	ctx.objectIds.set(value, id);
	return id;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Whether `value` matches every `const`/`enum` discriminator property the
 * branch declares (with at least one such property present and matching).
 * A uniquely tag-selected branch's validation issues are authoritative — the
 * model named its intended variant — so the coercion layer may apply lossy
 * repairs to them; without a unique tag, branch issues are guesses.
 */
function isTagSelectedBranch(branch: unknown, value: unknown): boolean {
	if (!isJsonObject(branch) || !isJsonObject(value)) return false;
	const props = branch.properties;
	if (!isJsonObject(props)) return false;
	let matched = false;
	for (const key in props) {
		const propSchema = props[key];
		if (!isJsonObject(propSchema)) continue;
		const hasConst = Object.hasOwn(propSchema, "const");
		const enumValues = Array.isArray(propSchema.enum) ? propSchema.enum : undefined;
		if (!hasConst && !enumValues) continue;
		if (!Object.hasOwn(value, key)) return false;
		const candidate = value[key];
		if (hasConst) {
			if (!areJsonValuesEqual(candidate, propSchema.const)) return false;
		} else if (enumValues && !enumValues.some(entry => areJsonValuesEqual(entry, candidate))) {
			return false;
		}
		matched = true;
	}
	return matched;
}

function pushIssue(
	issues: JsonSchemaValidationIssue[],
	path: readonly PropertyKey[],
	message: string,
	options: { expectedTypes?: string[]; keyword?: string } = {},
): void {
	issues.push({ path: [...path], message, ...options });
}

function typeOfJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

/** Push a validation issue with a copied path so later mutations to `path` do not corrupt earlier issues. */

function matchesJsonSchemaType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isJsonObject(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return false;
	}
}

/** Decide whether `value` satisfies a single JSON-Schema `type` keyword string. `integer` is a refinement of `number`. */

function schemaTypes(schema: Record<string, unknown>): string[] {
	const raw = schema.type;
	const types =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: [];
	if (schema.nullable === true && !types.includes("null")) {
		return [...types, "null"];
	}
	return types;
}

/** Extract the effective `type` list from a schema, treating `nullable: true` as adding `"null"`. */

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** RFC 6901 token decode: `~1` → `/`, `~0` → `~`. */

function resolveLocalRef(root: unknown, ref: string): unknown | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawToken of ref.slice(2).split("/")) {
		const token = decodePointerToken(rawToken);
		if (!isJsonObject(current) && !Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

/** Resolve a `#/path/to/node` pointer against the root schema. Returns `undefined` for external/unsupported refs. */

function isRequiredSet(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/** Narrow `required: unknown` to `required: string[]` — the spec allows it to be missing but rejects non-string entries. */

/**
 * Core validator. Walks a schema node, applies every applicable keyword to
 * `value`, and accumulates issues. Returns `true` only if no keyword
 * rejected; combinators may add issues but still return true (e.g. `anyOf`
 * succeeds if at least one branch matches).
 */
function validateSchemaNode(
	schema: unknown,
	value: unknown,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	if (schema === true) return true;
	if (schema === false) {
		pushIssue(issues, path, "must not match false schema", { keyword: "false" });
		return false;
	}
	if (!isJsonObject(schema)) {
		pushIssue(issues, path, "schema must be an object or boolean", { keyword: "schema" });
		return false;
	}

	const ref = schema.$ref;
	if (typeof ref === "string") {
		const resolved = resolveLocalRef(ctx.root, ref);
		if (resolved === undefined) {
			pushIssue(issues, path, `unresolved reference ${ref}`, { keyword: "$ref" });
			return false;
		}
		// Cycle detection: for object/array values we key on (ref, value-identity)
		// so the same schema applied to a different value still recurses; only an
		// exact (schema, value) repeat short-circuits as a true cycle. For
		// primitives we fall back to a depth counter so self-referential schemas
		// without a base case still terminate.
		let pairKey: string | undefined;
		if (value !== null && typeof value === "object") {
			pairKey = `${ref}:${getValueIdentity(ctx, value)}`;
			if (ctx.seenPairs.has(pairKey)) return true;
			ctx.seenPairs.add(pairKey);
		} else {
			if (ctx.refDepth >= MAX_REF_DEPTH) {
				pushIssue(issues, path, "reference depth exceeded", { keyword: "$ref" });
				return false;
			}
			ctx.refDepth += 1;
		}
		const ok = validateSchemaNode(resolved, value, path, ctx, issues);
		if (pairKey !== undefined) ctx.seenPairs.delete(pairKey);
		else ctx.refDepth -= 1;
		return ok;
	}

	if (value === null && schema.nullable === true) return true;

	let valid = true;
	const types = schemaTypes(schema);
	if (types.length > 0 && !types.some(type => matchesJsonSchemaType(value, type))) {
		pushIssue(issues, path, `expected ${types.join(" or ")}, received ${typeOfJsonValue(value)}`, {
			keyword: "type",
			expectedTypes: types,
		});
		return false;
	}

	if ("const" in schema && !areJsonValuesEqual(value, schema.const)) {
		pushIssue(issues, path, "must equal const value", { keyword: "const" });
		valid = false;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some(entry => areJsonValuesEqual(entry, value))) {
		pushIssue(issues, path, "must be one of the allowed enum values", { keyword: "enum" });
		valid = false;
	}

	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (keyword === "allOf") {
			for (const branch of branches) {
				valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
			}
			continue;
		}

		let matches = 0;
		let firstIssues: JsonSchemaValidationIssue[] | undefined;
		let selectedIssues: JsonSchemaValidationIssue[] | undefined;
		let selectedCount = 0;
		for (const branch of branches) {
			const branchIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(branch, value, path, ctx, branchIssues)) {
				matches += 1;
				continue;
			}
			if (!firstIssues) firstIssues = branchIssues;
			if (isTagSelectedBranch(branch, value)) {
				selectedCount += 1;
				if (selectedCount === 1) selectedIssues = branchIssues;
			}
		}
		const branchValid = keyword === "anyOf" ? matches > 0 : matches === 1;
		if (!branchValid) {
			if (matches === 0 && selectedCount === 1 && selectedIssues && selectedIssues.length > 0) {
				// A const/enum discriminator uniquely identifies the intended
				// variant, so its diagnosis is authoritative: surface untagged and
				// keep every repair (including lossy ones) available.
				issues.push(...selectedIssues);
			} else if (matches === 0 && firstIssues && firstIssues.length > 0) {
				// No variant matched and no tag picks one: everything reported is
				// the first failing branch's guess — another variant may accept the
				// value as-is. Surface all issues (deep ones remain individually
				// repairable by lossless coercions) but mark their provenance so
				// lossy repairs (stringify, key deletion, singleton wrap) stay off.
				for (const branchIssue of firstIssues) {
					issues.push(branchIssue.fromUnionBranch ? branchIssue : { ...branchIssue, fromUnionBranch: true });
				}
			} else {
				pushIssue(
					issues,
					path,
					keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema",
					{
						keyword,
					},
				);
			}
			valid = false;
		}
	}

	if ("not" in schema) {
		const notIssues: JsonSchemaValidationIssue[] = [];
		if (validateSchemaNode(schema.not, value, path, ctx, notIssues)) {
			pushIssue(issues, path, "must not match excluded schema", { keyword: "not" });
			valid = false;
		}
	}

	// if/then/else: validate the if-branch silently; based on its outcome,
	// validate against then/else. Each sub-schema is treated as a schema node
	// (no requirement that branches be objects). This is a minimal correct
	// semantic — schemas where the if-branch references properties only present
	// after applying then will still resolve consistently for the LLM-emitted
	// shapes we encounter.
	if ("if" in schema) {
		const ifIssues: JsonSchemaValidationIssue[] = [];
		const ifOk = validateSchemaNode(schema.if, value, path, ctx, ifIssues);
		const branch = ifOk ? schema.then : schema.else;
		if (branch !== undefined) {
			valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
		}
	}

	// `unevaluatedProperties` / `unevaluatedItems` require tracking which
	// keys/indices were "evaluated" by sibling keywords across composed
	// schemas — expensive bookkeeping we do not implement. Warn once so tool
	// authors who rely on them know the keyword is silently permissive in
	// this validator.
	if (("unevaluatedProperties" in schema || "unevaluatedItems" in schema) && !seenUnevaluatedWarning) {
		seenUnevaluatedWarning = true;
		logger.warn(
			"JSON Schema unevaluatedProperties/unevaluatedItems are not enforced by the in-tree validator; treating as permissive",
		);
	}

	if (isJsonObject(value)) {
		valid = validateObjectKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (Array.isArray(value)) {
		valid = validateArrayKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (typeof value === "string") {
		valid = validateStringKeywords(schema, value, path, issues) && valid;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		valid = validateNumberKeywords(schema, value, path, issues) && valid;
	}

	return valid;
}

/** Apply object-shaped JSON-Schema keywords: `required`, `properties`, `propertyNames`, `patternProperties`, `dependentRequired`, `dependentSchemas`, `additionalProperties`, and the `min/maxProperties` counts. */
function validateObjectKeywords(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	const properties = isJsonObject(schema.properties) ? schema.properties : {};
	if (isRequiredSet(schema.required)) {
		for (const key of schema.required) {
			if (!(key in value)) {
				pushIssue(issues, [...path, key], "is required", { keyword: "required" });
				valid = false;
			}
		}
	}

	for (const key in properties) {
		if (!(key in value)) continue;
		valid = validateSchemaNode(properties[key], value[key], [...path, key], ctx, issues) && valid;
	}

	if (schema.propertyNames !== undefined) {
		for (const key of Object.keys(value)) {
			valid = validateSchemaNode(schema.propertyNames, key, [...path, key], ctx, issues) && valid;
		}
	}

	const known = new Set(Object.keys(properties));
	if (isJsonObject(schema.patternProperties)) {
		const patternProperties = schema.patternProperties;
		for (const pattern in patternProperties) {
			const patternSchema = patternProperties[pattern];
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch {
				pushIssue(issues, path, `invalid patternProperties regex ${pattern}`, { keyword: "patternProperties" });
				valid = false;
				continue;
			}
			for (const key in value) {
				if (!re.test(key)) continue;
				known.add(key);
				valid = validateSchemaNode(patternSchema, value[key], [...path, key], ctx, issues) && valid;
			}
		}
	}

	if (isJsonObject(schema.dependentRequired)) {
		const dependentRequired = schema.dependentRequired;
		for (const key in dependentRequired) {
			const deps = dependentRequired[key];
			if (!(key in value)) continue;
			if (!Array.isArray(deps)) continue;
			for (const dep of deps) {
				if (typeof dep !== "string") continue;
				if (!(dep in value)) {
					pushIssue(issues, [...path, dep], `is required when "${key}" is present`, {
						keyword: "dependentRequired",
					});
					valid = false;
				}
			}
		}
	}

	if (isJsonObject(schema.dependentSchemas)) {
		const dependentSchemas = schema.dependentSchemas;
		for (const key in dependentSchemas) {
			if (!(key in value)) continue;
			valid = validateSchemaNode(dependentSchemas[key], value, path, ctx, issues) && valid;
		}
	}

	// `known` includes property names and any keys matched by patternProperties
	// above, so additionalProperties only governs the genuine leftovers.
	const additional = schema.additionalProperties;
	if (additional === false) {
		for (const key of Object.keys(value)) {
			if (known.has(key)) continue;
			pushIssue(issues, [...path, key], "must not be present", { keyword: "additionalProperties" });
			valid = false;
		}
	} else if (additional !== undefined && additional !== true) {
		for (const key in value) {
			if (known.has(key)) continue;
			valid = validateSchemaNode(additional, value[key], [...path, key], ctx, issues) && valid;
		}
	}

	if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
		pushIssue(issues, path, `must have at least ${schema.minProperties} properties`, { keyword: "minProperties" });
		valid = false;
	}
	if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
		pushIssue(issues, path, `must have at most ${schema.maxProperties} properties`, { keyword: "maxProperties" });
		valid = false;
	}

	return valid;
}

/** Apply array-shaped keywords: `min/maxItems`, `uniqueItems`, `prefixItems` + `items` tuple validation, and `contains` with `min/maxContains`. */
function validateArrayKeywords(
	schema: Record<string, unknown>,
	value: unknown[],
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		pushIssue(issues, path, `must have at least ${schema.minItems} items`, { keyword: "minItems" });
		valid = false;
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		pushIssue(issues, path, `must have at most ${schema.maxItems} items`, { keyword: "maxItems" });
		valid = false;
	}
	if (schema.uniqueItems === true) {
		for (let i = 0; i < value.length; i += 1) {
			for (let j = i + 1; j < value.length; j += 1) {
				if (!areJsonValuesEqual(value[i], value[j])) continue;
				pushIssue(issues, [...path, j], "must be unique", { keyword: "uniqueItems" });
				valid = false;
			}
		}
	}

	// Tuple validation uses JSON Schema 2020-12 `prefixItems` for per-index
	// schemas. When present, `items` is the schema for every remaining element.
	const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
	const items = schema.items;
	if (Array.isArray(items)) {
		pushIssue(issues, path, "array-valued items is not valid in JSON Schema 2020-12; use prefixItems", {
			keyword: "items",
		});
		valid = false;
	} else if (prefixItems) {
		const limit = Math.min(prefixItems.length, value.length);
		for (let i = 0; i < limit; i += 1) {
			valid = validateSchemaNode(prefixItems[i], value[i], [...path, i], ctx, issues) && valid;
		}
		if (items !== undefined) {
			for (let i = prefixItems.length; i < value.length; i += 1) {
				valid = validateSchemaNode(items, value[i], [...path, i], ctx, issues) && valid;
			}
		}
	} else if (items !== undefined) {
		for (let i = 0; i < value.length; i += 1) {
			valid = validateSchemaNode(items, value[i], [...path, i], ctx, issues) && valid;
		}
	}

	if (schema.contains !== undefined) {
		const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
		const maxContains = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
		let count = 0;
		for (let i = 0; i < value.length; i += 1) {
			const containsIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(schema.contains, value[i], [...path, i], ctx, containsIssues)) {
				count += 1;
			}
		}
		if (count < minContains) {
			pushIssue(issues, path, `must contain at least ${minContains} matching item(s)`, { keyword: "contains" });
			valid = false;
		}
		if (count > maxContains) {
			pushIssue(issues, path, `must contain at most ${maxContains} matching item(s)`, { keyword: "maxContains" });
			valid = false;
		}
	}

	return valid;
}

/** Apply string-shaped keywords: `min/maxLength`, `pattern`. Invalid regexes flag the schema itself rather than the value. */
function validateStringKeywords(
	schema: Record<string, unknown>,
	value: string,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minLength === "number" && value.length < schema.minLength) {
		pushIssue(issues, path, `must be at least ${schema.minLength} characters`, { keyword: "minLength" });
		valid = false;
	}
	if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		pushIssue(issues, path, `must be at most ${schema.maxLength} characters`, { keyword: "maxLength" });
		valid = false;
	}
	if (typeof schema.pattern === "string") {
		try {
			if (!new RegExp(schema.pattern).test(value)) {
				pushIssue(issues, path, "must match pattern", { keyword: "pattern" });
				valid = false;
			}
		} catch {
			pushIssue(issues, path, "schema pattern is invalid", { keyword: "pattern" });
			valid = false;
		}
	}
	return valid;
}

/** Apply number-shaped keywords: `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum` (both numeric draft 2020-12 and boolean draft-07 forms), and `multipleOf`. */
function validateNumberKeywords(
	schema: Record<string, unknown>,
	value: number,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		pushIssue(issues, path, `must be >= ${schema.minimum}`, { keyword: "minimum" });
		valid = false;
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		pushIssue(issues, path, `must be <= ${schema.maximum}`, { keyword: "maximum" });
		valid = false;
	}
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		pushIssue(issues, path, `must be > ${schema.exclusiveMinimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		pushIssue(issues, path, `must be < ${schema.exclusiveMaximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
		pushIssue(issues, path, `must be > ${schema.minimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
		pushIssue(issues, path, `must be < ${schema.maximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
		const quotient = value / schema.multipleOf;
		if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
			pushIssue(issues, path, `must be a multiple of ${schema.multipleOf}`, { keyword: "multipleOf" });
			valid = false;
		}
	}
	return valid;
}

export function validateJsonSchemaValue(schema: unknown, value: unknown): JsonSchemaValidationResult {
	const issues: JsonSchemaValidationIssue[] = [];
	const success = validateSchemaNode(
		schema,
		value,
		[],
		{ root: schema, seenPairs: new Set(), objectIds: new WeakMap(), nextObjectId: { value: 0 }, refDepth: 0 },
		issues,
	);
	return { success, issues };
}

export function isJsonSchemaValueValid(schema: unknown, value: unknown): boolean {
	return validateJsonSchemaValue(schema, value).success;
}
