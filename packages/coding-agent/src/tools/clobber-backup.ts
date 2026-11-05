/**
 * Copy-before-clobber: keep the bytes a session is about to destroy.
 *
 * Two writes end badly often enough to be worth insuring against:
 *
 * 1. A session replaces a whole file it did not create. Whatever was in it is
 *    gone the instant the write lands — there is no undo, and for a file no
 *    version control tracks there is nothing to go back to.
 * 2. A session writes under ANOTHER session's directory. A live transcript or a
 *    sibling's artifact has no other copy anywhere.
 *
 * Before either, the caller copies the old content aside and tells the model
 * where it went. Nothing is blocked, refused, or held for approval: a write
 * that would have happened still happens, byte for byte, and a backup that
 * cannot be taken degrades to a note saying so. The only cost on the ordinary
 * path — a session rewriting a file it just created — is one `stat` the callers
 * already had in hand.
 *
 * Bounds (see {@link RETENTION_DAYS}, {@link STORE_BUDGET_BYTES},
 * {@link MAX_BACKUP_BYTES}): copies live under `~/.omp/agent/clobbered/<date>/`
 * for two weeks, the store is swept back under its byte budget once per process
 * per day, and a single file past the per-file cap is reported rather than
 * copied.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getClobberBackupsDir, getSessionsDir, pathIsWithin } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Day directories older than this are swept. Two weeks outlives a weekend plus the week it takes to notice. */
const RETENTION_DAYS = 14;

/** Total bytes the store may hold after a sweep. Oldest days go first; the current day is never swept. */
const STORE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Largest file copied aside. Past this the loss is reported instead, so one huge write cannot fill the disk. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Why the old content was worth keeping. */
export type ClobberReason = "not-created-here" | "foreign-session-dir";

/** What happened to the bytes a write was about to replace. */
export type ClobberBackup =
	| { kind: "saved"; reason: ClobberReason; from: string; to: string; bytes: number }
	| { kind: "too-large"; reason: ClobberReason; from: string; bytes: number }
	| { kind: "failed"; reason: ClobberReason; from: string; error: string };

/**
 * Owner of the per-session set of paths this session brought into existence.
 * Lives on the {@link ToolSession} the way the edit store does, so a subagent
 * keeps its own and inherits nothing: a file created by someone else is a file
 * this session did not create.
 */
export interface ClobberBackupOwner {
	/** Absolute paths created by this session; replacing one destroys only its own work. */
	clobberCreatedPaths?: Set<string>;
}

/** The session facts a backup decision needs. A structural subset of `ToolSession`. */
export interface ClobberBackupSession extends ClobberBackupOwner {
	cwd: string;
	getSessionFile?: () => string | null;
	getArtifactsDir?: () => string | null;
}

/**
 * Remember that this session created `absolutePath`, so a later rewrite of it
 * is not insured against. Call it only once the file is actually on disk.
 */
export function recordCreatedPath(session: ClobberBackupOwner, absolutePath: string): void {
	(session.clobberCreatedPaths ??= new Set<string>()).add(path.resolve(absolutePath));
}

/** Forget a path this session created, for a caller that then moved or deleted it. */
export function forgetCreatedPath(session: ClobberBackupOwner, absolutePath: string): void {
	session.clobberCreatedPaths?.delete(path.resolve(absolutePath));
}

/**
 * True when `target` sits under the sessions root but outside everything this
 * session owns there — another session's transcript, its artifacts, or another
 * project's bucket. A session's own transcript file and its own artifacts
 * directory (the transcript path without `.jsonl`) are its own.
 *
 * A subagent owns only its own file and artifacts: writing into its parent's
 * directory is writing into another session's directory, which is exactly the
 * case worth insuring.
 */
function isForeignSessionDirectory(session: ClobberBackupSession, target: string): boolean {
	let sessionsRoot: string;
	try {
		sessionsRoot = getSessionsDir();
	} catch {
		return false;
	}
	if (!pathIsWithin(sessionsRoot, target)) return false;
	const sessionFile = session.getSessionFile?.() ?? undefined;
	if (sessionFile) {
		const own = path.resolve(sessionFile);
		if (own === target) return false;
		const ownArtifacts = own.endsWith(".jsonl") ? own.slice(0, -".jsonl".length) : own;
		if (pathIsWithin(ownArtifacts, target)) return false;
	}
	const artifactsDir = session.getArtifactsDir?.() ?? undefined;
	if (artifactsDir && pathIsWithin(artifactsDir, target)) return false;
	return true;
}

/** The reason this write needs insuring, or `undefined` when it destroys nothing but this session's own work. */
function clobberReason(session: ClobberBackupSession, target: string): ClobberReason | undefined {
	if (isForeignSessionDirectory(session, target)) return "foreign-session-dir";
	if (session.clobberCreatedPaths?.has(target)) return undefined;
	return "not-created-here";
}

/** `<HHMMSS><ms>-<rand>-<name>`: sorts by time inside its day, keeps the original extension readable. */
function backupFileName(now: Date, originalName: string): string {
	const stamp =
		`${now.getHours()}`.padStart(2, "0") +
		`${now.getMinutes()}`.padStart(2, "0") +
		`${now.getSeconds()}`.padStart(2, "0") +
		`${now.getMilliseconds()}`.padStart(3, "0");
	const unique = Bun.randomUUIDv7("hex").slice(-8);
	// A path has no separators in its basename; the cap keeps a pathological
	// name from pushing the whole entry past NAME_MAX.
	return `${stamp}-${unique}-${originalName.slice(-120)}`;
}

/** Local calendar day, the directory a backup lands in. */
function dayKey(now: Date): string {
	return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
}

/** Day directory of the store, newest last. Unreadable store: empty. */
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

/** Bytes a day directory holds, counting only its own files (the store is one level deep plus its index). */
async function dayDirBytes(dayDir: string): Promise<number> {
	let total = 0;
	try {
		for (const entry of await fs.readdir(dayDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			total += (await fs.stat(path.join(dayDir, entry.name)).catch(() => undefined))?.size ?? 0;
		}
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Clobber backup day unreadable", { dayDir, error: String(error) });
	}
	return total;
}

/** The day whose sweep this process already ran; one sweep per process per day is enough. */
let sweptDay: string | undefined;

/**
 * Drop day directories past {@link RETENTION_DAYS}, then the oldest remaining
 * ones until the store fits {@link STORE_BUDGET_BYTES}. Today is never dropped:
 * the backup that triggered the sweep is in it. Best-effort throughout — a
 * store that cannot be swept still takes backups.
 */
async function sweepStore(root: string, today: string): Promise<void> {
	const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const cutoffKey = dayKey(cutoff);
	const days = await listDayDirs(root);
	const kept: string[] = [];
	for (const day of days) {
		if (day < cutoffKey && day !== today) {
			await fs.rm(path.join(root, day), { recursive: true, force: true }).catch(error => {
				logger.debug("Clobber backup sweep failed", { day, error: String(error) });
			});
			continue;
		}
		kept.push(day);
	}
	let total = 0;
	const sizes = new Map<string, number>();
	for (const day of kept) {
		const bytes = await dayDirBytes(path.join(root, day));
		sizes.set(day, bytes);
		total += bytes;
	}
	for (const day of kept) {
		if (total <= STORE_BUDGET_BYTES) break;
		if (day === today) continue;
		await fs.rm(path.join(root, day), { recursive: true, force: true }).catch(error => {
			logger.debug("Clobber backup budget sweep failed", { day, error: String(error) });
		});
		total -= sizes.get(day) ?? 0;
	}
}

/**
 * Copy aside whatever `absolutePath` holds, when replacing it would destroy
 * something this session cannot put back. Returns `undefined` when there is
 * nothing to insure: the path is absent, is not a regular file, is empty, or
 * holds only this session's own work outside any other session's directory.
 *
 * Never throws and never blocks the write that follows.
 */
export async function backupBeforeClobber(
	session: ClobberBackupSession,
	absolutePath: string,
): Promise<ClobberBackup | undefined> {
	const target = path.resolve(absolutePath);
	const reason = clobberReason(session, target);
	if (reason === undefined) return undefined;

	const stat = await fs.stat(target).catch(() => undefined);
	// Absent (this write creates it), a directory or a device: no bytes to lose.
	if (!stat?.isFile() || stat.size === 0) return undefined;
	if (stat.size > MAX_BACKUP_BYTES) return { kind: "too-large", reason, from: target, bytes: stat.size };

	const now = new Date();
	const day = dayKey(now);
	const root = getClobberBackupsDir();
	const dayDir = path.join(root, day);
	const destination = path.join(dayDir, backupFileName(now, path.basename(target)));
	try {
		await fs.mkdir(dayDir, { recursive: true });
		// A reflink where the filesystem has one, a plain copy everywhere else —
		// never a hard link, which the in-place truncate below would follow.
		await fs.copyFile(target, destination, fs.constants.COPYFILE_FICLONE);
		// The name alone cannot say where the bytes came from; the day's index can.
		await fs.appendFile(
			path.join(dayDir, "index.jsonl"),
			`${JSON.stringify({ at: now.toISOString(), reason, from: target, to: destination, bytes: stat.size })}\n`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Could not copy a file aside before it was overwritten", { from: target, error: message });
		return { kind: "failed", reason, from: target, error: message };
	}
	if (sweptDay !== day) {
		sweptDay = day;
		await sweepStore(root, day).catch(error => {
			logger.debug("Clobber backup sweep failed", { error: String(error) });
		});
	}
	return { kind: "saved", reason, from: target, to: destination, bytes: stat.size };
}

function reasonPhrase(reason: ClobberReason): string {
	return reason === "foreign-session-dir"
		? "it is inside another session's directory"
		: "this session did not create it";
}

/**
 * One line telling the model what happened to the content it just replaced, or
 * `undefined` when nothing was at risk. Appended to the tool result, so the
 * session that caused the loss is the one told where to find the copy.
 */
export function clobberBackupNote(backup: ClobberBackup | undefined, displayPath: string): string | undefined {
	if (!backup) return undefined;
	const why = reasonPhrase(backup.reason);
	switch (backup.kind) {
		case "saved":
			return `[Backup] ${displayPath}: ${why}, so its previous ${backup.bytes} bytes were copied to ${shortenPath(backup.to)}`;
		case "too-large":
			return `[Backup] ${displayPath}: ${why}, but its previous ${backup.bytes} bytes were over the ${MAX_BACKUP_BYTES}-byte backup limit and are gone`;
		case "failed":
			return `[Backup] ${displayPath}: ${why}, but its previous content could not be copied aside (${backup.error}) and is gone`;
	}
}

/** Reset the once-per-process-per-day sweep marker. Tests only. */
export function resetClobberSweepForTests(): void {
	sweptDay = undefined;
}
