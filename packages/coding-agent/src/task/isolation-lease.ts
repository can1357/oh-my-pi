/**
 * Leases on a materialised isolation sandbox: who is still working in it.
 *
 * The marker under `isolation-ownership` answers who may delete a sandbox. It
 * cannot answer when, because a sandbox is used by more than the run that
 * materialised it: a kept-alive isolated child stays live in its workspace, a
 * nested child spawned from it inherits that cwd without materialising
 * anything, and a session another process opens there is no different. Claiming
 * on open is not the answer — the owner's own child session has that cwd too,
 * so an opening claim would stop the run that built the sandbox from ever
 * cleaning it up. Accounting for the use is: the owner keeps the teardown, and
 * runs it — capture included — once the last user has gone.
 *
 * A lease is a file in the sandbox, not an entry in a map, because the user
 * need not share a process with the owner. Each names the process holding it,
 * so a crashed holder's lease is as dead as a crashed owner's claim, and the
 * same liveness rule retires both.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	ISOLATION_OWNER_FILE,
	isProcessStillLive,
	readProcessIdentity,
	writeProcessIdentity,
} from "./isolation-ownership";

/** Directory of lease files inside a sandbox's base dir. */
export const ISOLATION_LEASE_DIR = ".omp-isolation-leases";

interface LeasedWorkspace {
	/** Teardown its owner asked for while the sandbox was still in use. */
	pendingTeardown?: () => Promise<void>;
}

/** Sandboxes materialised by this process, by merged directory. */
const workspaces = new Map<string, LeasedWorkspace>();

/** Start accounting for `mergedDir`; called where the sandbox is materialised. */
export function registerIsolationWorkspace(mergedDir: string): void {
	if (!workspaces.has(mergedDir)) workspaces.set(mergedDir, {});
}

/** Stop accounting for a sandbox whose teardown has run. */
export function forgetIsolationWorkspace(mergedDir: string): void {
	workspaces.delete(mergedDir);
}

/** Whether `cwd` is inside `mergedDir` (or is it). */
function isInside(cwd: string, mergedDir: string): boolean {
	return cwd === mergedDir || cwd.startsWith(mergedDir + path.sep);
}

/** Mount directory names a sandbox's merged view uses (`merged` is the legacy name). */
const ISOLATION_MOUNT_DIRS = ["m", "merged"];

/** The merged directory of a sandbox this process materialised that contains `cwd`. */
function owningWorkspace(cwd: string): string | undefined {
	const resolved = path.resolve(cwd);
	for (const mergedDir of workspaces.keys()) {
		if (isInside(resolved, mergedDir)) return mergedDir;
	}
	return undefined;
}

/**
 * The base directory of the sandbox `cwd` sits in, found on disk rather than
 * in this process's records: a session another process opens in a sandbox has
 * no local knowledge of it, and is exactly the user a lease must cover.
 */
async function findSandboxBase(cwd: string): Promise<string | undefined> {
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < 64; depth += 1) {
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		if (ISOLATION_MOUNT_DIRS.includes(path.basename(dir))) {
			if (await Bun.file(path.join(parent, ISOLATION_OWNER_FILE)).exists()) return parent;
		}
		dir = parent;
	}
	return undefined;
}

/**
 * Whether any live process holds a lease on the sandbox at `baseDir`.
 *
 * A lease whose holder is gone is removed on the way past: a crashed user must
 * not pin a workspace for ever, exactly as a crashed owner does not.
 */
export async function hasLiveIsolationLease(baseDir: string): Promise<boolean> {
	const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
	const entries = await fs.readdir(leaseDir).catch(() => [] as string[]);
	let live = false;
	for (const entry of entries) {
		const file = path.join(leaseDir, entry);
		const holder = await readProcessIdentity(file);
		if (holder === "unreadable") {
			// A lease we cannot read is not proof that nobody holds it.
			live = true;
			continue;
		}
		if (holder && (await isProcessStillLive(holder))) {
			live = true;
			continue;
		}
		await fs.rm(file, { force: true }).catch(() => undefined);
	}
	return live;
}

/**
 * Hold the sandbox `cwd` sits in, if any, and return the release. A caller that
 * will keep working in a directory it did not materialise — a nested child
 * spawned from an isolated parent, a session another process opens there —
 * holds one for as long as that is true. Returns a no-op when `cwd` is in no
 * sandbox.
 */
export async function leaseIsolationWorkspace(cwd: string): Promise<() => Promise<void>> {
	const mergedDir = owningWorkspace(cwd);
	const sandbox = mergedDir === undefined ? await findSandboxBase(cwd) : path.dirname(mergedDir);
	if (sandbox === undefined) return async () => {};
	const leaseFile = path.join(sandbox, ISOLATION_LEASE_DIR, `${process.pid}-${Snowflake.next()}.json`);
	try {
		await writeProcessIdentity(leaseFile);
	} catch (error) {
		logger.debug("isolation lease could not be recorded", { sandbox, error: String(error) });
		return async () => {};
	}
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await fs.rm(leaseFile, { force: true }).catch(() => undefined);
		if (mergedDir === undefined) return;
		const workspace = workspaces.get(mergedDir);
		const pending = workspace?.pendingTeardown;
		if (!workspace || !pending) return;
		if (await hasLiveIsolationLease(sandbox)) return;
		// The owner asked to tear the sandbox down while this lease held it.
		workspace.pendingTeardown = undefined;
		await pending().catch(error => {
			logger.warn("deferred isolation teardown failed", { mergedDir, error: String(error) });
		});
	};
}

/**
 * Record `teardown` against a sandbox someone is still working in, and report
 * whether it was deferred. The last lease to end runs it; a sandbox nobody
 * holds returns false and its owner proceeds immediately.
 */
export async function deferTeardownWhileLeased(mergedDir: string, teardown: () => Promise<void>): Promise<boolean> {
	if (!(await hasLiveIsolationLease(path.dirname(mergedDir)))) return false;
	const workspace = workspaces.get(mergedDir);
	if (!workspace) {
		// Not this process's sandbox: nothing here can run the teardown later, so
		// the caller must decide. Reporting the use is still right.
		return true;
	}
	workspace.pendingTeardown = teardown;
	return true;
}
