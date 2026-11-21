/**
 * Factory Gemini accepts a restricted Schema shape. Keep this projection
 * separate from shared normalizers, which preserve unsupported keywords in
 * description text instead of dropping them.
 */
import { isJsonObject, type JsonObject } from "./types";

/** Schema keywords the CLI copies through verbatim. */
const FACTORY_DROID_ALLOWED_KEYS: Record<string, true> = {
	type: true,
	title: true,
	description: true,
	required: true,
	format: true,
	minimum: true,
	maximum: true,
	minLength: true,
	maxLength: true,
	pattern: true,
	minItems: true,
	maxItems: true,
	default: true,
	example: true,
};

function stringifySchemaValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** True when the node's `type` (string or array form) includes "null". */
function typeIncludesNull(node: JsonObject): boolean {
	if (node.type === "null") return true;
	return Array.isArray(node.type) && (node.type as unknown[]).includes("null");
}

/**
 * How `required` combines when two schemas merge: `"union"` for conjunctions
 * (`allOf`, a parent absorbing its collapsed union) where every side's
 * constraints hold; `"intersection"` for alternatives (`anyOf`/`oneOf`
 * branches), where a field is only guaranteed when every branch requires it.
 */
type RequiredMerge = "union" | "intersection";

function dedupe(values: unknown[]): unknown[] {
	return values.filter((entry, index, array) => array.indexOf(entry) === index);
}

/** Bound keywords whose conjunction keeps the stricter value. */
const STRICTER_BOUND: Record<string, (a: number, b: number) => number> = {
	minimum: Math.max,
	minLength: Math.max,
	minItems: Math.max,
	maximum: Math.min,
	maxLength: Math.min,
	maxItems: Math.min,
};

function mergeFactoryDroidSchemas(left: JsonObject, right: JsonObject, requiredMerge: RequiredMerge): JsonObject {
	const merged: JsonObject = { ...left };
	for (const [key, value] of Object.entries(right)) {
		if (key === "properties") {
			const leftProperties = isJsonObject(merged.properties) ? (merged.properties as JsonObject) : {};
			const rightProperties = isJsonObject(value) ? value : {};
			const properties: JsonObject = { ...leftProperties };
			for (const [name, schema] of Object.entries(rightProperties)) {
				if (isJsonObject(leftProperties[name]) && isJsonObject(schema)) {
					properties[name] = mergeFactoryDroidSchemas(leftProperties[name] as JsonObject, schema, requiredMerge);
				} else {
					properties[name] = schema;
				}
			}
			merged.properties = properties;
		} else if (key === "required") {
			// Combined below: intersection must also see a missing right-hand `required`.
		} else if (requiredMerge === "union" && key in STRICTER_BOUND && typeof value === "number") {
			// Conjunctions keep the tighter of two bounds.
			const current = merged[key];
			merged[key] = typeof current === "number" ? STRICTER_BOUND[key](current, value) : value;
		} else if (key === "enum" && Array.isArray(left.enum) && Array.isArray(value)) {
			merged.enum = dedupe([...(left.enum as unknown[]), ...(value as unknown[])]);
		} else if (requiredMerge === "union" && key === "anyOf" && Array.isArray(merged.anyOf) && Array.isArray(value)) {
			// Two retained unions in one conjunction: keep every pairing of compatible
			// branches instead of dropping the right-hand constraint.
			const pairs = intersectUnionBranches(merged.anyOf as JsonObject[], value as JsonObject[]);
			if (pairs.length > 0) merged.anyOf = pairs;
		} else if (!(key in merged)) {
			merged[key] = value;
		}
	}

	const leftRequired = Array.isArray(left.required) ? (left.required as unknown[]) : [];
	const rightRequired = Array.isArray(right.required) ? (right.required as unknown[]) : [];
	if (requiredMerge === "union") {
		if (Array.isArray(left.required) || Array.isArray(right.required)) {
			merged.required = dedupe([...leftRequired, ...rightRequired]);
		}
	} else {
		const shared = dedupe(leftRequired.filter(entry => rightRequired.includes(entry)));
		if (shared.length > 0) merged.required = shared;
		else delete merged.required;
	}
	return merged;
}

/** Branch-wise conjunction of two unions: each same-typed (or untyped) pair merged, enums intersected. */
function intersectUnionBranches(left: JsonObject[], right: JsonObject[]): JsonObject[] {
	const pairs: JsonObject[] = [];
	for (const a of left) {
		for (const b of right) {
			if (a.type !== undefined && b.type !== undefined && a.type !== b.type) continue;
			const pair = mergeFactoryDroidSchemas(a, b, "union");
			if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
				// The merge unions enums; a conjunction admits only values both allow.
				const allowed = (a.enum as unknown[]).filter(value => (b.enum as unknown[]).includes(value));
				if (allowed.length === 0) continue;
				pair.enum = allowed;
			}
			pairs.push(pair);
		}
	}
	return pairs;
}

/** Fields the proxy accepts beside `anyOf`; anything else there is a 400. */
const ANY_OF_SIBLING_KEYS: Record<string, true> = {
	title: true,
	description: true,
	default: true,
	example: true,
};

/** The proxy 400s on `required` names a schema's own `properties` lacks. */
function withoutUndefinedRequired(branch: JsonObject): JsonObject {
	if (!Array.isArray(branch.required)) return branch;
	const properties = isJsonObject(branch.properties) ? branch.properties : {};
	const required = (branch.required as unknown[]).filter(
		name => typeof name === "string" && Object.hasOwn(properties, name),
	);
	const { required: _dropped, ...rest } = branch;
	return required.length > 0 ? { ...rest, required } : rest;
}

function settleUnion(out: JsonObject, branches: JsonObject[], nullable: boolean): void {
	let nonNull = branches;
	const mixedTypes =
		nonNull.every(branch => typeof branch.type === "string") && new Set(nonNull.map(branch => branch.type)).size > 1;
	if (mixedTypes && Object.keys(out).every(key => key in ANY_OF_SIBLING_KEYS)) {
		out.anyOf = nonNull.map(withoutUndefinedRequired);
		if (nullable) out.nullable = true;
		return;
	}
	if (mixedTypes) {
		// `anyOf` must be the only structural field, and branches of
		// different types never merge into one Schema: keep only the
		// branches of the node's own type (none if no branch has it),
		// else of the first branch's type.
		const ownType = Array.isArray(out.type)
			? (out.type as unknown[]).find(t => typeof t === "string" && t !== "null")
			: (out.type ?? (isJsonObject(out.properties) ? "object" : undefined));
		const kept = ownType ?? nonNull[0].type;
		nonNull = nonNull.filter(branch => branch.type === kept);
	} else if (typeof out.type === "string") {
		// An untyped branch keeps the union from counting as mixed, but a typed branch of another type
		// still must not lend its fields (`items` on a string) to this node.
		const compatible = nonNull.filter(branch => branch.type === undefined || branch.type === out.type);
		if (compatible.length > 0) nonNull = compatible;
	}
	let collapsed: JsonObject | undefined;
	for (const branch of nonNull) {
		collapsed = collapsed ? mergeFactoryDroidSchemas(collapsed, branch, "intersection") : { ...branch };
	}
	if (collapsed) {
		collapsed.nullable = nullable;
		Object.assign(out, mergeFactoryDroidSchemas(out, collapsed, "union"));
		// A pattern cannot be conjoined into one regex the proxy accepts; the union's own,
		// narrower one wins over one an `allOf` merged in first.
		if (typeof collapsed.pattern === "string") out.pattern = collapsed.pattern;
		// Narrowing can drop the branch that defined a required property.
		if (mixedTypes && Array.isArray(out.required)) {
			const kept = withoutUndefinedRequired(out);
			if (kept.required) out.required = kept.required;
			else delete out.required;
		}
	}
}

function copyFactoryDroidSchema(node: unknown): JsonObject | undefined {
	if (!isJsonObject(node)) return undefined;

	const out: JsonObject = {};
	for (const key of Object.keys(FACTORY_DROID_ALLOWED_KEYS)) {
		if (key in node) out[key] = node[key];
	}
	if ("const" in node) out.enum = [stringifySchemaValue(node.const)];
	if (Array.isArray(node.enum)) out.enum = node.enum.map(stringifySchemaValue);

	if (isJsonObject(node.properties)) {
		const properties: JsonObject = {};
		for (const [name, schema] of Object.entries(node.properties)) {
			const copied = copyFactoryDroidSchema(schema);
			if (copied !== undefined) properties[name] = copied;
		}
		out.properties = properties;
	}
	if (isJsonObject(node.items)) {
		const copied = copyFactoryDroidSchema(node.items);
		if (copied !== undefined) out.items = copied;
	}

	// allOf: merge every branch into this node's own copy first, so the union
	// handling below sees every field that will sit beside it.
	if (Array.isArray(node.allOf)) {
		for (const branch of node.allOf) {
			const copied = copyFactoryDroidSchema(branch);
			if (copied) Object.assign(out, mergeFactoryDroidSchemas(out, copied, "union"));
		}
	}

	// anyOf/oneOf unions: merge the non-null branches (a field stays required
	// only when every branch requires it), marking the result nullable when a
	// `type: "null"` branch is present, then fold that into this node so its
	// own properties/required survive. Typed branches of different types cannot
	// merge into one Schema (`string` gaining `items` is a 400), so they stay an
	// `anyOf` when the node has nothing else the proxy forbids beside it.
	const unionKey = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
	if (unionKey) {
		const branches = (node[unionKey] as unknown[])
			.map(copyFactoryDroidSchema)
			.filter((branch): branch is JsonObject => branch !== undefined);
		const nonNull = branches.filter(branch => !typeIncludesNull(branch));
		settleUnion(out, nonNull, nonNull.length < branches.length);
	}

	// The Schema proto takes a single string `type`: collapse draft-2020-12
	// type unions the way the shared normalizer does — a null branch becomes
	// `nullable: true`, the first non-null type wins.
	if (Array.isArray(out.type)) {
		const types = (out.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null")) out.nullable = true;
		out.type = nonNull[0] ?? types[0];
	}
	// The proxy's Schema proto requires a type; infer one when the source
	// omitted it, the same way the CLI's copier does.
	if (!("type" in out)) {
		if (isJsonObject(out.properties)) out.type = "object";
		else if ("items" in out) out.type = "array";
		else if ("enum" in out) out.type = "string";
	}
	return out;
}

/**
 * A kept `anyOf` can gain structural siblings when an enclosing `allOf`
 * merges into it (at any depth); settle those against the merged node.
 */
function settleMergedUnions(node: JsonObject): void {
	if (isJsonObject(node.properties)) {
		for (const schema of Object.values(node.properties)) {
			if (isJsonObject(schema)) settleMergedUnions(schema);
		}
	}
	if (isJsonObject(node.items)) settleMergedUnions(node.items);
	if (!Array.isArray(node.anyOf)) return;
	for (const branch of node.anyOf) {
		if (isJsonObject(branch)) settleMergedUnions(branch);
	}
	// A union left with one branch (an allOf intersection) is that branch.
	const single = node.anyOf.length === 1;
	const { anyOf, nullable, ...rest } = node;
	if (!single && Object.keys(rest).every(key => key in ANY_OF_SIBLING_KEYS)) return;
	delete node.anyOf;
	delete node.nullable;
	settleUnion(node, anyOf as JsonObject[], nullable === true);
	if (!("type" in node) && isJsonObject(node.properties)) node.type = "object";
	// The collapse merges branches, which can leave new unions beside fields.
	settleMergedUnions(node);
}

/** Project a dereferenced JSON Schema onto Factory Gemini's allowed fields. */
export function normalizeSchemaForFactoryDroid(value: unknown): unknown {
	if (!isJsonObject(value)) return value;
	const out = copyFactoryDroidSchema(value) ?? {};
	settleMergedUnions(out);
	return out;
}
