export async function afterPendingOperationsSettle<T>(
	operations: Promise<unknown>[],
	callback: () => Promise<T>,
): Promise<T> {
	await Promise.allSettled(operations);
	return callback();
}

/**
 * Wait for a pending-operation set to settle and stay unchanged long enough to
 * take a consistent snapshot. If a new operation starts while we're waiting or
 * while the snapshot callback is running, retry against the newer generation.
 */
export async function snapshotAfterPendingOperationsSettle<T>(
	getGeneration: () => number,
	getPendingOperations: () => Promise<unknown>[],
	takeSnapshot: () => Promise<T>,
): Promise<T> {
	for (;;) {
		const generation = getGeneration();
		await Promise.allSettled(getPendingOperations());
		if (getGeneration() !== generation) continue;
		const snapshot = await takeSnapshot();
		if (getGeneration() === generation) return snapshot;
	}
}
