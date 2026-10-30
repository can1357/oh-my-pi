/**
 * Leases on a materialised isolation sandbox: who is still working in it.
 *
 * The marker under `isolation-ownership` answers who may delete a sandbox. It
 * cannot answer when, because a sandbox is used by more than the run that
 * materialised it: a kept-alive isolated child stays live in its workspace, a
 * nested child spawned from it inherits that cwd without materialising
 * anything, and a session another process opens there is no different.
 * Claiming on open is not the answer — the owner's own child session has that
 * cwd too — so the owner keeps the teardown and accounts for the use instead,
 * and runs it, capture included, once the last user has gone.
 *
 * A lease is a file in the sandbox, so it crosses processes, and it is taken,
 * read and dropped under the *same lock and the same canonical identity as the
 * marker*. A claim nothing else consults under the lock is not a claim:
 * materialisation, retirement and reclamation each decide about a sandbox, and
 * each must see the same leases at the moment it decides.
 *
 * Three further rules, each learned from a way this went wrong:
 *
 * - a grant that could not be recorded is a failure, not a quiet no-op. A
 *   caller told it holds a lease arranges its life around that;
 * - a lease directory that cannot be listed counts as held. A read error is
 *   not evidence that nobody is in there;
 * - the owner's own child session does not pin its own sandbox. It is part of
 *   the run, so its lease carries the owner's agent id and the owner ignores
 *   it; a nested child's does not and is honoured.
 */
import { type FSWatcher, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	isProcessStillLive,
	readIsolationClaim,
	readProcessIdentity,
	resolveSandboxIdentity,
	SANDBOX_LOCK_WAIT,
	writeProcessIdentity,
} from "./isolation-ownership";

/** Directory of lease files inside a sandbox's base dir. */
export const ISOLATION_LEASE_DIR = ".omp-isolation-leases";

/** How often a deferred teardown re-asks whether the last user has gone. */
const LEASE_POLL_MS = 250;

interface LeasedWorkspace {
	/** Canonical base directory of the sandbox. */
	baseDir: string;
	/** The materialisation this record belongs to; a later one owns its own teardown. */
	generation: string;
	/** Agent id of the run that owns the sandbox: its own session's lease does not pin it. */
	agentId?: string;
	/** Teardown its owner asked for while the sandbox was still in use. */
	pendingTeardown?: () => Promise<void>;
	/** Poll watching for the last user to leave, including one in another process. */
	poll?: NodeJS.Timeout;
	/** Watch on the lease directory, so a departure is acted on as it happens. */
	watcher?: FSWatcher;
}

/** Sandboxes materialised by this process, by merged directory. */
const workspaces = new Map<string, LeasedWorkspace>();

/** Start accounting for a sandbox this process has just materialised. */
export function registerIsolationWorkspace(
	mergedDir: string,
	details: { baseDir: string; generation: string; agentId?: string },
): void {
	const existing = workspaces.get(mergedDir);
	if (existing && existing.generation === details.generation) return;
	// A new materialisation of the same path supersedes the old record, and the
	// old one's teardown no longer speaks for this directory.
	clearInterval(existing?.poll);
	existing?.watcher?.close();
	workspaces.set(mergedDir, { ...details });
}

/**
 * Stop accounting for a sandbox whose teardown has run. Keyed by generation:
 * an older teardown finishing must not drop the record — and with it the
 * pending teardown — of the materialisation that replaced it.
 */
export function forgetIsolationWorkspace(mergedDir: string, generation?: string): void {
	const existing = workspaces.get(mergedDir);
	if (!existing) return;
	if (generation !== undefined && existing.generation !== generation) return;
	clearInterval(existing.poll);
	existing.watcher?.close();
	workspaces.delete(mergedDir);
}

/** Mount directory names a sandbox's merged view uses (`merged` is the legacy name). */
const ISOLATION_MOUNT_DIRS = ["m", "merged"];

/**
 * The base directory of the sandbox `cwd` sits in, found on disk: a session
 * another process opens in a sandbox has no local knowledge of it, and is
 * exactly the user a lease must cover. `cwd` is canonicalised first, so a
 * symlinked path reaches the same sandbox as the path it points at.
 *
 * A directory named `m` is not a sandbox on its own: the marker beside it must
 * name a current claim, or anything with an `m` in it would hand out leases
 * nobody honours.
 */
async function findSandboxBase(cwd: string): Promise<string | undefined> {
	let dir = await resolveSandboxIdentity(cwd);
	for (let depth = 0; depth < 64; depth += 1) {
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		if (ISOLATION_MOUNT_DIRS.includes(path.basename(dir))) {
			const claim = await readIsolationClaim(parent);
			if (claim.kind === "claimed") return parent;
		}
		dir = parent;
	}
	return undefined;
}

/** Whether a lease file belongs to the run that owns the sandbox. */
async function isOwnersOwnLease(file: string, ownerAgentId: string | undefined): Promise<boolean> {
	if (ownerAgentId === undefined) return false;
	const decoded: unknown = await Bun.file(file)
		.json()
		.catch(() => undefined);
	if (typeof decoded !== "object" || decoded === null || !("agentId" in decoded)) return false;
	return decoded.agentId === ownerAgentId;
}

/**
 * Whether any live process holds a lease on the sandbox at `baseDir`.
 *
 * A lease whose holder is gone is removed on the way past: a crashed user must
 * not pin a workspace for ever, exactly as a crashed owner does not. A lease —
 * or a lease directory — that cannot be read counts as held: deletion needs
 * proof, and an I/O error is not proof that nobody is in there.
 */
export async function hasLiveIsolationLease(baseDir: string, ownerAgentId?: string): Promise<boolean> {
	const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(leaseDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		logger.warn("isolation lease directory could not be listed; treating the sandbox as in use", {
			baseDir,
			error: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
	let live = false;
	for (const entry of entries) {
		const file = path.join(leaseDir, entry);
		const holder = await readProcessIdentity(file);
		if (holder === "unreadable") {
			live = true;
			continue;
		}
		if (holder && (await isProcessStillLive(holder))) {
			// The owner's own child session is part of the run, not a later user
			// of its workspace: it must not stop its own run's capture.
			if (await isOwnersOwnLease(file, ownerAgentId)) continue;
			live = true;
			continue;
		}
		if (holder === undefined) continue;
		await fs.rm(file, { force: true }).catch(() => undefined);
	}
	return live;
}

/**
 * Hold the sandbox `cwd` sits in, if any, and return the release.
 *
 * Taken under the sandbox lock, after re-reading the claim, so a teardown that
 * is deciding cannot miss it and a sandbox already being retired cannot hand
 * one out. Throws if the lease cannot be recorded: a caller told it holds one
 * arranges its life around that, and a silent no-op is how a live child's
 * workspace gets deleted under it. Returns a no-op release only when `cwd` is
 * in no sandbox at all.
 */
export async function leaseIsolationWorkspace(
	cwd: string,
	options: { agentId?: string } = {},
): Promise<() => Promise<void>> {
	const sandbox = await findSandboxBase(cwd);
	if (sandbox === undefined) return async () => {};
	const leaseFile = path.join(sandbox, ISOLATION_LEASE_DIR, `${process.pid}-${Snowflake.next()}.json`);
	const lock = await acquireFileLock(sandbox, SANDBOX_LOCK_WAIT);
	try {
		const claim = await readIsolationClaim(sandbox);
		if (claim.kind !== "claimed") {
			throw new Error(`Isolation workspace ${sandbox} is being torn down and cannot be leased.`);
		}
		await writeProcessIdentity(leaseFile, options.agentId === undefined ? {} : { agentId: options.agentId });
	} finally {
		lock.release();
	}
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await dropLease(sandbox, leaseFile);
	};
}

/** Remove a lease under the lock, then run the owner's deferred teardown if it was the last one. */
async function dropLease(sandbox: string, leaseFile: string): Promise<void> {
	const lock = await acquireFileLock(sandbox, SANDBOX_LOCK_WAIT);
	try {
		await fs.rm(leaseFile, { force: true }).catch(() => undefined);
	} finally {
		lock.release();
	}
	await runPendingTeardownIfIdle(sandbox);
}

/** Watch a sandbox's lease directory, so a lease going away is acted on at once. */
function watchLeaseDirectory(baseDir: string): FSWatcher | undefined {
	try {
		const watcher = watch(path.join(baseDir, ISOLATION_LEASE_DIR), () => {
			void runPendingTeardownIfIdle(baseDir);
		});
		watcher.unref?.();
		return watcher;
	} catch {
		// No watch available (the directory may not exist yet): the poll carries it.
		return undefined;
	}
}

/** Run the deferred teardown of any sandbox of this process at `baseDir` whose last user has gone. */
async function runPendingTeardownIfIdle(baseDir: string): Promise<void> {
	for (const [mergedDir, workspace] of workspaces) {
		if (workspace.baseDir !== baseDir) continue;
		if (workspace.pendingTeardown === undefined) continue;
		if (await hasLiveIsolationLease(baseDir, workspace.agentId)) continue;
		// Read and cleared with nothing awaited in between: the watch and the
		// poll can both arrive while the other is still deciding, and a teardown
		// that runs twice captures and deletes twice.
		const pending = workspace.pendingTeardown;
		workspace.pendingTeardown = undefined;
		if (pending === undefined) continue;
		if (workspace.poll) {
			clearInterval(workspace.poll);
			workspace.poll = undefined;
		}
		workspace.watcher?.close();
		workspace.watcher = undefined;
		await pending().catch(error => {
			logger.warn("deferred isolation teardown failed", { mergedDir, error: String(error) });
		});
	}
}

/**
 * Record `teardown` against a sandbox someone is still working in, and report
 * whether it was deferred.
 *
 * The caller holds the sandbox lock, so the answer and the record are taken
 * together: a lease that arrives afterwards waits for the same lock and is
 * seen by the teardown this defers to. The last user to leave runs it — and
 * because that user may be in another process, whose departure this process
 * never hears about, the wait is also polled. A sandbox nobody holds returns
 * false and its owner proceeds immediately.
 */
export async function deferTeardownWhileLeased(
	mergedDir: string,
	teardown: () => Promise<void>,
	options: { generation?: string } = {},
): Promise<boolean> {
	const workspace = workspaces.get(mergedDir);
	if (workspace && options.generation !== undefined && workspace.generation !== options.generation) {
		// An older materialisation asking about a directory a newer one owns.
		return false;
	}
	const baseDir = workspace?.baseDir ?? (await resolveSandboxIdentity(path.dirname(mergedDir)));
	if (!(await hasLiveIsolationLease(baseDir, workspace?.agentId))) return false;
	if (!workspace) {
		// Not this process's sandbox: nothing here will run the teardown later,
		// so the caller must decide. Reporting the use is still right.
		return true;
	}
	workspace.pendingTeardown = teardown;
	// Watched so a departure is acted on as it happens, and polled as well
	// because a holder killed outright leaves its lease file behind: only its
	// liveness, re-asked, tells that apart from a live one.
	workspace.watcher ??= watchLeaseDirectory(baseDir);
	workspace.poll ??= setInterval(() => {
		void runPendingTeardownIfIdle(baseDir);
	}, LEASE_POLL_MS);
	workspace.poll.unref?.();
	return true;
}
