import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { renderTreeSelector } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

let counter = 0;
function makeMessageNode(message: AgentMessage, parentId: string | null = null, label?: string): SessionTreeNode {
	const id = `entry-${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [], label };
}

function render(tree: SessionTreeNode[], width = 120): string {
	return renderTreeSelector(
		{ roots: tree, currentLeafId: tree[tree.length - 1]?.entry.id ?? null },
		{ columns: width, rows: 60 },
	);
}

describe("TreeSelectorComponent developer message rendering", () => {
	it("renders developer messages with their content, not just [developer]", () => {
		const planContent = "## Plan\n\n1. Fix the tree selector\n2. Update the HTML export";
		const root = makeMessageNode({ role: "user", content: "/plan", timestamp: 1 });
		const developer = makeMessageNode(
			{ role: "developer", content: [{ type: "text", text: planContent }], timestamp: 2 },
			root.entry.id,
		);
		root.children.push(developer);

		const rendered = render([root]);

		expect(rendered).toContain("developer:");
		expect(rendered).toContain("Fix the tree selector");
		expect(rendered).toContain("Update the HTML export");
		expect(rendered).not.toMatch(/^\s*\[developer\]\s*$/m);
	});
});
