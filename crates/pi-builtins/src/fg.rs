use std::io::Write;

use brush_core::{ExecutionResult, builtins, jobs, sys};
use clap::Parser;

use crate::job_resume;

/// Move a specified job to the foreground.
#[derive(Parser)]
pub(crate) struct FgCommand {
	/// Job spec for the job to move to the foreground; if not specified, the
	/// current job is moved. Only the first is used, and a last operand `&`
	/// resumes the job in the background instead.
	#[arg(allow_hyphen_values = true, trailing_var_arg = true)]
	args: Vec<String>,
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
		let operands = match job_resume::operands(
			&context.command_name,
			"fg [job_spec]",
			job_control,
			&self.args,
			&mut stderr,
		)? {
			Ok(operands) => operands,
			Err(status) => return Ok(ExecutionResult::new(status)),
		};
		// Bash knows which jobs stopped, continued or ended.
		context.shell.jobs_mut().observe_stops_and_continues()?;
		context.shell.jobs_mut().poll_preserving_completed()?;

		// As Bash's `fg_builtin` does, a last operand `&` resumes the job in
		// the background.
		if operands.last().is_some_and(|last| last == "&") {
			let resumed = job_resume::resume_in_background(
				context.shell,
				operands.first().map(String::as_str),
				&context.command_name,
				&mut stdout,
				&mut stderr,
			)?;
			return Ok(if resumed { ExecutionResult::success() } else { ExecutionResult::general_error() });
		}

		let Some(job) = job_resume::resolve(
			context.shell.jobs_mut(),
			operands.first().map(String::as_str),
			&context.command_name,
			&mut stderr,
		)?
		else {
			return Ok(ExecutionResult::general_error());
		};
		if !job_resume::check_resumable(job, &context.command_name, &mut stderr)? {
			return Ok(ExecutionResult::general_error());
		}
		let id = job.id;
		writeln!(stdout, "{}", job.command_line)?;

		// A shell without a terminal of its own, a script with `set -m`, has
		// none to give the job.
		let result = context.shell.jobs_mut().run_in_foreground(id, is_interactive).await?;
		if is_interactive {
			sys::terminal::move_self_to_foreground()?;
		}

		// Bash running a script prints nothing for a job that stops
		// (`notify_of_job_status`); `jobs` shows it.
		if is_interactive
			&& let Some(job) = context.shell.jobs().jobs.iter().find(|job| job.id == id)
			&& matches!(job.state, jobs::JobState::Stopped)
		{
			// N.B. We use the '\r' to overwrite any ^Z output.
			writeln!(stderr, "\r{job}")?;
		}

		Ok(result.unwrap_or_else(ExecutionResult::general_error))
	}
}
