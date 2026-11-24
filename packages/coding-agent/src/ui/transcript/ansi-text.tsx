/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Pre-styled command text (SGR colors baked in by the theme's `fg`/`bg`) as
 * word-wrapped terminal rows: `/session`, `/jobs`, `/advisor status` and the
 * other command reports built as ANSI strings. `padX` blank cells pad each
 * side, `padY` blank rows above and below.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { wrapTextWithAnsi } from "../../utils/text-width";

export interface AnsiTextProps {
	readonly text: string;
	readonly padX?: number;
	readonly padY?: number;
}

/** The wrapped rows of `text` at `width`, padded as {@link AnsiTextProps} asks. */
export function ansiTextRows(text: string, width: number, padX = 0, padY = 0): string[] {
	const inner = Math.max(1, width - padX * 2);
	const pad = " ".repeat(padX);
	const rows = text === "" ? [] : wrapTextWithAnsi(text, inner).map(line => (padX > 0 ? `${pad}${line}` : line));
	const blank = Array.from({ length: padY }, () => "");
	return [...blank, ...rows, ...blank];
}

export function AnsiText(props: AnsiTextProps): JSXNode {
	return <canvas paint={width => ansiTextRows(props.text, width, props.padX, props.padY)} />;
}
