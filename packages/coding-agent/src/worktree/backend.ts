import type { IsoBackendKind, VcsGitRepo } from "@oh-my-pi/pi-natives";
import type { Settings } from "../config/settings";

/** A session worktree and the identity of the backend that owns it. */
export interface SessionWorktree {
	path: string;
	branch: string;
	sourceCwd: string;
	baseCommit: string;
	keptChanges: boolean;
	clonedWith?: IsoBackendKind;
	cloneError?: string;
	ovnfs?: OvnfsCheckout;
}

/** Identity and provenance of a managed ovnfs checkout. */
export interface OvnfsCheckout {
	command: string;
	checkout: string;
	created: string;
}

/** Validated request to create a worktree from a Git checkout. */
export interface WorktreeStart {
	repository: VcsGitRepo;
	settings: Settings;
	branch: string;
	sourceCwd: string;
	baseCommit: string;
	keptChanges: boolean;
}

/** Repository handles needed to inspect a worktree and its branch. */
export interface WorktreeInspection {
	checkout: VcsGitRepo | null;
	branchRepo: VcsGitRepo | null;
	missingBranchRepoMeansMoved: boolean;
}

/** An entry managed by `omp worktree list|clear`. */
export interface ManagedWorktree {
	path: string;
	kind: "pr-checkout" | "task-isolation" | "empty" | "stray" | "ovnfs";
	parentRepo?: string;
	branch?: string;
	orphanReason?: string;
	/** Teardown uses the owning backend, never the current creation preference. */
	remove(): Promise<void>;
}

/** A checkout's location and the original working directory it was forked from. */
export interface WorktreeLocation {
	root: string;
	source: string;
	/** The daemon is unavailable; a missing mount does not mean the checkout was removed. */
	offline?: boolean;
	/** A removed checkout still has a session bucket, but no longer owns its path. */
	removed?: boolean;
}

/** Checkout operations used by session relocation, resume, and worktree maintenance. */
export interface WorktreeBackend {
	create(start: WorktreeStart): Promise<SessionWorktree>;
	inspect(worktree: SessionWorktree): Promise<WorktreeInspection>;
	remove(worktree: SessionWorktree, moved: boolean): Promise<void>;
	managed(): Promise<ManagedWorktree[]>;
	locations(cwd: string): Promise<WorktreeLocation[]>;
}
