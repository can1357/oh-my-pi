use std::io::Write;

use brush_core::{ExecutionResult, builtins, jobs};
use clap::Parser;

#[derive(Clone, Copy, Default)]
enum JobListingMode {
	#[default]
	Default,
	Changed,
	ProcessIds,
}

/// Manage jobs.
#[derive(Parser)]
pub(crate) struct JobsCommand {
	/// Also show process IDs.
	#[arg(short = 'l')]
	also_show_pids: bool,

	#[arg(short = 'n')]
	_list_changed_only: bool,

	/// Show only process IDs, unless a later `-n` asks for changed jobs.
	#[arg(short = 'p')]
	_show_pids_only: bool,

	/// Show only running jobs.
	#[arg(short = 'r')]
	running_jobs_only: bool,

	/// Show only stopped jobs.
	#[arg(short = 's')]
	stopped_jobs_only: bool,

	/// Job specs to list.
	// TODO(jobs): Add -x option
	job_specs: Vec<String>,

	/// The last of `-n` and `-p` in the option words. Bash lets the later
	/// option decide whether it lists changed jobs or process IDs.
	#[arg(skip)]
	listing_mode: JobListingMode,
}

impl builtins::Command for JobsCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		let args: Vec<_> = args.into_iter().collect();
		let mut command = Self::try_parse_from(args.clone())?;
		command.listing_mode = listing_mode(&args);
		Ok(command)
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Collect the jobs that ended since the shell last looked, so the
		// listing shows them as ended rather than running.
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
					self.mark_reported(context.shell.jobs_mut(), id);
				}
			}
		} else {
			for job_spec in &self.job_specs {
				let Some(job) = resolve_job_spec(context.shell.jobs(), job_spec) else {
					writeln!(context.stderr(), "{}: no such job: {}", context.command_name, job_spec)?;
					exit_code = ExecutionResult::general_error();
					continue;
				};
				if self.lists(job) {
					let id = job.id;
					self.display_job(&context, job, false)?;
					self.mark_reported(context.shell.jobs_mut(), id);
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
	/// `-n` lists only the jobs whose state changed since a listing last
	/// showed them, including jobs no listing has shown yet.
	fn lists(&self, job: &jobs::Job) -> bool {
		!matches!(self.listing_mode, JobListingMode::Changed) || job.changed_since_listed()
	}

	/// Writes the job unless `-r` or `-s` leaves it out; returns whether it
	/// was written.
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

		if matches!(self.listing_mode, JobListingMode::ProcessIds) {
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

		Ok(true)
	}

	/// A listing tells the user the state of each job it shows, as Bash's
	/// does: `jobs -n` then leaves the job out until its state changes, and
	/// `wait -n` passes over a job it showed as ended. `-p` output prints only
	/// pids, which tells no state.
	fn mark_reported(&self, jobs: &mut jobs::JobManager, id: usize) {
		if !matches!(self.listing_mode, JobListingMode::ProcessIds) {
			jobs.mark_reported(id);
		}
	}
}

/// Returns whether `-n` or `-p` occurs last in short-option words before
/// `--`. Bash uses that final option for a combined `jobs` invocation.
fn listing_mode(args: &[String]) -> JobListingMode {
	let mut mode = JobListingMode::Default;
	for arg in args.iter().skip(1) {
		if arg == "--" {
			break;
		}
		let Some(options) = arg.strip_prefix('-') else {
			continue;
		};
		if options.is_empty() || options.starts_with('-') {
			continue;
		}
		for option in options.chars() {
			match option {
				'n' => mode = JobListingMode::Changed,
				'p' => mode = JobListingMode::ProcessIds,
				_ => {},
			}
		}
	}
	mode
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
