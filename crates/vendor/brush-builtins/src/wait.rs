use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
	int_utils,
	jobs::{Job, JobSelector},
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

		let mut result = ExecutionResult::success();

		if self.wait_for_first_or_next {
			let selectors = match resolve_wait_selectors(&context, &self.ids)? {
				WaitSelectorResolution::Selectors(selectors) => selectors,
				WaitSelectorResolution::Failure(result) => return Ok(result),
			};
			let Some(waited) = context.shell.jobs_mut().wait_next(&selectors).await? else {
				return Ok(ExecutionExitCode::NotFound.into());
			};
			if let Some(variable) = &self.variable_to_receive_id {
				assign_wait_variable(context.shell, variable, waited.identifier)?;
			}
			return Ok(waited.result);
		}

		let mut waited_identifier = None;
		if !self.ids.is_empty() {
			for id in &self.ids {
				if id.starts_with('%') {
					// It's a job spec.
					if let Some(job) = context.shell.jobs_mut().resolve_job_spec(id) {
						waited_identifier = Some(job_identifier(job));
						result = if self.wait_for_terminate {
							job.wait_for_termination().await?
						} else {
							job.wait().await?
						};
					} else {
						writeln!(context.stderr(), "{}: no such job: {}", context.command_name, id)?;

						result = ExecutionExitCode::GeneralError.into();
					}
				} else if let Ok(pid) = int_utils::parse::<i32>(id, 10) {
					if let Some(job) = context.shell.jobs_mut().resolve_process_id(pid) {
						waited_identifier = Some(pid.to_string());
						result = if self.wait_for_terminate {
							job.wait_for_termination().await?
						} else {
							job.wait().await?
						};
					} else {
						writeln!(
							context.stderr(),
							"{}: pid {pid} is not a child of this shell",
							context.command_name
						)?;

						result = ExecutionExitCode::NotFound.into();
					}
				} else {
					writeln!(context.stderr(), "{}: no such job: {}", context.command_name, id)?;

					result = ExecutionExitCode::GeneralError.into();
				}
			}
		} else {
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

		if let (Some(variable), Some(identifier)) = (&self.variable_to_receive_id, waited_identifier) {
			assign_wait_variable(context.shell, variable, identifier)?;
		}

		Ok(result)
	}
}

enum WaitSelectorResolution {
	Selectors(Vec<JobSelector>),
	Failure(ExecutionResult),
}

fn resolve_wait_selectors<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
	ids: &[String],
) -> Result<WaitSelectorResolution, brush_core::Error> {
	let mut selectors = Vec::new();
	for id in ids {
		if id.starts_with('%') {
			if let Some(selector) = context.shell.jobs().resolve_job_spec_selector(id) {
				selectors.push(selector);
			} else {
				writeln!(context.stderr(), "{}: no such job: {}", context.command_name, id)?;
				return Ok(WaitSelectorResolution::Failure(
					ExecutionExitCode::GeneralError.into(),
				));
			}
		} else if let Ok(pid) = int_utils::parse::<i32>(id, 10) {
			if context.shell.jobs().contains_process_id(pid) {
				selectors.push(JobSelector::ProcessId(pid));
			} else {
				writeln!(
					context.stderr(),
					"{}: pid {pid} is not a child of this shell",
					context.command_name
				)?;
				return Ok(WaitSelectorResolution::Failure(ExecutionExitCode::NotFound.into()));
			}
		} else {
			writeln!(context.stderr(), "{}: no such job: {}", context.command_name, id)?;
			return Ok(WaitSelectorResolution::Failure(
				ExecutionExitCode::GeneralError.into(),
			));
		}
	}
	Ok(WaitSelectorResolution::Selectors(selectors))
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
