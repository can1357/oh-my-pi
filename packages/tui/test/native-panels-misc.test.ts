import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { MoveOverlay, type MoveOverlayResult } from "../src/overlays/move-overlay";
import { BtwHistoryPanel } from "../src/overlays/btw-history-panel";
import type { BtwHistoryRecord } from "../src/overlays/btw-history";
import { CodexResetFireworksController } from "../src/overlays/codex-reset-fireworks";
import type { Component, OverlayHandle } from "../src/index";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
	vi.useRealTimers();
});

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search over described nodes, not descending into component children. */
function findNode(root: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode | undefined {
	if (predicate(root)) return root;
	for (const child of root.c ?? []) {
		if (!isNode(child)) continue;
		const found = findNode(child, predicate);
		if (found) return found;
	}
	return undefined;
}

function listOf(root: NativeNode): NativeNode & { k: "list" } {
	const list = findNode(root, node => node.k === "list");
	if (list?.k !== "list") throw new Error("no list described");
	return list;
}

describe("MoveOverlay native events", () => {
	const entries = [
		{ value: "/work/alpha", label: "alpha/" },
		{ value: "/work/beta", label: "beta/" },
		{ value: "/work/gamma", label: "gamma/" },
	];

	it("mirrors a selected suggestion and confirms the activated one", () => {
		const results: (MoveOverlayResult | undefined)[] = [];
		const overlay = new MoveOverlay("/work", result => results.push(result), { search: () => entries });
		expect(listOf(overlay.describe()).p?.selected).toBe("/work/alpha");

		overlay.handleNativeEvent({ type: "select", key: "results", item: "/work/gamma" });
		expect(listOf(overlay.describe()).p?.selected).toBe("/work/gamma");
		expect(results).toEqual([]);

		overlay.handleNativeEvent({ type: "activate", key: "results", item: "/work/beta" });
		expect(results).toEqual([{ directory: "/work/beta" }]);
	});
});

describe("BtwHistoryPanel native events", () => {
	const record = (id: string, question: string): BtwHistoryRecord => ({
		id,
		leafId: null,
		question,
		answer: `answer to ${question}`,
		status: "complete",
		createdAt: 0,
		updatedAt: 0,
	});

	function panel(): BtwHistoryPanel {
		return new BtwHistoryPanel({
			records: [record("a", "first question"), record("b", "second question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			requestRender: () => {},
			getHeight: () => 30,
		});
	}

	it("shows the natively selected record's turn in the details pane", () => {
		const history = panel();
		history.handleNativeEvent({ type: "select", key: "body/history/records", item: "b" });
		const described = history.describe();
		expect(listOf(described).p?.selected).toBe("b");
		const question = findNode(described, node => node.k === "md" && node.p?.text === "second question");
		expect(question).toBeDefined();
	});

	it("opens the follow-up composer for an activated record", () => {
		const history = panel();
		expect(findNode(history.describe(), node => node.key === "composer")).toBeUndefined();
		history.handleNativeEvent({ type: "activate", key: "body/history/records", item: "b" });
		const described = history.describe();
		expect(listOf(described).p?.selected).toBe("b");
		expect(findNode(described, node => node.key === "composer")).toBeDefined();
	});
});

describe("CodexResetFireworks under a native surface", () => {
	it("does not run the frame repaint loop", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		let renders = 0;
		const handle: OverlayHandle = { hide: () => {}, setHidden: () => {}, isHidden: () => false };
		const controller = new CodexResetFireworksController({
			ui: {
				showOverlay: (_component: Component) => handle,
				setFocus: () => {},
				requestRender: () => {
					renders++;
				},
				terminal: { rows: 30 },
			},
		});
		expect(controller.show({ kind: "unscheduled-weekly-reset" })).toBe(true);
		vi.advanceTimersByTime(1_000);
		controller.dispose();
		// One paint to show the overlay; no 85ms frame ticks.
		expect(renders).toBe(1);
	});
});
