/**
 * Bridges a long wait on one prompt cache entry: keeps the entry alive while
 * renting it pays, then buys out by compacting the history or letting the
 * entry expire.
 *
 * Ported from upstream pi's cache warmer (earendil-works/pi): a refresh is
 * scheduled at 90% of the model's declared prompt-cache lifetime (at least
 * ten seconds before expiry) and only fires when the expected avoided
 * cache-miss cost minus the refresh cost clears a savings floor. Warming runs
 * in two phases — "streaming" while the agent run that sent the request is
 * still active, "idle" after it settles — and stops on context change, mode
 * change, or a refresh that misses the cache.
 *
 * A refresh ("rent") is a `max_tokens: 0` pre-warm where the catalog declares
 * the endpoint accepts one, else a one-token replay priced with the output the
 * session's earlier replays of the model were actually billed. While
 * streaming, renting continues as long as the refresh spend since the last
 * real request plus the next refresh stays within the cheapest buy-out
 * (ski rental): the extra cost of re-writing the prefix once it expires, or,
 * for prompts past the bridge-compaction threshold, compacting the history
 * before the entry expires and re-writing only the compacted context. The
 * idle phase keeps a fixed continuation probability and a 30-minute window,
 * so an entry whose lifetime outlasts it (Anthropic's 1h tier) is only warmed
 * while a run is active.
 *
 * A model is warmed only when its catalog entry (or a models.yml `promptCache`
 * override) declares a lifetime for the retention tier the request used, so
 * providers whose replay behavior is unvalidated are never touched.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	PromptCacheCutoff,
	resolveCacheRetention,
	type SimpleStreamOptions,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { isPromptCachePrewarmSupported } from "@oh-my-pi/pi-catalog/compat/prompt-cache-prewarm";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../extensibility/shared-events";

export type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult };

/** Warming mode: "off" disables it, "streaming" protects active runs, "idle" also covers gaps between runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;

/**
 * The lower of `mode` and `cap` (off < streaming < idle): a session capped at
 * "streaming" never warms between runs, and the user's "off" always wins.
 */
export function capCacheWarmingMode(mode: CacheWarmingMode, cap: CacheWarmingMode): CacheWarmingMode {
	return CACHE_WARMING_MODES.indexOf(mode) <= CACHE_WARMING_MODES.indexOf(cap) ? mode : cap;
}

/**
 * How a streaming wait is bridged once warming is worth it: "auto" rents while
 * renting pays, then compacts or lets the entry expire, whichever is cheaper;
 * "keepalive" never compacts; "compact" compacts at the first decision when
 * the prompt reaches the bridge-compaction threshold.
 */
export type CacheWarmingStrategy = "auto" | "keepalive" | "compact";
export const CACHE_WARMING_STRATEGIES = ["auto", "keepalive", "compact"] as const;

/**
 * How a refresh reaches the provider: "prewarm" sends the request with
 * `max_tokens: 0` (no output billed), "replay" re-sends it with a one-token
 * output cap and cuts generation off.
 */
export type CacheWarmingRentMethod = "prewarm" | "replay";

/** Identity of a refresh actually sent to the provider. */
export interface CacheWarmingRefreshStart {
	phase: "streaming" | "idle";
	method: CacheWarmingRentMethod;
	provider: string;
	model: string;
}

/** Result of a refresh that {@link CacheWarmingRefreshStart} announced. */
export interface CacheWarmingRefreshEnd extends CacheWarmingRefreshStart {
	outcome: "hit" | "miss" | "error" | "aborted";
	/** Present only when onWarmed recorded this refresh, including an aborted one the provider had already accepted. */
	usage?: Usage;
	/**
	 * Why warming stopped; absent when warming continues (the refresh rescheduled, a rejected pre-warm fell back
	 * to a replay, or a new request replaced the run).
	 */
	warmingStopReason?: string;
}

/** Prompt-cache retention tier a request wrote its entry under. */
export type PromptCacheTier = "short" | "long";

/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh or bridge compaction is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from upstream usage over 5-minute entries;
 * per-session estimates were not better than this constant.
 */
const IDLE_CONTINUATION_PROBABILITY = 0.15;
/** Extension decide calls must answer inside the ten-second expiry margin. */
const CACHE_WARMING_DECIDE_TIMEOUT_MS = 2_000;
/**
 * Billed output tokens a replay is priced at before the session observed one
 * for the model. A replay is cut off at its first generated block, yet
 * measured replays were all billed more than one token, some over 16k.
 */
const REPLAY_OUTPUT_PRIOR_TOKENS = 512;
/** A bridge compaction is decided this long before its entry expires, so its request still reads the entry. */
const BRIDGE_COMPACTION_LEAD_MS = 60_000;
/** A refresh replacing a bridge compaction that never reached the provider must go out this long before expiry. */
const BRIDGE_FALLBACK_MARGIN_MS = 10_000;
/** Status reason while a bridge compaction holds the entry. */
const BRIDGE_IN_PROGRESS_REASON = "bridge compaction in progress";

/**
 * Prompt size from which a streaming wait may be bridged with compaction:
 * `percent` of the context window, capped at `tokens`. A model without a known
 * window uses `tokens`.
 */
export function resolveBridgeCompactionThreshold(contextWindow: number, percent: number, tokens: number): number {
	if (contextWindow <= 0) return tokens;
	return Math.min(Math.floor((contextWindow * percent) / 100), tokens);
}

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Whether the provider emits a real one-hour cache marker. Unsupported long
 * retention is emitted as the provider's default five-minute entry, so the
 * warmer must use that actual tier rather than a nonexistent long lifetime.
 */
function supportsLongCacheRetention(model: Model<Api>): boolean {
	const compat = model.compat;
	if (model.api === "anthropic-messages") {
		return (
			compat !== undefined && "supportsLongCacheRetention" in compat && compat.supportsLongCacheRetention === true
		);
	}
	// Factory Droid resolves long retention per upstream at request time, so
	// warming starts on the 5m tier and adopts 1h once a response reports it.
	// A model declaring only a 1h lifetime (a long-only `promptCache` override)
	// starts on 1h instead, and stops if a response reports a 5m write.
	if (model.api === "factory-droid-agent") return model.promptCache?.short === undefined;
	if (model.api === "bedrock-converse-stream") {
		return (
			compat !== undefined &&
			"supportsLongPromptCacheRetention" in compat &&
			compat.supportsLongPromptCacheRetention === true
		);
	}
	return true;
}

/**
 * Retention tier a request writes under, or undefined when caching is off.
 *
 * Mirrors the Anthropic provider's retention default (`getCacheControl`):
 * OAuth subscriber seats write 1h entries where the model supports them.
 * `resolveCacheRetention` keeps an explicit option or `PI_CACHE_RETENTION`
 * ahead of that fallback.
 */
export function resolvePromptCacheTier(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	isOAuthToken = false,
): PromptCacheTier | undefined {
	const longByDefault = isOAuthToken && model.api === "anthropic-messages" && supportsLongCacheRetention(model);
	const retention = resolveCacheRetention(options?.cacheRetention, longByDefault ? "long" : "short");
	if (retention === "none") return undefined;
	return retention === "long" && !supportsLongCacheRetention(model) ? "short" : retention;
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	isOAuthToken = false,
): number | undefined {
	const tier = resolvePromptCacheTier(model, options, isOAuthToken);
	const seconds = tier === undefined ? undefined : model.promptCache?.[tier];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Tier a completed response actually wrote, from the provider's per-TTL
 * cache-write breakdown (Anthropic `usage.cache_creation`). Undefined when the
 * response wrote nothing or the provider does not report the split.
 */
export function observedPromptCacheTier(usage: Usage): PromptCacheTier | undefined {
	if ((usage.cttl?.ephemeral1h ?? 0) > 0) return "long";
	if ((usage.cttl?.ephemeral5m ?? 0) > 0) return "short";
	return undefined;
}

/** Prompt size of a response: what its request sent, cached or not. */
export function promptTokensOf(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Whether `message` is the response to a request sent to `model`. A
 * server-side fallback retags the response with the served model, so its
 * fallback marker's `from` names the model the request went to.
 */
function answers(message: AssistantMessage, model: Model<Api>): boolean {
	if (message.provider !== model.provider) return false;
	if (message.model === model.id) return true;
	const fallback = message.content.find(block => block.type === "fallback");
	return fallback?.type === "fallback" && fallback.from.model === model.id;
}

/**
 * Whether replaying the request leaves its cache entry untouched. Anthropic
 * Messages and Converse budget-based reasoning derive a wire budget from
 * `max_tokens`; lowering the cap can change that budget and the cache key.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (model.api === "anthropic-messages") {
		const reasoningRequested = model.reasoning && options?.reasoning !== undefined && !options.forceReasoningOff;
		return !reasoningRequested || model.thinking?.mode === "anthropic-adaptive";
	}
	if (model.api === "bedrock-converse-stream") {
		const reasoningRequested =
			model.reasoning &&
			((options?.reasoning !== undefined && !options.disableReasoning && !options.forceReasoningOff) ||
				(model.thinking?.requiresEffort === true && !model.thinking.suppressWhenOff));
		if (!reasoningRequested) return true;
		return model.thinking?.mode === "anthropic-adaptive";
	}
	return true;
}

/**
 * True once the replay starts generating output. Providers with early cache
 * usage are cut off here; Converse must continue to terminal metadata under
 * its one-token wire cap.
 */
function isGenerationEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "image_end":
			return true;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		default:
			return false;
	}
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cttl">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

/** Price of writing `tokens` into the cache under `tier`; models without a write price bill the prompt as input. */
function writePrice(model: Model<Api>, tier: PromptCacheTier, tokens: number): number {
	if (model.cost.cacheWrite <= 0) return price(model, { input: tokens });
	return price(model, {
		cacheWrite: tokens,
		cttl: tier === "long" ? { ephemeral1h: tokens } : { ephemeral5m: tokens },
	});
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** "warm" sends a refresh, "compact" bridges the wait with compaction, "stop" lets the entry expire. */
export type CacheWarmingAction = "warm" | "compact" | "stop";

/** Inputs and outcome of one warming decision, as surfaced by the session status. */
export interface CacheWarmingDecision {
	/** "streaming" while the agent run that sent the request is still active. */
	phase: "streaming" | "idle";
	/** How a refresh would be sent; undefined when the request cannot be refreshed safely. */
	method?: CacheWarmingRentMethod;
	/** Price of this refresh: a cache read of the prompt, plus the expected billed output for a replay. 0 without a method. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost: re-writing the prompt instead of reading it. */
	missCost: number;
	/**
	 * Price of bridging with compaction instead: reading the prompt, generating the summary, and re-writing the
	 * compacted context. Undefined when compaction is not an option at this decision.
	 */
	compactCost?: number;
	/** Refresh spend since the last real request. */
	spentCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`. */
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	economicsAvailable: boolean;
	/**
	 * The warmer's decision. Idle: "warm" when `expectedSavings` is at least $0.05. Streaming: "warm" while that
	 * holds and `spentCost + warmCost` stays within the cheaper of `missCost` and `compactCost`; then "compact"
	 * when compaction saves at least $0.05 over `missCost`, else "stop".
	 */
	action: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a decision timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** While refreshing: when the provider sent the refresh. */
	sentAt?: number;
	/**
	 * When warming gives up while scheduled or refreshing: the idle window ends, or, while streaming, renting
	 * stops paying at current prices (undefined when it never would).
	 */
	stopsAt?: number;
	/** The pending decision, or the decision that stopped warming or started a bridge compaction. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions;
}

/** The slice of an assistant event stream the warmer consumes. */
export interface CacheWarmStream extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}

/** Size of what a bridge compaction would produce, as the host estimates it. */
export interface CacheBridgeEstimate {
	/** Output tokens of the summary. */
	summaryTokens: number;
	/** Prompt tokens of the compacted context the next request re-writes. */
	keptTokens: number;
}

/**
 * How a bridge compaction settled: "armed" when its result is ready to replace the history once the tool
 * returns; "failed-accepted" when it failed after a provider accepted its request (which read, so refreshed,
 * the entry); "failed-unaccepted" when it failed before any provider accepted it.
 */
export type CacheBridgeOutcome = "armed" | "failed-accepted" | "failed-unaccepted";

/** The host's compaction, for bridging a streaming wait whose renting stopped paying. */
export interface CacheBridgeCompactor {
	/** Bridging strategy, read live. */
	strategy(): CacheWarmingStrategy;
	/** Prompt size from which `model`'s waits may be bridged with compaction (see {@link resolveBridgeCompactionThreshold}). */
	thresholdTokens(model: Model<Api>): number;
	/** Cost inputs for compacting a `promptTokens` prompt, or undefined when no bridge-capable method can run now. */
	estimate(promptTokens: number): CacheBridgeEstimate | undefined;
	/**
	 * Starts compacting the history behind the pending tool call; resolves once that settles. The host owns it:
	 * a new request does not cancel it, and its armed result replaces the history at the tool's turn end.
	 */
	compact(): Promise<CacheBridgeOutcome>;
}

interface ActiveRun extends CacheWarmRequest {
	change: () => PromptCacheChange | undefined;
	tier: PromptCacheTier;
	delayMs: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** Set while a refresh or bridge compaction that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: NodeJS.Timeout;
	/**
	 * When the provider sent the refresh in progress (its `onPayload`); undefined while it waits for
	 * an in-flight slot or an extension's decision, when nothing has reached the provider yet.
	 */
	refreshSentAt?: number;
	warmingStopReason?: string;
	/** Cache entry this run's request writes; a refresh hit confirms and extends it. */
	entry: TrackedCacheEntry;
	/** The request can be refreshed without changing its cache key ({@link isReplayable}). */
	replayable: boolean;
	/** Dollars the provider billed for this run's refreshes. */
	spent: number;
	/** Decisions taken so far; the "compact" strategy compacts at the first. */
	decisions: number;
	/** A bridge compaction failed: the run's only buy-out is letting the entry expire. */
	bridgeFailed: boolean;
	/** The decision behind the bridge compaction in flight. */
	bridging?: CacheWarmingDecision;
}

/** Lifetime of the prompt cache entry the latest request wrote, independent of whether it is warmed. */
export interface PromptCacheEntry {
	/** When a request last wrote or read the entry (send time of the latest real or warm request). */
	touchedAt: number;
	/** Retention tier the entry was written under. */
	tier: PromptCacheTier;
	/** How long the provider keeps the entry after it was last touched. */
	ttlMs: number;
}

/**
 * The entry the latest confirmed request wrote, whatever the next request
 * would send differently: what that request would find in the cache.
 */
export interface ConfirmedPromptCacheEntry {
	model: Model<Api>;
	tier: PromptCacheTier;
	touchedAt: number;
	/** Undefined when the model declares no lifetime for the tier. */
	ttlMs?: number;
	/** Prompt size (input + cacheRead + cacheWrite) of the response that confirmed the entry. */
	promptTokens: number;
	/** What the next request sends differently, so it cannot read the entry. */
	change?: PromptCacheChange;
	/** A warm refresh of the entry missed the cache. */
	refreshMissed: boolean;
}

/**
 * What the next request sends differently from the one that wrote the entry, so it cannot read it. `history`:
 * the transcript was rewound, branched, compacted or replaced, so the armed request no longer leads it.
 */
export type PromptCacheChange =
	| { kind: "model"; from: string; to: string }
	| { kind: "thinking"; from: string; to: string }
	| { kind: "tools" }
	| { kind: "system-prompt" }
	| { kind: "retention" }
	| { kind: "history" };

/** What a warm refresh of the current conversation found: when it was sent and whether it read the cache. */
export interface CacheRefreshOutcome {
	sentAt: number;
	hit: boolean;
}

interface TrackedCacheEntry {
	model: Model<Api>;
	tier: PromptCacheTier;
	touchedAt: number;
	change: () => PromptCacheChange | undefined;
	refreshMissed?: boolean;
	promptTokens?: number;
}

/** Everything the warmer needs from its host; injected so the core stays session-agnostic. */
export interface CacheWarmerDeps {
	/**
	 * Streams a warm request. Must apply the same settings/provider wrapper the
	 * real turn used so the refresh lands on the same cache key.
	 */
	stream: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	) => CacheWarmStream | Promise<CacheWarmStream>;
	/** Prompt size (input + cacheRead + cacheWrite) of the most recent real provider response. */
	getPromptTokens: () => number;
	/** Current warming mode, read live so setting changes apply without re-arming. */
	getMode: () => CacheWarmingMode;
	/** Extension override hook; failures fall back to the warmer's own decision. */
	decide?: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Bridge compaction; without it a streaming wait is only rented or left to expire. */
	bridge?: CacheBridgeCompactor;
}

/** A decision and, when it stops warming, why. */
interface Evaluation {
	decision: CacheWarmingDecision;
	stopReason: string;
	/** A bridge compaction decided now still reads the entry before it expires. */
	compactNow: boolean;
}

/**
 * Keeps one prompt cache entry alive by refreshing its request before the
 * entry expires, or bridges the wait with compaction. `start` replaces any
 * previous run and restarts its refresh spend.
 */
export class CacheWarmer {
	#run?: ActiveRun;
	/** Entry the provider confirmed by reading or writing the prompt cache. */
	#entry?: TrackedCacheEntry;
	/** Entry the in-flight request will write, published only once its response confirms it. */
	#pendingEntry?: TrackedCacheEntry;
	#inactive: CacheWarmingStatus;
	readonly #deps: CacheWarmerDeps;
	/** Models whose endpoint rejected a pre-warm this session; they are refreshed by replay. */
	readonly #prewarmRefused = new Set<string>();
	/** Billed output of this session's replays, per model: the running mean prices the next replay. */
	readonly #replayOutput = new Map<string, { replays: number; tokens: number }>();
	/**
	 * Called with every paid warm response, including one that missed the cache or was aborted after acceptance.
	 * `refresh` is set when the response answered for the conversation as it still stands (not an error, not
	 * replaced or outdated): when it was sent, the moment a hit restarts the entry's lifetime, and whether it hit.
	 */
	onWarmed?: (message: AssistantMessage, extensionOverride: boolean, refresh: CacheRefreshOutcome | undefined) => void;
	/** Called when a refresh is handed to the stream; stop decisions, compactions and extension vetoes send nothing and skip it. */
	onRefreshStart?: (refresh: CacheWarmingRefreshStart) => void;
	/** Called exactly once after each onRefreshStart, unless the host cleared it (dispose) while the refresh was in flight. */
	onRefreshEnd?: (refresh: CacheWarmingRefreshEnd) => void;

	constructor(deps: CacheWarmerDeps) {
		this.#deps = deps;
		this.#inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		return this.#statusOf(this.#run?.change);
	}

	/**
	 * {@link confirmedEntry} with the warming {@link status}, evaluating what changed in the conversation once
	 * when the running warm-up keeps that same entry.
	 */
	get confirmedView(): { entry: ConfirmedPromptCacheEntry | undefined; warming: CacheWarmingStatus } {
		const entry = this.#entry;
		if (!entry) return { entry: undefined, warming: this.status };
		const change = entry.change();
		const runChange = this.#run?.change;
		return {
			entry: this.#confirmed(entry, change),
			warming: this.#statusOf(runChange === entry.change ? () => change : runChange),
		};
	}

	#statusOf(change: (() => PromptCacheChange | undefined) | undefined): CacheWarmingStatus {
		if (this.#deps.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.#run;
		if (!run || !change) return this.#inactive;
		if (change() !== undefined) return { state: "inactive", reason: "conversation context changed" };
		if (run.bridging) {
			return {
				state: "inactive",
				reason: BRIDGE_IN_PROGRESS_REASON,
				decision: run.bridging,
				extensionOverride: run.extensionOverride,
			};
		}
		const { decision } = this.#evaluate(run, run.nextWarmAt);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		const sentAt = refreshing ? run.refreshSentAt : undefined;
		const stopsAt = this.#stopsAt(run, decision);
		return {
			// A refresh still queued for a provider slot holds nothing off: the entry can lapse before it goes out.
			state: sentAt !== undefined ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			...(sentAt !== undefined ? { sentAt } : {}),
			...(stopsAt !== undefined ? { stopsAt } : {}),
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/**
	 * When warming is expected to give up: the idle window's end, or the streaming decision at which renting
	 * stops paying if prices hold. Undefined while streaming refreshes are free.
	 */
	#stopsAt(run: ActiveRun, decision: CacheWarmingDecision): number | undefined {
		if (run.phase === "idle") return run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (decision.action !== "warm") return run.nextWarmAt;
		if (decision.warmCost <= 0) return undefined;
		const buy =
			decision.compactCost !== undefined ? Math.min(decision.missCost, decision.compactCost) : decision.missCost;
		const affordable = Math.max(1, Math.floor((buy - decision.spentCost) / decision.warmCost));
		return run.nextWarmAt + affordable * run.delayMs;
	}

	/**
	 * Cache entry the latest confirmed request wrote, while the conversation
	 * still matches it. Tracked even when warming is off or the request cannot
	 * be replayed; undefined until a response reports cache usage, and when the
	 * model declares no lifetime for the tier or caching is off.
	 */
	get cacheEntry(): PromptCacheEntry | undefined {
		const entry = this.confirmedEntry;
		if (!entry || entry.change !== undefined || entry.ttlMs === undefined) return undefined;
		return { touchedAt: entry.touchedAt, tier: entry.tier, ttlMs: entry.ttlMs };
	}

	/** {@link cacheEntry} whether or not the conversation still matches it; undefined until a response reports cache usage. */
	get confirmedEntry(): ConfirmedPromptCacheEntry | undefined {
		const entry = this.#entry;
		return entry && this.#confirmed(entry, entry.change());
	}

	#confirmed(entry: TrackedCacheEntry, change: PromptCacheChange | undefined): ConfirmedPromptCacheEntry {
		const seconds = entry.model.promptCache?.[entry.tier];
		return {
			model: entry.model,
			tier: entry.tier,
			touchedAt: entry.touchedAt,
			ttlMs: seconds === undefined ? undefined : seconds * 1000,
			change,
			refreshMissed: entry.refreshMissed === true,
			promptTokens: entry.promptTokens ?? 0,
		};
	}

	/**
	 * Keep the prompt cache entry written by `request` warm until `change` reports a difference in the next request.
	 * Returns the request's dispatch hook: call it each time the provider sends the request (its `onPayload`),
	 * so the entry's lifetime counts from when it left rather than from a wait for a provider slot.
	 */
	start(request: CacheWarmRequest, change: () => PromptCacheChange | undefined): () => void {
		this.#clearRun();
		// A string key is classified up front. Resolver keys (rotating
		// credentials) cannot be inspected without consuming them; they start on
		// the short tier and `onResponse` switches to the tier the provider
		// reports having written.
		const apiKey = request.options.apiKey;
		const isOAuthToken =
			request.model.api === "anthropic-messages" && typeof apiKey === "string" && isAnthropicOAuthToken(apiKey);
		const tier = resolvePromptCacheTier(request.model, request.options, isOAuthToken);
		const entry = tier === undefined ? undefined : { model: request.model, tier, touchedAt: Date.now(), change };
		// The entry's lifetime, and so the next decision, counts from the send, past any wait for a provider slot.
		const dispatched = () => {
			if (!entry) return;
			entry.touchedAt = Date.now();
			const run = this.#run;
			if (run?.entry !== entry || run.timer === undefined) return;
			clearTimeout(run.timer);
			run.timer = undefined;
			this.#schedule(run);
		};
		this.#pendingEntry = entry;
		const mode = this.#deps.getMode();
		if (mode === "off") {
			this.#stop("cache warming disabled");
			return dispatched;
		}
		if (entry === undefined) {
			this.#stop("request disabled prompt caching");
			return dispatched;
		}
		const delayMs = this.#delayFor(request.model, entry.tier);
		if (delayMs === undefined) {
			this.#stop("cache lifetime unavailable");
			return dispatched;
		}
		this.#run = {
			...request,
			change,
			tier: entry.tier,
			entry,
			delayMs,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
			replayable: isReplayable(request.model, request.options),
			spent: 0,
			decisions: 0,
			bridgeFailed: false,
		};
		this.#schedule(this.#run);
		return dispatched;
	}

	/**
	 * Confirm the in-flight request's cache entry and adopt the retention tier
	 * its response actually wrote, so the schedule follows the provider's
	 * decision rather than a guess about the credential. A failed response, or
	 * one that neither read nor wrote the cache, never publishes its entry.
	 */
	onResponse(message: AssistantMessage): void {
		const observed = observedPromptCacheTier(message.usage);
		const pending = this.#pendingEntry;
		if (pending && answers(message, pending.model)) {
			this.#pendingEntry = undefined;
			if (message.stopReason !== "error" && (message.usage.cacheRead > 0 || message.usage.cacheWrite > 0)) {
				if (observed !== undefined) pending.tier = observed;
				pending.promptTokens = promptTokensOf(message.usage);
				this.#entry = pending;
			}
		}
		const run = this.#run;
		if (!run || run.timer === undefined) return;
		if (!answers(message, run.model)) return;
		if (observed === undefined || observed === run.tier) return;
		const delayMs = this.#delayFor(run.model, observed);
		if (delayMs === undefined) {
			this.#stop("cache lifetime unavailable");
			return;
		}
		clearTimeout(run.timer);
		run.timer = undefined;
		run.tier = observed;
		run.delayMs = delayMs;
		this.#schedule(run);
	}

	onAgentSettled(): void {
		const run = this.#run;
		if (!run) return;
		if (this.#deps.getMode() === "streaming") {
			this.#stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const reason = this.#idleStopReason(run);
		if (reason) this.#stop(reason);
	}

	/** Reconcile an active run after the effective warming mode changes. */
	onModeChanged(): void {
		const run = this.#run;
		if (!run) return;
		const reason = this.#getModeStopReason(run);
		if (reason) this.#stop(reason);
	}

	cancel(): void {
		this.#entry = undefined;
		this.#pendingEntry = undefined;
		this.#stop("inactive");
	}

	#delayFor(model: Model<Api>, tier: PromptCacheTier): number | undefined {
		const seconds = model.promptCache?.[tier];
		return seconds === undefined ? undefined : getCacheWarmingDelayMs(seconds * 1000);
	}

	/** When the run's entry expires, counted from its latest touch. */
	#expiresAt(run: ActiveRun): number | undefined {
		const seconds = run.model.promptCache?.[run.tier];
		return seconds === undefined ? undefined : run.entry.touchedAt + seconds * 1000;
	}

	/** Latest decision time at which a bridge compaction still reads the entry before it expires. */
	#compactDeadline(run: ActiveRun): number | undefined {
		const expiresAt = this.#expiresAt(run);
		if (expiresAt === undefined || expiresAt - BRIDGE_COMPACTION_LEAD_MS <= run.entry.touchedAt) return undefined;
		return expiresAt - BRIDGE_COMPACTION_LEAD_MS;
	}

	#idleStopReason(run: ActiveRun): string | undefined {
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (Date.now() >= deadline) return "30-minute idle safety limit reached";
		if (run.nextWarmAt <= deadline) return undefined;
		return run.delayMs >= MAX_IDLE_WARMING_AGE_MS
			? "cache entry outlives the 30-minute idle window"
			: "30-minute idle safety limit reached";
	}

	/** A refresh sent at `sentAt` left the run's entry in the cache: its lifetime restarts then, at the replay's size. */
	#touch(run: ActiveRun, sentAt: number, usage: Usage): void {
		run.entry.touchedAt = sentAt;
		run.entry.promptTokens = promptTokensOf(usage);
		this.#entry = run.entry;
		if (this.#pendingEntry === run.entry) this.#pendingEntry = undefined;
	}

	#clearRun(): void {
		const run = this.#run;
		if (!run) return;
		this.#run = undefined;
		clearTimeout(run.timer);
		run.controller.abort();
	}

	#stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		if (this.#run) this.#run.warmingStopReason = reason;
		this.#clearRun();
		this.#inactive = { state: "inactive", reason, ...stopped };
	}

	/**
	 * Arms the next decision: at the refresh point, or, while streaming, at the compaction deadline when the
	 * decision taken then would compact. A streaming request that cannot be refreshed and has no compaction
	 * ahead stops here.
	 */
	#schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		const now = Date.now();
		run.nextWarmAt = now + run.delayMs;
		if (run.phase === "idle") {
			const reason = this.#idleStopReason(run);
			if (reason) {
				this.#stop(reason);
				return;
			}
		} else {
			const deadline = this.#compactDeadline(run);
			if (deadline !== undefined && this.#evaluate(run, deadline).decision.action === "compact") {
				run.nextWarmAt = Math.max(now, deadline);
			} else if (!run.replayable) {
				this.#stop("request cannot be replayed safely");
				return;
			}
		}
		run.timer = setTimeout(() => void this.#decideAt(run), Math.max(0, run.nextWarmAt - now));
		run.timer.unref?.();
	}

	async #decide({ decision, compactNow }: Evaluation): Promise<CacheWarmingAction> {
		const decide = this.#deps.decide;
		if (!decide) return decision.action;
		// A slow extension must not push the refresh past the expiry margin: on
		// timeout the warmer's own decision stands.
		const { promise: timedOut, resolve } = Promise.withResolvers<undefined>();
		const timer = setTimeout(resolve, CACHE_WARMING_DECIDE_TIMEOUT_MS, undefined);
		try {
			const decided = await Promise.race([
				decide({
					type: "cache_warming_decision",
					...(decision.method !== undefined ? { method: decision.method } : {}),
					warmCost: decision.warmCost,
					missCost: decision.missCost,
					...(decision.compactCost !== undefined ? { compactCost: decision.compactCost } : {}),
					spentCost: decision.spentCost,
					continuationProbability: decision.continuationProbability,
					action: decision.action,
				}).then(override => ({ override })),
				timedOut,
			]);
			if (!decided) return decision.action;
			// An override the request cannot carry out leaves the warmer's decision standing.
			const override = decided.override;
			if (override === "warm" && decision.method === undefined) return decision.action;
			if (override === "compact" && !compactNow) return decision.action;
			return override;
		} catch {
			// Extension failures fall back to the warmer's own decision.
			return decision.action;
		} finally {
			clearTimeout(timer);
		}
	}

	async #decideAt(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		run.refreshSentAt = undefined;
		if (!this.#validateRun(run)) return;
		const evaluation = this.#evaluate(run, run.nextWarmAt);
		const { decision, stopReason } = evaluation;
		run.decisions++;
		const action = await this.#decide(evaluation);
		if (!this.#validateRun(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			this.#stop(extensionOverride ? "stopped by extension" : stopReason, { decision, extensionOverride });
			return;
		}
		if (action === "compact") {
			await this.#bridge(run, decision, extensionOverride);
			return;
		}
		// "warm" is only ever decided, or accepted from an extension, with a method.
		if (decision.method) await this.#refresh(run, decision.method, extensionOverride);
		else this.#stop("request cannot be replayed safely", { decision, extensionOverride });
	}

	/**
	 * Hands the wait to the host's bridge compaction. Its request reads the entry, so it holds the entry for
	 * one more lifetime either way; one that never reached the provider is replaced by a single refresh while
	 * the entry can still be refreshed.
	 */
	async #bridge(run: ActiveRun, decision: CacheWarmingDecision, extensionOverride: boolean): Promise<void> {
		run.bridging = decision;
		run.extensionOverride = extensionOverride;
		let outcome: CacheBridgeOutcome;
		try {
			outcome = (await this.#deps.bridge?.compact()) ?? "failed-unaccepted";
		} catch {
			outcome = "failed-unaccepted";
		}
		if (this.#run !== run) return;
		run.bridging = undefined;
		if (outcome === "armed") {
			this.#stop("bridged by compaction", { decision, extensionOverride });
			return;
		}
		run.bridgeFailed = true;
		if (outcome === "failed-unaccepted" && this.#validateRun(run)) {
			const method = this.#rentMethod(run);
			const expiresAt = this.#expiresAt(run);
			if (method && expiresAt !== undefined && Date.now() <= expiresAt - BRIDGE_FALLBACK_MARGIN_MS) {
				await this.#refresh(run, method, extensionOverride);
				return;
			}
		}
		if (this.#run === run) this.#stop("bridge compaction failed", { decision, extensionOverride });
	}

	/** Sends one refresh; a pre-warm the endpoint refuses is replayed in the same slot. */
	async #refresh(run: ActiveRun, method: CacheWarmingRentMethod, extensionOverride: boolean): Promise<void> {
		const refused = await this.#send(run, method, extensionOverride);
		if (refused && this.#validateRun(run)) await this.#send(run, "replay", extensionOverride);
	}

	/** Sends a refresh and settles the run on its outcome; true when the endpoint refused a pre-warm. */
	async #send(run: ActiveRun, method: CacheWarmingRentMethod, extensionOverride: boolean): Promise<boolean> {
		run.extensionOverride = extensionOverride;
		run.refreshSentAt = undefined;
		const refresh: CacheWarmingRefreshStart = {
			phase: run.phase,
			method,
			provider: run.model.provider,
			model: run.model.id,
		};
		this.onRefreshStart?.(refresh);
		let outcome: CacheWarmingRefreshEnd["outcome"] = "error";
		let usage: Usage | undefined;
		// Superseded by when the provider sends it, past any wait for an in-flight slot.
		const queuedAt = Date.now();
		try {
			const message = method === "prewarm" ? await this.#prewarm(run) : await this.#replay(run);
			const sentAt = run.refreshSentAt ?? queuedAt;
			// Record before the abort check: a refresh cancelled or replaced after the
			// provider accepted it was still billed, and spend tracking must see it.
			// Only a refresh that answered for the conversation as it still stands
			// says anything about that conversation's cache entry.
			if (message && message.usage.totalTokens > 0) {
				run.spent += message.usage.cost.total;
				if (method === "replay") this.#observeReplayOutput(run.model, message.usage.output);
				if (this.onWarmed) {
					const answered = message.stopReason !== "error" && this.#run === run && run.change() === undefined;
					this.onWarmed(
						message,
						extensionOverride,
						answered ? { sentAt, hit: message.usage.cacheRead > 0 && message.usage.cacheWrite === 0 } : undefined,
					);
					usage = message.usage;
				}
			}
			if (this.#run !== run) {
				outcome = "aborted";
				return false;
			}
			// Anthropic answers a pre-warm it does not take with `invalid_request_error`, an HTTP 400.
			if (method === "prewarm" && message?.stopReason === "error" && message.errorStatus === 400) {
				// This endpoint does not take a pre-warm for the model: replay instead, now and for the session.
				this.#prewarmRefused.add(modelKey(run.model));
				return true;
			}
			if (!message || message.stopReason === "error") {
				this.#stop("refresh failed");
				return false;
			}
			// A refresh that re-wrote the prefix (or read nothing) means the entry was
			// already gone or the refresh no longer lands on its key; further
			// refreshes would each pay a full write.
			if (message.usage.cacheRead <= 0 || message.usage.cacheWrite > 0) {
				outcome = "miss";
				// What it wrote, though, the next request reads: a new lifetime from the refresh's send.
				if (message.usage.cacheWrite > 0) this.#touch(run, sentAt, message.usage);
				else run.entry.refreshMissed = true;
				this.#stop("refresh missed the cache");
				return false;
			}
			outcome = "hit";
			// A hit proves the run's entry exists even before its own response
			// confirmed it, and restarts its lifetime.
			this.#touch(run, sentAt, message.usage);
			if (this.#validateRun(run)) this.#schedule(run);
		} finally {
			this.onRefreshEnd?.({
				...refresh,
				outcome,
				...(usage ? { usage } : {}),
				...(run.warmingStopReason ? { warmingStopReason: run.warmingStopReason } : {}),
			});
		}
		return false;
	}

	/** Sends the request with `max_tokens: 0`: the provider reads the prompt and returns usage without generating. */
	async #prewarm(run: ActiveRun): Promise<AssistantMessage | undefined> {
		const onPayload = run.options.onPayload;
		let stream: CacheWarmStream;
		try {
			stream = await this.#deps.stream(run.model, run.context, {
				...run.options,
				prewarm: true,
				signal: run.controller.signal,
				onPayload: (payload, model, signal) => {
					run.refreshSentAt = Date.now();
					return onPayload?.(payload, model, signal);
				},
			});
		} catch {
			return undefined;
		}
		try {
			for await (const event of stream) {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
			}
		} catch {
			// A broken stream still settles its result below.
		}
		try {
			return await stream.result();
		} catch {
			return undefined;
		}
	}

	/**
	 * Requests one output token. Anthropic Messages cuts off at its first
	 * generated block after reporting early cache usage. Converse suppresses
	 * adaptive allowance and runs to terminal metadata under a true one-token
	 * total-generation cap.
	 */
	async #replay(run: ActiveRun): Promise<AssistantMessage | undefined> {
		const cutoff = new AbortController();
		let stream: CacheWarmStream;
		const onPayload = run.options.onPayload;
		const replayOptions: SimpleStreamOptions = {
			...run.options,
			maxTokens: 1,
			signal: AbortSignal.any([run.controller.signal, cutoff.signal]),
			onPayload: (payload, model, signal) => {
				run.refreshSentAt = Date.now();
				return onPayload?.(payload, model, signal);
			},
		};
		if (run.model.api === "bedrock-converse-stream" && run.model.thinking?.mode === "anthropic-adaptive") {
			// Adaptive Converse ignores thinkingBudgets on the wire. Zero each
			// supported effort so the generic mapper cannot inflate maxTokens,
			// including after mandatory-effort normalization selects its default.
			const thinkingBudgets = { ...run.options.thinkingBudgets };
			for (const effort of run.model.thinking.efforts) thinkingBudgets[effort] = 0;
			replayOptions.thinkingBudgets = thinkingBudgets;
		}
		try {
			stream = await this.#deps.stream(run.model, run.context, replayOptions);
		} catch {
			return undefined;
		}
		const needsTerminalUsage = run.model.api === "bedrock-converse-stream";
		let partial: AssistantMessage | undefined;
		try {
			for await (const event of stream) {
				if (event.type === "done") return event.message;
				if (event.type === "error") {
					if (event.error.stopReason !== "aborted") return event.error;
					break;
				}
				partial = event.partial;
				if (isGenerationEvent(event) && !needsTerminalUsage) {
					// The reason tells the provider's prompt-cache diagnostics this abort
					// is the planned cutoff, so the observed cache usage is kept.
					cutoff.abort(new PromptCacheCutoff());
					break;
				}
			}
		} catch {
			// Stream failures past acceptance still carry the envelope's usage.
		}
		try {
			await stream.result();
		} catch {
			// The deliberate cutoff surfaces as an aborted result.
		}
		if (!partial) return undefined;
		const usage: Usage = { ...partial.usage };
		usage.cost = calculateCost(run.model, usage);
		return { ...partial, usage, stopReason: "aborted" };
	}

	#observeReplayOutput(model: Model<Api>, outputTokens: number): void {
		const key = modelKey(model);
		const observed = this.#replayOutput.get(key) ?? { replays: 0, tokens: 0 };
		observed.replays++;
		observed.tokens += outputTokens;
		this.#replayOutput.set(key, observed);
	}

	/** Billed output a replay of `model` is expected to cost: this session's running mean, before that the prior. */
	#expectedReplayOutput(model: Model<Api>): number {
		const observed = this.#replayOutput.get(modelKey(model));
		return observed ? observed.tokens / observed.replays : REPLAY_OUTPUT_PRIOR_TOKENS;
	}

	/** The safest refresh the request supports, or undefined when refreshing it could change its cache key. */
	#rentMethod(run: ActiveRun): CacheWarmingRentMethod | undefined {
		if (!run.replayable) return undefined;
		// The endpoint refuses `max_tokens: 0` with a forced tool choice.
		const toolChoice = run.options.toolChoice;
		const prewarm =
			isPromptCachePrewarmSupported(run.model) &&
			(toolChoice === undefined || toolChoice === "auto" || toolChoice === "none") &&
			!this.#prewarmRefused.has(modelKey(run.model));
		return prewarm ? "prewarm" : "replay";
	}

	/**
	 * Price of bridging the run's wait with compaction, or undefined when compaction is not a buy-out: no
	 * compactor or bridge-capable method, the "keepalive" strategy, a failed bridge, a prompt under the
	 * threshold, or an entry too short-lived to compact before it expires.
	 */
	#compactCost(run: ActiveRun, promptTokens: number): number | undefined {
		const bridge = this.#deps.bridge;
		if (!bridge || run.bridgeFailed || bridge.strategy() === "keepalive") return undefined;
		if (promptTokens < bridge.thresholdTokens(run.model)) return undefined;
		if (this.#compactDeadline(run) === undefined) return undefined;
		const estimate = bridge.estimate(promptTokens);
		if (!estimate) return undefined;
		const model = run.model;
		const kept = Math.min(estimate.keptTokens, promptTokens);
		return (
			price(model, { cacheRead: promptTokens }) +
			price(model, { output: estimate.summaryTokens }) +
			Math.max(0, writePrice(model, run.tier, kept) - price(model, { cacheRead: kept }))
		);
	}

	#validateRun(run: ActiveRun): boolean {
		if (this.#run !== run) return false;
		const reason =
			this.#getModeStopReason(run) ?? (run.change() !== undefined ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.#stop(reason);
		return false;
	}

	#getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.#deps.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	/** Prices the decision taken at `decisionAt` and makes it. */
	#evaluate(run: ActiveRun, decisionAt: number): Evaluation {
		const model = run.model;
		const promptTokens = this.#deps.getPromptTokens();
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = writePrice(model, run.tier, promptTokens);
		const method = this.#rentMethod(run);
		const warmCost =
			method === undefined
				? 0
				: method === "prewarm"
					? cacheHitCost
					: cacheHitCost + price(model, { output: this.#expectedReplayOutput(model) });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		const compactCost = run.phase === "streaming" ? this.#compactCost(run, promptTokens) : undefined;
		const deadline = this.#compactDeadline(run);
		const compactNow = compactCost !== undefined && deadline !== undefined && decisionAt <= deadline;
		const decision: CacheWarmingDecision = {
			phase: run.phase,
			...(method !== undefined ? { method } : {}),
			warmCost,
			missCost,
			...(compactCost !== undefined ? { compactCost } : {}),
			spentCost: run.spent,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: "stop",
		};
		const stopReason = !economicsAvailable
			? "cache economics unavailable"
			: method === undefined
				? "request cannot be replayed safely"
				: expectedSavings < CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS
					? "expected savings below threshold"
					: "refresh spend reached the cost of losing the cache";
		decision.action = this.#act(run, decision, compactNow);
		return { decision, stopReason, compactNow };
	}

	/**
	 * The warmer's action on priced `decision`. Idle: refresh while the expected savings clear the floor.
	 * Streaming (ski rental): refresh while the spend so far plus this refresh stays within the cheapest
	 * buy-out, then compact when that saves at least the floor over letting the entry expire, else stop. A
	 * compaction found too late to read the entry before it expires waits one more refresh.
	 */
	#act(run: ActiveRun, decision: CacheWarmingDecision, compactNow: boolean): CacheWarmingAction {
		if (!decision.economicsAvailable) return "stop";
		const rentPays =
			decision.method !== undefined && decision.expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS;
		if (decision.phase === "idle") return rentPays ? "warm" : "stop";
		const { compactCost, missCost } = decision;
		if (compactNow && run.decisions === 0 && this.#deps.bridge?.strategy() === "compact") return "compact";
		const buyCost = compactCost !== undefined ? Math.min(missCost, compactCost) : missCost;
		if (rentPays && decision.spentCost + decision.warmCost <= buyCost) return "warm";
		if (compactCost !== undefined && missCost - compactCost >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS) {
			if (compactNow) return "compact";
			if (rentPays) return "warm";
		}
		return "stop";
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const rent = decision.method ? `${decision.method} ${formatDollars(decision.warmCost)}` : "no safe refresh";
	if (decision.phase === "idle") {
		const probability = Math.round(decision.continuationProbability * 100);
		const comparison = decision.expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? ">=" : "<";
		return `${rent}, ${probability}% continuation probability, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
	}
	const buy =
		decision.compactCost !== undefined && decision.compactCost < decision.missCost
			? `compact ${formatDollars(decision.compactCost)}`
			: `expire ${formatDollars(decision.missCost)}`;
	return `${rent}, spent ${formatDollars(decision.spentCost)} of buy-out ${buy}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line human-readable warming status for hosts that surface it. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once the warmer (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") {
		const verb = status.reason === BRIDGE_IN_PROGRESS_REASON ? "Compacting" : "Stopped";
		return status.reason ? `${verb} (${status.reason}; ${details})` : `${verb} (${details})`;
	}
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}
