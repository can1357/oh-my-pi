/**
 * Rollback transaction: PREPARE → SAFETY → APPLY → VERIFY → COMMIT.
 *
 * Guarantees:
 * - HEAD and the current branch never move. A rollback only rewrites files (and
 *   the matching index entries); commit history is untouched.
 * - Nothing is overwritten before the current workspace has been captured. The
 *   SAFETY phase snapshots the pre-rollback state whenever it differs from the
 *   target, so "undo the rollback" is just another rollback.
 * - The change set is minimal: only paths that differ between the current
 *   snapshot and the target tree are restored or removed.
 * - VERIFY recaptures the workspace and requires it to match the target.
 *   Anything left over fails the transaction with the journal preserved, so a
 *   failure or crash is recoverable and visible instead of silent.
 * - Paths excluded by the size guard are never touched and never verified: they
 *   were never part of the snapshot.
 *
 * The index/worktree staging distinction is intentionally collapsed: restored
 * paths land in both, so a rolled-back workspace has no phantom staged diff
 * against the content on disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toError } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { captureWorkspaceTree } from "./capture";
import { clearJournal, writeJournal } from "./store";
import type { CheckpointMeta, RollbackJournal, RollbackPhase, RollbackResult, WorkspaceIdentity } from "./types";

export interface ApplyPlan {
	/** Paths present in the target tree whose current content differs or is missing. */
	readonly restore: string[];
	/** Paths present now but absent from the target tree. */
	readonly remove: string[];
}

/**
 * Split a base→target tree diff into restores and removals, dropping paths the
 * size guard excluded from the snapshot on either side.
 */
export function buildApplyPlan(entries: readonly git.TreeDiffEntry[], skippedFiles: readonly string[]): ApplyPlan {
	const skipped = new Set(skippedFiles);
	const restore: string[] = [];
	const remove: string[] = [];
	for (const entry of entries) {
		if (skipped.has(entry.path)) continue;
		// Diff direction is base → target, so "D" means the target lacks the path.
		if (entry.status === "D") remove.push(entry.path);
		else restore.push(entry.path);
	}
	return { restore, remove };
}

/**
 * Materialize the target content. Removals are unlinked from the working tree
 * and then dropped from the index, which handles tracked and untracked
 * creations with one code path; restores come out of the target tree into
 * worktree + index.
 */
async function applyTarget(
	worktreeRoot: string,
	targetTreeSha: string,
	plan: ApplyPlan,
	signal?: AbortSignal,
): Promise<void> {
	await git.withRepoLock(
		worktreeRoot,
		async () => {
			for (const relative of plan.remove) {
				await fs.rm(path.join(worktreeRoot, relative), { force: true, recursive: true });
			}
			if (plan.remove.length > 0) await git.stage.removeCached(worktreeRoot, plan.remove, signal);
			if (plan.restore.length > 0) {
				await git.restorePathsFromTree(worktreeRoot, targetTreeSha, plan.restore, { signal });
			}
		},
		signal,
	);
}

/**
 * Recapture the workspace and compare it with the target tree. Tree equality is
 * the fast path; when the trees differ the residual per-path diff decides,
 * because size-guard exclusions legitimately make the recaptured tree differ
 * from the target on exactly those paths.
 */
export async function verifyRollback(
	worktreeRoot: string,
	targetTreeSha: string,
	skippedFiles: readonly string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; residual: string[] }> {
	const verifyTree = await git.captureWorktreeTree(worktreeRoot, { excludePaths: skippedFiles, signal });
	if (verifyTree === targetTreeSha) return { ok: true, residual: [] };
	const entries = await git.diff.treeStatus(worktreeRoot, verifyTree, targetTreeSha, { signal });
	const skipped = new Set(skippedFiles);
	const residual = entries.filter(entry => !skipped.has(entry.path)).map(entry => entry.path);
	return { ok: residual.length === 0, residual };
}

export interface RollbackRequest {
	/** Checkpoint metadata root for the session. */
	readonly root: string;
	readonly sessionId: string;
	readonly identity: WorkspaceIdentity;
	readonly target: CheckpointMeta;
	readonly maxFileBytes: number;
	/**
	 * Capture the pre-rollback workspace. Injected by the service so the
	 * transaction reuses the ordinary create path (dedup, retention, metadata)
	 * without this module depending on it.
	 */
	readonly captureSafety: () => Promise<CheckpointMeta>;
	readonly signal?: AbortSignal;
}

/**
 * Run the full transaction. Returns `ok: false` with the journal left on disk
 * for every recoverable failure (verification mismatch, abort, git error);
 * throws only for programming errors that cannot be attributed to the workspace.
 */
export async function runRollbackTransaction(request: RollbackRequest): Promise<RollbackResult> {
	const { root, sessionId, identity, target, signal } = request;
	const worktreeRoot = identity.worktreePath;

	// PREPARE: snapshot the current state so the change set is computed against
	// content-addressed truth rather than status heuristics.
	const base = await captureWorkspaceTree(worktreeRoot, { maxFileBytes: request.maxFileBytes, signal });
	if (base.treeSha === target.treeSha) {
		// Workspace already matches the checkpoint: no safety capture, no writes.
		await clearJournal(root, sessionId);
		return { ok: true, restoredFiles: 0, removedFiles: 0 };
	}

	const now = new Date().toISOString();
	let journal: RollbackJournal = {
		sessionId,
		phase: "prepare",
		startedAt: now,
		updatedAt: now,
		identity,
		targetId: target.id,
		targetTreeSha: target.treeSha,
		baseTreeSha: base.treeSha,
		skippedFiles: base.skippedFiles,
	};
	await writeJournal(root, sessionId, journal);

	const advance = async (phase: RollbackPhase, patch: Partial<RollbackJournal> = {}): Promise<void> => {
		journal = { ...journal, ...patch, phase, updatedAt: new Date().toISOString() };
		await writeJournal(root, sessionId, journal);
	};

	let safetyCheckpoint: CheckpointMeta | undefined;
	let plan: ApplyPlan = { restore: [], remove: [] };
	try {
		// SAFETY: always taken when the workspace differs from the target.
		safetyCheckpoint = await request.captureSafety();
		await advance("safety", { safetyCheckpointId: safetyCheckpoint.id });

		// APPLY: minimal change set, worktree + index, HEAD untouched.
		const entries = await git.diff.treeStatus(worktreeRoot, base.treeSha, target.treeSha, { signal });
		plan = buildApplyPlan(entries, base.skippedFiles);
		await applyTarget(worktreeRoot, target.treeSha, plan, signal);
		await advance("apply");

		// VERIFY
		const verified = await verifyRollback(worktreeRoot, target.treeSha, base.skippedFiles, signal);
		if (!verified.ok) {
			const detail = `workspace does not match checkpoint ${target.id} after apply (${verified.residual.length} path(s) differ: ${verified.residual.slice(0, 5).join(", ")})`;
			await advance("failed", { error: detail });
			return {
				ok: false,
				safetyCheckpoint,
				restoredFiles: plan.restore.length,
				removedFiles: plan.remove.length,
				error: detail,
			};
		}
	} catch (error) {
		const message = toError(error).message;
		await advance("failed", { error: message });
		return {
			ok: false,
			safetyCheckpoint,
			restoredFiles: 0,
			removedFiles: 0,
			error: message,
		};
	}

	// COMMIT: the journal's absence is the "no transaction in flight" signal.
	await clearJournal(root, sessionId);
	return {
		ok: true,
		safetyCheckpoint,
		restoredFiles: plan.restore.length,
		removedFiles: plan.remove.length,
	};
}
