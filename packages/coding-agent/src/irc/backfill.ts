import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import type { IrcHistoryRecord, IrcMessage } from "./types";

/**
 * Upper bound on reconstructed records. Legacy transcripts can carry tens of
 * thousands of hub sends; the Messages view only needs recent thread context.
 */
const MAX_BACKFILL_RECORDS = 2_000;

interface HubToolCallBlock {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: { op?: unknown; to?: unknown; message?: unknown };
}

function hubSends(entry: FileEntry): Array<{ callId: string; to: string; body: string }> {
	if (entry.type !== "message") return [];
	const message = (entry as SessionMessageEntry).message;
	if (message.role !== "assistant") return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const sends: Array<{ callId: string; to: string; body: string }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const call = block as HubToolCallBlock;
		if (call.type !== "toolCall" || call.name !== "hub") continue;
		const args = call.arguments;
		if (!args || args.op !== "send") continue;
		if (typeof args.to !== "string" || typeof args.message !== "string") continue;
		if (args.to.length === 0 || args.message.length === 0) continue;
		sends.push({ callId: call.id ?? "", to: args.to, body: args.message });
	}
	return sends;
}

/**
 * Reconstruct Agent Hub sends from a legacy session transcript.
 *
 * Durable IRC history journals (`.irc` sidecars) only exist for sessions
 * driven by builds with message persistence. Older transcripts record every
 * hub send as a `hub` tool call in the root session file. This streams that
 * file once and projects those calls into history records so the Messages
 * view shows pre-journal conversations. Delivery outcomes are unknowable
 * from tool calls alone, so records are marked `injected`.
 *
 * Only Main's outbound traffic is reconstructed: sibling traffic lives in
 * nested per-agent transcripts, which would multiply the scan cost.
 */
export async function backfillIrcHistoryFromTranscript(
	sessionFile: string | undefined | null,
): Promise<IrcHistoryRecord[]> {
	if (!sessionFile) return [];
	const records: IrcHistoryRecord[] = [];
	try {
		await visitEntriesFromFileStream(sessionFile, entry => {
			if (records.length >= MAX_BACKFILL_RECORDS) return false;
			for (const send of hubSends(entry)) {
				const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
				const message: IrcMessage = {
					id: `bf:${entry.id}:${send.callId}`,
					from: MAIN_AGENT_ID,
					to: send.to,
					body: send.body,
					ts: Number.isFinite(ts) ? ts : 0,
					broadcastId: send.to === "all" ? `bf-broadcast:${send.callId}` : undefined,
				};
				records.push({ message, outcome: "injected", updatedAt: Number.isFinite(ts) ? ts : 0 });
			}
		});
	} catch {
		return records;
	}
	// The visitor stops at the cap mid-file; keep the most recent sends.
	return records.slice(-MAX_BACKFILL_RECORDS);
}

/**
 * Drop backfilled records that duplicate a durable journal record for the
 * same send (sessions used across the old/new builds record sends both ways).
 * Match on endpoint pair + body; the journal's snowflake ids never collide
 * with `bf:` ids, so ids cannot be used for dedupe.
 */
export function dedupeBackfillRecords(
	backfilled: readonly IrcHistoryRecord[],
	journaled: readonly IrcHistoryRecord[],
): IrcHistoryRecord[] {
	const seen = new Set(journaled.map(record => `${record.message.to}\u0000${record.message.body}`));
	return backfilled.filter(record => !seen.has(`${record.message.to}\u0000${record.message.body}`));
}
