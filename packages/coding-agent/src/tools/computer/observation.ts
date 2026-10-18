/**
 * Where desktop input lands, so the worker knows which app's reaction to wait
 * for: the window each element ref was read from, and the window under a
 * desktop point.
 */
import type { DesktopDisplay, DesktopWindow } from "@oh-my-pi/pi-natives";

/** One `ax()` tree row: its indent and its ref. */
export interface TreeRow {
	indent: number;
	ref: string;
}

const ROW = /^((?: {2})*)- \S+/;
const REF = /^ \[ref=(e\d+)\]/;

/**
 * Read one row of the native tree grammar (`crates/pi-natives/src/desktop/ax.rs`
 * `format_tree`): pre-order, two spaces of indent per depth, then
 * `- role "label" [ref=eN]: "value" …`. Undefined for non-row lines (the walk's
 * trailers). The label is skipped as a quoted, backslash-escaped string, so a
 * label holding `[ref=e9]` cannot pass for the row's ref.
 */
export function parseTreeRow(line: string): TreeRow | undefined {
	const match = ROW.exec(line);
	if (!match) return undefined;
	let position = match[0].length;
	if (line.startsWith(' "', position)) {
		let index = position + 2;
		while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
		if (index >= line.length) return undefined;
		position = index + 1;
	}
	const ref = REF.exec(line.slice(position));
	if (!ref) return undefined;
	return { indent: match[1].length, ref: ref[1] };
}

/** Every ref a tree text names. */
export function treeRefs(text: string): string[] {
	const refs: string[] = [];
	for (const line of text.split("\n")) {
		const row = parseTreeRow(line);
		if (row) refs.push(row.ref);
	}
	return refs;
}

/** A window an input addressed, as far as the worker knows it. */
export interface InputWindow {
	id: string;
	pid?: number;
}

/** Most refs remembered for mapping an element back to its window. */
const MAX_REFS = 20_000;

/** The window each ref was read from, for elements resolved by ref alone. Oldest first, bounded. */
export class RefWindows {
	readonly #refs = new Map<string, InputWindow>();

	record(window: InputWindow, refs: Iterable<string>): void {
		for (const ref of refs) {
			this.#refs.delete(ref);
			this.#refs.set(ref, window);
		}
		for (const ref of this.#refs.keys()) {
			if (this.#refs.size <= MAX_REFS) break;
			this.#refs.delete(ref);
		}
	}

	windowOf(ref: string): InputWindow | undefined {
		return this.#refs.get(ref);
	}
}

/**
 * A desktop-root pointer position (pixels of the desktop's or display's latest screenshot) in
 * desktop coordinates, through the display regions that screenshot reported;
 * undefined when it falls outside them. Native pointer input maps it the same way.
 */
export function desktopPoint(
	displays: readonly DesktopDisplay[],
	point: { x: number; y: number },
): { x: number; y: number } | undefined {
	const display = displays.find(
		candidate =>
			point.x >= candidate.pixelX &&
			point.x < candidate.pixelX + candidate.pixelWidth &&
			point.y >= candidate.pixelY &&
			point.y < candidate.pixelY + candidate.pixelHeight,
	);
	if (!display) return undefined;
	return {
		x: display.x + ((point.x - display.pixelX) * display.width) / display.pixelWidth,
		y: display.y + ((point.y - display.pixelY) * display.height) / display.pixelHeight,
	};
}

/**
 * The topmost listed window containing a desktop point (native window lists
 * run front to back). An unfocused window covering a whole display is passed
 * over: system overlays list above app windows (the macOS Dock keeps a
 * transparent one over each display) and never take focus, so such a window
 * does not tell where input went. A focused one is a full-screen app.
 */
export function windowAt(
	windows: readonly DesktopWindow[],
	displays: readonly DesktopDisplay[],
	point: { x: number; y: number },
): DesktopWindow | undefined {
	return windows.find(
		window =>
			point.x >= window.x &&
			point.x < window.x + window.width &&
			point.y >= window.y &&
			point.y < window.y + window.height &&
			(window.focused ||
				!displays.some(
					display =>
						window.x <= display.x &&
						window.y <= display.y &&
						window.x + window.width >= display.x + display.width &&
						window.y + window.height >= display.y + display.height,
				)),
	);
}
