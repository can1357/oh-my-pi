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
import {
	fitOutputTokensToContextWindow,
	type StreamFn,
	Tokenizer,
	tokenizerEncodingForModel,
} from "@oh-my-pi/pi-agent-core";
import { type Model, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { serverSideFallbackModels } from "@oh-my-pi/pi-catalog/compat/server-side-fallback";
import type { Encoding } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type AnthropicSlowModeLanes, anthropicSlowModeLanes } from "./anthropic-slow-mode";

import {
	cfgModelLoopGuardCheckAssistantContent,
	cfgModelLoopGuardEnabled,
	cfgOmitThinking,
	cfgProvidersAnthropicServerSideFallback,
	cfgProvidersAnthropicServerSideFallbackModels,
	cfgProvidersAnthropicSlowMode,
	cfgProvidersAntigravityEndpoint,
	cfgProvidersCacheRetention,
	cfgProvidersMaxInFlightRequests,
	cfgProvidersOpenaiLiveSteering,
	cfgProvidersOpenaiWebsockets,
	cfgProvidersOpenrouterVariant,
	cfgProvidersStreamFirstEventTimeoutSeconds,
	cfgProvidersStreamIdleTimeoutSeconds,
	cfgRetryMaxDelayMs,
	cfgTextVerbosity,
	validateProviderMaxInFlightRequests,
} from "./settings";

/** Map `providers.openaiWebsockets` to the provider `preferWebsockets` hint (`auto` → model default). */
export function resolveOpenAIWebsocketPreference(settings: Settings): boolean | undefined {
	const setting = cfgProvidersOpenaiWebsockets.get(settings);
	return setting === "on" ? true : setting === "off" ? false : undefined;
}

/** Anthropic `MessageCreateParams.fallbacks` accepts at most three entries. */
const ANTHROPIC_MAX_FALLBACK_MODELS = 3;

/**
 * Clean a configured `providers.anthropic.serverSideFallbackModels` value into
 * the wire chain. The registry guarantees an array (a non-array configured
 * value falls back to the default), but not its element types: hand-edited
 * YAML can supply non-string entries, which are dropped instead of throwing.
 * The wire contract allows at most three entries
 * (MessageCreateParams.fallbacks) and an overlong chain would be rejected by
 * the API instead of falling back, so cap deliberately and loudly.
 */
function configuredServerSideFallbackModels(configured: readonly unknown[]): string[] {
	const models = configured
		.filter((id): id is string => typeof id === "string")
		.map(id => id.trim())
		.filter(id => id.length > 0);
	if (models.length > ANTHROPIC_MAX_FALLBACK_MODELS) {
		logger.warn("providers.anthropic.serverSideFallbackModels exceeds the wire limit; using the first three", {
			configured: models.length,
			limit: ANTHROPIC_MAX_FALLBACK_MODELS,
		});
	}
	return models.slice(0, ANTHROPIC_MAX_FALLBACK_MODELS);
}

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/** Session wiring for Anthropic subscription wrap-up and slow mode (`providers.anthropic.slowMode`). */
export interface SettingsStreamSlowModeContext {
	/** Defaults to the process-wide lane registry. */
	lanes?: AnthropicSlowModeLanes;
	/** Final gate before auto-accepting the lane for `model` (e.g. prefer sibling accounts). */
	canAutoAccept?: (model: Model) => boolean | Promise<boolean>;
	/** Route slow-mode notices to the requesting session. */
	notify?: (level: "info" | "warning" | "error", message: string) => void;
	/** Record which account lane served the session's latest Anthropic request. */
	onLane?: (lane: string) => void;
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` always win — the helper only fills holes.
 * The one exception is the output cap, which is lowered when prompt plus cap
 * would exceed the model's context window (see
 * {@link fitOutputTokensToContextWindow}); every request this session drives,
 * including side turns like `/btw`, goes through here.
 */
export function createSettingsAwareStreamFn(
	settings: Settings,
	base: StreamFn = streamSimple,
	slowModeContext?: SettingsStreamSlowModeContext,
): StreamFn {
	// One tokenizer per encoding, so per-message counts are reused across requests.
	const tokenizers = new Map<Encoding | null, Tokenizer>();
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = cfgProvidersOpenrouterVariant.get(settings);
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(settings);
		const textVerbosity =
			model.api === "openai-codex-responses"
				? cfgTextVerbosity.isConfigured(settings)
					? cfgTextVerbosity.get(settings)
					: undefined
				: model.api === "openai-responses"
					? cfgTextVerbosity.get(settings)
					: undefined;
		// "auto" leaves the option unset so provider defaults and the
		// PI_CACHE_RETENTION env override keep working; anything else is an
		// explicit per-request retention (long restores 1h Anthropic TTLs and
		// implicitly disables the short-entry keep-alive refresh loop).
		const cacheRetentionSetting = cfgProvidersCacheRetention.get(settings);
		const cacheRetention = cacheRetentionSetting === "auto" ? undefined : cacheRetentionSetting;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(cfgProvidersStreamFirstEventTimeoutSeconds.get(settings));
		const streamIdleTimeoutMs = timeoutSecondsToMs(cfgProvidersStreamIdleTimeoutSeconds.get(settings));
		// Server-side fallback (opt-in): when the user enables it AND the
		// catalog assigns the model a chain (`server-side-fallback-models` axis,
		// authored for Fable/Mythos on first-party Anthropic), inject `fallbacks`.
		// A configured `providers.anthropic.serverSideFallbackModels` replaces the
		// catalog chain, and an empty configured chain sends nothing even with the
		// toggle on. The provider layer picks it up, sends the beta header, and
		// honors the response signals. Models without a rule-assigned chain are
		// untouched.
		const catalogFallbackChain =
			streamOptions?.fallbacks === undefined && cfgProvidersAnthropicServerSideFallback.get(settings)
				? serverSideFallbackModels(model)
				: [];
		const serverSideFallbackChain =
			catalogFallbackChain.length > 0 && cfgProvidersAnthropicServerSideFallbackModels.isConfigured(settings)
				? configuredServerSideFallbackModels(cfgProvidersAnthropicServerSideFallbackModels.get(settings))
				: catalogFallbackChain;
		const fallbacks =
			streamOptions?.fallbacks ??
			(serverSideFallbackChain.length > 0 ? serverSideFallbackChain.map(id => ({ model: id })) : undefined);
		// Anthropic usage-limit stages: the provider consults these hooks only for
		// first-party OAuth requests, so attaching them per anthropic call is safe.
		// Wrap-up tracking runs for everyone; the setting (`/slow`) gates only the
		// low-priority lane, read per call so a mid-request toggle takes effect.
		const slowModeLanes = slowModeContext?.lanes ?? anthropicSlowModeLanes;
		const canAutoAccept = slowModeContext?.canAutoAccept;
		const slowModeHooks =
			streamOptions?.anthropicSlowMode === undefined && model.provider === "anthropic"
				? slowModeLanes.hooks({
						lowPriority: () => cfgProvidersAnthropicSlowMode.get(settings) === "auto",
						canAutoAccept: canAutoAccept ? () => canAutoAccept(model) : undefined,
						notify: slowModeContext?.notify,
						onLane: slowModeContext?.onLane,
					})
				: undefined;
		const encoding = tokenizerEncodingForModel(model);
		let tokenizer = tokenizers.get(encoding);
		if (!tokenizer) {
			tokenizer = new Tokenizer(model);
			tokenizers.set(encoding, tokenizer);
		}
		const maxTokens = fitOutputTokensToContextWindow(model, context, streamOptions?.maxTokens, tokenizer);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			maxTokens,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? cfgRetryMaxDelayMs.get(settings),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? cfgProvidersMaxInFlightRequests.get(settings),
			),
			loopGuard: {
				enabled: cfgModelLoopGuardEnabled.get(settings),
				checkAssistantContent: cfgModelLoopGuardCheckAssistantContent.get(settings),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? cfgOmitThinking.get(settings),
			// An off switch, not a default: the agent loop always offers its queue.
			liveSteering: cfgProvidersOpenaiLiveSteering.get(settings) ? streamOptions?.liveSteering : undefined,
			...(fallbacks !== undefined ? { fallbacks } : {}),
			...(slowModeHooks !== undefined ? { anthropicSlowMode: slowModeHooks } : {}),
		};
		return base(model, context, merged);
	};
}
