export const ADVISOR_DEFAULT_MAX_TOOL_CALLS_PER_REVIEW = 1;

export interface AdvisorToolCallBudgetDecision {
	allowed: boolean;
	nextUsed: number;
	reason?: string;
}

export function normalizeAdvisorToolCallBudget(
	value: number,
	fallback = ADVISOR_DEFAULT_MAX_TOOL_CALLS_PER_REVIEW,
): number {
	const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? Math.trunc(fallback) : 0;
	if (!Number.isFinite(value) || value < 0) return safeFallback;
	return Math.trunc(value);
}

export function consumeAdvisorToolCall(
	toolName: string,
	used: number,
	maxCalls: number,
): AdvisorToolCallBudgetDecision {
	const normalizedUsed = Number.isFinite(used) && used >= 0 ? Math.trunc(used) : 0;
	const normalizedMax = normalizeAdvisorToolCallBudget(maxCalls);
	if (toolName === "advise" || toolName === "check_in") {
		return { allowed: true, nextUsed: normalizedUsed };
	}
	if (normalizedUsed >= normalizedMax) {
		return {
			allowed: false,
			nextUsed: normalizedUsed,
			reason: `Advisor verification budget exhausted (${normalizedMax} investigative call${normalizedMax === 1 ? "" : "s"} per review). Use advise or check_in now.`,
		};
	}
	return { allowed: true, nextUsed: normalizedUsed + 1 };
}
