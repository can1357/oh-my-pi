import * as fs from "node:fs/promises";
import { hasFsCode, isEexist, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";

import * as path from "node:path";

/**
 * Resolve the path an atomic config write must land on so a user-managed
 * symlink survives the publish. `rename()` over a symlink path replaces the
 * LINK itself with a regular file — silently unlinking the managed target
 * (e.g. a dotfiles checkout) and leaving the real file stale. Writing to the
 * referent keeps link and target in sync.
 */
export async function resolveSymlinkWriteTarget(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	// realpath fails with ENOENT on a dangling link. Recreate the referent
	// (one hop) so the write repairs the target the user pointed at rather
	// than replacing the link. A chain dangling past one hop lands on the
	// first missing referent, which still leaves the original link in place.
	try {
		return path.resolve(path.dirname(filePath), await fs.readlink(filePath));
	} catch {
		return filePath;
	}
}

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
