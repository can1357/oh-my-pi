use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;

/// Suspend the shell.
#[derive(Parser)]
pub(crate) struct SuspendCommand {
	/// Force suspend login shells.
	#[arg(short = 'f')]
	force: bool,
}

impl builtins::Command for SuspendCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if context.shell.options().login_shell && !self.force {
			writeln!(context.stderr(), "login shell cannot be suspended")?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		#[expect(clippy::cast_possible_wrap)]
		brush_core::sys::signal::kill_process(
			std::process::id() as i32,
			brush_core::traps::TrapSignal::Signal(nix::sys::signal::SIGSTOP),
		)?;

		Ok(ExecutionResult::success())
	}
}
