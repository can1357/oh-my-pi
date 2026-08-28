import { randomUUID } from "node:crypto";
import type { ConversationStateStructure } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Bounded per-conversation proto state + blob cache with an active/retained
 * split, and rotation with a bounded depth (#8345).
 *
 * On-disk persistence is deliberately out: the plan's contingency keeps the
 * store in memory (active/retained split + rotation cap) rather than inventing
 * a new on-disk format, because `packages/ai` is a library with no session
 * state directory of its own to reuse. This replaces five unbounded,
 * process-lifetime module-level `Map`s/`Set`s in `cursor.ts`.
 */

export interface CursorConversationEntry {
	state: ConversationStateStructure | undefined;
	blobs: Map<string, Uint8Array>;
}

/** Retained (unpinned) entries before LRU eviction begins. */
export const CURSOR_RETAINED_CONVERSATION_LIMIT = 64;
/** A single base conversation id may rotate its wire id at most this many times. */
export const MAX_CURSOR_CONVERSATION_ROTATIONS = 3;

/** Every entry, active and retained alike. */
const entries = new Map<string, CursorConversationEntry>();
/** Pin counts for entries held by an in-flight request — never evicted while > 0. */
const activePinCounts = new Map<string, number>();
/** Retained (unpinned) ids in insertion order, oldest first. */
const retainedLru = new Set<string>();

/**
 * Base conversation id → rotated wire id (#8345). Cursor's backend can pin a
 * per-conversation rejection (bare `resource_exhausted`, zero tokens) to one
 * conversationId forever. On such a failure the id is rotated and the next
 * attempt rebuilds a fresh conversation from `context` (no cached-state
 * migration). A failed rotation is not repeated, so real account exhaustion
 * is not hidden. After the rotated id completes a turn, a later poison of
 * that id is allowed to rotate again.
 */
const rotatedConversationIds = new Map<string, string>();
/** Rotated ids that have completed a full turn (`successfulRotatedConversationIds`). */
const successfulRotatedConversationIds = new Set<string>();
/** Rotated ids that have not yet completed a turn, so cached state is skipped (`freshRotatedConversationIds`). */
const freshRotatedConversationIds = new Set<string>();
/** Number of rotations issued per base id — the rotation-depth cap. */
const rotationCounts = new Map<string, number>();

/**
 * Returns (creating if needed) the entry and pins it active — a pinned entry
 * is never evicted. A pin of an already-pinned id increments a re-entrancy
 * count; the entry object is the handle, so state/blobs are mutated through
 * the returned reference with no separate read call.
 */
export function pinCursorConversation(id: string): CursorConversationEntry {
	let entry = entries.get(id);
	if (!entry) {
		entry = { state: undefined, blobs: new Map() };
		entries.set(id, entry);
	} else {
		// A currently-retained entry becomes active again — it must not be in
		// the eviction set while a live request holds it.
		retainedLru.delete(id);
	}
	activePinCounts.set(id, (activePinCounts.get(id) ?? 0) + 1);
	return entry;
}

/**
 * Purges rotation bookkeeping owned by a base id evicted from the retained
 * LRU: its base→rotated mapping and rotation count, its current rotated id
 * from the success/fresh sets, and the base id itself from those sets. Only
 * called for a base genuinely evicted from `retainedLru`. Entries whose
 * resolved (rotated) id is still active, fresh, or is the id currently being
 * unpinned are skipped by the overflow loop so an in-flight, not-yet-retried,
 * or just-completed rotated request cannot lose its mapping.
 */
function evictCursorRotationState(baseId: string): void {
	const rotated = rotatedConversationIds.get(baseId);
	if (rotated !== undefined) {
		successfulRotatedConversationIds.delete(rotated);
		freshRotatedConversationIds.delete(rotated);
	}
	rotatedConversationIds.delete(baseId);
	rotationCounts.delete(baseId);
	successfulRotatedConversationIds.delete(baseId);
	freshRotatedConversationIds.delete(baseId);
}

/**
 * Releases one pin. On the final unpin the entry moves to the retained LRU,
 * which evicts oldest-first beyond `CURSOR_RETAINED_CONVERSATION_LIMIT`.
 * Candidates of the turn that just finished — the unpinned id and any base
 * resolving to it — are never victims of that unpin's overflow eviction.
 * Unknown ids are a no-op (reset-first discipline: this is an exit-path gate
 * and must run on every path without itself failing).
 */
export function unpinCursorConversation(id: string): void {
	const count = activePinCounts.get(id);
	if (count === undefined || count <= 0) {
		activePinCounts.delete(id);
		return;
	}
	if (count > 1) {
		activePinCounts.set(id, count - 1);
		return;
	}
	activePinCounts.delete(id);
	const entry = entries.get(id);
	if (!entry) return;
	// Most-recently-unpinned goes to the tail; the LRU is oldest-first.
	retainedLru.delete(id);
	retainedLru.add(id);
	while (retainedLru.size > CURSOR_RETAINED_CONVERSATION_LIMIT) {
		let victim: string | undefined;
		let freshVictim: string | undefined;
		for (const candidate of retainedLru) {
			// Raw mapping read, not resolveCursorConversationId: the overflow scan
			// must stay side-effect-free — resolving here would re-admit its own
			// candidate at the LRU tail mid-iteration.
			const resolved = rotatedConversationIds.get(candidate) ?? candidate;
			// Candidates of the turn that just finished are never victims of
			// their own unpin: the id itself (the LRU tail) and any base whose
			// resolved wire id is that id — the owner of the base→rotated
			// mapping this turn resolved through. A completed turn has usually
			// cleared the mapping's freshness by unpin time, so the fresh check
			// below no longer sees it; the resolved-id comparison is what keeps
			// the mapping reachable.
			if (candidate === id || resolved === id) continue;
			if ((activePinCounts.get(resolved) ?? 0) > 0) continue;
			if (freshRotatedConversationIds.has(resolved)) {
				freshVictim ??= candidate;
				continue;
			}
			victim = candidate;
			break;
		}
		// No plain victim: fall back to the oldest fresh mapping, or leave the
		// overflow in place when every candidate is protected until an older
		// evictable entry exists.
		victim ??= freshVictim;
		if (victim === undefined) break;
		retainedLru.delete(victim);
		entries.delete(victim);
		evictCursorRotationState(victim);
	}
}

/**
 * Returns the current rotated wire id for a base conversation, or the base
 * itself when no rotation has been issued. Public counterpart to the
 * consumer's `rotatedConversationIds.get(base) ?? base` (`cursor.ts`), so an
 * external consumer (Task 10) can resolve the id it should actually use and
 * then query its fresh/marked state via `isCursorRotationFresh` /
 * `isCursorRotationMarked`.
 *
 * A successful base→rotated resolution is a use of the conversation: it
 * refreshes the base mapping's retained-LRU ownership. Later turns pin and
 * unpin only the rotated id, so without this refresh the base's slot ages at
 * its pre-rotation position and eviction purges a still-current mapping
 * while its rotated entry was just used. The refresh only applies while the
 * base actually holds a retained slot — a pinned base must stay out of the
 * eviction set until its final unpin re-admits it.
 */
export function resolveCursorConversationId(baseId: string): string {
	const rotated = rotatedConversationIds.get(baseId);
	if (rotated === undefined) return baseId;
	if (retainedLru.has(baseId)) {
		// Most-recently-used goes to the tail; the LRU is oldest-first.
		retainedLru.delete(baseId);
		retainedLru.add(baseId);
	}
	return rotated;
}

/**
 * Rotates the wire id for a base conversation to a fresh one, recording the
 * base→rotated mapping. Each base may rotate at most
 * `MAX_CURSOR_CONVERSATION_ROTATIONS` times; beyond that returns `undefined`.
 * The id format matches today's scheme: `crypto.randomUUID()` per attempt.
 *
 * Mirrors the consumer's `canRotate` gate (`cursor.ts`): a new rotation is
 * allowed only when there is no current rotated id OR that id has completed a
 * turn (`markCursorRotationSucceeded`). Otherwise `undefined` is returned and
 * the current (unmarked) rotated id stays in place — one failure streak must
 * not consume ids and hide real account exhaustion.
 */
export function rotateCursorConversation(baseId: string): string | undefined {
	const rotations = rotationCounts.get(baseId) ?? 0;
	if (rotations >= MAX_CURSOR_CONVERSATION_ROTATIONS) return undefined;
	const currentRotated = rotatedConversationIds.get(baseId);
	// `canRotate` from cursor.ts, verbatim: currentRotated must be absent or marked.
	if (currentRotated !== undefined && !successfulRotatedConversationIds.has(currentRotated)) {
		return undefined;
	}
	const rotated = randomUUID();
	if (currentRotated) successfulRotatedConversationIds.delete(currentRotated);
	rotatedConversationIds.set(baseId, rotated);
	freshRotatedConversationIds.add(rotated);
	rotationCounts.set(baseId, rotations + 1);
	logger.debug("cursor conversation rotated", {
		base: baseId,
		from: currentRotated ?? baseId,
		to: rotated,
	});
	return rotated;
}

/**
 * Marks a rotated id as having completed a full turn — the gate that today
 * lives in `successfulRotatedConversationIds` ("After the rotated id
 * completes a turn, a later poison of that id is allowed to rotate again").
 */
export function markCursorRotationSucceeded(id: string): void {
	successfulRotatedConversationIds.add(id);
	freshRotatedConversationIds.delete(id);
}

/** Whether a rotated id has completed a full turn (`successfulRotatedConversationIds.has`). */
export function isCursorRotationMarked(id: string): boolean {
	return successfulRotatedConversationIds.has(id);
}

/** Whether a rotated id has not yet completed a turn and must skip cached state (`freshRotatedConversationIds.has`). */
export function isCursorRotationFresh(id: string): boolean {
	return freshRotatedConversationIds.has(id);
}

/** Clears all module-level state. Tests must call this in `beforeEach`. */
export function resetCursorConversationStore(): void {
	entries.clear();
	activePinCounts.clear();
	retainedLru.clear();
	rotatedConversationIds.clear();
	successfulRotatedConversationIds.clear();
	freshRotatedConversationIds.clear();
	rotationCounts.clear();
}
