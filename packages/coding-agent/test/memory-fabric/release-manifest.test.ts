import { describe, expect, it } from "bun:test";

import { DEFAULT_ADAPTIVE_CONFIG } from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/adaptive-budget";
import { DEFAULT_THRESHOLD_CONFIG } from "@oh-my-pi/pi-coding-agent/memory-fabric/expansion-thresholds";
import {
	BASELINE_LANE_CLASSIFICATIONS,
	CONTROL_LOOP_BASELINE,
	createReleaseManifest,
	RELEASE_MANIFEST_SCHEMA_VERSION,
	validateReleaseManifest,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/release-manifest";
import { DEFAULT_RRF_CONFIG } from "@oh-my-pi/pi-coding-agent/memory-fabric/rrf-fusion";

function manifest() {
	return createReleaseManifest({
		releaseTag: "memory-control-loop-v1.0",
		commitSha: "abcdef1234abcdef1234abcdef1234abcdef1234",
		timestamp: "2026-08-18T00:00:00Z",
	});
}

describe("release-manifest", () => {
	describe("CONTROL_LOOP_BASELINE", () => {
		it("mirrors the live default configurations", () => {
			expect(CONTROL_LOOP_BASELINE.rrfRankConstant).toBe(DEFAULT_RRF_CONFIG.rankConstant);
			expect(CONTROL_LOOP_BASELINE.laneWeights).toEqual({ ...DEFAULT_RRF_CONFIG.laneWeights });
			expect(CONTROL_LOOP_BASELINE.expansionThresholds.activeThreshold).toBe(
				DEFAULT_THRESHOLD_CONFIG.activeThreshold,
			);
			expect(CONTROL_LOOP_BASELINE.adaptiveBudgets.recovery).toBe(DEFAULT_ADAPTIVE_CONFIG.recoveryTokenBudget);
			expect(CONTROL_LOOP_BASELINE.absoluteMemoryLimitTokens).toBe(
				DEFAULT_THRESHOLD_CONFIG.maximumTotalExpansionTokens,
			);
			expect(CONTROL_LOOP_BASELINE.maximumExpansionStepsPerTurn).toBe(DEFAULT_THRESHOLD_CONFIG.maximumStepsPerTurn);
		});

		it("keeps expansion thresholds strictly increasing", () => {
			const t = CONTROL_LOOP_BASELINE.expansionThresholds;
			expect(t.silentThreshold).toBeLessThan(t.activeThreshold);
			expect(t.activeThreshold).toBeLessThan(t.urgentThreshold);
		});
	});

	describe("BASELINE_LANE_CLASSIFICATIONS", () => {
		it("classifies exactly the five public lanes", () => {
			expect(BASELINE_LANE_CLASSIFICATIONS).toHaveLength(5);
			const lanes = BASELINE_LANE_CLASSIFICATIONS.map(entry => entry.lane);
			expect(lanes).toEqual(["canonical", "memvid-lexical", "memvid-temporal", "graphify", "mempalace"]);
		});
	});

	describe("createReleaseManifest", () => {
		it("builds a manifest from caller-supplied release facts", () => {
			const built = manifest();
			expect(built.schemaVersion).toBe(RELEASE_MANIFEST_SCHEMA_VERSION);
			expect(built.releaseTag).toBe("memory-control-loop-v1.0");
			expect(built.rollbackTarget).toBe("memory-control-loop-v1.0");
			expect(built.testVerificationSummary).toBeUndefined();
		});

		it("attaches a test summary only when the pipeline supplies one", () => {
			const built = createReleaseManifest({
				releaseTag: "v1.1",
				commitSha: "abcdef1",
				timestamp: "2026-08-18T00:00:00Z",
				rollbackTarget: "v1.0",
				testVerificationSummary: {
					totalTestsPassed: 12,
					totalTestsFailed: 0,
					totalAssertions: 40,
					testSuiteCount: 2,
				},
			});
			expect(built.rollbackTarget).toBe("v1.0");
			expect(built.testVerificationSummary?.totalAssertions).toBe(40);
		});

		it("deep-copies the baseline so manifests cannot mutate shared state", () => {
			const built = manifest();
			built.controlLoopBaseline.laneWeights.canonical = 0;
			built.controlLoopBaseline.adaptiveBudgets.recovery = 0;
			expect(CONTROL_LOOP_BASELINE.laneWeights.canonical).toBe(1.0);
			expect(CONTROL_LOOP_BASELINE.adaptiveBudgets.recovery).toBe(DEFAULT_ADAPTIVE_CONFIG.recoveryTokenBudget);
		});
	});

	describe("validateReleaseManifest", () => {
		it("accepts a freshly created manifest", () => {
			const result = validateReleaseManifest(manifest());
			expect(result.valid).toBe(true);
			expect(result.reasons).toHaveLength(0);
		});

		it("rejects non-object inputs", () => {
			expect(validateReleaseManifest(null).valid).toBe(false);
			expect(validateReleaseManifest("manifest").valid).toBe(false);
		});

		it("reports every failed check with a reason", () => {
			const broken = manifest();
			broken.schemaVersion = "2.0.0";
			broken.commitSha = "not-a-sha";
			const result = validateReleaseManifest(broken);
			expect(result.valid).toBe(false);
			expect(result.reasons.some(reason => reason.includes("schemaVersion"))).toBe(true);
			expect(result.reasons.some(reason => reason.includes("commitSha"))).toBe(true);
		});

		it("rejects thresholds that are not strictly increasing", () => {
			const broken = manifest();
			broken.controlLoopBaseline.expansionThresholds.urgentThreshold = 0.1;
			const result = validateReleaseManifest(broken);
			expect(result.valid).toBe(false);
			expect(result.reasons.some(reason => reason.includes("strictly increasing"))).toBe(true);
		});

		it("rejects an empty adapter classification list", () => {
			const broken = manifest();
			broken.adapterClassifications = [];
			const result = validateReleaseManifest(broken);
			expect(result.valid).toBe(false);
			expect(result.reasons.some(reason => reason.includes("adapterClassifications"))).toBe(true);
		});
	});
});
