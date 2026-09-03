/**
 * Schema IR and the ArkType-compatible definition parser.
 *
 * `parseDef` turns the definition subset this repo uses — string DSL
 * (primitives, literals, unions, arrays, bounds, `number.integer`,
 * `string.url`, inline `= literal` defaults), object literals (optional `?`
 * keys, `"+"` undeclared-key policy, `"[string]"` index signatures), tuple
 * `[def, "[]"]` arrays, and embedded `Type` instances — into a small IR tree
 * consumed by the interpreter (`interp.ts`), the JIT compiler (`compile.ts`),
 * and the JSON Schema emitter (`json-schema.ts`).
 */

import { type ErrorConfig, OmpErrors, OmpTypeError } from "./errors";
import { keywordIR, patternIR, templateIR } from "./keywords";

/** Brand carried by `Type` instances so the parser can embed them in defs. */
export const IR_BRAND: unique symbol = Symbol("omptype.schema");

const kMorph: unique symbol = Symbol("omptype.hasMorph");
const kMorphOwner: unique symbol = Symbol("omptype.hasMorphOwner");
const kAlias: unique symbol = Symbol("omptype.hasAlias");
const kAliasOwner: unique symbol = Symbol("omptype.hasAliasOwner");
const kSimple: unique symbol = Symbol("omptype.simple");
const kSimpleOwner: unique symbol = Symbol("omptype.simpleOwner");

interface IRAnalysis {
	[kMorph]?: boolean;
	[kMorphOwner]?: object;
	[kAlias]?: boolean;
	[kAliasOwner]?: object;
	[kSimple]?: boolean;
	[kSimpleOwner]?: object;
	/** Node-local metadata used for shallow error formatting. */
	cfg?: ErrorConfig;
	/** True when `desc` was derived from the node itself rather than authored via `.describe()`. */
	descAuto?: boolean;
}

/**
 * The parser-facing surface of an embedded `Type` instance.
 * `type.ts` implements this on every schema it creates.
 */
export interface EmbeddableSchema {
	[IR_BRAND]: true;
	/** Structural IR of the schema (base type when runtime steps exist). */
	ir: IR;
	/** True when the schema carries `.pipe()`/`.narrow()` steps. */
	hasSteps: boolean;
	/** Output IR of the last `.to(target)` step, when statically known. */
	stepOut?: IR;
	/** True when the last pipe step is bare — output shape statically unknown. */
	opaqueOutput?: boolean;
	/** `.default()` payload; a function is a factory invoked per fill. */
	defaultValue?: unknown;
	hasDefault: boolean;
	/** Precomputed output for a non-factory default after validation and morphs. */
	defaultOutput?: unknown;
	hasDefaultOutput?: boolean;
	/** `.describe()` annotation, emitted into JSON Schema. */
	description?: string;
	/** Full validate+morph pipeline (identical to calling the schema). */
	run(value: unknown, path?: readonly PropertyKey[]): unknown;
}

/** Policy for undeclared object keys. */
export type Extras = "keep" | "reject" | "delete";

/** Constructor accepted by `type.instanceOf` and tuple `instanceof` expressions. */
export type Constructor = abstract new (...args: never[]) => object;

/** Context available to in-definition morph callbacks. */
export interface MorphContext {
	/** Return a validation error at the current path. */
	error(expectation: string): OmpErrors;
	/** Alias of `error` matching ArkType's rejection vocabulary. */
	reject(expectation: string): OmpErrors;
}

/** One fixed tuple position, optionally absent or defaulted. */
export interface TupleItemIR {
	val: IR;
	opt: boolean;
	def?: unknown;
	defFactory?: boolean;
	hasDefault?: boolean;
	/** True once the default has been validated and static morph output precomputed. */
	defValidated?: boolean;
}

/** Fixed, optional, variadic, and postfix tuple sequence. */
export interface TupleIR {
	k: "tuple";
	prefix: TupleItemIR[];
	variadic?: IR;
	postfix: IR[];
	desc?: string;
}

export type IR = IRAnalysis &
	(
		| { k: "unknown"; desc?: string }
		| { k: "null"; desc?: string }
		| { k: "undefined"; desc?: string }
		| { k: "boolean"; desc?: string }
		| { k: "bigint"; desc?: string }
		| { k: "symbol"; desc?: string }
		| { k: "never"; desc?: string }
		/** Any non-null object (the bare `object` keyword). */
		| { k: "anyobject"; desc?: string }
		| { k: "string"; min?: number; max?: number; url?: boolean; desc?: string }
		| {
				k: "number";
				min?: number;
				max?: number;
				xmin?: boolean;
				xmax?: boolean;
				int?: boolean;
				divisor?: number;
				desc?: string;
		  }
		| { k: "lit"; v: unknown; desc?: string }
		| { k: "union"; members: IR[]; desc?: string }
		| { k: "intersection"; members: IR[]; desc?: string }
		| { k: "array"; el: IR; min?: number; max?: number; desc?: string }
		| TupleIR
		| {
				k: "object";
				props: PropIR[];
				index?: IR;
				symbolIndex?: IR;
				patternIndexes?: { key: IR; val: IR }[];
				extras: Extras;
				desc?: string;
		  }
		| {
				k: "refine";
				base: IR;
				pred: (value: unknown) => boolean | OmpErrors;
				expected: string;
				json?: Record<string, unknown>;
				desc?: string;
		  }
		| {
				k: "morph";
				input: IR;
				fn: (value: unknown, context: MorphContext) => unknown;
				out?: IR;
				desc?: string;
		  }
		| { k: "instance"; ctor: Constructor; expected: string; desc?: string }
		| { k: "alias"; name: string; resolve: () => IR; desc?: string }
		/** Embedded schema with runtime steps; validated by calling `run`. */
		| { k: "sub"; schema: EmbeddableSchema; desc?: string }
	);

export interface PropIR {
	key: PropertyKey;
	opt: boolean;
	val: IR;
	/** Default payload (value, or factory when `defFactory`); missing key is filled. */
	def?: unknown;
	defFactory?: boolean;
	hasDefault?: boolean;
	/** True once the default has been validated and static morph output precomputed. */
	defValidated?: boolean;
}

/** Definition input accepted by `type()` and object property values. */
export type Def = string | RegExp | Date | EmbeddableSchema | readonly unknown[] | { readonly [k: string]: unknown };

// ── tokenizer ────────────────────────────────────────────────────────────────

type Tok =
	| { t: "id"; v: string }
	| { t: "num"; v: number }
	| { t: "bigint"; v: bigint }
	| { t: "date"; v: Date }
	| { t: "regex"; v: RegExp }
	| { t: "str"; v: string }
	| { t: "op"; v: string };

const SIMPLE_OPS = "|&()[]=?%,#";

function tokenize(src: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "d" && (src[i + 1] === "'" || src[i + 1] === '"')) {
			const quote = src[i + 1];
			const end = src.indexOf(quote, i + 2);
			if (end < 0) throw new OmpTypeError(`unterminated date literal in "${src}"`);
			const source = src.slice(i + 2, end).trim();
			const value = /^\d+$/.test(source) ? new Date(Number(source)) : new Date(source);
			if (Number.isNaN(value.valueOf())) throw new OmpTypeError(`invalid date literal in "${src}"`);
			toks.push({ t: "date", v: value });
			i = end + 1;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			let value = "";
			for (; j < n && src[j] !== c; j++) {
				if (src[j] === "\\") {
					j++;
					if (j >= n) break;
				}
				value += src[j];
			}
			if (j >= n) throw new OmpTypeError(`unterminated string literal in "${src}"`);
			toks.push({ t: "str", v: value });
			i = j + 1;
			continue;
		}
		if (c === "/") {
			let j = i + 1;
			for (; j < n; j++) {
				if (src[j] === "\\") j++;
				else if (src[j] === "/") break;
			}
			if (j >= n) throw new OmpTypeError(`unterminated regular expression in "${src}"`);
			let end = j + 1;
			while (end < n && /[dgimsuvy]/.test(src[end])) end++;
			const source = src.slice(i + 1, j);
			const flags = src.slice(j + 1, end);
			try {
				toks.push({ t: "regex", v: new RegExp(source, flags) });
			} catch {
				throw new OmpTypeError(`invalid regular expression "${src.slice(i, end)}"`);
			}
			i = end;
			continue;
		}
		if ((c >= "0" && c <= "9") || (c === "-" && i + 1 < n && src[i + 1] >= "0" && src[i + 1] <= "9")) {
			let j = i + 1;
			while (j < n && /[\w.+-]/.test(src[j])) j++;
			const raw = src.slice(i, j);
			if (/^-?(?:0|[1-9]\d*)n$/.test(raw) && raw !== "-0n") {
				toks.push({ t: "bigint", v: BigInt(raw.slice(0, -1)) });
			} else {
				const valid =
					/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && !Object.is(Number(raw), -0) && String(Number(raw)) === raw;
				if (!valid) throw new OmpTypeError(`Malformed number literal '${raw}'`);
				toks.push({ t: "num", v: Number(raw) });
			}
			i = j;
			continue;
		}
		if (/[a-zA-Z_$]/.test(c)) {
			let j = i + 1;
			while (j < n && /[\w.$]/.test(src[j])) j++;
			toks.push({ t: "id", v: src.slice(i, j) });
			i = j;
			continue;
		}
		if (c === "<" || c === ">") {
			if (src[i + 1] === "=") {
				toks.push({ t: "op", v: `${c}=` });
				i += 2;
			} else {
				toks.push({ t: "op", v: c });
				i++;
			}
			continue;
		}
		if (c === "=" && src[i + 1] === "=") {
			toks.push({ t: "op", v: "==" });
			i += 2;
			continue;
		}
		if (SIMPLE_OPS.includes(c)) {
			toks.push({ t: "op", v: c });
			i++;
			continue;
		}
		throw new OmpTypeError(`unexpected character '${c}' in "${src}"`);
	}
	return toks;
}

// ── string-definition parser ─────────────────────────────────────────────────

const CMP: Record<string, true> = { "<": true, "<=": true, ">": true, ">=": true };

const KEYWORDS: Record<string, () => IR> = {
	number: () => ({ k: "number" }),
	"number.integer": () => ({ k: "number", int: true }),
	boolean: () => ({ k: "boolean" }),
	bigint: () => ({ k: "bigint" }),
	symbol: () => ({ k: "symbol" }),
	never: () => ({ k: "never" }),
	null: () => ({ k: "null" }),
	undefined: () => ({ k: "undefined" }),
	unknown: () => ({ k: "unknown" }),
	any: () => ({ k: "unknown" }),
	object: () => ({ k: "anyobject" }),
	Date: () => ({ k: "instance", ctor: Date, expected: "a Date" }),
	true: () => ({ k: "lit", v: true }),
	false: () => ({ k: "lit", v: false }),
};

/** Resolve named scope aliases and, when present, scoped generic invocations. */
export interface AliasResolver {
	(name: string): IR | undefined;
	hasGeneric?(name: string): boolean;
	generic?(name: string, arguments_: readonly IR[]): IR | undefined;
}

/**
 * Resolvers that only intercept the `this` self-reference. A parse under such
 * a resolver of a source with no `this` token is identical to a resolver-free
 * parse, so it may read and populate the string-definition cache.
 */
const THIS_ONLY_RESOLVERS = new WeakSet<AliasResolver>();

/** Declare that `resolve` only intercepts `this` (see THIS_ONLY_RESOLVERS). */
export function markThisOnlyResolver(resolve: AliasResolver): void {
	THIS_ONLY_RESOLVERS.add(resolve);
}

interface ParsedTop {
	ir: IR;
	def?: unknown;
	hasDefault: boolean;
	/** Trailing `?` marker — only legal on object property values. */
	optional: boolean;
}

class StrParser {
	#toks: Tok[];
	#pos = 0;
	#src: string;
	#resolve: AliasResolver | undefined;

	constructor(src: string, resolve?: AliasResolver) {
		this.#src = src;
		this.#resolve = resolve;
		this.#toks = tokenize(src);
	}

	#peek(offset = 0): Tok | undefined {
		return this.#toks[this.#pos + offset];
	}

	#next(): Tok {
		const t = this.#toks[this.#pos++];
		if (!t) throw new OmpTypeError(`unexpected end of definition "${this.#src}"`);
		return t;
	}

	#eatOp(v: string): boolean {
		const t = this.#peek();
		if (t?.t === "op" && t.v === v) {
			this.#pos++;
			return true;
		}
		return false;
	}

	/** Full definition with optional trailing `= literal` default and/or `?` optional marker. */
	parseTop(): ParsedTop {
		const ir = this.parseUnion();
		let def: unknown;
		let hasDefault = false;
		if (this.#eatOp("=")) {
			const t = this.#next();
			if (t.t === "num" || t.t === "bigint" || t.t === "date" || t.t === "str") def = t.v;
			else if (t.t === "id" && (t.v === "true" || t.v === "false")) def = t.v === "true";
			else if (t.t === "id" && t.v === "null") def = null;
			else if (t.t === "id" && t.v === "undefined") def = undefined;
			else throw new OmpTypeError(`unsupported default literal in "${this.#src}"`);
			hasDefault = true;
		}
		const optional = this.#eatOp("?");
		this.#expectEnd();
		return { ir, def, hasDefault, optional };
	}

	#expectEnd(): void {
		if (this.#pos < this.#toks.length) {
			throw new OmpTypeError(`trailing tokens in definition "${this.#src}"`);
		}
	}

	parseUnion(): IR {
		const first = this.parseIntersection();
		if (!this.#eatOp("|")) return first;
		const members = [first, this.parseIntersection()];
		while (this.#eatOp("|")) members.push(this.parseIntersection());
		return { k: "union", members };
	}

	parseIntersection(): IR {
		const first = this.parseBounded();
		if (!this.#eatOp("&")) return first;
		const members = [first, this.parseBounded()];
		while (this.#eatOp("&")) members.push(this.parseBounded());
		const literal = members.find((member): member is Extract<IR, { k: "lit" }> => member.k === "lit");
		if (literal && typeof literal.v === "number") {
			for (const member of members) {
				if (
					member.k === "number" &&
					((member.int && !Number.isInteger(literal.v)) ||
						(member.divisor !== undefined && literal.v % member.divisor !== 0) ||
						(member.min !== undefined && (member.xmin ? literal.v <= member.min : literal.v < member.min)) ||
						(member.max !== undefined && (member.xmax ? literal.v >= member.max : literal.v > member.max)))
				) {
					throw new OmpTypeError("literal is excluded by intersection");
				}
			}
			return literal;
		}
		return { k: "intersection", members };
	}

	/**
	 * `NUM CMP base (CMP NUM)?` or `base (CMP NUM)?`, with `[]*` postfix on the
	 * base AND after a trailing bound — `string>0[]` is an array of bounded
	 * strings, matching ArkType precedence (bounds bind tighter than `[]`).
	 */
	parseBounded(): IR {
		const t = this.#peek();
		const t1 = this.#peek(1);
		if ((t?.t === "num" || t?.t === "date") && t1?.t === "op" && (t1.v === "<" || t1.v === "<=")) {
			const lo = t.v;
			this.#pos += 2;
			let node = this.#eatDivisor(this.parsePostfix());
			node = applyBound(node, flip(t1.v), lo, this.#src);
			const t2 = this.#peek();
			if (!(t2?.t === "op" && CMP[t2.v])) {
				throw new OmpTypeError(`left bound requires a corresponding right bound in "${this.#src}"`);
			}
			if (t2.v === ">" || t2.v === ">=") {
				throw new OmpTypeError(`right bound must use < or <= in "${this.#src}"`);
			}
			this.#pos++;
			const hi = this.#next();
			if (hi.t !== "num" && hi.t !== "date") {
				throw new OmpTypeError(`expected bound after comparator in "${this.#src}"`);
			}
			node = applyBound(node, t2.v, hi.v, this.#src);
			return this.#eatArraySuffixes(node);
		}
		let node = this.#eatDivisor(this.parsePostfix());
		const t2 = this.#peek();
		if (t2?.t === "op" && t2.v === "==") {
			this.#pos++;
			const limit = this.#next();
			if (limit.t !== "num" && limit.t !== "bigint" && limit.t !== "date") {
				throw new OmpTypeError(`expected literal after == in "${this.#src}"`);
			}
			node = applyEquality(node, limit.v, this.#src);
		} else if (t2?.t === "op" && CMP[t2.v] && (this.#peek(1)?.t === "num" || this.#peek(1)?.t === "date")) {
			this.#pos++;
			const limit = this.#next() as Extract<Tok, { t: "num" | "date" }>;
			node = applyBound(node, t2.v, limit.v, this.#src);
			node = this.#eatArraySuffixes(node);
		}
		return node;
	}

	#eatDivisor(node: IR): IR {
		if (!this.#eatOp("%")) return node;
		const divisor = this.#next();
		if (divisor.t !== "num") throw new OmpTypeError(`expected number after % in "${this.#src}"`);
		if (node.k !== "number") throw new OmpTypeError(`% requires number in "${this.#src}"`);
		if (!Number.isFinite(divisor.v) || !Number.isInteger(divisor.v) || divisor.v === 0)
			throw new OmpTypeError(`divisor must be a non-zero integer in "${this.#src}"`);
		// Copy-on-write: the primary may be a shared node (string-def cache,
		// generic arguments); stamping it in place would leak into other schemas.
		return { ...node, divisor: Math.abs(divisor.v) };
	}

	/** Wrap `node` in array IR for each `[]` pair at the cursor. */
	#eatArraySuffixes(node: IR): IR {
		for (;;) {
			const t = this.#peek();
			if (!(t?.t === "op" && t.v === "[")) return node;
			this.#pos++;
			if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
			node = { k: "array", el: node };
		}
	}

	parsePostfix(): IR {
		let node = this.parsePrimary();
		for (;;) {
			const t = this.#peek();
			if (t?.t === "op" && t.v === "[") {
				this.#pos++;
				if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
				node = { k: "array", el: node };
				continue;
			}
			if (t?.t === "op" && t.v === "#") {
				this.#pos++;
				const name = this.#next();
				if (name.t !== "id") throw new OmpTypeError(`expected brand name after # in "${this.#src}"`);
				continue;
			}
			break;
		}
		return node;
	}

	#parseGenericArguments(): IR[] {
		this.#eatOp("<");
		const arguments_: IR[] = [];
		if (this.#eatOp(">")) return arguments_;
		for (;;) {
			arguments_.push(this.parseUnion());
			if (this.#eatOp(">")) return arguments_;
			if (!this.#eatOp(",")) throw new OmpTypeError(`expected ',' or '>' in "${this.#src}"`);
			const next = this.#peek();
			if (next?.t === "op" && (next.v === "," || next.v === ">")) {
				throw new OmpTypeError(`generic arguments cannot be empty in "${this.#src}"`);
			}
		}
	}

	parsePrimary(): IR {
		const t = this.#next();
		if (t.t === "op" && t.v === "(") {
			const inner = this.parseUnion();
			if (!this.#eatOp(")")) throw new OmpTypeError(`expected ')' in "${this.#src}"`);
			return inner;
		}
		if (t.t === "str" || t.t === "num" || t.t === "bigint" || t.t === "date") return { k: "lit", v: t.v };
		if (t.t === "regex") return patternIR(t.v);
		if (t.t === "id") {
			if (t.v === "keyof") {
				try {
					return keyOf(this.parsePostfix());
				} catch (error) {
					if (error instanceof OmpTypeError) throw new OmpTypeError("keyof operand must be an object");
					throw error;
				}
			}
			if (t.v === "Array.liftFrom" && this.#peek()?.t === "op" && this.#peek()?.v === "<") {
				this.#pos++;
				const element = this.parsePrimary();
				if (!this.#eatOp(">")) throw new OmpTypeError(`expected '>' in "${this.#src}"`);
				const array: IR = { k: "array", el: element, desc: "an object" };
				return {
					k: "morph",
					input: { k: "union", members: [element, array] },
					fn: value => (Array.isArray(value) ? value : [value]),
					out: array,
				};
			}
			if (t.v === "Record" && this.#peek()?.t === "op" && this.#peek()?.v === "<") {
				const arguments_ = this.#parseGenericArguments();
				if (arguments_.length !== 2) throw new OmpTypeError("Record requires two arguments");
				return { k: "object", props: [], index: arguments_[1], extras: "keep" };
			}
			if (this.#peek()?.t === "op" && this.#peek()?.v === "<" && this.#resolve?.hasGeneric?.(t.v)) {
				const arguments_ = this.#parseGenericArguments();
				const instantiated = this.#resolve.generic?.(t.v, arguments_);
				if (!instantiated) throw new OmpTypeError(`unknown generic "${t.v}" in "${this.#src}"`);
				return instantiated;
			}
			const scoped = this.#resolve?.(t.v);
			const make = KEYWORDS[t.v];
			const keyword = scoped ?? make?.() ?? keywordIR(t.v);
			if (!keyword) throw new OmpTypeError(`unknown keyword "${t.v}" in "${this.#src}"`);
			return keyword;
		}
		throw new OmpTypeError(`unexpected token in "${this.#src}"`);
	}
}

const STRING_DEF_CACHE_MAX = 1_024;
const stringDefCache = new Map<string, ParsedTop>();

function isWhitespaceAt(src: string, index: number): boolean {
	const code = src.charCodeAt(index);
	return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(src[index]));
}

/** Fast path for the literal unions pervasive in command schemas. */
function parseLiteralUnion(src: string): IR | undefined {
	const members: Extract<IR, { k: "lit" }>[] = [];
	let index = 0;
	while (index < src.length && isWhitespaceAt(src, index)) index++;
	for (;;) {
		const quote = src[index];
		if (quote !== "'" && quote !== '"') return undefined;
		const end = src.indexOf(quote, index + 1);
		if (end < 0) return undefined;
		members.push({ k: "lit", v: src.slice(index + 1, end) });
		index = end + 1;
		while (index < src.length && isWhitespaceAt(src, index)) index++;
		if (index === src.length) {
			const ir: IR = members.length === 1 ? members[0] : { k: "union", members };
			let simple = true;
			for (let member = 1; simple && member < members.length; member++) {
				for (let previous = 0; previous < member; previous++) {
					if (members[previous].k === "lit" && members[previous].v === members[member].v) {
						simple = false;
						break;
					}
				}
			}
			ir[kSimple] = simple;
			ir[kSimpleOwner] = ir;
			return ir;
		}
		if (src[index] !== "|") return undefined;
		index++;
		while (index < src.length && isWhitespaceAt(src, index)) index++;
	}
}

function genericArguments(src: string): { name: string; args: string[] } | undefined {
	const open = src.indexOf("<");
	if (open < 1 || !src.endsWith(">")) return undefined;
	const name = src.slice(0, open).trim();
	const body = src.slice(open + 1, -1);
	const args: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (quote !== "") {
			if (char === quote && body[index - 1] !== "\\") quote = "";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === "<" || char === "(" || char === "[") {
			depth++;
		} else if (char === ">" || char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			args.push(body.slice(start, index).trim());
			start = index + 1;
		}
	}
	args.push(body.slice(start).trim());
	return { name, args };
}

function genericKeys(ir: IR): Set<PropertyKey> {
	const keys = new Set<PropertyKey>();
	const visit = (node: IR): void => {
		if (node.k === "lit" && typeof node.v === "string") keys.add(node.v);
		else if (node.k === "union") for (const member of node.members) visit(member);
	};
	visit(ir);
	return keys;
}

function resolveStructuralIR(ir: IR): IR {
	const seen = new Set<IR>();
	while (ir.k === "alias") {
		if (seen.has(ir)) throw new OmpTypeError(`cannot structurally transform recursive alias "${ir.name}"`);
		seen.add(ir);
		ir = ir.resolve();
	}
	return ir;
}

function mergeObjectIR(left: IR, right: IR): IR {
	left = resolveStructuralIR(left);
	right = resolveStructuralIR(right);
	if (left.k !== "object" || right.k !== "object") {
		throw new OmpTypeError("Merge requires object arguments");
	}
	const props = [...left.props];
	for (const prop of right.props) {
		const index = props.findIndex(candidate => candidate.key === prop.key);
		if (index < 0) props.push(prop);
		else props[index] = prop;
	}
	return {
		k: "object",
		props,
		index: right.index ?? left.index,
		symbolIndex: right.symbolIndex ?? left.symbolIndex,
		patternIndexes:
			left.patternIndexes === undefined && right.patternIndexes === undefined
				? undefined
				: [...(left.patternIndexes ?? []), ...(right.patternIndexes ?? [])],
		extras: right.extras === "keep" ? left.extras : right.extras,
	};
}

function parseGeneric(src: string, resolve?: AliasResolver): IR | undefined {
	const generic = genericArguments(src);
	if (generic === undefined) return undefined;
	if (generic.name === "Array.liftFrom" && generic.args.length === 1) {
		const element = parseDef(generic.args[0], resolve);
		const array: IR = { k: "array", el: element, desc: "an object" };
		return {
			k: "morph",
			input: { k: "union", members: [element, array] },
			fn: value => (Array.isArray(value) ? value : [value]),
			out: array,
		};
	}
	if (generic.name === "Record" && generic.args.length === 2) {
		return { k: "object", props: [], index: parseDef(generic.args[1], resolve), extras: "keep" };
	}
	if ((generic.name === "Extract" || generic.name === "Exclude") && generic.args.length === 2) {
		return distributeFilter(
			parseDef(generic.args[0], resolve),
			parseDef(generic.args[1], resolve),
			generic.name === "Extract",
		);
	}
	if ((generic.name === "Partial" || generic.name === "Required") && generic.args.length === 1) {
		const object = resolveStructuralIR(parseDef(generic.args[0], resolve));
		if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
		const optional = generic.name === "Partial";
		return { ...object, props: object.props.map(prop => ({ ...prop, opt: optional })) };
	}
	if ((generic.name === "Pick" || generic.name === "Omit") && generic.args.length === 2) {
		const object = resolveStructuralIR(parseDef(generic.args[0], resolve));
		if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
		const keys = genericKeys(parseDef(generic.args[1], resolve));
		const pick = generic.name === "Pick";
		return { ...object, props: object.props.filter(prop => keys.has(prop.key) === pick) };
	}
	if (generic.name === "Merge" && generic.args.length === 2) {
		return mergeObjectIR(parseDef(generic.args[0], resolve), parseDef(generic.args[1], resolve));
	}
	return undefined;
}

/**
 * Subtype comparison lives in `type.ts` (it needs full traversal), so it is
 * installed here at module load for the parser's `Extract`/`Exclude` support.
 */
let isAssignable: (source: IR, target: IR) => boolean = () => false;

/** Install the assignability comparator used by `Extract`/`Exclude`. */
export function useAssignability(compare: (source: IR, target: IR) => boolean): void {
	isAssignable = compare;
}

/**
 * Distribute `base` over its union members, keeping those assignable to
 * `target` (`keepAssignable`) or those that are not (`Exclude`).
 */
export function distributeFilter(base: IR, target: IR, keepAssignable: boolean): IR {
	const resolved = base.k === "alias" ? base.resolve() : base;
	const members = resolved.k === "union" ? resolved.members : [resolved];
	const retained = members.filter(member => isAssignable(member, target) === keepAssignable);
	if (retained.length === 0) return { k: "never" };
	return retained.length === 1 ? retained[0] : { k: "union", members: retained };
}

/** Parse recurring global DSL fragments once; scoped aliases bypass the cache. */
function parseRegexExec(src: string): IR | undefined {
	if (!src.startsWith("x/")) return undefined;
	const end = src.lastIndexOf("/");
	if (end < 2) throw new OmpTypeError(`unterminated regular expression in "${src}"`);
	let regex: RegExp;
	try {
		regex = new RegExp(src.slice(2, end), src.slice(end + 1));
	} catch {
		throw new OmpTypeError(`invalid regular expression "${src.slice(1)}"`);
	}
	return {
		k: "morph",
		input: patternIR(regex),
		fn: (value, context) => {
			regex.lastIndex = 0;
			return regex.exec(value as string) ?? context.error(`a string matching ${regex}`);
		},
	};
}

function parseStringDef(src: string, resolve?: AliasResolver): ParsedTop {
	const cacheable = resolve === undefined || (!src.includes("this") && THIS_ONLY_RESOLVERS.has(resolve));
	if (cacheable) {
		const cached = stringDefCache.get(src);
		if (cached) return cached;
	}
	const pipeIndex = src.indexOf("|>");
	if (pipeIndex >= 0) {
		const input = src.slice(0, pipeIndex).trim();
		const output = src.slice(pipeIndex + 2).trim();
		if (input.length === 0 || output.length === 0) {
			throw new OmpTypeError(`pipe expression requires operands in "${src}"`);
		}
		const parsedInput = parseStringDef(input, resolve);
		if (parsedInput.hasDefault) {
			throw new OmpTypeError(`unexpected pipe expression after default in "${src}"`);
		}
		const parsed: ParsedTop = {
			ir: {
				k: "morph",
				input: parsedInput.ir,
				fn: value => value,
				out: parseStringDef(output, resolve).ir,
			},
			hasDefault: false,
			optional: false,
		};
		if (cacheable && stringDefCache.size < STRING_DEF_CACHE_MAX) stringDefCache.set(src, parsed);
		return parsed;
	}
	let ir = parseLiteralUnion(src) ?? parseRegexExec(src) ?? parseGeneric(src, resolve);
	if (ir === undefined && src.startsWith("`") && src.endsWith("`")) {
		ir = templateIR(src.slice(1, -1));
	}

	const parsed: ParsedTop =
		ir === undefined ? new StrParser(src, resolve).parseTop() : { ir, hasDefault: false, optional: false };
	if (cacheable && stringDefCache.size < STRING_DEF_CACHE_MAX) stringDefCache.set(src, parsed);
	return parsed;
}

function flip(op: string): string {
	switch (op) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		default:
			return "<=";
	}
}

function applyEquality(node: IR, value: number | bigint | Date, src: string): IR {
	if (node.k === "union") {
		return { k: "union", members: node.members.map(member => applyEquality(member, value, src)) };
	}
	if (value instanceof Date) {
		if (!acceptsDate(node)) throw new OmpTypeError(`Date equality requires Date in "${src}"`);
		return { k: "lit", v: value };
	}
	if (node.k === "number" && typeof value === "number") return { k: "lit", v: value };
	if (node.k === "bigint" && typeof value === "bigint") return { k: "lit", v: value };
	if ((node.k === "string" || node.k === "array") && typeof value === "number") {
		if (!Number.isInteger(value) || value < 0) {
			throw new OmpTypeError(`exact length must be a non-negative integer in "${src}"`);
		}
		return { ...node, min: value, max: value };
	}
	throw new OmpTypeError(`equality literal is incompatible with ${node.k} in "${src}"`);
}

/**
 * Apply `node CMP value` — numeric/string/array ranges or Date bounds.
 * Copy-on-write: `node` may be shared (string-def cache, generic arguments,
 * resolved aliases), so bounds land on a fresh node, never in place.
 */
function applyBound(node: IR, op: string, value: number | Date, src: string): IR {
	if (node.k === "alias") return applyBound(node.resolve(), op, value, src);
	if (node.k === "refine" && !(value instanceof Date)) {
		return { ...node, base: applyBound(node.base, op, value, src) };
	}
	if (node.k === "union") {
		const kinds = new Set(node.members.map(boundKind));
		if (kinds.size !== 1) throw new OmpTypeError(`cannot apply one bound to multiple bound kinds in "${src}"`);
		return { k: "union", members: node.members.map(member => applyBound(member, op, value, src)) };
	}
	if (!(value instanceof Date) && acceptsDate(node)) {
		return applyBound(node, op, new Date(value), src);
	}
	if (value instanceof Date) {
		if (!acceptsDate(node)) throw new OmpTypeError(`date bound requires Date in "${src}"`);
		const limit = value.valueOf();
		const relation =
			op === ">=" ? "on or after" : op === ">" ? "later than" : op === "<=" ? "on or before" : "earlier than";
		return {
			k: "refine",
			base: node,
			pred: input => {
				if (!(input instanceof Date)) return false;
				const time = input.valueOf();
				return op === ">=" ? time >= limit : op === ">" ? time > limit : op === "<=" ? time <= limit : time < limit;
			},
			expected: `a Date ${relation} ${value.toISOString()}`,
		};
	}
	if (node.k === "number") {
		const bounded = { ...node };
		switch (op) {
			case ">=":
				bounded.min = value;
				bounded.xmin = false;
				break;
			case ">":
				bounded.min = value;
				bounded.xmin = true;
				break;
			case "<=":
				bounded.max = value;
				bounded.xmax = false;
				break;
			case "<":
				bounded.max = value;
				bounded.xmax = true;
				break;
		}
		if (
			bounded.min !== undefined &&
			bounded.max !== undefined &&
			(bounded.min > bounded.max || (bounded.min === bounded.max && (bounded.xmin || bounded.xmax)))
		) {
			throw new OmpTypeError(`numeric range is unsatisfiable in "${src}"`);
		}
		return bounded;
	}
	if (node.k === "string" || node.k === "array") {
		if (!Number.isInteger(value) || value < 0) {
			throw new OmpTypeError(`length bound must be a non-negative integer in "${src}"`);
		}
		const bounded = { ...node };
		switch (op) {
			case ">=":
				bounded.min = value;
				break;
			case ">":
				bounded.min = value + 1;
				break;
			case "<=":
				bounded.max = value;
				break;
			case "<":
				bounded.max = value - 1;
				break;
		}
		if (
			(bounded.min !== undefined && bounded.max !== undefined && bounded.min > bounded.max) ||
			(bounded.max ?? 0) < 0
		) {
			throw new OmpTypeError(`length range is unsatisfiable in "${src}"`);
		}
		return bounded;
	}
	throw new OmpTypeError(`cannot bound ${node.k} in "${src}"`);
}

function acceptsDate(node: IR): boolean {
	return (node.k === "instance" && node.ctor === Date) || (node.k === "refine" && acceptsDate(node.base));
}

// ── definition parser ────────────────────────────────────────────────────────

function isEmbedded(def: unknown): def is EmbeddableSchema {
	return (typeof def === "function" || (typeof def === "object" && def !== null)) && IR_BRAND in def;
}

/** Embed a schema value: inline pure structure, keep `sub` nodes for stepped schemas. */
export function embed(schema: EmbeddableSchema): IR {
	if (schema.hasSteps) return { k: "sub", schema, desc: schema.description, descAuto: schema.ir.desc === undefined };
	if (schema.description !== undefined && schema.ir.desc === undefined) {
		return { ...schema.ir, desc: schema.description, descAuto: true };
	}
	return schema.ir;
}
function boundKind(node: IR): "number" | "length" | "date" | undefined {
	if (node.k === "number") return "number";
	if (node.k === "string" || node.k === "array") return "length";
	if (acceptsDate(node)) return "date";
	return undefined;
}

function isCallback(value: unknown): value is (input: unknown, context: MorphContext) => unknown {
	return typeof value === "function";
}

function isConstructor(value: unknown): value is Constructor {
	return typeof value === "function" && value.prototype !== undefined;
}

function parseTupleItem(def: unknown, resolve?: AliasResolver): TupleItemIR {
	if (Array.isArray(def) && def.length === 2 && def[1] === "?") {
		return { val: parseDef(def[0], resolve), opt: true };
	}
	if (Array.isArray(def) && def.length === 3 && def[1] === "=") {
		return {
			val: parseDef(def[0], resolve),
			opt: true,
			def: def[2],
			defFactory: typeof def[2] === "function",
			hasDefault: true,
		};
	}
	if (typeof def === "string") {
		const parsed = parseStringDef(def, resolve);
		return {
			val: parsed.ir,
			opt: parsed.optional || parsed.hasDefault,
			def: parsed.def,
			hasDefault: parsed.hasDefault,
		};
	}
	return { val: parseDef(def, resolve), opt: false };
}

function cloneTuple(tuple: TupleIR): TupleIR {
	return {
		...tuple,
		prefix: tuple.prefix.map(item => ({ ...item })),
		postfix: [...tuple.postfix],
	};
}

function hasOptionalPrefix(tuple: TupleIR): boolean {
	return tuple.prefix.some(item => item.opt || item.hasDefault === true);
}

function appendTupleItem(tuple: TupleIR, item: TupleItemIR): void {
	if (tuple.variadic !== undefined) {
		if (item.opt || item.hasDefault) {
			throw new OmpTypeError("An optional element may not follow a variadic element");
		}
		if (hasOptionalPrefix(tuple)) {
			throw new OmpTypeError("A postfix required element cannot follow an optional or defaultable element");
		}
		tuple.postfix.push(item.val);
		return;
	}
	if (item.hasDefault && tuple.prefix.some(prefixItem => prefixItem.opt && !prefixItem.hasDefault)) {
		throw new OmpTypeError("A defaultable element may not follow an optional element without a default");
	}
	if (hasOptionalPrefix(tuple) && !item.opt) {
		throw new OmpTypeError("required tuple elements cannot follow optional elements");
	}
	tuple.prefix.push(item);
}

function appendTuple(target: TupleIR, spread: TupleIR): void {
	if (target.variadic !== undefined && spread.variadic !== undefined) {
		throw new OmpTypeError("a tuple may have one spread followed by an array definition");
	}
	for (const item of spread.prefix) appendTupleItem(target, { ...item });
	if (spread.variadic !== undefined) {
		target.variadic = spread.variadic;
	}
	for (const item of spread.postfix) appendTupleItem(target, { val: item, opt: false });
}

function spreadAlternatives(spread: IR): TupleIR[] {
	if (spread.k === "alias") return spreadAlternatives(spread.resolve());
	if (spread.k === "sub") return spreadAlternatives(spread.schema.ir);
	if (spread.k === "union") return spread.members.flatMap(spreadAlternatives);
	if (spread.k === "array") return [{ k: "tuple", prefix: [], variadic: spread.el, postfix: [] }];
	if (spread.k === "tuple") return [spread];
	throw new OmpTypeError("tuple spread element must be an array");
}

function parseTuple(def: readonly unknown[], resolve?: AliasResolver): IR {
	let branches: TupleIR[] = [{ k: "tuple", prefix: [], postfix: [] }];
	for (let index = 0; index < def.length; index++) {
		if (def[index] === "...") {
			if (index + 1 >= def.length) {
				throw new OmpTypeError("a tuple may have one spread followed by an array definition");
			}
			const alternatives = spreadAlternatives(parseDef(def[++index], resolve));
			const distributed: TupleIR[] = [];
			for (const branch of branches) {
				for (const alternative of alternatives) {
					const next = cloneTuple(branch);
					appendTuple(next, alternative);
					distributed.push(next);
				}
			}
			branches = distributed;
			continue;
		}
		const item = parseTupleItem(def[index], resolve);
		for (const branch of branches) appendTupleItem(branch, { ...item });
	}
	return branches.length === 1 ? branches[0] : { k: "union", members: branches };
}

/** Build the runtime schema for an object's or tuple's keys. */
export function keyOf(node: IR): IR {
	if (node.k === "alias") return keyOf(node.resolve());
	if (node.k === "sub") return keyOf(node.schema.ir);
	if (node.k === "refine") return keyOf(node.base);
	if (node.k === "intersection") {
		const members = node.members.flatMap(member => {
			const keys = keyOf(member);
			return keys.k === "union" ? keys.members : [keys];
		});
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (node.k === "object") {
		const members: IR[] = node.props.map(prop => ({ k: "lit", v: prop.key }));
		if (node.index !== undefined || (node.patternIndexes?.length ?? 0) > 0) members.push({ k: "string" });
		if (node.symbolIndex !== undefined) members.push({ k: "symbol" });
		if (members.length === 0) return { k: "never" };
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (node.k === "tuple") return { k: "number", int: true, min: 0 };
	if (node.k === "union") {
		if (node.members.length === 0) return { k: "never" };
		const literalSets = node.members.map(member => {
			const keyed = keyOf(member);
			const literals = keyed.k === "union" ? keyed.members : [keyed];
			const keys = new Set<PropertyKey>();
			for (const literal of literals) {
				if (
					literal.k === "lit" &&
					(typeof literal.v === "string" || typeof literal.v === "number" || typeof literal.v === "symbol")
				) {
					keys.add(literal.v);
				}
			}
			return keys;
		});
		const common = [...literalSets[0]].filter(key => literalSets.slice(1).every(keys => keys.has(key)));
		if (common.length === 0) throw new OmpTypeError("keyof operand must be an object");
		const members = common.map(value => ({ k: "lit", v: value }) satisfies IR);
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	throw new OmpTypeError("keyof operand must be an object");
}

function parseArrayExpression(def: readonly unknown[], resolve?: AliasResolver): IR {
	if (def.length === 2 && def[1] === "[]") return { k: "array", el: parseDef(def[0], resolve) };
	if (def.length === 2 && def[0] === "keyof") return keyOf(parseDef(def[1], resolve));
	if (def[0] === "instanceof") {
		const members: IR[] = [];
		for (let index = 1; index < def.length; index++) {
			const ctor = def[index];
			if (!isConstructor(ctor)) throw new OmpTypeError("instanceof operands must be constructors");
			members.push({
				k: "instance",
				ctor,
				expected: ctor === Error ? "an Error" : `an instance of ${ctor.name || "the constructor"}`,
			});
		}
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (def[0] === "===") {
		const members = def.slice(1).map(value => ({ k: "lit", v: value }) satisfies IR);
		if (members.length === 0) return { k: "never" };
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (def.length >= 3 && def[1] === "|") {
		return { k: "union", members: [parseDef(def[0], resolve), parseDef(def[2], resolve)] };
	}
	if (def.length >= 3 && def[1] === "&") {
		return { k: "intersection", members: [parseDef(def[0], resolve), parseDef(def[2], resolve)] };
	}
	if (def.length === 3 && def[1] === "=>") {
		if (!isCallback(def[2])) throw new OmpTypeError("morph operator requires a function");
		return { k: "morph", input: parseDef(def[0], resolve), fn: def[2] };
	}
	if (def.length === 3 && def[1] === "|>") {
		return { k: "morph", input: parseDef(def[0], resolve), fn: value => value, out: parseDef(def[2], resolve) };
	}
	if (def.length === 3 && def[1] === ":") {
		if (!isCallback(def[2])) throw new OmpTypeError("narrow operator requires a predicate");
		const predicate = def[2];
		const name = predicate.name;
		const expected = name.length === 0 ? "valid according to an anonymous predicate" : `valid according to ${name}`;
		return {
			k: "refine",
			base: parseDef(def[0], resolve),
			pred: value => {
				let errors: OmpErrors | undefined;
				const error = (
					input:
						| string
						| {
								expected: string;
								actual?: unknown;
								path?: readonly PropertyKey[];
								relativePath?: readonly PropertyKey[];
						  },
				): OmpErrors => {
					const detail = typeof input === "string" ? { expected: input } : input;
					const next = OmpErrors.single([...(detail.path ?? detail.relativePath ?? [])], detail.expected, value, {
						preserveActual: true,
						...(Object.hasOwn(detail, "actual") ? { actual: String(detail.actual) } : {}),
					});
					if (errors) errors.append(next);
					else errors = next;
					return next;
				};
				const result = predicate(value, { error, reject: error });
				return errors ?? (result instanceof OmpErrors ? result : result === true);
			},
			expected,
		};
	}
	if (def.length >= 3 && def[1] === "@") {
		const base = parseDef(def[0], resolve);
		const meta = def[2];
		if (typeof meta === "string") return { ...base, desc: meta, cfg: { ...base.cfg, expected: meta } };
		if (typeof meta === "object" && meta !== null) {
			const config = meta as ErrorConfig & { description?: string };
			return {
				...base,
				cfg: {
					...(typeof config.description === "string" ? { expected: config.description } : {}),
					...config,
				},
				...(typeof config.description === "string" ? { desc: config.description } : {}),
			};
		}
		return base;
	}
	return parseTuple(def, resolve);
}

function isObjectDefinition(def: unknown): def is Record<PropertyKey, unknown> {
	return (
		typeof def === "object" &&
		def !== null &&
		!Array.isArray(def) &&
		!(def instanceof RegExp) &&
		!(def instanceof Date)
	);
}

function spreadObjectOf(ir: IR): Extract<IR, { k: "object" }> | undefined {
	if (ir.k === "alias") return spreadObjectOf(ir.resolve());
	if (ir.k === "sub") return spreadObjectOf(ir.schema.ir);
	if (ir.k === "refine") return spreadObjectOf(ir.base);
	if (ir.k === "anyobject") return { k: "object", props: [], extras: "keep" };
	if (ir.k === "object") return ir;
	if (ir.k !== "intersection") return undefined;
	let result: Extract<IR, { k: "object" }> = { k: "object", props: [], extras: "keep" };
	for (const member of ir.members) {
		const object = spreadObjectOf(member);
		if (object === undefined) return undefined;
		result = mergeObjectIR(result, object) as Extract<IR, { k: "object" }>;
	}
	return result;
}

function indexKeyKind(
	key: IR,
	value: IR,
	props: PropIR[],
	indexes: {
		string?: IR;
		symbol?: IR;
		patterns: { key: IR; val: IR }[];
	},
): void {
	if (key.k === "alias") return indexKeyKind(key.resolve(), value, props, indexes);
	if (key.k === "union") {
		for (const member of key.members) indexKeyKind(member, value, props, indexes);
		return;
	}
	if (key.k === "lit" && (typeof key.v === "string" || typeof key.v === "symbol")) {
		props.push({ key: key.v, opt: false, val: value });
		return;
	}
	if (key.k === "string") {
		indexes.string = value;
		return;
	}
	if (key.k === "symbol") {
		indexes.symbol = value;
		return;
	}
	if (key.k === "refine" && key.base.k === "string") {
		indexes.patterns.push({ key, val: value });
		return;
	}
	throw new OmpTypeError(`indexed key definition must resolve to a string or symbol (was ${expectedOf(key)})`);
}

function addObjectProp(props: PropIR[], spreadKeys: Set<PropertyKey> | undefined, prop: PropIR): void {
	if (spreadKeys === undefined) {
		props.push(prop);
		return;
	}
	const previous = props.findIndex(candidate => candidate.key === prop.key);
	if (previous < 0) {
		props.push(prop);
		return;
	}
	if (!spreadKeys.delete(prop.key)) throw new OmpTypeError(`duplicate object key ${String(prop.key)}`);
	props[previous] = prop;
}

function parseObjectDefinition(def: Record<PropertyKey, unknown>, resolve?: AliasResolver): IR {
	const props: PropIR[] = [];
	let spreadKeys: Set<PropertyKey> | undefined;
	let normalizedKey: PropertyKey | undefined;
	let normalizedKeys: PropertyKey[] | undefined;
	let indexes:
		| {
				string?: IR;
				symbol?: IR;
				patterns: { key: IR; val: IR }[];
		  }
		| undefined;
	let extras: Extras = "keep";
	let simple = true;
	for (const originalKey in def) {
		if (!Object.hasOwn(def, originalKey)) continue;
		const val = def[originalKey];
		if (originalKey === "+") {
			if (val === "reject" || val === "delete") {
				extras = val;
				if (val === "delete") simple = false;
			} else if (val === "ignore") extras = "keep";
			else throw new OmpTypeError(`bad "+" value ${String(val)}`);
			continue;
		}
		if (originalKey === "...") {
			const parsed = parseDef(val, resolve);
			const spread = spreadObjectOf(parsed);
			if (spread === undefined) {
				throw new OmpTypeError(`object spread must resolve to an object literal (was ${expectedOf(parsed)})`);
			}
			if (simple && !isSimpleIR(spread)) simple = false;
			spreadKeys ??= new Set();
			for (const prop of spread.props) {
				const previous = props.findIndex(candidate => candidate.key === prop.key);
				if (previous < 0) props.push(prop);
				else props[previous] = prop;
				spreadKeys.add(prop.key);
			}
			if (spread.index !== undefined || spread.symbolIndex !== undefined || spread.patternIndexes !== undefined) {
				const objectIndexes = indexes ?? { patterns: [] };
				indexes = objectIndexes;
				objectIndexes.string ??= spread.index;
				objectIndexes.symbol ??= spread.symbolIndex;
				if (spread.patternIndexes !== undefined) objectIndexes.patterns.push(...spread.patternIndexes);
			}
			if (spread.extras !== "keep") extras = spread.extras;
			continue;
		}
		if (typeof originalKey === "string" && originalKey.startsWith("[") && originalKey.endsWith("]")) {
			let value: IR;
			if (typeof val === "string") {
				const parsed = parseStringDef(val, resolve);
				if (parsed.hasDefault) throw new OmpTypeError("index signatures cannot specify a default");
				value = parsed.ir;
			} else {
				if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
					throw new OmpTypeError("index signatures cannot specify a default");
				}
				value = parseDef(val, resolve);
				if (isEmbedded(val) && val.hasDefault) {
					throw new OmpTypeError("index signatures cannot specify a default");
				}
			}
			const keyDefinition = originalKey.slice(1, -1);
			const regex = /^\/((?:\\.|[^\\/])*)\/([dgimsuvy]*)$/.exec(keyDefinition);
			let key: IR;
			if (regex === null) {
				key = parseDef(keyDefinition, resolve);
			} else {
				try {
					key = patternIR(new RegExp(regex[1], regex[2]));
				} catch {
					throw new OmpTypeError(`invalid index signature pattern ${keyDefinition}`);
				}
			}
			const objectIndexes = indexes ?? { patterns: [] };
			indexes = objectIndexes;
			indexKeyKind(key, value, props, objectIndexes);
			if (simple && (!isSimpleIR(key) || !isSimpleIR(value))) simple = false;
			continue;
		}
		const escapedOptional = typeof originalKey === "string" && originalKey.endsWith("\\?");
		const escapedMeta =
			typeof originalKey === "string" &&
			(originalKey === "\\+" || originalKey === "\\..." || originalKey.startsWith("\\["));
		const rawKey = escapedOptional
			? `${originalKey.slice(0, -2)}?`
			: escapedMeta
				? originalKey.slice(1)
				: originalKey;
		const opt = typeof rawKey === "string" && !escapedOptional && !escapedMeta && rawKey.endsWith("?");
		const key = opt ? rawKey.slice(0, -1) : rawKey;
		let prop: PropIR;
		if (typeof val === "string") {
			const parsed = parseStringDef(val, resolve);
			prop = { key, opt: opt || parsed.optional, val: parsed.ir };
			if (parsed.hasDefault) {
				prop.def = parsed.def;
				prop.hasDefault = true;
			}
		} else if (Array.isArray(val) && val.length === 2 && val[1] === "?") {
			prop = { key, opt: true, val: parseDef(val[0], resolve) };
		} else if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
			prop = {
				key,
				opt,
				val: parseDef(val[0], resolve),
				def: val[2],
				defFactory: typeof val[2] === "function",
				hasDefault: true,
			};
		} else if (isEmbedded(val)) {
			prop = val.hasDefault
				? {
						key,
						opt,
						val: embed(val),
						def: val.hasDefaultOutput ? val.defaultOutput : val.defaultValue,
						defFactory: typeof val.defaultValue === "function",
						hasDefault: true,
						defValidated: val.hasDefaultOutput,
					}
				: { key, opt, val: embed(val) };
		} else {
			prop = {
				key,
				opt,
				val: isObjectDefinition(val) ? parseObjectDefinition(val, resolve) : parseDef(val, resolve),
			};
		}
		if (key !== originalKey) {
			if (!spreadKeys?.has(key) && props.some(candidate => candidate.key === key)) {
				throw new OmpTypeError(`duplicate object key ${String(key)}`);
			}
			if (normalizedKey === undefined) normalizedKey = key;
			else {
				normalizedKeys ??= [normalizedKey];
				normalizedKeys.push(key);
			}
		} else if (!spreadKeys?.has(key) && (key === normalizedKey || normalizedKeys?.includes(key))) {
			throw new OmpTypeError(`duplicate object key ${String(key)}`);
		}
		if (opt && prop.hasDefault) throw new OmpTypeError(`optional key ${String(key)} cannot specify a default`);
		if (simple && (prop.hasDefault || !isSimpleIR(prop.val))) simple = false;
		addObjectProp(props, spreadKeys, prop);
	}
	for (const key of Object.getOwnPropertySymbols(def)) {
		if (!Object.prototype.propertyIsEnumerable.call(def, key)) continue;
		const val = def[key];
		let prop: PropIR;
		if (typeof val === "string") {
			const parsed = parseStringDef(val, resolve);
			prop = { key, opt: parsed.optional, val: parsed.ir };
			if (parsed.hasDefault) {
				prop.def = parsed.def;
				prop.hasDefault = true;
			}
		} else if (Array.isArray(val) && val.length === 2 && val[1] === "?") {
			prop = { key, opt: true, val: parseDef(val[0], resolve) };
		} else if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
			prop = {
				key,
				opt: false,
				val: parseDef(val[0], resolve),
				def: val[2],
				defFactory: typeof val[2] === "function",
				hasDefault: true,
			};
		} else if (isEmbedded(val)) {
			prop = val.hasDefault
				? {
						key,
						opt: false,
						val: embed(val),
						def: val.hasDefaultOutput ? val.defaultOutput : val.defaultValue,
						defFactory: typeof val.defaultValue === "function",
						hasDefault: true,
						defValidated: val.hasDefaultOutput,
					}
				: { key, opt: false, val: embed(val) };
		} else {
			prop = {
				key,
				opt: false,
				val: isObjectDefinition(val) ? parseObjectDefinition(val, resolve) : parseDef(val, resolve),
			};
		}
		if (simple && (prop.hasDefault || !isSimpleIR(prop.val))) simple = false;
		addObjectProp(props, spreadKeys, prop);
	}
	const object: IR = {
		k: "object",
		props,
		index: indexes?.string,
		symbolIndex: indexes?.symbol,
		patternIndexes: indexes === undefined || indexes.patterns.length === 0 ? undefined : indexes.patterns,
		extras,
	};
	object[kSimple] = simple;
	object[kSimpleOwner] = object;
	return object;
}

/** Parse a definition, optionally resolving names from an enclosing scope. */
export function parseDef(def: unknown, resolve?: AliasResolver): IR {
	if (typeof def === "string") {
		const parsed = parseStringDef(def, resolve);
		if (parsed.hasDefault) {
			throw new OmpTypeError("A default may only be specified for an object property or tuple element");
		}
		if (parsed.optional) {
			throw new OmpTypeError(`optional "?" marker is only valid on object property values`);
		}
		return parsed.ir;
	}
	if (Array.isArray(def)) {
		if (def.length === 3 && def[1] === "=") {
			throw new OmpTypeError("A default may only be specified for an object property or tuple element");
		}
		return parseArrayExpression(def, resolve);
	}
	if (def instanceof RegExp) return patternIR(def);
	if (def instanceof Date) return { k: "lit", v: def };
	if (isEmbedded(def)) return embed(def);
	if (typeof def === "function") {
		const resolved = Reflect.apply(def, undefined, []);
		if (!isEmbedded(resolved)) {
			throw new OmpTypeError(`thunk must return a Type (was ${typeof resolved})`);
		}
		return embed(resolved);
	}
	if (isObjectDefinition(def)) return parseObjectDefinition(def, resolve);
	throw new OmpTypeError(`unsupported definition ${String(def)} (was ${typeof def})`);
}

/** Whether `ir` needs no construction-time normalization or morph analysis. */
export function isSimpleIR(ir: IR): boolean {
	const cached = ir[kSimpleOwner] === ir ? ir[kSimple] : undefined;
	if (cached !== undefined) return cached;
	const simple = scanSimpleIR(ir);
	ir[kSimple] = simple;
	ir[kSimpleOwner] = ir;
	return simple;
}

function scanSimpleIR(ir: IR): boolean {
	switch (ir.k) {
		case "intersection":
		case "morph":
		case "sub":
		case "alias":
			return false;
		case "refine":
			return scanSimpleIR(ir.base);
		case "union":
			if (ir.members.length < 2) return false;
			if (
				ir.members.length === 2 &&
				ir.members.every(member => member.k === "lit" && typeof member.v === "boolean")
			) {
				return false;
			}
			for (let index = 0; index < ir.members.length; index++) {
				const member = ir.members[index];
				if (
					member.k !== "lit" ||
					(member.v !== null && (typeof member.v === "object" || typeof member.v === "function"))
				) {
					return false;
				}
				for (let previous = 0; previous < index; previous++) {
					const candidate = ir.members[previous];
					if (candidate.k === "lit" && candidate.v === member.v) return false;
				}
			}
			return true;
		case "array":
			return scanSimpleIR(ir.el);
		case "tuple":
			for (const item of ir.prefix) {
				if (item.hasDefault || !scanSimpleIR(item.val)) return false;
			}
			if (ir.variadic !== undefined && !scanSimpleIR(ir.variadic)) return false;
			for (const item of ir.postfix) if (!scanSimpleIR(item)) return false;
			return true;
		case "object":
			if (ir.extras === "delete") return false;
			for (const prop of ir.props) {
				if (prop.hasDefault || !scanSimpleIR(prop.val)) return false;
			}
			if (ir.index !== undefined && !scanSimpleIR(ir.index)) return false;
			if (ir.symbolIndex !== undefined && !scanSimpleIR(ir.symbolIndex)) return false;
			if (ir.patternIndexes !== undefined) {
				for (const pattern of ir.patternIndexes) {
					if (!scanSimpleIR(pattern.key) || !scanSimpleIR(pattern.val)) return false;
				}
			}
			return true;
		default:
			return true;
	}
}

/** True when validating `ir` can produce an output different from its input. */
export function hasMorph(ir: IR): boolean {
	const cached = ir[kMorphOwner] === ir ? ir[kMorph] : undefined;
	if (cached !== undefined) return cached;
	const result = scanMorph(ir);
	ir[kMorph] = result;
	ir[kMorphOwner] = ir;
	return result;
}

function scanMorph(ir: IR, activeAliases?: Set<IR>): boolean {
	const cached = ir[kMorphOwner] === ir ? ir[kMorph] : undefined;
	if (cached !== undefined) return cached;

	let result = false;
	switch (ir.k) {
		case "sub":
		case "morph":
			result = true;
			break;
		case "alias": {
			if (activeAliases?.has(ir)) return false;
			const aliases = activeAliases ?? new Set<IR>();
			aliases.add(ir);
			result = scanMorph(ir.resolve(), aliases);
			aliases.delete(ir);
			return result;
		}
		case "object":
			result = ir.extras === "delete";
			for (let index = 0; !result && index < ir.props.length; index++) {
				const prop = ir.props[index];
				result = prop.hasDefault === true || scanMorph(prop.val, activeAliases);
			}
			if (!result && ir.index !== undefined) result = scanMorph(ir.index, activeAliases);
			if (!result && ir.symbolIndex !== undefined) result = scanMorph(ir.symbolIndex, activeAliases);
			if (!result && ir.patternIndexes !== undefined) {
				for (const pattern of ir.patternIndexes) {
					if (scanMorph(pattern.val, activeAliases)) {
						result = true;
						break;
					}
				}
			}
			break;
		case "array":
			result = scanMorph(ir.el, activeAliases);
			break;
		case "union":
		case "intersection":
			for (const member of ir.members) {
				if (scanMorph(member, activeAliases)) {
					result = true;
					break;
				}
			}
			break;
		case "refine":
			result = scanMorph(ir.base, activeAliases);
			break;
		case "tuple":
			for (const item of ir.prefix) {
				if (item.hasDefault === true || scanMorph(item.val, activeAliases)) {
					result = true;
					break;
				}
			}
			if (!result && ir.variadic !== undefined) result = scanMorph(ir.variadic, activeAliases);
			if (!result) {
				for (const item of ir.postfix) {
					if (scanMorph(item, activeAliases)) {
						result = true;
						break;
					}
				}
			}
			break;
	}
	return result;
}

/**
 * True when a traversal of `ir` can revisit nodes through recursive aliases,
 * requiring cycle guards in the interpreter. Embedded sub-schemas run their
 * own guarded traversal and are intentionally not inspected.
 */
export function hasAlias(ir: IR): boolean {
	const cached = ir[kAliasOwner] === ir ? ir[kAlias] : undefined;
	if (cached !== undefined) return cached;
	const result = scanAlias(ir);
	ir[kAlias] = result;
	ir[kAliasOwner] = ir;
	return result;
}

function scanAlias(ir: IR): boolean {
	const cached = ir[kAliasOwner] === ir ? ir[kAlias] : undefined;
	if (cached !== undefined) return cached;
	switch (ir.k) {
		case "alias":
			return true;
		case "object":
			for (const prop of ir.props) if (scanAlias(prop.val)) return true;
			if (ir.index !== undefined && scanAlias(ir.index)) return true;
			if (ir.symbolIndex !== undefined && scanAlias(ir.symbolIndex)) return true;
			if (ir.patternIndexes !== undefined) {
				for (const pattern of ir.patternIndexes) {
					if (scanAlias(pattern.key) || scanAlias(pattern.val)) return true;
				}
			}
			return false;
		case "array":
			return scanAlias(ir.el);
		case "tuple":
			for (const item of ir.prefix) if (scanAlias(item.val)) return true;
			if (ir.variadic !== undefined && scanAlias(ir.variadic)) return true;
			for (const item of ir.postfix) if (scanAlias(item)) return true;
			return false;
		case "union":
		case "intersection":
			for (const member of ir.members) if (scanAlias(member)) return true;
			return false;
		case "refine":
			return scanAlias(ir.base);
		case "morph":
			return scanAlias(ir.input) || (ir.out !== undefined && scanAlias(ir.out));
		default:
			return false;
	}
}

/** Human-readable expectation for error messages, e.g. `"a string"`. */
export function expectedOf(ir: IR): string {
	if (ir.desc !== undefined) return ir.desc;
	switch (ir.k) {
		case "unknown":
			return "unknown";
		case "null":
			return "null";
		case "undefined":
			return "undefined";
		case "boolean":
			return "boolean";
		case "bigint":
			return "a bigint";
		case "symbol":
			return "a symbol";
		case "never":
			return "never";
		case "anyobject":
			return "an object";
		case "string": {
			let out = ir.url ? "a URL string" : "a string";
			if (ir.min !== undefined && ir.max !== undefined) out += ` (length ${ir.min} to ${ir.max})`;
			else if (ir.min !== undefined) out += ` (length at least ${ir.min})`;
			else if (ir.max !== undefined) out += ` (length at most ${ir.max})`;
			return out;
		}
		case "number": {
			let out = ir.int ? "an integer" : "a number";
			if (ir.min !== undefined) out += ` ${ir.xmin ? "more than" : "at least"} ${ir.min}`;
			if (ir.max !== undefined)
				out += `${ir.min !== undefined ? " and" : ""} ${ir.xmax ? "less than" : "at most"} ${ir.max}`;
			if (ir.divisor !== undefined) out += ` divisible by ${ir.divisor}`;
			return out;
		}
		case "lit":
			return ir.v instanceof Date
				? `the date ${ir.v.toISOString()}`
				: typeof ir.v === "string"
					? JSON.stringify(ir.v)
					: String(ir.v);
		case "union": {
			if (ir.members.length === 0) return "";
			const first = expectedOf(ir.members[0]);
			if (ir.members.length === 1) return first;
			const second = expectedOf(ir.members[1]);
			if (ir.members.length === 2) return first === second ? first : `${first} or ${second}`;
			const expectations = first === second ? [first] : [first, second];
			for (let i = 2; i < ir.members.length; i++) {
				const expected = expectedOf(ir.members[i]);
				if (!expectations.includes(expected)) expectations.push(expected);
			}
			return expectations.join(" or ");
		}
		case "intersection":
			return ir.members.map(expectedOf).join(" and ");
		case "array":
			return "an array";
		case "tuple":
			return "a tuple";
		case "object":
			return "an object";
		case "instance":
			return ir.expected;
		case "refine":
			return ir.expected;
		case "morph":
			return expectedOf(ir.input);
		case "alias":
			return ir.name === "this" ? expectedOf(ir.resolve()) : ir.name;
		case "sub":
			return ir.desc ?? ir.schema.description ?? expectedOf(ir.schema.ir);
	}
}
