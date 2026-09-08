export type AffinityLevel = "none" | "preferred" | "required";

export type StatePortabilityScope = "portable" | "provider" | "account" | "deployment";

export interface StatePortability {
	scope: StatePortabilityScope;
	origin?: string;
}

export interface AffinityCandidate {
	id: string;
	provider?: string;
	accountId?: string;
	deployment?: string;
}

/**
 * Hard-gate for affinity. `preferred` is ranking elsewhere and always passes.
 * Missing origin on a required non-portable scope rejects the candidate.
 */
export function candidateAllowed(
	portability: StatePortability | undefined,
	candidate: AffinityCandidate,
	level: AffinityLevel,
): boolean {
	if (portability === undefined || level === "none") {
		return true;
	}
	if (portability.scope === "portable") {
		return true;
	}
	if (level === "preferred") {
		return true;
	}
	const origin = portability.origin;
	if (origin === undefined) {
		return false;
	}
	switch (portability.scope) {
		case "provider":
			return candidate.provider === origin;
		case "account":
			return candidate.accountId === origin;
		case "deployment":
			return candidate.deployment === origin;
	}
}
