import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTierByFamily,
	TextContent,
	Usage,
} from "@oh-my-pi/pi-ai";
import {
	directoryIsEnterable,
	directoryIsMissing,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEexist,
	isEnoent,
	isEnotdir,
	isEnotempty,
	isFsError,
	logger,
	pathIsWithin,
	stringifyJson,
	toError,
} from "@oh-my-pi/pi-utils";
import { isTaskToolDetails, type StructuredSubagentSchemaMode } from "@oh-my-pi/pi-tui/tools/task";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { moveFileAcrossDevices } from "../utils/atomic-file";
import { hasAnnotationDraftsSync } from "../extensibility/custom-commands/bundled/annotate/draft-store";
import { ARTIFACT_STAGING_MARKER, ARTIFACT_STAGING_SUFFIX } from "./artifact-staging";
import { ArtifactManager } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore, lazyImageDataSync } from "./blob-store";
import type { CompactionMethod } from "./compaction-methods";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import { createInterruptedToolResults, sessionExitFollowsLastMessage } from "./exit-diagnostics";
import type { RetryFallbackRole } from "./retry-fallback-chains";
import {
	type BuildSessionContextOptions,
	buildSessionContext,
	type SessionContext,
	snapcompactHistoryBlockOptions,
} from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
	type FileEntry,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type ModelUsageEntry,
	lastSelfSelectedLeafId,
	type NewSessionOptions,
	type ResetBoundaryEntry,
	type ServiceTierChangeEntry,
	sessionEntryLeafId,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { currentRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity";
import {
	filterSessionsForPicker,
	findMostRecentNonEmptySession,
	findRecentSessionContinuation,
	findSessionContinuation,
	isEmptySession,
	listAllSessions,
	listSessions,
	type SessionContinuation,
	type SessionInfo,
} from "./session-listing";
import {
	loadEntriesFromFile,
	loadSessionFile,
	normalizeAssistantUsage,
	parseSessionContent,
	readSessionHeaderId,
	resolveBlobRefsInEntries,
	resolveBlobRefsInEntriesSync,
	type SessionLoadResult,
	visitEntriesFromFile,
} from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	hasPositiveMovedProjectEvidence,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	worktreeSessionDirs,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { forgetExternalizedImages, prepareEntryForPersistence } from "./session-persistence";
import { loadPinnedSessionIds, sortPinnedFirst } from "./session-pins";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
	SessionWriteConflictError,
	tryAcquireSessionLease,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";
import { recordSessionRecap, recordSessionTitle } from "./session-index";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const DISCARDED_ENTRY_BRANCH_MARKER = "discarded-entry-branch";
/**
 * Read-back-and-retry passes one full rewrite makes after meeting another
 * writer's entries. Each pass re-reads the file, so only a writer that appends
 * inside every read-to-publish window exhausts them.
 */
const MAX_WRITE_CONFLICT_RECOVERIES = 3;

/** A fresh session id. */
export function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

/**
 * `moveTo` refused before anything moved: another live omp process writes the
 * session, or the session file at the destination.
 */
export class SessionMoveRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionMoveRefusedError";
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

export function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

/** How many of the biggest entries a tally names, so one log line stays one line. */
const ARTIFACT_COPY_LARGEST = 3;

/**
 * What one reproduction of a session's artifacts directory cost.
 *
 * A session that moves off its file duplicates everything beside it, and the
 * only account of that was the free space afterwards. `largest` names the
 * top-level entries that dominated the bytes — a subagent's directory, a tool
 * log, whatever a later release starts writing there — so the cost is
 * attributable to a kind rather than only to a number.
 */
export interface ArtifactCopyTally {
	/** Files reproduced, at every depth. */
	entries: number;
	/** Their apparent size: what the copy asked of the disk. */
	bytes: number;
	/** The biggest top-level entries, a directory counted as its whole subtree, biggest first. */
	largest: { name: string; bytes: number }[];
}

/** What one staged copy has produced so far. */
interface ArtifactCopyProgress {
	/** Files reproduced, at every depth. */
	entries: number;
	/**
	 * Every object this copy made, by path, with the identity it had when it
	 * was made. Taking the tree down again consults this: an object at one of
	 * those paths that is not the object that was made there belongs to
	 * whoever put it there, and is not this copy's to delete.
	 */
	created: Map<string, ObjectIdentity>;
}

/** How a copy ended, for the caller that has to tell the session about it. */
export interface ArtifactCopyOutcome {
	/** What reached the destination; zeroed when nothing was published. */
	tally: ArtifactCopyTally;
	/**
	 * Whether a staged copy was thrown away instead of reaching the
	 * destination. A source with no artifacts discards nothing: there is a
	 * difference between a fork that inherited nothing and one that lost what
	 * it should have inherited, and only the second is worth telling anyone.
	 */
	discarded: boolean;
	/**
	 * Why it was discarded: because the source stopped being the session it was
	 * copied for, or because the copy itself could not be finished. They are
	 * not the same thing to say to anyone — one means the files belong to
	 * another conversation now, the other means they are still where they were.
	 */
	reason: "source-changed" | "copy-failed" | undefined;
}

/**
 * Reproduce one entry of an artifacts directory into `into`, a staging
 * directory this copy created and holds open, and return the bytes it cost.
 *
 * Every path here is resolved through that descriptor, the creating calls and
 * the failing ones alike: a staged file that cannot be finished is taken back
 * through the same held directory that made it. A handler reaching for the
 * pathname instead is how a name that changed underneath comes to name
 * somebody else's file.
 *
 * An entry the source lost while the walk ran (its session reaped it, a tool
 * replaced it) is skipped with a debug line, so one vanished file cannot cost
 * the destination everything after it — which a single recursive `cp` of a
 * directory a live session is still writing could.
 */
async function reproduceArtifactEntry(
	entry: fs.Dirent,
	from: string,
	into: PinnedDirectory,
	stagedUnder: string,
	progress: ArtifactCopyProgress,
): Promise<number> {
	const source = path.join(from, entry.name);
	const destination = `${into.at}/${entry.name}`;
	const staged = stagedUnder ? `${stagedUnder}/${entry.name}` : entry.name;
	try {
		if (entry.isDirectory()) {
			await fs.promises.mkdir(destination);
			// What `mkdir` made and what the next step opens are two
			// resolutions of one name; a mount landing between them is how a
			// copy comes to write into somebody else's filesystem.
			const child = await pinVerifiedChild(into, entry.name, "nothing was copied into it");
			if (!child) return 0;
			try {
				progress.created.set(staged, child.identity);
				return await reproduceArtifactTree(source, child, staged, progress);
			} finally {
				await child.close();
			}
		}
		if (entry.isFile()) return await reproduceArtifactFile(source, into, entry.name, staged, progress);
		if (entry.isSymbolicLink()) {
			await fs.promises.symlink(await fs.promises.readlink(source), destination);
			await rememberCreated(destination, staged, progress);
			return 0;
		}
		// Anything else a session's artifacts directory may hold (a fifo, a
		// socket): `cp` carries it into the staging tree like the rest.
		await fs.promises.cp(source, destination, { force: false, errorOnExist: true });
		await rememberCreated(destination, staged, progress);
		return 0;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		logger.debug("Session artifact vanished while it was being copied", { source, staged });
		return 0;
	}
}

/** Record what this copy just made at `target`, so only that object is ever removed. */
async function rememberCreated(target: string, staged: string, progress: ArtifactCopyProgress): Promise<void> {
	try {
		progress.created.set(staged, identityOf(await fs.promises.lstat(target, { bigint: true })));
	} catch {
		// Gone already; nothing this copy may remove.
	}
}

/** Reproduce the file `source` as `name` inside the held directory `into`, and return its bytes. */
async function reproduceArtifactFile(
	source: string,
	into: PinnedDirectory,
	name: string,
	staged: string,
	progress: ArtifactCopyProgress,
): Promise<number> {
	// The source is read before the destination exists, so an artifact that
	// vanished leaves nothing behind: an empty staged file would be published
	// as a real artifact of zero bytes, which reads as evidence that the tool
	// produced nothing rather than as evidence that is gone.
	const sourceStat = await fs.promises.stat(source);
	const destination = `${into.at}/${name}`;
	const handle = await fs.promises.open(destination, "wx");
	let created: ObjectIdentity | undefined;
	try {
		created = identityOf(await handle.stat({ bigint: true }));
		await handle.chmod(sourceStat.mode);
		await handle.writeFile(fs.createReadStream(source) as unknown as string);
		progress.created.set(staged, identityOf(await handle.stat({ bigint: true })));
		progress.entries += 1;
		return sourceStat.size;
	} catch (error) {
		// Read from the handle, which is the file itself: the copy's own
		// `chmod` and partial write have moved its change time since it was
		// opened, and the stub is still indisputably this copy's.
		const stub = await handle
			.stat({ bigint: true })
			.then(identityOf)
			.catch(() => created);
		await handle.close().catch(() => {});
		// Taken back through the directory that made it, and only while the
		// name still reaches the file that was made: a failure is not a licence
		// to delete whatever answers to a pathname by then.
		await removeHeldEntry(into, name, stub);
		throw error;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Take `name` back out of a held directory, and only while it is still the object `created` records. */
async function removeHeldEntry(
	into: PinnedDirectory,
	name: string,
	created: ObjectIdentity | undefined,
): Promise<void> {
	// The same two steps as any other removal — the name must still reach the
	// object, and the object is judged where only this copy can name it. A
	// failure path is not an exception to holding what it deletes.
	if (created) await removeIfStillOurs(into, name, created, name);
}

/** Reproduce the directory `from` into the held staging directory `into`. */
async function reproduceArtifactTree(
	from: string,
	into: PinnedDirectory,
	stagedUnder: string,
	progress: ArtifactCopyProgress,
): Promise<number> {
	const entries = await fs.promises.readdir(from, { withFileTypes: true });
	let bytes = 0;
	for (const entry of entries) bytes += await reproduceArtifactEntry(entry, from, into, stagedUnder, progress);
	return bytes;
}

/** Identity of one object: what it is, and which object it is. */
interface ObjectIdentity {
	device: bigint;
	inode: bigint;
	directory: boolean;
	/**
	 * Change time at nanosecond resolution. A file rewritten in place keeps its
	 * inode, so the number alone does not say the bytes are still the ones that
	 * were copied; a directory's moves whenever anything is written into it,
	 * including by this copy, so there it says nothing and is not compared.
	 */
	changedAt: bigint;
	/** How many names reach it. Another one appearing moves the change time without making it somebody else's. */
	links: bigint;
}

/**
 * A directory held open, so every operation inside it names the directory this
 * copy created rather than whatever its pathname reaches now.
 *
 * On Linux `/proc/self/fd/<n>` is a path that resolves through the open
 * descriptor, which is as close as Node comes to the `*at` system calls: a
 * pathname renamed away, or a directory replaced by a symlink, cannot redirect
 * work done through it. Elsewhere the pathname is all there is, and the
 * identity checks below are the whole boundary.
 */
interface PinnedDirectory {
	/** Path that resolves through the descriptor, or the plain path off Linux. */
	at: string;
	path: string;
	identity: ObjectIdentity;
	close(): Promise<void>;
}

const CAN_PIN_DIRECTORIES = process.platform === "linux";

/** What the staging root must still be: its own directory, whatever it now holds. */
function stagingIdentity(staging: ArtifactStaging): ObjectIdentity {
	return { device: staging.device, inode: staging.inode, directory: true, changedAt: 0n, links: 0n };
}

function identityOf(stat: fs.BigIntStats): ObjectIdentity {
	return {
		device: stat.dev,
		inode: stat.ino,
		directory: stat.isDirectory(),
		changedAt: stat.ctimeNs,
		links: stat.nlink,
	};
}

/** Whether both describe the same object — the same file, not merely the same name. */
function sameNode(left: ObjectIdentity, right: ObjectIdentity): boolean {
	return left.device === right.device && left.inode === right.inode && left.directory === right.directory;
}

/**
 * Whether the object at a staged name is still the one this copy put there,
 * and so still this copy's to remove.
 *
 * A filesystem hands a freed inode straight back, so the number alone cannot
 * tell this copy's file from one unlinked and recreated at the same name — the
 * change time is what separates them. A hard link moves that change time too,
 * without making the file anybody else's, and shows itself in the link count.
 */
function thisCopysToRemove(now: ObjectIdentity, created: ObjectIdentity): boolean {
	if (!sameNode(now, created)) return false;
	return now.directory || now.changedAt === created.changedAt || now.links > created.links;
}

/**
 * Whether both describe the same object *and* the same state of it.
 *
 * Deleting something this copy made only needs to know the name still reaches
 * that object: a hard link somebody else made to it moves its change time
 * without making it theirs. Handing it over needs more, because a file
 * rewritten in place keeps its inode and would be served under this session's
 * `artifact://` id as if the copy had produced it.
 */
function sameObject(left: ObjectIdentity, right: ObjectIdentity): boolean {
	if (!sameNode(left, right)) return false;
	return left.directory || left.changedAt === right.changedAt;
}

/**
 * Open `target` as a directory without following a symlink at its last
 * component, and hold it. `expected` refuses anything that is not the very
 * object the caller means — a directory swapped for another, or shadowed by a
 * mount, has an inode of its own and does not pass.
 */
async function pinDirectory(
	target: string,
	expected?: ObjectIdentity,
	logicalPath?: string,
): Promise<PinnedDirectory | undefined> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(
			target,
			fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
		);
	} catch {
		return undefined;
	}
	const identity = identityOf(await handle.stat({ bigint: true }));
	if (expected && !sameNode(identity, expected)) {
		await handle.close();
		return undefined;
	}
	return {
		at: CAN_PIN_DIRECTORIES ? `/proc/self/fd/${handle.fd}` : target,
		// Where it is, not how it was reached: a descriptor path answers no
		// question about mounts, and that is what the mount table is asked.
		path: logicalPath ?? target,
		identity,
		close: () => handle.close(),
	};
}

/**
 * Hold a child of a directory this copy already holds, and refuse anything
 * that is not a directory of the parent's own.
 *
 * A directory is reached through its parent's descriptor, so no pathname above
 * it can redirect the walk; what the descriptor cannot answer by itself is
 * whether the thing it reached is a doorway somewhere else. Three things
 * answer that, and the last is the one that decides:
 *
 * - the device, which a mount from another filesystem changes;
 * - the mount table, read against where the directory is and never against the
 *   descriptor path, because `/proc/self/fd` answers no question about mounts;
 * - and the directory's own link to its parent. A descriptor opened while a
 *   bind mount stood on the name keeps the bound directory after the mount is
 *   detached — same device, and by then an empty mount table — but it is some
 *   other directory's child, and `..` says so. Asked last, it also closes the
 *   order the other way round: a mount that is still there to be detached is
 *   a mount the table has already reported.
 */
async function pinVerifiedChild(
	parent: PinnedDirectory,
	name: string,
	what: string,
): Promise<PinnedDirectory | undefined> {
	const where = `${parent.path}/${name}`;
	const child = await pinDirectory(`${parent.at}/${name}`, undefined, where);
	if (!child) return undefined;
	if (child.identity.device !== parent.identity.device) {
		logger.warn(`A session artifact directory is on another filesystem than its parent; ${what}`, { dir: where });
		await child.close();
		return undefined;
	}
	const mounts = await mountsUnder(where);
	if (mounts === undefined || mounts.length > 0) {
		logger.warn(`A session artifact directory is mounted or unverifiable; ${what}`, {
			dir: where,
			mounts: mounts?.slice(0, ARTIFACT_COPY_LARGEST),
		});
		await child.close();
		return undefined;
	}
	if (!(await isChildOf(child, parent))) {
		logger.warn(`A session artifact directory is not a child of the directory that holds its name; ${what}`, {
			dir: where,
		});
		await child.close();
		return undefined;
	}
	return child;
}

/**
 * Whether the directory a descriptor holds is a child of the directory another
 * descriptor holds — asked of the filesystem, through `..`, rather than of a
 * pathname.
 */
async function isChildOf(child: PinnedDirectory, parent: PinnedDirectory): Promise<boolean> {
	const above = await pinDirectory(`${child.at}/..`);
	if (!above) return false;
	try {
		return sameNode(above.identity, parent.identity);
	} finally {
		await above.close();
	}
}

/** Where a session leaves the artifact claims its transcript has already spent. */
export const RESERVED_CLAIMS_FILE = ".omp-reserved";

/** A staging directory this copy created, with the identity it had when it was made. */
interface ArtifactStaging {
	path: string;
	device: bigint;
	inode: bigint;
	/** Held while this copy is building in it, so no other process sweeps it. */
	lease: { release(): void };
}

/**
 * Artifact copies in flight in this process, by destination artifacts
 * directory.
 *
 * `ArtifactManager` is not the only thing that reads a session's artifacts:
 * the public `artifact://` handler, a transcript export and a subagent's
 * output allocator all go to the filesystem themselves, and most of them hold
 * no session object to ask. A copy announces itself here, before it does
 * anything, so any of them can wait for the directory to become what the
 * session will actually have.
 */
const pendingArtifactCopies = new Map<string, Set<Promise<unknown>>>();

/** Rejects when `signal` aborts; never resolves otherwise. */
export function abortRejection(signal: AbortSignal): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	const fail = () => reject(signal.reason ?? new Error("Aborted"));
	if (signal.aborted) fail();
	else signal.addEventListener("abort", fail, { once: true });
	return promise;
}

/**
 * Settles once every artifact copy this process is running into `dir` has
 * finished; immediately when there are none.
 *
 * A caller that can be cancelled passes its signal: a pending answer is not a
 * missing answer, but neither is it something to make a cancelled read, an
 * interactive viewer or a deadline sit through. With no `dir` the caller is
 * saying it does not know which directory will answer it, so it waits for
 * every copy — the only honest answer when any of them could be the one.
 */
export async function whenArtifactCopiesSettle(dir?: string | null, signal?: AbortSignal): Promise<void> {
	for (;;) {
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		const pending = dir
			? [...(pendingArtifactCopies.get(path.resolve(dir)) ?? [])]
			: [...pendingArtifactCopies.values()].flatMap(set => [...set]);
		if (pending.length === 0) return;
		const settled = Promise.allSettled(pending);
		if (signal) await Promise.race([settled, abortRejection(signal)]);
		else await settled;
	}
}

/**
 * How many artifact copies into `dir` this process has announced, ever, and
 * how many are running now.
 *
 * A reader that lists the directory needs both. "Nothing is running" taken
 * after the listing does not say the listing was current: a copy announced and
 * finished while it ran leaves the table empty and the listing stale. The
 * count of announcements is what separates those, because it only goes up.
 */
export function artifactCopyActivity(dir: string): { announced: number; pending: number } {
	const key = path.resolve(dir);
	return { announced: artifactCopyAnnouncements.get(key) ?? 0, pending: pendingArtifactCopies.get(key)?.size ?? 0 };
}

/** Announcements per destination, counted for {@link artifactCopyActivity}; never reset. */
const artifactCopyAnnouncements = new Map<string, number>();

/** Announce a copy into `dir` for the readers of it, until `done` settles. */
function announceArtifactCopy(dir: string, done: Promise<unknown>): () => void {
	const key = path.resolve(dir);
	artifactCopyAnnouncements.set(key, (artifactCopyAnnouncements.get(key) ?? 0) + 1);
	const set = pendingArtifactCopies.get(key) ?? new Set();
	set.add(done);
	pendingArtifactCopies.set(key, set);
	return () => {
		set.delete(done);
		if (set.size === 0) pendingArtifactCopies.delete(key);
	};
}

/**
 * A private directory beside `destinationArtifactsDir` to build the copy in,
 * and the identity of the directory that was made.
 *
 * The lease is taken on the name *before* the directory exists, so there is no
 * window in which a tree is on disk that another copier can read as abandoned.
 * Without a lease there is no copy: continuing unprotected is how a live
 * copier's tree gets swept out from under it.
 *
 * The tree carries a marker naming its own identity. That is what a later
 * sweeper has to go on — the directory at a staging name may be anything by
 * then, and a sweeper that stats whatever it finds is validating a stranger's
 * directory against itself.
 */
async function createArtifactStaging(destinationArtifactsDir: string): Promise<ArtifactStaging | undefined> {
	await fs.promises.mkdir(path.dirname(destinationArtifactsDir), { recursive: true });
	await sweepAbandonedArtifactStaging(destinationArtifactsDir);
	for (let attempt = 0; attempt < 4; attempt++) {
		const staging = `${destinationArtifactsDir}.${mintSessionId()}${ARTIFACT_STAGING_SUFFIX}`;
		const lease = tryAcquireSessionLease(stagingLeaseName(staging));
		if (!lease) continue;
		try {
			await fs.promises.mkdir(staging, { mode: 0o700 });
		} catch (error) {
			lease.release();
			if (isEexist(error)) continue;
			throw error;
		}
		try {
			const identity = await fs.promises.lstat(staging, { bigint: true });
			await fs.promises.writeFile(
				path.join(staging, ARTIFACT_STAGING_MARKER),
				JSON.stringify({
					device: String(identity.dev),
					inode: String(identity.ino),
					// The lease belongs to the tree, not to the name it is under:
					// a tree moved to another staging name still has to be read
					// as the live copier's, and its basename no longer says so.
					lease: stagingLeaseName(staging),
				}),
				{ mode: 0o600 },
			);
			return { path: staging, device: identity.dev, inode: identity.ino, lease };
		} catch (error) {
			lease.release();
			throw error;
		}
	}
	return undefined;
}

/** The lease a copy holds while it is building in `staging`. */
function stagingLeaseName(staging: string): string {
	return `artifact-staging:${path.basename(staging)}`;
}

/**
 * The staging tree at `leftover`, if it is one and the marker inside it names
 * the very directory it is in.
 *
 * A directory that merely wears the name proves nothing: it may be a stranger's
 * data that happens to sit there. The marker is written by the copy that made
 * the tree and records the identity that tree had then, so a directory moved
 * aside and replaced cannot answer for it.
 */
async function identifyArtifactStaging(
	leftover: string,
	lease: { release(): void },
): Promise<ArtifactStaging | undefined> {
	let identity: fs.BigIntStats;
	try {
		identity = await fs.promises.lstat(leftover, { bigint: true });
	} catch {
		return undefined;
	}
	if (!identity.isDirectory()) return undefined;
	let marker: { device?: unknown; inode?: unknown; lease?: unknown };
	try {
		marker = JSON.parse(await fs.promises.readFile(path.join(leftover, ARTIFACT_STAGING_MARKER), "utf8"));
	} catch {
		return undefined;
	}
	if (marker?.device !== String(identity.dev) || marker?.inode !== String(identity.ino)) return undefined;
	// The lease the tree was made under, which a tree moved to another staging
	// name still carries. Taking the lease of the name it happens to wear says
	// nothing about whether its copier is still running.
	const own = typeof marker.lease === "string" ? marker.lease : stagingLeaseName(leftover);
	if (own !== stagingLeaseName(leftover)) {
		const ownLease = tryAcquireSessionLease(own);
		if (!ownLease) return undefined;
		ownLease.release();
	}
	return { path: leftover, device: identity.dev, inode: identity.ino, lease };
}

/**
 * Remove staging trees left behind by copies that are no longer running — ones
 * killed before they could publish or discard.
 *
 * Every staging tree in the session directory is considered, not only those
 * named for this destination: a resume mints a new destination each time, so a
 * crashed copy's tree is never named for the next one's. A live copy holds a
 * lease on its own tree, so taking that lease is what says the copy is gone,
 * and the marker inside is what says the tree was a copy's at all.
 */
async function sweepAbandonedArtifactStaging(destinationArtifactsDir: string): Promise<void> {
	const parent = path.dirname(destinationArtifactsDir);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(parent, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(ARTIFACT_STAGING_SUFFIX)) continue;
		const leftover = path.join(parent, entry.name);
		const lease = tryAcquireSessionLease(stagingLeaseName(leftover));
		if (!lease) continue; // A copy is still building in it.
		try {
			const staging = await identifyArtifactStaging(leftover, lease);
			if (staging) await removeArtifactStaging(staging);
		} catch {
			// It went away on its own, or is not ours to remove.
		} finally {
			lease.release();
		}
	}
}

/**
 * Mount points under `root`, from the kernel's own table, or `undefined` when
 * the table cannot be read.
 *
 * Nothing a `stat` returns tells a bind mount from the directory it shadows —
 * same device, same inode, and `..` resolves to the mount point's parent — so
 * the only way to know a copy is about to write into, publish, or delete
 * somebody else's filesystem is to ask which paths are mounts. An unreadable
 * table is not "no mounts": it is no answer, and the caller treats it as a
 * reason not to touch anything.
 */
async function mountsUnder(root: string): Promise<string[] | undefined> {
	if (process.platform !== "linux") return [];
	let table: string;
	try {
		table = await fs.promises.readFile("/proc/self/mountinfo", "utf8");
	} catch {
		return undefined;
	}
	const within = `${root}${path.sep}`;
	const found: string[] = [];
	for (const line of table.split("\n")) {
		// `<id> <parent> <dev> <root> <mount point> ...`. Every control
		// character and the backslash itself are octal-escaped, not only the
		// space, so a path holding a tab is otherwise read as a different path.
		const point = line
			.split(" ")[4]
			?.replace(/\\(\d{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
		if (point && (point === root || point.startsWith(within))) found.push(point);
	}
	return found;
}

/**
 * Remove a staging tree, and only the objects that were created in it.
 *
 * The root is held open and every step inside it goes through that descriptor,
 * so a pathname renamed away, or a directory replaced by a symlink, cannot
 * redirect the walk: what is reached is what this copy made. Each child is
 * checked against the identity it was created with — a directory shadowed by a
 * mount, or a file replaced by somebody else's, is a different object and is
 * left where it is. A sweeper clearing up after a process that is gone has no
 * such record, and so removes nothing from inside the tree: it takes the tree
 * away only when there is nothing in it but the marker.
 */
async function removeArtifactStaging(staging: ArtifactStaging, created?: Map<string, ObjectIdentity>): Promise<void> {
	// The root goes the way every object inside it goes: moved, whole, into a
	// directory created here, emptied from inside, and taken down there. A
	// `rmdir` of its own name would take whatever that name reaches at that
	// instant, and the staging name is derived from the session file, so
	// anybody can know it and leave an empty directory under it to be removed.
	const parent = await pinDirectory(path.dirname(staging.path));
	if (!parent) {
		logger.warn("Could not hold the directory a session artifact staging tree is in; left alone", {
			staging: staging.path,
		});
		return;
	}
	try {
		await removeDirectoryIfStillOurs(parent, path.basename(staging.path), stagingIdentity(staging), "", created);
	} finally {
		await parent.close();
	}
}

/** Remove the contents of a directory this copy owns, through the descriptor that holds it. */
async function emptyPinnedDirectory(
	dir: PinnedDirectory,
	stagedUnder: string,
	created?: Map<string, ObjectIdentity>,
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir.at, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Could not read a session artifact staging directory", {
				dir: dir.path,
				error: toError(error).message,
			});
		}
		return;
	}
	for (const entry of entries) {
		const staged = stagedUnder ? `${stagedUnder}/${entry.name}` : entry.name;
		const record = created?.get(staged);
		// The marker stays until the tree it marks is gone. It is what a
		// sweeper recognises an abandoned tree by, and removing it first opens
		// a window in which a kill leaves a tree nothing will ever collect —
		// along with whatever this removal had already moved into a directory
		// of its own inside it. It leaves with the tree, from inside the
		// directory the tree is moved into.
		if (!stagedUnder && entry.name === ARTIFACT_STAGING_MARKER) continue;
		// Only what this copy recorded creating is this copy's to remove.
		//
		// Without that record there is no such thing: a sweeper arriving at an
		// abandoned tree knows the *tree* was a copy's, which the marker says,
		// and knows nothing at all about an object it never placed. Reading
		// the one claim as the other is how a sweep comes to delete a file
		// somebody else put there — the tree is left whole instead, and said
		// so.
		//
		// What that costs is retention rather than a delay: nothing collects
		// such a tree later, and it outlives the session it was being copied
		// for. A record durable enough for the next process to use is possible
		// — written as the copy goes, read conservatively, anything missing or
		// not matching meaning keep — and would turn this into recovery. It is
		// not here, and this is the conservative half of it.
		if (!created) {
			logger.warn("An abandoned session artifact staging tree is not this process's to empty; left whole", {
				dir: dir.path,
				entries: entries.length,
			});
			return;
		}
		if (record === undefined) {
			logger.warn("A session artifact staging entry was not created by this copy; left alone", { path: staged });
			continue;
		}
		if (entry.isDirectory()) {
			await removeDirectoryIfStillOurs(dir, entry.name, record, staged, created);
			continue;
		}
		await removeIfStillOurs(dir, entry.name, record, staged);
	}
}

/**
 * Remove `name` from a held directory, but only while it is still the object
 * this copy created there.
 *
 * Checking and then unlinking a name leaves a gap: whatever answers to the
 * name at the moment of the unlink is what is destroyed, and that may be a
 * file somebody else put there since. So the entry is first moved aside to a
 * name only this copy knows — one atomic step — and judged there. What turns
 * out not to be this copy's is put back, and left alone.
 */
async function removeIfStillOurs(
	dir: PinnedDirectory,
	name: string,
	record: ObjectIdentity,
	staged: string,
): Promise<void> {
	const at = `${dir.at}/${name}`;
	// First, that the name still reaches the object this copy created: a file
	// unlinked and recreated there can wear the same inode, and only the
	// change time and link count separate it from this copy's own.
	const before = await fs.promises
		.lstat(at, { bigint: true })
		.then(identityOf)
		.catch(() => undefined);
	if (!before || !thisCopysToRemove(before, record)) {
		if (before) {
			logger.warn("A session artifact staging entry is not the object that was created; left alone", {
				path: staged,
			});
		}
		return;
	}
	// Then, that nothing took its place between that answer and this removal.
	// The entry is moved into a directory made here — `mkdir` fails rather
	// than overwrites, so the place it is moved to cannot be anybody else's —
	// and judged there, where the object is still on disk and its inode
	// therefore cannot have been recycled by a replacement. Anything that is
	// not this copy's is left in that directory rather than put back over
	// whatever now holds the original name.
	const aside = await makeExclusiveDirectory(dir);
	if (!aside) return;
	const asideDir = aside.dir;
	try {
		if (!(await moveIntoAside(at, asideDir, false, staged))) return;
		const moved = await fs.promises
			.lstat(`${asideDir.at}/${ASIDE_ENTRY}`, { bigint: true })
			.then(identityOf)
			.catch(() => undefined);
		if (moved && sameNode(moved, before)) {
			await fs.promises.unlink(`${asideDir.at}/${ASIDE_ENTRY}`).catch(() => {});
			return;
		}
		logger.warn("A session artifact staging entry changed as it was being removed; put back", { path: staged });
		try {
			// Exclusive again: if something has taken the original name since,
			// it keeps it, and what was moved stays where nothing serves it.
			await fs.promises.link(`${asideDir.at}/${ASIDE_ENTRY}`, at);
			await fs.promises.unlink(`${asideDir.at}/${ASIDE_ENTRY}`).catch(() => {});
		} catch {
			logger.warn("Could not put back an object that was not this copy's", {
				path: staged,
				kept: asideDir.path,
			});
		}
	} finally {
		await removeExclusiveDirectory(dir, aside);
	}
}

/** The one name an aside directory ever holds. */
const ASIDE_ENTRY = "entry";

/**
 * Move `from` to the one name inside an aside directory, having first taken
 * that name exclusively.
 *
 * `rename` replaces whatever the target names, which is safe only while the
 * target is known to be this copy's. The aside directory was created here, but
 * it is reached again by its name to be opened, so the thing opened can be
 * another directory with contents of its own: creating the name first — `mkdir`
 * for a directory, `open(wx)` for anything else, both of which fail rather than
 * overwrite — is what proves the move lands on nobody's file.
 */
async function moveIntoAside(
	from: string,
	aside: PinnedDirectory,
	directory: boolean,
	staged: string,
): Promise<boolean> {
	const target = `${aside.at}/${ASIDE_ENTRY}`;
	try {
		if (directory) await fs.promises.mkdir(target);
		else await (await fs.promises.open(target, "wx")).close();
	} catch {
		logger.warn("A session artifact removal directory is not the one that was created; nothing was moved into it", {
			path: staged,
			aside: aside.path,
		});
		return false;
	}
	try {
		await fs.promises.rename(from, target);
		return true;
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Could not set a session artifact aside to remove it", { path: staged });
		await (directory ? fs.promises.rmdir(target) : fs.promises.unlink(target)).catch(() => {});
		return false;
	}
}

/**
 * Remove a directory from a held directory, but only while it is still the
 * directory this copy created there.
 *
 * A `rmdir` of a name is not a removal of the directory that name reached a
 * moment ago: an empty directory put there in between is what goes, and an
 * empty directory is the one thing any process of the same user can make. So a
 * staged directory is moved, whole, into a directory created here, emptied
 * from inside through a descriptor held on it, and taken down there, where the
 * name it has is one nothing else has ever seen.
 */
async function removeDirectoryIfStillOurs(
	parent: PinnedDirectory,
	name: string,
	record: ObjectIdentity,
	staged: string,
	created: Map<string, ObjectIdentity> | undefined,
): Promise<void> {
	const at = `${parent.at}/${name}`;
	const before = await fs.promises
		.lstat(at, { bigint: true })
		.then(identityOf)
		.catch(() => undefined);
	if (!before?.directory || !sameNode(before, record)) {
		if (before) {
			logger.warn("A session artifact staging entry is not the directory that was created; left alone", {
				path: staged,
			});
		}
		return;
	}
	// Emptied where it stands, so that anything in it which is not this
	// copy's — a file somebody else put there, which this copy leaves alone —
	// stays under the name it has rather than being carried off with the
	// directory around it.
	const inPlace = await pinVerifiedChild(parent, name, "it was left where it is");
	if (!inPlace) return;
	let empty = false;
	try {
		if (!sameNode(inPlace.identity, before)) return;
		await emptyPinnedDirectory(inPlace, staged, created);
		// The root of a staging tree keeps its marker until the tree itself
		// goes, so "empty" there means the marker and nothing else.
		const left = await fs.promises.readdir(inPlace.at).catch(() => ["unreadable"]);
		empty = left.length === 0 || (staged === "" && left.length === 1 && left[0] === ARTIFACT_STAGING_MARKER);
	} finally {
		await inPlace.close();
	}
	if (!empty) {
		logger.debug("A session artifact staging directory still holds something this copy may not remove", {
			path: staged,
		});
		return;
	}
	// Only then taken down, and not by its name: a `rmdir` of the name takes
	// whatever the name reaches at that instant, and an empty directory put
	// there in between is both indistinguishable and trivial to make. The
	// empty directory is moved into one created here, checked there, and
	// removed under a name nothing else has ever seen.
	await removeEmptyDirectory(parent, name, before, staged);
}

/**
 * Remove an empty directory this copy created, from inside a directory created
 * here rather than by the name it has where it stands.
 */
async function removeEmptyDirectory(
	parent: PinnedDirectory,
	name: string,
	expected: ObjectIdentity,
	staged: string,
): Promise<void> {
	const aside = await makeExclusiveDirectory(parent);
	if (!aside) return;
	const asideDir = aside.dir;
	try {
		if (!(await moveIntoAside(`${parent.at}/${name}`, asideDir, true, staged))) return;
		// Opened where nothing else names it, and still required to be the
		// directory that was moved: a bind mount that stood on the old name is
		// a different inode, detached or not.
		const inside = await pinVerifiedChild(asideDir, ASIDE_ENTRY, "it was left where it was moved to");
		// And still holding nothing but what leaves with it. The emptiness was
		// decided before the move; something put in between is somebody else's
		// object, and carrying it off — to a directory this process then takes
		// down — loses it as surely as deleting it would. Judged here, where
		// the object is on disk and under a name nothing else can reach, and
		// the whole tree goes back if there is anything to go back for.
		const held = inside
			? await fs.promises.readdir(inside.at).catch(() => ["unreadable"])
			: [ARTIFACT_STAGING_MARKER, "unreadable"];
		const empty = held.every(entry => entry === ARTIFACT_STAGING_MARKER);
		const ours = Boolean(inside && sameNode(inside.identity, expected)) && empty;
		await inside?.close();
		if (!ours) {
			logger.warn("A session artifact staging entry changed as it was being removed; put back", {
				path: staged,
				held: empty ? undefined : held.slice(0, ARTIFACT_COPY_LARGEST),
			});
			await putDirectoryBack(parent, name, asideDir, staged);
			return;
		}
		// The marker goes here, inside a directory created by this process and
		// named by it: from the kill that lands a moment earlier, a sweeper
		// still finds a marked tree — this one — and takes both down.
		await fs.promises.unlink(`${asideDir.at}/${ASIDE_ENTRY}/${ARTIFACT_STAGING_MARKER}`).catch(() => {});
		await fs.promises.rmdir(`${asideDir.at}/${ASIDE_ENTRY}`).catch(() => {});
	} finally {
		await removeExclusiveDirectory(parent, aside);
	}
}

/**
 * Put a directory back under the name it was moved from, and only if that name
 * is still free.
 *
 * `mkdir` is what asks: it fails rather than overwrites, so a name something
 * else has taken since keeps what it has, and what was moved stays in the
 * aside directory, where nothing serves it and the next sweep finds it.
 */
async function putDirectoryBack(
	parent: PinnedDirectory,
	name: string,
	aside: PinnedDirectory,
	staged: string,
): Promise<void> {
	try {
		await fs.promises.mkdir(`${parent.at}/${name}`);
		await fs.promises.rename(`${aside.at}/${ASIDE_ENTRY}`, `${parent.at}/${name}`);
	} catch {
		logger.warn("Could not put back a directory that was not this copy's", { path: staged, kept: aside.path });
	}
}

/**
 * Take down an aside directory, and only while its name still reaches the
 * directory that was created.
 *
 * This is the one `rmdir` by name left, and what makes it safe is the name:
 * minted here, never reused, and never written down anywhere another process
 * can read it before it exists. An empty directory put in its place would have
 * to be put there under a name nobody could know. The staging root cannot
 * claim that — its name comes from the session file it belongs to — which is
 * why the root is taken down from inside one of these instead.
 */
async function removeExclusiveDirectory(parent: PinnedDirectory, aside: AsideDirectory): Promise<void> {
	const name = path.basename(aside.dir.path);
	await fs.promises.unlink(`${aside.dir.at}/${ARTIFACT_STAGING_MARKER}`).catch(() => {});
	await aside.dir.close();
	const now = await fs.promises
		.lstat(`${parent.at}/${name}`, { bigint: true })
		.then(identityOf)
		.catch(() => undefined);
	if (now && sameNode(now, aside.dir.identity)) await fs.promises.rmdir(`${parent.at}/${name}`).catch(() => {});
	aside.lease.release();
}

/** A directory created here to judge one object in, and the lease that keeps a sweeper out of it. */
interface AsideDirectory {
	dir: PinnedDirectory;
	lease: { release(): void };
}

/**
 * A directory created here, under a name nothing else can already hold, that a
 * sweeper will finish if this process does not.
 *
 * It is named and marked as a staging tree of its own, because that is what it
 * is: a tree of this copy's objects, on disk, that nothing points at. A crash
 * between the move and the removal would otherwise leave the thing moved into
 * it where no sweep looks — the leak the old by-name `rmdir` did not have, and
 * the price of not having it is a marker and a lease, which the sweeper
 * already understands.
 */
async function makeExclusiveDirectory(dir: PinnedDirectory): Promise<AsideDirectory | undefined> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const name = `.omp-removing-${mintSessionId()}${ARTIFACT_STAGING_SUFFIX}`;
		const lease = tryAcquireSessionLease(stagingLeaseName(name));
		if (!lease) continue;
		try {
			await fs.promises.mkdir(`${dir.at}/${name}`, { mode: 0o700 });
		} catch (error) {
			lease.release();
			if (isEexist(error)) continue;
			return undefined;
		}
		const aside = await pinVerifiedChild(dir, name, "nothing was moved into it");
		if (!aside) {
			lease.release();
			return undefined;
		}
		try {
			await fs.promises.writeFile(
				`${aside.at}/${ARTIFACT_STAGING_MARKER}`,
				JSON.stringify({
					device: String(aside.identity.device),
					inode: String(aside.identity.inode),
					lease: stagingLeaseName(name),
				}),
				{ mode: 0o600 },
			);
		} catch {
			await aside.close();
			lease.release();
			return undefined;
		}
		return { dir: aside, lease };
	}
	return undefined;
}

/** Remove an unpublished staging tree and give up its lease, whatever happens. */
async function discardArtifactStaging(staging: ArtifactStaging, created?: Map<string, ObjectIdentity>): Promise<void> {
	try {
		await removeArtifactStaging(staging, created);
	} catch (error) {
		logger.warn("Failed to remove an abandoned session artifact staging directory", {
			staging: staging.path,
			error: toError(error).message,
		});
	} finally {
		staging.lease.release();
	}
}

/**
 * Hand the staged tree to `destination`, and report which names got there.
 *
 * Everything is checked **before** the tree can be reached: the staging root
 * is still the directory that was created, nothing is mounted under it, and
 * every object in it is still the object the copy wrote. A check after the
 * handover cannot withhold anything — a reader can already have opened what it
 * would withdraw — so the rename is the last step rather than the first.
 *
 * A destination that does not exist takes the whole tree in one rename. One
 * that already holds entries of its own — the session wrote an artifact while
 * the copy ran, or recorded the identifiers it may not reuse — keeps every
 * name it has, and the rest is moved across through descriptors held on both
 * directories. Each move creates a name that was free; nothing is overwritten
 * and nothing is undone, so there is no rollback to aim at somebody else's
 * file.
 */
async function publishArtifactStaging(
	staging: ArtifactStaging,
	destination: string,
	created: Map<string, ObjectIdentity>,
): Promise<Map<string, number | null> | undefined> {
	// The directory both names live in, held for the handover: the rename is
	// then resolved from a descriptor on each side rather than from two
	// pathnames, so a staging directory substituted at that instant cannot be
	// what moves.
	const parent = await pinDirectory(path.dirname(staging.path));
	if (!parent) return undefined;
	try {
		const root = await pinDirectory(
			`${parent.at}/${path.basename(staging.path)}`,
			stagingIdentity(staging),
			staging.path,
		);
		if (!root) {
			logger.warn("Session artifact staging is no longer the directory that was created; nothing was published", {
				staging: staging.path,
			});
			return undefined;
		}
		let staged: string[];
		try {
			// Every object in the tree, found by walking it rather than by
			// reading back the record: a file somebody else added to the stage
			// is not in the record, and a check that only visits what the copy
			// wrote would publish it as this session's artifact.
			staged = await fs.promises.readdir(root.at);
			const unexpected = await firstUnexpectedObject(root, "", created);
			if (unexpected) {
				logger.warn("A staged session artifact is not the object that was copied; nothing was published", {
					staging: staging.path,
					staged: unexpected,
				});
				return undefined;
			}
			// Last before the handover; a check made after it cannot withhold
			// anything, because a reader can already have opened what it would
			// take back.
			const mounts = await mountsUnder(staging.path);
			if (mounts === undefined || mounts.length > 0) {
				logger.warn("Session artifact staging is mounted or unverifiable; nothing was published from it", {
					staging: staging.path,
					mounts: mounts?.slice(0, ARTIFACT_COPY_LARGEST),
				});
				return undefined;
			}
		} finally {
			await root.close();
		}
		const published = staged.filter(name => name !== ARTIFACT_STAGING_MARKER);
		try {
			await fs.promises.rename(
				`${parent.at}/${path.basename(staging.path)}`,
				`${parent.at}/${path.basename(destination)}`,
			);
			// The marker travels with the tree and is taken out of the
			// destination afterwards: removing it first would leave a crash
			// between the two with a staging tree nothing can recognise.
			//
			// Through the tree itself, never through the destination name. The
			// rename keeps the inode, so the directory that was staged is
			// still identifiable; a symlink put at the destination name points
			// the unlink at a marker of somebody else's, and that file is as
			// likely to be their only copy of it.
			const handed = await pinDirectory(
				`${parent.at}/${path.basename(destination)}`,
				stagingIdentity(staging),
				destination,
			);
			if (handed) {
				try {
					await fs.promises.unlink(`${handed.at}/${ARTIFACT_STAGING_MARKER}`).catch(() => {});
				} finally {
					await handed.close();
				}
			} else {
				logger.warn("A session's published artifacts directory is not the tree that was staged; marker left", {
					destination,
				});
			}
			// `null` is the whole tree in one rename: every name arrived,
			// whatever is in it, because the directory itself is what moved.
			return new Map(published.map(name => [name, null]));
		} catch (error) {
			if (!isEnotempty(error) && !isEexist(error) && !isEnotdir(error)) {
				logger.warn("Could not publish a session's copied artifacts", {
					staging: staging.path,
					destination,
					error: toError(error).message,
				});
				return undefined;
			}
		}
		return await mergeIntoDestination(staging, destination, published);
	} finally {
		await parent.close();
	}
}

/**
 * The first staged object the copy cannot answer for: one it did not create,
 * one that is no longer what it was, or one it did create that is no longer
 * there.
 *
 * Both halves matter, and they are not the same question. Walking what is
 * there finds a file somebody else added; only comparing the record against
 * what is there finds a file that was taken away. The second is the half that
 * decides a delivery: a fork whose transcript refers to `artifact://1` and
 * whose directory has only `0` has not inherited its artifacts, and publishing
 * it says that it has.
 */
async function firstUnexpectedObject(
	dir: PinnedDirectory,
	stagedUnder: string,
	created: Map<string, ObjectIdentity>,
): Promise<string | undefined> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir.at, { withFileTypes: true });
	} catch (error) {
		return `${stagedUnder || "."}: ${toError(error).message}`;
	}
	const present = new Set(entries.map(entry => entry.name));
	const prefix = stagedUnder ? `${stagedUnder}/` : "";
	for (const staged of created.keys()) {
		if (!staged.startsWith(prefix)) continue;
		const rest = staged.slice(prefix.length);
		if (rest.length === 0 || rest.includes("/")) continue;
		if (!present.has(rest)) return staged;
	}
	for (const entry of entries) {
		const staged = stagedUnder ? `${stagedUnder}/${entry.name}` : entry.name;
		if (!stagedUnder && entry.name === ARTIFACT_STAGING_MARKER) continue;
		const record = created.get(staged);
		if (!record) return staged;
		const now = await fs.promises
			.lstat(`${dir.at}/${entry.name}`, { bigint: true })
			.then(identityOf)
			.catch(() => undefined);
		if (!now || !sameObject(now, record)) return staged;
		if (!record.directory) continue;
		const child = await pinDirectory(`${dir.at}/${entry.name}`, record, path.join(dir.path, entry.name));
		if (!child) return staged;
		try {
			const deeper = await firstUnexpectedObject(child, staged, created);
			if (deeper) return deeper;
		} finally {
			await child.close();
		}
	}
	return undefined;
}

/**
 * Move the staged entries into a destination that already has contents of its
 * own, through descriptors held on both directories.
 *
 * Both sides are pinned, so neither a staging path nor a destination path that
 * stops meaning its directory can take a move somewhere else; a name the
 * destination already has is left to the destination, which is the rule a
 * colliding artifact has always had.
 *
 * Unlike the single rename this falls back from, it is **not atomic**: the
 * entries appear one at a time, so a reader can see some of the inherited
 * artifacts and not the rest. Readers in this process do not — they wait on
 * the copy ({@link whenArtifactCopiesSettle}), which is every consumer the
 * session has: the `artifact://` handler, a subagent's output allocator and an
 * export. A reader in another process can, and the condition for it is narrow:
 * this path runs only when the destination already holds artifacts, which
 * means the session is writing there itself, and a reader of a directory being
 * written to sees partial state whoever is writing it.
 */
async function mergeIntoDestination(
	staging: ArtifactStaging,
	destination: string,
	staged: readonly string[],
): Promise<Map<string, number> | undefined> {
	const from = await pinDirectory(staging.path, stagingIdentity(staging));
	if (!from) return undefined;
	try {
		// Through the directory that holds the destination's name, so the
		// destination root gets what every directory below it gets: its device
		// against its parent's, the mount table, and its own link to its
		// parent. Opening it by its pathname asks none of those, and a bind
		// mounted over it and then detached is a descriptor on somebody else's
		// directory that answers to all of this copy's other checks.
		const above = await pinDirectory(path.dirname(destination));
		if (!above) {
			logger.warn("Could not hold the directory a session's artifacts go in; nothing was published", {
				destination,
			});
			return undefined;
		}
		try {
			const into = await pinVerifiedChild(above, path.basename(destination), "nothing was published into it");
			if (!into) return undefined;
			try {
				const published = new Map<string, number>();
				for (const name of staged) {
					published.set(name, await moveIntoHeldDirectory(from, into, name, destination));
				}
				return published;
			} finally {
				await into.close();
			}
		} finally {
			await above.close();
		}
	} finally {
		await from.close();
	}
}

/**
 * Move one staged entry into the held destination, creating only names that
 * are free, and report whether anything of it arrived.
 *
 * Every creation is exclusive — `link` for a file, `mkdir` for a directory —
 * so a name the destination already has keeps whatever is behind it, and a
 * name it creates while this runs wins too. A directory the destination
 * already has is merged into rather than replaced, through descriptors held
 * on both sides, which is the only way to add to it without overwriting the
 * entries it has of its own.
 */
async function moveIntoHeldDirectory(
	from: PinnedDirectory,
	into: PinnedDirectory,
	name: string,
	destination: string,
): Promise<number> {
	const source = `${from.at}/${name}`;
	const target = `${into.at}/${name}`;
	try {
		const entry = await fs.promises.lstat(source, { bigint: true });
		if (!entry.isDirectory()) {
			// `link` refuses an existing name, so nothing is ever overwritten;
			// the staged name is then dropped, leaving the tree empty for its
			// own removal.
			await fs.promises.link(source, target);
			await fs.promises.unlink(source).catch(() => {});
			return 1;
		}
		try {
			await fs.promises.mkdir(target);
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		// Both sides are opened through the descriptor that holds them and
		// checked for a mount: the destination's own subdirectory is not this
		// copy's work and can be anything by the time the merge reaches it,
		// and the check at the destination root was answered before any of
		// these names was touched.
		const sourceDir = await pinVerifiedChild(from, name, "it was left in the staging tree");
		const targetDir = await pinVerifiedChild(into, name, "nothing was published into it");
		if (!sourceDir || !targetDir) {
			await sourceDir?.close();
			await targetDir?.close();
			return 0;
		}
		try {
			// What this placed, counted as it places it. A staged name that is
			// simply gone when the walk reaches it was not delivered by this
			// copy — somebody removing it is not the same event as it arriving
			// — and the caller turns this number into "the fork inherited
			// these files", which is what stops anyone looking for them.
			let placed = 0;
			for (const child of await fs.promises.readdir(sourceDir.at)) {
				placed += await moveIntoHeldDirectory(sourceDir, targetDir, child, destination);
			}
			return placed;
		} finally {
			await sourceDir.close();
			await targetDir.close();
			await fs.promises.rmdir(source).catch(() => {});
		}
	} catch (error) {
		if (isEexist(error) || isEnotempty(error) || isEnotdir(error) || isEnoent(error)) return 0;
		logger.warn("Could not publish one of a session's copied artifacts", {
			destination,
			name,
			error: toError(error).message,
		});
		return 0;
	}
}

/**
 * Copy a session's artifact directory to another session, matching interactive
 * `/fork`. Failures are logged, never thrown.
 *
 * The copy is built in a private staging directory and handed over in one
 * rename, so the destination only ever gains a complete copy. That is what
 * makes abandoning one safe: a copy whose source stopped being the session it
 * was copied for (`stillTheSource`), or one that could not be finished, is
 * removed while it is still unpublished and unreachable by any other name.
 * Nothing at the destination is overwritten, and nothing anywhere is deleted by
 * name — the two ways an undo destroys somebody else's file.
 *
 * Returns what it cost and logs the same. A session forced off its file
 * duplicates its artifacts, and a session with large ones duplicates a lot;
 * until now neither the session nor its log said so, and the first report of
 * it was the free space. See {@link ArtifactCopyTally}.
 */
export async function copySessionArtifacts(
	sourceSessionFile: string,
	destinationSessionFile: string,
	options?: { stillTheSource?: () => Promise<boolean>; onSettled?: (outcome: ArtifactCopyOutcome) => Promise<void> },
): Promise<ArtifactCopyOutcome> {
	const destinationDir = artifactsDirectoryFor(destinationSessionFile);
	if (!destinationDir) return await copySessionArtifactsOnce(sourceSessionFile, destinationSessionFile, options);
	// Announced before it does anything, and before it waits for the copies
	// already going into this directory: a copy that is invisible until its
	// first continuation lets a reader conclude the directory is settled when
	// it is not, and a copy that waits before announcing lets a second one slip
	// past it into the same namespace.
	const earlier = [...(pendingArtifactCopies.get(path.resolve(destinationDir)) ?? [])];
	const run = (async () => {
		await Promise.allSettled(earlier);
		return await copySessionArtifactsOnce(sourceSessionFile, destinationSessionFile, options);
	})();
	const forget = announceArtifactCopy(destinationDir, run);
	try {
		return await run;
	} finally {
		forget();
	}
}

async function copySessionArtifactsOnce(
	sourceSessionFile: string,
	destinationSessionFile: string,
	options?: { stillTheSource?: () => Promise<boolean>; onSettled?: (outcome: ArtifactCopyOutcome) => Promise<void> },
): Promise<ArtifactCopyOutcome> {
	// Whatever the caller has to record about this copy is part of the copy:
	// a reader that waited for the directory to settle has waited for that too,
	// rather than finishing in the window before it is written.
	const settle = async (outcome: ArtifactCopyOutcome): Promise<ArtifactCopyOutcome> => {
		try {
			await options?.onSettled?.(outcome);
		} catch (error) {
			logger.warn("Failed to record what a session artifact copy settled as", { error: toError(error).message });
		}
		return outcome;
	};
	const empty: ArtifactCopyOutcome = {
		tally: { entries: 0, bytes: 0, largest: [] },
		discarded: false,
		reason: undefined,
	};
	// Artifacts sit beside the journal's real name: a session reached through a
	// symlink keeps them next to the link's target, not next to the link.
	let realSource = sourceSessionFile;
	try {
		realSource = await fs.promises.realpath(sourceSessionFile);
	} catch {}
	const sourceArtifactsDir = artifactsDirectoryFor(realSource);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return await settle(empty);
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return await settle(empty);
	let sourceEntries: fs.Dirent[];
	try {
		if (!(await fs.promises.stat(sourceArtifactsDir)).isDirectory()) return await settle(empty);
		sourceEntries = await fs.promises.readdir(sourceArtifactsDir, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read a session's artifacts", { sourceArtifactsDir, error: toError(error).message });
		}
		return await settle(empty);
	}
	const staging = await createArtifactStaging(destinationArtifactsDir);
	if (!staging) {
		logger.warn("Could not stage a session's artifacts", { sourceArtifactsDir, destinationArtifactsDir });
		return await settle(empty);
	}
	const progress: ArtifactCopyProgress = { entries: 0, created: new Map() };
	const perEntry: { name: string; bytes: number; files: number }[] = [];
	// Held for the whole walk: everything written, and everything taken back
	// after a failure, is resolved through the directory this copy created
	// rather than through a name that can stop meaning it.
	const root = await pinDirectory(staging.path, stagingIdentity(staging));
	if (!root) {
		logger.warn("Could not hold a session's artifact staging directory open", { staging: staging.path });
		await discardArtifactStaging(staging, progress.created);
		return await settle({ ...empty, discarded: true, reason: "copy-failed" });
	}
	try {
		for (const entry of sourceEntries) {
			const filesBefore = progress.entries;
			const bytes = await reproduceArtifactEntry(entry, sourceArtifactsDir, root, "", progress);
			perEntry.push({ name: entry.name, bytes, files: progress.entries - filesBefore });
		}
	} catch (error) {
		logger.warn("Failed to copy session artifacts", {
			sourceArtifactsDir,
			destinationArtifactsDir,
			error: toError(error).message,
		});
		await root.close();
		await discardArtifactStaging(staging, progress.created);
		return await settle({ ...empty, discarded: true, reason: "copy-failed" });
	}
	await root.close();
	let stillTheSource = true;
	try {
		stillTheSource = options?.stillTheSource ? await options.stillTheSource() : true;
	} catch (error) {
		// A check that cannot answer is not an answer: the copy is abandoned,
		// and abandoning it is what releases the staging tree and its lease.
		logger.warn("Could not check whether a session's artifacts still belong to it; the copy was discarded", {
			sourceArtifactsDir,
			error: toError(error).message,
		});
		await discardArtifactStaging(staging, progress.created);
		return await settle({ ...empty, discarded: true, reason: "copy-failed" });
	}
	if (!stillTheSource) {
		logger.warn("Session artifacts stopped belonging to the session they were copied for; the copy was discarded", {
			sourceArtifactsDir,
			destinationArtifactsDir,
		});
		await discardArtifactStaging(staging, progress.created);
		return await settle({ ...empty, discarded: true, reason: "source-changed" });
	}
	const published = await publishArtifactStaging(staging, destinationArtifactsDir, progress.created);
	await discardArtifactStaging(staging, progress.created);
	if (!published) return await settle({ ...empty, discarded: true, reason: "copy-failed" });
	// Only what this copy placed. A name the destination already had kept its
	// own version; an entry that lost part of itself — to such a name, to a
	// check that refused it, or to somebody removing a staged file before the
	// move reached it — is not reported as inherited, because this number is
	// what tells a reader the files are there.
	const delivered = perEntry.filter(entry => {
		const placed = published.get(entry.name);
		return placed === null || placed === entry.files;
	});
	if (delivered.length === 0) {
		const lost = sourceEntries.length > 0;
		return await settle({ ...empty, discarded: lost, reason: lost ? "copy-failed" : undefined });
	}
	const tally: ArtifactCopyTally = {
		entries: delivered.reduce((total, entry) => total + entry.files, 0),
		bytes: delivered.reduce((total, entry) => total + entry.bytes, 0),
		largest: delivered
			.filter(entry => entry.bytes > 0)
			.sort((left, right) => right.bytes - left.bytes)
			.slice(0, ARTIFACT_COPY_LARGEST)
			.map(entry => ({ name: entry.name, bytes: entry.bytes })),
	};
	if (tally.entries > 0) {
		logger.info("Copied a session's artifacts", {
			sourceArtifactsDir,
			destinationArtifactsDir,
			entries: tally.entries,
			bytes: tally.bytes,
			largest: tally.largest,
		});
	}
	return await settle({ tally, discarded: false, reason: undefined });
}

/**
 * The highest `artifact://<n>` any of these entries refers to, or -1.
 *
 * The transcript is the authority on which identifiers a conversation has
 * already used: the directory beside it may have lost files, gained files
 * belonging to someone else, or hold names that are not artifacts at all.
 */
export function highestArtifactReference(entries: readonly SessionEntry[]): number {
	let highest = -1;
	for (const entry of entries) {
		for (const match of JSON.stringify(entry).matchAll(/artifact:\/\/(\d{1,16})\b/g)) {
			const id = Number(match[1]);
			if (Number.isSafeInteger(id) && id > highest) highest = id;
		}
	}
	return highest;
}

/**
 * The subagent output names these entries refer to through `agent://`.
 *
 * Numeric artifact identifiers are not the only thing a fork inherits a claim
 * on: a transcript that cites `agent://Worker` has spent that name, and a
 * subagent handed it again would answer in the original's place.
 */
export function inheritedOutputNames(entries: readonly SessionEntry[]): string[] {
	const names = new Set<string>();
	for (const entry of entries) {
		for (const match of JSON.stringify(entry).matchAll(/agent:\/\/([A-Za-z0-9][\w.-]{0,63})/g)) {
			// A nested child is addressed `parent.child`; the first segment is
			// the only one this session's allocator hands out.
			const first = (match[1] as string).split(".")[0];
			if (first) names.add(first);
		}
	}
	return [...names].sort();
}

/** The numeric id an artifact file name (`<id>.<tool>.log`) carries, if any. */
function artifactIdOf(name: string): string | undefined {
	return /^(\d+)\./.exec(name)?.[1];
}

/**
 * Move one directory entry without replacing anything that has appeared at
 * `to` since the caller listed the destination. `link(2)` refuses an existing
 * target where `rename(2)` would silently overwrite it; where hard links are
 * unavailable an exclusive copy keeps the same guarantee. A directory rename
 * only ever replaces an empty directory, which is harmless.
 */
async function moveEntryWithoutReplacing(from: string, to: string, isDirectory: boolean): Promise<void> {
	if (isDirectory) {
		await fs.promises.rename(from, to);
		return;
	}
	try {
		await fs.promises.link(from, to);
	} catch (err) {
		if (isEexist(err)) throw err;
		await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
	}
	try {
		await fs.promises.unlink(from);
	} catch (err) {
		// The entry has landed; a second copy left behind is not a failed move.
		if (!isEnoent(err)) logger.debug("Artifact placed but its source copy could not be removed", { from, to });
	}
}

/** What `destination` currently holds: entries by name, and the artifact ids (`<id>.<tool>.log`) already in use. */
async function destinationOccupancy(
	destination: string,
): Promise<{ occupants: Map<string, fs.Dirent>; takenIds: Set<string> }> {
	const present = await fs.promises.readdir(destination, { withFileTypes: true });
	const occupants = new Map(present.map(entry => [entry.name, entry]));
	const takenIds = new Set<string>();
	for (const entry of present) {
		const id = artifactIdOf(entry.name);
		if (id !== undefined) takenIds.add(id);
	}
	return { occupants, takenIds };
}

/**
 * Move `source`'s entries into `destination`, recursing into directories that
 * exist on both sides, then remove `source` once it is empty. Nothing at the
 * destination is ever replaced: an entry whose name — or, for `<id>.<tool>.log`
 * artifact files, whose id — is already taken stays at the source, as does one
 * whose move fails. Once moving has begun this never throws, so the caller is
 * never left with a session file rolled back away from artifacts that already
 * moved. Returns the entries left at the source, each with its reason.
 */
async function mergeDirectoryInto(
	source: string,
	destination: string,
	stranded: string[] = [],
	prefix = "",
): Promise<string[]> {
	let { occupants, takenIds } = await destinationOccupancy(destination);
	const strandedBefore = stranded.length;
	for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		const label = prefix + entry.name;
		const id = artifactIdOf(entry.name);
		try {
			// A writer can publish another `<id>.*` file while earlier entries move,
			// and a different file name slips past link(2)'s EEXIST; list again right
			// before an id-bearing move so the check is one syscall old, not the
			// whole merge. Inside the boundary: a failed listing strands this entry
			// like a failed move would, instead of aborting a merge already under way.
			if (id !== undefined) ({ occupants, takenIds } = await destinationOccupancy(destination));
			const occupant = occupants.get(entry.name);
			if (occupant === undefined && (id === undefined || !takenIds.has(id))) {
				if (entry.isDirectory()) {
					try {
						await moveEntryWithoutReplacing(from, to, true);
					} catch (err) {
						if (!isFsError(err) || err.code !== "EXDEV") throw err;
						await fs.promises.mkdir(to);
						await mergeDirectoryInto(from, to, stranded, `${label}/`);
					}
				} else {
					await moveEntryWithoutReplacing(from, to, false);
				}
			} else if (occupant?.isDirectory() && entry.isDirectory()) {
				await mergeDirectoryInto(from, to, stranded, `${label}/`);
			} else {
				stranded.push(`${label} (${occupant === undefined ? "id" : "name"} taken)`);
			}
		} catch (err) {
			// ENOENT: the entry vanished under us (a writer's temp file); nothing to move.
			if (!isEnoent(err)) stranded.push(`${label} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	try {
		await fs.promises.rmdir(source);
	} catch (err) {
		// Still occupied by a collision recorded above, by an entry a writer landed
		// mid-merge, or held open (EBUSY): the directory stays behind.
		if (!isEnoent(err) && (stranded.length === strandedBefore || !isEnotempty(err))) {
			stranded.push(`${prefix || "."} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	return stranded;
}

/**
 * Relocate a session's artifacts directory for {@link SessionManager.moveTo}.
 *
 * The destination may already exist: a session moving back into a bucket it
 * lived in before finds its own `<id>/` there whenever a writer that captured
 * the old path — subagents adopt the parent's `ArtifactManager`, eval
 * subprocesses inherit `PI_ARTIFACTS_DIR` — kept writing after the move away.
 * Renaming onto an existing directory fails with a platform-specific code
 * (ENOTEMPTY, EEXIST, EPERM on Windows), so the fallback is decided by what is
 * there, not by the code: an existing directory is merged into.
 *
 * A name or artifact id taken on both sides is left at the source rather than
 * resolved: artifact ids resolve by `<id>.` prefix against one directory, so
 * overwriting the destination copy or parking a renamed duplicate beside it
 * would each destroy or misdirect a referenced artifact. The copy already at
 * the destination keeps the id; the session's own copy stays at the source,
 * retained on disk under the path the header's `previousSessionFiles` records
 * but not reachable through `artifact://` — two writers that shared one id
 * space cannot both be.
 */
async function relocateArtifactsDirectory(source: string, destination: string): Promise<"renamed" | "merged"> {
	try {
		await fs.promises.rename(source, destination);
		return "renamed";
	} catch (err) {
		// lstat on both sides: a symlink is never merged through, whichever end it
		// is on — the destination's target is not this session's directory, and a
		// symlinked source would have its target's contents moved out from under
		// it. Only a real directory on each side is a merge.
		const [occupant, origin] = await Promise.all([
			fs.promises.lstat(destination).catch((statErr: unknown) => {
				if (isEnoent(statErr)) return null;
				throw err;
			}),
			fs.promises.lstat(source),
		]);
		if (occupant === null && origin.isDirectory() && isFsError(err) && err.code === "EXDEV") {
			await fs.promises.mkdir(destination);
		} else if (occupant === null || !occupant.isDirectory() || !origin.isDirectory()) {
			throw err;
		}
	}
	const stranded = await mergeDirectoryInto(source, destination);
	if (stranded.length > 0) {
		logger.warn("Merged session artifacts into an existing directory; some entries left at source", {
			source,
			destination,
			stranded,
		});
	} else {
		logger.info("Merged session artifacts into an existing directory", { source, destination });
	}
	return "merged";
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
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

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
		subagentCost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "model_usage") return entry.usage;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

/** Complete incomplete assistant usage in loaded history; returns how many messages were repaired. */
function normalizeLoadedUsage(entries: SessionEntry[]): number {
	let repaired = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			repaired++;
		}
	}
	return repaired;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

/**
 * Zero the monetary attribution on one usage record in place, leaving token
 * counts untouched. Cost, credit meters, and premium-request counts describe
 * billing; forks that must not inherit spend (see {@link SessionManager.forkFrom}
 * `resetInheritedCost`) drop them while keeping the tokens compaction relies on.
 */
function resetUsageCost(usage: Usage | undefined): void {
	if (!usage) return;
	usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	usage.credits = undefined;
	usage.premiumRequests = undefined;
}

/** Clear child billing kept in task results without discarding their token counts. */
function resetTaskResultBilling(details: unknown): void {
	if (!isTaskToolDetails(details)) return;
	resetUsageCost(taskUsageFrom(details));
	for (const result of details.results) {
		if (result === null || typeof result !== "object") continue;
		resetUsageCost(taskUsageFrom(result));
		resetNestedTaskBilling(result.extractedToolData);
	}
	const progress = details.progress;
	if (Array.isArray(progress)) {
		for (const item of progress) {
			if (item === null || typeof item !== "object") continue;
			if (typeof item.cost === "number") item.cost = 0;
			resetTaskResultBilling(item.inflightTaskDetails);
			resetNestedTaskBilling(item.extractedToolData);
		}
	}
}

/** Recurse only through task snapshots extracted from the task subprocess tool. */
function resetNestedTaskBilling(extractedToolData: Record<string, unknown[]> | undefined): void {
	const tasks = extractedToolData?.task;
	if (!Array.isArray(tasks)) return;
	for (const task of tasks) resetTaskResultBilling(task);
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state that does not survive as user intent
	// once the draft is cleared. `mode_change` covers the `plan.defaultOnStartup`
	// path (interactive-mode.ts enters plan mode before draft restoration) and
	// `/plan` toggles that leave the session otherwise empty; entries carrying
	// real conversation state — messages, compactions, branch summaries,
	// custom/custom_message, session_init, labels, title/tool selection — never
	// reach this branch and always keep the file resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal.
 */
class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();
	// Branch memo: getBranch() walks leaf-to-root per call (array + Set +
	// reverse) on per-frame/per-turn paths. The branch only changes on
	// insert/rebuild/setLeaf, so cache the array keyed on (leaf, generation).
	// An insert that extends the current leaf appends to the memo in place
	// (O(1)) instead of discarding it. `branchView()` hands the memo out
	// read-only and live: it grows when such an insert lands, while a leaf
	// change or rebuild starts a fresh array (the old one is never mutated).
	#generation = 0;
	#branchCache: { leaf: string | null | undefined; generation: number; branch: SessionEntry[] } | undefined;

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
		this.#generation++;
		this.#branchCache = undefined;
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
		// A captured late-usage leaf can dangle after its target was rolled back or rewritten away.
		if (this.#leaf !== null && !this.#entriesById.has(this.#leaf)) this.setLeaf(lastSelfSelectedLeafId(entries));
	}

	insert(entry: SessionEntry): void {
		const previousLeaf = this.#leaf;
		const isNew = !this.#entriesById.has(entry.id);
		this.#entriesById.set(entry.id, entry);
		// Late usage is physically last but replays to the active leaf captured at append time.
		const nextLeaf = sessionEntryLeafId(entry);
		this.#leaf = nextLeaf;
		this.#generation++;
		const cache = this.#branchCache;
		if (
			isNew &&
			nextLeaf === entry.id &&
			cache !== undefined &&
			cache.generation === this.#generation - 1 &&
			cache.leaf === previousLeaf &&
			entry.parentId === previousLeaf &&
			entry.parentId !== null
		) {
			cache.branch.push(entry);
			cache.leaf = entry.id;
			cache.generation = this.#generation;
		} else {
			this.#branchCache = undefined;
		}

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		const usage = entryUsage(entry);
		addUsage(this.#usage, usage);
		// Completed `task` results carry the child's spend; tracked apart so the
		// status line can split the session's own cost from its subagents'.
		if (usage && entry.type === "message" && entry.message.role === "toolResult") {
			this.#usage.subagentCost += usage.cost.total;
		}
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		if (this.#leaf === id) return;
		this.#leaf = id;
		this.#generation++;
		this.#branchCache = undefined;
	}

	/**
	 * Stop extending the issued branch view in place: the next insert starts a
	 * fresh memo. For inserts whose leaf move is undone right after, which must
	 * not grow a view held by callers.
	 */
	detachBranchView(): void {
		this.#branchCache = undefined;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		// The memoized default-leaf branch stays private — callers may
		// sort/reverse/splice the result (the return type is SessionEntry[]),
		// so hand out a copy. Explicit fromId walks (rare) bypass the cache.
		if (id === undefined || id === this.#leaf) return this.branchView().slice();
		return this.#walk(id);
	}

	/** The memoized active-leaf branch, without copying. Callers MUST NOT mutate it. */
	branchView(): readonly SessionEntry[] {
		const cache = this.#branchCache;
		if (cache !== undefined && cache.generation === this.#generation) return cache.branch;
		const branch = this.#walk(this.#leaf);
		this.#branchCache = { leaf: this.#leaf, generation: this.#generation, branch };
		return branch;
	}

	#walk(leaf: string | null): SessionEntry[] {
		const branch: SessionEntry[] = [];
		// Per-path visited set: a corrupt cyclic parentId chain must stop at
		// the FIRST repeated id (a bare depth cap of `size` still duplicates
		// entries when unrelated entries inflate the index — e.g. a self-cycle
		// plus one unrelated entry yields [entry, entry]).
		const seen = new Set<string>();
		let cursor = leaf ? this.#entriesById.get(leaf) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getRecordedCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "ensureOnDisk"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
>;

interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	expectedDiskSize: number | null;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	fallbackRuntimeOnly: boolean;
	/** Stashed sibling family candidate; moveTo drops it, so a rollback must restore it. */
	taskSiblingCandidate: string | undefined;
	header: SessionHeader;
	entries: SessionEntry[];
	/**
	 * A holder of its own on the session's ownership lease, taken when the
	 * snapshot was made. A rollback adopts it, so the session it names stays
	 * this process's for the whole switch instead of being released and raced
	 * for again; a commit releases it.
	 */
	sessionClaim: SessionClaim | undefined;
}

/**
 * One holder of a session's ownership lease. Releasing is idempotent and
 * leaves the handle visibly unheld, so a handle whose lease was given up
 * elsewhere (a {@link SessionManager.close} during a switch) can never be
 * mistaken for ownership when a rollback adopts it.
 */
class SessionClaim {
	readonly sessionId: string;
	#release: (() => void) | undefined;

	constructor(sessionId: string, release: (() => void) | undefined) {
		this.sessionId = sessionId;
		this.#release = release;
	}

	/** Whether this handle still holds the lease. */
	get held(): boolean {
		return this.#release !== undefined;
	}

	release(): void {
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

/**
 * The state a full-file body was serialized from, cheap to compare against
 * the live state. Entries change only by append, array replacement, or an
 * in-place update announced through `rewriteEntries()` (which bumps the
 * revision); the title slot and header are small and compared by value.
 */
interface SessionBodyStamp {
	entries: readonly SessionEntry[];
	entryCount: number;
	lastEntry: SessionEntry | undefined;
	revision: number;
	/** Serialized title slot and header lines. */
	prefix: string;
}

/**
 * One full-file serialization: title slot, header, and entry lines in file
 * order plus their total UTF-8 byte length. Kept as lines so the file backend
 * streams them instead of materializing one string the size of the session.
 */
interface SessionFileBody {
	lines: string[];
	bytes: number;
	stamp: SessionBodyStamp;
}

/** Whether `text` is exactly the concatenation of `lines`, compared without building it. */
function textMatchesLines(text: string, lines: readonly string[]): boolean {
	let offset = 0;
	for (const line of lines) {
		if (!text.startsWith(line, offset)) return false;
		offset += line.length;
	}
	return offset === text.length;
}

/**
 * The storage may have published a write that rejected, and an authoritative
 * repair could not be proven durable. Callers must fail closed until recovery.
 */
export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

/**
 * This session moved to a new file and keeps saving there. Not a failure:
 * nothing is latched. Delivered through {@link SessionManager.onPersistenceNotice}.
 */
export interface SessionPersistenceNotice {
	/**
	 * `"open-elsewhere"`: another live omp process wrote `from` first and still
	 * has it open, so this process saves its entries elsewhere instead of mixing
	 * them into that file. `"replaced"`: `from` changed on disk and no longer
	 * reads as this session's journal, so it is left untouched. `"contested"`:
	 * a writer without the ownership lease kept changing `from` through every
	 * read-back-and-retry pass, so this session stops racing it.
	 */
	reason: "open-elsewhere" | "replaced" | "contested";
	/** The session file this session was saving to. */
	from: string;
	/** The fresh sibling it saves to from now on: same directory, a new session id whose `parentSession` is the old one. */
	to: string;
	/** The id this session answered to until now; under `"open-elsewhere"` another live process still does. */
	previousSessionId: string;
	/** The id it answers to from now on. */
	sessionId: string;
}

/**
 * Why a session this process just loaded is not its to continue, and what it
 * left behind. Reported by {@link SessionManager.claimResumedSessionOrFork}
 * and by {@link SessionManager.setSessionFile}; the resumed session carries on
 * as a fork of what was loaded either way.
 */
export interface ResumedSessionFork {
	/**
	 * `"owned-elsewhere"`: another live omp process holds the session's
	 * ownership lease, so the id and the file stay with it. `"departed"`: the
	 * transcript says this copy was handed to another machine, so it is stale
	 * whoever holds its lease.
	 */
	reason: "owned-elsewhere" | "departed";
	/** The id of the session that was loaded, which this process no longer answers to. */
	sessionId: string;
	/** The file it was loaded from. */
	sessionFile: string;
}

/**
 * A resume refused because the file it loaded from no longer holds that
 * session: a different journal is there now.
 *
 * Continuing is not offered. The transcript in memory could be written to a
 * file of its own, but nothing beside that path can still be attributed —
 * the artifacts directory next to it is whatever the replacement left there,
 * and a transcript whose `artifact://` references silently resolve to another
 * conversation's files no longer means what it says. A refusal naming both
 * sessions leaves that judgement with the person resuming.
 */
export class SessionSourceReplacedError extends Error {
	/** The path that was resumed. */
	readonly sessionFile: string;
	/** The session that was loaded from it. */
	readonly requestedSessionId: string;
	/** The session whose journal holds that path now. */
	readonly foundSessionId: string;

	constructor(sessionFile: string, requestedSessionId: string, foundSessionId: string) {
		super(
			`Cannot resume session "${requestedSessionId}" from "${sessionFile}": that file now holds session "${foundSessionId}". Nothing was changed; resume the session you want by its own file.`,
		);
		this.name = "SessionSourceReplacedError";
		this.sessionFile = sessionFile;
		this.requestedSessionId = requestedSessionId;
		this.foundSessionId = foundSessionId;
	}
}

/**
 * Thrown by {@link SessionManager.forkFrom} when the fork source is missing.
 * The CLI maps this to a clean session-resolution failure at its own boundary
 * (this module must not import `main.ts`, where `SessionResolutionError` lives).
 */
export class ForkSourceNotFoundError extends Error {
	constructor(sourcePath: string) {
		super(`Session "${sourcePath}" not found.`);
		this.name = "ForkSourceNotFoundError";
	}
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: completed entries
 * (user/assistant/toolResult messages, tool_execution_start markers, custom
 * entries) are handed to the OS synchronously in-body on append and never
 * `fsync`'d. In-flight streaming text is intentionally not durable until
 * `message_end` persists the finished message.
 *
 * While an in-place atomic rewrite is publishing, a concurrent completed append
 * supersedes that publish with a synchronous full-body rewrite so the entry is
 * software-crash durable before the append returns; the abandoned atomic's
 * `commitGuard` then refuses to clobber the fresher body.
 *
 * During {@link moveTo}, appends write a full body to the live relocation path
 * (source until rename, destination once the rename has landed) so a crash mid-
 * move still preserves completed entries without recreating a vacated source.
 * A trailing atomic rewrite still rewrites the header cwd after the path is
 * repointed.
 */
export class SessionManager {
	#cwd: string;
	/** Additional workspace directories beyond cwd (multi-root). Normalized absolute, deduped, excludes cwd. */
	#additionalDirectories: string[] = [];
	#fallbackRuntimeOnly = false;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	/**
	 * Parent-derived sibling family candidate stashed by the Task executor once
	 * the child session exists. Session-scoped and non-persisted: the header
	 * never sees it, and forks, moves, and new-session resets start without it.
	 */
	#taskSiblingCandidate: string | undefined;
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#titleRevision = 0;
	/** Bumped by in-place entry updates, which a {@link SessionBodyStamp} cannot otherwise see. */
	#bodyRevision = 0;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Malformed records the loader skipped for the current session file; reported by `/dump anon`. */
	#loadedMalformedRecords = 0;
	/** Byte length this manager last loaded or durably wrote; `null` means the path was absent. */
	#expectedDiskSize: number | null = null;
	/**
	 * Generation of the latest deferred publish queued on a `defersSyncPublish`
	 * backend. A deferred-rewrite confirmation older than the latest queued
	 * publish is stale (the backend no longer holds its body) and must record
	 * nothing (rvEW).
	 */
	#deferredPublishGen = 0;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/** Sealed by {@link releaseRetainedEntries}: every later append/title/rewrite is a dropped no-op. */
	#released = false;
	/** Set by {@link releaseRetainedEntries}: `#entries` was cleared, so `#serializeBody()` is no longer authoritative. */
	#entriesReleased = false;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** FIFO reservation for atomic batches and authoritative recovery. */
	#atomicPersistenceTail: Promise<void> = Promise.resolve();
	/** Observer notifications withheld until their entries are proven durable. */
	#pendingDurabilityNotifications: SessionEntry[] = [];
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;
	/**
	 * Active {@link moveTo} relocation. Concurrent completed appends write a
	 * full body to the live path: source while it still exists, destination
	 * once rename has landed (source gone). Never recreates a vacated source.
	 * `null` outside an active relocation.
	 */
	#sessionFileRelocating: { source: string; dest: string; copying?: boolean } | null = null;
	/** Atomic entry batch currently staged for a full-file commit. */
	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	/**
	 * The last breadcrumb this manager wrote marked a lazy fresh session whose
	 * JSONL is not yet on disk. Cleared (and the crumb re-stamped non-fresh) once
	 * the session materializes, so a materialized-then-deleted session still falls
	 * back to the most-recent session instead of being treated as a fresh crumb.
	 */
	#breadcrumbFresh = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#persistenceErrorCallbacks = new Set<(error: Error) => void>();
	#persistenceNoticeCallbacks = new Set<(notice: SessionPersistenceNotice) => void>();
	/** Every notice raised so far, replayed to each later subscriber. */
	#persistenceNotices: SessionPersistenceNotice[] = [];
	/**
	 * Moves whose new file no full transcript has been published to yet,
	 * oldest first. A move is announced inside the write that decides it, and
	 * the new file is written after that, asynchronously on some paths.
	 */
	#movesAwaitingWrite: { notice: SessionPersistenceNotice; written: PromiseWithResolvers<boolean> }[] = [];
	/** How each move no longer awaiting its write ended: its file published (`true`), or never. */
	readonly #moveWriteOutcomes = new WeakMap<SessionPersistenceNotice, boolean>();
	/**
	 * This process's ownership claim on the session it last wrote (file storage
	 * only), keyed by session id so every path to the journal meets it. Unheld
	 * while another live process owns the session, and after {@link close} gave
	 * the claim up.
	 */
	#sessionClaim: SessionClaim | undefined;
	/**
	 * One claim per state snapshot that may still be rolled back to, taken in
	 * {@link captureState} and ended by {@link commitSessionSwitch} or
	 * {@link restoreState}.
	 *
	 * Each is a holder of its own on the same lease, so overlapping switches
	 * cannot end each other's: a switch keeps the session it came from until it
	 * knows which one it lives in, and a second switch started inside the first
	 * adds a holder rather than taking one away. Releasing at the switch and
	 * claiming again on rollback would leave exactly the window this branch
	 * exists to close.
	 */
	#snapshotClaims = new Set<SessionClaim>();
	/**
	 * The background artifact copy a move or branch to `sessionFile` started (see
	 * {@link #moveOffSessionFile}, {@link createBranchedSession}). Never rejects.
	 */
	#pendingArtifactCopy: { sessionFile: string; done: Promise<ArtifactCopyOutcome> } | undefined;
	/**
	 * Resolves, once the artifact copy a fork started has finished, to whether
	 * those artifacts reached this session; unset for a session that forked none.
	 */
	#artifactsReproduced: Promise<boolean> | undefined;
	/**
	 * The highest artifact identifier this session's transcript inherited whose
	 * file never arrived. The next allocation starts past it, so a reference the
	 * conversation already carries never comes to name new, unrelated output.
	 */
	#reservedArtifactId: number | undefined;
	/** Why a fork's inherited artifacts never arrived, once its copy has finished. */
	#artifactLossReason: ArtifactCopyOutcome["reason"];
	/** The session this one was forked off, for anything that has to name it later. */
	#forkedFrom: ResumedSessionFork | undefined;
	/** Subagent output names the inherited transcript refers to, which may not be reused. */
	#inheritedOutputNames: readonly string[] = [];

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		// Absolute, so session files (and `PI_SESSION_FILE` in bash and eval) stay
		// valid after a command changes directory: `--session-dir` may be relative.
		this.#sessionDir = sessionDir ? path.resolve(sessionDir) : sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) this.#storage.ensureDirSync(this.#sessionDir);
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		this.#breadcrumbFresh = fresh;
		if (this.#suppressBreadcrumb) return;
		writeTerminalBreadcrumb(cwd, sessionFile, fresh, {
			remoteStorage: !(this.#storage instanceof FileSessionStorage),
		});
	}

	/**
	 * Re-stamp a fresh-session breadcrumb as non-fresh once the session has
	 * materialized on disk. A no-op unless the current breadcrumb is still fresh.
	 */
	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	/**
	 * Deliver one failure or notice to a single observer. Observer failures are
	 * swallowed: a host surface that throws must not corrupt session teardown.
	 */
	#invokePersistenceObserver<T>(observer: (value: T) => void, value: T): void {
		try {
			observer(value);
		} catch (callbackError) {
			logger.warn("Session persistence observer failed", {
				error: toError(callbackError).message,
			});
		}
	}

	#notifyPersistenceErrorObservers(error: Error): void {
		for (const observer of this.#persistenceErrorCallbacks) this.#invokePersistenceObserver(observer, error);
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;
		// A line that failed to land leaves its blob refs unreferenced on disk,
		// so the next persist must re-check those blobs instead of trusting the memo.
		forgetExternalizedImages(this.#blobs);

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			this.#notifyPersistenceErrorObservers(error);
		}

		return this.#diskFailure;
	}

	#notifyPersistenceNotice(notice: SessionPersistenceNotice): void {
		logger.warn("Session moved to a new file", { ...notice });
		this.#persistenceNotices.push(notice);
		for (const observer of this.#persistenceNoticeCallbacks) this.#invokePersistenceObserver(observer, notice);
	}

	/**
	 * Hold this process's ownership claim on `#sessionId`, moving it off a
	 * previous session. Write paths claim, and so does the resume guard
	 * ({@link claimResumedSessionOrFork}) for the session this process is about
	 * to live in, so the first process to resume or write a session owns it and
	 * inspection (`omp share`, `--export`, `render`) never does. A failed claim
	 * is retried on the next write, so a writer takes over once the owner
	 * closed the session or exited.
	 */
	#claimSession(): void {
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		if (!this.#persist || !sessionFile || !this.#storage.claimSession) return;
		const current = this.#sessionClaim;
		if (current?.sessionId === sessionId && current.held) return;
		if (current && current.sessionId !== sessionId) current.release();
		// The storage also checks that the path still holds this session: if
		// another session was moved onto it, the claim fails and the next write
		// moves this session to a sibling instead of appending into that journal.
		this.#sessionClaim = new SessionClaim(sessionId, this.#storage.claimSession(sessionId, sessionFile) ?? undefined);
	}

	/**
	 * A second holder of the current session's lease for a state snapshot, so a
	 * rollback to it takes the session back without ever letting go of it.
	 * `undefined` when this manager does not own the session to begin with.
	 */
	#retainOwnershipForSnapshot(): SessionClaim | undefined {
		const claim = this.#sessionClaim;
		const sessionFile = this.#sessionFile;
		if (!claim?.held || !this.#persist || !sessionFile || !this.#storage.claimSession) return undefined;
		const release = this.#storage.claimSession(claim.sessionId, sessionFile);
		if (!release) return undefined;
		const retained = new SessionClaim(claim.sessionId, release);
		this.#snapshotClaims.add(retained);
		return retained;
	}

	/**
	 * Whether another live omp process owns this session, claiming it first
	 * when it is free. A non-owner never writes the session's file: its next
	 * write moves this session to a sibling with a new id instead, so two
	 * processes never mix their entries in one journal and the owner's full
	 * rewrites never race the other process's appends.
	 */
	#sessionOwnedElsewhere(): boolean {
		if (this.#released || this.#sessionFileRelocating) return false;
		this.#claimSession();
		const claim = this.#sessionClaim;
		return claim !== undefined && claim.sessionId === this.#sessionId && !claim.held;
	}

	/**
	 * `#sessionFile` when `error` reports that it changed since this manager
	 * last wrote it, which the caller can recover from; `undefined` reports the
	 * conflict as before. A fresh file that already exists is never recovered,
	 * so a colliding sibling cannot move again. Backends that defer sync
	 * publishes also report as before: there a conflict can be this manager
	 * racing its own unconfirmed publish, not another writer.
	 */
	#conflictedSessionFile(error: unknown): string | undefined {
		const sessionFile = this.#sessionFile;
		if (
			!(error instanceof SessionWriteConflictError) ||
			error.expectedSize === null ||
			!sessionFile ||
			path.resolve(error.path) !== path.resolve(sessionFile) ||
			!this.#persist ||
			this.#released ||
			this.#sessionFileRelocating ||
			this.#storage.defersSyncPublish
		) {
			return undefined;
		}
		return sessionFile;
	}

	/** The entries `content` holds that this manager does not, or `undefined` when it is not this session's journal. */
	#foreignEntriesIn(content: string): SessionEntry[] | undefined {
		const { entries, invalidHeader } = parseSessionContent(content);
		const header = entries[0];
		if (invalidHeader || header?.type !== "session" || header.id !== this.#sessionId) return undefined;
		const foreign: SessionEntry[] = [];
		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as SessionEntry;
			if (!this.#index.has(entry.id)) foreign.push(entry);
		}
		return foreign;
	}

	/**
	 * Keep the entries another writer added to `#sessionFile`, whose bytes now
	 * measure `diskSize`. They join this session's tree as a side branch (their
	 * parents are entries both writers loaded), the active leaf stays this
	 * session's, and the retried rewrite republishes them with the rest.
	 */
	#adoptForeignEntries(foreign: readonly SessionEntry[], diskSize: number): void {
		const leaf = this.#index.leafId();
		let adopted = 0;
		for (const entry of foreign) {
			// A recovery that raced this one may already have kept it.
			if (this.#index.has(entry.id)) continue;
			this.#entries.push(entry);
			this.#index.insert(entry);
			adopted++;
		}
		this.#index.setLeaf(leaf);
		this.#expectedDiskSize = diskSize;
		if (adopted > 0)
			logger.warn("Kept session entries another writer added", { sessionFile: this.#sessionFile, adopted });
	}

	/**
	 * A synchronous full rewrite of `#sessionFile` met bytes this manager did
	 * not write: usually a writer without the ownership lease (an older omp,
	 * an external tool) appending to the file this process owns. Overwriting
	 * would erase those entries and retrying blindly can never succeed, so read
	 * the file back, keep its new entries, and retry against the size just read.
	 * A deleted file is recreated; a file that no longer reads as this session
	 * is left untouched and the session moves to a sibling.
	 *
	 * After {@link MAX_WRITE_CONFLICT_RECOVERIES} passes (`recoveries`) the
	 * other writer is still racing every read-to-publish window: leave the file
	 * to it and move to a sibling rather than re-serializing on every write.
	 *
	 * Returns the path to retry, or `undefined` to report the conflict as before.
	 */
	#recoverFromWriteConflictSync(error: unknown, recoveries: number): string | undefined {
		const contested = this.#conflictedSessionFile(error);
		if (!contested) return undefined;
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		if (!this.#storage.readTextSync) return undefined;
		let content: string;
		try {
			content = this.#storage.readTextSync(contested);
		} catch (readError) {
			if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
			this.#expectedDiskSize = null;
			return contested;
		}
		const foreign = this.#foreignEntriesIn(content);
		if (!foreign) return this.#moveOffSessionFile("replaced");
		resolveBlobRefsInEntriesSync(foreign, this.#blobs);
		this.#adoptForeignEntries(foreign, Buffer.byteLength(content, "utf8"));
		return contested;
	}

	/** Asynchronous {@link #recoverFromWriteConflictSync}. */
	async #recoverFromWriteConflict(error: unknown, recoveries: number): Promise<string | undefined> {
		const contested = this.#conflictedSessionFile(error);
		if (!contested) return undefined;
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		const epoch = this.#diskEpoch;
		let content: string;
		try {
			content = await this.#storage.readText(contested);
		} catch (readError) {
			// A synchronous rewrite during the read already recovered; retry against its result.
			if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
			if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
			this.#expectedDiskSize = null;
			return contested;
		}
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		const foreign = this.#foreignEntriesIn(content);
		if (!foreign) return this.#moveOffSessionFile("replaced");
		await resolveBlobRefsInEntries(foreign, this.#blobs);
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		this.#adoptForeignEntries(foreign, Buffer.byteLength(content, "utf8"));
		return contested;
	}

	/**
	 * Why the session just loaded is not this process's to continue, or
	 * `undefined` when it is — in which case this process now holds its
	 * ownership claim and keeps it, so a later resume elsewhere meets an owner
	 * rather than a free lease.
	 *
	 * The lease alone cannot answer this: `claimSession` refuses both a live
	 * owner and a path that now holds a different session's journal, and it
	 * re-reads the header itself when it is asked. The journal is read before
	 * the claim, because a session that is no longer at this path may still be
	 * running somewhere else under the lease this would otherwise take; and a
	 * refused claim is read *again* afterwards, because a replacement that
	 * lands in between is what the storage saw and what makes it refuse —
	 * reported as a replacement rather than mistaken for a live owner.
	 */
	async #resumedSessionContention(staleCopy: boolean): Promise<ResumedSessionFork["reason"] | undefined> {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return undefined;
		await this.#refuseWhenSourceReplaced(sessionFile);
		if (staleCopy) return "departed";
		if (!this.#sessionOwnedElsewhere()) return undefined;
		await this.#refuseWhenSourceReplaced(sessionFile);
		return "owned-elsewhere";
	}

	/** Refuse a resume whose file stopped holding the session that was loaded from it. */
	async #refuseWhenSourceReplaced(sessionFile: string): Promise<void> {
		const onDisk = await readSessionHeaderId(sessionFile);
		if (onDisk !== undefined && onDisk !== this.#sessionId) {
			throw new SessionSourceReplacedError(sessionFile, this.#sessionId, onDisk);
		}
	}

	/**
	 * Leave the session just loaded where it is — with the live process that
	 * owns it, or as the stale copy of a conversation that moved away — and
	 * carry on as a fork of it: a new id in a sibling file whose header points
	 * back through `parentSession` only. No `continuationOf`, unlike
	 * {@link #moveOffSessionFile}: the session left behind may still be running
	 * under its own id, so a later resume of that file must land on it and not
	 * follow this copy.
	 *
	 * The fork carries the transcript that was loaded, never a re-read of the
	 * file. Its artifacts are copied in the background, as every other fork and
	 * move copies them: the caller has already proved the journal still holds
	 * the session being forked, and waiting for the copy instead costs half a
	 * minute of unusable startup on an ordinary half-gigabyte artifacts
	 * directory — measured at 33 s for 512 MiB in 8,192 files.
	 *
	 * What the wait bought was the ability to *refuse* a resume whose source
	 * was replaced during the copy. That refusal is given up here, and
	 * deliberately not called equivalent: the copy still takes itself back when
	 * its source stops being the session it was copied for, so nothing foreign
	 * is ever inherited, and {@link artifactsReproduced} lets the caller say so
	 * in the transcript instead of letting the loss pass unmentioned.
	 *
	 * An unfinished tool call at the tip is paired with a result that says the
	 * outcome is unknown, as an explicit fork does: the session this forked
	 * from may be running that tool right now, and a dangling call would
	 * otherwise be stripped from the model's context without a trace.
	 *
	 * Called while the transcript is being adopted, before anything has
	 * published the loaded id, so nothing outside ever sees this process answer
	 * to the owner's session. Returns what was left behind.
	 */
	#adoptLoadedSessionAsFork(reason: ResumedSessionFork["reason"], sessionDir?: string): ResumedSessionFork {
		const from = this.#sessionFile as string;
		const previousSessionId = this.#sessionId;
		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		const to = path.join(
			sessionDir ?? path.dirname(from),
			`${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`,
		);
		const {
			type: _type,
			id: _id,
			timestamp: _timestamp,
			parentSession: _parent,
			continuationOf: _of,
			...carried
		} = this.#header;
		this.#header = {
			type: "session",
			id: this.#sessionId,
			timestamp,
			parentSession: previousSessionId,
			...carried,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
		};
		SessionManager.#repairForkedInterruptedTail(this.#entries, this.#index.pathTo());
		this.#index.rebuild(this.#entries);
		this.#closeWriterEventually();
		this.#sessionFile = to;
		this.#expectedDiskSize = null;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		// Read from the transcript this fork carries, not from the directory
		// being copied: those are the identifiers the conversation actually
		// refers to, they are all of them even when the source no longer holds
		// the files, and nothing else in that directory can inflate them.
		const inherited = highestArtifactReference(this.#entries);
		const inheritedNames = inheritedOutputNames(this.#entries);
		const done = copySessionArtifacts(from, to, {
			stillTheSource: async () => (await readSessionHeaderId(from)) === previousSessionId,
			// Part of the copy, not a follow-up to it: an allocator that waited
			// for the directory must not start its scan before the names this
			// transcript has already spent are recorded beside the files.
			onSettled: () => this.#recordReservedClaims(to),
		});
		this.#pendingArtifactCopy = { sessionFile: to, done };
		this.#inheritedOutputNames = inheritedNames;
		// Taken at the fork, not when a copy reports a loss: a copy can arrive
		// successfully and still be missing a file the transcript refers to —
		// one the source lost before the walk reached it — and that reference
		// is just as reusable as one a discard lost. What the copy does bring
		// is in the directory, where the scan finds it anyway.
		this.#reserveInheritedArtifacts(inherited, inheritedNames);
		this.#artifactsReproduced = done.then(outcome => {
			this.#artifactLossReason = outcome.reason;
			return !outcome.discarded;
		});
		this.#rememberBreadcrumb(this.#cwd, to);
		this.#claimSession();
		logger.info(
			reason === "owned-elsewhere"
				? "Resumed a session another omp process owns; continuing in a fork"
				: "Resumed a copy of a session that moved away; continuing in a fork",
			{ source: from, sessionId: previousSessionId, fork: to },
		);
		this.#forkedFrom = { reason, sessionId: previousSessionId, sessionFile: from };
		return this.#forkedFrom;
	}

	/**
	 * Keep the identifiers an inherited transcript refers to out of this
	 * session's allocator, and record that in the header so a reopen, and
	 * anything forked from here, keeps the same promise.
	 */
	#reserveInheritedArtifacts(throughId: number, names: readonly string[], options?: { rewrite?: boolean }): void {
		if (throughId < 0 && names.length === 0) return;
		if (throughId >= 0 && (this.#reservedArtifactId ?? -1) < throughId) {
			this.#reservedArtifactId = throughId;
			this.#header.reservedArtifactId = throughId;
		}
		if (names.length > 0) {
			const kept = new Set([...(this.#header.reservedOutputNames ?? []), ...this.#inheritedOutputNames, ...names]);
			this.#header.reservedOutputNames = [...kept].sort();
			this.#inheritedOutputNames = this.#header.reservedOutputNames;
		}
		// The header carries it from here: every rewrite persists it, a reopen
		// reads it back, and a fork of this session takes it along. A rewrite
		// that fails is a disk failure like any other and is reported as one,
		// rather than leaving a promise that only this process remembers. A
		// session still being built writes its header itself and needs none.
		if (options?.rewrite === false || !this.#persist || !this.#sessionFile) return;
		this.#rewriteRequired = true;
		void this.#scheduleDiskWork(async () => {
			await this.#rewriteAtomically();
		});
	}

	/**
	 * Leave the claims this transcript has already spent beside its artifacts,
	 * where anything holding only the directory can read them.
	 *
	 * The header answers for the session manager, but a subagent's output
	 * allocator and any other reader of that directory have no header to
	 * consult — and a name whose file never arrived is invisible to a scan of
	 * what is there.
	 */
	async #recordReservedClaims(sessionFile?: string): Promise<void> {
		const dir = sessionFile ? artifactsDirectoryFor(sessionFile) : this.getArtifactsDir();
		const throughId = this.#reservedArtifactId ?? -1;
		const names = this.#inheritedOutputNames;
		if (!dir || (throughId < 0 && names.length === 0)) return;
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			await fs.promises.writeFile(path.join(dir, RESERVED_CLAIMS_FILE), JSON.stringify({ throughId, names }), {
				mode: 0o600,
			});
		} catch (error) {
			// A claim nothing can read is a claim that will be broken, so this
			// is a persistence failure like any other: observers hear it now,
			// `flush()` raises it for whoever asks later, and a subscriber that
			// arrives after the fact still finds it.
			this.#noteDiskFailure(
				new Error(`Failed to record reserved artifact claims in ${dir}: ${toError(error).message}`),
			);
		}
	}

	/**
	 * Settles once any artifact copy this session is waiting on has finished,
	 * one way or the other.
	 *
	 * Every reader of the artifacts directory needs this, not just
	 * {@link ArtifactManager}: the public `artifact://` handler goes to the
	 * filesystem itself, and a read that lands mid-copy would otherwise see a
	 * directory that is not yet this session's.
	 */
	async whenArtifactsSettled(signal?: AbortSignal): Promise<void> {
		const pending = this.#pendingArtifactCopy?.done;
		if (!pending) return;
		if (signal) await Promise.race([pending, abortRejection(signal)]);
		else await pending;
	}

	/**
	 * Whether the artifacts of the session this one forked from reached it, once
	 * their copy has finished: `false` when the copy took itself back because
	 * its source stopped being that session. `true` for a session that forked
	 * nothing.
	 */
	async artifactsReproduced(): Promise<boolean> {
		return (await this.#artifactsReproduced) ?? true;
	}

	/**
	 * The highest artifact identifier this session inherited but never received
	 * a file for, once {@link artifactsReproduced} has answered `false`. Those
	 * identifiers are never handed out again, so a reference the transcript
	 * already carries cannot come to name later, unrelated output.
	 */
	reservedArtifactId(): number | undefined {
		return this.#reservedArtifactId;
	}

	/**
	 * Subagent output names this session's transcript already refers to and
	 * has no file for. A new subagent handed one of these would answer for
	 * `agent://<name>` references the conversation already made.
	 */
	reservedOutputNames(): readonly string[] {
		return this.#inheritedOutputNames;
	}

	/**
	 * Why a fork's inherited artifacts never arrived, once
	 * {@link artifactsReproduced} has answered `false`. A source that stopped
	 * being the session it was copied for and a copy that simply could not be
	 * finished leave the files in very different places, and only the first is
	 * a reason to say they belong to another conversation now.
	 */
	artifactLossReason(): ArtifactCopyOutcome["reason"] {
		return this.#artifactLossReason;
	}

	/** The session this one was forked off at its resume, if it was. */
	forkedFromSession(): ResumedSessionFork | undefined {
		return this.#forkedFrom;
	}

	/**
	 * Leave `#sessionFile` untouched and continue as a fresh session in a
	 * sibling file. It gets a new session id whose header points back through
	 * `parentSession` and keeps the provider prompt-cache key, as {@link fork}
	 * does, so resume-by-id, the title index, and the picker never see two
	 * files for one id. Unlike a fork it also records `continuationOf`, so a
	 * later resume of the old file follows the conversation here (see
	 * `findSessionContinuation`). Nothing durable exists there yet: the caller
	 * publishes the whole transcript once and appends incrementally after that.
	 *
	 * The artifact copy runs in the background so a move never blocks the turn
	 * loop on a large artifacts directory; the sibling's artifact manager waits
	 * for it before scanning ids or resolving `artifact://`, and flush/close
	 * await it. Returns the sibling.
	 */
	#moveOffSessionFile(reason: SessionPersistenceNotice["reason"]): string {
		const from = this.#sessionFile as string;
		const previousSessionId = this.#sessionId;
		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		const to = path.join(path.dirname(from), `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		// The marker goes before the carried-over fields: the session listing
		// reads only the first 4 KB of a file, and a header grows with them.
		const {
			type: _type,
			id: _id,
			timestamp: _timestamp,
			parentSession: _parent,
			continuationOf: _of,
			...carried
		} = this.#header;
		this.#header = {
			type: "session",
			id: this.#sessionId,
			timestamp,
			parentSession: previousSessionId,
			continuationOf: previousSessionId,
			...carried,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
		};
		this.#closeWriterEventually();
		this.#sessionFile = to;
		this.#expectedDiskSize = null;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#pendingArtifactCopy = { sessionFile: to, done: copySessionArtifacts(from, to) };
		this.#rememberBreadcrumb(this.#cwd, to);
		this.#claimSession();
		const notice: SessionPersistenceNotice = { reason, from, to, previousSessionId, sessionId: this.#sessionId };
		this.#movesAwaitingWrite.push({ notice, written: Promise.withResolvers<boolean>() });
		this.#notifyPersistenceNotice(notice);
		return to;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		forgetExternalizedImages(this.#blobs);
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
			this.#notifyPersistenceErrorObservers(error);
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (this.#released) {
			// Terminal seal: repair would reset the disk tail (escaping the
			// close() serialization) and atomically publish #serializeBody() — after
			// release that truncates, and a revival may already own the file.
			// The original operation error still propagates to the caller.
			logger.warn("Skipped authoritative session repair after terminal release", {
				error: String(operationError),
			});
			return;
		}
		if (!this.#persist || !this.#sessionFile) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain();
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				await this.#publishAuthoritativeBody(
					sessionFile,
					operationError,
					() => !this.#released && this.#diskEpoch === epoch,
				);
				if (this.#diskEpoch !== epoch) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Authoritative session repair was superseded before verification."),
					]);
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	/**
	 * Publish the current in-memory journal as `sessionFile`'s authoritative
	 * body, tolerating a write whose own acknowledgment failed but that
	 * landed anyway: a readback matching the intended body still counts as
	 * durable. Callers own serialization (the disk queue) and any
	 * `#released`/epoch guard; this only writes and repairs
	 * `#expectedDiskSize` bookkeeping via {@link #recordFullRewrite}.
	 */
	async #publishAuthoritativeBody(
		sessionFile: string,
		operationError: Error,
		commitGuard?: () => boolean,
		recoveries = 0,
	): Promise<void> {
		const target =
			sessionFile === this.#sessionFile && this.#sessionOwnedElsewhere()
				? this.#moveOffSessionFile("open-elsewhere")
				: sessionFile;
		const body = this.#serializeBody();
		const options = { expectedSize: this.#expectedDiskSize, commitGuard };
		try {
			await (this.#storage.writeLinesAtomic
				? this.#storage.writeLinesAtomic(target, body.lines, options)
				: this.#storage.writeTextAtomic(target, body.lines.join(""), options));
		} catch (error) {
			const retryPath = await this.#recoverFromWriteConflict(error, recoveries);
			if (retryPath) return this.#publishAuthoritativeBody(retryPath, operationError, commitGuard, recoveries + 1);
			const recoveryErrors = [toError(error)];
			try {
				await this.#storage.drain();
			} catch (drainFailure) {
				recoveryErrors.push(toError(drainFailure));
			}
			let actual: string;
			try {
				actual = await this.#storage.readText(target);
			} catch (readFailure) {
				recoveryErrors.push(toError(readFailure));
				throw this.#latchIndeterminate(operationError, recoveryErrors);
			}
			if (!textMatchesLines(actual, body.lines)) {
				recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
				throw this.#latchIndeterminate(operationError, recoveryErrors);
			}
		}
		this.#recordFullRewrite(target, body.bytes);
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#lineFor(entry: FileEntry): string {
		return `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
	}
	#recordDurableAppend(line: string): void {
		this.#expectedDiskSize = (this.#expectedDiskSize ?? 0) + Buffer.byteLength(line, "utf8");
	}

	/**
	 * A full transcript is durable at `target`. That settles every move up to
	 * the last one to `target`: an earlier move whose file was never written
	 * because the session moved on again counts as written with it.
	 */
	#recordFullRewrite(target: string, bytes: number): void {
		this.#expectedDiskSize = bytes;
		const published = path.resolve(target);
		const last = this.#movesAwaitingWrite.findLastIndex(move => path.resolve(move.notice.to) === published);
		for (const move of this.#movesAwaitingWrite.splice(0, last + 1)) this.#settleMoveWrite(move, true);
	}

	#settleMoveWrite(
		move: { notice: SessionPersistenceNotice; written: PromiseWithResolvers<boolean> },
		written: boolean,
	): void {
		this.#moveWriteOutcomes.set(move.notice, written);
		move.written.resolve(written);
	}

	/**
	 * Whether the move `notice` reports has a durable new file: `true` once a
	 * full transcript has been published there (or to the file a later move
	 * went to), `false` when this manager stopped writing first ({@link seal})
	 * or `notice` is not one of its moves, and `undefined` while that write is
	 * still to come. A move is announced before it, so a subscriber that must
	 * not act before the new file exists waits with {@link whenMoveWritten}.
	 */
	moveWritten(notice: SessionPersistenceNotice): boolean | undefined {
		if (this.#movesAwaitingWrite.some(move => move.notice === notice)) return undefined;
		return this.#moveWriteOutcomes.get(notice) ?? false;
	}

	/** Settles with {@link moveWritten}'s answer once that is no longer `undefined`. */
	whenMoveWritten(notice: SessionPersistenceNotice): Promise<boolean> {
		const pending = this.#movesAwaitingWrite.find(move => move.notice === notice);
		if (pending) return pending.written.promise;
		return Promise.resolve(this.#moveWriteOutcomes.get(notice) ?? false);
	}

	/**
	 * Confirm a publish the backend only queued. The manager's durability state
	 * (durable size, current-marking) advances only here, never at queue time:
	 * until the store confirms, the record still describes the last confirmed
	 * publish. A rejected publish is realigned with the size the store actually
	 * holds and latched, so the next append retries the transcript instead of
	 * reusing an `expectedSize` the backend never reached.
	 *
	 * `onConfirm` runs only once the backend confirms the queued publish. A
	 * deferred rewrite must neither record the replacement nor mark the manager
	 * current before then (hV-oB): an append racing the unconfirmed publish
	 * would otherwise take the hot path and land a bare append on a body the
	 * backend may still reject, inflating the CAS token past anything durable.
	 * A rewrite racing it instead carries the last confirmed token, which the
	 * store's queue-time size check fail-fasts before a second provisional
	 * publish can queue behind the unconfirmed one.
	 */
	#confirmDeferredPublish(sessionFile: string, onConfirm?: () => void): void {
		const confirmed = this.#storage.confirmWrites?.(sessionFile);
		if (!confirmed) return;
		void confirmed
			.then(() => {
				onConfirm?.();
			})
			.catch(err => {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				try {
					this.#expectedDiskSize = this.#storage.existsSync(sessionFile)
						? this.#storage.statSync(sessionFile).size
						: null;
				} catch {
					// Backend unreadable: leave the record for the next write to re-establish.
				}
				this.#noteDiskFailure(err);
			});
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	/** Serialize the whole file — title slot, header, entries — as lines, stamped with the state they came from. */
	#serializeBody(): SessionFileBody {
		const titleLine = this.#titleSlotLine();
		const headerLine = this.#lineFor(this.#header);
		const entries = this.#entries;
		const lines = [titleLine, headerLine];
		let bytes = Buffer.byteLength(titleLine, "utf8") + Buffer.byteLength(headerLine, "utf8");
		for (const entry of entries) {
			const line = this.#lineFor(entry);
			bytes += Buffer.byteLength(line, "utf8");
			lines.push(line);
		}
		const stamp: SessionBodyStamp = {
			entries,
			entryCount: entries.length,
			lastEntry: entries.at(-1),
			revision: this.#bodyRevision,
			prefix: titleLine + headerLine,
		};
		return { lines, bytes, stamp };
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Live path for concurrent completed appends during {@link moveTo}.
	 * Prefers destination once rename has landed (source gone); otherwise
	 * source. Never invents a path that does not already exist.
	 */
	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		if (relocating.copying && this.#storage.existsSync(relocating.source)) return relocating.source;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;
		// Rename in flight with neither path visible (rare cross-device edge):
		// fall back to destination so we do not recreate a vacated source.
		return relocating.dest;
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * During {@link moveTo}, writes to the live relocation path (source pre-
	 * rename, destination post-rename) rather than always `#sessionFile`, so
	 * concurrent completed entries are durable without recreating a vacated source.
	 */
	#rewriteSynchronously(): void {
		if (this.#released) return;
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		let targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;

		try {
			if (this.#sessionOwnedElsewhere()) targetPath = this.#moveOffSessionFile("open-elsewhere");
			let body = this.#serializeBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			for (let recoveries = 0; ; recoveries++) {
				try {
					const options = { expectedSize: this.#expectedDiskSize };
					if (this.#storage.writeLinesSync) this.#storage.writeLinesSync(targetPath, body.lines, options);
					else this.#storage.writeTextSync(targetPath, body.lines.join(""), options);
					break;
				} catch (err) {
					const retryPath = this.#recoverFromWriteConflictSync(err, recoveries);
					if (!retryPath) throw err;
					targetPath = retryPath;
					body = this.#serializeBody();
				}
			}
			this.#clearDiskError();
			if (this.#storage.defersSyncPublish) {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				// The publish is only queued: record nothing and stay non-current
				// until the backend confirms (hV-oB). A racing rewrite still
				// carries the last confirmed token, so the store's queue-time
				// size check fail-fasts it instead of queueing a second
				// provisional publish behind the unconfirmed one; a racing
				// append retries the transcript on the cold path instead of
				// landing a bare append on a body the backend may still reject.
				// The success handler below is the single place the replacement
				// becomes durable state.
				const generation = ++this.#deferredPublishGen;
				const { bytes, stamp } = body;
				const publishedPath = targetPath;
				this.#confirmDeferredPublish(publishedPath, () => {
					// A newer deferred publish owns the durability record now;
					// this body is no longer on the backend, so record nothing.
					if (generation !== this.#deferredPublishGen) return;
					this.#recordFullRewrite(publishedPath, bytes);
					const entries = this.#entries;
					const bodyIsCurrent =
						stamp.entries === entries &&
						stamp.entryCount === entries.length &&
						stamp.lastEntry === entries.at(-1) &&
						stamp.revision === this.#bodyRevision &&
						stamp.prefix === this.#titleSlotLine() + this.#lineFor(this.#header);
					if (!bodyIsCurrent) {
						// Entries raced the unconfirmed publish: the confirmed
						// body predates them. Stay non-current and re-issue the
						// full transcript instead of declaring it durable
						// (rvEW); the re-issued publish carries the
						// just-confirmed size token, so its queue-time check
						// passes.
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						this.#rewriteSynchronously();
						return;
					}
					if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
						this.#fileIsCurrent = true;
						this.#materializeBreadcrumb();
						this.#rewriteRequired = false;
						this.#hasTitleSlot = true;
					}
				});
				return;
			}
			this.#recordFullRewrite(targetPath, body.bytes);
			// Only mark the manager current when writing the active session path.
			// Mid-move writes update the live relocation path; `#sessionFile` is
			// still the pre-repoint source until moveTo repoints it.
			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#rewriteRequired = false;
				this.#hasTitleSlot = true;
			} else {
				// Destination body is current on disk; in-memory still needs a
				// header-cwd rewrite after repoint, but entries are durable.
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran.
	 */
	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#released) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	/**
	 * Shared fenced atomic-rewrite loop used by `#rewriteAtomically` and the
	 * `#persistTitleChangeEntry` fallback. Holds `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Returns `false` when the disk epoch
	 * moved so callers skip current-marking updates; a body that landed before
	 * that change still advances the durable byte record after readback.
	 */
	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		if (this.#released) return false;
		this.#atomicRewriteFenceEpoch = epoch;
		let recoveries = 0;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				if (this.#sessionOwnedElsewhere()) this.#moveOffSessionFile("open-elsewhere");
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				const body = this.#serializeBody();
				const options = {
					expectedSize: this.#expectedDiskSize,
					commitGuard: () => !this.#released && this.#diskEpoch === epoch,
				};
				try {
					await (this.#storage.writeLinesAtomic
						? this.#storage.writeLinesAtomic(sessionFile, body.lines, options)
						: this.#storage.writeTextAtomic(sessionFile, body.lines.join(""), options));
				} catch (error) {
					if (await this.#recoverFromWriteConflict(error, recoveries)) {
						recoveries++;
						// Publish the whole transcript against what the recovery found on the next pass.
						this.#atomicRewriteDirty = true;
						continue;
					}
					try {
						if (textMatchesLines(await this.#storage.readText(sessionFile), body.lines)) {
							this.#recordFullRewrite(sessionFile, body.bytes);
						}
					} catch {
						// Preserve the publish error when durable state cannot be read back.
					}
					throw error;
				}
				if (this.#diskEpoch !== epoch) {
					try {
						if (textMatchesLines(await this.#storage.readText(sessionFile), body.lines)) {
							this.#recordFullRewrite(sessionFile, body.bytes);
						}
					} catch {
						// A superseding rewrite owns the durability record when its body cannot be read back.
					}
					return false;
				}
				this.#recordFullRewrite(sessionFile, body.bytes);
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (this.#released || !this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (this.#diskFailure) {
			// The failed entry and any later entries remain in memory. A full
			// replacement is the writability probe and restores all of them once
			// transient storage pressure clears.
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
		}

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// The first durable entry after draft consumption races the old manager's
		// close-time GC. Serialize that one transition with the GC; once any
		// durable entry exists, later appends cannot satisfy its delete predicate.
		if (
			this.#storage.withSessionFileLockSync &&
			this.#draftOnlySessionCleanupArmed &&
			!isDraftOnlyMetadataEntry(entry) &&
			this.#entries.every(candidate => candidate === entry || isDraftOnlyMetadataEntry(candidate))
		) {
			try {
				this.#storage.withSessionFileLockSync(this.#sessionFile, () => this.#appendToCurrentSessionFile(entry));
			} catch (err) {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#noteDiskFailure(err);
			}
			return;
		}
		this.#appendToCurrentSessionFile(entry);
	}

	#appendToCurrentSessionFile(entry: SessionEntry): void {
		// Atomic replacement / move window: do not open a fresh append writer that
		// a Windows EPERM replace could detach from the current JSONL path.
		// - moveTo: write a full body to the live relocation path (source pre-
		//   rename, destination post-rename) so completed entries are durable
		//   without recreating a vacated source.
		// - in-place atomic fence: supersede the pending publish with a
		//   synchronous full-body rewrite; bumping `#diskEpoch` abandons the
		//   in-flight atomic via its `commitGuard`.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously();
			return;
		}
		// Cold/divergent: not on disk yet, in-memory entries diverged from the
		// file, or another live process owns it → rewrite the whole file
		// synchronously (to a sibling in the last case) and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired || this.#sessionOwnedElsewhere()) {
			this.#rewriteSynchronously();
			return;
		}

		// Hot path: write the entry directly on the writer, outside the async disk
		// chain. Prefer appendSync so write failures latch `#diskFailure` before
		// this call returns (not via a discarded rejected Promise after a later
		// microtask). Callers stay non-throwing here — the core turn loop invokes
		// appendMessage/appendCustomEntry without try/catch. A later entry retries
		// all in-memory state through a full rewrite. File writers apply each line
		// to the OS page cache before return.
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		try {
			const writer = this.#appendWriter();
			const line = this.#lineFor(entry);
			if (writer.appendSync && !this.#storage.defersSyncPublish) {
				writer.appendSync(line);
				this.#recordDurableAppend(line);
			} else {
				// A backend that only queues the publish (indexed) has no synchronous
				// durability, so the durable size may advance only once it confirms
				// the line: a lost publish must not leave the record describing bytes
				// the store never accepted, or the next recovery rewrite hands the
				// backend CAS an impossible `expectedSize`.
				if (writer.appendSync) writer.appendSync(line);
				const confirmed = writer.appendSync ? writer.flush() : writer.append(line);
				void confirmed
					.then(() => this.#recordDurableAppend(line))
					.catch(err => {
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						this.#noteDiskFailure(err);
					});
			}
		} catch (err) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#noteDiskFailure(err);
		}
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#rewriteSynchronously();
			if (this.#diskFailure) throw this.#diskFailure;
			return;
		}

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Title changes use their own asynchronous append path rather than
		// #appendToSessionFile. During move, write the full body (including the
		// title entry) to the live relocation path so a crash mid-move still
		// keeps the title change; the trailing rewrite still updates header cwd.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}

		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			!this.#storage.existsSync(this.#sessionFile) ||
			this.#sessionOwnedElsewhere()
		) {
			await this.#rewriteAtomically();
			return;
		}

		const epoch = this.#diskEpoch;
		const line = this.#lineFor(entry);
		await this.#scheduleDiskWork(
			async () => {
				if (this.#released) return;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					await this.#appendWriter().append(line);
					this.#recordDurableAppend(line);
					await this.#storage.updateSessionTitle(sessionFile, update);
					if (this.#diskEpoch === epoch) this.#fileIsCurrent = true;
				} catch {
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#expectedDiskSize = null;
		this.#reconcileSessionDirForFallback();
		if (options?.sessionDir && this.#persist) {
			this.#sessionDir = path.resolve(options.sessionDir);
			this.#storage.ensureDirSync(this.#sessionDir);
		}
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;
		// A new session inherits no transcript, so it inherits no claim on
		// identifiers or names, and no loss to report.
		this.#reservedArtifactId = undefined;
		this.#inheritedOutputNames = [];
		this.#artifactLossReason = undefined;
		this.#artifactsReproduced = undefined;
		this.#forkedFrom = undefined;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
			taskPromptCacheKey: options?.taskPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#loadedMalformedRecords = 0;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
		} else {
			this.#sessionFile = undefined;
		}

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#header = header;
		this.#entries = entries;
		this.#sessionId = header.id;
		// Belongs to the transcript, not to the process that lost the files.
		this.#reservedArtifactId = header.reservedArtifactId;
		this.#inheritedOutputNames = header.reservedOutputNames ?? [];
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
		const repairedUsage = normalizeLoadedUsage(entries);
		if (repairedUsage > 0) logger.warn("Loaded assistant messages with incomplete usage", { count: repairedUsage });
		this.#index.rebuild(entries);
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string; runtime: RuntimeIdentity } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
		};
	}

	#setLeaf(id: string | null): void {
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		if (this.#released) {
			logger.warn("Dropped session entry appended after terminal release", { type: entry.type });
			return;
		}
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			logger.warn("Assistant message recorded with incomplete usage", { id: entry.id });
		}
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			// An off-branch entry replays to the leaf it captured, not to itself.
			batch.externalLeafId = sessionEntryLeafId(entry);
		}
		this.#appendToSessionFile(entry);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#entries.filter(entry => !batch.entryIds.has(entry.id));
		for (const entry of retained) {
			entry.parentId = retainedAncestor(entry.parentId);
			// An off-branch entry captured a staged leaf; keep it pointing at a surviving entry.
			if (typeof entry.activeLeafId === "string") {
				entry.activeLeafId = retainedAncestor(entry.activeLeafId);
			}
		}
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		this.#entries = retained;
		this.#index.rebuild(retained);
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		const pendingCopy = this.#pendingArtifactCopy;
		this.#artifactManager = new ArtifactManager(
			sessionFile.slice(0, -JSONL_SUFFIX_LENGTH),
			pendingCopy?.sessionFile === sessionFile ? pendingCopy.done : undefined,
			this.getSeanceSourceArtifactsDir() ?? undefined,
			() => this.#reservedArtifactId,
		);
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of Array.from(this.#sessionNameChangedCallbacks)) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			expectedDiskSize: this.#expectedDiskSize,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			fallbackRuntimeOnly: this.#fallbackRuntimeOnly,
			taskSiblingCandidate: this.#taskSiblingCandidate,
			// Entries are snapshotted by reference (switch/reload replaces the
			// array wholesale). The header is cloned: moveTo mutates it in place
			// (cwd, additionalDirectories), so a by-reference capture would let
			// a rollback observe the move it is undoing.
			header: structuredClone(this.#header),
			entries: [...this.#entries],
			// A holder of its own, so a rollback to this snapshot takes the
			// session back without this manager ever letting go of it — and so a
			// switch started inside another cannot end the outer one's claim.
			sessionClaim: this.#retainOwnershipForSnapshot(),
		};
	}

	/**
	 * The switch `snapshot` was captured for is final: give up the claim it
	 * retained on the session left behind. Until this is called a rollback
	 * through {@link restoreState} can still take that session back, so no
	 * other process may have it. A snapshot that was already rolled back or
	 * committed is left alone, so a caller may always end its transaction.
	 */
	commitSessionSwitch(snapshot: SessionManagerStateSnapshot): void {
		const retained = snapshot.sessionClaim;
		if (retained && this.#snapshotClaims.delete(retained)) retained.release();
	}

	/**
	 * Create an independent manager for the current logical session and branch.
	 * The clone shares the storage backend but owns its entry index and writer, so
	 * callers can finish session-owned work after this manager switches elsewhere.
	 * Set `persist` false when the original session is intentionally being dropped.
	 */
	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage);
		clone.#suppressBreadcrumb = true;
		// A clone is a second manager over the same session, not a transfer of
		// ownership: it takes no claim here and claims on its own first write.
		const snapshot = this.captureState();
		this.commitSessionSwitch(snapshot);
		clone.restoreState({ ...snapshot, sessionClaim: undefined });
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#expectedDiskSize = null;
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#forceFileCreation = false;
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		// Ownership rolls back with everything else: the claim taken on the
		// session being switched to is dropped, and the holder this snapshot
		// kept on the session this manager is returning to is adopted.
		// Reacquiring it here instead would leave a window in which another
		// process could take the session this one still lives in — and a holder
		// released meanwhile (a `close()` during the switch) is unheld, so it is
		// never mistaken for ownership.
		const retained = snapshot.sessionClaim;
		if (retained) this.#snapshotClaims.delete(retained);
		if (this.#sessionClaim && this.#sessionClaim !== retained) this.#sessionClaim.release();
		this.#sessionClaim = retained?.held ? retained : undefined;

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#expectedDiskSize = snapshot.expectedDiskSize;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#fallbackRuntimeOnly = snapshot.fallbackRuntimeOnly;
		// A completed moveTo drops the stash, so a rollback restores it here.
		this.#taskSiblingCandidate = snapshot.taskSiblingCandidate;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		this.#additionalDirectories = snapshot.header.additionalDirectories ?? [];
		this.#sessionName = snapshot.sessionName;

		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Undo a {@link moveTo} using a {@link captureState} snapshot: rename the
	 * session and artifacts back into the captured bucket, then restore the
	 * captured metadata (cwd, header, additionalDirectories) and the stashed
	 * sibling candidate the forward move dropped. The captured header is
	 * persisted after relocation so a fresh open of the source session sees the
	 * pre-move metadata, including workspace roots the move filtered out.
	 * Rollbacks must not re-enter forward-move hooks, so this bypasses
	 * AgentSession entirely. If the rename-back itself fails, the
	 * manager stays pointed at the actual moved file (restoring the snapshot
	 * would split the transcript across a recreated source and the stranded
	 * target) and the error names where the session file actually lives.
	 */
	async rollbackMove(snapshot: SessionManagerStateSnapshot): Promise<void> {
		try {
			const targetSessionDir = snapshot.sessionFile ? path.dirname(snapshot.sessionFile) : snapshot.sessionDir;
			await this.moveTo(snapshot.cwd, targetSessionDir);
		} catch (error) {
			const movedFile = this.getSessionFile();
			throw new Error(
				`could not relocate the session back to ${snapshot.sessionDir} (${error instanceof Error ? error.message : String(error)}); the session file remains at ${movedFile}`,
			);
		}
		// The inverse moveTo already rewrote the restored source file and left
		// #expectedDiskSize describing that on-disk body. restoreState resets it
		// to the pre-move snapshot size, so capture the post-relocation size and
		// reapply it — otherwise the final rewrite would compare a stale size and
		// reject an otherwise successful rollback.
		const relocatedDiskSize = this.#expectedDiskSize;
		this.restoreState(snapshot);
		// Persist the captured header so disk and memory agree after a fresh open.
		if (this.#persist && this.#sessionFile) {
			this.#expectedDiskSize = relocatedDiskSize;
			this.#forceFileCreation = true;
			this.#rewriteRequired = true;
			await this.#rewriteAtomically();
		}
	}
	/**
	 * Switch to a different session file (resume / branch).
	 *
	 * With `forkIfContested`, a file another live omp process owns is left to
	 * it and this session carries on as a fork of what was loaded, reported in
	 * the result, instead of answering to the loaded id until the first write.
	 * A file that no longer holds the session loaded from it refuses with
	 * {@link SessionSourceReplacedError} and changes nothing.
	 */
	async setSessionFile(
		sessionFile: string,
		options?: { forkIfContested?: boolean },
	): Promise<{ forkedFrom?: ResumedSessionFork }> {
		return await this.#setSessionFile(sessionFile, undefined, options);
	}

	async #setSessionFile(
		sessionFile: string,
		loadedSession?: SessionLoadResult,
		options?: { throwIfMissing?: boolean; newSession?: NewSessionOptions; forkIfContested?: boolean },
	): Promise<{ forkedFrom?: ResumedSessionFork }> {
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;
		// The previous session is not given up here: the snapshot a caller took
		// before this switch holds a claim of its own on it (see
		// {@link captureState}), so it stays this process's until that switch
		// commits or rolls back. Opening claims nothing by itself: the first
		// write does, so inspecting a session never counts as owning it.
		this.#sessionClaim?.release();
		this.#sessionClaim = undefined;

		const resolvedSessionFile = path.resolve(sessionFile);
		const loaded = loadedSession ?? (await loadSessionFile(resolvedSessionFile, this.#storage));
		const sourceSize =
			loaded.sourceSize !== undefined
				? loaded.sourceSize
				: this.#storage.existsSync(resolvedSessionFile)
					? this.#storage.statSync(resolvedSessionFile).size
					: null;
		if (loaded.invalidHeader) {
			throw new Error(
				`Cannot resume session "${resolvedSessionFile}": the session header is missing or malformed. The file was not modified.`,
			);
		}

		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const { entries: fileEntries, titleSlot } = loaded;
		if (fileEntries.length === 0) {
			if (options?.throwIfMissing) {
				throw new Error(
					`Cannot resume session "${resolvedSessionFile}": the session file holds no entries. The file was not modified.`,
				);
			}
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(options?.newSession, resolvedSessionFile);
			this.#expectedDiskSize = sourceSize;
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return {};
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		// loadEntriesFromFile guarantees entries[0] is a valid session header.
		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's working directory only when it is verifiably
		// accessible. Sessions live in a dir keyed by their cwd, so resuming a
		// session from another project must re-point cwd/sessionDir at that
		// project — but a deleted OR permission-blocked directory (macOS TCC
		// denial) must not be adopted: callers without a cwd-change callback
		// (extension UI, RPC) would otherwise track a directory the process
		// cannot enter. Keep the current cwd so the session stays where the
		// user already is.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryIsEnterable(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#fallbackRuntimeOnly = false;
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		} else if (headerCwd && headerCwd !== path.resolve(this.#cwd)) {
			// Header cwd not enterable: keep runtime cwd but mark fallback
			// so workspace changes stay runtime-only until the transcript
			// is relocated.
			this.#fallbackRuntimeOnly = true;
		} else {
			this.#fallbackRuntimeOnly = false;
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#expectedDiskSize = sourceSize;
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated || loaded.malformedRecords > 0;
		this.#loadedMalformedRecords = loaded.malformedRecords;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata()) this.#rewriteRequired = true;

		// Before anything publishes the loaded id: whatever holds the file keeps
		// it, this session takes an id of its own. Checked last so the fork
		// carries the whole adopted state, and when nothing contests the file
		// this is where this process takes its ownership claim.
		if (options?.forkIfContested && this.#persist) {
			const reason = await this.#resumedSessionContention(false);
			if (reason) return { forkedFrom: this.#adoptLoadedSessionAsFork(reason) };
		}
		return {};
	}

	/**
	 * Startup counterpart of {@link setSessionFile}'s `forkIfContested`, for a
	 * session this manager was opened on: take this process's ownership claim
	 * on the loaded session and keep it, or report why it could not and carry
	 * on as a fork of what was loaded (in `sessionDir`, default: beside the
	 * file it was loaded from).
	 *
	 * `staleCopy` says the transcript itself disqualifies this copy — its last
	 * transfer marker hands the conversation to another machine — which forks
	 * whoever holds the lease. That decision belongs to the caller that reads
	 * transfer markers; everything about ownership belongs here. Both run in
	 * one gate so the journal is verified once, before anything is forked or
	 * any artifacts are copied.
	 *
	 * The claim is what makes a startup adoption exclusive. Probing the lease
	 * and dropping it again answers only "nobody had written this yet": two
	 * processes that both resume before either writes then both carry the same
	 * session id, allocate artifacts in one directory, and the second one's
	 * first write moves it off the file under a `continuationOf` naming a
	 * session that is still running. Holding the claim from the resume onwards
	 * makes the loser fork here, where it still costs nothing.
	 *
	 * Throws {@link SessionSourceReplacedError} when the file no longer holds
	 * the session that was loaded from it, leaving this manager untouched.
	 *
	 * Only the resume guard calls this. Opening a session to read it — `omp
	 * sessions`, `--export`, `render`, the picker's previews — never does, so
	 * inspecting a session still never takes it from its owner.
	 */
	async claimResumedSessionOrFork(options?: {
		sessionDir?: string;
		staleCopy?: boolean;
	}): Promise<ResumedSessionFork | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;
		const reason = await this.#resumedSessionContention(options?.staleCopy === true);
		return reason ? this.#adoptLoadedSessionAsFork(reason, options?.sessionDir) : undefined;
	}

	/**
	 * Start a new session and persist its header before returning, except for a
	 * `drop` (/delete) successor.
	 *
	 * The durable empty boundary prevents a later process on another terminal
	 * from selecting the previous conversation as the most recent session. The
	 * drop path does not need it: the fresh terminal breadcrumb already pins
	 * this terminal to the successor, and if deleting the predecessor failed,
	 * that surviving non-empty transcript is the correct resume target.
	 * Materializing the successor there would only leave a zero-turn stub
	 * behind when the user quits, so it keeps the ordinary lazy gate and writes
	 * once it has content.
	 */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		const sessionFile = this.#resetToNewSession(options);
		if (options?.drop !== true) await this.ensureOnDisk();
		return sessionFile;
	}

	/** Delete a session file and its artifact directory. ENOENT is treated as success. */
	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	/**
	 * Fork the current session into a new file with the same entries.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		const previousReservedArtifactId = this.#reservedArtifactId;
		const previousReservedOutputNames = [...this.#inheritedOutputNames];
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#reconcileSessionDirForFallback();

		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#expectedDiskSize = null;
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
			taskPromptCacheKey: this.#header.taskPromptCacheKey,
		};
		// The fork keeps this session's entries, so it keeps what they have
		// already spent: identifiers and subagent names the transcript refers
		// to, whether this session recorded them or they are only in the body.
		this.#reservedArtifactId = undefined;
		this.#inheritedOutputNames = [];
		this.#reserveInheritedArtifacts(
			Math.max(highestArtifactReference(this.#entries), previousReservedArtifactId ?? -1),
			[...new Set([...inheritedOutputNames(this.#entries), ...previousReservedOutputNames])],
			{ rewrite: false },
		);
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		await this.#rewriteAtomically();
		// After the file exists, so the claims record cannot make the new
		// artifacts directory non-empty before a copy into it is handed over.
		await this.#recordReservedClaims();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/** Move the session to a new working directory. */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));
		const expectedSessionFile = this.#sessionFile
			? path.join(nextSessionDir, path.basename(this.#sessionFile))
			: undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			!this.#fallbackRuntimeOnly &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir)) &&
			(!expectedSessionFile || path.resolve(this.#sessionFile!) === path.resolve(expectedSessionFile))
		) {
			return;
		}

		// A move writes both paths: it must neither move a session another live
		// omp process writes nor replace a destination one writes. Checked before
		// relocation starts (appends still go to the source) and before any
		// directory is created, so a refusal touches nothing.
		let destination: { id: string; release: () => void } | undefined;
		// Hold the lease of the session in the destination file until the move
		// settles, so its owner cannot start writing mid-move. Our own id is
		// refcounted, never contended.
		const claimDestination = async (file: string): Promise<void> => {
			const id = await readSessionHeaderId(file);
			if (id === undefined || id === destination?.id) return;
			const release = this.#storage.claimSession?.(id, file);
			if (release === null) {
				throw new SessionMoveRefusedError(
					`Cannot move session to "${file}": another live omp process writes the session there. Nothing was moved.`,
				);
			}
			destination?.release();
			destination = release ? { id, release } : undefined;
		};
		// The file at the source path must still be this session: if another
		// session replaced it, moving it would carry that session away from its
		// writer, whose lease our id never covered.
		const assertSourceIsOurs = async (file: string): Promise<void> => {
			const id = await readSessionHeaderId(file);
			if (id !== undefined && id !== this.#sessionId) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${file}": the file now holds a different session. Nothing was moved.`,
				);
			}
		};
		if (this.#persist && this.#sessionFile && this.#storage.claimSession) {
			// Every persisted move rewrites the journal (at least its header cwd),
			// even when the path stays the same.
			await assertSourceIsOurs(this.#sessionFile);
			this.#claimSession();
			if (!this.#sessionClaim?.held) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${this.#sessionFile}": another live omp process writes it. Nothing was moved.`,
				);
			}
			if (expectedSessionFile && path.resolve(this.#sessionFile) !== path.resolve(expectedSessionFile)) {
				await claimDestination(expectedSessionFile);
			}
		}

		let sessionFileExisted = false;
		// Track source+dest for concurrent completed appends during relocation
		// (see `#sessionFileRelocating`). Existence of either path decides the
		// live write target — not a `#diskEpoch` bump, which would cancel any
		// disk task already queued at the current epoch (e.g. a header-only
		// `ensureOnDisk()` materializing rewrite) before the drain below runs it.
		if (this.#persist && this.#sessionFile) {
			const source = this.#sessionFile;
			const dest = path.join(nextSessionDir, path.basename(source));
			this.#sessionFileRelocating = { source, dest };
		}

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile);
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile);
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged =
					oldArtifactsDir !== null &&
					newArtifactsDir !== null &&
					path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);
				let sessionMoved = false;
				let artifactsRenamed = false;

				try {
					if (sessionFileExisted && sessionPathChanged) {
						// The drain awaited: re-check that both paths still hold the
						// sessions we checked.
						await assertSourceIsOurs(oldSessionFile);
						await claimDestination(newSessionFile);
						try {
							await fs.promises.rename(oldSessionFile, newSessionFile);
						} catch (error) {
							if (!isFsError(error) || error.code !== "EXDEV") throw error;
							if (this.#sessionFileRelocating) this.#sessionFileRelocating.copying = true;
							await moveFileAcrossDevices(oldSessionFile, newSessionFile);
						}
						sessionMoved = true;
					}

					if (artifactPathChanged) {
						let artifactStat: fs.Stats | null = null;
						try {
							artifactStat = await fs.promises.stat(oldArtifactsDir);
						} catch (err) {
							if (!isEnoent(err)) throw err;
						}
						if (artifactStat?.isDirectory()) {
							// Only a whole-directory rename can be undone by renaming back;
							// a merge leaves the rollback below to the session file alone.
							artifactsRenamed =
								(await relocateArtifactsDirectory(oldArtifactsDir, newArtifactsDir)) === "renamed";
						}
					}
				} catch (err) {
					if (artifactsRenamed && oldArtifactsDir && newArtifactsDir) {
						try {
							await fs.promises.rename(newArtifactsDir, oldArtifactsDir);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move artifacts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					if (sessionMoved) {
						try {
							try {
								await fs.promises.rename(newSessionFile, oldSessionFile);
							} catch (error) {
								if (!isFsError(error) || error.code !== "EXDEV") throw error;
								await moveFileAcrossDevices(newSessionFile, oldSessionFile);
							}
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					throw err;
				}

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				// The freshness expectation must describe the NEW path. A successful
				// rename carried this manager's tracked bytes to `newSessionFile`, so
				// #expectedDiskSize still applies; without a rename the destination
				// holds no bytes this manager wrote, so a recreate-from-memory must
				// publish against an absent file rather than a stale size.
				if (sessionPathChanged && !sessionMoved) this.#expectedDiskSize = null;
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;
				// Path is repointed; hot-path appends may use `#sessionFile` again.
				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			// The stash is scoped to the conversation's pre-move state: a completed
			// move must not let a later opted-in request promote it. Refusals and
			// the internal rollback rethrow above, and the no-op early return never
			// relocates, so all three keep it; a caller undoing this completed move
			// through rollbackMove() re-derives it from the captureState() snapshot.
			this.clearTaskSiblingCandidate();
			// Clear only after the rename has landed. If the move threw,
			// keep the flag so the next relocation retries.
			this.#fallbackRuntimeOnly = false;
			if (this.#additionalDirectories.length === 0) {
				this.#header.additionalDirectories = undefined;
			} else {
				// Re-filter additional roots: the new cwd may have been an
				// additional root, or it may now contain one.
				this.#additionalDirectories = this.#additionalDirectories.filter(d => d !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			// Rewrite at the new location when the file already existed (update cwd) or
			// there is in-memory output worth materializing; otherwise stay lazy.
			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
			// The destination is ours or untouched now.
			destination?.release();
		}
	}

	/**
	 * Force the session onto disk even with no assistant message yet (ACP
	 * session/new must create a discoverable file immediately).
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	/** Persist this session's transcript as a newly identified OMP session. */
	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession({ taskPromptCacheKey: this.#header.taskPromptCacheKey });
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		manager.#entries = structuredClone(this.#entries);
		manager.#index.rebuild(manager.#entries);
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	/**
	 * Stage a synchronous group of entry appends and publish the resulting full
	 * journal with one atomic replace. A failed publish removes only the staged
	 * entries, preserves/reparents entries appended concurrently, restores the
	 * prior durable file view, and clears the failed writer latch for retry.
	 *
	 * The callback MUST be synchronous.
	 */
	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically();
			if (!this.#fileIsCurrent || this.#rewriteRequired) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	/**
	 * Replace an uncertain append tail with the authoritative in-memory journal.
	 * Callers must only use this for monotonic recovery where every retained
	 * entry remains intended (for example, an explicit terminal tombstone).
	 */
	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	/**
	 * Flush pending entry writes, without waiting for a background artifact
	 * copy. For a caller that only needs its own append durable — a resume
	 * notice, say — waiting for a half-gigabyte of artifacts to be reproduced
	 * first is the whole latency this fork path exists to avoid.
	 */
	async flushEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
		// on IndexedSessionStorage during `flushSync`) so callers relying on
		// flush() see the write durably visible to readers.
		await this.#scheduleDiskWork(async () => {
			await this.#storage.drain();
		});
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Flush pending writes, including any artifact copy still running. Call
	 * before switching sessions or on shutdown: both move or reopen the
	 * artifacts directory a copy may still be publishing into.
	 */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.flushEntries();
		await this.#pendingArtifactCopy?.done;
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			this.#writer?.flushSync?.();
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// Another process can consume the draft and append a real conversation
		// while this manager still has a draft-only in-memory view. Backends that
		// cannot make the final content check and deletion one atomic operation
		// must skip this opportunistic cleanup rather than risk data loss.
		if (!this.#storage.deleteSessionWithArtifactsIf) return;
		try {
			const artifactsDir = this.getArtifactsDir();
			const deleted = await this.#storage.deleteSessionWithArtifactsIf(sessionFile, content => {
				// An `/annotate` draft is work in progress the session must keep.
				if (artifactsDir && hasAnnotationDraftsSync(artifactsDir, this.#header.id)) return false;
				const onDisk = parseSessionContent(content);
				return (
					!onDisk.invalidHeader &&
					onDisk.malformedRecords === 0 &&
					(onDisk.entries.slice(1) as SessionEntry[]).every(isDraftOnlyMetadataEntry)
				);
			});
			if (!deleted) {
				await this.#clearDraftOnlySessionMarker();
				this.#draftOnlySessionCleanupArmed = false;
				return;
			}
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		if (!this.#persist) return;
		// Closing gives up every ownership claim this manager holds, including
		// the one a switch snapshot still kept: a rollback after this finds that
		// holder unheld and reclaims on the next write instead of writing into a
		// session another process may have taken meanwhile.
		for (const retained of this.#snapshotClaims) retained.release();
		this.#snapshotClaims.clear();
		this.#sessionClaim?.release();
		// A prior `flushSync` can self-conflict with this manager's own
		// unconfirmed deferred publish; drain despite the latch so that
		// publish can still confirm before we give up on the transcript.
		await this.#scheduleDiskWork(
			async () => {
				const hadWriter = this.#writer !== undefined;
				await this.#closeWriterHandle();
				if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
					this.#fileIsCurrent = true;
			},
			{ ignorePriorError: true },
		);
		await this.#pendingArtifactCopy?.done;
		await this.#dropIfEmptyAndNoDraft();
		// Wait for any queued backing writes (IndexedSessionStorage per-path
		// tail) to become durable so a graceful shutdown does not exit while
		// a fire-and-forget publish is still on the wire.
		await this.#scheduleDiskWork(
			async () => {
				await this.#storage.drain();
			},
			{ ignorePriorError: true },
		);
		if (
			this.#diskFailure &&
			this.#sessionFile &&
			this.#storage.defersSyncPublish &&
			!this.#entriesReleased &&
			this.#shouldHaveSessionFile()
		) {
			// Deferred-publish only: a synchronous backend's drain() is a
			// no-op, so any failure there is a genuine external conflict or a
			// permanent write failure, not a self-race this retry can catch
			// up on. seal() disabled the ordinary mid-life repair path, so
			// close() issues the terminal write directly instead.
			const operationError = this.#diskFailure;
			const sessionFile = this.#sessionFile;
			await this.#scheduleDiskWork(
				async () => {
					await this.#publishAuthoritativeBody(sessionFile, operationError);
					this.#clearDiskError();
				},
				{ ignorePriorError: true },
			).catch(() => undefined);
		}
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Raise the terminal write barrier ahead of the final {@link close}. Once
	 * sealed:
	 * - every later append, title change, and rewrite is a dropped no-op —
	 *   including work an event handler tries to enqueue while dispose is
	 *   awaiting `close()` on the disk tail;
	 * - the disk epoch is bumped, so queued-but-unexecuted tail work is
	 *   superseded and an ALREADY-RUNNING fenced/repair rewrite (awaiting the
	 *   tail, drain, writer close, or the atomic stage) fails its commit guard
	 *   at the rename fence instead of publishing over a revived file.
	 * - a move whose new file was never written stays unwritten
	 *   ({@link whenMoveWritten} settles `false`).
	 * The final `close()` itself is scheduled after the bump and still runs;
	 * pre-seal hot-path appends are already in the page cache. Idempotent;
	 * terminal.
	 */
	seal(): void {
		if (this.#released) return;
		this.#released = true;
		this.#diskEpoch++;
		for (const move of this.#movesAwaitingWrite.splice(0)) this.#settleMoveWrite(move, false);
	}

	/**
	 * Terminal release: drop the in-memory transcript and complete the
	 * {@link seal}. The entry journal and its index mirror the agent's message
	 * array (tool results, file contents, base64 frame images); on a disposed
	 * session — e.g. a parked subagent still referenced by the lifecycle
	 * adoption record — they would otherwise stay pinned for the process
	 * lifetime.
	 *
	 * Closes the append writer; with the seal up, nothing can reopen it. A
	 * revival may reopen the same JSONL through a NEW manager the moment
	 * dispose returns; a late event handler resuming on THIS manager must
	 * never race that writer — and a post-release rewrite would persist the
	 * now-empty entry list, truncating the transcript. Reads after this point
	 * reopen from disk (revival, `history://`). Only call from session
	 * dispose, after the final `close()`; idempotent.
	 */
	releaseRetainedEntries(): void {
		this.seal();
		this.#entries = [];
		this.#index.clear();
		this.#inMemoryArtifacts = null;
		this.#closeWriterEventually();
		this.#entriesReleased = true;
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** Recorded cwd from the session header (original project), may differ from runtime {@link getCwd} when fallback retained launch cwd. */
	getRecordedCwd(): string | undefined {
		return this.#header?.cwd;
	}

	setCwdWithoutRelocation(newCwd: string): void {
		const resolvedCwd = path.resolve(newCwd);
		if (resolvedCwd === path.resolve(this.#cwd)) {
			this.#fallbackRuntimeOnly = true;
			return;
		}
		this.#cwd = resolvedCwd;
		this.#fallbackRuntimeOnly = true;
		if (this.#sessionFile) {
			this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		}
	}
	adoptRecordedCwd(): void {
		const recordedCwd = this.#header.cwd;
		if (!recordedCwd) return;
		this.#cwd = path.resolve(recordedCwd);
		if (this.#sessionFile) this.#sessionDir = path.dirname(this.#sessionFile);
		this.#fallbackRuntimeOnly = false;
		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Re-anchor the session bucket to the runtime cwd after a fallback.
	 * The fallback flag keeps the transcript at its recorded path (stale
	 * bucket) while runtime cwd is the launch dir; only a true relocation
	 * should recompute sessionDir. Workspace-dir mutations must not clear
	 * it early.
	 */
	#reconcileSessionDirForFallback(): void {
		if (this.#fallbackRuntimeOnly) {
			this.#sessionDir = computeDefaultSessionDir(this.#cwd, this.#storage);
			this.#fallbackRuntimeOnly = false;
		}
	}

	/** Additional workspace directories beyond cwd (multi-root), absolute and normalized. */
	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	/**
	 * Persist a workspace-directory change to the session header. Respects the
	 * lazy-persistence gate: a session with no durable output yet keeps the
	 * change in memory (the header lands with the first real write), so seeding
	 * roots at launch never materializes an empty resumable session file.
	 */
	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Add a workspace directory. Normalizes (relative to cwd), dedupes, rejects
	 * the cwd itself, persists to the session header, and triggers an atomic
	 * rewrite so the change survives a crash. Returns the resolved absolute
	 * path or `null` when the directory was already present (no-op).
	 */
	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		// In fallback the transcript is still in the stale bucket; keep
		// workspace edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/**
	 * Remove a workspace directory by absolute or cwd-relative path. Persists
	 * the trimmed header. Returns the resolved path that was removed, or
	 * `null` when the directory was not an additional root (no-op).
	 */
	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/** Seed additional directories from settings or a passed list. Also called on resumed sessions with --add-dir; persists the updated header when the session file is already durable. No-op when the normalized list is unchanged (avoids rewriting large session files on every startup). */
	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			this.#additionalDirectories = next;
			return;
		}
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	/**
	 * Whether the current session has actually been materialized to durable
	 * storage (the JSONL exists on disk / in the active storage backend).
	 *
	 * Session persistence is lazy: the file is only written once the history
	 * contains an assistant message (or an explicit {@link ensureOnDisk}
	 * caller forces it). Until then {@link getSessionFile} returns an allocated
	 * path that leads nowhere, so a `--resume <id>` hint built from it would
	 * always fail. Consumers that advertise a resume command must gate on this
	 * (issue #8860).
	 */
	isSessionOnDisk(): boolean {
		return !!this.#sessionFile && this.#storage.existsSync(this.#sessionFile);
	}

	/**
	 * {@link isSessionOnDisk}, counting only what the backing store has
	 * confirmed. Remote storage publishes asynchronously, so a hint printed
	 * just before the process exits must not count a write still in flight:
	 * the exit aborts it and `--resume <id>` would find nothing. A deferring
	 * store without `existsConfirmedSync` cannot vouch for its writes, so it
	 * reports false.
	 */
	isSessionConfirmedOnDisk(): boolean {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return false;
		const storage = this.#storage;
		if (storage.existsConfirmedSync) return storage.existsConfirmedSync(sessionFile);
		return !storage.defersSyncPublish && storage.existsSync(sessionFile);
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	/** Source artifacts a seance fork reads in place; null for ordinary sessions. */
	getSeanceSourceArtifactsDir(): string | null {
		return artifactsDirectoryFor(this.#header?.seanceSource);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		if (this.#released) return {};
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		if (this.#released) return undefined;
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	/**
	 * Content of a spill artifact kept in memory by a non-persistent session.
	 * Null for unknown ids and for file-backed sessions, whose artifacts resolve
	 * through {@link getArtifactPath}.
	 */
	getArtifactContent(id: string): string | null {
		return this.#inMemoryArtifacts?.get(id) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	/** Tracks user rename requests; background title updates do not invalidate them. */
	get titleRevision(): number {
		return this.#titleRevision;
	}

	/** Malformed JSONL records skipped when this session file was loaded (0 for new sessions). */
	get loadedMalformedRecords(): number {
		return this.#loadedMalformedRecords;
	}

	/** Invalidate older generated renames before starting a new request. */
	reserveTitleRevision(): number {
		return ++this.#titleRevision;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/**
	 * Subscribe to persistence failures so hosts can surface lost-durability state.
	 *
	 * A failure latched before this call — a store that failed on its first write,
	 * before the host wired its observer — is replayed to the new subscriber.
	 * Without the replay the host sees only a dispose rejection it cannot
	 * attribute to persistence (issue #11493).
	 */
	onPersistenceError(cb: (error: Error) => void): () => void {
		this.#persistenceErrorCallbacks.add(cb);
		const latched = this.#diskFailure;
		if (latched) this.#invokePersistenceObserver(cb, latched);
		return () => {
			this.#persistenceErrorCallbacks.delete(cb);
		};
	}

	/**
	 * Subscribe to {@link SessionPersistenceNotice}s: this session moved to a new
	 * file and keeps saving there, which the user should hear about but which is
	 * not a failure. Every notice raised before this call is replayed to the new
	 * subscriber, as {@link onPersistenceError} replays a latched failure, so each
	 * subscriber sees each notice once however late it subscribed.
	 */
	onPersistenceNotice(cb: (notice: SessionPersistenceNotice) => void): () => void {
		for (const notice of this.#persistenceNotices) this.#invokePersistenceObserver(cb, notice);
		this.#persistenceNoticeCallbacks.add(cb);
		return () => {
			this.#persistenceNoticeCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#released) return false;
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		if (source === "user") this.#titleRevision++;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });
		// Keep the recent-sessions title index current so welcome-screen lookups
		// never have to content-scan this session's file.
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionTitle(this.#sessionId, title);
		}

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Rename a session file that is not loaded in this process, e.g. from the
	 * resume picker. Returns the title as stored (the session canonicalizes
	 * it), or null when the rename did not happen.
	 *
	 * The cross-process ownership lease is claimed before the transcript is
	 * loaded and held until the write is done. Claiming first is what makes
	 * the rename safe: another process appending between our load and our
	 * write would leave us parenting the title entry to a stale leaf, so the
	 * reopened session followed the older branch and hid the other process's
	 * turn. Holding the lease from before the load keeps the loaded leaf
	 * stable until the title is written.
	 */
	static async renameSessionTitle(
		sessionPath: string,
		title: string,
		options?: { cwd?: string },
	): Promise<string | null> {
		const storage = new FileSessionStorage();
		// The header id is what the lease is keyed on; a null claim means
		// another live process owns the session, so leave it alone.
		const sessionId = await readSessionHeaderId(sessionPath);
		if (!sessionId) return null;
		const probe = storage.claimSession(sessionId, sessionPath);
		if (!probe) return null;
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(sessionPath, undefined, storage, {
				initialCwd: options?.cwd,
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			if (manager.getSessionFile() !== sessionPath) return null;
			if (!(await manager.setSessionName(title, "user"))) return null;
			return manager.getSessionName() ?? null;
		} finally {
			try {
				await manager?.close();
			} finally {
				probe();
			}
		}
	}

	/**
	 * Journal an idle recap for this session in history.db. Recaps never enter
	 * the session file or LLM context; in-memory sessions are not journaled.
	 */
	recordRecap(recap: string): void {
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionRecap(this.#sessionId, this.#cwd, recap);
		}
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * The live header and entries, for collab replication. Nothing is copied:
	 * the host mutates entries in place on rewrite paths, so callers must not
	 * mutate what this returns and must serialize it synchronously, before any
	 * such rewrite can run.
	 */
	snapshotForReplication(): { header: SessionHeader; entries: readonly SessionEntry[] } {
		return { header: this.#header, entries: this.#entries };
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append to a non-active branch without changing the current leaf.
	 * Used by work that retains ownership of a branch across tree navigation.
	 *
	 * The entry records the active leaf it interrupted (`activeLeafId`) so a
	 * reload replays the same leaf instead of adopting this off-branch tail.
	 * Pass `preserveActiveLeaf: false` when the caller selects the new entry as
	 * the leaf instead (a re-answered `ask`).
	 */
	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
		options?: { preserveActiveLeaf?: boolean },
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			message,
			...(options?.preserveActiveLeaf === false ? {} : { activeLeafId }),
		};
		// The entry never joins the active branch; keep it out of any branch view
		// already handed out. Recording `activeLeafId` leaves the index's leaf on
		// the active branch, as the in-memory contract requires.
		this.#index.detachBranchView();
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Record usage on its initiating branch without moving a successor branch or session. */
	appendModelUsage(
		usage: Pick<
			ModelUsageEntry,
			"purpose" | "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
		>,
		owner: { sessionId: string; parentId: string | null },
	): string | undefined {
		if (this.#sessionId !== owner.sessionId || (owner.parentId !== null && !this.#index.has(owner.parentId))) {
			return undefined;
		}
		const activeLeafId = this.#index.leafId();
		const entry: ModelUsageEntry = {
			type: "model_usage",
			id: generateId(this.#index),
			parentId: owner.parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			...usage,
			...(activeLeafId !== owner.parentId ? { activeLeafId } : {}),
		};
		this.#recordEntry(entry);
		// Through #setLeaf so an in-flight atomic batch restores this leaf, not the usage entry, on rollback.
		if (activeLeafId !== owner.parentId) this.#setLeaf(activeLeafId);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 * @param resolvedModelIsFallback Whether this transition selected a retry-fallback model
	 */
	appendModelChange(model: string, role?: string, resolvedModelIsFallback = false): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			...this.#freshEntryFields(),
			model,
			role,
			resolvedModelIsFallback,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string[];
		task: string;
		tools: string[];
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		perCallModel?: boolean;
		perCallModelIdentity?: string;
		perCallThinkingLevel?: ConfiguredThinkingLevel | null;
		retryFallback?: RetryFallbackRole;
		readOnly?: boolean;
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
		advisor?: string;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
		isolated?: boolean;
		workPoolYieldItems?: WorkPoolYieldItem[];
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		options: {
			details?: T;
			fromExtension?: boolean;
			preserveData?: Record<string, unknown>;
			method?: CompactionMethod;
			providerReplayThroughEntryId?: string;
			tokensAfter?: number;
		} = {},
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: options.tokensAfter,
			method: options.method,
			providerReplayThroughEntryId: options.providerReplayThroughEntryId,
			details: options.details,
			fromExtension: options.fromExtension,
			preserveData: options.preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append the durable conversation boundary recorded by `/clear`. The
	 * collapsed live transcript and the model-context rebuild start after the
	 * latest one, while the full history stays on disk (the plain
	 * `transcript:true` export walks it unchanged).
	 */
	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly.
	 */
	async rewriteEntries(): Promise<void> {
		this.#bodyRevision++;
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
		timestamp?: number,
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const fresh = this.#freshEntryFields();
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...fresh,
			// Prefer the initiating message's own timestamp: without it the entry
			// records the emission time, which on rebuild excludes provider
			// preparation / hook time from the prompt→yield anchor.
			timestamp: timestamp !== undefined ? new Date(timestamp).toISOString() : fresh.timestamp,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	/** Append a credential pin recording which OAuth account served `provider`. */
	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Latest credential pin per provider on the current branch (root → leaf),
	 * with the effective last-use time of the pinned account.
	 *
	 * Pins are appended only when the serving account *changes*, so a long
	 * session on one account carries a single old pin entry. Any assistant turn
	 * for the same provider after that pin was necessarily served by the pinned
	 * account, so its timestamp advances `lastUsedAt` — a resume seconds after
	 * the last turn seeds a warm sticky instead of a stale one.
	 */
	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded. `skipEphemeral` passes over temporary
	 * switches (retry fallback hops, prewalk, context promotion), returning the
	 * role the session was last assigned.
	 */
	getLastModelChangeRole(options?: { skipEphemeral?: boolean }): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "model_change") continue;
			const role = entry.role ?? "default";
			if (options?.skipEphemeral && (role === EPHEMERAL_MODEL_CHANGE_ROLE || role === PREWALK_MODEL_CHANGE_ROLE)) {
				continue;
			}
			return role;
		}
		return undefined;
	}

	/**
	 * The newest model change on the current branch when it selected a model for
	 * this session only (`temporary`, or a prewalk handoff); undefined when the
	 * newest change assigned a role, was a retry fallback hop, or none was recorded.
	 */
	getSessionLocalModelChange(): ModelChangeEntry | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "model_change") continue;
			return entry.role === "temporary" || entry.role === PREWALK_MODEL_CHANGE_ROLE ? entry : undefined;
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * The active-leaf branch (same entries as `getBranch()`) without the
	 * defensive copy. The array is the manager's memo: never mutate it. It is
	 * live — an entry appended to the current leaf is pushed onto it — so use
	 * `getBranch()` when you need a snapshot that survives appends.
	 */
	getBranchView(): readonly SessionEntry[] {
		return this.#index.branchView();
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), {
			resolveFrameData: data => lazyImageDataSync(this.#blobs, data),
			...options,
		});
	}

	/** Prompt blocks for a snapcompact archive, budgeted and resolved as {@link buildSessionContext} attaches them. */
	snapcompactHistoryBlocks(archive: snapcompact.Archive): (TextContent | ImageContent)[] {
		const resolveFrameData = (data: string) => lazyImageDataSync(this.#blobs, data);
		return snapcompact.historyBlocks(archive, snapcompactHistoryBlockOptions(archive, { resolveFrameData }));
	}

	/** Strip stale OpenAI Responses replay metadata from loaded assistant entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}
		if (changed) this.#bodyRevision++;
		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	static getInheritedProviderPromptCacheKey(header: SessionHeader | undefined): string | undefined {
		return header?.taskPromptCacheKey !== undefined ? undefined : (header?.providerPromptCacheKey ?? header?.id);
	}

	/** Seed automatic affinity without turning a legacy fork identity into an explicit override. */
	async setTaskPromptCacheKey(key: string): Promise<void> {
		if (this.#header.taskPromptCacheKey === key && this.#header.providerPromptCacheKey === undefined) return;
		this.#header.taskPromptCacheKey = key;
		this.#header.providerPromptCacheKey = undefined;
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Stash the parent-derived sibling family candidate without touching the
	 * header. Unlike {@link setTaskPromptCacheKey} this is neither persisted nor
	 * carried into forks, moves, or new-session resets, so a fresh identity
	 * starts without it while the per-request policy gate still decides whether
	 * this session's requests consume it.
	 */
	setTaskSiblingCandidate(key: string): void {
		this.#taskSiblingCandidate = key;
	}

	/** Stashed sibling family candidate; consumed only when the request model opts in. */
	getTaskSiblingCandidate(): string | undefined {
		return this.#taskSiblingCandidate;
	}

	/** Drop the stash: a committed switch to a different session adopts that session's identity. */
	clearTaskSiblingCandidate(): void {
		this.#taskSiblingCandidate = undefined;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#setLeaf(null);
	}

	/**
	 * Durably move the active branch past a discarded entry.
	 *
	 * The loader reconstructs the active branch from the last physical journal
	 * entry, so changing the in-memory leaf alone is lost on reload. Known
	 * metadata children are chained onto the discarded entry's parent before the
	 * entry is removed. If any child may carry content, the subtree is preserved
	 * off-branch instead. Both paths append a metadata-only branch marker and
	 * rewrite the journal, making the selected path durable.
	 */
	async discardEntryDurably(entryId: string): Promise<void> {
		const entry = this.#index.get(entryId);
		if (!entry) return;
		const children = this.#index.childrenOf(entryId);
		const canReparentChildren = children.every(child => child.type === "service_tier_change");
		let leafId = entry.parentId;
		if (canReparentChildren) {
			for (const child of children) {
				child.parentId = leafId;
				leafId = child.id;
			}
			this.#entries = this.#entries.filter(candidate => candidate.id !== entryId);
			this.#index.rebuild(this.#entries);
		}
		this.branchWithSummary(leafId, "", {
			kind: DISCARDED_ENTRY_BRANCH_MARKER,
			discardedEntryId: entryId,
		});
		await this.rewriteEntries();
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * With `copyArtifacts`, the source artifact directory is copied in the background;
	 * the new artifact manager waits for it before allocating ids or resolving
	 * `artifact://`, so kept references stay valid and new ids cannot collide.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string, options?: { copyArtifacts?: boolean }): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		// Every kept entry lies on the forked path, so a late-usage or off-branch leaf
		// marker no longer applies.
		const entriesToKeep: SessionEntry[] = [];
		for (const entry of branchPath) {
			if (entry.type === "label") continue;
			entriesToKeep.push(entry.activeLeafId === undefined ? entry : { ...entry, activeLeafId: undefined });
		}
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		this.#reconcileSessionDirForFallback();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#sessionId = newSessionId;
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#index.rebuild(this.#entries);
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		if (options?.copyArtifacts && sourceSessionFile) {
			this.#pendingArtifactCopy = {
				sessionFile: newSessionFile,
				done: copySessionArtifacts(sourceSessionFile, newSessionFile),
			};
		}
		this.#expectedDiskSize = null;
		this.#rewriteSynchronously();
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		return newSessionFile;
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 */
	static create(cwd: string, sessionDir?: string, storage: SessionStorage = new FileSessionStorage()): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Artifacts are copied
	 * recursively by default; nested agents that deliberately share their parent's
	 * artifact root may disable this with `copyArtifacts: false`.
	 *
	 * `seance` creates a read-only consult fork instead: artifacts stay in the
	 * source (the header's `seanceSource` points lookups at them), inherited
	 * workspace roots are dropped, and the source's `session_init` contracts
	 * become inert `source_session_init` custom entries so revival never
	 * mistakes them for the fork's own.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: {
			copyArtifacts?: boolean;
			suppressBreadcrumb?: boolean;
			sessionFile?: string;
			resetInheritedCost?: boolean;
			repairInterruptedTail?: boolean;
			seance?: boolean;
		},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		// A missing source must fail instead of forking an empty parentless session:
		// the loader swallows ENOENT by default for fresh-session opens, so fork opts out.
		let sourceEntries: FileEntry[];
		try {
			sourceEntries = await loadEntriesFromFile(sourcePath, storage, { throwIfMissing: true });
		} catch (err) {
			if (isEnoent(err) || isEnotdir(err)) throw new ForkSourceNotFoundError(sourcePath);
			throw err;
		}
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		normalizeLoadedUsage(history);
		if (options?.resetInheritedCost) SessionManager.#resetInheritedUsageCost(history);
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(sourceHeader),
				taskPromptCacheKey: sourceHeader?.taskPromptCacheKey,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		// The fork carries the source's transcript, so it carries its claims:
		// identifiers and output names the source could not back are still
		// spent here, and a fork that forgets them answers for them with new
		// output. Taken from the entries, so a source header that never
		// recorded one is still covered.
		manager.#reserveInheritedArtifacts(
			Math.max(highestArtifactReference(history), sourceHeader?.reservedArtifactId ?? -1),
			[...new Set([...inheritedOutputNames(history), ...(sourceHeader?.reservedOutputNames ?? [])])],
			{ rewrite: false },
		);
		manager.#additionalDirectories = options?.seance
			? []
			: (sourceHeader?.additionalDirectories ?? []).filter(d => d !== path.resolve(cwd));
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		if (options?.seance) {
			manager.#header.seanceSource = path.resolve(sourcePath);
			SessionManager.#neutralizeSessionInits(history);
		}
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#entries = history;
		manager.#index.rebuild(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		if (options?.repairInterruptedTail) {
			SessionManager.#repairForkedInterruptedTail(history, manager.#index.pathTo());
			manager.#index.rebuild(history);
		}
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		if (!options?.seance && options?.copyArtifacts !== false) {
			await copySessionArtifacts(sourcePath, manager.#sessionFile!);
		}
		// After the copy, never before it: the claims are a file in the
		// artifacts directory, and writing one first would make the directory
		// exist with contents of its own — which is exactly the case the
		// handover treats as a destination that already holds artifacts, and
		// the fork would inherit nothing but its own bookkeeping.
		await manager.#recordReservedClaims();
		return manager;
	}

	/** Replace inherited `session_init` entries, in place, with inert custom entries keeping the same tree position. */
	static #neutralizeSessionInits(history: SessionEntry[]): void {
		for (let index = 0; index < history.length; index++) {
			const entry = history[index]!;
			if (entry.type !== "session_init") continue;
			const neutralized: CustomEntry = {
				type: "custom",
				customType: "source_session_init",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				data: entry,
			};
			history[index] = neutralized;
		}
	}

	/**
	 * Zero the monetary attribution (cost, credits, premium requests) on the
	 * forked history's assistant turns and completed `task` results, in place.
	 *
	 * A tan fork is a fresh agent that inherits the parent's transcript purely
	 * for context; its spend must reflect only its own work. Session cost is
	 * derived by summing `usage.cost` over the transcript, so without this the
	 * clone's Agent Hub row would open at the parent's entire accumulated cost.
	 * Token counts are left intact — compaction anchors and context math depend
	 * on them — since only billing attribution is inherited, not context size.
	 */
	static #resetInheritedUsageCost(history: SessionEntry[]): void {
		for (const entry of history) {
			resetUsageCost(entryUsage(entry));
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
				resetTaskResultBilling(entry.message.details);
			}
		}
	}

	/**
	 * Pair unresolved calls on the fork's active branch with diagnostic results.
	 *
	 * Forks can be taken while the source parent is still running. A result that
	 * arrives later is only present in that parent's history, so the child must
	 * preserve an unknown outcome instead of asserting the tool never ran.
	 *
	 * A source whose process exit follows its last message is no longer running;
	 * it keeps the resume recovery instead: startup warns about the pending
	 * calls, then pairs them with process-exit results and the interrupted-turn
	 * abort record.
	 *
	 * Sibling branches are excluded: only the root-to-active-leaf path is copied.
	 */
	static #repairForkedInterruptedTail(history: SessionEntry[], branch: readonly SessionEntry[]): void {
		const leaf = branch.at(-1);
		if (!leaf || sessionExitFollowsLastMessage(branch)) return;
		const results = createInterruptedToolResults(branch, "fork");
		if (results.length === 0) return;
		const usedIds = new Set(history.map(entry => entry.id));
		let parentId = leaf.id;
		for (const result of results) {
			const id = generateId(usedIds);
			usedIds.add(id);
			const entry: SessionMessageEntry = {
				type: "message",
				id,
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				message: result,
			};
			history.push(entry);
			parentId = id;
		}
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 * @param options.throwIfMissing Propagate ENOENT instead of creating a new session at a missing path.
	 * @param options.parentSession Parent session file recorded when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { initialCwd?: string; parentSession?: string; suppressBreadcrumb?: boolean; throwIfMissing?: boolean },
	): Promise<SessionManager> {
		const probed = await loadSessionFile(filePath, storage, { throwIfMissing: options?.throwIfMissing });
		const header = probed.entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when it is verifiably
		// accessible. A deleted or permission-blocked (macOS TCC denial) project
		// dir would make the constructor's #cwd — and the `setProjectDir` chdir
		// interactive mode runs next — fail, so fall back to the launch cwd and
		// anchor /new and /branch there too, keeping the resumed session where
		// the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryIsEnterable(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		// Freshness gate for fail-closed callers (revive): the cwd probe above
		// yields, so re-read after it and adopt only the fresh snapshot. A
		// transcript deleted, truncated, or replaced mid-probe then fails
		// closed here (ENOENT / holds-no-entries, without minting) instead of
		// reviving stale history. Other callers keep the single probe read.
		const loaded = options?.throwIfMissing
			? await loadSessionFile(filePath, storage, { throwIfMissing: true })
			: probed;
		await manager.#setSessionFile(filePath, loaded, {
			throwIfMissing: options?.throwIfMissing,
			newSession: { parentSession: options?.parentSession },
		});
		return manager;
	}

	/**
	 * Whether `session` was recorded in a worktree of `cwd`'s repository that no
	 * longer exists, e.g. a `/wt` worktree removed since. Resume such a session
	 * through {@link openRelocated} into `cwd`: its own directory cannot be entered.
	 * @param sessionDir `cwd`'s session directory; defaults to the cwd-derived one.
	 */
	static async isFromRemovedWorktree(
		session: Pick<SessionInfo, "path" | "cwd">,
		cwd: string,
		sessionDir?: string,
	): Promise<boolean> {
		if (!session.cwd || !(await directoryIsMissing(session.cwd))) return false;
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
		const home = path.resolve(path.dirname(session.path));
		return (await worktreeSessionDirs(cwd, dir)).some(sibling => path.resolve(sibling) === home);
	}

	/**
	 * Open a session whose recorded directory `recordedCwd` is gone and move it,
	 * artifacts included, into `cwd` so it resumes from there.
	 * @param sessionDir Target session directory; defaults to `cwd`'s.
	 * @throws {SessionMoveRefusedError} when another live omp process writes the session.
	 */
	static async openRelocated(
		sessionPath: string,
		recordedCwd: string,
		cwd: string,
		sessionDir?: string,
	): Promise<SessionManager> {
		// Anchor at the missing recorded cwd: `open` otherwise falls back to the
		// launch cwd, which would make the `moveTo` below a no-op whenever the move
		// target equals it. moveTo never chdirs, so the stale cwd is only the
		// relocation source, not a directory we enter.
		const manager = await SessionManager.open(sessionPath, sessionDir, undefined, { initialCwd: recordedCwd });
		try {
			await manager.moveTo(cwd, sessionDir);
		} catch (error) {
			await manager.close();
			throw error;
		}
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read; `init` is null for files written before
	 * `session_init` was recorded (no faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{
		cwd: string;
		init: PersistedSessionInit | null;
		seanceSource?: string;
	} | null> {
		let header: SessionHeader | undefined;
		const initEntries: FileEntry[] = [];
		const visit = (entry: FileEntry): void => {
			if (entry.type === "session") {
				header ??= entry;
				return;
			}
			if (entry.type === "session_init") initEntries.push(entry);
		};

		try {
			await visitEntriesFromFile(filePath, visit, storage);
		} catch {
			return null;
		}
		// A missing, empty, or invalid file has no usable session.
		if (!header) return null;
		return {
			cwd: header.cwd ?? getProjectDir(),
			init: extractSessionInit(initEntries),
			seanceSource: header.seanceSource,
		};
	}
	/**
	 * Continue the most recent session, or create a new one if none exists.
	 *
	 * When the chosen session's conversation went on in another file (it moved
	 * off its file; see `findSessionContinuation`), this opens the copy to
	 * resume instead and reports it to `onSessionContinuation`. The session the
	 * terminal's record of its last session names was chosen, as a file named
	 * to `--resume` is, so it is kept when it has turns its continuation lacks
	 * ({@link findSessionContinuation}). Without that record the pick goes by
	 * file time, and a process writes its exit record or an idle cache refresh
	 * long after its last turn, so the pick can be any copy
	 * ({@link findRecentSessionContinuation}).
	 */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options: { onSessionContinuation?: (continuation: SessionContinuation) => void } = {},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// A lazy fresh-session boundary whose JSONL was never materialized
			// (for example, initial creation followed by exit before any assistant
			// output). Honor the boundary rather than falling back to
			// findMostRecentSession(), which would resurrect an older transcript.
			// Explicit newSession() boundaries are materialized before it returns so
			// this remains correct even when the relaunch has a different terminal id.
			if (
				breadcrumb.fresh &&
				!breadcrumb.exists &&
				(!sessionDir || pathIsWithin(dir, path.dirname(breadcrumb.sessionFile)))
			) {
				const manager = new SessionManager(cwd, dir, true, storage);
				manager.#resetToNewSession();
				return manager;
			}

			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				if (!sessionDir || pathIsWithin(dir, breadcrumb.sessionFile)) {
					chosenSession = breadcrumb.sessionFile;
				}
			} else {
				// The terminal's last session started in a different cwd. Re-root only
				// when that cwd is gone *and* this location is the same directory
				// inode (a worktree move/rename). A missing path alone is not a move.
				// When an explicit sessionDir is reused across the move, the stale
				// breadcrumb file may be the newest entry there; prefer a genuine
				// current-cwd session.
				let newestInTargetDir = await findMostRecentNonEmptySession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd &&
							!isEmptySession(session),
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const candidateForMove =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				// Absence of the recorded cwd is not a move: deleted, unmounted, and
				// offline paths also fail existsSync. Only re-root when the continue
				// cwd is the same directory inode the breadcrumb recorded — a rename.
				// Cross-filesystem `mv` (new inode) is intentionally not a re-root.
				const looksLikeMovedProject =
					candidateForMove && hasPositiveMovedProjectEvidence(breadcrumb.cwdIdentity, resolvedCwd);
				if (looksLikeMovedProject) {
					logger.warn("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					// The breadcrumb names this session, as a file named to `--resume` is named.
					const continuation = await findSessionContinuation(breadcrumb.sessionFile, storage);
					const manager = await SessionManager.open(
						continuation?.session.path ?? breadcrumb.sessionFile,
						undefined,
						storage,
						{ initialCwd: breadcrumbCwd },
					);
					try {
						await manager.moveTo(cwd, sessionDir);
						if (continuation) options.onSessionContinuation?.(continuation);
						return manager;
					} catch (err) {
						if (!(err instanceof SessionMoveRefusedError)) throw err;
						// Another live omp process still writes the session (the
						// project was renamed under it): leave it there and continue
						// as if no move were possible.
						logger.warn("Not re-rooting moved session: it is open in another omp process", {
							from: breadcrumbCwd,
							to: resolvedCwd,
						});
						await manager.close();
					}
				} else if (candidateForMove) {
					logger.warn(
						"Not relocating session: project directory is unavailable and there is no evidence it moved here",
						{ from: breadcrumbCwd, to: resolvedCwd },
					);
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentNonEmptySession(dir, storage);
		if (chosenSession) {
			const fromBreadcrumb = !!breadcrumb && path.resolve(chosenSession) === path.resolve(breadcrumb.sessionFile);
			const continuation = fromBreadcrumb
				? await findSessionContinuation(chosenSession, storage)
				: await findRecentSessionContinuation(chosenSession, storage);
			if (continuation) {
				options.onSessionContinuation?.(continuation);
				chosenSession = continuation.session.path;
			}
		}

		const manager = new SessionManager(cwd, dir, true, storage);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else manager.#resetToNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const sessions = await listSessions(dir, storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/** List all sessions across all project directories, pinned sessions first. */
	static async listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		const sessions = await listAllSessions(storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/**
	 * Picker-facing project list in recency order (the picker floats pins),
	 * untitled empties dropped. Titled empties stay — a title is user intent worth resuming.
	 * By default includes the same folder in the repository's other git worktrees,
	 * so a session `/wt` moved stays reachable from the checkout it left.
	 * The directory scope limits the picker to its own session bucket.
	 */
	static async listForPicker(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		worktreeScope: "directory" | "repo" = "repo",
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const [pinned, siblingDirs] = await Promise.all([
			loadPinnedSessionIds(),
			worktreeScope === "repo" ? worktreeSessionDirs(cwd, dir) : [],
		]);
		return filterSessionsForPicker(await listSessions(dir, storage, siblingDirs), pinned);
	}

	/** Picker-facing cross-project list, same empty-session rule as {@link listForPicker}. */
	static async listAllForPicker(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return filterSessionsForPicker(await listAllSessions(storage), await loadPinnedSessionIds());
	}
}

/** True when already-loaded entries carry at least one real user/assistant message. */
export function hasConversationalHistory(entries: readonly FileEntry[]): boolean {
	return entries.some(e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
}

/**
 * The persisted `session_init` contract a cold revive rebuilds a subagent from:
 * the {@link SessionInitEntry} payload without its tree bookkeeping fields.
 */
export interface PersistedSessionInit {
	systemPrompt: string[];
	task: string;
	tools: string[];
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	perCallModel?: boolean;
	perCallModelIdentity?: string;
	perCallThinkingLevel?: ConfiguredThinkingLevel | null;
	retryFallback?: RetryFallbackRole;
	readOnly?: boolean;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	restrictToolNames?: boolean;
	spawns?: string;
	readSummarize?: boolean;
	advisor?: string;
	compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
	isolated?: boolean;
	workPoolYieldItems?: WorkPoolYieldItem[];
}

/**
 * Latest persisted `session_init` contract among already-loaded entries, or
 * null when the transcript carries none.
 */
export function extractSessionInit(entries: readonly FileEntry[]): PersistedSessionInit | null {
	let init: PersistedSessionInit | null = null;
	for (const entry of entries) {
		if (entry.type !== "session_init") continue;
		init = {
			systemPrompt: typeof entry.systemPrompt === "string" ? [entry.systemPrompt] : entry.systemPrompt,
			task: entry.task,
			tools: entry.tools,
			agent: entry.agent,
			modelRole: entry.modelRole,
			resolvedModel: entry.resolvedModel,
			...(entry.perCallModel ? { perCallModel: true } : undefined),
			perCallModelIdentity: entry.perCallModelIdentity,
			perCallThinkingLevel: entry.perCallThinkingLevel,
			retryFallback: entry.retryFallback,
			readOnly: entry.readOnly,
			outputSchema: entry.outputSchema,
			outputSchemaMode: entry.outputSchemaMode,
			restrictToolNames: entry.restrictToolNames,
			readSummarize: entry.readSummarize,
			spawns: entry.spawns,
			advisor: entry.advisor,
			isolated: entry.isolated,
			...(entry.compactionThreshold !== undefined ? { compactionThreshold: entry.compactionThreshold } : undefined),
			...(entry.workPoolYieldItems !== undefined ? { workPoolYieldItems: entry.workPoolYieldItems } : undefined),
		};
	}
	return init;
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	if (hasConversationalHistory(sessionManager.getEntries())) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
