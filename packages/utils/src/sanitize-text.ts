/**
 * Strip ANSI escape sequences, remove control characters / lone surrogates,
 * and normalize line endings.
 *
 * Bun-native implementation of the former native `sanitizeText` (see
 * `crates/pi-natives/src/text.rs::sanitize_text`). JavaScript strings are
 * already UTF-16 code-unit arrays. `toWellFormed()` handles the uncommon
 * malformed path; when it changes the input, replacement characters are
 * dropped and the normalized result goes through the well-formed sanitizer.
 *
 * Fast path: well-formed input with no controls or ANSI returns the original
 * string after the control probe.
 */

const ESC_CHAR = "\x1b";

// Well-formed strings only need control/ANSI detection: C0 (excl. \t \n),
// CR, DEL, and C1. ESC (0x1B) is in \x0B-\x1F.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}

/**
 * Names whose values are secrets wherever they appear — query parameters,
 * JSON fields, `name=value` pairs in an error body. Substring match, so
 * compound names (`client_secret`, `exaApiKey`, `refresh_token`,
 * `signingSecret`) qualify; the short words `auth` and `key` match only as
 * whole words so `OAuthError: invalid_grant` and `keyword` keep their values.
 * The one classification every redactor shares.
 */
export const SECRET_NAME =
	/(?:\bauth\b|authorization|bearer|cookie|secret|passw(?:or)?d|pwd|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|\bkey\b|signature)/i;

const SECRET_NAME_SOURCE = SECRET_NAME.source;
/** `Bearer …` / `Basic …` authorization values. */
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
/** `name: value`, `name=value`, `"name":"value"` where the name is a secret name; an authorization scheme word is kept. */
const NAMED_SECRET_VALUE = new RegExp(
	`([\\w-]*${SECRET_NAME_SOURCE}[\\w-]*["']?\\s*[:=]\\s*["']?)(?!(?:Bearer|Basic)\\b)[^\\s,;}"']+`,
	"gi",
);
/** A JWT: three base64url segments. */
const JWT_VALUE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Redact credential-bearing query parameters in a URL, or in any identifier
 * that embeds one — a managed MCP credential id keeps its server URL's
 * complete query string — so the text can be logged or shown. Everything
 * outside the query is left verbatim; the placeholder stays readable rather
 * than percent-encoded.
 */
export function redactUrlSecrets(text: string): string {
	const queryStart = text.indexOf("?");
	if (queryStart === -1) return text;
	const fragmentStart = text.indexOf("#", queryStart);
	const params = new URLSearchParams(text.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart));
	for (const name of params.keys()) {
		if (SECRET_NAME.test(name)) params.set(name, "[redacted]");
	}
	const query = params.toString().replaceAll("%5Bredacted%5D", "[redacted]");
	return `${text.slice(0, queryStart + 1)}${query}${fragmentStart === -1 ? "" : text.slice(fragmentStart)}`;
}

/**
 * Redact credential-shaped values in free text before it is logged or shown:
 * authorization values, query parameters and `name: value` / `name=value` /
 * `"name":"value"` pairs whose name is a {@link SECRET_NAME}, and JWTs. For an
 * error body or a credential-disable cause that may echo what was submitted.
 */
export function redactSecrets(text: string): string {
	return redactUrlSecrets(text)
		.replace(AUTHORIZATION_VALUE, "$1 [redacted]")
		.replace(NAMED_SECRET_VALUE, "$1[redacted]")
		.replace(JWT_VALUE, "[redacted]");
}
