import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal, GoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { TodoItem } from "../tools/todo";
import type { CustomMessage } from "./messages";

/** Session-specific events that extend the core AgentEvent. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| (Extract<AgentEvent, { type: "agent_end" }> & {
			/** False when an async delivery will resume the session before its true final settle. */
			isTerminal?: boolean;
	  })
	| {
			type: "auto_compaction_start";
			/**
			 * `manual` is an operator asking for it. The other four are the engine's
			 * own triggers.
			 *
			 * A manual pass used to emit nothing at all, which left every non-TUI
			 * client to infer the outcome from the prose the slash command prints.
			 * The two paths are the same operation and now announce themselves the
			 * same way; the reason is what tells them apart.
			 */
			reason: "threshold" | "overflow" | "idle" | "incomplete" | "manual";
			/** `soft` only ever reaches here from a manual pass; the rest are shared. */
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact" | "soft";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact" | "soft";
			/**
			 * Why the pass ran, echoed from its `auto_compaction_start`.
			 *
			 * Optional because it arrived after the event did. A consumer that has to
			 * tell a user-initiated pass from one the engine started needs it on both
			 * halves: the TUI stands down for `manual` on either, and pairing by
			 * arrival order is not something a bus with several front-ends can offer.
			 */
			reason?: "threshold" | "overflow" | "idle" | "incomplete" | "manual";
			result: CompactionResult | undefined;
			/**
			 * Context tokens after the rewrite. `CompactionResult` carries only
			 * `tokensBefore` — the after is computed at commit time — so without this
			 * a client cannot report the one number the operator wants.
			 */
			tokensAfter?: number;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
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
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "advisor_cost_changed" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	/**
	 * Plan mode moved, whoever moved it.
	 *
	 * Modelled on `goal_updated` below: a mode is state, and a client that has to
	 * poll for state drifts the moment anything changes it from elsewhere.
	 */
	| { type: "plan_mode_changed"; enabled: boolean; planFilePath?: string }
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
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
