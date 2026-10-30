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
import { constants as fsConstants, type Stats } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { getAgentDir, getSessionsDir, isEnoent, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { codeOf, statIfPresent, withGcLock } from "./gc-lock";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { readSessionHeaderId, sessionHeaderIdFromBytes } from "./session-loader";
import { SESSION_STAGING_RE, sessionStagingPath, tryAcquireSessionLease } from "./session-storage";
import { parseTitleSlotFromContent, parseTitleSlotLine } from "./session-title-slot";

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
 * is a link, which the archive and the sessions tree being on different
 * filesystems would otherwise rule out.
 *
 * `link`, not `rename`: a transcript only comes out of the archive onto a
 * path nothing holds, so a file that appeared there in the meantime is
 * someone's work. `EEXIST` says so instead of writing over it.
 */
export async function inflateArchivedTranscript(
	source: string,
	destination: string,
	notes: string[] = [],
): Promise<number> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const ground = await mintStagingGround(destination);
	const tempPath = ground.file;
	let handle: fs.FileHandle | undefined;
	let staged: Stats | undefined;
	try {
		// Inside a directory this run minted, so the name this publication
		// reads from is not one anybody else can bind, and the cleanup is
		// that directory rather than a name a check had to vouch for.
		handle = await fs.open(tempPath, "wx");
		staged = await handle.stat();
		const written = await inflateIntoHandleWithDigest(Bun.file(source).stream(), handle);
		const landed = await fs.lstat(tempPath).catch(() => undefined);
		if (landed?.dev !== staged.dev || landed.ino !== staged.ino) {
			throw new Error(`${tempPath} was replaced while the transcript was being written`);
		}
		await fs.link(tempPath, destination);
		// What was published, read back through a descriptor: non-blocking
		// against a FIFO, `fstat` for a regular file, `lstat` against a
		// symlink onto the very file just written, and then the digest,
		// which is the only one of the four that is about bytes.
		const published = await openRegularFile(destination);
		if (!published) throw new Error(`${destination} is not the transcript this restore wrote`);
		try {
			if (!(await fs.lstat(destination).catch(() => undefined))?.isFile()) {
				throw new Error(`${destination} is not the transcript this restore wrote`);
			}
			const back = await digestOfHandle(published);
			if (back.hash !== written.hash || back.size !== written.size) {
				throw new Error(`${destination} is not the transcript this restore wrote`);
			}
		} finally {
			await published.close().catch(() => undefined);
		}
		return written.size;
	} catch (error) {
		throw archiveReadError(source, error);
	} finally {
		try {
			const note = await removeStagingGround(ground, staged);
			if (note) notes.push(note);
		} finally {
			await handle?.close().catch(() => undefined);
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
async function* bytesOfHandle(handle: fs.FileHandle): AsyncGenerator<Uint8Array> {
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
	source: ReadableStream<Uint8Array>,
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
 * A descriptor on `file` only when `file` is a regular file.
 *
 * Non-blocking, because an ordinary read-only open of a FIFO waits for a
 * writer that may never come: the live tree is the user's, anything can be
 * at a path in it, and a resume that hangs on one is worse than a resume
 * that refuses. The check is `fstat` on what was opened, not `lstat` on the
 * name, so the answer is about the file the descriptor holds.
 */
export async function openRegularFile(file: string): Promise<fs.FileHandle | undefined> {
	const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
		if (isEnoent(error)) return undefined;
		// A FIFO with no writer, or a device nobody is driving.
		if (codeOf(error) === "ENXIO") return undefined;
		throw error;
	});
	if (!handle) return undefined;
	if ((await handle.stat()).isFile()) return handle;
	await handle.close().catch(() => undefined);
	return undefined;
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
	const real = await fs.realpath(destination).catch(() => undefined);
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
async function assertLiveTreeHoldsArchive(source: string, destination: string, archiveRoot: string): Promise<void> {
	const stat = await fs.lstat(source).catch(error => {
		// Only absence. An I/O error says nothing about what is there, and
		// reading it as "nothing" is how a file nobody could stat is passed
		// over as already carried.
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat) return;
	if (stat.isDirectory()) {
		const live = await statIfPresent(destination);
		if (!live?.isDirectory()) {
			throw new Error(`${destination} is not a directory holding what ${source} holds`);
		}
		if (live.dev === stat.dev && live.ino === stat.ino) {
			throw new Error(`${destination} is the archived directory ${source} itself, not a copy of it`);
		}
		for (const entry of (await fs.readdir(source)).sort()) {
			await assertLiveTreeHoldsArchive(path.join(source, entry), path.join(destination, entry), archiveRoot);
		}
		return;
	}
	// A link, a device, or a killed writer's staging residue: none of them was
	// carried home and none of them is an artifact.
	if (!stat.isFile() || SESSION_STAGING_RE.test(path.basename(source))) return;
	const live = await fs.open(destination, "r").catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	try {
		const liveStat = await live?.stat();
		if (!live || !liveStat?.isFile()) {
			throw new Error(`${destination} does not hold what the archived ${source} holds`);
		}
		if (!(await survivesRemovalOf(destination, liveStat, stat, archiveRoot))) {
			throw new Error(`${destination} is the archived ${source} itself, not a second copy of it`);
		}
		if (!(await sourceIsPrefixOfDestination(Bun.file(source).stream(), live, false))) {
			throw new Error(`${destination} does not hold what the archived ${source} holds`);
		}
	} finally {
		await live?.close();
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
 * file — is reported, and the archive keeps its copy.
 *
 * A destination that is the archived entry itself under another name, or that
 * would not survive the archive tree being removed, is reported too — see
 * {@link survivesRemovalOf}. An unreadable destination is reported as well: a
 * permission or I/O failure says nothing about what is there, and only its
 * absence may be read as an empty slot.
 *
 * Staging residue the archive happens to hold is not an artifact and is not
 * carried home; the sweep that reclaims a killed writer's temps owns it.
 */
async function copyEntryDereferenced(
	source: string,
	destination: string,
	archiveRoot: string,
	notes: string[],
): Promise<void> {
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
		if (!existing) await fs.chmod(destination, stat.mode & 0o7777);
		// Sorted, so a restore that stops part-way is reproducible from its report.
		for (const entry of (await fs.readdir(source)).sort()) {
			await copyEntryDereferenced(path.join(source, entry), path.join(destination, entry), archiveRoot, notes);
		}
		return;
	}
	if (!stat.isFile()) return;
	if (SESSION_STAGING_RE.test(path.basename(source))) return;
	if (existing) {
		const live = await openRegularFile(destination);
		try {
			if (live) {
				const target = await live.stat();
				if (!(await survivesRemovalOf(destination, target, stat, archiveRoot))) {
					throw new Error(
						`${destination} is the archived ${source} itself, not a second copy of it; ` +
							`the archive is kept — give the live tree a file of its own and restore again`,
					);
				}
				if (await sourceIsPrefixOfDestination(Bun.file(source).stream(), live, false)) return;
			}
		} finally {
			await live?.close();
		}
		throw new Error(
			`${destination} already holds something else, so the archived ${source} was left in the archive; ` +
				`move that path aside and restore again`,
		);
	}
	// Staged inside a directory this run mints, so nothing of anyone else's
	// can wear the name this publication reads from, and the cleanup is the
	// directory rather than a name a check had to vouch for.
	const ground = await mintStagingGround(destination);
	let staged: fs.FileHandle | undefined;
	let stagedStat: Stats | undefined;
	try {
		staged = await fs.open(ground.file, "wx", stat.mode & 0o7777);
		stagedStat = await staged.stat();
		const archived = await fs.open(source, "r");
		let written: CopiedBytes;
		try {
			written = await copyHandleWithDigest(archived, staged);
		} finally {
			await archived.close().catch(() => undefined);
		}
		await staged.chmod(stat.mode & 0o7777);
		// `link`, not `rename`: a file someone created at the destination while
		// this copy was being staged is their work, and a rename would write
		// over it without anyone asking. `EEXIST` sends this entry down the
		// "already holds something else" road on the next attempt instead.
		await fs.link(ground.file, destination);
		// What landed, read back: opened non-blocking so a FIFO cannot hang
		// this, `fstat`ed and `lstat`ed for a regular file that is not a
		// link, and then digested against what was written.
		const published = await openRegularFile(destination);
		const wrong = (): Error =>
			new Error(`${destination} is not the copy of ${source} this restore wrote, so it was left as it is`);
		if (!published) throw wrong();
		try {
			if (!(await fs.lstat(destination).catch(() => undefined))?.isFile()) throw wrong();
			const back = await digestOfHandle(published);
			if (back.hash !== written.hash || back.size !== written.size) throw wrong();
		} finally {
			await published.close().catch(() => undefined);
		}
	} finally {
		try {
			const note = await removeStagingGround(ground, stagedStat);
			if (note) notes.push(note);
		} finally {
			await staged?.close().catch(() => undefined);
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
 * place each time. So the session ends up in two places and the archive
 * phase, which an operator names and acknowledges, is the only thing that
 * takes one away.
 */
async function copyTreeDereferenced(source: string, destination: string, notes: string[]): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const archiveRoot = await fs.realpath(source);
	await copyEntryDereferenced(source, destination, archiveRoot, notes);
	await assertLiveTreeHoldsArchive(source, destination, archiveRoot);
}

/** A private directory this run minted, and the staging path inside it. */
export interface StagingGround {
	dir: string;
	file: string;
}

/**
 * Mint a staging directory of this run's own beside `target`.
 *
 * `mkdir` without `recursive`, so `EEXIST` is the kernel saying the name is
 * taken and another is minted — uniqueness comes from the kernel rather
 * than from a name this process picked. Mode `0700`, so what is inside is
 * this run's until it publishes it.
 *
 * The directory is what makes the cleanup honest. There is no way to unlink
 * an inode: `unlinkat` takes a name, so any identity check is taken at one
 * moment and acted on at another, and a staging path anyone could rebind
 * between the two is a file somebody else's bytes can end up at. Inside
 * ground this run minted, the only actor who can arrange that is one who
 * can already write in a `0700` directory that did not exist a moment ago.
 *
 * The name matches {@link SESSION_STAGING_RE}, so the sweep that reclaims
 * an interrupted run's leftovers recognises it.
 */
export async function mintStagingGround(target: string): Promise<StagingGround> {
	for (;;) {
		const dir = sessionStagingPath(target);
		try {
			await fs.mkdir(dir, { mode: 0o700 });
		} catch (error) {
			if (codeOf(error) === "EEXIST") continue;
			throw error;
		}
		return { dir, file: path.join(dir, path.basename(target)) };
	}
}

/**
 * Take the staging ground away again, with what this run put there.
 *
 * Anything else inside it is reported rather than deleted, and a failure to
 * look is reported rather than read as an absence: "it was not there" and "I
 * could not tell" are different answers, and treating the second as the
 * first is how a foreign file disappears into an empty error list. The
 * sentence returned is the one for the command to print; nothing here
 * throws, because this runs on the way out of a failure as often as a
 * success.
 */
export async function removeStagingGround(
	ground: StagingGround,
	created: Stats | undefined,
): Promise<string | undefined> {
	const notes: string[] = [];
	const entries = await fs.readdir(ground.dir).catch(error => {
		if (isEnoent(error)) return undefined;
		notes.push(`${ground.dir} could not be read, so it was left as it is: ${error}`);
		return undefined;
	});
	if (entries === undefined) return notes[0];
	for (const name of entries) {
		const at = path.join(ground.dir, name);
		const standing = await fs.lstat(at).catch(error => {
			if (!isEnoent(error)) notes.push(`${at} could not be read, so it was left alone: ${error}`);
			return undefined;
		});
		if (!standing) continue;
		if (at !== ground.file || !created || standing.dev !== created.dev || standing.ino !== created.ino) {
			notes.push(`${at} is not what this run staged there, so it was left alone`);
			continue;
		}
		await fs.rm(at).catch((error: unknown) => notes.push(`${at} could not be removed: ${error}`));
	}
	if (notes.length === 0) {
		await fs.rmdir(ground.dir).catch((error: unknown) => {
			if (!isEnoent(error)) notes.push(`${ground.dir} could not be removed: ${error}`);
		});
	}
	return notes.length > 0 ? notes.join("; ") : undefined;
}
/**
 * Archived paths with no live counterpart, as relative names.
 *
 * The question a stale restore record raises: has the live tree caught up
 * with what the archive holds? Presence, not sameness — a session that
 * carried on diverges from its archive by design — and only enough of it to
 * decide whether an unfinished restore is still unfinished.
 */
export async function archivedPathsWithoutLiveCopies(archiveFile: string, sessionFile: string): Promise<string[]> {
	const archiveArtifacts = archiveFile.slice(0, -ARCHIVED_SESSION_SUFFIX.length);
	const liveArtifacts = sessionFile.slice(0, -SESSION_SUFFIX.length);
	const outstanding: string[] = [];
	for (const file of await treeFiles(archiveArtifacts)) {
		if (SESSION_STAGING_RE.test(path.basename(file))) continue;
		const name = path.relative(archiveArtifacts, file);
		if (!(await statIfPresent(path.join(liveArtifacts, name)))) outstanding.push(name);
	}
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
	const live = await fs.open(sessionPath, "r");
	try {
		let holds = false;
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
			holds = await sourceIsPrefixOfDestination(source as AsyncIterable<Uint8Array>, live, true);
		});
		if (holds) return true;
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
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
	const live = await fs.open(livePath, "r");
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
	const candidate = await fs.open(candidatePath, "r").catch(() => undefined);
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
		await pipeline(Bun.file(archiveFile).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
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
 * Leases of every transcript a restore moves: the session's own, read from
 * the header rather than from the archive's filename, and those nested in
 * either artifact tree, found the same way.
 *
 * This has to match what the archive phase acquires, or the two disagree
 * about who owns what. A filename is not a session id — archiving accepts a
 * transcript called anything, and the id lives in the header — and a
 * parent's lease says nothing about the subagent sessions below it, which is
 * why archiving leases the whole tree and skips a session whose child is
 * live. A restore moving those files while their owners held their leases
 * would lose exactly the writes the lease exists to protect.
 *
 * The set is taken to a fixed point rather than calculated once, and it is
 * taken again immediately before the artifact tree moves: a subagent can
 * appear in the tree between an enumeration and the first copy, and a set
 * only as fresh as its first pass would not cover it. Each pass enumerates
 * again while holding everything the pass before it took, so a child that
 * appears is either leased too or refuses the run. Passes stop when one
 * finds nothing new; a tree that never settles is refused rather than
 * chased.
 *
 * Null, with everything taken so far released, when any of them is live.
 */
const RESTORE_LEASE_PASSES = 8;

interface RestoreLeases {
	/** Take the set again, for owners that have appeared since. False when one is live. */
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
		} catch {
			// A probe that throws says nothing about who owns what, and holding
			// what it took would read as a live owner to everything after it.
			return false;
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
 * and drop the archive copy so the session exists in exactly one place.
 *
 * The caller must hold the gc lock: between the transcript landing and the
 * artifact tree following it, the session exists in both trees, and an
 * archive phase running in that window would move the halves past each other.
 *
 * Ownership leases are taken first, for every transcript the restore moves —
 * the session's own, read from its header, and every nested one in either
 * artifact tree — matching what the archive phase acquires. See
 * {@link tryAcquireRestoreLeases}.
 *
 * What a refusal leaves, because "both copies whole" is not the same as a
 * transaction and this is not one:
 *
 * - No archived bytes are ever lost. Every path that gives one up proves
 *   first that the live tree holds it, and the archive is set aside rather
 *   than deleted until that proof has been taken again with the whole move
 *   finished — see {@link copyTreeDereferenced}.
 * - A refusal before the copy leaves both trees untouched.
 * - A refusal during the copy leaves the live tree holding the entries
 *   carried so far, with the archive still complete. Running the restore
 *   again finishes it; the entries already there are recognised rather than
 *   copied twice.
 * - A refusal after the copy — a changed owner set, a live file that no
 *   longer holds what the archive held — puts every retired entry back and
 *   leaves the live tree holding the whole copy. The archive is complete,
 *   the live tree is complete, and the space is not reclaimed until a later
 *   run succeeds.
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
	const owners = async (): Promise<(string | undefined)[]> => [
		await inflateArchivedHeaderId(archiveFile),
		...(await Promise.all(
			[...(await treeFiles(archiveArtifacts)), ...(await treeFiles(liveArtifacts)), sessionPath].map(file =>
				readSessionHeaderId(file),
			),
		)),
	];
	const stem = path.basename(archiveFile, ARCHIVED_SESSION_SUFFIX);
	const target = stem.slice(stem.lastIndexOf("_") + 1) || stem;
	const restoreCommand = `omp gc --restore ${shellQuote(target)} --apply${agentDirFlag(agentDir ?? agentDirOfArchivedPath(archiveFile) ?? getAgentDir())}`;
	const leases = await tryAcquireRestoreLeases(owners);
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
	try {
		// The record goes down before anything is published and comes up only
		// when everything is home. Nothing that runs later has to work out from
		// the live tree whether this finished, which is the question every
		// earlier version of this got wrong in both directions.
		await fs.mkdir(path.dirname(record), { recursive: true });
		await fs.writeFile(record, `${restoreCommand}\n`);
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
		} else {
			bytes = await inflateArchivedTranscript(archiveFile, sessionPath, notes);
		}

		const notRestored: string[] = [];
		const hasArtifacts = (await statIfPresent(archiveArtifacts)) !== undefined;
		let artifactsRestored = !hasArtifacts && (await statIfPresent(liveArtifacts)) !== undefined;
		// Neither copy goes. The restore publishes the session into the live
		// tree and leaves the archive where it is, so `omp gc --archive`,
		// which an operator invokes by name and acknowledges, stays the only
		// step that takes a copy away. Re-archiving the session recognises
		// its own archive and finishes the move; until someone asks, the
		// space is not reclaimed, which is the cost this feature can afford.
		if (!(await leases.refresh())) throw noOwners();
		const leasedOwners = await ownerSignature(owners);
		if (hasArtifacts) {
			try {
				await copyTreeDereferenced(archiveArtifacts, liveArtifacts, notes);
				if (!(await leases.refresh())) throw noOwners();
				if ((await ownerSignature(owners)) !== leasedOwners) {
					throw new Error(
						`the subagent sessions below ${archiveArtifacts} changed while it was being restored; ` +
							`everything carried home is there and the archive is untouched — ` +
							`run \`${restoreCommand}\` again`,
					);
				}
				artifactsRestored = true;
			} catch (error) {
				notRestored.push(
					`the artifact tree (subagent transcripts, tool output) at ${archiveArtifacts}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		notRestored.push(...notes);
		if (notRestored.length === 0) await fs.rm(record, { force: true });
		else await fs.writeFile(record, `${restoreCommand}\n${notRestored.join("\n")}\n`);
		return { sessionPath, archivePath: archiveFile, bytes, artifactsRestored, notRestored };
	} finally {
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
			`Restored the transcript of "${archived}" to ${restored.sessionPath}, but could not restore ${restored.notRestored.join("; ")}. ` +
				`The archive is kept; \`${retry}\` retries it once the path is clear.`,
		);
	}
	return restored.sessionPath;
}
