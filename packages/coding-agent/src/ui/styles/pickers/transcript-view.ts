/**
 * The transcript selectors' screen (`/rewind`, `/copy`): a rule, the head, a
 * rule, the branch as the transcript draws it, the hint row and a closing
 * rule, filling the screen.
 *
 * - Turns are their transcript blocks two cells in; the outlined one sits in
 *   a dotted box instead (an optional label at the right of its top edge),
 *   its trailing blank rows left below the box.
 * - The body scrolls just far enough to show the outline, with context when
 *   it fits. A taller outline keeps the window within the selected turn:
 *   reached from above (and at open) it shows its end, from below its top,
 *   and the wheel scrolls three rows a notch up to its edges. A scrollbar
 *   takes the last column while the body overflows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { pickerState } from "@oh-my-pi/pi-tui/term/painters/picker";
import { SgrState } from "@oh-my-pi/pi-tui/text/ansi";
import { padTo, sliceCells, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import "../messages";
import "../tools";
import "../transcript/read-group";

/** One turn (or a piece of one) in a lane. */
export type LaneItem = {
	/** Rows drawn as they are above the blocks, never boxed (a caption, a blank row). */
	readonly lead?: readonly string[];
	/** Transcript blocks, in order. */
	readonly blocks: readonly UiNode[];
	readonly outlined: boolean;
	/** Text at the right end of the outline's top edge. */
	readonly label?: string;
};

/** Rows of a lane and where its outline box sits (`[start, end)`). */
export interface Lane {
	readonly rows: string[];
	readonly outline?: readonly [number, number];
}

/** Rows a wheel notch scrolls. */
const WHEEL_ROWS = 3;
/** Rows of context kept on each side of the outline when there is room. */
const OUTLINE_CONTEXT = 1;

/**
 * `items` in a lane `width` cells wide: blocks painted `width - 4` wide two
 * cells in, the outlined item's blocks boxed in `color` instead (`┆ block ┆`,
 * the box spanning the lane) with its trailing blank rows under the box.
 */
export function laneRows(cx: PaintContext, items: readonly LaneItem[], width: number, color: string): Lane {
	const theme = cx.theme;
	const inner = Math.max(1, width - 4);
	const rows: string[] = [];
	let outline: [number, number] | undefined;
	for (const item of items) {
		for (const row of item.lead ?? []) rows.push(padTo(`  ${row}`, width - 2));
		const blocks = item.blocks.flatMap(block => cx.paint(block, inner).rows);
		if (!item.outlined) {
			for (const row of blocks) rows.push(padTo(`  ${row}`, width - 2));
			continue;
		}
		let end = blocks.length;
		while (end > 0 && blocks[end - 1]!.trim() === "") end--;
		const label = item.label ?? "";
		const edge = (corner: string, text: string) =>
			`${theme.style(color, `${corner}${"┄".repeat(Math.max(0, width - 2 - visibleWidth(text)))}`)}${theme.style(`strong ${color}`, text)}`;
		const side = theme.style(color, "┆");
		const start = rows.length;
		rows.push(`${edge("╭", label)}${theme.style(color, "╮")}`);
		for (const row of blocks.slice(0, end)) rows.push(`${side} ${padTo(row, inner)} ${side}`);
		rows.push(`${edge("╰", "")}${theme.style(color, "╯")}`);
		outline = [start, rows.length];
		for (let blank = end; blank < blocks.length; blank++) rows.push("");
	}
	return { rows, outline };
}

/** Scroll `node`'s transcript view a wheel notch up (`-1`) or down (`1`). */
export function wheelTranscriptView(node: UiNode, notches: -1 | 1): void {
	const wheel = pickerState<number>(node, "transcript.wheel", () => 0);
	wheel.set(wheel.peek() + notches * WHEEL_ROWS);
}

/**
 * `body` in `height` rows of `width` cells: all of it (blank rows below)
 * when it fits, else the last window moved by the wheel and clamped to
 * keep as much of the outline visible as possible, with a scrollbar.
 */
function bodyWindow(node: UiNode, cx: PaintContext, body: Lane, width: number, height: number): string[] {
	const theme = cx.theme;
	const rows = body.rows;
	const wheel = pickerState<number>(node, "transcript.wheel", () => 0)();
	if (rows.length <= height) {
		const out = rows.map(row => truncate(row, width, ""));
		while (out.length < height) out.push("");
		return out;
	}
	// Where the view was last drawn from, at whatever width (the painter's own output, so untracked).
	const drawn = pickerState<{ start: number; wheel: number }>(node, "transcript.scroll", () => ({
		start: 0,
		wheel,
	}));
	const last = drawn.peek();
	let start = last.start + wheel - last.wheel;
	if (body.outline) {
		const [top, bottom] = body.outline;
		const tail = bottom - height;
		if (top < tail) {
			// A tall outline contains the window. The wheel stops at its edges; a
			// window left outside it by a selection change lands on the far edge,
			// so moving down opens a turn on its end and moving up on its top.
			const wheeled = wheel !== last.wheel;
			if (start < top) start = wheeled ? top : tail;
			else if (start > tail) start = wheeled ? tail : top;
		} else {
			// A short outline fits inside the window with context around it.
			const context = Math.min(OUTLINE_CONTEXT, Math.floor((top - tail) / 2));
			start = Math.max(tail + context, Math.min(start, top - context));
		}
	}
	const max = rows.length - height;
	start = Math.max(0, Math.min(start, max));
	drawn.set({ start, wheel });
	const thumb = Math.max(1, Math.min(height, Math.floor((height * height) / rows.length)));
	const thumbTop = Math.round((start / max) * (height - thumb));
	const inner = Math.max(0, width - 1);
	const out: string[] = [];
	for (let row = 0; row < height; row++) {
		const line = rows[start + row]!;
		const bar = row >= thumbTop && row < thumbTop + thumb ? theme.style("accent", "█") : theme.style("dim", "│");
		// A row cut short (a wide fork) runs its fill on under the scrollbar.
		const fill =
			visibleWidth(line) > inner ? new SgrState().feed(sliceCells(line, 0, inner).text).background : undefined;
		out.push(`${truncate(line, inner, "", true)}${fill === undefined ? bar : `${fill}${bar}\x1b[49m`}`);
	}
	return out;
}

/**
 * The whole screen: rules around `head`, the body windowed to the screen
 * (`cx.height`, else `rows`; natural height without either), the `footer`
 * row and a closing rule.
 */
export function transcriptScreen(
	node: UiNode,
	cx: PaintContext,
	screen: { readonly head: string; readonly body: Lane; readonly footer: string; readonly rows?: number },
): Block {
	const theme = cx.theme;
	const width = cx.width;
	const rule = theme.style("border", "─".repeat(width));
	const height = cx.height ?? screen.rows;
	const rows = [rule, truncate(screen.head, width, theme.symbols.ellipsis), rule];
	if (height === undefined) rows.push(...screen.body.rows.map(row => truncate(row, width, "")));
	else rows.push(...bodyWindow(node, cx, screen.body, width, Math.max(1, height - 5)));
	rows.push(truncate(screen.footer, width, theme.symbols.ellipsis), rule);
	return { rows };
}
