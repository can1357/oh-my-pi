import type { AssignmentResult, Claim, CounterEvidence, EvidenceRef } from "../task/assignment-contract";

export type CriterionStatus = "pass" | "fail" | "unproven";
export type CriterionJudgmentStatus = CriterionStatus | "blocked";

export interface LaneCriterionCheck {
	readonly criterionId: string;
	readonly passed: boolean;
	readonly status?: CriterionStatus;
	readonly failureClass?: string;
	readonly parentExecuted?: boolean;
}

export interface AdjudicationLane {
	readonly laneId: string;
	readonly verification?: readonly LaneCriterionCheck[];
	readonly result?: AssignmentResult;
	readonly blocked?: boolean;
}

export interface CriterionJudgment {
	readonly criterionId: string;
	readonly status: CriterionJudgmentStatus;
	readonly acceptedClaimIds: readonly string[];
	readonly rejectedClaimIds: readonly string[];
	readonly evidenceRefs: readonly string[];
	readonly sourceLaneIds: readonly string[];
	readonly discriminatingQuestion?: string;
}

function appendUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function evidenceForClaim(claim: Claim, evidenceById: ReadonlyMap<string, EvidenceRef>): readonly EvidenceRef[] {
	const refs: EvidenceRef[] = [];
	for (const id of claim.evidenceRefs ?? []) {
		const evidence = evidenceById.get(id);
		if (evidence) refs.push(evidence);
	}
	return refs;
}

function hasIndependentReproduction(claims: readonly Claim[], evidenceById: ReadonlyMap<string, EvidenceRef>): boolean {
	return claims.some(claim =>
		evidenceForClaim(claim, evidenceById).some(evidence =>
			evidence.independentlyReproducedBy?.some(laneId => laneId !== evidence.producedBy),
		),
	);
}

function collectClaimEvidence(
	claims: readonly Claim[],
	evidenceById: ReadonlyMap<string, EvidenceRef>,
	evidenceIds: string[],
): void {
	for (const claim of claims) {
		for (const evidence of evidenceForClaim(claim, evidenceById)) appendUnique(evidenceIds, evidence.id);
		for (const evidenceId of claim.counterEvidenceRefs ?? []) appendUnique(evidenceIds, evidenceId);
	}
}

function collectCounterevidenceRefs(counterevidence: readonly CounterEvidence[], evidenceIds: string[]): void {
	for (const item of counterevidence) {
		for (const evidenceId of item.artifactRefs ?? []) appendUnique(evidenceIds, evidenceId);
	}
}

function laneReferencesCriterion(
	lane: AdjudicationLane,
	criterionId: string,
	claims: readonly Claim[],
	counterevidence: readonly CounterEvidence[],
): boolean {
	return Boolean(
		lane.verification?.some(check => check.criterionId === criterionId) ||
			lane.result?.evidence.some(evidence => evidence.criterionId === criterionId) ||
			claims.length > 0 ||
			counterevidence.length > 0,
	);
}

function adjudicateCriterion(criterionId: string, lanes: readonly AdjudicationLane[]): CriterionJudgment {
	const acceptedClaimIds: string[] = [];
	const rejectedClaimIds: string[] = [];
	const evidenceIds: string[] = [];
	const sourceLaneIds: string[] = [];
	const referencingLanes: AdjudicationLane[] = [];
	let independentPass = false;
	let parentFailure = false;
	let contradiction = false;
	let passOrFailEvidence = false;

	for (const lane of lanes) {
		const result = lane.result;
		const v2Result = result?.version === "assignment-result/v2" ? result : undefined;
		const claims = (v2Result?.claims ?? []).filter(claim => claim.satisfiesCriteria?.includes(criterionId));
		const counterevidence = (v2Result?.counterevidence ?? []).filter(item =>
			item.criterionIds?.includes(criterionId),
		);
		const contradictedClaims = claims.filter(claim => claim.verificationStatus === "contradicted");
		const acceptedClaims = claims.filter(claim => claim.verificationStatus !== "contradicted");
		const checks = lane.verification?.filter(check => check.criterionId === criterionId) ?? [];
		const childEvidence = result?.evidence.filter(evidence => evidence.criterionId === criterionId) ?? [];
		const evidenceById = new Map<string, EvidenceRef>();
		for (const evidence of v2Result?.evidenceRefs ?? []) evidenceById.set(evidence.id, evidence);

		if (laneReferencesCriterion(lane, criterionId, claims, counterevidence)) referencingLanes.push(lane);
		for (const claim of acceptedClaims) appendUnique(acceptedClaimIds, claim.id);
		for (const claim of contradictedClaims) appendUnique(rejectedClaimIds, claim.id);
		collectClaimEvidence(claims, evidenceById, evidenceIds);
		collectCounterevidenceRefs(counterevidence, evidenceIds);

		if (checks.length > 0 || childEvidence.length > 0 || claims.length > 0 || counterevidence.length > 0) {
			appendUnique(sourceLaneIds, lane.laneId);
		}
		if (counterevidence.length > 0 || contradictedClaims.length > 0) contradiction = true;

		if (childEvidence.length > 0) passOrFailEvidence = true;
		for (const check of checks) {
			const status = check.status ?? (check.passed ? "pass" : "fail");
			if (status !== "unproven") passOrFailEvidence = true;
			if (status === "pass" && check.parentExecuted) independentPass = true;
			if (status === "pass" && hasIndependentReproduction(acceptedClaims, evidenceById)) independentPass = true;
			if (status === "fail" && check.parentExecuted) parentFailure = true;
		}
	}

	if (parentFailure || (contradiction && !independentPass)) {
		return {
			criterionId,
			status: "fail",
			acceptedClaimIds,
			rejectedClaimIds,
			evidenceRefs: evidenceIds,
			sourceLaneIds,
		};
	}
	if (independentPass) {
		return {
			criterionId,
			status: "pass",
			acceptedClaimIds,
			rejectedClaimIds,
			evidenceRefs: evidenceIds,
			sourceLaneIds,
		};
	}
	if (
		referencingLanes.length > 0 &&
		referencingLanes.every(lane => lane.blocked) &&
		!passOrFailEvidence &&
		!contradiction
	) {
		return {
			criterionId,
			status: "blocked",
			acceptedClaimIds,
			rejectedClaimIds,
			evidenceRefs: evidenceIds,
			sourceLaneIds,
		};
	}
	return {
		criterionId,
		status: "unproven",
		acceptedClaimIds,
		rejectedClaimIds,
		evidenceRefs: evidenceIds,
		sourceLaneIds,
		discriminatingQuestion: `No independent evidence for criterion "${criterionId}"; provide a parent-run check or a reproduction from a second lane.`,
	};
}

export function adjudicateCriteria(
	criteria: readonly { readonly id: string }[],
	lanes: readonly AdjudicationLane[],
): readonly CriterionJudgment[] {
	return criteria.map(criterion => adjudicateCriterion(criterion.id, lanes));
}

export function judgmentsToCriteriaEvidence(judgments: readonly CriterionJudgment[]): Record<string, CriterionStatus> {
	const evidence: Record<string, CriterionStatus> = {};
	for (const judgment of judgments) {
		evidence[judgment.criterionId] = judgment.status === "blocked" ? "unproven" : judgment.status;
	}
	return evidence;
}
