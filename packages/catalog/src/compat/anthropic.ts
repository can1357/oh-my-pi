/**
 * Anthropic endpoint-shape predicates: which URLs are the official first-party
 * API, and which non-official hosts enforce Anthropic's thinking-signature
 * protocol on replay. Compat resolution (`./resolve`) and runtime routing in
 * pi-ai both consume these; URL matching is the one detection surface that
 * stays in code.
 */
import { hostMatchesUrl } from "../hosts";

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

const CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER = /gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i;
const VERTEX_ANTHROPIC_URL_MARKER = /aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i;
const BEDROCK_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i;
const AZURE_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i;

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
		isAzureAnthropicRoute(baseUrl)
	);
}
