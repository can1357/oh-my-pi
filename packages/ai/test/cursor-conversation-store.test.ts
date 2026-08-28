import { beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_RETAINED_CONVERSATION_LIMIT,
	type CursorConversationEntry,
	isCursorRotationFresh,
	isCursorRotationMarked,
	MAX_CURSOR_CONVERSATION_ROTATIONS,
	markCursorRotationSucceeded,
	pinCursorConversation,
	resetCursorConversationStore,
	resolveCursorConversationId,
	rotateCursorConversation,
	unpinCursorConversation,
} from "../src/providers/cursor/conversation-store";

beforeEach(() => {
	resetCursorConversationStore();
});

describe("cursor conversation store — active/retained split", () => {
	it("a pinned entry survives 64 subsequent admissions and stays resolvable after retained overflow", () => {
		const pinned = pinCursorConversation("pinned-id");
		pinned.blobs.set("b1", new Uint8Array([1]));

		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `admit-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		// 64 admissions exactly fill retained: the pinned id is untouched.
		expect(pinCursorConversation("pinned-id")).toBe(pinned);
		unpinCursorConversation("pinned-id");

		// Overflow the retained set: the still-active pinned id is never evicted.
		for (let i = 0; i < 80; i++) {
			const id = `extra-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		const after = pinCursorConversation("pinned-id");
		expect(after).toBe(pinned);
		expect(after.blobs).toBe(pinned.blobs);
		expect(after.blobs.get("b1")).toEqual(new Uint8Array([1]));
		unpinCursorConversation("pinned-id");
	});

	it("retained entries evict LRU at 65 — the earliest unpinned admission is dropped", () => {
		const originals = new Map<string, CursorConversationEntry>();
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `r-${i}`;
			originals.set(id, pinCursorConversation(id));
			unpinCursorConversation(id);
		}
		// At exactly the limit nothing was evicted — the tail entry still resolves in place.
		const tailKey = `r-${CURSOR_RETAINED_CONVERSATION_LIMIT - 1}`;
		const tailOriginal = originals.get(tailKey)!;
		expect(pinCursorConversation(tailKey)).toBe(tailOriginal);
		unpinCursorConversation(tailKey);

		// The 65th retained admission evicts the earliest (r-0). Assert the
		// survivor before re-pinning r-0: a fresh re-pin would re-admit r-0 to
		// retained and push the size back past the limit, evicting r-1.
		pinCursorConversation("r-65");
		unpinCursorConversation("r-65");

		// A non-earliest survivor still resolves by its original identity.
		expect(pinCursorConversation("r-1")).toBe(originals.get("r-1")!);
		unpinCursorConversation("r-1");

		// Re-pinning the evicted r-0 yields a fresh entry with no residue.
		const r0 = pinCursorConversation("r-0");
		expect(r0).not.toBe(originals.get("r-0"));
		expect(r0.state).toBeUndefined();
		expect(r0.blobs.size).toBe(0);
	});

	it("re-pin after eviction recreates a fresh entry (no false residue)", () => {
		const first = pinCursorConversation("evicted-id");
		first.blobs.set("k", new Uint8Array([42]));
		first.state = undefined;
		unpinCursorConversation("evicted-id");
		// Overflow it out of retained.
		for (let i = 0; i <= CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `filler-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		const rePinned = pinCursorConversation("evicted-id");
		expect(rePinned).not.toBe(first);
		expect(rePinned.blobs).not.toBe(first.blobs);
		expect(rePinned.blobs.size).toBe(0);
		expect(rePinned.state).toBeUndefined();
		unpinCursorConversation("evicted-id");
	});

	it("unpinning an unknown id is a no-op", () => {
		const entry = pinCursorConversation("known");
		entry.blobs.set("x", new Uint8Array([9]));
		unpinCursorConversation("never-pinned");
		expect(pinCursorConversation("known")).toBe(entry);
		expect(entry.blobs.get("x")).toEqual(new Uint8Array([9]));
		unpinCursorConversation("known");
		unpinCursorConversation("known");
		const retained = pinCursorConversation("known");
		expect(retained).toBe(entry);
		expect(retained.blobs.get("x")).toEqual(new Uint8Array([9]));
		unpinCursorConversation("known");
	});

	it("re-entrant pins keep the entry active until the final unpin", () => {
		const first = pinCursorConversation("re");
		expect(pinCursorConversation("re")).toBe(first);
		unpinCursorConversation("re");
		// Still pinned once → entry identity unchanged, not yet in the retained eviction set.
		expect(pinCursorConversation("re")).toBe(first);
		unpinCursorConversation("re");
	});
});

describe("cursor conversation store — rotation", () => {
	function requireRotation(result: string | undefined): string {
		if (result === undefined) throw new Error("expected a rotation id");
		return result;
	}

	it("returns three distinct ids then undefined on the fourth", () => {
		const ids: Array<string> = [];
		for (let i = 0; i < MAX_CURSOR_CONVERSATION_ROTATIONS; i++) {
			const rotated = requireRotation(rotateCursorConversation("base"));
			expect(ids).not.toContain(rotated);
			ids.push(rotated);
			// Each rotation must complete a turn before the next may be issued.
			markCursorRotationSucceeded(rotated);
		}
		expect(new Set(ids).size).toBe(MAX_CURSOR_CONVERSATION_ROTATIONS);
		expect(rotateCursorConversation("base")).toBeUndefined();
	});

	it("a rotation is fresh until a turn marks it succeeded", () => {
		const rotated = requireRotation(rotateCursorConversation("base"));
		expect(isCursorRotationFresh(rotated)).toBe(true);
		expect(isCursorRotationMarked(rotated)).toBe(false);
		// While unmarked, a re-rotation is refused and the resolved id holds.
		expect(rotateCursorConversation("base")).toBeUndefined();
		expect(resolveCursorConversationId("base")).toBe(rotated);

		markCursorRotationSucceeded(rotated);
		expect(isCursorRotationMarked(rotated)).toBe(true);
		expect(isCursorRotationFresh(rotated)).toBe(false);
	});

	it("marking and the rotation cap are tracked per base", () => {
		const rotA = requireRotation(rotateCursorConversation("a"));
		const rotC = requireRotation(rotateCursorConversation("c"));
		markCursorRotationSucceeded(rotA);
		expect(isCursorRotationMarked(rotA)).toBe(true);
		expect(isCursorRotationMarked(rotC)).toBe(false);
		// Base "a" hits its own cap of 3, independent of the single marking;
		// each step marks the freshly rotated id so the next rotation is allowed.
		expect(rotateCursorConversation("a")).toBeDefined();
		markCursorRotationSucceeded(resolveCursorConversationId("a"));
		expect(rotateCursorConversation("a")).toBeDefined();
		markCursorRotationSucceeded(resolveCursorConversationId("a"));
		expect(rotateCursorConversation("a")).toBeUndefined();
		// Base "c" is unaffected: its current id is unmarked, so its next
		// rotation must wait for a completed turn.
		expect(rotateCursorConversation("c")).toBeUndefined();
		markCursorRotationSucceeded(rotC);
		expect(rotateCursorConversation("c")).toBeDefined();
	});

	it("two consecutive rotations without marking return [id, undefined]", () => {
		const first = rotateCursorConversation("streak");
		expect(first).toBeDefined();
		// A failure streak must not consume ids: while the current rotated id is
		// unmarked, the next rotation is refused — real account exhaustion must
		// not be hidden behind a rotation cascade.
		expect(rotateCursorConversation("streak")).toBeUndefined();
		expect(resolveCursorConversationId("streak")).toBe(requireRotation(first));
	});

	it("resolveCursorConversationId returns the latest rotated id, or the base itself", () => {
		// A never-rotated base resolves to itself.
		expect(resolveCursorConversationId("never-rotated")).toBe("never-rotated");

		const first = requireRotation(rotateCursorConversation("base"));
		markCursorRotationSucceeded(first);
		const second = requireRotation(rotateCursorConversation("base"));
		// The latest rotation wins: the resolver returns the current wire id.
		expect(resolveCursorConversationId("base")).toBe(second);
		expect(resolveCursorConversationId("base")).not.toBe(first);
		// An unrelated base is unaffected by rotations on "base".
		expect(resolveCursorConversationId("other")).toBe("other");
	});

	it("65 unpinned bases with rotation state evict the oldest mapping and count", () => {
		const rotatedByBase = new Map<string, string>();
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `rot-r-${i}`;
			pinCursorConversation(id);
			let rotated = requireRotation(rotateCursorConversation(id));
			if (i === 0) {
				markCursorRotationSucceeded(rotated);
				rotated = requireRotation(rotateCursorConversation(id));
				markCursorRotationSucceeded(rotated);
				rotated = requireRotation(rotateCursorConversation(id));
				markCursorRotationSucceeded(rotated);
				expect(rotateCursorConversation(id)).toBeUndefined();
			}
			rotatedByBase.set(id, rotated);
			unpinCursorConversation(id);
		}
		const oldest = "rot-r-0";
		const oldestCapped = rotatedByBase.get(oldest)!;
		// Observe the pre-overflow mapping state without resolveCursorConversationId:
		// a resolve is a use and would refresh the oldest mapping's LRU position.
		expect(isCursorRotationMarked(oldestCapped)).toBe(true);
		expect(rotateCursorConversation(oldest)).toBeUndefined();

		pinCursorConversation("rot-r-65");
		const overflowRotated = requireRotation(rotateCursorConversation("rot-r-65"));
		unpinCursorConversation("rot-r-65");

		expect(resolveCursorConversationId(oldest)).toBe(oldest);
		expect(isCursorRotationFresh(oldestCapped)).toBe(false);
		expect(isCursorRotationMarked(oldestCapped)).toBe(false);
		expect(isCursorRotationFresh(oldest)).toBe(false);
		expect(isCursorRotationMarked(oldest)).toBe(false);
		const reissued = requireRotation(rotateCursorConversation(oldest));
		expect(reissued).not.toBe(oldestCapped);
		expect(isCursorRotationFresh(reissued)).toBe(true);

		const survivor = "rot-r-1";
		const survivorRotated = rotatedByBase.get(survivor);
		if (survivorRotated === undefined) throw new Error("expected survivor rotation");
		expect(resolveCursorConversationId(survivor)).toBe(survivorRotated);
		expect(isCursorRotationFresh(survivorRotated)).toBe(true);
		expect(resolveCursorConversationId("rot-r-65")).toBe(overflowRotated);
	});

	it("a pinned base's rotation state survives retained churn", () => {
		pinCursorConversation("pinned-rot");
		const pinnedRotated = requireRotation(rotateCursorConversation("pinned-rot"));
		markCursorRotationSucceeded(pinnedRotated);

		for (let i = 0; i <= CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `churn-${i}`;
			pinCursorConversation(id);
			rotateCursorConversation(id);
			unpinCursorConversation(id);
		}

		expect(resolveCursorConversationId("pinned-rot")).toBe(pinnedRotated);
		expect(isCursorRotationMarked(pinnedRotated)).toBe(true);
		expect(isCursorRotationFresh(pinnedRotated)).toBe(false);
		const next = requireRotation(rotateCursorConversation("pinned-rot"));
		expect(next).not.toBe(pinnedRotated);
		expect(isCursorRotationFresh(next)).toBe(true);
		unpinCursorConversation("pinned-rot");
	});

	it("keeps a retained base mapping while its rotated id is pinned across retained overflow", () => {
		pinCursorConversation("poisoned-base");
		const rotated = requireRotation(rotateCursorConversation("poisoned-base"));
		unpinCursorConversation("poisoned-base");
		pinCursorConversation(rotated);

		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT + 1; i++) {
			const id = `unpin-overflow-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}

		expect(resolveCursorConversationId("poisoned-base")).toBe(rotated);
		expect(isCursorRotationFresh(rotated)).toBe(true);
		unpinCursorConversation(rotated);
	});

	it("keeps a fresh rotation mapping through retained-LRU overflow when the rotated id is not pinned", () => {
		pinCursorConversation("fresh-base");
		const rotated = requireRotation(rotateCursorConversation("fresh-base"));
		unpinCursorConversation("fresh-base");

		// Fill the retained LRU past capacity. The base is the oldest unpinned
		// entry, so it would be the normal eviction victim, but its resolved
		// wire id is still fresh and must not be discarded before retry.
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT + 1; i++) {
			const id = `churn-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}

		expect(resolveCursorConversationId("fresh-base")).toBe(rotated);
		expect(isCursorRotationFresh(rotated)).toBe(true);
	});

	it("evicts the oldest fresh rotation when every retained mapping is still fresh", () => {
		const bases: string[] = [];
		const rotatedByBase = new Map<string, string>();
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT + 2; i++) {
			const id = `all-fresh-${i}`;
			bases.push(id);
			pinCursorConversation(id);
			rotatedByBase.set(id, requireRotation(rotateCursorConversation(id)));
			unpinCursorConversation(id);
		}
		const oldest = bases[0];
		const oldestRotated = rotatedByBase.get(oldest ?? "");
		if (oldest === undefined || oldestRotated === undefined) throw new Error("expected oldest rotation");
		expect(resolveCursorConversationId(oldest)).toBe(oldest);
		expect(isCursorRotationFresh(oldestRotated)).toBe(false);
		const newest = bases[bases.length - 1];
		const newestRotated = rotatedByBase.get(newest ?? "");
		if (newest === undefined || newestRotated === undefined) throw new Error("expected newest rotation");
		expect(resolveCursorConversationId(newest)).toBe(newestRotated);
		expect(isCursorRotationFresh(newestRotated)).toBe(true);
	});

	it("does not evict a just-created fresh mapping when every older retained base is pin-protected", () => {
		const rotatedPins: string[] = [];
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const base = `prot-${i}`;
			pinCursorConversation(base);
			const rotated = requireRotation(rotateCursorConversation(base));
			pinCursorConversation(rotated);
			unpinCursorConversation(base);
			rotatedPins.push(rotated);
		}
		pinCursorConversation("newest-base");
		const newestRotated = requireRotation(rotateCursorConversation("newest-base"));
		unpinCursorConversation("newest-base");
		expect(resolveCursorConversationId("newest-base")).toBe(newestRotated);
		expect(isCursorRotationFresh(newestRotated)).toBe(true);
		for (const rotated of rotatedPins) unpinCursorConversation(rotated);
	});

	it("keeps a successful rotation mapping through the rotated id's overflow unpin after success cleared freshness", () => {
		// 64 older retained bases whose rotated ids are pinned: every older
		// candidate is pin-protected, so the overflow scan must walk past all
		// of them and reach the tail.
		const olderRotations: string[] = [];
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const base = `prot-${i}`;
			pinCursorConversation(base);
			const older = requireRotation(rotateCursorConversation(base));
			pinCursorConversation(older);
			unpinCursorConversation(base);
			olderRotations.push(older);
		}
		// The turn under test: pin the rotated retry id and complete the turn —
		// success clears the mapping's freshness — then unpin the rotated id
		// into the overflowing retained set.
		pinCursorConversation("retry-base");
		const rotated = requireRotation(rotateCursorConversation("retry-base"));
		unpinCursorConversation("retry-base");
		const entry = pinCursorConversation(rotated);
		entry.blobs.set("turn", new Uint8Array([7]));
		markCursorRotationSucceeded(rotated);
		unpinCursorConversation(rotated);

		// The unpin's overflow scan must not select "retry-base" (it resolves
		// to the just-unpinned id) nor the rotated id itself: pre-fix the base
		// was evicted, deleting the successful base→rotated mapping together
		// with its success mark.
		expect(resolveCursorConversationId("retry-base")).toBe(rotated);
		expect(isCursorRotationMarked(rotated)).toBe(true);
		expect(isCursorRotationFresh(rotated)).toBe(false);
		// The mapping is usable: the resolved id still returns this turn's
		// entry with its cached blobs, not a recreated empty one.
		const reused = pinCursorConversation(resolveCursorConversationId("retry-base"));
		expect(reused).toBe(entry);
		expect(reused.blobs.get("turn")).toEqual(new Uint8Array([7]));
		unpinCursorConversation(rotated);
		for (const older of olderRotations) unpinCursorConversation(older);
	});

	it("recent rotated use keeps the base mapping owned when later admissions overflow the retained LRU", () => {
		// Regression: a turn after rotation pins and refreshes only the rotated
		// id, so the base's retained slot used to age at its pre-rotation
		// position. A consumer observes this as the next turn reverting to the
		// poisoned base conversation id (empty state, reset rotation count)
		// even though the conversation was used moments ago.
		pinCursorConversation("used-base");
		unpinCursorConversation("used-base");
		const rotated = requireRotation(rotateCursorConversation("used-base"));
		markCursorRotationSucceeded(rotated);

		// Age the base to the LRU head: every later admission is another
		// conversation, none of them touches "used-base" itself.
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT - 2; i++) {
			const id = `aged-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		expect(resolveCursorConversationId("used-base")).toBe(rotated);

		// The recent turn on the rotated id must have refreshed the base
		// mapping's ownership: the overflow admission evicts the next-oldest
		// retained entry instead of the still-current base → rotated mapping.
		const entry = pinCursorConversation(rotated);
		unpinCursorConversation(rotated);
		pinCursorConversation("overflow-admission");
		unpinCursorConversation("overflow-admission");

		expect(resolveCursorConversationId("used-base")).toBe(rotated);
		expect(isCursorRotationMarked(rotated)).toBe(true);
		// The conversation's state entry is the same object — a stale-ownership
		// eviction would have recreated it empty on this turn.
		expect(pinCursorConversation(resolveCursorConversationId("used-base"))).toBe(entry);
		unpinCursorConversation(resolveCursorConversationId("used-base"));
	});
});
