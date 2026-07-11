/**
 * Root completion gate — structured success criteria beyond prose verification.
 */

import type { ActiveTaskContractSnapshot } from "./task-contract";

export type CompletionGateOutcome = "pass" | "recoverable" | "blocked";

export interface CompletionGateInput {
	readonly contract: ActiveTaskContractSnapshot;
	readonly deliverablesPresent: readonly string[];
	readonly criteriaEvidence: Readonly<Record<string, boolean | "pass" | "fail" | "unproven">>;
	readonly triggeredNonSolutions: readonly string[];
	readonly requiredEvidencePresent: boolean;
	readonly unresolvedBlockers: readonly string[];
	readonly scopeValid: boolean;
}

export interface CompletionGate {
	readonly allDeliverablesPresent: boolean;
	readonly criteriaSatisfied: boolean;
	readonly nonSolutionTriggered: boolean;
	readonly requiredEvidencePresent: boolean;
	readonly unresolvedBlockersAcknowledged: boolean;
	readonly scopeValid: boolean;
}

export interface CompletionGateEvaluation {
	readonly gate: CompletionGate;
	readonly outcome: CompletionGateOutcome;
	readonly missingCriteria: readonly string[];
	readonly failedCriteria: readonly string[];
	readonly unprovenCriteria: readonly string[];
	readonly reminder?: string;
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateEvaluation {
	const deliverableSet = new Set(input.deliverablesPresent.map(d => d.trim()).filter(Boolean));
	const allDeliverablesPresent = input.contract.deliverables.every(d => deliverableSet.has(d.trim()));

	const missingCriteria: string[] = [];
	const failedCriteria: string[] = [];
	const unprovenCriteria: string[] = [];
	let criteriaSatisfied = true;
	for (const criterion of input.contract.completionCriteria) {
		const evidence = input.criteriaEvidence[criterion.id];
		let status: "pass" | "fail" | "unproven";
		switch (evidence) {
			case true:
				status = "pass";
				break;
			case false:
				status = "fail";
				break;
			case "pass":
			case "fail":
			case "unproven":
				status = evidence;
				break;
			default:
				status = "unproven";
		}

		switch (status) {
			case "pass":
				break;
			case "fail":
				criteriaSatisfied = false;
				failedCriteria.push(criterion.id);
				missingCriteria.push(criterion.id);
				break;
			case "unproven":
				criteriaSatisfied = false;
				unprovenCriteria.push(criterion.id);
				missingCriteria.push(criterion.id);
				break;
		}
	}

	const nonSolutionTriggered = input.triggeredNonSolutions.length > 0;
	const unresolvedBlockersAcknowledged =
		input.unresolvedBlockers.length === 0 ||
		input.unresolvedBlockers.every(b => typeof b === "string" && b.trim().length > 0);

	const gate: CompletionGate = Object.freeze({
		allDeliverablesPresent,
		criteriaSatisfied,
		nonSolutionTriggered,
		requiredEvidencePresent: input.requiredEvidencePresent,
		unresolvedBlockersAcknowledged,
		scopeValid: input.scopeValid,
	});

	let outcome: CompletionGateOutcome = "pass";
	if (
		!gate.scopeValid ||
		nonSolutionTriggered ||
		(input.unresolvedBlockers.length > 0 && !unresolvedBlockersAcknowledged)
	) {
		outcome = "blocked";
	} else if (!allDeliverablesPresent || !criteriaSatisfied || !input.requiredEvidencePresent) {
		outcome = "recoverable";
	}

	let reminder: string | undefined;
	if (outcome === "recoverable") {
		const parts: string[] = [];
		if (!allDeliverablesPresent) {
			parts.push(
				`Missing deliverables: ${input.contract.deliverables.filter(d => !deliverableSet.has(d.trim())).join(", ")}`,
			);
		}
		if (failedCriteria.length > 0) {
			parts.push(`Failed criteria: ${failedCriteria.join(", ")}`);
		}
		if (unprovenCriteria.length > 0) {
			parts.push(`Unproven criteria (no independent evidence): ${unprovenCriteria.join(", ")}`);
		}
		if (!input.requiredEvidencePresent) {
			parts.push("Required evidence is not present.");
		}
		reminder = parts.join(" ");
	}

	return Object.freeze({
		gate,
		outcome,
		missingCriteria: Object.freeze([...missingCriteria]),
		failedCriteria: Object.freeze([...failedCriteria]),
		unprovenCriteria: Object.freeze([...unprovenCriteria]),
		reminder,
	});
}
