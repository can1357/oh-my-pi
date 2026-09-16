export function noteAttachmentStateChange(
	epochs: Map<number, number>,
	tabId: number,
): void {
	epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
}

export function hasUsableRelaySocket(
	socket: { readyState: number } | null,
	openReadyState: number,
	connectingReadyState: number,
): boolean {
	return (
		socket !== null &&
		(socket.readyState === openReadyState || socket.readyState === connectingReadyState)
	);
}

export function noteDebuggerDetach(
	attachmentEpochs: Map<number, number>,
	loaderGenerations: Map<number, number>,
	tabId: number,
): void {
	noteAttachmentStateChange(attachmentEpochs, tabId);
	// A pending loader probe belongs to the detached debugger root. Invalidate
	// it immediately so its late result cannot restore a stale recovery baseline.
	noteAttachmentStateChange(loaderGenerations, tabId);
}

export function captureRecoveryLoaderNavigation(
	loaderIds: Map<number, string>,
	loaderGenerations: Map<number, number>,
	tabId: number,
	method: string,
	params: unknown,
	frameLoaderIds?: Map<number, Record<string, string>>,
	isRootSession = true,
): boolean {
	if (method !== "Page.frameNavigated" || !params || typeof params !== "object")
		return false;
	const frame = (params as { frame?: unknown }).frame;
	if (!frame || typeof frame !== "object") return false;
	const { id, loaderId, parentId } = frame as {
		id?: unknown;
		loaderId?: unknown;
		parentId?: unknown;
	};
	if (typeof loaderId !== "string") return false;
	if (parentId !== undefined && !frameLoaderIds) return false;
	noteAttachmentStateChange(loaderGenerations, tabId);
	if (isRootSession && parentId === undefined) loaderIds.set(tabId, loaderId);
	if (typeof id === "string" && frameLoaderIds) {
		frameLoaderIds.set(tabId, { ...frameLoaderIds.get(tabId), [id]: loaderId });
	}
	return true;
}

export interface RecoveryLoaderState {
	mainLoaderId?: string;
	frameLoaderIds: Record<string, string>;
}

export function recoveryLoaderState(frameTree: unknown): RecoveryLoaderState {
	const frameLoaderIds: Record<string, string> = {};
	let mainLoaderId: string | undefined;
	const visit = (node: unknown, main: boolean): void => {
		if (!node || typeof node !== "object") return;
		const { frame, childFrames } = node as {
			frame?: { id?: unknown; loaderId?: unknown };
			childFrames?: unknown;
		};
		if (frame && typeof frame === "object") {
			if (main && typeof frame.loaderId === "string") mainLoaderId = frame.loaderId;
			if (typeof frame.id === "string" && typeof frame.loaderId === "string")
				frameLoaderIds[frame.id] = frame.loaderId;
		}
		if (Array.isArray(childFrames)) for (const child of childFrames) visit(child, false);
	};
	visit(frameTree, true);
	return { mainLoaderId, frameLoaderIds };
}

export async function detachWithRecoveryLoaderObservation(
	loaderIds: Map<number, string>,
	loaderGenerations: Map<number, number>,
	tabId: number,
	enablePage: () => Promise<unknown>,
	readLoaderState: () => Promise<string | RecoveryLoaderState | undefined>,
	detach: () => Promise<void>,
	onObservationStarted: () => Promise<void>,
	onObservedDetachSuccess: () => Promise<void>,
	frameLoaderIds?: Map<number, Record<string, string>>,
): Promise<void> {
	const loaderGeneration = loaderGenerations.get(tabId) ?? 0;
	const mainLoaderIdBeforeObservation = loaderIds.get(tabId);
	const frameLoaderIdsBeforeObservation = frameLoaderIds
		? { ...frameLoaderIds.get(tabId) }
		: undefined;
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
	if (observingPage) {
		try {
			await onObservationStarted();
		} catch {}
	}
	const loaderState = await readLoaderState().catch(() => undefined);
	const mainLoaderId = typeof loaderState === "string" ? loaderState : loaderState?.mainLoaderId;
	const loaderStateChanged = loaderGeneration !== loaderGenerations.get(tabId);
	if (typeof mainLoaderId === "string") {
		const observedMainLoaderId = loaderIds.get(tabId);
		if (!loaderStateChanged || observedMainLoaderId === mainLoaderIdBeforeObservation)
			loaderIds.set(tabId, mainLoaderId);
	}
	if (typeof loaderState === "object" && frameLoaderIds) {
		if (!loaderStateChanged) {
			frameLoaderIds.set(tabId, loaderState.frameLoaderIds);
		} else {
			const observedFrameLoaderIds = frameLoaderIds.get(tabId) ?? {};
			const navigationDeltas = Object.fromEntries(
				Object.entries(observedFrameLoaderIds).filter(
					([frameId, loaderId]) => frameLoaderIdsBeforeObservation?.[frameId] !== loaderId,
				),
			);
			frameLoaderIds.set(tabId, { ...loaderState.frameLoaderIds, ...navigationDeltas });
		}
	}
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

export function consumeGuardInitiatedDetach(
	guardMarkedTabs: Set<number>,
	relayMarkedTabs: Set<number>,
	tabId: number,
	reason: string,
): boolean {
	const guardMarked = guardMarkedTabs.delete(tabId);
	const userDetach =
		reason === "canceled_by_user" || reason === "replaced_with_devtools";
	if (!guardMarked || userDetach) return false;
	// A relay detach can settle while a guard retry for the same tab is pending.
	// The guard owns this event, but the overlapping relay marker is spent too.
	relayMarkedTabs.delete(tabId);
	return true;
}

export function noteRelayDetachOutcome(
	completedTabs: Set<number>,
	tabId: number,
	relayInitiated: boolean,
): void {
	if (relayInitiated) completedTabs.add(tabId);
	else completedTabs.delete(tabId);
}

export async function detachThenBestEffortCleanup(
	detach: () => Promise<void>,
	cleanup: () => Promise<void>,
): Promise<void> {
	await detach();
	await cleanup().catch(() => {});
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
