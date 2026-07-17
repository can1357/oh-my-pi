import { describe, expect, it } from "bun:test";
import type { AssignmentContractV2, AssignmentResultV2 } from "../../src/task/assignment-contract";
import {
	ASSIGNMENT_CONTRACT_V2_VERSION,
	ASSIGNMENT_CONTRACT_VERSION,
	ASSIGNMENT_RESULT_V2_VERSION,
	ASSIGNMENT_RESULT_VERSION,
	computeAssignmentContractDigest,
	parseAssignmentContract,
	parseAssignmentResult,
	withAssignmentContractDigest,
	withAssignmentContractV2Digest,
} from "../../src/task/assignment-contract";

function v2ContractInput(): Omit<AssignmentContractV2, "digest"> {
	return {
		version: ASSIGNMENT_CONTRACT_V2_VERSION,
		id: "roundtrip-v2",
		revision: 3,
		role: "Evidence engineer",
		workClass: "judgment",
		autonomy: "supervised",
		objective: "Establish a lossless contract round trip",
		deliverables: ["report.json", "trace.txt"],
		scope: { allowedPaths: ["packages/coding-agent/src/**"], deniedPaths: ["packages/coding-agent/src/session/**"] },
		procedures: [{ id: "inspect", kind: "command", command: "bun test focused.test.ts" }],
		acceptance: [
			{
				id: "criterion-1",
				description: "Contract round trips",
				check: "artifact_exists",
				params: { path: "report.json" },
			},
		],
		reporting: ASSIGNMENT_RESULT_V2_VERSION,
		nonSolutions: ["Silently dropping policy fields"],
		failureModes: [{ id: "digest-drift", description: "Digest omitted a V2 field" }],
		evidencePolicy: { requireArtifactRefs: true, requireCommandOutput: false },
		strategyFamily: " independent-evidence ",
		independenceGroup: " lane-a ",
		priorBlockedRoutes: [
			{
				family: "legacy-digest",
				mechanism: "unsigned-extension",
				blocker: "Policy fields were omitted",
				blockerFingerprint: "sha256:blocked-route",
			},
		],
		resultRequirements: {
			claimsRequired: true,
			counterevidenceRequired: true,
			unresolvedGapsRequired: true,
		},
	};
}

function v2ResultEnvelope(): Record<string, unknown> {
	return {
		version: ASSIGNMENT_RESULT_V2_VERSION,
		contractId: "roundtrip-v2",
		revision: 3,
		digest: "contract-digest",
		status: "success",
		changedFiles: ["packages/coding-agent/src/task/assignment-contract.ts"],
		evidence: [{ criterionId: "criterion-1", passed: true, summary: "Round trip passed" }],
		evidenceRefs: [
			{
				id: "evidence-test",
				type: "test",
				locator: "packages/coding-agent/test/task/assignment-contract-roundtrip.test.ts",
				digest: "sha256:test",
				producedBy: "ContractLossless",
				independentlyReproducedBy: ["VerifierAdjudicator"],
				sourceAuthority: "direct",
				environment: "windows-bun",
				freshnessDate: "2026-07-11",
			},
			{
				id: "evidence-counter",
				type: "counterexample",
				locator: "test:counterexample",
				producedBy: "ContractLossless",
				sourceAuthority: "primary",
			},
		],
		claims: [
			{
				id: "claim-base",
				statement: "The digest includes all declared V2 fields.",
				supported: true,
				kind: "observation",
				evidenceRefs: ["evidence-test"],
				satisfiesCriteria: ["criterion-1"],
				verificationStatus: "locally-verified",
				residualAssumptions: ["The hash implementation remains deterministic."],
			},
			{
				id: "claim-linked",
				statement: "The parser retains traceable links.",
				supported: true,
				kind: "inference",
				evidenceRefs: ["evidence-test"],
				counterEvidenceRefs: ["evidence-counter"],
				dependsOnClaims: ["claim-base"],
				satisfiesCriteria: ["criterion-1"],
				verificationStatus: "independently-reproduced",
				residualAssumptions: ["Evidence locators remain accessible."],
			},
		],
		counterevidence: [
			{
				summary: "The prior unsigned projection would have accepted stale policy fields.",
				artifactRefs: ["evidence-counter"],
				claimIds: ["claim-linked"],
				criterionIds: ["criterion-1"],
			},
		],
		unresolvedGaps: [{ id: "gap-1", description: "No external implementation is compared." }],
		recommendedNextAction: "Run the focused contract tests.",
	};
}

describe("assignment-contract lossless V2", () => {
	it("round trips every declared V2 contract field through JSON", () => {
		const contract = withAssignmentContractV2Digest(v2ContractInput());
		const parsed = parseAssignmentContract(JSON.parse(JSON.stringify(contract)));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.contract.version !== ASSIGNMENT_CONTRACT_V2_VERSION) return;
		expect(parsed.contract).toEqual(contract);
		expect(Object.isFrozen(parsed.contract.evidencePolicy)).toBe(true);
		expect(Object.isFrozen(parsed.contract.priorBlockedRoutes)).toBe(true);
		expect(Object.isFrozen(parsed.contract.priorBlockedRoutes?.[0])).toBe(true);
		expect(Object.isFrozen(parsed.contract.resultRequirements)).toBe(true);
	});

	it("changes the V2 digest for every formerly omitted field", () => {
		const input = v2ContractInput();
		const original = withAssignmentContractV2Digest(input);
		const flippedEvidencePolicy = withAssignmentContractV2Digest({
			...input,
			evidencePolicy: { requireArtifactRefs: false, requireCommandOutput: false },
		});
		const flippedPriorBlockedRoutes = withAssignmentContractV2Digest({
			...input,
			priorBlockedRoutes: [{ family: "alternate", mechanism: "probe", blocker: "timeout" }],
		});
		const flippedResultRequirements = withAssignmentContractV2Digest({
			...input,
			resultRequirements: {
				claimsRequired: false,
				counterevidenceRequired: true,
				unresolvedGapsRequired: true,
			},
		});

		expect(flippedEvidencePolicy.digest).not.toBe(original.digest);
		expect(flippedPriorBlockedRoutes.digest).not.toBe(original.digest);
		expect(flippedResultRequirements.digest).not.toBe(original.digest);

		const legacyDigest = computeAssignmentContractDigest({
			version: input.version,
			id: input.id,
			revision: input.revision,
			role: input.role,
			workClass: input.workClass,
			autonomy: input.autonomy,
			objective: input.objective,
			deliverables: input.deliverables,
			scope: input.scope,
			procedures: input.procedures,
			acceptance: input.acceptance,
			reporting: input.reporting,
			nonSolutions: input.nonSolutions,
			failureModes: input.failureModes,
			strategyFamily: input.strategyFamily,
			independenceGroup: input.independenceGroup,
		});
		const parsed = parseAssignmentContract({ ...original, digest: legacyDigest });
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: "digest_mismatch" })]);
	});

	it("round trips traceable V2 result claims and evidence", () => {
		// The envelope helper is deliberately loose (Record) so rejection tests can
		// corrupt fields; view it through the V2 shape for the equality assertions.
		const input = v2ResultEnvelope() as Partial<AssignmentResultV2>;
		const parsed = parseAssignmentResult(JSON.parse(JSON.stringify(input)));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.result.version !== ASSIGNMENT_RESULT_V2_VERSION) return;
		expect(parsed.result.evidenceRefs).toEqual(input.evidenceRefs);
		expect(parsed.result.claims).toEqual(input.claims);
		expect(parsed.result.counterevidence).toEqual(input.counterevidence);
		expect(parsed.result.unresolvedGaps).toEqual(input.unresolvedGaps);
		expect(parsed.result.recommendedNextAction).toBe(input.recommendedNextAction);
		expect(Object.isFrozen(parsed.result.evidenceRefs)).toBe(true);
		expect(Object.isFrozen(parsed.result.evidenceRefs?.[0])).toBe(true);
		expect(Object.isFrozen(parsed.result.evidenceRefs?.[0]?.independentlyReproducedBy)).toBe(true);
		expect(Object.isFrozen(parsed.result.claims)).toBe(true);
		expect(Object.isFrozen(parsed.result.claims?.[1]?.dependsOnClaims)).toBe(true);
		expect(Object.isFrozen(parsed.result.counterevidence?.[0]?.claimIds)).toBe(true);
	});

	it("rejects V2 evidence and claim references that cannot be resolved", () => {
		const duplicateEvidenceIds = v2ResultEnvelope();
		duplicateEvidenceIds.evidenceRefs = [
			...(duplicateEvidenceIds.evidenceRefs as unknown[]),
			{ id: "evidence-test", type: "trace", locator: "duplicate", producedBy: "worker", sourceAuthority: "direct" },
		];
		const unknownEvidence = v2ResultEnvelope();
		(unknownEvidence.claims as Array<Record<string, unknown>>)[0].evidenceRefs = ["not-present"];
		const selfDependency = v2ResultEnvelope();
		(selfDependency.claims as Array<Record<string, unknown>>)[0].dependsOnClaims = ["claim-base"];
		const unknownClaim = v2ResultEnvelope();
		(unknownClaim.counterevidence as Array<Record<string, unknown>>)[0].claimIds = ["not-present"];

		for (const input of [duplicateEvidenceIds, unknownEvidence, selfDependency, unknownClaim]) {
			const parsed = parseAssignmentResult(input);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok)
				expect(
					parsed.diagnostics.some(
						diagnostic => diagnostic.code === "invalid_field" || diagnostic.code === "duplicate_criterion",
					),
				).toBe(true);
		}
	});

	it("keeps the V1 digest and parse result byte-compatible", () => {
		const input = {
			version: ASSIGNMENT_CONTRACT_VERSION,
			id: "v1-regression",
			revision: 2,
			role: "Tester",
			workClass: "mechanical" as const,
			autonomy: "bound" as const,
			objective: "Preserve v1",
			deliverables: ["report"],
			scope: { allowedPaths: ["src/**"], deniedPaths: ["src/nope/**"] },
			procedures: [{ id: "p1", kind: "note" as const, note: "Observe" }],
			acceptance: [
				{
					id: "criterion",
					description: "Observed",
					check: "artifact_exists" as const,
					params: { path: "out.txt" },
				},
			],
			reporting: ASSIGNMENT_RESULT_VERSION,
		};
		const digest = computeAssignmentContractDigest(input);
		expect(digest).toBe("5a1b2688d14e8890afd946261b5d085b0c52ce21f40adb96c988f582d88a06d5");

		const expected = withAssignmentContractDigest(input);
		const parsed = parseAssignmentContract({ ...input, digest });
		expect(parsed).toEqual({ ok: true, contract: expected });
	});
});
