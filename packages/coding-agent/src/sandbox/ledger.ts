/**
 * Protected paths contained code created or replaced (G7 of the sandbox access design): the
 * identity watch that detects them and the ledger `<agentDir>/sandbox-created.json` that records
 * them. A ledgered path stays protected until the user trusts it; meanwhile project discovery skips
 * items under it and host git refuses a repository whose git metadata holds one.
 *
 * The ledger lives in the agent dir (a protected path wherever a writable root covers it), is
 * changed under its file lock, written atomically and read through a stat-keyed cache, so every
 * realm (worker threads too) and omp process sees the others' writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAgentDir, hasFsCode, isRecord, logger, resolveEquivalentPath, withFileLockSync } from "@oh-my-pi/pi-utils";
import { writeFileAtomicallySync } from "../utils/atomic-file";
import { isWithin } from "./platform";

export interface SandboxCreatedEntry {
	/** The path as omp watched it (lexical). */
	readonly path: string;
	/** What it resolved to when the change was seen. */
	readonly real: string;
	/** Workspace of the runtime whose contained process created it. */
	readonly workspace: string;
	/** When omp saw the change (ms since the epoch). */
	readonly at: number;
	/** The repository (common dir) whose `core.hooksPath` it is, when that lies outside the git dir. */
	readonly gitDir?: string;
}

/** A ledger entry as the `/sandbox` panel and RPC list it. */
export interface SandboxCreatedPath extends SandboxCreatedEntry {
	/** Whether it exists now; only a path that no longer exists can be removed from the ledger. */
	readonly exists: boolean;
}

/** Identity of one existing watched path (lstat only; a symlink's target is read, never followed). */
interface Identity {
	readonly kind: "dir" | "link" | "other";
	/** `dev:ino` */
	readonly id: string;
	/** A symlink's target. */
	readonly target?: string;
}

/** Identity of each watched path; `undefined` while it is missing. */
export type IdentitySnapshot = Map<string, Identity | undefined>;

let cache: { key: string; entries: readonly SandboxCreatedEntry[] } | undefined;
let revision = 0;

let createdCheck: () => void = () => {};

/**
 * Installs the identity watch of every live runtime of this realm (`SandboxRuntime.checkCreated`,
 * registered by the runtime module). {@link currentSandboxCreated} runs it before reading the
 * ledger, so a change a contained process just made is ledgered first.
 */
export function setSandboxCreatedCheck(check: () => void): void {
	createdCheck = check;
}

/** Where the ledger lives: the agent dir; the runtime protects it inside a writable root. */
export function sandboxCreatedLedgerPath(): string {
	return path.join(getAgentDir(), "sandbox-created.json");
}

function isEntry(value: unknown): value is SandboxCreatedEntry {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.real === "string" &&
		typeof value.workspace === "string" &&
		typeof value.at === "number" &&
		(value.gitDir === undefined || typeof value.gitDir === "string")
	);
}

function readLedger(file: string): SandboxCreatedEntry[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (Array.isArray(parsed)) return parsed.filter(isEntry);
		logger.warn("sandbox: ignoring a malformed created-paths ledger", { file });
	} catch (error) {
		logger.warn("sandbox: ignoring an unreadable created-paths ledger", { file, error: String(error) });
	}
	return [];
}

/** Every ledgered path; a missing or corrupt ledger reads as empty. Re-read when the file changed. */
export function sandboxCreatedEntries(): readonly SandboxCreatedEntry[] {
	const file = sandboxCreatedLedgerPath();
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	// Every write replaces the file (a new inode), so the key changes even within one mtime tick.
	const key = stat ? `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}` : file;
	if (cache?.key !== key) {
		cache = { key, entries: stat ? readLedger(file) : [] };
		revision++;
	}
	return cache.entries;
}

/** Changes whenever {@link sandboxCreatedEntries} does (this realm's writes and other processes'). */
export function sandboxCreatedRevision(): number {
	sandboxCreatedEntries();
	return revision;
}

/** The ledger after the live runtimes' identity watch ran: what every consumer reads before it trusts a path. */
export function currentSandboxCreated(): readonly SandboxCreatedEntry[] {
	createdCheck();
	return sandboxCreatedEntries();
}

/**
 * Applies `change` to the ledger as it is on disk, under its file lock (realms and omp processes
 * share it); writes what `change` returns, nothing for `undefined`.
 */
function updateLedger(change: (entries: readonly SandboxCreatedEntry[]) => SandboxCreatedEntry[] | undefined): void {
	const file = sandboxCreatedLedgerPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	withFileLockSync(file, () => {
		cache = undefined;
		const next = change(sandboxCreatedEntries());
		if (next === undefined) return;
		writeFileAtomicallySync(file, `${JSON.stringify(next, null, "\t")}\n`);
		cache = undefined;
	});
}

/** Both forms of `target` a ledger entry may name: lexical and canonical. */
function forms(target: string): string[] {
	return [path.resolve(target), resolveEquivalentPath(target, { throughMissing: true })];
}

/** The entry of `entries` (default: the ledger) `target` lies at or under, or `undefined`. */
export function sandboxCreatedCovering(
	target: string,
	entries: readonly SandboxCreatedEntry[] = sandboxCreatedEntries(),
): SandboxCreatedEntry | undefined {
	if (entries.length === 0) return undefined;
	const platform = process.platform;
	const candidates = forms(target);
	return entries.find(entry =>
		candidates.some(form => isWithin(form, entry.path, platform) || isWithin(form, entry.real, platform)),
	);
}

/** Paths whose skip was logged; each is logged once per process, not once per enumeration. */
const skipLogged = new Set<string>();

/**
 * The warning for project config at `target` that discovery skips because it lies at or under an
 * entry of `entries` (one ledger read per enumeration); `undefined` when none covers it. The skip is
 * logged once per path per process. The warning points at `/sandbox` only when the entry belongs to
 * workspace `cwd`, where it can be trusted.
 */
export function sandboxCreatedSkip(
	target: string,
	cwd: string,
	entries: readonly SandboxCreatedEntry[],
): string | undefined {
	const entry = sandboxCreatedCovering(target, entries);
	if (entry === undefined) return undefined;
	if (!skipLogged.has(target)) {
		skipLogged.add(target);
		logger.warn("sandbox: skipped project config a sandboxed command created or replaced", {
			path: target,
			ledgered: entry.path,
		});
	}
	const trust = forms(cwd).includes(entry.workspace) ? "; trust it in /sandbox to load it" : "";
	return `Skipped ${target}: a sandboxed command created or replaced ${entry.path}${trust}`;
}

/** Records `entries` not already covered by a ledgered path; returns the ones added. */
export function recordSandboxCreated(entries: readonly SandboxCreatedEntry[]): SandboxCreatedEntry[] {
	let added: SandboxCreatedEntry[] = [];
	updateLedger(current => {
		added = entries.filter(entry => sandboxCreatedCovering(entry.path, current) === undefined);
		return added.length > 0 ? [...current, ...added] : undefined;
	});
	return added;
}

/** Drops the entry naming `target` (its lexical or canonical path); whether one existed. */
export function removeSandboxCreated(target: string): boolean {
	let removed = false;
	updateLedger(current => {
		const kept = current.filter(entry => entry.path !== target && entry.real !== target);
		removed = kept.length !== current.length;
		return removed ? kept : undefined;
	});
	return removed;
}

/** Whether `entry` (either form) exists now. */
export function sandboxCreatedExists(entry: SandboxCreatedEntry): boolean {
	return identity(entry.path) !== undefined || identity(entry.real) !== undefined;
}

/**
 * Whether host git must refuse the repository with git entry, git dir or common dir `gitDir`: a ledgered
 * path lies at, above or below it (a replaced `.git`, a created `hooks/`), or is its hooks path.
 */
export function sandboxCreatedRefusesRepo(
	gitDir: string,
	entries: readonly SandboxCreatedEntry[] = sandboxCreatedEntries(),
): boolean {
	if (entries.length === 0) return false;
	const platform = process.platform;
	const candidates = forms(gitDir);
	return entries.some(entry =>
		candidates.some(
			form =>
				form === entry.gitDir ||
				[entry.path, entry.real].some(
					ledgered => isWithin(form, ledgered, platform) || isWithin(ledgered, form, platform),
				),
		),
	);
}

/**
 * Makes the natives git wrapper refuse repositories {@link sandboxCreatedRefusesRepo} names (its
 * git entry, git dir or common dir), after running the live runtimes' identity watch. Idempotent.
 */
export function installSandboxRepoGuard(): void {
	vcs.setRepoGuard(paths => {
		const entries = currentSandboxCreated();
		return !paths.some(dir => sandboxCreatedRefusesRepo(dir, entries));
	});
}

function identity(target: string): Identity | undefined {
	let stat: fs.Stats | undefined;
	try {
		stat = fs.lstatSync(target, { throwIfNoEntry: false });
	} catch (error) {
		// A parent turned into a file: the path is missing.
		if (hasFsCode(error, "ENOTDIR")) return undefined;
		throw error;
	}
	if (!stat) return undefined;
	const id = `${stat.dev}:${stat.ino}`;
	if (stat.isDirectory()) return { kind: "dir", id };
	if (!stat.isSymbolicLink()) return { kind: "other", id };
	try {
		return { kind: "link", id, target: fs.readlinkSync(target) };
	} catch {
		return { kind: "link", id, target: "" };
	}
}

/** Identity of each of `paths` (lstat only; a symlink's target is read, never followed). */
export function identitySnapshot(paths: Iterable<string>): IdentitySnapshot {
	const snapshot: IdentitySnapshot = new Map();
	for (const target of paths) snapshot.set(target, identity(target));
	return snapshot;
}

/**
 * Paths of `before` contained code created or replaced by `after`: one that appeared; a symlink
 * whose target or type changed; a watched ancestor (a path with another of `before` below it)
 * that was replaced. An existing leaf replaced in place is not listed: contained code cannot
 * write a read-only carve-out, while host git rewrites `.git/config` through a rename. A path that
 * disappeared is not listed; a path below another listed one is dropped (its ancestor names it).
 * A path of `linkOnly` that appeared is listed only as a symlink (contained git creates it).
 */
export function changedIdentities(
	before: IdentitySnapshot,
	after: IdentitySnapshot,
	linkOnly: ReadonlySet<string> = new Set(),
): string[] {
	const platform = process.platform;
	const watched = [...before.keys()];
	const changed: string[] = [];
	for (const [target, was] of before) {
		const now = after.get(target);
		if (now === undefined) continue;
		if (was === undefined) {
			if (linkOnly.has(target) && now.kind !== "link") continue;
		} else {
			const ancestor = watched.some(other => other !== target && isWithin(other, target, platform));
			const replaced = ancestor
				? now.id !== was.id || now.kind !== was.kind
				: (now.kind === "link" || was.kind === "link") && (now.kind !== was.kind || now.target !== was.target);
			if (!replaced) continue;
		}
		changed.push(target);
	}
	return changed.filter(target => !changed.some(other => other !== target && isWithin(target, other, platform)));
}
