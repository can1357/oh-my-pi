export function noteAttachmentStateChange(epochs: Map<number, number>, tabId: number): void {
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

export function snapshotAttachmentState(epochs: Map<number, number>, tabIds: number[]): Map<number, number> {
	const snapshot = new Map<number, number>();
	for (const tabId of tabIds) snapshot.set(tabId, epochs.get(tabId) ?? 0);
	return snapshot;
}

export function filterFreshAttachmentState(
	epochs: Map<number, number>,
	snapshot: Map<number, number>,
	tabIds: number[],
): number[] {
	return tabIds.filter(tabId => (epochs.get(tabId) ?? 0) === (snapshot.get(tabId) ?? 0));
}
