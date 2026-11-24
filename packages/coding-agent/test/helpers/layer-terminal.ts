/**
 * One overlay view (a picker, a hub, a dialog) mounted as a layer on a
 * scripted pi-tui terminal, driven by raw input bytes the way a terminal
 * delivers them and read back as painted rows.
 */
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { fullscreenMenuView } from "../../src/modes/controllers/selector-views";

export interface LayerTerminal {
	readonly term: TestTerminal;
	/** Painted rows with escapes (the fullscreen screen while one is up), after resizing to `width` when given. */
	render(width?: number): string[];
	/** Painted rows, escapes stripped and trailing blanks trimmed. */
	lines(width?: number): string[];
	/** {@link lines} joined. */
	text(width?: number): string;
	/** Feed raw input bytes: one key sequence, an SGR mouse report, or plain text typed key by key. */
	handleInput(raw: string): void;
	/** Press keys by id (`enter`, `j`, `ctrl+o`). */
	press(...ids: string[]): void;
	dispose(): void;
}

export function firstOfKind(node: UiNode, kind: string): UiNode | null {
	if (node.kind === kind) return node;
	for (const child of node.children()) {
		const found = firstOfKind(child, kind);
		if (found) return found;
	}
	return null;
}

/**
 * Mount `view` as a layer under the active theme and focus its first
 * `focusKind` node (default `picker`), else the view's root. `fullscreen`
 * wraps it in the full-size app-screen overlay fullscreen menus open in.
 */
export function mountLayer(
	view: () => JSXNode,
	options: {
		columns?: number;
		rows?: number;
		focusKind?: string;
		fullscreen?: boolean;
	} = {},
): LayerTerminal {
	let columns = options.columns ?? 120;
	const rows = options.rows ?? 40;
	const layerView = options.fullscreen ? () => fullscreenMenuView("screen", view()) : view;
	const term = createTestTerminal(() => ({ layer: layerView() }), {
		columns,
		rows,
		theme: currentTheme(),
	});
	const layer = term.surface.layer()[0];
	const root = layer && options.fullscreen ? (layer.children()[0] ?? layer) : layer;
	term.focus(root ? (firstOfKind(root, options.focusKind ?? "picker") ?? root) : null);
	const render = (width?: number): string[] => {
		if (width !== undefined && width !== columns) {
			columns = width;
			term.resize(width, rows);
		}
		term.render();
		return [...(term.fullscreen() ?? term.rows())];
	};
	const lines = (width?: number): string[] => render(width).map(row => stripEscapes(row).trimEnd());
	return {
		term,
		render,
		lines,
		text: width => lines(width).join("\n"),
		handleInput(raw) {
			const pointer = raw.startsWith("\x1b[<") ? decodeMouse(raw) : null;
			if (pointer) {
				term.mouse(pointer);
				return;
			}
			if (!raw.startsWith("\x1b") && [...raw].length > 1) {
				term.type(raw);
				return;
			}
			const key = decodeKey(raw, { kitty: true, backspaceIsCtrl: false });
			if (!key) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
			term.press(key.id, { text: key.text, kind: key.kind });
		},
		press(...ids) {
			for (const id of ids) term.press(id);
		},
		dispose: () => term.dispose(),
	};
}

/** Whether `raw` paints `text` right after the SGR `sgr` (other attributes may sit between). */
export function paintedIn(raw: string, sgr: string, text: string): boolean {
	const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped(sgr)}(?:\\x1b\\[[0-9;]*m)*${escaped(text)}`).test(raw);
}
