//! Externalize / restore contract types.
//!
//! # What `externalize` writes
//!
//! The shell's tables (variables, the root shell's function scopes, jobs,
//! child processes, options, traps, cwd, counters, …) are in the store at
//! all times ([`crate::bash::store`]); a heap snapshot taken between two engine
//! calls holds them without `externalize`, and
//! [`Shell::restore`](crate::bash::Shell::restore) without a `Frames` blob
//! continues from them (a command that was running is gone; a child vproc
//! that was running is reported [`Lost::Vproc`] and its job ends with
//! status 137).
//! `externalize` adds what only the engine has, the execution position:
//! the `Frames` blob (frames, partial words, staged ops, fd tables with
//! in-memory pipe contents, subshell overlays and scopes, pending calls and
//! signals, the scheduler) plus the unit blobs live frames need. A running
//! background job's table entry is live in the store; its execution
//! position needs `externalize` at a safepoint.
//!
//! # When `externalize` is complete
//!
//! [`Shell::externalize`](crate::bash::Shell::externalize) may be called
//! between any two steps. The snapshot is *complete* only right after
//! [`Step::SuspendReady`](crate::bash::Step::SuspendReady), which the engine
//! returns once, after
//! [`ControlHandle::request_suspend`](crate::bash::ControlHandle::request_suspend),
//! when all of the following hold:
//!
//! - every virtual process sits at an op boundary or at a stage boundary of a
//!   staged op (its partial progress is in frame locals);
//! - no *mutating* filesystem operation is in flight (open with
//!   create/truncate/append/exclusive, `mkfifo_or_temp`); while one is, `step`
//!   keeps returning `Blocked`;
//! - pending *idempotent* filesystem operations have been dropped (cancelled)
//!   and are recorded to be re-issued after restore.
//!
//! In-flight [`Task`](crate::bash::Task)s, externals and host callouts do not
//! delay `SuspendReady`: callouts stay pending (the host's suspended callout
//! lives in the same heap snapshot and answers with `complete` after restore),
//! and tasks and externals are checkpointed or reported [`Lost`]. A host that
//! wants quiescence waits for them before requesting the suspend.
//!
//! # What is lost
//!
//! [`ExternalizeReport::lost`] lists, without changing the running shell:
//! every external process in flight, including programs that outlived their
//! virtual owner, every task whose `checkpoint` returned `None`, and every fd
//! backed by a host object that cannot be re-acquired (per-run stdio).
//! [`RestoreReport::lost`] also reports those ownerless programs with their
//! original virtual-process and native-process identifiers; it does not
//! recreate their completed owners. Lost commands with waiters finish with
//! status 137 and a `Lost` event; lost fds read EOF and fail writes with
//! "Bad file descriptor".
//!
//! # Engine upgrades
//!
//! Frames images require the same layout version and engine build. An
//! incompatible image returns
//! [`RestoreError::Incompatible`](crate::bash::RestoreError::Incompatible)
//! before reading any state-store records and leaves the stored image intact.
//! There is no automatic migration or abandonment. With the same magic and
//! IR version, a host can explicitly use [`RestoreOpts::drop_frames`] to keep
//! root state and abandon running scripts with status 255. Differing magic or
//! IR versions are refused in every restore mode because record keys may
//! differ. A shell already running in the old library continues there, but its
//! frames cannot be resumed by an incompatible new library. Stores without a
//! Frames image do not have this layout restriction.

use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::FileKind,
	ids::{NativeRef, RunId, Vpid},
};

/// Options of [`Shell::restore`](crate::bash::Shell::restore).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RestoreOpts {
	/// Ignore the frames blob: keep root state, abandon the scripts that were
	/// running (each reports `Done` with status 255). Recovery for a different
	/// frames layout or build, but not a different magic or IR record schema.
	pub drop_frames: bool,
}

/// Result of [`Shell::externalize`](crate::bash::Shell::externalize).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalizeReport {
	/// Size of the frames blob.
	pub bytes:         usize,
	/// Unit blobs written by this call.
	pub units_written: u32,
	/// Pending idempotent fs operations, and external spawns the host had
	/// not finished (no process exists; the spawn is dropped), that restore
	/// re-issues.
	pub reissued_fs:   u32,
	/// What a restore of this snapshot cannot bring back.
	pub lost:          Vec<Lost>,
}

/// Result of [`Shell::restore`](crate::bash::Shell::restore).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreReport {
	/// Virtual processes rebuilt.
	pub vprocs:        u32,
	/// Scripts resumed.
	pub runs:          u32,
	/// Idempotent fs operations and unfinished external spawns that will be
	/// re-issued.
	pub reissued_fs:   u32,
	/// Tasks resumed from checkpoints.
	pub tasks_resumed: u32,
	/// What could not be brought back.
	pub lost:          Vec<Lost>,
	/// Scripts abandoned by [`RestoreOpts::drop_frames`] (status 255).
	pub abandoned:     Vec<RunId>,
}

/// Something a snapshot cannot carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Lost {
	/// An external process in flight, even if its virtual owner has ended.
	Ext {
		/// Its original virtual process (which need not be restored).
		vpid: Vpid,
		/// OS pid.
		pid:  u32,
	},
	/// A native task without a checkpoint (or whose restore failed).
	Task {
		/// Its virtual process.
		vpid:   Vpid,
		/// Native handle.
		native: NativeRef,
	},
	/// An open or read of a host pipe, FIFO, socket or device in flight
	/// (`. fifo`, `echo x > fifo &`): a FIFO open is a rendezvous with the
	/// other end and a read consumed bytes, so neither can be dropped and
	/// re-issued (a regular file's are re-issued instead).
	Pending {
		/// The virtual process waiting for it.
		vpid: Vpid,
		/// What the host object is.
		kind: FileKind,
	},
	/// A child vproc the store lists as running when a shell is restored
	/// without its `Frames` blob: its execution position was never
	/// externalized. Its status becomes 137 (its job, if any, is done).
	Vproc {
		/// The virtual process.
		vpid: Vpid,
	},
	/// An fd backed by a host object that cannot be re-acquired.
	Fd {
		/// Owning virtual process.
		vpid: Vpid,
		/// fd number.
		fd:   i32,
		/// What the host object was (file, pipe, socket, terminal, device),
		/// so a consumer can tell which open OS handle was dropped.
		kind: FileKind,
	},
}
