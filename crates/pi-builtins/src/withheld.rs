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
/// `exec`'s options as Bash does (see [`parse_exec_args`]) and refuses a
/// command.
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct RedirectionOnlyExec {
	/// Options, command and arguments, as given (see [`parse_exec_args`]).
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for RedirectionOnlyExec {
	type Error = brush_core::Error;

	/// Takes every word as given: Bash's option parser, not clap's, reads
	/// them (`--` included).
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { args: args.into_iter().skip(1).collect() })
	}

	async fn execute<SE: ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let options = match parse_exec_args(&self.args) {
			Ok(options) => options,
			Err(error) => return error.report(&context),
		};
		if !options.command.is_empty() {
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

/// Whether the simple command that runs `exec` with `args` (after its name)
/// leaves its redirections in the shell, as Bash's dispatch does for `exec`
/// (see [`builtins::Registration::keeps_redirections`]). Bash decides it
/// before `exec` reads its options, so an invalid option or a missing
/// argument (`exec -z name 2>/dev/null`, status 2) keeps them too: `exec`
/// fails before it reaches any command. They stay unless the options parse
/// and leave a command, one `exec` would replace the shell with, which this
/// shell refuses without changing a descriptor. The options are read with
/// the parser `exec` itself uses ([`parse_exec_args`]).
pub(crate) fn exec_names_no_command(args: &[brush_core::CommandArg]) -> bool {
	let args: Vec<String> = args.iter().map(ToString::to_string).collect();
	!matches!(parse_exec_args(&args), Ok(options) if !options.command.is_empty())
}

/// `exec`'s options and the command they leave, as Bash's `exec_builtin`
/// reads them (see [`parse_exec_args`]).
pub(crate) struct ExecOptions<'a> {
	/// `-c`: run the command with an empty environment.
	pub(crate) clean_environment: bool,
	/// `-l`: run the command as a login shell (`-` before its zeroth argument).
	pub(crate) login: bool,
	/// `-a NAME`: the command's zeroth argument; the last `-a` wins.
	pub(crate) argv0: Option<&'a str>,
	/// The command and its arguments: every word after the options.
	pub(crate) command: &'a [String],
}

/// Why [`parse_exec_args`] refused `exec`'s options, as Bash's
/// `internal_getopt` refuses them; `exec` returns status 2 for each.
pub(crate) enum ExecUsageError {
	/// An option `exec` does not take (`-z`, or `-:`).
	InvalidOption(char),
	/// `-a` as the last word, with no argument.
	MissingArgument(char),
	/// `--help` where an option word may start.
	Help,
}

/// The synopsis Bash's `builtin_usage` prints for `exec`.
const EXEC_USAGE: &str = "exec [-cl] [-a name] [command [argument ...]] [redirection ...]";

impl ExecUsageError {
	/// Writes what Bash writes for this refusal (the diagnostic and the
	/// usage line on standard error, or the help on standard output for
	/// `--help`) and returns status 2, as Bash's `exec` returns `EX_USAGE`.
	pub(crate) fn report<SE: ShellExtensions>(
		&self,
		context: &brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, brush_core::Error> {
		let name = &context.command_name;
		match self {
			Self::InvalidOption(option) => writeln!(context.stderr(), "{name}: -{option}: invalid option")?,
			Self::MissingArgument(option) => {
				writeln!(context.stderr(), "{name}: -{option}: option requires an argument")?;
			},
			Self::Help => {
				writeln!(
					context.stdout(),
					"{name}: {EXEC_USAGE}\n    Replace the shell with the given command, or, with no command, apply \
					 the redirections to the shell itself.\n\n    Options:\n      -a name\tpass NAME as the \
					 zeroth argument to COMMAND\n      -c\texecute COMMAND with an empty environment\n      \
					 -l\tplace a dash in the zeroth argument to COMMAND"
				)?;
				return Ok(brush_core::ExecutionExitCode::InvalidUsage.into());
			},
		}
		writeln!(context.stderr(), "{name}: usage: {EXEC_USAGE}")?;
		Ok(brush_core::ExecutionExitCode::InvalidUsage.into())
	}
}

/// Reads `exec`'s options from `args` (the words after its name) as Bash's
/// `internal_getopt (list, "cla:")` does, stopping at the first error as
/// `exec_builtin` does. Each option word starts with `-` and has more after
/// it; flags combine (`-cl`), and `-a` takes the rest of its word as its
/// argument (`-aname`, `-caname`), else the next word, whatever it is (`-a
/// -c`). The options end at the first word that is not one (a lone `-`
/// too), and `--` ends them and is dropped; `--help` where a word starts is
/// the help request.
pub(crate) fn parse_exec_args(args: &[String]) -> Result<ExecOptions<'_>, ExecUsageError> {
	let mut options =
		ExecOptions { clean_environment: false, login: false, argv0: None, command: &[] };
	let mut index = 0;
	while let Some(word) = args.get(index) {
		if word == "--help" {
			return Err(ExecUsageError::Help);
		}
		if word == "--" {
			index += 1;
			break;
		}
		let Some(letters) = word.strip_prefix('-').filter(|letters| !letters.is_empty()) else {
			break;
		};
		index += 1;
		for (offset, option) in letters.char_indices() {
			match option {
				'c' => options.clean_environment = true,
				'l' => options.login = true,
				'a' => {
					let rest = &letters[offset + option.len_utf8()..];
					if rest.is_empty() {
						let Some(argument) = args.get(index) else {
							return Err(ExecUsageError::MissingArgument('a'));
						};
						options.argv0 = Some(argument);
						index += 1;
					} else {
						options.argv0 = Some(rest);
					}
					break;
				},
				other => return Err(ExecUsageError::InvalidOption(other)),
			}
		}
	}
	options.command = &args[index.min(args.len())..];
	Ok(options)
}
