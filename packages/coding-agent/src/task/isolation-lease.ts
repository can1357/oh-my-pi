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
	type ProcessIdentity,
	readIsolationClaim,
	readProcessIdentity,
	resolveSandboxIdentity,
	SANDBOX_LOCK_WAIT,
	writeProcessIdentity,
} from "./isolation-ownership";

/**
 * Marker a departing user leaves when it had to give up its lease while its
 * own work might still be running — a session whose shutdown handlers outran
 * the grace. Dropping the lease is how a stalled disposal stops holding a
 * kernel for ever; deleting the workspace underneath a handler that is still
 * writing is not, so the owner keeps the directory instead of removing it and
 * reclamation takes it once both processes are gone.
 */
export const ISOLATION_UNFINISHED_FILE = ".omp-isolation-unfinished.json";

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
	/** Serialises departure handling, so every party that notices awaits the same work. */
	gate?: Promise<void>;
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

/** What a cwd walk found above it. */
type FoundSandbox = { kind: "sandbox" | "retiring"; baseDir: string };

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
async function findSandboxBase(cwd: string): Promise<FoundSandbox | undefined> {
	let dir = await resolveSandboxIdentity(cwd);
	for (let depth = 0; depth < 64; depth += 1) {
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		if (ISOLATION_MOUNT_DIRS.includes(path.basename(dir))) {
			const claim = await readIsolationClaim(parent);
			if (claim.kind === "claimed") return { kind: "sandbox", baseDir: parent };
			// A sandbox whose teardown is still running is not a sandbox a new
			// user may join, and it is not "no sandbox" either.
			if (claim.kind === "retiring") return { kind: "retiring", baseDir: parent };
		}
		dir = parent;
	}
	return undefined;
}

/**
 * Whether a lease is the owning run's own session: *this* process, under the
 * owner's agent id. The agent id alone is not identity — another process can
 * carry the same one, and treating its lease as the owner's own deletes its
 * live data — so the holder has to be this process too.
 */
function isOwnersOwnLease(holder: ProcessIdentity, agentId: unknown, ownerAgentId: string | undefined): boolean {
	if (ownerAgentId === undefined || agentId !== ownerAgentId) return false;
	return holder.pid === process.pid;
}

/** The agent id recorded in a lease file, if any. */
async function readLeaseAgentId(file: string): Promise<unknown> {
	const decoded: unknown = await Bun.file(file)
		.json()
		.catch(() => undefined);
	if (typeof decoded !== "object" || decoded === null || !("agentId" in decoded)) return undefined;
	return decoded.agentId;
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
			if (isOwnersOwnLease(holder, await readLeaseAgentId(file), ownerAgentId)) continue;
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
 * is deciding cannot miss it. Throws if the lease cannot be recorded, and
 * throws if the sandbox is already being torn down: a no-op release handed
 * back for a retiring sandbox is a promise of protection nothing is keeping.
 * Returns a no-op release only when `cwd` is in no sandbox at all.
 *
 * Awaiting the release is a completion barrier *for a holder in the owner's
 * process*: when it resolves, this lease is gone from disk and any teardown
 * its departure started — the owner's capture and removal, whoever noticed it
 * first — has finished. A holder in another process can only report that its
 * own lease is gone: the owner's teardown runs in the owner, which this one
 * cannot await, and claiming otherwise would be the same false promise as the
 * no-op grant. {@link isLocalIsolationOwner} tells the two apart.
 */
export async function leaseIsolationWorkspace(
	cwd: string,
	options: { agentId?: string } = {},
): Promise<() => Promise<void>> {
	const found = await findSandboxBase(cwd);
	if (found === undefined) return async () => {};
	if (found.kind === "retiring") {
		throw new Error(`Isolation workspace ${found.baseDir} is being torn down and cannot be leased.`);
	}
	const sandbox = found.baseDir;
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
		if (!released) {
			await dropLease(sandbox, leaseFile);
			// Marked released only once the file is gone, so a caller that saw a
			// transient failure can retry this same release rather than being
			// told the lease is dropped while it is still on disk.
			released = true;
		}
		await runPendingTeardownIfIdle(sandbox);
	};
}

/** Record that a user of the sandbox `cwd` sits in may still be writing to it. */
export async function markUnfinishedWriter(cwd: string): Promise<void> {
	const found = await findSandboxBase(cwd);
	if (found === undefined) return;
	await writeProcessIdentity(path.join(found.baseDir, ISOLATION_UNFINISHED_FILE));
}

/** Whether a live process said it might still be writing into the sandbox at `baseDir`. */
export async function hasUnfinishedWriter(baseDir: string): Promise<boolean> {
	const holder = await readProcessIdentity(path.join(baseDir, ISOLATION_UNFINISHED_FILE));
	if (holder === undefined) return false;
	if (holder === "unreadable") return true;
	return await isProcessStillLive(holder);
}

/** Whether the sandbox at `baseDir` was materialised by this process, so its teardown runs here. */
export function isLocalIsolationOwner(baseDir: string): boolean {
	for (const workspace of workspaces.values()) {
		if (workspace.baseDir === baseDir) return true;
	}
	return false;
}

/** Remove a lease under the lock. Raises when the file is still there, so the caller can retry. */
async function dropLease(sandbox: string, leaseFile: string): Promise<void> {
	const lock = await acquireFileLock(sandbox, SANDBOX_LOCK_WAIT);
	try {
		await fs.rm(leaseFile, { force: true });
	} finally {
		lock.release();
	}
}

/** Watch a sandbox's lease directory, so a lease going away is acted on at once. */
function watchLeaseDirectory(baseDir: string): FSWatcher | undefined {
	try {
		// Deliberately referenced: while a teardown is owed, this process has
		// work left to do, and exiting with a foreign lease outstanding leaves
		// the sandbox and the work written in it behind.
		return watch(path.join(baseDir, ISOLATION_LEASE_DIR), () => {
			void runPendingTeardownIfIdle(baseDir);
		});
	} catch {
		// No watch available (the directory may not exist yet): the poll carries it.
		return undefined;
	}
}

/**
 * Run the deferred teardown of any sandbox of this process at `baseDir` whose
 * last user has gone, and wait for it.
 *
 * Serialised per sandbox: two parties noticing the same departure — the watch
 * and a release, the poll and a release — would otherwise both pass an
 * "is one running?" test before either had read the leases, and the second
 * would return while the first was still capturing. Chaining them means every
 * caller awaits the work, not merely its start.
 */
async function runPendingTeardownIfIdle(baseDir: string): Promise<void> {
	for (const [mergedDir, workspace] of workspaces) {
		if (workspace.baseDir !== baseDir) continue;
		const previous = workspace.gate ?? Promise.resolve();
		const gated = previous.then(async () => await settleIfIdle(mergedDir, workspace, baseDir));
		workspace.gate = gated.catch(() => undefined);
		await gated;
	}
}

/** One serialised attempt: if nobody holds the sandbox, run what its owner left to do. */
async function settleIfIdle(mergedDir: string, workspace: LeasedWorkspace, baseDir: string): Promise<void> {
	if (workspace.pendingTeardown === undefined) return;
	if (await hasLiveIsolationLease(baseDir, workspace.agentId)) return;
	const pending = workspace.pendingTeardown;
	workspace.pendingTeardown = undefined;
	disarmTeardownWatch(workspace);
	await pending().catch(error => {
		logger.warn("deferred isolation teardown failed", { mergedDir, error: String(error) });
	});
}

/** Stop watching and polling a sandbox whose teardown is no longer owed. */
function disarmTeardownWatch(workspace: LeasedWorkspace): void {
	clearInterval(workspace.poll);
	workspace.poll = undefined;
	workspace.watcher?.close();
	workspace.watcher = undefined;
}

/**
 * Record what this sandbox's owner still owes — capture and removal — *before*
 * asking whether anybody is using it.
 *
 * The order is the point. A check that finds no users and registers nothing
 * leaves a user admitted a moment later with no teardown to run on its way
 * out: it is protected from deletion and its work is never captured, which
 * loses it just as surely. Registering first means every admission window is
 * covered by something that captures; the caller takes the registration back
 * only once it has established, under the sandbox lock, that it may do the
 * work itself.
 *
 * The caller holds that lock, so the record and the answer are taken together:
 * a lease arriving afterwards waits for it and is then seen by whoever departs
 * last. Because that party may be in another process, whose departure this one
 * never hears about, the wait is watched and polled too.
 *
 * Returns true when somebody is using the sandbox and the teardown stays
 * registered for them; false when the caller may run it now.
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
	if (!workspace) {
		// Not this process's sandbox: nothing here will run the teardown later,
		// so the caller must decide. Reporting the use is still right.
		return await hasLiveIsolationLease(baseDir);
	}
	// Never downgraded: the owner registers capture-and-cleanup first and its
	// plain cleanup follows, and replacing the first with the second is how a
	// late user's work ends up deleted without ever being captured.
	workspace.pendingTeardown ??= teardown;
	workspace.watcher ??= watchLeaseDirectory(baseDir);
	// Deliberately referenced: a teardown is owed, so this process has work
	// left; exiting now leaves the sandbox and the work written in it behind.
	workspace.poll ??= setInterval(() => {
		void runPendingTeardownIfIdle(baseDir);
	}, LEASE_POLL_MS);
	if (await hasLiveIsolationLease(baseDir, workspace.agentId)) return true;
	// Nobody is here after all, and the caller is about to do the work itself.
	workspace.pendingTeardown = undefined;
	disarmTeardownWatch(workspace);
	return false;
}
