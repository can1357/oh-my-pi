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
import { fitOutputTokensToContextWindow, type StreamFn, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type Model, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { openAIResponsesReplaysNativeHistory } from "@oh-my-pi/pi-ai/providers/openai-responses-state";
import { serverSideFallbackModels } from "@oh-my-pi/pi-catalog/compat/server-side-fallback";
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
	cfgProvidersMuseCodeStoreResponses,
	cfgProvidersOpenaiCodexDaybreak,
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

/** Configured fallback chains already warned about, so each warning fires once per distinct value. */
interface FallbackChainWarnings {
	/** Last configured list warned about for entries that are not model ids. */
	unusable?: readonly unknown[];
	/** Last overlong chain warned about. */
	overlong?: string;
}

/**
 * Clean the configured `providers.anthropic.serverSideFallbackModels` value into
 * the wire chain, or `undefined` when it states no chain, so the catalog's
 * applies. The setting reads `undefined` when unset and when a hand-edited
 * value is not a list (the registry warns and returns the unset default); `[]`
 * is an explicit empty chain and sends nothing. Entries that are not non-blank
 * strings are dropped with a warning naming each one and why; a non-empty list
 * left without a model id states no chain, so it follows the catalog like an
 * unset value instead of sending nothing like `[]`.
 * The wire contract allows at most three entries
 * (MessageCreateParams.fallbacks) and an overlong chain would be rejected by
 * the API instead of falling back, so cap deliberately and loudly. Each warning
 * fires once per distinct value, tracked in `warned`, rather than on every request.
 */
function configuredServerSideFallbackModels(
	configured: readonly unknown[] | undefined,
	warned: FallbackChainWarnings,
): string[] | undefined {
	if (configured === undefined) return undefined;
	const models: string[] = [];
	const dropped: Array<{ index: number; value: unknown; problem: string }> = [];
	for (const [index, entry] of configured.entries()) {
		if (typeof entry !== "string") {
			dropped.push({ index, value: entry, problem: `not a string (${entry === null ? "null" : typeof entry})` });
			continue;
		}
		const id = entry.trim();
		if (id.length > 0) models.push(id);
		else dropped.push({ index, value: entry, problem: "blank string" });
	}
	const noModelId = models.length === 0 && configured.length > 0;
	if (dropped.length > 0 && !Bun.deepEquals(warned.unusable, configured)) {
		warned.unusable = configured;
		logger.warn(
			noModelId
				? "providers.anthropic.serverSideFallbackModels has no model id; ignoring it and following the catalog chain"
				: "providers.anthropic.serverSideFallbackModels: dropping entries that are not model ids",
			{ setting: cfgProvidersAnthropicServerSideFallbackModels.id, dropped, expected: "non-blank model id strings" },
		);
	}
	if (noModelId) return undefined;
	if (models.length > ANTHROPIC_MAX_FALLBACK_MODELS) {
		const chain = models.join("\n");
		if (warned.overlong !== chain) {
			warned.overlong = chain;
			logger.warn("providers.anthropic.serverSideFallbackModels exceeds the wire limit; using the first three", {
				configured: models.length,
				limit: ANTHROPIC_MAX_FALLBACK_MODELS,
			});
		}
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
	// One tokenizer per reading model and native-history replay state, so
	// per-message counts are reused across requests: its prices (images,
	// replayed thinking and reasoning) belong to that model and request state.
	const tokenizers = new Map<string, Tokenizer>();
	// Configured fallback chains already warned about (unusable entries, overlong chains).
	const fallbackChainWarnings: FallbackChainWarnings = {};
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
		// A configured `providers.anthropic.serverSideFallbackModels` list replaces
		// the catalog chain, and `[]` sends nothing even with the toggle on; an
		// unset value (or one without a model id) keeps the catalog chain. The
		// provider layer picks it up, sends the beta header, and honors the
		// response signals. Models without a rule-assigned chain are untouched.
		const catalogFallbackChain =
			streamOptions?.fallbacks === undefined && cfgProvidersAnthropicServerSideFallback.get(settings)
				? serverSideFallbackModels(model)
				: [];
		const serverSideFallbackChain =
			(catalogFallbackChain.length > 0
				? configuredServerSideFallbackModels(
						cfgProvidersAnthropicServerSideFallbackModels.get(settings),
						fallbackChainWarnings,
					)
				: undefined) ?? catalogFallbackChain;
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
		// Opt-in: storage keeps prompts and outputs on Meta's side. The setting
		// also reads PI_MUSE_STORE_RESPONSES, which overrides it while set.
		const storeResponses =
			streamOptions?.storeResponses ??
			(model.provider === "muse-code" ? cfgProvidersMuseCodeStoreResponses.get(settings) : undefined);
		// Per request from this session's settings: the process-wide default in
		// pi-ai follows whichever session bound effects last.
		const codexAccessPrograms =
			streamOptions?.codexAccessPrograms ??
			(model.api === "openai-codex-responses" ? cfgProvidersOpenaiCodexDaybreak.get(settings) : undefined);
		const maxInFlightRequests = validateProviderMaxInFlightRequests(
			streamOptions?.maxInFlightRequests ?? cfgProvidersMaxInFlightRequests.get(settings),
		);
		// A cold Responses session rebuilds turns without their encrypted reasoning.
		// A request that may wait for a provider slot is built when it gets one,
		// after a concurrent response may have warmed the session, so it is
		// fitted as replaying.
		const nativeHistoryReplay =
			Object.hasOwn(maxInFlightRequests, model.provider) ||
			openAIResponsesReplaysNativeHistory(model, streamOptions?.providerSessionState);
		const tokenizerKey = `${model.provider}\0${model.api}\0${model.id}\0${nativeHistoryReplay}`;
		let tokenizer = tokenizers.get(tokenizerKey);
		if (!tokenizer) {
			tokenizer = new Tokenizer(model, { nativeHistoryReplay });
			tokenizers.set(tokenizerKey, tokenizer);
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
			maxInFlightRequests,
			loopGuard: {
				enabled: cfgModelLoopGuardEnabled.get(settings),
				checkAssistantContent: cfgModelLoopGuardCheckAssistantContent.get(settings),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? cfgOmitThinking.get(settings),
			// An off switch, not a default: the agent loop always offers its queue.
			liveSteering: cfgProvidersOpenaiLiveSteering.get(settings) ? streamOptions?.liveSteering : undefined,
			...(fallbacks !== undefined ? { fallbacks } : {}),
			...(storeResponses !== undefined ? { storeResponses } : {}),
			...(codexAccessPrograms !== undefined ? { codexAccessPrograms } : {}),
			...(slowModeHooks !== undefined ? { anthropicSlowMode: slowModeHooks } : {}),
		};
		return base(model, context, merged);
	};
}
