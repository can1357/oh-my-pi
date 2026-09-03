/** Create an abort signal that fires after a timeout and preserves caller cancellation. */
export function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/** Detect a timeout raised by an abortable fetch. */
export function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Proxy environment variables Bun's `fetch` consults, in the precedence order it
 * reads them. Used to name the offending entry in {@link unsupportedProxyMessage}.
 */
const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * Detect Bun's `UnsupportedProxyProtocol` fetch rejection, raised when a proxy
 * env var (`HTTPS_PROXY`, `ALL_PROXY`, …) points at a scheme it cannot drive —
 * most commonly a SOCKS proxy (`socks5://`, `socks5h://`). The raw error tells
 * the caller to "pass `verbose: true` in the second argument to fetch()", which
 * is meaningless from a CLI, so callers translate it into
 * {@link unsupportedProxyMessage}.
 */
export function isUnsupportedProxyError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("UnsupportedProxyProtocol");
}

/**
 * Build an actionable CLI message for an {@link isUnsupportedProxyError} failure,
 * naming any set proxy env var whose scheme is not `http(s)://` so the user can
 * see exactly which variable to change.
 */
export function unsupportedProxyMessage(env: Record<string, string | undefined> = process.env): string {
	const offending: string[] = [];
	for (const name of PROXY_ENV_VARS) {
		const value = env[name];
		if (value && !/^https?:\/\//i.test(value)) offending.push(`${name}=${value}`);
	}
	const detail = offending.length > 0 ? ` (offending: ${offending.join(", ")})` : "";
	return `Proxy configuration uses a scheme Bun's fetch cannot use${detail}. Only http:// and https:// proxies are supported — SOCKS proxies (socks5://, socks5h://) are not. Point HTTP_PROXY/HTTPS_PROXY at an http:// proxy URL or unset the proxy variables, then retry.`;
}
