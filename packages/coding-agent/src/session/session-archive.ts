/**
 * The cold archive `omp gc --archive` writes to, and the way back out of it.
 *
 * `gc --archive` copies a transcript, gzipped, to
 * `<agentDir>/archive/sessions/<bucket>/<name>.jsonl.gz` and copies its
 * artifact tree beside it; the live copy stays until `gc --reclaim` gives it
 * up. Nothing else in the agent writes there. A session stays resumable
 * because every read path that misses in the live sessions tree falls back
 * to this module, and because a session is restored to its original path
 * before any component opens it for writing — a `.jsonl.gz` is never handed
 * to the session writer.
 *
 * The archive root is routinely a symlink onto another filesystem, so every
 * walk follows symlinks and nothing here renames or hard-links across the two
 * roots.
 *
 * A restore copies a session into the live tree in two steps (transcript,
 * then artifact tree), the reverse of what the archive phase does, so both
 * hold `<agentDir>/gc.lock` while they do it.
 */
import * as fs from "./gc-fs";
import { CryptoHasher, constants as fsConstants, Glob, type Stats } from "./gc-fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getAgentDir, getSessionsDir, isEnoent, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { codeOf, statIfPresent, withGcLock } from "./gc-lock";
import {
	absentFile,
	chmodDirectory,
	createExclusive,
	type HeldFile,
	kindOf,
	newNonce,
	NotARegularFile,
	notRegularAsAbsent,
	openRegularFile,
	type OwnFileRemoval,
	removeFileNoOneElseWrites,
	unlinkFileNoOneElseWrites,
	writeExclusive,
} from "./regular-file";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { readSessionHeaderIdFromHandle, sessionHeaderIdFromBytes } from "./session-loader";
import { SESSION_STAGING_RE, sessionStagingPath, tryAcquireSessionLease } from "./session-storage";
import { parseTitleSlotFromContent, parseTitleSlotLine } from "./session-title-slot";

/** Suffix `gc --archive` gives a transcript it has compressed. */
export const ARCHIVED_SESSION_SUFFIX = ".jsonl.gz";
const SESSION_SUFFIX = ".jsonl";
const ARCHIVED_SESSION_GLOB = new Glob(`*/*${ARCHIVED_SESSION_SUFFIX}`);

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

/** The archived transcript a live session path would be stored as, if one is there. */
export function archivedSessionPathForLive(sessionFile: string, agentDir?: string): string | undefined {
	if (!sessionFile.endsWith(SESSION_SUFFIX)) return undefined;
	const relative = path.relative(getSessionsDir(agentDir), sessionFile);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return path.join(getArchivedSessionsDir(agentDir), `${relative}.gz`);
}
/**
 * The agent directory an archived path belongs to, derived from the path
 * itself: `<agentDir>/archive/sessions/<bucket>/<name>.jsonl.gz`.
 *
 * A command printed for the reader has to name the directory this work
 * happened in, not the one this process happens to default to. Someone who
 * passes an explicit archive path from another agent directory and is then
 * handed a recovery command scoped to their own default runs it against the
 * wrong storage, where it reports success for a session it never saw.
 */
export function agentDirOfArchivedPath(archiveFile: string): string | undefined {
	const sessionsRoot = path.dirname(path.dirname(archiveFile));
	if (path.basename(sessionsRoot) !== "sessions") return undefined;
	const archiveRoot = path.dirname(sessionsRoot);
	if (path.basename(archiveRoot) !== "archive") return undefined;
	return path.dirname(archiveRoot);
}

/**
 * The record a restore keeps while it is unfinished.
 *
 * Written before anything is published and removed only when every entry is
 * home, so "did a restore finish?" is answered by the restore that ran
 * rather than re-derived later from what the live tree looks like. Every
 * attempt to infer it afterwards was wrong in both directions: a tool output
 * a session emptied read as an unfinished restore, and an artifact a restore
 * had refused to write over read as a finished one, so the refusal became a
 * silent success on the next ordinary resume.
 *
 * It lives beside the archive rather than in the live tree, because the live
 * tree is what a session writes to and what the archive phase copies.
 */
export function restoreRecordPath(archiveFile: string): string {
	return `${archiveFile}.restoring`;
}

/**
 * Why the name of a restore record cannot serve as one, or undefined when it
 * can: when nothing is there, or a regular file. A link, a FIFO, a device or a
 * directory there is not a record a restore wrote; nothing is written through
 * it, waited on, replaced or removed in its place, and the caller refuses,
 * naming it. `lstat`, so a link is judged as the link. A regular file there is
 * not judged by what it holds: whatever it holds, it is left — see
 * {@link createRestoreRecord}.
 */
export async function restoreRecordRefusal(record: string): Promise<string | undefined> {
	const standing = await fs.lstat(record).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!standing || standing.isFile()) return undefined;
	const what = standing.isSymbolicLink()
		? "a symbolic link"
		: standing.isDirectory()
			? "a directory"
			: standing.isFIFO()
				? "a FIFO"
				: "not a regular file";
	return (
		`${record}, where a restore keeps its record of being unfinished, is ${what}, not a record a restore wrote, ` +
		`so nothing was restored and nothing was written to it; look at it, move it aside, and run the same command again. ` +
		moveAsidePermission(record)
	);
}

/**
 * What to do when moving a record aside is refused: the directory it is in —
 * the archive bucket, which can be made read-only — has to be writable.
 */
export function moveAsidePermission(record: string): string {
	return (
		`If moving it is refused permission, ${path.dirname(record)} is not writable: make it writable with ` +
		`\`chmod u+w\` and move it again`
	);
}

/**
 * What is said about a regular file that stood at a restore record's name
 * before this run: an earlier restore's record, or anything else — what it
 * holds is no evidence either way. It is left, and while it is there the
 * session is treated as unfinished: resuming it, `omp render` and anything
 * else that opens it first finishes the restore, and so refuse too.
 */
export function restoreRecordLeftNote(record: string): string {
	return (
		`${record} was there before this run — an earlier restore's record of being unfinished, or something else — and a ` +
		`restore removes only the record it created in the same run, so it was left; while it is there this session is treated as ` +
		`unfinished, and it does not open: resuming it, \`omp render\` and anything else that opens it refuse as gc does. ` +
		`Look at it, and once the session holds everything, move it aside. ${moveAsidePermission(record)}`
	);
}

/** The start of what is said when the directory a restore record lives in refuses a change to it. */
function recordDirectoryNotWritable(record: string, error: unknown): string {
	return `${path.dirname(record)} is not writable (${errorText(error)})`;
}

const isPermissionError = (error: unknown): boolean => codeOf(error) === "EACCES" || codeOf(error) === "EPERM";

/** The restore record this run made, held through the descriptor it was made with. */
interface OwnRestoreRecord {
	path: string;
	handle: fs.FileHandle;
	dev: number;
	ino: number;
}

/**
 * Make this run's restore record, holding `text`, or return undefined when
 * something already has the name. It is created exclusively — `O_CREAT |
 * O_EXCL`, which neither follows a link nor opens what is there — and its
 * identity is taken from the descriptor it was created through, so what this
 * run later rewrites is the file it made, never one that has the name by
 * then, and what it removes is decided by that identity
 * ({@link dropOwnRestoreRecord} says where a name still decides). An error
 * after the create and before the write leaves an empty record, which, not
 * being taken down by this run, needs the same move aside as any record a
 * run left.
 */
async function createRestoreRecord(record: string, text: string): Promise<OwnRestoreRecord | undefined> {
	await fs.mkdir(path.dirname(record), { recursive: true });
	let handle: fs.FileHandle;
	try {
		handle = await createExclusive(record, 0o600);
	} catch (error) {
		if (codeOf(error) === "EEXIST") return undefined;
		if (isPermissionError(error)) {
			throw new Error(
				`${recordDirectoryNotWritable(record, error)}, so the restore could not make ${record} and restored nothing: ` +
					`make it writable with \`chmod u+w\` and run the same command again`,
			);
		}
		throw error;
	}
	try {
		await handle.writeFile(text);
		const { dev, ino } = await handle.stat();
		return { path: record, handle, dev, ino };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

/** Put `text` in this run's record, through its descriptor: never through a name. */
async function rewriteOwnRestoreRecord(own: OwnRestoreRecord, text: string): Promise<void> {
	await own.handle.truncate(0);
	await own.handle.write(text, 0);
}

/**
 * Take this run's record down, or say why what has its name was left. It is
 * removed only while the name holds the file this run created, by the
 * identity taken at creation and while this run still holds the descriptor
 * it created the record through, so that inode cannot have been handed out
 * again to a file someone put at the name — see {@link unlinkFileNoOneElseWrites}, which
 * also names the one gap left: a file renamed onto the name between the last
 * look and the `unlink`. A directory that refuses the change is named, with
 * what to do.
 */
async function dropOwnRestoreRecord(own: OwnRestoreRecord): Promise<string | undefined> {
	let removal: OwnFileRemoval;
	try {
		removal = await unlinkFileNoOneElseWrites(own.path, [own]);
	} catch (error) {
		if (!isPermissionError(error)) throw error;
		return (
			`${recordDirectoryNotWritable(own.path, error)}, so this restore could not take down its record ${own.path}, ` +
			`though everything else came home. While it is there the session is treated as unfinished and does not open: ` +
			`make the directory writable with \`chmod u+w\`, then look at the record and move it aside`
		);
	}
	if (removal !== "kept") return undefined;
	return (
		`${own.path} held something other than the record this restore wrote, so it was left: look at it, and once the ` +
		`session holds everything, move it aside`
	);
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
export function archiveReadError(file: string, cause: unknown): unknown {
	// A name that is not a regular file says so itself, and is no damage.
	if (cause instanceof NotARegularFile) return cause;
	// zlib failures carry a `Z_`-prefixed code; an errno is the filesystem's.
	if (cause instanceof Error && "code" in cause && /^E[A-Z]+$/.test(String(cause.code))) return cause;
	const stem = path.basename(file, ARCHIVED_SESSION_SUFFIX);
	const id = stem.slice(stem.lastIndexOf("_") + 1) || stem;
	return new Error(
		`Cannot read the archived session "${file}": ${cause instanceof Error ? cause.message : String(cause)}. ` +
			`The archive is damaged; \`omp gc --restore ${shellQuote(id)}${agentDirFlag(agentDirOfArchivedPath(file) ?? getAgentDir())}\` reports the same without touching it.`,
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
		await pipeline(bytesOfRegularFile(file), createGunzip(), async (source: NodeJS.ReadableStream) => {
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
 * Inflate `source` onto `destination` through a staging directory this run
 * mints beside the destination, and return the bytes written. A truncated
 * archive or a full disk then leaves the destination untouched instead of a
 * zero-length transcript — which is exactly what a hand-written
 * `gunzip -c … > …` produces. The stage shares the destination's filesystem
 * so the publish is a link, which the archive and the sessions tree being on
 * different filesystems would otherwise rule out.
 *
 * `link`, not `rename`: a transcript only comes out of the archive onto a
 * path nothing holds, so a file that appeared there in the meantime is
 * someone's work. `EEXIST` says so instead of writing over it. What the link
 * left at that name is read back by {@link checkPublished}.
 */
export async function inflateArchivedTranscript(
	source: string,
	destination: string,
	ledger: string,
	notes: string[] = [],
): Promise<number> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	// A directory this run mints and records, so the stage is a file of this
	// run's own making, and a later restore leaves it out of the live tree if
	// this run is killed before removing it. The transcript keeps the
	// archive's mode, which is the live transcript's: a private session must
	// not come back readable by more than it was.
	const mode = (await fs.stat(source)).mode & 0o7777;
	const ground = await mintStagingGround(destination, ledger, mode);
	try {
		await ground.handle.chmod(mode);
		// Only a failed read of the archive says anything about the archive:
		// what goes wrong publishing the transcript afterwards is reported as
		// itself, never as a damaged archive.
		const written = await inflateIntoHandleWithDigest(bytesOfRegularFile(source), ground.handle).catch(
			(error: unknown) => {
				throw archiveReadError(source, error);
			},
		);
		const landed = await fs.lstat(ground.file).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (landed?.dev !== ground.created.dev || landed.ino !== ground.created.ino) {
			throw new Error(`${ground.file} was replaced while the transcript was being written`);
		}
		await fs.link(ground.file, destination);
		const check = await checkPublished(destination, ground.created, holdsCopied(written));
		if (!check.staged) {
			throw new Error(
				`${notStagedMessage(destination, "the transcript this restore wrote", check)}, so it was left as it is`,
			);
		}
		return written.size;
	} finally {
		try {
			const note = await removeStagingGround(ground);
			if (note) notes.push(note);
		} finally {
			await ground.handle.close().catch(() => undefined);
		}
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
 * Bytes a transcript spends on its name before the conversation starts, with
 * the header record that identifies it — or undefined when `head` does not
 * open a session transcript at all.
 *
 * This is what keeps transcript semantics off ordinary artifacts. A tool-output
 * log whose first line happens to look like a title record is not a transcript,
 * and letting the comparison below skip bytes in one would make arbitrary
 * content ignorable.
 */
function readTranscriptHead(head: Uint8Array): { prefixBytes: number; header: Record<string, unknown> } | undefined {
	const slot = titleSlotWidth(head);
	const rest = head.subarray(slot);
	const newline = rest.indexOf(0x0a);
	if (newline < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(rest.subarray(0, newline)).toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const header = parsed as Record<string, unknown>;
	if (header.type !== "session" || typeof header.id !== "string") return undefined;
	return { prefixBytes: slot + newline + 1, header };
}

/**
 * Header fields that carry the session's name rather than its identity.
 *
 * A rename is written in whichever representation the writer of the day uses:
 * the fixed-width slot today, and — when `SessionManager.setSessionName`
 * rewrites a transcript that predates the slot — `title` and `titleSource` on
 * the header record itself. Both are the same editable name, so neither takes
 * part in deciding whether two files are the same session. Every other field,
 * `id` and `timestamp` and `cwd` included, must match exactly — except the
 * schema `version`, which `migrateToCurrentVersion` raises when the writer
 * opens a transcript an older build wrote. A raised version is the same
 * session in a newer shape; a lowered one is not, and is refused.
 */
const RENAMEABLE_HEADER_FIELDS: Record<string, true> = { title: true, titleSource: true };

function headersAreOneSession(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (RENAMEABLE_HEADER_FIELDS[key]) continue;
		if (key === "version") {
			const held = typeof a.version === "number" ? a.version : 1;
			const holder = typeof b.version === "number" ? b.version : 1;
			if (holder < held) return false;
			continue;
		}
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
	}
	return true;
}

/** Opening bytes read to decide whether a file is a transcript and where its body starts. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

/**
 * Transcript semantics — reading part of a file as a session's name rather
 * than as its content — are granted only where the file's provenance is
 * known, and the one place it is known is the session transcript itself: the
 * `.jsonl.gz` the archive is named for and the `.jsonl` it came from.
 *
 * Nothing in an artifact tree qualifies, which is why no helper here decides
 * it from a path. A name does not say what wrote a file — tool output can be
 * created as `.jsonl`, copied from a `.log`, or renamed either way — and
 * neither does its shape, since a log that opens with a session-shaped
 * record is exactly the thing this guards against. Every artifact is
 * compared byte for byte, a nested subagent transcript included: one renamed
 * since it was archived stops matching and its restore is refused with the
 * archive kept, which costs a retry where granting it on a name costs the
 * unique bytes of anything named to look like one.
 */

/**
 * Whether the file open as `destination` holds every byte `source` yields.
 *
 * For an ordinary artifact that is a plain byte-for-byte prefix test: opaque
 * content has no parts anyone may skip.
 *
 * For a session transcript — a file named as one, whose opening record past
 * an optional fixed-width title slot is a session header — the name is
 * compared as a name and the conversation byte for byte. A transcript only
 * ever grows at its end, so "the destination starts with all of this" is
 * identity, and the one span that moves under a rename is the name itself:
 * the slot, which `FileSessionStorage.updateSessionTitle` rewrites in place,
 * and the header's own `title`/`titleSource`, which the legacy rewrite adds.
 * Each side is measured on its own, so a copy that gained a slot it never had
 * and a copy renamed since still read as the same session, while a different
 * `id`, `timestamp` or `cwd` reads as a different one.
 *
 * The source is drained even after a mismatch, because a caller may be feeding
 * it from a pipeline that must finish.
 */
async function sourceIsPrefixOfDestination(
	source: AsyncIterable<Uint8Array>,
	destination: fs.FileHandle,
	transcript: boolean,
): Promise<boolean> {
	const window = Buffer.allocUnsafe(64 * 1024);
	const head: Uint8Array[] = [];
	let headBytes = 0;
	let settled = false;
	let mismatch = false;
	let offset = 0;
	const destinationMatches = async (expected: Uint8Array, at: number): Promise<boolean> => {
		const { bytesRead } = await destination.read(window, 0, expected.byteLength, at);
		return bytesRead === expected.byteLength && window.subarray(0, expected.byteLength).equals(expected);
	};
	const settle = async (): Promise<boolean> => {
		settled = true;
		const buffered = Buffer.concat(head, headBytes);
		const destinationHead = Buffer.allocUnsafe(TRANSCRIPT_HEAD_BYTES);
		const { bytesRead } = await destination.read(destinationHead, 0, TRANSCRIPT_HEAD_BYTES, 0);
		const sourceTranscript = readTranscriptHead(buffered);
		const destinationTranscript = readTranscriptHead(destinationHead.subarray(0, bytesRead));
		let skip = 0;
		if (transcript && sourceTranscript && destinationTranscript) {
			if (!headersAreOneSession(sourceTranscript.header, destinationTranscript.header)) return false;
			skip = sourceTranscript.prefixBytes;
			offset = destinationTranscript.prefixBytes;
		}
		const rest = buffered.subarray(skip);
		for (let at = 0; at < rest.byteLength; at += window.byteLength) {
			const want = Math.min(window.byteLength, rest.byteLength - at);
			if (!(await destinationMatches(rest.subarray(at, at + want), offset))) return false;
			offset += want;
		}
		return true;
	};
	for await (const chunk of source) {
		if (mismatch) continue;
		if (!settled) {
			head.push(chunk);
			headBytes += chunk.byteLength;
			if (headBytes < TRANSCRIPT_HEAD_BYTES) continue;
			if (!(await settle())) mismatch = true;
			continue;
		}
		for (let at = 0; at < chunk.byteLength; at += window.byteLength) {
			const want = Math.min(window.byteLength, chunk.byteLength - at);
			if (!(await destinationMatches(chunk.subarray(at, at + want), offset))) {
				mismatch = true;
				break;
			}
			offset += want;
		}
	}
	// A source shorter than the head window never settled above.
	if (!mismatch && !settled && !(await settle())) return false;
	return !mismatch;
}

/** Newline-delimited records of a byte stream. */
async function* linesOf(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of source) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
			yield buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) yield buffer;
}

/**
 * A file's bytes read positionally, so the caller's pinned descriptor stays
 * the one being read and stays open for the next comparison — a read stream
 * over a `FileHandle` closes it when it ends.
 */
export async function* bytesOfHandle(handle: fs.FileHandle): AsyncGenerator<Uint8Array> {
	const window = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	for (;;) {
		const { bytesRead } = await handle.read(window, 0, window.byteLength, offset);
		if (bytesRead === 0) return;
		offset += bytesRead;
		yield Uint8Array.prototype.slice.call(window, 0, bytesRead);
	}
}
/** What a copy wrote: the bytes' digest and how many there were. */
export interface CopiedBytes {
	hash: string;
	size: number;
}

/**
 * Copy everything `source` holds into `destination`, digesting what is
 * written on the way through.
 *
 * The digest is the point. A copy that stats the source again afterwards is
 * asking a second time a question it already answered, and the answer can
 * have changed — on a filesystem whose timestamps have one-second resolution
 * and whose inode numbers come back round, an in-place rewrite of the same
 * length leaves size, mtime, ctime, device and inode all identical. The
 * bytes this function wrote are the bytes it hashed, and nothing that
 * happens to the source afterwards changes either.
 */
export async function copyHandleWithDigest(source: fs.FileHandle, destination: fs.FileHandle): Promise<CopiedBytes> {
	const hasher = new CryptoHasher("sha256");
	let size = 0;
	for await (const chunk of bytesOfHandle(source)) {
		hasher.update(chunk);
		for (let written = 0; written < chunk.byteLength;) {
			const { bytesWritten } = await destination.write(chunk, written, chunk.byteLength - written, size + written);
			written += bytesWritten;
		}
		size += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), size };
}

/** The digest and length of everything an open descriptor holds. */
export async function digestOfHandle(handle: fs.FileHandle): Promise<CopiedBytes> {
	const hasher = new CryptoHasher("sha256");
	let size = 0;
	for await (const chunk of bytesOfHandle(handle)) {
		hasher.update(chunk);
		size += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), size };
}
/**
 * Inflate an archived stream into `destination`, digesting what is written.
 *
 * The stream counterpart of {@link copyHandleWithDigest}, for the one place
 * that inflates rather than copies. The digest is of the bytes this run put
 * in the file, which is what the published entry is compared against
 * afterwards — a stage rebound between the write and the publication reads
 * back as something else.
 */
export async function inflateIntoHandleWithDigest(
	source: AsyncIterable<Uint8Array>,
	destination: fs.FileHandle,
): Promise<CopiedBytes> {
	const hasher = new CryptoHasher("sha256");
	let size = 0;
	await pipeline(source, createGunzip(), async (inflated: NodeJS.ReadableStream) => {
		for await (const chunk of inflated as AsyncIterable<Uint8Array>) {
			hasher.update(chunk);
			for (let written = 0; written < chunk.byteLength;) {
				const put = await destination.write(chunk, written, chunk.byteLength - written, size + written);
				written += put.bytesWritten;
			}
			size += chunk.byteLength;
		}
	});
	return { hash: hasher.digest("hex"), size };
}

/** Whether everything `prefix` holds is how `whole` begins. */
export async function handleBeginsWith(whole: fs.FileHandle, prefix: fs.FileHandle): Promise<boolean> {
	return await sourceIsPrefixOfDestination(bytesOfHandle(prefix), whole, false);
}

/**
 * Everything the regular file at `file` holds, read through a descriptor
 * {@link openRegularFile} checked — the archive's own files included, since
 * the archive is a tree like any other and anything can stand in it. ENOENT
 * when nothing is there, as a read by name gave; {@link NotARegularFile}
 * when anything but a regular file is.
 */
export async function* bytesOfRegularFile(file: string): AsyncGenerator<Uint8Array> {
	const handle = await openRegularFile(file);
	if (!handle) throw absentFile(file);
	try {
		yield* bytesOfHandle(handle);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * What {@link checkPublished} found at a publication's name: the very file
 * this run staged; something verifiably other than it; or, with
 * `unverified` saying why, nothing at all, because a look failed.
 */
export type PublicationCheck = { staged: true } | { staged: false; unverified?: string };

/**
 * Whether the entry a publication left at `destination` is the very file
 * this run staged, holding what this run wrote.
 *
 * A descriptor pins an inode, not a name, so each step answers a question
 * the others cannot. The open is non-blocking, because an ordinary open of a
 * FIFO published at that name never returns. `fstat` says the descriptor
 * holds the staged inode. `lstat` says the name holds it too: a symlink onto
 * that inode reads right through the descriptor, and so does a different
 * file put at the name after the open. `holds` reads the bytes, because an
 * in-place rewrite keeps every identity field. And the name is asked once
 * more after the read, because a file put there while the bytes were being
 * read leaves the descriptor right and the name wrong.
 *
 * The answer is about the moment of each look, and checking again does not
 * make it a fact about later. Two writers are outside it. One that can write
 * the published file itself — file-write access, a lower bar than access to
 * the directory — can rewrite bytes in place after the digest: the inode,
 * the length and the name all stay what they were, so a corrupt archive or
 * transcript is reported as published. One that can write the destination's
 * directory can rebind the name after the last look. What this rules out is
 * reporting a publication whose name, when this run last looked, held
 * somebody else's file, or whose bytes, when this run read them, were not
 * what it wrote.
 *
 * Anything short of staged leaves a caller to withdraw or put back what it
 * published, so a look that fails is never taken for staged. Nor is it taken
 * for something else standing there: it comes back `unverified`, and the
 * caller says the publication could not be checked — see
 * {@link notStagedMessage} — rather than that the name holds another file.
 */
export async function checkPublished(
	destination: string,
	staged: Stats,
	holds: (published: fs.FileHandle) => Promise<boolean>,
): Promise<PublicationCheck> {
	const isStaged = (entry: Stats | undefined): boolean =>
		entry?.isFile() === true && entry.dev === staged.dev && entry.ino === staged.ino;
	const named = async (): Promise<Stats | undefined> =>
		await fs.lstat(destination).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
	const other: PublicationCheck = { staged: false };
	try {
		// Anything but a regular file at the name is verifiably not the staged file.
		const published = await openRegularFile(destination).catch(notRegularAsAbsent);
		if (!published) return other;
		try {
			if (!isStaged(await published.stat())) return other;
			if (!isStaged(await named())) return other;
			if (!(await holds(published))) return other;
		} finally {
			await published.close().catch(() => undefined);
		}
		return isStaged(await named()) ? { staged: true } : other;
	} catch (error) {
		return { staged: false, unverified: errorText(error) };
	}
}

/**
 * What a caller says when {@link checkPublished} did not find its file
 * staged: that `subject` is not `is` ("the transcript this restore wrote"),
 * or, when a look failed, that whether it is could not be checked, and why.
 */
export function notStagedMessage(subject: string, is: string, check: { unverified?: string }): string {
	return check.unverified === undefined
		? `${subject} is not ${is}`
		: `whether ${subject} is ${is} could not be checked (${check.unverified})`;
}

/** A `holds` for {@link checkPublished}: exactly the bytes a copy wrote. */
export function holdsCopied(written: CopiedBytes): (published: fs.FileHandle) => Promise<boolean> {
	return async published => {
		const back = await digestOfHandle(published);
		return back.hash === written.hash && back.size === written.size;
	};
}

/** The same, split into newline-delimited records. */
async function* linesOfHandle(handle: fs.FileHandle): AsyncGenerator<string> {
	yield* linesOf(bytesOfHandle(handle));
}

/** Whether every field of `held` appears in `holder` with the same value. */
function jsonContains(held: unknown, holder: unknown): boolean {
	if (held === null || typeof held !== "object") return held === holder;
	if (holder === null || typeof holder !== "object") return false;
	if (Array.isArray(held)) {
		return (
			Array.isArray(holder) &&
			held.length === holder.length &&
			held.every((item, at) => jsonContains(item, holder[at]))
		);
	}
	if (Array.isArray(holder)) return false;
	const inner = holder as Record<string, unknown>;
	return Object.entries(held as Record<string, unknown>).every(([key, value]) => jsonContains(value, inner[key]));
}

/**
 * The entry tree `migrateV1ToV2` builds for a transcript that never had one.
 *
 * A genuine version 1 transcript has no entry names at all, so there is
 * nothing on the archived side to map from. What the migration does is
 * positional: every non-session record gets a fresh `id`, its `parentId` is
 * the record immediately before it — null for the first — and a compaction's
 * `firstKeptEntryIndex` becomes the `firstKeptEntryId` of the entry at that
 * index, counting the session header as entry zero.
 *
 * So the relations are rebuilt here the same way and compared against what
 * the live file says. The names themselves are not compared, because the
 * migration chose them; the structure they describe is, because that is the
 * conversation's branch and compaction shape. Exempting the fields outright
 * would let a reparented or re-targeted history read as the same session,
 * and the context rebuilt from it would be a different conversation.
 */
class MigratedEntryTree {
	/** Live entry names by entry index, the session header being entry zero. */
	readonly #liveIdByEntry: (string | undefined)[] = [];
	/** Names already in use, because a name the migration assigns names one entry. */
	readonly #used = new Set<string>();
	#ambiguous = false;

	/** Record the live name of the entry at `entry`, the header being entry zero. */
	note(entry: number, live: Record<string, unknown>): void {
		// Only a usable name is recorded. An entry whose name is missing or
		// empty names nothing, and treating it as a name would let a history
		// whose relations point at nothing compare as one the migration built.
		const id = typeof live.id === "string" && live.id !== "" ? live.id : undefined;
		// A name already naming an earlier entry names neither: the migration
		// gives each entry its own, and a history where one entry stands in for
		// another rebuilds as a different conversation.
		if (id !== undefined) {
			if (this.#used.has(id)) this.#ambiguous = true;
			this.#used.add(id);
		}
		this.#liveIdByEntry[entry] = id;
	}

	/** Whether the live record stands where the migration would have put it. */
	holdsRelations(archived: Record<string, unknown>, live: Record<string, unknown>, entry: number): boolean {
		if (this.#ambiguous) return false;
		if (typeof live.id !== "string" || live.id === "") return false;
		// The record before this one, or nothing when this is the first.
		const expectedParent = entry > 1 ? this.#liveIdByEntry[entry - 1] : null;
		const liveParent = live.parentId === undefined ? null : live.parentId;
		if (liveParent !== expectedParent) return false;
		const index = archived.firstKeptEntryIndex;
		if (index === undefined && archived.firstKeptEntryId === undefined) {
			return live.firstKeptEntryId === undefined;
		}
		if (typeof index !== "number") return false;
		return live.firstKeptEntryId === this.#liveIdByEntry[index];
	}
}

/** Names the v1 migration assigns; their meaning is checked by {@link MigratedEntryTree}. */
const MIGRATED_RECORD_FIELDS: Record<string, true> = {
	id: true,
	parentId: true,
	firstKeptEntryIndex: true,
	firstKeptEntryId: true,
};

/** Whether `holder` carries `held`, allowing for the migrations `version` has since been through. */
function recordIsCarried(
	held: unknown,
	holder: unknown,
	version: number,
	tree: MigratedEntryTree,
	entry: number,
): boolean {
	if (typeof held !== "object" || held === null || Array.isArray(held)) return jsonContains(held, holder);
	if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return false;
	const a = held as Record<string, unknown>;
	const b = holder as Record<string, unknown>;
	if (version < 2 && !tree.holdsRelations(a, b, entry)) return false;
	for (const [key, value] of Object.entries(a)) {
		if (version < 2 && MIGRATED_RECORD_FIELDS[key]) continue;
		// `migrateV2ToV3` renames the `hookMessage` role to `custom`.
		if (version < 3 && key === "message") {
			const held = value as Record<string, unknown> | null;
			const holder = b.message as Record<string, unknown> | null;
			if (held && holder && held.role === "hookMessage" && holder.role === "custom") {
				if (!jsonContains({ ...held, role: "custom" }, holder)) return false;
				continue;
			}
		}
		if (!jsonContains(value, b[key])) return false;
	}
	return true;
}

/** Next record of a transcript, parsed when it parses. */
async function nextRecord(lines: AsyncGenerator<string>): Promise<{ raw: string; value: unknown } | undefined> {
	const next = await lines.next();
	if (next.done) return undefined;
	try {
		return { raw: next.value, value: JSON.parse(next.value) as unknown };
	} catch {
		return { raw: next.value, value: undefined };
	}
}

/**
 * The session header a transcript opens with, past the fixed-width title slot
 * when it carries one, or undefined when this is not a transcript at all.
 *
 * The slot is recognised only at the very start and only at its physical
 * width, the same contract {@link titleSlotWidth} enforces on the byte path.
 * Nothing else is passed over: an artifact whose lines happen to look like
 * title records is not a transcript, and must not be able to compare as one.
 */
async function openingHeader(lines: AsyncGenerator<string>): Promise<Record<string, unknown> | undefined> {
	let first = await nextRecord(lines);
	if (
		first &&
		Buffer.byteLength(first.raw, "utf8") === SESSION_TITLE_SLOT_BYTES - 1 &&
		parseTitleSlotLine(first.raw)
	) {
		first = await nextRecord(lines);
	}
	const header = first?.value;
	if (typeof header !== "object" || header === null || Array.isArray(header)) return undefined;
	const record = header as Record<string, unknown>;
	if (record.type !== "session" || typeof record.id !== "string") return undefined;
	return record;
}

/**
 * Whether the live transcript carries every record the archived one holds,
 * record by record rather than byte by byte.
 *
 * This is the slower answer to the same question {@link
 * sourceIsPrefixOfDestination} asks, and it is only asked when that one says
 * no. The writer does not only append: opening a transcript written by an
 * older version migrates it, which re-serialises its records, fills in fields
 * the older writer left out and raises the header's version — the archived
 * bytes are then no longer a prefix of a file that still holds every one of
 * their records.
 *
 * Both sides must be transcripts, proved the same way the byte path proves
 * it, or the answer is no: opaque content has no records anyone may read past.
 *
 * Containment, not equality: each archived record must appear at its own
 * place in the live transcript with every field it had, unchanged. A record
 * the live side has filled out still carries the archived one; a record whose
 * content was pruned, replaced or reordered does not, which is how a
 * rewritten history stays a different session.
 */
async function recordsAreCarried(archived: AsyncGenerator<string>, live: AsyncGenerator<string>): Promise<boolean> {
	const held = await openingHeader(archived);
	const holder = await openingHeader(live);
	if (!held || !holder || !headersAreOneSession(held, holder)) return false;
	const version = typeof held.version === "number" ? held.version : 1;
	const tree = new MigratedEntryTree();
	// Entry zero is the session header; the records follow it.
	for (let entry = 1; ; entry += 1) {
		const next = await nextRecord(archived);
		if (!next) return true;
		const onto = await nextRecord(live);
		if (!onto) return false;
		const a = next.value;
		const b = onto.value;
		if (typeof b === "object" && b !== null && !Array.isArray(b)) {
			tree.note(entry, b as Record<string, unknown>);
		}
		if (version >= 2 && next.raw === onto.raw) continue;
		if (a === undefined || b === undefined) return false;
		if (!recordIsCarried(a, b, version, tree, entry)) return false;
	}
}

/** Whether `target` is `root` or lies below it, both already real paths. */
function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether `destination` is a copy that survives `archiveRoot` being deleted.
 *
 * Two separate things have to hold, and a link count says neither of them.
 * The directory entry must lie outside the tree being removed — two archived
 * names hard-linked to one inode, with live names that are symlinks to them,
 * have `nlink` 2 and no entry at all once the tree goes. And the entry must
 * not be the archived file itself under another mount: a bind mount gives it
 * a path whose string is outside the tree while `dev`/`ino` say it is the
 * same file. A same-inode candidate is refused outright; the archive is kept
 * and the operator is told, which costs a retry where a wrong answer costs
 * the session.
 */
async function survivesRemovalOf(destination: string, destinationStat: Stats, source: Stats, archiveRoot: string) {
	const real = await fs.realpath(destination).catch((error: unknown) => {
		// Gone since it was opened: not a copy that survives anything.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (real === undefined || isWithin(archiveRoot, real)) return false;
	return !(destinationStat.dev === source.dev && destinationStat.ino === source.ino);
}

/**
 * Prove the live tree holds every archived entry, one entry at a time.
 *
 * Nothing is deleted here, and nothing a restore does deletes an archived
 * entry at all. Eleven review rounds found the same shape every time: the
 * proof and the delete are two operations, nothing in this process can hold
 * a subagent out between them, and no number of passes turns that into a
 * guarantee. So the restore copies and leaves the archive where it is. The
 * archive phase is the one step that gives a copy up, and an operator
 * invokes it by name, acknowledges what it does and sees what it refuses.
 *
 * What this still earns: an artifact the live tree does not hold is named,
 * so a restore that could not finish says which path is in the way instead
 * of reporting success.
 */
async function assertLiveTreeHoldsArchive(
	source: string,
	destination: string,
	archiveRoot: string,
	isResidue: (entry: string) => boolean,
): Promise<void> {
	const stat = await fs.lstat(source).catch(error => {
		// Only absence. An I/O error says nothing about what is there, and
		// reading it as "nothing" is how a file nobody could stat is passed
		// over as already carried.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	// A staging directory a run recorded and could not clear is residue, not
	// an artifact, and was never carried home. Nothing else is skipped for
	// its name: see {@link stagingLedgerDir}.
	if (!stat || isResidue(source)) return;
	if (stat.isDirectory()) {
		const live = await statIfPresent(destination);
		if (!live?.isDirectory()) {
			throw new Error(`${destination} is not a directory holding what ${source} holds`);
		}
		if (live.dev === stat.dev && live.ino === stat.ino) {
			throw new Error(`${destination} is the archived directory ${source} itself, not a copy of it`);
		}
		for (const entry of (await fs.readdir(source)).sort()) {
			await assertLiveTreeHoldsArchive(
				path.join(source, entry),
				path.join(destination, entry),
				archiveRoot,
				isResidue,
			);
		}
		return;
	}
	// A link or a device: neither was carried home, and neither is an artifact.
	if (!stat.isFile()) return;
	// What stands at the live name, if not a regular file, does not hold it.
	const live = await openRegularFile(destination).catch(notRegularAsAbsent);
	try {
		const liveStat = await live?.stat();
		if (!live || !liveStat?.isFile()) {
			throw new Error(`${destination} does not hold what the archived ${source} holds`);
		}
		if (!(await survivesRemovalOf(destination, liveStat, stat, archiveRoot))) {
			throw new Error(`${destination} is the archived ${source} itself, not a second copy of it`);
		}
		if (!(await sourceIsPrefixOfDestination(bytesOfRegularFile(source), live, false))) {
			throw new Error(`${destination} does not hold what the archived ${source} holds`);
		}
	} finally {
		await live?.close();
	}
}

/**
 * Copy one entry out of the archive, resolving symlinks into real files.
 *
 * Each file is staged in a directory this run mints beside its destination
 * and linked into place, so a killed restore never leaves a partial file at
 * a real path — if it did, the retry below would take that partial for a
 * finished one and skip it.
 *
 * An entry the live tree already holds with the archive's own bytes is left
 * alone: that is an entry an interrupted attempt of this restore already
 * carried home. Anything else standing at the destination — a different file
 * of the same name, a dangling link, a directory where the archive holds a
 * file — is reported, and the archive keeps its copy.
 *
 * A destination that is the archived entry itself under another name, or that
 * would not survive the archive tree being removed, is reported too — see
 * {@link survivesRemovalOf}. An unreadable destination is reported as well: a
 * permission or I/O failure says nothing about what is there, and only its
 * absence may be read as an empty slot.
 *
 * A staging directory a run recorded and could not clear is residue, not an
 * artifact, and is not carried home: copying it would publish a partial or
 * foreign file into the live tree as if the session had written it. Whether
 * an entry is one is the ledger's answer, not its name's — see
 * {@link stagingLedgerDir}.
 */
async function copyEntryDereferenced(
	source: string,
	destination: string,
	archiveRoot: string,
	ledger: string,
	notes: string[],
	isResidue: (entry: string) => boolean,
	special: string[],
): Promise<void> {
	const stat = await fs.stat(source).catch(error => {
		// A link whose target is gone: nothing to carry, nothing to lose.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat || isResidue(source)) return;
	// Only absence is an empty slot: a look that fails says nothing about
	// what is there, and a directory taken for new would be given the
	// archive's mode.
	const existing = await fs.lstat(destination).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (stat.isDirectory()) {
		// Through the link: a symlinked artifact directory is a directory the
		// restore may merge into, the same way the archive phase walks one.
		const live = existing ? await statIfPresent(destination) : undefined;
		if (existing && !live?.isDirectory()) {
			throw new Error(`${destination} is not a directory, so ${source} cannot be restored into it`);
		}
		if (live && live.dev === stat.dev && live.ino === stat.ino) {
			throw new Error(
				`${destination} is the archived directory ${source} itself, not a second copy of it; ` +
					`the archive is kept — give the live tree a directory of its own and restore again`,
			);
		}
		await fs.mkdir(destination, { recursive: true });
		// Only a directory this restore created takes the archived mode: `mkdir`
		// applies the umask, so a tree deliberately tightened below it would
		// otherwise come back readable to more than it was. A directory the live
		// tree already holds keeps its own permissions — merging an archive into
		// a private `0700` directory must not widen it to the archive's mode.
		if (!existing) await chmodDirectory(destination, stat.mode & 0o7777);
		// Sorted, so a restore that stops part-way is reproducible from its report.
		for (const entry of (await fs.readdir(source)).sort()) {
			await copyEntryDereferenced(
				path.join(source, entry),
				path.join(destination, entry),
				archiveRoot,
				ledger,
				notes,
				isResidue,
				special,
			);
		}
		return;
	}
	if (!stat.isFile()) {
		special.push(await archivedSpecialEntry(source, stat));
		return;
	}
	if (existing) {
		// Anything but a regular file at the name already holds something else.
		const live = await openRegularFile(destination).catch(notRegularAsAbsent);
		try {
			if (live) {
				const target = await live.stat();
				if (!(await survivesRemovalOf(destination, target, stat, archiveRoot))) {
					throw new Error(
						`${destination} is the archived ${source} itself, not a second copy of it; ` +
							`the archive is kept — give the live tree a file of its own and restore again`,
					);
				}
				if (await sourceIsPrefixOfDestination(bytesOfRegularFile(source), live, false)) return;
			}
		} finally {
			await live?.close();
		}
		throw new Error(
			`${destination} already holds something else, so the archived ${source} was left in the archive; ` +
				`move that path aside and restore again`,
		);
	}
	// Staged in a directory this run mints and records, so the stage is a
	// file of this run's own making, and a later restore leaves it out of the
	// live tree if this run is killed before removing it.
	const ground = await mintStagingGround(destination, ledger, stat.mode & 0o7777);
	try {
		const archived = await openRegularFile(source);
		if (!archived) throw absentFile(source);
		let written: CopiedBytes;
		try {
			written = await copyHandleWithDigest(archived, ground.handle);
		} finally {
			await archived.close().catch(() => undefined);
		}
		await ground.handle.chmod(stat.mode & 0o7777);
		// `link`, not `rename`: a file someone created at the destination while
		// this copy was being staged is their work, and a rename would write
		// over it without anyone asking. `EEXIST` sends this entry down the
		// "already holds something else" road on the next attempt instead.
		await fs.link(ground.file, destination);
		const check = await checkPublished(destination, ground.created, holdsCopied(written));
		if (!check.staged) {
			throw new Error(
				`${notStagedMessage(destination, `the copy of ${source} this restore wrote`, check)}, so it was left as it is`,
			);
		}
	} finally {
		try {
			const note = await removeStagingGround(ground);
			if (note) notes.push(note);
		} finally {
			await ground.handle.close().catch(() => undefined);
		}
	}
}

/**
 * Bring an archived artifact tree home and leave the archive where it is.
 *
 * A restore publishes; it does not reclaim. Giving a copy up needs a proof
 * that holds from the moment it is taken to the moment the bytes go, and
 * there is no way here to hold a subagent out of the tree across those two
 * operations — which is what every round of review found, in a different
 * place each time. So the session ends up in two places, and
 * `omp gc --reclaim`, which an operator runs by name on one session and
 * acknowledges, is the only thing that takes the live copy away.
 */
async function copyTreeDereferenced(
	source: string,
	destination: string,
	agentDir: string,
	notes: string[],
): Promise<{ leftOut: Array<[string, string]>; special: string[] }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const archiveRoot = await fs.realpath(source);
	const recorded = await stagingResidueUnder(agentDir, source);
	// What was left out, and the record that named it, so the caller can say
	// where it still is and how to move it.
	const leftOut = new Map<string, string>();
	const isResidue = (entry: string): boolean => {
		const record = recorded(entry);
		if (record === undefined) return false;
		leftOut.set(entry, record);
		return true;
	};
	const special: string[] = [];
	const ledger = stagingLedgerDir(agentDir);
	await copyEntryDereferenced(source, destination, archiveRoot, ledger, notes, isResidue, special);
	await assertLiveTreeHoldsArchive(source, destination, archiveRoot, isResidue);
	return { leftOut: [...leftOut], special };
}

/**
 * What a FIFO, a socket or a device found in the archived tree is, itself or
 * at the end of a link, in the words a restore's message starts with: gc
 * never archives one, so a person put it there. It is not read — reading a
 * FIFO waits on it, or takes what was written to it — and not carried home;
 * the caller says what that leaves to do.
 */
async function archivedSpecialEntry(entry: string, stat: Stats): Promise<string> {
	const named = await fs.lstat(entry);
	return (
		`${entry} ${named.isSymbolicLink() ? "links to" : "is"} ${kindOf(stat)} in the archive, which a restore cannot ` +
		`carry home`
	);
}

/**
 * `<agentDir>/gc-staging`, where a run records each staging directory it
 * mints — one file per directory — before it makes the directory.
 *
 * Every run that mints holds `<agentDir>/gc.lock` for its whole life, so a
 * record still standing while the lock is held belongs to a run that is
 * gone. A record may make a restore leave the directory it names out of the
 * live tree; it never makes anything be removed — a record is a file
 * anybody running as this user could have written. A run removes only the
 * staging directories it made itself, known in memory while it runs. So a
 * killed run's residue stays until someone removes it by hand. Anything
 * with a staging-looking name and no record is somebody's file and is
 * treated like any other — the shape of a name proves nothing about who
 * made it. The ledger directory itself is this feature's alone.
 */
export function stagingLedgerDir(agentDir: string): string {
	return path.join(agentDir, "gc-staging");
}

/**
 * What a run records about one staging directory it minted. Written first
 * with only the names, before the directory exists, and replaced once the
 * directory and its file exist with both their identities.
 */
interface StagingRecord {
	dir: string;
	file: string;
	/** The minted directory's identity; absent while the run had not yet made it. */
	dirIdentity?: { dev: number; ino: number };
	/** The staged file's identity; absent while the run had not yet created it. */
	identity?: { dev: number; ino: number };
}

/** A private directory this run minted, the file it stages into there, and its record. */
export interface StagingGround {
	dir: string;
	file: string;
	/** The staged file, open for reading and writing. The caller closes it. */
	handle: fs.FileHandle;
	/** The staged file's identity, from the descriptor that created it. */
	created: Stats;
	/** This directory's record in {@link stagingLedgerDir}. */
	record: string;
	/**
	 * The record, held: the descriptor that wrote it, open until
	 * {@link removeStagingGround} has removed it or given it up, and the
	 * bytes it wrote, a random value among them. What this run removes the
	 * record by — see {@link removeFileNoOneElseWrites} — since neither its name nor its
	 * inode number is proof the file there is still the one this run wrote.
	 */
	recordHeld: HeldFile;
}

/**
 * Names tried before minting gives up. A name taken this many times in a row
 * is not a collision a fresh id fixes, and a run that kept trying would
 * never finish.
 */
const STAGING_MINT_ATTEMPTS = 16;

/** Suffix of a record's replacement while it is being written; never read as a record. */
const STAGING_RECORD_PART = ".part";

/**
 * Refuse a ledger anybody but this user can write. A record is only as
 * trustworthy as the directory it sits in: one other users can write is a
 * place they can put records, and a record that has once been writable by
 * someone else stays suspect after a `chmod`, so this refuses rather than
 * repairing.
 */
async function assertPrivateLedger(ledger: string): Promise<void> {
	const standing = await fs.lstat(ledger);
	const uid = process.getuid?.();
	const shared = process.platform !== "win32" && (standing.mode & 0o077) !== 0;
	if (!standing.isDirectory() || (uid !== undefined && standing.uid !== uid) || shared) {
		throw new Error(
			`${ledger} is not a private directory owned by this user, so no staging record in it can be trusted ` +
				`and nothing was staged; look at what is in it and remove it, then run again`,
		);
	}
}

/**
 * Mint a staging directory of this run's own beside `target`, create the
 * file to stage into inside it, and record both in `ledger`.
 *
 * The record goes down first, naming the directory and file this attempt is
 * about to make; then the directory is made with `mkdir` without
 * `recursive`, so `EEXIST` is the kernel saying the name is taken and
 * another is minted, up to {@link STAGING_MINT_ATTEMPTS} times; then the
 * file is created, and a second record, with the directory's and the
 * file's identities, is linked in at a fresh name before the first is
 * removed. So, while the machine stays up, there is no moment at which this
 * run has made something the ledger does not name, and a later restore
 * leaves whatever a killed run left out of the live tree; a run killed
 * between the two leaves both records, naming the same directory. Nothing
 * here writes over a name: every record is created afresh or linked in,
 * where a name already taken fails with `EEXIST`, and only the files this
 * attempt wrote are removed — see {@link removeFileNoOneElseWrites}. A `rename` onto the
 * record's name would replace whatever stood there by then. Nothing here is
 * synced, so after a power loss the directory can outlive its record; it is
 * then indistinguishable from an artifact and is treated as one.
 *
 * Mode `0700`, so nothing without this user's rights puts a file inside.
 * What the directory is not: a boundary against a process that can write
 * the directory it sits in. Such a process can rename the minted directory
 * away and put one of its own at the name, and every later step here names
 * a path — there is no system call that unlinks an inode — so it then acts
 * on whatever stands there. The identity checks narrow what that can do;
 * they do not take it away.
 */
export async function mintStagingGround(target: string, ledger: string, mode = 0o666): Promise<StagingGround> {
	await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
	await assertPrivateLedger(ledger);
	for (let attempt = 0; attempt < STAGING_MINT_ATTEMPTS; attempt++) {
		const dir = sessionStagingPath(target);
		const file = path.join(dir, path.basename(target));
		const record = path.join(ledger, `${Snowflake.next()}.json`);
		const part = `${record}${STAGING_RECORD_PART}`;
		// A random value in every version this run writes: a file put at the
		// record's name by anyone who did not read this one cannot hold it.
		const intent: StagingRecord & { nonce: string } = { dir, file, nonce: newNonce() };
		// Written whole under the part name, then linked into place: a run
		// killed during the write leaves a part, which no run reads as a
		// record, never a record cut short — which no run could tell from a
		// damaged one. Created afresh, and `link` refuses a name already
		// taken: either way EEXIST, and whatever holds the name is kept.
		let written: HeldFile[];
		try {
			written = [await writeExclusive(part, JSON.stringify(intent), 0o600)];
		} catch (error) {
			if (codeOf(error) !== "EEXIST") throw error;
			throw new Error(`${errorText(error)}; ${part} is not a record this run wrote, so it was left as it is`, {
				cause: error,
			});
		}
		// Every descriptor this attempt holds, closed once what it wrote is
		// removed or handed on — never before, so no other file can take
		// those inode numbers while this run still decides by them.
		const release = async (keep?: HeldFile): Promise<void> => {
			for (const held of written) if (held !== keep) await held.handle.close().catch(() => undefined);
		};
		// What this attempt wrote to the ledger, and only that, by the
		// identities it captured: at any of its names, anything else is kept
		// and named — whatever it is called, it is not this run's to remove.
		const names = [part, record];
		const unrecord = async (): Promise<string[]> => {
			const notes: string[] = [];
			for (const at of names) {
				const note = await removeFileNoOneElseWrites(at, written, "a record this run wrote");
				if (note) notes.push(note);
			}
			return notes;
		};
		// The failure, with what was left behind; what the failure already
		// says is not said twice.
		const failed = (error: unknown, notes: string[]): unknown => {
			const message = error instanceof Error ? error.message : String(error);
			const more = notes.filter(note => !message.includes(note));
			return more.length > 0 ? new Error(`${message}; ${more.join("; ")}`, { cause: error }) : error;
		};
		try {
			await fs.link(part, record);
			// The part name goes; the record keeps the file under its own name.
			const left = await removeFileNoOneElseWrites(part, written, "a record this run wrote");
			if (left) throw new Error(left);
		} catch (error) {
			const notes = await unrecord();
			await release();
			throw failed(error, notes);
		}
		try {
			await fs.mkdir(dir, { mode: 0o700 });
		} catch (error) {
			const notes = await unrecord();
			await release();
			if (notes.length > 0) throw failed(error, notes);
			if (codeOf(error) === "EEXIST") continue;
			throw error;
		}
		let handle: fs.FileHandle | undefined;
		let created: Stats | undefined;
		try {
			const minted = await fs.lstat(dir);
			handle = await createExclusive(file, mode, true);
			created = await handle.stat();
			const recorded: StagingRecord = {
				...intent,
				dirIdentity: { dev: minted.dev, ino: minted.ino },
				identity: { dev: created.dev, ino: created.ino },
			};
			// The same way as the first: written whole under a part name of
			// its own and linked in at a fresh record name, so neither is
			// written over; then the first goes, only while it is still the
			// file this run wrote. The directory is named by one record or
			// both throughout.
			const complete = path.join(ledger, `${Snowflake.next()}.json`);
			const completePart = `${complete}${STAGING_RECORD_PART}`;
			names.push(completePart, complete);
			const recordHeld = await writeExclusive(completePart, JSON.stringify(recorded), 0o600);
			written.push(recordHeld);
			await fs.link(completePart, complete);
			for (const at of [completePart, record]) {
				const left = await removeFileNoOneElseWrites(at, written, "a record this run wrote");
				if (left) throw new Error(left);
			}
			// Only the second record's descriptor goes on with the ground.
			await release(recordHeld);
			return { dir, file, handle, created, record: complete, recordHeld };
		} catch (error) {
			// What this attempt made goes again before the failure is
			// reported, and the record goes with it only once nothing it
			// names is left: a directory nothing records is a directory a
			// restore would carry home as somebody's artifact. The staged
			// file is removed while its descriptor is still held, and only
			// then closed: a file it did not get to create is not its to
			// remove.
			const note = await clearStagingGround(dir, file, created, "this run");
			await handle?.close().catch(() => undefined);
			if (note) {
				await release();
				throw failed(error, [note]);
			}
			const ledgerNotes = await unrecord();
			await release();
			throw failed(error, ledgerNotes);
		}
	}
	throw new Error(
		`no staging directory could be made beside ${target}: ${STAGING_MINT_ATTEMPTS} names in a row were already taken`,
	);
}

/**
 * Take away a staging directory this run made, with the one file this run
 * staged in it — while that file is still the regular file whose identity
 * this run holds in memory — and nothing else. `staged` undefined means
 * this run never created the file, so nothing inside is its to remove.
 *
 * Only the run that minted a directory calls this. A later run has a record
 * at most, and a record is a file anybody running as this user could have
 * written, naming a directory with a name, a place and an inode anybody
 * could arrange; none of that says a run made it, so no record removes
 * anything.
 *
 * Anything else inside is reported rather than deleted, and a failure to
 * look is reported rather than read as an absence: "it was not there" and "I
 * could not tell" are different answers, and treating the second as the
 * first is how a foreign file disappears into an empty error list. Nothing
 * here throws, because this runs on the way out of a failure as often as a
 * success.
 */
async function clearStagingGround(
	dir: string,
	file: string,
	staged: { dev: number; ino: number } | undefined,
	stager: string,
): Promise<string | undefined> {
	const notes: string[] = [];
	const entries = await fs.readdir(dir).catch(error => {
		if (isEnoent(error)) return undefined;
		notes.push(`${dir} could not be read, so it was left as it is: ${error}`);
		return undefined;
	});
	if (entries === undefined) return notes[0];
	for (const name of entries) {
		const at = path.join(dir, name);
		const standing = await fs.lstat(at).catch(error => {
			if (!isEnoent(error)) notes.push(`${at} could not be read, so it was left alone: ${error}`);
			return undefined;
		});
		if (!standing) continue;
		const ours =
			staged !== undefined &&
			at === file &&
			standing.isFile() &&
			standing.dev === staged.dev &&
			standing.ino === staged.ino;
		if (!ours) {
			notes.push(`${at} is not what ${stager} staged there, so it was left alone`);
			continue;
		}
		await fs.rm(at).catch((error: unknown) => notes.push(`${at} could not be removed: ${error}`));
	}
	if (notes.length === 0) {
		await fs.rmdir(dir).catch((error: unknown) => {
			if (!isEnoent(error)) notes.push(`${dir} could not be removed: ${error}`);
		});
	}
	return notes.length > 0 ? notes.join("; ") : undefined;
}

/**
 * Take this run's staging directory away again, with what this run staged
 * there, and its record with it — the record by the identity this run
 * captured when it wrote it, so a file put at that name since is kept and
 * named. A directory that cannot be taken away keeps its record, so later
 * restores leave it out of the live tree. The sentence returned is the one
 * for the command to print.
 */
export async function removeStagingGround(ground: StagingGround): Promise<string | undefined> {
	try {
		const note = await clearStagingGround(ground.dir, ground.file, ground.created, "this run");
		if (note !== undefined) return note;
		return await removeFileNoOneElseWrites(ground.record, [ground.recordHeld], "the record this run wrote");
	} finally {
		await ground.recordHeld.handle.close().catch(() => undefined);
	}
}

/** What {@link surveyRecordedStagingGrounds} found. */
export interface StagingSurvey {
	/** Recorded staging directories still standing, left by runs that are gone. */
	residue: string[];
	/**
	 * Records whose directory is gone: kept, since no run removes what it did
	 * not make, and harmless, since they narrow nothing a restore does —
	 * but they pile up, one per staging directory that left its tree, so
	 * they are named, each to be moved out with `gc --quarantine`.
	 */
	withoutDirectory: string[];
	notes: string[];
}

/**
 * A ledger file that is not JSON at all: cut short. The first version of a
 * record goes to a part name and is linked whole into place, so no run of
 * this version leaves one; an earlier one killed while it wrote a record's
 * first version did, before it made any staging directory.
 */
class CutShortRecord extends Error {}

/** A ledger file that holds JSON, but not what a gc run writes as a record. */
class NotAStagingRecord extends Error {
	constructor() {
		super("not a staging record");
	}
}

/**
 * What to say of a ledger file that could not be taken for a record, the
 * same in every command that meets it — the quarantine of it included,
 * since no run of this feature wrote it to be moved. One cut short or one
 * that is not what a run writes gets the way out: move it out of the
 * ledger; for the second, which may name something, with what that costs
 * if it names a staging directory.
 */
function unreadableRecordNote(record: string, ledger: string, error: unknown): string {
	if (error instanceof CutShortRecord) {
		return (
			`${record} does not hold a staging record (${error.message}). A gc run of an earlier version killed while ` +
			`it wrote a record leaves one cut short like this, and made no staging directory before it; look at it, ` +
			`move it out of ${ledger}, and run the same command again`
		);
	}
	if (error instanceof NotAStagingRecord) {
		return (
			`${record} does not hold a staging record: it is JSON, but not what a gc run writes. Look at it, move it ` +
			`out of ${ledger}, and run the same command again. If it names a staging directory that is still in a ` +
			`session tree, ${UNRECORDED_STAGE_WARNING}`
		);
	}
	return `${record} could not be read: ${errorText(error)}`;
}

function parseIdentity(value: unknown): { dev: number; ino: number } | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "object" ||
		value === null ||
		!("dev" in value && Number.isSafeInteger(value.dev) && (value.dev as number) >= 0) ||
		!("ino" in value && Number.isSafeInteger(value.ino) && (value.ino as number) >= 0)
	) {
		throw new NotAStagingRecord();
	}
	return { dev: value.dev as number, ino: value.ino as number };
}

function parseStagingRecord(text: string): StagingRecord {
	let entry: unknown;
	try {
		entry = JSON.parse(text);
	} catch (error) {
		throw new CutShortRecord(errorText(error), { cause: error });
	}
	if (
		typeof entry !== "object" ||
		entry === null ||
		!("dir" in entry && typeof entry.dir === "string") ||
		!("file" in entry && typeof entry.file === "string") ||
		// A run records the absolute paths it made; a relative one would be
		// read against whatever directory the reader happens to run in.
		!path.isAbsolute(entry.dir) ||
		!path.isAbsolute(entry.file)
	) {
		throw new NotAStagingRecord();
	}
	const dirIdentity = parseIdentity("dirIdentity" in entry ? entry.dirIdentity : undefined);
	const identity = parseIdentity("identity" in entry ? entry.identity : undefined);
	// A run writes the names first and then both identities at once, so a
	// record holding one identity without the other is not one a run wrote.
	if ((dirIdentity === undefined) !== (identity === undefined)) throw new NotAStagingRecord();
	return { dir: entry.dir, file: entry.file, dirIdentity, identity };
}

/**
 * Every record in the agent directory's ledger with its path. A ledger that
 * cannot be read, is not private, or holds a record that cannot be parsed
 * comes back as `failure`: what such a record named can no longer be told
 * apart from an artifact, so a caller that would act on the difference has
 * to stop rather than guess. A name ending in {@link STAGING_RECORD_PART} is
 * never read as a record, and nothing here or in any later run removes it:
 * a replacement a killed run left and a file somebody else put there look
 * alike, and a suffix is no proof which it is.
 */
async function readStagingRecords(
	agentDir: string,
): Promise<{ records: { path: string; entry: StagingRecord }[]; failure?: string }> {
	const ledger = stagingLedgerDir(agentDir);
	const found = { records: [] as { path: string; entry: StagingRecord }[] };
	let names: string[];
	try {
		names = await fs.readdir(ledger);
		await assertPrivateLedger(ledger);
	} catch (error) {
		if (isEnoent(error)) return found;
		return { ...found, failure: `${ledger} could not be read: ${errorText(error)}` };
	}
	for (const name of names.sort()) {
		const record = path.join(ledger, name);
		if (name.endsWith(STAGING_RECORD_PART)) continue;
		try {
			// Regular files only, through a descriptor: a FIFO among the
			// records refuses, rather than being waited on or drained.
			const handle = await openRegularFile(record);
			if (!handle) throw absentFile(record);
			let text: string;
			try {
				text = await handle.readFile("utf8");
			} finally {
				await handle.close().catch(() => undefined);
			}
			found.records.push({ path: record, entry: parseStagingRecord(text) });
		} catch (error) {
			return { ...found, failure: unreadableRecordNote(record, ledger, error) };
		}
	}
	return found;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a record turns out to name, once checked against what is on disk. */
type RecordedGround =
	/** The directory the run minted, still there with the identity it recorded. */
	| { kind: "minted" }
	/** A record written before the run made its directory, which is there. */
	| { kind: "intent" }
	/** Nothing of that run's stands at the name any more. */
	| { kind: "gone"; note?: string }
	/** A record no run of this feature could have written. */
	| { kind: "refused"; note: string }
	/**
	 * What the record names could not be looked at, so whether it is the
	 * run's directory cannot be told: never taken for gone, nor for refused —
	 * which would let a restore carry it home as an artifact.
	 */
	| { kind: "unknown"; note: string };

/**
 * Check a record against what a run could have minted, before anything acts
 * on it. A record can only ever narrow what is already known to be staging
 * ground — it is never authority by itself: the directory it names has to
 * be named the way {@link sessionStagingPath} names one, hold the file the
 * record names directly, sit inside the sessions tree or the archive, and,
 * when the record says so, still be the inode the run made. A record that
 * fails the first three is refused outright, whatever else it says.
 */
async function checkRecordedGround(entry: StagingRecord, roots: readonly string[]): Promise<RecordedGround> {
	const shaped =
		path.dirname(entry.file) === entry.dir &&
		SESSION_STAGING_RE.exec(path.basename(entry.dir))?.[1] === path.basename(entry.file);
	if (!shaped) return { kind: "refused", note: `${entry.dir} is not a staging directory, so its record was refused` };
	let standing: Stats;
	try {
		standing = await fs.lstat(entry.dir);
	} catch (error) {
		if (isEnoent(error)) return { kind: "gone" };
		return { kind: "unknown", note: `${entry.dir} could not be read, so it was left as it is: ${errorText(error)}` };
	}
	const real = await fs.realpath(entry.dir).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		return { failed: errorText(error) };
	});
	if (typeof real === "object") {
		return { kind: "unknown", note: `${entry.dir} could not be resolved, so it was left as it is: ${real.failed}` };
	}
	const contained = real !== undefined && roots.some(root => isWithin(root, real) && real !== root);
	if (!contained) {
		return {
			kind: "refused",
			note: `${entry.dir} is outside the sessions and archive trees, so its record was refused and it was left alone`,
		};
	}
	if (!standing.isDirectory()) {
		return { kind: "gone", note: `${entry.dir} is no longer the directory a run staged in, so it was left alone` };
	}
	if (!entry.dirIdentity) return { kind: "intent" };
	if (standing.dev !== entry.dirIdentity.dev || standing.ino !== entry.dirIdentity.ino) {
		return { kind: "gone", note: `${entry.dir} is no longer the directory a run staged in, so it was left alone` };
	}
	return { kind: "minted" };
}

/**
 * The real paths a staging directory may sit inside: the sessions tree and
 * the archive. A tree not made yet holds nothing; one that cannot be resolved
 * throws, since dropping it would read every directory in it as outside.
 */
async function stagingRoots(agentDir: string): Promise<string[]> {
	const roots: string[] = [];
	for (const root of [getSessionsDir(agentDir), getArchivedSessionsDir(agentDir)]) {
		try {
			roots.push(await fs.realpath(root));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw new Error(
				`${root} could not be resolved (${errorText(error)}), so staging ground in it cannot be told from anything else`,
			);
		}
	}
	return roots;
}

/**
 * The staging directories runs recorded and did not live to clean up,
 * found and reported — never removed. See {@link clearStagingGround} for
 * why a record removes nothing: the residue a killed run leaves stays until
 * someone removes it by hand, and its record keeps a restore from carrying
 * it into the live tree in the meantime.
 *
 * Nothing in the ledger is removed either. A record whose directory is gone
 * and a record replacement a run died writing are files this run did not
 * write, and their names and shapes are no proof any run did: a file
 * somebody put there looks the same. Both are kept and do nothing — a
 * record whose directory is gone narrows nothing a restore does — and the
 * first is listed, since nothing else ever clears it: one moved out by
 * `gc --quarantine`, which also finishes a quarantine of it that stopped. A
 * record whose name now holds something other than a run's directory is
 * reported, with the command that moves the record out. A record no run
 * could have written is reported and kept — see {@link checkRecordedGround}.
 */
export async function surveyRecordedStagingGrounds(agentDir: string): Promise<StagingSurvey> {
	const result: StagingSurvey = { residue: [], withoutDirectory: [], notes: [] };
	const { records, failure } = await readStagingRecords(agentDir);
	if (failure) {
		result.notes.push(failure);
		return result;
	}
	let roots: string[];
	try {
		roots = await stagingRoots(agentDir);
	} catch (error) {
		result.notes.push(errorText(error));
		return result;
	}
	for (const { path: record, entry } of records) {
		const ground = await checkRecordedGround(entry, roots);
		if (ground.kind === "refused" || ground.kind === "unknown") {
			result.notes.push(ground.note);
			continue;
		}
		if (ground.kind === "gone") {
			if (ground.note) {
				result.notes.push(
					`${ground.note}; its record ${record} was kept, since a later run removes nothing it did not make — ` +
						`\`omp gc --quarantine ${shellQuote(path.basename(record))} --apply${agentDirFlag(agentDir)}\` moves ` +
						`the record, and only the record, out of ${path.dirname(record)}`,
				);
			} else {
				result.withoutDirectory.push(record);
			}
			continue;
		}
		result.residue.push(entry.dir);
	}
	return result;
}

/**
 * The staging record that names an entry below `root` as a staging
 * directory a run recorded and did not clear — residue, which a restore
 * leaves out of the live tree and where it is — or undefined. Decided by a
 * checked record ({@link checkRecordedGround}),
 * never by a name. A record can only make something be left out; it never
 * makes anything be removed. Compared by real path relative to `root`, so
 * an archive reached through a symlink still matches the directory a run
 * minted inside it.
 *
 * Throws when the ledger cannot be read or holds a record that cannot be
 * parsed, and when `root`, or a directory a record names, cannot be looked
 * at: without it, residue and artifact cannot be told apart, and a walk
 * that carried on would publish a partial file as one or skip an artifact as
 * the other.
 */
export async function stagingResidueUnder(
	agentDir: string,
	root: string,
): Promise<(entry: string) => string | undefined> {
	const residue = await recordedStagingByPath(agentDir, root);
	return entry => residue.get(path.relative(root, entry));
}

/**
 * Every recorded staging directory inside `root`, with the record that names
 * it — what {@link stagingResidueUnder} answers one entry at a time.
 */
export async function recordedStagingIn(agentDir: string, root: string): Promise<{ dir: string; record: string }[]> {
	return [...(await recordedStagingByPath(agentDir, root))]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([relative, record]) => ({ dir: path.join(root, relative), record }));
}

/** Recorded staging directories inside `root`, by their path under it, each with its record. */
async function recordedStagingByPath(agentDir: string, root: string): Promise<Map<string, string>> {
	const residue = new Map<string, string>();
	const { records, failure } = await readStagingRecords(agentDir);
	if (failure) throw new Error(`${failure}; staging residue cannot be told from artifacts, so nothing was carried`);
	if (records.length === 0) return residue;
	const unknown = (what: string): Error =>
		new Error(`${what}; staging residue cannot be told from artifacts, so nothing was carried`);
	const realRoot = await fs.realpath(root).catch((error: unknown) => {
		// A tree not made yet holds no residue.
		if (isEnoent(error)) return undefined;
		throw unknown(`${root} could not be resolved (${errorText(error)})`);
	});
	if (realRoot === undefined) return residue;
	const roots = await stagingRoots(agentDir);
	for (const { path: record, entry } of records) {
		// A record written before its run made the directory names one that
		// run may have made; leaving it out of the live tree is all a record
		// can do, so it is enough that the name and the place check out.
		const ground = await checkRecordedGround(entry, roots);
		if (ground.kind === "unknown") throw unknown(ground.note);
		if (ground.kind !== "minted" && ground.kind !== "intent") continue;
		const real = await fs.realpath(entry.dir).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw unknown(`${entry.dir} could not be resolved (${errorText(error)})`);
		});
		if (real === undefined) continue;
		const relative = path.relative(realRoot, real);
		if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) residue.set(relative, record);
	}
	return residue;
}

/**
 * What is said about a directory a staging record names, where a command
 * found it — `consequence` says what that command does about it — and what to
 * do about it. It never advises removing the directory: a record is not proof
 * a run made it. For one a killed gc run left, it names `gc --quarantine`,
 * which moves the directory and its record out of both session trees and
 * checks where it moves them — see {@link quarantineStagingRecord}. Moving the
 * record alone would turn the directory into an artifact gc carries.
 */
export function stagingResidueNote(dir: string, record: string, consequence: string): string {
	const agentDir = path.dirname(path.dirname(record));
	return (
		`${dir} is named by the staging record ${record}, ${consequence}. If a killed gc run left it, stop any gc run and ` +
		`any use of this session, look at the record and the directory, then move both out of the session trees with ` +
		`\`omp gc --quarantine ${shellQuote(path.basename(record))} --apply${agentDirFlag(agentDir)}\`, leave any ` +
		`\`.restoring\` record where it is, and run the same command again; if it then reports that a \`.restoring\` ` +
		`record was there before it, look at that record and move it aside. If no gc run made the directory, move only the ` +
		`record out of ${path.dirname(record)} and run the same command again`
	);
}

/** What a restore says about a recorded staging directory in the archived tree. */
export const ARCHIVED_RESIDUE = "so a restore leaves it in the archive, where it is, and does not finish";
/** What a restore says about a recorded staging directory in the live tree. */
export const LIVE_RESIDUE =
	"in the live artifact tree, where a killed restore leaves its stage, so a restore does not finish while it is there";

/** What `gc --quarantine` found, and moved or would move. */
export interface StagingQuarantine {
	record: string;
	/** The staging directory the record names, when it is still there. */
	directory?: string;
	/** Where the record and its directory go, or went. */
	quarantine?: string;
	moved: boolean;
	errors: string[];
}

/**
 * `target`'s real path as it would resolve now: the real path of its nearest
 * existing ancestor with the missing rest appended.
 */
async function resolvedPath(target: string): Promise<{ real: string; existing: string }> {
	const rest: string[] = [];
	let at = target;
	for (;;) {
		try {
			return { real: path.join(await fs.realpath(at), ...rest.reverse()), existing: at };
		} catch (error) {
			const parent = path.dirname(at);
			if (!isEnoent(error) || parent === at) throw error;
			rest.push(path.basename(at));
			at = parent;
		}
	}
}

/**
 * A staging record, held: the descriptor it was read through stays open, so
 * no other file can be given its inode number until the caller closes it,
 * and the bytes read are what a file at its name must still hold for this
 * run to call it the same record — see {@link removeFileNoOneElseWrites}.
 */
async function readRecordFile(file: string): Promise<{ held: HeldFile; entry: StagingRecord }> {
	const handle = await openRegularFile(file);
	if (!handle) throw absentFile(file);
	try {
		const { dev, ino } = await handle.stat();
		const bytes = await handle.readFile();
		return { held: { handle, dev, ino, bytes }, entry: parseStagingRecord(bytes.toString("utf8")) };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

/** What one place a quarantine of a record uses holds, read with no ledger record to go by. */
interface QuarantinePlace {
	destination: string;
	/** Every path in it. */
	paths: string[];
	/** Why it could not be listed, when it could not. */
	unreadable?: string;
	/** Where it resolves, when that is inside a session tree. */
	insideTree?: string;
	/** Why where it resolves could not be found, when it could not. */
	unresolved?: string;
	/** The record, when a whole copy of it is a regular file at its name there. */
	copy?: StagingRecord;
	/** Why what is at the record's name there could not be read, when it could not. */
	copyUnreadable?: string;
	/** The staging directory a part copy there begins by naming, when enough of it was copied to read that. */
	partNames?: string;
}

/**
 * The text of the regular file at `at`; undefined when nothing is there or
 * what is there is not a regular file; or why it could not be read — which
 * is not the same as nothing there.
 */
async function readRegularText(at: string): Promise<{ text: string } | { unreadable: string } | undefined> {
	try {
		// The entry itself: a link to a file elsewhere is not a file here.
		const standing = await fs.lstat(at).catch((error: unknown) => {
			// Absent, or a path component that is not a directory: either way
			// nothing can stand at this name.
			if (isEnoent(error) || codeOf(error) === "ENOTDIR") return undefined;
			throw error;
		});
		if (!standing?.isFile()) return undefined;
		const handle = await openRegularFile(at);
		if (!handle) return undefined;
		try {
			return { text: await handle.readFile("utf8") };
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch (error) {
		return { unreadable: errorText(error) };
	}
}

/**
 * What `destination` holds for the record named `recordName`, or undefined
 * when it holds nothing. A place that cannot be listed is not an empty one:
 * its copy of the record is still looked for at the one name a quarantine
 * gives it, which searching the directory can reach without listing it.
 */
async function readQuarantinePlace(
	destination: string,
	recordName: string,
	roots: readonly string[],
): Promise<QuarantinePlace | undefined> {
	const place: QuarantinePlace = { destination, paths: [] };
	try {
		const names = await fs.readdir(destination);
		if (names.length === 0) return undefined;
		place.paths = names.map(name => path.join(destination, name));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		place.unreadable = errorText(error);
	}
	try {
		const resolved = await resolvedPath(destination);
		if (roots.some(root => isWithin(root, resolved.real) || isWithin(resolved.real, root))) {
			place.insideTree = resolved.real;
		}
	} catch (error) {
		place.unresolved = errorText(error);
	}
	const read = await readRegularText(path.join(destination, recordName));
	if (read === undefined) return place;
	if ("unreadable" in read) {
		place.copyUnreadable = read.unreadable;
		return place;
	}
	const { text } = read;
	try {
		place.copy = parseStagingRecord(text);
	} catch {
		// A run writes a record with its directory first, so a copy stopped
		// part-way often names it already.
		const quoted = /^\{\s*"dir"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
		try {
			if (quoted !== undefined) place.partNames = JSON.parse(quoted) as string;
		} catch {}
	}
	return place;
}

/** Where a staging directory left in its tree with no ledger record ends up, and what to do about it. */
const UNRECORDED_STAGE_WARNING =
	`with no record in the ledger, a restore takes it for an artifact and carries it home, partial file and all; ` +
	`look for it in the session trees — a directory named \`.<file name>.<16 hexadecimal digits>.tmp\` — and move it ` +
	`out by hand to keep it out`;

/**
 * Answer `gc --quarantine` for a record no longer in the ledger: always a
 * refusal, never a finished quarantine. Nothing on disk afterwards can show
 * whether a quarantine finished — a later directory can be given the old
 * inodes, an alias can show the original at another name, and anything put
 * beside the record's copy as evidence can be put there by other hands — so
 * this names every place a quarantine of the record uses and what each
 * holds, or what in it could not be looked at, and gives the one step that
 * is right whichever happened: put a copy of the record back in the ledger
 * and run the same command again. What could not be read may be that copy,
 * so it is never reported as none. With the ledger record to go by, that run
 * decides from what is on disk, under every check a first run makes, and
 * reports the quarantine done once nothing is left to move. A staging
 * directory still in a session tree with no record in the ledger is one a
 * restore takes for an artifact and carries home, and restore cannot tell it
 * from an artifact of the same shape, so every answer says so.
 */
function settleWithoutLedgerRecord(
	result: StagingQuarantine,
	ledger: string,
	places: readonly QuarantinePlace[],
): StagingQuarantine {
	const { record } = result;
	if (places.length === 0) {
		result.errors.push(
			`${record} is not a staging record in ${ledger}, and no place a quarantine of it uses holds anything. If a gc run ` +
				`wrote it and its staging directory is still where the killed run left it, ${UNRECORDED_STAGE_WARNING}`,
		);
		return result;
	}
	if (places.length === 1) result.quarantine = places[0].destination;
	const copyOf = (place: QuarantinePlace): string => path.join(place.destination, path.basename(record));
	const held = places
		.map(place => {
			let holds =
				place.unreadable !== undefined
					? `${place.destination} could not be listed (${place.unreadable})`
					: `${place.destination} holds ${place.paths.join(", ")}`;
			if (place.unreadable !== undefined && place.copy !== undefined) {
				holds += `, though ${copyOf(place)} could be read and holds the whole record`;
			}
			if (place.insideTree !== undefined) holds += ` and resolves to ${place.insideTree}, inside a session tree`;
			if (place.unresolved !== undefined) {
				holds +=
					`, and where ${place.destination} resolves could not be checked (${place.unresolved}), so whether it is ` +
					`inside a session tree is not known`;
			}
			if (place.copyUnreadable !== undefined)
				holds += `; ${copyOf(place)} could not be read (${place.copyUnreadable})`;
			return holds;
		})
		.join("; ");
	const copies = places.filter(place => place.copy !== undefined);
	const unread = places.filter(place => place.copyUnreadable !== undefined).map(copyOf);
	const which =
		copies.length === 1
			? copyOf(copies[0])
			: `the copy whose directory you mean to quarantine — ${copies.map(place => `${copyOf(place)}, naming ${place.copy!.dir}`).join("; ")} —`;
	// What could not be read may be a whole copy, so it is never called none.
	const unknown =
		unread.length === 0
			? ""
			: `${unread.join(" and ")} could not be read, so whether ${unread.length === 1 ? "it is" : "each is"} a whole copy ` +
				`of the record is not known`;
	// The run the step leads to lists the place it uses before it moves
	// anything, so a copy in a place that cannot be listed needs that first.
	const unlisted = copies.filter(place => place.unreadable !== undefined).map(place => place.destination);
	const listFirst =
		unlisted.length === 0
			? ""
			: ` That run lists ${unlisted.join(" or ")} before it moves anything, so make ${unlisted.join(" and ")} listable ` +
				`by this user first.`;
	const step =
		copies.length === 0
			? unread.length > 0
				? `${unknown}: once this user can read ${unread.length === 1 ? "it" : "them"}, run the same command again, and it ` +
					`says what ${unread.length === 1 ? "it holds" : "they hold"} and the step that follows.`
				: `No place holds a whole copy of the record, so there is none to put back; nothing reads what those places hold, so ` +
					`look at it and copy out anything you want to keep.`
			: `To finish a quarantine of it, or to see that one finished, copy ${which} back to ${record} and run the same command ` +
				`again: with the ledger record to go by, it decides from what is on disk, moves the directory if it is still at its ` +
				`old name, refuses what it has to, and reports the quarantine done once nothing is left to move.` +
				listFirst +
				(unknown === ""
					? ""
					: ` ${unknown}; once this user can read ${unread.length === 1 ? "it" : "them"}, the same command says what ${unread.length === 1 ? "it holds" : "they hold"}.`);
	const named = [...new Set(places.flatMap(place => place.copy?.dir ?? place.partNames ?? []))];
	result.errors.push(
		`${record} is not in ${ledger}, so this does not report a quarantine of it finished, and does not finish one: what is on ` +
			`disk cannot show which happened. A finished quarantine removes the record from the ledger, so it leaves this; so ` +
			`does a ledger record removed by hand, and one lost any other way, partway through a quarantine or not. What the ` +
			`places a quarantine of it uses ` +
			`hold: ${held}. ${step} If the staging directory the record names${named.length > 0 ? `, ${named.join(" or ")},` : ""} ` +
			`is still in a session tree, ${UNRECORDED_STAGE_WARNING}.`,
	);
	return result;
}

/** How far a copy at a quarantine name has got, or why what stands there is none. */
type RecordCopy = { held: "none" | "part" | "all" } | { refused: string };

/**
 * What stands at `at`, the name `gc --quarantine` gives the record's copy in
 * its destination — `what` naming the record — judged by what it is and what
 * it holds, never by its name.
 * It is this copy when it is nothing yet; a regular file holding exactly
 * `bytes` — what a finished copy leaves, or the record's own inode linked
 * there; or a regular file no other name holds, with fewer bytes, all of
 * them how `bytes` begin — what a copy stopped part-way leaves. Anything
 * else is refused, whoever put it there: an expected name is not evidence
 * that what holds it is ours, and a record may stop a quarantine, never make
 * it write over something. So is a part copy this user cannot write:
 * finishing it needs that write, and asking first is what lets a preview,
 * and `--apply` before anything moves, refuse what applying would fail at.
 *
 * With `finish`, a part copy is completed — the rest written after what it
 * holds, through a descriptor that has to be on the very file just judged,
 * at the length it was judged at — and the name is judged again, so what
 * comes back says what the name holds now: every byte it held stays where it
 * was, and no other name sees the write.
 */
async function recordCopyAt(at: string, bytes: Buffer, finish: boolean, what: string): Promise<RecordCopy> {
	const standing = await fs.lstat(at).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!standing) return { held: "none" };
	const refused = { refused: `${at} is already there and is not a copy of ${what}` };
	// The type comes from `lstat` before anything is opened: a symlink is
	// refused whatever it points at, and opening a device can act on it.
	if (!standing.isFile()) return refused;
	const reader = await openRegularFile(at, { noFollow: true }).catch(notRegularAsAbsent);
	if (!reader) return refused;
	let judged: Stats;
	let held: Buffer;
	try {
		judged = await reader.stat();
		const same = judged.isFile() && judged.dev === standing.dev && judged.ino === standing.ino;
		if (!same || judged.size > bytes.length) return refused;
		held = await reader.readFile();
	} finally {
		await reader.close().catch(() => undefined);
	}
	if (held.equals(bytes)) return { held: "all" };
	if (judged.nlink !== 1 || held.length >= bytes.length || !held.equals(bytes.subarray(0, held.length))) {
		return refused;
	}
	if (!finish) {
		try {
			await fs.access(at, fsConstants.W_OK);
		} catch (error) {
			return {
				refused: `${at} holds the start of ${what} but cannot be written to finish it: ${errorText(error)}`,
			};
		}
		return { held: "part" };
	}
	const writer = await openRegularFile(at, { write: true, noFollow: true });
	if (!writer) throw absentFile(at);
	try {
		const now = await writer.stat();
		if (now.dev !== judged.dev || now.ino !== judged.ino || now.size !== held.length || now.nlink !== 1) {
			return refused;
		}
		for (let written = held.length; written < bytes.length;) {
			written += (await writer.write(bytes, written, bytes.length - written, written)).bytesWritten;
		}
		await writer.sync();
	} finally {
		await writer.close().catch(() => undefined);
	}
	return await recordCopyAt(at, bytes, false, what);
}

/**
 * Make `at` hold exactly `bytes`, writing over nothing: what stands there has
 * to pass {@link recordCopyAt}. Nothing there is filled by `link` from
 * `linkFrom` when one is given — `link` never replaces a name — or else, and
 * when the link cannot reach, by a file created for it alone and synced; a
 * part copy is finished in place. It counts only once read back whole.
 * Returns why it could not, or undefined once it has.
 */
async function putExactly(at: string, bytes: Buffer, what: string, linkFrom?: string): Promise<string | undefined> {
	const found = await recordCopyAt(at, bytes, false, what);
	if ("refused" in found) return found.refused;
	if (found.held === "none") {
		let linked = false;
		if (linkFrom !== undefined) {
			try {
				await fs.link(linkFrom, at);
				linked = true;
			} catch (error) {
				// Another filesystem than the ledger's, or one without hard
				// links: copied across instead, and the next run finishes the
				// copy if this stops.
				if (codeOf(error) === "EEXIST") throw error;
			}
		}
		if (!linked) {
			const handle = await createExclusive(at, 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close().catch(() => undefined);
			}
		}
	}
	const written = await recordCopyAt(at, bytes, true, what);
	if ("refused" in written) return written.refused;
	if (written.held !== "all") return `${at} does not hold all of ${what}`;
	return undefined;
}

/**
 * Move a staging record and the directory it names out of the session trees,
 * into `gc-quarantine/<record id>` beside the tree the directory's parent is
 * in. Without `apply`, say what would move — and what would stop it.
 *
 * A restore then finds neither the record nor the directory and finishes,
 * and whatever the directory held stays readable in quarantine. A record is
 * acted on only when it is one a run of this feature could have written —
 * see {@link parseStagingRecord} and {@link checkRecordedGround}.
 *
 * Short of another writer racing it there, nothing at the destination is
 * written over, replaced or removed. The record goes first: by `link`, which
 * never replaces a name, or — across filesystems, where a link cannot reach,
 * or on one that has no hard links — by a copy created for it alone, and it
 * is read back whole before anything else happens. Then the directory moves
 * by `rename` onto a name nothing holds. Then the record's ledger entry, the
 * one thing this removes, goes. Whatever already has the record's name in the
 * destination has to pass {@link recordCopyAt}.
 *
 * The destination's real path, as it resolves through any link above it, has
 * to lie outside both session trees, or nothing moves: a quarantine that
 * resolved into a tree would put a partial stage where a restore carries it
 * home. Every failure this can predict — a destination holding something
 * else, at another name or at the record's, a part copy that cannot be
 * written to finish it, a directory that cannot be written, a directory move
 * across filesystems — is checked before anything is made, the same way for
 * a preview as for `--apply`, and checked again once the destination exists,
 * before anything moves into it. A filesystem error after that can still
 * stop `--apply` where the preview did not.
 *
 * The destination is decided from the directory's parent, which a move
 * leaves in place, and while the ledger entry is there each run decides its
 * next step from what is on disk — the record's copy none, part or all, the
 * directory at its old name or not — so a quarantine stopped anywhere is
 * finished by the same command. A gc run's archive phase removes no ledger
 * entry it did not write, so the entry stays until the quarantine removes
 * it. With no ledger entry, this never reports a quarantine finished,
 * whatever the destination holds: a finished quarantine retried, and one
 * whose entry was removed by hand partway through, are both answered by
 * {@link settleWithoutLedgerRecord}, which refuses and gives the step that
 * finishes either: copy the record back to the ledger and run again. A
 * ledger entry that cannot be looked at is not taken for one that is gone:
 * that refusal says it could not be checked and gives no copy-back step,
 * since the record may be there. Nor is any other look that fails taken for
 * nothing there.
 *
 * The caller holds the gc lock, so no run is staging into the directory while
 * it moves; the advice that names this command asks for activity on the
 * session to stop. A process that writes into the destination after the last
 * check — rebinding a directory above it, putting an empty directory at the
 * directory's name, linking the part copy under another name, rewriting the
 * ledger record during the copy — is outside what this guards.
 */
export async function quarantineStagingRecord(
	agentDir: string,
	query: string,
	apply: boolean,
): Promise<StagingQuarantine> {
	// The ledger record's descriptor, once read, is held until this returns:
	// the record is removed by it, last of all.
	const holding: { record?: HeldFile } = {};
	try {
		return await quarantineHoldingRecord(agentDir, query, apply, holding);
	} finally {
		await holding.record?.handle.close().catch(() => undefined);
	}
}

async function quarantineHoldingRecord(
	agentDir: string,
	query: string,
	apply: boolean,
	holding: { record?: HeldFile },
): Promise<StagingQuarantine> {
	const ledger = stagingLedgerDir(agentDir);
	const record = path.isAbsolute(query)
		? path.normalize(query)
		: path.join(ledger, query.endsWith(".json") ? query : `${query}.json`);
	const result: StagingQuarantine = { record, moved: false, errors: [] };
	const refuse = (why: string): StagingQuarantine => {
		result.errors.push(why);
		return result;
	};
	if (path.dirname(record) !== ledger || !record.endsWith(".json")) {
		return refuse(`${record} is not a staging record in ${ledger}`);
	}
	const id = path.basename(record, ".json");
	let roots: string[];
	try {
		roots = await stagingRoots(agentDir);
	} catch (error) {
		return refuse(`${errorText(error)}, so nothing was moved`);
	}
	const quarantineFor = (tree: string | undefined): string =>
		path.join(tree === undefined ? agentDir : path.dirname(tree), "gc-quarantine", id);

	let listed: Stats;
	try {
		listed = await fs.lstat(record);
	} catch (error) {
		if (!isEnoent(error)) {
			return refuse(
				`${record} could not be checked (${errorText(error)}), so whether ${ledger} still holds it is not known: ` +
					`nothing was moved, and this is no reason to copy a record back, since one may already be there. Once ` +
					`${record} can be checked, run the same command again.`,
			);
		}
		// Already moved by an earlier run of this command, or never there.
		const destinations = [...new Set([...roots, undefined].map(quarantineFor))];
		const places = await Promise.all(destinations.map(at => readQuarantinePlace(at, path.basename(record), roots)));
		return settleWithoutLedgerRecord(
			result,
			ledger,
			places.filter(place => place !== undefined),
		);
	}
	let bytes: Buffer;
	let entry: StagingRecord;
	let read: HeldFile;
	try {
		await assertPrivateLedger(ledger);
		// The entry itself, not what it leads to: a run writes its record as a
		// regular file, and a link to one would move as the link.
		if (!listed.isFile()) throw new Error("it is not a regular file");
		({ held: read, entry } = await readRecordFile(record));
		holding.record = read;
		bytes = read.bytes ?? Buffer.alloc(0);
		if (read.dev !== listed.dev || read.ino !== listed.ino) throw new Error("it changed while it was read");
	} catch (error) {
		return refuse(unreadableRecordNote(record, ledger, error));
	}
	const ground = await checkRecordedGround(entry, roots);
	if (ground.kind === "refused" || ground.kind === "unknown") return refuse(ground.note);
	const directoryPresent = ground.kind !== "gone";
	const moved = path.basename(entry.dir);

	// A parent that is gone takes its whole tree with it, and the quarantine
	// goes beside the agent directory; one that cannot be resolved says
	// nothing about where it belongs. When one tree resolves inside the other
	// — a sessions tree linked to the agent directory, say — the quarantine
	// goes beside the outer one, whichever is listed first: beside the inner
	// one is inside the outer.
	let tree: string | undefined;
	try {
		const parent = await fs.realpath(path.dirname(entry.dir));
		for (const root of roots) {
			if (isWithin(root, parent) && (tree === undefined || isWithin(root, tree))) tree = root;
		}
	} catch (error) {
		if (!isEnoent(error)) {
			return refuse(
				`${path.dirname(entry.dir)} could not be resolved (${errorText(error)}), so where a quarantine of ${entry.dir} ` +
					`goes is not known and nothing was moved; run the same command again once it can be`,
			);
		}
	}
	const destination = quarantineFor(tree);
	const recordInto = path.join(destination, path.basename(record));
	const ofRecord = "this record";
	result.quarantine = destination;
	if (directoryPresent) result.directory = entry.dir;

	// Everything that would stop the move: run before anything is made, and
	// again once the destination exists, before anything moves into it.
	const obstacle = async (): Promise<string | undefined> => {
		try {
			const { real, existing } = await resolvedPath(destination);
			if (roots.some(root => isWithin(root, real) || isWithin(real, root))) {
				return `${destination} resolves to ${real}, inside a session tree, so nothing was moved; give it a directory of its own outside ${roots.join(" and ")}`;
			}
			const standing = await fs.lstat(destination).catch((error: unknown) => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
			if (standing) {
				if (!standing.isDirectory())
					return `${destination} is already there and is not a directory, so nothing was moved`;
				const names = await fs.readdir(destination);
				const foreign = names.filter(name => name !== moved && name !== path.basename(record));
				if (foreign.length > 0) {
					return `${destination} already holds ${foreign.join(", ")}, which no quarantine of this record put there, so nothing was moved`;
				}
				// The directory cannot be here while it is still at its old name.
				if (directoryPresent && names.includes(moved)) {
					return `${destination} already holds ${moved} while ${entry.dir} is still there, so nothing was moved`;
				}
				const copied = await recordCopyAt(recordInto, bytes, false, ofRecord);
				if ("refused" in copied) return `${copied.refused}, so nothing was moved`;
			}
			const writable = [existing, ledger, ...(directoryPresent ? [path.dirname(entry.dir), entry.dir] : [])];
			for (const directory of writable) {
				try {
					await fs.access(directory, fsConstants.W_OK | fsConstants.X_OK);
				} catch (error) {
					return `${directory} cannot be written, so nothing was moved: ${errorText(error)}`;
				}
			}
			if (directoryPresent) {
				const [from, into] = await Promise.all([fs.stat(path.dirname(entry.dir)), fs.stat(existing)]);
				if (from.dev !== into.dev) {
					return `${entry.dir} and ${destination} are on different filesystems, so the directory cannot be moved by rename and nothing was moved`;
				}
			}
			return undefined;
		} catch (error) {
			return `${destination} could not be checked, so nothing was moved: ${errorText(error)}`;
		}
	};
	const before = await obstacle();
	if (before) return refuse(before);
	if (!apply) return result;

	try {
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		await fs.mkdir(destination, { mode: 0o700 }).catch((error: unknown) => {
			if (codeOf(error) !== "EEXIST") throw error;
		});
	} catch (error) {
		return refuse(`${destination} could not be made, so nothing was moved: ${errorText(error)}`);
	}
	const made = await obstacle();
	if (made) return refuse(made);
	// The record first, read back whole — not assumed from the steps that put
	// it there — and only then the directory, so the directory never leaves
	// its tree without its whole record beside it.
	try {
		const why = await putExactly(recordInto, bytes, ofRecord, record);
		if (why) {
			return refuse(
				`${why}, so the directory was not moved and ${record} was left in the ledger; look at both, then run the same command again`,
			);
		}
	} catch (error) {
		return refuse(
			`${record} could not be copied into ${destination}: ${errorText(error)}, so the directory was not moved and ` +
				`${record} was left in the ledger; look at both, then run the same command again`,
		);
	}
	if (directoryPresent) {
		const into = path.join(destination, moved);
		// Both names once more, the instant before the move. `link` cannot
		// move a directory, and `rename` of one replaces an empty directory
		// standing at the new name — no bytes, but not this run's — and fails
		// on anything else; so that name is looked at last, one system call
		// before. The directory itself has to be the one the run minted, when
		// the record says which that is.
		const absent = (error: unknown): undefined => {
			if (isEnoent(error)) return undefined;
			throw error;
		};
		try {
			const moving = await fs.lstat(entry.dir);
			const minted = entry.dirIdentity;
			if (!moving.isDirectory() || (minted && (moving.dev !== minted.dev || moving.ino !== minted.ino))) {
				return refuse(
					`${entry.dir} is no longer the directory a run staged in, so it was not moved; its record is copied into ` +
						`${destination} and still in ${ledger}: look at both, then run the same command again`,
				);
			}
			if (await fs.lstat(into).catch(absent)) {
				return refuse(
					`${into} appeared while this quarantine ran, and it was not this quarantine's, so ${entry.dir} was not ` +
						`moved; its record is copied into ${destination} and still in ${ledger}: look at both, then run the same ` +
						`command again`,
				);
			}
			await fs.rename(entry.dir, into);
		} catch (error) {
			const across = codeOf(error) === "EXDEV" ? ", because they are on different filesystems" : "";
			return refuse(
				`${entry.dir} could not be moved into ${destination}${across}: ${errorText(error)}; its record is copied there ` +
					`and still in ${ledger}, so run the same command again once that is fixed`,
			);
		}
	}
	// The ledger entry last: once it goes, a retry finds no record, and says
	// so rather than take anything on disk for a finished quarantine. Only
	// while it is still the file whose bytes went into the destination: the
	// descriptor read through is still held, so no file put at the name
	// since can carry its inode number, and the bytes must match too — a
	// file put there since is somebody's, and kept, a copy across
	// filesystems included.
	const note = await removeFileNoOneElseWrites(record, [read], "the record this command copied into the quarantine");
	if (note) {
		return refuse(
			`${note}; the copy and the directory are in ${destination}, so look at ${record}, then run the same command ` +
				`again`,
		);
	}
	result.moved = true;
	return result;
}

/**
 * Archived paths with no live counterpart, as relative names.
 *
 * The question a stale restore record raises: has the live tree caught up
 * with what the archive holds? A regular file at the name, not sameness — a
 * session that carried on diverges from its archive by design — and only
 * enough of it to decide whether an unfinished restore is still unfinished.
 * A FIFO, a device or a directory standing there is not the artifact: a
 * reader of it waits or fails instead of reading the archived bytes, so
 * the restore that would bring them home is still outstanding. So is
 * anything in a staging directory a record names: a restore leaves it out,
 * and leaving something out is not a finished restore.
 */
export async function archivedPathsWithoutLiveCopies(archiveFile: string, sessionFile: string): Promise<string[]> {
	const archiveArtifacts = archiveFile.slice(0, -ARCHIVED_SESSION_SUFFIX.length);
	const liveArtifacts = sessionFile.slice(0, -SESSION_SUFFIX.length);
	const outstanding: string[] = [];
	// Directories as well as files: an empty directory the restore left out
	// is still something the live tree does not hold.
	const visit = async (name: string): Promise<void> => {
		const archived = await statIfPresent(path.join(archiveArtifacts, name));
		if (!archived) return;
		const live = await statIfPresent(path.join(liveArtifacts, name));
		if (!archived.isDirectory()) {
			if (!live?.isFile()) outstanding.push(name);
			return;
		}
		if (name !== "" && !live?.isDirectory()) {
			outstanding.push(name);
			return;
		}
		for (const entry of await fs.readdir(path.join(archiveArtifacts, name))) await visit(path.join(name, entry));
	};
	await visit("");
	return outstanding.sort();
}

/**
 * What restoring `archiveFile` would refuse in its artifact tree, without
 * writing anything: each live destination that already holds something
 * other than the archived entry, or a prefix of it — the same questions
 * {@link copyEntryDereferenced} asks before it publishes.
 */
export async function artifactRestoreConflicts(
	archiveFile: string,
	sessionFile: string,
	agentDir: string,
): Promise<string[]> {
	const archiveArtifacts = archiveFile.slice(0, -ARCHIVED_SESSION_SUFFIX.length);
	const liveArtifacts = sessionFile.slice(0, -SESSION_SUFFIX.length);
	// A killed restore stages in the live tree, so its residue is there, and
	// it stops a restore whether or not the archive still has a tree to carry.
	const liveResidue = async (): Promise<string[]> => {
		const notes: string[] = [];
		for (const { dir, record } of await recordedStagingIn(agentDir, liveArtifacts)) {
			notes.push(stagingResidueNote(dir, record, LIVE_RESIDUE));
		}
		return notes;
	};
	if (!(await statIfPresent(archiveArtifacts))) return await liveResidue();
	const archiveRoot = await fs.realpath(archiveArtifacts);
	const isResidue = await stagingResidueUnder(agentDir, archiveArtifacts);
	const conflicts: string[] = [];
	const visit = async (source: string, destination: string): Promise<void> => {
		const stat = await fs.stat(source).catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (!stat) return;
		const record = isResidue(source);
		if (record !== undefined) {
			conflicts.push(stagingResidueNote(source, record, ARCHIVED_RESIDUE));
			return;
		}
		// A look that fails says nothing about what is there: it is reported as
		// that, never read as an empty slot or as something else standing there.
		const unchecked = (error: unknown): void => {
			conflicts.push(
				`${destination} could not be checked against the archived ${source}, so whether it can be restored ` +
					`there is not known: ${errorText(error)}`,
			);
		};
		let existing: Stats | undefined;
		try {
			existing = await fs.lstat(destination).catch((error: unknown) => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
		} catch (error) {
			unchecked(error);
			return;
		}

		if (stat.isDirectory()) {
			if (existing) {
				let live: Stats | undefined;
				try {
					live = await statIfPresent(destination);
				} catch (error) {
					unchecked(error);
					return;
				}
				if (!live?.isDirectory()) {
					conflicts.push(`${destination} is not a directory, so ${source} could not be restored into it`);
					return;
				}
			}
			for (const entry of (await fs.readdir(source)).sort()) {
				await visit(path.join(source, entry), path.join(destination, entry));
			}
			return;
		}
		if (!stat.isFile()) {
			conflicts.push(
				`${await archivedSpecialEntry(source, stat)}, so applying would leave it there and not read it, and would ` +
					`not finish; move it out of the archive, then restore`,
			);
			return;
		}
		if (!existing) return;
		let live: fs.FileHandle | undefined;
		try {
			// Anything but a regular file at the name already holds something else.
			live = await openRegularFile(destination).catch(notRegularAsAbsent);
			if (
				live &&
				(await survivesRemovalOf(destination, await live.stat(), stat, archiveRoot)) &&
				(await sourceIsPrefixOfDestination(bytesOfRegularFile(source), live, false))
			) {
				return;
			}
		} catch (error) {
			unchecked(error);
			return;
		} finally {
			await live?.close().catch(() => undefined);
		}
		conflicts.push(
			`${destination} already holds something else, so the archived ${source} would be left in the archive`,
		);
	};
	await visit(archiveArtifacts, liveArtifacts);
	conflicts.push(...(await liveResidue()));
	return conflicts;
}

/** The owner set as one comparable value, so a membership change is visible. */
async function ownerSignature(owners: () => Promise<(string | undefined)[]>): Promise<string> {
	const ids = (await owners()).filter((id): id is string => id !== undefined);
	return [...new Set(ids)].sort().join("\n");
}

/**
 * Whether the live transcript holds everything the archive holds — the same
 * session, possibly carried on since it was restored, possibly renamed since.
 * It is what lets a restore that was interrupted before its artifact tree
 * arrived be finished after the session has been resumed.
 *
 * See {@link sourceIsPrefixOfDestination} for what "holds" means and why the
 * title slot is the one span that may differ.
 *
 * A read that fails, on either side, throws: it is no answer either way, and
 * taking it for "no" is how a transcript nobody could read was called a
 * different session.
 */
export async function archiveIsPrefixOfLive(archiveFile: string, sessionPath: string): Promise<boolean> {
	// Non-blocking, so a FIFO at the live name is a refusal rather than a hang,
	// and one that names it: it is no session for the archive to be part of.
	const live = await openRegularFile(sessionPath);
	if (!live) return false;
	try {
		let holds = false;
		await pipeline(bytesOfRegularFile(archiveFile), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await sourceIsPrefixOfDestination(source as AsyncIterable<Uint8Array>, live, true);
		});
		if (holds) return true;
		await pipeline(bytesOfRegularFile(archiveFile), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await recordsAreCarried(linesOf(source as AsyncIterable<Uint8Array>), linesOfHandle(live));
		});
		return holds;
	} catch (error) {
		throw archiveReadError(archiveFile, error);
	} finally {
		await live.close();
	}
}

/**
 * Whether the live transcript at `livePath` holds everything the already-open
 * archived transcript has.
 *
 * The archive phase asks this immediately before it replaces an archived
 * transcript with a longer one, and it has to be an answer about the file it
 * examined rather than about whatever the name points at by then — so the
 * gzip stream is read from the caller's descriptor, positionally, not
 * reopened by path.
 *
 * It is otherwise the same question {@link archiveIsPrefixOfLive} answers,
 * record-aware fallback included. Binding the read to a descriptor while
 * dropping that fallback is how an ordinary migrated session — a version 1
 * or 2 transcript the writer brought forward, or a legacy layout — stopped
 * being re-archivable with nothing competing with it at all. A read that
 * fails throws, the same way.
 */
export async function archivedHandleIsPrefixOfLive(archived: fs.FileHandle, livePath: string): Promise<boolean> {
	const live = await openRegularFile(livePath);
	if (!live) return false;
	try {
		let holds = false;
		await pipeline(bytesOfHandle(archived), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await sourceIsPrefixOfDestination(source as AsyncIterable<Uint8Array>, live, true);
		});
		if (holds) return true;
		await pipeline(bytesOfHandle(archived), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await recordsAreCarried(linesOf(source as AsyncIterable<Uint8Array>), linesOfHandle(live));
		});
		return holds;
	} finally {
		await live.close();
	}
}

/**
 * Whether the file at `candidatePath` holds every byte the already-open
 * `archived` handle has, and is not that same file.
 *
 * The archive phase asks this about the copy it has staged, with the
 * existing archived file pinned by the descriptor it read, so the comparison
 * is of the file rather than of whatever its name points at by then. It is
 * only ever an answer about what was read: the caller writes over nothing on
 * the strength of it, and publishes only where there is nothing to replace.
 * A read that fails throws — a comparison that could not be made is not one
 * that found different bytes.
 */
export async function archivedHandleIsHeldBy(
	archived: fs.FileHandle,
	archivedStat: Stats,
	candidatePath: string,
	transcript = false,
): Promise<boolean> {
	const candidate = await openRegularFile(candidatePath);
	if (!candidate) return false;
	try {
		const candidateStat = await candidate.stat();
		if (archivedStat.dev === candidateStat.dev && archivedStat.ino === candidateStat.ino) return false;
		// Positional reads on both sides: a read stream over the caller's
		// handle closes it when it ends, and the second comparison would then
		// be answering about a descriptor that is gone.
		if (await sourceIsPrefixOfDestination(bytesOfHandle(archived), candidate, transcript)) return true;
		if (!transcript) return false;
		return await recordsAreCarried(linesOfHandle(archived), linesOfHandle(candidate));
	} finally {
		await candidate.close();
	}
}

/** Whether `source` and `destination` name the one file rather than two copies of it. */
export async function isSamePath(source: string, destination: string): Promise<boolean> {
	const [a, b] = await Promise.all([statIfPresent(source), statIfPresent(destination)]);
	return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Bytes of an archived transcript inflated before giving up on finding its
 * header. The production reader's own limit, so the two agree about where a
 * header can be.
 */
const ARCHIVED_HEADER_READ_LIMIT = 1024 * 1024;

/** Every file below `root`, links followed, the way the archive phase enumerates one. */
async function treeFiles(root: string): Promise<string[]> {
	if (!(await statIfPresent(root))) return [];
	const files: string[] = [];
	for await (const name of new Glob("**/*").scan({
		cwd: root,
		dot: true,
		onlyFiles: true,
		followSymlinks: true,
	})) {
		files.push(path.join(root, name));
	}
	return files;
}

/**
 * The session id the archived transcript's own header carries, read with the
 * reader every other part of omp uses.
 *
 * Inventing header semantics here is how a lease misses an identity the
 * writer holding it is using: leading blank lines, a pretty-printed header, a
 * title slot narrower than its usual width, whitespace past any sniff window
 * — all of them are headers to the session loader, and a restore that cannot
 * see them walks past their owners.
 *
 * No archive at the name has no header and no owner. One that cannot be
 * read throws: a header nobody could read is not one that names nobody, and
 * a restore that took it for that would publish the transcript without its
 * owner's lease.
 */
async function inflateArchivedHeaderId(archiveFile: string): Promise<string | undefined> {
	if (!(await statIfPresent(archiveFile))) return undefined;
	const head: Uint8Array[] = [];
	let bytes = 0;
	try {
		await pipeline(bytesOfRegularFile(archiveFile), createGunzip(), async (source: NodeJS.ReadableStream) => {
			for await (const chunk of source as AsyncIterable<Uint8Array>) {
				if (bytes >= ARCHIVED_HEADER_READ_LIMIT) continue;
				head.push(chunk);
				bytes += chunk.byteLength;
			}
		});
	} catch (error) {
		throw archiveReadError(archiveFile, error);
	}
	return sessionHeaderIdFromBytes(Buffer.concat(head, bytes));
}

/**
 * Leases of every transcript a restore brings home: the session's own, read
 * from the header rather than from the archive's filename, and those nested
 * in either artifact tree, found the same way.
 *
 * This has to match what the archive phase acquires, or the two disagree
 * about who owns what. A filename is not a session id — archiving accepts a
 * transcript called anything, and the id lives in the header — and a
 * parent's lease says nothing about the subagent sessions below it, which is
 * why archiving leases the whole tree and skips a session whose child is
 * live. A restore publishing those files while their owners held their
 * leases would race exactly the writes the lease exists to protect.
 *
 * The set is taken to a fixed point rather than calculated once, and it is
 * taken again immediately before and after the artifact tree is copied: a
 * subagent can appear in the tree between an enumeration and the first copy,
 * and a set only as fresh as its first pass would not cover it. Each pass
 * enumerates again while holding everything the pass before it took, so a
 * child that appears is either leased too or refuses the run. Passes stop
 * when one finds nothing new; a tree that never settles is refused rather
 * than chased.
 *
 * Null, with everything taken so far released, when any of them is live.
 * Throws, with everything released, when one cannot be probed: an owner
 * nobody could look for is not a live one.
 */
const RESTORE_LEASE_PASSES = 8;

interface RestoreLeases {
	/** Take the set again, for owners that have appeared since. False when one is live; throws when one cannot be probed. */
	refresh(): Promise<boolean>;
	release(): void;
}

async function tryAcquireRestoreLeases(owners: () => Promise<(string | undefined)[]>): Promise<RestoreLeases | null> {
	const leases: FileLockHandle[] = [];
	const leased = new Set<string>();
	const release = (): void => {
		for (const held of leases) held.release();
		leases.length = 0;
	};
	const refresh = async (): Promise<boolean> => {
		try {
			for (let pass = 0; pass < RESTORE_LEASE_PASSES; pass += 1) {
				let added = false;
				for (const id of await owners()) {
					if (id === undefined || leased.has(id)) continue;
					const lease = tryAcquireSessionLease(id);
					if (!lease) return false;
					leased.add(id);
					leases.push(lease);
					added = true;
				}
				if (!added) return true;
			}
			return false;
		} catch (error) {
			// A probe that throws says nothing about who owns what: it is not
			// a live owner, and saying one is sends the reader to look for a
			// process that is not there. What it took goes with the failure.
			release();
			throw new Error(`who owns this session and its subagent sessions could not be checked: ${errorText(error)}`, {
				cause: error,
			});
		}
	};
	if (await refresh()) return { refresh, release };
	release();
	return null;
}

/**
 * `value` as one shell word, so a path with a space in it survives being
 * pasted into a terminal. An instruction that splits into two words sends
 * the reader to a directory that does not exist, and the recovery it was
 * printed for does not happen.
 */
export function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `--agent-dir` a printed instruction needs to run where this one did.
 *
 * Always printed, never "add it when it is not the default one": whether the
 * directory came from the flag, the environment or the config is invisible
 * to whoever copies the line, and a recovery command that runs against the
 * wrong default reports success for a session it never touched.
 */
export function agentDirFlag(agentDir?: string): string {
	return agentDir ? ` --agent-dir ${shellQuote(agentDir)}` : "";
}

/**
 * Put an archived transcript back where it belongs, with its artifact tree,
 * and leave the archive where it is: after a restore the session is in two
 * places until `omp gc --reclaim` gives the live copy up.
 *
 * The caller must hold the gc lock: between the transcript landing and the
 * artifact tree following it, the session is half in each tree, and an
 * archive phase running in that window would copy the halves past each
 * other. Holding it also means every staging record standing in the ledger
 * is a dead run's; the directories they name are left out of the live tree,
 * left where they are, and reported as not restored — see
 * {@link stagingResidueUnder}.
 *
 * Ownership leases are taken first, for every transcript the restore moves —
 * the session's own, read from its header, and every nested one in either
 * artifact tree — matching what the archive phase acquires. See
 * {@link tryAcquireRestoreLeases}.
 *
 * What a refusal leaves, because "both copies whole" is not the same as a
 * transaction and this is not one:
 *
 * - Nothing archived is removed or changed: a restore only adds to the live
 *   tree.
 * - A refusal before the copy leaves both trees untouched.
 * - A refusal during the copy leaves the live tree holding the entries
 *   carried so far, with the archive complete. Running the restore again
 *   finishes it; the entries already there are recognised rather than
 *   copied twice.
 * - A refusal after the copy — a changed owner set, a live file that no
 *   longer holds what the archive holds — leaves the live tree holding the
 *   whole copy and the restore's record down, so the next resume finishes
 *   or reports it rather than opening the session as if it were whole.
 * - A content conflict names the live path to move aside; nothing moves
 *   until someone does.
 *
 * So the states a refusal can leave are a partly published live tree or two
 * complete copies, never a session with bytes in neither place.
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
	const stagingAgentDir = agentDir ?? getAgentDir();
	const ledger = stagingLedgerDir(stagingAgentDir);
	// Read through a non-blocking descriptor: a FIFO at the live transcript's
	// name, or anywhere in either tree, owns nothing and must not hang this —
	// the restore's walk names it, as the artifact it cannot carry.
	const headerId = async (file: string): Promise<string | undefined> => {
		const handle = await openRegularFile(file)
			.catch(notRegularAsAbsent)
			.catch(error => {
				if (codeOf(error) === "ENOTDIR") return undefined;
				throw error;
			});
		if (!handle) return undefined;
		try {
			return await readSessionHeaderIdFromHandle(handle);
		} finally {
			await handle.close().catch(() => undefined);
		}
	};
	const owners = async (): Promise<(string | undefined)[]> => [
		await inflateArchivedHeaderId(archiveFile),
		...(await Promise.all(
			[...(await treeFiles(archiveArtifacts)), ...(await treeFiles(liveArtifacts)), sessionPath].map(headerId),
		)),
	];
	const stem = path.basename(archiveFile, ARCHIVED_SESSION_SUFFIX);
	const target = stem.slice(stem.lastIndexOf("_") + 1) || stem;
	const agentDirSuffix = agentDirFlag(agentDir ?? agentDirOfArchivedPath(archiveFile) ?? getAgentDir());
	const restoreCommand = `omp gc --restore ${shellQuote(target)} --apply${agentDirSuffix}`;
	const leases = await tryAcquireRestoreLeases(owners).catch((error: unknown) => {
		throw new Error(`Cannot restore "${archiveFile}": ${errorText(error)}. Nothing was restored`, { cause: error });
	});
	const noOwners = (): Error =>
		new Error(
			`Cannot restore "${archiveFile}": a running process owns this session or one of its subagent sessions. ` +
				`Close it and run \`${restoreCommand}\` again.`,
		);
	if (!leases) throw noOwners();
	// Nothing between taking a lease and releasing it may run outside the
	// guard. The record's own creation is work like any other: a `mkdir`
	// that fails or a write that runs out of space left the restore
	// throwing with the lease still held, and every later attempt then
	// refused with "a running process owns this session" — the holder being
	// this one's own leaked handle.
	const record = restoreRecordPath(archiveFile);
	let own: OwnRestoreRecord | undefined;
	try {
		// The record goes down before anything is published and comes up only
		// when everything is home. Nothing that runs later has to work out from
		// the live tree whether this finished, which is the question every
		// earlier version of this got wrong in both directions. This run makes
		// its own record and removes only that; a file already at the name —
		// an earlier run's record, or anything else — keeps the session marked
		// unfinished, and is left.
		const refused = await restoreRecordRefusal(record);
		if (refused) throw new Error(refused);
		own = await createRestoreRecord(record, `${restoreCommand}\n`);
		if (own === undefined) {
			const late = await restoreRecordRefusal(record);
			if (late) throw new Error(late);
		}
		const notes: string[] = [];
		let bytes: number;
		if (await statIfPresent(sessionPath)) {
			// The transcript is already live. Either another process restored it
			// while this one waited for the lock, or an earlier attempt moved the
			// transcript and failed on its artifact tree. Finishing that attempt is
			// the only way the tree comes home, so a retry resumes rather than
			// refusing — for this session, carried on or not, never another.
			const carried =
				!(await statIfPresent(archiveFile)) ||
				(await archiveIsPrefixOfLive(archiveFile, sessionPath).catch((error: unknown) => {
					throw new Error(
						`Cannot restore "${archiveFile}": ${sessionPath} could not be compared with it, so whether it is ` +
							`this session carried on is not known: ${errorText(error)}`,
						{ cause: error },
					);
				}));
			if (!carried) {
				throw new Error(
					`Refusing to restore over a different session file: ${sessionPath} is not this archive carried on. ` +
						`To bring the archived one home, move ${sessionPath} and its artifact directory ${liveArtifacts} aside, ` +
						`then run \`${restoreCommand}\` ` +
						"(without `--apply` it only reports). " +
						`To keep the live one and be rid of the archived one, move both halves out of the archive directory ` +
						`yourself — the transcript ${archiveFile} and its artifact directory ${archiveArtifacts}; ` +
						`there is nothing for \`--restore\` to do once they are gone, and restoring by id would report ` +
						`that no archived session matches. Nothing is removed until you choose.`,
				);
			}
			bytes = (await fs.stat(sessionPath)).size;
		} else {
			bytes = await inflateArchivedTranscript(archiveFile, sessionPath, ledger, notes);
		}

		const notRestored: string[] = [];
		const hasArtifacts = (await statIfPresent(archiveArtifacts)) !== undefined;
		let artifactsRestored = !hasArtifacts && (await statIfPresent(liveArtifacts)) !== undefined;
		// Neither copy goes. The restore publishes the session into the live
		// tree and leaves the archive where it is, so `omp gc --reclaim`,
		// which an operator runs by name and acknowledges, stays the only
		// step that takes a copy away; until someone asks, the space is not
		// given back, which is the cost this feature can afford.
		if (!(await leases.refresh())) throw noOwners();
		const leasedOwners = await ownerSignature(owners);
		if (hasArtifacts) {
			try {
				const { leftOut, special } = await copyTreeDereferenced(
					archiveArtifacts,
					liveArtifacts,
					stagingAgentDir,
					notes,
				);
				if (!(await leases.refresh())) throw noOwners();
				if ((await ownerSignature(owners)) !== leasedOwners) {
					throw new Error(
						`the subagent sessions below ${archiveArtifacts} changed while it was being restored; ` +
							`everything carried home is there and the archive is untouched — ` +
							`run \`${restoreCommand}\` again`,
					);
				}
				// Leaving anything out is not a finished restore: each directory,
				// and each FIFO, socket or device the archive holds, is named, the
				// record stays down and the command fails. What was left out stays
				// in the archive, and nothing here suggests removing it.
				for (const [dir, staging] of leftOut) notRestored.push(stagingResidueNote(dir, staging, ARCHIVED_RESIDUE));
				// Moving the entry out is not enough: this restore keeps its
				// record, and a restore run again stops at a record already
				// there, so the advice names it.
				for (const entry of special) {
					notRestored.push(
						`${entry}, so it was left there and not read; the restore does not finish while it is there — move ` +
							`it out of the archive, move this restore's record ${record} aside, then restore again`,
					);
				}
				artifactsRestored = leftOut.length === 0 && special.length === 0;
			} catch (error) {
				notRestored.push(
					`the artifact tree (subagent transcripts, tool output) at ${archiveArtifacts} was not restored whole: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		// A restore killed while it staged left its stage in the live tree;
		// until that is moved out, this restore has not finished — whether or
		// not the archive still has an artifact tree to carry.
		try {
			const residue = await recordedStagingIn(stagingAgentDir, liveArtifacts);
			for (const { dir, record: staging } of residue) {
				notRestored.push(stagingResidueNote(dir, staging, LIVE_RESIDUE));
			}
			if (residue.length > 0) artifactsRestored = false;
		} catch (error) {
			artifactsRestored = false;
			notRestored.push(`the live artifact tree at ${liveArtifacts} could not be checked: ${errorText(error)}`);
		}
		notRestored.push(...notes);
		if (own === undefined) {
			if (await statIfPresent(record)) notRestored.push(restoreRecordLeftNote(record));
		} else if (notRestored.length === 0) {
			const left = await dropOwnRestoreRecord(own);
			if (left) notRestored.push(left);
		} else {
			await rewriteOwnRestoreRecord(own, `${restoreCommand}\n${notRestored.join("\n")}\n`);
		}
		return { sessionPath, archivePath: archiveFile, bytes, artifactsRestored, notRestored };
	} finally {
		await own?.handle.close().catch(() => undefined);
		leases.release();
	}
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
 * Whether the live session already has a copy of everything its retained
 * archive holds, so opening it needs no restore.
 *
 * The answer is the one a restore recorded, not one inferred from the live
 * tree. Every inference was wrong in both directions at once. Content
 * comparison read ordinary living — a child renaming itself, a tool
 * rewriting its output — as an interrupted restore and refused to open a
 * complete session. Presence read an artifact a restore had refused to
 * write over as a finished one, so a resume that correctly refused became a
 * silent success on the second attempt. A size test read a tool output a
 * session had emptied as unfinished while an entry that is genuinely empty
 * in the archive read as finished. There is no shape of the live tree that
 * carries the fact, because the fact is about what the restore did.
 *
 * So the restore writes a record before it publishes anything and removes
 * it only when every entry is home, and this is a question about that
 * record: one stat, no ownership taken, and nothing for a later writer to
 * fool. A live transcript that is not there at all is never complete, which
 * is what sends a resume-by-id for a fully archived session down the
 * restore route.
 */
async function liveSessionIsComplete(sessionFile: string, archiveFile: string): Promise<boolean> {
	if (!(await statIfPresent(sessionFile))) return false;
	return (await statIfPresent(restoreRecordPath(archiveFile))) === undefined;
}

/**
 * The live `.jsonl` path of a session file, bringing it out of the archive
 * first when that is where it lives. Everything that reads a session as an
 * ordinary file — the writer, a fork and its artifact copy, `omp render`,
 * `omp session pack`, `omp anonymize` — goes through here, so none of them
 * has to understand `.jsonl.gz`, and none of them silently drops the
 * subagent transcripts and tool output stored beside it.
 *
 * A live transcript with an archive still beside it is the same case wearing
 * a different path: a run killed between publishing the transcript and
 * carrying the tree home leaves exactly that, and resume-by-id then resolves
 * to the live file. Opening it as if it were whole breaks this change's own
 * resumability contract — the session comes up with its subagent transcripts
 * and tool output missing and nothing said — so the restore is finished here
 * too.
 *
 * A restore that could not bring the artifact tree back fails here rather
 * than handing out a transcript whose artifacts are still in the archive:
 * the live transcript wins every later id lookup, so an unreported half
 * restore is one nothing would retry.
 */
export async function materializeSessionFile(sessionFile: string, agentDir?: string): Promise<string> {
	let archived: string | undefined;
	if (isArchivedSessionPath(sessionFile)) {
		archived = sessionFile;
	} else {
		const candidate = archivedSessionPathForLive(sessionFile, agentDir);
		if (candidate !== undefined && (await statIfPresent(candidate))) archived = candidate;
	}
	if (archived === undefined) return sessionFile;
	if (!isArchivedSessionPath(sessionFile) && (await liveSessionIsComplete(sessionFile, archived))) {
		// The archive is only being retained: the live session already holds
		// everything it does. There is nothing to finish, so this must not take
		// the session's leases — doing so made an ordinary fork of a session
		// the caller already owns fail with "a running process owns this
		// session" once an archive existed beside it.
		return sessionFile;
	}
	const restored = await restoreArchivedSession(archived, agentDir);
	if (restored.notRestored.length > 0) {
		const stem = path.basename(restored.sessionPath, SESSION_SUFFIX);
		const retry = `omp gc --restore ${shellQuote(stem.slice(stem.lastIndexOf("_") + 1) || stem)} --apply${agentDirFlag(agentDir ?? agentDirOfArchivedPath(archived) ?? getAgentDir())}`;
		throw new Error(
			`Restored the transcript of "${archived}" to ${restored.sessionPath}, but the restore did not finish: ${restored.notRestored.join("; ")}. ` +
				`The archive is kept; \`${retry}\` retries it once the path is clear.`,
		);
	}
	return restored.sessionPath;
}
