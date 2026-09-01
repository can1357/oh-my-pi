/**
 * Event payload and result shapes shared between the extensions and hooks
 * subsystems.
 *
 * Both subsystems observe the same agent/session lifecycle, so the *event*
 * payloads (what happened) and the simpler *result* shapes (handler return
 * values that don't depend on subsystem-specific identifiers like
 * `AgentMessage` vs `Message`) are intentionally identical.
 *
 * Anything that diverges between the two subsystems — UI context, runtime
 * context, command context, tool-call discrimination, or return shapes that
 * carry subsystem-specific message types — lives in the per-subsystem
 * `types.ts` files and is documented there.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { Goal, GoalModeState } from "../goals/state";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../session/session-entries";
import type { TodoItem } from "../tools/todo";

// ============================================================================
// Session Events
// ============================================================================

/** Fired on initial session load */
export interface SessionStartEvent {
	type: "session_start";
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	/** Reason for the switch */
	reason: "new" | "resume" | "fork";
	/** Session file we're switching to (only for "resume") */
	targetSessionFile?: string;
}

/** Fired after switching to another session */
export interface SessionSwitchEvent {
	type: "session_switch";
	/** Reason for the switch */
	reason: "new" | "resume" | "fork";
	/** Session file we came from */
	previousSessionFile: string | undefined;
}

/** Fired before branching a session (can be cancelled) */
export interface SessionBeforeBranchEvent {
	type: "session_before_branch";
	/** ID of the entry to branch from */
	entryId: string;
}

/** Fired after branching a session */
export interface SessionBranchEvent {
	type: "session_branch";
	previousSessionFile: string | undefined;
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	/** Compaction preparation with messages to summarize, file ops, previous summary, etc. */
	preparation: CompactionPreparation;
	/** Branch entries (root to current leaf). Use to inspect custom state or previous compactions. */
	branchEntries: SessionEntry[];
	/** Optional user-provided instructions for the summary */
	customInstructions?: string;
	/** Abort signal - handlers should pass this to LLM calls and check it periodically */
	signal: AbortSignal;
}

/** Fired before compaction summarization to customize prompts/context */
export interface SessionCompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: AgentMessage[];
}

/** Fired after context compaction */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	/** Whether the compaction entry was provided by an extension/hook */
	fromExtension: boolean;
}

/** Fired on process exit (SIGINT/SIGTERM) */
export interface SessionShutdownEvent {
	type: "session_shutdown";
}

/** Fired when a main-agent turn is about to settle; handlers may request one continuation turn. */
export interface SessionStopEvent {
	type: "session_stop";
	messages: AgentMessage[];
	turn_id: number;
	last_assistant_message?: AgentMessage;
	session_id: string;
	session_file?: string;
	stop_hook_active: boolean;
	/** Cancels handler waiting when the active settle pass is aborted. */
	signal: AbortSignal;
}

/** Preparation data for tree navigation (used by session_before_tree event) */
export interface TreePreparation {
	/** Node being switched to */
	targetId: string;
	/** Current active leaf (being abandoned), null if no current position */
	oldLeafId: string | null;
	/** Common ancestor of target and old leaf, null if no common ancestor */
	commonAncestorId: string | null;
	/** Entries to summarize (old leaf back to common ancestor or compaction) */
	entriesToSummarize: SessionEntry[];
	/** Whether user chose to summarize */
	userWantsSummary: boolean;
}

/** Fired before navigating to a different node in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	/** Preparation data for the navigation */
	preparation: TreePreparation;
	/** Abort signal - honors Escape during summarization (model available via ctx.model) */
	signal: AbortSignal;
}

/** Fired after navigating to a different node in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	/** The new active leaf, null if navigated to before first entry */
	newLeafId: string | null;
	/** Previous active leaf, null if there was no position */
	oldLeafId: string | null;
	/** Branch summary entry if one was created */
	summaryEntry?: BranchSummaryEntry;
	/** Whether summary came from extension/hook */
	fromExtension?: boolean;
}

/** Union of all session event types */
export interface GoalUpdatedEvent {
	type: "goal_updated";
	goal: Goal | null;
	state?: GoalModeState;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeBranchEvent
	| SessionBranchEvent
	| SessionBeforeCompactEvent
	| SessionCompactingEvent
	| SessionCompactEvent
	| SessionStopEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| GoalUpdatedEvent;

// ============================================================================
// Agent / Turn Events
// ============================================================================

/**
 * Fired before each LLM call.
 *
 * Original session messages are NOT modified - only the messages sent to the
 * LLM are affected when a handler returns a replacement (the return shape
 * differs between extensions and hooks; see each subsystem's
 * `ContextEventResult`).
 */
export interface ContextEvent {
	type: "context";
	/** Messages about to be sent to the LLM (deep copy, safe to modify) */
	messages: AgentMessage[];
}

/**
 * Fired when an agent loop starts (once per user prompt).
 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
	/**
	 * When true, the session has already scheduled an automatic continuation
	 * (auto-retry, empty/unexpected-stop retry, etc.). Subscribers must not
	 * treat this as a user-visible terminal settle.
	 */
	willContinue?: boolean;
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

// ============================================================================
// Auto-compaction / Auto-retry Events
// ============================================================================

/** Fired when auto-compaction starts */
export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
}

/** Fired when auto-compaction ends */
export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
	skipped?: boolean;
}

/** Fired when auto-retry starts */
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	errorId?: number;
}

/** Persisted retry error whose transcript presentation changed when the retry saga settled. */
export interface RetryErrorUpdate {
	entryId: string;
	persistenceKey?: string;
	note: string;
	retryRecovery: AssistantRetryRecovery;
}

/** Fired when auto-retry ends */
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
	retryErrors?: RetryErrorUpdate[];
}

/** Fired when auto-retry switches to a configured fallback model/provider. */
export interface RetryFallbackAppliedEvent {
	type: "retry_fallback_applied";
	from: string;
	to: string;
	role: string;
}

/** Fired when a request succeeds on the fallback model applied by auto-retry. */
export interface RetryFallbackSucceededEvent {
	type: "retry_fallback_succeeded";
	model: string;
	role: string;
}

// ============================================================================
// TTSR / Todo Reminders
// ============================================================================

/** Fired when TTSR rule matching interrupts generation */
export interface TtsrTriggeredEvent {
	type: "ttsr_triggered";
	rules: Rule[];
}

/** Fired when todo reminder logic detects unfinished todos */
export interface TodoReminderEvent {
	type: "todo_reminder";
	todos: TodoItem[];
	attempt: number;
	maxAttempts: number;
}

// ============================================================================
// Shared Event Result Shapes
// ============================================================================

/**
 * Return type for `tool_call` handlers.
 * Allows handlers to block tool execution or revise the input the tool runs with.
 */
export interface ToolCallEventResult {
	/** If true, block the tool from executing */
	block?: boolean;
	/** Reason for blocking (returned to LLM as error) */
	reason?: string;
	/**
	 * Replacement input the tool executes with, instead of the original arguments. Ignored when
	 * `block` is true. This is the raw execution input passed to the tool's `execute` (the handler
	 * owns its correctness) — not the normalized `event.input` view, which may carry derived
	 * gate-only fields (e.g. hashline `edit` `path`/`paths`) that are not real parameters. When
	 * multiple handlers set `input`, the last one wins; handlers do not observe each other's
	 * revisions (each sees the original `event.input`). Not applied to `computer` tool calls.
	 *
	 * For model-issued tool calls the event fires at arg-prep time in the agent loop, before
	 * concurrency scheduling, `tool_execution_start`, and the approval gate: the revision is
	 * revalidated against the tool schema and becomes what the loop schedules, displays, persists,
	 * and executes — the user always approves what actually runs. For dispatches the loop never
	 * sees (nested `write xd://` device calls, Cursor direct execution) the tool wrapper applies
	 * the revision before its own approval gate; a revised nested xd:// input forfeits the outer
	 * write gate's approval and faces the full prompt again.
	 */
	input?: Record<string, unknown>;
}

/**
 * Return type for `tool_result` handlers.
 * Allows handlers to modify tool results.
 */
export interface ToolResultEventResult {
	/** Replacement content array (text and images) */
	content?: (TextContent | ImageContent)[];
	/** Replacement details */
	details?: unknown;
	/** Override isError flag */
	isError?: boolean;
}

/** Return type for `session_before_switch` handlers */
export interface SessionBeforeSwitchResult {
	/** If true, cancel the switch */
	cancel?: boolean;
}

/** Return type for `session_before_branch` handlers */
export interface SessionBeforeBranchResult {
	/**
	 * If true, abort the branch entirely. No new session file is created,
	 * conversation stays unchanged.
	 */
	cancel?: boolean;
	/**
	 * If true, the branch proceeds (new session file created, session state updated)
	 * but the in-memory conversation is NOT rewound to the branch point.
	 *
	 * Use case: git-checkpoint handler that restores code state separately.
	 * The handler handles state restoration itself, so it doesn't want the
	 * agent's conversation to be rewound (which would lose recent context).
	 *
	 * - `cancel: true` → nothing happens, user stays in current session
	 * - `skipConversationRestore: true` → branch happens, but messages stay as-is
	 * - neither → branch happens AND messages rewind to branch point (default)
	 */
	skipConversationRestore?: boolean;
}

/** Return type for `session_before_compact` handlers */
export interface SessionBeforeCompactResult {
	/** If true, cancel the compaction */
	cancel?: boolean;
	/** Custom compaction result - SessionManager adds id/parentId */
	compaction?: CompactionResult;
}

/** Return type for `session.compacting` handlers */
export interface SessionCompactingResult {
	/** Additional context lines to include in summary */
	context?: string[];
	/** Override the default compaction prompt */
	prompt?: string;
	/** Custom data to store in compaction entry */
	preserveData?: Record<string, unknown>;
}

/** Return type for `session_stop` handlers */
export interface SessionStopEventResult {
	/** Continue the main session with additional context before settling */
	continue?: boolean;
	/** OMP-native model-visible context for the continuation */
	additionalContext?: string;
	/** Claude/Codex-compatible block decision; maps to a continuation */
	decision?: "block";
	/** Claude/Codex-compatible model-visible continuation reason */
	reason?: string;
}

/** Return type for `session_before_tree` handlers */
export interface SessionBeforeTreeResult {
	/** If true, cancel the navigation entirely */
	cancel?: boolean;
	/**
	 * Custom summary (skips default summarizer).
	 * Only used if preparation.userWantsSummary is true.
	 */
	summary?: {
		summary: string;
		details?: unknown;
	};
}
