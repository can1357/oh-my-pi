import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect/demotion";
import { ollamaChatDropsOwnThinking } from "@oh-my-pi/pi-ai/providers/ollama";
import { isColdReplayableResponsesTurn } from "@oh-my-pi/pi-ai/providers/openai-shared";
import {
	isSameModelTurn,
	shouldDropTruncatedThinkingOnlyAssistant,
} from "@oh-my-pi/pi-ai/providers/transform-messages";
import {
	getOpenAIResponsesHistoryItems,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "@oh-my-pi/pi-ai/utils";
import { resolveThinkingReplayTokens, type ThinkingReplayTokens } from "@oh-my-pi/pi-catalog/compat/thinking-replay";
import type { ModelTokenizer } from "@oh-my-pi/pi-catalog/types";
import * as natives from "@oh-my-pi/pi-natives";
import { materializeString, stringifyJson } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import { base64ImageSize, estimateImageTokens, type ImageDetail, type ImageSize } from "./image-tokens";
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
	o200k: natives.Encoding.O200kBase,
};

/** Maps the catalog-resolved tokenizer family to its native implementation. */
export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): natives.Encoding | null {
	return model?.tokenizer ? NATIVE_ENCODING[model.tokenizer] : null;
}

type TokenizerModel = Pick<Model, "tokenizer"> &
	snapcompact.ShapeTarget & { compat?: Model["compat"]; thinking?: Model["thinking"] };

/** The model an assistant turn's native reasoning (signed thinking, Responses history) is replayed to. */
interface ReasoningReplayReader {
	api: string;
	provider: string;
	id: string;
}

function reasoningReplayReader(model: TokenizerModel | null | undefined): ReasoningReplayReader | undefined {
	if (!model?.api || !model.provider || !model.id) return undefined;
	// Filtering targets strip native reasoning items before the request is encoded.
	const compat = model.compat;
	if (compat && "filterReasoningHistory" in compat && compat.filterReasoningHistory) return undefined;
	return { api: model.api, provider: model.provider, id: model.id };
}

/** Identity of the reader whose replayed reasoning a {@link Tokenizer} counts; equal keys count it alike. */
export function reasoningReplayKey(model: TokenizerModel | null | undefined): string {
	const reader = reasoningReplayReader(model);
	return reader ? `${reader.api}\0${reader.provider}\0${reader.id}` : "";
}

/** Request state a {@link Tokenizer} counts for, beyond its model. */
export interface TokenizerOptions {
	/**
	 * Whether the request replays native Responses history (pi-ai's
	 * `openAIResponsesReplaysNativeHistory`). A cold session rebuilds a turn
	 * holding encrypted reasoning from its text and tool calls, without the
	 * reasoning or its signature. Default: true.
	 */
	nativeHistoryReplay?: boolean;
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
	 * are billed by the provider on replay, so the default counts them (a reader
	 * billing replayed thinking at `output` size: the reasoning, at its turn's
	 * output size) — but their *local* byte size can diverge wildly from what
	 * the provider charges, so the compaction floor (which only needs the
	 * reliably-countable, on-wire-compressible content) excludes them to avoid
	 * false triggers on thinking-heavy turns.
	 * Native Responses reasoning that actually replays is not an opaque byte
	 * guess: it is charged at the turn's provider-reported reasoning tokens in
	 * both arms.
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

// Growing streamed text and large tool results must not evict the reusable
// short fragments. Account for UTF-16 key storage plus a per-entry allowance.
const NATIVE_CACHE_MAX_LENGTH = 16 * 1024;

function countNativeFragment(
	text: string,
	encoding: natives.Encoding | null | undefined,
	counts: LRUCache<string, number>,
): number {
	if (text.length > NATIVE_CACHE_MAX_LENGTH) return natives.countTokens(text, encoding);
	const cached = counts.get(text);
	if (cached !== undefined) return cached;
	const tokens = natives.countTokens(text, encoding);
	// Detach sliced strings so a small key cannot retain a much larger source.
	counts.set(materializeString(text), tokens);
	return tokens;
}

function countTokensNat(
	text: string | string[],
	encoding: natives.Encoding | null | undefined,
	mode: TokenCountMode,
	counts: LRUCache<string, number>,
): NativeTokenCount {
	try {
		let tokens: number;
		if (typeof text === "string") {
			tokens = countNativeFragment(text, encoding, counts);
		} else if (text.length > 0 && text.length < 16) {
			// The native API sums independent fragments, not their concatenation.
			// Keep its parallel batch path for arrays of 16 or more fragments.
			tokens = 0;
			for (const fragment of text) tokens += countNativeFragment(fragment, encoding, counts);
		} else {
			tokens = natives.countTokens(text, encoding);
		}
		return { tokens, exact: true };
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
 * when the model's encoding, image or thinking-replay pricing, replay
 * identity or native-history replay state changes); one-shot flows construct
 * their own for the model that will be billed. Known tokenizer families use
 * exact native counts; unknown models keep the fast byte estimate (or o200k
 * when `PI_TOKENIZER_ACCURATE=1`).
 */
export class Tokenizer {
	readonly #encoding: natives.Encoding | null;
	readonly #frameBilling: snapcompact.FrameBilling;
	readonly frameBillingKey: string;
	readonly #reasoningReader: ReasoningReplayReader | undefined;
	readonly #dropsOllamaThinking: boolean;
	/** Claude's own API and prefix-bound hosts keep another model's signature from their deployment. */
	readonly #readsDeploymentSignatures: boolean;
	readonly reasoningReplayKey: string;
	/** How the reader bills replayed signed thinking (catalog `thinking-replay-tokens`). */
	readonly thinkingReplayTokens: ThinkingReplayTokens;
	/** Whether the counted request replays native Responses history; see {@link TokenizerOptions}. */
	readonly nativeHistoryReplay: boolean;

	/** Exact counts only; byte fallbacks remain mode-dependent and uncached. */
	readonly #nativeCounts = new LRUCache<string, number>({
		max: 256,
		maxSize: 512 * 1024,
		sizeCalculation: (_tokens, text) => text.length * 2 + 64,
	});

	/**
	 * Per-message estimate memo. Keyed by message identity, deliberately not a
	 * symbol-tagged property: callers spread messages to derive throwaway
	 * variants for counting (`estimateBranchSummaryTokens` does
	 * `countMessage({ ...message, content: truncated })`), and a property-borne
	 * cache would ride along the spread. Identity keying gives clones a fresh
	 * count.
	 */
	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	/**
	 * Counts what `streamSimple` sends `model`. Its catalog compat decides
	 * whether Responses reasoning history is filtered: `streamOpenAIResponses`'
	 * per-request `filterReasoningHistory` override is a debugging hook
	 * `streamSimple` never forwards, so a caller using it passes `model` with
	 * that compat set.
	 */
	constructor(model?: TokenizerModel | null, options?: TokenizerOptions) {
		this.#encoding = tokenizerEncodingForModel(model);
		this.#frameBilling = snapcompact.frameBilling(model ?? undefined);
		this.frameBillingKey = snapcompact.frameBillingKey(this.#frameBilling);
		this.#reasoningReader = reasoningReplayReader(model);
		this.#dropsOllamaThinking = ollamaChatDropsOwnThinking(model);
		const compat = model?.compat;
		this.#readsDeploymentSignatures =
			model?.api === "anthropic-messages" &&
			((compat !== undefined && "officialEndpoint" in compat && compat.officialEndpoint) ||
				model.thinking?.prefixBinding === true);
		this.reasoningReplayKey = reasoningReplayKey(model);
		this.thinkingReplayTokens = resolveThinkingReplayTokens(model ?? {});
		this.nativeHistoryReplay = options?.nativeHistoryReplay ?? true;
	}

	get encoding(): natives.Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (mode === "strict") return countTokensNat(text, this.#encoding, mode, this.#nativeCounts).tokens;
		if (!testEnv && this.#encoding !== null)
			return countTokensNat(text, this.#encoding, mode, this.#nativeCounts).tokens;
		if (accurate) return countTokensNat(text, undefined, mode, this.#nativeCounts).tokens;
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
		const result = countTokensNat(text, this.#encoding, "strict", this.#nativeCounts);
		return { fits: result.tokens <= budget, tokens: result.tokens, exact: result.exact };
	}

	/**
	 * Token estimate for one message under this tokenizer's encoding.
	 *
	 * Settled historical messages are counted once and reused until an owner
	 * (prune/shake/strip-images) calls `invalidateMessageCache`; streaming
	 * assistants bypass the memo entirely (see the message-cache settle-gate
	 * invariant). Image blocks charge {@link imageTokens}, the same estimate
	 * the native remote-compaction probe applies.
	 */
	countMessage(message: AgentMessage, options?: MessageCountOptions): number {
		const floored = options?.excludeEncryptedReasoning === true;
		if (!isEstimateCacheable(message)) return this.#measureMessage(message, floored, false);
		const version = messageEstimateVersion(message);
		let entry = this.#estimates.get(message);
		if (entry === undefined || entry.version !== version) {
			entry = { version };
			this.#estimates.set(message, entry);
		}
		const cached = floored ? entry.floored : entry.default;
		if (cached !== undefined) return cached;
		const result = this.#measureMessage(message, floored, false);
		if (floored) entry.floored = result;
		else entry.default = result;
		return result;
	}

	/**
	 * {@link countMessage} for the transcript's latest surviving assistant turn
	 * (`isSurvivingAssistant`), which an Anthropic Messages replay keeps
	 * byte-for-byte (`transformMessages`): a turn whose tool calls ended without
	 * a tool-use stop keeps its signatures then, so its reasoning is charged. A
	 * count of one message cannot see its position; a caller walking back from
	 * the end of the transcript counts that turn here. Not memoized: it differs
	 * from {@link countMessage} only for that one turn.
	 */
	countLatestTurn(message: AgentMessage, options?: MessageCountOptions): number {
		return this.#measureMessage(message, options?.excludeEncryptedReasoning === true, true);
	}

	/** Sum of {@link countMessage} over `messages`. */
	countMessages(messages: readonly AgentMessage[], options?: MessageCountOptions): number {
		let total = 0;
		for (const message of messages) total += this.countMessage(message, options);
		return total;
	}

	/**
	 * Input tokens for one image (not a snapcompact frame) under the reader's
	 * catalog image rule, or the generic estimate when it has none.
	 */
	imageTokens(size: ImageSize | null | undefined, detail?: ImageDetail): number {
		return estimateImageTokens(size, detail, this.#frameBilling.rule);
	}

	/**
	 * Whether `message`'s signed reasoning reaches this reader natively: from
	 * the same model, host and wire, or from another Claude model on the same
	 * Anthropic deployment, which keeps the signature (`transformMessages`).
	 * Claude bills that reasoning when the reader can read it and drops the
	 * block otherwise, so such a turn counts high rather than low.
	 */
	#replaysReasoningNatively(message: AssistantMessage): boolean {
		const reader = this.#reasoningReader;
		return (
			reader !== undefined &&
			message.api === reader.api &&
			message.provider === reader.provider &&
			(message.model === reader.id || this.#readsDeploymentSignatures)
		);
	}

	/**
	 * The replayed native Responses reasoning {@link countMessage} charges
	 * across `messages`: the part of a count that changes with the reading
	 * model. A replay whose backend reported no reasoning tokens counts at the
	 * signature price `countMessage` gives it.
	 */
	replayedReasoningTokens(messages: readonly AgentMessage[]): number {
		let total = 0;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const replayed = this.#replayedReasoningTokens(message);
			total +=
				replayed === null
					? this.countMessage(message) - this.countMessage(message, { excludeEncryptedReasoning: true })
					: (replayed ?? 0);
		}
		return total;
	}

	#measureMessage(message: AgentMessage, excludeEncryptedReasoning: boolean, latestTurn: boolean): number {
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
			case "user":
			case "developer": {
				// Both roles carry `string | (TextContent | ImageContent)[]` and both are
				// sent to the provider -- convertMessageToLlm handles developer alongside
				// user -- so they are counted alike. Without the developer case the switch
				// fell through to `default: return 0`, and the old annotation narrowed the
				// blocks to text-only, hiding the image charge the toolResult arm applies.
				const content = message.content;
				if (typeof content === "string") {
					fragments.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += this.imageTokens(base64ImageSize(block.data), block.detail);
						}
					}
				}
				break;
			}
			case "assistant": {
				// Replayed native Responses reasoning is billed as input at the turn's
				// reported reasoning tokens, not at its ~3x larger ciphertext size, so it
				// is a token price and counts in both arms. Its thinking signature never
				// reaches the wire then (the payload items replay instead); a turn whose
				// backend reported no reasoning tokens keeps the signature as its price.
				const replayedReasoning = this.#replayedReasoningTokens(message);
				const ollamaReader = this.#reasoningReader?.api === "ollama-chat" ? this.#reasoningReader : undefined;
				const ownOllamaTurn = ollamaReader !== undefined && isSameModelTurn(message, ollamaReader);
				if (typeof replayedReasoning === "number") extra += replayedReasoning;
				const signaturesPriced = this.thinkingReplayTokens === "signature";
				// The replay's signature rule (`transformMessages`): an aborted or
				// errored turn's final block can hold a partial signature, and a turn
				// whose tool calls ended without a tool-use stop is abandoned, so all
				// its signatures are stripped. Every other block completed. On the
				// Anthropic Messages API the latest assistant turn keeps an abandoned
				// turn's signatures byte-for-byte (Bedrock's Converse replay strips
				// them too); a per-message count cannot see position, so it follows
				// the rule for older turns unless the caller says it is the latest
				// (`countLatestTurn`).
				const content = message.content;
				const invalidStop = message.stopReason === "aborted" || message.stopReason === "error";
				const keepsLatestSignatures = latestTurn && message.api === "anthropic-messages";
				const abandonedToolUse =
					!keepsLatestSignatures &&
					!invalidStop &&
					message.stopReason !== "toolUse" &&
					content.some(block => block.type === "toolCall");
				const untrustedIndex = invalidStop ? content.length - 1 : -1;
				let signedReasoning = false;
				for (let index = 0; index < content.length; index++) {
					const block = content[index];
					if (block.type === "text") {
						fragments.push(block.text);
					} else if (block.type === "thinking") {
						// `transformMessages` drops another model's empty thinking and demotes the
						// rest to visible text; only the reader's own thinking stays native.
						if (ollamaReader && !ownOllamaTurn) {
							if (block.thinking.trim()) fragments.push(renderDemotedThinking(ollamaReader.id, block.thinking));
							continue;
						}
						if (this.#dropsOllamaThinking && ownOllamaTurn) continue;
						fragments.push(block.thinking);
						// Providers charge for the opaque signature/reasoning payload that
						// rides alongside the thinking text (OpenAI Responses encrypted
						// reasoning items, Gemini thought signatures). A reader billing at
						// `output` size (Claude) charges the reasoning, priced below, not
						// these bytes. The compaction floor excludes it (its local byte size
						// diverges from provider billing).
						if (
							block.thinkingSignature &&
							!excludeEncryptedReasoning &&
							signaturesPriced &&
							typeof replayedReasoning !== "number"
						) {
							fragments.push(block.thinkingSignature);
						}
						if (block.thinkingSignature && !abandonedToolUse && index !== untrustedIndex) signedReasoning = true;
					} else if (block.type === "toolCall") {
						fragments.push(block.name);
						fragments.push(stringifyJson(block.arguments) ?? "null");
					} else if (block.type === "redactedThinking") {
						// Encrypted reasoning blob the provider still bills for on replay;
						// excluded from the compaction floor for the same reason as above.
						signedReasoning = true;
						if (!excludeEncryptedReasoning && signaturesPriced) fragments.push(block.data);
					} else if (block.type === "anthropicServerTool") {
						// Native Anthropic server-tool call/result replayed verbatim on the
						// wire (server_tool_use input and opaque result content). The provider
						// still bills for it on same-provider replay; excluded from the
						// compaction floor like other encrypted reasoning because its local
						// byte size diverges from provider billing.
						if (!excludeEncryptedReasoning) fragments.push(stringifyJson(block.block) ?? "null");
					}
				}
				// The visible text undercounts a native replay: the provider rebuilds
				// the full reasoning from its signature, billed at the turn's output
				// size less the visible text shake has since elided from it. The
				// floor keeps the visible count.
				if (
					signedReasoning &&
					!excludeEncryptedReasoning &&
					!signaturesPriced &&
					this.#replaysReasoningNatively(message)
				) {
					const visible = fragments.length === 0 ? extra : extra + this.countTokens(fragments);
					return Math.max(visible, message.usage.output - (message.elidedOutputTokens ?? 0));
				}
				break;
			}
			case "custom":
			case "hookMessage":
			case "toolResult": {
				if (typeof message.content === "string") {
					fragments.push(message.content);
				} else {
					for (const block of message.content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += this.imageTokens(base64ImageSize(block.data), block.detail);
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
							else extra += this.#frameTokens(block.data);
						}
					} else if (message.images) {
						for (const image of message.images) {
							extra += this.#frameTokens(image.data);
						}
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

	/**
	 * Input tokens this reader bills for replaying `message`'s native Responses
	 * reasoning; `undefined` when the reader re-encodes the turn from its
	 * blocks instead, `null` when it replays but the backend reported no
	 * reasoning tokens to price it by. The payload goes back on the wire only
	 * to the api, model and provider that produced it (`convertMessages` in
	 * pi-ai's Responses providers), and then only what survives replay: a
	 * truncated thinking-only turn is dropped, a hidden-empty or reasoning-only
	 * payload sanitizes to nothing, and a cold session rebuilds the turn without
	 * its reasoning, so those send no reasoning and no signature (0).
	 */
	#replayedReasoningTokens(message: AssistantMessage): number | null | undefined {
		const reader = this.#reasoningReader;
		if (!reader || message.api !== reader.api || message.model !== reader.id) return undefined;
		const items = getOpenAIResponsesHistoryItems(message.providerPayload, reader.provider, message.provider);
		if (!items) return undefined;
		if (!items.some(item => item.type === "reasoning") || shouldDropTruncatedThinkingOnlyAssistant(message)) return 0;
		const replay = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(items);
		if (!replay?.some(item => item.type === "reasoning")) return 0;
		// Cold, only plaintext reasoning bound to no server state replays natively.
		if (!this.nativeHistoryReplay && !isColdReplayableResponsesTurn(replay)) return 0;
		return message.usage?.reasoningTokens ?? null;
	}

	/** Whether a Tokenizer built for `model` with `options` would count every message as this one does. */
	countsAlike(model: TokenizerModel | null | undefined, options?: TokenizerOptions): boolean {
		return (
			tokenizerEncodingForModel(model) === this.#encoding &&
			snapcompact.frameBillingKey(snapcompact.frameBilling(model ?? undefined)) === this.frameBillingKey &&
			reasoningReplayKey(model) === this.reasoningReplayKey &&
			resolveThinkingReplayTokens(model ?? {}) === this.thinkingReplayTokens &&
			ollamaChatDropsOwnThinking(model) === this.#dropsOllamaThinking &&
			(options?.nativeHistoryReplay ?? true) === this.nativeHistoryReplay
		);
	}

	/** One snapcompact frame at the active model's price for its pixel size; unreadable frames cost the ceiling. */
	#frameTokens(data: string): number {
		const size = base64ImageSize(data);
		return size ? snapcompact.frameTokens(this.#frameBilling, size) : snapcompact.FRAME_TOKEN_ESTIMATE;
	}
}
