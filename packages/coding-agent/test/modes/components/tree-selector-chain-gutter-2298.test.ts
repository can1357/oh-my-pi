import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { treeListRows } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

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

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	return treeListRows({ roots: tree, currentLeafId: leafId }, { columns: width, rows: 60 });
}

describe("issue #7332: linear branch continuations stay compact", () => {
	// Linear continuations should align with their branch head. Indenting them
	// another level leaves the vertical anchor disconnected from the branch
	// connector and makes heavily branched conversations drift right.
	it("aligns descendants of a last sibling with the branch head", () => {
		const root = makeNode("user", "original");
		const rootAsst = makeNode("assistant", "resp", root.entry.id);
		root.children.push(rootAsst);

		// rootAsst branches; branch2 is active (renders first), branch1 is last.
		const branch1 = makeNode("user", "branch1 head", rootAsst.entry.id);
		const branch2 = makeNode("user", "branch2 head", rootAsst.entry.id);
		rootAsst.children.push(branch1, branch2);

		// Chain descendants under branch1 (the LAST sibling) — these are the
		// rows that used to lose the gutter.
		const chain1 = makeNode("assistant", "chain-asst-1", branch1.entry.id);
		branch1.children.push(chain1);
		const chain2 = makeNode("user", "chain-user-2", chain1.entry.id);
		chain1.children.push(chain2);

		const fixIt = makeNode("user", "fix it all", branch2.entry.id);
		branch2.children.push(fixIt);

		const rendered = renderStripped([root], fixIt.entry.id);

		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// Branch1 is the last sibling at level 1, so its own connector is `└─`.
		const branch1Row = findRow("user: branch1 head");
		expect(branch1Row).toMatch(/└─\s+user: branch1 head/);
		const head = branch1Row.indexOf("user: branch1 head");

		// The terminal branch has no continuing sibling gutter. Its linear
		// descendants align with the branch head instead of inventing a
		// disconnected vertical one level farther right.
		for (const needle of ["assistant: chain-asst-1", "user: chain-user-2"]) {
			const row = findRow(needle);
			expect(row).not.toContain("│");
			expect(row.indexOf(needle)).toBe(head);
		}
	});

	// Branched grandchildren and their continuations must stay on the standard
	// tree convention so a `│` never floats below an unrelated `└─`. Only the
	// nearest connector gutter is extended for chain rows.
	it("does not extend the gutter through branched descendants of a last-sibling parent", () => {
		const root = makeNode("user", "original");
		const rootAsst = makeNode("assistant", "resp", root.entry.id);
		root.children.push(rootAsst);

		const branch1 = makeNode("user", "branch1 head", rootAsst.entry.id);
		const branch2 = makeNode("user", "branch2 head", rootAsst.entry.id);
		rootAsst.children.push(branch1, branch2);

		// branch1 itself branches into c, d (both have their own connectors),
		// and each grandchild continues linearly.
		const c = makeNode("user", "grandchild c", branch1.entry.id);
		const d = makeNode("user", "grandchild d", branch1.entry.id);
		branch1.children.push(c, d);
		const cContinuation = makeNode("assistant", "c continuation", c.entry.id);
		c.children.push(cContinuation);
		const dContinuation = makeNode("assistant", "d continuation", d.entry.id);
		d.children.push(dContinuation);

		const fixIt = makeNode("user", "fix it all", branch2.entry.id);
		branch2.children.push(fixIt);

		const rendered = renderStripped([root], fixIt.entry.id);

		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// The grandchildren carry their own connectors; branch1's terminated
		// column stays blank so the standard `└─` semantics survive.
		const branch1Column = findRow("user: branch1 head").search(/└─/);
		for (const needle of ["grandchild c", "grandchild d"]) {
			const row = findRow(needle);
			expect(row[branch1Column]).toBe(" ");
			expect(row).toMatch(/[├└]─/);
		}

		// Linear continuations stay at their branch head's content depth. The
		// non-last branch keeps its sibling gutter; the terminal branch needs
		// no synthetic anchor.
		const cRow = findRow("c continuation");
		expect(cRow).toContain("│");
		expect(cRow.indexOf("assistant: c continuation")).toBe(findRow("grandchild c").indexOf("user: grandchild c"));
		const dRow = findRow("d continuation");
		expect(dRow).not.toContain("│");
		expect(dRow.indexOf("assistant: d continuation")).toBe(findRow("grandchild d").indexOf("user: grandchild d"));
	});
});

describe("a fork whose branch head the filter hides", () => {
	// The guide belongs to the fork, not to the head's row: a hidden head (a bookkeeping entry the
	// default view drops) still has siblings below it, and the rows under it must say so.
	it("keeps the fork's guide on the rows under the hidden head", () => {
		const root = makeNode("user", "original");
		const fork = makeNode("assistant", "resp", root.entry.id);
		root.children.push(fork);

		const hiddenHead: SessionTreeNode = {
			entry: {
				type: "custom",
				id: `e${counter++}`,
				parentId: fork.entry.id,
				timestamp: new Date().toISOString(),
				customType: "marker",
			},
			children: [],
		};
		const under = makeNode("user", "under the hidden head", hiddenHead.entry.id);
		hiddenHead.children.push(under);
		const reply = makeNode("assistant", "its reply", under.entry.id);
		under.children.push(reply);
		const other = makeNode("user", "other branch", fork.entry.id);
		fork.children.push(other, hiddenHead);

		// The leaf sits under the hidden head: that branch renders first, `other` is the last sibling.
		const rendered = renderStripped([root], reply.entry.id);
		const row = (needle: string): string => {
			const found = rendered.find(line => line.includes(needle));
			if (!found) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return found;
		};

		expect(rendered.some(line => line.includes("[custom: marker]"))).toBe(false);
		const otherRow = row("user: other branch");
		expect(otherRow).toMatch(/└─\s+user: other branch/);
		const corner = otherRow.indexOf("└");
		for (const needle of ["user: under the hidden head", "assistant: its reply"]) {
			expect(row(needle)[corner]).toBe("│");
		}
	});
});
