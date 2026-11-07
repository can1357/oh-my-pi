//! `pi_shell::bash`: a bash 5.3 engine built for hosts that need to watch,
//! pause, cancel and snapshot what a shell runs.
//!
//! # Overview
//!
//! - [`Engine`]: shared per process (compiled-unit cache).
//! - [`Shell`]: one shell's transient execution state. Persistent state
//!   (variables, options, `$0`, positional parameters, …) lives in a host-owned
//!   [`StateStore`]; every side effect goes through a [`Host`].
//! - [`Shell::step`] drives the cooperative scheduler of virtual processes from
//!   the caller's thread; every IR op is a safepoint where [`ControlHandle`]
//!   requests (pause, cancel, signals, suspend) apply. `trap` actions run
//!   there; `kill` sends virtual signals in-engine or asks the host to signal
//!   OS processes.
//! - Events ([`Event`]) report what runs, node by node, with spans into units a
//!   client can re-parse with [`syntax`].
//! - [`Shell::externalize`] / [`Shell::restore`] move the running state through
//!   the store, across processes.
//!
//! # Example
//!
//! ```ignore
//! let engine = Engine::new(EngineConfig::default());
//! let mut cx = Cx { host: &mut host, store: &mut store };
//! let mut shell = Shell::create(&engine, &mut cx, ShellInit::default())?;
//! let run = shell.submit(Script::command(&b"for i in 1 2; do echo $i; done"[..]));
//! loop {
//!     match shell.step(&mut cx, Budget::default()) {
//!         Step::Done { run: r, status } if r == run => break status,
//!         Step::Call { id, call } => shell.complete(id, run_callout(call)),
//!         Step::Blocked | Step::Paused => wait_for(shell.control()),
//!         _ => {},
//!     }
//! }
//! ```

#![forbid(unsafe_code)]

pub mod diag;
mod engine;
mod error;
pub mod event;
mod fd;
pub mod fs;
mod host;
mod ids;
pub mod invocation;
pub mod ir;
mod mem;
mod mem_store;
mod packed_names;
pub mod signal;
pub mod snapshot;
pub mod socket;
pub mod store;
pub mod term;
mod text;
pub mod trace;
mod vm;
pub mod zshopt;

pub mod pattern;
pub mod syntax;

/// zsh/newuser's startup check: the `newuser` scripts an interactive zsh
/// sources after `/etc/zshenv` when the user has no startup files.
pub use crate::bash::vm::newuser_startup_scripts;
pub use crate::bash::{
	diag::Diag,
	engine::{Engine, EngineConfig},
	error::{ExtError, Incompatibility, RestoreError, ShellError},
	event::{
		CompiledUnit, CustomEvent, Event, EventData, EventKind, EventMask, EventSink, NodeRef,
		Origin, SpanRef, WaitKey,
	},
	fd::{BadFd, FdFlags, FdRef},
	fs::{DirEntry, DirIter, File, FileKind, Fs, FsPending, FsPoll, OpenFlags, Stat},
	host::{
		ChildRedir, ChildRedirs, CpuTimes, Deadline, EnvView, ExitStatus, ExtProc, Host, Invocation,
		Lineage, Login, Logins, OsHandle, PgroupSpec, PipeMirror, PipeTap, ProcEvent, ResolveCtx,
		Resolved, Rlimit, SpawnFuture, SpawnSpec, StdFd, StdioSpec, SystemTimeLike, Task, Timer,
		TtyInfo, UserInfo, Verdict, Via,
	},
	ids::{
		AstNodeId, CallId, CmdTag, Dialect, IntrinsicId, JobId, ModeId, NativeRef, Platform, RunId,
		ToolRef, UnitId, Vpid,
	},
	mem_store::MemStore,
	signal::{SigSet, SigTarget, Signal},
	snapshot::{ExternalizeReport, Lost, RestoreOpts, RestoreReport},
	socket::{Accepted, IpFamily, ListenError, ListenStage, SockAddr, Sockets},
	store::{Attrs, StateStore, StoreError, VarValue},
	term::{CtlChar, Pty, SetWhen, Shtty, TermFlag, Terminal, Termios},
	vm::{
		Budget, CallOutcome, ControlHandle, Cx, IoPoll, Profile, RunStdio, Script, Shell, ShellApi,
		ShellInit, Step, ToolCall, VprocSel, WakeToken, vproc_layout,
	},
};
