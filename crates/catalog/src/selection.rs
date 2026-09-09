//! Human-facing model selector parsing and deterministic catalog matching.
//!
//! This module deliberately sits above [`crate::resolve`]: it turns a user's
//! loose selector into an exact provider/model pair, then the constraint
//! resolver remains the only authority that makes a route usable.

use std::{
	cmp,
	collections::{BTreeMap, BTreeSet},
};

use globset::{GlobBuilder, GlobMatcher};
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
	Availability, CatalogAlias, ModelAvailability, ModelKey, ModelSpec, ProviderId, RouteDef,
	RouteId, settings::FallbackChains,
};

/// A configured or built-in role that expands to an ordered selector chain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelRole {
	/// Stable role identifier without its leading `@`.
	pub id:            Str,
	/// Ordered selectors; the first usable match wins.
	pub selectors:     Box<[Str]>,
	/// Picker display label.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub display_name:  Option<Str>,
	/// Picker color token.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub color:         Option<Str>,
	/// Whether picker listings hide this role. Direct selectors remain valid.
	#[serde(default)]
	pub hidden:        bool,
	/// Stable picker/cycle order. Roles without an explicit order sort after it.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cycle_order:   Option<u32>,
	/// Provider preference applied while ranking this role's candidates.
	#[serde(default)]
	pub provider_rank: Box<[ProviderId]>,
}
impl ModelRole {
	/// Creates an ordered role assignment from a comma-separated selector
	/// chain with an optional explicit thinking level.
	///
	/// Empty comma-separated elements are ignored. `auto` is retained on every
	/// selector in the chain, keeping role configuration independent from an
	/// active session's thinking state.
	pub fn assignment(
		id: impl Into<Str>,
		selector: &str,
		thinking: Option<&str>,
	) -> Result<Self, SelectionError> {
		let id = id.into();
		if !valid_role_id(&id) {
			return Err(SelectionError::Invalid(id));
		}
		let selectors = selector
			.split(',')
			.map(str::trim)
			.filter(|selector| !selector.is_empty())
			.map(|selector| role_assignment_selector(selector, thinking))
			.collect::<Result<Vec<_>, _>>()?;
		if selectors.is_empty() {
			return Err(SelectionError::Empty);
		}
		Ok(Self {
			id,
			selectors: selectors.into_boxed_slice(),
			display_name: None,
			color: None,
			hidden: false,
			cycle_order: None,
			provider_rank: Box::new([]),
		})
	}
}

/// Formats one persisted role selector with an explicit thinking annotation.
///
/// A route annotation and thinking annotation cannot both occupy the selector
/// suffix, so attempting to add thinking to a route-qualified selector fails
/// rather than silently discarding either choice.
pub fn role_assignment_selector(
	selector: &str,
	thinking: Option<&str>,
) -> Result<Str, SelectionError> {
	let selector = selector.trim();
	if let Some((_, configured_thinking)) = role_reference(selector)? {
		let thinking = thinking.or(configured_thinking);
		return Ok(match thinking {
			Some(thinking) => sf!(
				"{}:{thinking}",
				&selector[..selector.len() - configured_thinking.map_or(0, |level| level.len() + 1)]
			),
			None => Str::new(selector),
		});
	}
	let parsed = parse_selector(selector)?;
	let Some(thinking) = thinking else {
		return Ok(Str::new(selector));
	};
	if !is_thinking_level(thinking) || parsed.route.is_some() {
		return Err(SelectionError::Invalid(Str::new(selector)));
	}
	let mut formatted = String::with_capacity(
		parsed.model.len()
			+ thinking.len()
			+ parsed
				.upstream
				.as_ref()
				.map_or(1, |upstream| upstream.len().saturating_add(2)),
	);
	formatted.push_str(&parsed.model);
	formatted.push(':');
	formatted.push_str(thinking);
	if let Some(upstream) = parsed.upstream {
		formatted.push('@');
		formatted.push_str(&upstream);
	}
	Ok(formatted.into())
}

fn valid_role_id(id: &str) -> bool {
	let mut chars = id.chars();
	chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
		&& chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn role_reference(selector: &str) -> Result<Option<(&str, Option<&str>)>, SelectionError> {
	let Some(reference) = selector.strip_prefix('@') else {
		return Ok(None);
	};
	if reference.contains('/') {
		return Ok(None);
	}
	let (role, thinking) = match reference.rsplit_once(':') {
		Some((role, thinking)) if is_thinking_level(thinking) => (role, Some(thinking)),
		Some(_) => return Err(SelectionError::Invalid(Str::new(selector))),
		None => (reference, None),
	};
	if !valid_role_id(role) {
		return Err(SelectionError::Invalid(Str::new(selector)));
	}
	Ok(Some((role, thinking)))
}

/// Inserts or replaces one role assignment, returning whether it changed.
///
/// This updates configuration data only. In particular, updating a
/// non-default role never mutates an active session model or thinking level.
pub fn upsert_role_assignment(
	roles: &mut Vec<ModelRole>,
	id: impl Into<Str>,
	selector: &str,
	thinking: Option<&str>,
) -> Result<bool, SelectionError> {
	let replacement = ModelRole::assignment(id, selector, thinking)?;
	if let Some(existing) = roles.iter_mut().find(|role| role.id == replacement.id) {
		if *existing == replacement {
			return Ok(false);
		}
		*existing = replacement;
		return Ok(true);
	}
	roles.push(replacement);
	Ok(true)
}

/// The built-in role vocabulary.  Values remain user-configurable; these ids
/// are the stable public contract used by selectors and persisted settings.
pub const BUILTIN_ROLE_IDS: &[&str] = &[
	"default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "memory", "task",
	"advisor",
];

/// Parsed, syntax-only model selector annotations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedSelector {
	/// Model spelling before annotations.
	pub model:    Str,
	/// Optional upstream provider/routing target.
	pub upstream: Option<Str>,
	/// Optional thinking level.
	pub thinking: Option<Str>,
	/// Optional explicit route identifier.
	pub route:    Option<RouteId>,
}

/// Exact catalog identity with annotations retained for the request planner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedModel {
	/// Provider owning the selected route.
	pub provider: ProviderId,
	/// Canonical normalized model key.
	pub model:    ModelKey,
	/// Requested upstream routing annotation.
	pub upstream: Option<Str>,
	/// Requested thinking level.
	pub thinking: Option<Str>,
	/// Route requested by the selector, if any.
	pub route:    Option<RouteId>,
}

/// Why an ordered selector candidate exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CandidateProvenance {
	/// A concrete catalog model matched the selector.
	Catalog,
	/// An exact configured selector has no discovery/catalog row yet.
	ConfiguredDeclared,
}

/// One credential-blind ordered candidate. Authentication is deliberately
/// deferred to inference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionCandidate {
	/// Selector retained exactly enough to avoid mutating a durable pin.
	pub selector:   Str,
	/// Concrete catalog selection, absent for a configured-but-undiscovered
	/// declaration.
	pub selected:   Option<SelectedModel>,
	/// Availability provenance.
	pub provenance: CandidateProvenance,
}

/// A compiled path-scoped `enabledModels` allowlist.
#[derive(Clone, Debug)]
pub struct ModelScope {
	patterns: Box<[(Str, GlobMatcher)]>,
}

impl ModelScope {
	/// Compiles case-insensitive glob patterns once. Patterns match both full
	/// provider/model selectors and bare logical model ids.
	pub fn compile(patterns: &[Str]) -> Result<Self, SelectionError> {
		let mut compiled = Vec::with_capacity(patterns.len());
		for pattern in patterns
			.iter()
			.flat_map(|chain| chain.as_str().split(','))
			.map(str::trim)
			.filter(|pattern| !pattern.is_empty())
		{
			let base = scope_pattern_base(pattern);
			let glob = GlobBuilder::new(base)
				.case_insensitive(true)
				.literal_separator(false)
				.build()
				.map_err(|_| SelectionError::Invalid(Str::new(pattern)))?;
			compiled.push((Str::new(base), glob.compile_matcher()));
		}
		Ok(Self { patterns: compiled.into_boxed_slice() })
	}

	/// Reports whether a full provider/model identity is enabled.
	pub fn allows(&self, provider: &ProviderId<str>, model: &ModelKey<str>) -> bool {
		if self.patterns.is_empty() {
			return true;
		}
		let bare = logical_id(model);
		self.patterns.iter().any(|(_, pattern)| {
			pattern.is_match(bare) || pattern.is_match(format!("{provider}/{bare}"))
		})
	}

	fn allows_selected(
		&self,
		models: &[ModelSpec],
		routes: &[RouteDef],
		aliases: &[CatalogAlias],
		roles: &[ModelRole],
		mru: &BTreeMap<(ProviderId, ModelKey), u64>,
		selected: &SelectedModel,
	) -> bool {
		if self.patterns.is_empty() {
			return true;
		}
		self.patterns.iter().any(|(source, pattern)| {
			if contains_glob_meta(source) {
				return pattern.is_match(logical_id(&selected.model))
					|| pattern.is_match(format!(
						"{}/{}",
						selected.provider,
						logical_id(&selected.model)
					));
			}
			select_model(models, routes, aliases, roles, mru, source).is_ok_and(|allowed| {
				allowed.provider == selected.provider && allowed.model == selected.model
			})
		})
	}

	/// Returns configured patterns that did not match a concrete model. Exact
	/// provider/model declarations remain selectable and fail only when
	/// invoked.
	pub fn synthetic_declarations(&self, models: &[ModelSpec], routes: &[RouteDef]) -> Vec<Str> {
		self
			.patterns
			.iter()
			.filter(|(source, _)| !contains_glob_meta(source) && source.contains('/'))
			.filter(|(_, pattern)| {
				!models.iter().any(|model| {
					model.routes.iter().any(|route| {
						routes
							.iter()
							.find(|candidate| candidate.id == *route)
							.is_some_and(|route| {
								pattern.is_match(format!("{}/{}", route.provider, logical_id(&model.key)))
							})
					})
				})
			})
			.map(|(source, _)| source.clone())
			.collect()
	}
}

/// Initial-selection inputs, already collected by the CLI/settings boundary.
#[derive(Clone, Copy, Debug, Default)]
pub struct InitialModel<'a> {
	/// `--model` value.
	pub cli_model:    Option<&'a str>,
	/// `--provider` value, applied to an otherwise bare CLI model.
	pub cli_provider: Option<&'a str>,
	/// Persisted default-model setting.
	pub setting:      Option<&'a str>,
	/// `OMP_DEFAULT_MODEL`, then `OMP_MODEL` in that order.
	pub environment:  &'a [Option<&'a str>],
}

/// Selection failures are precise enough for a caller to render a useful
/// picker/error without guessing a fallback.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SelectionError {
	/// A selector has no model portion.
	#[error("model selector is empty")]
	Empty,
	/// Annotation syntax is malformed or duplicated.
	#[error("invalid model selector `{0}`")]
	Invalid(Str),
	/// A role points back to itself through one or more configured roles.
	#[error("model role cycle at @{0}")]
	RoleCycle(Str),
	/// No role with this id is configured or built in.
	#[error("unknown model role @{0}")]
	UnknownRole(Str),
	/// No available model matches the requested selector.
	#[error("unknown model `{0}`")]
	NotFound(Str),
}

/// Parses `:level`, `:route`, and `@upstream` annotations without looking up a
/// catalog. `:max` and `:auto` remain ordinary model text until the caller
/// confirms they are not literal model ids.
pub fn parse_selector(input: &str) -> Result<ParsedSelector, SelectionError> {
	let input = input.trim();
	if input.is_empty() {
		return Err(SelectionError::Empty);
	}
	let (before_upstream, upstream) = split_upstream(input)?;
	let (model, suffix) = before_upstream
		.rsplit_once(':')
		.unwrap_or((before_upstream, ""));
	if model.is_empty() || model.ends_with(':') {
		return Err(SelectionError::Invalid(Str::new(input)));
	}
	let mut parsed =
		ParsedSelector { model: Str::new(model), upstream, thinking: None, route: None };
	if !suffix.is_empty() {
		if is_thinking_level(suffix) {
			parsed.thinking = Some(Str::new(suffix));
		} else if suffix
			.chars()
			.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
		{
			parsed.route = Some(RouteId::new(suffix));
		} else {
			return Err(SelectionError::Invalid(Str::new(input)));
		}
	} else if before_upstream.ends_with(':') {
		return Err(SelectionError::Invalid(Str::new(input)));
	}
	Ok(parsed)
}

fn split_upstream(input: &str) -> Result<(&str, Option<Str>), SelectionError> {
	if let Some(rest) = input.strip_prefix('@') {
		let (upstream, model) = rest
			.split_once('/')
			.ok_or_else(|| SelectionError::Invalid(Str::new(input)))?;
		if upstream.is_empty() || model.is_empty() || model.contains('@') {
			return Err(SelectionError::Invalid(Str::new(input)));
		}
		return Ok((model, Some(Str::new(upstream))));
	}
	match input.rsplit_once('@') {
		None => Ok((input, None)),
		Some((model, upstream))
			if !model.is_empty() && !upstream.is_empty() && !upstream.contains('/') =>
		{
			Ok((model, Some(Str::new(upstream))))
		},
		Some(_) => Err(SelectionError::Invalid(Str::new(input))),
	}
}

/// Matches a selector by the ordered cascade: exact provider/id, bare id,
/// alias, provider-scoped fuzzy match, then substring.
///
/// Ambiguity is ranked by MRU, route priority, and canonical identity, never
/// iteration order.
pub fn select_model(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	roles: &[ModelRole],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	selector: &str,
) -> Result<SelectedModel, SelectionError> {
	select_inner(models, routes, aliases, roles, mru, selector, &mut BTreeSet::new())
}

fn select_inner(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	roles: &[ModelRole],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	selector: &str,
	visiting: &mut BTreeSet<Str>,
) -> Result<SelectedModel, SelectionError> {
	if selector == "*" {
		return select_inner(models, routes, aliases, roles, mru, "@default", visiting);
	}
	if let Some((role, thinking)) = role_reference(selector)? {
		if !visiting.insert(Str::new(role)) {
			return Err(SelectionError::RoleCycle(Str::new(role)));
		}
		let found = roles
			.iter()
			.find(|candidate| candidate.id == role)
			.ok_or_else(|| SelectionError::UnknownRole(Str::new(role)))?;
		if found.selectors.is_empty() {
			let selected = match role {
				"tiny" | "memory" => ["commit", "smol"].into_iter().find_map(|fallback| {
					let selector = format!("@{fallback}");
					select_inner(models, routes, aliases, roles, mru, &selector, visiting).ok()
				}),
				"smol" | "task" => find_smol(models, routes, mru),
				"slow" | "plan" | "advisor" => find_slow(models, routes, mru),
				_ => pick_default(models, routes, mru),
			};
			visiting.remove(role);
			return selected
				.map(|mut selected| {
					if let Some(thinking) = thinking {
						selected.thinking = Some(Str::new(thinking));
					}
					selected
				})
				.ok_or_else(|| SelectionError::NotFound(Str::new(selector)));
		}
		let preferred = found.provider_rank.iter().find_map(|provider| {
			found.selectors.iter().find_map(|pattern| {
				if pattern.starts_with('@') || pattern.contains('/') {
					return None;
				}
				let qualified = format!("{provider}/{pattern}");
				select_inner(models, routes, aliases, roles, mru, &qualified, visiting).ok()
			})
		});
		let mut selected = preferred.or_else(|| {
			found.selectors.iter().find_map(|pattern| {
				select_inner(models, routes, aliases, roles, mru, pattern, visiting).ok()
			})
		});
		if selected.is_none() && matches!(role, "tiny" | "memory") {
			selected = ["commit", "smol"].into_iter().find_map(|fallback| {
				let selector = format!("@{fallback}");
				select_inner(models, routes, aliases, roles, mru, &selector, visiting).ok()
			});
		}
		let result = selected
			.map(|mut selected| {
				if let Some(thinking) = thinking {
					selected.thinking = Some(Str::new(thinking));
				}
				selected
			})
			.ok_or_else(|| SelectionError::NotFound(Str::new(selector)));
		visiting.remove(role);
		return result;
	}
	let parsed = parse_selector(selector)?;
	// Guard `:max`/`:auto`: catalog literals win over suffix interpretation.
	if matches!(parsed.thinking.as_deref(), Some("max" | "auto"))
		&& models
			.iter()
			.any(|model| model.key == selector || logical_id(&model.key) == selector)
	{
		return choose(
			models,
			routes,
			mru,
			selector,
			None,
			None,
			None,
			ModelKey::from_ref(selector),
			selector,
		);
	}
	let (provider, id) = parsed
		.model
		.split_once('/')
		.map_or((None, parsed.model.as_str()), |(provider, id)| (Some(provider), id));
	if id.is_empty() {
		return Err(SelectionError::Invalid(Str::new(selector)));
	}
	if let Ok(found) = choose_alias(models, routes, aliases, mru, &parsed, provider, selector) {
		return Ok(found);
	}
	// A qualified selector binds its provider to the route provider and always
	// compares the model portion with the canonical logical id. If that exact
	// pair is absent, the full spelling gets the bare-id rung of the cascade.
	if let Ok(found) = choose(
		models,
		routes,
		mru,
		id,
		provider,
		parsed.route.as_deref(),
		parsed.upstream.clone(),
		ModelKey::from_ref(id),
		selector,
	) {
		return Ok(with_annotations(found, parsed.clone()));
	}
	if provider.is_some()
		&& let Ok(found) = choose(
			models,
			routes,
			mru,
			parsed.model.as_str(),
			None,
			parsed.route.as_deref(),
			parsed.upstream.clone(),
			ModelKey::from_ref(parsed.model.as_str()),
			selector,
		) {
		return Ok(with_annotations(found, parsed));
	}
	let mut matches = candidates(models, routes, provider, id, parsed.route.as_deref());
	if matches.is_empty() && provider.is_some() {
		matches = candidates(models, routes, provider, id, None);
	}
	if matches.is_empty() {
		matches = candidates(models, routes, provider, id, parsed.route.as_deref());
	}
	matches.retain(|(_, model)| model.key.as_str().contains(id));
	match choose_candidates(matches, routes, mru, parsed.clone(), selector) {
		Ok(selected) => Ok(selected),
		Err(error) => {
			if provider != Some("openrouter") {
				return Err(error);
			}
			let Some(undated) = strip_openrouter_date_suffix(id) else {
				return Err(error);
			};
			let fallback = match provider {
				Some(provider) => format!("{provider}/{undated}"),
				None => undated.to_owned(),
			};
			select_inner(models, routes, aliases, roles, mru, &fallback, visiting)
		},
	}
}

fn with_annotations(mut selected: SelectedModel, parsed: ParsedSelector) -> SelectedModel {
	selected.thinking = parsed.thinking;
	selected.upstream = parsed.upstream;
	selected.route = parsed.route;
	selected
}

fn choose_alias(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	parsed: &ParsedSelector,
	provider: Option<&str>,
	original: &str,
) -> Result<SelectedModel, SelectionError> {
	let route = parsed.route.as_deref();
	let candidates = aliases
		.iter()
		.filter(|alias| {
			alias.alias == parsed.model
				|| provider.is_none()
					&& alias
						.alias
						.split_once('/')
						.is_some_and(|(_, id)| id == parsed.model)
		})
		.flat_map(|alias| {
			candidates(models, routes, provider, alias.target.as_str(), route)
				.into_iter()
				.filter(move |(_, model)| model.key == alias.target)
		})
		.collect();
	let selected = choose_candidates(candidates, routes, mru, parsed.clone(), original)?;
	Ok(selected)
}

fn choose(
	models: &[ModelSpec],
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	_id: &str,
	provider: Option<&str>,
	route: Option<&RouteId<str>>,
	upstream: Option<Str>,
	exact: &ModelKey<str>,
	original: &str,
) -> Result<SelectedModel, SelectionError> {
	let candidates = candidates(models, routes, provider, exact.as_str(), route)
		.into_iter()
		.filter(|(_, model)| {
			model.key.as_str() == exact.as_str() || logical_id(&model.key) == exact.as_str()
		})
		.collect();
	choose_candidates(
		candidates,
		routes,
		mru,
		ParsedSelector {
			model: Str::new(exact.as_str()),
			upstream,
			thinking: None,
			route: route.map(ToOwned::to_owned),
		},
		original,
	)
}

fn candidates<'a>(
	models: &'a [ModelSpec],
	routes: &'a [RouteDef],
	provider: Option<&str>,
	_id: &str,
	route: Option<&RouteId<str>>,
) -> Vec<(ProviderId, &'a ModelSpec)> {
	models
		.iter()
		.filter_map(|model| {
			let route = model
				.routes
				.iter()
				.filter_map(|id| routes.iter().find(|candidate| candidate.id == *id))
				.find(|candidate| {
					provider.is_none_or(|wanted| candidate.provider == wanted)
						&& route.is_none_or(|wanted| candidate.id.as_str() == wanted.as_str())
				})?;
			Some((route.provider.clone(), model))
		})
		.filter(|(_, model)| model.availability != ModelAvailability::Disabled)
		.collect()
}

/// The key's logical portion, without its provider prefix.
fn logical_id(key: &ModelKey<str>) -> &str {
	key.as_str()
		.split_once('/')
		.map_or(key.as_str(), |(_, rest)| rest)
}

fn choose_candidates(
	candidates: Vec<(ProviderId, &ModelSpec)>,
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	parsed: ParsedSelector,
	original: &str,
) -> Result<SelectedModel, SelectionError> {
	let Some((provider, model)) = candidates
		.into_iter()
		.max_by(|left, right| rank(left, routes, mru).cmp(&rank(right, routes, mru)))
	else {
		return Err(SelectionError::NotFound(Str::new(original)));
	};
	Ok(SelectedModel {
		provider,
		model: model.key.clone(),
		upstream: parsed.upstream,
		thinking: parsed.thinking,
		route: parsed.route,
	})
}

fn rank(
	candidate: &(ProviderId, &ModelSpec),
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
) -> (u8, u64, u32, cmp::Reverse<ProviderId>, cmp::Reverse<ModelKey>) {
	let availability = u8::from(candidate.1.availability == ModelAvailability::Available);
	let recent = *mru
		.get(&(candidate.0.clone(), candidate.1.key.clone()))
		.unwrap_or(&0);
	let priority = candidate
		.1
		.routes
		.iter()
		.filter_map(|id| {
			routes
				.iter()
				.find(|route| route.id == *id && route.provider == candidate.0)
		})
		.filter_map(|route| route.priority)
		.max()
		.unwrap_or(0);
	(
		availability,
		recent,
		priority,
		cmp::Reverse(candidate.0.clone()),
		cmp::Reverse(candidate.1.key.clone()),
	)
}

/// Resolves the initial choice with strict source precedence. Environment
/// values are supplied by the caller to keep this pure and testable.
pub fn select_initial(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	roles: &[ModelRole],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	initial: InitialModel<'_>,
) -> Result<Option<SelectedModel>, SelectionError> {
	let cli = initial.cli_model.map(|model| match initial.cli_provider {
		Some(provider) if !model.contains('/') => format!("{provider}/{model}"),
		_ => model.to_owned(),
	});
	let choice = cli
		.as_deref()
		.or(initial.setting)
		.or_else(|| initial.environment.iter().flatten().copied().next());
	match choice {
		Some(selector) => select_model(models, routes, aliases, roles, mru, selector).map(Some),
		None => pick_default(models, routes, mru)
			.map(Some)
			.ok_or_else(|| SelectionError::NotFound(sf!("default"))),
	}
}

/// Picks the preferred available catalog model, using MRU only as a tiebreak.
pub fn pick_default(
	models: &[ModelSpec],
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
) -> Option<SelectedModel> {
	let candidates = models
		.iter()
		.filter(|model| model.availability != ModelAvailability::Disabled)
		.flat_map(move |model| {
			model.routes.iter().filter_map(move |route_id| {
				routes
					.iter()
					.find(|route| route.id == *route_id)
					.map(move |route| (route.provider.clone(), model))
			})
		})
		.collect();
	choose_candidates(
		candidates,
		routes,
		mru,
		ParsedSelector { model: Str::default(), upstream: None, thinking: None, route: None },
		"default",
	)
	.ok()
}

/// Finds a cheap/fast fallback. Explicit `@smol` still takes precedence at the
/// role layer; this is only its data-driven fallback.
pub fn find_smol(
	models: &[ModelSpec],
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
) -> Option<SelectedModel> {
	let candidates = models
		.iter()
		.filter(|model| {
			model.availability != ModelAvailability::Disabled && {
				let key = model.key.as_str().to_ascii_lowercase();
				key.contains("mini")
					|| key.contains("small")
					|| key.contains("flash")
					|| key.contains("haiku")
					|| key.contains("nano")
			}
		})
		.flat_map(move |model| {
			model.routes.iter().filter_map(move |id| {
				routes
					.iter()
					.find(|route| route.id == *id)
					.map(move |route| (route.provider.clone(), model))
			})
		})
		.collect();
	choose_candidates(
		candidates,
		routes,
		mru,
		ParsedSelector { model: Str::default(), upstream: None, thinking: None, route: None },
		"smol",
	)
	.ok()
	.or_else(|| pick_default(models, routes, mru))
}

/// Finds a reasoning-capable fallback; the capability fact, not a model-name
/// convention, is authoritative.
pub fn find_slow(
	models: &[ModelSpec],
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
) -> Option<SelectedModel> {
	let candidates = models
		.iter()
		.filter(|model| model.availability != ModelAvailability::Disabled && model.thinking.is_some())
		.flat_map(move |model| {
			model.routes.iter().filter_map(move |id| {
				routes
					.iter()
					.find(|route| route.id == *id)
					.map(move |route| (route.provider.clone(), model))
			})
		})
		.collect();
	choose_candidates(
		candidates,
		routes,
		mru,
		ParsedSelector { model: Str::default(), upstream: None, thinking: None, route: None },
		"slow",
	)
	.ok()
	.or_else(|| pick_default(models, routes, mru))
}

/// Finds a visual-design-capable fallback. A native image-input declaration
/// is the data-driven signal; no model-name allowlist participates.
pub fn find_designer(
	models: &[ModelSpec],
	routes: &[RouteDef],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
) -> Option<SelectedModel> {
	let candidates = models
		.iter()
		.filter(|model| {
			model.availability != ModelAvailability::Disabled
				&& model
					.capabilities
					.chat
					.as_ref()
					.is_some_and(|chat| matches!(chat.image_input, Availability::Native(_)))
		})
		.flat_map(move |model| {
			model.routes.iter().filter_map(move |id| {
				routes
					.iter()
					.find(|route| route.id == *id)
					.map(move |route| (route.provider.clone(), model))
			})
		})
		.collect();
	choose_candidates(
		candidates,
		routes,
		mru,
		ParsedSelector { model: Str::default(), upstream: None, thinking: None, route: None },
		"designer",
	)
	.ok()
	.or_else(|| pick_default(models, routes, mru))
}

/// Builds deterministic known roles from built-ins and configured metadata.
pub fn known_roles(configured: &[ModelRole]) -> Vec<ModelRole> {
	let mut roles = configured.to_vec();
	for id in BUILTIN_ROLE_IDS {
		if roles.iter().all(|role| role.id != *id) {
			roles.push(ModelRole {
				id:            Str::new(id),
				selectors:     Box::new([]),
				display_name:  None,
				color:         None,
				hidden:        false,
				cycle_order:   None,
				provider_rank: Box::new([]),
			});
		}
	}
	roles.sort_by(|left, right| {
		left
			.cycle_order
			.unwrap_or(u32::MAX)
			.cmp(&right.cycle_order.unwrap_or(u32::MAX))
			.then_with(|| left.id.cmp(&right.id))
	});
	roles
}

/// Returns roles visible in picker/cycle order. Hidden roles remain valid to
/// direct selection.
pub fn visible_roles(roles: &[ModelRole]) -> Vec<&ModelRole> {
	let mut visible = roles.iter().filter(|role| !role.hidden).collect::<Vec<_>>();
	visible.sort_by(|left, right| {
		left
			.cycle_order
			.unwrap_or(u32::MAX)
			.cmp(&right.cycle_order.unwrap_or(u32::MAX))
			.then_with(|| left.id.cmp(&right.id))
	});
	visible
}

/// Resolves the retry fallback chain owning one live catalog selection.
///
/// Specificity is exact model, longest provider wildcard, a matching live
/// role hint, another matching configured role with `default` preferred, then
/// an unassigned default chain. A role hint whose configured primary no longer
/// matches `current` is ignored.
pub fn retry_fallback_chain_key(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	roles: &[ModelRole],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	chains: &FallbackChains,
	current: &SelectedModel,
	role_hint: Option<&str>,
) -> Option<Str> {
	let full = format!("{}/{}", current.provider, logical_id(&current.model));
	if chains.contains_key(current.model.as_str()) {
		return Some(Str::new(current.model.as_str()));
	}
	if chains.contains_key(full.as_str()) {
		return Some(full.into());
	}

	let mut wildcard = None;
	let mut wildcard_len = 0;
	for key in chains.keys() {
		let Some(prefix) = key.strip_suffix("/*") else {
			continue;
		};
		if (full == prefix.as_str()
			|| full
				.strip_prefix(prefix.as_str())
				.is_some_and(|tail| tail.starts_with('/')))
			&& prefix.len() > wildcard_len
		{
			wildcard = Some(key.clone());
			wildcard_len = prefix.len();
		}
	}
	if wildcard.is_some() {
		return wildcard;
	}

	let role_matches = |id: &str| {
		let Some(role) = roles
			.iter()
			.find(|candidate| candidate.id == id && !candidate.selectors.is_empty())
		else {
			return false;
		};
		let Some(selected) = role
			.selectors
			.iter()
			.find_map(|selector| select_model(models, routes, aliases, roles, mru, selector).ok())
		else {
			return false;
		};
		selected.provider == current.provider && selected.model == current.model
	};
	if let Some(hint) = role_hint
		&& chains.contains_key(hint)
		&& role_matches(hint)
	{
		return Some(Str::new(hint));
	}
	let mut matched = None;
	for key in chains.keys() {
		if !role_matches(key) {
			continue;
		}
		if key == "default" {
			return Some(key.clone());
		}
		matched.get_or_insert_with(|| key.clone());
	}
	if matched.is_some() {
		return matched;
	}
	let default_unassigned = roles
		.iter()
		.find(|role| role.id == "default")
		.is_none_or(|role| role.selectors.is_empty());
	(chains.contains_key("default") && default_unassigned).then(|| Str::new_static("default"))
}

/// Resolves comma- and array-based selector chains without consulting
/// credential state.
///
/// Configured exact provider/model declarations that are absent from discovery
/// are retained as synthetic candidates so the call boundary, rather than the
/// picker, reports transport failure.
pub fn candidate_plan(
	models: &[ModelSpec],
	routes: &[RouteDef],
	aliases: &[CatalogAlias],
	roles: &[ModelRole],
	mru: &BTreeMap<(ProviderId, ModelKey), u64>,
	selectors: &[Str],
	scope: Option<&ModelScope>,
) -> Result<Vec<SelectionCandidate>, SelectionError> {
	let mut plan = Vec::new();
	for selector in selectors
		.iter()
		.flat_map(|chain| chain.as_str().split(','))
		.map(str::trim)
		.filter(|selector| !selector.is_empty())
	{
		match select_model(models, routes, aliases, roles, mru, selector) {
			Ok(selected)
				if scope.is_none_or(|scope| {
					scope.allows_selected(models, routes, aliases, roles, mru, &selected)
				}) =>
			{
				if plan
					.iter()
					.all(|candidate: &SelectionCandidate| candidate.selected.as_ref() != Some(&selected))
				{
					plan.push(SelectionCandidate {
						selector:   Str::new(selector),
						selected:   Some(selected),
						provenance: CandidateProvenance::Catalog,
					});
				}
			},
			Ok(_) => {},
			Err(SelectionError::NotFound(_))
				if exact_declared_selector(selector)
					&& scope.is_none_or(|scope| {
						let (provider, model) = selector.split_once('/').expect("checked exact selector");
						scope.allows(ProviderId::from_ref(provider), ModelKey::from_ref(model))
					}) =>
			{
				plan.push(SelectionCandidate {
					selector:   Str::new(selector),
					selected:   None,
					provenance: CandidateProvenance::ConfiguredDeclared,
				});
			},
			Err(error) => return Err(error),
		}
	}
	if plan.is_empty() {
		return Err(SelectionError::NotFound(
			selectors
				.first()
				.cloned()
				.unwrap_or_else(|| Str::new_static("default")),
		));
	}
	Ok(plan)
}

fn exact_declared_selector(selector: &str) -> bool {
	let Some((provider, model)) = selector.split_once('/') else {
		return false;
	};
	!provider.is_empty()
		&& !model.is_empty()
		&& !contains_glob_meta(selector)
		&& !selector.starts_with('@')
}

fn scope_pattern_base(pattern: &str) -> &str {
	let pattern = pattern.trim();
	let Some((base, suffix)) = pattern.rsplit_once(':') else {
		return pattern;
	};
	if is_thinking_level(suffix) {
		base
	} else {
		pattern
	}
}

fn contains_glob_meta(pattern: &str) -> bool {
	pattern
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'['))
}

fn strip_openrouter_date_suffix(model: &str) -> Option<&str> {
	let (base, suffix) = model.rsplit_once('-')?;
	(suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_digit())).then_some(base)
}

fn is_thinking_level(value: &str) -> bool {
	matches!(value, "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::Catalog;
	#[test]
	fn selector_grammar_is_table_driven() {
		for (input, model, upstream, thinking, route) in [
			("gpt", "gpt", None, None, None),
			("gpt:high", "gpt", None, Some("high"), None),
			("gpt:west", "gpt", None, None, Some("west")),
			("gpt@openrouter", "gpt", Some("openrouter"), None, None),
			("@openrouter/gpt:low", "gpt", Some("openrouter"), Some("low"), None),
		] {
			let parsed = parse_selector(input).expect(input);
			assert_eq!(parsed.model.as_str(), model);
			assert_eq!(parsed.upstream.as_deref(), upstream);
			assert_eq!(parsed.thinking.as_deref(), thinking);
			assert_eq!(parsed.route.as_ref().map(|route| route.as_str()), route);
		}
		for invalid in ["", "@upstream", "gpt@", "gpt::high"] {
			assert!(parse_selector(invalid).is_err(), "{invalid}");
		}
	}

	#[test]
	fn non_default_role_retains_explicit_auto_thinking() {
		let mut roles = vec![
			ModelRole::assignment(Str::new_static("default"), "openai/primary", Some("high"))
				.expect("default assignment"),
		];
		assert!(
			upsert_role_assignment(
				&mut roles,
				Str::new_static("task"),
				"openai-codex/worker",
				Some("auto")
			)
			.expect("task assignment")
		);
		assert_eq!(roles[0].selectors[0].as_str(), "openai/primary:high");
		assert_eq!(roles[1].selectors[0].as_str(), "openai-codex/worker:auto");
		assert!(
			!upsert_role_assignment(
				&mut roles,
				Str::new_static("task"),
				"openai-codex/worker",
				Some("auto")
			)
			.expect("unchanged task assignment")
		);
	}

	#[test]
	fn role_assignment_normalizes_ordered_comma_chains() {
		let role = ModelRole::assignment(
			"default",
			" missing/provider, openai-codex/gpt-5.3-codex-spark ,, ",
			Some("high"),
		)
		.expect("role chain");
		assert_eq!(role.selectors.as_ref(), [
			Str::new_static("missing/provider:high"),
			Str::new_static("openai-codex/gpt-5.3-codex-spark:high"),
		]);
	}

	#[test]
	fn configured_roles_can_delegate_to_role_aliases() {
		let catalog = Catalog::embedded();
		let target =
			pick_default(catalog.models(), catalog.routes(), &BTreeMap::new()).expect("default model");
		let roles = [
			ModelRole::assignment("slow", target.model.as_str(), None).expect("slow"),
			ModelRole::assignment("task", "@slow", Some("high")).expect("task"),
			ModelRole::assignment("advisor", "@slow", None).expect("advisor"),
		];
		assert_eq!(roles[1].selectors.as_ref(), [Str::new_static("@slow:high")]);
		for (selector, thinking) in [("@task", Some("high")), ("@advisor", None)] {
			let selected = select_model(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&roles,
				&BTreeMap::new(),
				selector,
			)
			.expect(selector);
			assert_eq!(selected.model, target.model);
			assert_eq!(selected.thinking.as_deref(), thinking);
		}
	}

	#[test]
	fn retry_role_resolution_prefers_live_hint_then_default_for_shared_assignment() {
		let catalog = Catalog::embedded();
		let mru = BTreeMap::new();
		let current =
			pick_default(catalog.models(), catalog.routes(), &mru).expect("default catalog model");
		let selector = current.model.as_str();
		let roles = vec![
			ModelRole::assignment("vision", selector, None).expect("vision role"),
			ModelRole::assignment("default", selector, None).expect("default role"),
		];
		let chains = FallbackChains::from([
			(Str::new_static("vision"), vec![sf!("provider/vision-fallback")]),
			(Str::new_static("default"), vec![sf!("provider/default-fallback")]),
		]);
		assert_eq!(
			retry_fallback_chain_key(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&roles,
				&mru,
				&chains,
				&current,
				Some("vision"),
			)
			.as_deref(),
			Some("vision")
		);
		assert_eq!(
			retry_fallback_chain_key(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&roles,
				&mru,
				&chains,
				&current,
				None,
			)
			.as_deref(),
			Some("default")
		);
	}

	#[test]
	fn retry_role_resolution_ignores_stale_and_unowned_role_hints() {
		let catalog = Catalog::embedded();
		let mru = BTreeMap::new();
		let current =
			pick_default(catalog.models(), catalog.routes(), &mru).expect("default catalog model");
		let other = catalog
			.models()
			.iter()
			.find(|model| model.key != current.model && !model.routes.is_empty())
			.and_then(|model| {
				select_model(
					catalog.models(),
					catalog.routes(),
					catalog.aliases(),
					&[],
					&mru,
					model.key.as_str(),
				)
				.ok()
			})
			.expect("second catalog model");
		let roles = vec![
			ModelRole::assignment("vision", other.model.as_str(), None).expect("vision role"),
			ModelRole::assignment("default", current.model.as_str(), None).expect("default role"),
		];
		let chains = FallbackChains::from([
			(Str::new_static("vision"), vec![sf!("provider/vision-fallback")]),
			(Str::new_static("default"), vec![sf!("provider/default-fallback")]),
		]);
		assert_eq!(
			retry_fallback_chain_key(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&roles,
				&mru,
				&chains,
				&current,
				Some("vision"),
			)
			.as_deref(),
			Some("default")
		);
		let unowned_roles = vec![
			ModelRole::assignment("vision", other.model.as_str(), None).expect("vision role"),
			ModelRole::assignment("default", other.model.as_str(), None).expect("default role"),
		];
		assert_eq!(
			retry_fallback_chain_key(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&unowned_roles,
				&mru,
				&chains,
				&current,
				None,
			),
			None
		);
	}

	#[test]
	fn role_thinking_replacement_preserves_upstream() {
		assert_eq!(
			role_assignment_selector("worker:high@openrouter", Some("auto"))
				.expect("selector")
				.as_str(),
			"worker:auto@openrouter"
		);
		assert!(role_assignment_selector("worker:west", Some("auto")).is_err());
	}

	#[test]
	fn matching_cascade_is_table_driven() {
		let catalog = Catalog::embedded();
		let models = catalog.models();
		// Catalog keys are `provider/logical` composites. Pick a model whose
		// logical id is unambiguous and whose key prefix owns a real route, so
		// both the bare and provider-qualified rungs resolve deterministically.
		let model = models
			.iter()
			.find(|model| {
				let Some((prefix, rest)) = model.key.as_str().split_once('/') else {
					return false;
				};
				!rest.contains('/')
					&& models
						.iter()
						.filter(|other| logical_id(&other.key) == rest)
						.count() == 1
					&& model.routes.iter().any(|id| {
						catalog
							.route(id)
							.is_some_and(|route| route.provider == prefix)
					})
			})
			.expect("uniquely keyed catalog model");
		let (provider, bare) = model.key.as_str().split_once('/').expect("composite key");
		let mru = BTreeMap::new();
		for selector in [bare.to_owned(), model.key.as_str().to_owned()] {
			let selected = select_model(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&[],
				&mru,
				&selector,
			)
			.expect(&selector);
			assert_eq!(selected.provider.as_str(), provider, "{selector}");
			assert_eq!(selected.model, model.key, "{selector}");
		}
	}

	#[test]
	fn qualified_collapsed_variant_alias_resolves_to_canonical_target() {
		let catalog = Catalog::embedded();
		let alias = catalog
			.aliases()
			.iter()
			.find(|alias| alias.alias == "cursor/claude-4.6-opus-high")
			.expect("shipped collapsed Cursor alias");
		let selected = select_model(
			catalog.models(),
			catalog.routes(),
			catalog.aliases(),
			&[],
			&BTreeMap::new(),
			alias.alias.as_str(),
		)
		.expect("qualified alias");
		assert_eq!(selected.model, alias.target);
		assert_eq!(selected.provider.as_str(), "cursor");
	}

	#[test]
	fn enabled_scope_uses_selection_grammar_without_key_prefix_confusion() {
		let catalog = Catalog::embedded();
		let mru = BTreeMap::new();
		let alias = catalog
			.aliases()
			.iter()
			.find_map(|alias| {
				let selected = select_model(
					catalog.models(),
					catalog.routes(),
					catalog.aliases(),
					&[],
					&mru,
					alias.alias.as_str(),
				)
				.ok()?;
				let bare = logical_id(&selected.model);
				(select_model(catalog.models(), catalog.routes(), catalog.aliases(), &[], &mru, bare)
					.ok() == Some(selected.clone()))
				.then_some((alias, selected))
			})
			.expect("resolvable catalog alias");
		let selected = alias.1;
		let logical = logical_id(&selected.model);
		let role = ModelRole::assignment("task", alias.0.alias.as_str(), None).expect("role");
		for enabled in [
			selected.model.as_str().to_owned(),
			logical.to_owned(),
			alias.0.alias.as_str().to_owned(),
			"@task".to_owned(),
			format!("{}/*", selected.provider),
		] {
			let scope = ModelScope::compile(&[Str::new(&enabled)]).expect("scope");
			let plan = candidate_plan(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				std::slice::from_ref(&role),
				&mru,
				&[Str::new(alias.0.alias.as_str())],
				Some(&scope),
			)
			.unwrap_or_else(|error| panic!("{enabled}: {error}"));
			assert_eq!(plan[0].selected.as_ref(), Some(&selected), "{enabled}");
		}
		if let Some((key_provider, _)) = selected.model.as_str().split_once('/')
			&& selected.provider != key_provider
		{
			let scope =
				ModelScope::compile(&[Str::new(format!("{key_provider}/{logical}"))]).expect("scope");
			assert!(!scope.allows(&selected.provider, &selected.model));
		}
	}

	#[test]
	fn enabled_scope_retains_exact_offline_declarations() {
		let scope = ModelScope::compile(&[Str::new_static("custom/offline-model")]).expect("scope");
		assert_eq!(scope.synthetic_declarations(&[], &[]), vec![Str::new_static(
			"custom/offline-model"
		)]);
		let plan = candidate_plan(
			&[],
			&[],
			&[],
			&[],
			&BTreeMap::new(),
			&[Str::new_static("custom/offline-model")],
			Some(&scope),
		)
		.expect("declared candidate");
		assert_eq!(plan[0].provenance, CandidateProvenance::ConfiguredDeclared);
		assert!(plan[0].selected.is_none());
	}

	#[test]
	fn date_suffix_and_known_role_order_are_deterministic() {
		assert_eq!(strip_openrouter_date_suffix("gpt-5-20260822"), Some("gpt-5"));
		assert_eq!(strip_openrouter_date_suffix("gpt-5-latest"), None);
		let mut role = ModelRole::assignment("custom", "provider/model", None).expect("role");
		role.cycle_order = Some(1);
		let roles = known_roles(&[role]);
		assert_eq!(roles[0].id.as_str(), "custom");
		assert!(roles.iter().any(|role| role.id == "default"));
	}
	#[test]
	fn tiny_and_memory_follow_commit_before_smol_without_mutation() {
		let catalog = Catalog::embedded();
		let selected_model = catalog
			.models()
			.iter()
			.find(|model| {
				model.availability != ModelAvailability::Disabled
					&& model
						.routes
						.iter()
						.any(|route| catalog.route(route).is_some())
			})
			.expect("available catalog model");
		let original = ModelRole::assignment("commit", selected_model.key.as_str(), None)
			.expect("commit assignment");
		let unavailable_tiny =
			ModelRole::assignment("tiny", "definitely-missing-model", None).expect("tiny assignment");
		let roles = known_roles(&[original, unavailable_tiny.clone()]);
		for selector in ["@tiny", "@memory"] {
			let selected = select_model(
				catalog.models(),
				catalog.routes(),
				catalog.aliases(),
				&roles,
				&BTreeMap::new(),
				selector,
			)
			.expect(selector);
			assert_eq!(selected.model, selected_model.key);
		}
		assert_eq!(roles.iter().find(|role| role.id == "tiny"), Some(&unavailable_tiny));
	}
}
