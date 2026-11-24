/**
 * Terminal look of a progress HUD row (`row` `omp.hud.progress`), docked
 * right: the dim label, an 18-cell bar (`━` accent over `─` dim) when the
 * work has a size, then the tail; a tail that cannot fit gives way to its
 * short form. A judgment batch's tail is `12/40` (bold) ` · $0.031` (dim)
 * ` · 2 failed` (warning, ` +2!` when tight); a background compaction's its
 * run time.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { statusText } from "../../dock/progress";
import { termOf } from "../messages/fill";

/** A colored piece of a tail. */
export interface TailText {
	readonly text: string;
	readonly color: string;
	readonly strong?: boolean;
	/** Cap the text to this share of the row (a failure reason). */
	readonly cap?: number;
}

/** What a progress row's terminal look reads. */
export type ProgressTerm = {
	readonly label: string;
	readonly tail?: TailText;
	readonly fallback?: TailText;
	readonly judgment?: {
		readonly count: string;
		readonly cost: string;
		readonly failed: number;
	};
	/** A run time from epoch ms (background compaction). */
	readonly run?: { readonly startedAt: number };
	readonly bar?: { readonly value: number; readonly max: number };
};

const BAR_WIDTH = 18;
const MIN_BAR_WIDTH = 4;

function styled(theme: Theme, piece: TailText, width: number): string {
	const text = piece.cap === undefined ? piece.text : truncate(piece.text, Math.max(8, Math.floor(width * piece.cap)));
	const colored = theme.fg(piece.color, text);
	return piece.strong ? theme.style("strong", colored) : colored;
}

function judgmentTail(theme: Theme, judgment: NonNullable<ProgressTerm["judgment"]>, width: number): string {
	const { count, cost, failed } = judgment;
	let failure = failed > 0 ? ` · ${failed} failed` : "";
	const compact = failed > 0 ? ` +${failed}!` : "";
	const fixed = visibleWidth(count) + visibleWidth(cost);
	if (failure && fixed + visibleWidth(failure) + MIN_BAR_WIDTH + 1 > width && fixed + visibleWidth(compact) <= width)
		failure = compact;
	return `${theme.style("strong", theme.fg("text", count))}${cost ? theme.fg("dim", cost) : ""}${failure ? theme.fg("warning", failure) : ""}`;
}

function paintProgressRow(node: UiNode, cx: PaintContext): Block {
	const term = termOf<ProgressTerm>(node) as ProgressTerm;
	const width = cx.width;
	if (width <= 0 || term.label === undefined) return EMPTY_BLOCK;
	const theme = cx.theme;
	let tail: string;
	let fallback: string;
	if (term.judgment) {
		tail = judgmentTail(theme, term.judgment, width);
		fallback = theme.style("strong", theme.fg("text", term.judgment.count));
	} else if (term.run) {
		tail = theme.fg("text", formatDuration(cx.now() - term.run.startedAt));
		fallback = tail;
	} else {
		tail = term.tail ? styled(theme, term.tail, width) : "";
		fallback = term.fallback ? styled(theme, term.fallback, width) : tail;
	}
	let remaining = width - visibleWidth(tail);
	if (term.bar && remaining > 1) {
		const cells = Math.min(BAR_WIDTH, remaining - 1);
		const fraction = Math.min(1, Math.max(0, term.bar.value / Math.max(1, term.bar.max)));
		const filled = Math.round(fraction * cells);
		const bar = `${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(cells - filled))}`;
		tail = `${bar} ${tail}`;
		remaining = width - visibleWidth(tail);
	}
	if (remaining > 1) {
		const label = truncate(statusText(term.label), remaining - 1, "");
		if (label) tail = `${theme.fg("dim", label)} ${tail}`;
	}
	if (visibleWidth(tail) > width) tail = truncate(fallback, width, "");
	return {
		rows: [`${" ".repeat(Math.max(0, width - visibleWidth(tail)))}${tail}`],
	};
}

defineRolePainter("row", "omp.hud.progress", paintProgressRow);
