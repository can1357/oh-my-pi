use std::{
	borrow::Cow,
	io,
	os::unix::process::{CommandExt, ExitStatusExt},
};

use clap::Parser;
use tokio::process;

use crate::{
	Error, ErrorKind, ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult,
	ShellExtensions, builtins, builtins::command::CommandCommand, commands,
};

/// Exec the provided command.
///
/// In a protected embedded host, unlike bash, `exec` spawns the command and
/// exits only this shell after the child completes; it never replaces the
/// embedding process image.
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
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.args.is_empty() {
			// When no arguments are present, then there's nothing for us to execute -- but
			// we need to ensure that any redirections setup for this builtin get applied
			// to the calling shell instance.
			#[allow(clippy::needless_collect, reason = "fd iteration borrows context during exec")]
			let fds: Vec<_> = context.iter_fds().collect();

			context.shell.replace_open_files(fds.into_iter());
			return Ok(ExecutionResult::success());
		}

		// A protected root shell must preserve the embedding process, so it always
		// launches a child and exits after that child completes.
		if context.params.protect_host_process() && !context.shell.is_subshell() {
			return self.execute_external_in_subshell(context).await;
		}

		// A cloned subshell cannot safely replace its parent. Preserve the existing
		// builtin delegation for the simple form, and spawn directly for exec flags.
		if context.shell.is_subshell() {
			if self.empty_environment || self.exec_as_login || self.name_for_argv0.is_some() {
				return self.execute_external_in_subshell(context).await;
			}

			let cmd_cmd = CommandCommand { command_and_args: self.args.clone(), ..Default::default() };
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

		if exec_error.kind() == io::ErrorKind::NotFound {
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

	async fn execute_external_in_subshell<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Error> {
		let argv0 = self.argv0();
		let cmd = commands::compose_std_command(
			&context,
			&self.args[0],
			argv0.as_ref(),
			&self.args[1..],
			self.empty_environment,
		)?;

		let mut cmd = process::Command::from(cmd);
		cmd.kill_on_drop(true);

		let mut child = match cmd.spawn() {
			Ok(child) => child,
			Err(spawn_err) => {
				if spawn_err.kind() == io::ErrorKind::NotFound {
					return Ok(ExecutionExitCode::NotFound.into());
				}

				return Err(ErrorKind::from(spawn_err).into());
			},
		};
		if let Some(observer) = context.params.spawn_observer()
			&& let Some(pid) = child.id()
			&& let Ok(pid) = i32::try_from(pid)
		{
			observer.on_spawn(pid, None);
		}

		let status = child.wait().await?;
		let mut result = if let Some(code) = status.code() {
			#[expect(clippy::cast_sign_loss, reason = "exit status is masked to one byte")]
			ExecutionResult::new((code & 0xff) as u8)
		} else if let Some(signal) = status.signal() {
			#[expect(clippy::cast_sign_loss, reason = "signal status is masked to one byte")]
			ExecutionResult::new((signal & 0xff) as u8 + 128)
		} else {
			tracing::error!("unhandled process exit");
			ExecutionExitCode::NotFound.into()
		};
		if context.params.protect_host_process() && !context.shell.is_subshell() {
			result.next_control_flow = ExecutionControlFlow::ExitShell;
		}
		Ok(result)
	}
}
