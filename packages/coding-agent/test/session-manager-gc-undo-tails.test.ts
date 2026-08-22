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
});
