/**
 * Durable ownership registry for targets in the project-shared broker-owned
 * Chromium (`omp.browser.headless`/`omp.browser.headed`).
 *
 * The shared browser outlives any single omp process, but tab ownership is
 * otherwise tracked only in that process's memory (`tab-supervisor`'s `tabs`
 * map). When a session ends abnormally (crash, SIGKILL, cleanup timeout) its
 * in-process map dies with it and the pages it opened stay open in the shared
 * Chromium forever, accumulating into multi-GB orphan targets (issue #10022).
 *
 * This module records, on disk under the broker runtime dir, which OS process
 * created each shared-browser page target. Any live omp process can then reap
 * targets whose owning process is gone. It only ever touches OMP-owned
 * shared-browser targets — user-owned connected/relay/spawned browsers have no
 * registry and are never scanned.
 *
 * Ownership is authoritative in the safe direction: a target is reaped only
 * when its owner PID reports `ESRCH` (definitively dead). A live PID is never
 * reaped, so a live session's tabs cannot be yanked out from under it; the
 * worst case (recycled PID) leaves an orphan uncollected rather than closing a
 * live page.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isPidAlive, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Connection } from "puppeteer-core";
import { daemonRuntimeDir } from "../../launch/paths";
import { browserConnection } from "./launch";

/** Identifies one shared-browser daemon's target registry. */
export interface SharedTargetScope {
	/** Canonical project directory owning the broker (as stamped on the handle). */
	projectDir: string;
	/** Broker daemon name, e.g. `omp.browser.headless`. */
	daemonName: string;
}

/** On-disk ownership record: one file per owning omp process. */
interface OwnershipFile {
	pid: number;
	updatedAt: number;
	targets: string[];
}

/**
 * Reap only records whose owner has been dead AND untouched for this long.
 * The PID probe is already authoritative; the grace window is a conservative
 * guard against clock skew and PID reuse races, and keeps a just-crashed
 * process's very fresh records around briefly in case it is being restarted.
 */
const DEFAULT_GRACE_MS = 15_000;

/** Re-send cadence and overall budget of {@link closeSharedTargetUntilGone}. */
const RECLOSE_INTERVAL_MS = 2_000;
const RECLOSE_BUDGET_MS = 30_000;
/** Per-target budget of {@link retryUnclosedSharedTargets}, so a sweep over many targets stays bounded. */
const RETRY_CLOSE_BUDGET_MS = 5_000;

/** In-process set of shared-browser targets this process created, keyed by registry dir. */
const ownedByDir = new Map<string, Set<string>>();
/** Owned targets whose close this process could not confirm, keyed by registry dir. */
const unclosedByDir = new Map<string, Set<string>>();
/** In-flight {@link retryUnclosedSharedTargets} run per registry dir. */
const unclosedRetries = new Map<string, Promise<number>>();
/** Per-registry-dir write serialization so concurrent record/forget can't tear the file. */
const writeChains = new Map<string, Promise<void>>();

function registryDir(scope: SharedTargetScope): string {
	return path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
}

/** Serialize a write against others for the same registry dir. */
function chain(dir: string, task: () => Promise<void>): Promise<void> {
	const prev = writeChains.get(dir) ?? Promise.resolve();
	const next = prev.then(task, task);
	writeChains.set(
		dir,
		next.catch(() => undefined),
	);
	return next;
}

/** Persist (or, when empty, remove) this process's ownership file for a registry dir. */
async function flush(dir: string): Promise<void> {
	const owned = ownedByDir.get(dir);
	const file = path.join(dir, `${process.pid}.json`);
	if (!owned || owned.size === 0) {
		await fs.rm(file, { force: true }).catch(() => undefined);
		return;
	}
	const record: OwnershipFile = { pid: process.pid, updatedAt: Date.now(), targets: [...owned] };
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(tmp, JSON.stringify(record));
	await fs.rename(tmp, file);
}

/** Record that this process created `targetId` in the given shared browser. */
export async function recordSharedTarget(scope: SharedTargetScope, targetId: string): Promise<void> {
	const dir = registryDir(scope);
	let owned = ownedByDir.get(dir);
	if (!owned) {
		owned = new Set();
		ownedByDir.set(dir, owned);
	}
	owned.add(targetId);
	await chain(dir, () => flush(dir)).catch(err =>
		logger.debug("Failed to record shared-browser target ownership", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** Drop `targetId` from this process's ownership file (closed the normal way). */
export async function forgetSharedTarget(scope: SharedTargetScope, targetId: string): Promise<void> {
	const dir = registryDir(scope);
	unclosedByDir.get(dir)?.delete(targetId);
	const owned = ownedByDir.get(dir);
	if (!owned?.delete(targetId)) return;
	await chain(dir, () => flush(dir)).catch(err =>
		logger.debug("Failed to update shared-browser target ownership", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/**
 * Drop every target this process still claims in `scope`. For when the whole
 * shared browser is confirmed gone — the broker reported its daemon in a
 * terminal state after a stop — which takes the targets that could not be
 * closed with it; the records are dead weight that would otherwise be
 * rewritten on every later write until this process exits. Only call this on
 * that confirmation: while the browser lives, the records are the only handle
 * a later reap has on its orphaned targets.
 */
export async function forgetSharedTargets(scope: SharedTargetScope): Promise<void> {
	const dir = registryDir(scope);
	unclosedByDir.delete(dir);
	const owned = ownedByDir.get(dir);
	if (!owned || owned.size === 0) return;
	owned.clear();
	await chain(dir, () => flush(dir)).catch(err =>
		logger.debug("Failed to clear shared-browser target ownership", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** Options for {@link collectOrphanTargets}; the defaults hit the real registry, the seams are for tests. */
export interface CollectOrphanOptions {
	/** Wall clock; injectable for deterministic grace-window tests. */
	now?: () => number;
	/** PID liveness probe; injectable so tests need no real subprocesses. */
	isAlive?: (pid: number) => boolean;
	/** Grace window in ms before a dead owner's records are eligible. */
	graceMs?: number;
}

/** Targets belonging to one dead process, kept grouped so partial failures remain retryable. */
export interface OrphanOwner {
	file: string;
	pid: number;
	updatedAt: number;
	targetIds: string[];
}

/** Orphan-scan result grouped by durable ownership file. */
export interface OrphanScan {
	owners: OrphanOwner[];
}

/**
 * Scan a registry dir for targets whose owning process is gone. Returns one
 * entry per dead owner so a reaper can retain only targets whose CDP closure
 * was not confirmed. This process's own file and every live-owner file are
 * left untouched.
 */
export async function collectOrphanTargets(
	scope: SharedTargetScope,
	opts: CollectOrphanOptions = {},
): Promise<OrphanScan> {
	const now = opts.now ?? Date.now;
	const isAlive = opts.isAlive ?? isPidAlive;
	const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
	const dir = registryDir(scope);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return { owners: [] };
		throw err;
	}
	const owners: OrphanOwner[] = [];
	const nowMs = now();
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let record: OwnershipFile;
		try {
			record = (await Bun.file(file).json()) as OwnershipFile;
		} catch {
			continue; // torn or malformed file; a live owner will rewrite it
		}
		if (typeof record?.pid !== "number" || !Array.isArray(record.targets)) continue;
		if (record.pid === process.pid) continue; // our own file
		if (isAlive(record.pid)) continue; // owner still running
		if (nowMs - (record.updatedAt ?? 0) < graceMs) continue; // conservative grace
		owners.push({
			file,
			pid: record.pid,
			updatedAt: record.updatedAt,
			targetIds: record.targets.filter(id => typeof id === "string"),
		});
	}
	return { owners };
}

/**
 * How long {@link closeCdpTarget} waits by default for Chromium to destroy a target whose close it accepted.
 * Past it the close counts as unconfirmed, as a failed one does.
 */
const CLOSE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Close a page target by id on the browser's root connection. Returns true only
 * when CDP reports the target destroyed or confirms it no longer exists; a
 * dropped connection or transient protocol failure returns false so durable
 * ownership remains available for a later retry. Never throws.
 *
 * A browser-target session per call would race: overlapping ones make puppeteer
 * lose the browser target (puppeteer#15750). Puppeteer enables target discovery
 * on the root connection when it connects, so `Target.targetDestroyed` arrives there.
 *
 * `Target.closeTarget` answers `success` once Chromium has started closing the
 * page, not once it is gone: the target stays listed until its renderer has
 * unloaded it. Its `Target.targetDestroyed` confirms the close instead, as it
 * does for Puppeteer's own `page.close()`.
 *
 * A caller that bounds the whole close MUST pass a `confirmTimeoutMs` well below
 * its budget, so a missed `targetDestroyed` still leaves time for the
 * `Target.getTargets` absence check to decide the result.
 */
export async function closeCdpTarget(
	browser: Browser,
	targetId: string,
	confirmTimeoutMs = CLOSE_CONFIRM_TIMEOUT_MS,
): Promise<boolean> {
	let connection: Connection;
	try {
		connection = browserConnection(browser);
	} catch {
		return false;
	}
	const destroyed = Promise.withResolvers<boolean>();
	const onDestroyed = (event: { targetId: string }): void => {
		if (event.targetId === targetId) destroyed.resolve(true);
	};
	connection.on("Target.targetDestroyed", onDestroyed);
	let timer: NodeJS.Timeout | undefined;
	try {
		try {
			const result = await connection.send("Target.closeTarget", { targetId });
			if (result.success) {
				timer = setTimeout(() => destroyed.resolve(false), confirmTimeoutMs);
				if (await destroyed.promise) return true;
			}
		} catch {
			// A concurrent reaper or the page itself may already have closed the
			// target. Confirm absence before treating the cleanup as complete.
		}
		try {
			const { targetInfos } = await connection.send("Target.getTargets");
			return !targetInfos.some(info => info.targetId === targetId);
		} catch {
			return false;
		}
	} finally {
		clearTimeout(timer);
		connection.off("Target.targetDestroyed", onDestroyed);
	}
}

/**
 * {@link closeCdpTarget} for the omp relay, over a channel that answers browser-level `Target.*`
 * commands. The relay's `Target.getTargets` lists only tabs it can drive right now, not those of a
 * disconnected browser or with a dismissed debugger, so absence is read from `Target.getTargetInfo`:
 * it looks the id up among every tab the extensions reported, and answers an unknown id with the
 * browser target.
 */
export async function closeRelayTarget(channel: Pick<CDPSession, "send">, targetId: string): Promise<boolean> {
	try {
		const result = await channel.send("Target.closeTarget", { targetId });
		if (result.success) return true;
	} catch {
		// Closed already (the worker's own close), or the extension cannot answer.
	}
	try {
		const { targetInfo } = await channel.send("Target.getTargetInfo", { targetId });
		return targetInfo.targetId !== targetId;
	} catch {
		return false;
	}
}

/** Bounds of {@link closeSharedTargetUntilGone}. */
interface CloseUntilGoneOptions {
	/** Give up (returning false) after this long; default 30 s. */
	budgetMs?: number;
	/** Re-send interval while the target is still listed; default 2 s. */
	intervalMs?: number;
}

/**
 * Confirms a web search page's close like {@link closeCdpTarget} (#16680). Chromium can answer
 * `success: true` and keep the page, so the close is re-sent every `intervalMs` while the target
 * is listed. Returns false once `budgetMs` elapses or the connection drops; never throws.
 */
export async function closeSharedTargetUntilGone(
	browser: Browser,
	targetId: string,
	opts: CloseUntilGoneOptions = {},
): Promise<boolean> {
	const intervalMs = opts.intervalMs ?? RECLOSE_INTERVAL_MS;
	const stop = AbortSignal.timeout(opts.budgetMs ?? RECLOSE_BUDGET_MS);
	let connection: Connection;
	try {
		connection = browserConnection(browser);
	} catch {
		return false;
	}
	const destroyed = Promise.withResolvers<true>();
	const onDestroyed = (event: { targetId: string }): void => {
		if (event.targetId === targetId) destroyed.resolve(true);
	};
	connection.on("Target.targetDestroyed", onDestroyed);
	try {
		// A closed connection rejects every send at once; stop rather than spin to the budget.
		while (!stop.aborted && browser.connected) {
			const round = AbortSignal.any([stop, AbortSignal.timeout(intervalMs)]);
			// Sent outright, not under `round`: a stalled Chromium outlasts rounds, and a skipped send never closes.
			// The reply proves nothing: success can leave the page open; an error may mean it went.
			void connection.send("Target.closeTarget", { targetId }).catch(() => {});
			// Answered after the close, so it also settles a target already gone, or one whose event was missed.
			const unlisted = connection.send("Target.getTargets").then(
				reply => (reply.targetInfos.some(info => info.targetId === targetId) ? destroyed.promise : true),
				() => (browser.connected ? destroyed.promise : false),
			);
			if (await untilAborted(round, Promise.race([destroyed.promise, unlisted])).catch(() => false)) return true;
		}
		return false;
	} finally {
		connection.off("Target.targetDestroyed", onDestroyed);
	}
}

/** Mark a target whose close went unconfirmed for retry while this process lives; the reaper skips live owners. */
export function markSharedTargetUnclosed(scope: SharedTargetScope, targetId: string): void {
	const dir = registryDir(scope);
	let unclosed = unclosedByDir.get(dir);
	if (!unclosed) {
		unclosed = new Set();
		unclosedByDir.set(dir, unclosed);
	}
	unclosed.add(targetId);
}

/**
 * Retry the closes marked for `scope`, forgetting confirmed ones.
 * Returns the count closed; never throws. Concurrent calls for a scope share one run.
 */
export function retryUnclosedSharedTargets(browser: Browser, scope: SharedTargetScope): Promise<number> {
	const dir = registryDir(scope);
	const inFlight = unclosedRetries.get(dir);
	if (inFlight) return inFlight;
	const run = retryUnclosed(browser, scope, dir);
	unclosedRetries.set(dir, run);
	void run.finally(() => {
		if (unclosedRetries.get(dir) === run) unclosedRetries.delete(dir);
	});
	return run;
}

async function retryUnclosed(browser: Browser, scope: SharedTargetScope, dir: string): Promise<number> {
	const pending = unclosedByDir.get(dir);
	if (!pending || pending.size === 0) return 0;
	let closed = 0;
	// Iterate live, not a snapshot: overlapping searches share this run, so ids they mark mid-sweep
	// must be tried too. Set iteration reaches entries added during it and skips forgotten ones.
	for (const targetId of pending) {
		const gone = await closeSharedTargetUntilGone(browser, targetId, { budgetMs: RETRY_CLOSE_BUDGET_MS });
		if (!gone) {
			logger.debug("Shared-browser target still open after retried close", { targetId });
			continue;
		}
		closed++;
		await forgetSharedTarget(scope, targetId);
	}
	if (closed > 0) logger.debug("Closed lingering shared-browser targets", { count: closed, daemon: scope.daemonName });
	return closed;
}

/** Atomically retain unresolved targets, or remove an ownership file once all are resolved. */
async function updateOwnershipFile(owner: OrphanOwner, targetIds: string[]): Promise<void> {
	if (targetIds.length === 0) {
		await fs.rm(owner.file, { force: true });
		return;
	}
	const tmp = `${owner.file}.${process.pid}.tmp`;
	try {
		const record: OwnershipFile = { pid: owner.pid, updatedAt: owner.updatedAt, targets: targetIds };
		await Bun.write(tmp, JSON.stringify(record));
		await fs.rename(tmp, owner.file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Reap shared-browser targets whose owning omp process is gone. Each owner
 * file is removed only after every target is confirmed closed/absent; partial
 * failures atomically retain the unresolved ids for the next attach to retry.
 * Failures are logged, never thrown, so cleanup cannot block browser open.
 */
export async function reapOrphanSharedTargets(browser: Browser, scope: SharedTargetScope): Promise<number> {
	let scan: OrphanScan;
	try {
		scan = await collectOrphanTargets(scope);
	} catch (err) {
		logger.debug("Failed to scan shared-browser target registry", {
			error: err instanceof Error ? err.message : String(err),
		});
		return 0;
	}
	let closed = 0;
	for (const owner of scan.owners) {
		const retained: string[] = [];
		for (const targetId of owner.targetIds) {
			if (await closeCdpTarget(browser, targetId)) {
				closed++;
			} else {
				retained.push(targetId);
				logger.debug("Retaining orphaned shared-browser target for retry", { targetId, ownerPid: owner.pid });
			}
		}
		if (retained.length === owner.targetIds.length) continue;
		try {
			await updateOwnershipFile(owner, retained);
		} catch (err) {
			logger.debug("Failed to update shared-browser ownership after reap", {
				ownerPid: owner.pid,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (closed > 0) logger.debug("Reaped orphaned shared-browser targets", { count: closed, daemon: scope.daemonName });
	return closed;
}

/** Test-only reset of the in-process ownership state. */
export function resetOrphanRegistryForTest(): void {
	ownedByDir.clear();
	unclosedByDir.clear();
	unclosedRetries.clear();
	writeChains.clear();
}
