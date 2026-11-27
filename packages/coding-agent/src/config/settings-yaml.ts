/**
 * Settings config files on disk: YAML reads that record the generation they saw, moving an invalid
 * file aside before anything can overwrite it, and the symlink-aware path a save writes. Used only
 * by the settings store (`./settings-store`), the single writer of every settings file.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { RawSettings } from "./raw-settings";
import { migrateRawSettings } from "./settings-migrations";

/** A config file's content plus the stat fields that change with every write or replacement. */
export interface YamlContentGeneration {
	kind: "content";
	source: string;
	mtimeNs: bigint;
	ctimeNs: bigint;
	inode: bigint;
	size: bigint;
}

/** What a config path held when read: content, nothing, or a file that could not be read. */
export type YamlGeneration = { kind: "missing" } | YamlContentGeneration | { kind: "unreadable" };

/** Outcome of {@link loadYamlSettings}. */
export type YamlLoadResult =
	| { kind: "missing" }
	| { kind: "loaded"; settings: RawSettings; generation: YamlContentGeneration }
	| { kind: "invalid"; error: unknown; generation: YamlContentGeneration; backupPath?: string }
	| { kind: "unreadable"; error: unknown };

/** Generation a load observed. */
export function yamlGenerationOf(result: YamlLoadResult): YamlGeneration {
	switch (result.kind) {
		case "missing":
			return { kind: "missing" };
		case "loaded":
		case "invalid":
			return result.generation;
		case "unreadable":
			return { kind: "unreadable" };
	}
}

/** Whether two reads saw the same file; an unreadable read matches nothing. */
export function yamlGenerationsMatch(left: YamlGeneration, right: YamlGeneration): boolean {
	switch (left.kind) {
		case "missing":
			return right.kind === "missing";
		case "content":
			return (
				right.kind === "content" &&
				left.source === right.source &&
				left.mtimeNs === right.mtimeNs &&
				left.ctimeNs === right.ctimeNs &&
				left.inode === right.inode &&
				left.size === right.size
			);
		case "unreadable":
			return false;
	}
}

/** Synchronous read of the generation at `filePath`, for capturing what a write was based on. */
export function readYamlGeneration(filePath: string): YamlGeneration {
	try {
		const source = fs.readFileSync(filePath, "utf8");
		const stat = fs.statSync(filePath, { bigint: true });
		return {
			kind: "content",
			source,
			mtimeNs: stat.mtimeNs,
			ctimeNs: stat.ctimeNs,
			inode: stat.ino,
			size: stat.size,
		};
	} catch (error) {
		return isEnoent(error) ? { kind: "missing" } : { kind: "unreadable" };
	}
}

/**
 * Reads and migrates the settings YAML at `filePath`. A retired `lastChangelogVersion` key goes to
 * `onLegacyChangelogVersion`. Never throws: failures are results.
 */
export async function loadYamlSettings(
	filePath: string,
	onLegacyChangelogVersion?: (version: string) => void,
): Promise<YamlLoadResult> {
	let content: string;
	let generation: YamlContentGeneration;
	try {
		content = await fs.promises.readFile(filePath, "utf8");
		const stat = await fs.promises.stat(filePath, { bigint: true });
		generation = {
			kind: "content",
			source: content,
			mtimeNs: stat.mtimeNs,
			ctimeNs: stat.ctimeNs,
			inode: stat.ino,
			size: stat.size,
		};
	} catch (error) {
		if (isEnoent(error)) return { kind: "missing" };
		return { kind: "unreadable", error };
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		return { kind: "invalid", error, generation };
	}
	if (parsed === null || parsed === undefined) {
		return { kind: "loaded", settings: {}, generation };
	}
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			kind: "invalid",
			error: new Error("Settings YAML must contain a mapping at the document root"),
			generation,
		};
	}
	return {
		kind: "loaded",
		settings: migrateRawSettings(parsed as RawSettings, onLegacyChangelogVersion),
		generation,
	};
}

/**
 * Moves the invalid config at `filePath` aside (`<file>.broken-<time>-<pid>-<uuid>`), so a later
 * write can never truncate the only copy of the user's configuration.
 *
 * @throws Error when the file cannot be moved; the caller must then refuse to write it.
 */
export async function quarantineInvalidYaml(
	filePath: string,
	result: Extract<YamlLoadResult, { kind: "invalid" }>,
): Promise<Extract<YamlLoadResult, { kind: "invalid" }>> {
	const backupPath = `${filePath}.broken-${Date.now()}-${process.pid}-${randomUUID()}`;
	try {
		await fs.promises.rename(filePath, backupPath);
	} catch (error) {
		throw new Error(
			`Settings config is invalid and could not be moved aside: ${filePath}; refusing to overwrite it: ${String(error)}`,
		);
	}
	logger.warn("Settings: moved invalid config aside", {
		path: filePath,
		backupPath,
		error: String(result.error),
	});
	return { ...result, backupPath };
}

/**
 * Settings a load produced; `null` for a missing file.
 *
 * @throws Error naming `filePath` (and its backup) for an invalid or unreadable file.
 */
export function unwrapYamlLoad(filePath: string, result: YamlLoadResult): RawSettings | null {
	switch (result.kind) {
		case "missing":
			return null;
		case "loaded":
			return result.settings;
		case "invalid":
			throw new Error(
				`Settings config is invalid: ${filePath}${result.backupPath ? ` (moved to ${result.backupPath})` : ""}: ${String(result.error)}`,
			);
		case "unreadable":
			throw new Error(`Failed to read settings config ${filePath}: ${String(result.error)}`);
	}
}

/**
 * Upper bound on symlink hops while resolving a dangling config chain by hand.
 * `realpath()` already rejects a fully-linked cycle with ELOOP; this caps the
 * manual walk so a chain that turns cyclic AFTER realpath reported ENOENT (a
 * concurrent retarget mid-walk) surfaces a bounded ELOOP instead of spinning
 * forever. Matches Linux's MAXSYMLINKS (40).
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Split a dangling symlink target into the physical path segments the flush
 * walk should follow. Three platform-correctness rules that a naive
 * `target.split(/[\\/]+/)` gets wrong:
 *
 *  1. Root double-count. An ABSOLUTE target seeds the accumulator at
 *     `parse(target).root` — `C:\` on Windows, the `\\server\share\` prefix of
 *     a UNC path, `/` on POSIX. The root must therefore be STRIPPED from the
 *     string before splitting; otherwise it is re-emitted as a leading segment
 *     and `C:\managed\final.yml` resolves to `C:\` + `C:` + `managed` + … =
 *     `C:\C:\managed\final.yml`, so the flush fails against a dangling absolute
 *     link on Windows. (POSIX escaped this by luck: the leading `/` splits to an
 *     empty leading segment that the walk already skips.) A RELATIVE target
 *     seeds at the link's real parent dir and keeps every segment unchanged.
 *  2. Separator set. `\` is a separator only on Windows. On POSIX it is a valid
 *     filename character, so a target literally named `managed\config.yml` must
 *     stay ONE segment, not two. Split on the platform separator set: `/` only
 *     on POSIX, `/` or `\` on Windows. Keyed off `pathApi.sep` so the rule is
 *     driven by the platform, not a hardcoded cross-platform class.
 *  3. Dot segments. POSIX follows each component physically, so `..` stays a
 *     raw segment and the walk pops the REAL parent of whatever `alias`
 *     resolved to. Windows collapses `.` and `..` inside a symlink target
 *     lexically before following any component: `alias\..\final.yml` names the
 *     link directory's `final.yml` even when `alias` is a directory link, and
 *     `missing\..\final.yml` never consults `missing`. Only a leading `..` of a
 *     relative target still pops the link's real parent, and a trailing
 *     separator survives to demand a directory. Walking raw `..` segments there
 *     writes a file the link never reads — possibly an unrelated one — so the
 *     Windows target is normalized first.
 *
 * `pathApi` is injectable so the platform-specific behavior is testable off the
 * host OS (drive with `path.win32` / `path.posix`); it defaults to the host.
 */
export function physicalTargetSegments(target: string, pathApi: typeof path = path): string[] {
	const windows = pathApi.sep === "\\";
	const separator = windows ? /[\\/]+/ : /\/+/;
	const spelled = windows ? pathApi.normalize(target) : target;
	const body = pathApi.isAbsolute(spelled) ? spelled.slice(pathApi.parse(spelled).root.length) : spelled;
	return body.split(separator);
}

/**
 * Path a save of the config at `filePath` writes: the final target of its symlink chain, so an
 * atomic rename replaces the file a managed (dotfiles) link points at instead of the link itself,
 * dangling chains included (see {@link physicalTargetSegments}); `quarantinedTarget`, the target an
 * invalid file was moved away from, when one was.
 *
 * @throws Error with code `ELOOP` when the chain turns cyclic mid-walk, or `ENOTDIR` when a target
 * needs an unresolved or non-directory component to be a directory.
 */
export async function resolveYamlWritePath(filePath: string, quarantinedTarget?: string): Promise<string> {
	if (quarantinedTarget) return quarantinedTarget;
	try {
		return await fs.promises.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	// realpath fails for a dangling symlink. Resolve its target so recreating
	// a quarantined config repairs the target without replacing the
	// user-managed link. Walk the symlink chain hop by hop: realpath already
	// handled the case where every referent exists, so we only reach here when
	// the final referent is missing. Follow each existing intermediate link
	// until the referent is a non-symlink or does not exist, so the write
	// lands on the final target and preserves every intermediate link instead
	// of clobbering one into a regular file.
	try {
		if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
			let current = filePath;
			for (let hops = 0; ; hops++) {
				// realpath() rejects a fully-linked cycle up front, so we only
				// reach the manual walk on a chain that dangles today. It can
				// still turn cyclic mid-walk if another process retargets an
				// intermediate link, at which point readlink() would alternate
				// forever. Cap the hops and surface an ELOOP so a cycle has
				// bounded behavior instead of hanging flush().
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
					// rather than collapsing to the chain head, which would let the
					// atomic rename replace the first user-managed symlink.
					return current === filePath ? path.resolve(filePath) : current;
				}
				// Resolve the target one physical segment at a time so an
				// intermediate directory symlink is followed by the filesystem
				// BEFORE a later `..` pops its PHYSICAL parent. Both absolute and
				// relative targets take the same walk: normalizing the whole
				// string up front (path.resolve) collapses `alias/..` lexically
				// to the anchor, but a POSIX kernel follows `alias` first and then
				// pops its real parent, so the two disagree whenever an alias
				// precedes a `..` — the lexical result can escape to an unrelated
				// sibling and let the write clobber a foreign file. Windows does
				// collapse them lexically; physicalTargetSegments() applies the
				// host's rule. An absolute target seeds the accumulator at its
				// filesystem anchor; a relative one seeds at the link's REAL
				// parent dir.
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
				let frozen = false;
				for (const segment of physicalTargetSegments(target)) {
					if (segment === "" || segment === ".") {
						if (frozen) {
							// A trailing `/` (empty segment) or `/.` demands the
							// preceding component be a traversable directory. Before the
							// freeze that component was confirmed on disk, so the
							// requirement holds and the segment is inert. After the
							// freeze the component is a nonexistent/dangling name that
							// can never be a directory (`config.yml -> missing/`):
							// dropping the segment and writing a regular file there
							// mislocates and falsely reports success while the logical
							// config path stays unusable with ENOTDIR. Surface it.
							const notDir = new Error(
								`ENOTDIR: symlink target requires an unresolved component to be a directory for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
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
						let accStat: fs.Stats;
						try {
							accStat = await fs.promises.stat(acc);
						} catch (error) {
							// `acc` was resolved by realpath() moments ago, but a
							// concurrent process can remove the component between that
							// realpath and this stat (`config.yml -> dir/../final.yml`
							// while `dir` is deleted). The trailing `/` or `/.` still
							// requires `acc` to be a traversable directory, and that
							// requirement provably cannot hold once the component is
							// gone. Surface ENOTDIR here instead of letting the ENOENT
							// reach the outer catch, which would swallow it and return
							// the chain head — clobbering config.yml itself.
							if (!isEnoent(error)) throw error;
							const notDir = new Error(
								`ENOTDIR: symlink target requires a directory but ${acc} is gone for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
						}
						if (!accStat.isDirectory()) {
							const notDir = new Error(
								`ENOTDIR: symlink target requires a directory but ${acc} is not one for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
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
							const notDir = new Error(
								`ENOTDIR: cannot resolve '..' past an unresolved component in symlink target for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
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
						let accStat: fs.Stats;
						try {
							accStat = await fs.promises.stat(acc);
						} catch (error) {
							// `acc` was resolved by realpath() moments ago, but a
							// concurrent process can remove the component between that
							// realpath and this stat. The `..` still requires `acc` to
							// be a traversable directory to pop its parent, and that
							// requirement provably cannot hold once the component is
							// gone. Surface ENOTDIR here instead of letting the ENOENT
							// reach the outer catch, which would swallow it and return
							// the chain head — clobbering config.yml itself.
							if (!isEnoent(error)) throw error;
							const notDir = new Error(
								`ENOTDIR: symlink target requires a directory but ${acc} is gone for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
						}
						if (!accStat.isDirectory()) {
							const notDir = new Error(
								`ENOTDIR: symlink target requires a directory but ${acc} is not one for ${filePath}`,
							) as Error & { code?: string };
							notDir.code = "ENOTDIR";
							throw notDir;
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
						acc = candidate;
						frozen = true;
					}
				}
				const resolved = acc;
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
	return path.resolve(filePath);
}
