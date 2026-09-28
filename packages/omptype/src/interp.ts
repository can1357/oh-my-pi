/**
 * Tree-walking validator used for a schema's first few calls and as the
 * targeted fallback for recursive or predicate-only JIT subtrees.
 *
 * Semantics must stay in lockstep with `compile.ts`:
 * - success returns the output value; the input is returned as-is unless the
 *   schema morphs (defaults, `"+": "delete"`, embedded stepped schemas), in
 *   which case a fresh object/array is produced and the input is untouched
 * - failure returns an `OmpErrors` with a single fast-fail entry
 */
import { MISSING, OmpErrors } from "./errors";
import { expectedOf, hasAlias, hasMorph, type IR } from "./ir";

const own = Object.prototype.hasOwnProperty;
/** Return an independent runtime value for a prevalidated static default. */
export function materializeDefault(payload: unknown): unknown {
	if (payload === null || typeof payload !== "object") return payload;
	if (payload instanceof Date) return new Date(payload);
	return structuredClone(payload);
}
let activeVisits: WeakMap<object, Set<IR>> | undefined;
let activeChecks: WeakMap<object, Set<IR>> | undefined;

/**
 * Validate `value` against `ir`; returns output value or `OmpErrors`.
 * `path` seeds the traversal location so nested step callbacks observe
 * absolute ctx.path values when a compiled parent delegates a subtree;
 * resulting error paths are then already absolute.
 */
export function walk(ir: IR, value: unknown, path: PropertyKey[] = []): unknown {
	const previousVisits = activeVisits;
	const previousChecks = activeChecks;
	// Created lazily by visit/checks only when a recursive-alias node is reached.
	activeVisits = undefined;
	activeChecks = undefined;
	try {
		return visit(ir, value, path);
	} finally {
		activeVisits = previousVisits;
		activeChecks = previousChecks;
	}
}

function fail(path: PropertyKey[], expected: string, data: unknown): OmpErrors {
	const storedPath = path.length === 0 ? undefined : path.length === 1 ? path[0] : [...path];
	return new OmpErrors(storedPath, expected, data);
}

/** Pure predicate used for union-member scanning (no morphs, no errors). */
function checks(ir: IR, v: unknown): boolean {
	// Cycle guards are only needed when the subtree can revisit nodes through
	// recursive aliases; plain schemas skip the WeakMap bookkeeping entirely.
	if (typeof v !== "object" || v === null || !hasAlias(ir)) return checkNode(ir, v);
	activeChecks ??= new WeakMap();
	const visits = activeChecks;
	let visited = visits.get(v);
	if (visited?.has(ir)) return true;
	if (visited === undefined) {
		visited = new Set();
		visits.set(v, visited);
	}
	visited.add(ir);
	try {
		return checkNode(ir, v);
	} finally {
		visited.delete(ir);
	}
}

function checkNode(ir: IR, v: unknown): boolean {
	switch (ir.k) {
		case "unknown":
			return true;
		case "null":
			return v === null;
		case "undefined":
			return v === undefined;
		case "boolean":
			return typeof v === "boolean";
		case "bigint":
			return typeof v === "bigint";
		case "symbol":
			return typeof v === "symbol";
		case "never":
			return false;
		case "anyobject":
			return typeof v === "object" && v !== null;
		case "string":
			return (
				typeof v === "string" &&
				(ir.min === undefined || v.length >= ir.min) &&
				(ir.max === undefined || v.length <= ir.max) &&
				(!ir.url || URL.canParse(v))
			);
		case "number":
			if (typeof v !== "number") return false;
			return (
				(ir.int ? Number.isInteger(v) : Number.isFinite(v)) &&
				(ir.divisor === undefined || v % ir.divisor === 0) &&
				(ir.min === undefined || (ir.xmin ? v > ir.min : v >= ir.min)) &&
				(ir.max === undefined || (ir.xmax ? v < ir.max : v <= ir.max))
			);
		case "lit":
			return ir.v instanceof Date ? v instanceof Date && v.valueOf() === ir.v.valueOf() : v === ir.v;
		case "union":
			return ir.members.some(m => checks(m, v));
		case "intersection":
			return ir.members.every(member => checks(member, v));
		case "array": {
			if (!Array.isArray(v)) return false;
			if (ir.min !== undefined && v.length < ir.min) return false;
			if (ir.max !== undefined && v.length > ir.max) return false;
			for (const element of v) if (!checks(ir.el, element)) return false;
			return true;
		}
		case "tuple": {
			if (!Array.isArray(v)) return false;
			let required = ir.postfix.length;
			for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
			if (v.length < required) return false;
			if (ir.variadic === undefined && v.length > ir.prefix.length + ir.postfix.length) return false;
			const postfixStart = v.length - ir.postfix.length;
			const prefixCount = Math.min(ir.prefix.length, postfixStart);
			for (let index = 0; index < prefixCount; index++) {
				if (!checks(ir.prefix[index].val, v[index])) return false;
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (!item.opt && !item.hasDefault) return false;
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					if (!checks(ir.variadic, v[index])) return false;
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				if (!checks(ir.postfix[index], v[postfixStart + index])) return false;
			}
			return true;
		}
		case "object": {
			if (typeof v !== "object" || v === null) return false;
			const rec = v as Record<PropertyKey, unknown>;
			for (const p of ir.props) {
				const present = p.key in rec;
				if (!present) {
					if (!p.opt && !p.hasDefault) return false;
					continue;
				}
				if (!checks(p.val, rec[p.key])) return false;
			}
			for (const key in rec) {
				if (!own.call(rec, key)) continue;
				if (ir.index !== undefined && !checks(ir.index, rec[key])) return false;
				let patternMatched = false;
				if (ir.patternIndexes !== undefined) {
					for (const pattern of ir.patternIndexes) {
						if (!checks(pattern.key, key)) continue;
						patternMatched = true;
						if (!checks(pattern.val, rec[key])) return false;
					}
				}
				if (
					ir.extras === "reject" &&
					ir.index === undefined &&
					!patternMatched &&
					!ir.props.some(prop => prop.key === key)
				) {
					return false;
				}
			}
			for (const key of Object.getOwnPropertySymbols(rec)) {
				if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
				if (ir.symbolIndex !== undefined && !checks(ir.symbolIndex, rec[key])) return false;
				if (ir.extras === "reject" && ir.symbolIndex === undefined && !ir.props.some(prop => prop.key === key)) {
					return false;
				}
			}
			return true;
		}
		case "instance":
			return v instanceof ir.ctor;
		case "refine":
			if (!checks(ir.base, v)) return false;
			try {
				return ir.pred(v) === true;
			} catch {
				return false;
			}
		case "alias":
			return checks(ir.resolve(), v);
		case "morph":
			return checks(ir.input, v);
		case "sub":
			return !(ir.schema.run(v) instanceof OmpErrors);
	}
}

function visit(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	if (typeof v !== "object" || v === null || !hasAlias(ir)) return visitFinish(ir, v, path);
	activeVisits ??= new WeakMap();
	const visits = activeVisits;
	let visited = visits.get(v);
	if (visited?.has(ir)) return v;
	if (visited === undefined) {
		visited = new Set();
		visits.set(v, visited);
	}
	visited.add(ir);
	try {
		return visitFinish(ir, v, path);
	} finally {
		visited.delete(ir);
	}
}

/** Run the node visitor, then apply node-local error configuration. */
function visitFinish(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	const out = visitNode(ir, v, path);
	if (!(out instanceof OmpErrors) || ir.cfg === undefined) return out;
	for (const error of out) {
		if (error.path.length !== path.length) return out;
	}
	return out.configure(ir.cfg);
}

function visitNode(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	switch (ir.k) {
		case "alias":
			return visit(ir.resolve(), v, path);
		case "refine": {
			const base = visit(ir.base, v, path);
			if (base instanceof OmpErrors) return base;
			try {
				const result = ir.pred(base);
				if (result instanceof OmpErrors) return path.length === 0 ? result : prefixAll(result, path);
				return result ? base : fail(path, ir.expected, base);
			} catch {
				return fail(path, ir.expected, base);
			}
		}
		case "morph": {
			const input = visit(ir.input, v, path);
			if (input instanceof OmpErrors) return input;
			const context = {
				error: (expected: string, data: unknown = input) => fail(path, expected, data),
				reject: (problem: string, data: unknown = input) => fail(path, problem, data),
			};
			const output = ir.fn(input, context);
			if (output instanceof OmpErrors) return output;
			return ir.out === undefined ? output : visit(ir.out, output, path);
		}
		case "intersection": {
			let output = v;
			for (const member of ir.members) {
				output = visit(member, output, path);
				if (output instanceof OmpErrors) return output;
			}
			return output;
		}
		case "sub": {
			const out = ir.schema.run(v, path);
			if (out instanceof OmpErrors) {
				return path.length === 0 ? out : prefixAll(out, path);
			}
			return out;
		}
		case "union": {
			// fast path: any pure member matching returns the input unchanged
			for (const m of ir.members) {
				if (m.k !== "sub" && checks(m, v)) {
					if (hasMorph(m)) break;
					return v;
				}
			}
			let targeted: OmpErrors | undefined;
			let targetCount = 0;
			for (const member of ir.members) {
				if (member.k === "sub" || hasMorph(member)) {
					const out = visit(member, v, path);
					if (!(out instanceof OmpErrors)) return out;
					if (kindMatches(unwrapBase(member), v)) {
						targetCount++;
						targeted ??= out;
					}
				}
			}
			if (targetCount === 1 && targeted !== undefined) return targeted;
			return ir.members.some(canRefineUnionFailure) ? unionFail(ir, v, path) : fail(path, expectedOf(ir), v);
		}
		case "array": {
			if (!Array.isArray(v)) return fail(path, "an array", v);
			if (ir.min !== undefined && v.length < ir.min) return fail(path, `at least length ${ir.min}`, v.length);
			if (ir.max !== undefined && v.length > ir.max) return fail(path, `at most length ${ir.max}`, v.length);
			const morph = hasMorph(ir.el);
			// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
			const out = morph ? new Array<unknown>(v.length) : v;
			let errors: OmpErrors | undefined;
			for (let index = 0; index < v.length; index++) {
				path.push(index);
				const element = visit(ir.el, v[index], path);
				path.pop();
				if (element instanceof OmpErrors) {
					if (errors) errors.append(element);
					else errors = element;
				} else if (morph) {
					out[index] = element;
				}
			}
			return errors ?? out;
		}
		case "tuple": {
			if (!Array.isArray(v)) return fail(path, "an array", v);
			let required = ir.postfix.length;
			for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
			if (v.length < required) return fail(path, `an array of at least length ${required}`, v);
			const maximum = ir.prefix.length + ir.postfix.length;
			if (ir.variadic === undefined && v.length > maximum) {
				return fail(path, `an array of at most length ${maximum}`, v);
			}
			const postfixStart = v.length - ir.postfix.length;
			const prefixCount = Math.min(ir.prefix.length, postfixStart);
			const morph = hasMorph(ir);
			const output = morph ? [...v] : v;
			let errors: OmpErrors | undefined;
			for (let index = 0; index < prefixCount; index++) {
				path.push(index);
				const item = visit(ir.prefix[index].val, v[index], path);
				path.pop();
				if (item instanceof OmpErrors) {
					if (errors) errors.append(item);
					else errors = item;
				} else if (morph) {
					output[index] = item;
				}
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (item.hasDefault && morph) {
					const payload = item.def;
					if (item.defFactory && typeof payload === "function") {
						path.push(index);
						const resolved = visit(item.val, payload(), path);
						path.pop();
						if (resolved instanceof OmpErrors) {
							if (errors) errors.append(resolved);
							else errors = resolved;
						} else {
							output[index] = resolved;
						}
					} else {
						output[index] = materializeDefault(payload);
					}
				} else if (!item.opt) {
					path.push(index);
					const error = fail(path, expectedOf(item.val), MISSING);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					path.push(index);
					const item = visit(ir.variadic, v[index], path);
					path.pop();
					if (item instanceof OmpErrors) {
						if (errors) errors.append(item);
						else errors = item;
					} else if (morph) {
						output[index] = item;
					}
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				const inputIndex = postfixStart + index;
				path.push(inputIndex);
				const item = visit(ir.postfix[index], v[inputIndex], path);
				path.pop();
				if (item instanceof OmpErrors) {
					if (errors) errors.append(item);
					else errors = item;
				} else if (morph) {
					output[inputIndex] = item;
				}
			}
			return errors ?? output;
		}
		case "object": {
			if (typeof v !== "object" || v === null) return fail(path, "an object", v);
			const rec = v as Record<PropertyKey, unknown>;
			const morph = hasMorph(ir);
			let out: Record<PropertyKey, unknown> | undefined;
			let errors: OmpErrors | undefined;
			if (morph) {
				if (
					ir.extras === "delete" &&
					ir.index === undefined &&
					ir.symbolIndex === undefined &&
					ir.patternIndexes === undefined
				) {
					out = {};
				} else {
					out = { ...rec };
				}
			}
			for (const p of ir.props) {
				if (!(p.key in rec)) {
					if (p.hasDefault && out) {
						const payload = p.def;
						if (p.defFactory && typeof payload === "function") {
							path.push(p.key);
							const resolved = visit(p.val, payload(), path);
							path.pop();
							if (resolved instanceof OmpErrors) {
								if (errors) errors.append(resolved);
								else errors = resolved;
							} else {
								out[p.key] = resolved;
							}
						} else {
							out[p.key] = materializeDefault(payload);
						}
						continue;
					}
					if (p.opt || p.hasDefault) continue;
					path.push(p.key);
					const error = fail(path, expectedOf(p.val), MISSING);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
					continue;
				}
				path.push(p.key);
				const result = visit(p.val, rec[p.key], path);
				path.pop();
				if (result instanceof OmpErrors) {
					if (errors) errors.append(result);
					else errors = result;
				} else if (out) {
					out[p.key] = result;
				}
			}
			for (const key in rec) {
				if (!own.call(rec, key)) continue;
				let indexed = false;
				if (ir.index !== undefined) {
					indexed = true;
					path.push(key);
					const result = visit(ir.index, rec[key], path);
					path.pop();
					if (result instanceof OmpErrors) {
						if (errors) errors.append(result);
						else errors = result;
					} else if (out) {
						out[key] = result;
					}
				}
				if (ir.patternIndexes !== undefined) {
					for (const pattern of ir.patternIndexes) {
						if (!checks(pattern.key, key)) continue;
						indexed = true;
						path.push(key);
						const result = visit(pattern.val, rec[key], path);
						path.pop();
						if (result instanceof OmpErrors) {
							if (errors) errors.append(result);
							else errors = result;
						} else if (out) {
							out[key] = result;
						}
					}
				}
				if (ir.extras === "reject" && !indexed && !ir.props.some(prop => prop.key === key)) {
					path.push(key);
					const error = fail(path, "removed", rec[key]);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			for (const key of Object.getOwnPropertySymbols(rec)) {
				if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
				if (ir.symbolIndex !== undefined) {
					path.push(key);
					const result = visit(ir.symbolIndex, rec[key], path);
					path.pop();
					if (result instanceof OmpErrors) {
						if (errors) errors.append(result);
						else errors = result;
					} else if (out) {
						out[key] = result;
					}
				} else if (ir.extras === "reject" && !ir.props.some(prop => prop.key === key)) {
					path.push(key);
					const error = fail(path, "removed", rec[key]);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			return errors ?? out ?? v;
		}
		case "string": {
			if (typeof v !== "string") return fail(path, "a string", v);
			if (ir.min !== undefined && v.length < ir.min) return fail(path, `at least length ${ir.min}`, v.length);
			if (ir.max !== undefined && v.length > ir.max) return fail(path, `at most length ${ir.max}`, v.length);
			if (ir.url && !URL.canParse(v)) return fail(path, "a URL string", v);
			return v;
		}
		case "number": {
			if (typeof v !== "number" || !Number.isFinite(v)) return fail(path, ir.int ? "an integer" : "a number", v);
			let errors: OmpErrors | undefined;
			const add = (expected: string): void => {
				const error = fail(path, expected, v);
				if (errors) errors.append(error);
				else errors = error;
			};
			if (ir.int && !Number.isInteger(v)) add("an integer");
			if (ir.divisor !== undefined && v % ir.divisor !== 0) add(`a number divisible by ${ir.divisor}`);
			if (ir.min !== undefined && (ir.xmin ? v <= ir.min : v < ir.min)) {
				add(
					ir.min === 0
						? ir.xmin
							? "positive"
							: "non-negative"
						: `a number ${ir.xmin ? "more than" : "at least"} ${ir.min}`,
				);
			}
			if (ir.max !== undefined && (ir.xmax ? v >= ir.max : v > ir.max)) {
				add(
					ir.max === 0
						? ir.xmax
							? "negative"
							: "non-positive"
						: `a number ${ir.xmax ? "less than" : "at most"} ${ir.max}`,
				);
			}
			return errors ?? v;
		}
		case "lit": {
			if (checks(ir, v)) return v;
			if ((typeof ir.v === "object" && ir.v !== null) || typeof ir.v === "function") {
				let expected = "the specified reference";
				try {
					const serialized = JSON.stringify(ir.v);
					if (serialized !== undefined) {
						expected = `reference equal to ${serialized}`;
						if (typeof v === "object" && v !== null && JSON.stringify(v) === serialized) {
							expected += " (serialized to the same value)";
						}
					}
				} catch {
					// Cyclic values still get a useful reference-identity expectation.
				}
				return fail(path, expected, v);
			}
			return fail(path, expectedOf(ir), v);
		}
		default:
			return checks(ir, v) ? v : fail(path, expectedOf(ir), v);
	}
}

function prefixAll(errs: OmpErrors, path: PropertyKey[]): OmpErrors {
	for (let i = path.length - 1; i >= 0; i--) errs.prefix(path[i]);
	return errs;
}

/** True when a union failure can be replaced with a more specific nested error. */
export function canRefineUnionFailure(member: IR): boolean {
	const base = unwrapBase(member);
	if (base.k === "array" || base.k === "object") return true;
	if (base.k === "string") return base.min !== undefined || base.max !== undefined || base.url === true;
	return base.k === "number" && (base.int === true || base.min !== undefined || base.max !== undefined);
}

/**
 * Detailed failure for a union: descend into the member the value was clearly
 * aimed at — unique runtime-kind match, else an object member whose literal
 * discriminant property (e.g. `type: "'computer_call'"`) equals the value's —
 * for a precise nested error (paths, narrow messages) instead of the coarse
 * "A or B" expectation.
 */
export function unionFail(ir: IR & { k: "union" }, v: unknown, path: PropertyKey[], expected?: string): OmpErrors {
	let best: IR | undefined;
	for (const member of ir.members) {
		const base = unwrapBase(member);
		if (!kindMatches(base, v)) continue;
		if (best !== undefined) {
			best = undefined;
			break;
		}
		best = member;
	}
	if (best === undefined) {
		const discriminated = discriminateFailure(ir.members, v, path);
		if (discriminated !== undefined) return discriminated;
	}
	if (best !== undefined) {
		const out = visit(best, v, path);
		if (out instanceof OmpErrors) return out;
	}
	if (ir.members.every(member => unwrapBase(member).k === "object")) {
		const branches = ir.members.flatMap(member => {
			const result = visit(member, v, path);
			return result instanceof OmpErrors ? [[...result]] : [];
		});
		if (branches.length !== 0) {
			const common = branches[0].filter(
				(entry, index, first) =>
					first.findIndex(candidate => pathsEqual(candidate.path, entry.path)) === index &&
					branches.every(branch => branch.some(candidate => pathsEqual(candidate.path, entry.path))),
			);
			const alternatives: OmpErrors[] = [];
			if (common.length !== 0) {
				for (const entry of common) {
					const expectations = new Set<string>();
					for (const branch of branches) {
						for (const candidate of branch) {
							if (pathsEqual(candidate.path, entry.path)) {
								expectations.add(candidate.expected.endsWith(" instance") ? "an object" : candidate.expected);
							}
						}
					}
					alternatives.push(
						new OmpErrors(entry.path, [...expectations].join(" or "), entry.data, { preserveActual: true }),
					);
				}
			} else {
				for (const branch of branches) {
					for (const entry of branch) {
						alternatives.push(
							new OmpErrors(
								entry.path,
								entry.expected.endsWith(" instance") ? "an object" : entry.expected,
								entry.data,
								{ preserveActual: true },
							),
						);
					}
				}
			}
			const combined = alternatives[0];
			for (let index = 1; index < alternatives.length; index++) combined.append(alternatives[index]);
			return alternatives.length === 1 ? combined : combined.asAlternatives();
		}
	}
	return fail(path, expected ?? expectedOf(ir), v);
}

interface LiteralDiscriminant {
	path: PropertyKey[];
	value: unknown;
}

function unwrapBase(member: IR, seen = new Set<IR>()): IR {
	if (seen.has(member)) return member;
	seen.add(member);
	if (member.k === "sub") return unwrapBase(member.schema.ir, seen);
	if (member.k === "alias") return unwrapBase(member.resolve(), seen);
	if (member.k === "refine") return unwrapBase(member.base, seen);
	return member;
}

function collectDiscriminants(member: IR, prefix: PropertyKey[] = [], seen = new Set<IR>()): LiteralDiscriminant[] {
	if (seen.has(member)) return [];
	seen.add(member);
	if (member.k === "alias") return collectDiscriminants(member.resolve(), prefix, seen);
	if (member.k === "sub") return collectDiscriminants(member.schema.ir, prefix, seen);
	if (member.k === "refine") return collectDiscriminants(member.base, prefix, seen);
	if (member.k !== "object") return [];
	const result: LiteralDiscriminant[] = [];
	for (const property of member.props) {
		const propertyPath = [...prefix, property.key];
		const value = unwrapBase(property.val);
		if (value.k === "lit") result.push({ path: propertyPath, value: value.v });
		else result.push(...collectDiscriminants(property.val, propertyPath, new Set(seen)));
	}
	return result;
}

function pathsEqual(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): { present: boolean; value?: unknown } {
	let cursor = value;
	for (const key of path) {
		if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null || !(key in cursor)) {
			return { present: false };
		}
		cursor = (cursor as Record<PropertyKey, unknown>)[key];
	}
	return { present: true, value: cursor };
}

function discriminateFailure(members: IR[], value: unknown, path: PropertyKey[]): OmpErrors | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const byMember = members.map(member => collectDiscriminants(member));
	const candidates: { path: PropertyKey[]; distinct: number; declared: number }[] = [];
	for (const discriminants of byMember) {
		for (const discriminant of discriminants) {
			if (candidates.some(candidate => pathsEqual(candidate.path, discriminant.path))) continue;
			const values: unknown[] = [];
			let declared = 0;
			for (const branch of byMember) {
				const match = branch.find(candidate => pathsEqual(candidate.path, discriminant.path));
				if (match === undefined) continue;
				declared++;
				if (!values.some(candidate => Object.is(candidate, match.value))) values.push(match.value);
			}
			if (values.length > 1) candidates.push({ path: discriminant.path, distinct: values.length, declared });
		}
	}
	candidates.sort((left, right) => right.distinct - left.distinct || right.declared - left.declared);
	for (const candidate of candidates) {
		const actual = valueAtPath(value, candidate.path);
		const exact: IR[] = [];
		const defaults: IR[] = [];
		const expectedMembers: IR[] = [];
		for (let index = 0; index < members.length; index++) {
			const discriminant = byMember[index].find(item => pathsEqual(item.path, candidate.path));
			if (discriminant === undefined) {
				defaults.push(members[index]);
				continue;
			}
			expectedMembers.push({ k: "lit", v: discriminant.value });
			if (actual.present && Object.is(actual.value, discriminant.value)) exact.push(members[index]);
		}
		if (!actual.present) {
			if (defaults.length !== 0 && defaults.length < members.length) {
				return discriminateFailure(defaults, value, path);
			}
			return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), undefined);
		}
		if (exact.length === 0) {
			if (defaults.length !== 0) return discriminateFailure(defaults, value, path);
			return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), actual.value);
		}
		if (exact.length === 1) {
			const result = visit(exact[0], value, path);
			return result instanceof OmpErrors ? result : undefined;
		}
		const nested = discriminateFailure(exact, value, path);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/** True when a value's runtime shape could only be aimed at this member. */
function kindMatches(base: IR, v: unknown): boolean {
	switch (base.k) {
		case "array":
			return Array.isArray(v);
		case "object":
		case "anyobject":
			return typeof v === "object" && v !== null && !Array.isArray(v);
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number";
		default:
			return false;
	}
}
