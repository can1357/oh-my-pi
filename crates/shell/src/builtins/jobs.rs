use std::io::Write;

use clap::Parser;

use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins, jobs};

/// Manage jobs.
#[derive(Parser)]
pub(crate) struct JobsCommand {
	/// Also show process IDs.
	#[arg(short = 'l')]
	also_show_pids: bool,

	/// List only jobs that have changed status since the last notification.
	#[arg(short = 'n')]
	list_changed_only: bool,

	/// Show only process IDs.
	#[arg(short = 'p')]
	show_pids_only: bool,

	/// Show only running jobs.
	#[arg(short = 'r')]
	running_jobs_only: bool,

	/// Show only stopped jobs.
	#[arg(short = 's')]
	stopped_jobs_only: bool,

	/// Job specs to list.
	// TODO(jobs): Add -x option
	job_specs: Vec<String>,
}

impl builtins::Command for JobsCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.list_changed_only {
			for (job, result) in context.shell.jobs_mut().poll()? {
				result?;
				self.display_job(&context, &job)?;
			}
			return Ok(ExecutionResult::success());
		}

		let mut exit_code = ExecutionResult::success();
		if self.job_specs.is_empty() {
			for job in &context.shell.jobs().jobs {
				self.display_job(&context, job)?;
			}
		} else {
			for job_spec in &self.job_specs {
				match resolve_job_spec(context.shell.jobs(), job_spec) {
					Ok(job) => self.display_job(&context, job)?,
					Err(error) => {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, job_spec, error)?;
						exit_code = ExecutionResult::general_error();
					},
				}
			}
		}

		Ok(exit_code)
	}
}

impl JobsCommand {
	fn display_job(
		&self,
		context: &ExecutionContext<'_, impl ShellExtensions>,
		job: &jobs::Job,
	) -> Result<(), Error> {
		if self.running_jobs_only && !matches!(job.state, jobs::JobState::Running) {
			return Ok(());
		}
		if self.stopped_jobs_only && !matches!(job.state, jobs::JobState::Stopped) {
			return Ok(());
		}

		if self.show_pids_only {
			if let Some(pid) = job.representative_pid() {
				writeln!(context.stdout(), "{pid}")?;
			}
		} else if self.also_show_pids {
			write!(context.stdout(), "[{}]{:3}", job.id, job.annotation())?;
			if let Some(pid) = job.representative_pid() {
				write!(context.stdout(), "{pid}\t")?;
			} else {
				write!(context.stdout(), "<pid unknown>\t")?;
			}
			writeln!(context.stdout(), "{}\t{}", job.state, job.command_line)?;
		} else {
			writeln!(context.stdout(), "{job}")?;
		}

		Ok(())
	}
}

fn resolve_job_spec<'a>(
	job_manager: &'a jobs::JobManager,
	job_spec: &str,
) -> Result<&'a jobs::Job, jobs::JobSpecError> {
	match job_manager.resolve_job_spec_selector(job_spec)? {
		jobs::JobSelector::JobId(id) => job_manager
			.jobs
			.iter()
			.find(|job| job.id == id)
			.ok_or(jobs::JobSpecError::NotFound),
		jobs::JobSelector::ProcessId(pid) => job_manager
			.jobs
			.iter()
			.find(|job| {
				job.representative_pid()
					.is_some_and(|job_pid| job_pid == pid)
			})
			.ok_or(jobs::JobSpecError::NotFound),
	}
}
