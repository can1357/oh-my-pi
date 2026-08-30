export function noteAttachmentStateChange(epochs: Map<number, number>, tabId: number): void {
	epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
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
