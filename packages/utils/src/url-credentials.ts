/**
 * Credentials a URL can carry in text: userinfo (`scheme://user:password@host`)
 * and query or fragment parameters whose name marks a secret (`?apiKey=…`,
 * `#access_token=…`). Configured endpoints (MCP servers, brokers, registries)
 * may embed either, and the URL then travels into error messages, runtime error
 * fields (Bun's fetch errors carry the full URL in `path`) and log context.
 *
 * The scanner splits each URL the way the WHATWG URL parser does, so a spelling
 * the parser accepts cannot hide a credential from it:
 * - the authority runs from `://` to the first `/`, `?`, `#` or `\`, and its
 *   userinfo ends at the LAST `@` in it (a raw `@` or `'` in a password stays
 *   inside the userinfo, as the parser reads it);
 * - query and fragment parameters are split on `&`, and a name is compared
 *   after percent-decoding (`%74oken` is `token`).
 * It works on any text, whether or not the URL would parse, and it is linear in
 * the text's length: every character is visited a bounded number of times.
 */

// Literal alternatives only, so a test is linear in the name's length.
const SECRET_NAME = /key|token|secret|auth|passw(?:or)?d/i;
/** Nested URLs inside a parameter value are scanned this deep; deeper values are redacted whole. */
const MAX_NESTED_URL_DEPTH = 2;
const REDACTED = "[redacted]";

/** Whether a query or fragment parameter named `name` (raw, as it appears in the URL) carries a secret. */
export function isSecretUrlParamName(name: string): boolean {
	return SECRET_NAME.test(name.includes("%") ? percentDecode(name) : name);
}

/**
 * Replace URL userinfo and secret-named query and fragment values anywhere in
 * `text` with `[redacted]`. Text without `://` is returned unchanged; a text
 * that needs no change is returned as the same string.
 */
export function redactUrlCredentials(text: string): string {
	return redactAt(text, 0);
}

function redactAt(text: string, depth: number): string {
	let hit = text.indexOf("://");
	if (hit < 0) return text;
	let out = "";
	let copied = 0;
	while (hit >= 0) {
		const authorityStart = hit + 3;
		// Authority: up to the first `/ ? # \` or whitespace; userinfo ends at its last `@`.
		let i = authorityStart;
		let lastAt = -1;
		for (; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x5c || isSpace(c)) break;
			if (c === 0x40) lastAt = i;
		}
		if (lastAt >= 0) {
			out += text.slice(copied, authorityStart) + REDACTED;
			copied = lastAt;
		}
		// Path: up to `?`, `#`, whitespace, or another URL's `://`.
		for (; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c === 0x3f || c === 0x23 || isSpace(c)) break;
			if (c === 0x3a && text.startsWith("//", i + 1)) break;
		}
		// Query, then fragment: `&`-separated parameters up to whitespace.
		while (i < text.length && (text.charCodeAt(i) === 0x3f || text.charCodeAt(i) === 0x23)) {
			let end = i + 1;
			while (
				end < text.length &&
				!isSpace(text.charCodeAt(end)) &&
				(text.charCodeAt(end) !== 0x23 || text.charCodeAt(i) === 0x23)
			)
				end++;
			const params = text.slice(i + 1, end);
			const redacted = redactParams(params, depth);
			if (redacted !== params) {
				out += text.slice(copied, i + 1) + redacted;
				copied = end;
			}
			i = end;
		}
		hit = i < text.length ? text.indexOf("://", Math.max(i, authorityStart)) : -1;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

function redactParams(params: string, depth: number): string {
	// Built only once a parameter changes; until then the input is returned as is.
	// No secret word, no escape and no nested URL anywhere in the parameters: nothing can need redaction.
	if (!SECRET_NAME.test(params) && !params.includes("%") && !params.includes("://")) return params;
	let out: string | undefined;
	let start = 0;
	// The next `=` at or after `start`; reused across pairs so `a&a&…&a=1` is not rescanned per pair.
	let eq = -2;
	while (start <= params.length) {
		let end = params.indexOf("&", start);
		if (end < 0) end = params.length;
		if (eq !== -1 && eq < start) eq = params.indexOf("=", start);
		if (eq >= 0 && eq < end) {
			const value = params.slice(eq + 1, end);
			const clean = redactParamValue(params.slice(start, eq), value, depth);
			if (clean !== value) {
				out = `${out ?? params.slice(0, start)}${params.slice(start, eq + 1)}${clean}`;
			} else if (out !== undefined) {
				out += params.slice(start, end);
			}
		} else if (out !== undefined) {
			out += params.slice(start, end);
		}
		if (out !== undefined && end < params.length) out += "&";
		start = end + 1;
	}
	return out ?? params;
}

function redactParamValue(name: string, value: string, depth: number): string {
	if (value.length === 0) return value;
	if (isSecretUrlParamName(name)) return REDACTED;
	// A URL nested in a value (`redirect_uri=…`), raw or percent-encoded, carries its own credentials.
	const nested = value.includes("://") ? value : value.includes("%") ? percentDecode(value) : undefined;
	if (nested === undefined || !nested.includes("://")) return value;
	if (depth >= MAX_NESTED_URL_DEPTH) return REDACTED;
	const clean = redactAt(nested, depth + 1);
	if (clean === nested) return value;
	return nested === value ? clean : REDACTED;
}

/** Decode every valid `%XX` byte; malformed escapes stay as written. ASCII-exact, which the secret words need. */
function percentDecode(text: string): string {
	if (!text.includes("%")) return text;
	return text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function isSpace(c: number): boolean {
	return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}
