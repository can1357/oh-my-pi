/**
 * Identity-free Kiro route helpers: region/endpoint/profile validation and
 * SSRF-safe management/runtime URL construction. No credentials here.
 */

/**
 * Kiro API keys are always `ksk_…`, so the token shape distinguishes an API key
 * from an OAuth bearer. The credential projection carries no other marker.
 */
export const KIRO_API_KEY_PREFIX = "ksk_";

/** Bootstrap-only management probes — not an availability allowlist. */
export const KIRO_BOOTSTRAP_REGIONS = ["us-east-1", "eu-central-1"] as const;

export type KiroBootstrapRegion = (typeof KIRO_BOOTSTRAP_REGIONS)[number];

/** AWS-style region id used in `management.{region}.kiro.dev`. */
const KIRO_API_REGION_RE = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;

/**
 * CodeWhisperer/Kiro profile ARN. Capture group 1 is the API region.
 * Account id and profile suffix are validated but never logged or cached.
 */
const KIRO_PROFILE_ARN_RE = /^arn:aws:codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-\d+):\d+:profile\/[A-Za-z0-9_-]+$/;

/** Map SSO/OIDC login regions onto Kiro's current management/runtime regions. */
const SSO_TO_API_REGION: Readonly<Record<string, string>> = Object.freeze({
	"us-west-1": "us-east-1",
	"us-west-2": "us-east-1",
	"us-east-2": "us-east-1",
	"ap-southeast-1": "us-east-1",
	"ap-southeast-2": "us-east-1",
	"ap-northeast-1": "us-east-1",
	"ap-south-1": "us-east-1",
	"eu-west-1": "eu-central-1",
	"eu-west-2": "eu-central-1",
	"eu-west-3": "eu-central-1",
	"eu-north-1": "eu-central-1",
	"eu-south-1": "eu-central-1",
	"eu-south-2": "eu-central-1",
	"eu-central-2": "eu-central-1",
});

export interface KiroProfileRoute {
	apiRegion: string;
	profileArn: string;
}

export type KiroEndpointKind = "management" | "runtime";

export interface KiroEndpointRoute {
	kind: KiroEndpointKind;
	apiRegion: string;
	baseUrl: string;
}

/** Return the region when it is a safe Kiro API region; otherwise `undefined`. */
export function validateKiroApiRegion(region: string | undefined | null): string | undefined {
	if (typeof region !== "string" || region.length === 0 || region.length > 64) return undefined;
	if (!KIRO_API_REGION_RE.test(region)) return undefined;
	return region;
}

/**
 * Map an SSO/OIDC region hint to a Kiro API region. Unknown valid API regions
 * pass through; invalid values fall back to `us-east-1` only when absent.
 */
export function resolveKiroApiRegion(ssoRegion: string | undefined | null): string {
	if (!ssoRegion) return "us-east-1";
	const mapped = SSO_TO_API_REGION[ssoRegion] ?? ssoRegion;
	return validateKiroApiRegion(mapped) ?? "us-east-1";
}

/** Construct `https://management.{region}.kiro.dev/` after region validation. */
export function kiroManagementBaseUrl(apiRegion: string): string {
	const region = validateKiroApiRegion(apiRegion);
	if (!region) throw new Error("Invalid Kiro API region");
	return `https://management.${region}.kiro.dev/`;
}

/** Construct `https://runtime.{region}.kiro.dev/` after region validation. */
export function kiroRuntimeBaseUrl(apiRegion: string): string {
	const region = validateKiroApiRegion(apiRegion);
	if (!region) throw new Error("Invalid Kiro API region");
	return `https://runtime.${region}.kiro.dev/`;
}

/**
 * Parse and validate a Kiro management or runtime base URL. Rejects userinfo,
 * non-HTTPS, non-default ports, unexpected hosts/paths, and region injection.
 */
export function parseKiroEndpoint(endpoint: string | undefined | null): KiroEndpointRoute | undefined {
	if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 256) return undefined;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	if (url.username || url.password) return undefined;
	if (url.port && url.port !== "443") return undefined;
	if (url.search || url.hash) return undefined;
	const path = url.pathname === "" ? "/" : url.pathname;
	if (path !== "/") return undefined;

	const labels = url.hostname.split(".");
	if (labels.length !== 4) return undefined;
	const [kindLabel, region, second, tld] = labels;
	if (second !== "kiro" || tld !== "dev") return undefined;
	if (kindLabel !== "management" && kindLabel !== "runtime") return undefined;
	const apiRegion = validateKiroApiRegion(region);
	if (!apiRegion || apiRegion !== region) return undefined;

	const kind: KiroEndpointKind = kindLabel;
	const baseUrl = kind === "management" ? kiroManagementBaseUrl(apiRegion) : kiroRuntimeBaseUrl(apiRegion);
	return { kind, apiRegion, baseUrl };
}

/** Extract a validated API region from a Kiro endpoint URL. */
export function extractRegionFromKiroEndpoint(endpoint: string | undefined | null): string | undefined {
	return parseKiroEndpoint(endpoint)?.apiRegion;
}

/**
 * Validate a CodeWhisperer/Kiro profile ARN and derive its API region.
 * Returns `undefined` for malformed or SSRF-shaped values.
 */
export function parseKiroProfileArn(profileArn: string | undefined | null): KiroProfileRoute | undefined {
	if (typeof profileArn !== "string" || profileArn.length === 0 || profileArn.length > 512) return undefined;
	const match = profileArn.match(KIRO_PROFILE_ARN_RE);
	if (!match) return undefined;
	const apiRegion = validateKiroApiRegion(match[1]);
	if (!apiRegion) return undefined;
	return { apiRegion, profileArn };
}

/** Extract the display-safe trailing profile segment from a validated ARN. */
export function extractKiroProfileSegment(profileArn: string | undefined | null): string | undefined {
	const parsed = parseKiroProfileArn(profileArn);
	return parsed?.profileArn.slice(parsed.profileArn.lastIndexOf("/") + 1);
}

/** Extract region from a profile ARN without accepting unrelated strings. */
export function extractRegionFromKiroProfileArn(profileArn: string | undefined | null): string | undefined {
	return parseKiroProfileArn(profileArn)?.apiRegion;
}
