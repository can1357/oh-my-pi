/**
 * CLI handler for `omp worktree` — list and clean up agent-managed worktrees.
 *
 * Layout under `~/.omp/wt/`:
 *
 *   - **PR-checkout worktrees** (`tools/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. `ensureIsolation` writes an ownership
 *     marker naming the live omp process; a
 *     sandbox whose owner is still running is reported `live` and never
 *     removed without `--all`, so `clear` reclaims only crashed leftovers.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */
import * as fs from "../task/isolation-fs";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, Snowflake } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import {
	decideIsolationReclaim,
	ISOLATION_REMOVING_SUFFIX,
	requireSandboxLockHeld,
	withSandboxLock,
	ISOLATION_OWNER_FILE,
	readRetainedMountBackend,
	resolveSandboxIdentity,
} from "../task/isolation-ownership";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";

import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.omp/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `omp worktree clear` will remove it. */
	orphanReason?: string;
	/**
	 * Set when this process could not read the entry. It is listed so the user
	 * sees it, and never removed: a failure to look is not a licence to delete.
	 */
	keep?: boolean;
}

export interface AddWorktreeOptions {
	cwd?: string;
	path: string;
	commit?: string;
	branch?: string;
	forceBranch?: string;
	detach: boolean;
	quiet: boolean;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}
/**
 * Run native teardown on a retained workspace before recursive removal.
 * Recursive `rm` through a live overlay mount destroys the preserved upper
 * layer entry by entry and then fails on the mountpoint itself (likewise a
 * Btrfs subvolume root, removable only via subvolume delete) — and mounts
 * survive the owning session, so the reclaim path (unlike teardown) cannot
 * rely on the creator to stop them. Side-effect-free without a retained-
 * backend sidecar (returns false); throws when the sidecar cannot be read
 * or teardown itself fails, so the caller skips removal instead of
 * traversing a possibly live mount — the entry is then reported failed
 * with the error, data intact.
 */
export async function stopRetainedMount(dir: string): Promise<boolean> {
	const backend = await readRetainedMountBackend(dir);
	if (backend === undefined) return false;
	for (const name of TASK_ISOLATION_MOUNT_DIRS) {
		const candidate = path.join(dir, name);
		// A stat that failed is not a mount directory that is absent. Reading
		// it as absent skipped the native stop and left the next step — a
		// recursive removal — pointed at what may still be a mount.
		const found = await fs.statLookup(candidate);
		if (found.kind === "unknown") {
			throw new Error(
				`Isolation workspace ${dir} records a ${backend} mount, and ${candidate} could not be read ` +
					`(${found.reason}); refusing to remove it without stopping the mount.`,
			);
		}
		if (found.kind === "absent" || !found.value.isDirectory()) continue;
		await natives.isoStop(backend, candidate);
		return true;
	}
	// The sidecar names a mount backend and no mount directory is here: the
	// workspace is not in the shape this guard knows, so it is not removed.
	throw new Error(
		`Isolation workspace ${dir} records a ${backend} mount, but none of ${TASK_ISOLATION_MOUNT_DIRS.join(", ")} ` +
			"is there; refusing to remove it.",
	);
}

export async function addWorktree(options: AddWorktreeOptions): Promise<void> {
	if (options.branch && options.forceBranch) {
		throw new Error("fatal: options '-b' and '-B' cannot be used together");
	}
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const repository = vcs.requireGit(cwd);
	const worktreePath = path.resolve(cwd, options.path);
	// Absent is the ordinary case — the worktree is about to be created here.
	// Anything else is a path this process could not inspect, and creating a
	// worktree over it would be the same guess the rest of this file refuses.
	const existing = await fs.statLookup(worktreePath);
	if (existing.kind === "unknown") {
		throw new Error(`fatal: '${options.path}' could not be inspected: ${existing.reason}`);
	}
	if (existing.kind === "found") {
		const listing = existing.value.isDirectory() ? await fs.readdirLookup(worktreePath) : undefined;
		if (listing?.kind === "unknown") {
			throw new Error(`fatal: '${options.path}' could not be listed: ${listing.reason}`);
		}
		if (listing === undefined || listing.kind === "absent" || listing.value.length > 0) {
			throw new Error(`fatal: '${options.path}' already exists`);
		}
	}

	const settings = await Settings.init({ cwd });
	let ref: string;
	let detach = false;
	let createdBranch: string | undefined;
	if (options.branch || options.forceBranch) {
		const branch = options.branch ?? options.forceBranch;
		if (!branch) throw new Error("branch name is required");
		await repository.createBranch(branch, options.commit ?? "HEAD", Boolean(options.forceBranch));
		ref = branch;
		createdBranch = branch;
	} else if (options.detach) {
		ref = options.commit ?? "HEAD";
		detach = true;
	} else if (options.commit) {
		ref = options.commit;
		detach = !(await repository.refExists(`refs/heads/${options.commit}`));
	} else {
		const branch = path.basename(worktreePath);
		if (!(await repository.refExists(`refs/heads/${branch}`))) {
			await repository.createBranch(branch, "HEAD", false);
			createdBranch = branch;
		}
		ref = branch;
	}

	const commit = await repository.commitDetails(ref);
	const shortSha = commit.sha.slice(0, 7);
	const subject = commit.message.split("\n", 1)[0];
	if (!options.quiet) {
		const preparation = createdBranch
			? `new branch '${createdBranch}'`
			: detach
				? `detached HEAD ${shortSha}`
				: `checking out '${ref}'`;
		console.log(`Preparing worktree (${preparation})`);
	}
	const result = await repository.worktreeAdd(worktreePath, ref, {
		detach,
		clone: cfgWorktreeClone.get(settings),
		backend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
	});
	if (!options.quiet) {
		console.log(`HEAD is now at ${shortSha} ${subject}`);
		if (result.clonedWith != null) {
			console.log(`Cloned from ${repository.info().repoRoot} via ${formatIsolationBackend(result.clonedWith)}`);
		}
	}
	if (result.cloneError) {
		console.error(chalk.dim(`warning: worktree clone fell back to plain checkout: ${result.cloneError}`));
	}
	const hook = await vcs.runPostCheckoutHook(worktreePath, commit.sha);
	process.stderr.write(hook.stdout);
	process.stderr.write(hook.stderr);
	if (hook.exitCode !== 0) process.exitCode = hook.exitCode;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason ? chalk.yellow("orphaned") : chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${entries.length} total`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<{ removed: number; failed: number }> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return { removed: 0, failed: 0 };
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed.`));
		}
		return { removed: 0, failed: 0 };
	}

	const results: { path: string; ok: boolean; error?: string; skipped?: boolean }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.keep) {
				results.push({ path: target.path, ok: true, skipped: true });
				continue;
			}
			if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
				// Live worktree: ask git to remove it cleanly. If git refuses (locked,
				// dirty, etc.), fall back to fs.rm and rely on `worktree prune` to
				// clean the bookkeeping on the parent side.
				const removed = await vcs.git(target.parentRepo)?.worktreeRemove(target.path, true);
				if (!removed) {
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else {
				if (target.kind === "task-isolation") {
					// The scan is a decision taken earlier; this is the moment of
					// deletion. Resolve the sandbox to the directory itself first:
					// locking and deleting the scanned path lets a symlink swapped
					// in between point the removal at a different, live sandbox,
					// and a lock on an alias excludes nobody. Then, under that
					// lock, ask again — unless `--all` was asked for, which
					// deletes whatever is there.
					const sandbox = await resolveSandboxIdentity(target.path);
					// Through the one entry point, so the decision and the
					// removal share a recorded hold and anything they call
					// detects it rather than queueing behind this command.
					const removed = await withSandboxLock(sandbox, "remove", async () => {
						if (!options.all && !(await decideIsolationReclaim(sandbox)).reclaimable) return false;
						await stopRetainedMount(sandbox);
						// One atomic step under the hold, then the delete.
						// Checking the hold immediately before a recursive
						// removal still leaves the removal running after the
						// hold ends, and it erased a file a peer created in a
						// directory it was already walking. After the rename
						// there is nothing for a peer to lose: whatever it
						// writes to the live path is not inside what goes.
						const aside = `${sandbox}${ISOLATION_REMOVING_SUFFIX}${Snowflake.next()}`;
						requireSandboxLockHeld(sandbox, "remove");
						await fs.rename(sandbox, aside);
						await fs.rm(aside, { recursive: true, force: true });
						return true;
					});
					results.push(removed ? { path: target.path, ok: true } : { path: target.path, ok: true, skipped: true });
					continue;
				}
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await vcs.requireGit(parent).worktreePrune();
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	const succeeded = results.filter(result => result.ok && !result.skipped).length;
	const skipped = results.filter(result => result.skipped).length;
	const failed = results.filter(result => !result.ok).length;
	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, skipped, results }, null, 2));
		return { removed: succeeded, failed };
	}

	for (const result of results) {
		if (result.skipped) {
			console.log(`${chalk.dim("kept   ")}  ${result.path}`);
			console.log(`          ${chalk.dim("in use when the removal came round")}`);
		} else if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	return { removed: succeeded, failed };
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	const rootListing = await fs.readdirLookup(root);
	if (rootListing.kind === "absent") return [];
	// A listing that failed is not an empty worktree directory: saying "no
	// worktrees" would tell the user everything is clean when nothing was read.
	if (rootListing.kind === "unknown") {
		throw new Error(`Worktree directory ${root} could not be listed: ${rootListing.reason}`);
	}
	const topLevel = rootListing.value;

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.statLookup(dir);
		if (stat.kind === "unknown") {
			// Named, not dropped: an entry nobody can look at is exactly the
			// one a user needs to hear about, and it is never removed.
			entries.push({ path: dir, kind: "stray", orphanReason: `could not be read (${stat.reason})`, keep: true });
			continue;
		}
		if (stat.kind === "absent" || !stat.value.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		const childListing = await fs.readdirLookup(dir);
		if (childListing.kind === "unknown") {
			entries.push({
				path: dir,
				kind: "stray",
				orphanReason: `could not be listed (${childListing.reason})`,
				keep: true,
			});
			continue;
		}
		if (childListing.kind === "absent") continue;
		const children = childListing.value;
		let nested = 0;
		let unclassifiable = false;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.statLookup(childDir);
			if (childStat.kind === "unknown") {
				entries.push({
					path: childDir,
					kind: "stray",
					orphanReason: `could not be read (${childStat.reason})`,
					keep: true,
				});
				// Keeping the child while calling its parent a stray deletes the
				// child with the parent: a removal of the container takes
				// everything under it, so a parent holding something nobody
				// could classify is not a stray either.
				unclassifiable = true;
				continue;
			}
			if (childStat.kind === "absent" || !childStat.value.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
				if (childClassified.keep) unclassifiable = true;
			}
		}
		if (unclassifiable) {
			entries.push({
				path: dir,
				kind: "stray",
				orphanReason: "holds a directory this process could not read",
				keep: true,
			});
			continue;
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.statLookup(gitEntry);
	if (gitStat.kind === "unknown") {
		// A `.git` nobody can stat is not a directory without one: read that
		// way, a real linked worktree became a stray and was deleted.
		return {
			path: dir,
			kind: "stray",
			orphanReason: `its .git could not be read (${gitStat.reason})`,
			keep: true,
		};
	}
	if (gitStat.kind === "found" && gitStat.value.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	// A task-isolation sandbox is identified by its ownership marker — written
	// before the backend materialises the mount — or by the `m`/`merged` mount
	// dir itself (legacy dirs and crashed pre-marker runs). Recognizing the
	// marker alone keeps an in-progress sandbox from being mistaken for a stray
	// during the window between marker creation and mount materialisation.
	// `exists()` is false for a marker that is there and unreadable, and a
	// sandbox misread as a stray is removed with a plain recursive delete.
	// Unknown counts as a sandbox: the reclaim decision below then refuses it.
	const marker = await fs.lstatLookup(path.join(dir, ISOLATION_OWNER_FILE));
	let isIsolation = marker.kind !== "absent";
	if (!isIsolation) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountStat = await fs.statLookup(path.join(dir, mountDir));
			if (mountStat.kind === "unknown" || (mountStat.kind === "found" && mountStat.value.isDirectory())) {
				isIsolation = true;
				break;
			}
		}
	}
	if (!isIsolation) return null;
	// The same rule the owner's teardown follows, asked from the other side: an
	// unreadable marker is not proof that nobody is in there, and a live lease
	// counts as much as a live owner. `--all` deletes regardless.
	const decision = await decideIsolationReclaim(dir);
	return {
		path: dir,
		kind: "task-isolation",
		orphanReason: decision.reclaimable ? decision.reason : undefined,
	};
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	const gitFile = await fs.readTextLookup(gitEntry);
	if (gitFile.kind !== "found") {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason:
				gitFile.kind === "absent" ? "its .git file is missing" : `cannot read .git file: ${gitFile.reason}`,
			// A `.git` file nobody can read says nothing about whether this
			// checkout is live, and `clear` would remove it on that silence.
			keep: gitFile.kind === "unknown",
		};
	}
	const contents = gitFile.value;
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.statLookup(parentGitDir);
	if (parentDirStat.kind === "unknown") {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: `its parent's worktree record could not be read (${parentDirStat.reason})`,
			keep: true,
		};
	}
	if (parentDirStat.kind === "absent" || !parentDirStat.value.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.statLookup(parentRepo);
	if (parentRepoStat.kind === "unknown") {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: `its parent repo could not be read (${parentRepoStat.reason})`,
			keep: true,
		};
	}
	if (parentRepoStat.kind === "absent" || !parentRepoStat.value.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	// A branch name is a label in a listing, so not knowing it costs nothing
	// and decides nothing: no caller deletes on the strength of it.
	const head = await fs.readTextLookup(headFile);
	if (head.kind !== "found") return undefined;
	return /^ref:\s*refs\/heads\/(.+)$/.exec(head.value.trim())?.[1];
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}
