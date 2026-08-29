#![recursion_limit = "256"]

//! Production application CLI, TUI, and command dispatch.

pub mod acp_mode;
pub mod agents_cmd;
pub mod audio_coordinator;
pub mod auth_broker_cmd;
pub mod auth_cli;
pub mod auth_gateway_cmd;
pub mod bench_cmd;
pub mod browser_relay_cmd;
pub mod chat_cmd;
/// Native chat surface, public so command-template prompt goldens can freeze
/// its output.
#[doc(hidden)]
pub mod chat_ui;
pub mod cleanse_cmd;
pub mod cli;
pub mod commit_cmd;
pub mod complete_cmd;
pub mod completions;
pub mod compress_cmd;
pub mod config_cmd;
pub mod cursor_bridge;
pub mod daemon;
pub mod debug;
pub mod debug_logs;
pub mod diagnostics;
pub mod dry_balance_cmd;
pub mod editor;
pub mod endpoint;
pub mod ext_cli;
pub mod extension_trust;
pub mod gallery_cmd;
pub mod gateway_rpc;
pub mod gc_cmd;
pub mod git_cmd;
pub mod git_tui;
pub mod grep_cmd;
pub mod grievances_cmd;
#[cfg(feature = "gui")]
mod gui;
pub mod help_extra;
pub mod image_attachment;
pub mod images_cmd;
pub mod join_cmd;
pub mod keybindings;
pub mod models_cmd;
pub(crate) mod pickers;
pub mod print_mode;
pub mod profile_alias;
pub mod progress_reporter;
pub mod ps_cmd;
pub mod render_cmd;
pub mod rpc_mode;
#[cfg(feature = "local-tts")]
pub mod say_cmd;
/// Feature-disabled local speech command.
#[cfg(not(feature = "local-tts"))]
pub mod say_cmd {
	use crate::cli::SayArgs;

	/// Reports that local speech synthesis was excluded from this build.
	pub async fn run(_args: SayArgs) -> miette::Result<()> {
		Err(miette::miette!("local speech synthesis is not built; rerun with `--features local-tts`"))
	}
}
pub mod session_manager;
pub mod setup_cmd;
pub mod share_cmd;
pub mod shell_cmd;
pub mod smoke_test;
pub mod spec;
pub mod ssh_cmd;
pub mod standalone_tool_cmd;
pub mod startup_notice;
pub mod stats_cmd;
pub mod theme_watcher;
#[cfg(feature = "local")]
pub mod tiny_models_cmd;
pub mod token_cmd;
#[cfg(feature = "local")]
pub mod tool_installer;
pub mod ttsr_cmd;
pub mod update_cmd;
pub mod usage_cmd;
pub mod usage_error;
pub mod voice;
pub mod wizard;
pub mod worktree_cmd;

pub use miette::{IntoDiagnostic, Report, Result};
use omp_driver::prompt_prep::settings::PromptOverrides;

impl From<&cli::PromptArgs> for PromptOverrides {
	fn from(args: &cli::PromptArgs) -> Self {
		Self {
			personality:             args.personality,
			include_model_in_prompt: args.include_model_in_prompt,
			include_workstation:     args.include_workstation,
			include_workspace_tree:  args.include_workspace_tree,
			render_mermaid:          args.render_mermaid,
			skills_enabled:          args.skills_enabled,
			custom_prompt:           args.custom_prompt.clone(),
			append_prompt:           args.append_prompt.clone(),
			null_prompt:             args.null_prompt,
		}
	}
}

/// Parses process arguments and runs the selected production operation.
pub async fn run() -> Result<()> {
	cli::run().await
}
