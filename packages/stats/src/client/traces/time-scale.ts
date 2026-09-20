/**
 * Virtual time axis for the trace flamegraph.
 *
 * All three axis modes are piecewise-linear monotonic maps over global wall
 * time, so cross-track alignment is preserved in every mode:
 * - `time`: identity, or idle-compressed (long gaps collapse to fixed bridges)
 * - `turns`: each main-track turn interval gets equal virtual width
 * - `calls`: each interval between consecutive span boundaries gets equal width
 */

import type { TraceTrack } from "../types";

export type AxisMode = "time" | "turns" | "calls";

export interface TraceScale {
	/** ms epoch → virtual axis; monotonic non-decreasing. */
	toU(t: number): number;
	/** Inverse (clamped to domain). */
	toT(u: number): number;
	/** Virtual axis domain. */
	domain: [number, number];
	/** Idle bridges (time mode + compression): real gap [t0,t1] at virtual uMid. */
	gaps: Array<{ t0: number; t1: number; uMid: number }>;
}

/** Padding added around activity segments before gap detection (ms). */
const ACTIVITY_PAD_MS = 2000;
/** Gaps longer than this get compressed (ms). */
const GAP_THRESHOLD_MS = 30_000;
/** Fixed virtual width of a compressed gap bridge (virtual ms). */
const GAP_BRIDGE_U = 8000;

/** Piecewise-linear map defined by matched breakpoints (t ascending, u non-decreasing). */
function piecewise(tPoints: number[], uPoints: number[]): TraceScale {
	const n = tPoints.length;
	const domain: [number, number] = [uPoints[0], uPoints[n - 1]];

	const segmentAt = (points: number[], value: number): number => {
		// Binary search for the last breakpoint <= value.
		let lo = 0;
		let hi = n - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (points[mid] <= value) lo = mid;
			else hi = mid - 1;
		}
		return Math.min(lo, n - 2);
	};

	return {
		toU(t: number): number {
			if (t <= tPoints[0]) return uPoints[0];
			if (t >= tPoints[n - 1]) return uPoints[n - 1];
			const i = segmentAt(tPoints, t);
			const tSpan = tPoints[i + 1] - tPoints[i];
			if (tSpan <= 0) return uPoints[i];
			return uPoints[i] + ((t - tPoints[i]) / tSpan) * (uPoints[i + 1] - uPoints[i]);
		},
		toT(u: number): number {
			if (u <= uPoints[0]) return tPoints[0];
			if (u >= uPoints[n - 1]) return tPoints[n - 1];
			const i = segmentAt(uPoints, u);
			const uSpan = uPoints[i + 1] - uPoints[i];
			if (uSpan <= 0) return tPoints[i];
			return tPoints[i] + ((u - uPoints[i]) / uSpan) * (tPoints[i + 1] - tPoints[i]);
		},
		domain,
		gaps: [],
	};
}

/** All span intervals across tracks, sorted by start. */
function collectIntervals(tracks: TraceTrack[]): Array<[number, number]> {
	const intervals: Array<[number, number]> = [];
	for (const track of tracks) {
		for (const span of track.spans) intervals.push([span.start, span.end]);
	}
	intervals.sort((a, b) => a[0] - b[0]);
	return intervals;
}

/** Trace time bounds across all spans (falls back to [0, 1]). */
function traceBounds(tracks: TraceTrack[]): [number, number] {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const track of tracks) {
		for (const span of track.spans) {
			if (span.start < min) min = span.start;
			if (span.end > max) max = span.end;
		}
	}
	if (!Number.isFinite(min)) return [0, 1];
	return [min, Math.max(max, min + 1)];
}

/** Equal-virtual-width map over consecutive anchor times. */
function equalWidthScale(anchors: number[], tMin: number, tMax: number): TraceScale {
	const unique = [...new Set(anchors.filter(t => t >= tMin && t <= tMax))].sort((a, b) => a - b);
	if (unique[0] !== tMin) unique.unshift(tMin);
	if (unique[unique.length - 1] !== tMax) unique.push(tMax);
	if (unique.length < 2) return piecewise([tMin, tMax], [tMin, tMax]);
	// Keep the virtual domain the same length as the real one so zoom math is
	// scale-independent; each anchor interval gets an equal slice of it.
	const total = tMax - tMin;
	const step = total / (unique.length - 1);
	const uPoints = unique.map((_, i) => tMin + i * step);
	return piecewise(unique, uPoints);
}

/** Idle-compressed time scale: activity segments identity, long gaps bridged. */
function compressedTimeScale(tracks: TraceTrack[], tMin: number, tMax: number): TraceScale {
	const intervals = collectIntervals(tracks);
	// Merge padded activity intervals into segments.
	const segments: Array<[number, number]> = [];
	for (const [s, e] of intervals) {
		const start = s - ACTIVITY_PAD_MS;
		const end = e + ACTIVITY_PAD_MS;
		const last = segments[segments.length - 1];
		if (last && start <= last[1]) {
			if (end > last[1]) last[1] = end;
		} else {
			segments.push([start, end]);
		}
	}
	if (segments.length === 0) segments.push([tMin, tMax]);
	// Clamp to the trace bounds.
	segments[0][0] = Math.max(segments[0][0], tMin);
	segments[segments.length - 1][1] = Math.min(
		Math.max(segments[segments.length - 1][1], segments[segments.length - 1][0]),
		tMax,
	);

	const tPoints: number[] = [];
	const uPoints: number[] = [];
	const gaps: TraceScale["gaps"] = [];
	let u = segments[0][0];
	for (let i = 0; i < segments.length; i++) {
		const [s, e] = segments[i];
		if (i === 0) {
			tPoints.push(s);
			uPoints.push(u);
		} else {
			const prevEnd = segments[i - 1][1];
			const gap = s - prevEnd;
			if (gap > GAP_THRESHOLD_MS) {
				u += GAP_BRIDGE_U;
				gaps.push({ t0: prevEnd, t1: s, uMid: u - GAP_BRIDGE_U / 2 });
			} else {
				u += gap;
			}
			tPoints.push(s);
			uPoints.push(u);
		}
		u += Math.max(0, e - s);
		tPoints.push(e);
		uPoints.push(u);
	}
	const scale = piecewise(tPoints, uPoints);
	return { ...scale, gaps };
}

/** Build the axis map for the given mode over all tracks. */
export function buildScale(tracks: TraceTrack[], mode: AxisMode, compressIdle: boolean): TraceScale {
	const [tMin, tMax] = traceBounds(tracks);

	if (mode === "turns") {
		const main = tracks.find(track => track.id === "main");
		const anchors = (main?.spans ?? []).filter(span => span.kind === "turn").map(span => span.start);
		return equalWidthScale(anchors, tMin, tMax);
	}
	if (mode === "calls") {
		const anchors: number[] = [];
		for (const track of tracks) {
			for (const span of track.spans) {
				if (span.kind === "model" || span.kind === "tool" || span.kind === "background") {
					anchors.push(span.start, span.end);
				}
			}
		}
		return equalWidthScale(anchors, tMin, tMax);
	}
	if (compressIdle) return compressedTimeScale(tracks, tMin, tMax);
	return piecewise([tMin, tMax], [tMin, tMax]);
}

export interface Tick {
	u: number;
	label: string;
	major: boolean;
}

/** Target pixel spacing between ticks. */
const TICK_TARGET_PX = 90;

/** Round a raw step up to a "nice" 1/2/5 × 10ⁿ ms step. */
function niceStep(raw: number): number {
	const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
	for (const mult of [1, 2, 5, 10]) {
		if (pow * mult >= raw) return pow * mult;
	}
	return pow * 10;
}

function formatWallClock(t: number): string {
	const date = new Date(t);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/** Offset label from trace start: `+mm:ss.mmm`, hours prepended when needed. */
export function formatOffset(deltaMs: number): string {
	const sign = deltaMs < 0 ? "-" : "+";
	const abs = Math.abs(deltaMs);
	const hours = Math.floor(abs / 3_600_000);
	const minutes = Math.floor((abs % 3_600_000) / 60_000);
	const seconds = Math.floor((abs % 60_000) / 1000);
	const millis = Math.floor(abs % 1000);
	const withMs = abs % 1000 !== 0;
	const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${withMs ? "." : ""}${withMs ? String(millis).padStart(3, "0") : ""}`;
	return hours > 0 ? `${sign}${hours}:${mmss}` : `${sign}${mmss}`;
}

/**
 * Ruler ticks inside `[u0, u1]`. Ticks are placed at nice wall-time steps in
 * the underlying t-space (per linear segment in compressed/sequence modes),
 * with major ticks labelled as local wall clock and minors as offsets.
 */
export function buildTicks(scale: TraceScale, u0: number, u1: number, widthPx: number): Tick[] {
	const uSpan = u1 - u0;
	if (uSpan <= 0 || widthPx <= 0) return [];
	const ticks: Tick[] = [];
	const d0 = scale.domain[0];
	// Nice step in u-space (u is virtual milliseconds).
	const step = niceStep((uSpan * TICK_TARGET_PX) / widthPx);
	// Anchor the grid to the trace start so offset labels come out round.
	const first = d0 + Math.ceil((u0 - d0) / step) * step;
	let count = 0;
	for (let u = first; u <= u1 && count < 200; u += step, count++) {
		const t = scale.toT(u);
		const major = Math.round((u - d0) / step) % 5 === 0;
		ticks.push({
			u,
			label: major ? formatWallClock(t) : formatOffset(u - d0),
			major,
		});
	}
	return ticks;
}
