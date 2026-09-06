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
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";
import { hasEligibleRetryFallbackHop } from "./retry-fallback-chains";
import { capDurationToSessionDeadline, remainingSessionDeadlineMs } from "./session-deadline";

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` fill holes for routing and guard fields.
 * An absolute session deadline (`getDeadline`) re-caps stream watchdogs and
 * `maxRetryDelayMs`, including an explicit caller timeout or `0` (disabled),
 * so `--max-time` can still abort a hung primary in time for a configured
 * fallback hop. Without a deadline the caller-supplied timeouts win.
 */
export function createSettingsAwareStreamFn(
	settings: Settings,
	base?: StreamFn,
	options?: { getDeadline?: () => number | undefined },
): StreamFn {
	const stream = base ?? streamSimple;
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
		const remainingMs = remainingSessionDeadlineMs(options?.getDeadline?.());
		const reserveFallbackHop = hasEligibleRetryFallbackHop(settings, model);
		const streamFirstEventTimeoutMs = capDurationToSessionDeadline(
			timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds")),
			remainingMs,
			reserveFallbackHop,
		);
		const streamIdleTimeoutMs = capDurationToSessionDeadline(
			timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds")),
			remainingMs,
			reserveFallbackHop,
		);
		// Server-side fallback (opt-in): when the user enables it AND the
		// resolved model is a Claude Fable/Mythos on Anthropic's messages
		// API, inject the `fallbacks: [{ model: "claude-opus-4-8" }]` chain.
		// The provider layer picks it up, sends the beta header, and honors
		// the response signals. Every other model / API is untouched.
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
		const fallbacks =
			streamOptions?.fallbacks ?? (serverSideFallbackEnabled ? [{ model: "claude-opus-4-8" }] : undefined);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: capDurationToSessionDeadline(
				streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
				remainingMs,
				reserveFallbackHop,
			),
			streamIdleTimeoutMs: capDurationToSessionDeadline(
				streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
				remainingMs,
				reserveFallbackHop,
			),
			maxRetryDelayMs: capDurationToSessionDeadline(
				streamOptions?.maxRetryDelayMs ?? settings.get("retry.maxDelayMs"),
				remainingMs,
				reserveFallbackHop,
			),
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
		return stream(model, context, merged);
	};
}
