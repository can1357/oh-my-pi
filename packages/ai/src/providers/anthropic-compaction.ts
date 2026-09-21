import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Model } from "../types";
import type { AnthropicMessagesClientLike } from "./anthropic-client";
import { normalizeAnthropicBaseUrl, resolveDirectAnthropicBaseUrl } from "./anthropic-state";

function isCompactionCapableModel(model: Model<"anthropic-messages">): boolean {
	return (
		model.compat.supportsServerCompaction === true &&
		model.compat.supportsContextManagement !== false &&
		model.remoteCompaction?.enabled !== false
	);
}

/** Whether the model's effective first-party route is the official Anthropic API. */
export function resolvesToOfficialAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	const baseUrl =
		model.provider === "anthropic" ? resolveDirectAnthropicBaseUrl(model) : normalizeAnthropicBaseUrl(model.baseUrl);
	return isOfficialAnthropicApiUrl(baseUrl);
}

/** Whether the model and effective endpoint support Anthropic native compaction. */
export function supportsAnthropicCompaction(model: Model<"anthropic-messages">, effectiveBaseUrl?: string): boolean {
	if (!isCompactionCapableModel(model)) return false;
	if (model.remoteCompaction?.enabled === true) return true;
	if (
		model.transport === "pi-native" &&
		model.compat.firstPartyProvider === true &&
		(effectiveBaseUrl === undefined || effectiveBaseUrl === normalizeAnthropicBaseUrl(model.baseUrl))
	) {
		return true;
	}
	return (
		model.compat.firstPartyProvider === true &&
		(effectiveBaseUrl === undefined
			? resolvesToOfficialAnthropicEndpoint(model)
			: isOfficialAnthropicApiUrl(effectiveBaseUrl))
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
