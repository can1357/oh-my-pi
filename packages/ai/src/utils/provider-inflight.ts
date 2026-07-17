/**
 * Cross-process per-provider in-flight request limiter.
 *
 * Independent OMP processes share one request budget per provider id by
 * coordinating through lease directories on the local filesystem:
 *
 *   <root>/<provider>/                    provider directory
 *   <root>/<provider>/<token>/            lease directory, one per in-flight request
 *   <root>/<provider>/<token>/info.json   holder info: { pid, timestamp, token }
 *   <root>/<provider>/.lock/              mutex directory guarding lease mutation
 *   <root>/<provider>/.lock/info.json     holder info for the mutex
 *   <root>/<provider>/.waiter-<pid>-*     marker file, one per queued waiter
 *   <root>/<provider>/.wakeup             touched when a released slot has waiters
 *
 * Dispatching a limited request acquires a lease under the provider directory;
 * when every slot is taken the request queues, watching `.wakeup` and polling
 * as a fallback. A release only touches `.wakeup` when a live waiter marker
 * exists, so plain acquire/release cycles leave no wakeup file behind.
 *
 * Crash recovery reaps leases and locks whose recorded pid is dead. Unreadable
 * holder info counts as active while its mtime is fresh (the owner may still be
 * mid-write) and is reaped once stale; a readable holder with a live pid is
 * never reaped, no matter how old its timestamp. Reaping is guarded: a holder
 * is only deleted while it still matches the observation (inode + token) that
 * judged it stale, so a fresh lock that replaced a reaped one is never
 * clobbered by a slower concurrent reaper.
 */

import * as crypto from "node:crypto";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "../error";
import { AssistantMessageEventStream } from "./event-stream";

const LOCK_DIR_NAME = ".lock";
const WAKEUP_FILE_NAME = ".wakeup";
const WAITER_MARKER_PREFIX = ".waiter-";
const INFO_FILE_NAME = "info.json";
/** Age past which a holder with unreadable info counts as abandoned. */
const HOLDER_STALE_MS = 30_000;
/** Poll interval for queued slot waiters; `.wakeup` watching cuts the latency. */
const SLOT_POLL_MS = 50;
/** Retry interval while the lease mutex is held by another process. */
const LOCK_POLL_MS = 25;

/** Identity a lease or lock directory records for its owner. */
interface HolderInfo {
	pid: number;
	timestamp: number;
	token: string;
}

/** Snapshot used to guard deletes: only remove a holder that still matches. */
interface HolderObservation {
	ino: number;
	token: string | null;
}

const DEFAULT_ROOT = path.join(
	os.tmpdir(),
	`omp-provider-inflight${typeof process.getuid === "function" ? `-${process.getuid()}` : ""}`,
);
let limiterRoot = DEFAULT_ROOT;

/** Process-global default limits, keyed by provider id. Per-request
 *  `maxInFlightRequests` entries take precedence over these. */
let globalProviderLimits: Record<string, number> | undefined;

/**
 * Configure process-global default per-provider in-flight request limits.
 * Pass `undefined` to clear. Hosts call this from settings hooks so every
 * `streamSimple` call in the process picks the limits up without threading
 * options through.
 */
export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	globalProviderLimits = limits;
}

/**
 * Resolve the effective limit for `provider`: the per-request map wins over
 * the process-global configuration; entries that are not positive finite
 * numbers mean "unlimited".
 */
export function resolveProviderMaxInFlightRequests(
	provider: string,
	perRequest: Record<string, number> | undefined,
): number | undefined {
	const limit = perRequest?.[provider] ?? globalProviderLimits?.[provider];
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return undefined;
	return Math.floor(limit);
}

/** Provider ids are user/extension-supplied — encode them into a single opaque
 *  path segment (readable prefix + content hash) so ids like `..` cannot
 *  escape the limiter root. */
function providerPathSegment(provider: string): string {
	const hash = crypto.createHash("sha256").update(provider).digest("hex").slice(0, 12);
	const readable = provider.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
	return readable.length > 0 ? `${readable}-${hash}` : hash;
}

function providerDirFor(provider: string): string {
	return path.join(limiterRoot, providerPathSegment(provider));
}

function lockDirFor(provider: string): string {
	return path.join(providerDirFor(provider), LOCK_DIR_NAME);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the pid exists but belongs to another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function abortReason(signal: AbortSignal | undefined): unknown {
	return signal?.reason ?? new AIError.AbortError("Request aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortReason(signal);
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function readHolderInfo(dir: string): Promise<HolderInfo | null> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, INFO_FILE_NAME), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<HolderInfo> | null;
		if (!parsed || typeof parsed !== "object" || typeof parsed.pid !== "number") return null;
		return {
			pid: parsed.pid,
			timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
			token: typeof parsed.token === "string" ? parsed.token : "",
		};
	} catch {
		return null;
	}
}

async function writeHolderInfo(dir: string, token: string): Promise<void> {
	const info: HolderInfo = { pid: process.pid, timestamp: Date.now(), token };
	await fs.writeFile(path.join(dir, INFO_FILE_NAME), JSON.stringify(info));
}

/**
 * Classify a lease/lock directory. Readable info defers to pid liveness — a
 * live holder is active no matter how old its timestamp. Unreadable info (the
 * owner may still be mid-write, or crashed before writing) counts as active
 * while the mtime is fresh and stale once it ages out.
 */
async function inspectHolder(dir: string): Promise<"active" | "stale" | "gone"> {
	const info = await readHolderInfo(dir);
	if (info) return isPidAlive(info.pid) ? "active" : "stale";
	let mtimeMs: number;
	try {
		mtimeMs = (await fs.stat(path.join(dir, INFO_FILE_NAME))).mtimeMs;
	} catch {
		try {
			mtimeMs = (await fs.stat(dir)).mtimeMs;
		} catch {
			return "gone";
		}
	}
	return Date.now() - mtimeMs < HOLDER_STALE_MS ? "active" : "stale";
}

async function observeHolder(dir: string): Promise<HolderObservation | null> {
	let ino: number;
	try {
		ino = (await fs.stat(dir)).ino;
	} catch {
		return null;
	}
	const info = await readHolderInfo(dir);
	return { ino, token: info?.token ?? null };
}

/**
 * Delete `dir` only if it still matches `observed`. Between observing a stale
 * holder and deleting it, another process may have reaped it first and created
 * a fresh holder in its place — the inode and token checks make the delete a
 * no-op in that case instead of clobbering the live replacement.
 */
async function removeHolderIfUnchanged(dir: string, observed: HolderObservation): Promise<void> {
	const current = await observeHolder(dir);
	if (!current) return;
	if (current.ino !== observed.ino) return;
	if (current.token !== observed.token) return;
	await fs.rm(dir, { recursive: true, force: true });
}

/**
 * If the holder at `dir` is stale, capture a guarded release that deletes it
 * only while it still matches what was observed. Returns null for a live,
 * fresh, or missing holder.
 */
async function captureStaleHolderRelease(dir: string): Promise<(() => Promise<void>) | null> {
	if ((await inspectHolder(dir)) !== "stale") return null;
	const observed = await observeHolder(dir);
	if (!observed) return null;
	return () => removeHolderIfUnchanged(dir, observed);
}

/**
 * Capture a guarded cleanup for a holder directory we just created — used when
 * writing `info.json` fails after the mkdir succeeded. The cleanup deletes the
 * directory only while it still matches the captured observation, so a fresh
 * lock that replaced ours in the meantime survives.
 */
async function captureHolderDirRelease(dir: string): Promise<(() => Promise<void>) | null> {
	const observed = await observeHolder(dir);
	if (!observed) return null;
	return () => removeHolderIfUnchanged(dir, observed);
}

/**
 * Acquire the provider mutex by creating the lock directory. A held lock with
 * a live owner is honored (short abortable poll); a stale lock is reaped via
 * the guarded release and the mkdir retried immediately.
 */
async function acquireDirLock(lockDir: string, signal: AbortSignal | undefined): Promise<() => Promise<void>> {
	while (true) {
		throwIfAborted(signal);
		try {
			await fs.mkdir(lockDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const reap = await captureStaleHolderRelease(lockDir);
			if (reap) {
				await reap();
				continue;
			}
			await abortableSleep(LOCK_POLL_MS, signal);
			continue;
		}
		const token = crypto.randomUUID();
		try {
			await writeHolderInfo(lockDir, token);
		} catch (err) {
			const cleanup = await captureHolderDirRelease(lockDir);
			if (cleanup) await cleanup();
			throw err;
		}
		const observed = await observeHolder(lockDir);
		return async () => {
			if (observed) await removeHolderIfUnchanged(lockDir, observed);
		};
	}
}

/**
 * Count active leases under the provider directory, reaping stale ones as a
 * side effect. Must be called while holding the provider mutex. Dot-prefixed
 * entries (`.lock`, `.wakeup`, waiter markers) and plain files are skipped.
 */
async function countActiveLeases(providerDir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(providerDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let active = 0;
	for (const entry of entries) {
		if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
		const leaseDir = path.join(providerDir, entry.name);
		const state = await inspectHolder(leaseDir);
		if (state === "active") {
			active++;
		} else if (state === "stale") {
			await fs.rm(leaseDir, { recursive: true, force: true });
		}
	}
	return active;
}

/** Create a lease directory. Must be called while holding the provider mutex. */
async function createLease(providerDir: string): Promise<string> {
	const token = crypto.randomUUID();
	const leaseDir = path.join(providerDir, token);
	await fs.mkdir(leaseDir);
	try {
		await writeHolderInfo(leaseDir, token);
	} catch (err) {
		await fs.rm(leaseDir, { recursive: true, force: true });
		throw err;
	}
	return leaseDir;
}

/**
 * True when any waiter marker with a live pid exists. Markers left by dead
 * processes are removed on the way through.
 */
async function hasLiveWaiters(providerDir: string): Promise<boolean> {
	let names: string[];
	try {
		names = await fs.readdir(providerDir);
	} catch {
		return false;
	}
	let found = false;
	for (const name of names) {
		if (!name.startsWith(WAITER_MARKER_PREFIX)) continue;
		const pid = Number.parseInt(name.slice(WAITER_MARKER_PREFIX.length), 10);
		if (Number.isFinite(pid) && isPidAlive(pid)) {
			found = true;
			continue;
		}
		await fs.rm(path.join(providerDir, name), { force: true });
	}
	return found;
}

/** In-process wakeup fan-out so same-process waiters skip the poll latency. */
const localWaiters = new Map<string, Set<() => void>>();

function notifyLocalWaiters(providerDir: string): void {
	const set = localWaiters.get(providerDir);
	if (!set) return;
	for (const wake of [...set]) wake();
}

/**
 * Wait for a wakeup: an in-process release, a `.wakeup` write from another
 * process, or the poll interval — whichever comes first. Rejects with the
 * abort reason when `signal` fires.
 */
function waitForSlotWakeup(providerDir: string, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		let watcher: FSWatcher | undefined;
		const set = localWaiters.get(providerDir) ?? new Set<() => void>();
		localWaiters.set(providerDir, set);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			set.delete(wake);
			if (set.size === 0) localWaiters.delete(providerDir);
			watcher?.close();
		};
		let settled = false;
		const wake = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};
		const timer = setTimeout(wake, SLOT_POLL_MS);
		set.add(wake);
		signal?.addEventListener("abort", onAbort, { once: true });
		// Best-effort watcher; polling covers platforms where watch is flaky.
		try {
			watcher = watch(providerDir, (_event, filename) => {
				if (filename === WAKEUP_FILE_NAME) wake();
			});
			watcher.on("error", () => {});
		} catch {
			// fall back to polling
		}
	});
}

/**
 * Release a held lease. Writes `.wakeup` only when a live waiter marker exists
 * — releasing with nobody queued must not leave a wakeup file behind.
 */
async function releaseProviderSlot(providerDir: string, leaseDir: string): Promise<void> {
	await fs.rm(leaseDir, { recursive: true, force: true });
	if (await hasLiveWaiters(providerDir)) {
		await fs.writeFile(path.join(providerDir, WAKEUP_FILE_NAME), String(Date.now()));
	}
	notifyLocalWaiters(providerDir);
}

/**
 * Acquire an in-flight slot for `provider`, waiting for capacity when all
 * slots are leased. Returns the release function for the acquired lease.
 * Rejects with the abort reason (and never dispatches) when `signal` fires
 * while queued.
 */
export async function acquireProviderSlot(
	provider: string,
	limit: number,
	signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
	const providerDir = providerDirFor(provider);
	const lockDir = path.join(providerDir, LOCK_DIR_NAME);
	await fs.mkdir(providerDir, { recursive: true });
	let marker: string | undefined;
	try {
		while (true) {
			throwIfAborted(signal);
			const unlock = await acquireDirLock(lockDir, signal);
			let leaseDir: string | undefined;
			try {
				if ((await countActiveLeases(providerDir)) < limit) {
					leaseDir = await createLease(providerDir);
				}
			} finally {
				await unlock();
			}
			if (leaseDir !== undefined) {
				const acquired = leaseDir;
				return () => releaseProviderSlot(providerDir, acquired);
			}
			if (marker === undefined) {
				// Advertise the queued waiter cross-process so releases know a
				// `.wakeup` write would actually be consumed.
				marker = path.join(providerDir, `${WAITER_MARKER_PREFIX}${process.pid}-${crypto.randomUUID()}`);
				await fs.writeFile(marker, String(Date.now()));
			}
			await waitForSlotWakeup(providerDir, signal);
		}
	} finally {
		if (marker !== undefined) await fs.rm(marker, { force: true });
	}
}

/**
 * Gate `run` behind a provider slot: acquire before dispatch, pipe the inner
 * stream through, release when the request settles. An abort while queued (or
 * between acquisition and dispatch) rejects with the abort reason without ever
 * dispatching.
 */
export function streamWithProviderSlot(
	provider: string,
	limit: number,
	signal: AbortSignal | undefined,
	makeStream: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		try {
			release = await acquireProviderSlot(provider, limit, signal);
			throwIfAborted(signal);
			const inner = makeStream();
			for await (const event of inner) {
				outer.push(event);
			}
			if (!outer.done) outer.end(await inner.result());
		} catch (err) {
			if (!outer.done) outer.fail(err);
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Best-effort: a failed lease cleanup is reaped as stale later.
				}
			}
		}
	})();
	return outer;
}

/** Test-only backdoor: relocate the limiter root and inspect its layout. */
export const __providerInFlightForTesting = {
	/** Override the limiter root; `undefined` restores the default. */
	setRoot(root: string | undefined): void {
		limiterRoot = root ?? DEFAULT_ROOT;
	},
	providerDir(provider: string): string {
		return providerDirFor(provider);
	},
	lockDir(provider: string): string {
		return lockDirFor(provider);
	},
	/** Guarded reap of a stale lock, as the acquire path would perform it. */
	captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		return captureStaleHolderRelease(lockDirFor(provider));
	},
	/** Guarded write-failure cleanup of the current lock directory. */
	captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		return captureHolderDirRelease(lockDirFor(provider));
	},
};
