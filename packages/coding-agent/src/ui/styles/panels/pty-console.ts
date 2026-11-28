/**
 * `omp.overlay.console`: the interactive console in the terminal. One rounded
 * box at the screen's width: the status glyph, `Console`, the command and
 * the run's state; the PTY screen on the tool-output color; then what Escape
 * does while the program runs, or that the session finished.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, replaceTabs, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { keyLabel } from "../../keys/hints";
import type { PtyConsoleState } from "../../overlays/panels/pty-console";
import { styleReplayedRow } from "../../transcript/pty-replay";
import { termOf } from "./common";

/** What the console's box draws. */
export type PtyConsoleTerm = {
	readonly command: string;
	readonly state: PtyConsoleState;
	readonly exitCode: number | undefined;
	/** The visible PTY rows (SGR kept). */
	readonly screen: readonly string[];
};

/** How a run's state reads, and the color it reads in. */
export function consoleStateLabel(
	state: PtyConsoleState,
	exitCode: number | undefined,
): { readonly tone: string; readonly text: string } {
	if (state === "running") return { tone: "warning", text: "running" };
	if (state === "timed_out") return { tone: "warning", text: "timed out" };
	if (state === "killed") return { tone: "warning", text: "killed" };
	if (exitCode === 0) return { tone: "success", text: "exit 0" };
	if (exitCode === undefined) return { tone: "warning", text: "exited" };
	return { tone: "error", text: `exit ${exitCode}` };
}

defineRolePainter("col", "omp.overlay.console", (node, cx): Block => {
	const theme = cx.theme;
	const term = termOf<PtyConsoleTerm>(node);
	const state = term.state ?? "running";
	const inner = Math.max(1, Math.max(20, cx.width) - 2);
	const symbol = (key: string, color: string): string => theme.fg(color, theme.symbols.symbol(key));
	const icon =
		state === "running"
			? symbol("status.running", "accent")
			: state === "complete" && term.exitCode === 0
				? symbol("tool.bash", "accent")
				: symbol("status.warning", "warning");
	const label = consoleStateLabel(state, term.exitCode);
	const prefix = `${icon} ${theme.fg("accent", "Console")} `;
	const suffix = ` ${symbol("format.bracketLeft", "dim")}${theme.fg(label.tone, label.text)}${symbol("format.bracketRight", "dim")}`;
	const command = truncate(
		theme.fg("muted", replaceTabs(term.command ?? "")),
		Math.max(1, inner - visibleWidth(prefix) - visibleWidth(suffix)),
	);
	const footer =
		state === "running"
			? `${theme.fg("warning", keyLabel(theme, "escape"))} ${theme.fg("dim", "force-kill")} ${theme.fg("dim", "· input forwarded to PTY")}`
			: theme.fg("dim", "session finished");
	const output = theme.fg("toolOutput", "\u0000").split("\u0000")[0] ?? "";
	const screen = (term.screen ?? []).map(row => truncate(styleReplayedRow(row, output), inner));
	const box = theme.symbols.box;
	const edge = theme.fg("border", box.vertical);
	const rule = theme.fg("border", box.horizontal.repeat(inner));
	const line = (text: string): string => `${edge}${padTo(truncate(text, inner), inner)}${edge}`;
	return {
		rows: [
			`${theme.fg("border", box.topLeft)}${rule}${theme.fg("border", box.topRight)}`,
			line(`${prefix}${command}${suffix}`),
			...(screen.length > 0 ? screen : [""]).map(line),
			line(footer),
			`${theme.fg("border", box.bottomLeft)}${rule}${theme.fg("border", box.bottomRight)}`,
		],
	};
});
