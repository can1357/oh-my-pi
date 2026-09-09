//! Module defining the core shell structure and behavior.

use std::{
	borrow::Cow,
	env::current_dir,
	path::{Path, PathBuf},
	sync::Arc,
};

use im::HashMap;
use tokio::sync::Mutex;

use crate::{
	ExecutionControlFlow, ExecutionResult, builtins, env::ShellEnvironment, error, extensions,
	functions, jobs, keywords, openfiles, options::RuntimeOptions, pathcache, wellknownvars,
};

/// Shared key-binding backend used by interactive shell hosts.
pub type KeyBindingsHelper = Arc<Mutex<dyn crate::interfaces::KeyBindings>>;

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
mod parsing;
mod prompts;
mod state;
mod traps;

use std::time;

pub use builder::{CreateOptions, ShellBuilder, ShellBuilderState};
pub use initscripts::{ProfileLoadBehavior, RcLoadBehavior};
pub use state::ShellState;

use crate::{
	callstack::CallStack,
	env::EnvironmentLookup,
	parser::{ParserImpl, ast::Node},
	traps::TrapHandlerConfig,
	variables::ShellVariable,
};

/// Represents an instance of a shell.
///
/// # Type Parameters
///
/// * `SE` - The shell extensions implementation to use. These extensions are
///   statically injected into the shell at compile time to provide custom
///   behavior. When unspecified, defaults to `DefaultShellExtensions`, which
///   provide standard behavior.
pub struct Shell<SE: extensions::ShellExtensions = extensions::DefaultShellExtensions> {
	/// Injected error behavior.
	error_formatter: SE::ErrorFormatter,

	/// Trap handler configuration for the shell.
	traps: TrapHandlerConfig,

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
	call_stack: CallStack,

	/// Directory stack used by pushd et al.
	directory_stack: Vec<PathBuf>,

	/// Programmable completion configuration.
	completion_config: crate::completion::Config,

	/// Shell built-in commands.
	builtins: HashMap<String, builtins::Registration<SE>>,

	/// Shell program location cache.
	program_location_cache: pathcache::PathCache,

	/// Last "SECONDS" captured time.
	last_stopwatch_time: time::SystemTime,

	/// Last "SECONDS" offset requested.
	last_stopwatch_offset: u32,

	/// Parser implementation to use.
	parser_impl:  ParserImpl,
	/// Interactive input key bindings, when supplied by the host.
	key_bindings: Option<KeyBindingsHelper>,

	/// Command history, when history is enabled.
	history:       Option<crate::history::History>,
	/// Shell-local umask used when host-process protection is active.
	virtual_umask: u32,

	/// Shell-local resource limits keyed by the `ulimit` option letter.
	virtual_resource_limits: Vec<(char, u64, u64)>,
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
			virtual_umask: self.virtual_umask,
			virtual_resource_limits: self.virtual_resource_limits.clone(),
			depth: self.depth + 1,
		}
	}
}

impl<SE: extensions::ShellExtensions> Drop for Shell<SE> {
	fn drop(&mut self) {
		self.jobs.abort_internal_tasks();
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

		// Instantiate the shell with defaults, then replace configured fields.
		// Field update syntax cannot move from a type that owns a Drop implementation.
		let mut shell = Self::default();
		shell.error_formatter = options.error_formatter;
		shell.open_files = openfiles::OpenFiles::new();
		shell.options = runtime_options;
		shell.name = options.shell_name;
		shell.args = options.shell_args.unwrap_or_default();
		shell.version = options.shell_version;
		shell.product_display_str = options.shell_product_display_str;
		shell.working_dir = options.working_dir.map_or_else(current_dir, Ok)?;
		shell.builtins = options.builtins;
		shell.parser_impl = options.parser;
		shell.key_bindings = options.key_bindings;

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
	pub fn set_current_cmd(&mut self, cmd: &impl Node) {
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
			.get_using_policy("_", EnvironmentLookup::Anywhere)
			.is_some_and(|v| v.is_readonly())
		{
			return;
		}

		// Replace the variable entirely (fresh, non-exported). This matches
		// bash, which never exports `_` — even under `set -a` — and always
		// clears any previously-set attributes (except readonly, handled
		// above).
		let value = last_arg.unwrap_or_default();
		let _ = self.env.set_global("_", ShellVariable::new(value));
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

	/// Returns the keywords reserved by the current shell mode.
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

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Returns whether or not this shell is a subshell.
	pub fn is_subshell(&self) -> bool {
		self.depth > 0
	}

	pub(crate) const fn virtual_umask(&self) -> u32 {
		self.virtual_umask
	}

	pub(crate) const fn set_virtual_umask(&mut self, mask: u32) {
		self.virtual_umask = mask;
	}

	pub(crate) fn virtual_resource_limit(&self, key: char) -> Option<(u64, u64)> {
		self
			.virtual_resource_limits
			.iter()
			.find_map(|(candidate, soft, hard)| (*candidate == key).then_some((*soft, *hard)))
	}

	pub(crate) fn set_virtual_resource_limit(&mut self, key: char, soft: u64, hard: u64) {
		if let Some((_, current_soft, current_hard)) = self
			.virtual_resource_limits
			.iter_mut()
			.find(|(candidate, ..)| *candidate == key)
		{
			*current_soft = soft;
			*current_hard = hard;
		} else {
			self.virtual_resource_limits.push((key, soft, hard));
		}
	}

	/// Returns the last "SECONDS" captured time.
	pub fn last_stopwatch_time(&self) -> time::SystemTime {
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
	pub fn traps(&self) -> &TrapHandlerConfig {
		&self.traps
	}

	/// Returns a mutable reference to the shell's trap handler configuration.
	pub fn traps_mut(&mut self) -> &mut TrapHandlerConfig {
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

	/// Returns the programmable completion configuration.
	pub fn completion_config(&self) -> &crate::completion::Config {
		&self.completion_config
	}

	/// Returns the mutable programmable completion configuration.
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
	pub fn call_stack(&self) -> &CallStack {
		&self.call_stack
	}

	/// Returns command history when it is enabled.
	pub fn history(&self) -> Option<&crate::history::History> {
		self.history.as_ref()
	}

	/// Returns mutable command history when it is enabled.
	pub fn history_mut(&mut self) -> Option<&mut crate::history::History> {
		self.history.as_mut()
	}

	/// Returns the interactive key-binding backend when configured.
	pub fn key_bindings(&self) -> Option<&KeyBindingsHelper> {
		self.key_bindings.as_ref()
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

impl<SE: extensions::ShellExtensions> ShellState for Shell<SE> {
	fn is_subshell(&self) -> bool {
		Shell::is_subshell(self)
	}

	fn last_stopwatch_time(&self) -> time::SystemTime {
		Shell::last_stopwatch_time(self)
	}

	fn last_stopwatch_offset(&self) -> u32 {
		Shell::last_stopwatch_offset(self)
	}

	fn env(&self) -> &ShellEnvironment {
		Shell::env(self)
	}

	fn env_mut(&mut self) -> &mut ShellEnvironment {
		Shell::env_mut(self)
	}

	fn options(&self) -> &RuntimeOptions {
		Shell::options(self)
	}

	fn options_mut(&mut self) -> &mut RuntimeOptions {
		Shell::options_mut(self)
	}

	fn aliases(&self) -> &HashMap<String, String> {
		Shell::aliases(self)
	}

	fn aliases_mut(&mut self) -> &mut HashMap<String, String> {
		Shell::aliases_mut(self)
	}

	fn jobs(&self) -> &jobs::JobManager {
		Shell::jobs(self)
	}

	fn jobs_mut(&mut self) -> &mut jobs::JobManager {
		Shell::jobs_mut(self)
	}

	fn traps(&self) -> &TrapHandlerConfig {
		Shell::traps(self)
	}

	fn traps_mut(&mut self) -> &mut TrapHandlerConfig {
		Shell::traps_mut(self)
	}

	fn directory_stack(&self) -> &[PathBuf] {
		Shell::directory_stack(self)
	}

	fn directory_stack_mut(&mut self) -> &mut Vec<PathBuf> {
		Shell::directory_stack_mut(self)
	}

	fn last_pipeline_statuses(&self) -> &[u8] {
		Shell::last_pipeline_statuses(self)
	}

	fn last_pipeline_statuses_mut(&mut self) -> &mut Vec<u8> {
		Shell::last_pipeline_statuses_mut(self)
	}

	fn program_location_cache(&self) -> &pathcache::PathCache {
		Shell::program_location_cache(self)
	}

	fn program_location_cache_mut(&mut self) -> &mut pathcache::PathCache {
		Shell::program_location_cache_mut(self)
	}

	fn open_files(&self) -> &openfiles::OpenFiles {
		Shell::open_files(self)
	}

	fn open_files_mut(&mut self) -> &mut openfiles::OpenFiles {
		Shell::open_files_mut(self)
	}

	fn current_shell_name(&self) -> Option<Cow<'_, str>> {
		Shell::current_shell_name(self)
	}

	fn depth(&self) -> usize {
		Shell::depth(self)
	}

	fn call_stack(&self) -> &CallStack {
		Shell::call_stack(self)
	}

	fn version(&self) -> Option<&str> {
		Shell::version(self)
	}

	fn last_exit_status(&self) -> u8 {
		Shell::last_exit_status(self)
	}

	fn set_last_exit_status(&mut self, status: u8) {
		Shell::set_last_exit_status(self, status);
	}

	fn working_dir(&self) -> &Path {
		Shell::working_dir(self)
	}

	fn working_dir_mut(&mut self) -> &mut PathBuf {
		Shell::working_dir_mut(self)
	}

	fn product_display_str(&self) -> Option<&str> {
		Shell::product_display_str(self)
	}
}
#[cfg(test)]
mod lifecycle_tests {
	use std::{
		future,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		time::Duration,
	};

	use super::Shell;
	use crate::{
		ExecutionResult, SourceInfo,
		builtins::default_builtins,
		jobs::{Job, JobState, JobTask},
	};

	struct MarksDrop(Arc<AtomicBool>);

	impl Drop for MarksDrop {
		fn drop(&mut self) {
			self.0.store(true, Ordering::SeqCst);
		}
	}

	fn shell_with_pending_job(dropped: Arc<AtomicBool>) -> Shell {
		let mut shell = Shell::default();
		let handle = tokio::spawn(async move {
			let _guard = MarksDrop(dropped);
			future::pending::<()>().await;
			Ok(ExecutionResult::success())
		});
		shell.jobs.add_as_current(Job::new(
			[JobTask::Internal(handle)],
			"pending".into(),
			JobState::Running,
		));
		shell
	}

	#[tokio::test(flavor = "current_thread")]
	async fn dropping_shell_aborts_internal_jobs() {
		let dropped = Arc::new(AtomicBool::new(false));
		let shell = shell_with_pending_job(Arc::clone(&dropped));
		tokio::task::yield_now().await;
		drop(shell);
		tokio::task::yield_now().await;
		assert!(dropped.load(Ordering::SeqCst));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn explicit_exit_aborts_internal_jobs() {
		let dropped = Arc::new(AtomicBool::new(false));
		let mut shell = shell_with_pending_job(Arc::clone(&dropped));
		tokio::task::yield_now().await;
		shell.on_exit().await.unwrap();
		tokio::task::yield_now().await;
		assert!(dropped.load(Ordering::SeqCst));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn builtin_pipeline_does_not_block_current_thread_runtime() {
		let mut shell: Shell<crate::extensions::DefaultShellExtensions> = Shell::default();
		shell.builtins = default_builtins();
		let input = format!("printf %s {} | mapfile values", "x".repeat(256 * 1024));
		let params = shell.default_exec_params();
		let result = tokio::time::timeout(
			Duration::from_secs(5),
			shell.run_string(input, &SourceInfo::from("(pipeline test)"), &params),
		)
		.await
		.expect("builtin pipeline must not deadlock")
		.unwrap();
		assert!(result.is_success());
	}
}
