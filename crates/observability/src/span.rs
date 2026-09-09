//! Span lifecycle helpers for agent, chat, tool, and handoff operations.

use std::{error::Error, mem};

use omp_core::Str;
use opentelemetry::{
	Array, Context, KeyValue, StringValue, Value,
	global::{self, BoxedSpan},
	trace::{Span as _, SpanKind, Status, TraceContextExt, Tracer as _},
};
use serde_json::Value as JsonValue;

use crate::{
	attrs::{gen_ai, omp_aggregate, omp_gen_ai, openai},
	collector::{RunCollector, RunCoverage, RunSummary},
	content::{self, RequestContent, ResponseContent},
	semconv::{self, CaptureMode, Operation, ToolStatus},
};

/// Concrete span returned by the process-global OpenTelemetry tracer.
pub type Span = BoxedSpan;

/// Agent identity stamped onto emitted spans when individual fields are
/// present.
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentIdentity<'a> {
	/// Stable agent identifier.
	pub id:          Option<&'a str>,
	/// Human-readable agent name.
	pub name:        Option<&'a str>,
	/// Human-readable agent description.
	pub description: Option<&'a str>,
}

/// Common envelope inherited by every span kind.
#[derive(Clone, Copy, Debug, Default)]
pub struct SpanContext<'a> {
	/// Conversation identifier.
	pub conversation_id: Option<&'a str>,
	/// Current agent identity.
	pub agent:           Option<AgentIdentity<'a>>,
	/// Explicit parent span; the active OpenTelemetry context is used otherwise.
	pub parent:          Option<&'a Span>,
}

/// Request fields stamped when a chat span starts.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChatRequest<'a> {
	/// Maximum requested output tokens.
	pub max_tokens:        Option<u64>,
	/// Sampling temperature.
	pub temperature:       Option<f64>,
	/// Nucleus-sampling probability.
	pub top_p:             Option<f64>,
	/// Top-k sampling count.
	pub top_k:             Option<u64>,
	/// Frequency penalty.
	pub frequency_penalty: Option<f64>,
	/// Presence penalty.
	pub presence_penalty:  Option<f64>,
	/// Stop sequences; an empty slice is omitted.
	pub stop_sequences:    &'a [&'a str],
	/// Random seed.
	pub seed:              Option<i64>,
	/// Requested service tier.
	pub service_tier:      Option<&'a str>,
	/// Requested reasoning effort.
	pub reasoning_effort:  Option<&'a str>,
	/// Serialized tool choice.
	pub tool_choice:       Option<&'a str>,
	/// Available tool names; an empty slice is omitted.
	pub available_tools:   &'a [&'a str],
	/// Content capture mode.
	pub capture_mode:      CaptureMode,
	/// Request message content.
	pub content:           RequestContent<'a>,
}

/// Token and server-tool usage stamped when a chat span finishes.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChatUsage {
	/// Uncached input-token count.
	pub input:             u64,
	/// Output-token count.
	pub output:            u64,
	/// Cache-read input tokens, preserving provider presence vs absence.
	pub cache_read:        Option<u64>,
	/// Cache-created input tokens, preserving provider presence vs absence.
	pub cache_write:       Option<u64>,
	/// Reasoning output tokens.
	pub reasoning_output:  Option<u64>,
	/// Provider total, or `None` to derive input plus output.
	pub total:             Option<u64>,
	/// Server-side web-search requests.
	pub server_web_search: u64,
	/// Server-side web-fetch requests.
	pub server_web_fetch:  u64,
}

/// Optional cost fields stamped when a chat span finishes.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChatCost<'a> {
	/// Estimated total cost in USD.
	pub estimated_usd:      Option<f64>,
	/// Estimated input-side cost in USD.
	pub input_usd:          Option<f64>,
	/// Estimated output-side cost in USD.
	pub output_usd:         Option<f64>,
	/// Reason cost estimation is unavailable.
	pub unavailable_reason: Option<&'a str>,
}

/// Final provider response used to finish a chat span.
#[derive(Clone, Copy, Default)]
pub struct ChatOutcome<'a> {
	/// Actual response model recorded for every completed request.
	pub model:             &'a str,
	/// Provider response identifier.
	pub response_id:       Option<&'a str>,
	/// Gateway-reported upstream provider.
	pub upstream_provider: Option<&'a str>,
	/// Time to first chunk in milliseconds as reported by inference.
	pub ttft_ms:           Option<f64>,
	/// Provider stop reason.
	pub stop_reason:       Option<&'a str>,
	/// Provider error message for terminal error/aborted responses.
	pub error_message:     Option<&'a str>,
	/// Provider-stream failure before a final assistant message existed.
	///
	/// When present, only gateway and error attributes are emitted.
	pub failure:           Option<SpanError<'a>>,
	/// Usage, omitted when the provider returned none.
	pub usage:             Option<ChatUsage>,
	/// Cost result.
	pub cost:              ChatCost<'a>,
	/// Lowercased response headers used for gateway detection.
	pub response_headers:  &'a [(&'a str, &'a str)],
	/// Request base URL, emitted only when a gateway was detected.
	pub base_url:          Option<&'a str>,
	/// Content capture mode.
	pub capture_mode:      CaptureMode,
	/// Response message content.
	pub content:           ResponseContent<'a>,
}

/// Error information for exception recording and span status.
#[derive(Clone, Copy)]
pub struct SpanError<'a> {
	/// Concrete error class/name used for `error.type`.
	pub error_type: &'a str,
	/// Error value recorded as an OpenTelemetry exception event.
	pub error:      &'a (dyn Error + 'static),
}

/// Terminal result used to finish an `execute_tool` span.
#[derive(Clone, Copy)]
pub struct ToolOutcome<'a> {
	/// Returned value, if execution produced one.
	pub result:        Option<&'a JsonValue>,
	/// Whether the tool result itself represents an error.
	pub is_error:      bool,
	/// Explicit status; otherwise derived from `is_error`.
	pub status:        Option<ToolStatus>,
	/// Error message used when no exception value is available.
	pub error_message: Option<&'a str>,
	/// Exception, when the tool threw.
	pub error:         Option<SpanError<'a>>,
	/// Content capture mode.
	pub capture_mode:  CaptureMode,
}

/// Start the outer `invoke_agent` span.
#[must_use]
pub fn start_invoke_agent(model: &str, provider: Option<&str>, context: SpanContext<'_>) -> Span {
	let name = Operation::InvokeAgent.span_name(context.agent.and_then(|agent| agent.name), None);
	let mut attributes = envelope_attributes(Operation::InvokeAgent, Some(model), provider, context);
	start_span(name, SpanKind::Internal, &mut attributes, context.parent)
}

/// Start one provider `chat` span.
#[must_use]
pub fn start_chat(
	model: &str,
	provider: &str,
	step_number: u64,
	request: ChatRequest<'_>,
	context: SpanContext<'_>,
) -> Span {
	let mut attributes = envelope_attributes(Operation::Chat, Some(model), Some(provider), context);
	attributes.push(KeyValue::new(omp_gen_ai::AGENT_STEP_NUMBER, step_number as i64));
	attributes.push(KeyValue::new(gen_ai::OUTPUT_TYPE, "text"));
	attributes.push(KeyValue::new(gen_ai::REQUEST_STREAM, true));
	push_option(
		&mut attributes,
		gen_ai::REQUEST_MAX_TOKENS,
		request.max_tokens.map(|value| value as i64),
	);
	push_option(&mut attributes, gen_ai::REQUEST_TEMPERATURE, request.temperature);
	push_option(&mut attributes, gen_ai::REQUEST_TOP_P, request.top_p);
	push_option(&mut attributes, gen_ai::REQUEST_TOP_K, request.top_k.map(|value| value as i64));
	push_option(&mut attributes, gen_ai::REQUEST_FREQUENCY_PENALTY, request.frequency_penalty);
	push_option(&mut attributes, gen_ai::REQUEST_PRESENCE_PENALTY, request.presence_penalty);
	push_option(&mut attributes, gen_ai::REQUEST_SEED, request.seed);
	if !request.stop_sequences.is_empty() {
		attributes.push(KeyValue::new(
			gen_ai::REQUEST_STOP_SEQUENCES,
			string_array(request.stop_sequences.iter().copied()),
		));
	}
	if request
		.service_tier
		.is_some_and(|tier| should_send_service_tier(tier, provider))
	{
		attributes.push(KeyValue::new(
			openai::REQUEST_SERVICE_TIER,
			request.service_tier.unwrap_or_default().to_owned(),
		));
	}
	push_str(&mut attributes, omp_gen_ai::REQUEST_REASONING_EFFORT, request.reasoning_effort);
	push_str(&mut attributes, omp_gen_ai::REQUEST_TOOL_CHOICE, request.tool_choice);
	if !request.available_tools.is_empty() {
		attributes.push(KeyValue::new(
			omp_gen_ai::REQUEST_AVAILABLE_TOOLS,
			string_array(request.available_tools.iter().copied()),
		));
	}
	attributes.extend(content::request_attributes(request.capture_mode, request.content));
	start_span(
		Operation::Chat.span_name(Some(model), None),
		SpanKind::Client,
		&mut attributes,
		context.parent,
	)
}

/// Start one `execute_tool` span.
#[must_use]
pub fn start_execute_tool(
	tool_name: &str,
	tool_call_id: &str,
	description: Option<&str>,
	arguments: &JsonValue,
	capture_mode: CaptureMode,
	context: SpanContext<'_>,
) -> Span {
	let mut attributes = envelope_attributes(Operation::ExecuteTool, None, None, context);
	attributes.push(KeyValue::new(gen_ai::TOOL_NAME, tool_name.to_owned()));
	attributes.push(KeyValue::new(gen_ai::TOOL_CALL_ID, tool_call_id.to_owned()));
	attributes.push(KeyValue::new(gen_ai::TOOL_TYPE, "function"));
	push_str(&mut attributes, gen_ai::TOOL_DESCRIPTION, description);
	if let Some(attribute) = content::tool_arguments_attribute(capture_mode, arguments) {
		attributes.push(attribute);
	}
	start_span(
		Operation::ExecuteTool.span_name(Some(tool_name), None),
		SpanKind::Internal,
		&mut attributes,
		context.parent,
	)
}

/// Finish an `invoke_agent` span, stamping the run snapshot before error state.
///
/// Aggregate chat/tool latency is reported in milliseconds, as encoded by the
/// `_ms` extension keys, rather than semantic-convention seconds.
pub fn finish_invoke_agent(
	span: &mut Span,
	step_count: u64,
	summary: Option<&RunSummary>,
	coverage: Option<&RunCoverage>,
	error: Option<SpanError<'_>>,
) {
	span.set_attribute(KeyValue::new(omp_gen_ai::AGENT_STEP_COUNT, step_count as i64));
	if let (Some(summary), Some(coverage)) = (summary, coverage) {
		apply_aggregate_attributes(span, summary, coverage);
	}
	if let Some(error) = error {
		span.record_error(error.error);
		span.set_attribute(KeyValue::new(gen_ai::ERROR_TYPE, error.error_type.to_owned()));
		span.set_status(Status::error(error.error.to_string()));
	}
	span.end();
}

/// Finish a `chat` span with response, usage, cost, content, and terminal
/// status.
pub fn finish_chat(span: &mut Span, outcome: ChatOutcome<'_>) {
	apply_gateway_attributes(span, outcome.response_headers, outcome.base_url);
	if let Some(error) = outcome.failure {
		span.record_error(error.error);
		span.set_attribute(KeyValue::new(gen_ai::ERROR_TYPE, error.error_type.to_owned()));
		span.set_status(Status::error(error.error.to_string()));
		span.end();
		return;
	}
	apply_chat_response_attributes(span, &outcome);
	if let Some(usage) = outcome.usage {
		apply_usage_attributes(span, usage);
	}
	apply_cost_attributes(span, outcome.cost);
	span.set_attributes(content::response_attributes(outcome.capture_mode, outcome.content));
	if matches!(outcome.stop_reason, Some("error" | "aborted")) {
		let stop_reason = outcome.stop_reason.unwrap_or_default();
		span.set_attribute(KeyValue::new(gen_ai::ERROR_TYPE, stop_reason.to_owned()));
		span.set_status(Status::error(outcome.error_message.unwrap_or(stop_reason).to_owned()));
	}
	span.end();
}

/// Finish an `execute_tool` span.
pub fn finish_execute_tool(span: &mut Span, outcome: ToolOutcome<'_>) {
	if let Some(result) = outcome.result
		&& let Some(attribute) = content::tool_result_attribute(outcome.capture_mode, result)
	{
		span.set_attribute(attribute);
	}
	let status = outcome.status.unwrap_or(if outcome.is_error {
		ToolStatus::Error
	} else {
		ToolStatus::Ok
	});
	span.set_attribute(KeyValue::new(omp_gen_ai::TOOL_STATUS, status.as_str()));
	if status != ToolStatus::Ok {
		let error_type = if status == ToolStatus::Error {
			outcome.error.map_or("tool_error", |error| error.error_type)
		} else {
			status_error_type(status)
		};
		span.set_attribute(KeyValue::new(gen_ai::ERROR_TYPE, error_type.to_owned()));
		let message = outcome
			.error
			.map(|error| error.error.to_string())
			.or_else(|| outcome.error_message.map(str::to_owned))
			.unwrap_or_else(|| error_type.to_owned());
		span.set_status(Status::error(message));
	}
	if let Some(error) = outcome.error {
		span.record_error(error.error);
	}
	span.end();
}

/// Record a requested tool that bypassed span creation entirely.
pub fn record_skipped_tool(
	collector: &mut RunCollector,
	tool_call_id: impl Into<Str>,
	tool_name: impl Into<Str>,
	status: ToolStatus,
) {
	collector.record_orphan_tool(tool_call_id, tool_name, status);
}

/// Emit and immediately finish a one-shot `handoff` span.
pub fn record_handoff(
	from: Option<AgentIdentity<'_>>,
	to: AgentIdentity<'_>,
	context: SpanContext<'_>,
) {
	let name = Operation::Handoff.span_name(from.and_then(|agent| agent.name), to.name);
	let mut attributes = envelope_attributes(Operation::Handoff, None, None, context);
	if let Some(from) = from {
		push_str(&mut attributes, omp_gen_ai::HANDOFF_FROM_AGENT_NAME, from.name);
		push_str(&mut attributes, omp_gen_ai::HANDOFF_FROM_AGENT_ID, from.id);
	}
	push_str(&mut attributes, omp_gen_ai::HANDOFF_TO_AGENT_NAME, to.name);
	push_str(&mut attributes, omp_gen_ai::HANDOFF_TO_AGENT_ID, to.id);
	let mut span = start_span(name, SpanKind::Internal, &mut attributes, context.parent);
	span.end();
}

/// Run `f` while `span` is the active OpenTelemetry parent.
///
/// Tool-internal spans therefore nest below `execute_tool`, and a subagent's
/// `invoke_agent` span nests below the parent tool span. The closure is
/// synchronous because OpenTelemetry context guards are thread-local; async
/// callers should activate around each poll.
pub fn in_active_span<T>(span: &Span, f: impl FnOnce() -> T) -> T {
	let context = Context::current().with_remote_span_context(span.span_context().clone());
	let _guard = context.attach();
	f()
}

fn start_span(
	name: String,
	kind: SpanKind,
	attributes: &mut Vec<KeyValue>,
	parent: Option<&Span>,
) -> Span {
	let tracer = global::tracer(semconv::TRACER_NAME);
	let builder = tracer
		.span_builder(name)
		.with_kind(kind)
		.with_attributes(mem::take(attributes));
	if let Some(parent) = parent {
		let context = Context::current().with_remote_span_context(parent.span_context().clone());
		tracer.build_with_context(builder, &context)
	} else {
		tracer.build(builder)
	}
}

fn envelope_attributes(
	operation: Operation,
	model: Option<&str>,
	provider: Option<&str>,
	context: SpanContext<'_>,
) -> Vec<KeyValue> {
	let mut attributes = Vec::with_capacity(8);
	attributes.push(KeyValue::new(gen_ai::OPERATION_NAME, operation.as_str()));
	push_str(&mut attributes, gen_ai::REQUEST_MODEL, model);
	if let Some(provider) = provider
		.map(semconv::normalize_provider)
		.filter(|provider| !provider.is_empty())
	{
		attributes.push(KeyValue::new(gen_ai::PROVIDER_NAME, provider.to_owned()));
	}
	push_str(&mut attributes, gen_ai::CONVERSATION_ID, context.conversation_id);
	if let Some(agent) = context.agent {
		push_str(&mut attributes, gen_ai::AGENT_ID, agent.id);
		push_str(&mut attributes, gen_ai::AGENT_NAME, agent.name);
		push_str(&mut attributes, gen_ai::AGENT_DESCRIPTION, agent.description);
	}
	attributes
}

fn apply_chat_response_attributes(span: &mut Span, outcome: &ChatOutcome<'_>) {
	span.set_attribute(KeyValue::new(gen_ai::RESPONSE_MODEL, outcome.model.to_owned()));
	push_span_str(span, gen_ai::RESPONSE_ID, outcome.response_id);
	push_span_str(span, omp_gen_ai::RESPONSE_UPSTREAM_PROVIDER, outcome.upstream_provider);
	if let Some(ttft_ms) = outcome.ttft_ms {
		// Inference reports milliseconds, while this OpenTelemetry key is seconds.
		span.set_attribute(KeyValue::new(gen_ai::RESPONSE_TIME_TO_FIRST_CHUNK, ttft_ms / 1_000.0));
	}
	if let Some(reason) = outcome.stop_reason.and_then(map_stop_reason) {
		span.set_attribute(KeyValue::new(gen_ai::RESPONSE_FINISH_REASONS, string_array([reason])));
	}
}

fn apply_usage_attributes(span: &mut Span, usage: ChatUsage) {
	let input = usage.input + usage.cache_read.unwrap_or(0) + usage.cache_write.unwrap_or(0);
	span.set_attribute(KeyValue::new(gen_ai::USAGE_INPUT_TOKENS, input as i64));
	span.set_attribute(KeyValue::new(gen_ai::USAGE_OUTPUT_TOKENS, usage.output as i64));
	span.set_attribute(KeyValue::new(
		omp_gen_ai::USAGE_TOTAL_TOKENS,
		usage.total.unwrap_or(input + usage.output) as i64,
	));
	push_span_option(
		span,
		gen_ai::USAGE_CACHE_READ_INPUT_TOKENS,
		usage.cache_read.map(|value| value as i64),
	);
	push_span_option(
		span,
		gen_ai::USAGE_CACHE_CREATION_INPUT_TOKENS,
		usage.cache_write.map(|value| value as i64),
	);
	push_span_option(
		span,
		gen_ai::USAGE_REASONING_OUTPUT_TOKENS,
		usage.reasoning_output.map(|value| value as i64),
	);
	let server_tools = usage.server_web_search + usage.server_web_fetch;
	if server_tools > 0 {
		span.set_attribute(KeyValue::new(omp_gen_ai::USAGE_SERVER_SIDE_TOOLS, server_tools as i64));
	}
}

fn apply_cost_attributes(span: &mut Span, cost: ChatCost<'_>) {
	push_span_option(span, omp_gen_ai::COST_ESTIMATED_USD, cost.estimated_usd);
	push_span_option(span, omp_gen_ai::COST_INPUT_USD, cost.input_usd);
	push_span_option(span, omp_gen_ai::COST_OUTPUT_USD, cost.output_usd);
	push_span_str(span, omp_gen_ai::COST_UNAVAILABLE_REASON, cost.unavailable_reason);
}

fn apply_gateway_attributes(span: &mut Span, headers: &[(&str, &str)], base_url: Option<&str>) {
	let get = |key: &str| {
		headers
			.iter()
			.find_map(|(name, value)| name.eq_ignore_ascii_case(key).then_some(*value))
	};
	let gateway = if let Some(call_id) = get("x-litellm-call-id") {
		Some((
			"litellm",
			Some(call_id),
			get("x-litellm-model-id").or_else(|| get("x-litellm-model-group")),
		))
	} else if let Some(call_id) = get("helicone-id") {
		Some(("helicone", Some(call_id), get("helicone-target-provider")))
	} else if let Some(call_id) = get("x-portkey-trace-id").or_else(|| get("x-portkey-request-id")) {
		Some((
			"portkey",
			Some(call_id),
			get("x-portkey-llm-provider").or_else(|| get("x-portkey-provider")),
		))
	} else {
		get("x-generation-id")
			.filter(|id| id.starts_with("gen-"))
			.map(|id| ("openrouter", Some(id), None))
	};
	if let Some((name, call_id, routed_to)) = gateway {
		span.set_attribute(KeyValue::new(omp_gen_ai::GATEWAY_NAME, name));
		push_span_str(span, omp_gen_ai::GATEWAY_ENDPOINT, base_url);
		push_span_str(span, omp_gen_ai::GATEWAY_CALL_ID, call_id);
		push_span_str(span, omp_gen_ai::GATEWAY_ROUTED_TO, routed_to);
	}
	if let Some(status) = get("cf-aig-cache-status") {
		let status = status.trim();
		let status = if status.eq_ignore_ascii_case("hit") {
			"hit"
		} else if status.eq_ignore_ascii_case("miss") {
			"miss"
		} else if status.eq_ignore_ascii_case("bypass") {
			"bypass"
		} else {
			"unknown"
		};
		span.set_attribute(KeyValue::new(omp_gen_ai::GATEWAY_RESPONSE_CACHE_STATUS, status));
	}
}

fn apply_aggregate_attributes(span: &mut Span, summary: &RunSummary, coverage: &RunCoverage) {
	span.set_attribute(KeyValue::new(omp_aggregate::CHATS_COUNT, summary.chats.total as i64));
	span.set_attribute(KeyValue::new(
		omp_aggregate::CHATS_TOTAL_LATENCY_MS,
		summary.chats.total_latency_ms,
	));
	for (reason, count) in &summary.chats.by_stop_reason {
		span.set_attribute(KeyValue::new(omp_aggregate::chats_stop_reason(reason), *count as i64));
	}
	span.set_attribute(KeyValue::new(omp_aggregate::TOOLS_COUNT, summary.tools.total as i64));
	span.set_attribute(KeyValue::new(omp_aggregate::TOOLS_OK_COUNT, summary.tools.ok as i64));
	span.set_attribute(KeyValue::new(omp_aggregate::TOOLS_ERROR_COUNT, summary.tools.error as i64));
	span.set_attribute(KeyValue::new(
		omp_aggregate::TOOLS_SKIPPED_COUNT,
		summary.tools.skipped as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::TOOLS_BLOCKED_COUNT,
		summary.tools.blocked as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::TOOLS_TIMEOUT_COUNT,
		summary.tools.timeout as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::TOOLS_ABORTED_COUNT,
		summary.tools.aborted as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::TOOLS_TOTAL_LATENCY_MS,
		summary.tools.total_latency_ms,
	));
	push_string_array(span, omp_aggregate::TOOLS_INVOKED, &coverage.tools_invoked);
	push_string_array(span, omp_aggregate::TOOLS_AVAILABLE, &coverage.tools_available);
	push_string_array(span, omp_aggregate::TOOLS_UNUSED, &coverage.tools_unused);
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_INPUT_TOKENS_TOTAL,
		summary.usage.input as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_OUTPUT_TOKENS_TOTAL,
		summary.usage.output as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_CACHE_READ_INPUT_TOKENS_TOTAL,
		summary.usage.cached_input as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_CACHE_CREATION_INPUT_TOKENS_TOTAL,
		summary.usage.cache_write as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_REASONING_OUTPUT_TOKENS_TOTAL,
		summary.usage.reasoning_output as i64,
	));
	span.set_attribute(KeyValue::new(
		omp_aggregate::USAGE_TOTAL_TOKENS_TOTAL,
		summary.usage.total as i64,
	));
	if summary.cost.estimated_usd > 0.0 {
		span.set_attribute(KeyValue::new(
			omp_aggregate::COST_ESTIMATED_USD_TOTAL,
			summary.cost.estimated_usd,
		));
	}
	span.set_attribute(KeyValue::new(omp_aggregate::ERRORS_COUNT, summary.errors.total as i64));
}

fn push_string_array(span: &mut Span, key: &'static str, values: &[Str]) {
	if !values.is_empty() {
		span.set_attribute(KeyValue::new(
			key,
			string_array(values.iter().map(|value| value.as_str())),
		));
	}
}

fn string_array<'a>(values: impl IntoIterator<Item = &'a str>) -> Value {
	Value::Array(Array::String(
		values
			.into_iter()
			.map(|value| StringValue::from(value.to_owned()))
			.collect(),
	))
}

fn should_send_service_tier(tier: &str, provider: &str) -> bool {
	if tier == "auto" || tier.is_empty() {
		return false;
	}
	match provider {
		"openai" | "openai-codex" => true,
		"openrouter" => matches!(tier, "flex" | "scale" | "priority"),
		"google" => matches!(tier, "flex" | "priority"),
		"google-vertex" | "fireworks" => tier == "priority",
		_ => false,
	}
}

fn status_error_type(status: ToolStatus) -> &'static str {
	match status {
		ToolStatus::Error => "tool_error",
		ToolStatus::Skipped => "tool_skipped",
		ToolStatus::Blocked => "tool_blocked",
		ToolStatus::Timeout => "tool_timeout",
		ToolStatus::Aborted => "tool_aborted",
		ToolStatus::Ok => unreachable!("ok is not an error status"),
	}
}

fn map_stop_reason(reason: &str) -> Option<&'static str> {
	match reason {
		"stop" => Some("stop"),
		"length" => Some("length"),
		"toolUse" => Some("tool_calls"),
		"error" | "aborted" => Some("error"),
		_ => None,
	}
}

fn push_str(attributes: &mut Vec<KeyValue>, key: &'static str, value: Option<&str>) {
	if let Some(value) = value {
		attributes.push(KeyValue::new(key, value.to_owned()));
	}
}

fn push_option<T: Into<opentelemetry::Value>>(
	attributes: &mut Vec<KeyValue>,
	key: &'static str,
	value: Option<T>,
) {
	if let Some(value) = value {
		attributes.push(KeyValue::new(key, value));
	}
}

fn push_span_str(span: &mut Span, key: &'static str, value: Option<&str>) {
	if let Some(value) = value {
		span.set_attribute(KeyValue::new(key, value.to_owned()));
	}
}

fn push_span_option<T: Into<opentelemetry::Value>>(
	span: &mut Span,
	key: &'static str,
	value: Option<T>,
) {
	if let Some(value) = value {
		span.set_attribute(KeyValue::new(key, value));
	}
}
