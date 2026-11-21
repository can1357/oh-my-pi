import { describe, expect, it } from "bun:test";
import { buildLaneAxes, firstVisible } from "../src/client/traces/TimelineCanvas";

const identity = { toU: (t: number) => t };

function axisFor(spans: Array<{ start: number; end: number }>) {
	return buildLaneAxes({ lanes: [{ spans }] }, identity)[0];
}

describe("timeline lane axes", () => {
	it("keeps a long span that started early visible in a later viewport", () => {
		// Span 0 covers the whole viewport; later spans all end before it.
		const axis = axisFor([
			{ start: 0, end: 1000 },
			{ start: 10, end: 20 },
			{ start: 30, end: 40 },
			{ start: 50, end: 60 },
		]);
		expect(Array.from(axis.maxEndU)).toEqual([1000, 1000, 1000, 1000]);
		expect(firstVisible(axis.maxEndU, 500)).toBe(0);
	});

	it("skips spans that end before the viewport", () => {
		const axis = axisFor([
			{ start: 0, end: 10 },
			{ start: 20, end: 30 },
			{ start: 40, end: 50 },
		]);
		expect(firstVisible(axis.maxEndU, 25)).toBe(1);
	});

	it("returns the lane length when the viewport starts past every end", () => {
		const axis = axisFor([
			{ start: 0, end: 10 },
			{ start: 20, end: 30 },
		]);
		expect(firstVisible(axis.maxEndU, 31)).toBe(2);
	});

	it("handles an empty lane", () => {
		const axis = axisFor([]);
		expect(axis.maxEndU.length).toBe(0);
		expect(firstVisible(axis.maxEndU, 0)).toBe(0);
	});
});
