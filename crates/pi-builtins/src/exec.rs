use std::{
	borrow::Cow,
	os::unix::process::{CommandExt, ExitStatusExt},
};

use brush_core::{ErrorKind, ExecutionExitCode, ExecutionResult, builtins, commands};
use clap::Parser;

use crate::withheld::{ExecOptions, parse_exec_args};

/// Exec the provided command.
#[derive(Parser)]
pub(crate) struct ExecCommand {
	/// Options, command and arguments, as given (see
	/// [`crate::withheld::parse_exec_args`]).
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for ExecCommand {
	type Error = brush_core::Error;

	/// Takes every word as given: Bash's option parser, not clap's, reads
	/// them (`--` included).
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { args: args.into_iter().skip(1).collect() })
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let options = match parse_exec_args(&self.args) {
			Ok(options) => options,
			Err(error) => return error.report(&context),
		};
		if options.command.is_empty() {
			// With no command there is nothing to execute. The shell's dispatch
			// has already made this command's redirections the shell's own
			// (see `withheld::exec_names_no_command`).
			return Ok(ExecutionResult::success());
		}

		// If we know we're already running in a subshell, then `exec`ing is actually
		// unsafe, since it would also replace the *parent* shell instance. We instead
		// delegate to the `command` builtin to perform the execution, with an
		// expectation of returning.
		if context.shell.is_subshell() {
			if options.clean_environment || options.login || options.argv0.is_some() {
				return execute_external_in_subshell(&options, context).await;
			}

			let cmd_cmd = crate::command::CommandCommand {
				command_and_args: options.command.to_vec(),
				..Default::default()
			};

			return cmd_cmd.execute(context).await;
		}

		let argv0 = argv0(&options);

		let mut cmd = commands::compose_std_command(
			&context,
			&options.command[0],
			argv0.as_ref(),
			&options.command[1..],
			options.clean_environment,
		)
		.await?;

		let exec_error = cmd.exec();

		if exec_error.kind() == std::io::ErrorKind::NotFound {
			Ok(ExecutionExitCode::NotFound.into())
		} else {
			Err(ErrorKind::from(exec_error).into())
		}
	}
}

/// The zeroth argument `exec` gives its command: `-a`'s, else the command
/// name, with a `-` before it for `-l`.
fn argv0<'a>(options: &ExecOptions<'a>) -> Cow<'a, str> {
	let argv0 = options.argv0.unwrap_or_else(|| options.command[0].as_str());

	if options.login {
		Cow::Owned(std::format!("-{argv0}"))
	} else {
		Cow::Borrowed(argv0)
	}
}

/// Runs `exec`'s command as a child and returns its status, as `exec` does
/// in a subshell, whose replacement would replace its parent too.
async fn execute_external_in_subshell<SE: brush_core::ShellExtensions>(
	options: &ExecOptions<'_>,
	context: brush_core::ExecutionContext<'_, SE>,
) -> Result<ExecutionResult, brush_core::Error> {
	let argv0 = argv0(options);
	let cmd = commands::compose_std_command(
		&context,
		&options.command[0],
		argv0.as_ref(),
		&options.command[1..],
		options.clean_environment,
	)
	.await?;

	let mut cmd = tokio::process::Command::from(cmd);
	cmd.kill_on_drop(true);

	let mut child = match cmd.spawn() {
		Ok(child) => child,
		Err(spawn_err) => {
			if spawn_err.kind() == std::io::ErrorKind::NotFound {
				return Ok(ExecutionExitCode::NotFound.into());
			}

			return Err(ErrorKind::from(spawn_err).into());
		},
	};

	let status = child.wait().await?;

	if let Some(code) = status.code() {
		#[expect(clippy::cast_sign_loss)]
		return Ok(ExecutionResult::new((code & 0xff) as u8));
	}

	if let Some(signal) = status.signal() {
		#[expect(clippy::cast_sign_loss)]
		return Ok(ExecutionResult::new((signal & 0xff) as u8 + 128));
	}

	tracing::error!("unhandled process exit");
	Ok(ExecutionExitCode::NotFound.into())
}
