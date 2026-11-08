import type { ImageContent } from "@oh-my-pi/pi-ai";
import { sanitizeDisplayText } from "./extensions/display-text";

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

/** Identifies one turn of a topic, its latest by default: a follow-up gets a new key, so per-answer marks reset. */
export function getBtwTurnKey(record: BtwHistoryRecord, turnIndex = record.followUps?.length ?? 0): string {
	return `${record.id}:${turnIndex}`;
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

const INJECT_OPEN = "<inject>";
const INJECT_CLOSE = "</inject>";

/** An answer around its `<inject>` block: the steering prompt a side answer drafted for the main session. */
export interface BtwInjectParts {
	before: string;
	inject: string;
	after: string;
	/** False while no opener has a close: the block may still be streaming, so it runs to the end. */
	closed: boolean;
}

/**
 * Split an answer at its last closed `<inject>` block: the last opener that has a close
 * after it, paired with the first close after it. A tag merely mentioned in prose,
 * before or after the block, cannot capture it. Without a closed block, the last opener
 * runs to the end (`closed: false`); display it only while the answer still streams.
 * Linear: the last opener before the last close is the last one with any close after it.
 */
export function splitBtwInject(answer: string): BtwInjectParts | undefined {
	const lastClose = answer.lastIndexOf(INJECT_CLOSE);
	const open = lastClose === -1 ? -1 : answer.lastIndexOf(INJECT_OPEN, lastClose - INJECT_OPEN.length);
	if (open !== -1) {
		const close = answer.indexOf(INJECT_CLOSE, open + INJECT_OPEN.length);
		return {
			before: answer.slice(0, open),
			inject: answer.slice(open + INJECT_OPEN.length, close),
			after: answer.slice(close + INJECT_CLOSE.length),
			closed: true,
		};
	}
	const streaming = answer.lastIndexOf(INJECT_OPEN);
	if (streaming === -1) return undefined;
	return {
		before: answer.slice(0, streaming),
		inject: answer.slice(streaming + INJECT_OPEN.length),
		after: "",
		closed: false,
	};
}

/** A block's text as shown and as sent: control sequences stripped, tabs expanded, trimmed. */
export function formatBtwInjectText(inject: string): string {
	return sanitizeDisplayText(inject).trim();
}

/** The steering prompt to send, exactly as the block shows it; undefined while unclosed or blank. */
export function getBtwInject(answer: string): string | undefined {
	const parts = splitBtwInject(answer);
	const text = parts?.closed ? formatBtwInjectText(parts.inject) : "";
	return text || undefined;
}

/** A topic's steering prompt: only its latest turn's, once that turn completed. */
export function getBtwRecordInject(record: BtwHistoryRecord): string | undefined {
	const latest = getBtwLatestTurn(record);
	return latest.status === "complete" ? getBtwInject(latest.answer) : undefined;
}
