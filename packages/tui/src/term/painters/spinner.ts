/**
 * `spinner`: a frame picked from the terminal clock, then its label. Reading
 * `cx.now()` makes the animation tick repaint it; reduced motion draws the
 * first frame.
 */
import type { TspSpinnerProps, TspTone } from "@oh-my-pi/pi-wire";
import { padTo, visibleWidth } from "../../text/width";
import { definePainter, type PaintContext } from "../paint";
import { decorationText, lazyText } from "../text-layout";
import { lineBlock } from "./badge";
import { headText } from "./card";
import { styledText } from "./layout";

/** Milliseconds per spinner frame. */
export const SPINNER_INTERVAL_MS = 80;

const SPINNER_STYLES: Readonly<Record<string, readonly string[]>> = {
	braille: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	starburst: ["✶", "✸", "✹", "✺", "✹", "✸"],
	orbit: ["◐", "◓", "◑", "◒"],
};

const labelFrames = new WeakMap<readonly string[], readonly string[]>();

function currentFrame(cx: PaintContext, style: TspSpinnerProps["style"], besideLabel: boolean): string {
	let frames = (style && SPINNER_STYLES[style]) || cx.theme.symbols.spinnerFrames;
	if (frames.length === 0) return "";
	if (cx.reduceMotion) return frames[0]!;
	if (besideLabel && frames.length > 1) {
		// Reserve the widest animated frame so ticking cannot clip/reveal letters of the
		// unchanged label. Compute all padding once per frame set, not once per tick.
		let aligned = labelFrames.get(frames);
		if (!aligned) {
			let min = Infinity;
			let max = 0;
			for (const frame of frames) {
				const width = visibleWidth(frame);
				min = Math.min(min, width);
				max = Math.max(max, width);
			}
			aligned = min === max ? frames : frames.map(frame => padTo(frame, max));
			labelFrames.set(frames, aligned);
		}
		frames = aligned;
	}
	return frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length]!;
}

/** The spinner frame shown at the current clock (the theme's status frames by default). */
export function spinnerFrame(cx: PaintContext, style?: TspSpinnerProps["style"]): string {
	return currentFrame(cx, style, false);
}

definePainter("spinner", (node, cx) => {
	const props = node.props() as TspSpinnerProps & { tone?: TspTone };
	const label = styledText(cx.theme, props.label);
	const frame = cx.theme.style(props.tone ?? "accent", currentFrame(cx, props.style, !!label));
	const chrome = label ? `${frame} ` : frame;
	const block = lineBlock(chrome + label, cx);
	if (!block.rows.length) return block;
	return {
		rows: block.rows,
		text: label ? lazyText(() => [headText(chrome, label, block.rows[0]!, 0)]) : decorationText(1),
	};
});
