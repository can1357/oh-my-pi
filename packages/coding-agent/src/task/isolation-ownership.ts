/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

const { IsoBackendKind } = natives;

/** Marker file written into a task-isolation base dir identifying its owner. */
export const ISOLATION_OWNER_FILE = ".omp-isolation-owner.json";

/** Marker file written into a task-isolation base dir recording materialization completion. */
export const ISOLATION_MATERIALIZED_FILE = ".omp-isolation-materialized";

/**
 * Write a materialization completion marker in `baseDir` (outside `m/`).
 *
 * Its filesystem `ctimeMs` serves as the reference timestamp for ignored-path
 * change detection. Because userspace cannot alter `ctime`, any file created or
 * modified by the task has `ctimeMs` strictly greater than this marker.
 */
export async function writeMaterializationMarker(baseDir: string): Promise<void> {
	await Bun.write(path.join(baseDir, ISOLATION_MATERIALIZED_FILE), "");
}

/**
 * Read the filesystem `ctimeMs` of the materialization marker in `baseDir`, or
 * `null` if missing or unreadable.
 */
export async function readMaterializationCtime(baseDir: string): Promise<number | null> {
	try {
		const stat = await fs.stat(path.join(baseDir, ISOLATION_MATERIALIZED_FILE));
		return stat.ctimeMs;
	} catch {
		return null;
	}
}

/** Recorded owner of a task-isolation sandbox. */
export interface IsolationOwner {
	/** PID of the omp process that created and owns the sandbox. */
	pid: number;
	/** Task id the sandbox was materialised for. */
	id: string;
	/**
	 * Process-instance start-time token for {@link pid}, when the OS can report
	 * it. Distinguishes the owning process from an unrelated process that later
	 * inherits a recycled pid, so a crashed sandbox is never pinned live.
	 */
	startToken?: string;
	/** Parent repository root, so dead sandboxes can be compared against the parent checkout. */
	parentRepo?: string;
	/** Backend kind used to materialise the sandbox, when known. */
	backend?: number;
}

/**
 * Boot-stable start-time token for `pid`, or `null` when the process is gone or
 * the platform cannot report it. Read from the same source on write and
 * validate so an exact string compare rejects a recycled pid.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot); other Unixes shell out to `ps -o lstart`. Platforms that report
 * neither (e.g. Windows) yield `null`, degrading to a pid-only liveness check.
 */
async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}

/**
 * Record the current process as owner of the sandbox rooted at `baseDir`.
 *
 * Written before the isolation backend materialises `m` so a concurrent
 * `omp worktree clear` never sees an owner-less sandbox mid-creation.
 */
export async function writeIsolationOwner(
	baseDir: string,
	id: string,
	parentRepo?: string,
	backend?: number,
): Promise<void> {
	const startToken = await processStartToken(process.pid);
	const owner: IsolationOwner = {
		pid: process.pid,
		id,
		...(startToken ? { startToken } : {}),
		...(parentRepo ? { parentRepo } : {}),
		...(backend !== undefined ? { backend } : {}),
	};
	await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
}

/**
 * Whether a live omp process still owns the sandbox at `baseDir`.
 *
 * A missing or malformed marker means no verifiable owner — a crashed run or a
 * sandbox from before markers existed, both safe to reclaim. `process.kill(pid,
 * 0)` can fail with `EPERM` even when the process is alive, so only an explicit
 * `ESRCH` ("no such process") counts as dead; any other error is treated as
 * alive to avoid deleting a sandbox that is actually in use. When the marker
 * carries a {@link IsolationOwner.startToken}, a live pid whose current token no
 * longer matches is a recycled pid — a different process — and counts as dead.
 */
export async function hasLiveIsolationOwner(baseDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch {
		return false;
	}
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return false;
	const pid = decoded.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	// The pid is live (or unknowable via EPERM). Reject a recycled pid: if the
	// marker pinned the owner's start-time token, the process wearing that pid
	// now must still present the same token.
	if ("startToken" in decoded && typeof decoded.startToken === "string" && decoded.startToken.length > 0) {
		const current = await processStartToken(pid);
		if (current !== null && current !== decoded.startToken) return false;
	}
	return true;
}

/** Sidecar recording the native-teardown backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".omp-retained-backend.json";

/**
 * Backends whose workspaces `omp worktree clear` must not remove with plain
 * recursive `rm`, but route through native `isoStop` teardown instead:
 * mounts (overlayfs, projfs), where `rm` destroys the preserved layer and
 * fails on the mountpoint, and Btrfs subvolumes, whose root is only removable
 * via subvolume delete (its `stop` falls back to plain `rm` for ordinary
 * dirs, so routing it is always safe). Plain-copy and reflink backends need
 * no teardown — and their `stop` routines delete data themselves, so they
 * must never be routed through it.
 *
 * Notably absent: ZFS clones also need dataset-aware teardown, but `isoStop`
 * locates the dataset by its recorded mountpoint property, which no longer
 * matches after the retain rename — that needs pi-iso mount-table support
 * before a sidecar here could help.
 */
export function needsNativeTeardown(backend: unknown): backend is number {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Projfs || backend === IsoBackendKind.Btrfs;
}

/**
 * Record which backend built a retained workspace, so cleanup can route it
 * through native teardown before removal. Best-effort: retention stays valid
 * without it (the workspace merely falls back to plain recursive removal).
 */
export async function writeRetainedBackend(baseDir: string, backend: number): Promise<void> {
	await Bun.write(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
	);
}

/**
 * Backend recorded for a retained workspace when it needs native teardown
 * before remove. `undefined` only when no sidecar exists. Any other read
 * problem (permissions, I/O, malformed JSON) throws instead of reading as
 * absent: the workspace may be a live mount whose guard must not be silently
 * bypassed — the caller then leaves it in place rather than removing through
 * the mount. A well-formed record for a backend needing no teardown keeps
 * today's removal behavior.
 */
export async function readRetainedMountBackend(dir: string): Promise<number | undefined> {
	const sidecar = path.join(dir, RETAINED_BACKEND_FILE);
	if (await Bun.file(sidecar).exists()) {
		const decoded: unknown = await Bun.file(sidecar).json();
		if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
			throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
		}
		const backend = decoded.backend;
		if (typeof backend !== "number" || !Number.isInteger(backend)) {
			throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
		}
		if (!needsNativeTeardown(backend)) return undefined;
		return backend;
	}

	const ownerFile = path.join(dir, ISOLATION_OWNER_FILE);
	if (await Bun.file(ownerFile).exists()) {
		try {
			const decoded: unknown = await Bun.file(ownerFile).json();
			if (typeof decoded === "object" && decoded !== null && "backend" in decoded) {
				const backend = decoded.backend;
				if (typeof backend === "number" && Number.isInteger(backend) && needsNativeTeardown(backend)) {
					return backend;
				}
			}
		} catch {}
	}

	return undefined;
}

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface UniqueWorkCheckResult {
	hasUniqueWork: boolean;
	reason?: string;
	parentRepo?: string;
}

/**
 * Return relative paths of linked worktrees registered in `repoRoot` that lie inside `repoRoot`.
 */
export async function getNestedLinkedWorktrees(repoRoot: string): Promise<string[]> {
	const worktrees = await vcs.listWorktrees(repoRoot);
	const nested: string[] = [];
	const realRoot = await fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
	for (const wt of worktrees) {
		const rawPath = wt.path;
		const realWt = await fs.realpath(rawPath).catch(() => path.resolve(rawPath));
		const rel = path.relative(realRoot, realWt);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			nested.push(rel);
		}
	}
	return nested;
}

/**
 * Whether `relPath` lies within any of the `nestedWorktrees` relative paths.
 */
export function isUnderNestedWorktree(relPath: string, nestedWorktrees: string[]): boolean {
	const normalized = path.normalize(relPath);
	for (const wt of nestedWorktrees) {
		const normWt = path.normalize(wt);
		if (normalized === normWt || normalized.startsWith(normWt + path.sep) || normalized.startsWith(normWt + "/")) {
			return true;
		}
	}
	return false;
}

const COMPARISON_CHUNK_SIZE = 64 * 1024;

async function filesDiffer(pathA: string, pathB: string): Promise<boolean> {
	const [statA, statB] = await Promise.all([fs.lstat(pathA).catch(() => null), fs.lstat(pathB).catch(() => null)]);

	if (!statA && !statB) return false;
	if (!statA || !statB) return true;

	if (statA.isSymbolicLink() !== statB.isSymbolicLink()) return true;
	if (statA.isDirectory() !== statB.isDirectory()) return true;

	if (statA.isSymbolicLink()) {
		const [linkA, linkB] = await Promise.all([
			fs.readlink(pathA).catch(() => null),
			fs.readlink(pathB).catch(() => null),
		]);
		return linkA !== linkB;
	}

	if (statA.isDirectory()) return false;

	if (statA.size !== statB.size) return true;

	// Incremental streaming comparison in fixed 64KB chunks to avoid large allocations
	let fdA: fs.FileHandle | undefined;
	let fdB: fs.FileHandle | undefined;
	try {
		fdA = await fs.open(pathA, "r");
		fdB = await fs.open(pathB, "r");
		const bufA = Buffer.alloc(COMPARISON_CHUNK_SIZE);
		const bufB = Buffer.alloc(COMPARISON_CHUNK_SIZE);
		let position = 0;
		while (position < statA.size) {
			const toRead = Math.min(COMPARISON_CHUNK_SIZE, statA.size - position);
			const [resA, resB] = await Promise.all([
				fdA.read(bufA, 0, toRead, position),
				fdB.read(bufB, 0, toRead, position),
			]);
			if (resA.bytesRead !== resB.bytesRead) return true;
			if (resA.bytesRead === 0) break;
			if (!bufA.subarray(0, resA.bytesRead).equals(bufB.subarray(0, resB.bytesRead))) {
				return true;
			}
			position += resA.bytesRead;
		}
		return false;
	} catch {
		// Read/stat error -> cannot prove identical -> conservatively keep
		return true;
	} finally {
		await Promise.all([fdA?.close().catch(() => {}), fdB?.close().catch(() => {})]);
	}
}

// Ignored path change detection:
// Userspace cannot forge or backdate filesystem ctime. Files produced during
// materialization (APFS clonefile, reflink, rcopy) have ctimeMs at or before the
// materialization reference marker written outside m/ immediately after clone.
// Any file or directory created, modified, renamed, or attribute-changed after
// materialization has ctimeMs > markerCtimeMs, identifying unique work without
// expensive parent lookups or full-tree content comparisons. The marker resides
// in the sandbox base dir (outside m/) so it never appears in git status.
const MAX_IGNORED_ENTRIES_CHECKED = 1_000_000;

interface IgnoredInspectionState {
	entriesChecked: number;
}

async function checkIgnoredTreeModified(
	entryPath: string,
	relPath: string,
	markerCtimeMs: number,
	nestedWorktrees: string[],
	state: IgnoredInspectionState,
): Promise<{ hasUniqueWork: boolean; reason?: string }> {
	const stat = await fs.lstat(entryPath).catch(() => null);
	if (!stat) {
		return { hasUniqueWork: true, reason: `cannot stat ignored path ${relPath}` };
	}

	state.entriesChecked += 1;
	if (state.entriesChecked > MAX_IGNORED_ENTRIES_CHECKED) {
		return {
			hasUniqueWork: true,
			reason: `ignored entries exceed safety limit (${MAX_IGNORED_ENTRIES_CHECKED} entries)`,
		};
	}

	// Yield to event loop periodically so large walks stay async and non-blocking
	if (state.entriesChecked % 1024 === 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}

	if (stat.ctimeMs > markerCtimeMs) {
		return {
			hasUniqueWork: true,
			reason: `ignored path ${relPath} modified after materialization`,
		};
	}

	if (stat.isDirectory()) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(entryPath, { withFileTypes: true });
		} catch (err) {
			return {
				hasUniqueWork: true,
				reason: `cannot read ignored directory ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		for (const entry of entries) {
			const childRel = path.join(relPath, entry.name);
			if (isUnderNestedWorktree(childRel, nestedWorktrees)) {
				continue;
			}
			const childPath = path.join(entryPath, entry.name);
			const childResult = await checkIgnoredTreeModified(childPath, childRel, markerCtimeMs, nestedWorktrees, state);
			if (childResult.hasUniqueWork) return childResult;
		}
	}

	return { hasUniqueWork: false };
}

/**
 * Check whether a dead task-isolation sandbox holds unmerged work that must be preserved.
 *
 * Contract: A dead sandbox holds unique work if its `m/` copy has:
 * (a) any commit reachable from its local refs/HEAD/stash that the parent repo does not have, or
 * (b) any changed or untracked file (git status, untracked=all, ignoring paths under nested
 *     linked-worktree dirs) whose content differs from the same path in the parent checkout or
 *     represents an unmerged addition, or
 * (c) any ignored path (git status, ignored=matching) created, modified, renamed, or
 *     attribute-changed after materialization, judged by ctime against the reference marker.
 *
 * Inability to inspect repository metadata, read files, or classify sandbox state is treated
 * conservatively as unknown work (preserve).
 */
export async function inspectIsolationUniqueWork(baseDir: string): Promise<UniqueWorkCheckResult> {
	let mountDir: string | undefined;
	for (const name of TASK_ISOLATION_MOUNT_DIRS) {
		const candidate = path.join(baseDir, name);
		const stat = await fs.stat(candidate).catch(() => null);
		if (stat?.isDirectory()) {
			mountDir = candidate;
			break;
		}
	}

	if (!mountDir) {
		return { hasUniqueWork: false };
	}

	// Locate parent repo
	let parentRepo: string | undefined;
	try {
		const ownerFile = path.join(baseDir, ISOLATION_OWNER_FILE);
		const ownerData = await Bun.file(ownerFile).json();
		if (typeof ownerData?.parentRepo === "string" && ownerData.parentRepo) {
			parentRepo = ownerData.parentRepo;
		}
	} catch {}

	if (!parentRepo) {
		try {
			const altFile = path.join(mountDir, ".git", "objects", "info", "alternates");
			if (await Bun.file(altFile).exists()) {
				const altText = await Bun.file(altFile).text();
				const firstLine = altText
					.split("\n")
					.map(l => l.trim())
					.find(l => l.length > 0);
				if (firstLine) {
					const objDir = path.resolve(firstLine);
					const gitDir = path.dirname(objDir);
					const repo = vcs.git(gitDir);
					if (repo) {
						parentRepo = repo.info().repoRoot;
					}
				}
			}
		} catch {}
	}

	const hasGitDir = await fs
		.stat(path.join(mountDir, ".git"))
		.then(() => true)
		.catch(() => false);

	if (!parentRepo) {
		if (!hasGitDir) {
			// No git metadata and unknown parent: dummy test mock or empty stray
			return { hasUniqueWork: false };
		}
		// Git repo exists but parent cannot be determined: conservatively preserve
		return { hasUniqueWork: true, reason: "parent repository unknown" };
	}

	// With a known parent repo but missing or unreadable sandbox `.git`, commits and status
	// cannot be inspected. Inability to inspect means unknown work, so keep the sandbox.
	if (!hasGitDir) {
		return {
			hasUniqueWork: true,
			reason: "sandbox git repository missing or unreadable",
			parentRepo,
		};
	}

	const parentStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentStat?.isDirectory()) {
		return { hasUniqueWork: true, reason: `parent repository missing (${parentRepo})`, parentRepo };
	}

	// (a) Check for unique commits reachable from local refs/HEAD/stash
	const commitTips = new Set<string>();

	const headSha = await vcs.getHeadSha(mountDir);
	if (headSha) commitTips.add(headSha);

	const refShas = await vcs.listRefShas(mountDir, ["refs/heads/", "refs/tags/"]);
	for (const sha of refShas) {
		commitTips.add(sha);
	}

	const stashShas = await vcs.listStashShas(mountDir);
	for (const sha of stashShas) {
		commitTips.add(sha);
	}

	for (const sha of commitTips) {
		const present = await vcs.hasCommit(parentRepo, sha);
		if (!present) {
			return {
				hasUniqueWork: true,
				reason: `unique commit ${sha.slice(0, 8)} not in parent repo`,
				parentRepo,
			};
		}
	}

	// (b) Check for changed, untracked, and ignored files
	const nestedWorktrees = await getNestedLinkedWorktrees(parentRepo);
	let statusOutput: string;
	try {
		statusOutput = await vcs.statusPorcelain(mountDir, { untracked: "all", ignored: "matching" });
	} catch (err) {
		return {
			hasUniqueWork: true,
			reason: `git status failed in sandbox: ${err instanceof Error ? err.message : String(err)}`,
			parentRepo,
		};
	}

	if (statusOutput.trim().length > 0) {
		const lines = statusOutput.split("\n");
		let markerCtimeMs: number | null | undefined;
		const ignoredInspectionState: IgnoredInspectionState = { entriesChecked: 0 };
		for (const line of lines) {
			if (!line.trim()) continue;
			const statusCode = line.slice(0, 2);
			let filePath = line.slice(3).trim();
			if (filePath.includes(" -> ")) {
				filePath = filePath.split(" -> ").pop()!.trim();
			}
			if (filePath.startsWith('"') && filePath.endsWith('"')) {
				try {
					filePath = JSON.parse(filePath);
				} catch {}
			}

			if (isUnderNestedWorktree(filePath, nestedWorktrees)) {
				continue;
			}

			const sandboxFile = path.join(mountDir, filePath);
			const parentFile = path.join(parentRepo, filePath);

			if (statusCode === "!!") {
				// Lazy-read materialization marker when ignored entries exist.
				// A missing or unreadable marker when ignored files exist means unknown -> keep.
				if (markerCtimeMs === undefined) {
					markerCtimeMs = await readMaterializationCtime(baseDir);
				}
				if (markerCtimeMs === null) {
					return {
						hasUniqueWork: true,
						reason: "missing or unreadable materialization reference marker",
						parentRepo,
					};
				}

				const result = await checkIgnoredTreeModified(
					sandboxFile,
					filePath,
					markerCtimeMs,
					nestedWorktrees,
					ignoredInspectionState,
				);
				if (result.hasUniqueWork) {
					return {
						hasUniqueWork: true,
						reason: result.reason,
						parentRepo,
					};
				}
			} else {
				// Tracked modified/staged or untracked file
				if (await filesDiffer(sandboxFile, parentFile)) {
					return {
						hasUniqueWork: true,
						reason: `file ${filePath} differs from parent checkout`,
						parentRepo,
					};
				}
			}
		}
	}

	return { hasUniqueWork: false, parentRepo };
}
