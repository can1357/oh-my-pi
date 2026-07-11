import { describe, expect, it } from "bun:test";
import {
	compileTaskContractFromRequest,
	formatRootTaskContractXml,
	formatTaskContractXmlBlock,
	isSubstantialRequest,
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

	it("rejects a contract with missing objective", () => {
		const result = parseTaskContract({
			version: "task-contract/v1",
			deliverables: ["X"],
			completionCriteria: [{ id: "c1", description: "done" }],
			nonSolutions: [],
		});
		expect(result.ok).toBe(false);
	});

	describe("isSubstantialRequest", () => {
		it("marks multi-line requests as substantial", () => {
			const text = "Line 1\nLine 2\nLine 3\nLine 4";
			expect(isSubstantialRequest(text)).toBe(true);
		});

		it("marks long single-line requests as substantial", () => {
			const text = "a".repeat(250);
			expect(isSubstantialRequest(text)).toBe(true);
		});

		it("marks action-keyword requests as substantial", () => {
			expect(isSubstantialRequest("implement the caching layer")).toBe(true);
			expect(isSubstantialRequest("fix the bug in auth.ts")).toBe(true);
			expect(isSubstantialRequest("refactor the session manager")).toBe(true);
		});

		it("does not mark trivial messages as substantial", () => {
			expect(isSubstantialRequest("hi")).toBe(false);
			expect(isSubstantialRequest("")).toBe(false);
			expect(isSubstantialRequest("what time is it")).toBe(false);
		});
	});

	describe("compileTaskContractFromRequest", () => {
		it("produces a valid contract with default criteria", () => {
			const contract = compileTaskContractFromRequest("implement the new auth flow");
			expect(contract.version).toBe("task-contract/v1");
			expect(contract.objective).toContain("implement");
			expect(contract.completionCriteria.length).toBeGreaterThan(0);
			expect(contract.nonSolutions.length).toBeGreaterThan(0);
			expect(contract.knownFailureModes.length).toBeGreaterThan(0);
			expect(contract.evidenceRequirements.length).toBeGreaterThan(0);
			expect(contract.verificationPolicy.requireTargetedChecks).toBe(true);
		});

		it("includes supplied nonSolutions alongside defaults", () => {
			const contract = compileTaskContractFromRequest("fix the bug", {
				nonSolutions: ["Patch the test to hide the failure"],
			});
			expect(contract.nonSolutions).toContain("Patch the test to hide the failure");
			// Default non-solutions still present
			expect(contract.nonSolutions.some(s => s.includes("verification"))).toBe(true);
		});

		it("truncates very long objectives to 300 chars", () => {
			const longText = `implement ${"x".repeat(400)}`;
			const contract = compileTaskContractFromRequest(longText);
			expect(contract.objective.length).toBeLessThanOrEqual(300);
		});

		it("includes maxInitialFamilies in orchestrationPolicy when supplied", () => {
			const contract = compileTaskContractFromRequest("investigate the performance issue", {
				maxInitialFamilies: 3,
			});
			expect(contract.orchestrationPolicy.maxInitialFamilies).toBe(3);
		});
	});

	describe("formatRootTaskContractXml", () => {
		it("uses task-contract outer tag, not active-task-contract", () => {
			const contract = compileTaskContractFromRequest("implement the auth flow");
			const xml = formatRootTaskContractXml(contract);
			expect(xml).toContain('<task-contract version="task-contract/v1">');
			expect(xml).not.toContain("<active-task-contract>");
			expect(xml).toContain("</task-contract>");
		});

		it("escapes XML special characters in objective", () => {
			const contract = compileTaskContractFromRequest('Fix "quote" & <tag> issue');
			const xml = formatRootTaskContractXml(contract);
			expect(xml).toContain("&amp;");
			expect(xml).toContain("&lt;");
		});

		it("includes completion criteria and non-solutions", () => {
			const contract = compileTaskContractFromRequest("implement auth");
			const xml = formatRootTaskContractXml(contract);
			expect(xml).toContain("<completion-criteria>");
			expect(xml).toContain("<non-solutions>");
		});

		it("is distinct from formatTaskContractXmlBlock (advisor format)", () => {
			const contract = compileTaskContractFromRequest("implement auth");
			const snapshot = toActiveTaskContractSnapshot(contract);
			const rootXml = formatRootTaskContractXml(contract);
			const advisorXml = formatTaskContractXmlBlock(snapshot);
			expect(rootXml).toContain("<task-contract");
			expect(advisorXml).toContain("<active-task-contract>");
			expect(rootXml).not.toEqual(advisorXml);
		});
	});

	describe("searchBudget in orchestrationPolicy", () => {
		it("parses searchBudget when present in the contract", () => {
			const parsed = parseTaskContract({
				version: "task-contract/v1",
				objective: "investigate bug",
				deliverables: [],
				completionCriteria: [{ id: "c1", description: "root cause found" }],
				nonSolutions: [],
				orchestrationPolicy: {
					preferIndependence: true,
					searchBudget: {
						maxInitialFamilies: 4,
						maxRounds: 3,
						maxSameBlockerRetries: 1,
						minEvidenceGainToContinue: 0.2,
					},
				},
			});
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(parsed.contract.orchestrationPolicy.searchBudget).toBeDefined();
			expect(parsed.contract.orchestrationPolicy.searchBudget?.maxInitialFamilies).toBe(4);
			expect(parsed.contract.orchestrationPolicy.searchBudget?.maxRounds).toBe(3);
		});
	});
});
