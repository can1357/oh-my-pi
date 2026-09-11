import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_CHAT_INTEGRATION_ID,
	getGitHubCopilotBaseUrl,
	normalizeCopilotIntegrationId,
	parseGitHubCopilotApiKey,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl, Message } from "../types";
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

/**
 * Opt-in `Copilot-Integration-Id` override for chat and model-policy requests.
 * Reads `COPILOT_INTEGRATION_ID`; unset/invalid keeps the chat-surface default
 * (`COPILOT_CHAT_INTEGRATION_ID`). Model discovery keeps the CLI identity: it
 * unlocks enterprise/experimental models and listing models is not
 * policy-gated the way chat completions are (#11372).
 */
export function resolveCopilotIntegrationIdOverride(
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return normalizeCopilotIntegrationId(env.COPILOT_INTEGRATION_ID);
}

/**
 * Explicit caller-supplied `Copilot-Integration-Id`, matched case-insensitively.
 * Takes only caller layers (`extraHeaders` / `options.headers`) — never model
 * catalog headers — so a catalog default can never masquerade as a choice.
 */
function explicitCopilotIntegrationId(headers: Record<string, string> | undefined): unknown {
	if (!headers) return undefined;
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "copilot-integration-id") return headers[name];
	}
	return undefined;
}

/**
 * Effective identity before the chat-surface default: explicit value, then
 * request headers, then `COPILOT_INTEGRATION_ID`. Pure given its inputs, so
 * tests inject literals instead of mutating process state.
 */
export function resolveCopilotRequestIdentity(
	headers?: Record<string, string>,
	explicit?: unknown,
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return (
		normalizeCopilotIntegrationId(explicit) ??
		normalizeCopilotIntegrationId(explicitCopilotIntegrationId(headers)) ??
		resolveCopilotIntegrationIdOverride(env)
	);
}

/**
 * Reissue chat-surface Copilot denials once as the Copilot CLI.
 *
 * Chat is the default surface (`COPILOT_CHAT_INTEGRATION_ID`) because Business
 * organizations that gate premium models per client surface commonly allow
 * chat while blocking CLI/agentic clients (issue #11372). Other Business and
 * Enterprise orgs do the opposite and reject the chat identity — as an HTTP 403
 * or, on `api.business.githubcopilot.com`, an HTTP 400 `model_not_supported`
 * (issue #11669). Both denials retry once as the CLI. The retry fires only for
 * requests carrying the chat default and only when the caller resolved no
 * explicit identity — an explicit choice is never second-guessed. The denied
 * body is drained before reissuing, and the retry carries the CLI identity so
 * the guard passes it through: at most two requests, never a loop.
 */
export function wrapFetchForCopilotFallback(
	base: FetchImpl | undefined,
	enabled: boolean,
	integrationId?: unknown,
): FetchImpl {
	const inner = base ?? fetch;
	if (!enabled) return inner;
	return async (input, init) => {
		const response = await inner(input, init);
		if (response.status !== 403 && response.status !== 400) return response;
		if (input instanceof Request) return response;
		if (normalizeCopilotIntegrationId(integrationId) !== undefined) return response;
		const outgoing = new Headers(init?.headers);
		if (outgoing.get("Copilot-Integration-Id") !== COPILOT_CHAT_INTEGRATION_ID) {
			return response;
		}
		if (response.status === 400) {
			// A 400 is only the client-identity denial when its body carries
			// `code: "model_not_supported"`; read a clone so an unrelated 400
			// (which must not retry) reaches the caller with its body intact.
			let identityDenied = false;
			try {
				const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
				identityDenied = body?.error?.code === "model_not_supported";
			} catch {}
			if (!identityDenied) return response;
		}
		try {
			await response.arrayBuffer();
		} catch {}
		logger.warn(`GitHub Copilot chat identity denied (HTTP ${response.status}); retrying once as the Copilot CLI`);
		const retryHeaders = new Headers(outgoing);
		retryHeaders.set("Copilot-Integration-Id", COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"]);
		return inner(input, { ...init, headers: retryHeaders });
	};
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
	/** Enterprise login domain; Enterprise keeps the CLI identity that its private endpoint accepts. */
	enterpriseUrl?: string;
	/** Raw explicit identity; validated here, chat default when absent/invalid. */
	integrationId?: unknown;
}): CopilotDynamicHeaders {
	const initiator =
		params.initiatorOverride ?? getCopilotInitiatorOverride(params.headers) ?? inferCopilotInitiator(params.messages);
	const headers: Record<string, string> = {
		...COPILOT_CAPI_IDENTITY_HEADERS,
		"X-Initiator": initiator,
		"X-Interaction-Type": `conversation-${initiator}`,
	};
	headers["Copilot-Integration-Id"] =
		normalizeCopilotIntegrationId(params.integrationId) ??
		(params.enterpriseUrl ? COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"] : COPILOT_CHAT_INTEGRATION_ID);

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
