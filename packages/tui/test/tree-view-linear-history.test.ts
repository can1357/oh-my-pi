import { beforeAll, describe, expect, test } from "bun:test";
import { getThemeByName, type Theme } from "../src/theme";
import { TreeView } from "../src/components/tree-view";

let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("dark theme unavailable");
	darkTheme = loaded;
});
interface Node {
	id: string;
	children: Node[];
}

function buildLinearTree(length: number): Node {
	const root: Node = { id: "0", children: [] };
	let current = root;
	for (let index = 1; index < length; index++) {
		const child: Node = { id: String(index), children: [] };
		current.children.push(child);
		current = child;
	}
	return root;
}

describe("TreeView", () => {
	test("keeps a 10,000-message linear history at one display depth without quadratic ancestor metadata", () => {
		const tree = new TreeView({
			roots: [buildLinearTree(10_000)],
			getKey: node => node.id,
			getChildren: node => node.children,
			getChildDepth: (_node, row) => row.depth,
			compactSameDepthAncestors: true,
			theme: darkTheme,
			renderRow: node => node.id,
		});

		expect(tree.rows).toHaveLength(10_000);
		expect(tree.rows.every(row => row.depth === 0 && row.ancestors.length === 0)).toBe(true);
	});

	test("retains a same-depth branch head needed to continue sibling gutters", () => {
		const continuation: Node = { id: "a2", children: [] };
		const firstBranch: Node = { id: "a", children: [continuation] };
		const secondBranch: Node = { id: "b", children: [] };
		const root: Node = { id: "root", children: [firstBranch, secondBranch] };
		const tree = new TreeView({
			roots: [root],
			getKey: node => node.id,
			getChildren: node => node.children,
			getChildDepth: (_node, row, children) => (children.length > 1 ? row.depth + 1 : row.depth),
			compactSameDepthAncestors: true,
			theme: darkTheme,
			renderRow: node => node.id,
		});

		const continuationRow = tree.rows.find(row => row.key === "a2");
		expect(continuationRow?.ancestors.at(-1)).toMatchObject({ key: "a", isLast: false, siblingCount: 2 });
	});
});
