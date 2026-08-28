/**
 * Persistence lane — shared shapes.
 *
 * The stores in this directory are the durable half of the memory fabric:
 * everything else on the branch keeps its state in process and loses it when
 * the process does. Three stores share these types:
 *
 * - {@link WorkingState} is the live, mutable picture of the task, owned by
 *   `working-state-store.ts` and mutated on every meaningful step.
 * - A checkpoint (`checkpoint-store.ts`) is an immutable copy of a working
 *   state taken at a moment worth returning to — compaction, session stop.
 * - The event journal (`event-journal.ts`) is the append-only record of what
 *   happened, from which both of the above can be audited.
 *
 * ## Scope is an identity, not a filter
 *
 * {@link PersistenceScope} is folded into a single deterministic key by
 * {@link scopeKey} and rows are matched on that key exactly. The alternative —
 * `WHERE branch_id = ? OR branch_id IS NULL` — reads one branch's state into
 * another whenever a field is unset, which is precisely the cross-context
 * leakage the fabric's security model forbids. A scope with an unset field is
 * its own scope, not a wildcard.
 *
 * ## Hashes are for integrity, not identity
 *
 * `content_hash` columns exist so a reader can detect a torn or tampered row,
 * which means the hash must be collision-resistant. SHA-256 via `node:crypto`
 * — a 32-bit rolling hash would collide often enough to make the check
 * meaningless.
 */

import { createHash, randomUUID } from "node:crypto";

/** Where a piece of persisted state belongs. Every field narrows, none widens. */
export interface PersistenceScope {
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	sessionId?: string;
	taskId?: string;
	agentId?: string;
}

/** The live, mutable picture of the task in flight. */
export interface WorkingState {
	objective: string;
	constraints: string[];
	activePlan: string;
	currentStep: string;
	filesTouched: string[];
	pendingOperations: string[];
	unresolvedErrors: string[];
	lastVerifiedTestState: string;
	updatedAt: string;
}

/**
 * A fresh, empty working state.
 *
 * A function rather than a constant: a shared constant would hand every
 * caller the same array instances (so one session's `filesTouched.push`
 * appears in another's state) and a timestamp frozen at module load.
 */
export function createEmptyWorkingState(): WorkingState {
	return {
		objective: "",
		constraints: [],
		activePlan: "",
		currentStep: "",
		filesTouched: [],
		pendingOperations: [],
		unresolvedErrors: [],
		lastVerifiedTestState: "",
		updatedAt: new Date().toISOString(),
	};
}

/** An immutable snapshot of a working state, plus why it was taken. */
export interface CheckpointSnapshot {
	checkpointId: string;
	sessionId: string;
	/** What triggered the checkpoint, e.g. `"compaction"` or `"session-stop"`. */
	label: string;
	state: WorkingState;
	contentHash: string;
	createdAt: string;
}

/** What a caller hands the journal. */
export interface JournalEventInput {
	/** Event kind, e.g. `"record-created"`, `"checkpoint"`, `"tombstone"`. */
	type: string;
	/** The record this event concerns, when it concerns one. */
	recordId?: string;
	payload: Record<string, unknown>;
}

/** What the journal stores and returns: the input plus its position in history. */
export interface JournalEvent extends JournalEventInput {
	seq: number;
	timestamp: string;
}

/**
 * Deterministic identity for a scope.
 *
 * Unset fields are encoded explicitly (`\u0000` cannot occur in the inputs)
 * so `{projectId: "p"}` and `{projectId: "p", branchId: ""}` do not collide
 * with `{projectId: "p", branchId: undefined}` by accident of concatenation.
 */
export function scopeKey(scope: PersistenceScope): string {
	const part = (value: string | undefined): string => (value === undefined ? "\u0000unset" : value);
	return [
		scope.projectId,
		part(scope.worktreeId),
		part(scope.branchId),
		part(scope.sessionId),
		part(scope.taskId),
		part(scope.agentId),
	].join("\u0000");
}

/** SHA-256 hex digest of a JSON-serialisable value. */
export function hashContent(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A collision-safe identifier with a readable prefix. */
export function newPersistenceId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

/** Narrow an unknown row field to a string, with an empty-string fallback. */
export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Parse a JSON column that must hold an array of strings.
 *
 * A corrupt column yields an empty array rather than a throw: a store that
 * refuses to open because one row rotted is a store nobody re-enables.
 */
export function asStringArray(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}
