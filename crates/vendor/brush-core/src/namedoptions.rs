//! Defines shell options.

use std::{collections::HashMap, sync::LazyLock};

use crate::options::RuntimeOptions;

type OptionGetter = fn(shell: &RuntimeOptions) -> bool;
type OptionSetter = fn(shell: &mut RuntimeOptions, value: bool) -> ();

/// Defines an option.
pub struct ShellOptionDef {
	/// Getter function that retrieves the current value of the option.
	getter: OptionGetter,
	/// Setter function that may be used to set the current value of the option.
	setter: OptionSetter,
}

impl ShellOptionDef {
	/// Constructs a new option definition.
	///
	/// # Arguments
	///
	/// * `getter` - A function that retrieves the current value of the option.
	/// * `setter` - A function that sets the current value of the option.
	fn new(getter: OptionGetter, setter: OptionSetter) -> Self {
		Self { getter, setter }
	}

	/// Retrieves the current value of this option from the given runtime
	/// options.
	///
	/// # Arguments
	///
	/// * `options` - The runtime options to retrieve the value from.
	pub fn get(&self, options: &RuntimeOptions) -> bool {
		(self.getter)(options)
	}

	/// Sets the value of this option in the given runtime options.
	///
	/// # Arguments
	///
	/// * `options` - The runtime options to modify.
	/// * `value` - The new value to set for the option.
	pub fn set(&self, options: &mut RuntimeOptions, value: bool) {
		(self.setter)(options, value);
	}
}

/// Describes a shell option.
pub struct ShellOption {
	/// The name of the option.
	pub name:       &'static str,
	/// The definition of the option.
	pub definition: &'static ShellOptionDef,
}

/// Describes a set of shell options.
pub struct ShellOptionSet {
	inner: &'static HashMap<&'static str, ShellOptionDef>,
}

/// Kind of shell option.
#[derive(Clone, Copy)]
pub enum ShellOptionKind {
	/// `set` option.
	Set,
	/// `set -o` option.
	SetO,
	/// `shopt` option.
	Shopt,
}

/// Returns the options for the given shell option kind.
///
/// # Arguments
///
/// * `kind` - The kind of shell options to retrieve.
pub fn options(kind: ShellOptionKind) -> ShellOptionSet {
	match kind {
		ShellOptionKind::Set => ShellOptionSet { inner: &SET_OPTIONS },
		ShellOptionKind::SetO => ShellOptionSet { inner: &SET_O_OPTIONS },
		ShellOptionKind::Shopt => ShellOptionSet { inner: &SHOPT_OPTIONS },
	}
}

impl ShellOptionSet {
	/// Returns an iterator over the options defined in this set.
	pub fn iter(&self) -> impl Iterator<Item = ShellOption> {
		self
			.inner
			.iter()
			.map(|(&name, definition)| ShellOption { name, definition })
	}

	/// Returns the option with the given name, if it exists.
	///
	/// # Arguments
	///
	/// * `name` - The name of the option to retrieve.
	pub fn get(&self, name: &str) -> Option<&'static ShellOptionDef> {
		self.inner.get(name)
	}
}

static SET_OPTIONS: LazyLock<HashMap<&'static str, ShellOptionDef>> = LazyLock::new(|| {
	HashMap::from([
		(
			"a",
			ShellOptionDef::new(
				|options| options.export_variables_on_modification,
				|options, value| options.export_variables_on_modification = value,
			),
		),
		(
			"b",
			ShellOptionDef::new(
				|options| options.notify_job_termination_immediately,
				|options, value| options.notify_job_termination_immediately = value,
			),
		),
		(
			"c",
			ShellOptionDef::new(
				|options| options.command_string_mode,
				|options, value| options.command_string_mode = value,
			),
		),
		(
			"e",
			ShellOptionDef::new(
				|options| options.exit_on_nonzero_command_exit,
				|options, value| options.exit_on_nonzero_command_exit = value,
			),
		),
		(
			"f",
			ShellOptionDef::new(
				|options| options.disable_filename_globbing,
				|options, value| options.disable_filename_globbing = value,
			),
		),
		(
			"h",
			ShellOptionDef::new(
				|options| options.remember_command_locations,
				|options, value| options.remember_command_locations = value,
			),
		),
		(
			"i",
			ShellOptionDef::new(
				|options| options.interactive,
				|options, value| options.interactive = value,
			),
		),
		(
			"k",
			ShellOptionDef::new(
				|options| options.place_all_assignment_args_in_command_env,
				|options, value| options.place_all_assignment_args_in_command_env = value,
			),
		),
		(
			"m",
			ShellOptionDef::new(
				|options| options.enable_job_control,
				|options, value| options.enable_job_control = value,
			),
		),
		(
			"n",
			ShellOptionDef::new(
				|options| options.do_not_execute_commands,
				|options, value| options.do_not_execute_commands = value,
			),
		),
		(
			"p",
			ShellOptionDef::new(
				|options| options.real_effective_uid_mismatch,
				|options, value| options.real_effective_uid_mismatch = value,
			),
		),
		(
			"t",
			ShellOptionDef::new(
				|options| options.exit_after_one_command,
				|options, value| options.exit_after_one_command = value,
			),
		),
		(
			"u",
			ShellOptionDef::new(
				|options| options.treat_unset_variables_as_error,
				|options, value| options.treat_unset_variables_as_error = value,
			),
		),
		(
			"v",
			ShellOptionDef::new(
				|options| options.print_shell_input_lines,
				|options, value| options.print_shell_input_lines = value,
			),
		),
		(
			"x",
			ShellOptionDef::new(
				|options| options.print_commands_and_arguments,
				|options, value| options.print_commands_and_arguments = value,
			),
		),
		(
			"B",
			ShellOptionDef::new(
				|options| options.perform_brace_expansion,
				|options, value| options.perform_brace_expansion = value,
			),
		),
		(
			"C",
			ShellOptionDef::new(
				|options| options.disallow_overwriting_regular_files_via_output_redirection,
				|options, value| {
					options.disallow_overwriting_regular_files_via_output_redirection = value;
				},
			),
		),
		(
			"E",
			ShellOptionDef::new(
				|options| options.shell_functions_inherit_err_trap,
				|options, value| options.shell_functions_inherit_err_trap = value,
			),
		),
		(
			"H",
			ShellOptionDef::new(
				|options| options.enable_bang_style_history_substitution,
				|options, value| options.enable_bang_style_history_substitution = value,
			),
		),
		(
			"P",
			ShellOptionDef::new(
				|options| options.do_not_resolve_symlinks_when_changing_dir,
				|options, value| options.do_not_resolve_symlinks_when_changing_dir = value,
			),
		),
		(
			"T",
			ShellOptionDef::new(
				|options| options.shell_functions_inherit_debug_and_return_traps,
				|options, value| options.shell_functions_inherit_debug_and_return_traps = value,
			),
		),
		(
			"s",
			ShellOptionDef::new(
				|options| options.read_commands_from_stdin,
				|options, value| options.read_commands_from_stdin = value,
			),
		),
	])
});

static SET_O_OPTIONS: LazyLock<HashMap<&'static str, ShellOptionDef>> = LazyLock::new(|| {
	HashMap::from([
		(
			"allexport",
			ShellOptionDef::new(
				|options| options.export_variables_on_modification,
				|options, value| options.export_variables_on_modification = value,
			),
		),
		(
			"braceexpand",
			ShellOptionDef::new(
				|options| options.perform_brace_expansion,
				|options, value| options.perform_brace_expansion = value,
			),
		),
		(
			"emacs",
			ShellOptionDef::new(
				|options| options.emacs_mode,
				|options, value| options.emacs_mode = value,
			),
		),
		(
			"errexit",
			ShellOptionDef::new(
				|options| options.exit_on_nonzero_command_exit,
				|options, value| options.exit_on_nonzero_command_exit = value,
			),
		),
		(
			"errtrace",
			ShellOptionDef::new(
				|options| options.shell_functions_inherit_err_trap,
				|options, value| options.shell_functions_inherit_err_trap = value,
			),
		),
		(
			"functrace",
			ShellOptionDef::new(
				|options| options.shell_functions_inherit_debug_and_return_traps,
				|options, value| options.shell_functions_inherit_debug_and_return_traps = value,
			),
		),
		(
			"hashall",
			ShellOptionDef::new(
				|options| options.remember_command_locations,
				|options, value| options.remember_command_locations = value,
			),
		),
		(
			"histexpand",
			ShellOptionDef::new(
				|options| options.enable_bang_style_history_substitution,
				|options, value| options.enable_bang_style_history_substitution = value,
			),
		),
		(
			"history",
			ShellOptionDef::new(
				|options| options.enable_command_history,
				|options, value| options.enable_command_history = value,
			),
		),
		(
			"ignoreeof",
			ShellOptionDef::new(
				|options| options.ignore_eof,
				|options, value| options.ignore_eof = value,
			),
		),
		(
			"interactive-comments",
			ShellOptionDef::new(
				|options| options.interactive_comments,
				|options, value| options.interactive_comments = value,
			),
		),
		(
			"keyword",
			ShellOptionDef::new(
				|options| options.place_all_assignment_args_in_command_env,
				|options, value| options.place_all_assignment_args_in_command_env = value,
			),
		),
		(
			"monitor",
			ShellOptionDef::new(
				|options| options.enable_job_control,
				|options, value| options.enable_job_control = value,
			),
		),
		(
			"noclobber",
			ShellOptionDef::new(
				|options| options.disallow_overwriting_regular_files_via_output_redirection,
				|options, value| {
					options.disallow_overwriting_regular_files_via_output_redirection = value;
				},
			),
		),
		(
			"noexec",
			ShellOptionDef::new(
				|options| options.do_not_execute_commands,
				|options, value| options.do_not_execute_commands = value,
			),
		),
		(
			"noglob",
			ShellOptionDef::new(
				|options| options.disable_filename_globbing,
				|options, value| options.disable_filename_globbing = value,
			),
		),
		("nolog", ShellOptionDef::new(|_| false, |_, _| ())),
		(
			"notify",
			ShellOptionDef::new(
				|options| options.notify_job_termination_immediately,
				|options, value| options.notify_job_termination_immediately = value,
			),
		),
		(
			"nounset",
			ShellOptionDef::new(
				|options| options.treat_unset_variables_as_error,
				|options, value| options.treat_unset_variables_as_error = value,
			),
		),
		(
			"onecmd",
			ShellOptionDef::new(
				|options| options.exit_after_one_command,
				|options, value| options.exit_after_one_command = value,
			),
		),
		(
			"physical",
			ShellOptionDef::new(
				|options| options.do_not_resolve_symlinks_when_changing_dir,
				|options, value| options.do_not_resolve_symlinks_when_changing_dir = value,
			),
		),
		(
			"pipefail",
			ShellOptionDef::new(
				|options| options.return_last_failure_from_pipeline,
				|options, value| options.return_last_failure_from_pipeline = value,
			),
		),
		(
			"posix",
			ShellOptionDef::new(
				|options| options.posix_mode,
				|options, value| options.posix_mode = value,
			),
		),
		(
			"privileged",
			ShellOptionDef::new(
				|options| options.real_effective_uid_mismatch,
				|options, value| options.real_effective_uid_mismatch = value,
			),
		),
		(
			"verbose",
			ShellOptionDef::new(
				|options| options.print_shell_input_lines,
				|options, value| options.print_shell_input_lines = value,
			),
		),
		(
			"vi",
			ShellOptionDef::new(|options| options.vi_mode, |options, value| options.vi_mode = value),
		),
		(
			"xtrace",
			ShellOptionDef::new(
				|options| options.print_commands_and_arguments,
				|options, value| options.print_commands_and_arguments = value,
			),
		),
	])
});

static SHOPT_OPTIONS: LazyLock<HashMap<&'static str, ShellOptionDef>> = LazyLock::new(|| {
	HashMap::from([
		(
			"autocd",
			ShellOptionDef::new(|options| options.auto_cd, |options, value| options.auto_cd = value),
		),
		(
			"array_expand_once",
			ShellOptionDef::new(
				|options| options.array_expand_once,
				|options, value| options.array_expand_once = value,
			),
		),
		(
			"assoc_expand_once",
			ShellOptionDef::new(
				|options| options.assoc_expand_once,
				|options, value| options.assoc_expand_once = value,
			),
		),
		(
			"bash_source_fullpath",
			ShellOptionDef::new(
				|options| options.bash_source_full_path,
				|options, value| options.bash_source_full_path = value,
			),
		),
		(
			"cdable_vars",
			ShellOptionDef::new(
				|options| options.cdable_vars,
				|options, value| options.cdable_vars = value,
			),
		),
		(
			"cdspell",
			ShellOptionDef::new(
				|options| options.cd_autocorrect_spelling,
				|options, value| options.cd_autocorrect_spelling = value,
			),
		),
		(
			"checkhash",
			ShellOptionDef::new(
				|options| options.check_hashtable_before_command_exec,
				|options, value| options.check_hashtable_before_command_exec = value,
			),
		),
		(
			"checkjobs",
			ShellOptionDef::new(
				|options| options.check_jobs_before_exit,
				|options, value| options.check_jobs_before_exit = value,
			),
		),
		(
			"checkwinsize",
			ShellOptionDef::new(
				|options| options.check_window_size_after_external_commands,
				|options, value| options.check_window_size_after_external_commands = value,
			),
		),
		(
			"cmdhist",
			ShellOptionDef::new(
				|options| options.save_multiline_cmds_in_history,
				|options, value| options.save_multiline_cmds_in_history = value,
			),
		),
		(
			"compat31",
			ShellOptionDef::new(|options| options.compat31, |options, value| options.compat31 = value),
		),
		(
			"compat32",
			ShellOptionDef::new(|options| options.compat32, |options, value| options.compat32 = value),
		),
		(
			"compat40",
			ShellOptionDef::new(|options| options.compat40, |options, value| options.compat40 = value),
		),
		(
			"compat41",
			ShellOptionDef::new(|options| options.compat41, |options, value| options.compat41 = value),
		),
		(
			"compat42",
			ShellOptionDef::new(|options| options.compat42, |options, value| options.compat42 = value),
		),
		(
			"compat43",
			ShellOptionDef::new(|options| options.compat43, |options, value| options.compat43 = value),
		),
		(
			"compat44",
			ShellOptionDef::new(|options| options.compat44, |options, value| options.compat44 = value),
		),
		(
			"complete_fullquote",
			ShellOptionDef::new(
				|options| options.quote_all_metachars_in_completion,
				|options, value| options.quote_all_metachars_in_completion = value,
			),
		),
		(
			"direxpand",
			ShellOptionDef::new(
				|options| options.expand_dir_names_on_completion,
				|options, value| options.expand_dir_names_on_completion = value,
			),
		),
		(
			"dirspell",
			ShellOptionDef::new(
				|options| options.autocorrect_dir_spelling_on_completion,
				|options, value| options.autocorrect_dir_spelling_on_completion = value,
			),
		),
		(
			"dotglob",
			ShellOptionDef::new(
				|options| options.glob_matches_dotfiles,
				|options, value| options.glob_matches_dotfiles = value,
			),
		),
		(
			"execfail",
			ShellOptionDef::new(
				|options| options.exit_on_exec_fail,
				|options, value| options.exit_on_exec_fail = value,
			),
		),
		(
			"expand_aliases",
			ShellOptionDef::new(
				|options| options.expand_aliases,
				|options, value| options.expand_aliases = value,
			),
		),
		(
			"extdebug",
			ShellOptionDef::new(
				|options| options.enable_debugger,
				|options, value| options.enable_debugger = value,
			),
		),
		(
			"extglob",
			ShellOptionDef::new(
				|options| options.extended_globbing,
				|options, value| options.extended_globbing = value,
			),
		),
		(
			"extquote",
			ShellOptionDef::new(|options| options.extquote, |options, value| options.extquote = value),
		),
		(
			"failglob",
			ShellOptionDef::new(
				|options| options.fail_expansion_on_globs_without_match,
				|options, value| options.fail_expansion_on_globs_without_match = value,
			),
		),
		(
			"force_fignore",
			ShellOptionDef::new(
				|options| options.force_fignore,
				|options, value| options.force_fignore = value,
			),
		),
		(
			"globasciiranges",
			ShellOptionDef::new(
				|options| options.glob_ranges_use_c_locale,
				|options, value| options.glob_ranges_use_c_locale = value,
			),
		),
		(
			"globskipdots",
			ShellOptionDef::new(
				|options| options.glob_skip_dots,
				|options, value| options.glob_skip_dots = value,
			),
		),
		(
			"globstar",
			ShellOptionDef::new(
				|options| options.enable_star_star_glob,
				|options, value| options.enable_star_star_glob = value,
			),
		),
		(
			"gnu_errfmt",
			ShellOptionDef::new(
				|options| options.errors_in_gnu_format,
				|options, value| options.errors_in_gnu_format = value,
			),
		),
		(
			"histappend",
			ShellOptionDef::new(
				|options| options.append_to_history_file,
				|options, value| options.append_to_history_file = value,
			),
		),
		(
			"histreedit",
			ShellOptionDef::new(
				|options| options.allow_reedit_failed_history_subst,
				|options, value| options.allow_reedit_failed_history_subst = value,
			),
		),
		(
			"histverify",
			ShellOptionDef::new(
				|options| options.allow_modifying_history_substitution,
				|options, value| options.allow_modifying_history_substitution = value,
			),
		),
		(
			"hostcomplete",
			ShellOptionDef::new(
				|options| options.enable_hostname_completion,
				|options, value| options.enable_hostname_completion = value,
			),
		),
		(
			"huponexit",
			ShellOptionDef::new(
				|options| options.send_sighup_to_all_jobs_on_exit,
				|options, value| options.send_sighup_to_all_jobs_on_exit = value,
			),
		),
		(
			"inherit_errexit",
			ShellOptionDef::new(
				|options| options.command_subst_inherits_errexit,
				|options, value| options.command_subst_inherits_errexit = value,
			),
		),
		(
			"interactive_comments",
			ShellOptionDef::new(
				|options| options.interactive_comments,
				|options, value| options.interactive_comments = value,
			),
		),
		(
			"lastpipe",
			ShellOptionDef::new(
				|options| options.run_last_pipeline_cmd_in_current_shell,
				|options, value| options.run_last_pipeline_cmd_in_current_shell = value,
			),
		),
		(
			"lithist",
			ShellOptionDef::new(
				|options| options.embed_newlines_in_multiline_cmds_in_history,
				|options, value| options.embed_newlines_in_multiline_cmds_in_history = value,
			),
		),
		(
			"localvar_inherit",
			ShellOptionDef::new(
				|options| options.local_vars_inherit_value_and_attrs,
				|options, value| options.local_vars_inherit_value_and_attrs = value,
			),
		),
		(
			"localvar_unset",
			ShellOptionDef::new(
				|options| options.localvar_unset,
				|options, value| options.localvar_unset = value,
			),
		),
		(
			"login_shell",
			ShellOptionDef::new(
				|options| options.login_shell,
				|options, value| options.login_shell = value,
			),
		),
		(
			"mailwarn",
			ShellOptionDef::new(
				|options| options.mail_warn,
				|options, value| options.mail_warn = value,
			),
		),
		(
			"no_empty_cmd_completion",
			ShellOptionDef::new(
				|options| options.no_empty_cmd_completion,
				|options, value| options.no_empty_cmd_completion = value,
			),
		),
		(
			"nocaseglob",
			ShellOptionDef::new(
				|options| options.case_insensitive_pathname_expansion,
				|options, value| options.case_insensitive_pathname_expansion = value,
			),
		),
		(
			"nocasematch",
			ShellOptionDef::new(
				|options| options.case_insensitive_conditionals,
				|options, value| options.case_insensitive_conditionals = value,
			),
		),
		(
			"noexpand_translation",
			ShellOptionDef::new(
				|options| options.no_expand_translation,
				|options, value| options.no_expand_translation = value,
			),
		),
		(
			"nullglob",
			ShellOptionDef::new(
				|options| options.expand_non_matching_patterns_to_null,
				|options, value| options.expand_non_matching_patterns_to_null = value,
			),
		),
		(
			"patsub_replacement",
			ShellOptionDef::new(
				|options| options.patsub_replacement,
				|options, value| options.patsub_replacement = value,
			),
		),
		(
			"progcomp",
			ShellOptionDef::new(
				|options| options.programmable_completion,
				|options, value| options.programmable_completion = value,
			),
		),
		(
			"progcomp_alias",
			ShellOptionDef::new(
				|options| options.programmable_completion_alias,
				|options, value| options.programmable_completion_alias = value,
			),
		),
		(
			"promptvars",
			ShellOptionDef::new(
				|options| options.expand_prompt_strings,
				|options, value| options.expand_prompt_strings = value,
			),
		),
		(
			"restricted_shell",
			ShellOptionDef::new(
				|options| options.restricted_shell,
				|options, value| options.restricted_shell = value,
			),
		),
		(
			"shift_verbose",
			ShellOptionDef::new(
				|options| options.shift_verbose,
				|options, value| options.shift_verbose = value,
			),
		),
		(
			"sourcepath",
			ShellOptionDef::new(
				|options| options.source_builtin_searches_path,
				|options, value| options.source_builtin_searches_path = value,
			),
		),
		(
			"varredir_close",
			ShellOptionDef::new(
				|options| options.var_redir_close,
				|options, value| options.var_redir_close = value,
			),
		),
		(
			"xpg_echo",
			ShellOptionDef::new(
				|options| options.echo_builtin_expands_escape_sequences,
				|options, value| options.echo_builtin_expands_escape_sequences = value,
			),
		),
	])
});
