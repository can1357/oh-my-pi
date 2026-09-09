use std::io::Write;

use clap::Parser;

use crate::{ExecutionResult, builtins, jobs, sys};

/// Move a specified job to the foreground.
#[derive(Parser)]
pub(crate) struct FgCommand {
	/// Job spec for the job to move to the foreground; if not specified, the
	/// current job is moved.
	job_spec: Option<String>,
}

impl builtins::Command for FgCommand {
	type Error = crate::Error;

	async fn execute<SE: crate::ShellExtensions>(
		&self,
		context: crate::ExecutionContext<'_, SE>,
	) -> Result<crate::ExecutionResult, Self::Error> {
		let mut stderr = context.stdout();

		// Read interactive option before taking mutable borrow on jobs
		let is_interactive = context.shell.options().interactive;

		if let Some(job_spec) = &self.job_spec {
			if let Ok(job) = context.shell.jobs_mut().resolve_job_spec(job_spec) {
				job.move_to_foreground()?;
				writeln!(stderr, "{}", job.command_line)?;

				let result = job.wait().await?;
				if is_interactive {
					sys::terminal::move_self_to_foreground()?;
				}

				if matches!(job.state, jobs::JobState::Stopped) {
					// N.B. We use the '\r' to overwrite any ^Z output.
					let formatted = job.to_string();
					writeln!(context.stderr(), "\r{formatted}")?;
				}

				Ok(result)
			} else {
				writeln!(stderr, "{}: {}: no such job", job_spec, context.command_name)?;
				Ok(ExecutionResult::general_error())
			}
		} else {
			if let Some(job) = context.shell.jobs_mut().current_job_mut() {
				job.move_to_foreground()?;
				writeln!(stderr, "{}", job.command_line)?;

				let result = job.wait().await?;
				if is_interactive {
					sys::terminal::move_self_to_foreground()?;
				}

				if matches!(job.state, jobs::JobState::Stopped) {
					// N.B. We use the '\r' to overwrite any ^Z output.
					let formatted = job.to_string();
					writeln!(context.stderr(), "\r{formatted}")?;
				}

				Ok(result)
			} else {
				writeln!(stderr, "{}: no current job", context.command_name)?;
				Ok(ExecutionResult::general_error())
			}
		}
	}
}
