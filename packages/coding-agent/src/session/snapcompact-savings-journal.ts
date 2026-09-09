/**
 * Append-only journal of snapcompact tool-result savings.
 *
 * Snapcompact frames are transient — built per provider request in
 * `transformProviderContext` and never written to session.jsonl — so the tokens
 * they keep off the wire would otherwise leave no trace. This records one line
 * the FIRST time a tool result is imaged in a session:
 *
 *   {"ts":<epochMs>,"session":<sessionFile>,"provider":..,"model":..,"toolCallId":..,"savedTokens":..}
 *
 * Newline-delimited JSON, opened with O_APPEND so concurrent appenders (parallel
 * agents/subagents) never interleave a partial line. Writes are fire-and-forget;
 * a failure is logged at debug and never propagates into the request hot path.
 *
 * Readers MUST dedup by (session, toolCallId): a session resumed in a fresh
 * process re-images the same results and may append a second line. The savings
 * for a given (session, toolCallId) are stable, so any-per-key is correct.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getStatsDbPath, isEnoent, logger } from "@oh-my-pi/pi-utils";

export interface SnapcompactSavingsRecord {
	/** Epoch milliseconds when the swap was applied. */
	ts: number;
	/** Session file path (matches the stats `messages.session_file` key). */
	session: string;
	provider: string;
	model: string;
	toolCallId: string;
	savedTokens: number;
}

/** `~/.omp/.../snapcompact-savings.jsonl`, colocated with stats.db. */
export function snapcompactSavingsJournalPath(): string {
	return path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl");
}

/**
 * Appends savings to the journal, deduped by toolCallId for the recorder's
 * lifetime (one per session). Returns the in-flight append so callers/tests can
 * await durability; the production transform leaves it floating (fire-and-forget,
 * and it never rejects — I/O errors are swallowed to debug). `getSession` is read
 * at write time so a session file assigned late is still captured; a null session
 * (in-memory / SDK embedding) or non-positive savings skip the write.
 */
export type SnapcompactSavingsRecorder = (
	savings: ReadonlyArray<{ toolCallId: string; savedTokens: number }>,
	model: Model,
) => Promise<void>;

export function createSnapcompactSavingsRecorder(
	getSession: () => string | null,
	journalPath: string = snapcompactSavingsJournalPath(),
): SnapcompactSavingsRecorder {
	const seen = new Set<string>();
	let dirEnsured = false;
	return async (savings, model) => {
		const session = getSession();
		if (!session) return;
		const ts = Date.now();
		const lines: string[] = [];
		for (const { toolCallId, savedTokens } of savings) {
			if (savedTokens <= 0 || seen.has(toolCallId)) continue;
			seen.add(toolCallId);
			lines.push(
				JSON.stringify({
					ts,
					session,
					provider: model.provider,
					model: model.id,
					toolCallId,
					savedTokens,
				} satisfies SnapcompactSavingsRecord),
			);
		}
		if (lines.length === 0) return;
		try {
			if (!dirEnsured) {
				await fs.mkdir(path.dirname(journalPath), { recursive: true });
				dirEnsured = true;
			}
			await fs.appendFile(journalPath, `${lines.join("\n")}\n`);
		} catch (err) {
			logger.debug("snapcompact savings journal append failed", { err: String(err) });
		}
	};
}

/** Read all journal records. Malformed lines are skipped; a missing file is empty. */
export async function readSnapcompactSavingsJournal(
	journalPath: string = snapcompactSavingsJournalPath(),
): Promise<SnapcompactSavingsRecord[]> {
	let text: string;
	try {
		text = await Bun.file(journalPath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const records: SnapcompactSavingsRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as SnapcompactSavingsRecord);
		} catch {
			/* skip malformed line */
		}
	}
	return records;
}
