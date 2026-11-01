use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
	int_utils,
	jobs::{Job, JobManager, JobSelector},
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

		if self.wait_for_first_or_next {
			let mut selectors = Vec::with_capacity(self.ids.len());
			for id in &self.ids {
				match next_wait_selector(context.shell.jobs(), id) {
					Ok(selector) => selectors.push(selector),
					Err(refusal) => {
						writeln!(context.stderr(), "{}: {}", context.command_name, refusal.message)?;
						return Ok(refusal.status.into());
					},
				}
			}
			let Some(waited) = context.shell.jobs_mut().wait_next(&selectors).await? else {
				return Ok(ExecutionExitCode::NotFound.into());
			};
			if let Some(variable) = &self.variable_to_receive_id {
				assign_wait_variable(context.shell, variable, waited.identifier)?;
			}
			return Ok(waited.result);
		}

		let mut result = ExecutionResult::success();
		let mut waited_identifier = None;
		if self.ids.is_empty() {
			// Wait for all jobs.
			let jobs = if self.wait_for_terminate {
				context.shell.jobs_mut().wait_all_for_termination().await?
			} else {
				context.shell.jobs_mut().wait_all().await?
			};
			waited_identifier = jobs.last().map(job_identifier);

			if context.shell.options().enable_job_control {
				for job in jobs {
					writeln!(context.stdout(), "{job}")?;
				}
			}
		}

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
					.map(job_identifier),
				JobSelector::ProcessId(pid) => Some(pid.to_string()),
			};
			if let Some(waited) = context
				.shell
				.jobs_mut()
				.wait_for(selector, self.wait_for_terminate)
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

/// Resolves an operand of `wait -n`, which only waits for jobs in the table.
fn next_wait_selector(jobs: &JobManager, id: &str) -> Result<JobSelector, Refusal> {
	match int_utils::parse::<i32>(id, 10) {
		Ok(pid) if jobs.contains_process_id(pid) => Ok(JobSelector::ProcessId(pid)),
		Ok(pid) => Err(not_a_child(pid)),
		Err(_) => jobs.resolve_job_spec_selector(id).ok_or_else(|| no_such_job(id)),
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

fn job_identifier(job: &Job) -> String {
	job
		.representative_pid()
		.map_or_else(|| job.id.to_string(), |pid| pid.to_string())
}
