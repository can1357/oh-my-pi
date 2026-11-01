import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIZE_HARD_CAP = 1_000_000;
export const SIZE_BASE64_CHECK = 100_000;
export const ENTROPY_THRESHOLD = 5.0;

const DATA_URI_RE =
	/^data:(?<mime>[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+)?(?<params>(?:;[A-Za-z0-9!#$%&'*+.^_`|~-]+=[^;,]*)*)(?<base64>;base64)?,(?<data>[\s\S]*)$/i;
const VALID_MIME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export interface BlobMetadata {
	blob_ref?: string;
	original_size?: number;
	mime?: string;
	extraction_reason?: "data_uri" | "size_cap" | "high_entropy";
	entropy?: number;
}

/**
 * Metadata describing transformations applied by {@link sanitizeContent},
 * including blob extraction, injected prompt/memory tag removal, and credential redaction.
 */
export interface SanitizeMetadata {
	blob_ref?: string;
	extraction_reason?: "data_uri" | "size_cap" | "high_entropy";
	original_size?: number;
	sha256?: string;
	mime?: string;
	entropy?: number;
	stripped_tags?: boolean;
	redacted_secrets?: string[];
}

export function blobRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.MNEMOPI_BLOB_DIR && env.MNEMOPI_BLOB_DIR.length > 0
		? env.MNEMOPI_BLOB_DIR
		: join(homedir(), ".hermes", "mnemopi", "blobs");
}

export function computeSha256(data: Uint8Array | string): string {
	return Bun.SHA256.hash(data, "hex");
}

export function isDataUri(content: string): boolean {
	return /^data:/i.test(content);
}

export function parseDataUri(content: string): [mimeType: string, raw: Buffer] | null {
	const match = DATA_URI_RE.exec(content);
	if (match?.groups === undefined) return null;
	if (match.groups.base64 === undefined) return null;

	const rawMime = match.groups.mime;
	if (rawMime !== undefined && !VALID_MIME_RE.test(rawMime)) return null;
	const mimeType = rawMime ?? "application/octet-stream";
	const payload = match.groups.data ?? "";
	const decoded = decodeBase64Payload(payload);
	if (decoded === null) return null;

	return [mimeType, decoded];
}

export function isValidBase64(payload: string): boolean {
	const cleaned = payload.replace(/\s+/g, "");
	if (cleaned.length < 2 || cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
		return false;
	}
	const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat(4 - (cleaned.length % 4));
	if (!BASE64_RE.test(padded)) return false;
	try {
		Buffer.from(padded, "base64");
		return true;
	} catch {
		return false;
	}
}

function decodeBase64Payload(rawPayload: string): Buffer | null {
	const candidate = rawPayload.includes("%")
		? (() => {
				try {
					return decodeURIComponent(rawPayload);
				} catch {
					return rawPayload;
				}
			})()
		: rawPayload;
	const cleaned = candidate.replace(/\s+/g, "");
	if (cleaned.length >= 2 && cleaned.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
		const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat(4 - (cleaned.length % 4));
		if (BASE64_RE.test(padded)) {
			try {
				return Buffer.from(padded, "base64");
			} catch {
				return null;
			}
		}
	}
	return null;
}
function decodePercentEncoded(raw: string): Buffer {
	try {
		return Buffer.from(decodeURIComponent(raw), "utf-8");
	} catch {
		const binary = raw.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
		return Buffer.from(binary, "latin1");
	}
}

function extractCharset(params: string | undefined): string | null {
	if (!params) return null;
	const match = /(?:^|;)\s*charset=([^;,]+)/i.exec(params);
	return match?.[1]?.trim().toLowerCase() ?? null;
}

const SUPPORTED_SYMMETRIC_CHARSETS = new Set([
	"utf-8",
	"utf8",
	"iso-8859-1",
	"latin1",
	"windows-1252",
	"cp1252",
	"us-ascii",
	"ascii",
	"utf-16",
	"utf16",
	"utf-16le",
	"utf16le",
	"utf-16be",
	"utf16be",
]);

function isSupportedSymmetricCharset(charset: string | null): boolean {
	if (!charset) return true;
	return SUPPORTED_SYMMETRIC_CHARSETS.has(charset.toLowerCase());
}

function hasUtf16BeBom(rawBytes: Uint8Array | Buffer): boolean {
	return rawBytes.length >= 2 && rawBytes[0] === 0xfe && rawBytes[1] === 0xff;
}

function swapUtf16Bytes(buf: Buffer): Buffer {
	const swapped = Buffer.alloc(buf.length);
	for (let i = 0; i < buf.length - 1; i += 2) {
		swapped[i] = buf[i + 1]!;
		swapped[i + 1] = buf[i]!;
	}
	if (buf.length % 2 !== 0) {
		swapped[buf.length - 1] = buf[buf.length - 1]!;
	}
	return swapped;
}

function decodeWithCharset(rawBytes: Uint8Array | Buffer, charset: string | null): string {
	const lower = charset ? charset.toLowerCase() : null;
	if (!lower || lower === "utf-8" || lower === "utf8") {
		return new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
	}
	if (lower === "windows-1252" || lower === "cp1252") {
		return new TextDecoder("windows-1252").decode(rawBytes);
	}
	if (lower === "iso-8859-1" || lower === "latin1") {
		return Buffer.isBuffer(rawBytes) ? rawBytes.toString("latin1") : Buffer.from(rawBytes).toString("latin1");
	}
	if (lower === "us-ascii" || lower === "ascii") {
		return Buffer.isBuffer(rawBytes) ? rawBytes.toString("ascii") : Buffer.from(rawBytes).toString("ascii");
	}
	if (lower === "utf-16le" || lower === "utf16le") {
		return Buffer.isBuffer(rawBytes) ? rawBytes.toString("utf16le") : Buffer.from(rawBytes).toString("utf16le");
	}
	if (lower === "utf-16be" || lower === "utf16be") {
		const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
		return swapUtf16Bytes(buf).toString("utf16le");
	}
	if (lower === "utf-16" || lower === "utf16") {
		const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
		if (hasUtf16BeBom(buf)) {
			return swapUtf16Bytes(buf).toString("utf16le");
		}
		return buf.toString("utf16le");
	}
	const fallbackText = Buffer.from(rawBytes).toString("utf8");
	const tagRes = stripInjectedMemoryTags(fallbackText);
	const credRes = scrubLiveCredentials(tagRes.content);
	if (tagRes.stripped || credRes.matchedTypes.length > 0) {
		return credRes.content;
	}
	return "[REDACTED_UNSUPPORTED_CHARSET]";
}

function encodeWithCharset(text: string, charset: string | null, rawBytes?: Uint8Array | Buffer): Buffer {
	const lower = charset ? charset.toLowerCase() : null;
	if (lower === "windows-1252" || lower === "cp1252") {
		return encodeWindows1252(text);
	}
	if (lower === "iso-8859-1" || lower === "latin1") {
		return Buffer.from(text, "latin1");
	}
	if (lower === "us-ascii" || lower === "ascii") {
		return Buffer.from(text, "ascii");
	}
	if (lower === "utf-16le" || lower === "utf16le") {
		return Buffer.from(text, "utf16le");
	}
	if (lower === "utf-16be" || lower === "utf16be") {
		return swapUtf16Bytes(Buffer.from(text, "utf16le"));
	}
	if (lower === "utf-16" || lower === "utf16") {
		const leBuf = Buffer.from(text, "utf16le");
		if (rawBytes && hasUtf16BeBom(rawBytes)) {
			return swapUtf16Bytes(leBuf);
		}
		return leBuf;
	}
	return Buffer.from(text, "utf-8");
}

export function shannonEntropy(text: string): number {
	if (text.length === 0) return 0.0;

	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);

	let entropy = 0.0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

export function looksLikeBase64Blob(content: string): boolean {
	if (content.length < SIZE_BASE64_CHECK) return false;
	return shannonEntropy(content) > ENTROPY_THRESHOLD;
}

export function storeBlob(rawBytes: Uint8Array): string {
	const sha256 = computeSha256(rawBytes);
	const blobDir = join(blobRoot(), sha256.slice(0, 2), sha256.slice(0, 4));
	mkdirSync(blobDir, { recursive: true });
	const blobPath = join(blobDir, sha256);
	if (!existsSync(blobPath)) writeFileSync(blobPath, rawBytes);
	return sha256;
}
const HARNESS_TAG_START_RE = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;
const HARNESS_SYSTEM_TAG_NAME_RE = /^system-[a-z][a-z-]*$/;

const INJECTED_MEMORY_TAG_SET: ReadonlySet<string> = new Set([
	"memories",
	"mental_models",
	"hindsight_memories",
	"relevant_memories",
	"private",
]);

/**
 * Return `true` when `tagName` is a canonical harness-authored XML tag (`irc` or `system-*`
 * such as `system-reminder`, `system-notice`, `system-injection`, `system-interrupt`).
 */
export function isHarnessTagName(tagName: string): boolean {
	const lower = tagName.toLowerCase();
	return lower === "irc" || HARNESS_SYSTEM_TAG_NAME_RE.test(lower);
}

/**
 * Escape `<` on harness-authored tags (`<irc>`, `<system-*>`, and their closing forms)
 * so untrusted text cannot close an enclosing harness block or forge a new one.
 */
export function escapeHarnessTags(text: string): string {
	return text.replace(HARNESS_TAG_START_RE, "&lt;");
}

/**
 * Return `true` when `tagName` is an injected memory or harness wrapper tag that must
 * never be persisted into long-term memory.
 */
export function isInjectedMemoryTagName(tagName: string): boolean {
	const lower = tagName.toLowerCase();
	return isHarnessTagName(lower) || INJECTED_MEMORY_TAG_SET.has(lower);
}

/**
 * Strip injected prompt/harness/memory wrapper blocks (`<system-*>`, `<irc>`, `<memories>`,
 * `<mental_models>`, `<hindsight_memories>`, `<relevant_memories>`, `<private>`) in a single
 * linear $O(n)$ non-backtracking character scan without regex suffix rescanning.
 *
 * Semantics:
 * - Matched opening and closing tag pairs (including arbitrarily deep same-name or cross-tag
 *   nesting) remove the entire enclosed block.
 * - An unclosed opening injected tag truncates the remainder of `content` from that tag onward.
 * - An orphan closing injected tag is removed in place.
 */
function isTagWhitespaceCode(code: number): boolean {
	return (
		code === 32 ||
		(code >= 9 && code <= 13) ||
		code === 0x00a0 ||
		(code > 127 && /\s/.test(String.fromCharCode(code)))
	);
}

export function stripInjectedMemoryTags(content: string): { content: string; stripped: boolean } {
	let ltIdx = content.indexOf("<");
	if (ltIdx === -1) {
		return { content, stripped: false };
	}

	const stack: string[] = [];
	const openCounts = new Map<string, number>();
	const chunks: string[] = [];
	let lastIndex = 0;
	let stripped = false;
	let cachedGtIdx = -1;

	while (ltIdx !== -1) {
		let ptr = ltIdx + 1;
		while (ptr < content.length && isTagWhitespaceCode(content.charCodeAt(ptr))) {
			ptr++;
		}

		let isClosing = false;
		if (ptr < content.length && content.charCodeAt(ptr) === 47 /* '/' */) {
			isClosing = true;
			ptr++;
			while (ptr < content.length && isTagWhitespaceCode(content.charCodeAt(ptr))) {
				ptr++;
			}
		}

		const nameStart = ptr;
		while (ptr < content.length) {
			const code = content.charCodeAt(ptr);
			const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
			const isDigit = code >= 48 && code <= 57;
			const isExtra = code === 45 /* '-' */ || code === 95; /* '_' */
			if (ptr === nameStart) {
				if (!isAlpha) break;
			} else if (!isAlpha && !isDigit && !isExtra) {
				break;
			}
			ptr++;
		}
		const nameEnd = ptr;

		if (nameEnd === nameStart) {
			ltIdx = content.indexOf("<", ltIdx + 1);
			continue;
		}

		const tagName = content.slice(nameStart, nameEnd);
		if (!isInjectedMemoryTagName(tagName)) {
			ltIdx = content.indexOf("<", ltIdx + 1);
			continue;
		}

		// Next char after tagName must be EOF, '>', '/', or ASCII whitespace
		if (nameEnd < content.length) {
			const afterCode = content.charCodeAt(nameEnd);
			if (afterCode !== 62 /* '>' */ && afterCode !== 47 /* '/' */ && !isTagWhitespaceCode(afterCode)) {
				ltIdx = content.indexOf("<", ltIdx + 1);
				continue;
			}
		}

		// Look for closing '>' monotonically: cachedGtIdx is only searched forward
		if (cachedGtIdx < nameEnd) {
			cachedGtIdx = content.indexOf(">", nameEnd);
		}
		const gtIdx = cachedGtIdx;

		if (gtIdx === -1) {
			// No '>' in remainder of content: tag is unclosed/truncated to EOF.
			stripped = true;
			if (stack.length === 0) {
				chunks.push(content.slice(lastIndex, ltIdx));
			}
			lastIndex = content.length;
			break;
		}

		stripped = true;
		const lowerName = tagName.toLowerCase();
		if (!isClosing) {
			if (stack.length === 0) {
				chunks.push(content.slice(lastIndex, ltIdx));
			}
			let slashScan = gtIdx - 1;
			while (slashScan > nameEnd && isTagWhitespaceCode(content.charCodeAt(slashScan))) {
				slashScan--;
			}
			const isSelfClosing = slashScan >= nameEnd && content.charCodeAt(slashScan) === 47; /* '/' */
			if (!isSelfClosing) {
				stack.push(lowerName);
				openCounts.set(lowerName, (openCounts.get(lowerName) ?? 0) + 1);
			}
			lastIndex = gtIdx + 1;
		} else if (stack.length === 0) {
			chunks.push(content.slice(lastIndex, ltIdx));
			lastIndex = gtIdx + 1;
		} else if ((openCounts.get(lowerName) ?? 0) > 0) {
			while (stack.length > 0) {
				const popped = stack.pop()!;
				const count = (openCounts.get(popped) ?? 1) - 1;
				if (count > 0) {
					openCounts.set(popped, count);
				} else {
					openCounts.delete(popped);
				}
				if (popped === lowerName) {
					break;
				}
			}
			if (stack.length === 0) {
				lastIndex = gtIdx + 1;
			}
		}
		ltIdx = content.indexOf("<", gtIdx + 1);
	}

	if (!stripped) {
		return { content, stripped: false };
	}

	if (stack.length === 0 && lastIndex < content.length) {
		chunks.push(content.slice(lastIndex));
	}

	const cleaned = chunks
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { content: cleaned, stripped: true };
}

// Longest first, so `token_` wins over `tok` and reports the full match start.
const KEYWORDS = ["password", "secret", "token", "key", "tok", "sk", "pk", "rk"];
const MIN_MIXED_SEGMENT = 12;
const MIN_LETTERS_SEGMENT = 16;
const MIN_JWT_SEGMENT = 16;

const isDelimiter = (code: number) => code === 45 || code === 95;

function isCredentialSegment(length: number, letter: boolean, digit: boolean): boolean {
	if (!letter && !digit) return false;
	if (letter && digit) return length >= MIN_MIXED_SEGMENT;
	return length >= MIN_LETTERS_SEGMENT;
}

const isTokenChar = (code: number) =>
	(code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || isDelimiter(code);

function keywordStart(input: string, delimiter: number): number {
	for (const keyword of KEYWORDS) {
		const start = delimiter - keyword.length;
		if (start < 0 || !input.startsWith(keyword, start)) continue;
		if (start > 0 && isTokenChar(input.charCodeAt(start - 1)) && !isDelimiter(input.charCodeAt(start - 1))) {
			continue;
		}
		return start;
	}
	return -1;
}

function redactKeywordSecretsWithFlag(input: string): { content: string; matched: boolean } {
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
			if (isDelimiter(current)) {
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
	return copied === 0 ? { content: input, matched: false } : { content: out + input.slice(copied), matched: true };
}

function redactJwtsWithFlag(input: string): { content: string; matched: boolean } {
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
	return copied === 0 ? { content: input, matched: false } : { content: out + input.slice(copied), matched: true };
}
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const PEM_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const PEM_LEGACY_HEADERS_RE = /^(?:[ \t]*\r?\n[A-Za-z0-9-]+:[ \t]*[^\r\n]+)*/;

const WIN1252_SPECIAL_CHARS: Readonly<Record<number, number>> = {
	0x20ac: 0x80,
	0x201a: 0x82,
	0x0192: 0x83,
	0x201e: 0x84,
	0x2026: 0x85,
	0x2020: 0x86,
	0x2021: 0x87,
	0x02c6: 0x88,
	0x2030: 0x89,
	0x0160: 0x8a,
	0x2039: 0x8b,
	0x0152: 0x8c,
	0x017d: 0x8e,
	0x2018: 0x91,
	0x2019: 0x92,
	0x201c: 0x93,
	0x201d: 0x94,
	0x2022: 0x95,
	0x2013: 0x96,
	0x2014: 0x97,
	0x02dc: 0x98,
	0x2122: 0x99,
	0x0161: 0x9a,
	0x203a: 0x9b,
	0x0153: 0x9c,
	0x017e: 0x9e,
	0x0178: 0x9f,
};

function encodeWindows1252(text: string): Buffer {
	const buf = Buffer.alloc(text.length);
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const mapped = WIN1252_SPECIAL_CHARS[code];
		if (mapped !== undefined) {
			buf[i] = mapped;
		} else if (code <= 0xff) {
			buf[i] = code;
		} else {
			buf[i] = 0x3f; // '?'
		}
	}
	return buf;
}
/**
 * Redact PEM private key blocks in strictly linear time.
 * If no matching END marker remains in the suffix, subsequent unclosed BEGIN markers
 * redact only to the end of their current line without rescanning to EOF.
 */
export function redactPemPrivateKeys(text: string): { content: string; matched: boolean } {
	PEM_BEGIN_RE.lastIndex = 0;
	let match = PEM_BEGIN_RE.exec(text);
	if (match === null) {
		return { content: text, matched: false };
	}

	PEM_END_RE.lastIndex = 0;
	let noMoreEndMarkers = false;
	const chunks: string[] = [];
	let lastIndex = 0;

	while (match !== null) {
		const beginStart = match.index;
		const beginEnd = beginStart + match[0].length;
		chunks.push(text.slice(lastIndex, beginStart));

		if (!noMoreEndMarkers) {
			if (PEM_END_RE.lastIndex < beginEnd) {
				PEM_END_RE.lastIndex = beginEnd;
			}
			const endMatch = PEM_END_RE.exec(text);
			if (endMatch !== null) {
				chunks.push("[REDACTED]");
				lastIndex = endMatch.index + endMatch[0].length;
				PEM_BEGIN_RE.lastIndex = lastIndex;
				match = PEM_BEGIN_RE.exec(text);
				continue;
			}
			noMoreEndMarkers = true;
		}

		// No more END markers anywhere in the remaining text.
		// Consume the BEGIN header and any trailing PEM base64/whitespace characters, matching
		// the original pattern: -----BEGIN ... PRIVATE KEY-----[A-Za-z0-9+/=\r\n\t -]*
		let payloadEnd = beginEnd;
		const headerMatch = PEM_LEGACY_HEADERS_RE.exec(text.slice(payloadEnd));
		if (headerMatch && headerMatch[0].length > 0) {
			payloadEnd += headerMatch[0].length;
		}
		while (payloadEnd < text.length) {
			const code = text.charCodeAt(payloadEnd);
			if (
				(code >= 65 && code <= 90) ||
				(code >= 97 && code <= 122) ||
				(code >= 48 && code <= 57) ||
				code === 43 /* '+' */ ||
				code === 47 /* '/' */ ||
				code === 61 /* '=' */ ||
				code === 32 /* ' ' */ ||
				code === 9 /* '\t' */ ||
				code === 13 /* '\r' */ ||
				code === 10 /* '\n' */ ||
				code === 45 /* '-' */
			) {
				payloadEnd++;
			} else {
				break;
			}
		}
		chunks.push("[REDACTED]");
		lastIndex = payloadEnd;
		PEM_BEGIN_RE.lastIndex = lastIndex;
		match = PEM_BEGIN_RE.exec(text);
	}

	if (lastIndex < text.length) {
		chunks.push(text.slice(lastIndex));
	}

	return { content: chunks.join(""), matched: true };
}

const CREDENTIAL_RULES: ReadonlyArray<{
	type: string;
	pattern?: RegExp;
	custom?: (input: string) => { content: string; matched: boolean };
	replacement?: string;
}> = [
	{
		type: "pem_private_key",
		custom: redactPemPrivateKeys,
	},
	{
		type: "openai_anthropic_key",
		pattern: /\bsk-(?:proj|ant-api\d*|live)-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{36,}\b/g,
		replacement: "[REDACTED]",
	},
	{
		type: "github_pat",
		pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
		replacement: "[REDACTED]",
	},
	{
		type: "npm_token",
		pattern: /npm_[A-Za-z0-9]{30,}/g,
		replacement: "[REDACTED]",
	},
	{
		type: "google_api_key",
		pattern: /AIza[A-Za-z0-9_-]{30,}/g,
		replacement: "[REDACTED]",
	},
	{
		type: "aws_access_key",
		pattern: /(?!(?:AKIA|ASIA)IOSFODNN7EXAMPLE(?![A-Z0-9]))(?:AKIA|ASIA)[A-Z0-9]{16}/g,
		replacement: "[REDACTED]",
	},
	{
		type: "slack_or_gitlab_token",
		pattern: /xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}/g,
		replacement: "[REDACTED]",
	},
	{
		type: "auth_bearer_basic",
		pattern:
			/((?:\\?["'])?\b(?:Proxy-)?Authorization(?:\\?["'])?\s*:\s*(?:\\?["'])?(?:Bearer|Basic)\s+)(?!\[REDACTED\])(?:(?!\\["'])[^\s"',;}{[\]])+/gi,
		replacement: "$1[REDACTED]",
	},
	{
		type: "basic_auth_url",
		pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)(?!\[REDACTED\]@)[^\s/@]+(@)/gi,
		replacement: "$1[REDACTED]$2",
	},
	{
		type: "jwt",
		custom: redactJwtsWithFlag,
	},
	{
		type: "keyword_secret",
		custom: redactKeywordSecretsWithFlag,
	},
];

/**
 * Scrub live credentials (PEM private keys, API keys, provider tokens, Authorization headers,
 * basic-auth URLs, JWTs, and keyword-prefixed secrets) from `content` in linear time and
 * return both the redacted text and the list of matched credential rule identifiers.
 */
export function scrubLiveCredentials(content: string): { content: string; matchedTypes: string[] } {
	let current = content;
	const matchedTypes: string[] = [];

	for (const rule of CREDENTIAL_RULES) {
		if (rule.custom !== undefined) {
			const res = rule.custom(current);
			if (res.matched) {
				current = res.content;
				matchedTypes.push(rule.type);
			}
			continue;
		}
		if (rule.pattern === undefined) continue;
		rule.pattern.lastIndex = 0;
		let matched = false;
		current = current.replace(rule.pattern, (...args) => {
			matched = true;
			if (rule.replacement === "$1[REDACTED]") {
				return `${args[1] as string}[REDACTED]`;
			}
			if (rule.replacement === "$1[REDACTED]$2") {
				return `${args[1] as string}[REDACTED]${args[2] as string}`;
			}
			if (rule.replacement === "$1[REDACTED]$3") {
				return `${args[1] as string}[REDACTED]${args[3] as string}`;
			}
			if (rule.replacement === "$1[REDACTED]$4") {
				return `${args[1] as string}[REDACTED]${args[4] as string}`;
			}
			return rule.replacement ?? "[REDACTED]";
		});
		if (matched) matchedTypes.push(rule.type);
	}

	return { content: current, matchedTypes };
}

/**
 * Redact credential-shaped tokens from a memory string using the canonical rule set shared
 * across Mnemopi and coding-agent memory backends.
 */
export function redactMemorySecrets(input: string): string {
	return scrubLiveCredentials(input).content;
}

const TEXT_FIELDS = ["content", "extractText", "extract_text", "embedText", "embed_text", "source"] as const;
const MAX_NESTED_DATA_URI_PASSES = 3;
const EMBEDDED_DATA_URI_RE = /\bdata:[^\s"'<>]+/gi;

function trimTrailingDelimitersFromDataUri(candidate: string): [cleanUri: string, trailing: string] {
	const match = /^(data:[^,]*;base64,)([A-Za-z0-9+/=%_-]*)([\s\S]*)$/i.exec(candidate);
	if (match) {
		return [match[1] + match[2], match[3]];
	}
	let end = candidate.length;
	while (end > 5) {
		const ch = candidate[end - 1];
		if (
			ch === ")" ||
			ch === "]" ||
			ch === "}" ||
			ch === "." ||
			ch === ";" ||
			ch === ":" ||
			ch === "'" ||
			ch === '"'
		) {
			end--;
		} else {
			break;
		}
	}
	return [candidate.slice(0, end), candidate.slice(end)];
}

function resanitizeTextualDataUrl(
	uri: string,
	onStripped?: () => void,
	onRedacted?: (types: string[]) => void,
	depth = 0,
	isWholeField = false,
): string {
	const [cleanUri, trailing] = isWholeField ? [uri, ""] : trimTrailingDelimitersFromDataUri(uri);
	const uriMatch = DATA_URI_RE.exec(cleanUri);
	let rawMime = uriMatch?.groups?.mime;
	let isBase64 = uriMatch?.groups?.base64 !== undefined;
	let rawPayload = uriMatch?.groups?.data;
	const charset = extractCharset(uriMatch?.groups?.params);
	if (!uriMatch?.groups) {
		const b64 = /^data:[^,]*;base64,(?<data>[\s\S]*)$/i.exec(cleanUri);
		if (b64?.groups?.data !== undefined) {
			rawMime = undefined;
			isBase64 = true;
			rawPayload = b64.groups.data;
		} else {
			const commaIdx = cleanUri.indexOf(",");
			if (commaIdx !== -1) {
				rawMime = undefined;
				isBase64 = false;
				rawPayload = cleanUri.slice(commaIdx + 1);
			}
		}
	}
	if (rawPayload !== undefined) {
		const mimeType = rawMime ?? "text/plain";
		const payloadBytes = isBase64 ? decodeBase64Payload(rawPayload) : decodePercentEncoded(rawPayload);
		if (payloadBytes !== null && (rawMime === undefined || isTextualMime(mimeType, payloadBytes, charset))) {
			if (depth >= MAX_NESTED_DATA_URI_PASSES) {
				onRedacted?.(["nested_data_uri"]);
				return `[REDACTED_NESTED_DATA_URI]${trailing}`;
			}
			const unsupportedCharset = !isSupportedSymmetricCharset(charset);
			const innerDecoded = decodeWithCharset(payloadBytes, charset);
			let innerStripped = false;
			let innerRedacted = false;
			const sanitizedInner = resanitizeDecodedText(
				innerDecoded,
				() => {
					innerStripped = true;
					onStripped?.();
				},
				types => {
					innerRedacted = true;
					onRedacted?.(types);
				},
				depth + 1,
			);
			if (innerStripped || innerRedacted || unsupportedCharset) {
				return sanitizedInner + trailing;
			}
		}
	}
	return uri;
}

function resanitizeDecodedText(
	initialText: string,
	onStripped?: () => void,
	onRedacted?: (types: string[]) => void,
	depth = 0,
): string {
	let current = initialText;
	const tagRes = stripInjectedMemoryTags(current);
	if (tagRes.stripped) {
		current = tagRes.content;
		onStripped?.();
	}
	const credRes = scrubLiveCredentials(current);
	if (credRes.matchedTypes.length > 0) {
		current = credRes.content;
		onRedacted?.(credRes.matchedTypes);
	}
	if (isDataUri(current)) {
		const trimmed = current.trim();
		const whole = resanitizeTextualDataUrl(trimmed, onStripped, onRedacted, depth, true);
		current =
			whole !== trimmed
				? whole
				: current.replace(EMBEDDED_DATA_URI_RE, matchedUri =>
						resanitizeTextualDataUrl(matchedUri, onStripped, onRedacted, depth, false),
					);
	} else if (/data:/i.test(current)) {
		current = current.replace(EMBEDDED_DATA_URI_RE, matchedUri =>
			resanitizeTextualDataUrl(matchedUri, onStripped, onRedacted, depth, false),
		);
	}
	const postTagRes = stripInjectedMemoryTags(current);
	if (postTagRes.stripped) {
		current = postTagRes.content;
		onStripped?.();
	}
	const postCredRes = scrubLiveCredentials(current);
	if (postCredRes.matchedTypes.length > 0) {
		current = postCredRes.content;
		onRedacted?.(postCredRes.matchedTypes);
	}
	return current;
}

export function sanitizeTextField(input: string): string {
	return redactMemorySecrets(resanitizeDecodedText(input));
}

function resolveTrustedFallbackTimestamp(fallback?: string): string {
	if (fallback === undefined) {
		return new Date().toISOString();
	}
	if (fallback === "") {
		return "";
	}
	if (!fallback.includes("<") && !fallback.includes(">")) {
		const parsed = Date.parse(fallback);
		if (!Number.isNaN(parsed)) {
			return new Date(parsed).toISOString();
		}
	}
	return new Date().toISOString();
}

export function sanitizeTimestamp(ts: string | null | undefined, fallback?: string): string {
	if (ts === undefined || ts === null) {
		return resolveTrustedFallbackTimestamp(fallback);
	}
	const asStr = String(ts);
	let cleaned = asStr.includes("<") ? asStr.replace(/<[^>]*>/g, "") : asStr;
	cleaned = stripInjectedMemoryTags(cleaned).content;
	cleaned = redactMemorySecrets(cleaned).trim();
	if (cleaned.includes("<") || cleaned.includes(">")) {
		return resolveTrustedFallbackTimestamp(fallback);
	}
	const parsed = Date.parse(cleaned);
	if (Number.isNaN(parsed)) {
		return resolveTrustedFallbackTimestamp(fallback);
	}
	return new Date(parsed).toISOString();
}
const ROW_UNSANITIZED_STRING_KEYS: ReadonlySet<string> = new Set([
	"id",
	"memory_id",
	"session_id",
	"source_memory_id",
	"embedding_json",
	"blob_ref",
	"timestamp",
	"created_at",
	"updated_at",
	"first_seen",
	"last_seen",
]);

const ROW_JSON_ARRAY_KEYS: ReadonlySet<string> = new Set([
	"temporal_tags",
	"entities",
	"tags",
	"sources_json",
	"metadata_json",
	"metadata",
]);

function sanitizeJsonStringField(val: string, fallbackEmptyObject = false): string {
	try {
		const parsed = JSON.parse(val) as unknown;
		return JSON.stringify(sanitizeMetadataRecord(parsed, true));
	} catch {
		return fallbackEmptyObject ? "{}" : sanitizeTextField(val);
	}
}

export function sanitizeMemoryRow<T extends object>(row: T): T {
	const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
	if (typeof out.timestamp === "string") {
		out.timestamp = sanitizeTimestamp(out.timestamp, "");
	}
	if (typeof out.created_at === "string") {
		out.created_at = sanitizeTimestamp(out.created_at, "");
	}
	if (typeof out.updated_at === "string") {
		out.updated_at = sanitizeTimestamp(out.updated_at, "");
	}
	for (const key of ROW_JSON_ARRAY_KEYS) {
		if (key in out) {
			const val = out[key];
			if (typeof val === "string") {
				out[key] = sanitizeJsonStringField(val, key === "metadata_json" || key === "metadata");
			} else if (Array.isArray(val)) {
				out[key] = sanitizeMetadataRecord(val, true);
			} else if (val !== null && typeof val === "object") {
				out[key] = sanitizeMetadataRecord(val, true);
			}
		}
	}
	for (const [key, val] of Object.entries(out)) {
		if (typeof val === "string" && !ROW_UNSANITIZED_STRING_KEYS.has(key) && !ROW_JSON_ARRAY_KEYS.has(key)) {
			out[key] = sanitizeTextField(val);
		}
	}
	return out as T;
}

function sanitizeAuxiliaryString(input: string): string {
	return sanitizeTextField(input);
}

function redactNested(value: unknown, stripTags = false): unknown {
	if (typeof value === "string") return stripTags ? sanitizeAuxiliaryString(value) : redactMemorySecrets(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = redactNested(item, stripTags);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (!value || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) {
		const nextKeyRaw = stripTags ? sanitizeAuxiliaryString(key) : redactMemorySecrets(key);
		const baseKey = nextKeyRaw.trim().length > 0 ? nextKeyRaw : "[REDACTED]";
		let safeKey = baseKey;
		let suffix = 2;
		while (Object.hasOwn(out, safeKey)) {
			safeKey = `${baseKey}_${suffix++}`;
		}
		const nextItem = redactNested(item, stripTags);
		if (safeKey !== key || nextItem !== item) changed = true;
		Object.defineProperty(out, safeKey, {
			value: nextItem,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return changed ? out : value;
}

/**
 * Recursively sanitize all string values in a standalone metadata dictionary or nested object,
 * stripping injected prompt tags and redacting credential secrets.
 */
export function sanitizeMetadataRecord<T>(metadata: T, stripTags = true): T {
	return redactNested(metadata, stripTags) as T;
}
/**
 * Copy `value` with every text-bearing field and all nested metadata strings redacted.
 * Returns `value` itself when nothing changed, so a clean write allocates nothing.
 */
export function redactMemoryTextFields<T extends object>(value: T, stripTags = false): T {
	const source = value as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	for (const field of TEXT_FIELDS) {
		const text = source[field];
		if (typeof text !== "string") continue;
		const clean = stripTags ? sanitizeAuxiliaryString(text) : redactMemorySecrets(text);
		if (clean === text) continue;
		out ??= { ...source };
		out[field] = clean;
	}
	if ("metadata" in source) {
		const metadata = redactNested(source.metadata, stripTags);
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

const EXPLICIT_TEXTUAL_APPLICATION_MIMES: ReadonlySet<string> = new Set([
	"application/json",
	"application/ld+json",
	"application/ndjson",
	"application/x-ndjson",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"application/x-www-form-urlencoded",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/x-toml",
	"application/sql",
	"application/graphql",
	"application/csv",
	"application/rtf",
	"application/x-sh",
	"application/x-csh",
	"application/x-httpd-php",
]);

const KNOWN_BINARY_APPLICATION_MIMES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-gzip",
	"application/x-tar",
	"application/x-bzip2",
	"application/x-xz",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"application/zstd",
	"application/wasm",
	"application/protobuf",
	"application/x-protobuf",
	"application/java-archive",
	"application/epub+zip",
	"application/ogg",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/x-sqlite3",
	"application/vnd.sqlite3",
]);

function isKnownBinaryMime(lower: string): boolean {
	if (lower === "image/svg+xml") return false;
	if (
		lower.startsWith("image/") ||
		lower.startsWith("audio/") ||
		lower.startsWith("video/") ||
		lower.startsWith("font/") ||
		lower.startsWith("model/")
	) {
		return true;
	}
	if (KNOWN_BINARY_APPLICATION_MIMES.has(lower)) return true;
	if (lower.startsWith("application/vnd.openxmlformats-officedocument.")) return true;
	return (
		lower.endsWith("+zip") ||
		lower.endsWith("+gzip") ||
		lower.endsWith("+cbor") ||
		lower.endsWith("+protobuf") ||
		lower.endsWith("+msgpack") ||
		lower.endsWith("+ber") ||
		lower.endsWith("+der")
	);
}

function isTextualMime(mimeType: string, rawBytes?: Uint8Array, charset?: string | null): boolean {
	const lower = mimeType.trim().toLowerCase();
	if (isKnownBinaryMime(lower)) {
		return false;
	}
	if (charset !== undefined && charset !== null && charset.trim().length > 0) {
		return true;
	}
	if (
		lower === "" ||
		lower.startsWith("text/") ||
		lower === "image/svg+xml" ||
		EXPLICIT_TEXTUAL_APPLICATION_MIMES.has(lower) ||
		lower.endsWith("+json") ||
		lower.endsWith("+xml") ||
		lower.endsWith("+yaml") ||
		lower.endsWith("+toml") ||
		lower.endsWith("+csv") ||
		lower.endsWith("+jwt")
	) {
		return true;
	}
	if (isKnownBinaryMime(lower)) {
		return false;
	}
	if (rawBytes !== undefined) {
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Sanitize memory content prior to SQLite or blob-store persistence:
 * 1. Strips injected harness/memory wrapper tags (`<system-*>`, `<irc>`, `<memories>`, `<private>`, etc.).
 * 2. Scrubs live credentials (`[REDACTED]`).
 * 3. Extracts data URIs, payloads exceeding {@link SIZE_HARD_CAP}, and high-entropy blobs to disk
 *    (after scrubbing textual data URIs and oversized text payloads so secrets are never written to blobs).
 */
export function sanitizeContent(content: string): [sanitizedContent: string, meta: SanitizeMetadata] {
	const originalByteSize = Buffer.byteLength(content, "utf8");
	let workingContent = content;
	let tagsWereStripped = false;
	const initialTagRes = stripInjectedMemoryTags(workingContent);
	if (initialTagRes.stripped) {
		workingContent = initialTagRes.content;
		tagsWereStripped = true;
	}

	if (isDataUri(workingContent)) {
		const match = DATA_URI_RE.exec(workingContent);
		if (match?.groups !== undefined) {
			const rawMime = match.groups.mime;
			if (rawMime === undefined || VALID_MIME_RE.test(rawMime)) {
				const mimeType = rawMime ?? (match.groups.base64 !== undefined ? "application/octet-stream" : "text/plain");
				const params = match.groups.params;
				const charset = extractCharset(params);
				const rawPayload = match.groups.data ?? "";

				let rawBytes: Buffer | null = null;
				if (match.groups.base64 !== undefined) {
					rawBytes = decodeBase64Payload(rawPayload);
				} else {
					rawBytes = decodePercentEncoded(rawPayload);
				}

				if (rawBytes !== null) {
					let bytesToStore: Buffer = rawBytes;
					const originalPayloadSize = rawBytes.length;
					const omittedMime = rawMime === undefined;
					const isTextual = omittedMime || isTextualMime(mimeType, rawBytes, charset);
					const dataMeta: SanitizeMetadata = {
						original_size: originalPayloadSize,
						mime: mimeType,
						extraction_reason: "data_uri",
					};
					if (tagsWereStripped) {
						dataMeta.stripped_tags = true;
					}
					if (isTextual) {
						const unsupportedCharset = !isSupportedSymmetricCharset(charset);
						let decoded = decodeWithCharset(rawBytes, charset);
						let anyStripped = false;
						const innerRedacted: string[] = [];
						decoded = resanitizeDecodedText(
							decoded,
							() => {
								anyStripped = true;
								dataMeta.stripped_tags = true;
							},
							types => {
								for (const t of types) {
									if (!innerRedacted.includes(t)) innerRedacted.push(t);
								}
							},
						);
						if (decoded.includes("[REDACTED_NESTED_DATA_URI]") && !innerRedacted.includes("nested_data_uri")) {
							innerRedacted.push("nested_data_uri");
						}
						const tagRes = stripInjectedMemoryTags(decoded);
						if (tagRes.stripped) {
							decoded = tagRes.content;
							dataMeta.stripped_tags = true;
							anyStripped = true;
						}
						const credRes = scrubLiveCredentials(decoded);
						if (credRes.matchedTypes.length > 0) {
							decoded = credRes.content;
							for (const t of credRes.matchedTypes) {
								if (!innerRedacted.includes(t)) innerRedacted.push(t);
							}
						}
						if (innerRedacted.length > 0) {
							dataMeta.redacted_secrets = innerRedacted;
						}
						if (unsupportedCharset || anyStripped || innerRedacted.length > 0) {
							bytesToStore = encodeWithCharset(decoded, charset, rawBytes);
						}
					}
					const sha256 = storeBlob(bytesToStore);
					const blobRef = `blob://sha256/${sha256}`;
					dataMeta.blob_ref = blobRef;
					return [
						`[Binary content extracted: ${mimeType}, ${bytesToStore.length.toLocaleString("en-US")} bytes → ${blobRef}]`,
						dataMeta,
					];
				}
			}
		} else {
			const b64Fallback = /^data:[^,]*;base64,(?<data>[\s\S]*)$/i.exec(workingContent);
			if (b64Fallback?.groups?.data !== undefined) {
				const rawBytes = decodeBase64Payload(b64Fallback.groups.data);
				if (rawBytes !== null) {
					let decoded = decodeWithCharset(rawBytes, "utf-8");
					let anyStripped = false;
					const innerRedacted: string[] = [];
					decoded = resanitizeDecodedText(
						decoded,
						() => {
							anyStripped = true;
						},
						types => {
							for (const t of types) {
								if (!innerRedacted.includes(t)) innerRedacted.push(t);
							}
						},
					);
					const tagRes = stripInjectedMemoryTags(decoded);
					if (tagRes.stripped) {
						decoded = tagRes.content;
						anyStripped = true;
					}
					const credRes = scrubLiveCredentials(decoded);
					if (credRes.matchedTypes.length > 0) {
						decoded = credRes.content;
						for (const t of credRes.matchedTypes) {
							if (!innerRedacted.includes(t)) innerRedacted.push(t);
						}
					}
					if (anyStripped || innerRedacted.length > 0) {
						const bytesToStore = encodeWithCharset(decoded, "utf-8", rawBytes);
						const sha256 = storeBlob(bytesToStore);
						const blobRef = `blob://sha256/${sha256}`;
						const dataMeta: SanitizeMetadata = {
							original_size: rawBytes.length,
							mime: "text/plain",
							extraction_reason: "data_uri",
							blob_ref: blobRef,
						};
						if (tagsWereStripped || anyStripped) {
							dataMeta.stripped_tags = true;
						}
						if (innerRedacted.length > 0) {
							dataMeta.redacted_secrets = innerRedacted;
						}
						return [
							`[Binary content extracted: text/plain, ${bytesToStore.length.toLocaleString("en-US")} bytes → ${blobRef}]`,
							dataMeta,
						];
					}
				}
			} else {
				const nonB64Fallback = /^data:[^,]*,(?<data>[\s\S]*)$/i.exec(workingContent);
				if (nonB64Fallback?.groups?.data !== undefined) {
					const rawBytes = decodePercentEncoded(nonB64Fallback.groups.data);
					let decoded = decodeWithCharset(rawBytes, "utf-8");
					let anyStripped = false;
					const innerRedacted: string[] = [];
					decoded = resanitizeDecodedText(
						decoded,
						() => {
							anyStripped = true;
						},
						types => {
							for (const t of types) {
								if (!innerRedacted.includes(t)) innerRedacted.push(t);
							}
						},
					);
					const tagRes = stripInjectedMemoryTags(decoded);
					if (tagRes.stripped) {
						decoded = tagRes.content;
						anyStripped = true;
					}
					const credRes = scrubLiveCredentials(decoded);
					if (credRes.matchedTypes.length > 0) {
						decoded = credRes.content;
						for (const t of credRes.matchedTypes) {
							if (!innerRedacted.includes(t)) innerRedacted.push(t);
						}
					}
					if (anyStripped || innerRedacted.length > 0) {
						const bytesToStore = encodeWithCharset(decoded, "utf-8", rawBytes);
						const sha256 = storeBlob(bytesToStore);
						const blobRef = `blob://sha256/${sha256}`;
						const dataMeta: SanitizeMetadata = {
							original_size: rawBytes.length,
							mime: "text/plain",
							extraction_reason: "data_uri",
							blob_ref: blobRef,
						};
						if (tagsWereStripped || anyStripped) {
							dataMeta.stripped_tags = true;
						}
						if (innerRedacted.length > 0) {
							dataMeta.redacted_secrets = innerRedacted;
						}
						return [
							`[Binary content extracted: text/plain, ${bytesToStore.length.toLocaleString("en-US")} bytes → ${blobRef}]`,
							dataMeta,
						];
					}
				}
			}
		}
	}

	const meta: SanitizeMetadata = {};
	if (tagsWereStripped) {
		meta.stripped_tags = true;
	}
	const redactedTypes: string[] = [];
	const text = resanitizeDecodedText(
		workingContent,
		() => {
			meta.stripped_tags = true;
		},
		types => {
			for (const t of types) {
				if (!redactedTypes.includes(t)) redactedTypes.push(t);
			}
		},
	);
	if (redactedTypes.length > 0) {
		meta.redacted_secrets = redactedTypes;
	}

	const textByteSize = Buffer.byteLength(text, "utf8");
	if (textByteSize > SIZE_HARD_CAP) {
		const rawBytes = Buffer.from(text, "utf8");
		const sha256 = storeBlob(rawBytes);
		const blobRef = `blob://sha256/${sha256}`;
		return [
			`[Large content extracted: ${textByteSize.toLocaleString("en-US")} bytes → ${blobRef}]`,
			{
				...meta,
				blob_ref: blobRef,
				original_size: originalByteSize,
				extraction_reason: "size_cap",
			},
		];
	}

	if (textByteSize > SIZE_BASE64_CHECK && looksLikeBase64Blob(text)) {
		const rawBytes = Buffer.from(text, "utf8");
		const sha256 = storeBlob(rawBytes);
		const entropy = Math.round(shannonEntropy(text) * 100) / 100;
		const blobRef = `blob://sha256/${sha256}`;
		return [
			`[Encoded content extracted: ${textByteSize.toLocaleString("en-US")} bytes, entropy ${entropy.toFixed(1)} bits/char → ${blobRef}]`,
			{
				...meta,
				blob_ref: blobRef,
				original_size: originalByteSize,
				entropy,
				extraction_reason: "high_entropy",
			},
		];
	}

	return [text, meta];
}
