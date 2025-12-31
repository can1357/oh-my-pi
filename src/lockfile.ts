import { existsSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GLOBAL_LOCK_FILE, PROJECT_PLUGINS_LOCK } from "@omp/paths";
import chalk from "chalk";

/**
 * Lock file schema version
 */
export const LOCKFILE_VERSION = 1;

/**
 * Package entry in the lock file
 */
export interface LockFilePackage {
	version: string;
	resolved?: string;
	integrity?: string;
	dependencies?: Record<string, string>;
}

/**
 * Lock file structure
 */
export interface LockFile {
	lockfileVersion: number;
	packages: Record<string, LockFilePackage>;
}

/**
 * Load and validate a lock file.
 *
 * Returns null if:
 * - File doesn't exist
 * - File contains invalid JSON (corrupted)
 * - File has invalid/incompatible schema
 */
export async function loadLockFile(global = true): Promise<LockFile | null> {
	const path = global ? GLOBAL_LOCK_FILE : PROJECT_PLUGINS_LOCK;
	try {
		if (!existsSync(path)) return null;
		const data = await readFile(path, "utf-8");
		const parsed = JSON.parse(data);

		// Validate schema
		if (typeof parsed.lockfileVersion !== "number" || typeof parsed.packages !== "object") {
			console.log(chalk.yellow(`Warning: ${path} has invalid schema, ignoring`));
			return null;
		}

		// Check for incompatible version
		if (parsed.lockfileVersion > LOCKFILE_VERSION) {
			console.log(
				chalk.yellow(
					`Warning: ${path} was created by a newer version of omp (lockfile v${parsed.lockfileVersion}), ignoring`,
				),
			);
			return null;
		}

		return parsed as LockFile;
	} catch (err) {
		if ((err as Error).name === "SyntaxError") {
			console.log(chalk.yellow(`Warning: ${path} is corrupted (invalid JSON), ignoring`));
		}
		return null;
	}
}

/**
 * Acquire an advisory lock for lockfile operations.
 * Uses exclusive file creation (wx flag) for atomicity.
 */
async function acquireLockfileLock(lockfilePath: string): Promise<void> {
	const advisoryLockPath = `${lockfilePath}.lock`;
	const maxAttempts = 50;
	const retryDelayMs = 100;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			// Attempt exclusive creation - fails if file exists
			const handle = await open(advisoryLockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
			await handle.close();
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				// Lock exists, check if stale (older than 30 seconds)
				try {
					const content = await readFile(advisoryLockPath, "utf-8");
					const { timestamp } = JSON.parse(content);
					if (Date.now() - timestamp > 30000) {
						// Stale lock, remove and retry
						await unlink(advisoryLockPath).catch(() => {});
						continue;
					}
				} catch {
					// Corrupted lock file, remove and retry
					await unlink(advisoryLockPath).catch(() => {});
					continue;
				}
				// Wait and retry
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Failed to acquire lockfile lock after ${maxAttempts} attempts`);
}

/**
 * Release the advisory lock for lockfile operations.
 */
async function releaseLockfileLock(lockfilePath: string): Promise<void> {
	const advisoryLockPath = `${lockfilePath}.lock`;
	await unlink(advisoryLockPath).catch(() => {});
}

/**
 * Save lock file atomically using temp-file-plus-rename pattern.
 * This ensures the lockfile is never left in a partially-written state.
 */
export async function saveLockFile(lockFile: LockFile, global = true): Promise<void> {
	const path = global ? GLOBAL_LOCK_FILE : PROJECT_PLUGINS_LOCK;
	const tempPath = join(dirname(path), `.omp-lockfile-${process.pid}-${Date.now()}.tmp`);

	// Write to temp file first
	const handle = await open(tempPath, "w");
	try {
		await handle.writeFile(JSON.stringify(lockFile, null, 2));
		await handle.sync(); // Ensure data is flushed to disk
		await handle.close();

		// Atomic rename to replace original
		await rename(tempPath, path);
	} catch (err) {
		await handle.close().catch(() => {});
		await unlink(tempPath).catch(() => {});
		throw err;
	}
}

/**
 * Create a new empty lock file
 */
export function createLockFile(): LockFile {
	return {
		lockfileVersion: LOCKFILE_VERSION,
		packages: {},
	};
}

/**
 * Validate and optionally regenerate a corrupted lock file.
 *
 * @returns The loaded lock file, a new empty lock file if corrupted/missing, or null if validation fails
 */
export async function validateOrRegenerateLockFile(global = true): Promise<LockFile> {
	const existing = await loadLockFile(global);
	if (existing) {
		return existing;
	}

	// Lock file is missing or corrupted - create a fresh one
	const path = global ? GLOBAL_LOCK_FILE : PROJECT_PLUGINS_LOCK;
	if (existsSync(path)) {
		console.log(chalk.yellow(`Regenerating corrupted lock file: ${path}`));
	}

	return createLockFile();
}

/**
 * Get the locked version for a package, if it exists in the lock file.
 */
export async function getLockedVersion(packageName: string, global = true): Promise<string | null> {
	const lockFile = await loadLockFile(global);
	if (!lockFile) return null;

	const entry = lockFile.packages[packageName];
	return entry?.version ?? null;
}

/**
 * Metadata for a locked package entry
 */
export interface LockFileUpdateData {
	version: string;
	resolved?: string;
	integrity?: string;
	dependencies?: Record<string, string>;
}

/**
 * Update the lock file with a package's exact version and integrity data.
 * Uses advisory locking to prevent concurrent read-modify-write corruption.
 */
export async function updateLockFile(
	packageName: string,
	data: string | LockFileUpdateData,
	global = true,
): Promise<void> {
	const lockfilePath = global ? GLOBAL_LOCK_FILE : PROJECT_PLUGINS_LOCK;

	// Normalize string version to full data object
	const entry: LockFilePackage =
		typeof data === "string"
			? { version: data }
			: {
					version: data.version,
					...(data.resolved && { resolved: data.resolved }),
					...(data.integrity && { integrity: data.integrity }),
					...(data.dependencies && { dependencies: data.dependencies }),
				};

	await acquireLockfileLock(lockfilePath);
	try {
		let lockFile = await loadLockFile(global);
		if (!lockFile) {
			lockFile = createLockFile();
		}

		lockFile.packages[packageName] = entry;

		await saveLockFile(lockFile, global);
	} finally {
		await releaseLockfileLock(lockfilePath);
	}
}

/**
 * Get a locked package entry, if it exists in the lock file.
 */
export async function getLockedPackage(packageName: string, global = true): Promise<LockFilePackage | null> {
	const lockFile = await loadLockFile(global);
	if (!lockFile) return null;
	return lockFile.packages[packageName] ?? null;
}

/**
 * Verify that a package's integrity matches the lockfile entry.
 * Returns true if integrity matches or if no integrity is recorded.
 * Returns false if integrity is recorded but doesn't match.
 */
export function verifyIntegrity(expected: string | undefined, actual: string | undefined): boolean {
	if (!expected) {
		// No integrity recorded in lockfile - can't verify but don't fail
		return true;
	}
	if (!actual) {
		// Integrity expected but not provided - verification failed
		return false;
	}
	return expected === actual;
}
