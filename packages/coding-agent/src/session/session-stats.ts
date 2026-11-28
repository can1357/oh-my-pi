import type { Agent, AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	calculatePromptTokens,
	findTranscriptUsageAnchor,
	isTranscriptUsageAnchor,
	promptTokensOmitOutput,
	type TranscriptUsageAnchor,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderResponseMetadata, Usage } from "@oh-my-pi/pi-ai";
import { isSurvivingAssistant, withoutUnreplayedBlocks } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { type } from "@oh-my-pi/omptype";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";

import type { ContextUsage } from "../extensibility/extensions/types";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateContextToolSchemaTokens,
	type NonMessageTokenSource,
} from "./context-usage";
import type { ContextUsageBreakdown, SessionStats } from "./agent-session-types";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Non-message accounting recorded with a provider prompt. */
interface NonMessageSnapshot {
	nonMessageTokens: number;
	/** Schema tokens inside `nonMessageTokens`; absent on snapshots that predate the field. */
	toolSchemaTokens?: number;
}

interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;
	toolSchemaTokens: number;
	cutoffCount: number;
	/**
	 * Compaction epoch at rebase time. Distinguishes a genuinely fresh in-turn
	 * anchor (same epoch) from a post-cutoff anchor that predates a mid-run
	 * compaction (older epoch) so the latter never out-ranks this snapshot.
	 */
	epoch: number;
}

/** Capabilities the stats tracker borrows from its owning session. */
export interface SessionStatsTrackerHost {
	session: NonMessageTokenSource & { readonly settings?: Settings };
	agent: Agent;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
}

/**
 * A request whose replay of the anchor turn {@link SessionStatsTracker.getContextAnswer}
 * counts: another model's, or a retry that leaves a failed turn out.
 */
export interface ContextAnswerReader {
	/** Counts what the request sends. */
	tokenizer: Tokenizer;
	/**
	 * The request's model: its tool-name limits and API decide which tool calls,
	 * native server-tool blocks and turns its replay keeps.
	 */
	model: Model | undefined;
	/** A transcript message the request leaves out. */
	excludedMessage?: AgentMessage;
}

/** The anchor turn's answer that the context figure adds to the provider's prompt. */
export interface ContextAnswer {
	/** The anchor turn, as the transcript holds it. */
	message: AgentMessage;
	/** The answer in the figure: as the active model's next request replays it. */
	tokens: number;
	/** The answer as the reader's request replays it: 0 when that request leaves the turn out or drops it. */
	readerTokens: number;
}

/** A provider anchor and its position in the transcript. */
type UsageAnchor = Pick<TranscriptUsageAnchor, "index" | "message">;

function correctedPromptTokens(assistant: AssistantMessage): number {
	const providerPromptTokens = assistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(assistant.usage);
	return Math.max(0, providerPromptTokens - (assistant.contextSnapshot?.historyRewriteTokensRemoved ?? 0));
}

function isUsageWindowBoundary(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		entry.type === "branch_summary" ||
		entry.type === "compaction" ||
		entry.type === "reset_boundary"
	);
}

/** Model calls belonging to the same active transcript window as `agent.state.messages`. */
function forEachActiveModelUsage(branch: readonly SessionEntry[], visit: (usage: Usage) => void): void {
	const latestCompaction = getLatestCompactionEntry(branch);
	const compactionIndex = latestCompaction ? branch.lastIndexOf(latestCompaction) : -1;
	let resetIndex = -1;
	for (let index = branch.length - 1; index > compactionIndex; index--) {
		if (branch[index].type === "reset_boundary") {
			resetIndex = index;
			break;
		}
	}
	let startIndex = 0;
	if (resetIndex > compactionIndex) {
		startIndex = resetIndex + 1;
	} else if (latestCompaction) {
		const firstKeptIndex = branch.findIndex(entry => entry.id === latestCompaction.firstKeptEntryId);
		startIndex = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
		while (startIndex > 0 && !isUsageWindowBoundary(branch[startIndex - 1])) startIndex--;
	}
	for (let index = startIndex; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "model_usage") visit(entry.usage);
	}
}

/** Computes session totals and tracks the in-flight context estimate. */
export class SessionStatsTracker {
	readonly #host: SessionStatsTrackerHost;
	#pendingContextSnapshot: PendingContextSnapshot | undefined;
	#contextUsageRevision = 0;
	#compactionEpoch = 0;

	constructor(host: SessionStatsTrackerHost) {
		this.#host = host;
	}

	get #tokenizer() {
		return this.#host.agent.tokenizer;
	}

	/** Tool-schema tokens the active model carries in its prompt. */
	#currentToolSchemaTokens(tokenizer = this.#tokenizer): number {
		const session = this.#host.session;
		return estimateContextToolSchemaTokens(session.agent?.state?.tools ?? [], tokenizer, session.model, {
			sourceRevision: session.settings?.revision,
			pruneDescriptions: session.agent?.prunesToolDescriptions?.(session.model),
		});
	}

	/**
	 * The answer of provider anchor `anchor`, at `anchor.index` in the
	 * transcript `messages`, as `reader`'s request replays it: nothing when the
	 * request leaves the turn out (`reader.excludedMessage`) or its replay drops
	 * the turn (`isSurvivingAssistant`: a turn cut off with neither text nor a
	 * valid tool call), else the blocks the replay keeps
	 * (`withoutUnreplayedBlocks`: no malformed tool call, and native server-tool
	 * blocks only for the producing provider's Anthropic Messages model),
	 * counted with `countLatestTurn` when no later assistant turn survives (an
	 * Anthropic Messages replay keeps that turn's signatures) and with
	 * `countMessage` otherwise. The count is capped at `usage.output` when the
	 * provider reported an output.
	 */
	#answerTokens(anchor: UsageAnchor, messages: readonly AgentMessage[], reader: ContextAnswerReader): number {
		const { tokenizer, model, excludedMessage } = reader;
		if (messages[anchor.index] === excludedMessage || !isSurvivingAssistant(anchor.message, model)) return 0;
		const latestTurnIndex = messages.findLastIndex(
			message => message !== excludedMessage && message.role === "assistant" && isSurvivingAssistant(message, model),
		);
		const replayed = withoutUnreplayedBlocks(anchor.message, model);
		const answerTokens =
			latestTurnIndex === anchor.index ? tokenizer.countLatestTurn(replayed) : tokenizer.countMessage(replayed);
		const output = anchor.message.usage.output;
		return output > 0 ? Math.min(output, answerTokens) : answerTokens;
	}

	/**
	 * The provider anchor the context figure starts from, with its position in
	 * the transcript `activeMessages`: the newest anchor on the session branch
	 * `branchEntries` since the latest compaction unless an in-flight snapshot
	 * outranks it, else, for a session with an empty branch and no snapshot, the
	 * newest anchor in the transcript. `undefined` when the figure starts from
	 * the snapshot or from a local count.
	 */
	#usageAnchor(
		branchEntries: readonly SessionEntry[],
		activeMessages: readonly AgentMessage[],
	): UsageAnchor | undefined {
		const pending = this.#pendingContextSnapshot;
		if (branchEntries.length === 0) return pending ? undefined : findTranscriptUsageAnchor(activeMessages);
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		for (let entryIndex = branchEntries.length - 1; entryIndex > compactionIndex; entryIndex--) {
			const entry = branchEntries[entryIndex];
			if (entry.type !== "message" || !isTranscriptUsageAnchor(entry.message)) continue;
			const message = entry.message;
			let index = activeMessages.indexOf(message);
			if (index === -1) {
				index = activeMessages.findIndex(
					candidate => candidate.role === "assistant" && candidate.timestamp === message.timestamp,
				);
			}
			const epoch = message.contextSnapshot?.compactionEpoch ?? 0;
			const outranksPending = !pending || (index >= pending.cutoffCount && epoch >= pending.epoch);
			return index !== -1 && outranksPending ? { message, index } : undefined;
		}
		return undefined;
	}

	/**
	 * Anchored used-token arithmetic shared by every anchored branch: provider
	 * base + non-message change since the anchor + local tail + pending.
	 *
	 * Non-schema overhead only ever adds growth. Schema tokens move both ways:
	 * the provider base already contains every schema it was sent, so a roster
	 * shrink or a switch to a model that defers schemas must leave the base.
	 */
	#anchoredUsedTokens(
		base: number,
		anchor: NonMessageSnapshot,
		current: Required<NonMessageSnapshot>,
		tailFromIndex: number,
		activeMessages: readonly AgentMessage[],
		pendingTokens: number,
		tokenizer: Tokenizer,
	): number {
		const nonMessageDelta =
			anchor.toolSchemaTokens === undefined
				? Math.max(0, current.nonMessageTokens - anchor.nonMessageTokens)
				: Math.max(
						0,
						current.nonMessageTokens -
							current.toolSchemaTokens -
							(anchor.nonMessageTokens - anchor.toolSchemaTokens),
					) +
					current.toolSchemaTokens -
					anchor.toolSchemaTokens;
		return (
			Math.max(0, base + nonMessageDelta) +
			tokenizer.countMessages(activeMessages.slice(tailFromIndex)) +
			pendingTokens
		);
	}

	/**
	 * Token totals of {@link getSessionStats} without the message counts or the
	 * context breakdown — for per-turn accounting (goal budgets) that only
	 * needs the counters.
	 */
	getTokenTotals(): SessionStats["tokens"] {
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const addUsage = (usage: Usage): void => {
			tokens.input += usage.input;
			tokens.output += usage.output;
			tokens.reasoning += usage.reasoningTokens ?? 0;
			tokens.cacheRead += usage.cacheRead;
			tokens.cacheWrite += usage.cacheWrite;
			tokens.total += usage.totalTokens;
		};
		for (const message of this.#host.agent.state.messages) {
			if (message.role === "assistant") {
				if (message.usage) addUsage(message.usage);
			} else if (message.role === "toolResult" && message.toolName === "task") {
				const usage = taskToolUsage(message.details);
				if (usage) addUsage(usage);
			}
		}
		forEachActiveModelUsage(this.#host.sessionManager.getBranchView(), addUsage);
		return tokens;
	}

	/** Returns aggregate message, token, and cost statistics for the session. */
	getSessionStats(): SessionStats {
		const state = this.#host.agent.state;
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalReasoning = 0;
		let totalCacheWrite = 0;
		let totalTokens = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;
		let creditCost = 0;
		let committedCreditCost = 0;
		let committedAcuCost = 0;
		let hasCredits = false;
		const routedModels: Record<string, number> = {};
		const editRejections: Record<string, number> = {};
		const addUsage = (usage: Usage): void => {
			totalInput += usage.input;
			totalOutput += usage.output;
			totalReasoning += usage.reasoningTokens ?? 0;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalTokens += usage.totalTokens;
			totalPremiumRequests += usage.premiumRequests ?? 0;
			totalCost += usage.cost.total;
			const credits = usage.credits;
			if (credits !== undefined) {
				hasCredits = true;
				creditCost += credits.cost ?? 0;
				committedCreditCost += credits.committedCost ?? 0;
				committedAcuCost += credits.acuCost ?? 0;
			}
		};
		for (const message of state.messages) {
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.toolName === "task") {
					const usage = taskToolUsage(message.details);
					if (usage) addUsage(usage);
				} else if (message.toolName === "edit" && message.isError) {
					const { details } = message;
					if (details && typeof details === "object" && "errorKind" in details) {
						const kind = details.errorKind;
						if (typeof kind === "string") editRejections[kind] = (editRejections[kind] ?? 0) + 1;
					}
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				for (const content of message.content) {
					if (content.type === "toolCall") toolCalls++;
				}
				// Persisted and imported transcripts can predate usage metadata despite the current message type.
				const usage = message.usage;
				if (!usage) continue;
				addUsage(usage);
				if (message.upstreamModel !== undefined) {
					routedModels[message.upstreamModel] = (routedModels[message.upstreamModel] ?? 0) + 1;
				}
			}
		}
		forEachActiveModelUsage(this.#host.sessionManager.getBranchView(), addUsage);
		return {
			sessionFile: this.#host.sessionManager.getSessionFile(),
			sessionId: this.#host.sessionManager.getSessionId(),
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				reasoning: totalReasoning,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalTokens,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
			...(hasCredits
				? {
						credits: {
							cost: creditCost,
							committedCost: committedCreditCost,
							acuCost: committedAcuCost,
						},
					}
				: undefined),
			...(Object.keys(routedModels).length > 0 ? { routedModels } : undefined),
			...(Object.keys(editRejections).length > 0 ? { editRejections } : undefined),
			contextUsage: this.getContextUsage(),
		};
	}

	/** Resolves active context token count against provider anchors, pending snapshots, and live tail. */
	#computeUsedTokens(
		tokenizer: Tokenizer,
		current: Required<NonMessageSnapshot>,
		pendingMessages?: AgentMessage[],
	): { usedTokens: number; anchored: boolean } {
		const pendingTokens =
			pendingMessages && pendingMessages.length > 0 ? tokenizer.countMessages(pendingMessages) : 0;
		const activeMessages = this.#host.agent.state.messages;
		const anchor = this.#usageAnchor(this.#host.sessionManager.getBranchView(), activeMessages);
		if (anchor) {
			// The prompt the provider reported, and the anchor turn's own answer, which the next request sends.
			let base = correctedPromptTokens(anchor.message);
			if (promptTokensOmitOutput(anchor.message.usage)) {
				base += this.#answerTokens(anchor, activeMessages, {
					tokenizer: this.#tokenizer,
					model: this.#host.model(),
				});
			}
			const usedTokens = this.#anchoredUsedTokens(
				base,
				anchor.message.contextSnapshot ?? current,
				current,
				anchor.index + 1,
				activeMessages,
				pendingTokens,
				tokenizer,
			);
			return { usedTokens, anchored: true };
		}
		const pending = this.#pendingContextSnapshot;
		if (pending) {
			const usedTokens = this.#anchoredUsedTokens(
				pending.promptTokens,
				pending,
				current,
				pending.cutoffCount,
				activeMessages,
				pendingTokens,
				tokenizer,
			);
			return { usedTokens, anchored: true };
		}
		return {
			usedTokens: current.nonMessageTokens + tokenizer.countMessages(activeMessages) + pendingTokens,
			anchored: false,
		};
	}

	/** Returns the current provider-context token breakdown. */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const rawContextWindow = options?.contextWindow ?? this.#host.model()?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;
		const tokenizer = this.#tokenizer;
		const revision = this.#host.session.settings?.revision;
		const { skillsTokens, instructionFilesTokens, toolsTokens, systemContextTokens, systemPromptTokens } =
			computeNonMessageBreakdown(this.#host.session, tokenizer, revision);
		const categoryNonMessageTokens =
			skillsTokens + instructionFilesTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const current = {
			nonMessageTokens: computeNonMessageTokens(this.#host.session, tokenizer, revision),
			toolSchemaTokens: toolsTokens,
		};
		const { usedTokens, anchored } = this.#computeUsedTokens(tokenizer, current, options?.pendingMessages);
		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			instructionFilesTokens,
			skillsTokens,
			messagesTokens: Math.max(0, usedTokens - categoryNonMessageTokens),
		};
	}

	/** Returns current context tokens, capacity, and percentage. */
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const rawContextWindow = options?.contextWindow ?? this.#host.model()?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;
		const tokenizer = this.#tokenizer;
		const current = this.#currentNonMessageSnapshot(tokenizer);
		const { usedTokens } = this.#computeUsedTokens(tokenizer, current);
		return {
			tokens: usedTokens,
			contextWindow,
			percent: contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
		};
	}

	/**
	 * The anchor turn's answer that {@link getContextUsage} adds to the
	 * provider's prompt, counted as the active model's next request replays it
	 * and as `reader`'s request does; `undefined` when the figure adds none
	 * (it starts from an in-flight snapshot or a local count, or its base
	 * already holds the turn).
	 */
	getContextAnswer(reader: ContextAnswerReader): ContextAnswer | undefined {
		const messages = this.#host.agent.state.messages;
		const anchor = this.#usageAnchor(this.#host.sessionManager.getBranchView(), messages);
		if (!anchor || !promptTokensOmitOutput(anchor.message.usage)) return undefined;
		return {
			message: messages[anchor.index],
			tokens: this.#answerTokens(anchor, messages, { tokenizer: this.#tokenizer, model: this.#host.model() }),
			readerTokens: this.#answerTokens(anchor, messages, reader),
		};
	}

	/** Monotonic revision for in-flight context snapshot changes. */
	get revision(): number {
		return this.#contextUsageRevision;
	}

	/**
	 * Monotonic compaction epoch, bumped whenever history is compacted. Stamped
	 * onto each assistant snapshot at record time so {@link getContextBreakdown}
	 * can reject a post-cutoff anchor whose usage predates the last compaction.
	 */
	get compactionEpoch(): number {
		return this.#compactionEpoch;
	}

	/**
	 * Non-message accounting for a provider response: the values captured for
	 * the in-flight request, or the current values when none is pending.
	 */
	nonMessageSnapshot(): Required<NonMessageSnapshot> {
		const pending = this.#pendingContextSnapshot;
		if (pending) return { nonMessageTokens: pending.nonMessageTokens, toolSchemaTokens: pending.toolSchemaTokens };
		return this.#currentNonMessageSnapshot();
	}

	#currentNonMessageSnapshot(tokenizer = this.#tokenizer): Required<NonMessageSnapshot> {
		return {
			nonMessageTokens: computeNonMessageTokens(
				this.#host.session,
				tokenizer,
				this.#host.session.settings?.revision,
			),
			toolSchemaTokens: this.#currentToolSchemaTokens(tokenizer),
		};
	}

	/**
	 * Apply an estimated prompt-prefix reduction to the current provider anchor.
	 *
	 * History after the anchor is estimated live by {@link getContextBreakdown};
	 * callers must pass only savings from entries already included in the
	 * anchor's provider-reported prompt. Persisting the correction on the
	 * assistant snapshot keeps reloads accurate, and the next successful
	 * assistant response naturally replaces it with a fresh provider anchor.
	 */
	recordAnchoredHistoryRewrite(tokensRemoved: number): void {
		if (!Number.isFinite(tokensRemoved) || tokensRemoved <= 0) return;

		const branchEntries = this.#host.sessionManager.getBranchView();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || !isTranscriptUsageAnchor(entry.message)) continue;
			const assistant = entry.message;

			if (!assistant.contextSnapshot) {
				assistant.contextSnapshot = {
					promptTokens: calculatePromptTokens(assistant.usage),
					...this.#currentNonMessageSnapshot(),
					compactionEpoch: this.#compactionEpoch,
				};
			}
			const snapshot = assistant.contextSnapshot;
			snapshot.historyRewriteTokensRemoved = (snapshot.historyRewriteTokensRemoved ?? 0) + Math.floor(tokensRemoved);
			this.#contextUsageRevision++;
			return;
		}
	}

	/** Sets or clears the in-flight context snapshot. */
	setPendingSnapshot(snapshot: Omit<PendingContextSnapshot, "epoch" | "toolSchemaTokens"> | undefined): void {
		this.#pendingContextSnapshot = snapshot
			? { ...snapshot, toolSchemaTokens: this.#currentToolSchemaTokens(), epoch: this.#compactionEpoch }
			: undefined;
		this.#contextUsageRevision++;
	}

	/** Recomputes an in-flight snapshot after history is compacted or rewritten. */
	rebaseAfterCompaction(): void {
		this.#compactionEpoch++;
		if (!this.#pendingContextSnapshot) return;
		const tokenizer = this.#tokenizer;
		const nonMessageTokens = computeNonMessageTokens(
			this.#host.session,
			tokenizer,
			this.#host.session.settings?.revision,
		);
		const messages = this.#host.agent.state.messages;
		this.setPendingSnapshot({
			promptTokens: nonMessageTokens + tokenizer.countMessages(messages),
			nonMessageTokens,
			cutoffCount: messages.length,
		});
	}

	/** Records provider usage headers against the active session account. */
	ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		const provider = model?.provider;
		if (!provider) return;
		this.#host.modelRegistry.authStorage.usage.ingestHeaders(provider, response.headers, {
			sessionId: this.#host.agent.sessionId,
			baseUrl: this.#host.modelRegistry.getProviderBaseUrl?.(provider),
			responseStatus: response.status,
		});
	}
}

function taskToolUsage(details: unknown): Usage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const usage = Reflect.get(details, "usage");
	return isUsage(usage) ? usage : undefined;
}

const UsageShape = type({
	input: "number",
	output: "number",
	cacheRead: "number",
	cacheWrite: "number",
	totalTokens: "number",
	cost: { total: "number" },
});

function isUsage(value: unknown): value is Usage {
	return UsageShape.allows(value);
}
