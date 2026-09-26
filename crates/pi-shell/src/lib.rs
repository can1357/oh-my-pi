pub mod cancel;
pub mod minimizer;
pub mod output_decode;
pub mod process;
pub mod shell;

#[cfg(windows)]
pub mod windows;

pub use brush_core::commands::{ChildSessionAction, child_session_action};
// Reuse brush's Windows path spellings for host paths presented by the CLI.
pub use brush_core::sys::fs::{expand_to_long_path, get_short_path};
// Re-exported for `pi-natives`: the builtins live in `pi-builtins`,
// but the native layer only ever depends on the shell.
pub use pi_builtins::{
	panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available,
};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
