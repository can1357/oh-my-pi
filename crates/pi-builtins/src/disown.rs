use std::io::Write;

use brush_core::{ExecutionResult, builtins, int_utils, jobs::JobSelector};
use clap::Parser;

/// Remove jobs from the table of active jobs.
#[derive(Parser)]
#[clap(disable_help_flag = true)]
pub(crate) struct DisownCommand {
	/// Keep each job in the table and only mark it not to receive SIGHUP.
	#[arg(short = 'h')]
	keep_in_table: bool,

	/// Remove every job when no job is named.
	#[arg(short = 'a')]
	all_jobs: bool,

	/// Remove only running jobs when no job is named.
	#[arg(short = 'r')]
	running_jobs_only: bool,

	/// Job specs or process IDs of the jobs to remove.
	job_specs: Vec<String>,
}

impl builtins::Command for DisownCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		// Reap finished jobs first, so `-r` and the status a disowned job keeps
		// are current.
		context.shell.jobs_mut().poll_preserving_completed()?;

		// `-h` asks only that a job be spared the SIGHUP Bash forwards to its
		// jobs when it gets one; this shell forwards none, so `-h` checks that
		// each job exists and leaves it where it is.
		if self.job_specs.is_empty() && (self.all_jobs || self.running_jobs_only) {
			if !self.keep_in_table {
				context.shell.jobs_mut().disown_all(self.running_jobs_only);
			}
			return Ok(ExecutionResult::success());
		}

		let current = [String::from("%+")];
		let specs = if self.job_specs.is_empty() { &current[..] } else { &self.job_specs[..] };
		let mut result = ExecutionResult::success();
		// As in Bash, each operand is resolved against the table the operands
		// before it left: `disown %% %%` removes the current job and then the
		// one that became current.
		for spec in specs {
			let jobs = context.shell.jobs_mut();
			let selector = match int_utils::parse::<i32>(spec, 10) {
				Ok(pid) => jobs
					.contains_process_id(pid)
					.then_some(JobSelector::ProcessId(pid)),
				Err(_) => jobs.resolve_job_spec_selector(spec),
			};
			let found = selector.is_some_and(|selector| self.keep_in_table || jobs.disown(selector));
			if !found {
				let name = if self.job_specs.is_empty() { "current" } else { spec.as_str() };
				writeln!(context.stderr(), "{}: {name}: no such job", context.command_name)?;
				result = ExecutionResult::general_error();
			}
		}

		Ok(result)
	}
}
