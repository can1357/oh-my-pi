//! `omp_shell::sys`: the OS-facing pieces of the bash engine.
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

/// Put back `old`, the mask `pthread_sigmask` read from the calling thread.
/// On Linux with the system call on the kernel's 64-signal set, the first
/// word of `old`: glibc's `pthread_sigmask` leaves its internal signals 32
/// and 33 out of a set it sets, so it would drop a block of them the thread
/// had (one made with the system call). Async-signal-safe: a forked child
/// calls it too.
#[cfg(unix)]
pub(crate) fn restore_mask(old: &libc::sigset_t) {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		const _: () = assert!(size_of::<libc::sigset_t>() >= size_of::<u64>());
		// SAFETY: `old` is an initialized set at least as large as the
		// kernel's, which the kernel only reads; no old set is wanted.
		unsafe {
			libc::syscall(
				libc::SYS_rt_sigprocmask,
				libc::SIG_SETMASK,
				std::ptr::from_ref(old).cast::<u64>(),
				std::ptr::null_mut::<u64>(),
				size_of::<u64>(),
			)
		};
	}
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	{
		// SAFETY: `old` is the mask pthread_sigmask gave this thread.
		unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, old, std::ptr::null_mut()) };
	}
}

#[cfg(test)]
mod suites;
