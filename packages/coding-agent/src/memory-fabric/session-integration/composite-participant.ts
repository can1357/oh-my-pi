/**
 * Composite session participant.
 *
 * Fans a single lifecycle out to several `SessionMemoryParticipant`s so that,
 * e.g., a Guardian participant and a Git Intelligence participant can run side
 * by side. Participants are invoked in registration order.
 *
 * Merge policy for single-valued hooks:
 *   - prepareContext / checkpoint: first non-null result wins (priority = order).
 *   - beforeToolCall: all advisories are collected and merged (texts joined,
 *     memoryIds unioned, severity escalated to the highest).
 *
 * Every delegate call is isolated fail-open: one participant throwing never
 * prevents the others from running, and never breaks the tool call. Even the
 * error reporter is wrapped, because diagnostics must never be the thing that
 * takes a turn down.
 */

import type {
	AfterToolCallEvent,
	BeforeCompactionEvent,
	BeforeModelEvent,
	BeforeToolCallEvent,
	ContinuationCapsule,
	MemoryContextPacket,
	MemoryToolAdvisory,
	SessionMemoryParticipant,
	SessionResumeEvent,
	SessionStartEvent,
	SessionStopEvent,
	UserPromptEvent,
} from "./types";

type Advisory = MemoryToolAdvisory;
type Severity = Advisory["severity"];

/** Minimal structural view of the participant methods the composite calls. */
interface ParticipantLike extends SessionMemoryParticipant {
	participantName?: string;
	onSessionStart?(event: SessionStartEvent): Promise<void> | void;
	onUserPrompt?(event: UserPromptEvent): Promise<void> | void;
	prepareContext?(event: BeforeModelEvent): Promise<MemoryContextPacket | null> | MemoryContextPacket | null;
	beforeToolCall?(event: BeforeToolCallEvent): Promise<Advisory | null> | Advisory | null;
	afterToolCall?(event: AfterToolCallEvent): Promise<void> | void;
	checkpoint?(event: BeforeCompactionEvent): Promise<ContinuationCapsule | null> | ContinuationCapsule | null;
	onResume?(event: SessionResumeEvent): Promise<void> | void;
	stop?(event: SessionStopEvent): Promise<void> | void;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

function mergeAdvisories(advisories: Advisory[]): Advisory | null {
	const present = advisories.filter((a): a is Advisory => a != null && a.text.length > 0);
	if (present.length === 0) return null;
	if (present.length === 1) return present[0];
	const memoryIds = Array.from(new Set(present.flatMap(a => a.memoryIds)));
	const severity = present.reduce<Severity>(
		(hi, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[hi] ? a.severity : hi),
		"info",
	);
	return { text: present.map(a => a.text).join("\n\n"), memoryIds, severity };
}

export interface CompositeParticipantOptions {
	participantName?: string;
	onError?: (participantName: string, where: string, error: unknown) => void;
}

export class CompositeSessionParticipant implements SessionMemoryParticipant {
	readonly participantName: string;
	readonly #participants: ParticipantLike[];
	readonly #onError?: (participantName: string, where: string, error: unknown) => void;

	constructor(participants: SessionMemoryParticipant[], options: CompositeParticipantOptions = {}) {
		this.#participants = participants.filter(Boolean) as ParticipantLike[];
		this.participantName = options.participantName ?? "composite";
		this.#onError = options.onError;
	}

	#nameOf(participant: ParticipantLike): string {
		return participant.participantName ?? "unknown";
	}

	#report(participant: ParticipantLike, where: string, error: unknown): void {
		try {
			this.#onError?.(this.#nameOf(participant), where, error);
		} catch {
			/* diagnostics must never throw */
		}
	}

	/** Run a void hook across all participants, isolating failures. */
	async #fanOut<E>(
		where: string,
		event: E,
		pick: (participant: ParticipantLike) => ((event: E) => Promise<void> | void) | undefined,
	): Promise<void> {
		await Promise.all(
			this.#participants.map(async participant => {
				const fn = pick(participant);
				if (!fn) return;
				try {
					await fn.call(participant, event);
				} catch (error) {
					this.#report(participant, where, error);
				}
			}),
		);
	}

	async onSessionStart(event: SessionStartEvent): Promise<void> {
		await this.#fanOut("onSessionStart", event, p => p.onSessionStart?.bind(p));
	}

	async onUserPrompt(event: UserPromptEvent): Promise<void> {
		await this.#fanOut("onUserPrompt", event, p => p.onUserPrompt?.bind(p));
	}

	async onResume(event: SessionResumeEvent): Promise<void> {
		await this.#fanOut("onResume", event, p => p.onResume?.bind(p));
	}

	async afterToolCall(event: AfterToolCallEvent): Promise<void> {
		await this.#fanOut("afterToolCall", event, p => p.afterToolCall?.bind(p));
	}

	async stop(event: SessionStopEvent): Promise<void> {
		await this.#fanOut("stop", event, p => p.stop?.bind(p));
	}

	async prepareContext(event: BeforeModelEvent): Promise<MemoryContextPacket | null> {
		for (const participant of this.#participants) {
			if (!participant.prepareContext) continue;
			try {
				const packet = await participant.prepareContext(event);
				if (packet) return packet;
			} catch (error) {
				this.#report(participant, "prepareContext", error);
			}
		}
		return null;
	}

	async checkpoint(event: BeforeCompactionEvent): Promise<ContinuationCapsule | null> {
		for (const participant of this.#participants) {
			if (!participant.checkpoint) continue;
			try {
				const capsule = await participant.checkpoint(event);
				if (capsule) return capsule;
			} catch (error) {
				this.#report(participant, "checkpoint", error);
			}
		}
		return null;
	}

	async beforeToolCall(event: BeforeToolCallEvent): Promise<Advisory | null> {
		const advisories: Advisory[] = [];
		for (const participant of this.#participants) {
			if (!participant.beforeToolCall) continue;
			try {
				const advisory = await participant.beforeToolCall(event);
				if (advisory) advisories.push(advisory);
			} catch (error) {
				this.#report(participant, "beforeToolCall", error);
			}
		}
		return mergeAdvisories(advisories);
	}
}
