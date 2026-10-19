export const MAX_EVAL_STREAM_ARGUMENT_BYTES = 1024 * 1024;

export type EvalStreamLanguage = "js" | "py" | "rb" | "jl";

export interface EvalArgsStreamSnapshot {
	readonly revision: number;
	readonly language?: EvalStreamLanguage;
	readonly codePrefix: string;
	readonly reset?: boolean;
	readonly timeout?: number;
	readonly complete: boolean;
	/** True when this snapshot replaced, rather than appended to, the preceding provider buffer. */
	readonly restart: boolean;
}

export type EvalArgsStreamResult =
	| { kind: "snapshot"; snapshot: EvalArgsStreamSnapshot }
	| { kind: "disabled"; reason: string; restart: boolean };

type StringScan =
	| { kind: "partial"; value: string; resume: number }
	| { kind: "complete"; value: string; end: number }
	| { kind: "invalid"; reason: string };

/** Successful scan of the `code` value, reusable while later buffers extend the one it came from. */
interface CodeScan {
	readonly valueStart: number;
	readonly scan: Exclude<StringScan, { kind: "invalid" }>;
}

/** In/out cursor letting `parseSnapshot` resume the `code` string where the previous buffer stopped. */
interface CodeScanCursor {
	/** Scan of the previous buffer; only valid when the current buffer extends it. */
	readonly previous?: CodeScan;
	/** Scan produced for the current buffer. */
	next?: CodeScan;
	/** True when `next` continued `previous`, so its value extends `previous.scan.value`. */
	resumed: boolean;
}

type ValueScan = { kind: "partial" } | { kind: "complete"; end: number } | { kind: "invalid"; reason: string };

function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function skipWhitespace(raw: string, offset: number): number {
	while (offset < raw.length && isWhitespace(raw[offset] as string)) offset++;
	return offset;
}

function hexValue(char: string): number {
	const code = char.charCodeAt(0);
	if (code >= 48 && code <= 57) return code - 48;
	if (code >= 65 && code <= 70) return code - 55;
	if (code >= 97 && code <= 102) return code - 87;
	return -1;
}

function scanHexCodeUnit(raw: string, offset: number): number | undefined | null {
	if (raw.length - offset < 4) return undefined;
	let value = 0;
	for (let index = offset; index < offset + 4; index++) {
		const digit = hexValue(raw[index] as string);
		if (digit < 0) return null;
		value = value * 16 + digit;
	}
	return value;
}

/** Decodes only string bytes whose JSON meaning is already unambiguous. */
function scanJsonString(raw: string, offset: number): StringScan {
	if (raw[offset] !== '"') return { kind: "invalid", reason: "expected JSON string" };
	return scanJsonStringBody(raw, offset + 1, "");
}

/**
 * Continues decoding string contents at `index` with `value` already decoded.
 * Unescaped runs are copied with one slice; partial results report the first
 * unconsumed index so a longer buffer can resume there.
 */
function scanJsonStringBody(raw: string, index: number, value: string): StringScan {
	const length = raw.length;
	let runStart = index;
	while (index < length) {
		const code = raw.charCodeAt(index);
		if (code >= 0x20 && code !== 0x22 && code !== 0x5c && (code < 0xd800 || code > 0xdfff)) {
			index++;
			continue;
		}
		if (code === 0x22) {
			if (index > runStart) value += raw.slice(runStart, index);
			return { kind: "complete", value, end: index + 1 };
		}
		if (code === 0x5c) {
			if (index > runStart) value += raw.slice(runStart, index);
			if (index + 1 >= length) return { kind: "partial", value, resume: index };
			const escapeCode = raw[index + 1] as string;
			const escaped = escapeCode === '"' ? '"' : escapeCode === "\\" ? "\\" : escapeCode === "/" ? "/" : undefined;
			if (escaped !== undefined) {
				value += escaped;
				index += 2;
				runStart = index;
				continue;
			}
			const control =
				escapeCode === "b"
					? "\b"
					: escapeCode === "f"
						? "\f"
						: escapeCode === "n"
							? "\n"
							: escapeCode === "r"
								? "\r"
								: escapeCode === "t"
									? "\t"
									: undefined;
			if (control !== undefined) {
				value += control;
				index += 2;
				runStart = index;
				continue;
			}
			if (escapeCode !== "u") return { kind: "invalid", reason: "invalid JSON string escape" };
			const first = scanHexCodeUnit(raw, index + 2);
			if (first === undefined) return { kind: "partial", value, resume: index };
			if (first === null) return { kind: "invalid", reason: "invalid Unicode escape" };
			if (first >= 0xd800 && first <= 0xdbff) {
				const secondEscape = index + 6;
				if (length - secondEscape < 2) return { kind: "partial", value, resume: index };
				if (raw.slice(secondEscape, secondEscape + 2) !== "\\u") {
					return { kind: "invalid", reason: "unpaired high surrogate" };
				}
				const second = scanHexCodeUnit(raw, secondEscape + 2);
				if (second === undefined) return { kind: "partial", value, resume: index };
				if (second === null || second < 0xdc00 || second > 0xdfff) {
					return { kind: "invalid", reason: "unpaired high surrogate" };
				}
				value += String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
				index = secondEscape + 6;
				runStart = index;
				continue;
			}
			if (first >= 0xdc00 && first <= 0xdfff) return { kind: "invalid", reason: "unpaired low surrogate" };
			value += String.fromCharCode(first);
			index += 6;
			runStart = index;
			continue;
		}
		if (code < 0x20) return { kind: "invalid", reason: "unescaped JSON control character" };
		if (code <= 0xdbff) {
			if (index + 1 >= length) {
				if (index > runStart) value += raw.slice(runStart, index);
				return { kind: "partial", value, resume: index };
			}
			const low = raw.charCodeAt(index + 1);
			if (low < 0xdc00 || low > 0xdfff) return { kind: "invalid", reason: "unpaired high surrogate" };
			index += 2;
			continue;
		}
		return { kind: "invalid", reason: "unpaired low surrogate" };
	}
	if (index > runStart) value += raw.slice(runStart, index);
	return { kind: "partial", value, resume: index };
}

function scanJsonValue(raw: string, offset: number): ValueScan {
	const start = skipWhitespace(raw, offset);
	if (start >= raw.length) return { kind: "partial" };
	if (raw[start] === '"') {
		const string = scanJsonString(raw, start);
		return string.kind === "invalid"
			? string
			: string.kind === "partial"
				? { kind: "partial" }
				: { kind: "complete", end: string.end };
	}
	const first = raw[start] as string;
	if (first === "{" || first === "[") {
		const stack = [first];
		let index = start + 1;
		while (index < raw.length) {
			const char = raw[index] as string;
			if (char === '"') {
				const string = scanJsonString(raw, index);
				if (string.kind === "invalid") return string;
				if (string.kind === "partial") return { kind: "partial" };
				index = string.end;
				continue;
			}
			if (char === "{" || char === "[") stack.push(char);
			else if (char === "}" || char === "]") {
				const expected = char === "}" ? "{" : "[";
				if (stack.pop() !== expected) return { kind: "invalid", reason: "mismatched JSON delimiter" };
				if (stack.length === 0) return { kind: "complete", end: index + 1 };
			}
			index++;
		}
		return { kind: "partial" };
	}
	let end = start;
	while (end < raw.length && !isWhitespace(raw[end] as string) && raw[end] !== "," && raw[end] !== "}") end++;
	const token = raw.slice(start, end);
	if (
		token === "true" ||
		token === "false" ||
		token === "null" ||
		/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)
	) {
		return { kind: "complete", end };
	}
	if (
		["true", "false", "null"].some(value => value.startsWith(token)) ||
		/^-?(?:\d+)?(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(token)
	) {
		return { kind: "partial" };
	}
	return { kind: "invalid", reason: "invalid JSON value" };
}

function parseCompletedValue(raw: string, start: number, end: number): unknown {
	return JSON.parse(raw.slice(start, end));
}

function parseSnapshot(
	raw: string,
	cursor?: CodeScanCursor,
): Omit<EvalArgsStreamSnapshot, "revision" | "restart"> | { reason: string } {
	let offset = skipWhitespace(raw, 0);
	if (offset >= raw.length) return { codePrefix: "", complete: false };
	if (raw[offset] !== "{") return { reason: "eval arguments must be a JSON object" };
	offset++;
	let language: EvalStreamLanguage | undefined;
	let languageSeen = false;
	let codePrefix = "";
	let codeSeen = false;
	let reset: boolean | undefined;
	let resetSeen = false;
	let timeout: number | undefined;
	let timeoutSeen = false;
	while (true) {
		offset = skipWhitespace(raw, offset);
		if (offset >= raw.length) return { language, codePrefix, reset, timeout, complete: false };
		if (raw[offset] === "}") {
			if (!languageSeen) return { reason: "missing eval language" };
			offset = skipWhitespace(raw, offset + 1);
			if (offset !== raw.length) return { reason: "unexpected bytes after eval arguments" };
			return { language, codePrefix, reset, timeout, complete: true };
		}
		const key = scanJsonString(raw, offset);
		if (key.kind === "invalid") return { reason: key.reason };
		if (key.kind === "partial") return { language, codePrefix, reset, timeout, complete: false };
		offset = skipWhitespace(raw, key.end);
		if (offset >= raw.length) return { language, codePrefix, reset, timeout, complete: false };
		if (raw[offset] !== ":") return { reason: "expected colon after eval argument name" };
		offset = skipWhitespace(raw, offset + 1);
		const valueStart = offset;
		if (valueStart >= raw.length) return { language, codePrefix, reset, timeout, complete: false };
		if (key.value === "language") {
			if (languageSeen) return { reason: "duplicate eval language" };
			languageSeen = true;
		} else if (key.value === "code") {
			if (codeSeen) return { reason: "duplicate eval code" };
			codeSeen = true;
		} else if (key.value === "reset") {
			if (resetSeen) return { reason: "duplicate eval reset" };
			resetSeen = true;
		} else if (key.value === "timeout") {
			if (timeoutSeen) return { reason: "duplicate eval timeout" };
			timeoutSeen = true;
		}
		if (key.value === "code") {
			const previous = cursor?.previous;
			const resumed = previous !== undefined && previous.valueStart === valueStart;
			const code = !resumed
				? scanJsonString(raw, valueStart)
				: previous.scan.kind === "complete"
					? previous.scan
					: scanJsonStringBody(raw, previous.scan.resume, previous.scan.value);
			if (code.kind === "invalid") return { reason: code.reason };
			if (cursor) {
				cursor.next = { valueStart, scan: code };
				cursor.resumed = resumed;
			}
			codePrefix = code.value;
			if (code.kind === "partial") return { language, codePrefix, reset, timeout, complete: false };
			offset = code.end;
		} else {
			const value = scanJsonValue(raw, valueStart);
			if (value.kind === "invalid") return { reason: value.reason };
			if (value.kind === "partial") return { language, codePrefix, reset, timeout, complete: false };
			let parsed: unknown;
			try {
				parsed = parseCompletedValue(raw, valueStart, value.end);
			} catch {
				return { reason: "invalid completed eval argument" };
			}
			if (key.value === "language") {
				if (parsed !== "js" && parsed !== "py" && parsed !== "rb" && parsed !== "jl") {
					return { reason: "unsupported eval language" };
				}
				language = parsed;
			} else if (key.value === "reset") {
				if (typeof parsed !== "boolean") return { reason: "eval reset must be boolean" };
				reset = parsed;
			} else if (key.value === "title") {
				// Title carries no planning signal, but a non-string title fails
				// final dispatch (evalSchema), so planning from this buffer would
				// be phantom I/O for a call that never runs. Duplicate string
				// titles need no guard: last-wins matches JSON.parse semantics.
				if (typeof parsed !== "string") return { reason: "eval title must be a string" };
			} else if (key.value === "timeout") {
				if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
					return { reason: "eval timeout must be a non-negative finite number" };
				}
				timeout = parsed;
			}
			offset = value.end;
		}
		offset = skipWhitespace(raw, offset);
		if (offset >= raw.length) return { language, codePrefix, reset, timeout, complete: false };
		if (raw[offset] === ",") {
			offset++;
			continue;
		}
		if (raw[offset] !== "}") return { reason: "expected comma or end of eval arguments" };
	}
}

/** UTF-8 size check that skips the byte count when UTF-16 length alone decides it. */
function exceedsArgumentLimit(raw: string): boolean {
	if (raw.length * 3 <= MAX_EVAL_STREAM_ARGUMENT_BYTES) return false;
	return (
		raw.length > MAX_EVAL_STREAM_ARGUMENT_BYTES || Buffer.byteLength(raw, "utf8") > MAX_EVAL_STREAM_ARGUMENT_BYTES
	);
}

/** Stateful decoder for cumulative provider-owned eval argument buffers. */
export class EvalArgsStreamDecoder {
	#raw = "";
	#codePrefix = "";
	/** `code` scan of `#raw`, resumed while later buffers append to it. */
	#codeScan?: CodeScan;
	#revision = 0;
	#last?: Omit<EvalArgsStreamSnapshot, "revision" | "restart">;

	update(raw: string): EvalArgsStreamResult {
		const restart = this.#raw.length > 0 && !raw.startsWith(this.#raw);
		if (exceedsArgumentLimit(raw)) {
			return { kind: "disabled", reason: "eval argument stream exceeds speculation limit", restart };
		}
		const cursor: CodeScanCursor = { previous: restart ? undefined : this.#codeScan, resumed: false };
		const parsed = parseSnapshot(raw, cursor);
		if ("reason" in parsed) return { kind: "disabled", reason: parsed.reason, restart };
		// A resumed scan only appended to the previous decoded prefix.
		if (!restart && !cursor.resumed && !parsed.codePrefix.startsWith(this.#codePrefix)) {
			return { kind: "disabled", reason: "decoded eval code prefix was rewritten", restart: true };
		}
		this.#raw = raw;
		this.#codePrefix = parsed.codePrefix;
		this.#codeScan = cursor.next;
		this.#last = parsed;
		this.#revision++;
		return {
			kind: "snapshot",
			snapshot: Object.freeze({ ...parsed, revision: this.#revision, restart }),
		};
	}

	matchesFinal(args: Readonly<Record<string, unknown>>): boolean {
		const parsed = parseSnapshot(JSON.stringify(args));
		if ("reason" in parsed || !parsed.complete || !parsed.codePrefix.startsWith(this.#codePrefix)) return false;
		if (this.#last?.language !== undefined && parsed.language !== this.#last.language) return false;
		if (this.#last?.reset !== undefined && parsed.reset !== this.#last.reset) return false;
		return (
			parsed.codePrefix === args.code &&
			parsed.language === args.language &&
			parsed.reset === args.reset &&
			parsed.timeout === args.timeout
		);
	}
}
