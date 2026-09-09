//! Model limits, context, provenance, and wire-target records.
#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	capability::{CacheRetentionBits, ModelCapabilities},
	id::{
		CatalogRevision, ClassId, CodecId, ModelKey, RouteId, ThinkingPolicyId, WireModelId,
		WirePolicyId,
	},
	pricing::{PremiumMultiplier, Pricing},
	provider::EndpointSpec,
	thinking::ThinkingRouting,
};

/// Token and batch limits attached to a model deployment.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelLimits {
	/// Total context window in tokens, or `None` when unknown.
	pub context_window:        Option<u64>,
	/// Maximum input tokens, or `None` when only total context is known.
	pub maximum_input_tokens:  Option<u64>,
	/// Maximum generated output tokens, or `None` when unknown.
	pub maximum_output_tokens: Option<u64>,
	/// Maximum operation batch size, or `None` when operation-specific limits
	/// apply.
	pub maximum_batch:         Option<u32>,
}

/// Prefix-cache behavior for replayed canonical conversation context.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PrefixCachePolicy {
	/// Cache retention classes usable for conversation prefixes.
	pub retention:             CacheRetentionBits,
	/// Minimum cacheable prefix length in tokens, if known.
	pub minimum_prefix_tokens: Option<u32>,
	/// Maximum explicit cache breakpoints, if bounded.
	pub maximum_breakpoints:   Option<u8>,
}

/// Provider-side conversation state lifetime and invalidation behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServerStatePolicy {
	/// Whether the provider reports handle expiry evidence.
	pub expiry_evidence:             bool,
	/// Whether a credential refresh for the same principal invalidates handles.
	pub credential_generation_bound: bool,
	/// Maximum handle lifetime in milliseconds, if known.
	pub maximum_lifetime_ms:         Option<u64>,
}

/// How canonical conversation history reaches the selected route.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextStrategy {
	/// Replays canonical history on every turn.
	Replay,
	/// Replays history with deterministic cache identity and breakpoints.
	PrefixCache(PrefixCachePolicy),
	/// Continues from a typed provider state handle and sends only a delta.
	ServerState(ServerStatePolicy),
}

/// Typed provider-side compaction target kept out of router-facing records.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelRemoteCompaction {
	/// Whether remote compaction is explicitly enabled.
	pub enabled:              Option<bool>,
	/// Transport used by the compaction endpoint, when it differs from the model
	/// route.
	pub transport:            Option<CodecId>,
	/// Primary remote compaction endpoint.
	pub endpoint:             Option<Str>,
	/// Whether the provider's version-two streaming protocol is enabled.
	pub v2_streaming_enabled: Option<bool>,
	/// Version-two remote compaction endpoint.
	pub v2_endpoint:          Option<Str>,
	/// Streaming remote compaction endpoint.
	pub streaming_endpoint:   Option<Str>,
	/// Opaque wire model identifier used for remote compaction.
	pub model:                Option<WireModelId>,
	/// Token count at which remote compaction should start, if declared.
	pub trigger_tokens:       Option<u64>,
	/// Desired post-compaction token count, if declared.
	pub target_tokens:        Option<u64>,
}

/// Source class for catalog evidence.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum ProvenanceKind {
	/// Fact shipped in the deterministic bundled catalog.
	Bundled,
	/// Fact reported by runtime provider discovery.
	Discovered,
	/// Fact supplied by explicit user configuration.
	Configured,
}

/// Confidence assigned to one evidence source.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum EvidenceConfidence {
	/// Behavior was directly verified against the provider.
	Verified,
	/// Behavior was declared by an authoritative provider source.
	Declared,
	/// Behavior was inferred by compiler or discovery normalization rules.
	Inferred,
	/// The source provides no confidence evidence.
	Unknown,
}

/// Auditable origin of one or more model facts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProvenanceSource {
	/// Overlay class of this source.
	pub kind:           ProvenanceKind,
	/// Stable source name or content address.
	pub origin:         Str,
	/// Catalog revision that incorporated the source.
	pub revision:       Option<CatalogRevision>,
	/// Evidence confidence.
	pub confidence:     EvidenceConfidence,
	/// Observation time in Unix milliseconds, if available.
	pub observed_at_ms: Option<u64>,
}

/// Model-level availability state independent of feature availability.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum ModelAvailability {
	/// Availability has not been established.
	Unspecified,
	/// Model is selectable with an eligible account.
	Available,
	/// Model requires an authenticated principal.
	LoginRequired,
	/// Provider temporarily blocks selection.
	Blocked,
	/// Catalog or user configuration disables selection.
	Disabled,
}

/// Auditable source and lifecycle facts for one model record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelProvenance {
	/// Ordered evidence sources after overlay resolution.
	pub sources:          Box<[ProvenanceSource]>,
	/// Latest known provider update time in Unix milliseconds.
	pub updated_at_ms:    Option<u64>,
	/// Temporary block expiry in Unix milliseconds.
	pub blocked_until_ms: Option<u64>,
	/// Whether the provider declares this deployment deprecated.
	pub deprecated:       bool,
}

/// Catalog-estimated model quality and output throughput.
///
/// Values use millionth precision so catalog snapshots remain deterministic and
/// never depend on floating-point serialization.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CatalogModelMetrics {
	/// Intelligence score multiplied by one million.
	pub intelligence_millionths:             Option<u32>,
	/// Estimated output tokens per second multiplied by one million.
	pub output_tokens_per_second_millionths: Option<u32>,
}

const _: () =
	assert!(std::mem::size_of::<CatalogModelMetrics>() <= 16, "catalog metrics must stay compact");

/// Selectable model deployment and its route-specific wire identifiers.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelSpec {
	/// Stable normalized model key.
	pub key: ModelKey,
	/// Normalized model class (vendor lineage).
	pub class: ClassId,
	/// Human-readable display name.
	pub display_name: Str,
	/// Opaque wire identifiers paired with their routes.
	pub wire_ids: Box<[(RouteId, WireModelId)]>,
	/// Eligible routes in deterministic preference order.
	pub routes: Box<[RouteId]>,
	/// Typed operation and feature capabilities.
	pub capabilities: ModelCapabilities,
	/// Token and batch limits.
	pub limits: ModelLimits,
	/// Optional interned reasoning policy.
	pub thinking: Option<ThinkingPolicyId>,
	/// Model-specific native effort spellings and wire-model routing.
	pub thinking_routing: ThinkingRouting,
	/// Interned wire-lowering and recovery policy.
	pub wire_policy: WirePolicyId,
	/// Conversation context strategy.
	pub context: ContextStrategy,
	/// Integer-only price schedule.
	pub pricing: Pricing,
	/// Catalog-estimated quality and output throughput.
	pub catalog_metrics: CatalogModelMetrics,
	/// Model availability state.
	pub availability: ModelAvailability,
	/// Auditable source and lifecycle facts.
	pub provenance: ModelProvenance,
	/// Normalized model selected when the current context must be promoted.
	pub context_promotion_target: Option<ModelKey>,
	/// Model selected for local context compaction.
	pub compaction_model: Option<ModelKey>,
	/// Preferred edit-tool contract revision for this model.
	pub edit_revision: Option<Str>,
	/// Optional provider-side context compaction contract.
	pub remote_compaction: Option<ModelRemoteCompaction>,
	/// Premium quota multiplier at millionth precision.
	pub premium_multiplier_millionths: Option<PremiumMultiplier>,
}

/// Router-facing model facts with no logical or wire model identifier.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PolicyModel {
	/// Normalized class used only for compiler-resolved policy grouping.
	pub class: ClassId,
	/// Typed operation and feature capabilities.
	pub capabilities: ModelCapabilities,
	/// Token and batch limits.
	pub limits: ModelLimits,
	/// Optional interned reasoning policy.
	pub thinking: Option<ThinkingPolicyId>,
	/// Model-specific native effort spellings and wire-model routing.
	pub thinking_routing: ThinkingRouting,
	/// Interned wire-lowering and recovery policy.
	pub wire_policy: WirePolicyId,
	/// Conversation context strategy.
	pub context: ContextStrategy,
	/// Integer-only price schedule.
	pub pricing: Pricing,
	/// Model availability state.
	pub availability: ModelAvailability,
	/// Auditable source and lifecycle facts.
	pub provenance: ModelProvenance,
	/// Model selected for local context compaction.
	pub compaction_model: Option<ModelKey>,
	/// Preferred edit-tool contract revision for this model.
	pub edit_revision: Option<Str>,
	/// Premium quota multiplier at millionth precision.
	pub premium_multiplier_millionths: Option<PremiumMultiplier>,
}

impl From<&ModelSpec> for PolicyModel {
	fn from(model: &ModelSpec) -> Self {
		Self {
			class: model.class.clone(),
			capabilities: model.capabilities.clone(),
			limits: model.limits,
			thinking: model.thinking.clone(),
			thinking_routing: model.thinking_routing.clone(),
			wire_policy: model.wire_policy.clone(),
			context: model.context,
			pricing: model.pricing.clone(),
			availability: model.availability,
			provenance: model.provenance.clone(),
			compaction_model: model.compaction_model.clone(),
			edit_revision: model.edit_revision.clone(),
			premium_multiplier_millionths: model.premium_multiplier_millionths,
		}
	}
}

/// Codec-facing endpoint and opaque wire model selection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WireTarget {
	/// Selected route.
	pub route:      RouteId,
	/// Selected codec.
	pub codec:      CodecId,
	/// Concrete endpoint configuration.
	pub endpoint:   EndpointSpec,
	/// Opaque wire model identifier used only while encoding.
	pub wire_model: WireModelId,
}
