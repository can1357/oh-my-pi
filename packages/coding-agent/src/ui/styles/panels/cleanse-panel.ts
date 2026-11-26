/**
 * The `/cleanse` sheet in the terminal: the shared titled sheet (see `./btw`)
 * with its own log lines (verdicts and outcomes: colored glyphs and words,
 * plain files) and live rows (spinner lines for the phase and checkers, the
 * repair head with a 16-cell bar, a line per running lane).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { formatDuration } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspAgentProps, TspMeterProps, TspSpan, TspSpinnerProps, TspTextProps } from "@oh-my-pi/pi-wire";
import { paintSheet } from "./btw";
import { activityFrame, plainText, propsOf, roleOf } from "./common";

/** Cells of the repair bar. */
const BAR_CELLS = 16;

/** Spans as the terminal log draws them: spaces around a styled word stay plain, paths plain. */
function logLine(theme: Theme, spans: readonly TspSpan[]): string {
	let out = "";
	for (const span of spans) {
		if (!span.s || span.s === "path") {
			out += span.t;
			continue;
		}
		const lead = span.t.match(/^ */)![0];
		const trail = span.t.slice(lead.length).match(/ *$/)![0];
		const body = span.t.slice(lead.length, span.t.length - trail.length);
		out += `${lead}${body && theme.style(span.s, body)}${trail}`;
	}
	return out;
}

function paintLogLine(node: UiNode, cx: PaintContext): Block {
	return { rows: wrap(logLine(cx.theme, propsOf<TspTextProps>(node).spans ?? []), cx.width) };
}
defineRolePainter("text", "omp.cleanse.verdict", paintLogLine);
defineRolePainter("text", "omp.cleanse.outcome", paintLogLine);

function elapsedText(node: UiNode | undefined): string {
	const age = node ? ((node.props() as { age?: number }).age ?? 0) : 0;
	return formatDuration(age, "short");
}

defineRolePainter("col", "omp.cleanse.live", (node, cx): Block => {
	const theme = cx.theme;
	const frame = activityFrame(cx);
	const dim = (text: string) => theme.fg("dim", text);
	const rows: string[] = [];
	for (const child of node.children()) {
		if (child.kind === "spinner") {
			rows.push(`${theme.fg("warning", frame)} ${replaceTabs(plainText(propsOf<TspSpinnerProps>(child).label))}`);
			continue;
		}
		if (roleOf(child) === "omp.cleanse.head") {
			const [, meter, ...rest] = child.children();
			const value = meter ? (propsOf<TspMeterProps>(meter).value ?? 0) : 0;
			const filled = Math.round(value * BAR_CELLS);
			const label = meter ? plainText((meter.props() as { label?: string }).label).replace(/ lanes$/, "") : "";
			const facts = rest
				.filter(part => part.kind === "text")
				.map(part => plainText(propsOf<TspTextProps>(part).spans));
			const parts = [
				`${label}`,
				...facts.flatMap(fact => fact.split(" · ")),
				elapsedText(rest.find(p => p.kind === "elapsed")),
			];
			const bar = `[${theme.fg("accent", "█".repeat(filled))}${dim("░".repeat(BAR_CELLS - filled))}]`;
			rows.push(`${theme.fg("accent", frame)} Repairing ${bar} ${parts.join(dim(" · "))}`);
			continue;
		}
		if (roleOf(child) === "omp.cleanse.lanes") {
			for (const lane of child.children()) {
				const props = propsOf<TspAgentProps>(lane);
				const task = plainText(props.task);
				const age = formatDuration(props.stats?.age ?? 0, "short");
				rows.push(
					`${theme.fg("warning", frame)} ${theme.style("strong", props.name)} ${task} ${dim("·")} ${dim("starting")} ${dim(`· ${age}`)}`,
				);
			}
			continue;
		}
		// A running checker: its spinner label and elapsed time.
		const [spinner, elapsed] = child.children();
		const label = spinner ? replaceTabs(plainText(propsOf<TspSpinnerProps>(spinner).label)) : "";
		rows.push(`${theme.fg("warning", frame)} ${label} ${dim(`· ${elapsedText(elapsed)}`)}`);
	}
	return { rows: rows.flatMap(row => wrap(row, cx.width)) };
});

defineRolePainter("col", "omp.overlay.cleanse", paintSheet);
