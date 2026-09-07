import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

function assistantNode(id: string, parentId: string | null, text: string): SessionTreeNode {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 0,
		stopReason: "stop",
	} as AgentMessage;
	return {
		entry: { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message },
		children: [],
	};
}

function modelNode(id: string, parentId: string | null): SessionTreeNode {
	return {
		entry: {
			type: "model_change",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			model: "test/model",
		},
		children: [],
	};
}

function link(parent: SessionTreeNode, child: SessionTreeNode): SessionTreeNode {
	parent.children.push(child);
	return child;
}

/**
 * root ─┬─ a1 ── a2 ── a3   (branch A, three deep)
 *       └─ b1             (branch B)
 */
function fixture(): { roots: SessionTreeNode[]; ids: Record<string, string> } {
	const root = assistantNode("root", null, "common parent");
	const a1 = link(root, assistantNode("a1", "root", "branch A head"));
	const a2 = link(a1, assistantNode("a2", "a1", "branch A middle"));
	link(a2, assistantNode("a3", "a2", "branch A tail"));
	link(root, assistantNode("b1", "root", "branch B"));
	return { roots: [root], ids: { root: "root", a1: "a1", a2: "a2", a3: "a3", b1: "b1" } };
}

function selectorAt(leafId: string): TreeSelectorComponent {
	const { roots } = fixture();
	return new TreeSelectorComponent(
		roots,
		leafId,
		40,
		() => {},
		() => {},
	);
}

describe("tree selector collapse", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("hides the whole subtree of the selected node, keeping the node itself", () => {
		const selector = selectorAt("a1");
		const list = selector.getTreeList();
		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);

		selector.handleInput(TAB);

		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "b1"]);
		expect(list.isCollapsed("a1")).toBe(true);
	});

	it("restores the subtree on a second toggle", () => {
		const selector = selectorAt("a1");
		selector.handleInput(TAB);
		selector.handleInput(TAB);

		expect(selector.getTreeList().getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);
		expect(selector.getTreeList().isCollapsed("a1")).toBe(false);
	});

	it("counts the entire hidden subtree, not just direct children", () => {
		const selector = selectorAt("a1");
		selector.handleInput(TAB);

		const row = selector
			.render(120)
			.map(line => Bun.stripANSI(line))
			.find(line => line.includes("branch A head"));
		if (!row) throw new Error("Expected the collapsed branch head to stay visible");
		expect(row).toContain("(+2)");
		expect(row).toContain("\u25b8"); // ▸ collapsed marker
	});

	it("attributes a nested collapse's descendants to the outermost fold", () => {
		const selector = selectorAt("a2");
		const list = selector.getTreeList();
		selector.handleInput(TAB); // fold a2, hiding a3
		selector.handleInput(UP);
		expect(list.getSelectedNode()?.entry.id).toBe("a1");
		selector.handleInput(TAB); // fold a1, swallowing the a2 fold

		const row = selector
			.render(120)
			.map(line => Bun.stripANSI(line))
			.find(line => line.includes("branch A head"));
		if (!row) throw new Error("Expected the collapsed branch head to stay visible");
		// Both a2 and a3 are hidden by the visible fold, so it must report 2 — the
		// inner fold is invisible and owns nothing.
		expect(row).toContain("(+2)");
	});

	it("is a no-op on a node with nothing below it", () => {
		const selector = selectorAt("a3");
		const list = selector.getTreeList();
		selector.handleInput(TAB);

		expect(list.isCollapsed("a3")).toBe(false);
		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);
	});

	it("keeps a subtree collapsed across a filter change", () => {
		const selector = selectorAt("a1");
		const list = selector.getTreeList();
		selector.handleInput(TAB);
		selector.handleInput("\x1ba"); // alt+a — widen to the "all" filter

		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "b1"]);
	});

	it("folds only the branches off the current thread, keeping that thread readable", () => {
		const selector = selectorAt("a3"); // current thread is root → a1 → a2 → a3
		const list = selector.getTreeList();

		selector.handleInput(SHIFT_TAB);
		// The thread stays fully expanded; branch b1 survives as a single row.
		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);
		expect(list.isCollapsed("root")).toBe(false);
		expect(list.isCollapsed("a1")).toBe(false);

		selector.handleInput(SHIFT_TAB);
		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);
	});

	it("folds an off-thread branch down to its head row", () => {
		const { roots } = fixture();
		// Give branch B its own descendants so folding it is observable.
		const b1 = roots[0].children[1];
		link(b1, assistantNode("b2", "b1", "branch B deep"));
		const selector = new TreeSelectorComponent(
			roots,
			"a3",
			40,
			() => {},
			() => {},
		);
		const list = selector.getTreeList();
		expect(list.getVisibleEntryIds()).toContain("b2");

		selector.handleInput(SHIFT_TAB);

		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "a2", "a3", "b1"]);
		expect(list.isCollapsed("b1")).toBe(true);
	});

	it("folds an off-thread branch at its first visible row", () => {
		const root = assistantNode("root", null, "common parent");
		const active = link(root, assistantNode("active", "root", "active branch"));
		const hiddenHead = link(root, modelNode("hidden-head", "root"));
		const visibleHead = link(hiddenHead, assistantNode("visible-head", "hidden-head", "visible branch head"));
		link(visibleHead, assistantNode("visible-tail", "visible-head", "visible branch tail"));
		const selector = new TreeSelectorComponent(
			[root],
			active.entry.id,
			40,
			() => {},
			() => {},
		);
		const list = selector.getTreeList();

		selector.handleInput(SHIFT_TAB);

		expect(list.getVisibleEntryIds()).toEqual(["root", "active", "visible-head"]);
		expect(list.isCollapsed("visible-head")).toBe(true);
		expect(list.isCollapsed("hidden-head")).toBe(false);
	});

	it("keeps manual folds while activating focused-thread folds", () => {
		const { roots } = fixture();
		const b1 = roots[0].children[1];
		link(b1, assistantNode("b2", "b1", "branch B deep"));
		const selector = new TreeSelectorComponent(
			roots,
			"a1",
			40,
			() => {},
			() => {},
		);
		const list = selector.getTreeList();

		selector.handleInput(TAB);
		selector.handleInput(SHIFT_TAB);

		expect(list.isCollapsed("a1")).toBe(true);
		expect(list.isCollapsed("b1")).toBe(true);
		expect(list.getVisibleEntryIds()).toEqual(["root", "a1", "b1"]);
	});

	it("counts only descendants visible in the current projection", () => {
		const root = assistantNode("root", null, "common parent");
		const hidden = link(root, modelNode("hidden", "root"));
		link(hidden, assistantNode("visible", "hidden", "visible descendant"));
		const selector = new TreeSelectorComponent(
			[root],
			"root",
			40,
			() => {},
			() => {},
		);

		selector.handleInput(TAB);

		const row = selector
			.render(120)
			.map(line => Bun.stripANSI(line))
			.find(line => line.includes("common parent"));
		expect(row).toContain("(+1)");
	});

	it("collapses on space, but types a space into an active search instead", () => {
		const selector = selectorAt("a1");
		const list = selector.getTreeList();

		selector.handleInput(" ");
		expect(list.isCollapsed("a1")).toBe(true);

		selector.handleInput(" "); // expand again, then start searching
		selector.handleInput("b");
		selector.handleInput(" ");
		expect(list.getSearchQuery()).toBe("b ");
		expect(list.isCollapsed(list.getSelectedNode()?.entry.id ?? "")).toBe(false);
	});

	it("preserves Left and Right as page navigation", () => {
		const root = assistantNode("n0", null, "entry 0");
		let tip = root;
		for (let i = 1; i < 12; i++) tip = link(tip, assistantNode(`n${i}`, tip.entry.id, `entry ${i}`));
		const selector = new TreeSelectorComponent(
			[root],
			"n11",
			13,
			() => {},
			() => {},
		);
		const list = selector.getTreeList();

		selector.handleInput(LEFT);
		expect(list.getSelectedNode()?.entry.id).toBe("n6");
		selector.handleInput(RIGHT);
		expect(list.getSelectedNode()?.entry.id).toBe("n11");
	});

	it("moves the cursor to the collapsed ancestor when the selection is hidden", () => {
		const selector = selectorAt("a3");
		const list = selector.getTreeList();
		expect(list.getSelectedNode()?.entry.id).toBe("a3");

		// Walk up to a1 and collapse from there: the cursor must not be stranded
		// on a row that no longer exists.
		selector.handleInput(UP);
		selector.handleInput(UP);
		expect(list.getSelectedNode()?.entry.id).toBe("a1");

		selector.handleInput(TAB);
		expect(list.getSelectedNode()?.entry.id).toBe("a1");
	});

	it("stays linear on a deep chain", () => {
		const root = assistantNode("n0", null, "entry 0");
		let tip = root;
		for (let i = 1; i < 20_000; i++) {
			tip = link(tip, assistantNode(`n${i}`, tip.entry.id, `entry ${i}`));
		}
		const selector = new TreeSelectorComponent(
			[root],
			"n0",
			40,
			() => {},
			() => {},
		);

		const started = performance.now();
		selector.handleInput(TAB);
		const elapsed = performance.now() - started;

		expect(selector.getTreeList().getVisibleEntryIds()).toEqual(["n0"]);
		expect(elapsed).toBeLessThan(2_000);
	});
});
