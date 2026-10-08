/**
 * Per-site consent for relay-driven browsing: a relay tab drives the user's
 * real Chrome, so an origin it opens at or navigates to must be allowed by
 * `browser.relayAllowedSites` (or explicitly approved through the ask tool —
 * see the gate in `browser.ts`). Pure, dependency-free helpers only; pattern
 * semantics align with the per-tab `allowed_domains` matching in `network.ts`
 * (`normalizeAllowedDomains`/`domainMatches`): exact hostnames, plus
 * `*.example.com` wildcards that also match the bare domain.
 */

/** Origin (`scheme://host[:port]`) a URL would drive, or undefined for non-http(s) URLs (`about:blank` never gates). */
export function parseSite(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	const origin = parsed.origin;
	return origin === "null" ? undefined : origin;
}

/**
 * Hostname of an origin or bare-host string (scheme, port, path, and case
 * stripped; no trailing dot), so origins and allowlist patterns compare as
 * hostnames the way `allowed_domains` does. IPv6 literals keep their brackets.
 */
export function siteHost(value: string): string {
	try {
		return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		const bare = value.trim().toLowerCase().split("/", 1)[0] ?? "";
		if (bare.startsWith("[")) {
			const close = bare.indexOf("]");
			return close === -1 ? bare : bare.slice(0, close + 1);
		}
		return bare.replace(/\.$/, "").split(":", 1)[0] ?? "";
	}
}

/**
 * Whether `origin` is allowed by `patterns`: exact hostnames
 * (`example.com`) and `*.example.com` wildcards that also match the bare
 * domain. Invalid patterns never match (a persisted typo must not brick
 * relay browsing, unlike a per-call `allowed_domains` list which throws).
 */
export function siteMatches(origin: string, patterns: readonly string[]): boolean {
	const host = siteHost(origin);
	if (!host) return false;
	return patterns.some(pattern => {
		const normalized = siteHost(pattern);
		if (!normalized.startsWith("*.")) return normalized !== "" && host === normalized;
		const suffix = normalized.slice(2);
		if (!suffix || suffix.includes("*")) return false;
		return host === suffix || host.endsWith(`.${suffix}`);
	});
}

/**
 * Origin of `uncheckedUrl` that still needs user consent, or null when the
 * URL needs none: no http(s) origin, or one matching `patterns`.
 */
export function diffSite(uncheckedUrl: string, patterns: readonly string[]): string | null {
	const origin = parseSite(uncheckedUrl);
	if (origin === undefined || siteMatches(origin, patterns)) return null;
	return origin;
}
