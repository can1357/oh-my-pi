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
import { type FSWatcher, watch } from "./isolation-fs";
import * as fs from "./isolation-fs";
import * as path from "node:path";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	withSandboxLock,
	isProcessStillLive,
	type ProcessIdentity,
	readIsolationClaim,
	readProcessIdentity,
	resolveSandboxIdentity,
	writeProcessIdentity,
} from "./isolation-ownership";

/**
 * Directory of unfinished-writer records: one file per writer that gave up its
 * lease while its own work might still be running — a session whose shutdown
 * handlers outran the grace.
 *
 * One file per writer, not one marker: two of them overwrote each other, and a
 * single record naming the one that had already exited let a destructive path
 * delete the other's live data. Each names its process, so a crashed writer's
 * record retires like a crashed holder's lease, and each is cleared by its own
 * writer when it finishes — a record nobody ever clears is a workspace nobody
 * ever reclaims.
 */
/**
 * Where a party announces that it is *about to* take a stake, before it
 * queues for the sandbox lock.
 *
 * A writer blocked on the lock is invisible to the holder's listing, so an
 * owner saw "only my own records", stopped waiting, and exited while a real
 * foreign write was queued one position behind it. An intent is written
 * without the lock, so it is already on disk when the holder looks.
 */
export const ISOLATION_INTENT_DIR = ".omp-isolation-intent";

export const ISOLATION_UNFINISHED_DIR = ".omp-isolation-unfinished";

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
type FoundSandbox =
	| { kind: "sandbox"; baseDir: string; generation: string }
	| { kind: "retiring"; baseDir: string }
	| { kind: "unknown"; baseDir: string; reason: string };

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
			if (claim.kind === "claimed") {
				return { kind: "sandbox", baseDir: parent, generation: claim.generation };
			}
			// A sandbox whose teardown is still running is not a sandbox a new
			// user may join, and it is not "no sandbox" either.
			if (claim.kind === "retiring") return { kind: "retiring", baseDir: parent };
			// A marker that is here and cannot be read is unknown, not absent.
			// Walking past it returns "no sandbox", and the caller then gets a
			// successful no-op where it asked for protection.
			if (claim.kind === "unknown") return { kind: "unknown", baseDir: parent, reason: claim.reason };
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
	// An id nobody can read is simply not an id: this only decides whether a
	// lease is the owner's own, and the unreadable case is already counted as
	// a live foreign holder by `readHolders`, which is the strict answer.
	const found = await fs.readJsonLookup(file);
	if (found.kind !== "found") return undefined;
	const decoded = found.value;
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
	const listing = await fs.readdirLookup(leaseDir);
	if (listing.kind === "absent") return false;
	if (listing.kind === "unknown") {
		logger.warn("isolation lease directory could not be listed; treating the sandbox as in use", {
			baseDir,
			error: listing.reason,
		});
		return true;
	}
	const entries = listing.value;
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
	if (found.kind === "unknown") {
		throw new Error(
			`Isolation workspace ${found.baseDir} has an unreadable owner marker (${found.reason}); refusing to ` +
				"hand out a lease nothing would honour.",
		);
	}
	const sandbox = found.baseDir;
	const leaseFile = path.join(sandbox, ISOLATION_LEASE_DIR, `${process.pid}-${Snowflake.next()}.json`);
	// Announced before queueing for the lock, so the current holder's listing
	// already shows this party.
	const intent = await announceIntent(sandbox);
	try {
		// Through the one entry point every acquisition uses, so a caller that
		// already holds this lock is served rather than queued behind itself.
		await withSandboxLock(sandbox, "lease", async () => {
			const claim = await readIsolationClaim(sandbox);
			if (claim.kind !== "claimed") {
				throw new Error(`Isolation workspace ${sandbox} is being torn down and cannot be leased.`);
			}
			// The same path is not the same workspace: a lease written under a
			// successor protects a run this caller never joined, and leaves the
			// caller believing it holds the one it queued for.
			if (claim.generation !== found.generation) {
				throw new Error(
					`Isolation workspace ${sandbox} is now generation ${claim.generation}, not ${found.generation}; ` +
						"cannot lease a workspace that has been replaced.",
				);
			}
			await writeProcessIdentity(leaseFile, options.agentId === undefined ? {} : { agentId: options.agentId });
		});
	} finally {
		await intent();
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

/**
 * Record that this process may still be writing into the sandbox `cwd` sits
 * in, and return the clear for when it has finished.
 *
 * Raises when the record cannot be written. A caller that could not say "I may
 * still be writing" has not been told it is safe to stop holding its lease,
 * and treating a failed write as a logged inconvenience is how a shutdown
 * handler loses the file it was saving.
 */
export async function markUnfinishedWriter(cwd: string): Promise<() => Promise<void>> {
	const found = await findSandboxBase(cwd);
	if (found === undefined) return async () => {};
	if (found.kind === "unknown") {
		// Refuses rather than returning a no-op the caller would cache as a
		// successful publication: an unreadable marker is not "no sandbox".
		throw new Error(
			`Isolation workspace ${found.baseDir} has an unreadable owner marker (${found.reason}); cannot record a writer.`,
		);
	}
	const record = path.join(found.baseDir, ISOLATION_UNFINISHED_DIR, `${process.pid}-${Snowflake.next()}.json`);
	// The generation this caller believes it is writing into, read before the
	// wait. A successor claimed at the same path is a different workspace.
	const intended = found.kind === "sandbox" ? found.generation : undefined;
	// Announced before queueing for the lock: an owner that lists while this
	// call is waiting must see that somebody is on the way in.
	const intent = await announceIntent(found.baseDir);
	try {
		// Under the sandbox lock, like lease admission: a retention that has
		// decided nobody is here must not then rename the directory out from
		// under a record published a moment later.
		await withSandboxLock(found.baseDir, "record a writer in", async () => {
			// A fact established before a lock is not a fact after it: the
			// sandbox found above may have been retired, renamed or reclaimed
			// while this call waited.
			const claim = await readIsolationClaim(found.baseDir);
			if (claim.kind !== "claimed") {
				throw new Error(
					`Isolation workspace ${found.baseDir} is no longer claimable (${claim.kind}); cannot record a writer.`,
				);
			}
			// And the same path is not the same workspace: a record published
			// into a successor's generation says a stranger's run is writing
			// here, and keeps that run's workspace for work that is not in it.
			if (intended !== undefined && claim.generation !== intended) {
				throw new Error(
					`Isolation workspace ${found.baseDir} is now generation ${claim.generation}, not ${intended}; ` +
						"cannot record a writer against a workspace that has been replaced.",
				);
			}
			await writeProcessIdentity(record);
		});
	} finally {
		await intent();
	}
	return async () => {
		await fs.rm(record, { force: true });
		// Our own record going away is the event the owner was waiting for.
		// Unreferencing on "only my own record is here" and then exiting when
		// it cleared is how a queued foreign write lost its capture: the
		// teardown had nothing left to run it. Settling here runs it while
		// this process is still alive, under the lock, where a foreign record
		// or announced intent is visible.
		await runPendingTeardownIfIdle(found.baseDir);
	};
}

/**
 * Record that this process is about to claim a stake in `baseDir`, and return
 * the clear for when it has finished trying.
 *
 * Best-effort by design: a sandbox that cannot take the note is one whose
 * lock attempt will fail anyway, and refusing here would turn a readable
 * failure into an unreadable one.
 */
async function announceIntent(baseDir: string): Promise<() => Promise<void>> {
	const file = path.join(baseDir, ISOLATION_INTENT_DIR, `${process.pid}-${Snowflake.next()}.json`);
	// Raises rather than returning a clear for a note that was never written.
	// A caller told it announced itself waits for a lock believing the holder
	// can see it, and on a full disk the holder saw nothing at all.
	try {
		await writeProcessIdentity(file);
	} catch (error) {
		throw new Error(
			`Could not announce a stake in isolation workspace ${baseDir} (${fs.reasonOf(error)}); ` +
				"refusing to queue for its lock unseen.",
		);
	}
	return async () => {
		await fs.rm(file, { force: true }).catch(() => undefined);
	};
}

/**
 * Whether a live process said it might still be writing into the sandbox at
 * `baseDir`. Records of processes that have since gone are cleared on the way
 * past; a record that cannot be read counts as live, as everywhere else here.
 */
export async function hasUnfinishedWriter(baseDir: string): Promise<boolean> {
	// Both directories: a party queued for the lock has announced its intent
	// and is as much a user of this workspace as one whose record has landed.
	for (const dir of [ISOLATION_UNFINISHED_DIR, ISOLATION_INTENT_DIR]) {
		if (await hasLiveRecordIn(path.join(baseDir, dir))) return true;
	}
	return false;
}

/** Whether a live process has a record in `dir`, clearing dead ones on the way past. */
async function hasLiveRecordIn(dir: string): Promise<boolean> {
	const listing = await fs.readdirLookup(dir);
	if (listing.kind === "absent") return false;
	// A directory that cannot be listed is not an empty one, and the caller is
	// about to delete or rename what is in it.
	if (listing.kind === "unknown") return true;
	let live = false;
	for (const entry of listing.value) {
		const file = path.join(dir, entry);
		const holder = await readProcessIdentity(file);
		if (holder === "unreadable") {
			live = true;
			continue;
		}
		if (holder === undefined) continue;
		if (await isProcessStillLive(holder)) {
			live = true;
			continue;
		}
		await fs.rm(file, { force: true }).catch(() => undefined);
	}
	return live;
}

/** One reading of a record or lease directory: what is live, and whether it is all ours. */
interface HolderReading {
	/** A live holder is present. */
	anyLive: boolean;
	/** Every live holder is this process. Meaningless unless {@link anyLive}. */
	allOurs: boolean;
	/** The directory could not be read, so neither answer is known. */
	unknown: boolean;
}

/**
 * Read one directory of holder records once.
 *
 * Once, deliberately: asking "is anybody here?" and then "are they all ours?"
 * as two listings turns a departure between them into "all ours", and the
 * owner then exits without the final capture. One listing cannot see a
 * transition as a state.
 */
async function readHolders(dir: string): Promise<HolderReading> {
	const listing = await fs.readdirLookup(dir);
	if (listing.kind === "absent") return { anyLive: false, allOurs: true, unknown: false };
	if (listing.kind === "unknown") return { anyLive: true, allOurs: false, unknown: true };
	const entries = listing.value;
	let anyLive = false;
	let allOurs = true;
	for (const entry of entries) {
		const holder = await readProcessIdentity(path.join(dir, entry));
		if (holder === undefined) continue;
		if (holder === "unreadable") {
			anyLive = true;
			allOurs = false;
			continue;
		}
		if (!(await isProcessStillLive(holder))) continue;
		anyLive = true;
		if (holder.pid !== process.pid) allOurs = false;
	}
	return { anyLive, allOurs, unknown: false };
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
	await withSandboxLock(sandbox, "drop a lease in", async () => {
		await fs.rm(leaseFile, { force: true });
	});
}

/** Watch a sandbox's lease directory, so a lease going away is acted on at once. */
function watchLeaseDirectory(baseDir: string): FSWatcher | undefined {
	try {
		// Deliberately referenced: while a teardown is owed, this process has
		// work left to do, and exiting with a foreign lease outstanding leaves
		// the sandbox and the work written in it behind.
		// Both directories: a departure is a lease going away or a writer
		// clearing its record, and the last of either is what releases the
		// owner's capture.
		const onChange = (): void => void runPendingTeardownIfIdle(baseDir);
		const leases = watch(path.join(baseDir, ISOLATION_LEASE_DIR), onChange);
		let writers: FSWatcher | undefined;
		try {
			writers = watch(path.join(baseDir, ISOLATION_UNFINISHED_DIR), onChange);
		} catch {
			writers = undefined;
		}
		// `unref` forwarded, not dropped: a wrapper with only `close` made every
		// later `unref` a silent no-op, and the process stayed alive on a watch
		// nobody could release.
		return {
			close: () => {
				leases.close();
				writers?.close();
			},
			unref: () => {
				leases.unref?.();
				writers?.unref?.();
				return undefined as unknown as FSWatcher;
			},
			ref: () => {
				leases.ref?.();
				writers?.ref?.();
				return undefined as unknown as FSWatcher;
			},
		} as unknown as FSWatcher;
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
	// Taking the registration is done under the sandbox lock, so a watch or a
	// poll cannot start the teardown beside a caller that is deciding the same
	// thing under that lock; the teardown itself takes the lock again, so it is
	// released before running it. One entry point, so this decision and anything it calls — publication,
	// a writer listing — share the hold instead of queueing behind it. Taking
	// the lock raw here and re-entering through the wrapper deadlocked against
	// this very call.
	const pending = await withSandboxLock(baseDir, "settle", async (): Promise<(() => Promise<void>) | undefined> => {
		if (workspace.pendingTeardown === undefined) return undefined;
		// The owner's own session counts as much as anyone else's. Excluding it
		// let a teardown delete the workspace its own child was still writing
		// in; the run's result no longer depends on that exclusion, because the
		// capture at release has already happened by the time this runs.
		const leases = await readHolders(path.join(baseDir, ISOLATION_LEASE_DIR));
		if (leases.anyLive) {
			// Somebody else arrived after a writer record let this process
			// unreference its wait: the work is this process's to do, so the
			// references come back. A lease that is only *ours* is different —
			// waiting for ourselves is not a reason to keep the process alive,
			// and a retained self-lease kept a finished program from exiting.
			// Re-read the writer records, and under this same hold: publication
			// takes this lock, so a record queued at the moment of the listing
			// used to land just after it and the owner exited without capturing
			// it. Under the lock there is no "just after".
			const writersNow = await readHolders(path.join(baseDir, ISOLATION_UNFINISHED_DIR));
			// Intents are read *after* every other listing this decision waits
			// for, and nothing is awaited between reading them and acting on
			// them. Read first, they are a snapshot of who had announced
			// themselves before the awaits that followed, and a contender that
			// announced during those awaits was invisible — which is how an
			// owner exited with a foreign write still queued.
			const intents = await readHolders(path.join(baseDir, ISOLATION_INTENT_DIR));
			if (
				leases.allOurs &&
				!leases.unknown &&
				writersNow.allOurs &&
				!writersNow.unknown &&
				intents.allOurs &&
				!intents.unknown
			) {
				workspace.poll?.unref?.();
				workspace.watcher?.unref?.();
			} else {
				workspace.poll?.ref?.();
				workspace.watcher?.ref?.();
			}
			return undefined;
		}
		// A writer that gave up its lease but has not finished is still a user:
		// its record going away is the event this is waiting for just as much
		// as the last lease going away.
		const writers = await readHolders(path.join(baseDir, ISOLATION_UNFINISHED_DIR));
		// Last, for the same reason as above.
		const intents = await readHolders(path.join(baseDir, ISOLATION_INTENT_DIR));
		if (writers.anyLive || intents.anyLive) {
			// Our own record is kept until this process exits, so waiting for it
			// must not keep this process alive: the record is on disk and
			// reclamation takes the workspace afterwards. A *foreign* writer's
			// record is different — it will go while this process can still do
			// the final capture, and exiting early leaves that work uncaptured.
			// The arrival branch needs the same answer: a foreign party on its
			// way in is a reason to stay, whether or not its record has landed.
			if (writers.allOurs && !writers.unknown && intents.allOurs && !intents.unknown) {
				workspace.poll?.unref?.();
				workspace.watcher?.unref?.();
			} else {
				workspace.poll?.ref?.();
				workspace.watcher?.ref?.();
			}
			return undefined;
		}
		// Nothing is here and nothing is on its way — asked once more, with no
		// await since, because the teardown this returns is irreversible.
		const arriving = await readHolders(path.join(baseDir, ISOLATION_INTENT_DIR));
		if (arriving.anyLive) {
			workspace.poll?.ref?.();
			workspace.watcher?.ref?.();
			return undefined;
		}
		const owed = workspace.pendingTeardown;
		workspace.pendingTeardown = undefined;
		disarmTeardownWatch(workspace);
		return owed;
	});
	// Outside the hold: the teardown takes this lock itself, and running it
	// from inside would be the same self-deadlock in another place.
	if (pending === undefined) return;
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
 * Register what the owner owes without deciding anything, for a caller that
 * does not hold the sandbox lock.
 *
 * The registration must outlive the caller's own unlocked look at the
 * sandbox: withdrawing it on "nobody is here" and only then committing the
 * cleanup is precisely the window a user can be admitted in, and that user
 * then departs with nothing registered to capture its work. Whoever next takes
 * the lock — the cleanup itself — withdraws it, or honours it.
 *
 * No watch or poll is armed here: until something has decided under the lock
 * that the sandbox is in use, a timer could start the teardown beside the
 * caller that is about to run it.
 */
export function armTeardown(
	mergedDir: string,
	teardown: () => Promise<void>,
	options: { generation?: string } = {},
): void {
	const workspace = workspaces.get(mergedDir);
	if (!workspace) return;
	if (options.generation !== undefined && workspace.generation !== options.generation) return;
	workspace.pendingTeardown ??= teardown;
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
	if ((await hasLiveIsolationLease(baseDir)) || (await hasUnfinishedWriter(baseDir))) return true;
	// Nobody is here after all, and the caller is about to do the work itself.
	workspace.pendingTeardown = undefined;
	disarmTeardownWatch(workspace);
	return false;
}
