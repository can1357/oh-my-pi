/**
 * The cold archive `omp gc --archive` writes to, and the way back out of it.
 *
 * `gc --archive` gzips a transcript to
 * `<agentDir>/archive/sessions/<bucket>/<name>.jsonl.gz` and moves its
 * artifact tree beside it. Nothing else in the agent writes there. A session
 * stays resumable because every read path that misses in the live sessions
 * tree falls back to this module, and because a session is restored to its
 * original path before any component opens it for writing — a `.jsonl.gz` is
 * never handed to the session writer.
 *
 * The archive root is routinely a symlink onto another filesystem, so every
 * walk follows symlinks and nothing here renames or hard-links across the two
 * roots.
 *
 * A restore moves a session between the two trees in two steps (transcript,
 * then artifact tree), which is also what the archive phase does in reverse,
 * so both hold `<agentDir>/gc.lock` while they do it.
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getAgentDir, getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { statIfPresent, withGcLock } from "./gc-lock";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { sessionStagingPath } from "./session-storage";
import { parseTitleSlotFromContent } from "./session-title-slot";

/** Suffix `gc --archive` gives a transcript it has compressed. */
export const ARCHIVED_SESSION_SUFFIX = ".jsonl.gz";
const SESSION_SUFFIX = ".jsonl";
const ARCHIVED_SESSION_GLOB = new Bun.Glob(`*/*${ARCHIVED_SESSION_SUFFIX}`);

/** `<agentDir>/archive/sessions`, the root `gc --archive` moves transcripts into. */
export function getArchivedSessionsDir(agentDir?: string): string {
	return path.join(path.dirname(getSessionsDir(agentDir)), "archive", "sessions");
}

export function isArchivedSessionPath(file: string): boolean {
	return file.endsWith(ARCHIVED_SESSION_SUFFIX);
}

/**
 * Live path of an archived transcript, or undefined when the file is not
 * omp's own archive copy. A `.jsonl.gz` from somewhere else is somebody's own
 * backup: omp reads and writes only inside its archive, so a caller holding
 * one is told to inflate it rather than having omp move their file.
 */
export function liveSessionPathForArchive(archiveFile: string, agentDir?: string): string | undefined {
	if (!isArchivedSessionPath(archiveFile)) return undefined;
	const relative = path.relative(getArchivedSessionsDir(agentDir), archiveFile);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return path.join(getSessionsDir(agentDir), relative.slice(0, -".gz".length));
}

/**
 * Every archived transcript, as absolute paths, newest session first. Buckets
 * and the archive root itself are commonly symlinks onto another filesystem,
 * which `Bun.Glob` walks only when asked. The file name starts with the
 * session's own timestamp, so sorting by name orders sessions by when they
 * ran — unlike mtime, which records when gc happened to archive them.
 */
export async function listArchivedSessionFiles(agentDir?: string): Promise<string[]> {
	const archiveRoot = getArchivedSessionsDir(agentDir);
	try {
		const files = await Array.fromAsync(
			ARCHIVED_SESSION_GLOB.scan({ cwd: archiveRoot, followSymlinks: true }),
			name => path.join(archiveRoot, name),
		);
		files.sort((left, right) => path.basename(right).localeCompare(path.basename(left)));
		return files;
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/**
 * Archived transcripts whose file name carries `sessionArg` as an id prefix,
 * newest session first. The name is `<timestamp>_<id>.jsonl.gz`, so this needs
 * no decompression and stays cheap with a large archive.
 */
export async function findArchivedSessionFiles(sessionArg: string, agentDir?: string): Promise<string[]> {
	const needle = sessionArg.toLowerCase();
	if (!needle) return [];
	const matches: string[] = [];
	for (const file of await listArchivedSessionFiles(agentDir)) {
		const name = path.basename(file, ARCHIVED_SESSION_SUFFIX).toLowerCase();
		const separator = name.lastIndexOf("_");
		const id = separator < 0 ? name : name.slice(separator + 1);
		if (name.startsWith(needle) || id.startsWith(needle)) matches.push(file);
	}
	return matches;
}

export interface RestoredSession {
	/** Live path the transcript now occupies. */
	sessionPath: string;
	archivePath: string;
	/** Bytes of the restored transcript. */
	bytes: number;
	/** The artifact tree (subagent transcripts, tool output) came back too. */
	artifactsRestored: boolean;
	/** What restoring could not bring back, in words a caller can print. */
	notRestored: string[];
}

/**
 * A zlib failure on its own ("unexpected end of file") says nothing about
 * what the reader was holding. Name the archive and the command that reports
 * the same thing with a reason. A filesystem failure — the archive is gone,
 * or unreadable — is passed through untouched, `code` and all: it is not a
 * damaged archive and callers test it with `isEnoent`.
 */
function archiveReadError(file: string, cause: unknown): unknown {
	// zlib failures carry a `Z_`-prefixed code; an errno is the filesystem's.
	if (cause instanceof Error && "code" in cause && /^E[A-Z]+$/.test(String(cause.code))) return cause;
	const stem = path.basename(file, ARCHIVED_SESSION_SUFFIX);
	const id = stem.slice(stem.lastIndexOf("_") + 1) || stem;
	return new Error(
		`Cannot read the archived session "${file}": ${cause instanceof Error ? cause.message : String(cause)}. ` +
			`The archive is damaged; \`omp gc --restore ${id}\` reports the same without touching it.`,
		{ cause },
	);
}

/**
 * Bytes an archived transcript inflates to. Deliberately the same strict
 * inflate the restore and the archive verification use: a reader that
 * tolerates a truncated or appended archive would show a short transcript as
 * a whole one.
 */
export async function inflateArchivedBytes(file: string): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		await pipeline(Bun.file(file).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
			for await (const chunk of source as AsyncIterable<Uint8Array>) {
				chunks.push(chunk);
				length += chunk.byteLength;
			}
		});
	} catch (error) {
		throw archiveReadError(file, error);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Inflate `source` onto `destination` through a temp file in the destination's
 * own directory, and return the bytes written. A truncated archive or a full
 * disk then leaves the destination untouched instead of a zero-length
 * transcript — which is exactly what a hand-written `gunzip -c … > …`
 * produces. The temp file shares the destination's directory so the publish
 * is a rename, which the archive and the sessions tree being on different
 * filesystems would otherwise rule out.
 */
export async function inflateArchivedTranscript(source: string, destination: string): Promise<number> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const tempPath = sessionStagingPath(destination);
	try {
		const handle = await fs.open(tempPath, "w");
		await pipeline(Bun.file(source).stream(), createGunzip(), handle.createWriteStream());
		const { size } = await fs.stat(tempPath);
		await fs.rename(tempPath, destination);
		return size;
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw archiveReadError(source, error);
	}
}

/**
 * Whether the live file at `destination` already holds every byte the archive
 * has at `source` — the archived copy read as a prefix of it.
 *
 * That is what proves dropping the archive's copy loses nothing, and it is
 * the same identity rule {@link archiveIsPrefixOfLive} applies to the
 * transcript. It admits the two shapes a restore has to finish: the entry an
 * earlier attempt already carried home byte for byte, and the complete live
 * file whose archived copy a killed archive run left truncated. It refuses
 * every shape that is not this entry — a different file of the same name, a
 * rewritten one, a link whose target is gone — because for those the archive
 * holds bytes that exist nowhere else.
 */
async function destinationHoldsSource(source: string, sourceStat: Stats, destination: string): Promise<boolean> {
	// Through the link, so a symlink onto the restored file still counts and a
	// dangling one does not. A shorter destination cannot hold the whole source.
	const target = await statIfPresent(destination);
	if (!target?.isFile() || target.size < sourceStat.size) return false;
	const live = await fs.open(destination, "r");
	try {
		let offset = 0;
		const window = Buffer.allocUnsafe(64 * 1024);
		for await (const chunk of Bun.file(source).stream()) {
			for (let at = 0; at < chunk.byteLength; at += window.byteLength) {
				const want = Math.min(window.byteLength, chunk.byteLength - at);
				const { bytesRead } = await live.read(window, 0, want, offset);
				if (bytesRead !== want || !window.subarray(0, want).equals(chunk.subarray(at, at + want))) return false;
				offset += want;
			}
		}
		return true;
	} finally {
		await live.close();
	}
}

/**
 * Copy one entry out of the archive, resolving symlinks into real files.
 *
 * Each file lands on a temp beside its destination and is renamed into place,
 * so a killed restore never leaves a partial file at a real path — if it did,
 * the retry below would take that partial for a finished one, skip it, and
 * then drop the archive's complete copy.
 *
 * An entry the live tree already holds with the archive's own bytes is left
 * alone: that is an entry an interrupted attempt of this restore already
 * carried home. Anything else standing at the destination — a different file
 * of the same name, a dangling link, a directory where the archive holds a
 * file — is reported, and the archive keeps its copy. Refusing to overwrite
 * is right; the bug this guards is dropping the archived original because
 * something unrelated happened to occupy its path.
 */
async function copyEntryDereferenced(source: string, destination: string): Promise<void> {
	const stat = await fs.stat(source).catch(error => {
		// A link whose target is gone: nothing to carry, nothing to lose.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat) return;
	const existing = await fs.lstat(destination).catch(() => undefined);
	if (stat.isDirectory()) {
		// Through the link: a symlinked artifact directory is a directory the
		// restore may merge into, the same way the archive phase walks one.
		if (existing && !(await statIfPresent(destination))?.isDirectory()) {
			throw new Error(`${destination} is not a directory, so ${source} cannot be restored into it`);
		}
		await fs.mkdir(destination, { recursive: true });
		// Only a directory this restore created takes the archived mode: `mkdir`
		// applies the umask, so a tree deliberately tightened below it would
		// otherwise come back readable to more than it was. A directory the live
		// tree already holds keeps its own permissions — merging an archive into
		// a private `0700` directory must not widen it to the archive's mode.
		if (!existing) await fs.chmod(destination, stat.mode & 0o7777);
		for (const entry of await fs.readdir(source)) {
			await copyEntryDereferenced(path.join(source, entry), path.join(destination, entry));
		}
		return;
	}
	if (!stat.isFile()) return;
	if (existing) {
		if (await destinationHoldsSource(source, stat, destination)) return;
		throw new Error(
			`${destination} already holds something else, so the archived ${source} was left in the archive; ` +
				`move that path aside and restore again`,
		);
	}
	// Named so `omp gc` reclaims it: a killed copy leaves it behind, and the
	// staging sweep already clears a writer's abandoned temps.
	const tempPath = sessionStagingPath(destination);
	try {
		await fs.copyFile(source, tempPath);
		await fs.rename(tempPath, destination);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

/** Bring an archived artifact tree home, then drop the archive's copy. */
async function copyTreeDereferenced(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await copyEntryDereferenced(source, destination);
	await fs.rm(source, { recursive: true, force: true });
}

/**
 * Whether both transcripts open with a fixed-width title slot. The slot is
 * rewritten in place at byte zero by `FileSessionStorage.updateSessionTitle`,
 * so a session renamed since it was archived differs from its archive in
 * exactly those bytes while still being the same session; comparing them
 * would refuse the restore for ever. Every byte that carries identity — the
 * header record with the id, timestamp and cwd — follows the slot and is
 * still compared.
 */
async function bothOpenWithTitleSlot(archiveHead: Buffer, live: fs.FileHandle): Promise<boolean> {
	if (!parseTitleSlotFromContent(archiveHead.toString("utf8"))) return false;
	const liveHead = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
	const { bytesRead } = await live.read(liveHead, 0, SESSION_TITLE_SLOT_BYTES, 0);
	if (bytesRead !== SESSION_TITLE_SLOT_BYTES) return false;
	return parseTitleSlotFromContent(liveHead.toString("utf8")) !== undefined;
}

/**
 * Whether the live transcript starts with everything the archive holds — the
 * same session, possibly carried on since it was restored. A transcript only
 * ever grows at its end, so a prefix match is identity; it is what lets a
 * restore that was interrupted before its artifact tree arrived be finished
 * after the session has been resumed. The one span that does change in place
 * is the title slot, and {@link bothOpenWithTitleSlot} passes over it.
 *
 * Streamed on both sides: a transcript can be tens of megabytes, and this
 * runs with the gc lock held.
 */
export async function archiveIsPrefixOfLive(archiveFile: string, sessionPath: string): Promise<boolean> {
	const live = await fs.open(sessionPath, "r");
	try {
		let offset = 0;
		let mismatch = false;
		const window = Buffer.allocUnsafe(64 * 1024);
		// The archive's opening bytes, held back until there are enough of them
		// to tell a title slot from ordinary content.
		const head = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
		let headBytes = 0;
		let headSettled = false;
		const liveMatches = async (expected: Uint8Array, at: number): Promise<boolean> => {
			const { bytesRead } = await live.read(window, 0, expected.byteLength, at);
			return bytesRead === expected.byteLength && window.subarray(0, expected.byteLength).equals(expected);
		};
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
			for await (const chunk of source as AsyncIterable<Uint8Array>) {
				if (mismatch) continue;
				let at = 0;
				if (!headSettled) {
					const take = Math.min(SESSION_TITLE_SLOT_BYTES - headBytes, chunk.byteLength);
					head.set(chunk.subarray(0, take), headBytes);
					headBytes += take;
					at = take;
					if (headBytes < SESSION_TITLE_SLOT_BYTES) continue;
					headSettled = true;
					if (!(await bothOpenWithTitleSlot(head, live)) && !(await liveMatches(head, 0))) {
						mismatch = true;
						continue;
					}
					offset = SESSION_TITLE_SLOT_BYTES;
				}
				for (; at < chunk.byteLength; at += window.byteLength) {
					const want = Math.min(window.byteLength, chunk.byteLength - at);
					if (!(await liveMatches(chunk.subarray(at, at + want), offset))) {
						mismatch = true;
						break;
					}
					offset += want;
				}
			}
		});
		// An archive shorter than one title slot never settled the head above.
		if (!mismatch && !headSettled) return await liveMatches(head.subarray(0, headBytes), 0);
		return !mismatch;
	} catch {
		return false;
	} finally {
		await live.close();
	}
}

/**
 * Put an archived transcript back where it belongs, with its artifact tree,
 * and drop the archive copy so the session exists in exactly one place.
 *
 * The caller must hold the gc lock: between the transcript landing and the
 * artifact tree following it, the session exists in both trees, and an
 * archive phase running in that window would move the halves past each other.
 */
export async function restoreArchivedSessionLocked(archiveFile: string, agentDir?: string): Promise<RestoredSession> {
	const sessionPath = liveSessionPathForArchive(archiveFile, agentDir);
	if (!sessionPath) {
		throw new Error(
			`"${archiveFile}" is not in this agent's session archive (${getArchivedSessionsDir(agentDir)}). ` +
				`Inflate it yourself with \`gunzip -c "${archiveFile}" > <file>.jsonl\`; omp does not move files outside its own storage.`,
		);
	}
	const archiveArtifacts = archiveFile.slice(0, -ARCHIVED_SESSION_SUFFIX.length);
	const liveArtifacts = sessionPath.slice(0, -SESSION_SUFFIX.length);
	let bytes: number;
	if (await statIfPresent(sessionPath)) {
		// The transcript is already live. Either another process restored it
		// while this one waited for the lock, or an earlier attempt moved the
		// transcript and failed on its artifact tree. Finishing that attempt is
		// the only way the tree comes home, so a retry resumes rather than
		// refusing — for this session, carried on or not, never another.
		if ((await statIfPresent(archiveFile)) && !(await archiveIsPrefixOfLive(archiveFile, sessionPath))) {
			throw new Error(`Refusing to restore over a different session file: ${sessionPath}`);
		}
		bytes = (await fs.stat(sessionPath)).size;
	} else {
		bytes = await inflateArchivedTranscript(archiveFile, sessionPath);
	}

	const notRestored: string[] = [];
	const hasArtifacts = (await statIfPresent(archiveArtifacts)) !== undefined;
	let artifactsRestored = !hasArtifacts && (await statIfPresent(liveArtifacts)) !== undefined;
	if (hasArtifacts) {
		try {
			await copyTreeDereferenced(archiveArtifacts, liveArtifacts);
			artifactsRestored = true;
		} catch (error) {
			notRestored.push(
				`the artifact tree (subagent transcripts, tool output) at ${archiveArtifacts}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	// Keep the archive when its artifacts did not come with it, so the next
	// attempt still has both halves to work from.
	if (artifactsRestored || !hasArtifacts) await fs.rm(archiveFile, { force: true });
	return { sessionPath, archivePath: archiveFile, bytes, artifactsRestored, notRestored };
}

/**
 * {@link restoreArchivedSessionLocked}, taking the gc lock for the caller.
 * Queues behind a maintenance run rather than failing: the caller here is
 * someone opening a session, who never asked to compete with `omp gc`.
 */
export async function restoreArchivedSession(archiveFile: string, agentDir?: string): Promise<RestoredSession> {
	const dir = agentDir ?? getAgentDir();
	try {
		return await withGcLock(dir, () => restoreArchivedSessionLocked(archiveFile, dir), { waitMs: 30_000 });
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("GC already running")) {
			throw new Error(
				`Cannot open "${archiveFile}": an omp storage maintenance run is holding ${path.join(dir, "gc.lock")}, so the session cannot come out of the archive yet. Retry once it finishes.`,
			);
		}
		throw error;
	}
}

/**
 * The live `.jsonl` path of a session file, bringing it out of the archive
 * first when that is where it lives. Everything that reads a session as an
 * ordinary file — the writer, a fork and its artifact copy, `omp render`,
 * `omp session pack`, `omp anonymize` — goes through here, so none of them
 * has to understand `.jsonl.gz`, and none of them silently drops the
 * subagent transcripts and tool output stored beside it.
 *
 * A restore that could not bring the artifact tree back fails here rather
 * than handing out a transcript whose artifacts are still in the archive:
 * the live transcript wins every later id lookup, so an unreported half
 * restore is one nothing would retry.
 */
export async function materializeSessionFile(sessionFile: string, agentDir?: string): Promise<string> {
	if (!isArchivedSessionPath(sessionFile)) return sessionFile;
	const restored = await restoreArchivedSession(sessionFile, agentDir);
	if (restored.notRestored.length > 0) {
		const stem = path.basename(restored.sessionPath, SESSION_SUFFIX);
		throw new Error(
			`Restored the transcript of "${sessionFile}" to ${restored.sessionPath}, but could not restore ${restored.notRestored.join("; ")}. ` +
				`The archive is kept; \`omp gc --restore ${stem.slice(stem.lastIndexOf("_") + 1) || stem} --apply\` retries it once the path is clear.`,
		);
	}
	return restored.sessionPath;
}
