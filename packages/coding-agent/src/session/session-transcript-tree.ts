/**
 * A session's subagent transcripts nest in its artifacts directory
 * (`<session>/<Id>.jsonl`, `<session>/<Id>/<Id.Sub>.jsonl`, advisors as
 * `__advisor*.jsonl`). Under file storage they are files in that directory;
 * under a key-indexed storage (`session.storage: sql`) they are rows keyed by
 * the same paths, while the directory on disk holds only tool artifacts.
 * Copying, moving, or listing a session's children therefore goes through the
 * storage for the transcripts, whatever the filesystem does with the rest.
 */
import * as path from "node:path";
import { isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { FileSessionStorage, type SessionStorage } from "./session-storage";

/** How a tree operation behaves when one entry, or one directory, fails. */
export interface TranscriptTreeOptions {
	/**
	 * Strand rather than throw: a transcript this cannot read, place or even
	 * enumerate stays where it is and is logged, and the operation reports
	 * what it did move.
	 *
	 * {@link copyTranscriptTree} and {@link moveTranscriptTree} default it to
	 * **true for file storage and false for a key-indexed one**, which is what
	 * each caller's rollback can actually recover from — see
	 * {@link moveTranscriptTree}. It is a default rather than something every
	 * caller must remember, because a caller that forgets gets the behaviour
	 * that loses a session. {@link listTranscriptTree} on its own defaults to
	 * false and leaves the choice to its caller.
	 */
	strandOnFailure?: boolean;
}

/**
 * Every file `storage` holds under `dir` whose name matches `pattern`
 * (default: transcripts, `*.jsonl`), at any depth, in walk order. A directory
 * that cannot be listed stops the walk, unless `strandOnFailure` is set: the
 * unreadable directory is then logged and skipped, and its siblings are still
 * returned.
 */
export function listTranscriptTree(
	storage: SessionStorage,
	dir: string,
	pattern = "*.jsonl",
	options: TranscriptTreeOptions = {},
): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const matches = (name: string): boolean =>
		pattern === "*" || (pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : name === pattern);
	const walk = (current: string): void => {
		const resolved = path.resolve(current);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		// This enumerates one session's subagent tree, so it takes regular files
		// only and shows dot-named ones, the rule stated on
		// `SessionStorage.listFilesSync`. Through the glob it did the opposite,
		// and a `*.jsonl` symlink to a FIFO in an artifacts directory made every
		// caller that reads what this returns — `omp report` among them — block
		// on an open that never returns.
		let entries: ReturnType<SessionStorage["listEntriesSync"]>;
		let dirs: string[];
		try {
			entries = storage.listEntriesSync(current);
			dirs = storage.listDirsSync(current);
		} catch (err) {
			if (!options.strandOnFailure) throw err;
			logger.warn("Skipped a directory of a session's subagent tree that could not be listed", {
				dir: current,
				error: String(err),
			});
			return;
		}
		for (const entry of entries) {
			if (entry.isFile && matches(entry.name)) found.push(path.join(current, entry.name));
		}
		for (const name of dirs) walk(path.join(current, name));
	};
	walk(dir);
	return found;
}

/** A transcript a tree operation placed, as `from` → `to`. */
export interface TranscriptPlacement {
	from: string;
	to: string;
}

/**
 * Copy every file the storage holds under `fromDir` whose name matches
 * `pattern` (default: transcripts) to the same relative path under `toDir`.
 * A key-indexed storage passes `*` so the session's draft row goes too.
 * Returns the files it copied.
 *
 * **Never replaces, and the exclusive write is what decides that.** A file
 * already at the destination wins, whether the filesystem copy of the
 * artifacts directory placed it, or another client of a shared store
 * committed it while this copy was reading its source. An `exists` check
 * cannot decide it: the write would land after the absence it saw stopped
 * being true, keeping this copy's bytes and dropping the ones the other
 * client committed.
 *
 * There IS an `exists` check in the loop below, and it decides nothing — it
 * only avoids reading a source whose destination is already there, which
 * under file storage is almost every source, since the caller's directory
 * copy has usually placed them all. Without it this read a whole tree and
 * threw the bytes away. A destination that appears after it answers still
 * reaches the exclusive write, and still wins.
 */
export async function copyTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
	options: TranscriptTreeOptions = {},
): Promise<TranscriptPlacement[]> {
	const copied: TranscriptPlacement[] = [];
	const strand = options.strandOnFailure ?? storage instanceof FileSessionStorage;
	// A shared store may hold rows another client committed since this one
	// loaded its view; a tree copy that missed them would drop children.
	await storage.refresh?.();
	for (const from of listTranscriptTree(storage, fromDir, pattern, { strandOnFailure: strand })) {
		const to = path.join(toDir, path.relative(fromDir, from));
		// A cheap skip, not the decision. Under file storage the caller's
		// directory copy has usually placed every transcript already, so
		// without this each one is read whole and thrown away — measured at
		// one byte read per byte of tree against none at the merge base. The
		// exclusive write below is still what makes a taken destination win,
		// so a destination that appears after this check is kept, not
		// replaced: this only avoids reading a source that is certainly
		// pointless to read.
		if (await storage.exists(to)) continue;
		let content: string;
		try {
			content = await storage.readText(from);
		} catch (err) {
			// Removed since the listing: nothing left to copy.
			if (isEnoent(err)) continue;
			throw err;
		}
		try {
			await storage.writeTextNoReplace(to, content);
		} catch (err) {
			// The destination is taken: it wins, by this function's contract.
			if (isEexist(err)) continue;
			throw err;
		}
		copied.push({ from, to });
	}
	return copied;
}

/**
 * Move every file the storage holds under `fromDir` whose name matches
 * `pattern` to the same relative path under `toDir`. A key-indexed storage
 * passes `*`: it keeps the session's unsent prompt draft (`draft.txt`) beside
 * the subagent transcripts, and no directory move carries its rows. Returns
 * the files it moved, so a later failed step can move them back with
 * {@link restoreTranscripts}.
 *
 * **Every move refuses to replace.** `renameNoReplace` rejects a destination
 * another writer published since this caller looked, where `rename` would
 * silently overwrite it; the earlier `exists` check could not, because the
 * destination can appear between the check and the rename.
 *
 * The two storage families then need opposite failure handling, named by
 * `strandOnFailure` rather than inferred, because the caller's rollback can
 * undo different amounts of work:
 *
 * - **A key-indexed storage is all or nothing**: when one move fails, the
 *   ones before it are moved back before the error is thrown, so the
 *   session's tree never ends up split or holding another session's child.
 * - **File storage STRANDS**, exactly as `mergeDirectoryInto` does, and never
 *   throws once moving has begun. The directory move ran first and has
 *   already placed everything it could; a caller that rolls its session file
 *   back cannot put those files back, so throwing here would leave the
 *   session at its old path with its subagent transcripts under another
 *   session's directory. A transcript whose destination is taken, whose move
 *   fails for any other reason, or that sits in a directory this cannot even
 *   list, stays where it is and is logged.
 */
export async function moveTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
	options: TranscriptTreeOptions = {},
): Promise<TranscriptPlacement[]> {
	const moved: TranscriptPlacement[] = [];
	const stranded: string[] = [];
	const strand = options.strandOnFailure ?? storage instanceof FileSessionStorage;
	await storage.refresh?.();
	try {
		for (const from of listTranscriptTree(storage, fromDir, pattern, { strandOnFailure: strand })) {
			const to = path.join(toDir, path.relative(fromDir, from));
			try {
				storage.ensureDirSync(path.dirname(to));
				await storage.renameNoReplace(from, to);
			} catch (err) {
				if (isEnoent(err)) continue;
				if (!strand) throw err;
				stranded.push(from);
				logger.warn("Left a subagent transcript at its old path while moving a session", {
					from,
					to,
					error: String(err),
				});
				continue;
			}
			moved.push({ from, to });
		}
	} catch (err) {
		try {
			await restoreTranscripts(storage, moved);
		} catch (rollbackErr) {
			// Not the move's own error: some transcripts stay at their new paths.
			throw new Error(
				`Failed to move subagent transcripts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
				{ cause: rollbackErr },
			);
		}
		throw err;
	}
	if (stranded.length > 0) {
		logger.warn("Moved a session; some subagent transcripts stayed at their old paths", {
			fromDir,
			toDir,
			stranded: stranded.length,
		});
	}
	return moved;
}

/**
 * Move transcripts {@link moveTranscriptTree} moved back to where they were,
 * newest move first. The restore refuses to replace, as the move did: a key
 * another client wrote at an old path since is kept, the restore fails with
 * `EEXIST` there, and that transcript stays at its new path.
 */
export async function restoreTranscripts(
	storage: SessionStorage,
	moved: readonly TranscriptPlacement[],
): Promise<void> {
	for (const { from, to } of [...moved].reverse()) {
		await storage.renameNoReplace(to, from);
	}
}
