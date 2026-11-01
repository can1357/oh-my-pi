/**
 * The names an artifact copy builds under, in a module of their own.
 *
 * `session-manager.ts` owns the copy, and the walkers that list a session's
 * files have to know which directories are a copy's rather than a session's.
 * They are not a readiness signal: a tree exists only once a copy has started
 * building, and one left behind by a copy that was killed is kept. Whether a
 * copy is in flight is asked of the process running it (see
 * `eval/artifact-readiness.ts`).
 */

/** Suffix of the directories an artifact copy builds itself in. */
export const ARTIFACT_STAGING_SUFFIX = ".staging";

/** Name of the marker a copy writes into its staging tree to prove the tree is its own. */
export const ARTIFACT_STAGING_MARKER = ".omp-staging";
