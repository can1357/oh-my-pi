/**
 * Memory Fabric — session bridge.
 *
 * The driver for the lifecycle layer. A session calls the eight methods on this
 * class at the natural boundaries of a turn; the bridge turns each call into a
 * well-formed `MemoryLifecycleEvent`, publishes it on the bus, invokes the
 * matching participant hook under a deadline, and reports what happened.
 *
 * Everything here exists to keep memory work off the critical path in the only
 * sense that matters — the turn must finish whether or not memory does:
 *
 *   - **Bounded.** Every hook runs under `withDeadline`. A wedged backend
 *     degrades into *no memory*, never into a hung turn. Checkpoints get a
 *     longer budget than recall because they run during compaction, not
 *     between a keystroke and the model call.
 *   - **Fail-open by default.** A hook that throws, rejects or times out yields
 *     the neutral value for that hook (`null`, or nothing at all). Setting
 *     `failOpen: false` re-raises instead, which is useful in tests and in
 *     deployments that would rather fail loudly than silently lose memory.
 *   - **Observable.** Every hook emits one `MemoryLifecycleTelemetry` record,
 *     including on the failure and timeout paths, carrying the same sequence
 *     number as the event that triggered it so the two can be joined.
 *
 * Two details are worth calling out because they are easy to get wrong:
 *
 *   - Hooks are invoked through a thunk, not by passing an already-created
 *     promise. A participant that throws *synchronously* would otherwise
 *     escape the deadline wrapper entirely and propagate into the turn.
 *   - `depth` and `causationId` are caller-supplied rather than hardcoded to
 *     `0`/absent, which is what makes the bus's re-entrancy guard reachable:
 *     memory work that provokes more memory work can be tagged as nested and
 *     dropped instead of amplifying.
 *
 * Deliberately *not* here: rendering the packet into a provider message. That
 * is `context-injection.ts`'s job (`formatMemoryContext` / `appendMemoryContext`),
 * and keeping it there leaves this module free of any dependency on the agent's
 * message types.
 */

import { randomUUID } from "node:crypto";
import { DeadlineExceededError, withDeadline } from "./deadline";
import type { SessionEventBus } from "./event-bus";
import type {
	AfterToolCallEvent,
	BeforeCompactionEvent,
	BeforeModelEvent,
	BeforeToolCallEvent,
	ContinuationCapsule,
	MemoryContextPacket,
	MemoryEventMetadata,
	MemoryEventOrigin,
	MemoryLifecycleEvent,
	MemorySessionScope,
	MemoryToolAdvisory,
	SessionMemoryParticipant,
	SessionResumeEvent,
	SessionStartEvent,
	SessionStopEvent,
	UserPromptEvent,
} from "./types";

/** Recall sits between the keystroke and the model call, so its budget is small. */
export const DEFAULT_NORMAL_DEADLINE_MS = 150;

/** Checkpoints run during compaction, off the interactive path, so they get more room. */
export const DEFAULT_CHECKPOINT_DEADLINE_MS = 1000;

/**
 * A monotonic sequence source.
 *
 * `SessionEventBus` deliberately does not declare this — it is an
 * implementation detail of `InProcessSessionEventBus` — but the bridge needs a
 * total order over the events it publishes. Requiring it in the options type
 * states that dependency instead of casting it on at runtime.
 */
export interface SequenceSource {
	nextSequence(): number;
}

export type SequencedSessionEventBus = SessionEventBus & SequenceSource;

/** The lifecycle points the bridge drives, named after the events they publish. */
export type MemoryLifecycleHook = MemoryLifecycleEvent["type"];

export interface MemoryLifecycleTelemetry {
	event: "memory.lifecycle";
	hook: MemoryLifecycleHook;
	/** The sequence of the event that triggered the hook, for joining the two. */
	sequence: number;
	participant: string;
	durationMs: number;
	outcome: "completed" | "failed" | "timeout";
	correlationId: string;
	causationId?: string;
	turnId?: string;
	toolCallId?: string;
}

/**
 * Per-call envelope overrides.
 *
 * Supplying `causationId` and `depth` is what lets a caller mark an event as
 * caused by an earlier one, which the bus uses to refuse to re-enter itself.
 */
export interface LifecycleCallOptions {
	correlationId?: string;
	causationId?: string;
	turnId?: string;
	toolCallId?: string;
	depth?: number;
}

/**
 * Structural view of the hooks the bridge calls.
 *
 * `SessionMemoryParticipant` is an empty marker interface by design: every hook
 * is optional, so a participant implements only the points it cares about. The
 * bridge therefore narrows to this structural view and calls every hook
 * defensively — the same approach `CompositeSessionParticipant` takes.
 */
interface BridgeParticipant extends SessionMemoryParticipant {
	participantName?: string;
	onSessionStart?(event: SessionStartEvent): Promise<void> | void;
	onUserPrompt?(event: UserPromptEvent): Promise<void> | void;
	prepareContext?(event: BeforeModelEvent): Promise<MemoryContextPacket | null> | MemoryContextPacket | null;
	beforeToolCall?(event: BeforeToolCallEvent): Promise<MemoryToolAdvisory | null> | MemoryToolAdvisory | null;
	afterToolCall?(event: AfterToolCallEvent): Promise<void> | void;
	checkpoint?(event: BeforeCompactionEvent): Promise<ContinuationCapsule | null> | ContinuationCapsule | null;
	onResume?(event: SessionResumeEvent): Promise<void> | void;
	stop?(event: SessionStopEvent): Promise<void> | void;
}

export interface MemorySessionBridgeOptions {
	scope: MemorySessionScope;
	eventBus: SequencedSessionEventBus;
	participant: SessionMemoryParticipant;
	/** Budget for interactive hooks. Defaults to `DEFAULT_NORMAL_DEADLINE_MS`. */
	normalDeadlineMs?: number;
	/** Budget for `beforeCompaction`. Defaults to `DEFAULT_CHECKPOINT_DEADLINE_MS`. */
	checkpointDeadlineMs?: number;
	/** When false, hook failures re-raise instead of degrading. Defaults to true. */
	failOpen?: boolean;
	/** Injectable clock, for deterministic tests. */
	now?: () => number;
	/** Injectable id source, for deterministic tests. */
	newId?: () => string;
}

export class MemorySessionBridge {
	readonly #scope: MemorySessionScope;
	readonly #eventBus: SequencedSessionEventBus;
	readonly #participant: BridgeParticipant;
	readonly #normalDeadlineMs: number;
	readonly #checkpointDeadlineMs: number;
	readonly #failOpen: boolean;
	readonly #now: () => number;
	readonly #newId: () => string;
	readonly #telemetryListeners = new Set<(event: MemoryLifecycleTelemetry) => void>();

	constructor(options: MemorySessionBridgeOptions) {
		this.#scope = options.scope;
		this.#eventBus = options.eventBus;
		this.#participant = options.participant as BridgeParticipant;
		this.#normalDeadlineMs = options.normalDeadlineMs ?? DEFAULT_NORMAL_DEADLINE_MS;
		this.#checkpointDeadlineMs = options.checkpointDeadlineMs ?? DEFAULT_CHECKPOINT_DEADLINE_MS;
		this.#failOpen = options.failOpen ?? true;
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? randomUUID;
	}

	/** Name of the participant this bridge drives, as it appears in telemetry. */
	get participantName(): string {
		return this.#participant.participantName ?? "unknown";
	}

	/** Subscribe to lifecycle telemetry. Returns an idempotent unsubscribe handle. */
	onTelemetry(listener: (event: MemoryLifecycleTelemetry) => void): () => void {
		this.#telemetryListeners.add(listener);
		return () => {
			this.#telemetryListeners.delete(listener);
		};
	}

	#emitTelemetry(record: MemoryLifecycleTelemetry): void {
		for (const listener of this.#telemetryListeners) {
			try {
				listener(record);
			} catch (error) {
				// Diagnostics must never be the thing that takes a turn down.
				console.warn("[memory-fabric] telemetry listener failed", error);
			}
		}
	}

	#envelope(
		origin: MemoryEventOrigin,
		options: LifecycleCallOptions,
	): { metadata: MemoryEventMetadata; correlationId: string; sequence: number } {
		const correlationId = options.correlationId ?? this.#newId();
		const sequence = this.#eventBus.nextSequence();
		const metadata: MemoryEventMetadata = {
			origin,
			correlationId,
			depth: options.depth ?? 0,
			sequence,
			timestamp: this.#now(),
		};
		// Assigned conditionally rather than as explicit `undefined`, so the
		// shapes stay valid under `exactOptionalPropertyTypes`.
		if (options.causationId !== undefined) metadata.causationId = options.causationId;
		if (options.turnId !== undefined) metadata.turnId = options.turnId;
		if (options.toolCallId !== undefined) metadata.toolCallId = options.toolCallId;
		return { metadata, correlationId, sequence };
	}

	async #emit(event: MemoryLifecycleEvent): Promise<void> {
		try {
			await this.#eventBus.emit(event);
		} catch (error) {
			// The bus is fail-open by contract, but a third-party implementation
			// that throws must still not be able to break the turn.
			console.warn("[memory-fabric] lifecycle bus emit failed", error);
		}
	}

	/**
	 * Publish the event, then run the matching hook under a deadline.
	 *
	 * `invoke` is a thunk rather than a promise so that a participant which
	 * throws synchronously is caught here instead of escaping into the turn.
	 */
	async #dispatch<T>(
		event: MemoryLifecycleEvent,
		timeoutMs: number,
		fallback: T,
		invoke: () => Promise<T | null | undefined> | T | null | undefined,
	): Promise<T> {
		await this.#emit(event);

		const started = this.#now();
		let outcome: MemoryLifecycleTelemetry["outcome"] = "completed";
		try {
			const result = await withDeadline(Promise.resolve().then(invoke), timeoutMs);
			return (result ?? fallback) as T;
		} catch (error) {
			outcome = error instanceof DeadlineExceededError ? "timeout" : "failed";
			if (!this.#failOpen) throw error;
			return fallback;
		} finally {
			const record: MemoryLifecycleTelemetry = {
				event: "memory.lifecycle",
				hook: event.type,
				sequence: event.sequence,
				participant: this.participantName,
				durationMs: this.#now() - started,
				outcome,
				correlationId: event.metadata.correlationId,
			};
			if (event.metadata.causationId !== undefined) record.causationId = event.metadata.causationId;
			if (event.metadata.turnId !== undefined) record.turnId = event.metadata.turnId;
			if (event.metadata.toolCallId !== undefined) record.toolCallId = event.metadata.toolCallId;
			this.#emitTelemetry(record);
		}
	}

	async sessionStart(resumed: boolean, options: LifecycleCallOptions = {}): Promise<void> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: SessionStartEvent = { type: "session_start", metadata, scope: this.#scope, sequence, resumed };
		await this.#dispatch<void>(event, this.#normalDeadlineMs, undefined, () =>
			this.#participant.onSessionStart?.(event),
		);
	}

	async userPrompt(text: string, options: LifecycleCallOptions = {}): Promise<void> {
		const { metadata, sequence } = this.#envelope("user", options);
		const event: UserPromptEvent = { type: "user_prompt", metadata, scope: this.#scope, sequence, text };
		await this.#dispatch<void>(event, this.#normalDeadlineMs, undefined, () =>
			this.#participant.onUserPrompt?.(event),
		);
	}

	async beforeModel(
		userText: string,
		activeContextText?: string,
		options: LifecycleCallOptions = {},
	): Promise<MemoryContextPacket | null> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: BeforeModelEvent = {
			type: "before_model",
			metadata,
			scope: this.#scope,
			sequence,
			userText,
		};
		if (activeContextText !== undefined) event.activeContextText = activeContextText;
		return this.#dispatch<MemoryContextPacket | null>(event, this.#normalDeadlineMs, null, () =>
			this.#participant.prepareContext?.(event),
		);
	}

	async beforeToolCall(
		toolName: string,
		input: unknown,
		options: LifecycleCallOptions = {},
	): Promise<MemoryToolAdvisory | null> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: BeforeToolCallEvent = {
			type: "before_tool_call",
			metadata,
			scope: this.#scope,
			sequence,
			toolName,
			input,
		};
		return this.#dispatch<MemoryToolAdvisory | null>(event, this.#normalDeadlineMs, null, () =>
			this.#participant.beforeToolCall?.(event),
		);
	}

	async afterToolCall(
		toolName: string,
		input: unknown,
		output: unknown,
		success: boolean,
		durationMs: number,
		options: LifecycleCallOptions = {},
	): Promise<void> {
		const { metadata, sequence } = this.#envelope("tool", options);
		const event: AfterToolCallEvent = {
			type: "after_tool_call",
			metadata,
			scope: this.#scope,
			sequence,
			toolName,
			input,
			output,
			success,
			durationMs,
		};
		await this.#dispatch<void>(event, this.#normalDeadlineMs, undefined, () =>
			this.#participant.afterToolCall?.(event),
		);
	}

	async beforeCompaction(reason: string, options: LifecycleCallOptions = {}): Promise<ContinuationCapsule | null> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: BeforeCompactionEvent = {
			type: "before_compaction",
			metadata,
			scope: this.#scope,
			sequence,
			reason,
		};
		return this.#dispatch<ContinuationCapsule | null>(event, this.#checkpointDeadlineMs, null, () =>
			this.#participant.checkpoint?.(event),
		);
	}

	async resume(options: LifecycleCallOptions = {}): Promise<void> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: SessionResumeEvent = { type: "session_resume", metadata, scope: this.#scope, sequence };
		await this.#dispatch<void>(event, this.#normalDeadlineMs, undefined, () => this.#participant.onResume?.(event));
	}

	async stop(reason: string, options: LifecycleCallOptions = {}): Promise<void> {
		const { metadata, sequence } = this.#envelope("main-agent", options);
		const event: SessionStopEvent = { type: "session_stop", metadata, scope: this.#scope, sequence, reason };
		await this.#dispatch<void>(event, this.#normalDeadlineMs, undefined, () => this.#participant.stop?.(event));
	}
}
