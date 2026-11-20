/**
 * Trip planner for the agent arrow: how long a move takes and the path it follows. Pure math, no DOM, so the feel
 * is unit-tested; `pointer.ts` turns a {@link Trip} into Web Animations keyframes.
 */

/** A point in viewport CSS pixels. */
export interface Point {
	x: number;
	y: number;
}

/** The planner's constants: Fitts-style duration, a sideways arc, a small overshoot, and a lean with speed. */
export const TRIP = {
	/** Duration is `baseMs + perBitMs · log2(1 + distance / targetPx)`, clamped to `[minMs, maxMs]`. */
	baseMs: 80,
	perBitMs: 70,
	targetPx: 24,
	minMs: 140,
	maxMs: 380,
	/** Moves shorter than this place the arrow directly. */
	snapPx: 0.5,
	/** Sideways bow as a fraction of the distance, capped. */
	arc: 0.1,
	arcMaxPx: 30,
	/** The arm's elbow direction; the path bows to the side away from it. */
	elbow: { x: 0.6, y: 0.8 },
	/** Distance past the target before the correction, as a fraction of the distance, capped. */
	overshoot: 0.03,
	overshootMaxPx: 4,
	/** Fraction of the timeline at which the main travel has arrived (at the overshoot point). */
	mainEnds: 0.8,
	/** Fraction of the timeline at which the correction back onto the target starts. */
	fixStarts: 0.66,
	/** Path segments; a trip has `steps + 1` samples. */
	steps: 16,
	/** Lean is `leanDeg · tanh(speed / leanAtPxPerMs)`. */
	leanDeg: 9,
	leanAtPxPerMs: 1.8,
} as const;

/** One planned move of the arrow tip. */
export interface Trip {
	/** 0 when the move is too short to animate. */
	durationMs: number;
	/** Tip positions at equal time steps; the first is the start and the last is exactly the target. */
	points: Point[];
	/** Arrow rotation in degrees at each of {@link points}; zero at both ends. */
	leanDeg: number[];
}

/** Minimum-jerk easing `s³(10 − 15s + 6s²)`: zero velocity and acceleration at both ends, clamped outside 0..1. */
export function minimumJerk(s: number): number {
	if (s <= 0) return 0;
	if (s >= 1) return 1;
	return s * s * s * (10 - 15 * s + 6 * s * s);
}

/** How long a move of `distance` CSS pixels takes, in whole ms; 0 below the snap distance. */
export function tripDuration(distance: number): number {
	if (distance < TRIP.snapPx) return 0;
	const ms = TRIP.baseMs + TRIP.perBitMs * Math.log2(1 + distance / TRIP.targetPx);
	return Math.round(Math.max(TRIP.minMs, Math.min(TRIP.maxMs, ms)));
}

/** Plan the arrow tip's path from `from` to `to`: a minimum-jerk reach that bows sideways, overshoots and settles. */
export function planTrip(from: Point, to: Point): Trip {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	const durationMs = tripDuration(distance);
	if (durationMs === 0) return { durationMs, points: [{ x: to.x, y: to.y }], leanDeg: [0] };

	const overshoot = Math.min(TRIP.overshoot * distance, TRIP.overshootMaxPx);
	const side = dx * TRIP.elbow.y - dy * TRIP.elbow.x > 0 ? -1 : 1;
	const arc = side * Math.min(TRIP.arc * distance, TRIP.arcMaxPx);
	const points: Point[] = [];
	for (let i = 0; i <= TRIP.steps; i++) {
		const s = i / TRIP.steps;
		const correction = overshoot * minimumJerk((s - TRIP.fixStarts) / (1 - TRIP.fixStarts));
		// Progress along the straight line, 1 at the target and slightly past it around `mainEnds`.
		const along = ((distance + overshoot) * minimumJerk(s / TRIP.mainEnds) - correction) / distance;
		// Sideways offset as a fraction of the distance, along the line's normal.
		const across = (arc * Math.sin(Math.PI * Math.max(0, Math.min(1, along)))) / distance;
		points.push({ x: from.x + dx * along - dy * across, y: from.y + dy * along + dx * across });
	}
	points[TRIP.steps] = { x: to.x, y: to.y };
	return { durationMs, points, leanDeg: leanAngles(points, durationMs) };
}

/** Where the tip is `elapsedMs` into `trip`: straight between neighbouring samples, as its keyframes play it. */
export function tripPointAt(trip: Trip, elapsedMs: number): Point {
	const last = trip.points.length - 1;
	if (trip.durationMs === 0 || elapsedMs >= trip.durationMs) return trip.points[last];
	const position = (Math.max(0, elapsedMs) / trip.durationMs) * last;
	const index = Math.floor(position);
	const t = position - index;
	const a = trip.points[index];
	const b = trip.points[index + 1];
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Rotation per sample: the arrow tips into its travel, by its speed along the up-right diagonal (the axis its notch
 * lies across), so a move right or up leans clockwise and a move left or down leans back.
 */
function leanAngles(points: readonly Point[], durationMs: number): number[] {
	const last = points.length - 1;
	const stepMs = durationMs / last;
	return points.map((_, i) => {
		if (i === 0 || i === last) return 0;
		const before = points[i - 1];
		const after = points[i + 1];
		const speed = ((after.x - before.x - (after.y - before.y)) * Math.SQRT1_2) / (2 * stepMs);
		return TRIP.leanDeg * Math.tanh(speed / TRIP.leanAtPxPerMs);
	});
}
