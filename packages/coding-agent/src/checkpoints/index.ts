/**
 * Git-backed workspace checkpoints and rollback.
 *
 * `WorkspaceCheckpointService` is the entry point: `create` snapshots the
 * working tree into `refs/omp/checkpoints/<sessionId>/<id>` plus a metadata file
 * beside the session's artifacts, and `rollback` restores one of those snapshots
 * through a journaled transaction that always captures the pre-rollback state
 * first. Neither ever moves HEAD or the current branch.
 */
export * from "./capture";
export * from "./notify";
export * from "./rollback";
export * from "./service";
export * from "./store";
export * from "./types";
