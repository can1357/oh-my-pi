/**
 * Anthropic endpoint-shape predicates: which URLs are the official first-party
 * API, and which non-official hosts enforce Anthropic's thinking-signature
 * protocol on replay. Compat resolution (`./resolve`) and runtime routing in
 * pi-ai both consume these; URL matching is the one detection surface that
 * stays in code.
 */
import { $env, logger } from "@oh-my-pi/pi-utils";
import { hostMatchesUrl, isBedrockRouteUrl } from "../hosts";

const OFFICIAL_ANTHROPIC_URL = "https://api.anthropic.com";

/**
 * Official first-party Anthropic API. A missing baseUrl is official on purpose:
 * request dispatch falls back to `https://api.anthropic.com`. This is the one
 * auth-sensitive host check — OAuth credentials are attached based on it — so
 * it requires the exact origin or a path boundary (`/`) after it; a bare
 * prefix check would accept lookalikes like `https://api.anthropic.com.evil.com`.
 */
export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	return lower === OFFICIAL_ANTHROPIC_URL || lower.startsWith(`${OFFICIAL_ANTHROPIC_URL}/`);
}

/** `anthropic-version` values this codebase knows how to speak. */
export const ANTHROPIC_API_VERSIONS = ["2023-06-01", "2026-10-21"] as const;
export type AnthropicApiVersion = (typeof ANTHROPIC_API_VERSIONS)[number];

/** Version every non-official Anthropic-compatible endpoint receives. */
export const LEGACY_ANTHROPIC_API_VERSION: AnthropicApiVersion = "2023-06-01";

let warnedInvalidApiVersion: string | undefined;

function isAnthropicApiVersion(value: string): value is AnthropicApiVersion {
	return (ANTHROPIC_API_VERSIONS as readonly string[]).includes(value);
}

/**
 * `anthropic-version` for a request to `baseUrl`. `PI_ANTHROPIC_API_VERSION`
 * opts the official first-party API into a newer version; every other host
 * (Copilot, Bedrock, Foundry, Cloudflare, third-party compatibles) stays on
 * {@link LEGACY_ANTHROPIC_API_VERSION} because those deployments gate newer
 * versions on their own schedule (Bedrock accepts 2026-10-21 only for 4.7+).
 * Read per call so a flipped environment takes effect without a restart.
 */
export function resolveAnthropicApiVersion(baseUrl?: string): AnthropicApiVersion {
	if (!isOfficialAnthropicApiUrl(baseUrl)) return LEGACY_ANTHROPIC_API_VERSION;
	const configured = $env.PI_ANTHROPIC_API_VERSION?.trim();
	if (!configured) return LEGACY_ANTHROPIC_API_VERSION;
	if (isAnthropicApiVersion(configured)) return configured;
	if (warnedInvalidApiVersion !== configured) {
		warnedInvalidApiVersion = configured;
		logger.warn("anthropic: unsupported PI_ANTHROPIC_API_VERSION; using legacy version", {
			configured,
			supported: ANTHROPIC_API_VERSIONS,
			using: LEGACY_ANTHROPIC_API_VERSION,
		});
	}
	return LEGACY_ANTHROPIC_API_VERSION;
}

/**
 * Whether Messages requests on `version` may carry `temperature`, `top_p`,
 * or `top_k`. API version 2026-10-21 rejects all three with a 400, even at
 * their default values.
 */
export function anthropicApiVersionAcceptsSamplingParams(version: AnthropicApiVersion): boolean {
	return version === "2023-06-01";
}

const CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER = /gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i;
const VERTEX_ANTHROPIC_URL_MARKER = /aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i;
const BEDROCK_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i;
const AZURE_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i;

/**
 * Amazon Bedrock's Anthropic Messages API: the `/anthropic` path on the
 * bedrock-runtime or bedrock-mantle endpoint. It rejects the tool `strict`
 * field and enforces Anthropic signatures on replay.
 */
export function isBedrockAnthropicRoute(baseUrl?: string): boolean {
	return isBedrockRouteUrl(baseUrl, "anthropic");
}

/**
 * Azure AI Inference / Foundry Anthropic route
 * (`<resource>.inference.ai.azure.com`, `<resource>.services.ai.azure.com`).
 * Fronts Claude behind Azure identity and enforces Anthropic signatures on
 * replay; it also rejects the top-level `strict` tool field.
 */
export function isAzureAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && AZURE_ANTHROPIC_URL_MARKER.test(baseUrl);
}

/**
 * Known non-official URLs that enforce Anthropic thinking signatures on replay
 * (GitHub Copilot, ZenMux, Cloudflare AI Gateway `/anthropic`, Google Vertex
 * `publishers/anthropic`, AWS Bedrock, Azure Foundry).
 *
 * Runtime routing calls this with the effective URL because a model's resolved
 * compat can be stale after Foundry or a provider base-URL override reroutes it.
 */
export function isAnthropicSigningProxyUrl(baseUrl?: string): boolean {
	return (
		hostMatchesUrl(baseUrl, "githubCopilot") ||
		hostMatchesUrl(baseUrl, "zenmux") ||
		(baseUrl !== undefined &&
			(CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER.test(baseUrl) ||
				VERTEX_ANTHROPIC_URL_MARKER.test(baseUrl) ||
				BEDROCK_ANTHROPIC_URL_MARKER.test(baseUrl))) ||
		isBedrockAnthropicRoute(baseUrl) ||
		isAzureAnthropicRoute(baseUrl)
	);
}
