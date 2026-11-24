/** The active Codex account fields retained between status refreshes. */
export interface CodexResetUsageSnapshot {
	/** When this usage report was observed, if supplied by the provider. */
	observedAt?: number;
	/** Weekly usage, its quota identity, and its previously scheduled reset deadline. */
	sevenDay?: { percent: number; resetsAt?: number; tier?: string; plan?: string };
	savedResets?: number;
}

/** A detected Codex quota event that can trigger the fireworks presentation. */
export type CodexResetFireworksEvent =
	| { kind: "unscheduled-weekly-reset" }
	| { kind: "saved-reset-banked"; added: number; available: number };

/**
 * Compare consecutive reports for one Codex account. A saved-reset grant takes
 * precedence when both changes arrive in the same report. A verified decrease,
 * or a prior positive balance becoming unavailable, suppresses the weekly event
 * because the user may have redeemed a credit. Other weekly usage drops are
 * celebrated only when the provider advances the quota deadline before the
 * previously scheduled reset.
 */
export function detectCodexResetFireworks(
	previous: CodexResetUsageSnapshot,
	current: CodexResetUsageSnapshot,
): CodexResetFireworksEvent | undefined {
	const previousSavedResets = previous.savedResets;
	const currentSavedResets = current.savedResets;
	if (previousSavedResets !== undefined) {
		if (currentSavedResets === undefined) {
			if (previousSavedResets > 0) return undefined;
		} else {
			if (currentSavedResets > previousSavedResets) {
				return {
					kind: "saved-reset-banked",
					added: currentSavedResets - previousSavedResets,
					available: currentSavedResets,
				};
			}
			if (currentSavedResets < previousSavedResets) return undefined;
		}
	}

	if (!previous.sevenDay || !current.sevenDay) return undefined;
	if (previous.sevenDay.tier !== current.sevenDay.tier || previous.sevenDay.plan !== current.sevenDay.plan) {
		return undefined;
	}
	const previousWeeklyPercent = Math.round(Math.max(0, Math.min(100, previous.sevenDay.percent)));
	const currentWeeklyPercent = Math.round(Math.max(0, Math.min(100, current.sevenDay.percent)));
	if (previousWeeklyPercent === 0 || currentWeeklyPercent >= previousWeeklyPercent) return undefined;

	const scheduledResetAt = previous.sevenDay.resetsAt;
	const nextResetAt = current.sevenDay.resetsAt;
	if (
		scheduledResetAt === undefined ||
		!Number.isFinite(scheduledResetAt) ||
		nextResetAt === undefined ||
		!Number.isFinite(nextResetAt) ||
		nextResetAt <= scheduledResetAt ||
		typeof current.observedAt !== "number" ||
		!Number.isFinite(current.observedAt) ||
		current.observedAt >= scheduledResetAt
	) {
		return undefined;
	}
	return { kind: "unscheduled-weekly-reset" };
}
