import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath } from "@oh-my-pi/pi-utils";
import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";
import { parseIsolationBackend } from "../task/worktree";
import type { WorktreeBackend } from "./backend";
import { managedGitWorktrees } from "./git-managed";
import { resolveAvailableWorktreePath } from "./paths";

/** Linked Git worktree implementation. */
export const gitWorktree: WorktreeBackend = {
	async create({ repository, settings, branch, sourceCwd, baseCommit, keptChanges }) {
		const primaryRoot = repository.primaryRoot();
		const slug = branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
		const basePath = getWorktreeDir(`${slug}-${hashPath(primaryRoot)}`);
		const worktreePath = await resolveAvailableWorktreePath(basePath, await repository.worktrees());
		await fs.mkdir(path.dirname(worktreePath), { recursive: true });

		await repository.createBranch(branch, baseCommit, false);
		const result = await repository.worktreeAdd(worktreePath, branch, {
			detach: false,
			clone: cfgWorktreeClone.get(settings),
			backend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
			keepChanges: keptChanges,
		});
		return {
			path: await fs.realpath(worktreePath),
			branch,
			clonedWith: result.clonedWith ?? undefined,
			cloneError: result.cloneError ?? undefined,
			sourceCwd,
			baseCommit,
			keptChanges,
		};
	},
	async inspect(wt) {
		const present = await Bun.file(path.join(wt.path, ".git")).exists();
		return {
			checkout: present ? vcs.git(wt.path) : null,
			branchRepo: vcs.git(wt.sourceCwd),
			missingBranchRepoMeansMoved: true,
		};
	},
	async remove(wt, moved) {
		const repository = vcs.requireGit(wt.sourceCwd);
		if (!(await repository.worktreeRemove(wt.path, true))) {
			throw new Error(`Failed to remove worktree ${wt.path}; branch '${wt.branch}' kept.`);
		}
		if (!moved && !(await repository.deleteBranch(wt.branch, true))) {
			throw new Error(`Removed worktree ${wt.path} but failed to delete branch '${wt.branch}'.`);
		}
	},
	managed: managedGitWorktrees,
	async locations(cwd) {
		const repo = vcs.git(cwd);
		if (!repo) return [];
		const source = repo.primaryRoot();
		return (await repo.worktrees()).map(wt => ({ root: wt.path, source }));
	},
};
