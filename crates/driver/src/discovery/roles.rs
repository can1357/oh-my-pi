//! Durable project-scoped model-role assignments.

use std::env;

use omp_catalog::{
	ModelKey, ModelRole, SelectedModel, SelectionError, select_model, settings::ModelSettings,
	snapshot::Catalog,
};
use omp_core::Str;
/// Invocation-local resolved model roles after CLI-over-environment precedence.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LaunchRoles {
	/// Primary model when explicitly overridden.
	pub primary:       Option<ModelKey>,
	/// Fast/low-cost model.
	pub smol:          Option<ModelKey>,
	/// Deep-reasoning model.
	pub slow:          Option<ModelKey>,
	/// Planning model.
	pub plan:          Option<ModelKey>,
	/// Planning selector's explicit thinking annotation.
	pub plan_thinking: Option<Str>,
}

/// Resolves role selectors through the catalog authority. CLI values override
/// `OMP_*_MODEL`; unsupported thinking annotations are rejected by catalog
/// selection rather than clamped client-side.
pub fn resolve_launch_roles(
	catalog: &Catalog,
	settings: &ModelSettings,
	primary: Option<&str>,
	smol: Option<&str>,
	slow: Option<&str>,
	plan: Option<&str>,
) -> Result<LaunchRoles, SelectionError> {
	let configured_roles = configured_roles(settings)?;
	let models = eligible_models(catalog, settings, None);
	let resolve_selected = |cli: Option<&str>, variable: &str, role: &str| {
		let environment = env::var(variable).ok();
		let Some(selector) = cli
			.or(environment.as_deref())
			.or_else(|| settings.role_selector(role).map(Str::as_str))
		else {
			return Ok(None);
		};
		select_model(
			&models,
			catalog.routes(),
			catalog.aliases(),
			&configured_roles,
			&Default::default(),
			selector,
		)
		.map(Some)
	};
	let primary = resolve_selected(primary, "OMP_DEFAULT_MODEL", "default")?;
	let smol = resolve_selected(smol, "OMP_SMOL_MODEL", "smol")?;
	let slow = resolve_selected(slow, "OMP_SLOW_MODEL", "slow")?;
	let plan = resolve_selected(plan, "OMP_PLAN_MODEL", "plan")?;
	Ok(LaunchRoles {
		primary:       primary.map(|selected| selected.model),
		smol:          smol.map(|selected| selected.model),
		slow:          slow.map(|selected| selected.model),
		plan_thinking: plan.as_ref().and_then(|selected| selected.thinking.clone()),
		plan:          plan.map(|selected| selected.model),
	})
}
/// Resolves one explicit role selector through the catalog authority with no
/// environment fallback (e.g. `--plan-yolo-into`, `--prewalk-into`).
pub fn resolve_role_selector(
	catalog: &Catalog,
	settings: &ModelSettings,
	selector: &str,
) -> Result<SelectedModel, SelectionError> {
	let roles = configured_roles(settings)?;
	let models = eligible_models(catalog, settings, None);
	select_model(&models, catalog.routes(), catalog.aliases(), &roles, &Default::default(), selector)
}

fn configured_roles(settings: &ModelSettings) -> Result<Vec<ModelRole>, SelectionError> {
	let mut roles = settings
		.roles
		.iter()
		.map(|(id, selector)| {
			let mut role = ModelRole::assignment(id.clone(), selector.as_str(), None)?;
			if let Some(tag) = settings.role_tag(id) {
				role.display_name = Some(tag.name.clone());
				role.color = tag.color.clone();
				role.hidden = tag.hidden;
			}
			role.cycle_order = settings
				.cycle_order
				.iter()
				.position(|candidate| candidate == id)
				.and_then(|index| u32::try_from(index).ok());
			role.provider_rank = settings
				.provider_order
				.iter()
				.cloned()
				.map(omp_catalog::ProviderId::from)
				.collect::<Vec<_>>()
				.into_boxed_slice();
			Ok(role)
		})
		.collect::<Result<Vec<_>, SelectionError>>()?;
	roles = omp_catalog::known_roles(&roles);
	Ok(roles)
}

/// Reports whether one concrete selector remains inside configured model and
/// provider admission.
pub fn model_selector_allowed(catalog: &Catalog, settings: &ModelSettings, selector: &str) -> bool {
	model_selector_allowed_for_provider(catalog, settings, selector, None)
}

/// Reports whether one concrete selector remains inside configured admission
/// on an optional credential-pinned provider route.
pub fn model_selector_allowed_for_provider(
	catalog: &Catalog,
	settings: &ModelSettings,
	selector: &str,
	credential_provider: Option<&omp_catalog::ProviderId>,
) -> bool {
	catalog
		.model(ModelKey::from_ref(selector))
		.or_else(|| catalog.resolve_alias(selector))
		.is_some_and(|model| {
			model.routes.iter().any(|route_id| {
				catalog.route(route_id).is_some_and(|route| {
					let model_id = model
						.key
						.as_str()
						.split_once('/')
						.map_or(model.key.as_str(), |(_, model)| model);
					credential_route_allowed(settings, &route.provider, model_id, credential_provider)
				})
			})
		})
}

/// Chooses the deterministic allowed fallback model, optionally constrained to
/// a provider.
pub fn fallback_model_selector(
	catalog: &Catalog,
	settings: &ModelSettings,
	credential_provider: Option<&omp_catalog::ProviderId>,
) -> Option<Str> {
	let models = eligible_models(catalog, settings, credential_provider);
	let mru = Default::default();
	omp_catalog::find_smol(&models, catalog.routes(), &mru)
		.or_else(|| omp_catalog::pick_default(&models, catalog.routes(), &mru))
		.map(|selected| Str::new(selected.model.as_str()))
}

fn credential_route_allowed(
	settings: &ModelSettings,
	route_provider: &omp_catalog::ProviderId,
	model_id: &str,
	credential_provider: Option<&omp_catalog::ProviderId>,
) -> bool {
	settings.model_allowed(route_provider.as_str(), model_id)
		&& credential_provider.is_none_or(|provider| route_provider == provider)
}

fn eligible_models(
	catalog: &Catalog,
	settings: &ModelSettings,
	credential_provider: Option<&omp_catalog::ProviderId>,
) -> Vec<omp_catalog::ModelSpec> {
	catalog
		.models()
		.iter()
		.filter(|model| {
			model.routes.iter().any(|route_id| {
				catalog.route(route_id).is_some_and(|route| {
					let model_id = model
						.key
						.as_str()
						.split_once('/')
						.map_or(model.key.as_str(), |(_, model)| model);
					credential_route_allowed(settings, &route.provider, model_id, credential_provider)
				})
			})
		})
		.cloned()
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn explicit_auto_survives_role_snapshot_codec() {
		let roles = vec![
			ModelRole::assignment("default", "openai/primary", Some("high")).expect("default role"),
			ModelRole::assignment("task", "openai-codex/worker", Some("auto")).expect("task role"),
		];
		let encoded = serde_json::to_vec(&roles).expect("encode role snapshot");
		let decoded: Vec<ModelRole> = serde_json::from_slice(&encoded).expect("decode role snapshot");
		assert_eq!(decoded, roles);
		assert_eq!(decoded[1].selectors[0].as_str(), "openai-codex/worker:auto");
	}
	#[test]
	fn configured_role_and_model_admission_drive_launch_resolution() {
		let catalog = omp_catalog::snapshot::Catalog::try_embedded().expect("catalog");
		let model = catalog.models().first().expect("model");
		let mut settings = ModelSettings::default();
		settings
			.roles
			.insert(Str::new_static("default"), Str::new(model.key.as_str()));
		let launch = resolve_launch_roles(catalog, &settings, None, None, None, None).expect("roles");
		assert_eq!(launch.primary.as_ref(), Some(&model.key));
		let provider = catalog
			.route(model.routes.first().expect("route"))
			.expect("route")
			.provider
			.clone();
		settings.disabled_providers =
			[omp_catalog::settings::PathScopedStringEntry::Bare(Str::new(provider.as_str()))].into();
		assert!(resolve_launch_roles(catalog, &settings, None, None, None, None).is_err(),);
	}

	#[test]
	fn credential_pinned_eligibility_requires_an_allowed_provider_route() {
		let allowed_provider = omp_catalog::ProviderId::new("allowed");
		let denied_provider = omp_catalog::ProviderId::new("denied");
		let mut settings = ModelSettings::default();
		settings.enabled_models =
			[omp_catalog::settings::PathScopedStringEntry::Bare(Str::new_static("allowed/example"))]
				.into();

		assert!(credential_route_allowed(
			&settings,
			&allowed_provider,
			"example",
			Some(&allowed_provider),
		));
		assert!(!credential_route_allowed(
			&settings,
			&denied_provider,
			"example",
			Some(&denied_provider),
		));
		assert!(!credential_route_allowed(
			&settings,
			&allowed_provider,
			"example",
			Some(&denied_provider),
		));
	}

	#[test]
	fn configured_role_aliases_reach_recursive_catalog_resolution() {
		let catalog = omp_catalog::snapshot::Catalog::try_embedded().expect("catalog");
		let mut settings = ModelSettings::default();
		settings
			.roles
			.insert(Str::new_static("task"), Str::new_static("@slow"));
		settings
			.roles
			.insert(Str::new_static("default"), Str::new_static("@task"));
		let launch =
			resolve_launch_roles(catalog, &settings, None, None, None, None).expect("aliased roles");
		assert!(launch.primary.is_some());
	}
}
