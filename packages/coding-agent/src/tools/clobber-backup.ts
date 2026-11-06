/**
 * Copy-before-clobber: keep the bytes a session is about to destroy.
 *
 * Two mutations end badly often enough to be worth insuring against:
 *
 * 1. A session replaces or deletes a whole file it did not create. Whatever was
 *    in it is gone the instant the write lands — there is no undo, and for a
 *    file no version control tracks there is nothing to go back to.
 * 2. A session writes under ANOTHER session's directory. A live transcript or a
 *    sibling's artifact has no other copy anywhere.
 *
 * Before either, the caller copies the old content aside and tells the model
 * where it went. Nothing is blocked, refused, or held for approval: a write
 * that would have happened still happens, byte for byte, and a backup that
 * cannot be taken degrades to a note saying so. Nothing here throws.
 *
 * What it costs on the ordinary path — a session rewriting a file it created —
 * is two `stat`s and two `realpath`s: one pair to decide (measured ~96 µs) and
 * one in {@link noteOwnWrite} to refresh the record (~38 µs), against a write
 * that takes milliseconds. The `realpath`s are what make the sessions-root test
 * agree with itself when `~/.omp` or the target is reached through a symlink; a
 * lexical test is cheaper and would under-insure.
 *
 * Bounds (see {@link RETENTION_DAYS}, {@link STORE_BUDGET_BYTES},
 * {@link MAX_BACKUP_BYTES}): copies live under `~/.omp/agent/clobbered/<date>/`
 * for two weeks, and completed days are swept back under a byte budget once per
 * process per day. The budget does NOT bound the current day — a process that
 * rewrites large files all day keeps every copy until tomorrow's sweep — and a
 * single file past the per-file cap is reported rather than copied.
 */
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { shortenEmbeddedPaths, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getClobberBackupsDir, getSessionsDir, pathIsWithin } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Day directories older than this are swept. Two weeks outlives a weekend plus the week it takes to notice. */
const RETENTION_DAYS = 14;

/** Bytes the COMPLETED days may hold after a sweep. Oldest go first; the current day is never swept. */
const STORE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Largest file copied aside. Past this the loss is reported instead, so one huge write cannot fill the disk. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/**
 * Suffix on a copy that outgrew {@link MAX_BACKUP_BYTES} while it was being
 * taken. The cap is decided from a `stat` before the copy, so a source another
 * writer extends in between lands a copy above it. Throwing that copy away to
 * keep the arithmetic tidy would destroy the one thing this module exists to
 * keep, so it is kept and marked, and the sweep weighs a marked copy instead of
 * assuming the cap holds for it.
 */
const OVERSIZE_SUFFIX = ".oversize";

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const INDEX_NAME = "index.jsonl";

/**
 * Why the old content was worth keeping. `changed-since` is separate from
 * `not-created-here` so the note never tells a session it did not write a file
 * it did: an external `chmod`, a new hard link or a timestamp-preserving copy
 * all move the recorded identity, and the honest thing to say is that the file
 * changed, not that it was never ours.
 */
export type ClobberReason = "not-created-here" | "changed-since" | "foreign-session-dir";

/** What happened to the bytes a mutation was about to destroy. */
export type ClobberBackup =
	| { kind: "saved"; reason: ClobberReason; from: string; to: string; bytes: number }
	| { kind: "too-large"; reason: ClobberReason; from: string; bytes: number }
	| { kind: "failed"; reason: ClobberReason; from: string; error: string };

/**
 * What a path looked like when this session last wrote it. The inode catches a
 * delete and recreate; `ctimeMs` catches the rest of what `mtimeMs` misses,
 * because a `cp --preserve=timestamps` or a restore from an archive can put
 * someone else's equal-length bytes there with the mtime this session left.
 * The kernel moves ctime on any write, and no ordinary tool can forge it.
 */
interface WrittenFile {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
}

/**
 * The files this session brought into existence, and the identity of the
 * session that did. A `ToolSession` outlives the logical session it serves
 * (the SDK re-points `getSessionFile`), so the key is re-checked on every use
 * and a change throws the whole set away rather than letting one session
 * inherit another's exemptions.
 */
export interface ClobberCreatedFiles {
	key: string;
	byPath: Map<string, WrittenFile>;
}

/** Owner of the per-session created-file record. Lives on the `ToolSession` the way the edit store does. */
export interface ClobberBackupOwner {
	clobberCreatedPaths?: ClobberCreatedFiles;
}

/** The session facts a backup decision needs. A structural subset of `ToolSession`. */
export interface ClobberBackupSession extends ClobberBackupOwner {
	cwd: string;
	getSessionFile?: () => string | null;
	getSessionId?: () => string | null;
}

/** Identity of the logical session behind a `ToolSession` right now. */
function sessionKey(session: ClobberBackupSession): string {
	return `${session.getSessionFile?.() ?? ""}\u0000${session.getSessionId?.() ?? ""}`;
}

/** The session's created-file record, emptied when the session it belongs to has changed. */
function createdFiles(session: ClobberBackupSession): ClobberCreatedFiles {
	const key = sessionKey(session);
	const existing = session.clobberCreatedPaths;
	if (existing?.key === key) return existing;
	const fresh: ClobberCreatedFiles = { key, byPath: new Map<string, WrittenFile>() };
	session.clobberCreatedPaths = fresh;
	return fresh;
}

/**
 * Realpath memo. Every comparison below runs on resolved paths so one spelling
 * of `~/.omp` cannot be called foreign to another; the memo keeps the sessions
 * root and the session's own transcript off the syscall path after first use.
 * Bounded because a long session touches many files and this is not a cache
 * anyone reads twice.
 */
const realPathMemo = new Map<string, string>();
const REAL_PATH_MEMO_MAX = 64;

/** `target` with every symlink resolved, or its lexically resolved form when it cannot be. */
function realPath(target: string, memoize: boolean): string {
	const resolved = path.resolve(target);
	if (memoize) {
		const hit = realPathMemo.get(resolved);
		if (hit !== undefined) return hit;
	}
	let real: string;
	try {
		real = realpathSync.native(resolved);
	} catch {
		real = resolved;
	}
	if (memoize) {
		if (realPathMemo.size >= REAL_PATH_MEMO_MAX) realPathMemo.clear();
		realPathMemo.set(resolved, real);
	}
	return real;
}

/**
 * True when `realTarget` sits under the sessions root but outside everything
 * this session owns there — another session's transcript, its artifacts, or
 * another project's bucket. A session owns its own transcript file and the
 * directory of the same name without `.jsonl`, and nothing else.
 *
 * Deliberately not `getArtifactsDir()`: a subagent adopts its parent's artifact
 * manager, so that getter returns the PARENT's directory and would exempt
 * exactly the writes this trigger exists to insure.
 *
 * A session with no transcript (print mode, SDK embedding, a bare tool session)
 * owns nothing under the root, so every write there is insured. That is the
 * safe direction: it copies more, never less.
 */
function isForeignSessionDirectory(session: ClobberBackupSession, realTarget: string): boolean {
	let sessionsRoot: string;
	try {
		sessionsRoot = realPath(getSessionsDir(), true);
	} catch {
		return false;
	}
	if (!pathIsWithin(sessionsRoot, realTarget)) return false;
	const sessionFile = session.getSessionFile?.();
	if (sessionFile) {
		const own = realPath(sessionFile, true);
		if (own === realTarget) return false;
		const ownArtifacts = own.endsWith(".jsonl") ? own.slice(0, -".jsonl".length) : own;
		if (pathIsWithin(ownArtifacts, realTarget)) return false;
	}
	return true;
}

/** The reason this mutation needs insuring, or `undefined` when it destroys only this session's own work. */
function clobberReason(
	session: ClobberBackupSession,
	realTarget: string,
	stat: WrittenFile,
): ClobberReason | undefined {
	if (isForeignSessionDirectory(session, realTarget)) return "foreign-session-dir";
	const written = createdFiles(session).byPath.get(realTarget);
	if (!written) return "not-created-here";
	// Same path is not enough: another writer may have replaced the content, or
	// the file itself, since this session wrote it.
	if (
		written.size === stat.size &&
		written.mtimeMs === stat.mtimeMs &&
		written.ctimeMs === stat.ctimeMs &&
		written.ino === stat.ino
	) {
		return undefined;
	}
	return "changed-since";
}

/**
 * Remember what `absolutePath` looks like now, so a later rewrite of a file
 * this session authored is not insured against. Call it after the bytes are on
 * disk. `created` says the mutation brought the file into existence; without it
 * this only refreshes a record the session already holds, so a file someone
 * else made never becomes "ours" by being written to.
 */
export async function noteOwnWrite(
	session: ClobberBackupSession,
	absolutePath: string,
	created: boolean,
): Promise<void> {
	try {
		const target = realPath(absolutePath, false);
		const files = createdFiles(session);
		if (!created && !files.byPath.has(target)) return;
		const stat = await fs.stat(target).catch(() => undefined);
		if (!stat?.isFile()) return;
		files.byPath.set(target, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			ino: Number(stat.ino),
		});
	} catch (error) {
		logger.debug("Could not record a written path", { path: absolutePath, error: String(error) });
	}
}

/** Forget a path this session created, for a caller that then deleted or moved it away. */
export function forgetOwnWrite(session: ClobberBackupSession, absolutePath: string): void {
	session.clobberCreatedPaths?.byPath.delete(realPath(absolutePath, false));
}

/** `<HHMMSSmmm>-<rand>-<name>`: sorts by time inside its day, keeps the original extension readable. */
function backupFileName(now: Date, originalName: string): string {
	const stamp =
		`${now.getHours()}`.padStart(2, "0") +
		`${now.getMinutes()}`.padStart(2, "0") +
		`${now.getSeconds()}`.padStart(2, "0") +
		`${now.getMilliseconds()}`.padStart(3, "0");
	const unique = Bun.randomUUIDv7("hex").slice(-8);
	// A basename has no separators; the cap keeps a pathological name from
	// pushing the whole entry past NAME_MAX.
	return `${stamp}-${unique}-${originalName.slice(-120)}`;
}

/** Local calendar day, the directory a backup lands in. */
function dayKey(now: Date): string {
	return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
}

/** Day directories of the store, oldest first. Unreadable store: empty. */
async function listDayDirs(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries
			.filter(entry => entry.isDirectory() && DAY_DIR_RE.test(entry.name))
			.map(entry => entry.name)
			.sort();
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Clobber backup store unreadable", { root, error: String(error) });
		return [];
	}
}

/**
 * Every regular file in a day, counted by `stat`, including its index and
 * anything in a subdirectory. The index is deliberately NOT trusted for sizes:
 * an entry can name a file that no longer exists, understate it, collide with
 * another entry's basename or point outside the day, and each of those made
 * the budget count something other than what the directory holds.
 *
 * The sweep only reaches this when {@link sweepStore}'s cheap bound says the
 * store might be over budget, so the ordinary small store pays one `readdir`
 * per day and no stats at all.
 *
 * Logical bytes: a sparse file or a reflink counts what it says it holds, not
 * what it occupies.
 */
async function dayBytes(dayDir: string, entries: readonly DayEntry[]): Promise<number> {
	let total = 0;
	for (const entry of entries) {
		total += (await fs.stat(path.join(entry.dir, entry.name)).catch(() => undefined))?.size ?? 0;
	}
	return total;
}

/** A regular file inside a day directory, at any depth. */
interface DayEntry {
	dir: string;
	name: string;
}

/**
 * Every regular file under `dayDir`, at any depth, walked by hand rather than
 * with a recursive `readdir`: that follows a symlinked directory, so a link
 * dropped into the store would have the sweep walking and stat-ing a tree
 * outside it, and a link loop would throw `ELOOP` and make the whole day weigh
 * nothing. Links are skipped, so a day weighs what it itself holds.
 *
 * Unreadable directory: what was read so far.
 */
async function dayEntries(dayDir: string): Promise<DayEntry[]> {
	const found: DayEntry[] = [];
	const pending = [dayDir];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		let listed;
		try {
			listed = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) logger.debug("Clobber backup day unreadable", { dir, error: String(error) });
			continue;
		}
		for (const entry of listed) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
			else if (entry.isFile()) found.push({ dir, name: entry.name });
		}
	}
	return found;
}

/** Stores already swept today, keyed by store root: one sweep per store per process per day. */
const sweptStores = new Map<string, string>();

/**
 * Drop day directories past {@link RETENTION_DAYS}, then the oldest remaining
 * ones until the completed days fit {@link STORE_BUDGET_BYTES}. Today is never
 * dropped: the backup that triggered the sweep is in it, and so is everything
 * the live processes write before midnight. Best-effort throughout — a store
 * that cannot be swept still takes backups.
 */
async function sweepStore(root: string, today: string): Promise<void> {
	const cutoffKey = dayKey(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000));
	const kept: string[] = [];
	for (const day of await listDayDirs(root)) {
		if (day < cutoffKey && day !== today) {
			await fs.rm(path.join(root, day), { recursive: true, force: true }).catch(error => {
				logger.debug("Clobber backup age sweep failed", { day, error: String(error) });
			});
			continue;
		}
		if (day !== today) kept.push(day);
	}
	// Every copy passed the per-file cap before it landed, so counting them is
	// an upper bound and an ordinary store is proved under budget without a
	// single `stat`. The per-day index is the one file no cap applies to, so it
	// is measured. Anything else a hand dropped into the store is assumed to be
	// a copy, which is where this bound stops being a guarantee.
	const entries = new Map<string, DayEntry[]>();
	let ceiling = 0;
	for (const day of kept) {
		const dayDir = path.join(root, day);
		const found = await dayEntries(dayDir);
		entries.set(day, found);
		// The index has no cap, and neither has a copy whose source grew while it
		// was being taken; both are measured. Everything else passed the per-file
		// cap before it landed, so counting it is a sound upper bound.
		const measured = found.filter(
			e => (e.dir === dayDir && e.name === INDEX_NAME) || e.name.endsWith(OVERSIZE_SUFFIX),
		);
		for (const entry of measured) {
			ceiling += (await fs.stat(path.join(entry.dir, entry.name)).catch(() => undefined))?.size ?? 0;
		}
		ceiling += (found.length - measured.length) * MAX_BACKUP_BYTES;
	}
	if (ceiling <= STORE_BUDGET_BYTES) return;
	let total = 0;
	const sizes = new Map<string, number>();
	for (const day of kept) {
		const bytes = await dayBytes(path.join(root, day), entries.get(day) ?? []);
		sizes.set(day, bytes);
		total += bytes;
	}
	for (const day of kept) {
		if (total <= STORE_BUDGET_BYTES) break;
		await fs.rm(path.join(root, day), { recursive: true, force: true }).catch(error => {
			logger.debug("Clobber backup budget sweep failed", { day, error: String(error) });
		});
		total -= sizes.get(day) ?? 0;
	}
}

/**
 * Copy aside whatever `absolutePath` holds, when replacing or removing it would
 * destroy something this session cannot put back. Returns `undefined` when
 * there is nothing to insure: the path is absent, is not a regular file, is
 * empty, or holds only this session's own work outside any other session's
 * directory.
 *
 * Never throws, and never stops the mutation that follows.
 */
export async function backupBeforeClobber(
	session: ClobberBackupSession,
	absolutePath: string,
): Promise<ClobberBackup | undefined> {
	let reason: ClobberReason | undefined;
	let target = path.resolve(absolutePath);
	let size = 0;
	try {
		// The stat comes first: an absent path (the common `create`) answers the
		// whole question without resolving anything.
		const stat = await fs.stat(target).catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (!stat?.isFile() || stat.size === 0) return undefined;
		size = stat.size;
		target = realPath(target, false);
		reason = clobberReason(session, target, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			ino: Number(stat.ino),
		});
		if (reason === undefined) return undefined;
		if (size > MAX_BACKUP_BYTES) return { kind: "too-large", reason, from: target, bytes: size };

		const now = new Date();
		const day = dayKey(now);
		const root = getClobberBackupsDir();
		const dayDir = path.join(root, day);
		let destination = path.join(dayDir, backupFileName(now, path.basename(target)));
		await fs.mkdir(dayDir, { recursive: true });
		// A reflink where the filesystem has one, a plain copy everywhere else —
		// never a hard link, which the in-place truncate below would follow.
		await fs.copyFile(target, destination, fs.constants.COPYFILE_FICLONE);
		// What landed is what the index and the note must report: the size above
		// was read before the copy, and a source another writer extended in
		// between is both larger than that and larger than the cap allowed.
		size = (await fs.stat(destination).catch(() => undefined))?.size ?? size;
		if (size > MAX_BACKUP_BYTES) {
			const marked = `${destination}${OVERSIZE_SUFFIX}`;
			const renamed = await fs
				.rename(destination, marked)
				.then(() => true)
				.catch(error => {
					logger.warn("Could not mark an oversized copy; the budget will undercount it", {
						to: destination,
						error: String(error),
					});
					return false;
				});
			if (renamed) destination = marked;
		}
		// Past this point the bytes ARE saved, so nothing below may downgrade the
		// answer to "could not be copied": the index and the sweep are bookkeeping,
		// and a caller told its content is gone when a copy exists is worse than a
		// store that is briefly untidy.
		try {
			// The name alone cannot say where the bytes came from; the day's index
			// can. The sweep does not read it — it weighs the directory itself —
			// but a person recovering a file a week later needs it.
			await fs.appendFile(
				path.join(dayDir, INDEX_NAME),
				`${JSON.stringify({ at: now.toISOString(), reason, from: target, to: destination, bytes: size })}\n`,
			);
		} catch (error) {
			logger.warn("Clobber backup index entry failed; the copy itself is on disk", {
				to: destination,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// Outside the index's catch: an unwritable index must not also stop
		// retention and the budget from being enforced on a store that is still
		// taking copies.
		if (sweptStores.get(root) !== day) {
			sweptStores.set(root, day);
			await sweepStore(root, day).catch(error => {
				logger.warn("Clobber backup sweep failed", { root, error: String(error) });
			});
		}
		return { kind: "saved", reason, from: target, to: destination, bytes: size };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Could not copy a file aside before it was replaced", { from: target, error: message });
		// Before the reason is known there is nothing to report: the caller cannot
		// say whether anything was at risk, and inventing a note would be a guess.
		return reason === undefined ? undefined : { kind: "failed", reason, from: target, error: message };
	}
}

function reasonPhrase(reason: ClobberReason): string {
	switch (reason) {
		case "foreign-session-dir":
			return "it is inside another session's directory";
		case "changed-since":
			return "it changed since this session wrote it";
		case "not-created-here":
			return "this session did not create it";
	}
}

/**
 * One line telling the model what happened to the content it is about to
 * replace, or `undefined` when nothing was at risk. Appended to the tool
 * result, so the session that caused the loss is the one told where the copy is.
 */
export function clobberBackupNote(backup: ClobberBackup | undefined, displayPath: string): string | undefined {
	if (!backup) return undefined;
	const why = reasonPhrase(backup.reason);
	switch (backup.kind) {
		case "saved":
			return `[Backup] ${displayPath}: ${why}, so its previous ${backup.bytes} bytes were copied to ${shortenPath(backup.to)}`;
		case "too-large":
			return `[Backup] ${displayPath}: ${why}, but its previous ${backup.bytes} bytes were over the ${MAX_BACKUP_BYTES}-byte backup limit, so they are not recoverable from here`;
		case "failed":
			// The message quotes a path inside a sentence, where `shortenPath` —
			// which only matches a string that IS a path — would leave the home
			// directory in the model's context.
			return `[Backup] ${displayPath}: ${why}, but its previous content could not be copied aside (${shortenEmbeddedPaths(backup.error)}), so it is not recoverable from here`;
	}
}
