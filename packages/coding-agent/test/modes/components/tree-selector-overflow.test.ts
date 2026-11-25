import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { mountTreeSelector, treeListRows } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

let counter = 0;
function makeUserNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${counter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: counter };
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

/** Build a tree where every parent has two children, simulating heavy rewind branching. */
function buildBranchyTree(branchDepth: number): { root: SessionTreeNode; leaf: SessionTreeNode } {
	const root = makeUserNode("root");
	let current = root;
	for (let i = 0; i < branchDepth; i++) {
		const a = makeUserNode(`branch-${i}-a`, current.entry.id);
		const b = makeUserNode(`branch-${i}-b-this-side-stays-active`, current.entry.id);
		current.children.push(a, b);
		current = b;
	}
	return { root, leaf: current };
}

function renderSelector(tree: SessionTreeNode, leafId: string, width: number): string[] {
	return treeListRows({ roots: [tree], currentLeafId: leafId }, { columns: width, rows: 200 });
}

describe("TreeSelectorComponent deep branching overflow", () => {
	it("opens a deep linear history at its current leaf and navigates past filtered entries", () => {
		const root = makeUserNode("first prompt");
		let tail = root;
		for (let i = 0; i < 50_000; i++) {
			const node: SessionTreeNode = {
				entry: {
					id: `setting-${i}`,
					parentId: tail.entry.id,
					timestamp: root.entry.timestamp,
					type: "thinking_level_change",
					thinkingLevel: "off",
				},
				children: [],
			};
			tail.children.push(node);
			tail = node;
		}
		const leaf = makeUserNode("latest prompt", tail.entry.id);
		tail.children.push(leaf);
		const selected: string[] = [];
		const term = mountTreeSelector({
			roots: [root],
			currentLeafId: leaf.entry.id,
			onSelect: id => selected.push(id),
		});
		try {
			expect(term.screen().join("\n")).toContain("latest prompt");
			term.press("enter");
			term.press("up");
			term.press("enter");
			expect(selected).toEqual([leaf.entry.id, root.entry.id]);
		} finally {
			term.dispose();
		}
	});

	it("keeps the selected entry text visible when branching exceeds the viewport width", () => {
		const { root, leaf } = buildBranchyTree(80);
		const width = 120;
		const rendered = renderSelector(root, leaf.entry.id, width);

		// Every rendered row must fit the viewport — never wider than `width` display cols.
		for (const line of rendered) {
			expect(Bun.stringWidth(line, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(width);
		}

		// The selected row (marked with the `›` cursor) must still show the entry text
		// instead of spending the whole viewport on branch gutters.
		const selectedRow = rendered.find(line => line.trimStart().startsWith("›"));
		expect(selectedRow).toBeDefined();
		expect(selectedRow!).toContain("user:");
		expect(selectedRow!).toMatch(/branch-\d+-b/);
	});
});
