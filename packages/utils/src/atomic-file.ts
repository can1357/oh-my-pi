import * as fs from "node:fs";
import * as path from "node:path";
import { isOmpOwnedPath } from "./dirs";
import { hasFsCode, isEexist, isEnoent } from "./fs-error";
import * as logger from "./logger";
import { toError } from "./type-guards";

/**
 * Link hops followed before a destination is declared cyclic. Linux stops at
 * 40, so a chain this host would have opened never fails here first.
 */
const MAX_SYMLINK_HOPS = 40;

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
 * Whether a path spells a directory rather than a file: a trailing separator,
 * or a final `.` or `..` component. `open(path, "w")` refuses all three.
 */
function namesADirectory(value: string): boolean {
	const tail = value.split(/[\\/]/).at(-1);
	return tail === "" || tail === "." || tail === "..";
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
 * deliberately so: within omp's own directories the helper cannot tell them
 * apart, and an atomic write there must land where a plain `open(path, "w")`
 * would.
 *
 * Outside omp's own directories the path is returned untouched and the link is
 * replaced, as before. A project checkout's `.omp/` holds whatever the
 * repository committed, symlinks included; following one would let a clone
 * redirect omp's write onto any file its user can write. {@link isOmpOwnedPath}
 * draws that line.
 *
 * A dangling link resolves to the path it names, which the write then creates —
 * again what a plain write does, including failing when that path's directory
 * does not exist.
 */
export async function resolveWriteTarget(filePath: string): Promise<string> {
	let current = filePath;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
		// Asked again at every hop, not once at the start: the link that decides
		// the next step is the one in THIS directory, and a link the user made out
		// of their own directory can land in a tree a checkout or a download
		// filled. The walk stops there and the write lands on the link itself.
		if (!isOmpOwnedPath(path.dirname(current))) return current;
		let link: string;
		try {
			link = await fs.promises.readlink(current);
		} catch (error) {
			if (endsSymlinkWalk(error)) return current;
			throw error;
		}
		// The hop lands where the kernel would put it. The link's text is appended
		// to its directory's physical path WITHOUT normalizing — `path.resolve`
		// and `path.join` would collapse a `..` lexically, and after a component
		// that is itself a link that leaves the wrong parent — and the result's own
		// parent is then canonicalized by the filesystem.
		const joined = path.isAbsolute(link)
			? link
			: `${await fs.promises.realpath(path.dirname(current))}${path.sep}${link}`;
		// A link text ending `/` or `/.` names a DIRECTORY, and an ordinary write
		// through it fails EISDIR or ENOTDIR. Splitting it into dirname and
		// basename would throw that requirement away and write the file anyway, so
		// the spelling is handed on whole and the staging `open` refuses it.
		if (namesADirectory(joined)) return joined;
		try {
			current = path.join(await fs.promises.realpath(path.dirname(joined)), path.basename(joined));
		} catch (error) {
			// The named directory is not there; the write will fail on it, as a plain
			// write through the same link does.
			if (!endsSymlinkWalk(error)) throw error;
			current = joined;
		}
	}
	throw symlinkLoopError(filePath);
}

/** Synchronous sibling of {@link resolveWriteTarget}. */
export function resolveWriteTargetSync(filePath: string): string {
	let current = filePath;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
		if (!isOmpOwnedPath(path.dirname(current))) return current;
		let link: string;
		try {
			link = fs.readlinkSync(current);
		} catch (error) {
			if (endsSymlinkWalk(error)) return current;
			throw error;
		}
		// `.native` asks the operating system; the JavaScript `realpathSync`
		// collapses `..` lexically, which is the whole defect this avoids.
		const joined = path.isAbsolute(link)
			? link
			: `${fs.realpathSync.native(path.dirname(current))}${path.sep}${link}`;
		if (namesADirectory(joined)) return joined;
		try {
			current = path.join(fs.realpathSync.native(path.dirname(joined)), path.basename(joined));
		} catch (error) {
			if (!endsSymlinkWalk(error)) throw error;
			current = joined;
		}
	}
	throw symlinkLoopError(filePath);
}

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 *
 * A destination that is a symlink is resolved first (see
 * {@link resolveWriteTarget}), so the link survives the publication.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	await publishStagedFile(tempPath, await resolveWriteTarget(targetPath));
}

/**
 * The publication step itself, on a destination already resolved. Callers that
 * resolved before staging use this so the destination cannot be swapped between
 * the two steps, and so one write never walks the links twice.
 */
async function publishStagedFile(tempPath: string, destination: string): Promise<void> {
	try {
		await fs.promises.rename(tempPath, destination);
		return;
	} catch (error) {
		// A rename only fails this way when the destination is on another
		// filesystem, which here means a link that leaves this one. Copy beside the
		// real file and publish from there; every same-device destination, in this
		// directory or another, still moves by rename and keeps its inode.
		if (hasFsCode(error, "EXDEV")) {
			await replaceFileAcrossDevices(tempPath, destination);
			return;
		}
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
 * carries a secret. A caller that must leave the mode to the user's umask
 * stages the file itself and publishes it with {@link replaceFileAtomically}.
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
		await publishStagedFile(tempPath, destination);
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
 *
 * This one does not resolve a symlinked destination, and does not need to: it
 * publishes with `link`, which refuses an existing destination of any kind, so
 * it never replaces a link in the first place.
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
		// The copy carries the source's mode, which may be read-only; fsync needs
		// only a readable descriptor.
		const fd = fs.openSync(staging, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		await publishStagedFile(staging, target);
	} catch (error) {
		await fs.promises.rm(staging, { force: true });
		throw error;
	}
	await fs.promises.unlink(source).catch(error => {
		logger.warn("Failed to remove moved file's source", { source, error: toError(error).message });
	});
}
