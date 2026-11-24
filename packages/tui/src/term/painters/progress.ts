/**
 * `progress`: a bar with its percentage and label (`████░░░░ 42% label`).
 * Indeterminate progress (`value: null`) slides a block along the track on
 * the terminal clock.
 */
import type { TspProgressProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter, type PaintContext } from "../paint";
import { lineBlock } from "./badge";
import { styledText } from "./layout";

/** Widest track a bar takes. */
export const MAX_TRACK = 24;
const FILL = "█";
const EMPTY = "░";
const SLIDE_MS = 100;
const SLIDER = 3;

/** A track of `cells` with `value` (0–1) of it filled in `tone`. */
export function track(cx: PaintContext, cells: number, value: number, tone: string): string {
	const filled = Math.round(Math.min(1, Math.max(0, value)) * cells);
	return cx.theme.style(tone, FILL.repeat(filled)) + cx.theme.style("dim", EMPTY.repeat(cells - filled));
}

definePainter("progress", (node, cx) => {
	const props = node.props() as TspProgressProps & { tone?: TspTone };
	const label = styledText(cx.theme, props.label);
	const percent = props.value === null ? "" : `${Math.round(Math.min(1, Math.max(0, props.value)) * 100)}%`;
	const cells = Math.max(4, Math.min(MAX_TRACK, Math.floor(cx.width / 3)));
	const tone = props.tone ?? "accent";
	let bar: string;
	if (props.value === null) {
		const span = cells + SLIDER;
		const at = cx.reduceMotion ? 0 : (Math.floor(cx.now() / SLIDE_MS) % span) - SLIDER;
		let out = "";
		for (let i = 0; i < cells; i++)
			out += i >= at && i < at + SLIDER ? cx.theme.style(tone, FILL) : cx.theme.style("dim", EMPTY);
		bar = out;
	} else bar = track(cx, cells, props.value, tone);
	const parts = [bar, percent && cx.theme.style("muted", percent), label].filter(Boolean);
	return lineBlock(parts.join(" "), cx);
});
