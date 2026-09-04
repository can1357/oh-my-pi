//! Runtime-owned model, thinking, provider, and wire settings projections.

#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

use std::{
	collections::BTreeMap,
	path::{Component, Path, PathBuf},
	sync,
	time::Duration,
};

use omp_con::{Ctx, Kv, Value};
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr, VariantNames};

use crate::{
	capability::{ProviderFamily, ServiceTier, TierAudience},
	id::WireModelId,
	provider::TransportKind,
	thinking::{ThinkingEffort, ThinkingPolicy},
};

/// Token budgets associated with portable reasoning effort levels.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ThinkingBudgets {
	/// Minimal-effort token ceiling.
	pub minimal: u64,
	/// Low-effort token ceiling.
	pub low:     u64,
	/// Medium-effort token ceiling.
	pub medium:  u64,
	/// High-effort token ceiling.
	pub high:    u64,
	/// Extra-high-effort token ceiling.
	pub xhigh:   u64,
	/// Maximum-effort token ceiling.
	pub max:     u64,
}

impl Default for ThinkingBudgets {
	fn default() -> Self {
		Self {
			minimal: 1_024,
			low:     2_048,
			medium:  8_192,
			high:    16_384,
			xhigh:   32_768,
			max:     32_768,
		}
	}
}

impl ThinkingBudgets {
	/// Returns the configured budget for a concrete effort.
	pub const fn for_effort(self, effort: ThinkingEffort) -> Option<u64> {
		match effort {
			ThinkingEffort::Off => None,
			ThinkingEffort::Minimal => Some(self.minimal),
			ThinkingEffort::Low => Some(self.low),
			ThinkingEffort::Medium => Some(self.medium),
			ThinkingEffort::High => Some(self.high),
			ThinkingEffort::XHigh => Some(self.xhigh),
			ThinkingEffort::Max => Some(self.max),
		}
	}
}

/// Portable service-tier selection persisted without provider credentials.
#[derive(
	Clone,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum TierSetting {
	/// Omit a service tier.
	#[default]
	None,
	/// Inherit the root session tier.
	Inherit,
	/// Provider standard tier.
	Standard,
	/// `OpenAI` `auto` tier: the provider picks the processing tier.
	Auto,
	/// `OpenAI` `default` tier: explicit standard processing.
	Default,
	/// Provider flex tier.
	Flex,
	/// `OpenAI` `scale` tier.
	Scale,
	/// Provider priority tier.
	Priority,
}

impl TierSetting {
	fn resolve(&self, family: ProviderFamily, parent: Option<&ServiceTier>) -> Option<ServiceTier> {
		match self {
			Self::None => None,
			Self::Inherit => parent.cloned(),
			Self::Standard => Some(ServiceTier { name: Str::new_static("standard"), priority: 0 }),
			// auto/default/flex/scale are OpenAI-family wire names and mean nothing
			// elsewhere.
			Self::Auto if family == ProviderFamily::OpenAi => {
				Some(ServiceTier { name: Str::new_static("auto"), priority: 0 })
			},
			Self::Default if family == ProviderFamily::OpenAi => {
				Some(ServiceTier { name: Str::new_static("default"), priority: 0 })
			},
			Self::Flex if family == ProviderFamily::OpenAi => {
				Some(ServiceTier { name: Str::new_static("flex"), priority: -10 })
			},
			Self::Scale if family == ProviderFamily::OpenAi => {
				Some(ServiceTier { name: Str::new_static("scale"), priority: 0 })
			},
			Self::Auto | Self::Default | Self::Flex | Self::Scale => None,
			Self::Priority => {
				Some(ServiceTier { name: Str::new_static("priority"), priority: 10 })
			},
		}
	}
}

/// Default `OpenRouter` routing suffix.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum OpenRouterVariant {
	/// Do not append a routing suffix.
	#[default]
	Default,
	/// Prefer throughput and latency.
	Nitro,
	/// Prefer lowest price.
	Floor,
	/// Enable `OpenRouter` online routing.
	Online,
	/// Use `OpenRouter`'s curated exacto route.
	Exacto,
}

/// Tri-state wire feature selection.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum WireToggle {
	/// Follow catalog policy.
	#[default]
	Auto,
	/// Disable the feature.
	Off,
	/// Require the feature.
	On,
}

/// Kimi provider API format.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum KimiApiFormat {
	/// Follow live catalog metadata.
	#[default]
	Auto,
	/// Require an OpenAI-compatible route.
	OpenAi,
	/// Require an Anthropic-compatible route.
	Anthropic,
}

/// Prompt-cache retention selection.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum CacheRetentionSetting {
	/// Preserve request intent and catalog defaults.
	#[default]
	Auto,
	/// Disable prompt caching.
	None,
	/// Request short retention.
	Short,
	/// Request long retention.
	Long,
}

/// Persistence scope for configured model role assignments.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum ModelRoleStorage {
	/// Persist role assignments in the active global profile.
	#[default]
	Global,
	/// Persist role assignments in project settings with global fallback.
	Project,
}

omp_con::con_enum!(ThinkingEffort);
omp_con::con_enum!(TierSetting);
omp_con::con_enum!(OpenRouterVariant);
omp_con::con_enum!(WireToggle);
omp_con::con_enum!(KimiApiFormat);
omp_con::con_enum!(CacheRetentionSetting);
omp_con::con_enum!(ModelRoleStorage);

/// Presentation metadata for one configured model role.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ModelTag {
	/// Human-readable role label.
	pub name:   Str,
	/// Optional presentation color.
	#[serde(default)]
	pub color:  Option<Str>,
	/// Whether the role is functional but omitted from selectors.
	#[serde(default)]
	pub hidden: bool,
}

/// Model selector assignments keyed by role name.
pub type ModelRoles = BTreeMap<Str, Str>;

/// Presentation metadata keyed by role name.
pub type ModelTags = BTreeMap<Str, ModelTag>;

/// Catalog-owned model and provider policy projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ModelSettings {
	/// Model selector assignments keyed by role name.
	pub roles:                    ModelRoles,
	/// Persistence scope for model role assignments.
	pub role_storage:             ModelRoleStorage,
	/// Presentation metadata keyed by model role.
	pub tags:                     ModelTags,
	/// Role names in quick-cycle order.
	pub cycle_order:              ArcStrList,
	/// Optional canonical model selector allow-list.
	pub enabled_models:           PathScopedStrList,
	/// Provider ids excluded from discovery, selection, and routing.
	pub disabled_providers:       PathScopedStrList,
	/// Default thinking effort used when a caller leaves effort unset.
	pub default_thinking:         ThinkingEffort,
	/// Universal configured reasoning ceiling.
	pub thinking_ceiling:         ThinkingEffort,
	/// Per-effort reasoning token budgets.
	pub thinking_budgets:         ThinkingBudgets,
	/// Provider ids in preferred routing order.
	pub provider_order:           ArcStrList,
	/// OpenAI-family service tier.
	pub tier_openai:              TierSetting,
	/// Anthropic-family service tier.
	pub tier_anthropic:           TierSetting,
	/// Google-family service tier.
	pub tier_google:              TierSetting,
	/// Fireworks serving tier.
	pub tier_fireworks:           TierSetting,
	/// Prompt-cache retention policy.
	pub cache_retention:          CacheRetentionSetting,
	/// `OpenAI` Codex websocket preference.
	pub openai_websockets:        WireToggle,
	/// Default `OpenRouter` routing suffix.
	pub openrouter_variant:       OpenRouterVariant,
	/// Kimi wire format preference.
	pub kimi_api_format:          KimiApiFormat,
	/// Model selector for tiny/title work.
	pub tiny_selector:            Str,
	/// Model selector for memory inference.
	pub memory_selector:          Str,
	/// Model selector for automatic-thinking classification.
	pub auto_thinking_selector:   Str,
	/// Model selector for unexpected-stop classification.
	pub unexpected_stop_selector: Str,
}

/// Clone-cheap string sequence.
pub type ArcStrList = sync::Arc<[Str]>;

/// One string or a string sequence in path-scoped settings syntax.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OneOrManyStr {
	/// One value.
	One(Str),
	/// Multiple values.
	Many(Box<[Str]>),
}

/// One mixed bare or path-scoped string-list entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PathScopedStringEntry {
	/// A value active in every working directory.
	Bare(Str),
	/// Values active below at least one configured path prefix.
	Scoped(PathScopedStringValues),
}

/// Path predicates and values for one scoped list entry.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PathScopedStringValues {
	/// Singular path prefix.
	pub path:          Option<OneOrManyStr>,
	/// Path-prefix sequence.
	pub paths:         Option<OneOrManyStr>,
	/// Singular legacy path-prefix spelling.
	pub path_prefix:   Option<OneOrManyStr>,
	/// Legacy path-prefix sequence spelling.
	pub path_prefixes: Option<OneOrManyStr>,
	/// Generic values.
	pub values:        Option<OneOrManyStr>,
	/// Generic item spelling.
	pub items:         Option<OneOrManyStr>,
	/// Model selectors used by enabled-model entries.
	pub models:        Option<OneOrManyStr>,
	/// Provider ids used by disabled-provider entries.
	pub providers:     Option<OneOrManyStr>,
}

/// Clone-cheap mixed global/path-scoped string-list source.
pub type PathScopedStrList = sync::Arc<[PathScopedStringEntry]>;

impl Default for ModelSettings {
	fn default() -> Self {
		Self {
			roles:                    BTreeMap::new(),
			role_storage:             ModelRoleStorage::Global,
			tags:                     BTreeMap::new(),
			cycle_order:              sync::Arc::from([
				Str::new_static("smol"),
				Str::new_static("default"),
				Str::new_static("slow"),
			]),
			enabled_models:           sync::Arc::from([]),
			disabled_providers:       sync::Arc::from([]),
			default_thinking:         ThinkingEffort::High,
			thinking_ceiling:         ThinkingEffort::Max,
			thinking_budgets:         ThinkingBudgets::default(),
			provider_order:           sync::Arc::from([]),
			tier_openai:              TierSetting::None,
			tier_anthropic:           TierSetting::None,
			tier_google:              TierSetting::None,
			tier_fireworks:           TierSetting::None,
			cache_retention:          CacheRetentionSetting::Auto,
			openai_websockets:        WireToggle::Auto,
			openrouter_variant:       OpenRouterVariant::Default,
			kimi_api_format:          KimiApiFormat::Auto,
			tiny_selector:            Str::new_static("@tiny"),
			memory_selector:          Str::new_static("@tiny"),
			auto_thinking_selector:   Str::new_static("@tiny"),
			unexpected_stop_selector: Str::new_static("@tiny"),
		}
	}
}

impl ModelSettings {
	/// Projects model and provider policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			roles:                    roles_from_kv(AI_MODEL_ROLES.get(ctx)),
			role_storage:             AI_MODEL_ROLE_STORAGE.get(ctx),
			tags:                     tags_from_kv(AI_MODEL_TAGS.get(ctx)),
			cycle_order:              AI_MODEL_CYCLE_ORDER.get(ctx).into(),
			enabled_models:           path_scoped_from_kv(AI_MODEL_ENABLED_MODELS.get(ctx)),
			disabled_providers:       path_scoped_from_kv(AI_MODEL_DISABLED_PROVIDERS.get(ctx)),
			default_thinking:         AI_DEFAULT_THINKING.get(ctx),
			thinking_ceiling:         AI_THINKING_CEILING.get(ctx),
			thinking_budgets:         thinking_budgets_from_kv(AI_THINKING_BUDGETS.get(ctx)),
			provider_order:           AI_PROVIDER_ORDER.get(ctx).into(),
			tier_openai:              AI_TIER_OPENAI.get(ctx),
			tier_anthropic:           AI_TIER_ANTHROPIC.get(ctx),
			tier_google:              AI_TIER_GOOGLE.get(ctx),
			tier_fireworks:           AI_TIER_FIREWORKS.get(ctx),
			cache_retention:          AI_CACHE_RETENTION.get(ctx),
			openai_websockets:        AI_OPENAI_WEBSOCKETS.get(ctx),
			openrouter_variant:       AI_OPENROUTER_VARIANT.get(ctx),
			kimi_api_format:          AI_KIMI_API_FORMAT.get(ctx),
			tiny_selector:            AI_TINY_SELECTOR.get(ctx),
			memory_selector:          AI_MEMORY_SELECTOR.get(ctx),
			auto_thinking_selector:   AI_AUTO_THINKING_SELECTOR.get(ctx),
			unexpected_stop_selector: AI_UNEXPECTED_STOP_SELECTOR.get(ctx),
		}
	}

	/// Applies configured effort budgets and the configured default to one model
	/// policy.
	pub fn apply_thinking_policy(&self, policy: &mut ThinkingPolicy) {
		policy.default_level = Some(self.default_thinking)
			.filter(|effort| *effort != ThinkingEffort::Off && policy.efforts.contains(effort));
		for effort in policy.efforts.iter().copied() {
			if let Some(budget) = self.thinking_budgets.for_effort(effort) {
				policy.effort_budgets.insert(effort, budget);
			}
		}
	}

	/// Returns a stable provider preference rank; unlisted providers follow
	/// listed ones.
	pub fn provider_rank(&self, provider: &str) -> usize {
		self
			.provider_order
			.iter()
			.position(|item| item == provider)
			.unwrap_or(usize::MAX)
	}

	/// Returns the configured selector for one role.
	pub fn role_selector(&self, role: &str) -> Option<&Str> {
		self.roles.get(role)
	}

	/// Returns presentation metadata for one role.
	pub fn role_tag(&self, role: &str) -> Option<&ModelTag> {
		self.tags.get(role)
	}

	/// Returns a role's quick-cycle rank; unlisted roles follow configured ones.
	pub fn cycle_rank(&self, role: &str) -> usize {
		self
			.cycle_order
			.iter()
			.position(|configured| configured == role)
			.unwrap_or(usize::MAX)
	}

	/// Resolves enabled-model entries for an exact working directory.
	pub fn resolved_enabled_models(&self, cwd: &Path, home: &Path) -> ArcStrList {
		resolve_path_scoped(&self.enabled_models, cwd, home, ScopedValueKind::Models)
	}

	/// Resolves disabled-provider entries for an exact working directory.
	pub fn resolved_disabled_providers(&self, cwd: &Path, home: &Path) -> ArcStrList {
		resolve_path_scoped(&self.disabled_providers, cwd, home, ScopedValueKind::Providers)
	}

	/// Clones these settings into one frozen working-directory projection.
	///
	/// The returned enabled-model and disabled-provider lists contain only bare
	/// entries, so downstream routing, inference, and discovery do not retain
	/// filesystem context.
	pub fn resolve_path_scopes(&self, cwd: &Path, home: &Path) -> Self {
		let mut resolved = self.clone();
		resolved.enabled_models = self
			.resolved_enabled_models(cwd, home)
			.iter()
			.cloned()
			.map(PathScopedStringEntry::Bare)
			.collect::<Vec<_>>()
			.into();
		resolved.disabled_providers = self
			.resolved_disabled_providers(cwd, home)
			.iter()
			.cloned()
			.map(PathScopedStringEntry::Bare)
			.collect::<Vec<_>>()
			.into();
		resolved
	}

	/// Reports whether a provider remains eligible using bare global entries.
	pub fn provider_allowed(&self, provider: &str) -> bool {
		!self
			.disabled_providers
			.iter()
			.any(|entry| matches!(entry, PathScopedStringEntry::Bare(value) if value == provider))
	}

	/// Reports whether a provider remains eligible at an exact working
	/// directory.
	pub fn provider_allowed_at(&self, cwd: &Path, home: &Path, provider: &str) -> bool {
		!self
			.resolved_disabled_providers(cwd, home)
			.iter()
			.any(|disabled| disabled == provider)
	}

	/// Reports whether a canonical identity is inside the bare global model
	/// scope.
	pub fn model_allowed(&self, provider: &str, model: &str) -> bool {
		let patterns = self.enabled_models.iter().filter_map(|entry| match entry {
			PathScopedStringEntry::Bare(value) => Some(value),
			PathScopedStringEntry::Scoped(_) => None,
		});
		self.provider_allowed(provider) && model_matches(patterns, provider, model)
	}

	/// Appends a persistently selected canonical model to a non-empty model
	/// scope.
	///
	/// The first configured occurrence wins case-insensitively. Empty scopes
	/// remain empty so persisting a default never creates a new restriction.
	pub fn insert_persisted_default(&mut self, canonical: &str) -> bool {
		if self.enabled_models.is_empty()
			|| self.enabled_models.iter().any(|entry| match entry {
				PathScopedStringEntry::Bare(value) => value.eq_ignore_ascii_case(canonical),
				PathScopedStringEntry::Scoped(source) => scoped_values(source, ScopedValueKind::Models)
					.iter()
					.any(|value| value.eq_ignore_ascii_case(canonical)),
			}) {
			return false;
		}
		let mut enabled = self.enabled_models.iter().cloned().collect::<Vec<_>>();
		enabled.push(PathScopedStringEntry::Bare(Str::new(canonical)));
		self.enabled_models = enabled.into();
		true
	}

	/// Reports whether a canonical identity is inside the resolved
	/// working-directory scope.
	pub fn model_allowed_at(&self, cwd: &Path, home: &Path, provider: &str, model: &str) -> bool {
		let patterns = self.resolved_enabled_models(cwd, home);
		self.provider_allowed_at(cwd, home, provider)
			&& model_matches(patterns.iter(), provider, model)
	}

	/// Returns the stable routing rank for an eligible model.
	pub fn model_rank(&self, provider: &str, model: &str) -> Option<usize> {
		self
			.model_allowed(provider, model)
			.then(|| self.provider_rank(provider))
	}

	/// Returns the stable routing rank in a resolved working-directory scope.
	pub fn model_rank_at(
		&self,
		cwd: &Path,
		home: &Path,
		provider: &str,
		model: &str,
	) -> Option<usize> {
		self
			.model_allowed_at(cwd, home, provider, model)
			.then(|| self.provider_rank(provider))
	}

	/// Resolves route family and provider-specific tier policy.
	pub fn service_tier_for_route(
		&self,
		provider: &str,
		model: Option<&str>,
		audience: TierAudience,
		parent: Option<&ServiceTier>,
	) -> Option<ServiceTier> {
		if provider.contains("fireworks") {
			return self.tier_fireworks.resolve(ProviderFamily::Other, parent);
		}
		self.service_tier(provider_family(provider, model), audience, parent)
	}

	/// Resolves a family/audience service tier into the concrete wire value.
	pub fn service_tier(
		&self,
		family: ProviderFamily,
		_audience: TierAudience,
		parent: Option<&ServiceTier>,
	) -> Option<ServiceTier> {
		let family_setting = match family {
			ProviderFamily::OpenAi => &self.tier_openai,
			ProviderFamily::Anthropic => &self.tier_anthropic,
			ProviderFamily::Google => &self.tier_google,
			ProviderFamily::Other => return None,
		};
		family_setting.resolve(family, parent)
	}

	/// Reports whether a concrete route satisfies configured wire preferences.
	pub fn wire_route_allowed(&self, provider: &str, codec: &str, transport: TransportKind) -> bool {
		let openai_route = provider.contains("openai") || provider.contains("codex");
		let websocket_allowed = !openai_route
			|| match self.openai_websockets {
				WireToggle::Auto => true,
				WireToggle::Off => transport != TransportKind::Websocket,
				WireToggle::On => transport == TransportKind::Websocket,
			};
		let kimi_route = provider.contains("kimi") || provider.contains("moonshot");
		let kimi_allowed = !kimi_route
			|| match self.kimi_api_format {
				KimiApiFormat::Auto => true,
				KimiApiFormat::OpenAi => codec.starts_with("openai-"),
				KimiApiFormat::Anthropic => codec == "anthropic",
			};
		websocket_allowed && kimi_allowed
	}

	/// Applies the configured `OpenRouter` suffix only when the model has no
	/// explicit variant.
	pub fn openrouter_wire_model(&self, provider: &str, model: &WireModelId<str>) -> WireModelId {
		if provider != "openrouter"
			|| self.openrouter_variant == OpenRouterVariant::Default
			|| model
				.rsplit('/')
				.next()
				.is_some_and(|tail| tail.contains(':'))
		{
			return model.to_owned();
		}
		Str::from(format!("{}:{}", model, <&'static str>::from(self.openrouter_variant))).into()
	}

	/// Selects the configured model for one harness-owned auxiliary purpose.
	pub const fn special_selector(&self, purpose: SpecialModelPurpose) -> &Str {
		match purpose {
			SpecialModelPurpose::Tiny => &self.tiny_selector,
			SpecialModelPurpose::Memory => &self.memory_selector,
			SpecialModelPurpose::AutoThinking => &self.auto_thinking_selector,
			SpecialModelPurpose::UnexpectedStop => &self.unexpected_stop_selector,
		}
	}

	/// Returns a bounded first-event timeout derived from provider settings.
	pub const fn plan_ttl(&self) -> Duration {
		Duration::from_secs(30)
	}
}

/// Harness-owned auxiliary model use.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpecialModelPurpose {
	/// Session titles and cheap transforms.
	Tiny,
	/// Memory extraction and consolidation.
	Memory,
	/// Automatic thinking classifier.
	AutoThinking,
	/// Unexpected-stop classifier.
	UnexpectedStop,
}

impl ModelSettings {
	/// Reports whether all cross-variable model policy invariants hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		let budgets = self.thinking_budgets;
		let ordered =
			[budgets.minimal, budgets.low, budgets.medium, budgets.high, budgets.xhigh, budgets.max];
		let selectors_valid = [
			&self.tiny_selector,
			&self.memory_selector,
			&self.auto_thinking_selector,
			&self.unexpected_stop_selector,
		]
		.into_iter()
		.all(|value| !value.trim().is_empty());
		let lists_valid = unique_nonempty(&self.provider_order)
			&& unique_nonempty(&self.cycle_order)
			&& scoped_entries_valid(&self.enabled_models, ScopedValueKind::Models)
			&& scoped_entries_valid(&self.disabled_providers, ScopedValueKind::Providers);
		let roles_valid = self
			.roles
			.iter()
			.all(|(role, selector)| !role.trim().is_empty() && !selector.trim().is_empty());
		let tags_valid = self
			.tags
			.iter()
			.all(|(role, tag)| !role.trim().is_empty() && !tag.name.trim().is_empty());
		ordered.iter().all(|value| *value > 0)
			&& ordered.windows(2).all(|pair| pair[0] <= pair[1])
			&& selectors_valid
			&& lists_valid
			&& roles_valid
			&& tags_valid
	}
}

impl OneOrManyStr {
	fn as_slice(&self) -> &[Str] {
		match self {
			Self::One(value) => std::slice::from_ref(value),
			Self::Many(values) => values,
		}
	}
}

#[derive(Clone, Copy)]
enum ScopedValueKind {
	Models,
	Providers,
}

fn scoped_values(source: &PathScopedStringValues, kind: ScopedValueKind) -> Vec<&Str> {
	match kind {
		ScopedValueKind::Models => source.models.iter(),
		ScopedValueKind::Providers => source.providers.iter(),
	}
	.chain(source.values.iter())
	.chain(source.items.iter())
	.flat_map(OneOrManyStr::as_slice)
	.collect()
}

fn scoped_prefixes(source: &PathScopedStringValues) -> impl Iterator<Item = &Str> {
	source
		.path
		.iter()
		.chain(source.paths.iter())
		.chain(source.path_prefix.iter())
		.chain(source.path_prefixes.iter())
		.flat_map(OneOrManyStr::as_slice)
}

fn resolve_path_scoped(
	entries: &[PathScopedStringEntry],
	cwd: &Path,
	home: &Path,
	kind: ScopedValueKind,
) -> ArcStrList {
	let cwd = normalize_path(cwd, cwd, home);
	let mut resolved = Vec::new();
	for entry in entries {
		match entry {
			PathScopedStringEntry::Bare(value) => resolved.push(value.clone()),
			PathScopedStringEntry::Scoped(source)
				if scoped_prefixes(source).any(|prefix| {
					cwd.starts_with(normalize_path(Path::new(prefix.as_str()), &cwd, home))
				}) =>
			{
				resolved.extend(scoped_values(source, kind).into_iter().cloned());
			},
			PathScopedStringEntry::Scoped(_) => {},
		}
	}
	resolved.into()
}

fn normalize_path(path: &Path, cwd: &Path, home: &Path) -> PathBuf {
	let expanded = path.to_str().map_or_else(
		|| path.to_owned(),
		|text| {
			if text == "~" {
				home.to_owned()
			} else if let Some(relative) = text.strip_prefix("~/") {
				home.join(relative)
			} else if path.is_absolute() {
				path.to_owned()
			} else {
				cwd.join(path)
			}
		},
	);
	let mut normalized = PathBuf::new();
	for component in expanded.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				normalized.pop();
			},
			Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
			Component::RootDir => normalized.push(Path::new("/")),
			Component::Normal(value) => normalized.push(value),
		}
	}
	normalized
}

fn model_matches<'a>(patterns: impl Iterator<Item = &'a Str>, provider: &str, model: &str) -> bool {
	let mut configured = false;
	let mut matched = false;
	for pattern in patterns {
		configured = true;
		matched |= model_pattern_matches(pattern, provider, model);
	}
	!configured || matched
}

/// Reports whether one configured model-scope pattern matches a provider and
/// model identity.
///
/// Matching is ASCII case-insensitive and supports `*`, `?`, and glob character
/// classes. A valid trailing thinking effort is ignored for admission, except
/// when the complete pattern exactly names a colon-bearing model id.
pub fn model_pattern_matches(pattern: &str, provider: &str, model: &str) -> bool {
	let logical_id = model
		.split_once('/')
		.map_or(model, |(_, logical_id)| logical_id);
	if exact_pattern_matches(pattern, provider, logical_id) {
		return true;
	}
	let pattern = pattern
		.rsplit_once(':')
		.filter(|(_, suffix)| suffix.parse::<ThinkingEffort>().is_ok())
		.map_or(pattern, |(pattern, _)| pattern);
	pattern.split_once('/').map_or_else(
		|| glob_matches(pattern.as_bytes(), logical_id.as_bytes()),
		|(provider_pattern, model_pattern)| {
			glob_matches(provider_pattern.as_bytes(), provider.as_bytes())
				&& glob_matches(model_pattern.as_bytes(), logical_id.as_bytes())
		},
	)
}

fn exact_pattern_matches(pattern: &str, provider: &str, model: &str) -> bool {
	pattern.split_once('/').map_or_else(
		|| pattern.eq_ignore_ascii_case(model),
		|(pattern_provider, pattern_model)| {
			pattern_provider.eq_ignore_ascii_case(provider)
				&& pattern_model.eq_ignore_ascii_case(model)
		},
	)
}

fn scoped_entries_valid(entries: &[PathScopedStringEntry], kind: ScopedValueKind) -> bool {
	entries.iter().all(|entry| match entry {
		PathScopedStringEntry::Bare(value) => !value.trim().is_empty(),
		PathScopedStringEntry::Scoped(source) => {
			let prefixes = scoped_prefixes(source).collect::<Vec<_>>();
			let values = scoped_values(source, kind);
			!prefixes.is_empty()
				&& !values.is_empty()
				&& prefixes.iter().all(|value| !value.trim().is_empty())
				&& values.iter().all(|value| !value.trim().is_empty())
		},
	})
}

fn unique_nonempty(values: &[Str]) -> bool {
	values.iter().enumerate().all(|(index, value)| {
		!value.trim().is_empty() && values[..index].iter().all(|prior| prior != value)
	})
}

fn glob_matches(pattern: &[u8], value: &[u8]) -> bool {
	let (mut pattern_index, mut value_index) = (0, 0);
	let (mut star, mut retry_value) = (None, 0);
	while value_index < value.len() {
		if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
			star = Some(pattern_index);
			pattern_index += 1;
			retry_value = value_index;
			continue;
		}
		let token = glob_token_matches(pattern, pattern_index, value[value_index]);
		if let Some((true, next_pattern)) = token {
			pattern_index = next_pattern;
			value_index += 1;
		} else if let Some(star_index) = star {
			retry_value += 1;
			value_index = retry_value;
			pattern_index = star_index + 1;
		} else {
			return false;
		}
	}
	while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
		pattern_index += 1;
	}
	pattern_index == pattern.len()
}

fn glob_token_matches(pattern: &[u8], index: usize, value: u8) -> Option<(bool, usize)> {
	let token = *pattern.get(index)?;
	if token == b'?' {
		return Some((true, index + 1));
	}
	if token != b'[' {
		return Some((token.eq_ignore_ascii_case(&value), index + 1));
	}
	character_class_matches(pattern, index, value)
		.or(Some((b'['.eq_ignore_ascii_case(&value), index + 1)))
}

fn character_class_matches(pattern: &[u8], start: usize, value: u8) -> Option<(bool, usize)> {
	let mut index = start + 1;
	let negated = matches!(pattern.get(index), Some(b'!' | b'^'));
	index += usize::from(negated);
	let mut matched = false;
	let mut populated = false;
	if pattern.get(index) == Some(&b']') {
		matched = value == b']';
		populated = true;
		index += 1;
	}
	while let Some(&current) = pattern.get(index) {
		if current == b']' && populated {
			return Some(((matched && !negated) || (!matched && negated), index + 1));
		}
		populated = true;
		if pattern.get(index + 1) == Some(&b'-')
			&& let Some(&end) = pattern.get(index + 2)
			&& end != b']'
		{
			let value = value.to_ascii_lowercase();
			let first = current.to_ascii_lowercase();
			let last = end.to_ascii_lowercase();
			matched |= first.min(last) <= value && value <= first.max(last);
			index += 3;
		} else {
			matched |= current.eq_ignore_ascii_case(&value);
			index += 1;
		}
	}
	None
}

fn roles_to_kv(roles: &ModelRoles) -> Kv {
	Kv(roles
		.iter()
		.map(|(key, value)| (key.clone(), Value::Str(value.clone())))
		.collect())
}

fn roles_from_kv(value: Kv) -> ModelRoles {
	value
		.0
		.into_iter()
		.filter_map(|(key, value)| value.as_str().map(|value| (key, Str::from(value))))
		.collect()
}

fn tags_to_kv(tags: &ModelTags) -> Kv {
	Kv(tags
		.iter()
		.map(|(key, tag)| {
			let mut fields = vec![(Str::new_static("name"), Value::Str(tag.name.clone()))];
			if let Some(color) = &tag.color {
				fields.push((Str::new_static("color"), Value::Str(color.clone())));
			}
			fields.push((Str::new_static("hidden"), Value::Bool(tag.hidden)));
			(key.clone(), Value::Kv(Kv(fields)))
		})
		.collect())
}

fn tags_from_kv(value: Kv) -> ModelTags {
	value
		.0
		.into_iter()
		.filter_map(|(key, value)| {
			let fields = value.as_kv()?;
			let name = Str::from(fields.get("name")?.as_str()?);
			let color = fields.get("color").and_then(Value::as_str).map(Str::from);
			let hidden = fields
				.get("hidden")
				.and_then(Value::as_bool)
				.unwrap_or(false);
			Some((key, ModelTag { name, color, hidden }))
		})
		.collect()
}

fn thinking_budgets_to_kv(budgets: ThinkingBudgets) -> Kv {
	Kv(vec![
		(Str::new_static("minimal"), Value::Int(budgets.minimal as i64)),
		(Str::new_static("low"), Value::Int(budgets.low as i64)),
		(Str::new_static("medium"), Value::Int(budgets.medium as i64)),
		(Str::new_static("high"), Value::Int(budgets.high as i64)),
		(Str::new_static("xhigh"), Value::Int(budgets.xhigh as i64)),
		(Str::new_static("max"), Value::Int(budgets.max as i64)),
	])
}

fn thinking_budgets_from_kv(value: Kv) -> ThinkingBudgets {
	let defaults = ThinkingBudgets::default();
	let read = |name: &str, default| {
		value
			.get(name)
			.and_then(Value::as_int)
			.and_then(|value| u64::try_from(value).ok())
			.unwrap_or(default)
	};
	ThinkingBudgets {
		minimal: read("minimal", defaults.minimal),
		low:     read("low", defaults.low),
		medium:  read("medium", defaults.medium),
		high:    read("high", defaults.high),
		xhigh:   read("xhigh", defaults.xhigh),
		max:     read("max", defaults.max),
	}
}

fn one_or_many_value(value: &OneOrManyStr) -> Value {
	Value::List(value.as_slice().iter().cloned().map(Value::Str).collect())
}

fn path_scoped_to_kv(entries: &[PathScopedStringEntry]) -> Vec<Kv> {
	entries
		.iter()
		.map(|entry| match entry {
			PathScopedStringEntry::Bare(value) => {
				Kv(vec![(Str::new_static("value"), Value::Str(value.clone()))])
			},
			PathScopedStringEntry::Scoped(source) => {
				let mut fields = Vec::new();
				for (name, value) in [
					("path", source.path.as_ref()),
					("paths", source.paths.as_ref()),
					("path_prefix", source.path_prefix.as_ref()),
					("path_prefixes", source.path_prefixes.as_ref()),
					("values", source.values.as_ref()),
					("items", source.items.as_ref()),
					("models", source.models.as_ref()),
					("providers", source.providers.as_ref()),
				] {
					if let Some(value) = value {
						fields.push((Str::from(name), one_or_many_value(value)));
					}
				}
				Kv(fields)
			},
		})
		.collect()
}

fn one_or_many_from_value(value: &Value) -> Option<OneOrManyStr> {
	let values = value
		.as_list()?
		.iter()
		.map(|value| value.as_str().map(Str::from))
		.collect::<Option<Box<[_]>>>()?;
	Some(OneOrManyStr::Many(values))
}

fn path_scoped_from_kv(entries: Vec<Kv>) -> PathScopedStrList {
	entries
		.into_iter()
		.filter_map(|entry| {
			if let Some(value) = entry.get("value").and_then(Value::as_str) {
				return Some(PathScopedStringEntry::Bare(Str::from(value)));
			}
			Some(PathScopedStringEntry::Scoped(PathScopedStringValues {
				path:          entry.get("path").and_then(one_or_many_from_value),
				paths:         entry.get("paths").and_then(one_or_many_from_value),
				path_prefix:   entry.get("path_prefix").and_then(one_or_many_from_value),
				path_prefixes: entry.get("path_prefixes").and_then(one_or_many_from_value),
				values:        entry.get("values").and_then(one_or_many_from_value),
				items:         entry.get("items").and_then(one_or_many_from_value),
				models:        entry.get("models").and_then(one_or_many_from_value),
				providers:     entry.get("providers").and_then(one_or_many_from_value),
			}))
		})
		.collect::<Vec<_>>()
		.into()
}

const fn invalid(reason: &'static str) -> Result<(), Str> {
	Err(Str::new_static(reason))
}

fn validate_roles(_: &Ctx, value: &Kv) -> Result<(), Str> {
	if roles_from_kv(value.clone())
		.iter()
		.all(|(role, selector)| !role.trim().is_empty() && !selector.trim().is_empty())
		&& value.iter().all(|(_, value)| value.as_str().is_some())
	{
		Ok(())
	} else {
		invalid("model roles require non-empty string keys and selectors")
	}
}

fn validate_tags(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let tags = tags_from_kv(value.clone());
	if tags.len() == value.len()
		&& tags
			.iter()
			.all(|(role, tag)| !role.trim().is_empty() && !tag.name.trim().is_empty())
	{
		Ok(())
	} else {
		invalid("model tags require non-empty keys and names")
	}
}

fn validate_budgets(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let budgets = thinking_budgets_from_kv(value.clone());
	let ordered =
		[budgets.minimal, budgets.low, budgets.medium, budgets.high, budgets.xhigh, budgets.max];
	let fields_valid = ["minimal", "low", "medium", "high", "xhigh", "max"]
		.into_iter()
		.all(|name| {
			value
				.get(name)
				.and_then(Value::as_int)
				.is_some_and(|value| value > 0)
		});
	if value.len() == ordered.len()
		&& fields_valid
		&& ordered.windows(2).all(|pair| pair[0] <= pair[1])
	{
		Ok(())
	} else {
		invalid("thinking budgets must be positive and ordered")
	}
}

fn validate_unique(_: &Ctx, value: &Vec<Str>) -> Result<(), Str> {
	if unique_nonempty(value) {
		Ok(())
	} else {
		invalid("list values must be non-empty and unique")
	}
}

fn validate_path_scoped_models(_: &Ctx, value: &Vec<Kv>) -> Result<(), Str> {
	let entries = path_scoped_from_kv(value.clone());
	if entries.len() == value.len() && scoped_entries_valid(&entries, ScopedValueKind::Models) {
		Ok(())
	} else {
		invalid("enabled model entries require non-empty paths and models")
	}
}

fn validate_path_scoped_providers(_: &Ctx, value: &Vec<Kv>) -> Result<(), Str> {
	let entries = path_scoped_from_kv(value.clone());
	if entries.len() == value.len() && scoped_entries_valid(&entries, ScopedValueKind::Providers) {
		Ok(())
	} else {
		invalid("disabled provider entries require non-empty paths and providers")
	}
}

fn validate_selector(_: &Ctx, value: &Str) -> Result<(), Str> {
	if value.trim().is_empty() {
		invalid("model selector must not be empty")
	} else {
		Ok(())
	}
}

omp_con::var! {
	/// Model selector assignments keyed by role name.
	pub static AI_MODEL_ROLES = ai_model_roles: Kv {
		default: roles_to_kv(&ModelSettings::default().roles),
		validate: validate_roles,
		flags: archive,
		meta: {
			"legacy.path": "model.roles",
		},
	};
	/// Where model selector role assignments are saved.
	pub static AI_MODEL_ROLE_STORAGE = ai_model_role_storage: ModelRoleStorage {
		default: ModelRoleStorage::Global,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Prompt",
			"ui.label": "Model Role Storage",
			"ui.option.global": "Global",
			"ui.option.global.desc": "Save role models in the active profile config (current behavior)",
			"ui.option.project": "Per-project",
			"ui.option.project.desc": "Save project role models in .omp/config.yml; missing project roles use global defaults",
			"legacy.path": "modelRoleStorage",
			"legacy.path": "model.role_storage",
		},
	};
	/// Presentation metadata keyed by model role.
	pub static AI_MODEL_TAGS = ai_model_tags: Kv {
		default: tags_to_kv(&ModelSettings::default().tags),
		validate: validate_tags,
		flags: archive,
		meta: {
			"legacy.path": "model.tags",
		},
	};
	/// Role names in quick-cycle order.
	pub static AI_MODEL_CYCLE_ORDER = ai_model_cycle_order: Vec<Str> {
		default: vec![Str::new_static("smol"), Str::new_static("default"), Str::new_static("slow")],
		validate: validate_unique,
		flags: archive,
		meta: {
			"legacy.path": "model.cycle_order",
		},
	};
	/// Optional canonical model selector allow-list.
	pub static AI_MODEL_ENABLED_MODELS = ai_model_enabled_models: Vec<Kv> {
		default: path_scoped_to_kv(&ModelSettings::default().enabled_models),
		validate: validate_path_scoped_models,
		flags: archive,
		meta: {
			"legacy.path": "model.enabled_models",
		},
	};
	/// Provider ids excluded from discovery, selection, and routing.
	pub static AI_MODEL_DISABLED_PROVIDERS = ai_model_disabled_providers: Vec<Kv> {
		default: path_scoped_to_kv(&ModelSettings::default().disabled_providers),
		validate: validate_path_scoped_providers,
		flags: archive,
		meta: {
			"legacy.path": "model.disabled_providers",
		},
	};
	/// Reasoning depth for thinking-capable models.
	pub static AI_DEFAULT_THINKING = ai_default_thinking: ThinkingEffort {
		default: ThinkingEffort::High,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Thinking",
			"ui.label": "Thinking Level",
			"ui.choices": "thinking-levels",
			"legacy.path": "defaultThinkingLevel",
			"legacy.path": "model.default_thinking",
		},
	};
	/// Universal configured reasoning ceiling.
	pub static AI_THINKING_CEILING = ai_thinking_ceiling: ThinkingEffort {
		default: ThinkingEffort::Max,
		flags: archive,
		meta: {
			"legacy.path": "model.thinking_ceiling",
		},
	};
	/// Per-effort reasoning token budgets.
	pub static AI_THINKING_BUDGETS = ai_thinking_budgets: Kv {
		default: thinking_budgets_to_kv(ThinkingBudgets::default()),
		validate: validate_budgets,
		flags: archive,
		meta: {
			"legacy.path": "model.thinking_budgets",
		},
	};
	/// Provider ids in preferred routing order.
	pub static AI_PROVIDER_ORDER = ai_provider_order: Vec<Str> {
		default: Vec::new(),
		validate: validate_unique,
		flags: archive,
		meta: {
			"legacy.path": "model.provider_order",
		},
	};
	/// Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.
	pub static AI_TIER_OPENAI = ai_tier_openai: TierSetting {
		default: TierSetting::None,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Service Tier — OpenAI",
			"ui.option.none": "None",
			"ui.option.none.desc": "Omit service_tier (standard processing)",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Provider default tier selection",
			"ui.option.default": "Default",
			"ui.option.default.desc": "Standard priority processing",
			"ui.option.flex": "Flex",
			"ui.option.flex.desc": "Lower cost, higher latency when available",
			"ui.option.scale": "Scale",
			"ui.option.scale.desc": "Scale Tier credits when available",
			"ui.option.priority": "Priority",
			"ui.option.priority.desc": "Faster, higher cost (premium request)",
			"legacy.path": "tier.openai",
			"legacy.path": "model.tier_openai",
		},
	};
	/// Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.
	pub static AI_TIER_ANTHROPIC = ai_tier_anthropic: TierSetting {
		default: TierSetting::None,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Service Tier — Anthropic",
			"ui.option.none": "None",
			"ui.option.none.desc": "Standard processing",
			"ui.option.priority": "Priority",
			"ui.option.priority.desc": "Fast mode (`speed: \"fast\"`) on supported direct Claude models; ignored on Bedrock/Vertex",
			"legacy.path": "tier.anthropic",
			"legacy.path": "model.tier_anthropic",
		},
	};
	/// Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.
	pub static AI_TIER_GOOGLE = ai_tier_google: TierSetting {
		default: TierSetting::None,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Service Tier — Google",
			"ui.option.none": "None",
			"ui.option.none.desc": "Standard processing",
			"ui.option.flex": "Flex",
			"ui.option.flex.desc": "Lower cost, higher latency (Gemini API + Vertex)",
			"ui.option.priority": "Priority",
			"ui.option.priority.desc": "Faster, higher reliability (Gemini API + Vertex)",
			"legacy.path": "tier.google",
			"legacy.path": "model.tier_google",
		},
	};
	/// Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.
	pub static AI_TIER_FIREWORKS = ai_tier_fireworks: TierSetting {
		default: TierSetting::None,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Fireworks",
			"ui.label": "Fireworks Tier",
			"ui.option.none": "Standard",
			"ui.option.none.desc": "Default serving path (no service_tier)",
			"ui.option.priority": "Priority",
			"ui.option.priority.desc": "Priority serving path: higher reliability, premium per-token pricing",
			"legacy.path": "providers.fireworksTier",
			"legacy.path": "model.tier_fireworks",
		},
	};
	/// Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI).
	pub static AI_CACHE_RETENTION = ai_cache_retention: CacheRetentionSetting {
		default: CacheRetentionSetting::Auto,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Protocol",
			"ui.label": "Prompt Cache Retention",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Provider default — Anthropic uses 5m entries kept warm by idle keep-alive refreshes; PI_CACHE_RETENTION still applies",
			"ui.option.short": "Short (5m)",
			"ui.option.short.desc": "Cheapest cache writes; Anthropic keeps the entry warm with bounded keep-alive refreshes while idle",
			"ui.option.long": "Long (1h)",
			"ui.option.long.desc": "1h TTL where the provider supports it; pricier writes, no keep-alive refresh requests",
			"ui.option.none": "Off",
			"ui.option.none.desc": "Disable prompt caching and cache-affinity routing",
			"legacy.path": "providers.cacheRetention",
			"legacy.path": "model.cache_retention",
		},
	};
	/// Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables).
	pub static AI_OPENAI_WEBSOCKETS = ai_openai_websockets: WireToggle {
		default: WireToggle::Auto,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Protocol",
			"ui.label": "OpenAI WebSockets",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Use model/provider default websocket behavior",
			"ui.option.off": "Off",
			"ui.option.off.desc": "Disable websockets for OpenAI Codex models",
			"ui.option.on": "On",
			"ui.option.on.desc": "Force websockets for OpenAI Codex models",
			"legacy.path": "providers.openaiWebsockets",
			"legacy.path": "model.openai_websockets",
		},
	};
	/// Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant).
	pub static AI_OPENROUTER_VARIANT = ai_openrouter_variant: OpenRouterVariant {
		default: OpenRouterVariant::Default,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Protocol",
			"ui.label": "OpenRouter Routing",
			"ui.option.default": "Default",
			"ui.option.default.desc": "No suffix; use OpenRouter's default routing",
			"ui.option.nitro": ":nitro",
			"ui.option.nitro.desc": "Prioritize throughput / lowest latency",
			"ui.option.floor": ":floor",
			"ui.option.floor.desc": "Prioritize cheapest available provider",
			"ui.option.online": ":online",
			"ui.option.online.desc": "Enable OpenRouter's web-search plugin",
			"ui.option.exacto": ":exacto",
			"ui.option.exacto.desc": "Cherry-picked high-quality providers (only defined for select models)",
			"legacy.path": "providers.openrouterVariant",
			"legacy.path": "model.openrouter_variant",
		},
	};
	/// API format for Kimi Code provider (auto follows live model metadata).
	pub static AI_KIMI_API_FORMAT = ai_kimi_api_format: KimiApiFormat {
		default: KimiApiFormat::Auto,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Protocol",
			"ui.label": "Kimi API Format",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Use the model's server-declared protocol",
			"ui.option.openai": "OpenAI",
			"ui.option.openai.desc": "api.kimi.com",
			"ui.option.anthropic": "Anthropic",
			"ui.option.anthropic.desc": "api.moonshot.ai",
			"legacy.path": "providers.kimiApiFormat",
			"legacy.path": "model.kimi_api_format",
		},
	};
	/// Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model.
	pub static AI_TINY_SELECTOR = ai_tiny_selector: Str {
		default: Str::new_static("@tiny"),
		suggest: ["@tiny", "lfm2.5-230m", "lfm2.5-350m", "falcon-h1-90m"],
		validate: validate_selector,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Tiny Model",
			"ui.label": "Tiny Model",
			"ui.option.@tiny": "Online (TINY role, else @smol)",
			"ui.option.@tiny.desc": "Online title generation: the TINY model role (set one in /models) when assigned, otherwise the online fallback (commit role, then @smol). No local download or on-device inference.",
			"ui.option.lfm2.5-230m": "LFM2.5 230M",
			"ui.option.lfm2.5-230m.desc": "Recommended local model; fastest LFM2.5 option, about 214 MB cached.",
			"ui.option.lfm2.5-350m": "LFM2.5 350M",
			"ui.option.lfm2.5-350m.desc": "Larger LFM2.5 option, about 292 MB cached; tends toward terse titles.",
			"ui.option.falcon-h1-90m": "Falcon H1 Tiny 90M",
			"ui.option.falcon-h1-90m.desc": "Smallest option, about 147 MB cached; lower fidelity on complex prompts.",
			"legacy.path": "providers.tinyModel",
			"legacy.path": "model.tiny_selector",
		},
	};
	/// Mnemopi LLM for fact extraction + consolidation: online (the TINY role from /models, else smol/remote) by default, or a local on-device model.
	pub static AI_MEMORY_SELECTOR = ai_memory_selector: Str {
		default: Str::new_static("@tiny"),
		suggest: ["@tiny", "qwen3-1.7b", "llama3.2:3b", "gemma-3-1b", "qwen2.5-1.5b", "lfm2-1.2b"],
		validate: validate_selector,
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "General",
			"ui.label": "Memory Model",
			"ui.when": "ai_memory_backend=mnemopi",
			"ui.option.@tiny": "Online (TINY role, else @smol)",
			"ui.option.@tiny.desc": "Use the online model: the TINY role from /models when set, otherwise @smol. No local model download or on-device inference.",
			"ui.option.qwen3-1.7b": "Qwen3 1.7B",
			"ui.option.qwen3-1.7b.desc": "MLX only (providers.tinyModelDevice=mlx): onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
			"ui.option.llama3.2:3b": "Llama 3.2 3B",
			"ui.option.llama3.2:3b.desc": "Larger Llama 3.2 option for local memory/classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
			"ui.option.gemma-3-1b": "Gemma 3 1B",
			"ui.option.gemma-3-1b.desc": "Best consolidation/dedup; lighter footprint, but leaks small talk during extraction.",
			"ui.option.qwen2.5-1.5b": "Qwen2.5 1.5B",
			"ui.option.qwen2.5-1.5b.desc": "Best extraction granularity (atomic facts); weaker consolidation.",
			"ui.option.lfm2-1.2b": "LFM2 1.2B",
			"ui.option.lfm2-1.2b.desc": "Fastest load; solid all-rounder, slightly noisier extraction labels.",
			"legacy.path": "providers.memoryModel",
			"legacy.path": "model.memory_selector",
		},
	};
	/// Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model.
	pub static AI_AUTO_THINKING_SELECTOR = ai_auto_thinking_selector: Str {
		default: Str::new_static("@tiny"),
		suggest: ["@tiny", "qwen3-1.7b", "llama3.2:3b", "gemma-3-1b", "qwen2.5-1.5b", "lfm2-1.2b"],
		validate: validate_selector,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Thinking",
			"ui.label": "Auto Thinking Model",
			"ui.when": "ai_default_thinking=auto",
			"ui.option.@tiny": "Online (TINY role, else @smol)",
			"ui.option.@tiny.desc": "Classify prompt difficulty online with the TINY role model (set one in /models) or @smol; no local download or on-device inference.",
			"ui.option.qwen3-1.7b": "Qwen3 1.7B",
			"ui.option.qwen3-1.7b.desc": "MLX only (providers.tinyModelDevice=mlx): onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
			"ui.option.llama3.2:3b": "Llama 3.2 3B",
			"ui.option.llama3.2:3b.desc": "Larger Llama 3.2 option for local memory/classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
			"ui.option.gemma-3-1b": "Gemma 3 1B",
			"ui.option.gemma-3-1b.desc": "Best consolidation/dedup; lighter footprint, but leaks small talk during extraction.",
			"ui.option.qwen2.5-1.5b": "Qwen2.5 1.5B",
			"ui.option.qwen2.5-1.5b.desc": "Best extraction granularity (atomic facts); weaker consolidation.",
			"ui.option.lfm2-1.2b": "LFM2 1.2B",
			"ui.option.lfm2-1.2b.desc": "Fastest load; solid all-rounder, slightly noisier extraction labels.",
			"legacy.path": "providers.autoThinkingModel",
			"legacy.path": "model.auto_thinking_selector",
		},
	};
	/// Classifier for Smart unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.
	pub static AI_UNEXPECTED_STOP_SELECTOR = ai_unexpected_stop_selector: Str {
		default: Str::new_static("@tiny"),
		suggest: ["@tiny", "qwen3-1.7b", "llama3.2:3b", "gemma-3-1b", "qwen2.5-1.5b", "lfm2-1.2b"],
		validate: validate_selector,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Tiny Model",
			"ui.label": "Unexpected Stop Model",
			"ui.when": "ai_features_unexpected_stop_detection=smart",
			"ui.option.@tiny": "Online (TINY role, else @smol)",
			"ui.option.@tiny.desc": "Use the online model: the TINY role from /models when set, otherwise @smol. No local model download or on-device inference.",
			"ui.option.qwen3-1.7b": "Qwen3 1.7B",
			"ui.option.qwen3-1.7b.desc": "MLX only (providers.tinyModelDevice=mlx): onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
			"ui.option.llama3.2:3b": "Llama 3.2 3B",
			"ui.option.llama3.2:3b.desc": "Larger Llama 3.2 option for local memory/classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
			"ui.option.gemma-3-1b": "Gemma 3 1B",
			"ui.option.gemma-3-1b.desc": "Best consolidation/dedup; lighter footprint, but leaks small talk during extraction.",
			"ui.option.qwen2.5-1.5b": "Qwen2.5 1.5B",
			"ui.option.qwen2.5-1.5b.desc": "Best extraction granularity (atomic facts); weaker consolidation.",
			"ui.option.lfm2-1.2b": "LFM2 1.2B",
			"ui.option.lfm2-1.2b.desc": "Fastest load; solid all-rounder, slightly noisier extraction labels.",
			"legacy.path": "providers.unexpectedStopModel",
			"legacy.path": "model.unexpected_stop_selector",
		},
	};
}

/// Resolves provider family from canonical route and model identities.
pub fn provider_family(provider: &str, model: Option<&str>) -> ProviderFamily {
	let model = model.unwrap_or_default();
	if provider.contains("anthropic")
		|| provider.contains("claude")
		|| model.contains("anthropic/")
		|| model.contains("claude")
	{
		ProviderFamily::Anthropic
	} else if provider.contains("google")
		|| provider.contains("gemini")
		|| model.contains("google/")
		|| model.contains("gemini")
	{
		ProviderFamily::Google
	} else if provider.contains("openai")
		|| provider == "openrouter"
		|| provider == "azure"
		|| model.contains("openai/")
	{
		ProviderFamily::OpenAi
	} else {
		ProviderFamily::Other
	}
}

/// Exact configured model fallback chains keyed by model id or `provider/*`.
pub type FallbackChains = BTreeMap<Str, Vec<Str>>;

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn role_metadata_and_canonical_paths_round_trip() {
		let mut settings = ModelSettings::default();
		settings
			.roles
			.insert(Str::new_static("smol"), Str::new_static("openai/gpt-5-mini"));
		settings.tags.insert(Str::new_static("smol"), ModelTag {
			name:   Str::new_static("Small"),
			color:  Some(Str::new_static("cyan")),
			hidden: false,
		});
		settings.role_storage = ModelRoleStorage::Project;
		assert_eq!(settings.role_selector("smol").map(Str::as_str), Some("openai/gpt-5-mini"));
		assert_eq!(settings.role_tag("smol").map(|tag| tag.name.as_str()), Some("Small"));
		assert_eq!(settings.cycle_rank("smol"), 0);
		assert_eq!(settings.cycle_rank("other"), usize::MAX);
		let encoded = serde_json::to_value(&settings).expect("settings serialize");
		let decoded: ModelSettings = serde_json::from_value(encoded).expect("settings deserialize");
		assert_eq!(decoded, settings);
		let ctx = Ctx::new();
		AI_MODEL_ROLE_STORAGE
			.set(&ctx, ModelRoleStorage::Project)
			.expect("set model role storage");
		assert_eq!(ModelSettings::from_con(&ctx).role_storage, ModelRoleStorage::Project);
	}

	#[test]
	fn openai_service_tier_values_match_pi_and_stay_openai_only() {
		use std::str::FromStr as _;

		for (setting, name, priority) in [
			(TierSetting::Auto, "auto", 0),
			(TierSetting::Default, "default", 0),
			(TierSetting::Flex, "flex", -10),
			(TierSetting::Scale, "scale", 0),
			(TierSetting::Priority, "priority", 10),
		] {
			assert_eq!(TierSetting::from_str(name).expect("kebab tier name parses"), setting);
			let mut settings = ModelSettings::default();
			settings.tier_openai = setting;
			let tier = settings
				.service_tier_for_route("openai", Some("gpt-5"), TierAudience::Session, None)
				.expect("OpenAI tier resolves");
			assert_eq!(tier.name.as_str(), name);
			assert_eq!(tier.priority, priority);
		}
		for setting in [TierSetting::Auto, TierSetting::Default, TierSetting::Scale] {
			let mut settings = ModelSettings::default();
			settings.tier_anthropic = setting.clone();
			assert!(
				settings
					.service_tier_for_route(
						"anthropic",
						Some("claude-sonnet-4-6"),
						TierAudience::Session,
						None,
					)
					.is_none(),
				"{setting:?} is an OpenAI-family wire name"
			);
		}
	}

	#[test]
	fn model_scope_filters_before_provider_ranking() {
		let mut settings = ModelSettings::default();
		settings.provider_order =
			sync::Arc::from([Str::new_static("openai"), Str::new_static("anthropic")]);
		settings.enabled_models = sync::Arc::from([
			PathScopedStringEntry::Bare(Str::new_static("openai/gpt-5.*")),
			PathScopedStringEntry::Bare(Str::new_static("claude-*")),
		]);
		settings.disabled_providers =
			sync::Arc::from([PathScopedStringEntry::Bare(Str::new_static("anthropic"))]);
		assert_eq!(settings.model_rank("openai", "gpt-5.6"), Some(0));
		assert_eq!(settings.model_rank("openai", "openai/gpt-5.6"), Some(0));
		assert_eq!(settings.model_rank("openai", "gpt-4.1"), None);
		assert_eq!(settings.model_rank("anthropic", "claude-opus-4-6"), None);
		assert!(settings.model_allowed("openrouter", "claude-sonnet-4-6"));
		assert!(model_pattern_matches("OPENAI/GPT-5.[4-7]:HIGH", "openai", "gpt-5.6"));
		assert!(model_pattern_matches("openrouter/model:exacto", "OPENROUTER", "MODEL:EXACTO"));
		assert!(!model_pattern_matches("openai/gpt-5.[!4-7]", "openai", "gpt-5.6"));
		assert!(settings.validate());
		settings.cycle_order =
			sync::Arc::from([Str::new_static("default"), Str::new_static("default")]);
		assert!(!settings.validate());
	}

	#[test]
	fn persisted_default_extends_only_an_existing_scope() {
		let mut settings = ModelSettings::default();
		assert!(!settings.insert_persisted_default("openai/gpt-5.6"));
		settings.enabled_models =
			sync::Arc::from([PathScopedStringEntry::Bare(Str::new_static("anthropic/*"))]);
		assert!(settings.insert_persisted_default("openai/gpt-5.6"));
		assert!(!settings.insert_persisted_default("OPENAI/GPT-5.6"));
		assert_eq!(settings.enabled_models.len(), 2);
		assert!(matches!(
			settings.enabled_models.last(),
			Some(PathScopedStringEntry::Bare(value)) if value == "openai/gpt-5.6"
		));
	}

	#[test]
	fn mixed_path_scoped_lists_resolve_against_exact_cwd_and_home() {
		let settings: ModelSettings = serde_json::from_value(serde_json::json!({
			"enabled_models": [
				"openai/gpt-5.*",
				{
					"pathPrefix": "/work/project",
					"models": ["anthropic/claude-*"],
					"items": "openrouter/*"
				},
				{
					"paths": ["~/private"],
					"values": "google/gemini-*"
				}
			],
			"disabled_providers": [
				"legacy",
				{
					"pathPrefixes": ["/work/project", "/other"],
					"providers": ["anthropic"]
				}
			]
		}))
		.expect("mixed scoped settings");
		let cwd = Path::new("/work/project/subdir");
		let home = Path::new("/Users/test");
		assert_eq!(settings.resolved_enabled_models(cwd, home).as_ref(), &[
			Str::new_static("openai/gpt-5.*"),
			Str::new_static("anthropic/claude-*"),
			Str::new_static("openrouter/*"),
		]);
		assert_eq!(settings.resolved_disabled_providers(cwd, home).as_ref(), &[
			Str::new_static("legacy"),
			Str::new_static("anthropic")
		]);
		assert!(settings.model_allowed_at(cwd, home, "openai", "gpt-5.6"));
		assert!(!settings.model_allowed_at(cwd, home, "anthropic", "claude-opus-4-6"));
		let frozen = settings.resolve_path_scopes(cwd, home);
		assert!(
			frozen
				.enabled_models
				.iter()
				.all(|entry| matches!(entry, PathScopedStringEntry::Bare(_)))
		);
		assert!(frozen.model_allowed("openai", "gpt-5.6"));
		assert!(!frozen.model_allowed("anthropic", "claude-opus-4-6"));
		assert_eq!(
			settings
				.resolved_enabled_models(Path::new("/Users/test/private/repo"), home)
				.as_ref(),
			&[Str::new_static("openai/gpt-5.*"), Str::new_static("google/gemini-*")]
		);
	}
}
