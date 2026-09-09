//! Model catalog commands with inference-routed runtime discovery refresh.

use std::{
	collections::BTreeMap,
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::{
	Client,
	call::{CallMeta, DiscoveryRequest, Target},
	discovery::{DiscoveryCacheKey, DiscoveryStore, ProviderDiscoveryState, ProviderLifecycle},
	id::RequestId,
	receipt::ExecutionBudget,
	router,
};
use omp_catalog::{DiscoveredModel, ModelSpec, OperationBits, ProviderId, snapshot::Catalog};
use omp_core::Str;

use crate::cli::{LaunchExtensions, ModelRole, ModelsArgs, ModelsCommand};

const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(2 * 60 * 60);

/// Runs a model catalog operation. Refresh travels through the same inference
/// routes and credentials used at call time, then atomically updates only the
/// runtime discovery cache.
pub async fn run(args: &ModelsArgs, extensions: &LaunchExtensions) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let catalog = composed_catalog(&data_dir, extensions).await?;
	match args.command.as_ref() {
		None => print_rows(&select(catalog.as_ref(), args.filter.as_deref(), args.role), args.json),
		Some(ModelsCommand::List { filter, json, role }) => {
			print_rows(&select(catalog.as_ref(), filter.as_deref(), *role), *json)
		},
		Some(ModelsCommand::Find { pattern, json }) => {
			print_rows(&select(catalog.as_ref(), Some(pattern), None), *json)
		},
		Some(ModelsCommand::Refresh) => refresh().await,
	}
}

async fn composed_catalog(
	data_dir: &Path,
	_launch: &LaunchExtensions,
) -> miette::Result<Arc<Catalog>> {
	omp_driver::registry::production_catalog(data_dir).into_diagnostic()
}

async fn refresh() -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	fs::create_dir_all(&data_dir).into_diagnostic()?;
	let credentials = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let registry = omp_driver::registry::production_registry(&data_dir, credentials)
		.await
		.into_diagnostic()?;
	let catalog = registry.catalog();
	let mut routes = BTreeMap::<ProviderId, Vec<_>>::new();
	for route in catalog
		.routes()
		.iter()
		.filter(|route| route.discovery.is_some())
	{
		routes
			.entry(route.provider.clone())
			.or_default()
			.push(route.id.clone());
	}
	let store = DiscoveryStore::open(&data_dir.join("models.db")).into_diagnostic()?;
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_millis()
		.try_into()
		.map_err(|_| miette!("system clock exceeds discovery timestamp range"))?;
	store.prune_expired(now_ms).into_diagnostic()?;
	let loaded_config =
		omp_driver::discovery::models::load_or_import_legacy(&data_dir).into_diagnostic()?;
	let mut refreshed = refresh_local_providers(
		&store,
		catalog,
		loaded_config.as_ref().map(|loaded| &loaded.config),
		now_ms,
	)
	.await?;
	let mut failures = Vec::new();
	for (provider, provider_routes) in routes {
		let mut rows = Vec::new();
		for route in provider_routes {
			let planner = router::Router::new(registry.clone(), Duration::from_secs(30));
			let meta = CallMeta {
				id:             RequestId::from(format!("omp-model-refresh-{}", provider.as_str())),
				target:         Target::ProviderService(provider.clone()),
				deadline:       None,
				budget:         ExecutionBudget::default(),
				session:        None,
				debug_session:  None,
				response_hooks: Default::default(),
			};
			let mut cursor = None;
			loop {
				let page = Client::new(registry.service(), planner.clone(), meta.clone())
					.execute(DiscoveryRequest {
						provider:  Some(provider.clone()),
						route:     Some(route.clone()),
						cursor:    cursor.clone(),
						page_size: 500,
						operation: None,
					})
					.await;
				let page = match page {
					Ok(page) => page,
					Err(error) => {
						tracing::warn!(
							provider = %provider,
							route = %route,
							%error,
							"model discovery refresh failed"
						);
						failures.push(format!("{}: {error}", provider.as_str()));
						break;
					},
				};
				rows.extend(
					page
						.models
						.iter()
						.filter_map(|model| discovered(model, &provider, &route, now_ms)),
				);
				cursor = page.next_cursor;
				if cursor.is_none() {
					break;
				}
			}
		}
		if !rows.is_empty() {
			store
				.publish(
					&DiscoveryCacheKey::provider(provider.clone()),
					&rows,
					now_ms,
					DISCOVERY_CACHE_TTL,
				)
				.into_diagnostic()?;
			refreshed = refreshed.saturating_add(rows.len());
		}
	}
	for failure in failures {
		eprintln!("warning: discovery refresh failed for {failure}");
	}
	println!("refreshed {refreshed} runtime model row(s); configured catalog models remain visible");
	Ok(())
}

async fn refresh_local_providers(
	store: &DiscoveryStore,
	catalog: &Catalog,
	config: Option<&omp_driver::discovery::models::ModelsConfig>,
	now_ms: u64,
) -> miette::Result<usize> {
	let probes =
		omp_driver::discovery::models::discovery_probes(config, catalog).into_diagnostic()?;
	let http = omp_envd::model_discovery::ModelDiscoveryHttpHost::new();
	let mut refreshed = 0_usize;
	for probe in probes {
		let provider = probe.provider.clone();
		let key = DiscoveryCacheKey::endpoint(provider.clone(), &probe.endpoint);
		store
			.set_lifecycle(&ProviderLifecycle {
				provider:       provider.clone(),
				cache_scope:    key.credential_scope.clone(),
				state:          ProviderDiscoveryState::Probing,
				error_code:     None,
				observed_at_ms: now_ms,
				retry_at_ms:    None,
			})
			.into_diagnostic()?;
		match probe
			.probe(&http, tokio_util::sync::CancellationToken::new())
			.await
		{
			Ok(mut rows) => {
				omp_driver::discovery::models::apply_runtime_discovery_overrides(&probe, &mut rows);
				for row in &mut rows {
					row.observed_at_ms = Some(now_ms);
				}
				store
					.publish(&key, &rows, now_ms, DISCOVERY_CACHE_TTL)
					.into_diagnostic()?;
				refreshed = refreshed.saturating_add(rows.len());
			},
			Err(error) => {
				let error_code: &'static str = error.into();
				store
					.set_lifecycle(&ProviderLifecycle {
						provider:       provider.clone(),
						cache_scope:    key.credential_scope.clone(),
						state:          ProviderDiscoveryState::Failed,
						error_code:     Some(Str::new_static(error_code)),
						observed_at_ms: now_ms,
						retry_at_ms:    Some(now_ms.saturating_add(5 * 60 * 1000)),
					})
					.into_diagnostic()?;
				eprintln!("warning: local model discovery failed for {}: {error}", provider.as_str());
			},
		}
	}
	Ok(refreshed)
}

fn discovered(
	model: &ModelSpec,
	provider: &ProviderId<str>,
	route: &omp_catalog::RouteId<str>,
	now_ms: u64,
) -> Option<DiscoveredModel> {
	let wire_model = model
		.wire_ids
		.iter()
		.find_map(|(candidate, wire)| (candidate == route).then(|| wire.clone()))?;
	Some(DiscoveredModel {
		provider: provider.to_owned(),
		route: route.to_owned(),
		wire_model,
		aliases: Box::new([]),
		display_name: Some(model.display_name.clone()),
		declared_class: Some(model.class.clone()),
		declared_operations: OperationBits::empty(),
		declared_capabilities: Some(model.capabilities.clone()),
		declared_limits: Some(model.limits.clone()),
		declared_pricing: Box::new([]),
		extended_context_mode: None,
		availability: Some(model.availability.clone()),
		source: Str::new_static("runtime-inference-discovery"),
		observed_at_ms: Some(now_ms),
		updated_at_ms: None,
		deprecated: None,
	})
}

fn select<'a>(
	catalog: &'a Catalog,
	filter: Option<&str>,
	role: Option<ModelRole>,
) -> Vec<&'a ModelSpec> {
	let needle = filter.unwrap_or_default().to_ascii_lowercase();
	let mut rows = catalog
		.models()
		.iter()
		.filter(|model| {
			needle.is_empty()
				|| model.key.as_str().to_ascii_lowercase().contains(&needle)
				|| model
					.display_name
					.as_str()
					.to_ascii_lowercase()
					.contains(&needle)
				|| model
					.routes
					.iter()
					.filter_map(|id| catalog.routes().iter().find(|route| route.id == *id))
					.any(|route| {
						route
							.provider
							.as_str()
							.to_ascii_lowercase()
							.contains(&needle)
					})
		})
		.collect::<Vec<_>>();
	if let Some(role) = role {
		let index = match role {
			ModelRole::Primary => 0,
			ModelRole::Smol => 1,
			ModelRole::Slow => 2,
			ModelRole::Plan => 3,
		};
		rows = rows
			.get(index % rows.len().max(1))
			.into_iter()
			.copied()
			.collect();
	}
	rows
}

fn print_rows(rows: &[&ModelSpec], json: bool) -> miette::Result<()> {
	if json {
		println!("{}", serde_json::to_string_pretty(rows).into_diagnostic()?);
		return Ok(());
	}
	for model in rows {
		println!(
			"{}\t{}\tcontext={}\tmax_output={}\tthinking={}",
			model.key,
			model.display_name,
			model
				.limits
				.context_window
				.map_or_else(|| "?".into(), |value| value.to_string()),
			model
				.limits
				.maximum_output_tokens
				.map_or_else(|| "?".into(), |value| value.to_string()),
			model.thinking.as_ref().map_or("no", |_| "yes")
		);
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn finds_a_model_by_case_insensitive_key_or_display_name() {
		let catalog = Catalog::embedded();
		let first = catalog.models().first().expect("embedded model");
		let prefix = &first.key.as_str()[..3.min(first.key.as_str().len())];
		assert!(select(catalog, Some(&prefix.to_ascii_uppercase()), None).contains(&first));
	}
}
