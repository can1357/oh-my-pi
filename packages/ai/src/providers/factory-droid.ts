import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	FACTORY_DROID_ANTHROPIC_BASE_URL,
	FACTORY_DROID_CLIENT_VERSION,
	FACTORY_DROID_COMPLETIONS_BASE_URL,
	FACTORY_DROID_GOOGLE_BASE_URL,
	FACTORY_DROID_MODEL_META,
	FACTORY_DROID_RESPONSES_BASE_URL,
	type FactoryDroidModelInput,
} from "@oh-my-pi/pi-catalog/discovery";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as AIError from "../error";
import type { Context, Model, ModelSpec, ServiceTier, StreamFunction, StreamOptions, ToolChoice } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamFactoryDroidGemini } from "./factory-droid/gemini";
import { streamAnthropic, streamOpenAICompletions, streamOpenAIResponses } from "./register-builtins";

/**
 * Factory Droid subscription provider — sidecar-free transport over Factory's
 * LLM proxy. The proxy multiplexes four wire protocols by model family:
 *
 * | family | path | models |
 * |---|---|---|
 * | `openai-completions` | `/api/llm/o/v1/chat/completions` | Droid Core (Kimi, GLM, DeepSeek, Inkling, Nemotron) + Grok |
 * | `openai-responses` | `/api/llm/o/v1/responses` | GPT-5.x |
 * | `anthropic-messages` | `/api/llm/a/v1/messages` | Claude + MiniMax |
 * | `google-generate` | `/api/llm/g/v1/generate` | Gemini (native generateContent SSE) |
 *
 * Cross-cutting contract on every path:
 *
 * - Auth: `Authorization: Bearer <workos access token>` from `/login
 *   factory-droid` (WorkOS device code, refreshed through the auth store).
 *   Factory API keys are control-plane only and get 403 here.
 * - Identity headers: `factory-cli/<version>` user agent, `X-Client-Version`,
 *   `X-Factory-Client: cli`, `X-Factory-Org-Id`, the X-Stainless runtime
 *   fingerprint, and v4-shaped `x-session-id` /
 *   `x-assistant-message-id` used for usage attribution.
 * - System-prompt gate: the proxy rejects (403) requests whose system prompt
 *   does not start with the exact Droid identity sentence
 *   {@link DROID_SYSTEM_PREFIX}. The rest of the prompt is untouched.
 * - `x-api-provider` selects the upstream router from the model's registry
 *   rotation list (first entry pinned).
 */

/** Droid identity sentence; the proxy rejects requests whose system prompt lacks this prefix. */
export const DROID_SYSTEM_PREFIX = "You are Droid, an AI software engineering agent built by Factory.";

export interface FactoryDroidOptions extends StreamOptions {
	/** Accepted for interface compatibility; the direct transport does not spawn processes. */
	cwd?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

/** Per-upstream thinking budgets by effort level. */
const ANTHROPIC_THINKING_BUDGETS: Readonly<Record<string, number>> = {
	low: 4096,
	medium: 12288,
	high: 24576,
	xhigh: 24576,
	max: 0,
};

/** Registry lookup; falls back to a completions default so custom ids still stream. */
function resolveModelMeta(model: Model<"factory-droid-agent">): FactoryDroidModelInput | undefined {
	return FACTORY_DROID_MODEL_META[model.requestModelId ?? model.id];
}

/**
 * Registry comes from the static table, never from `model.headers`:
 * the shared model cache intentionally strips headers from persisted specs,
 * so header-carried routing would silently vanish on cached loads. The
 * account's live-resolved upstream rotation rides the spec itself
 * (`factoryDroidApiProviders`), which the cache preserves.
 */
function resolveUpstream(model: Model<"factory-droid-agent">, meta: FactoryDroidModelInput | undefined): string {
	return model.factoryDroidApiProviders?.[0] ?? meta?.apiProviders[0] ?? "fireworks";
}

/** Identity headers shared by the OpenAI-SDK paths (completions + responses). */
function buildOpenAiHeaders(input: {
	upstream: string;
	sessionUuid: string;
	requestId: string;
	orgId?: string;
	/**
	 * The chat-completions route accepts droid's full X-Stainless SDK
	 * fingerprint; the Responses route 431s once total header size crosses its
	 * WAF budget (verified live), so it goes without the telemetry set.
	 */
	stainless?: boolean;
}): Record<string, string> {
	return {
		Accept: "application/json",
		"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
		"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
		"X-Factory-Client": "cli",
		...(input.stainless === false
			? {}
			: {
					"X-Stainless-Lang": "js",
					"X-Stainless-Package-Version": "6.25.0",
					"X-Stainless-Runtime": "node",
					"X-Stainless-Runtime-Version": process.version,
					"X-Stainless-Arch": process.arch,
					"X-Stainless-OS":
						process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
					"X-Stainless-Retry-Count": "0",
				}),
		"x-api-provider": input.upstream,
		"x-session-id": input.sessionUuid,
		"x-assistant-message-id": input.requestId,
		...(input.orgId ? { "X-Factory-Org-Id": input.orgId } : {}),
	};
}

/**
 * Reasoning body extras for the completions path, mirroring the CLI's
 * `buildRequestParams`: Fireworks takes `reasoning_effort` plus
 * `reasoning_history: "preserved"` while thinking; Baseten takes
 * `chat_template_args.enable_thinking` (forced-on family) and never receives
 * `reasoning_effort`.
 */
function buildCompletionsReasoningBody(
	upstream: string,
	options: FactoryDroidOptions | undefined,
): Record<string, unknown> | undefined {
	if (options?.disableReasoning) {
		return upstream === "baseten" ? { chat_template_args: { enable_thinking: false } } : { reasoning_effort: "none" };
	}
	if (options?.reasoning !== undefined) {
		if (upstream === "baseten") return { chat_template_args: { enable_thinking: true } };
		return { reasoning_history: "preserved" };
	}
	return undefined;
}

/** Decodes the WorkOS JWT payload without verifying the signature (server verifies). */
function factoryDroidTokenClaims(accessToken: string): Record<string, unknown> | null {
	const [, payloadSegment] = accessToken.split(".");
	if (!payloadSegment) return null;
	try {
		const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
		return payload != null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Factory's external org id (`X-Factory-Org-Id` header value) from a token's claims. */
function factoryDroidOrgIdFromToken(accessToken: string): string | undefined {
	const external = factoryDroidTokenClaims(accessToken)?.external_org_id;
	return typeof external === "string" && external.length > 0 ? external : undefined;
}

export const streamFactoryDroid: StreamFunction<"factory-droid-agent"> = (
	model: Model<"factory-droid-agent">,
	context: Context,
	options?: FactoryDroidOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			// Sole credential path: the OMP-stored WorkOS session from `/login
			// factory-droid`, resolved and refreshed by the harness and passed as
			// apiKey. The kNoAuth sentinel ("N/A") means no stored credential.
			const harnessToken = options?.apiKey?.trim();
			if (!harnessToken || harnessToken === "N/A") {
				throw new AIError.ConfigurationError(
					"No Factory Droid credentials found. Run `/login factory-droid` (WorkOS device code).",
				);
			}
			const auth = { accessToken: harnessToken, orgId: undefined };

			const meta = resolveModelMeta(model);
			const upstream = resolveUpstream(model, meta);
			// The proxy expects v4-shaped ids; the OMP session id is a UUIDv7-style
			// timestamp id, so map it through a deterministic v4 shape that stays
			// stable per session.
			const requestId = crypto.randomUUID();
			const sessionUuid = options?.sessionId ? deterministicUuid(options.sessionId) : requestId;
			const orgId = auth.orgId ?? factoryDroidOrgIdFromToken(auth.accessToken);

			const proxiedContext: Context = {
				...context,
				systemPrompt: [DROID_SYSTEM_PREFIX, ...(context.systemPrompt ?? [])],
			};

			const wire = meta?.wire ?? "openai-completions";
			const baseOptions = {
				apiKey: auth.accessToken,
				signal: options?.signal,
				fetch: options?.fetch,
			};

			let innerStream: AssistantMessageEventStream;
			if (wire === "google-generate") {
				innerStream = streamFactoryDroidGemini(model, proxiedContext, {
					...baseOptions,
					baseUrl: FACTORY_DROID_GOOGLE_BASE_URL,
					geminiMedium: meta?.geminiMedium,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					temperature: options?.temperature,
					reasoning: options?.reasoning,
					disableReasoning: options?.disableReasoning,
					headers: {
						"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
						"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
						"X-Factory-Client": "cli",
						"x-api-provider": upstream,
						"x-session-id": sessionUuid,
						"x-assistant-message-id": requestId,
						...(orgId ? { "X-Factory-Org-Id": orgId } : {}),
						...options?.headers,
					},
				});
			} else if (wire === "anthropic-messages") {
				const anthropicModel = buildModel({
					...model,
					api: "anthropic-messages",
					baseUrl: FACTORY_DROID_ANTHROPIC_BASE_URL,
				} as ModelSpec<"anthropic-messages">);
				const effort = options?.disableReasoning ? undefined : options?.reasoning;
				const thinkingStyle = meta?.thinkingStyle ?? "adaptive";
				const adaptive = thinkingStyle === "adaptive" || thinkingStyle === "adaptive-summarized";
				const budget = effort !== undefined ? (ANTHROPIC_THINKING_BUDGETS[effort] ?? 24_576) : undefined;
				innerStream = streamAnthropic(anthropicModel, proxiedContext, {
					...baseOptions,
					// NOT isOAuth: the OAuth branch would cloak the request in Claude
					// Code identity (billing header as system[0], cowork betas, CC user
					// agent) and trip the proxy's Droid-prefix gate. The non-official-URL
					// branch already sends `Authorization: Bearer <apiKey>` plus our
					// caller headers — exactly droid's shape. The Anthropic SDK contract
					// still wants an x-api-key, which droid fills with a placeholder.
					isOAuth: false,
					thinkingEnabled: options?.disableReasoning !== true,
					...(adaptive
						? { effort: (effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" }
						: { thinkingBudgetTokens: budget }),
					thinkingDisplay: thinkingStyle === "adaptive-summarized" ? "summarized" : undefined,
					interleavedThinking: thinkingStyle === "budget-interleaved",
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					temperature: options?.temperature,
					toolChoice: options?.toolChoice as "auto" | "any" | "none" | { type: "tool"; name: string } | undefined,
					sessionId: sessionUuid,
					headers: {
						"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
						"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
						"X-Factory-Client": "cli",
						"X-Stainless-Lang": "js",
						"X-Stainless-Package-Version": "0.70.1",
						"X-Stainless-Runtime": "node",
						"X-Stainless-Runtime-Version": process.version,
						"X-Stainless-Arch": process.arch,
						"X-Stainless-OS":
							process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
						"X-Stainless-Retry-Count": "0",
						"x-api-key": "placeholder",
						"x-api-provider": upstream,
						"x-session-id": sessionUuid,
						"x-assistant-message-id": requestId,
						...(orgId ? { "X-Factory-Org-Id": orgId } : {}),
						...options?.headers,
					},
				});
			} else if (wire === "openai-responses") {
				const responsesModel = buildModel({
					...model,
					api: "openai-responses",
					baseUrl: FACTORY_DROID_RESPONSES_BASE_URL,
				} as ModelSpec<"openai-responses">);
				const cfg = meta?.responsesConfig;
				// dXT: the proxy's Responses surface wants "xhigh", never "max".
				const effort = options?.disableReasoning
					? undefined
					: options?.reasoning === "max"
						? "xhigh"
						: options?.reasoning;
				innerStream = streamOpenAIResponses(responsesModel, proxiedContext, {
					...baseOptions,
					reasoning: effort as "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
					reasoningSummary: effort ? "auto" : undefined,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					temperature: options?.temperature,
					toolChoice: options?.toolChoice,
					sessionId: sessionUuid,
					extraBody: {
						// HTTP-vs-WS translations (verified live): droid's WebSocket
						// surface accepts top-level `verbosity` and the legacy "900"
						// retention; the HTTPS Responses route rejects both — verbosity
						// moved under `text`, and these models require "24h" caching.
						prompt_cache_key: sessionUuid,
						// Only extendedCache models (Vx config) carry retention;
						// the proxy requires "24h" for them and rejects the field
						// entirely for lighter configs like grok's.
						...(cfg?.extendedCache ? { prompt_cache_retention: "24h" } : {}),
						parallel_tool_calls: cfg?.parallelToolCalls ?? true,
						...(cfg?.serviceTier ? { service_tier: cfg.serviceTier } : {}),
						...(cfg?.safetyId ? { safety_identifier: orgId ?? sessionUuid } : {}),
					},
					headers: {
						...buildOpenAiHeaders({ upstream, sessionUuid, requestId, orgId, stainless: false }),
						...options?.headers,
					},
				});
			} else {
				const extraBody = buildCompletionsReasoningBody(upstream, options);
				const openaiModel = buildModel({
					...model,
					api: "openai-completions",
					baseUrl: FACTORY_DROID_COMPLETIONS_BASE_URL,
					compat: {
						// The proxy's upstreams speak `max_tokens` (not the OpenAI-era
						// `max_completion_tokens`) and have no `store` field.
						maxTokensField: "max_tokens",
						supportsStore: false,
						...(meta?.toolMessageIncludesName ? { requiresToolResultName: true } : {}),
						...(model.compatConfig ?? {}),
						...(extraBody ? { extraBody } : {}),
					},
				} as ModelSpec<"openai-completions">);
				innerStream = streamOpenAICompletions(openaiModel, proxiedContext, {
					...baseOptions,
					temperature: options?.temperature ?? 1,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					// Baseten reasoning rides chat_template_args only; the generic
					// reasoning_effort passthrough would add a field droid never sends.
					reasoning: upstream === "baseten" ? undefined : options?.reasoning,
					disableReasoning: upstream === "baseten" ? undefined : options?.disableReasoning,
					toolChoice: options?.toolChoice,
					sessionId: sessionUuid,
					headers: {
						...buildOpenAiHeaders({ upstream, sessionUuid, requestId, orgId }),
						...options?.headers,
					},
				});
			}

			for await (const event of innerStream) {
				stream.push(event);
			}
		} catch (error) {
			stream.push({ type: "error", reason: "error", error: createProviderErrorMessage(model, error) });
			stream.end();
		}
	})();

	return stream;
};
