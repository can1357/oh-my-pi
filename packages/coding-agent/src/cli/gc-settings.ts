/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgGcBlobs = register({ id: "gc.blobs", type: "boolean", default: true });

export const cfgGcArchive = register({ id: "gc.archive", type: "boolean", default: true });

export const cfgGcWal = register({ id: "gc.wal", type: "boolean", default: true });

export const cfgGcColdArchiveAfterDays = register({ id: "gc.coldArchiveAfterDays", type: "number", default: 30 });

export const cfgGcRetainNewestGlobal = register({ id: "gc.retainNewestGlobal", type: "number", default: 20 });

export const cfgGcRetainNewestPerCwd = register({ id: "gc.retainNewestPerCwd", type: "number", default: 10 });

// Opt-in: unlike the other phases it deletes user-visible files (debug reports,
// collab replicas), so an unqualified `omp gc --apply` leaves them alone.
export const cfgGcStale = register({ id: "gc.stale", type: "boolean", default: false });

export const cfgGcStaleRetainNewest = register({ id: "gc.staleRetainNewest", type: "number", default: 20 });

export const cfgGcStaleRetainDays = register({ id: "gc.staleRetainDays", type: "number", default: 30 });
