/**
 * The session tree picker (`/tree`) on an in-memory terminal: built from
 * {@link TreeSelectorNode}s, the picker focused the way the overlay focuses it,
 * keys routed as the terminal backend routes them.
 */
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { TreeSelector, type TreeSelectorProps } from "../../src/ui/overlays/pickers/tree-selector";
import { mountOverlay } from "./overlay-terminal";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

export type TreeSelectorTestProps = Pick<TreeSelectorProps, "roots" | "currentLeafId"> &
	Partial<Omit<TreeSelectorProps, "roots" | "currentLeafId">>;

/** The tree picker over `props` (no-op callbacks unless given), its picker focused. */
export function mountTreeSelector(
	props: TreeSelectorTestProps,
	size: { columns?: number; rows?: number } = {},
): TestTerminal {
	const rows = size.rows ?? 40;
	return mountOverlay(
		() =>
			TreeSelector({
				terminalHeight: rows,
				onSelect: () => {},
				onCancel: () => {},
				router: InternalUrlRouter.builtins(),
				...props,
			}),
		{ columns: size.columns, rows },
	);
}

/** The tree picker's plain screen over `props`, joined by newlines. */
export function renderTreeSelector(props: TreeSelectorTestProps, size?: { columns?: number; rows?: number }): string {
	const term = mountTreeSelector(props, size);
	try {
		return term.screen().join("\n");
	} finally {
		term.dispose();
	}
}

/**
 * The tree's list rows as plain text, without the sheet's frame, header and
 * blank rows: what follows the cursor column (`› `), so a row reads
 * `  ├─ • user: text`.
 */
export function treeListRows(props: TreeSelectorTestProps, size?: { columns?: number; rows?: number }): string[] {
	const screen = renderTreeSelector(props, size).split("\n");
	const start = screen.findIndex(row => row.startsWith("├"));
	const end = screen.findIndex((row, index) => index > start && row.startsWith("╰"));
	return screen
		.slice(start + 1, end < 0 ? undefined : end)
		.map(row => row.slice(1, -1).trimEnd())
		.filter(row => row.trim() !== "");
}
