/**
 * Continuation policy shared by the two entry points that resume an existing
 * transcript: `agentLoopContinue` (low level) and `Agent.continue()` (façade).
 *
 * Both used to encode the same rule separately — the loop entry validated by
 * throwing, the façade as a branch chain with drain/prefill/throw arms — so a
 * new resumable tail shape had to be added in three places. Here the rule is a
 * pure classifier plus one table: a new shape is a row in each, and the refusal
 * wording has exactly one definition.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "./types";

/**
 * What the transcript tail is. Deliberately free of intent: what to *do* with a
 * shape is {@link CONTINUATION_PLAN}'s business.
 */
export type TailShape =
	/** Nothing to resume. */
	| { readonly kind: "empty" }
	/** A `user`, `toolResult` or custom message: the provider takes the next turn. */
	| { readonly kind: "injectable" }
	/** An aborted (interrupted) partial assistant turn, replayable as prefill. */
	| { readonly kind: "prefill"; readonly assistant: AssistantMessage }
	/** A completed assistant turn: resuming needs a queued message. */
	| { readonly kind: "settled-assistant"; readonly assistant: AssistantMessage };

/** Which queue a pending message waits in. */
export type QueueKind = "steering" | "followUp";

/** Queue availability at the moment the decision is made. */
export interface QueueSnapshot {
	readonly steering: boolean;
	readonly followUp: boolean;
}

/** A snapshot for callers that have no queues (the raw loop entry point). */
export const NO_QUEUED_MESSAGES: QueueSnapshot = { steering: false, followUp: false };

/** Why a continuation cannot start. */
export type ContinuationRefusal = "empty" | "settled-assistant";

/** What to do about a {@link TailShape}. */
export type ContinuationPlan =
	/** Resume in place through the loop. */
	| { readonly step: "run" }
	/**
	 * Deliver queued messages first, in `buffers` order. Each buffer is dequeued
	 * in turn; the first non-empty one becomes the opening turn. `otherwise` is
	 * the refusal to raise when every buffer drains empty (a queue that emptied
	 * between the snapshot and the dequeue, or a signal that aborted the dequeue).
	 */
	| {
			readonly step: "dequeue";
			readonly buffers: readonly QueueKind[];
			readonly otherwise: ContinuationRefusal;
	  }
	| { readonly step: "refuse"; readonly reason: ContinuationRefusal };

/** A tail shape plus the plan it selects. */
export interface ContinuationDecision {
	readonly shape: TailShape;
	readonly plan: ContinuationPlan;
}

/** Delivery order for the dequeue step: live user input owns the turn before queued follow-ups. */
export const DEQUEUE_ORDER: readonly QueueKind[] = ["steering", "followUp"];

/** Classify the transcript tail. Pure. */
export function classifyTail(messages: readonly AgentMessage[]): TailShape {
	const tail = messages[messages.length - 1];
	if (tail === undefined) return { kind: "empty" };
	if (tail.role !== "assistant") return { kind: "injectable" };
	const assistant = tail as AssistantMessage;
	// `stopReason` is the whole test here: which aborts are *user* interrupts is a
	// host policy (`isUserInterruptAbort`) and stays there.
	return assistant.stopReason === "aborted"
		? { kind: "prefill", assistant }
		: { kind: "settled-assistant", assistant };
}

/**
 * Shape → plan. One row per tail shape; the queue snapshot carries the
 * precedence, so "queued messages win over an in-place resume" is stated once.
 */
export const CONTINUATION_PLAN: Record<TailShape["kind"], (queues: QueueSnapshot) => ContinuationPlan> = {
	// A queued steer/follow-up is delivered even from an empty transcript, as the
	// opening turn. Refusing here would leave the message undeliverable, and
	// idle-drain callers (`AgentSession#scheduleQueuedMessageDrain`) re-arm
	// `continue()` on every microtask because the queue never clears — an
	// unbounded allocation loop until OOM (issue #6344).
	empty: queues =>
		queues.steering || queues.followUp
			? { step: "dequeue", buffers: DEQUEUE_ORDER, otherwise: "empty" }
			: { step: "refuse", reason: "empty" },
	injectable: () => ({ step: "run" }),
	// An interrupted partial turn is resumable only when nothing is queued: with a
	// queue pending, the queued message owns the next turn (and settles the tail),
	// matching every other assistant tail. Draining instead of prefilling is why
	// `otherwise` is the settled-assistant refusal here.
	prefill: queues =>
		queues.steering || queues.followUp
			? { step: "dequeue", buffers: DEQUEUE_ORDER, otherwise: "settled-assistant" }
			: { step: "run" },
	"settled-assistant": queues =>
		queues.steering || queues.followUp
			? { step: "dequeue", buffers: DEQUEUE_ORDER, otherwise: "settled-assistant" }
			: { step: "refuse", reason: "settled-assistant" },
};

/** Classify the tail and select its plan in one call. */
export function decideContinuation(messages: readonly AgentMessage[], queues: QueueSnapshot): ContinuationDecision {
	const shape = classifyTail(messages);
	return { shape, plan: CONTINUATION_PLAN[shape.kind](queues) };
}

/**
 * Refusal wording per entry point: the raw loop is used by embedders, where
 * refusing is a programming error, while the façade's text is read by callers
 * that resume agent sessions.
 */
export const REFUSAL_TEXT: Record<ContinuationRefusal, { readonly loop: string; readonly session: string }> = {
	empty: {
		loop: "Cannot continue: no messages in context",
		session: "No messages to continue from",
	},
	"settled-assistant": {
		loop: "Cannot continue from message role: assistant",
		session: "Cannot continue from message role: assistant",
	},
};
