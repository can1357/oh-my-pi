export type ModelEquivalence = "exact" | "family" | "capability" | "explicit";

export interface ModelRoute {
	logicalModel: string;
	provider: string;
	concreteModel: string;
	protocol: string;
	equivalence: ModelEquivalence;
}

/**
 * Split a model id on the first `/` only. Similar names are never rewritten
 * or treated as equivalent — there is no fuzzy, family, or alias matching here.
 */
export function parseModelRoute(id: string): { provider?: string; concreteModel: string } {
	const slash = id.indexOf("/");
	if (slash === -1) {
		return { concreteModel: id };
	}
	return { provider: id.slice(0, slash), concreteModel: id.slice(slash + 1) };
}
