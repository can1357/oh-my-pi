/**
 * JSON Schema validator engine behind `fromJsonSchema`: plans the document,
 * interprets the plan for the first calls, and swaps in generated code once a
 * schema proves hot. Where code generation is forbidden (strict CSP) the
 * interpreter keeps serving every call.
 */
import { generate } from "./codegen";
import { type Issue, Sink, validate } from "./interpret";
import { type FormatCheck, type Plan, Planner } from "./plan";
import { Registry } from "./resolve";

/** Calls interpreted before the JIT generates code; generation costs about as much as a hundred interpreted checks. */
const JIT_THRESHOLD = 64;

/** Options shared by the validator engine and `fromJsonSchema`. */
export interface ValidatorOptions {
	/** Semantics for resources that declare no `$schema`: `"2020-12"` (default) or `"7"`. */
	readonly draft?: "2020-12" | "7";
	/** Documents by URI that `$ref`s may name: remote schemas, meta-schemas. */
	readonly schemas?: Readonly<Record<string, unknown>>;
	/** Assertions by `format` name. Without one, `format` is an annotation, as draft 2020-12 specifies. */
	readonly formats?: Readonly<Record<string, FormatCheck>>;
}

/** A compiled JSON Schema. */
export class Validator {
	/** Allocation-free validity test; safe to detach (`const check = validator.check`). */
	readonly check: (value: unknown) => boolean;
	/** Whether some `properties` subschema declares a `default` for {@link fillDefaults} to apply. */
	readonly hasDefaults: boolean;
	readonly #root: Plan;

	/**
	 * `onCompile` receives the steady-state check once the schema turns hot
	 * (generated code, or the interpreter where code generation is forbidden), so
	 * callers holding their own reference can drop the dispatch through `check`.
	 *
	 * # Errors
	 * Throws `OmpTypeError` for unresolvable or malformed `$ref`s, invalid
	 * patterns, and schema nodes that are neither booleans nor objects.
	 */
	constructor(
		schema: unknown,
		options: ValidatorOptions = {},
		onCompile?: (check: (value: unknown) => value is unknown) => void,
	) {
		const registry = new Registry(options.draft ?? "2020-12", options.schemas);
		const planner = new Planner(registry, options.formats);
		const root = planner.root(schema);
		this.hasDefaults = planner.sawDefaults;
		this.#root = root;
		let calls = 0;
		let impl = (value: unknown): value is unknown => {
			if (++calls < JIT_THRESHOLD) return validate(root, value);
			impl = generate(root) ?? ((input: unknown): input is unknown => validate(root, input));
			onCompile?.(impl);
			return impl(value);
		};
		this.check = value => impl(value);
	}

	/** Every issue that makes `value` invalid (empty when it is valid). */
	explain(value: unknown): Issue[] {
		const sink = new Sink();
		validate(this.#root, value, sink);
		return sink.issues;
	}

	/** `value` with absent declared properties set to their `default`, copied on write. */
	fillDefaults(value: unknown): unknown {
		return fill(this.#root, value);
	}
}

/** Defaults descend through in-place `$ref`/`allOf`, declared properties, and items. */
function fill(plan: Plan, value: unknown): unknown {
	let out = value;
	if (plan.refs !== undefined) for (const ref of plan.refs) out = fill(ref, out);
	if (plan.allOf !== undefined) for (const branch of plan.allOf) out = fill(branch, out);
	if (typeof out !== "object" || out === null) return out;
	if (Array.isArray(out)) {
		const prefix = plan.prefixItems ?? [];
		if (prefix.length === 0 && plan.items === undefined) return out;
		let copy: unknown[] | undefined;
		for (let index = 0; index < out.length; index++) {
			const itemPlan = index < prefix.length ? prefix[index] : plan.items;
			if (itemPlan === undefined) continue;
			const item = fill(itemPlan, out[index]);
			if (item === out[index]) continue;
			copy ??= [...out];
			copy[index] = item;
		}
		return copy ?? out;
	}
	if (plan.properties === undefined) return out;
	const source = out as Record<string, unknown>;
	let copy: Record<string, unknown> | undefined;
	for (const { key, plan: propertyPlan } of plan.properties) {
		if (!Object.hasOwn(source, key) || source[key] === undefined) continue;
		const filled = fill(propertyPlan, source[key]);
		if (filled === source[key]) continue;
		copy ??= { ...source };
		copy[key] = filled;
	}
	if (plan.defaults !== undefined) {
		for (const { key, value: fallback } of plan.defaults) {
			if (Object.hasOwn(source, key) && source[key] !== undefined) continue;
			copy ??= { ...source };
			copy[key] = typeof fallback === "object" && fallback !== null ? structuredClone(fallback) : fallback;
		}
	}
	return copy ?? out;
}
