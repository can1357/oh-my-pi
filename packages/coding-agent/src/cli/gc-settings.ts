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
