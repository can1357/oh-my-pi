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
		expect(result.failedCriteria).toEqual(["c1"]);
		expect(result.unprovenCriteria).toEqual([]);
	});

	it("distinguishes unproven criteria from failed criteria", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: "pass" },
			triggeredNonSolutions: [],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("recoverable");
		expect(result.failedCriteria).toEqual([]);
		expect(result.unprovenCriteria).toEqual(["c2"]);
		expect(result.missingCriteria).toEqual(["c2"]);
		expect(result.reminder).toContain("Unproven criteria (no independent evidence): c2");
	});

	it("reports explicitly failed criteria", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: "fail", c2: "pass" },
			triggeredNonSolutions: [],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("recoverable");
		expect(result.failedCriteria).toEqual(["c1"]);
		expect(result.unprovenCriteria).toEqual([]);
		expect(result.missingCriteria).toEqual(["c1"]);
	});

	it("passes when every criterion has pass status", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: "pass", c2: "pass" },
			triggeredNonSolutions: [],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("pass");
	});

	it("normalizes mixed boolean and status evidence", () => {
		const result = evaluateCompletionGate({
			contract,
			deliverablesPresent: ["test", "fix"],
			criteriaEvidence: { c1: true, c2: "pass" },
			triggeredNonSolutions: [],
			requiredEvidencePresent: true,
			unresolvedBlockers: [],
			scopeValid: true,
		});
		expect(result.outcome).toBe("pass");
	});
});
