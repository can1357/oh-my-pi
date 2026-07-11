import { describe, expect, it } from "bun:test";
import { evaluateCompletionGate } from "../../src/orchestration/completion-gate";
import { buildCompletionGateInputFromYield } from "../../src/tools/yield";

const oneCriterionContract = {
	objective: "Prove the change",
	deliverables: [],
	completionCriteria: [{ id: "c1", description: "Evidence exists" }],
	nonSolutions: [],
	knownFailureModes: [],
};

describe("yield completion gate input", () => {
	it("treats a bare self-reported pass as unproven", () => {
		const input = buildCompletionGateInputFromYield(oneCriterionContract, {
			evidence: [{ criterionId: "c1", passed: true, summary: "done" }],
		});
		const result = evaluateCompletionGate(input);

		expect(input.criteriaEvidence).toEqual({ c1: "unproven" });
		expect(result.outcome).toBe("recoverable");
		expect(result.unprovenCriteria).toEqual(["c1"]);
	});

	it("accepts an artifact-backed pass", () => {
		const input = buildCompletionGateInputFromYield(oneCriterionContract, {
			evidence: [{ criterionId: "c1", passed: true, artifactRefs: ["artifact://1"] }],
		});
		const result = evaluateCompletionGate(input);

		expect(input.criteriaEvidence).toEqual({ c1: "pass" });
		expect(result.outcome).toBe("pass");
	});

	it("requires evidence coverage for every completion criterion", () => {
		const input = buildCompletionGateInputFromYield(
			{
				...oneCriterionContract,
				completionCriteria: [
					{ id: "c1", description: "First evidence exists" },
					{ id: "c2", description: "Second evidence exists" },
				],
			},
			{ evidence: [{ criterionId: "c1", passed: false }] },
		);

		expect(input.requiredEvidencePresent).toBe(false);
	});

	it("does not infer deliverables from changed files", () => {
		const contract = { ...oneCriterionContract, deliverables: ["expected-deliverable"] };
		const input = buildCompletionGateInputFromYield(contract, { changedFiles: ["x.ts"] });

		expect(input.deliverablesPresent).toEqual([]);
	});
});
