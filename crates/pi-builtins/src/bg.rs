use std::io::Write;

use brush_core::{ExecutionResult, builtins};
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
		let mut exit_code = ExecutionResult::success();

		if !self.job_specs.is_empty() {
			for job_spec in &self.job_specs {
				if let Some(job) = context.shell.jobs_mut().resolve_job_spec(job_spec) {
					job.move_to_background()?;
				} else {
					writeln!(context.stderr(), "{}: {}: no such job", context.command_name, job_spec)?;
					exit_code = ExecutionResult::general_error();
				}
			}
		} else {
			if let Some(job) = context.shell.jobs_mut().current_job_mut() {
				job.move_to_background()?;
			} else {
				writeln!(context.stderr(), "{}: no current job", context.command_name)?;
				exit_code = ExecutionResult::general_error();
			}
		}

		Ok(exit_code)
	}
}
