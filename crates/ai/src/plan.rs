//! Credential-free, immutable execution plans and capability negotiation
//! evidence.
use std::{
	collections::BTreeMap,
	sync::Arc,
	time,
	time::{Duration, Instant},
};

use omp_core::{Str, sf};
use parking_lot::Mutex;

use crate::{
	call::{Call, ChatRequest, ContentPart, Message, Role, Setting, ToolChoice},
	catalog::{
		CatalogRevision, CodecId, Emulation, ModelKey, OperationKind, PolicyModel, ProviderId,
		RouteId, ThinkingPolicy, ThinkingSelection, WirePolicy, WireTarget,
	},
	error::{Error, ErrorDetail, ErrorKind},
	receipt::{
		Adjustment, ExecutionBudget, ExecutionReceipt, FeatureId, Penalty, ReasonId, Replayability,
	},
};

/// Whether a caller expressed a hard requirement or an adjustable preference.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequirementStrength {
	/// Planning fails unless the capability is satisfied.
	Required,
	/// Planning may continue only with explicit adjustment evidence.
	Preferred,
}

/// One feature requested from a selected model and route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityRequirement {
	/// Stable feature identity.
	pub feature:  FeatureId,
	/// Whether absence is fatal or adjustable.
	pub strength: RequirementStrength,
}

/// Route-scoped evidence for a requested capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityEvidence {
	/// Stable feature identity.
	pub feature:      FeatureId,
	/// Native, emulated, unsupported, or unknown route behavior.
	pub availability: CapabilityAvailability,
	/// Evidence provenance or constraint result.
	pub reason:       ReasonId,
}

/// Constraint-checked capability availability used by the planner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityAvailability {
	/// The selected codec and route implement the capability directly.
	Native,
	/// The runtime can reproduce the requested behavior by an explicit method.
	Emulated(Emulation),
	/// Available evidence proves the behavior cannot be provided.
	Unsupported,
	/// Available evidence does not establish support or non-support.
	Unknown,
}

/// The decision made for one requested capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NegotiationDecision {
	/// The selected route provides the feature natively.
	Native {
		/// Requested feature.
		feature: FeatureId,
	},
	/// The selected route provides the feature through an allowed emulation.
	Emulated {
		/// Requested feature.
		feature: FeatureId,
		/// Authorized emulation method.
		method:  Emulation,
	},
	/// An unknown preferred feature was accepted under explicit best-effort
	/// policy.
	UnknownAccepted {
		/// Requested feature.
		feature: FeatureId,
		/// Evidence reason for accepting unknown support.
		reason:  ReasonId,
	},
	/// A preferred feature was dropped with receipt evidence.
	Dropped {
		/// Requested feature.
		feature: FeatureId,
		/// Evidence reason for dropping the feature.
		reason:  ReasonId,
	},
}

/// Caller policy governing native, emulated, unknown, and dropped behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct PlanningPolicy {
	/// Whether native support is mandatory for required features.
	pub allow_emulation:           bool,
	/// Whether lossy emulation is allowed when the catalog labels it explicitly.
	pub allow_lossy_emulation:     bool,
	/// Whether unknown support may satisfy a preference.
	pub allow_unknown_preferences: bool,
	/// Whether unsupported preferences may be dropped with an adjustment.
	pub allow_dropped_preferences: bool,
}

/// Per-route ceilings used to assign model-visible constraint slots.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ConstraintBudgetCaps {
	/// Maximum advertised tool declarations, when constrained by the route.
	pub maximum_tools:  Option<u16>,
	/// Maximum native strict-schema declarations, when constrained by the
	/// route.
	pub maximum_strict: Option<u16>,
}

/// One already-registered model-visible intent competing for route capacity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConstraintIntent {
	/// Declaration priority; larger values are preferred.
	pub priority: u8,
	/// Whether this intent consumes a native strict-schema slot.
	pub strict:   bool,
}

/// Stable per-route assignment for one registration-set epoch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConstraintAssignment {
	/// Indices of intents assigned a model-visible tool slot.
	pub advertised: Arc<[usize]>,
	/// Indices omitted because the route's bounded capacity was exhausted.
	pub dropped:    Arc<[usize]>,
}

#[derive(Default)]
struct ConstraintBudgetCache {
	assignments: BTreeMap<([u8; 32], RouteId), Arc<ConstraintAssignment>>,
}

/// Caches priority-ordered constraint assignments by slot-set epoch and route.
///
/// The cache key deliberately uses the core-slot-only hash rather than a
/// worker-inclusive registry hash: changing a host device must not invalidate
/// a model prompt prefix.
#[derive(Default)]
pub struct ConstraintBudget {
	cache: Mutex<ConstraintBudgetCache>,
}

impl ConstraintBudget {
	/// Assigns a stable set of advertised constraint slots for one route.
	///
	/// The same `(slot_hash, route)` reuses its assignment. A changed live set
	/// supplies a new hash; choosing a different route supplies a new route id.
	pub fn assign(
		&self,
		slot_hash: [u8; 32],
		route: &RouteId<str>,
		caps: ConstraintBudgetCaps,
		intents: &[ConstraintIntent],
	) -> Arc<ConstraintAssignment> {
		let key = (slot_hash, route.to_owned());
		let mut cache = self.cache.lock();
		if let Some(assignment) = cache.assignments.get(&key) {
			return Arc::clone(assignment);
		}

		let mut ordered = (0..intents.len()).collect::<Vec<_>>();
		ordered.sort_by(|left, right| {
			intents[*right]
				.priority
				.cmp(&intents[*left].priority)
				.then_with(|| left.cmp(right))
		});
		let mut advertised = Vec::with_capacity(intents.len());
		let mut dropped = Vec::new();
		let mut strict = 0_usize;
		for index in ordered {
			if caps
				.maximum_tools
				.is_some_and(|limit| advertised.len() >= limit as usize)
				|| (intents[index].strict
					&& caps
						.maximum_strict
						.is_some_and(|limit| strict >= limit as usize))
			{
				dropped.push(index);
				continue;
			}
			if intents[index].strict {
				strict = strict.saturating_add(1);
			}
			advertised.push(index);
		}
		let assignment = Arc::new(ConstraintAssignment {
			advertised: advertised.into(),
			dropped:    dropped.into(),
		});
		cache.assignments.insert(key, Arc::clone(&assignment));
		assignment
	}

	/// Drops cached assignments retired with an old core-slot registration set.
	pub fn retain_slot_hash(&self, slot_hash: [u8; 32]) {
		self
			.cache
			.lock()
			.assignments
			.retain(|(cached, _), _| *cached == slot_hash);
	}
}
/// Caller-authorized behavior when a pinned model cannot be selected.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ModelFallback {
	/// Refuse the request; a pinned model is never silently substituted.
	#[default]
	Deny,
	/// Explicitly substitute the parent session model and receipt the change.
	Parent,
	/// Try only the caller's explicit ordered fallback chain.
	Chain,
}

/// Stable prompt instruction supplied on every forced-call attempt.
pub const FORCED_CALL_DIRECTIVE: &str =
	"Call the requested tool next. Do not answer in text before calling it.";

/// Route facts used to choose a forced-call enforcement rung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcedCallCaps {
	/// Native tool-call capabilities declared by the selected route.
	pub features:       omp_catalog::ToolFeatureBits,
	/// Whether this exact wire dialect accepts a forced selector.
	pub forced_choice:  Option<bool>,
	/// Provider-declared price of setting native `tool_choice`.
	pub native_penalty: Option<Penalty>,
}

impl ForcedCallCaps {
	/// Builds ladder capabilities from route features and compiled wire policy.
	pub const fn from_wire_policy(
		features: omp_catalog::ToolFeatureBits,
		native_penalty: Option<Penalty>,
		policy: &WirePolicy,
	) -> Self {
		Self { features, forced_choice: policy.tool.forced_choice, native_penalty }
	}
}

/// Chosen forced-call enforcement rung for one attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcedCallDecision {
	/// Soft prompt insertion is always required for a forced call.
	pub soft_prompt:   bool,
	/// Whether the request may carry a native forcing flag this attempt.
	pub native_choice: bool,
	/// Evidence of an expensive final-rung escalation.
	pub escalation:    Option<Adjustment>,
}

/// Chooses the forced-call ladder without provider-name special cases.
pub fn forced_call_ladder(
	choice: &Setting<ToolChoice>,
	caps: ForcedCallCaps,
	non_compliant: bool,
	escalations_left: u8,
) -> ForcedCallDecision {
	let forced = matches!(
		choice,
		crate::call::Setting::Require(
			crate::call::ToolChoice::Required | crate::call::ToolChoice::Named(_)
		) | crate::call::Setting::Prefer(
			crate::call::ToolChoice::Required | crate::call::ToolChoice::Named(_)
		)
	);
	if !forced {
		return ForcedCallDecision {
			soft_prompt:   false,
			native_choice: false,
			escalation:    None,
		};
	}
	let native_supported = caps.forced_choice == Some(true)
		&& match choice {
			Setting::Require(ToolChoice::Named(_)) | Setting::Prefer(ToolChoice::Named(_)) => caps
				.features
				.contains(omp_catalog::ToolFeatureBits::NAMED_CHOICE),
			_ => caps
				.features
				.contains(omp_catalog::ToolFeatureBits::REQUIRED_CHOICE),
		};
	let escalation = (non_compliant && escalations_left != 0 && native_supported)
		.then(|| caps.native_penalty.clone())
		.flatten()
		.map(|penalty| Adjustment::Escalated { feature: FeatureId(sf!("tool_choice")), penalty });
	ForcedCallDecision {
		soft_prompt: true,
		native_choice: native_supported && (caps.native_penalty.is_none() || escalation.is_some()),
		escalation,
	}
}

/// Applies a forced-call decision to canonical chat input before encoding.
///
/// The soft prompt is the last message of the transcript, as a user turn
/// This keeps the forced choice out of the cached prefix.
/// Anything earlier — a leading system message, or a system message
/// hoisted into Anthropic's `system` array — rewrites the cached prefix and
/// re-bills the whole conversation, the very cost ADR 0019 keeps the soft
/// rung free of. Codecs merge the turn into a trailing user message.
pub fn apply_forced_call_decision(
	request: &ChatRequest,
	decision: &ForcedCallDecision,
) -> ChatRequest {
	let mut adjusted = request.clone();
	if decision.soft_prompt {
		let mut messages = Vec::with_capacity(request.messages.len().saturating_add(1));
		messages.extend(request.messages.iter().cloned());
		messages.push(Message {
			role:    Role::User,
			content: Arc::from([ContentPart::Text { text: sf!(FORCED_CALL_DIRECTIVE), proof: None }]),
			name:    None,
		});
		adjusted.messages = messages.into();
		if !decision.native_choice {
			adjusted.tool_choice = Setting::Prefer(ToolChoice::Auto);
		}
	}
	adjusted
}

/// A typed codec-specific option requested by an operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeOptionRequirement {
	/// Codec that alone may serialize the option.
	pub codec:    CodecId,
	/// Whether a mismatch is fatal or may be dropped with evidence.
	pub strength: RequirementStrength,
	/// Stable feature identity used in errors and receipts.
	pub feature:  FeatureId,
}

/// Explicit input-body facts used to reject unsafe multi-attempt plans.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayRequirements {
	/// Aggregate replayability of every operation body component.
	pub replayability:           Replayability,
	/// Whether planning may require a semantic retry behind an output gate.
	pub semantic_retry_possible: bool,
	/// Whether secure staging was explicitly requested by the caller.
	pub staging_explicit:        bool,
	/// Maximum body bytes the caller permits staging.
	pub staging_limit:           Option<u64>,
}

impl Default for ReplayRequirements {
	fn default() -> Self {
		Self {
			replayability:           Replayability::Replayable,
			semantic_retry_possible: false,
			staging_explicit:        false,
			staging_limit:           None,
		}
	}
}

/// How the plan will make body data available to attempts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayPlan {
	/// Every attempt opens an independent replayable source.
	Replayable,
	/// Exactly one attempt is permitted and automatic fallback is suppressed.
	OneShotSingleAttempt,
	/// Explicit secure staging must complete before the first attempt.
	SecureStaging {
		/// Maximum bytes eligible for secure staging.
		maximum_bytes: u64,
	},
}

/// Health evidence for one concrete route service.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RouteHealth {
	/// Recent probes or attempts establish that the route is healthy.
	Healthy,
	/// No runtime observation is available.
	Unknown,
	/// The route remains usable but has degraded observations.
	Degraded,
	/// The route is not currently eligible for execution.
	Unavailable,
}

/// Route-scoped, credential-free runtime capability and ranking evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeRouteEvidence {
	/// Route whose runtime state was observed.
	pub route:            RouteId,
	/// Monotonic registry state generation.
	pub generation:       u64,
	/// Current route health classification.
	pub health:           RouteHealth,
	/// Remaining quota score in millionths, where larger is preferred.
	pub quota_millionths: u32,
	/// Smoothed end-to-end latency used for deterministic ranking.
	pub latency:          Duration,
	/// Whether an existing session or account binding prefers this route.
	pub affinity:         bool,
	/// Route-specific operation support observed at runtime.
	pub operation:        CapabilityAvailability,
	/// Route-specific requested-feature evidence.
	pub capabilities:     Arc<[CapabilityEvidence]>,
}

/// Exact caller-authorized model sequence retained by a plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackScope {
	/// Primary normalized model selected by the exact selector, absent for
	/// management operations.
	pub primary:  Option<ModelKey>,
	/// Ordered normalized models explicitly named as fallbacks.
	pub explicit: Arc<[ModelKey]>,
}

/// Clone-cheap side-effect-free planner used by typed clients.
pub trait Planner: Clone + Send + Sync + 'static {
	/// Applies immutable planning settings to the real call, then produces its
	/// credential-free execution plan.
	fn plan(&self, call: &mut Call, now: Instant) -> Result<ExecutionPlan, Error>;

	/// Revalidates expiry, catalog revision, and volatile registry generation.
	fn validate(&self, plan: &ExecutionPlan, now: Instant) -> Result<(), Error>;
}

/// One exact, already-negotiated route authorized for pre-commit fallback.
#[derive(Clone, Debug)]
pub struct PlannedFallback {
	/// Normalized model, absent only for model-less management operations.
	pub model:              Option<ModelKey>,
	/// Provider domain.
	pub provider:           ProviderId,
	/// Concrete route.
	pub route:              RouteId,
	/// Codec used by the route.
	pub codec:              CodecId,
	/// Exact interned wire-lowering policy.
	pub wire_policy:        Arc<WirePolicy>,
	/// Exact optional thinking policy.
	pub thinking_policy:    Option<Arc<ThinkingPolicy>>,
	/// Fully resolved thinking selection for this route.
	pub thinking_selection: Option<ThinkingSelection>,
	/// Candidate-specific capability negotiation outcomes.
	pub decisions:          Arc<[NegotiationDecision]>,
	/// Router-facing model facts.
	pub policy_model:       Option<Arc<PolicyModel>>,
	/// Exact codec-facing target.
	pub wire_target:        Option<WireTarget>,
	/// Route-scoped runtime evidence.
	pub runtime_evidence:   RuntimeRouteEvidence,
}

/// Immutable, credential-free execution plan.
#[derive(Clone, Debug)]
pub struct ExecutionPlan {
	/// Wall-clock instant captured during side-effect-free planning for
	/// time-sensitive policy.
	pub planned_at:          time::SystemTime,
	/// Catalog revision against which selection and negotiation ran.
	pub catalog_revision:    CatalogRevision,
	/// Registry generation against which route services were inspected.
	pub registry_generation: u64,
	/// Absolute time after which volatile evidence must be replanned.
	pub expires_at:          Instant,
	/// Planned operation kind.
	pub operation:           OperationKind,
	/// Selected normalized model for model-scoped operations.
	pub model:               Option<ModelKey>,
	/// Selected provider domain.
	pub provider:            ProviderId,
	/// Selected concrete route.
	pub route:               RouteId,
	/// Selected codec.
	pub codec:               CodecId,
	/// Router-facing catalog facts; absent for model-less management operations.
	pub policy_model:        Option<Arc<PolicyModel>>,
	/// Exact interned wire policy selected for encoding.
	pub wire_policy:         Arc<WirePolicy>,
	/// Exact optional thinking policy selected for model-scoped encoding.
	pub thinking_policy:     Option<Arc<ThinkingPolicy>>,
	/// Fully resolved effort, budget, reasoning mode, and opaque wire model.
	pub thinking_selection:  Option<ThinkingSelection>,
	/// Capability negotiation outcomes.
	pub decisions:           Arc<[NegotiationDecision]>,
	/// Exact caller-authorized model fallback scope.
	pub fallback_scope:      FallbackScope,
	/// Ordered exact fallback routes authorized during planning; no runtime
	/// candidate invention.
	pub fallbacks:           Arc<[PlannedFallback]>,
	/// Input replay or staging behavior required before execution.
	pub replay:              ReplayPlan,
	/// Cross-attempt budget copied from the request.
	pub budget:              ExecutionBudget,
	/// Route-scoped runtime facts used during planning.
	pub runtime_evidence:    RuntimeRouteEvidence,
	pub(crate) wire_target:  Option<WireTarget>,
}

impl ExecutionPlan {
	/// Rejects an expired plan or a plan produced for different catalog/registry
	/// state.
	pub fn validate(
		&self,
		now: Instant,
		catalog_revision: &CatalogRevision<str>,
		registry_generation: u64,
	) -> Result<(), Error> {
		if plan_is_current(
			now,
			self.expires_at,
			&self.catalog_revision,
			catalog_revision,
			self.registry_generation,
			registry_generation,
		) {
			return Ok(());
		}

		Err(Error::planning(
			ErrorKind::StalePlan,
			ErrorDetail::stale_plan(
				Str::new(self.catalog_revision.as_str()),
				if now > self.expires_at {
					sf!("expired")
				} else if &self.catalog_revision != catalog_revision {
					Str::new(catalog_revision.as_str())
				} else {
					sf!("registry-state-changed")
				},
			),
			ExecutionReceipt::default(),
		))
	}

	/// Borrows the codec-only wire target at the encoding boundary.
	pub(crate) const fn wire_target(&self) -> Option<&WireTarget> {
		self.wire_target.as_ref()
	}
}

fn plan_is_current(
	now: Instant,
	expires_at: Instant,
	planned_revision: &CatalogRevision<str>,
	current_revision: &CatalogRevision<str>,
	planned_generation: u64,
	current_generation: u64,
) -> bool {
	now <= expires_at
		&& planned_revision.as_str() == current_revision.as_str()
		&& planned_generation == current_generation
}

/// Negotiates requested capabilities without acquiring credentials or touching
/// a network.
pub fn negotiate(
	requirements: &[CapabilityRequirement],
	evidence: &[CapabilityEvidence],
	policy: PlanningPolicy,
) -> Result<(Vec<NegotiationDecision>, Vec<Adjustment>), Error> {
	let mut decisions = Vec::with_capacity(requirements.len());
	let mut adjustments = Vec::new();
	for requirement in requirements {
		let observed = evidence
			.iter()
			.find(|item| item.feature == requirement.feature);
		let availability = observed.map_or(CapabilityAvailability::Unknown, |item| item.availability);
		let reason =
			observed.map_or_else(|| ReasonId(sf!("no-route-evidence")), |item| item.reason.clone());

		match availability {
			CapabilityAvailability::Native => {
				decisions.push(NegotiationDecision::Native { feature: requirement.feature.clone() });
			},
			CapabilityAvailability::Emulated(method)
				if policy.allow_emulation
					&& (policy.allow_lossy_emulation || emulation_is_lossless(method)) =>
			{
				decisions.push(NegotiationDecision::Emulated {
					feature: requirement.feature.clone(),
					method,
				});
			},
			CapabilityAvailability::Unknown
				if requirement.strength == RequirementStrength::Preferred
					&& policy.allow_unknown_preferences =>
			{
				decisions.push(NegotiationDecision::UnknownAccepted {
					feature: requirement.feature.clone(),
					reason,
				});
			},
			CapabilityAvailability::Unsupported
				if requirement.strength == RequirementStrength::Preferred
					&& policy.allow_dropped_preferences =>
			{
				decisions.push(NegotiationDecision::Dropped {
					feature: requirement.feature.clone(),
					reason:  reason.clone(),
				});
				adjustments.push(Adjustment::Dropped { feature: requirement.feature.clone(), reason });
			},
			CapabilityAvailability::Unknown => {
				return Err(capability_error(ErrorKind::CapabilityUnknown, requirement, reason));
			},
			CapabilityAvailability::Unsupported | CapabilityAvailability::Emulated(_) => {
				return Err(capability_error(ErrorKind::CapabilityMismatch, requirement, reason));
			},
		}
	}
	Ok((decisions, adjustments))
}

/// Validates a codec-specific option before any authentication or encoding
/// occurs.
pub fn negotiate_native_option(
	requirement: Option<&NativeOptionRequirement>,
	selected_codec: &CodecId<str>,
	allow_drop_preferred: bool,
) -> Result<Option<NegotiationDecision>, Error> {
	let Some(requirement) = requirement else {
		return Ok(None);
	};
	if requirement.codec.as_str() == selected_codec.as_str() {
		return Ok(Some(NegotiationDecision::Native { feature: requirement.feature.clone() }));
	}
	if requirement.strength == RequirementStrength::Preferred && allow_drop_preferred {
		return Ok(Some(NegotiationDecision::Dropped {
			feature: requirement.feature.clone(),
			reason:  ReasonId(sf!("native-option-codec-mismatch")),
		}));
	}
	Err(Error::planning(
		ErrorKind::CodecMismatch,
		ErrorDetail::capability(
			Str::new(requirement.feature.0.as_str()),
			ReasonId(sf!("native-option-codec-mismatch")),
		),
		ExecutionReceipt::default(),
	))
}

/// Derives explicit retry/staging behavior from aggregate body evidence.
pub fn plan_replay(
	requirements: &ReplayRequirements,
	budget: &ExecutionBudget,
) -> Result<ReplayPlan, Error> {
	match requirements.replayability {
		Replayability::Replayable | Replayability::Staged => Ok(ReplayPlan::Replayable),
		Replayability::OneShot
			if requirements.semantic_retry_possible
				|| (requirements.staging_explicit && budget.max_attempts > 1) =>
		{
			if !requirements.staging_explicit {
				return Err(replay_error(
					ErrorKind::StagingRequired,
					"semantic-retry-requires-explicit-staging",
				));
			}
			let maximum_bytes = requirements
				.staging_limit
				.unwrap_or(0)
				.min(budget.max_staging_bytes);
			if maximum_bytes == 0 {
				return Err(replay_error(ErrorKind::StagingRequired, "staging-budget-is-zero"));
			}
			Ok(ReplayPlan::SecureStaging { maximum_bytes })
		},
		Replayability::OneShot if budget.max_attempts > 1 => {
			Err(replay_error(ErrorKind::ReplayRequired, "one-shot-body-forbids-multiple-attempts"))
		},
		Replayability::OneShot => Ok(ReplayPlan::OneShotSingleAttempt),
	}
}

fn capability_error(
	kind: ErrorKind,
	requirement: &CapabilityRequirement,
	reason: ReasonId,
) -> Error {
	Error::planning(
		kind,
		ErrorDetail::capability(Str::new(requirement.feature.0.as_str()), reason),
		ExecutionReceipt::default(),
	)
}

fn replay_error(kind: ErrorKind, reason: &'static str) -> Error {
	Error::planning(
		kind,
		ErrorDetail::replay(ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

const fn emulation_is_lossless(method: Emulation) -> bool {
	!matches!(method, Emulation::PromptInstruction)
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, Instant};

	use super::*;
	use crate::{
		call::{Setting as CallSetting, ToolChoice as CallToolChoice},
		catalog::{CatalogRevision, CodecId, Emulation, RouteId},
		receipt::{Cost, ExecutionBudget, FeatureId, Penalty, ReasonId},
	};

	fn requirement(strength: RequirementStrength) -> CapabilityRequirement {
		CapabilityRequirement { feature: FeatureId(sf!("structured-output")), strength }
	}

	fn budget(attempts: u32, staging: u64) -> ExecutionBudget {
		ExecutionBudget {
			max_elapsed:           None,
			max_attempts:          attempts,
			max_input_tokens:      None,
			max_output_tokens:     None,
			max_cost:              None::<Cost>,
			max_provisional_bytes: 0,
			max_staging_bytes:     staging,
		}
	}

	#[test]
	fn unknown_and_unsupported_have_distinct_typed_failures() {
		let unknown = negotiate(
			&[requirement(RequirementStrength::Required)],
			&[CapabilityEvidence {
				feature:      FeatureId(sf!("structured-output")),
				availability: CapabilityAvailability::Unknown,
				reason:       ReasonId(sf!("not-observed")),
			}],
			PlanningPolicy::default(),
		)
		.expect_err("unknown requirement must fail");
		assert_eq!(unknown.kind, ErrorKind::CapabilityUnknown);

		let unsupported = negotiate(
			&[requirement(RequirementStrength::Required)],
			&[CapabilityEvidence {
				feature:      FeatureId(sf!("structured-output")),
				availability: CapabilityAvailability::Unsupported,
				reason:       ReasonId(sf!("proven-absent")),
			}],
			PlanningPolicy::default(),
		)
		.expect_err("unsupported requirement must fail");
		assert_eq!(unsupported.kind, ErrorKind::CapabilityMismatch);
	}

	#[test]
	fn native_and_emulated_features_require_explicit_policy() {
		let native = CapabilityEvidence {
			feature:      FeatureId(sf!("structured-output")),
			availability: CapabilityAvailability::Native,
			reason:       ReasonId(sf!("route-native")),
		};
		let (decisions, _) = negotiate(
			&[requirement(RequirementStrength::Required)],
			&[native],
			PlanningPolicy::default(),
		)
		.unwrap();
		assert!(matches!(decisions.as_slice(), [NegotiationDecision::Native { .. }]));

		let emulated = CapabilityEvidence {
			feature:      FeatureId(sf!("structured-output")),
			availability: CapabilityAvailability::Emulated(Emulation::ResponseTransform),
			reason:       ReasonId(sf!("bounded-validator")),
		};
		assert_eq!(
			negotiate(
				&[requirement(RequirementStrength::Required)],
				std::slice::from_ref(&emulated),
				PlanningPolicy::default()
			)
			.expect_err("emulation defaults forbidden")
			.kind,
			ErrorKind::CapabilityMismatch,
		);
		let policy = PlanningPolicy { allow_emulation: true, ..PlanningPolicy::default() };
		assert!(matches!(
			negotiate(&[requirement(RequirementStrength::Required)], &[emulated], policy)
				.unwrap()
				.0
				.as_slice(),
			[NegotiationDecision::Emulated { .. }]
		));
	}

	#[test]
	fn wrong_codec_native_options_fail_unless_preferred_drop_is_explicit() {
		let option = NativeOptionRequirement {
			codec:    CodecId::from("openai"),
			strength: RequirementStrength::Required,
			feature:  FeatureId(sf!("openai-prediction")),
		};
		assert_eq!(
			negotiate_native_option(Some(&option), CodecId::from_ref("anthropic"), true)
				.expect_err("required mismatch")
				.kind,
			ErrorKind::CodecMismatch,
		);
		let preferred =
			NativeOptionRequirement { strength: RequirementStrength::Preferred, ..option };
		assert!(matches!(
			negotiate_native_option(Some(&preferred), CodecId::from_ref("anthropic"), true).unwrap(),
			Some(NegotiationDecision::Dropped { .. })
		));
	}

	#[test]
	fn one_shot_replay_and_staging_are_explicit() {
		let one_shot = ReplayRequirements {
			replayability:           Replayability::OneShot,
			semantic_retry_possible: false,
			staging_explicit:        false,
			staging_limit:           None,
		};
		assert_eq!(
			plan_replay(&one_shot, &budget(2, 0))
				.expect_err("multiple attempts")
				.kind,
			ErrorKind::ReplayRequired
		);

		let semantic = ReplayRequirements { semantic_retry_possible: true, ..one_shot };
		assert_eq!(
			plan_replay(&semantic, &budget(1, 64))
				.expect_err("implicit staging")
				.kind,
			ErrorKind::StagingRequired
		);
		let staged =
			ReplayRequirements { staging_explicit: true, staging_limit: Some(128), ..semantic };
		assert_eq!(plan_replay(&staged, &budget(2, 64)).unwrap(), ReplayPlan::SecureStaging {
			maximum_bytes: 64,
		});
	}

	#[test]
	fn expiry_revision_and_registry_generation_make_plans_stale() {
		let now = Instant::now();
		let expiry = now + Duration::from_secs(1);
		let revision = CatalogRevision::from("r1");
		assert!(plan_is_current(now, expiry, &revision, &revision, 7, 7));
		assert!(!plan_is_current(
			expiry + Duration::from_nanos(1),
			expiry,
			&revision,
			&revision,
			7,
			7
		));
		assert!(!plan_is_current(now, expiry, &revision, CatalogRevision::from_ref("r2"), 7, 7));
		assert!(!plan_is_current(now, expiry, &revision, &revision, 7, 8));
	}
	#[test]
	fn constraint_budget_is_priority_stable_and_epoch_cached() {
		let budget = ConstraintBudget::default();
		let route = RouteId::from("route");
		let intents = [
			ConstraintIntent { priority: 3, strict: false },
			ConstraintIntent { priority: 250, strict: true },
			ConstraintIntent { priority: 200, strict: true },
		];
		let first = budget.assign(
			[7; 32],
			&route,
			ConstraintBudgetCaps { maximum_tools: Some(2), maximum_strict: Some(1) },
			&intents,
		);
		assert_eq!(first.advertised.as_ref(), &[1, 0]);
		assert_eq!(first.dropped.as_ref(), &[2]);
		assert!(Arc::ptr_eq(
			&first,
			&budget.assign(
				[7; 32],
				&route,
				ConstraintBudgetCaps { maximum_tools: Some(1), maximum_strict: Some(0) },
				&intents,
			)
		));
		assert!(!Arc::ptr_eq(
			&first,
			&budget.assign(
				[8; 32],
				&route,
				ConstraintBudgetCaps { maximum_tools: Some(2), maximum_strict: Some(1) },
				&intents,
			)
		));
	}
	#[test]
	fn forced_call_ladder_skips_paid_native_choice_then_records_escalation() {
		let choice = CallSetting::Require(CallToolChoice::Named(sf!("lookup")));
		let caps = ForcedCallCaps {
			features:       omp_catalog::ToolFeatureBits::NAMED_CHOICE,
			forced_choice:  Some(true),
			native_penalty: Some(Penalty::CacheInvalidated),
		};
		let soft = forced_call_ladder(&choice, caps.clone(), false, 1);
		assert!(soft.soft_prompt);
		assert!(!soft.native_choice);
		assert_eq!(soft.escalation, None);
		let escalated = forced_call_ladder(&choice, caps, true, 1);
		assert!(escalated.native_choice);
		assert!(matches!(
			escalated.escalation,
			Some(Adjustment::Escalated { penalty: Penalty::CacheInvalidated, .. })
		));
	}

	#[test]
	fn soft_prompt_is_appended_after_the_transcript_not_prepended_to_system() {
		let text = |role, body: &str| Message {
			role,
			content: Arc::from([ContentPart::Text { text: Str::new(body), proof: None }]),
			name: None,
		};
		let request = ChatRequest {
			messages:          Arc::from([
				text(Role::System, "You are omp."),
				text(Role::User, "Look up x."),
				text(Role::Assistant, "Sure."),
			]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       CallSetting::Require(CallToolChoice::Named(sf!("lookup"))),
			output:            CallSetting::Unset,
			reasoning:         CallSetting::Unset,
			verbosity:         CallSetting::Unset,
			cache_retention:   CallSetting::Unset,
			service_tier:      CallSetting::Unset,
			sampling:          crate::call::Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       crate::call::NegotiationPolicy::default(),
			forced_call:       None,
		};
		let decision =
			ForcedCallDecision { soft_prompt: true, native_choice: false, escalation: None };
		let adjusted = apply_forced_call_decision(&request, &decision);

		// The cached prefix — every original message, in order — is untouched.
		assert_eq!(adjusted.messages.len(), request.messages.len() + 1);
		let text_of = |message: &Message| match message.content.as_ref() {
			[ContentPart::Text { text, .. }] => text.clone(),
			other => panic!("fixture parts are text: {other:?}"),
		};
		for (original, kept) in request.messages.iter().zip(adjusted.messages.iter()) {
			assert_eq!(original.role, kept.role);
			assert_eq!(text_of(original), text_of(kept));
		}
		let tail = adjusted.messages.last().expect("directive appended");
		assert_eq!(tail.role, Role::User);
		assert!(matches!(
			tail.content.as_ref(),
			[ContentPart::Text { text, .. }] if text.as_str() == FORCED_CALL_DIRECTIVE
		));
		assert!(matches!(adjusted.tool_choice, CallSetting::Prefer(CallToolChoice::Auto)));
	}

	#[test]
	fn supports_forced_tool_choice_matches_pi_behavior() {
		let choice = CallSetting::Require(CallToolChoice::Named(sf!("lookup")));
		for declared in [None, Some(false)] {
			let mut policy = WirePolicy::baseline();
			policy.tool.forced_choice = declared;
			let decision = forced_call_ladder(
				&choice,
				ForcedCallCaps::from_wire_policy(
					omp_catalog::ToolFeatureBits::NAMED_CHOICE,
					Some(Penalty::Billable),
					&policy,
				),
				true,
				1,
			);
			assert!(decision.soft_prompt);
			assert!(!decision.native_choice, "unknown is not affirmative support");
			assert_eq!(decision.escalation, None);
		}

		let decision = forced_call_ladder(
			&choice,
			ForcedCallCaps {
				features:       omp_catalog::ToolFeatureBits::NAMED_CHOICE,
				forced_choice:  Some(true),
				native_penalty: Some(Penalty::Billable),
			},
			true,
			1,
		);
		assert!(matches!(
			decision.escalation,
			Some(Adjustment::Escalated { penalty: Penalty::Billable, .. })
		));
	}
}
