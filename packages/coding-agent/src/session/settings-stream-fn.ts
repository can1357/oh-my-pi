/**
 * Settings-aware stream wrapper shared by the main agent (sdk.ts) and the
 * advisor agent (AgentSession.#buildAdvisorRuntime).
 *
 * verbosity, stream watchdog budgets, per-provider in-flight caps, and the loop
 * guard out of `Settings`
 * per request, layering them onto whatever options the caller passed. Before
 * this helper existed, advisor turns called bare `streamSimple` while the main
 * turn went through an inline closure that read these settings — so an advisor on
 * OpenRouter never saw `providers.openrouterVariant`, breaking sticky routing
 * and OpenRouter response-cache hits across advisor calls.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { logger } from "@oh-my-pi/pi-utils";
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

/** Anthropic `MessageCreateParams.fallbacks` accepts at most three entries. */
const ANTHROPIC_MAX_FALLBACK_MODELS = 3;

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` always win — the helper only fills holes.
 */
export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
		const textVerbosity =
			model.api === "openai-codex-responses"
				? settings.isConfigured("textVerbosity")
					? settings.get("textVerbosity")
					: undefined
				: model.api === "openai-responses"
					? settings.get("textVerbosity")
					: undefined;
		// "auto" leaves the option unset so provider defaults and the
		// PI_CACHE_RETENTION env override keep working; anything else is an
		// explicit per-request retention (long restores 1h Anthropic TTLs and
		// implicitly disables the short-entry keep-alive refresh loop).
		const cacheRetentionSetting = settings.get("providers.cacheRetention");
		const cacheRetention = cacheRetentionSetting === "auto" ? undefined : cacheRetentionSetting;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds"));
		const streamIdleTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds"));
		// Server-side fallback (opt-in): when the user enables it AND the
		// resolved model is a Claude Fable/Mythos on Anthropic's messages
		// API, inject the `providers.anthropic.serverSideFallbackModels`
		// chain (default `[{ model: "claude-opus-4-8" }]`) as `fallbacks`.
		// The provider layer picks it up, sends the beta header, and honors
		// the response signals. Every other model / API is untouched, and an
		// empty configured chain sends nothing even with the toggle on.
		const serverSideFallbackEligible =
			settings.get("providers.anthropic.serverSideFallback") &&
			model.api === "anthropic-messages" &&
			model.provider === "anthropic";
		const serverSideFallbackIdentity = serverSideFallbackEligible
			? (model.identity ?? classifyModel(model.provider, model.id ?? "", { lenient: true }))
			: undefined;
		const serverSideFallbackEnabled =
			serverSideFallbackIdentity?.class === "anthropic" &&
			(serverSideFallbackIdentity.family === "fable" || serverSideFallbackIdentity.family === "mythos");
		// The wire contract allows at most three fallback entries
		// (MessageCreateParams.fallbacks); an overlong chain would be rejected
		// by the API instead of falling back, so cap deliberately and loudly.
		// Non-string elements can arrive via YAML/CLI config (the generic array
		// parser doesn't validate element types); drop them instead of throwing.
		// Hand-edited YAML can supply a scalar/object where the schema expects an
		// array; Settings.get returns the raw configured value, so guard the shape
		// before filtering (non-arrays behave like an empty chain).
		const rawFallbackModels = serverSideFallbackEnabled
			? settings.get("providers.anthropic.serverSideFallbackModels")
			: [];
		const configuredFallbackModels = Array.isArray(rawFallbackModels)
			? rawFallbackModels
					.filter((id): id is string => typeof id === "string")
					.map(id => id.trim())
					.filter(id => id.length > 0)
			: [];
		if (configuredFallbackModels.length > ANTHROPIC_MAX_FALLBACK_MODELS) {
			logger.warn("providers.anthropic.serverSideFallbackModels exceeds the wire limit; using the first three", {
				configured: configuredFallbackModels.length,
				limit: ANTHROPIC_MAX_FALLBACK_MODELS,
			});
		}
		const serverSideFallbackModels = configuredFallbackModels.slice(0, ANTHROPIC_MAX_FALLBACK_MODELS);
		const fallbacks =
			streamOptions?.fallbacks ??
			(serverSideFallbackModels.length > 0 ? serverSideFallbackModels.map(id => ({ model: id })) : undefined);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? settings.get("retry.maxDelayMs"),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: settings.get("model.loopGuard.enabled"),
				checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? settings.get("omitThinking"),
			...(fallbacks !== undefined ? { fallbacks } : {}),
		};
		return base(model, context, merged);
	};
}
