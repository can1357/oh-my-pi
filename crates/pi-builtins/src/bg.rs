use brush_core::{ExecutionResult, builtins};
use clap::Parser;

use crate::job_resume;

/// Moves a job to run in the background.
#[derive(Parser)]
pub(crate) struct BgCommand {
	/// List of job specs to move to background; the current job if none.
	#[arg(allow_hyphen_values = true, trailing_var_arg = true)]
	job_specs: Vec<String>,
}

impl builtins::Command for BgCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut stdout = context.stdout();
		let mut stderr = context.stderr();
		let job_control = context.shell.options().enable_job_control;
		let operands = match job_resume::operands(
			&context.command_name,
			"bg [job_spec ...]",
			job_control,
			&self.job_specs,
			&mut stderr,
		)? {
			Ok(operands) => operands,
			Err(status) => return Ok(ExecutionResult::new(status)),
		};
		// Bash knows which jobs stopped, continued or ended.
		context.shell.jobs_mut().observe_stops_and_continues()?;
		context.shell.jobs_mut().poll_preserving_completed()?;

		// Each operand in turn, the current job if none (`bg_builtin`).
		let specs: Vec<Option<&str>> = if operands.is_empty() {
			vec![None]
		} else {
			operands.iter().map(|operand| Some(operand.as_str())).collect()
		};
		let mut succeeded = true;
		for spec in specs {
			succeeded &= job_resume::resume_in_background(
				context.shell,
				spec,
				&context.command_name,
				&mut stdout,
				&mut stderr,
			)?;
		}
		Ok(if succeeded { ExecutionResult::success() } else { ExecutionResult::general_error() })
	}
}
