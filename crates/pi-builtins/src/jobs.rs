use std::io::Write;

use brush_core::{ExecutionResult, builtins, jobs};
use clap::Parser;

/// Manage jobs.
///
/// As in Bash, the last of `-l`, `-n` and `-p` decides the listing and the
/// last of `-r` and `-s` the state shown, and an option may repeat.
#[derive(Parser)]
pub(crate) struct JobsCommand {
	/// Also show process IDs.
	#[arg(short = 'l', overrides_with_all = ["also_show_pids", "list_changed_only", "show_pids_only"])]
	also_show_pids: bool,

	/// List only jobs that changed state since a listing last showed them.
	#[arg(short = 'n', overrides_with_all = ["also_show_pids", "list_changed_only", "show_pids_only"])]
	list_changed_only: bool,

	/// Show only process IDs.
	#[arg(short = 'p', overrides_with_all = ["also_show_pids", "list_changed_only", "show_pids_only"])]
	show_pids_only: bool,

	/// Show only running jobs.
	#[arg(short = 'r', overrides_with_all = ["running_jobs_only", "stopped_jobs_only"])]
	running_jobs_only: bool,

	/// Show only stopped jobs.
	#[arg(short = 's', overrides_with_all = ["running_jobs_only", "stopped_jobs_only"])]
	stopped_jobs_only: bool,

	/// Job specs to list.
	// TODO(jobs): Add -x option
	job_specs: Vec<String>,
}

impl builtins::Command for JobsCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Collect the jobs that ended since the shell last looked, so the
		// listing shows them as ended rather than running. With job control
		// on, Bash also sees which processes stopped or continued.
		if context.shell.options().enable_job_control {
			context.shell.jobs_mut().observe_stops_and_continues()?;
		}
		context.shell.jobs_mut().poll_preserving_completed()?;

		let mut exit_code = ExecutionResult::success();
		if self.job_specs.is_empty() {
			// As Bash does before it lists every job, take out the ended jobs
			// an earlier listing reported.
			context.shell.jobs_mut().remove_reported_jobs();
			for index in 0..context.shell.jobs().jobs.len() {
				let job = &context.shell.jobs().jobs[index];
				if !self.lists(job) {
					continue;
				}
				let id = job.id;
				if self.display_job(&context, job, true)? {
					self.mark_listed(context.shell.jobs_mut(), id);
				}
			}
		} else {
			for job_spec in &self.job_specs {
				let Some(job) = resolve_job_spec(context.shell.jobs(), job_spec) else {
					let reason = context.shell.jobs().job_spec_match(job_spec).error_message();
					writeln!(context.stderr(), "{}: {}: {reason}", context.command_name, job_spec)?;
					exit_code = ExecutionResult::general_error();
					continue;
				};
				let id = job.id;
				if self.lists(job) && self.display_job(&context, job, false)? {
					self.mark_listed(context.shell.jobs_mut(), id);
				}
				// Bash drops the ended jobs a listing reported after each job
				// spec it lists, so a later operand, or the caller, no longer
				// finds them.
				context.shell.jobs_mut().remove_reported_jobs();
			}
		}

		Ok(exit_code)
	}
}

impl JobsCommand {
	/// `-n` lists only the jobs no listing has shown since one of their
	/// processes last changed state, including jobs no listing has shown.
	fn lists(&self, job: &jobs::Job) -> bool {
		!self.list_changed_only || !job.is_listed()
	}

	/// Writes the job unless `-r` or `-s` leaves it out, or `-p` finds no pid
	/// to print; returns whether it was written.
	fn display_job(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		job: &jobs::Job,
		filter_by_state: bool,
	) -> Result<bool, brush_core::Error> {
		if filter_by_state && self.running_jobs_only && !matches!(job.state, jobs::JobState::Running) {
			return Ok(false);
		}
		if filter_by_state && self.stopped_jobs_only && !matches!(job.state, jobs::JobState::Stopped) {
			return Ok(false);
		}

		if self.show_pids_only {
			let Some(pid) = job.representative_pid() else {
				return Ok(false);
			};
			writeln!(context.stdout(), "{pid}")?;
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

		Ok(true)
	}

	/// A listing tells the user the state of each job it shows, as Bash's
	/// does: `jobs -n` then leaves the job out until one of its processes
	/// changes state, and a job shown as ended is reported. `-p` prints only
	/// pids, which tell no state.
	fn mark_listed(&self, jobs: &mut jobs::JobManager, id: usize) {
		if !self.show_pids_only {
			jobs.mark_listed(id);
		}
	}
}

fn resolve_job_spec<'a>(job_manager: &'a jobs::JobManager, job_spec: &str) -> Option<&'a jobs::Job> {
	match job_manager.resolve_job_spec_selector(job_spec)? {
		jobs::JobSelector::JobId(id) => job_manager.jobs.iter().find(|job| job.id == id),
		jobs::JobSelector::ProcessId(pid) => job_manager
			.jobs
			.iter()
			.find(|job| job.representative_pid().is_some_and(|job_pid| job_pid == pid)),
	}
}
