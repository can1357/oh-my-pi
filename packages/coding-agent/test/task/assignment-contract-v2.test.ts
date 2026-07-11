import { describe, expect, it } from "bun:test";
import {
	ASSIGNMENT_CONTRACT_V2_VERSION,
	ASSIGNMENT_RESULT_V2_VERSION,
	computeAssignmentContractDigest,
	parseAssignmentContract,
	parseAssignmentResult,
} from "../../src/task/assignment-contract";

describe("assignment-contract v2", () => {
	it("parses v2 contracts with nonSolutions and strategyFamily", () => {
		const digest = computeAssignmentContractDigest({
			version: ASSIGNMENT_CONTRACT_V2_VERSION,
			id: "a1",
			revision: 0,
			role: "Investigator",
			workClass: "judgment",
			autonomy: "bound",
			objective: "Find root cause",
			deliverables: ["Report"],
			scope: { allowedPaths: [] },
			acceptance: [{ id: "evidence", description: "Repro captured", check: "artifact_exists", params: { path: "repro.txt" } }],
			reporting: ASSIGNMENT_RESULT_V2_VERSION,
			nonSolutions: ["Guess without reading logs"],
			strategyFamily: "persistence",
		});

		const parsed = parseAssignmentContract({
			version: ASSIGNMENT_CONTRACT_V2_VERSION,
			id: "a1",
			revision: 0,
			digest,
			role: "Investigator",
			workClass: "judgment",
			autonomy: "bound",
			objective: "Find root cause",
			deliverables: ["Report"],
			scope: { allowedPaths: [] },
			acceptance: [{ id: "evidence", description: "Repro captured", check: "artifact_exists", params: { path: "repro.txt" } }],
			reporting: ASSIGNMENT_RESULT_V2_VERSION,
			nonSolutions: ["Guess without reading logs"],
			strategyFamily: "persistence",
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.contract.version).toBe(ASSIGNMENT_CONTRACT_V2_VERSION);
		if ("strategyFamily" in parsed.contract) {
			expect(parsed.contract.strategyFamily).toBe("persistence");
		}
	});

	it("accepts falsified assignment results in v2", () => {
		const parsed = parseAssignmentResult({
			version: ASSIGNMENT_RESULT_V2_VERSION,
			contractId: "a1",
			revision: 0,
			digest: "abc",
			status: "falsified",
			changedFiles: [],
			evidence: [{ criterionId: "evidence", passed: false, summary: "Approach disproved" }],
			summary: "Route blocked by missing API",
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.result.status).toBe("falsified");
	});
});
