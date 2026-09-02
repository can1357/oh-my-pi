/**
 * JIT compiler: lowers schema IR into a specialized validator via
 * `new Function`. Invoked by `type.ts` after a schema's third call; the
 * interpreter (`interp.ts`) covers earlier calls so rarely-used schemas never
 * pay codegen cost.
 *
 * Generated code philosophy:
 * - success path is straight-line monomorphic JS with zero allocation; when
 *   the schema has no morphs the input value itself is returned
 * - failure allocates a single `OmpErrors` (`E(path, expected, data)`); path
 *   arrays and messages are inline literals, so cost is one small allocation
 * - morphing nodes (defaults, `"+": "delete"`, embedded stepped schemas)
 *   produce a fresh output object; pure subtrees below them stay check-only
 * - morphing union members use separately compiled or hoisted runners; pure
 *   members compile to inline predicates
 */
import { MISSING, OmpErrors } from "./errors";
import { canRefineUnionFailure, materializeDefault, unionFail, walk } from "./interp";
import { expectedOf, hasMorph, type IR, type MorphContext, type PropIR, type TupleIR } from "./ir";

const own = Object.prototype.hasOwnProperty;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Inline-able literal, else undefined (caller hoists into the refs pool). */
function litSource(v: unknown): string | undefined {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	switch (typeof v) {
		case "string":
		case "boolean":
			return JSON.stringify(v);
		case "number":
			return Number.isFinite(v) ? String(v) : undefined;
		default:
			return undefined;
	}
}

type PathSeg = { s: PropertyKey } | { d: string };

type LiteralIR = Extract<IR, { k: "lit" }>;

function isPrimitiveLiteral(node: IR): node is LiteralIR {
	return node.k === "lit" && (node.v === null || (typeof node.v !== "object" && typeof node.v !== "function"));
}

/** Whether `undefined` necessarily fails, allowing property-presence checks to be elided. */
function rejectsUndefined(node: IR): boolean {
	switch (node.k) {
		case "unknown":
		case "undefined":
		case "alias":
		case "sub":
			return false;
		case "lit":
			return node.v !== undefined;
		case "union":
			return node.members.every(rejectsUndefined);
		case "intersection":
			return node.members.some(rejectsUndefined);
		case "refine":
			return rejectsUndefined(node.base);
		case "morph":
			return rejectsUndefined(node.input);
		default:
			return true;
	}
}

class CompiledMorphContext implements MorphContext {
	#path: PropertyKey[] | PropertyKey | undefined;
	#data: unknown;

	constructor(path: PropertyKey[] | PropertyKey | undefined, data: unknown) {
		this.#path = path;
		this.#data = data;
	}

	error(expectation: string): OmpErrors {
		return new OmpErrors(this.#path, expectation, this.#data);
	}

	reject(expectation: string): OmpErrors {
		return this.error(expectation);
	}
}

class Builder {
	#lines: string[] = [];
	#refs: unknown[] = [];
	#activeAliases: Set<IR> | undefined;
	#id = 0;

	next(prefix: string): string {
		return `${prefix}${this.#id++}`;
	}

	push(line: string): void {
		this.#lines.push(line);
	}

	ref(value: unknown): string {
		const idx = this.#refs.indexOf(value);
		if (idx >= 0) return `R[${idx}]`;
		this.#refs.push(value);
		return `R[${this.#refs.length - 1}]`;
	}

	lit(v: unknown): string {
		return litSource(v) ?? this.ref(v);
	}

	access(base: string, key: PropertyKey): string {
		return typeof key === "string" && IDENT.test(key) ? `${base}.${key}` : `${base}[${this.lit(key)}]`;
	}

	pathExpr(segs: PathSeg[]): string {
		const parts = segs.map(seg => ("s" in seg ? this.lit(seg.s) : seg.d));
		return `[${parts.join(",")}]`;
	}

	storedPathExpr(segs: PathSeg[]): string {
		if (segs.length === 0) return "undefined";
		if (segs.length === 1) {
			const seg = segs[0];
			return "s" in seg ? this.lit(seg.s) : seg.d;
		}
		const staticParts: PropertyKey[] = [];
		for (const seg of segs) {
			if ("d" in seg) return this.pathExpr(segs);
			staticParts.push(seg.s);
		}
		return this.ref(staticParts);
	}

	error(segs: PathSeg[], expected: string, dataExpr: string): string {
		return `new AE(${this.storedPathExpr(segs)},${JSON.stringify(expected)},${dataExpr})`;
	}

	fail(segs: PathSeg[], expected: string, dataExpr: string): string {
		return `return ${this.error(segs, expected, dataExpr)}`;
	}

	appendError(errors: string, error: string): string {
		return `if(${errors}===undefined)${errors}=${error};else ${errors}.append(${error});`;
	}

	/** Pure boolean predicate for a morph-free subtree. */
	predicate(node: IR, v: string): string {
		switch (node.k) {
			case "unknown":
				return "true";
			case "null":
				return `${v}===null`;
			case "undefined":
				return `${v}===undefined`;
			case "boolean":
				return `typeof ${v}==="boolean"`;
			case "bigint":
				return `typeof ${v}==="bigint"`;
			case "symbol":
				return `typeof ${v}==="symbol"`;
			case "never":
				return "false";
			case "anyobject":
				return `(typeof ${v}==="object"&&${v}!==null)`;
			case "lit":
				return node.v instanceof Date
					? `(${v} instanceof Date&&${v}.valueOf()===${node.v.valueOf()})`
					: `${v}===${this.lit(node.v)}`;
			case "instance":
				return `${v} instanceof ${this.ref(node.ctor)}`;
			case "string": {
				let out = `typeof ${v}==="string"`;
				if (node.min !== undefined) out += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) out += `&&${v}.length<=${node.max}`;
				if (node.url) out += `&&URL.canParse(${v})`;
				return out;
			}
			case "number": {
				let out = node.int ? `Number.isInteger(${v})` : `Number.isFinite(${v})`;
				if (node.divisor !== undefined) out += `&&${v}%${node.divisor}===0`;
				if (node.min !== undefined) out += `&&${v}${node.xmin ? ">" : ">="}${node.min}`;
				if (node.max !== undefined) out += `&&${v}${node.xmax ? "<" : "<="}${node.max}`;
				return out;
			}
			case "union": {
				const lits = node.members.filter(isPrimitiveLiteral);
				if (lits.length > 8) {
					const values = this.ref(new Set(lits.map(member => member.v)));
					const literalNodes = new Set<IR>(lits);
					const rest = node.members.filter(member => !literalNodes.has(member));
					let out = `${values}.has(${v})`;
					for (const m of rest) out += `||(${this.predicate(m, v)})`;
					return `(${out})`;
				}
				return `(${node.members.map(m => `(${this.predicate(m, v)})`).join("||")})`;
			}
			case "intersection":
				return `(${node.members.map(member => `(${this.predicate(member, v)})`).join("&&")})`;
			case "array": {
				const array = this.next("a");
				const index = this.next("i");
				let out = `Array.isArray(${v})`;
				if (node.min !== undefined) out += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) out += `&&${v}.length<=${node.max}`;
				const item = `${array}[${index}]`;
				out += `&&((${array})=>{for(let ${index}=0;${index}<${array}.length;${index}++)if(!(${this.predicate(node.el, item)}))return false;return true})(${v})`;
				return out;
			}
			case "object": {
				const checks = [`typeof ${v}==="object"`, `${v}!==null`];
				for (const p of node.props) {
					const av = this.access(v, p.key);
					const present = `${this.lit(p.key)} in ${v}`;
					const predicate = this.predicate(p.val, av);
					checks.push(
						p.opt || p.hasDefault
							? rejectsUndefined(p.val)
								? `((${av}!==undefined&&(${predicate}))||!(${present}))`
								: `(!(${present})||(${predicate}))`
							: rejectsUndefined(p.val)
								? predicate
								: `((${present})&&(${predicate}))`,
					);
				}
				const stringKey = this.next("k");
				if (node.index !== undefined) {
					checks.push(
						`(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.predicate(node.index, `${v}[${stringKey}]`)}))return false;return true})()`,
					);
				}
				if (node.patternIndexes !== undefined) {
					for (const pattern of node.patternIndexes) {
						checks.push(
							`(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&(${this.predicate(pattern.key, stringKey)})&&!(${this.predicate(pattern.val, `${v}[${stringKey}]`)}))return false;return true})()`,
						);
					}
				}
				if (node.symbolIndex !== undefined) {
					const symbol = this.next("s");
					checks.push(
						`(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.predicate(node.symbolIndex, `${v}[${symbol}]`)}))return false;return true})()`,
					);
				}
				if (node.extras === "reject") {
					const patternMatch =
						node.patternIndexes?.map(pattern => `(${this.predicate(pattern.key, stringKey)})`).join("||") ??
						"false";
					if (node.index === undefined) {
						checks.push(
							`(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;return true})()`,
						);
					}
					if (node.symbolIndex === undefined) {
						const symbol = this.next("s");
						checks.push(
							`(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;return true})()`,
						);
					}
				}
				return `(${checks.join("&&")})`;
			}
			case "sub":
				return `!(${this.ref(node.schema.run)}(${v}) instanceof AE)`;
			default:
				return `!(${this.ref(boundWalk(node))}(${v}) instanceof AE)`;
		}
	}

	declaredCheck(props: PropIR[], keyVar: string): string {
		if (props.length === 0) return "false";
		if (props.length > 6) {
			const set = this.ref(new Set(props.map(p => p.key)));
			return `${set}.has(${keyVar})`;
		}
		return `(${props.map(p => `${keyVar}===${this.lit(p.key)}`).join("||")})`;
	}

	/**
	 * Run a node through its interpreter/sub-schema runner, appending any
	 * failure to `errors`. `brk` (when given) exits the enclosing block on
	 * failure so dependent statements (output assignment, morph fns) are
	 * skipped. Both runner kinds receive the absolute path so nested step
	 * callbacks observe ctx.path; walk-produced errors are already absolute,
	 * while sub runners return schema-relative errors that need prefixing.
	 */
	emitCollectDelegate(node: IR, v: string, segs: PathSeg[], errors: string, brk?: string, out?: string): void {
		const sub = node.k === "sub";
		const runner = sub ? node.schema.run : boundWalk(node);
		const result = this.next("r");
		const args = segs.length > 0 ? `${v},${this.pathExpr(segs)}` : v;
		this.push(`const ${result}=${this.ref(runner)}(${args});`);
		const failure = sub && segs.length > 0 ? `PF(${result},${this.pathExpr(segs)})` : result;
		this.push(
			`if(${result} instanceof AE){${this.appendError(errors, failure)}${brk === undefined ? "" : `break ${brk};`}}`,
		);
		if (out !== undefined) this.push(`${out}=${result};`);
	}

	/** Snapshot the error count so sequencing sites can detect soft failures. */
	markErrors(errors: string): string {
		const mark = this.next("n");
		this.push(`const ${mark}=${errors}===void 0?0:${errors}.length;`);
		return mark;
	}

	/** Exit `brk` when errors were appended since `mark` (interp's return-on-error). */
	guardGrowth(errors: string, mark: string, brk: string): void {
		this.push(`if((${errors}===void 0?0:${errors}.length)!==${mark})break ${brk};`);
	}

	/** Aggregate every independent failure in a morph-free subtree. */
	emitCollectCheck(node: IR, v: string, segs: PathSeg[], errors: string, failureData = v): void {
		if (node.cfg !== undefined || node.k === "refine") {
			this.emitCollectDelegate(node, v, segs, errors);
			return;
		}
		switch (node.k) {
			case "unknown":
				return;
			case "array": {
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}}`,
				);
				if (node.min !== undefined) {
					this.push(
						`else if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, `at least length ${node.min}`, `${v}.length`),
						)}}`,
					);
				}
				if (node.max !== undefined) {
					this.push(
						`else if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, `at most length ${node.max}`, `${v}.length`),
						)}}`,
					);
				}
				this.push("else{");
				const index = this.next("i");
				this.push(`for(let ${index}=0;${index}<${v}.length;${index}++){`);
				this.emitCollectCheck(node.el, `${v}[${index}]`, [...segs, { d: index }], errors);
				this.push("}}");
				return;
			}
			case "tuple": {
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}}else{`,
				);
				const requiredPrefix = node.prefix.filter(item => !item.opt && !item.hasDefault).length;
				const minimum = requiredPrefix + node.postfix.length;
				const maximum = node.prefix.length + node.postfix.length;
				if (minimum > 0) {
					this.push(
						`if(${v}.length<${minimum}){${this.appendError(
							errors,
							this.error(segs, `an array of at least length ${minimum}`, failureData),
						)}}else{`,
					);
				}
				if (node.variadic === undefined) {
					this.push(
						`if(${v}.length>${maximum}){${this.appendError(
							errors,
							this.error(segs, `an array of at most length ${maximum}`, failureData),
						)}}else{`,
					);
				}
				let postfixStart = `${v}.length`;
				if (node.postfix.length > 0) {
					postfixStart = this.next("p");
					this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
				}
				let prefixCount = String(node.prefix.length);
				if (requiredPrefix !== node.prefix.length) {
					prefixCount = this.next("n");
					this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
				}
				for (let index = 0; index < node.prefix.length; index++) {
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					this.emitCollectCheck(node.prefix[index].val, `${v}[${index}]`, [...segs, { d: String(index) }], errors);
					if (index >= requiredPrefix) this.push("}");
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					this.push(`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){`);
					this.emitCollectCheck(node.variadic, `${v}[${index}]`, [...segs, { d: index }], errors);
					this.push("}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					this.emitCollectCheck(node.postfix[index], `${v}[${inputIndex}]`, [...segs, { d: inputIndex }], errors);
				}
				if (node.variadic === undefined) this.push("}");
				if (minimum > 0) this.push("}");
				this.push("}");
				return;
			}
			case "object": {
				if (
					node.patternIndexes !== undefined ||
					node.symbolIndex !== undefined ||
					node.props.some(prop => typeof prop.key === "symbol")
				) {
					this.emitCollectDelegate(node, v, segs, errors);
					return;
				}
				this.push(
					`if(typeof ${v}!=="object"||${v}===null){${this.appendError(
						errors,
						this.error(segs, "an object", failureData),
					)}}else{`,
				);
				for (const prop of node.props) {
					const present = `${this.lit(prop.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: prop.key }];
					if (prop.opt || prop.hasDefault) {
						this.push(`if(${present}){`);
						this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
						this.push("}");
					} else {
						this.push(
							`if(!(${present})){${this.appendError(
								errors,
								this.error(propSegs, expectedOf(prop.val), "M"),
							)}}else{`,
						);
						this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
						this.push("}");
					}
				}
				if (node.index !== undefined) {
					const key = this.next("k");
					this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){`);
					this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
					this.push("}");
				} else if (node.extras === "reject") {
					const key = this.next("k");
					this.push(
						`for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){`,
					);
					this.push(this.appendError(errors, this.error([...segs, { d: key }], "removed", `${v}[${key}]`)));
					this.push("}");
				}
				if (node.extras === "reject") {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], "removed", `${v}[${symbol}]`))}}`,
					);
				}
				this.push("}");
				return;
			}
			case "union": {
				const failure = node.members.some(canRefineUnionFailure)
					? `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`
					: this.error(segs, expectedOf(node), failureData);
				this.push(`if(!(${this.predicate(node, v)})){${this.appendError(errors, failure)}}`);
				return;
			}
			case "string": {
				this.push(
					`if(typeof ${v}!=="string"){${this.appendError(errors, this.error(segs, "a string", failureData))}}`,
				);
				if (node.min !== undefined) {
					this.push(
						`else if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, `at least length ${node.min}`, `${v}.length`),
						)}}`,
					);
				}
				if (node.max !== undefined) {
					this.push(
						`else if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, `at most length ${node.max}`, `${v}.length`),
						)}}`,
					);
				}
				if (node.url) {
					this.push(
						`else if(!URL.canParse(${v})){${this.appendError(
							errors,
							this.error(segs, "a URL string", failureData),
						)}}`,
					);
				}
				return;
			}
			case "number": {
				this.push(
					`if(typeof ${v}!=="number"||!Number.isFinite(${v})){${this.appendError(
						errors,
						this.error(segs, node.int ? "an integer" : "a number", failureData),
					)}}else{`,
				);
				if (node.int) {
					this.push(
						`if(!Number.isInteger(${v})){${this.appendError(errors, this.error(segs, "an integer", failureData))}}`,
					);
				}
				if (node.divisor !== undefined) {
					this.push(
						`if(${v}%${node.divisor}!==0){${this.appendError(
							errors,
							this.error(segs, `a number divisible by ${node.divisor}`, failureData),
						)}}`,
					);
				}
				if (node.min !== undefined) {
					const expected =
						node.min === 0
							? node.xmin
								? "positive"
								: "non-negative"
							: `a number ${node.xmin ? "more than" : "at least"} ${node.min}`;
					this.push(
						`if(${v}${node.xmin ? "<=" : "<"}${node.min}){${this.appendError(
							errors,
							this.error(segs, expected, failureData),
						)}}`,
					);
				}
				if (node.max !== undefined) {
					const expected =
						node.max === 0
							? node.xmax
								? "negative"
								: "non-positive"
							: `a number ${node.xmax ? "less than" : "at most"} ${node.max}`;
					this.push(
						`if(${v}${node.xmax ? ">=" : ">"}${node.max}){${this.appendError(
							errors,
							this.error(segs, expected, failureData),
						)}}`,
					);
				}
				this.push("}");
				return;
			}
			case "lit":
				if (
					(node.v !== null && typeof node.v === "object" && !(node.v instanceof Date)) ||
					typeof node.v === "function"
				) {
					this.emitCollectDelegate(node, v, segs, errors);
				} else {
					this.push(
						`if(!(${this.predicate(node, v)})){${this.appendError(
							errors,
							this.error(segs, expectedOf(node), failureData),
						)}}`,
					);
				}
				return;
			case "intersection":
			case "sub":
				this.emitCollectDelegate(node, v, segs, errors);
				return;
			case "null":
			case "undefined":
			case "boolean":
			case "bigint":
			case "symbol":
			case "never":
			case "anyobject":
			case "instance":
				this.push(
					`if(!(${this.predicate(node, v)})){${this.appendError(
						errors,
						this.error(segs, expectedOf(node), failureData),
					)}}`,
				);
				return;
			default:
				this.emitCollectDelegate(node, v, segs, errors);
		}
	}

	emitTupleShape(
		node: TupleIR,
		v: string,
		segs: PathSeg[],
		errors: string,
		brk: string,
		failureData: string,
	): { postfixStart: string; prefixCount: string; requiredPrefix: number } {
		this.push(
			`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}break ${brk};}`,
		);
		const requiredPrefix = node.prefix.filter(item => !item.opt && !item.hasDefault).length;
		const minimum = requiredPrefix + node.postfix.length;
		if (minimum > 0) {
			this.push(
				`if(${v}.length<${minimum}){${this.appendError(
					errors,
					this.error(segs, `an array of at least length ${minimum}`, failureData),
				)}break ${brk};}`,
			);
		}
		if (node.variadic === undefined) {
			const maximum = node.prefix.length + node.postfix.length;
			this.push(
				`if(${v}.length>${maximum}){${this.appendError(
					errors,
					this.error(segs, `an array of at most length ${maximum}`, failureData),
				)}break ${brk};}`,
			);
		}
		let postfixStart = `${v}.length`;
		if (node.postfix.length > 0) {
			postfixStart = this.next("p");
			this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
		}
		let prefixCount = String(node.prefix.length);
		if (requiredPrefix !== node.prefix.length) {
			prefixCount = this.next("n");
			this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
		}
		return { postfixStart, prefixCount, requiredPrefix };
	}

	/** Fill `target` with a validated default (factory output revalidated per call). */
	emitDefaultFill(val: IR, def: unknown, isFactory: boolean, target: string, segs: PathSeg[], errors: string): void {
		if (isFactory && typeof def === "function") {
			const candidate = this.next("d");
			const resolved = this.next("t");
			const label = this.next("L");
			this.push(`const ${candidate}=${this.ref(def)}();let ${resolved};${label}:{`);
			this.emitCollectProduce(val, candidate, segs, resolved, errors, label);
			this.push(`${target}=${resolved};}`);
		} else {
			// Static defaults were prevalidated at construction; MD clones
			// mutable payloads so callers cannot alias the schema's copy.
			this.push(`${target}=${litSource(def) ?? `MD(${this.ref(def)})`};`);
		}
	}

	/**
	 * Validate `v` against a morphing subtree and assign the produced output
	 * to `out` (an already-declared `let`). Failures append to `errors` and
	 * `break ${brk}` (skipping the output assignment), mirroring interp: an
	 * error in one child never suppresses sibling validation or morphs.
	 */
	emitCollectProduce(
		node: IR,
		v: string,
		segs: PathSeg[],
		out: string,
		errors: string,
		brk: string,
		failureData = v,
	): void {
		if (node.cfg !== undefined || node.k === "refine") {
			this.emitCollectDelegate(node, v, segs, errors, brk, out);
			return;
		}
		if (!hasMorph(node)) {
			this.emitCollectCheck(node, v, segs, errors, failureData);
			this.push(`${out}=${v};`);
			return;
		}
		switch (node.k) {
			case "sub":
				this.emitCollectDelegate(node, v, segs, errors, brk, out);
				return;
			case "morph": {
				const input = this.next("t");
				this.push(`let ${input};`);
				const mark = this.markErrors(errors);
				this.emitCollectProduce(node.input, v, segs, input, errors, brk, failureData);
				this.guardGrowth(errors, mark, brk);
				const context = this.next("c");
				const result = this.next("r");
				this.push(`const ${context}=new MC(${this.storedPathExpr(segs)},${input});`);
				this.push(`const ${result}=${this.ref(node.fn)}(${input},${context});`);
				this.push(`if(${result} instanceof AE){${this.appendError(errors, result)}break ${brk};}`);
				if (node.out === undefined) this.push(`${out}=${result};`);
				else this.emitCollectProduce(node.out, result, segs, out, errors, brk);
				return;
			}
			case "alias": {
				let active = this.#activeAliases;
				if (active === undefined) {
					active = new Set();
					this.#activeAliases = active;
				}
				if (active.has(node)) {
					this.emitCollectDelegate(node, v, segs, errors, brk, out);
					return;
				}
				active.add(node);
				try {
					this.emitCollectProduce(node.resolve(), v, segs, out, errors, brk, failureData);
				} finally {
					active.delete(node);
				}
				return;
			}
			case "union": {
				const ok = this.next("u");
				this.push(`let ${ok}=false;`);
				const label = this.next("b");
				this.push(`${label}:{`);
				for (const m of node.members) {
					if (m.k !== "sub" && !hasMorph(m)) {
						this.push(`if(${this.predicate(m, v)}){${out}=${v};${ok}=true;break ${label};}`);
					}
				}
				for (const m of node.members) {
					if (m.k === "sub" || hasMorph(m)) {
						const runner = m.k === "sub" ? m.schema.run : m.k === "alias" ? boundWalk(m) : compile(m);
						const r = this.next("r");
						this.push(`const ${r}=${this.ref(runner)}(${v});`);
						this.push(`if(!(${r} instanceof AE)){${out}=${r};${ok}=true;break ${label};}`);
					}
				}
				this.push("}");
				const failure = `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`;
				this.push(`if(!${ok}){${this.appendError(errors, failure)}break ${brk};}`);
				return;
			}
			case "array": {
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}break ${brk};}`,
				);
				if (node.min !== undefined) {
					this.push(
						`if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, `at least length ${node.min}`, `${v}.length`),
						)}break ${brk};}`,
					);
				}
				if (node.max !== undefined) {
					this.push(
						`if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, `at most length ${node.max}`, `${v}.length`),
						)}break ${brk};}`,
					);
				}
				const array = this.next("a");
				const index = this.next("i");
				const input = this.next("x");
				const element = this.next("t");
				const label = this.next("L");
				this.push(`const ${array}=new Array(${v}.length);`);
				this.push(
					`for(let ${index}=0;${index}<${v}.length;${index}++){const ${input}=${v}[${index}];let ${element};${label}:{`,
				);
				this.emitCollectProduce(node.el, input, [...segs, { d: index }], element, errors, label);
				this.push(`${array}[${index}]=${element};}}`);
				this.push(`${out}=${array};`);
				return;
			}
			case "tuple": {
				const { postfixStart, prefixCount, requiredPrefix } = this.emitTupleShape(
					node,
					v,
					segs,
					errors,
					brk,
					failureData,
				);
				const tuple = this.next("a");
				this.push(`const ${tuple}=[...${v}];`);
				for (let index = 0; index < node.prefix.length; index++) {
					const item = node.prefix[index];
					const itemSegs: PathSeg[] = [...segs, { s: index }];
					const input = `${v}[${index}]`;
					const output = `${tuple}[${index}]`;
					const label = this.next("L");
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					this.push(`${label}:{`);
					if (hasMorph(item.val)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(item.val, input, itemSegs, temporary, errors, label);
						this.push(`${output}=${temporary};`);
					} else {
						this.emitCollectCheck(item.val, input, itemSegs, errors);
					}
					this.push("}");
					if (index >= requiredPrefix) {
						if (item.hasDefault) {
							this.push("}else{");
							this.emitDefaultFill(item.val, item.def, item.defFactory === true, output, itemSegs, errors);
							this.push("}");
						} else {
							this.push("}");
						}
					}
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					const input = this.next("x");
					const label = this.next("L");
					this.push(
						`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){const ${input}=${v}[${index}];${label}:{`,
					);
					if (hasMorph(node.variadic)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(node.variadic, input, [...segs, { d: index }], temporary, errors, label);
						this.push(`${tuple}[${index}]=${temporary};`);
					} else {
						this.emitCollectCheck(node.variadic, input, [...segs, { d: index }], errors);
					}
					this.push("}}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					const input = `${v}[${inputIndex}]`;
					const item = node.postfix[index];
					const label = this.next("L");
					this.push(`${label}:{`);
					if (hasMorph(item)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(item, input, [...segs, { d: inputIndex }], temporary, errors, label);
						this.push(`${tuple}[${inputIndex}]=${temporary};`);
					} else {
						this.emitCollectCheck(item, input, [...segs, { d: inputIndex }], errors);
					}
					this.push("}");
				}
				this.push(`${out}=${tuple};`);
				return;
			}
			case "object": {
				if (
					node.patternIndexes !== undefined ||
					node.symbolIndex !== undefined ||
					node.props.some(prop => typeof prop.key === "symbol")
				) {
					this.emitCollectDelegate(node, v, segs, errors, brk, out);
					return;
				}
				this.push(
					`if(typeof ${v}!=="object"||${v}===null){${this.appendError(
						errors,
						this.error(segs, "an object", failureData),
					)}break ${brk};}`,
				);
				const object = this.next("o");
				const fresh = node.extras === "delete" && node.index === undefined;
				this.push(fresh ? `const ${object}={};` : `const ${object}={...${v}};`);
				for (const prop of node.props) {
					const present = `${this.lit(prop.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: prop.key }];
					const input = this.access(v, prop.key);
					const output = this.access(object, prop.key);
					const label = this.next("L");
					this.push(`if(!(${present})){`);
					if (prop.hasDefault) {
						this.emitDefaultFill(prop.val, prop.def, prop.defFactory === true, output, propSegs, errors);
					} else if (!prop.opt) {
						this.push(this.appendError(errors, this.error(propSegs, expectedOf(prop.val), "M")));
					}
					this.push(`}else{${label}:{`);
					if (hasMorph(prop.val)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(prop.val, input, propSegs, temporary, errors, label);
						this.push(`${output}=${temporary};`);
					} else {
						this.emitCollectCheck(prop.val, input, propSegs, errors);
						if (fresh) this.push(`${output}=${input};`);
					}
					this.push("}}");
				}
				if (node.index !== undefined) {
					const key = this.next("k");
					const label = this.next("L");
					this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){${label}:{`);
					if (hasMorph(node.index)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(node.index, `${v}[${key}]`, [...segs, { d: key }], temporary, errors, label);
						this.push(`${object}[${key}]=${temporary};`);
					} else {
						this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
					}
					this.push("}}");
				} else if (node.extras === "reject") {
					const key = this.next("k");
					this.push(
						`for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){${this.appendError(
							errors,
							this.error([...segs, { d: key }], "removed", `${v}[${key}]`),
						)}}`,
					);
				}
				if (node.extras === "reject") {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], "removed", `${v}[${symbol}]`))}}`,
					);
				}
				this.push(`${out}=${object};`);
				return;
			}
			case "intersection": {
				const current = this.next("t");
				this.push(`let ${current}=${v};`);
				const mark = this.markErrors(errors);
				for (let index = 0; index < node.members.length; index++) {
					if (index > 0) this.guardGrowth(errors, mark, brk);
					const member = node.members[index];
					if (hasMorph(member)) this.emitCollectProduce(member, current, segs, current, errors, brk);
					else this.emitCollectCheck(member, current, segs, errors);
				}
				this.push(`${out}=${current};`);
				return;
			}
			default:
				this.emitCollectDelegate(node, v, segs, errors, brk, out);
		}
	}

	build(ir: IR): (value: unknown) => unknown {
		const errors = this.next("e");
		let ret: string;
		if (hasMorph(ir)) {
			const label = this.next("L");
			this.push(`let ${errors};let o;${label}:{`);
			this.emitCollectProduce(ir, "v", [], "o", errors, label);
			this.push("}");
			ret = "o";
		} else {
			this.push(`let ${errors};`);
			this.emitCollectCheck(ir, "v", [], errors);
			ret = "v";
		}
		this.push(`if(${errors}!==undefined)return ${errors};`);
		const src = `return function(v){${this.#lines.join("")}return ${ret}}`;
		const make = new Function("R", "AE", "M", "PF", "UF", "MC", "own", "MD", src) as (
			refs: unknown[],
			ae: typeof OmpErrors,
			m: typeof MISSING,
			pf: typeof prefixErrors,
			uf: typeof unionFail,
			mc: typeof CompiledMorphContext,
			ownFn: typeof own,
			md: typeof materializeDefault,
		) => (value: unknown) => unknown;
		return make(
			this.#refs,
			OmpErrors,
			MISSING,
			prefixErrors,
			unionFail,
			CompiledMorphContext,
			own,
			materializeDefault,
		);
	}

	emitAllows(node: IR, v: string): void {
		switch (node.k) {
			case "array": {
				const array = this.next("a");
				const index = this.next("i");
				this.push(`const ${array}=${v};if(!Array.isArray(${array}))return false;`);
				if (node.min !== undefined) this.push(`if(${array}.length<${node.min})return false;`);
				if (node.max !== undefined) this.push(`if(${array}.length>${node.max})return false;`);
				this.push(`for(let ${index}=0;${index}<${array}.length;${index}++){`);
				this.emitAllows(node.el, `${array}[${index}]`);
				this.push("}");
				return;
			}
			case "object": {
				const object = this.next("o");
				this.push(`const ${object}=${v};if(typeof ${object}!=="object"||${object}===null)return false;`);
				for (const prop of node.props) {
					const value = this.next("p");
					const present = `${this.lit(prop.key)} in ${object}`;
					this.push(`const ${value}=${this.access(object, prop.key)};`);
					if (prop.opt || prop.hasDefault) {
						if (rejectsUndefined(prop.val)) {
							this.push(`if(${value}!==undefined){`);
							this.emitAllows(prop.val, value);
							this.push(`}else if(${present})return false;`);
						} else {
							this.push(`if(${present}){`);
							this.emitAllows(prop.val, value);
							this.push("}");
						}
					} else {
						if (!rejectsUndefined(prop.val)) this.push(`if(!(${present}))return false;`);
						this.emitAllows(prop.val, value);
					}
				}
				const stringKey = this.next("k");
				if (node.index !== undefined) {
					this.push(`for(const ${stringKey} in ${object}){if(!own.call(${object},${stringKey}))continue;`);
					this.emitAllows(node.index, `${object}[${stringKey}]`);
					this.push("}");
				}
				if (node.patternIndexes !== undefined) {
					for (const pattern of node.patternIndexes) {
						this.push(
							`for(const ${stringKey} in ${object})if(own.call(${object},${stringKey})&&(${this.predicate(pattern.key, stringKey)})&&!(${this.predicate(pattern.val, `${object}[${stringKey}]`)}))return false;`,
						);
					}
				}
				if (node.symbolIndex !== undefined) {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${object})){if(!Object.prototype.propertyIsEnumerable.call(${object},${symbol}))continue;`,
					);
					this.emitAllows(node.symbolIndex, `${object}[${symbol}]`);
					this.push("}");
				}
				if (node.extras === "reject") {
					const patternMatch =
						node.patternIndexes?.map(pattern => `(${this.predicate(pattern.key, stringKey)})`).join("||") ??
						"false";
					if (node.index === undefined) {
						this.push(
							`for(const ${stringKey} in ${object})if(own.call(${object},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;`,
						);
					}
					if (node.symbolIndex === undefined) {
						const symbol = this.next("s");
						this.push(
							`for(const ${symbol} of Object.getOwnPropertySymbols(${object}))if(Object.prototype.propertyIsEnumerable.call(${object},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;`,
						);
					}
				}
				return;
			}
			case "union": {
				const sources: string[] = [];
				for (const member of node.members) {
					if (!isPrimitiveLiteral(member)) break;
					const source = litSource(member.v);
					if (source === undefined) break;
					sources.push(source);
				}
				if (sources.length === node.members.length && sources.length >= 4) {
					this.push(
						`switch(${v}){${sources.map(source => `case ${source}:`).join("")}break;default:return false;}`,
					);
					return;
				}
				this.push(`if(!(${this.predicate(node, v)}))return false;`);
				return;
			}
			default:
				this.push(`if(!(${this.predicate(node, v)}))return false;`);
		}
	}

	buildAllows(ir: IR): (value: unknown) => value is unknown {
		this.emitAllows(ir, "v");
		const src = `return function(v){${this.#lines.join("")}return true}`;
		const make = new Function("R", "AE", "own", src) as (
			refs: unknown[],
			ae: typeof OmpErrors,
			ownFn: typeof own,
		) => (value: unknown) => value is unknown;
		return make(this.#refs, OmpErrors, own);
	}
}

function prefixErrors(errs: OmpErrors, parts: PropertyKey[]): OmpErrors {
	for (let i = parts.length - 1; i >= 0; i--) errs.prefix(parts[i]);
	return errs;
}

const kWalk = Symbol("omptype.boundWalk");

interface WalkTagged {
	[kWalk]?: (value: unknown, path?: PropertyKey[]) => unknown;
}

/** Cached interpreter closure for recursive aliases and predicate-only fallbacks. */
function boundWalk(node: IR): (value: unknown, path?: PropertyKey[]) => unknown {
	const tagged = node as IR & WalkTagged;
	let fn = tagged[kWalk];
	if (!fn) {
		fn = (value: unknown, path?: PropertyKey[]) => walk(node, value, path);
		tagged[kWalk] = fn;
	}
	return fn;
}

function resolvedRoot(ir: IR): IR {
	return ir.k === "alias" ? ir.resolve() : ir;
}

const compiledCache = new WeakMap<IR, (value: unknown) => unknown>();
const allowsCache = new WeakMap<IR, (value: unknown) => value is unknown>();

/** Compile `ir` into a specialized validator. */
export function compile(ir: IR): (value: unknown) => unknown {
	const root = resolvedRoot(ir);
	const validator = compiledCache.get(root);
	if (validator === undefined) {
		// Publish a deferred wrapper before building: recursive schemas re-enter
		// compile() for the same root mid-build (e.g. an alias element inside an
		// array), and each re-entry must reuse this build instead of starting a
		// fresh one forever. The wrapper resolves to the built validator by call
		// time; the interpreter is a safety net that never triggers post-build.
		const built: { value?: (value: unknown) => unknown } = {};
		compiledCache.set(root, value => (built.value === undefined ? walk(root, value) : built.value(value)));
		const compiled = new Builder().build(root);
		built.value = compiled;
		compiledCache.set(root, compiled);
		return compiled;
	}
	return validator;
}

/** Compile `ir` into an allocation-free boolean validator. */
export function compileAllows(ir: IR): (value: unknown) => value is unknown {
	const root = resolvedRoot(ir);
	const validator = allowsCache.get(root);
	if (validator === undefined) {
		const built: { value?: (value: unknown) => value is unknown } = {};
		allowsCache.set(root, ((value: unknown) =>
			built.value === undefined ? !(walk(root, value) instanceof OmpErrors) : built.value(value)) as (
			value: unknown,
		) => value is unknown);
		const compiled = new Builder().buildAllows(root);
		built.value = compiled;
		allowsCache.set(root, compiled);
		return compiled;
	}
	return validator;
}

/** Generated source for inspection/debugging. */
export function compileToSource(ir: IR): string {
	const root = resolvedRoot(ir);
	const builder = new Builder();
	if (hasMorph(root)) {
		builder.push("let o;");
		builder.emitCollectProduce(root, "v", [], "o", "e", "L0");
		return `function(v){/* refs elided */return o}`;
	}
	builder.emitCollectCheck(root, "v", [], "e");
	return `function(v){/* refs elided */return v}`;
}
