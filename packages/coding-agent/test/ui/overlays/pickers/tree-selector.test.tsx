/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { TreeSelector, type TreeSelectorNode } from "../../../../src/ui/overlays/pickers/tree-selector";
import { pickerSuite } from "./harness";

const userNode = (id: string, parentId: string | null, text: string, timestamp: number): TreeSelectorNode => ({
	entry: {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp },
	} as unknown as TreeSelectorNode["entry"],
	children: [],
});

function build(): { roots: TreeSelectorNode[]; leaf: string } {
	let n = 0;
	const user = (text: string, parentId: string | null): TreeSelectorNode => userNode(`e${n++}`, parentId, text, n);
	const asst = (text: string, parentId: string | null): TreeSelectorNode => ({
		entry: {
			type: "message",
			id: `e${n++}`,
			parentId,
			timestamp: "2026-01-01T00:00:00Z",
			message: { role: "assistant", content: [{ type: "text", text }], timestamp: n, stopReason: "stop" },
		} as unknown as TreeSelectorNode["entry"],
		children: [],
	});
	const root = user("hello world", null);
	const a = asst("hi there 日本語 ok", root.entry.id);
	root.children.push(a);
	const b1 = user("branch one with a long long long long long long long long prompt text", a.entry.id);
	const b2 = user("branch two", a.entry.id);
	a.children.push(b1, b2);
	const c = asst("answer two", b2.entry.id);
	b2.children.push(c);
	b1.label = "mark";
	return { roots: [root], leaf: c.entry.id };
}

const noop = (): void => {};

test("the ASCII tree paints fork guides and active-path bullets", () => {
	createRoot(dispose => {
		const { roots, leaf } = build();
		try {
			const [node] = resolveChildren(
				<TreeSelector roots={roots} currentLeafId={leaf} terminalHeight={30} onSelect={noop} onCancel={noop} />,
			)();
			const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
			const rows = paintNode(staticEnvironment(theme), node!, 120).rows.map(stripEscapes);
			expect(rows.find(row => row.includes("branch one"))).toContain("'- [mark] user: branch one");
			expect(rows.find(row => row.includes("branch two"))).toContain("|- * user: branch two");
		} finally {
			dispose();
		}
	});
});

test("a session thousands of entries deep opens on its newest entry", () => {
	// The rows were built recursively, one stack frame per entry: long sessions overflowed the stack.
	const depth = 20_000;
	const nodes = Array.from({ length: depth }, (_, i) => userNode(`e${i}`, i === 0 ? null : `e${i - 1}`, `prompt ${i}`, i));
	for (let i = 1; i < depth; i++) nodes[i - 1]!.children.push(nodes[i]!);
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<TreeSelector
					roots={[nodes[0]!]}
					currentLeafId={`e${depth - 1}`}
					terminalHeight={30}
					onSelect={noop}
					onCancel={noop}
				/>,
			)();
			const rows = paintNode(staticEnvironment(loadThemeSync("dark")), node!, 120).rows.map(stripEscapes);
			expect(rows.some(row => row.includes(`› • user: prompt ${depth - 1}`))).toBe(true);
		} finally {
			dispose();
		}
	});
});

pickerSuite({
	dir: "overlays/tree-selector",
	mount(caseName) {
		if (caseName === "empty")
			return {
				view: () => (
					<TreeSelector roots={[]} currentLeafId={null} terminalHeight={10} onSelect={noop} onCancel={noop} />
				),
			};
		const { roots, leaf } = build();
		return {
			view: () => (
				<TreeSelector
					roots={roots}
					currentLeafId={leaf}
					terminalHeight={30}
					onSelect={noop}
					onCancel={noop}
					sessionName="My session"
				/>
			),
			// The old card's filter tabs (keypath `filter`) are the picker's tabs: a tab click is `action tab`.
			steps: {
				"native select": d =>
					void d.emit({ type: "action", key: "picker", act: "tab", value: "user-only", mods: [] }),
				"native tab": d => void d.emit({ type: "action", key: "picker", act: "tab", value: "all", mods: [] }),
			},
		};
	},
});
