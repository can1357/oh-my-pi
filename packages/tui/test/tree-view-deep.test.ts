import { describe, expect, test } from "bun:test";
import { TreeView } from "../src/components/tree-view";

interface Node {
	id: string;
	children: Node[];
}

/** Linear chain of `depth` nodes — the shape a long single-branch session has. */
function chain(depth: number): Node {
	const root: Node = { id: "n0", children: [] };
	let tail = root;
	for (let i = 1; i < depth; i++) {
		const next: Node = { id: `n${i}`, children: [] };
		tail.children.push(next);
		tail = next;
	}
	return root;
}

describe("TreeView deep projection", () => {
	// Copying an ancestor array per row is O(depth²) memory; a 50k-deep chain
	// allocated ~1.2B entries and OOM-killed `/tree` on long sessions.
	test("projects a 50k-deep chain and still reports full ancestry", () => {
		const view = new TreeView<Node, string>({
			roots: [chain(50_000)],
			getKey: node => node.id,
			getChildren: node => node.children,
			maxRows: 20,
		});

		expect(view.rows.length).toBe(50_000);
		const last = view.rows[view.rows.length - 1];
		expect(last.key).toBe("n49999");
		expect(last.ancestors.length).toBe(49999);
		expect(last.ancestors[0]?.key).toBe("n0");
		expect(last.ancestors[49_998]?.key).toBe("n49998");
	});
});
