/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/**
 * The one sentence every surface says about blob reclamation.
 *
 * Three places have to carry it — the flag's help, the setting's interface
 * description, and the output of a run that reclaims — and when each held
 * its own wording they drifted: the setting's copy lost "stop every session
 * writer first", and the flag's lost the checkpoint-only alternative. A
 * warning that is only as good as its least complete copy is worth exactly
 * that, so there is one copy.
 */
export const GC_BLOBS_WARNING =
	"Quiescent machines only: concurrent session writes can permanently delete a blob a readable " +
	"session still references. Stop every session writer first, including any that holds no ownership " +
	"lease. `omp gc --wal --apply` checkpoints the databases and reclaims nothing, whatever is " +
	"configured — and `gc.blobs: true` in any configuration layer makes an unqualified `omp gc --apply` " +
	"reclaim without the flag.";

// Opt-in, default off, because reference discovery cannot be made sound
// while sessions are being written. Deciding that a blob is unreferenced
// means reading every session that could refer to it, and a session can be
// created, forked, moved to a sibling or appended to while that reading is
// happening — so the answer describes a tree that no longer exists. Measured
// at the head of #18224, which rewrites that walk: a live transcript stored
// in the blob store and linked into the sessions tree is deleted with
// `errors: []` and exit 0, and so are the link hops a session's path runs
// through. `--blobs`, or `gc.blobs`, turns the phase on for a machine whose
// sessions are quiescent.
export const cfgGcBlobs = register({
	id: "gc.blobs",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Developer",
		label: "Reclaim Unreferenced Blobs",
		description: `Reclaim unreferenced blobs during \`omp gc --apply\`. ${GC_BLOBS_WARNING}`,
		warning: "Can permanently delete data a readable session references while sessions are being written.",
	},
});

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

// Opt-in: rewrites cold session files in place through the filesystem's
// transparent compression (APFS, NTFS), so it needs an explicit request.
export const cfgGcCompress = register({ id: "gc.compress", type: "boolean", default: false });

export const cfgGcCompressAfterDays = register({ id: "gc.compressAfterDays", type: "number", default: 7 });

// Opt-in: an interactive launch starts a detached `omp gc --compress --apply`
// at most once a day, so idle sessions get compressed without anyone asking.
export const cfgGcAutoCompress = register({ id: "gc.autoCompress", type: "boolean", default: false });
