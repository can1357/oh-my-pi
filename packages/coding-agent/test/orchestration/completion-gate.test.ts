import { describe, expect, it } from "bun:test";
import { evaluateCompletionGate } from "../../src/orchestration/completion-gate";

describe("completion gate", () => {
	const contract = {
		objective: "Fix bug",
		deliverables: ["test", "fix"],
		completionCriteria: [
			{ id: "c1", description: "Regression test added" },
			{ id: "c2", description: "Root cause fixed" },
		],
		nonSolutions: ["Disable test"],
		knownFailureModes: [],
	};

	it("passes when all gates satisfied", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: true, c2: true },
			triggeredNonSolutions: [],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("pass");
	});

	it("blocks when a non-solution triggered", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: true, c2: true },
			triggeredNonSolutions: ["Disable test"],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("blocked");
		expect(result.gate.nonSolutionTriggered).toBe(true);
	});

	it("returns recoverable when criteria missing", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["fix"],
			criteriaEvidence: { c1: false, c2: true },
			triggeredNonSolutions: [],
			requiredEvidencePresent: false,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("recoverable");
		expect(result.missingCriteria).toContain("c1");
	});
});
