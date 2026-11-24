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

function chain(parent: SessionTreeNode, role: "user" | "assistant", text: string): SessionTreeNode {
	const node = makeNode(role, text, parent.entry.id);
	parent.children.push(node);
	return node;
}

/** A spine of `forks` interrupted turns, returning the tree and its active leaf. */
function forkedSpine(forks: number): { root: SessionTreeNode; leaf: SessionTreeNode } {
	counter = 0;
	const root = makeNode("user", "root question");
	let cursor: SessionTreeNode = root;
	for (let fork = 0; fork < forks; fork++) {
		chain(cursor, "assistant", `abandoned ${fork}`);
		cursor = chain(cursor, "user", `follow-up ${fork}`);
	}
	return { root, leaf: cursor };
}

function renderStripped(root: SessionTreeNode, leaf: SessionTreeNode): string[] {
	return treeListRows({ roots: [root], currentLeafId: leaf.entry.id }, { columns: 120, rows: 200 });
}

/** Column of a row's `├─`/`└─`, or `undefined` when it draws no connector. */
function connectorColumn(row: string): number | undefined {
	const column = row.search(/[├└]─/);
	return column < 0 ? undefined : column;
}

describe("clamped rows share one horizontal frame", () => {
	// 25 nested forks: the `└─` closing each abandoned turn must step one level
	// outward per fork, never stack unrelated depths in one column.
	it("steps closing connectors outward one level at a time", () => {
		const { root, leaf } = forkedSpine(25);
		const closing = renderStripped(root, leaf)
			.filter(row => /└─/.test(row))
			.map(row => row.search(/└─/));

		expect(closing.length).toBeGreaterThan(2);
		for (const [left, right] of closing.slice(0, -1).map((column, i) => [column, closing[i + 1]])) {
			expect(right).toBeLessThan(left);
		}
	});

	// A `└─` is the last child at its level, so its column stays empty below.
	it("leaves a terminated column empty on every row beneath it", () => {
		const { root, leaf } = forkedSpine(25);
		const rows = renderStripped(root, leaf);

		for (const [index, row] of rows.entries()) {
			const column = connectorColumn(row);
			if (column === undefined || row[column] !== "└") continue;
			for (const below of rows.slice(index + 1)) {
				expect(below[column] ?? " ").not.toBe("│");
			}
		}
	});
});
