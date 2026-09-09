//! Cross-session AutoQA grievance inventory, cleanup, and manual delivery.

use std::{fs, sync::Arc};

use miette::{IntoDiagnostic as _, Result, miette};
use omp_cache::telemetry_cache::{IssueDeleteSelector, IssueInventoryFilter, TelemetryIndex};
use omp_envd::github_url::GithubCredentialBridge;
use serde_json::json;

use crate::cli::{GrievanceAction, GrievancesArgs};

/// Executes the project-scoped grievance operation through its telemetry index
/// owner.
///
/// # Errors
/// Returns a typed storage, credential, transport, or serialization failure.
pub async fn run(args: GrievancesArgs) -> Result<()> {
	if args.action == GrievanceAction::Clean {
		IssueDeleteSelector { id: args.id.clone(), device: args.tool.clone(), all: args.all }
			.validate()
			.into_diagnostic()?;
	}
	let Some(index) = open_index()? else {
		if args.json {
			match args.action {
				GrievanceAction::List => println!("[]"),
				GrievanceAction::Clean => println!(r#"{{"deleted":0}}"#),
				GrievanceAction::Push => {
					println!(r#"{{"pushed":0,"ok":false,"skipped":true,"reason":"no_db"}}"#)
				},
			}
		} else {
			println!("No grievances database found. AutoQA has not recorded any reports yet.");
		}
		return Ok(());
	};
	match args.action {
		GrievanceAction::List => list(&index, &args),
		GrievanceAction::Clean => clean(&index, &args),
		GrievanceAction::Push => push(&index, args.json).await,
	}
}

fn list(index: &TelemetryIndex, args: &GrievancesArgs) -> Result<()> {
	let findings = index
		.issue_inventory(&IssueInventoryFilter { device: args.tool.clone(), limit: args.limit })
		.into_diagnostic()?;
	if args.json {
		let rows = findings
			.iter()
			.map(|finding| {
				json!({
					"id": finding.issue.id,
					"session": finding.issue.session_id,
					"tool": finding.issue.device,
					"revision": finding.issue.rev,
					"createdAtMs": finding.issue.created_at_ms,
					"uploaded": finding.issue.remote_ack.is_some(),
					"report": omp_observability::autoqa::project_payload(&finding.payload),
				})
			})
			.collect::<Vec<_>>();
		println!("{}", serde_json::to_string_pretty(&rows).into_diagnostic()?);
		return Ok(());
	}
	if findings.is_empty() {
		println!("No grievances recorded yet.");
		return Ok(());
	}
	for finding in &findings {
		let revision = finding.issue.rev.as_deref().unwrap_or("unknown");
		println!("#{} {} (rev {revision})", finding.issue.id, finding.issue.device);
		println!("  {}", omp_observability::autoqa::project_payload(&finding.payload));
		println!();
	}
	if let Some(tool) = args.tool.as_deref() {
		println!("Showing {} most recent for {tool}", findings.len());
	} else {
		println!("Showing {} most recent", findings.len());
	}
	Ok(())
}

fn clean(index: &TelemetryIndex, args: &GrievancesArgs) -> Result<()> {
	let deleted = index
		.delete_issues(&IssueDeleteSelector {
			id:     args.id.clone(),
			device: args.tool.clone(),
			all:    args.all,
		})
		.into_diagnostic()?;
	if args.json {
		println!("{}", json!({ "deleted": deleted }));
	} else if deleted == 0 {
		println!("No matching grievances to delete.");
	} else {
		println!("Deleted {deleted} grievance{}.", if deleted == 1 { "" } else { "s" });
	}
	Ok(())
}

async fn push(index: &TelemetryIndex, json_output: bool) -> Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let credentials = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let authority: Arc<dyn omp_envd::github_url::CredentialAuthority> =
		Arc::new(omp_driver::auth_backend::github_authority(credentials));
	let bridge = GithubCredentialBridge::new();
	bridge
		.bind(authority)
		.map_err(|_| miette!("AutoQA credential authority was already bound"))?;
	let result = omp_driver::telemetry_upload::manual_push(index, &bridge)
		.await
		.into_diagnostic()?;
	if json_output {
		println!("{}", json!({ "pushed": result.pushed, "ok": result.ok }));
	} else if result.ok {
		if result.pushed == 0 {
			println!("Nothing to push — all grievances are already shipped.");
		} else {
			println!(
				"Pushed {} grievance{}.",
				result.pushed,
				if result.pushed == 1 { "" } else { "s" }
			);
		}
	} else {
		return Err(miette!("grievance push failed after {} acknowledgement(s)", result.pushed));
	}
	Ok(())
}

fn open_index() -> Result<Option<TelemetryIndex>> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let project = fs::canonicalize(".").into_diagnostic()?;
	let state_dir = omp_env::project_state::directory(&data_dir, &project).into_diagnostic()?;
	let database = state_dir.join("telemetry.sqlite3");
	if !database.exists() {
		return Ok(None);
	}
	TelemetryIndex::open(&state_dir.join("telemetry"), &database)
		.map(Some)
		.into_diagnostic()
}
