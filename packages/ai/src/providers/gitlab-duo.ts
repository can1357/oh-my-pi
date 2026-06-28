import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
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

type GitLabProvider = "anthropic" | "openai";
type GitLabOpenAIApiType = "chat" | "responses";

export type GitLabModelMapping = {
	provider: GitLabProvider;
	model: string;
	openaiApiType?: GitLabOpenAIApiType;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

export const MODEL_MAPPINGS: Record<string, GitLabModelMapping> = {
	"duo-chat-opus-4-6": {
		provider: "anthropic",
		model: "claude-opus-4-6",
		name: "Duo Chat Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"duo-chat-sonnet-4-6": {
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		name: "Duo Chat Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"duo-chat-opus-4-5": {
		provider: "anthropic",
		model: "claude-opus-4-5-20251101",
		name: "Duo Chat Opus 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"duo-chat-sonnet-4-5": {
		provider: "anthropic",
		model: "claude-sonnet-4-5-20250929",
		name: "Duo Chat Sonnet 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"duo-chat-haiku-4-5": {
		provider: "anthropic",
		model: "claude-haiku-4-5-20251001",
		name: "Duo Chat Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"duo-chat-gpt-5-1": {
		provider: "openai",
		model: "gpt-5.1-2025-11-13",
		openaiApiType: "chat",
		name: "Duo Chat GPT-5.1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	"duo-chat-gpt-5-2": {
		provider: "openai",
		model: "gpt-5.2-2025-12-11",
		openaiApiType: "chat",
		name: "Duo Chat GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	"duo-chat-gpt-5-mini": {
		provider: "openai",
		model: "gpt-5-mini-2025-08-07",
		openaiApiType: "chat",
		name: "Duo Chat GPT-5 Mini",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	"duo-chat-gpt-5-codex": {
		provider: "openai",
		model: "gpt-5-codex",
		openaiApiType: "responses",
		name: "Duo Chat GPT-5 Codex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"duo-chat-gpt-5-2-codex": {
		provider: "openai",
		model: "gpt-5.2-codex",
		openaiApiType: "responses",
		name: "Duo Chat GPT-5.2 Codex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};

export function getModelMapping(modelId: string): GitLabModelMapping | undefined {
	const direct = MODEL_MAPPINGS[modelId];
	if (direct) return direct;

	// Support canonical model IDs (e.g. "gpt-5-codex", "claude-sonnet-4-5-20250929")
	// in addition to Duo aliases (e.g. "duo-chat-gpt-5-codex").
	return Object.values(MODEL_MAPPINGS).find(mapping => mapping.model === modelId);
}

export function getGitLabDuoModels(): Model<Api>[] {
	return Object.entries(MODEL_MAPPINGS).map(([id, mapping]) =>
		buildModel({
			id,
			name: mapping.name,
			api:
				mapping.provider === "anthropic"
					? "anthropic-messages"
					: mapping.openaiApiType === "responses"
						? "openai-responses"
						: "openai-completions",
			provider: "gitlab-duo",
			baseUrl: mapping.provider === "anthropic" ? ANTHROPIC_PROXY_URL : OPENAI_PROXY_URL,
			reasoning: mapping.reasoning,
			input: [...mapping.input],
			cost: { ...mapping.cost },
			contextWindow: mapping.contextWindow,
			maxTokens: mapping.maxTokens,
		} as ModelSpec<Api>),
	);
}

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

			const mapping = getModelMapping(model.id);
			if (!mapping) {
				throw new AIError.ConfigurationError(`Unsupported GitLab Duo model: ${model.id}`);
			}

			const directAccess = await getDirectAccessToken(apiKey, options.fetch);
			const headers = {
				...directAccess.headers,
				...options.headers,
			};

			const reasoningEffort = options.reasoning;

			const inner =
				mapping.provider === "anthropic"
					? streamAnthropic(
							buildModel({
								...model,
								id: mapping.model,
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
					: mapping.openaiApiType === "responses"
						? streamOpenAIResponses(
								buildModel({
									...model,
									id: mapping.model,
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
									id: mapping.model,
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
