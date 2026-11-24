/**
 * `omp.app.probe`: the protocol probe in the terminal. A border-colored rule
 * above and below (the hidden first and last columns); every text indented
 * one cell and word-wrapped, its rows filled to the width (an open style,
 * like the inverse sample's, runs to the edge); spacers as blank rows; the
 * OSC 66 samples as written (never wrapped or cut); the image as itself.
 * The styling sample (`term.sample`) shows what TSP spans cannot carry: its
 * `underline` word underlined, its `del`/`mark` samples as plain strike and
 * inverse, and the blank run after `truecolor:` as a
 * 24-bit hue sweep.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { hyperlink } from "@oh-my-pi/pi-tui/text/osc";
import { padTo, replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { hsvToRgb } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTextProps } from "@oh-my-pi/pi-wire";

const SWEEP_CELLS = 32;
/** The styling sample shows the bare SGR attributes behind these span tokens. */
const SAMPLE_TOKENS: Readonly<Record<string, string>> = { del: "strike", mark: "inverse" };
const SWEEP_GAP = `: ${" ".repeat(SWEEP_CELLS)}`;

/** A hue sweep of background-painted cells. */
function sweep(cells: number): string {
	let out = "";
	for (let i = 0; i < cells; i++) {
		const { r, g, b } = hsvToRgb({ h: (i / cells) * 360, s: 0.85, v: 1 });
		out += `\x1b[48;2;${r};${g};${b}m `;
	}
	return `${out}\x1b[0m`;
}

/** Spans styled by the theme, links as OSC 8. */
function spanText(theme: Theme, spans: readonly TspSpan[], sample: boolean): string {
	let out = "";
	for (const span of spans) {
		let text = span.t;
		if (sample) {
			text = text
				.replace(SWEEP_GAP, `: ${sweep(SWEEP_CELLS)}`)
				.replace(/\bunderline\b/, word => theme.style("underline", word));
		}
		if (span.s) text = theme.style((sample && SAMPLE_TOKENS[span.s]) || span.s, text);
		out += span.href ? hyperlink(text, span.href) : text;
	}
	return out;
}

function textRows(node: UiNode, cx: PaintContext): string[] {
	const props = node.props() as TspTextProps & { term?: { sample?: boolean } };
	const spans = props.spans ?? (props.text ? [{ t: props.text }] : []);
	const styled = replaceTabs(spanText(cx.theme, spans, props.term?.sample === true));
	const inner = Math.max(1, cx.width - 2);
	return wrap(styled, inner).map(row => ` ${padTo(row, inner)} `);
}

function paintProbe(node: UiNode, cx: PaintContext): Block {
	const rule = cx.theme.fg("border", cx.theme.symbols.box.horizontal.repeat(cx.width));
	const rows: string[] = [];
	for (const child of node.children()) {
		const props = child.props() as { hidden?: boolean; text?: string };
		if (child.kind === "col" && props.hidden) rows.push(rule);
		else if (child.kind === "text") rows.push(...textRows(child, cx));
		else if (child.kind === "ansi") rows.push(...(props.text ?? "").split("\n"));
		else rows.push(...cx.paint(child, cx.width).rows);
	}
	return { rows };
}

/** The terminal role of the other debug tools' transcript output, laid out like the probe. */
export const DEBUG_BLOCK_ROLE = "omp.debug.block";

defineRolePainter("col", "omp.app.probe", paintProbe);
defineRolePainter("col", DEBUG_BLOCK_ROLE, paintProbe);
