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
 * The archive root is routinely a symlink onto another filesystem (it is one
 * on the machine this was written for), so every walk follows symlinks and
 * nothing here renames or hard-links across the two roots.
 *
 * A restore moves a session between the two trees in two steps (transcript,
 * then artifact tree), which is also what the archive phase does in reverse,
 * so both hold `<agentDir>/gc.lock` while they do it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getAgentDir, getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withGcLock } from "./gc-lock";
import { sessionStagingPath } from "./session-storage";

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

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
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
 * Copy one entry out of the archive, resolving symlinks into real files.
 *
 * Each file lands on a temp beside its destination and is renamed into place,
 * so a killed restore never leaves a partial file at a real path — if it did,
 * the retry below would take that partial for a finished one, skip it, and
 * then drop the archive's complete copy.
 *
 * An entry the live tree already holds is left alone: when a restore is
 * finishing an interrupted attempt the live side is the newer one. A live
 * entry of a different kind (a directory where the archive holds a file) is
 * not something a restore may resolve, so it is reported instead.
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
		if (existing && !existing.isDirectory()) {
			throw new Error(`${destination} is not a directory, so ${source} cannot be restored into it`);
		}
		await fs.mkdir(destination, { recursive: true });
		// `mkdir` applies the umask, so a tree deliberately tightened below it
		// would otherwise come back readable to more than it was.
		await fs.chmod(destination, stat.mode & 0o7777);
		for (const entry of await fs.readdir(source)) {
			await copyEntryDereferenced(path.join(source, entry), path.join(destination, entry));
		}
		return;
	}
	if (!stat.isFile()) return;
	if (existing?.isDirectory()) {
		throw new Error(`${destination} is a directory, so the archived file ${source} cannot be restored over it`);
	}
	if (existing) return;
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
 * Whether the live transcript starts with everything the archive holds — the
 * same session, possibly carried on since it was restored. A transcript only
 * ever grows at its end, so a prefix match is identity; it is what lets a
 * restore that was interrupted before its artifact tree arrived be finished
 * after the session has been resumed.
 *
 * Streamed on both sides: a transcript can be tens of megabytes, and this
 * runs with the gc lock held.
 */
async function archiveIsPrefixOfLive(archiveFile: string, sessionPath: string): Promise<boolean> {
	const live = await fs.open(sessionPath, "r");
	try {
		let offset = 0;
		let mismatch = false;
		const window = Buffer.allocUnsafe(64 * 1024);
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
			for await (const chunk of source as AsyncIterable<Uint8Array>) {
				if (mismatch) continue;
				for (let at = 0; at < chunk.byteLength; at += window.byteLength) {
					const want = Math.min(window.byteLength, chunk.byteLength - at);
					const { bytesRead } = await live.read(window, 0, want, offset);
					if (bytesRead !== want || !window.subarray(0, want).equals(chunk.subarray(at, at + want))) {
						mismatch = true;
						break;
					}
					offset += want;
				}
			}
		});
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
	if (await pathExists(sessionPath)) {
		// The transcript is already live. Either another process restored it
		// while this one waited for the lock, or an earlier attempt moved the
		// transcript and failed on its artifact tree. Finishing that attempt is
		// the only way the tree comes home, so a retry resumes rather than
		// refusing — for this session, carried on or not, never another.
		if ((await pathExists(archiveFile)) && !(await archiveIsPrefixOfLive(archiveFile, sessionPath))) {
			throw new Error(`Refusing to restore over a different session file: ${sessionPath}`);
		}
		bytes = (await fs.stat(sessionPath)).size;
	} else {
		bytes = await inflateArchivedTranscript(archiveFile, sessionPath);
	}

	const notRestored: string[] = [];
	const hasArtifacts = await pathExists(archiveArtifacts);
	let artifactsRestored = !hasArtifacts && (await pathExists(liveArtifacts));
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
