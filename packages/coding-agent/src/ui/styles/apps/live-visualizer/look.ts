/**
 * `omp.app.live`: the call panel in the terminal. A rounded border box (sharp
 * below four cells) around two spectrum rows and the transcript row (cut from
 * its start, in `accent`); the bottom edge carries the status and key hints
 * (` ● listening · ␣ mute · ⎋ end `, just the status when that does not fit)
 * in the phase's color. The spectrum is two rows of eighth-blocks whose
 * heights follow the call energy, a carrier and a shimmer wave advanced by
 * the frame counter; the working phase's spinner also steps with the frame.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, truncate, truncateStart, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspTextProps } from "@oh-my-pi/pi-wire";
import type { LiveCardTerm } from "../../../apps/live-visualizer/live-visualizer";
import { type LivePhase, PHASE_COLORS, PHASE_ICONS } from "../../../apps/live-visualizer/model";

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPECTRUM_ROWS = 2;

/** Spectrum rows `width` cells wide at `frame` for `energy` (0..1). */
function spectrum(frame: number, energy: number, width: number): string[] {
	const steps = BLOCKS.length - 1;
	const rows = Array.from({ length: SPECTRUM_ROWS }, () => "");
	for (let column = 0; column < width; column++) {
		const carrier = 0.5 + 0.5 * Math.sin(frame * 0.43 + column * 0.71);
		const shimmer = 0.5 + 0.5 * Math.sin(frame * 0.19 - column * 1.17);
		const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * SPECTRUM_ROWS * steps);
		for (let row = 0; row < SPECTRUM_ROWS; row++) {
			const above = (SPECTRUM_ROWS - row - 1) * steps;
			rows[row] += BLOCKS[Math.max(0, Math.min(steps, height - above))];
		}
	}
	return rows;
}

function transcriptOf(card: UiNode): string {
	const text = card.children().find(child => child.kind === "text");
	return ((text?.props() as TspTextProps | undefined)?.spans ?? []).map(span => span.t).join("");
}

defineRolePainter("card", "omp.app.live", (node, cx): Block => {
	const theme = cx.theme;
	const facts = (node.props() as { term?: LiveCardTerm }).term;
	const phase = (facts?.phase ?? "connecting") as LivePhase;
	const frame = facts?.frame ?? 0;
	const width = Math.max(2, cx.width);
	const round = width >= 4;
	const inner = round ? width - 4 : width - 2;
	const border = (text: string) => theme.fg("border", text);
	const color = phase === "muted" ? "dim" : phase === "error" ? "error" : "success";
	const transcript = truncateStart(transcriptOf(node), inner);
	const body = [
		...spectrum(frame, facts?.energy ?? 0, inner).map(row => theme.fg(color, row)),
		`${theme.fg("accent", transcript)}${" ".repeat(Math.max(0, inner - visibleWidth(transcript)))}`,
	];
	const box = round
		? theme.symbols.box
		: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" };
	const right = width > 1;
	const rows = [border(`${box.topLeft}${box.horizontal.repeat(width - 2)}${right ? box.topRight : ""}`)];
	for (const row of body) {
		rows.push(
			round
				? `${border(box.vertical)} ${padTo(row, inner)} ${border(box.vertical)}`
				: `${border(box.vertical)}${row}${right ? border(box.vertical) : ""}`,
		);
	}
	const frames = theme.symbols.spinnerFrames;
	const icon = phase === "working" && frames.length > 0 ? frames[frame % frames.length] : PHASE_ICONS[phase];
	const status = `${icon} ${phase}`;
	const edge = width - 2;
	const full = ` ${status} · ␣ mute · ⎋ end `;
	const short = ` ${status} `;
	const label = edge >= visibleWidth(full) + 1 ? full : edge >= visibleWidth(short) + 1 ? short : "";
	const corner = right ? box.bottomRight : "";
	if (label === "") rows.push(border(`${box.bottomLeft}${box.horizontal.repeat(edge)}${corner}`));
	else {
		const fill = Math.max(0, edge - visibleWidth(label) - 1);
		rows.push(
			`${border(`${box.bottomLeft}${box.horizontal}`)}${theme.fg(PHASE_COLORS[phase], truncate(label, edge - 1))}${border(`${box.horizontal.repeat(fill)}${corner}`)}`,
		);
	}
	return { rows };
});
