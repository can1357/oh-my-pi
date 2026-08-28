pub mod cancel;
pub mod minimizer;
pub mod process;
pub mod shell;
#[cfg(windows)]
pub mod windows;

pub use brush_core::commands::{ChildSessionAction, child_session_action};
// Re-exported for `pi-natives`: the builtins live in `pi-builtins`,
// but the native layer only ever depends on the shell.
pub use pi_builtins::{
	panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available,
};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
