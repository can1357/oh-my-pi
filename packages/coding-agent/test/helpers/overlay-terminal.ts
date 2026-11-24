/**
 * An overlay view (picker, panel) on an in-memory terminal: mounted as a layer,
 * keyboard focus on its first node of `focusKind` (the overlay's focus target),
 * keys, pastes and mouse routed as the terminal backend routes them.
 */
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const DARK = loadThemeSync("dark");

/** The first node of `kind` under `node`, depth first. */
export function findKind(node: UiNode, kind: string): UiNode | undefined {
	if (node.kind === kind) return node;
	for (const child of node.children()) {
		const hit = findKind(child, kind);
		if (hit) return hit;
	}
	return undefined;
}

export interface OverlayTerminalOptions {
	readonly columns?: number;
	readonly rows?: number;
	/** Kind of the node holding focus (default `picker`; the root when none). */
	readonly focusKind?: string;
}

/** `view` as a layer on a dark-themed terminal, focused like its overlay. */
export function mountOverlay(view: () => JSXNode, options: OverlayTerminalOptions = {}): TestTerminal {
	const term = createTestTerminal(() => ({ layer: view() }), {
		columns: options.columns ?? 120,
		rows: options.rows ?? 40,
		theme: DARK,
	});
	const root = term.surface.layer()[0];
	term.focus((root && findKind(root, options.focusKind ?? "picker")) ?? root ?? null);
	return term;
}
