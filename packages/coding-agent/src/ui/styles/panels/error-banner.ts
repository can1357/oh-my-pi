/**
 * The error banner's terminal look: a blank row, an error-colored rule, the
 * message (the first line bold, every line indented under the `✘`, at most
 * four rows then a muted `… +N more lines` hint), the muted dismissal note,
 * and a closing rule.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { terminalPaddingX } from "../terminal-padding";

/** Message rows shown before the overflow hint. */
const MAX_ROWS = 4;

/** Terminal facts of the banner. */
export interface ErrorBannerTerm {
	/** The raw message (ANSI styling kept). */
	readonly message: string;
}

defineRolePainter("row", "omp.errorBanner", (node, cx): Block => {
	const theme = cx.theme;
	const term = (node.props() as { term?: ErrorBannerTerm }).term;
	const lines = (term?.message ?? "")
		.trim()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const inner = cx.width - 2 * paddingX;
	const textWidth = Math.max(1, inner - 2);
	const body: string[] = [];
	const headline = theme.style("strong", theme.fg("error", `✘ ${lines[0] ?? "Unknown error"}`));
	const hang = theme.style("strong", theme.fg("error", "  "));
	const headRows = wrap(headline, textWidth);
	headRows.forEach((row, index) => {
		body.push(`${pad}${index === 0 ? "" : hang}${row}`);
	});
	for (const line of lines.slice(1)) {
		for (const row of wrap(theme.fg("error", line), textWidth)) body.push(`${pad}  ${row}`);
	}
	const rule = theme.fg("error", theme.symbols.box.horizontal.repeat(cx.width));
	const rows = ["", rule, ...body.slice(0, MAX_ROWS)];
	if (body.length > MAX_ROWS) {
		// A cut headline leaves its bold open over the hint.
		const hint = theme.fg("dim", `  … +${body.length - MAX_ROWS} more lines (⌃O to expand)`);
		rows.push(`${pad}${headRows.length > MAX_ROWS ? theme.style("strong", hint) : hint}`);
	}
	for (const row of wrap(theme.fg("dim", "Dismissed when you send your next message."), inner)) {
		rows.push(pad + row);
	}
	rows.push(rule);
	return { rows };
});
