pub mod cancel;
mod coreutils;
mod fd;
pub mod fixup;
pub mod minimizer;
pub mod process;
pub mod shell;
#[cfg(windows)]
pub mod windows;

pub use brush_core::commands::{ChildSessionAction, child_session_action};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
