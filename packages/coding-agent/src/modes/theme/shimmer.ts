import { isSettingsInitialized, settings } from "../../config/settings";
import type { Theme, ThemeColor } from "./theme";

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
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
type ShimmerMode = "classic" | "kitt" | "disabled";

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
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	// Fixed-velocity, un-floored band position: advancing at a constant
	// cells/second (not period / fixed-sweep) keeps the per-frame step ≤1 cell at
	// the default cadence for any length, so long messages are no steppier.
	const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * bar with a quadratic-decay trail behind it. No leading glow — LEDs don't
 * predict the future.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	// Fixed head velocity: a triangle ping-pong over a 2*range round trip at a
	// constant cells/second, so the bright head advances ≤1 cell per frame at the
	// default cadence regardless of bar length. Round-trip duration scales with length.
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
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

function resolveMode(): ShimmerMode {
	if (!isSettingsInitialized()) return "classic";
	return settings.get("display.shimmer");
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
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
	const mode = resolveMode();

	// Pre-scan: total code-point count (positions the band) and resolved palette.
	// The per-segment string is kept verbatim — iterating UTF-16 units with a
	// surrogate-pair guard produces the same code points as `Array.from(text)`
	// at zero per-frame allocation (previously the #1 hotspot at ~10% of profiled
	// CPU during streaming — the working message is shimmered every animation
	// frame at 30fps and `Array.from` reallocated the code-point array each tick).
	let total = 0;
	const perSeg: { text: string; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		total += countCodePoints(seg.text);
		perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

	// Disabled: no animation, no per-char work. Paint each segment in its mid
	// tier so the working line stays legible without movement.
	if (mode === "disabled") {
		let out = "";
		for (const { text, palette } of perSeg) {
			const seq = compile(theme, palette).mid;
			out += `${seq.open}${text}${seq.close}`;
		}
		return out;
	}

	const time = Date.now();
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	// Fast-path window: outside `[bandLo, bandHi]` the intensity is guaranteed
	// zero (tier "low"), so we can skip `intensityFn` + `tierFor` entirely for
	// the prefix/suffix of every segment. On the typical ~60-char working
	// message the classic band spans ~12 cells, so ~80% of the per-char loop
	// disappears — the intensity call and the tier compare were the residual
	// per-frame cost after #4353 removed the allocation hotspot (issue #4377).
	const { lo: bandLo, hi: bandHi } = activeBand(mode, time, total);

	let out = "";
	let index = 0;
	for (const { text, palette } of perSeg) {
		const compiled = compile(theme, palette);
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
			const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(intensityFn(time, index, total));
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

/**
 * Sweep window (code-point indices) outside which the intensity is guaranteed
 * zero for `mode` at `time` over `total` cells. Widening the window is safe —
 * the per-char intensity call still runs inside the window and reports 0 for
 * off-band code points — but narrower windows skip more of the per-char loop.
 */
function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
		return {
			lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
			hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
		};
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	// The trail always lies behind the head for the current direction — chars
	// ahead of the head are dark. See {@link kittIntensity} for the exact rule.
	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
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
