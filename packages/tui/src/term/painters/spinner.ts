/**
 * `spinner`: a frame picked from the terminal clock at the environment's
 * spinner cadence, then its label. Reading `cx.now()` makes the animation
 * tick repaint it; a still cadence (0) draws the first frame.
 */
import type { TspSpinnerProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter, type PaintContext } from "../paint";
import { lineBlock } from "./badge";
import { styledText } from "./layout";

const SPINNER_STYLES: Readonly<Record<string, readonly string[]>> = {
	braille: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	starburst: ["✶", "✸", "✹", "✺", "✹", "✸"],
	orbit: ["◐", "◓", "◑", "◒"],
};

/**
 * Index of the frame a `count`-frame spinner shows now, at `cx.spinnerInterval`. Still spinners
 * (interval 0) show frame 0 without reading the clock, so they never schedule animation ticks.
 */
export function spinnerIndex(cx: PaintContext, count: number): number {
	const interval = cx.spinnerInterval;
	if (interval <= 0 || count <= 0) return 0;
	return Math.floor(cx.now() / interval) % count;
}

/** The spinner frame shown at the current clock (the theme's status frames by default). */
export function spinnerFrame(cx: PaintContext, style?: TspSpinnerProps["style"]): string {
	const frames = (style && SPINNER_STYLES[style]) || cx.theme.symbols.spinnerFrames;
	if (frames.length === 0) return "";
	return frames[spinnerIndex(cx, frames.length)]!;
}

definePainter("spinner", (node, cx) => {
	const props = node.props() as TspSpinnerProps & { tone?: TspTone };
	const frame = cx.theme.style(props.tone ?? "accent", spinnerFrame(cx, props.style));
	const label = styledText(cx.theme, props.label);
	return lineBlock(label ? `${frame} ${label}` : frame, cx);
});
