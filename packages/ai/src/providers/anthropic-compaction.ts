import { isBedrockAnthropicRoute, isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Model } from "../types";
import type { AnthropicMessagesClientLike } from "./anthropic-client";
import { normalizeAnthropicBaseUrl, resolveDirectAnthropicBaseUrl } from "./anthropic-state";

function isCompactionCapableModel(model: Model<"anthropic-messages">): boolean {
	return model.compat.supportsServerCompaction === true && model.remoteCompaction?.enabled !== false;
}

/** Supported Anthropic Messages deployments; gateways require an explicit opt-in. */
function isSupportedCompactionEndpoint(baseUrl: string | undefined): boolean {
	if (isOfficialAnthropicApiUrl(baseUrl)) return true;
	if (!baseUrl) return false;
	try {
		const { hostname, pathname } = new URL(baseUrl);
		return (
			/^(?:[a-z0-9-]+[-.])?aiplatform\.googleapis\.com$/.test(hostname) ||
			(hostname.endsWith(".services.ai.azure.com") &&
				(pathname === "/" || pathname === "/anthropic" || pathname.startsWith("/anthropic/"))) ||
			/^aws-external-anthropic\.[a-z0-9-]+\.api\.aws$/.test(hostname)
		);
	} catch {
		return false;
	}
}

/** Whether the model's effective first-party route is the official Anthropic API. */
export function resolvesToOfficialAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	const baseUrl =
		model.provider === "anthropic" ? resolveDirectAnthropicBaseUrl(model) : normalizeAnthropicBaseUrl(model.baseUrl);
	return isOfficialAnthropicApiUrl(baseUrl);
}

/** Whether model policy and the effective deployment support on-demand compaction. */
export function supportsAnthropicCompaction(model: Model<"anthropic-messages">, effectiveBaseUrl?: string): boolean {
	if (!isCompactionCapableModel(model)) return false;
	if (
		model.transport === "pi-native" &&
		model.compat.firstPartyProvider === true &&
		(effectiveBaseUrl === undefined || effectiveBaseUrl === normalizeAnthropicBaseUrl(model.baseUrl))
	) {
		return true;
	}
	const route =
		effectiveBaseUrl ??
		(model.provider === "anthropic"
			? resolveDirectAnthropicBaseUrl(model)
			: normalizeAnthropicBaseUrl(model.baseUrl));
	// Bedrock's own `/anthropic` routes are AWS endpoints, not gateways.
	if (isBedrockAnthropicRoute(route)) return true;
	return (
		isSupportedCompactionEndpoint(route) &&
		(model.compat.firstPartyProvider === true ||
			model.provider === "google-vertex" ||
			model.remoteCompaction?.enabled === true)
	);
}

/** Read a caller-owned client's endpoint for request and compaction routing. */
export function injectedClientBaseUrl(client: AnthropicMessagesClientLike): string | undefined {
	const candidate = "baseURL" in client ? client.baseURL : undefined;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Whether a caller-owned Anthropic client targets a compaction-capable endpoint. */
export function supportsAnthropicCompactionOnClient(
	model: Model<"anthropic-messages">,
	client: AnthropicMessagesClientLike,
): boolean {
	const baseUrl = injectedClientBaseUrl(client);
	if (baseUrl !== undefined) return supportsAnthropicCompaction(model, baseUrl);
	return isCompactionCapableModel(model) && model.remoteCompaction?.enabled === true;
}
