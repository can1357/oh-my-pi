/**
 * Prompt-cache observability: per-request cache metrics plus attributed causes
 * for every cache break.
 *
 * Providers only report *that* cached tokens were read (`usage.cacheRead`);
 * they never say *why* a break happened. This tracker fingerprints each
 * outbound request (system prompt, tool list, message prefix, model) and, when
 * the response usage shows the cache missed, names the harness-side change
 * that broke it — or flags the break as provider-side (TTL expiry, eviction)
 * when nothing changed on our end.
 *
 * Prefix stability is the top harness-level cost lever (cache reads bill at
 * ~10% of input rate), so unattributed breaks are the first thing to chase
 * when spend regresses.
 */

import type { AssistantMessage, Context, Model, Usage } from "@pk-nerdsaver-ai/pi-ai";
import type { AgentMessage } from "./types";

/** Harness-side change classes that can break a provider prefix cache. */
export type CacheBreakCause =
	| "system-prompt-change"
	| "tool-list-change"
	| "history-rewrite"
	| "model-change"
	| "provider-side";

/** Host-declared reason for an intentional history rewrite (prune, compaction, …). */
export type HistoryRewriteReason = "prune" | "compaction" | "branch" | "restore" | "other";

export interface CacheTraceEvent {
	/** provider/model the request went to. */
	readonly model: string;
	/** Prompt tokens billed for this request (input + cacheRead + cacheWrite). */
	readonly promptTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly uncachedInputTokens: number;
	/**
	 * Prompt tokens billed on the previous request — the upper bound on what a
	 * perfectly stable prefix could have re-read from cache this turn.
	 */
	readonly previousPromptTokens: number | undefined;
	/** cacheRead / previousPromptTokens; undefined on the first request. */
	readonly hitRatio: number | undefined;
	/** True when this request re-read meaningfully less than the prior prefix. */
	readonly broke: boolean;
	/**
	 * Harness-side changes detected between this request and the previous one.
	 * Populated on every trace (even cache hits — a change after the last
	 * breakpoint doesn't break the cache). On a break with no detected change,
	 * `causes` is `["provider-side"]`.
	 */
	readonly causes: readonly CacheBreakCause[];
	/** Host-declared reason when `causes` includes `history-rewrite`. */
	readonly rewriteReason: HistoryRewriteReason | undefined;
	/** Index of the first mutated message when a history rewrite was detected. */
	readonly firstDivergence: number | undefined;
}

export interface CacheStats {
	readonly requests: number;
	readonly promptTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly uncachedInputTokens: number;
	/** Lifetime cacheRead / promptTokens across all requests. */
	readonly hitRate: number;
	readonly breaks: number;
	readonly breaksByCause: Readonly<Record<CacheBreakCause, number>>;
	/** False until the provider reports any cache usage; stats are then meaningful. */
	readonly cachingObserved: boolean;
}

/**
 * A request re-reading less than this share of the previous prompt counts as
 * a break. Well above partial-suffix misses (a new user turn re-caches only
 * the tail) and well below any genuine prefix hit.
 */
const BREAK_RATIO = 0.5;

/**
 * Prompts shorter than this can't be cached by the strictest provider minimum
 * (Anthropic: 1024 tokens), so misses on them attribute nothing.
 */
const MIN_CACHEABLE_PROMPT_TOKENS = 1024;

interface RequestFingerprint {
	readonly modelKey: string;
	readonly systemPromptHash: bigint;
	readonly toolsHash: bigint;
	readonly messageHashes: readonly bigint[];
}

const EMPTY_CAUSES: readonly CacheBreakCause[] = [];

export class CacheAttributionTracker {
	#messageHashes = new WeakMap<object, bigint>();
	#toolHashes = new WeakMap<object, bigint>();
	#previous: RequestFingerprint | undefined;
	#previousPromptTokens: number | undefined;
	#inflight: { fingerprint: RequestFingerprint; causes: CacheBreakCause[]; firstDivergence: number | undefined };
	#declaredRewrite: HistoryRewriteReason | undefined;
	#cachingObserved = false;
	#onTrace: ((trace: CacheTraceEvent) => void) | undefined;

	#requests = 0;
	#promptTokens = 0;
	#cacheReadTokens = 0;
	#cacheWriteTokens = 0;
	#uncachedInputTokens = 0;
	#breaks = 0;
	#breaksByCause: Record<CacheBreakCause, number> = {
		"system-prompt-change": 0,
		"tool-list-change": 0,
		"history-rewrite": 0,
		"model-change": 0,
		"provider-side": 0,
	};

	constructor(options?: { onTrace?: (trace: CacheTraceEvent) => void }) {
		this.#onTrace = options?.onTrace;
		this.#inflight = {
			fingerprint: { modelKey: "", systemPromptHash: 0n, toolsHash: 0n, messageHashes: [] },
			causes: [],
			firstDivergence: undefined,
		};
	}

	/**
	 * Host signal: the message history is about to be (or was just) rewritten
	 * on purpose. Consumed by the next request's attribution so the break is
	 * labeled with the host's reason instead of an anonymous mutation.
	 */
	noteHistoryRewrite(reason: HistoryRewriteReason): void {
		this.#declaredRewrite = reason;
	}

	/**
	 * Fingerprint the outbound request. Call once per provider request with the
	 * post-transform inputs — the message list the request is built from and
	 * the final wire context (system prompt + tools).
	 */
	observeRequest(messages: readonly AgentMessage[], context: Context, model: Model): void {
		const fingerprint: RequestFingerprint = {
			modelKey: `${model.provider}/${model.id}`,
			systemPromptHash: this.#hashSystemPrompt(context.systemPrompt),
			toolsHash: this.#hashTools(context.tools),
			messageHashes: messages.map(message => this.#hashMessage(message)),
		};

		const causes: CacheBreakCause[] = [];
		let firstDivergence: number | undefined;
		const previous = this.#previous;
		if (previous) {
			if (fingerprint.modelKey !== previous.modelKey) causes.push("model-change");
			if (fingerprint.systemPromptHash !== previous.systemPromptHash) causes.push("system-prompt-change");
			if (fingerprint.toolsHash !== previous.toolsHash) causes.push("tool-list-change");
			firstDivergence = findFirstDivergence(previous.messageHashes, fingerprint.messageHashes);
			if (firstDivergence !== undefined) causes.push("history-rewrite");
		}

		this.#inflight = { fingerprint, causes, firstDivergence };
	}

	/**
	 * Record the response usage for the request last passed to
	 * {@link observeRequest}, classify any cache break, and emit a trace.
	 * Returns the trace, or undefined when the message carries no usage.
	 */
	observeUsage(message: Pick<AssistantMessage, "usage" | "stopReason">): CacheTraceEvent | undefined {
		const usage = message.usage;
		const promptTokens = usage ? usagePromptTokens(usage) : 0;
		if (!usage || promptTokens <= 0) return undefined;

		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		if (cacheRead > 0 || cacheWrite > 0) this.#cachingObserved = true;

		const previousPromptTokens = this.#previousPromptTokens;
		const hitRatio =
			previousPromptTokens !== undefined && previousPromptTokens > 0 ? cacheRead / previousPromptTokens : undefined;
		const attributable =
			this.#cachingObserved &&
			previousPromptTokens !== undefined &&
			previousPromptTokens >= MIN_CACHEABLE_PROMPT_TOKENS;
		const broke = attributable && hitRatio !== undefined && hitRatio < BREAK_RATIO;

		let causes: readonly CacheBreakCause[] = this.#inflight.causes;
		const rewriteReason = causes.includes("history-rewrite") ? (this.#declaredRewrite ?? "other") : undefined;
		if (broke && causes.length === 0) causes = ["provider-side"];
		if (!broke && causes.length === 0) causes = EMPTY_CAUSES;

		const trace: CacheTraceEvent = {
			model: this.#inflight.fingerprint.modelKey,
			promptTokens,
			cacheReadTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
			uncachedInputTokens: usage.input ?? 0,
			previousPromptTokens,
			hitRatio,
			broke,
			causes,
			rewriteReason,
			firstDivergence: this.#inflight.firstDivergence,
		};

		this.#requests += 1;
		this.#promptTokens += promptTokens;
		this.#cacheReadTokens += cacheRead;
		this.#cacheWriteTokens += cacheWrite;
		this.#uncachedInputTokens += usage.input ?? 0;
		if (broke) {
			this.#breaks += 1;
			for (const cause of causes) this.#breaksByCause[cause] += 1;
		}

		this.#previous = this.#inflight.fingerprint;
		this.#previousPromptTokens = promptTokens;
		this.#declaredRewrite = undefined;

		this.#onTrace?.(trace);
		return trace;
	}

	stats(): CacheStats {
		return {
			requests: this.#requests,
			promptTokens: this.#promptTokens,
			cacheReadTokens: this.#cacheReadTokens,
			cacheWriteTokens: this.#cacheWriteTokens,
			uncachedInputTokens: this.#uncachedInputTokens,
			hitRate: this.#promptTokens > 0 ? this.#cacheReadTokens / this.#promptTokens : 0,
			breaks: this.#breaks,
			breaksByCause: { ...this.#breaksByCause },
			cachingObserved: this.#cachingObserved,
		};
	}

	#hashMessage(message: AgentMessage): bigint {
		const key = message as object;
		let hash = this.#messageHashes.get(key);
		if (hash === undefined) {
			hash = hashJson(message);
			this.#messageHashes.set(key, hash);
		}
		return hash;
	}

	#hashSystemPrompt(systemPrompt: Context["systemPrompt"]): bigint {
		if (!systemPrompt) return 0n;
		const text = typeof systemPrompt === "string" ? systemPrompt : systemPrompt.join("\0");
		return Bun.hash.wyhash(text);
	}

	#hashTools(tools: Context["tools"]): bigint {
		if (!tools || tools.length === 0) return 0n;
		// Order matters: providers serialize tools in array order, so a reorder
		// changes wire bytes even when the set is identical.
		let combined = 1n;
		for (const tool of tools) {
			let hash = this.#toolHashes.get(tool);
			if (hash === undefined) {
				hash = hashJson({ name: tool.name, description: tool.description, parameters: tool.parameters });
				this.#toolHashes.set(tool, hash);
			}
			combined = BigInt.asUintN(64, combined * 1099511628211n + hash);
		}
		return combined;
	}
}

function usagePromptTokens(usage: Usage): number {
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (prompt > 0) return prompt;
	return usage.totalTokens ?? 0;
}

function findFirstDivergence(previous: readonly bigint[], current: readonly bigint[]): number | undefined {
	// A pure append keeps every previously sent message identical; any change
	// inside the previously sent range is a rewrite. Messages dropped from the
	// end count too (shorter history rewrites the prefix at the cut).
	const sharedLength = Math.min(previous.length, current.length);
	for (let i = 0; i < sharedLength; i++) {
		if (previous[i] !== current[i]) return i;
	}
	if (current.length < previous.length) return current.length;
	return undefined;
}

function hashJson(value: unknown): bigint {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "";
	} catch {
		serialized = String(value);
	}
	return Bun.hash.wyhash(serialized);
}
