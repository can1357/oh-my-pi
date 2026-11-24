/**
 * Terminal look of the role-cycle track (`row` `omp.track`): a blank row,
 * then the inset labels in their colors joined by a thin `┆`
 * (`statusLineSep`); the active one (`omp.track.active`) is a powerline chip:
 * caps in its color around ` label ` filled with it, the label bold in black
 * or white by the fill's luma. Two spaces part the chip from its neighbours.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { terminalPaddingX } from "../terminal-padding";
import { propsOf } from "../messages/fill";

/** `text` on a fill of foreground color `color`, in black or white by the fill's luma (Rec. 601). */
function chipFill(theme: Theme, color: string, text: string): string {
	const value = Number.parseInt(theme.hex(color).replace("#", ""), 16);
	const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
	const luma = 0.299 * r + 0.587 * g + 0.114 * b;
	const fg = luma > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	return `\x1b[48;2;${r};${g};${b}m${fg}${text}\x1b[39m\x1b[49m`;
}

function paintTrack(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const symbols = theme.symbols;
	const thin = theme.fg("statusLineSep", symbols.symbol("sep.powerlineThin"));
	const items = node.children().map(child => {
		const props = propsOf<{ spans: readonly TspSpan[]; role: string }>(child);
		const span = props.spans?.[0];
		return {
			label: span?.t ?? "",
			color: span?.s ?? "accent",
			active: props.role === "omp.track.active",
		};
	});
	let track = "";
	items.forEach((item, index) => {
		if (index > 0) track += item.active || items[index - 1]!.active ? "  " : ` ${thin} `;
		if (!item.active) {
			track += theme.fg(item.color, item.label);
			return;
		}
		const chip = chipFill(theme, item.color, theme.style("strong", ` ${item.label} `));
		track += `${theme.fg(item.color, symbols.symbol("sep.powerlineRight"))}${chip}${theme.fg(item.color, symbols.symbol("sep.powerlineLeft"))}`;
	});
	const paddingX = terminalPaddingX();
	return { rows: ["", " ".repeat(paddingX) + truncate(track, Math.max(1, cx.width - 2 * paddingX))] };
}

defineRolePainter("row", "omp.track", paintTrack);
