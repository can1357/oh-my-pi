/**
 * Planner: lowers JSON Schema documents into a draft-independent {@link Plan}
 * graph that both validator backends consume.
 *
 * Planning applies everything that does not depend on the instance: dialect
 * differences (draft 7 `$ref` overriding its siblings, array-form `items`
 * with `additionalItems`, `dependencies`), vocabularies, `$ref` resolution,
 * and `$dynamicRef` resolution. The dynamic scope only matters through the
 * outermost resource declaring each `$dynamicAnchor` name, so plans are
 * memoized per (schema, scope) and recursion stays finite.
 */
import { OmpTypeError } from "../errors";
import {
	type Location,
	type Registry,
	type Resource,
	VOCAB_APPLICATOR,
	VOCAB_UNEVALUATED,
	VOCAB_VALIDATION,
} from "./resolve";
import { compilePattern, isInheritedName } from "./runtime";

/** Boolean check for one `format` name; returning false rejects the string. */
export type FormatCheck = (value: string) => boolean;

export const T_NULL = 1;
export const T_BOOLEAN = 2;
export const T_INTEGER = 4;
/** Any finite number, integers included. */
export const T_NUMBER = 8;
export const T_STRING = 16;
export const T_ARRAY = 32;
export const T_OBJECT = 64;
export const T_ANY = 127;
/** Every number type: `type: "number"`. */
export const T_NUMERIC = T_NUMBER | T_INTEGER;

/** The single JSON kind a passing value of `types` has, as a mask; 0 when several. */
export function kindOf(types: number): number {
	if (types === 0) return 0;
	if ((types & T_NUMERIC) === types) return types;
	return (types & (types - 1)) === 0 ? types : 0;
}

const TYPE_FLAGS: Record<string, number> = {
	null: T_NULL,
	boolean: T_BOOLEAN,
	integer: T_INTEGER,
	number: T_NUMERIC,
	string: T_STRING,
	array: T_ARRAY,
	object: T_OBJECT,
};

/** A `properties`/`dependentSchemas` entry. */
export interface KeyPlan {
	readonly key: string;
	readonly plan: Plan;
	/** `key` is inherited by plain objects (`constructor`, `__proto__`, ...): reads need an own check. */
	readonly inherited: boolean;
}

/** A `patternProperties` entry. */
export interface PatternPlan {
	readonly pattern: RegExp;
	readonly plan: Plan;
}

/** A `dependentRequired` entry. */
export interface DependentRequired {
	readonly key: string;
	readonly required: readonly string[];
}

/** A property `default` declared under `properties`. */
export interface PropertyDefault {
	readonly key: string;
	readonly value: unknown;
}

/**
 * Normalized keywords of one schema location in one dynamic scope. Absent
 * fields impose nothing; type-specific keywords only constrain values of
 * their type.
 */
export interface Plan {
	/** Accepted JSON types as `T_*` flags; `T_ANY` when unconstrained, 0 for `false`. */
	types: number;
	/** No keyword constrains the value (`true`, `{}`, annotation-only schemas). */
	empty: boolean;
	/** `F_*` keyword groups present; 0 when `type` is the only constraint. */
	flags: number;
	/** `$ref` and resolved `$dynamicRef` targets, applied in place. */
	refs?: Plan[];
	hasConst?: boolean;
	constValue?: unknown;
	enumValues?: readonly unknown[];
	multipleOf?: number;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
	formatName?: string;
	format?: FormatCheck;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	prefixItems?: Plan[];
	/** Schema for elements after `prefixItems` (or every element). */
	items?: Plan;
	contains?: Plan;
	minContains?: number;
	maxContains?: number;
	unevaluatedItems?: Plan;
	minProperties?: number;
	maxProperties?: number;
	required?: string[];
	properties?: KeyPlan[];
	patternProperties?: PatternPlan[];
	additionalProperties?: Plan;
	propertyNames?: Plan;
	dependentRequired?: DependentRequired[];
	dependentSchemas?: KeyPlan[];
	unevaluatedProperties?: Plan;
	allOf?: Plan[];
	anyOf?: Plan[];
	oneOf?: Plan[];
	not?: Plan;
	if?: Plan;
	/** `then`, applied when `if` passes. */
	ifThen?: Plan;
	/** `else`, applied when `if` fails. */
	ifElse?: Plan;
	defaults?: PropertyDefault[];
}

/** The `true` schema. */
export const TRUE_PLAN: Plan = { types: T_ANY, empty: true, flags: 0 };
/** The `false` schema. */
export const FALSE_PLAN: Plan = { types: 0, empty: false, flags: 0 };

export const F_CONST = 1;
export const F_ENUM = 2;
/** Numeric keywords. */
export const F_NUMBER = 4;
/** String keywords. */
export const F_STRING = 8;
/** Array keywords. */
export const F_ARRAY = 16;
/** `required` and `properties`. */
export const F_PROPERTIES = 32;
/** Keywords that visit every key: `patternProperties`, `additionalProperties`, `propertyNames`, property counts. */
export const F_KEYS = 64;
/** `dependentRequired`, `dependentSchemas`. */
export const F_DEPENDENT = 128;
export const F_REFS = 256;
/** `allOf`, `anyOf`, `oneOf`, `not`, `if`. */
export const F_APPLICATORS = 512;
/** `unevaluatedProperties`, `unevaluatedItems`. */
export const F_UNEVALUATED = 1024;

/** Keyword group of each constraining plan field; neutral fields map to 0. */
const FIELD_FLAGS: Record<string, number> = {
	hasConst: F_CONST,
	enumValues: F_ENUM,
	multipleOf: F_NUMBER,
	minimum: F_NUMBER,
	maximum: F_NUMBER,
	exclusiveMinimum: F_NUMBER,
	exclusiveMaximum: F_NUMBER,
	minLength: F_STRING,
	maxLength: F_STRING,
	pattern: F_STRING,
	format: F_STRING,
	minItems: F_ARRAY,
	maxItems: F_ARRAY,
	uniqueItems: F_ARRAY,
	prefixItems: F_ARRAY,
	items: F_ARRAY,
	contains: F_ARRAY,
	minContains: F_ARRAY,
	maxContains: F_ARRAY,
	required: F_PROPERTIES,
	properties: F_PROPERTIES,
	patternProperties: F_KEYS,
	additionalProperties: F_KEYS,
	propertyNames: F_KEYS,
	minProperties: F_KEYS,
	maxProperties: F_KEYS,
	dependentRequired: F_DEPENDENT,
	dependentSchemas: F_DEPENDENT,
	refs: F_REFS,
	allOf: F_APPLICATORS,
	anyOf: F_APPLICATORS,
	oneOf: F_APPLICATORS,
	not: F_APPLICATORS,
	if: F_APPLICATORS,
	ifThen: F_APPLICATORS,
	ifElse: F_APPLICATORS,
	unevaluatedProperties: F_UNEVALUATED,
	unevaluatedItems: F_UNEVALUATED,
};

/** Dynamic scope: the outermost resource declaring each `$dynamicAnchor` name seen so far. */
interface Scope {
	readonly key: string;
	readonly anchors: ReadonlyMap<string, Resource>;
}

const EMPTY_SCOPE: Scope = { key: "", anchors: new Map() };

function enter(scope: Scope, resource: Resource): Scope {
	if (resource.dynamicAnchors.size === 0) return scope;
	let anchors: Map<string, Resource> | undefined;
	for (const name of resource.dynamicAnchors.keys()) {
		if (scope.anchors.has(name)) continue;
		anchors ??= new Map(scope.anchors);
		anchors.set(name, resource);
	}
	if (anchors === undefined) return scope;
	const key = [...anchors]
		.map(([name, owner]) => `${name}\u0001${owner.uri}`)
		.sort()
		.join("\u0002");
	return { key, anchors };
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) if (typeof item !== "string") return undefined;
	return value as string[];
}

/** Lowers one registry's documents into plans. */
export class Planner {
	readonly #registry: Registry;
	readonly #formats: Readonly<Record<string, FormatCheck>> | undefined;
	/** Plans in the empty dynamic scope (almost all of them), by schema. */
	readonly #memo = new Map<object, Plan>();
	/** Plans under `$dynamicAnchor` scopes, by scope key then schema. */
	readonly #scoped = new Map<string, Map<object, Plan>>();
	/** Whether any `properties` subschema declares a `default`. */
	sawDefaults = false;

	constructor(registry: Registry, formats: Readonly<Record<string, FormatCheck>> | undefined) {
		this.#registry = registry;
		this.#formats = formats;
	}

	/** Plan the registry's root document. */
	root(schema: unknown): Plan {
		const target = this.#registry.addRoot(schema);
		return this.#build(target.schema, target.location, enter(EMPTY_SCOPE, target.location.resource));
	}

	#build(schema: unknown, location: Location, scope: Scope): Plan {
		if (schema === true) return TRUE_PLAN;
		if (schema === false) return FALSE_PLAN;
		if (!isNode(schema)) throw new OmpTypeError("JSON Schema nodes must be booleans or objects");
		let memo = this.#memo;
		if (scope.key !== "") {
			let scoped = this.#scoped.get(scope.key);
			if (scoped === undefined) {
				scoped = new Map();
				this.#scoped.set(scope.key, scoped);
			}
			memo = scoped;
		}
		const known = memo.get(schema);
		if (known !== undefined) return known;
		const plan: Plan = { types: T_ANY, empty: false, flags: 0 };
		memo.set(schema, plan);
		this.#fill(plan, schema, location, scope);
		let flags = 0;
		for (const field in plan) flags |= FIELD_FLAGS[field] ?? 0;
		if (flags === 0) {
			// Type-only schemas (`{ "type": "string", "description": … }`) have no subschemas, so
			// nothing captured `plan` while filling it; every one of them shares a plan per mask.
			const shared = typePlan(plan.types);
			memo.set(schema, shared);
			return shared;
		}
		plan.flags = flags;
		return plan;
	}

	/** Plan a subschema reached structurally from `parent`. */
	#child(schema: unknown, parent: Location, scope: Scope): Plan {
		if (!isNode(schema)) return this.#build(schema, parent, scope);
		const location = this.#registry.location(schema) ?? parent;
		return this.#build(
			schema,
			location,
			location.resource === parent.resource ? scope : enter(scope, location.resource),
		);
	}

	#ref(ref: string, location: Location, scope: Scope): Plan {
		const target = this.#registry.resolve(ref, location.base);
		return this.#build(target.schema, target.location, enter(scope, target.location.resource));
	}

	/**
	 * `$dynamicRef` resolves like `$ref` unless its initial target declares the
	 * fragment as a `$dynamicAnchor`; then the outermost resource in scope
	 * declaring that anchor wins.
	 */
	#dynamicRef(ref: string, location: Location, scope: Scope): Plan {
		const target = this.#registry.resolve(ref, location.base);
		const hash = ref.indexOf("#");
		const name = hash < 0 ? "" : ref.slice(hash + 1);
		if (name === "" || name.charCodeAt(0) === 47 || !isNode(target.schema) || target.schema.$dynamicAnchor !== name) {
			return this.#build(target.schema, target.location, enter(scope, target.location.resource));
		}
		const outermost = scope.anchors.get(name);
		const dynamic = outermost?.dynamicAnchors.get(name);
		if (outermost === undefined || dynamic === undefined) {
			return this.#build(target.schema, target.location, enter(scope, target.location.resource));
		}
		const dynamicLocation = this.#registry.location(dynamic) ?? { base: outermost.uri, resource: outermost };
		return this.#build(dynamic, dynamicLocation, enter(scope, outermost));
	}

	/** Lower the keywords `node` declares; one pass over its own keys. */
	#fill(plan: Plan, node: Node, location: Location, scope: Scope): void {
		const { draft, vocab } = location.resource;
		if (typeof node.$ref === "string") {
			plan.refs = [this.#ref(node.$ref, location, scope)];
			// Draft 7: `$ref` overrides every sibling keyword.
			if (draft === "7") return;
		}
		const validation = (vocab & VOCAB_VALIDATION) !== 0;
		const applicator = (vocab & VOCAB_APPLICATOR) !== 0;
		const unevaluated = draft !== "7" && (vocab & VOCAB_UNEVALUATED) !== 0;
		for (const key in node) {
			const value = node[key];
			switch (key) {
				case "$dynamicRef":
					if (draft === "2020-12" && typeof value === "string") {
						(plan.refs ??= []).push(this.#dynamicRef(value, location, scope));
					}
					break;
				case "type":
					if (validation) plan.types = typeFlags(value);
					break;
				case "const":
					if (validation) {
						plan.hasConst = true;
						plan.constValue = value;
					}
					break;
				case "enum":
					if (validation && Array.isArray(value)) plan.enumValues = value;
					break;
				case "multipleOf":
					if (validation && typeof value === "number" && value > 0) plan.multipleOf = value;
					break;
				case "minimum":
				case "maximum":
				case "exclusiveMinimum":
				case "exclusiveMaximum":
					if (validation && typeof value === "number" && Number.isFinite(value)) plan[key] = value;
					break;
				case "minLength":
				case "maxLength":
				case "minItems":
				case "maxItems":
				case "minProperties":
				case "maxProperties":
					if (validation && typeof value === "number" && value >= 0) plan[key] = value;
					break;
				case "minContains":
				case "maxContains":
					if (validation && draft !== "7" && typeof value === "number" && value >= 0) plan[key] = value;
					break;
				case "pattern":
					if (validation && typeof value === "string") plan.pattern = pattern(value);
					break;
				case "uniqueItems":
					if (validation && value === true) plan.uniqueItems = true;
					break;
				case "required": {
					const required = validation ? stringList(value) : undefined;
					if (required !== undefined && required.length > 0) plan.required = required;
					break;
				}
				case "dependentRequired":
				case "dependencies":
					if (!isNode(value)) break;
					for (const property in value) {
						const dependency = value[property];
						if (Array.isArray(dependency)) {
							const required = validation ? stringList(dependency) : undefined;
							if (required !== undefined && required.length > 0) {
								(plan.dependentRequired ??= []).push({ key: property, required });
							}
						} else if (
							applicator &&
							key === "dependencies" &&
							(isNode(dependency) || typeof dependency === "boolean")
						) {
							(plan.dependentSchemas ??= []).push({
								key: property,
								plan: this.#child(dependency, location, scope),
								inherited: isInheritedName(property),
							});
						}
					}
					break;
				case "dependentSchemas":
					if (!applicator || !isNode(value)) break;
					for (const property in value) {
						(plan.dependentSchemas ??= []).push({
							key: property,
							plan: this.#child(value[property], location, scope),
							inherited: isInheritedName(property),
						});
					}
					break;
				case "format": {
					const check = typeof value === "string" ? this.#formats?.[value] : undefined;
					if (check !== undefined) {
						plan.format = check;
						plan.formatName = value as string;
					}
					break;
				}
				case "allOf":
				case "anyOf":
				case "oneOf":
					if (applicator && Array.isArray(value) && value.length > 0) {
						plan[key] = value.map(branch => this.#child(branch, location, scope));
					}
					break;
				case "not":
					if (applicator) plan.not = this.#child(value, location, scope);
					break;
				case "if":
					if (!applicator) break;
					plan.if = this.#child(value, location, scope);
					if (node.then !== undefined) plan.ifThen = this.#child(node.then, location, scope);
					if (node.else !== undefined) plan.ifElse = this.#child(node.else, location, scope);
					break;
				case "properties":
					if (applicator && isNode(value)) this.#properties(plan, value, location, scope);
					break;
				case "patternProperties":
					if (!applicator || !isNode(value)) break;
					for (const source in value) {
						(plan.patternProperties ??= []).push({
							pattern: pattern(source),
							plan: this.#child(value[source], location, scope),
						});
					}
					break;
				case "additionalProperties":
				case "propertyNames":
				case "contains":
					if (applicator) plan[key] = this.#child(value, location, scope);
					break;
				case "items":
					if (!applicator) break;
					if (Array.isArray(value)) {
						// Draft 7 tuples (and 2019-09): `additionalItems` covers the rest.
						plan.prefixItems = value.map(item => this.#child(item, location, scope));
						if (node.additionalItems !== undefined) {
							plan.items = this.#child(node.additionalItems, location, scope);
						}
					} else {
						plan.items = this.#child(value, location, scope);
					}
					break;
				case "prefixItems":
					if (applicator && draft === "2020-12" && Array.isArray(value) && !Array.isArray(node.items)) {
						plan.prefixItems = value.map(item => this.#child(item, location, scope));
					}
					break;
				case "unevaluatedProperties":
				case "unevaluatedItems":
					if (unevaluated) plan[key] = this.#child(value, location, scope);
					break;
			}
		}
	}

	#properties(plan: Plan, properties: Node, location: Location, scope: Scope): void {
		const entries: KeyPlan[] = [];
		for (const key in properties) {
			const value = properties[key];
			entries.push({ key, plan: this.#child(value, location, scope), inherited: isInheritedName(key) });
			if (isNode(value) && "default" in value) {
				(plan.defaults ??= []).push({ key, value: value.default });
				this.sawDefaults = true;
			}
		}
		if (entries.length > 0) plan.properties = entries;
	}
}

const TYPE_PLANS = new Map<number, Plan>([
	[T_ANY, TRUE_PLAN],
	[0, FALSE_PLAN],
]);

/** The shared plan of a schema constraining nothing but its type. */
function typePlan(types: number): Plan {
	let plan = TYPE_PLANS.get(types);
	if (plan === undefined) {
		plan = { types, empty: false, flags: 0 };
		TYPE_PLANS.set(types, plan);
	}
	return plan;
}

function typeFlags(value: unknown): number {
	if (typeof value === "string") return TYPE_FLAGS[value] ?? T_ANY;
	if (!Array.isArray(value)) return T_ANY;
	let types = 0;
	for (const name of value) types |= typeof name === "string" ? (TYPE_FLAGS[name] ?? 0) : 0;
	return types;
}

function pattern(source: string): RegExp {
	try {
		return compilePattern(source);
	} catch {
		throw new OmpTypeError(`invalid pattern: ${source}`);
	}
}
