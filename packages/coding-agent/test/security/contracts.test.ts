import { describe, expect, test } from "bun:test";
import type { SecurityFinding, SecurityScanBundle } from "../../src/security/contracts";
import {
	createSecurityFindingFingerprint,
	createSecurityFindingId,
	createSecurityOccurrenceId,
	createSecurityScanId,
	parseSecurityFinding,
	parseSecurityScanBundle,
} from "../../src/security/contracts";

const LOCATION = { path: "src/archive.ts", startLine: 10, endLine: 12, role: "sink" } as const;

function fixtureFinding(): SecurityFinding {
	const fingerprint = createSecurityFindingFingerprint({
		ruleId: "path-traversal.archive-extraction",
		category: "path-traversal",
		anchor: "archive-write",
		locations: [LOCATION],
	});
	return {
		id: createSecurityFindingId(fingerprint),
		scanId: "secscan_fixture",
		fingerprint,
		ruleId: "path-traversal.archive-extraction",
		anchor: "archive-write",
		title: "Archive path escapes output root",
		summary: "An entry path reaches a write without containment validation.",
		severity: { level: "high", score: 8.1, scoringSystem: "CVSS:3.1" },
		confidence: { level: "high", rationale: "Direct source trace" },
		taxonomy: { category: "path-traversal", cwe: ["CWE-22"] },
		occurrences: [
			{ id: createSecurityOccurrenceId(fingerprint, [LOCATION]), locations: [LOCATION], evidenceIds: [] },
		],
		evidence: [],
		remediation: "Reject paths outside the extraction root.",
		validation: { status: "unvalidated", evidenceIds: [] },
		disposition: { status: "open" },
		provenance: {
			producer: { kind: "omp-native", name: "omp-security", version: "test" },
			createdAt: "2026-07-29T00:00:00.000Z",
		},
	};
}

describe("security contracts", () => {
	test("stable finding fingerprints ignore location order and path separators", () => {
		const first = createSecurityFindingFingerprint({
			ruleId: "SSRF",
			category: "Network",
			locations: [
				{ path: "src\\b.ts", startLine: 9 },
				{ path: "./src/a.ts", startLine: 2 },
			],
		});
		const second = createSecurityFindingFingerprint({
			ruleId: "ssrf",
			category: "network",
			locations: [
				{ path: "src/a.ts", startLine: 2 },
				{ path: "src/b.ts", startLine: 9 },
			],
		});
		expect(first).toBe(second);
		expect(createSecurityFindingId(first)).toBe(createSecurityFindingId(second));
	});

	test("finding fingerprints are stable across every location ordering", () => {
		const locations = [
			{ path: "src/entry.ts", startLine: 4, endLine: 8, startColumn: 2, endColumn: 4, role: "source" },
			{ path: "src/entry.ts", startLine: 4, endLine: 8, startColumn: 2, endColumn: 4, role: "sink" },
			{ path: "src/entry.ts", startLine: 4, endLine: 9, startColumn: 1, endColumn: 3, role: "propagation" },
			{ path: "src/entry.ts", startLine: 4, endLine: 10, startColumn: 1, endColumn: 3, role: "source" },
		] as const;
		const baseline = createSecurityFindingFingerprint({
			ruleId: "fixture.rule",
			category: "fixture",
			locations,
		});
		for (const ordered of [locations.toReversed(), [locations[2], locations[0], locations[3], locations[1]]]) {
			expect(
				createSecurityFindingFingerprint({
					ruleId: "fixture.rule",
					category: "fixture",
					locations: ordered,
				}),
			).toBe(baseline);
		}
	});

	test("scan IDs remain OMP-owned", () => {
		expect(createSecurityScanId(() => "018f0000-0000-7000-8000-000000000001")).toBe(
			"secscan_018f0000000070008000000000000001",
		);
	});

	test("finding validation accepts canonical objects", () => {
		expect(parseSecurityFinding(fixtureFinding()).id).toStartWith("secf_");
	});

	test("finding validation rejects missing occurrences", () => {
		const finding = fixtureFinding();
		expect(() => parseSecurityFinding({ ...finding, occurrences: [] })).toThrow();
	});

	test("bundle validation enforces scan/finding lineage", () => {
		const finding = fixtureFinding();
		const bundle: SecurityScanBundle = {
			scan: {
				documentType: "omp-security.scan",
				schemaVersion: "1.0",
				id: finding.scanId,
				projectKey: "fixture-project",
				status: "completed",
				createdAt: "2026-07-29T00:00:00.000Z",
				completedAt: "2026-07-29T00:01:00.000Z",
				target: {
					kind: "imported",
					repositoryRoot: "/fixture",
					displayName: "fixture",
					includePaths: [],
					excludePaths: [],
					treeDigest: Bun.SHA256.hash("fixture", "hex"),
				},
				producer: { kind: "sarif-import", name: "FixtureScanner", version: "1.2.3" },
				provenance: finding.provenance,
				findingIds: [finding.id],
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
			findings: [finding],
		};
		expect(parseSecurityScanBundle(bundle).findings).toHaveLength(1);
		expect(() => parseSecurityScanBundle({ ...bundle, findings: [{ ...finding, scanId: "other" }] })).toThrow();
		expect(() => parseSecurityScanBundle({ ...bundle, findings: [finding, finding] })).toThrow(
			"duplicate finding ids",
		);
		expect(() =>
			parseSecurityScanBundle({ ...bundle, scan: { ...bundle.scan, findingIds: [finding.id, finding.id] } }),
		).toThrow("duplicate finding references");
		expect(() => parseSecurityScanBundle({ ...bundle, scan: { ...bundle.scan, findingIds: [] } })).toThrow(
			"omits finding",
		);
		const missingEvidence = {
			...finding,
			occurrences: [{ ...finding.occurrences[0], evidenceIds: ["sece_missing"] }],
		};
		expect(() => parseSecurityScanBundle({ ...bundle, findings: [missingEvidence] })).toThrow("missing evidence");
	});
});
