/** Candidate ranking for auth-gateway route selection. Lower rank is better. */
export type CandidateDisposition = "preferred" | "eligible" | "deprioritized" | "last_resort" | "blocked";

const DISPOSITION_RANK: Record<CandidateDisposition, number> = {
	preferred: 0,
	eligible: 1,
	deprioritized: 2,
	last_resort: 3,
	blocked: 4,
};

/** Negative when `a` is better than `b`. Lower rank number is better. */
export function compareDisposition(a: CandidateDisposition, b: CandidateDisposition): number {
	return DISPOSITION_RANK[a] - DISPOSITION_RANK[b];
}

/** False only for `blocked`. */
export function isSelectable(d: CandidateDisposition): boolean {
	return d !== "blocked";
}
