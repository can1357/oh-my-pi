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
import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getAgentDir, getSessionsDir, isEnoent, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { codeOf, statIfPresent, withGcLock } from "./gc-lock";
import {
	absentFile,
	createExclusive,
	type HeldFile,
	makeHeldDirectory,
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
import { isSessionLeaseHeld, SESSION_STAGING_RE, sessionStagingPath, tryAcquireSessionLease } from "./session-storage";
import { parseTitleSlotFromContent, parseTitleSlotLine } from "./session-title-slot";

/** Suffix `gc --archive` gives a transcript it has compressed. */
export const ARCHIVED_SESSION_SUFFIX = ".jsonl.gz";
const SESSION_SUFFIX = ".jsonl";
/** The longest name a directory entry may have on the filesystems omp runs on. */
const NAME_MAX = 255;

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
 * Take this run's record down, or say why what has its name was left. The
 * record is a file only gc names and writes — created here with `O_EXCL` and
 * written only through its own descriptor — so it goes by
 * {@link unlinkFileNoOneElseWrites}: removed only while the name holds the
 * very inode this run created, which no other file can have been given while
 * this run holds its descriptor, looked at again the instant before the
 * `unlink`. Nothing is moved aside, so a run killed here leaves its record at
 * its own name or nothing. A directory that refuses the change is named,
 * with what to do.
 */
async function dropOwnRestoreRecord(own: OwnRestoreRecord): Promise<string | undefined> {
	let removal: OwnFileRemoval;
	try {
		removal = await unlinkFileNoOneElseWrites(own.path, [{ handle: own.handle, dev: own.dev, ino: own.ino }]);
	} catch (error) {
		if (isPermissionError(error)) {
			return (
				`${recordDirectoryNotWritable(own.path, error)}, so this restore could not take down its record ${own.path}, ` +
				`though everything else came home. While it is there the session is treated as unfinished and does not open: ` +
				`make the directory writable with \`chmod u+w\`, then look at the record and move it aside`
			);
		}
		throw error;
	}
	if (removal !== "kept") return undefined;
	return `${own.path} held something other than the record this restore wrote, so it was left: look at it, and once the session holds everything, move it aside`;
}

/**
 * Every archived transcript, as absolute paths, newest session first, and
 * every bucket that could not be read. Buckets and the archive root itself
 * are commonly symlinks onto another filesystem, which `Bun.Glob` walks only
 * when asked. The file name starts with the session's own timestamp, so
 * sorting by name orders sessions by when they ran — unlike mtime, which
 * records when gc happened to archive them.
 *
 * A bucket that cannot be read — `EACCES`, `EPERM`, gone, not a directory —
 * is not part of the listing, and it is named in `unreadable`, never left
 * out without a word: a listing that failed in part is not a complete
 * listing. Any other failure propagates, so a scan that failed is not taken
 * for an empty archive.
 */
export async function scanArchivedSessionFiles(
	agentDir?: string,
): Promise<{ files: string[]; unreadable: { bucket: string; error: string }[] }> {
	const archiveRoot = getArchivedSessionsDir(agentDir);
	let buckets: string[];
	try {
		buckets = await fs.readdir(archiveRoot);
	} catch (error) {
		if (isEnoent(error) || codeOf(error) === "ENOTDIR") return { files: [], unreadable: [] };
		throw error;
	}
	const files: string[] = [];
	const unreadable: { bucket: string; error: string }[] = [];
	for (const bucket of buckets) {
		const dir = path.join(archiveRoot, bucket);
		const found: string[] = [];
		try {
			// Not only regular files: an archived name that stands for a FIFO
			// is still that session's name, and a restore of it by id should
			// say what stands there, as opening it does, not that nothing
			// matches. Nothing here opens it.
			// `readdir`, not a glob: a glob lists only files and directories.
			for (const name of await fs.readdir(dir)) {
				if (!name.endsWith(ARCHIVED_SESSION_SUFFIX)) continue;
				const entry = path.join(dir, name);
				if ((await fs.stat(entry).catch(() => undefined))?.isDirectory()) continue;
				found.push(entry);
			}
		} catch (error) {
			if (isEnoent(error) || isPermissionError(error) || codeOf(error) === "ENOTDIR") {
				unreadable.push({ bucket: dir, error: codeOf(error) ?? errorText(error) });
				continue;
			}
			throw error;
		}
		files.push(...found);
	}
	files.sort((left, right) => path.basename(right).localeCompare(path.basename(left)));
	return { files, unreadable };
}

/** The archived transcripts {@link scanArchivedSessionFiles} could read — for a count, never for choosing one. */
export async function listArchivedSessionFiles(agentDir?: string): Promise<string[]> {
	return (await scanArchivedSessionFiles(agentDir)).files;
}

/**
 * Archived transcripts whose file name carries `sessionArg` as an id prefix,
 * newest session first. The name is `<timestamp>_<id>.jsonl.gz`, so this needs
 * no decompression and stays cheap with a large archive.
 *
 * Throws, choosing nothing, while any bucket cannot be read: the bucket that
 * could not be read is exactly where another candidate might be, so a prefix
 * that matches one readable session may be ambiguous, and one that matches
 * none may still name a session. Skipping it instead let a reclaim resolve a
 * formerly ambiguous prefix to the one session it could see and give up that
 * session's live copy — the wrong one.
 */
export async function findArchivedSessionFiles(sessionArg: string, agentDir?: string): Promise<string[]> {
	const needle = sessionArg.toLowerCase();
	if (!needle) return [];
	const { files, unreadable } = await scanArchivedSessionFiles(agentDir);
	if (unreadable.length > 0) {
		const named = unreadable.map(({ bucket, error }) => `${bucket} (${error})`).join(", ");
		throw new Error(
			`archive ${unreadable.length === 1 ? "bucket" : "buckets"} ${named} could not be read, so whether ` +
				`"${sessionArg}" matches an archived session there is not known, and none was chosen: make ` +
				`${unreadable.length === 1 ? "it" : "them"} readable, or move ${unreadable.length === 1 ? "it" : "them"} ` +
				`out of ${getArchivedSessionsDir(agentDir)}, and run the command again`,
		);
	}
	const matches: string[] = [];
	for (const file of files) {
		const name = path.basename(file, ARCHIVED_SESSION_SUFFIX).toLowerCase();
		const separator = name.lastIndexOf("_");
		const id = separator < 0 ? name : name.slice(separator + 1);
		if (name.startsWith(needle) || id.startsWith(needle)) matches.push(file);
	}
	return matches;
}

/**
 * Receives a line to show while a session comes out of the archive, so
 * whoever opened it sees it is being brought back rather than a program that
 * has stopped: a session with thousands of artifacts takes seconds, and once
 * took twenty with nothing printed.
 */
export type RestoreProgress = (line: string) => void;

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
 * left at that name is read back by {@link publishedIsStaged}.
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
		const written = await inflateIntoHandleWithDigest(bytesOfRegularFile(source), ground.handle);
		const landed = await fs.lstat(ground.file).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (landed?.dev !== ground.created.dev || landed.ino !== ground.created.ino) {
			throw new Error(`${ground.file} was replaced while the transcript was being written`);
		}
		await fs.link(ground.file, destination);
		if (!(await publishedIsStaged(destination, ground.created, holdsCopied(written)))) {
			throw new Error(`${destination} is not the transcript this restore wrote, so it was left as it is`);
		}
		return written.size;
	} catch (error) {
		throw archiveReadError(source, error);
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
	const hasher = new Bun.CryptoHasher("sha256");
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
	const hasher = new Bun.CryptoHasher("sha256");
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
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	destination: fs.FileHandle,
): Promise<CopiedBytes> {
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	await pipeline(source as AsyncIterable<Uint8Array>, createGunzip(), async (inflated: NodeJS.ReadableStream) => {
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
 * The bytes of the regular file at `file`, read through one descriptor that
 * {@link openRegularFile} has judged a regular file before a byte is read: a
 * FIFO, a socket or a device at the name — directly, through a link, or put
 * there after an earlier look — throws {@link NotARegularFile} with nothing
 * read, so it is neither waited on nor drained. Nothing at the name throws
 * `ENOENT`, as a read by name would.
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
 */
export async function publishedIsStaged(
	destination: string,
	staged: Stats,
	holds: (published: fs.FileHandle) => Promise<boolean>,
): Promise<boolean> {
	const isStaged = (entry: Stats | undefined): boolean =>
		entry?.isFile() === true && entry.dev === staged.dev && entry.ino === staged.ino;
	const published = await openRegularFile(destination).catch(() => undefined);
	if (!published) return false;
	try {
		if (!isStaged(await published.stat())) return false;
		if (!isStaged(await fs.lstat(destination).catch(() => undefined))) return false;
		if (!(await holds(published))) return false;
	} catch {
		return false;
	} finally {
		await published.close().catch(() => undefined);
	}
	return isStaged(await fs.lstat(destination).catch(() => undefined));
}

/** A `holds` for {@link publishedIsStaged}: exactly the bytes a copy wrote. */
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
	plan?: RestorePlan,
	/** Called once per archived file the live tree holds once this returns. */
	onFile?: () => void,
): Promise<void> {
	const stat = await fs.stat(source).catch(error => {
		// A link whose target is gone: nothing to carry, nothing to lose.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat || isResidue(source)) return;
	// Only absence is an empty slot: a look that fails says nothing about
	// what is there, and a directory taken for new would be given the
	// archive's mode. Said as a failed look, never as something standing there.
	const unchecked = (error: unknown): Error =>
		new Error(
			`${destination} could not be checked against the archived ${source}, so whether it can be restored ` +
				`there is not known: ${errorText(error)}`,
			{ cause: error },
		);
	const existing = await fs.lstat(destination).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw unchecked(error);
	});
	if (stat.isDirectory()) {
		// Through the link: a symlinked artifact directory is a directory the
		// restore may merge into, the same way the archive phase walks one.
		const live = existing
			? await statIfPresent(destination).catch((error: unknown) => {
					throw unchecked(error);
				})
			: undefined;
		if (existing && !live?.isDirectory()) {
			throw new Error(`${destination} is not a directory, so ${source} cannot be restored into it`);
		}
		if (live && live.dev === stat.dev && live.ino === stat.ino) {
			throw new Error(
				`${destination} is the archived directory ${source} itself, not a second copy of it; ` +
					`the archive is kept — give the live tree a directory of its own and restore again`,
			);
		}
		// A directory this restore makes gets its mode from the `mkdir` that
		// makes it, and nothing changes that mode afterwards — see
		// {@link makeHeldDirectory}: a mode set after the `mkdir`, by name or
		// through a descriptor opened after it, reached a directory a writer
		// swapped in between the two, and gave somebody's private directory
		// the archived `0777`. The mode is the archived one with the owner's
		// read, write and search added, so the restore can fill it — an
		// archived `0500` directory taken as it is could not be filled — and
		// the umask narrows it as it narrows any directory this user makes. A
		// directory the live tree already holds keeps its own permissions:
		// merging an archive into a private `0700` directory must not widen it.
		const mode = (stat.mode & 0o777) | 0o700;
		if (!existing) {
			if (plan) await planWritableDirectory(path.dirname(destination), plan, source);
			assertUmaskKeepsOwnerWrite(destination, mode, source);
			plan?.created.add(destination);
		}
		// Where this directory's entries start in the preview's list, so that
		// once all of them would come home the directory is named in their place.
		const promisedFrom = plan?.missing.length ?? 0;
		let held: HeldFile | undefined;
		if (!plan && !existing) held = await makeHeldDirectory(destination, mode);
		try {
			// Sorted, so a restore that stops part-way is reproducible from its report.
			for (const entry of (await fs.readdir(source)).sort()) {
				await copyEntryDereferenced(
					path.join(source, entry),
					path.join(destination, entry),
					archiveRoot,
					ledger,
					notes,
					isResidue,
					plan,
					onFile,
				);
			}
			if (plan && !existing) plan.noteDirectory(destination, promisedFrom);
			if (held) {
				// The fill names paths, so a writer that moved this directory
				// away and put something else at its name while it was filled
				// had files land there instead: said, not taken for a restore.
				// This comparison only reports and decides nothing, since by the
				// time it is read it is already stale.
				const standing = await fs.lstat(destination).catch(() => undefined);
				if (!standing || standing.dev !== held.dev || standing.ino !== held.ino) {
					throw new Error(
						`${destination} is no longer the directory this restore made for ${source}: something moved it ` +
							`while it was being filled, so what was restored into it may be elsewhere`,
					);
				}
			}
		} finally {
			await held?.handle.close().catch(() => undefined);
		}
		return;
	}
	if (!stat.isFile()) return;
	if (existing) {
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
				if (await sourceIsPrefixOfDestination(bytesOfRegularFile(source), live, false)) {
					onFile?.();
					return;
				}
			}
		} finally {
			await live?.close();
		}
		throw new Error(
			`${destination} already holds something else, so the archived ${source} was left in the archive; ` +
				`move that path aside and restore again`,
		);
	}
	if (plan) {
		// What the steps below need, asked in their order: a staging record in
		// the ledger, a stage beside the destination, the archived file opened
		// as a regular file — so a source this user cannot read, or one that is
		// no regular file, refuses here as it would there.
		await planLedger(ledger, plan);
		await planWritableDirectory(path.dirname(destination), plan, source);
		// The stage is named after the file, with a suffix: a name near the
		// filesystem's limit restores no further than `ENAMETOOLONG`.
		const stage = path.basename(sessionStagingPath(destination));
		if (Buffer.byteLength(stage) > NAME_MAX) {
			throw new Error(
				`${source} has a name too long to stage beside ${destination}: the staging name would be ` +
					`${Buffer.byteLength(stage)} bytes, over the ${NAME_MAX} a name may have, so it would be left in the ` +
					`archive; give it a shorter name there and restore again`,
			);
		}
		// And the stage is a directory made by name, `0700`: under a umask that
		// takes the owner's write bit, the file cannot go in it.
		assertUmaskKeepsOwnerWrite(path.join(path.dirname(destination), stage), 0o700, source);
		const archived = await openRegularFile(source);
		if (!archived) throw absentFile(source);
		await archived.close().catch(() => undefined);
		plan.notePromise(destination);
		return;
	}
	// Staged in a directory this run mints and records, so the stage is a
	// file of this run's own making, and a later restore leaves it out of the
	// live tree if this run is killed before removing it.
	const ground = await mintStagingGround(destination, ledger, stat.mode & 0o7777);
	try {
		// Through the regular-file check: an archived name that has become a
		// FIFO, a socket or a device since the walk looked is refused unread.
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
		if (!(await publishedIsStaged(destination, ground.created, holdsCopied(written)))) {
			throw new Error(`${destination} is not the copy of ${source} this restore wrote, so it was left as it is`);
		}
		onFile?.();
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
	plan?: RestorePlan,
	onFile?: () => void,
): Promise<Array<[string, string]>> {
	if (plan) await planWritableDirectory(path.dirname(destination), plan, source);
	else await fs.mkdir(path.dirname(destination), { recursive: true });
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
	const ledger = stagingLedgerDir(agentDir);
	await copyEntryDereferenced(source, destination, archiveRoot, ledger, notes, isResidue, plan, onFile);
	if (!plan) await assertLiveTreeHoldsArchive(source, destination, archiveRoot, isResidue);
	return [...leftOut];
}

/**
 * What a restore would do, worked out by the restore's own steps — the same
 * walk, the same refusals, in the same order — with each write replaced by a
 * check that it could be made, and nothing written. A preview that asked its
 * own questions instead promised, three rounds running, something the apply
 * then refused: a directory it would create at an archived `0500` mode, a
 * live tree that is the archive itself, a ledger it could not write.
 */
export interface RestorePlan {
	/**
	 * Archived entries the live tree lacks and applying would bring home whole,
	 * relative to the live artifact tree, in the order the walk reached them. A
	 * directory applying would make is named once, in place of its entries, and
	 * only when every one of them would come home: a refusal inside it leaves
	 * the entries before the refusal named one by one, and the directory not at
	 * all. Naming it beside a refusal promised a whole directory the apply
	 * then left empty.
	 */
	missing: string[];
	/** Directories applying would create, so a step inside one knows it will be there and writable. */
	created: Set<string>;
	/** Record the file `destination` as something applying would bring home. */
	notePromise(destination: string): void;
	/** Record a directory applying would make, all of it planned: named in place of the entries recorded since `from`. */
	noteDirectory(destination: string, from: number): void;
	/** Whether the staging ledger has been checked. */
	ledgerChecked: boolean;
}

/** A {@link RestorePlan} for the session whose live artifact tree is `liveArtifacts`. */
export function newRestorePlan(liveArtifacts: string): RestorePlan {
	const plan: RestorePlan = {
		missing: [],
		created: new Set(),
		ledgerChecked: false,
		notePromise(destination) {
			plan.missing.push(path.relative(liveArtifacts, destination));
		},
		noteDirectory(destination, from) {
			// The live tree's own root is not an entry of it.
			if (destination === liveArtifacts) return;
			plan.missing.splice(from, plan.missing.length - from, path.relative(liveArtifacts, destination));
		},
	};
	return plan;
}

/**
 * Throw unless `dir` is a directory this user can write into, or one a
 * restore could make — its nearest existing ancestor writable, and the
 * process umask leaving the owner write and search on what `mkdir` with
 * `mode` makes — or one the plan already makes. `what` names what would be
 * restored there. The umask matters for a directory made by name: under
 * `umask 0277` a `mkdir` makes one its own maker cannot write into, and the
 * apply then fails where the preview had promised it.
 */
async function planWritableDirectory(dir: string, plan: RestorePlan, what: string, mode = 0o777): Promise<void> {
	if (plan.created.has(dir)) return;
	const standing = await statIfPresent(dir);
	if (standing) {
		if (!standing.isDirectory())
			throw new Error(`${dir} is not a directory, so ${what} could not be restored into it`);
		try {
			await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
		} catch {
			throw new Error(
				`${dir} is not writable, so ${what} could not be restored into it: make it writable with \`chmod u+w\` ` +
					`and run the same command again`,
			);
		}
		return;
	}
	const parent = path.dirname(dir);
	if (parent === dir) throw new Error(`${dir} could not be made, so ${what} could not be restored into it`);
	await planWritableDirectory(parent, plan, what);
	assertUmaskKeepsOwnerWrite(dir, mode, what);
	plan.created.add(dir);
}

/**
 * Throw unless a directory made by name at `dir` with `mode` under this
 * process's umask keeps its owner's write and search bits: under `umask
 * 0277` a `mkdir` makes one its own maker cannot write into, and the apply
 * then fails where the preview had promised it.
 */
function assertUmaskKeepsOwnerWrite(dir: string, mode: number, what: string): void {
	const umask = process.umask();
	if ((mode & ~umask & 0o300) === 0o300) return;
	throw new Error(
		`${dir} would be made under umask ${umask.toString(8).padStart(4, "0")}, which leaves its owner unable to ` +
			`write into it, so ${what} could not be restored into it: run the command with a umask that keeps the ` +
			`owner's write and search bits, such as \`umask 077\``,
	);
}

/** Throw unless a restore could record a stage in `ledger`: there and private and writable, or makeable. */
async function planLedger(ledger: string, plan: RestorePlan): Promise<void> {
	if (plan.ledgerChecked) return;
	if (await statIfPresent(ledger)) await assertPrivateLedger(ledger);
	await planWritableDirectory(ledger, plan, "a staging record", 0o700);
	plan.ledgerChecked = true;
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
	/**
	 * The staged file held: {@link handle} and {@link created}'s identity, by
	 * which this run removes the file — at the stage, or at any name it was
	 * linked to — and nothing put at those names since. See {@link removeFileNoOneElseWrites}.
	 */
	held: HeldFile;
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
			return {
				dir,
				file,
				handle,
				created,
				held: { handle, dev: created.dev, ino: created.ino },
				record: complete,
				recordHeld,
			};
		} catch (error) {
			// What this attempt made goes again before the failure is
			// reported, and the record goes with it only once nothing it
			// names is left: a directory nothing records is a directory a
			// restore would carry home as somebody's artifact. The staged
			// file is removed while its descriptor is still held, and only
			// then closed: a file it did not get to create is not its to
			// remove.
			const note = await clearStagingGround(
				dir,
				file,
				handle && created ? { handle, dev: created.dev, ino: created.ino } : undefined,
				"this run",
			);
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
 * staged in it — while that file is still the one this run holds open, by
 * the rule every removal here follows ({@link removeFileNoOneElseWrites}) — and nothing
 * else. `staged` undefined means this run never created the file, so nothing
 * inside is its to remove.
 *
 * Only the run that minted a directory calls this. A later run has a record
 * at most, and a record is a file anybody running as this user could have
 * written, naming a directory with a name, a place and an inode anybody
 * could arrange; none of that says a run made it, so no record removes
 * anything. The directory itself goes with `rmdir`, which removes nothing
 * but an empty directory.
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
	staged: HeldFile | undefined,
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
		const what = `what ${stager} staged there`;
		const note =
			staged !== undefined && at === file
				? await removeFileNoOneElseWrites(at, [staged], what)
				: `${at} is not ${what}, so it was left as it is`;
		if (note) notes.push(note);
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
		const note = await clearStagingGround(ground.dir, ground.file, ground.held, "this run");
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
	 * they are named, each to be moved out of the ledger by hand.
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
 * same in every command that meets it. One cut short or one that is not
 * what a run writes gets the way out: move it out of the ledger; for the
 * second, which may name something, with what that costs if it names a
 * staging directory.
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
			`session tree, move that directory out of the tree by hand first: with no record in the ledger, a restore ` +
			`takes it for an artifact and carries it home, partial file and all`
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
 * to stop rather than guess.
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
		// Never read as a record, and never removed: a replacement a killed
		// run left and a file somebody else put there look alike, and a
		// suffix is no proof which it is.
		if (name.endsWith(STAGING_RECORD_PART)) continue;
		try {
			// Non-blocking and regular files only: a FIFO among the records
			// must refuse, not wait for a writer that never comes.
			const handle = await openRegularFile(record).catch(notRegularAsAbsent);
			if (!handle) throw new Error("it is not a regular file");
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
 * first is listed, since nothing else ever clears it. A record whose name
 * now holds something other than a run's directory is reported. A record no
 * run could have written is reported and kept — see
 * {@link checkRecordedGround}.
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
						`look at both, then move the record out of ${path.dirname(record)}`,
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
 * found it — `consequence` says what that command does about it — and how to
 * recover. It never advises removing the directory: a record is not proof a
 * run made it. The recovery for one a killed gc run left is the one a review
 * ran on a genuine killed archive: the directory, then its record, moved
 * into one directory of their own outside both session trees, then the
 * command run again — which then finishes, with the partial stage kept where
 * it was put and none of it carried home. Moving the record alone would turn
 * the directory into an artifact gc carries.
 *
 * The example command deletes nothing. Every deletion it once made — the
 * empty directory taken back with `rmdir`, a partial copy taken back with
 * `rm -rf` — went through a name, and a name resolved when the command runs
 * can by then lead to somebody else's directory: a review swapped the new
 * directory's name for a link to an unrelated directory between the move
 * and the clean-up, and the clean-up deleted that directory's file. So
 * nothing is taken back; the command is written to be run again instead,
 * and continues from what it finds.
 *
 * It names every path by its real path as it resolves now, so relinking the
 * agent directory afterwards cannot redirect it. It checks that both
 * directories it moves out of are writable, and stops, saying which to fix,
 * before it makes anything. It decides whether its directory's name lies
 * inside either session tree — resolving the trees again by the names gc
 * uses, so a tree moved or relinked since this message is caught — before
 * it makes the directory; `realpath` resolves a tree whose last part has
 * been renamed away to the path it would have, and stops the command only
 * when more than that is missing. It makes the directory with `mkdir`, or
 * takes the one an earlier run of it made: a directory, never a link. It
 * then enters it and checks the directory it is now in — not the name —
 * against the trees again.
 *
 * It names no destination for a move. A move onto a named child — `mv src
 * dir/name` — goes into whatever that name resolves to when `mv` runs, and
 * a review planted a link to a live artifact tree at the free name the
 * command had just checked, which carried the stage into the live session.
 * Instead each run that has anything left to move makes a new numbered
 * directory with `mkdir`, which fails on any name already there, enters it,
 * requires the directory it is in to be that one, and moves with `mv -n src
 * ./`: the only target is the directory the shell holds, and the name inside
 * it is the source's own. `-n` refuses to replace anything; GNU `mv` then
 * exits 1 and busybox `mv` exits 0, so neither exit status is trusted, and
 * each move is checked afterwards — the source gone — before the next. The
 * staging directory, or what is left of it, goes first and the record only
 * after it: a record moved while any of its directory is still in a session
 * tree would leave that directory to be carried home as an artifact, by a
 * restore that exits 0 without having finished.
 *
 * A move onto another filesystem is a copy and then a delete, so it can stop
 * part-way — out of space, a file it cannot read — and leave a partial copy,
 * or a whole copy with part of the original not yet deleted. Each file is
 * whole in at least one of the two places, since the delete starts only
 * once the copy has finished. The command says so and stops; the copy stays
 * where it is, and once the cause is fixed the identical command moves what
 * is left into the next numbered directory, beside it. The same holds when
 * it is killed part-way. A writer that changes the trees, the directory or
 * either source between a check and a move is outside what it guards: it
 * can have a different source moved in, or the directory itself moved, but
 * with nothing deleted and no named destination it cannot make the command
 * destroy anything or move into a place it did not check. It runs in a
 * subshell, so stopping does not close the shell it was pasted into. When
 * the agent directory already resolves into a session tree, no command is
 * given at all.
 *
 * Where a move stopped, the directory it was moving into is named by the
 * external `pwd -P`, run through `env`, because the shell's own builtin may
 * report the path it cached at `cd` (dash and busybox do) after someone
 * renamed a directory above it. That is a report, and only as honest as the
 * `env` and `pwd` on `PATH`: with no `env` the command names the path it
 * began with, marked so; a substituted `env` can name a wrong one. Either
 * misdirects the reader; neither makes the command move or delete anything.
 */
export async function stagingResidueNote(dir: string, record: string, consequence: string): Promise<string> {
	const agentDir = path.dirname(path.dirname(record));
	const roots = await stagingRoots(agentDir);
	const trees = roots.length > 0 ? roots.join(" and ") : "the sessions tree and the archive";
	const realAgentDir = await fs.realpath(agentDir).catch(() => undefined);
	let example: string;
	let afterSteps = "";
	if (realAgentDir !== undefined && !roots.some(root => isWithin(root, realAgentDir))) {
		const aside = path.join(realAgentDir, `gc-quarantine-${path.basename(record, ".json")}`);
		const realDir = await fs.realpath(dir).catch(() => dir);
		const realRecord = await fs.realpath(record).catch(() => record);
		const checks = [getSessionsDir(agentDir), getArchivedSessionsDir(agentDir)].map(shellQuote).join(" ");
		const sources = [path.dirname(realDir), path.dirname(realRecord)].map(shellQuote).join(" ");
		example =
			`for example \`(d=${shellQuote(aside)}; s=${shellQuote(realDir)}; c=${shellQuote(realRecord)}; inside() { ` +
			`for t in ${checks}; do t=$(realpath "$t") || exit 1; case "$1/" in "$t"/*) echo "$1 is inside the session ` +
			`tree $t, so nothing was moved" >&2; exit 1;; esac; done; }; there() { [ -e "$1" ] || [ -L "$1" ]; }; ` +
			`there "$s" || there "$c" || exit 0; for p in ${sources}; do [ -w "$p" ] || { echo "$p is not writable: ` +
			`make it writable with chmod u+w and run this command again" >&2; exit 1; }; done; ` +
			`p=$(realpath "\${d%/*}") || exit 1; inside "$p/\${d##*/}"; [ -d "$d" ] && [ ! -L "$d" ] || mkdir "$d" || ` +
			`exit 1; cd -P "$d" || exit 1; r=$(pwd -P); inside "$r"; k=1; while there "./$k"; do k=$((k+1)); done; ` +
			`mkdir "./$k" || exit 1; cd -P "./$k" || exit 1; [ "$(pwd -P)" = "$r/$k" ] || { echo "$r/$k is not the ` +
			`directory this command just made, so nothing was moved" >&2; exit 1; }; if there "$s"; then mv -n "$s" ./; ` +
			`there "$s" && { h=$(env pwd -P 2>/dev/null) && [ -n "$h" ] || h="$r/$k (its path when this command began)"; ` +
			`echo "the move of $s did not finish — it stopped part-way, or something ` +
			`already had its name in $h: anything it copied is in $h and the rest is still in $s; nothing was deleted, and once ` +
			`the cause is fixed this command, run again, moves what is left into a new directory beside it" >&2; exit 1; ` +
			`}; fi; if there "$c"; then mv -n "$c" ./; there "$c" && { echo "$c was not moved: once the cause is ` +
			`fixed, run this command again" >&2; exit 1; }; fi; exit 0)\`, which checks that both directories it moves ` +
			`out of are writable and that ` +
			`its directory is outside both session trees — by name before it makes the directory, and again on the ` +
			`directory it has entered — then, in a new numbered directory inside it that it has just made and entered, ` +
			`moves the staging directory, or what is left of it, and only then the record, checking after each move ` +
			`that it happened, and deletes nothing`;
		afterSteps =
			` If the command stops because a directory is not writable — it names the directory, usually ` +
			`${path.dirname(dir)}, which holds the staging directory, or ${path.dirname(record)}, which holds the record — ` +
			`make it writable with \`chmod u+w\` and run the command again. On a read-only mount, or for a file or ` +
			`directory marked immutable, \`chmod\` does not help: that has to be undone first. Whatever stops the command, ` +
			`a kill part-way included, fix the cause and run the identical command again: it continues from what it ` +
			`finds, and once nothing is left to move it exits 0 and does nothing. A move onto another filesystem is a ` +
			`copy and then a delete, so it can stop part-way; the command then says so, what was copied stays where it ` +
			`was put, and the next run moves what is left into a new numbered directory beside it. The command never ` +
			`deletes anything; once the restore has finished, what to keep of ${aside} is yours to decide.`;
	} else {
		example =
			`no example is given here, because ${agentDir} resolves to ${realAgentDir ?? "a path that could not be read"}, ` +
			`inside a session tree`;
	}
	return (
		`${dir} is named by the staging record ${record}, ${consequence}. If a killed gc run left it: 1. stop any gc run ` +
		`and any use of this session; 2. look at the record and the directory; 3. move the directory into a directory ` +
		`of their own whose real path is outside both session trees, ${trees}; 4. move the record into the same ` +
		`directory — ${example} — and leave any \`.restoring\` record where it is; 5. run the same command again, and ` +
		`if it then reports that a \`.restoring\` record was there before it, look at that record and move it ` +
		`aside.${afterSteps} Moving the record without the directory makes gc take the directory for an artifact. If ` +
		`no gc run made the directory, move only the record out of ${path.dirname(record)} and run the same command again`
	);
}

/** What a restore says about a recorded staging directory in the archived tree. */
export const ARCHIVED_RESIDUE = "so a restore leaves it in the archive, where it is, and does not finish";
/** What a restore says about a recorded staging directory in the live tree. */
export const LIVE_RESIDUE =
	"in the live artifact tree, where a killed restore leaves its stage, so a restore does not finish while it is there";

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
 */
export async function archiveIsPrefixOfLive(archiveFile: string, sessionPath: string): Promise<boolean> {
	// Non-blocking, so a FIFO at the live name is a refusal rather than a hang.
	const live = await openRegularFile(sessionPath).catch(notRegularAsAbsent);
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
	} catch {
		return false;
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
 * being re-archivable with nothing competing with it at all.
 */
export async function archivedHandleIsPrefixOfLive(archived: fs.FileHandle, livePath: string): Promise<boolean> {
	const live = await openRegularFile(livePath).catch(notRegularAsAbsent);
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
	} catch {
		return false;
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
 */
export async function archivedHandleIsHeldBy(
	archived: fs.FileHandle,
	archivedStat: Stats,
	candidatePath: string,
	transcript = false,
): Promise<boolean> {
	const candidate = await openRegularFile(candidatePath).catch(notRegularAsAbsent);
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
	} catch {
		return false;
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
	for await (const name of new Bun.Glob("**/*").scan({
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
 */
async function inflateArchivedHeaderId(archiveFile: string): Promise<string | undefined> {
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
	} catch {
		// Unreadable or damaged: the archive error paths report that on their own.
		return undefined;
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
 */
const RESTORE_LEASE_PASSES = 8;

interface RestoreLeases {
	/** Take the set again, for owners that have appeared since. False when one is live. */
	refresh(): Promise<boolean>;
	release(): void;
}

async function tryAcquireRestoreLeases(
	owners: () => Promise<(string | undefined)[]>,
	observeOnly = false,
): Promise<RestoreLeases | { unprobed: string } | null> {
	let unprobed: string | undefined;
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
					if (observeOnly) {
						// A preview looks without taking: a lease it held would make
						// a session opened meanwhile fork its turn into a new one.
						const held = isSessionLeaseHeld(id);
						if (held === null) throw new Error(`the ownership lease of session ${id} could not be probed`);
						if (held) return false;
					} else {
						const lease = tryAcquireSessionLease(id);
						if (!lease) return false;
						leases.push(lease);
					}
					leased.add(id);
					added = true;
				}
				if (!added) return true;
			}
			return false;
		} catch (error) {
			// A probe that throws says nothing about who owns what, and holding
			// what it took would read as a live owner to everything after it.
			// Kept, so the refusal says the look failed rather than that a
			// process owns the session.
			unprobed = errorText(error);
			return false;
		}
	};
	if (await refresh()) return { refresh, release };
	release();
	return unprobed === undefined ? null : { unprobed };
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
export async function restoreArchivedSessionLocked(
	archiveFile: string,
	agentDir?: string,
	plan?: RestorePlan,
	progress?: RestoreProgress,
): Promise<RestoredSession> {
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
	// name, or anywhere in either tree, owns nothing and must not hang this.
	const headerId = async (file: string): Promise<string | undefined> => {
		const handle = await openRegularFile(file).catch(error => {
			if (error instanceof NotARegularFile || codeOf(error) === "ENOTDIR") return undefined;
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
	// Said before anything else is done: finding the session's owners alone
	// reads every transcript in both trees, and a session with thousands of
	// artifacts took twenty seconds with nothing on the screen.
	if (!plan) progress?.(`Bringing session ${target} back from the archive…`);
	const acquired = await tryAcquireRestoreLeases(owners, plan !== undefined);
	if (acquired && "unprobed" in acquired) {
		throw new Error(
			`Cannot restore "${archiveFile}": a file of this session could not be read (${acquired.unprobed}), so whether ` +
				`a running process owns it is not known. Once it can be read, run \`${restoreCommand}\` again.`,
		);
	}
	const leases = acquired;
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
		// Planned: what creating the record needs — its directory written to —
		// and whether a file already at the name would be left, as below.
		let recordStanding = false;
		if (plan) {
			await planWritableDirectory(path.dirname(record), plan, "the restore record");
			recordStanding = (await statIfPresent(record)) !== undefined;
		} else {
			own = await createRestoreRecord(record, `${restoreCommand}\n`);
			if (own === undefined) {
				const late = await restoreRecordRefusal(record);
				if (late) throw new Error(late);
			}
		}
		const notes: string[] = [];
		let bytes: number;
		if (await statIfPresent(sessionPath)) {
			// The transcript is already live. Either another process restored it
			// while this one waited for the lock, or an earlier attempt moved the
			// transcript and failed on its artifact tree. Finishing that attempt is
			// the only way the tree comes home, so a retry resumes rather than
			// refusing — for this session, carried on or not, never another.
			if ((await statIfPresent(archiveFile)) && !(await archiveIsPrefixOfLive(archiveFile, sessionPath))) {
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
		} else if (plan) {
			// What inflating the transcript needs: its directory, a staging
			// record, and an archive that reads whole.
			await planWritableDirectory(path.dirname(sessionPath), plan, archiveFile);
			await planLedger(ledger, plan);
			bytes = (await inflateArchivedBytes(archiveFile)).byteLength;
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
				// A count once a second, and the last one, while the tree comes home.
				let onFile: (() => void) | undefined;
				if (progress && !plan) {
					const total = (await treeFiles(archiveArtifacts)).length;
					let done = 0;
					let saidAt = Date.now();
					const say = (): void =>
						progress(`Bringing session ${target} back from the archive: ${done} of ${total} artifact files`);
					say();
					onFile = () => {
						done += 1;
						if (done === total || Date.now() - saidAt >= 1000) {
							saidAt = Date.now();
							say();
						}
					};
				}
				const leftOut = await copyTreeDereferenced(
					archiveArtifacts,
					liveArtifacts,
					stagingAgentDir,
					notes,
					plan,
					onFile,
				);
				if (!(await leases.refresh())) throw noOwners();
				if ((await ownerSignature(owners)) !== leasedOwners) {
					throw new Error(
						`the subagent sessions below ${archiveArtifacts} changed while it was being restored; ` +
							`everything carried home is there and the archive is untouched — ` +
							`run \`${restoreCommand}\` again`,
					);
				}
				// Leaving anything out is not a finished restore: each directory
				// is named, the record stays down and the command fails. The
				// directory stays in the archive, and nothing here suggests
				// removing it.
				for (const [dir, staging] of leftOut)
					notRestored.push(await stagingResidueNote(dir, staging, ARCHIVED_RESIDUE));
				artifactsRestored = leftOut.length === 0;
			} catch (error) {
				notRestored.push(
					`the artifact tree (subagent transcripts, tool output) at ${archiveArtifacts} ${
						plan ? "would not be" : "was not"
					} restored whole: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		// A restore killed while it staged left its stage in the live tree;
		// until that is moved out, this restore has not finished — whether or
		// not the archive still has an artifact tree to carry.
		try {
			const residue = await recordedStagingIn(stagingAgentDir, liveArtifacts);
			for (const { dir, record: staging } of residue) {
				notRestored.push(await stagingResidueNote(dir, staging, LIVE_RESIDUE));
			}
			if (residue.length > 0) artifactsRestored = false;
		} catch (error) {
			artifactsRestored = false;
			notRestored.push(`the live artifact tree at ${liveArtifacts} could not be checked: ${errorText(error)}`);
		}
		notRestored.push(...notes);
		if (plan) {
			if (recordStanding) notRestored.push(restoreRecordLeftNote(record));
		} else if (own === undefined) {
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
export async function restoreArchivedSession(
	archiveFile: string,
	agentDir?: string,
	progress?: RestoreProgress,
): Promise<RestoredSession> {
	const dir = agentDir ?? getAgentDir();
	try {
		return await withGcLock(dir, () => restoreArchivedSessionLocked(archiveFile, dir, undefined, progress), {
			waitMs: 30_000,
		});
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
export async function materializeSessionFile(
	sessionFile: string,
	agentDir?: string,
	progress?: RestoreProgress,
): Promise<string> {
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
	const restored = await restoreArchivedSession(archived, agentDir, progress);
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
