export interface BtwHistoryTurn {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwHistoryRecord extends BtwHistoryTurn {
	id: string;
	leafId: string | null;
	followUps?: readonly BtwHistoryTurn[];
}

export function getBtwLatestTurn(record: BtwHistoryRecord): BtwHistoryTurn {
	return record.followUps?.at(-1) ?? record;
}

export function getBtwTurns(record: BtwHistoryRecord): readonly BtwHistoryTurn[] {
	return [record, ...(record.followUps ?? [])];
}

/** Copy the most recent nonblank answer, preserving its original whitespace. */
export function getBtwCopyText(record: BtwHistoryRecord): string | undefined {
	if (record.followUps) {
		for (let index = record.followUps.length - 1; index >= 0; index--) {
			const answer = record.followUps[index]!.answer;
			if (answer.trim()) return answer;
		}
	}
	return record.answer.trim() ? record.answer : undefined;
}
