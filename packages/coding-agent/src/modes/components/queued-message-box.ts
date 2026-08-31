import type { Component } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { fit } from "./overlay-box";

/**
 * A single queued steer / follow-up message rendered inside a bordered box.
 *
 * Model (matches the approved steering-preview design):
 *  - Body rows carry a tree-style gutter that distinguishes a hard newline
 *    (`├─` / `└─` for the first visual row of a logical line) from a soft
 *    wrap (`│ ` for continuation rows produced by word-wrapping a long line).
 *  - Each logical line is word-wrapped to the content width (Bun.wrapAnsi),
 *    so a long line flows onto continuation rows instead of being truncated
 *    mid-word.
 *  - When collapsed, the box keeps at most `collapseLines` visual rows and
 *    reports the remainder in the bottom border as `+N rows · M chars`
 *    (English), centered like the title sits in the top rule.
 *  - The horizontal rules use a light dashed glyph (`╌`) for the steering-box
 *    look; the vertical borders are dashed too (`╎`). This is local to queued
 *    overlays keep their own solid borders via `overlay-box`.
 *  - Callers may suppress the top rule to stack a custom header above the
 *    boxed body while preserving column-for-column alignment.
 */
const DASH = "╌";
const VDASH = "╎";

/** Word-wrap a (plain, sanitized) line to `width` columns; returns visual rows. */
function wrapLine(line: string, width: number): string[] {
	if (width <= 0 || line.length === 0) return [""];
	// Bun.wrapAnsi is ANSI-aware and word-wraps at width, preserving interior
	// whitespace runs; it joins visual rows with `\n`.
	return Bun.wrapAnsi(line, width, { wordWrap: true, hard: true }).split("\n");
}

export interface QueuedMessageBoxOptions {
	/** Max visual rows when not expanded (mirrors `pendingQueueCollapseLines`). */
	collapseLines: number;
	/** When true, show every visual row and no truncation hint. */
	expanded: boolean;
	/** When false, omit the top rule so a caller can supply a custom header. */
	showTopBorder?: boolean;
	/** Optional footer text inset into the bottom rule (e.g. the queue hint). */
	footerText?: string;
}

export class QueuedMessageBox implements Component {
	#title: string;
	#lines: readonly string[];
	#collapseLines: number;
	#expanded: boolean;
	#showTopBorder: boolean;
	#footerText: string | undefined;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	/**
	 * @param title  Box title inset into the top rule (e.g. `Steer`, `Follow-up`);
	 *               empty for the streaming-steer box whose top rule is animated.
	 * @param lines  The logical message lines (already sanitized by the caller);
	 *               each is word-wrapped at render time, so pass every line — this
	 *               component performs the collapse, not the caller.
	 */
	constructor(title: string, lines: readonly string[], opts: QueuedMessageBoxOptions) {
		this.#title = title;
		this.#lines = lines;
		this.#collapseLines = opts.collapseLines;
		this.#expanded = opts.expanded;
		this.#showTopBorder = opts.showTopBorder ?? true;
		this.#footerText = opts.footerText;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
		// Below this the frame has no room; fall back to plain indented rows so a
		// very narrow terminal still shows something without breaking layout.
		if (width < 8) {
			const flat = this.#title
				? [theme.fg("dim", `${this.#title}:`), ...this.#lines.map(l => theme.fg("dim", `  ${l}`))]
				: this.#lines.map(l => theme.fg("dim", `  ${l}`));
			this.#cachedWidth = width;
			this.#cachedLines = flat;
			return flat;
		}
		// Body row layout: `│ <gutter(3)> <content> │` → content = width - 7.
		const contentW = Math.max(0, width - 7);
		const lastLogical = this.#lines.length - 1;
		const allRows: Array<{ li: number; vi: number; text: string }> = [];
		const lineRowCount: number[] = [];
		this.#lines.forEach((line, li) => {
			const visual = wrapLine(line, contentW);
			lineRowCount[li] = visual.length;
			visual.forEach((v, vi) => {
				allRows.push({ li, vi, text: v });
			});
		});
		let shown = allRows;
		let hiddenRows = 0;
		let hiddenChars = 0;
		if (!this.#expanded && allRows.length > this.#collapseLines) {
			shown = allRows.slice(0, this.#collapseLines);
			hiddenRows = allRows.length - this.#collapseLines;
			hiddenChars = allRows.slice(this.#collapseLines).reduce((a, r) => a + visibleWidth(r.text), 0);
		}
		// `└─` marks a clean single-row end (last logical line, not wrapped, nothing
		// truncated). A wrapped last line continues onto `│` rows, so its first row
		// is `├─`; a truncated queue likewise ends on `├─`.
		const isTruncated = hiddenRows > 0;
		const gp = (g: string) => theme.fg("muted", g);
		const out: string[] = this.#showTopBorder ? [this.#topBorder(width)] : [];
		for (const r of shown) {
			const gutter =
				r.vi === 0 ? (r.li === lastLogical && !isTruncated && lineRowCount[r.li] === 1 ? "└─ " : "├─ ") : "│  ";
			out.push(this.#bodyRow(gutter, r.text, width, gp));
		}
		if (allRows.length === 0) out.push(this.#bodyRow("│  ", "", width, gp));
		out.push(this.#bottomBorder(width, hiddenRows, hiddenChars, this.#footerText));

		this.#cachedWidth = width;
		this.#cachedLines = out;
		return out;
	}

	#topBorder(width: number): string {
		const box = theme.boxRound;
		const inner = Math.max(0, width - 2);
		if (!this.#title) return theme.fg("border", box.topLeft + DASH.repeat(inner) + box.topRight);
		const shown = truncateToWidth(` ${this.#title} `, Math.max(0, inner - 2));
		const fill = Math.max(0, inner - 1 - visibleWidth(shown));
		return (
			theme.fg("border", box.topLeft + DASH) +
			theme.bold(theme.fg("accent", shown)) +
			theme.fg("border", DASH.repeat(fill) + box.topRight)
		);
	}

	#bodyRow(gutter: string, text: string, width: number, gp: (s: string) => string): string {
		const contentW = Math.max(0, width - 7);
		return `${theme.fg("border", VDASH)} ${gp(gutter)}${fit(text, contentW)} ${theme.fg("border", VDASH)}`;
	}

	#bottomBorder(width: number, hiddenRows: number, hiddenChars: number, footerText: string | undefined): string {
		const box = theme.boxRound;
		const inner = Math.max(0, width - 2);
		const parts: string[] = [];
		if (footerText) parts.push(footerText);
		if (hiddenRows > 0) parts.push(`+${hiddenRows} rows · ${hiddenChars} chars`);
		const seg = parts.length ? ` ${parts.join(" · ")} ` : "";
		if (!seg) return theme.fg("border", box.bottomLeft + DASH.repeat(inner) + box.bottomRight);
		const left = 1; // left-aligned, one cell in from the corner
		const maxSeg = Math.max(0, inner - left);
		const segShown = truncateToWidth(seg, maxSeg);
		const segW = visibleWidth(segShown);
		const right = Math.max(0, inner - left - segW);
		return (
			theme.fg("border", box.bottomLeft + DASH.repeat(left)) +
			theme.fg("muted", segShown) +
			theme.fg("border", DASH.repeat(right) + box.bottomRight)
		);
	}
}

/**
 * A dashed footer rule (no side borders) carrying queue-level hint text — used
 * when the last visual pending entry is lightweight (no box to fold the hint
 * into), so the affordance still reads as a border-style footer, not a thrown
 * plain line.
 */
export class QueueFooter implements Component {
	#text: string;
	#cachedWidth = -1;
	#cached: string[] | undefined;
	constructor(text: string) {
		this.#text = text;
	}
	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cached = undefined;
	}
	render(width: number): readonly string[] {
		if (this.#cached && this.#cachedWidth === width) return this.#cached;
		const inner = Math.max(0, width);
		const left = 1;
		const seg = truncateToWidth(` ${this.#text} `, Math.max(0, inner - left));
		const segW = visibleWidth(seg);
		const right = Math.max(0, inner - left - segW);
		const line =
			theme.fg("border", DASH.repeat(left)) + theme.fg("muted", seg) + theme.fg("border", DASH.repeat(right));
		this.#cached = [line];
		this.#cachedWidth = width;
		return this.#cached;
	}
}
