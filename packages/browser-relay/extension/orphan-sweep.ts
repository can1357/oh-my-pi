export interface OrphanSweepState {
	nowMs: number;
	graceMs: number;
	disconnected: boolean;
	hasTrackedAttachments: boolean;
	existingDeadlineMs: number | null;
}

/**
 * Preserve the first orphan-sweep deadline while the relay stays disconnected.
 *
 * Repeated disconnect callbacks or worker restarts must not keep extending the
 * grace period: once the relay has been down long enough, the next normal
 * alarm/startup event should reclaim the surviving debugger attachment.
 */
export function nextOrphanSweepDeadline(
	state: OrphanSweepState,
): number | null {
	if (!state.disconnected || !state.hasTrackedAttachments) return null;
	if (state.existingDeadlineMs !== null) return state.existingDeadlineMs;
	return state.nowMs + state.graceMs;
}

export interface OrphanSweepExecutionState {
	nowMs: number;
	deadlineMs: number | null;
	disconnected: boolean;
	hasTrackedAttachments: boolean;
}

export function shouldRunOrphanSweep(
	state: OrphanSweepExecutionState,
): boolean {
	return (
		state.deadlineMs !== null &&
		state.disconnected &&
		state.hasTrackedAttachments &&
		state.nowMs >= state.deadlineMs
	);
}

export function orphanSweepAlarmDelayMinutes(
	deadlineMs: number,
	nowMs: number,
): number {
	return Math.max((deadlineMs - nowMs) / 60_000, 0.01);
}
