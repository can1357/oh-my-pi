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
 *   1. {@link prepareIsolationContext} — resolve the git root.
 *   2. {@link runIsolatedSubprocess}    — start worktree, capture its
 *                                        baseline, run, capture changes, and
 *                                        transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call; steps 2 and 3 are per-spawn.
 */
import * as fs from "./isolation-fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
/**
 * How long a finished, successful isolated run waits for deferred owner jobs
 * before capturing anyway. Long enough for a flush to land, short enough that
 * a job which never settles cannot hold the result.
 */
const DEFERRED_CLEANUP_MAX_WAIT_MS = 30_000;

import { trackLateCleanup } from "../utils/late-cleanup";
import { armTeardown, hasLiveIsolationLease, hasUnfinishedWriter } from "./isolation-lease";
import {
	readIsolationClaim,
	readRetainedMountBackend,
	requireSandboxLockHeld,
	resolveSandboxIdentity,
	withSandboxLock,
} from "./isolation-ownership";
import { asReleaseHold, createReleaseHold } from "../utils/release-hold";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { needsNativeTeardown, writeRetainedBackend } from "./isolation-ownership";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	applyNestedPatches,
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

import { cfgTaskIsolationCommits } from "./settings";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo shared by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
}

/**
 * Resolve the git repo root isolated spawns are copied from and merged back
 * into. Throws when the cwd is not inside a git repository; callers surface
 * the error as a task-tool failure. Each spawn captures its own baseline from
 * its isolation copy (see {@link captureIsolationBaseline}).
 */
export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	return { repoRoot: await getRepoRoot(cwd) };
}

/** Fingerprint of a captured delta, used to skip re-committing an unchanged workspace on release. */
function deltaFingerprint(rootPatch: string, nestedPatches: readonly NestedRepoPatch[]): bigint | number {
	let key = rootPatch;
	for (const { relativePath, patch } of nestedPatches) key += `\0${relativePath}\0${patch}`;
	return fs.hash(key);
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
		const style = cfgTaskIsolationCommits.get(session.settings);
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
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationBackend(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
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
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which the write may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			await fs.writeFileDeep(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
}

interface IsolationPatchCapture {
	artifacts: IsolationPatchArtifacts;
	/** {@link deltaFingerprint} of the written delta. */
	fingerprint: bigint | number;
}

/**
 * Capture the isolation delta and write every part of it to disk — the root
 * patch and one file per nested repo — before the caller tears the workspace
 * down. Throws when any write fails so nothing captured is ever the only copy.
 */
async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchCapture> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await fs.writeFileDeep(patchPath, delta.rootPatch);
	const nestedPatchPaths = await persistNestedPatches(artifactsDir, agentId, delta.nestedPatches);
	return {
		artifacts: {
			patchPath,
			hasRootChanges: delta.rootPatch.trim().length > 0,
			nestedPatches: delta.nestedPatches,
			nestedPatchPaths,
		},
		fingerprint: deltaFingerprint(delta.rootPatch, delta.nestedPatches),
	};
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
/** Mount directory name inside a sandbox base dir. */
const TASK_ISOLATION_MOUNT_NAME = "m";

export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
	/**
	 * Whether there is a workspace to recover from: `here` names {@link dir},
	 * `gone` means a teardown won the race and removed it, and `unknown`
	 * means this process could not find out — which is not the same as gone,
	 * and must not be reported as a path.
	 */
	location: "here" | "gone" | "unknown";
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
	generation?: string,
): Promise<RetainedWorkspace> {
	const baseDir = await resolveSandboxIdentity(path.dirname(isolationDir));
	// Check and act under one hold. A session admitted *after* the check and
	// before the rename got `ENOENT` at its own cwd: a check-then-act window
	// is not a decision, and a lease taken in it is as real as one taken
	// before. The teardown path already holds this lock, and re-taking it
	// there would deadlock against itself, so it says so.
	return await withSandboxLock(baseDir, "retain", async () => {
		// The directory may already be gone: a concurrent retention, or a
		// teardown that won the race, has moved it. Reporting a path that does
		// not exist sends the user to an empty name, so the sibling that does
		// exist is reported instead.
		// Only `ENOENT` says the workspace has moved. A stat that fails for any
		// other reason is a workspace this caller could not look at, and
		// retention goes ahead on the real path rather than hunting siblings.
		// The path is not the claim. A successor materialised here is a
		// different workspace with a different owner, and moving it took a
		// stranger's work while this run's own retained copy sat intact beside
		// it. Checked wherever the path is claimed, not only where siblings
		// are searched.
		if (generation !== undefined) {
			const claim = await readIsolationClaim(baseDir);
			if (claim.kind === "unknown") {
				return { dir: isolationDir, sidecarOk: false, location: "unknown" };
			}
			// Three ways this path is not this run's workspace, and `retiring`
			// is the one that was falling through to the rename. A teardown in
			// progress owns that path: moving its marker left its backend stop
			// running on a name a successor then took, and the successor was
			// deleted by that continuation. "Not claimed by me" is the
			// condition, not "claimed by somebody else".
			if (claim.kind !== "claimed" || claim.generation !== generation) {
				const sibling = await findRetainedSibling(baseDir, generation);
				if (sibling.kind === "unknown") return { dir: isolationDir, sidecarOk: false, location: "unknown" };
				if (sibling.kind === "absent") return { dir: isolationDir, sidecarOk: false, location: "gone" };
				return {
					dir: sibling.value,
					sidecarOk: await hasRetainedSidecar(path.dirname(sibling.value), backend),
					location: "here",
				};
			}
		}
		const existing = await fs.statLookup(isolationDir);
		if (existing.kind === "absent") {
			// Someone else moved it. Report a path that exists and a sidecar
			// state that is read rather than assumed: a decoy `.retained-*`
			// without a mount, or an older sibling, sent callers to the wrong
			// workspace and claimed metadata nothing had written.
			const retained = await findRetainedSibling(baseDir, generation);
			// Three answers, three messages. "Could not look" is neither a
			// workspace to recover from nor a workspace that is gone, and
			// naming the original path for it sent the user to an empty name.
			if (retained.kind === "unknown") {
				return { dir: isolationDir, sidecarOk: false, location: "unknown" };
			}
			if (retained.kind === "absent") return { dir: isolationDir, sidecarOk: false, location: "gone" };
			return {
				dir: retained.value,
				sidecarOk: await hasRetainedSidecar(path.dirname(retained.value), backend),
				location: "here",
			};
		}
		return await retainUnderLock(isolationDir, baseDir, backend);
	});
}

/** The newest `.retained-*` copy of this sandbox that actually holds a workspace. */
async function findRetainedSibling(baseDir: string, generation: string | undefined): Promise<fs.Lookup<string>> {
	const parent = path.dirname(baseDir);
	const prefix = `${path.basename(baseDir)}.retained-`;
	const listing = await fs.readdirLookup(parent);
	if (listing.kind !== "found") return listing.kind === "absent" ? fs.ABSENT : listing;
	// Ordered by the retention stamp in the name, not by modification time:
	// a file touched inside an older retention made that unrelated workspace
	// look like the newest one, and the user was sent to a stranger's run.
	let latest: { dir: string; stamp: number } | undefined;
	for (const entry of listing.value) {
		if (!entry.startsWith(prefix)) continue;
		const stamp = Number.parseInt(entry.slice(prefix.length).split("-")[0] ?? "", 36);
		if (!Number.isFinite(stamp)) continue;
		const candidate = path.join(parent, entry, TASK_ISOLATION_MOUNT_NAME);
		// A retained copy with no mount directory is not this workspace. A
		// candidate that cannot be looked at is not evidence either way, so
		// the whole answer becomes "I do not know" rather than the next best.
		const found = await fs.statLookup(candidate);
		if (found.kind === "unknown") return found;
		if (found.kind === "absent" || !found.value.isDirectory()) continue;
		// The stamp orders retentions of *this* path; it does not say whose run
		// they hold. A later retention of the same slot by a successor was
		// reported to the owner of the earlier one, whose own copy sat intact
		// beside it. The marker inside the retained copy answers that.
		if (generation !== undefined) {
			const claim = await readIsolationClaim(path.join(parent, entry));
			if (claim.kind === "unknown") return fs.UNKNOWN(claim.reason);
			if (claim.kind !== "claimed" || claim.generation !== generation) continue;
		}
		if (latest === undefined || stamp > latest.stamp) latest = { dir: candidate, stamp };
	}
	return latest === undefined ? fs.ABSENT : fs.FOUND(latest.dir);
}

/**
 * Whether the cleanup metadata `clear` would need is really on disk for a
 * retained workspace — read, not inferred from the fact that a sibling exists:
 * a second retention reported it present while the first had failed to write it.
 */
async function hasRetainedSidecar(retainedBase: string, backend: natives.IsoBackendKind | undefined): Promise<boolean> {
	if (backend === undefined || !needsNativeTeardown(backend)) return true;
	return (await readRetainedMountBackend(retainedBase).catch(() => undefined)) !== undefined;
}

async function retainUnderLock(
	isolationDir: string,
	baseDir: string,
	backend: natives.IsoBackendKind | undefined,
): Promise<RetainedWorkspace> {
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	// Nothing renames a workspace somebody is in — the same rule deletion
	// already follows. A recorded writer keeps its cwd, and so does a live
	// lease that is not ours: moving the directory gave a second session
	// `ENOENT` at its own cwd, which is the loss retention exists to prevent.
	if ((await hasUnfinishedWriter(baseDir)) || (await hasLiveIsolationLease(baseDir))) {
		logger.warn("isolation workspace retained in place: another session is still working in this path", {
			isolationDir,
		});
		// The sidecar still has to be here, or `clear` skips the native stop
		// for a mount backend and traverses a live mount later.
		let inPlaceSidecarOk = !needsSidecar;
		if (needsSidecar && backend !== undefined) {
			inPlaceSidecarOk = await writeRetainedBackend(baseDir, backend).then(
				() => true,
				() => false,
			);
		}
		return { dir: isolationDir, sidecarOk: inPlaceSidecarOk, location: "here" };
	}
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			// At the act, not at the decision: everything above may have taken
			// long enough for this call's hold to have ended.
			requireSandboxLockHeld(baseDir, "move");
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk, location: "here" };
		} catch {
			if (attempt === 2) return { dir: isolationDir, sidecarOk, location: "here" };
			await fs.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk, location: "here" };
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
	/** Set when the retained workspace is not on disk at all, so no path can be named. */
	retainedGone?: boolean;
	/** Set when this process could not find out where the workspace went. */
	retainedUnknown?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. One-shot
 * and failed startup paths clean up in `finally`. If captured changes cannot
 * be written to disk, the workspace is retained under a unique `.retained-*`
 * sibling and its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let taskBaseline: WorktreeBaseline | undefined;
	/** Fingerprint of the delta already handed to the caller at run end; release only re-captures on change. */
	let handedOff: bigint | number | undefined;
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	let baseReleasePromise: Promise<void> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	let releasePromise: Promise<void> | undefined;
	/** Artifacts {@link releaseIsolation} captured, when it ran before this function's own post-run capture. */
	let releasedCapture: Partial<SingleResult> | undefined;
	/** The run's IRC wake hold, released only once the run-end capture is done. */
	let releaseIrcWakes: (() => void) | undefined;
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	/**
	 * Release what the caller held and tear the workspace down, handing the
	 * teardown this run's capture so it runs under the lock that authorises the
	 * removal. Memoised, because the caller's release must run once — but a
	 * teardown deferred to a late departure re-enters `cleanupIsolation`
	 * directly, since a memoised promise that has already resolved would report
	 * a removal that never happened.
	 */
	const cleanupHandle = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			await releaseBase();
			if (handle && !retainWorkspace) {
				await cleanupIsolation(handle, {
					capture: async () => {
						try {
							await capture();
						} catch (error) {
							// Kept for the caller's result: the teardown keeps
							// the workspace on this failure, and a kept
							// workspace nobody is told about is a lost patch.
							finalCaptureError = error;
							throw error;
						}
					},
				});
			}
		})();
		return cleanupPromise;
	};
	/**
	 * Write this run's patch, and its branch, from the sandbox as it stands.
	 *
	 * Raises on failure, always, and its two callers answer that differently on
	 * purpose. The capture the teardown runs under the sandbox lock *authorises
	 * a deletion*, so a failure there must stop it: an earlier successful
	 * capture used to make a later failure a warning, and the caller reading
	 * that as "captured" deleted the source of a half-written patch. The
	 * capture at release authorises nothing — it only fills in the parent's
	 * result — so a failure there is logged and the release goes on, because
	 * throwing out of it abandons the caller's hold and replaces a child's real
	 * output with a blank failure.
	 */
	const capture = async (): Promise<void> => {
		if (!handle || !taskBaseline || retainWorkspace) {
			return;
		}
		const sandbox = handle;
		const baselineAtRelease = taskBaseline;
		let capture: IsolationPatchCapture;
		try {
			capture = await writeIsolationPatch(sandbox.mergedDir, baselineAtRelease, opts.artifactsDir, opts.agentId);
		} catch (captureErr) {
			retainWorkspace = true;
			const retained = await retainIsolationWorkspace(sandbox.mergedDir, sandbox.backend, sandbox.generation);
			throw new Error(
				renderIsolationError({
					kind: "patch-capture-failed",
					message: captureErr instanceof Error ? captureErr.message : String(captureErr),
					retainedDir: retained.dir,
					sidecarMissing: !retained.sidecarOk,
					retainedGone: retained.location === "gone",
					retainedUnknown: retained.location === "unknown",
				}),
			);
		}
		const patchResult = capture.artifacts;
		// Kept for the post-run path: a release that ran inside the child's
		// own teardown — a refused adoption ends the child there — has
		// already captured and removed the workspace, so the result the
		// parent reads must carry that capture rather than a second,
		// impossible one.
		releasedCapture = { ...patchResult };
		AgentRegistry.global().setHistory(opts.agentId, {
			patchPath: patchResult.patchPath,
			nestedPatchPaths: patchResult.nestedPatchPaths,
		});
		// Nothing changed since the run-end capture the caller already
		// merged or applied: a branch now would only duplicate that work.
		if (capture.fingerprint === handedOff) return;
		const commitResult = await commitToBranch(
			sandbox.mergedDir,
			baselineAtRelease,
			opts.agentId,
			opts.description,
			undefined,
		);
		// Branch mode's result is the branch, not the patch: a caller handed
		// only the patch path reports "No changes to apply" and drops work
		// that is sitting on a branch this release just made.
		releasedCapture = {
			...patchResult,
			...(commitResult?.branchName ? { branchName: commitResult.branchName } : {}),
			...(commitResult?.baseSha ? { branchBaseSha: commitResult.baseSha } : {}),
			...(commitResult?.nestedPatches ? { nestedPatches: commitResult.nestedPatches } : {}),
		};
		AgentRegistry.global().setHistory(opts.agentId, {
			patchPath: patchResult.patchPath,
			branchName: commitResult?.branchName,
			nestedPatchPaths: patchResult.nestedPatchPaths,
		});
	};
	const releaseIsolation = (): Promise<void> => {
		releasePromise ??= (async () => {
			if (!handle || !taskBaseline || retainWorkspace) {
				await cleanupHandle();
				return;
			}
			// Capture now, whatever else happens: this release is what the
			// parent's result is built from, and a capture postponed to an
			// unknown later moment leaves that result with no patch and no
			// branch for work the child really did.
			//
			// A failure here is reported and does not stop the release. This
			// capture is not what authorises a deletion — the one under the
			// sandbox lock below is, and that one raises — so throwing out of
			// here only abandons the caller's hold and replaces a child's real
			// output with a blank failure result.
			await capture().catch(error => {
				logger.warn("capture at release failed; the locked capture before removal decides", {
					agentId: opts.agentId,
					error: error instanceof Error ? error.message : String(error),
				});
				// Kept, so the caller's result can say it. A release whose
				// capture failed used to return exit 0 with no error, no patch
				// and no path: the only copy of the work survived in a
				// directory nobody was told about.
				releaseCaptureError = error;
			});
			const sandbox = handle;
			// Someone is still working in the sandbox — a nested child that
			// inherited this cwd, a session another process opened in it. The
			// removal waits for them, and so does a second capture, or
			// everything they write after this moment is captured by nobody.
			// Registered before anything is decided and *not* withdrawn here:
			// this path holds no lock, so a user admitted between a look and
			// the cleanup below would otherwise depart with nothing registered
			// to capture its work. The registration is the same teardown the
			// cleanup runs — capture under the sandbox lock, then removal — so
			// a late departure gets the same guarantee, and it re-enters
			// `cleanupIsolation` rather than the memoised handle cleanup.
			armTeardown(handle.mergedDir, async () => await cleanupIsolation(sandbox, { capture }), {
				generation: handle.generation,
			});
			await cleanupHandle();
		})();
		return releasePromise;
	};
	/** Why the capture at release failed, when it did; the caller's result must carry it. */
	let releaseCaptureError: unknown;
	/** Why the teardown's own capture — the last one — failed, when it did. */
	let finalCaptureError: unknown;
	let lifecycleOwnsRelease = false;
	try {
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const isolationBackend = handle.backend;
		const baseline = await captureIsolationBaseline(isolationDir, opts.context.repoRoot);
		taskBaseline = baseline;
		/**
		 * What this run hands the child, built only once there is a child to
		 * hand it to: the base release for a one-shot run (it never touches the
		 * worktree, and its `finalizeSubagentLifecycle` runs `onRelease` before
		 * the post-run capture below, so the handle must survive to the
		 * `finally`), full capture-and-cleanup for a kept-alive one. Claiming it
		 * says the agent lifecycle owns the workspace and everything the caller
		 * held behind it, which is what the `finally` asks instead of looking a
		 * manager up by id — a manager mid-release, replaced, or rewritten by a
		 * concurrent operation answers for neither.
		 */
		const childHold = createReleaseHold(opts.baseOptions.keepAlive === false ? releaseBase : releaseIsolation, () => {
			lifecycleOwnsRelease = true;
			// Whatever owns this owns the caller's hold behind it, since
			// discharging this discharges that.
			asReleaseHold(opts.baseOptions.onRelease)?.claim();
		});
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup
			// (`releaseIsolation`) to the agent lifecycle.
			onRelease: childHold,
			deferIrcWakeRelease: release => {
				releaseIrcWakes = release;
			},
		});
		opts.onSubprocessResult?.(result);
		// A successful result cannot be captured while deferred owner jobs or
		// shutdown hooks may still write the worktree. Failed runs skip capture,
		// so their cleanup remains asynchronous.
		if (deferredCleanup && result.exitCode === 0) {
			// Bounded. A deferred owner job that never settles would otherwise
			// hold a finished, successful run for ever — the capture below is
			// worth waiting for, but not without end.
			const settled = await Promise.race([
				deferredCleanup.then(() => true),
				scheduler.wait(DEFERRED_CLEANUP_MAX_WAIT_MS).then(() => false),
			]);
			if (!settled) {
				logger.warn("deferred owner jobs outran the capture wait; capturing the workspace as it stands", {
					agentId: opts.agentId,
					waitedMs: DEFERRED_CLEANUP_MAX_WAIT_MS,
				});
			}
		}
		/**
		 * Run the teardown here, where this function can still speak, and fold
		 * its capture failure into the result. The teardown's capture is the
		 * last one and it keeps the workspace when it fails; left to the
		 * `finally`, that failure reached a log while the caller got exit 0,
		 * earlier artifacts, no error and no path to the only copy.
		 */
		const reportingFinalCapture = async (artifacts: SingleResult): Promise<SingleResult> => {
			if (!releasePromise && !lifecycleOwnsRelease && !deferredCleanup && !retainWorkspace) {
				await cleanupHandle();
			}
			if (finalCaptureError === undefined) return artifacts;
			retainWorkspace = true;
			const kept = await retainIsolationWorkspace(isolationDir, isolationBackend, handle?.generation);
			return {
				...artifacts,
				error: renderIsolationError({
					kind: "patch-capture-failed",
					message: finalCaptureError instanceof Error ? finalCaptureError.message : String(finalCaptureError),
					retainedDir: kept.dir,
					sidecarMissing: !kept.sidecarOk,
					retainedGone: kept.location === "gone",
					retainedUnknown: kept.location === "unknown",
				}),
			};
		};
		if (releasePromise) {
			// The child's own teardown already ran the release — a refused
			// adoption ends the child inside `runSubprocess` — so the capture and
			// the workspace removal have happened. Re-capturing from a directory
			// that is gone would report a capture failure, and a retained
			// workspace, for work that was in fact captured: hand back what the
			// release wrote.
			await releasePromise;
			const released = await reportingFinalCapture(rememberAgentArtifacts({ ...result, ...releasedCapture }));
			if (releaseCaptureError === undefined) return released;
			// The workspace is kept by the locked capture that refused; name it,
			// because it holds the only copy of what could not be captured.
			const retained = await retainIsolationWorkspace(isolationDir, isolationBackend, handle?.generation);
			retainWorkspace = true;
			return {
				...released,
				error: renderIsolationError({
					kind: "patch-capture-failed",
					message:
						releaseCaptureError instanceof Error ? releaseCaptureError.message : String(releaseCaptureError),
					retainedDir: retained.dir,
					sidecarMissing: !retained.sidecarOk,
					retainedGone: retained.location === "gone",
					retainedUnknown: retained.location === "unknown",
				}),
			};
		}
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			let commitResult: CommitToBranchResult | null;
			try {
				commitResult = await commitToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
			} catch (mergeErr) {
				// Agent succeeded but the branch commit failed. `commitToBranch`
				// is not atomic: the clean-baseline path fetches the agent's
				// commits into the parent ODB and creates `omp/task/<id>` before
				// it commits the leftover working-tree delta, so a throw from
				// that trailing step leaves behind a branch that already holds
				// every commit the agent made. The isolation worktree — the only
				// other copy of those objects — is destroyed by the `finally`
				// below, so deleting the branch unconditionally turned a
				// recoverable merge conflict into permanent loss of committed
				// work (#8868). Delete only when nothing is at stake.
				const baseSha = baseline.root.headCommit;
				const branchName = `omp/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
					return rememberAgentArtifacts({
						...result,
						...capture.artifacts,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, isolationBackend, handle?.generation);
					return rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
							retainedGone: retained.location === "gone",
							retainedUnknown: retained.location === "unknown",
						}),
					});
				}
			}
			handedOff = deltaFingerprint(commitResult?.rootPatch ?? "", commitResult?.nestedPatches ?? []);
			// The branch holds the root-repo work, but nested-repo patches exist
			// only in memory until written; the workspace goes away in `finally`.
			try {
				const nestedPatchPaths = await persistNestedPatches(
					opts.artifactsDir,
					opts.agentId,
					commitResult?.nestedPatches ?? [],
				);
				return await reportingFinalCapture(
					rememberAgentArtifacts({
						...result,
						branchName: commitResult?.branchName,
						branchBaseSha: commitResult?.baseSha,
						nestedPatches: commitResult?.nestedPatches,
						nestedPatchPaths,
					}),
				);
			} catch (persistErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend, handle?.generation);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
						retainedGone: retained.location === "gone",
						retainedUnknown: retained.location === "unknown",
					}),
				});
			}
		}
		if (result.exitCode === 0) {
			try {
				const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
				handedOff = capture.fingerprint;
				return await reportingFinalCapture(rememberAgentArtifacts({ ...result, ...capture.artifacts }));
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend, handle?.generation);
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
						retainedGone: retained.location === "gone",
						retainedUnknown: retained.location === "unknown",
					}),
				});
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		if (!handle) {
			// Isolation failed before a workspace existed, so no child was ever
			// dispatched and no child lifecycle will end: whatever the caller
			// holds for this child is still owed, and this is the last place
			// that can discharge it.
			await releaseBase();
		} else if (!releasePromise && !lifecycleOwnsRelease) {
			if (retainWorkspace) {
				// The workspace stays on disk, but the caller's hold is not part
				// of it: nothing left will end to release it. `releaseBase` runs
				// at most once.
				await releaseBase();
			} else if (deferredCleanup) {
				trackLateCleanup(deferredCleanup.then(cleanupHandle), {
					agentId: opts.agentId,
					resource: "isolation",
				});
			} else {
				await cleanupHandle();
			}
		}
		// The worktree is captured: a held peer message may now wake a turn in it.
		if (releaseIrcWakes && opts.baseOptions.deferIrcWakeRelease)
			opts.baseOptions.deferIrcWakeRelease(releaseIrcWakes);
		else releaseIrcWakes?.();
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
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
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
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
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
			// A patch this process cannot read is not an empty patch: read that
			// way, the run reports no changes for work it has already written.
			const read = await fs.readTextLookup(result.patchPath);
			if (read.kind !== "found") {
				throw new Error(
					`Captured patch ${result.patchPath} could not be read (${read.kind === "absent" ? "it is not there" : read.reason}).`,
				);
			}
			const patchText = read.value;
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
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
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return renderIsolationSummary({
			kind: "nested-apply-failed",
			error: applyErr instanceof Error ? applyErr.message : String(applyErr),
			nestedPatchPaths: result.nestedPatchPaths,
		});
	}
}
