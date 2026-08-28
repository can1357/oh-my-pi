/**
 * Release manifest for the memory-fabric control loop.
 *
 * Captures the tuned control-loop baseline (fusion constants, thresholds,
 * budgets) as a single reviewable artifact, plus a validator for manifests
 * arriving from storage or the wire.
 *
 * Release provenance (commit SHA, timestamp, test summary) is caller-supplied
 * through {@link createReleaseManifest} — this module never fabricates it.
 * The baseline itself is derived from the live default configurations so it
 * cannot drift from the values the control loop actually uses.
 */

import { DEFAULT_ADAPTIVE_CONFIG } from "./adaptive-fidelity/adaptive-budget";
import { DEFAULT_THRESHOLD_CONFIG } from "./expansion-thresholds";
import { DEFAULT_RRF_CONFIG, type MemoryLane } from "./rrf-fusion";

/** Storage/engine classification for a retrieval lane. */
export type LaneStorageKind = "local-sqlite" | "log-structured" | "code-graph" | "episodic";

/** How a lane is realized, for release review and rollback triage. */
export interface LaneClassification {
	lane: MemoryLane;
	name: string;
	laneType: LaneStorageKind;
}

/** Coverage/quality targets the release was tuned against. */
export interface CoverageTargets {
	requiredCoverageTarget: number;
	weightedCoverageTarget: number;
	verificationTarget: number;
	provenanceTarget: number;
}

/** Scored decision-region thresholds captured at release time. */
export interface ExpansionThresholdSnapshot {
	silentThreshold: number;
	activeThreshold: number;
	urgentThreshold: number;
}

/** Risk-based threshold deltas captured at release time. */
export interface RiskOverrideDeltas {
	destructiveOperationDelta: number;
	crashRecoveryDelta: number;
	readOnlyDelta: number;
}

/** Budget names in the release snapshot, mapped from the adaptive config. */
export type AdaptiveBudgetName = "initial" | "normal" | "debugging" | "architecture" | "recovery" | "repository-wide";

/** The tuned control-loop configuration a release ships with. */
export interface ControlLoopBaseline {
	rrfRankConstant: number;
	laneWeights: Record<MemoryLane, number>;
	coverageTargets: CoverageTargets;
	expansionThresholds: ExpansionThresholdSnapshot;
	riskOverrides: RiskOverrideDeltas;
	adaptiveBudgets: Record<AdaptiveBudgetName, number>;
	absoluteMemoryLimitTokens: number;
	maximumExpansionStepsPerTurn: number;
}

/** Test-run evidence attached to a release by its build pipeline. */
export interface TestVerificationSummary {
	totalTestsPassed: number;
	totalTestsFailed: number;
	totalAssertions: number;
	testSuiteCount: number;
}

export interface ReleaseManifest {
	schemaVersion: string;
	releaseTag: string;
	commitSha: string;
	timestamp: string;
	controlLoopBaseline: ControlLoopBaseline;
	adapterClassifications: LaneClassification[];
	/** Present only when the build pipeline supplied real test evidence. */
	testVerificationSummary?: TestVerificationSummary;
	rollbackTarget: string;
}

export const RELEASE_MANIFEST_SCHEMA_VERSION = "1.0.0";

/**
 * Baseline derived from the live default configurations — never a hardcoded
 * copy, so a tuning change in any source module flows through automatically.
 */
export const CONTROL_LOOP_BASELINE: ControlLoopBaseline = {
	rrfRankConstant: DEFAULT_RRF_CONFIG.rankConstant,
	laneWeights: { ...DEFAULT_RRF_CONFIG.laneWeights },
	coverageTargets: {
		requiredCoverageTarget: 0.9,
		weightedCoverageTarget: 0.85,
		verificationTarget: 0.85,
		provenanceTarget: 1.0,
	},
	expansionThresholds: {
		silentThreshold: DEFAULT_THRESHOLD_CONFIG.silentThreshold,
		activeThreshold: DEFAULT_THRESHOLD_CONFIG.activeThreshold,
		urgentThreshold: DEFAULT_THRESHOLD_CONFIG.urgentThreshold,
	},
	riskOverrides: {
		destructiveOperationDelta: -0.15,
		crashRecoveryDelta: -0.2,
		readOnlyDelta: 0.1,
	},
	adaptiveBudgets: {
		initial: DEFAULT_ADAPTIVE_CONFIG.initialTokenBudget,
		normal: DEFAULT_ADAPTIVE_CONFIG.normalTokenBudget,
		debugging: DEFAULT_ADAPTIVE_CONFIG.debuggingTokenBudget,
		architecture: DEFAULT_ADAPTIVE_CONFIG.architectureTokenBudget,
		recovery: DEFAULT_ADAPTIVE_CONFIG.recoveryTokenBudget,
		"repository-wide": DEFAULT_ADAPTIVE_CONFIG.repoWideTokenBudget,
	},
	absoluteMemoryLimitTokens: DEFAULT_THRESHOLD_CONFIG.maximumTotalExpansionTokens,
	maximumExpansionStepsPerTurn: DEFAULT_THRESHOLD_CONFIG.maximumStepsPerTurn,
};

/** Lane classifications for the five public retrieval lanes. */
export const BASELINE_LANE_CLASSIFICATIONS: ReadonlyArray<LaneClassification> = [
	{ lane: "canonical", name: "SQLite canonical event journal & working state", laneType: "local-sqlite" },
	{ lane: "memvid-lexical", name: "Memvid log-structured lexical evidence", laneType: "log-structured" },
	{ lane: "memvid-temporal", name: "Memvid log-structured temporal timeline", laneType: "log-structured" },
	{ lane: "graphify", name: "Graphify code-graph call paths & impact assertions", laneType: "code-graph" },
	{ lane: "mempalace", name: "MemPalace episodic wings, rooms & drawers", laneType: "episodic" },
];

/** Caller-supplied release facts; the tuned baseline comes from defaults. */
export interface CreateReleaseManifestInput {
	releaseTag: string;
	commitSha: string;
	timestamp: string;
	rollbackTarget?: string;
	testVerificationSummary?: TestVerificationSummary;
}

/** Build a manifest around the current baseline. Deep-copies shared state. */
export function createReleaseManifest(input: CreateReleaseManifestInput): ReleaseManifest {
	const manifest: ReleaseManifest = {
		schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
		releaseTag: input.releaseTag,
		commitSha: input.commitSha,
		timestamp: input.timestamp,
		controlLoopBaseline: {
			...CONTROL_LOOP_BASELINE,
			laneWeights: { ...CONTROL_LOOP_BASELINE.laneWeights },
			coverageTargets: { ...CONTROL_LOOP_BASELINE.coverageTargets },
			expansionThresholds: { ...CONTROL_LOOP_BASELINE.expansionThresholds },
			riskOverrides: { ...CONTROL_LOOP_BASELINE.riskOverrides },
			adaptiveBudgets: { ...CONTROL_LOOP_BASELINE.adaptiveBudgets },
		},
		adapterClassifications: BASELINE_LANE_CLASSIFICATIONS.map(entry => ({ ...entry })),
		rollbackTarget: input.rollbackTarget ?? input.releaseTag,
	};
	if (input.testVerificationSummary) {
		manifest.testVerificationSummary = { ...input.testVerificationSummary };
	}
	return manifest;
}

/** Result of manifest validation; `reasons` lists every failed check. */
export interface ManifestValidation {
	valid: boolean;
	reasons: string[];
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Validate a manifest arriving from storage or the wire. */
export function validateReleaseManifest(manifest: unknown): ManifestValidation {
	if (!manifest || typeof manifest !== "object") {
		return { valid: false, reasons: ["manifest is not an object"] };
	}
	const m = manifest as Partial<ReleaseManifest>;
	const reasons: string[] = [];

	if (m.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
		reasons.push(`schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}`);
	}
	if (typeof m.releaseTag !== "string" || m.releaseTag.length === 0) {
		reasons.push("releaseTag must be a non-empty string");
	}
	if (typeof m.commitSha !== "string" || !COMMIT_SHA_PATTERN.test(m.commitSha)) {
		reasons.push("commitSha must be a 7-40 character hex git SHA");
	}
	if (typeof m.timestamp !== "string" || Number.isNaN(Date.parse(m.timestamp))) {
		reasons.push("timestamp must be a parseable date string");
	}

	const baseline = m.controlLoopBaseline as Partial<ControlLoopBaseline> | undefined;
	if (!baseline) {
		reasons.push("controlLoopBaseline is missing");
	} else {
		if (typeof baseline.rrfRankConstant !== "number" || baseline.rrfRankConstant <= 0) {
			reasons.push("rrfRankConstant must be a positive number");
		}
		const thresholds = baseline.expansionThresholds as Partial<ExpansionThresholdSnapshot> | undefined;
		if (
			!thresholds ||
			typeof thresholds.silentThreshold !== "number" ||
			typeof thresholds.activeThreshold !== "number" ||
			typeof thresholds.urgentThreshold !== "number"
		) {
			reasons.push("expansionThresholds must provide numeric silent/active/urgent thresholds");
		} else {
			const ordered =
				thresholds.silentThreshold < thresholds.activeThreshold &&
				thresholds.activeThreshold < thresholds.urgentThreshold;
			if (!ordered) reasons.push("expansion thresholds must be strictly increasing (silent < active < urgent)");
		}
		if (typeof baseline.absoluteMemoryLimitTokens !== "number" || baseline.absoluteMemoryLimitTokens <= 0) {
			reasons.push("absoluteMemoryLimitTokens must be a positive number");
		}
		if (typeof baseline.maximumExpansionStepsPerTurn !== "number" || baseline.maximumExpansionStepsPerTurn < 1) {
			reasons.push("maximumExpansionStepsPerTurn must be at least 1");
		}
	}

	if (!Array.isArray(m.adapterClassifications) || m.adapterClassifications.length === 0) {
		reasons.push("adapterClassifications must be a non-empty array");
	}
	if (typeof m.rollbackTarget !== "string" || m.rollbackTarget.length === 0) {
		reasons.push("rollbackTarget must be a non-empty string");
	}

	return { valid: reasons.length === 0, reasons };
}
