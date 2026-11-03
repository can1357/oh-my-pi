use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
	int_utils,
	jobs::{Job, JobManager, JobSelector, JobState},
	variables::ShellValueLiteral,
};
use clap::Parser;

/// Wait for jobs to terminate.
#[derive(Parser)]
pub(crate) struct WaitCommand {
	/// Wait for specified job to terminate (instead of change status).
	#[arg(short = 'f')]
	wait_for_terminate: bool,

	/// Wait for a single job to change status; if jobs are specified, waits for
	/// the first to change status, and otherwise waits for the next change.
	#[arg(short = 'n')]
	wait_for_first_or_next: bool,

	/// Name of variable to receive the job ID of the job whose status is
	/// indicated.
	#[arg(short = 'p', value_name = "VAR_NAME")]
	variable_to_receive_id: Option<String>,

	/// Process IDs or job specs to wait for.
	ids: Vec<String>,
}

impl builtins::Command for WaitCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if let Some(variable) = &self.variable_to_receive_id {
			context.shell.env_mut().unset(variable)?;
		}
		let job_control = context.shell.options().enable_job_control;
		// With job control Bash has seen every stop and continue before it
		// reads a job spec, which moves the current job.
		if job_control && !self.ids.is_empty() {
			context.shell.jobs_mut().observe_stops_and_continues()?;
		}

		if self.wait_for_first_or_next {
			// As Bash's `set_waitlist` does, refuse each operand that names no
			// job and wait for the others; with none left, return 127.
			let mut selectors = Vec::with_capacity(self.ids.len());
			for id in &self.ids {
				match next_wait_selector(context.shell.jobs(), id) {
					Some(selector) => selectors.push(selector),
					None => {
						writeln!(context.stderr(), "{}: {}", context.command_name, no_such_job(id).message)?;
					},
				}
			}
			if !self.ids.is_empty() && selectors.is_empty() {
				return Ok(ExecutionExitCode::NotFound.into());
			}
			let Some(waited) = context
				.shell
				.jobs_mut()
				.wait_next(&selectors, job_control)
				.await?
			else {
				return Ok(ExecutionExitCode::NotFound.into());
			};
			if let Some(variable) = &self.variable_to_receive_id {
				assign_wait_variable(context.shell, variable, waited.identifier)?;
			}
			return Ok(waited.result);
		}

		if self.ids.is_empty() {
			// Wait for all jobs. As in Bash, even with `set -m`, `wait` prints
			// none of the jobs it collects: a script learns their state from
			// `jobs`. It warns of each stopped job it passes over
			// (`wait_for_background_pids`). Bash leaves the `-p` variable unset
			// here.
			let last_async_pid = context.shell.last_background_pid();
			let stopped = if self.wait_for_terminate {
				context
					.shell
					.jobs_mut()
					.wait_all_for_termination(last_async_pid, job_control)
					.await?
			} else {
				context
					.shell
					.jobs_mut()
					.wait_all(last_async_pid, job_control)
					.await?
			};
			for (job_id, pid) in stopped {
				let pid = pid.map(|pid| pid.to_string()).unwrap_or_default();
				writeln!(context.stderr(), "{}: warning: job {job_id}[{pid}] stopped", context.command_name)?;
			}
			return Ok(ExecutionResult::success());
		}

		let mut result = ExecutionResult::success();
		let mut waited_identifier = None;
		for id in &self.ids {
			let selector = match wait_selector(context.shell.jobs(), id) {
				Ok(selector) => selector,
				Err(refusal) => {
					writeln!(context.stderr(), "{}: {}", context.command_name, refusal.message)?;
					result = refusal.status.into();
					continue;
				},
			};
			let identifier = match selector {
				JobSelector::JobId(job_id) => context
					.shell
					.jobs()
					.jobs
					.iter()
					.find(|job| job.id == job_id)
					.map(Job::wait_identifier),
				JobSelector::ProcessId(pid) => Some(pid.to_string()),
			};
			// In POSIX mode Bash then forgets the ended jobs that were reported
			// and the status of a pid it waited for as a child, but not a status
			// it only kept (`wait_for_single_pid`).
			let posix_forgotten_pid = match selector {
				JobSelector::ProcessId(pid)
					if context.shell.options().posix_mode
						&& context.shell.jobs().contains_process_id(pid) =>
				{
					Some(pid)
				},
				_ => None,
			};
			// Bash warns that a job it is asked to wait for is stopped
			// (`wait_for_job`), which it sees only with job control on.
			if job_control && let JobSelector::JobId(job_id) = selector {
				context.shell.jobs_mut().observe_stops_and_continues()?;
				if context
					.shell
					.jobs()
					.jobs
					.iter()
					.any(|job| job.id == job_id && matches!(job.state, JobState::Stopped))
				{
					writeln!(
						context.stderr(),
						"{}: warning: wait_for_job: job {job_id} is stopped",
						context.command_name
					)?;
				}
			}
			if let Some(waited) = context
				.shell
				.jobs_mut()
				.wait_for(selector, self.wait_for_terminate, job_control)
				.await?
			{
				result = waited;
				waited_identifier = identifier;
			} else {
				let refusal = match selector {
					JobSelector::ProcessId(pid) => not_a_child(pid),
					JobSelector::JobId(_) => no_such_job(id),
				};
				writeln!(context.stderr(), "{}: {}", context.command_name, refusal.message)?;
				result = refusal.status.into();
			}
			if let Some(pid) = posix_forgotten_pid {
				context.shell.jobs_mut().remove_reported_jobs();
				context.shell.jobs_mut().forget_reported(pid);
			}
		}

		if let (Some(variable), Some(identifier)) = (&self.variable_to_receive_id, waited_identifier) {
			assign_wait_variable(context.shell, variable, identifier)?;
		}

		Ok(result)
	}
}

/// Why `wait` refuses an operand: Bash's message and exit status.
struct Refusal {
	message: String,
	status:  ExecutionExitCode,
}

fn no_such_job(id: &str) -> Refusal {
	Refusal { message: format!("{id}: no such job"), status: ExecutionExitCode::NotFound }
}

fn not_a_child(pid: i32) -> Refusal {
	Refusal {
		message: format!("pid {pid} is not a child of this shell"),
		status:  ExecutionExitCode::NotFound,
	}
}

/// Resolves an operand of `wait`: a job spec names a job in the table, and a
/// number names a pid, whose job or kept status `wait` then looks up.
fn wait_selector(jobs: &JobManager, id: &str) -> Result<JobSelector, Refusal> {
	if id.starts_with('%') {
		return jobs.resolve_job_spec_selector(id).ok_or_else(|| no_such_job(id));
	}
	int_utils::parse::<i32>(id, 10)
		.map(JobSelector::ProcessId)
		.map_err(|_| Refusal {
			message: format!("`{id}': not a pid or valid job spec"),
			status:  ExecutionExitCode::GeneralError,
		})
}

/// Resolves an operand of `wait -n`, which only waits for jobs in the table:
/// a number names the job holding that pid, as Bash's `set_waitlist` does.
fn next_wait_selector(jobs: &JobManager, id: &str) -> Option<JobSelector> {
	match int_utils::parse::<i32>(id, 10) {
		Ok(pid) => jobs.contains_process_id(pid).then_some(JobSelector::ProcessId(pid)),
		Err(_) => jobs.resolve_job_spec_selector(id),
	}
}

fn assign_wait_variable(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	name: &str,
	value: String,
) -> Result<(), brush_core::Error> {
	shell.env_mut().update_or_add(
		name,
		ShellValueLiteral::Scalar(value),
		|_| Ok(()),
		EnvironmentLookup::Anywhere,
		EnvironmentScope::Global,
	)
}

