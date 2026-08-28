/**
 * Coverage-Driven Expansion Builder & Diagnostic Explanation
 *
 * Maps context coverage gaps directly to targeted expansion requests and
 * builds unified control loop diagnostics for logging & guardian explain.
 */

import type { ContextExpansionRequest } from "./adaptive-fidelity/types";
import type { ContextCoverageReport } from "./contextual-coverage";
import type { ExpansionDecisionResult } from "./expansion-thresholds";
import type { FusedMemoryItem } from "./rrf-fusion";
import { formatRRFExplanation } from "./rrf-fusion";

/**
 * Calculate expansion token budget based on coverage deficit.
 *
 * Buckets: deficit <= 0.1 -> 3000, deficit <= 0.3 -> 6000, else 8000.
 * Compares coverage directly rather than the subtracted deficit so that
 * floating-point noise (1 - 0.7 = 0.30000000000000004) cannot push a
 * boundary value into the wrong bucket.
 */
export function calculateCoverageExpansionBudget(report: ContextCoverageReport): number {
	if (report.requiredCoverage >= 0.9) return 3000;
	if (report.requiredCoverage >= 0.7) return 6000;
	return 8000;
}

/**
 * Build a targeted expansion request based on ContextCoverageReport gap
 * analysis.
 *
 * The caller supplies the turn identifier: request construction is pure and
 * deterministic, so the same report and turn always produce the same request.
 */
export function buildCoverageExpansion(report: ContextCoverageReport, turnId: string): ContextExpansionRequest | null {
	if (
		report.requiredCoverage >= 0.9 &&
		report.unresolvedNeedIds.length === 0 &&
		report.missingCriticalNeedIds.length === 0
	) {
		return null;
	}

	const tiers = report.recommendedExpansionTiers;
	if (tiers.length === 0) {
		return null;
	}

	const budget = calculateCoverageExpansionBudget(report);
	const coverageText = report.requiredCoverage.toFixed(2);
	const unresolvedText = report.unresolvedNeedIds.join(", ");

	return {
		packetId: report.packetId,
		turnId,
		trigger: "low-retrieval-confidence",
		requestedTiers: tiers,
		topics: report.recommendedQueries,
		maximumAdditionalTokens: budget,
		reason: `Required context coverage is ${coverageText}. Unresolved needs: ${unresolvedText}`,
	};
}

/**
 * Format coverage report diagnostics for logging and guardian explain.
 */
export function formatCoverageExplanation(report: ContextCoverageReport): string {
	const requiredPct = (report.requiredCoverage * 100).toFixed(1);
	const requiredRatio = `${report.satisfiedNeedIds.length}/${report.requiredNeeds}`;
	const lines = [
		`Context Coverage Report [Packet: ${report.packetId}]`,
		`  Required coverage: ${requiredPct}% (${requiredRatio})`,
		`  Weighted coverage: ${(report.weightedCoverage * 100).toFixed(1)}%`,
		`  Verification coverage: ${(report.verificationCoverage * 100).toFixed(1)}%`,
		`  Provenance coverage: ${(report.provenanceCoverage * 100).toFixed(1)}%`,
		`  Freshness coverage: ${(report.freshnessCoverage * 100).toFixed(1)}%`,
		`  Satisfied needs: ${report.satisfiedNeedIds.join(", ") || "none"}`,
	];

	if (report.partiallySatisfiedNeedIds.length > 0) {
		lines.push(`  Partially satisfied needs: ${report.partiallySatisfiedNeedIds.join(", ")}`);
	}

	if (report.unresolvedNeedIds.length > 0) {
		lines.push(`  Unresolved needs: ${report.unresolvedNeedIds.join(", ")}`);
	}

	if (report.contradictedNeedIds.length > 0) {
		lines.push(`  Contradicted needs: ${report.contradictedNeedIds.join(", ")}`);
	}

	if (report.recommendedExpansionTiers.length > 0) {
		lines.push(`  Recommended expansion tiers: ${report.recommendedExpansionTiers.join(", ")}`);
	}

	return lines.join("\n");
}

/**
 * Unified diagnostic explanation for the complete control loop:
 * RRF Fusion -> Coverage Evaluator -> Expansion Threshold Decision.
 */
export function formatControlLoopExplanation(
	fusedItems: FusedMemoryItem[],
	coverageReport: ContextCoverageReport,
	expansionDecision: ExpansionDecisionResult,
): string {
	const sections: string[] = [];

	sections.push("================ CONTROL LOOP DIAGNOSTIC EXPLANATION ================");
	sections.push(`Action Decision: ${expansionDecision.action.toUpperCase()}`);
	sections.push(`Reason: ${expansionDecision.reason}`);
	sections.push(
		`Score: ${expansionDecision.score.toFixed(4)} | Threshold: ${expansionDecision.effectiveThreshold.toFixed(4)}`,
	);

	if (expansionDecision.tiers?.length) {
		sections.push(`Target Tiers: ${expansionDecision.tiers.join(", ")}`);
	}

	sections.push("\n--- COVERAGE ANALYSIS ---");
	sections.push(formatCoverageExplanation(coverageReport));

	sections.push(`\n--- RRF FUSED CANDIDATES (Top ${Math.min(5, fusedItems.length)}) ---`);
	for (const item of fusedItems.slice(0, 5)) {
		sections.push(formatRRFExplanation(item));
		sections.push("");
	}

	sections.push("====================================================================");

	return sections.join("\n");
}
