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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE } from "../task/isolation-ownership";

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

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
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
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
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

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	if (failed > 0) process.exitCode = 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
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
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	// A task-isolation sandbox is identified by its ownership marker — written
	// before the backend materialises the mount — or by the `m`/`merged` mount
	// dir itself (legacy dirs and crashed pre-marker runs). Recognizing the
	// marker alone keeps an in-progress sandbox from being mistaken for a stray
	// during the window between marker creation and mount materialisation.
	let isIsolation = await Bun.file(path.join(dir, ISOLATION_OWNER_FILE)).exists();
	if (!isIsolation) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountStat = await fs.stat(path.join(dir, mountDir)).catch(() => null);
			if (mountStat?.isDirectory()) {
				isIsolation = true;
				break;
			}
		}
	}
	if (!isIsolation) return null;
	const live = await hasLiveIsolationOwner(dir);
	return {
		path: dir,
		kind: "task-isolation",
		// Only after confirming no live owner is the "no live task" claim true.
		// A running subagent's sandbox stays live so `clear` won't delete it.
		orphanReason: live ? undefined : "task-isolation leftover (no live task owns it)",
	};
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
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
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
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
