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
//! every external process in flight, every task whose `checkpoint` returned
//! `None`, and every fd backed by a host object that cannot be re-acquired
//! (per-run stdio). After restore their waiters see status 137 and a `Lost`
//! event; lost fds read EOF and fail writes with "Bad file descriptor".

use serde::{Deserialize, Serialize};

use crate::bash::{
	error::Incompatibility,
	fs::FileKind,
	ids::{NativeRef, RunId, Vpid},
};

/// Shared, versioned snapshot entries outside the frozen execution core.
pub mod vocabulary;

/// Options of [`Shell::restore`](crate::bash::Shell::restore).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RestoreOpts {
	/// Abandon execution and keep root state. Every old script reports `Done`
	/// with status 255; no old execution is resumed. Unlike ordinary refusal,
	/// which leaves persisted bytes unchanged, this consumes the Frames blob.
	/// The report distinguishes incompatibility from requested abandonment;
	/// root-store integrity is still checked.
	pub drop_frames:   bool,
	/// Seed `$RANDOM` from the host instead of continuing the snapshot's
	/// sequence, as bash reseeds a forked subshell: shells restored from one
	/// image next to each other would otherwise draw the same numbers.
	pub reseed_random: bool,
}

/// Why execution was deliberately discarded by [`RestoreOpts::drop_frames`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FrameAbandonment {
	/// Header and vocabulary passed preflight; the caller requested abandonment.
	/// The discarded execution core was not decoded or validated.
	Requested,
	/// Ordinary restore would refuse this image as incompatible.
	Incompatible {
		/// The same incompatibility ordinary restore reports.
		why: Incompatibility,
	},
	/// The vocabulary metadata could not be decoded or validated.
	Unreadable,
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
	pub vprocs:           u32,
	/// Scripts resumed.
	pub runs:             u32,
	/// Idempotent fs operations and unfinished external spawns that will be
	/// re-issued.
	pub reissued_fs:      u32,
	/// Tasks resumed from checkpoints.
	pub tasks_resumed:    u32,
	/// What could not be brought back.
	pub lost:             Vec<Lost>,
	/// Scripts abandoned by [`RestoreOpts::drop_frames`] (status 255).
	pub abandoned:        Vec<RunId>,
	/// Reason execution was discarded, or `None` if no Frames blob was dropped.
	pub frames_abandoned: Option<FrameAbandonment>,
}

/// Something a snapshot cannot carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Lost {
	/// An external process in flight.
	Ext {
		/// Its virtual process.
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
	/// A historical Misc record this reader preserves but cannot interpret.
	Record {
		/// Original numeric Misc-key identifier.
		id: u32,
	},
	/// An optional vocabulary entry preserved without applying its payload.
	Vocabulary {
		/// Permanent entry identifier.
		id:       u32,
		/// Unrecognized payload revision.
		revision: u32,
		/// Owning virtual process, or shell-wide state.
		vpid:     Option<Vpid>,
	},
}
