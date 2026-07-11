/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve git root + capture baseline.
 *   2. {@link runIsolatedSubprocess}    — start worktree, run, capture
 *                                        branch/patch, tear worktree down.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call (the baseline is cloned per spawn
 * before mutation); steps 2 and 3 are per-spawn.
 */
import * as path from "node:path";
import type * as natives from "@pk-nerdsaver-ai/pi-natives";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import type { SingleResult } from "./types";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

type IsoBackendKind = natives.IsoBackendKind;

/** Resolved repo + baseline used by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
	baseline: WorktreeBaseline;
}

/**
 * Resolve the git repo root and capture the worktree baseline used to diff
 * each isolated spawn against. Throws when the cwd is not inside a git
 * repository; callers surface the error as a task-tool failure.
 */
export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	const repoRoot = await getRepoRoot(cwd);
	const baseline = await captureBaseline(repoRoot);
	return { repoRoot, baseline };
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = session.settings.get("task.isolation.commits");
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears `preloadedExtensionPaths` / `preloadedCustomToolPaths`
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. Baseline is cloned per spawn. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationMode(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches`. On commit failure the branch is
 * deleted and `result.error` carries the merge-failure message.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` and
 * returns `patchPath` + `nestedPatches`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * The isolation handle is always torn down in `finally`.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let handle: IsolationHandle | undefined;
	try {
		const taskBaseline = structuredClone(opts.context.baseline);
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedCustomToolPaths: undefined,
		});
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			try {
				const commitResult = await commitToBranch(
					isolationDir,
					taskBaseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
				return {
					...result,
					branchName: commitResult?.branchName,
					nestedPatches: commitResult?.nestedPatches,
				};
			} catch (mergeErr) {
				// Agent succeeded but branch commit failed — clean up stale branch
				const branchName = `omp/task/${opts.agentId}`;
				await git.branch.tryDelete(opts.context.repoRoot, branchName);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				return { ...result, error: `Merge failed: ${msg}` };
			}
		}
		if (result.exitCode === 0) {
			try {
				const delta = await captureDeltaPatch(isolationDir, taskBaseline);
				const patchPath = path.join(opts.artifactsDir, `${opts.agentId}.patch`);
				await Bun.write(patchPath, delta.rootPatch);
				return {
					...result,
					patchPath,
					nestedPatches: delta.nestedPatches,
				};
			} catch (patchErr) {
				const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
				return { ...result, error: `Patch capture failed: ${msg}` };
			}
		}
		return result;
	} catch (err) {
		return opts.buildFailureResult(err);
	} finally {
		if (handle) {
			await cleanupIsolation(handle);
		}
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	try {
		if (mergeMode === "branch") {
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{ branchName: result.branchName, taskId: result.id, description: result.description },
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
				summary = `\n\n<system-notification>Branch merge failed: ${result.branchName}.${conflictPart}\nThe unmerged branch remains for manual resolution.</system-notification>`;
			}
			if (mergeResult.stashConflict) {
				summary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				changesApplied = await git.patch.canApplyText(repoRoot, normalized);
				hadAnyChanges = false;
				if (changesApplied) {
					try {
						await git.patch.applyText(repoRoot, normalized);
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			const notification =
				"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
			const patchList = result.patchPath ? `\n\nPatch artifact:\n- ${result.patchPath}` : "";
			summary = `\n\n${notification}${patchList}`;
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
		return {
			summary: `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`,
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch {
		// Nested patch failures are non-fatal to the parent merge.
		return "\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
	}
}
