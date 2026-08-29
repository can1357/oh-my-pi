import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { type FileLockOptions, withFileLock } from "../config/file-lock";

const TRANSFORMERS_TEMP_FILE_RE = /\.tmp\.(\d+)\.[A-Za-z0-9-]+$/;
const DEFAULT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_LOCK_OPTIONS = {
	staleMs: 30 * 60 * 1000,
	retries: 7_200,
	retryDelayMs: 250,
	staleWhileOwnerAlive: false,
} satisfies FileLockOptions;

export interface TinyModelTempPruneResult {
	removedFiles: number;
	reclaimedBytes: number;
	failedFiles: number;
	skippedActiveFiles: number;
}

export interface TinyModelTempPruneOptions {
	maxOrphanAgeMs?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
}

export interface TinyModelTempSnapshotEntry {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

export type TinyModelTempSnapshot = ReadonlyMap<string, TinyModelTempSnapshotEntry>;

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

function resolveRepoCacheDir(cacheDir: string, repo: string): string {
	const root = path.resolve(cacheDir);
	const repoDir = path.resolve(root, repo);
	if (repoDir === root || !repoDir.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Tiny-model repository escapes its cache root: ${repo}`);
	}
	return repoDir;
}

function lockTarget(cacheDir: string, repo: string): string {
	const safeRepo = repo.replaceAll(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.resolve(cacheDir), ".ompk-download-locks", safeRepo);
}

function snapshotEntry(stats: Stats): TinyModelTempSnapshotEntry {
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	};
}

function matchesSnapshot(stats: Stats, snapshot: TinyModelTempSnapshotEntry): boolean {
	return (
		stats.dev === snapshot.dev &&
		stats.ino === snapshot.ino &&
		stats.size === snapshot.size &&
		stats.mtimeMs === snapshot.mtimeMs &&
		stats.ctimeMs === snapshot.ctimeMs
	);
}

/** Capture one process's partials so a failed retry only removes files it touched. */
export async function captureTinyModelTempSnapshot(
	cacheDir: string,
	repo: string,
	ownerPid = process.pid,
): Promise<TinyModelTempSnapshot> {
	const repoDir = resolveRepoCacheDir(cacheDir, repo);
	const snapshot = new Map<string, TinyModelTempSnapshotEntry>();
	await fs.mkdir(repoDir, { recursive: true });
	const candidates = new Bun.Glob("**/*.tmp.*").scan({
		cwd: repoDir,
		dot: true,
		onlyFiles: true,
		followSymlinks: false,
	});
	for await (const relativePath of candidates) {
		const match = TRANSFORMERS_TEMP_FILE_RE.exec(path.basename(relativePath));
		if (!match || Number.parseInt(match[1]!, 10) !== ownerPid) continue;
		const candidate = path.resolve(repoDir, relativePath);
		if (!candidate.startsWith(`${repoDir}${path.sep}`)) continue;
		try {
			const stats = await fs.lstat(candidate);
			if (stats.isFile() && !stats.isSymbolicLink()) snapshot.set(relativePath, snapshotEntry(stats));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return snapshot;
}

/** Remove only current-owner partials created or changed during one failed attempt. */
export async function pruneTinyModelAttemptTemps(
	cacheDir: string,
	repo: string,
	before: TinyModelTempSnapshot,
	ownerPid = process.pid,
): Promise<TinyModelTempPruneResult> {
	const repoDir = resolveRepoCacheDir(cacheDir, repo);
	const result: TinyModelTempPruneResult = {
		removedFiles: 0,
		reclaimedBytes: 0,
		failedFiles: 0,
		skippedActiveFiles: 0,
	};
	await fs.mkdir(repoDir, { recursive: true });
	const candidates = new Bun.Glob("**/*.tmp.*").scan({
		cwd: repoDir,
		dot: true,
		onlyFiles: true,
		followSymlinks: false,
	});
	for await (const relativePath of candidates) {
		const match = TRANSFORMERS_TEMP_FILE_RE.exec(path.basename(relativePath));
		if (!match || Number.parseInt(match[1]!, 10) !== ownerPid) continue;
		const candidate = path.resolve(repoDir, relativePath);
		if (!candidate.startsWith(`${repoDir}${path.sep}`)) continue;

		let stats: Stats;
		try {
			stats = await fs.lstat(candidate);
		} catch (error) {
			if (isEnoent(error)) continue;
			result.failedFiles += 1;
			continue;
		}
		if (!stats.isFile() || stats.isSymbolicLink()) continue;
		const previous = before.get(relativePath);
		if (previous && matchesSnapshot(stats, previous)) {
			result.skippedActiveFiles += 1;
			continue;
		}

		try {
			await removeWithRetries(candidate);
			result.removedFiles += 1;
			result.reclaimedBytes += stats.size;
		} catch (error) {
			if (!isEnoent(error)) result.failedFiles += 1;
		}
	}
	return result;
}

/**
 * Delete Transformers.js PID-tagged partial downloads only when their owner is
 * gone or the partial is old enough that it cannot be a legitimate download.
 * Completed cache entries and unrecognized files are never touched.
 */
export async function pruneAbandonedTinyModelTemps(
	cacheDir: string,
	repo: string,
	options: TinyModelTempPruneOptions = {},
): Promise<TinyModelTempPruneResult> {
	const repoDir = resolveRepoCacheDir(cacheDir, repo);
	const maxOrphanAgeMs = options.maxOrphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
	const now = options.now ?? Date.now;
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const result: TinyModelTempPruneResult = {
		removedFiles: 0,
		reclaimedBytes: 0,
		failedFiles: 0,
		skippedActiveFiles: 0,
	};

	await fs.mkdir(repoDir, { recursive: true });
	const candidates = new Bun.Glob("**/*.tmp.*").scan({
		cwd: repoDir,
		dot: true,
		onlyFiles: true,
		followSymlinks: false,
	});
	for await (const relativePath of candidates) {
		const match = TRANSFORMERS_TEMP_FILE_RE.exec(path.basename(relativePath));
		if (!match) continue;
		const ownerPid = Number.parseInt(match[1]!, 10);
		const candidate = path.resolve(repoDir, relativePath);
		if (!candidate.startsWith(`${repoDir}${path.sep}`)) continue;

		let stats: Stats;
		try {
			stats = await fs.lstat(candidate);
		} catch (error) {
			if (isEnoent(error)) continue;
			result.failedFiles += 1;
			continue;
		}
		if (!stats.isFile() || stats.isSymbolicLink()) continue;

		const validOwnerPid = Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid <= 2_147_483_647;
		if (validOwnerPid && isProcessAlive(ownerPid)) {
			result.skippedActiveFiles += 1;
			continue;
		}
		if (!validOwnerPid && now() - stats.mtimeMs < maxOrphanAgeMs) continue;

		try {
			await removeWithRetries(candidate);
			result.removedFiles += 1;
			result.reclaimedBytes += stats.size;
		} catch (error) {
			if (!isEnoent(error)) result.failedFiles += 1;
		}
	}
	return result;
}

/** Serialize one repository's Transformers.js cache fill across OMPK workers. */
export async function withTinyModelDownloadLock<T>(
	cacheDir: string,
	repo: string,
	operation: () => Promise<T>,
	options: FileLockOptions = DEFAULT_MODEL_LOCK_OPTIONS,
): Promise<T> {
	resolveRepoCacheDir(cacheDir, repo);
	const target = lockTarget(cacheDir, repo);
	await fs.mkdir(path.dirname(target), { recursive: true });
	return await withFileLock(target, operation, options);
}
