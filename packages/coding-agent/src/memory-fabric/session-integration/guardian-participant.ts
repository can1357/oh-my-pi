/**
 * Memory Fabric — guardian session participant.
 *
 * The adapter between the two event vocabularies. `session-integration/` speaks
 * `MemoryLifecycleEvent` (underscored: `before_model`, `after_tool_call`); the
 * guardian speaks `SessionEvent` (hyphenated: `before-model`, `tool-result`).
 * The two are deliberately not unified — one models memory participants, the
 * other models agent sessions — so something has to translate, and this is it.
 *
 * The participant does exactly three things:
 *
 *   1. **Translates and forwards.** Each lifecycle hook builds the equivalent
 *      guardian event and emits it on the guardian bus, which is what lets the
 *      decision engine see the session at all.
 *   2. **Collects.** `prepareContext` and `beforeToolCall` consume whatever the
 *      guardian staged in response to earlier events, turning a
 *      `GuardianPendingInjection` into the lifecycle layer's
 *      `MemoryContextPacket` / `MemoryToolAdvisory`.
 *   3. **Checkpoints.** `checkpoint` renders the session's working state into a
 *      continuation capsule.
 *
 * Two events are *not* forwarded by default, and the omission is deliberate.
 * `before-model` requires the turn's `AgentMessage[]` and `tool-result`
 * requires a provider-shaped `ToolResultMessage`; the lifecycle vocabulary
 * carries neither. Rather than fabricate them — an empty message array is a
 * lie the decision engine would score on — both are supplied by optional
 * adapters that the caller, which does hold the real values, can pass in.
 *
 * Everything the private prototype did with retrieval brokers, context
 * composers and progressive-context controllers is absent on purpose: the
 * guardian already owns retrieval behind `GuardianRetrievalPort`, and reaching
 * around it would give the memory layer two independent retrieval paths that
 * could disagree.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type {
	CompactionEvent as GuardianCompactionEvent,
	SessionEventBus as GuardianEventBus,
	SessionStartEvent as GuardianStartEvent,
	SessionStopEvent as GuardianStopEvent,
} from "../guardian/event-bus";
import { classifyIntent, extractEntitiesFromPrompt } from "../guardian/event-bus";
import type { GuardianPendingInjection, GuardianRetrievalPort, GuardianScope } from "../guardian/integration";
import { formatGuardianInjection } from "../guardian/integration";
import type {
	AfterToolCallEvent,
	BeforeCompactionEvent,
	BeforeModelEvent,
	BeforeToolCallEvent,
	ContinuationCapsule,
	MemoryContextPacket,
	MemorySessionScope,
	MemoryToolAdvisory,
	SessionMemoryParticipant,
	SessionResumeEvent,
	SessionStartEvent,
	SessionStopEvent,
	UserPromptEvent,
} from "./types";

/**
 * The slice of the guardian integration this participant consumes.
 *
 * Stated structurally rather than as the concrete class so a caller can supply
 * a different collector — and so a test does not have to stand up a decision
 * engine to assert on translation.
 */
export interface GuardianInjectionSource {
	/** Resolves once decisions queued so far have settled. */
	whenIdle(): Promise<void>;
	/** Take the staged context and clear it. */
	takeInjection(): GuardianPendingInjection | null;
	/** Inspect the staged context without consuming it. */
	peekInjection(): GuardianPendingInjection | null;
}

/** Supplies the turn payload the lifecycle vocabulary does not carry. */
export type TurnDescriber = (event: BeforeModelEvent) => { messages: AgentMessage[]; turnNumber: number } | null;

/** Supplies the provider-shaped tool result the lifecycle vocabulary does not carry. */
export type ToolResultDescriber = (event: AfterToolCallEvent) => ToolResultMessage | null;

export interface GuardianSessionParticipantOptions {
	/** The guardian's own bus. Translated events are emitted here. */
	bus: GuardianEventBus;
	/** Where staged context is collected from. */
	injections: GuardianInjectionSource;
	/** Read for continuation capsules. Without it, `checkpoint` yields nothing. */
	port?: Pick<GuardianRetrievalPort, "getWorkingState">;
	/** Session this one resumed from. Defaults to the session's own id. */
	parentSessionId?: string;
	/** Supplies `before-model`. Without it, that event is not emitted. */
	describeTurn?: TurnDescriber;
	/** Supplies `tool-result`. Without it, that event is not emitted. */
	describeToolResult?: ToolResultDescriber;
	/** Injectable clock, for deterministic tests. */
	now?: () => number;
	/** Injectable id source, for deterministic tests. */
	newId?: () => string;
}

const STOP_REASONS: ReadonlySet<string> = new Set(["user-quit", "error", "completed", "timeout"]);

/**
 * Compaction reasons the lifecycle layer uses, mapped onto the three the
 * guardian distinguishes. Anything unrecognised is treated as manual, which is
 * the reading that assumes the least.
 */
const COMPACTION_TRIGGERS: ReadonlyMap<string, GuardianCompactionEvent["trigger"]> = new Map([
	["token-limit", "token-limit"],
	["token-pressure", "token-limit"],
	["manual", "manual"],
	["checkpoint", "checkpoint"],
]);

function toGuardianScope(scope: MemorySessionScope): GuardianScope {
	const guardianScope: GuardianScope = { projectId: scope.projectId, sessionId: scope.sessionId };
	if (scope.worktreeId !== undefined) guardianScope.worktreeId = scope.worktreeId;
	if (scope.branchId !== undefined) guardianScope.branchId = scope.branchId;
	return guardianScope;
}

/** Render the guardian's working state as continuation text. */
export function formatContinuationCapsule(objective: string | undefined, constraints: string[] | undefined): string {
	const sections: string[] = [];
	if (objective) sections.push(`Objective: ${objective}`);
	if (constraints?.length) sections.push(`Constraints:\n${constraints.map(line => `- ${line}`).join("\n")}`);
	return sections.join("\n\n");
}

export class GuardianSessionParticipant implements SessionMemoryParticipant {
	readonly participantName = "guardian";
	readonly #bus: GuardianEventBus;
	readonly #injections: GuardianInjectionSource;
	readonly #port: Pick<GuardianRetrievalPort, "getWorkingState"> | undefined;
	readonly #parentSessionId: string | undefined;
	readonly #describeTurn: TurnDescriber | undefined;
	readonly #describeToolResult: ToolResultDescriber | undefined;
	readonly #now: () => number;
	readonly #newId: () => string;
	#turnNumber = 0;

	constructor(options: GuardianSessionParticipantOptions) {
		this.#bus = options.bus;
		this.#injections = options.injections;
		this.#port = options.port;
		this.#parentSessionId = options.parentSessionId;
		this.#describeTurn = options.describeTurn;
		this.#describeToolResult = options.describeToolResult;
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? randomUUID;
	}

	#timestamp(): string {
		return new Date(this.#now()).toISOString();
	}

	/**
	 * Let the guardian's queue drain before reading what it staged.
	 *
	 * The guardian bus is fire-and-forget by design, so an event emitted a
	 * moment ago has not necessarily reached the decision queue yet — awaiting
	 * `whenIdle` alone would observe an empty queue and conclude, wrongly, that
	 * there was nothing to collect. Yielding a macrotask first gives the bus's
	 * listeners a chance to enqueue. The whole thing runs under the bridge's
	 * deadline, so a guardian that never settles costs the turn nothing.
	 */
	async #settle(): Promise<void> {
		await Bun.sleep(0);
		await this.#injections.whenIdle();
	}

	async onSessionStart(event: SessionStartEvent): Promise<void> {
		const scope = toGuardianScope(event.scope);
		const started: GuardianStartEvent = {
			type: "session-start",
			sessionId: scope.sessionId,
			projectId: scope.projectId,
			timestamp: this.#timestamp(),
		};
		if (scope.worktreeId !== undefined) started.worktreeId = scope.worktreeId;
		if (scope.branchId !== undefined) started.branchId = scope.branchId;
		this.#bus.emit(started);
	}

	async onUserPrompt(event: UserPromptEvent): Promise<void> {
		this.#bus.emit({
			type: "user-prompt",
			sessionId: event.scope.sessionId,
			prompt: event.text,
			promptId: event.metadata.correlationId,
			timestamp: this.#timestamp(),
			entities: extractEntitiesFromPrompt(event.text),
			intent: classifyIntent(event.text),
		});
	}

	/**
	 * Collect whatever the guardian staged for this turn.
	 *
	 * Single-shot by contract: `takeInjection` clears the staged context, so
	 * the same records cannot leak into every subsequent turn.
	 */
	async prepareContext(event: BeforeModelEvent): Promise<MemoryContextPacket | null> {
		const started = this.#now();

		const turn = this.#describeTurn?.(event);
		if (turn) {
			this.#turnNumber = turn.turnNumber;
			this.#bus.emit({
				type: "before-model",
				sessionId: event.scope.sessionId,
				messages: turn.messages,
				turnNumber: turn.turnNumber,
				timestamp: this.#timestamp(),
			});
		}

		await this.#settle();

		const pending = this.#injections.takeInjection();
		if (!pending) return null;

		return {
			id: this.#newId(),
			text: formatGuardianInjection(pending),
			memoryIds: [...pending.context.recordIds],
			tokenEstimate: pending.context.tokenCount,
			createdAt: this.#now(),
			latencyMs: this.#now() - started,
		};
	}

	/**
	 * Forward the call, then surface a warning the guardian raised about it.
	 *
	 * Only a warning staged *by this tool call* is consumed here. Context
	 * staged for the model is left alone: taking it would deliver records
	 * assembled for the turn as a note about a single tool, and the turn would
	 * then get nothing.
	 */
	async beforeToolCall(event: BeforeToolCallEvent): Promise<MemoryToolAdvisory | null> {
		this.#bus.emit({
			type: "tool-call",
			sessionId: event.scope.sessionId,
			toolName: event.toolName,
			args: event.input,
			toolCallId: event.metadata.toolCallId ?? event.metadata.correlationId,
			timestamp: this.#timestamp(),
		});

		await this.#settle();

		const staged = this.#injections.peekInjection();
		if (!staged?.warning || staged.trigger !== "tool-call") return null;

		const pending = this.#injections.takeInjection();
		if (!pending) return null;

		return {
			text: formatGuardianInjection(pending),
			memoryIds: [...pending.context.recordIds],
			severity: "warning",
		};
	}

	async afterToolCall(event: AfterToolCallEvent): Promise<void> {
		const result = this.#describeToolResult?.(event);
		if (!result) return;

		this.#bus.emit({
			type: "tool-result",
			sessionId: event.scope.sessionId,
			toolName: event.toolName,
			args: event.input,
			result,
			toolCallId: event.metadata.toolCallId ?? event.metadata.correlationId,
			timestamp: this.#timestamp(),
			isError: !event.success,
		});
	}

	async checkpoint(event: BeforeCompactionEvent): Promise<ContinuationCapsule | null> {
		this.#bus.emit({
			type: "compaction",
			sessionId: event.scope.sessionId,
			trigger: COMPACTION_TRIGGERS.get(event.reason) ?? "manual",
			tokensBefore: 0,
			summary: "",
			timestamp: this.#timestamp(),
		});

		if (!this.#port) return null;

		const workingState = await this.#port.getWorkingState(event.scope.sessionId);
		if (!workingState) return null;

		const text = formatContinuationCapsule(workingState.objective, workingState.constraints);
		if (!text) return null;

		return { id: this.#newId(), text, createdAt: this.#now() };
	}

	async onResume(event: SessionResumeEvent): Promise<void> {
		this.#bus.emit({
			type: "resume",
			sessionId: event.scope.sessionId,
			parentSessionId: this.#parentSessionId ?? event.scope.sessionId,
			timestamp: this.#timestamp(),
		});
	}

	async stop(event: SessionStopEvent): Promise<void> {
		const reason = STOP_REASONS.has(event.reason) ? (event.reason as GuardianStopEvent["reason"]) : "completed";
		this.#bus.emit({
			type: "session-stop",
			sessionId: event.scope.sessionId,
			reason,
			timestamp: this.#timestamp(),
		});
	}

	/** Turn number last reported by {@link TurnDescriber}. Zero until one is. */
	get turnNumber(): number {
		return this.#turnNumber;
	}
}

export function createGuardianSessionParticipant(
	options: GuardianSessionParticipantOptions,
): GuardianSessionParticipant {
	return new GuardianSessionParticipant(options);
}
