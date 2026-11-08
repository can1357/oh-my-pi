//! `pi_shell::sys`: the OS-facing pieces of the bash engine.
//!
//! - [`NativeSpawner`]: spawns externals for a [`Host`](crate::bash::Host) and
//!   reports them as [`ExtProc`](crate::bash::ExtProc)s. Unix: each external
//!   leads its own session or process group, or stays in the host's
//!   ([`Sessions`]), via `posix_spawn` where possible; signals, `stop` and
//!   `cont` go to the whole group (the pid alone in the host's); an abandoned
//!   external gets TERM, then KILL after the grace. Windows: `CreateProcessW`
//!   into a Job Object per job (pause via `NtSuspendProcess`, KILL via
//!   `TerminateJobObject`, TERM via `CTRL_BREAK`). Leak checks list and kill
//!   what survives a command.
//! - [`StdFs`] and [`StdFile`]: the engine's [`Fs`](crate::bash::Fs) and
//!   [`File`](crate::bash::File) over `std::fs`, always `Ready` (local
//!   syscalls), for `obash` and tests.
//! - [`std_stream`]: the process's own stdin/stdout/stderr as engine files.
//! - [`Parker`]: blocks a drive loop's thread until the engine may make
//!   progress; on Linux it also waits for the exits of externals spawned with
//!   [`Exits::Park`].
//! - `proc` (Unix): the process table, session and group membership,
//!   identity-pinned signals.
//! - [`pathext`]: Windows `PATHEXT` executable resolution.
//! - [`shebang`]: `#!` parsing and the in-engine (`SelfShell`) mapping.
//! - [`cmdline`]: Windows command-line quoting.
//!
//! Executors that sandbox or virtualize the filesystem wrap or replace these.

pub mod cmdline;
#[cfg(windows)]
pub mod console;
mod fs;
mod fs_ops;
#[cfg(any(windows, test))]
mod job;
pub mod langinfo;
mod lifecycle;
mod park;
pub mod pathext;
pub mod pcre;
#[cfg(unix)]
pub mod proc;
mod pump;
#[cfg(unix)]
mod ready;
pub mod regex;
mod relay;
pub mod rlimit;
pub mod shebang;
#[cfg(unix)]
pub mod socket;
mod spawn;
pub mod tty;
pub mod uname;
pub mod user;
pub mod utmp;

#[cfg(windows)]
pub(crate) use crate::sys::spawn::break_console_groups;
pub use crate::sys::{
	fs::{StdFile, StdFs, std_stream},
	park::Parker,
	relay::{ByteDecoder, OutputDecoding},
	spawn::{Exits, Leftover, NativeSpawner, Sessions, SpawnConfig, dispositions_changed},
};
pub(crate) use crate::sys::{pump::End, relay::Relays};

/// The C library's `PATH_MAX`, which zsh sizes path buffers by. Windows has
/// no such limit for the engine's paths, so it takes Linux's.
#[cfg(unix)]
pub const PATH_MAX: usize = libc::PATH_MAX as usize;
#[cfg(not(unix))]
pub const PATH_MAX: usize = 4096;

#[cfg(test)]
mod suites;
