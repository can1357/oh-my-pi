import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getAgentDir, getBlobsDir, getHistoryDbPath, getModelDbPath, getSessionsDir } from "@pk-nerdsaver-ai/pi-utils";
import { Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { listSessionsReadOnly, type SessionInfo, type SessionStatus } from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";

const HASH_RE = /^[a-f0-9]{64}$/;
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
	const selected = flags.blobs === true || flags.archive === true || flags.wal === true;
	const settings =
		flags.apply === true ? await Settings.loadIsolated({ agentDir }) : await Settings.loadReadOnly({ agentDir });
	const getBoolean = (pathKey: "gc.blobs" | "gc.archive" | "gc.wal") => settings.get(pathKey);
	const getNumber = (pathKey: "gc.coldArchiveAfterDays" | "gc.retainNewestGlobal" | "gc.retainNewestPerCwd") =>
		settings.get(pathKey);
	return {
		apply: flags.apply === true,
		json: flags.json === true,
		agentDir,
		runBlobs: selected ? flags.blobs === true : getBoolean("gc.blobs"),
		runArchive: selected ? flags.archive === true : getBoolean("gc.archive"),
		runWal: selected ? flags.wal === true : getBoolean("gc.wal"),
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
				if (hash && HASH_RE.test(hash)) hashes.add(hash);
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

function sessionIdFromSessionPath(sessionPath: string): string | undefined {
	const basename = path.basename(sessionPath);
	if (basename.endsWith(COMPRESSED_SESSION_SUFFIX)) {
		const id = basename.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
		return id || undefined;
	}
	if (basename.endsWith(SESSION_SUFFIX)) {
		const id = basename.slice(0, -SESSION_SUFFIX.length);
		return id || undefined;
	}
	return undefined;
}

function sessionIdFromSessionText(text: string): string | undefined {
	const line = text
		.split(/\r?\n/)
		.find(candidate => candidate.trim().length > 0)
		?.trim();
	if (!line) return undefined;
	try {
		const record = JSON.parse(line) as { type?: unknown; id?: unknown };
		return record.type === "session" && typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
	} catch {
		return undefined;
	}
}

async function archivedSessionIdFromFile(file: string): Promise<string | undefined> {
	return sessionIdFromSessionText(await readTextIfPresent(file)) ?? sessionIdFromSessionPath(file);
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
		const id = await archivedSessionIdFromFile(file);
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
	for (const candidate of candidates) {
		try {
			await moveSessionWithArtifacts(candidate);
			result.archived += 1;
			archivedSessionIds.push(candidate.session.id);
		} catch (error) {
			result.errors.push(`${candidate.session.path}: ${errorMessage(error)}`);
		}
	}

	await cleanupHistoryRowsForArchivedSessions(options, archiveRoot, archivedSessionIds, result);
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
			`sessions: ${result.archive.archived}/${result.archive.wouldArchive} archived, ${result.archive.historyRowsDeleted} history rows removed`,
		);
		if (result.archive.skippedActive > 0) lines.push(`sessions skipped active: ${result.archive.skippedActive}`);
		if (result.archive.errors.length > 0) lines.push(`session errors: ${result.archive.errors.length}`);
	}
	if (result.wal) {
		const state = result.wal.checkpointed ? "checkpointed" : "checkpoint dry-run";
		lines.push(`wal: ${state}, ${formatBytes(result.wal.walBytes)} across ${result.wal.databases.length} dbs`);
	}
	return `${lines.join("\n")}\n`;
}

export async function runGcCommand(args: GcCommandArgs): Promise<GcResult> {
	const options = await resolveOptions(args.flags);
	const archiveRoot = getArchivedSessionsDir(options.agentDir);
	const result = await withGcLock(options.agentDir, async lockPath => {
		const next: GcResult = { agentDir: options.agentDir, apply: options.apply, lockPath };
		if (options.runBlobs) next.blobs = await runBlobGc(options, archiveRoot);
		if (options.runArchive) next.archive = await runArchiveGc(options, archiveRoot);
		if (options.runWal) next.wal = await runWalGc(options);
		return next;
	});

	const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result);
	process.stdout.write(output);
	return result;
}
