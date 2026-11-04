import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { isCompressScratchPath } from "@oh-my-pi/omp-stats/parser";
import {
	formatBytes,
	getAgentDir,
	getBlobsDir,
	getConfigRootDir,
	getCustomSessionFilesDir,
	getHistoryDbPath,
	getModelDbPath,
	getReportsDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
	normalizePathForComparison,
	readLines,
	type FileLockHandle,
} from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { Setting } from "../config/registry";

import { BLOB_HASH_RE, BLOB_STAGING_RE, blobStagingPath } from "../session/blob-store";
import { listSessionsReadOnly, type SessionInfo, type SessionStatus } from "../session/session-listing";
import { parseTerminalBreadcrumb } from "../session/session-paths";
import {
	archiveIsPrefixOfLive,
	findArchivedSessionFiles,
	getArchivedSessionsDir,
	inflateArchivedBytes,
	isArchivedSessionPath,
	listArchivedSessionFiles,
	agentDirFlag,
	archivedHandleIsHeldBy,
	bytesOfHandle,
	copyHandleWithDigest,
	digestOfHandle,
	handleBeginsWith,
	archivedPathsWithoutLiveCopies,
	holdsCopied,
	mintStagingGround,
	publishedIsStaged,
	surveyRecordedStagingGrounds,
	removeStagingGround,
	stagingLedgerDir,
	restoreRecordPath,
	shellQuote,
	archivedHandleIsPrefixOfLive,
	isSamePath,
	bytesOfRegularFile,
	liveSessionPathForArchive,
	restoreArchivedSessionLocked,
	newRestorePlan,
	moveAsidePermission,
	stagingResidueNote,
	stagingResidueUnder,
	directoryModeFor,
	getReclaimedSessionsDir,
	reclaimedArtifactsPath,
	reclaimedContainerPath,
	reclaimedTranscriptPath,
	type CopiedBytes,
	type StagingGround,
} from "../session/session-archive";
import { codeOf, statIfPresent, withGcLock, withoutGcLock } from "../session/gc-lock";
import { RegularFileSessionStorage, readRegularSessionInfo } from "../session/gc-session-storage";
import { type NoReplaceRename, renameNoReplace } from "../session/libc";
import {
	describeOpenFileHolder,
	type OpenFileHolder,
	type OpenFileHolders,
	openFileHolders,
	ownDescriptorCount,
	type SoleOpenLease,
	soleOpenLeaseStands,
	takeSoleOpenLease,
} from "../session/open-file-holders";
import {
	absentFile,
	type HeldDirectoryRemoval,
	type HeldFile,
	holdSeenDirectory,
	kindOf,
	makeHeldDirectory,
	NotARegularFile,
	notRegularAsAbsent,
	openRegularFile,
	removeFileOthersMayWrite,
	removeHeldDirectory,
	renameRefusal,
} from "../session/regular-file";
import { readSessionHeaderIdFromHandle } from "../session/session-loader";
import { tryAcquireSessionLease } from "../session/session-storage";
import {
	type CompressCandidate,
	type CompressMethod,
	compressCandidate,
	compressFilesInPlace,
	compressionWorks,
	compressMethod,
	sweepCompressScratch,
} from "./gc-compress";
import {
	cfgGcArchive,
	cfgGcBlobs,
	cfgGcColdArchiveAfterDays,
	cfgGcCompress,
	cfgGcCompressAfterDays,
	cfgGcRetainNewestGlobal,
	cfgGcRetainNewestPerCwd,
	cfgGcStale,
	cfgGcStaleRetainDays,
	cfgGcStaleRetainNewest,
	cfgGcWal,
} from "./gc-settings";

const BLOB_FILE_RE = /^([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
const JSONL_GLOB = new Bun.Glob("**/*.jsonl");
const ANY_FILE_GLOB = new Bun.Glob("**/*");
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["pending", "interrupted", "unknown"]);
const DAY_MS = 86_400_000;
const GC_WRITE_GRACE_MS = 5 * 60_000;
const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
/** Bytes sampled to rule out a session header before streaming an artifact. */
const HEADER_SNIFF_BYTES = 4096;
/**
 * Minimum age before a dangling session pointer is pruned. A lazy session's
 * marker and fresh breadcrumb name a transcript that is not on disk until its
 * first turn, so an idle-but-open session must keep them well past the
 * write grace.
 */
const STALE_POINTER_GRACE_MS = DAY_MS;

export interface GcCommandFlags {
	apply?: boolean;
	json?: boolean;
	agentDir?: string;
	blobs?: boolean;
	archive?: boolean;
	wal?: boolean;
	stale?: boolean;
	compress?: boolean;
	/**
	 * The operator accepts that reclaiming is forward-only: the live copy moves
	 * into the archive, and an omp without `gc --restore` cannot find or read it there.
	 * Required by `--reclaim --apply`.
	 */
	forwardOnly?: boolean;
	/** Session id prefix or archive path to bring back out of the archive. */
	restore?: string;
	/** Session id prefix or archive path whose live copy should move into the archive. */
	reclaim?: string;
	coldArchiveAfterDays?: number;
	retainNewestGlobal?: number;
	retainNewestPerCwd?: number;
	staleRetainNewest?: number;
	staleRetainDays?: number;
	compressAfterDays?: number;
}

export interface GcCommandArgs {
	flags: GcCommandFlags;
}

export interface BlobGcResult {
	referenced: number;
	candidates: number;
	wouldDelete: number;
	deleted: number;
	bytes: number;
	errors: string[];
}

export interface ArchiveGcResult {
	/**
	 * Where the archive phase puts transcripts, and — until a run brings one
	 * back — the only place it exists. An omp without `gc --restore` neither
	 * searches this directory nor inflates what is in it.
	 */
	archiveDir: string;
	/** Undefined when the session listing could not be completed. */
	scanned?: number;
	skippedActive: number;
	keptNewestGlobal: number;
	keptNewestPerCwd: number;
	wouldArchive: number;
	archived: number;
	/**
	 * Staging directories killed `gc` runs recorded and left. Reported, never
	 * removed: a record is not proof a run made the directory. A restore of
	 * the session leaves it in the archive, names it and does not finish.
	 */
	stagingResidue?: string[];
	/**
	 * Staging records whose directory is gone, kept in the ledger: a later
	 * run removes nothing it did not make. Such a record narrows nothing a
	 * restore does, so it can be moved out of the ledger by hand.
	 */
	stagingRecordsWithoutDirectory?: string[];
	/** Broken links skipped while copying; undefined when the count could not be completed or was not taken. */
	brokenLinks?: number;
	errors: string[];
}

/** What `--reclaim` gave back, on the one session it was asked about. */
export interface ReclaimGcResult {
	/** What the caller asked for: a session id prefix or an archive path. */
	query: string;
	archivePath?: string;
	sessionPath?: string;
	/** 1 when the live originals moved into the archive, 0 when they did not and the reason is in `errors`. */
	reclaimed: number;
	/** 1 when a preview found nothing to refuse, so applying would move the live originals into the archive. */
	wouldReclaim?: number;
	/**
	 * Where the live transcript and artifact tree are now, moved by rename into
	 * the archive beside their copies — set when they moved, and when a reclaim
	 * that stopped could not move one back, with `reclaimed` 0 and the error
	 * saying how to bring it home.
	 */
	moved?: { transcript?: string; artifacts?: string };
	/** Archived copies this run deleted, each because the moved original beside it holds every byte it held. */
	freedCopies?: string[];
	/** Archived copies this run kept beside a moved original, each with why and where; also in `errors`. */
	keptCopies?: string[];
	/**
	 * Archived copies this run unlinked and then could not write back whole —
	 * the original changed in the call before the unlink, and the disk or a
	 * file size limit stopped the write-back — each saying how many bytes the
	 * written-back file holds; also in `errors`.
	 */
	lostCopies?: string[];
	/** The live artifact tree a refused reclaim left where it was, with the reason in `errors`. */
	keptArtifactTree?: string;
	errors: string[];
}

export interface RestoreGcResult {
	/** What the caller asked for: a session id prefix or an archive path. */
	query: string;
	archivePath?: string;
	sessionPath?: string;
	bytes: number;
	artifactsRestored: boolean;
	/** What restoring the transcript does not bring back, in words a caller can print. */
	notRestored: string[];
	/**
	 * In a preview, the archived artifact entries the live tree lacks, which
	 * applying would bring home — relative to the artifact tree, a missing
	 * directory named once. A live transcript over part of its tree is a
	 * session that opens short, and a preview that said nothing about it
	 * reported nothing to do.
	 */
	missingArtifacts?: string[];
	/**
	 * Live names a reclaimed original was moved back to by rename — or, in a
	 * preview, would be — the transcript, the artifact tree, or both.
	 */
	movedHome?: string[];
	/**
	 * Where a record a dead restore left at `<archive>.restoring` was set
	 * aside, whole — or, in a preview, the record applying would set aside.
	 */
	setAsideRecord?: string;
	errors: string[];
}

export interface WalCheckpointResult {
	dbPath: string;
	walBytes: number;
	wouldCheckpoint: boolean;
	checkpointed: boolean;
	busy: number;
	log: number;
	checkpointedFrames: number;
}

export interface WalGcResult {
	databases: WalCheckpointResult[];
	walBytes: number;
	wouldCheckpoint: boolean;
	checkpointed: boolean;
}

export interface StaleGcResult {
	/** Custom-session-file markers whose recorded transcript is gone. */
	danglingMarkers: number;
	/** Terminal breadcrumbs whose session file is gone. */
	staleBreadcrumbs: number;
	/** Debug report bundles beyond the retention window. */
	expiredReports: number;
	/** Collab guest replicas beyond the retention window. */
	expiredReplicas: number;
	wouldDelete: number;
	deleted: number;
	bytes: number;
	errors: string[];
}

export interface CompressGcResult {
	/** False when the sessions' filesystem has no supported transparent compression; nothing was scanned. */
	supported: boolean;
	/** The filesystem's compression method when supported. */
	method?: CompressMethod;
	/**
	 * With `--apply`, why a probe file showed the filesystem does not actually
	 * compress (e.g. macOS 27 `ditto`); set means no session was scanned.
	 */
	probeFailure?: string;
	/** Undefined when the session listing could not be completed. */
	scanned?: number;
	/** Idle sessions with files to compress that a running process still owns. */
	skippedLive: number;
	/** Sessions with at least one file still stored uncompressed. */
	sessions: number;
	wouldCompress: number;
	compressed: number;
	/** Logical bytes of the files selected for compression. */
	bytes: number;
	/** Bytes those files allocated on disk before compression. */
	allocatedBefore: number;
	/** Bytes the selected files allocate on disk afterwards (`--apply` only). */
	allocatedAfter: number;
	/** Scratch directories a killed run left behind; removed with `--apply`. */
	leftoverScratchDirs: number;
	errors: string[];
}

export interface GcResult {
	agentDir: string;
	apply: boolean;
	stale?: StaleGcResult;
	blobs?: BlobGcResult;
	archive?: ArchiveGcResult;
	restore?: RestoreGcResult;
	reclaim?: ReclaimGcResult;
	compress?: CompressGcResult;
	wal?: WalGcResult;
	lockPath: string;
	/**
	 * What this run could not remove of its own gc locks: left behind, a lock
	 * names this process, and every later run while it lives reads it as
	 * held. Also in the errors {@link collectGcErrors} gathers.
	 */
	lockNotReleased?: string[];
}

interface BlobCandidate {
	hash: string;
	paths: string[];
	bytes: number;
	mtimeMs: number;
}

interface BlobStagingFile {
	path: string;
	bytes: number;
	mtimeMs: number;
}

interface BlobScan {
	candidates: BlobCandidate[];
	staging: BlobStagingFile[];
}

interface ArchiveCandidate {
	session: SessionInfo;
	relativePath: string;
	destinationPath: string;
	/** The `--agent-dir` suffix an instruction this run prints needs to be runnable. */
	recovery: string;
	/** Where this run records the staging directories it mints. */
	ledger: string;
}

interface ResolvedGcOptions {
	apply: boolean;
	json: boolean;
	agentDir: string;
	/** Whether `--agent-dir` was named, so an instruction this prints can be copied literally. */
	agentDirWasGiven: boolean;
	runBlobs: boolean;
	runArchive: boolean;
	runWal: boolean;
	runStale: boolean;
	runCompress: boolean;
	/** Set by `--forward-only`: `--reclaim --apply` may move a live copy into the archive. */
	forwardOnly: boolean;
	/** Set by `--restore`; it runs alone, since no sweep may race a restore. */
	restoreTarget?: string;
	/** Set by `--reclaim`; it runs alone, and it is the only phase that deletes a live session. */
	reclaimTarget?: string;
	/** Phase flags the caller passed, so `--restore` can refuse to drop them. */
	explicitPhases: string[];
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
	staleRetainNewest: number;
	staleRetainDays: number;
	compressAfterDays: number;
}

interface WalCheckpointRow {
	busy?: number | bigint | null;
	log?: number | bigint | null;
	checkpointed?: number | bigint | null;
}

function normalizeNumberSetting(value: unknown, defaultValue: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
	return Math.max(0, Math.floor(value));
}

function numberSetting(value: number | undefined, fallback: unknown, defaultValue: number): number {
	if (value !== undefined && Number.isFinite(value)) return Math.max(0, Math.floor(value));
	return normalizeNumberSetting(fallback, defaultValue);
}

async function resolveOptions(flags: GcCommandFlags): Promise<ResolvedGcOptions> {
	const agentDir = path.resolve(flags.agentDir ?? getAgentDir());
	// An empty `--restore` names no session. Reading it as "no --restore given"
	// would run the configured phases instead — archiving sessions and sweeping
	// blobs for a command that asked for a restore.
	if (flags.restore !== undefined && flags.restore.trim() === "") {
		throw new Error("--restore needs a session id or the path of a file in the archive");
	}
	const selected =
		flags.blobs === true ||
		flags.archive === true ||
		flags.wal === true ||
		flags.stale === true ||
		flags.compress === true;
	const archiveSelected = selected && flags.archive === true;
	const staleSelected = selected && flags.stale === true;
	const compressSelected = selected && flags.compress === true;
	const needsArchiveSettings =
		archiveSelected &&
		(flags.coldArchiveAfterDays === undefined ||
			flags.retainNewestGlobal === undefined ||
			flags.retainNewestPerCwd === undefined);
	const needsStaleSettings =
		staleSelected && (flags.staleRetainNewest === undefined || flags.staleRetainDays === undefined);
	const needsCompressSettings = compressSelected && flags.compressAfterDays === undefined;
	// A restore and a reclaim run alone and read no setting, so they load
	// none: loading is not a read. `Settings.loadIsolated` migrates a legacy
	// agent directory on the way in — it renames `settings.json` onto
	// `settings.json.bak`, replacing a backup already there — and a review
	// lost that backup's only copy to both commands, each exiting 0.
	const runsAlone = flags.restore !== undefined || flags.reclaim !== undefined;
	const needsSettings =
		!runsAlone && (!selected || needsArchiveSettings || needsStaleSettings || needsCompressSettings);
	// Read-only first, always: a run this gate refuses must leave the agent
	// directory exactly as it found it.
	const configured = needsSettings ? await Settings.loadReadOnly({ agentDir, readLegacyIfNoConfig: true }) : undefined;
	const runArchive = selected
		? flags.archive === true
		: configured
			? cfgGcArchive.get(configured)
			: cfgGcArchive.default;
	// Archiving copies and keeps both sides, so by itself it hides nothing from
	// any reader. Moving the live copy into the archive is the step an omp
	// without `gc --restore` cannot follow: such a release searches `*.jsonl`
	// under the sessions tree, so what is in `archive/sessions` is invisible
	// to it. Pin a machine back to one of those after reclaiming and its own
	// sessions stop resuming until someone moves them back by hand. Refusing
	// here, before the gc lock and before settings are migrated, leaves the
	// agent directory exactly as it was found.
	if (flags.reclaim !== undefined && flags.apply === true && flags.forwardOnly !== true) {
		const archiveRoot = getArchivedSessionsDir(agentDir);
		throw new Error(
			`--reclaim --apply moves the live copy into the archive, leaving the session only in ${archiveRoot}, where only an omp with \`gc --restore\` can find it; ` +
				`a release pinned back from this one cannot resume it, and moving one back by hand is \`mv -n "${getReclaimedSessionsDir(agentDir)}/<bucket>/<file>/<file>.jsonl" "<sessions>/<bucket>/<file>.jsonl"\` and \`mv -n "${getReclaimedSessionsDir(agentDir)}/<bucket>/<file>/<file>" "<sessions>/<bucket>/<file>"\`. ` +
				`Pass --forward-only to accept that. \`omp gc --archive --apply${agentDirFlag(agentDir)}\` copies without moving anything and needs no such flag.`,
		);
	}
	const settings = needsSettings && flags.apply === true ? await Settings.loadIsolated({ agentDir }) : configured;
	const read = <T>(setting: Setting<T>): T => (settings ? setting.get(settings) : setting.default);
	return {
		apply: flags.apply === true,
		json: flags.json === true,
		agentDir,
		agentDirWasGiven: flags.agentDir !== undefined,
		forwardOnly: flags.forwardOnly === true,
		restoreTarget: flags.restore?.trim(),
		reclaimTarget: flags.reclaim?.trim(),
		explicitPhases: (["blobs", "archive", "wal", "stale", "compress"] as const).filter(
			phase => flags[phase] === true,
		),
		runBlobs: selected ? flags.blobs === true : read(cfgGcBlobs),
		runArchive,
		runWal: selected ? flags.wal === true : read(cfgGcWal),
		runStale: selected ? flags.stale === true : read(cfgGcStale),
		runCompress: selected ? flags.compress === true : read(cfgGcCompress),
		coldArchiveAfterDays: numberSetting(
			flags.coldArchiveAfterDays,
			read(cfgGcColdArchiveAfterDays),
			cfgGcColdArchiveAfterDays.default,
		),
		retainNewestGlobal: numberSetting(
			flags.retainNewestGlobal,
			read(cfgGcRetainNewestGlobal),
			cfgGcRetainNewestGlobal.default,
		),
		retainNewestPerCwd: numberSetting(
			flags.retainNewestPerCwd,
			read(cfgGcRetainNewestPerCwd),
			cfgGcRetainNewestPerCwd.default,
		),
		staleRetainNewest: numberSetting(
			flags.staleRetainNewest,
			read(cfgGcStaleRetainNewest),
			cfgGcStaleRetainNewest.default,
		),
		staleRetainDays: numberSetting(flags.staleRetainDays, read(cfgGcStaleRetainDays), cfgGcStaleRetainDays.default),
		compressAfterDays: numberSetting(
			flags.compressAfterDays,
			read(cfgGcCompressAfterDays),
			cfgGcCompressAfterDays.default,
		),
	};
}

export function collectGcErrors(result: GcResult): string[] {
	return [
		...(result.stale?.errors ?? []).map(error => `stale: ${error}`),
		...(result.blobs?.errors ?? []).map(error => `blobs: ${error}`),
		...(result.archive?.errors ?? []).map(error => `archive: ${error}`),
		...(result.restore?.errors ?? []).map(error => `restore: ${error}`),
		...(result.reclaim?.errors ?? []).map(error => `reclaim: ${error}`),
		...(result.compress?.errors ?? []).map(error => `compress: ${error}`),
		...(result.lockNotReleased ?? []).map(note => `lock: ${note}`),
	];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return false;
		throw error;
	}
}

/** Small registry/breadcrumb marker files; a missing file reads as empty. */
async function readTextIfPresent(file: string): Promise<string> {
	const handle = await openRegularFile(file);
	if (!handle) return "";
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function scanSessionLinesIfPresent(file: string, onLine: (line: Uint8Array) => void): Promise<void> {
	// readLines buffers at most the largest record, including malformed records.
	const scan = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const line of readLines(stream)) onLine(line);
	};
	try {
		// Compressed or not by what the file holds, not by its name: a `.leaving`
		// copy of a `.leaving` copy of an archived transcript ends in neither
		// suffix, and a review swept the blob only its gzip bytes referenced.
		// Read through a descriptor that holds a regular file: a transcript's
		// name standing for a FIFO is refused, never waited on or drained.
		const head = await openRegularFile(file);
		if (!head) return;
		const magic = Buffer.alloc(2);
		try {
			await head.read(magic, 0, 2, 0);
		} finally {
			await head.close();
		}
		const stream = Readable.toWeb(Readable.from(bytesOfRegularFile(file))) as ReadableStream<Uint8Array>;
		if (file.endsWith(COMPRESSED_SESSION_SUFFIX) || (magic[0] === 0x1f && magic[1] === 0x8b)) {
			const gunzip = createGunzip();
			await pipeline(stream, gunzip, async (source: NodeJS.ReadableStream) => {
				// Match the native stream's byte budget, not one arbitrary chunk or
				// a default queue that counts each potentially large chunk as size 1.
				await scan(
					Readable.toWeb(source, {
						strategy: new ByteLengthQueuingStrategy({ highWaterMark: gunzip.readableHighWaterMark }),
					}),
				);
			});
		} else {
			await scan(stream);
		}
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
		throw error;
	}
}

/**
 * `followSymlinks` throughout: a transcript placed in a session directory as a
 * symlink is a transcript like any other, and a blob it references must not be
 * swept because the walk could not see it.
 */
async function scanSessionTree(glob: Bun.Glob, root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(glob.scan({ cwd: root, followSymlinks: true }), name =>
			path.join(root, name),
		);
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	return scanSessionTree(JSONL_GLOB, root);
}

/**
 * Every name under a session root that can hold a transcript a reader or a
 * restore may take up, hidden names included: a transcript, an archived one,
 * a backup, and the private `.<name>.<16 hex digits>.leaving` name a run
 * killed while moving one aside leaves (`regular-file.ts`), which a restore
 * carries home as an artifact; and a staged copy inside a hidden staging
 * directory, which keeps its transcript's own name. A review killed a reclaim
 * while it freed a subagent transcript's copy, swept the blob only that
 * `.leaving` copy referenced, and a restore then brought the copy home
 * without it.
 */
const BLOB_REFERENCE_GLOBS = ["**/*.jsonl", "**/*.jsonl.gz", "**/*.jsonl.*.bak", "**/*.jsonl.*.leaving"].map(
	pattern => new Bun.Glob(pattern),
);

async function collectReferencedBlobHashes(sessionRoots: string[], exactSessionFiles: string[]): Promise<Set<string>> {
	const files = new Map<string, string>();
	const decoder = new TextDecoder();
	for (const root of sessionRoots) {
		for (const glob of BLOB_REFERENCE_GLOBS) {
			let names: string[];
			try {
				names = await Array.fromAsync(glob.scan({ cwd: root, followSymlinks: true, dot: true }));
			} catch (error) {
				if (codeOf(error) === "ENOENT") continue;
				throw error;
			}
			for (const name of names) {
				const file = path.join(root, name);
				files.set(normalizePathForComparison(file), file);
			}
		}
	}
	for (const file of exactSessionFiles) {
		files.set(normalizePathForComparison(file), file);
	}

	const hashes = new Set<string>();
	for (const file of files.values()) {
		// Keep raw-text matching: recoverable malformed records can still own blobs.
		await scanSessionLinesIfPresent(file, line => {
			for (const match of decoder.decode(line).matchAll(BLOB_REF_RE)) {
				const hash = match[1]?.toLowerCase();
				if (hash && BLOB_HASH_RE.test(hash)) hashes.add(hash);
			}
		});
	}
	return hashes;
}

/**
 * Paths recorded in the persistent registry (`<agentDir>/custom-session-files/*`).
 * A first save may leave only its staging temp, so the target need not exist
 * when reclaiming crash leftovers.
 */
async function collectRegisteredSessionPaths(registryDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(registryDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	const files = new Map<string, string>();
	for (const entry of entries) {
		const recorded = (await readTextIfPresent(path.join(registryDir, entry))).trim();
		if (!recorded) continue;
		const sessionFile = path.resolve(recorded);
		files.set(normalizePathForComparison(sessionFile), sessionFile);
	}
	return [...files.values()];
}

/**
 * Exact session files recorded in terminal breadcrumbs. Supplements
 * {@link collectRegisteredSessionFiles}: a breadcrumb holds only that
 * terminal's last session, but catches the current transcript even if its
 * persistent marker write failed.
 */
async function collectBreadcrumbSessionFiles(breadcrumbDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(breadcrumbDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	const files = new Map<string, string>();
	for (const entry of entries) {
		const text = await readTextIfPresent(path.join(breadcrumbDir, entry));
		const lines = text.split("\n");
		const breadcrumbCwd = lines[0]?.trim();
		const recordedSessionFile = lines[1]?.trim();
		if (!breadcrumbCwd || !recordedSessionFile) continue;
		const sessionFile = path.resolve(breadcrumbCwd, recordedSessionFile);
		files.set(normalizePathForComparison(sessionFile), sessionFile);
	}
	return [...files.values()];
}

async function collectBlobCandidates(blobDir: string): Promise<BlobScan> {
	let entries: string[];
	try {
		entries = await fs.readdir(blobDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { candidates: [], staging: [] };
		throw error;
	}

	const byHash = new Map<string, BlobCandidate>();
	const staging: BlobStagingFile[] = [];
	for (const entry of entries) {
		const isStaging = BLOB_STAGING_RE.test(entry);
		const hash = isStaging ? undefined : entry.match(BLOB_FILE_RE)?.[1];
		if (!isStaging && !hash) continue;
		const file = path.join(blobDir, entry);
		const stat = await statIfPresent(file);
		if (!stat) continue;
		if (!stat.isFile()) continue;
		if (!hash) {
			staging.push({ path: file, bytes: stat.size, mtimeMs: stat.mtimeMs });
			continue;
		}
		const candidate = byHash.get(hash) ?? { hash, paths: [], bytes: 0, mtimeMs: stat.mtimeMs };
		candidate.paths.push(file);
		candidate.bytes += stat.size;
		candidate.mtimeMs = Math.max(candidate.mtimeMs, stat.mtimeMs);
		byHash.set(hash, candidate);
	}
	return { candidates: [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash)), staging };
}

async function unlinkBlobFile(file: string, result: BlobGcResult): Promise<void> {
	try {
		await fs.unlink(file);
		result.deleted += 1;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
		result.errors.push(`${file}: ${errorMessage(error)}`);
	}
}

/**
 * Delete an unreferenced candidate unless a put reused its blob after the
 * candidate scan. `BlobStore.put` refreshes an old reused blob's mtime before
 * its new reference reaches a session file, and rewrites the blob when that
 * touch finds the path gone. The canonical file is therefore moved to a
 * staging name first: a touch that landed before the move shows on the moved
 * file, which goes back; one that lands after misses the path, so the put
 * writes the blob again. Returns whether the candidate was deleted.
 */
async function deleteBlobCandidate(
	candidate: BlobCandidate,
	deleteBeforeMs: number,
	result: BlobGcResult,
): Promise<boolean> {
	const canonical = candidate.paths.find(file => path.basename(file) === candidate.hash);
	const files = candidate.paths.filter(file => file !== canonical);
	if (canonical) {
		const moved = blobStagingPath(canonical);
		try {
			await fs.rename(canonical, moved);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") {
				result.errors.push(`${canonical}: ${errorMessage(error)}`);
				return false;
			}
		}
		const stat = await statIfPresent(moved);
		if (stat && stat.mtimeMs > deleteBeforeMs) {
			await restoreReusedBlob(moved, canonical, result);
			return false;
		}
		if (stat) files.unshift(moved);
	}
	for (const file of files) await unlinkBlobFile(file, result);
	return true;
}

/** Put a blob reused mid-sweep back; a put that already rewrote it wins (same bytes). */
async function restoreReusedBlob(moved: string, canonical: string, result: BlobGcResult): Promise<void> {
	try {
		await fs.rename(moved, canonical);
		return;
	} catch (error) {
		result.errors.push(`${canonical}: failed to restore reused blob: ${errorMessage(error)}`);
		if (!(await statIfPresent(canonical))) {
			return;
		}
	}
	try {
		await fs.unlink(moved);
	} catch (error) {
		if (codeOf(error) !== "ENOENT")
			result.errors.push(`${moved}: could not remove staging blob: ${errorMessage(error)}`);
	}
}

async function runBlobGc(options: ResolvedGcOptions, archiveSessionsRoot: string): Promise<BlobGcResult> {
	const blobDir = getBlobsDir(options.agentDir);
	const sessionsRoot = getSessionsDir(options.agentDir);
	const defaultRoots = [sessionsRoot, archiveSessionsRoot, getReclaimedSessionsDir(options.agentDir)];
	const exactSessionFiles = new Map<string, string>();
	for (const file of await collectRegisteredSessionPaths(getCustomSessionFilesDir(options.agentDir))) {
		if (!(await statIfPresent(file))?.isFile()) continue;
		exactSessionFiles.set(normalizePathForComparison(file), file);
	}
	for (const file of await collectBreadcrumbSessionFiles(getTerminalSessionsDir(options.agentDir))) {
		exactSessionFiles.set(normalizePathForComparison(file), file);
	}
	const referenced = await collectReferencedBlobHashes(defaultRoots, [...exactSessionFiles.values()]);
	const { candidates, staging } = await collectBlobCandidates(blobDir);
	const result: BlobGcResult = {
		referenced: referenced.size,
		candidates: candidates.length,
		wouldDelete: 0,
		deleted: 0,
		bytes: 0,
		errors: [],
	};

	const deleteBeforeMs = Date.now() - GC_WRITE_GRACE_MS;
	for (const candidate of candidates) {
		if (referenced.has(candidate.hash)) continue;
		if (candidate.mtimeMs > deleteBeforeMs) continue;
		if (options.apply && !(await deleteBlobCandidate(candidate, deleteBeforeMs, result))) continue;
		result.wouldDelete += candidate.paths.length;
		result.bytes += candidate.bytes;
	}
	// A live write renames its staging file away within milliseconds; one past
	// the grace was left by a killed or crashed writer and nothing will claim it.
	for (const file of staging) {
		if (file.mtimeMs > deleteBeforeMs) continue;
		result.wouldDelete += 1;
		result.bytes += file.bytes;
		if (options.apply) await unlinkBlobFile(file.path, result);
	}
	return result;
}

interface StaleCandidate {
	kind: "danglingMarkers" | "staleBreadcrumbs" | "expiredReports" | "expiredReplicas";
	/** Removed together; the first path is the entry itself. */
	paths: string[];
	bytes: number;
	/** Session file whose ownership lease must be free (no running writer) to remove it. */
	ownedSession?: string;
}

/**
 * Config-root stores (`reports/`, `collab/`) live beside the agent dir, not in
 * it. The default agent dir resolves them through the dirs resolver (XDG-aware);
 * a custom agent dir named `agent` owns its parent as config root; any other
 * custom agent dir has no config root for gc to maintain.
 */
function resolveConfigRootStores(agentDir: string): { reportsDir: string; collabDir: string } | undefined {
	const configRoot = getConfigRootDir();
	if (normalizePathForComparison(agentDir) === normalizePathForComparison(path.join(configRoot, "agent"))) {
		return { reportsDir: getReportsDir(), collabDir: path.join(configRoot, "collab") };
	}
	if (path.basename(agentDir) !== "agent") return undefined;
	const root = path.dirname(agentDir);
	return { reportsDir: path.join(root, "reports"), collabDir: path.join(root, "collab") };
}

async function listFilesIfPresent(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter(entry => entry.isFile()).map(entry => path.join(dir, entry.name));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

/** Whether a pointer's target is verifiably gone; a failed lookup throws. */
async function sessionFileMissing(sessionFile: string): Promise<boolean> {
	try {
		return !(await fs.stat(sessionFile)).isFile();
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") return true;
		throw error;
	}
}

/**
 * Pointer files (custom-session markers, terminal breadcrumbs) past
 * {@link STALE_POINTER_GRACE_MS} whose recorded session file is gone.
 * `resolveTarget` returns undefined for unparsable pointers, which are kept.
 */
async function collectDanglingPointers(
	dir: string,
	kind: StaleCandidate["kind"],
	resolveTarget: (text: string) => string | undefined,
): Promise<StaleCandidate[]> {
	const deleteBeforeMs = Date.now() - STALE_POINTER_GRACE_MS;
	const candidates: StaleCandidate[] = [];
	for (const file of await listFilesIfPresent(dir)) {
		const stat = await statIfPresent(file);
		if (!stat || stat.mtimeMs > deleteBeforeMs) continue;
		const target = resolveTarget(await readTextIfPresent(file));
		if (!target || !(await sessionFileMissing(target))) continue;
		candidates.push({ kind, paths: [file], bytes: stat.size });
	}
	return candidates;
}

/**
 * Files beyond the newest `retainNewest` that are also older than
 * `retainDays` (and never inside the write grace).
 */
async function collectExpiredFiles(
	dir: string,
	suffix: string,
	options: ResolvedGcOptions,
): Promise<Array<{ file: string; bytes: number }>> {
	const files: Array<{ file: string; bytes: number; mtimeMs: number }> = [];
	for (const file of await listFilesIfPresent(dir)) {
		if (!file.endsWith(suffix)) continue;
		const stat = await statIfPresent(file);
		if (stat) files.push({ file, bytes: stat.size, mtimeMs: stat.mtimeMs });
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const deleteBeforeMs = Date.now() - Math.max(options.staleRetainDays * DAY_MS, GC_WRITE_GRACE_MS);
	return files.slice(options.staleRetainNewest).filter(entry => entry.mtimeMs < deleteBeforeMs);
}

async function runStaleGc(options: ResolvedGcOptions): Promise<StaleGcResult> {
	const markersDir = getCustomSessionFilesDir(options.agentDir);
	const breadcrumbDir = getTerminalSessionsDir(options.agentDir);
	const candidates: StaleCandidate[] = [
		...(await collectDanglingPointers(markersDir, "danglingMarkers", text => {
			const recorded = text.trim();
			return recorded ? path.resolve(recorded) : undefined;
		})),
		...(await collectDanglingPointers(breadcrumbDir, "staleBreadcrumbs", text => {
			const crumb = parseTerminalBreadcrumb(text);
			// A fresh crumb is a lazy `/new` boundary that `--continue` honors
			// before its transcript exists. It stays until the session materializes
			// (rewriting it non-fresh) or the terminal's next session replaces it.
			if (!crumb || crumb.fresh) return undefined;
			const cwd = crumb.cwd.trim();
			const sessionFile = crumb.sessionFile.trim();
			return cwd && sessionFile ? path.resolve(cwd, sessionFile) : undefined;
		})),
	];
	const stores = resolveConfigRootStores(options.agentDir);
	if (stores) {
		for (const { file, bytes } of await collectExpiredFiles(stores.reportsDir, ".tar.gz", options)) {
			candidates.push({ kind: "expiredReports", paths: [file], bytes });
		}
		// A replica a terminal's breadcrumb points at is what `--continue` resumes
		// there; one a running guest holds is skipped at removal (ownership lease).
		const resumable = new Set(
			(await collectBreadcrumbSessionFiles(breadcrumbDir)).map(file => normalizePathForComparison(file)),
		);
		for (const { file, bytes } of await collectExpiredFiles(stores.collabDir, SESSION_SUFFIX, options)) {
			if (resumable.has(normalizePathForComparison(file))) continue;
			candidates.push({
				kind: "expiredReplicas",
				// The replica's custom-session marker would only dangle once it is gone.
				paths: [file, sessionArtifactsPath(file), path.join(markersDir, hashPath(file))],
				bytes,
				ownedSession: file,
			});
		}
	}

	const result: StaleGcResult = {
		danglingMarkers: 0,
		staleBreadcrumbs: 0,
		expiredReports: 0,
		expiredReplicas: 0,
		wouldDelete: 0,
		deleted: 0,
		bytes: 0,
		errors: [],
	};
	for (const candidate of candidates) {
		const lease = candidate.ownedSession ? await tryAcquireSessionFileLease(candidate.ownedSession) : undefined;
		if (lease === null) continue;
		try {
			result[candidate.kind] += 1;
			result.wouldDelete += 1;
			result.bytes += candidate.bytes;
			if (!options.apply) continue;
			try {
				for (const target of candidate.paths) await fs.rm(target, { recursive: true, force: true });
				result.deleted += 1;
			} catch (error) {
				result.errors.push(`${candidate.paths[0]}: ${errorMessage(error)}`);
			}
		} finally {
			// Held through the removal so a guest cannot reopen the replica mid-delete.
			lease?.release();
		}
	}
	return result;
}

/** Take the session's lease; null means an observed owner, not a failed probe. */
async function tryAcquireSessionFileLease(sessionFile: string): Promise<FileLockHandle | null | undefined> {
	const sessionId = await readRegularSessionHeaderId(sessionFile);
	return sessionId === undefined ? undefined : tryAcquireSessionLease(sessionId);
}

/**
 * The session id in the header of the regular file at `file`; undefined when
 * nothing is there or it carries no session header. Opened through
 * {@link openRegularFile}, so a FIFO at a transcript's name — or put there
 * after a look at the name — is never waited on: it throws
 * {@link NotARegularFile}, as a read that fails throws its own error.
 */
async function readRegularSessionHeaderId(file: string): Promise<string | undefined> {
	const handle = await openRegularFile(file);
	if (!handle) return undefined;
	try {
		return await readSessionHeaderIdFromHandle(handle);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function listActiveSessions(sessionsRoot: string, errors: string[]): Promise<SessionInfo[]> {
	let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) !== "ENOENT" && codeOf(error) !== "ENOTDIR") {
			errors.push(`${sessionsRoot} could not be listed (${errorMessage(error)})`);
		}
		return [];
	}

	const storage = new RegularFileSessionStorage();
	const sessions: SessionInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			if (entry.isSymbolicLink())
				errors.push(`${path.join(sessionsRoot, entry.name)} is a symbolic link, not a session bucket`);
			continue;
		}
		sessions.push(...(await listSessionsReadOnly(path.join(sessionsRoot, entry.name), storage)));
	}
	errors.push(...storage.failureMessages);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const unreadable = new Set(storage.failures.map(failure => failure.file));
	return sessions.filter(session => !unreadable.has(session.path));
}

async function listNestedSessionsReadOnly(artifactsRoot: string): Promise<SessionInfo[]> {
	const files = await collectJsonlFiles(artifactsRoot);
	const dirs = [...new Set(files.map(file => path.dirname(file)))].sort();
	const storage = new RegularFileSessionStorage();
	const sessions: SessionInfo[] = [];
	for (const dir of dirs) sessions.push(...(await listSessionsReadOnly(dir, storage)));
	if (storage.failures.length > 0) throw new Error(storage.failureMessages.join("; "));
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

async function hasLiveNestedSessions(session: SessionInfo, archiveBeforeMs: number): Promise<boolean> {
	for (const nested of await listNestedSessionsReadOnly(sessionArtifactsPath(session.path))) {
		if (nested.status && ACTIVE_STATUSES.has(nested.status)) return true;
		if (nested.modified.getTime() > archiveBeforeMs) return true;
	}
	return false;
}

function archiveDestination(
	archiveRoot: string,
	sessionsRoot: string,
	session: SessionInfo,
): Omit<ArchiveCandidate, "session" | "recovery" | "ledger"> | null {
	const sessionPath = session.path;
	const relativePath = path.relative(sessionsRoot, sessionPath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	if (!relativePath.endsWith(SESSION_SUFFIX)) return null;
	return {
		relativePath,
		destinationPath: path.join(archiveRoot, `${relativePath}.gz`),
	};
}

function sessionCwdKey(sessionsRoot: string, session: SessionInfo): string {
	const relativePath = path.relative(sessionsRoot, session.path);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return session.cwd || ".";
	const dirname = path.dirname(relativePath);
	return dirname === "." ? session.cwd || "." : dirname;
}

function sessionArtifactsPath(sessionPath: string): string {
	if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
		return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
	}
	return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

/** SHA-256 and byte count of a stream, used to prove an archive inflates to its source. */
async function digestStream(stream: AsyncIterable<Uint8Array>): Promise<{ hash: string; bytes: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of stream) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), bytes };
}

/** SHA-256 and byte count of what an archived transcript inflates to. */
async function digestArchivedSessionFile(file: string): Promise<{ hash: string; bytes: number }> {
	let digest: { hash: string; bytes: number } | undefined;
	await pipeline(bytesOfRegularFile(file), createGunzip(), async (source: NodeJS.ReadableStream) => {
		digest = await digestStream(source as AsyncIterable<Uint8Array>);
	});
	if (!digest) throw new Error(`archive produced no bytes: ${file}`);
	return digest;
}

/**
 * A `holds` for {@link publishedIsStaged}: the published archive inflates to
 * exactly `expected`, the digest of the transcript it was compressed from.
 *
 * Read positionally, not through a read stream: a stream over a `FileHandle`
 * closes the descriptor on a schedule of its own, which moves the moment of
 * the last look this read-back depends on.
 */
function inflatesTo(expected: { hash: string; bytes: number }): (published: fs.FileHandle) => Promise<boolean> {
	return async published => {
		let digest: { hash: string; bytes: number } | undefined;
		await pipeline(bytesOfHandle(published), createGunzip(), async (inflated: NodeJS.ReadableStream) => {
			digest = await digestStream(inflated as AsyncIterable<Uint8Array>);
		});
		return digest?.hash === expected.hash && digest.bytes === expected.bytes;
	};
}

/**
 * Take back the name this run linked onto its stage, when that is all taking
 * it back removes. Returns what was left and why, for the command to print.
 *
 * The name is in the archive, where any process of this user can name it,
 * so it goes by {@link removeFileOthersMayWrite} and is judged on what the
 * move took, which must still have another name (`nlink > 1`), so only a name
 * goes, never a file's last. Two things can be there:
 *
 * - this run's staged file, held open since it was created: it goes only
 *   while it holds what this run wrote (`holds`). Bytes written to it by this
 *   name are in no other copy, and the stage's own name goes next by
 *   identity alone, so a file that no longer holds what this run wrote keeps
 *   this name, and the run names it;
 * - whatever the stage's name holds now, when that is not this run's file —
 *   a `link` from a rebound stage gave it this second name. It goes: its
 *   other name, at the stage, is not this run's, so the stage's clean-up
 *   keeps it and names it.
 *
 * Anything else at the name is somebody's, and is left and named. This runs
 * on the way out of a failure, so it reports rather than throws.
 */
async function withdrawLinkedPublication(
	destination: string,
	ground: StagingGround,
	holds: (moved: fs.FileHandle) => Promise<boolean>,
): Promise<string | undefined> {
	let staged: Stats | undefined;
	try {
		staged = await lstatIfPresent(ground.file);
	} catch (error) {
		return `${ground.file} could not be checked (${errorMessage(error)}), so the publication at ${destination} was left as it is`;
	}
	const isOwn = (entry: Stats): boolean => entry.dev === ground.held.dev && entry.ino === ground.held.ino;
	const linkedHere = (entry: Stats): boolean =>
		isOwn(entry) || (staged !== undefined && entry.dev === staged.dev && entry.ino === staged.ino);
	const notOurs = `${destination} is not what this run published there`;
	const result = await removeFileOthersMayWrite(destination, {
		matches: linkedHere,
		mismatch: notOurs,
		judge: async (moved, handle) => {
			if (!linkedHere(moved) || moved.nlink <= 1) return notOurs;
			if (!isOwn(moved)) return undefined;
			return handle && (await holds(handle)) ? undefined : notOurs;
		},
	});
	return result.outcome === "kept" ? result.note : undefined;
}

/**
 * Compress `source` into `destination` and prove what landed there.
 *
 * The archive is a copy: the live transcript stays where it is, so an
 * archive that turns out not to be what was compressed costs a retry and
 * nothing else. A run that reports success must not be holding an archive
 * that is somebody else's file, which is what the read-back is for — see
 * {@link publishedIsStaged}.
 *
 * A transcript can be a symlink, as `FileSessionStorage.listFilesSync`
 * already treats one as a transcript like any other. The compressed archive
 * holds its content either way, and the link and the file it names are both
 * left as they are.
 */
async function gzipSessionFile(
	source: string,
	destination: string,
	ledger: string,
	notes: string[],
	supersedes?: Stats,
): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	// The transcript is read through one descriptor from here on: its bytes,
	// its digest and, at the end, its mode. A file put at the live name
	// meanwhile is not what this run archives, so it lends the archive
	// nothing — its permissions least of all.
	const live = await openRegularFile(source);
	if (!live) throw absentFile(source);
	let ground: StagingGround;
	try {
		// A directory of this run's own minting, recorded so a later restore
		// leaves it out of the live tree if this run is killed before removing
		// it. The archive keeps the transcript's own mode: a private session
		// copied into the archive must not become readable by more than it was.
		ground = await mintStagingGround(destination, ledger, (await live.stat()).mode & 0o7777);
	} catch (error) {
		await live.close().catch(() => undefined);
		throw error;
	}
	let linked = false;
	// What the transcript digests to, which a withdrawn publication must
	// still inflate to: set before anything is linked.
	let expected: { hash: string; bytes: number } | undefined;
	try {
		await ground.handle.chmod((await live.stat()).mode & 0o7777);
		expected = await digestStream(bytesOfHandle(live));
		await pipeline(bytesOfHandle(live), createGzip({ level: 9 }), ground.handle.createWriteStream());
		// A failed look throws as it came: only a look that sees another file is a replacement.
		const stagedNow = await lstatIfPresent(ground.file);
		if (stagedNow?.dev !== ground.created.dev || stagedNow.ino !== ground.created.ino) {
			throw new Error(
				`${ground.file} was replaced while the archive was being written; run \`omp gc --archive\` again`,
			);
		}
		if (supersedes) {
			// The archive holds an earlier part of this very session — proved a
			// prefix of what is being written — so replacing it loses nothing,
			// and refusing would make a restored session unarchivable the moment
			// it takes another turn.
			//
			// Proved again here, by reading the file rather than its name,
			// through the very descriptor this check opened, and held open until
			// the shorter copy is gone, so no other file can take its inode
			// number. An inode comparison cannot see a replacement written in
			// place, and the earlier proof was taken before the stage existed,
			// so it is an observation about bytes that may since have changed.
			// Anything but a regular file at the archived name has changed.
			const archived = await openRegularFile(destination, { noFollow: true });
			const changed = `${destination} changed while it was being archived`;
			if (!archived) throw new Error(`${changed}; run \`omp gc --archive\` again`);
			try {
				// What the proof below reads, digested first: an append after this
				// read makes the file hold more than was proved, and the judgment
				// at the private name then keeps it.
				const proved = await digestOfHandle(archived);
				if (!(await archivedHandleIsPrefixOfLive(archived, source))) {
					throw new Error(`${changed}; run \`omp gc --archive\` again`);
				}
				const standing = await archived.stat();
				if (standing.dev !== supersedes.dev || standing.ino !== supersedes.ino) {
					throw new Error(`${changed}; run \`omp gc --archive\` again`);
				}
				// The shorter copy, a name any process of this user can write,
				// goes by `removeFileOthersMayWrite` — moved to a private name and
				// judged there to be the very file proved above, still holding
				// exactly the bytes proved: bytes written by its name between the
				// proof and the move are in no other copy — and the longer one is
				// linked in at its name before it goes. A rename onto the name
				// instead replaced whatever stood there by the time it ran.
				const replaced = await removeFileOthersMayWrite(destination, {
					matches: named => named.isFile() && named.dev === standing.dev && named.ino === standing.ino,
					mismatch: changed,
					judge: async (_moved, handle) => {
						const now = await handle?.stat();
						if (!handle || now?.dev !== standing.dev || now.ino !== standing.ino) return changed;
						const holds = await digestOfHandle(handle);
						return holds.hash === proved.hash && holds.size === proved.size ? undefined : changed;
					},
					replaceWith: () => fs.link(ground.file, destination),
				});
				if (replaced.outcome === "absent") throw new Error(`${changed}; run \`omp gc --archive\` again`);
				if (replaced.outcome === "kept") throw new Error(`${replaced.note}; run \`omp gc --archive\` again`);
				if (replaced.note) notes.push(replaced.note);
			} finally {
				await archived.close();
			}
		} else {
			// `link`, not `rename`: the caller has established that nothing of
			// this session's is at the destination, so anything there now is
			// someone else's, and `EEXIST` says so rather than writing over it.
			await fs.link(ground.file, destination);
			linked = true;
		}
		const unconfirmed = await publishedIsStaged(destination, ground.created, inflatesTo(expected));
		if (unconfirmed) {
			throw new Error(
				`${destination} is not confirmed as the archive this run wrote for ${source} (${unconfirmed}), so ` +
					`${source} was not archived; run \`omp gc --archive\` again`,
			);
		}
		// The mode once more, from the descriptor the bytes were read through,
		// now that the archived name has been opened and checked, and set
		// through a descriptor proved to hold the very inode just published —
		// never through a name, which could by now be somebody else's file.
		const published = await openRegularFile(destination, { noFollow: true });
		const notOurs = (): Error =>
			new Error(`${destination} is not the archive this run wrote for ${source}, so ${source} was not archived`);
		if (!published) throw notOurs();
		try {
			const held = await published.stat();
			if (held.dev !== ground.created.dev || held.ino !== ground.created.ino) throw notOurs();
			await published.chmod((await live.stat()).mode & 0o7777);
		} finally {
			await published.close().catch(() => undefined);
		}
	} catch (error) {
		// A superseding archive holds everything the one it replaced held, so
		// removing it would give up bytes to recover from a failure the live
		// transcript survives anyway. A linked one is taken back only while
		// taking it back removes nothing but a name.
		if (linked && expected) {
			const note = await withdrawLinkedPublication(destination, ground, inflatesTo(expected));
			if (note) notes.push(note);
		}
		throw error;
	} finally {
		// The directory this run minted goes, with what this run put in it.
		// Anything else inside is reported rather than deleted.
		try {
			const note = await removeStagingGround(ground);
			if (note) notes.push(note);
		} finally {
			await ground.handle.close().catch(() => undefined);
			await live.close().catch(() => undefined);
		}
	}
}

/**
 * One entry this copy created, held: the descriptor it was created through
 * stays open until the copy has finished or been undone, so no other entry
 * can be given its inode number meanwhile. A review copied an archived file
 * elsewhere, removed it, and created a file of its own at the name; the
 * kernel gave the new file the freed number, and a rollback that knew the
 * entry by its number alone deleted that file, its only copy.
 */
interface ArchiveCreation {
	path: string;
	held: HeldFile;
	directory: boolean;
	/**
	 * For a file, the bytes this copy wrote into it. The archived name is one
	 * any process of this user can write by, so the file is taken back only
	 * while it holds exactly these: bytes written by its name since are in no
	 * other copy.
	 */
	written?: CopiedBytes;
}

/** What one copy into the archive created, so a failure can undo exactly that. */
interface ArchiveCopyState {
	brokenLinks: number;
	/** Entries this copy created, shallowest first. */
	created: ArchiveCreation[];
	/** The `--agent-dir` suffix an instruction this copy prints needs to be runnable. */
	recovery: string;
	/** Where this run records the staging directories it mints. */
	ledger: string;
	/** What this copy left alone because it was no longer its own to remove. */
	notes: string[];
	/**
	 * The record naming an entry of the live tree as a killed run's staging
	 * directory, when one does. Such a directory is not an artifact: it is
	 * left where it is, uncopied, and `gc --archive` lists it under
	 * `stagingResidue`.
	 */
	residue: (entry: string) => string | undefined;
}

/**
 * Whether the archive's entry at `destination` is a copy that outlives the
 * live tree being removed.
 *
 * Holding the same bytes is not the same as being a second copy of them. An
 * archived name that is a link into the live tree reads identical to the
 * live file it points at, and the moment that tree goes the archive holds a
 * dangling name and the artifact exists nowhere. The entry must be a file in
 * its own right, resolving outside the tree this run is about to delete.
 *
 * Says what was seen — undefined when it is — or that a look failed, with
 * its error: a failed look is not an entry seen to be a link.
 */
async function survivesSourceRemoval(
	destination: string,
	sourceRoot: string,
): Promise<{ seen: string } | { unchecked: string } | undefined> {
	let entry: Stats | undefined;
	let real: string;
	let root: string;
	try {
		entry = await lstatIfPresent(destination);
		if (!entry) return { seen: `nothing stands at ${destination}` };
		if (!entry.isFile()) return { seen: `${destination} is not a regular file` };
		[real, root] = await Promise.all([fs.realpath(destination), fs.realpath(sourceRoot)]);
	} catch (error) {
		return {
			unchecked: `whether ${destination} is a file of its own outside ${sourceRoot} could not be checked (${errorMessage(error)})`,
		};
	}
	const relative = path.relative(root, real);
	if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) return undefined;
	return { seen: `${destination} resolves inside ${sourceRoot}, the live tree` };
}

/**
 * Put back at `destination` the bytes an open descriptor still holds, in
 * place of `replacing`, the file this run published there.
 *
 * A superseding publication that turns out not to have published what this
 * run copied has already taken the shorter archived copy off its name. That
 * copy is not gone: this run has held it open throughout, and an unlinked
 * inode is still readable through a descriptor. It goes back the way
 * everything else is written here — a stage of this run's own, digested as
 * it is copied, published, and read back by {@link publishedIsStaged} — and
 * what this run published there, a name any process of this user can write,
 * goes by {@link removeFileOthersMayWrite}. Anything else at the name is left as it is.
 */
async function putArchivedCopyBack(
	archived: fs.FileHandle,
	destination: string,
	replacing: HeldFile,
	replacingHolds: CopiedBytes,
	mode: number,
	ledger: string,
	notes: string[],
): Promise<void> {
	const ground = await mintStagingGround(destination, ledger, mode & 0o7777);
	try {
		const written = await copyHandleWithDigest(archived, ground.handle);
		await ground.handle.chmod(mode & 0o7777);
		const notOurs = `${destination} is not the copy this run published there`;
		const replaced = await removeFileOthersMayWrite(destination, {
			matches: named => named.isFile() && named.dev === replacing.dev && named.ino === replacing.ino,
			mismatch: notOurs,
			// The copy this run published, still holding exactly what this run
			// wrote: bytes written by its name since are in no other copy.
			judge: async (_moved, handle) => {
				const now = await handle?.stat();
				if (!handle || now?.dev !== replacing.dev || now.ino !== replacing.ino) return notOurs;
				return (await holdsCopied(replacingHolds)(handle)) ? undefined : notOurs;
			},
			replaceWith: () => fs.link(ground.file, destination),
		});
		if (replaced.outcome === "absent") await fs.link(ground.file, destination);
		if (replaced.outcome === "kept") throw new Error(`${destination} could not be put back: ${replaced.note}`);
		if (replaced.outcome === "removed" && replaced.note) notes.push(replaced.note);
		const unconfirmed = await publishedIsStaged(destination, ground.created, holdsCopied(written));
		if (unconfirmed) {
			throw new Error(
				`${destination} could not be put back: what stands at that name is not confirmed as the copy this run ` +
					`wrote back (${unconfirmed}), so it was left as it is`,
			);
		}
	} finally {
		try {
			const note = await removeStagingGround(ground);
			if (note) notes.push(note);
		} finally {
			await ground.handle.close().catch(() => undefined);
		}
	}
}

/**
 * Publish one live file into the archive.
 *
 * Nothing already in the archive is written over but a shorter copy of this
 * very file, proved to be how the copied bytes begin — what a restore leaves
 * behind, since it keeps its copy and the session carries on. A destination
 * that already holds exactly what would be written is left alone, and a
 * destination holding anything else is reported with both copies intact. A
 * half-finished artifact tree is finished by restoring the session and
 * archiving it again, not by writing over the half.
 *
 * The live content is staged beside its destination first, so the comparison
 * runs against the bytes that are actually about to land rather than against
 * a live file that may have changed since. The archived copy standing there
 * is read through an open descriptor, so what is compared is the file, not
 * the name.
 *
 * Only the destination's absence may skip that comparison. A destination
 * that cannot be opened — no permission, an I/O error — is not an empty
 * slot, and reading it as one is how a file nobody could read gets written
 * over. The live file being the archived file under another name — a hard
 * link, a symlink onto it — is refused outright rather than archived over
 * itself.
 */
async function publishArtifactIntoArchive(
	source: string,
	sourceStat: Stats,
	destination: string,
	sourceRoot: string,
	state: ArchiveCopyState,
): Promise<void> {
	// The stage is this run's own file, inside a directory this run minted,
	// and what it holds is known because this run wrote it and digested the
	// bytes as they went by. That digest is the proof. Every version of this
	// that asked the question a second time — stat the source again, compare
	// sizes and timestamps — was asking at T2 about a fact established at
	// T1, and on a filesystem with one-second timestamps and reusable inodes
	// an in-place rewrite of the same length leaves size, mtime, ctime,
	// device and inode all identical. There is no stat comparison that can
	// be made sound there, and none is needed: the bytes published are the
	// bytes copied.
	//
	// The archived file still has to be read, because the question about it
	// — does the archive already hold this, or something else — is about a
	// file this run did not write.
	const ground = await mintStagingGround(destination, state.ledger, sourceStat.mode & 0o7777);
	const tempPath = ground.file;
	const held = ground.created;
	// Held open until the end: the bytes and the mode published are both
	// read from this one descriptor, and the mode is read again after the
	// archived name was last opened, so a file tightened while this run
	// worked is archived with the tighter mode.
	let live: fs.FileHandle | undefined;
	const liveMode = async (): Promise<number> => {
		if (!live) throw new Error(`${source} was not opened`);
		return (await live.stat()).mode & 0o7777;
	};
	// Once linked into the archive, the stage's descriptor goes to the copy's
	// record of what it created, and is closed only after the copy has
	// finished or been undone.
	let published = false;
	try {
		// Through the regular-file check: a live artifact replaced by a FIFO,
		// a socket or a device since the walk looked is refused unread.
		live = await openRegularFile(source);
		if (!live) throw absentFile(source);
		const copied = await copyHandleWithDigest(live, ground.handle);
		// `open` applies the umask; the archived copy keeps the live file's
		// own permissions, so a deliberately private artifact stays private.
		await ground.handle.chmod(await liveMode());
		const stem = path.basename(sourceRoot);
		const target = stem.slice(stem.lastIndexOf("_") + 1) || stem;
		const conflict = (): Error =>
			new Error(
				`the archive already holds ${destination}, and it is not what archiving ${source} would write; ` +
					`the archive is left as it is. Bring the session home with ` +
					`\`omp gc --restore ${shellQuote(target)} --apply${state.recovery}\` and archive it again, ` +
					`or move one of the two copies aside. Without \`--apply\`, \`--restore\` reports what it would do and changes nothing.`,
			);
		// The proof was about a descriptor; the publication is about a name.
		// `link` replaces nothing, and a shorter copy is replaced only once it
		// has been moved to a private name and judged there — see
		// {@link removeFileOthersMayWrite} — so neither writes over a file somebody put at the
		// name. What the publication left at the name is read back — see
		// {@link publishedIsStaged} for each step and what it rules out — since
		// a process that can write the destination's directory can still
		// rebind the name after the link, which no check run here prevents
		// and the read-back reports. An ordinary writer rewriting the live
		// source is a different thing and is handled — what was copied is
		// what is published.
		const stagedIsStillOurs = async (): Promise<boolean> => {
			// A failed look throws as it came, not as a file somebody put there.
			const standing = await lstatIfPresent(tempPath);
			return standing?.dev === held.dev && standing.ino === held.ino;
		};
		const rebound = (): Error =>
			new Error(
				`${tempPath} is no longer the file this run staged there, so it was left alone and ${source} was ` +
					`not archived; run \`omp gc --archive\` again`,
			);
		const notPublished = (why: string): Error =>
			new Error(
				`${destination} is not confirmed as the copy of ${source} this run wrote (${why}), so ${source} was not ` +
					`archived; run \`omp gc --archive\` again`,
			);
		const archived = await openRegularFile(destination, { noFollow: true });
		if (!archived) {
			if (!(await stagedIsStillOurs())) throw rebound();
			await fs.link(tempPath, destination);
			const unconfirmed = await publishedIsStaged(destination, held, holdsCopied(copied));
			if (unconfirmed) {
				const note = await withdrawLinkedPublication(destination, ground, holdsCopied(copied));
				if (note) state.notes.push(note);
				throw notPublished(unconfirmed);
			}
			state.created.push({ path: destination, held: ground.held, directory: false, written: copied });
			published = true;
			await ground.handle.chmod(await liveMode());
			return;
		}
		try {
			const verified = await archived.stat();
			if (verified.dev === sourceStat.dev && verified.ino === sourceStat.ino) {
				throw new Error(
					`${source} is the archived ${destination} itself, not a second copy of it; ` +
						`archiving it would write the archive over its own file`,
				);
			}
			if (!verified.isFile()) throw conflict();
			const independent = await survivesSourceRemoval(destination, sourceRoot);
			if (independent && "unchecked" in independent) {
				throw new Error(`${independent.unchecked}, so ${source} was not archived; run \`omp gc --archive\` again`);
			}
			if (independent) throw conflict();
			const archivedBytes = await digestOfHandle(archived);
			// Same length settles it either way: the archive already holds
			// exactly these bytes, or it holds different ones and nothing
			// here may write over them.
			if (archivedBytes.size === copied.size) {
				if (archivedBytes.hash === copied.hash) {
					// The bytes are already archived; the mode is the live
					// file's now, set through the descriptor held on that very
					// inode, so a file tightened since it was archived is not
					// kept in the archive readable by more than it is.
					const mode = await liveMode();
					if ((verified.mode & 0o7777) !== mode) {
						await archived.chmod(mode);
					}
					return;
				}
				throw conflict();
			}
			// A shorter archived copy is only superseded when it is how the
			// copied bytes begin. Anything else is a different file wearing
			// the name.
			if (archivedBytes.size > copied.size || !(await handleBeginsWith(ground.handle, archived))) throw conflict();
			// The shorter copy, a name any process of this user can write, goes by
			// `removeFileOthersMayWrite` — moved to a private name and judged there
			// to be the very file read above, held open since, still holding
			// exactly the bytes digested before the prefix proof: bytes written by
			// its name since are in no other copy — and the longer one is linked
			// in at its name before it goes. A rename onto the name instead
			// replaced whatever stood there by the time it ran.
			const changed = `${destination} changed while it was being archived`;
			const replaced = await removeFileOthersMayWrite(destination, {
				matches: named => named.isFile() && named.dev === verified.dev && named.ino === verified.ino,
				mismatch: changed,
				judge: async (_moved, handle) => {
					const now = await handle?.stat();
					if (!handle || now?.dev !== verified.dev || now.ino !== verified.ino) return changed;
					return (await holdsCopied(archivedBytes)(handle)) ? undefined : changed;
				},
				replaceWith: async () => {
					if (!(await stagedIsStillOurs())) throw rebound();
					await fs.link(tempPath, destination);
				},
			});
			if (replaced.outcome === "absent") throw new Error(`${changed}; run \`omp gc --archive\` again`);
			if (replaced.outcome === "kept") {
				throw new Error(`${replaced.note}; ${source} was not archived; run \`omp gc --archive\` again`);
			}
			if (replaced.note) state.notes.push(replaced.note);
			const unconfirmed = await publishedIsStaged(destination, held, holdsCopied(copied));
			if (unconfirmed) {
				// The shorter archived copy is gone from that name — and it is
				// still here, in the descriptor this run has held open
				// throughout. It goes back in place of what this run put there
				// and of nothing else: a file somebody has put at the name
				// since is theirs.
				try {
					await putArchivedCopyBack(
						archived,
						destination,
						ground.held,
						copied,
						verified.mode,
						state.ledger,
						state.notes,
					);
				} catch (error) {
					throw new Error(
						`${notPublished(unconfirmed).message}; ${errorMessage(error)}. ${source}, which began with the bytes of the ` +
							`shorter copy the archive held when this run copied it, is kept`,
					);
				}
				throw notPublished(unconfirmed);
			}
			await ground.handle.chmod(await liveMode());
		} finally {
			await archived.close().catch(() => undefined);
		}
		return;
	} finally {
		// The cleanup is the directory this run minted, not a name it hoped
		// still meant what it meant before. What is inside and this run's own
		// goes; anything else is reported rather than deleted, and a failure
		// to look is reported rather than read as an absence.
		try {
			const note = await removeStagingGround(ground);
			if (note) state.notes.push(note);
		} finally {
			if (!published) await ground.handle.close().catch(() => undefined);
			await live?.close().catch(() => undefined);
		}
	}
}

/**
 * Copy one live entry into the archive with symlinks resolved into real files.
 *
 * One walk does the deciding and the writing, over the tree the writes land
 * in: a safety pass that walked a different tree — one that stopped at a
 * directory symlink the copy follows — would clear files it never looked at.
 */
async function copyArtifactEntryIntoArchive(
	source: string,
	destination: string,
	sourceRoot: string,
	state: ArchiveCopyState,
): Promise<void> {
	if (state.residue(source) !== undefined) return;
	const stat = await fs.stat(source).catch(error => {
		// A link whose target is already gone: one of them must not make a
		// session unarchivable forever.
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) {
		if ((await lstatIfPresent(source))?.isSymbolicLink()) state.brokenLinks += 1;
		return;
	}
	if (stat.isDirectory()) {
		if (await isSamePath(source, destination)) {
			throw new Error(`the live artifact tree ${source} is the archived tree ${destination} itself`);
		}
		// A directory this copy makes gets {@link directoryModeFor} the live
		// directory's mode from the `mkdir` that makes it, narrowed by the
		// umask, and nothing widens it afterwards: see {@link makeHeldDirectory}.
		// One the archive already holds is narrowed to that, never widened:
		// merging into an archived directory that grants more than the live
		// one — archived before the user made it private — left the archive
		// granting more, and a restore after a reclaim made the live directory
		// `0755` again from its `0700`.
		const allowed = directoryModeFor(stat.mode);
		let held: HeldFile | undefined;
		try {
			held = await makeHeldDirectory(destination, allowed);
		} catch (error) {
			if (codeOf(error) !== "EEXIST") throw error;
		}
		if (held) state.created.push({ path: destination, held, directory: true });
		else await narrowArchivedDirectory(source, destination, allowed);
		// Sorted, so a run that fails part-way is reproducible from its report.
		for (const entry of (await fs.readdir(source)).sort()) {
			await copyArtifactEntryIntoArchive(path.join(source, entry), path.join(destination, entry), sourceRoot, state);
		}
		return;
	}
	if (!stat.isFile()) {
		// A FIFO, a socket or a device — itself or behind a link — is left out
		// unread, and named: reading one waits on it or takes what is written
		// to it, and skipping one without a word archived a session as whole
		// while its tree held something no copy has.
		const named = await lstatIfPresent(source);
		state.notes.push(
			`${source} ${named?.isSymbolicLink() ? "links to" : "is"} ${kindOf(stat)}, which the archive cannot hold, ` +
				`so it was left out of the archive and not read`,
		);
		return;
	}
	await publishArtifactIntoArchive(source, stat, destination, sourceRoot, state);
}

/**
 * Narrow `destination`, a directory the archive already holds for the live
 * `source`, so it grants no more than `allowed`: it only ever loses
 * permissions, never gains one. The `chmod` goes through a descriptor held on
 * the very directory the name was seen to hold, so a directory swapped in for
 * it is narrowed rather than another one widened, and the mode it narrows is
 * the one read through that descriptor, not the earlier look at the name: a
 * review made the archived `0777` directory `0700` between the two, and a
 * `chmod` computed from the look gave it `0755`. One gap is left: a `chmod`
 * by another process in the one call between that read and this `chmod` is
 * overwritten — there is no compare-and-set of a mode. A link the archive
 * holds at the name is not followed to be changed: if what it leads to grants
 * more, the session is not archived and the reason says so.
 */
async function narrowArchivedDirectory(source: string, destination: string, allowed: number): Promise<void> {
	const seen = await fs.lstat(destination).catch((error: unknown) => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (seen?.isSymbolicLink())
		throw new Error(
			`${destination} is a symbolic link, not an archived directory; ${source} was not archived into it`,
		);
	const target = seen;
	if (!target?.isDirectory()) {
		throw new Error(
			`the archive already holds ${destination}, and it is not a directory, so ${source} was not archived into it`,
		);
	}
	// Only a reason to look closer: nothing is changed on the strength of it.
	if ((target.mode & 0o777 & ~allowed) === 0) return;
	const held = seen?.isDirectory() ? await holdSeenDirectory(destination, seen) : undefined;
	if (!held) {
		throw new Error(
			`${destination} grants more (${(target.mode & 0o777).toString(8)}) than the live ${source} ` +
				`(${(allowed & 0o777).toString(8)}), and it is not a directory this run could narrow, so ${source} was ` +
				`not archived into it`,
		);
	}
	try {
		const current = (await held.handle.stat()).mode & 0o7777;
		// Permission bits outside `allowed` go; the setuid, setgid and sticky
		// bits stay as they are.
		const narrowed = current & (allowed | 0o7000);
		if (narrowed !== current) await held.handle.chmod(narrowed);
	} finally {
		await held.handle.close().catch(() => undefined);
	}
}

/**
 * Undo one failed copy into the archive, and nothing more.
 *
 * What goes is what this copy made, and only while the name still holds what
 * it made. A pathname is not ownership in either direction: a file somebody
 * created at a destination the copy refused to replace must not be removed
 * because its name is unfamiliar, and a file somebody put at a name this
 * copy did once create must not be removed because the name is familiar.
 * Neither is an inode number, which the kernel hands to the next file once
 * the last name and descriptor of the old one are gone — so every entry this
 * copy made has been held open since it was made. A file, at a name any
 * process of this user can write, goes by {@link removeFileOthersMayWrite},
 * and only while it holds exactly the bytes this copy wrote: a review
 * appended unique bytes by the name before the move, and a rollback judged
 * by identity alone took them.
 *
 * A directory this copy made is left, empty of what this copy put in it. No
 * look taken after a `mkdir` tells the directory it made from an empty one of
 * the same owner and mode renamed onto its name before the look — no system
 * call makes a directory and hands back a descriptor on it — and a review did
 * exactly that, with an extended attribute on its own directory, which the
 * rollback's `rmdir` then took. An empty directory left in the archive costs
 * nothing and is said in `notes`; the next archive run merges into it.
 *
 * Whatever is left is said in `notes`, and so is a failure to look at an
 * entry or to remove one: "it was not there" and "I could not tell" are
 * different answers.
 *
 * Staging directories a failed publication left are not this function's:
 * they go through {@link removeStagingGround}, which knows what it put
 * there. Nothing here deletes by the shape of a name.
 */
async function removeTreeAdditions(created: readonly ArchiveCreation[], notes: string[]): Promise<void> {
	const directories: string[] = [];
	for (const made of [...created].reverse()) {
		if (made.directory) {
			directories.push(made.path);
			continue;
		}
		// An archived name any process of this user can write: what it holds
		// goes only once moved aside and judged to be the copy held since it
		// was published, holding what this copy wrote.
		const notOurs = `${made.path} is not the copy this run put in the archive`;
		const removal = await removeFileOthersMayWrite(made.path, {
			matches: standing => standing.isFile() && standing.dev === made.held.dev && standing.ino === made.held.ino,
			mismatch: notOurs,
			judge: async (_moved, handle) => {
				const now = await handle?.stat();
				if (!handle || now?.dev !== made.held.dev || now.ino !== made.held.ino || !made.written) return notOurs;
				return (await holdsCopied(made.written)(handle)) ? undefined : notOurs;
			},
		});
		if (removal.outcome === "kept") notes.push(removal.note);
	}
	if (directories.length > 0) {
		notes.push(
			`the director${directories.length === 1 ? "y" : "ies"} this run made in the archive ${directories.length === 1 ? "was" : "were"} ` +
				`left, emptied of what it put there: ${directories.join(", ")}`,
		);
	}
}

/** What an entry is, as distinct from its name: the identity a removal checks before it goes. */
interface EntryIdentity {
	dev: number;
	ino: number;
	/** The whole mode: the type bits and the permissions. */
	mode: number;
	/** The device a device node stands for. */
	rdev: number;
	/**
	 * When the inode last changed, for anything but a regular file. A
	 * regular file is compared by its bytes instead, and its change time
	 * moves when another name of it is removed from the same tree.
	 */
	ctimeMs?: number;
	/** What a symbolic link points at. */
	target?: string;
}

/** The identity a single `stat` reports; a link's target is read separately. */
function identityFrom(stat: Stats): EntryIdentity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		rdev: stat.rdev,
		ctimeMs: stat.isFile() ? undefined : stat.ctimeMs,
	};
}

function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.rdev === b.rdev &&
		a.ctimeMs === b.ctimeMs &&
		a.target === b.target
	);
}

/** An entry seen to change while it was being looked at — told apart from a look that failed. */
class EntryChanged extends Error {}

/**
 * One look at what `entry` names, or undefined when nothing does.
 *
 * A link's target is a second read, so it is bracketed: `lstat`,
 * `readlink`, `lstat` again, and the two must describe the same inode with
 * the same change time, or the target may belong to a replacement — inode
 * numbers come back, so the number alone does not say the entry is the one
 * first seen. Throws {@link EntryChanged} when the entry changed while it was
 * being looked at, and any failed look as it came.
 */
async function lookAt(entry: string): Promise<EntryIdentity | undefined> {
	const first = await fs.lstat(entry).catch(error => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (!first) return undefined;
	const seen = identityFrom(first);
	if (!first.isSymbolicLink()) return seen;
	const target = await fs.readlink(entry);
	const again = await fs.lstat(entry);
	if (!sameIdentity(seen, identityFrom(again))) {
		throw new EntryChanged(`${entry} changed while this run was looking at it; it was kept`);
	}
	return { ...seen, target };
}

/**
 * Whether `entry` still names exactly what `proved` describes, taken in one
 * look — see {@link lookAt}. Absence is reported as `undefined`, and an
 * entry seen to change while being looked at as `false`; a look that fails
 * throws, since a failed look says nothing about what stands there.
 */
async function standsAsProved(entry: string, proved: EntryIdentity): Promise<boolean | undefined> {
	let now: EntryIdentity | undefined;
	try {
		now = await lookAt(entry);
	} catch (error) {
		if (error instanceof EntryChanged) return false;
		throw error;
	}
	return now === undefined ? undefined : sameIdentity(now, proved);
}

/** One live file a reclaim proved, as the entry rather than as its name, and the archived copy it was proved against. */
interface ProvenEntry extends EntryIdentity {
	path: string;
	destination: string;
	/** The archived copy at `destination` as the proof found it: the one file there a reclaim may free. */
	copy: { dev: number; ino: number };
}

/** One live directory a reclaim proved, held open from the proof to the end of the run. */
interface ProvenDirectory {
	path: string;
	destination: string;
	held: HeldFile;
}

/**
 * What a reclaim proved of a live tree: its files, and its directories,
 * deepest first, each held open from the proof to the end of the run, so no
 * other directory can be given its inode number while the run decides by it
 * — see {@link holdSeenDirectory}. The holder closes them with
 * {@link releaseProvenTree}. `live` holds the device and inode of every live
 * entry proved, the transcript's included, so an archived copy that is one
 * of them, under another name, is told from a copy — see
 * {@link archivedAliasRefusal} — and an entry of the moved tree the proof
 * never saw is told from one it did — see {@link unprovedEntry}.
 */
interface ProvenTree {
	files: ProvenEntry[];
	directories: ProvenDirectory[];
	live: Set<string>;
}

/** Close every directory a proof of the live tree holds. */
async function releaseProvenTree(proven: ProvenTree): Promise<void> {
	for (const directory of proven.directories) await directory.held.handle.close().catch(() => undefined);
}

/**
 * Why the archive holds no independent copy of some entry of the proved
 * tree: an archived counterpart that is itself one of the live entries — see
 * {@link archivedAliasRefusal}. Asked once the whole tree is proved, when
 * every live entry is known, since one checked as the walk went could only be
 * compared with the entries proved before it.
 */
async function archivedAliasesRefusal(proven: ProvenTree): Promise<string | undefined> {
	for (const entry of [...proven.files, ...proven.directories]) {
		const archived = await lstatIfPresent(entry.destination);
		if (archived?.isSymbolicLink())
			return `${entry.destination} is a symbolic link, not a copy of ${entry.path}; it was kept`;
		if (!archived) continue;
		const refused = archivedAliasRefusal(entry.path, entry.destination, archived, proven.live);
		if (refused) return refused;
	}
	return undefined;
}

/**
 * Who else holds `file` open — the file open at `handle`, this run's one
 * descriptor on it — as the process list shows it, for a refusal to name.
 * Asked only once the kernel has refused a lease — see
 * {@link takeSoleOpenLease} — since the list proves nothing and costs a look
 * at every descriptor of every process: 0.7 to 1.4 seconds a read on a
 * machine running 3,300 processes, which, read on every reclaim and preview,
 * was most of the time several tests took. Other processes are listed; this
 * process is counted apart, by the descriptors it holds on the file besides
 * `handle`: the kernel refuses a lease to an open of its own as to anyone's.
 */
async function holdersOf(
	handle: fs.FileHandle,
	file: string,
): Promise<{ listed: OpenFileHolders; ownOthers: number | undefined; ownUnknown?: string }> {
	const listed: OpenFileHolders = await openFileHolders([file]).catch((error: unknown) => ({
		unknown: errorMessage(error),
	}));
	let ownOthers: number | undefined;
	let ownUnknown: string | undefined;
	try {
		const own = await ownDescriptorCount(await handle.stat());
		ownOthers = own === undefined ? undefined : Math.max(0, own - 1);
		if (own === undefined) ownUnknown = "this platform provides no count of this process's descriptors";
	} catch (error) {
		ownUnknown = `this process's descriptors could not be checked (${errorMessage(error)})`;
	}
	const others = (holders: OpenFileHolder[]): OpenFileHolder[] =>
		holders.filter(holder => holder.pid !== process.pid).map(holder => ({ ...holder, file }));
	return {
		listed:
			"holders" in listed
				? { ...listed, holders: others(listed.holders) }
				: { ...listed, seen: others(listed.seen ?? []) },
		ownOthers,
		ownUnknown,
	};
}

/**
 * Why a file was kept when the kernel would not lease it — see
 * {@link takeSoleOpenLease} — said so a reader can act on it: which file, what
 * the kernel answered, who holds it as far as can be seen, and what to do.
 * The kernel refuses while any other open of the file exists, in another
 * process or in this one, so another process is named only when one is seen.
 */
function leaseRefusal(
	file: string,
	lease: Exclude<SoleOpenLease, { outcome: "held" }>,
	{ listed, ownOthers, ownUnknown }: { listed: OpenFileHolders; ownOthers: number | undefined; ownUnknown?: string },
): string {
	const own =
		ownOthers !== undefined && ownOthers > 0
			? `this omp process (${process.pid}) itself holds ${file} open through ${ownOthers} other ` +
				`${ownOthers === 1 ? "descriptor" : "descriptors"}`
			: undefined;
	const seen = "holders" in listed ? listed.holders : (listed.seen ?? []);
	const unseen = listed.unlisted ? `. ${listed.unlisted}. Who else holds it is not known` : "";
	if ("unknown" in listed || ownUnknown) {
		const failures = [
			...("unknown" in listed ? [`the process list could not be checked (${listed.unknown})`] : []),
			...(ownUnknown ? [ownUnknown] : []),
			...(listed.unlisted ? [listed.unlisted] : []),
		];
		const observed = [...seen.map(describeOpenFileHolder), ...(own ? [own] : [])];
		const kernel =
			lease.outcome === "open-elsewhere"
				? `${file} is open or mapped elsewhere (${lease.evidence})`
				: `whether anything else holds ${file} open could not be proved: ${lease.meaning} (${lease.evidence})`;
		const next =
			lease.outcome === "unproved"
				? lease.retry
					? "Reclaim again later"
					: "Here `gc --reclaim` keeps the live copy; the archive keeps its copy too, and `gc --restore` still reads it"
				: `Who else holds it is not known. Find the holder with \`fuser -v ${shellQuote(file)}\` or \`lsof ${shellQuote(file)}\``;
		return (
			`${kernel}; ${failures.join("; ")}. ` +
			`${observed.length > 0 ? `Seen holding it: ${observed.join("; ")}. ` : ""}` +
			`${ownOthers === 0 ? "This process holds no other descriptor on it. " : ""}` +
			`Nothing was moved. ${next}`
		);
	}
	if ("holders" in listed && listed.holders.length > 0) {
		return (
			`${listed.holders.map(describeOpenFileHolder).join("; ")}${own ? `; and ${own}` : ""} open (${lease.evidence}): ` +
			`it is using the session, and what it writes through that descriptor once the file moved would land in the ` +
			`archive beside a copy that does not hold it, so nothing was moved — let it finish, or close it, and reclaim again${unseen}`
		);
	}
	if (own) {
		return (
			`${own}, so the kernel would not lease it (${lease.evidence}), and no other process this run can list holds ` +
			`it; nothing was moved. Close what has it open in this process and reclaim again${unseen}`
		);
	}
	const list =
		"unknown" in listed
			? `the process list could not be read either (${listed.unknown})`
			: `no process this run can list holds it${listed.unlisted ? `; ${listed.unlisted}` : ""}`;
	if (lease.outcome === "open-elsewhere") {
		return (
			`${file} is open or mapped elsewhere: the kernel refused this run a lease on it (${lease.evidence}), which ` +
			`it does only while another open of the file exists or it is mapped, and ${list}` +
			`${ownOthers === 0 ? ", nor does this process through another descriptor" : ""} — so the holder is one ` +
			`this run cannot see: a child that inherited the descriptor, a process it was handed to, a mapping (this ` +
			`process's own not excluded), or another user's or another container's process. It may be using the ` +
			`session, so nothing was moved. Find it with \`fuser -v ${shellQuote(file)}\` or ` +
			`\`lsof ${shellQuote(file)}\` (as root for another user's), let it finish or close it, and reclaim again`
		);
	}
	return (
		`whether anything else holds ${file} open could not be proved: ${lease.meaning} (${lease.evidence}). A ` +
		`process list does not show a descriptor a process inherited or was handed, so without the kernel's lease ` +
		`nothing proves the file unheld, and nothing was moved; ${list}. ` +
		(lease.retry
			? "Reclaim again later"
			: "Here `gc --reclaim` keeps the live copy; the archive keeps its copy too, and `gc --restore` still reads it")
	);
}

/** A live file a reclaim moves, held open with the kernel's lease from just before the move until the run lets go. */
interface LeasedFile {
	path: string;
	proved: EntryIdentity;
	handle: fs.FileHandle;
}

/**
 * Open every live file a reclaim is about to move, and have the kernel prove
 * that no other process holds any of them open — see {@link takeSoleOpenLease}
 * — each still the very file the walk proved. Every file opened goes into
 * `leased`, whose descriptors the caller closes on every way out, which lets
 * go of the lease, as the kernel does when the process ends, by any signal.
 * Undefined once every lease is held; otherwise why the session is kept,
 * with nothing moved.
 *
 * A process holding a session file is using the session: once the file has
 * moved, what it writes through its descriptor lands in the archive, beside
 * an archived copy that does not hold it. The kernel counts every open file
 * description, however it was handed on — a forked child's, a descriptor
 * passed over a socket — so a lease is refused while any other reaches the
 * file, and only then is the process list read, to name who holds it — see
 * {@link leaseRefusal}. Once granted, another process's open of the file
 * waits until this run lets go, or for no longer than the kernel's
 * `fs.lease-break-time` (45 seconds by default), and the lease then reads as
 * broken — which {@link brokenLease} finds once the moves are made.
 */
async function leaseLiveFiles(
	files: readonly { path: string; proved: EntryIdentity }[],
	leased: LeasedFile[],
): Promise<string | undefined> {
	for (const file of files) {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await openRegularFile(file.path, { noFollow: true });
		} catch (error) {
			return `${file.path} could not be checked (${errorMessage(error)})`;
		}
		if (!handle) return `${file.path} is no longer the file this run proved`;
		leased.push({ ...file, handle });
		const lease = takeSoleOpenLease(handle.fd);
		if (lease.outcome !== "held") return leaseRefusal(file.path, lease, await holdersOf(handle, file.path));
		const now = await handle.stat();
		if (!now.isFile() || !sameIdentity(identityFrom(now), file.proved)) {
			return `${file.path} is no longer the file this run proved`;
		}
	}
	return undefined;
}

/**
 * What a broken lease shows, for a report: the kernel breaks a lease when an
 * open of the file is made or tried, or the file is truncated, by any
 * process, this one included, and a refused non-blocking open breaks it as
 * surely as a finished one. It does not say who, nor whether the open
 * succeeded; a review saw a refused open, and this process's own open,
 * reported as "another process opened it".
 */
function leaseBrokenBecause(file: string): string {
	return (
		`the kernel broke this run's lease on ${file}: an open of it was made or tried, or it was truncated, by ` +
		`some process — which one the kernel does not say, and this one is not excluded`
	);
}

/**
 * Why a leased file shows the session may be in use now that the moves are
 * made — its lease broke meanwhile — or undefined. Throws when a lease cannot
 * be asked about: that is a failure to check, not an open.
 */
function brokenLease(leased: readonly LeasedFile[]): string | undefined {
	const opened = leased.find(file => !soleOpenLeaseStands(file.handle.fd));
	if (!opened) return undefined;
	return (
		`${leaseBrokenBecause(opened.path)}, while this run moved it into the archive, so the session may be in ` +
		`use; reclaim again once nothing uses it`
	);
}

/**
 * Why the live tree no longer stands as proved, asked the step before it
 * moves: a file's name no longer holds the file proved there, or a
 * directory's name no longer holds the directory held open since its proof.
 * Undefined while everything stands; a look that fails is said as one.
 */
async function treeChangedSinceProof(
	files: readonly LeasedFile[],
	directories: readonly ProvenDirectory[],
): Promise<string | undefined> {
	for (const file of files) {
		let stands: boolean | undefined;
		try {
			stands = await standsAsProved(file.path, file.proved);
		} catch (error) {
			return `whether ${file.path} is still the file this run proved could not be checked (${errorMessage(error)})`;
		}
		if (stands !== true) return `${file.path} is no longer the file this run proved`;
	}
	for (const directory of directories) {
		let named: Stats | undefined;
		try {
			named = await lstatIfPresent(directory.path);
		} catch (error) {
			return `whether ${directory.path} is still the directory this run proved could not be checked (${errorMessage(error)})`;
		}
		if (!named?.isDirectory() || named.dev !== directory.held.dev || named.ino !== directory.held.ino) {
			return `${directory.path} is no longer the directory this run proved`;
		}
	}
	return undefined;
}

/**
 * The first entry of the moved tree at `root` that the proof never saw —
 * written into the tree after it was proved — or undefined when every entry
 * is one it proved. Such an entry has no archived copy, and it moved with
 * its original, so nothing is lost; but whoever wrote it is using the session.
 */
async function unprovedEntry(root: string, proven: ProvenTree): Promise<string | undefined> {
	for (const name of await fs.readdir(root)) {
		const entry = path.join(root, name);
		const stat = await fs.lstat(entry);
		if (!proven.live.has(identityKey(stat))) return entry;
		if (stat.isDirectory()) {
			const found = await unprovedEntry(entry, proven);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** What a lstat of `entry` finds, a link not followed, or undefined when nothing is there. */
async function lstatIfPresent(entry: string): Promise<Stats | undefined> {
	return await fs.lstat(entry).catch((error: unknown) => {
		if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return undefined;
		throw error;
	});
}

/**
 * Why a reclaim cannot move `from` to `to`: they are on different
 * filesystems. Said the same by a preview and by applying.
 */
function crossFilesystemRefusal(from: string, to: string): string {
	return (
		`${to} is on another filesystem than ${from}, and a reclaim moves an original into the archive by rename ` +
		`and never deletes one: a copy cannot stand in for it, since no copy carries its inode, its change and ` +
		`birth times, or the attributes this process cannot even list. Nothing was moved and nothing deleted; to ` +
		`reclaim, keep the archive on the sessions tree's filesystem`
	);
}

/**
 * Move a live original to `to` by a rename that replaces nothing — see
 * `renameNoReplace` (`libc.ts`) — undefined once it has moved, otherwise why
 * it has not; it has not moved then. A rename across filesystems is refused
 * by the kernel (`EXDEV`), and with it the reclaim: a copy cannot stand in
 * for an original.
 */
async function moveOriginal(from: string, to: string): Promise<string | undefined> {
	let moved: NoReplaceRename;
	try {
		moved = await renameNoReplace(from, to);
	} catch (error) {
		if (codeOf(error) === "EXDEV") return crossFilesystemRefusal(from, to);
		return `${from} could not be moved to ${to} (${errorMessage(error)})`;
	}
	if (moved.outcome === "renamed") return undefined;
	if (moved.outcome === "taken") return `${to} is already taken, so ${from} was not moved there`;
	if (moved.outcome === "absent") return `${from} is gone since this run proved it`;
	return (
		`${from} could not be moved to ${to}: ${moved.why}, and a rename that may replace what has that name could ` +
		`remove another file there`
	);
}

/** A live original a reclaim moved, and where to. */
interface ReclaimMove {
	from: string;
	to: string;
}

/**
 * Put what a reclaim moved back under its live names, the last move first,
 * with renames that replace nothing. Returns the moves that could not be put
 * back, each with the sentence saying where it is and how it comes home.
 */
async function moveBack(
	moves: readonly ReclaimMove[],
	restoreCommand: string,
): Promise<{ left: ReclaimMove[]; notes: string[] }> {
	const left: ReclaimMove[] = [];
	const notes: string[] = [];
	for (const move of [...moves].reverse()) {
		const why = await moveOriginal(move.to, move.from);
		if (why === undefined) continue;
		left.unshift(move);
		notes.push(
			`${move.from} is at ${move.to} and could not be moved back (${why}); \`${restoreCommand}\`, or opening the ` +
				`session, moves it home`,
		);
	}
	return { left, notes };
}

/** An entry's device and inode, as one key. */
function identityKey(stat: { dev: number; ino: number }): string {
	return `${stat.dev}:${stat.ino}`;
}

/**
 * Why `archived` is no copy of `live` at all: it is `live` itself, or another
 * entry of the live tree being reclaimed, reached through a link, a mount, or
 * a `/proc/<pid>/fd` descriptor. A review made an archived directory a link
 * to a descriptor a process held on the live one; the reclaim removed the
 * live directory, and once that process exited neither name led anywhere and
 * a restore brought nothing back. `liveEntries` holds the device and inode of
 * every live entry this run proved. Undefined when `archived` is none of them.
 */
function archivedAliasRefusal(
	live: string,
	archived: string,
	archivedStat: Stats,
	liveEntries: ReadonlySet<string>,
): string | undefined {
	if (!liveEntries.has(identityKey(archivedStat))) return undefined;
	return (
		`${archived} is not a copy of ${live}: it is ${live}, or another entry of this session's live tree, reached ` +
		`through a link, a mount or a descriptor, so reclaiming ${live} would leave the archive holding nothing for it; ` +
		`it was kept. Archive the session again into a real archive, and reclaim after that`
	);
}

/**
 * Why `live` has no archived copy at `archived` that a reclaim can move it
 * beside: none is there, or it is no copy but the live tree itself — see
 * {@link archivedAliasRefusal}. Undefined otherwise. What the copy carries
 * beyond its bytes does not matter: the live file itself is what a reclaim
 * moves into the archive, and a restore moves back.
 */
async function archivedFileRefusal(
	live: string,
	archived: string,
	liveEntries: ReadonlySet<string>,
): Promise<string | undefined> {
	const archivedStat = await lstatIfPresent(archived);
	if (archivedStat?.isSymbolicLink()) return `${archived} is a symbolic link, not a copy of ${live}; it was kept`;
	if (!archivedStat?.isFile()) {
		return `${archived} is no longer an archived copy of ${live}, so ${live} would not come back; it was kept`;
	}
	return archivedAliasRefusal(live, archived, archivedStat, liveEntries);
}

/**
 * Why the live directory `live` has no archived directory at `archived` that
 * a reclaim can move it beside: none is there, or the archive holds the live
 * tree itself there — see {@link archivedAliasRefusal}. Undefined otherwise;
 * its mode does not matter, since the live directory itself is what moves.
 */
async function archivedDirectoryRefusal(
	live: string,
	archived: string,
	liveEntries: ReadonlySet<string>,
): Promise<string | undefined> {
	const archivedStat = await lstatIfPresent(archived);
	if (archivedStat?.isSymbolicLink()) return `${archived} is a symbolic link, not a copy of ${live}; it was kept`;
	if (!archivedStat?.isDirectory()) {
		return `${archived} is not an archived directory, so the live directory ${live} would not come back`;
	}
	return archivedAliasRefusal(live, archived, archivedStat, liveEntries);
}

/**
 * Give an already-archived transcript the live transcript's mode, so a
 * transcript tightened since it was archived is not kept in the archive
 * readable by more than it is.
 *
 * The `chmod` goes through a descriptor proved, before it is used, to be
 * the archived transcript: the name holds that very inode as a regular file,
 * and what the descriptor reads inflates to exactly what the live
 * transcript holds. A name rebound to somebody else's file as this opens it
 * fails that and is left as it is. The live mode is read from the live
 * transcript's own descriptor last, after the archived one was opened.
 */
async function carryLiveModeToArchive(live: string, archived: string): Promise<void> {
	const changed = (): Error =>
		new Error(`${archived} changed while it was being archived; run \`omp gc --archive\` again`);
	const liveHandle = await openRegularFile(live);
	if (!liveHandle) throw new Error(`${live} is no longer a regular file, so it was not archived`);
	try {
		const archivedHandle = await openRegularFile(archived, { noFollow: true });
		if (!archivedHandle) throw changed();
		try {
			// A look that fails is said as one: only a look that sees something
			// else is reported as a change.
			const unchecked = (what: string, error: unknown): Error =>
				new Error(
					`${what} of ${archived} could not be checked (${errorMessage(error)}), so its mode was not set; ` +
						`run \`omp gc --archive\` again`,
				);
			const held = await archivedHandle.stat();
			let named: Stats | undefined;
			try {
				named = await lstatIfPresent(archived);
			} catch (error) {
				throw unchecked("what stands at the name", error);
			}
			if (!named?.isFile() || named.dev !== held.dev || named.ino !== held.ino) throw changed();
			const expected = await digestStream(bytesOfHandle(liveHandle));
			let inflates: boolean;
			try {
				inflates = await inflatesTo(expected)(archivedHandle);
			} catch (error) {
				throw unchecked("what inflates out", error);
			}
			if (!inflates) throw changed();
			const mode = (await liveHandle.stat()).mode & 0o7777;
			if ((held.mode & 0o7777) !== mode) await archivedHandle.chmod(mode);
		} finally {
			await archivedHandle.close().catch(() => undefined);
		}
	} finally {
		await liveHandle.close().catch(() => undefined);
	}
}

/**
 * A relative link's target as an absolute path that keeps every name the
 * target goes through: the leading `..` steps are taken against `realParent`,
 * the link's own directory as a real path, so none of them passes through
 * that directory by name; the rest is kept as written, so a name in it that is
 * itself a link — `outside/current` — stays one, and the moved link follows it
 * when it moves on. `.` steps are dropped. Undefined when a `..` follows a
 * name in the rest: that name may be a link, so no lexical form is the same
 * path, and a resolved one would be a snapshot.
 */
function aliasPreservingTarget(realParent: string, target: string): string | undefined {
	const parts = target.split("/").filter(part => part !== "" && part !== ".");
	let base = realParent;
	let at = 0;
	while (at < parts.length && parts[at] === "..") {
		base = path.dirname(base);
		at += 1;
	}
	const rest = parts.slice(at);
	if (rest.includes("..")) return undefined;
	return rest.length === 0 ? base : path.join(base, ...rest);
}

/**
 * Why a reclaim keeps a session whose transcript is a symbolic link: the file
 * it leads to is outside the session's tree and its leases, and moving the
 * link into the archive would leave that file where the session no longer
 * looks — a turn written there would be left behind.
 */
function transcriptLinkRefusal(sessionPath: string, target: string, kept: "was" | "would be"): string {
	return (
		`${sessionPath} is a symbolic link, to ${target}, which a reclaim does not give up: a turn written to that file ` +
		`would be left where this session no longer looks. The live copy ${kept} kept; to reclaim the session, replace ` +
		`the link with a copy of the transcript it leads to, at the same name, and reclaim again. The file it leads to ` +
		`is not touched`
	);
}

/**
 * Prove the archive holds every entry of a live tree, collecting its files
 * and its directories, deepest first.
 *
 * Nothing moves while this runs; the whole tree is settled first. Only
 * regular files the archive holds an independent copy of, with every byte,
 * and directories it holds a directory for, are collected. A FIFO, socket or
 * device has no copy. Neither does a symbolic link: a reference to something
 * outside the tree cannot be archived — only what it led to at one moment
 * can — so the tree is kept instead, and the user decides where the link
 * goes. Nothing an entry carries beyond its bytes is asked about: the entry
 * itself is what a reclaim moves, and a restore moves back.
 *
 * Throws the reason the first unproved entry could not be proved, with
 * nothing moved.
 */
async function proveLiveTreeIsArchived(
	source: string,
	destination: string,
	sourceRoot: string,
	proven: ProvenTree,
	residue: (entry: string) => string | undefined,
): Promise<void> {
	const stat = await fs.lstat(source).catch(error => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) return;
	if (stat.isDirectory()) {
		// A killed restore's stage, which the archive does not take: giving
		// up the live tree would remove it, and its record would then name
		// nothing a later run could find.
		const record = residue(source);
		if (record !== undefined) {
			throw new Error(
				await stagingResidueNote(
					source,
					record,
					"in the live artifact tree, where a killed restore leaves its stage, so a reclaim keeps it and the tree it is in",
				),
			);
		}
		// Held from here until the run ends, so no other directory can be
		// given its inode number while the run decides by it, and only while
		// it is the directory the walk saw — see {@link holdSeenDirectory}.
		const held = await holdSeenDirectory(source, stat);
		if (!held) throw new Error(`${source} changed while this run was proving it; it was kept`);
		proven.live.add(identityKey(held));
		try {
			// The archive must hold a directory of its own for it, which is
			// where a restore brings home anything only the archive holds.
			const refused = await archivedDirectoryRefusal(source, destination, proven.live);
			if (refused) throw new Error(refused);
			for (const entry of (await fs.readdir(source)).sort()) {
				await proveLiveTreeIsArchived(
					path.join(source, entry),
					path.join(destination, entry),
					sourceRoot,
					proven,
					residue,
				);
			}
		} catch (error) {
			await held.handle.close().catch(() => undefined);
			throw error;
		}
		// Appended after its children, so the list reads deepest first and a
		// copy directory is empty by the time freeing the copies reaches it.
		proven.directories.push({ path: source, destination, held });
		return;
	}
	if (!stat.isFile()) {
		// A link: what it leads to is outside this tree and its leases, so any
		// process can change it — a child added to a linked directory, a hop
		// of a chain rebound — and the archive holds only what it led to at one
		// moment. A link takes no space, so it is kept, the way a FIFO is, and
		// the user decides where it goes.
		if (stat.isSymbolicLink()) {
			// A relative link leads somewhere else once moved, so the advice for
			// one makes it absolute first — keeping every name it goes through.
			// The target as the kernel resolves it now is a snapshot: a link to
			// `outside/current` made into one to `outside/v1` no longer follows
			// `current` when it moves on, which is the very reason a reclaim
			// keeps links. So only the leading `..` steps, which climb out of
			// the link's own directory, are taken against that directory's real
			// path — no step back through this tree is left to stop resolving
			// once the tree moves — and the rest of the target is kept as written.
			const target = await fs.readlink(source);
			const resolved = await fs.realpath(source).catch((error: unknown) => {
				if (codeOf(error) === "ENOENT") return undefined;
				throw error;
			});
			let move =
				`move the link out of the tree — it keeps leading where it leads, and the archive holds what it led to ` +
				`when the session was archived — and reclaim again`;
			if (target !== undefined && !path.isAbsolute(target)) {
				const parent = await fs.realpath(path.dirname(source));
				const absolute = aliasPreservingTarget(parent, target);
				move =
					absolute !== undefined
						? `move the link out of the tree and reclaim again. It is a relative link, to ${target}, so moved as it ` +
							`is it would lead somewhere else: first make it absolute, keeping every name it goes through, with ` +
							`\`ln -sfn ${shellQuote(absolute)} ${shellQuote(source)}\`, then move it. The archive holds what it ` +
							`led to when the session was archived`
						: `move the link out of the tree and reclaim again. It is a relative link, to ${target}, so moved as it ` +
							`is it would lead somewhere else, and its target steps back with \`..\` after a name that may itself ` +
							`be a link, so no absolute form keeps it as it is: either spell the absolute target yourself, or ` +
							`freeze it at what it leads to now${resolved !== undefined ? `, ${resolved},` : ""} — a snapshot ` +
							`that no longer follows a name it went through when that name moves on`;
			}
			// Moved out, a link into this tree leads to an entry the reclaim then
			// moves into the archive; the archive holds it, but the link will lead nowhere.
			const realRoot = await fs.realpath(sourceRoot);
			if (resolved !== undefined && (resolved === realRoot || resolved.startsWith(`${realRoot}${path.sep}`))) {
				move +=
					`. It leads into this session's own tree, to ${resolved}, so once the session moves into the archive ` +
					`it will lead nowhere: the archive holds that entry, and \`omp gc --restore\` brings it back`;
			}
			throw new Error(
				`${source} is a symbolic link, which a reclaim does not give up: what it leads to is outside this ` +
					`session's tree and its leases, and the archive holds only what it led to at one moment. The live ` +
					`tree was kept; to reclaim this session, ${move}`,
			);
		}
		// A FIFO, a socket or a device: the archive holds nothing for it, so no
		// copy stands for it, and a reader of it in the archive would wait or fail.
		throw new Error(
			`${source} is ${stat.isFIFO() ? "a FIFO" : stat.isSocket() ? "a socket" : "a device"}, which the archive cannot ` +
				`hold, so the live tree was kept; move it out of the tree to reclaim this session`,
		);
	}
	// Only absence is nothing. A name that is not a regular file throws, in its
	// own words; any other look that fails says what is there could not be
	// read, which is not the same as the archive holding it.
	const live = await openRegularFile(source);
	if (!live) return;
	let liveStat: Stats;
	try {
		liveStat = await live.stat();
		if (!liveStat.isFile()) throw new Error(`${source} is not a file the archive can hold`);
		proven.live.add(identityKey(liveStat));
		const missing = await archivedFileRefusal(source, destination, proven.live);
		if (missing) throw new Error(missing);
		const independent = await survivesSourceRemoval(destination, sourceRoot);
		if (independent && "unchecked" in independent) throw new Error(independent.unchecked);
		if (independent)
			throw new Error(`${destination} is not an independent archived copy of ${source}: ${independent.seen}`);
		if (!(await archivedHandleIsHeldBy(live, liveStat, destination))) {
			throw new Error(`${source} holds what ${destination} does not`);
		}
	} finally {
		await live.close();
	}
	// The descriptor follows a link; the name has to be the file just read.
	const proved = identityFrom(liveStat);
	const missing = await archivedFileRefusal(source, destination, proven.live);
	if (missing) throw new Error(missing);
	// The archived copy as it stands now: the one file at its name a reclaim
	// may free once the original stands beside it — see {@link freeArchivedCopies}.
	const copy = await fs.lstat(destination);
	if ((await standsAsProved(source, proved)) !== true) {
		throw new Error(`${source} is no longer the file this run proved; it was kept`);
	}
	proven.files.push({ path: source, destination, copy: { dev: copy.dev, ino: copy.ino }, ...proved });
}

/**
 * Free the archived copies a reclaim's moved originals now stand beside.
 *
 * Only copies go: files at canonical archive names — see
 * `reclaimedTranscriptPath` (`session-archive.ts`) — each the very archived
 * copy the proof read. Each is moved to a private name and judged there
 * through a descriptor — see {@link removeFileOthersMayWrite} — so bytes
 * written to it by its name before the move are judged too, and it goes only
 * while three things hold at that last look: the kernel grants this run the
 * sole-open lease on the moved copy, so no other process holds it open to
 * write through later; the original's own lease, `leased`, held since before
 * the moves, is intact, so nothing opened or truncated the original since;
 * and the original holds every byte the copy holds. A review appended through
 * a descriptor held on the copy, and truncated the original, after the
 * proof, and the copy went with bytes the original no longer held. Then each
 * copy directory that is empty, deepest first, only while its name holds the
 * directory held open since this began — see {@link removeHeldDirectory}. An
 * entry only the archive holds, the archived transcript and anything at a
 * reclaimed name are never touched. What is left is the one system call
 * between that last look and the `unlink`, which POSIX cannot close, and a
 * process that opens a copy by the private name it was moved to — a name
 * only one watching gc's moves can know — while it is freed: its open waits
 * on the copy's lease, the check after the `unlink` writes the copy's bytes
 * back to its name, and what that process writes afterwards goes into the
 * unlinked file. Such a process ignores this run's lease on a name that is
 * this run's alone; it is outside what this guards.
 *
 * Returns what went; for each copy kept, why and where it is — a copy kept
 * costs space, never an original — and, apart, each copy unlinked whose
 * write-back could not finish, with how much of it is left.
 */
async function freeArchivedCopies(
	proven: ProvenTree,
	liveArtifacts: string,
	reclaimedTree: string,
	leased: readonly LeasedFile[],
): Promise<{ freed: string[]; kept: string[]; lost: string[] }> {
	const freed: string[] = [];
	const kept: string[] = [];
	const lost: string[] = [];
	const held: { path: string; held: HeldFile }[] = [];
	try {
		for (const directory of proven.directories) {
			try {
				const seen = await lstatIfPresent(directory.destination);
				if (!seen) continue;
				if (!seen.isDirectory()) {
					kept.push(`${directory.destination} is not a directory, so it was left as it is`);
					continue;
				}
				const holding = await holdSeenDirectory(directory.destination, seen);
				if (holding) held.push({ path: directory.destination, held: holding });
				else
					kept.push(
						`${directory.destination} no longer holds the directory this run saw, so it was left as it is`,
					);
			} catch (error) {
				kept.push(
					`${directory.destination} could not be checked (${errorMessage(error)}), so it was left as it is`,
				);
			}
		}
		for (const file of proven.files) {
			const copy = file.destination;
			const original = path.join(reclaimedTree, path.relative(liveArtifacts, file.path));
			const originalLease = leased.find(entry => entry.path === file.path);
			const isCopy = (stat: Stats): boolean =>
				stat.isFile() && stat.dev === file.copy.dev && stat.ino === file.copy.ino;
			// Read through the original's own leased descriptor, never by its
			// name: an open by name, this process's own included, breaks the
			// lease that proves nothing else opened or truncated it.
			const redundant = async (handle: fs.FileHandle): Promise<string | undefined> => {
				if (!originalLease) return `${original} is not one this run leased, so what it holds was not checked`;
				if (!soleOpenLeaseStands(originalLease.handle.fd)) {
					return `${leaseBrokenBecause(original)}, after it moved, so it may no longer hold what ${copy} holds`;
				}
				if (await handleBeginsWith(originalLease.handle, handle)) return undefined;
				return `${copy} holds bytes the original beside it, ${original}, does not`;
			};
			const removal = await removeFileOthersMayWrite(copy, {
				matches: isCopy,
				mismatch: `${copy} is no longer the archived copy this run proved`,
				judge: async (moved, handle) => {
					if (!isCopy(moved)) return `${copy} is no longer the archived copy this run proved`;
					if (!handle) return `${copy} could not be read where it was moved`;
					const lease = takeSoleOpenLease(handle.fd);
					if (lease.outcome === "open-elsewhere") {
						// The kernel refuses for any other open or a mapping, this
						// process's own included; a descriptor count cannot see a
						// mapping, so only a holder that is seen is named.
						const own = await ownDescriptorCount(moved);
						return own !== undefined && own > 1
							? `this omp process (${process.pid}) itself holds ${copy} open through ${own - 1} other ` +
									`${own === 2 ? "descriptor" : "descriptors"} (${lease.evidence}), and could write to it after it went`
							: `${copy} is open or mapped elsewhere (${lease.evidence}), by a process the kernel does not ` +
									`name, this one not excluded, and whoever holds it could write to it after it went`;
					}
					if (lease.outcome === "unproved") {
						return `whether anything else holds ${copy} open could not be told (${lease.evidence}: ${lease.meaning})`;
					}
					return await redundant(handle);
				},
				// The same, once more, after the `unlink`: a change in the one call
				// between the look above and the `unlink` — an open or a truncation
				// of either file blocks on its lease and shows here — writes the
				// copy's bytes back rather than losing them.
				confirm: async handle => {
					if (!soleOpenLeaseStands(handle.fd)) return `${leaseBrokenBecause(copy)}, as it went`;
					return await redundant(handle);
				},
			});
			if (removal.outcome === "removed") freed.push(copy);
			else if (removal.outcome === "kept") (removal.lost ? lost : kept).push(removal.note);
		}
		for (const directory of held) {
			let removal: HeldDirectoryRemoval;
			try {
				removal = await removeHeldDirectory(directory.path, directory.held);
			} catch (error) {
				kept.push(`${directory.path} could not be removed (${errorMessage(error)}), so it was left as it is`);
				continue;
			}
			// Not empty is what an entry only the archive holds, or a copy kept
			// above, leaves it: kept, and nothing more to say.
			if (removal === "removed") freed.push(directory.path);
		}
	} finally {
		for (const directory of held) await directory.held.handle.close().catch(() => undefined);
	}
	return { freed, kept, lost };
}

/**
 * Copy an artifact tree into the archive with symlinks resolved into real
 * files, leaving the live tree where it is. The archive must hold the bytes:
 * a link into a tree that is relocated or cleaned later archives a session
 * that cannot come back. `fs.rename` is not an option either — the archive
 * root is routinely a symlink onto another filesystem.
 *
 * A link whose target is already gone is skipped and counted: one broken
 * link must not make a session unarchivable forever.
 *
 * No archived file is replaced with bytes that do not begin with what it
 * already holds, and the deciding and the writing are the same walk of the
 * same tree — see {@link publishArtifactIntoArchive} and
 * {@link copyArtifactEntryIntoArchive}. That is not the same as "cannot lose
 * anything": a process that writes archive paths without the gc lock is
 * outside what this guards, and the last gap between a proof and the rename
 * it authorises belongs to it.
 *
 * A failure part-way through removes only what this copy wrote, so a retry
 * finds no stray tree of its own making — but anything the archive already
 * held stays. After a restore, which keeps its copy, the live tree is the
 * archived one carried on, and re-archiving it writes the longer copy over
 * the shorter rather than refusing.
 */
async function copyArtifactsTree(
	source: string,
	destination: string,
	recovery: string,
	ledger: string,
): Promise<{ brokenLinks: number; notes: string[] }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const residue = await stagingResidueUnder(path.dirname(ledger), source);
	const state: ArchiveCopyState = { brokenLinks: 0, created: [], recovery, ledger, notes: [], residue };
	try {
		await copyArtifactEntryIntoArchive(source, destination, source, state);
	} catch (error) {
		await removeTreeAdditions(state.created, state.notes);
		// What the copy left behind travels with the failure that caused it:
		// a note dropped on the error path is a file nobody is told about.
		if (state.notes.length > 0) throw new Error(`${errorMessage(error)}; ${state.notes.join("; ")}`);
		throw error;
	} finally {
		// Every entry this copy made was held until now — see {@link ArchiveCreation}.
		for (const made of state.created) await made.held.handle.close().catch(() => undefined);
	}
	return { brokenLinks: state.brokenLinks, notes: state.notes };
}

/**
 * Whether `destination` already holds exactly what archiving `source` would
 * write: a session archived before and unchanged since, which needs no
 * second copy of its transcript.
 *
 * The destination has to be a file of its own. A name that only points
 * somewhere else — at the live transcript, say — reads byte for byte as the
 * transcript while holding none of it, and once `--reclaim` gives the live
 * copy up the archive names nothing.
 *
 * Nothing at either name, or no regular file there, is "no"; a read that
 * fails throws, as it came — a failed read is not a different archive.
 */
async function archiveAlreadyHolds(source: string, destination: string): Promise<boolean> {
	if (!(await lstatIfPresent(destination))?.isFile()) return false;
	try {
		// Through the regular-file check: a FIFO at the live name is not waited
		// on, and is no transcript the archive could hold.
		const live = await digestStream(bytesOfRegularFile(source));
		const stored = await digestArchivedSessionFile(destination);
		return live.hash === stored.hash;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

/** Occupants of the names this archive owns, checked by preview and apply alike. */
async function checkArchiveNames(candidate: ArchiveCandidate): Promise<void> {
	const legacy = candidate.destinationPath.slice(0, -".gz".length);
	const legacyEntry = await lstatIfPresent(legacy);
	if (legacyEntry)
		throw new Error(
			`archive destination exists: ${legacy}${legacyEntry.isSymbolicLink() ? " is a symbolic link" : ""}`,
		);
	for (const file of [candidate.session.path, candidate.destinationPath]) {
		const standing = await lstatIfPresent(file);
		if (standing && !standing.isFile()) throw new NotARegularFile(file, kindOf(standing));
	}
	for (const dir of [sessionArtifactsPath(candidate.session.path), sessionArtifactsPath(candidate.destinationPath)]) {
		const standing = await lstatIfPresent(dir);
		if (standing && !standing.isDirectory())
			throw new Error(
				`${dir} is ${standing.isFile() ? "a regular file" : kindOf(standing)}, not an artifact directory`,
			);
	}
}

/**
 * Copy one session into the archive: the transcript compressed, then its
 * artifact tree. The live copy stays where it is.
 *
 * A destination that already holds this very transcript needs no second
 * copy of it; its artifact tree is still copied, since that can have grown.
 * What the copy left and why travels with a failure, as it does with a
 * success. A session whose originals a reclaim moved into the archive — see
 * `reclaimedTranscriptPath` (`session-archive.ts`) — is not archived at all
 * until a restore brings them home: its copies stand beside those originals,
 * and superseding them, or copying into them, would leave a copy beside an
 * original that does not hold it.
 */
async function copySessionIntoArchive(candidate: ArchiveCandidate): Promise<{ brokenLinks: number; notes: string[] }> {
	await checkArchiveNames(candidate);
	const sourceSession = candidate.session.path;
	const destSession = candidate.destinationPath;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	for (const original of [reclaimedTranscriptPath(destSession), reclaimedArtifactsPath(destSession)]) {
		if (!(await lstatIfPresent(original))) continue;
		const stem = path.basename(destSession, ".jsonl.gz");
		const target = stem.slice(stem.lastIndexOf("_") + 1) || stem;
		throw new Error(
			`${original} holds this session's own entries, which \`omp gc --reclaim\` moved into the archive, so ` +
				`${sourceSession} was not archived beside them. Look at both: move ${sourceSession} and its artifact ` +
				`directory ${sourceArtifacts} aside, bring the session home with \`omp gc --restore ${shellQuote(target)} ` +
				`--apply${candidate.recovery}\`, and archive again`,
		);
	}
	const archiveEntry = await lstatIfPresent(destSession);
	if (archiveEntry && !archiveEntry.isFile()) throw new NotARegularFile(destSession, kindOf(archiveEntry));
	const alreadyArchived = (await pathExists(destSession)) && (await archiveAlreadyHolds(sourceSession, destSession));
	// The archive holding an earlier part of this very session is what a
	// restore leaves behind: it copies and keeps its copy, so the next turn
	// makes the live transcript longer than the archive. That is this session
	// carried on, not a different one, and the archive takes the longer copy
	// rather than refusing for ever.
	const supersedes =
		(await pathExists(destSession)) &&
		!alreadyArchived &&
		(await lstatIfPresent(destSession))?.isFile() &&
		(await archiveIsPrefixOfLive(destSession, sourceSession))
			? await statIfPresent(destSession)
			: undefined;
	if ((await pathExists(destSession)) && !alreadyArchived && !supersedes) {
		const stem = path.basename(destSession, ".jsonl.gz");
		const target = stem.slice(stem.lastIndexOf("_") + 1) || stem;
		throw new Error(
			`the archive at ${destSession} holds a different session, so ${sourceSession} was left where it is. ` +
				`Bring the archived one home with \`omp gc --restore ${shellQuote(target)} --apply${candidate.recovery}\` ` +
				`and archive again; ` +
				`or keep it yourself by moving both halves out of the archive directory, the transcript ${destSession} ` +
				`and its artifact directory ${destArtifacts}, and archive again. Moving the transcript alone is not enough: ` +
				`the artifact directory left behind holds the other session's subagent transcripts and tool output, ` +
				`and archiving refuses rather than mixing them with this one's. ` +
				`Without \`--apply\`, \`--restore\` reports what it would do and changes nothing.`,
		);
	}

	let brokenLinks = 0;
	// Nothing is removed here. Copying the session into the archive is the
	// whole of this phase, and the live copy stays until someone asks for the
	// space back by name with `--reclaim`. Every data-loss finding this change
	// has had came from a deletion that ran in the same breath as the copy
	// that justified it, so the one deletion left in this feature lives in a
	// command whose only job is deletion, on a session an operator names.
	//
	// An archive that already holds this transcript needs no second copy of
	// it; its artifact tree still does.
	const notes: string[] = [];
	try {
		if (!alreadyArchived) await gzipSessionFile(sourceSession, destSession, candidate.ledger, notes, supersedes);
		else await carryLiveModeToArchive(sourceSession, destSession);
		if (await pathExists(sourceArtifacts)) {
			const copied = await copyArtifactsTree(sourceArtifacts, destArtifacts, candidate.recovery, candidate.ledger);
			brokenLinks = copied.brokenLinks;
			notes.push(...copied.notes);
		}
	} catch (error) {
		// What the copy left behind travels with the failure that caused it.
		if (notes.length > 0) throw new Error(`${errorMessage(error)}; ${notes.join("; ")}`);
		throw error;
	}
	// An earlier restore's record of being unfinished is never removed here:
	// this run did not write it, and a run removes only what it made itself.
	// What a file at that name holds is no evidence of who wrote it — a crash,
	// an older version or another program can leave anything there. It is
	// reported, with what the live tree still lacks or that it lacks nothing.
	const record = restoreRecordPath(destSession);
	const standing = await fs.lstat(record).catch((error: unknown) => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (standing) {
		const outstanding = await archivedPathsWithoutLiveCopies(destSession, sourceSession);
		notes.push(
			outstanding.length === 0
				? `${record} records a restore that did not finish, and ${sourceSession} now holds every entry the archive ` +
						`holds; this run did not write that record, so it was left — while it is there the session is treated ` +
						`as unfinished: look at it, and move it aside. ${moveAsidePermission(record)}`
				: `${sourceSession} is still missing ${outstanding.length} of the entries the archive holds ` +
						`(${outstanding[0]}${outstanding.length > 1 ? ", …" : ""}), so the unfinished restore recorded at ` +
						`${record} was kept; run \`omp gc --restore ${shellQuote(path.basename(destSession, ".jsonl.gz"))} --apply${candidate.recovery}\``,
		);
	}
	return { brokenLinks, notes };
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

async function runArchiveGc(options: ResolvedGcOptions, archiveRoot: string): Promise<ArchiveGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const errors: string[] = [];
	const sessions = await listActiveSessions(sessionsRoot, errors);
	const cutoffMs = Date.now() - options.coldArchiveAfterDays * DAY_MS;
	const result: ArchiveGcResult = {
		archiveDir: archiveRoot,
		scanned: errors.length === 0 ? sessions.length : undefined,
		skippedActive: 0,
		keptNewestGlobal: 0,
		keptNewestPerCwd: 0,
		wouldArchive: 0,
		archived: 0,
		brokenLinks: options.apply ? 0 : undefined,
		errors,
	};
	const candidates: ArchiveCandidate[] = [];
	let inactiveSeen = 0;
	const inactiveSeenByCwd = new Map<string, number>();
	const archiveBeforeMs = Date.now() - GC_WRITE_GRACE_MS;

	for (const session of sessions) {
		if (session.status && ACTIVE_STATUSES.has(session.status)) {
			result.skippedActive += 1;
			continue;
		}
		if (session.modified.getTime() > archiveBeforeMs) {
			result.skippedActive += 1;
			continue;
		}
		try {
			if (await hasLiveNestedSessions(session, archiveBeforeMs)) {
				result.skippedActive += 1;
				continue;
			}
		} catch (error) {
			result.errors.push(
				`${session.path} was kept: its nested sessions could not be checked (${errorMessage(error)})`,
			);
			continue;
		}
		const cwdKey = sessionCwdKey(sessionsRoot, session);
		const cwdSeen = inactiveSeenByCwd.get(cwdKey) ?? 0;
		const keepGlobal = inactiveSeen < options.retainNewestGlobal;
		const keepPerCwd = cwdSeen < options.retainNewestPerCwd;
		inactiveSeen += 1;
		inactiveSeenByCwd.set(cwdKey, cwdSeen + 1);
		if (keepGlobal) {
			result.keptNewestGlobal += 1;
			continue;
		}
		if (keepPerCwd) {
			result.keptNewestPerCwd += 1;
			continue;
		}
		if (options.coldArchiveAfterDays > 0 && session.modified.getTime() > cutoffMs) continue;
		const destination = archiveDestination(archiveRoot, sessionsRoot, session);
		if (!destination) continue;
		candidates.push({
			...destination,
			session,
			recovery: agentDirFlag(options.agentDir),
			ledger: stagingLedgerDir(options.agentDir),
		});
	}

	// Before this run stages anything of its own, so every staging record
	// standing now is a dead run's, or somebody's. Reported, never removed:
	// only the run that made a staging directory or a ledger file removes it,
	// by the identity it captured making it — see
	// {@link surveyRecordedStagingGrounds}. Preview and applying see the same.
	const grounds = await surveyRecordedStagingGrounds(options.agentDir);
	if (grounds.residue.length > 0) result.stagingResidue = grounds.residue;
	if (grounds.withoutDirectory.length > 0) result.stagingRecordsWithoutDirectory = grounds.withoutDirectory;
	result.errors.push(...grounds.notes);

	// An archived session keeps every row that describes it. Its prompt-history,
	// title and recap rows exist nowhere else, and its stats rows are only
	// re-derivable while a transcript is in the sessions tree, so a command
	// that copies a session into the archive must not delete them.
	for (const candidate of candidates) {
		// A session a live process still owns is left alone, the way
		// `--compress` does it: the five-minute write grace alone would archive
		// a session under its writer and lose the turn it was about to append.
		// The dry run takes the lease too, so `wouldArchive` counts what
		// `--apply` would really take.
		let tree: { leases: FileLockHandle[]; transcripts: Set<string> } | null = null;
		try {
			const leased = await tryAcquireSessionTreeLeases(
				candidate.session,
				await collectSessionFiles(candidate.session),
			);
			if ("file" in leased) {
				// A live owner is skipped as active; an owner that could not be
				// probed is kept too, but said as a failed check, with why.
				if (leased.unprobed === undefined) result.skippedActive += 1;
				else result.errors.push(treeLeaseRefusalText(leased, `${candidate.session.path} was not archived`));
				continue;
			}
			tree = leased;
			await checkArchiveNames(candidate);
			result.wouldArchive += 1;
			if (!options.apply) continue;
			const { brokenLinks, notes } = await copySessionIntoArchive(candidate);
			result.archived += 1;
			if (result.brokenLinks !== undefined) result.brokenLinks += brokenLinks;
			result.errors.push(...notes);
		} catch (error) {
			result.brokenLinks = undefined;
			result.errors.push(`${candidate.session.path}: ${errorMessage(error)}`);
		} finally {
			for (const held of tree?.leases ?? []) held.release();
		}
	}
	return result;
}

/**
 * Every file of a session: its transcript plus its artifact tree (subagent
 * transcripts, tool output).
 *
 * `followSymlinks`, the way {@link scanSessionTree} walks the sessions tree
 * and the nested-session scan reads an artifact tree: a subagent transcript
 * reached through a directory link below the artifact tree is a transcript a
 * process can own, and the ownership leases are taken from exactly this list.
 * A walk that stopped at the link would archive a session out from under its
 * live writer.
 */
async function collectSessionFiles(session: SessionInfo): Promise<string[]> {
	const artifactsDir = sessionArtifactsPath(session.path);
	const files = [session.path];
	try {
		for await (const name of ANY_FILE_GLOB.scan({
			cwd: artifactsDir,
			dot: true,
			onlyFiles: true,
			followSymlinks: true,
		})) {
			if (isCompressScratchPath(name)) continue;
			files.push(path.join(artifactsDir, name));
		}
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
	return files;
}

/**
 * Session id in `file`'s header, or undefined when it has none. A file is
 * streamed only when its first byte past JSON whitespace opens a record (the
 * header or the title slot before it), or when its sampled prefix is all
 * whitespace; other binary and plain-text artifacts cost one small read.
 */
async function readArtifactSessionId(file: string): Promise<string | undefined> {
	// Through a descriptor that holds a regular file: an artifact that is, or
	// links to, a FIFO, a socket or a device is no transcript, and reading it
	// would wait on it or take what is written to it. It owns nothing here;
	// the archive copy names it as what the archive cannot hold, and the
	// reclaim keeps the live tree for it.
	const handle = await openRegularFile(file).catch(notRegularAsAbsent);
	if (!handle) return undefined;
	try {
		const sniff = Buffer.allocUnsafe(HEADER_SNIFF_BYTES);
		const { bytesRead } = await handle.read(sniff, 0, sniff.byteLength, 0);
		const prefix = new TextDecoder().decode(sniff.subarray(0, bytesRead)).replace(/^[ \t\r\n]+/, "");
		if (prefix !== "" && prefix[0] !== "{") return undefined;
		return await readSessionHeaderIdFromHandle(handle);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** The ownership leases a run holds over a session tree. */
interface SessionTreeLeases {
	leases: FileLockHandle[];
	/** Session ids already leased, so a copied transcript that shares one is not leased twice. */
	leasedIds: Set<string>;
	/** Files found to be transcripts. */
	transcripts: Set<string>;
}

/**
 * Lease every transcript among `files` that `tree` does not already cover,
 * found by its session header rather than its name: subagent sessions, or
 * any file a process can open with `--session`. Each session id is leased
 * once, so a copied transcript that shares an id does not read as live.
 *
 * Returns the first file whose owner is live, or whose owner could not be
 * probed — with why, then: an unknown owner keeps the session as a live one
 * does, but is reported as a failed check, never as a running process —
 * with every lease taken so far left in `tree`; undefined once each one is
 * held.
 */
async function leaseTranscripts(
	tree: SessionTreeLeases,
	files: readonly string[],
): Promise<TreeLeaseRefusal | undefined> {
	for (const file of files) {
		let lease: FileLockHandle | null;
		try {
			const sessionId = await readArtifactSessionId(file);
			if (sessionId === undefined) continue;
			tree.transcripts.add(file);
			if (tree.leasedIds.has(sessionId)) continue;
			lease = tryAcquireSessionLease(sessionId);
			if (lease) tree.leasedIds.add(sessionId);
		} catch (error) {
			if (codeOf(error) === "ENOENT") continue;
			return { file, unprobed: errorMessage(error) };
		}
		if (lease === null) return { file };
		tree.leases.push(lease);
	}
	return undefined;
}

/** A transcript of a session tree that could not be leased: owned by a live process, or its owner not known, and why. */
interface TreeLeaseRefusal {
	file: string;
	unprobed?: string;
}

/** The refusal for `refused`, in words for what was seen: a live owner, or an owner check that failed. */
function treeLeaseRefusalText(refused: TreeLeaseRefusal, tail: string): string {
	return refused.unprobed === undefined
		? `a running process owns ${refused.file}; ${tail}`
		: `whether a running process owns ${refused.file} could not be checked (${refused.unprobed}); ${tail}`;
}

/**
 * Leases of every transcript in a session: its own and those nested in its
 * artifact tree — see {@link leaseTranscripts}. The refusal, with every
 * lease taken so far released, when any of them is live or cannot be probed.
 */
async function tryAcquireSessionTreeLeases(
	session: SessionInfo,
	files: string[],
): Promise<SessionTreeLeases | TreeLeaseRefusal> {
	const tree: SessionTreeLeases = { leases: [], leasedIds: new Set(), transcripts: new Set([session.path]) };
	const refused = await leaseTranscripts(tree, files);
	if (refused === undefined) return tree;
	for (const held of tree.leases) held.release();
	return refused;
}

/**
 * Store idle sessions compressed in place. A session qualifies once its
 * transcript is `compressAfterDays` old and no running process holds its
 * ownership lease; files written more recently than that are left alone.
 * Unlike archiving, an interrupted last turn does not exclude a session:
 * paths, bytes, and mtimes are unchanged and no history or stats rows are
 * deleted, so it stays resumable. Leftover scratch directories from a killed
 * run are removed first. A session that fails is reported and skipped.
 */
async function runCompressGc(options: ResolvedGcOptions, archiveRoot: string): Promise<CompressGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const method = await compressMethod(sessionsRoot);
	const result: CompressGcResult = {
		supported: method !== undefined,
		method,
		scanned: 0,
		skippedLive: 0,
		sessions: 0,
		wouldCompress: 0,
		compressed: 0,
		bytes: 0,
		allocatedBefore: 0,
		allocatedAfter: 0,
		leftoverScratchDirs: 0,
		errors: [],
	};
	if (method === undefined) return result;

	if (method === "apfs") {
		// Only the APFS copy-and-swap uses scratch directories. Archiving can carry a
		// leftover inside an artifact tree into the archive root.
		result.leftoverScratchDirs = await sweepCompressScratch(
			[sessionsRoot, archiveRoot],
			options.apply,
			result.errors,
		);
	}
	if (options.apply) {
		// Without it, a volume that ignores the request would still copy and verify every candidate.
		try {
			if (!(await compressionWorks(sessionsRoot, method))) {
				result.probeFailure = `${method} compression stored a compressible probe file uncompressed`;
				return result;
			}
		} catch (error) {
			result.errors.push(`compression probe: ${errorMessage(error)}`);
			return result;
		}
	}
	const listingErrors: string[] = [];
	const sessions = await listActiveSessions(sessionsRoot, listingErrors);
	result.errors.push(...listingErrors);
	result.scanned = listingErrors.length === 0 ? sessions.length : undefined;
	const cutoffMs = Date.now() - Math.max(options.compressAfterDays * DAY_MS, GC_WRITE_GRACE_MS);
	for (const session of sessions) {
		if (session.modified.getTime() > cutoffMs) continue;
		let files: string[];
		try {
			files = await collectSessionFiles(session);
		} catch (error) {
			result.errors.push(`${session.path}: ${errorMessage(error)}`);
			continue;
		}
		const candidates: CompressCandidate[] = [];
		for (const file of files) {
			try {
				const candidate = await compressCandidate(file);
				if (candidate && candidate.mtimeMs <= cutoffMs) candidates.push(candidate);
			} catch (error) {
				if (codeOf(error) !== "ENOENT") result.errors.push(`${file}: ${errorMessage(error)}`);
			}
		}
		if (candidates.length === 0) continue;
		let tree: { leases: FileLockHandle[]; transcripts: Set<string> } | null = null;
		try {
			const leased = await tryAcquireSessionTreeLeases(session, files);
			if ("file" in leased) {
				if (leased.unprobed === undefined) result.skippedLive += 1;
				else result.errors.push(treeLeaseRefusalText(leased, `${session.path} was not compressed`));
				continue;
			}
			tree = leased;
			result.sessions += 1;
			result.wouldCompress += candidates.length;
			for (const candidate of candidates) {
				result.bytes += candidate.bytes;
				result.allocatedBefore += candidate.allocated;
			}
			if (!options.apply) continue;
			const batch = await compressFilesInPlace(candidates, method, tree.transcripts);
			result.compressed += batch.compressed;
			result.allocatedAfter += batch.allocatedAfter;
			result.errors.push(...batch.errors);
		} catch (error) {
			result.errors.push(`${session.path}: ${errorMessage(error)}`);
		} finally {
			// Held through the rewrite so no omp process resumes the session mid-swap.
			for (const held of tree?.leases ?? []) held.release();
		}
	}
	return result;
}

async function checkpointWal(dbPath: string, apply: boolean): Promise<WalCheckpointResult> {
	const walPath = `${dbPath}-wal`;
	let walBytes = 0;
	try {
		walBytes = (await fs.stat(walPath)).size;
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
	const result: WalCheckpointResult = {
		dbPath,
		walBytes,
		wouldCheckpoint: walBytes > 0,
		checkpointed: false,
		busy: 0,
		log: 0,
		checkpointedFrames: 0,
	};
	if (!apply || !(await pathExists(dbPath))) return result;

	const db = new Database(dbPath);
	let checkpointAttempted = false;
	try {
		db.run("PRAGMA busy_timeout = 5000");
		using checkpointStmt = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
		const row = checkpointStmt.get() as WalCheckpointRow | null;
		checkpointAttempted = true;
		result.busy = sqliteNumber(row?.busy);
		result.log = sqliteNumber(row?.log);
		result.checkpointedFrames = sqliteNumber(row?.checkpointed);
	} finally {
		db.close();
	}
	try {
		result.walBytes = (await fs.stat(walPath)).size;
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
		result.walBytes = 0;
	}
	if (checkpointAttempted && (result.busy > 0 || result.walBytes > 0)) {
		throw new Error(`WAL checkpoint failed for ${dbPath}: busy=${result.busy}, walBytes=${result.walBytes}`);
	}
	result.checkpointed = checkpointAttempted;
	return result;
}

async function runWalGc(options: ResolvedGcOptions): Promise<WalGcResult> {
	const databases = await Promise.all(
		[getHistoryDbPath(options.agentDir), getModelDbPath(options.agentDir)].map(dbPath =>
			checkpointWal(dbPath, options.apply),
		),
	);
	return {
		databases,
		walBytes: databases.reduce((total, db) => total + db.walBytes, 0),
		wouldCheckpoint: databases.some(db => db.wouldCheckpoint),
		checkpointed: databases.some(db => db.checkpointed),
	};
}

export function renderText(result: GcResult): string {
	const lines = [`GC ${result.apply ? "applied" : "dry-run"} (${result.agentDir})`];
	if (result.stale) {
		const stale = result.stale;
		lines.push(
			`stale: ${stale.deleted}/${stale.wouldDelete} entries, ${formatBytes(stale.bytes)} (${stale.danglingMarkers} session markers, ${stale.staleBreadcrumbs} breadcrumbs, ${stale.expiredReports} reports, ${stale.expiredReplicas} collab replicas)`,
		);
		if (stale.errors.length > 0) lines.push(`stale errors: ${stale.errors.length}`);
	}
	if (result.blobs) {
		lines.push(
			`blobs: ${result.blobs.deleted}/${result.blobs.wouldDelete} files, ${formatBytes(result.blobs.bytes)}, ${result.blobs.referenced} refs`,
		);
		if (result.blobs.errors.length > 0) lines.push(`blob errors: ${result.blobs.errors.length}`);
	}
	if (result.archive) {
		lines.push(`sessions: ${result.archive.archived}/${result.archive.wouldArchive} archived`);
		if (!result.apply && result.archive.wouldArchive > 0) {
			// The dry run is where this has to be read: archiving copies and
			// keeps both sides, so it frees nothing by itself.
			lines.push(
				`these sessions would be copied to ${result.archive.archiveDir}, keeping the live copy; ` +
					`\`omp gc --reclaim <id> --apply --forward-only${agentDirFlag(result.agentDir)}\` gives the live one up afterwards`,
			);
		}
		if (result.archive.skippedActive > 0) lines.push(`sessions skipped active: ${result.archive.skippedActive}`);
		for (const residue of result.archive.stagingResidue ?? []) {
			lines.push(`staging recorded as left by a killed gc run, kept where it is: ${residue}`);
		}
		for (const record of result.archive.stagingRecordsWithoutDirectory ?? []) {
			lines.push(
				`staging record whose directory is gone, kept: ${record}; it narrows nothing, and can be moved out of ` +
					`${path.dirname(record)} by hand`,
			);
		}
		if (result.archive.brokenLinks === undefined) {
			lines.push("links inside artifact trees whose target was gone: unknown (not counted completely)");
		} else if (result.archive.brokenLinks > 0) {
			lines.push(`links inside artifact trees whose target was gone: ${result.archive.brokenLinks}`);
		}
		if (result.archive.errors.length > 0) lines.push(`session errors: ${result.archive.errors.length}`);
	}
	if (result.restore) {
		const restore = result.restore;
		for (const home of restore.movedHome ?? []) {
			lines.push(`restore: ${result.apply ? "moved" : "would move"} the reclaimed original home to ${home}`);
		}
		if (restore.setAsideRecord) {
			lines.push(
				result.apply
					? `restore: a dead restore's record was set aside, kept whole, at ${restore.setAsideRecord}`
					: `restore: would set aside the record a dead restore left at ${restore.setAsideRecord}`,
			);
		}
		if (restore.sessionPath) {
			const verb = result.apply ? "restored" : "would restore";
			const artifacts = restore.artifactsRestored ? " with its artifacts" : "";
			lines.push(`restore: ${verb} ${restore.archivePath} to ${restore.sessionPath}${artifacts}`);
		}
		const missing = restore.missingArtifacts ?? [];
		if (missing.length > 0) {
			lines.push(
				`restore: would bring back ${missing.length} artifact ${missing.length === 1 ? "entry" : "entries"} the live ` +
					`tree lacks (${missing[0]}${missing.length > 1 ? ", …" : ""})`,
			);
		}
		for (const note of restore.notRestored) lines.push(`not restored: ${note}`);
		if (restore.errors.length > 0) lines.push(`restore errors: ${restore.errors.length}`);
	}
	if (result.reclaim) {
		const reclaim = result.reclaim;
		const moved = [reclaim.moved?.transcript, reclaim.moved?.artifacts].filter(entry => entry !== undefined);
		if (reclaim.reclaimed > 0 && reclaim.sessionPath) {
			lines.push(
				`reclaim: moved ${reclaim.sessionPath}${reclaim.moved?.artifacts ? " and its artifact tree" : ""} into the ` +
					`archive (${moved.join(", ")}); the session is now only in the archive, beside ${reclaim.archivePath}`,
			);
			const freed = reclaim.freedCopies?.length ?? 0;
			if (freed > 0)
				lines.push(`reclaim freed ${freed} archived ${freed === 1 ? "copy" : "copies"} the originals hold`);
			for (const note of reclaim.keptCopies ?? []) lines.push(`reclaim kept an archived copy: ${note}`);
			for (const note of reclaim.lostCopies ?? []) {
				lines.push(`reclaim could not write back all of an archived copy: ${note}`);
			}
		} else if (moved.length > 0) {
			// Neither "moved nothing" nor "kept the tree" is true once an
			// original is at a reclaimed name: one line, saying where.
			lines.push(
				`reclaim: stopped with part of ${reclaim.sessionPath ?? reclaim.query} at ${moved.join(", ")} — see the ` +
					`error for how to bring it home`,
			);
		} else if (reclaim.wouldReclaim) {
			lines.push(
				`reclaim: would move ${reclaim.sessionPath} into the archive; the session would then be only in the ` +
					`archive, beside ${reclaim.archivePath}`,
			);
		} else {
			// A refusal has to read as one. Reporting only what moved lets a
			// run that moved nothing print the same line as a run that worked.
			const verb = result.apply ? "gave up nothing" : "would give up nothing";
			lines.push(`reclaim: ${verb} for "${reclaim.query}"`);
		}
		if (reclaim.keptArtifactTree !== undefined) {
			lines.push(`reclaim kept the live artifact tree: ${reclaim.keptArtifactTree}`);
		}
		if (reclaim.errors.length > 0) lines.push(`reclaim errors: ${reclaim.errors.length}`);
	}
	if (result.compress) {
		const compress = result.compress;
		if (!compress.supported) {
			lines.push("compress: unsupported on this filesystem (APFS or NTFS only)");
		} else {
			if (compress.probeFailure !== undefined) {
				lines.push(`compress skipped: ${compress.probeFailure}`);
			} else {
				const after = result.apply ? `, ${formatBytes(compress.allocatedAfter)} after` : "";
				lines.push(
					`compress: ${compress.compressed}/${compress.wouldCompress} files in ${compress.sessions} sessions, ${formatBytes(compress.allocatedBefore)} on disk before${after}`,
				);
				if (compress.skippedLive > 0) lines.push(`compress skipped live: ${compress.skippedLive}`);
			}
			if (compress.leftoverScratchDirs > 0) {
				const verb = result.apply ? "removed" : "found";
				lines.push(`compress leftover scratch dirs ${verb}: ${compress.leftoverScratchDirs}`);
			}
			if (compress.errors.length > 0) lines.push(`compress errors: ${compress.errors.length}`);
		}
	}
	if (result.wal) {
		const state = result.wal.checkpointed ? "checkpointed" : "checkpoint dry-run";
		lines.push(`wal: ${state}, ${formatBytes(result.wal.walBytes)} across ${result.wal.databases.length} dbs`);
	}
	for (const note of result.lockNotReleased ?? []) lines.push(`gc lock left behind: ${note}`);
	return `${lines.join("\n")}\n`;
}

/**
 * What `--restore --apply` would refuse, leave or bring back, for the
 * preview to say first. It runs the restore itself in its plan mode — the
 * same steps, refusals and order, each write replaced by a check that it
 * could be made — so the preview cannot promise what the apply would then
 * refuse: a preview that walked the trees its own way did, three rounds
 * running, for a different reason each time.
 */
async function previewRestore(
	archiveFile: string,
	sessionPath: string,
	agentDir: string,
): Promise<{ refusals: string[]; missing?: string[]; movedHome?: string[]; setAsideRecord?: string }> {
	const plan = newRestorePlan(sessionPath.slice(0, -".jsonl".length));
	try {
		const planned = await restoreArchivedSessionLocked(archiveFile, agentDir, plan);
		return {
			refusals: planned.notRestored,
			missing: plan.missing.sort(),
			movedHome: planned.movedHome,
			setAsideRecord: planned.setAsideRecord,
		};
	} catch (error) {
		return { refusals: [errorMessage(error)] };
	}
}

/**
 * Bring one archived session back to the sessions tree, and say what coming
 * back does not include. A person should not have to reconstruct the original
 * path and run `gunzip` by hand — and a hand-run `gunzip -c … > …` truncates
 * its destination when the archive turns out to be short.
 */
async function runRestoreGc(options: ResolvedGcOptions, query: string): Promise<RestoreGcResult> {
	const result: RestoreGcResult = { query, bytes: 0, artifactsRestored: false, notRestored: [], errors: [] };
	let matches: string[];
	try {
		matches = isArchivedSessionPath(query)
			? [path.resolve(query)]
			: await findArchivedSessionFiles(query, options.agentDir);
	} catch (error) {
		result.errors.push(errorMessage(error));
		return result;
	}
	if (matches.length === 0) {
		const archived = await listArchivedSessionFiles(options.agentDir);
		result.errors.push(
			`no archived session matches "${query}" among ${archived.length} in ${getArchivedSessionsDir(options.agentDir)}`,
		);
		return result;
	}
	if (matches.length > 1) {
		result.errors.push(
			`"${query}" matches ${matches.length} archived sessions; name one of them:\n${matches.map(file => `  ${file}`).join("\n")}`,
		);
		return result;
	}
	const archiveFile = matches[0];
	try {
		const standing = await lstatIfPresent(archiveFile);
		if (!standing) {
			result.errors.push(`no such archive file: ${archiveFile}`);
			return result;
		}
		if (!standing.isFile()) throw new NotARegularFile(archiveFile, kindOf(standing));
	} catch (error) {
		result.errors.push(`${archiveFile} could not be checked (${errorMessage(error)})`);
		return result;
	}
	result.archivePath = archiveFile;
	const sessionPath = liveSessionPathForArchive(archiveFile, options.agentDir);
	if (!options.apply) {
		// Say now what --apply would refuse, instead of promising a restore.
		if (!sessionPath) {
			result.errors.push(
				`"${archiveFile}" is not in ${getArchivedSessionsDir(options.agentDir)}; inflate it yourself with \`gunzip\``,
			);
			return result;
		}
		// What applying would bring home, and what it would refuse.
		const preview = async (): Promise<RestoreGcResult> => {
			result.sessionPath = sessionPath;
			const { refusals, missing, movedHome, setAsideRecord } = await previewRestore(
				archiveFile,
				sessionPath,
				options.agentDir,
			);
			result.errors.push(...refusals);
			result.notRestored.push(...refusals);
			if (missing) result.missingArtifacts = missing;
			if (movedHome && movedHome.length > 0) result.movedHome = movedHome;
			if (setAsideRecord) result.setAsideRecord = setAsideRecord;
			return result;
		};
		try {
			const live = await lstatIfPresent(sessionPath);
			if (live && !live.isFile()) throw new NotARegularFile(sessionPath, kindOf(live));
			if (live) {
				// Finish an interrupted restore only for this same session, carried on or not.
				if (!(await archiveIsPrefixOfLive(archiveFile, sessionPath))) {
					result.errors.push(
						`a different session file already exists at ${sessionPath}; nothing would be restored`,
					);
					return result;
				}
				return await preview();
			}
		} catch (error) {
			result.errors.push(`${sessionPath} could not be checked (${errorMessage(error)})`);
			return result;
		}
		try {
			// A dry run that cannot read the archive must say so, not promise a
			// restore that `--apply` then fails.
			await inflateArchivedBytes(archiveFile);
		} catch (error) {
			result.errors.push(`${archiveFile} cannot be read: ${errorMessage(error)}`);
			return result;
		}
		return await preview();
	}
	try {
		// This command already holds the gc lock for the whole run.
		const restored = await restoreArchivedSessionLocked(archiveFile, options.agentDir);
		result.sessionPath = restored.sessionPath;
		result.bytes = restored.bytes;
		result.artifactsRestored = restored.artifactsRestored;
		if (restored.movedHome.length > 0) result.movedHome = restored.movedHome;
		if (restored.setAsideRecord) result.setAsideRecord = restored.setAsideRecord;
		// An artifact tree left behind — a conflict, or a recorded staging
		// directory it left out — is a half-restored session, not a note.
		result.errors.push(...restored.notRestored);
		result.notRestored.push(...restored.notRestored);
	} catch (error) {
		result.errors.push(errorMessage(error));
		return result;
	}
	// Facts about what a transcript can and cannot carry. This build deletes
	// no rows when it archives; an older one did, and only the stats rows of
	// those come back.
	result.notRestored.push(
		"prompt history, the session title and recaps: they are not in the transcript, so if an older `gc --archive` deleted this session's rows nothing rebuilds them",
		"stats rows: `omp stats` re-reads the restored transcript and puts them back",
	);
	return result;
}

/**
 * Give back the space an archived session's live copy occupies, without
 * deleting an original.
 *
 * **gc never deletes an original.** The live transcript and the live artifact
 * tree leave their names only by `rename`, into the archive beside their
 * copies — see `reclaimedTranscriptPath` (`session-archive.ts`) — which keeps
 * each inode and so everything it carries: every mode bit, the owner and the
 * group, every extended attribute (`trusted.*` too, which this process cannot
 * even list), ACLs, inode flags, link counts and times. What frees the space
 * is deleting the archive's copies of them, and only a copy gc made, at a
 * canonical archive name, whose bytes the moved original holds — see
 * {@link freeArchivedCopies}. The archived transcript stays, so everything
 * that finds the session by it still does, and a restore moves the originals
 * home by rename. Where a rename cannot be made — the archive on another
 * filesystem (`EXDEV`), or any other refusal — nothing moves and nothing is
 * deleted: no copy carries the change time, the birth time or the inode, so
 * nothing could prove a copy carries everything.
 *
 * What is proved before anything moves, under the gc lock and the ownership
 * lease of every transcript in the tree, a subagent's that joined after the
 * tree was listed included: every live entry is a regular file or a
 * directory (a link, a FIFO, a socket or a device keeps the session), none is
 * a killed restore's stage, the archive holds an independent copy of each
 * with every byte, none of those copies is a live entry under another name,
 * and the transcript is what its archived copy inflates to. Then the kernel
 * is asked to prove no other process holds a file open — see
 * {@link leaseLiveFiles} — each name is checked once more to hold what was
 * proved — see {@link treeChangedSinceProof} — and the moves are made, the
 * transcript first: it is also the mark that the session is reclaimed. After
 * them, a lease broken by another process's open, an entry the proof never
 * saw in the moved tree, or anything put at a live name puts both back.
 *
 * What a crash leaves keeps every byte and every original. Killed between the
 * moves, the transcript is at its reclaimed name and the tree is live:
 * opening the session or `omp gc --restore` moves the transcript home. Killed
 * while the copies are freed, both originals are at their reclaimed names and
 * a restore brings both home. A copy a kill there leaves at a private
 * `.leaving` name in the archived tree is a copy, which a restore carries home
 * as an artifact.
 */
async function runReclaimGc(options: ResolvedGcOptions, query: string): Promise<ReclaimGcResult> {
	const result: ReclaimGcResult = { query, reclaimed: 0, errors: [] };
	try {
		return await reclaimSessionGc(options, query, result);
	} catch (error) {
		result.errors.push(errorMessage(error));
		if (result.sessionPath) {
			const artifacts = result.sessionPath.slice(0, -".jsonl".length);
			try {
				if (await lstatIfPresent(artifacts)) result.keptArtifactTree = artifacts;
			} catch (failure) {
				result.errors.push(`${artifacts} could not be checked (${errorMessage(failure)})`);
			}
		}
	}
	return result;
}

async function reclaimSessionGc(
	options: ResolvedGcOptions,
	query: string,
	result: ReclaimGcResult,
): Promise<ReclaimGcResult> {
	let matches: string[];
	try {
		matches = isArchivedSessionPath(query)
			? [path.resolve(query)]
			: await findArchivedSessionFiles(query, options.agentDir);
	} catch (error) {
		// Returned, not thrown: a command that cannot find what it was asked
		// about has an answer, and throwing it past the result means the
		// caller reports nothing at all.
		result.errors.push(errorMessage(error));
		return result;
	}
	if (matches.length !== 1) {
		const archived = await listArchivedSessionFiles(options.agentDir);
		result.errors.push(
			matches.length === 0
				? `no archived session matches "${query}" among ${archived.length} in ${getArchivedSessionsDir(options.agentDir)}`
				: `"${query}" matches ${matches.length} archived sessions; name one of them:\n${matches.map(file => `  ${file}`).join("\n")}`,
		);
		return result;
	}
	const archiveFile = matches[0];
	result.archivePath = archiveFile;
	const archiveEntry = await lstatIfPresent(archiveFile);
	if (!archiveEntry) {
		result.errors.push(`no such archive file: ${archiveFile}`);
		return result;
	}
	if (!archiveEntry.isFile()) throw new NotARegularFile(archiveFile, kindOf(archiveEntry));
	const sessionPath = liveSessionPathForArchive(archiveFile, options.agentDir);
	const recovery = agentDirFlag(options.agentDir);
	const restoreCommand = `omp gc --restore ${shellQuote(path.basename(archiveFile, ".jsonl.gz"))} --apply${recovery}`;
	const reclaimedTranscript = reclaimedTranscriptPath(archiveFile);
	const reclaimedTree = reclaimedArtifactsPath(archiveFile);
	if (sessionPath) result.sessionPath = sessionPath;
	const liveEntry = sessionPath ? await lstatIfPresent(sessionPath) : undefined;
	if (liveEntry && !liveEntry.isFile()) {
		if (liveEntry.isSymbolicLink())
			throw new Error(
				transcriptLinkRefusal(sessionPath!, await fs.readlink(sessionPath!), options.apply ? "was" : "would be"),
			);
		throw new NotARegularFile(sessionPath!, kindOf(liveEntry));
	}
	if (!sessionPath || !liveEntry) {
		// The transcript being gone is not the same as the space being given
		// back: removing a transcript by hand leaves its whole artifact tree,
		// which is usually the larger half, and saying the space is back
		// sends the reader away from the directory still holding it.
		const strandedTree = sessionPath ? await lstatIfPresent(sessionPath.slice(0, -".jsonl".length)) : undefined;
		if (sessionPath && strandedTree) result.keptArtifactTree = sessionPath.slice(0, -".jsonl".length);
		const reclaimed = (await lstatIfPresent(reclaimedTranscript)) !== undefined;
		result.errors.push(
			`${archiveFile} has no live transcript to reclaim${sessionPath ? ` at ${sessionPath}` : ""}; ` +
				(strandedTree
					? `its live artifact tree is still there${strandedTree.isSymbolicLink() ? " as a symbolic link" : ""} and this command does not remove it on its own. ` +
						`Bring the session home with \`${restoreCommand}\` and reclaim it, or remove the tree yourself`
					: reclaimed
						? `it is already reclaimed: its transcript is at ${reclaimedTranscript}, and \`${restoreCommand}\` ` +
							`brings it home`
						: "the space is already given back"),
		);
		return result;
	}
	result.sessionPath = sessionPath;
	const liveArtifacts = sessionPath.slice(0, -".jsonl".length);
	const artifactEntry = await lstatIfPresent(liveArtifacts);
	if (artifactEntry?.isSymbolicLink())
		throw new Error(`${liveArtifacts} is a symbolic link, not a live artifact directory; nothing was moved`);
	const archiveArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const notACopy = (): string =>
		`${archiveFile} is not a copy of ${sessionPath} as it stands; archive it again with ` +
		`\`omp gc --archive --apply${recovery}\` and reclaim after that`;
	// Why the archive is not a copy of the live transcript as it stands, or
	// undefined when it is; a comparison that cannot read says so, with its
	// error, never that the two differ.
	const notHeldLive = async (): Promise<string | undefined> => {
		try {
			return (await archiveAlreadyHolds(sessionPath, archiveFile)) ? undefined : notACopy();
		} catch (error) {
			return (
				`whether ${archiveFile} is a copy of ${sessionPath} could not be checked (${errorMessage(error)}); ` +
				`nothing was moved`
			);
		}
	};
	// A refusal names the live tree it left behind, on every path that can
	// reach one. Reporting it only sometimes is how a reader learns to stop
	// trusting it.
	const keepTree = async (): Promise<void> => {
		try {
			if (await lstatIfPresent(liveArtifacts)) result.keptArtifactTree = liveArtifacts;
		} catch (error) {
			result.errors.push(`${liveArtifacts} could not be checked (${errorMessage(error)})`);
		}
	};
	// Where the moves go, checked before anything moves, by preview and apply
	// alike: the session's own directory under `archive/reclaimed` absent or
	// empty — an original already there is a session a restore has not
	// brought home — every condition `rename(2)` names for both moves (see
	// `renameRefusal`, `regular-file.ts`), and the reclaimed tree on the
	// sessions tree's filesystem. A preview has only the device numbers to go
	// by; applying has the kernel's own answer, which refuses a bind mount of
	// one filesystem too.
	const container = reclaimedContainerPath(archiveFile);
	const destinationRefusal = async (): Promise<string | undefined> => {
		const standing = await lstatIfPresent(container);
		if (standing && !standing.isDirectory())
			return `${container} is already there as ${kindOf(standing)}, not a reclaim directory; nothing was moved`;
		if (standing && (!standing.isDirectory() || (await fs.readdir(container)).length > 0)) {
			return (
				`${container} is already there — this session's own entries from an earlier reclaim, or something ` +
				`else — and a reclaim never moves an original over anything; bring the session home with ` +
				`\`${restoreCommand}\` (moving ${sessionPath} aside first), or look at it, and reclaim after that`
			);
		}
		let near = container;
		let nearStat = standing;
		while (!nearStat && path.dirname(near) !== near) {
			near = path.dirname(near);
			nearStat = await statIfPresent(near);
		}
		const here = await fs.stat(path.dirname(sessionPath));
		if (nearStat && nearStat.dev !== here.dev) return crossFilesystemRefusal(sessionPath, reclaimedTranscript);
		for (const entry of [sessionPath, ...((await pathExists(liveArtifacts)) ? [liveArtifacts] : [])]) {
			const refused = await renameRefusal(entry, container);
			if (refused) return `${refused}; nothing was moved`;
		}
		return undefined;
	};
	// What applying would find when it asks the kernel to prove `file` unheld
	// — see {@link leaseLiveFiles} — asked of the live name and let go at
	// once. Undefined when the lease was granted.
	const leaseWouldRefuse = async (file: string): Promise<string | undefined> => {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await openRegularFile(file);
			if (!handle) return undefined;
			const lease = takeSoleOpenLease(handle.fd);
			return lease.outcome === "held" ? undefined : leaseRefusal(file, lease, await holdersOf(handle, file));
		} catch (error) {
			return `whether another process holds ${file} open could not be asked (${errorMessage(error)})`;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	};
	// An enumeration that fails says nothing about who owns the session, and
	// reporting it as an owner sends the reader to close a process that does
	// not exist. Both halves are named for what they are.
	const sessionTree = async (session: SessionInfo): Promise<{ files?: string[]; failure?: string }> => {
		try {
			return { files: await collectSessionFiles(session) };
		} catch (error) {
			return { failure: `${sessionPath} and its subagent sessions could not be listed: ${errorMessage(error)}` };
		}
	};
	// What the transcript holds, or why that could not be told: a transcript
	// that cannot be read is not "not a session file", and a review saw the
	// one said for the other.
	const readSession = async (): Promise<{ session?: SessionInfo; why?: string }> => {
		try {
			const session = await readRegularSessionInfo(sessionPath);
			return session ? { session } : { why: `${sessionPath} is not a session file` };
		} catch (error) {
			return { why: `${sessionPath} could not be read to find its session (${errorMessage(error)})` };
		}
	};
	const treeRefusal = (refused: TreeLeaseRefusal): string =>
		treeLeaseRefusalText(refused, "nothing was moved; reclaim again once it is closed or can be read");
	// A session a live process owns is reported and kept, whenever it joined.
	// The transcripts are among the files the walk compared. The leases taken
	// go into `tree`; the reason to keep the session, if any, comes back.
	const leaseProvedTranscripts = async (
		tree: SessionTreeLeases,
		proved: { files: ProvenEntry[] },
	): Promise<string | undefined> => {
		const refused = await leaseTranscripts(
			tree,
			proved.files.map(entry => entry.path),
		);
		if (refused === undefined) return undefined;
		await keepTree();
		return `${treeRefusal(refused)} (found after this run took its leases)`;
	};
	if (!options.apply) {
		// A preview that reports nothing is a preview nobody can act on, and
		// its exit status is how a script learns the difference. Everything
		// applying would refuse for is checked here too, short of taking the
		// leases: the owner is probed and released, and the tree is proved.
		const { session, why } = await readSession();
		const listed = session ? await sessionTree(session) : undefined;
		const probe = session && listed?.files ? await tryAcquireSessionTreeLeases(session, listed.files) : undefined;
		if (probe && !("file" in probe)) for (const held of probe.leases) held.release();
		if (!session) {
			result.errors.push(why ?? `${sessionPath} is not a session file`);
			await keepTree();
		} else if (listed?.failure) {
			result.errors.push(listed.failure);
			await keepTree();
		} else if (probe && "file" in probe) {
			result.errors.push(treeRefusal(probe));
			await keepTree();
		}
		const transcriptStat = await fs.lstat(sessionPath);
		const live = new Set([identityKey(transcriptStat)]);
		const transcriptCopy = await archivedFileRefusal(sessionPath, archiveFile, live);
		if (transcriptCopy) {
			await keepTree();
			result.errors.push(transcriptCopy);
		}
		const notHeld = await notHeldLive();
		if (notHeld) {
			await keepTree();
			result.errors.push(notHeld);
			return result;
		}
		const transcriptTarget = (await lookAt(sessionPath))?.target;
		if (transcriptTarget !== undefined) {
			await keepTree();
			result.errors.push(transcriptLinkRefusal(sessionPath, transcriptTarget, "would be"));
		}
		const destination = await destinationRefusal();
		if (destination) {
			await keepTree();
			result.errors.push(destination);
		}
		const files = [sessionPath];
		// Copies applying would have to keep, said as applying says them: the
		// reclaim still goes ahead, and the space is not all given back.
		const copyNotes: string[] = [];
		if (await pathExists(liveArtifacts)) {
			const preview: ProvenTree = { files: [], directories: [], live };
			try {
				const residue = await stagingResidueUnder(options.agentDir, liveArtifacts);
				await proveLiveTreeIsArchived(liveArtifacts, archiveArtifacts, liveArtifacts, preview, residue);
				const alias = await archivedAliasesRefusal(preview);
				if (alias) throw new Error(alias);
				files.push(...preview.files.map(entry => entry.path));
				for (const entry of [...preview.files, ...preview.directories]) {
					const directory = path.dirname(entry.destination);
					try {
						await fs.access(directory, fsConstants.W_OK | fsConstants.X_OK);
					} catch (error) {
						const code = codeOf(error);
						copyNotes.push(
							code === "EACCES" || code === "EPERM" || code === "EROFS"
								? `an archived copy would be kept: ${entry.destination} cannot be freed, since ${directory} is not writable here (${errorMessage(error)})`
								: `whether ${directory} can be written to free ${entry.destination} could not be checked (${errorMessage(error)})`,
						);
					}
				}
				const probed: SessionTreeLeases = { leases: [], leasedIds: new Set(), transcripts: new Set() };
				const kept = await leaseProvedTranscripts(probed, preview);
				for (const held of probed.leases) held.release();
				if (kept) result.errors.push(kept);
			} catch (error) {
				await keepTree();
				result.errors.push(`${liveArtifacts} would be kept: ${errorMessage(error)}`);
			} finally {
				await releaseProvenTree(preview);
			}
		}
		// Asked of the live names, as applying asks before it moves them: a
		// process holding one of them open now keeps the session then. The
		// kernel's lease is the proof; the process list is read only to name a
		// holder once the kernel has refused.
		for (const file of files) {
			const refused = await leaseWouldRefuse(file);
			if (refused === undefined) continue;
			await keepTree();
			result.errors.push(`${refused}; the live copy would be kept`);
			break;
		}
		// A preview that found nothing to refuse has to say what applying
		// would do. Reporting it the way a refusal reports itself — "would
		// give up nothing" — tells the reader the opposite of what is about
		// to happen.
		if (result.errors.length === 0) result.wouldReclaim = 1;
		result.errors.push(...copyNotes);
		return result;
	}
	// Leases first, and the whole tree's, the way the archive phase takes
	// them. Proving before taking them proves nothing: the owner can write
	// between the proof and the lease, and the move then runs against a
	// reading that is already stale. And a parent's lease says nothing about
	// the subagent sessions below it, whose files this moves too.
	const { session, why } = await readSession();
	if (!session) {
		await keepTree();
		result.errors.push(why ?? `${sessionPath} is not a session file`);
		return result;
	}
	const listed = await sessionTree(session);
	if (listed.failure) {
		await keepTree();
		result.errors.push(listed.failure);
		return result;
	}
	const leasedTree = await tryAcquireSessionTreeLeases(session, listed.files ?? []);
	if ("file" in leasedTree) {
		await keepTree();
		result.errors.push(treeRefusal(leasedTree));
		return result;
	}
	const tree = leasedTree;
	// Every directory the proof below holds, closed once the run is done —
	// never before, so no other directory can take an inode number this run
	// still decides by — and every file leased before the moves.
	const proven: ProvenTree = { files: [], directories: [], live: new Set() };
	const leased: LeasedFile[] = [];
	let containerHeld: HeldFile | undefined;
	let containerMade = false;
	let originalsInContainer = false;
	try {
		// Proved under the leases, so what was read is what no writer holding
		// one can change while this runs.
		const transcriptStat = await fs.lstat(sessionPath);
		proven.live.add(identityKey(transcriptStat));
		const transcriptCopy = await archivedFileRefusal(sessionPath, archiveFile, proven.live);
		if (transcriptCopy) {
			await keepTree();
			result.errors.push(transcriptCopy);
			return result;
		}
		const notHeld = await notHeldLive();
		if (notHeld) {
			await keepTree();
			result.errors.push(notHeld);
			return result;
		}
		// The root is taken as the entry proved here and checked again as it
		// moves, the way the entries are: a name rebound while this ran is
		// somebody else's transcript.
		const root = await lookAt(sessionPath);
		if (!root) {
			await keepTree();
			result.errors.push(`${sessionPath} is no longer there to reclaim`);
			return result;
		}
		// A transcript that is a symbolic link is kept, like any link in the
		// tree: the file it leads to is outside this session's tree and its
		// leases, and moving the link would leave that file where the session
		// no longer looks.
		if (root.target !== undefined) {
			await keepTree();
			result.errors.push(transcriptLinkRefusal(sessionPath, root.target, "was"));
			return result;
		}
		const destination = await destinationRefusal();
		if (destination) {
			await keepTree();
			result.errors.push(`${sessionPath} was kept: ${destination}`);
			return result;
		}
		// Every entry settled before anything moves.
		const treeLive = await pathExists(liveArtifacts);
		if (treeLive) {
			try {
				const residue = await stagingResidueUnder(options.agentDir, liveArtifacts);
				await proveLiveTreeIsArchived(liveArtifacts, archiveArtifacts, liveArtifacts, proven, residue);
				const alias = await archivedAliasesRefusal(proven);
				if (alias) throw new Error(alias);
			} catch (error) {
				await keepTree();
				result.errors.push(`${liveArtifacts} was kept: ${errorMessage(error)}`);
				return result;
			}
		}
		// The walk can reach a subagent session that joined after the leases
		// above were taken; it holds a lease of its own and can take its
		// next turn after any proof of its file. Its lease is taken here, or
		// nothing moves: a live owner's session is not this command's, and a
		// dead one writes nothing late. Each lease is held to the end of the
		// run, so nothing claims the session while it moves.
		const kept = await leaseProvedTranscripts(tree, proven);
		if (kept) {
			result.errors.push(kept);
			return result;
		}
		const refused =
			(await leaseLiveFiles(
				[{ path: sessionPath, proved: root }, ...proven.files.map(entry => ({ path: entry.path, proved: entry }))],
				leased,
			)) ?? (await treeChangedSinceProof(leased, proven.directories));
		if (refused) {
			await keepTree();
			result.errors.push(`${sessionPath} was kept: ${refused}`);
			return result;
		}
		// The session's own directory under `archive/reclaimed`, made by this
		// run — or found empty, which a reclaim killed before its first move
		// leaves — and held open from here, so no other directory put at its
		// name is taken for it. Only one this run made is removed in the end,
		// and only while it is that one and empty: an empty directory found
		// there, whoever made it, has its own owner, mode and attributes, and a
		// review planted one with an attribute and saw it go.
		let containerFailure: string | undefined;
		try {
			await fs.mkdir(path.dirname(container), { recursive: true, mode: 0o700 });
			const standing = await lstatIfPresent(container);
			if (standing?.isDirectory()) {
				containerHeld = await holdSeenDirectory(container, standing);
			} else {
				containerHeld = await makeHeldDirectory(container, 0o700);
				containerMade = true;
			}
			if (!containerHeld) containerFailure = `${container} changed while this run looked at it`;
		} catch (error) {
			containerFailure = `${container} could not be made (${errorMessage(error)})`;
		}
		if (containerFailure) {
			await keepTree();
			result.errors.push(`${sessionPath} was kept: ${containerFailure}; nothing was moved`);
			return result;
		}
		// The transcript first: a session whose transcript is at its
		// reclaimed name is one the archive holds, which opening it or a
		// restore brings home, whatever of its tree is still live.
		const notMoved = await moveOriginal(sessionPath, reclaimedTranscript);
		if (notMoved) {
			await keepTree();
			result.errors.push(`${sessionPath} was kept: ${notMoved}`);
			return result;
		}
		originalsInContainer = true;
		const moves: ReclaimMove[] = [{ from: sessionPath, to: reclaimedTranscript }];
		let stopped: string | undefined;
		if (treeLive) {
			stopped = await moveOriginal(liveArtifacts, reclaimedTree);
			if (stopped === undefined) moves.push({ from: liveArtifacts, to: reclaimedTree });
		}
		try {
			stopped ??= brokenLease(leased);
			// What moved is what was proved: the transcript's own inode, and the
			// tree's root directory held open since its proof — not something
			// put at a live name between the last look and the rename.
			const movedTranscript = stopped === undefined ? await lstatIfPresent(reclaimedTranscript) : undefined;
			if (stopped === undefined && (movedTranscript?.dev !== root.dev || movedTranscript.ino !== root.ino)) {
				stopped = `${reclaimedTranscript} is not the transcript ${sessionPath} this run proved`;
			}
			const treeRoot = proven.directories.at(-1);
			if (stopped === undefined && treeLive && treeRoot) {
				const movedTree = await lstatIfPresent(reclaimedTree);
				if (movedTree?.dev !== treeRoot.held.dev || movedTree.ino !== treeRoot.held.ino) {
					stopped = `${reclaimedTree} is not the directory ${liveArtifacts} this run proved`;
				}
			}
			if (stopped === undefined && treeLive) {
				const unseen = await unprovedEntry(reclaimedTree, proven);
				if (unseen !== undefined) {
					stopped =
						`${path.join(liveArtifacts, path.relative(reclaimedTree, unseen))} was put into the session's tree ` +
						`after this run proved it, so whoever put it there is using the session; reclaim again once it is done`;
				}
			}
			for (const name of stopped === undefined ? [sessionPath, liveArtifacts] : []) {
				if (await lstatIfPresent(name)) {
					stopped = `${name} was written to after this run moved the session's own entry from there into the archive`;
					break;
				}
			}
		} catch (error) {
			stopped = `the moved session could not be checked (${errorMessage(error)})`;
		}
		if (stopped !== undefined) {
			const back = await moveBack(moves, restoreCommand);
			originalsInContainer = back.left.length > 0;
			if (back.left.length === 0) {
				await keepTree();
				result.errors.push(`${sessionPath} was kept: ${stopped}; what had moved was moved back`);
			} else {
				result.moved = {};
				for (const move of back.left) {
					if (move.to === reclaimedTranscript) result.moved.transcript = move.to;
					else result.moved.artifacts = move.to;
				}
				await keepTree();
				result.errors.push(`${sessionPath} was not reclaimed: ${stopped}; ${back.notes.join("; ")}`);
			}
			return result;
		}
		result.reclaimed = 1;
		result.moved = { transcript: reclaimedTranscript, ...(treeLive ? { artifacts: reclaimedTree } : {}) };
		// The originals are in the archive. Their leases stay until the copies
		// are freed: a copy goes only while its original's lease shows nothing
		// opened or truncated the original since the proof — see
		// {@link freeArchivedCopies}. The `finally` below lets go of them.
		if (treeLive) {
			const freed = await freeArchivedCopies(proven, liveArtifacts, reclaimedTree, leased);
			result.freedCopies = freed.freed;
			if (freed.kept.length > 0) {
				result.keptCopies = freed.kept;
				// Said as errors, as the archive phase says what it left: space
				// not given back is worth a look, though the original is not
				// touched by keeping a copy.
				result.errors.push(...freed.kept.map(note => `an archived copy was kept: ${note}`));
			}
			if (freed.lost.length > 0) {
				result.lostCopies = freed.lost;
				result.errors.push(
					...freed.lost.map(note => `an archived copy could not be written back whole after it went: ${note}`),
				);
			}
		}
	} catch (error) {
		await keepTree();
		result.errors.push(errorMessage(error));
	} finally {
		for (const file of leased) await file.handle.close().catch(() => undefined);
		await releaseProvenTree(proven);
		if (containerHeld) {
			// Only the one this run made, and only empty: when nothing stayed moved.
			if (containerMade && !originalsInContainer) {
				try {
					await removeHeldDirectory(container, containerHeld);
				} catch (error) {
					result.errors.push(
						`${container} could not be removed (${errorMessage(error)}), so it was left as it is`,
					);
				}
			}
			await containerHeld.handle.close().catch(() => undefined);
		}
		for (const held of tree.leases) held.release();
	}
	return result;
}

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args.flags);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	if (options.restoreTarget !== undefined && options.reclaimTarget !== undefined) {
		throw new Error("--restore and --reclaim are opposites; run one of them");
	}
	for (const [flag, target] of [
		["restore", options.restoreTarget],
		["reclaim", options.reclaimTarget],
	] as const) {
		// Saying nothing about phases it dropped is how a command reports
		// success for work it never did.
		if (target !== undefined && options.explicitPhases.length > 0) {
			throw new Error(`--${flag} runs alone; drop ${options.explicitPhases.map(name => `--${name}`).join(" ")}`);
		}
	}
	// A preview writes nothing, the lock included: it reads the lock instead
	// of taking it — see {@link withoutGcLock}.
	const run = async (lockPath: string): Promise<GcResult> => {
		const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath };
		// A restore runs alone: no sweep may race a session coming back.
		if (options.restoreTarget !== undefined) {
			next.restore = await runRestoreGc(options, options.restoreTarget);
			return next;
		}
		// Reclaiming runs alone too: it is the one phase that moves a live
		// session out of the sessions tree, and no sweep may race it.
		if (options.reclaimTarget !== undefined) {
			next.reclaim = await runReclaimGc(options, options.reclaimTarget);
			return next;
		}
		// Pruned collab replicas release their blobs to this run's sweep.
		if (options.runStale) next.stale = await runStaleGc(options);
		if (options.runBlobs) next.blobs = await runBlobGc(options, archiveRoot);
		if (options.runArchive) next.archive = await runArchiveGc(options, archiveRoot);
		if (options.runCompress) next.compress = await runCompressGc(options, archiveRoot);
		if (options.runWal) next.wal = await runWalGc(options);
		return next;
	};
	const lockNotReleased: string[] = [];
	const result = options.apply
		? await withGcLock(options.agentDir, run, { onReleaseFailure: note => lockNotReleased.push(note) })
		: await withoutGcLock(options.agentDir, run);
	if (lockNotReleased.length > 0) result.lockNotReleased = lockNotReleased;

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
	process.stdout.write(output);
	return result;
}
