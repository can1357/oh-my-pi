/**
 * A question folded to a few rows in a text terminal, as the native ask card folds it
 * (`native/ask-card.ts`): its mark and question, then, under the question, its summary — the
 * typed answer, an empty field's placeholder, or its options as chips (up to {@link PILL_LIMIT},
 * the chosen ones always among them, then `+N`), a chosen one checked on the success tint, with
 * its note.
 *
 * @example
 * renderFoldedQuestion(
 * 	{ question: "Rollout?", answered: false, summary: { kind: "pills", more: "", pills } },
 * 	60,
 * );
 * // ["○ Rollout?", "   Behind a flag   Default on   Next minor   After a soak   +2 "] (chips on a tint)
 */
import { type FoldSummary, foldPills } from "../native/ask-card";
import { theme } from "../theme/theme";
import { Ellipsis, truncateToWidth, wrapTextWithAnsi } from "../utils";

/** What a folded question shows; the native card's `FoldedQuestion` without its pointer wiring. */
export interface FoldedRows {
	question: string;
	answered: boolean;
	error?: string | undefined;
	summary: FoldSummary;
}

/** Cells the summary and error sit in from the mark, under the question's text. */
const INDENT = "  ";

/**
 * Terminal rows an ask panel leaves to the rows under it: the folded composer and its borders, the
 * spacer and working row over it, the status line and some slack, so the live region never outgrows
 * the viewport.
 */
export const ASK_RESERVED_ROWS = 8;

/** `question` folded to its rows at `width`: the wrapped question, then its summary cut to one row. */
export function renderFoldedQuestion(question: FoldedRows, width: number): string[] {
	const mark = question.error
		? theme.fg("error", "!")
		: question.answered
			? theme.fg("success", "✓")
			: theme.fg("dim", "○");
	const inner = Math.max(1, width - INDENT.length);
	const lines = wrapTextWithAnsi(theme.fg("text", question.question), inner).map(
		(line, index) => `${index === 0 ? `${mark} ` : INDENT}${line}`,
	);
	const summary = summaryLine(question.summary);
	// One row, as the native fold: the open question shows the rest.
	if (summary) lines.push(`${INDENT}${truncateToWidth(summary, inner, Ellipsis.Unicode)}`);
	if (question.error) {
		lines.push(...wrapTextWithAnsi(theme.fg("error", question.error), inner).map(line => `${INDENT}${line}`));
	}
	return lines;
}

function summaryLine(summary: FoldSummary): string {
	switch (summary.kind) {
		case "answer":
			return `${theme.fg("muted", summary.text.replace(/\s+/g, " "))}${noteText(summary.note)}`;
		case "well":
			return theme.fg("dim", summary.placeholder);
		case "pills": {
			const { shown, hidden } = foldPills(summary.pills);
			// Chips on a tint, a chosen one on the success tint with its check, as the native pills.
			const chips = shown.map(pill =>
				pill.chosen
					? theme.bg("toolSuccessBg", theme.fg("success", ` ✓ ${pill.cut} `))
					: theme.bg("selectedBg", theme.fg("muted", ` ${pill.cut} `)),
			);
			if (hidden > 0) chips.push(theme.bg("selectedBg", theme.fg("dim", ` +${hidden} `)));
			const note = shown.some(pill => pill.chosen) ? noteText(summary.note) : "";
			return `${chips.join(" ")}${note}`;
		}
	}
}

function noteText(note: string | undefined): string {
	if (!note) return "";
	return theme.fg("dim", `  ✎ ${truncateToWidth(note, 60, Ellipsis.Unicode)}`);
}
