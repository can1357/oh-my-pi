import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getBaseConfigRoot,
	getConfigDirName,
	getConfigRootDir,
	relativePathWithinRoot,
} from "./dirs";
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
 *
 * Only the platform's own separators split it. A backslash is an ordinary
 * character in a POSIX filename, and splitting on it there mistakes a file
 * called `middle\` for a directory and abandons the link chain at it.
 */
function namesADirectory(value: string): boolean {
	const tail = (process.platform === "win32" ? value.split(/[\\/]/) : value.split("/")).at(-1);
	return tail === "" || tail === "." || tail === "..";
}

/** The configured project config directory names, each split into its components. */
function projectConfigDirNames(): string[][] {
	return [CONFIG_DIR_NAME, getConfigDirName()].map(name => name.split(/[\\/]/).filter(Boolean));
}

function containsSequence(segments: readonly string[], wanted: readonly string[]): boolean {
	if (wanted.length === 0) return false;
	return segments.some((_, at) => wanted.every((part, offset) => segments[at + offset] === part));
}

/**
 * Whether `candidate` stays inside a directory omp itself keeps: the config
 * root, the profile-independent root, or the agent directory. The physical
 * location decides, so an alias or a `..` cannot spell a way out of it.
 *
 * A config write follows a link only while every step stays inside these. A
 * link whose target leaves them is left alone and replaced, which is what a
 * write on upstream main does with every link — so this narrowing takes nothing
 * away that users have today, and it keeps the rule a property of the path
 * rather than an open-ended question about territory omp does not own.
 */
function insideOmpRoots(candidate: string): boolean {
	const resolved = path.resolve(candidate);
	let dir = path.dirname(resolved);
	try {
		dir = fs.realpathSync.native(dir);
	} catch {
		// Not on disk yet; judge the lexical spelling of its parent.
	}
	return [getConfigRootDir(), getBaseConfigRoot(), getAgentDir()].some(
		root => relativePathWithinRoot(root, dir) !== null || path.resolve(root) === dir,
	);
}

/**
 * Whether the link at `filePath` lives inside some *project's* config directory,
 * and so inside a tree a checkout produced. Both names are matched, because omp
 * uses both: `getProjectAgentDir()` builds one from the constant, while
 * discovery walks up looking for `getConfigDirName()`, which `PI_CONFIG_DIR`
 * renames — and that one may name several components.
 *
 * This is the one thing a config write must not follow a link through. A
 * repository commits whatever it likes in its own `.omp`, and following a link
 * found there would let a clone redirect the write onto any file its user can
 * write.
 *
 * It is the link's OWN location that decides, taken physically: the directory
 * the link sits in, canonicalized, plus the link's name. Classifying where the
 * link points instead would ask the question of the wrong file, and a lexical
 * path would miss a project directory reached through an aliased parent or a
 * `..`. omp's own roots carry the same name, so the search starts below the
 * deepest of them that contains the link.
 */
function insideAProjectConfigDir(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	// The DIRECTORY the link sits in, canonicalized — never the link itself.
	// Containment of the whole path would be answered for the link's TARGET, so
	// a project link pointing at a file in omp's own root would lose its
	// project marker and be followed.
	let dir = path.dirname(resolved);
	try {
		dir = fs.realpathSync.native(dir);
	} catch {
		// Not on disk yet; the lexical spelling is all there is to judge.
	}
	let searched = dir;
	for (const root of [getConfigRootDir(), getBaseConfigRoot(), getAgentDir()]) {
		const below = relativePathWithinRoot(root, dir);
		if (below !== null && below.length < searched.length) searched = below;
	}
	const segments = [...searched.split(path.sep), path.basename(resolved)];
	return projectConfigDirNames().some(name => containsSequence(segments, name));
}

/**
 * The file a plain write to `filePath` would open: links on the final component
 * are followed to their target, so publishing by rename replaces the file the
 * link names instead of the link itself.
 *
 * This is what the `…Config…` writers below use, and nothing else does. A write
 * that does not ask for it keeps replacing a link with a regular file, which is
 * what every caller outside those writers has always done.
 *
 * A dangling link resolves to the path it names, which the write then creates —
 * what a plain write does, including failing when that path's directory does
 * not exist.
 */
export async function resolveConfigWriteTarget(filePath: string): Promise<string> {
	let current = filePath;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
		// Both asked of every hop, not just the entry: a link outside any project
		// can point at one inside a checkout's config directory, and it is that
		// link the repository controls; and a chain may leave omp's roots at any
		// step, not only the first.
		if (!insideOmpRoots(current) || insideAProjectConfigDir(current)) return current;
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
		let next: string;
		try {
			next = path.join(await fs.promises.realpath(path.dirname(joined)), path.basename(joined));
		} catch (error) {
			// The named directory is not there; the write will fail on it, as a plain
			// write through the same link does.
			if (!endsSymlinkWalk(error)) throw error;
			next = joined;
		}
		// The step leaves omp's directories: stop here and let the write replace
		// this link, which is what a write on upstream main does with every link.
		if (!insideOmpRoots(next)) return current;
		current = next;
	}
	throw symlinkLoopError(filePath);
}

/** Synchronous sibling of {@link resolveConfigWriteTarget}. */
function resolveWriteTargetSync(filePath: string): string {
	let current = filePath;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
		if (!insideOmpRoots(current) || insideAProjectConfigDir(current)) return current;
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
		let next: string;
		try {
			next = path.join(fs.realpathSync.native(path.dirname(joined)), path.basename(joined));
		} catch (error) {
			if (!endsSymlinkWalk(error)) throw error;
			next = joined;
		}
		if (!insideOmpRoots(next)) return current;
		current = next;
	}
	throw symlinkLoopError(filePath);
}

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 *
 * A symlink at the destination is replaced, as it always has been. A config
 * writer that wants the link kept asks for it by name:
 * {@link replaceConfigFileAtomically}.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	await publishStagedFile(tempPath, targetPath);
}

/**
 * {@link replaceFileAtomically} for a path the person using omp owns, where a
 * symlink is their own arrangement: the link is followed and the file it names
 * is replaced, so a shared profile keeps sharing. A path inside a project's
 * config directory is never followed — that tree is a checkout's.
 */
export async function replaceConfigFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	await publishStagedFile(tempPath, await resolveConfigWriteTarget(targetPath));
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
 * A symlink at the destination is replaced, as it always has been. A config
 * writer that wants the link kept asks for it by name:
 * {@link writeConfigFileAtomically}.
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
	await stageAndPublish(filePath, filePath, content, mode);
}

/**
 * {@link writeFileAtomically} for a path the person using omp owns, where a
 * symlink is their own arrangement.
 *
 * The link is resolved before staging, so the temp sibling and the published
 * file both land beside the file the link names and the link survives: a shared
 * profile that links its config at another profile's keeps sharing it, and so
 * does a dotfiles tree that links one out to another disk. A path inside a
 * project's config directory is never followed, because that tree is whatever a
 * checkout put there.
 *
 * A target whose directory cannot be written fails here — the staging `open`
 * reports `EACCES`/`EROFS` naming the resolved path — rather than diverting the
 * write to a fresh file at the link.
 */
export async function writeConfigFileAtomically(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	mode: number = 0o600,
): Promise<void> {
	await stageAndPublish(filePath, await resolveConfigWriteTarget(filePath), content, mode);
}

async function stageAndPublish(
	filePath: string,
	destination: string,
	content: string | NodeJS.ArrayBufferView,
	mode: number,
): Promise<void> {
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
 * await, such as the boot-time config migration. `followConfigLink` is the
 * opt-in {@link writeConfigFileAtomically} makes for the asynchronous writers.
 */
export function writeFileAtomicallySync(
	filePath: string,
	content: string,
	mode: number = 0o600,
	followConfigLink = false,
): void {
	const destination = followConfigLink ? resolveWriteTargetSync(filePath) : filePath;
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
	// The destination arrives resolved when `publishStagedFile` falls back here;
	// a direct caller gets the plain behaviour, like every other non-config path.
	const target = destination;
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
