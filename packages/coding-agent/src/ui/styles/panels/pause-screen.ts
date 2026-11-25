/**
 * The pause screen's terminal look, centered on the fullscreen layer:
 *
 * - wide and tall enough: the session name, a big pause glyph, `P A U S E D`,
 *   what pausing means, the settlement status, the clock and the keys;
 * - otherwise a compact stack (`▌▌ P A U S E D`, clock, status, keys);
 * - when even that does not fit, the most important lines first (status,
 *   keys, session, title, clock), and on one row `Paused · ⎋ to resume`.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { formatDuration } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { keyLabel } from "../../keys/hints";
import { termOf } from "./common";
import { appInterruptKeys } from "../../../config/keybindings/matchers";

interface PauseTerm {
	readonly since: number;
	readonly session?: string;
	readonly work: { readonly unsettledTurns: number; readonly unfinishedJobs: number };
}

/** Narrowest screen that gets the full layout. */
const FULL_MIN_WIDTH = 64;
const GLYPH_ROWS = 7;
const GLYPH = "█████    █████";
const FACT_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
];

function center(text: string, width: number): string {
	const fitted = truncate(text, width);
	const lead = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2));
	return `${" ".repeat(lead)}${fitted}`;
}

function settlementLines(theme: Theme, term: Partial<PauseTerm>): string[] {
	const work = term.work ?? { unsettledTurns: 0, unfinishedJobs: 0 };
	if (work.unsettledTurns === 0 && work.unfinishedJobs === 0) {
		return [theme.fg("success", "Paused — ready to suspend")];
	}
	return [
		theme.fg("warning", "Pausing — waiting for work to settle"),
		theme.fg("muted", `Unsettled turns: ${work.unsettledTurns}`),
		theme.fg("muted", `Unfinished jobs: ${work.unfinishedJobs}`),
	];
}

defineRolePainter("col", "omp.pause", (node, cx): Block => {
	const theme = cx.theme;
	const width = cx.width;
	const height = cx.height ?? 24;
	const term = termOf<PauseTerm>(node);
	const session = term.session?.replace(/\s+/g, " ").trim();
	const clock = theme.fg("dim", `paused for ${formatDuration(cx.now() - (term.since ?? cx.now()), "clock")}`);
	const settlement = settlementLines(theme, term);
	const sessionLine = session ? theme.style("strong", session) : undefined;
	const interrupt = keyLabel(theme, appInterruptKeys()[0] ?? "escape");
	const lines: string[] = [];
	const full: string[] = [];
	if (sessionLine) full.push(center(sessionLine, width), "");
	for (let i = 0; i < GLYPH_ROWS; i++) full.push(center(theme.fg("accent", GLYPH), width));
	full.push("", center(theme.style("strong", theme.fg("accent", "P A U S E D")), width), "");
	const factWidth = Math.max(...FACT_LINES.map(visibleWidth));
	const factLead = " ".repeat(Math.max(0, Math.floor((width - factWidth) / 2)));
	for (const fact of FACT_LINES) full.push(`${factLead}${theme.fg("muted", fact)}`);
	for (const line of settlement) full.push(center(line, width));
	const resumeHint = `${interrupt} · ${keyLabel(theme, "enter")} · ${keyLabel(theme, "space")} — resume`;
	full.push(center(clock, width), "", center(theme.fg("dim", resumeHint), width));

	const title = center(theme.style("strong", theme.fg("accent", "▌▌ P A U S E D")), width);
	const resume = center(theme.fg("dim", `${interrupt} to resume`), width);
	const compact: string[] = [];
	if (sessionLine) compact.push(center(sessionLine, width));
	compact.push(title, "", center(clock, width), ...settlement.map(line => center(line, width)), resume);

	if (width >= FULL_MIN_WIDTH && full.length <= height) lines.push(...full);
	else if (compact.length <= height) lines.push(...compact);
	else if (height <= 1) {
		const settled = (term.work?.unsettledTurns ?? 0) === 0 && (term.work?.unfinishedJobs ?? 0) === 0;
		lines.push(
			center(
				theme.fg(settled ? "success" : "warning", `${settled ? "Paused" : "Pausing"} · ${interrupt} to resume`),
				width,
			),
		);
	} else {
		const ranked = [...settlement.map(line => center(line, width)), resume];
		if (sessionLine) ranked.push(center(sessionLine, width));
		ranked.push(title, center(clock, width));
		lines.push(...ranked.slice(0, height));
	}
	const top = Math.max(0, Math.floor((height - lines.length) / 2));
	const rows = Array.from({ length: height }, (_, i) => lines[i - top] ?? "");
	return { rows };
});
