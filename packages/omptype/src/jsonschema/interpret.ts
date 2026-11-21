/**
 * Plan interpreter: validates values directly against a {@link Plan} graph.
 * It serves a schema's first calls (before the JIT in `codegen.ts` takes
 * over), runtimes that forbid code generation, error explanations, and the
 * annotation tracking behind `unevaluatedProperties`/`unevaluatedItems`.
 *
 * {@link validate} takes two optional collectors:
 * - `sink` gathers {@link Issue}s with paths (explain mode); validation then
 *   keeps going past the first failure so every issue surfaces.
 * - `ann` receives evaluated property names and item indices. Only in-place
 *   applicators (`allOf`, `anyOf`, `$ref`, ...) forward it; child instances
 *   start fresh.
 */
import { MISSING } from "../errors";
import {
	F_APPLICATORS,
	F_ARRAY,
	F_CONST,
	F_DEPENDENT,
	F_ENUM,
	F_KEYS,
	F_NUMBER,
	F_PROPERTIES,
	F_REFS,
	F_STRING,
	F_UNEVALUATED,
	type Plan,
	T_ANY,
	T_ARRAY,
	T_BOOLEAN,
	T_INTEGER,
	T_NULL,
	T_NUMBER,
	T_OBJECT,
	T_STRING,
} from "./plan";
import { codePointLength, isMultipleOf, jsonEqual, jsonIncludes, uniqueItems } from "./runtime";

/** One failure found while explaining an invalid value. */
export interface Issue {
	readonly path: PropertyKey[];
	readonly expected: string;
	readonly data: unknown;
}

/** Issue collector for explain mode. */
export class Sink {
	readonly issues: Issue[] = [];

	add(expected: string, data: unknown, key?: PropertyKey): void {
		this.issues.push({ path: key === undefined ? [] : [key], expected, data });
	}

	/** Prefix the paths of issues recorded since `from` with `key`. */
	prefix(from: number, key: PropertyKey): void {
		const issues = this.issues;
		for (let index = from; index < issues.length; index++) issues[index].path.unshift(key);
	}
}

/** Locations of the current instance evaluated so far by successful subschemas. */
export interface Ann {
	/** Evaluated property names, or `true` once every property is evaluated. */
	props: Set<string> | true | undefined;
	/** Every index below this is evaluated (`Infinity` for all). */
	items: number;
	/** Indices evaluated by `contains`. */
	contained: Set<number> | undefined;
}

const hasOwn = Object.hasOwn;
const isArray = Array.isArray;

function newAnn(): Ann {
	return { props: undefined, items: 0, contained: undefined };
}

function mergeAnn(into: Ann, from: Ann): void {
	if (from.props === true) into.props = true;
	else if (from.props !== undefined && into.props !== true) {
		if (into.props === undefined) into.props = new Set(from.props);
		else for (const key of from.props) into.props.add(key);
	}
	if (from.items > into.items) into.items = from.items;
	if (from.contained !== undefined) {
		if (into.contained === undefined) into.contained = new Set(from.contained);
		else for (const index of from.contained) into.contained.add(index);
	}
}

function annotateProp(ann: Ann, key: string): void {
	if (ann.props === true) return;
	if (ann.props === undefined) ann.props = new Set([key]);
	else ann.props.add(key);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !isArray(value);
}

/** Own-property read; `inherited` names (`constructor`, `__proto__`, ...) need the own check. */
function ownValue(object: Record<string, unknown>, key: string, inherited: boolean): unknown {
	return inherited && !hasOwn(object, key) ? undefined : object[key];
}

const TYPE_NAMES: [number, string][] = [
	[T_OBJECT, "an object"],
	[T_ARRAY, "an array"],
	[T_STRING, "a string"],
	[T_NUMBER, "a number"],
	[T_INTEGER, "an integer"],
	[T_BOOLEAN, "boolean"],
	[T_NULL, "null"],
];

/** Human-readable expectation for a `T_*` mask. */
export function describeTypes(types: number): string {
	if (types === 0) return "never";
	const names: string[] = [];
	for (const [flag, name] of TYPE_NAMES) {
		if (!(types & flag)) continue;
		if (flag === T_INTEGER && types & T_NUMBER) continue;
		names.push(name);
	}
	return names.join(" or ");
}

function describeValue(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

/** What a missing or mismatched value of `plan` was expected to be. */
function expectedOf(schema: Plan): string {
	const plan = unwrapRef(schema);
	if (plan.hasConst) return describeValue(plan.constValue);
	if (plan.enumValues !== undefined) return plan.enumValues.map(describeValue).join(" or ");
	if (plan.types !== T_ANY) return describeTypes(plan.types);
	return "present";
}

function matchesTypes(value: unknown, types: number): boolean {
	switch (typeof value) {
		case "string":
			return (types & T_STRING) !== 0;
		case "number":
			return (types & T_NUMBER) !== 0
				? Number.isFinite(value)
				: (types & T_INTEGER) !== 0 && Number.isInteger(value);
		case "boolean":
			return (types & T_BOOLEAN) !== 0;
		case "object":
			if (value === null) return (types & T_NULL) !== 0;
			return (types & (isArray(value) ? T_ARRAY : T_OBJECT)) !== 0;
		default:
			return false;
	}
}

function isPrimitive(value: unknown): boolean {
	return value === null || (typeof value !== "object" && typeof value !== "function");
}

/**
 * Object property whose value selects the only `anyOf`/`oneOf` branch that can
 * pass: every branch is an object schema requiring the property with distinct
 * primitive `const`/`enum` values.
 */
export interface Discriminator {
	readonly key: string;
	/** Tag value → branch index. */
	readonly branches: Map<unknown, number>;
}

/** Follow plans that are a bare single `$ref`. */
export function unwrapRef(plan: Plan): Plan {
	let current = plan;
	for (let depth = 0; depth < 32 && current.refs?.length === 1 && isRefOnly(current); depth++) {
		current = current.refs[0];
	}
	return current;
}

/** True when the plan's only constraint is its `refs`. */
export function isRefOnly(plan: Plan): boolean {
	return plan.flags === F_REFS && plan.types === T_ANY;
}

function tagValues(plan: Plan): unknown[] | undefined {
	if (plan.hasConst) return isPrimitive(plan.constValue) ? [plan.constValue] : undefined;
	if (plan.enumValues !== undefined && plan.enumValues.every(isPrimitive)) return [...plan.enumValues];
	return undefined;
}

/** Find a {@link Discriminator} for union branches, if one exists. */
export function findDiscriminator(branches: readonly Plan[]): Discriminator | undefined {
	if (branches.length < 2) return undefined;
	const plans = branches.map(unwrapRef);
	const first = plans[0];
	if (first.types !== T_OBJECT || first.properties === undefined || first.required === undefined) return undefined;
	for (const candidate of first.properties) {
		if (candidate.inherited) continue;
		const key = candidate.key;
		const map = new Map<unknown, number>();
		let ok = true;
		for (let index = 0; index < plans.length && ok; index++) {
			const plan = plans[index];
			if (plan.types !== T_OBJECT || plan.required?.includes(key) !== true) {
				ok = false;
				break;
			}
			const property = plan.properties?.find(entry => entry.key === key);
			const values = property === undefined ? undefined : tagValues(unwrapRef(property.plan));
			if (values === undefined) {
				ok = false;
				break;
			}
			for (const value of values) {
				if (map.has(value)) {
					ok = false;
					break;
				}
				map.set(value, index);
			}
		}
		if (ok) return { key, branches: map };
	}
	return undefined;
}

const kAnyOf = Symbol("omptype.jsonschema.anyOfTag");
const kOneOf = Symbol("omptype.jsonschema.oneOfTag");

/** A plan with its union discriminators, found on first use (`null`: none). */
interface TaggedPlan extends Plan {
	[kAnyOf]?: Discriminator | null;
	[kOneOf]?: Discriminator | null;
}

/**
 * Whether `value` satisfies `plan`.
 *
 * Infinite `$ref` cycles that never descend into the value (`{"$ref": "#"}`)
 * overflow the stack, as they would in any evaluator.
 */
export function validate(plan: Plan, value: unknown, sink?: Sink, ann?: Ann): boolean {
	if (plan.empty) return true;
	if (plan.types !== T_ANY && !matchesTypes(value, plan.types)) {
		sink?.add(describeTypes(plan.types), value);
		return false;
	}
	const flags = plan.flags;
	if (flags === 0) return true;
	if (flags & F_UNEVALUATED) return validateUnevaluated(plan, value, sink, ann);
	return validateKeywords(plan, flags, value, sink, ann);
}

function validateKeywords(
	plan: Plan,
	flags: number,
	value: unknown,
	sink: Sink | undefined,
	ann: Ann | undefined,
): boolean {
	let ok = true;
	if (
		flags & F_CONST &&
		!(isPrimitive(plan.constValue) ? value === plan.constValue : jsonEqual(value, plan.constValue))
	) {
		if (sink === undefined) return false;
		sink.add(describeValue(plan.constValue), value);
		ok = false;
	}
	if (flags & F_ENUM) {
		const values = plan.enumValues!;
		if (!(isPrimitive(value) ? values.includes(value) : jsonIncludes(values, value))) {
			if (sink === undefined) return false;
			sink.add(values.map(describeValue).join(" or "), value);
			ok = false;
		}
	}
	let valid = true;
	switch (typeof value) {
		case "number":
			if (flags & F_NUMBER) valid = validateNumber(plan, value, sink);
			break;
		case "string":
			if (flags & F_STRING) valid = validateString(plan, value, sink);
			break;
		case "object":
			if (value === null) break;
			if (isArray(value)) {
				if (flags & F_ARRAY) valid = validateArray(plan, value, sink, ann);
			} else if (flags & (F_PROPERTIES | F_KEYS | F_DEPENDENT)) {
				valid = validateObject(plan, flags, value as Record<string, unknown>, sink, ann);
			}
			break;
	}
	if (!valid) {
		if (sink === undefined) return false;
		ok = false;
	}
	if (flags & F_REFS) {
		for (const ref of plan.refs!) {
			if (validate(ref, value, sink, ann)) continue;
			if (sink === undefined) return false;
			ok = false;
		}
	}
	if (!(flags & F_APPLICATORS)) return ok;
	if (plan.allOf !== undefined) {
		for (const branch of plan.allOf) {
			if (validate(branch, value, sink, ann)) continue;
			if (sink === undefined) return false;
			ok = false;
		}
	}
	if (plan.anyOf !== undefined && !validateUnion(plan, plan.anyOf, false, value, sink, ann)) {
		if (sink === undefined) return false;
		ok = false;
	}
	if (plan.oneOf !== undefined && !validateUnion(plan, plan.oneOf, true, value, sink, ann)) {
		if (sink === undefined) return false;
		ok = false;
	}
	if (plan.not !== undefined && validate(plan.not, value)) {
		if (sink === undefined) return false;
		sink.add("not matching the negated schema", value);
		ok = false;
	}
	if (plan.if !== undefined && !validateConditional(plan, plan.if, value, sink, ann)) {
		if (sink === undefined) return false;
		ok = false;
	}
	return ok;
}

function validateNumber(plan: Plan, value: number, sink: Sink | undefined): boolean {
	const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = plan;
	let ok = true;
	if (minimum !== undefined && value < minimum) {
		if (sink === undefined) return false;
		sink.add(`at least ${minimum}`, value);
		ok = false;
	}
	if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
		if (sink === undefined) return false;
		sink.add(`more than ${exclusiveMinimum}`, value);
		ok = false;
	}
	if (maximum !== undefined && value > maximum) {
		if (sink === undefined) return false;
		sink.add(`at most ${maximum}`, value);
		ok = false;
	}
	if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
		if (sink === undefined) return false;
		sink.add(`less than ${exclusiveMaximum}`, value);
		ok = false;
	}
	if (multipleOf !== undefined && !isMultipleOf(value, multipleOf)) {
		if (sink === undefined) return false;
		sink.add(`divisible by ${multipleOf}`, value);
		ok = false;
	}
	return ok;
}

function validateString(plan: Plan, value: string, sink: Sink | undefined): boolean {
	const { minLength, maxLength, pattern, format } = plan;
	let ok = true;
	if (minLength !== undefined && value.length < minLength * 2 && codePointLength(value) < minLength) {
		if (sink === undefined) return false;
		sink.add(`at least length ${minLength}`, value);
		ok = false;
	}
	if (maxLength !== undefined && value.length > maxLength && codePointLength(value) > maxLength) {
		if (sink === undefined) return false;
		sink.add(`at most length ${maxLength}`, value);
		ok = false;
	}
	if (pattern !== undefined && !pattern.test(value)) {
		if (sink === undefined) return false;
		sink.add(`matching /${pattern.source}/`, value);
		ok = false;
	}
	if (format !== undefined && !format(value)) {
		if (sink === undefined) return false;
		sink.add(`a string in ${plan.formatName} format`, value);
		ok = false;
	}
	return ok;
}

function validateArray(plan: Plan, value: unknown[], sink: Sink | undefined, ann: Ann | undefined): boolean {
	const { minItems, maxItems, prefixItems, items, contains, maxContains } = plan;
	const n = value.length;
	let ok = true;
	if (minItems !== undefined && n < minItems) {
		if (sink === undefined) return false;
		sink.add(`an array of at least length ${minItems}`, value);
		ok = false;
	}
	if (maxItems !== undefined && n > maxItems) {
		if (sink === undefined) return false;
		sink.add(`an array of at most length ${maxItems}`, value);
		ok = false;
	}
	const prefixLength = prefixItems?.length ?? 0;
	if (prefixItems !== undefined) {
		const end = n < prefixLength ? n : prefixLength;
		for (let index = 0; index < end; index++) {
			const from = sink === undefined ? 0 : sink.issues.length;
			if (validate(prefixItems[index], value[index], sink)) continue;
			if (sink === undefined) return false;
			sink.prefix(from, index);
			ok = false;
		}
		if (ann !== undefined && end > ann.items) ann.items = end;
	}
	if (items !== undefined) {
		if (!items.empty) {
			for (let index = prefixLength; index < n; index++) {
				const from = sink === undefined ? 0 : sink.issues.length;
				if (validate(items, value[index], sink)) continue;
				if (sink === undefined) return false;
				sink.prefix(from, index);
				ok = false;
			}
		}
		if (ann !== undefined) ann.items = Infinity;
	}
	if (contains !== undefined) {
		const atLeast = plan.minContains ?? 1;
		let count = 0;
		for (let index = 0; index < n; index++) {
			if (!validate(contains, value[index])) continue;
			count++;
			if (ann !== undefined) (ann.contained ??= new Set()).add(index);
			else if (count >= atLeast && maxContains === undefined) break;
		}
		if (count < atLeast) {
			if (sink === undefined) return false;
			sink.add(`an array containing at least ${atLeast} matching item${atLeast === 1 ? "" : "s"}`, value);
			ok = false;
		}
		if (maxContains !== undefined && count > maxContains) {
			if (sink === undefined) return false;
			sink.add(`an array containing at most ${maxContains} matching items`, value);
			ok = false;
		}
	}
	if (plan.uniqueItems && !uniqueItems(value)) {
		if (sink === undefined) return false;
		sink.add("an array of unique items", value);
		ok = false;
	}
	return ok;
}

function declares(plan: Plan, key: string): boolean {
	const properties = plan.properties;
	if (properties === undefined) return false;
	for (const property of properties) if (property.key === key) return true;
	return false;
}

function validateObject(
	plan: Plan,
	flags: number,
	object: Record<string, unknown>,
	sink: Sink | undefined,
	ann: Ann | undefined,
): boolean {
	let ok = true;
	const { required, properties } = plan;
	if (required !== undefined) {
		for (const key of required) {
			if (object[key] !== undefined && hasOwn(object, key)) continue;
			if (sink === undefined) return false;
			const property = properties?.find(entry => entry.key === key);
			sink.add(property === undefined ? "present" : expectedOf(property.plan), MISSING, key);
			ok = false;
		}
	}
	if (properties !== undefined) {
		for (const { key, plan: property, inherited } of properties) {
			const item = ownValue(object, key, inherited);
			if (item === undefined) continue;
			if (ann !== undefined) annotateProp(ann, key);
			const from = sink === undefined ? 0 : sink.issues.length;
			if (validate(property, item, sink)) continue;
			if (sink === undefined) return false;
			sink.prefix(from, key);
			ok = false;
		}
	}
	if (flags & F_KEYS) {
		const { patternProperties, additionalProperties, propertyNames, minProperties, maxProperties } = plan;
		let count = 0;
		for (const key in object) {
			count++;
			if (propertyNames !== undefined) {
				const from = sink === undefined ? 0 : sink.issues.length;
				if (!validate(propertyNames, key, sink)) {
					if (sink === undefined) return false;
					sink.prefix(from, key);
					ok = false;
				}
			}
			if (patternProperties === undefined && additionalProperties === undefined) continue;
			let matched = declares(plan, key);
			if (patternProperties !== undefined) {
				for (const { pattern, plan: patternPlan } of patternProperties) {
					if (!pattern.test(key)) continue;
					matched = true;
					if (ann !== undefined) annotateProp(ann, key);
					const from = sink === undefined ? 0 : sink.issues.length;
					if (validate(patternPlan, object[key], sink)) continue;
					if (sink === undefined) return false;
					sink.prefix(from, key);
					ok = false;
				}
			}
			if (matched || additionalProperties === undefined) continue;
			if (additionalProperties.types === 0) {
				if (sink === undefined) return false;
				sink.add("removed", object[key], key);
				ok = false;
				continue;
			}
			const from = sink === undefined ? 0 : sink.issues.length;
			if (validate(additionalProperties, object[key], sink)) continue;
			if (sink === undefined) return false;
			sink.prefix(from, key);
			ok = false;
		}
		if (additionalProperties !== undefined && ann !== undefined) ann.props = true;
		if (minProperties !== undefined && count < minProperties) {
			if (sink === undefined) return false;
			sink.add(`an object with at least ${minProperties} properties`, object);
			ok = false;
		}
		if (maxProperties !== undefined && count > maxProperties) {
			if (sink === undefined) return false;
			sink.add(`an object with at most ${maxProperties} properties`, object);
			ok = false;
		}
	}
	if (!(flags & F_DEPENDENT)) return ok;
	if (plan.dependentRequired !== undefined) {
		for (const dependency of plan.dependentRequired) {
			if (object[dependency.key] === undefined || !hasOwn(object, dependency.key)) continue;
			for (const key of dependency.required) {
				if (object[key] !== undefined && hasOwn(object, key)) continue;
				if (sink === undefined) return false;
				sink.add(`present when ${dependency.key} is present`, MISSING, key);
				ok = false;
			}
		}
	}
	if (plan.dependentSchemas !== undefined) {
		for (const { key, plan: dependency, inherited } of plan.dependentSchemas) {
			if (ownValue(object, key, inherited) === undefined) continue;
			if (validate(dependency, object, sink, ann)) continue;
			if (sink === undefined) return false;
			ok = false;
		}
	}
	return ok;
}

function validateUnion(
	plan: Plan,
	branches: readonly Plan[],
	exclusive: boolean,
	value: unknown,
	sink: Sink | undefined,
	ann: Ann | undefined,
): boolean {
	const tagged = plan as TaggedPlan;
	const slot = exclusive ? kOneOf : kAnyOf;
	let discriminator = tagged[slot];
	if (discriminator === undefined) {
		discriminator = findDiscriminator(branches) ?? null;
		tagged[slot] = discriminator;
	}
	if (discriminator !== null) {
		if (!isObject(value)) {
			sink?.add("an object", value);
			return false;
		}
		const tag = value[discriminator.key];
		const index = discriminator.branches.get(tag);
		if (index !== undefined) return validate(branches[index], value, sink, ann);
		sink?.add(
			[...discriminator.branches.keys()].map(describeValue).join(" or "),
			tag === undefined ? MISSING : tag,
			discriminator.key,
		);
		return false;
	}
	if (exclusive) {
		let matched = -1;
		let matchedAnn: Ann | undefined;
		for (let index = 0; index < branches.length; index++) {
			const local = ann === undefined ? undefined : newAnn();
			if (!validate(branches[index], value, undefined, local)) continue;
			if (matched >= 0) {
				sink?.add("exactly one matching oneOf schema", value);
				return false;
			}
			matched = index;
			matchedAnn = local;
		}
		if (matched >= 0) {
			if (ann !== undefined && matchedAnn !== undefined) mergeAnn(ann, matchedAnn);
			return true;
		}
	} else if (ann === undefined) {
		for (const branch of branches) if (validate(branch, value)) return true;
	} else {
		let ok = false;
		for (const branch of branches) {
			const local = newAnn();
			if (!validate(branch, value, undefined, local)) continue;
			ok = true;
			mergeAnn(ann, local);
		}
		if (ok) return true;
	}
	if (sink !== undefined) explainBranches(branches, value, sink);
	return false;
}

function validateConditional(
	plan: Plan,
	condition: Plan,
	value: unknown,
	sink: Sink | undefined,
	ann: Ann | undefined,
): boolean {
	const { ifThen: then, ifElse: otherwise } = plan;
	if (ann === undefined) {
		if (then === undefined && otherwise === undefined) return true;
		if (validate(condition, value)) return then === undefined || validate(then, value, sink);
		return otherwise === undefined || validate(otherwise, value, sink);
	}
	const local = newAnn();
	if (validate(condition, value, undefined, local)) {
		mergeAnn(ann, local);
		return then === undefined || validate(then, value, sink, ann);
	}
	return otherwise === undefined || validate(otherwise, value, sink, ann);
}

/** Plans with `unevaluated*`: run every other keyword collecting annotations, then check what is left. */
function validateUnevaluated(plan: Plan, value: unknown, sink: Sink | undefined, ann: Ann | undefined): boolean {
	const local = newAnn();
	let ok = validateKeywords(plan, plan.flags, value, sink, local);
	if (!ok && sink === undefined) return false;
	const properties = plan.unevaluatedProperties;
	if (properties !== undefined && isObject(value)) {
		const evaluated = local.props;
		if (evaluated !== true) {
			for (const key in value) {
				if (evaluated?.has(key) === true) continue;
				const from = sink === undefined ? 0 : sink.issues.length;
				if (validate(properties, value[key], sink)) continue;
				if (sink === undefined) return false;
				if (properties.types === 0) {
					sink.issues.length = from;
					sink.add("removed", value[key], key);
				} else {
					sink.prefix(from, key);
				}
				ok = false;
			}
		}
		local.props = true;
	}
	const items = plan.unevaluatedItems;
	if (items !== undefined && isArray(value)) {
		for (let index = local.items; index < value.length; index++) {
			if (local.contained?.has(index) === true) continue;
			const from = sink === undefined ? 0 : sink.issues.length;
			if (validate(items, value[index], sink)) continue;
			if (sink === undefined) return false;
			sink.prefix(from, index);
			ok = false;
		}
		local.items = Infinity;
	}
	if (ok && ann !== undefined) mergeAnn(ann, local);
	return ok;
}

/**
 * Report why no union branch matched: the branch that got deepest into the
 * value explains it best; failures at the value itself become one
 * alternatives issue (`a string or null`).
 */
function explainBranches(branches: readonly Plan[], value: unknown, sink: Sink): void {
	let best: Issue[] | undefined;
	let bestDepth = -1;
	const shallow: string[] = [];
	for (const branch of branches) {
		const local = new Sink();
		validate(branch, value, local);
		let depth = 0;
		for (const issue of local.issues) if (issue.path.length > depth) depth = issue.path.length;
		if (depth === 0) {
			for (const issue of local.issues) if (!shallow.includes(issue.expected)) shallow.push(issue.expected);
		}
		if (depth > bestDepth || (depth === bestDepth && best !== undefined && local.issues.length < best.length)) {
			best = local.issues;
			bestDepth = depth;
		}
	}
	if (bestDepth > 0 && best !== undefined) {
		sink.issues.push(...best);
		return;
	}
	sink.add(shallow.length > 0 ? shallow.join(" or ") : "matching a union branch", value);
}
