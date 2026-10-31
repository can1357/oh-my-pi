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
import {
	listSessionsReadOnly,
	readSessionInfo,
	type SessionInfo,
	type SessionStatus,
} from "../session/session-listing";
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
	openRegularFile,
	liveSessionPathForArchive,
	restoreArchivedSessionLocked,
	artifactRestoreConflicts,
	moveAsidePermission,
	restoreRecordLeftNote,
	restoreRecordRefusal,
	stagingResidueNote,
	stagingResidueUnder,
	type StagingGround,
} from "../session/session-archive";
import { codeOf, statIfPresent, withGcLock } from "../session/gc-lock";
import { readSessionHeaderId } from "../session/session-loader";
import { FileSessionStorage, tryAcquireSessionLease } from "../session/session-storage";
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
const JSONL_GZ_GLOB = new Bun.Glob("**/*.jsonl.gz");
const JSONL_BACKUP_GLOB = new Bun.Glob("**/*.jsonl.*.bak");
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
	 * The operator accepts that reclaiming is forward-only: the live copy goes
	 * and an omp without `gc --restore` cannot find or read what is left.
	 * Required by `--reclaim --apply`.
	 */
	forwardOnly?: boolean;
	/** Session id prefix or archive path to bring back out of the archive. */
	restore?: string;
	/** Session id prefix or archive path whose live copy should be given up. */
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
	scanned: number;
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
	/** Links inside an artifact tree whose target was already gone, so the archive could not hold their bytes. */
	brokenLinks: number;
	errors: string[];
}

/** What `--reclaim` gave back, on the one session it was asked about. */
export interface ReclaimGcResult {
	/** What the caller asked for: a session id prefix or an archive path. */
	query: string;
	archivePath?: string;
	/**
	 * Live paths a refused run had already removed before it stopped. Empty on
	 * every ordinary refusal, because nothing goes until the whole tree is
	 * proved; non-empty only when the removal itself failed part-way, and then
	 * the archive holds all of it.
	 */
	partiallyRemoved?: string[];
	sessionPath?: string;
	/** 1 when the live copy went, 0 when it was kept and the reason is in `errors`. */
	reclaimed: number;
	/** 1 when a preview found nothing to refuse, so applying would give the live copy up. */
	wouldReclaim?: number;
	/** The live artifact tree a refused reclaim left in place, with the reason in `errors`. */
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
	scanned: number;
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
	/** Set by `--forward-only`: `--reclaim --apply` may give up a live copy. */
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
	const needsSettings = !selected || needsArchiveSettings || needsStaleSettings || needsCompressSettings;
	// Read-only first, always. `Settings.loadIsolated` migrates a legacy agent
	// directory on the way in — it renames `settings.json` to
	// `settings.json.bak` and writes `config.yml` — and a run this gate refuses
	// must leave the agent directory exactly as it found it.
	const configured = needsSettings ? await Settings.loadReadOnly({ agentDir }) : undefined;
	const runArchive = selected
		? flags.archive === true
		: configured
			? cfgGcArchive.get(configured)
			: cfgGcArchive.default;
	// Archiving copies and keeps both sides, so by itself it hides nothing from
	// any reader. Giving the live copy up is the step an omp without
	// `gc --restore` cannot follow: such a release searches `*.jsonl` under the
	// sessions tree and reads a transcript as plain text, so what is left in
	// `archive/sessions` is invisible to it whether or not it is compressed.
	// Pin a machine back to one of those after reclaiming and its own sessions
	// stop resuming until someone inflates them by hand. Refusing here, before
	// the gc lock and before settings are migrated, leaves the agent directory
	// exactly as it was found.
	if (flags.reclaim !== undefined && flags.apply === true && flags.forwardOnly !== true) {
		const archiveRoot = getArchivedSessionsDir(agentDir);
		throw new Error(
			`--reclaim --apply gives up the live copy, leaving the session only in ${archiveRoot}, where only an omp with \`gc --restore\` can find it; ` +
				`a release pinned back from this one cannot resume it, and inflating one by hand is \`gunzip -c "<file>.jsonl.gz" > "<sessions>/<bucket>/<file>.jsonl"\` plus its artifact directory. ` +
				`Pass --forward-only to accept that. \`omp gc --archive --apply${agentDirFlag(agentDir)}\` copies without giving anything up and needs no such flag.`,
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
	];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

/** Small registry/breadcrumb marker files; a missing file reads as empty. */
async function readTextIfPresent(file: string): Promise<string> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return "";
		throw error;
	}
}

async function scanSessionLinesIfPresent(file: string, onLine: (line: Uint8Array) => void): Promise<void> {
	// readLines buffers at most the largest record, including malformed records.
	const scan = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const line of readLines(stream)) onLine(line);
	};
	try {
		const stream = Bun.file(file).stream();
		if (file.endsWith(COMPRESSED_SESSION_SUFFIX)) {
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

async function collectCompressedJsonlFiles(root: string): Promise<string[]> {
	return scanSessionTree(JSONL_GZ_GLOB, root);
}

async function collectBackupJsonlFiles(root: string): Promise<string[]> {
	return scanSessionTree(JSONL_BACKUP_GLOB, root);
}

async function collectReferencedBlobHashes(sessionRoots: string[], exactSessionFiles: string[]): Promise<Set<string>> {
	const files = new Map<string, string>();
	const decoder = new TextDecoder();
	for (const root of sessionRoots) {
		for (const file of [
			...(await collectJsonlFiles(root)),
			...(await collectCompressedJsonlFiles(root)),
			...(await collectBackupJsonlFiles(root)),
		]) {
			files.set(normalizePathForComparison(file), file);
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
		if (!(await statIfPresent(canonical))) {
			result.errors.push(`${canonical}: failed to restore reused blob: ${errorMessage(error)}`);
			return;
		}
	}
	try {
		await fs.unlink(moved);
	} catch {
		// The rewritten canonical blob stands; a leftover staging copy ages out.
	}
}

async function runBlobGc(options: ResolvedGcOptions, archiveSessionsRoot: string): Promise<BlobGcResult> {
	const blobDir = getBlobsDir(options.agentDir);
	const sessionsRoot = getSessionsDir(options.agentDir);
	const defaultRoots = [sessionsRoot, archiveSessionsRoot];
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

/** Whether a pointer's target is verifiably gone; unreadable targets count as present. */
async function sessionFileMissing(sessionFile: string): Promise<boolean> {
	try {
		return !(await fs.stat(sessionFile)).isFile();
	} catch (error) {
		const code = codeOf(error);
		return code === "ENOENT" || code === "ENOTDIR";
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

/**
 * Take the ownership lease of the session in `sessionFile`, or null while a
 * running process holds it (or the lease cannot be probed: an unknown owner is
 * treated as live). The lease is keyed by the header's session id. Undefined
 * when the file has no session header: omp writes the header with the first
 * bytes of a session, so no running writer owns such a file (and candidates
 * are past the write grace, so none is mid-write).
 */
async function tryAcquireSessionFileLease(sessionFile: string): Promise<FileLockHandle | null | undefined> {
	try {
		const sessionId = await readSessionHeaderId(sessionFile);
		return sessionId === undefined ? undefined : tryAcquireSessionLease(sessionId);
	} catch {
		return null;
	}
}

async function listActiveSessions(sessionsRoot: string): Promise<SessionInfo[]> {
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}

	const storage = new FileSessionStorage();
	const sessions: SessionInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		sessions.push(...(await listSessionsReadOnly(path.join(sessionsRoot, entry.name), storage)));
	}
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

async function listNestedSessionsReadOnly(artifactsRoot: string): Promise<SessionInfo[]> {
	const files = await collectJsonlFiles(artifactsRoot);
	const dirs = [...new Set(files.map(file => path.dirname(file)))].sort();
	const storage = new FileSessionStorage();
	const sessions: SessionInfo[] = [];
	for (const dir of dirs) sessions.push(...(await listSessionsReadOnly(dir, storage)));
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
	await pipeline(Bun.file(file).stream(), createGunzip(), async (source: NodeJS.ReadableStream) => {
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
 * Take back a name this run linked onto its stage, when that is all taking
 * it back removes. Returns what was left and why, for the command to print.
 *
 * The name goes only while it and the stage still name one inode: then the
 * stage keeps that inode's bytes — this run's, or a file somebody bound to
 * the stage before the link, which the ground's cleanup then reports and
 * leaves. A name holding anything else was put there after the link by
 * somebody else, and removing it would delete their file; it is left and
 * named. This runs on the way out of a failure, so it reports rather than
 * throws.
 */
async function withdrawLinkedPublication(destination: string, stage: string): Promise<string | undefined> {
	let named: Stats;
	try {
		named = await fs.lstat(destination);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		return `${destination} could not be looked at, so it was left as it is: ${errorMessage(error)}`;
	}
	const staged = await fs.lstat(stage).catch(() => undefined);
	if (staged?.dev !== named.dev || staged.ino !== named.ino) {
		return `${destination} is not what this run published there, so it was left alone`;
	}
	try {
		await fs.unlink(destination);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") return `${destination} could not be taken back: ${errorMessage(error)}`;
	}
	return undefined;
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
	if (!live) throw new Error(`${source} is not a regular file, so it was not archived`);
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
	try {
		await ground.handle.chmod((await live.stat()).mode & 0o7777);
		const expected = await digestStream(bytesOfHandle(live));
		await pipeline(bytesOfHandle(live), createGzip({ level: 9 }), ground.handle.createWriteStream());
		const stagedNow = await fs.lstat(ground.file).catch(() => undefined);
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
			// through the very descriptor this check opened. An inode
			// comparison cannot see a replacement written in place, and the
			// earlier proof was taken before the stage existed, so it is an
			// observation about bytes that may since have changed. What
			// survives is the gap between this read and the rename.
			const archived = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
				if (codeOf(error) === "ENOENT") return undefined;
				throw error;
			});
			const changed = `${destination} changed while it was being archived; run \`omp gc --archive\` again`;
			if (!archived) throw new Error(changed);
			try {
				if (!(await archivedHandleIsPrefixOfLive(archived, source))) throw new Error(changed);
				const standing = await archived.stat();
				const named = await statIfPresent(destination);
				if (!named || named.dev !== standing.dev || named.ino !== standing.ino) throw new Error(changed);
				if (standing.dev !== supersedes.dev || standing.ino !== supersedes.ino) throw new Error(changed);
			} finally {
				await archived.close();
			}
			await fs.rename(ground.file, destination);
		} else {
			// `link`, not `rename`: the caller has established that nothing of
			// this session's is at the destination, so anything there now is
			// someone else's, and `EEXIST` says so rather than writing over it.
			await fs.link(ground.file, destination);
			linked = true;
		}
		if (!(await publishedIsStaged(destination, ground.created, inflatesTo(expected)))) {
			throw new Error(
				`${destination} is not the archive this run wrote for ${source}, so ${source} was not archived; ` +
					`run \`omp gc --archive\` again`,
			);
		}
		// The mode once more, from the descriptor the bytes were read through,
		// now that the archived name has been opened and checked, and set
		// through a descriptor proved to hold the very inode just published —
		// never through a name, which could by now be somebody else's file.
		const published = await openRegularFile(destination);
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
		if (linked) {
			const note = await withdrawLinkedPublication(destination, ground.file);
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

/** One entry this copy created, as the entry it created — not merely the name it used. */
interface ArchiveCreation {
	path: string;
	dev: number;
	ino: number;
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
 */
async function survivesSourceRemoval(destination: string, sourceRoot: string): Promise<boolean> {
	const entry = await fs.lstat(destination).catch(() => undefined);
	if (!entry?.isFile()) return false;
	const [real, root] = await Promise.all([
		fs.realpath(destination).catch(() => undefined),
		fs.realpath(sourceRoot).catch(() => sourceRoot),
	]);
	if (real === undefined) return false;
	const relative = path.relative(root, real);
	return relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative));
}

/** Remember an entry this copy made, by the entry and not by its name. */
async function noteCreation(target: string, state: ArchiveCopyState): Promise<void> {
	const made = await statIfPresent(target);
	if (made) state.created.push({ path: target, dev: made.dev, ino: made.ino });
}

/**
 * Put back at `destination` the bytes an open descriptor still holds.
 *
 * A `rename` replaces, so a superseding publication that turns out not to
 * have published what this run copied has already taken the shorter
 * archived copy off its name. That copy is not gone: this run has held it
 * open throughout, and an unlinked inode is still readable through a
 * descriptor. It goes back the way everything else is written here — a
 * stage of this run's own, digested as it is copied, published, and read
 * back by {@link publishedIsStaged}. A put-back that does not read back is
 * reported as that; what stands at the name then is left as it is.
 */
async function putArchivedCopyBack(
	archived: fs.FileHandle,
	destination: string,
	mode: number,
	ledger: string,
	notes: string[],
): Promise<void> {
	const ground = await mintStagingGround(destination, ledger, mode & 0o7777);
	try {
		const written = await copyHandleWithDigest(archived, ground.handle);
		await ground.handle.chmod(mode & 0o7777);
		await fs.rename(ground.file, destination);
		if (!(await publishedIsStaged(destination, ground.created, holdsCopied(written)))) {
			throw new Error(
				`${destination} could not be put back: what stands at that name is not the copy this run wrote back, ` +
					`so it was left as it is`,
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
	try {
		live = await fs.open(source, "r");
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
		// The proof was about a descriptor; the publication is about a name,
		// and `link` and `rename` take whatever the name points at when they
		// run. So what the publication left at the name is read back — see
		// {@link publishedIsStaged} for each step and what it rules out.
		//
		// The limit, stated rather than engineered past: a process that can
		// write the destination's directory can rebind the name after the
		// last look, and no check run here sees that. An ordinary writer
		// rewriting the live source is a different thing and is handled —
		// what was copied is what is published.
		const stagedIsStillOurs = async (): Promise<boolean> => {
			const standing = await fs.lstat(tempPath).catch(() => undefined);
			return standing?.dev === held.dev && standing.ino === held.ino;
		};
		const rebound = (): Error =>
			new Error(
				`${tempPath} is no longer the file this run staged there, so it was left alone and ${source} was ` +
					`not archived; run \`omp gc --archive\` again`,
			);
		const notPublished = (): Error =>
			new Error(
				`${destination} is not the copy of ${source} this run wrote, so ${source} was not archived; ` +
					`run \`omp gc --archive\` again`,
			);
		const archived = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
			if (codeOf(error) === "ENOENT") return undefined;
			// A readerless FIFO at the archived name: something is there, and
			// only absence may be read as an empty slot.
			if (codeOf(error) === "ENXIO") throw conflict();
			throw error;
		});
		if (!archived) {
			if (!(await stagedIsStillOurs())) throw rebound();
			await fs.link(tempPath, destination);
			if (!(await publishedIsStaged(destination, held, holdsCopied(copied)))) {
				const note = await withdrawLinkedPublication(destination, tempPath);
				if (note) state.notes.push(note);
				throw notPublished();
			}
			await ground.handle.chmod(await liveMode());
			state.created.push({ path: destination, dev: held.dev, ino: held.ino });
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
			if (!verified.isFile() || !(await survivesSourceRemoval(destination, sourceRoot))) throw conflict();
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
			const standing = await statIfPresent(destination);
			if (!standing || standing.dev !== verified.dev || standing.ino !== verified.ino) {
				throw new Error(`${destination} changed while it was being archived; run \`omp gc --archive\` again`);
			}
			if (!(await stagedIsStillOurs())) throw rebound();
			await fs.rename(tempPath, destination);
			if (!(await publishedIsStaged(destination, held, holdsCopied(copied)))) {
				// A rename replaces, so the shorter archived copy is already
				// gone from that name — and it is still here, in the
				// descriptor this run has held open throughout. It goes back
				// over what this run put there and over nothing else: a file
				// somebody has put at the name since is theirs.
				const now = await fs.lstat(destination).catch(() => undefined);
				if (now && (now.dev !== held.dev || now.ino !== held.ino)) {
					throw new Error(
						`${notPublished().message}; the shorter copy the archive held at ${destination} was not put back, ` +
							`because that name now holds something this run did not put there. ${source}, which began ` +
							`with those bytes when this run copied it, is kept`,
					);
				}
				try {
					await putArchivedCopyBack(archived, destination, verified.mode, state.ledger, state.notes);
				} catch (error) {
					throw new Error(`${notPublished().message}; ${errorMessage(error)}`);
				}
				throw notPublished();
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
			await ground.handle.close().catch(() => undefined);
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
		if ((await fs.lstat(source).catch(() => undefined))?.isSymbolicLink()) state.brokenLinks += 1;
		return;
	}
	if (stat.isDirectory()) {
		if (await isSamePath(source, destination)) {
			throw new Error(`the live artifact tree ${source} is the archived tree ${destination} itself`);
		}
		const standing = await statIfPresent(destination);
		await fs.mkdir(destination, { recursive: true });
		if (!standing) {
			// Recorded before the mode is set: a `chmod` that fails must still
			// leave this directory to the rollback, or a retry finds it standing
			// at whatever the umask gave it and keeps that mode for good.
			await noteCreation(destination, state);
			// A directory deliberately kept private stays private in the archive:
			// `mkdir` applies the umask, which would widen a `0700` tree to
			// `0755`. A directory the archive already holds keeps its own mode —
			// merging into a private one must not widen it to the live tree's.
			await fs.chmod(destination, stat.mode & 0o7777);
		}
		// Sorted, so a run that fails part-way is reproducible from its report.
		for (const entry of (await fs.readdir(source)).sort()) {
			await copyArtifactEntryIntoArchive(path.join(source, entry), path.join(destination, entry), sourceRoot, state);
		}
		return;
	}
	if (!stat.isFile()) return;
	await publishArtifactIntoArchive(source, stat, destination, sourceRoot, state);
}

/**
 * Undo one failed copy into the archive, and nothing more.
 *
 * What goes is what this copy made, and only while the name still holds what
 * it made. A pathname is not ownership in either direction: a file somebody
 * created at a destination the copy refused to replace must not be removed
 * because its name is unfamiliar, and a file somebody put at a name this
 * copy did once create must not be removed because the name is familiar.
 * The entry is identified by `dev`/`ino`, so an entry that was replaced
 * since is left alone. Deepest first, so a directory is empty when its turn
 * comes.
 *
 * A failure to look at an entry, or to remove one, goes into `notes` rather
 * than being read as an absence: "it was not there" and "I could not tell"
 * are different answers. A directory left because something else is in it
 * is not news — that something is not this copy's to remove.
 *
 * Staging directories a failed publication left are not this function's:
 * they go through {@link removeStagingGround}, which knows what it put
 * there. Nothing here deletes by the shape of a name.
 */
async function removeTreeAdditions(created: readonly ArchiveCreation[], notes: string[]): Promise<void> {
	for (const made of [...created].reverse()) {
		let standing: Stats;
		try {
			standing = await fs.lstat(made.path);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") {
				notes.push(`${made.path} could not be looked at, so it was left as it is: ${errorMessage(error)}`);
			}
			continue;
		}
		if (standing.dev !== made.dev || standing.ino !== made.ino) continue;
		try {
			if (standing.isDirectory()) await fs.rmdir(made.path);
			else await fs.unlink(made.path);
		} catch (error) {
			const code = codeOf(error);
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
				notes.push(`${made.path} could not be taken back: ${errorMessage(error)}`);
			}
		}
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

/**
 * One look at what `entry` names, or undefined when nothing does.
 *
 * A link's target is a second read, so it is bracketed: `lstat`,
 * `readlink`, `lstat` again, and the two must describe the same inode with
 * the same change time, or the target may belong to a replacement — inode
 * numbers come back, so the number alone does not say the entry is the one
 * first seen. Throws when the entry changed while it was being looked at.
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
		throw new Error(`${entry} changed while this run was looking at it; it was kept`);
	}
	return { ...seen, target };
}

/**
 * Whether `entry` still names exactly what `proved` describes, taken in one
 * look — see {@link lookAt}. Absence is reported as `undefined`, and an
 * entry that changed while being looked at as `false`.
 */
async function standsAsProved(entry: string, proved: EntryIdentity): Promise<boolean | undefined> {
	let now: EntryIdentity | undefined;
	try {
		now = await lookAt(entry);
	} catch {
		return false;
	}
	return now === undefined ? undefined : sameIdentity(now, proved);
}

/** One live entry a reclaim proved, as the entry rather than as its name. */
interface ProvenEntry extends EntryIdentity {
	path: string;
	destination: string;
	/** A link, device or socket: nothing to compare, only a name to drop. */
	compared: boolean;
}

/**
 * Look once more, as an entry is about to go, at whether it is still the one
 * the walk proved and whether the archive still holds it.
 *
 * The walk's reading is a fact about a moment that has passed by the time
 * the removal reaches this entry. A file is read again through a descriptor
 * opened now; a link or a device has nothing to read, so the name has to
 * still hold the very entry the walk saw — see {@link standsAsProved}.
 *
 * The caller holds the lease of every transcript in the tree, so no process
 * that writes a session through its lease changes the answer after this.
 * One that writes without a lease still can, between this look and the
 * `unlink`, which takes a name because no system call takes an inode.
 */
async function proveEntryStillGoes(entry: ProvenEntry): Promise<void> {
	if (!entry.compared) {
		if ((await standsAsProved(entry.path, entry)) === false) {
			throw new Error(`${entry.path} is no longer the entry this run proved; it was kept`);
		}
		return;
	}
	const live = await fs.open(entry.path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (!live) return;
	try {
		const now = await live.stat();
		if (!now.isFile() || !sameIdentity(identityFrom(now), entry)) {
			throw new Error(`${entry.path} is no longer the file this run proved; it was kept`);
		}
		if (!(await archivedHandleIsHeldBy(live, now, entry.destination))) {
			throw new Error(`${entry.path} holds what ${entry.destination} does not; it was kept`);
		}
	} finally {
		await live.close().catch(() => undefined);
	}
	// The descriptor follows a link; the name has to be the file itself.
	if ((await standsAsProved(entry.path, entry)) === false) {
		throw new Error(`${entry.path} is no longer the file this run proved; it was kept`);
	}
}

/**
 * The same for the session's own transcript, which goes last: the name still
 * holds the entry the reclaim proved under its lease, and what it holds, read
 * through a descriptor opened now, is still exactly what the archive inflates
 * to. A transcript somebody put at the name while the tree was being removed
 * fails one of the two whichever way it got there — moved in beside the
 * original, or created on the inode the original freed.
 */
async function proveTranscriptStillGoes(
	sessionPath: string,
	proved: EntryIdentity,
	archiveFile: string,
): Promise<void> {
	const kept = (): Error => new Error(`${sessionPath} is no longer the transcript this run proved; it was kept`);
	if ((await standsAsProved(sessionPath, proved)) !== true) throw kept();
	const live = await openRegularFile(sessionPath).catch(() => undefined);
	if (!live) throw kept();
	try {
		const [now, archived] = await Promise.all([
			digestStream(bytesOfHandle(live)),
			digestArchivedSessionFile(archiveFile),
		]);
		if (now.hash !== archived.hash || now.bytes !== archived.bytes) {
			throw new Error(`${sessionPath} holds what ${archiveFile} does not; it was kept`);
		}
	} finally {
		await live.close().catch(() => undefined);
	}
	if ((await standsAsProved(sessionPath, proved)) !== true) throw kept();
}

/**
 * Why `live` must not be given up for `archived`, when the archived copy
 * grants a permission the live file does not; undefined otherwise. Reclaim
 * compares against the archive rather than its own earlier look at the live
 * file: restoring a copy more readable than the file it replaced hands the
 * bytes to whoever the live file kept them from.
 */
async function archivedModeWider(live: string, liveStat: Stats, archived: string): Promise<string | undefined> {
	const archivedStat = await fs.stat(archived).catch(() => undefined);
	if (!archivedStat) return undefined;
	const liveMode = liveStat.mode & 0o7777;
	const archivedMode = archivedStat.mode & 0o7777;
	if ((archivedMode & ~liveMode) === 0) return undefined;
	return (
		`${archived} is archived with mode ${archivedMode.toString(8)}, which grants more than the live ${live}'s ` +
		`${liveMode.toString(8)}; archive the session again, which gives the archived copy the live mode, ` +
		`and reclaim after that`
	);
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
		const archivedHandle = await openRegularFile(archived);
		if (!archivedHandle) throw changed();
		try {
			const held = await archivedHandle.stat();
			const named = await fs.lstat(archived).catch(() => undefined);
			if (!named?.isFile() || named.dev !== held.dev || named.ino !== held.ino) throw changed();
			const expected = await digestStream(bytesOfHandle(liveHandle));
			if (!(await inflatesTo(expected)(archivedHandle).catch(() => false))) throw changed();
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
 * Prove the archive holds every file of a live tree, collecting the files in
 * the order they would be removed.
 *
 * Nothing is removed while this runs. Proving entry by entry and deleting as
 * it went meant a tree that refused on its last file had already lost the
 * ones before it, and the refusal then said the tree "was kept" while part
 * of it was gone. The whole tree is settled first; only then does anything
 * go.
 *
 * Throws the reason the first unproved entry could not be proved, with
 * nothing deleted.
 */
async function proveLiveTreeIsArchived(
	source: string,
	destination: string,
	sourceRoot: string,
	proven: { files: ProvenEntry[]; directories: string[] },
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
		for (const entry of (await fs.readdir(source)).sort()) {
			await proveLiveTreeIsArchived(
				path.join(source, entry),
				path.join(destination, entry),
				sourceRoot,
				proven,
				residue,
			);
		}
		// Appended after its children, so the list reads deepest first and a
		// directory is empty by the time the removal reaches it. Prepending
		// put the root in front of its own children, which made every nested
		// tree delete its files and then fail `rmdir` with `ENOTEMPTY`.
		proven.directories.push(source);
		return;
	}
	if (!stat.isFile()) {
		// A FIFO, a socket or a device: the archive holds nothing for it, so
		// giving up the live tree would remove something no copy has.
		if (!stat.isSymbolicLink()) {
			throw new Error(
				`${source} is ${stat.isFIFO() ? "a FIFO" : stat.isSocket() ? "a socket" : "a device"}, which the archive cannot ` +
					`hold, so the live tree was kept; move it out of the tree to give this session's live copy up`,
			);
		}
		// A link the copy resolved rather than carried: its own name is all
		// there is to drop, and there is nothing to compare. What is recorded
		// is one look at it, and it has to be the entry the walk just found —
		// a file put in its place would go uncompared.
		const seen = await lookAt(source);
		if (!seen || !sameIdentity({ ...seen, target: undefined }, identityFrom(stat))) {
			throw new Error(`${source} changed while this run was looking at it; it was kept`);
		}
		proven.files.push({ path: source, destination, ...seen, compared: false });
		return;
	}
	const live = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(error => {
		// Only absence is nothing. Anything else says what is there could not
		// be read, which is not the same as the archive holding it.
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (!live) return;
	let liveStat: Stats;
	try {
		liveStat = await live.stat();
		if (!liveStat.isFile()) throw new Error(`${source} is not a file the archive can hold`);
		if (!(await survivesSourceRemoval(destination, sourceRoot))) {
			throw new Error(`${destination} is not an independent archived copy of ${source}`);
		}
		if (!(await archivedHandleIsHeldBy(live, liveStat, destination))) {
			throw new Error(`${source} holds what ${destination} does not`);
		}
	} finally {
		await live.close();
	}
	// The descriptor follows a link; the name has to be the file just read.
	const proved = identityFrom(liveStat);
	// A reclaim never gives up a file for an archived copy more readable
	// than it: restoring that copy would hand the bytes to whoever the live
	// file kept them from.
	const wider = await archivedModeWider(source, liveStat, destination);
	if (wider) throw new Error(wider);
	if ((await standsAsProved(source, proved)) !== true) {
		throw new Error(`${source} is no longer the file this run proved; it was kept`);
	}
	proven.files.push({ path: source, destination, ...proved, compared: true });
}

/**
 * Remove a live tree the archive has been shown to hold in full. Only
 * `--reclaim` calls this: it is the one deletion left in the feature, and an
 * operator asks for it on a session they name.
 *
 * Every entry was proved before any of them went — see
 * {@link proveLiveTreeIsArchived} — and the caller holds the lease of every
 * transcript about to go, a subagent's that joined after the tree was first
 * listed included: a session a live process owns is reported and kept
 * before this runs, and a dead owner writes nothing late. What is left here
 * is the removal itself, each entry looked at once more as it goes — see
 * {@link proveEntryStillGoes}. A removal that fails part-way reports exactly
 * what went, because saying a tree "was kept" when some of it is gone is the
 * misreport this replaces.
 *
 * What this does not exclude, stated rather than implied: a process that
 * changes the tree without holding a lease — an editor, a script, anything
 * that is not a session writer — between the last look at an entry and its
 * `unlink`. A subagent session created below the tree after the walk is not
 * removed, because its file was never proved; the removal then stops at its
 * directory and says what it had already given up.
 */
async function removeProvenLiveTree(
	proven: { files: ProvenEntry[]; directories: string[] },
	removed: string[],
): Promise<void> {
	// Appended as each one goes, so a removal that throws part-way leaves the
	// caller holding exactly what it had already given up.
	for (const entry of proven.files) {
		await proveEntryStillGoes(entry);
		await fs.unlink(entry.path);
		removed.push(entry.path);
	}
	for (const directory of proven.directories) {
		await fs.rmdir(directory);
		removed.push(directory);
	}
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
 */
async function archiveAlreadyHolds(source: string, destination: string): Promise<boolean> {
	try {
		if (!(await fs.lstat(destination).catch(() => undefined))?.isFile()) return false;
		const live = await digestStream(Bun.file(source).stream());
		const stored = await digestArchivedSessionFile(destination);
		return live.hash === stored.hash;
	} catch {
		return false;
	}
}

/**
 * Copy one session into the archive: the transcript compressed, then its
 * artifact tree. The live copy stays where it is.
 *
 * A destination that already holds this very transcript needs no second
 * copy of it; its artifact tree is still copied, since that can have grown.
 * What the copy left and why travels with a failure, as it does with a
 * success.
 */
async function copySessionIntoArchive(candidate: ArchiveCandidate): Promise<{ brokenLinks: number; notes: string[] }> {
	const sourceSession = candidate.session.path;
	const destSession = candidate.destinationPath;
	const legacyDestSession = destSession.endsWith(".gz") ? destSession.slice(0, -".gz".length) : `${destSession}.gz`;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	if (await pathExists(legacyDestSession)) throw new Error(`archive destination exists: ${legacyDestSession}`);
	const alreadyArchived = (await pathExists(destSession)) && (await archiveAlreadyHolds(sourceSession, destSession));
	// The archive holding an earlier part of this very session is what a
	// restore leaves behind: it copies and keeps its copy, so the next turn
	// makes the live transcript longer than the archive. That is this session
	// carried on, not a different one, and the archive takes the longer copy
	// rather than refusing for ever.
	const supersedes =
		(await pathExists(destSession)) &&
		!alreadyArchived &&
		(await fs.lstat(destSession).catch(() => undefined))?.isFile() &&
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
	const sessions = await listActiveSessions(sessionsRoot);
	const cutoffMs = Date.now() - options.coldArchiveAfterDays * DAY_MS;
	const result: ArchiveGcResult = {
		archiveDir: archiveRoot,
		scanned: sessions.length,
		skippedActive: 0,
		keptNewestGlobal: 0,
		keptNewestPerCwd: 0,
		wouldArchive: 0,
		archived: 0,
		brokenLinks: 0,
		errors: [],
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
		if (await hasLiveNestedSessions(session, archiveBeforeMs)) {
			result.skippedActive += 1;
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
	// standing now is a dead run's. Reported, never removed: only the run
	// that made a staging directory removes it, and nothing in this phase
	// deletes by name — see {@link surveyRecordedStagingGrounds}.
	const grounds = await surveyRecordedStagingGrounds(options.agentDir, options.apply);
	if (grounds.residue.length > 0) result.stagingResidue = grounds.residue;
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
			tree = await tryAcquireSessionTreeLeases(candidate.session, await collectSessionFiles(candidate.session));
			if (tree === null) {
				result.skippedActive += 1;
				continue;
			}
			result.wouldArchive += 1;
			if (!options.apply) continue;
			const { brokenLinks, notes } = await copySessionIntoArchive(candidate);
			result.archived += 1;
			result.brokenLinks += brokenLinks;
			result.errors.push(...notes);
		} catch (error) {
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
	const prefix = (await Bun.file(file).slice(0, HEADER_SNIFF_BYTES).text()).replace(/^[ \t\r\n]+/, "");
	if (prefix !== "" && prefix[0] !== "{") return undefined;
	return readSessionHeaderId(file);
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
 * Returns the first file whose owner is live or cannot be probed (an
 * unknown owner counts as live), with every lease taken so far left in
 * `tree`; undefined once each one is held.
 */
async function leaseTranscripts(tree: SessionTreeLeases, files: readonly string[]): Promise<string | undefined> {
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
			lease = null;
		}
		if (lease === null) return file;
		tree.leases.push(lease);
	}
	return undefined;
}

/**
 * Leases of every transcript in a session: its own and those nested in its
 * artifact tree — see {@link leaseTranscripts}. Null, with every lease taken
 * so far released, when any of them is live or cannot be probed.
 */
async function tryAcquireSessionTreeLeases(session: SessionInfo, files: string[]): Promise<SessionTreeLeases | null> {
	const tree: SessionTreeLeases = { leases: [], leasedIds: new Set(), transcripts: new Set([session.path]) };
	if ((await leaseTranscripts(tree, files)) === undefined) return tree;
	for (const held of tree.leases) held.release();
	return null;
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
	const sessions = await listActiveSessions(sessionsRoot);
	result.scanned = sessions.length;
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
			tree = await tryAcquireSessionTreeLeases(session, files);
			if (tree === null) {
				result.skippedLive += 1;
				continue;
			}
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
		if (result.archive.brokenLinks > 0) {
			lines.push(`links inside artifact trees whose target was gone: ${result.archive.brokenLinks}`);
		}
		if (result.archive.errors.length > 0) lines.push(`session errors: ${result.archive.errors.length}`);
	}
	if (result.restore) {
		const restore = result.restore;
		if (restore.sessionPath) {
			const verb = result.apply ? "restored" : "would restore";
			const artifacts = restore.artifactsRestored ? " with its artifacts" : "";
			lines.push(`restore: ${verb} ${restore.archivePath} to ${restore.sessionPath}${artifacts}`);
		}
		for (const note of restore.notRestored) lines.push(`not restored: ${note}`);
		if (restore.errors.length > 0) lines.push(`restore errors: ${restore.errors.length}`);
	}
	if (result.reclaim) {
		const reclaim = result.reclaim;
		const partial = reclaim.partiallyRemoved ?? [];
		if (reclaim.reclaimed > 0 && reclaim.sessionPath) {
			lines.push(`reclaim: gave up ${reclaim.sessionPath}; the session is now only in ${reclaim.archivePath}`);
		} else if (partial.length > 0) {
			// Neither "gave up nothing" nor "kept the tree" is true once part
			// of it is gone, and printing both is how a reader stops believing
			// either. One line, saying what happened — and qualified the way
			// the error is, because stdout saying the archive holds all of it
			// while stderr says a joining child's turn may be missing is the
			// reader believing the half that is easier to read.
			lines.push(
				`reclaim: gave up ${partial.length} of ${reclaim.sessionPath ?? reclaim.query} and then stopped; ` +
					`the archive holds what was proved before it stopped — see the error for what it may not hold`,
			);
		} else if (reclaim.wouldReclaim) {
			lines.push(
				`reclaim: would give up ${reclaim.sessionPath}; the session would then be only in ${reclaim.archivePath}`,
			);
		} else {
			// A refusal has to read as one. Reporting only what was given up
			// lets a run that deleted nothing print the same line as a run
			// that worked.
			const verb = result.apply ? "gave up nothing" : "would give up nothing";
			lines.push(`reclaim: ${verb} for "${reclaim.query}"`);
		}
		if (reclaim.keptArtifactTree !== undefined && partial.length === 0) {
			lines.push(`reclaim kept the live artifact tree: ${reclaim.keptArtifactTree}`);
		}
		for (const removed of partial) lines.push(`reclaim removed before it stopped: ${removed}`);
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
	return `${lines.join("\n")}\n`;
}

/**
 * What `--restore --apply` would refuse or leave, for the preview to say
 * first: what stands at the restore record's name — something that is not a
 * regular file is refused, and a regular file is left, keeping the session
 * unfinished — and conflicts in the artifact tree. A preview that checks
 * only the transcript exits 0 over a refusal applying then reports.
 */
async function previewArtifactConflicts(archiveFile: string, sessionPath: string, agentDir: string): Promise<string[]> {
	const refusals: string[] = [];
	const record = restoreRecordPath(archiveFile);
	try {
		const refused = await restoreRecordRefusal(record);
		const standing = await fs.lstat(record).catch((error: unknown) => {
			if (codeOf(error) === "ENOENT") return undefined;
			throw error;
		});
		if (refused) refusals.push(refused);
		else if (standing) refusals.push(restoreRecordLeftNote(record));
	} catch (error) {
		refusals.push(`${record} could not be looked at: ${errorMessage(error)}`);
	}
	try {
		refusals.push(
			...(await artifactRestoreConflicts(archiveFile, sessionPath, agentDir)).map(
				conflict => `the artifact tree would not be restored whole: ${conflict}`,
			),
		);
	} catch (error) {
		refusals.push(`the artifact tree could not be checked: ${errorMessage(error)}`);
	}
	return refusals;
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
	if (!(await pathExists(archiveFile))) {
		result.errors.push(`no such archive file: ${archiveFile}`);
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
		if (await pathExists(sessionPath)) {
			// `--apply` finishes an interrupted restore: the transcript landed,
			// the artifact tree did not, and the live file is this very session
			// carried on. Refusing here would report an error for an operation
			// that applying performs.
			if (!(await archiveIsPrefixOfLive(archiveFile, sessionPath))) {
				result.errors.push(`a different session file already exists at ${sessionPath}; nothing would be restored`);
				return result;
			}
			result.sessionPath = sessionPath;
			const conflicts = await previewArtifactConflicts(archiveFile, sessionPath, options.agentDir);
			result.errors.push(...conflicts);
			result.notRestored.push(...conflicts);
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
		result.sessionPath = sessionPath;
		const conflicts = await previewArtifactConflicts(archiveFile, sessionPath, options.agentDir);
		result.errors.push(...conflicts);
		result.notRestored.push(...conflicts);
		return result;
	}
	try {
		// This command already holds the gc lock for the whole run.
		const restored = await restoreArchivedSessionLocked(archiveFile, options.agentDir);
		result.sessionPath = restored.sessionPath;
		result.bytes = restored.bytes;
		result.artifactsRestored = restored.artifactsRestored;
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
 * Give back the space an archived session's live copy occupies.
 *
 * The one deletion in this feature. `--archive` copies and keeps both sides,
 * so reclaiming is a separate thing an operator asks for on a session they
 * name: the archive is proved to hold every byte the live copy holds, and
 * only then does the live copy go, entry by entry, each looked at again as
 * it goes.
 *
 * A proof and an `unlink` are two operations, and no proof taken between
 * them closes the gap — a subagent session that joined while this ran, holding
 * its own lease, took a turn after the last comparison of its file and lost
 * it. So the rule is about owners, not about proofs: every transcript about
 * to go is leased first, a subagent's that joined after the tree was listed
 * included, and a session any live process owns is reported and kept. A
 * dead owner writes nothing late, and a lease held until the file is gone
 * means nothing claims it in between.
 *
 * What that leaves, named rather than narrowed. A process that writes into
 * the tree without holding a lease, between the last look at an entry and
 * its `unlink`: session writers hold one; editors and scripts do not. And a
 * process with write access to the existing archive's files during the
 * reclaim, even with the archive directory read-only: the comparison is a
 * reading of the archive at one moment, and a byte changed in the archived
 * transcript after it leaves the live copy gone and an archive that does not
 * inflate — no valid copy anywhere.
 */
async function runReclaimGc(options: ResolvedGcOptions, query: string): Promise<ReclaimGcResult> {
	const result: ReclaimGcResult = { query, reclaimed: 0, errors: [] };
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
	const sessionPath = liveSessionPathForArchive(archiveFile, options.agentDir);
	const recovery = agentDirFlag(options.agentDir);
	if (!sessionPath || !(await pathExists(sessionPath))) {
		// The transcript being gone is not the same as the space being given
		// back: removing a transcript by hand leaves its whole artifact tree,
		// which is usually the larger half, and saying the space is back
		// sends the reader away from the directory still holding it.
		const strandedTree = sessionPath ? await pathExists(sessionPath.slice(0, -".jsonl".length)) : false;
		if (sessionPath && strandedTree) result.keptArtifactTree = sessionPath.slice(0, -".jsonl".length);
		result.errors.push(
			`${archiveFile} has no live transcript to reclaim${sessionPath ? ` at ${sessionPath}` : ""}; ` +
				(strandedTree
					? `its live artifact tree is still there and this command does not remove it on its own. ` +
						`Bring the session home with \`omp gc --restore ${shellQuote(path.basename(archiveFile, ".jsonl.gz"))} --apply${recovery}\` ` +
						`and reclaim it, or remove the tree yourself`
					: "the space is already given back"),
		);
		return result;
	}
	result.sessionPath = sessionPath;
	const liveArtifacts = sessionPath.slice(0, -".jsonl".length);
	const archiveArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const holdsLive = async (): Promise<boolean> => await archiveAlreadyHolds(sessionPath, archiveFile);
	const notACopy = (): string =>
		`${archiveFile} is not a copy of ${sessionPath} as it stands; archive it again with ` +
		`\`omp gc --archive --apply${recovery}\` and reclaim after that`;
	// A refusal names the live tree it left behind, on every path that can
	// reach one. Reporting it only sometimes is how a reader learns to stop
	// trusting it.
	const keepTree = async (): Promise<void> => {
		if (await pathExists(liveArtifacts)) result.keptArtifactTree = liveArtifacts;
	};
	const restoreCommand = `omp gc --restore ${shellQuote(path.basename(archiveFile, ".jsonl.gz"))} --apply${recovery}`;
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
	// A session a live process owns is reported and kept, whenever it joined.
	// The transcripts are the files the walk compared: a link or a device
	// carries no session's bytes, and removing one removes only a name. The
	// leases taken go into `tree`; the reason to keep the session, if any,
	// comes back.
	const leaseProvedTranscripts = async (
		tree: SessionTreeLeases,
		proved: { files: ProvenEntry[] },
	): Promise<string | undefined> => {
		const owner = await leaseTranscripts(
			tree,
			proved.files.filter(entry => entry.compared).map(entry => entry.path),
		);
		if (owner === undefined) return undefined;
		await keepTree();
		return (
			`a running process owns ${owner}, or its owner could not be probed; it was found after this run ` +
			`took its leases, and nothing was given up — close it and reclaim again`
		);
	};
	if (!options.apply) {
		// A preview that reports nothing is a preview nobody can act on, and
		// its exit status is how a script learns the difference. Everything
		// applying would refuse for is checked here too, short of taking the
		// leases: the owner is probed and released, and the tree is proved.
		const session = await readSessionInfo(sessionPath).catch(() => undefined);
		const listed = session ? await sessionTree(session) : undefined;
		const probe = listed?.files ? await tryAcquireSessionTreeLeases(session!, listed.files) : null;
		if (probe) for (const held of probe.leases) held.release();
		if (!session) {
			result.errors.push(`${sessionPath} is not a session file`);
			await keepTree();
		} else if (listed?.failure) {
			result.errors.push(listed.failure);
			await keepTree();
		} else if (!probe) {
			result.errors.push(
				`a running process owns ${sessionPath} or one of its subagent sessions; close it and reclaim again`,
			);
			await keepTree();
		}
		const transcriptWider = await archivedModeWider(sessionPath, await fs.stat(sessionPath), archiveFile);
		if (transcriptWider) {
			await keepTree();
			result.errors.push(transcriptWider);
		}
		if (!(await holdsLive())) {
			await keepTree();
			result.errors.push(notACopy());
			return result;
		}
		if (await pathExists(liveArtifacts)) {
			const preview = { files: [] as ProvenEntry[], directories: [] as string[] };
			try {
				const residue = await stagingResidueUnder(options.agentDir, liveArtifacts);
				await proveLiveTreeIsArchived(liveArtifacts, archiveArtifacts, liveArtifacts, preview, residue);
				const probed: SessionTreeLeases = { leases: [], leasedIds: new Set(), transcripts: new Set() };
				const kept = await leaseProvedTranscripts(probed, preview);
				for (const held of probed.leases) held.release();
				if (kept) result.errors.push(kept);
			} catch (error) {
				await keepTree();
				result.errors.push(`${liveArtifacts} would be kept: ${errorMessage(error)}`);
			}
		}
		// A preview that found nothing to refuse has to say what applying
		// would take. Reporting it the way a refusal reports itself — "would
		// give up nothing" — tells the reader the opposite of what is about
		// to happen.
		if (result.errors.length === 0) result.wouldReclaim = 1;
		return result;
	}
	// Leases first, and the whole tree's, the way the archive phase takes
	// them. Proving before taking them proves nothing: the owner can write
	// between the proof and the lease, and the deletion then runs against a
	// reading that is already stale. And a parent's lease says nothing about
	// the subagent sessions below it, whose files this deletes too.
	const session = await readSessionInfo(sessionPath).catch(() => undefined);
	if (!session) {
		await keepTree();
		result.errors.push(`${sessionPath} is not a session file`);
		return result;
	}
	const listed = await sessionTree(session);
	if (listed.failure) {
		await keepTree();
		result.errors.push(listed.failure);
		return result;
	}
	const tree = await tryAcquireSessionTreeLeases(session, listed.files ?? []);
	if (!tree) {
		await keepTree();
		result.errors.push(
			`a running process owns ${sessionPath} or one of its subagent sessions; close it and reclaim again`,
		);
		return result;
	}
	try {
		// Proved under the leases, so what was read is what no writer holding
		// one can change while this runs.
		const transcriptWider = await archivedModeWider(sessionPath, await fs.stat(sessionPath), archiveFile);
		if (transcriptWider) {
			await keepTree();
			result.errors.push(transcriptWider);
			return result;
		}
		if (!(await holdsLive())) {
			await keepTree();
			result.errors.push(notACopy());
			return result;
		}
		// The root goes last, after every entry below it, so it is taken as
		// the entry proved here and checked again as it goes, the way the
		// entries are: a name rebound while the tree was being removed is
		// somebody else's transcript.
		const root = await lookAt(sessionPath);
		if (!root) {
			await keepTree();
			result.errors.push(`${sessionPath} is no longer there to reclaim`);
			return result;
		}
		// Every file settled before any of it goes. Proving and deleting as
		// the walk went meant a tree that refused on its last file had
		// already lost the ones before it, while the report said it was kept.
		const proven = { files: [] as ProvenEntry[], directories: [] as string[] };
		if (await pathExists(liveArtifacts)) {
			try {
				const residue = await stagingResidueUnder(options.agentDir, liveArtifacts);
				await proveLiveTreeIsArchived(liveArtifacts, archiveArtifacts, liveArtifacts, proven, residue);
			} catch (error) {
				await keepTree();
				result.errors.push(`${liveArtifacts} was kept: ${errorMessage(error)}`);
				return result;
			}
		}
		// The walk can reach a subagent session that joined after the leases
		// above were taken; it holds a lease of its own and can take its
		// next turn after any proof of its file. Its lease is taken here, or
		// nothing goes: a live owner's session is not this command's, and a
		// dead one writes nothing late. Each lease taken is held until the
		// file it covers is gone, so nothing claims the session in between.
		const kept = await leaseProvedTranscripts(tree, proven);
		if (kept) {
			result.errors.push(kept);
			return result;
		}
		const removed: string[] = [];
		try {
			await removeProvenLiveTree(proven, removed);
			await proveTranscriptStillGoes(sessionPath, root, archiveFile);
			await fs.unlink(sessionPath);
		} catch (error) {
			// The removal itself failed part-way. What went is named, because
			// the live tree is no longer whole and saying it was kept would be
			// false; the archive holds every file that went, as it was proved,
			// and `omp gc --restore` brings it back.
			result.partiallyRemoved = removed;
			await keepTree();
			result.errors.push(
				removed.length === 0
					? `${sessionPath} was kept: ${errorMessage(error)}`
					: `${sessionPath} was partly given up and then could not be finished: ${errorMessage(error)}. ` +
							`The archive holds every file that went, as it was when proved — \`${restoreCommand}\` brings them back`,
			);
			return result;
		}
		result.reclaimed = 1;
	} catch (error) {
		result.errors.push(errorMessage(error));
	} finally {
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
	const result = await withGcLock(options.agentDir, async lockPath => {
		const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath };
		// A restore runs alone: no sweep may race a session coming back.
		if (options.restoreTarget !== undefined) {
			next.restore = await runRestoreGc(options, options.restoreTarget);
			return next;
		}
		// Reclaiming runs alone too: it is the one phase that deletes a live
		// session, and no sweep may race it.
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
	});

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
	process.stdout.write(output);
	return result;
}
