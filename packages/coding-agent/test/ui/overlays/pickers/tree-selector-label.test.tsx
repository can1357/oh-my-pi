/** @jsxImportSource @oh-my-pi/pi-tui */
/** A tree row's text as Tern is sent it: one line, each line break of the entry a space (a blank line: two). */
import { expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { TreeSelector, type TreeSelectorNode } from "../../../../src/ui/overlays/pickers/tree-selector";

test("a tree row keeps the entry's blank line as two spaces and expands its tabs", () => {
	const root: TreeSelectorNode = {
		entry: {
			type: "message",
			id: "e0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "# Parity answer\n\nA paragraph\r\nnext\x07" }],
				timestamp: 1,
				stopReason: "stop",
			},
		} as unknown as TreeSelectorNode["entry"],
		children: [],
	};
	const term = createTestTerminal(
		() => ({
			layer: (
				<TreeSelector
					roots={[root]}
					currentLeafId="e0"
					terminalHeight={30}
					onSelect={() => {}}
					onCancel={() => {}}
				/>
			),
		}),
		{ columns: 80, rows: 30 },
	);
	try {
		term.render();
		const find = (at: UiNode): UiNode | undefined =>
			at.kind === "picker"
				? at
				: at
						.children()
						.map(find)
						.find(found => found !== undefined);
		const items = (find(term.surface.layer()[0]!)!.props() as { items: readonly TspPickerItem[] }).items;
		const label = items[0]!.label;
		const text = typeof label === "string" ? label : label.map(span => span.t).join("");
		expect(text).toEndWith("# Parity answer  A paragraph  next");
	} finally {
		term.dispose();
	}
});
