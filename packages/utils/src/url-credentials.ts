/**
 * Credentials a URL can carry in text: userinfo (`scheme://user:password@host`)
 * and query parameters whose name marks a secret (`?apiKey=…`, `&access_token=…`).
 * Configured endpoints (MCP servers, brokers, registries) may embed either, and
 * the URL then travels into error messages, runtime error fields (Bun's fetch
 * errors carry the full URL in `path`) and log context.
 */
// Anchored on `://` rather than on the scheme, so the scan starts only at a `:`.
const URL_USERINFO = /(:\/\/)[^\s/?#@"'<>\\]+@/g;
const SECRET_QUERY_PARAM =
	/([?&][^=&#\s"'<>\\]*(?:key|token|secret|auth|password|passwd)[^=&#\s"'<>\\]*=)[^&#\s"'<>\\]+/gi;

/**
 * Replace URL userinfo and secret-named query values anywhere in `text` with
 * `[redacted]`. Text without `://` is returned unchanged, and each pattern runs
 * only when its marker (`@`, `=`) occurs, so callers on hot paths (every log
 * record) mostly pay substring scans.
 */
export function redactUrlCredentials(text: string): string {
	if (!text.includes("://")) return text;
	let out = text;
	if (out.includes("@")) out = out.replace(URL_USERINFO, "$1[redacted]@");
	if (out.includes("=")) out = out.replace(SECRET_QUERY_PARAM, "$1[redacted]");
	return out;
}
