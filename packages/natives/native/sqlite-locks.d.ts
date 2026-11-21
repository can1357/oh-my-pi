import type { HeldFileKind } from "./index.js";

/**
 * Lazily loading forms of the SQLite lock exports in `index.d.ts`: the addon
 * loads on the first call instead of at import.
 */

/** Moves this process's SQLite record locks onto open-file-description locks; `false` when unavailable. */
export declare function installSqliteLockShim(): boolean;

/** How `path` is held by this process (open elsewhere and locked), or `null`. */
export declare function heldFileKind(path: string): HeldFileKind | null;
