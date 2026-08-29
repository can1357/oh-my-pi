/** Isolated apply succeeded; parent must re-run acceptance on this tree. */
export const MERGED_UNVERIFIED_MARKER = "MERGED — child yield is not evidence; re-run acceptance on this tree.";

export function annotateUnverifiedMergeSummary(mergeSummary: string, latch: boolean): string {
	if (!latch) return mergeSummary;
	if (mergeSummary.includes(MERGED_UNVERIFIED_MARKER)) return mergeSummary;
	const markerBlock = `\n${MERGED_UNVERIFIED_MARKER}`;
	return mergeSummary.length > 0 ? `${mergeSummary}${markerBlock}` : markerBlock;
}

export function isolatedApplyShouldLatch(args: {
	isolated: boolean;
	applyChanges: boolean;
	hadAnyChanges: boolean;
	exitCode: number;
}): boolean {
	// Key on `hadAnyChanges`, not `changesApplied`: a no-op merge ("No changes
	// to apply.") leaves the repo clean but applied nothing, so there is no
	// unverified child work for the parent to re-accept.
	return args.isolated && args.applyChanges && args.hadAnyChanges === true && args.exitCode === 0;
}

/** A single pending unverified merge — the parent re-runs acceptance once. */
export class UnverifiedMergeLatch {
	#latched = false;

	mark(): void {
		this.#latched = true;
	}

	clear(): void {
		this.#latched = false;
	}

	get latched(): boolean {
		return this.#latched;
	}
}
