/**
 * `/wt` backing: fork the current checkout into a fresh linked git worktree on
 * a new branch, carrying the uncommitted changes along, so the session can be
 * relocated there without disturbing the original checkout.
 *
 * The worktree is created through the clone-first path (`worktree.clone`,
 * `isolation.backend`) and lands under the agent-managed worktree base
 * (`worktree.base`, default `~/.omp/wt`) next to `github pr_checkout` trees,
 * so `omp worktree list|clear` sees it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";
import { resolveAvailableWorktreePath } from "../tools/gh-pr-checkout";

export interface SessionWorktree {
	/** Absolute, realpath'd worktree root. */
	path: string;
	/** Branch checked out in the worktree (created from the source `HEAD`). */
	branch: string;
	/** Backend that cloned the checkout, or undefined for a plain checkout. */
	clonedWith?: IsoBackendKind;
	/** Why the clone fell back to a plain checkout, when it did. */
	cloneError?: string;
}

/** Default `/wt` branch name: `wt/<yyyymmdd-hhmmss>`. */
export function defaultSessionWorktreeBranch(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wt/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** One-line confirmation shown after the session moved into `worktree`. */
export function formatSessionWorktreeSummary(worktree: SessionWorktree, sourceCleaned = false): string {
	const how =
		worktree.clonedWith === undefined ? "checked out" : `cloned via ${formatIsolationBackend(worktree.clonedWith)}`;
	const changeStatus = sourceCleaned
		? "uncommitted changes moved, source checkout cleaned"
		: "uncommitted changes carried over";
	return `Moved to worktree ${worktree.path} on branch ${worktree.branch} (${how}, ${changeStatus}).`;
}

/**
 * If `worktree.cleanSource` is enabled, resets and cleans the source checkout.
 * Catches git errors and returns `{ cleaned: true }` on success, or `{ cleaned: false, errorMessage }` on failure.
 */
export async function cleanSourceCheckoutIfConfigured(
	sourceCwd: string,
	settings: Settings,
): Promise<{ cleaned: boolean; errorMessage?: string }> {
	if (!settings.get("worktree.cleanSource")) {
		return { cleaned: false };
	}
	try {
		const repository = vcs.requireGit(sourceCwd);
		await repository.reset("hard", "HEAD");
		await repository.clean({});
		return { cleaned: true };
	} catch (error) {
		logger.warn("failed to clean source checkout after /wt", { cwd: sourceCwd, error });
		return {
			cleaned: false,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}
/**
 * Create the worktree for `/wt`. Throws with a user-facing message when `cwd`
 * is not a git checkout, `branch` already exists, or git refuses.
 */
export async function createSessionWorktree(cwd: string, settings: Settings, branch: string): Promise<SessionWorktree> {
	try {
		await settings.flush();
	} catch (err) {
		throw new Error(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
	}
	const repository = vcs.git(cwd);
	if (!repository) {
		throw new Error(`Not inside a git repository: ${cwd}`);
	}
	if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..")) {
		throw new Error(`Invalid branch name: ${branch}`);
	}
	const branchRef = `refs/heads/${branch}`;
	if (await repository.refExists(branchRef)) {
		throw new Error(`Branch '${branch}' already exists; pick another name.`);
	}
	const primaryRoot = repository.primaryRoot() ?? repository.info().repoRoot;
	const slug = branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const basePath = getWorktreeDir(`${slug}-${hashPath(primaryRoot)}`);
	const worktreePath = await resolveAvailableWorktreePath(basePath, await repository.worktrees());
	await fs.mkdir(path.dirname(worktreePath), { recursive: true });

	await repository.createBranch(branch, "HEAD", false);
	const result = await repository.worktreeAdd(worktreePath, branch, {
		detach: false,
		clone: settings.get("worktree.clone"),
		backend: parseIsolationBackend(settings.get("isolation.backend")),
		keepChanges: true,
	});
	return {
		path: await fs.realpath(worktreePath),
		branch,
		clonedWith: result.clonedWith ?? undefined,
		cloneError: result.cloneError ?? undefined,
	};
}
