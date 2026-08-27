/**
 * `titles` replicated domain — adapts the session-title index
 * ({@link ../../session/title-index}) to the broker's replication contract.
 *
 * Merge key is the session id (`session_titles` PRIMARY KEY). The logical clock
 * (`rev`) is the row's `updated_at`, stored in epoch SECONDS in the table while
 * the wire's `rev` is epoch MILLIS. We convert at this boundary in BOTH
 * directions (`rev = updated_at * 1000` on read; `value.updatedAt` carries the
 * seconds back through to {@link mergeRemote} on write) so title revs stay
 * comparable with every other domain and the broker — the same seconds/millis
 * rule the history domain follows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { sessionDirNameForCwd } from "../../session/session-paths";
import { mergeRemote, scanChangedSinceForSessionIds } from "../../session/title-index";
import { listSyncedProjects } from "../project-scope";
import type { ReplicatedDomain } from "../replica";
import type { StateEntry } from "../wire";

/** Payload shape carried in {@link StateEntry.value} for the titles domain. */
interface TitleValue {
	sessionId: string;
	title: string;
	/** Epoch SECONDS, matching the table column (NOT the millis `rev`). */
	updatedAt: number;
}

function isTitleValue(value: unknown): value is TitleValue {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.sessionId === "string" && typeof v.title === "string" && typeof v.updatedAt === "number";
}

/**
 * How long the synced session-id set is reused before re-reading the session
 * dirs. A single sync cycle touches many titles; without this every title would
 * re-`readdir` every synced project's dir. Kept short so toggling a project's
 * `sync` flag takes effect within a couple of cycles.
 */
const SYNCED_IDS_TTL_MS = 3_000;

let syncedIdsCache: { at: number; ids: Set<string> } | undefined;

/** Session id embedded in a `<file-safe-timestamp>_<id>.jsonl` filename. */
function sessionIdFromFileName(file: string): string | undefined {
	if (!file.endsWith(".jsonl")) return undefined;
	const sep = file.lastIndexOf("_");
	if (sep <= 0) return undefined;
	return file.slice(sep + 1, -".jsonl".length) || undefined;
}

/**
 * Session ids that belong to a sync-enabled project, memoized briefly. A title
 * carries no cwd, so its project is derived from which synced project's session
 * dir the session file lives in. A project name or task title is exactly the
 * kind of thing a user disables sync to protect, so this set is the strict gate
 * for OUTBOUND titles.
 */
function syncedSessionIds(): Set<string> {
	const now = Date.now();
	if (syncedIdsCache && now - syncedIdsCache.at < SYNCED_IDS_TTL_MS) return syncedIdsCache.ids;
	const ids = new Set<string>();
	const root = getSessionsDir();
	for (const project of listSyncedProjects()) {
		// sessionDirNameForCwd canonicalizes internally, so localPath is fine.
		const dir = path.join(root, sessionDirNameForCwd(project.localPath));
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue; // project may have no sessions yet
		}
		for (const file of files) {
			const id = sessionIdFromFileName(file);
			if (id) ids.add(id);
		}
	}
	syncedIdsCache = { at: now, ids };
	return ids;
}

/** Build the titles {@link ReplicatedDomain}. */
export function createTitlesDomain(): ReplicatedDomain {
	return {
		id: "titles",

		changedSince(afterRev: number, limit: number): StateEntry[] {
			// `afterRev` is epoch millis; the column is epoch seconds. Revs are
			// always `updated_at * 1000`, so flooring recovers the exact second.
			const afterSeconds = Math.floor(afterRev / 1000);
			const ids = syncedSessionIds();
			if (ids.size === 0) return [];
			const entries: StateEntry[] = [];
			for (const row of scanChangedSinceForSessionIds(afterSeconds, limit, ids)) {
				const value: TitleValue = {
					sessionId: row.sessionId,
					title: row.title,
					updatedAt: row.updatedAt,
				};
				entries.push({ key: row.sessionId, rev: row.updatedAt * 1000, value });
			}
			return entries;
		},

		applyRemote(entries: readonly StateEntry[]): void {
			// Asymmetry (strict OUT, permissive IN): outbound is gated on the
			// session belonging to a synced project (see syncedSessionIds), but
			// inbound accepts any well-formed remote title even when the session
			// body has not replicated yet. A title is a short display string, and
			// the peer legitimately sends it under a project it has enabled; B may
			// simply receive the title before the session file arrives. Refusing
			// it here would drop a title B can never recover once the body lands.
			const rows: Array<{ sessionId: string; title: string; updatedAt: number }> = [];
			for (const entry of entries) {
				// The title index has no delete path; a tombstone is a no-op here.
				if (entry.value === null) continue;
				if (!isTitleValue(entry.value)) {
					logger.debug("titles domain dropping malformed remote entry", { key: entry.key });
					continue;
				}
				const value = entry.value;
				rows.push({ sessionId: value.sessionId, title: value.title, updatedAt: value.updatedAt });
			}
			// One batched transaction for the whole delta; LWW makes replays safe.
			if (rows.length > 0) mergeRemote(rows);
		},
	};
}
