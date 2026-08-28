import { describe, expect, it } from "bun:test";

import type { TokenTelemetryEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";
import { accountTokens } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";
import { projectTokenBreakdown } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-breakdown";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

function ev(stage: string, before: number, after: number, fidelityClass?: string): TokenTelemetryEvent {
	return accountTokens(before, after, { stage, fidelityClass, now: NOW });
}

describe("token-breakdown", () => {
	it("returns an inert report for undefined or empty input", () => {
		expect(projectTokenBreakdown(undefined).eventCount).toBe(0);
		expect(projectTokenBreakdown([]).totalSaved).toBe(0);
		expect(projectTokenBreakdown([]).mode).toBe("observe");
	});

	it("skips malformed events instead of throwing", () => {
		const junk = [null, 42, { kind: "other" }, { kind: "acf.token-accounting", stage: 7 }];
		const report = projectTokenBreakdown(junk as unknown as TokenTelemetryEvent[]);
		expect(report.eventCount).toBe(0);
	});

	it("aggregates totals and percent saved", () => {
		const report = projectTokenBreakdown([ev("distill", 100, 40), ev("dedup", 100, 60)]);
		expect(report.eventCount).toBe(2);
		expect(report.totalBefore).toBe(200);
		expect(report.totalAfter).toBe(100);
		expect(report.totalSaved).toBe(100);
		expect(report.percentSaved).toBe(50);
	});

	it("counts growth and reports a negative saved total", () => {
		const report = projectTokenBreakdown([ev("distill", 10, 25)]);
		expect(report.grewCount).toBe(1);
		expect(report.totalSaved).toBe(-15);
		expect(report.percentSaved).toBe(-150);
	});

	it("averages per-event ratios", () => {
		const report = projectTokenBreakdown([ev("a", 100, 50), ev("b", 100, 100)]);
		expect(report.avgRatio).toBeCloseTo(0.75, 5);
	});

	it("groups by stage sorted by key", () => {
		const report = projectTokenBreakdown([ev("dedup", 10, 5), ev("coverage", 20, 10), ev("dedup", 10, 10)]);
		expect(report.byStage.map(g => g.key)).toEqual(["coverage", "dedup"]);
		expect(report.byStage[1]?.eventCount).toBe(2);
		expect(report.byStage[1]?.saved).toBe(5);
	});

	it("groups by fidelity class and skips events without one", () => {
		const report = projectTokenBreakdown([ev("a", 10, 5, "F1"), ev("b", 10, 5), ev("c", 30, 10, "F1")]);
		expect(report.byFidelity).toHaveLength(1);
		expect(report.byFidelity[0]?.key).toBe("F1");
		expect(report.byFidelity[0]?.eventCount).toBe(2);
		expect(report.byFidelity[0]?.saved).toBe(25);
	});

	it("filters by stage when requested", () => {
		const events = [ev("distill", 10, 5), ev("dedup", 20, 10)];
		const report = projectTokenBreakdown(events, { stages: ["dedup"] });
		expect(report.eventCount).toBe(1);
		expect(report.totalSaved).toBe(10);
	});

	it("filters by fidelity class when requested", () => {
		const events = [ev("a", 10, 5, "F1"), ev("a", 10, 5, "F2"), ev("a", 10, 5)];
		const report = projectTokenBreakdown(events, { fidelityClasses: ["F2"] });
		expect(report.eventCount).toBe(1);
	});

	it("returns the inert report when filters exclude everything", () => {
		const report = projectTokenBreakdown([ev("distill", 10, 5)], { stages: ["nope"] });
		expect(report.eventCount).toBe(0);
		expect(report.byStage).toEqual([]);
	});

	it("computes per-group percent saved and growth counts", () => {
		const report = projectTokenBreakdown([ev("s", 100, 25), ev("s", 10, 20)]);
		const group = report.byStage[0];
		expect(group?.percentSaved).toBe(59);
		expect(group?.grewCount).toBe(1);
	});

	it("does not mutate the input array", () => {
		const events = [ev("a", 10, 5)];
		const snapshot = [...events];
		projectTokenBreakdown(events, { stages: ["a"] });
		expect(events).toEqual(snapshot);
	});
});
