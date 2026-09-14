/**
 * Types for git-backed workspace checkpoints.
 *
 * A checkpoint is a snapshot of the working tree (tracked + untracked
 * non-ignored files) stored as a commit under
 * `refs/omp/checkpoints/<sessionId>/<id>` plus a metadata JSON file next to the
 * session's artifacts. HEAD, the current branch, and the user's index are never
 * moved by a capture.
 */

/**
 * The workspace a checkpoint belongs to. `repoRoot` is the primary checkout
 * (shared by linked worktrees, so it names the project); `worktreePath` is the
 * specific checkout whose files were snapshotted. Both are compared when a
 * checkpoint is validated, so a checkpoint captured in worktree A is never
 * offered — or applied — in worktree B of the same repository.
 */
export interface WorkspaceIdentity {
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly headSha: string | null;
	readonly branch: string | null;
}

/** Why a checkpoint was captured. `manual` and `pre-rollback` are retention-protected. */
export type CheckpointReason = "manual" | "auto" | "pre-rollback";

export interface CheckpointMeta {
	/** Short hex id (10 chars), unique within the session. */
	readonly id: string;
	readonly sessionId: string;
	readonly createdAt: string;
	/** User-supplied label (manual captures). */
	readonly label?: string;
	readonly reason: CheckpointReason;
	readonly identity: WorkspaceIdentity;
	/** Full working-tree snapshot tree (tracked + untracked non-ignored). */
	readonly treeSha: string;
	readonly headShaAtCapture: string | null;
	/** `refs/omp/checkpoints/<sessionId>/<id>`. */
	readonly refName: string;
	/** Absolute path of this metadata file. */
	readonly metaPath: string;
	/**
	 * Logical bytes the snapshot represents (sum of blob sizes in `treeSha`).
	 * Content shared with existing git objects costs no additional disk, so this
	 * is an upper bound on what the capture could have added, not a delta.
	 */
	readonly bytesCaptured: number;
	/** Paths excluded from the snapshot because they exceed `checkpoints.maxFileBytes`. */
	readonly skippedFiles: string[];
}

export interface CreateCheckpointOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly label?: string;
	readonly reason: CheckpointReason;
	readonly signal?: AbortSignal;
}

/**
 * Session surface used to record a rollback in the transcript. Structurally
 * satisfied by `SessionManager.appendCustomEntry`, so the checkpoints module
 * does not depend on the session package.
 */
export interface WorkspaceRollbackSessionSurface {
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface RollbackOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/**
	 * Optional session surface notified after a successful rollback. When
	 * omitted the caller is responsible for calling `emitWorkspaceRolledBack`.
	 */
	readonly notify?: WorkspaceRollbackSessionSurface;
}

export interface RollbackResult {
	readonly ok: boolean;
	/** Snapshot of the pre-rollback workspace, so a rollback is itself reversible. */
	readonly safetyCheckpoint?: CheckpointMeta;
	readonly restoredFiles: number;
	readonly removedFiles: number;
	readonly error?: string;
}

/** Phase reached by the in-flight rollback transaction. Absent journal ⇔ no transaction in flight. */
export type RollbackPhase = "prepare" | "safety" | "apply" | "failed";

export interface RollbackJournal {
	readonly sessionId: string;
	readonly phase: RollbackPhase;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly identity: WorkspaceIdentity;
	readonly targetId: string;
	readonly targetTreeSha: string;
	/** Tree captured before APPLY — what the workspace looked like going in. */
	readonly baseTreeSha: string;
	readonly safetyCheckpointId?: string;
	readonly skippedFiles: string[];
	readonly error?: string;
}

/** A checkpoint operation could not proceed (not a repository, unusable snapshot, guard tripped). */
export class CheckpointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CheckpointError";
	}
}
