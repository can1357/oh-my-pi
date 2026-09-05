export function noteAttachmentStateChange(
	epochs: Map<number, number>,
	tabId: number,
): void {
	epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
}

export function captureRecoveryLoaderNavigation(
	loaderIds: Map<number, string>,
	loaderGenerations: Map<number, number>,
	tabId: number,
	method: string,
	params: unknown,
): boolean {
	if (method !== "Page.frameNavigated" || !params || typeof params !== "object")
		return false;
	const frame = (params as { frame?: unknown }).frame;
	if (!frame || typeof frame !== "object") return false;
	const { loaderId, parentId } = frame as {
		loaderId?: unknown;
		parentId?: unknown;
	};
	if (parentId !== undefined || typeof loaderId !== "string") return false;
	noteAttachmentStateChange(loaderGenerations, tabId);
	loaderIds.set(tabId, loaderId);
	return true;
}

export async function detachWithRecoveryLoaderObservation(
	loaderIds: Map<number, string>,
	loaderGenerations: Map<number, number>,
	tabId: number,
	enablePage: () => Promise<unknown>,
	readMainFrameLoaderId: () => Promise<string | undefined>,
	detach: () => Promise<void>,
	onObservationStarted: () => Promise<void>,
	onObservedDetachSuccess: () => Promise<void>,
): Promise<void> {
	const loaderGeneration = loaderGenerations.get(tabId) ?? 0;
	// Page events may have been disabled after recovery. Observe them for the
	// entire snapshot-to-detach window so a committed navigation can supersede
	// the snapshot before debugger ownership ends. Observation is best-effort:
	// failure to enable Page must not strand the orphaned attachment.
	let observingPage = false;
	try {
		await enablePage();
		observingPage = true;
	} catch {}
	// Page.enable mutates the surviving debugger root. Persist that fact before
	// any later await so an MV3 worker termination cannot expose the root as
	// reusable while the loader snapshot or detach is still pending.
	if (observingPage) await onObservationStarted();
	const loaderId = await readMainFrameLoaderId().catch(() => undefined);
	if (
		loaderGeneration === loaderGenerations.get(tabId) &&
		typeof loaderId === "string"
	)
		loaderIds.set(tabId, loaderId);
	await detach();
	if (observingPage) await onObservedDetachSuccess();
}

export function isAttachmentStateCurrent(
	epochs: ReadonlyMap<number, number>,
	tabId: number,
	epoch: number,
): boolean {
	return (epochs.get(tabId) ?? 0) === epoch;
}

export function consumeRelayInitiatedDetach(
	markedTabs: Set<number>,
	tabId: number,
	reason: string,
): boolean {
	const relayMarked = markedTabs.delete(tabId);
	const userDetach =
		reason === "canceled_by_user" || reason === "replaced_with_devtools";
	return relayMarked && !userDetach;
}

export function shouldRetrackAfterDetachFailure(
	targets: ReadonlyArray<{ tabId?: number; attached: boolean }> | null,
	tabId: number,
): boolean {
	return (
		targets === null ||
		targets.some((target) => target.tabId === tabId && target.attached)
	);
}

export function serializeRecoverableStateUpdate(
	previousUpdate: Promise<unknown>,
	immediateWrite: Promise<unknown>,
	isCurrent: () => boolean,
	persistCurrent: () => Promise<unknown>,
): Promise<void> {
	return Promise.allSettled([previousUpdate, immediateWrite]).then(async () => {
		if (!isCurrent()) return;
		await persistCurrent();
	});
}

export function retryFailedStateUpdate<T>(
	failedUpdate: Promise<T>,
	currentUpdate: Promise<T>,
	createRetry: () => Promise<T>,
): Promise<T> | null {
	return failedUpdate === currentUpdate ? createRetry() : null;
}

export function restoreRecoverableState(
	target: Set<number>,
	storedIds: unknown,
	mutatedTabIds: ReadonlySet<number>,
): void {
	if (!Array.isArray(storedIds)) return;
	for (const id of storedIds) {
		if (typeof id === "number" && !mutatedTabIds.has(id)) target.add(id);
	}
}

export function extensionOwnedAttachedTabIds(
	targets: ReadonlyArray<{ tabId?: number; attached: boolean }>,
	recoverableTabIds: ReadonlySet<number>,
): number[] {
	return targets
		.filter(
			(target) =>
				target.attached &&
				target.tabId !== undefined &&
				recoverableTabIds.has(target.tabId),
		)
		.map((target) => target.tabId as number);
}

export function requireRecoveryStateLoaded(loaded: boolean): void {
	if (!loaded) throw new Error("browser relay recovery state failed to load");
}

/** Share one load attempt, cache success, and allow a rejected attempt to retry. */
export function createRetryableLoader<T>(
	load: () => Promise<T>,
): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		if (pending) return pending;
		const attempt = load().catch((error: unknown) => {
			if (pending === attempt) pending = null;
			throw error;
		});
		pending = attempt;
		return attempt;
	};
}

export function snapshotAttachmentState(
	epochs: Map<number, number>,
	tabIds: number[],
): Map<number, number> {
	const snapshot = new Map<number, number>();
	for (const tabId of tabIds) snapshot.set(tabId, epochs.get(tabId) ?? 0);
	return snapshot;
}

export function filterFreshAttachmentState(
	epochs: Map<number, number>,
	snapshot: Map<number, number>,
	tabIds: number[],
): number[] {
	return tabIds.filter(
		(tabId) =>
			isAttachmentStateCurrent(epochs, tabId, snapshot.get(tabId) ?? 0),
	);
}
