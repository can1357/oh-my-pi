use std::io::Write;

use clap::Parser;

use crate::{ExecutionExitCode, ExecutionResult, builtins};

/// Suspend the shell.
#[derive(Parser)]
pub(crate) struct SuspendCommand {
	/// Force suspend login shells.
	#[arg(short = 'f')]
	force: bool,
}

impl builtins::Command for SuspendCommand {
	type Error = crate::Error;

	async fn execute<SE: crate::ShellExtensions>(
		&self,
		context: crate::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if context.params.protect_host_process() {
			return Err(crate::ErrorKind::SuspendNotSupportedInShellHost.into());
		}
		if context.shell.options().login_shell && !self.force {
			writeln!(context.stderr(), "login shell cannot be suspended")?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		#[expect(clippy::cast_possible_wrap)]
		crate::sys::signal::kill_process(
			std::process::id() as i32,
			crate::traps::TrapSignal::Signal(nix::sys::signal::SIGSTOP),
		)?;

		Ok(ExecutionResult::success())
	}
}
