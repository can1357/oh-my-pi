/**
 * `spinner`: a frame picked from the terminal clock, then its label. Reading
 * `cx.now()` makes the animation tick repaint it; reduced motion draws the
 * first frame.
 */
import type { TspSpinnerProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter, type PaintContext } from "../paint";
import { lineBlock } from "./badge";
import { styledText } from "./layout";

/** Milliseconds per spinner frame. */
export const SPINNER_INTERVAL_MS = 80;

const SPINNER_STYLES: Readonly<Record<string, readonly string[]>> = {
	braille: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	starburst: ["✶", "✸", "✹", "✺", "✹", "✸"],
	orbit: ["◐", "◓", "◑", "◒"],
};

/** The spinner frame shown at the current clock (the theme's status frames by default). */
export function spinnerFrame(cx: PaintContext, style?: TspSpinnerProps["style"]): string {
	const frames = (style && SPINNER_STYLES[style]) || cx.theme.symbols.spinnerFrames;
	if (frames.length === 0) return "";
	if (cx.reduceMotion) return frames[0]!;
	return frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length]!;
}

definePainter("spinner", (node, cx) => {
	const props = node.props() as TspSpinnerProps & { tone?: TspTone };
	const frame = cx.theme.style(props.tone ?? "accent", spinnerFrame(cx, props.style));
	const label = styledText(cx.theme, props.label);
	return lineBlock(label ? `${frame} ${label}` : frame, cx);
});
