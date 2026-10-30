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
import { SESSION_STAGING_RE, sessionStagingPath } from "./session-storage";
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
 * Whether a path is a session transcript by name — the `.jsonl` the writer
 * gives one, in the sessions tree and nested in an artifact tree.
 *
 * Provenance, not shape: a tool-output log may happen to open with a record
 * that looks like a session header, and reading its bytes as a session's name
 * is how its content becomes ignorable. Only a file omp itself writes as a
 * transcript gets transcript semantics.
 */
function isTranscriptPath(file: string): boolean {
	return file.endsWith(SESSION_SUFFIX);
}

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
 * Fields `migrateToCurrentVersion` rewrites rather than preserves, by the
 * version the archived copy was written at.
 *
 * A v1 transcript gets the entry tree it never had: `migrateV1ToV2` assigns
 * every non-session record a fresh `id` and a `parentId`, and turns a
 * compaction's `firstKeptEntryIndex` into `firstKeptEntryId`. Those are the
 * migration's own bookkeeping, not the conversation, so they are set aside
 * for a transcript archived before version 2 and compared for every other.
 * Everything a record says — its type, its message, its content — is still
 * compared, so a rewritten history is still a different session.
 */
const MIGRATED_RECORD_FIELDS: Record<string, true> = {
	id: true,
	parentId: true,
	firstKeptEntryIndex: true,
	firstKeptEntryId: true,
};

/** Whether `holder` carries `held`, allowing for the migrations `version` has since been through. */
function recordIsCarried(held: unknown, holder: unknown, version: number): boolean {
	if (typeof held !== "object" || held === null || Array.isArray(held)) return jsonContains(held, holder);
	if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return false;
	const a = held as Record<string, unknown>;
	const b = holder as Record<string, unknown>;
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
	for (;;) {
		const next = await nextRecord(archived);
		if (!next) return true;
		const onto = await nextRecord(live);
		if (!onto) return false;
		if (next.raw === onto.raw) continue;
		if (next.value === undefined || onto.value === undefined) return false;
		if (!recordIsCarried(next.value, onto.value, version)) return false;
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
 * Remove the archive tree, one entry at a time, each only once that entry has
 * been shown to have an independent live copy carrying its content.
 *
 * Checking the whole tree and then deleting it leaves the whole deletion
 * standing on observations taken before it started; checking a file by size
 * and inode leaves it standing on the wrong question, because content that
 * changed to the same length passes both. So each file is compared in full
 * through a descriptor of its own and unlinked immediately after, which is
 * the narrowest order POSIX allows. A live writer that ignores the gc lock
 * can still change a file in the gap between one entry's check and its
 * unlink; nothing short of holding the whole tree open closes that, and the
 * lock is what cooperating writers use.
 */
async function removeArchiveTreeOnceCarried(source: string, destination: string, archiveRoot: string): Promise<void> {
	const stat = await fs.lstat(source).catch(error => {
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
			await removeArchiveTreeOnceCarried(path.join(source, entry), path.join(destination, entry), archiveRoot);
		}
		await fs.rmdir(source);
		return;
	}
	if (!stat.isFile() || SESSION_STAGING_RE.test(path.basename(source))) {
		// A link, a device, or a killed writer's staging residue: none of them
		// was carried home, and the name is all there is to drop.
		await fs.unlink(source);
		return;
	}
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
		const transcript = isTranscriptPath(source);
		if (
			!(await sourceIsPrefixOfDestination(Bun.file(source).stream(), live, transcript)) &&
			!(transcript && (await recordsAreCarried(linesOf(Bun.file(source).stream()), linesOfHandle(live))))
		) {
			throw new Error(`${destination} no longer holds what the archived ${source} holds`);
		}
	} finally {
		await live?.close();
	}
	await fs.unlink(source);
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
async function copyEntryDereferenced(source: string, destination: string, archiveRoot: string): Promise<void> {
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
			await copyEntryDereferenced(path.join(source, entry), path.join(destination, entry), archiveRoot);
		}
		return;
	}
	if (!stat.isFile()) return;
	if (SESSION_STAGING_RE.test(path.basename(source))) return;
	if (existing) {
		const live = await fs.open(destination, "r").catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		try {
			const target = await live?.stat();
			if (live && target?.isFile()) {
				if (!(await survivesRemovalOf(destination, target, stat, archiveRoot))) {
					throw new Error(
						`${destination} is the archived ${source} itself, not a second copy of it; ` +
							`the archive is kept — give the live tree a file of its own and restore again`,
					);
				}
				const transcript = isTranscriptPath(source);
				if (await sourceIsPrefixOfDestination(Bun.file(source).stream(), live, transcript)) return;
				if (transcript && (await recordsAreCarried(linesOf(Bun.file(source).stream()), linesOfHandle(live)))) {
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
	// Named so `omp gc` reclaims it: a killed copy leaves it behind, and the
	// staging sweep already clears a writer's abandoned temps.
	const tempPath = sessionStagingPath(destination);
	try {
		await fs.copyFile(source, tempPath);
		// `link`, not `rename`: a file someone created at the destination while
		// this copy was being staged is their work, and a rename would write
		// over it without anyone asking. `EEXIST` sends this entry down the
		// "already holds something else" road on the next attempt instead.
		await fs.link(tempPath, destination);
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

/**
 * Bring an archived artifact tree home, then drop the archive's copy — one
 * entry at a time, each only once that entry has been shown to have an
 * independent live copy still carrying its content. See
 * {@link removeArchiveTreeOnceCarried}.
 */
async function copyTreeDereferenced(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const archiveRoot = await fs.realpath(source);
	await copyEntryDereferenced(source, destination, archiveRoot);
	await removeArchiveTreeOnceCarried(source, destination, archiveRoot);
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
 * Whether the file at `candidatePath` holds every byte the already-open
 * `archived` handle has, and is not that same file.
 *
 * The archive phase asks this immediately before it publishes a replacement
 * for an artifact the archive already holds, with the existing archived copy
 * pinned by the descriptor it read: a path swapped underneath cannot turn the
 * answer into permission to overwrite something that was never examined.
 */
export async function archivedHandleIsHeldBy(
	archived: fs.FileHandle,
	archivedStat: Stats,
	candidatePath: string,
	transcript = isTranscriptPath(candidatePath),
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
