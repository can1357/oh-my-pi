import type { ActivityLedger } from "./ledger";

export interface RawClipRemover {
	remove(localPointer: string): Promise<void>;
}

export interface RawClipCleanupResult {
	readonly deletedEvidenceIds: readonly string[];
	readonly failures: ReadonlyArray<{ readonly evidenceId: string; readonly reason: string }>;
}

/** Delete expired local raw clips while retaining an auditable deletion timestamp. */
export async function purgeExpiredRawClips(
	ledger: ActivityLedger,
	remover: RawClipRemover,
	now: string,
): Promise<RawClipCleanupResult> {
	const deletedEvidenceIds: string[] = [];
	const failures: Array<{ evidenceId: string; reason: string }> = [];
	for (const evidence of ledger.listExpiredRawClips(now)) {
		const rawClip = evidence.rawClip;
		if (!rawClip) continue;
		try {
			await remover.remove(rawClip.localPointer);
			if (ledger.markRawClipDeleted(evidence.id, now)) deletedEvidenceIds.push(evidence.id);
		} catch (error) {
			failures.push({
				evidenceId: evidence.id,
				reason: error instanceof Error ? error.message : "raw clip removal failed",
			});
		}
	}
	return { deletedEvidenceIds, failures };
}
