use std::io::Write;

use brush_core::{ExecutionResult, builtins, jobs, sys};
use clap::Parser;

/// Move a specified job to the foreground.
#[derive(Parser)]
pub(crate) struct FgCommand {
	/// Job spec for the job to move to the foreground; if not specified, the
	/// current job is moved.
	job_spec: Option<String>,
}

impl builtins::Command for FgCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut stdout = context.stdout();
		let mut stderr = context.stderr();

		// Read options before taking mutable borrow on jobs
		let is_interactive = context.shell.options().interactive;
		let job_control = context.shell.options().enable_job_control;
		// With job control on, Bash knows which jobs stopped or continued, and
		// it knows which ended.
		if job_control {
			context.shell.jobs_mut().observe_stops_and_continues()?;
		}
		context.shell.jobs_mut().poll_preserving_completed()?;

		let job = match &self.job_spec {
			Some(job_spec) => context.shell.jobs_mut().resolve_job_spec(job_spec),
			None => context.shell.jobs_mut().current_job_mut(),
		};
		let Some(job) = job else {
			match &self.job_spec {
				Some(job_spec) => {
					writeln!(stdout, "{}: {}: no such job", job_spec, context.command_name)?;
				},
				None => writeln!(stdout, "{}: no current job", context.command_name)?,
			}
			return Ok(ExecutionResult::general_error());
		};
		// As Bash's `start_job` does, refuse a job that has ended.
		if job.is_done() {
			writeln!(stderr, "{}: job has terminated", context.command_name)?;
			return Ok(ExecutionResult::general_error());
		}
		let id = job.id;
		writeln!(stdout, "{}", job.command_line)?;

		// A shell without a terminal of its own, a script with `set -m`, has
		// none to give the job.
		let result = context
			.shell
			.jobs_mut()
			.run_in_foreground(id, job_control, is_interactive)
			.await?;
		if is_interactive {
			sys::terminal::move_self_to_foreground()?;
		}

		if let Some(job) = context.shell.jobs().jobs.iter().find(|job| job.id == id)
			&& matches!(job.state, jobs::JobState::Stopped)
		{
			// N.B. We use the '\r' to overwrite any ^Z output.
			writeln!(stderr, "\r{job}")?;
		}

		Ok(result.unwrap_or_else(ExecutionResult::general_error))
	}
}
