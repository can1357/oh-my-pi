import type { FileEntry, SessionEntry, SessionHeader } from "./session-entries";

/** A disagreement on one independently compared part of a shared entry. */
export interface SessionMergeConflict {
	entryId: string;
	reason: "parent" | "payload" | "header";
}

export interface SessionMergePlan {
	/** Entries already present in the authoritative destination. */
	keptEntries: number;
	/** Source-only entries grafted into the destination tree. */
	addedEntries: number;
	/** Source-only entries that cannot attach, including their descendants. */
	skippedEntries: number;
	conflicts: SessionMergeConflict[];
	/** Destination order with each grafted entry interleaved after its parent. */
	merged: FileEntry[];
}

/**
 * Plan a union of two files for the same logical session.
 *
 * In practice, two concurrent writers can carry the same session id into two
 * project directories. Their files share much of the tree but each can contain
 * branches the other lacks, so exact-file deduplication would lose work. This
 * merge instead unions entries by id and grafts every source-only branch whose
 * ancestry reaches an existing entry (or a null root).
 *
 * The destination wins for shared ids because applying a merge must not rewrite
 * data already chosen by the operator as the target. Parent and payload are
 * compared independently: a parent-only disagreement reports only `parent`;
 * differences in all fields other than `parentId` report `payload`, so an entry
 * that differs on both axes reports both conflicts. Headers are compared as a
 * whole because concurrent writers can diverge on `title` and `titleSource`;
 * a changed shared header reports `header`, but the destination copy is kept.
 * Source headers are partitioned first and never grafted.
 *
 * `merged` interleaves rather than appends: destination entries keep their
 * original order and every grafted entry is emitted immediately after its
 * parent, depth-first through its grafted descendants and in source order
 * among siblings. Source-only roots (null `parentId`) land after the
 * destination's leading header and before its first entry, so the header stays
 * the first physical record of the file.
 *
 * That ordering is load-bearing. `SessionEntryIndex.insert` moves the leaf to
 * every entry it sees, so `rebuild()` resumes on whatever the file ends with:
 * appending the grafts wholesale moved the active branch onto the source
 * copy's last branch, which is what made a merge look like the other
 * conversation glued onto the end of this one. Interleaving keeps the
 * destination's original last entry last, and therefore keeps the resumed
 * leaf. The single exception is a source branch descending from that last
 * entry: its continuation is emitted after it and necessarily becomes the new
 * leaf.
 *
 * Interleaving is also the correct journal semantics. `label` and `archive`
 * records (as handled by `insert()`), along with title changes, are
 * last-record-wins. Placing grafted records before the destination's own later
 * records therefore keeps the destination authoritative, matching the conflict
 * policy above.
 */
export function planSessionMerge(into: readonly FileEntry[], from: readonly FileEntry[]): SessionMergePlan {
	const destinationIds = new Set(into.map(entry => entry.id));
	const destinationById = new Map<string, SessionEntry>();
	const destinationHeaderById = new Map<string, SessionHeader>();
	for (const entry of into) {
		if (entry.type === "session") destinationHeaderById.set(entry.id, entry);
		else destinationById.set(entry.id, entry);
	}

	const conflicts: SessionMergeConflict[] = [];
	const sourceById = new Map<string, SessionEntry>();
	const seenSourceIds = new Set<string>();
	let skippedHeaders = 0;
	for (const entry of from) {
		if (seenSourceIds.has(entry.id)) continue;
		seenSourceIds.add(entry.id);
		if (entry.type === "session") {
			const destinationHeader = destinationHeaderById.get(entry.id);
			if (destinationHeader) {
				if (!Bun.deepEquals(destinationHeader, entry)) {
					conflicts.push({ entryId: entry.id, reason: "header" });
				}
			} else {
				skippedHeaders++;
			}
			continue;
		}
		sourceById.set(entry.id, entry);
	}

	for (const source of sourceById.values()) {
		const destination = destinationById.get(source.id);
		if (!destination) continue;

		const parentDiffers = destination.parentId !== source.parentId;
		if (parentDiffers) conflicts.push({ entryId: source.id, reason: "parent" });

		const payloadDiffers = parentDiffers
			? !Bun.deepEquals(destination, { ...source, parentId: destination.parentId })
			: !Bun.deepEquals(destination, source);
		if (payloadDiffers) conflicts.push({ entryId: source.id, reason: "payload" });
	}

	const childrenByParent = new Map<string, SessionEntry[]>();
	const sourceRoots: SessionEntry[] = [];
	let sourceOnlyCount = 0;
	for (const source of sourceById.values()) {
		if (destinationIds.has(source.id)) continue;
		sourceOnlyCount++;

		if (source.parentId === null) {
			sourceRoots.push(source);
			continue;
		}
		const siblings = childrenByParent.get(source.parentId);
		if (siblings) siblings.push(source);
		else childrenByParent.set(source.parentId, [source]);
	}

	const merged: FileEntry[] = [];
	let addedEntries = 0;

	// Pre-order walk of one grafted subtree. Buckets are consumed as they are
	// visited, so a duplicated destination id cannot graft the same branch twice
	// and an unreachable cycle among source-only entries stays unreachable.
	const emitGraft = (root: SessionEntry): void => {
		const stack: SessionEntry[] = [root];
		for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
			merged.push(entry);
			addedEntries++;
			const children = childrenByParent.get(entry.id);
			if (!children) continue;
			childrenByParent.delete(entry.id);
			for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
		}
	};

	let rootsEmitted = false;
	for (const entry of into) {
		if (!rootsEmitted && entry.type !== "session") {
			for (const root of sourceRoots) emitGraft(root);
			rootsEmitted = true;
		}
		merged.push(entry);
		const children = childrenByParent.get(entry.id);
		if (!children) continue;
		childrenByParent.delete(entry.id);
		for (const child of children) emitGraft(child);
	}
	if (!rootsEmitted) for (const root of sourceRoots) emitGraft(root);

	return {
		keptEntries: into.length,
		addedEntries,
		skippedEntries: skippedHeaders + sourceOnlyCount - addedEntries,
		conflicts,
		merged,
	};
}
