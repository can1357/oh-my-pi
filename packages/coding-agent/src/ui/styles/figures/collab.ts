/**
 * Collaboration blocks.
 *
 * - `card` `omp.user.collab`: ` «sender» ›` (accent, the sender bold) over
 *   the prompt as a user bubble.
 * - `col` `omp.collab.qrcode`: the symbol in black on white, one cell in;
 *   when the width or the viewport allocation cannot hold it whole, one row
 *   instead: the `Join` link and why the code is hidden (warning), cut to
 *   the width.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { CollabPromptTerm, CollabQrTerm } from "../../transcript/figures/collab";
import { bubbleRows } from "../messages/user";
import { termOf } from "../messages/fill";
import { RowText } from "../rendered-text";

function paintCollabPrompt(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const sender = termOf<CollabPromptTerm>(node).sender ?? "guest";
	const head = ` ${theme.fg("accent", `\x1b[1m«${sender}»\x1b[22m ›`)}`;
	const prompt = node.children().find(child => child.kind === "md");
	const out = new RowText().literal(truncate(head, cx.width));
	if (prompt) out.block(bubbleRows(cx, prompt, cx.width));
	return out.done();
}

const QR_OPEN = "\x1b[47m\x1b[30m";
const QR_CLOSE = "\x1b[0m";

function paintQrCode(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const { url = "", rows = [] } = termOf<CollabQrTerm>(node);
	const need = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 0) + 1;
	const reason =
		cx.width < need
			? `terminal width ${cx.width}; need ${need}`
			: cx.height !== undefined && cx.height < rows.length
				? `viewport height ${cx.height}; need ${rows.length}`
				: undefined;
	if (reason === undefined) return { rows: rows.map(row => ` ${QR_OPEN}${row}${QR_CLOSE}`) };
	if (cx.height === 0) return EMPTY_BLOCK;
	const label = theme.fg("accent", "\x1b[4mJoin\x1b[24m");
	const join = cx.hyperlinks ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;
	return { rows: [truncate(`${join} ${theme.fg("warning", `QR code hidden: ${reason}.`)}`, cx.width, "")] };
}

defineRolePainter("card", "omp.user.collab", paintCollabPrompt);
defineRolePainter("col", "omp.collab.qrcode", paintQrCode);
