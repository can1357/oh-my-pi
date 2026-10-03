/**
 * Single classifier for "this endpoint is served by the local machine".
 *
 * Discovery budgets ({@link discoveryProbeTimeoutMs}) and the built-in role
 * presets both branch on it, and two copies drifted apart once (IPv6 `::` was
 * local in one and remote in the other), so every caller resolves it here.
 * Wildcard bind addresses (`0.0.0.0`, `::`) count as local: a model advertised
 * on them is reachable on this host.
 */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.");
}

/**
 * Whether `value` points at the local machine. `fallback` decides unparseable
 * input — probe budgets treat a malformed base URL as local (tight timeout),
 * while policy decisions stay conservative and treat it as remote.
 */
export function isLoopbackUrl(value: string, fallback = false): boolean {
	try {
		return isLoopbackHostname(new URL(value).hostname);
	} catch {
		return fallback;
	}
}
