import { describe, expect, it } from "bun:test";
import { minimumJerk, type Point, planTrip, tripDuration, tripPointAt } from "../extension/overlay/motion";

const origin: Point = { x: 0, y: 0 };

/** Signed distance of `point` from the line `from → to`; positive is to the right of travel on screen. */
function sideOf(point: Point, from: Point, to: Point): number {
	const length = Math.hypot(to.x - from.x, to.y - from.y);
	return ((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)) / length;
}

describe("trip duration", () => {
	it("snaps moves under half a pixel and never animates faster than 140ms", () => {
		expect(tripDuration(0)).toBe(0);
		expect(tripDuration(0.49)).toBe(0);
		expect(tripDuration(0.5)).toBe(140);
		expect(tripDuration(8)).toBe(140);
	});

	it("grows with the log of the distance and tops out at 380ms", () => {
		// 80 + 70·log2(1 + d/24): 24px is one bit, 72px two, 168px three, 360px four.
		expect(tripDuration(24)).toBe(150);
		expect(tripDuration(72)).toBe(220);
		expect(tripDuration(168)).toBe(290);
		expect(tripDuration(360)).toBe(360);
		expect(tripDuration(5000)).toBe(380);
	});
});

describe("minimum-jerk easing", () => {
	it("starts and ends at rest, symmetric about the midpoint", () => {
		expect(minimumJerk(-1)).toBe(0);
		expect(minimumJerk(0)).toBe(0);
		expect(minimumJerk(0.5)).toBeCloseTo(0.5, 12);
		expect(minimumJerk(1)).toBe(1);
		expect(minimumJerk(2)).toBe(1);
		expect(minimumJerk(0.25) + minimumJerk(0.75)).toBeCloseTo(1, 12);
		// Barely moving right after the start: no visible jump on the first frame.
		expect(minimumJerk(0.05)).toBeLessThan(0.002);
	});
});

describe("planned trip", () => {
	it("has 17 samples that start at the origin and end exactly on the target", () => {
		const to = { x: 412.3, y: -87.6 };
		const trip = planTrip({ x: 10, y: 20 }, to);
		expect(trip.points).toHaveLength(17);
		expect(trip.leanDeg).toHaveLength(17);
		expect(trip.points[0]).toEqual({ x: 10, y: 20 });
		expect(trip.points[16]).toEqual(to);
		expect(trip.durationMs).toBe(tripDuration(Math.hypot(402.3, 107.6)));
	});

	it("places the arrow directly when the move is too short to see", () => {
		const trip = planTrip({ x: 5, y: 5 }, { x: 5.2, y: 5.1 });
		expect(trip.durationMs).toBe(0);
		expect(trip.points).toEqual([{ x: 5.2, y: 5.1 }]);
	});

	it("overshoots by 3% of the distance, capped at 4px, and settles back", () => {
		const along = (trip: { points: Point[] }) => Math.max(...trip.points.map(point => point.x));
		// 100px: 3px past the target at the end of the main travel (sample 13 of 16 is closest to 0.8).
		expect(along(planTrip(origin, { x: 100, y: 0 })) - 100).toBeGreaterThan(1.5);
		expect(along(planTrip(origin, { x: 100, y: 0 })) - 100).toBeLessThanOrEqual(3);
		// 600px would be 18px uncapped.
		expect(along(planTrip(origin, { x: 600, y: 0 })) - 600).toBeGreaterThan(2);
		expect(along(planTrip(origin, { x: 600, y: 0 })) - 600).toBeLessThanOrEqual(4);
	});

	it("only ever moves forward until the overshoot, then only back", () => {
		const xs = planTrip(origin, { x: 300, y: 0 }).points.map(point => point.x);
		const peak = xs.indexOf(Math.max(...xs));
		for (let i = 1; i <= peak; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
		for (let i = peak + 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1]);
		expect(peak).toBeGreaterThanOrEqual(11);
	});

	it("bows sideways by a tenth of the distance, capped at 30px", () => {
		const bow = (to: Point) =>
			Math.max(...planTrip(origin, to).points.map(point => Math.abs(sideOf(point, origin, to))));
		expect(bow({ x: 100, y: 0 })).toBeGreaterThan(9);
		expect(bow({ x: 100, y: 0 })).toBeLessThanOrEqual(10);
		expect(bow({ x: 0, y: 900 })).toBeGreaterThan(28);
		expect(bow({ x: 0, y: 900 })).toBeLessThanOrEqual(30);
	});

	it("bows away from the elbow whichever way it travels", () => {
		// The elbow points down-right, so a move left or right arcs over the top and a move up or down swings left.
		expect(planTrip(origin, { x: 200, y: 0 }).points[8].y).toBeLessThan(-10);
		expect(planTrip(origin, { x: -200, y: 0 }).points[8].y).toBeLessThan(-10);
		expect(planTrip(origin, { x: 0, y: 200 }).points[8].x).toBeLessThan(-10);
		expect(planTrip(origin, { x: 0, y: -200 }).points[8].x).toBeLessThan(-10);
		// The side of travel it bows to flips exactly at the elbow direction (0.6, 0.8).
		const midSide = (to: Point) => Math.sign(sideOf(planTrip(origin, to).points[8], origin, to));
		expect(midSide({ x: 60, y: 79 })).toBe(-1);
		expect(midSide({ x: 60, y: 81 })).toBe(1);
	});

	it("leans into fast travel and stands upright at both ends", () => {
		const right = planTrip(origin, { x: 800, y: 0 }).leanDeg;
		expect(right[0]).toBe(0);
		expect(right[16]).toBe(0);
		expect(Math.max(...right)).toBeGreaterThan(6);
		expect(Math.max(...right)).toBeLessThan(9);
		// The opposite move leans the other way by the same amount, and a slow short move barely leans.
		const left = planTrip(origin, { x: -800, y: 0 }).leanDeg;
		expect(Math.min(...left)).toBeCloseTo(-Math.max(...right), 1);
		expect(Math.max(...planTrip(origin, { x: 12, y: 0 }).leanDeg.map(Math.abs))).toBeLessThan(1);
	});
});

describe("position during a trip", () => {
	const trip = planTrip({ x: 50, y: 50 }, { x: 450, y: 250 });

	it("is the start before it begins and the target once it is over", () => {
		expect(tripPointAt(trip, -10)).toEqual({ x: 50, y: 50 });
		expect(tripPointAt(trip, 0)).toEqual({ x: 50, y: 50 });
		expect(tripPointAt(trip, trip.durationMs)).toEqual({ x: 450, y: 250 });
		expect(tripPointAt(trip, trip.durationMs + 500)).toEqual({ x: 450, y: 250 });
	});

	it("hits each sample on its time step and runs straight between neighbours", () => {
		const step = trip.durationMs / 16;
		expect(tripPointAt(trip, step * 5).x).toBeCloseTo(trip.points[5].x, 9);
		expect(tripPointAt(trip, step * 5).y).toBeCloseTo(trip.points[5].y, 9);
		const between = tripPointAt(trip, step * 5.25);
		expect(between.x).toBeCloseTo(trip.points[5].x * 0.75 + trip.points[6].x * 0.25, 9);
		expect(between.y).toBeCloseTo(trip.points[5].y * 0.75 + trip.points[6].y * 0.25, 9);
	});

	it("lets a redirected trip start from where the arrow is, not where it was headed", () => {
		const halfway = tripPointAt(trip, trip.durationMs / 2);
		const redirected = planTrip(halfway, { x: 60, y: 400 });
		expect(redirected.points[0]).toEqual(halfway);
		expect(redirected.durationMs).toBe(tripDuration(Math.hypot(60 - halfway.x, 400 - halfway.y)));
	});

	it("is the target for a trip that was never animated", () => {
		expect(tripPointAt(planTrip(origin, { x: 0.1, y: 0 }), 0)).toEqual({ x: 0.1, y: 0 });
	});
});
