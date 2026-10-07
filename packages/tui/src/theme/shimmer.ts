import { isReduceMotion } from "../reduce-motion";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { node } from "../native/describe";
import type { NativeNode } from "../native/node";
import { isNativeRendering } from "../native/state";
import type { Theme, ThemeColor } from "./theme";
import { FG_RESET } from "./color";

// ─── Animation velocity ──────────────────────────────────────────────────────
// Band/head travel speed in border cells per second. Driving position by a fixed
// velocity — instead of dividing a fixed sweep duration by the (length-derived)
// period — makes smoothness independent of message length: at the loader's
// default 30fps redraw cadence the band advances ≤1 cell per frame for any
// string, so it never visibly steps. Sweep/round-trip durations now scale with
// length. Keep ≤ the animated redraw fps (loader RENDER_INTERVAL_MS = 1000/30).
const SHIMMER_SPEED_CELLS_PER_S = 30;

// ─── Classic sweep tunables ──────────────────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

// ─── KITT scanner tunables ───────────────────────────────────────────────────
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

// ─── Tier thresholds ─────────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

// ─── Raw ANSI codes ──────────────────────────────────────────────────────────
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
/** Sweep style for animated shimmer text; `disabled` renders every tier as the mid color. */
export type ShimmerMode = "classic" | "kitt" | "disabled";

let activeMode: ShimmerMode = "classic";

/** Select the shimmer sweep style. The host pushes its `display.shimmer` preference here. */
export function setShimmerMode(mode: ShimmerMode): void {
	activeMode = mode;
}

type ShimmerPaletteTier = ThemeColor | { ansi: string };

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

/** Three-tier color stack a shimmer character cycles through as the band sweeps. */
export interface ShimmerPalette {
	/** Color for chars outside / at the edge of the band (intensity < ~0.22). */
	low: ShimmerPaletteTier;
	/** Color for chars approaching the crest (~0.22 ≤ intensity < ~0.65). */
	mid: ShimmerPaletteTier;
	/** Color at the band's crest (intensity ≥ ~0.65). */
	high: ShimmerPaletteTier;
	/** Whether to bold the crest tier. Default `false`. */
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

// ─── Palette compilation cache ───────────────────────────────────────────────
// Resolving ANSI codes for every character was the dominant per-frame cost.
// We resolve once per (theme, palette) pair into ready-to-concat prefix/suffix
// strings, then coalesce same-tier runs at render time so each frame emits a
// handful of escape sequences instead of one per code point.
//
// The cache is stashed as a Symbol-keyed slot directly on the palette object
// — no module-level sidecar — and invalidates when the active Theme changes.
interface TierSeq {
	open: string;
	close: string;
}
interface CompiledPalette {
	low: TierSeq;
	mid: TierSeq;
	high: TierSeq;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
	[kCompiledFor]?: ShimmerTheme;
	[kCompiled]?: CompiledPalette;
}

function compile(theme: ShimmerTheme, palette: ShimmerPalette): CompiledPalette {
	const p = palette as ShimmerPalette & PaletteCache;
	const cached = p[kCompiled];
	if (cached && p[kCompiledFor] === theme) return cached;
	const lowOpen = resolveTierAnsi(theme, palette.low);
	const midOpen = resolveTierAnsi(theme, palette.mid);
	const highColorOpen = resolveTierAnsi(theme, palette.high);
	const highOpen = palette.bold ? `${BOLD_OPEN}${highColorOpen}` : highColorOpen;
	const highClose = palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET;
	const out: CompiledPalette = {
		low: { open: lowOpen, close: FG_RESET },
		mid: { open: midOpen, close: FG_RESET },
		high: { open: highOpen, close: highClose },
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

// ─── Intensity profiles ──────────────────────────────────────────────────────
/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(index: number, position: number): number {
	const dist = Math.abs(index + CLASSIC_PADDING - position);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * bar with a quadratic-decay trail behind it. No leading glow — LEDs don't
 * predict the future.
 */
function kittIntensity(index: number, head: number, goingRight: boolean): number {
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	// Only chars *behind* the head light up — direction-dependent.
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return activeMode !== "disabled" && !isReduceMotion();
}

/**
 * Describe shimmering segments for a TSP terminal, which clocks the sweep
 * itself: a `shimmer` node in the active mode, or plain spans in the mid tier
 * color when shimmer is disabled. Palette tiers given as theme colors travel as
 * token names; raw-ANSI tiers are dropped (the terminal's theme decides).
 */
export function describeShimmer(segments: readonly ShimmerSegment[], key?: string): NativeNode {
	const spans: TspSpan[] = [];
	for (const { text: value, palette } of segments) {
		if (value.length === 0) continue;
		const mid = (palette ?? DEFAULT_SHIMMER_PALETTE).mid;
		spans.push(typeof mid === "string" ? { t: value, s: mid } : { t: value });
	}
	if (activeMode === "disabled" || isReduceMotion()) return node("text", { spans }, undefined, key);
	const palette = segments[0]?.palette ?? DEFAULT_SHIMMER_PALETTE;
	const tokens: { low?: string; mid?: string; high?: string } = {};
	if (typeof palette.low === "string") tokens.low = palette.low;
	if (typeof palette.mid === "string") tokens.mid = palette.mid;
	if (typeof palette.high === "string") tokens.high = palette.high;
	return node("shimmer", { spans, mode: activeMode, palette: tokens }, undefined, key);
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a
 * single continuous string for band positioning. Each segment can supply
 * its own palette so the gradient stays in lockstep while the colors
 * differ.
 *
 * Performance shape (per call, dominant cost):
 *   - One `Date.now()` read.
 *   - One `compile()` lookup per segment (Symbol-keyed cache slot, hot path
 *     skipped after first frame).
 *   - One ANSI open/close pair per **run of same-tier chars**, not per char.
 *   - No per-char allocations beyond the run buffer.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	// A TSP terminal animates shimmer from described nodes; a frame painted
	// here would freeze mid-sweep, so the text goes out unstyled.
	if (isNativeRendering()) {
		let out = "";
		for (const { text: value } of segments) out += value;
		return out;
	}
	const mode = isReduceMotion() ? "disabled" : activeMode;

	// Disabled: no animation or code-point scan. Preserve the all-empty result,
	// but include empty segments' ANSI pairs when any segment has text.
	if (mode === "disabled") {
		let hasText = false;
		for (const { text } of segments) {
			if (text.length > 0) {
				hasText = true;
				break;
			}
		}
		if (!hasText) return "";
		let out = "";
		for (const { text, palette } of segments) {
			const seq = compile(theme, palette ?? DEFAULT_SHIMMER_PALETTE).mid;
			out += `${seq.open}${text}${seq.close}`;
		}
		return out;
	}

	// Position the band in code points without copying the segments or splitting
	// their strings. Surrogate pairs are counted independently in each segment.
	let total = 0;
	for (const { text } of segments) total += countCodePoints(text);
	if (total === 0) return "";

	// Fixed velocity keeps the per-frame step independent of message length.
	// Share the frame's phase/head between the window and every active character.
	const travel = (Date.now() / 1000) * SHIMMER_SPEED_CELLS_PER_S;
	const isKitt = mode === "kitt";
	let position: number;
	let goingRight = true;
	let bandLo: number;
	let bandHi: number;
	if (isKitt) {
		const range = total - 1;
		if (range <= 0) {
			position = 0;
		} else {
			const cycleCells = 2 * range;
			const sweep = travel % cycleCells;
			goingRight = sweep < range;
			position = goingRight ? sweep : cycleCells - sweep;
		}
		// Only the head and its direction-dependent trailing cells can light up.
		bandLo = goingRight ? position - KITT_HEAD_HALF - KITT_TRAIL_LEN : position - KITT_HEAD_HALF;
		bandHi = goingRight ? position + KITT_HEAD_HALF : position + KITT_HEAD_HALF + KITT_TRAIL_LEN;
	} else {
		position = travel % (total + CLASSIC_PADDING * 2);
		bandLo = position - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH;
		bandHi = position - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH;
	}

	// Outside this window intensity is zero, so skip the intensity and tier
	// calculations for the low-tier prefix/suffix of every segment.
	const intensityFn = isKitt ? kittIntensity : classicIntensity;

	let out = "";
	let index = 0;
	for (const { text, palette } of segments) {
		const compiled = compile(theme, palette ?? DEFAULT_SHIMMER_PALETTE);
		let runTier: Tier | null = null;
		let runStart = 0;
		let runEnd = 0;
		let i = 0;
		while (i < text.length) {
			// Detect a surrogate pair so a single code point (e.g. an emoji) stays
			// atomic; the band position is measured in code points, not UTF-16 units.
			const c = text.charCodeAt(i);
			let step = 1;
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				const c2 = text.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) step = 2;
			}
			const tier: Tier =
				index < bandLo || index > bandHi ? "low" : tierFor(intensityFn(index, position, goingRight));
			if (tier !== runTier) {
				if (runTier !== null && runEnd > runStart) {
					const seq = compiled[runTier];
					out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
				}
				runTier = tier;
				runStart = i;
			}
			runEnd = i + step;
			index++;
			i += step;
		}
		if (runTier !== null && runEnd > runStart) {
			const seq = compiled[runTier];
			out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
		}
	}
	return out;
}

function countCodePoints(text: string): number {
	let n = 0;
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				i += 2;
				n++;
				continue;
			}
		}
		i++;
		n++;
	}
	return n;
}

export function shimmerText(text: string, theme: ShimmerTheme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}
