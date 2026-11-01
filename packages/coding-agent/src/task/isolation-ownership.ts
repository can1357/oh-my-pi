/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import * as fs from "./isolation-fs";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { AsyncLocalStorage } from "node:async_hooks";
import { acquireFileLock, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { hasLiveIsolationLease, hasUnfinishedWriter } from "./isolation-lease";

/**
 * How long a materialisation, teardown, lease or reclamation waits for the
 * sandbox lock another one holds. Waiting for each other is the point.
 */
export const SANDBOX_LOCK_WAIT = { retries: 600, retryDelayMs: 100 };

/**
 * The canonical path of a sandbox, which is its identity.
 *
 * A lock is a name, not a directory: two paths that reach the same directory
 * through different symlinks hash to different lock names, so each would think
 * it had exclusive access while both materialised and deleted the same files.
 * Resolving symlinks before locking, claiming, leasing or deleting makes the
 * name the directory.
 *
 * The sandbox need not exist yet, so a leaf that is simply absent is taken
 * from its nearest existing parent. Any other failure — a permission error, an
 * I/O error — is raised: silently falling back to the alias is how two holders
 * end up with two locks on one directory, and a caller that cannot establish
 * the identity must not act as though it had.
 */
export async function resolveSandboxIdentity(target: string): Promise<string> {
	const absolute = path.resolve(target);
	const resolved = await fs.realpathLookup(absolute);
	if (resolved.kind === "found") return resolved.value;
	if (resolved.kind === "unknown") {
		throw new Error(`Isolation path ${absolute} could not be resolved (${resolved.reason}).`);
	}
	const parent = path.dirname(absolute);
	if (parent === absolute) return absolute;
	return path.join(await resolveSandboxIdentity(parent), path.basename(absolute));
}

const { IsoBackendKind } = natives;

/** Marker file written into a task-isolation base dir identifying its owner. */
export const ISOLATION_OWNER_FILE = ".omp-isolation-owner.json";

/** Recorded owner of a task-isolation sandbox. */
export interface IsolationOwner {
	/** PID of the omp process that created and owns the sandbox. */
	pid: number;
	/** Task id the sandbox was materialised for. */
	id: string;
	/**
	 * Identifies this materialisation of {@link id}, not just the id. An id is
	 * reused — a replacement spawn, or a second process opening the same
	 * workspace — so a teardown still holding an older handle must be able to
	 * see that the path it captured now belongs to a later run.
	 */
	generation?: string;
	/**
	 * Process-instance start-time token for {@link pid}, when the OS can report
	 * it. Distinguishes the owning process from an unrelated process that later
	 * inherits a recycled pid, so a crashed sandbox is never pinned live.
	 */
	startToken?: string;
}

/**
 * Boot-stable start-time token for `pid`, or `null` when the process is gone or
 * the platform cannot report it. Read from the same source on write and
 * validate so an exact string compare rejects a recycled pid.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot); other Unixes shell out to `ps -o lstart`. Platforms that report
 * neither (e.g. Windows) yield `null`, degrading to a pid-only liveness check.
 */
async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		// `absent` is a process that has gone and `unknown` is a `/proc` this
		// caller cannot read; both give no token, and the pid-only check that
		// follows errs towards "still live", which is the safe direction here.
		const read = await fs.readTextLookup(`/proc/${pid}/stat`);
		if (read.kind !== "found") return null;
		const stat = read.value;
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	return await fs.processStartTime(pid);
}

/** A process identity recorded in a marker or a lease. */
export interface ProcessIdentity {
	pid: number;
	startToken?: string;
}

/** Write this process's identity to `file`, replacing it atomically. */
export async function writeProcessIdentity(file: string, extra: Record<string, unknown> = {}): Promise<void> {
	const startToken = await processStartToken(process.pid);
	const record = { pid: process.pid, ...(startToken ? { startToken } : {}), ...extra };
	await writeFileAtomically(file, JSON.stringify(record));
}

/**
 * Replace `file` in one step. A marker rewritten in place is readable as a
 * truncated, generation-less file for the length of the write, and a failure
 * part-way leaves it that way for good — which is exactly when something else
 * is deciding whether the sandbox still has an owner.
 */
async function writeFileAtomically(file: string, contents: string): Promise<void> {
	const temporary = `${file}.${process.pid}.${Snowflake.next()}.tmp`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	try {
		await fs.writeFileDeep(temporary, contents);
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** The identity recorded in `file`, `undefined` when there is none, `"unreadable"` when it cannot be read. */
export async function readProcessIdentity(file: string): Promise<ProcessIdentity | "unreadable" | undefined> {
	const found = await fs.readJsonLookup(file);
	if (found.kind === "absent") return undefined;
	if (found.kind === "unknown") return "unreadable";
	const decoded = found.value;
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return "unreadable";
	const pid = decoded.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unreadable";
	const startToken =
		"startToken" in decoded && typeof decoded.startToken === "string" && decoded.startToken.length > 0
			? decoded.startToken
			: undefined;
	return { pid, ...(startToken ? { startToken } : {}) };
}

/**
 * Whether the process named by `identity` is still running. `process.kill(pid,
 * 0)` can fail with `EPERM` even when the process is alive, so only an explicit
 * `ESRCH` counts as dead; a live pid whose start token no longer matches is a
 * recycled pid, which is a different process.
 */
export async function isProcessStillLive(identity: ProcessIdentity): Promise<boolean> {
	try {
		process.kill(identity.pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if (identity.startToken === undefined) return true;
	const current = await processStartToken(identity.pid);
	return current === null || current === identity.startToken;
}

/**
 * Record the current process as owner of the sandbox rooted at `baseDir`, and
 * return the {@link IsolationOwner.generation} this materialisation is
 * recorded under.
 *
 * Written before the isolation backend materialises `m` so a concurrent
 * `omp worktree clear` never sees an owner-less sandbox mid-creation, and
 * written atomically so a failure part-way never leaves a marker that reads as
 * owner-less.
 */
export async function writeIsolationOwner(baseDir: string, id: string): Promise<string> {
	const generation = `${process.pid}-${Snowflake.next()}`;
	await writeProcessIdentity(path.join(baseDir, ISOLATION_OWNER_FILE), { id, generation });
	return generation;
}

/** Mark a renamed-away sandbox as retired, so reclamation never mistakes it for a live owner's. */
export async function markIsolationRetired(baseDir: string): Promise<void> {
	await writeProcessIdentity(path.join(baseDir, ISOLATION_OWNER_FILE), { retired: true });
}

/**
 * Mark a sandbox whose teardown is still running in place, after an in-place
 * backend stop outran its bound. The stop can still delete this path, so
 * nothing may materialise here until it settles — and when it never does, the
 * marker names the process to wait on, so reclamation can retire it once that
 * process is gone.
 */
export async function markIsolationRetiring(baseDir: string): Promise<void> {
	await writeProcessIdentity(path.join(baseDir, ISOLATION_OWNER_FILE), { retiring: true });
}

/**
 * What the marker at `baseDir` says, told apart from not being able to read it.
 *
 * A teardown may only delete a sandbox it can still prove is its own, so
 * "the marker is damaged, truncated, unreadable or gone" has to be a distinct
 * answer from "the marker names someone": an old handle cannot establish
 * ownership from a marker nobody can read, and an unreadable marker is a
 * reclamation problem for `omp worktree clear` rather than a licence to
 * delete whatever is there now.
 */
export type IsolationClaim =
	/** The marker names the generation that currently owns the sandbox. */
	| { kind: "claimed"; generation: string }
	/** A teardown is still running on this path; nothing may materialise here. */
	| { kind: "retiring" }
	/** There is no marker here at all: this is not a sandbox. */
	| { kind: "absent" }
	/**
	 * A marker is here and cannot be read. Distinct from `absent` on purpose: a
	 * failure to look is not an absence, and treating an unreadable marker as
	 * "not a sandbox" is how a lease and a writer record both became successful
	 * no-ops over a workspace somebody was using.
	 */
	| { kind: "unknown"; reason: string };

/** Read the claim recorded for the sandbox at `baseDir`. */
export async function readIsolationClaim(baseDir: string): Promise<IsolationClaim> {
	// `readJsonLookup` asks `lstat` first, so a dangling marker symlink — whose
	// open gives `ENOENT` just as a missing one does — is an entry that exists
	// and cannot be read, which is unknown.
	const found = await fs.readJsonLookup(path.join(baseDir, ISOLATION_OWNER_FILE));
	if (found.kind === "absent") return { kind: "absent" };
	if (found.kind === "unknown") return { kind: "unknown", reason: found.reason };
	const decoded = found.value;
	if (typeof decoded !== "object" || decoded === null) {
		return { kind: "unknown", reason: "marker is not an object" };
	}
	if ("retiring" in decoded && decoded.retiring === true) return { kind: "retiring" };
	if (!("generation" in decoded)) {
		return { kind: "unknown", reason: "marker carries no generation" };
	}
	const generation = decoded.generation;
	if (typeof generation !== "string" || generation.length === 0) {
		return { kind: "unknown", reason: "marker generation is not a non-empty string" };
	}
	return { kind: "claimed", generation };
}

/**
 * Remove everything in a sandbox the caller has just claimed, keeping the
 * marker that records the claim. Materialising over an existing sandbox has to
 * destroy its contents; doing that only after the claim is written means there
 * is never a moment where live data sits under no marker, and the previous
 * owner's teardown finds a generation that is not its own.
 */
export async function clearClaimedWorkspace(baseDir: string): Promise<void> {
	requireSandboxLockHeld(baseDir, "empty");
	// A listing that fails is not an empty sandbox: reading it as one leaves
	// the previous owner's data in place under this run's claim, and the run
	// then works in a workspace it believes is clean.
	const listing = await fs.readdirLookup(baseDir);
	if (listing.kind === "absent") return;
	if (listing.kind === "unknown") {
		throw new Error(`Isolation workspace ${baseDir} could not be listed (${listing.reason}); refusing to clear it.`);
	}
	// The boundary of this guarantee, stated rather than left to be
	// rediscovered: the hold is checked before the rename and the rename is one
	// syscall, so nothing a peer writes afterwards is inside what goes. A
	// caller that detaches this call and releases its hold while the removal
	// below is already running is not covered — nothing can cancel a syscall
	// in flight. Every current caller awaits this function under its own hold.
	const entries = listing.value.filter(entry => entry !== ISOLATION_OWNER_FILE);
	if (entries.length === 0) return;
	// Moved aside in one step, then deleted.
	//
	// Checking the hold before each removal is still a check at the top of an
	// act: a removal already running keeps deleting after the hold ends, and
	// it erased a file a peer created in the directory it was walking. A
	// rename is a single syscall that either happened under this hold or did
	// not, and once it has, nothing a peer writes to the live path is inside
	// what this call deletes.
	const aside = path.join(baseDir, `${ISOLATION_CLEARING_PREFIX}${Snowflake.next()}`);
	await fs.mkdir(aside);
	requireSandboxLockHeld(baseDir, "empty");
	for (const entry of entries) {
		await fs.rename(path.join(baseDir, entry), path.join(aside, entry));
	}
	// Outside the hold's protection on purpose: this path is unreachable to
	// anybody else, so how long it takes no longer decides anything.
	await fs.rm(aside, { recursive: true, force: true });
}

/** Why a sandbox may or may not be reclaimed by something that did not materialise it. */
export interface IsolationReclaimDecision {
	/** True only when nothing provably still needs the sandbox. */
	reclaimable: boolean;
	/** The judgement in one phrase, for `omp worktree list` and the clear log. */
	reason: string;
}

/**
 * Whether the sandbox at `baseDir` may be reclaimed by a reclaimer — `omp
 * worktree clear` — that did not materialise it.
 *
 * This is the same rule the owner's teardown follows, asked from the other
 * side: deletion needs proof, and an error is not proof. A marker that cannot
 * be read says nothing about whether a task is running in there, so it keeps
 * the directory (`--all` is the way to delete anyway); a live owner or a live
 * lease keeps it; a marker a teardown retired is always reclaimable, because
 * its owner has already decided it is finished with it.
 */
export async function decideIsolationReclaim(baseDir: string): Promise<IsolationReclaimDecision> {
	const markerFile = path.join(baseDir, ISOLATION_OWNER_FILE);
	const marker = await fs.readJsonLookup(markerFile);
	if (marker.kind === "absent") {
		// A sandbox with no marker at all: a pre-marker leftover, or one whose
		// marker something removed. Neither is proof that no task is working
		// in there, and the marker is written before the backend materialises
		// anything, so a crashed run leaves one naming its dead process.
		// `--all` is the way to remove what cannot prove itself.
		return { reclaimable: false, reason: "no owner marker (use --all to remove)" };
	}
	if (marker.kind === "unknown") {
		return { reclaimable: false, reason: `owner marker unreadable (${marker.reason})` };
	}
	const decoded = marker.value;
	if (typeof decoded !== "object" || decoded === null) {
		return { reclaimable: false, reason: "owner marker unreadable (not an object)" };
	}
	// Asked before the retired shortcut: a directory its owner finished with
	// can still hold a writer that has not, and "retired" is a statement about
	// the owner alone.
	if (await hasUnfinishedWriter(baseDir)) {
		return { reclaimable: false, reason: "a live writer may still be saving into it" };
	}
	if ("retired" in decoded && decoded.retired === true) {
		return { reclaimable: true, reason: "task-isolation leftover (retired by its owner)" };
	}
	const identity = await readProcessIdentity(markerFile);
	if (identity === "unreadable" || identity === undefined) {
		return { reclaimable: false, reason: "owner marker unreadable (no usable owner identity)" };
	}
	if (await isProcessStillLive(identity)) {
		// Precise about what is known: the process that built this sandbox is
		// still running. That is not the same as a task still working in it —
		// a user who has just cleared the last lease and the last writer record
		// has no way to tell the two apart from "a live task owns it".
		const inUse = (await hasLiveIsolationLease(baseDir)) || (await hasUnfinishedWriter(baseDir));
		return {
			reclaimable: false,
			reason: inUse
				? `a live task is working in it (pid ${identity.pid})`
				: `the omp process that built it is still running (pid ${identity.pid}); it goes when that run ` +
					"finishes with it, or now with --all",
		};
	}
	if (await hasLiveIsolationLease(baseDir)) {
		return { reclaimable: false, reason: "a live session is working in it" };
	}
	if (await hasUnfinishedWriter(baseDir)) {
		// Its lease is gone — that is how a stalled disposal stops holding a
		// kernel — but it said it might still be saving in here, and deleting
		// the directory under that write loses the work either way.
		return { reclaimable: false, reason: "a live writer may still be saving into it" };
	}
	return { reclaimable: true, reason: "task-isolation leftover (no live task owns it)" };
}

/** Suffix of the name a reclaim moves a whole sandbox to before deleting it. */
export const ISOLATION_REMOVING_SUFFIX = ".removing-";

/** Prefix of the staging directory a clear moves a sandbox's contents into before deleting them. */
export const ISOLATION_CLEARING_PREFIX = ".omp-clearing-";

/** Sidecar recording the native-teardown backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".omp-retained-backend.json";

/**
 * Backends whose workspaces `omp worktree clear` must not remove with plain
 * recursive `rm`, but route through native `isoStop` teardown instead:
 * mounts (overlayfs, projfs), where `rm` destroys the preserved layer and
 * fails on the mountpoint, and Btrfs subvolumes, whose root is only removable
 * via subvolume delete (its `stop` falls back to plain `rm` for ordinary
 * dirs, so routing it is always safe). Plain-copy and reflink backends need
 * no teardown — and their `stop` routines delete data themselves, so they
 * must never be routed through it.
 *
 * Notably absent: ZFS clones also need dataset-aware teardown, but `isoStop`
 * locates the dataset by its recorded mountpoint property, which no longer
 * matches after the retain rename — that needs pi-iso mount-table support
 * before a sidecar here could help.
 */
export function needsNativeTeardown(backend: unknown): backend is number {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Projfs || backend === IsoBackendKind.Btrfs;
}

/**
 * Record which backend built a retained workspace, so cleanup can route it
 * through native teardown before removal. Best-effort: retention stays valid
 * without it (the workspace merely falls back to plain recursive removal).
 */
export async function writeRetainedBackend(baseDir: string, backend: number): Promise<void> {
	await fs.writeFileDeep(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
	);
}

/**
 * Backend recorded for a retained workspace when it needs native teardown
 * before remove. `undefined` only when no sidecar exists. Any other read
 * problem (permissions, I/O, malformed JSON) throws instead of reading as
 * absent: the workspace may be a live mount whose guard must not be silently
 * bypassed — the caller then leaves it in place rather than removing through
 * the mount. A well-formed record for a backend needing no teardown keeps
 * today's removal behavior.
 */
export async function readRetainedMountBackend(dir: string): Promise<number | undefined> {
	const sidecar = path.join(dir, RETAINED_BACKEND_FILE);
	// Three-valued throughout: `absent` is the only answer that means "no
	// sidecar". A dangling entry — which `stat` reports as `ENOENT` while
	// `lstat` sees it — and an unreadable one are both `unknown`, and the
	// caller is about to remove a possible mount, so unknown raises.
	const found = await fs.readJsonLookup(sidecar);
	if (found.kind === "absent") return undefined;
	if (found.kind === "unknown") {
		throw new Error(`retained-mount metadata at ${sidecar} could not be read: ${found.reason}`);
	}
	const decoded = found.value;
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	// A backend this build does not know is not a backend that needs no
	// teardown: answering "no" would route a possible mount to recursive
	// removal. It is unknown, and unknown raises.
	if (!isKnownBackend(backend)) {
		throw new Error(`retained-mount metadata at ${sidecar} names backend ${backend}, which this build does not know`);
	}
	if (!needsNativeTeardown(backend)) return undefined;
	return backend;
}

/** Whether `backend` is a backend value this build understands. */
function isKnownBackend(backend: number): boolean {
	return Object.values(IsoBackendKind).includes(backend as natives.IsoBackendKind);
}

/**
 * Explain a sandbox lock this caller could not take.
 *
 * The holder is knowable — the marker names it — and a caller that has just
 * waited a minute should be told who to look for rather than an attempt count.
 * Descriptor exhaustion is the one case where nothing can be said about the
 * holder, and it says that instead of guessing.
 */
export async function describeSandboxLockFailure(
	baseDir: string,
	purpose: string,
	error: unknown,
	waitedMs: number,
): Promise<Error> {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const text = error instanceof Error ? error.message : String(error);
	const waited = `${(waitedMs / 1000).toFixed(1)}s`;
	if (code === "EMFILE" || code === "ENFILE" || /EMFILE|ENFILE|too many open files/i.test(text)) {
		return new Error(
			`Could not ${purpose} isolation workspace ${baseDir}: this host is out of file descriptors ` +
				`(${code ?? "reported by the lock"}). The lock could not be opened at all, so whether anything ` +
				"holds the workspace is unknown; raise the open-file limit (`ulimit -n`) or reduce how many " +
				"sessions run at once.",
			{ cause: error },
		);
	}
	// Who *holds* the lock is not knowable from here — it is an anonymous
	// kernel object, and the pid in the marker is the run that recorded the
	// workspace, which is often a different process. Saying "held by pid N"
	// sent callers after the wrong one, and a lock that failed to open in a
	// millisecond is not contention at all; both are reported as what they are.
	const owner = await readProcessIdentity(path.join(baseDir, ISOLATION_OWNER_FILE)).catch(() => undefined);
	const recorded =
		owner === undefined || owner === "unreadable"
			? "its recorded owner is not readable"
			: `its marker records pid ${owner.pid} as the run that built it, which may not be the process holding the lock`;
	const claim = await readIsolationClaim(baseDir).catch(() => undefined);
	const state = claim === undefined ? "unknown" : claim.kind;
	// Contention is what the lock reports, not what the clock suggests: an
	// `EACCES` after a second is a failure to open, not a holder, and saying
	// "another run holds it" for one sends the caller after nobody.
	const contended = /attempts|timed out|lock is held/i.test(text);
	return new Error(
		`Could not ${purpose} isolation workspace ${baseDir} after ${waited} (${state}): ` +
			(contended
				? `another run holds the lock; the holder is not identifiable, and ${recorded}. A workspace is held ` +
					"while its task's patch is being saved, while it is being built, and while it is being removed. " +
					"Retry, or run `omp worktree list` to see what owns it."
				: `the lock could not be taken at all (${text}); nothing is known about a holder, and ${recorded}.`),
		{ cause: error },
	);
}

/**
 * Sandbox paths whose lock the current async context holds.
 *
 * A hold is *detected*, never declared. The flag this replaces had to be
 * passed by hand: the one production caller forgot it and deadlocked against
 * its own lock for sixty seconds, and a caller that asserted it wrongly walked
 * straight through a peer's hold and moved a workspace in five milliseconds.
 * The code should look rather than be told.
 */
const heldSandboxLocks = new AsyncLocalStorage<Map<string, SandboxLockHandle>>();

/**
 * A hold, recorded as the lock itself rather than as a note that one was
 * taken. Releasing the lock invalidates it, so "do I hold this?" is answered
 * by the lock's own state: a boolean left in a context is still a declaration,
 * just one the code wrote instead of the caller, and an unawaited child kept
 * it true long enough to move a workspace a different process was holding.
 */
export interface SandboxLockHandle {
	/** The sandbox this lock is for. A handle for another one is not this hold. */
	readonly baseDir: string;
	release(): void;
	/** Whether this lock is still held, asked of the lock rather than of a note. */
	isHeld(): boolean;
}

/**
 * Run `body` inside the hold of a lock this caller has already acquired, so
 * everything `body` calls detects the hold instead of waiting on it.
 *
 * The lock itself is what gets recorded — there is no way to assert a hold
 * without having taken one, and releasing it invalidates the record.
 */
export async function runHoldingSandboxLock<T>(
	baseDir: string,
	lock: SandboxLockHandle,
	body: () => Promise<T>,
): Promise<T> {
	// A real handle for a different sandbox is not a hold on this one: it was
	// accepted once, and retention moved a workspace a second process held.
	if (lock.baseDir !== baseDir) {
		throw new Error(`Sandbox lock for ${lock.baseDir} cannot stand for a hold on ${baseDir}.`);
	}
	const held = new Map(heldSandboxLocks.getStore() ?? []);
	held.set(baseDir, lock);
	return await heldSandboxLocks.run(held, body);
}

/**
 * Whether the caller's async context holds the lock for `baseDir` *now*.
 *
 * Asked of the lock, not of a flag left behind: an unawaited child outlives
 * the call that recorded the hold, and a recorded boolean stayed true after
 * its wrapper released, which let retention move a workspace another process
 * was holding.
 */
export function holdsSandboxLock(baseDir: string): boolean {
	return heldSandboxLocks.getStore()?.get(baseDir)?.isHeld() === true;
}

/**
 * Raise unless this call's hold on `baseDir` is live *now*.
 *
 * Asked immediately before an act that cannot be undone. A body that entered
 * under the lock is not a body that still holds it: one resumed after its
 * wrapper had released and renamed a workspace while another process held the
 * native lock. Entering under a hold authorises nothing by itself.
 */
export function requireSandboxLockHeld(baseDir: string, act: string): void {
	if (holdsSandboxLock(baseDir)) return;
	throw new Error(`Refusing to ${act} ${baseDir}: this call no longer holds that workspace's lock.`);
}

/**
 * Run `body` holding the sandbox lock, with the hold visible to everything it
 * calls. Re-entering for the same sandbox inside `body` takes no second lock.
 */
export async function withSandboxLock<T>(baseDir: string, purpose: string, body: () => Promise<T>): Promise<T> {
	if (holdsSandboxLock(baseDir)) return await body();
	const lock = await acquireSandboxLockWithNotice(baseDir, purpose);
	try {
		return await runHoldingSandboxLock(baseDir, lock, body);
	} finally {
		lock.release();
	}
}

/** How long a lock wait runs before the caller is told it is waiting, and how often after. */
const SANDBOX_LOCK_NOTICE_MS = 1_000;
const SANDBOX_LOCK_REMINDER_MS = 30_000;

/**
 * Every sandbox lock this process currently holds.
 *
 * Its only job is reachability: a native lock is released when its JavaScript
 * handle is collected, and a suspended async frame did not keep one alive.
 */
const heldByThisProcess = new Set<SandboxLockHandle>();

/** Set once: stderr keeps a no-op error listener so a late stream failure cannot kill the run. */
let stderrGuarded = false;

/**
 * Write a diagnostic to stderr, and never fail because of it.
 *
 * A closed descriptor throws here; a broken pipe fails *later*, as a stream
 * error with no listener, which terminates the process. Both killed children
 * that were a moment away from being granted the lock they were waiting for.
 * A diagnostic is not worth a run, so the synchronous throw, the write
 * callback's error and the stream's own error event are all swallowed.
 */
function writeNoticeSafely(text: string): void {
	try {
		const stream = process.stderr;
		if (!stderrGuarded) {
			stderrGuarded = true;
			stream.on?.("error", () => {
				// Nothing to do: the caller cannot be told. That is not a failure
				// of the work it is doing.
			});
		}
		stream.write(text, () => {
			// Swallows the asynchronous failure the callback reports.
		});
	} catch {
		// Swallows the synchronous one.
	}
}

/**
 * Take a sandbox lock, telling the caller at the *start* of a wait rather than
 * at the end of it.
 *
 * The wait itself is unchanged — shortening it would only trade a slow
 * materialisation for a failed one — but there is no reason the caller should
 * learn in the sixtieth second what can be said in the first. The notice
 * carries what is actually knowable: the holder of the lock is an anonymous
 * kernel object, and the pid in the marker is the run that built the
 * workspace, which may not be the holder.
 */
export async function acquireSandboxLockWithNotice(baseDir: string, purpose: string): Promise<SandboxLockHandle> {
	const startedAt = Date.now();
	const announce = async (): Promise<void> => {
		try {
			const owner = await readProcessIdentity(path.join(baseDir, ISOLATION_OWNER_FILE)).catch(() => undefined);
			const recorded =
				owner === undefined || owner === "unreadable"
					? "its recorded owner is not readable"
					: `its marker records pid ${owner.pid} as the run that built it, which may not be the process holding the lock`;
			// Clearing a timer does not cancel a callback that is already running,
			// and the marker read above takes time: a notice that announces after
			// the lock was taken says the opposite of the truth.
			if (settled) return;
			// Says only what is true at this moment: the lock has not been granted.
			// Whether that is a holder or a lock that cannot be opened is not known
			// until the attempt ends, and claiming a holder here contradicted the
			// failure that followed.
			const message =
				`Waiting for the isolation workspace lock to ${purpose} ${baseDir} — it has not been granted yet. ` +
				`If another run holds it, the holder is not identifiable, and ${recorded}. ` +
				"`omp worktree list` shows what owns it.";
			writeNoticeSafely(`${message}\n`);
			logger.warn(`Waiting for the isolation workspace lock to ${purpose} ${baseDir}`, {
				waitedMs: Date.now() - startedAt,
				detail:
					`It has not been granted yet. If another run holds it, the holder is not identifiable, and ` +
					`${recorded}. A workspace is held while its task's patch is being saved, while it is being ` +
					"built, and while it is being removed. `omp worktree list` shows what owns it. Whether this " +
					"wait ends in a grant or in a lock that could not be opened is said by the final error.",
			});
		} catch {
			// An announcement that fails is still only an announcement.
		}
	};
	let settled = false;
	const notice = setTimeout(() => void announce(), SANDBOX_LOCK_NOTICE_MS);
	const reminder = setInterval(() => void announce(), SANDBOX_LOCK_REMINDER_MS);
	notice.unref?.();
	reminder.unref?.();
	try {
		const lock = await acquireFileLock(baseDir, SANDBOX_LOCK_WAIT);
		// The handle carries its own state, so a hold recorded against it stops
		// being a hold the moment it is released.
		let released = false;
		const handle: SandboxLockHandle = {
			baseDir,
			release: () => {
				// Idempotent **after a release that worked**: a caller that
				// hands this handle to a continuation and a `finally` that
				// also releases must not unlock twice.
				//
				// Deliberately not idempotent after one that threw. The flag
				// is set only once the unlock has succeeded, so a retry calls
				// the native release again — which is the behaviour a caller
				// needs, because a throw leaves it unknown whether the lock
				// was dropped, and treating the attempt as done would strand
				// it for the life of the process. The measured consequence is
				// a second native call on that path, and that is the trade:
				// one extra call against a lock nobody can release.
				if (released) return;
				// Marked released only once the lock really is: a native
				// release that threw left the wrapper saying "not held" while
				// the lock was still held, which is the same disagreement the
				// boolean caused, with the sign reversed.
				lock.release();
				released = true;
				heldByThisProcess.delete(handle);
			},
			// Asked of the lock, not of the boolean beside it: a handle released
			// by another route, or one whose release threw, leaves the two
			// disagreeing, and the hold is whatever the lock says it is.
			isHeld: () => !released && lock.acquired,
		};
		// Reachable for as long as it is held. A teardown whose capture outran
		// its deadline sits for ever in `await capturing`, and its frame was
		// not enough to keep the native lock alive: the lock was dropped about
		// a second after the deadline and the workspace this teardown was
		// holding became free to take, which is the opposite of what the
		// deadline promises.
		heldByThisProcess.add(handle);
		return handle;
	} catch (error) {
		throw await describeSandboxLockFailure(baseDir, purpose, error, Date.now() - startedAt);
	} finally {
		settled = true;
		clearTimeout(notice);
		clearInterval(reminder);
	}
}
