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
	const walk = (current: string): void => {
		const resolved = path.resolve(current);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		found.push(...storage.listFilesSync(current, pattern));
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
 * Copy every transcript under `fromDir` to the same relative path under
 * `toDir`. Never replaces: a transcript already at the destination (one the
 * filesystem copy of the artifacts directory already placed, or one written
 * there since) wins. Returns the transcripts it copied.
 */
export async function copyTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
): Promise<TranscriptPlacement[]> {
	const copied: TranscriptPlacement[] = [];
	for (const from of listTranscriptTree(storage, fromDir)) {
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
 * `pattern` to the same relative path under `toDir`, leaving one whose
 * destination is taken where it is. A key-indexed storage passes `*`: it keeps
 * the session's unsent prompt draft (`draft.txt`) beside the subagent
 * transcripts, and no directory move carries its rows. Returns the files it
 * moved, so a later failed step can move them back with
 * {@link restoreTranscripts}. All or nothing: when one move fails, the ones
 * before it are moved back before the error is thrown.
 */
export async function moveTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
): Promise<TranscriptPlacement[]> {
	const moved: TranscriptPlacement[] = [];
	try {
		for (const from of listTranscriptTree(storage, fromDir, pattern)) {
			const to = path.join(toDir, path.relative(fromDir, from));
			if (await storage.exists(to)) continue;
			storage.ensureDirSync(path.dirname(to));
			try {
				await storage.rename(from, to);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			moved.push({ from, to });
		}
	} catch (err) {
		await restoreTranscripts(storage, moved);
		throw err;
	}
	return moved;
}

/** Move transcripts {@link moveTranscriptTree} moved back to where they were, newest move first. */
export async function restoreTranscripts(
	storage: SessionStorage,
	moved: readonly TranscriptPlacement[],
): Promise<void> {
	for (const { from, to } of [...moved].reverse()) await storage.rename(to, from);
}
