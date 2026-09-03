import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

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
	const selector = new TreeSelectorComponent(
		[tree],
		leafId,
		200,
		() => {},
		() => {},
	);
	return selector.renderContent(width).map(line => Bun.stripANSI(line));
}

describe("TreeSelectorComponent deep branching overflow", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
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

	it("preserves prefix budget so the selected entry text remains legible at narrow width", () => {
		const { root, leaf } = buildBranchyTree(40);
		const width = 80;
		const rendered = renderSelector(root, leaf.entry.id, width);

		const selectedRow = rendered.find(line => line.trimStart().startsWith("›"));
		expect(selectedRow).toBeDefined();
		expect(selectedRow!).toContain("user:");
	});
});
