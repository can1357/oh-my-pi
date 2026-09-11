import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
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
 * SUPPORTED-SPELLING SUBSET — the deliberate complexity ceiling. `realpath()`
 * (the fast path) covers every real-world config; everything below it exists
 * only for user-controlled dangling-link edges, and spellings outside the
 * subset fail with a clear ENOTDIR/ELOOP instead of another special case — a
 * write must never land on a path the link cannot resolve through:
 *
 *  1. any path that resolves today (realpath fast path);
 *  2. a dangling final symlink, including a chain: the referent is recreated;
 *  3. dangling intermediate/ancestor symlinks: followed, referents recreated;
 *  4. plainly-missing components in the config's OWN spelling: lexical tail,
 *     created by the writer's recursive mkdir (they are ancestors of the
 *     result);
 *  5. `X/../leaf` with a plainly-missing `X` in the config's own spelling:
 *     `X` is materialized as a directory so the spelling resolves beside it;
 *  6. inert interior `//`/`./` spellings of the above.
 *
 * Outside: `..` past a component that was never entered (other than case 5),
 * `..` inside a followed link's target, trailing separators naming a
 * directory, and symlink cycles. See `frozenTail` for the grammar.
 *
 * The result is always a file target: a resolution landing on an existing
 * directory rejects instead of publishing into it.
 */
export async function resolveSymlinkWriteTarget(filePath: string): Promise<string> {
	return assertFileWriteTarget(filePath, await resolveSymlinkTargetPath(filePath));
}

/**
 * A resolved target that exists as anything but a REGULAR FILE can never be
 * published to: rename() over a directory fails EISDIR on POSIX, and on
 * Windows the `EPERM` replacement fallback would move the directory aside
 * and drop the config file in its place; over a FIFO, socket, or device it
 * would silently DESTROY the special object. Reject the write up front; a
 * missing leaf is the normal recreate case and passes through.
 */
async function assertFileWriteTarget(filePath: string, resolved: string): Promise<string> {
	try {
		if (!(await fs.promises.stat(resolved)).isFile()) {
			throw enotDir(`config write target is not a regular file (${resolved}) for ${filePath}`);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return resolved;
}

async function resolveSymlinkTargetPath(filePath: string): Promise<string> {
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
	// ONE shared budget for every symlink this resolution traverses: the
	// final-component chain below AND the intermediate links spliced inside
	// the segment walks. The kernel's MAXSYMLINKS caps the TOTAL traversals
	// for one open, so independent per-walk counters could resolve 1 + 40
	// hops and "successfully" publish to a referent the repaired link can
	// never reach — opening it surfaces ELOOP forever after.
	const hopBudget = { hops: 0 };
	try {
		if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
			let current = filePath;
			for (;;) {
				// realpath() rejects a fully-linked cycle up front, so we only
				// reach the manual walk on a chain that dangles today. It can
				// still turn cyclic mid-walk if another process retargets an
				// intermediate link, at which point readlink() would alternate
				// forever. Cap the hops and surface an ELOOP so a cycle has
				// bounded behavior instead of hanging the writer.
				if (++hopBudget.hops > MAX_SYMLINK_HOPS) throw symlinkHopOverflow(filePath);
				let target: string;
				try {
					target = await fs.promises.readlink(current);
				} catch (error) {
					if (!isEnoent(error)) throw error;
					// An intermediate link vanished mid-walk: it was confirmed a
					// symlink by the lstat below on the prior hop, then removed
					// before this readlink. Land on the deepest hop we resolved
					// rather than collapsing to the chain head, which would let
					return current === filePath ? walkOriginalSpelling(filePath, hopBudget) : current;
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
				const resolved = await walkPhysicalSegments(filePath, acc, physicalTargetSegments(target), hopBudget);

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
	return walkOriginalSpelling(filePath, hopBudget);
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
function walkOriginalSpelling(filePath: string, hopBudget: { hops: number }): Promise<string> {
	const cwd = process.cwd();
	const spelling = path.isAbsolute(filePath) ? filePath : `${cwd}${path.sep}${filePath}`;
	return walkPhysicalSegments(filePath, path.parse(spelling).root, physicalTargetSegments(spelling), hopBudget);
}

/** The result of one physical segment walk: where it landed, whether
 * that path is a FROZEN (missing-on-disk) resolution whose direct continuations
 * must repair before traversing, and whether the walked spelling ENDED naming
 * a directory (a trailing `/` or `/.`) whose demand is still outstanding —
 * deferred because an ENCLOSING walk may append further segments through that
 * directory, which dissolves the demand; only a walk that ends terminally
 * with it names a directory and must surface ENOTDIR. */
interface SegmentWalkResult {
	path: string;
	frozen: boolean;
	pendingDir: boolean;
}

/**
 * Walk `segments` physically from a canonical `acc`, in two phases with
 *
 *  - LIVE (`walkLive`): every component exists on disk. `realpath()` follows
 *    live symlinks, `..` pops the PHYSICAL parent (TOCTOU-checked), trailing
 *    separators demand directories, and a DANGLING symlink component is
 *    followed by recursing into its target segments — bounded by the shared
 *    `hopBudget`. A splice that ends FROZEN (its referent missing)
 *    marks the accumulator: a `..` directly after it in the CONFIG's own
 *    spelling repairs the missing component by materializing it, the same
 *    fix the frozen phase applies for a plainly-missing `X/../leaf`.
 *  - FROZEN (`frozenTail`): a plainly-missing component stops physical
 *    traversal. The remaining segments are checked against the frozen-tail
 *    grammar — the explicit supported-subset contract — and either join
 *    lexically (the writer's mkdir covers them), repair the one fixable
 *    `X/../leaf` spelling, or reject with a clear ENOTDIR.
 *
 * A component may only be "entered" once it exists. Anything the live phase
 * returns after a freeze is missing on disk by construction: a following
 * trailing separator still stats it and surfaces ENOTDIR — the one
 * deliberate exception is the `..` repair above, because the spelling only
 * becomes resolvable by entering the materialized component.
 */
async function walkPhysicalSegments(
	filePath: string,
	acc: string,
	segments: readonly string[],
	hopBudget: { hops: number },
): Promise<string> {
	// `hopBudget` is SHARED with the chain loop in resolveSymlinkTargetPath:
	// the kernel's MAXSYMLINKS caps the total symlink traversals for one
	// open, so every link this resolution follows — final-component chain
	// hops and intermediate-link splices alike — must draw on one budget.
	// Both reject the forty-first traversal, matching Linux's MAXSYMLINKS.
	// Materializing a missing component races any concurrent creator (or
	// remover) of the same path; bound the retries so adversarial churn
	// surfaces an error instead of hanging the writer.
	let repairs = 0;

	const materializeComponent = async (component: string): Promise<void> => {
		if (++repairs > MAX_SYMLINK_HOPS) {
			throw enotDir(`component ${component} kept disappearing while being materialized for ${filePath}`);
		}
		await fs.promises.mkdir(component, { recursive: true, mode: 0o700 });
	};

	const walkLive = async (
		liveAcc: string,
		liveSegments: readonly string[],
		repairAllowed: boolean,
	): Promise<SegmentWalkResult> => {
		let index = 0;
		// Set while `liveAcc` came from a splice that FROZE on a missing
		// referent — a path that does not exist on disk yet.
		let accFrozen = false;
		while (index < liveSegments.length) {
			const segment = liveSegments[index++];
			if (segment === "" || segment === ".") {
				// An interior separator or `.` is inert. A TRAILING one
				// demands `liveAcc` be a traversable directory — it was
				// canonical moments ago, but a concurrent process can have
				// replaced it with a regular file, and dropping the segment
				// would then land the rename on top of that file while the
				// logical config path is really ENOTDIR. Verify.
				if (index < liveSegments.length) continue;
				const accStat = await statTraversingDirectory(liveAcc, filePath, "trailing separator");
				if (!accStat.isDirectory()) {
					throw enotDir(`symlink target requires a directory but ${liveAcc} is not one for ${filePath}`);
				}
				continue;
			}
			if (segment === "..") {
				// A `..` directly after a spliced FROZEN component would stat
				// a path that does not exist. When the `..` belongs to the
				// config's own spelling AND a file leaf still follows, repair
				// by materializing the missing component — the same fix
				// `frozenTail` performs for a plainly-missing `X/../leaf` —
				// and re-enter it physically so the pop follows whatever the
				// concurrent filesystem holds. A spelling that ENDS at the
				// `..` names a directory (rejected regardless) and must not
				// materialize anything just to discover that.
				if (accFrozen && repairAllowed && liveSegments.slice(index).some(isPlainName)) {
					await materializeComponent(liveAcc);
					return walkLive(
						path.dirname(liveAcc),
						[path.basename(liveAcc), ...liveSegments.slice(index - 1)],
						repairAllowed,
					);
				}
				// Pops only the PHYSICAL parent: `liveAcc` was canonicalized by
				// realpath() moments ago, but a concurrent process can replace
				// it with a regular file before this pop — lexically popping
				// then would land the rename on a mislocated sibling
				// (`config.yml -> racetarget/../victim.yml`). Verify first.
				const accStat = await statTraversingDirectory(liveAcc, filePath, "'..'");
				if (!accStat.isDirectory()) {
					throw enotDir(`symlink target requires a directory but ${liveAcc} is not one for ${filePath}`);
				}
				liveAcc = path.dirname(liveAcc);
				continue;
			}
			const candidate = path.join(liveAcc, segment);
			try {
				liveAcc = await fs.promises.realpath(candidate);
				accFrozen = false;
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			// The component is missing — but it may itself be a DANGLING
			// SYMLINK whose referent the write should recreate
			// (`mcp.json -> alias/config.json` with `alias -> missing-dir`).
			// Freezing on the link path would leave the writer unable to
			// create anything THROUGH the link; follow it instead, so
			// intermediate links survive exactly like final-component chains
			// do. A cycle among dangling links (`a -> b`, `b -> a`) never
			// reaches the outer chain check, so the budget is what surfaces
			// it as a bounded ELOOP.
			let linkTarget: string | undefined;
			try {
				if ((await fs.promises.lstat(candidate)).isSymbolicLink()) {
					linkTarget = await fs.promises.readlink(candidate);
				}
			} catch (lstatError) {
				if (!isEnoent(lstatError)) throw lstatError;
			}
			if (linkTarget !== undefined) {
				if (++hopBudget.hops > MAX_SYMLINK_HOPS) throw symlinkHopOverflow(filePath);
				// An absolute target re-anchors at its root; a relative one
				// resolves against the canonical accumulator we stand on.
				// The followed link's segments are the LINK author's spelling,
				// so repairs stay disabled inside them — except for a `..` the
				// CONFIG's own continuation places right after the splice,
				// which the frozen-accumulator branch above repairs.
				const anchor = path.isAbsolute(linkTarget) ? path.parse(linkTarget).root : liveAcc;
				const spliced = await walkLive(anchor, physicalTargetSegments(linkTarget), false);
				if (spliced.pendingDir && index >= liveSegments.length) {
					// The link's own spelling ends naming a directory. Nothing in
					// THIS walk continues past it, so defer the demand upward: an
					// enclosing walk may still append its own segments through that
					// directory (`~/.omp -> /missing/dotfiles/` while the writer
					// targets `~/.omp/mcp.json`), which dissolves it; only the
					// outermost walk treats a still-terminal demand as ENOTDIR.
					return { path: spliced.path, frozen: spliced.frozen, pendingDir: true };
				}
				liveAcc = spliced.path;
				accFrozen = spliced.frozen;
				continue;
			}
			// Plainly missing: freeze here and interpret the remainder.
			return await frozenTail(candidate, liveSegments.slice(index), repairAllowed);
		}
		return { path: liveAcc, frozen: accFrozen, pendingDir: false };
	};

	const frozenTail = async (
		frozenPath: string,
		tail: readonly string[],
		repairAllowed: boolean,
	): Promise<SegmentWalkResult> => {
		// The grammar of segments following a plainly-missing component —
		// the SUPPORTED SUBSET of dangling-target spellings. Everything else
		// rejects with a clear ENOTDIR: the kernel cannot take the parent of
		// a path it never entered, and guessing where a `..` would land puts
		// the write on an unrelated file while the link stays unusable.
		//
		//   lexical   `X a/b/…`      missing ancestors of the result; the
		//                             writer's recursive mkdir creates them
		//   repair    `X ../leaf…`   `X` materialized as a 0700 directory and
		//                             re-entered physically, so `..` pops the
		//                             parent of whatever `X` is NOW (a
		//                             concurrent creator may have made it a
		//                             symlink); the all-plain leaf resolves
		//                             beside it
		//   inert     interior `//` and `./` fold into the two shapes above
		//   deferred  a TRAILING `/` or `/.` names a directory: returned as
		//                             `pendingDir` rather than rejected,
		//                             because an enclosing walk may append its
		//                             own segments through that directory;
		//                             only the outermost walk converts a
		//                             still-terminal demand to ENOTDIR
		//
		// Rejected: `..` after lexically appended names (`X/a/..` — needs
		// `X/a` entered), a bare or repeated `X/..`/`X/../..` (names a
		// directory, and a config publish needs a file leaf), `X/../` (a `..`
		// the separator demands be entered first), and any `..` inside a
		// FOLLOWED LINK's target (the missing name belongs to the link
		// author's world; only the config's own spelling is ours to repair).
		const stripped: string[] = [];
		for (const [i, seg] of tail.entries()) {
			if ((seg === "" || seg === ".") && i < tail.length - 1) continue;
			stripped.push(seg);
		}
		if (stripped.length === 0) return { path: frozenPath, frozen: true, pendingDir: false };
		const last = stripped[stripped.length - 1];
		if (last === "" || last === ".") {
			// The spelling ends demanding a directory. An enclosing walk may
			// still append its own segments THROUGH that directory — any
			// continuation requires one there anyway and the writer's mkdir
			// creates it — so defer via `pendingDir` instead of throwing. A
			// `..` before the separator (`X/../`) cannot be joined lexically
			// and stays a hard rejection.
			const before = stripped.slice(0, -1);
			if (!before.every(isPlainName)) {
				throw enotDir(`symlink target requires a directory for the missing component ${frozenPath} (${filePath})`);
			}
			return { path: path.join(frozenPath, ...before), frozen: true, pendingDir: true };
		}
		const leaf = stripped[0] === ".." ? stripped.slice(1) : stripped;
		if (leaf.some(seg => !isPlainName(seg)) || (stripped[0] === ".." && (leaf.length === 0 || !repairAllowed))) {
			throw enotDir(`cannot resolve '..' past an unresolved component in symlink target for ${filePath}`);
		}
		if (stripped[0] !== "..") return { path: path.join(frozenPath, ...stripped), frozen: true, pendingDir: false };
		// Repair `X/../leaf`: materialize `X`, then RE-ENTER it physically
		// instead of popping lexically — between the failed lstat and the
		// mkdir another process can create `X` as a symlink to an existing
		// directory (recursive mkdir succeeds through it), and the original
		// spelling then resolves THROUGH that link: `..` must pop the
		// referent's REAL parent, or the write lands on an unrelated lexical
		// sibling while reporting success.
		await materializeComponent(frozenPath);
		return walkLive(path.dirname(frozenPath), [path.basename(frozenPath), "..", ...leaf], repairAllowed);
	};

	const result = await walkLive(acc, segments, true);
	if (result.pendingDir) {
		throw enotDir(`symlink target requires a directory but resolves to ${result.path} (${filePath})`);
	}
	return result.path;
}

/** A plain path-name segment — not a separator, dot, or parent traversal. */
function isPlainName(segment: string): boolean {
	return segment !== "" && segment !== "." && segment !== "..";
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

/** Surface a bounded ELOOP when one resolution's total symlink traversals
 * would exceed the kernel's MAXSYMLINKS: publishing past that budget would
 * land the write on a referent the repaired link can never open. */
function symlinkHopOverflow(filePath: string): Error & { code?: string } {
	const cyclic = new Error(
		`ELOOP: symlink chain for ${filePath} exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle)`,
	) as Error & { code?: string };
	cyclic.code = "ELOOP";
	return cyclic;
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
 * rename cannot EXDEV across mounts) and is fsync'd before the rename — the
 * durability the YAML settings flush always had, now shared by every config
 * writer. Its mode takes only the OWNER bits of the referent's current mode —
 * credential-bearing configs drop group/world bits exactly like an
 * unconditional 0o600 did — and only while the owner keeps READ access:
 * stricter-but-readable owner modes (e.g. a read-only 0o400 dotfiles
 * checkout) survive, while a referent whose access comes from group/world
 * bits or an ACL, or is owner-write-only (0o200, e.g. 0o266 & 0o700 — the
 * rename hands the replacement to the caller, who could not read it back),
 * falls back to owner-only 0o600 — chmod'd explicitly because creation
 * modes pass through umask. The rename itself goes
 * through {@link replaceFileAtomically}, so Windows `EPERM`/`EEXIST`
 * replacement failures recover instead of failing the write.
 */
export async function publishSerializedConfig(writePath: string, content: string): Promise<void> {
	const dir = path.dirname(writePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	let mode = 0o600;
	try {
		const referentMode = (await fs.promises.stat(writePath)).mode & 0o700;
		// Preserve the owner bits only when they include owner-read: without
		// 0o400 the replacement would be unreadable by its (new) owner —
		// access used to arrive via group/world bits on someone else's file,
		// which the owner-bit mask already strips. This also covers the
		// all-bits-via-group/world case (mask 0).
		if ((referentMode & 0o400) !== 0) mode = referentMode;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const tmpPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
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
	return withResolvedConfigFileLock(await resolveSymlinkWriteTarget(filePath), fn);
}

/**
 * {@link withConfigFileLock} for callers that resolve the write target
 * THEMSELVES — e.g. the YAML settings flush, which honors its quarantine map
 * before locking. Sharing this keeps the materialized parent's hardened 0700
 * creation mode and the pinned-callback contract identical for every config
 * writer instead of maintaining a parallel resolve/mkdir/lock path.
 */
export async function withResolvedConfigFileLock<T>(
	writePath: string,
	fn: (writePath: string) => Promise<T>,
): Promise<T> {
	await fs.promises.mkdir(path.dirname(writePath), {
		recursive: true,
		mode: 0o700,
	});
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
