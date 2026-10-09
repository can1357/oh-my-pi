/**
 * Credential-shaped token redaction for memory writes, shared by every backend.
 *
 * `recall` puts stored memories back into the prompt, so a stored credential reaches
 * every provider on every later turn. The `local` and `sharpshooter` backends each
 * carried a private copy of this pattern list. `mnemopi` carried none.
 */

// Fixed-prefix provider tokens. Each is anchored on a literal, so it matches in one
// pass with no backtracking.
const PATTERNS = [
	// More specific first (per Hindsight pattern ordering for no partial consume).
	/sk-ant-[A-Za-z0-9_-]{20,}/g,
	/sk-proj-[A-Za-z0-9_-]{48,}/g,
	/sk-admin-[A-Za-z0-9_-]{40,}/g,
	/gsk_[A-Za-z0-9]{20,}/g,
	/hf_[A-Za-z0-9]{30,}/g,
	/xai-[A-Za-z0-9]{40,}/g,
	/pplx-[A-Za-z0-9]{40,}/g,
	/ya29\.[0-9A-Za-z_-]{20,}/g,
	/dapi[A-Za-z0-9]{32}/g,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	// Common provider token prefixes (GitHub, npm, Slack, Google).
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{30,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
];
// Longest first, so `token_` wins over `tok` and reports the full match start.
const KEYWORDS = ["password", "secret", "token", "key", "tok", "sk", "pk", "rk"];
// A segment mixing letters and digits is credential-like at 12 characters. Letters
// alone need 16, which still catches `password-supersecretvalue` and
// `token-abcdefghijklmnop` while leaving `authentication` and `configuration` alone.
const MIN_MIXED_SEGMENT = 12;
const MIN_LETTERS_SEGMENT = 16;

// (isDelimiter inlined per ts-no-tiny-functions rule; no one-line rename wrapper)
const isTokenChar = (code: number) =>
	(code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code === 45 || code === 95);

function isCredentialSegment(length: number, letter: boolean, digit: boolean): boolean {
	if (!letter && !digit) return false;
	if (letter && digit) return length >= MIN_MIXED_SEGMENT;
	return length >= MIN_LETTERS_SEGMENT;
}


function keywordStart(input: string, delimiter: number): number {
	for (const keyword of KEYWORDS) {
		const start = delimiter - keyword.length;
		if (start >= 0 && input.startsWith(keyword, start)) return start;
	}
	return -1;
}

/**
 * Redact a keyword, a delimiter, and the credential-looking run after it, as in
 * `secret_aB3dEfGh1JkLmN`.
 *
 * A regex cannot express "some later segment of this run mixes letters and digits"
 * without a lookahead over the tail, which rescans it once per candidate. Text like
 * `token_aaaa-token_aaaa-…` is one unbroken run, so that rescan is quadratic, and
 * `retainMessages` runs this synchronously over a whole transcript. Instead each run is
 * visited once: split it into segments, mark which ones look like credentials, then
 * sweep the flags backwards so every delimiter can be judged in constant time.
 */
function redactKeywordSecrets(input: string): string {
	let out = "";
	let copied = 0;
	let index = 0;
	while (index < input.length) {
		if (!isTokenChar(input.charCodeAt(index))) {
			index++;
			continue;
		}

		const runStart = index;
		const starts: number[] = [runStart];
		const credential: boolean[] = [];
		let length = 0;
		let letter = false;
		let digit = false;
		while (index < input.length && isTokenChar(input.charCodeAt(index))) {
			const current = input.charCodeAt(index);
			if (current === 45 || current === 95) {
				credential.push(isCredentialSegment(length, letter, digit));
				starts.push(index + 1);
				length = 0;
				letter = false;
				digit = false;
			} else {
				length++;
				if (current >= 48 && current <= 57) digit = true;
				else letter = true;
			}
			index++;
		}
		credential.push(isCredentialSegment(length, letter, digit));
		const runEnd = index;

		// suffix[k] answers "does any segment from k onwards look like a credential".
		const suffix: boolean[] = Array.from({ length: credential.length + 1 }, () => false);
		for (let k = credential.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] || credential[k]!;

		for (let k = 1; k < starts.length; k++) {
			if (!suffix[k]) continue;
			const start = keywordStart(input, starts[k]! - 1);
			if (start < 0 || start < copied || start < runStart) continue;
			out += `${input.slice(copied, start)}[REDACTED]`;
			copied = runEnd;
			break;
		}
	}
	return copied === 0 ? input : out + input.slice(copied);
}

const MIN_JWT_SEGMENT = 16;

/**
 * Redact `header.payload.signature` tokens.
 *
 * The regex this replaces, `[A-Za-z0-9_-]{16,}\.` twice over, re-scanned the tail from
 * every start position when the text held long identifier runs and no dots, which is
 * what a coding transcript looks like. Dots are sparse, so anchoring on them and
 * measuring outward visits each character a constant number of times.
 */
function redactJwts(input: string): string {
	let out = "";
	let copied = 0;
	let dot = input.indexOf(".");
	while (dot > 0) {
		let start = dot;
		while (start > copied && isTokenChar(input.charCodeAt(start - 1))) start--;
		let middle = dot + 1;
		while (middle < input.length && isTokenChar(input.charCodeAt(middle))) middle++;
		let end = middle + 1;
		while (end < input.length && isTokenChar(input.charCodeAt(end))) end++;
		const looksLikeJwt =
			dot - start >= MIN_JWT_SEGMENT &&
			input.charCodeAt(middle) === 46 &&
			middle - dot - 1 >= MIN_JWT_SEGMENT &&
			end - middle - 1 >= MIN_JWT_SEGMENT;
		if (looksLikeJwt) {
			out += `${input.slice(copied, start)}[REDACTED]`;
			copied = end;
			dot = input.indexOf(".", end);
			continue;
		}
		dot = input.indexOf(".", dot + 1);
	}
	return copied === 0 ? input : out + input.slice(copied);
}

// --- PII redaction (high-precision, low FP; ported ideas+validators from Hindsight) ---
// Credential (keyword/PATTERNS/JWT) FIRST to preserve full matches and avoid partial leaks.
// Then PII for standalone with typed [REDACTED:xxx].

function redactEmails(input: string): string {
	// Linear scan (indexOf + bounds) to avoid ReDoS/quadratic on bad inputs like long @-less or . runs.
	let out = "";
	let copied = 0;
	let pos = 0;
	while ((pos = input.indexOf("@", pos)) !== -1) {
		let start = pos;
		while (start > copied && /[A-Za-z0-9._%+-]/.test(input[start - 1])) start--;
		let end = pos + 1;
		while (end < input.length && /[A-Za-z0-9.-]/.test(input[end])) end++;
		const dom = input.slice(pos + 1, end);
		if (dom.includes(".") && /[A-Za-z]{2,}$/.test(dom)) {
			out += input.slice(copied, start) + "[REDACTED:email]";
			copied = end;
			pos = end;
			continue;
		}
		pos++;
	}
	return copied === 0 ? input : out + input.slice(copied);
}

function redactPhones(input: string): string {
	// TR +90/05xx; leading token bound to avoid matching inside code tokens, ports, line nums.
	const re = /(?<![A-Za-z0-9_])(?:\+90|0)[\s-]?5[0-9]{2}[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2}(?![0-9])/g;
	return input.replace(re, "[REDACTED:phone]");
}

function isValidTckn(str: string): boolean {
	if (!/^[1-9]\d{10}$/.test(str)) return false;
	let odd = 0;
	let even = 0;
	for (let index = 0; index < 9; index++) {
		const digit = str.charCodeAt(index) - 48;
		if (index % 2 === 0) odd += digit;
		else even += digit;
	}
	const tenth = str.charCodeAt(9) - 48;
	const eleventh = str.charCodeAt(10) - 48;
	if (((7 * odd - even) % 10 + 10) % 10 !== tenth) return false;
	return (odd + even + tenth) % 10 === eleventh;
}

function redactTckn(input: string): string {
	const re = /(?<![A-Za-z0-9_])\d{11}(?![A-Za-z0-9_])/g;
	return input.replace(re, (m) => (isValidTckn(m) ? "[REDACTED:tckn]" : m));
}

// National IBAN lengths bound candidates before trailing prose.
// Format reference (including national/partial formats): https://www.iban.com/structure
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
	AD: 24,
	AE: 23,
	AL: 28,
	AO: 25,
	AT: 20,
	AZ: 28,
	BA: 20,
	BE: 16,
	BF: 28,
	BG: 22,
	BH: 22,
	BI: 27,
	BJ: 28,
	BR: 29,
	BY: 28,
	CF: 27,
	CG: 27,
	CH: 21,
	CI: 28,
	CM: 27,
	CR: 22,
	CV: 25,
	CY: 28,
	CZ: 24,
	DE: 22,
	DJ: 27,
	DK: 18,
	DO: 28,
	DZ: 24,
	EE: 20,
	EG: 29,
	ES: 24,
	FI: 18,
	FK: 18,
	FO: 18,
	FR: 27,
	GA: 27,
	GB: 22,
	GE: 22,
	GI: 23,
	GL: 18,
	GQ: 27,
	GR: 27,
	GT: 28,
	GW: 25,
	HN: 28,
	HR: 21,
	HU: 28,
	IE: 22,
	IL: 23,
	IQ: 23,
	IR: 26,
	IS: 26,
	IT: 27,
	JO: 30,
	KM: 27,
	KW: 30,
	KZ: 20,
	LB: 28,
	LC: 32,
	LI: 21,
	LT: 20,
	LU: 20,
	LV: 21,
	LY: 25,
	MA: 28,
	MC: 27,
	MD: 24,
	ME: 22,
	MG: 27,
	MK: 19,
	ML: 28,
	MN: 20,
	MR: 27,
	MT: 31,
	MU: 30,
	MZ: 25,
	NE: 28,
	NI: 28,
	NL: 18,
	NO: 15,
	OM: 23,
	PK: 24,
	PL: 28,
	PS: 29,
	PT: 25,
	QA: 29,
	RO: 24,
	RS: 22,
	RU: 33,
	SA: 24,
	SC: 31,
	SD: 18,
	SE: 24,
	SI: 19,
	SK: 24,
	SM: 27,
	SN: 28,
	SO: 23,
	ST: 25,
	SV: 28,
	TD: 27,
	TG: 28,
	TL: 23,
	TN: 24,
	TR: 26,
	UA: 29,
	VA: 22,
	VG: 24,
	XK: 20,
	YE: 30,
};

function isValidIban(ibanRaw: string): boolean {
	let iban = ibanRaw.replace(/[\s-]/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
	if (iban.length !== IBAN_LENGTHS[iban.slice(0, 2)]) return false;
	iban = iban.slice(4) + iban.slice(0, 4);
	let numStr = "";
	for (let i = 0; i < iban.length; i++) {
		const c = iban.charCodeAt(i);
		if (c >= 65 && c <= 90) numStr += (c - 55).toString();
		else numStr += iban[i];
	}
	let rem = 0;
	for (let i = 0; i < numStr.length; i++) {
		rem = (rem * 10 + parseInt(numStr[i], 10)) % 97;
	}
	return rem === 1;
}

function redactIbans(input: string): string {
	const headers = /(?<![\p{L}\p{N}_])([A-Z]{2})\d{2}/giu;
	const separator = /[\s-]/u;
	const tokenCharacter = /[\p{L}\p{N}_]/u;
	let out = "";
	let copied = 0;
	for (const match of input.matchAll(headers)) {
		if (match.index < copied) continue;
		const length = IBAN_LENGTHS[match[1].toUpperCase()];
		if (length === undefined) continue;
		let end = match.index + 4;
		let characters = 4;
		while (characters < length && end < input.length) {
			const code = input.charCodeAt(end);
			if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) characters++;
			else if (!separator.test(input[end])) break;
			end++;
		}
		if (characters !== length || tokenCharacter.test(input[end] ?? "")) continue;
		if (!isValidIban(input.slice(match.index, end))) continue;
		out += `${input.slice(copied, match.index)}[REDACTED:iban]`;
		copied = end;
	}
	return copied === 0 ? input : out + input.slice(copied);
}

function isLuhnCard(value: string): boolean {
	const digitsStr = value.replace(/[\s-]/g, "");
	if (!/^\d{13,19}$/.test(digitsStr)) return false;
	const digits = digitsStr.split("").map((n) => parseInt(n, 10));
	if (new Set(digits).size === 1) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits[i];
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}

function redactCreditCards(input: string): string {
	// 13-19 total digits, any common grouping with seps
	const re = /(?<![A-Za-z0-9_])(?<!\d)(?<!\d\.)(?:\d[ -]?){12,18}\d(?!\d)(?!\.\d)(?![A-Za-z0-9_])/g;
	return input.replace(re, (m) => (isLuhnCard(m) ? "[REDACTED:credit_card]" : m));
}

export function redactMemorySecrets(input: string): string {
	let out = redactJwts(redactKeywordSecrets(input));
	for (const pattern of PATTERNS) out = out.replace(pattern, "[REDACTED]");
	out = redactEmails(out);
	out = redactPhones(out);
	out = redactTckn(out);
	out = redactIbans(out);
	out = redactCreditCards(out);
	return out;
}

/**
 * Text-bearing fields a memory write can carry. The mnemopi facade accepts camelCase
 * and snake_case for the extraction and embedding overrides, and writes each to its own
 * column, so clearing `content` alone would leave a credential in `embed_text`.
 */
const TEXT_FIELDS = [
	"content",
	"extractText",
	"experienceText",
	"extract_text",
	"embedText",
	"embed_text",
	// `source` is persisted, returned by search, and appended to prompt context by
	// `formatRecallBlock`, and callers pass arbitrary strings for it.
	"source",
] as const;

/**
 * `metadata` is serialized whole into `working_memory.metadata_json`, and callers put
 * free text in it (`mnemopi/backend.ts` copies `MemoryBackendSaveInput.context` to
 * `metadata.context`), so its strings need the same treatment as `content`.
 */
function redactNested(value: unknown): unknown {
	if (typeof value === "string") return redactMemorySecrets(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = redactNested(item);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (!value || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	for (const [key, item] of Object.entries(source)) {
		const next = redactNested(item);
		if (next === item) continue;
		out ??= { ...source };
		out[key] = next;
	}
	return out ?? value;
}

/**
 * Copy `value` with every text-bearing field and all nested metadata strings redacted.
 * Returns `value` itself when nothing changed, so a clean write allocates nothing.
 */
export function redactMemoryTextFields<T extends object>(value: T): T {
	const source = value as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	for (const field of TEXT_FIELDS) {
		const text = source[field];
		if (typeof text !== "string") continue;
		const clean = redactMemorySecrets(text);
		if (clean === text) continue;
		out ??= { ...source };
		out[field] = clean;
	}
	if ("metadata" in source) {
		const metadata = redactNested(source.metadata);
		if (metadata !== source.metadata) {
			out ??= { ...source };
			out.metadata = metadata;
		}
	}
	return (out ?? value) as T;
}

/**
 * Scrub a `remember(memory, options)` call pair. `memory` is either the content string
 * or an input object. `options` is `undefined` when the caller takes the facade default.
 */
export function redactRememberWrite<M extends string | object, O>(memory: M, options: O): [M, O] {
	const scrubbedMemory = (
		typeof memory === "string" ? redactMemorySecrets(memory) : redactMemoryTextFields(memory)
	) as M;
	const scrubbedOptions = (
		options === undefined || options === null ? options : redactMemoryTextFields(options as object)
	) as O;
	return [scrubbedMemory, scrubbedOptions];
}
