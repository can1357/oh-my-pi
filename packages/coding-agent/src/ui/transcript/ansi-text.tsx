/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Pre-styled command text (SGR colors baked in by the theme's `fg`/`bg`) as
 * word-wrapped terminal rows: `/session`, `/jobs`, `/advisor status` and the
 * other command reports built as ANSI strings. `padX` blank cells pad each
 * side in the standard layout, `padY` blank rows above and below.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { wrapTextWithAnsi } from "../../utils/text-width";
import { terminalPaddingX } from "../styles/terminal-padding";

/** The styled text and its padding in the standard terminal layout. */
export interface AnsiTextProps {
	readonly text: string;
	readonly padX?: number;
	readonly padY?: number;
}

/** The wrapped rows of `text` at `width`, with horizontal padding adjusted by the terminal layout. */
export function ansiTextRows(text: string, width: number, padX = 0, padY = 0): string[] {
	const paddingX = terminalPaddingX(padX);
	const inner = Math.max(1, width - paddingX * 2);
	const pad = " ".repeat(paddingX);
	const rows = text === "" ? [] : wrapTextWithAnsi(text, inner).map(line => pad + line);
	const blank = Array.from({ length: padY }, () => "");
	return [...blank, ...rows, ...blank];
}

/** Draw pre-styled text in the terminal with the current layout's padding. */
export function AnsiText(props: AnsiTextProps): JSXNode {
	return <canvas paint={width => ansiTextRows(props.text, width, props.padX, props.padY)} />;
}
