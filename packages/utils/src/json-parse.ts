const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const U = 0x75;
const SQUOTE = 0x27;

// Valid chars after `\`: " \ / b f n r t u
const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

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

const HEX4_RE = /^[0-9a-fA-F]{4}$/;

function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function isIdentChar(cp: number): boolean {
	return (
		(cp >= 0x30 && cp <= 0x39) ||
		((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a) ||
		cp === 0x5f /* _ */ ||
		cp === 0x24 /* $ */
	);
}

/** Bareword literals: standard JSON plus Python `True`/`False`/`None`. */
const KEYWORDS: readonly (readonly [string, unknown])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];

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
 * Recursive-descent parser for a forgiving superset of JSON. Beyond strict JSON
 * it accepts, and normalizes, the malformations LLM tool-call bodies leak in
 * practice:
 *
 * - single-quoted strings and unquoted object keys (JSON5);
 * - trailing / stray commas, and `//` + block comments;
 * - Python literals `True` / `False` / `None` and JS `NaN` / `Infinity`;
 * - raw control characters and invalid `\x` escapes inside strings (kept literally);
 * - unescaped quotes inside strings — a quote only closes a string when followed
 *   by a value terminator, recovering apostrophes such as `'it's'`.
 *
 * In `partial` mode an unterminated string/object/array (or a value cut off at
 * end-of-input) is auto-closed with whatever was parsed so far — for streaming.
 * In strict mode, end-of-input mid-value and trailing garbage both throw, so a
 * final parse never silently accepts a half-formed tool call.
 */
class RelaxedJson {
	readonly #s: string;
	readonly #n: number;
	readonly #partial: boolean;
	#i = 0;

	constructor(source: string, partial: boolean) {
		this.#s = source;
		this.#n = source.length;
		this.#partial = partial;
	}

	parse(): unknown {
		this.#ws();
		if (this.#i >= this.#n) {
			if (this.#partial) return undefined;
			throw new SyntaxError("Unexpected end of JSON input");
		}
		const value = this.#value();
		if (value === INCOMPLETE) return undefined;
		this.#ws();
		if (!this.#partial && this.#i < this.#n) {
			throw new SyntaxError(`Unexpected trailing characters at position ${this.#i}`);
		}
		return value;
	}

	#ws(): void {
		const s = this.#s;
		for (;;) {
			while (this.#i < this.#n && isWhitespace(s.charCodeAt(this.#i))) this.#i++;
			if (this.#i + 1 < this.#n && s.charCodeAt(this.#i) === 0x2f /* / */) {
				const next = s.charCodeAt(this.#i + 1);
				if (next === 0x2f /* / line comment */) {
					this.#i += 2;
					while (this.#i < this.#n && s.charCodeAt(this.#i) !== 0x0a) this.#i++;
					continue;
				}
				if (next === 0x2a /* * block comment */) {
					this.#i += 2;
					while (
						this.#i + 1 < this.#n &&
						!(s.charCodeAt(this.#i) === 0x2a && s.charCodeAt(this.#i + 1) === 0x2f)
					) {
						this.#i++;
					}
					this.#i = Math.min(this.#i + 2, this.#n);
					continue;
				}
			}
			break;
		}
	}

	#value(): unknown {
		const s = this.#s;
		const c = s[this.#i];
		if (c === "{") return this.#object();
		if (c === "[") return this.#array();
		if (c === '"' || c === "'") return this.#string(s.charCodeAt(this.#i));
		const cc = s.charCodeAt(this.#i);
		if (cc === 0x2d /* - */ || cc === 0x2b /* + */ || cc === 0x2e /* . */ || (cc >= 0x30 && cc <= 0x39)) {
			// JS-only NaN / Infinity are deliberately not accepted: a tool must not
			// execute with a non-finite numeric arg; they fall through #number's
			// NaN guard (strict throw / partial rollback) like other bad tokens.
			return this.#number();
		}
		return this.#keyword();
	}

	#object(): Record<string, unknown> {
		this.#i++; // consume {
		const out: Record<string, unknown> = {};
		for (;;) {
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated object");
			}
			const c = this.#s[this.#i];
			if (c === "}") {
				this.#i++;
				return out;
			}
			if (c === ",") {
				// Tolerate leading / doubled / trailing commas.
				this.#i++;
				continue;
			}
			const key = this.#key();
			this.#ws();
			if (this.#i < this.#n && this.#s[this.#i] === ":") {
				this.#i++;
			} else if (this.#partial) {
				return out;
			} else {
				throw new SyntaxError("Expected ':' in object");
			}
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Expected value after ':'");
			}
			const value = this.#value();
			if (value === INCOMPLETE) return out;
			out[key] = value;
			this.#ws();
			const d = this.#i < this.#n ? this.#s[this.#i] : "";
			if (d === ",") {
				this.#i++;
				continue;
			}
			if (d === "}") {
				this.#i++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or '}' in object");
		}
	}

	#array(): unknown[] {
		this.#i++; // consume [
		const out: unknown[] = [];
		for (;;) {
			this.#ws();
			if (this.#i >= this.#n) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated array");
			}
			const c = this.#s[this.#i];
			if (c === "]") {
				this.#i++;
				return out;
			}
			if (c === ",") {
				this.#i++;
				continue;
			}
			const value = this.#value();
			if (value === INCOMPLETE) return out;
			out.push(value);
			this.#ws();
			const d = this.#i < this.#n ? this.#s[this.#i] : "";
			if (d === ",") {
				this.#i++;
				continue;
			}
			if (d === "]") {
				this.#i++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or ']' in array");
		}
	}

	#key(): string {
		const c = this.#s[this.#i];
		if (c === '"' || c === "'") return this.#string(this.#s.charCodeAt(this.#i));
		// Unquoted identifier key: read until a structural delimiter / whitespace.
		const start = this.#i;
		while (this.#i < this.#n) {
			const ch = this.#s[this.#i];
			if (ch === ":" || ch === "," || ch === "}" || isWhitespace(this.#s.charCodeAt(this.#i))) break;
			this.#i++;
		}
		if (this.#i === start) {
			if (this.#partial) return "";
			throw new SyntaxError("Expected object key");
		}
		return this.#s.slice(start, this.#i);
	}

	#string(quote: number): string {
		const s = this.#s;
		const n = this.#n;
		let i = this.#i + 1; // skip opening quote
		let out = "";
		let runStart = i;
		while (i < n) {
			const cc = s.charCodeAt(i);
			if (cc !== BACKSLASH && cc !== quote) {
				i++;
				continue;
			}
			if (cc === quote) {
				// Apostrophe / inner-quote recovery (a quote that isn't followed by a
				// value terminator is literal) is safe for single quotes and in partial
				// mode. For double quotes in strict mode, close on the first unescaped
				// quote like standard JSON so malformed structure fails loudly instead
				// of silently swallowing commas/colons into one string.
				const lenient = quote === SQUOTE || this.#partial;
				if (!lenient || this.#closesString(i + 1)) {
					out += s.slice(runStart, i);
					this.#i = i + 1;
					return out;
				}
				// Unescaped inner quote (e.g. apostrophe in `'it's'`) — keep it literal.
				i++;
				continue;
			}
			// Backslash escape.
			out += s.slice(runStart, i);
			i++;
			if (i >= n) {
				out += "\\";
				runStart = i;
				break;
			}
			const esc = s.charCodeAt(i);
			switch (esc) {
				case QUOTE:
					out += '"';
					break;
				case SQUOTE:
					out += "'";
					break;
				case BACKSLASH:
					out += "\\";
					break;
				case 0x2f:
					out += "/";
					break;
				case 0x62:
					out += "\b";
					break;
				case 0x66:
					out += "\f";
					break;
				case 0x6e:
					out += "\n";
					break;
				case 0x72:
					out += "\r";
					break;
				case 0x74:
					out += "\t";
					break;
				case U: {
					const hex = s.slice(i + 1, i + 5);
					if (HEX4_RE.test(hex)) {
						out += String.fromCharCode(parseInt(hex, 16));
						i += 4;
					} else {
						out += "\\u"; // invalid \u — keep literal
					}
					break;
				}
				default:
					out += `\\${s[i]}`; // invalid escape — keep backslash literal
			}
			i++;
			runStart = i;
		}
		out += s.slice(runStart, i);
		if (this.#partial) {
			this.#i = i;
			return out;
		}
		throw new SyntaxError("Unterminated string");
	}

	/** A quote closes a string only when the next non-space char ends a value. */
	#closesString(from: number): boolean {
		const s = this.#s;
		let k = from;
		while (k < this.#n && isWhitespace(s.charCodeAt(k))) k++;
		if (k >= this.#n) return true;
		const c = s[k];
		return c === "," || c === "}" || c === "]" || c === ":";
	}

	#number(): unknown {
		const s = this.#s;
		const start = this.#i;
		while (this.#i < this.#n) {
			const ch = s[this.#i];
			if (
				(ch >= "0" && ch <= "9") ||
				ch === "-" ||
				ch === "+" ||
				ch === "." ||
				ch === "e" ||
				ch === "E" ||
				ch === "x" ||
				ch === "X" ||
				(ch >= "a" && ch <= "f") ||
				(ch >= "A" && ch <= "F")
			) {
				this.#i++;
			} else {
				break;
			}
		}
		const token = s.slice(start, this.#i);
		const num = Number(token);
		if (Number.isNaN(num)) {
			if (this.#partial) return INCOMPLETE;
			throw new SyntaxError(`Invalid number: ${token}`);
		}
		return num;
	}

	#keyword(): unknown {
		const s = this.#s;
		const i = this.#i;
		for (const [word, value] of KEYWORDS) {
			// Require a non-identifier boundary so `Truex` / `nullish` are not misread
			// as the keyword followed by junk.
			if (s.startsWith(word, i) && !isIdentChar(s.charCodeAt(i + word.length))) {
				this.#i += word.length;
				return value;
			}
		}
		if (this.#partial) {
			// Incomplete / unrecognized atomic token at the streaming edge — signal the
			// caller to roll back to the last valid prefix instead of committing junk.
			this.#i = this.#n;
			return INCOMPLETE;
		}
		throw new SyntaxError(`Unexpected token at position ${this.#i}`);
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
 * re-parse a streaming tool-call argument buffer. Bounds the mid-stream
 * partial-parse cost from quadratic to linear in N.
 */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/**
 * Throttled variant of {@link parseStreamingJson} for the per-delta hot path.
 *
 * Tool calls arrive as a long sequence of small deltas — calling
 * `parseStreamingJson(buffer)` on every delta re-parses the entire buffer
 * each time, giving O(N²) work in the total buffer length. Throttling skips
 * the re-parse until at least `minGrowthBytes` of new content has arrived
 * since the last successful parse, bounding mid-stream cost to O(N).
 *
 * Each provider tracks the last parsed length on its tool-call block, so the
 * final `toolcall_end` parse (which providers already perform unconditionally)
 * is the authoritative full parse — the throttle only delays mid-stream UI
 * updates by at most `minGrowthBytes` of accumulated partial content.
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
	if (len === 0 || (lastParsedLen > 0 && len - lastParsedLen < minGrowthBytes)) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}
