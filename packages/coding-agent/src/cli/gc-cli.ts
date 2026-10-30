import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
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
	inflateArchivedTranscript,
	isArchivedSessionPath,
	listArchivedSessionFiles,
	liveFileHoldsArchived,
	liveSessionPathForArchive,
	restoreArchivedSessionLocked,
} from "../session/session-archive";
import { codeOf, statIfPresent, withGcLock } from "../session/gc-lock";
import { readSessionHeaderId } from "../session/session-loader";
import {
	FileSessionStorage,
	SESSION_STAGING_RE,
	sessionStagingPath,
	tryAcquireSessionLease,
} from "../session/session-storage";
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
const SESSION_STAGING_GLOB = new Bun.Glob("**/*.tmp");
const ANY_FILE_GLOB = new Bun.Glob("**/*");
/**
 * Archive temps staged before compression moved to {@link sessionStagingPath}:
 * `<session>.jsonl.gz.<pid>.<epoch-ms>.tmp`, beside the archive they publish.
 * Released builds left these in the archive root, where no sweep looked.
 */
const LEGACY_ARCHIVE_STAGING_RE = /^.+\.jsonl\.gz\.\d+\.\d+\.tmp$/;
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
	 * The operator accepts that archiving is forward-only: the transcript
	 * leaves the sessions tree, and an omp without `gc --restore` cannot find
	 * or read it. Required by `--archive --apply`.
	 */
	forwardOnly?: boolean;
	/** Session id prefix or archive path to bring back out of the archive. */
	restore?: string;
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
	/** Session staging temps past the write grace, left by a killed or crashed writer. */
	wouldDeleteTemps: number;
	deletedTemps: number;
	tempBytes: number;
	/** Links inside an artifact tree whose target was already gone, so the archive could not hold their bytes. */
	brokenLinks: number;
	/**
	 * Files a symlinked transcript pointed at. Their bytes are in the archive
	 * now, and omp no longer uses them, but they are outside its storage so it
	 * does not delete them.
	 */
	orphanedTargets: string[];
	/**
	 * Live artifact trees the archive holds a complete copy of, which could not
	 * be removed (a locked file, a read-only directory). The session is
	 * archived; these are bytes still to reclaim by hand.
	 */
	leftoverArtifactTrees: string[];
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
}

interface ResolvedGcOptions {
	apply: boolean;
	json: boolean;
	agentDir: string;
	runBlobs: boolean;
	runArchive: boolean;
	runWal: boolean;
	runStale: boolean;
	runCompress: boolean;
	/** Set by `--forward-only`: the archive phase may move sessions with `--apply`. */
	forwardOnly: boolean;
	/** Set by `--restore`; it runs alone, since no sweep may race a restore. */
	restoreTarget?: string;
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
	// Archiving is the one step omp cannot undo for a reader that does not know
	// about it. A release without `gc --restore` searches `*.jsonl` under the
	// sessions tree and reads a transcript as plain text, so a transcript under
	// `archive/sessions` is invisible to it whether or not it is compressed.
	// Pin a machine back to one of those and its own archived sessions stop
	// resuming until someone inflates them by hand. Nothing is lost and the way
	// back is one command, but nobody takes that step by accident: refusing
	// here, before the gc lock and before settings are migrated, leaves the
	// agent directory exactly as it was found.
	if (runArchive && flags.apply === true && flags.restore === undefined && flags.forwardOnly !== true) {
		const archiveRoot = getArchivedSessionsDir(agentDir);
		throw new Error(
			`--archive --apply moves cold sessions to ${archiveRoot}, where only an omp with \`gc --restore\` can find them; ` +
				`a release pinned back from this one cannot resume them, and inflating one by hand is \`gunzip -c "<file>.jsonl.gz" > "<sessions>/<bucket>/<file>.jsonl"\` plus its artifact directory. ` +
				`Pass --forward-only to accept that, or drop --archive and run \`omp gc --apply\` for the phases that keep every session where it is.`,
		);
	}
	const settings = needsSettings && flags.apply === true ? await Settings.loadIsolated({ agentDir }) : configured;
	const read = <T>(setting: Setting<T>): T => (settings ? setting.get(settings) : setting.default);
	return {
		apply: flags.apply === true,
		json: flags.json === true,
		agentDir,
		forwardOnly: flags.forwardOnly === true,
		restoreTarget: flags.restore?.trim(),
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
): Omit<ArchiveCandidate, "session"> | null {
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

async function movePath(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	try {
		await fs.rename(source, destination);
		return;
	} catch (error) {
		if (codeOf(error) !== "EXDEV") throw error;
	}
	const stat = await fs.stat(source);
	if (stat.isDirectory()) {
		await fs.cp(source, destination, { recursive: true });
		await fs.rm(source, { recursive: true, force: true });
		return;
	}
	await fs.copyFile(source, destination);
	await fs.unlink(source);
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
 * Compress `source` into `destination`, and drop the source only once the
 * archive has been read back and proved to inflate to the same bytes. An
 * archive that cannot be read is not an archive, and a run that reports
 * success must not be the thing that lost the session.
 *
 * A transcript can be a symlink, as `FileSessionStorage.listFilesSync`
 * already treats one as a transcript like any other. The compressed archive
 * holds its content either way. Removing the link leaves the file it names
 * alone and returns it so the caller can report a copy omp no longer uses.
 * omp deletes nothing outside its own storage: that target may be a file its
 * owner keeps, or a second session's link to the same bytes, and a cleanup
 * that can delete an unrelated file is worse than the defect it cleans up
 * after.
 *
 * Once the source is gone the archive is the only copy, so from that point
 * on a later failure never removes it.
 */
async function gzipSessionFile(source: string, destination: string): Promise<{ orphanedTarget?: string }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	// One staging shape across the sessions tree and the archive, so the sweep
	// that reclaims a killed writer's leftovers recognizes this one too.
	const tempPath = sessionStagingPath(destination);
	// Only the transcript's own link counts. `realpath` would also resolve a
	// symlinked sessions directory and report every transcript under it as an
	// orphan, drowning the lines that name a real one.
	const sourceReal = (await fs.lstat(source).catch(() => undefined))?.isSymbolicLink()
		? await fs.realpath(source).catch(() => source)
		: source;
	let sourceGone = false;
	let renamed = false;
	try {
		const expected = await digestStream(Bun.file(source).stream());
		await pipeline(
			Bun.file(source).stream(),
			createGzip({ level: 9 }),
			(await fs.open(tempPath, "w")).createWriteStream(),
		);
		await fs.rename(tempPath, destination);
		renamed = true;
		const stored = await digestArchivedSessionFile(destination);
		if (stored.hash !== expected.hash) {
			throw new Error(
				`archive verification failed for ${source}: ${expected.bytes} bytes in, ${stored.bytes} bytes back`,
			);
		}
		await fs.unlink(source);
		sourceGone = true;
		return { orphanedTarget: sourceReal === source ? undefined : sourceReal };
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		if (renamed && !sourceGone) await fs.rm(destination, { force: true });
		throw error;
	}
}

/**
 * Relative paths the archive already holds under `destination`, or undefined
 * when the destination does not exist. Directories are listed too, so a
 * cleanup can tell one it has to keep from one it made.
 */
async function existingTreePaths(destination: string): Promise<Set<string> | undefined> {
	if (!(await statIfPresent(destination))) return undefined;
	const paths = new Set<string>();
	for await (const name of ANY_FILE_GLOB.scan({ cwd: destination, dot: true, onlyFiles: false })) {
		paths.add(name);
	}
	return paths;
}

/**
 * Refuse the move while the archive holds artifact bytes the live tree does
 * not, and while either tree is the other under another name.
 *
 * `fs.cp(…, { force: true })` truncates an existing destination before it
 * writes the first byte, so a complete archived copy standing where a
 * shorter or divergent live file lands is gone the moment the copy starts.
 * No cleanup recovers it: a snapshot of the destination records which paths
 * were there, not what they held. The conflict therefore has to be resolved
 * before anything is written, and the rule is the restore's rule in the
 * other direction — the surviving copy must hold everything the other had.
 *
 * The alias check is the same hazard seen from the archive side: with
 * `dereference: true`, copying a live path that resolves to its own archived
 * counterpart would read and truncate one file.
 */
async function assertArchiveTreeIsSafeToOverwrite(source: string, destination: string): Promise<void> {
	if (!(await statIfPresent(destination))) return;
	const sourceReal = await fs.realpath(source).catch(() => source);
	const destinationReal = await fs.realpath(destination).catch(() => destination);
	if (sourceReal === destinationReal) {
		throw new Error(
			`the live artifact tree ${source} resolves to the archived tree ${destinationReal}, so archiving it would copy it over itself`,
		);
	}
	for await (const name of ANY_FILE_GLOB.scan({ cwd: destination, dot: true, onlyFiles: true })) {
		const archived = path.join(destination, name);
		const live = path.join(source, name);
		if ((await fs.realpath(live).catch(() => live)) === (await fs.realpath(archived).catch(() => archived))) {
			throw new Error(`${live} resolves to the archived ${archived}, so archiving it would copy it over itself`);
		}
		if (!(await statIfPresent(live))) continue;
		if (await liveFileHoldsArchived(archived, live)) continue;
		throw new Error(
			`the archive already holds ${archived}, and ${live} does not hold its bytes; ` +
				`archiving would overwrite the archived copy with a shorter or different one. ` +
				`Restore the session first (\`omp gc --restore\`), or move one of the two aside`,
		);
	}
}

/**
 * Undo one failed copy into the archive, and nothing more. With no
 * `preexisting` set the destination is this run's own creation and goes
 * whole; otherwise every path absent from that snapshot goes and every path
 * in it stays. Recursion is safe on a path the snapshot does not name: the
 * snapshot was taken before the copy, so nothing under a directory this run
 * created was there before it either. Entries a parent already took are
 * gone, which `force` passes over.
 */
async function removeTreeAdditions(destination: string, preexisting: Set<string> | undefined): Promise<void> {
	if (!preexisting) {
		await fs.rm(destination, { recursive: true, force: true });
		return;
	}
	for await (const name of ANY_FILE_GLOB.scan({ cwd: destination, dot: true, onlyFiles: false })) {
		if (preexisting.has(name)) continue;
		await fs.rm(path.join(destination, name), { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Copy an artifact tree into the archive with symlinks resolved into real
 * files, then drop the source. The archive must hold the bytes: a link into
 * a tree that is relocated or cleaned later archives a session that cannot
 * come back. `fs.rename` is not an option either — the archive root is
 * routinely a symlink onto another filesystem. `force` lets a run finish a
 * tree that a killed run left half-copied.
 *
 * A link whose target is already gone is skipped and counted: dereferencing
 * it throws, and one broken link must not make a session unarchivable
 * forever.
 *
 * A failure part-way through removes only what this copy wrote, so a retry
 * finds no stray tree of its own making — but anything the archive already
 * held stays. After a restore that brought the transcript home and stopped
 * before its artifact tree, the live tree is a subset of the archived one
 * and re-archiving it copies fewer files than are already there; a cleanup
 * that removed the destination would delete the only copy of every artifact
 * the restore had not reached yet, and the transcript rollback could not
 * bring those back.
 *
 * A pre-existing archive entry is never overwritten with bytes it does not
 * already contain: {@link assertArchiveTreeIsSafeToOverwrite} settles that
 * before the copy begins, because `force: true` truncates a destination file
 * before it writes and no cleanup can put back contents.
 *
 * Once the copy is complete the archive holds the session, and a failure to
 * drop the live tree (a locked file, a read-only directory) is reported as a
 * leftover rather than thrown: rolling the move back from here would delete
 * the archive — the only complete copy — and leave the half-removed live tree
 * behind.
 */
async function moveArtifactsTree(
	source: string,
	destination: string,
): Promise<{ brokenLinks: number; leftoverSource?: string }> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await assertArchiveTreeIsSafeToOverwrite(source, destination);
	const preexisting = await existingTreePaths(destination);
	let brokenLinks = 0;
	try {
		await fs.cp(source, destination, {
			recursive: true,
			dereference: true,
			force: true,
			filter: async entry => {
				const link = await fs.lstat(entry).catch(() => undefined);
				if (!link?.isSymbolicLink()) return true;
				if (await pathExists(entry)) return true;
				brokenLinks += 1;
				return false;
			},
		});
	} catch (error) {
		await removeTreeAdditions(destination, preexisting);
		throw error;
	}
	try {
		await fs.rm(source, { recursive: true, force: true });
	} catch {
		return { brokenLinks, leftoverSource: source };
	}
	return { brokenLinks };
}

/**
 * Whether `destination` already holds exactly what archiving `source` would
 * write — the signature of a run killed between the archive landing and the
 * transcript being dropped. Finishing that move is what keeps one session
 * from wedging every later run on `archive destination exists`.
 */
async function archiveAlreadyHolds(source: string, destination: string): Promise<boolean> {
	try {
		const live = await digestStream(Bun.file(source).stream());
		const stored = await digestArchivedSessionFile(destination);
		return live.hash === stored.hash;
	} catch {
		return false;
	}
}

/**
 * Move one session into the archive: the transcript compressed, then its
 * artifact tree. Returns the symlink target the transcript named, if any,
 * which is now a copy omp no longer uses.
 *
 * A destination that already holds this very transcript is a move a killed
 * run did not finish, and is finished here rather than reported forever.
 */
async function moveSessionWithArtifacts(
	candidate: ArchiveCandidate,
): Promise<{ orphanedTarget?: string; brokenLinks: number; leftoverSource?: string }> {
	const sourceSession = candidate.session.path;
	const destSession = candidate.destinationPath;
	const legacyDestSession = destSession.endsWith(".gz") ? destSession.slice(0, -".gz".length) : `${destSession}.gz`;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	if (await pathExists(legacyDestSession)) throw new Error(`archive destination exists: ${legacyDestSession}`);
	const alreadyArchived = (await pathExists(destSession)) && (await archiveAlreadyHolds(sourceSession, destSession));
	if ((await pathExists(destSession)) && !alreadyArchived) {
		throw new Error(`archive destination holds a different session: ${destSession}`);
	}

	const moved: Array<{ source: string; destination: string; compressed?: boolean }> = [];
	let orphanedTarget: string | undefined;
	let brokenLinks = 0;
	let leftoverSource: string | undefined;
	try {
		if (alreadyArchived) {
			// The archive is verified identical, so dropping the transcript only
			// finishes what the killed run had already proved safe.
			const link = await fs.lstat(sourceSession).catch(() => undefined);
			orphanedTarget = link?.isSymbolicLink() ? await fs.realpath(sourceSession).catch(() => undefined) : undefined;
			await fs.unlink(sourceSession);
		} else {
			orphanedTarget = (await gzipSessionFile(sourceSession, destSession)).orphanedTarget;
		}
		moved.push({ source: sourceSession, destination: destSession, compressed: true });
		if (await pathExists(sourceArtifacts)) {
			const tree = await moveArtifactsTree(sourceArtifacts, destArtifacts);
			brokenLinks = tree.brokenLinks;
			leftoverSource = tree.leftoverSource;
			moved.push({ source: sourceArtifacts, destination: destArtifacts });
		}
	} catch (error) {
		for (const move of moved.reverse()) {
			try {
				if (move.compressed) {
					await inflateArchivedTranscript(move.destination, move.source);
					// The archive copy goes only when nothing is left beside it.
					// Artifacts the archive already held — files the live tree
					// never had — are reachable only through their `.jsonl.gz`
					// sibling, which is what `gc --restore` and a resume by id
					// look for; dropping it would strand them on disk.
					if (!(await pathExists(destArtifacts))) await fs.unlink(move.destination);
				} else {
					await movePath(move.destination, move.source);
				}
			} catch {
				// Preserve the original failure; rollback failure is reported by the next scan.
			}
		}
		throw error;
	}
	return { orphanedTarget, brokenLinks, leftoverSource };
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

/**
 * Staging temps directly under `root` and below it, whose basename `matches`.
 * The scan starts at `root` and the sweep below only unlinks the entry it
 * found — never a link's target — so nothing outside the storage gc owns is
 * reached from here.
 *
 * `followSymlinks` says whether that storage continues through a symlinked
 * directory. The archive's buckets and root are commonly links onto another
 * filesystem, and {@link listArchivedSessionFiles} already reads the
 * archives there, so the temps staged beside them are gc's to reclaim too.
 */
async function collectStagingFilesUnder(
	root: string,
	matches: (basename: string) => boolean,
	followSymlinks: boolean,
	into: Map<string, string>,
): Promise<void> {
	try {
		for await (const name of SESSION_STAGING_GLOB.scan({ cwd: root, dot: true, followSymlinks })) {
			if (!matches(path.basename(name))) continue;
			const file = path.join(root, name);
			into.set(normalizePathForComparison(file), file);
		}
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
}

/**
 * Staging temps ({@link SESSION_STAGING_RE}) anywhere under `sessionsRoot` or
 * `archiveRoot`, plus those beside exact session files recorded elsewhere
 * (`--session` paths, collab replicas). A transcript is not the only file
 * published this way: restoring an archived session stages every artifact it
 * brings back, and a killed run leaves those behind too.
 *
 * The archive root also answers for {@link LEGACY_ARCHIVE_STAGING_RE}, the
 * shape released builds staged compression through. Those temps are on disk
 * now and nothing else will ever claim them.
 */
async function collectSessionStagingFiles(
	sessionsRoot: string,
	archiveRoot: string,
	exactSessionFiles: string[],
): Promise<string[]> {
	const files = new Map<string, string>();
	await collectStagingFilesUnder(sessionsRoot, basename => SESSION_STAGING_RE.test(basename), false, files);
	await collectStagingFilesUnder(
		archiveRoot,
		basename => SESSION_STAGING_RE.test(basename) || LEGACY_ARCHIVE_STAGING_RE.test(basename),
		true,
		files,
	);
	for (const sessionFile of exactSessionFiles) {
		const target = path.basename(sessionFile);
		for (const file of await listFilesIfPresent(path.dirname(sessionFile))) {
			if (SESSION_STAGING_RE.exec(path.basename(file))?.[1] === target) {
				files.set(normalizePathForComparison(file), file);
			}
		}
	}
	return [...files.values()];
}

/**
 * Count, and with `--apply` delete, session staging temps past the write
 * grace. A stager writes its temp continuously and renames it away within
 * milliseconds of the last byte, and every gc run — this one, a concurrent
 * one, a restore — holds `<agentDir>/gc.lock` for its whole life, so a temp
 * whose mtime has stood still for the grace belongs to no live writer and
 * nothing will claim it.
 */
async function sweepSessionStagingFiles(
	options: ResolvedGcOptions,
	sessionsRoot: string,
	archiveRoot: string,
	registeredSessionPaths: string[],
	result: ArchiveGcResult,
): Promise<void> {
	const exactSessionFiles = [
		...registeredSessionPaths,
		...(await collectBreadcrumbSessionFiles(getTerminalSessionsDir(options.agentDir))),
	];
	const deleteBeforeMs = Date.now() - GC_WRITE_GRACE_MS;
	for (const file of await collectSessionStagingFiles(sessionsRoot, archiveRoot, exactSessionFiles)) {
		const stat = await statIfPresent(file);
		if (!stat?.isFile() || stat.mtimeMs > deleteBeforeMs) continue;
		result.wouldDeleteTemps += 1;
		result.tempBytes += stat.size;
		if (!options.apply) continue;
		try {
			await fs.unlink(file);
			result.deletedTemps += 1;
		} catch (error) {
			if (codeOf(error) !== "ENOENT") result.errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
}

async function runArchiveGc(
	options: ResolvedGcOptions,
	archiveRoot: string,
	registeredSessionPaths: string[],
): Promise<ArchiveGcResult> {
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
		wouldDeleteTemps: 0,
		deletedTemps: 0,
		tempBytes: 0,
		brokenLinks: 0,
		orphanedTargets: [],
		leftoverArtifactTrees: [],
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
		candidates.push({ ...destination, session });
	}

	// Before archiving moves transcripts away from the temps staged beside them,
	// and before this run stages any archive of its own.
	await sweepSessionStagingFiles(options, sessionsRoot, archiveRoot, registeredSessionPaths, result);

	// An archived session keeps every row that describes it. Its prompt-history,
	// title and recap rows exist nowhere else, and its stats rows are only
	// re-derivable once the transcript is back in the sessions tree, so a
	// command that moves a session it is keeping must not delete them.
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
			const { orphanedTarget, brokenLinks, leftoverSource } = await moveSessionWithArtifacts(candidate);
			result.archived += 1;
			result.brokenLinks += brokenLinks;
			if (orphanedTarget) result.orphanedTargets.push(orphanedTarget);
			if (leftoverSource) result.leftoverArtifactTrees.push(leftoverSource);
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

/**
 * Leases of every transcript in a session: its own and those nested in its
 * artifact tree (subagent sessions, or any file a process can open with
 * `--session`), found by their session header rather than their name. Each
 * session id is leased once, so a copied transcript that shares an id does
 * not read as live. Null, with every lease taken so far released, when any of
 * them is live or cannot be probed (an unknown owner counts as live).
 */
async function tryAcquireSessionTreeLeases(
	session: SessionInfo,
	files: string[],
): Promise<{ leases: FileLockHandle[]; transcripts: Set<string> } | null> {
	const leases: FileLockHandle[] = [];
	const leasedIds = new Set<string>();
	const transcripts = new Set<string>([session.path]);
	for (const file of files) {
		let lease: FileLockHandle | null;
		try {
			const sessionId = await readArtifactSessionId(file);
			if (sessionId === undefined) continue;
			transcripts.add(file);
			if (leasedIds.has(sessionId)) continue;
			lease = tryAcquireSessionLease(sessionId);
			if (lease) leasedIds.add(sessionId);
		} catch (error) {
			if (codeOf(error) === "ENOENT") continue;
			lease = null;
		}
		if (lease === null) {
			for (const held of leases) held.release();
			return null;
		}
		leases.push(lease);
	}
	return { leases, transcripts };
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

function renderText(result: GcResult): string {
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
			// The dry run is where this has to be read, because `--apply` without
			// `--forward-only` never reaches a report.
			lines.push(
				`these sessions would move to ${result.archive.archiveDir}; only an omp with \`gc --restore\` finds them there, so --apply needs --forward-only`,
			);
		}
		for (const target of result.archive.orphanedTargets) {
			lines.push(`archived by content, its link target left in place: ${target}`);
		}
		for (const tree of result.archive.leftoverArtifactTrees) {
			lines.push(`archived, but its live artifact tree could not be removed: ${tree}`);
		}
		if (result.archive.skippedActive > 0) lines.push(`sessions skipped active: ${result.archive.skippedActive}`);
		if (result.archive.wouldDeleteTemps > 0) {
			lines.push(
				`session staging temps: ${result.archive.deletedTemps}/${result.archive.wouldDeleteTemps} files, ${formatBytes(result.archive.tempBytes)}`,
			);
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
		return result;
	}
	try {
		// This command already holds the gc lock for the whole run.
		const restored = await restoreArchivedSessionLocked(archiveFile, options.agentDir);
		result.sessionPath = restored.sessionPath;
		result.bytes = restored.bytes;
		result.artifactsRestored = restored.artifactsRestored;
		// An artifact tree left behind is a half-restored session, not a note.
		result.errors.push(...restored.notRestored.map(note => `could not restore ${note}`));
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

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args.flags);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	if (options.restoreTarget !== undefined && options.explicitPhases.length > 0) {
		// Saying nothing about phases it dropped is how a command reports success
		// for work it never did.
		throw new Error(`--restore runs alone; drop ${options.explicitPhases.map(flag => `--${flag}`).join(" ")}`);
	}
	const result = await withGcLock(options.agentDir, async lockPath => {
		const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath };
		// Stale cleanup may prune a missing first-save target's registry marker.
		const registeredSessionPaths = options.runArchive
			? await collectRegisteredSessionPaths(getCustomSessionFilesDir(options.agentDir))
			: [];
		// A restore runs alone: no sweep may race a session coming back.
		if (options.restoreTarget !== undefined) {
			next.restore = await runRestoreGc(options, options.restoreTarget);
			return next;
		}
		// Pruned collab replicas release their blobs to this run's sweep.
		if (options.runStale) next.stale = await runStaleGc(options);
		if (options.runBlobs) next.blobs = await runBlobGc(options, archiveRoot);
		if (options.runArchive) next.archive = await runArchiveGc(options, archiveRoot, registeredSessionPaths);
		if (options.runCompress) next.compress = await runCompressGc(options, archiveRoot);
		if (options.runWal) next.wal = await runWalGc(options);
		return next;
	});

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
	process.stdout.write(output);
	return result;
}
