//! Model catalog commands with inference-routed runtime discovery refresh.

use std::{
	collections::{BTreeMap, BTreeSet},
	env, fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_catalog::{DiscoveredModel, ModelSpec, ProviderId, snapshot::Catalog};
use omp_core::Str;
use omp_driver::bridges::{AgentGoalControl, InferenceBridge};
use omp_inference::{
	Client, Registry,
	call::{CallMeta, DiscoveryRequest, Target},
	discovery::{DiscoveryCacheKey, DiscoveryStore},
	id::RequestId,
	receipt::ExecutionBudget,
	router,
};

use crate::cli::{InvocationExtensionMode, LaunchExtensions, ModelRole, ModelsArgs, ModelsCommand};

const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Returns a provider's current account-verified model selectors from the
/// discovery cache. Embedded catalog rows are intentionally excluded.
pub(crate) fn fresh_provider_models(
	data_dir: &Path,
	provider: &ProviderId<str>,
) -> miette::Result<Option<Vec<String>>> {
	let path = data_dir.join("models.db");
	if !path.exists() {
		return Ok(None);
	}
	let store = DiscoveryStore::open(&path).into_diagnostic()?;
	let Some(cached) = store
		.load_fresh(&DiscoveryCacheKey::provider(provider.to_owned()), discovery_now_ms()?)
		.into_diagnostic()?
	else {
		return Ok(None);
	};
	// Cached rows outlive the binary that decoded them. Older Anthropic
	// bootstrap decoders preserved the model identity but did not record the
	// endpoint's implicit Chat capability. Treat those rows as stale so the
	// current decoder can replace them before a caller exposes the selector.
	if provider.as_str() == "anthropic"
		&& cached.rows.iter().any(|row| {
			!discovered_model_supports_chat(row) || row.wire_model.as_str().ends_with("[1m]")
		}) {
		return Ok(None);
	}
	Ok(Some(discovered_selectors(&cached.rows)))
}

/// Discovers and atomically caches the models advertised by a provider's
/// authenticated discovery endpoint. Some providers return only additions to
/// their client-owned base catalog rather than a complete model list.
pub(crate) async fn refresh_provider(
	registry: &Registry,
	data_dir: &Path,
	provider: &ProviderId<str>,
) -> miette::Result<Vec<String>> {
	let routes = provider_discovery_routes(registry.catalog(), provider);
	if routes.is_empty() {
		return Err(miette!("provider `{provider}` does not expose model discovery"));
	}

	let now_ms = discovery_now_ms()?;
	let mut rows = Vec::new();
	for route in routes {
		let planner = router::Router::new(registry.clone(), Duration::from_secs(30));
		let meta = CallMeta {
			id:             RequestId::from(format!("omp-model-refresh-{}", provider.as_str())),
			target:         Target::RouteService(route.clone()),
			deadline:       None,
			budget:         ExecutionBudget::default(),
			session:        None,
			response_hooks: Default::default(),
		};
		let mut cursor = None;
		loop {
			let page = Client::new(registry.service(), planner.clone(), meta.clone())
				.execute(DiscoveryRequest {
					provider:  Some(provider.to_owned()),
					route:     Some(route.clone()),
					cursor:    cursor.clone(),
					page_size: 500,
					operation: None,
				})
				.await
				.map_err(|error| miette!("{provider} model discovery failed: {error}"))?;
			rows.extend(
				page
					.models
					.iter()
					.filter_map(|model| discovered(model, provider, &route, now_ms)),
			);
			cursor = page.next_cursor;
			if cursor.is_none() {
				break;
			}
		}
	}
	if rows.is_empty() {
		return Err(miette!("{provider} model discovery returned no models"));
	}

	fs::create_dir_all(data_dir).into_diagnostic()?;
	DiscoveryStore::open(&data_dir.join("models.db"))
		.into_diagnostic()?
		.publish(
			&DiscoveryCacheKey::provider(provider.to_owned()),
			&rows,
			now_ms,
			DISCOVERY_CACHE_TTL,
		)
		.into_diagnostic()?;
	Ok(discovered_selectors(&rows))
}

fn provider_discovery_routes(
	catalog: &Catalog,
	provider: &ProviderId<str>,
) -> Vec<omp_catalog::RouteId> {
	let mut seen_specs = BTreeSet::new();
	catalog
		.routes()
		.iter()
		.filter(|route| route.provider == *provider)
		.filter_map(|route| {
			let discovery = route.discovery.as_ref()?;
			seen_specs
				.insert(discovery.clone())
				.then(|| route.id.clone())
		})
		.collect()
}

fn discovered_selectors(rows: &[DiscoveredModel]) -> Vec<String> {
	let mut selectors = rows
		.iter()
		.filter(|row| discovered_model_supports_chat(row))
		.map(|row| format!("{}/{}", row.provider, row.wire_model))
		.collect::<Vec<_>>();
	selectors.sort();
	selectors.dedup();
	selectors
}

fn discovered_model_supports_chat(row: &DiscoveredModel) -> bool {
	row.declared_operations
		.contains_kind(omp_catalog::OperationKind::Chat)
		|| row
			.declared_capabilities
			.as_ref()
			.is_some_and(|capabilities| {
				capabilities
					.operations
					.contains_kind(omp_catalog::OperationKind::Chat)
			})
}

fn discovery_now_ms() -> miette::Result<u64> {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_millis()
		.try_into()
		.map_err(|_| miette!("system clock exceeds discovery timestamp range"))
}

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
	launch: &LaunchExtensions,
) -> miette::Result<Arc<Catalog>> {
	let root = fs::canonicalize(env::current_dir().into_diagnostic()?).into_diagnostic()?;
	let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
	let settings = omp_settings::manager::SettingsManager::open(
		omp_settings::manager::SettingsPaths::discover(data_dir, Some(&root)),
	)
	.into_diagnostic()?;
	let settings_snapshot = settings.snapshot();
	let driver_settings = settings_snapshot
		.project::<omp_driver::settings::Settings>()
		.into_diagnostic()?
		.get()
		.clone();
	let model_settings = settings_snapshot
		.project::<omp_catalog::settings::ModelSettings>()
		.into_diagnostic()?
		.get()
		.resolve_path_scopes(&root, &home);
	let disabled = matches!(launch.mode, InvocationExtensionMode::Disabled);
	let extension_scopes = driver_settings
		.extension_scopes(
			omp_driver::settings::workspace_extension_overlay(&root)
				.map_err(|error| miette!("{error}"))?,
		)
		.map_err(|error| miette!("{error}"))?;
	let discovery_settings = omp_driver::discovery::PromptDiscoverySettings {
		model: model_settings,
		skills: settings_snapshot
			.project::<omp_driver::discovery::skills::SkillDiscoverySettings>()
			.into_diagnostic()?
			.get()
			.clone(),
		foreign: settings_snapshot
			.project::<omp_driver::discovery::foreign::ForeignContentSettings>()
			.into_diagnostic()?
			.get()
			.clone(),
		rules: settings_snapshot
			.project::<omp_driver::rulebook::RulebookSettings>()
			.into_diagnostic()?
			.get()
			.clone(),
		native: omp_driver::discovery::native::NativeDiscoveryOptions {
			explicit_roots: if disabled {
				Vec::new()
			} else {
				launch.native_roots.clone()
			},
			root_mode: match launch.mode {
				InvocationExtensionMode::Merge => omp_driver::discovery::native::NativeRootMode::Merge,
				InvocationExtensionMode::ExplicitOnly | InvocationExtensionMode::Disabled => {
					omp_driver::discovery::native::NativeRootMode::ExplicitOnly
				},
			},
			include_workspace: !launch.no_workspace && !disabled,
			client_installed: Some(data_dir.join("ext/installed.toml")),
			workspace_identity: Some(omp_driver::discovery::workspace_identity(&root)),
			..Default::default()
		},
		grants: Some(omp_driver::discovery::ExtensionGrantSettings {
			path:    data_dir.join("ext/grants.toml"),
			session: Arc::from([]),
		}),
		extension_scopes,
		extension_overrides: launch.settings.clone().into(),
	};
	let discovery =
		omp_driver::discovery::active_prompt_snapshots(&root, &[], &home, &discovery_settings);
	let extension_specs = discovery
		.content
		.extensions
		.iter()
		.chain(launch.trusted.iter())
		.cloned()
		.collect::<Vec<_>>();
	let base = omp_driver::registry::production_catalog(data_dir).into_diagnostic()?;
	if extension_specs.is_empty() {
		return Ok(base);
	}
	let state_dir =
		omp_env::project_state::directory(data_dir, &root).map_err(|error| miette!("{error}"))?;
	omp_driver::chat::ensure_state_directory(&state_dir).map_err(|error| miette!("{error}"))?;
	let bridges = omp_driver::bridges::builtin_with_content(
		&root,
		Arc::new(InferenceBridge::default()),
		AgentGoalControl::default(),
		None,
		omp_agent::advisor::AdvisorAdviceQueue::default(),
		&discovery.content,
	);
	let environment =
		omp_envd::ProjectEnvironment::attach(&root, &state_dir, omp_envd::AttachOptions {
			py_eval: false,
			approval_mode: None,
			trusted_extensions: extension_specs,
			contributed_values: launch.contributed.clone(),
			settings: settings_snapshot,
			bridges,
			spawn_idle_timeout: None,
		})
		.await
		.into_diagnostic()?;
	let evidences = environment.extension_registry_evidences();
	let catalog = omp_driver::model_controls::compose_runtime_provider_catalog(
		base.as_ref(),
		evidences
			.iter()
			.flat_map(|evidence| evidence.providers.iter()),
	)
	.into_diagnostic()?;
	Ok(Arc::new(catalog))
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
	for provider in catalog.providers() {
		let provider_routes = provider_discovery_routes(catalog, &provider.id);
		if !provider_routes.is_empty() {
			routes.insert(provider.id.clone(), provider_routes);
		}
	}
	let store = DiscoveryStore::open(&data_dir.join("models.db")).into_diagnostic()?;
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_millis()
		.try_into()
		.map_err(|_| miette!("system clock exceeds discovery timestamp range"))?;
	let mut refreshed = 0_usize;
	let mut failures = Vec::new();
	for (provider, provider_routes) in routes {
		let mut rows = Vec::new();
		for route in provider_routes {
			let planner = router::Router::new(registry.clone(), Duration::from_secs(30));
			let meta = CallMeta {
				id:             RequestId::from(format!("omp-model-refresh-{}", provider.as_str())),
				target:         Target::RouteService(route.clone()),
				deadline:       None,
				budget:         ExecutionBudget::default(),
				session:        None,
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
					Duration::from_secs(24 * 60 * 60),
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
	let mut declared_operations = model.capabilities.operations;
	// The Claude subscription bootstrap endpoint is itself an authoritative
	// list of chat-selectable models. The mixed discovery projector may replace
	// a compact response row with conservative catalog metadata, so retain this
	// endpoint-level fact when materializing the durable cache row.
	if provider.as_str() == "anthropic" {
		declared_operations.insert_kind(omp_catalog::OperationKind::Chat);
	}
	Some(DiscoveredModel {
		provider: provider.to_owned(),
		route: route.to_owned(),
		wire_model,
		aliases: Box::new([]),
		display_name: Some(model.display_name.clone()),
		declared_class: Some(model.class.clone()),
		declared_operations,
		declared_capabilities: Some(model.capabilities.clone()),
		declared_limits: Some(model.limits.clone()),
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

	fn cached_model(provider: &ProviderId<str>) -> DiscoveredModel {
		DiscoveredModel {
			provider:              provider.to_owned(),
			route:                 omp_catalog::RouteId::from("anthropic/primary"),
			wire_model:            omp_catalog::WireModelId::from("claude-fable-5-1[1m]"),
			aliases:               Box::new([]),
			display_name:          Some(Str::new_static("Claude Fable 5.1")),
			declared_class:        None,
			declared_operations:   omp_catalog::OperationBits::empty(),
			declared_capabilities: None,
			declared_limits:       None,
			extended_context_mode: None,
			availability:          None,
			source:                Str::new_static("test"),
			observed_at_ms:        None,
			updated_at_ms:         None,
			deprecated:            None,
		}
	}

	#[test]
	fn anthropic_cache_rows_without_chat_evidence_are_refreshed() {
		let directory = tempfile::tempdir().expect("temporary profile");
		let provider = ProviderId::from("anthropic");
		let store = DiscoveryStore::open(&directory.path().join("models.db")).expect("cache");
		let now_ms = discovery_now_ms().expect("clock");
		let mut row = cached_model(&provider);
		store
			.publish(
				&DiscoveryCacheKey::provider(provider.clone()),
				&[row.clone()],
				now_ms,
				DISCOVERY_CACHE_TTL,
			)
			.expect("stale generation");
		assert_eq!(fresh_provider_models(directory.path(), &provider).expect("stale lookup"), None,);

		row.wire_model = omp_catalog::WireModelId::from("claude-fable-5-1");
		row.declared_operations
			.insert_kind(omp_catalog::OperationKind::Chat);
		store
			.publish(
				&DiscoveryCacheKey::provider(provider.clone()),
				&[row],
				now_ms,
				DISCOVERY_CACHE_TTL,
			)
			.expect("current generation");
		assert_eq!(
			fresh_provider_models(directory.path(), &provider).expect("fresh lookup"),
			Some(vec!["anthropic/claude-fable-5-1".to_owned()]),
		);
	}

	#[test]
	fn anthropic_cache_rows_with_decorated_wire_ids_are_refreshed() {
		let directory = tempfile::tempdir().expect("temporary profile");
		let provider = ProviderId::from("anthropic");
		let store = DiscoveryStore::open(&directory.path().join("models.db")).expect("cache");
		let now_ms = discovery_now_ms().expect("clock");
		let mut row = cached_model(&provider);
		row.declared_operations
			.insert_kind(omp_catalog::OperationKind::Chat);
		store
			.publish(
				&DiscoveryCacheKey::provider(provider.clone()),
				&[row],
				now_ms,
				DISCOVERY_CACHE_TTL,
			)
			.expect("decorated generation");
		assert_eq!(fresh_provider_models(directory.path(), &provider).expect("stale lookup"), None,);
	}

	#[test]
	fn anthropic_cache_projection_retains_endpoint_chat_capability() {
		let catalog = Catalog::embedded();
		let provider = ProviderId::from("anthropic");
		let route = omp_catalog::RouteId::from("anthropic/primary");
		let mut model = catalog
			.model(omp_catalog::ModelKey::from_ref("anthropic/claude-fable-5"))
			.expect("bundled Anthropic model")
			.clone();
		model.capabilities = omp_catalog::unknown_capabilities();
		let row = discovered(&model, &provider, &route, 1).expect("primary route wire id");
		assert!(discovered_model_supports_chat(&row));
	}

	#[test]
	fn provider_discovery_routes_deduplicate_shared_specs() {
		let catalog = Catalog::embedded();
		let routes = provider_discovery_routes(catalog, ProviderId::from_ref("anthropic"));
		assert_eq!(routes, [omp_catalog::RouteId::from("anthropic/primary")]);
	}

	#[test]
	fn finds_a_model_by_case_insensitive_key_or_display_name() {
		let catalog = Catalog::embedded();
		let first = catalog.models().first().expect("embedded model");
		let prefix = &first.key.as_str()[..3.min(first.key.as_str().len())];
		assert!(select(catalog, Some(&prefix.to_ascii_uppercase()), None).contains(&first));
	}
}
