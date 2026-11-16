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
] as const;

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+:[^/?#\s@]+@/gi;
const SENSITIVE_QUERY_PARAM = new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS.join("|")})=)([^&#\\s"']*)`, "gi");
const QUOTED_OAUTH_PAIR = new RegExp(
	`((?:["'])(?:${OAUTH_PAIR_KEYS.join("|")})(?:["'])\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}\\]]+)`,
	"gi",
);
const BARE_OAUTH_PAIR = new RegExp(
	`\\b(${OAUTH_PAIR_KEYS.join("|")})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)"'}\\]]+)`,
	"gi",
);
const BEARER_TOKEN = /\b(Bearer\s+)\S+/gi;

/** Mask credentials in diagnostic text while leaving unrelated failure detail readable. */
export function redactSensitiveText(text: string | undefined | null): string {
	if (!text) return "";
	return text
		.replace(URL_USERINFO, `$1${MASK}@`)
		.replace(QUOTED_OAUTH_PAIR, `$1"${MASK}"`)
		.replace(SENSITIVE_QUERY_PARAM, `$1${MASK}`)
		.replace(BARE_OAUTH_PAIR, `$1$2${MASK}`)
		.replace(BEARER_TOKEN, `$1${MASK}`);
}
