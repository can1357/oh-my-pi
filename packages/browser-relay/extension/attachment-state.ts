export function noteAttachmentStateChange(
	epochs: Map<number, number>,
	tabId: number,
): void {
	epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
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
		(tabId) => (epochs.get(tabId) ?? 0) === (snapshot.get(tabId) ?? 0),
	);
}
