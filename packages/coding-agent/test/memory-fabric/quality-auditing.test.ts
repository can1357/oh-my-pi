import { describe, expect, it } from "bun:test";

import {
	type AuditableEvent,
	computeDecayedConfidence,
	detectContradictions,
	formatAuditLog,
	formatProvenanceString,
	QuotaEnforcer,
	VERIFICATION_HALF_LIVES_DAYS,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/quality-auditing";
import { createMemoryRecord, type MemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

function record(content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const base = createMemoryRecord({
		type: "fact",
		projectId: "proj-a",
		content,
		sourceRefs: [],
		tags: ["style"],
	});
	return { ...base, ...overrides };
}

describe("quality-auditing", () => {
	describe("computeDecayedConfidence", () => {
		it("halves confidence after exactly one half-life", () => {
			expect(computeDecayedConfidence(1, "observed", VERIFICATION_HALF_LIVES_DAYS.observed)).toBeCloseTo(0.5, 3);
		});

		it("returns the original confidence at zero age", () => {
			expect(computeDecayedConfidence(0.8, "user-confirmed", 0)).toBe(0.8);
		});

		it("decays slower for stronger verification tiers", () => {
			const strong = computeDecayedConfidence(0.9, "user-confirmed", 30);
			const weak = computeDecayedConfidence(0.9, "model-proposed", 30);
			expect(strong).toBeGreaterThan(weak);
		});

		it("clamps to the 0.01 floor for very old records", () => {
			expect(computeDecayedConfidence(0.5, "contradicted", 1000)).toBe(0.01);
		});

		it("treats non-finite or negative age as zero", () => {
			expect(computeDecayedConfidence(0.7, "observed", Number.NaN)).toBe(0.7);
			expect(computeDecayedConfidence(0.7, "observed", -5)).toBe(0.7);
		});

		it("covers every verification tier", () => {
			expect(Object.keys(VERIFICATION_HALF_LIVES_DAYS)).toHaveLength(6);
		});
	});

	describe("detectContradictions", () => {
		it("flags opposing directives on a shared topic", () => {
			const a = record("always use tabs for project indentation");
			const b = record("never use tabs for project indentation");
			const findings = detectContradictions([a, b]);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.reason).toMatch(/shared terms/);
			expect(findings[0]?.confidence).toBe(0.85);
		});

		it("is symmetric in record order", () => {
			const a = record("never use tabs for project indentation");
			const b = record("always use tabs for project indentation");
			expect(detectContradictions([a, b])).toHaveLength(1);
		});

		it("does not flag two records that both carry the negated form", () => {
			const a = record("you must not commit generated bundle files");
			const b = record("you must not commit generated vendor files");
			expect(detectContradictions([a, b])).toHaveLength(0);
		});

		it("does not treat the enable inside disable as opposing", () => {
			const a = record("disable the strict telemetry checks entirely");
			const b = record("disable the strict telemetry checks entirely");
			expect(detectContradictions([a, b])).toHaveLength(0);
		});

		it("ignores records from different projects", () => {
			const a = record("always use tabs for project indentation");
			const b = record("never use tabs for project indentation", { projectId: "proj-b" });
			expect(detectContradictions([a, b])).toHaveLength(0);
		});

		it("skips records whose verification is already resolved", () => {
			const a = record("always use tabs for project indentation");
			const b = record("never use tabs for project indentation", { verification: "superseded" });
			expect(detectContradictions([a, b])).toHaveLength(0);
		});

		it("requires a shared topic, not just opposing keywords", () => {
			const a = record("always compress uploaded artifacts");
			const b = record("never restart production databases");
			expect(detectContradictions([a, b])).toHaveLength(0);
		});
	});

	describe("formatAuditLog", () => {
		const events: AuditableEvent[] = [
			{ seq: 1, type: "memory.write", recordId: "mem_1", timestamp: "2026-01-01T00:00:00Z", payload: { ok: true } },
			{ seq: 2, type: "memory.update", timestamp: "2026-01-01T00:01:00Z", payload: {} },
		];

		it("formats pretty JSON arrays", () => {
			const output = formatAuditLog(events, "json");
			expect(JSON.parse(output)).toHaveLength(2);
			expect(output).toContain("\n");
		});

		it("formats one event per line as JSONL", () => {
			const lines = formatAuditLog(events, "jsonl").split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[1] ?? "").seq).toBe(2);
		});
	});

	describe("formatProvenanceString", () => {
		it("returns an empty string for no records", () => {
			expect(formatProvenanceString([])).toBe("");
		});

		it("formats id, verification, type and tags per record", () => {
			const a = record("tabs", { id: "mem_1", verification: "observed" });
			expect(formatProvenanceString([a])).toBe("mem_1=>observed | fact | style");
		});
	});

	describe("QuotaEnforcer", () => {
		it("denies writes over the per-minute rate and recovers after the window", () => {
			let clock = 0;
			const enforcer = new QuotaEnforcer({ maxWritesPerMinute: 2 }, () => clock);
			expect(enforcer.checkQuota(0, 0).allowed).toBe(true);
			expect(enforcer.checkQuota(0, 0).allowed).toBe(true);
			const denied = enforcer.checkQuota(0, 0);
			expect(denied.allowed).toBe(false);
			expect(denied.reason).toMatch(/Rate limit exceeded/);
			clock = 60000;
			expect(enforcer.checkQuota(0, 0).allowed).toBe(true);
		});

		it("denies writes at the record-count quota", () => {
			const enforcer = new QuotaEnforcer({ maxRecordsPerProject: 10 }, () => 0);
			expect(enforcer.checkQuota(9, 0).allowed).toBe(true);
			const denied = enforcer.checkQuota(10, 0);
			expect(denied.allowed).toBe(false);
			expect(denied.reason).toMatch(/Record count quota exceeded/);
		});

		it("denies writes at the storage quota", () => {
			const enforcer = new QuotaEnforcer({ maxSizeBytesPerProject: 1000 }, () => 0);
			const denied = enforcer.checkQuota(0, 1000);
			expect(denied.allowed).toBe(false);
			expect(denied.reason).toMatch(/Storage quota exceeded/);
		});

		it("does not consume rate-window slots on denied writes", () => {
			const enforcer = new QuotaEnforcer({ maxWritesPerMinute: 1, maxRecordsPerProject: 1 }, () => 0);
			expect(enforcer.checkQuota(1, 0).allowed).toBe(false);
			expect(enforcer.checkQuota(0, 0).allowed).toBe(true);
		});
	});
});
