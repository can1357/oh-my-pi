import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "../utils/ttyid";
import {
	getCustomSessionFilesDir,
	getSessionsDir,
	getTerminalSessionsDir,
	getWorktreesDir,
	hashPath,
	relativePathWithinNormalizedRoot,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Settings } from "../config/settings";
import { worktreeFamily } from "../worktree/worktrees";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();
const migratingSessionRoots = new Map<string, Promise<void>>();

// The public synchronous SessionManager factories must finish migrations before
// returning. Use the same migration steps at startup, yielding each directory
// to read so the async caller need not block the event loop to enumerate it.
type DirectoryScan<T = void> = Generator<string, T, string[]>;

function runDirectoryScanSync<T>(scan: DirectoryScan<T>): T {
	let step = scan.next();
	while (!step.done) {
		let entries: string[];
		try {
			entries = fs.readdirSync(step.value);
		} catch (error) {
			step = scan.throw(error);
			continue;
		}
		step = scan.next(entries);
	}
	return step.value;
}

async function runDirectoryScan<T>(scan: DirectoryScan<T>): Promise<T> {
	let step = scan.next();
	while (!step.done) {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(step.value);
		} catch (error) {
			step = scan.throw(error);
			continue;
		}
		step = scan.next(entries);
	}
	return step.value;
}

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function* migrateSessionDirPath(oldPath: string, newPath: string): DirectoryScan {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		let files: string[];
		try {
			files = yield oldPath;
		} catch (error) {
			if (isEnoent(error) && !fs.existsSync(oldPath)) return;
			throw error;
		}
		// A synchronous caller may have completed this merge during the read.
		if (!fs.existsSync(oldPath)) return;
		for (const file of files) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (fs.existsSync(dst)) {
				if (fs.existsSync(src)) {
					logger.warn("Session directory migration collision; preserving legacy entry", { src, dst });
				}
				continue;
			}
			fs.renameSync(src, dst);
		}
		fs.rmdirSync(oldPath);
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/**
 * Reconstruct the short-lived hashed session dir name used by 17.2.5-17.2.8
 * (reverted PR #7397): `<scope>-<readable>-<sha256hex>` keyed by the canonical
 * cwd. Kept only so {@link prepareProjectSessionDir} can recover sessions
 * stranded when 17.2.9 restored the legacy names without a reverse migration.
 */
function encodeHashedSessionDirName(canonicalCwd: string, scope: "home" | "tmp" | "abs"): string {
	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	return `${scope}-${readable || "project"}-${digest}`;
}

/** Whether `relative` (from `path.relative(root, target)`) stays at or inside `root`. */
function isRelativeWithin(relative: string): boolean {
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface DefaultSessionDirNames {
	encodedDirName: string;
	hashedDirName: string;
	/** Home-relative name a temp-root cwd got while home was checked first; migrated forward. */
	shadowedHomeDirName?: string;
	/** Hashed home-scoped name from before temp-root precedence. */
	shadowedHomeHashedDirName?: string;
	resolvedCwd: string;
}

function getDefaultSessionDirName(cwd: string): DefaultSessionDirNames {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	const inHome = isRelativeWithin(homeRelative);
	let encodedDirName: string;
	let shadowedHomeDirName: string | undefined;
	let shadowedHomeHashedDirName: string | undefined;
	let scope: "home" | "tmp" | "abs";
	// The temp root is checked first: it is the more specific root wherever it
	// nests inside home (Windows' `%USERPROFILE%\AppData\Local\Temp`).
	if (isRelativeWithin(tempRelative)) {
		encodedDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
		if (inHome) {
			shadowedHomeDirName = encodeRelativeSessionDirName("-", homeRelative);
			shadowedHomeHashedDirName = encodeHashedSessionDirName(canonicalCwd, "home");
		}
		scope = "tmp";
	} else if (inHome) {
		encodedDirName = encodeRelativeSessionDirName("-", homeRelative);
		scope = "home";
	} else {
		encodedDirName = encodeLegacyAbsoluteSessionDirName(canonicalCwd);
		scope = "abs";
	}
	return {
		encodedDirName,
		hashedDirName: encodeHashedSessionDirName(canonicalCwd, scope),
		shadowedHomeDirName,
		shadowedHomeHashedDirName,
		resolvedCwd,
	};
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function* migrateHomeSessionDirs(sessionsRoot: string): DirectoryScan {
	if (migratedSessionRoots.has(sessionsRoot)) return;

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = yield sessionsRoot;
	} catch {
		migratedSessionRoots.add(sessionsRoot);
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		// A synchronous factory can finish the sweep while an async read is pending.
		if (migratedSessionRoots.has(sessionsRoot)) return;
		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			yield* migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			logger.warn("Failed to migrate legacy home session directory", {
				oldPath,
				newPath,
				error: String(error),
			});
		}
	}
	migratedSessionRoots.add(sessionsRoot);
}

/** Move the session dir `legacyDirName` under `sessionsRoot` into `sessionDir`. Best-effort. */
function* migrateNamedSessionDir(
	legacyDirName: string,
	sessionDir: string,
	sessionsRoot: string,
	kind: "legacy" | "hashed" = "legacy",
): DirectoryScan {
	const legacyDir = path.join(sessionsRoot, legacyDirName);
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		yield* migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		logger.warn(`Failed to migrate ${kind} session directory`, {
			oldPath: legacyDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	if (currentDirName !== encodedDirName && currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Default session directory for `cwd` under `sessionsRoot`, without the legacy
 * migrations or directory creation {@link computeDefaultSessionDir} performs.
 * Read-only lookups (the `archive` eval prelude) use it so querying a project
 * never creates or moves a session bucket.
 */
export function sessionDirForCwd(cwd: string, sessionsRoot: string = getSessionsDir()): string {
	return path.join(sessionsRoot, getDefaultSessionDirName(cwd).encodedDirName);
}

/** Session buckets for both backends, including removed worktrees whose sessions can be resumed. */
export async function worktreeSessionDirs(
	cwd: string,
	sessionDir: string,
	options: { settings?: Settings; stranded?: boolean } = {},
): Promise<string[]> {
	const sessionsRoot = resolveManagedSessionRoot(sessionDir, cwd);
	if (!sessionsRoot) return [];
	try {
		const family = await worktreeFamily(cwd, options.settings);
		if (!family) return [];
		const { primary, prefix, locations } = family;
		const dirs = new Set(managedWorktreeSessionDirs(primary, prefix, sessionsRoot));
		for (const location of locations) {
			const dir = sessionDirForCwd(path.resolve(location.root, prefix), sessionsRoot);
			if (options.stranded && location.offline) dirs.delete(dir);
			else dirs.add(dir);
		}
		dirs.delete(path.resolve(sessionDir));
		return [...dirs];
	} catch (error) {
		logger.debug("Worktree session directory lookup failed", { cwd, error: String(error) });
		return [];
	}
}

/** Stand-in worktree name: encoding a path through it yields the name around any managed worktree's. */
const WORKTREE_NAME_PROBE = "{worktree}";

/**
 * Session directories for the `prefix` folder of agent-managed worktrees of
 * the repository at `primaryRoot`, matched by directory name. Those worktrees
 * live at `<worktree base>/<slug>-<hashPath(primaryRoot)>[-<n>]` (see
 * `createSessionWorktree` and `resolveAvailableWorktreePath`), so the match
 * needs no git metadata and survives the worktree's removal.
 */
function managedWorktreeSessionDirs(primaryRoot: string, prefix: string, sessionsRoot: string): string[] {
	// Encode against the canonical base: a live worktree's directory was named
	// from its realpath, and the probe path does not exist to be resolved.
	const probe = path.join(resolveEquivalentPath(getWorktreesDir()), WORKTREE_NAME_PROBE, prefix);
	const [head, tail] = path.basename(sessionDirForCwd(probe, sessionsRoot)).split(WORKTREE_NAME_PROBE);
	if (tail === undefined) return [];
	// The name hashes the root as spelled when the worktree was made; a symlinked
	// spelling (macOS `/tmp` vs `/private/tmp`) hashes differently, so accept both.
	const hashes = new Set([hashPath(primaryRoot), hashPath(resolveEquivalentPath(primaryRoot))]);
	const name = new RegExp(`^[\\w.-]+-(?:${[...hashes].join("|")})(?:-\\d+)?$`);
	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.length <= head.length + tail.length || !entry.startsWith(head) || !entry.endsWith(tail)) continue;
		if (name.test(entry.slice(head.length, entry.length - tail.length))) dirs.push(path.join(sessionsRoot, entry));
	}
	return dirs;
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const names = getDefaultSessionDirName(cwd);
	const root = path.isAbsolute(sessionsRoot) ? sessionsRoot : path.resolve(sessionsRoot);
	if (!migratedSessionRoots.has(root)) runDirectoryScanSync(migrateHomeSessionDirs(root));
	return runDirectoryScanSync(prepareProjectSessionDir(names, storage, root, sessionsRoot));
}

/** The startup counterpart to {@link computeDefaultSessionDir}: never enumerate directories synchronously. */
export async function computeDefaultSessionDirAsync(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): Promise<string> {
	const names = getDefaultSessionDirName(cwd);
	const root = path.isAbsolute(sessionsRoot) ? sessionsRoot : path.resolve(sessionsRoot);
	if (!migratedSessionRoots.has(root)) {
		let pending = migratingSessionRoots.get(root);
		if (!pending) {
			pending = runDirectoryScan(migrateHomeSessionDirs(root)).finally(() => {
				migratingSessionRoots.delete(root);
			});
			migratingSessionRoots.set(root, pending);
		}
		await pending;
	}
	return runDirectoryScan(prepareProjectSessionDir(names, storage, root, sessionsRoot));
}

function* prepareProjectSessionDir(
	{
		encodedDirName,
		hashedDirName,
		shadowedHomeDirName,
		shadowedHomeHashedDirName,
		resolvedCwd,
	}: DefaultSessionDirNames,
	storage: SessionStorage,
	sessionsRoot: string,
	requestedRoot: string,
): DirectoryScan<string> {
	let sessionDir = path.join(sessionsRoot, encodedDirName);
	yield* migrateNamedSessionDir(encodeLegacyAbsoluteSessionDirName(resolvedCwd), sessionDir, sessionsRoot);
	if (shadowedHomeDirName) yield* migrateNamedSessionDir(shadowedHomeDirName, sessionDir, sessionsRoot);
	if (shadowedHomeHashedDirName) yield* migrateNamedSessionDir(shadowedHomeHashedDirName, sessionDir, sessionsRoot);
	yield* migrateNamedSessionDir(hashedDirName, sessionDir, sessionsRoot, "hashed");
	// Keep the caller's relative path unless chdir during a read would now
	// point it at a different bucket. All migration I/O used the original root.
	if (requestedRoot !== sessionsRoot && path.resolve(requestedRoot) === sessionsRoot) {
		sessionDir = path.join(requestedRoot, encodedDirName);
	}
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/** Prefix for the optional cwd device+inode line in a terminal breadcrumb. */
const CWDSTAT_PREFIX = "cwdstat ";

export interface CwdIdentity {
	dev: string;
	ino: string;
}

/**
 * Snapshot the directory identity of `cwd` for later move detection.
 * A later path with the same device+inode is the same directory after rename.
 */
export function readCwdIdentity(cwd: string): CwdIdentity | undefined {
	try {
		const st = fs.statSync(path.resolve(cwd), { bigint: true });
		if (!st.isDirectory()) return undefined;
		return { dev: st.dev.toString(), ino: st.ino.toString() };
	} catch {
		return undefined;
	}
}

/**
 * True when `targetCwd` is the same directory that `cwdIdentity` was recorded
 * from — i.e. the project was renamed or moved, not merely deleted/unmounted.
 * Missing identity (legacy breadcrumb, or cwd absent at write time) is not evidence.
 *
 * Same-filesystem `mv` and `git worktree move` preserve `dev`+`ino` and qualify.
 * A cross-filesystem `mv` is copy+unlink (new inode, possibly new `dev`) and
 * therefore returns false — that is intentional. Absence is not a move; we
 * would rather leave the session in the original bucket than steal it into an
 * unrelated continue cwd (#11565).
 */
export function hasPositiveMovedProjectEvidence(cwdIdentity: CwdIdentity | undefined, targetCwd: string): boolean {
	if (!cwdIdentity) return false;
	const target = readCwdIdentity(targetCwd);
	return target !== undefined && target.dev === cwdIdentity.dev && target.ino === cwdIdentity.ino;
}

function parseBreadcrumbExtras(lines: string[]): {
	fresh: boolean;
	cwdIdentity: CwdIdentity | undefined;
} {
	let fresh = false;
	let cwdIdentity: CwdIdentity | undefined;
	for (const extra of lines.slice(2)) {
		if (extra === "fresh") {
			fresh = true;
			continue;
		}
		if (extra.startsWith(CWDSTAT_PREFIX)) {
			const [dev, ino] = extra.slice(CWDSTAT_PREFIX.length).split(" ");
			if (dev && ino) cwdIdentity = { dev, ino };
		}
	}
	return { fresh, cwdIdentity };
}

/** A terminal breadcrumb's recorded fields, before any check against the filesystem. */
export interface ParsedTerminalBreadcrumb {
	cwd: string;
	/** As recorded; a relative path resolves against `cwd`. */
	sessionFile: string;
	fresh: boolean;
	cwdIdentity: CwdIdentity | undefined;
}

/** Parse breadcrumb file content; null when it lacks the cwd and session lines. */
export function parseTerminalBreadcrumb(content: string): ParsedTerminalBreadcrumb | null {
	const lines = content.trim().split("\n");
	if (lines.length < 2) return null;
	return { cwd: lines[0], sessionFile: lines[1], ...parseBreadcrumbExtras(lines) };
}

/**
 * Storage facts about the writing session manager that decide whether the
 * custom-files registry can usefully record its transcript.
 *
 * A transcript under another agent dir's managed root still needs its marker:
 * the manager writes blobs to the current agent dir's store, and only that
 * agent dir's gc decides their reachability, which never scans the other root.
 */
export interface CustomSessionFileScope {
	/**
	 * The session lives in a non-filesystem storage backend. A marker names a
	 * local path gc reads from disk, so it would only ever dangle.
	 */
	remoteStorage?: boolean;
}

/**
 * Overwrite `file` with `content` unless it already holds exactly that, so
 * re-recording an unchanged pointer costs a read instead of a disk write.
 */
function writeIfChangedSync(file: string, content: string): void {
	try {
		if (fs.readFileSync(file, "utf8") === content) return;
	} catch {
		// Missing or unreadable: write it below.
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/**
 * Whether the garbage collector's recursive `*.jsonl` scan of the sessions root reaches `file`:
 * a JSONL transcript under that root with no dot-leading path segment, since the scan skips dot
 * entries. Anything else needs a marker to stay visible to the collector.
 */
function isFoundByManagedScan(file: string): boolean {
	if (!file.endsWith(".jsonl")) return false;
	const root = getSessionsDir();
	try {
		const present = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!present) {
			// A lazy transcript in an ordinary root/bucket needs no realpath: aliases
			// at or above root are shared by the scan. A dangling leaf link is not absent.
			const bucket = path.dirname(file);
			if (path.dirname(bucket) === root && !fs.lstatSync(bucket, { throwIfNoEntry: false })?.isSymbolicLink()) {
				return !path.basename(bucket).startsWith(".") && !path.basename(file).startsWith(".");
			}
		}

		const realRoot = fs.realpathSync(root);
		let existing = file;
		if (!present) {
			// Keep markers for missing custom paths. For a candidate under the physical
			// root, check its nearest existing ancestor so a bucket link cannot escape.
			if (relativePathWithinNormalizedRoot(realRoot, file) === null) return false;
			do {
				if (path.basename(existing).startsWith(".")) return false;
				const parent = path.dirname(existing);
				if (parent === existing) return false;
				existing = parent;
			} while (!fs.lstatSync(existing, { throwIfNoEntry: false }));
		}
		const relative = relativePathWithinNormalizedRoot(realRoot, fs.realpathSync(existing));
		if (relative === null || relative.startsWith(".") || relative.includes(`${path.sep}.`)) return false;
		return !present || relative.endsWith(".jsonl");
	} catch {
		// Inaccessible entries or dangling links are not provably covered by the scan.
		return false;
	}
}

/**
 * Record a session's exact file in the persistent custom-files registry when
 * the managed-root glob scan cannot fully account for it. Idempotent: the
 * marker is keyed by a hash of the resolved file, and its content is the
 * absolute path. Best-effort — a failure here must never break session
 * creation.
 *
 * `sessionFile` may be relative (e.g. `--session .omp-sessions/work`); it is
 * resolved against the recorded `cwd`, matching how the breadcrumb stores it.
 */
function recordCustomSessionFile(cwd: string, sessionFile: string, scope: CustomSessionFileScope | undefined): void {
	if (scope?.remoteStorage) return;
	try {
		const resolvedSessionFile = path.resolve(cwd, sessionFile);
		if (isFoundByManagedScan(resolvedSessionFile)) return;
		writeIfChangedSync(path.join(getCustomSessionFilesDir(), hashPath(resolvedSessionFile)), resolvedSessionFile);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Custom session file record failed", { err });
	}
}

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * `fresh` marks a freshly minted, lazy session whose JSONL is not yet
 * materialized. A fresh breadcrumb is honored by
 * {@link readTerminalBreadcrumbEntry} even when its target file is still absent,
 * so a same-terminal relaunch does not fall back to an older transcript. Explicit
 * `SessionManager.newSession()` boundaries are materialized and therefore also
 * survive relaunches whose terminal identity changed. Once any lazy session
 * materializes, the caller rewrites the breadcrumb with `fresh:false` so a later
 * external delete is still treated as a genuinely stale crumb.
 *
 * When `cwd` exists, the breadcrumb also records its device+inode so
 * `--continue` can tell a rename/move from a deleted or unmounted path.
 *
 * `scope` describes the writing manager's storage so the custom-files registry
 * skips transcripts a marker cannot help gc read (see {@link CustomSessionFileScope}).
 */
export function writeTerminalBreadcrumb(
	cwd: string,
	sessionFile: string,
	fresh = false,
	scope?: CustomSessionFileScope,
): void {
	// Persist session files the managed-root glob scan cannot fully account for,
	// regardless of terminal identity. Storage GC needs the exact path after the
	// per-terminal breadcrumb is overwritten by a later session.
	recordCustomSessionFile(cwd, sessionFile, scope);

	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
	const extras: string[] = [];
	if (fresh) extras.push("fresh");
	const identity = readCwdIdentity(cwd);
	if (identity) extras.push(`${CWDSTAT_PREFIX}${identity.dev} ${identity.ino}`);
	const extraBlock = extras.length > 0 ? `${extras.join("\n")}\n` : "";
	const content = `${cwd}\n${sessionFile}\n${extraBlock}`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy fresh-session crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh. Re-recording the same session (resume,
	// cwd re-adoption) leaves an identical crumb alone instead of rewriting it.
	try {
		writeIfChangedSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
	/** Device+inode of `cwd` when the breadcrumb was written, if that path existed. */
	cwdIdentity?: CwdIdentity;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file regardless of whether the recorded
 * cwd still matches the current one. Callers decide how to interpret a cwd
 * mismatch (e.g. a moved/renamed worktree).
 *
 * A missing target file yields `null` UNLESS the breadcrumb is a `fresh`
 * boundary — a lazy session whose JSONL was never written — in which case the
 * entry is returned with `exists:false` so the caller can distinguish it from a
 * genuinely stale/deleted breadcrumb.
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const parsed = parseTerminalBreadcrumb(await Bun.file(breadcrumbFile).text());
		if (!parsed) return null;
		const { cwd: breadcrumbCwd, sessionFile, fresh, cwdIdentity } = parsed;

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a never-written lazy fresh-session boundary.
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh, cwdIdentity };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
