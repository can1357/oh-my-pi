import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type FactoryDroidModelPolicy,
	factoryDroidRegionalLimits,
	resolveFactoryDroidPolicy,
	resolveFactoryDroidRotation,
} from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { RequestPolicy } from "@oh-my-pi/pi-catalog/compat/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	FACTORY_DROID_CLIENT_VERSION,
	type FactoryDroidWire,
	factoryDroidClientHeaders,
	factoryDroidWireBaseUrl,
	resolveFactoryDroidInferenceRegion,
} from "@oh-my-pi/pi-catalog/wire/factory-droid";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import type { OAuthRequestIdentity } from "../auth/types";
import * as AIError from "../error";
import { mapAnthropicToolChoice } from "../stream";
import type { Api, Context, Model, ModelSpec, ServiceTier, StreamFunction, StreamOptions, ToolChoice } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type AnthropicOptions, mapStainlessArch, mapStainlessOs, shouldStripThinkingHistory } from "./anthropic";
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
 *   rotation list (first entry pinned); the registry is KDL
 *   (`rules/providers/factory-droid.kdl`, read through `compat/factory-droid`).
 */

/** Droid identity sentence prepended to the system channel. */
const DROID_SYSTEM_PREFIX = droidIdentity.trim();

/**
 * Node build the CLI's packaged runtime reports. The Stainless fingerprint is
 * a client-identity signal, so it is pinned to droid's own runtime rather than
 * leaking whichever Node/Bun build happens to host OMP.
 */
const FACTORY_DROID_RUNTIME_VERSION = "v26.3.0";

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

/**
 * Default upstream from the discovered rotation. Routing comes from the KDL
 * registry or the spec itself, never from `model.headers`: the shared model
 * cache strips headers from persisted specs, so header-carried routing would
 * vanish on cached loads, while `factoryDroidApiProviders` survives.
 */
function defaultUpstream(
	model: Model<"factory-droid-agent">,
	registry: FactoryDroidModelPolicy | undefined,
): string | undefined {
	return (model.factoryDroidApiProviders ?? registry?.rotation ?? ["fireworks"])[0];
}

function requireUpstream(upstream: string | undefined): string {
	if (!upstream) throw new AIError.ConfigurationError("Factory Droid model is unavailable in this account region.");
	return upstream;
}

/** A request attempt bound to the account serving it. */
interface AccountScope {
	/** The model with native limits narrowed to the account's inference region. */
	model: Model<"factory-droid-agent">;
	upstream: string;
	orgId: string | undefined;
	baseUrl: string;
}

/**
 * Bind one attempt to the credential that serves it: host, organization,
 * eligible upstream and native limits all follow that account. Without an
 * OAuth identity the discovered scope applies. Cached live routing may encode
 * organization denies, so a new account can narrow those routes but never
 * restore a static alternative.
 */
function scopeToAccount(
	model: Model<"factory-droid-agent">,
	registry: FactoryDroidModelPolicy | undefined,
	wire: FactoryDroidWire,
	identity: OAuthRequestIdentity | undefined,
	token: string,
): AccountScope {
	if (!identity) {
		return {
			model,
			upstream: requireUpstream(defaultUpstream(model, registry)),
			orgId: factoryDroidOrgIdFromToken(token) ?? model.factoryDroidOrgId,
			baseUrl: model.baseUrl || factoryDroidWireBaseUrl(wire, undefined),
		};
	}
	// Custom gateways keep their URL; Factory's own hosts follow residency.
	const defaultEndpoint =
		!model.baseUrl ||
		model.baseUrl === factoryDroidWireBaseUrl(wire, "global") ||
		model.baseUrl === factoryDroidWireBaseUrl(wire, "eu");
	const baseUrl = defaultEndpoint ? factoryDroidWireBaseUrl(wire, identity.region) : model.baseUrl;
	if (!registry) {
		return { model, upstream: requireUpstream(defaultUpstream(model, registry)), orgId: identity.orgId, baseUrl };
	}

	const inferenceRegion = resolveFactoryDroidInferenceRegion(identity);
	const eligible = resolveFactoryDroidRotation(registry, inferenceRegion);
	const upstream = requireUpstream(
		(model.factoryDroidApiProviders ?? eligible).find(provider => eligible.some(candidate => candidate === provider)),
	);
	const limits = factoryDroidRegionalLimits(registry, inferenceRegion);
	if (model.contextWindow != null && limits.contextWindow != null && limits.contextWindow < model.contextWindow) {
		// No authoritative count exists for this exact request: prior-turn usage
		// cannot prove the appended history fits, and tokenization belongs to the
		// caller's context-management layer.
		throw new AIError.ConfigurationError(
			`Factory Droid ${model.id} now has a ${limits.contextWindow}-token context window in ${inferenceRegion}, ` +
				`smaller than the selected model's ${model.contextWindow}. Rediscover and select the regional model ` +
				"so context management can check or compact the history before retrying.",
		);
	}
	// Only native limits change: custom endpoints, policy overrides, routing
	// constraints and credit metadata remain caller-owned.
	const contextWindow = model.contextWindow ?? limits.contextWindow;
	const maxTokens =
		limits.maxTokens == null ? model.maxTokens : Math.min(model.maxTokens ?? limits.maxTokens, limits.maxTokens);
	const scoped =
		contextWindow === model.contextWindow && maxTokens === model.maxTokens
			? model
			: { ...model, contextWindow, maxTokens };
	return { model: scoped, upstream, orgId: identity.orgId, baseUrl };
}

type SharedWire = Exclude<FactoryDroidWire, "google-generate">;

/** Request dialect plus the shared-transport model for one route. */
interface ResolvedRoute {
	policy: RequestPolicy;
	/** Model rebuilt for the shared transport's API; absent on the native Gemini client. */
	inner?: Model<SharedWire>;
	/** Server-side refusal fallback targets resolved for the route's upstream. */
	serverSideFallbackModels?: readonly string[];
}

/**
 * Routes memoized on the caller's model, so steady-state requests do no compat
 * resolution. Keys are bounded by the model's upstream × host × region limits.
 */
const ROUTES = new WeakMap<Model<"factory-droid-agent">, Map<string, ResolvedRoute>>();

function resolveRoute(
	source: Model<"factory-droid-agent">,
	scope: AccountScope,
	wire: FactoryDroidWire,
): ResolvedRoute {
	const { model, upstream, baseUrl } = scope;
	const key = `${wire}\n${upstream}\n${baseUrl}\n${model.contextWindow}\n${model.maxTokens}`;
	let routes = ROUTES.get(source);
	if (!routes) {
		routes = new Map();
		ROUTES.set(source, routes);
	}
	let route = routes.get(key);
	if (route) return route;
	if (wire === "google-generate") {
		route = { policy: resolveModelPolicy(model, { upstream }).request };
	} else {
		const resolved = resolveModelPolicy({ ...model, api: wire }, { upstream });
		const fallbackModels = resolved.catalog.serverSideFallbackModels;
		route = {
			policy: resolved.request,
			inner: buildModel({
				...model,
				api: wire,
				baseUrl,
				compat: resolved.compat,
				thinking: resolved.thinking,
			} as ModelSpec<SharedWire>),
			serverSideFallbackModels: Array.isArray(fallbackModels)
				? fallbackModels.filter((entry): entry is string => typeof entry === "string")
				: undefined,
		};
	}
	routes.set(key, route);
	return route;
}

/** The attempt's effort: undefined when reasoning is off. */
function selectEffort(
	model: Model<"factory-droid-agent">,
	registry: FactoryDroidModelPolicy | undefined,
	options: FactoryDroidOptions | undefined,
): { effort: Effort | undefined; disabled: boolean } {
	if (options?.disableReasoning || options?.forceReasoningOff) return { effort: undefined, disabled: true };
	// Without a caller effort the native default applies, which can be thinking off.
	// Untyped callers may still pass the native `off`/`none` rungs.
	const selected: string | undefined =
		options?.reasoning ?? (registry?.defaultReasoningOff ? "off" : model.thinking?.defaultLevel);
	return selected === "none" || selected === "off"
		? { effort: undefined, disabled: true }
		: { effort: selected as Effort | undefined, disabled: false };
}

/**
 * Identity headers every wire sends, plus the wire-specific extras observed
 * on the live traffic from the CLI's underlying SDKs:
 * - every inference call declares how its upstream was chosen
 *   (`x-provider-routing-source`): `session_lock` once the session has a
 *   locked upstream (any continuation, or from the start on routes that lock
 *   it), otherwise `configured_order` when live routing chose the rotation and
 *   `registry_default` when it did not.
 * - completions/responses add `Accept` and, where the route's policy names
 *   one, the `OpenAI-Platform` org hint.
 * - every SDK-backed wire adds its SDK's X-Stainless fingerprint; the timeout
 *   entry is transport-owned on the OpenAI wires, while droid's Anthropic
 *   client pins 600s and needs the `x-api-key` placeholder its SDK requires.
 * - google adds nothing beyond the shared identity set.
 */
function buildIdentityHeaders(input: {
	upstream: string;
	routingSource: "session_lock" | "configured_order" | "registry_default";
	sessionUuid: string;
	requestId: string;
	orgId?: string;
	wire: FactoryDroidWire;
	openaiPlatformHeader?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
		...factoryDroidClientHeaders(input.orgId),
		"x-api-provider": input.upstream,
		"x-provider-routing-source": input.routingSource,
		"x-session-id": input.sessionUuid,
		"x-assistant-message-id": input.requestId,
	};
	if (input.wire === "openai-completions" || input.wire === "openai-responses") {
		headers.Accept = "application/json";
		if (input.openaiPlatformHeader) headers["OpenAI-Platform"] = input.openaiPlatformHeader;
	}
	if (input.wire !== "google-generate") {
		headers["X-Stainless-Lang"] = "js";
		headers["X-Stainless-Package-Version"] = input.wire === "anthropic-messages" ? "0.70.1" : "6.25.0";
		headers["X-Stainless-Runtime"] = "node";
		headers["X-Stainless-Runtime-Version"] = FACTORY_DROID_RUNTIME_VERSION;
		headers["X-Stainless-Arch"] = mapStainlessArch(process.arch);
		headers["X-Stainless-OS"] = mapStainlessOs(process.platform);
		headers["X-Stainless-Retry-Count"] = "0";
		if (input.wire === "anthropic-messages") {
			// droid constructs its Anthropic client with a 600s request timeout;
			// the SDK renders that as the seconds-valued telemetry header.
			headers["X-Stainless-Timeout"] = "600";
			headers["x-api-key"] = "placeholder";
		}
	}
	return headers;
}

function effortField(effort: string | undefined): Record<string, unknown> {
	return effort ? { reasoning_effort: effort } : {};
}

/**
 * Encode the selected route's reasoning dialect. Custom ids without a
 * resolved dialect use the generic effort field.
 */
function buildCompletionsReasoningBody(
	policy: RequestPolicy,
	effort: Effort | undefined,
	disabled: boolean,
): Record<string, unknown> {
	const history =
		effort !== undefined && policy.completionsReasoningHistory && policy.completionsReasoningHistory !== "omit"
			? { reasoning_history: policy.completionsReasoningHistory }
			: {};
	switch (policy.completionsReasoningMode ?? "effort") {
		case "none":
			return {};
		case "effort":
			return { ...effortField(disabled ? "none" : effort), ...history };
		case "forced-on":
			// The route cannot turn thinking off; off maps to its lowest rung.
			return { ...effortField(disabled ? "low" : effort), ...history };
		case "opt-in":
			// Toggle-only dialect: the template flag is the sole control.
			return { chat_template_args: { enable_thinking: effort !== undefined }, ...history };
	}
}

/** Factory's external org id (`X-Factory-Org-Id` header value) from the WorkOS JWT payload, unverified (the server verifies). */
function factoryDroidOrgIdFromToken(accessToken: string): string | undefined {
	const [, payloadSegment] = accessToken.split(".");
	if (!payloadSegment) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
	if (payload == null || typeof payload !== "object" || !("external_org_id" in payload)) return undefined;
	const external = payload.external_org_id;
	return typeof external === "string" && external.length > 0 ? external : undefined;
}

const REGION_UNAVAILABLE_PATTERN = /not available in this region/i;

/** Explain region rejections without persisting an exclusion from the catalog. */
function asRegionUnavailableError(model: Model<Api>, errorMessage: string | undefined): string | undefined {
	if (errorMessage == null || !REGION_UNAVAILABLE_PATTERN.test(errorMessage)) return undefined;
	return `${model.id} is not served from your network's region. Choose another model.`;
}

/** Caller options every wire forwards unchanged, plus the resolved bearer and identity headers. */
type ForwardedOptions = Pick<
	StreamOptions,
	| "signal"
	| "fetch"
	| "credentialId"
	| "cacheRetention"
	| "providerSessionState"
	| "onPayload"
	| "onResponse"
	| "onSseEvent"
	| "providerRetryWait"
	| "acceptEmptyResponse"
	| "maxRetryDelayMs"
	| "streamIdleTimeoutMs"
	| "streamFirstEventTimeoutMs"
	| "maxTokens"
	| "waitForTerminalDrain"
> & { apiKey: string; headers: Record<string, string> };

/** One resolved request attempt, shared by every wire encoder. */
interface Attempt {
	model: Model<"factory-droid-agent">;
	route: ResolvedRoute;
	baseUrl: string;
	effort: Effort | undefined;
	disabled: boolean;
	sessionUuid: string;
	context: Context;
	options: FactoryDroidOptions | undefined;
	forwarded: ForwardedOptions;
}

function streamGoogleWire(a: Attempt): AssistantMessageEventStream {
	return streamFactoryDroidGemini(a.model, a.context, {
		...a.forwarded,
		baseUrl: a.baseUrl,
		thinkingDialect: a.route.policy.googleThinking,
		temperature: a.options?.temperature,
		topP: a.options?.topP,
		topK: a.options?.topK,
		reasoning: a.effort,
		disableReasoning: a.disabled,
		stopSequences: a.options?.stopSequences,
	});
}

function streamMessagesWire(a: Attempt, inner: Model<"anthropic-messages">): AssistantMessageEventStream {
	const { policy } = a.route;
	const { effort, options } = a;
	const style = policy.anthropicThinking;
	const adaptive = style === "adaptive" || style === "adaptive-summarized";
	// Adaptive thinking keeps the full ladder; native budget-effort maps effort
	// through {low,medium,high} only; budget-interleaved sends no output effort.
	const outputEffort =
		effort === undefined || !(adaptive || style === "budget-effort")
			? undefined
			: !adaptive && (effort === "xhigh" || effort === "max")
				? "high"
				: effort;
	const fallbackModels = a.route.serverSideFallbackModels;
	const refusalFallbacks = fallbackModels?.length ? fallbackModels.map(model => ({ model })) : undefined;
	return streamAnthropic(inner, a.context, {
		...a.forwarded,
		// The non-OAuth client keeps Factory's system channel intact and sends
		// its WorkOS bearer token in Authorization.
		isOAuth: false,
		anthropicPrefixMismatchBehavior: options?.anthropicPrefixMismatchBehavior,
		anthropicCompaction: options?.anthropicCompaction,
		userProfileId: options?.userProfileId,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		fallbackCreditRedemption: options?.fallbackCreditRedemption,
		anthropicSlowMode: options?.anthropicSlowMode,
		thinkingEnabled: !a.disabled,
		effort: outputEffort as AnthropicOptions["effort"],
		// Token budgets come from the KDL ladder; adaptive thinking has none.
		thinkingBudgetTokens: adaptive || effort === undefined ? undefined : inner.thinking?.effortBudgets?.[effort],
		// The shared transport defaults supported models to "summarized"; only
		// an explicit hide is forwarded.
		thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
		// Native sends the interleaved beta only while a thinking config is on
		// the wire, and strips it once the history stops being thinking-led.
		// Headers are built before params, so the strip condition is mirrored.
		interleavedThinking:
			style === "budget-interleaved" && effort !== undefined && !shouldStripThinkingHistory(a.context.messages),
		// Native refusal fallbacks send the chain and the fallback-credit beta
		// even without a credit token; the transport adds server-side-fallback.
		...(refusalFallbacks ? { fallbacks: refusalFallbacks } : {}),
		betas: [
			...(policy.anthropicToolStreamingBeta && a.context.tools?.length
				? ["fine-grained-tool-streaming-2025-05-14"]
				: []),
			...(refusalFallbacks ? ["fallback-credit-2026-06-01"] : []),
		],
		temperature: options?.temperature,
		stopSequences: options?.stopSequences,
		serviceTier: options?.serviceTier,
		toolChoice: mapAnthropicToolChoice(options?.toolChoice),
	});
}

function streamResponsesWire(a: Attempt, inner: Model<"openai-responses">): AssistantMessageEventStream {
	const { policy } = a.route;
	const { effort, disabled, options, sessionUuid } = a;
	const verbosity = options?.textVerbosity ?? policy.responsesVerbosity;
	// Native declares every function tool non-strict; OpenAI treats an absent flag as strict.
	const tools = a.context.tools?.map(tool => ({ ...tool, strict: false }));
	return streamOpenAIResponses(inner, tools ? { ...a.context, tools } : a.context, {
		...a.forwarded,
		sessionId: sessionUuid,
		reasoning: effort,
		// Hosts without reasoning-summary support (xai-routed models) get the
		// shared resolver's explicit null instead of the "auto" default.
		reasoningSummary: effort ? "auto" : undefined,
		// How disabled reasoning reaches the wire (`none` tier or omitted) is the
		// route's `reasoning-disable-mode`; no reasoning means no encrypted content.
		disableReasoning: disabled,
		includeEncryptedReasoning: disabled ? false : undefined,
		serviceTier: options?.serviceTier,
		include: options?.include,
		statefulResponses: options?.statefulResponses,
		// Native sends no temperature here. Without a caller choice, the OpenAI
		// family defaults tool_choice to auto; the transport emits it only with tools.
		toolChoice: options?.toolChoice ?? (policy.responsesToolChoiceAuto ? "auto" : undefined),
		extraBody: {
			prompt_cache_key: sessionUuid,
			...(policy.responsesCacheRetention ? { prompt_cache_retention: "24h" } : {}),
			// Native always states parallel tool calls when tools ride the request.
			...(a.context.tools?.length ? { parallel_tool_calls: policy.responsesParallelToolCalls !== false } : {}),
			...(policy.responsesServiceTier ? { service_tier: policy.responsesServiceTier } : {}),
			...(verbosity ? { text: { verbosity } } : {}),
			// Native computes userId ?? sessionId and never passes userId, so the
			// wire value is the session id rather than the stable WorkOS user id.
			...(policy.responsesSafetyIdentifier ? { safety_identifier: sessionUuid } : {}),
		},
	});
}

function streamCompletionsWire(a: Attempt, inner: Model<"openai-completions">): AssistantMessageEventStream {
	const { options } = a;
	// The selected dialect owns every reasoning field, so the shared encoder gets none.
	const extraBody = buildCompletionsReasoningBody(a.route.policy, a.effort, a.disabled);
	return streamOpenAICompletions({ ...inner, compat: { ...inner.compat, extraBody } }, a.context, {
		...a.forwarded,
		sessionId: a.sessionUuid,
		temperature: options?.temperature ?? FACTORY_DROID_COMPLETIONS_TEMPERATURE,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		frequencyPenalty: options?.frequencyPenalty,
		stopSequences: options?.stopSequences,
		initiatorOverride: options?.initiatorOverride,
		promptCacheKey: options?.promptCacheKey,
		promptCache: options?.promptCache,
		serviceTier: options?.serviceTier,
		reasoning: undefined,
		disableReasoning: undefined,
		toolChoice: options?.toolChoice,
	});
}

function streamWire(wire: FactoryDroidWire, a: Attempt): AssistantMessageEventStream {
	switch (wire) {
		case "google-generate":
			return streamGoogleWire(a);
		case "anthropic-messages":
			return streamMessagesWire(a, a.route.inner as Model<"anthropic-messages">);
		case "openai-responses":
			return streamResponsesWire(a, a.route.inner as Model<"openai-responses">);
		case "openai-completions":
			return streamCompletionsWire(a, a.route.inner as Model<"openai-completions">);
	}
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
		// apiKey. The no-auth sentinel means no stored credential.
		const harnessToken = options?.apiKey?.trim();
		try {
			if (!harnessToken || harnessToken === NO_AUTH_SENTINEL) {
				throw new AIError.ConfigurationError(
					"No Factory Droid credentials found. Run `/login factory-droid` (WorkOS device code).",
				);
			}
			const registry = resolveFactoryDroidPolicy(model);
			const wire = registry?.wire ?? "openai-completions";
			const scope = scopeToAccount(model, registry, wire, options?.oauthIdentity, harnessToken);
			// The proxy expects v4-shaped ids; the OMP session id is a UUIDv7-style
			// timestamp id, so it maps through a deterministic v4 shape that stays
			// stable per session.
			const requestId = crypto.randomUUID();
			const sessionUuid = options?.sessionId ? deterministicUuid(options.sessionId) : requestId;
			const systemPrompt = context.systemPrompt ?? [];
			const route = resolveRoute(model, scope, wire);
			const attempt: Attempt = {
				model: scope.model,
				route,
				baseUrl: scope.baseUrl,
				...selectEffort(scope.model, registry, options),
				sessionUuid,
				context: {
					...context,
					systemPrompt: [DROID_SYSTEM_PREFIX, ...systemPrompt],
				},
				options,
				forwarded: {
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
					maxTokens: options?.maxTokens ?? scope.model.maxTokens ?? undefined,
					waitForTerminalDrain: options?.waitForTerminalDrain,
					headers: {
						...buildIdentityHeaders({
							upstream: scope.upstream,
							// The upstream locks for the session once a turn has been served.
							routingSource:
								route.policy.routingSessionLock ||
								context.messages.some(message => message.role === "assistant")
									? "session_lock"
									: (scope.model.factoryDroidRoutingSource ?? "registry_default"),
							sessionUuid,
							requestId,
							orgId: scope.orgId,
							wire,
							openaiPlatformHeader: route.policy.openaiPlatformHeader,
						}),
						...options?.headers,
					},
				},
			};

			for await (const event of streamWire(wire, attempt)) {
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
