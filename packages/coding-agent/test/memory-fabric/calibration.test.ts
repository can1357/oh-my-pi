import { describe, expect, it } from "bun:test";

import {
	aggregateMetrics,
	type CalibrationSample,
	calibrate,
	calibratePerProject,
	DEFAULT_CALIBRATION_PARAMETERS,
	decideRegime,
	sampleFromPacketUtilization,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/calibration";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

function sample(overrides: Partial<CalibrationSample> = {}): CalibrationSample {
	return {
		projectId: "p1",
		tokenUtilizationRate: 0.7,
		recordUtilizationRate: 0.7,
		needCoverageRate: 1,
		...overrides,
	};
}

function windowOf(n: number, overrides: Partial<CalibrationSample> = {}): CalibrationSample[] {
	return Array.from({ length: n }, () => sample(overrides));
}

describe("aggregateMetrics", () => {
	it("weights recent samples more via EWMA", () => {
		const rising = aggregateMetrics([sample({ tokenUtilizationRate: 0 }), sample({ tokenUtilizationRate: 1 })]);
		const falling = aggregateMetrics([sample({ tokenUtilizationRate: 1 }), sample({ tokenUtilizationRate: 0 })]);
		expect(rising.meanTokenUtilization).toBeCloseTo(0.4, 5);
		expect(falling.meanTokenUtilization).toBeCloseTo(0.6, 5);
	});

	it("clamps out-of-range rates defensively", () => {
		const metrics = aggregateMetrics([sample({ tokenUtilizationRate: 7, needCoverageRate: -3 })]);
		expect(metrics.meanTokenUtilization).toBe(1);
		expect(metrics.meanNeedCoverage).toBe(0);
	});

	it("reports zero expansion utilization when no sample carries it", () => {
		expect(aggregateMetrics(windowOf(3)).meanExpansionUtilization).toBe(0);
	});
});

describe("decideRegime", () => {
	it("holds with too few samples", () => {
		expect(decideRegime(aggregateMetrics(windowOf(2)), 5)).toBe("insufficient-data");
	});

	it("lets safety dominate efficiency", () => {
		const metrics = aggregateMetrics(windowOf(6, { needCoverageRate: 0.5, tokenUtilizationRate: 0.1 }));
		expect(metrics.coverageShortfall).toBeGreaterThan(0);
		expect(metrics.utilizationShortfall).toBeGreaterThan(0);
		expect(decideRegime(metrics, 5)).toBe("under-provisioned");
	});

	it("tightens only when coverage is safe and tokens are wasted", () => {
		const metrics = aggregateMetrics(windowOf(6, { tokenUtilizationRate: 0.1 }));
		expect(decideRegime(metrics, 5)).toBe("over-provisioned");
	});

	it("balances when both bands are met", () => {
		expect(decideRegime(aggregateMetrics(windowOf(6)), 5)).toBe("balanced");
	});
});

describe("calibrate", () => {
	it("holds parameters and reports zero confidence on insufficient data", () => {
		const result = calibrate(windowOf(2), { now: NOW });
		expect(result.regime).toBe("insufficient-data");
		expect(result.confidence).toBe(0);
		expect(result.adjustments).toEqual([]);
		expect(result.effective).toEqual(DEFAULT_CALIBRATION_PARAMETERS);
		expect(result.calibratedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(result.failedOpen).toBe(false);
	});

	it("leaves a balanced project untouched", () => {
		const result = calibrate(windowOf(6), { now: NOW });
		expect(result.regime).toBe("balanced");
		expect(result.adjustments).toEqual([]);
		expect(result.proposed).toEqual(result.baseline);
	});

	it("adds fidelity in every dimension when under-provisioned", () => {
		const result = calibrate(windowOf(6, { needCoverageRate: 0 }), { now: NOW });
		expect(result.regime).toBe("under-provisioned");
		expect(result.proposed.budget.targetFillRatio).toBeGreaterThan(result.baseline.budget.targetFillRatio);
		expect(result.proposed.gate.semanticSimilarityThreshold).toBeGreaterThan(
			result.baseline.gate.semanticSimilarityThreshold,
		);
		expect(result.proposed.density.detailedThreshold).toBeLessThan(result.baseline.density.detailedThreshold);
	});

	it("treats any safety incident as under-provisioned even with full coverage", () => {
		const samples = [...windowOf(5), sample({ safetyIncident: true })];
		expect(calibrate(samples, { now: NOW }).regime).toBe("under-provisioned");
	});

	it("caps every knob change at its maximum step", () => {
		const result = calibrate(windowOf(6, { needCoverageRate: 0 }), { now: NOW });
		const budget = result.adjustments.find(a => a.knob === "budget.targetFillRatio");
		expect(budget?.clampedBy).toBe("maxStep");
		expect(budget?.after).toBeCloseTo(0.8, 5);
	});

	it("never collapses past the gate similarity floor and audits it", () => {
		const baseline = {
			...DEFAULT_CALIBRATION_PARAMETERS,
			gate: { semanticSimilarityThreshold: 0.78 },
		};
		const result = calibrate(windowOf(6, { tokenUtilizationRate: 0 }), { baseline, now: NOW });
		expect(result.regime).toBe("over-provisioned");
		const gate = result.adjustments.find(a => a.knob === "gate.semanticSimilarityThreshold");
		expect(result.proposed.gate.semanticSimilarityThreshold).toBe(0.75);
		expect(gate?.clampedBy).toBe("floor");
	});

	it("keeps density thresholds ordered with the minimum gap", () => {
		const baseline = {
			...DEFAULT_CALIBRATION_PARAMETERS,
			density: { detailedThreshold: 0.55, standardThreshold: 0.55, compactThreshold: 0.22 },
		};
		const result = calibrate(windowOf(6, { needCoverageRate: 0 }), { baseline, now: NOW });
		const d = result.proposed.density;
		expect(d.detailedThreshold - d.standardThreshold).toBeGreaterThanOrEqual(0.05 - 1e-9);
		expect(d.standardThreshold - d.compactThreshold).toBeGreaterThanOrEqual(0.05 - 1e-9);
	});

	it("keeps effective at baseline in observe and suggest modes", () => {
		const samples = windowOf(6, { needCoverageRate: 0 });
		const observed = calibrate(samples, { now: NOW });
		expect(observed.mode).toBe("observe");
		expect(observed.effective).toEqual(observed.baseline);
		const suggested = calibrate(samples, { mode: "suggest", now: NOW });
		expect(suggested.effective).toEqual(suggested.baseline);
		expect(suggested.awaitingApproval).toBe(true);
	});

	it("applies the proposal only in active mode", () => {
		const result = calibrate(windowOf(6, { needCoverageRate: 0 }), { mode: "active", now: NOW });
		expect(result.effective).toEqual(result.proposed);
		expect(result.effective).not.toEqual(result.baseline);
		expect(result.awaitingApproval).toBe(false);
	});

	it("is deterministic for identical inputs", () => {
		const samples = windowOf(6, { needCoverageRate: 0.4, tokenUtilizationRate: 0.3 });
		expect(calibrate(samples, { now: NOW })).toEqual(calibrate(samples, { now: NOW }));
	});

	it("does not mutate the caller's baseline or samples", () => {
		const baseline = {
			...DEFAULT_CALIBRATION_PARAMETERS,
			budget: { targetFillRatio: 0.5 },
		};
		const samples = windowOf(6, { needCoverageRate: 0 });
		calibrate(samples, { baseline, mode: "active", now: NOW });
		expect(baseline.budget.targetFillRatio).toBe(0.5);
		expect(samples).toHaveLength(6);
	});

	it("fails open to the baseline when a sample throws on access", () => {
		const poisoned: CalibrationSample = {
			get projectId(): string {
				throw new Error("boom");
			},
			tokenUtilizationRate: 1,
			recordUtilizationRate: 1,
			needCoverageRate: 1,
		};
		const result = calibrate([poisoned], { now: NOW });
		expect(result.failedOpen).toBe(true);
		expect(result.effective).toEqual(DEFAULT_CALIBRATION_PARAMETERS);
		expect(result.confidence).toBe(0);
	});
});

describe("calibratePerProject", () => {
	it("calibrates each project independently", () => {
		const samples = [
			...windowOf(6, { projectId: "alpha", needCoverageRate: 0 }),
			...windowOf(6, { projectId: "beta" }),
		];
		const results = calibratePerProject(samples, { now: NOW });
		expect(results.size).toBe(2);
		expect(results.get("alpha")?.regime).toBe("under-provisioned");
		expect(results.get("beta")?.regime).toBe("balanced");
	});

	it("returns an empty map for no samples", () => {
		expect(calibratePerProject([], { now: NOW }).size).toBe(0);
	});
});

describe("sampleFromPacketUtilization", () => {
	it("adapts a packet-utilization record conservatively", () => {
		const adapted = sampleFromPacketUtilization({
			taskId: "t1",
			packetId: "pk1",
			weightedUtilizationRate: 0.8,
			needCoverageRate: Number.NaN,
			knownFailureRepeated: true,
		});
		expect(adapted.projectId).toBe("t1");
		expect(adapted.tokenUtilizationRate).toBe(0.8);
		expect(adapted.needCoverageRate).toBe(0);
		expect(adapted.safetyIncident).toBe(true);
		expect(adapted.sampleId).toBe("pk1");
		expect(adapted.taskSucceeded).toBeUndefined();
	});

	it("prefers the explicit project id and falls back to unknown", () => {
		expect(sampleFromPacketUtilization({ projectId: "pkt" }, "explicit").projectId).toBe("explicit");
		expect(sampleFromPacketUtilization({}).projectId).toBe("unknown");
	});
});
