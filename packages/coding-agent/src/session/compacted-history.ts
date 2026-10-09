import { getRemoteCompactionPreserve } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionEntry } from "./session-entries";

/**
 * How many leading entries of `path` (root to leaf) a summarizing compaction
 * has archived: the entries before the kept range of the newest compaction on
 * the path that summarizes its history.
 *
 * Nothing on the normal path reads those entries again. The model context
 * starts at the kept range, and compaction preparation reads from the newest
 * reusable compaction's kept range onward.
 *
 * A provider-native compaction is not a boundary. Its placeholder summary
 * covers nothing for another provider, which then re-summarizes the history
 * behind it (the same rule as `findReadableCompactionIndex`). Returns 0 when the
 * newest summarizing compaction's kept range is not on the path before it.
 */
export function archivedPrefixLength(path: readonly SessionEntry[]): number {
	for (let compactionIndex = path.length - 1; compactionIndex >= 0; compactionIndex--) {
		const compaction = path[compactionIndex];
		if (compaction.type !== "compaction" || getRemoteCompactionPreserve(compaction.preserveData)) continue;
		for (let i = 0; i < compactionIndex; i++) {
			if (path[i].id === compaction.firstKeptEntryId) return i;
		}
		return 0;
	}
	return 0;
}

/**
 * The entries of `path` that are archived and may hold their images as blob
 * refs. Compaction entries are excluded: their snapcompact frames follow their
 * own lazy rules.
 */
export function archivedEntries(path: readonly SessionEntry[]): SessionEntry[] {
	return path.slice(0, archivedPrefixLength(path)).filter(entry => entry.type !== "compaction");
}

/**
 * The root-to-leaf path of a freshly loaded journal, whose leaf is its last
 * entry, as the session index would walk it.
 */
export function activePathOfLoadedEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor = entries.at(-1);
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		path.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return path.reverse();
}
