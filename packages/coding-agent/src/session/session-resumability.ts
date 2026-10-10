/** Dependency-light facts shared by live and synchronous recent-session selection. */
export interface SessionResumabilityFacts {
	readonly status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	readonly assistantTurns?: number;
	readonly title?: string;
	readonly firstMessage?: string;
}

export function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Canonical empty-session predicate used by both live resume and startup prepaint. */
export function isSessionResumabilityEmpty(facts: SessionResumabilityFacts): boolean {
	if (facts.status !== undefined && facts.status !== "pending" && facts.status !== "unknown") return false;
	if ((facts.assistantTurns ?? 1) > 0) return false;
	if (sanitizeSessionName(facts.title)) return false;
	if (sanitizeSessionName(facts.firstMessage === "(no messages)" ? undefined : facts.firstMessage)) return false;
	return true;
}
