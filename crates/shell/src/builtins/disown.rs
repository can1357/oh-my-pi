use std::io::Write as _;

use clap::Parser;
use smallvec::SmallVec;

use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins, jobs};

/// Removes jobs from the shell's managed job table.
#[derive(Parser)]
#[clap(disable_help_flag = true)]
pub(crate) struct DisownCommand {
	/// Select all jobs.
	#[arg(short = 'a')]
	all: bool,

	/// Restrict selection to running jobs.
	#[arg(short = 'r')]
	running_only: bool,

	/// Keep selected jobs but omit future SIGHUP delivery.
	#[arg(short = 'h')]
	keep: bool,

	/// Jobs to disown.
	job_specs: Vec<String>,
}

impl builtins::Command for DisownCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut ids = SmallVec::<usize, 4>::new();
		let mut had_error = false;

		if self.all || (self.running_only && self.job_specs.is_empty()) {
			ids.extend(context.shell.jobs().jobs.iter().map(|job| job.id));
		} else if self.job_specs.is_empty() {
			if let Some(job) = context.shell.jobs().current_job() {
				ids.push(job.id);
			} else {
				writeln!(context.stderr(), "{}: current: no such job", context.command_name)?;
				had_error = true;
			}
		} else {
			for job_spec in &self.job_specs {
				match resolve_job_id(context.shell.jobs(), job_spec) {
					Ok(id) => {
						if !ids.contains(&id) {
							ids.push(id);
						}
					},
					Err(error) => {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, job_spec, error)?;
						had_error = true;
					},
				}
			}
		}

		if self.running_only {
			ids.retain(|id| {
				context
					.shell
					.jobs()
					.jobs
					.iter()
					.find(|job| job.id == *id)
					.is_some_and(|job| matches!(job.state, jobs::JobState::Running))
			});
		}

		if self.keep {
			for id in ids {
				context.shell.jobs_mut().keep_on_shell_exit(id);
			}
		} else {
			for id in ids {
				context.shell.jobs_mut().disown(id);
			}
		}

		if had_error {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}

fn resolve_job_id(
	job_manager: &jobs::JobManager,
	job_spec: &str,
) -> Result<usize, jobs::JobSpecError> {
	match job_manager.resolve_job_spec_selector(job_spec)? {
		jobs::JobSelector::JobId(id) => Ok(id),
		jobs::JobSelector::ProcessId(pid) => job_manager
			.jobs
			.iter()
			.find(|job| {
				job.representative_pid()
					.is_some_and(|job_pid| job_pid == pid)
			})
			.map(|job| job.id)
			.ok_or(jobs::JobSpecError::NotFound),
	}
}
