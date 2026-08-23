import { Database } from "bun:sqlite";
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
	readLines,
} from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { BLOB_HASH_RE } from "../session/blob-store";
import { listSessionsReadOnly, type SessionInfo, type SessionStatus } from "../session/session-listing";
import { isProcessAlive, readSessionOwnerPids, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

const BLOB_FILE_RE = /^([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
const JSONL_GLOB = new Bun.Glob("**/*.jsonl");
const JSONL_GZ_GLOB = new Bun.Glob("**/*.jsonl.gz");
const JSONL_BACKUP_GLOB = new Bun.Glob("**/*.jsonl.*.bak");
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["pending", "interrupted", "unknown"]);
const DAY_MS = 86_400_000;
const GC_WRITE_GRACE_MS = 5 * 60_000;
const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
const GC_LOCK_BREAKER_SUFFIX = ".break";

export interface GcCommandFlags {
	apply?: boolean;
	json?: boolean;
	agentDir?: string;
	blobs?: boolean;
	archive?: boolean;
	wal?: boolean;
	undoTails?: boolean;
	keepUndoTails?: number;
	coldArchiveAfterDays?: number;
	retainNewestGlobal?: number;
	retainNewestPerCwd?: number;
}

export interface GcCommandArgs {
	flags: GcCommandFlags;
}

export interface UndoTailGcResult {
	/** Sessions skipped because a live owner process holds the append writer. */
	skippedLive: number;
	filesScanned: number;
	markersPruned: number;
	entriesRemoved: number;
	keep: number;
	files: Array<{ file: string; markers: number; removed: number }>;
	errors: string[];
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

export interface GcResult {
	agentDir: string;
	apply: boolean;
	blobs?: BlobGcResult;
	archive?: ArchiveGcResult;
	wal?: WalGcResult;
	undoTails?: UndoTailGcResult;
	lockPath: string;
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

interface ResolvedGcOptions {
	apply: boolean;
	json: boolean;
	agentDir: string;
	runBlobs: boolean;
	runArchive: boolean;
	runWal: boolean;
	runUndoTails: boolean;
	keepUndoTails: number;
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
	const selected = flags.blobs === true || flags.archive === true || flags.wal === true || flags.undoTails === true;
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
		runUndoTails: selected ? flags.undoTails === true : false,
		keepUndoTails: Math.max(0, flags.keepUndoTails ?? 1),
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
		...(result.undoTails?.errors ?? []).map(error => `undo-tails: ${error}`),
	];
}

function getArchivedSessionsDir(agentDir: string): string {
	return path.join(path.dirname(getSessionsDir(agentDir)), "archive", "sessions");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	if (pid) return !isProcessAlive(pid);

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

function renderText(result: GcResult): string {
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
	if (result.undoTails) {
		const t = result.undoTails;
		lines.push(
			`undo tails: ${t.markersPruned} markers pruned, ${t.entriesRemoved} entries removed, keep=${t.keep}, ${t.filesScanned} files scanned`,
		);
		if (t.skippedLive) lines.push(`sessions skipped live: ${t.skippedLive}`);
		if (t.errors.length > 0) lines.push(`undo tail errors: ${t.errors.length}`);
	}
	if (result.wal) {
		const state = result.wal.checkpointed ? "checkpointed" : "checkpoint dry-run";
		lines.push(`wal: ${state}, ${formatBytes(result.wal.walBytes)} across ${result.wal.databases.length} dbs`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Prune off-branch tails of older user-undo branches across active sessions.
 * Sessions with any live owner process (append-writer pid sidecar) are
 * skipped: an open AgentSession holds those entries in memory and would
 * re-append them.
 */
async function runUndoTailGc(options: ResolvedGcOptions): Promise<UndoTailGcResult> {
	const sessionsRoot = getSessionsDir(options.agentDir);
	const result: UndoTailGcResult = {
		filesScanned: 0,
		markersPruned: 0,
		entriesRemoved: 0,
		skippedLive: 0,
		keep: options.keepUndoTails,
		files: [],
		errors: [],
	};
	const candidates = await listActiveSessions(sessionsRoot);
	for (const session of candidates) {
		// Liveness gate via the owner sidecar: a live process holding this
		// session's append writer would re-append pruned entries from its
		// in-memory tree. SessionStatus is journal-tail state ("complete"
		// means the last turn yielded, not that nobody has it open), so it is
		// deliberately not used here.
		const ownerPids = readSessionOwnerPids(session.path);
		if (ownerPids.some(pid => isProcessAlive(pid))) {
			result.skippedLive++;
			continue;
		}
		result.filesScanned++;
		try {
			// suppressBreadcrumb keeps storage maintenance side-effect-free:
			// otherwise scanning repoints this terminal's --continue target
			// at whichever session happened to be read last. apply=false
			// returns before any rewrite, so dry runs never write the file.
			const manager = await SessionManager.open(session.path, undefined, undefined, { suppressBreadcrumb: true });
			try {
				const counts = await manager.pruneUserUndoTails(options.keepUndoTails, options.apply);
				result.markersPruned += counts.markers;
				result.entriesRemoved += counts.removed;
				if (counts.markers > 0) result.files.push({ file: session.path, ...counts });
			} finally {
				await manager.close();
			}
		} catch (error) {
			result.errors.push(`${session.path}: ${errorMessage(error)}`);
		}
	}
	return result;
}

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args.flags);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	const result = await withGcLock(options.agentDir, async lockPath => {
		const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath };
		if (options.runBlobs) next.blobs = await runBlobGc(options, archiveRoot);
		if (options.runArchive) next.archive = await runArchiveGc(options, archiveRoot);
		if (options.runWal) next.wal = await runWalGc(options);
		if (options.runUndoTails) next.undoTails = await runUndoTailGc(options);
		return next;
	});

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
	process.stdout.write(output);
	return result;
}
