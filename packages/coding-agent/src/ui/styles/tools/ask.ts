/**
 * `ask`: answered questions in a muted frame headed `? Ask` (`⚠ Ask` when
 * the deadline answered), tinted by outcome. Each question in text color,
 * its answer after a check (3 rows collapsed, 10 expanded), option notes in
 * muted italics. Without answers: a plain `⚠ Ask` head over the dim
 * fallback text. Nothing while the call waits (the ask panel owns it).
 *
 * Reads {@link AskTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { AskTerm, AskTermAnswer } from "../../tools/ask";
import { capMoreLines, frameInner, frameRows, hangingWrap, outcomeBg, statusIcon, statusLine } from "./frame";
import { defineToolLook, isExpanded, toolProps } from "./look";

/** Answer and note rows shown collapsed / expanded. */
const COLLAPSED_ROWS = 3;
const EXPANDED_ROWS = 10;

function answerRows(theme: Theme, answer: AskTermAnswer, width: number, expanded: boolean): string[] {
	const limit = expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
	const rows = hangingWrap(" ", " ", theme.fg("text", answer.question), width);
	if (answer.shown === "") rows.push(`   ${theme.fg("dim", "(no answer)")}`);
	else {
		const prefix = ` ${theme.fg("success", theme.symbols.symbol("status.success"))} `;
		const indent = "   ";
		const lines = answer.shown
			.split("\n")
			.flatMap((line, index) =>
				hangingWrap(index === 0 ? prefix : indent, indent, theme.fg("toolOutput", line), width),
			);
		rows.push(...capMoreLines(theme, lines, limit, indent));
	}
	const notes: string[] = [];
	for (const note of answer.notes)
		notes.push(...hangingWrap("   ", "   ", `\x1b[3m${theme.fg("muted", note)}\x1b[23m`, width));
	rows.push(...capMoreLines(theme, notes, limit, "   "));
	return rows;
}

function paintAsk(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as Partial<AskTerm> | undefined;
	const theme = cx.theme;
	if (term?.fallback !== undefined) {
		const head = statusLine(theme, { glyph: statusIcon(cx, "warning"), title: "Ask" });
		const text = term.fallback ? `${head}\n${theme.fg("dim", term.fallback)}` : head;
		return { rows: wrap(text, cx.width) };
	}
	if (!term?.answers) return EMPTY_BLOCK;
	const width = cx.width;
	const inner = frameInner(width);
	const expanded = isExpanded(props);
	const content = term.answers.flatMap(answer => answerRows(theme, answer, inner, expanded));
	if (term.timedOut)
		content.push(...hangingWrap(" ", " ", theme.fg("dim", "auto-selected after timeout — not a user choice"), inner));
	const glyph = term.timedOut ? statusIcon(cx, "warning") : theme.fg("accent", theme.symbols.symbol("tool.ask"));
	return {
		rows: frameRows(theme, width, {
			head: statusLine(theme, { glyph, title: "Ask" }),
			sections: content.length > 0 ? [{ lines: content }] : [],
			border: "borderMuted",
			bg: outcomeBg(term.timedOut ? "warning" : "success"),
		}),
	};
}

defineToolLook("ask", { paint: paintAsk, margin: true });
