/** Backwards-compatible session facade for the shared context-maintenance controller. */

import type { AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult, ShakeConfig } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, CodexCompactionContext, Model } from "@oh-my-pi/pi-ai";
import type { CompactOptions } from "../extensibility/extensions/types";
import { ContextMaintenance, type CompactionCheckResult, type ContextMaintenanceHost } from "./context-maintenance";
import type { HandoffResult, SessionHandoffOptions } from "./agent-session-types";
import type { ShakeMode, ShakeResult } from "./shake-types";

export * from "./context-maintenance";

/** Capabilities supplied by the owning AgentSession. */
export interface SessionMaintenanceHost extends ContextMaintenanceHost {}

/**
 * Main/task-session compatibility facade.
 *
 * Policy and mutable maintenance state live in exactly one ContextMaintenance
 * instance so other owners can use the same controller without importing the
 * AgentSession facade.
 */
export class SessionMaintenance {
	readonly #controller: ContextMaintenance;

	constructor(host: SessionMaintenanceHost) {
		this.#controller = new ContextMaintenance(host);
	}

	resetForNewPrompt(): void {
		this.#controller.resetForNewPrompt();
	}

	get isCompacting(): boolean {
		return this.#controller.isCompacting;
	}

	get speculationState(): "idle" | "running" | "armed" {
		return this.#controller.speculationState;
	}

	get speculationCompletion(): Promise<void> | undefined {
		return this.#controller.speculationCompletion;
	}

	cancelSpeculation(): void {
		this.#controller.cancelSpeculation();
	}

	get skipPostTurnMaintenanceAssistantTimestamp(): number | undefined {
		return this.#controller.skipPostTurnMaintenanceAssistantTimestamp;
	}

	set skipPostTurnMaintenanceAssistantTimestamp(timestamp: number | undefined) {
		this.#controller.skipPostTurnMaintenanceAssistantTimestamp = timestamp;
	}

	dropImages(): Promise<{ removed: number }> {
		return this.#controller.dropImages();
	}

	shake(
		mode: ShakeMode,
		opts: {
			config?: ShakeConfig;
			signal?: AbortSignal;
			requireArtifact?: boolean;
			isCurrent?: () => boolean;
			toolResultsOnly?: boolean;
		} = {},
	): Promise<ShakeResult> {
		return this.#controller.shake(mode, opts);
	}

	shakeForRequestBodyReadTimeout(generation: number): Promise<boolean> {
		return this.#controller.shakeForRequestBodyReadTimeout(generation);
	}

	compact(
		customInstructions?: string,
		options?: CompactOptions,
		methodOffset = 0,
		retryController?: AbortController,
		onCommitted?: () => void,
	): Promise<CompactionResult> {
		return this.#controller.compact(customInstructions, options, methodOffset, retryController, onCommitted);
	}

	abortCompaction(reason?: unknown): Promise<void> | undefined {
		return this.#controller.abortCompaction(reason);
	}

	waitForManualCompactionCleanup(): Promise<((startedTurn: boolean) => void) | undefined> {
		return this.#controller.waitForManualCompactionCleanup();
	}

	claimPendingResume(): ((startedTurn: boolean) => void) | undefined {
		return this.#controller.claimPendingResume();
	}

	noteTurnStarted(): void {
		this.#controller.noteTurnStarted();
	}

	abortAutomaticCompaction(): void {
		this.#controller.abortAutomaticCompaction();
	}

	runIdleCompaction(): Promise<void> {
		return this.#controller.runIdleCompaction();
	}

	handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		return this.#controller.handoff(customInstructions, options);
	}

	maybeStartSpeculativeCompaction(contextTokens: number, contextWindow: number): void {
		this.#controller.maybeStartSpeculativeCompaction(contextTokens, contextWindow);
	}

	deferThresholdCompactionToSpeculation(contextTokens: number, contextWindow: number): boolean {
		return this.#controller.deferThresholdCompactionToSpeculation(contextTokens, contextWindow);
	}

	runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		return this.#controller.runPrePromptCompactionIfNeeded(messages);
	}

	maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		return this.#controller.maintainContextMidRun(activeMessages, signal, context);
	}

	checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		allowDefer = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		return this.#controller.checkCompaction(assistantMessage, skipAbortedCheck, allowDefer, autoContinue);
	}

	resolveContextPromotionTarget(
		currentModel: Model,
		contextWindow: number,
		signal?: AbortSignal,
	): Promise<Model | undefined> {
		return this.#controller.resolveContextPromotionTarget(currentModel, contextWindow, signal);
	}

	resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		return this.#controller.resolveCompactionModelCandidates(preferredModel, availableModels, filter);
	}

	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean {
		return this.#controller.contextFitsModel(model, excludedMessage);
	}

	runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			pendingContextTokens?: number;
			preparedContextTokens?: number;
			suppressContinuation?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
			detachPostCommit?: boolean;
			methodIndex?: number;
			fallbackFromShake?: boolean;
			explicitNewContextRequest?: boolean;
			excludeMediaMethods?: boolean;
		} = {},
	): Promise<CompactionCheckResult> {
		return this.#controller.runAutoCompaction(reason, willRetry, deferred, allowDefer, options);
	}

	setAutoCompactionEnabled(enabled: boolean, persist = false): void {
		this.#controller.setAutoCompactionEnabled(enabled, persist);
	}

	get autoCompactionEnabled(): boolean {
		return this.#controller.autoCompactionEnabled;
	}
}
