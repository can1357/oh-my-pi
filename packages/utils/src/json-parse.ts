import {
	BACKSLASH,
	COLON,
	COMMA,
	isHexDigit,
	isNumberStart,
	isWhitespace,
	JsonLexer,
	LBRACE,
	LBRACKET,
	QUOTE,
	RBRACE,
	RBRACKET,
	SQUOTE,
	VALID_ESCAPE_CHAR,
} from "./json-lexer";

const U = 0x75;

const CONTROL_ESCAPES: readonly string[] = (() => {
	const e: string[] = [];
	e[0x08] = "\\b";
	e[0x09] = "\\t";
	e[0x0a] = "\\n";
	e[0x0c] = "\\f";
	e[0x0d] = "\\r";
	for (let cp = 0; cp <= 0x1f; cp++) {
		e[cp] ??= `\\u${cp.toString(16).padStart(4, "0")}`;
	}
	return e;
})();

/**
 * Sentinel returned by partial-mode value parsing when an atomic value
 * (number / keyword) is incomplete at the streaming edge, so the enclosing
 * object/array rolls back to the last valid prefix instead of committing junk.
 */
const INCOMPLETE = Symbol("incomplete");

/**
 * Lightweight string-level repair of the escape/control-char hazards that make
 * otherwise-valid JSON fail `JSON.parse`: raw control characters inside strings
 * are escaped, and invalid `\x` escapes have their backslash escaped. Returns the
 * input unchanged when no repair is needed. Pure string→string; does not parse.
 */
export function repairJson(json: string): string {
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let inString = false;
	let i = 0;

	while (i < len) {
		if (!inString) {
			// Fast scan: skip to next quote.
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			if (i >= len) break;
			inString = true;
			i++;
			continue;
		}

		// Fast scan inside string: advance past chars that need no handling.
		while (i < len) {
			const cp = json.charCodeAt(i);
			if (cp < 0x20 || cp === QUOTE || cp === BACKSLASH) break;
			i++;
		}
		if (i >= len) break;

		const cp = json.charCodeAt(i);

		if (cp === QUOTE) {
			inString = false;
			i++;
			continue;
		}

		if (cp === BACKSLASH) {
			// Need at least one char after the backslash; treat EOI as invalid escape.
			if (i + 1 >= len) {
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			const nextCp = json.charCodeAt(i + 1);

			if (nextCp === U) {
				// Need full \uXXXX, all four digits, all hex.
				if (
					i + 5 < len &&
					isHexDigit(json.charCodeAt(i + 2)) &&
					isHexDigit(json.charCodeAt(i + 3)) &&
					isHexDigit(json.charCodeAt(i + 4)) &&
					isHexDigit(json.charCodeAt(i + 5))
				) {
					i += 6;
					continue;
				}
				// Truncated or non-hex \u — escape the backslash, re-process the rest.
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			if (nextCp < 128 && VALID_ESCAPE_CHAR[nextCp] === 1) {
				i += 2;
				continue;
			}

			parts.push(json.slice(lastEmit, i), "\\\\");
			lastEmit = i + 1;
			i++;
			continue;
		}

		// Control character (cp < 0x20).
		parts.push(json.slice(lastEmit, i), CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i++;
	}

	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/**
 * Recursive-descent tree builder over the tolerant {@link JsonLexer} grammar
 * (single quotes, unquoted keys, comments, Python literals, stray commas,
 * literal invalid escapes, apostrophe recovery, bareword values).
 *
 * In `partial` mode (lexer mode `streaming`) an unterminated string/object/array
 * (or a value cut off at end-of-input) is auto-closed with whatever was parsed
 * so far, and an incomplete trailing atom rolls the enclosing container back
 * to its last valid prefix. In strict mode, end-of-input mid-value and trailing
 * garbage both throw, so a final parse never silently accepts a half-formed
 * tool call.
 */
class RelaxedJson {
	readonly #lex: JsonLexer;
	readonly #partial: boolean;

	constructor(source: string, partial: boolean) {
		this.#lex = new JsonLexer(source, partial ? "streaming" : "strict");
		this.#partial = partial;
	}

	parse(): unknown {
		const lex = this.#lex;
		lex.ws();
		if (lex.atEnd) {
			if (this.#partial) return undefined;
			throw new SyntaxError("Unexpected end of JSON input");
		}
		const value = this.#value(false);
		if (value === INCOMPLETE) return undefined;
		lex.ws();
		if (!this.#partial && !lex.atEnd) {
			throw new SyntaxError(`Unexpected trailing characters at position ${lex.pos}`);
		}
		return value;
	}

	#value(allowBareword: boolean): unknown {
		const lex = this.#lex;
		const c = lex.peek();
		if (c === LBRACE) return this.#object();
		if (c === LBRACKET) return this.#array();
		if (c === QUOTE || c === SQUOTE) return lex.string(c).value;
		// JS-only NaN / Infinity are deliberately not accepted: a tool must not
		// execute with a non-finite numeric arg; they fail the lexer's finite
		// guard (strict throw / partial rollback) like other bad tokens.
		if (isNumberStart(c)) return lex.number() ?? INCOMPLETE;
		const keyword = lex.keyword();
		if (keyword !== undefined) return keyword;
		if (this.#partial) {
			// Incomplete / unrecognized atomic token at the streaming edge — signal the
			// caller to roll back to the last valid prefix instead of committing junk.
			lex.pos = lex.src.length;
			return INCOMPLETE;
		}
		if (allowBareword) return lex.bareword();
		throw new SyntaxError(`Unexpected token at position ${lex.pos}`);
	}

	#object(): Record<string, unknown> {
		const lex = this.#lex;
		lex.pos++; // consume {
		const out: Record<string, unknown> = {};
		for (;;) {
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated object");
			}
			const c = lex.peek();
			if (c === RBRACE) {
				lex.pos++;
				return out;
			}
			if (c === COMMA) {
				// Tolerate leading / doubled / trailing commas.
				lex.pos++;
				continue;
			}
			const key = this.#key();
			lex.ws();
			if (lex.peek() === COLON) {
				lex.pos++;
			} else if (this.#partial) {
				return out;
			} else {
				throw new SyntaxError("Expected ':' in object");
			}
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Expected value after ':'");
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out[key] = value;
			lex.ws();
			const d = lex.peek();
			if (d === COMMA) {
				lex.pos++;
				continue;
			}
			if (d === RBRACE) {
				lex.pos++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or '}' in object");
		}
	}

	#array(): unknown[] {
		const lex = this.#lex;
		lex.pos++; // consume [
		const out: unknown[] = [];
		for (;;) {
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated array");
			}
			const c = lex.peek();
			if (c === RBRACKET) {
				lex.pos++;
				return out;
			}
			if (c === COMMA) {
				lex.pos++;
				continue;
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out.push(value);
			lex.ws();
			const d = lex.peek();
			if (d === COMMA) {
				lex.pos++;
				continue;
			}
			if (d === RBRACKET) {
				lex.pos++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or ']' in array");
		}
	}

	#key(): string {
		const lex = this.#lex;
		const c = lex.peek();
		if (c === QUOTE || c === SQUOTE) return lex.string(c).value;
		const key = lex.unquotedKey();
		if (key.length === 0 && !this.#partial) throw new SyntaxError("Expected object key");
		return key;
	}
}

/**
 * Final-parse a JSON value, repairing the common LLM malformations
 * ({@link RelaxedJson}). Tries strict `JSON.parse` first (fast path, exact JSON
 * semantics), then the relaxed parser. Throws when the input is unrepairable,
 * truncated, or carries trailing garbage — so callers can skip a bad tool call
 * rather than execute a half-formed one.
 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return new RelaxedJson(json, false).parse() as T;
	}
}

/**
 * Parse possibly-incomplete JSON during streaming. Always returns a value, never
 * throws: `{}` for empty/whitespace/unrecoverable buffers, and an auto-closed
 * best-effort object for truncated ones.
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	const trimmed = partialJson?.trimStart();
	if (!trimmed) return {} as T;
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		try {
			return (new RelaxedJson(trimmed, true).parse() ?? {}) as T;
		} catch {
			return {} as T;
		}
	}
}

/**
 * Default minimum byte growth before `parseStreamingJsonThrottled` will
 * re-parse a streaming tool-call argument buffer. Acts as the floor of the
 * geometric gate — see {@link parseStreamingJsonThrottled}.
 */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/**
 * Throttled variant of {@link parseStreamingJson} for the per-delta hot path.
 *
 * Tool calls arrive as a long sequence of small deltas — calling
 * `parseStreamingJson(buffer)` on every delta re-parses the entire buffer
 * each time, giving O(N²) work in the total buffer length. A fixed re-parse
 * floor alone does NOT fix this: with `minGrowthBytes` constant, a buffer of
 * length N is parsed N/minGrowthBytes times at an average cost of N/2, which
 * is still O(N²) (the constant just shrinks). Long `write` payloads — where
 * the buffer is the whole file — made this the dominant main-thread stall
 * during streaming.
 *
 * Instead the gate scales geometrically: once the buffer is large, a re-parse
 * requires growth proportional to the current length (`len / 32`, floored at
 * `minGrowthBytes`). Parse points then form a geometric progression, so a
 * buffer of length N is parsed O(log N) times for O(N log N) total work,
 * while small buffers keep the snappy fixed-cadence updates.
 *
 * Each provider tracks the last parsed length on its tool-call block, so the
 * final `toolcall_end` parse (which providers already perform unconditionally)
 * is the authoritative full parse — the throttle only delays mid-stream UI
 * updates, by at most ~3% of the accumulated content for large buffers.
 *
 * @returns the parsed object plus the new `parsedLen` to persist; or `null`
 *          when the buffer has not grown enough to warrant a re-parse.
 */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string | undefined,
	lastParsedLen: number,
	minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: T; parsedLen: number } | null {
	const len = partialJson?.length ?? 0;
	if (len === 0) return null;
	const growth = Math.max(minGrowthBytes, len >> 5);
	if (lastParsedLen > 0 && len - lastParsedLen < growth) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

/**
 * Classification of a streaming buffer against strict JSON (RFC 8259):
 * - `"complete"`: exactly one whole JSON value (plus surrounding whitespace).
 * - `"prefix"`: a proper prefix of some valid JSON value — more bytes can
 *   still complete it.
 * - `"invalid"`: no suffix can ever make it valid strict JSON (e.g. a raw
 *   control character inside a string, or a second top-level value).
 */
export type JsonPrefixState = "complete" | "prefix" | "invalid";

/** What the strict-prefix scanner expects at the current position. */
const enum JsonExpect {
	Value,
	ObjKeyOrEnd,
	ObjKey,
	ObjColon,
	ObjCommaOrEnd,
	ArrValueOrEnd,
	ArrCommaOrEnd,
	End,
}

/**
 * Classify `text` as a strict-JSON value, prefix, or dead end.
 *
 * Providers use this to disambiguate identifierless streaming tool-call
 * deltas: a chunk starting with `{` is a *new* sibling call only if the
 * current call's argument buffer cannot absorb it — the buffer is already a
 * complete value, already unsalvageable (lossy hosts abandon buffers
 * mid-string, leaving raw control characters strict JSON forbids), or the
 * concatenation would break it. Unlike {@link parseStreamingJson} this is
 * deliberately strict: forgiving repair would mask exactly the corruption
 * signals the caller needs.
 *
 * A top-level number at end-of-input classifies as `"complete"` even though
 * more digits could extend it; tool-argument buffers are always objects, so
 * the ambiguity is immaterial here.
 */
export function classifyJsonPrefix(text: string): JsonPrefixState {
	const n = text.length;
	let i = 0;
	// Container stack: true = object, false = array.
	const stack: boolean[] = [];
	let expect = JsonExpect.Value;

	/** Consume a string starting at the opening quote. 1 = ok, 0 = prefix, -1 = invalid. */
	const scanString = (): 1 | 0 | -1 => {
		i++; // opening quote
		while (i < n) {
			const c = text.charCodeAt(i);
			if (c === QUOTE) {
				i++;
				return 1;
			}
			if (c === BACKSLASH) {
				i++;
				if (i >= n) return 0;
				const e = text.charCodeAt(i);
				if (e >= 128 || !VALID_ESCAPE_CHAR[e]) return -1;
				i++;
				if (e === U) {
					for (let k = 0; k < 4; k++, i++) {
						if (i >= n) return 0;
						if (!isHexDigit(text.charCodeAt(i))) return -1;
					}
				}
				continue;
			}
			if (c < 0x20) return -1; // raw control char: strict JSON forbids it
			i++;
		}
		return 0;
	};

	/** Consume a number starting at `-` or a digit. 1 = token done, 0 = prefix, -1 = invalid. */
	const scanNumber = (): 1 | 0 | -1 => {
		if (text.charCodeAt(i) === 0x2d) i++; // -
		if (i >= n) return 0;
		let c = text.charCodeAt(i);
		if (c === 0x30) {
			i++; // 0: no further integer digits allowed
		} else if (c >= 0x31 && c <= 0x39) {
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		} else {
			return -1;
		}
		if (i < n && text.charCodeAt(i) === 0x2e) {
			i++; // .
			if (i >= n) return 0;
			if (text.charCodeAt(i) < 0x30 || text.charCodeAt(i) > 0x39) return -1;
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		}
		c = i < n ? text.charCodeAt(i) : 0;
		if (c === 0x65 || c === 0x45) {
			i++; // e | E
			if (i < n && (text.charCodeAt(i) === 0x2b || text.charCodeAt(i) === 0x2d)) i++;
			if (i >= n) return 0;
			if (text.charCodeAt(i) < 0x30 || text.charCodeAt(i) > 0x39) return -1;
			while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
		}
		return 1;
	};

	/** Consume `true`/`false`/`null`. 1 = done, 0 = prefix, -1 = invalid. */
	const scanKeyword = (): 1 | 0 | -1 => {
		for (const word of ["true", "false", "null"] as const) {
			if (word.charCodeAt(0) !== text.charCodeAt(i)) continue;
			const available = Math.min(word.length, n - i);
			if (!word.startsWith(text.slice(i, i + available))) return -1;
			i += available;
			return available === word.length ? 1 : 0;
		}
		return -1;
	};

	/** A value just finished; the next expectation follows from the stack. */
	const valueDone = (): JsonExpect =>
		stack.length === 0
			? JsonExpect.End
			: stack[stack.length - 1]
				? JsonExpect.ObjCommaOrEnd
				: JsonExpect.ArrCommaOrEnd;

	while (i < n) {
		const c = text.charCodeAt(i);
		if (isWhitespace(c)) {
			i++;
			continue;
		}
		switch (expect) {
			case JsonExpect.Value:
			case JsonExpect.ArrValueOrEnd: {
				if (c === 0x5d && expect === JsonExpect.ArrValueOrEnd) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c === 0x7b) {
					stack.push(true);
					i++;
					expect = JsonExpect.ObjKeyOrEnd;
					break;
				}
				if (c === 0x5b) {
					stack.push(false);
					i++;
					expect = JsonExpect.ArrValueOrEnd;
					break;
				}
				let r: 1 | 0 | -1;
				if (c === QUOTE) r = scanString();
				else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) r = scanNumber();
				else if (c === 0x74 || c === 0x66 || c === 0x6e) r = scanKeyword();
				else return "invalid";
				if (r === -1) return "invalid";
				if (r === 0) return "prefix";
				expect = valueDone();
				break;
			}
			case JsonExpect.ObjKeyOrEnd:
			case JsonExpect.ObjKey: {
				if (c === 0x7d && expect === JsonExpect.ObjKeyOrEnd) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== QUOTE) return "invalid";
				const r = scanString();
				if (r === -1) return "invalid";
				if (r === 0) return "prefix";
				expect = JsonExpect.ObjColon;
				break;
			}
			case JsonExpect.ObjColon:
				if (c !== 0x3a) return "invalid";
				i++;
				expect = JsonExpect.Value;
				break;
			case JsonExpect.ObjCommaOrEnd:
				if (c === 0x7d) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== 0x2c) return "invalid";
				i++;
				expect = JsonExpect.ObjKey;
				break;
			case JsonExpect.ArrCommaOrEnd:
				if (c === 0x5d) {
					stack.pop();
					i++;
					expect = valueDone();
					break;
				}
				if (c !== 0x2c) return "invalid";
				i++;
				expect = JsonExpect.Value;
				break;
			case JsonExpect.End:
				return "invalid"; // trailing non-whitespace after a complete value
		}
	}
	return expect === JsonExpect.End ? "complete" : "prefix";
}
