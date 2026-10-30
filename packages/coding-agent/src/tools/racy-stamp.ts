/**
 * Stats whose change time is younger than this are never memoized (git's
 * racy-clean rule): on coarse-timestamp filesystems a same-size rewrite inside
 * one timestamp granule leaves the whole stat unchanged.
 */
export const RACY_STAMP_WINDOW_MS = 2_000;
