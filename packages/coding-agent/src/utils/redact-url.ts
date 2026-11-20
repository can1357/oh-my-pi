const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

/**
 * Drop URL userinfo and fragments. By default, redact only query parameters
 * with credential-like names; `"omit"` drops the whole query.
 */
export function redactUrlForLog(url: string, query: "redact-sensitive" | "omit" = "redact-sensitive"): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		parsed.hash = "";
		if (query === "omit") {
			parsed.search = "";
		} else {
			for (const name of parsed.searchParams.keys()) {
				if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
			}
		}
		return parsed.toString();
	} catch {
		// An unparseable URL can still carry credentials.
		return url.split(/[?#]/, 1)[0].replace(/^([^:/?#]+:\/\/)[^/@]*@/, "$1");
	}
}
