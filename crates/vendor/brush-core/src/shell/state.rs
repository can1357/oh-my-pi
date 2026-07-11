//! Defines state traits for the shell.

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
};

use crate::{
	completion, env::ShellEnvironment, jobs, openfiles, options::RuntimeOptions, pathcache,
	shell::KeyBindingsHelper,
};

/// A dyn-safe trait for constrained access to shell state.
pub trait ShellState {
	/// Returns whether or not this shell is a subshell.
	fn is_subshell(&self) -> bool;

	/// Returns the last "SECONDS" captured time.
	fn last_stopwatch_time(&self) -> std::time::SystemTime;

	/// Returns the last "SECONDS" offset requested.
	fn last_stopwatch_offset(&self) -> u32;

	/// Returns the shell environment containing variables.
	fn env(&self) -> &ShellEnvironment;

	/// Returns a mutable reference to the shell environment.
	fn env_mut(&mut self) -> &mut ShellEnvironment;

	/// Returns the shell's runtime options.
	fn options(&self) -> &RuntimeOptions;

	/// Returns a mutable reference to the shell's runtime options.
	fn options_mut(&mut self) -> &mut RuntimeOptions;

	/// Returns the shell's aliases.
	fn aliases(&self) -> &HashMap<String, String>;

	/// Returns a mutable reference to the shell's aliases.
	fn aliases_mut(&mut self) -> &mut HashMap<String, String>;

	/// Returns the shell's job manager.
	fn jobs(&self) -> &jobs::JobManager;

	/// Returns a mutable reference to the shell's job manager.
	fn jobs_mut(&mut self) -> &mut jobs::JobManager;

	/// Returns the shell's trap handler configuration.
	fn traps(&self) -> &crate::traps::TrapHandlerConfig;

	/// Returns a mutable reference to the shell's trap handler configuration.
	fn traps_mut(&mut self) -> &mut crate::traps::TrapHandlerConfig;

	/// Returns the shell's directory stack.
	fn directory_stack(&self) -> &[PathBuf];

	/// Returns a mutable reference to the shell's directory stack.
	fn directory_stack_mut(&mut self) -> &mut Vec<PathBuf>;

	/// Returns the statuses of commands in the last pipeline.
	fn last_pipeline_statuses(&self) -> &[u8];

	/// Returns a mutable reference to the statuses of commands in the last
	/// pipeline.
	fn last_pipeline_statuses_mut(&mut self) -> &mut Vec<u8>;

	/// Returns the shell's program location cache.
	fn program_location_cache(&self) -> &pathcache::PathCache;

	/// Returns a mutable reference to the shell's program location cache.
	fn program_location_cache_mut(&mut self) -> &mut pathcache::PathCache;

	/// Returns the shell's completion configuration.
	fn completion_config(&self) -> &completion::Config;

	/// Returns a mutable reference to the shell's completion configuration.
	fn completion_config_mut(&mut self) -> &mut completion::Config;

	/// Returns the shell's open files.
	fn open_files(&self) -> &openfiles::OpenFiles;

	/// Returns a mutable reference to the shell's open files.
	fn open_files_mut(&mut self) -> &mut openfiles::OpenFiles;

	/// Returns the *current* name of the shell ($0).
	fn current_shell_name(&self) -> Option<Cow<'_, str>>;

	/// Returns the current subshell depth; 0 is returned if this shell is not a
	/// subshell.
	fn depth(&self) -> usize;

	/// Returns the call stack for the shell.
	fn call_stack(&self) -> &crate::callstack::CallStack;

	/// Returns the shell's history, if it exists.
	fn history(&self) -> Option<&crate::history::History>;

	/// Returns a mutable reference to the shell's history, if it exists.
	fn history_mut(&mut self) -> Option<&mut crate::history::History>;

	/// Returns the shell's official version string (if available).
	fn version(&self) -> Option<&str>;

	/// Returns the exit status of the last command executed in this shell.
	fn last_exit_status(&self) -> u8;

	/// Updates the last exit status.
	fn set_last_exit_status(&mut self, status: u8);

	/// Returns the key bindings helper for the shell.
	fn key_bindings(&self) -> Option<&KeyBindingsHelper>;

	/// Sets the key bindings helper for the shell.
	fn set_key_bindings(&mut self, key_bindings: Option<KeyBindingsHelper>);

	/// Returns the shell's current working directory.
	fn working_dir(&self) -> &Path;

	/// Returns a mutable reference to the shell's current working directory.
	/// This is only accessible within the crate.
	fn working_dir_mut(&mut self) -> &mut PathBuf;

	/// Returns the product display name for this shell.
	fn product_display_str(&self) -> Option<&str>;
}
