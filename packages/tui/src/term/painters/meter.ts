/**
 * `meter`: a value drawn as a bar (with stacked parts and marks), a ring
 * glyph or a block row, then `label / total`. Thresholds turn the fill to
 * warning or error.
 */
import type { TspMeterProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter, type PaintContext } from "../paint";
import { lineBlock } from "./badge";
import { styledText } from "./layout";

const TRACK_CELLS: Readonly<Record<string, number>> = { sm: 8, md: 16, lg: 24 };
const RING = ["○", "◔", "◑", "◕", "●"];
const BLOCK_ON = "▰";
const BLOCK_OFF = "▱";
const FILL = "█";
const EMPTY = "░";

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function fillTone(props: TspMeterProps & { tone?: TspTone }): string {
	const value = props.value ?? 0;
	if (props.thresholds?.bad !== undefined && value >= props.thresholds.bad) return "error";
	if (props.thresholds?.warn !== undefined && value >= props.thresholds.warn) return "warning";
	return props.tone ?? "accent";
}

function bar(cx: PaintContext, props: TspMeterProps & { tone?: TspTone }, cells: number): string {
	const tokens: string[] = Array.from({ length: cells }, () => "");
	const glyphs: string[] = Array.from({ length: cells }, () => EMPTY);
	if (props.parts && props.parts.length > 0) {
		let start = 0;
		for (const part of props.parts) {
			const end = Math.min(cells, Math.round((start + clamp(part.value)) * cells));
			const from = Math.round(start * cells);
			for (let i = from; i < end; i++) {
				glyphs[i] = part.hatch ? "▒" : FILL;
				tokens[i] = part.token ?? "accent";
			}
			start += clamp(part.value);
		}
	} else if (props.value !== null) {
		const filled = Math.round(clamp(props.value) * cells);
		const tone = fillTone(props);
		for (let i = 0; i < filled; i++) {
			glyphs[i] = FILL;
			tokens[i] = tone;
		}
	}
	for (const mark of props.marks ?? []) {
		const at = Math.min(cells - 1, Math.max(0, Math.round(clamp(mark.at) * cells)));
		glyphs[at] = (mark.icon && cx.theme.symbols.icon(mark.icon)) || "│";
		tokens[at] = mark.tone ?? "muted";
	}
	let out = "";
	for (let i = 0; i < cells; i++) out += cx.theme.style(tokens[i] || "dim", glyphs[i]!);
	return out;
}

definePainter("meter", (node, cx) => {
	const props = node.props() as TspMeterProps & { tone?: TspTone };
	let gauge: string;
	if (props.style === "ring") {
		const index = props.value === null ? 0 : Math.round(clamp(props.value) * (RING.length - 1));
		gauge = cx.theme.style(props.value === null ? "dim" : fillTone(props), RING[index]!);
	} else if (props.style === "blocks") {
		const steps = props.steps ?? TRACK_CELLS[props.size ?? "sm"]!;
		const on = props.value === null ? 0 : Math.round(clamp(props.value) * steps);
		gauge =
			cx.theme.style(fillTone(props), BLOCK_ON.repeat(on)) + cx.theme.style("dim", BLOCK_OFF.repeat(steps - on));
	} else {
		const cells = Math.max(1, Math.min(TRACK_CELLS[props.size ?? "md"]!, cx.width));
		gauge = bar(cx, props, cells);
	}
	const label = styledText(cx.theme, props.label);
	const total = styledText(cx.theme, props.total);
	const text = label && total ? `${label}${cx.theme.style("dim", "/")}${total}` : label || total;
	return lineBlock(text ? `${gauge} ${text}` : gauge, cx);
});
