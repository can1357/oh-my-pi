import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getTerminalId } from "@oh-my-pi/pi-tui/ttyid";
import {
	getCustomSessionFilesDir,
	getSessionsDir,
	getTerminalSessionsDir,
	getWorktreesDir,
	hashPath,
	pathIsWithin,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (fs.existsSync(dst)) {
				logger.warn("Session directory migration collision; preserving legacy entry", { src, dst });
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
 * cwd. Kept only so {@link migrateHashedSessionDir} can recover sessions
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

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	hashedDirName: string;
	/** Home-relative name a temp-root cwd got while home was checked first; migrated forward. */
	shadowedHomeDirName?: string;
	resolvedCwd: string;
} {
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
	let scope: "home" | "tmp" | "abs";
	// The temp root is checked first: it is the more specific root wherever it
	// nests inside home (Windows' `%USERPROFILE%\AppData\Local\Temp`).
	if (isRelativeWithin(tempRelative)) {
		encodedDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
		if (inHome) shadowedHomeDirName = encodeRelativeSessionDirName("-", homeRelative);
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
		resolvedCwd,
	};
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
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

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			logger.warn("Failed to migrate legacy home session directory", {
				oldPath,
				newPath,
				error: String(error),
			});
		}
	}
}

/** Move the session dir `legacyDirName` under `sessionsRoot` into `sessionDir`. Best-effort. */
function migrateNamedSessionDir(legacyDirName: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, legacyDirName);
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate legacy session directory", {
			oldPath: legacyDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

/**
 * Migrate a 17.2.5-17.2.8 hashed session dir back into its legacy path-based
 * directory. The 17.2.9 revert restored the legacy names but dropped migration,
 * stranding sessions written under the hashed scheme (issue #7677). Best-effort.
 */
function migrateHashedSessionDir(hashedDirName: string, sessionDir: string, sessionsRoot: string): void {
	const hashedDir = path.join(sessionsRoot, hashedDirName);
	if (hashedDir === sessionDir || !fs.existsSync(hashedDir)) return;

	try {
		migrateSessionDirPath(hashedDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate hashed session directory", {
			oldPath: hashedDir,
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

/**
 * Session directories for `cwd`'s folder in the other worktrees of its git
 * repository, under the sessions root holding `sessionDir`: every worktree git
 * lists, plus agent-managed ones (`/wt`, PR checkouts) found by name, so a
 * worktree removed since still counts. `/wt` moves a session into a linked
 * worktree's directory; the session picker lists these so it stays resumable
 * from the checkout it left, and vice versa.
 *
 * Empty outside git, when `cwd` sits outside its checkout, when `sessionDir`
 * is not cwd-derived (a custom `--session-dir`), or when git metadata is
 * unreadable.
 */
export async function worktreeSessionDirs(cwd: string, sessionDir: string): Promise<string[]> {
	const sessionsRoot = resolveManagedSessionRoot(sessionDir, cwd);
	if (!sessionsRoot) return [];
	try {
		const repo = vcs.git(cwd);
		const prefix = repo?.prefixOf(cwd);
		if (!repo || prefix == null) return [];
		const dirs = new Set(managedWorktreeSessionDirs(repo.primaryRoot(), prefix, sessionsRoot));
		for (const worktree of await repo.worktrees()) {
			dirs.add(sessionDirForCwd(path.resolve(worktree.path, prefix), sessionsRoot));
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
	const { encodedDirName, hashedDirName, shadowedHomeDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	migrateNamedSessionDir(encodeLegacyAbsoluteSessionDirName(resolvedCwd), sessionDir, sessionsRoot);
	if (shadowedHomeDirName) migrateNamedSessionDir(shadowedHomeDirName, sessionDir, sessionsRoot);
	migrateHashedSessionDir(hashedDirName, sessionDir, sessionsRoot);
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
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. Normalize that identity before comparing or
 * resuming it.
 */
export function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` exists). Capped to defend against pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!fs.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
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
		if (resolvedSessionFile.endsWith(".jsonl") && pathIsWithin(getSessionsDir(), resolvedSessionFile)) return;
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

/** Resolve and validate a parsed breadcrumb against the current filesystem. */
function validateTerminalBreadcrumb(parsed: ParsedTerminalBreadcrumb | null): TerminalBreadcrumb | null {
	if (!parsed) return null;
	const { cwd, fresh, cwdIdentity } = parsed;
	const sessionFile = path.resolve(cwd, parsed.sessionFile);
	const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
	const exists = stat?.isFile() === true;
	return exists || fresh ? { cwd, sessionFile, exists, fresh, cwdIdentity } : null;
}

/** Synchronous breadcrumb read for first-frame paths that cannot await the session graph. */
export function readTerminalBreadcrumbEntrySync(): TerminalBreadcrumb | null {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		return validateTerminalBreadcrumb(parseTerminalBreadcrumb(fs.readFileSync(breadcrumbFile, "utf8")));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		return null;
	}
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
		return validateTerminalBreadcrumb(parseTerminalBreadcrumb(await Bun.file(breadcrumbFile).text()));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		return null;
	}
}
