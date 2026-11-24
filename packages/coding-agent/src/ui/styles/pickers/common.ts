/**
 * Pieces the picker screen looks share: a query field with its caret, key
 * hint rows, search-hit highlighting.
 */
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { renderInline } from "@oh-my-pi/pi-tui/text/markdown/inline";
import { lexInline } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { markdownStyles } from "@oh-my-pi/pi-tui/text/markdown/styles";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { sliceCells, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A single-line field: `prompt` then `text` with the caret cell inverted (a
 * space past the end), scrolled so the caret stays within `width`.
 */
export function caretField(theme: Theme, prompt: string, text: string, cursor: number, width: number): string {
	const room = width - visibleWidth(prompt);
	if (room <= 0) return sliceCells(prompt, 0, width).text;
	const at = Math.max(0, Math.min(cursor, text.length));
	const display = at >= text.length ? `${text} ` : text;
	const before = display.slice(0, at);
	const caret = [...segmenter.segment(display.slice(at))][0]?.segment ?? " ";
	const after = display.slice(at + caret.length);
	let head = before;
	const caretWidth = visibleWidth(caret);
	// Keep the caret visible: drop leading cells until it fits.
	while (head.length > 0 && visibleWidth(head) + caretWidth > room) {
		const first = [...segmenter.segment(head)][0]!.segment;
		head = head.slice(first.length);
	}
	const tailRoom = Math.max(0, room - visibleWidth(head) - caretWidth);
	const tail = sliceCells(after, 0, tailRoom).text;
	return `${prompt}${head}${theme.style("inverse", caret)}${tail}`;
}

/** One key hint: the keycaps and what they do. */
export type KeyHint = readonly [keys: string, label: string];

/**
 * Key hints as `keys label · keys label`, keys `dim` and labels `muted`
 * (separators `dim`), wrapped to `width`.
 */
export function keyHintRows(theme: Theme, hints: readonly KeyHint[], width: number): string[] {
	const text = hints
		.map(([keys, label]) => `${theme.style("dim", keys)}${theme.style("muted", ` ${label}`)}`)
		.join(theme.style("dim", " · "));
	return wrap(text, width);
}

/** `text` with `[from, to)` UTF-16 ranges in `style`. */
export function highlightRanges(
	theme: Theme,
	text: string,
	ranges: readonly (readonly [number, number])[],
	style = "accent",
): string {
	if (ranges.length === 0) return text;
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (start >= text.length) break;
		if (start > pos) out += text.slice(pos, start);
		out += theme.style(style, text.slice(Math.max(start, pos), Math.min(end, text.length)));
		pos = Math.min(end, text.length);
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

/** Case-insensitive occurrences of `tokens` in `text`, merged, as UTF-16 ranges. */
export function tokenHits(text: string, tokens: readonly string[]): [number, number][] {
	if (tokens.length === 0) return [];
	const lower = text.toLowerCase();
	const ranges: [number, number][] = [];
	for (const token of tokens) {
		if (token.length === 0) continue;
		for (let from = lower.indexOf(token); from !== -1; from = lower.indexOf(token, from + token.length)) {
			ranges.push([from, from + token.length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/**
 * Inline markdown (emphasis, code, links) rendered in the theme's markdown
 * colors, plain runs in `base` (a theme color or style tokens).
 */
export function inlineMarkdown(theme: Theme, source: string, base?: string): string {
	const env = { styles: markdownStyles(theme, true), hyperlinks: false };
	const text = (run: string): string => (base ? theme.style(base, run) : run);
	return renderInline(env, lexInline(source), { text, restore: "" });
}

/** The text inline markdown shows, without markers or styles. */
export function plainInlineMarkdown(source: string): string {
	return stripEscapes(inlineMarkdown(PLAIN_THEME, source));
}
