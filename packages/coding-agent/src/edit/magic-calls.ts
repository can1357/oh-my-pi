import { type ToolCall, toolWireSchema } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { APPLY_TOOLS } from "./magic-tools";

interface WrittenToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

interface Parameter {
	type: unknown;
	optional: boolean;
}

const TOOL_PARAMETERS = new Map(
	APPLY_TOOLS.map((tool): [string, Map<string, Parameter>] => {
		const { properties, required } = toolWireSchema(tool);
		const fields = new Map<string, Parameter>();
		if (isRecord(properties)) {
			for (const key in properties) {
				const schema = properties[key];
				if (isRecord(schema)) {
					fields.set(key, { type: schema.type, optional: !Array.isArray(required) || !required.includes(key) });
				}
			}
		}
		return [tool.name, fields];
	}),
);
const TOOL_NAMES = [...TOOL_PARAMETERS.keys()].map(name => RegExp.escape(name)).join("|");
const PYTHON_START = new RegExp(String.raw`^\s*(?:\[\s*)?(?:${TOOL_NAMES})\s*\(`);
const JSON_START = new RegExp(String.raw`^\s*(?:\[\s*)?\{\s*"(?:name|function|arguments|parameters|${TOOL_NAMES})"`);
const FENCE_LINE = /^[\t ]*(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
const INTEGER_STRING = /^[+-]?\d+$/;

/** Normalize schema-compatible wire values or give the model a JSON parse error. */
export function normalizeApplyArguments(call: ToolCall): Record<string, unknown> | string {
	let args = call.arguments;
	if (Object.hasOwn(args, "__parseError") || Object.hasOwn(args, "__rawJson")) {
		const recovered = typeof args.__rawJson === "string" ? repeatedJsonObject(args.__rawJson) : undefined;
		if (!recovered || Object.hasOwn(recovered, "__parseError") || Object.hasOwn(recovered, "__rawJson")) {
			const detail =
				typeof args.__parseError === "string" && args.__parseError ? args.__parseError : "Invalid JSON.";
			return `Malformed ${call.name} arguments: ${detail}\nSend one JSON object per call.`;
		}
		args = recovered;
	}
	const fields = TOOL_PARAMETERS.get(call.name);
	if (!fields) return args;
	let normalized = args;
	for (const [key, field] of fields) {
		const value = args[key];
		if (value === null && field.optional) {
			if (normalized === args) normalized = { ...args };
			delete normalized[key];
		} else if (typeof value === "string") {
			let coerced: boolean | number;
			if (field.type === "boolean" && (value === "true" || value === "false")) {
				coerced = value === "true";
			} else if (field.type === "integer" && INTEGER_STRING.test(value)) {
				coerced = Number(value);
				if (!Number.isSafeInteger(coerced)) continue;
			} else {
				continue;
			}
			if (normalized === args) normalized = { ...args };
			normalized[key] = coerced;
		}
	}
	return normalized;
}

// Some providers duplicate argument deltas. Recover only if every complete object agrees.
function repeatedJsonObject(raw: string): Record<string, unknown> | undefined {
	let depth = 0;
	let start = 0;
	let quoted = false;
	let first: Record<string, unknown> | undefined;
	let repeated = false;
	for (let i = 0; i < raw.length; i++) {
		const char = raw.charAt(i);
		if (depth === 0) {
			if (/\s/.test(char)) continue;
			if (char !== "{") return undefined;
			start = i;
			depth = 1;
		} else if (quoted) {
			if (char === "\\") i++;
			else if (char === '"') quoted = false;
		} else if (char === '"') {
			quoted = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			let value: unknown;
			try {
				value = JSON.parse(raw.slice(start, i + 1));
			} catch {
				return undefined;
			}
			if (!isRecord(value)) return undefined;
			if (first) {
				if (!Bun.deepEquals(first, value, true)) return undefined;
				repeated = true;
			} else {
				first = value;
			}
		}
	}
	return depth === 0 && repeated ? first : undefined;
}

/** Read fenced JSON/Python and complete bare Python call lines, without treating prose as a call. */
export function parseWrittenToolCalls(text: string): { calls: WrittenToolCall[]; attempted: boolean } {
	const calls: WrittenToolCall[] = [];
	let attempted = false;
	let from = 0;
	let fence: { marker: string; tool: boolean } | undefined;
	const parseBare = (outside: string) => {
		for (const line of outside.split("\n")) {
			if (PYTHON_START.test(line)) {
				attempted = true;
				const parsed = new PythonCalls(line).parse();
				if (parsed) calls.push(...parsed);
			} else if (JSON_START.test(line)) {
				attempted = true;
			}
		}
	};
	for (const match of text.matchAll(FENCE_LINE)) {
		const marker = match[1]!;
		const tag = match[2]!.trim();
		if (!fence) {
			parseBare(text.slice(from, match.index));
			fence = { marker, tool: /^tool_(?:code|response)$/.test(tag) };
		} else {
			if (!marker.startsWith(fence.marker) || tag !== "") continue;
			const body = text.slice(from, match.index);
			if (PYTHON_START.test(body)) {
				attempted = true;
				const parsed = new PythonCalls(body).parse();
				if (parsed) calls.push(...parsed);
			} else {
				attempted ||= fence.tool || JSON_START.test(body);
				const value = parseWrittenJson(body);
				for (const entry of Array.isArray(value) ? value : [value]) {
					const call = writtenToolCall(entry);
					if (call) calls.push(call);
				}
			}
			fence = undefined;
		}
		from = match.index + match[0].length + 1;
	}
	if (fence) {
		const tail = text.slice(from);
		attempted ||= fence.tool || PYTHON_START.test(tail) || JSON_START.test(tail);
	} else {
		parseBare(text.slice(from));
	}
	return { calls, attempted };
}

const JSON_PYTHON_LITERALS = /"(?:[^"\\]|\\.)*"|\b(?:True|False|None)\b/gs;

function parseWrittenJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Translate only tokens outside strings: the arguments may contain Python source verbatim.
		const normalized = text.replace(JSON_PYTHON_LITERALS, token =>
			token === "True" ? "true" : token === "False" ? "false" : token === "None" ? "null" : token,
		);
		if (normalized === text) return undefined;
		try {
			return JSON.parse(normalized);
		} catch {
			return undefined;
		}
	}
}

function writtenToolCall(entry: unknown): WrittenToolCall | undefined {
	if (!isRecord(entry)) return undefined;
	const { function: fn, name, parameters, arguments: args, ...rest } = entry;
	if (isRecord(fn)) return writtenToolCall(fn);
	const tool = typeof name === "string" ? name : typeof fn === "string" ? fn : undefined;
	if (tool === undefined) {
		// A tool name can also be the object's only key: `{"replace": {…args}}`.
		const keys = Object.keys(entry);
		const only = keys[0];
		const params = only === undefined ? undefined : entry[only];
		return keys.length === 1 && only !== undefined && TOOL_PARAMETERS.has(only) && isRecord(params)
			? { name: only, arguments: params }
			: undefined;
	}
	let params: unknown = parameters ?? args ?? rest;
	if (typeof params === "string") params = parseWrittenJson(params);
	return TOOL_PARAMETERS.has(tool) && isRecord(params) ? { name: tool, arguments: params } : undefined;
}

const SPACE = /\s+/y;
const IDENTIFIER = /[A-Za-z_]\w*/y;
const INTEGER = /[+-]?(?:0x_?[\da-f](?:_?[\da-f])*|0o_?[0-7](?:_?[0-7])*|0b_?[01](?:_?[01])*|\d(?:_?\d)*)/iy;
const ESCAPE = /\\(?:\r?\n|[0-7]{1,3}|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[\s\S])/y;
const SIMPLE_ESCAPES: Record<string, string> = {
	a: "\u0007",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"'": "'",
	'"': '"',
	"\\": "\\",
	"\n": "",
	"\r\n": "",
};

/** Restricted literal grammar; never evaluates or recovers a partial call or call list. */
class PythonCalls {
	#at = 0;

	constructor(readonly text: string) {}

	parse(): WrittenToolCall[] | undefined {
		const list = this.#take("[");
		const calls: WrittenToolCall[] = [];
		for (;;) {
			if (list && this.#take("]")) break;
			const call = this.#call();
			if (!call) return undefined;
			calls.push(call);
			if (!list || this.#take("]")) break;
			if (!this.#take(",")) return undefined;
		}
		this.#match(SPACE);
		return this.#at === this.text.length ? calls : undefined;
	}

	#call(): WrittenToolCall | undefined {
		const name = this.#match(IDENTIFIER);
		if (!name || !TOOL_PARAMETERS.has(name) || !this.#take("(")) return undefined;
		const args: Record<string, unknown> = Object.create(null);
		while (!this.#take(")")) {
			const key = this.#match(IDENTIFIER);
			if (!key || Object.hasOwn(args, key) || !this.#take("=")) return undefined;
			const value = this.#literal();
			if (value === undefined) return undefined;
			args[key] = value;
			if (this.#take(")")) break;
			if (!this.#take(",")) return undefined;
		}
		return { name, arguments: args };
	}

	#literal(): string | number | boolean | null | undefined {
		this.#match(SPACE);
		const quote = this.text[this.#at];
		if (quote === '"' || quote === "'") return this.#string(quote);
		const word = this.#match(IDENTIFIER);
		if (word === "True" || word === "true") return true;
		if (word === "False" || word === "false") return false;
		if (word === "None" || word === "null") return null;
		if (word !== undefined) return undefined;
		const token = this.#match(INTEGER);
		if (token === undefined) return undefined;
		const value = (token.startsWith("-") ? -1 : 1) * Number(token.replace(/^[+-]|_/g, ""));
		return Number.isSafeInteger(value) ? value : undefined;
	}

	#string(quote: string): string | undefined {
		const triple = quote.repeat(3);
		const delimiter = this.text.startsWith(triple, this.#at) ? triple : quote;
		this.#at += delimiter.length;
		let from = this.#at;
		let value = "";
		while (this.#at < this.text.length) {
			if (this.text.startsWith(delimiter, this.#at)) {
				value += this.text.slice(from, this.#at);
				this.#at += delimiter.length;
				return value;
			}
			const char = this.text[this.#at];
			if (char === "\\") {
				value += this.text.slice(from, this.#at);
				const token = this.#match(ESCAPE);
				if (!token) return undefined;
				const escape = token.slice(1);
				const first = escape.charAt(0);
				if (first === "x" || first === "u" || first === "U") {
					if (escape.length === 1) return undefined;
					const code = Number.parseInt(escape.slice(1), 16);
					if (code > 0x10ffff) return undefined;
					value += String.fromCodePoint(code);
				} else if (first === "N") {
					return undefined; // Named Unicode escapes require Python's name table.
				} else if (first >= "0" && first <= "7") {
					value += String.fromCharCode(Number.parseInt(escape, 8));
				} else {
					value += Object.hasOwn(SIMPLE_ESCAPES, escape) ? SIMPLE_ESCAPES[escape] : token;
				}
				from = this.#at;
			} else {
				if (delimiter === quote && (char === "\n" || char === "\r")) return undefined;
				this.#at++;
			}
		}
		return undefined;
	}

	#take(token: string): boolean {
		this.#match(SPACE);
		if (!this.text.startsWith(token, this.#at)) return false;
		this.#at += token.length;
		return true;
	}

	#match(token: RegExp): string | undefined {
		token.lastIndex = this.#at;
		const match = token.exec(this.text);
		if (!match) return undefined;
		this.#at = token.lastIndex;
		return match[0];
	}
}
