import { describe, expect, test } from "bun:test";
import {
	type AdjudicationLane,
	adjudicateCriteria,
	judgmentsToCriteriaEvidence,
} from "../../src/orchestration/criterion-adjudication";
import {
	ASSIGNMENT_RESULT_V2_VERSION,
	type AssignmentResultV2,
	type Claim,
	type ClaimVerificationStatus,
	type EvidenceRef,
} from "../../src/task/assignment-contract";

function makeResult(overrides: Partial<AssignmentResultV2>): AssignmentResultV2 {
	return {
		version: ASSIGNMENT_RESULT_V2_VERSION,
		contractId: "assignment",
		revision: 1,
		digest: "digest",
		status: "success",
		changedFiles: [],
		evidence: [],
		...overrides,
	};
}

function makeEvidenceRef(id: string, producedBy: string, independentlyReproducedBy?: readonly string[]): EvidenceRef {
	return {
		id,
		type: "test",
		locator: `artifact://${id}`,
		producedBy,
		sourceAuthority: "direct",
		...(independentlyReproducedBy ? { independentlyReproducedBy } : {}),
	};
}

function makeClaim(
	id: string,
	criterionId: string,
	evidenceRefs: readonly string[],
	verificationStatus: ClaimVerificationStatus = "locally-verified",
): Claim {
	return {
		id,
		statement: `Claim ${id}`,
		supported: true,
		satisfiesCriteria: [criterionId],
		evidenceRefs,
		verificationStatus,
	};
}

const criterion = [{ id: "criterion-a" }];

describe("adjudicateCriteria", () => {
	test("records a parent-executed pass with its linked evidence", () => {
		const judgment = adjudicateCriteria(criterion, [
			{
				laneId: "parent",
				verification: [{ criterionId: "criterion-a", passed: true, status: "pass", parentExecuted: true }],
				result: makeResult({
					claims: [makeClaim("claim-a", "criterion-a", ["evidence-a"])],
					evidenceRefs: [makeEvidenceRef("evidence-a", "parent")],
				}),
			},
		]);

		expect(judgment).toEqual([
			expect.objectContaining({
				criterionId: "criterion-a",
				status: "pass",
				acceptedClaimIds: ["claim-a"],
				evidenceRefs: ["evidence-a"],
				sourceLaneIds: ["parent"],
			}),
		]);
	});

	test("leaves a self-reported pass unproven", () => {
		const [judgment] = adjudicateCriteria(criterion, [
			{ laneId: "self", verification: [{ criterionId: "criterion-a", passed: true }] },
		]);

		expect(judgment).toEqual(
			expect.objectContaining({
				status: "unproven",
				discriminatingQuestion:
					'No independent evidence for criterion "criterion-a"; provide a parent-run check or a reproduction from a second lane.',
			}),
		);
	});

	test("accepts evidence independently reproduced by another lane", () => {
		const [judgment] = adjudicateCriteria(criterion, [
			{
				laneId: "first",
				verification: [{ criterionId: "criterion-a", passed: true }],
				result: makeResult({
					claims: [makeClaim("claim-a", "criterion-a", ["evidence-a"])],
					evidenceRefs: [makeEvidenceRef("evidence-a", "first", ["second"])],
				}),
			},
		]);

		expect(judgment).toEqual(expect.objectContaining({ status: "pass", sourceLaneIds: ["first"] }));
	});

	test("lets counterevidence defeat a self-reported pass", () => {
		const [judgment] = adjudicateCriteria(criterion, [
			{
				laneId: "self",
				verification: [{ criterionId: "criterion-a", passed: true }],
				result: makeResult({
					counterevidence: [{ summary: "Reproduction disproved claim", criterionIds: ["criterion-a"] }],
				}),
			},
		]);

		expect(judgment?.status).toBe("fail");
	});

	test("records a parent-executed failed check as failed", () => {
		const [judgment] = adjudicateCriteria(criterion, [
			{
				laneId: "parent",
				verification: [{ criterionId: "criterion-a", passed: false, status: "fail", parentExecuted: true }],
			},
		]);

		expect(judgment?.status).toBe("fail");
	});

	test("maps fully blocked criteria to unproven completion evidence", () => {
		const [judgment] = adjudicateCriteria(criterion, [
			{
				laneId: "one",
				blocked: true,
				verification: [{ criterionId: "criterion-a", passed: false, status: "unproven" }],
			},
			{
				laneId: "two",
				blocked: true,
				verification: [{ criterionId: "criterion-a", passed: false, status: "unproven" }],
			},
		]);

		expect(judgment?.status).toBe("blocked");
		expect(judgmentsToCriteriaEvidence(judgment ? [judgment] : [])).toEqual({ "criterion-a": "unproven" });
	});

	test("does not treat duplicate same-producer evidence as independent", () => {
		const result = makeResult({
			claims: [makeClaim("claim-a", "criterion-a", ["evidence-a"])],
			evidenceRefs: [makeEvidenceRef("evidence-a", "producer")],
		});
		const [judgment] = adjudicateCriteria(criterion, [
			{ laneId: "one", verification: [{ criterionId: "criterion-a", passed: true }], result },
			{ laneId: "two", verification: [{ criterionId: "criterion-a", passed: true }], result },
		]);

		expect(judgment?.status).toBe("unproven");
	});

	test("adjudicates mixed criteria independently and is deterministic", () => {
		const criteria = [{ id: "pass" }, { id: "fail" }, { id: "unproven" }];
		const lanes: readonly AdjudicationLane[] = [
			{
				laneId: "parent",
				verification: [
					{ criterionId: "pass", passed: true, parentExecuted: true },
					{ criterionId: "fail", passed: false, parentExecuted: true },
				],
			},
		];

		const first = adjudicateCriteria(criteria, lanes);
		expect(first.map(judgment => judgment.status)).toEqual(["pass", "fail", "unproven"]);
		expect(adjudicateCriteria(criteria, lanes)).toEqual(first);
	});

	test("leaves every criterion unproven when no lanes report evidence", () => {
		const judgments = adjudicateCriteria([{ id: "one" }, { id: "two" }], []);

		expect(judgments.map(judgment => judgment.status)).toEqual(["unproven", "unproven"]);
	});
});
