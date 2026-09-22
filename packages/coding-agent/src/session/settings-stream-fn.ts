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
import { scheduler } from "node:timers/promises";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type ProviderRetryAttemptInfo, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { logger } from "@oh-my-pi/pi-utils";
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

/** Describes a provider-internal retry backoff that is about to be slept through. */
export interface ProviderRetryWaitInfo {
	delayMs: number;
	model: string;
	provider: string;
	api: string;
	/** 1-based retry index, when the waiting retry loop tracks one. */
	attempt?: number;
	/** Retry budget of that loop, when known. */
	maxAttempts?: number;
}

/**
 * Observer notified around provider-internal retry backoffs.
 *
 * pi-ai retries a failed stream on its own (anthropic stream backoff, the
 * openai-responses transient retry, the empty-completion retry) and simply
 * sleeps between attempts. Without this hook those sleeps are invisible: no
 * loader, no log line — the session just looks frozen until pi-ai gives up and
 * the session-level saga finally emits `auto_retry_start`.
 */
export interface ProviderRetryWaitObserver {
	onStart(info: ProviderRetryWaitInfo): void;
	onEnd(result: { aborted: boolean }): void;
}

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
 *
 * When `retryWaitObserver` is supplied and the caller did not bring its own
 * `providerRetryWait`, the wrapper installs one that reports the wait and then
 * performs exactly the sleep pi-ai's default would have performed, so retry
 * delays, attempt counts, and abort semantics are unchanged.
 */
export function createSettingsAwareStreamFn(
	settings: Settings,
	base: StreamFn = streamSimple,
	retryWaitObserver?: ProviderRetryWaitObserver,
): StreamFn {
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
		// Only fill the hole: a caller that brought its own wait keeps it untouched.
		const providerRetryWait =
			streamOptions?.providerRetryWait ??
			(retryWaitObserver
				? async (delayMs: number, signal?: AbortSignal, attemptInfo?: ProviderRetryAttemptInfo): Promise<void> => {
						const info: ProviderRetryWaitInfo = {
							delayMs,
							model: model.id,
							provider: model.provider,
							api: model.api,
							// Absent when the waiting loop keeps no counter; the UI then
							// drops the "(n/m)" instead of inventing one.
							...(attemptInfo !== undefined
								? { attempt: attemptInfo.attempt, maxAttempts: attemptInfo.maxAttempts }
								: {}),
						};
						logger.info("Provider retry wait", { ...info });
						retryWaitObserver.onStart(info);
						try {
							await scheduler.wait(delayMs, { signal });
						} catch (error) {
							// `scheduler.wait` only rejects on abort; treat any rejection as
							// one so the indicator always clears, and rethrow so pi-ai's
							// cancellation handling is byte-for-byte what it was before.
							logger.debug("Provider retry wait aborted", { ...info });
							retryWaitObserver.onEnd({ aborted: true });
							throw error;
						}
						retryWaitObserver.onEnd({ aborted: false });
					}
				: undefined);
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
			...(providerRetryWait !== undefined ? { providerRetryWait } : {}),
		};
		return base(model, context, merged);
	};
}
