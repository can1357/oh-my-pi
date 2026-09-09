use std::{collections::HashMap, io::Write};

use brush_core::{ExecutionExitCode, ExecutionResult, builtins, variables};
use clap::Parser;
use itertools::Itertools;

crate::minus_or_plus_flag_arg!(
	ExportVariablesOnModification,
	'a',
	"Export variables on modification"
);
crate::minus_or_plus_flag_arg!(
	NotifyJobTerminationImmediately,
	'b',
	"Notify job termination immediately"
);
crate::minus_or_plus_flag_arg!(ExitOnNonzeroCommandExit, 'e', "Exit on nonzero command exit");
crate::minus_or_plus_flag_arg!(DisableFilenameGlobbing, 'f', "Disable filename globbing");
crate::minus_or_plus_flag_arg!(RememberCommandLocations, 'h', "Remember command locations");
crate::minus_or_plus_flag_arg!(
	PlaceAllAssignmentArgsInCommandEnv,
	'k',
	"Place all assignment args in command environment"
);
crate::minus_or_plus_flag_arg!(EnableJobControl, 'm', "Enable job control");
crate::minus_or_plus_flag_arg!(DoNotExecuteCommands, 'n', "Do not execute commands");
crate::minus_or_plus_flag_arg!(RealEffectiveUidMismatch, 'p', "Real effective UID mismatch");
crate::minus_or_plus_flag_arg!(ExitAfterOneCommand, 't', "Exit after one command");
crate::minus_or_plus_flag_arg!(TreatUnsetVariablesAsError, 'u', "Treat unset variables as error");
crate::minus_or_plus_flag_arg!(PrintShellInputLines, 'v', "Print shell input lines");
crate::minus_or_plus_flag_arg!(PrintCommandsAndArguments, 'x', "Print commands and arguments");
crate::minus_or_plus_flag_arg!(PerformBraceExpansion, 'B', "Perform brace expansion");
crate::minus_or_plus_flag_arg!(
	DisallowOverwritingRegularFilesViaOutputRedirection,
	'C',
	"Disallow overwriting regular files via output redirection"
);
crate::minus_or_plus_flag_arg!(
	ShellFunctionsInheritErrTrap,
	'E',
	"Shell functions inherit ERR trap"
);
crate::minus_or_plus_flag_arg!(
	EnableBangStyleHistorySubstitution,
	'H',
	"Enable bang style history substitution"
);
crate::minus_or_plus_flag_arg!(
	DoNotResolveSymlinksWhenChangingDir,
	'P',
	"Do not resolve symlinks when changing dir"
);
crate::minus_or_plus_flag_arg!(
	ShellFunctionsInheritDebugAndReturnTraps,
	'T',
	"Shell functions inherit DEBUG and RETURN traps"
);

#[derive(clap::Parser)]
pub(crate) struct SetOption {
	#[arg(short = 'o', name = "setopt_enable", num_args=0..=1, value_name = "OPT")]
	enable:  Option<Vec<String>>,
	#[arg(long = concat!("+o"), name = "setopt_disable", hide = true, num_args=0..=1)]
	disable: Option<Vec<String>>,
}

/// Manage set-based shell options.
#[derive(Parser)]
#[clap(disable_help_flag = true)]
pub(crate) struct SetCommand {
	/// Display help for this command.
	#[clap(long, action = clap::ArgAction::HelpLong)]
	help: Option<bool>,

	#[clap(flatten)]
	export_variables_on_modification: ExportVariablesOnModification,
	#[clap(flatten)]
	notify_job_termination_immediately: NotifyJobTerminationImmediately,
	#[clap(flatten)]
	exit_on_nonzero_command_exit: ExitOnNonzeroCommandExit,
	#[clap(flatten)]
	disable_filename_globbing: DisableFilenameGlobbing,
	#[clap(flatten)]
	remember_command_locations: RememberCommandLocations,
	#[clap(flatten)]
	place_all_assignment_args_in_command_env: PlaceAllAssignmentArgsInCommandEnv,
	#[clap(flatten)]
	enable_job_control: EnableJobControl,
	#[clap(flatten)]
	do_not_execute_commands: DoNotExecuteCommands,
	#[clap(flatten)]
	real_effective_uid_mismatch: RealEffectiveUidMismatch,
	#[clap(flatten)]
	exit_after_one_command: ExitAfterOneCommand,
	#[clap(flatten)]
	treat_unset_variables_as_error: TreatUnsetVariablesAsError,
	#[clap(flatten)]
	print_shell_input_lines: PrintShellInputLines,
	#[clap(flatten)]
	print_commands_and_arguments: PrintCommandsAndArguments,
	#[clap(flatten)]
	perform_brace_expansion: PerformBraceExpansion,
	#[clap(flatten)]
	disallow_overwriting_regular_files_via_output_redirection:
		DisallowOverwritingRegularFilesViaOutputRedirection,
	#[clap(flatten)]
	shell_functions_inherit_err_trap: ShellFunctionsInheritErrTrap,
	#[clap(flatten)]
	enable_bang_style_history_substitution: EnableBangStyleHistorySubstitution,
	#[clap(flatten)]
	do_not_resolve_symlinks_when_changing_dir: DoNotResolveSymlinksWhenChangingDir,
	#[clap(flatten)]
	shell_functions_inherit_debug_and_return_traps: ShellFunctionsInheritDebugAndReturnTraps,

	#[clap(flatten)]
	set_option: SetOption,

	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	positional_args: Vec<String>,
}

impl builtins::Command for SetCommand {
	type Error = brush_core::Error;

	fn takes_plus_options() -> bool {
		true
	}

	/// Override the default [`builtins::Command::new`] function to handle clap's
	/// limitation related to `--`. See [`builtins::parse_known`] for more
	/// information TODO(set): we can safely remove this after the issue is
	/// resolved
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		//
		// TODO(set): This is getting pretty messy; we need to see how to avoid this --
		// handling from leaking into too many commands' custom parsing.
		//

		// Apply the same workaround from the default implementation of Command::new to
		// handle '+' args.
		let mut updated_args = vec![];
		let mut now_parsing_positional_args = false;
		let mut next_arg_is_option_value = false;
		for (i, arg) in args.into_iter().enumerate() {
			if now_parsing_positional_args || next_arg_is_option_value {
				updated_args.push(arg);

				next_arg_is_option_value = false;
				continue;
			}

			if arg == "-" || arg == "--" || (i > 0 && !arg.starts_with(['-', '+'])) {
				now_parsing_positional_args = true;
			}

			if let Some(plus_options) = arg.strip_prefix("+") {
				next_arg_is_option_value = plus_options.ends_with('o');
				for c in plus_options.chars() {
					updated_args.push(format!("--+{c}"));
				}
			} else {
				next_arg_is_option_value = arg.starts_with('-') && arg.ends_with('o');
				updated_args.push(arg);
			}
		}

		let (mut this, rest_args) = brush_core::builtins::try_parse_known::<Self>(updated_args)?;
		if let Some(args) = rest_args {
			this.positional_args.extend(args);
		}
		Ok(this)
	}

	#[expect(clippy::too_many_lines)]
	#[allow(clippy::useless_let_if_seq)]
	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut result = ExecutionResult::success();

		let mut saw_option = false;

		if let Some(value) = self.print_commands_and_arguments.to_bool() {
			context.shell.options_mut().print_commands_and_arguments = value;
			saw_option = true;
		}

		if let Some(value) = self.export_variables_on_modification.to_bool() {
			context.shell.options_mut().export_variables_on_modification = value;
			saw_option = true;
		}

		if let Some(value) = self.notify_job_termination_immediately.to_bool() {
			context
				.shell
				.options_mut()
				.notify_job_termination_immediately = value;
			saw_option = true;
		}

		if let Some(value) = self.exit_on_nonzero_command_exit.to_bool() {
			context.shell.options_mut().exit_on_nonzero_command_exit = value;
			saw_option = true;
		}

		if let Some(value) = self.disable_filename_globbing.to_bool() {
			context.shell.options_mut().disable_filename_globbing = value;
			saw_option = true;
		}

		if let Some(value) = self.remember_command_locations.to_bool() {
			context.shell.options_mut().remember_command_locations = value;
			saw_option = true;
		}

		if let Some(value) = self.place_all_assignment_args_in_command_env.to_bool() {
			context
				.shell
				.options_mut()
				.place_all_assignment_args_in_command_env = value;
			saw_option = true;
		}

		if let Some(value) = self.enable_job_control.to_bool() {
			context.shell.options_mut().enable_job_control = value;
			saw_option = true;
		}

		if let Some(value) = self.do_not_execute_commands.to_bool() {
			context.shell.options_mut().do_not_execute_commands = value;
			saw_option = true;
		}

		if let Some(value) = self.real_effective_uid_mismatch.to_bool() {
			context.shell.options_mut().real_effective_uid_mismatch = value;
			saw_option = true;
		}

		if let Some(value) = self.exit_after_one_command.to_bool() {
			context.shell.options_mut().exit_after_one_command = value;
			saw_option = true;
		}

		if let Some(value) = self.treat_unset_variables_as_error.to_bool() {
			context.shell.options_mut().treat_unset_variables_as_error = value;
			saw_option = true;
		}

		if let Some(value) = self.print_shell_input_lines.to_bool() {
			context.shell.options_mut().print_shell_input_lines = value;
			saw_option = true;
		}

		if let Some(value) = self.print_commands_and_arguments.to_bool() {
			context.shell.options_mut().print_commands_and_arguments = value;
			saw_option = true;
		}

		if let Some(value) = self.perform_brace_expansion.to_bool() {
			context.shell.options_mut().perform_brace_expansion = value;
			saw_option = true;
		}

		if let Some(value) = self
			.disallow_overwriting_regular_files_via_output_redirection
			.to_bool()
		{
			context
				.shell
				.options_mut()
				.disallow_overwriting_regular_files_via_output_redirection = value;
			saw_option = true;
		}

		if let Some(value) = self.shell_functions_inherit_err_trap.to_bool() {
			context.shell.options_mut().shell_functions_inherit_err_trap = value;
			saw_option = true;
		}

		if let Some(value) = self.enable_bang_style_history_substitution.to_bool() {
			context
				.shell
				.options_mut()
				.enable_bang_style_history_substitution = value;
			saw_option = true;
		}

		if let Some(value) = self.do_not_resolve_symlinks_when_changing_dir.to_bool() {
			context
				.shell
				.options_mut()
				.do_not_resolve_symlinks_when_changing_dir = value;
			saw_option = true;
		}

		if let Some(value) = self
			.shell_functions_inherit_debug_and_return_traps
			.to_bool()
		{
			context
				.shell
				.options_mut()
				.shell_functions_inherit_debug_and_return_traps = value;
			saw_option = true;
		}

		let mut named_options: HashMap<String, bool> = HashMap::new();
		if let Some(option_names) = &self.set_option.disable {
			saw_option = true;
			if option_names.is_empty() {
				for option in
					brush_core::namedoptions::options(brush_core::namedoptions::ShellOptionKind::SetO)
						.iter()
						.sorted_by_key(|option| option.name)
				{
					let option_value = option.definition.get(context.shell.options());
					let option_value_str = if option_value { "-o" } else { "+o" };
					writeln!(context.stdout(), "set {option_value_str} {}", option.name)?;
				}
			} else {
				for option_name in option_names {
					named_options.insert(option_name.to_owned(), false);
				}
			}
		}
		if let Some(option_names) = &self.set_option.enable {
			saw_option = true;
			if option_names.is_empty() {
				for option in
					brush_core::namedoptions::options(brush_core::namedoptions::ShellOptionKind::SetO)
						.iter()
						.sorted_by_key(|option| option.name)
				{
					let option_value = option.definition.get(context.shell.options());
					let option_value_str = if option_value { "on" } else { "off" };
					writeln!(context.stdout(), "{:15}\t{option_value_str}", option.name)?;
				}
			} else {
				for option_name in option_names {
					named_options.insert(option_name.to_owned(), true);
				}
			}
		}

		for (option_name, value) in named_options {
			if let Some(option_def) =
				brush_core::namedoptions::options(brush_core::namedoptions::ShellOptionKind::SetO)
					.get(option_name.as_str())
			{
				option_def.set(context.shell.options_mut(), value);
			} else {
				result = ExecutionExitCode::InvalidUsage.into();
			}
		}

		let args = context.shell.current_shell_args_mut();

		let skip = match self.positional_args.first() {
			Some(x) if x == "-" => {
				if self.positional_args.len() > 1 {
					args.clear();
				}
				1
			},
			Some(x) if x == "--" => {
				args.clear();
				1
			},
			Some(_) => {
				args.clear();
				0
			},
			None => 0,
		};

		for arg in self.positional_args.iter().skip(skip) {
			args.push(arg.to_owned());
		}

		saw_option = saw_option || !self.positional_args.is_empty();

		// If we *still* haven't seen any options, then we need to display all variables
		// and functions.
		if !saw_option {
			display_all(&context)?;
		}

		Ok(result)
	}
}

fn display_all(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
) -> Result<(), brush_core::Error> {
	// Display variables.
	for (name, var) in context.shell.env().iter().sorted_by_key(|v| v.0) {
		if !var.is_enumerable() {
			continue;
		}

		// TODO(set): For now, skip all dynamic variables. The current behavior
		// of bash is not quite clear. We've empirically found that some
		// special variables don't get displayed until they're observed
		// at least once.
		if matches!(var.value(), variables::ShellValue::Dynamic { .. }) {
			continue;
		}

		// Skip variables that have been declared but are unset.
		if !var.value().is_set() {
			continue;
		}

		writeln!(
			context.stdout(),
			"{name}={}",
			var.value()
				.format(variables::FormatStyle::Basic, context.shell)?,
		)?;
	}

	// Display functions... unless we're in posix compliance mode.
	if !context.shell.options().posix_mode {
		for (_name, registration) in context.shell.funcs().iter().sorted_by_key(|v| v.0) {
			writeln!(context.stdout(), "{}", registration.definition())?;
		}
	}

	Ok(())
}
