/** Handoff document generation. Committing the document as a compaction entry is owned by SessionMaintenance. */

import * as path from "node:path";
import {
	type Agent,
	type AgentMessage,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import { generateHandoffFromContext, renderHandoffPrompt } from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model, ServiceTier, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { HandoffResult, SessionHandoffOptions } from "./agent-session-types";
import type { SessionManager } from "./session-manager";

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

function throwIfHandoffAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = signal.reason;
	if (reason instanceof DOMException && reason.name === "AbortError") {
		throw new Error("Handoff cancelled");
	}
	if (reason instanceof Error) throw reason;
	if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
	throw new Error("Handoff aborted by session");
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionHandoffHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sideStreamFn: StreamFn;
	obfuscator: SecretObfuscator | undefined;
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	sessionId(): string;
	baseSystemPrompt(): string[];
	setSkipPostTurnMaintenance(timestamp: number | undefined): void;
	obfuscateTextForProvider(text: string | undefined): string | undefined;
	deobfuscateFromProvider(text: string): string;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	effectiveServiceTier(model: Model | undefined): ServiceTier | undefined;
}

/** Generates handoff documents with a cache-friendly oneshot LLM call. */
export class SessionHandoff {
	#handoffAbortController: AbortController | undefined;
	readonly #host: SessionHandoffHost;

	constructor(host: SessionHandoffHost) {
		this.#host = host;
	}
	/**
	 * Cancel in-progress handoff generation, preserving a harness-provided reason.
	 */
	abortHandoff(reason?: Error): void {
		this.#handoffAbortController?.abort(reason);
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call.
	 *
	 * The request is built through the same pipeline a live turn uses so the
	 * oneshot reads the provider prompt cache the main turn populated. The
	 * caller (SessionMaintenance) commits the returned document as a compaction
	 * entry; this method rewrites no history.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined when an auto-triggered
	 *   generation produced no content (manual generation throws instead)
	 */
	async generateDocument(
		customInstructions?: string,
		options?: SessionHandoffOptions,
	): Promise<HandoffResult | undefined> {
		this.#host.setSkipPostTurnMaintenance(undefined);

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort(sourceSignal?.reason);
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			throwIfHandoffAborted(handoffSignal);

			const model = this.#host.model();
			if (!model) {
				throw new Error("No model selected for handoff");
			}
			const apiKey = await this.#host.modelRegistry.getApiKey(model, this.#host.sessionId());
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = this.#host.sessionId();
			// The loop sends `promptCacheKey` (providerPromptCacheKey) and falls back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from this.#host.sessionId() (tan/subagent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
			const handoffPromptCacheKey = this.#host.agent.promptCacheKey ?? this.#host.agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(this.#host.obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...this.#host.agent.state.messages,
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffLlmMessages = await this.#host.convertMessagesToLlm(handoffSnapshot, handoffSignal);
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the document seeds the post-compaction context and must not carry
			// prompt-specific hook state.
			const handoffContext = await this.#host.agent.buildSideRequestContext(
				handoffLlmMessages,
				this.#host.baseSystemPrompt(),
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
					signal: handoffSignal,
				},
				model.provider,
			);
			const rawHandoffText = await generateHandoffFromContext(
				obfuscateProviderContext(this.#host.obfuscator, handoffContext),
				model,
				{
					streamOptions: handoffStreamOptions,
					completeImpl: async (requestModel, requestContext, requestOptions) => {
						const stream = await this.#host.sideStreamFn(requestModel, requestContext, requestOptions);
						return stream.result();
					},
					telemetry: resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId()),
					// Honor the user's /model thinking selection on the handoff path.
					// Clamped per-model inside generateHandoffFromContext via
					// resolveCompactionEffort so unsupported-effort models don't trip
					// requireSupportedEffort.
					thinkingLevel: this.#host.thinkingLevel(),
				},
			);
			const handoffText = this.#host.deobfuscateFromProvider(rawHandoffText);

			throwIfHandoffAborted(handoffSignal);
			if (!handoffText || handoffText.trim().length === 0) {
				// Empty/whitespace-only generation is a real failure, not a user
				// cancellation. #7904 stopped masking provider errors as "Handoff
				// cancelled"; an empty document is the remaining path that produced the
				// same misleading, undebuggable message (#7993).
				logger.warn("Handoff generation produced no content", {
					sessionId: this.#host.sessionId(),
					autoTriggered: options?.autoTriggered ?? false,
				});
				// Auto-handoff is best-effort: returning undefined lets maintenance fall
				// back to the next compaction method. A user-initiated handoff must
				// surface the failure instead of a silent, misleading "cancelled".
				if (options?.autoTriggered) {
					return undefined;
				}
				throw new Error("Handoff generation produced no content");
			}

			let savedPath: string | undefined;
			if (options?.autoTriggered && this.#host.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.#host.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
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

			return { document: handoffText, savedPath };
		} catch (error) {
			// Only a genuine cancellation (user Esc or an unreasoned source-signal
			// abort) maps to "Handoff cancelled". A harness-provided abort reason and
			// provider failures surface verbatim.
			throwIfHandoffAborted(handoffSignal);
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}
}
