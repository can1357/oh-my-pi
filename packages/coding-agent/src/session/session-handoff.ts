/** Handoff document generation. Committing the document as a compaction entry is owned by SessionMaintenance. */

import * as path from "node:path";
import {
	type Agent,
	type AgentMessage,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import {
	CompactionCancelledError,
	generateHandoffFromContext,
	type NumberCheckReport,
	renderHandoffPrompt,
	SummaryNumberCheck,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, Model, ServiceTier, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { logger, ptree, Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { journalCompletion } from "./model-usage-journal";
import type { SessionManager } from "./session-manager";

import {
	cfgCompactionHandoffSaveToDisk,
	cfgCompactionHandoffTimeoutSeconds,
	cfgCompactionNumberCheck,
} from "./context-settings";

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

function throwIfHandoffAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new CompactionCancelledError(undefined, { cause: signal.reason });
}

/** A fired deadline is a failure, not a cancel, so automatic maintenance moves on to its next method. */
function throwIfHandoffTimedOut(deadline: AbortSignal | undefined, timeoutSeconds: number): void {
	if (deadline?.aborted) {
		throw new Error(`Handoff timed out after ${timeoutSeconds}s (compaction.handoffTimeoutSeconds)`);
	}
}

/** Request snapshot and cancellation owned by the compaction pass. */
export interface HandoffGenerationOptions {
	model: Model;
	signal: AbortSignal;
	messages?: readonly AgentMessage[];
	autoTriggered?: boolean;
	/** Sees every provider attempt's response, billed or failed, beside the spend journal. */
	onAttempt?: (message: AssistantMessage) => void;
}

/** A generated handoff document, with the number check's findings when it ran and found any. */
export interface HandoffDocument {
	text: string;
	/** Numbers the document gave that its input never showed, when `compaction.numberCheck` found any. */
	numberCheck?: NumberCheckReport;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionHandoffHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sideStreamFn: StreamFn;
	obfuscator(): SecretObfuscator | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	sessionId(): string;
	getPromptCacheKeyForModel(model: Model): string | undefined;
	baseSystemPrompt(): string[];
	obfuscateTextForProvider(text: string | undefined): string | undefined;
	deobfuscateFromProvider(text: string): string;
	convertMessagesToLlm(messages: AgentMessage[], signal: AbortSignal | undefined, model: Model): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	effectiveServiceTier(model: Model | undefined): ServiceTier | undefined;
}

/** Generates handoff documents with a cache-friendly oneshot LLM call. */
export class SessionHandoff {
	readonly #host: SessionHandoffHost;

	constructor(host: SessionHandoffHost) {
		this.#host = host;
	}
	/**
	 * Generate a handoff document with a oneshot LLM call.
	 *
	 * The request is built through the same pipeline a live turn uses so the
	 * oneshot reads the provider prompt cache the main turn populated. The
	 * caller (SessionMaintenance) commits the returned document as a compaction
	 * entry; this method rewrites no history.
	 *
	 * Auto generation returns undefined for unusable output so maintenance can try its next method.
	 */
	async generateDocument(
		customInstructions: string | undefined,
		{ model, signal: cancelSignal, messages, autoTriggered, onAttempt }: HandoffGenerationOptions,
	): Promise<HandoffDocument | undefined> {
		const timeoutSeconds = cfgCompactionHandoffTimeoutSeconds.get(this.#host.settings);
		const deadline = timeoutSeconds > 0 ? AbortSignal.timeout(timeoutSeconds * 1000) : undefined;
		// Every request step observes the deadline; cancellation checks keep reading
		// `cancelSignal` so only the caller's abort reports as a cancel.
		const signal = ptree.combineSignals(cancelSignal, deadline) ?? cancelSignal;
		try {
			throwIfHandoffAborted(cancelSignal);

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = this.#host.sessionId();
			// The loop sends an explicit or model-gated Task key, falling back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from this.#host.sessionId() (tan/subagent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
			const handoffPromptCacheKey = this.#host.getPromptCacheKeyForModel(model) ?? this.#host.agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(this.#host.obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...(messages ?? this.#host.agent.state.messages),
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			// Every handoff document is committed as a compaction entry.
			const journal = journalCompletion(this.#host.sessionManager, {
				purpose: "compaction:handoff",
				usageOnly: true,
			});
			const apiKey = await this.#host.modelRegistry.getApiKey(model, cacheSessionId);
			if (!apiKey) throw new Error(`No API key for ${model.provider}`);
			const handoffLlmMessages = await this.#host.convertMessagesToLlm(handoffSnapshot, signal, model);
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the document seeds the post-compaction context and must not carry
			// prompt-specific hook state.
			const handoffContext = await this.#host.agent.buildSideRequestContext(
				handoffLlmMessages,
				this.#host.baseSystemPrompt(),
				signal,
			);
			const handoffStreamOptions = this.#host.prepareSimpleStreamOptions(
				{
					apiKey: this.#host.modelRegistry.resolver(model, cacheSessionId),
					sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
					promptCacheKey: handoffPromptCacheKey,
					preferWebsockets: false,
					serviceTier: this.#host.effectiveServiceTier(model),
					hideThinkingSummary: this.#host.agent.hideThinkingSummary,
					initiatorOverride: "agent",
					signal,
				},
				model.provider,
			);
			throwIfHandoffAborted(cancelSignal);
			// Checked in the provider's (obfuscated) text space: the document and its
			// input are compared before deobfuscation.
			const numberCheck = cfgCompactionNumberCheck.get(this.#host.settings) ? new SummaryNumberCheck() : undefined;
			const rawHandoffText = await generateHandoffFromContext(
				obfuscateProviderContext(this.#host.obfuscator(), handoffContext),
				model,
				{
					streamOptions: handoffStreamOptions,
					completeImpl: async (requestModel, requestContext, requestOptions) => {
						const stream = await this.#host.sideStreamFn(requestModel, requestContext, requestOptions);
						const message = await stream.result();
						// One call per provider attempt, so a retried or failed one is billed too.
						journal?.(message);
						onAttempt?.(message);
						return message;
					},
					telemetry: resolveTelemetry(this.#host.agent.telemetry, cacheSessionId),
					// Honor the user's /model thinking selection on the handoff path.
					// Clamped per-model inside generateHandoffFromContext via
					// resolveCompactionEffort so unsupported-effort models don't trip
					// requireSupportedEffort.
					thinkingLevel: this.#host.thinkingLevel(),
					numberCheck,
				},
			);
			const handoffText = this.#host.deobfuscateFromProvider(rawHandoffText);

			throwIfHandoffAborted(cancelSignal);
			// An aborted stream returns its partial text; never validate or commit it.
			throwIfHandoffTimedOut(deadline, timeoutSeconds);
			const failure = !handoffText?.trim()
				? "no content"
				: !/^## Goal[ \t]*\r?$/m.test(handoffText)
					? "an invalid document"
					: undefined;
			if (failure) {
				logger.warn(`Handoff generation produced ${failure}`, {
					providerSessionId: cacheSessionId,
					autoTriggered: autoTriggered ?? false,
				});
				// Auto-handoff is best-effort: maintenance can try the next method
				// without committing a document that replaces the user's goal.
				if (autoTriggered) {
					return undefined;
				}
				throw new Error(`Handoff generation produced ${failure}`);
			}

			if (autoTriggered && cfgCompactionHandoffSaveToDisk.get(this.#host.settings)) {
				const artifactsDir = this.#host.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			throwIfHandoffAborted(cancelSignal);
			return { text: handoffText, ...(numberCheck?.report ? { numberCheck: numberCheck.report } : {}) };
		} catch (error) {
			throwIfHandoffAborted(cancelSignal);
			throwIfHandoffTimedOut(deadline, timeoutSeconds);
			throw error;
		}
	}
}
