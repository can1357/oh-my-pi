import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function chain(parent: SessionTreeNode, ...specs: Array<["user" | "assistant", string]>): SessionTreeNode {
	let cur = parent;
	for (const [role, text] of specs) {
		const n = makeNode(role, text, cur.entry.id);
		cur.children.push(n);
		cur = n;
	}
	return cur;
}

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
	);
	return selector.renderContent(width).map(line => Bun.stripANSI(line));
}

// A terminal branch whose linear chain branches again must keep every row at
// its logical depth without reviving the terminal gutter or drifting right.
describe("issue #7332: terminal branch chains keep compact alignment", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("aligns chain rows with their branch heads and terminates last-sibling gutters", () => {
		counter = 0;
		const root = makeNode("user", "proceed with implementation");
		const asst = chain(root, ["assistant", "resp"]);
		const b1 = makeNode("user", "first review head", asst.entry.id);
		const b2 = makeNode("user", "plain review head", asst.entry.id);
		const b3 = makeNode("user", "second review head", asst.entry.id);
		asst.children.push(b1, b2, b3);
		const leaf = chain(b1, ["assistant", "b1 reply"], ["user", "active leaf"]);

		// Chain under the LAST sibling b3, with a branch point partway down.
		const fixIt = chain(b3, ["assistant", "fix-asst"], ["user", "fix it all"]);
		const revAsst = chain(fixIt, ["assistant", "rev-asst"]);
		const t1 = makeNode("user", "review the fixes", revAsst.entry.id);
		const t2 = makeNode("user", "other thread", revAsst.entry.id);
		revAsst.children.push(t1, t2);
		chain(t1, ["user", "all findings done"], ["user", "still have findings"]);

		const rendered = renderStripped([root], leaf.entry.id);
		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// b3 is the last sibling: its connector is `└─` at column 2.
		expect(findRow("user: second review head")).toMatch(/^\s{2}└─ \S/);

		// Chain rows under the `└─` head align with its content. They neither
		// revive the terminated gutter nor create a disconnected anchor farther
		// right.
		for (const needle of ["assistant: fix-asst", "user: fix it all", "assistant: rev-asst"]) {
			const row = findRow(needle);
			expect(row).not.toContain("│");
			expect(row).toMatch(/^\s{5}\S/);
		}

		// The deeper branch point advances one level from the compact chain.
		expect(findRow("user: review the fixes")).toMatch(/^\s{5}├─ \S/);
		expect(findRow("user: other thread")).toMatch(/^\s{5}└─ \S/);

		// Continuations of the non-last grandchild stay aligned with that
		// grandchild while its sibling gutter remains visible.
		for (const needle of ["user: all findings done", "user: still have findings"]) {
			const row = findRow(needle);
			expect(row).toMatch(/^\s{5}│\s{2}\S/);
		}
	});
});

// Multiple roots (e.g. orphaned parent chains after `resetLeaf`) render as
// children of a virtual branching root: the roots share column 0 and their
// own descendants must nest one level in rather than collapsing back.
describe("issue #7332: single-child roots stay nested under the virtual root", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("indents linear descendants of a root past the shared column-0 roots", () => {
		counter = 0;
		const root1 = makeNode("user", "root one head");
		chain(root1, ["assistant", "root one reply"], ["user", "root one follow"]);
		const root2 = makeNode("user", "root two head");
		const leaf = chain(root2, ["assistant", "root two reply"]);

		const rendered = renderStripped([root1, root2], leaf.entry.id);
		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// root1 is not on the active path: its head sits at the shared column 0
		// (2-space cursor, no gutter prefix).
		expect(findRow("user: root one head")).toMatch(/^\s{2}\S/);

		// Its linear descendants nest one level in; before the fix they collapsed
		// back to the root's column.
		for (const needle of ["assistant: root one reply", "user: root one follow"]) {
			expect(findRow(needle)).toMatch(/^\s{5}\S/);
		}
	});
});
