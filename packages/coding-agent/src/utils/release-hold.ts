/**
 * A resource one party holds on another's behalf — the retained eval kernel a
 * child's `tools=[…]` run on, an isolation workspace — carried as the call
 * that discharges it.
 *
 * The hold *is* the ownership record, rather than the subject's name in some
 * table: whoever can still observe the child takes it over with
 * {@link ReleaseHold.claim}, and the boundary that created it asks
 * {@link ReleaseHold.isOwed} on its way out. Reading ownership off the object
 * is what a lookup cannot do — a second operation's bookkeeping cannot clear
 * the first's debt, a manager torn down and replaced mid-release cannot lose
 * it, and the answer never depends on which instance happens to be global.
 *
 * A hold is callable, so every existing `onRelease` consumer discharges it by
 * calling it and needs to know nothing about this.
 */
export interface ReleaseHold {
	/** Discharge the hold. The underlying release runs at most once; later callers await that same run. */
	(): Promise<void>;
	/** Record that something which will certainly end has taken the hold over, and must discharge it. */
	claim(): void;
	/** True while nobody has taken the hold over and nothing has discharged it. */
	isOwed(): boolean;
}

/**
 * Wrap `release` as a hold. `onClaim` runs when this hold is claimed, which is
 * how a derived hold tells the hold it was built from that the same party now
 * owns both — an isolation run hands the agent lifecycle one call that cleans
 * the workspace *and* releases what its caller held.
 */
export function createReleaseHold(release: () => void | Promise<void>, onClaim?: () => void): ReleaseHold {
	let discharge: Promise<void> | undefined;
	let claimed = false;
	const hold = ((): Promise<void> => {
		if (discharge) return discharge;
		// Published before `release` runs, not after it resolves: a release that
		// calls the hold again on its own synchronous path — a kernel shutdown
		// whose teardown hook reaches the same borrow — would otherwise find no
		// discharge in progress and start a second one.
		const settled = Promise.withResolvers<void>();
		discharge = settled.promise;
		void (async () => {
			try {
				await release();
				settled.resolve();
			} catch (error) {
				settled.reject(error);
			}
		})();
		return discharge;
	}) as ReleaseHold;
	hold.claim = (): void => {
		if (claimed) return;
		claimed = true;
		onClaim?.();
	};
	hold.isOwed = (): boolean => !claimed && discharge === undefined;
	return hold;
}

/** The hold behind an `onRelease`, or undefined for a plain callback that carries no ownership. */
export function asReleaseHold(release: (() => void | Promise<void>) | undefined): ReleaseHold | undefined {
	if (typeof release !== "function") return undefined;
	const candidate = release as Partial<ReleaseHold>;
	return typeof candidate.claim === "function" && typeof candidate.isOwed === "function"
		? (release as ReleaseHold)
		: undefined;
}
