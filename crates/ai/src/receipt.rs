//! Lossless, secret-free execution accounting.

use std::{
	ops::AddAssign,
	time::{Duration, SystemTime},
};

use omp_core::{IntoStr, Str, sf};
use serde::{Deserialize, Serialize};

pub use crate::body::{AttemptBodyEvidence, Replayability};
use crate::{
	catalog::{
		CatalogRevision, CodecId, Emulation, ModelKey, ProviderId, RouteId, ThinkingPolicyId,
		WirePolicyId,
	},
	id::{AccountId, PrincipalId},
};

/// Identifies a negotiated feature in receipt evidence.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct FeatureId(pub Str);

impl FeatureId {
	/// Creates a feature identifier.
	#[inline]
	pub fn new(value: impl IntoStr) -> Self {
		Self(value.into_str())
	}

	/// Creates a static feature identifier.
	#[inline]
	pub const fn new_static(value: &'static str) -> Self {
		Self(sf!(value))
	}
}
impl From<&str> for FeatureId {
	#[inline]
	fn from(value: &str) -> Self {
		Self(Str::new(value))
	}
}

/// Identifies a catalog or policy reason.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ReasonId(pub Str);

impl ReasonId {
	/// Creates a reason identifier.
	#[inline]
	pub fn new(value: impl IntoStr) -> Self {
		Self(value.into_str())
	}

	/// Creates a static reason identifier.
	#[inline]
	pub const fn new_static(value: &'static str) -> Self {
		Self(sf!(value))
	}
}
impl From<&str> for ReasonId {
	#[inline]
	fn from(value: &str) -> Self {
		Self(Str::new(value))
	}
}
/// Describes an execution penalty introduced while satisfying intent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Penalty {
	/// Existing prompt-cache identity was invalidated.
	CacheInvalidated,
	/// The change can add billable usage.
	Billable,
	/// The change can increase latency.
	Latency,
	/// The penalty is known to exist but cannot be quantified.
	Unknown,
}

/// Records a capability negotiation decision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Adjustment {
	/// A feature was used in its native form.
	Native {
		/// Negotiated feature.
		feature: FeatureId,
	},
	/// A feature was emulated by a named mechanism.
	Emulated {
		/// Negotiated feature.
		feature: FeatureId,
		/// Emulation mechanism.
		method:  Emulation,
	},
	/// A preferred feature was intentionally omitted.
	Dropped {
		/// Omitted feature.
		feature: FeatureId,
		/// Typed omission reason.
		reason:  ReasonId,
	},
	/// One requested value was substituted for another.
	Substituted {
		/// Negotiated feature.
		feature: FeatureId,
		/// Requested value.
		from:    Str,
		/// Selected value.
		to:      Str,
	},
	/// A more costly enforcement mechanism was enabled.
	Escalated {
		/// Negotiated feature.
		feature: FeatureId,
		/// Resulting penalty.
		penalty: Penalty,
	},
}

/// Identifies the provenance of usage measurements.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum UsageSource {
	/// No usage observation is available yet.
	#[default]
	Unknown,
	/// The provider reported the measurement.
	Provider,
	/// A deterministic local runtime measured the value.
	Measured,
	/// A tokenizer or policy estimated the value.
	Estimated,
	/// Accumulated values have more than one provenance.
	Mixed,
}

/// Dimensioned resource usage for any inference operation.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Usage {
	/// Input tokens consumed.
	pub input_tokens: u64,
	/// Output tokens consumed, including any reasoning tokens.
	pub output_tokens: u64,
	/// Reasoning subset of `output_tokens`; diagnostic only, never priced or
	/// budgeted separately.
	pub reasoning_tokens: u64,
	/// Prompt-cache tokens read.
	pub cache_read_tokens: u64,
	/// Prompt-cache tokens written.
	pub cache_write_tokens: u64,
	/// Subset of `cache_write_tokens` written with one-hour retention. Anthropic
	/// bills these at twice the base
	/// input rate instead of the five-minute cache-write rate.
	#[serde(default)]
	pub cache_write_1h_tokens: u64,
	/// Images processed or generated.
	pub images: u32,
	/// Input audio duration in milliseconds.
	pub audio_input_ms: u64,
	/// Output audio duration in milliseconds.
	pub audio_output_ms: u64,
	/// Video duration in milliseconds.
	pub video_ms: u64,
	/// Standalone or hosted search calls made.
	pub search_calls: u32,
	/// Premium requests consumed, scaled by one million. GitHub Copilot bills
	/// each user-initiated
	/// request at the model's premium multiplier and agent-initiated
	/// continuations at zero.
	#[serde(default)]
	pub premium_requests_millionths: u64,
	/// Provenance of the accumulated values.
	pub source: UsageSource,
}

impl Usage {
	/// Fixed-point scale of `premium_requests_millionths`: one premium request.
	pub const PREMIUM_REQUEST_SCALE: u64 = 1_000_000;

	/// Adds all dimensions with saturation and preserves mixed provenance.
	pub fn accumulate(&mut self, other: Self) {
		self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
		self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
		self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
		self.cache_read_tokens = self
			.cache_read_tokens
			.saturating_add(other.cache_read_tokens);
		self.cache_write_tokens = self
			.cache_write_tokens
			.saturating_add(other.cache_write_tokens);
		self.cache_write_1h_tokens = self
			.cache_write_1h_tokens
			.saturating_add(other.cache_write_1h_tokens);
		self.images = self.images.saturating_add(other.images);
		self.audio_input_ms = self.audio_input_ms.saturating_add(other.audio_input_ms);
		self.audio_output_ms = self.audio_output_ms.saturating_add(other.audio_output_ms);
		self.video_ms = self.video_ms.saturating_add(other.video_ms);
		self.search_calls = self.search_calls.saturating_add(other.search_calls);
		self.premium_requests_millionths = self
			.premium_requests_millionths
			.saturating_add(other.premium_requests_millionths);
		self.source = match (self.source, other.source) {
			(UsageSource::Unknown, source) | (source, UsageSource::Unknown) => source,
			(left, right) if left == right => left,
			_ => UsageSource::Mixed,
		};
	}

	/// Returns the total of all billable token dimensions.
	///
	/// Reasoning tokens are a subset of `output_tokens` and are not added
	/// again.
	pub const fn total_tokens(&self) -> u64 {
		self
			.input_tokens
			.saturating_add(self.output_tokens)
			.saturating_add(self.cache_read_tokens)
			.saturating_add(self.cache_write_tokens)
	}
}

impl AddAssign for Usage {
	fn add_assign(&mut self, rhs: Self) {
		self.accumulate(rhs);
	}
}

/// Exact integer monetary cost in micro-US dollars.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Cost {
	/// Signed micro-US dollars; negative values represent explicit credits.
	pub micro_usd: i128,
}

impl Cost {
	/// Creates a cost from an integer number of micro-US dollars.
	pub const fn from_micro_usd(micro_usd: i128) -> Self {
		Self { micro_usd }
	}

	/// Adds a cost, saturating only at the integer representation boundary.
	pub const fn accumulate(&mut self, other: Self) {
		self.micro_usd = self.micro_usd.saturating_add(other.micro_usd);
	}
}

impl AddAssign for Cost {
	fn add_assign(&mut self, rhs: Self) {
		self.accumulate(rhs);
	}
}

/// Cross-attempt limits applied to one execution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionBudget {
	/// Maximum elapsed wall-clock duration.
	pub max_elapsed:           Option<Duration>,
	/// Maximum number of provider or local attempts.
	pub max_attempts:          u32,
	/// Maximum aggregate input tokens.
	pub max_input_tokens:      Option<u64>,
	/// Maximum aggregate output and reasoning tokens.
	pub max_output_tokens:     Option<u64>,
	/// Maximum aggregate monetary cost.
	pub max_cost:              Option<Cost>,
	/// Maximum bytes held behind a transactional output gate.
	pub max_provisional_bytes: u64,
	/// Maximum bytes accepted by explicit secure staging.
	pub max_staging_bytes:     u64,
}

/// Bounded in-memory capacity available to transactional output gates unless a
/// caller supplies a tighter explicit budget.
pub const DEFAULT_PROVISIONAL_BYTES: u64 = 64 * 1024;

impl Default for ExecutionBudget {
	fn default() -> Self {
		Self {
			max_elapsed:           None,
			max_attempts:          1,
			max_input_tokens:      None,
			max_output_tokens:     None,
			max_cost:              None,
			max_provisional_bytes: DEFAULT_PROVISIONAL_BYTES,
			max_staging_bytes:     0,
		}
	}
}

/// Credential-free summary of the selected catalog plan.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanSummary {
	/// Catalog revision against which the plan was produced.
	pub catalog_revision: Option<CatalogRevision>,
	/// Selected normalized model.
	pub model:            Option<ModelKey>,
	/// Selected provider.
	pub provider:         Option<ProviderId>,
	/// Selected concrete route.
	pub route:            Option<RouteId>,
	/// Selected codec.
	pub codec:            Option<CodecId>,
	/// Selected wire-lowering policy.
	pub wire_policy:      Option<WirePolicyId>,
	/// Selected reasoning policy.
	pub thinking_policy:  Option<ThinkingPolicyId>,
}

/// Final outcome of an individual attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AttemptOutcome {
	/// The attempt produced the selected answer.
	Succeeded,
	/// The attempt failed before any ordinary output committed.
	FailedPreCommit,
	/// The attempt failed after ordinary output committed.
	FailedCommitted,
	/// Provisional output was discarded after a semantic postcondition failed.
	RejectedSemantic,
	/// The attempt was cancelled.
	Cancelled,
}

/// Sanitized provider response evidence.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderEvidence {
	/// Provider request identifier, if present.
	pub request_id: Option<Str>,
	/// HTTP or protocol status, if applicable.
	pub status:     Option<u16>,
	/// Structured provider error code, if present.
	pub code:       Option<Str>,
	/// Bounded, sanitized error classification context.
	pub summary:    Option<Str>,
}

/// Accounting record for one visible or hidden attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AttemptReceipt {
	/// Zero-based attempt index.
	pub index:             u32,
	/// Whether output was held provisionally from consumers.
	pub hidden:            bool,
	/// Provider used by the attempt.
	pub provider:          Option<ProviderId>,
	/// Route used by the attempt.
	pub route:             Option<RouteId>,
	/// Account used without exposing credential material.
	pub account:           Option<AccountId>,
	/// Principal used for affinity decisions.
	pub principal:         Option<PrincipalId>,
	/// Body replay evidence.
	pub body:              AttemptBodyEvidence,
	/// Final attempt outcome.
	pub outcome:           AttemptOutcome,
	/// Dimensioned usage charged to the attempt.
	pub usage:             Usage,
	/// Integer cost charged to the attempt.
	pub cost:              Cost,
	/// Sanitized provider evidence.
	pub provider_evidence: ProviderEvidence,
	/// Total attempt duration.
	pub elapsed:           Duration,
}

#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod recovery_kind {
	use serde::{Deserialize, Serialize};
	use strum::IntoStaticStr;

	/// Kind of deterministic recovery applied to canonical output.
	#[derive(Clone, Copy, Debug, Deserialize, Eq, IntoStaticStr, PartialEq, Serialize)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum RecoveryKind {
		/// Malformed JSON was repaired within configured bounds.
		JsonRepair,
		/// Leaked dialect markup was normalized.
		DialectNormalization,
		/// A partial tool call was assembled and validated.
		ToolAssembly,
		/// Leaked reasoning was classified into a thinking block.
		ThinkingClassification,
		/// Exactly framed Harmony analysis/final markup was normalized.
		HarmonyLeakRepair,
		/// Provable Harmony protocol leakage rejected a provisional attempt.
		HarmonyLeakDetection,
		/// Reasoning stopped making bounded forward progress.
		ReasoningStall,
		/// Repetition was detected within one attempt.
		WithinAttemptRepetition,
		/// A tool call repeated across committed conversation turns.
		CrossTurnToolLoop,
		/// A malformed tool result was repaired within declared bounds.
		ToolResultRepair,
		/// A model-fabricated tool result was rejected.
		FabricatedResultRejection,
		/// Expired server state was reseeded from replay.
		SessionReseed,
		/// Empty output was classified or recovered.
		EmptyOutput,
	}
}

#[doc(inline)]
pub use recovery_kind::RecoveryKind;

impl RecoveryKind {
	/// Returns the stable snake-case recovery code derived by `strum`.
	pub const fn as_str(&self) -> &'static str {
		self.into_str()
	}
}

/// Evidence for one recovery action.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveryRecord {
	/// Attempt on which recovery occurred.
	pub attempt:     u32,
	/// Recovery category.
	pub kind:        RecoveryKind,
	/// Stable rule identifier.
	pub rule:        ReasonId,
	/// Number of input bytes examined.
	pub input_bytes: u64,
	/// Number of bounded repair steps performed.
	pub steps:       u32,
}

/// Storage selected for explicit request-body staging.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StagingStorage {
	/// The bounded body remained in zeroizing process memory.
	Memory,
	/// The complete body was migrated to an authenticated-encrypted temporary
	/// file.
	EncryptedTemporaryFile,
}

/// Authenticated-encryption algorithm used for temporary staging.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StagingEncryptionAlgorithm {
	/// IETF ChaCha20-Poly1305 with a unique nonce for every chunk.
	ChaCha20Poly1305,
}

/// Non-secret provenance of the staging encryption key.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StagingKeySource {
	/// The caller supplied the key material explicitly.
	CallerProvided,
	/// A caller-provided adapter derived the key from an operating-system
	/// credential facility.
	OperatingSystem,
}

/// Secret-free authenticated-encryption evidence for temporary staging.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StagingEncryption {
	/// Authenticated-encryption algorithm used.
	pub algorithm:     StagingEncryptionAlgorithm,
	/// Non-secret provenance of the key material.
	pub key_source:    StagingKeySource,
	/// Whether every stored chunk carried and verified an authentication tag.
	pub authenticated: bool,
	/// Number of independently authenticated chunks.
	pub chunk_count:   u64,
}

/// Evidence for explicit secure staging of otherwise one-shot input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StagingReceipt {
	/// Number of bytes staged.
	pub bytes:         u64,
	/// Time spent staging input.
	pub elapsed:       Duration,
	/// Final storage selected after any memory-to-disk migration.
	pub storage:       StagingStorage,
	/// Authenticated-encryption evidence; present exactly for encrypted
	/// temporary storage.
	pub encryption:    Option<StagingEncryption>,
	/// Whether staging completed before execution.
	pub completed:     bool,
	/// Whether caller cancellation stopped staging or invalidated the staged
	/// body.
	pub cancelled:     bool,
	/// Bytes charged against the execution staging budget.
	pub budget_charge: u64,
}

/// Wall-clock breakdown across execution phases.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct TimingBreakdown {
	/// Time spent waiting for readiness and admission.
	pub queued:         Duration,
	/// Time spent planning and negotiating intent.
	pub planning:       Duration,
	/// Time spent acquiring credentials.
	pub authentication: Duration,
	/// Time spent encoding requests.
	pub encoding:       Duration,
	/// Time until the first decodable frame.
	pub first_frame:    Option<Duration>,
	/// Time spent streaming or receiving the body.
	pub streaming:      Duration,
	/// Total elapsed execution time.
	pub total:          Duration,
	/// Completion wall-clock time when recorded.
	pub completed_at:   Option<SystemTime>,
}

/// Serving model attributed only after a successful attempt settles.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ServingModelAttribution {
	/// Concrete serving provider.
	pub provider: ProviderId,
	/// Concrete serving model.
	pub model:    ModelKey,
	/// Successful attempt index that settled this attribution.
	pub attempt:  u32,
}

/// Complete accounting record for an execution, including failed hidden
/// attempts.
/// Token categories measured against one immutable request projection.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextUsageReceipt {
	/// Stable turn identity anchoring every measurement.
	pub turn_id:             Option<Str>,
	/// Projection revision measured by the tokenizer.
	pub context_revision:    Option<u64>,
	/// Physical journal event anchoring the prompt projection.
	pub prompt_anchor:       Option<u64>,
	/// Durable compaction/reset epoch measured by the tokenizer.
	pub compaction_epoch:    Option<u64>,
	/// Model context-window ceiling.
	pub window_tokens:       Option<u64>,
	/// Complete serialized input tokens at this anchor.
	pub input_tokens:        Option<u64>,
	/// System-prompt tokens, when independently measurable.
	pub system_tokens:       Option<u64>,
	/// Conversation-message tokens, when independently measurable.
	pub message_tokens:      Option<u64>,
	/// Installed skill prompt tokens, when independently measurable.
	pub skill_tokens:        Option<u64>,
	/// Tool declarations and tool-result tokens, when independently measurable.
	pub tool_tokens:         Option<u64>,
	/// Reserved runtime buffers, when independently measurable.
	pub buffer_tokens:       Option<u64>,
	/// Input tokens avoided by the active Snapcompact projection.
	pub snapcompact_savings: Option<u64>,
}

/// Complete accounting record for an execution, including failed hidden
/// attempts.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionReceipt {
	/// Credential-free plan summary.
	pub plan:          PlanSummary,
	/// Negotiation changes made with caller permission.
	pub adjustments:   Vec<Adjustment>,
	/// Every visible and hidden attempt.
	pub attempts:      Vec<AttemptReceipt>,
	/// Exactly one model attributed after successful settlement.
	pub serving_model: Option<ServingModelAttribution>,
	/// Deterministic recovery actions.
	pub recoveries:    Vec<RecoveryRecord>,
	/// Explicit staging evidence.
	pub staging:       Vec<StagingReceipt>,
	/// Accumulated dimensioned usage.
	pub usage:         Usage,
	/// Anchored request-context accounting for the settled attempt.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub context:       Option<ContextUsageReceipt>,
	/// Accumulated integer cost.
	pub cost:          Cost,
	/// Cross-phase timings.
	pub timings:       TimingBreakdown,
}

impl ExecutionReceipt {
	/// Settles serving-model attribution once after success.
	///
	/// Replaying the same settlement is idempotent; a conflicting second
	/// attribution is rejected.
	pub fn settle_serving_model(
		&mut self,
		attribution: ServingModelAttribution,
	) -> Result<(), ServingModelAttribution> {
		match &self.serving_model {
			None => {
				self.serving_model = Some(attribution);
				Ok(())
			},
			Some(current) if current == &attribution => Ok(()),
			Some(_) => Err(attribution),
		}
	}

	/// Adds usage and cost from an attempt before storing it.
	pub fn record_attempt(&mut self, attempt: AttemptReceipt) {
		self.usage += attempt.usage;
		self.cost += attempt.cost;
		self.attempts.push(attempt);
	}
}

#[cfg(test)]
mod tests {
	use super::{Cost, ExecutionReceipt, ServingModelAttribution, Usage, UsageSource};
	use crate::catalog::{ModelKey as CatalogModelKey, ProviderId as CatalogProviderId};

	#[test]
	fn serving_model_settles_once_and_replay_is_idempotent() {
		let attribution = ServingModelAttribution {
			provider: CatalogProviderId::from("provider"),
			model:    CatalogModelKey::from("model"),
			attempt:  2,
		};
		let mut receipt = ExecutionReceipt::default();
		assert_eq!(receipt.settle_serving_model(attribution.clone()), Ok(()));
		assert_eq!(receipt.settle_serving_model(attribution.clone()), Ok(()));
		let conflicting =
			ServingModelAttribution { model: CatalogModelKey::from("other"), ..attribution };
		assert_eq!(receipt.settle_serving_model(conflicting.clone()), Err(conflicting));
	}

	#[test]
	fn accumulates_every_usage_dimension_and_integer_cost() {
		let mut usage = Usage {
			input_tokens: 1,
			output_tokens: 2,
			reasoning_tokens: 3,
			cache_read_tokens: 4,
			cache_write_tokens: 5,
			cache_write_1h_tokens: 2,
			images: 1,
			audio_input_ms: 6,
			audio_output_ms: 7,
			video_ms: 8,
			search_calls: 1,
			premium_requests_millionths: 330_000,
			source: UsageSource::Provider,
		};
		usage += Usage {
			input_tokens: 10,
			output_tokens: 20,
			reasoning_tokens: 30,
			cache_read_tokens: 40,
			cache_write_tokens: 50,
			cache_write_1h_tokens: 20,
			images: 2,
			audio_input_ms: 60,
			audio_output_ms: 70,
			video_ms: 80,
			search_calls: 2,
			premium_requests_millionths: 1_000_000,
			source: UsageSource::Estimated,
		};
		assert_eq!((usage.input_tokens, usage.output_tokens, usage.reasoning_tokens), (11, 22, 33));
		assert_eq!((usage.cache_read_tokens, usage.cache_write_tokens, usage.images), (44, 55, 3));
		assert_eq!(usage.cache_write_1h_tokens, 22);
		assert_eq!(
			(usage.audio_input_ms, usage.audio_output_ms, usage.video_ms, usage.search_calls),
			(66, 77, 88, 3)
		);
		assert_eq!(usage.premium_requests_millionths, 1_330_000);
		assert_eq!(usage.source, UsageSource::Mixed);
		let mut cost = Cost::from_micro_usd(125);
		cost += Cost::from_micro_usd(75);
		assert_eq!(cost.micro_usd, 200);
	}
}
