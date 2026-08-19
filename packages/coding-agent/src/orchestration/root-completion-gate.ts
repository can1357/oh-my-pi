/**
 * Root-agent completion gate helpers — evaluate contract satisfaction from the
 * session transcript when the main agent stops without a structured yield.
 */

import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import type { CompletionGateInput } from "./completion-gate";
import { type EvidenceKind, EvidenceLedger } from "./evidence-ledger";
import type { ActiveTaskContractSnapshot } from "./task-contract";

const VERIFICATION_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "read", "search", "grep", "eval", "find"]);
const DELIVERABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"bash",
	"apply_patch",
	"ast-edit",
	"ast_edit",
]);

function evidenceKindForTool(toolName: string): EvidenceKind {
	if (toolName === "bash" || toolName === "eval") return "command";
	if (toolName === "read" || toolName === "search" || toolName === "grep" || toolName === "find") return "source";
	return "artifact";
}

function completionEvidenceLedger(
	contract: ActiveTaskContractSnapshot,
	toolResults: readonly ToolResultMessage[],
	sinceTimestamp?: number,
): EvidenceLedger {
	const taskContractId = `root-completion-${sinceTimestamp ?? "session"}`;
	const ledger = new EvidenceLedger(taskContractId);
	const criterionIds = new Set(contract.completionCriteria.map(criterion => criterion.id));

	for (const result of toolResults) {
		const supportedCriteria: string[] = [];
		if (criterionIds.has("targeted_verification") && VERIFICATION_TOOL_NAMES.has(result.toolName)) {
			supportedCriteria.push("targeted_verification");
		}
		if (criterionIds.has("deliverables_present") && DELIVERABLE_TOOL_NAMES.has(result.toolName)) {
			supportedCriteria.push("deliverables_present");
		}
		if (supportedCriteria.length === 0) continue;

		ledger.append({
			taskContractId,
			criterionIds: supportedCriteria,
			claim: `Successful ${result.toolName} tool result`,
			kind: evidenceKindForTool(result.toolName),
			locator: `tool-result://${result.toolCallId}`,
			status: "supports",
			redactionStatus: "clean",
		});
	}

	return ledger;
}

export function collectRecentToolResults(
	messages: readonly AgentMessage[],
	sinceTimestamp?: number,
): readonly ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => {
		if (message.role !== "toolResult") return false;
		if (sinceTimestamp !== undefined && message.timestamp < sinceTimestamp) return false;
		return !message.isError && message.useless !== true;
	});
}

/**
 * Build gate input from transcript tool results since the active contract was set.
 * Uses concrete tool-use signals rather than the model's narrative alone.
 */
export function buildCompletionGateInputFromTranscript(
	contract: ActiveTaskContractSnapshot,
	messages: readonly AgentMessage[],
	sinceTimestamp?: number,
): CompletionGateInput {
	const toolResults = collectRecentToolResults(messages, sinceTimestamp);
	const ledger = completionEvidenceLedger(contract, toolResults, sinceTimestamp);
	const criterionIds = contract.completionCriteria.map(criterion => criterion.id);
	const coverage = ledger.evaluateCriterionCoverage(criterionIds);
	const criteriaEvidence: Record<string, "pass" | "fail" | "unproven"> = {};

	for (const criterion of contract.completionCriteria) {
		const status = coverage[criterion.id];
		if (criterion.id === "deliverables_present" && contract.deliverables.length === 0) {
			criteriaEvidence[criterion.id] = "pass";
		} else {
			criteriaEvidence[criterion.id] = status === "contradicted" ? "fail" : status;
		}
	}

	const hasVerificationEvidence = ledger.supportingForCriterion("targeted_verification").length > 0;
	const hasDeliverableEvidence =
		contract.deliverables.length === 0 || ledger.supportingForCriterion("deliverables_present").length > 0;

	return {
		contract,
		deliverablesPresent: hasDeliverableEvidence ? [...contract.deliverables] : [],
		criteriaEvidence,
		triggeredNonSolutions: [],
		requiredEvidencePresent: hasVerificationEvidence,
		unresolvedBlockers: [],
		scopeValid: true,
	};
}
