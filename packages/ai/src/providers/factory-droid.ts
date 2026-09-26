import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	FACTORY_DROID_ANTHROPIC_BASE_URL,
	FACTORY_DROID_CLIENT_VERSION,
	FACTORY_DROID_COMPLETIONS_BASE_URL,
	FACTORY_DROID_GOOGLE_BASE_URL,
	FACTORY_DROID_MODEL_META,
	FACTORY_DROID_RESPONSES_BASE_URL,
	type FactoryDroidModelInput,
	type FactoryDroidWire,
} from "@oh-my-pi/pi-catalog/discovery";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as AIError from "../error";
import type { Api, Context, Model, ModelSpec, ServiceTier, StreamFunction, StreamOptions, ToolChoice } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { hasNonThinkingTurnAfterLastUser, hasThinkinglessAssistantHistory } from "./anthropic";
import { createProviderErrorMessage } from "./error-message";
import droidIdentity from "./factory-droid/droid-identity.md" with { type: "text" };
import { streamFactoryDroidGemini } from "./factory-droid/gemini";
import { streamAnthropic, streamOpenAICompletions, streamOpenAIResponses } from "./register-builtins";

/**
 * Factory Droid subscription provider — sidecar-free transport over Factory's
 * LLM proxy. The proxy multiplexes four wire protocols by model family:
 *
 * | family | path | models |
 * |---|---|---|
 * | `openai-completions` | `/api/llm/o/v1/chat/completions` | Kimi, GLM, DeepSeek, Qwen, Inkling, MiniMax M3, Mistral, Nemotron |
 * | `openai-responses` | `/api/llm/o/v1/responses` | GPT + Grok |
 * | `anthropic-messages` | `/api/llm/a/v1/messages` | Claude |
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
 * - System identity: one Droid identity sentence precedes the caller's system
 *   prompt without changing its contents. A historical plugin-without-prefix
 *   403 is not evidence that the same gate remains active today.
 * - `x-api-provider` selects the upstream router from the model's registry
 *   rotation list (first entry pinned).
 */

/** Droid identity sentence prepended once in the system channel. */
export const DROID_SYSTEM_PREFIX = droidIdentity.trim();

/**
 * Node build the CLI's packaged runtime reports. The Stainless fingerprint is
 * a client-identity signal, so it is pinned to droid's own runtime rather than
 * leaking whichever Node/Bun build happens to host OMP.
 */
const FACTORY_DROID_RUNTIME_VERSION = "v24.3.0";

/**
 * The CLI's chat-completions request builder pins `temperature: 1` on every
 * body before per-model shaping runs, so the field is unconditional on this
 * wire; only an explicit caller temperature displaces it.
 */
const FACTORY_DROID_COMPLETIONS_TEMPERATURE = 1;

export interface FactoryDroidOptions extends StreamOptions {
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
	/** OMP-native "omit thinking summaries" (anthropic adaptive display). */
	hideThinkingSummary?: boolean;
	/** OMP-native response verbosity (responses wire `text.verbosity`). */
	textVerbosity?: "low" | "medium" | "high";
}

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

/**
 * Identity headers every wire sends, plus the wire-specific extras observed
 * on the live traffic from the CLI's underlying SDKs:
 * - every inference call declares `x-provider-routing-source:
 *   configured_order`: droid always walks the model's registry rotation in
 *   order, so the proxy is told the upstream choice was configuration-driven
 *   rather than server-routed.
 * - completions/responses add `Accept` and the `OpenAI-Platform` org hint
 *   (openai/azure upstreams only).
 * - completions adds the OpenAI SDK's X-Stainless fingerprint minus the
 *   timeout/helper entries: droid builds its chat client without a request
 *   timeout and streams through `create({ stream: true })` rather than the
 *   `.stream()` helper, so neither header rides the wire. The Responses route
 *   431s once total header size crosses its WAF budget (verified live), so it
 *   goes without the telemetry set entirely.
 * - anthropic adds the Anthropic SDK's X-Stainless fingerprint including that
 *   client's 600s timeout, plus the `x-api-key` placeholder the SDK contract
 *   requires.
 * - google adds nothing beyond the shared identity set.
 */
function buildIdentityHeaders(input: {
	upstream: string;
	sessionUuid: string;
	requestId: string;
	orgId?: string;
	wire: FactoryDroidWire;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
		"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
		"X-Factory-Client": "cli",
		"x-api-provider": input.upstream,
		"x-provider-routing-source": "configured_order",
		"x-session-id": input.sessionUuid,
		"x-assistant-message-id": input.requestId,
	};
	if (input.wire === "openai-completions" || input.wire === "openai-responses") {
		headers.Accept = "application/json";
		if (input.upstream === "openai" || input.upstream === "azure_openai") {
			headers["OpenAI-Platform"] = "org-bHuLtG1fGmYk5YaOihAAXFBw";
		}
	}
	if (input.wire === "openai-completions" || input.wire === "anthropic-messages") {
		headers["X-Stainless-Lang"] = "js";
		headers["X-Stainless-Package-Version"] = input.wire === "openai-completions" ? "6.25.0" : "0.70.1";
		headers["X-Stainless-Runtime"] = "node";
		headers["X-Stainless-Runtime-Version"] = FACTORY_DROID_RUNTIME_VERSION;
		headers["X-Stainless-Arch"] = process.arch;
		headers["X-Stainless-OS"] =
			process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux";
		headers["X-Stainless-Retry-Count"] = "0";
		if (input.wire === "anthropic-messages") {
			// droid constructs its Anthropic client with a 600s request timeout;
			// the SDK renders that as the seconds-valued telemetry header. The
			// chat-completions client is built without one, so that wire carries
			// no timeout header at all.
			headers["X-Stainless-Timeout"] = "600";
			headers["x-api-key"] = "placeholder";
		}
	}
	if (input.orgId) headers["X-Factory-Org-Id"] = input.orgId;
	return headers;
}

/**
 * Reasoning body extras for the completions path, mirroring the CLI's
 * per-model `apiProviderConfig` request builders. The shape is keyed by
 * model×upstream:
 *
 * - Fireworks takes `reasoning_effort` (the per-model effort mappers are
 *   identity for every rung, "max" included). Families whose request builder
 *   opts into reasoning history also send "preserved" (kimi/glm/nemotron/
 *   qwen/inkling) or "interleaved" (deepseek); MiniMax M3 does not.
 *   Disabled sends `reasoning_effort: "none"` with no history.
 * - Baseten opt-in families (kimi, glm-5.1, nemotron) take
 *   `chat_template_args.enable_thinking`; Baseten never receives
 *   `reasoning_history`.
 * - Baseten reasoning-effort families (glm-5.2, glm-5.2-fast, inkling) take
 *   `reasoning_effort` verbatim (incl. "max"); disabled sends
 *   `reasoning_effort: "none"` (emitNone).
 * - Baseten forced-on (deepseek-v4-pro) coerces off/disabled to
 *   `reasoning_effort: "low"` — thinking can never be switched off there.
 *   (The upstream table's `reasoningEffort.coercions` entry maps off/none to
 *   low, and the CLI applies it only while the resolved thinking mode is
 *   forced-on; opt-in and reasoning-effort Baseten families are untouched.)
 * - Mistral advertises no thinking config and `supports.reasoningHistory:
 *   false`, so effort rides the wire the way Fireworks takes it but
 *   `reasoning_history` never does.
 *
 * Models without a registry `completionsReasoning` entry (glm-4.7, glm-5,
 * custom ids) keep the legacy upstream-only shape.
 */
function buildCompletionsReasoningBody(
	meta: FactoryDroidModelInput | undefined,
	upstream: string,
	options: FactoryDroidOptions | undefined,
): Record<string, unknown> | undefined {
	// The CLI treats the "off"/"none" rungs as the disable state, same as the
	// explicit disable flag: Fireworks maps off -> "none", opt-in Baseten
	// flips the template switch off, reasoning-effort Baseten emits "none".
	// (OMP's harness already maps those rungs to `disableReasoning: true` —
	// `reasoning` is typed `Effort` and never carries "off"/"none".)
	const disabled = options?.disableReasoning === true;
	const shaping = meta?.completionsReasoning;

	if (upstream === "baseten") {
		const mode = shaping?.baseten?.mode;
		if (mode === "reasoning-effort") {
			// While thinking the transport emits reasoning_effort verbatim; only
			// the disable state needs a body override (emitNone).
			return disabled ? { reasoning_effort: "none" } : undefined;
		}
		if (mode === "forced-on") {
			return disabled ? { reasoning_effort: "low" } : undefined;
		}
		// opt-in families (kimi, glm-5.1, nemotron): the template defaults to
		// thinking-off, and the CLI's `fah` short-circuit returns an empty body
		// for off/none on opt-in models — the disable state is expressed by
		// omission, never by enable_thinking: false. Only an explicit effort
		// flips the switch on.
		if (!disabled && options?.reasoning !== undefined) {
			return { chat_template_args: { enable_thinking: true } };
		}
		return undefined;
	}

	if (upstream === "mistral") {
		return disabled ? { reasoning_effort: "none" } : undefined;
	}

	// Fireworks (and any other upstream for unregistered models).
	if (disabled) return { reasoning_effort: "none" };
	if (options?.reasoning !== undefined) {
		const history = shaping?.fireworks?.history;
		return history || !meta ? { reasoning_history: history ?? "preserved" } : undefined;
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

const REGION_UNAVAILABLE_PATTERN = /not available in this region/i;

/** Explain region rejections without persisting an exclusion from the catalog. */
function asRegionUnavailableError(model: Model<Api>, errorMessage: string | undefined): string | undefined {
	if (errorMessage == null || !REGION_UNAVAILABLE_PATTERN.test(errorMessage)) return undefined;
	return `${model.id} is not served from your network's region. Choose another model.`;
}

export const streamFactoryDroid: StreamFunction<"factory-droid-agent"> = (
	model: Model<"factory-droid-agent">,
	context: Context,
	options?: FactoryDroidOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// Sole credential path: the OMP-stored WorkOS session from `/login
		// factory-droid`, resolved and refreshed by the harness and passed as
		// apiKey. The kNoAuth sentinel ("N/A") means no stored credential.
		const harnessToken = options?.apiKey?.trim();
		try {
			if (!harnessToken || harnessToken === "N/A") {
				throw new AIError.ConfigurationError(
					"No Factory Droid credentials found. Run `/login factory-droid` (WorkOS device code).",
				);
			}
			const meta = resolveModelMeta(model);
			const upstream = resolveUpstream(model, meta);
			// The proxy expects v4-shaped ids; the OMP session id is a UUIDv7-style
			// timestamp id, so map it through a deterministic v4 shape that stays
			// stable per session.
			const requestId = crypto.randomUUID();
			const sessionUuid = options?.sessionId ? deterministicUuid(options.sessionId) : requestId;
			const orgId = factoryDroidOrgIdFromToken(harnessToken);

			const systemPrompt = context.systemPrompt ?? [];
			const proxiedContext: Context = {
				...context,
				systemPrompt:
					systemPrompt[0] === DROID_SYSTEM_PREFIX ? systemPrompt : [DROID_SYSTEM_PREFIX, ...systemPrompt],
			};

			const wire = meta?.wire ?? "openai-completions";
			const responsesBaseUrl = model.baseUrl ?? FACTORY_DROID_RESPONSES_BASE_URL;
			const baseOptions = {
				apiKey: harnessToken,
				signal: options?.signal,
				fetch: options?.fetch,
				credentialId: options?.credentialId,
				cacheRetention: options?.cacheRetention,
				providerSessionState: options?.providerSessionState,
				onPayload: options?.onPayload,
				onResponse: options?.onResponse,
				onSseEvent: options?.onSseEvent,
				providerRetryWait: options?.providerRetryWait,
				acceptEmptyResponse: options?.acceptEmptyResponse,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
				streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
			};

			let innerStream: AssistantMessageEventStream;
			if (wire === "google-generate") {
				innerStream = streamFactoryDroidGemini(model, proxiedContext, {
					...baseOptions,
					// Discovery stamps the region-resolved wire URL; the constant
					// is the global default for hand-registered custom models.
					baseUrl: model.baseUrl ?? FACTORY_DROID_GOOGLE_BASE_URL,
					geminiMedium: meta?.geminiMedium,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					reasoning: options?.reasoning,
					disableReasoning: options?.disableReasoning,
					stopSequences: options?.stopSequences,
					headers: {
						...buildIdentityHeaders({ upstream, sessionUuid, requestId, orgId, wire: "google-generate" }),
						...options?.headers,
					},
				});
			} else if (wire === "anthropic-messages") {
				const anthropicModel = buildModel({
					...model,
					api: "anthropic-messages",
					baseUrl: model.baseUrl ?? FACTORY_DROID_ANTHROPIC_BASE_URL,
				} as ModelSpec<"anthropic-messages">);
				const effort = options?.disableReasoning ? undefined : options?.reasoning;
				const thinkingStyle = meta?.thinkingStyle ?? "adaptive";
				const adaptive = thinkingStyle === "adaptive" || thinkingStyle === "adaptive-summarized";
				const budgetEffortStyle = thinkingStyle === "budget-effort" || thinkingStyle === "budget-effort-beta";
				// Budget styles carry the model's baked effortBudgets (the standard
				// OMP ladder, set in catalog discovery) — no provider-side table.
				const budget = effort !== undefined ? anthropicModel.thinking?.effortBudgets?.[effort] : undefined;
				// Native budget-effort thinking maps effort through {low,medium,high}
				// only — xhigh/max fall back to "high" (adaptive keeps the full ladder).
				const budgetEffort = effort === "xhigh" || effort === "max" ? "high" : effort;
				// The effort-2025-11-24 beta rides Bedrock/Vertex upstreams whenever
				// `output_config.effort` is on the wire, and the budget-effort-beta
				// style carries it unconditionally; Factory's direct anthropic route
				// and MiniMax never advertise it.
				// Native appends the beta only when an `output_config` is actually on
				// the wire — budget-interleaved builds never carry one.
				const emitsOutputConfig = thinkingStyle !== "budget-interleaved";
				const effortBeta =
					thinkingStyle === "budget-effort-beta" ||
					(emitsOutputConfig &&
						(upstream === "bedrock_anthropic" || upstream === "vertex_anthropic") &&
						effort !== undefined);
				innerStream = streamAnthropic(anthropicModel, proxiedContext, {
					...baseOptions,
					// The non-OAuth client keeps Factory's system channel intact and
					// sends its WorkOS bearer token in Authorization.
					anthropicCacheRefresh: options?.anthropicCacheRefresh,
					anthropicPrefixMismatchBehavior: options?.anthropicPrefixMismatchBehavior,
					anthropicCacheRefreshRequest: options?.anthropicCacheRefreshRequest,
					anthropicCompaction: options?.anthropicCompaction,
					userProfileId: options?.userProfileId,
					metadata: options?.metadata,
					taskBudget: options?.taskBudget,
					fallbackCreditRedemption: options?.fallbackCreditRedemption,
					anthropicSlowMode: options?.anthropicSlowMode,
					isOAuth: false,
					thinkingEnabled: options?.disableReasoning !== true,
					...(adaptive
						? { effort: (effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" }
						: {
								thinkingBudgetTokens: budget,
								...(budgetEffortStyle
									? { effort: (budgetEffort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" }
									: {}),
							}),
					// OMP's native pattern: the shared transport defaults supported
					// models to "summarized"; only an explicit hide is forwarded.
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					// Native emits the interleaved beta only while a thinking config is
					// actually on the wire: off/default-off turns get betaFlags: [] and a
					// non-thinking-led history strips budget-interleaved models (no
					// output_config) to betaFlags: [] as well. The header is built before
					// buildParams, so the branch replicates the strip condition.
					interleavedThinking:
						thinkingStyle === "budget-interleaved" &&
						effort !== undefined &&
						!hasThinkinglessAssistantHistory(context.messages) &&
						!hasNonThinkingTurnAfterLastUser(context.messages),
					// Native thinking-history handling: non-adaptive styles replay
					// thinking blocks only while the conversation stays thinking-led.
					stripThinkingHistory: !adaptive,
					effortBeta,
					fastMode: meta?.fastMode === true,
					// Native refusal fallbacks (fable entries): on the direct
					// anthropic upstream the CLI sends fallbacks=[{model}] and the
					// fallback-credit beta even without a credit token. The
					// server-side-fallback beta is auto-attached by the transport.
					...(upstream === "anthropic" && meta?.refusalFallbackModels?.length
						? {
								fallbacks: meta.refusalFallbackModels.map(model => ({ model })),
								betas: ["fallback-credit-2026-06-01"],
							}
						: {}),
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					temperature: options?.temperature,
					stopSequences: options?.stopSequences,
					serviceTier: options?.serviceTier,
					toolChoice: options?.toolChoice as "auto" | "any" | "none" | { type: "tool"; name: string } | undefined,
					sessionId: sessionUuid,
					headers: {
						...buildIdentityHeaders({ upstream, sessionUuid, requestId, orgId, wire: "anthropic-messages" }),
						...options?.headers,
					},
				});
			} else if (wire === "openai-responses") {
				const cfg = meta?.responsesConfig;
				// Registry-family shaping and retention use the resolved upstream;
				// max_output_tokens omission is resolved by catalog policy.
				const family = meta?.apiProviders[0] ?? upstream;
				const xaiFamily = family === "xai";
				const responsesModel = buildModel({
					...model,
					api: "openai-responses",
					baseUrl: responsesBaseUrl,
				} as ModelSpec<"openai-responses">);
				// The CLI's ZeH uses K(e) = e.toLowerCase(), preserving "max".
				const effort = options?.disableReasoning ? undefined : options?.reasoning;
				innerStream = streamOpenAIResponses(responsesModel, proxiedContext, {
					...baseOptions,
					reasoning: effort,
					// The CLI omits reasoning.summary for xai-routed models (grok);
					// null suppresses the shared transport's "auto" default.
					reasoningSummary: effort ? (xaiFamily ? null : "auto") : undefined,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					serviceTier: options?.serviceTier,
					include: options?.include,
					forceReasoningOff: options?.forceReasoningOff ?? options?.disableReasoning,
					statefulResponses: options?.statefulResponses,
					// The CLI sends no `temperature` on this wire; tool_choice is
					// forwarded only when the caller picks one (the API's default
					// is already "auto" — probe-verified the proxy accepts the
					// omission).
					toolChoice: options?.toolChoice,
					sessionId: sessionUuid,
					extraBody: {
						prompt_cache_key: sessionUuid,
						// Only extendedCache models routed to the openai upstream
						// carry retention; the proxy requires "24h" for them, rejects
						// the field for lighter configs, and rotations like
						// bedrock_openai drop it for the turn.
						...(cfg?.extendedCache && upstream === "openai" ? { prompt_cache_retention: "24h" } : {}),
						// Defaults ride the API's own (parallel tool calls are on
						// by default); only the non-default false is written.
						...(cfg?.parallelToolCalls === false ? { parallel_tool_calls: false } : {}),
						...(cfg?.serviceTier ? { service_tier: cfg.serviceTier } : {}),
						// Caller textVerbosity (StreamOptions) wins over the model's
						// registry verbosity, mirroring OMP's own option surface.
						...((cfg?.verbosity ?? options?.textVerbosity)
							? { text: { verbosity: options?.textVerbosity ?? cfg?.verbosity } }
							: {}),
						// The CLI computes userId ?? sessionId and its call site never
						// passes userId, so the wire value is the session id — match it
						// exactly rather than leaking the stable WorkOS user id.
						...(cfg?.safetyId ? { safety_identifier: sessionUuid } : {}),
					},
					headers: {
						...buildIdentityHeaders({ upstream, sessionUuid, requestId, orgId, wire: "openai-responses" }),
						...options?.headers,
					},
				});
			} else {
				const extraBody = buildCompletionsReasoningBody(meta, upstream, options);
				// Baseten opt-in families (kimi, glm-5.1, nemotron) ride the
				// template switch; reasoning-effort and forced-on families
				// (glm-5.2/5.2-fast, inkling, deepseek-v4-pro) take
				// `reasoning_effort` verbatim from the transport while thinking.
				const basetenReasoningEffort =
					upstream === "baseten" &&
					(meta?.completionsReasoning?.baseten?.mode === "reasoning-effort" ||
						meta?.completionsReasoning?.baseten?.mode === "forced-on");
				// The proxy's completions families replay stored reasoning_content
				// on assistant turns (streamed as `reasoning_content` deltas).
				// Kimi/GLM/nemotron replay captured thinking; DeepSeek also
				// requires a placeholder on tool-call turns. The Mistral upstream
				// instead streams and replays typed thinking parts in `content`,
				// including GLM when EU routing selects Mistral.
				const reasoningReplay = meta?.reasoningReplay;
				const openaiModel = buildModel({
					...model,
					api: "openai-completions",
					baseUrl: model.baseUrl ?? FACTORY_DROID_COMPLETIONS_BASE_URL,
					compat: {
						// The proxy's upstreams speak `max_tokens` (not the OpenAI-era
						// `max_completion_tokens`) and have no `store` field.
						maxTokensField: "max_tokens",
						supportsStore: false,
						// Factory's chat-completions proxy uses reasoning_effort even for
						// Qwen; the generic Qwen dialect would send enable_thinking
						// instead and silently drop the requested effort.
						thinkingFormat: "openai",
						...(upstream === "mistral"
							? { mistralReasoningContentParts: true, requiresThinkingAsText: false }
							: {}),
						...(meta?.toolMessageIncludesName ? { requiresToolResultName: true } : {}),
						// Generic-host heuristics that don't apply to the Factory
						// proxy: native emits reasoning params regardless of
						// tool_choice, never invents "." reasoning_content, and never
						// rewrites empty assistant content to ".".
						disableReasoningOnForcedToolChoice: false,
						disableReasoningOnToolChoice: false,
						allowsSyntheticReasoningContentForToolCalls: false,
						requiresAssistantContentForToolCalls: false,
						// capture-only (Kimi): replay through the capture-only
						// path, no synthetic fallback tiers. placeholder
						// (DeepSeek): keep the requires-path so the tool-call-turn
						// placeholder can fire — native forces the placeholder
						// only on tool-call turns with a single space, where the
						// generic family heuristic demands it on every assistant
						// turn with an empty string.
						...(reasoningReplay === "capture-only" ? { requiresReasoningContentForToolCalls: false } : {}),
						...(reasoningReplay === "capture-only" || reasoningReplay === "standard"
							? { replayReasoningContent: true }
							: {}),
						...(reasoningReplay === "placeholder"
							? {
									requiresReasoningContentForAllAssistantTurns: false,
									syntheticReasoningContentFallback: " ",
								}
							: {}),
						...(model as Model<Api>).compatConfig,
						...(extraBody ? { extraBody } : {}),
					},
				} as ModelSpec<"openai-completions">);
				innerStream = streamOpenAICompletions(openaiModel, proxiedContext, {
					...baseOptions,
					// droid pins temperature on every completions body; a caller
					// override still wins.
					temperature: options?.temperature ?? FACTORY_DROID_COMPLETIONS_TEMPERATURE,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					stopSequences: options?.stopSequences,
					frequencyPenalty: options?.frequencyPenalty,
					initiatorOverride: options?.initiatorOverride,
					promptCacheKey: options?.promptCacheKey,
					promptCache: options?.promptCache,
					serviceTier: options?.serviceTier,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					// Baseten opt-in reasoning rides chat_template_args only; the
					// generic reasoning_effort passthrough would add a field droid
					// never sends for those families. Reasoning-effort / forced-on
					// Baseten models pass through so the transport emits the effort
					// verbatim (the body builder supplies only the disable coercions).
					reasoning: upstream === "baseten" && !basetenReasoningEffort ? undefined : options?.reasoning,
					disableReasoning: upstream === "baseten" ? undefined : options?.disableReasoning,
					toolChoice: options?.toolChoice,
					sessionId: sessionUuid,
					headers: {
						...buildIdentityHeaders({ upstream, sessionUuid, requestId, orgId, wire: "openai-completions" }),
						...options?.headers,
					},
				});
			}

			for await (const event of innerStream) {
				if (event.type === "error") {
					const regionMessage = asRegionUnavailableError(model, event.error.errorMessage);
					if (regionMessage != null) {
						stream.push({ ...event, error: { ...event.error, errorMessage: regionMessage } });
						continue;
					}
				}
				stream.push(event);
			}
		} catch (error) {
			const message = createProviderErrorMessage(model, error);
			const regionMessage = asRegionUnavailableError(model, message.errorMessage);
			if (regionMessage != null) message.errorMessage = regionMessage;
			stream.push({ type: "error", reason: "error", error: message });
			stream.end();
		}
	})();

	return stream;
};
