/**
 * Contract prompt injector.
 *
 * Contract blocks are ephemeral message-level context. This module owns their
 * XML shape so executor and advisor blocks carry the same digest and safely
 * escape XML text and attribute values.
 */

import type { AssumptionRecord, ContractGap } from "./intent-compiler";
import type { TaskContractV1 } from "./task-contract";

export type PromptTarget = "executor" | "advisor";

export interface InjectionBlock {
	readonly target: PromptTarget;
	readonly digest: string;
	readonly text: string;
}

export function buildContractInjectionBlock(
	contract: TaskContractV1,
	digest: string,
	target: PromptTarget,
	gaps: readonly ContractGap[] = [],
	assumptions: readonly AssumptionRecord[] = [],
	unresolvedBlocked = false,
): InjectionBlock {
	const text =
		target === "executor"
			? buildExecutorBlock(contract, digest, gaps, unresolvedBlocked)
			: buildAdvisorBlock(contract, digest, gaps, assumptions, unresolvedBlocked);
	return Object.freeze({ target, digest, text });
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function buildExecutorBlock(
	contract: TaskContractV1,
	digest: string,
	gaps: readonly ContractGap[],
	unresolvedBlocked: boolean,
): string {
	if (!contract.objective.trim()) return "";
	const prefix = digest.trim().slice(0, 16);
	const parts: string[] = [
		`<task-contract version="${escapeXml(contract.version)}" digest="${escapeXml(prefix)}">`,
		`  <objective>${escapeXml(contract.objective)}</objective>`,
	];

	if (contract.deliverables.length > 0) {
		parts.push("  <deliverables>");
		for (const deliverable of contract.deliverables) parts.push(`    <item>${escapeXml(deliverable)}</item>`);
		parts.push("  </deliverables>");
	}
	if (contract.completionCriteria.length > 0) {
		parts.push("  <completion-criteria>");
		for (const criterion of contract.completionCriteria) {
			parts.push(`    <criterion id="${escapeXml(criterion.id)}">${escapeXml(criterion.description)}</criterion>`);
		}
		parts.push("  </completion-criteria>");
	}
	if (contract.nonSolutions.length > 0) {
		parts.push("  <non-solutions>");
		for (const nonSolution of contract.nonSolutions) parts.push(`    <item>${escapeXml(nonSolution)}</item>`);
		parts.push("  </non-solutions>");
	}
	if (contract.knownFailureModes.length > 0) {
		parts.push("  <known-failure-modes>");
		for (const failureMode of contract.knownFailureModes) {
			parts.push(
				`    <failure-mode id="${escapeXml(failureMode.id)}">${escapeXml(failureMode.description)}</failure-mode>`,
			);
		}
		parts.push("  </known-failure-modes>");
	}
	if (contract.constraints.length > 0) {
		parts.push("  <constraints>");
		for (const constraint of contract.constraints) parts.push(`    <item>${escapeXml(constraint)}</item>`);
		parts.push("  </constraints>");
	}
	if (contract.assumptions.length > 0) {
		parts.push("  <assumptions>");
		for (const assumption of contract.assumptions) {
			const verified = assumption.verified === undefined ? "" : ` verified="${assumption.verified}"`;
			parts.push(
				`    <assumption id="${escapeXml(assumption.id)}"${verified}>${escapeXml(assumption.statement)}</assumption>`,
			);
		}
		parts.push("  </assumptions>");
	}
	if (contract.evidenceRequirements.length > 0) {
		parts.push("  <evidence-requirements>");
		for (const requirement of contract.evidenceRequirements) {
			parts.push(
				`    <requirement id="${escapeXml(requirement.id)}">${escapeXml(requirement.description)}</requirement>`,
			);
		}
		parts.push("  </evidence-requirements>");
	}

	const unresolved = gaps.filter(gap => gap.hardOverride !== undefined || gap.priorityScore >= 0.6);
	if (unresolved.length > 0) {
		parts.push(unresolvedBlocked ? '  <unresolved blocked="true">' : "  <unresolved>");
		for (const gap of unresolved) {
			const question = gap.questionSpec ? ` question="${escapeXml(gap.questionSpec.questionText)}"` : "";
			parts.push(
				`    <gap id="${escapeXml(gap.id)}" field="${escapeXml(gap.field)}" impact="${escapeXml(gap.impact)}" risk="${escapeXml(gap.risk)}"${question}>${escapeXml(gap.description)}</gap>`,
			);
		}
		parts.push("  </unresolved>");
	}

	parts.push("</task-contract>");
	return parts.join("\n");
}

function buildAdvisorBlock(
	contract: TaskContractV1,
	digest: string,
	gaps: readonly ContractGap[],
	assumptions: readonly AssumptionRecord[],
	unresolvedBlocked: boolean,
): string {
	if (!contract.objective.trim()) return "";
	const prefix = digest.trim().slice(0, 16);
	const parts: string[] = [
		`<active-task-contract digest="${escapeXml(prefix)}">`,
		`  <objective>${escapeXml(contract.objective)}</objective>`,
	];
	if (contract.deliverables.length > 0) {
		parts.push(`  <deliverables>${contract.deliverables.map(escapeXml).join(" | ")}</deliverables>`);
	}
	if (contract.completionCriteria.length > 0) {
		parts.push("  <criteria>");
		for (const criterion of contract.completionCriteria) {
			parts.push(`    <c id="${escapeXml(criterion.id)}">${escapeXml(criterion.description)}</c>`);
		}
		parts.push("  </criteria>");
	}
	if (contract.nonSolutions.length > 0) {
		parts.push(`  <non-solutions>${contract.nonSolutions.map(escapeXml).join("; ")}</non-solutions>`);
	}

	const highImpactAssumptions = assumptions.filter(
		assumption =>
			!assumption.verified && (assumption.impactIfWrong === "critical" || assumption.impactIfWrong === "high"),
	);
	if (highImpactAssumptions.length > 0) {
		parts.push("  <unverified-assumptions>");
		for (const assumption of highImpactAssumptions) {
			parts.push(
				`    <assumption field="${escapeXml(assumption.field)}" impact="${escapeXml(assumption.impactIfWrong)}">${escapeXml(assumption.statement)}</assumption>`,
			);
		}
		parts.push("  </unverified-assumptions>");
	}

	const materialGaps = gaps.filter(
		gap => gap.hardOverride !== undefined || gap.risk === "blocking" || gap.risk === "significant",
	);
	if (materialGaps.length > 0) {
		parts.push(unresolvedBlocked ? '  <open-gaps blocked="true">' : "  <open-gaps>");
		for (const gap of materialGaps) {
			parts.push(
				`    <gap id="${escapeXml(gap.id)}" field="${escapeXml(gap.field)}" impact="${escapeXml(gap.impact)}" risk="${escapeXml(gap.risk)}">${escapeXml(gap.description)}</gap>`,
			);
		}
		parts.push("  </open-gaps>");
	}

	parts.push("</active-task-contract>");
	return parts.join("\n");
}

/** Build a focused recovery block; return nothing when there is no recovery context. */
export function buildRecoveryInjection(missingCriteriaIds: readonly string[], blockerSummary: string): string {
	const criteria = missingCriteriaIds.map(id => id.trim()).filter(Boolean);
	const summary = blockerSummary.trim();
	if (criteria.length === 0 && !summary) return "";
	const parts = ["<completion-gate-failure>"];
	for (const criterionId of criteria) parts.push(`  <unmet-criterion id="${escapeXml(criterionId)}" />`);
	if (summary) parts.push(`  <recovery-instruction>${escapeXml(summary)}</recovery-instruction>`);
	parts.push("</completion-gate-failure>");
	return parts.join("\n");
}
