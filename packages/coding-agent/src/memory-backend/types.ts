/**
 * Memory backend abstraction.
 *
 * One store is selected. `await resolveMemoryBackend(settings)` returns a single
 * `MemoryBackend`, and everything that goes through this abstraction goes through
 * that one object. Not everything does: the built-in `recall`, `retain` and
 * `reflect` tools gate on `memory.backend` directly and reach their own session
 * state, which is why the wrapper below has to keep the store's `id`.
 * Implementations MUST be self-contained: they own the per-session state they
 * create in `start()` and tear it down on `clear()`.
 *
 * `sharpshooter.enabled` is the one case where that object composes two backends
 * rather than being a store itself. Sharpshooter distills project decisions instead
 * of storing memories, so it runs beside the selected store and the selection is
 * wrapped to drive both. The wrapper keeps the store's `id`, leaving tool gating
 * that reads `memory.backend` unaffected, and it deliberately does not fan every
 * method out: `clear` and `enqueue` reach the store alone, since both can destroy or
 * erode decision files that keep no history to restore from. See
 * `with-sharpshooter.ts`.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";

export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "sharpshooter";

export interface MemoryBackendStatus {
	backend: MemoryBackendId;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

export interface MemoryBackendSearchOptions {
	limit?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying recall call. */
	signal?: AbortSignal;
}

export interface MemoryBackendSearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}

export interface MemoryBackendSearchResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendSearchItem[];
	message?: string;
}

export interface MemoryBackendSaveInput {
	content: string;
	context?: string;
	source?: string;
	importance?: number;
}

export interface MemoryBackendSaveResult {
	backend: MemoryBackendId;
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
}

export interface MemoryBackendOperationContext {
	agentDir: string;
	cwd: string;
	session?: AgentSession;
}

export interface MemoryRuntimeContext {
	status(): Promise<MemoryBackendStatus>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
}

/**
 * Why a backend is being started.
 *
 * `"start"` is a fresh install for the project the session is already in, and a
 * backend may catch up on transcript state it missed while it was being resolved.
 * `"rebind"` says the session's cwd moved: the transcript it can see belongs to
 * the project it just left, so nothing in it may be attributed to the destination.
 */
export type MemoryBackendStartReason = "start" | "rebind";

export interface MemoryBackendStartOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	/** Defaults to `"start"`; every cwd-move path must pass `"rebind"`. */
	reason?: MemoryBackendStartReason;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
}

/** A successful recall, including an empty result, staged until user-turn delivery. */
export interface MemoryPromptPreparation {
	context?: string;
	/** Commit synchronously after delivery validation; false rejects lost ownership without state writes. */
	commit(): boolean;
}

export interface MemoryBackend {
	readonly id: MemoryBackendId;

	/**
	 * Wire any background work or session subscriptions for this backend.
	 *
	 * Called once per agent session at startup. Implementations MUST be
	 * non-throwing: failures should be logged and swallowed so a misconfigured
	 * memory backend cannot break the agent loop.
	 */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/**
	 * Markdown injected as the system-prompt append section.
	 * Returned on every prompt rebuild via `refreshBaseSystemPrompt()`.
	 */
	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Structured state for UI, slash commands, and extensions. */
	status?(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus>;

	/** Explicit user-facing semantic/lexical search. */
	search?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult>;

	/** Explicit user-facing save operation. */
	save?(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;

	/** Render backend-specific memory statistics as markdown (`/memory stats`). */
	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	/** Render backend-specific memory diagnostics as markdown (`/memory diagnose`). */
	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	/** Render pending deltas awaiting consolidation (`/memory queue`). */
	queuePreview?(context: MemoryBackendOperationContext): Promise<string | undefined>;
	/**
	 * Optional hook to inject a backend-specific block into the current turn's
	 * system prompt before the agent starts generating.
	 *
	 * This is the only place a backend can affect the very first answer of a
	 * fresh session. Context is appended to the winning base prompt at delivery;
	 * commit publishes the cached snippet and first-turn consumption together.
	 * Return undefined for an ineligible or failed recall, not an empty success.
	 */
	beforeAgentStartPrompt?(
		session: AgentSession,
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined>;

	/**
	 * Optional hook to splice extra context into a compaction summarization.
	 *
	 * Called from the compaction call site before the LLM summary is requested.
	 * Returning a string appends one entry to the compaction's `extraContext`
	 * list (which becomes part of the summarization prompt). Return `undefined`
	 * to inject nothing — the local backend takes this branch because its
	 * summary is already part of the system prompt.
	 */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/**
	 * Optional hook to apply live edits to this backend's own `<id>.*` settings
	 * (`changed` lists them) in a running top-level session. When omitted, the
	 * session re-applies the whole backend (`applyMemoryBackend`), which rebuilds
	 * its runtime state, memory tools, and prompt from the current settings.
	 */
	applySettings?(session: AgentSession, changed: readonly string[]): Promise<void>;
}
