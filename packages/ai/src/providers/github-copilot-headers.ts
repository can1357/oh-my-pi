import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_CHAT_INTEGRATION_ID,
	getGitHubCopilotBaseUrl,
	normalizeCopilotIntegrationId,
	parseGitHubCopilotApiKey,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
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
 * Working `Copilot-Integration-Id` learned per credential.
 *
 * Business orgs that reject the chat-surface default pay one extra round-trip
 * per stream until the working shape is known (issue #11669, follow-up). The
 * cache remembers the identity that last cleared the identity gate so later
 * streams start there instead of replaying the denial. Enterprise credentials
 * already default to the CLI identity, so they only consult the cache when a
 * prior reverse retry learned chat.
 *
 * Process-local only: a stale entry costs at most one reverse retry, which
 * relearns the working shape. Explicit `COPILOT_INTEGRATION_ID` and caller
 * headers bypass the cache entirely — a pin is never second-guessed.
 */
const COPILOT_WORKING_INTEGRATION_CACHE_LIMIT = 50;
const copilotWorkingIntegrationCache = new LRUCache<string, string>({ max: COPILOT_WORKING_INTEGRATION_CACHE_LIMIT });

/**
 * Normalize the effective request host for cache isolation. Custom
 * `model.baseUrl` values survive `resolveGitHubCopilotBaseUrl`, so two proxies
 * fronting different org policies must not share a learned identity even when
 * the token envelope matches.
 */
function normalizeCopilotCacheBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
	} catch {
		return trimmed.toLowerCase();
	}
}

/**
 * Stable cache key for a raw Copilot API key envelope on one effective host.
 * Hashes the bearer with `Bun.hash` (repo-approved hashing API; same
 * credential-scoped pattern as the GitLab Duo and Codex account keys) so token
 * bytes never sit in the map as keys; enterprise/business routing inputs and
 * the normalized effective base URL participate so the same token on two hosts
 * does not share an entry.
 */
export function getCopilotIntegrationCacheKey(apiKeyRaw: string | undefined, baseUrl?: string): string | undefined {
	if (!apiKeyRaw) return undefined;
	const trimmed = apiKeyRaw.trim();
	if (!trimmed) return undefined;
	const parsed = parseGitHubCopilotApiKey(trimmed);
	if (!parsed.accessToken) return undefined;
	const fingerprint = Bun.hash(parsed.accessToken).toString(36);
	return `${parsed.enterpriseUrl ?? ""}\0${parsed.apiEndpoint ?? ""}\0${normalizeCopilotCacheBaseUrl(baseUrl)}\0${fingerprint}`;
}

/** Cached working identity for a cache key, if one was learned. */
export function getCachedCopilotIntegrationId(cacheKey: string | undefined): string | undefined {
	if (!cacheKey) return undefined;
	return normalizeCopilotIntegrationId(copilotWorkingIntegrationCache.get(cacheKey));
}

/**
 * Remember the identity that cleared the identity gate for a credential.
 * Every store refreshes recency, so hot credentials survive eviction.
 */
export function rememberCopilotWorkingIntegrationId(cacheKey: string | undefined, integrationId: unknown): void {
	const normalized = normalizeCopilotIntegrationId(integrationId);
	if (!cacheKey || !normalized) return;
	copilotWorkingIntegrationCache.set(cacheKey, normalized);
}

/** Clear one cached identity, or the whole cache when no key is given. */
export function clearCopilotIntegrationCache(cacheKey?: string): void {
	if (cacheKey === undefined) copilotWorkingIntegrationCache.clear();
	else copilotWorkingIntegrationCache.delete(cacheKey);
}

/**
 * True when a response is a client-identity denial: HTTP 403, or HTTP 400
 * carrying `code: "model_not_supported"`. Reads a clone so the caller's body
 * stays intact. Unreadable 400s are not denials.
 */
async function isCopilotIdentityDenied(response: Response): Promise<boolean> {
	if (response.status === 403) return true;
	if (response.status !== 400) return false;
	try {
		const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
		return body?.error?.code === "model_not_supported";
	} catch {
		return false;
	}
}

/**
 * Reissue Copilot client-identity denials once with the other surface.
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
 *
 * When `cacheKey` is set, a 2xx retry remembers its identity via
 * `rememberCopilotWorkingIntegrationId`, so later streams for the same
 * credential start at the working shape. A cached CLI start that is itself
 * denied (stale after an org-policy flip) retries once as chat and relearns.
 * Only a 2xx retry proves its identity — 401s deny every identity equally and
 * 408/429/5xx are transport-retryable (the transport resends the *original*
 * headers), so those must never be recorded as working. Any non-2xx retry
 * clears the entry instead: the next stream rediscovers rather than pinning a
 * shape that just failed.
 */
export function wrapFetchForCopilotFallback(
	base: FetchImpl | undefined,
	enabled: boolean,
	integrationId?: unknown,
	cacheKey?: string,
	/**
	 * Build-time cache provenance: the exact cached value the outgoing headers
	 * were built from. `undefined` rereads the cache at dispatch (direct
	 * callers); `null` pins "cache was empty at build" so a sibling learning
	 * mid-flight cannot change this request's retry decision.
	 */
	cacheSnapshot?: string | null,
): FetchImpl {
	const inner = base ?? fetch;
	if (!enabled) return inner;
	const cliIntegrationId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
	return async (input, init) => {
		// Provenance fallback for direct callers: without a build-time value,
		// snapshot at dispatch — still before any await in this invocation, so
		// a concurrent stream cannot interleave between the snapshot and use.
		const cachedBeforeRequest =
			cacheSnapshot === undefined
				? getCachedCopilotIntegrationId(cacheKey)
				: normalizeCopilotIntegrationId(cacheSnapshot);
		const response = await inner(input, init);
		if (response.status !== 403 && response.status !== 400) return response;
		if (input instanceof Request) return response;
		if (normalizeCopilotIntegrationId(integrationId) !== undefined) return response;
		const outgoing = new Headers(init?.headers);
		const outgoingId = outgoing.get("Copilot-Integration-Id");
		if (outgoingId === COPILOT_CHAT_INTEGRATION_ID) {
			if (await isCopilotIdentityDenied(response)) {
				try {
					await response.arrayBuffer();
				} catch {}
				logger.warn(
					`GitHub Copilot chat identity denied (HTTP ${response.status}); retrying once as the Copilot CLI`,
				);
				const retryHeaders = new Headers(outgoing);
				retryHeaders.set("Copilot-Integration-Id", cliIntegrationId);
				const retry = await inner(input, { ...init, headers: retryHeaders });
				if (cacheKey) {
					if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, cliIntegrationId);
					else clearCopilotIntegrationCache(cacheKey);
				}
				return retry;
			}
			return response;
		}
		if (outgoingId === cliIntegrationId && cacheKey) {
			if (cachedBeforeRequest !== cliIntegrationId) return response;
			if (await isCopilotIdentityDenied(response)) {
				try {
					await response.arrayBuffer();
				} catch {}
				logger.warn(
					`GitHub Copilot CLI identity denied (HTTP ${response.status}); retrying once as ${COPILOT_CHAT_INTEGRATION_ID}`,
				);
				const retryHeaders = new Headers(outgoing);
				retryHeaders.set("Copilot-Integration-Id", COPILOT_CHAT_INTEGRATION_ID);
				const retry = await inner(input, { ...init, headers: retryHeaders });
				if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, COPILOT_CHAT_INTEGRATION_ID);
				else clearCopilotIntegrationCache(cacheKey);
				return retry;
			}
			return response;
		}
		return response;
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
	/** Learned working identity for this credential; explicit still wins, then this, then the defaults. */
	cachedIntegrationId?: unknown;
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
		normalizeCopilotIntegrationId(params.cachedIntegrationId) ??
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
