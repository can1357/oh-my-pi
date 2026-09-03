import * as fs from "node:fs/promises";
import { hasFsCode, isEexist, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.rename(tempPath, targetPath);
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
		await fs.rename(targetPath, backupPath);
	} catch (error) {
		if (isEnoent(error)) {
			await fs.rename(tempPath, targetPath);
			return;
		}
		throw renameError;
	}

	try {
		await fs.rename(tempPath, targetPath);
	} catch (replaceError) {
		try {
			await fs.rename(backupPath, targetPath);
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
		await fs.rm(backupPath);
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
