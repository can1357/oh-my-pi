/**
 * `/copy`'s terminal look (`term.look = "omp.copy"`): the transcript
 * selectors' screen (`./transcript-view`) headed `⧉ Copy · pick what to put
 * on the clipboard` (or the caller's title), the outlined turn boxed in green
 * with `N blocks →` on its top edge when it has blocks, then the key hints.
 *
 * Descended into its blocks, the turn shows each block under a caption
 * (`i/n · label · N lines  ⧉ copy  ↗ open`), the focused one boxed; the
 * wheel scrolls the view.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, type PickerTerm, sheetHit } from "@oh-my-pi/pi-tui/term/painters/picker";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { expandKeyLabel } from "../../keys/hints";
import { termOf } from "../panels/common";
import { type LaneItem, laneRows, transcriptScreen, wheelTranscriptView } from "./transcript-view";

/** One turn as the look draws it. */
export type CopyLookTurn = {
	/** The turn's transcript blocks. */
	readonly blocks: readonly UiNode[];
	readonly outlined: boolean;
	/** Inner blocks → descends into. */
	readonly count: number;
};

/** One inner block while descended. */
export type CopyLookBlock = {
	/** `label · N lines`. */
	readonly caption: string;
	/** The block's content (its head when long). */
	readonly body: readonly UiNode[];
	readonly focused: boolean;
	/** A link `o` opens. */
	readonly link: boolean;
};

/** The look's term facts. */
export type CopyLookTerm = PickerTerm & {
	/** Terminal role (`omp.copy`): the wheel widget. */
	readonly role: string;
	/** The caller's heading (default `⧉ Copy · pick what to put on the clipboard`). */
	readonly heading?: string;
	readonly turns: readonly CopyLookTurn[];
	/** The selected turn's blocks while descended (drawn in its place). */
	readonly descended?: { readonly at: number; readonly blocks: readonly CopyLookBlock[] };
	/** `i/n` of the outlined turn or block; empty without turns. */
	readonly counter: string;
	/** The pick verb. */
	readonly action: string;
	/** Links open (`o`, `↗ open`). */
	readonly opens: boolean;
	readonly truncated: boolean;
	/** Screen rows when the layer allots no height. */
	readonly screenRows?: number;
};

/**
 * The descended turn in a lane `width` cells wide: each block a blank row
 * then its caption (cut to leave its actions whole), the focused one's
 * content boxed, a blank row after.
 */
function blockItems(
	term: Partial<CopyLookTerm>,
	cx: PaintContext,
	blocks: readonly CopyLookBlock[],
	width: number,
): LaneItem[] {
	const theme = cx.theme;
	const items = blocks.map((block, index): LaneItem => {
		const actions = `  ${theme.style("accent", `⧉ ${term.action}`)}${block.link && term.opens ? `  ${theme.style("accent", "↗ open")}` : ""}`;
		const caption = truncate(`${index + 1}/${blocks.length} · ${block.caption}`, width - 4 - visibleWidth(actions));
		return {
			lead: ["", `${theme.style(block.focused ? "success" : "dim", caption)}${actions}`],
			blocks: block.body,
			outlined: block.focused,
		};
	});
	items.push({ lead: [""], blocks: [], outlined: false });
	return items;
}

function paintCopy(node: UiNode, cx: PaintContext): Block {
	const term = termOf<CopyLookTerm>(node);
	const theme = cx.theme;
	const width = cx.width;
	if (!term.turns || width < 8) return { rows: [] };
	const descended = term.descended;
	const items = term.turns.flatMap((turn, index): LaneItem[] =>
		descended?.at === index
			? blockItems(term, cx, descended.blocks, width - 1)
			: [
					{
						blocks: turn.blocks,
						outlined: turn.outlined,
						label:
							turn.outlined && turn.count > 0
								? ` ${turn.count} block${turn.count === 1 ? "" : "s"} → `
								: undefined,
					},
				],
	);
	const focused = descended?.blocks.find(block => block.focused);
	const hints = descended
		? [
				term.counter,
				"↑/↓ block",
				"←/⎋ back",
				`⏎ ${term.action}`,
				focused?.link && term.opens ? "o open" : "",
				"click ⧉/↗",
			]
		: [
				term.counter,
				"↑/↓ step",
				term.turns.some(turn => turn.outlined && turn.count > 0) ? "→ blocks" : "",
				`⏎ ${term.action}`,
				term.truncated ? "a earlier turns" : "",
				`${expandKeyLabel(theme)} expand`,
				"⎋ close",
			];
	const head = term.heading
		? ` ${theme.style("strong", term.heading)}`
		: ` ⧉ ${theme.style("strong", "Copy")} · ${theme.style("dim", "pick what to put on the clipboard")}`;
	const screen = transcriptScreen(node, cx, {
		head,
		body: laneRows(cx, items, width - 1, "success"),
		footer: ` ${theme.style("dim", hints.filter(Boolean).join("  "))}`,
		rows: term.screenRows,
	});
	return { ...screen, hits: [sheetHit(node, width, screen.rows.length)] };
}

definePickerLook("omp.copy", paintCopy);

/** The wheel scrolls the view (the selection stays). */
defineRoleWidget("picker", "omp.copy", {
	mouse(node, mouse) {
		if (mouse.action !== "press" || (mouse.button !== "wheel-up" && mouse.button !== "wheel-down")) return false;
		wheelTranscriptView(node, mouse.button === "wheel-up" ? -1 : 1);
		return true;
	},
});
