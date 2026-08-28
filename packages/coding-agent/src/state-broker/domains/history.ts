/**
 * `history` replicated domain — adapts the local prompt-history table
 * ({@link HistoryStorage}) to the broker's replication contract.
 *
 * Merge key is the prompt text (the table's UNIQUE column). The logical clock
 * (`rev`) is the prompt's `created_at`, but the table stores that in epoch
 * SECONDS while the wire's `rev` is epoch MILLIS. We convert at this boundary in
 * BOTH directions (`rev = created_at * 1000` on read; `value.createdAt` carries
 * the seconds back through to {@link HistoryStorage.mergeRemote} on write).
 * Getting the unit wrong here would make history's revs incomparable with every
 * other domain's (already millis) and with the broker, silently breaking LWW.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { HistoryStorage } from "../../session/history-storage";
import { listSyncedProjects, projectById, resolveProject } from "../project-scope";
import type { ReplicatedDomain } from "../replica";
import type { StateEntry } from "../wire";

/** In-project location of a prompt on the wire (absolute cwds never leave). */
interface WireProject {
	id: string;
	/** POSIX path from the project root to the prompt's cwd; `""` at the root. */
	rel: string;
}

/** Payload shape carried in {@link StateEntry.value} for the history domain. */
interface HistoryValue {
	prompt: string;
	/** Epoch SECONDS, matching the table column (NOT the millis `rev`). */
	createdAt: number;
	/** Path-translated project reference; replaces the raw absolute `cwd`. */
	project?: WireProject;
	/**
	 * Legacy pre-scoping field. A mixed-version fleet may still send a bare
	 * absolute `cwd`; we tolerate it on INBOUND (dropping the value) but never
	 * emit it. See {@link isHistoryValue} and the applyRemote fallback.
	 */
	cwd?: string;
	sessionId?: string;
}

/** `stateEntrySchema` caps `key` at 4096 chars; longer prompts are skipped, not truncated. */
const MAX_KEY_LENGTH = 4096;

function isWireProject(value: unknown): value is WireProject {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.rel === "string";
}

function isHistoryValue(value: unknown): value is HistoryValue {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.prompt !== "string" || typeof v.createdAt !== "number") return false;
	if (v.project !== undefined && !isWireProject(v.project)) return false;
	if (v.cwd !== undefined && typeof v.cwd !== "string") return false;
	if (v.sessionId !== undefined && typeof v.sessionId !== "string") return false;
	return true;
}

/** Build the history {@link ReplicatedDomain}; defaults to the process-wide history store. */
export function createHistoryDomain(storage: HistoryStorage = HistoryStorage.open()): ReplicatedDomain {
	return {
		id: "history",

		changedSince(afterRev: number, limit: number): StateEntry[] {
			// `afterRev` is epoch millis; the column is epoch seconds. Our revs are
			// always `created_at * 1000` (a multiple of 1000), so flooring the
			// millis watermark recovers the exact second to compare strictly after.
			const afterSeconds = Math.floor(afterRev / 1000);
			// FAIL CLOSED: only prompts under a sync-enabled project are read.
			const synced = listSyncedProjects();
			if (synced.length === 0) return [];
			// Stored cwds may be the raw localPath or its canonical (symlink-
			// resolved) form, so match against both when they differ.
			const prefixes: string[] = [];
			for (const project of synced) {
				prefixes.push(project.localPath);
				if (project.canonicalPath !== project.localPath) prefixes.push(project.canonicalPath);
			}
			const entries: StateEntry[] = [];
			// Scan FORWARD until the page is either full or provably ends on a
			// COMPLETE second.
			//
			// The project-prefix and null-cwd predicates run in SQL, before the
			// LIMIT, but two predicates cannot: an oversized key (see
			// MAX_KEY_LENGTH) and a cwd that is not in a sync-enabled project.
			// Dropping rows after the limit is what makes an all-dropped page
			// possible, and an empty return tells the sync engine there is nothing
			// to send — so it leaves the outbound watermark where it is, and one
			// page's worth of overlong prompts blocks every newer prompt from ever
			// replicating.
			//
			// The length predicate deliberately stays here rather than moving into
			// SQL: the wire caps `key` at 4096 UTF-16 code units, while SQLite's
			// `length()` counts code points and `length(CAST(x AS BLOB))` counts
			// UTF-8 bytes. The former would admit strings the schema rejects; the
			// latter would silently drop legitimate CJK prompts at a third of the
			// allowance. So we keep the exact check and make skipping cheap instead.
			//
			// The cursor is composite — `(created_at, id)` — because `created_at`
			// has one-second granularity and a page can therefore end mid-second.
			// Advancing by `created_at` alone would skip whatever else that second
			// holds, which is the same class of bug as advancing the watermark onto
			// a partially covered rev; here it is worse, because this cursor is
			// internal and the engine cannot compensate for it.
			let cursorSec = afterSeconds;
			let cursorId: number | undefined;
			for (;;) {
				const rows = storage.scanChangedSinceForPaths(cursorSec, limit, prefixes, cursorId);
				if (rows.length === 0) break; // nothing left: everything scanned is complete.
				for (const row of rows) {
					if (entries.length >= limit) break; // page full; the rest waits for the next pass.
					const key = row.prompt;
					if (key.length > MAX_KEY_LENGTH) {
						// Truncating would alias two distinct prompts under one key, so skip.
						logger.debug("history domain skipping oversized prompt key", { length: key.length });
						continue;
					}
					if (!row.cwd) continue; // the SQL predicate excludes null cwd; defensive.
					const resolved = resolveProject(row.cwd);
					// A cwd inside a synced prefix normally resolves to that project,
					// but not always to a SYNCED one: a registered nested project with
					// `sync: false` sits inside its enabled parent's prefix, and
					// `resolveProject` returns the deepest match. Sending the prompt
					// then stamps the disabled project's own id on it, replicating the
					// history the user opted out of. Judge the resolved project, never
					// the prefix that found it.
					if (!resolved?.project.sync) {
						logger.debug("history domain skipping prompt outside a synced project", { key });
						continue;
					}
					const value: HistoryValue = {
						prompt: row.prompt,
						createdAt: row.created_at,
						project: { id: resolved.project.id, rel: resolved.rel },
						sessionId: row.sessionId,
					};
					entries.push({ key, rev: row.created_at * 1000, value });
				}
				const last = rows[rows.length - 1];
				cursorSec = last.created_at;
				cursorId = last.id;
				// A full page is saturated, so the engine trims its trailing tie and
				// the leftovers are re-read next pass.
				if (entries.length >= limit) break;
				// A short page is the end of the data: every second it touched is
				// complete by definition.
				if (rows.length < limit) break;
				// Otherwise more rows may share `last.created_at`. Returning now
				// would let the engine commit a watermark on that second while part
				// of it is unscanned, and the strict `created_at > cursor` on the
				// next call would skip the remainder forever. Only stop once a kept
				// entry's second is strictly below the second we stopped in.
				const lastEntry = entries[entries.length - 1];
				if (lastEntry && lastEntry.rev < last.created_at * 1000) break;
			}
			return entries;
		},

		applyRemote(entries: readonly StateEntry[]): void {
			const rows: Array<{ prompt: string; createdAt: number; cwd?: string; sessionId?: string }> = [];
			for (const entry of entries) {
				// History has no delete path; a tombstone is meaningless here.
				if (entry.value === null) continue;
				if (!isHistoryValue(entry.value)) {
					logger.debug("history domain dropping malformed remote entry", { key: entry.key });
					continue;
				}
				const value = entry.value;
				if (value.prompt.length > MAX_KEY_LENGTH) continue; // mirrors the outbound key cap.
				let cwd: string | undefined;
				if (value.project) {
					// Reconstruct THIS machine's absolute cwd from the mapping. FAIL
					// CLOSED: if the project is unknown here or has sync disabled, drop
					// the prompt so an unmapped project's history never lands locally.
					const local = projectById(value.project.id);
					if (!local?.sync) {
						logger.debug("history domain skipping unmapped/disabled project", {
							id: value.project.id,
						});
						continue;
					}
					cwd = value.project.rel ? path.join(local.localPath, value.project.rel) : local.localPath;
				} else {
					// Backward tolerance: a pre-scoping peer still sends a bare `cwd`
					// string naming a path on ITS machine. Accept the prompt but drop
					// the meaningless cwd rather than reject it — rejecting would
					// error-loop a mixed-version fleet.
					cwd = undefined;
				}
				rows.push({
					prompt: value.prompt,
					createdAt: value.createdAt,
					cwd,
					sessionId: value.sessionId,
				});
			}
			// One batched transaction for the whole delta; LWW makes replays safe.
			if (rows.length > 0) storage.mergeRemote(rows);
		},
	};
}
