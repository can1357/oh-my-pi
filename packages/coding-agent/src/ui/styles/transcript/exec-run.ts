/**
 * User-run commands and cells (`tool` nodes with role `omp.bash` /
 * `omp.eval`): between two full-width rules in the run's mode color (dim
 * when excluded from context), the bold `$ command` or `>>> code` prompt,
 * a blank row and the output's tail (20 rows collapsed), then inline pictures
 * (or their linked placeholders). Once settled, the hidden-row count and notices.
 * The bottom rule carries the spinner and cancel hint while running, then the
 * exit code or `cancelled`.
 *
 * Reads the node's status, exit, collapsed and {@link ExecRunTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { imageRows } from "@oh-my-pi/pi-tui/term/painters/image";
import { spinnerIndex } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { appInterruptKeys } from "../../../config/keybindings/matchers";
import { terminalPaddingX } from "../terminal-padding";
import { expandKeyLabel, keyLabel } from "../../keys/hints";
import type { ExecRunTerm } from "../../transcript/exec-run";
import { imageLink } from "../tools/file-common";
import { toolProps } from "../tools/look";

/** Output rows a collapsed run shows. */
const PREVIEW_ROWS = 20;

/** A full-width rule with an optional label after three rule cells. */
function rule(theme: Theme, color: string, width: number, label?: string): string {
	const line = theme.symbols.box.horizontal;
	const lead = line.repeat(3);
	const room = width - visibleWidth(lead) - 3;
	if (!label || room < 1) return theme.fg(color, line.repeat(Math.max(1, width)));
	const fitted = ` ${truncate(label, room)} `;
	return `${theme.fg(color, lead)}${fitted}${theme.fg(color, line.repeat(Math.max(0, width - visibleWidth(lead) - visibleWidth(fitted))))}`;
}

function paintExecRun(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as unknown as ExecRunTerm;
	const theme = cx.theme;
	const width = cx.width;
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const inner = Math.max(1, width - 2 * paddingX);
	const padded = (text: string): string[] => wrap(text, inner).map(row => pad + row);
	const color = term.color;
	const expanded = props.collapsed === false;
	const running = props.status === "running";
	const rows = [rule(theme, color, width)];
	const source = props.command ?? "";
	if (term.kind === "bash") rows.push(...padded(theme.fg(color, `\x1b[1m$ ${source}\x1b[22m`)));
	else {
		const prompt = theme.fg(color, "\x1b[1m>>>\x1b[22m");
		const indent = theme.fg(color, "    ");
		const code = highlightCode(source, term.lang, theme);
		rows.push(...padded(code.map((line, i) => (i === 0 ? `${prompt} ${line}` : `${indent}${line}`)).join("\n")));
	}
	const lines = term.lines.map(line => (term.styled ? line : theme.fg("muted", line)));
	if (lines.length > 0) {
		const wrapped = lines.flatMap(line => {
			const parts = wrap(line, inner);
			return parts.length > 0 ? parts : [""];
		});
		const shown = expanded ? wrapped : wrapped.slice(-PREVIEW_ROWS);
		rows.push("", ...shown.map(row => pad + row));
	}
	const pictures = cx.images && term.images.length > 0 ? node.children().filter(child => child.kind === "image") : [];
	term.images.forEach((image, index) => {
		const label = theme.fg("muted", image);
		const picture = pictures[index];
		const drawn = picture && imageRows(picture, cx, label);
		if (drawn && drawn.state !== "fallback") rows.push(...drawn.rows);
		else rows.push(...padded(imageLink(cx, label, term.imageBlobs?.[index])));
	});
	if (!running) {
		const parts: string[] = [];
		const hidden = expanded ? 0 : Math.max(0, term.lines.length - PREVIEW_ROWS);
		if (hidden > 0) parts.push(theme.fg("dim", `… ${hidden} more lines (${expandKeyLabel(theme)} to expand)`));
		for (const notice of term.notices) parts.push(theme.fg(notice.color, notice.text));
		if (parts.length > 0) rows.push(...padded(`\n${parts.join("\n")}`));
	}
	let label: string | undefined;
	if (running) {
		const frames = theme.symbols.spinnerFrames;
		const frame = frames[spinnerIndex(cx, frames.length)]!;
		const interrupt = keyLabel(theme, appInterruptKeys()[0] ?? "escape");
		label = `${theme.fg(color, frame)} ${theme.fg("muted", `Running… (${interrupt} to cancel)`)}`;
	} else if (props.status === "cancelled") label = theme.fg("warning", "cancelled");
	else if (props.status === "error") label = theme.fg("error", `exit ${props.exit}`);
	rows.push(rule(theme, color, width, label));
	return { rows };
}

defineRolePainter("tool", "omp.bash", paintExecRun);
defineRolePainter("tool", "omp.eval", paintExecRun);
