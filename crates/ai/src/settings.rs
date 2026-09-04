//! Runtime-backed inference retry, fallback, sampling, admission, and timeout
//! settings.

#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

use std::{collections::BTreeMap, sync, sync::LazyLock, time::Duration};

use omp_catalog::{
	ModelKey, ProviderId,
	settings::{CacheRetentionSetting, FallbackChains},
};
use omp_con::{Ctx, Kv, Value};
use omp_core::Str;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use strum::{Display, EnumString, IntoStaticStr, VariantNames};

use crate::{
	Call,
	call::{CacheRetention, ChatRequest, OperationCall, Setting, TextVerbosity},
	layer::retry::RetryBackoff,
	receipt::ExecutionBudget,
};

/// Behavior after a fallback route succeeds.
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
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive, const_into_str)]
pub enum FallbackRevertPolicy {
	/// Retry the primary after its suppression window expires.
	#[default]
	CooldownExpiry,
	/// Keep the fallback until the caller explicitly changes selection.
	Never,
}

/// Policy when every metered account is inside the configured usage reserve.
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
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive, const_into_str)]
pub enum UsageReservePolicy {
	/// Interactive callers confirm; unattended callers use fallback.
	#[default]
	Confirm,
	/// Automatically use an eligible fallback.
	Auto,
	/// Refuse to spend the reserve and do not fall back.
	FailClosed,
}

/// Replay-safe retry and explicitly authorized fallback policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct RetrySettings {
	/// Enables transport and model fallback recovery.
	pub enabled:              bool,
	/// Maximum retries after the first attempt.
	pub max_retries:          u32,
	/// First exponential retry ceiling in milliseconds.
	pub base_delay_ms:        u64,
	/// Largest accepted retry delay in milliseconds; `0` disables the cap.
	pub max_delay_ms:         u64,
	/// Enables model fallback candidates.
	pub model_fallback:       bool,
	/// Enables quota-aware preflight fallback.
	pub usage_aware_fallback: bool,
	/// Remaining quota percentage held in reserve.
	pub usage_reserve_pct:    u8,
	/// Action when every account is inside the reserve.
	pub usage_reserve_policy: UsageReservePolicy,
	/// Exact model/provider fallback chains.
	pub fallback_chains:      FallbackChains,
	/// Primary reversion behavior after fallback.
	pub fallback_revert:      FallbackRevertPolicy,
	/// Enables the explicit Anthropic server-side safety fallback header.
	pub server_side_fallback: bool,
}

impl Default for RetrySettings {
	fn default() -> Self {
		Self {
			enabled:              true,
			max_retries:          10,
			base_delay_ms:        500,
			max_delay_ms:         300_000,
			model_fallback:       true,
			usage_aware_fallback: false,
			usage_reserve_pct:    10,
			usage_reserve_policy: UsageReservePolicy::Confirm,
			fallback_chains:      BTreeMap::new(),
			fallback_revert:      FallbackRevertPolicy::CooldownExpiry,
			server_side_fallback: false,
		}
	}
}

static ACTIVE_FALLBACKS: LazyLock<Mutex<BTreeMap<ModelKey, ModelKey>>> =
	LazyLock::new(Default::default);

pub(crate) fn record_fallback(primary: &ModelKey<str>, fallback: &ModelKey<str>) {
	ACTIVE_FALLBACKS
		.lock()
		.insert(primary.to_owned(), fallback.to_owned());
}

pub(crate) fn active_fallback(primary: &ModelKey<str>) -> Option<ModelKey> {
	ACTIVE_FALLBACKS.lock().get(primary).cloned()
}

impl RetrySettings {
	/// Returns the total attempt bound installed on calls that retain defaults.
	pub const fn max_attempts(&self) -> u32 {
		if self.enabled {
			self.max_retries.saturating_add(1)
		} else {
			1
		}
	}

	/// Returns the retry middleware policy.
	pub const fn backoff(&self) -> RetryBackoff {
		RetryBackoff {
			base:    Duration::from_millis(self.base_delay_ms),
			maximum: Duration::from_millis(self.max_delay_ms),
		}
	}

	/// Applies retry defaults without weakening tighter caller limits.
	pub fn apply_budget(&self, budget: &mut ExecutionBudget) {
		let configured = self.max_attempts();
		budget.max_attempts = if budget.max_attempts == ExecutionBudget::default().max_attempts {
			configured
		} else {
			budget.max_attempts.min(configured).max(1)
		};
	}

	/// Resolves the configured chain for an exact model, then its provider
	/// wildcard.
	pub fn fallback_selectors<'a>(
		&'a self,
		model: &ModelKey<str>,
		provider: Option<&ProviderId<str>>,
	) -> impl Iterator<Item = &'a Str> + 'a {
		let exact = self
			.fallback_chains
			.get(model.as_str())
			.into_iter()
			.flatten();
		let wildcard = provider
			.and_then(|provider| {
				self
					.fallback_chains
					.get(&Str::from(format!("{provider}/*")))
			})
			.into_iter()
			.flatten();
		exact.chain(wildcard)
	}

	/// Expands the configured chain and then the chain owned by its last
	/// reachable fallback.
	///
	/// The walk is bounded by the caller's remaining attempt budget and keeps
	/// the first occurrence of each model. This makes a fallback that is itself
	/// a chain key reachable without allowing cyclic chains to grow forever.
	pub fn fallback_walk(
		&self,
		primary: &ModelKey<str>,
		primary_provider: Option<&ProviderId<str>>,
		max_fallbacks: usize,
		mut provider_for: impl FnMut(&ModelKey<str>) -> Option<ProviderId>,
	) -> Vec<ModelKey> {
		let mut selected = Vec::new();
		let mut current = primary.to_owned();
		let mut provider = primary_provider.map(ToOwned::to_owned);
		while selected.len() < max_fallbacks {
			let remaining = max_fallbacks - selected.len();
			let next = self
				.fallback_selectors(&current, provider.as_deref())
				.map(|selector| ModelKey::from(selector.clone()))
				.filter(|candidate| candidate != primary && !selected.contains(candidate))
				.filter_map(|candidate| provider_for(&candidate).map(|provider| (candidate, provider)))
				.take(remaining)
				.collect::<Vec<_>>();
			let Some((last, last_provider)) = next.last().cloned() else {
				break;
			};
			selected.extend(next.into_iter().map(|(candidate, _)| candidate));
			current = last;
			provider = Some(last_provider);
		}
		selected
	}
}

impl RetrySettings {
	/// Projects retry and fallback policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			enabled:              AI_RETRY_ENABLED.get(ctx),
			max_retries:          AI_RETRY_MAX_RETRIES.get(ctx),
			base_delay_ms:        u64::from(AI_RETRY_BASE_DELAY_MS.get(ctx)),
			max_delay_ms:         u64::from(AI_RETRY_MAX_DELAY_MS.get(ctx)),
			model_fallback:       AI_RETRY_MODEL_FALLBACK.get(ctx),
			usage_aware_fallback: AI_RETRY_USAGE_AWARE_FALLBACK.get(ctx),
			usage_reserve_pct:    AI_RETRY_USAGE_RESERVE_PCT.get(ctx),
			usage_reserve_policy: AI_RETRY_USAGE_RESERVE_POLICY.get(ctx),
			fallback_chains:      deserialize_table(AI_RETRY_FALLBACK_CHAINS.get(ctx)),
			fallback_revert:      AI_RETRY_FALLBACK_REVERT.get(ctx),
			server_side_fallback: AI_RETRY_SERVER_SIDE_FALLBACK.get(ctx),
		}
	}

	/// Reports whether all cross-variable retry invariants hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		let chains_valid = self.fallback_chains.iter().all(|(key, values)| {
			!key.is_empty()
				&& !values.is_empty()
				&& values.iter().enumerate().all(|(index, value)| {
					!value.is_empty() && values[..index].iter().all(|prior| prior != value)
				})
		});
		self.max_retries <= 100
			&& (self.max_delay_ms == 0 || self.base_delay_ms <= self.max_delay_ms)
			&& self.max_delay_ms <= 3_600_000
			&& self.usage_reserve_pct <= 100
			&& chains_valid
	}
}

/// Defaults for chat sampling and output shaping.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct SamplingSettings {
	/// Temperature; negative preserves the provider default.
	pub temperature:        f32,
	/// Nucleus cutoff; negative preserves the provider default.
	pub top_p:              f32,
	/// Top-k bound; negative preserves the provider default.
	pub top_k:              i32,
	/// Minimum probability cutoff; negative preserves the provider default.
	pub min_p:              f32,
	/// Presence penalty; negative preserves the provider default.
	pub presence_penalty:   f32,
	/// Frequency penalty; negative preserves the provider default.
	pub frequency_penalty:  f32,
	/// Repetition penalty; negative preserves the provider default.
	pub repetition_penalty: f32,
	/// Default response verbosity.
	pub verbosity:          TextVerbositySetting,
}

impl Default for SamplingSettings {
	fn default() -> Self {
		Self {
			temperature:        -1.0,
			top_p:              -1.0,
			top_k:              -1,
			min_p:              -1.0,
			presence_penalty:   -1.0,
			frequency_penalty:  -1.0,
			repetition_penalty: -1.0,
			verbosity:          TextVerbositySetting::Medium,
		}
	}
}

/// Configured default response verbosity.
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
pub enum TextVerbositySetting {
	/// Concise output.
	Low,
	/// Balanced output.
	#[default]
	Medium,
	/// Detailed output.
	High,
}

omp_con::con_enum!(FallbackRevertPolicy);
omp_con::con_enum!(UsageReservePolicy);
omp_con::con_enum!(TextVerbositySetting);

impl SamplingSettings {
	/// Installs defaults on a chat request while preserving every
	/// caller-explicit value.
	pub fn apply(
		&self,
		request: &mut ChatRequest,
		top_k: bool,
		penalties: bool,
		extended: bool,
		verbosity: bool,
	) {
		request.sampling.temperature = request
			.sampling
			.temperature
			.or_else(|| nonnegative(self.temperature));
		request.sampling.top_p = request.sampling.top_p.or_else(|| nonnegative(self.top_p));
		if top_k {
			request.sampling.top_k = request
				.sampling
				.top_k
				.or_else(|| u32::try_from(self.top_k).ok());
		}
		if extended {
			request.sampling.min_p = request.sampling.min_p.or_else(|| nonnegative(self.min_p));
			request.sampling.repetition_penalty = request
				.sampling
				.repetition_penalty
				.or_else(|| nonnegative(self.repetition_penalty));
		}
		if penalties {
			request.sampling.presence_penalty = request
				.sampling
				.presence_penalty
				.or_else(|| nonnegative(self.presence_penalty));
			request.sampling.frequency_penalty = request
				.sampling
				.frequency_penalty
				.or_else(|| nonnegative(self.frequency_penalty));
		}
		if verbosity && matches!(request.verbosity, Setting::Unset) {
			request.verbosity = Setting::Prefer(match self.verbosity {
				TextVerbositySetting::Low => TextVerbosity::Low,
				TextVerbositySetting::Medium => TextVerbosity::Medium,
				TextVerbositySetting::High => TextVerbosity::High,
			});
		}
	}
}

impl SamplingSettings {
	/// Projects sampling defaults from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			temperature:        AI_SAMPLING_TEMPERATURE.get(ctx),
			top_p:              AI_SAMPLING_TOP_P.get(ctx),
			top_k:              AI_SAMPLING_TOP_K.get(ctx),
			min_p:              AI_SAMPLING_MIN_P.get(ctx),
			presence_penalty:   AI_SAMPLING_PRESENCE_PENALTY.get(ctx),
			frequency_penalty:  AI_SAMPLING_FREQUENCY_PENALTY.get(ctx),
			repetition_penalty: AI_SAMPLING_REPETITION_PENALTY.get(ctx),
			verbosity:          AI_SAMPLING_VERBOSITY.get(ctx),
		}
	}

	/// Reports whether all cross-variable sampling invariants hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		let probability = |value: f32| value == -1.0 || (0.0..=1.0).contains(&value);
		let finite =
			[self.temperature, self.presence_penalty, self.frequency_penalty, self.repetition_penalty]
				.into_iter()
				.all(f32::is_finite);
		finite
			&& self.temperature >= -1.0
			&& probability(self.top_p)
			&& probability(self.min_p)
			&& self.top_k >= -1
	}
}

/// Provider admission and request timeout policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ProviderRuntimeSettings {
	/// Maximum concurrent requests keyed by provider id; absent or zero is
	/// unlimited.
	pub max_in_flight:            BTreeMap<Str, usize>,
	/// Maximum queued callers per provider before backpressure fails fast.
	pub max_queued:               usize,
	/// Per-transport-attempt timeout in seconds.
	pub timeout_seconds:          u64,
	/// Overall logical-call timeout in seconds; zero leaves caller deadlines
	/// authoritative.
	pub call_timeout_seconds:     u64,
	/// Bedrock guardrail policy keyed by provider id.
	pub bedrock_guardrails:       BTreeMap<Str, crate::codec::bedrock::BedrockGuardrail>,
	/// Bedrock invocation-log attribution tags keyed by provider id.
	pub bedrock_request_metadata: BTreeMap<Str, BTreeMap<Str, Str>>,
}

impl Default for ProviderRuntimeSettings {
	fn default() -> Self {
		Self {
			max_in_flight:            BTreeMap::new(),
			max_queued:               64,
			timeout_seconds:          300,
			call_timeout_seconds:     0,
			bedrock_guardrails:       BTreeMap::new(),
			bedrock_request_metadata: BTreeMap::new(),
		}
	}
}

impl ProviderRuntimeSettings {
	/// Resolves a provider concurrency limit; zero and absent entries are
	/// unlimited.
	pub fn in_flight_limit(&self, provider: &ProviderId<str>) -> Option<usize> {
		self
			.max_in_flight
			.get(provider.as_str())
			.copied()
			.filter(|limit| *limit > 0)
	}

	/// Applies the configured logical timeout without weakening a tighter caller
	/// timeout.
	pub fn apply_budget(&self, budget: &mut ExecutionBudget) {
		if self.call_timeout_seconds == 0 {
			return;
		}
		let configured = Duration::from_secs(self.call_timeout_seconds);
		budget.max_elapsed = Some(
			budget
				.max_elapsed
				.map_or(configured, |current| current.min(configured)),
		);
	}
}

impl ProviderRuntimeSettings {
	/// Projects provider admission and timeout policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			max_in_flight:            deserialize_table(AI_PROVIDER_MAX_IN_FLIGHT.get(ctx)),
			max_queued:               AI_PROVIDER_MAX_QUEUED.get(ctx) as usize,
			timeout_seconds:          u64::from(AI_PROVIDER_TIMEOUT_SECONDS.get(ctx)),
			call_timeout_seconds:     u64::from(AI_PROVIDER_CALL_TIMEOUT_SECONDS.get(ctx)),
			bedrock_guardrails:       deserialize_table(AI_PROVIDER_BEDROCK_GUARDRAILS.get(ctx)),
			bedrock_request_metadata: deserialize_table(AI_PROVIDER_BEDROCK_REQUEST_METADATA.get(ctx)),
		}
	}

	/// Reports whether all cross-variable provider runtime invariants hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		self.max_queued <= 100_000
			&& self.timeout_seconds > 0
			&& self.timeout_seconds <= 3_600
			&& self.call_timeout_seconds <= 86_400
			&& self
				.max_in_flight
				.iter()
				.all(|(provider, limit)| !provider.is_empty() && *limit <= 100_000)
			&& self.bedrock_guardrails.iter().all(|(provider, guardrail)| {
				!provider.trim().is_empty()
					&& !guardrail.identifier.trim().is_empty()
					&& !guardrail.version.trim().is_empty()
			}) && self
			.bedrock_request_metadata
			.keys()
			.all(|provider| !provider.trim().is_empty())
	}
}

/// Immutable projection installed into constructed inference services.
#[derive(Clone, Debug, Default)]
pub struct InferenceSettings {
	/// Retry and fallback policy.
	pub retry:                     RetrySettings,
	/// Chat sampling defaults.
	pub sampling:                  SamplingSettings,
	/// Provider admission and timeout policy.
	pub providers:                 ProviderRuntimeSettings,
	/// Catalog/model policy.
	pub model:                     omp_catalog::settings::ModelSettings,
	/// Whether context-overflow plans may promote to a larger compatible model.
	pub context_promotion_enabled: bool,
}

impl InferenceSettings {
	/// Projects the complete inference policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			retry:                     RetrySettings::from_con(ctx),
			sampling:                  SamplingSettings::from_con(ctx),
			providers:                 ProviderRuntimeSettings::from_con(ctx),
			model:                     omp_catalog::settings::ModelSettings::from_con(ctx),
			context_promotion_enabled: crate::settings::AI_CONTEXT_PROMOTION_ENABLED.get(ctx),
		}
	}

	/// Applies budget projections before side-effect-free planning.
	pub fn apply_planning_call(&self, call: &mut Call) {
		self.retry.apply_budget(&mut call.budget);
		self.providers.apply_budget(&mut call.budget);
	}

	/// Applies live control-plane defaults to one chat request for a resolved
	/// route, preserving every caller-explicit semantic intent.
	///
	/// `provider`, `model`, and `codec` are compiled catalog facts. Passing
	/// `None` applies only route-independent settings; callers that already
	/// resolved a route should pass all three so codec-specific controls and
	/// service-tier policy are projected without provider-name branching.
	pub fn apply_chat_request(
		&self,
		chat: &mut ChatRequest,
		provider: Option<&str>,
		model: Option<&str>,
		codec: Option<&str>,
	) {
		let openai_chat = codec == Some("openai-chat");
		let openai_responses = codec == Some("openai-responses");
		let top_k = openai_chat || matches!(codec, Some("anthropic" | "gemini" | "ollama" | "devin"));
		let penalties = openai_chat || openai_responses;
		self
			.sampling
			.apply(chat, top_k, penalties, openai_chat, openai_responses);
		if matches!(chat.cache_retention, Setting::Unset) {
			chat.cache_retention = match self.model.cache_retention {
				CacheRetentionSetting::Auto => Setting::Unset,
				CacheRetentionSetting::None => Setting::Require(CacheRetention::Request),
				CacheRetentionSetting::Short => Setting::Prefer(CacheRetention::Short),
				CacheRetentionSetting::Long => Setting::Prefer(CacheRetention::Long),
			};
		}
		if matches!(chat.service_tier, Setting::Unset)
			&& let Some(tier) = provider.and_then(|provider| {
				self.model.service_tier_for_route(
					provider,
					model,
					omp_catalog::TierAudience::Session,
					None,
				)
			}) {
			chat.service_tier = Setting::Prefer(tier);
		}
	}

	/// Applies request-level projections after the immutable plan is selected.
	pub fn apply_call(&self, call: &mut Call) {
		let execution = call.execution.as_ref();
		let provider = execution.map(|execution| execution.provider.as_str());
		let model = execution
			.and_then(|execution| execution.model.as_deref())
			.map(omp_catalog::ModelKey::as_str);
		let codec = execution.map(|execution| execution.codec.as_str());
		if let OperationCall::Chat(chat) = &mut call.operation {
			self.apply_chat_request(sync::Arc::make_mut(chat), provider, model, codec);
		}
	}
}

fn nonnegative(value: f32) -> Option<f32> {
	(value >= 0.0).then_some(value)
}

fn json_to_con(value: serde_json::Value) -> Option<Value> {
	match value {
		serde_json::Value::Null => None,
		serde_json::Value::Bool(value) => Some(Value::Bool(value)),
		serde_json::Value::Number(value) => value
			.as_i64()
			.map(Value::Int)
			.or_else(|| value.as_f64().map(Value::Float)),
		serde_json::Value::String(value) => Some(Value::Str(Str::from(value))),
		serde_json::Value::Array(values) => values
			.into_iter()
			.map(json_to_con)
			.collect::<Option<Vec<_>>>()
			.map(Value::List),
		serde_json::Value::Object(values) => values
			.into_iter()
			.map(|(key, value)| Some((Str::from(key), json_to_con(value)?)))
			.collect::<Option<Vec<_>>>()
			.map(|values| Value::Kv(Kv(values))),
	}
}

fn con_to_json(value: Value) -> serde_json::Value {
	match value {
		Value::Bool(value) => serde_json::Value::Bool(value),
		Value::Int(value) => serde_json::Value::Number(value.into()),
		Value::Float(value) => serde_json::Number::from_f64(value)
			.map_or(serde_json::Value::Null, serde_json::Value::Number),
		Value::Str(value) | Value::Enum(value) => serde_json::Value::String(value.into()),
		Value::Duration(value) => serde_json::Value::String(value.to_string()),
		Value::List(values) => {
			serde_json::Value::Array(values.into_iter().map(con_to_json).collect())
		},
		Value::Kv(values) => serde_json::Value::Object(
			values
				.0
				.into_iter()
				.map(|(key, value)| (key.into(), con_to_json(value)))
				.collect(),
		),
	}
}

fn serialize_table<T: Serialize>(value: &T) -> Kv {
	match json_to_con(serde_json::to_value(value).expect("settings table serializes")) {
		Some(Value::Kv(value)) => value,
		_ => panic!("settings table must serialize as an object"),
	}
}

fn try_deserialize_table<T: DeserializeOwned>(value: Kv) -> Option<T> {
	serde_json::from_value(con_to_json(Value::Kv(value))).ok()
}

fn deserialize_table<T: DeserializeOwned>(value: Kv) -> T {
	try_deserialize_table(value).expect("convar table was validated before commit")
}

const fn invalid(reason: &'static str) -> Result<(), Str> {
	Err(Str::new_static(reason))
}

fn validate_retry_chains(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let Some(chains) = try_deserialize_table::<FallbackChains>(value.clone()) else {
		return invalid("fallback chains must map selectors to non-empty selector lists");
	};
	if chains.iter().all(|(key, values)| {
		!key.is_empty()
			&& !values.is_empty()
			&& values.iter().enumerate().all(|(index, value)| {
				!value.is_empty() && values[..index].iter().all(|prior| prior != value)
			})
	}) {
		Ok(())
	} else {
		invalid("fallback chains must map selectors to non-empty unique selector lists")
	}
}

fn validate_max_in_flight(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let Some(limits) = try_deserialize_table::<BTreeMap<Str, usize>>(value.clone()) else {
		return invalid("provider limits must map provider names to integers");
	};
	if limits
		.iter()
		.all(|(provider, limit)| !provider.is_empty() && *limit <= 100_000)
	{
		Ok(())
	} else {
		invalid("provider limits require non-empty names and values at most 100000")
	}
}

fn validate_bedrock_guardrails(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let Some(guardrails) = try_deserialize_table::<
		BTreeMap<Str, crate::codec::bedrock::BedrockGuardrail>,
	>(value.clone()) else {
		return invalid("Bedrock guardrails must be keyed configuration blocks");
	};
	if guardrails.iter().all(|(provider, guardrail)| {
		!provider.trim().is_empty()
			&& !guardrail.identifier.trim().is_empty()
			&& !guardrail.version.trim().is_empty()
	}) {
		Ok(())
	} else {
		invalid("Bedrock guardrails require non-empty provider, identifier, and version")
	}
}

fn validate_bedrock_request_metadata(_: &Ctx, value: &Kv) -> Result<(), Str> {
	let Some(metadata) = try_deserialize_table::<BTreeMap<Str, BTreeMap<Str, Str>>>(value.clone())
	else {
		return invalid("Bedrock request metadata must map provider names to string tag maps");
	};
	if metadata.keys().all(|provider| !provider.trim().is_empty()) {
		Ok(())
	} else {
		invalid("Bedrock request metadata requires non-empty provider names")
	}
}

const fn validate_finite(_: &Ctx, value: &f32) -> Result<(), Str> {
	if value.is_finite() {
		Ok(())
	} else {
		invalid("sampling value must be finite")
	}
}

fn validate_retry_base(ctx: &Ctx, value: &u32) -> Result<(), Str> {
	let maximum = AI_RETRY_MAX_DELAY_MS.get(ctx);
	if maximum == 0 || *value <= maximum {
		Ok(())
	} else {
		invalid("base retry delay must not exceed the maximum retry delay")
	}
}

fn validate_retry_max(ctx: &Ctx, value: &u32) -> Result<(), Str> {
	if *value == 0 || AI_RETRY_BASE_DELAY_MS.get(ctx) <= *value {
		Ok(())
	} else {
		invalid("maximum retry delay must be zero or at least the base retry delay")
	}
}

omp_con::var! {
	/// Enables transport and model fallback recovery.
	pub static AI_RETRY_ENABLED = ai_retry_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "retry.enabled",
		},
	};
	/// Maximum retry attempts on API errors
	pub static AI_RETRY_MAX_RETRIES = ai_retry_max_retries: u32 {
		default: 10,
		min: 0,
		max: 100,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Retry Attempts",
			"ui.option.1": "1 retry",
			"ui.option.2": "2 retries",
			"ui.option.3": "3 retries",
			"ui.option.5": "5 retries",
			"ui.option.10": "10 retries",
			"legacy.path": "retry.maxRetries",
			"legacy.path": "retry.max_retries",
		},
	};
	/// First exponential retry ceiling in milliseconds.
	pub static AI_RETRY_BASE_DELAY_MS = ai_retry_base_delay_ms: u32 {
		default: 500,
		min: 0,
		max: 3_600_000,
		validate: validate_retry_base,
		flags: archive,
		meta: {
			"legacy.path": "retry.base_delay_ms",
		},
	};
	/// Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets.
	pub static AI_RETRY_MAX_DELAY_MS = ai_retry_max_delay_ms: u32 {
		default: 300_000,
		min: 0,
		max: 3_600_000,
		validate: validate_retry_max,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Max Retry Delay",
			"ui.unit": "ms",
			"legacy.path": "retry.maxDelayMs",
			"legacy.path": "retry.max_delay_ms",
		},
	};
	/// Allow retry recovery to switch to configured fallback models
	pub static AI_RETRY_MODEL_FALLBACK = ai_retry_model_fallback: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Retry Model Fallback",
			"legacy.path": "retry.modelFallback",
			"legacy.path": "retry.model_fallback",
		},
	};
	/// Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.
	pub static AI_RETRY_USAGE_AWARE_FALLBACK = ai_retry_usage_aware_fallback: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Usage-Aware Fallback",
			"legacy.path": "retry.usageAwareFallback",
			"legacy.path": "retry.usage_aware_fallback",
		},
	};
	/// Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.
	pub static AI_RETRY_USAGE_RESERVE_PCT = ai_retry_usage_reserve_pct: u8 {
		default: 10,
		min: 0,
		max: 100,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Reserve Margin",
			"ui.unit": "percent",
			"ui.when": "ai_retry_usage_aware_fallback=true",
			"ui.option.5": "5%",
			"ui.option.5.desc": "Act only when nearly exhausted",
			"ui.option.10": "10%",
			"ui.option.10.desc": "Balanced safety margin",
			"ui.option.15": "15%",
			"ui.option.15.desc": "Conservative",
			"ui.option.20": "20%",
			"ui.option.20.desc": "Early protection",
			"ui.option.25": "25%",
			"ui.option.25.desc": "Very conservative",
			"legacy.path": "retry.usageReservePct",
			"legacy.path": "retry.usage_reserve_pct",
		},
	};
	/// What to do when every same-provider coding-plan account is inside the reserve margin.
	pub static AI_RETRY_USAGE_RESERVE_POLICY = ai_retry_usage_reserve_policy: UsageReservePolicy {
		default: UsageReservePolicy::Confirm,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Reserve Policy",
			"ui.when": "ai_retry_usage_aware_fallback=true",
			"ui.option.confirm": "Confirm interactively",
			"ui.option.confirm.desc": "Keep interactive sessions on the primary until confirmed; background agents auto-fallback",
			"ui.option.auto": "Auto-fallback",
			"ui.option.auto.desc": "Always select the next eligible configured fallback",
			"ui.option.fail-closed": "Fail closed",
			"ui.option.fail-closed.desc": "Do not spend reserve quota or select a fallback",
			"legacy.path": "retry.usageReservePolicy",
			"legacy.path": "retry.usage_reserve_policy",
		},
	};
	/// JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix.
	pub static AI_RETRY_FALLBACK_CHAINS = ai_retry_fallback_chains: Kv {
		default: serialize_table(&FallbackChains::new()),
		validate: validate_retry_chains,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Retry Fallback Chains",
			"legacy.path": "retry.fallbackChains",
			"legacy.path": "retry.fallback_chains",
		},
	};
	/// When to return to the primary model after a fallback
	pub static AI_RETRY_FALLBACK_REVERT = ai_retry_fallback_revert: FallbackRevertPolicy {
		default: FallbackRevertPolicy::CooldownExpiry,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Fallback Revert Policy",
			"ui.option.cooldown-expiry": "Cooldown expiry",
			"ui.option.cooldown-expiry.desc": "Return to the primary model after its suppression window ends",
			"ui.option.never": "Never",
			"ui.option.never.desc": "Stay on the fallback model until manually changed",
			"legacy.path": "retry.fallbackRevertPolicy",
			"legacy.path": "retry.fallback_revert",
		},
	};
	/// When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.
	pub static AI_RETRY_SERVER_SIDE_FALLBACK = ai_retry_server_side_fallback: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Retry & Fallback",
			"ui.label": "Anthropic Server-Side Fallback (Fable 5)",
			"legacy.path": "providers.anthropic.serverSideFallback",
			"legacy.path": "retry.server_side_fallback",
		},
	};
	/// Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)
	pub static AI_SAMPLING_TEMPERATURE = ai_sampling_temperature: f32 {
		default: -1.0,
		min: -1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Temperature",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.0": "0",
			"ui.option.0.desc": "Deterministic",
			"ui.option.0.2": "0.2",
			"ui.option.0.2.desc": "Focused",
			"ui.option.0.5": "0.5",
			"ui.option.0.5.desc": "Balanced",
			"ui.option.0.7": "0.7",
			"ui.option.0.7.desc": "Creative",
			"ui.option.1": "1",
			"ui.option.1.desc": "Maximum variety",
			"legacy.path": "sampling.temperature",
			"legacy.path": "temperature",
		},
	};
	/// Nucleus sampling cutoff (0-1, -1 = provider default)
	pub static AI_SAMPLING_TOP_P = ai_sampling_top_p: f32 {
		default: -1.0,
		min: -1.0,
		max: 1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Top P",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.0.1": "0.1",
			"ui.option.0.1.desc": "Very focused",
			"ui.option.0.3": "0.3",
			"ui.option.0.3.desc": "Focused",
			"ui.option.0.5": "0.5",
			"ui.option.0.5.desc": "Balanced",
			"ui.option.0.9": "0.9",
			"ui.option.0.9.desc": "Broad",
			"ui.option.1": "1",
			"ui.option.1.desc": "No nucleus filtering",
			"legacy.path": "topP",
			"legacy.path": "sampling.top_p",
		},
	};
	/// Sample from top-K tokens (-1 = provider default)
	pub static AI_SAMPLING_TOP_K = ai_sampling_top_k: i32 {
		default: -1,
		min: -1,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Top K",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.1": "1",
			"ui.option.1.desc": "Greedy top token",
			"ui.option.20": "20",
			"ui.option.20.desc": "Focused",
			"ui.option.40": "40",
			"ui.option.40.desc": "Balanced",
			"ui.option.100": "100",
			"ui.option.100.desc": "Broad",
			"legacy.path": "topK",
			"legacy.path": "sampling.top_k",
		},
	};
	/// Minimum probability threshold (0-1, -1 = provider default)
	pub static AI_SAMPLING_MIN_P = ai_sampling_min_p: f32 {
		default: -1.0,
		min: -1.0,
		max: 1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Min P",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.0.01": "0.01",
			"ui.option.0.01.desc": "Very permissive",
			"ui.option.0.05": "0.05",
			"ui.option.0.05.desc": "Balanced",
			"ui.option.0.1": "0.1",
			"ui.option.0.1.desc": "Strict",
			"legacy.path": "minP",
			"legacy.path": "sampling.min_p",
		},
	};
	/// Penalty for introducing already-present tokens (-1 = provider default)
	pub static AI_SAMPLING_PRESENCE_PENALTY = ai_sampling_presence_penalty: f32 {
		default: -1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Presence Penalty",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.0": "0",
			"ui.option.0.desc": "No penalty",
			"ui.option.0.5": "0.5",
			"ui.option.0.5.desc": "Mild novelty",
			"ui.option.1": "1",
			"ui.option.1.desc": "Encourage novelty",
			"ui.option.2": "2",
			"ui.option.2.desc": "Strong novelty",
			"legacy.path": "presencePenalty",
			"legacy.path": "sampling.presence_penalty",
		},
	};
	/// Default frequency penalty; negative preserves provider default.
	pub static AI_SAMPLING_FREQUENCY_PENALTY = ai_sampling_frequency_penalty: f32 {
		default: -1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"legacy.path": "sampling.frequency_penalty",
		},
	};
	/// Penalty for repeated tokens (-1 = provider default)
	pub static AI_SAMPLING_REPETITION_PENALTY = ai_sampling_repetition_penalty: f32 {
		default: -1.0,
		validate: validate_finite,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Repetition Penalty",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use provider default",
			"ui.option.0.8": "0.8",
			"ui.option.0.8.desc": "Allow repetition",
			"ui.option.1": "1",
			"ui.option.1.desc": "No penalty",
			"ui.option.1.1": "1.1",
			"ui.option.1.1.desc": "Mild penalty",
			"ui.option.1.2": "1.2",
			"ui.option.1.2.desc": "Balanced",
			"ui.option.1.5": "1.5",
			"ui.option.1.5.desc": "Strong penalty",
			"legacy.path": "repetitionPenalty",
			"legacy.path": "sampling.repetition_penalty",
		},
	};
	/// OpenAI Responses and Codex response verbosity (low, medium, or high)
	pub static AI_SAMPLING_VERBOSITY = ai_sampling_verbosity: TextVerbositySetting {
		default: TextVerbositySetting::Medium,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Sampling",
			"ui.label": "Text Verbosity",
			"ui.option.low": "Low",
			"ui.option.low.desc": "Prefer concise responses",
			"ui.option.medium": "Medium",
			"ui.option.medium.desc": "Balance brevity and detail (default)",
			"ui.option.high": "High",
			"ui.option.high.desc": "Prefer detailed responses",
			"legacy.path": "textVerbosity",
			"legacy.path": "sampling.verbosity",
		},
	};
	/// Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited.
	pub static AI_PROVIDER_MAX_IN_FLIGHT = ai_provider_max_in_flight: Kv {
		default: serialize_table(&BTreeMap::<Str, usize>::new()),
		validate: validate_max_in_flight,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Max In-Flight Requests",
			"ui.widget": "provider-limits",
			"legacy.path": "providers.maxInFlightRequests",
			"legacy.path": "provider_runtime.max_in_flight",
		},
	};
	/// Maximum queued callers per provider before backpressure fails fast.
	pub static AI_PROVIDER_MAX_QUEUED = ai_provider_max_queued: u32 {
		default: 64,
		min: 0,
		max: 100_000,
		flags: archive,
		meta: {
			"legacy.path": "provider_runtime.max_queued",
		},
	};
	/// Per-transport-attempt timeout in seconds.
	pub static AI_PROVIDER_TIMEOUT_SECONDS = ai_provider_timeout_seconds: u32 {
		default: 300,
		min: 1,
		max: 3_600,
		flags: archive,
		meta: {
			"legacy.path": "provider_runtime.timeout_seconds",
		},
	};
	/// Overall logical-call timeout in seconds; zero preserves caller deadlines.
	pub static AI_PROVIDER_CALL_TIMEOUT_SECONDS = ai_provider_call_timeout_seconds: u32 {
		default: 0,
		min: 0,
		max: 86_400,
		flags: archive,
		meta: {
			"legacy.path": "provider_runtime.call_timeout_seconds",
		},
	};
	/// Bedrock guardrail policy keyed by provider id.
	pub static AI_PROVIDER_BEDROCK_GUARDRAILS = ai_provider_bedrock_guardrails: Kv {
		default: serialize_table(&BTreeMap::<Str, crate::codec::bedrock::BedrockGuardrail>::new()),
		validate: validate_bedrock_guardrails,
		flags: archive,
		meta: {
			"legacy.path": "provider_runtime.bedrock_guardrails",
		},
	};
	/// Bedrock invocation-log attribution tags keyed by provider id.
	pub static AI_PROVIDER_BEDROCK_REQUEST_METADATA = ai_provider_bedrock_request_metadata: Kv {
		default: serialize_table(&BTreeMap::<Str, BTreeMap<Str, Str>>::new()),
		validate: validate_bedrock_request_metadata,
		flags: archive,
		meta: {
			"legacy.path": "provider_runtime.bedrock_request_metadata",
		},
	};
}

omp_con::var! {
	/// Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.
	pub static AI_ADVISOR_ENABLED = ai_advisor_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Advisor",
			"ui.label": "Enable Advisor",
			"legacy.path": "advisor.enabled",
		},
	};
	/// Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.
	pub static AI_PREWALK_ENABLED = ai_prewalk_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Prewalk",
			"ui.label": "Enable Prewalk",
			"legacy.path": "prewalk.enabled",
		},
	};
	/// Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.
	pub static AI_ADVISOR_SYNC_BACKLOG = ai_advisor_sync_backlog: Str {
		default: Str::new_static("off"),
		suggest: ["off", "1", "3", "5"],
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Advisor",
			"ui.label": "Advisor Sync Backlog",
			"ui.when": "ai_advisor_enabled=true",
			"ui.option.off": "off",
			"ui.option.1": "1",
			"ui.option.3": "3",
			"ui.option.5": "5",
			"legacy.path": "advisor.syncBacklog",
		},
	};
	/// After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.
	pub static AI_ADVISOR_IMMUNE_TURNS = ai_advisor_immune_turns: i64 {
		default: 3,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Advisor",
			"ui.label": "Advisor Immune Turns",
			"ui.when": "ai_advisor_enabled=true",
			"ui.option.0": "0 turns",
			"ui.option.0.desc": "Allow every concern/blocker to interrupt.",
			"ui.option.1": "1 turn",
			"ui.option.2": "2 turns",
			"ui.option.3": "3 turns",
			"ui.option.3.desc": "Default.",
			"ui.option.4": "4 turns",
			"ui.option.5": "5 turns",
			"legacy.path": "advisor.immuneTurns",
		},
	};
	/// Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning
	pub static AI_EXTERNAL_THINKING = ai_external_thinking: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"ui.group": "Thinking",
			"ui.label": "External Thinking",
			"ui.warning": "At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement",
			"legacy.path": "externalThinking",
		},
	};
	/// Promote to a larger-context model on context overflow instead of compacting
	pub static AI_CONTEXT_PROMOTION_ENABLED = ai_context_promotion_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "context",
			"ui.group": "General",
			"ui.label": "Auto-Promote Context",
			"legacy.path": "contextPromotion.enabled",
		},
	};
	/// Automatically compact context when it gets too large
	pub static AI_COMPACTION_ENABLED = ai_compaction_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "context",
			"ui.group": "Compaction",
			"ui.label": "Auto-Compact",
			"legacy.path": "compaction.enabled",
		},
	};
	/// Check thresholds at safe mid-turn tool-loop boundaries before the next provider request
	pub static AI_COMPACTION_MID_TURN_ENABLED = ai_compaction_mid_turn_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "context",
			"ui.group": "Compaction",
			"ui.label": "Mid-Turn Compaction",
			"legacy.path": "compaction.midTurnEnabled",
		},
	};
	/// Fixed token limit for context maintenance; overrides percentage if set
	pub static AI_COMPACTION_THRESHOLD_TOKENS = ai_compaction_threshold_tokens: i64 {
		default: -1,
		flags: archive,
		meta: {
			"ui.tab": "context",
			"ui.group": "Compaction",
			"ui.label": "Compaction Token Limit",
			"ui.option.-1": "Default",
			"ui.option.-1.desc": "Use percentage-based threshold",
			"ui.option.25000": "25K tokens",
			"ui.option.25000.desc": "1/8 of a 200K window",
			"ui.option.50000": "50K tokens",
			"ui.option.50000.desc": "1/4 of a 200K window",
			"ui.option.100000": "100K tokens",
			"ui.option.100000.desc": "1/2 of a 200K window",
			"ui.option.150000": "150K tokens",
			"ui.option.150000.desc": "3/4 of a 200K window",
			"ui.option.200000": "200K tokens",
			"ui.option.200000.desc": "Full standard context window",
			"ui.option.300000": "300K tokens",
			"ui.option.300000.desc": "Large context window",
			"ui.option.500000": "500K tokens",
			"ui.option.500000.desc": "Very large context window",
			"legacy.path": "compaction.thresholdTokens",
		},
	};
	/// Legacy token reserve used when no explicit compaction threshold is configured.
	pub static AI_COMPACTION_RESERVE_TOKENS = ai_compaction_reserve_tokens: f64 {
		default: -1.0,
		flags: archive,
		meta: {
			"legacy.path": "compaction.reserveTokens",
		},
	};
	/// Recent-token tail preserved when context is compacted.
	pub static AI_COMPACTION_KEEP_RECENT_TOKENS = ai_compaction_keep_recent_tokens: i64 {
		default: 20000,
		flags: archive,
		meta: {
			"legacy.path": "compaction.keepRecentTokens",
		},
	};
}

omp_con::var! {
	/// Optional SQLite DB path. Defaults to the agent memories directory.
	pub static AI_MNEMOPI_DB_PATH = ai_mnemopi_db_path: Str {
		default: Str::new_static(""),
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "Mnemopi",
			"ui.label": "Mnemopi DB Path",
			"ui.when": "ai_memory_backend=mnemopi",
			"legacy.path": "mnemopi.dbPath",
		},
	};
}

omp_con::var! {
	/// Prioritized providers for image generation; unlisted providers follow the active session provider and the built-in order
	pub static AI_PROVIDERS_IMAGE_ORDER = ai_providers_image_order: Vec<Str> {
		default: Vec::new(),
		suggest: ["openai", "openai-codex", "antigravity", "xai", "gemini", "openrouter", "deepinfra"],
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Image Provider Order",
			"ui.ordered": "true",
			"ui.option.openai": "OpenAI",
			"ui.option.openai.desc": "OPENAI_API_KEY (gpt-image-2) or active GPT model; falls back to a connected Codex subscription",
			"ui.option.openai-codex": "OpenAI Codex (ChatGPT)",
			"ui.option.openai-codex.desc": "Uses a connected Codex / ChatGPT subscription — no OPENAI_API_KEY needed",
			"ui.option.antigravity": "Antigravity",
			"ui.option.antigravity.desc": "Requires google-antigravity OAuth",
			"ui.option.xai": "xAI Grok Imagine",
			"ui.option.xai.desc": "Requires xAI Grok OAuth or XAI_API_KEY",
			"ui.option.gemini": "Gemini",
			"ui.option.gemini.desc": "Requires GEMINI_API_KEY",
			"ui.option.openrouter": "OpenRouter",
			"ui.option.openrouter.desc": "Requires OPENROUTER_API_KEY",
			"ui.option.deepinfra": "DeepInfra",
			"ui.option.deepinfra.desc": "Requires DEEPINFRA_API_KEY",
			"legacy.path": "providers.imageOrder",
		},
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn zero_max_retry_delay_is_a_valid_uncapped_sentinel() {
		let settings =
			RetrySettings { base_delay_ms: 500, max_delay_ms: 0, ..RetrySettings::default() };
		assert!(settings.validate());
		assert_eq!(settings.backoff().maximum, Duration::ZERO);
	}
	#[test]
	fn planning_projects_retry_budget_onto_the_real_call_once() {
		let mut call = Call::new(
			crate::call::CallMeta {
				id:             crate::id::RequestId::from("settings-budget"),
				target:         crate::call::Target::ProviderService(ProviderId::from("provider")),
				deadline:       None,
				budget:         ExecutionBudget::default(),
				session:        None,
				debug_session:  None,
				response_hooks: Default::default(),
			},
			OperationCall::Auth(sync::Arc::new(crate::call::AuthRequest::ListAccounts {
				provider: None,
			})),
		);
		let settings = InferenceSettings::default();
		settings.apply_planning_call(&mut call);
		assert_eq!(call.budget.max_attempts, settings.retry.max_attempts());
		let planned_budget = call.budget.clone();
		settings.apply_call(&mut call);
		assert_eq!(call.budget, planned_budget, "late request projection cannot mutate budget");
	}

	#[test]
	fn from_con_projects_typed_overrides() {
		let ctx = Ctx::new();
		AI_RETRY_MAX_RETRIES.set(&ctx, 3).expect("set retry limit");
		AI_SAMPLING_VERBOSITY
			.set(&ctx, TextVerbositySetting::High)
			.expect("set verbosity");
		let metadata = BTreeMap::from([(
			Str::new_static("amazon-bedrock"),
			BTreeMap::from([(Str::new_static("team"), Str::new_static("growth"))]),
		)]);
		AI_PROVIDER_BEDROCK_REQUEST_METADATA
			.set(&ctx, serialize_table(&metadata))
			.expect("set Bedrock request metadata");
		crate::settings::AI_CONTEXT_PROMOTION_ENABLED
			.set(&ctx, true)
			.expect("enable context promotion");
		let settings = InferenceSettings::from_con(&ctx);
		assert_eq!(settings.retry.max_retries, 3);
		assert!(settings.context_promotion_enabled);
		assert_eq!(settings.sampling.verbosity, TextVerbositySetting::High);
		assert_eq!(settings.providers.bedrock_request_metadata, metadata);
		assert!(settings.retry.validate());
		assert!(settings.sampling.validate());
		assert!(settings.providers.validate());
	}

	#[test]
	fn fallback_walk_reaches_chain_owned_by_last_fallback_within_budget() {
		let settings = RetrySettings {
			fallback_chains: BTreeMap::from([
				(Str::new_static("provider/a"), vec![Str::new_static("provider/b")]),
				(Str::new_static("provider/b"), vec![Str::new_static("provider/c")]),
			]),
			..RetrySettings::default()
		};
		let walked = settings.fallback_walk(
			ModelKey::from_ref("provider/a"),
			Some(ProviderId::from_ref("provider")),
			2,
			|model| {
				matches!(model.as_str(), "provider/a" | "provider/b" | "provider/c")
					.then(|| ProviderId::from("provider"))
			},
		);
		assert_eq!(walked, [ModelKey::from("provider/b"), ModelKey::from("provider/c"),]);
	}

	#[test]
	fn fallback_walk_deduplicates_cycles_and_obeys_attempt_bound() {
		let settings = RetrySettings {
			fallback_chains: BTreeMap::from([
				(Str::new_static("provider/a"), vec![Str::new_static("provider/b")]),
				(Str::new_static("provider/b"), vec![Str::new_static("provider/a")]),
			]),
			..RetrySettings::default()
		};
		assert_eq!(
			settings.fallback_walk(
				ModelKey::from_ref("provider/a"),
				Some(ProviderId::from_ref("provider")),
				10,
				|_| Some(ProviderId::from("provider")),
			),
			[ModelKey::from("provider/b")]
		);
	}
}
