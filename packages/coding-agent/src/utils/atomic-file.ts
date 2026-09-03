import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEexist, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

/**
 * Upper bound on symlink hops while resolving a dangling config chain by hand.
 * `realpath()` already rejects a fully-linked cycle with ELOOP; this caps the
 * manual walk so a chain that turns cyclic AFTER realpath reported ENOENT (a
 * concurrent retarget mid-walk) surfaces a bounded ELOOP instead of spinning
 * forever. Matches Linux's MAXSYMLINKS (40).
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Split a dangling symlink target into the physical path segments the write
 * walk should follow. Two platform-correctness rules that a naive
 * `target.split(/[\\/]+/)` gets wrong:
 *
 *  1. Root double-count. An ABSOLUTE target seeds the accumulator at
 *     `parse(target).root` — `C:\` on Windows, the `\\server\share\` prefix of
 *     a UNC path, `/` on POSIX. The root must therefore be STRIPPED from the
 *     string before splitting; otherwise it is re-emitted as a leading segment
 *     and `C:\managed\final.yml` resolves to `C:\` + `C:` + `managed` + … =
 *     `C:\C:\managed\final.yml`, so the write fails against a dangling absolute
 *     link on Windows. (POSIX escaped this by luck: the leading `/` splits to an
 *     empty leading segment that the walk already skips.) A RELATIVE target
 *     seeds at the link's real parent dir and keeps every segment unchanged.
 *  2. Separator set. `\` is a separator only on Windows. On POSIX it is a valid
 *     filename character, so a target literally named `managed\config.yml` must
 *     stay ONE segment, not two. Split on the platform separator set: `/` only
 *     on POSIX, `/` or `\` on Windows. Keyed off `pathApi.sep` so the rule is
 *     driven by the platform, not a hardcoded cross-platform class.
 *
 * `pathApi` is injectable so the platform-specific behavior is testable off the
 * host OS (drive with `path.win32` / `path.posix`); it defaults to the host.
 */
export function physicalTargetSegments(target: string, pathApi: typeof path = path): string[] {
	const separator = pathApi.sep === "\\" ? /[\\/]+/ : /\/+/;
	const body = pathApi.isAbsolute(target) ? target.slice(pathApi.parse(target).root.length) : target;
	return body.split(separator);
}

/**
 * Resolve the path an atomic config write must land on so a user-managed
 * symlink survives the publish. `rename()` over a symlink path replaces the
 * LINK itself with a regular file — silently unlinking the managed target
 * (e.g. a dotfiles checkout) and leaving the real file stale. Writing to the
 * referent keeps both in sync.
 *
 * `realpath()` handles every chain whose referents all exist. A DANGLING link
 * needs a manual walk so the write recreates the target the user pointed at
 * instead of replacing the link; that walk resolves the target one physical
 * segment at a time (see the inline comments for the TOCTOU hardening) —
 * shared by the YAML settings flush and the JSON config writers.
 */
export async function resolveSymlinkWriteTarget(filePath: string): Promise<string> {
	try {
		return await fs.promises.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	// realpath fails for a dangling symlink. Resolve its target so recreating
	// the referent repairs the target without replacing the user-managed link.
	// Walk the symlink chain hop by hop: realpath already handled the case
	// where every referent exists, so we only reach here when the final
	// referent is missing. Follow each existing intermediate link until the
	// referent is a non-symlink or does not exist, so the write lands on the
	// final target and preserves every intermediate link instead of clobbering
	// one into a regular file.
	try {
		if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
			let current = filePath;
			for (let hops = 0; ; hops++) {
				// realpath() rejects a fully-linked cycle up front, so we only
				// reach the manual walk on a chain that dangles today. It can
				// still turn cyclic mid-walk if another process retargets an
				// intermediate link, at which point readlink() would alternate
				// forever. Cap the hops and surface an ELOOP so a cycle has
				// bounded behavior instead of hanging the writer.
				if (hops >= MAX_SYMLINK_HOPS) {
					const cyclic = new Error(
						`ELOOP: symlink chain for ${filePath} exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle)`,
					) as Error & { code?: string };
					cyclic.code = "ELOOP";
					throw cyclic;
				}
				let target: string;
				try {
					target = await fs.promises.readlink(current);
				} catch (error) {
					if (!isEnoent(error)) throw error;
					// An intermediate link vanished mid-walk: it was confirmed a
					// symlink by the lstat below on the prior hop, then removed
					// before this readlink. Land on the deepest hop we resolved
					// rather than collapsing to the chain head, which would let
					// the atomic rename replace the first user-managed symlink.
					return current === filePath ? walkOriginalSpelling(filePath) : current;
				}
				// Resolve the target one physical segment at a time so an
				// intermediate directory symlink is followed by the filesystem
				// BEFORE a later `..` pops its PHYSICAL parent. Both absolute and
				// relative targets take the same walk: normalizing the whole
				// string up front (path.resolve) collapses `alias/..` lexically
				// to the anchor, but the kernel follows `alias` first and then
				// pops its real parent, so the two disagree whenever an alias
				// precedes a `..` — the lexical result can escape to an unrelated
				// sibling and let the write clobber a foreign file. An absolute
				// target seeds the accumulator at its filesystem anchor; a
				// relative one seeds at the link's REAL parent dir.
				let acc: string;
				if (path.isAbsolute(target)) {
					acc = path.parse(target).root;
				} else {
					const lexicalDir = path.dirname(current);
					acc = lexicalDir;
					try {
						acc = await fs.promises.realpath(lexicalDir);
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
				}
				// realpath() on the deepest existing prefix keeps `acc` canonical so
				// each `..` pops the real parent. Once a NAMED component does not
				// exist on disk the walk is FROZEN: the remainder is joined
				// lexically, but nothing past the miss was physically traversable,
				// so any construct that requires ENTERING the frozen component — a
				// `..`, or a trailing `/` or `/.` that demands it be a directory —
				// cannot be satisfied by the filesystem and must surface ENOTDIR
				// rather than lexically landing a regular file at a mislocated path.
				const resolved = await walkPhysicalSegments(filePath, acc, physicalTargetSegments(target));

				let nextIsSymlink = false;
				try {
					nextIsSymlink = (await fs.promises.lstat(resolved)).isSymbolicLink();
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				if (!nextIsSymlink) return resolved;
				current = resolved;
			}
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	// The leaf is not a symlink, so the miss lives in an ANCESTOR — possibly
	// a dangling DIRECTORY link (`~/.omp -> /missing/dotfiles` while the writer
	// targets `~/.omp/mcp.json`; lstat through the dangling link reports ENOENT,
	// so the chain above never engages and realpath(parent) cannot resolve
	// either). Walk the FULL physical path so ancestor links are followed and
	// their referents recreated instead of failing mkdir through the dangling
	// link. This also canonicalizes every existing component, which collapses
	// directory aliases onto one physical parent for the missing-leaf case.
	return walkOriginalSpelling(filePath);
}

/**
 * Walk the ORIGINAL spelling of a missing path without lexical normalization.
 * `path.resolve()` would collapse `alias/..` onto an unrelated lexical sibling
 * before the filesystem follows `alias` (`/base/alias/../mcp.json` with
 * `alias -> /other/deep` really resolves to `/other/mcp.json`); the physical
 * walker instead follows the link first and pops its REAL parent. A relative
 * input is anchored onto the cwd by plain concatenation for the same reason —
 * `path.join`/`path.resolve` would normalize the `..` away.
 */
function walkOriginalSpelling(filePath: string): Promise<string> {
	const cwd = process.cwd();
	const spelling = path.isAbsolute(filePath) ? filePath : `${cwd}${path.sep}${filePath}`;
	return walkPhysicalSegments(filePath, path.parse(spelling).root, physicalTargetSegments(spelling));
}

/**
 * Walk `segments` physically from a canonical `acc`, one component at a time,
 * following symlinked components (including dangling ones, whose referents the
 * write recreates) and popping only PHYSICAL parents for `..`. Returns the
 * resolved accumulator — canonical up to the deepest existing component, then
 * lexical once a component is missing (the freeze).
 */
async function walkPhysicalSegments(filePath: string, acc: string, segments: readonly string[]): Promise<string> {
	let frozen = false;
	const remaining = [...segments];
	let linkHops = 0;
	while (remaining.length > 0) {
		const segment = remaining.shift()!;
		if (segment === "" || segment === ".") {
			if (frozen) {
				// An INTERIOR separator or `.` after the frozen component is
				// inert — `managed//mcp.json` and `managed/./mcp.json` are
				// equivalent spellings of `managed/mcp.json`, and the write
				// below creates the missing parent. Only a TRAILING `/`
				// (empty segment) or `/.` demands the preceding component be
				// a directory: after the freeze that component is a
				// nonexistent/dangling name that can never be a directory
				// (`config.yml -> missing/`), so writing a regular file there
				// mislocates and falsely reports success while the logical
				// config path stays unusable with ENOTDIR. Surface it.
				if (remaining.length > 0) continue;
				throw enotDir(`symlink target requires an unresolved component to be a directory for ${filePath}`);
			}
			// The walk is not frozen, so `acc` was resolved by realpath()
			// and exists on disk — but existence is not enough. A trailing
			// `/` or `/.` demands `acc` be a directory, and a concurrent
			// process can win a TOCTOU race: the initial realpath(filePath)
			// saw the target missing, then the target was created as a
			// REGULAR FILE before this segment walk reached it, so
			// realpath(candidate) succeeded and left `frozen` false. The
			// preceding component is now a regular file, not a directory,
			// and dropping the segment would land the atomic rename on top
			// of it while the logical config path is really ENOTDIR. Verify
			// the requirement holds instead of assuming it.
			const accStat = await statTraversingDirectory(acc, filePath, "trailing separator");
			if (!accStat.isDirectory()) {
				throw enotDir(`symlink target requires a directory but ${acc} is not one for ${filePath}`);
			}
			continue;
		}
		if (segment === "..") {
			if (frozen) {
				// `..` after a component that could not be physically
				// traversed — a missing name or a dangling symlink — whether
				// the `..` follows it immediately (`link/..`) or after further
				// lexical names (`missing/child/..`). The kernel cannot take
				// the parent of a path it never entered: `missing/child/..`
				// fails because `missing` was never a directory to descend,
				// so the lexically appended `child` is not a real component to
				// pop. Popping and continuing would leave `acc` on a
				// mislocated path and land a regular file there while
				// reporting success. Surface the ENOTDIR the filesystem
				// raises instead.
				throw enotDir(`cannot resolve '..' past an unresolved component in symlink target for ${filePath}`);
			}
			// `acc` was resolved by realpath() and exists on disk, but a
			// `..` demands it be a traversable directory to pop its parent.
			// A concurrent process can win a TOCTOU race: the initial
			// realpath(filePath) saw the component missing, then it was
			// created as a REGULAR FILE before realpath(candidate) reached
			// it, so that call succeeded and left `frozen` false. The
			// kernel cannot take the parent of `regularfile/..` — it fails
			// with ENOTDIR — so lexically popping and continuing would let
			// the atomic rename land on a mislocated sibling
			// (`config.yml -> racetarget/../victim.yml`) while the logical
			// config path is really ENOTDIR. Verify before popping.
			const accStat = await statTraversingDirectory(acc, filePath, "'..'");
			if (!accStat.isDirectory()) {
				throw enotDir(`symlink target requires a directory but ${acc} is not one for ${filePath}`);
			}
			acc = path.dirname(acc);
			continue;
		}
		if (frozen) {
			acc = path.join(acc, segment);
			continue;
		}
		const candidate = path.join(acc, segment);
		try {
			acc = await fs.promises.realpath(candidate);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			// The component is missing — but it may itself be a DANGLING
			// SYMLINK whose referent the write should recreate
			// (`mcp.json -> alias/config.json` with `alias -> missing-dir`).
			// Freezing on the link path would leave the writer unable to
			// create anything THROUGH the link; follow it instead and splice
			// its target's segments in front of the walk, so intermediate
			// links survive exactly like final-component chains do.
			let linkTarget: string | undefined;
			try {
				if ((await fs.promises.lstat(candidate)).isSymbolicLink()) {
					linkTarget = await fs.promises.readlink(candidate);
				}
			} catch (lstatError) {
				if (!isEnoent(lstatError)) throw lstatError;
			}
			if (linkTarget === undefined) {
				acc = candidate;
				frozen = true;
				continue;
			}
			// A cycle among dangling links (`a -> b`, `b -> a`) never
			// reaches the outer chain check, which only counts hops of
			// the FINAL component. Bound this walk's follows and surface
			// a bounded ELOOP instead of splicing forever.
			if (++linkHops >= MAX_SYMLINK_HOPS) {
				const cyclic = new Error(
					`ELOOP: symlink chain for ${filePath} exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle)`,
				) as Error & { code?: string };
				cyclic.code = "ELOOP";
				throw cyclic;
			}
			if (path.isAbsolute(linkTarget)) acc = path.parse(linkTarget).root;
			// A relative target resolves against the link's parent — the
			// canonical `acc` we are standing on.
			remaining.unshift(...physicalTargetSegments(linkTarget));
		}
	}
	return acc;
}

/**
 * Stat a component the walk is about to require to be a traversable directory.
 * `acc` was resolved by realpath() moments ago, but a concurrent process can
 * remove it before this stat (`config.yml -> dir/../final.yml` while `dir` is
 * deleted). The requirement provably cannot hold once the component is gone,
 * so surface ENOTDIR instead of letting the ENOENT reach the outer catch,
 * which would swallow it and return the chain head — clobbering the
 * user-managed link itself.
 */
async function statTraversingDirectory(acc: string, filePath: string, requirement: string): Promise<fs.Stats> {
	try {
		return await fs.promises.stat(acc);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		throw enotDir(`symlink target requires a directory (${requirement}) but ${acc} is gone for ${filePath}`);
	}
}

function enotDir(message: string): Error & { code?: string } {
	const notDir = new Error(`ENOTDIR: ${message}`) as Error & { code?: string };
	notDir.code = "ENOTDIR";
	return notDir;
}

/**
 * Stage serialized content and publish it atomically against an ALREADY-RESOLVED
 * config target — the path pinned by {@link withConfigFileLock}. The temp file
 * is per-writer unique (pid + random, in the target's own directory so the
 * rename cannot EXDEV across mounts); its mode takes only the OWNER bits of
 * the referent's current mode — credential-bearing configs drop group/world
 * bits exactly like an unconditional 0o600 did, while stricter-than-600 owner
 * modes survive, and a new file falls back to owner-only — and is chmod'd
 * explicitly because creation modes pass through umask. The rename itself goes
 * through {@link replaceFileAtomically}, so Windows `EPERM`/`EEXIST`
 * replacement failures recover instead of failing the write.
 */
export async function publishSerializedConfig(writePath: string, content: string): Promise<void> {
	const dir = path.dirname(writePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	let mode = 0o600;
	try {
		mode = (await fs.promises.stat(writePath)).mode & 0o700;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const tmpPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		await fs.promises.chmod(tmpPath, mode);
		await replaceFileAtomically(tmpPath, writePath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Serialize a read-modify-write against one config file on its symlink-RESOLVED
 * target: two configured paths that alias the same physical file must contend
 * on one lock, or both read-modify-writes can publish against the resolved
 * target and the last rename drops the other's mutation. The lock directory
 * (`${resolved}.lock`) is created with a non-recursive `mkdir`, so the
 * referent's parent directory is materialized first — also covering a link
 * dangling into a directory that does not exist yet.
 */
export async function withConfigFileLock<T>(filePath: string, fn: (writePath: string) => Promise<T>): Promise<T> {
	const writePath = await resolveSymlinkWriteTarget(filePath);
	await fs.promises.mkdir(path.dirname(writePath), { recursive: true, mode: 0o700 });
	// The callback receives the LOCKED target and must do both its read and
	// its write through it: if the link is retargeted mid-callback, resolving
	// the logical path again would publish to the new referent while this
	// lock still names the old one, letting another mutation lock the new
	// referent independently and race its read-modify-write.
	return withFileLock(writePath, async () => fn(writePath));
}

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fsp.rename(tempPath, targetPath);
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
		await fsp.rename(targetPath, backupPath);
	} catch (error) {
		if (isEnoent(error)) {
			await fsp.rename(tempPath, targetPath);
			return;
		}
		throw renameError;
	}

	try {
		await fsp.rename(tempPath, targetPath);
	} catch (replaceError) {
		try {
			await fsp.rename(backupPath, targetPath);
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
		await fsp.rm(backupPath);
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
