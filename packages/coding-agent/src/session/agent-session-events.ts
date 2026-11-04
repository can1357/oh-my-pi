import type { AgentEvent, ThinkingLevel, ToolExecution } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import type { CustomMessage } from "./messages";
import type { CacheWarmingRefreshEnd, CacheWarmingRefreshStart } from "./cache-warmer";
import type { BlockedKind } from "../utils/run-status";

/** Session-specific events that extend the core AgentEvent. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| (Extract<AgentEvent, { type: "agent_end" }> & {
			/** False when an async delivery will resume the session before its true final settle. */
			isTerminal?: boolean;
			/**
			 * True when the agent finished its turn: the end is terminal, or the session resumes
			 * only for queued input or background-job results. False while the agent continues its
			 * own work (retry, compaction continuation, stop-time reminders).
			 */
			yielded?: boolean;
			/**
			 * True on a non-terminal end whose only possible resume is a background-job result
			 * (no queued input, no continuation the agent scheduled itself). The wake is not
			 * guaranteed: a cancelled or suppressed job never delivers one.
			 */
			awaitingAsyncWork?: boolean;
	  })
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
	  }
	// One pair per manual compaction (RPC `compact`, `/compact`, extension
	// `ctx.compact()`), emitted once the live turn is aborted; fallback passes to
	// the next configured method stay inside the same pair.
	| {
			type: "manual_compaction_start";
			/** The `/compact <mode>` subcommand, when one was given. */
			mode?: string;
	  }
	| {
			type: "manual_compaction_end";
			/** Present when the compaction committed. */
			result?: CompactionResult;
			/** True when the compaction was cancelled (abort, or a `session_before_compact` hook). */
			aborted: boolean;
			/** True when there was nothing to compact; `errorMessage` says why. */
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| ({ type: "cache_warming_start" } & CacheWarmingRefreshStart)
	| ({ type: "cache_warming_end" } & CacheWarmingRefreshEnd)
	| { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "config_warnings_changed" }
	| { type: "advisor_cost_changed" }
	| { type: "advisor_yielded" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level. */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	// Coalesced snapshot of the displayable steering/follow-up queue: emitted
	// whenever it differs from the last `queue_update` (enqueue, dequeue on
	// delivery, remove, clear/restore, live-steering adoption/withdrawal, or
	// session switch), never on a no-op mutation. Mirrors
	// `AgentSession.getQueuedMessages()`; `liveSteered` counts the leading
	// `steering` entries already sent into the streaming response, which
	// `remove_queued_message` cannot reach.
	| { type: "queue_update"; steering: string[]; followUp: string[]; liveSteered: number }
	// A dialog the session itself opened mid-turn and that only a person can
	// answer: the coding-plan reserve prompt, an MCP sign-in, a `cfg://` write,
	// a plan approval, an ACP permission request. `start` carries what is being
	// asked and is emitted when the first one opens; `end` when the last one
	// settles. Without these a surface showing run state cannot tell a session
	// that is working from one that has been waiting for a person for hours.
	// `prompt` and `kind` are the dialog's own words and classification, so a
	// surface that attaches mid-wait (a focus rebuild, a reconnecting RPC
	// client) reports the operation being approved rather than a generic label
	// it has no way to refine. `toolCalls` names every tool call whose dialog
	// is open, so a surface tracking a call knows when that call's own wait
	// ends — which is not when the last dialog settles, and not something the
	// oldest dialog's words can be read to mean.
	| { type: "user_wait_start"; prompt: string; kind?: BlockedKind; toolCalls?: string[] }
	| { type: "user_wait_end" };

/** What one dialog waiting on a person asks, and how a surface that reports run state classifies it. */
export interface UserWaitFrame {
	/** The dialog's own words: the operation it asks to approve, or the question it asks. */
	prompt: string;
	/** Absent when the opener named no classification; such a wait reads as a question. */
	kind?: BlockedKind;
	/**
	 * The tool call this dialog's own caller named, when it named one: an ACP permission request,
	 * an approval a tool asks for. A caller that names a call asserts it about this moment, so it
	 * is taken at its word. Absent for a dialog that stands on its own (an MCP sign-in, a `cfg://`
	 * write, an extension's own question), which owns no call and so retires none.
	 */
	toolCallId?: string;
	/**
	 * The execution the `ui` this dialog came from was handed to, when it came from a call's own
	 * `ui`. Its holder keeps that `ui` after the call is over, and a later call can reuse the id,
	 * so what is kept is the run itself: it identifies the dialog's call only while that run lasts.
	 * Never serialized — it is an in-process handle, not part of any wire frame.
	 */
	toolCallExecution?: ToolExecution;
	/**
	 * True when this dialog came from a `ui` handed to one tool call. Such a dialog belongs to that
	 * call's run and to nothing else: when {@link toolCallExecution} is absent or over, the dialog
	 * names no call, rather than falling back to whatever happens to be executing around it.
	 */
	toolCallOwned?: boolean;
}

/**
 * What `user_wait_start` carries when the caller named nothing: an SDK caller
 * on the one-argument `waitForUser` still produces a valid frame, and the
 * surfaces that report run state still say a person is owed an answer.
 */
export const UNNAMED_USER_WAIT_PROMPT = "a dialog waiting for you";

/**
 * How a session identifies one run of one tool call to a surface that must compare across a gap
 * it saw nothing through — a focus handover, a reconnect. `mark` is equal only for the same run
 * of the same call in the same session, and stays unique for that session's whole life, so a
 * logical reset that recycles call ids cannot hand an old record to a new run. `live` says
 * whether that run is still going: a surface restoring what it recorded needs both, since the
 * same terminal mark on both sides still describes a call that is over.
 */
export interface ToolCallRunMark {
	readonly mark: string;
	readonly live: boolean;
}

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
