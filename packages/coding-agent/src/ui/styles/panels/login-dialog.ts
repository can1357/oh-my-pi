/**
 * The sign-in flow in the terminal: a box titled `Login to <provider>` with
 * the flow as it happened — the sign-in link (accented, every wrapped row a
 * link to it), how to open it, instructions, prompts with their fields and
 * answers, waits and progress (dim).
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { LoginPiece } from "../../overlays/panels/login-dialog";
import { boxRows, termOf } from "./common";

const link = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

defineRolePainter("col", "omp.login", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 6) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const term = termOf<{ title: string; pieces: readonly LoginPiece[]; caret: boolean }>(node);
	const content: string[] = [];
	for (const piece of term.pieces ?? []) {
		switch (piece.kind) {
			case "spacer":
				content.push("");
				break;
			case "url":
				for (const row of wrap(piece.url, inner)) content.push(theme.fg("accent", link(piece.url, row)));
				break;
			case "text": {
				for (const row of wrap(
					theme.fg(piece.style, piece.href ? link(piece.href, piece.text) : piece.text),
					inner,
				)) {
					content.push(row);
				}
				break;
			}
			case "field": {
				const raw = piece.field.text();
				const text = piece.field.secret ? "•".repeat([...raw].length) : raw;
				const cursor = piece.field.cursor();
				content.push(term.caret ? `> ${inputLine(text, cursor, inner - 2, "").trimEnd()}` : `> ${text}`);
				const error = piece.field.error();
				if (error) content.push(...wrap(theme.fg("error", error), inner));
				break;
			}
		}
	}
	return { rows: boxRows(theme, term.title ?? "", content, cx.width) };
});
