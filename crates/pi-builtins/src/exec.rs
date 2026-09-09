use std::{
	borrow::Cow,
	os::unix::process::{CommandExt, ExitStatusExt},
};

use brush_core::{ErrorKind, ExecutionExitCode, ExecutionResult, builtins, commands};
use clap::Parser;

/// Exec the provided command.
#[derive(Parser)]
pub(crate) struct ExecCommand {
	/// Pass given name as zeroth argument to command.
	#[arg(short = 'a', value_name = "NAME")]
	name_for_argv0: Option<String>,

	/// Exec command with an empty environment.
	#[arg(short = 'c')]
	empty_environment: bool,

	/// Exec command as a login shell.
	#[arg(short = 'l')]
	exec_as_login: bool,

	/// Command and args.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for ExecCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.args.is_empty() {
			// When no arguments are present, then there's nothing for us to execute -- but
			// we need to ensure that any redirections setup for this builtin get applied
			// to the calling shell instance.
			#[allow(clippy::needless_collect)]
			let fds: Vec<_> = context.iter_fds().collect();

			context.shell.replace_open_files(fds.into_iter());
			return Ok(ExecutionResult::success());
		}

		// If we know we're already running in a subshell, then `exec`ing is actually
		// unsafe, since it would also replace the *parent* shell instance. We instead
		// delegate to the `command` builtin to perform the execution, with an
		// expectation of returning.
		if context.shell.is_subshell() {
			if self.empty_environment || self.exec_as_login || self.name_for_argv0.is_some() {
				return self.execute_external_in_subshell(context).await;
			}

			let cmd_cmd = crate::command::CommandCommand {
				command_and_args: self.args.clone(),
				..Default::default()
			};

			return cmd_cmd.execute(context).await;
		}

		let argv0 = self.argv0();

		let mut cmd = commands::compose_std_command(
			&context,
			&self.args[0],
			argv0.as_ref(),
			&self.args[1..],
			self.empty_environment,
		)?;

		let exec_error = cmd.exec();

		if exec_error.kind() == std::io::ErrorKind::NotFound {
			Ok(ExecutionExitCode::NotFound.into())
		} else {
			Err(ErrorKind::from(exec_error).into())
		}
	}
}

impl ExecCommand {
	fn argv0(&self) -> Cow<'_, str> {
		let argv0 = self
			.name_for_argv0
			.as_deref()
			.unwrap_or_else(|| self.args[0].as_str());

		if self.exec_as_login {
			Cow::Owned(std::format!("-{argv0}"))
		} else {
			Cow::Borrowed(argv0)
		}
	}

	async fn execute_external_in_subshell<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, brush_core::Error> {
		let argv0 = self.argv0();
		let cmd = commands::compose_std_command(
			&context,
			&self.args[0],
			argv0.as_ref(),
			&self.args[1..],
			self.empty_environment,
		)?;

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
}
