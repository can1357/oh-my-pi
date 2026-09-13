export interface HelloRefreshTabChange {
	url?: string;
	groupId?: number;
}

export function applyHelloTabChanges<T extends { tabId: number }>(
	tabs: readonly T[],
	changes: ReadonlyMap<number, T | null>,
): T[] {
	const current = new Map(tabs.map(tab => [tab.tabId, tab]));
	for (const [tabId, tab] of changes) {
		if (tab === null) current.delete(tabId);
		else current.set(tabId, tab);
	}
	return [...current.values()];
}

/**
 * URL and group changes affect relay reconciliation, so an in-flight hello
 * carrying their previous values must be suppressed rather than merely
 * followed by a metadata refresh.
 */
export function invalidatesHelloReconciliation(changeInfo: HelloRefreshTabChange): boolean {
	return changeInfo.groupId !== undefined || changeInfo.url !== undefined;
}

export function shouldSuppressHelloSnapshot(
	structuralDirty: boolean,
	reconciliationDirty: boolean,
	allowStaleReconciliation: boolean,
): boolean {
	return structuralDirty || (reconciliationDirty && !allowStaleReconciliation);
}
