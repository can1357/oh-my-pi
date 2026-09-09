/** Neutral IR and parser for the benchmark's arktype-compatible definitions. */
export type IR =
	| { k: "unknown" }
	| { k: "null" }
	| { k: "undefined" }
	| { k: "boolean" }
	| { k: "string"; min?: number; max?: number }
	| { k: "number"; min?: number; max?: number; xmin?: boolean; xmax?: boolean; int?: boolean }
	| { k: "lit"; v: string | number | boolean }
	| { k: "union"; members: IR[] }
	| { k: "array"; el: IR }
	| { k: "object"; props: PropIR[]; index?: IR; extras: Extras };

export type Extras = "keep" | "reject" | "delete";

export interface PropIR {
	key: string;
	opt: boolean;
	val: IR;
	def?: unknown;
	hasDefault?: boolean;
}

/** Arktype-style string DSL, object literal, or `[def, "[]"]` array tuple. */
export type Def = string | { [key: string]: Def } | readonly Def[];

type Token =
	| { type: "id"; value: string }
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "operator"; value: string };

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === " " || character === "\t" || character === "\n") {
			index++;
			continue;
		}
		if (character === "'" || character === '"') {
			let end = index + 1;
			let value = "";
			while (end < source.length && source[end] !== character) value += source[end++];
			if (end >= source.length) throw new Error(`unterminated string literal in "${source}"`);
			tokens.push({ type: "string", value });
			index = end + 1;
			continue;
		}
		if (
			(character >= "0" && character <= "9") ||
			(character === "-" && source[index + 1] >= "0" && source[index + 1] <= "9")
		) {
			let end = index + 1;
			while (end < source.length && ((source[end] >= "0" && source[end] <= "9") || source[end] === ".")) end++;
			tokens.push({ type: "number", value: Number(source.slice(index, end)) });
			index = end;
			continue;
		}
		if (/[a-zA-Z_]/.test(character)) {
			let end = index + 1;
			while (end < source.length && /[\w.]/.test(source[end])) end++;
			tokens.push({ type: "id", value: source.slice(index, end) });
			index = end;
			continue;
		}
		if (character === "<" || character === ">") {
			const operator = source[index + 1] === "=" ? `${character}=` : character;
			tokens.push({ type: "operator", value: operator });
			index += operator.length;
			continue;
		}
		if ("|()[]=".includes(character)) {
			tokens.push({ type: "operator", value: character });
			index++;
			continue;
		}
		throw new Error(`unexpected char '${character}' in "${source}"`);
	}
	return tokens;
}

const COMPARATORS = new Set(["<", "<=", ">", ">="]);

class Parser {
	readonly #tokens: Token[];
	#position = 0;

	constructor(source: string) {
		this.#tokens = tokenize(source);
	}

	#peek(offset = 0): Token | undefined {
		return this.#tokens[this.#position + offset];
	}

	#next(): Token {
		const token = this.#tokens[this.#position++];
		if (!token) throw new Error("unexpected end of definition");
		return token;
	}

	#eat(operator: string): boolean {
		const token = this.#peek();
		if (token?.type !== "operator" || token.value !== operator) return false;
		this.#position++;
		return true;
	}

	parseTop(): { ir: IR; defaultValue?: unknown; hasDefault: boolean } {
		const ir = this.#parseUnion();
		if (!this.#eat("=")) {
			this.#expectEnd();
			return { ir, hasDefault: false };
		}
		const token = this.#next();
		let defaultValue: unknown;
		if (token.type === "number" || token.type === "string") defaultValue = token.value;
		else if (token.type === "id" && (token.value === "true" || token.value === "false")) {
			defaultValue = token.value === "true";
		} else if (token.type === "id" && token.value === "null") defaultValue = null;
		else throw new Error("unsupported default literal");
		this.#expectEnd();
		return { ir, defaultValue, hasDefault: true };
	}

	#expectEnd(): void {
		if (this.#position !== this.#tokens.length) throw new Error("trailing tokens in definition");
	}

	#parseUnion(): IR {
		const first = this.#parseBounded();
		if (!this.#eat("|")) return first;
		const members = [first, this.#parseBounded()];
		while (this.#eat("|")) members.push(this.#parseBounded());
		return { k: "union", members };
	}

	#parseBounded(): IR {
		const first = this.#peek();
		const possibleComparator = this.#peek(1);
		if (
			first?.type === "number" &&
			possibleComparator?.type === "operator" &&
			COMPARATORS.has(possibleComparator.value)
		) {
			this.#position++;
			const comparator = this.#next();
			if (comparator.type !== "operator") throw new Error("expected comparator");
			let node = applyBound(this.#parsePostfix(), flipComparator(comparator.value), first.value);
			const upper = this.#peek();
			if (upper?.type === "operator" && COMPARATORS.has(upper.value)) {
				this.#position++;
				const value = this.#next();
				if (value.type !== "number") throw new Error("expected number after comparator");
				node = applyBound(node, upper.value, value.value);
			}
			return node;
		}
		let node = this.#parsePostfix();
		const comparator = this.#peek();
		if (comparator?.type === "operator" && COMPARATORS.has(comparator.value)) {
			this.#position++;
			const value = this.#next();
			if (value.type !== "number") throw new Error("expected number after comparator");
			node = applyBound(node, comparator.value, value.value);
		}
		return node;
	}

	#parsePostfix(): IR {
		let node = this.#parsePrimary();
		while (this.#eat("[")) {
			if (!this.#eat("]")) throw new Error("expected ']'");
			node = { k: "array", el: node };
		}
		return node;
	}

	#parsePrimary(): IR {
		const token = this.#next();
		if (token.type === "operator" && token.value === "(") {
			const node = this.#parseUnion();
			if (!this.#eat(")")) throw new Error("expected ')'");
			return node;
		}
		if (token.type === "string" || token.type === "number") return { k: "lit", v: token.value };
		if (token.type !== "id") throw new Error(`unexpected token ${JSON.stringify(token)}`);
		switch (token.value) {
			case "string":
				return { k: "string" };
			case "number":
				return { k: "number" };
			case "number.integer":
				return { k: "number", int: true };
			case "boolean":
				return { k: "boolean" };
			case "null":
				return { k: "null" };
			case "undefined":
				return { k: "undefined" };
			case "unknown":
			case "object":
				return { k: "unknown" };
			case "true":
				return { k: "lit", v: true };
			case "false":
				return { k: "lit", v: false };
			default:
				throw new Error(`unknown keyword "${token.value}"`);
		}
	}
}

function flipComparator(operator: string): string {
	switch (operator) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		case ">=":
			return "<=";
		default:
			throw new Error(`bad comparator ${operator}`);
	}
}

function applyBound(node: IR, operator: string, value: number): IR {
	if (node.k !== "string" && node.k !== "number" && node.k !== "array") throw new Error(`cannot bound ${node.k}`);
	const target = node as { min?: number; max?: number; xmin?: boolean; xmax?: boolean };
	if (operator === ">=") {
		target.min = value;
		if (node.k === "number") target.xmin = false;
	} else if (operator === ">") {
		target.min = node.k === "number" ? value : value + 1;
		if (node.k === "number") target.xmin = true;
	} else if (operator === "<=") {
		target.max = value;
		if (node.k === "number") target.xmax = false;
	} else if (operator === "<") {
		target.max = node.k === "number" ? value : value - 1;
		if (node.k === "number") target.xmax = true;
	}
	return node;
}

/** Parse a benchmark definition into the neutral IR. */
export function parseDef(definition: Def): IR {
	if (typeof definition === "string") return new Parser(definition).parseTop().ir;
	if (Array.isArray(definition)) {
		if (definition.length === 2 && definition[1] === "[]") return { k: "array", el: parseDef(definition[0] as Def) };
		throw new Error('unsupported tuple definition (only [def, "[]"])');
	}
	if (typeof definition !== "object" || definition === null)
		throw new Error(`unsupported definition: ${String(definition)}`);
	const props: PropIR[] = [];
	let index: IR | undefined;
	let extras: Extras = "keep";
	for (const rawKey of Object.keys(definition)) {
		const value = (definition as Record<string, Def>)[rawKey];
		if (rawKey === "+") {
			if (value !== "reject" && value !== "delete" && value !== "ignore")
				throw new Error(`bad "+" value ${String(value)}`);
			extras = value === "ignore" ? "keep" : value;
			continue;
		}
		if (rawKey === "[string]") {
			index = parseDef(value);
			continue;
		}
		const opt = rawKey.endsWith("?");
		const key = opt ? rawKey.slice(0, -1) : rawKey;
		if (typeof value === "string") {
			const parsed = new Parser(value).parseTop();
			const property: PropIR = { key, opt, val: parsed.ir };
			if (parsed.hasDefault) {
				property.def = parsed.defaultValue;
				property.hasDefault = true;
			}
			props.push(property);
		} else props.push({ key, opt, val: parseDef(value) });
	}
	return { k: "object", props, index, extras };
}
