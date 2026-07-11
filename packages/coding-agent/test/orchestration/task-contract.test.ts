import { describe, expect, it } from "bun:test";
import {
	formatTaskContractXmlBlock,
	parseTaskContract,
	toActiveTaskContractSnapshot,
} from "../../src/orchestration/task-contract";

describe("task-contract", () => {
	it("parses a valid task contract", () => {
		const parsed = parseTaskContract({
			version: "task-contract/v1",
			objective: "Ship typed contracts",
			deliverables: ["Parser", "Tests"],
			completionCriteria: [{ id: "done", description: "Tests pass" }],
			nonSolutions: ["Skip verification"],
			knownFailureModes: [{ id: "fm1", description: "Digest drift" }],
			evidenceRequirements: [],
			constraints: [],
			assumptions: [],
			verificationPolicy: { requireTargetedChecks: true, allowNarrativeOnly: false },
			orchestrationPolicy: { preferIndependence: true },
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const snapshot = toActiveTaskContractSnapshot(parsed.contract);
		const xml = formatTaskContractXmlBlock(snapshot);
		expect(xml).toContain("<active-task-contract>");
		expect(xml).toContain("Skip verification");
	});
});
