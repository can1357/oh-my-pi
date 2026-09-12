/** Session memory backend lifecycle and transcript resets. */

import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightConversationTrackingSnapshot, HindsightSessionState } from "../hindsight/state";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackendStartOptions } from "../memory-backend/types";
import type { MnemopiSessionState } from "../mnemopi/state";
import { releaseSharpshooterSession } from "../sharpshooter/backend";

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionMemoryHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	isDisposed(): boolean;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	getHindsightSessionState(): HindsightSessionState | undefined;
	setHindsightSessionState(state: HindsightSessionState | undefined): void;
	getMnemopiSessionState(): MnemopiSessionState | undefined;
	takeMnemopiSessionState(): MnemopiSessionState | undefined;
	setBaseSystemPrompt(prompt: string[]): void;
	refreshBaseSystemPrompt(): Promise<void>;
	replaceMemoryTools(tools: AgentTool[]): Promise<void>;
	rebaseHindsightCloseRetainBaseline(closeRetainBaselineTurns?: number): void;
}

/** Owns memory backend transitions and transcript-scoped memory state. */
export class SessionMemory {
	readonly #host: SessionMemoryHost;
	readonly #memoryAgentDir: string | undefined;
	readonly #memoryTaskDepth: number;
	readonly #createMemoryTools: (() => Promise<AgentTool[]>) | undefined;
	#memoryBackendTransition: Promise<void> = Promise.resolve();
	#localMemoryStartupAbort: AbortController | undefined;
	#baseSystemPromptBeforeMemoryPromotion: string[] | undefined;

	constructor(
		host: SessionMemoryHost,
		options: {
			memoryAgentDir?: string;
			memoryTaskDepth?: number;
			createMemoryTools?: () => Promise<AgentTool[]>;
		},
	) {
		this.#host = host;
		this.#memoryAgentDir = options.memoryAgentDir;
		this.#memoryTaskDepth = options.memoryTaskDepth ?? 0;
		this.#createMemoryTools = options.createMemoryTools;
	}

	/**
	 * Chain a backend start onto the serialized memory transition so leave-path
	 * drains and dispose wait for delayed Hindsight installation instead of
	 * treating a missing live state as having nothing pending.
	 */
	trackBackendStart(start: Promise<unknown>): void {
		const transition = this.#memoryBackendTransition.then(() => start);
		this.#memoryBackendTransition = transition.then(
			() => undefined,
			() => undefined,
		);
	}

	/** Current serialized backend transition, used by prompt and disposal drains. */
	get transition(): Promise<void> {
		return this.#memoryBackendTransition;
	}

	/** Base prompt captured before a per-turn memory promotion. */
	get promotionSnapshot(): string[] | undefined {
		return this.#baseSystemPromptBeforeMemoryPromotion;
	}

	/** Clears the per-turn memory promotion after a canonical prompt rebuild. */
	clearPromotionSnapshot(): void {
		this.#baseSystemPromptBeforeMemoryPromotion = undefined;
	}

	/** Captures the canonical prompt before the first per-turn memory promotion. */
	capturePromotionSnapshot(prompt: string[]): void {
		this.#baseSystemPromptBeforeMemoryPromotion ??= prompt;
	}

	/** Restores a promotion snapshot while rolling back a failed session switch. */
	restorePromotionSnapshot(prompt: string[] | undefined): void {
		this.#baseSystemPromptBeforeMemoryPromotion = prompt;
	}
	/** Rekeys memory backends after a conversation identity change. */
	rekeyForCurrentSessionId(): void {
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (this.#host.settings.get("memory.backend") !== "hindsight") return;
		// `/fresh` keeps the persisted conversation document. `/clear` overlays
		// `sessionId:resetBoundaryId` so resume reconstructs the same identity
		// and a later retain cannot replace the drained pre-clear history.
		const session = this.#host.memoryBackendSession();
		const sid = session.hindsightDocumentId ?? session.sessionManager.getSessionId();
		if (!sid) return;
		this.#host.getHindsightSessionState()?.setSessionId(sid);
	}

	captureHindsightConversationTracking(): HindsightConversationTrackingSnapshot | undefined {
		if (this.#host.settings.get("memory.backend") !== "hindsight") return undefined;
		const state = this.#host.getHindsightSessionState();
		if (!state || state.aliasOf) return undefined;
		return state.captureConversationTracking();
	}

	restoreHindsightConversationTracking(snapshot?: HindsightConversationTrackingSnapshot): void {
		if (!snapshot) return;
		if (this.#host.settings.get("memory.backend") !== "hindsight") return;
		const state = this.#host.getHindsightSessionState();
		if (!state || state.aliasOf) return;
		state.restoreConversationTracking(snapshot);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (this.#host.settings.get("memory.backend") !== "mnemopi") return;
		const sid = this.#host.agent.sessionId;
		if (!sid) return;
		this.#host.getMnemopiSessionState()?.setSessionId(sid);
	}

	/** Flush a below-cadence Hindsight tail while the current transcript is still loaded. */
	async drainHindsightPendingRetain(): Promise<void> {
		await this.#memoryBackendTransition;
		const hindsight = this.#host.getHindsightSessionState();
		if (!hindsight) return;
		try {
			await hindsight.drainOnClose();
		} catch (error) {
			logger.warn("Memory lifecycle: Hindsight leave-path flush failed", { error: String(error) });
		}
	}

	/** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
	#resetHindsightConversationTrackingIfHindsight(closeRetainBaselineTurns?: number): boolean {
		if (this.#host.settings.get("memory.backend") !== "hindsight") return false;
		const state = this.#host.getHindsightSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking(closeRetainBaselineTurns);
		return true;
	}

	#resetMnemopiConversationTrackingIfMnemopi(): boolean {
		if (this.#host.settings.get("memory.backend") !== "mnemopi") return false;
		const state = this.#host.getMnemopiSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	/** Resets transcript-scoped memory counters and removes a promoted prompt. */
	async resetContextForNewTranscript(options?: { closeRetainBaselineTurns?: number }): Promise<void> {
		const hadPromotedMemoryPrompt = this.#baseSystemPromptBeforeMemoryPromotion !== undefined;
		this.#host.rebaseHindsightCloseRetainBaseline(options?.closeRetainBaselineTurns);
		const resetHindsight = this.#resetHindsightConversationTrackingIfHindsight(options?.closeRetainBaselineTurns);
		const resetMnemopi = this.#resetMnemopiConversationTrackingIfMnemopi();
		if (hadPromotedMemoryPrompt) {
			this.#host.setBaseSystemPrompt(this.#baseSystemPromptBeforeMemoryPromotion!);
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		}
		if (resetHindsight || resetMnemopi || hadPromotedMemoryPrompt) {
			await this.#host.refreshBaseSystemPrompt();
		}
	}

	/** Cancel the local rollout-memory startup owned by this session. */
	cancelLocalMemoryStartup(): void {
		this.#localMemoryStartupAbort?.abort();
		this.#localMemoryStartupAbort = undefined;
	}

	/** Start a new local rollout-memory generation and cancel its predecessor. */
	beginLocalMemoryStartup(): AbortSignal {
		this.cancelLocalMemoryStartup();
		const controller = new AbortController();
		this.#localMemoryStartupAbort = controller;
		return controller.signal;
	}

	/** Release the local startup slot if `signal` still owns it. */
	endLocalMemoryStartup(signal: AbortSignal): void {
		if (this.#localMemoryStartupAbort?.signal === signal) this.#localMemoryStartupAbort = undefined;
	}

	async #disposeMemoryBackendState(consolidateMnemopi = true): Promise<void> {
		this.cancelLocalMemoryStartup();
		try {
			releaseSharpshooterSession(this.#host.memoryBackendSession());
		} catch (error) {
			logger.warn("Memory lifecycle: Sharpshooter dispose failed", { error: String(error) });
		}
		const hindsight = this.#host.getHindsightSessionState();
		if (hindsight) {
			try {
				await hindsight.drainOnClose();
			} catch (error) {
				logger.warn("Memory lifecycle: Hindsight flush failed", { error: String(error) });
			}
			this.#host.setHindsightSessionState(undefined);
			hindsight.dispose();
		}

		const mnemopi = this.#host.takeMnemopiSessionState();
		if (mnemopi) {
			try {
				await mnemopi.dispose({ consolidate: consolidateMnemopi });
			} catch (error) {
				logger.warn("Memory lifecycle: Mnemopi dispose failed", { error: String(error) });
			}
		}
	}

	/**
	 * Apply the selected memory backend to runtime state, tools, and prompt.
	 * Concurrent settings changes run in order and settle before the next turn.
	 */
	async applyMemoryBackend(): Promise<void> {
		if (this.#host.isDisposed()) return;
		const transition = this.#memoryBackendTransition.then(() => this.#applyMemoryBackend());
		this.#memoryBackendTransition = transition.then(
			() => undefined,
			() => undefined,
		);
		await transition;
	}

	async #applyMemoryBackend(): Promise<void> {
		if (this.#host.isDisposed()) return;
		try {
			await this.#disposeMemoryBackendState();
			if (this.#memoryAgentDir && this.#memoryTaskDepth === 0 && !this.#host.isDisposed()) {
				const backend = await resolveMemoryBackend(this.#host.settings);
				await backend.start({
					session: this.#host.memoryBackendSession(),
					settings: this.#host.settings,
					modelRegistry: this.#host.modelRegistry,
					agentDir: this.#memoryAgentDir,
					taskDepth: this.#memoryTaskDepth,
				});
			}
			if (this.#host.isDisposed()) return;
			await this.#refreshMemoryTools();
			if (this.#host.isDisposed()) return;
			await this.#host.refreshBaseSystemPrompt();
		} catch (error) {
			await this.#disposeMemoryBackendState(false);
			if (!this.#host.isDisposed()) {
				await this.#replaceMemoryTools([]).catch(refreshError => {
					logger.warn("Failed to remove memory tools after backend apply error", {
						error: String(refreshError),
					});
				});
			}
			throw error;
		}
	}

	async #refreshMemoryTools(): Promise<void> {
		const tools = (await this.#createMemoryTools?.()) ?? [];
		await this.#replaceMemoryTools(tools);
	}

	#replaceMemoryTools(tools: AgentTool[]): Promise<void> {
		return this.#host.replaceMemoryTools(tools);
	}
}
