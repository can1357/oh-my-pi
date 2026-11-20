const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

/**
 * Drop URL userinfo and fragments (which can carry a workspace access token),
 * and redact credential-bearing query params before logging.
 */
export function redactUrlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		parsed.hash = "";
		for (const name of parsed.searchParams.keys()) {
			if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
		}
		return parsed.toString();
	} catch {
		// An unparseable URL can still carry credentials.
		return url.split(/[?#]/, 1)[0].replace(/^([^:/?#]+:\/\/)[^/@]*@/, "$1");
	}
}
