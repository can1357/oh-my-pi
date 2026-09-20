//! Terminal presentation adapter for the driver-owned workflow host.

use std::{path::Path, sync::Arc};

use miette::IntoDiagnostic as _;
use omp_core::Str;
use omp_driver::adw::{RunStatus, definition, production::ProductionAdwHost};
use tokio_util::sync::CancellationToken;

use crate::cli::AdwCommand;

/// Runs one workflow verb.
pub async fn run(command: AdwCommand) -> miette::Result<()> {
	match command {
		AdwCommand::List { project } => list(&project),
		AdwCommand::Run { workflow, project, model, max_attempts } => {
			execute(&workflow, &project, model, max_attempts).await
		},
	}
}

fn list(project: &Path) -> miette::Result<()> {
	let names = definition::available(project);
	if names.is_empty() {
		println!(
			"No workflows declared. Add `{}/<name>.toml` under the project root.",
			definition::WORKFLOW_DIR
		);
		return Ok(());
	}
	for name in names {
		match definition::load(project, name.as_str()) {
			Ok(loaded) => {
				let phases = loaded.workflow().phases();
				println!("{name} ({} phases)", phases.len());
				for phase in phases {
					println!("  - {} [{}]", phase.name.as_str(), phase.kind);
				}
			},
			// A broken definition is reported in place rather than aborting the
			// listing: the operator asked what exists, and one invalid file does
			// not make the others unknowable.
			Err(error) => println!("{name} (invalid: {error})"),
		}
	}
	Ok(())
}

async fn execute(
	workflow: &str,
	project: &Path,
	model: Str,
	max_attempts: u32,
) -> miette::Result<()> {
	let definition = definition::load(project, workflow).into_diagnostic()?;
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let ctx = Arc::new(omp_con::Ctx::new());
	let host =
		ProductionAdwHost::open(project.to_path_buf(), data_dir, model, ctx).into_diagnostic()?;
	let cancel = CancellationToken::new();
	let exit = omp_driver::adw::run(&definition, max_attempts, &host, &cancel)
		.await
		.into_diagnostic()?;

	for record in &exit.records {
		println!(
			"{} attempt {}: {} — {}",
			record.phase,
			record.attempt,
			if record.accepted {
				"accepted"
			} else {
				"rejected"
			},
			record.decision
		);
	}
	match exit.status {
		RunStatus::Accepted => println!("Workflow `{workflow}` accepted every phase."),
		RunStatus::Halted | RunStatus::Blocked => println!(
			"Workflow `{workflow}` {}{}.",
			exit.status,
			exit
				.reason
				.as_deref()
				.map_or_else(String::new, |reason| format!(": {reason}"))
		),
		RunStatus::Cancelled => println!("Workflow `{workflow}` cancelled."),
	}
	if exit.code == 0 {
		Ok(())
	} else {
		Err(miette::miette!("workflow exited with status {}", exit.code))
	}
}
