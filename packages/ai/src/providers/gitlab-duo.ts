import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getGitLabDuoModels, resolveGitLabDuoModelIdentity } from "@oh-my-pi/pi-catalog/provider-models";
import * as AIError from "../error";
import { ANTHROPIC_THINKING, mapAnthropicToolChoice } from "../stream";
import type { Api, Context, FetchImpl, Model, ModelSpec, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";
import { streamAnthropic, streamOpenAICompletions, streamOpenAIResponses } from "./register-builtins";

const GITLAB_COM_URL = "https://gitlab.com";
const AI_GATEWAY_URL = "https://cloud.gitlab.com";
const ANTHROPIC_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/anthropic/`;
const OPENAI_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/openai/v1`;
const DIRECT_ACCESS_TTL_MS = 25 * 60 * 1000;

export { getGitLabDuoModels };

interface DirectAccessToken {
	token: string;
	headers: Record<string, string>;
	expiresAt: number;
}

const directAccessCache = new Map<string, DirectAccessToken>();

async function getDirectAccessToken(
	gitlabAccessToken: string,
	fetchImpl: FetchImpl = fetch,
): Promise<DirectAccessToken> {
	const cached = directAccessCache.get(gitlabAccessToken);
	if (cached && cached.expiresAt > Date.now()) {
		return cached;
	}

	const response = await fetchImpl(`${GITLAB_COM_URL}/api/v4/ai/third_party_agents/direct_access`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${gitlabAccessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			feature_flags: { DuoAgentPlatformNext: true },
		}),
	});

	if (!response.ok) {
		const detail = await response.text();
		if (response.status === 403) {
			throw new AIError.ProviderResponseError(
				`GitLab Duo access denied. Ensure Duo is enabled for this account. ${detail}`,
				{ provider: "gitlab-duo", kind: "runtime" },
			);
		}
		throw new AIError.GitLabDuoApiError(
			`Failed to get GitLab Duo direct access token: ${response.status} ${detail}`,
			response.status,
		);
	}

	const payload = (await response.json()) as { token?: string; headers?: Record<string, string> };
	if (!payload.token || typeof payload.token !== "string") {
		throw new AIError.ProviderResponseError("GitLab Duo direct access response missing token", {
			provider: "gitlab-duo",
			kind: "envelope",
		});
	}
	if (!payload.headers || typeof payload.headers !== "object") {
		throw new AIError.ProviderResponseError("GitLab Duo direct access response missing headers", {
			provider: "gitlab-duo",
			kind: "envelope",
		});
	}

	const token: DirectAccessToken = {
		token: payload.token,
		headers: payload.headers,
		expiresAt: Date.now() + DIRECT_ACCESS_TTL_MS,
	};
	directAccessCache.set(gitlabAccessToken, token);
	return token;
}

export function clearGitLabDuoDirectAccessCache(): void {
	directAccessCache.clear();
}

export function isGitLabDuoModel(model: Model<Api>): boolean {
	return model.provider === "gitlab-duo";
}

export function streamGitLabDuo(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
			if (!apiKey || !options) {
				throw new AIError.MissingApiKeyError(
					undefined,
					"Missing GitLab access token. Run /login gitlab-duo or set GITLAB_TOKEN.",
				);
			}

			const identity = resolveGitLabDuoModelIdentity(model.id);
			if (!identity) {
				throw new AIError.ConfigurationError(`Unsupported GitLab Duo model: ${model.id}`);
			}
			const route = apiRouteFor("gitlab-duo", model.id);
			if (
				route?.api !== "anthropic-messages" &&
				route?.api !== "openai-responses" &&
				route?.api !== "openai-completions"
			) {
				throw new AIError.ConfigurationError(`Missing GitLab Duo API route for model: ${model.id}`);
			}

			const directAccess = await getDirectAccessToken(apiKey, options.fetch);
			const headers = {
				...directAccess.headers,
				...options.headers,
			};

			const reasoningEffort = options.reasoning;

			const inner =
				route.api === "anthropic-messages"
					? streamAnthropic(
							buildModel({
								...model,
								id: identity.upstreamModelId,
								api: "anthropic-messages",
								baseUrl: ANTHROPIC_PROXY_URL,
								compat: model.compatConfig,
							} as ModelSpec<"anthropic-messages">),
							context,
							{
								apiKey: directAccess.token,
								isOAuth: true,
								temperature: options.temperature,
								topP: options.topP,
								topK: options.topK,
								minP: options.minP,
								presencePenalty: options.presencePenalty,
								repetitionPenalty: options.repetitionPenalty,
								maxTokens: options.maxTokens ?? model.maxTokens ?? undefined,
								signal: options.signal,
								cacheRetention: options.cacheRetention,
								headers,
								maxRetryDelayMs: options.maxRetryDelayMs,
								metadata: options.metadata,
								sessionId: options.sessionId,
								promptCacheKey: options.promptCacheKey,
								providerSessionState: options.providerSessionState,
								onPayload: options.onPayload,
								onResponse: options.onResponse,
								onSseEvent: options.onSseEvent,
								fetch: options.fetch,
								thinkingEnabled: Boolean(reasoningEffort) && model.reasoning,
								thinkingBudgetTokens: reasoningEffort
									? (options.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
									: undefined,
								reasoning: reasoningEffort,
								toolChoice: mapAnthropicToolChoice(options.toolChoice),
							},
						)
					: route.api === "openai-responses"
						? streamOpenAIResponses(
								buildModel({
									...model,
									id: identity.upstreamModelId,
									api: "openai-responses",
									baseUrl: OPENAI_PROXY_URL,
									compat: model.compatConfig,
								} as ModelSpec<"openai-responses">),
								context,
								{
									apiKey: directAccess.token,
									temperature: options.temperature,
									topP: options.topP,
									topK: options.topK,
									minP: options.minP,
									presencePenalty: options.presencePenalty,
									repetitionPenalty: options.repetitionPenalty,
									maxTokens: options.maxTokens ?? model.maxTokens ?? undefined,
									signal: options.signal,
									cacheRetention: options.cacheRetention,
									headers,
									maxRetryDelayMs: options.maxRetryDelayMs,
									metadata: options.metadata,
									sessionId: options.sessionId,
									promptCacheKey: options.promptCacheKey,
									statefulResponses: options.statefulResponses,
									providerSessionState: options.providerSessionState,
									onPayload: options.onPayload,
									onResponse: options.onResponse,
									onSseEvent: options.onSseEvent,
									fetch: options.fetch,
									reasoning: reasoningEffort,
									toolChoice: options.toolChoice,
								} satisfies OpenAIResponsesOptions,
							)
						: streamOpenAICompletions(
								buildModel({
									...model,
									id: identity.upstreamModelId,
									api: "openai-completions",
									baseUrl: OPENAI_PROXY_URL,
									compat: model.compatConfig,
								} as ModelSpec<"openai-completions">),
								context,
								{
									apiKey: directAccess.token,
									temperature: options.temperature,
									topP: options.topP,
									topK: options.topK,
									minP: options.minP,
									presencePenalty: options.presencePenalty,
									repetitionPenalty: options.repetitionPenalty,
									maxTokens: options.maxTokens ?? model.maxTokens ?? undefined,
									signal: options.signal,
									cacheRetention: options.cacheRetention,
									headers,
									maxRetryDelayMs: options.maxRetryDelayMs,
									metadata: options.metadata,
									sessionId: options.sessionId,
									promptCacheKey: options.promptCacheKey,
									providerSessionState: options.providerSessionState,
									onPayload: options.onPayload,
									onResponse: options.onResponse,
									onSseEvent: options.onSseEvent,
									fetch: options.fetch,
									reasoning: reasoningEffort,
									toolChoice: options.toolChoice,
								} satisfies OpenAICompletionsOptions,
							);

			for await (const event of inner) {
				stream.push(event);
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
