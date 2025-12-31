import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
 * Save lock file
 */
export async function saveLockFile(lockFile: LockFile, global = true): Promise<void> {
	const path = global ? GLOBAL_LOCK_FILE : PROJECT_PLUGINS_LOCK;
	await writeFile(path, JSON.stringify(lockFile, null, 2));
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
 * Update the lock file with a package's exact version.
 */
export async function updateLockFile(packageName: string, version: string, global = true): Promise<void> {
	let lockFile = await loadLockFile(global);
	if (!lockFile) {
		lockFile = createLockFile();
	}

	lockFile.packages[packageName] = {
		version,
	};

	await saveLockFile(lockFile, global);
}
