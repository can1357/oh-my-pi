/**
 * The names an artifact copy builds under, in a module of their own.
 *
 * `session-manager.ts` owns the copy; these two names are also what tells
 * everything else that a copy is in flight, and one of those readers is the
 * evaluation worker, which cannot import the session manager without loading
 * the native addon with it.
 */

/** Suffix of the directories an artifact copy builds itself in. */
export const ARTIFACT_STAGING_SUFFIX = ".staging";

/** Name of the marker a copy writes into its staging tree to prove the tree is its own. */
export const ARTIFACT_STAGING_MARKER = ".omp-staging";
