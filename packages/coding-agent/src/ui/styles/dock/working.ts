/**
 * Terminal looks of the dock's status rows.
 *
 * - `row` `omp.working`: a blank row, then one cell in: the interrupt key
 *   (muted, or the accent's dim hue) and the label shimmering — or, for a
 *   maintenance run, a spinner frame (accent; warning for a retry) and the
 *   muted line. A trailer docks right when two cells stay free.
 * - `row` `omp.hint.retry`: a blank row, then `F5` (dim) ` to retry`
 *   (muted) where the working row's interrupt key stood.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { shimmerTiers } from "@oh-my-pi/pi-tui/term/painters/shimmer";
import { type ShimmerMode, type ShimmerTiers, shimmerText } from "@oh-my-pi/pi-tui/text/shimmer";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { keyLabel } from "../../keys/hints";
import { termOf } from "../messages/fill";

/** What the working row's terminal look reads (`term` of the `omp.working` row). */
export type WorkingTerm = {
	readonly look: "working" | "maintenance";
	/** The interrupt key: the working row's glyph. */
	readonly key: string | undefined;
	/** The maintenance spinner's color. */
	readonly tone: "accent" | "warning";
	/** The line at wall time `now`, keys formatted by `keyLabel`. */
	readonly message: (now: number, keyLabel: (key: string) => string) => string;
	/** The message is re-read every frame (a function label). */
	readonly live: boolean;
	/** The message counts down (a retry). */
	readonly countdown?: boolean;
	/** The label shimmers (working look only). */
	readonly shimmer?: ShimmerMode;
	readonly accent?: { readonly main: string; readonly dim: string };
	/** Drawn as given (the producer styles it). */
	readonly trailer?: () => string | undefined;
};

/** Spinner frame period of a maintenance row, ms. */
const SPINNER_MS = 80;

function hexFg(hex: string, text: string): string {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${text}\x1b[39m`;
}

/** Shimmer tiers: dim, then the accent (or muted / accent bold by default). */
function tiers(theme: Theme, accent: WorkingTerm["accent"]): ShimmerTiers {
	if (!accent) return shimmerTiers(theme);
	return {
		low: text => theme.fg("dim", text),
		mid: text => hexFg(accent.main, text),
		high: text => theme.style("strong", hexFg(accent.main, text)),
	};
}

/** `body` with `trailer` docked at the right edge when two cells stay free. */
function docked(body: string, trailer: string | undefined, width: number): string {
	if (!trailer) return body;
	const gap = width - visibleWidth(body) - visibleWidth(trailer);
	return gap >= 2 ? `${body}${" ".repeat(gap)}${trailer}` : body;
}

function paintWorking(node: UiNode, cx: PaintContext): Block {
	const term = termOf<WorkingTerm>(node) as WorkingTerm;
	const theme = cx.theme;
	const label = (key: string): string => keyLabel(theme, key);
	const animated =
		term.look === "maintenance" ? !cx.reduceMotion || term.countdown === true : term.shimmer !== undefined;
	// Reading the clock repaints the row every frame; a still row reads it only for a live label.
	const now = animated || term.live || term.countdown ? cx.now(term.shimmer !== undefined && !cx.reduceMotion) : 0;
	const message = term.message(now, label);
	let lead: string;
	let text: string;
	if (term.look === "maintenance") {
		const frames = theme.symbols.spinnerFrames;
		const frame =
			frames.length === 0 ? "" : frames[cx.reduceMotion ? 0 : Math.floor(now / SPINNER_MS) % frames.length]!;
		lead = theme.fg(term.tone, frame);
		text = theme.fg("muted", message);
	} else {
		const glyph = term.key === undefined ? "" : ` ${label(term.key)}`;
		lead = term.accent ? hexFg(term.accent.dim, glyph) : theme.fg("muted", glyph);
		const looks = tiers(theme, term.accent);
		text = term.shimmer && !cx.reduceMotion ? shimmerText(message, now, term.shimmer, looks) : looks.mid(message);
	}
	const body = truncate(` ${lead} ${text}`, cx.width);
	return { rows: ["", docked(body, term.trailer?.(), cx.width)] };
}

function paintRetryHint(node: UiNode, cx: PaintContext): Block {
	const key = termOf<{ key: string }>(node).key ?? "f5";
	const theme = cx.theme;
	return {
		rows: ["", truncate(`  ${theme.fg("dim", keyLabel(theme, key))}${theme.fg("muted", " to retry")}`, cx.width)],
	};
}

defineRolePainter("row", "omp.working", paintWorking);
defineRolePainter("row", "omp.hint.retry", paintRetryHint);
