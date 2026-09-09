import { describe, expect, test } from "bun:test";
import type { SecurityFinding, SecurityScanBundle } from "../../src/security";
import { compareSecurityLineage, compareSecurityProducers } from "../../src/security";

function finding(
	id: string,
	fingerprint: string,
	ruleId: string,
	path: string,
	startLine: number,
	cwe: string[] = [],
): SecurityFinding {
	return {
		id,
		scanId: "placeholder",
		fingerprint,
		ruleId,
		title: id,
		summary: id,
		severity: { level: "high" },
		confidence: { level: "high" },
		taxonomy: { category: "test", cwe },
		occurrences: [{ id: `occ-${id}`, locations: [{ path, startLine }], evidenceIds: [] }],
		evidence: [],
		validation: { status: "unvalidated", evidenceIds: [] },
		disposition: { status: "open" },
		provenance: { producer: { kind: "omp-native", name: "fixture" }, createdAt: "2026-07-29T00:00:00.000Z" },
	};
}

function bundle(scanId: string, findings: SecurityFinding[]): SecurityScanBundle {
	for (const item of findings) item.scanId = scanId;
	return {
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: "fixture",
			status: "completed",
			createdAt: "2026-07-29T00:00:00.000Z",
			target: {
				kind: "imported",
				repositoryRoot: "/fixture",
				displayName: "fixture",
				includePaths: [],
				excludePaths: [],
				treeDigest: "fixture",
			},
			producer: { kind: "omp-native", name: "fixture" },
			provenance: { producer: { kind: "omp-native", name: "fixture" }, createdAt: "2026-07-29T00:00:00.000Z" },
			findingIds: findings.map(item => item.id),
			coverage: {
				mode: "imported",
				completeness: "unknown",
				inventoryStrategy: "imported",
				includePaths: [],
				excludePaths: [],
				surfaces: [],
				explicitExclusions: [],
				deferred: [],
			},
		},
		findings,
	};
}

describe("security comparison", () => {
	test("matches exact fingerprints before rule/location fallbacks", () => {
		const reference = bundle("secscan_reference", [
			finding("ref-exact", "fp-exact", "rule.exact", "src/a.ts", 5),
			finding("ref-fallback", "fp-reference", "rule.fallback", "src/b.ts", 9),
		]);
		const candidate = bundle("secscan_candidate", [
			finding("cand-exact", "fp-exact", "rule.exact", "src/a.ts", 5),
			finding("cand-fallback", "fp-candidate", "rule.fallback", "src/b.ts", 9),
			finding("cand-only", "fp-only", "rule.only", "src/c.ts", 3),
		]);
		reference.scan.producer = { kind: "codex-security-bundle", name: "Codex Security" };
		reference.scan.metrics = { runtimeMs: 12_000 };
		candidate.scan.metrics = {
			runtimeMs: 8_000,
			tokenUsage: { input: 100, output: 50, reasoning: 25, cacheRead: 10, cacheWrite: 0, total: 185 },
		};
		const report = compareSecurityProducers(reference, candidate);
		expect(report.matches.map(match => match.basis)).toEqual(["fingerprint", "rule_location"]);
		expect(report.referenceOnlyFindingIds).toEqual([]);
		expect(report.candidateOnlyFindingIds).toEqual(["cand-only"]);
		expect(report.recallAgainstReference).toBe(1);
		expect(report.precisionAgainstReference).toBeCloseTo(2 / 3);
		expect(report.reference).toMatchObject({
			producer: { kind: "codex-security-bundle" },
			findingCount: 2,
			metrics: { runtimeMs: 12_000 },
		});
		expect(report.candidate.metrics?.tokenUsage?.total).toBe(185);
		expect(report.candidateOnlyFindings).toEqual([
			expect.objectContaining({
				findingId: "cand-only",
				ruleId: "rule.only",
				title: "cand-only",
				primaryLocation: { path: "src/c.ts", startLine: 3 },
			}),
		]);
	});

	test("matches producer-neutral taxonomy and nearby source locations only when unambiguous", () => {
		const reference = bundle("secscan_reference", [
			finding("ref-cmd", "official-fp", "official.command", "src/command.ts", 3, ["CWE-78"]),
		]);
		const candidate = bundle("secscan_candidate", [
			finding("cand-cmd", "native-fp", "native.shell", "./src/command.ts", 5, ["cwe-78"]),
		]);
		const report = compareSecurityProducers(reference, candidate);
		expect(report.matches).toEqual([
			{
				referenceFindingId: "ref-cmd",
				candidateFindingId: "cand-cmd",
				basis: "taxonomy_location",
			},
		]);
	});

	test("leaves ambiguous taxonomy and location candidates unmatched", () => {
		const reference = bundle("secscan_reference", [
			finding("ref-one", "ref-one-fp", "official.one", "src/shared.ts", 10, ["CWE-89"]),
			finding("ref-two", "ref-two-fp", "official.two", "src/shared.ts", 12, ["CWE-89"]),
		]);
		const candidate = bundle("secscan_candidate", [
			finding("cand", "cand-fp", "native.sql", "src/shared.ts", 11, ["CWE-89"]),
		]);
		const report = compareSecurityProducers(reference, candidate);
		expect(report.matches).toEqual([]);
		expect(report.referenceOnlyFindingIds).toEqual(["ref-one", "ref-two"]);
		expect(report.candidateOnlyFindingIds).toEqual(["cand"]);
	});

	test("lineage classifies unchanged, resolved, and introduced findings", () => {
		const before = bundle("secscan_before", [
			finding("before-shared", "fp-shared", "rule.shared", "src/a.ts", 1),
			finding("before-resolved", "fp-resolved", "rule.resolved", "src/b.ts", 1),
		]);
		const after = bundle("secscan_after", [
			finding("after-shared", "fp-shared", "rule.shared", "src/a.ts", 1),
			finding("after-new", "fp-new", "rule.new", "src/c.ts", 1),
		]);
		const report = compareSecurityLineage(before, after);
		expect(report.unchanged).toBe(1);
		expect(report.resolved).toBe(1);
		expect(report.introduced).toBe(1);
	});

	test("never marks findings resolved from an incomplete after-scan", () => {
		const before = bundle("secscan_before", [finding("before-open", "fp-open", "rule.open", "src/open.ts", 1)]);
		const after = bundle("secscan_after", []);
		after.scan.status = "cancelled";
		expect(() => compareSecurityLineage(before, after)).toThrow(
			"requires a completed after-scan; secscan_after is cancelled",
		);
	});
});
