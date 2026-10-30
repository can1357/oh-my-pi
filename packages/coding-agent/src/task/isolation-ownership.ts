/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { isEnoent, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { hasLiveIsolationLease } from "./isolation-lease";

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
	try {
		return await fs.realpath(absolute);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		const parent = path.dirname(absolute);
		if (parent === absolute) return absolute;
		return path.join(await resolveSandboxIdentity(parent), path.basename(absolute));
	}
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
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
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
		await Bun.write(temporary, contents);
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** The identity recorded in `file`, `undefined` when there is none, `"unreadable"` when it cannot be read. */
export async function readProcessIdentity(file: string): Promise<ProcessIdentity | "unreadable" | undefined> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		return "unreadable";
	}
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
	/** The marker cannot be read, or carries no generation. */
	| { kind: "unknown"; reason: string };

/** Read the claim recorded for the sandbox at `baseDir`. */
export async function readIsolationClaim(baseDir: string): Promise<IsolationClaim> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch (error) {
		return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
	}
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
	const entries = await fs.readdir(baseDir).catch(() => [] as string[]);
	for (const entry of entries) {
		if (entry === ISOLATION_OWNER_FILE) continue;
		await fs.rm(path.join(baseDir, entry), { recursive: true, force: true });
	}
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
	let decoded: unknown;
	try {
		decoded = await Bun.file(markerFile).json();
	} catch (error) {
		if (isEnoent(error)) {
			// A sandbox with no marker at all: a pre-marker leftover, or one whose
			// marker something removed. Neither is proof that no task is working
			// in there, and the marker is written before the backend materialises
			// anything, so a crashed run leaves one naming its dead process.
			// `--all` is the way to remove what cannot prove itself.
			return { reclaimable: false, reason: "no owner marker (use --all to remove)" };
		}
		return { reclaimable: false, reason: `owner marker unreadable (${errorText(error)})` };
	}
	if (typeof decoded !== "object" || decoded === null) {
		return { reclaimable: false, reason: "owner marker unreadable (not an object)" };
	}
	if ("retired" in decoded && decoded.retired === true) {
		return { reclaimable: true, reason: "task-isolation leftover (retired by its owner)" };
	}
	const identity = await readProcessIdentity(markerFile);
	if (identity === "unreadable" || identity === undefined) {
		return { reclaimable: false, reason: "owner marker unreadable (no usable owner identity)" };
	}
	if (await isProcessStillLive(identity)) {
		return { reclaimable: false, reason: "a live task owns it" };
	}
	if (await hasLiveIsolationLease(baseDir)) {
		return { reclaimable: false, reason: "a live session is working in it" };
	}
	return { reclaimable: true, reason: "task-isolation leftover (no live task owns it)" };
}

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
	await Bun.write(
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
	if (!(await Bun.file(sidecar).exists())) return undefined;
	const decoded: unknown = await Bun.file(sidecar).json();
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	if (!needsNativeTeardown(backend)) return undefined;
	return backend;
}

/** One-line text for an error recorded in a reclaim decision. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
