use std::io::Write;

use brush_core::{ExecutionResult, ShellExtensions, builtins};
use clap::Parser;

/// Stands in for a builtin the embedding shell withholds because it would act
/// on the host process itself (`exec` replaces it, `suspend` stops it).
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct WithheldCommand {
	#[clap(allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for WithheldCommand {
	type Error = brush_core::Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		writeln!(context.stderr(), "{}: not available in this shell", context.command_name)?;
		Ok(ExecutionResult::general_error())
	}
}

/// Registration that replaces a builtin the embedding shell withholds.
///
/// It starts disabled, so the name resolves exactly as a disabled builtin
/// does, and re-enabling it (`enable exec`) only enables the refusal: the real
/// implementation is no longer registered.
pub fn withheld_builtin<SE: ShellExtensions>() -> builtins::Registration<SE> {
	let mut registration = builtins::builtin::<WithheldCommand, SE>();
	registration.disabled = true;
	registration
}

/// Stands in for `exec` in a shell that withholds command replacement, which
/// would replace the host process, but keeps `exec`'s other form: with no
/// command, the redirections given to `exec` change the shell's own
/// descriptors for every later command, as in Bash (`exec 2>/dev/null`,
/// `exec 3>file`, `exec 2>&3`, `exec 3>&-`). The shell's dispatch makes them
/// the shell's before this runs (see [`exec_names_no_command`]); this checks
/// `exec`'s options and refuses a command.
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct RedirectionOnlyExec {
	/// Pass given name as zeroth argument to command (accepted and ignored
	/// without a command, as in Bash).
	#[arg(short = 'a', value_name = "NAME")]
	_name_for_argv0: Option<String>,

	/// Exec command with an empty environment.
	#[arg(short = 'c')]
	_empty_environment: bool,

	/// Exec command as a login shell.
	#[arg(short = 'l')]
	_exec_as_login: bool,

	/// Command and args.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for RedirectionOnlyExec {
	type Error = brush_core::Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if !self.args.is_empty() {
			writeln!(context.stderr(), "{}: not available in this shell", context.command_name)?;
			return Ok(ExecutionResult::general_error());
		}
		Ok(ExecutionResult::success())
	}
}

/// Registration of [`RedirectionOnlyExec`], a special builtin as `exec` is.
pub fn redirection_only_exec_builtin<SE: ShellExtensions>() -> builtins::Registration<SE> {
	builtins::builtin::<RedirectionOnlyExec, SE>()
		.special()
		.keeps_redirections(exec_names_no_command)
}

/// Whether `exec`'s arguments (after its name) name no command to run, so
/// the simple command that runs `exec` leaves its redirections in the
/// shell, as Bash's dispatch does for `exec` (see
/// [`builtins::Registration::keeps_redirections`]). Bash keeps them before
/// `exec` parses its options, so an invalid option (`exec -z 2>/dev/null`)
/// still keeps them. A command `exec` would replace the shell with is one
/// this shell refuses, and the refusal changes no descriptor.
pub(crate) fn exec_names_no_command(args: &[brush_core::CommandArg]) -> bool {
	let mut words = args.iter().map(ToString::to_string);
	while let Some(word) = words.next() {
		match word.as_str() {
			"--" => return words.next().is_none(),
			"-a" => {
				words.next();
			},
			option if option.starts_with('-') && option.len() > 1 => {},
			_ => return false,
		}
	}
	true
}
