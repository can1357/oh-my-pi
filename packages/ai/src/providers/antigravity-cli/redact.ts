/**
 * Structural redaction of OAuth material from Antigravity CLI failure text.
 * Only fixed key lists and URL/Bearer shapes are masked, so failure keywords
 * such as "quota", "timeout" or "exit code=1" survive for diagnosis.
 */

const MASK = "***";

const SENSITIVE_QUERY_KEYS = [
	"code_challenge",
	"code_verifier",
	"access_token",
	"refresh_token",
	"client_secret",
	"id_token",
	"api_key",
	"password",
	"state",
	"token",
	"code",
] as const;

const OAUTH_PAIR_KEYS = [
	"code_challenge",
	"code_verifier",
	"access_token",
	"refresh_token",
	"client_secret",
	"id_token",
	"token",
	"api_key",
	"password",
] as const;

const URL_USERINFO = /(:\/\/)[^:/?#\s@]*:[^/?#\s@]*@/gi;
const SCHEME_CHARACTER = /[a-z0-9+.-]/i;
const SENSITIVE_QUERY_PARAM = new RegExp(`([?#&](?:${SENSITIVE_QUERY_KEYS.join("|")})=)([^&#\\s"']*)`, "gi");
const QUOTED_OAUTH_PAIR = new RegExp(
	`((?:["'])(?:${OAUTH_PAIR_KEYS.join("|")})(?:["'])\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}\\]]+)`,
	"gi",
);
const BARE_OAUTH_PAIR = new RegExp(
	`\\b(${OAUTH_PAIR_KEYS.join("|")})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)"'}\\]]+)`,
	"gi",
);
const QUOTED_AMBIGUOUS_PAIR = new RegExp(
	`((?:["'])(?:code|state)(?:["'])\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
	"gi",
);
const AMBIGUOUS_BARE_PAIR = new RegExp(`\\b(code|state)(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)"'}\\]]+)`, "gi");
const BEARER_TOKEN = /\b(Bearer\s+)\S+/gi;

/** A long value that is not an ALL_CAPS diagnostic constant is treated as an OAuth grant. */
function isOpaqueSecret(value: string): boolean {
	if (value.length < 16) return false;
	return !/^[A-Z][A-Z0-9_]*$/u.test(value);
}

/** Masks `scheme://user:password@` without scanning the scheme as a backtracking prefix. */
function redactUrlUserinfo(text: string): string {
	return text.replace(URL_USERINFO, (match, separator: string, offset: number) => {
		let start = offset;
		while (start > 0 && SCHEME_CHARACTER.test(text.charAt(start - 1))) start--;
		return /[a-z]/i.test(text.slice(start, offset)) ? `${separator}${MASK}@` : match;
	});
}

/** Mask credentials in diagnostic text while leaving unrelated failure detail readable. */
export function redactSensitiveText(text: string | undefined | null): string {
	if (!text) return "";
	return redactUrlUserinfo(text)
		.replace(QUOTED_OAUTH_PAIR, `$1"${MASK}"`)
		.replace(SENSITIVE_QUERY_PARAM, `$1${MASK}`)
		.replace(BARE_OAUTH_PAIR, `$1$2${MASK}`)
		.replace(QUOTED_AMBIGUOUS_PAIR, (match, prefix: string, quoted: string) =>
			isOpaqueSecret(quoted.slice(1, -1)) ? `${prefix}"${MASK}"` : match,
		)
		.replace(AMBIGUOUS_BARE_PAIR, (match, key: string, separator: string, value: string) => {
			const unquoted = value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
			return isOpaqueSecret(unquoted) ? `${key}${separator}${MASK}` : match;
		})
		.replace(BEARER_TOKEN, `$1${MASK}`);
}
