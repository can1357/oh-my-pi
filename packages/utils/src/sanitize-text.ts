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
 * Names whose values are secrets where names are structured — query,
 * fragment, and userinfo parameters of a URL, JSON keys. Substring match, so
 * `authCode`, `oauth_code`, `exaApiKey`, `client_secret`, and `refresh_token`
 * all qualify; over-matching is the safe direction there. The one
 * classification every redactor shares.
 */
export const SECRET_NAME = /auth|cookie|secret|passw(?:or)?d|pwd|token|credential|key|signature/i;

/**
 * In prose only a name that ends in a secret word right before `:` or `=`
 * counts, so `OAuthError: invalid_grant`, `tokens: 500`, and
 * `authorized: yes` keep their values while `refresh_token:`, `client_secret=`,
 * `"apiKey":`, and `authCode=` lose theirs.
 */
const SECRET_NAME_IN_PROSE =
	/(?:authorization|bearer|cookie|secret|passw(?:or)?d|pwd|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|signature|\bauth(?:[-_]?(?:code|token|key))?)/i;

/** `Bearer …` / `Basic …` authorization values. */
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
/** `name: value`, `name=value`, `"name":"value"` in prose; an authorization scheme word is kept. */
const NAMED_SECRET_VALUE = new RegExp(
	`([\\w-]*${SECRET_NAME_IN_PROSE.source}["']?\\s*[:=]\\s*["']?)(?!(?:Bearer|Basic)\\b)[^\\s,;}"']+`,
	"gi",
);
/** A JWT: three base64url segments. */
const JWT_VALUE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** A URL wherever it sits in text; ends at whitespace or a quote/bracket. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** Sentence punctuation that follows a URL in prose is not part of it. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/** A parameter name as the receiving parser reads it: percent-decoded, `+` as space; malformed escapes stay raw. */
function decodedParameterName(name: string): string {
	try {
		return decodeURIComponent(name.replaceAll("+", " "));
	} catch {
		return name;
	}
}

/** `name=value&…` with every secret-named value replaced; other pairs verbatim, never re-encoded. */
function redactPairs(pairs: string): string {
	return pairs
		.split("&")
		.map(pair => {
			const separator = pair.indexOf("=");
			if (separator === -1) return pair;
			const name = pair.slice(0, separator);
			// The receiving parser decodes `api%4Bey` to `apiKey`; classify what it
			// reads while leaving the original spelling in the output.
			return SECRET_NAME.test(decodedParameterName(name)) ? `${name}=[redacted]` : pair;
		})
		.join("&");
}

function redactUrl(url: string): string {
	const withoutUserinfo = url.replace(URL_USERINFO, "$1[redacted]@");
	const fragmentStart = withoutUserinfo.indexOf("#");
	const head = fragmentStart === -1 ? withoutUserinfo : withoutUserinfo.slice(0, fragmentStart);
	const fragment = fragmentStart === -1 ? undefined : withoutUserinfo.slice(fragmentStart + 1);
	const queryStart = head.indexOf("?");
	const base = queryStart === -1 ? head : head.slice(0, queryStart);
	const query = queryStart === -1 ? undefined : head.slice(queryStart + 1);
	return `${base}${query === undefined ? "" : `?${redactPairs(query)}`}${fragment === undefined ? "" : `#${redactPairs(fragment)}`}`;
}

/**
 * Redact the credential-bearing parts of every URL in `text` — userinfo,
 * query and fragment parameters whose name is a {@link SECRET_NAME} — so the
 * text can be logged or shown. Works on a bare URL, on an identifier that
 * embeds one (a managed MCP credential id keeps its server URL's complete
 * query string), and on prose around a URL: nothing outside a URL is touched,
 * and inside one only the redacted values change — no re-encoding.
 */
export function redactUrlSecrets(text: string): string {
	return text.replace(URL_IN_TEXT, match => {
		const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
		return `${redactUrl(trailing ? match.slice(0, -trailing.length) : match)}${trailing}`;
	});
}

/**
 * Redact credential-shaped values in free text before it is logged or shown:
 * every URL's secrets, authorization values, `name: value` / `name=value` /
 * `"name":"value"` pairs for a secret name, and JWTs. For an error body or a
 * credential-disable cause that may echo what was submitted.
 */
export function redactSecrets(text: string): string {
	return redactUrlSecrets(text)
		.replace(AUTHORIZATION_VALUE, "$1 [redacted]")
		.replace(NAMED_SECRET_VALUE, "$1[redacted]")
		.replace(JWT_VALUE, "[redacted]");
}
