/**
 * Resolve a configured LiteLLM base URL onto the proxy's management surface.
 *
 * Discovery (`/model/info`) and usage reporting (`/key/info`, `/v2/user/info`)
 * both sit beside the inference `/v1` prefix rather than under it, so the
 * terminal `/v1` is dropped while any deployment path prefix is kept. Valid
 * URLs also lose credentials, query, and fragment. The fallback for an
 * unparseable string is not validation: callers that need an HTTP(S) origin
 * must check the input first.
 */
export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/g, "");
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}
