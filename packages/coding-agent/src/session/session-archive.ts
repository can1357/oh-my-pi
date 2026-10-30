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
 * Bytes of a fixed-width title slot at the start of `head`, or 0 when there
 * is none.
 *
 * Physical width is part of the contract, not an accident of the writer:
 * `serializeTitleSlot` pads every slot to exactly
 * {@link SESSION_TITLE_SLOT_BYTES} with the newline last, and
 * `FileSessionStorage.updateSessionTitle` rewrites exactly that span in
 * place. A shorter title record that merely parses is not a slot, and
 * treating it as one would let the skip below swallow the header record that
 * carries the session id — which is the one thing identity rests on.
 */
function titleSlotWidth(head: Uint8Array): number {
	if (head.byteLength < SESSION_TITLE_SLOT_BYTES) return 0;
	const slot = head.subarray(0, SESSION_TITLE_SLOT_BYTES);
	if (slot[SESSION_TITLE_SLOT_BYTES - 1] !== 0x0a) return 0;
	if (slot.subarray(0, SESSION_TITLE_SLOT_BYTES - 1).includes(0x0a)) return 0;
	return parseTitleSlotFromContent(Buffer.from(slot).toString("utf8")) ? SESSION_TITLE_SLOT_BYTES : 0;
}

/**
 * Whether the file open as `destination` holds every byte `source` yields,
 * once the fixed-width title slot either side may carry at byte zero is set
 * aside.
 *
 * A transcript only ever grows at its end, so "the destination starts with
 * all of this" is identity — except for the title slot, which
 * `FileSessionStorage.updateSessionTitle` rewrites in place and
 * `SessionManager` inserts ahead of a legacy transcript that never had one.
 * Each side is measured on its own, so a renamed copy, a copy that gained a
 * slot it did not have, and a copy with no slot on either side all compare
 * as the same session. Everything past the slot — the header record with the
 * id, timestamp and cwd, and every turn after it — is compared byte for
 * byte, so divergence still reads as divergence.
 *
 * Streamed on both sides: a transcript can be tens of megabytes, and this
 * runs with the gc lock held. The source is drained even after a mismatch,
 * because a caller may be feeding it from a pipeline that must finish.
 */
async function sourceIsPrefixOfDestination(
	source: AsyncIterable<Uint8Array>,
	destination: fs.FileHandle,
): Promise<boolean> {
	const window = Buffer.allocUnsafe(64 * 1024);
	// The source's opening bytes, held back until there are enough of them to
	// tell a title slot from ordinary content.
	const head = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
	let headBytes = 0;
	let headSettled = false;
	let mismatch = false;
	let offset = 0;
	const destinationMatches = async (expected: Uint8Array, at: number): Promise<boolean> => {
		const { bytesRead } = await destination.read(window, 0, expected.byteLength, at);
		return bytesRead === expected.byteLength && window.subarray(0, expected.byteLength).equals(expected);
	};
	const settleHead = async (): Promise<boolean> => {
		headSettled = true;
		const destinationHead = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
		const { bytesRead } = await destination.read(destinationHead, 0, SESSION_TITLE_SLOT_BYTES, 0);
		offset = titleSlotWidth(destinationHead.subarray(0, bytesRead));
		const rest = head.subarray(titleSlotWidth(head.subarray(0, headBytes)), headBytes);
		if (rest.byteLength === 0) return true;
		if (!(await destinationMatches(rest, offset))) return false;
		offset += rest.byteLength;
		return true;
	};
	for await (const chunk of source) {
		if (mismatch) continue;
		let at = 0;
		if (!headSettled) {
			const take = Math.min(SESSION_TITLE_SLOT_BYTES - headBytes, chunk.byteLength);
			head.set(chunk.subarray(0, take), headBytes);
			headBytes += take;
			at = take;
			if (headBytes < SESSION_TITLE_SLOT_BYTES) continue;
			if (!(await settleHead())) {
				mismatch = true;
				continue;
			}
		}
		for (; at < chunk.byteLength; at += window.byteLength) {
			const want = Math.min(window.byteLength, chunk.byteLength - at);
			if (!(await destinationMatches(chunk.subarray(at, at + want), offset))) {
				mismatch = true;
				break;
			}
			offset += want;
		}
	}
	// A source shorter than one title slot never settled its head above.
	if (!mismatch && !headSettled && !(await settleHead())) return false;
	return !mismatch;
}

/**
 * Whether the live file at `destination` already holds every byte the
 * archive has at `source`.
 *
 * That is what proves dropping the archive's copy loses nothing. It admits
 * the two shapes a restore has to finish: the entry an earlier attempt
 * already carried home, and the complete live file whose archived copy a
 * killed archive run left truncated. It refuses every shape that is not this
 * entry — a different file of the same name, a rewritten one, a link whose
 * target is gone — because for those the archive holds bytes that exist
 * nowhere else.
 */
async function destinationHoldsSource(source: string, destination: string): Promise<boolean> {
	// Through the link, so a symlink onto a restored file still counts and a
	// dangling one does not. The caller has already refused a link that
	// resolves back into the archive: equal bytes read through such a link are
	// the archive's own, not a second copy.
	if (!(await statIfPresent(destination))?.isFile()) return false;
	const live = await fs.open(destination, "r");
	try {
		return await sourceIsPrefixOfDestination(Bun.file(source).stream(), live);
	} finally {
		await live.close();
	}
}

/** Whether `target` is `root` or lies below it, both already real paths. */
function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether `destination` resolves into `archiveRoot` — the tree the restore is
 * about to delete.
 *
 * A live artifact that is a symlink onto its archived counterpart, or a live
 * artifact directory that is a symlink onto the archived directory, reads
 * byte for byte as "already restored" while being the archive's own bytes
 * seen through another name. Carrying on would delete the tree the live path
 * points into and leave the session with no copy at all. Every directory
 * level is tested on the way down, so a parent alias is caught before its
 * children are even looked at.
 */
async function resolvesIntoArchive(destination: string, archiveRoot: string): Promise<boolean> {
	const real = await fs.realpath(destination).catch(() => undefined);
	return real !== undefined && isWithin(archiveRoot, real);
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
 * file, a link that resolves back into the archive — is reported, and the
 * archive keeps its copy. Refusing to overwrite is right; the bug this
 * guards is dropping the archived original because something unrelated
 * happened to occupy its path, or because the path pointed at the original
 * itself.
 *
 * `archiveRoot` is the real path of the tree the caller removes once this
 * returns, and is what an alias is tested against.
 */
async function copyEntryDereferenced(source: string, destination: string, archiveRoot: string): Promise<void> {
	const stat = await fs.stat(source).catch(error => {
		// A link whose target is gone: nothing to carry, nothing to lose.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat) return;
	const existing = await fs.lstat(destination).catch(() => undefined);
	if (existing && (await resolvesIntoArchive(destination, archiveRoot))) {
		throw new Error(
			`${destination} resolves into the archive at ${archiveRoot}, so it is the archived copy under another name, ` +
				`not a second one; the archive is kept — replace that link with a real file or directory and restore again`,
		);
	}
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
			await copyEntryDereferenced(path.join(source, entry), path.join(destination, entry), archiveRoot);
		}
		return;
	}
	if (!stat.isFile()) return;
	if (existing) {
		if (await destinationHoldsSource(source, destination)) return;
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
	await copyEntryDereferenced(source, destination, await fs.realpath(source));
	await fs.rm(source, { recursive: true, force: true });
}

/**
 * Whether the live transcript holds everything the archive holds — the same
 * session, possibly carried on since it was restored, possibly renamed since.
 * It is what lets a restore that was interrupted before its artifact tree
 * arrived be finished after the session has been resumed.
 *
 * See {@link sourceIsPrefixOfDestination} for what "holds" means and why the
 * title slot is the one span that may differ.
 */
export async function archiveIsPrefixOfLive(archiveFile: string, sessionPath: string): Promise<boolean> {
	const live = await fs.open(sessionPath, "r");
	try {
		let holds = false;
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await sourceIsPrefixOfDestination(source as AsyncIterable<Uint8Array>, live);
		});
		return holds;
	} catch {
		return false;
	} finally {
		await live.close();
	}
}

/**
 * Whether the live file at `livePath` holds every byte the archive holds at
 * `archivedPath`. The archive phase asks this before it lets a copy overwrite
 * an artifact the archive already holds; the restore asks the same question
 * in the other direction through {@link destinationHoldsSource}.
 */
export async function liveFileHoldsArchived(archivedPath: string, livePath: string): Promise<boolean> {
	const live = await fs.open(livePath, "r").catch(() => undefined);
	if (!live) return false;
	try {
		return await sourceIsPrefixOfDestination(Bun.file(archivedPath).stream(), live);
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
