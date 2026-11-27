/**
 * Advisor notes (`card` role `omp.advisor`), one cell in:
 *
 * - `ⓘ Advisor` (bold, `customMessageLabel`) and a dim `N notes · K blockers`.
 * - Each note on a rail tinted by its severity (`error` blocker, `warning`
 *   concern, `muted` otherwise): `⟦severity⟧`, `T-n` and `[advisor]` lead its
 *   first row; paragraphs wrap at most 110 cells wide.
 * - Collapsed: the first three notes and a dim `… +N more notes` row, cut
 *   to `collapsedLines` rows when that is set (`display.advisorCollapsedLines`).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { AdvisorNote } from "../../../session/transcript/messages";
import { COLLAPSED_ADVISOR_NOTES, noteSource } from "../../transcript/messages/advisor-message";
import { termOf } from "./fill";
import { RowText, sliceText } from "../rendered-text";

/** Widest a note's text runs. */
const NOTE_LINE_WIDTH = 110;

function severityColor(severity: AdvisorNote["severity"]): string {
	return severity === "blocker" ? "error" : severity === "concern" ? "warning" : "muted";
}

/** `text` wrapped at `first` cells for its first row and `rest` after. */
function wrapVarying(text: string, first: number, rest: number): string[] {
	const head = wrap(text, first);
	if (head.length <= 1) return head;
	const line = head[0]!;
	const at = text.indexOf(line);
	if (at === -1) return wrap(text, rest);
	return [line, ...wrap(text.slice(at + line.length).trimStart(), rest)];
}

/** A note's rows behind its rail (and, on the first, its badges): each paragraph copies whole. */
function noteRows(theme: Theme, note: AdvisorNote, width: number, out: RowText): void {
	const symbols = theme.symbols;
	const color = severityColor(note.severity);
	const badge = note.severity
		? `${theme.fg(color, `${symbols.symbol("format.bracketLeft")}${note.severity}${symbols.symbol("format.bracketRight")}`)} `
		: "";
	const source = noteSource(note);
	const who = source ? `${theme.fg("dim", `[${replaceTabs(source)}]`)} ` : "";
	const age = note.turnsAgo !== undefined ? `${theme.fg("dim", `T-${note.turnsAgo}`)} ` : "";
	const railGlyph = symbols.symbol("advisor.rail");
	const rail = theme.fg(color, railGlyph);
	const quote = visibleWidth(`  ${railGlyph} `);
	const room = Math.min(NOTE_LINE_WIDTH, width);
	const first = Math.max(10, room - quote - visibleWidth(badge) - visibleWidth(age) - visibleWidth(who));
	const rest = Math.max(10, room - quote);
	const lead = `  ${railGlyph} `;
	note.note
		.split("\n")
		.filter(paragraph => paragraph.trim())
		.forEach((paragraph, index) => {
			const lines = index === 0 ? wrapVarying(paragraph, first, rest) : wrap(paragraph, rest);
			const badges = index === 0 ? `${badge}${age}${who}` : "";
			const rows = lines.map(
				(line, at) => `  ${rail} ${at === 0 ? badges : ""}${theme.fg("customMessageText", replaceTabs(line))}`,
			);
			out.prefixed(
				replaceTabs(paragraph),
				rows.map(row => truncate(row, width)),
				`${lead}${Bun.stripANSI(badges)}`,
				lead,
			);
		});
}

function paintAdvisor(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const term = termOf<{ notes: readonly AdvisorNote[]; expanded: boolean; collapsedLines?: number }>(node);
	const notes = term.notes ?? [];
	const inner = Math.max(1, cx.width - 2);
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const meta = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0) meta.push(theme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));
	const tag = theme.fg("customMessageLabel", `\x1b[1m${theme.symbols.symbol("status.info")} Advisor\x1b[22m`);
	const head = truncate(`${tag} ${theme.fg("dim", meta.join(" · "))}`, inner);
	const shown = term.expanded ? notes : notes.slice(0, COLLAPSED_ADVISOR_NOTES);
	const body = new RowText();
	for (const note of shown) noteRows(theme, note, inner, body);
	const hidden = notes.length - shown.length;
	if (hidden > 0) {
		const rail = theme.fg("dim", theme.symbols.symbol("advisor.rail"));
		body.deco(
			truncate(`  ${rail} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`, inner),
		);
	}
	const cap = term.expanded ? 0 : Math.max(0, Math.floor(term.collapsedLines ?? 0));
	const kept = cap > 0 && body.length > cap ? sliceText(body.done(), 0, cap) : body.done();
	const content = new RowText().literal(head).block(kept).done();
	return new RowText()
		.block(
			content,
			1,
			content.rows.map(row => ` ${row}`),
		)
		.done();
}

defineRolePainter("card", "omp.advisor", paintAdvisor);
