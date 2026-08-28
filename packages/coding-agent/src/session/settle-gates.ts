/** Isolated apply succeeded; parent must re-run acceptance on this tree. */
export const MERGED_UNVERIFIED_MARKER =
	"MERGED — child yield is not evidence; re-run acceptance on this tree.";

export function annotateUnverifiedMergeSummary(mergeSummary: string, latch: boolean): string {
	if (!latch) return mergeSummary;
	if (mergeSummary.includes(MERGED_UNVERIFIED_MARKER)) return mergeSummary;
	const markerBlock = `\n${MERGED_UNVERIFIED_MARKER}`;
	return mergeSummary.length > 0 ? `${mergeSummary}${markerBlock}` : markerBlock;
}

export function isolatedApplyShouldLatch(args: {
	isolated: boolean;
	applyChanges: boolean;
	changesApplied: boolean | null;
	exitCode: number;
}): boolean {
	return args.isolated && args.applyChanges && args.changesApplied === true && args.exitCode === 0;
}

export class UnverifiedMergeLatch {
	readonly #ids = new Set<string>();

	mark(agentId: string): void {
		if (agentId.length > 0) this.#ids.add(agentId);
	}

	clear(): void {
		this.#ids.clear();
	}

	get size(): number {
		return this.#ids.size;
	}
}
