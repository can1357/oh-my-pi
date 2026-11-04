//! `pi-shell`: pi's embedded bash.
//!
//! One crate, in layers:
//!
//! - [`bash`]: the bash 5.3 engine (with zsh dialect): [`bash::syntax`] parses,
//!   [`bash::pattern`] matches globs and regexes, the VM runs scripts as
//!   cooperatively scheduled virtual processes, and every side effect goes
//!   through the [`bash::Host`] seam.
//! - [`sys`]: the OS pieces of a host (process spawning and groups, the
//!   `std::fs` filesystem, readiness, parking).
//! - pi's host: [`vfs::VfsFs`] (the engine's filesystem over `pi-vfs`),
//!   [`host::PiHost`], [`session::Session`] (a persistent shell driven by a
//!   task on the caller's runtime), [`tools`] (`timeout`, `nohup`, `git` and
//!   the command-running extras as host callouts), [`extras`] (pi's utilities
//!   from `pi-builtins` as engine commands) and [`git`] (the guard and
//!   in-process worktree layers).
//! - The API pi-natives uses: [`Shell`], [`execute_shell`],
//!   [`execute_shell_streams`], [`minimizer`], [`taps`], [`cancel`],
//!   [`process`].
//! - [`testkit`]: a deterministic test host for the engine suites and the fault
//!   injector of the `obash` binary (`src/bin/obash`: the engine as a
//!   standalone shell, for differential tests and benchmarks against bash).

// The parser is `no_std`-clean and names `alloc` paths.
extern crate alloc;

pub mod bash;
pub mod extras;
pub mod git;
pub mod host;
pub mod session;
pub mod sys;
pub mod testkit;
pub mod tools;
pub mod vfs;

#[cfg(test)]
mod suites;

pub mod cancel;
mod child_session;
pub mod minimizer;
pub mod output_decode;
mod paths;
pub mod process;
pub mod shell;
pub mod taps;

#[cfg(windows)]
pub mod windows;

pub use child_session::{ChildSessionAction, child_session_action};
// Windows path spellings for host paths presented by the CLI.
pub use paths::{expand_to_long_path, get_short_path};
// Re-exported for `pi-natives`: the builtins live in `pi-builtins`,
// but the native layer only ever depends on the shell.
pub use pi_builtins::{
	panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available,
};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
pub use taps::{PipeStreamInfo, PipeStreamRead, PipeTaps};
