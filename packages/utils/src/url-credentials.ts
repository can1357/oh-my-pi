/**
 * Credentials a URL can carry in text: userinfo (`scheme://user:password@host`)
 * and query parameters whose name marks a secret (`?apiKey=…`, `&access_token=…`).
 * Configured endpoints (MCP servers, brokers, registries) may embed either, and
 * the URL then travels into error messages, runtime error fields (Bun's fetch
 * errors carry the full URL in `path`) and log context.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>\\]+@/gi;
const SECRET_QUERY_PARAM =
	/([?&][^=&#\s"'<>\\]*(?:key|token|secret|auth|password|passwd)[^=&#\s"'<>\\]*=)[^&#\s"'<>\\]+/gi;

/**
 * Replace URL userinfo and secret-named query values anywhere in `text` with
 * `[redacted]`. Text without `://` is returned unchanged, so callers on hot
 * paths (every log record) pay one substring scan.
 */
export function redactUrlCredentials(text: string): string {
	if (!text.includes("://")) return text;
	return text.replace(URL_USERINFO, "$1[redacted]@").replace(SECRET_QUERY_PARAM, "$1[redacted]");
}
