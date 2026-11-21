/**
 * Contracts for the trace axis scale: identity time mode, idle-compression
 * bridge math, equal-width turn/call modes, and ruler tick placement.
 */

import { describe, expect, it } from "bun:test";
import { buildScale, buildTicks } from "@oh-my-pi/omp-stats/client/traces/time-scale";
import type { TraceSpan, TraceTrack } from "@oh-my-pi/omp-stats/types";

const B = 1_700_000_000_000;

function span(start: number, end: number, kind: TraceSpan["kind"] = "model"): TraceSpan {
	return { id: `${kind}:${start}`, kind, start, end, label: kind };
}

function track(id: string, spans: TraceSpan[]): TraceTrack {
	return {
		id,
		parentId: id === "main" ? null : "main",
		label: id,
		agent: null,
		model: null,
		file: id,
		spans,
		markers: [],
	};
}

describe("buildScale", () => {
	it("time mode without compression is the identity over the trace bounds", () => {
		const tracks = [track("main", [span(B, B + 10_000), span(B + 40_000, B + 100_000)])];
		const scale = buildScale(tracks, "time", false);
		expect(scale.domain).toEqual([B, B + 100_000]);
		expect(scale.gaps).toEqual([]);
		for (const t of [B, B + 5000, B + 42_000, B + 100_000]) {
			expect(scale.toU(t)).toBe(t);
			expect(scale.toT(scale.toU(t))).toBe(t);
		}
	});

	it("compresses gaps over 30s to a fixed 8s bridge and stays monotonic and invertible", () => {
		// Two activity clusters separated by a 96s idle gap (after ±2s padding).
		const tracks = [track("main", [span(B, B + 10_000), span(B + 110_000, B + 120_000)])];
		const scale = buildScale(tracks, "time", true);

		expect(scale.gaps.length).toBe(1);
		expect(scale.gaps[0].t0).toBe(B + 12_000);
		expect(scale.gaps[0].t1).toBe(B + 108_000);

		// The 96s real gap occupies exactly 8s of virtual axis.
		expect(scale.toU(B + 108_000) - scale.toU(B + 12_000)).toBe(8000);

		// Strictly monotonic over a sweep, and invertible inside activity segments.
		let prev = Number.NEGATIVE_INFINITY;
		for (let t = B; t <= B + 120_000; t += 1000) {
			const u = scale.toU(t);
			expect(u).toBeGreaterThanOrEqual(prev);
			prev = u;
		}
		for (const t of [B + 500, B + 9000, B + 111_000, B + 119_500]) {
			expect(scale.toT(scale.toU(t))).toBeCloseTo(t, 6);
		}
	});

	it("turns mode gives each main-track turn interval equal virtual width", () => {
		const tracks = [
			track("main", [
				span(B, B + 5000, "turn"),
				span(B + 10_000, B + 20_000, "turn"),
				span(B + 40_000, B + 100_000, "turn"),
				span(B + 40_000, B + 100_000, "model"),
			]),
		];
		const scale = buildScale(tracks, "turns", false);
		// Anchors: B, B+10k, B+40k, B+100k → three equal intervals.
		const w1 = scale.toU(B + 10_000) - scale.toU(B);
		const w2 = scale.toU(B + 40_000) - scale.toU(B + 10_000);
		const w3 = scale.toU(B + 100_000) - scale.toU(B + 40_000);
		expect(w1).toBeCloseTo(w2, 2);
		expect(w2).toBeCloseTo(w3, 2);
	});

	it("calls mode gives each span-boundary interval equal virtual width", () => {
		const tracks = [track("main", [span(B, B + 10_000), span(B + 50_000, B + 60_000)])];
		const scale = buildScale(tracks, "calls", false);
		// Anchors: B, B+10k, B+50k, B+60k → three equal intervals over a 60k domain.
		expect(scale.toU(B + 10_000) - scale.toU(B)).toBeCloseTo(20_000, 6);
		expect(scale.toU(B + 50_000) - scale.toU(B + 10_000)).toBeCloseTo(20_000, 6);
		expect(scale.toU(B + 60_000) - scale.toU(B + 50_000)).toBeCloseTo(20_000, 6);
	});
});

describe("buildTicks", () => {
	it("places round-offset ticks strictly inside the window with usable pixel spacing", () => {
		const tracks = [track("main", [span(B, B + 100_000)])];
		const scale = buildScale(tracks, "time", false);
		const widthPx = 900;
		const ticks = buildTicks(scale, B, B + 100_000, widthPx);

		expect(ticks.length).toBeGreaterThanOrEqual(5);
		const pxPerU = widthPx / 100_000;
		for (let i = 0; i < ticks.length; i++) {
			expect(ticks[i].u).toBeGreaterThanOrEqual(B);
			expect(ticks[i].u).toBeLessThanOrEqual(B + 100_000);
			// Offsets from the trace start are round multiples of the step.
			expect((ticks[i].u - B) % 1000).toBe(0);
			if (i > 0) {
				expect((ticks[i].u - ticks[i - 1].u) * pxPerU).toBeGreaterThanOrEqual(60);
			}
		}
		// Minor ticks are labelled as offsets from the trace start.
		const minor = ticks.find(tick => !tick.major);
		expect(minor?.label.startsWith("+")).toBe(true);
	});
});
