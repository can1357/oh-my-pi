/**
 * Job state machine — enforces valid transitions and records them durably.
 *
 * All transitions are recorded with timestamp, actor, and reason. Invalid
 * transitions are rejected synchronously before any side-effect runs.
 */

import type { JobState, JobTransitionEvent, RemoteJobV1, ResourceKind, ResourceRecord } from "./types";
import { isTerminal, isValidTransition } from "./types";

export type TransitionActor = JobTransitionEvent["actor"];

export interface TransitionResult {
	readonly ok: true;
	readonly event: JobTransitionEvent;
}

export interface TransitionError {
	readonly ok: false;
	readonly code: "invalid_transition" | "already_terminal" | "idempotent";
	readonly message: string;
}

/**
 * Attempt a state transition on the given job record.
 *
 * - Idempotent: transitioning to the current state is a no-op (returns ok=true).
 * - Rejects transitions from terminal states (except cleaning after failure/cancel/timeout).
 * - Rejects transitions not listed in VALID_TRANSITIONS.
 * - Mutates the job record in-place (for in-memory use; the store persists separately).
 */
export function transition(
	job: RemoteJobV1,
	to: JobState,
	actor: TransitionActor,
	reason: string,
): TransitionResult | TransitionError {
	if (job.state === to) {
		return { ok: true, event: job.transitions[job.transitions.length - 1] ?? makeEvent(to, to, actor, reason) };
	}

	if (!isValidTransition(job.state, to)) {
		if (isTerminal(job.state)) {
			return {
				ok: false,
				code: "already_terminal",
				message: `Job ${job.id} is in terminal state "${job.state}" — cannot transition to "${to}"`,
			};
		}
		return {
			ok: false,
			code: "invalid_transition",
			message: `Transition "${job.state}" → "${to}" is not valid for job ${job.id}`,
		};
	}

	const event = makeEvent(job.state, to, actor, reason);
	(job.transitions as JobTransitionEvent[]).push(event);
	(job as { state: JobState }).state = to;
	(job as { updatedAt: string }).updatedAt = event.timestamp;
	return { ok: true, event };
}

function makeEvent(from: JobState, to: JobState, actor: TransitionActor, reason: string): JobTransitionEvent {
	return Object.freeze({
		from,
		to,
		timestamp: new Date().toISOString(),
		actor,
		reason: reason.trim() || "(no reason)",
	});
}

/** Register a resource against the job's resource inventory. */
export function registerResource(job: RemoteJobV1, kind: ResourceKind, id: string, label: string): ResourceRecord {
	const record: ResourceRecord = {
		kind,
		id: id.trim(),
		label: label.trim(),
		createdAt: new Date().toISOString(),
	};
	(job.resources as ResourceRecord[]).push(record);
	return record;
}

/** Mark a resource as cleaned in the inventory. */
export function markResourceCleaned(job: RemoteJobV1, resourceId: string): boolean {
	const record = (job.resources as ResourceRecord[]).find(r => r.id === resourceId);
	if (!record) return false;
	(record as { cleanedAt?: string }).cleanedAt = new Date().toISOString();
	return true;
}

/** Returns true if all registered resources have a cleanedAt timestamp. */
export function allResourcesCleaned(job: RemoteJobV1): boolean {
	return job.resources.every(r => r.cleanedAt !== undefined);
}

/** Returns resources that have not yet been cleaned. */
export function pendingCleanupResources(job: RemoteJobV1): readonly ResourceRecord[] {
	return job.resources.filter(r => r.cleanedAt === undefined);
}
