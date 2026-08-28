/**
 * Tests for the contextual-need coverage evaluator.
 */

import { describe, expect, it } from "bun:test";
import type {
	ContextNeed,
	InjectedRecordView,
	NeedSupport,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/contextual-coverage";
import {
	ARCHITECTURE_NEED_TEMPLATES,
	calculateFreshnessCoverage,
	calculateNeedSatisfaction,
	calculateRequiredCoverage,
	calculateVerificationCoverage,
	calculateWeightedCoverage,
	DEBUGGING_NEED_TEMPLATES,
	DEFAULT_FRESHNESS_WINDOW_MS,
	DEPLOYMENT_NEED_TEMPLATES,
	generateCoverageReport,
	getNeedTemplatesForTask,
	RECOVERY_NEED_TEMPLATES,
	verificationSupportWeight,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/contextual-coverage";

function need(overrides?: Partial<ContextNeed>): ContextNeed {
	return {
		id: "need-1",
		type: "objective",
		description: "Test objective",
		required: true,
		priority: 1.0,
		satisfiedByMemoryIds: [],
		partiallySatisfiedByMemoryIds: [],
		status: "unresolved",
		...overrides,
	};
}

describe("need templates", () => {
	it("maps known task types to their template sets", () => {
		expect(getNeedTemplatesForTask("debugging")).toBe(DEBUGGING_NEED_TEMPLATES);
		expect(getNeedTemplatesForTask("Architecture")).toBe(ARCHITECTURE_NEED_TEMPLATES);
		expect(getNeedTemplatesForTask("RECOVERY")).toBe(RECOVERY_NEED_TEMPLATES);
		expect(getNeedTemplatesForTask("deployment")).toBe(DEPLOYMENT_NEED_TEMPLATES);
	});

	it("returns null for unknown task types instead of a silent fallback", () => {
		expect(getNeedTemplatesForTask("refactoring")).toBeNull();
		expect(getNeedTemplatesForTask("")).toBeNull();
	});
});

describe("calculateRequiredCoverage", () => {
	it("returns 1.0 when there are no required needs", () => {
		expect(calculateRequiredCoverage([need({ required: false })])).toBe(1.0);
	});

	it("counts satisfied as 1 and partial as 0.5", () => {
		const needs = [
			need({ id: "a", status: "satisfied" }),
			need({ id: "b", status: "partially-satisfied" }),
			need({ id: "c", status: "unresolved" }),
			need({ id: "d", status: "contradicted" }),
		];
		expect(calculateRequiredCoverage(needs)).toBeCloseTo(1.5 / 4);
	});

	it("ignores non-required needs", () => {
		const needs = [need({ id: "a", status: "satisfied" }), need({ id: "b", required: false, status: "unresolved" })];
		expect(calculateRequiredCoverage(needs)).toBe(1.0);
	});
});

describe("calculateWeightedCoverage", () => {
	it("weights satisfaction by priority", () => {
		const needs = [
			need({ id: "a", priority: 1.0, status: "satisfied" }),
			need({ id: "b", priority: 0.5, status: "unresolved" }),
		];
		expect(calculateWeightedCoverage(needs)).toBeCloseTo(1.0 / 1.5);
	});

	it("returns 1.0 when total priority is zero", () => {
		expect(calculateWeightedCoverage([need({ priority: 0 })])).toBe(1.0);
	});
});

describe("verificationSupportWeight", () => {
	it("orders verification levels by trust", () => {
		expect(verificationSupportWeight("user-confirmed")).toBe(1.0);
		expect(verificationSupportWeight("test-observed")).toBe(1.0);
		expect(verificationSupportWeight("source-extracted")).toBe(0.95);
		expect(verificationSupportWeight("tool-observed")).toBe(0.9);
		expect(verificationSupportWeight("episode-derived")).toBe(0.7);
		expect(verificationSupportWeight("model-proposed")).toBe(0.4);
		expect(verificationSupportWeight(undefined)).toBe(0.6);
	});
});

describe("calculateNeedSatisfaction", () => {
	it("returns 0 for no supports", () => {
		expect(calculateNeedSatisfaction([])).toBe(0);
	});

	it("takes the best verification-weighted support score", () => {
		const supports: NeedSupport[] = [
			{ needId: "n", memoryId: "m1", support: "partial", supportScore: 0.5, verification: "user-confirmed" },
			{ needId: "n", memoryId: "m2", support: "complete", supportScore: 1.0, verification: "model-proposed" },
		];
		expect(calculateNeedSatisfaction(supports)).toBeCloseTo(0.5);
	});
});

describe("calculateVerificationCoverage", () => {
	it("returns 1.0 for no needs and 0.0 when nothing is covered", () => {
		expect(calculateVerificationCoverage([], [])).toBe(1.0);
		expect(calculateVerificationCoverage([need({ status: "unresolved" })], [])).toBe(0.0);
	});

	it("counts covered needs whose supports carry >= 0.90 verification", () => {
		const needs = [need({ id: "a", status: "satisfied" }), need({ id: "b", status: "satisfied" })];
		const supports: NeedSupport[] = [
			{ needId: "a", memoryId: "m1", support: "complete", supportScore: 1.0, verification: "test-observed" },
			{ needId: "b", memoryId: "m2", support: "complete", supportScore: 1.0, verification: "model-proposed" },
		];
		expect(calculateVerificationCoverage(needs, [], supports)).toBeCloseTo(0.5);
	});

	it("ignores contradictory and none supports", () => {
		const needs = [need({ id: "a", status: "satisfied" })];
		const supports: NeedSupport[] = [
			{
				needId: "a",
				memoryId: "m1",
				support: "contradictory",
				supportScore: 1.0,
				verification: "user-confirmed",
			},
		];
		expect(calculateVerificationCoverage(needs, [], supports)).toBe(0.0);
	});

	it("falls back to the verification of referenced records", () => {
		const needs = [need({ id: "a", status: "satisfied", satisfiedByMemoryIds: ["m1"] })];
		const records: InjectedRecordView[] = [{ id: "m1", verification: "source-extracted" }];
		expect(calculateVerificationCoverage(needs, records)).toBe(1.0);
	});

	it("never assumes strength for untraceable evidence", () => {
		const needs = [need({ id: "a", status: "satisfied" })];
		expect(calculateVerificationCoverage(needs, [])).toBe(0.0);
	});
});

describe("calculateFreshnessCoverage", () => {
	const now = "2026-08-20T00:00:00.000Z";

	it("returns 1.0 for no records", () => {
		expect(calculateFreshnessCoverage([], now)).toBe(1.0);
	});

	it("counts records within the window as fresh", () => {
		const records: InjectedRecordView[] = [
			{ id: "fresh", createdAt: "2026-08-19T00:00:00.000Z" },
			{ id: "stale", createdAt: "2026-01-01T00:00:00.000Z" },
		];
		expect(calculateFreshnessCoverage(records, now)).toBeCloseTo(0.5);
	});

	it("never counts records without a timestamp as fresh", () => {
		const records: InjectedRecordView[] = [{ id: "no-ts" }, { id: "bad-ts", createdAt: "not-a-date" }];
		expect(calculateFreshnessCoverage(records, now)).toBe(0.0);
	});

	it("treats parseable timestamps as fresh when no clock is injected", () => {
		const records: InjectedRecordView[] = [{ id: "a", createdAt: "2020-01-01T00:00:00.000Z" }, { id: "b" }];
		expect(calculateFreshnessCoverage(records)).toBeCloseTo(0.5);
	});

	it("honors a custom freshness window", () => {
		const records: InjectedRecordView[] = [{ id: "a", createdAt: "2026-08-19T00:00:00.000Z" }];
		expect(calculateFreshnessCoverage(records, now, 60 * 60 * 1000)).toBe(0.0);
		expect(calculateFreshnessCoverage(records, now, DEFAULT_FRESHNESS_WINDOW_MS)).toBe(1.0);
	});
});

describe("generateCoverageReport", () => {
	it("aggregates statuses, critical needs, and computed metrics", () => {
		const needs = [
			need({ id: "a", status: "satisfied", critical: true, satisfiedByMemoryIds: ["m1"] }),
			need({ id: "b", status: "partially-satisfied", type: "code-impact" }),
			need({ id: "c", status: "unresolved", type: "validation", critical: true }),
			need({ id: "d", status: "contradicted", required: false }),
		];
		const records: InjectedRecordView[] = [
			{
				id: "m1",
				verification: "test-observed",
				createdAt: "2026-08-19T00:00:00.000Z",
				sourceRefs: ["src/a.ts"],
			},
			{ id: "m2", verification: "model-proposed" },
		];

		const report = generateCoverageReport("packet-1", needs, records, { nowIso: "2026-08-20T00:00:00.000Z" });

		expect(report.packetId).toBe("packet-1");
		expect(report.totalNeeds).toBe(4);
		expect(report.requiredNeeds).toBe(3);
		expect(report.satisfiedNeedIds).toEqual(["a"]);
		expect(report.partiallySatisfiedNeedIds).toEqual(["b"]);
		expect(report.unresolvedNeedIds).toEqual(["c"]);
		expect(report.contradictedNeedIds).toEqual(["d"]);
		expect(report.missingCriticalNeedIds).toEqual(["c"]);
		expect(report.criticalNeedsSatisfied).toBe(false);
		// Covered: a (record m1, test-observed => strong) and b (no evidence => weak).
		expect(report.verificationCoverage).toBeCloseTo(0.5);
		// m1 has sourceRefs, m2 does not.
		expect(report.provenanceCoverage).toBeCloseTo(0.5);
		// m1 fresh, m2 has no timestamp.
		expect(report.freshnessCoverage).toBeCloseTo(0.5);
	});

	it("recommends tiers and queries for uncovered needs", () => {
		const needs = [
			need({ id: "a", status: "unresolved", type: "failure-history" }),
			need({ id: "b", status: "partially-satisfied", type: "code-impact" }),
			need({ id: "c", status: "unresolved", type: "evidence" }),
			need({ id: "d", status: "unresolved", type: "constraint" }),
			need({ id: "e", status: "satisfied", type: "validation" }),
		];

		const report = generateCoverageReport("packet-2", needs, []);

		expect(report.recommendedExpansionTiers).toEqual(["L2", "L3", "L4", "L1"]);
		expect(report.recommendedQueries.length).toBe(4);
		expect(report.recommendedQueries[0]).toContain("failure history");
	});

	it("reports full coverage metrics for empty inputs", () => {
		const report = generateCoverageReport("packet-3", [], []);
		expect(report.requiredCoverage).toBe(1.0);
		expect(report.weightedCoverage).toBe(1.0);
		expect(report.verificationCoverage).toBe(1.0);
		expect(report.provenanceCoverage).toBe(1.0);
		expect(report.freshnessCoverage).toBe(1.0);
		expect(report.criticalNeedsSatisfied).toBe(true);
	});
});
