import { assertCodeWriteTarget, type DelegatedIo } from "../session/delegated-io";
import * as git from "../utils/git";
import type { SingleResult } from "./types";
import { applyNestedPatches, cleanupTaskBranches, mergeTaskBranches } from "./worktree";

/** Integrate captured artifacts only after child success; retain recovery references on every failure. */
export async function integrateTaskResult(options: {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	codeWrite?: Extract<DelegatedIo, { kind: "code-write" }>;
	signal?: AbortSignal;
	commitMessage?: (diff: string) => Promise<string | null>;
}): Promise<void> {
	const { result, repoRoot, mergeMode, codeWrite, signal, commitMessage } = options;
	result.changesApplied = false;
	if (result.exitCode !== 0 || result.error || result.isError || result.aborted) {
		result.isError = true;
		result.exitCode ||= 1;
		result.mergeSummary = "Child execution failed; no integration attempted. Recovery artifacts are retained.";
		return;
	}
	try {
		signal?.throwIfAborted();
		if (codeWrite) await assertCodeWriteTarget(codeWrite);
		if (!result.patchPath) throw new Error("Missing captured patch artifact.");
		const patch = await Bun.file(result.patchPath).text();
		const nested = result.nestedPatches ?? [];
		if (patch.trim()) {
			// Check against the live worktree BEFORE branch-mode stash/cherry-pick too.
			// Otherwise a competing uncommitted edit would surface only after parent mutation.
			if (!(await git.patch.canApplyText(repoRoot, patch)))
				throw new Error("Captured patch conflicts with the current repository.");
			signal?.throwIfAborted();
			if (mergeMode === "branch") {
				if (!result.branchName) throw new Error("Missing captured branch artifact.");
				const merge = await mergeTaskBranches(repoRoot, [
					{ branchName: result.branchName, taskId: result.id, description: result.description },
				]);
				result.changesApplied = merge.merged.includes(result.branchName);
				if (merge.failed.length || merge.stashConflict)
					throw new Error(merge.conflict ?? merge.stashConflict ?? "Branch integration failed.");
			} else {
				await git.patch.applyText(repoRoot, patch);
				result.changesApplied = true;
			}
		}
		if (nested.length) {
			signal?.throwIfAborted();
			const warnings = await applyNestedPatches(repoRoot, nested, commitMessage);
			result.changesApplied = true;
			if (warnings.length) throw new Error(warnings.join("\n"));
		}
		result.mergeSummary = result.changesApplied ? "Isolated changes applied successfully." : "No changes to apply.";
		if (result.branchName) await cleanupTaskBranches(repoRoot, [result.branchName]);
	} catch (error) {
		result.exitCode = 1;
		result.isError = true;
		result.error = error instanceof Error ? error.message : String(error);
		result.mergeSummary = `Integration failed: ${result.error}. Recovery patch/branch artifacts are retained.`;
	}
}
