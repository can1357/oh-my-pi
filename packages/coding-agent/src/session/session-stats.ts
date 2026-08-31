import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	calculatePromptTokens,
	findTranscriptUsageAnchor,
	isTranscriptUsageAnchor,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderResponseMetadata, Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { ContextUsage } from "../extensibility/extensions/types";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	type NonMessageTokenSource,
} from "../modes/utils/context-usage";
import type { ContextUsageBreakdown, SessionStats } from "./agent-session-types";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionManager } from "./session-manager";

interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;
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
	session: NonMessageTokenSource;
	agent: Agent;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
	sessionId(): string;
}

function correctedPromptTokens(assistant: AssistantMessage): number {
	const providerPromptTokens = assistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(assistant.usage);
	return Math.max(0, providerPromptTokens - (assistant.contextSnapshot?.historyRewriteTokensRemoved ?? 0));
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

	/**
	 * Anchored used-token arithmetic shared by every anchored branch: provider
	 * base + non-message growth since the anchor + local tail + pending.
	 */
	#anchoredUsedTokens(
		base: number,
		anchorNonMessageTokens: number,
		currentNonMessageTokens: number,
		tailFromIndex: number,
		activeMessages: readonly AgentMessage[],
		pendingTokens: number,
	): number {
		return (
			base +
			Math.max(0, currentNonMessageTokens - anchorNonMessageTokens) +
			this.#tokenizer.countMessages(activeMessages.slice(tailFromIndex)) +
			pendingTokens
		);
	}

	/** Returns aggregate message, token, and cost statistics for the session. */
	getSessionStats(): SessionStats {
		const state = this.#host.agent.state;
		const userMessages = state.messages.filter(message => message.role === "user").length;
		const assistantMessages = state.messages.filter(message => message.role === "assistant").length;
		const toolResults = state.messages.filter(message => message.role === "toolResult").length;
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
		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistant = message;
				toolCalls += assistant.content.filter(content => content.type === "toolCall").length;
				// Persisted and imported transcripts can predate usage metadata despite the current message type.
				const usage = assistant.usage;
				if (!usage) continue;
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
				if (assistant.upstreamModel !== undefined) {
					routedModels[assistant.upstreamModel] = (routedModels[assistant.upstreamModel] ?? 0) + 1;
				}
			}
			if (message.role === "toolResult" && message.toolName === "task") {
				const usage = taskToolUsage(message.details);
				if (!usage) continue;
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
			}
		}
		return {
			sessionFile: this.#host.sessionManager.getSessionFile(),
			sessionId: this.#host.sessionId(),
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
			contextUsage: this.getContextUsage(),
		};
	}

	/** Returns the current provider-context token breakdown. */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const rawContextWindow = options?.contextWindow ?? this.#host.model()?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;
		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(
			this.#host.session,
			this.#tokenizer,
		);
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const currentNonMessageTokens = computeNonMessageTokens(this.#host.session, this.#tokenizer);
		const branchEntries = this.#host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		let usedTokens = 0;
		let anchored = false;
		const pendingMessages = options?.pendingMessages ?? [];
		const pendingTokens = this.#tokenizer.countMessages(pendingMessages);
		const pending = this.#pendingContextSnapshot;

		let anchorEntry: SessionMessageEntry | undefined;
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || !isTranscriptUsageAnchor(entry.message)) continue;
			anchorEntry = entry;
			break;
		}

		const activeMessages = this.#host.agent.state.messages;
		let anchorIndex = -1;
		let anchorAssistant: AssistantMessage | undefined;
		if (anchorEntry?.message.role === "assistant") {
			const assistant = anchorEntry.message;
			anchorAssistant = assistant;
			anchorIndex = activeMessages.indexOf(assistant);
			if (anchorIndex === -1) {
				anchorIndex = activeMessages.findIndex(
					message => message.role === "assistant" && message.timestamp === assistant.timestamp,
				);
			}
		}

		const anchorEpoch = anchorAssistant?.contextSnapshot?.compactionEpoch ?? 0;
		const useAnchor =
			anchorAssistant !== undefined &&
			anchorIndex !== -1 &&
			(!pending || (anchorIndex >= pending.cutoffCount && anchorEpoch >= pending.epoch));
		if (useAnchor && anchorAssistant) {
			const nonMessageTokens =
				anchorAssistant.contextSnapshot?.nonMessageTokens ??
				computeNonMessageTokens(this.#host.session, this.#tokenizer);
			anchored = true;
			usedTokens = this.#anchoredUsedTokens(
				correctedPromptTokens(anchorAssistant),
				nonMessageTokens,
				currentNonMessageTokens,
				anchorIndex + 1,
				activeMessages,
				pendingTokens,
			);
		} else if (pending) {
			anchored = true;
			usedTokens = this.#anchoredUsedTokens(
				pending.promptTokens,
				pending.nonMessageTokens,
				currentNonMessageTokens,
				pending.cutoffCount,
				activeMessages,
				pendingTokens,
			);
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			const liveAnchor = findTranscriptUsageAnchor(activeMessages);
			if (liveAnchor) {
				const nonMessageTokens =
					liveAnchor.message.contextSnapshot?.nonMessageTokens ??
					computeNonMessageTokens(this.#host.session, this.#tokenizer);
				usedTokens = this.#anchoredUsedTokens(
					correctedPromptTokens(liveAnchor.message),
					nonMessageTokens,
					currentNonMessageTokens,
					liveAnchor.index + 1,
					activeMessages,
					pendingTokens,
				);
				anchored = true;
			}
		}
		if (!anchored) {
			usedTokens = currentNonMessageTokens + this.#tokenizer.countMessages(activeMessages) + pendingTokens;
		}
		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens: Math.max(0, usedTokens - categoryNonMessageTokens),
		};
	}

	/** Returns current context tokens, capacity, and percentage. */
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const breakdown = this.getContextBreakdown(options);
		if (!breakdown) return undefined;
		return {
			tokens: breakdown.usedTokens,
			contextWindow: breakdown.contextWindow,
			percent: breakdown.contextWindow > 0 ? (breakdown.usedTokens / breakdown.contextWindow) * 100 : 0,
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

	/** Non-message token count captured for the active provider request. */
	get pendingNonMessageTokens(): number | undefined {
		return this.#pendingContextSnapshot?.nonMessageTokens;
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

		const branchEntries = this.#host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || !isTranscriptUsageAnchor(entry.message)) continue;
			const assistant = entry.message;

			if (!assistant.contextSnapshot) {
				assistant.contextSnapshot = {
					promptTokens: calculatePromptTokens(assistant.usage),
					nonMessageTokens: computeNonMessageTokens(this.#host.session, this.#tokenizer),
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
	setPendingSnapshot(snapshot: Omit<PendingContextSnapshot, "epoch"> | undefined): void {
		this.#pendingContextSnapshot = snapshot ? { ...snapshot, epoch: this.#compactionEpoch } : undefined;
		this.#contextUsageRevision++;
	}

	/** Recomputes an in-flight snapshot after history is compacted or rewritten. */
	rebaseAfterCompaction(): void {
		this.#compactionEpoch++;
		if (!this.#pendingContextSnapshot) return;
		const nonMessageTokens = computeNonMessageTokens(this.#host.session, this.#tokenizer);
		const messages = this.#host.agent.state.messages;
		this.setPendingSnapshot({
			promptTokens: nonMessageTokens + this.#tokenizer.countMessages(messages),
			nonMessageTokens,
			cutoffCount: messages.length,
		});
	}

	/** Records provider usage headers against the active session account. */
	ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		const provider = model?.provider;
		if (!provider) return;
		this.#host.modelRegistry.authStorage.ingestUsageHeaders(provider, response.headers, {
			sessionId: this.#host.agent.sessionId,
			baseUrl: this.#host.modelRegistry.getProviderBaseUrl?.(provider),
		});
	}
}

function taskToolUsage(details: unknown): Usage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const usage = Reflect.get(details, "usage");
	return isUsage(usage) ? usage : undefined;
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		typeof value.input === "number" &&
		typeof value.output === "number" &&
		typeof value.cacheRead === "number" &&
		typeof value.cacheWrite === "number" &&
		typeof value.totalTokens === "number" &&
		typeof value.cost.total === "number"
	);
}
