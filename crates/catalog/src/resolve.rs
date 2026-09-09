//! Exact catalog selection, immutable overlays, aliases, fallback chains, and
//! constraints.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{self, Display},
	iter,
};

use globset::GlobBuilder;
use omp_core::{IntoStr, Str};
use serde::{Deserialize, Serialize};

use crate::{
	AuthSpec, AuthSpecId, Availability, CatalogAlias, CatalogRevision, ClassId, CodecId,
	ContextStrategy, DiscoverySpecId, EmbeddingFormatBits, EndpointSpec, EvidenceConfidence,
	GrammarBits, HeaderProfileId, HostedToolBits, ModalityBits, ModelAvailability,
	ModelCapabilities, ModelKey, ModelLimits, ModelRemoteCompaction, ModelSpec, OperationKind,
	OverlaySource, OverlayStack, PolicyModel, PremiumMultiplier, Pricing, ProvenanceKind,
	ProvenanceSource, ProviderDef, ProviderId, ReasoningFeatureBits, RoleBits, RouteDef, RouteId,
	RouteRestrictions, SamplingControlBits, StructuredOutputBits, TextVerbosityBits,
	ThinkingPolicyId, ThinkingRouting, ToolFeatureBits, TransportKind, TrustDomain, WireModelId,
	WirePolicyId, compile::CompiledCatalog,
};

/// An exact provider and normalized-model selector.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ExactSelector {
	/// Commercial or local provider domain.
	pub provider: ProviderId,
	/// Stable normalized model key.
	pub model:    ModelKey,
}

impl ExactSelector {
	/// Creates an exact selector without parsing or normalizing either
	/// identifier.
	pub fn new(provider: impl Into<ProviderId>, model: impl Into<ModelKey>) -> Self {
		Self { provider: provider.into(), model: model.into() }
	}
}

impl Display for ExactSelector {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}/{}", self.provider, self.model)
	}
}

/// A provider-scoped exact alias selector.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct AliasSelector {
	/// Provider in whose model namespace the alias is resolved.
	pub provider: ProviderId,
	/// Alias spelling, matched byte-for-byte.
	pub alias:    Str,
}

impl AliasSelector {
	/// Creates a provider-scoped alias selector without normalizing its
	/// spelling.
	pub fn new(provider: impl Into<ProviderId>, alias: impl IntoStr) -> Self {
		Self { provider: provider.into(), alias: alias.into_str() }
	}
}

impl Display for AliasSelector {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}/{}", self.provider, self.alias)
	}
}

/// An exact selector or an exact, declaratively registered alias.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum ModelSelector {
	/// Selects one provider/model pair exactly.
	Exact(ExactSelector),
	/// Selects one provider-scoped alias exactly.
	Alias(AliasSelector),
}

/// An explicitly ordered cross-model fallback chain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FallbackChain {
	/// First selector attempted.
	pub primary:   ModelSelector,
	/// Additional selectors in caller-declared order.
	pub fallbacks: Box<[ModelSelector]>,
}

impl FallbackChain {
	/// Creates a chain containing only an exact primary selector.
	pub fn exact(primary: ExactSelector) -> Self {
		Self { primary: ModelSelector::Exact(primary), fallbacks: Box::new([]) }
	}

	/// Returns an iterator yielding the primary selector followed by any
	/// fallbacks.
	pub fn iter(&self) -> impl DoubleEndedIterator<Item = &ModelSelector> + '_ {
		iter::once(&self.primary).chain(self.fallbacks.iter())
	}
}

/// Policy for returning from a successfully selected fallback.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum FallbackRevertPolicy {
	/// Keep the fallback selected until an explicit model change.
	#[default]
	Never,
	/// Reconsider the primary after this cooldown.
	CooldownExpiry {
		/// Cooldown measured from fallback selection.
		cooldown_ms: u64,
	},
}

/// Per-selector thinking adjustment applied only while that fallback is active.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FallbackThinkingAdjustment {
	/// Exact, alias, or wildcard selector receiving the adjustment.
	pub selector: ModelSelector,
	/// Requested thinking spelling; `None` disables thinking.
	pub thinking: Option<Str>,
}

/// Runtime policy layered over an immutable fallback chain.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct FallbackRuntimePolicy {
	/// Selector-specific thinking overrides.
	pub thinking: Box<[FallbackThinkingAdjustment]>,
	/// Primary-model reconsideration policy.
	pub revert:   FallbackRevertPolicy,
}

/// Resolved model plus fallback-only runtime adjustments.
#[derive(Clone, Debug)]
pub struct FallbackResolution {
	/// Catalog resolution selected by the chain.
	pub resolved:     ResolvedModel,
	/// Thinking adjustment for the selected selector.
	pub thinking:     Option<Option<Str>>,
	/// Earliest wall-clock millisecond at which primary reconsideration is
	/// allowed.
	pub revert_at_ms: Option<u64>,
}

/// A provider-scoped alias supplied by a discovery or user overlay.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScopedAlias {
	/// Provider namespace in which the alias is visible.
	pub provider:   ProviderId,
	/// Canonical compiler alias record.
	pub definition: CatalogAlias,
}

/// Model field names tracked by field-level provenance.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelField {
	/// Normalized class.
	Class,
	/// Display name.
	DisplayName,
	/// Route-specific wire identifiers.
	WireIds,
	/// Eligible route order.
	Routes,
	/// Typed capability evidence.
	Capabilities,
	/// Token and batch limits.
	Limits,
	/// Reasoning policy.
	Thinking,
	/// Model-specific effort spelling and wire-model routing.
	ThinkingRouting,
	/// Wire policy.
	WirePolicy,
	/// Context strategy.
	Context,
	/// Price schedule.
	Pricing,
	/// Availability state.
	Availability,
	/// Context-promotion target.
	ContextPromotionTarget,
	/// Local compaction model.
	CompactionModel,
	/// Preferred edit-tool contract revision.
	EditRevision,
	/// Remote compaction contract.
	RemoteCompaction,
	/// Premium quota multiplier.
	PremiumMultiplier,
	/// Latest provider update time.
	UpdatedAt,
	/// Temporary block expiry.
	BlockedUntil,
	/// Deprecation state.
	Deprecated,
}

/// Route field names tracked by field-level provenance.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteField {
	/// Wire codec.
	Codec,
	/// Network or local transport.
	Transport,
	/// Endpoint URL and region.
	Endpoint,
	/// Authentication specification.
	Auth,
	/// Static header profile.
	Headers,
	/// Discovery specification.
	Discovery,
	/// Strict tool-schema disablement.
	StrictTools,
	/// Route capability restrictions.
	CapabilityLimits,
	/// Endpoint trust boundary.
	TrustDomain,
	/// Route priority.
	Priority,
}

/// Field-granular provenance for a resolved model and its eligible routes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FieldProvenance {
	/// Winning evidence source for each model field.
	pub model:  BTreeMap<ModelField, ProvenanceSource>,
	/// Winning evidence source for each route field, keyed first by route.
	pub routes: BTreeMap<RouteId, BTreeMap<RouteField, ProvenanceSource>>,
}

/// A partial model replacement; omitted fields retain lower-precedence values.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelPatch {
	/// Replacement class.
	pub class: Option<ClassId>,
	/// Replacement display name.
	pub display_name: Option<Str>,
	/// Replacement route/wire-id pairs.
	pub wire_ids: Option<Box<[(RouteId, WireModelId)]>>,
	/// Replacement route order.
	pub routes: Option<Box<[RouteId]>>,
	/// Replacement capability evidence.
	pub capabilities: Option<ModelCapabilities>,
	/// Replacement limits.
	pub limits: Option<ModelLimits>,
	/// `Some(None)` explicitly clears the reasoning policy.
	pub thinking: Option<Option<ThinkingPolicyId>>,
	/// Replacement model-specific effort spelling and wire-model routing.
	pub thinking_routing: Option<ThinkingRouting>,
	/// Replacement wire policy.
	pub wire_policy: Option<WirePolicyId>,
	/// Replacement context strategy.
	pub context: Option<ContextStrategy>,
	/// Replacement pricing.
	pub pricing: Option<Pricing>,
	/// Replacement model availability.
	pub availability: Option<ModelAvailability>,
	/// `Some(None)` explicitly clears context promotion.
	pub context_promotion_target: Option<Option<ModelKey>>,
	/// `Some(None)` explicitly clears the local compaction model.
	pub compaction_model: Option<Option<ModelKey>>,
	/// `Some(None)` explicitly clears the preferred edit-tool revision.
	pub edit_revision: Option<Option<Str>>,
	/// `Some(None)` explicitly clears remote compaction.
	pub remote_compaction: Option<Option<ModelRemoteCompaction>>,
	/// `Some(None)` explicitly clears the premium multiplier.
	pub premium_multiplier_millionths: Option<Option<PremiumMultiplier>>,
	/// `Some(None)` explicitly clears the latest provider update time.
	pub updated_at_ms: Option<Option<u64>>,
	/// `Some(None)` explicitly clears the block expiry.
	pub blocked_until_ms: Option<Option<u64>>,
	/// Replacement deprecation state.
	pub deprecated: Option<bool>,
}

/// A model addition or partial replacement in one overlay layer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelOverlay {
	/// Exact provider/model pair affected by this entry.
	pub selector: ExactSelector,
	/// Complete record used when the base catalog has no matching model.
	pub added:    Option<ModelSpec>,
	/// Field-granular changes applied after an optional addition.
	pub patch:    ModelPatch,
}

/// A partial route replacement; omitted fields retain lower-precedence values.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutePatch {
	/// Replacement codec.
	pub codec:                Option<CodecId>,
	/// Replacement transport.
	pub transport:            Option<TransportKind>,
	/// Replacement endpoint.
	pub endpoint:             Option<EndpointSpec>,
	/// Replacement authentication specification.
	pub auth:                 Option<AuthSpecId>,
	/// Replacement header profile.
	pub headers:              Option<HeaderProfileId>,
	/// `Some(None)` explicitly disables discovery.
	pub discovery:            Option<Option<DiscoverySpecId>>,
	/// Whether strict tool schemas are disabled on this route.
	pub disable_strict_tools: Option<bool>,
	/// Replacement route restrictions.
	pub capability_limits:    Option<RouteRestrictions>,
	/// Replacement trust boundary.
	pub trust_domain:         Option<TrustDomain>,
	/// `Some(None)` explicitly clears priority.
	pub priority:             Option<Option<u32>>,
}

/// A route addition or partial replacement in one overlay layer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RouteOverlay {
	/// Route affected by this entry.
	pub route: RouteId,
	/// Complete route used when the base catalog has no matching route.
	pub added: Option<RouteDef>,
	/// Field-granular changes applied after an optional addition.
	pub patch: RoutePatch,
}

/// One immutable overlay layer.
///
/// External contributors construct this through
/// [`crate::CatalogOverlayBuilder`], which keeps source identity paired with
/// publication ownership in [`crate::OverlayStack`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CatalogOverlay {
	/// Evidence source assigned to every field changed by this layer.
	pub(crate) source:     ProvenanceSource,
	/// Interned authentication-specification additions or replacements.
	#[serde(default)]
	pub(crate) auth_specs: Box<[AuthSpec]>,
	/// Complete provider additions or higher-precedence replacements.
	#[serde(default)]
	pub(crate) providers:  Box<[ProviderDef]>,
	/// Model additions and patches.
	pub(crate) models:     Box<[ModelOverlay]>,
	/// Route additions and patches.
	pub(crate) routes:     Box<[RouteOverlay]>,
	/// Exact alias additions or replacements.
	pub(crate) aliases:    Box<[ScopedAlias]>,
}

impl CatalogOverlay {
	/// Returns the evidence source applied by this complete layer.
	pub const fn source(&self) -> &ProvenanceSource {
		&self.source
	}

	/// Returns the number of provider-scoped model entries in this layer.
	pub const fn model_count(&self) -> usize {
		self.models.len()
	}

	/// Returns the distinct model keys added by this layer, used to validate
	/// intra-overlay cross-references (promotion and compaction targets)
	/// during sanitization.
	pub fn added_model_keys(&self) -> BTreeSet<ModelKey> {
		self
			.models
			.iter()
			.filter(|entry| entry.added.is_some())
			.map(|entry| entry.selector.model.clone())
			.collect()
	}

	/// Returns whether this layer contributes no catalog records.
	pub const fn is_empty(&self) -> bool {
		self.auth_specs.is_empty()
			&& self.providers.is_empty()
			&& self.models.is_empty()
			&& self.routes.is_empty()
			&& self.aliases.is_empty()
	}

	/// Combines complete independently produced slices under one publication
	/// source while preserving their supplied precedence order.
	pub fn combined(source: ProvenanceSource, overlays: impl IntoIterator<Item = Self>) -> Self {
		let mut auth_specs = Vec::new();
		let mut providers = Vec::new();
		let mut models = Vec::new();
		let mut routes = Vec::new();
		let mut aliases = Vec::new();
		for overlay in overlays {
			auth_specs.extend(overlay.auth_specs);
			providers.extend(overlay.providers);
			models.extend(overlay.models);
			routes.extend(overlay.routes);
			aliases.extend(overlay.aliases);
		}
		Self {
			source,
			auth_specs: auth_specs.into_boxed_slice(),
			providers: providers.into_boxed_slice(),
			models: models.into_boxed_slice(),
			routes: routes.into_boxed_slice(),
			aliases: aliases.into_boxed_slice(),
		}
	}
}

pub(crate) fn retain_additive_models(
	mut overlay: CatalogOverlay,
	existing_models: &BTreeSet<ModelKey>,
	known_providers: &BTreeSet<ProviderId>,
	mut valid: impl FnMut(&ModelSpec) -> bool,
) -> CatalogOverlay {
	overlay.auth_specs = Box::new([]);
	overlay.providers = Box::new([]);
	overlay.routes = Box::new([]);
	overlay.models = overlay
		.models
		.into_vec()
		.into_iter()
		.filter(|entry| {
			entry.added.as_ref().is_some_and(&mut valid)
				&& known_providers.contains(&entry.selector.provider)
				&& !existing_models.contains(&entry.selector.model)
		})
		.collect();
	let retained_targets = overlay
		.models
		.iter()
		.map(|entry| entry.selector.model.clone())
		.collect::<BTreeSet<_>>();
	overlay.aliases = overlay
		.aliases
		.into_vec()
		.into_iter()
		.filter(|alias| {
			known_providers.contains(&alias.provider)
				&& retained_targets.contains(&alias.definition.target)
		})
		.collect();
	overlay
}

/// Explicit authority for security-sensitive configured route changes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UnsafeTrustScope {
	endpoint_trust: bool,
	auth_trust:     bool,
}

impl UnsafeTrustScope {
	/// Grants both endpoint and authentication trust authority.
	pub const ALL: Self = Self { endpoint_trust: true, auth_trust: true };
	/// Grants authority to change authentication requirements.
	pub const AUTH: Self = Self { endpoint_trust: false, auth_trust: true };
	/// Grants authority to change endpoint and redirect trust boundaries.
	pub const ENDPOINT: Self = Self { endpoint_trust: true, auth_trust: false };
	/// Grants no security-sensitive override authority.
	pub const NONE: Self = Self { endpoint_trust: false, auth_trust: false };
}

/// A typed capability requirement used during deterministic resolution.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "capability", content = "required")]
pub enum CapabilityConstraint {
	/// Chat roles.
	ChatRoles(RoleBits),
	/// Tool-call behaviors.
	ToolFeatures(ToolFeatureBits),
	/// Structured output forms.
	StructuredOutput(StructuredOutputBits),
	/// Grammar languages.
	Grammar(GrammarBits),
	/// Text verbosity controls.
	TextVerbosity(TextVerbosityBits),
	/// Reasoning behaviors.
	Reasoning(ReasoningFeatureBits),
	/// Chat input modalities.
	InputModalities(ModalityBits),
	/// Hosted chat tools.
	HostedTools(HostedToolBits),
	/// Sampling controls.
	Sampling(SamplingControlBits),
	/// Embedding output formats.
	EmbeddingFormats(EmbeddingFormatBits),
}

/// Typed model and route constraints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResolutionConstraints {
	/// Operation that must have positive support evidence.
	pub operation:              OperationKind,
	/// Minimum model context size.
	pub minimum_context_tokens: Option<u64>,
	/// Minimum model output size.
	pub minimum_output_tokens:  Option<u64>,
	/// Additional typed positive-evidence requirements.
	pub capabilities:           Box<[CapabilityConstraint]>,
}

/// Why one exact selector did not satisfy its constraints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ConstraintFailure {
	/// The operation lacks positive support evidence.
	OperationUnknown(OperationKind),
	/// The model or route has an insufficient declared limit.
	Limit {
		/// Name of the constrained limit field.
		field:     Str,
		/// Required minimum capacity.
		required:  u64,
		/// Available capacity if known.
		available: Option<u64>,
	},
	/// A required capability is explicitly unsupported.
	Unsupported(CapabilityConstraint),
	/// A required capability lacks positive evidence.
	Unknown(CapabilityConstraint),
	/// Every provider-matching route rejects the operation or its requested
	/// limits.
	NoEligibleRoute(OperationKind),
}

/// One eligible route after provider filtering and deterministic ranking.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResolvedRoute {
	/// Route identifier.
	pub id:       RouteId,
	/// Route priority, where larger values sort first.
	pub priority: Option<u32>,
}

/// Router-safe result of exact model resolution.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResolvedModel {
	/// Canonical exact selector after alias expansion.
	pub selector:   ExactSelector,
	/// Router-facing facts without raw wire model identifiers.
	pub policy:     PolicyModel,
	/// Eligible routes ordered by descending priority then ascending route id.
	pub routes:     Box<[ResolvedRoute]>,
	/// Winning source for every model and route field.
	pub provenance: FieldProvenance,
}

/// Catalog overlay or resolution failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ResolveError {
	/// An overlay source was supplied to the wrong precedence tier.
	#[error("catalog resolution failed: overlay tier expects {expected} sources, got {actual}")]
	WrongOverlayKind {
		/// Expected provenance kind for this tier.
		expected: ProvenanceKind,
		/// Actual provenance kind supplied.
		actual:   ProvenanceKind,
	},
	/// A configured endpoint or trust-domain change lacked explicit authority.
	#[error("catalog resolution failed: route {0} endpoint change lacks explicit authority")]
	UnsafeEndpointChange(RouteId),
	/// A configured authentication change lacked explicit authority.
	#[error("catalog resolution failed: route {0} authentication change lacks explicit authority")]
	UnsafeAuthChange(RouteId),
	/// A model addition did not match its selector key.
	#[error("catalog resolution failed: added model does not match selector {0}")]
	MismatchedModelAddition(ExactSelector),
	/// A route addition did not match its declared route id.
	#[error("catalog resolution failed: added route does not match id {0}")]
	MismatchedRouteAddition(RouteId),
	/// An exact provider/model pair was not found.
	#[error("catalog resolution failed: model {0} not found")]
	ModelNotFound(ExactSelector),
	/// A selected provider was not declared.
	#[error("catalog resolution failed: provider {0} not found")]
	ProviderNotFound(ProviderId),
	/// No route connects the selected provider and model.
	#[error("catalog resolution failed: no eligible route for {0}")]
	NoEligibleRoute(ExactSelector),
	/// A provider-scoped alias was not declared exactly.
	#[error("catalog resolution failed: alias {0} not found")]
	AliasNotFound(AliasSelector),
	/// The exact selector failed typed constraints.
	#[error("catalog resolution failed: {selector} violates constraints {failures:?}")]
	Constraints {
		/// Exact selector that failed.
		selector: ExactSelector,
		/// Specific constraint failures encountered.
		failures: Box<[ConstraintFailure]>,
	},
	/// Every explicitly named selector failed.
	#[error("catalog resolution failed: every fallback failed: {0:?}")]
	FallbacksExhausted(Box<[Self]>),
}

/// Borrowed immutable bundled catalog input.
pub struct BundledCatalog<'a> {
	/// Bundled providers.
	pub providers: &'a [ProviderDef],
	/// Bundled routes.
	pub routes:    &'a [RouteDef],
	/// Bundled models.
	pub models:    &'a [ModelSpec],
	/// Bundled aliases.
	pub aliases:   &'a [CatalogAlias],
	/// Bundled field provenance source.
	pub source:    ProvenanceSource,
}

/// Resolver over an immutable bundled catalog plus ordered immutable overlays.
pub struct CatalogResolver<'a> {
	base:     BundledCatalog<'a>,
	overlays: Vec<CatalogOverlay>,
}

impl<'a> CatalogResolver<'a> {
	/// Creates a resolver borrowing, but never mutating, the bundled catalog.
	pub const fn new(base: BundledCatalog<'a>) -> Self {
		Self { base, overlays: Vec::new() }
	}

	/// Adds every layer from an immutable contribution stack in its declared
	/// precedence order.
	pub fn add_stack(
		&mut self,
		stack: &OverlayStack,
		scope: UnsafeTrustScope,
	) -> Result<(), ResolveError> {
		for (source, overlay) in stack.sources().iter().zip(stack.overlays()) {
			match source {
				OverlaySource::Bundled => {
					if overlay.source.kind != ProvenanceKind::Bundled {
						return Err(ResolveError::WrongOverlayKind {
							expected: ProvenanceKind::Bundled,
							actual:   overlay.source.kind,
						});
					}
					validate_overlay(overlay, UnsafeTrustScope::ALL)?;
					self.overlays.push(overlay.clone());
				},
				OverlaySource::DiskCache => self.add_disk_cache(overlay.clone())?,
				OverlaySource::Discovery => self.add_discovery(overlay.clone())?,
				OverlaySource::UserConfig | OverlaySource::Extension { .. } => {
					self.add_user(overlay.clone(), scope)?;
				},
			}
		}
		Ok(())
	}

	/// Adds a restart-recovered discovery cache below live discovery and user
	/// configuration.
	pub fn add_disk_cache(&mut self, overlay: CatalogOverlay) -> Result<(), ResolveError> {
		if overlay.source.kind != ProvenanceKind::Discovered {
			return Err(ResolveError::WrongOverlayKind {
				expected: ProvenanceKind::Discovered,
				actual:   overlay.source.kind,
			});
		}
		validate_overlay(&overlay, UnsafeTrustScope::NONE)?;
		let index = self
			.overlays
			.iter()
			.position(|existing| {
				matches!(existing.source.kind, ProvenanceKind::Discovered | ProvenanceKind::Configured)
			})
			.unwrap_or(self.overlays.len());
		self.overlays.insert(index, overlay);
		Ok(())
	}

	/// Adds a runtime-discovery overlay after validating its precedence class.
	pub fn add_discovery(&mut self, overlay: CatalogOverlay) -> Result<(), ResolveError> {
		if overlay.source.kind != ProvenanceKind::Discovered {
			return Err(ResolveError::WrongOverlayKind {
				expected: ProvenanceKind::Discovered,
				actual:   overlay.source.kind,
			});
		}
		validate_overlay(&overlay, UnsafeTrustScope::NONE)?;
		let index = self
			.overlays
			.iter()
			.position(|existing| existing.source.kind == ProvenanceKind::Configured)
			.unwrap_or(self.overlays.len());
		self.overlays.insert(index, overlay);
		Ok(())
	}

	/// Adds a user or extension overlay after validating security-sensitive
	/// changes against `scope`.
	pub fn add_user(
		&mut self,
		overlay: CatalogOverlay,
		scope: UnsafeTrustScope,
	) -> Result<(), ResolveError> {
		if overlay.source.kind != ProvenanceKind::Configured {
			return Err(ResolveError::WrongOverlayKind {
				expected: ProvenanceKind::Configured,
				actual:   overlay.source.kind,
			});
		}
		validate_overlay(&overlay, scope)?;
		self.overlays.push(overlay);
		Ok(())
	}

	/// Resolves the first satisfiable selector in an explicit fallback chain.
	pub fn resolve(
		&self,
		chain: &FallbackChain,
		constraints: &ResolutionConstraints,
	) -> Result<ResolvedModel, ResolveError> {
		let mut failures = Vec::new();
		for selector in chain.iter() {
			match self.resolve_one(selector, constraints) {
				Ok(resolved) => return Ok(resolved),
				Err(error) => failures.push(error),
			}
		}
		Err(ResolveError::FallbacksExhausted(failures.into_boxed_slice()))
	}

	/// Resolves a chain with selector-specific thinking and fallback reversion
	/// policy.
	pub fn resolve_with_policy(
		&self,
		chain: &FallbackChain,
		constraints: &ResolutionConstraints,
		policy: &FallbackRuntimePolicy,
		now_ms: u64,
	) -> Result<FallbackResolution, ResolveError> {
		let mut failures = Vec::new();
		for (index, selector) in chain.iter().enumerate() {
			match self.resolve_one(selector, constraints) {
				Ok(resolved) => {
					let thinking = policy
						.thinking
						.iter()
						.find(|adjustment| &adjustment.selector == selector)
						.map(|adjustment| adjustment.thinking.clone());
					let revert_at_ms = (index != 0)
						.then(|| match policy.revert {
							FallbackRevertPolicy::Never => None,
							FallbackRevertPolicy::CooldownExpiry { cooldown_ms } => {
								Some(now_ms.saturating_add(cooldown_ms))
							},
						})
						.flatten();
					return Ok(FallbackResolution { resolved, thinking, revert_at_ms });
				},
				Err(error) => failures.push(error),
			}
		}
		Err(ResolveError::FallbacksExhausted(failures.into_boxed_slice()))
	}

	/// Resolves every satisfiable explicitly named selector without inventing
	/// candidates.
	pub fn resolve_candidates(
		&self,
		chain: &FallbackChain,
		constraints: &ResolutionConstraints,
	) -> Vec<Result<ResolvedModel, ResolveError>> {
		chain
			.iter()
			.map(|selector| self.resolve_one(selector, constraints))
			.collect()
	}

	fn resolve_wildcard(
		&self,
		wildcard: &ExactSelector,
		constraints: &ResolutionConstraints,
	) -> Result<ResolvedModel, ResolveError> {
		if !self.provider_exists(&wildcard.provider) {
			return Err(ResolveError::ProviderNotFound(wildcard.provider.clone()));
		}
		let matcher = GlobBuilder::new(wildcard.model.as_str())
			.case_insensitive(true)
			.literal_separator(false)
			.build()
			.map_err(|_| ResolveError::ModelNotFound(wildcard.clone()))?
			.compile_matcher();
		let mut candidates = BTreeMap::<ModelKey, ()>::new();
		for model in self.base.models {
			if model_has_provider(model, &wildcard.provider, self.base.routes)
				&& (matcher.is_match(model.key.as_str())
					|| matcher.is_match(
						model
							.key
							.as_str()
							.rsplit_once('/')
							.map_or(model.key.as_str(), |(_, bare)| bare),
					)) {
				candidates.insert(model.key.clone(), ());
			}
		}
		for overlay in &self.overlays {
			for entry in &overlay.models {
				if entry.selector.provider == wildcard.provider
					&& let Some(model) = &entry.added
					&& (matcher.is_match(model.key.as_str())
						|| matcher.is_match(
							model
								.key
								.as_str()
								.rsplit_once('/')
								.map_or(model.key.as_str(), |(_, bare)| bare),
						)) {
					candidates.insert(model.key.clone(), ());
				}
			}
		}
		for (model, ()) in candidates {
			let selector = ModelSelector::Exact(ExactSelector::new(wildcard.provider.clone(), model));
			if let Ok(resolved) = self.resolve_one(&selector, constraints) {
				return Ok(resolved);
			}
		}
		Err(ResolveError::ModelNotFound(wildcard.clone()))
	}

	fn resolve_one(
		&self,
		selector: &ModelSelector,
		constraints: &ResolutionConstraints,
	) -> Result<ResolvedModel, ResolveError> {
		let exact = self.expand_selector(selector)?;
		if contains_glob_meta(exact.model.as_str()) {
			return self.resolve_wildcard(&exact, constraints);
		}
		if !self.provider_exists(&exact.provider) {
			return Err(ResolveError::ProviderNotFound(exact.provider));
		}
		let mut model = self
			.base
			.models
			.iter()
			.find(|model| {
				model.key == exact.model && model_has_provider(model, &exact.provider, self.base.routes)
			})
			.cloned();
		let mut model_sources = all_model_sources(self.base.source.clone());
		for overlay in &self.overlays {
			for entry in overlay
				.models
				.iter()
				.filter(|entry| entry.selector == exact)
			{
				if model.is_none() {
					let added = entry
						.added
						.clone()
						.ok_or_else(|| ResolveError::ModelNotFound(exact.clone()))?;
					if added.key != exact.model {
						return Err(ResolveError::MismatchedModelAddition(exact.clone()));
					}
					model = Some(added);
					model_sources = all_model_sources(overlay.source.clone());
				}
				if let Some(added) = &entry.added {
					let model = model.as_mut().expect("model initialized above");
					let mut evidence = model.provenance.sources.to_vec();
					for source in &added.provenance.sources {
						if !evidence.contains(source) {
							evidence.push(source.clone());
						}
					}
					model.provenance.sources = evidence.into_boxed_slice();
				}
				apply_model_patch(
					model.as_mut().expect("model initialized above"),
					&entry.patch,
					&overlay.source,
					&mut model_sources,
				);
			}
		}
		let model = model.ok_or_else(|| ResolveError::ModelNotFound(exact.clone()))?;
		let mut routes = Vec::new();
		let mut route_sources = BTreeMap::new();
		for route_id in &model.routes {
			let mut route = self
				.base
				.routes
				.iter()
				.find(|route| route.id == *route_id)
				.cloned();
			let mut sources = all_route_sources(self.base.source.clone());
			for overlay in &self.overlays {
				for entry in overlay
					.routes
					.iter()
					.filter(|entry| entry.route == *route_id)
				{
					if route.is_none() {
						let added = entry
							.added
							.clone()
							.ok_or_else(|| ResolveError::MismatchedRouteAddition(route_id.clone()))?;
						if added.id != *route_id {
							return Err(ResolveError::MismatchedRouteAddition(route_id.clone()));
						}
						route = Some(added);
						sources = all_route_sources(overlay.source.clone());
					}
					apply_route_patch(
						route.as_mut().expect("route initialized above"),
						&entry.patch,
						&overlay.source,
						&mut sources,
					);
				}
			}
			if let Some(route) = route.filter(|route| route.provider == exact.provider) {
				route_sources.insert(route.id.clone(), sources);
				routes.push(route);
			}
		}
		if routes.is_empty() {
			return Err(ResolveError::NoEligibleRoute(exact));
		}
		let failures = constraint_failures(&model, constraints);
		if !failures.is_empty() {
			return Err(ResolveError::Constraints {
				selector: exact,
				failures: failures.into_boxed_slice(),
			});
		}
		routes.retain(|route| route_satisfies(route, constraints));
		route_sources.retain(|route, _| routes.iter().any(|candidate| candidate.id == *route));
		if routes.is_empty() {
			return Err(ResolveError::Constraints {
				selector: exact,
				failures: Box::new([ConstraintFailure::NoEligibleRoute(constraints.operation)]),
			});
		}
		routes.sort_by(|left, right| {
			right
				.priority
				.unwrap_or(0)
				.cmp(&left.priority.unwrap_or(0))
				.then_with(|| left.id.cmp(&right.id))
		});
		let resolved_routes = routes
			.into_iter()
			.map(|route| ResolvedRoute { id: route.id, priority: route.priority })
			.collect::<Vec<_>>()
			.into_boxed_slice();
		Ok(ResolvedModel {
			selector:   exact,
			policy:     PolicyModel::from(&model),
			routes:     resolved_routes,
			provenance: FieldProvenance { model: model_sources, routes: route_sources },
		})
	}

	fn provider_exists(&self, provider: &ProviderId<str>) -> bool {
		self
			.base
			.providers
			.iter()
			.any(|candidate| candidate.id == *provider)
			|| self.overlays.iter().any(|overlay| {
				overlay
					.providers
					.iter()
					.any(|candidate| candidate.id == *provider)
			})
	}

	fn expand_selector(&self, selector: &ModelSelector) -> Result<ExactSelector, ResolveError> {
		match selector {
			ModelSelector::Exact(exact) => Ok(exact.clone()),
			ModelSelector::Alias(alias) => self
				.alias_target(alias)
				.map(|model| ExactSelector { provider: alias.provider.clone(), model })
				.ok_or_else(|| ResolveError::AliasNotFound(alias.clone())),
		}
	}

	fn alias_target(&self, selector: &AliasSelector) -> Option<ModelKey> {
		let mut target = self
			.base
			.aliases
			.iter()
			.find(|entry| entry.alias == selector.alias)
			.map(|entry| entry.target.clone());
		for overlay in &self.overlays {
			if let Some(entry) = overlay.aliases.iter().find(|entry| {
				entry.provider == selector.provider && entry.definition.alias == selector.alias
			}) {
				target = Some(entry.definition.target.clone());
			}
		}
		target
	}
}

pub(crate) fn materialize_overlay_stack(
	mut catalog: CompiledCatalog,
	stack: &OverlayStack,
	scope: UnsafeTrustScope,
) -> Result<CompiledCatalog, ResolveError> {
	let base = BundledCatalog {
		providers: &catalog.providers,
		routes:    &catalog.routes,
		models:    &catalog.models,
		aliases:   &catalog.aliases,
		source:    ProvenanceSource {
			kind:           ProvenanceKind::Bundled,
			origin:         Str::new_static("embedded"),
			revision:       Some(catalog.revision.clone()),
			confidence:     EvidenceConfidence::Verified,
			observed_at_ms: None,
		},
	};
	let mut resolver = CatalogResolver::new(base);
	resolver.add_stack(stack, scope)?;
	let overlays = resolver.overlays;
	let mut auth_specs = catalog.auth_specs.into_vec();
	let mut providers = catalog.providers.into_vec();
	let mut routes = catalog.routes.into_vec();
	let mut models = catalog.models.into_vec();
	let mut aliases = catalog.aliases.into_vec();
	for overlay in overlays {
		for spec in overlay.auth_specs {
			if let Some(existing) = auth_specs
				.iter_mut()
				.find(|existing| existing.id == spec.id)
			{
				*existing = spec;
			} else {
				auth_specs.push(spec);
			}
		}
		for provider in overlay.providers {
			if let Some(existing) = providers
				.iter_mut()
				.find(|existing| existing.id == provider.id)
			{
				*existing = provider;
			} else {
				providers.push(provider);
			}
		}
		for entry in overlay.routes {
			let route = if let Some(index) = routes.iter().position(|route| route.id == entry.route) {
				if entry
					.added
					.as_ref()
					.is_some_and(|added| added.id != entry.route)
				{
					return Err(ResolveError::MismatchedRouteAddition(entry.route));
				}
				&mut routes[index]
			} else {
				let Some(added) = entry.added else {
					return Err(ResolveError::MismatchedRouteAddition(entry.route));
				};
				if added.id != entry.route {
					return Err(ResolveError::MismatchedRouteAddition(entry.route));
				}
				routes.push(added);
				routes.last_mut().expect("inserted route")
			};
			apply_route_patch(
				route,
				&entry.patch,
				&overlay.source,
				&mut all_route_sources(overlay.source.clone()),
			);
		}
		for entry in overlay.models {
			let model = if let Some(index) = models
				.iter()
				.position(|model| model.key == entry.selector.model)
			{
				if entry
					.added
					.as_ref()
					.is_some_and(|added| added.key != entry.selector.model)
				{
					return Err(ResolveError::MismatchedModelAddition(entry.selector));
				}
				if let Some(added) = &entry.added {
					let mut evidence = models[index].provenance.sources.to_vec();
					for source in &added.provenance.sources {
						if !evidence.contains(source) {
							evidence.push(source.clone());
						}
					}
					models[index].provenance.sources = evidence.into_boxed_slice();
				}
				&mut models[index]
			} else {
				let Some(added) = entry.added else {
					return Err(ResolveError::MismatchedModelAddition(entry.selector));
				};
				if added.key != entry.selector.model {
					return Err(ResolveError::MismatchedModelAddition(entry.selector));
				}
				models.push(added);
				models.last_mut().expect("inserted model")
			};
			apply_model_patch(
				model,
				&entry.patch,
				&overlay.source,
				&mut all_model_sources(overlay.source.clone()),
			);
		}
		for alias in overlay.aliases {
			let alias_name = if alias.definition.alias.as_str().contains('/') {
				alias.definition.alias.clone()
			} else {
				Str::from(format!("{}/{}", alias.provider, alias.definition.alias))
			};
			let replacement = CatalogAlias {
				alias:      alias_name,
				target:     alias.definition.target.clone(),
				rationale:  alias.definition.rationale.clone(),
				provenance: alias.definition.provenance.clone(),
			};
			if let Some(existing) = aliases
				.iter_mut()
				.find(|existing| existing.alias == replacement.alias)
			{
				*existing = replacement;
			} else {
				aliases.push(replacement);
			}
		}
	}
	auth_specs.sort_by(|left, right| left.id.cmp(&right.id));
	providers.sort_by(|left, right| left.id.cmp(&right.id));
	routes.sort_by(|left, right| left.id.cmp(&right.id));
	models.sort_by(|left, right| left.key.cmp(&right.key));
	aliases.sort_by(|left, right| left.alias.cmp(&right.alias));
	catalog.auth_specs = auth_specs.into_boxed_slice();
	catalog.providers = providers.into_boxed_slice();
	catalog.routes = routes.into_boxed_slice();
	catalog.models = models.into_boxed_slice();
	catalog.aliases = aliases.into_boxed_slice();
	Ok(catalog)
}

fn validate_overlay(overlay: &CatalogOverlay, scope: UnsafeTrustScope) -> Result<(), ResolveError> {
	for route in &overlay.routes {
		if (route.added.is_some()
			|| route.patch.endpoint.is_some()
			|| route.patch.trust_domain.is_some())
			&& !scope.endpoint_trust
		{
			return Err(ResolveError::UnsafeEndpointChange(route.route.clone()));
		}
		if (route.added.is_some() || route.patch.auth.is_some()) && !scope.auth_trust {
			return Err(ResolveError::UnsafeAuthChange(route.route.clone()));
		}
		if let Some(added) = &route.added
			&& added.id != route.route
		{
			return Err(ResolveError::MismatchedRouteAddition(route.route.clone()));
		}
	}
	for model in &overlay.models {
		if let Some(added) = &model.added
			&& added.key != model.selector.model
		{
			return Err(ResolveError::MismatchedModelAddition(model.selector.clone()));
		}
	}
	Ok(())
}

fn contains_glob_meta(value: &str) -> bool {
	value
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{'))
}

fn model_has_provider(model: &ModelSpec, provider: &ProviderId<str>, routes: &[RouteDef]) -> bool {
	model.routes.iter().any(|route_id| {
		routes
			.iter()
			.any(|route| route.id == *route_id && route.provider.as_str() == provider.as_str())
	})
}

fn all_model_sources(source: ProvenanceSource) -> BTreeMap<ModelField, ProvenanceSource> {
	[
		ModelField::Class,
		ModelField::DisplayName,
		ModelField::WireIds,
		ModelField::Routes,
		ModelField::Capabilities,
		ModelField::Limits,
		ModelField::Thinking,
		ModelField::ThinkingRouting,
		ModelField::WirePolicy,
		ModelField::Context,
		ModelField::Pricing,
		ModelField::Availability,
		ModelField::ContextPromotionTarget,
		ModelField::CompactionModel,
		ModelField::EditRevision,
		ModelField::RemoteCompaction,
		ModelField::PremiumMultiplier,
		ModelField::UpdatedAt,
		ModelField::BlockedUntil,
		ModelField::Deprecated,
	]
	.into_iter()
	.map(|field| (field, source.clone()))
	.collect()
}

fn all_route_sources(source: ProvenanceSource) -> BTreeMap<RouteField, ProvenanceSource> {
	[
		RouteField::Codec,
		RouteField::Transport,
		RouteField::Endpoint,
		RouteField::Auth,
		RouteField::Headers,
		RouteField::Discovery,
		RouteField::StrictTools,
		RouteField::CapabilityLimits,
		RouteField::TrustDomain,
		RouteField::Priority,
	]
	.into_iter()
	.map(|field| (field, source.clone()))
	.collect()
}

macro_rules! patch_field {
	($patch:expr, $target:expr, $member:ident, $field:expr, $source:expr, $sources:expr) => {
		if let Some(value) = &$patch.$member {
			$target.$member = value.clone();
			$sources.insert($field, $source.clone());
		}
	};
}

fn apply_model_patch(
	model: &mut ModelSpec,
	patch: &ModelPatch,
	source: &ProvenanceSource,
	sources: &mut BTreeMap<ModelField, ProvenanceSource>,
) {
	patch_field!(patch, model, class, ModelField::Class, source, sources);
	patch_field!(patch, model, display_name, ModelField::DisplayName, source, sources);
	patch_field!(patch, model, wire_ids, ModelField::WireIds, source, sources);
	patch_field!(patch, model, routes, ModelField::Routes, source, sources);
	patch_field!(patch, model, capabilities, ModelField::Capabilities, source, sources);
	patch_field!(patch, model, limits, ModelField::Limits, source, sources);
	patch_field!(patch, model, thinking, ModelField::Thinking, source, sources);
	patch_field!(patch, model, thinking_routing, ModelField::ThinkingRouting, source, sources);
	patch_field!(patch, model, wire_policy, ModelField::WirePolicy, source, sources);
	patch_field!(patch, model, context, ModelField::Context, source, sources);
	patch_field!(patch, model, pricing, ModelField::Pricing, source, sources);
	patch_field!(patch, model, availability, ModelField::Availability, source, sources);
	patch_field!(
		patch,
		model,
		context_promotion_target,
		ModelField::ContextPromotionTarget,
		source,
		sources
	);
	patch_field!(patch, model, compaction_model, ModelField::CompactionModel, source, sources);
	patch_field!(patch, model, edit_revision, ModelField::EditRevision, source, sources);
	patch_field!(patch, model, remote_compaction, ModelField::RemoteCompaction, source, sources);
	patch_field!(
		patch,
		model,
		premium_multiplier_millionths,
		ModelField::PremiumMultiplier,
		source,
		sources
	);
	if let Some(value) = patch.updated_at_ms {
		model.provenance.updated_at_ms = value;
		sources.insert(ModelField::UpdatedAt, source.clone());
	}
	if let Some(value) = patch.blocked_until_ms {
		model.provenance.blocked_until_ms = value;
		sources.insert(ModelField::BlockedUntil, source.clone());
	}
	if let Some(value) = patch.deprecated {
		model.provenance.deprecated = value;
		sources.insert(ModelField::Deprecated, source.clone());
	}
	if !model
		.provenance
		.sources
		.iter()
		.any(|existing| existing == source)
	{
		let mut evidence = model.provenance.sources.to_vec();
		evidence.push(source.clone());
		model.provenance.sources = evidence.into_boxed_slice();
	}
}

fn apply_route_patch(
	route: &mut RouteDef,
	patch: &RoutePatch,
	source: &ProvenanceSource,
	sources: &mut BTreeMap<RouteField, ProvenanceSource>,
) {
	patch_field!(patch, route, codec, RouteField::Codec, source, sources);
	patch_field!(patch, route, transport, RouteField::Transport, source, sources);
	patch_field!(patch, route, endpoint, RouteField::Endpoint, source, sources);
	patch_field!(patch, route, auth, RouteField::Auth, source, sources);
	patch_field!(patch, route, headers, RouteField::Headers, source, sources);
	patch_field!(patch, route, discovery, RouteField::Discovery, source, sources);
	if let Some(disabled) = patch.disable_strict_tools {
		route.capability_limits.disable_strict_tools = disabled;
		sources.insert(RouteField::StrictTools, source.clone());
	}
	patch_field!(patch, route, capability_limits, RouteField::CapabilityLimits, source, sources);
	patch_field!(patch, route, trust_domain, RouteField::TrustDomain, source, sources);
	patch_field!(patch, route, priority, RouteField::Priority, source, sources);
}

fn constraint_failures(
	model: &ModelSpec,
	constraints: &ResolutionConstraints,
) -> Vec<ConstraintFailure> {
	let mut failures = Vec::new();
	if !model
		.capabilities
		.operations
		.contains_kind(constraints.operation)
	{
		failures.push(ConstraintFailure::OperationUnknown(constraints.operation));
	}
	check_limit(
		"context_tokens",
		constraints.minimum_context_tokens,
		model.limits.context_window,
		&mut failures,
	);
	check_limit(
		"output_tokens",
		constraints.minimum_output_tokens,
		model.limits.maximum_output_tokens,
		&mut failures,
	);
	for requirement in &constraints.capabilities {
		match capability_support(&model.capabilities, requirement) {
			CapabilitySupport::Supported => {},
			CapabilitySupport::Unsupported => {
				failures.push(ConstraintFailure::Unsupported(requirement.clone()));
			},
			CapabilitySupport::Unknown => {
				failures.push(ConstraintFailure::Unknown(requirement.clone()));
			},
		}
	}
	failures
}

fn route_satisfies(route: &RouteDef, constraints: &ResolutionConstraints) -> bool {
	if route
		.capability_limits
		.operations
		.is_some_and(|allowed| !allowed.contains_kind(constraints.operation))
	{
		return false;
	}
	if route
		.capability_limits
		.maximum_context_tokens
		.zip(constraints.minimum_context_tokens)
		.is_some_and(|(available, required)| available < required)
	{
		return false;
	}
	route
		.capability_limits
		.maximum_output_tokens
		.zip(constraints.minimum_output_tokens)
		.is_none_or(|(available, required)| available >= required)
}

fn check_limit(
	field: &str,
	required: Option<u64>,
	available: Option<u64>,
	failures: &mut Vec<ConstraintFailure>,
) {
	if let Some(required) = required
		&& available.is_none_or(|available| available < required)
	{
		failures.push(ConstraintFailure::Limit { field: Str::new(field), required, available });
	}
}

#[derive(Clone, Copy)]
enum CapabilitySupport {
	Supported,
	Unsupported,
	Unknown,
}

fn availability_bits<C>(
	availability: Option<&Availability<C>>,
	contains: impl FnOnce(&C) -> bool,
) -> CapabilitySupport {
	match availability {
		Some(Availability::Native(value) | Availability::Emulated { constraints: value, .. }) => {
			if contains(value) {
				CapabilitySupport::Supported
			} else {
				CapabilitySupport::Unsupported
			}
		},
		Some(Availability::Unsupported) => CapabilitySupport::Unsupported,
		Some(Availability::Unknown) | None => CapabilitySupport::Unknown,
	}
}

fn capability_support(
	capabilities: &ModelCapabilities,
	requirement: &CapabilityConstraint,
) -> CapabilitySupport {
	let chat = capabilities.chat.as_ref();
	match requirement {
		CapabilityConstraint::ChatRoles(required) => {
			availability_bits(chat.map(|value| &value.roles), |value| value.contains(*required))
		},
		CapabilityConstraint::ToolFeatures(required) => match chat.map(|value| &value.tools) {
			Some(Availability::Native(value) | Availability::Emulated { constraints: value, .. }) => {
				if value.features.contains(*required) {
					CapabilitySupport::Supported
				} else {
					CapabilitySupport::Unsupported
				}
			},
			Some(Availability::Unsupported) => CapabilitySupport::Unsupported,
			Some(Availability::Unknown) | None => CapabilitySupport::Unknown,
		},
		CapabilityConstraint::StructuredOutput(required) => {
			availability_bits(chat.map(|value| &value.structured_output), |value| {
				value.contains(*required)
			})
		},
		CapabilityConstraint::Grammar(required) => {
			availability_bits(chat.map(|value| &value.grammar), |value| value.contains(*required))
		},
		CapabilityConstraint::TextVerbosity(required) => {
			availability_bits(chat.map(|value| &value.text_verbosity), |value| {
				value.contains(*required)
			})
		},
		CapabilityConstraint::Reasoning(required) => {
			availability_bits(chat.map(|value| &value.reasoning), |value| {
				value.features.contains(*required)
			})
		},
		CapabilityConstraint::InputModalities(required) => {
			availability_bits(chat.map(|value| &value.input_modalities), |value| {
				value.contains(*required)
			})
		},
		CapabilityConstraint::HostedTools(required) => {
			availability_bits(chat.map(|value| &value.hosted_tools), |value| value.contains(*required))
		},
		CapabilityConstraint::Sampling(required) => {
			availability_bits(chat.map(|value| &value.sampling), |value| value.contains(*required))
		},
		CapabilityConstraint::EmbeddingFormats(required) => match capabilities.embeddings.as_ref() {
			Some(value) if value.formats.contains(*required) => CapabilitySupport::Supported,
			Some(_) => CapabilitySupport::Unsupported,
			None => CapabilitySupport::Unknown,
		},
	}
}

/// Creates a provenance source suitable for a synthetic bundled catalog in
/// tests or builders.
pub fn bundled_source(origin: impl IntoStr, revision: Option<CatalogRevision>) -> ProvenanceSource {
	ProvenanceSource {
		kind: ProvenanceKind::Bundled,
		origin: origin.into_str(),
		revision,
		confidence: EvidenceConfidence::Verified,
		observed_at_ms: None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		CatalogModelMetrics, ChatCapabilities, CodecProfile, CodexTransportPreference, EndpointSpec,
		HeaderProfileId, ManagementCapabilities, ModelProvenance, OperationBits,
		ReasoningCapabilities, RedirectTrust, RegistryMapping, StructuredOutputBits,
		ToolCapabilities, TransportKind,
	};

	fn source(kind: ProvenanceKind, origin: &str) -> ProvenanceSource {
		ProvenanceSource {
			kind,
			origin: origin.into_str(),
			revision: None,
			confidence: EvidenceConfidence::Declared,
			observed_at_ms: None,
		}
	}

	fn provider(id: &str, routes: &[&str]) -> ProviderDef {
		ProviderDef {
			id:                 id.into(),
			name:               id.into_str(),
			default_model:      None,
			auth:               Box::new([AuthSpecId::from("auth")]),
			management:         ManagementCapabilities {
				operations:        OperationBits::empty(),
				multiple_accounts: false,
				refresh:           false,
				principal_quota:   false,
			},
			routes:             routes
				.iter()
				.map(|route| RouteId::from(*route))
				.collect::<Vec<_>>()
				.into_boxed_slice(),
			wire_policy:        WirePolicyId::from("wire"),
			discovery_defaults: None,
			mapping:            RegistryMapping::Concrete,
		}
	}

	fn route(id: &str, provider: &str, priority: u32) -> RouteDef {
		RouteDef {
			id:                 id.into(),
			provider:           provider.into(),
			codec:              CodecId::from("codec"),
			codec_profile:      CodecProfile::default(),
			transport:          TransportKind::Http,
			endpoint:           EndpointSpec {
				base_url:    format!("https://{id}.test").into(),
				region:      None,
				api_version: None,
			},
			auth:               AuthSpecId::from("auth"),
			headers:            HeaderProfileId::from("headers"),
			discovery:          None,
			capability_limits:  RouteRestrictions::default(),
			trust_domain:       TrustDomain {
				origin:          format!("https://{id}.test").into(),
				redirects:       RedirectTrust::SameOrigin,
				allow_plaintext: false,
			},
			codex_transport:    CodexTransportPreference::HttpOnly,
			use_responses_lite: None,
			priority:           Some(priority),
		}
	}

	fn model(key: &str, route_ids: &[&str], chat: bool) -> ModelSpec {
		let mut operations = OperationBits::empty();
		let chat_capabilities = chat.then(|| {
			operations.insert_kind(OperationKind::Chat);
			ChatCapabilities {
				roles:             Availability::Native(RoleBits::SYSTEM | RoleBits::DEVELOPER),
				mid_session_roles: Availability::Unknown,
				tools:             Availability::Unknown,
				structured_output: Availability::Native(StructuredOutputBits::JSON_OBJECT),
				grammar:           Availability::Unknown,
				text_verbosity:    Availability::Unknown,
				reasoning:         Availability::Unknown,
				input_modalities:  Availability::Unknown,
				image_input:       Availability::Unknown,
				hosted_tools:      Availability::Unknown,
				prompt_caching:    Availability::Unknown,
				service_tiers:     Availability::Unknown,
				sampling:          Availability::Unknown,
				safety:            Availability::Unknown,
				determinism:       Availability::Unknown,
				server_state:      Availability::Unknown,
				logprobs:          Availability::Unknown,
			}
		});
		ModelSpec {
			key: key.into(),
			class: ClassId::from("class"),
			display_name: key.into_str(),
			wire_ids: route_ids
				.iter()
				.map(|route| (RouteId::from(*route), WireModelId::from(key)))
				.collect::<Vec<_>>()
				.into_boxed_slice(),
			routes: route_ids
				.iter()
				.map(|route| RouteId::from(*route))
				.collect::<Vec<_>>()
				.into_boxed_slice(),
			capabilities: ModelCapabilities {
				operations,
				chat: chat_capabilities,
				embeddings: None,
				image: None,
				video: None,
				speech: None,
				transcription: None,
				realtime: None,
				search: None,
				tokenization: None,
			},
			limits: ModelLimits {
				context_window:        Some(16_000),
				maximum_input_tokens:  Some(14_000),
				maximum_output_tokens: Some(2_000),
				maximum_batch:         None,
			},
			thinking: None,
			thinking_routing: ThinkingRouting::default(),
			wire_policy: WirePolicyId::from("wire"),
			context: ContextStrategy::Replay,
			pricing: Pricing::default(),
			catalog_metrics: CatalogModelMetrics::default(),
			availability: ModelAvailability::Available,
			provenance: ModelProvenance {
				sources:          Box::new([source(ProvenanceKind::Bundled, "base")]),
				updated_at_ms:    None,
				blocked_until_ms: None,
				deprecated:       false,
			},
			context_promotion_target: None,
			compaction_model: None,
			edit_revision: None,
			remote_compaction: None,
			premium_multiplier_millionths: None,
		}
	}

	fn constraints() -> ResolutionConstraints {
		ResolutionConstraints {
			operation:              OperationKind::Chat,
			minimum_context_tokens: None,
			minimum_output_tokens:  None,
			capabilities:           Box::new([]),
		}
	}

	#[test]
	fn precedence_is_field_granular_and_does_not_mutate_bundled_records() {
		let providers = [provider("p", &["r"])];
		let routes = [route("r", "p", 1)];
		let models = [model("m", &["r"], true)];
		let base_name = models[0].display_name.clone();
		let mut resolver = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		resolver
			.add_discovery(CatalogOverlay {
				auth_specs: Box::new([]),
				source:     source(ProvenanceKind::Discovered, "discovery"),
				providers:  Box::new([]),
				models:     Box::new([ModelOverlay {
					selector: ExactSelector::new("p", "m"),
					added:    None,
					patch:    ModelPatch {
						display_name: Some("discovered".into_str()),
						limits: Some(ModelLimits { context_window: Some(32_000), ..models[0].limits }),
						wire_policy: Some(WirePolicyId::from("discovery-wire")),
						..ModelPatch::default()
					},
				}]),
				routes:     Box::new([RouteOverlay {
					route: RouteId::from("r"),
					added: None,
					patch: RoutePatch { priority: Some(Some(2)), ..RoutePatch::default() },
				}]),
				aliases:    Box::new([]),
			})
			.expect("discovery overlay accepted");
		resolver
			.add_user(
				CatalogOverlay {
					auth_specs: Box::new([]),
					source:     source(ProvenanceKind::Configured, "user"),
					providers:  Box::new([]),
					models:     Box::new([ModelOverlay {
						selector: ExactSelector::new("p", "m"),
						added:    None,
						patch:    ModelPatch {
							display_name: Some("configured".into_str()),
							limits: Some(ModelLimits { context_window: Some(64_000), ..models[0].limits }),
							..ModelPatch::default()
						},
					}]),
					routes:     Box::new([RouteOverlay {
						route: RouteId::from("r"),
						added: None,
						patch: RoutePatch { priority: Some(Some(3)), ..RoutePatch::default() },
					}]),
					aliases:    Box::new([]),
				},
				UnsafeTrustScope::NONE,
			)
			.expect("safe user overlay accepted");
		let resolved = resolver
			.resolve(&FallbackChain::exact(ExactSelector::new("p", "m")), &constraints())
			.expect("model resolves");
		assert_eq!(models[0].display_name, base_name);
		assert_eq!(resolved.policy.limits.context_window, Some(64_000));
		assert_eq!(resolved.provenance.model[&ModelField::DisplayName].origin, "user");
		assert_eq!(resolved.provenance.model[&ModelField::Limits].origin, "user");
		assert_eq!(resolved.policy.wire_policy, WirePolicyId::from("discovery-wire"));
		assert_eq!(resolved.provenance.model[&ModelField::WirePolicy].origin, "discovery");
		assert_eq!(routes[0].priority, Some(1));
		assert_eq!(resolved.routes[0].priority, Some(3));
		assert_eq!(
			resolved.provenance.routes[RouteId::from_ref("r")][&RouteField::Priority].origin,
			"user"
		);
	}

	#[test]
	fn endpoint_and_auth_changes_require_their_explicit_unsafe_scope() {
		let providers = [provider("p", &["r"])];
		let routes = [route("r", "p", 1)];
		let models = [model("m", &["r"], true)];
		let make = || CatalogOverlay {
			auth_specs: Box::new([]),
			source:     source(ProvenanceKind::Configured, "user"),
			providers:  Box::new([]),
			models:     Box::new([]),
			routes:     Box::new([RouteOverlay {
				route: RouteId::from("r"),
				added: None,
				patch: RoutePatch {
					endpoint: Some(EndpointSpec {
						base_url:    "https://changed.test".into_str(),
						region:      None,
						api_version: None,
					}),
					auth: Some(AuthSpecId::from("other-auth")),
					..RoutePatch::default()
				},
			}]),
			aliases:    Box::new([]),
		};
		let mut denied = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		assert_eq!(
			denied.add_user(make(), UnsafeTrustScope::NONE),
			Err(ResolveError::UnsafeEndpointChange(RouteId::from("r")))
		);
		let mut endpoint_only = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		assert_eq!(
			endpoint_only.add_user(make(), UnsafeTrustScope::ENDPOINT),
			Err(ResolveError::UnsafeAuthChange(RouteId::from("r")))
		);
		let mut allowed = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		allowed
			.add_user(make(), UnsafeTrustScope::ALL)
			.expect("both scopes explicitly granted");
	}

	#[test]
	fn aliases_and_selectors_are_exact_even_for_adversarial_model_names() {
		let providers = [provider("p", &["r"])];
		let routes = [route("r", "p", 1)];
		let models = [model("gpt", &["r"], true), model("gpt-malicious-thinking", &["r"], true)];
		let aliases = [CatalogAlias {
			alias:      "safe".into_str(),
			target:     ModelKey::from("gpt"),
			rationale:  "test".into_str(),
			provenance: "test".into_str(),
		}];
		let resolver = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &aliases,
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		let alias = FallbackChain {
			primary:   ModelSelector::Alias(AliasSelector::new("p", "safe")),
			fallbacks: Box::new([]),
		};
		assert_eq!(
			resolver
				.resolve(&alias, &constraints())
				.expect("exact alias")
				.selector
				.model,
			"gpt"
		);
		let prefix = FallbackChain {
			primary:   ModelSelector::Alias(AliasSelector::new("p", "saf")),
			fallbacks: Box::new([]),
		};
		assert!(matches!(
			resolver.resolve(&prefix, &constraints()),
			Err(ResolveError::FallbacksExhausted(errors))
				if matches!(&errors[0], ResolveError::AliasNotFound(alias) if alias.alias == "saf")
		));
		assert_eq!(
			resolver
				.resolve(
					&FallbackChain::exact(ExactSelector::new("p", "gpt-malicious-thinking")),
					&constraints()
				)
				.expect("adversarial exact model")
				.selector
				.model,
			"gpt-malicious-thinking"
		);
	}

	#[test]
	fn alias_precedence_is_bundled_then_discovery_then_user() {
		let providers = [provider("p", &["r"])];
		let routes = [route("r", "p", 1)];
		let models = [
			model("bundled", &["r"], true),
			model("discovered", &["r"], true),
			model("user", &["r"], true),
		];
		let aliases = [CatalogAlias {
			alias:      "current".into_str(),
			target:     ModelKey::from("bundled"),
			rationale:  "test".into_str(),
			provenance: "test".into_str(),
		}];
		let mut resolver = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &aliases,
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		resolver
			.add_discovery(CatalogOverlay {
				auth_specs: Box::new([]),
				source:     source(ProvenanceKind::Discovered, "discovery"),
				providers:  Box::new([]),
				models:     Box::new([]),
				routes:     Box::new([]),
				aliases:    Box::new([ScopedAlias {
					provider:   ProviderId::from("p"),
					definition: CatalogAlias {
						alias:      "current".into_str(),
						target:     ModelKey::from("discovered"),
						rationale:  "test".into_str(),
						provenance: "discovery".into_str(),
					},
				}]),
			})
			.expect("discovery alias accepted");
		resolver
			.add_user(
				CatalogOverlay {
					auth_specs: Box::new([]),
					source:     source(ProvenanceKind::Configured, "user"),
					providers:  Box::new([]),
					models:     Box::new([]),
					routes:     Box::new([]),
					aliases:    Box::new([ScopedAlias {
						provider:   ProviderId::from("p"),
						definition: CatalogAlias {
							alias:      "current".into_str(),
							target:     ModelKey::from("user"),
							rationale:  "test".into_str(),
							provenance: "user".into_str(),
						},
					}]),
				},
				UnsafeTrustScope::NONE,
			)
			.expect("user alias accepted");
		let chain = FallbackChain {
			primary:   ModelSelector::Alias(AliasSelector::new("p", "current")),
			fallbacks: Box::new([]),
		};
		assert_eq!(
			resolver
				.resolve(&chain, &constraints())
				.expect("highest alias wins")
				.selector
				.model,
			"user"
		);
	}

	#[test]
	fn fallback_order_and_route_ties_are_deterministic_and_never_implicit() {
		let providers = [provider("p", &["z", "a"])];
		let routes = [route("z", "p", 7), route("a", "p", 7)];
		let models = [
			model("unknown", &["z"], false),
			model("good", &["z", "a"], true),
			model("also-good", &["a"], true),
		];
		let resolver = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		let explicit = FallbackChain {
			primary:   ModelSelector::Exact(ExactSelector::new("p", "unknown")),
			fallbacks: Box::new([
				ModelSelector::Exact(ExactSelector::new("p", "good")),
				ModelSelector::Exact(ExactSelector::new("p", "also-good")),
			]),
		};
		let resolved = resolver
			.resolve(&explicit, &constraints())
			.expect("explicit fallback succeeds");
		assert_eq!(resolved.selector.model, "good");
		assert_eq!(
			resolved
				.routes
				.iter()
				.map(|route| route.id.as_str())
				.collect::<Vec<_>>(),
			["a", "z"]
		);
		let no_fallback = FallbackChain::exact(ExactSelector::new("p", "unknown"));
		assert!(
			matches!(resolver.resolve(&no_fallback, &constraints()), Err(ResolveError::FallbacksExhausted(errors)) if errors.len() == 1)
		);
	}

	#[test]
	fn typed_constraints_require_positive_evidence() {
		let providers = [provider("p", &["r"])];
		let routes = [route("r", "p", 1)];
		let models = [model("m", &["r"], true)];
		let resolver = CatalogResolver::new(BundledCatalog {
			providers: &providers,
			routes:    &routes,
			models:    &models,
			aliases:   &[],
			source:    source(ProvenanceKind::Bundled, "base"),
		});
		let required = ResolutionConstraints {
			operation:              OperationKind::Chat,
			minimum_context_tokens: Some(8_000),
			minimum_output_tokens:  Some(1_000),
			capabilities:           Box::new([
				CapabilityConstraint::StructuredOutput(StructuredOutputBits::JSON_OBJECT),
				CapabilityConstraint::Grammar(GrammarBits::EBNF),
			]),
		};
		assert!(matches!(
			resolver.resolve(&FallbackChain::exact(ExactSelector::new("p", "m")), &required),
			Err(ResolveError::FallbacksExhausted(errors))
				if matches!(&errors[0], ResolveError::Constraints { failures, .. }
					if failures.contains(&ConstraintFailure::Unknown(CapabilityConstraint::Grammar(GrammarBits::EBNF))))
		));
	}
	#[test]
	fn native_default_tools_and_reasoning_satisfy_typed_constraints() {
		let mut capabilities = model("m", &["r"], true).capabilities;
		let chat = capabilities.chat.as_mut().expect("chat capabilities");
		chat.tools = Availability::Native(ToolCapabilities {
			features:      ToolFeatureBits::empty(),
			maximum_tools: None,
		});
		chat.reasoning = Availability::Native(ReasoningCapabilities {
			features:              ReasoningFeatureBits::EFFORT,
			efforts:               Box::new([]),
			minimum_budget_tokens: None,
			maximum_budget_tokens: None,
		});
		assert!(matches!(
			capability_support(
				&capabilities,
				&CapabilityConstraint::ToolFeatures(ToolFeatureBits::empty())
			),
			CapabilitySupport::Supported
		));
		assert!(matches!(
			capability_support(
				&capabilities,
				&CapabilityConstraint::Reasoning(ReasoningFeatureBits::EFFORT)
			),
			CapabilitySupport::Supported
		));
	}
}
