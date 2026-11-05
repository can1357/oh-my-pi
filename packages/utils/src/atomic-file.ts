import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getBaseConfigRoot,
	getConfigDirName,
	getConfigRootDir,
	pathIsWithin,
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

/**
 * The longest basename POSIX filesystems accept, in BYTES: ext4, xfs and tmpfs
 * all stop at 255, and the limit counts bytes rather than code points.
 */
const MAX_BASENAME_BYTES = 255;

/**
 * A staging path beside `destination`, with a basename short enough to create.
 *
 * The suffix carries the pid and a uuid so two processes publishing one file
 * never share a staging path, and the destination's own name is kept in front
 * of it only as far as it fits — because a staging name is derived from a name
 * the user chose, and a 245-byte basename is legal while that name plus a
 * 45-byte suffix is not. Since the config write resolves before it stages, the
 * name in front is the LINK'S TARGET, which a user may well have made long: a
 * reviewer reproduced `ENAMETOOLONG` on all three registries through the real
 * CLI with a 245-byte target that reads back perfectly well.
 *
 * Truncation is by bytes and never splits a character, so the result is a valid
 * name on every filesystem the limit comes from. Uniqueness does not depend on
 * the kept prefix: the uuid carries it, and the open is exclusive regardless.
 */
function stagingPathFor(destination: string, extension: string): string {
	const suffix = `.${process.pid}.${crypto.randomUUID()}.${extension}`;
	const dir = path.dirname(destination);
	const name = path.basename(destination);
	const room = MAX_BASENAME_BYTES - Buffer.byteLength(suffix, "utf8");
	let kept = name;
	while (Buffer.byteLength(kept, "utf8") > room) kept = kept.slice(0, -1);
	return path.join(dir, `${kept}${suffix}`);
}

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

/**
 * The project config directory names, each as the components the filesystem
 * would make of it.
 *
 * `PI_CONFIG_DIR` is a path, and discovery treats it as one: `./custom/config`
 * and `nested/../custom` name the same directories `custom/config` and
 * `custom`. Splitting the raw string instead produced components no real
 * directory ever has — `.`, `..`, `nested` — so the name never matched and a
 * project directory spelled that way was not recognised as one. A backslash is
 * a separator only where the platform says it is; on POSIX it is part of the
 * name.
 */
function projectConfigDirNames(): string[][] {
	return [CONFIG_DIR_NAME, getConfigDirName()].map(name =>
		path
			.normalize(name)
			.split(path.sep)
			// `.` and `..` are traversal, not name. `PI_CONFIG_DIR=../custom` names
			// the directory `custom` beside the project, and a canonical path never
			// carries a `..` component for the matcher to find.
			.filter(segment => segment !== "" && segment !== "." && segment !== ".."),
	);
}

function containsSequence(segments: readonly string[], wanted: readonly string[]): boolean {
	if (wanted.length === 0) return false;
	return segments.some((_, at) => wanted.every((part, offset) => segments[at + offset] === part));
}

/**
 * Where a link sits, as the filesystem sees it: its directory canonicalized and
 * its own name appended.
 *
 * NOT `path.resolve` first. That collapses a `..` before anything physical
 * happens, so an entry spelled `…/alias/../name`, where `alias` is a link into
 * a checkout or out of omp's directories, loses the very component that decides
 * how it must be treated. `path.dirname` leaves the `..` in place for the
 * kernel to resolve, which is the whole point.
 */
function locationOf(filePath: string): { dir: string; name: string } {
	const absolute = path.isAbsolute(filePath) ? filePath : `${process.cwd()}${path.sep}${filePath}`;
	let dir = path.dirname(absolute);
	try {
		dir = fs.realpathSync.native(dir);
	} catch {
		// Not on disk yet; the lexical spelling of its parent is all there is.
		dir = path.resolve(dir);
	}
	return { dir, name: path.basename(absolute) };
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
	const { dir } = locationOf(candidate);
	return [getConfigRootDir(), getBaseConfigRoot(), getAgentDir()].some(root => pathIsWithin(root, dir));
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
	// The DIRECTORY the link sits in — never the link itself. Canonicalizing the
	// whole path would answer for the link's TARGET, so a project link pointing
	// at a file in omp's own root would lose its project marker and be followed.
	const { dir, name } = locationOf(filePath);
	let searched: string | undefined;
	for (const root of [getConfigRootDir(), getBaseConfigRoot(), getAgentDir()]) {
		// `pathIsWithin` canonicalizes both sides and counts a directory that IS
		// the root as inside it. Comparing spellings instead left two holes: a
		// link directly in the config root was never followed, which is where the
		// default profile keeps every one of these files, and a root reached
		// through a symlinked parent — `/home` on an automounted machine — missed
		// every time.
		if (!pathIsWithin(root, dir)) continue;
		const below = relativePathWithinRoot(root, dir) ?? "";
		if (searched === undefined || below.length < searched.length) searched = below;
	}
	const segments = [...(searched ?? dir).split(path.sep), name];
	return projectConfigDirNames().some(configName => containsSequence(segments, configName));
}

/**
 * The file a plain write to `filePath` would open: links on the final component
 * are followed to their target, so publishing by rename replaces the file the
 * link names instead of the link itself.
 *
 * This is what {@link writeConfigFileAtomically} uses, and nothing else does.
 * It is not exported: one entry point, so a future writer opts in by calling
 * that function rather than by resolving a path itself and losing the project
 * rule. A write that does not ask for it keeps replacing a link with a regular
 * file, which is what every caller outside that one has always done.
 *
 * A dangling link resolves to the path it names, which the write then creates —
 * what a plain write does, including failing when that path's directory does
 * not exist.
 */
async function resolveConfigWriteTarget(filePath: string): Promise<string> {
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
		// basename would throw that requirement away and write the file somewhere
		// that spelling never named, so it is handed on whole and the write fails.
		// Where it fails is the `rename`, not the staging `open`: the staged
		// sibling of `<dir>/` is a valid path INSIDE that directory, so it is
		// created and then removed by the caller's `finally` when publication
		// reports `ENOTEMPTY`/`EBUSY`. A reviewer measured that; an earlier version
		// of this comment claimed the `open` refused it, which was wrong.
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

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 *
 * A symlink at the destination is replaced, as it always has been. The one
 * writer form that keeps the link is {@link writeConfigFileAtomically}.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	await publishStagedFile(tempPath, targetPath);
}

/**
 * Write a config file the person using omp owns, where a symlink at the
 * destination is their own arrangement: the link is followed and the file it
 * names is replaced, so a shared profile keeps sharing. A path inside a
 * project's config directory is never followed — that tree is a checkout's.
 *
 * **The link is resolved BEFORE the temp file is staged, and the staging
 * happens beside the resolved destination.** That ordering is the whole
 * difference between this and a plain write, and it is load-bearing three ways:
 *
 * 1. The publishing `rename` is then always within one directory, so it is the
 *    atomic replace this module promises. Staging beside the path as GIVEN and
 *    renaming onto the resolved one crosses a filesystem boundary whenever the
 *    link does — `getAgentDir()` is an accepted root and `PI_CODING_AGENT_DIR`
 *    exists to relocate it — and `rename` then fails `EXDEV` and the write is
 *    lost. Two independent reviewers reproduced exactly that through
 *    `omp plugin marketplace add` and `omp plugin install`.
 * 2. A destination whose directory cannot be written fails HERE, at the staging
 *    `open`, reporting `EACCES`/`EROFS` against the resolved path, rather than
 *    diverting the write to a fresh file at the link.
 * 3. The destination cannot be swapped between resolving and publishing,
 *    because there is nothing in between.
 *
 * `mode` left undefined keeps the file at the user's umask, which is what the
 * registries had before they shared this helper; a number is applied to the
 * staged file and survives publication, for a destination holding a secret.
 */
export async function writeConfigFileAtomically(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	mode?: number,
): Promise<void> {
	await stageAndPublish(await resolveConfigWriteTarget(filePath), content, mode);
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
		// `EXDEV` is deliberately NOT handled here. On upstream main a rename
		// across devices throws and the caller decides what that means; exactly one
		// caller, the browser download mover, wants a copy instead, and it asks for
		// `replaceFileAcrossDevices` itself. Catching it here would silently turn
		// every `replaceFileAtomically` into copy + rename + unlink-source for
		// artifacts, session pins, the skills manifest, plugin runtime config and
		// sharpshooter memories, none of which asked for that.
		if (!hasFsCode(error, "EPERM") && !isEexist(error)) throw error;
		await replaceAfterWindowsRenameFailure(tempPath, destination, error);
	}
}

async function replaceAfterWindowsRenameFailure(
	tempPath: string,
	targetPath: string,
	renameError: unknown,
): Promise<void> {
	const backupPath = stagingPathFor(targetPath, "bak");
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
 * A symlink at the destination is replaced, as it always has been. The one
 * writer form that keeps the link is {@link writeConfigFileAtomically}.
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
	await stageAndPublish(filePath, content, mode);
}

async function stageAndPublish(
	destination: string,
	content: string | NodeJS.ArrayBufferView,
	mode: number | undefined,
): Promise<void> {
	const tempPath = stagingPathFor(destination, "tmp");
	let removeTemp = false;
	try {
		// `0o666` with no explicit mode leaves the result to the user's umask,
		// which is what a file written by `Bun.write` carries and what the
		// registries had before they shared this helper.
		const handle = await fs.promises.open(tempPath, "wx", mode ?? 0o666);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		// The umask narrows the mode passed to open(), so an explicitly requested
		// one is restored; an umask-defaulted file is left exactly as the umask
		// made it.
		if (mode !== undefined) await fs.promises.chmod(tempPath, mode);
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
 * await, such as the boot-time config migration. It never follows a symlinked
 * destination: the one opt-in this module offers is
 * {@link writeConfigFileAtomically}, and nothing synchronous asked for it.
 */
export function writeFileAtomicallySync(filePath: string, content: string, mode: number = 0o600): void {
	const destination = filePath;
	const tempPath = stagingPathFor(destination, "tmp");
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
	const staging = stagingPathFor(destination, "move");
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
	const staging = stagingPathFor(destination, "move");
	try {
		await fs.promises.copyFile(source, staging);
		// The copy carries the source's mode, which may be read-only — and a
		// read-only descriptor is NOT enough to flush it: libuv implements fsync on
		// Windows with `FlushFileBuffers`, which needs `GENERIC_WRITE`, so `"r"`
		// fails there with `EPERM` while working on POSIX. Make the staged copy
		// writable for the flush and put its mode back before publishing, so a
		// 0444 source still moves and the flush holds a descriptor every platform
		// accepts.
		const stagedMode = (await fs.promises.stat(staging)).mode & 0o777;
		await fs.promises.chmod(staging, stagedMode | 0o200);
		const fd = fs.openSync(staging, "r+");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		await fs.promises.chmod(staging, stagedMode);
		await publishStagedFile(staging, destination);
	} catch (error) {
		await fs.promises.rm(staging, { force: true });
		throw error;
	}
	await fs.promises.unlink(source).catch(error => {
		logger.warn("Failed to remove moved file's source", { source, error: toError(error).message });
	});
}
