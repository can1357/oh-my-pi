import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface BtwHistoryTurn {
	question: string;
	/** Images attached to the question, sent again with it on later follow-ups. */
	images?: readonly ImageContent[];
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwHistoryRecord extends BtwHistoryTurn {
	id: string;
	leafId: string | null;
	/** Display heading for the topic, e.g. `/sitrep`; `question` keeps the full text sent to the model. */
	title?: string;
	followUps?: readonly BtwHistoryTurn[];
}

/** The topic's display heading: its title, else the opening question. */
export function getBtwTopicLabel(record: BtwHistoryRecord): string {
	return record.title ?? record.question;
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
