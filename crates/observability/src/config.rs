//! Fail-open telemetry configuration and host hooks.
//!
//! [`TelemetryConfig`] owns tracer, attribute, usage, and callback settings.
//! User code runs through fail-open methods: returned errors and panics become
//! [`TelemetryWarning`] values, while failures in the warning hook are
//! swallowed.

use std::{
	any::Any,
	env,
	panic::{AssertUnwindSafe, catch_unwind},
	sync::Arc,
};

use omp_core::{Str, sf};
use opentelemetry::{Array, KeyValue, StringValue, Value, global::BoxedTracer, trace::Span as _};
use serde_json::Value as JsonValue;
use smallvec::SmallVec;

use crate::{
	attrs::omp_gen_ai,
	collector::{RunCoverage, RunSummary},
	content::{self, RequestContent, ResponseContent},
	redact::redact_sensitive_credentials,
	semconv::{self, CaptureMode},
	span::Span,
};

/// Default instrumentation-library name.
pub const DEFAULT_TRACER_NAME: &str = "@omp/agent-core";

/// A result returned by a host telemetry callback.
pub type HookResult<T = ()> = Result<T, Str>;

/// Attributes attached to a span by static configuration or a resolver.
pub type TelemetryAttributes = SmallVec<KeyValue, 8>;

/// Identifies the agent span being configured or reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelemetrySpanKind {
	/// The outer agent invocation.
	InvokeAgent,
	/// One provider chat step.
	Chat,
	/// One tool execution.
	ExecuteTool,
	/// One agent handoff.
	Handoff,
}

/// Owned agent identity retained by telemetry configuration and events.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TelemetryAgentIdentity {
	/// Stable agent identifier.
	pub id:          Option<Str>,
	/// Human-readable agent name.
	pub name:        Option<Str>,
	/// Human-readable agent description.
	pub description: Option<Str>,
}

/// Context supplied to dynamic attributes and lifecycle callbacks.
#[derive(Clone, Copy, Debug)]
pub struct TelemetryAttributeContext<'a> {
	/// Kind of span being processed.
	pub kind:            TelemetrySpanKind,
	/// Provider model identifier, when applicable.
	pub model:           Option<&'a str>,
	/// Current agent identity, when known.
	pub agent:           Option<&'a TelemetryAgentIdentity>,
	/// Conversation identifier, when known.
	pub conversation_id: Option<&'a str>,
	/// Zero-based chat step number; absent on other span kinds.
	pub step_number:     Option<u64>,
	/// Tool-call identifier on tool spans.
	pub tool_call_id:    Option<&'a str>,
	/// Tool name on tool spans.
	pub tool_name:       Option<&'a str>,
}

/// Context supplied to span start and end callbacks.
pub struct TelemetryHookContext<'a> {
	/// Attributes describing the span.
	pub attributes: TelemetryAttributeContext<'a>,
	/// Mutable span handle, allowing a hook to stamp attributes.
	pub span:       &'a mut Span,
}

/// Accuracy of usage figures supplied to telemetry hooks.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum UsageAccuracy {
	/// Usage came directly from the provider.
	#[default]
	Actual,
	/// All counts were estimated by the harness.
	Estimated,
	/// Provider and estimated counts were combined.
	Mixed,
}

/// Bucketed token counts supplied to cost and usage hooks.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ChatUsageSnapshot {
	/// Input tokens.
	pub input_tokens:            u64,
	/// Output tokens.
	pub output_tokens:           u64,
	/// Total tokens.
	pub total_tokens:            u64,
	/// Cache-read input tokens.
	pub cached_input_tokens:     Option<u64>,
	/// Cache-write input tokens.
	pub cache_write_tokens:      Option<u64>,
	/// Reasoning output tokens.
	pub reasoning_output_tokens: Option<u64>,
	/// Whether the counts are actual, estimated, or mixed.
	pub accuracy:                UsageAccuracy,
}

/// Input supplied to the configured cost estimator.
#[derive(Clone, Copy, Debug)]
pub struct CostEstimatorContext<'a> {
	/// Normalized provider name.
	pub provider:     &'a str,
	/// Provider model identifier.
	pub model:        &'a str,
	/// Requested or resolved service tier.
	pub service_tier: Option<&'a str>,
	/// Bucketed token usage.
	pub usage:        ChatUsageSnapshot,
}

/// Cost estimate returned by a cost estimator.
#[derive(Clone, Debug, PartialEq)]
pub enum CostEstimate {
	/// Pricing was available.
	Available {
		/// Total estimated USD cost.
		usd:        f64,
		/// Optional input-side USD cost.
		input_usd:  Option<f64>,
		/// Optional output-side USD cost.
		output_usd: Option<f64>,
	},
	/// Pricing intentionally could not be determined.
	Unavailable {
		/// Stable reason suitable for an attribute value.
		reason: Str,
	},
}

/// Event delivered after estimating one chat step's cost.
#[derive(Clone, Debug)]
pub struct CostDelta<'a> {
	/// Conversation identifier.
	pub conversation_id:         Option<&'a str>,
	/// Current agent identity.
	pub agent:                   Option<&'a TelemetryAgentIdentity>,
	/// Zero-based chat step number.
	pub step_number:             Option<u64>,
	/// Normalized provider name.
	pub provider:                &'a str,
	/// Provider model identifier.
	pub model:                   &'a str,
	/// Requested or resolved service tier.
	pub service_tier:            Option<&'a str>,
	/// Bucketed token usage.
	pub usage:                   ChatUsageSnapshot,
	/// Total estimated USD cost.
	pub cost_usd:                Option<f64>,
	/// Input-side USD cost.
	pub input_usd:               Option<f64>,
	/// Output-side USD cost.
	pub output_usd:              Option<f64>,
	/// Reason pricing was unavailable.
	pub cost_unavailable_reason: Option<&'a str>,
}

/// Event delivered for every chat step carrying usage.
pub struct ChatUsageEvent<'a> {
	/// Chat span associated with this usage.
	pub span:            &'a mut Span,
	/// Current agent identity.
	pub agent:           Option<&'a TelemetryAgentIdentity>,
	/// Conversation identifier.
	pub conversation_id: Option<&'a str>,
	/// Zero-based chat step number.
	pub step_number:     Option<u64>,
	/// Provider model identifier.
	pub model:           &'a str,
	/// Normalized provider name.
	pub provider:        Option<&'a str>,
	/// Requested or resolved service tier.
	pub service_tier:    Option<&'a str>,
	/// Bucketed token usage.
	pub usage:           ChatUsageSnapshot,
	/// Resolved cost, when any.
	pub cost:            Option<&'a CostEstimate>,
	/// Resolved dynamic span attributes.
	pub attributes:      Option<&'a [KeyValue]>,
	/// Lower-cased upstream response headers.
	pub headers:         Option<&'a [(Str, Str)]>,
}

/// Stable category for a non-fatal telemetry failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelemetryWarningCode {
	/// Dynamic attribute resolution failed.
	ResolveAttributesFailed,
	/// A custom content serializer failed.
	ContentSerializerFailed,
	/// The cost-delta callback failed.
	OnCostDeltaFailed,
	/// The chat-usage callback failed.
	OnChatUsageFailed,
	/// Cost estimation failed.
	CostEstimatorFailed,
	/// The run-end callback failed.
	OnRunEndFailed,
	/// The span-start callback failed.
	OnSpanStartFailed,
	/// The span-end callback failed.
	OnSpanEndFailed,
	/// Agent-name normalization failed.
	NormalizeAgentNameFailed,
	/// Provider normalization failed.
	NormalizeProviderFailed,
	/// The warning callback itself failed; this is swallowed.
	OnTelemetryWarningFailed,
}

/// Non-fatal telemetry callback failure delivered to the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetryWarning {
	/// Stable failure category.
	pub code:    TelemetryWarningCode,
	/// Human-readable description.
	pub message: Str,
	/// Error or panic description, when available.
	pub error:   Option<Str>,
}

/// Optional overrides for five bounded content serializers.
#[derive(Clone, Default)]
pub struct TelemetryContentSerializer {
	/// Override request-message summary serialization.
	pub request_messages:    Option<RequestSerializer>,
	/// Override assistant-text summary serialization.
	pub response_text:       Option<ResponseSerializer>,
	/// Override assistant tool-call summary serialization.
	pub response_tool_calls: Option<ResponseSerializer>,
	/// Override tool-call argument summary serialization.
	pub tool_call_arguments: Option<JsonSerializer>,
	/// Override tool-result summary serialization.
	pub tool_call_result:    Option<JsonSerializer>,
}

/// Request-content serializer hook.
pub type RequestSerializer =
	Arc<dyn for<'a> Fn(RequestContent<'a>) -> HookResult<Option<Str>> + Send + Sync>;
/// Response-content serializer hook.
pub type ResponseSerializer =
	Arc<dyn for<'a> Fn(ResponseContent<'a>) -> HookResult<Option<Str>> + Send + Sync>;
/// Arbitrary JSON serializer hook.
pub type JsonSerializer = Arc<dyn Fn(&JsonValue) -> HookResult<Option<Str>> + Send + Sync>;
/// Dynamic attribute resolver hook.
pub type AttributeResolver = Arc<
	dyn for<'a> Fn(&TelemetryAttributeContext<'a>) -> HookResult<TelemetryAttributes> + Send + Sync,
>;
/// Provider or agent-name normalizer hook.
pub type NameNormalizer = Arc<dyn Fn(Option<&str>) -> HookResult<Option<Str>> + Send + Sync>;
/// Cost estimator hook.
pub type CostEstimator =
	Arc<dyn for<'a> Fn(&CostEstimatorContext<'a>) -> HookResult<Option<CostEstimate>> + Send + Sync>;
/// Span lifecycle hook.
pub type SpanHook = Arc<dyn for<'a> Fn(&mut TelemetryHookContext<'a>) -> HookResult + Send + Sync>;
/// Cost-delta lifecycle hook.
pub type CostDeltaHook = Arc<dyn for<'a> Fn(&CostDelta<'a>) -> HookResult + Send + Sync>;
/// Chat-usage lifecycle hook.
pub type ChatUsageHook = Arc<dyn for<'a> Fn(&mut ChatUsageEvent<'a>) -> HookResult + Send + Sync>;
/// Run-end lifecycle hook.
pub type RunEndHook = Arc<dyn Fn(&RunSummary, &RunCoverage) -> HookResult + Send + Sync>;
/// Warning callback hook.
pub type WarningHook = Arc<dyn Fn(&TelemetryWarning) -> HookResult + Send + Sync>;

/// Cheaply cloneable, thread-safe telemetry configuration.
#[derive(Clone)]
pub struct TelemetryConfig {
	/// Explicit tracer override; otherwise the global tracer is resolved lazily.
	pub tracer:                  Option<Arc<BoxedTracer>>,
	/// Tracer-name override.
	pub tracer_name:             Str,
	/// Message-content capture policy.
	pub capture_message_content: CaptureMode,
	/// Static attributes merged onto every span.
	pub attributes:              Arc<[KeyValue]>,
	/// Dynamic attributes resolved once for each span.
	pub resolve_attributes:      Option<AttributeResolver>,
	/// Agent identity stamped on agent spans and propagated to children.
	pub agent:                   Option<TelemetryAgentIdentity>,
	/// Explicit conversation identifier.
	pub conversation_id:         Option<Str>,
	/// Per-step cost estimator override.
	pub cost_estimator:          Option<CostEstimator>,
	/// Cost-delta lifecycle callback.
	pub on_cost_delta:           Option<CostDeltaHook>,
	/// Chat-usage lifecycle callback.
	pub on_chat_usage:           Option<ChatUsageHook>,
	/// Provider-name normalization override.
	pub normalize_provider:      Option<NameNormalizer>,
	/// Agent-name normalization override.
	pub normalize_agent_name:    Option<NameNormalizer>,
	/// Bounded content serializer overrides.
	pub content_serializer:      TelemetryContentSerializer,
	/// Span-start lifecycle callback.
	pub on_span_start:           Option<SpanHook>,
	/// Span-end lifecycle callback.
	pub on_span_end:             Option<SpanHook>,
	/// Run-end lifecycle callback.
	pub on_run_end:              Option<RunEndHook>,
	/// Receiver for non-fatal telemetry failures.
	pub on_telemetry_warning:    Option<WarningHook>,
}

impl Default for TelemetryConfig {
	fn default() -> Self {
		Self {
			tracer:                  None,
			tracer_name:             sf!(DEFAULT_TRACER_NAME),
			capture_message_content: CaptureMode::from_env_value(
				env::var("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT")
					.ok()
					.as_deref(),
			),
			attributes:              Arc::from([]),
			resolve_attributes:      None,
			agent:                   None,
			conversation_id:         None,
			cost_estimator:          None,
			on_cost_delta:           None,
			on_chat_usage:           None,
			normalize_provider:      None,
			normalize_agent_name:    None,
			content_serializer:      TelemetryContentSerializer::default(),
			on_span_start:           None,
			on_span_end:             None,
			on_run_end:              None,
			on_telemetry_warning:    None,
		}
	}
}

impl TelemetryConfig {
	/// Returns the configured tracer name.
	pub fn tracer_name(&self) -> &str {
		&self.tracer_name
	}

	/// Resolves the explicit tracer or lazily obtains the named global tracer.
	pub fn resolve_tracer(&self) -> Arc<BoxedTracer> {
		self
			.tracer
			.clone()
			.unwrap_or_else(|| Arc::new(opentelemetry::global::tracer(self.tracer_name.to_string())))
	}

	/// Resolves static and dynamic attributes in declaration order.
	pub fn attributes_for_span(
		&self,
		context: &TelemetryAttributeContext<'_>,
	) -> TelemetryAttributes {
		let mut attributes: TelemetryAttributes = self
			.attributes
			.iter()
			.cloned()
			.map(redact_attribute)
			.collect();
		let Some(resolver) = &self.resolve_attributes else {
			return attributes;
		};
		match invoke(&**resolver, context) {
			Ok(dynamic) => attributes.extend(dynamic.into_iter().map(redact_attribute)),
			Err(error) => self.warn(
				TelemetryWarningCode::ResolveAttributesFailed,
				"resolveAttributes failed; ignoring dynamic telemetry attributes",
				error,
			),
		}
		attributes
	}

	/// Applies configured static and dynamic attributes to a span.
	pub fn apply_span_attributes(&self, span: &mut Span, context: &TelemetryAttributeContext<'_>) {
		for attribute in self.attributes_for_span(context) {
			span.set_attribute(attribute);
		}
	}

	/// Normalizes a provider, falling back to [`semconv::normalize_provider`].
	pub fn normalized_provider(&self, provider: Option<&str>) -> Option<Str> {
		let Some(normalizer) = &self.normalize_provider else {
			return provider
				.map(semconv::normalize_provider)
				.filter(|value| !value.is_empty())
				.map(Str::new);
		};
		match invoke(&**normalizer, provider) {
			Ok(value) => value,
			Err(error) => {
				self.warn(
					TelemetryWarningCode::NormalizeProviderFailed,
					"normalizeProvider failed; using the built-in normalization",
					error,
				);
				provider
					.map(semconv::normalize_provider)
					.filter(|value| !value.is_empty())
					.map(Str::new)
			},
		}
	}

	/// Normalizes an agent name, preserving the built-in identity behavior.
	pub fn normalized_agent_name(&self, name: Option<&str>) -> Option<Str> {
		let Some(normalizer) = &self.normalize_agent_name else {
			return name.filter(|value| !value.is_empty()).map(Str::new);
		};
		match invoke(&**normalizer, name) {
			Ok(value) => value,
			Err(error) => {
				self.warn(
					TelemetryWarningCode::NormalizeAgentNameFailed,
					"normalizeAgentName failed; using the original agent name",
					error,
				);
				name.filter(|value| !value.is_empty()).map(Str::new)
			},
		}
	}

	/// Normalizes the name within an agent identity without changing its other
	/// fields.
	pub fn normalized_agent_identity(
		&self,
		agent: &TelemetryAgentIdentity,
	) -> TelemetryAgentIdentity {
		TelemetryAgentIdentity {
			id:          agent.id.clone(),
			name:        self.normalized_agent_name(agent.name.as_deref()),
			description: agent.description.clone(),
		}
	}

	/// Estimates cost with a custom estimator, falling back to catalog pricing.
	///
	/// `catalog_priced` is the caller's model-catalog lookup. It is also used if
	/// the custom estimator errors or panics, so telemetry cannot break a turn.
	pub fn estimate_cost(
		&self,
		context: &CostEstimatorContext<'_>,
		catalog_priced: impl FnOnce(&CostEstimatorContext<'_>) -> Option<CostEstimate>,
	) -> Option<CostEstimate> {
		let Some(estimator) = &self.cost_estimator else {
			return catalog_priced(context);
		};
		match invoke(&**estimator, context) {
			Ok(Some(cost)) => Some(cost),
			Ok(None) => catalog_priced(context),
			Err(error) => {
				self.warn(
					TelemetryWarningCode::CostEstimatorFailed,
					"costEstimator failed; using catalog pricing",
					error,
				);
				catalog_priced(context)
			},
		}
	}

	/// Invokes the span-start hook without allowing failures to escape.
	pub fn span_started(&self, context: &mut TelemetryHookContext<'_>) {
		let Some(hook) = &self.on_span_start else {
			return;
		};
		if let Err(error) = invoke(&**hook, context) {
			self.warn(
				TelemetryWarningCode::OnSpanStartFailed,
				"onSpanStart failed; swallowing telemetry hook failure",
				error,
			);
		}
	}

	/// Invokes the span-end hook without allowing failures to escape.
	pub fn span_ended(&self, context: &mut TelemetryHookContext<'_>) {
		let Some(hook) = &self.on_span_end else {
			return;
		};
		if let Err(error) = invoke(&**hook, context) {
			self.warn(
				TelemetryWarningCode::OnSpanEndFailed,
				"onSpanEnd failed; swallowing telemetry hook failure",
				error,
			);
		}
	}

	/// Invokes the cost-delta hook without allowing failures to escape.
	pub fn cost_delta(&self, event: &CostDelta<'_>) {
		let Some(hook) = &self.on_cost_delta else {
			return;
		};
		if let Err(error) = invoke(&**hook, event) {
			self.warn(
				TelemetryWarningCode::OnCostDeltaFailed,
				"onCostDelta failed; swallowing telemetry hook failure",
				error,
			);
		}
	}

	/// Invokes the chat-usage hook without allowing failures to escape.
	pub fn chat_usage(&self, event: &mut ChatUsageEvent<'_>) {
		let Some(hook) = &self.on_chat_usage else {
			return;
		};
		if let Err(error) = invoke(&**hook, event) {
			self.warn(
				TelemetryWarningCode::OnChatUsageFailed,
				"onChatUsage failed; swallowing telemetry hook failure",
				error,
			);
		}
	}

	/// Invokes the run-end hook without allowing failures to escape.
	pub fn run_ended(&self, summary: &RunSummary, coverage: &RunCoverage) {
		let Some(hook) = &self.on_run_end else { return };
		if let Err(error) = invoke2(&**hook, summary, coverage) {
			self.warn(
				TelemetryWarningCode::OnRunEndFailed,
				"onRunEnd failed; swallowing telemetry hook failure",
				error,
			);
		}
	}

	/// Serializes a bounded request summary, honoring a custom override.
	pub fn serialize_request_messages(&self, request: RequestContent<'_>) -> Option<Str> {
		if let Some(serializer) = &self.content_serializer.request_messages {
			return self.serialized_result(invoke(&**serializer, request));
		}
		string_attribute(
			content::request_attributes(CaptureMode::Summary, request),
			omp_gen_ai::REQUEST_MESSAGES,
		)
	}

	/// Serializes a bounded response-text summary, honoring a custom override.
	pub fn serialize_response_text(&self, response: ResponseContent<'_>) -> Option<Str> {
		if let Some(serializer) = &self.content_serializer.response_text {
			return self.serialized_result(invoke(&**serializer, response));
		}
		string_attribute(
			content::response_attributes(CaptureMode::Summary, response),
			omp_gen_ai::RESPONSE_TEXT,
		)
	}

	/// Serializes a bounded response-tool-call summary, honoring an override.
	pub fn serialize_response_tool_calls(&self, response: ResponseContent<'_>) -> Option<Str> {
		if let Some(serializer) = &self.content_serializer.response_tool_calls {
			return self.serialized_result(invoke(&**serializer, response));
		}
		string_attribute(
			content::response_attributes(CaptureMode::Summary, response),
			omp_gen_ai::RESPONSE_TOOL_CALLS,
		)
	}

	/// Serializes bounded tool-call arguments, honoring a custom override.
	pub fn serialize_tool_call_arguments(&self, value: &JsonValue) -> Option<Str> {
		self.serialize_json(
			self.content_serializer.tool_call_arguments.as_ref(),
			value,
			content::tool_arguments_attribute,
		)
	}

	/// Serializes a bounded tool result, honoring a custom override.
	pub fn serialize_tool_call_result(&self, value: &JsonValue) -> Option<Str> {
		self.serialize_json(
			self.content_serializer.tool_call_result.as_ref(),
			value,
			content::tool_result_attribute,
		)
	}

	fn serialized_result(&self, result: Result<Option<Str>, Str>) -> Option<Str> {
		match result {
			Ok(value) => value.map(|value| Str::from(redact_sensitive_credentials(value.as_str()))),
			Err(error) => {
				self.warn(
					TelemetryWarningCode::ContentSerializerFailed,
					"contentSerializer failed; omitting captured content",
					error,
				);
				None
			},
		}
	}

	fn serialize_json(
		&self,
		serializer: Option<&JsonSerializer>,
		value: &JsonValue,
		default: fn(CaptureMode, &JsonValue) -> Option<KeyValue>,
	) -> Option<Str> {
		if let Some(serializer) = serializer {
			return match invoke(&**serializer, value) {
				Ok(value) => value.map(|value| Str::from(redact_sensitive_credentials(value.as_str()))),
				Err(error) => {
					self.warn(
						TelemetryWarningCode::ContentSerializerFailed,
						"contentSerializer failed; omitting captured content",
						error,
					);
					None
				},
			};
		}
		default(CaptureMode::Summary, value).and_then(key_value_string)
	}

	/// Delivers a host-defined warning, swallowing warning-hook failures.
	pub fn telemetry_warning(&self, warning: &TelemetryWarning) {
		let Some(hook) = &self.on_telemetry_warning else {
			return;
		};
		let _ = catch_unwind(AssertUnwindSafe(|| hook(warning)));
	}

	fn warn(&self, code: TelemetryWarningCode, message: &'static str, error: Str) {
		let warning = TelemetryWarning {
			code,
			message: sf!(message),
			error: Some(Str::from(redact_sensitive_credentials(error.as_str()))),
		};
		self.telemetry_warning(&warning);
	}
}

fn redact_attribute(attribute: KeyValue) -> KeyValue {
	let value = match attribute.value {
		Value::String(value) => {
			Value::String(StringValue::from(redact_sensitive_credentials(value.as_str())))
		},
		Value::Array(Array::String(values)) => Value::Array(Array::String(
			values
				.into_iter()
				.map(|value| StringValue::from(redact_sensitive_credentials(value.as_str())))
				.collect(),
		)),
		value => value,
	};
	KeyValue::new(attribute.key, value)
}

fn invoke<A, T>(hook: &(impl Fn(A) -> HookResult<T> + ?Sized), argument: A) -> Result<T, Str> {
	match catch_unwind(AssertUnwindSafe(|| hook(argument))) {
		Ok(result) => result,
		Err(payload) => Err(panic_message(payload)),
	}
}

fn invoke2<A, B, T>(
	hook: &(impl Fn(A, B) -> HookResult<T> + ?Sized),
	first: A,
	second: B,
) -> Result<T, Str> {
	match catch_unwind(AssertUnwindSafe(|| hook(first, second))) {
		Ok(result) => result,
		Err(payload) => Err(panic_message(payload)),
	}
}

fn panic_message(payload: Box<dyn Any + Send>) -> Str {
	if let Some(message) = payload.downcast_ref::<&str>() {
		Str::new(*message)
	} else if let Some(message) = payload.downcast_ref::<String>() {
		Str::new(message)
	} else {
		sf!("telemetry hook panicked")
	}
}

fn string_attribute(attributes: impl IntoIterator<Item = KeyValue>, key: &str) -> Option<Str> {
	attributes
		.into_iter()
		.find(|attribute| attribute.key.as_str() == key)
		.and_then(key_value_string)
}

fn key_value_string(attribute: KeyValue) -> Option<Str> {
	let Value::String(value) = attribute.value else {
		return None;
	};
	Some(Str::new(value.as_str()))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use parking_lot::Mutex;

	use super::*;

	fn context() -> TelemetryAttributeContext<'static> {
		TelemetryAttributeContext {
			kind:            TelemetrySpanKind::Chat,
			model:           Some("claude-sonnet-4"),
			agent:           None,
			conversation_id: Some("conversation"),
			step_number:     Some(3),
			tool_call_id:    None,
			tool_name:       None,
		}
	}

	#[test]
	fn config_is_send_sync() {
		fn assert_send_sync<T: Send + Sync>() {}
		assert_send_sync::<TelemetryConfig>();
	}

	#[test]
	fn static_attribute_is_resolved_for_span() {
		let config = TelemetryConfig {
			attributes: Arc::from([KeyValue::new("tenant", "acme")]),
			..TelemetryConfig::default()
		};
		let attributes = config.attributes_for_span(&context());
		assert!(
			attributes
				.iter()
				.any(|attribute| attribute.key.as_str() == "tenant")
		);
	}

	#[test]
	fn dynamic_resolver_receives_context() {
		let seen = Arc::new(Mutex::new(None));
		let capture = Arc::clone(&seen);
		let config = TelemetryConfig {
			resolve_attributes: Some(Arc::new(move |context| {
				*capture.lock() =
					Some((context.kind, context.model.map(Str::new), context.step_number));
				Ok(SmallVec::new())
			})),
			..TelemetryConfig::default()
		};
		let _ = config.attributes_for_span(&context());
		assert_eq!(
			*seen.lock(),
			Some((TelemetrySpanKind::Chat, Some(sf!("claude-sonnet-4")), Some(3)))
		);
	}

	#[test]
	fn failing_estimator_uses_catalog_fallback_and_warns() {
		let warnings = Arc::new(Mutex::new(Vec::new()));
		let capture = Arc::clone(&warnings);
		let config = TelemetryConfig {
			cost_estimator: Some(Arc::new(|_| Err(sf!("pricing offline")))),
			on_telemetry_warning: Some(Arc::new(move |warning| {
				capture.lock().push(warning.code);
				Ok(())
			})),
			..TelemetryConfig::default()
		};
		let input = CostEstimatorContext {
			provider:     "anthropic",
			model:        "model",
			service_tier: None,
			usage:        ChatUsageSnapshot::default(),
		};
		let estimate = config.estimate_cost(&input, |_| {
			Some(CostEstimate::Available { usd: 1.0, input_usd: None, output_usd: None })
		});
		assert_eq!(
			estimate,
			Some(CostEstimate::Available { usd: 1.0, input_usd: None, output_usd: None })
		);
		assert_eq!(*warnings.lock(), vec![TelemetryWarningCode::CostEstimatorFailed]);
	}

	#[test]
	fn custom_content_serializer_overrides_default() {
		let config = TelemetryConfig {
			content_serializer: TelemetryContentSerializer {
				tool_call_arguments: Some(Arc::new(|_| Ok(Some(sf!("custom"))))),
				..TelemetryContentSerializer::default()
			},
			..TelemetryConfig::default()
		};
		assert_eq!(
			config.serialize_tool_call_arguments(&serde_json::json!({"secret": true})),
			Some(sf!("custom"))
		);
	}

	#[test]
	fn tracer_name_override_is_honored() {
		let config =
			TelemetryConfig { tracer_name: sf!("host-tracer"), ..TelemetryConfig::default() };
		assert_eq!(config.tracer_name(), "host-tracer");
	}

	#[test]
	fn panicking_span_end_is_swallowed_and_warned() {
		use opentelemetry::{global, trace::Tracer as _};

		let warnings = Arc::new(Mutex::new(Vec::new()));
		let capture = Arc::clone(&warnings);
		let config = TelemetryConfig {
			on_span_end: Some(Arc::new(|_| panic!("broken span hook"))),
			on_telemetry_warning: Some(Arc::new(move |warning| {
				capture.lock().push(warning.clone());
				Ok(())
			})),
			..TelemetryConfig::default()
		};
		let mut span = global::tracer("config-test").start("test");
		let mut hook_context = TelemetryHookContext { attributes: context(), span: &mut span };
		config.span_ended(&mut hook_context);

		let warnings = warnings.lock();
		assert_eq!(warnings.len(), 1);
		assert_eq!(warnings[0].code, TelemetryWarningCode::OnSpanEndFailed);
		assert_eq!(warnings[0].error.as_deref(), Some("broken span hook"));
	}

	#[test]
	fn erroring_warning_hook_is_swallowed() {
		let config = TelemetryConfig {
			cost_estimator: Some(Arc::new(|_| Err(sf!("failed")))),
			on_telemetry_warning: Some(Arc::new(|_| Err(sf!("also failed")))),
			..TelemetryConfig::default()
		};
		let input = CostEstimatorContext {
			provider:     "provider",
			model:        "model",
			service_tier: None,
			usage:        ChatUsageSnapshot::default(),
		};
		assert!(config.estimate_cost(&input, |_| None).is_none());
	}
}
