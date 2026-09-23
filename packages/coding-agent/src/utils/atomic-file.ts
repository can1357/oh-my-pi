import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEexist, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";

/** Write a private file through a synced sibling before publishing it. */
export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.promises.open(tempPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await replaceFileAtomically(tempPath, filePath);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.promises.rm(tempPath, { force: true });
	}
}

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.promises.rename(tempPath, targetPath);
		return;
	} catch (error) {
		if (!hasFsCode(error, "EPERM") && !isEexist(error)) throw error;
		await replaceAfterWindowsRenameFailure(tempPath, targetPath, error);
	}
}

async function replaceAfterWindowsRenameFailure(
	tempPath: string,
	targetPath: string,
	renameError: unknown,
): Promise<void> {
	const backupPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.bak`;
	try {
		await fs.promises.rename(targetPath, backupPath);
	} catch (error) {
		if (isEnoent(error)) {
			await fs.promises.rename(tempPath, targetPath);
			return;
		}
		throw renameError;
	}

	try {
		await fs.promises.rename(tempPath, targetPath);
	} catch (replaceError) {
		try {
			await fs.promises.rename(backupPath, targetPath);
		} catch (rollbackError) {
			throw new Error(
				`Failed to replace file after ${toError(renameError).message} (retry: ${
					toError(replaceError).message
				}; rollback: ${toError(rollbackError).message})`,
				{ cause: toError(renameError) },
			);
		}
		throw replaceError;
	}

	try {
		await fs.promises.rm(backupPath);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to remove atomic replacement backup", {
				path: targetPath,
				backupPath,
				error: toError(error).message,
			});
		}
	}
}

/**
 * Move a live file across devices without exposing a partial destination.
 * The source remains authoritative while the copy is staged. Publication and
 * source removal are synchronous so in-process writers cannot land between them.
 */
export async function moveFileAcrossDevices(source: string, destination: string): Promise<void> {
	const staging = `${destination}.${process.pid}.${crypto.randomUUID()}.move`;
	try {
		for (;;) {
			const before = fs.statSync(source, { bigint: true });
			await fs.promises.copyFile(source, staging);
			const after = fs.statSync(source, { bigint: true });
			if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) continue;
			// Flush the completed copy before making it discoverable. Neither the
			// temporary copy nor an existing destination is ever a live write target.
			const fd = fs.openSync(staging, "r+");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.linkSync(staging, destination);
			try {
				fs.unlinkSync(source);
			} catch (error) {
				fs.unlinkSync(destination);
				throw error;
			}
			return;
		}
	} finally {
		await fs.promises.unlink(staging).catch(error => {
			if (!isEnoent(error))
				logger.warn("Failed to remove staged move copy", { staging, error: toError(error).message });
		});
	}
}
