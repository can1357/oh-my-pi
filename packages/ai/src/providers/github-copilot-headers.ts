import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	getGitHubCopilotBaseUrl,
	parseGitHubCopilotApiKey,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import type { Message } from "../types";
/**
 * Infer whether the current request to Copilot is user-initiated or agent-initiated.
 * Accepts `unknown[]` because providers may pass pre-converted message shapes.
 */
export type CopilotInitiator = "user" | "agent";
export type CopilotPremiumRequests = number;
export type CopilotDynamicHeaders = {
	headers: Record<string, string>;
	initiator: CopilotInitiator;
	premiumRequests: CopilotPremiumRequests;
};
export function resolveGitHubCopilotBaseUrl(
	baseUrl: string | undefined,
	apiKey: string | undefined,
): string | undefined {
	if (!apiKey) return baseUrl;
	const { enterpriseUrl, apiEndpoint } = parseGitHubCopilotApiKey(apiKey);
	if (apiEndpoint && (!baseUrl || baseUrl.includes("githubcopilot.com"))) return apiEndpoint;
	if (!enterpriseUrl) return baseUrl;
	if (baseUrl && !baseUrl.includes("githubcopilot.com")) return baseUrl;
	return getGitHubCopilotBaseUrl(enterpriseUrl);
}
export function inferCopilotInitiator(messages: unknown[]): CopilotInitiator {
	if (messages.length === 0) return "user";

	const last = messages[messages.length - 1] as Record<string, unknown>;
	const attribution = last.attribution;
	if (typeof attribution === "string") {
		const normalizedAttribution = attribution.trim().toLowerCase();
		if (normalizedAttribution === "user" || normalizedAttribution === "agent") {
			return normalizedAttribution;
		}
	}

	const role = last.role as string | undefined;
	if (!role) return "user";

	if (role !== "user") return "agent";

	// Check if last content block is a tool_result (Anthropic-converted shape)
	const content = last.content;
	if (Array.isArray(content) && content.length > 0) {
		const lastBlock = content[content.length - 1] as Record<string, unknown>;
		if (lastBlock.type === "tool_result") {
			return "agent";
		}
	}

	return "user";
}

/** Check whether any message in the conversation contains image content. */
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some(msg => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		return false;
	});
}

/**
 * Resolve an explicitly configured Copilot initiator header, if present.
 * Handles case-insensitive X-Initiator keys and returns the last valid value.
 */
export function getCopilotInitiatorOverride(headers: Record<string, string> | undefined): CopilotInitiator | undefined {
	if (!headers) return undefined;

	let override: CopilotInitiator | undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "x-initiator") continue;
		const normalized = value.trim().toLowerCase();
		if (normalized === "user" || normalized === "agent") {
			override = normalized;
		}
	}

	return override;
}

export type CopilotPlanTier = "free" | "paid";

function normalizeCopilotPlanTier(planTier: string | undefined): CopilotPlanTier {
	if (planTier === "paid") return "paid";
	return "free";
}
export function getCopilotPremiumMultiplier(premiumMultiplier: number | undefined, planTier?: string): number {
	const normalizedMultiplier = premiumMultiplier ?? 1;
	if (normalizeCopilotPlanTier(planTier) === "free" && normalizedMultiplier === 0) {
		return 1;
	}
	return normalizedMultiplier;
}

export function getCopilotPremiumRequests(params: {
	initiator: CopilotInitiator;
	premiumMultiplier?: number;
	planTier?: string;
}): CopilotPremiumRequests {
	if (params.initiator === "agent") return 0;
	return getCopilotPremiumMultiplier(params.premiumMultiplier, params.planTier);
}

/**
 * Build dynamic Copilot headers that vary per-request.
 * Static headers (User-Agent, Editor-Version, etc.) come from model.headers.
 */
export function buildCopilotDynamicHeaders(params: {
	messages: unknown[];
	hasImages: boolean;
	premiumMultiplier?: number;
	headers?: Record<string, string>;
	initiatorOverride?: CopilotInitiator;
	planTier?: string;
}): CopilotDynamicHeaders {
	const initiator =
		params.initiatorOverride ?? getCopilotInitiatorOverride(params.headers) ?? inferCopilotInitiator(params.messages);
	const headers: Record<string, string> = {
		...COPILOT_CAPI_IDENTITY_HEADERS,
		"X-Initiator": initiator,
		"X-Interaction-Type": `conversation-${initiator}`,
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return {
		headers,
		initiator,
		premiumRequests: getCopilotPremiumRequests({
			initiator,
			premiumMultiplier: params.premiumMultiplier,
			planTier: params.planTier,
		}),
	};
}
