//! Standalone canonical read and web-search tool invocations.

use std::{env, sync::Arc};

use futures::StreamExt as _;
use miette::{IntoDiagnostic as _, miette};
use omp_core::{Str, sf};
use omp_driver::headless::{HeadlessSession, HeadlessSessionOptions};
use omp_settings::manager::{SettingsManager, SettingsPaths};
use omp_tool::{CallOutcome, ErasedEv, ErasedOutcome, Registry};

use crate::cli::{ReadCliArgs, SearchCliArgs};

/// Executes `read@1` and prints precisely the model-visible parts.
pub(crate) async fn read(args: ReadCliArgs) -> miette::Result<()> {
	let session = session().await?;
	let payload: omp_tools::read::Payload = invoke::<_, _, omp_tools::read::Fault>(
		session.tool_registry(),
		"read",
		&omp_tools::read::Params { path: args.path },
	)
	.await?;
	for part in payload.parts {
		match part {
			omp_tools::read::PayloadPart::Text { text } => {
				print!("{text}");
				if !text.ends_with('\n') {
					println!();
				}
			},
			omp_tools::read::PayloadPart::Blob { alt, .. } => println!("{alt}"),
		}
	}
	Ok(())
}

/// Executes `web_search@1` through the production inference facade.
pub(crate) async fn search(args: SearchCliArgs) -> miette::Result<()> {
	let session = session().await?;
	let payload: omp_tools::web_search::Payload = invoke::<_, _, omp_tools::web_search::Fault>(
		session.tool_registry(),
		"web_search",
		&omp_tools::web_search::Params {
			query:              Str::from(args.query.join(" ")),
			recency:            args.recency.map(|recency| match recency {
				crate::cli::SearchRecency::Day => omp_tools::web_search::Recency::Day,
				crate::cli::SearchRecency::Week => omp_tools::web_search::Recency::Week,
				crate::cli::SearchRecency::Month => omp_tools::web_search::Recency::Month,
				crate::cli::SearchRecency::Year => omp_tools::web_search::Recency::Year,
			}),
			limit:              args.limit,
			max_tokens:         None,
			temperature:        None,
			num_search_results: None,
			provider:           args.provider,
		},
	)
	.await?;
	let response = payload.response;
	if !response.answer.is_empty() {
		println!("{}", response.answer);
	}
	for source in response.sources {
		if args.compact {
			println!("{} — {}", source.title, source.url);
		} else {
			println!("\n{}\n{}\n{}", source.title, source.url, source.snippet);
		}
	}
	if !response.warnings.is_empty() {
		tracing::warn!(warning_count = response.warnings.len(), "web search completed with warnings");
	}
	for warning in response.warnings {
		eprintln!("Warning: {warning}");
	}
	Ok(())
}

pub(crate) async fn session() -> miette::Result<HeadlessSession> {
	session_at(None).await
}

pub(crate) async fn session_at(
	project: Option<std::path::PathBuf>,
) -> miette::Result<HeadlessSession> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let project = project
		.map_or_else(env::current_dir, Ok)
		.into_diagnostic()?
		.canonicalize()
		.into_diagnostic()?;
	let home = env::var_os("HOME").map_or_else(|| project.clone(), std::path::PathBuf::from);
	let settings_manager = SettingsManager::open(SettingsPaths::discover(&data_dir, Some(&project)))
		.into_diagnostic()?;
	let settings_snapshot = settings_manager.snapshot();
	let model_settings = settings_snapshot
		.project::<omp_catalog::settings::ModelSettings>()
		.into_diagnostic()?
		.get()
		.resolve_path_scopes(&project, &home);
	let catalog = omp_driver::registry::production_catalog(&data_dir).into_diagnostic()?;
	let roles = omp_driver::discovery::roles::resolve_launch_roles(
		catalog.as_ref(),
		&model_settings,
		None,
		None,
		None,
		None,
	)
	.map_err(|error| miette!(error))?;
	let model = roles
		.primary
		.map(|model| Str::from(model.as_str()))
		.ok_or_else(|| miette!("standalone tools require a configured default model role"))?;
	HeadlessSession::open(data_dir, HeadlessSessionOptions {
		project,
		settings_overlays: Box::default(),
		additional_roots: Box::default(),
		model,
		initial_regime: None,
		initial_prompt_slot: None,
		plan_handoff: None,
		resume: None,
		fork: None,
		py_eval: false,
		approval_mode: None,
		spawn_idle_timeout: None,
		pty_denied: true,
		credential_provider: None,
		api_key: None,
		prompt_cache_affinity: None,
		account_pins: None,
		session_generation: 1,
	})
	.await
	.into_diagnostic()
}

trait StandaloneFault {
	fn model_message(&self) -> Str;
}

impl StandaloneFault for omp_tools::read::Fault {
	fn model_message(&self) -> Str {
		self.message().clone()
	}
}

impl StandaloneFault for omp_tools::web_search::Fault {
	fn model_message(&self) -> Str {
		Str::from(self.to_string())
	}
}

async fn invoke<P, O, F>(registry: Arc<Registry>, name: &str, params: &P) -> miette::Result<O>
where
	P: serde::Serialize,
	O: serde::de::DeserializeOwned,
	F: serde::de::DeserializeOwned + StandaloneFault,
{
	let raw = serde_json::to_string(params).into_diagnostic()?;
	let (feed, incoming) = omp_tool::IncomingParams::owned_channel(sf!("standalone-cli"));
	feed.args_committed(Str::from(raw)).into_diagnostic()?;
	drop(feed);
	let mut stream = registry.invoke(name, incoming).into_diagnostic()?;
	while let Some(event) = stream.next().await {
		match event.into_diagnostic()? {
			ErasedEv::Update(_) => {},
			ErasedEv::Done(ErasedOutcome::Detached(_)) => {
				return Err(miette!("{name} detached unexpectedly"));
			},
			ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) => {
				return match serde_json::from_slice::<CallOutcome<O, F>>(&verdict).into_diagnostic()? {
					CallOutcome::Ok(payload) => Ok(payload),
					CallOutcome::Faulted(fault) => Err(miette!("{}", fault.model_message())),
					CallOutcome::ArgsRejected(issues) => {
						Err(miette!("invalid {name} arguments: {issues:?}"))
					},
					CallOutcome::Aborted { .. } => Err(miette!("{name} was aborted")),
				};
			},
		}
	}
	Err(miette!("{name} ended without a result"))
}
