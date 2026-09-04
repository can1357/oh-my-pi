import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelTokenizer } from "@oh-my-pi/pi-catalog/types";
import * as natives from "@oh-my-pi/pi-natives";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import type { AgentMessage } from "./types";

const testEnv = Bun.env.NODE_ENV === "test";
const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && !testEnv;

const NATIVE_ENCODING: Record<ModelTokenizer, natives.Encoding> = {
	"claude-v3": natives.Encoding.ClaudeV3,
	"claude-v47": natives.Encoding.ClaudeV47,
	"claude-v5": natives.Encoding.ClaudeV5,
	"claude-v5-sonnet": natives.Encoding.ClaudeV5Sonnet,
	qwen3: natives.Encoding.Qwen3,
	"deepseek-v3": natives.Encoding.DeepSeekV3,
	"kimi-k2": natives.Encoding.KimiK2,
	glm5: natives.Encoding.Glm5,
};

/** Maps the catalog-resolved tokenizer family to its native implementation. */
export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): natives.Encoding | null {
	return model?.tokenizer ? NATIVE_ENCODING[model.tokenizer] : null;
}

/**
 * `strict` always tries an exact native count (the catalog-resolved tokenizer
 * when known, o200k_base otherwise), falling back to the byte upper bound when
 * the loaded addon does not recognize that encoding. `approximate` and
 * `upperbound` prefer the same exact count for known tokenizer families or
 * when `PI_TOKENIZER_ACCURATE=1` is set; otherwise they use a cheap heuristic:
 * `approximate` a bytes/4 guess, `upperbound` the raw byte length (never
 * undercounts).
 */
export type TokenCountMode = "strict" | "approximate" | "upperbound";

/** Options for {@link Tokenizer.countMessage} / {@link Tokenizer.countMessages}. */
export interface MessageCountOptions {
	/**
	 * Drop opaque provider reasoning payloads (`thinkingSignature`,
	 * `redactedThinking`, native server-tool blocks) from the estimate. Those
	 * are billed by the provider on replay, so the default counts them — but
	 * their *local* byte size can diverge wildly from what the provider
	 * charges, so the compaction floor (which only needs the reliably-countable,
	 * on-wire-compressible content) excludes them to avoid false triggers on
	 * thinking-heavy turns.
	 */
	excludeEncryptedReasoning?: boolean;
}

function byteEstimate(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function sumFragments(text: string | string[], perFragment: (t: string) => number): number {
	return Array.isArray(text) ? text.reduce((sum, t) => sum + perFragment(t), 0) : perFragment(text);
}

interface NativeTokenCount {
	tokens: number;
	exact: boolean;
}

function countTokensNat(
	text: string | string[],
	encoding: natives.Encoding | null | undefined,
	mode: TokenCountMode,
): NativeTokenCount {
	try {
		return { tokens: natives.countTokens(text, encoding), exact: true };
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(!error.message.includes("does not match any variant of enum") &&
				!error.message.includes("unknown enum variant"))
		) {
			throw error;
		}
		const tokens = sumFragments(text, mode === "approximate" ? byteEstimate : byteLength);
		return { tokens, exact: false };
	}
}

/** Verdict from {@link Tokenizer.checkTokenBudget}. */
export interface TokenBudgetCheck {
	/** Whether the text fits the budget. */
	fits: boolean;
	/**
	 * Token count behind the verdict: the exact native count when `exact` is
	 * set, otherwise the conservative byte upper bound.
	 */
	tokens: number;
	/** Whether `tokens` came from the exact native tokenizer. */
	exact: boolean;
}

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Memoized estimates for one message under this tokenizer's encoding, split by
 * the {@link MessageCountOptions.excludeEncryptedReasoning} option so the two
 * variants never collide. `version` snapshots {@link messageEstimateVersion} at
 * write time; an owner mutation (prune/shake/strip-images) bumps the version,
 * which invalidates the entry in every live Tokenizer at once.
 */
interface MessageEstimate {
	version: number;
	default?: number;
	floored?: number;
}

/**
 * Model-aware local token counter. Immutable: the catalog-resolved encoding
 * is fixed at construction, so a cached count can never straddle two
 * encodings. An `Agent` owns one for its active model (swapping the instance
 * when the model's encoding changes); one-shot flows construct their own for
 * the model that will be billed. Known tokenizer families use exact native
 * counts; unknown models keep the fast byte estimate (or o200k when
 * `PI_TOKENIZER_ACCURATE=1`).
 */
export class Tokenizer {
	readonly #encoding: natives.Encoding | null;

	/**
	 * Per-message estimate memo. Keyed by message identity, deliberately not a
	 * symbol-tagged property: callers spread messages to derive throwaway
	 * variants for counting (`estimateBranchSummaryTokens` does
	 * `countMessage({ ...message, content: truncated })`), and a property-borne
	 * cache would ride along the spread. Identity keying gives clones a fresh
	 * count.
	 */
	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	constructor(model?: Pick<Model, "tokenizer"> | null) {
		this.#encoding = tokenizerEncodingForModel(model);
	}

	get encoding(): natives.Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (mode === "strict") return countTokensNat(text, this.#encoding, mode).tokens;
		if (!testEnv && this.#encoding !== null) return countTokensNat(text, this.#encoding, mode).tokens;
		if (accurate) return countTokensNat(text, undefined, mode).tokens;
		return sumFragments(text, mode === "upperbound" ? byteLength : byteEstimate);
	}

	/**
	 * Cheap-first budget probe — the way to ask "does this fit in `budget`
	 * tokens?" without tokenizing the world.
	 *
	 * Byte length is a hard upper bound on token count (every token consumes at
	 * least one input byte), so text whose raw bytes already fit the budget
	 * cannot possibly exceed it — that verdict is returned without tokenizing at
	 * all. Only text that busts the bound is ambiguous, and only that case pays
	 * for the exact count. Since the bound overshoots ~4x on ordinary prose, the
	 * common "comfortably under budget" answer is free.
	 */
	checkTokenBudget(text: string | string[], budget: number): TokenBudgetCheck {
		const bound = sumFragments(text, byteLength);
		if (bound <= budget) return { fits: true, tokens: bound, exact: false };
		const result = countTokensNat(text, this.#encoding, "strict");
		return { fits: result.tokens <= budget, tokens: result.tokens, exact: result.exact };
	}

	/**
	 * Token estimate for one message under this tokenizer's encoding.
	 *
	 * Settled historical messages are counted once and reused until an owner
	 * (prune/shake/strip-images) calls `invalidateMessageCache`; streaming
	 * assistants bypass the memo entirely (see the message-cache settle-gate
	 * invariant). Image blocks charge a fixed per-image estimate.
	 */
	countMessage(message: AgentMessage, options?: MessageCountOptions): number {
		const floored = options?.excludeEncryptedReasoning === true;
		if (!isEstimateCacheable(message)) return this.#measureMessage(message, floored);
		const version = messageEstimateVersion(message);
		let entry = this.#estimates.get(message);
		if (entry === undefined || entry.version !== version) {
			entry = { version };
			this.#estimates.set(message, entry);
		}
		const cached = floored ? entry.floored : entry.default;
		if (cached !== undefined) return cached;
		const result = this.#measureMessage(message, floored);
		if (floored) entry.floored = result;
		else entry.default = result;
		return result;
	}

	/** Sum of {@link countMessage} over `messages`. */
	countMessages(messages: readonly AgentMessage[], options?: MessageCountOptions): number {
		let total = 0;
		for (const message of messages) total += this.countMessage(message, options);
		return total;
	}

	#measureMessage(message: AgentMessage, excludeEncryptedReasoning: boolean): number {
		const fragments: string[] = [];
		let extra = 0;
		// Declaration-merged app roles (the coding-agent's bashExecution) are
		// invisible to this package's union, so the discriminant is read as data.
		const role: string = message.role;
		if (role === "bashExecution") {
			if ("command" in message && typeof message.command === "string") fragments.push(message.command);
			if ("output" in message && typeof message.output === "string") fragments.push(message.output);
			return fragments.length === 0 ? 0 : this.countTokens(fragments);
		}

		switch (message.role) {
			case "user": {
				const content: string | Array<{ type: string; text?: string }> = message.content;
				if (typeof content === "string") {
					fragments.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						}
					}
				}
				break;
			}
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "text") {
						fragments.push(block.text);
					} else if (block.type === "thinking") {
						fragments.push(block.thinking);
						// Providers charge for the opaque signature/reasoning payload that
						// rides alongside the thinking text (OpenAI Responses encrypted
						// reasoning items, Anthropic signed thinking blocks, etc.). Without
						// counting it, this estimator can read ~half of the provider-reported
						// usage on thinking-heavy turns — see #2275 for the resulting
						// compaction-trigger / post-check metric divergence. The compaction
						// floor excludes it (its local byte size diverges from provider billing).
						if (block.thinkingSignature && !excludeEncryptedReasoning) {
							fragments.push(block.thinkingSignature);
						}
					} else if (block.type === "toolCall") {
						fragments.push(block.name);
						fragments.push(stringifyJson(block.arguments) ?? "null");
					} else if (block.type === "redactedThinking") {
						// Encrypted reasoning blob the provider still bills for on replay;
						// excluded from the compaction floor for the same reason as above.
						if (!excludeEncryptedReasoning) fragments.push(block.data);
					} else if (block.type === "anthropicServerTool") {
						// Native Anthropic server-tool call/result replayed verbatim on the
						// wire (server_tool_use input and opaque result content). The provider
						// still bills for it on same-provider replay; excluded from the
						// compaction floor like other encrypted reasoning because its local
						// byte size diverges from provider billing.
						if (!excludeEncryptedReasoning) fragments.push(stringifyJson(block.block) ?? "null");
					}
				}
				break;
			}
			case "hookMessage":
			case "toolResult": {
				if (typeof message.content === "string") {
					fragments.push(message.content);
				} else {
					for (const block of message.content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += IMAGE_TOKEN_ESTIMATE;
						}
					}
				}
				break;
			}
			case "branchSummary":
			case "compactionSummary": {
				fragments.push(message.summary);
				if (message.role === "compactionSummary") {
					if (message.blocks) {
						for (const block of message.blocks) {
							if (block.type === "text") fragments.push(block.text);
							else extra += snapcompact.FRAME_TOKEN_ESTIMATE;
						}
					} else if (message.images) {
						// Snapcompact frames render at ≥1568px; providers bill the downscaled cap.
						extra += message.images.length * snapcompact.FRAME_TOKEN_ESTIMATE;
					}
				}
				break;
			}
			default:
				return 0;
		}

		if (fragments.length === 0) return extra;
		return extra + this.countTokens(fragments);
	}
}
