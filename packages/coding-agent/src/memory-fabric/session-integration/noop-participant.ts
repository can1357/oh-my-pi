/**
 * The participant that does nothing.
 *
 * This is the off switch, and it is a real object rather than a null check: it
 * implements every hook and returns the neutral value for each, so call sites
 * never need to test whether memory is enabled. Disabling the fabric — by
 * configuration, or because initialisation failed and the caller chose to fail
 * open — swaps this in and the session keeps running unchanged.
 *
 * It doubles as the reference for what a hook is allowed to return: `null` from
 * `prepareContext`, `beforeToolCall` and `checkpoint` means "nothing to add",
 * which is always a valid answer.
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

export class NoopSessionMemoryParticipant implements SessionMemoryParticipant {
	readonly participantName = "noop" as const;

	async onSessionStart(_event: SessionStartEvent): Promise<void> {}

	async onUserPrompt(_event: UserPromptEvent): Promise<void> {}

	async prepareContext(_event: BeforeModelEvent): Promise<MemoryContextPacket | null> {
		return null;
	}

	async beforeToolCall(_event: BeforeToolCallEvent): Promise<MemoryToolAdvisory | null> {
		return null;
	}

	async afterToolCall(_event: AfterToolCallEvent): Promise<void> {}

	async checkpoint(_event: BeforeCompactionEvent): Promise<ContinuationCapsule | null> {
		return null;
	}

	async onResume(_event: SessionResumeEvent): Promise<void> {}

	async stop(_event: SessionStopEvent): Promise<void> {}
}
