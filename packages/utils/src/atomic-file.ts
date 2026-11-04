import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEexist, isEnoent } from "./fs-error";
import * as logger from "./logger";
import { toError } from "./type-guards";

/**
 * Link hops followed before a destination is declared cyclic. Linux gives up at
 * 40 and macOS at 32; stopping at the lower of the two keeps a cycle surfacing
 * as `ELOOP` here rather than as an unbounded loop.
 */
const MAX_SYMLINK_HOPS = 32;

function symlinkLoopError(filePath: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`ELOOP: too many symbolic links encountered, open '${filePath}'`);
	error.code = "ELOOP";
	error.path = filePath;
	return error;
}

/**
 * `readlink` said the walk is over: `EINVAL` is a path that exists and is not a
 * link, `ENOENT`/`ENOTDIR` a path that is not there yet and the write creates.
 */
function endsSymlinkWalk(error: unknown): boolean {
	return hasFsCode(error, "EINVAL") || isEnoent(error) || hasFsCode(error, "ENOTDIR");
}

/**
 * The file a plain write to `filePath` would open: links on the final component
 * are followed to their target, so publishing by rename replaces the file the
 * link names instead of the link itself.
 *
 * Without this, every atomic write silently converts a symlinked destination
 * into a regular file. That breaks a shared omp profile, whose registry and
 * config paths are links at a profile root into the default root, and it breaks
 * a link someone made themselves into another directory. Both are honoured, and
 * deliberately so: the helper cannot tell them apart, and an atomic write must
 * land where a plain `open(path, "w")` would.
 *
 * A dangling link resolves to the path it names, which the write then creates —
 * again what a plain write does.
 */
async function resolveWriteTarget(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
		let link: string;
		try {
			link = await fs.promises.readlink(current);
		} catch (error) {
			if (endsSymlinkWalk(error)) return current;
			throw error;
		}
		current = path.resolve(path.dirname(current), link);
	}
	throw symlinkLoopError(filePath);
}

/** Synchronous sibling of {@link resolveWriteTarget}. */
function resolveWriteTargetSync(filePath: string): string {
	let current = path.resolve(filePath);
	for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
		let link: string;
		try {
			link = fs.readlinkSync(current);
		} catch (error) {
			if (endsSymlinkWalk(error)) return current;
			throw error;
		}
		current = path.resolve(path.dirname(current), link);
	}
	throw symlinkLoopError(filePath);
}

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 *
 * A destination that is a symlink is resolved first, so the link survives the
 * publication. When the resolved file lives in another directory the staged
 * file is no longer its sibling and a rename could cross a device boundary, so
 * it is re-staged beside the real file and published from there.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	const destination = await resolveWriteTarget(targetPath);
	if (path.dirname(destination) !== path.dirname(path.resolve(tempPath))) {
		await replaceFileAcrossDevices(tempPath, destination);
		return;
	}
	try {
		await fs.promises.rename(tempPath, destination);
		return;
	} catch (error) {
		if (!hasFsCode(error, "EPERM") && !isEexist(error)) throw error;
		await replaceAfterWindowsRenameFailure(tempPath, destination, error);
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
 * Write a file through a private temp sibling and publish it with a single
 * rename, so a reader never observes a half-written file and a failed write
 * leaves the destination untouched.
 *
 * A symlinked `filePath` is resolved first (see {@link resolveWriteTarget}), so
 * the staging sibling and the published file both land on the link's target and
 * the link survives. A target whose directory cannot be written fails here —
 * the staging `open` reports `EACCES`/`EROFS` naming the resolved path — rather
 * than diverting the write to a fresh file at the link.
 *
 * The staged file is created with `mode` (0600 by default) and published with
 * that mode, so the destination stays readable only by its owner even when it
 * carries a secret.
 */
export async function writeFileAtomically(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	mode: number = 0o600,
): Promise<void> {
	const destination = await resolveWriteTarget(filePath);
	const tempPath = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.promises.open(tempPath, "wx", mode);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		// The umask narrows the mode passed to open(); restore it explicitly.
		await fs.promises.chmod(tempPath, mode);
		await replaceFileAtomically(tempPath, destination);
		removeTemp = false;
	} finally {
		if (removeTemp) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => {});
		}
	}
}

/**
 * Synchronous sibling of {@link writeFileAtomically} for callers that cannot
 * await, such as the boot-time config migration.
 */
export function writeFileAtomicallySync(filePath: string, content: string, mode: number = 0o600): void {
	const destination = resolveWriteTargetSync(filePath);
	const tempPath = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", mode);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		// The umask narrows the mode passed to open(); restore it explicitly.
		fs.chmodSync(tempPath, mode);
		fs.renameSync(tempPath, destination);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The descriptor is already gone.
			}
		}
		fs.rmSync(tempPath, { force: true });
		throw error;
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

/**
 * Move a finished file across devices, replacing a same-named destination. The copy is staged beside the destination
 * and published in one rename, so a failure before publication leaves the destination as it was. Once published, a
 * source that cannot be removed is logged rather than failing the move.
 */
export async function replaceFileAcrossDevices(source: string, destination: string): Promise<void> {
	const target = await resolveWriteTarget(destination);
	const staging = `${target}.${process.pid}.${crypto.randomUUID()}.move`;
	try {
		await fs.promises.copyFile(source, staging);
		const fd = fs.openSync(staging, "r+");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		await replaceFileAtomically(staging, target);
	} catch (error) {
		await fs.promises.rm(staging, { force: true });
		throw error;
	}
	await fs.promises.unlink(source).catch(error => {
		logger.warn("Failed to remove moved file's source", { source, error: toError(error).message });
	});
}
