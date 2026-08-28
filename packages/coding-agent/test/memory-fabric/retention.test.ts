/**
 * Retention scoring — factors, tiers, penalties, deletion protection.
 */

import { describe, expect, it } from "bun:test";
import type { RetentionContext, RetentionSignals } from "@oh-my-pi/pi-coding-agent/memory-fabric/retention";
import {
	computeRetentionScore,
	DEFAULT_RETENTION_POLICY,
	emptyRetentionSignals,
	isDeletionCandidate,
	tierForScore,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/retention";
import type { CreateMemoryRecordInput, MemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";
import { createMemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

function record(overrides?: Partial<CreateMemoryRecordInput>): MemoryRecord {
	return createMemoryRecord({
		type: "fact",
		projectId: "proj-1",
		content: "tests run with bun",
		sourceRefs: [{ type: "user-message", id: "msg-1" }],
		...overrides,
	});
}

function context(overrides?: Partial<RetentionContext>): RetentionContext {
	return { currentProjectId: "proj-1", ...overrides };
}

function signals(overrides?: Partial<RetentionSignals>): RetentionSignals {
	return { ...emptyRetentionSignals(), ...overrides };
}

/** A clock frozen `days` after the record was created. */
function daysAfter(rec: MemoryRecord, days: number): () => number {
	const base = Date.parse(rec.createdAt);
	return () => base + days * 24 * 60 * 60 * 1000;
}

describe("tierForScore", () => {
	it("maps score bands onto tiers", () => {
		expect(tierForScore(0.9)).toBe("hot");
		expect(tierForScore(0.75)).toBe("hot");
		expect(tierForScore(0.6)).toBe("warm");
		expect(tierForScore(0.5)).toBe("warm");
		expect(tierForScore(0.3)).toBe("cold");
		expect(tierForScore(0.25)).toBe("cold");
		expect(tierForScore(0.1)).toBe("delete");
	});
});

describe("computeRetentionScore", () => {
	it("scores a fresh, verified, heavily used record as hot", () => {
		const rec = record({ verification: "user-confirmed", importance: 0.9 });
		const result = computeRetentionScore(
			rec,
			signals({ retrievalCount: 10, usefulCount: 9, dependentCount: 5 }),
			context({ now: daysAfter(rec, 0) }),
		);
		expect(result.tier).toBe("hot");
	});

	it("scores a contradicted, duplicated record as delete", () => {
		const rec = record({ verification: "contradicted", importance: 0.1 });
		const result = computeRetentionScore(
			rec,
			signals({ contradictionCount: 3, duplicateCount: 4 }),
			context({ now: daysAfter(rec, 200) }),
		);
		expect(result.tier).toBe("delete");
		expect(result.score).toBe(0);
	});

	it("weights verification states in strength order", () => {
		const base = { retrievalCount: 0 };
		const confirmed = computeRetentionScore(record({ verification: "user-confirmed" }), signals(base), context());
		const observed = computeRetentionScore(record({ verification: "observed" }), signals(base), context());
		const proposed = computeRetentionScore(record({ verification: "model-proposed" }), signals(base), context());
		expect(confirmed.factors.verificationStrength).toBe(1.0);
		expect(observed.factors.verificationStrength).toBe(0.7);
		expect(proposed.factors.verificationStrength).toBe(0.3);
	});

	it("gives full scope relevance only on project and branch match", () => {
		const onBranch = record({ branchId: "main" });
		const both = computeRetentionScore(onBranch, signals(), context({ currentBranchId: "main" }));
		const projectOnly = computeRetentionScore(record(), signals(), context({ currentBranchId: "main" }));
		const neither = computeRetentionScore(
			record({ projectId: "proj-2" }),
			signals(),
			context({ currentBranchId: "main" }),
		);
		expect(both.factors.scopeRelevance).toBe(1.0);
		expect(projectOnly.factors.scopeRelevance).toBeCloseTo(0.7);
		expect(neither.factors.scopeRelevance).toBe(0);
	});

	it("derives use rate from useful over retrieved, zero when never retrieved", () => {
		const rec = record();
		const used = computeRetentionScore(rec, signals({ retrievalCount: 4, usefulCount: 3 }), context());
		const unused = computeRetentionScore(rec, signals(), context());
		expect(used.factors.successfulUseRate).toBeCloseTo(0.75);
		expect(unused.factors.successfulUseRate).toBe(0);
	});

	it("decays recency linearly and adds staleness penalty past 90 days", () => {
		const rec = record();
		const fresh = computeRetentionScore(rec, signals(), context({ now: daysAfter(rec, 0) }));
		const aged = computeRetentionScore(rec, signals(), context({ now: daysAfter(rec, 100) }));
		const ancient = computeRetentionScore(rec, signals(), context({ now: daysAfter(rec, 400) }));
		expect(fresh.factors.recency).toBeCloseTo(1.0);
		expect(fresh.factors.stalenessPenalty).toBe(0);
		expect(aged.factors.stalenessPenalty).toBeCloseTo(0.1);
		expect(ancient.factors.recency).toBe(0);
	});

	it("saturates dependency centrality at ten dependents", () => {
		const rec = record();
		const some = computeRetentionScore(rec, signals({ dependentCount: 5 }), context());
		const many = computeRetentionScore(rec, signals({ dependentCount: 50 }), context());
		expect(some.factors.dependencyCentrality).toBeCloseTo(0.5);
		expect(many.factors.dependencyCentrality).toBe(1);
	});

	it("reduces uniqueness and adds a penalty per duplicate", () => {
		const rec = record();
		const unique = computeRetentionScore(rec, signals(), context());
		const duped = computeRetentionScore(rec, signals({ duplicateCount: 3 }), context());
		expect(unique.factors.uniqueness).toBe(1);
		expect(duped.factors.uniqueness).toBeCloseTo(0.25);
		expect(duped.factors.duplicationPenalty).toBeCloseTo(0.15);
	});

	it("is deterministic under an injected clock", () => {
		const rec = record();
		const ctx = context({ now: daysAfter(rec, 10) });
		const one = computeRetentionScore(rec, signals({ retrievalCount: 2, usefulCount: 1 }), ctx);
		const two = computeRetentionScore(rec, signals({ retrievalCount: 2, usefulCount: 1 }), ctx);
		expect(one.score).toBe(two.score);
		expect(one.factors).toEqual(two.factors);
	});
});

describe("isDeletionCandidate", () => {
	it("marks low-scoring unprotected records for deletion", () => {
		const rec = record({ verification: "contradicted", importance: 0 });
		const score = computeRetentionScore(rec, signals({ contradictionCount: 5 }), context());
		expect(isDeletionCandidate(rec, score, DEFAULT_RETENTION_POLICY)).toBe(true);
	});

	it("never deletes records at or above the policy threshold", () => {
		const rec = record({ verification: "user-confirmed", importance: 0.9 });
		const score = computeRetentionScore(rec, signals({ retrievalCount: 5, usefulCount: 5 }), context());
		expect(isDeletionCandidate(rec, score, DEFAULT_RETENTION_POLICY)).toBe(false);
	});

	it("protects evidence and audit-tagged records regardless of score", () => {
		const evidence = record({ type: "evidence", verification: "contradicted", importance: 0 });
		const audit = record({ tags: ["audit"], verification: "contradicted", importance: 0 });
		const lowEvidence = computeRetentionScore(evidence, signals({ contradictionCount: 5 }), context());
		const lowAudit = computeRetentionScore(audit, signals({ contradictionCount: 5 }), context());
		expect(isDeletionCandidate(evidence, lowEvidence, DEFAULT_RETENTION_POLICY)).toBe(false);
		expect(isDeletionCandidate(audit, lowAudit, DEFAULT_RETENTION_POLICY)).toBe(false);
		const unprotected = { ...DEFAULT_RETENTION_POLICY, preserveEvidence: false };
		expect(isDeletionCandidate(evidence, lowEvidence, unprotected)).toBe(true);
	});
});

describe("DEFAULT_RETENTION_POLICY", () => {
	it("carries the documented defaults", () => {
		expect(DEFAULT_RETENTION_POLICY.volatileTtlHours).toBe(24);
		expect(DEFAULT_RETENTION_POLICY.candidateTtlDays).toBe(7);
		expect(DEFAULT_RETENTION_POLICY.archiveAfterDays).toBe(30);
		expect(DEFAULT_RETENTION_POLICY.deleteDerivedBelowScore).toBeCloseTo(0.25);
	});
});
