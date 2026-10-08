/**
 * Keeps one prompt cache entry alive by replaying its request shortly before
 * the entry expires.
 *
 * Ported from upstream pi's cache warmer (earendil-works/pi): a refresh is
 * scheduled at 90% of the model's declared prompt-cache lifetime (at least
 * ten seconds before expiry) and only fires when the expected avoided
 * cache-miss cost minus the refresh cost clears a savings floor. Warming runs
 * in two phases — "streaming" while the agent run that sent the request is
 * still active, "idle" after it settles — and stops on context change, mode
 * change, a refresh that misses the cache, or fixed safety windows (60 min
 * streaming / 30 min idle). An entry whose lifetime outlasts the idle window
 * (Anthropic's 1h tier) is therefore only warmed while a run is active.
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
	resolveCacheRetention,
	type SimpleStreamOptions,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../extensibility/shared-events";

export type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult };

/** Warming mode: "off" disables it, "streaming" protects active runs, "idle" also covers gaps between runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;

/** Identity of a refresh actually sent to the provider. */
export interface CacheWarmingRefreshStart {
	phase: "streaming" | "idle";
	provider: string;
	model: string;
}

/** Result of a refresh that {@link CacheWarmingRefreshStart} announced. */
export interface CacheWarmingRefreshEnd extends CacheWarmingRefreshStart {
	outcome: "hit" | "miss" | "error" | "aborted";
	/** Present only when onWarmed recorded this refresh, including an aborted one the provider had already accepted. */
	usage?: Usage;
	/** Why warming stopped; absent when warming continues (the refresh rescheduled, or a new request replaced the run). */
	warmingStopReason?: string;
}

/** Prompt-cache retention tier a request wrote its entry under. */
export type PromptCacheTier = "short" | "long";

/** Streaming warming never continues past this long after the real request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from upstream usage over 5-minute entries;
 * per-session estimates were not better than this constant.
 */
const IDLE_CONTINUATION_PROBABILITY = 0.15;
/** Extension decide calls must answer inside the ten-second expiry margin. */
const CACHE_WARMING_DECIDE_TIMEOUT_MS = 2_000;

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
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
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

export type CacheWarmingAction = "warm" | "stop";

/** Inputs and outcome of one warm-or-stop decision, as surfaced by the session status. */
export interface CacheWarmingDecision {
	/** "streaming" while the agent run that sent the request is still active. */
	phase: "streaming" | "idle";
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`. */
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	economicsAvailable: boolean;
	/** The warmer's decision: "warm" when `expectedSavings` is at least $0.05. */
	action: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
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

interface ActiveRun extends CacheWarmRequest {
	isCurrent: () => boolean;
	tier: PromptCacheTier;
	delayMs: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: NodeJS.Timeout;
	warmingStopReason?: string;
}

/** Everything the warmer needs from its host; injected so the core stays session-agnostic. */
export interface CacheWarmerDeps {
	/**
	 * Streams a warm request. Must apply the same settings/provider wrapper the
	 * real turn used so the replay lands on the same cache key.
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
}

/**
 * Keeps one prompt cache entry alive by replaying its request before the entry
 * expires. `start` replaces any previous run; warm requests never extend the
 * fixed safety windows.
 */
export class CacheWarmer {
	#run?: ActiveRun;
	#inactive: CacheWarmingStatus;
	readonly #deps: CacheWarmerDeps;
	/** Called with every paid warm response, including one that missed the cache or was aborted after acceptance. */
	onWarmed?: (message: AssistantMessage, extensionOverride: boolean) => void;
	/** Called when a refresh is handed to the stream; stop decisions and extension vetoes send nothing and skip it. */
	onRefreshStart?: (refresh: CacheWarmingRefreshStart) => void;
	/** Called exactly once after each onRefreshStart, unless the host cleared it (dispose) while the refresh was in flight. */
	onRefreshEnd?: (refresh: CacheWarmingRefreshEnd) => void;

	constructor(deps: CacheWarmerDeps) {
		this.#deps = deps;
		this.#inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		if (this.#deps.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.#run;
		if (!run) return this.#inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.#evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.#clearRun();
		const mode = this.#deps.getMode();
		if (mode === "off") {
			this.#stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.#stop("request cannot be replayed safely");
			return;
		}
		// A string key is classified up front. Resolver keys (rotating
		// credentials) cannot be inspected without consuming them; they start on
		// the short tier and `onResponse` switches to the tier the provider
		// reports having written.
		const apiKey = request.options.apiKey;
		const isOAuthToken =
			request.model.api === "anthropic-messages" && typeof apiKey === "string" && isAnthropicOAuthToken(apiKey);
		const tier = resolvePromptCacheTier(request.model, request.options, isOAuthToken);
		if (tier === undefined) {
			this.#stop("request disabled prompt caching");
			return;
		}
		const delayMs = this.#delayFor(request.model, tier);
		if (delayMs === undefined) {
			this.#stop("cache lifetime unavailable");
			return;
		}
		this.#run = {
			...request,
			isCurrent,
			tier,
			delayMs,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.#schedule(this.#run);
	}

	/**
	 * Adopt the retention tier the armed request's response actually wrote, so
	 * the schedule follows the provider's decision rather than a guess about
	 * the credential.
	 */
	onResponse(message: AssistantMessage): void {
		const run = this.#run;
		if (!run || run.timer === undefined) return;
		if (message.provider !== run.model.provider || message.model !== run.model.id) return;
		const tier = observedPromptCacheTier(message.usage);
		if (tier === undefined || tier === run.tier) return;
		const delayMs = this.#delayFor(run.model, tier);
		if (delayMs === undefined) return;
		clearTimeout(run.timer);
		run.timer = undefined;
		run.tier = tier;
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
		this.#stop("inactive");
	}

	#delayFor(model: Model<Api>, tier: PromptCacheTier): number | undefined {
		const seconds = model.promptCache?.[tier];
		return seconds === undefined ? undefined : getCacheWarmingDelayMs(seconds * 1000);
	}

	#idleStopReason(run: ActiveRun): string | undefined {
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (Date.now() >= deadline) return "30-minute idle safety limit reached";
		if (run.nextWarmAt <= deadline) return undefined;
		return run.delayMs >= MAX_IDLE_WARMING_AGE_MS
			? "cache entry outlives the 30-minute idle window"
			: "30-minute idle safety limit reached";
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

	#schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = Date.now() + run.delayMs;
		const reason =
			run.phase === "idle"
				? this.#idleStopReason(run)
				: run.nextWarmAt > run.startedAt + MAX_WARMING_AGE_MS
					? "one-hour safety limit reached"
					: undefined;
		if (reason) {
			this.#stop(reason);
			return;
		}
		run.timer = setTimeout(() => void this.#refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	async #decide(decision: CacheWarmingDecision): Promise<CacheWarmingAction> {
		const decide = this.#deps.decide;
		if (!decide) return decision.action;
		// A slow extension must not push the replay past the expiry margin: on
		// timeout the warmer's own decision stands.
		const { promise: timedOut, resolve } = Promise.withResolvers<undefined>();
		const timer = setTimeout(resolve, CACHE_WARMING_DECIDE_TIMEOUT_MS, undefined);
		try {
			const decided = await Promise.race([
				decide({
					type: "cache_warming_decision",
					warmCost: decision.warmCost,
					missCost: decision.missCost,
					continuationProbability: decision.continuationProbability,
					action: decision.action,
				}).then(override => ({ override })),
				timedOut,
			]);
			return decided ? decided.override : decision.action;
		} catch {
			// Extension failures fall back to the warmer's own decision.
			return decision.action;
		} finally {
			clearTimeout(timer);
		}
	}

	async #refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.#validateRun(run)) return;
		const decision = this.#evaluate(run);
		const action = await this.#decide(decision);
		if (!this.#validateRun(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.#stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		const refresh: CacheWarmingRefreshStart = {
			phase: run.phase,
			provider: run.model.provider,
			model: run.model.id,
		};
		this.onRefreshStart?.(refresh);
		let outcome: CacheWarmingRefreshEnd["outcome"] = "error";
		let usage: Usage | undefined;
		try {
			const message = await this.#replay(run);
			// Record before the abort check: a refresh cancelled or replaced after the
			// provider accepted it was still billed, and spend tracking must see it.
			if (message && message.usage.totalTokens > 0 && this.onWarmed) {
				this.onWarmed(message, extensionOverride);
				usage = message.usage;
			}
			if (this.#run !== run) {
				outcome = "aborted";
				return;
			}
			if (!message || message.stopReason === "error") {
				this.#stop("refresh failed");
				return;
			}
			// A replay that re-wrote the prefix (or read nothing) means the entry was
			// already gone or the replay no longer lands on its key; further
			// refreshes would each pay a full write.
			if (message.usage.cacheRead <= 0 || message.usage.cacheWrite > 0) {
				outcome = "miss";
				this.#stop("refresh missed the cache");
				return;
			}
			outcome = "hit";
			if (!this.#validateRun(run)) return;
			this.#schedule(run);
		} finally {
			this.onRefreshEnd?.({
				...refresh,
				outcome,
				...(usage ? { usage } : {}),
				...(run.warmingStopReason ? { warmingStopReason: run.warmingStopReason } : {}),
			});
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
		const replayOptions: SimpleStreamOptions = {
			...run.options,
			maxTokens: 1,
			signal: AbortSignal.any([run.controller.signal, cutoff.signal]),
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
					cutoff.abort();
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

	#validateRun(run: ActiveRun): boolean {
		if (this.#run !== run) return false;
		const reason = this.#getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
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

	#evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const promptTokens = this.#deps.getPromptTokens();
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
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
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}
