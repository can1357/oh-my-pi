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
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

/**
 * Every file `storage` holds under `dir` whose name matches `pattern`
 * (default: transcripts, `*.jsonl`), at any depth, in walk order.
 */
export function listTranscriptTree(storage: SessionStorage, dir: string, pattern = "*.jsonl"): string[] {
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
		for (const entry of storage.listEntriesSync(current)) {
			if (entry.isFile && matches(entry.name)) found.push(path.join(current, entry.name));
		}
		for (const name of storage.listDirsSync(current)) walk(path.join(current, name));
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
 * A key-indexed storage passes `*` so the session's draft row goes too. Never
 * replaces: a file already at the destination (one the filesystem copy of the
 * artifacts directory already placed, or one written there since) wins.
 * Returns the files it copied.
 */
export async function copyTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
): Promise<TranscriptPlacement[]> {
	const copied: TranscriptPlacement[] = [];
	// A shared store may hold rows another client committed since this one
	// loaded its view; a tree copy that missed them would drop children.
	await storage.refresh?.();
	for (const from of listTranscriptTree(storage, fromDir, pattern)) {
		const to = path.join(toDir, path.relative(fromDir, from));
		if (await storage.exists(to)) continue;
		let content: string;
		try {
			content = await storage.readText(from);
		} catch (err) {
			// Removed since the listing: nothing left to copy.
			if (isEnoent(err)) continue;
			throw err;
		}
		await storage.writeText(to, content);
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
 * {@link restoreTranscripts}. All or nothing: when one move fails, the ones
 * before it are moved back before the error is thrown. A storage with a
 * refusing rename never replaces nor skips a taken destination, whether it
 * was taken before the move or another client takes it while the move runs:
 * that move fails with `EEXIST` naming it, so the session's tree never ends
 * up split or holding another session's child. Under file storage the
 * directory move already placed what it could, and a transcript whose
 * destination is taken stays where it is.
 */
export async function moveTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
): Promise<TranscriptPlacement[]> {
	const moved: TranscriptPlacement[] = [];
	await storage.refresh?.();
	try {
		for (const from of listTranscriptTree(storage, fromDir, pattern)) {
			const to = path.join(toDir, path.relative(fromDir, from));
			if (!storage.renameNoReplace && (await storage.exists(to))) continue;
			storage.ensureDirSync(path.dirname(to));
			try {
				await (storage.renameNoReplace ? storage.renameNoReplace(from, to) : storage.rename(from, to));
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
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
	return moved;
}

/**
 * Move transcripts {@link moveTranscriptTree} moved back to where they were,
 * newest move first. With a refusing rename, a key another client wrote at an
 * old path since is kept: the restore fails with `EEXIST` there, leaving that
 * transcript at its new path.
 */
export async function restoreTranscripts(
	storage: SessionStorage,
	moved: readonly TranscriptPlacement[],
): Promise<void> {
	for (const { from, to } of [...moved].reverse()) {
		await (storage.renameNoReplace ? storage.renameNoReplace(to, from) : storage.rename(to, from));
	}
}
