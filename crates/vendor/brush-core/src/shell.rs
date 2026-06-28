//! Module defining the core shell structure and behavior.

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
	sync::Arc,
};

use tokio::sync::Mutex;

use crate::{
	ExecutionControlFlow, ExecutionResult, builtins, env::ShellEnvironment, error, extensions,
	functions, interfaces, jobs, keywords, openfiles, options::RuntimeOptions, pathcache,
	wellknownvars,
};

/// Type for storing a key bindings helper.
pub type KeyBindingsHelper = Arc<Mutex<dyn interfaces::KeyBindings>>;

/// Type alias for shell file descriptors.
pub type ShellFd = i32;

// NOTE: The submodule files below (e.g., `shell/traps.rs`,
// `shell/callstack.rs`) contain `impl Shell<SE>` blocks that provide methods
// coordinating with types defined in the corresponding top-level modules (e.g.,
// `traps.rs`, `callstack.rs`). This is an intentional layered architecture:
// top-level modules define domain types and data structures, while
// shell/ submodules implement Shell methods that operate on those types.

mod builder;
mod builtin_registry;
mod callstack;
mod completion;
mod env;
mod execution;
mod expansion;
mod fs;
mod funcs;
mod history;
mod initscripts;
mod io;
mod job_control;
mod parsing;
mod prompts;
mod readline;
mod state;
mod traps;

pub use builder::{CreateOptions, ShellBuilder, ShellBuilderState};
pub use initscripts::{ProfileLoadBehavior, RcLoadBehavior};
pub use state::ShellState;

/// Represents an instance of a shell.
///
/// # Type Parameters
///
/// * `SE` - The shell extensions implementation to use. These extensions are
///   statically injected into the shell at compile time to provide custom
///   behavior. When unspecified, defaults to `DefaultShellExtensions`, which
///   provide standard behavior.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Shell<SE: extensions::ShellExtensions = extensions::DefaultShellExtensions> {
	/// Injected error behavior.
	#[cfg_attr(feature = "serde", serde(skip, default = "default_error_formatter"))]
	error_formatter: SE::ErrorFormatter,

	/// Trap handler configuration for the shell.
	traps: crate::traps::TrapHandlerConfig,

	/// Manages files opened and accessible via redirection operators.
	open_files: openfiles::OpenFiles,

	/// The current working directory.
	working_dir: PathBuf,

	/// The shell environment, containing shell variables.
	env: ShellEnvironment,

	/// Shell function definitions.
	funcs: functions::FunctionEnv,

	/// Runtime shell options.
	options: RuntimeOptions,

	/// State of managed jobs.
	/// TODO(serde): Need to warn somehow that jobs cannot be serialized.
	#[cfg_attr(feature = "serde", serde(skip))]
	jobs: jobs::JobManager,

	/// Shell aliases.
	aliases: HashMap<String, String>,

	/// The status of the last completed command.
	last_exit_status: u8,

	/// Tracks changes to `last_exit_status`.
	last_exit_status_change_count: usize,

	/// The status of each of the commands in the last pipeline.
	last_pipeline_statuses: Vec<u8>,

	/// Clone depth from the original ancestor shell.
	depth: usize,

	/// Shell name
	name: Option<String>,

	/// Positional shell arguments (not including shell name).
	args: Vec<String>,

	/// Shell version
	version: Option<String>,

	/// Detailed display string for the shell
	product_display_str: Option<String>,

	/// Function/script call stack.
	call_stack: crate::callstack::CallStack,

	/// Directory stack used by pushd et al.
	directory_stack: Vec<PathBuf>,

	/// Completion configuration.
	completion_config: crate::completion::Config,

	/// Shell built-in commands.
	#[cfg_attr(feature = "serde", serde(skip))]
	builtins: HashMap<String, builtins::Registration<SE>>,

	/// Shell program location cache.
	program_location_cache: pathcache::PathCache,

	/// Last "SECONDS" captured time.
	last_stopwatch_time: std::time::SystemTime,

	/// Last "SECONDS" offset requested.
	last_stopwatch_offset: u32,

	/// Parser implementation to use.
	#[cfg_attr(feature = "serde", serde(skip))]
	parser_impl: crate::parser::ParserImpl,

	/// Key bindings for the shell, optionally implemented by an interactive
	/// shell.
	#[cfg_attr(feature = "serde", serde(skip))]
	key_bindings: Option<KeyBindingsHelper>,

	/// History of commands executed in the shell.
	history: Option<crate::history::History>,
}

impl<SE: extensions::ShellExtensions> Clone for Shell<SE> {
	fn clone(&self) -> Self {
		Self {
			error_formatter: self.error_formatter.clone(),
			traps: self.traps.clone(),
			open_files: self.open_files.clone(),
			working_dir: self.working_dir.clone(),
			env: self.env.clone(),
			funcs: self.funcs.clone(),
			options: self.options.clone(),
			jobs: jobs::JobManager::new(),
			aliases: self.aliases.clone(),
			last_exit_status: self.last_exit_status,
			last_exit_status_change_count: self.last_exit_status_change_count,
			last_pipeline_statuses: self.last_pipeline_statuses.clone(),
			name: self.name.clone(),
			args: self.args.clone(),
			version: self.version.clone(),
			product_display_str: self.product_display_str.clone(),
			call_stack: {
				// Subshells must not inherit the parent's "currently handling signal X"
				// state; otherwise a trap handler that spawns a subshell would see itself
				// as already inside that handler and skip re-entrant delivery.
				let mut cs = self.call_stack.clone();
				cs.clear_active_trap_signals();
				cs
			},
			directory_stack: self.directory_stack.clone(),
			completion_config: self.completion_config.clone(),
			builtins: self.builtins.clone(),
			program_location_cache: self.program_location_cache.clone(),
			last_stopwatch_time: self.last_stopwatch_time,
			last_stopwatch_offset: self.last_stopwatch_offset,
			parser_impl: self.parser_impl,
			key_bindings: self.key_bindings.clone(),
			history: self.history.clone(),
			depth: self.depth + 1,
		}
	}
}

impl<SE: extensions::ShellExtensions> AsRef<Self> for Shell<SE> {
	fn as_ref(&self) -> &Self {
		self
	}
}

impl<SE: extensions::ShellExtensions> AsMut<Self> for Shell<SE> {
	fn as_mut(&mut self) -> &mut Self {
		self
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Returns a new shell instance created with the given options.
	/// Does *not* load any configuration files (e.g., bashrc).
	///
	/// # Arguments
	///
	/// * `options` - The options to use when creating the shell.
	pub(crate) fn new(options: CreateOptions<SE>) -> Result<Self, error::Error> {
		// Compute runtime options before moving fields out of `options`.
		let runtime_options = RuntimeOptions::defaults_from(&options);

		// Instantiate the shell with some defaults.
		let mut shell = Self {
			error_formatter: options.error_formatter,
			open_files: openfiles::OpenFiles::new(),
			options: runtime_options,
			name: options.shell_name,
			args: options.shell_args.unwrap_or_default(),
			version: options.shell_version,
			product_display_str: options.shell_product_display_str,
			working_dir: options.working_dir.map_or_else(std::env::current_dir, Ok)?,
			builtins: options.builtins,
			parser_impl: options.parser,
			key_bindings: options.key_bindings,
			..Self::default()
		};

		// Add in any open files provided.
		shell.open_files.update_from(options.fds.into_iter());

		// TODO(patterns): Without this a script that sets extglob will fail because we
		// parse the entire script with the same settings.
		shell.options.extended_globbing = true;

		// If requested, seed parameters from environment.
		if !options.do_not_inherit_env {
			wellknownvars::inherit_env_vars(&mut shell)?;
		}

		// If requested, set well-known variables.
		if !options.skip_well_known_vars {
			wellknownvars::init_well_known_vars(&mut shell)?;
		}

		// Set any provided variables.
		for (var_name, var_value) in options.vars {
			shell.env.set_global(var_name, var_value)?;
		}

		// Set up history, if relevant. Do NOT fail if we can't load history.
		if shell.options.enable_command_history {
			shell.history = shell
				.load_history()
				.unwrap_or_default()
				.or_else(|| Some(crate::history::History::default()));
		}

		Ok(shell)
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Increments the interactive line offset in the shell by the indicated
	/// number of lines.
	///
	/// # Arguments
	///
	/// * `delta` - The number of lines to increment the current line offset by.
	pub fn increment_interactive_line_offset(&mut self, delta: usize) {
		self.call_stack.increment_current_line_offset(delta);
	}

	/// Updates the currently executing command in the shell.
	pub fn set_current_cmd(&mut self, cmd: &impl brush_parser::ast::Node) {
		self
			.call_stack
			.set_current_pos(cmd.location().map(|span| span.start));
	}

	/// Updates the `$_` shell variable (last-argument of the previous simple
	/// command).
	///
	/// Passes `Some(last_arg)` to record the last argument of the just-executed
	/// command, or `None` to clear `$_` (used for assignment-only statements,
	/// which bash treats as having no "last argument").
	///
	/// The update is applied in-place so that attributes on `_` (notably
	/// `readonly`) are preserved: attempting to update a readonly `_` is a
	/// silent no-op, matching bash's observable stdout behavior.
	pub(crate) fn update_last_arg_variable(&mut self, last_arg: Option<String>) {
		// Bash refuses to update a readonly `_`, emitting an error to stderr
		// on each attempt. We silently skip the update here — the observable
		// stdout effect ($_ stays unchanged) matches bash; the missing stderr
		// diagnostics are harmless.
		if self
			.env
			.get_using_policy("_", crate::env::EnvironmentLookup::Anywhere)
			.is_some_and(|v| v.is_readonly())
		{
			return;
		}

		// Replace the variable entirely (fresh, non-exported). This matches
		// bash, which never exports `_` — even under `set -a` — and always
		// clears any previously-set attributes (except readonly, handled
		// above).
		let value = last_arg.unwrap_or_default();
		let _ = self
			.env
			.set_global("_", crate::variables::ShellVariable::new(value));
	}

	/// Applies errexit semantics to a result if enabled and appropriate.
	/// This should be called at "statement boundaries" where errexit should be
	/// checked.
	///
	/// # Arguments
	///
	/// * `result` - The execution result to potentially modify.
	pub const fn apply_errexit_if_enabled(&self, result: &mut ExecutionResult) {
		if self.options.exit_on_nonzero_command_exit
			&& !result.is_success()
			&& result.is_normal_flow()
		{
			result.next_control_flow = ExecutionControlFlow::ExitShell;
		}
	}

	/// Returns the keywords that are reserved by the shell.
	pub(crate) fn get_keywords(&self) -> Vec<&str> {
		if self.options.sh_mode {
			keywords::SH_MODE_KEYWORDS.iter().copied().collect()
		} else {
			keywords::KEYWORDS.iter().copied().collect()
		}
	}

	/// Checks if the given string is a keyword reserved in this shell.
	///
	/// # Arguments
	///
	/// * `s` - The string to check.
	pub fn is_keyword(&self, s: &str) -> bool {
		if self.options.sh_mode {
			keywords::SH_MODE_KEYWORDS.contains(s)
		} else {
			keywords::KEYWORDS.contains(s)
		}
	}

	pub(crate) const fn last_exit_status_change_count(&self) -> usize {
		self.last_exit_status_change_count
	}
}

#[inherent::inherent]
impl<SE: extensions::ShellExtensions> ShellState for Shell<SE> {
	/// Returns whether or not this shell is a subshell.
	pub fn is_subshell(&self) -> bool {
		self.depth > 0
	}

	/// Returns the last "SECONDS" captured time.
	pub fn last_stopwatch_time(&self) -> std::time::SystemTime {
		self.last_stopwatch_time
	}

	/// Returns the last "SECONDS" offset requested.
	pub fn last_stopwatch_offset(&self) -> u32 {
		self.last_stopwatch_offset
	}

	/// Returns the shell environment containing variables.
	pub fn env(&self) -> &ShellEnvironment {
		&self.env
	}

	/// Returns a mutable reference to the shell environment.
	pub fn env_mut(&mut self) -> &mut ShellEnvironment {
		&mut self.env
	}

	/// Returns the shell's runtime options.
	pub fn options(&self) -> &RuntimeOptions {
		&self.options
	}

	/// Returns a mutable reference to the shell's runtime options.
	pub fn options_mut(&mut self) -> &mut RuntimeOptions {
		&mut self.options
	}

	/// Returns the shell's aliases.
	pub fn aliases(&self) -> &HashMap<String, String> {
		&self.aliases
	}

	/// Returns a mutable reference to the shell's aliases.
	pub fn aliases_mut(&mut self) -> &mut HashMap<String, String> {
		&mut self.aliases
	}

	/// Returns the shell's job manager.
	pub fn jobs(&self) -> &jobs::JobManager {
		&self.jobs
	}

	/// Returns a mutable reference to the shell's job manager.
	pub fn jobs_mut(&mut self) -> &mut jobs::JobManager {
		&mut self.jobs
	}

	/// Returns the shell's trap handler configuration.
	pub fn traps(&self) -> &crate::traps::TrapHandlerConfig {
		&self.traps
	}

	/// Returns a mutable reference to the shell's trap handler configuration.
	pub fn traps_mut(&mut self) -> &mut crate::traps::TrapHandlerConfig {
		&mut self.traps
	}

	/// Returns the shell's directory stack.
	pub fn directory_stack(&self) -> &[PathBuf] {
		&self.directory_stack
	}

	/// Returns a mutable reference to the shell's directory stack.
	pub fn directory_stack_mut(&mut self) -> &mut Vec<PathBuf> {
		&mut self.directory_stack
	}

	/// Returns the statuses of commands in the last pipeline.
	pub fn last_pipeline_statuses(&self) -> &[u8] {
		&self.last_pipeline_statuses
	}

	/// Returns a mutable reference to the statuses of commands in the last
	/// pipeline.
	pub fn last_pipeline_statuses_mut(&mut self) -> &mut Vec<u8> {
		&mut self.last_pipeline_statuses
	}

	/// Returns the shell's program location cache.
	pub fn program_location_cache(&self) -> &pathcache::PathCache {
		&self.program_location_cache
	}

	/// Returns a mutable reference to the shell's program location cache.
	pub fn program_location_cache_mut(&mut self) -> &mut pathcache::PathCache {
		&mut self.program_location_cache
	}

	/// Returns the shell's completion configuration.
	pub fn completion_config(&self) -> &crate::completion::Config {
		&self.completion_config
	}

	/// Returns a mutable reference to the shell's completion configuration.
	pub fn completion_config_mut(&mut self) -> &mut crate::completion::Config {
		&mut self.completion_config
	}

	/// Returns the shell's open files.
	pub fn open_files(&self) -> &openfiles::OpenFiles {
		&self.open_files
	}

	/// Returns a mutable reference to the shell's open files.
	pub fn open_files_mut(&mut self) -> &mut openfiles::OpenFiles {
		&mut self.open_files
	}

	/// Returns the *current* name of the shell ($0).
	/// Influenced by the current call stack.
	pub fn current_shell_name(&self) -> Option<Cow<'_, str>> {
		for frame in self.call_stack.iter() {
			// Executed scripts shadow the shell name.
			if frame.frame_type.is_run_script() {
				return Some(frame.frame_type.name());
			}
		}

		self.name.as_deref().map(|name| name.into())
	}

	/// Returns the current subshell depth; 0 is returned if this shell is not a
	/// subshell.
	pub fn depth(&self) -> usize {
		self.depth
	}

	/// Returns the call stack for the shell.
	pub fn call_stack(&self) -> &crate::callstack::CallStack {
		&self.call_stack
	}

	/// Returns the shell's history, if it exists.
	pub fn history(&self) -> Option<&crate::history::History> {
		self.history.as_ref()
	}

	/// Returns a mutable reference to the shell's history, if it exists.
	pub fn history_mut(&mut self) -> Option<&mut crate::history::History> {
		self.history.as_mut()
	}

	/// Returns the shell's official version string (if available).
	pub fn version(&self) -> Option<&str> {
		self.version.as_deref()
	}

	/// Returns the exit status of the last command executed in this shell.
	pub fn last_exit_status(&self) -> u8 {
		self.last_exit_status
	}

	/// Updates the last exit status.
	pub fn set_last_exit_status(&mut self, status: u8) {
		self.last_exit_status = status;
		self.last_exit_status_change_count += 1;
	}

	/// Returns the key bindings helper for the shell.
	pub fn key_bindings(&self) -> Option<&KeyBindingsHelper> {
		self.key_bindings.as_ref()
	}

	/// Sets the key bindings helper for the shell.
	pub fn set_key_bindings(&mut self, key_bindings: Option<KeyBindingsHelper>) {
		self.key_bindings = key_bindings;
	}

	/// Returns the shell's current working directory.
	pub fn working_dir(&self) -> &Path {
		&self.working_dir
	}

	/// Returns a mutable reference to the shell's current working directory.
	/// This is only accessible within the crate.
	pub(crate) fn working_dir_mut(&mut self) -> &mut PathBuf {
		&mut self.working_dir
	}

	/// Returns the product display name for this shell.
	pub fn product_display_str(&self) -> Option<&str> {
		self.product_display_str.as_deref()
	}
}

#[cfg(feature = "serde")]
fn default_error_formatter<EF: extensions::ErrorFormatter>() -> EF {
	EF::default()
}
