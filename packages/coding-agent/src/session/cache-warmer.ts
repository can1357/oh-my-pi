/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap shortly before the entry expires.
 *
 * Ported from upstream pi's cache warmer (earendil-works/pi): a refresh is
 * scheduled at 90% of the model's declared prompt-cache lifetime (at least
 * ten seconds before expiry) and only fires when the expected avoided
 * cache-miss cost minus the refresh cost clears a savings floor. Warming runs
 * in two phases — "streaming" while the agent run that sent the request is
 * still active, "idle" after it settles — and stops on context change, mode
 * change, or fixed safety windows (60 min streaming / 30 min idle).
 *
 * A model is warmed only when its catalog entry (or a models.yml `promptCache`
 * override) declares a lifetime for the retention tier the request used, so
 * providers whose replay behavior is unvalidated are never touched.
 */
import {
	type Api,
	type AssistantMessage,
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

/** Streaming warming never continues past this long after the real request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from upstream usage; per-session estimates were
 * not better than this constant.
 */
const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 *
 * Mirrors the Anthropic provider's retention default: OAuth subscriber seats
 * write 1h entries where the model supports them, so an OAuth request with no
 * explicit retention schedules against the `long` tier. `resolveCacheRetention`
 * keeps an explicit option or `PI_CACHE_RETENTION` ahead of the fallback.
 * Callers that cannot inspect the credential pass `false` — that direction of
 * mismatch only over-warms a longer-lived entry (cheap reads), never misses one.
 */
export function getPromptCacheTtlMs(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	isOAuthToken = false,
): number | undefined {
	// Mirror the provider's OAuth default (see `getCacheControl`): subscriber
	// seats write 1h entries where the model supports long retention.
	const supportsLongCacheRetention =
		model.api === "anthropic-messages" &&
		isOAuthToken &&
		(model as Model<"anthropic-messages">).compat.supportsLongCacheRetention;
	const fallback = supportsLongCacheRetention ? "long" : "short";
	const retention = resolveCacheRetention(options?.cacheRetention, fallback);
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking modes derive
 * `budget_tokens` from `max_tokens`; the replay would get a different budget,
 * which Anthropic keys the message cache on, and the model could still think
 * for thousands of tokens. Adaptive (effort-driven) thinking keys on the
 * effort selector, which the replay preserves.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (model.api !== "anthropic-messages") return true;
	const reasoningRequested = model.reasoning && options?.reasoning !== undefined && !options.forceReasoningOff;
	if (!reasoningRequested) return true;
	return model.thinking?.mode === "anthropic-adaptive";
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

interface ActiveRun extends CacheWarmRequest {
	isCurrent: () => boolean;
	delayMs: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: NodeJS.Timeout;
}

/** Everything the warmer needs from its host; injected so the core stays session-agnostic. */
export interface CacheWarmerDeps {
	/**
	 * Streams a warm request. Must apply the same settings/provider wrapper the
	 * real turn used so the replay lands on the same cache key. Only the
	 * completed message is consumed.
	 */
	stream: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	) => { result(): Promise<AssistantMessage> } | Promise<{ result(): Promise<AssistantMessage> }>;
	/** Prompt size (input + cacheRead + cacheWrite) of the most recent real provider response. */
	getPromptTokens: () => number;
	/** Current warming mode, read live so setting changes apply without re-arming. */
	getMode: () => CacheWarmingMode;
	/** Extension override hook; failures fall back to the warmer's own decision. */
	decide?: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
}

/** Extension decide calls must answer inside the ten-second expiry margin. */
const CACHE_WARMING_DECIDE_TIMEOUT_MS = 2_000;

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	#run?: ActiveRun;
	#inactive: CacheWarmingStatus;
	readonly #deps: CacheWarmerDeps;
	/** Called with the completed warm response after each successful refresh. */
	onWarmed?: (message: AssistantMessage, extensionOverride: boolean) => void;

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
		// Mirror the provider's OAuth detection: a string key can be classified
		// directly; resolver/credential-storage keys fall back to the short tier,
		// which only ever over-warms a longer-lived entry.
		const apiKey = request.options.apiKey;
		const isOAuthToken =
			request.model.api === "anthropic-messages" && typeof apiKey === "string" && isAnthropicOAuthToken(apiKey);
		const ttlMs = getPromptCacheTtlMs(request.model, request.options, isOAuthToken);
		if (ttlMs === undefined) {
			this.#stop(
				resolveCacheRetention(request.options.cacheRetention) === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.#stop("cache lifetime unavailable");
			return;
		}
		this.#run = {
			...request,
			isCurrent,
			delayMs,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.#schedule(this.#run);
	}

	onAgentSettled(): void {
		const run = this.#run;
		if (!run) return;
		if (this.#deps.getMode() === "streaming") {
			this.#stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.#stop("30-minute idle safety limit reached");
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		const run = this.#run;
		if (!run) return;
		const reason = this.#getModeStopReason(run);
		if (reason) this.#stop(reason);
	}

	cancel(): void {
		this.#stop("inactive");
	}

	#clearRun(): void {
		const run = this.#run;
		if (!run) return;
		this.#run = undefined;
		clearTimeout(run.timer);
		run.controller.abort();
	}

	#stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.#clearRun();
		this.#inactive = { state: "inactive", reason, ...stopped };
	}

	#schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = Date.now() + run.delayMs;
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.#stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.#refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	async #refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.#validateRun(run)) return;
		const decision = this.#evaluate(run);
		const { warmCost, missCost, continuationProbability } = decision;
		let action = decision.action;
		const decide = this.#deps.decide;
		if (decide) {
			try {
				// A slow extension must not push the replay past the expiry margin:
				// on timeout the warmer's own decision stands.
				const decided = await Promise.race([
					decide({
						type: "cache_warming_decision",
						warmCost,
						missCost,
						continuationProbability,
						action,
					}).then(override => ({ override })),
					Bun.sleep(CACHE_WARMING_DECIDE_TIMEOUT_MS).then(() => undefined),
				]);
				if (decided) action = decided.override;
			} catch {
				// Extension failures fall back to the warmer's own decision.
			}
		}
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
		try {
			const stream = await this.#deps.stream(run.model, run.context, {
				...run.options,
				maxTokens: 1,
				signal: run.controller.signal,
			});
			const message = await stream.result();
			if (!this.#validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				this.onWarmed?.(message, extensionOverride);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.#run === run) this.#schedule(run);
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
