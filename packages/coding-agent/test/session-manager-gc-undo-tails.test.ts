/**
 * gc of user-undo branch tails: SessionManager.pruneUserUndoTails.
 *
 * Topology under test (built directly on the journal):
 *
 *   u1 a1 u2 a2          <- undo #1 drops (u2,a2)   [marker m1, anchor a1]
 *   u3 a3                <- undo #2 drops (u3,a3)   [marker m2, anchor m1]
 *   u4 a4                <- active tail
 *
 * prune(keep=1) must remove ONLY the m1 tail, scrub m1's details (the
 * dropped-prompts list is the last surviving copy of retracted content),
 * keep the m2 tail redoable, and never touch the active path.
 */
import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const SECRET_TAIL_1 = "MARKER-TAIL-ONE-5";
const SECRET_TAIL_2 = "MARKER-TAIL-TWO-8";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		timestamp: Date.now(),
	};
}

interface Topology {
	manager: SessionManager;
	m1: string;
	m2: string;
	tailOneIds: string[];
	tailTwoIds: string[];
	activeIds: string[];
}

function buildTopology(): Topology {
	const manager = SessionManager.inMemory();
	manager.appendMessage(userMessage("u1"));
	const a1 = manager.appendMessage(assistantMessage("a1"));
	const u2 = manager.appendMessage(userMessage(SECRET_TAIL_1));
	const a2 = manager.appendMessage(assistantMessage("a2-response"));

	// undo #1: branch before u2; anchor is a1.
	const m1 = manager.branchWithSummary(a1, "", {
		kind: "user-undo",
		undoOf: a2,
		steps: 1,
		droppedPrompts: `- ${SECRET_TAIL_1}`,
	});

	const u3 = manager.appendMessage(userMessage(SECRET_TAIL_2));
	const a3 = manager.appendMessage(assistantMessage("a3-response"));

	// undo #2: branch before u3; anchor is m1 itself (last entry before u3).
	const m2 = manager.branchWithSummary(m1, "", {
		kind: "user-undo",
		undoOf: a3,
		steps: 1,
		droppedPrompts: `- ${SECRET_TAIL_2}`,
	});

	manager.appendMessage(userMessage("u4"));
	manager.appendMessage(assistantMessage("a4"));
	const activeIds = manager.getBranch().map(entry => entry.id);
	return { manager, m1, m2, tailOneIds: [u2, a2], tailTwoIds: [u3, a3], activeIds };
}

describe("SessionManager.pruneUserUndoTails", () => {
	it("keep=1 prunes only the older tail and scrubs its marker", async () => {
		const { manager, m1, m2, tailOneIds, tailTwoIds } = buildTopology();

		const result = await manager.pruneUserUndoTails(1, true);

		expect(result.markers).toBe(1);
		expect(result.removed).toBeGreaterThanOrEqual(2);
		for (const id of tailOneIds) expect(manager.hasEntry(id)).toBe(false);
		for (const id of tailTwoIds) expect(manager.hasEntry(id)).toBe(true);

		const entries = manager.getEntries();
		const prunedMarker = entries.find(entry => entry.id === m1) as { details?: Record<string, unknown> };
		expect(prunedMarker.details?.droppedPrompts).toBeUndefined();
		expect(prunedMarker.details?.undoOf).toBeUndefined();
		expect(typeof prunedMarker.details?.prunedAt).toBe("string");

		const keptMarker = entries.find(entry => entry.id === m2) as { details?: Record<string, unknown> };
		expect(keptMarker.details?.droppedPrompts).toBe(`- ${SECRET_TAIL_2}`);
		expect(manager.hasEntry(keptMarker.details?.undoOf as string)).toBe(true);
	});

	it("never touches the active path", async () => {
		const { manager, activeIds } = buildTopology();
		const before = manager.getBranch().map(entry => entry.id);

		await manager.pruneUserUndoTails(1, true);

		const after = manager.getBranch().map(entry => entry.id);
		expect(after).toEqual(before);
		for (const id of activeIds) expect(manager.hasEntry(id)).toBe(true);
	});

	it("dry run computes the same counts without mutating", async () => {
		const { manager, tailOneIds } = buildTopology();
		const entriesBefore = manager.getEntries().length;

		const result = await manager.pruneUserUndoTails(1, false);

		expect(result.markers).toBe(1);
		expect(manager.getEntries().length).toBe(entriesBefore);
		for (const id of tailOneIds) expect(manager.hasEntry(id)).toBe(true);
	});

	it("keep=0 prunes both tails; newest undo becomes unredoable", async () => {
		const { manager, m2, tailOneIds, tailTwoIds } = buildTopology();

		const result = await manager.pruneUserUndoTails(0, true);

		expect(result.markers).toBe(2);
		for (const id of [...tailOneIds, ...tailTwoIds]) expect(manager.hasEntry(id)).toBe(false);
		const marker = manager.getEntries().find(entry => entry.id === m2) as { details?: Record<string, unknown> };
		expect(manager.hasEntry(marker.details?.undoOf as string)).toBe(false);
		expect(marker.details?.undoOf).toBeUndefined();
	});

	it("fewer markers than keep is a no-op", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("only"));
		manager.branchWithSummary((manager.getBranch().at(-1) as { id: string }).id, "", {
			kind: "user-undo",
			undoOf: null,
		});

		const result = await manager.pruneUserUndoTails(1, true);

		expect(result).toEqual({ markers: 0, removed: 0 });
	});

	it("a newer undo nested inside an older tail survives pruning of the older marker", async () => {
		// undo, redo back into the tail, undo again, then move the active
		// leaf elsewhere: m2 (newest) lives inside m1's tail and must stay
		// fully redoable while m1's tail is pruned.
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("u1"));
		const a1 = manager.appendMessage(assistantMessage("a1"));
		manager.appendMessage(userMessage(SECRET_TAIL_1));
		const a2 = manager.appendMessage(assistantMessage("a2-response"));
		const m1 = manager.branchWithSummary(a1, "", { kind: "user-undo", undoOf: a2, steps: 1, droppedPrompts: "" });
		// redo: branch back to the a2 tip (marker m2 = user-redo, not pruned
		// material), then continue inside the restored tail.
		const redo = manager.branchWithSummary(a2, "", { kind: "user-redo", redoOf: m1 });
		const u5 = manager.appendMessage(userMessage("late-in-tail"));
		const a5 = manager.appendMessage(assistantMessage("a5-response"));
		// undo again from inside the tail: m2's tail includes u5/a5 and the
		// redo marker entry itself.
		const m2 = manager.branchWithSummary(redo, "", { kind: "user-undo", undoOf: a5, steps: 1, droppedPrompts: "" });
		// tree-switch away: active path continues from a1, markers go off-branch.
		manager.branchWithSummary(a1, "", { kind: "manual", note: "switched away" });
		manager.appendMessage(userMessage("fresh"));
		manager.appendMessage(assistantMessage("fresh-reply"));

		const result = await manager.pruneUserUndoTails(1, true);

		// Only m1 is older than the newest marker. m2's ancestor spine runs
		// through m1's tail, so the older prune degrades to a scrub: the tail
		// survives instead of orphaning the retained marker.
		expect(result.markers).toBe(1);
		expect(result.removed).toBe(0);
		for (const kept of [redo, u5, a5, m2, a2]) expect(manager.hasEntry(kept)).toBe(true);
		// m2 stays redoable: its undoOf target survived.
		const m2Entry = manager.getEntries().find(entry => entry.id === m2) as
			| { details?: { undoOf?: string } }
			| undefined;
		expect(manager.hasEntry(m2Entry?.details?.undoOf ?? "")).toBe(true);
		// The second undo's own tail must NOT survive as garbage either when
		// it is the pruned one: run again with keep=0 semantics covered by the
		// scrub rule instead; here just confirm idempotence.
		const again = await manager.pruneUserUndoTails(1, true);
		expect(again.markers).toBe(0);
	});

	it("a second run after apply is a no-op (pruned markers are excluded)", async () => {
		const { manager } = await buildTopology();
		const first = await manager.pruneUserUndoTails(1, true);
		expect(first.markers).toBeGreaterThanOrEqual(1);

		const second = await manager.pruneUserUndoTails(1, true);
		expect(second.markers).toBe(0);
		expect(second.removed).toBe(0);

		// The scrubbed marker keeps its kind but no longer claims an undoOf.
		const scrubbed = manager
			.getEntries()
			.find(
				entry =>
					entry.type === "branch_summary" &&
					(entry as { details?: { kind?: string } }).details?.kind === "user-undo",
			);
		expect(scrubbed).toBeDefined();
		expect((scrubbed as { details?: { undoOf?: string | null; prunedAt?: string } }).details?.undoOf).toBeFalsy();
		expect((scrubbed as { details?: { prunedAt?: string } }).details?.prunedAt).toBeTruthy();
	});
});
