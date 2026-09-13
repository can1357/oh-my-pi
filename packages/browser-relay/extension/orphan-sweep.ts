export interface OrphanSweepState {
	nowMs: number;
	graceMs: number;
	disconnected: boolean;
	hasTrackedAttachments: boolean;
	existingDeadlineMs: number | null;
	recoveryStateLoading?: boolean;
	attachmentReconciliationPending?: boolean;
}

export interface OrphanSweepConnectionState {
	socketReadyState: number | null | undefined;
	openReadyState: number;
	forceDisconnected?: boolean;
}

export function orphanSweepSeesRelayDisconnected(
	state: OrphanSweepConnectionState,
): boolean {
	return (
		state.forceDisconnected === true ||
		state.socketReadyState !== state.openReadyState
	);
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
): number | null | undefined {
	// A fresh MV3 worker does not know whether the persisted recovery state owns
	// an orphan deadline until storage.session.get settles. Returning undefined
	// tells onSuspend to leave both the alarm and storage untouched; treating the
	// empty in-memory state as authoritative here would erase the only wake-up
	// capable of reclaiming a surviving debugger attachment.
	if (state.recoveryStateLoading === true) return undefined;
	// A startup getTargets failure leaves the in-memory guard empty even though
	// persisted ownership may still correspond to a live Chrome attachment. Do
	// not let a later onSuspend interpret that temporary absence as authoritative
	// and clear the only deadline capable of waking us for another reconciliation.
	if (
		state.disconnected &&
		state.attachmentReconciliationPending === true &&
		state.existingDeadlineMs !== null
	)
		return state.existingDeadlineMs;
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

export interface OrphanSweepRevalidationState {
	disconnected: boolean;
	hasTrackedAttachments: boolean;
	connectionReplaced: boolean;
}

export function shouldProceedWithOrphanSweep(
	state: OrphanSweepRevalidationState,
): boolean {
	return (
		state.disconnected &&
		state.hasTrackedAttachments &&
		!state.connectionReplaced
	);
}

export async function runAfterStartupReconciliation(
	reconcile: () => Promise<unknown>,
	runSweep: () => Promise<void>,
): Promise<void> {
	await reconcile();
	await runSweep();
}

export async function runExpiredOrphanSweep(
	clearDeadline: () => Promise<unknown>,
	revalidateAndSweep: () => Promise<void>,
): Promise<void> {
	// Once the deadline is due, persistence is cleanup rather than a gate. A
	// storage.session outage must not keep the debugger attachment alive and
	// restart the grace period forever.
	await clearDeadline().catch(() => {});
	await revalidateAndSweep();
}

export function orphanSweepAlarmDelayMinutes(
	deadlineMs: number,
	nowMs: number,
): number {
	return Math.max((deadlineMs - nowMs) / 60_000, 0.01);
}

export function restoreOrphanSweepDeadline(
	storedDeadline: unknown,
	isCurrent: boolean,
): number | null | undefined {
	if (!isCurrent) return undefined;
	return typeof storedDeadline === "number" && Number.isFinite(storedDeadline)
		? storedDeadline
		: null;
}

export function seedOrphanSweepDeadline(
	currentDeadlineMs: number | null,
	scheduledTime: number,
	generation: number,
	initializedRelayIntervened = false,
): { deadlineMs: number | null; generation: number } {
	if (currentDeadlineMs !== null) {
		return { deadlineMs: currentDeadlineMs, generation };
	}
	if (initializedRelayIntervened) {
		return { deadlineMs: null, generation };
	}
	return { deadlineMs: scheduledTime, generation: generation + 1 };
}

/**
 * Finish an alarm mutation before persisting its matching deadline. Deadline
 * updates are queued so an older clear cannot write `null` after a newer arm.
 */
export function serializeOrphanSweepDeadlineUpdate(
	previousUpdate: Promise<void>,
	alarmUpdate: Promise<unknown>,
	isCurrent: () => boolean,
	persist: () => Promise<unknown>,
	repairStaleAlarm: () => void,
): Promise<void> {
	return previousUpdate
		.catch(() => {})
		.then(async () => {
			await alarmUpdate.catch(() => {});
			if (!isCurrent()) {
				repairStaleAlarm();
				return;
			}
			await persist();
		});
}
