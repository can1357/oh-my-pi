#![recursion_limit = "256"]

//! Production application CLI, TUI, and command dispatch.

mod acp_events;
pub mod acp_mode;
pub mod audio_coordinator;
pub mod auth_broker_cmd;
pub mod auth_cli;
pub mod auth_gateway_cmd;
pub mod bench_cmd;
pub mod browser_relay_cmd;
pub mod chat_cmd;
/// Session-owning controller behind `omp chat`.
#[cfg(any(unix, windows))]
pub(crate) mod chat_control;
/// Application feeds behind the chat host's dashboards and account commands.
pub mod chat_services;
/// Push-to-talk capture and recognition for `omp chat`.
pub mod chat_voice;
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
pub mod endpoint;
pub mod exit_diagnostics;
pub mod ext_cli;
pub mod gallery_cmd;
pub mod gateway_rpc;
pub mod gc_cmd;
pub mod git_cmd;
pub mod grievances_cmd;
#[cfg(feature = "gui")]
mod gui;
pub mod help_extra;
pub mod images_cmd;
pub mod keybindings;
mod live_path;
mod live_reachability;
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
/// Process- and presentation-level setting convars.
pub mod settings;
/// Feature-disabled local speech command.
#[cfg(not(feature = "local-tts"))]
pub mod say_cmd {
	use crate::cli::SayArgs;

	/// Reports that local speech synthesis was excluded from this build.
	pub async fn run(_args: SayArgs) -> miette::Result<()> {
		Err(miette::miette!("local speech synthesis is not built; rerun with `--features local-tts`"))
	}
}
pub mod session_import;
pub mod setup_cmd;
pub mod shell_cmd;
pub mod smoke_test;
pub mod spec;
pub mod ssh_cmd;
pub mod standalone_tool_cmd;
pub mod startup_notice;
mod startup_update;
pub mod stats_cmd;
pub mod theme_watcher;
pub mod tiny_models_cmd;
pub mod token_cmd;
pub mod tool_installer;
pub mod update_cmd;
pub mod usage_cmd;
pub mod usage_error;
pub mod voice;
pub mod welcome_facts;
pub mod worktree_cmd;

use std::path::{Path, PathBuf};

pub use miette::{IntoDiagnostic, Report, Result};

/// Returns the archived command-stream configuration path for the selected
/// profile: `<config dir>/config.cfg` (`~/.o2/config.cfg` by default,
/// `~/.o2/profiles/<profile>/config.cfg` under `--profile`/`OMP_PROFILE`,
/// `OMP_CONFIG_DIR` overrides the root).
///
/// # Errors
///
/// Returns a directory error when no home directory is set or the selected
/// profile is invalid.
pub fn config_path() -> std::result::Result<PathBuf, omp_core::dirs::DataDirError> {
	Ok(omp_driver::cfg::CfgFiles::new(None)?.user_path("config"))
}

/// Builds the process control context from user and exact-project cfg files.
///
/// The default bind cfg ([`keybindings::DEFAULT_BINDS`]) executes first, then
/// user configuration, then `<project>/.omp/config.cfg` overlays it.
pub fn process_ctx(project_root: &Path) -> Result<omp_con::Ctx> {
	process_ctx_with(project_root, omp_con::Ctx::builder())
}

/// [`process_ctx`] over a caller-prepared builder (reply sink, user objects).
///
/// The [`omp_driver::cfg::CfgFiles`] resolver stays installed as the
/// context's loader and saver, so `exec <profile>` and `writecfg` (model
/// picker, `/settings`, `omp config set`) work for the whole process life
/// (ADR 0014), reading `<user>/<name>.cfg` plus the `<project>/.omp`
/// overlay and writing the user file atomically.
pub fn process_ctx_with(project_root: &Path, builder: omp_con::CtxBuilder) -> Result<omp_con::Ctx> {
	let files = omp_driver::cfg::CfgFiles::new(Some(project_root)).into_diagnostic()?;
	let loader = files.clone();
	let saver = files.clone();
	let ctx = builder
		.loader(move |name: &str| loader.load(name))
		.saver(move |name: &str, contents: &str| omp_con::CfgSaver::save(&saver, name, contents))
		.build();
	ctx.exec(
		keybindings::DEFAULT_BINDS,
		omp_con::Source::Config(omp_core::Str::new_static(keybindings::DEFAULT_BINDS_NAME)),
	)
	.into_diagnostic()?;
	ctx.seal_bind_defaults();
	let outcome = ctx.exec_configs(&files, None).into_diagnostic()?;
	if outcome.failed > 0 {
		tracing::warn!(
			failed = outcome.failed,
			ran = outcome.ran,
			"config.cfg contained statements this build does not understand; they were skipped"
		);
	}
	Ok(ctx)
}

/// Parses process arguments and runs the selected production operation.
pub async fn run() -> Result<()> {
	cli::run().await
}
