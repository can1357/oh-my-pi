import { Database } from "bun:sqlite";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { withStatsSyncLock } from "@oh-my-pi/omp-stats/aggregator";
import {
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getModelDbPath,
	getSessionsDir,
	getStatsDbPath,
	pluralize,
	readLines,
} from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { BLOB_HASH_RE } from "../session/blob-store";
import { inspectSessionEmptiness, type SessionPruneReason, sessionPruneReason } from "../session/session-emptiness";
import type { FileEntry, SessionHeader } from "../session/session-entries";
import { listSessionsReadOnly, type SessionInfo, type SessionStatus } from "../session/session-listing";
import type { LivenessHolder, LivenessSignal, SessionLiveness } from "../session/session-liveness";
import * as sessionLiveness from "../session/session-liveness";
import { loadEntriesFromFile } from "../session/session-loader";
import { planSessionMerge, type SessionMergeConflict, type SessionMergePlan } from "../session/session-merge";
import { resolveManagedSessionRoot } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import { parseTitleSlotFromContent, serializeTitleSlot, titleUpdateFromSlot } from "../session/session-title-slot";
import { shortenPath } from "../tools/render-utils";

const BLOB_FILE_RE = /^([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
const JSONL_GLOB = new Bun.Glob("**/*.jsonl");
const JSONL_GZ_GLOB = new Bun.Glob("**/*.jsonl.gz");
const JSONL_BACKUP_GLOB = new Bun.Glob("**/*.jsonl.*.bak");
const BAK_GLOB = new Bun.Glob("**/*.bak");
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["pending", "interrupted", "unknown"]);
const DAY_MS = 86_400_000;
const GC_WRITE_GRACE_MS = 5 * 60_000;
const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
const BROKEN_SESSION_SUFFIX = ".broken.jsonl";
const GC_LOCK_BREAKER_SUFFIX = ".break";

export interface GcCommandFlags {
	apply?: boolean;
	json?: boolean;
	agentDir?: string;
	blobs?: boolean;
	archive?: boolean;
	wal?: boolean;
	mergeSessions?: boolean;
	pruneEmptySessions?: "archive" | "delete";
	coldArchiveAfterDays?: number;
	retainNewestGlobal?: number;
	retainNewestPerCwd?: number;
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
	scanned: number;
	skippedActive: number;
	keptNewestGlobal: number;
	keptNewestPerCwd: number;
	wouldArchive: number;
	archived: number;
	historyRowsDeleted: number;
	statsRowsDeleted: number;
	ftsRebuilt: boolean;
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

/** A merge disagreement, tagged with the session whose file kept its own version. */
export interface SessionMergeGcConflict extends SessionMergeConflict {
	sessionId: string;
}

/** A session file this pass declined to touch, with the reason it was left alone. */
export interface SessionMergeSkippedFile {
	path: string;
	sessionId?: string;
	reason?: string;
	secondsSinceWrite?: number;
	signals?: LivenessSignal[];
	holders?: LivenessHolder[];
}

/**
 * One split session the pass can reunite.
 *
 * The two kinds arrive by different routes — duplicates share a session id
 * across project directories, forks carry a `parentSession` header pointing at
 * a different id — so they name their files differently and are reported
 * separately even though a single flag finds both.
 */
export type SessionMergeCandidate =
	| { kind: "duplicate"; sessionId: string; destination: string; sources: string[] }
	| {
			kind: "fork";
			sessionId: string;
			parent: string;
			fork: string;
			sharedEntries: number;
			forkOnlyEntries: number;
			/** Distinct destination entries that the fork-only subtrees hang from. */
			attachmentPoints: number;
	  };

export interface SessionMergeGcResult {
	/** Top-level session files examined for duplicate ids. */
	scanned: number;
	/** Fork discovery reads a wider set — backups and compressed sessions too. */
	forkScanned: number;
	duplicateGroups: number;
	forkPairs: number;
	skippedActive: number;
	skipped: SessionMergeSkippedFile[];
	/** Files that would be folded into another session and archived. */
	wouldMerge: number;
	/** Destination sessions actually rewritten. */
	merged: number;
	archivedSources: number;
	addedEntries: number;
	skippedEntries: number;
	conflicts: SessionMergeGcConflict[];
	candidates: SessionMergeCandidate[];
	errors: string[];
	livenessDegraded: string[];
}
export interface EmptySessionGcCandidate {
	path: string;
	sessionId: string;
	reason: SessionPruneReason;
	userMessages: number;
	assistantMessages: number;
	assistantTextChars: number;
	unfinishedAttempts: number;
	bytes: number;
}

export interface EmptySessionGcSkippedFile {
	path: string;
	secondsSinceWrite: number | undefined;
	signals: LivenessSignal[];
	holders: LivenessHolder[];
	reason?: string;
}

export interface EmptySessionGcResult {
	scanned: number;
	empty: number;
	skippedActive: number;
	wouldPrune: number;
	archived: number;
	deleted: number;
	emptyDirs: number;
	removedDirs: number;
	candidates: EmptySessionGcCandidate[];
	skipped: EmptySessionGcSkippedFile[];
	livenessDegraded: string[];
	errors: string[];
}

export interface GcResult {
	agentDir: string;
	apply: boolean;
	blobs?: BlobGcResult;
	archive?: ArchiveGcResult;
	wal?: WalGcResult;
	mergeSessions?: SessionMergeGcResult;
	pruneEmptySessions?: EmptySessionGcResult;
	lockPath: string;
	livenessDegraded: string[];
}

interface BlobCandidate {
	hash: string;
	paths: string[];
	bytes: number;
	mtimeMs: number;
}

interface ArchiveCandidate {
	session: SessionInfo;
	relativePath: string;
	destinationPath: string;
}

interface DuplicateSessionFile {
	path: string;
	header: SessionHeader;
	entries: FileEntry[];
	entryCount: number;
	cwdDirectoryMatch: boolean;
}

interface DuplicateSessionGroup {
	sessionId: string;
	destination: DuplicateSessionFile;
	sources: DuplicateSessionFile[];
}

interface ForkLineageFile {
	path: string;
	id: string;
	entries: FileEntry[];
}

interface ForkLineagePair {
	parent: ForkLineageFile;
	plan: SessionMergePlan;
	fork: ForkLineageFile;
	sharedEntries: number;
	forkOnlyEntries: number;
	attachmentPoints: number;
}

interface ResolvedGcOptions {
	apply: boolean;
	json: boolean;
	agentDir: string;
	runBlobs: boolean;
	runArchive: boolean;
	runWal: boolean;
	runMergeSessions: boolean;
	pruneEmptySessions?: "archive" | "delete";
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
}

interface SqliteRunResult {
	changes?: number | bigint;
}

interface WalCheckpointRow {
	busy?: number | bigint | null;
	log?: number | bigint | null;
	checkpointed?: number | bigint | null;
}

interface GcLockSnapshot {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	text: string;
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
	const selected =
		flags.blobs === true ||
		flags.archive === true ||
		flags.wal === true ||
		flags.mergeSessions === true ||
		flags.pruneEmptySessions !== undefined;
	const archiveSelected = selected && flags.archive === true;
	const needsArchiveSettings =
		archiveSelected &&
		(flags.coldArchiveAfterDays === undefined ||
			flags.retainNewestGlobal === undefined ||
			flags.retainNewestPerCwd === undefined);
	const settings =
		!selected || needsArchiveSettings
			? flags.apply === true
				? await Settings.loadIsolated({ agentDir })
				: await Settings.loadReadOnly({ agentDir })
			: undefined;
	const getBoolean = (pathKey: "gc.blobs" | "gc.archive" | "gc.wal") => settings?.get(pathKey) ?? getDefault(pathKey);
	const getNumber = (pathKey: "gc.coldArchiveAfterDays" | "gc.retainNewestGlobal" | "gc.retainNewestPerCwd") =>
		settings?.get(pathKey) ?? getDefault(pathKey);
	return {
		apply: flags.apply === true,
		json: flags.json === true,
		agentDir,
		runBlobs: selected ? flags.blobs === true : getBoolean("gc.blobs"),
		runArchive: selected ? flags.archive === true : getBoolean("gc.archive"),
		runWal: selected ? flags.wal === true : getBoolean("gc.wal"),
		runMergeSessions: flags.mergeSessions === true,
		pruneEmptySessions: flags.pruneEmptySessions,
		coldArchiveAfterDays: numberSetting(
			flags.coldArchiveAfterDays,
			getNumber("gc.coldArchiveAfterDays"),
			getDefault("gc.coldArchiveAfterDays"),
		),
		retainNewestGlobal: numberSetting(
			flags.retainNewestGlobal,
			getNumber("gc.retainNewestGlobal"),
			getDefault("gc.retainNewestGlobal"),
		),
		retainNewestPerCwd: numberSetting(
			flags.retainNewestPerCwd,
			getNumber("gc.retainNewestPerCwd"),
			getDefault("gc.retainNewestPerCwd"),
		),
	};
}

export function collectGcErrors(result: GcResult): string[] {
	return [
		...(result.blobs?.errors ?? []).map(error => `blobs: ${error}`),
		...(result.archive?.errors ?? []).map(error => `archive: ${error}`),
		...(result.mergeSessions?.errors ?? []).map(error => `merge: ${error}`),
		...(result.pruneEmptySessions?.errors ?? []).map(error => `prune: ${error}`),
	];
}

function getArchivedSessionsDir(agentDir: string): string {
	return path.join(path.dirname(getSessionsDir(agentDir)), "archive", "sessions");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function inspectGcLiveness(file: string, degraded: Set<string>): Promise<SessionLiveness> {
	const liveness = await sessionLiveness.inspectSessionLiveness(file);
	for (const reason of liveness.degraded) degraded.add(reason);
	return liveness;
}

function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
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

async function statIfPresent(target: string) {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
}

async function readTextIfPresent(file: string): Promise<string> {
	try {
		if (file.endsWith(COMPRESSED_SESSION_SUFFIX)) {
			return new TextDecoder().decode(gunzipSync(await Bun.file(file).bytes()));
		}
		return await Bun.file(file).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return "";
		throw error;
	}
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(JSONL_GLOB.scan(root), name => path.join(root, name));
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

async function collectCompressedJsonlFiles(root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(JSONL_GZ_GLOB.scan(root), name => path.join(root, name));
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

async function collectBackupJsonlFiles(root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(JSONL_BACKUP_GLOB.scan(root), name => path.join(root, name));
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

async function collectBakFiles(root: string): Promise<string[]> {
	try {
		const files = await Array.fromAsync(BAK_GLOB.scan(root), name => path.join(root, name));
		files.sort();
		return files;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}

async function collectReferencedBlobHashes(sessionRoots: string[]): Promise<Set<string>> {
	const hashes = new Set<string>();
	for (const root of sessionRoots) {
		const files = [
			...(await collectJsonlFiles(root)),
			...(await collectCompressedJsonlFiles(root)),
			...(await collectBackupJsonlFiles(root)),
		];
		for (const file of files) {
			const text = await readTextIfPresent(file);
			for (const match of text.matchAll(BLOB_REF_RE)) {
				const hash = match[1]?.toLowerCase();
				if (hash && BLOB_HASH_RE.test(hash)) hashes.add(hash);
			}
		}
	}
	return hashes;
}

async function collectBlobCandidates(blobDir: string): Promise<BlobCandidate[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(blobDir);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}

	const byHash = new Map<string, BlobCandidate>();
	for (const entry of entries) {
		const match = entry.match(BLOB_FILE_RE);
		const hash = match?.[1];
		if (!hash) continue;
		const file = path.join(blobDir, entry);
		const stat = await statIfPresent(file);
		if (!stat) continue;
		if (!stat.isFile()) continue;
		const candidate = byHash.get(hash) ?? { hash, paths: [], bytes: 0, mtimeMs: stat.mtimeMs };
		candidate.paths.push(file);
		candidate.bytes += stat.size;
		candidate.mtimeMs = Math.max(candidate.mtimeMs, stat.mtimeMs);
		byHash.set(hash, candidate);
	}
	return [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

async function runBlobGc(options: ResolvedGcOptions, archiveSessionsRoot: string): Promise<BlobGcResult> {
	const blobDir = getBlobsDir(options.agentDir);
	const sessionsRoot = getSessionsDir(options.agentDir);
	const referenced = await collectReferencedBlobHashes([sessionsRoot, archiveSessionsRoot]);
	const candidates = await collectBlobCandidates(blobDir);
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
		result.wouldDelete += candidate.paths.length;
		result.bytes += candidate.bytes;
		if (!options.apply) continue;
		for (const file of candidate.paths) {
			try {
				await fs.unlink(file);
				result.deleted += 1;
			} catch (error) {
				if (codeOf(error) === "ENOENT") continue;
				result.errors.push(`${file}: ${errorMessage(error)}`);
			}
		}
	}
	return result;
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

interface SessionLineageHeader {
	id: string;
	parentSession?: string;
	previousSessionFiles: string[];
}

function sessionLineageHeaderFromText(text: string): SessionLineageHeader | undefined {
	let sawTitleSlot = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const record = JSON.parse(line) as {
				type?: unknown;
				id?: unknown;
				parentSession?: unknown;
				previousSessionFiles?: unknown;
			};
			if (!sawTitleSlot && record.type === "title") {
				sawTitleSlot = true;
				continue;
			}
			if (record.type !== "session" || typeof record.id !== "string" || record.id.length === 0) return undefined;
			return {
				id: record.id,
				parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
				previousSessionFiles: Array.isArray(record.previousSessionFiles)
					? record.previousSessionFiles.filter(
							(previousSessionFile): previousSessionFile is string =>
								typeof previousSessionFile === "string" && previousSessionFile.length > 0,
						)
					: [],
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function readSessionLineageHeader(file: string): Promise<SessionLineageHeader | undefined> {
	const decoder = new TextDecoder();
	const lines: string[] = [];
	for await (const line of readLines(Bun.file(file).stream())) {
		const decoded = decoder.decode(line).trim();
		if (!decoded) continue;
		lines.push(decoded);
		const header = sessionLineageHeaderFromText(lines.join("\n"));
		if (header || lines.length >= 2) return header;
	}
	return undefined;
}

function isTopLevelSessionFile(sessionsRoot: string, file: string): boolean {
	const relative = path.relative(sessionsRoot, file);
	if (relative.startsWith("..") || path.isAbsolute(relative) || relative.endsWith(BROKEN_SESSION_SUFFIX)) return false;
	return relative.split(path.sep).length === 2;
}

async function loadDuplicateSessionFile(
	file: string,
	sessionId: string,
	sessionsRoot: string,
	storage: FileSessionStorage,
): Promise<DuplicateSessionFile> {
	const entries = await loadEntriesFromFile(file, storage);
	const header = entries[0];
	if (header?.type !== "session" || header.id !== sessionId) {
		throw new Error("session header changed during duplicate scan");
	}
	return {
		path: file,
		header,
		entries,
		entryCount: entries.length,
		cwdDirectoryMatch: resolveManagedSessionRoot(path.dirname(file), header.cwd) === path.resolve(sessionsRoot),
	};
}

function chooseDuplicateDestination(files: DuplicateSessionFile[]): DuplicateSessionFile {
	return files.toSorted(
		(left, right) =>
			Number(right.cwdDirectoryMatch) - Number(left.cwdDirectoryMatch) ||
			right.entryCount - left.entryCount ||
			left.path.localeCompare(right.path),
	)[0]!;
}

async function collectDuplicateSessionGroups(
	sessionsRoot: string,
	result: SessionMergeGcResult,
	degraded: Set<string>,
): Promise<DuplicateSessionGroup[]> {
	const files = (await collectJsonlFiles(sessionsRoot)).filter(file => isTopLevelSessionFile(sessionsRoot, file));
	result.scanned = files.length;
	const statusByPath = new Map(
		(await listActiveSessions(sessionsRoot)).map(session => [path.resolve(session.path), session.status]),
	);
	const byId = new Map<string, Array<{ path: string }>>();
	for (const file of files) {
		try {
			const lineage = await readSessionLineageHeader(file);
			if (!lineage || !sessionPathEncodesId(file, lineage.id)) continue;
			const group = byId.get(lineage.id) ?? [];
			group.push({ path: file });
			byId.set(lineage.id, group);
		} catch (error) {
			result.errors.push(`${file}: ${errorMessage(error)}`);
		}
	}

	const storage = new FileSessionStorage();
	const groups: DuplicateSessionGroup[] = [];
	for (const [sessionId, members] of byId) {
		if (members.length < 2 || new Set(members.map(member => path.dirname(member.path))).size < 2) continue;
		const active = members.filter(member => {
			const status = statusByPath.get(path.resolve(member.path));
			return status !== undefined && ACTIVE_STATUSES.has(status);
		});
		if (active.length > 0) {
			result.skippedActive += members.length;
			for (const member of active) {
				result.skipped.push({
					sessionId,
					path: member.path,
					reason: `session status is ${statusByPath.get(path.resolve(member.path))}`,
				});
			}
			continue;
		}
		const live = (await Promise.all(members.map(member => inspectGcLiveness(member.path, degraded)))).filter(
			liveness => liveness.live,
		);
		if (live.length > 0) {
			// One live member makes rewriting any member of the group unsafe.
			result.skippedActive += members.length;
			for (const liveness of live) {
				result.skipped.push({
					sessionId,
					path: liveness.path,
					secondsSinceWrite: liveness.secondsSinceWrite,
					signals: liveness.signals,
					holders: liveness.holders,
				});
			}
			continue;
		}
		const loaded: DuplicateSessionFile[] = [];
		let failed = false;
		for (const member of members) {
			try {
				loaded.push(await loadDuplicateSessionFile(member.path, sessionId, sessionsRoot, storage));
			} catch (error) {
				result.errors.push(`${member.path}: ${errorMessage(error)}`);
				failed = true;
			}
		}
		if (failed) continue;
		const destination = chooseDuplicateDestination(loaded);
		groups.push({
			sessionId,
			destination,
			sources: loaded.filter(file => file !== destination).sort((a, b) => a.path.localeCompare(b.path)),
		});
	}
	groups.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
	return groups;
}

function forkDiscoveryExclusion(sessionsRoot: string, file: string): string | undefined {
	const relative = path.relative(sessionsRoot, file);
	const segments = relative.split(path.sep);
	if (segments.some(segment => segment.includes(".backup-"))) return "path is under a session backup directory";
	if (file.endsWith(COMPRESSED_SESSION_SUFFIX)) return "compressed session file";
	if (file.endsWith(BROKEN_SESSION_SUFFIX)) return "broken session file";
	if (file.endsWith(".bak")) return "session backup file";
	if (relative.startsWith("..") || path.isAbsolute(relative) || segments.length !== 2) {
		return "nested subagent session file";
	}
	return undefined;
}

/**
 * A `parentSession` header value, which real sessions write in two forms.
 *
 * `SessionManager.forkFrom` records the parent's session id, but sessions on
 * disk also carry an absolute or sessions-root-relative JSONL path. Matching a
 * path against header ids finds nothing, so treating every value as an id drops
 * the pair and — worse — reports a file that plainly exists as missing.
 */
type ForkParentReference =
	| { kind: "file"; path: string }
	| { kind: "id"; id: string }
	| { kind: "self" }
	| { kind: "skip"; reason: string };

function resolveForkParentReference(
	sessionsRoot: string,
	forkPath: string,
	parentSession: string,
): ForkParentReference {
	const reference = parentSession.trim();
	if (reference.length === 0) {
		return {
			kind: "skip",
			reason: `parent session reference ${JSON.stringify(parentSession)} could not be resolved`,
		};
	}
	if (!reference.includes("/") && !reference.includes(path.sep) && !reference.endsWith(SESSION_SUFFIX)) {
		return { kind: "id", id: reference };
	}
	const resolved = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(sessionsRoot, reference);
	if (resolved === path.resolve(forkPath)) return { kind: "self" };
	const relative = path.relative(sessionsRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return { kind: "skip", reason: `parent session path ${reference} is outside the sessions root` };
	}
	return { kind: "file", path: resolved };
}

async function collectForkLineageGroups(
	sessionsRoot: string,
	result: SessionMergeGcResult,
): Promise<ForkLineagePair[]> {
	const files = [
		...(await collectJsonlFiles(sessionsRoot)),
		...(await collectCompressedJsonlFiles(sessionsRoot)),
		...(await collectBakFiles(sessionsRoot)),
	].toSorted();
	// Deliberately not `result.scanned`: this set is wider than the duplicate scan's
	// (backups and compressed sessions), so folding the two would inflate it.
	result.forkScanned = files.length;

	const lineages: Array<{ path: string; header: SessionLineageHeader }> = [];
	const byId = new Map<string, Array<{ path: string; header: SessionLineageHeader }>>();
	for (const file of files) {
		const exclusion = forkDiscoveryExclusion(sessionsRoot, file);
		if (exclusion) {
			result.skipped.push({ path: file, reason: exclusion });
			continue;
		}
		try {
			const header = await readSessionLineageHeader(file);
			if (!header) continue;
			const lineage = { path: file, header };
			lineages.push(lineage);
			const matches = byId.get(header.id) ?? [];
			matches.push(lineage);
			byId.set(header.id, matches);
		} catch (error) {
			result.errors.push(`${file}: ${errorMessage(error)}`);
		}
	}

	const storage = new FileSessionStorage();
	const pairs: ForkLineagePair[] = [];
	const degraded = new Set<string>();
	for (const forkLineage of lineages) {
		const parentSession = forkLineage.header.parentSession;
		if (parentSession === undefined) continue;
		const resolution = resolveForkParentReference(sessionsRoot, forkLineage.path, parentSession);
		if (resolution.kind === "self" || (resolution.kind === "id" && resolution.id === forkLineage.header.id)) {
			result.skipped.push({ path: forkLineage.path, reason: "parentSession self-reference" });
			continue;
		}
		if (resolution.kind === "skip") {
			result.skipped.push({ path: forkLineage.path, reason: resolution.reason });
			continue;
		}

		let parentLineage: { path: string; header: SessionLineageHeader };
		if (resolution.kind === "id") {
			const parentMatches = byId.get(resolution.id);
			if (!parentMatches || parentMatches.length === 0) {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session id ${resolution.id} not found among scanned sessions`,
				});
				continue;
			}
			if (parentMatches.length > 1) {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session id ${resolution.id} is ambiguous`,
				});
				continue;
			}
			parentLineage = parentMatches[0]!;
		} else {
			const exclusion = forkDiscoveryExclusion(sessionsRoot, resolution.path);
			if (exclusion) {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session file ${resolution.path} is excluded: ${exclusion}`,
				});
				continue;
			}
			let parentExists = false;
			try {
				parentExists = (await statIfPresent(resolution.path)) !== null;
			} catch {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session file ${resolution.path} is unreadable`,
				});
				continue;
			}
			if (!parentExists) {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session file ${resolution.path} not found on disk`,
				});
				continue;
			}
			let parentHeader: SessionLineageHeader | undefined;
			try {
				parentHeader = await readSessionLineageHeader(resolution.path);
			} catch {
				// Report the path as unreadable below; a parse/read failure is not absence.
			}
			if (!parentHeader || !sessionPathEncodesId(resolution.path, parentHeader.id)) {
				result.skipped.push({
					path: forkLineage.path,
					reason: `parent session file ${resolution.path} is unreadable`,
				});
				continue;
			}
			parentLineage = { path: resolution.path, header: parentHeader };
		}
		try {
			const paths = [parentLineage.path, forkLineage.path];
			const live = (await Promise.all(paths.map(file => inspectGcLiveness(file, degraded)))).filter(
				liveness => liveness.live,
			);
			if (live.length > 0) {
				result.skippedActive += live.length;
				for (const liveness of live) {
					result.skipped.push({
						path: liveness.path,
						reason: "held by a live process",
						secondsSinceWrite: liveness.secondsSinceWrite,
						signals: liveness.signals,
						holders: liveness.holders,
					});
				}
				continue;
			}

			const [parentEntries, forkEntries] = await Promise.all([
				loadEntriesFromFile(parentLineage.path, storage),
				loadEntriesFromFile(forkLineage.path, storage),
			]);
			const plan = planSessionMerge(parentEntries, forkEntries);
			if (plan.addedEntries === 0) {
				result.skipped.push({ path: forkLineage.path, reason: "fork contributes no unique entries" });
				continue;
			}
			const destinationIds = new Set(parentEntries.filter(entry => entry.type !== "session").map(entry => entry.id));
			const sourceEntries = forkEntries.filter(entry => entry.type !== "session");
			const attachmentParents = new Set(
				sourceEntries.flatMap(entry =>
					!destinationIds.has(entry.id) && entry.parentId !== null && destinationIds.has(entry.parentId)
						? [entry.parentId]
						: [],
				),
			);
			pairs.push({
				parent: { path: parentLineage.path, id: parentLineage.header.id, entries: parentEntries },
				fork: { path: forkLineage.path, id: forkLineage.header.id, entries: forkEntries },
				plan,
				sharedEntries: sourceEntries.filter(entry => destinationIds.has(entry.id)).length,
				forkOnlyEntries: plan.addedEntries,
				attachmentPoints: attachmentParents.size,
			});
		} catch (error) {
			result.errors.push(`${forkLineage.path}: ${errorMessage(error)}`);
		}
	}
	pairs.sort((left, right) => left.fork.path.localeCompare(right.fork.path));
	result.livenessDegraded = [...degraded];
	return pairs;
}

function serializeMergedSession(originalContent: string, entries: FileEntry[]): string {
	const titleSlot = parseTitleSlotFromContent(originalContent);
	const titleUpdate = titleUpdateFromSlot(titleSlot);
	let physicalEntries = entries;
	const logicalHeader = entries[0];
	if (titleUpdate && logicalHeader?.type === "session") {
		const { title: _title, titleSource: _titleSource, ...physicalHeader } = logicalHeader;
		physicalEntries = [physicalHeader, ...entries.slice(1)];
	}
	const body = `${physicalEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	return titleUpdate ? `${serializeTitleSlot(titleUpdate)}${body}` : body;
}

async function moveDuplicateSourceToArchive(source: string, sessionsRoot: string, archiveRoot: string): Promise<void> {
	const relativePath = path.relative(sessionsRoot, source);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error("duplicate source is outside the sessions root");
	}
	const destination = path.join(archiveRoot, relativePath);
	const sourceArtifacts = sessionArtifactsPath(source);
	const destinationArtifacts = sessionArtifactsPath(destination);
	if (await pathExists(destination)) throw new Error(`archive destination exists: ${destination}`);
	if ((await pathExists(sourceArtifacts)) && (await pathExists(destinationArtifacts))) {
		throw new Error(`archive artifacts destination exists: ${destinationArtifacts}`);
	}
	await movePath(source, destination);
	try {
		if (await pathExists(sourceArtifacts)) await movePath(sourceArtifacts, destinationArtifacts);
	} catch (error) {
		try {
			await movePath(destination, source);
		} catch {
			// Preserve the original failure; the archived source remains recoverable.
		}
		throw error;
	}
}

async function gzipSessionFile(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
	let renamed = false;
	try {
		const compressed = gzipSync(await Bun.file(source).bytes(), { level: 9 });
		await Bun.write(tempPath, compressed);
		await fs.rename(tempPath, destination);
		renamed = true;
		await fs.unlink(source);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		if (renamed) await fs.rm(destination, { force: true });
		throw error;
	}
}

async function restoreGzipSessionFile(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const decompressed = gunzipSync(await Bun.file(source).bytes());
	await Bun.write(destination, decompressed);
	await fs.unlink(source);
}

async function moveSessionWithArtifacts(candidate: ArchiveCandidate): Promise<void> {
	const sourceSession = candidate.session.path;
	const destSession = candidate.destinationPath;
	const legacyDestSession = destSession.endsWith(".gz") ? destSession.slice(0, -".gz".length) : `${destSession}.gz`;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	if (await pathExists(destSession)) throw new Error(`archive destination exists: ${destSession}`);
	if (await pathExists(legacyDestSession)) throw new Error(`archive destination exists: ${legacyDestSession}`);
	if ((await pathExists(sourceArtifacts)) && (await pathExists(destArtifacts))) {
		throw new Error(`archive artifacts destination exists: ${destArtifacts}`);
	}

	const moved: Array<{ source: string; destination: string; compressed?: boolean }> = [];
	try {
		await gzipSessionFile(sourceSession, destSession);
		moved.push({ source: sourceSession, destination: destSession, compressed: true });
		if (await pathExists(sourceArtifacts)) {
			await movePath(sourceArtifacts, destArtifacts);
			moved.push({ source: sourceArtifacts, destination: destArtifacts });
		}
	} catch (error) {
		for (const move of moved.reverse()) {
			try {
				if (move.compressed) {
					await restoreGzipSessionFile(move.destination, move.source);
				} else {
					await movePath(move.destination, move.source);
				}
			} catch {
				// Preserve the original failure; rollback failure is reported by the next scan.
			}
		}
		throw error;
	}
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

function tableExists(db: Database, table: string): boolean {
	const row = db
		.prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
		.get(table) as { present?: number } | null;
	return row?.present === 1;
}

function historyHasSessionId(db: Database): boolean {
	const rows = db.prepare("PRAGMA table_info(history)").all() as Array<{ name?: string | null }>;
	return rows.some(row => row.name === "session_id");
}

function deleteHistoryRowsForSessions(dbPath: string, sessionIds: string[]): { deleted: number; ftsRebuilt: boolean } {
	if (sessionIds.length === 0) return { deleted: 0, ftsRebuilt: false };
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		if (!tableExists(db, "history")) return { deleted: 0, ftsRebuilt: false };
		if (!historyHasSessionId(db)) return { deleted: 0, ftsRebuilt: false };
		const hasFts = tableExists(db, "history_fts");
		const deleteStmt = db.prepare("DELETE FROM history WHERE session_id = ?");
		let deleted = 0;
		const tx = db.transaction((ids: string[]) => {
			for (const id of ids) {
				const result = deleteStmt.run(id) as SqliteRunResult;
				deleted += sqliteNumber(result.changes);
			}
			if (deleted > 0 && hasFts) db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		});
		tx(sessionIds);
		return { deleted, ftsRebuilt: deleted > 0 && hasFts };
	} finally {
		db.close();
	}
}

async function collectArchivedSessionIds(archiveRoot: string): Promise<string[]> {
	const ids = new Set<string>();
	for (const file of await collectCompressedJsonlFiles(archiveRoot)) {
		const id = sessionLineageHeaderFromText(await readTextIfPresent(file))?.id;
		if (id) ids.add(id);
	}
	return [...ids].sort();
}

async function cleanupHistoryRowsForArchivedSessions(
	options: ResolvedGcOptions,
	archiveRoot: string,
	archivedSessionIds: string[],
	result: ArchiveGcResult,
): Promise<void> {
	const dbPath = getHistoryDbPath(options.agentDir);
	if (!(await pathExists(dbPath))) return;

	const cleanupIds = new Set(archivedSessionIds);
	try {
		for (const id of await collectArchivedSessionIds(archiveRoot)) cleanupIds.add(id);
	} catch (error) {
		result.errors.push(`history cleanup scan: ${errorMessage(error)}`);
	}

	try {
		const cleanup = deleteHistoryRowsForSessions(dbPath, [...cleanupIds]);
		result.historyRowsDeleted = cleanup.deleted;
		result.ftsRebuilt = cleanup.ftsRebuilt;
	} catch (error) {
		result.errors.push(`history cleanup: ${errorMessage(error)}`);
	}
}

const STATS_SESSION_TABLES = ["messages", "user_messages", "tool_calls", "file_offsets"] as const;
const STATS_ENTRY_TABLES = ["messages", "user_messages", "tool_calls"] as const;
type StatsEntryTable = (typeof STATS_ENTRY_TABLES)[number];

const STATS_IDENTITY_COLUMNS: Record<StatsEntryTable, readonly string[]> = {
	messages: ["entry_id", "timestamp"],
	user_messages: ["entry_id", "timestamp"],
	tool_calls: ["entry_id", "timestamp", "tool_call_id"],
};

interface StatsSession {
	path: string;
	id: string;
	parentSession?: string;
	historicalPaths: string[];
	identities: Record<StatsEntryTable, StatsEntryIdentity[]>;
}

interface StatsLineageNode extends StatsSession {
	statsPaths: Set<string>;
	identityKeys: Set<string>;
}

interface StatsEntryIdentity {
	entryId: string;
	timestamp: number;
	toolCallId: string;
}

interface StatsTransferTarget {
	path: string;
	identities: Record<StatsEntryTable, StatsEntryIdentity[]>;
}

interface StatsCleanupPlan {
	sessionPaths: string[];
	retainedSessions: StatsLineageNode[];
	transfers: StatsTransferTarget[];
	archivedIdentityKeys: Set<string>;
	preserveAll: boolean;
}

interface StatsCleanupContext {
	plans: StatsCleanupPlan[];
	incompleteRetainedSessions: StatsLineageNode[];
}

function createStatsIdentities(): Record<StatsEntryTable, StatsEntryIdentity[]> {
	return {
		messages: [],
		user_messages: [],
		tool_calls: [],
	};
}

function statsIdentityKey(table: StatsEntryTable, identity: StatsEntryIdentity): string {
	return `${table}\0${identity.entryId}\0${identity.timestamp}\0${identity.toolCallId}`;
}

function statsIdentityKeys(identities: Record<StatsEntryTable, StatsEntryIdentity[]>): Set<string> {
	const keys = new Set<string>();
	for (const table of STATS_ENTRY_TABLES) {
		for (const identity of identities[table]) keys.add(statsIdentityKey(table, identity));
	}
	return keys;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string | null }>;
	return rows.some(row => row.name === column);
}

function collectStoredStatsSessionPaths(db: Database): string[] {
	const sessionPaths = new Set<string>();
	for (const table of STATS_SESSION_TABLES) {
		if (!tableExists(db, table) || !tableHasColumn(db, table, "session_file")) continue;
		const rows = db.prepare(`SELECT DISTINCT session_file FROM ${table}`).all() as Array<{
			session_file?: string | null;
		}>;
		for (const row of rows) {
			if (typeof row.session_file === "string") sessionPaths.add(row.session_file);
		}
	}
	return [...sessionPaths];
}

/**
 * `/move` preserves the session filename and artifacts-directory basename.
 * Recover the top-level path represented by any main or nested stats row so
 * one archived logical session can reconcile every historical location.
 */
function logicalSessionRootForStatsPath(statsPath: string, sessionPath: string): string | undefined {
	const sessionFilename = path.basename(sessionPath);
	if (path.basename(statsPath) === sessionFilename) return statsPath;

	const artifactsDirname = sessionFilename.slice(0, -SESSION_SUFFIX.length);
	let directory = path.dirname(path.resolve(statsPath));
	while (true) {
		if (path.basename(directory) === artifactsDirname) return `${directory}${SESSION_SUFFIX}`;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function sessionPathEncodesId(sessionPath: string, sessionId: string): boolean {
	const stem = path.basename(sessionPath, SESSION_SUFFIX);
	return stem === sessionId || stem.endsWith(`_${sessionId}`);
}

function managedHistoricalSessionPaths(
	header: SessionLineageHeader,
	currentSessionPath: string,
	sessionsRoot: string,
): string[] {
	const root = path.resolve(sessionsRoot);
	const filename = path.basename(currentSessionPath);
	const paths = new Set<string>();
	for (const previousSessionFile of header.previousSessionFiles) {
		if (!path.isAbsolute(previousSessionFile) || path.basename(previousSessionFile) !== filename) continue;
		const resolved = path.resolve(previousSessionFile);
		const relative = path.relative(root, resolved);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative) ||
			!resolved.endsWith(SESSION_SUFFIX)
		) {
			continue;
		}
		paths.add(resolved);
	}
	return [...paths];
}

function resolveLogicalSessionMatch(
	statsPath: string,
	nodes: StatsLineageNode[],
): { node: StatsLineageNode; logicalRoot: string } | undefined {
	const matches: Array<{ node: StatsLineageNode; logicalRoot: string }> = [];
	for (const node of nodes) {
		const logicalRoot = logicalSessionRootForStatsPath(statsPath, node.path);
		if (logicalRoot) matches.push({ node, logicalRoot });
	}
	const exact = matches.filter(match => path.resolve(match.logicalRoot) === path.resolve(match.node.path));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return undefined;

	const known = matches.filter(match =>
		[...match.node.statsPaths].some(statsPath => path.resolve(statsPath) === path.resolve(match.logicalRoot)),
	);
	if (known.length === 1) return known[0];
	if (known.length > 1) return undefined;

	const idMatches = matches.filter(match => sessionPathEncodesId(match.logicalRoot, match.node.id));
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Resolve retained peers through `parentSession`, which is historically either
 * a session id or an absolute path. Ambiguous aliases are deliberately left
 * unresolved so cleanup fails safe instead of transferring across sessions.
 */
function buildStatsCleanupPlans(
	archivedSessions: StatsSession[],
	retainedSessions: StatsSession[],
	dbPath: string,
): StatsCleanupContext {
	const archivedNodes: StatsLineageNode[] = archivedSessions.map(session => ({
		...session,
		statsPaths: new Set([session.path, ...session.historicalPaths]),
		identityKeys: statsIdentityKeys(session.identities),
	}));
	const retainedNodes: StatsLineageNode[] = retainedSessions.map(session => ({
		...session,
		statsPaths: new Set([session.path, ...session.historicalPaths]),
		identityKeys: statsIdentityKeys(session.identities),
	}));
	const nodes = [...archivedNodes, ...retainedNodes];

	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		for (const storedPath of collectStoredStatsSessionPaths(db)) {
			const match = resolveLogicalSessionMatch(storedPath, nodes);
			if (match) match.node.statsPaths.add(match.logicalRoot);
		}
	} finally {
		db.close();
	}

	for (const child of nodes) {
		if (
			!child.parentSession ||
			(!path.isAbsolute(child.parentSession) && !child.parentSession.endsWith(SESSION_SUFFIX))
		) {
			continue;
		}
		const match = resolveLogicalSessionMatch(child.parentSession, nodes);
		if (match) match.node.statsPaths.add(match.logicalRoot);
	}

	const archivedPathClaimCounts = new Map<string, number>();
	for (const archived of archivedNodes) {
		for (const statsPath of archived.statsPaths) {
			const key = path.resolve(statsPath);
			archivedPathClaimCounts.set(key, (archivedPathClaimCounts.get(key) ?? 0) + 1);
		}
	}
	const ambiguousArchivedPathKeys = new Set(
		[...archivedPathClaimCounts].filter(([, count]) => count > 1).map(([key]) => key),
	);

	const aliases = new Map<string, StatsLineageNode | null>();
	const identityKeysByNode = new Map<StatsLineageNode, Set<string>>();
	for (const node of nodes) {
		const keys = new Set([
			`id:${node.id}`,
			...[...node.statsPaths].map(statsPath => `path:${path.resolve(statsPath)}`),
		]);
		identityKeysByNode.set(node, keys);
		for (const key of keys) {
			if (!aliases.has(key)) {
				aliases.set(key, node);
			} else if (aliases.get(key) !== node) {
				aliases.set(key, null);
			}
		}
	}

	const incompleteLineage = new Set<StatsLineageNode>();
	const lineageKeysByNode = new Map<StatsLineageNode, Set<string>>();
	for (const node of nodes) {
		const lineageKeys = new Set(identityKeysByNode.get(node));
		let current: StatsLineageNode | null = node;
		const seen = new Set<StatsLineageNode>();
		while (current?.parentSession) {
			if (seen.has(current)) {
				incompleteLineage.add(node);
				break;
			}
			seen.add(current);
			const parentReference = current.parentSession;
			const parentKey =
				path.isAbsolute(parentReference) || parentReference.endsWith(SESSION_SUFFIX)
					? `path:${path.resolve(parentReference)}`
					: `id:${parentReference}`;
			lineageKeys.add(parentKey);
			const parent = aliases.get(parentKey);
			if (!parent) {
				incompleteLineage.add(node);
				break;
			}
			for (const key of identityKeysByNode.get(parent) ?? []) lineageKeys.add(key);
			current = parent;
		}
		lineageKeysByNode.set(node, lineageKeys);
	}

	const retainedPathKeys = new Set(
		retainedNodes.flatMap(retained => [...retained.statsPaths].map(statsPath => path.resolve(statsPath))),
	);
	const plans = archivedNodes.map(archived => {
		const archivedLineage = lineageKeysByNode.get(archived) ?? new Set<string>();
		return {
			sessionPaths: [...archived.statsPaths].filter(statsPath => {
				const key = path.resolve(statsPath);
				return !retainedPathKeys.has(key) && !ambiguousArchivedPathKeys.has(key);
			}),
			retainedSessions: retainedNodes.filter(retained => {
				if (incompleteLineage.has(retained)) return false;
				const retainedLineage = lineageKeysByNode.get(retained);
				return retainedLineage ? [...retainedLineage].some(key => archivedLineage.has(key)) : false;
			}),
			transfers: [],
			archivedIdentityKeys: archived.identityKeys,
			preserveAll: false,
		};
	});
	return {
		plans,
		incompleteRetainedSessions: retainedNodes.filter(retained => incompleteLineage.has(retained)),
	};
}

function addSessionStatsIdentity(line: string, identities: Record<StatsEntryTable, StatsEntryIdentity[]>): void {
	if (line.length === 0) return;
	try {
		const record: unknown = JSON.parse(line);
		if (
			!record ||
			typeof record !== "object" ||
			!("type" in record) ||
			record.type !== "message" ||
			!("id" in record) ||
			typeof record.id !== "string" ||
			record.id.length === 0 ||
			!("message" in record) ||
			!record.message ||
			typeof record.message !== "object"
		) {
			return;
		}
		const message = record.message;
		if (!("role" in message)) return;
		const parsedEntryTimestamp =
			"timestamp" in record && typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
		if (message.role === "user") {
			identities.user_messages.push({
				entryId: record.id,
				timestamp: Number.isFinite(parsedEntryTimestamp) ? parsedEntryTimestamp : 0,
				toolCallId: "",
			});
			return;
		}
		if (message.role !== "assistant") return;
		const timestamp =
			"timestamp" in message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
				? message.timestamp
				: Number.isFinite(parsedEntryTimestamp)
					? parsedEntryTimestamp
					: 0;
		identities.messages.push({ entryId: record.id, timestamp, toolCallId: "" });
		if (!("content" in message) || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "toolCall" &&
				"id" in block &&
				typeof block.id === "string"
			) {
				identities.tool_calls.push({ entryId: record.id, timestamp, toolCallId: block.id });
			}
		}
	} catch {
		// Stats parsing is also lenient: a malformed line cannot own a retained row.
	}
}

function collectSessionStatsIdentitiesFromText(text: string): Record<StatsEntryTable, StatsEntryIdentity[]> {
	const identities = createStatsIdentities();
	for (const line of text.split(/\r?\n/)) addSessionStatsIdentity(line, identities);
	return identities;
}

async function collectSessionStatsIdentities(
	sessionPath: string,
): Promise<Record<StatsEntryTable, StatsEntryIdentity[]>> {
	const identities = createStatsIdentities();
	const decoder = new TextDecoder();
	for await (const line of readLines(Bun.file(sessionPath).stream())) {
		addSessionStatsIdentity(decoder.decode(line), identities);
	}
	return identities;
}

async function populateStatsTransferTargets(context: StatsCleanupContext): Promise<void> {
	const identitiesBySession = new Map<string, Promise<Record<StatsEntryTable, StatsEntryIdentity[]>>>();
	const identitiesFor = (session: StatsLineageNode): Promise<Record<StatsEntryTable, StatsEntryIdentity[]>> => {
		let identities = identitiesBySession.get(session.path);
		if (!identities) {
			identities = collectSessionStatsIdentities(session.path);
			identitiesBySession.set(session.path, identities);
		}
		return identities;
	};

	const incompleteIdentityKeys = new Set<string>();
	let hasUnidentifiableIncompleteSession = false;
	for (const retained of context.incompleteRetainedSessions) {
		const keys = statsIdentityKeys(await identitiesFor(retained));
		if (keys.size === 0) hasUnidentifiableIncompleteSession = true;
		for (const key of keys) incompleteIdentityKeys.add(key);
	}

	for (const plan of context.plans) {
		if (context.incompleteRetainedSessions.length > 0) {
			plan.preserveAll =
				hasUnidentifiableIncompleteSession ||
				plan.archivedIdentityKeys.size === 0 ||
				[...plan.archivedIdentityKeys].some(key => incompleteIdentityKeys.has(key));
		}
		for (const retained of plan.retainedSessions) {
			plan.transfers.push({ path: retained.path, identities: await identitiesFor(retained) });
		}
	}
}

/**
 * Rekey copied entry rows to the newest retained lineage peer before pruning.
 * The retained file's own offset is never rewritten: it already describes that
 * file's byte position, while every archived historical offset is deleted.
 */
function reconcileStatsRowsForSessions(dbPath: string, plans: StatsCleanupPlan[]): number {
	if (plans.length === 0) return 0;
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		const sessionTables = STATS_SESSION_TABLES.filter(
			table => tableExists(db, table) && tableHasColumn(db, table, "session_file"),
		);
		const entryTables = STATS_ENTRY_TABLES.filter(
			table =>
				sessionTables.includes(table) &&
				STATS_IDENTITY_COLUMNS[table].every(column => tableHasColumn(db, table, column)),
		);

		db.run(`
			CREATE TEMP TABLE gc_retained_entries (
				table_name TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				tool_call_id TEXT NOT NULL,
				target_session_file TEXT NOT NULL,
				PRIMARY KEY (table_name, entry_id, timestamp, tool_call_id)
			)
		`);
		const clearRetainedEntries = db.prepare("DELETE FROM gc_retained_entries");
		const insertRetainedEntry = db.prepare(`
			INSERT OR IGNORE INTO gc_retained_entries (
				table_name, entry_id, timestamp, tool_call_id, target_session_file
			) VALUES (?, ?, ?, ?, ?)
		`);
		const transferStatements = entryTables.map(table => {
			const toolCallMatch =
				table === "tool_calls" ? `retained.tool_call_id = ${table}.tool_call_id` : "retained.tool_call_id = ''";
			const identityMatch = `
				retained.table_name = '${table}'
				AND retained.entry_id = ${table}.entry_id
				AND retained.timestamp = ${table}.timestamp
				AND ${toolCallMatch}
			`;
			return db.prepare(`
				UPDATE OR IGNORE ${table}
				SET session_file = (
					SELECT retained.target_session_file
					FROM gc_retained_entries AS retained
					WHERE ${identityMatch}
				)
				WHERE session_file = ?
					AND EXISTS (
						SELECT 1
						FROM gc_retained_entries AS retained
						WHERE ${identityMatch}
					)
			`);
		});
		const deletionStatements = sessionTables.map(table => ({
			table,
			statement: db.prepare(`DELETE FROM ${table} WHERE session_file = ? OR instr(session_file, ?) = 1`),
		}));
		let deleted = 0;
		const tx = db.transaction((cleanupPlans: StatsCleanupPlan[]) => {
			for (const plan of cleanupPlans) {
				if (plan.preserveAll) continue;
				clearRetainedEntries.run();
				for (const target of plan.transfers) {
					for (const table of entryTables) {
						for (const identity of target.identities[table]) {
							insertRetainedEntry.run(
								table,
								identity.entryId,
								identity.timestamp,
								identity.toolCallId,
								target.path,
							);
						}
					}
				}
				for (const sessionPath of new Set(plan.sessionPaths)) {
					for (const statement of transferStatements) statement.run(sessionPath);
				}
				for (const sessionPath of new Set(plan.sessionPaths)) {
					const nestedPrefix = `${sessionArtifactsPath(sessionPath)}${path.sep}`;
					for (const { table, statement } of deletionStatements) {
						const requiresTransfer =
							plan.retainedSessions.length > 0 &&
							table !== "file_offsets" &&
							!entryTables.some(entryTable => entryTable === table);
						if (requiresTransfer) continue;
						const result = statement.run(sessionPath, nestedPrefix) as SqliteRunResult;
						deleted += sqliteNumber(result.changes);
					}
				}
			}
		});
		tx(plans);
		return deleted;
	} finally {
		db.close();
	}
}

async function collectArchivedStatsSessions(
	archiveRoot: string,
	sessionsRoot: string,
	onError: (file: string, error: unknown) => void,
): Promise<StatsSession[]> {
	const sessions: StatsSession[] = [];
	for (const file of await collectCompressedJsonlFiles(archiveRoot)) {
		const relative = path.relative(archiveRoot, file);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		const sourcePath = path.join(sessionsRoot, relative.slice(0, -".gz".length));
		try {
			const text = await readTextIfPresent(file);
			const header = sessionLineageHeaderFromText(text);
			if (!header) throw new Error("archive is missing a valid session header");
			sessions.push({
				path: sourcePath,
				id: header.id,
				parentSession: header.parentSession,
				historicalPaths: managedHistoricalSessionPaths(header, sourcePath, sessionsRoot),
				identities: collectSessionStatsIdentitiesFromText(text),
			});
		} catch (error) {
			onError(file, error);
		}
	}
	return sessions;
}

async function cleanupStatsRowsForArchivedSessions(
	options: ResolvedGcOptions,
	archiveRoot: string,
	newlyArchivedSessions: SessionInfo[],
	result: ArchiveGcResult,
): Promise<void> {
	const dbPath =
		path.resolve(options.agentDir) === path.resolve(getAgentDir())
			? getStatsDbPath()
			: path.join(options.agentDir, "stats.db");
	if (!(await pathExists(dbPath))) return;
	const sessionsRoot = getSessionsDir(options.agentDir);

	const archivedByPath = new Map<string, StatsSession>();
	for (const session of newlyArchivedSessions) {
		archivedByPath.set(path.resolve(session.path), {
			path: session.path,
			id: session.id,
			parentSession: session.parentSessionPath,
			historicalPaths: [],
			identities: createStatsIdentities(),
		});
	}

	let retainedSessions: SessionInfo[];
	try {
		for (const session of await collectArchivedStatsSessions(archiveRoot, sessionsRoot, (file, error) => {
			result.errors.push(`stats cleanup scan ${file}: ${errorMessage(error)}`);
		})) {
			archivedByPath.set(path.resolve(session.path), session);
		}
	} catch (error) {
		result.errors.push(`stats cleanup scan: ${errorMessage(error)}`);
	}
	try {
		retainedSessions = await listActiveSessions(sessionsRoot);
	} catch (error) {
		result.errors.push(`stats cleanup scan: ${errorMessage(error)}`);
		return;
	}

	try {
		await withStatsSyncLock(dbPath, async () => {
			const retainedStatsSessions = await Promise.all(
				retainedSessions.map(async session => {
					const header = await readSessionLineageHeader(session.path);
					if (!header || header.id !== session.id) {
						throw new Error(`session header changed during stats cleanup: ${session.path}`);
					}
					return {
						path: session.path,
						id: session.id,
						parentSession: header.parentSession,
						historicalPaths: managedHistoricalSessionPaths(header, session.path, sessionsRoot),
						identities: createStatsIdentities(),
					};
				}),
			);
			const context = buildStatsCleanupPlans([...archivedByPath.values()], retainedStatsSessions, dbPath);
			await populateStatsTransferTargets(context);
			result.statsRowsDeleted = reconcileStatsRowsForSessions(dbPath, context.plans);
		});
	} catch (error) {
		result.errors.push(`stats cleanup: ${errorMessage(error)}`);
	}
}

async function runArchiveGc(options: ResolvedGcOptions, archiveRoot: string): Promise<ArchiveGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const sessions = await listActiveSessions(sessionsRoot);
	const cutoffMs = Date.now() - options.coldArchiveAfterDays * DAY_MS;
	const result: ArchiveGcResult = {
		scanned: sessions.length,
		skippedActive: 0,
		keptNewestGlobal: 0,
		keptNewestPerCwd: 0,
		wouldArchive: 0,
		archived: 0,
		historyRowsDeleted: 0,
		statsRowsDeleted: 0,
		ftsRebuilt: false,
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

	result.wouldArchive = candidates.length;
	if (!options.apply) return result;

	const archivedSessionIds: string[] = [];
	const archivedSessions: SessionInfo[] = [];
	for (const candidate of candidates) {
		try {
			await moveSessionWithArtifacts(candidate);
			result.archived += 1;
			archivedSessionIds.push(candidate.session.id);
			archivedSessions.push(candidate.session);
		} catch (error) {
			result.errors.push(`${candidate.session.path}: ${errorMessage(error)}`);
		}
	}

	await cleanupHistoryRowsForArchivedSessions(options, archiveRoot, archivedSessionIds, result);
	await cleanupStatsRowsForArchivedSessions(options, archiveRoot, archivedSessions, result);
	return result;
}

/**
 * Reunites sessions that live in more than one file: duplicate copies sharing a
 * session id, and forks that `/fork` wrote as separate sessions.
 *
 * Duplicates go first. A duplicate merge rewrites its destination, and that
 * destination can itself be some fork's parent, so the fork phase re-reads from
 * disk afterwards and grafts onto the reunited file rather than a stale copy.
 */
async function runSessionMergeGc(options: ResolvedGcOptions, archiveRoot: string): Promise<SessionMergeGcResult> {
	const result: SessionMergeGcResult = {
		scanned: 0,
		forkScanned: 0,
		duplicateGroups: 0,
		forkPairs: 0,
		skippedActive: 0,
		skipped: [],
		wouldMerge: 0,
		merged: 0,
		archivedSources: 0,
		addedEntries: 0,
		skippedEntries: 0,
		conflicts: [],
		candidates: [],
		errors: [],
		livenessDegraded: [],
	};
	const degraded = new Set<string>();
	await mergeDuplicatePhase(options, archiveRoot, result, degraded);
	await mergeForkPhase(options, archiveRoot, result);
	result.livenessDegraded = [...new Set([...result.livenessDegraded, ...degraded])];
	return result;
}

async function mergeDuplicatePhase(
	options: ResolvedGcOptions,
	archiveRoot: string,
	result: SessionMergeGcResult,
	degraded: Set<string>,
): Promise<void> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const groups = await collectDuplicateSessionGroups(sessionsRoot, result, degraded);
	result.duplicateGroups = groups.length;
	result.wouldMerge += groups.reduce((count, group) => count + group.sources.length, 0);
	result.candidates.push(
		...groups.map(group => ({
			kind: "duplicate" as const,
			sessionId: group.sessionId,
			destination: group.destination.path,
			sources: group.sources.map(source => source.path),
		})),
	);

	const storage = new FileSessionStorage();
	for (const group of groups) {
		let mergedEntries = group.destination.entries;
		for (const source of group.sources) {
			const plan = planSessionMerge(mergedEntries, source.entries);
			mergedEntries = plan.merged;
			result.addedEntries += plan.addedEntries;
			result.skippedEntries += plan.skippedEntries;
			result.conflicts.push(
				...plan.conflicts.map(conflict => ({
					sessionId: group.sessionId,
					...conflict,
				})),
			);
		}
		if (!options.apply) continue;

		try {
			const destinationContent = await Bun.file(group.destination.path).text();
			const backupTimestamp = new Date().toISOString().replaceAll(":", "-");
			await Bun.write(`${group.destination.path}.${backupTimestamp}.bak`, destinationContent);
			await storage.writeTextAtomic(
				group.destination.path,
				serializeMergedSession(destinationContent, mergedEntries),
			);
			result.merged += 1;
		} catch (error) {
			result.errors.push(`${group.destination.path}: ${errorMessage(error)}`);
			continue;
		}

		for (const source of group.sources) {
			try {
				await moveDuplicateSourceToArchive(source.path, sessionsRoot, archiveRoot);
				result.archivedSources += 1;
			} catch (error) {
				result.errors.push(`${source.path}: ${errorMessage(error)}`);
			}
		}
	}
}

async function mergeForkPhase(
	options: ResolvedGcOptions,
	archiveRoot: string,
	result: SessionMergeGcResult,
): Promise<void> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const pairs = await collectForkLineageGroups(sessionsRoot, result);
	result.forkPairs = pairs.length;
	result.wouldMerge += pairs.length;
	result.addedEntries += pairs.reduce((sum, pair) => sum + pair.plan.addedEntries, 0);
	result.skippedEntries += pairs.reduce((sum, pair) => sum + pair.plan.skippedEntries, 0);
	result.conflicts.push(
		...pairs.flatMap(pair => pair.plan.conflicts.map(conflict => ({ sessionId: pair.parent.id, ...conflict }))),
	);
	result.candidates.push(
		...pairs.map(pair => ({
			kind: "fork" as const,
			sessionId: pair.fork.id,
			parent: pair.parent.path,
			fork: pair.fork.path,
			sharedEntries: pair.sharedEntries,
			forkOnlyEntries: pair.forkOnlyEntries,
			attachmentPoints: pair.attachmentPoints,
		})),
	);
	if (!options.apply) return;

	const storage = new FileSessionStorage();
	for (const pair of pairs) {
		let parentContent: string;
		try {
			parentContent = await Bun.file(pair.parent.path).text();
			const backupTimestamp = new Date().toISOString().replaceAll(":", "-");
			await Bun.write(`${pair.parent.path}.${backupTimestamp}.bak`, parentContent);
			await storage.writeTextAtomic(pair.parent.path, serializeMergedSession(parentContent, pair.plan.merged));
		} catch (error) {
			result.errors.push(`${pair.parent.path}: ${errorMessage(error)}`);
			continue;
		}

		try {
			// A successfully consumed fork is archived, never unlinked: its session and
			// artifacts remain recoverable while no longer cluttering the active list.
			await moveDuplicateSourceToArchive(pair.fork.path, sessionsRoot, archiveRoot);
			result.archivedSources += 1;
			result.merged += 1;
		} catch (error) {
			try {
				await storage.writeTextAtomic(pair.parent.path, parentContent);
			} catch (rollbackError) {
				result.errors.push(
					`${pair.fork.path}: ${errorMessage(error)}; parent rollback failed: ${errorMessage(rollbackError)}`,
				);
				continue;
			}
			result.errors.push(`${pair.fork.path}: ${errorMessage(error)}`);
		}
	}
}

async function runEmptySessionGc(
	options: ResolvedGcOptions,
	archiveRoot: string,
	mode: "archive" | "delete",
): Promise<EmptySessionGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const result: EmptySessionGcResult = {
		scanned: 0,
		empty: 0,
		skippedActive: 0,
		wouldPrune: 0,
		archived: 0,
		deleted: 0,
		emptyDirs: 0,
		removedDirs: 0,
		candidates: [],
		skipped: [],
		errors: [],
		livenessDegraded: [],
	};
	const files = (await collectJsonlFiles(sessionsRoot)).filter(file => isTopLevelSessionFile(sessionsRoot, file));
	result.scanned = files.length;

	const storage = new FileSessionStorage();
	const degraded = new Set<string>();
	for (const file of files) {
		try {
			const liveness = await inspectGcLiveness(file, degraded);
			if (liveness.live) {
				result.skippedActive++;
				result.skipped.push({
					path: file,
					secondsSinceWrite: liveness.secondsSinceWrite,
					signals: liveness.signals,
					holders: liveness.holders,
				});
				continue;
			}
			if (mode === "delete" && liveness.degraded.length > 0) {
				result.skippedActive++;
				result.skipped.push({
					path: file,
					secondsSinceWrite: liveness.secondsSinceWrite,
					signals: liveness.signals,
					holders: liveness.holders,
					reason: "liveness checks degraded; refusing irreversible deletion",
				});
				continue;
			}
			const stat = await fs.stat(file);

			const entries = await loadEntriesFromFile(file, storage);
			const header = entries[0];
			if (header?.type !== "session") throw new Error("session header missing");
			const emptiness = inspectSessionEmptiness(entries);
			const reason = sessionPruneReason(emptiness);
			if (!reason) continue;

			result.empty++;
			result.candidates.push({
				path: file,
				sessionId: header.id,
				reason,
				userMessages: emptiness.userMessages,
				assistantMessages: emptiness.assistantMessages,
				assistantTextChars: emptiness.assistantTextChars,
				unfinishedAttempts: emptiness.unfinishedAttempts,
				bytes: stat.size,
			});
			result.wouldPrune++;
			if (!options.apply) continue;

			if (mode === "archive") {
				await moveDuplicateSourceToArchive(file, sessionsRoot, archiveRoot);
				result.archived++;
			} else {
				await fs.rm(sessionArtifactsPath(file), { recursive: true, force: true });
				await fs.unlink(file);
				result.deleted++;
			}
		} catch (error) {
			result.errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
	await sweepEmptySessionDirs(sessionsRoot, options.apply, result);
	result.livenessDegraded = [...degraded];
	return result;
}

/** True when `dir` holds no file anywhere beneath it — a tree of empty directories counts. */
async function holdsNoFiles(dir: string): Promise<boolean> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) return false;
		if (!(await holdsNoFiles(path.join(dir, entry.name)))) return false;
	}
	return true;
}

/**
 * Remove per-cwd session directories that hold nothing. Pruning a transcript
 * leaves its directory behind, and the directory is created eagerly when a
 * session starts — so one appears for every throwaway cwd a session ever ran
 * in, whether or not it produced a transcript. They are swept regardless of
 * which run emptied them, because the point is the litter that predates this
 * one.
 *
 * Safe against a session starting concurrently: transcripts are appended
 * through a long-lived descriptor, but `JsonlWriter`'s constructor re-creates
 * the parent directory before opening it, so a directory removed between a
 * session's eager mkdir and its first write comes back. A directory holding a
 * live session's transcript is never a candidate — it holds a file.
 */
async function sweepEmptySessionDirs(
	sessionsRoot: string,
	apply: boolean,
	result: EmptySessionGcResult,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
		result.errors.push(`${sessionsRoot}: ${errorMessage(error)}`);
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(sessionsRoot, entry.name);
		try {
			if (!(await holdsNoFiles(dir))) continue;
			result.emptyDirs++;
			if (!apply) continue;
			await fs.rm(dir, { recursive: true });
			result.removedDirs++;
		} catch (error) {
			result.errors.push(`${dir}: ${errorMessage(error)}`);
		}
	}
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
		const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as WalCheckpointRow | null;
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

function gcLockPid(lockText: string): number | undefined {
	const pid = Number.parseInt(lockText.split(/\r?\n/, 1)[0] ?? "", 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = codeOf(error);
		if (code === "ESRCH" || code === "EINVAL") return false;
		return true;
	}
}

function gcLockStatSnapshot(stat: {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}): Omit<GcLockSnapshot, "text"> {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
	};
}

function sameGcLockStat(left: Omit<GcLockSnapshot, "text">, right: Omit<GcLockSnapshot, "text">): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function readGcLockSnapshot(lockPath: string): Promise<GcLockSnapshot | null> {
	const stat = await statIfPresent(lockPath);
	if (!stat) return null;

	let lockText = "";
	try {
		lockText = await Bun.file(lockPath).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}

	const afterStat = await statIfPresent(lockPath);
	if (!afterStat) return null;
	const before = gcLockStatSnapshot(stat);
	const after = gcLockStatSnapshot(afterStat);
	if (!sameGcLockStat(before, after)) return null;
	return { ...after, text: lockText };
}

async function gcLockSnapshotStillCurrent(lockPath: string, snapshot: GcLockSnapshot): Promise<boolean> {
	const stat = await statIfPresent(lockPath);
	return stat ? sameGcLockStat(snapshot, gcLockStatSnapshot(stat)) : false;
}

function shouldBreakGcLock(snapshot: GcLockSnapshot): boolean {
	const pid = gcLockPid(snapshot.text);
	if (pid) return !processExists(pid);

	const createdAtMs = Date.parse(snapshot.text.split(/\r?\n/, 2)[1] ?? "");
	const ageFromMs = Number.isFinite(createdAtMs) ? createdAtMs : snapshot.mtimeMs;
	return Date.now() - ageFromMs > GC_WRITE_GRACE_MS;
}

async function removeStaleGcLock(lockPath: string): Promise<boolean> {
	const snapshot = await readGcLockSnapshot(lockPath);
	if (!snapshot) return false;
	if (!shouldBreakGcLock(snapshot)) return false;
	if (!(await gcLockSnapshotStillCurrent(lockPath, snapshot))) return false;
	try {
		await fs.unlink(lockPath);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

async function openNewGcLock(lockPath: string): Promise<fs.FileHandle | null> {
	try {
		return await fs.open(lockPath, "wx");
	} catch (error) {
		if (codeOf(error) === "EEXIST") return null;
		throw error;
	}
}

async function releaseGcLockFile(lockPath: string, handle: fs.FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch {
		// Best effort: stale sidecar locks are recoverable by PID/timestamp.
	}
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
	}
}

async function openGcBreakerLock(lockPath: string): Promise<{ path: string; handle: fs.FileHandle }> {
	const breakerPath = `${lockPath}${GC_LOCK_BREAKER_SUFFIX}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const handle = await openNewGcLock(breakerPath);
		if (handle) {
			try {
				await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
				return { path: breakerPath, handle };
			} catch (error) {
				await releaseGcLockFile(breakerPath, handle);
				throw error;
			}
		}
		if (!(await removeStaleGcLock(breakerPath))) throw new Error(`GC already running: ${lockPath}`);
	}
	throw new Error(`GC already running: ${lockPath}`);
}

async function openGcLock(lockPath: string): Promise<fs.FileHandle> {
	const direct = await openNewGcLock(lockPath);
	if (direct) return direct;

	const breaker = await openGcBreakerLock(lockPath);
	try {
		const raced = await openNewGcLock(lockPath);
		if (raced) return raced;
		if (!(await removeStaleGcLock(lockPath))) throw new Error(`GC already running: ${lockPath}`);
		const takeover = await openNewGcLock(lockPath);
		if (takeover) return takeover;
		throw new Error(`GC already running: ${lockPath}`);
	} finally {
		await releaseGcLockFile(breaker.path, breaker.handle);
	}
}

async function withGcLock<T>(agentDir: string, fn: (lockPath: string) => Promise<T>): Promise<T> {
	const lockPath = path.join(agentDir, "gc.lock");
	await fs.mkdir(agentDir, { recursive: true });
	const handle = await openGcLock(lockPath);
	let result: T | undefined;
	let runError: unknown;
	try {
		await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
		result = await fn(lockPath);
	} catch (error) {
		runError = error;
	}
	let closeError: unknown;
	try {
		await handle.close();
	} catch (error) {
		closeError = error;
	}
	let unlinkError: unknown;
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") unlinkError = error;
	}
	if (runError) throw runError;
	if (closeError) throw closeError;
	if (unlinkError) throw unlinkError;
	return result as T;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatLivenessHolder(holder: LivenessHolder): string {
	return `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}`;
}

function formatLivenessReason(signals: readonly LivenessSignal[], holders: readonly LivenessHolder[]): string {
	const owner = holders.length > 0 ? holders.map(formatLivenessHolder).join(", ") : "an unidentified process";
	const reasons: string[] = [];
	if (signals.includes("open-handle")) reasons.push(`held open by ${owner}`);
	if (signals.includes("advisory-lock")) reasons.push("advisory lock held");
	if (signals.includes("posix-lock")) reasons.push(`POSIX lock held by ${owner}`);
	return reasons.join("; ");
}

function renderText(result: GcResult, options: ResolvedGcOptions): string {
	const lines = [`GC ${result.apply ? "applied" : "dry-run"} (${result.agentDir})`];
	if (result.blobs) {
		lines.push(
			`blobs: ${result.blobs.deleted}/${result.blobs.wouldDelete} files, ${formatBytes(result.blobs.bytes)}, ${result.blobs.referenced} refs`,
		);
		if (result.blobs.errors.length > 0) lines.push(`blob errors: ${result.blobs.errors.length}`);
	}
	if (result.archive) {
		lines.push(
			`sessions: ${result.archive.archived}/${result.archive.wouldArchive} archived, ${result.archive.historyRowsDeleted} history rows and ${result.archive.statsRowsDeleted} stats rows removed`,
		);
		if (result.archive.skippedActive > 0) lines.push(`sessions skipped active: ${result.archive.skippedActive}`);
		if (result.archive.errors.length > 0) lines.push(`session errors: ${result.archive.errors.length}`);
	}
	if (result.mergeSessions) {
		const merge = result.mergeSessions;
		const duplicateCopies = merge.candidates.reduce(
			(sum, candidate) => (candidate.kind === "duplicate" ? sum + candidate.sources.length : sum),
			0,
		);
		const attachmentPoints = merge.candidates.reduce(
			(sum, candidate) => (candidate.kind === "fork" ? sum + candidate.attachmentPoints : sum),
			0,
		);
		const detail = [
			merge.duplicateGroups > 0
				? `${duplicateCopies} duplicate ${pluralize("copy", duplicateCopies)} of ${merge.duplicateGroups} ${pluralize("session", merge.duplicateGroups)}`
				: undefined,
			merge.forkPairs > 0
				? `${merge.forkPairs} ${pluralize("fork", merge.forkPairs)} at ${attachmentPoints} attachment ${pluralize("point", attachmentPoints)}`
				: undefined,
		].filter((part): part is string => part !== undefined);
		const breakdown = detail.length > 0 ? ` (${detail.join("; ")})` : "";
		const conflicts =
			merge.conflicts.length > 0
				? `, ${merge.conflicts.length} ${pluralize("conflict", merge.conflicts.length)} (destination kept)`
				: "";
		if (merge.wouldMerge === 0) {
			lines.push(`merge: nothing to reunite across ${merge.scanned} ${pluralize("session", merge.scanned)}`);
		} else {
			lines.push(
				result.apply
					? `merge: folded ${merge.archivedSources}/${merge.wouldMerge} ${pluralize("file", merge.wouldMerge)} into ${merge.merged} ${pluralize("session", merge.merged)}, ${merge.addedEntries} ${pluralize("entry", merge.addedEntries)} added${breakdown}; consumed files archived to ${shortenPath(getArchivedSessionsDir(options.agentDir))}${conflicts}`
					: `merge: would fold ${merge.wouldMerge} ${pluralize("file", merge.wouldMerge)} back into ${merge.wouldMerge === 1 ? "its session" : "their sessions"}, adding ${merge.addedEntries} ${pluralize("entry", merge.addedEntries)}${breakdown}${conflicts}`,
			);
		}
		for (const skipped of merge.skipped) {
			// Liveness skips name the holding process; discovery exclusions carry a reason
			// string instead, and there are hundreds of those on a real sessions tree.
			if (!skipped.signals || !skipped.holders) continue;
			lines.push(
				`merge skipped: ${shortenPath(skipped.path)} ${formatLivenessReason(skipped.signals, skipped.holders)}`,
			);
		}
		if (merge.errors.length > 0) lines.push(`merge errors: ${merge.errors.length}`);
	}
	if (result.pruneEmptySessions && options.pruneEmptySessions) {
		const empty = result.pruneEmptySessions;
		const mode = options.pruneEmptySessions;
		const pastTense = mode === "archive" ? "archived" : "deleted";
		const affected = mode === "archive" ? empty.archived : empty.deleted;
		const unasked = empty.candidates.filter(candidate => candidate.reason === "no-prompt").length;
		const unanswered = empty.candidates.length - unasked;
		const summary = result.apply
			? `prune: ${pastTense} ${affected} of ${empty.empty} dead ${pluralize("session", empty.empty)}`
			: `prune: would ${mode} ${empty.wouldPrune} of ${empty.empty} dead ${pluralize("session", empty.empty)}`;
		// Two reasons, reported apart: "nobody asked" is usually harness litter,
		// "nobody answered" is usually a prompt that died mid-flight. An operator
		// auditing a candidate list wants to know which pile it landed in.
		const breakdown = [
			unanswered > 0 ? `${unanswered} unanswered` : undefined,
			unasked > 0 ? `${unasked} nobody asked` : undefined,
		].filter(part => part !== undefined);
		lines.push(breakdown.length > 0 ? `${summary} (${breakdown.join(", ")})` : summary);
		// Silent on a clean store: an operator running this weekly should see a
		// line only when there was something to remove.
		if (empty.emptyDirs > 0) {
			const dirs = `${empty.emptyDirs} empty session ${pluralize("directory", empty.emptyDirs)}`;
			lines.push(result.apply ? `prune: removed ${empty.removedDirs} of ${dirs}` : `prune: would remove ${dirs}`);
		}
		for (const skipped of empty.skipped) {
			const reason = skipped.reason ?? formatLivenessReason(skipped.signals, skipped.holders);
			lines.push(`prune skipped: ${shortenPath(skipped.path)} ${reason}`);
		}
		if (empty.errors.length > 0) lines.push(`prune errors: ${empty.errors.length}`);
	}
	if (result.wal) {
		const state = result.wal.checkpointed ? "checkpointed" : "checkpoint dry-run";
		lines.push(`wal: ${state}, ${formatBytes(result.wal.walBytes)} across ${result.wal.databases.length} dbs`);
	}
	if (result.livenessDegraded.length > 0) {
		lines.push(`liveness checks degraded: ${result.livenessDegraded.join("; ")}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args.flags);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	const result = await withGcLock(options.agentDir, async lockPath => {
		const next: GcResult = {
			agentDir: options.agentDir,
			apply: options.apply,
			lockPath,
			livenessDegraded: [],
		};
		if (options.runBlobs) next.blobs = await runBlobGc(options, archiveRoot);
		if (options.runMergeSessions) next.mergeSessions = await runSessionMergeGc(options, archiveRoot);
		if (options.pruneEmptySessions) {
			next.pruneEmptySessions = await runEmptySessionGc(options, archiveRoot, options.pruneEmptySessions);
		}
		if (options.runArchive) next.archive = await runArchiveGc(options, archiveRoot);
		if (options.runWal) next.wal = await runWalGc(options);
		next.livenessDegraded = [
			...new Set([
				...(next.mergeSessions?.livenessDegraded ?? []),
				...(next.pruneEmptySessions?.livenessDegraded ?? []),
			]),
		];
		return next;
	});

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result, options);
	process.stdout.write(output);
	return result;
}
