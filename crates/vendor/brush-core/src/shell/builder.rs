//! Module defining the builder for creating shell instances.

use std::{collections::HashMap, path::PathBuf};

pub use shell_builder::State as ShellBuilderState;

use super::Shell;
use crate::{
	ProfileLoadBehavior, RcLoadBehavior, ShellFd, ShellVariable, builtins, callstack, completion,
	env, error, extensions, functions, jobs, openfiles, options, pathcache,
	shell::KeyBindingsHelper, traps,
};

impl<SE: extensions::ShellExtensions, S: shell_builder::IsComplete> ShellBuilder<SE, S> {
	/// Returns a new shell instance created with the options provided. Runs any
	/// configuration loading as well.
	pub async fn build(self) -> Result<Shell<SE>, error::Error> {
		let mut options = self.build_settings();

		let profile = std::mem::take(&mut options.profile);
		let rc = std::mem::take(&mut options.rc);

		// Construct the shell.
		let mut shell = Shell::new(options)?;

		// Load profiles/configuration, unless skipped.
		if !profile.skip() || !rc.skip() {
			shell.load_config(&profile, &rc).await?;
		}

		Ok(shell)
	}
}

impl<SE: extensions::ShellExtensions, S: shell_builder::State> ShellBuilder<SE, S> {
	/// Add a disabled option
	pub fn disable_option(mut self, option: impl Into<String>) -> Self {
		self.disabled_options.push(option.into());
		self
	}

	/// Add an enabled option
	pub fn enable_option(mut self, option: impl Into<String>) -> Self {
		self.enabled_options.push(option.into());
		self
	}

	/// Add many disabled options
	pub fn disable_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.disabled_options
			.extend(options.into_iter().map(Into::into));
		self
	}

	/// Add many enabled options
	pub fn enable_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.enabled_options
			.extend(options.into_iter().map(Into::into));
		self
	}

	/// Add a disabled shopt option
	pub fn disable_shopt_option(mut self, option: impl Into<String>) -> Self {
		self.disabled_shopt_options.push(option.into());
		self
	}

	/// Add an enabled shopt option
	pub fn enable_shopt_option(mut self, option: impl Into<String>) -> Self {
		self.enabled_shopt_options.push(option.into());
		self
	}

	/// Add many disabled shopt options
	pub fn disable_shopt_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.disabled_shopt_options
			.extend(options.into_iter().map(Into::into));
		self
	}

	/// Add many enabled shopt options
	pub fn enable_shopt_options(mut self, options: impl IntoIterator<Item: Into<String>>) -> Self {
		self
			.enabled_shopt_options
			.extend(options.into_iter().map(Into::into));
		self
	}

	/// Add a single builtin registration
	pub fn builtin(mut self, name: impl Into<String>, reg: builtins::Registration<SE>) -> Self {
		self.builtins.insert(name.into(), reg);
		self
	}

	/// Add many builtin registrations
	pub fn builtins(
		mut self,
		builtins: impl IntoIterator<Item = (String, builtins::Registration<SE>)>,
	) -> Self {
		self.builtins.extend(builtins);
		self
	}

	/// Adds a single variable to be initialized in the shell.
	pub fn var(mut self, name: impl Into<String>, variable: ShellVariable) -> Self {
		self.vars.insert(name.into(), variable);
		self
	}
}

/// Options for creating a new shell.
#[derive(Default, bon::Builder)]
#[builder(
    builder_type(
        name = ShellBuilder,
        doc {
        /// Builder for [Shell]
    }),
    finish_fn(
        name = build_settings,
        vis = "pub(self)",
    ),
    start_fn(
        vis = "pub(self)"
    )
)]
pub struct CreateOptions<SE: extensions::ShellExtensions = extensions::DefaultShellExtensions> {
	/// Disabled options.
	#[builder(field)]
	pub disabled_options: Vec<String>,
	/// Enabled options.
	#[builder(field)]
	pub enabled_options: Vec<String>,
	/// Disabled shopt options.
	#[builder(field)]
	pub disabled_shopt_options: Vec<String>,
	/// Enabled shopt options.
	#[builder(field)]
	pub enabled_shopt_options: Vec<String>,
	/// Registered builtins.
	#[builder(field)]
	pub builtins: HashMap<String, builtins::Registration<SE>>,
	/// Provides a set of variables to be initialized in the shell. If present,
	/// they are assigned *after* inherited or well-known variables are set
	/// (when applicable).
	#[builder(field)]
	pub vars: HashMap<String, ShellVariable>,
	/// Error behavior implementation.
	#[builder(default)]
	pub error_formatter: SE::ErrorFormatter,
	/// Disallow overwriting regular files via output redirection.
	#[builder(default)]
	pub disallow_overwriting_regular_files_via_output_redirection: bool,
	/// Do not execute commands.
	#[builder(default)]
	pub do_not_execute_commands: bool,
	/// Exit after one command.
	#[builder(default)]
	pub exit_after_one_command: bool,
	/// Whether the shell is interactive.
	#[builder(default)]
	pub interactive: bool,
	/// Whether the shell is a login shell.
	#[builder(default)]
	pub login: bool,
	/// Whether to skip using a readline-like interface for input.
	#[builder(default)]
	pub no_editing: bool,
	/// System profile loading behavior.
	#[builder(default)]
	pub profile: ProfileLoadBehavior,
	/// Rc file loading behavior.
	#[builder(default)]
	pub rc: RcLoadBehavior,
	/// Whether to skip inheriting environment variables from the calling
	/// process.
	#[builder(default)]
	pub do_not_inherit_env: bool,
	/// Whether to skip initializing well-known variables.
	#[builder(default)]
	pub skip_well_known_vars: bool,
	/// Provides a set of initial open files to be tracked by the shell.
	#[builder(default)]
	pub fds: HashMap<ShellFd, openfiles::OpenFile>,
	/// Whether to launch external commands as session leaders.
	#[builder(default)]
	pub external_cmd_leads_session: bool,
	/// Initial working dir for the shell. If left unspecified, will be populated
	/// from the host environment.
	pub working_dir: Option<PathBuf>,
	/// Whether the shell is in POSIX compliance mode.
	#[builder(default)]
	pub posix: bool,
	/// Whether to print commands and arguments as they are read.
	#[builder(default)]
	pub print_commands_and_arguments: bool,
	/// Whether commands are being read from stdin.
	#[builder(default)]
	pub read_commands_from_stdin: bool,
	/// The name of the shell.
	pub shell_name: Option<String>,
	/// Base positional arguments for the shell (not including the shell name).
	pub shell_args: Option<Vec<String>>,
	/// Optionally provides a display string describing the version and variant
	/// of the shell.
	pub shell_product_display_str: Option<String>,
	/// Whether to run in maximal POSIX sh compatibility mode.
	#[builder(default)]
	pub sh_mode: bool,
	/// Whether to treat expansion of unset variables as an error.
	#[builder(default)]
	pub treat_unset_variables_as_error: bool,
	/// Whether to enable error-on-exit behavior.
	#[builder(default)]
	pub exit_on_nonzero_command_exit: bool,
	/// Whether to disable pathname expansion.
	#[builder(default)]
	pub disable_pathname_expansion: bool,
	/// Whether to print verbose output.
	#[builder(default)]
	pub verbose: bool,
	/// Parser implementation to use.
	#[builder(default)]
	pub parser: crate::parser::ParserImpl,
	/// Whether the shell is in command string mode (-c).
	#[builder(default)]
	pub command_string_mode: bool,
	/// Maximum function call depth.
	pub max_function_call_depth: Option<usize>,
	/// Key bindings helper for the shell to use.
	pub key_bindings: Option<KeyBindingsHelper>,
	/// Brush implementation version.
	pub shell_version: Option<String>,
}

impl<SE: extensions::ShellExtensions> Default for Shell<SE> {
	fn default() -> Self {
		Self {
			error_formatter: SE::ErrorFormatter::default(),
			traps: traps::TrapHandlerConfig::default(),
			open_files: openfiles::OpenFiles::default(),
			working_dir: PathBuf::default(),
			env: env::ShellEnvironment::default(),
			funcs: functions::FunctionEnv::default(),
			options: options::RuntimeOptions::default(),
			jobs: jobs::JobManager::default(),
			aliases: HashMap::default(),
			last_exit_status: 0,
			last_exit_status_change_count: 0,
			last_pipeline_statuses: vec![0],
			depth: 0,
			name: None,
			args: vec![],
			version: None,
			product_display_str: None,
			call_stack: callstack::CallStack::new(),
			directory_stack: vec![],
			completion_config: completion::Config::default(),
			builtins: HashMap::default(),
			program_location_cache: pathcache::PathCache::default(),
			last_stopwatch_time: std::time::SystemTime::now(),
			last_stopwatch_offset: 0,
			parser_impl: crate::parser::ParserImpl::default(),
			key_bindings: None,
			history: None,
		}
	}
}

impl Shell {
	/// Create an instance of [Shell] using the builder syntax
	pub fn builder() -> ShellBuilder<extensions::DefaultShellExtensions, shell_builder::Empty> {
		CreateOptions::builder()
	}

	/// Create an instance of [Shell] using the builder syntax, with custom
	/// extensions.
	pub fn builder_with_extensions<SE: extensions::ShellExtensions>()
	-> ShellBuilder<SE, shell_builder::Empty> {
		CreateOptions::builder()
	}
}
