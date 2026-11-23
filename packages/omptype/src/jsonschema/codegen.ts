/**
 * JIT backend: generates a specialized boolean validator for a {@link Plan}
 * graph via `new Function`.
 *
 * Plans inline into the function that reaches them; `$ref` targets, recursive
 * plans, and repeated non-leaf subtrees become their own functions. Failures
 * jump with `return false` or a labeled `break`, so union branches, `not`, and
 * `if` run inline without allocating closures. Unions whose branches share a
 * required tag property compile to a `switch` on that tag. Plans that need
 * annotation tracking (`unevaluated*`) delegate to the interpreter.
 */
import { findDiscriminator, isRefOnly, unwrapRef, validate } from "./interpret";
import {
	kindOf,
	type Plan,
	T_ANY,
	T_ARRAY,
	T_BOOLEAN,
	T_INTEGER,
	T_NULL,
	T_NUMBER,
	T_NUMERIC,
	T_OBJECT,
	T_STRING,
} from "./plan";
import { compileSimplePattern } from "./pattern";
import { codePointLength, isInheritedName, isMultipleOf, jsonEqual, jsonIncludes, uniqueItems } from "./runtime";

const HELPERS = {
	eq: jsonEqual,
	inc: jsonIncludes,
	uniq: uniqueItems,
	mult: isMultipleOf,
	cpl: codePointLength,
	own: Object.hasOwn,
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Set once code generation from strings is refused (strict CSP); never retried. */
let codegenBlocked = false;

/**
 * Generate a validator for `root`, or `undefined` when the runtime forbids
 * code generation from strings.
 */
export function generate(root: Plan): ((value: unknown) => value is unknown) | undefined {
	if (codegenBlocked) return undefined;
	const source = new Generator().program(root);
	let factory: (refs: unknown[], helpers: typeof HELPERS) => (value: unknown) => value is unknown;
	try {
		factory = new Function("R", "H", source.code) as typeof factory;
	} catch (error) {
		if (!(error instanceof EvalError)) throw error;
		codegenBlocked = true;
		return undefined;
	}
	return factory(source.refs, HELPERS);
}

function literal(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function isPrimitive(value: unknown): boolean {
	return value === null || (typeof value !== "object" && typeof value !== "function");
}

/** Boolean expression: `x` matches `types`. */
function typeTest(types: number, x: string): string {
	const tests: string[] = [];
	if (types & T_OBJECT) tests.push(`(typeof ${x}==="object"&&${x}!==null&&!Array.isArray(${x}))`);
	if (types & T_ARRAY) tests.push(`Array.isArray(${x})`);
	if (types & T_STRING) tests.push(`typeof ${x}==="string"`);
	if (types & T_NUMBER) tests.push(`Number.isFinite(${x})`);
	else if (types & T_INTEGER) tests.push(`Number.isInteger(${x})`);
	if (types & T_BOOLEAN) tests.push(`typeof ${x}==="boolean"`);
	if (types & T_NULL) tests.push(`${x}===null`);
	return tests.length === 1 ? tests[0] : `(${tests.join("||")})`;
}

/** Boolean expression: `x` does not match `types` (single kinds avoid a negated group). */
function typeMismatch(types: number, x: string): string {
	switch (types) {
		case T_OBJECT:
			return `typeof ${x}!=="object"||${x}===null||Array.isArray(${x})`;
		case T_ARRAY:
			return `!Array.isArray(${x})`;
		case T_STRING:
			return `typeof ${x}!=="string"`;
		case T_NUMERIC:
			return `!Number.isFinite(${x})`;
		case T_INTEGER:
			return `!Number.isInteger(${x})`;
		case T_BOOLEAN:
			return `typeof ${x}!=="boolean"`;
		case T_NULL:
			return `${x}!==null`;
		default:
			return `!${typeTest(types, x)}`;
	}
}

/** Leaf plans have no subschemas, so inlining them repeatedly stays small. */
function isLeaf(plan: Plan): boolean {
	return (
		plan.refs === undefined &&
		plan.prefixItems === undefined &&
		plan.items === undefined &&
		plan.contains === undefined &&
		plan.properties === undefined &&
		plan.patternProperties === undefined &&
		plan.additionalProperties === undefined &&
		plan.propertyNames === undefined &&
		plan.dependentSchemas === undefined &&
		plan.allOf === undefined &&
		plan.anyOf === undefined &&
		plan.oneOf === undefined &&
		plan.not === undefined &&
		plan.if === undefined
	);
}

class Generator {
	readonly #refs: unknown[] = [];
	readonly #refIndex = new Map<unknown, number>();
	readonly #functions = new Map<Plan, string>();
	readonly #queue: Plan[] = [];
	readonly #inlined = new Set<Plan>();
	readonly #inlining = new Set<Plan>();
	/** Pattern source → name of its char-code function or `RegExp` ref. */
	readonly #patterns = new Map<string, string>();
	readonly #helpers: string[] = [];
	#counter = 0;

	program(root: Plan): { code: string; refs: unknown[] } {
		const entry = this.#fn(root);
		const functions: string[] = [];
		for (let index = 0; index < this.#queue.length; index++) {
			const plan = this.#queue[index];
			this.#inlining.add(plan);
			const body = this.#emitInline(plan, "x", "return false", T_ANY);
			this.#inlining.delete(plan);
			functions.push(`function ${this.#functions.get(plan)}(x){${body}return true}`);
		}
		let prelude = "const{eq,inc,uniq,mult,cpl,own}=H;";
		for (let index = 0; index < this.#refs.length; index++) prelude += `const r${index}=R[${index}];`;
		return { code: `${prelude}${this.#helpers.join("")}${functions.join("")}return ${entry};`, refs: this.#refs };
	}

	#name(prefix: string): string {
		return `${prefix}${this.#counter++}`;
	}

	#ref(value: unknown): string {
		let index = this.#refIndex.get(value);
		if (index === undefined) {
			index = this.#refs.length;
			this.#refs.push(value);
			this.#refIndex.set(value, index);
		}
		return `r${index}`;
	}

	#fn(plan: Plan): string {
		let name = this.#functions.get(plan);
		if (name === undefined) {
			name = `f${this.#functions.size}`;
			this.#functions.set(plan, name);
			this.#queue.push(plan);
		}
		return name;
	}

	/** Code that runs `fail` unless `x` satisfies `plan`; `known` is a type mask `x` already satisfies. */
	#emit(plan: Plan, x: string, fail: string, known: number): string {
		if (plan.types === 0) return `${fail};`;
		if (plan.empty) return "";
		if (this.#inlining.has(plan) || (this.#inlined.has(plan) && !isLeaf(plan))) {
			return `if(!${this.#fn(plan)}(${x}))${fail};`;
		}
		this.#inlined.add(plan);
		this.#inlining.add(plan);
		const code = this.#emitInline(plan, x, fail, known);
		this.#inlining.delete(plan);
		return code;
	}

	#emitInline(plan: Plan, x: string, fail: string, known: number): string {
		if (plan.types === 0) return `${fail};`;
		if (plan.empty) return "";
		if (plan.unevaluatedProperties !== undefined || plan.unevaluatedItems !== undefined) {
			const check = (value: unknown): boolean => validate(plan, value);
			return `if(!${this.#ref(check)}(${x}))${fail};`;
		}
		if (isRefOnly(plan)) return this.#emitRefs(plan.refs!, x, fail);

		let out = "";
		let kind = known;
		const types = plan.types;
		if (types !== T_ANY && (known === 0 || (types & known) !== known)) {
			out += `if(${typeMismatch(types, x)})${fail};`;
			kind = kindOf(types);
		}
		if (plan.hasConst) {
			out += isPrimitive(plan.constValue)
				? `if(${x}!==${literal(plan.constValue)})${fail};`
				: `if(!eq(${x},${this.#ref(plan.constValue)}))${fail};`;
		}
		if (plan.enumValues !== undefined) out += this.#emitEnum(plan.enumValues, x, fail);
		out += this.#emitNumber(plan, x, fail, kind);
		out += this.#emitString(plan, x, fail, kind);
		out += this.#emitArray(plan, x, fail, kind);
		out += this.#emitObject(plan, x, fail, kind);
		if (plan.refs !== undefined) out += this.#emitRefs(plan.refs, x, fail);
		if (plan.allOf !== undefined) for (const branch of plan.allOf) out += this.#emit(branch, x, fail, kind);
		if (plan.anyOf !== undefined) out += this.#emitUnion(plan.anyOf, x, fail, kind, false);
		if (plan.oneOf !== undefined) out += this.#emitUnion(plan.oneOf, x, fail, kind, true);
		if (plan.not !== undefined) {
			const label = this.#name("L");
			out += `${label}:{${this.#emit(plan.not, x, `break ${label}`, kind)}${fail};}`;
		}
		if (plan.if !== undefined && (plan.ifThen !== undefined || plan.ifElse !== undefined)) {
			const done = this.#name("L");
			const otherwise = this.#name("L");
			const then = plan.ifThen === undefined ? "" : this.#emit(plan.ifThen, x, fail, kind);
			const elseCode = plan.ifElse === undefined ? "" : this.#emit(plan.ifElse, x, fail, kind);
			out += `${done}:{${otherwise}:{${this.#emit(plan.if, x, `break ${otherwise}`, kind)}${then}break ${done};}${elseCode}}`;
		}
		return out;
	}

	#emitRefs(refs: readonly Plan[], x: string, fail: string): string {
		let out = "";
		for (const ref of refs) {
			const target = unwrapRef(ref);
			if (target.types === 0) return `${fail};`;
			if (target.empty) continue;
			out += `if(!${this.#fn(target)}(${x}))${fail};`;
		}
		return out;
	}

	#emitEnum(values: readonly unknown[], x: string, fail: string): string {
		if (!values.every(isPrimitive)) return `if(!inc(${this.#ref(values)},${x}))${fail};`;
		if (values.length === 0) return `${fail};`;
		if (values.length <= 8) return `if(${values.map(value => `${x}!==${literal(value)}`).join("&&")})${fail};`;
		return `if(!${this.#ref(new Set(values))}.has(${x}))${fail};`;
	}

	#emitNumber(plan: Plan, x: string, fail: string, kind: number): string {
		let out = "";
		if (plan.minimum !== undefined) out += `if(${x}<${plan.minimum})${fail};`;
		if (plan.exclusiveMinimum !== undefined) out += `if(${x}<=${plan.exclusiveMinimum})${fail};`;
		if (plan.maximum !== undefined) out += `if(${x}>${plan.maximum})${fail};`;
		if (plan.exclusiveMaximum !== undefined) out += `if(${x}>=${plan.exclusiveMaximum})${fail};`;
		if (plan.multipleOf !== undefined) {
			out += Number.isInteger(plan.multipleOf)
				? `if(${x}%${plan.multipleOf}!==0)${fail};`
				: `if(!mult(${x},${plan.multipleOf}))${fail};`;
		}
		if (out === "" || (kind !== 0 && (kind & T_NUMERIC) === kind)) return out;
		return `if(typeof ${x}==="number"){${out}}`;
	}

	#emitString(plan: Plan, x: string, fail: string, kind: number): string {
		let out = "";
		const { minLength, maxLength } = plan;
		if (minLength !== undefined && minLength > 0) {
			out +=
				minLength === 1
					? `if(${x}.length<1)${fail};`
					: `if(${x}.length<${minLength * 2}&&cpl(${x})<${minLength})${fail};`;
		}
		if (maxLength !== undefined) out += `if(${x}.length>${maxLength}&&cpl(${x})>${maxLength})${fail};`;
		if (plan.pattern !== undefined) out += `if(!${this.#pattern(plan.pattern)}(${x}))${fail};`;
		if (plan.format !== undefined) out += `if(!${this.#ref(plan.format)}(${x}))${fail};`;
		if (out === "" || kind === T_STRING) return out;
		return `if(typeof ${x}==="string"){${out}}`;
	}

	/** Callee testing a string against `pattern`: a char-code function when simple, else the regex's `test`. */
	#pattern(pattern: RegExp): string {
		let callee = this.#patterns.get(pattern.source);
		if (callee === undefined) {
			const name = this.#name("pat");
			const helper = compileSimplePattern(pattern.source, name);
			if (helper === undefined) {
				callee = `${this.#ref(pattern)}.test`;
			} else {
				this.#helpers.push(helper);
				callee = name;
			}
			this.#patterns.set(pattern.source, callee);
		}
		return callee;
	}

	#emitArray(plan: Plan, x: string, fail: string, kind: number): string {
		const n = this.#name("n");
		let out = "";
		if (plan.minItems !== undefined && plan.minItems > 0) out += `if(${n}<${plan.minItems})${fail};`;
		if (plan.maxItems !== undefined) out += `if(${n}>${plan.maxItems})${fail};`;
		const prefix = plan.prefixItems ?? [];
		for (let index = 0; index < prefix.length; index++) {
			const item = prefix[index];
			if (item.empty) continue;
			const element = this.#name("e");
			out += `if(${n}>${index}){const ${element}=${x}[${index}];${this.#emit(item, element, fail, 0)}}`;
		}
		if (plan.items !== undefined && !plan.items.empty) {
			if (plan.items.types === 0) {
				out += `if(${n}>${prefix.length})${fail};`;
			} else {
				const index = this.#name("i");
				const element = this.#name("e");
				out += `for(let ${index}=${prefix.length};${index}<${n};${index}++){const ${element}=${x}[${index}];${this.#emit(plan.items, element, fail, 0)}}`;
			}
		}
		if (plan.contains !== undefined) {
			const atLeast = plan.minContains ?? 1;
			const atMost = plan.maxContains;
			if (atLeast > 0 || atMost !== undefined) {
				const count = this.#name("c");
				const index = this.#name("i");
				const label = this.#name("L");
				const element = `${x}[${index}]`;
				const early = atMost === undefined ? `if(${count}>=${atLeast})break;` : "";
				out += `let ${count}=0;for(let ${index}=0;${index}<${n};${index}++){${label}:{${this.#emit(plan.contains, element, `break ${label}`, 0)}${count}++;${early}}}`;
				if (atLeast > 0) out += `if(${count}<${atLeast})${fail};`;
				if (atMost !== undefined) out += `if(${count}>${atMost})${fail};`;
			}
		}
		if (plan.uniqueItems) out += `if(!uniq(${x}))${fail};`;
		if (out === "") return out;
		out = `const ${n}=${x}.length;${out}`;
		return kind === T_ARRAY ? out : `if(Array.isArray(${x})){${out}}`;
	}

	#get(x: string, key: string): string {
		const access = IDENTIFIER.test(key) ? `${x}.${key}` : `${x}[${JSON.stringify(key)}]`;
		return isInheritedName(key) ? `(own(${x},${JSON.stringify(key)})?${access}:undefined)` : access;
	}

	#emitObject(plan: Plan, x: string, fail: string, kind: number): string {
		let out = "";
		const required = new Set(plan.required);
		const properties = plan.properties ?? [];
		const declared = new Set(properties.map(property => property.key));
		for (const key of required) {
			if (!declared.has(key)) out += `if(${this.#get(x, key)}===undefined)${fail};`;
		}
		// Closed objects whose required keys are all declared: when the key count equals the number of
		// declared keys present, no other key exists; otherwise a slow pass finds the undeclared one.
		const additional = plan.additionalProperties;
		const counted =
			additional !== undefined &&
			additional.types === 0 &&
			plan.patternProperties === undefined &&
			(plan.propertyNames === undefined || plan.propertyNames.empty) &&
			plan.minProperties === undefined &&
			plan.maxProperties === undefined &&
			[...required].every(key => declared.has(key));
		const present = this.#name("pc");
		let optional = false;
		for (const property of properties) {
			const isRequired = required.has(property.key);
			if (property.plan.empty) {
				if (isRequired) out += `if(${this.#get(x, property.key)}===undefined)${fail};`;
				else if (counted) {
					out += `if(${this.#get(x, property.key)}!==undefined)${present}++;`;
					optional = true;
				}
				continue;
			}
			const value = this.#name("p");
			const check = this.#emit(property.plan, value, fail, 0);
			out += `const ${value}=${this.#get(x, property.key)};`;
			if (isRequired) out += `if(${value}===undefined)${fail};${check}`;
			else {
				out += `if(${value}!==undefined){${counted ? `${present}++;` : ""}${check}}`;
				optional ||= counted;
			}
		}
		if (counted) {
			const key = this.#name("k");
			const count = this.#name("c");
			const expected = optional ? present : String(required.size);
			if (optional) out = `let ${present}=${required.size};${out}`;
			out += `let ${count}=0;for(const ${key} in ${x})${count}++;`;
			out += `if(${count}!==${expected}){for(const ${key} in ${x})if(!${this.#isDeclared(key, declared)})${fail};}`;
		} else {
			out += this.#emitKeys(plan, x, fail, declared);
		}
		if (plan.dependentRequired !== undefined) {
			for (const dependency of plan.dependentRequired) {
				const missing = dependency.required.map(key => `${this.#get(x, key)}===undefined`).join("||");
				out += `if(${this.#get(x, dependency.key)}!==undefined&&(${missing}))${fail};`;
			}
		}
		if (plan.dependentSchemas !== undefined) {
			for (const dependency of plan.dependentSchemas) {
				out += `if(${this.#get(x, dependency.key)}!==undefined){${this.#emit(dependency.plan, x, fail, T_OBJECT)}}`;
			}
		}
		if (out === "" || kind === T_OBJECT) return out;
		return `if(typeof ${x}==="object"&&${x}!==null&&!Array.isArray(${x})){${out}}`;
	}

	/** The `for…in` pass: `patternProperties`, `additionalProperties`, `propertyNames`, property counts. */
	#emitKeys(plan: Plan, x: string, fail: string, declared: Set<string>): string {
		const patterns = plan.patternProperties;
		const additional = plan.additionalProperties;
		const names = plan.propertyNames;
		const { minProperties, maxProperties } = plan;
		const counting = minProperties !== undefined || maxProperties !== undefined;
		const checkAdditional = additional !== undefined && !additional.empty;
		const checkNames = names !== undefined && !names.empty;
		if (patterns === undefined && !checkAdditional && !checkNames && !counting) return "";
		const key = this.#name("k");
		const count = this.#name("c");
		let body = "";
		if (counting) body += `${count}++;`;
		if (checkNames) body += this.#emit(names, key, fail, T_STRING);
		if (patterns !== undefined || checkAdditional) {
			const matched = this.#name("m");
			const tracking = checkAdditional && (patterns !== undefined || declared.size > 0);
			if (tracking) body += `let ${matched}=${this.#isDeclared(key, declared)};`;
			for (const { pattern, plan: patternPlan } of patterns ?? []) {
				const value = this.#name("v");
				const check = patternPlan.empty
					? ""
					: `const ${value}=${x}[${key}];${this.#emit(patternPlan, value, fail, 0)}`;
				const mark = tracking ? `${matched}=true;` : "";
				if (check !== "" || mark !== "") body += `if(${this.#ref(pattern)}.test(${key})){${mark}${check}}`;
			}
			if (checkAdditional) {
				const value = this.#name("v");
				const check =
					additional.types === 0
						? `${fail};`
						: `const ${value}=${x}[${key}];${this.#emit(additional, value, fail, 0)}`;
				body += tracking ? `if(!${matched}){${check}}` : `{${check}}`;
			}
		}
		let out = `for(const ${key} in ${x}){${body}}`;
		if (counting) {
			out = `let ${count}=0;${out}`;
			if (minProperties !== undefined) out += `if(${count}<${minProperties})${fail};`;
			if (maxProperties !== undefined) out += `if(${count}>${maxProperties})${fail};`;
		}
		return out;
	}

	#isDeclared(key: string, declared: Set<string>): string {
		if (declared.size === 0) return "false";
		if (declared.size > 8) return `${this.#ref(declared)}.has(${key})`;
		return `(${[...declared].map(name => `${key}===${JSON.stringify(name)}`).join("||")})`;
	}

	#emitUnion(branches: readonly Plan[], x: string, fail: string, kind: number, exclusive: boolean): string {
		const discriminator = findDiscriminator(branches);
		if (discriminator !== undefined) {
			const byBranch = new Map<number, unknown[]>();
			for (const [tag, index] of discriminator.branches) {
				const tags = byBranch.get(index);
				if (tags === undefined) byBranch.set(index, [tag]);
				else tags.push(tag);
			}
			let cases = "";
			for (const [index, tags] of byBranch) {
				cases += `${tags.map(tag => `case ${literal(tag)}:`).join("")}{${this.#emit(branches[index], x, fail, T_OBJECT)}break;}`;
			}
			const guard = kind === T_OBJECT ? "" : `if(${typeMismatch(T_OBJECT, x)})${fail};`;
			return `${guard}switch(${this.#get(x, discriminator.key)}){${cases}default:${fail};}`;
		}
		if (!exclusive && branches.some(branch => branch.empty)) return "";
		if (exclusive) {
			const count = this.#name("c");
			let out = `let ${count}=0;`;
			for (const branch of branches) {
				const label = this.#name("L");
				out += `${label}:{${this.#emit(branch, x, `break ${label}`, kind)}if(++${count}>1)${fail};}`;
			}
			return `${out}if(${count}===0)${fail};`;
		}
		const done = this.#name("L");
		let out = `${done}:{`;
		for (const branch of branches) {
			const label = this.#name("L");
			out += `${label}:{${this.#emit(branch, x, `break ${label}`, kind)}break ${done};}`;
		}
		return `${out}${fail};}`;
	}
}
