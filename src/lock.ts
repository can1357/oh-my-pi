import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProjectPiDir, PI_CONFIG_DIR } from "@omp/paths";

const LOCK_TIMEOUT_MS = 60000; // 1 minute

function getLockPath(global: boolean): string {
	return global ? join(PI_CONFIG_DIR, ".lock") : join(getProjectPiDir(), ".lock");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // Signal 0 = check existence
		return true;
	} catch {
		return false;
	}
}

async function tryCleanStaleLock(lockPath: string): Promise<boolean> {
	try {
		const content = await readFile(lockPath, "utf-8");
		const { pid, timestamp } = JSON.parse(content);

		const isStale = Date.now() - timestamp > LOCK_TIMEOUT_MS;
		const isDeadProcess = !isProcessAlive(pid);

		if (isStale || isDeadProcess) {
			await rm(lockPath, { force: true });
			return true;
		}
		return false;
	} catch {
		// File doesn't exist or is malformed - consider it cleaned
		return true;
	}
}

export async function acquireLock(global = true): Promise<boolean> {
	const lockPath = getLockPath(global);

	try {
		await mkdir(dirname(lockPath), { recursive: true });

		const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() });

		// Atomic exclusive creation - fails if file already exists
		await writeFile(lockPath, lockContent, { flag: "wx" });
		return true;
	} catch (err: unknown) {
		// EEXIST means file already exists - check if it's stale
		if (err instanceof Error && "code" in err && err.code === "EEXIST") {
			const cleaned = await tryCleanStaleLock(lockPath);
			if (cleaned) {
				// Retry atomic creation after cleaning stale lock
				try {
					const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
					await writeFile(lockPath, lockContent, { flag: "wx" });
					return true;
				} catch {
					return false;
				}
			}
		}
		return false;
	}
}

export async function releaseLock(global = true): Promise<void> {
	const lockPath = getLockPath(global);

	try {
		// Validate PID ownership before releasing
		const content = await readFile(lockPath, "utf-8");
		const { pid } = JSON.parse(content);

		if (pid !== process.pid) {
			// Lock is owned by another process - do not release
			return;
		}

		await rm(lockPath, { force: true });
	} catch {
		// Lock file doesn't exist or is malformed - nothing to release
	}
}
