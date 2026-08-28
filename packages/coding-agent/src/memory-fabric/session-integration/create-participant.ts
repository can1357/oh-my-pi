/**
 * Memory Fabric — how a session decides which participant it gets.
 *
 * A session should never have to ask whether memory is enabled. It asks for a
 * participant, gets one, and calls hooks on it; whether that participant does
 * anything is decided here, once, at construction.
 *
 * The ladder is deliberately ordered so the most explicit intent wins:
 *
 *   1. A participant supplied outright — a test double, or a caller that has
 *      already composed something.
 *   2. Memory switched off — the no-op, not `null`, so call sites keep their
 *      shape.
 *   3. No guardian configuration — also the no-op. Absent configuration is a
 *      decision, not an error.
 *   4. A guardian participant, when there is something to build it from.
 *
 * If step 4 throws, `failOpen` decides whether the session degrades to the
 * no-op or refuses to start. It defaults to degrading: a memory layer that can
 * take the agent down with it is worse than no memory layer, and the failure is
 * still reported through {@link CreateParticipantOptions.onError} rather than
 * swallowed.
 *
 * Deliberately synchronous. Nothing in the ladder does I/O, and returning a
 * promise would invite call sites to believe otherwise.
 */

import { createGuardianSessionParticipant, type GuardianSessionParticipantOptions } from "./guardian-participant";
import { NoopSessionMemoryParticipant } from "./noop-participant";
import type { SessionMemoryParticipant } from "./types";

export interface CreateParticipantOptions {
	/**
	 * What to build the guardian participant from. Omit to disable the
	 * guardian without disabling the fabric's other call sites.
	 */
	guardian?: GuardianSessionParticipantOptions;
	/** Used as-is, ahead of every other rung. Intended for tests. */
	testParticipant?: SessionMemoryParticipant;
	/** Force the no-op regardless of the rest. */
	disabled?: boolean;
	/** Degrade to the no-op when construction throws. Defaults to `true`. */
	failOpen?: boolean;
	/** Where a degraded construction is reported. Defaults to `console.warn`. */
	onError?: (error: unknown) => void;
}

function reportDefault(error: unknown): void {
	console.warn("[memory-fabric] guardian participant unavailable, continuing without memory:", error);
}

/**
 * Resolve the participant a session should use.
 *
 * Never returns `null` and, unless `failOpen` is explicitly `false`, never
 * throws.
 */
export function createSessionMemoryParticipant(options: CreateParticipantOptions = {}): SessionMemoryParticipant {
	if (options.testParticipant) return options.testParticipant;
	if (options.disabled) return new NoopSessionMemoryParticipant();
	if (!options.guardian) return new NoopSessionMemoryParticipant();

	try {
		return createGuardianSessionParticipant(options.guardian);
	} catch (error) {
		if (options.failOpen === false) throw error;
		(options.onError ?? reportDefault)(error);
		return new NoopSessionMemoryParticipant();
	}
}
