use std::io::Write;

use brush_core::{ExecutionResult, builtins, jobs};
use clap::Parser;

/// Moves a job to run in the background.
#[derive(Parser)]
pub(crate) struct BgCommand {
	/// List of job specs to move to background.
	job_specs: Vec<String>,
}

impl builtins::Command for BgCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// With job control on, Bash knows which jobs stopped or continued, and
		// it knows which ended.
		if context.shell.options().enable_job_control {
			context.shell.jobs_mut().observe_stops_and_continues()?;
		}
		context.shell.jobs_mut().poll_preserving_completed()?;
		let mut stderr = context.stderr();
		let mut exit_code = ExecutionResult::success();

		if !self.job_specs.is_empty() {
			for job_spec in &self.job_specs {
				if let Some(job) = context.shell.jobs_mut().resolve_job_spec(job_spec) {
					if !resume_in_background(&mut stderr, &context.command_name, job)? {
						exit_code = ExecutionResult::general_error();
					}
				} else {
					writeln!(stderr, "{}: {}: no such job", context.command_name, job_spec)?;
					exit_code = ExecutionResult::general_error();
				}
			}
		} else {
			if let Some(job) = context.shell.jobs_mut().current_job_mut() {
				if !resume_in_background(&mut stderr, &context.command_name, job)? {
					exit_code = ExecutionResult::general_error();
				}
			} else {
				writeln!(stderr, "{}: no current job", context.command_name)?;
				exit_code = ExecutionResult::general_error();
			}
		}

		Ok(exit_code)
	}
}

/// Resumes `job` in the background, as Bash's `start_job` does for `bg`: a
/// job that has ended is refused, and a job that runs is left as it is, with
/// a note, and counts as success. Returns whether `bg` succeeded for it.
fn resume_in_background(
	stderr: &mut impl Write,
	command_name: &str,
	job: &mut jobs::Job,
) -> Result<bool, brush_core::Error> {
	match job.state {
		jobs::JobState::Done => {
			writeln!(stderr, "{command_name}: job has terminated")?;
			Ok(false)
		},
		jobs::JobState::Running => {
			writeln!(stderr, "{command_name}: job {} already in background", job.id)?;
			Ok(true)
		},
		jobs::JobState::Stopped | jobs::JobState::Unknown => {
			job.move_to_background()?;
			Ok(true)
		},
	}
}
