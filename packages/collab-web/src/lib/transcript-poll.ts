/**
 * Polling decision for the AgentDrawer's incremental transcript reads.
 *
 * Mirrors the TUI guest's contract (agent-transcript-viewer): a `null` reply
 * (timeout / session end) is transient and retryable from the same cursor; a
 * frame-level host `error` is terminal — the host replies with an unchanged
 * cursor, so retrying would loop hot without ever surfacing the failure.
 *
 * Each reply is one window of the transcript (at most a few MiB of whole
 * lines). Its `entry_patch` records apply through the drawer's
 * {@link EntryPatchReplay}, which holds every entry read so far: a record set
 * on a target from an earlier reply comes back in `changed`, so the drawer
 * shows that entry again, and a record read before its target applies when
 * the target arrives. A record is never a row.
 */

import type { EntryPatchReplay } from "@oh-my-pi/pi-utils/entry-patches";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TranscriptResult } from "./client";
import { isShownEntry, type TranscriptLine } from "./entry-patch-rows";
import { parseJsonl } from "./jsonl";

/** What one transcript poll round decided (the drawer's effect executes it). */
export type TranscriptPollDecision =
	/** Transient failure (timeout / not yet available): keep the cursor, poll again. */
	| { action: "retry" }
	/** Terminal host error: stop polling and surface the message (prior rows stay). */
	| { action: "stop"; message: string }
	/**
	 * Rows read: advance the cursor, append the parsed entries, and show again
	 * the entries of earlier replies that this reply's records changed.
	 */
	| {
			action: "advance";
			newSize: number;
			carry: string;
			fresh: readonly SessionEntry[];
			changed: readonly TranscriptLine[];
	  };

/**
 * Maps one {@link TranscriptResult} reply to a polling decision. Rows read go
 * through `patches`, the drawer's replay of this transcript's records.
 */
export function decideTranscriptPoll(
	reply: TranscriptResult | null,
	carry: string,
	patches: EntryPatchReplay<TranscriptLine>,
): TranscriptPollDecision {
	if (reply === null) return { action: "retry" };
	if (reply.kind === "error") return { action: "stop", message: reply.message };
	const parsed = parseJsonl(reply.text, carry);
	const lines: TranscriptLine[] = [];
	for (const item of parsed.items) {
		if (typeof item !== "object" || item === null) continue;
		if ("type" in item && item.type === "session") continue;
		lines.push(item as TranscriptLine);
	}
	const changed = patches.add(lines);
	return {
		action: "advance",
		newSize: reply.newSize,
		carry: parsed.carry,
		fresh: lines.filter(isShownEntry),
		changed,
	};
}
