/**
 * Markdown documents shared by the renderer's windowing tests.
 */

import { LEX_WINDOW_BYTES } from "../src/components/markdown";

/**
 * `Intro.`, then a construct (`open`, lines one blank line apart, `close`), then
 * `rest`. The lines are padded so that a `"\n\n"` inside the construct ends
 * exactly at LEX_WINDOW_BYTES, the end of the first probe window, where a probe
 * that stops at the window's end would cut it.
 */
export function straddleFirstWindow(open: string, line: (i: number) => string, close: string, rest: string): string {
	const prefix = `Intro.\n\n${open}\n`;
	let body = "";
	let i = 0;
	while (prefix.length + body.length < LEX_WINDOW_BYTES - 60) body += `${line(i++)}\n\n`;
	body += `${"y".repeat(LEX_WINDOW_BYTES - prefix.length - body.length - 2)}\n\n${line(i)}\n`;
	return `${prefix}${body}${close}\n\n${rest}`;
}
