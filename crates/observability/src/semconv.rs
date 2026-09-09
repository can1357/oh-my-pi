//! Stable value vocabularies and span-name formatting for agent telemetry.
//!
//! Values in this module are wire contracts. They intentionally preserve exact
//! spelling rather than tracking whichever semantic-convention crate version is
//! installed.

use std::str::FromStr;

/// Default OpenTelemetry tracer name used by the agent loop.
pub const TRACER_NAME: &str = "@omp/agent-core";
/// OpenTelemetry meter name used by the coding-agent exporter.
pub const METER_NAME: &str = "@omp/coding-agent";

/// Error returned when a string is not part of a bounded telemetry vocabulary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("invalid {0} telemetry vocabulary value")]
pub struct ParseSemconvError(&'static str);

macro_rules! vocab {
	(
		$(#[$enum_meta:meta])*
		pub enum $name:ident($label:literal, $as_str_doc:literal) {
			$(
				$(#[$variant_meta:meta])*
				$variant:ident => $wire:literal,
			)*
		}
	) => {
		$(#[$enum_meta])*
		pub enum $name {
			$(
				#[doc = concat!("The `", $wire, "` vocabulary value.")]
				$(#[$variant_meta])*
				$variant,
			)*
		}
		impl $name {
			#[doc = $as_str_doc]
			pub const fn as_str(self) -> &'static str {
				match self {
					$(Self::$variant => $wire,)*
				}
			}
		}

		impl FromStr for $name {
			type Err = ParseSemconvError;

			fn from_str(value: &str) -> Result<Self, Self::Err> {
				match value {
					$($wire => Ok(Self::$variant),)*
					_ => Err(ParseSemconvError($label)),
				}
			}
		}
	};
}

vocab! {
	/// Firehose event kinds accepted by core-side subscriptions.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum Kind("firehose event kind", "Returns the byte-exact firehose event kind.") {
		SessionStart => "session_start",
		SessionDispatch => "session_dispatch",
		SessionEnd => "session_end",
		TurnStart => "turn_start",
		TurnEnd => "turn_end",
		ModelRequest => "model_request",
		ModelAttempt => "model_attempt",
		ProviderError => "provider_error",
		ToolCall => "tool_call",
		CapabilityDegraded => "capability_degraded",
		Compaction => "compaction",
		Branch => "branch",
		ArtifactSpill => "artifact_spill",
		IssueReport => "issue_report",
		HostWarning => "host_warning",
	}
}

vocab! {
	/// Charitable argument-decoding repairs recorded by a tool call.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum RepairKind("repair kind", "Returns the byte-exact repair kind.") {
		Alias => "alias",
		Coerce => "coerce",
		TolerantParse => "tolerant_parse",
		TruncatedTail => "truncated_tail",
		Defaulted => "defaulted",
	}
}

vocab! {
	/// Action taken when a capability intent could not be honoured natively.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum DegradeAction("degrade action", "Returns the byte-exact degradation action.") {
		Dropped => "dropped",
		Emulated => "emulated",
		Clamped => "clamped",
	}
}

vocab! {
	/// Layer that caused an artifact payload to spill.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum SpillReason("spill reason", "Returns the byte-exact artifact spill reason.") {
		Render => "render",
		Verdict => "verdict",
	}
}

vocab! {
	/// Mutation applied to the session branch tree.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum BranchOp("branch operation", "Returns the byte-exact branch operation.") {
		Create => "create",
		Switch => "switch",
		Merge => "merge",
		Delete => "delete",
	}
}

vocab! {
	/// Cause of an agent-context compaction.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum CompactionReason("compaction reason", "Returns the byte-exact compaction reason.") {
		ContextLimit => "context_limit",
		Manual => "manual",
		Policy => "policy",
	}
}

vocab! {
	/// Framing protocol used by a declarative export target.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum ExportProtocol("export protocol", "Returns the byte-exact export protocol.") {
		OtlpHttp => "otlp_http",
		OtlpGrpc => "otlp_grpc",
		Jsonl => "jsonl",
	}
}

vocab! {
	/// Lifecycle state of a durable AutoQA issue.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum IssueStatus("issue status", "Returns the byte-exact issue status.") {
		Open => "open",
		Confirmed => "confirmed",
		FalsePositive => "false_positive",
		Fixed => "fixed",
		Duplicate => "duplicate",
	}
}

vocab! {
	/// User disposition for an AutoQA issue's external submission.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum Consent("consent", "Returns the byte-exact consent state.") {
		Local => "local",
		Shared => "shared",
		Pending => "pending",
	}
}

vocab! {
	/// Core-side data-capture level for a telemetry subscriber.
	#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, PartialOrd, Ord)]
	pub enum Capture("capture level", "Returns the byte-exact capture level.") {
		None => "none",
		Usage => "usage",
		#[default]
		Structure => "structure",
		Content => "content",
	}
}

vocab! {
	/// Durable retention tier enforced by core-side garbage collection.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum RetentionTier("retention tier", "Returns the byte-exact retention tier.") {
		Session => "session",
		Project => "project",
		Audit => "audit",
	}
}

vocab! {
	/// Values of `gen_ai.operation.name` emitted by agent-loop spans.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum Operation("operation", "Returns the byte-exact `gen_ai.operation.name` value.") {
		/// A complete agent-loop invocation.
		InvokeAgent => "invoke_agent",
		/// One model chat request.
		Chat => "chat",
		/// One tool execution.
		ExecuteTool => "execute_tool",
		/// A transition between named agents.
		Handoff => "handoff",
	}
}
impl Operation {
	/// Formats the span name exactly as specified by the wire contract.
	///
	/// `primary` is the agent name for `invoke_agent`, model identifier for
	/// `chat`, tool name for `execute_tool`, and source agent name for
	/// `handoff`. `secondary` is ignored except for `handoff`, where it is the
	/// destination agent name. A handoff with only a destination is named
	/// `handoff to {destination}`; with both names it uses a literal U+2192
	/// right arrow: `handoff {source} → {destination}`.
	pub fn span_name(self, primary: Option<&str>, secondary: Option<&str>) -> String {
		match self {
			Self::InvokeAgent => {
				format_subject("invoke_agent", primary.filter(|name| !name.is_empty()))
			},
			Self::Chat => format_subject("chat", primary),
			Self::ExecuteTool => format_subject("execute_tool", primary),
			Self::Handoff => {
				let from = primary.filter(|name| !name.is_empty());
				let to = secondary.filter(|name| !name.is_empty());
				match (from, to) {
					(Some(from), Some(to)) => format!("handoff {from} → {to}"),
					(_, Some(to)) => format!("handoff to {to}"),
					_ => "handoff".to_owned(),
				}
			},
		}
	}
}

vocab! {
	/// Terminal status vocabulary for tool execution.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum ToolStatus("tool status", "Returns the byte-exact terminal-status value.") {
		/// The tool completed successfully.
		Ok => "ok",
		/// The tool failed.
		Error => "error",
		/// The tool was intentionally skipped.
		Skipped => "skipped",
		/// Policy or permissions blocked the tool.
		Blocked => "blocked",
		/// The tool exceeded its deadline.
		Timeout => "timeout",
		/// The tool was aborted.
		Aborted => "aborted",
	}
}

vocab! {
	/// Values of the `gen_ai.token.type` metric dimension.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum TokenType("token type", "Returns the byte-exact `gen_ai.token.type` value.") {
		/// All input tokens, including cache buckets.
		Input => "input",
		/// Output tokens.
		Output => "output",
		/// Input plus output tokens.
		Total => "total",
		/// Cache-read input tokens.
		CacheReadInput => "cache_read_input",
		/// Cache-write input tokens.
		CacheWriteInput => "cache_write_input",
		/// Reasoning output tokens.
		ReasoningOutput => "reasoning_output",
	}
}

vocab! {
	/// Message-content capture mode.
	#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
	pub enum CaptureMode("content-capture mode", "Returns the byte-exact configuration value.") {
		/// Do not attach message content.
		#[default]
		None => "none",
		/// Attach bounded dashboard-friendly summaries.
		Summary => "summary",
		/// Attach summaries and full OpenTelemetry message payloads.
		Full => "full",
	}
}
impl CaptureMode {
	/// Parses `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` exactly as
	/// pi.
	///
	/// Missing, empty, and unrecognized values disable capture. Matching is
	/// ASCII-case-insensitive after trimming. `true`, `1`, `yes`, and `full`
	/// select full capture; `summary` selects summary capture.
	pub fn from_env_value(value: Option<&str>) -> Self {
		let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
			return Self::None;
		};
		if value.eq_ignore_ascii_case("summary") {
			Self::Summary
		} else if value.eq_ignore_ascii_case("true")
			|| value == "1"
			|| value.eq_ignore_ascii_case("yes")
			|| value.eq_ignore_ascii_case("full")
		{
			Self::Full
		} else {
			Self::None
		}
	}
}

vocab! {
	/// Stop-reason vocabulary received from providers.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum StopReason("stop reason", "Returns the byte-exact stop-reason value.") {
		/// The model stopped normally.
		Stop => "stop",
		/// The model reached a length limit.
		Length => "length",
		/// The model requested one or more tool calls.
		ToolUse => "toolUse",
		/// The provider reported an error.
		Error => "error",
		/// The request was aborted.
		Aborted => "aborted",
	}
}
impl StopReason {
	/// Maps this stop reason to the finish reason emitted on chat spans.
	pub const fn finish_reason(self) -> FinishReason {
		match self {
			Self::Stop => FinishReason::Stop,
			Self::Length => FinishReason::Length,
			Self::ToolUse => FinishReason::ToolCalls,
			Self::Error | Self::Aborted => FinishReason::Error,
		}
	}
}

vocab! {
	/// Normalized values emitted in `gen_ai.response.finish_reasons`.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum FinishReason("finish reason", "Returns the byte-exact finish-reason value.") {
		/// Normal completion (`stop`).
		Stop => "stop",
		/// Length-limited completion (`length`).
		Length => "length",
		/// Completion requesting tools (`tool_calls`).
		ToolCalls => "tool_calls",
		/// Errored or aborted completion (`error`).
		Error => "error",
	}
}

/// Maps a raw stop reason to the span's normalized finish-reason value.
///
/// Unknown values return `None`.
pub fn map_stop_reason(reason: &str) -> Option<&'static str> {
	reason
		.parse::<StopReason>()
		.ok()
		.map(StopReason::finish_reason)
		.map(FinishReason::as_str)
}

vocab! {
	/// Fixed `error.type` classifications emitted by pi.
	///
	/// JavaScript error names and caller-supplied error types remain free-form and
	/// therefore are not represented by this bounded vocabulary.
	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
	pub enum ErrorType("error type", "Returns the byte-exact `error.type` value.") {
		/// A chat ended with stop reason `error`.
		TerminalError => "error",
		/// A chat ended with stop reason `aborted`.
		TerminalAborted => "aborted",
		/// A tool failed without a more specific thrown-error class.
		ToolError => "tool_error",
		/// A tool was skipped.
		ToolSkipped => "tool_skipped",
		/// A tool was blocked.
		ToolBlocked => "tool_blocked",
		/// A tool timed out.
		ToolTimeout => "tool_timeout",
		/// A tool was aborted.
		ToolAborted => "tool_aborted",
		/// Fallback classification when no JavaScript error class is available.
		FallbackError => "Error",
	}
}
impl ErrorType {
	/// Returns the fixed error classification for a non-success tool status.
	///
	/// Successful tools have no `error.type`. A thrown error may replace the
	/// `ToolError` value with its free-form JavaScript error class name.
	pub const fn for_tool_status(status: ToolStatus) -> Option<Self> {
		match status {
			ToolStatus::Ok => None,
			ToolStatus::Error => Some(Self::ToolError),
			ToolStatus::Skipped => Some(Self::ToolSkipped),
			ToolStatus::Blocked => Some(Self::ToolBlocked),
			ToolStatus::Timeout => Some(Self::ToolTimeout),
			ToolStatus::Aborted => Some(Self::ToolAborted),
		}
	}
}

/// Normalizes a provider identifier for `gen_ai.provider.name`.
///
/// Unknown and empty provider identifiers pass through unchanged.
pub fn normalize_provider(raw: &str) -> &str {
	match raw {
		"amazon-bedrock" => "aws.bedrock",
		"google" | "google-antigravity" | "google-gemini-cli" => "gcp.gemini",
		"google-vertex" => "gcp.vertex_ai",
		"mistral" => "mistral_ai",
		"openai-codex" => "openai",
		"xai" => "x_ai",
		_ => raw,
	}
}

fn format_subject(operation: &str, subject: Option<&str>) -> String {
	let Some(subject) = subject else {
		return operation.to_owned();
	};
	let mut name = String::with_capacity(operation.len() + 1 + subject.len());
	name.push_str(operation);
	name.push(' ');
	name.push_str(subject);
	name
}

#[cfg(test)]
mod tests {
	use std::fmt;

	use super::*;

	fn assert_round_trip<T>(values: &[T])
	where
		T: Copy + fmt::Debug + Eq + FromStr<Err = ParseSemconvError>,
		T: AsWireStr,
	{
		for &value in values {
			assert_eq!(value.as_wire_str().parse::<T>(), Ok(value));
		}
	}

	trait AsWireStr {
		fn as_wire_str(&self) -> &'static str;
	}

	impl AsWireStr for Operation {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for ToolStatus {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for TokenType {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for CaptureMode {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for StopReason {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for FinishReason {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	impl AsWireStr for ErrorType {
		fn as_wire_str(&self) -> &'static str {
			self.as_str()
		}
	}

	#[test]
	fn enum_values_round_trip() {
		assert_round_trip(&[
			Operation::InvokeAgent,
			Operation::Chat,
			Operation::ExecuteTool,
			Operation::Handoff,
		]);
		assert_round_trip(&[
			ToolStatus::Ok,
			ToolStatus::Error,
			ToolStatus::Skipped,
			ToolStatus::Blocked,
			ToolStatus::Timeout,
			ToolStatus::Aborted,
		]);
		assert_round_trip(&[
			TokenType::Input,
			TokenType::Output,
			TokenType::Total,
			TokenType::CacheReadInput,
			TokenType::CacheWriteInput,
			TokenType::ReasoningOutput,
		]);
		assert_round_trip(&[CaptureMode::None, CaptureMode::Summary, CaptureMode::Full]);
		assert_round_trip(&[
			StopReason::Stop,
			StopReason::Length,
			StopReason::ToolUse,
			StopReason::Error,
			StopReason::Aborted,
		]);
		assert_round_trip(&[
			FinishReason::Stop,
			FinishReason::Length,
			FinishReason::ToolCalls,
			FinishReason::Error,
		]);
		assert_round_trip(&[
			ErrorType::TerminalError,
			ErrorType::TerminalAborted,
			ErrorType::ToolError,
			ErrorType::ToolSkipped,
			ErrorType::ToolBlocked,
			ErrorType::ToolTimeout,
			ErrorType::ToolAborted,
			ErrorType::FallbackError,
		]);
	}

	#[test]
	fn formats_exact_span_names() {
		assert_eq!(Operation::InvokeAgent.span_name(Some("planner"), None), "invoke_agent planner");
		assert_eq!(Operation::InvokeAgent.span_name(None, None), "invoke_agent");
		assert_eq!(Operation::InvokeAgent.span_name(Some(""), None), "invoke_agent");
		assert_eq!(Operation::Chat.span_name(Some("gpt-5"), None), "chat gpt-5");
		assert_eq!(Operation::ExecuteTool.span_name(Some("read"), None), "execute_tool read");
		assert_eq!(Operation::Handoff.span_name(Some("plan"), Some("build")), "handoff plan → build");
		assert_eq!(Operation::Handoff.span_name(None, Some("build")), "handoff to build");
		assert_eq!(Operation::Handoff.span_name(Some("plan"), None), "handoff");
		assert_eq!(Operation::Handoff.span_name(Some(""), Some("build")), "handoff to build");
		assert_eq!(Operation::Handoff.span_name(Some("plan"), Some("")), "handoff");
	}

	#[test]
	fn parses_content_capture_environment_values() {
		assert_eq!(CaptureMode::from_env_value(None), CaptureMode::None);
		assert_eq!(CaptureMode::from_env_value(Some("")), CaptureMode::None);
		assert_eq!(CaptureMode::from_env_value(Some(" summary ")), CaptureMode::Summary);
		for raw in ["true", "TRUE", "1", "yes", "Yes", "full", "FULL"] {
			assert_eq!(CaptureMode::from_env_value(Some(raw)), CaptureMode::Full);
		}
		assert_eq!(CaptureMode::from_env_value(Some("on")), CaptureMode::None);
	}

	#[test]
	fn maps_every_stop_reason() {
		assert_eq!(map_stop_reason("stop"), Some("stop"));
		assert_eq!(map_stop_reason("length"), Some("length"));
		assert_eq!(map_stop_reason("toolUse"), Some("tool_calls"));
		assert_eq!(map_stop_reason("error"), Some("error"));
		assert_eq!(map_stop_reason("aborted"), Some("error"));
		assert_eq!(map_stop_reason("unknown"), None);
	}

	#[test]
	fn normalizes_every_provider_mapping() {
		for (raw, normalized) in [
			("amazon-bedrock", "aws.bedrock"),
			("google", "gcp.gemini"),
			("google-antigravity", "gcp.gemini"),
			("google-gemini-cli", "gcp.gemini"),
			("google-vertex", "gcp.vertex_ai"),
			("mistral", "mistral_ai"),
			("openai-codex", "openai"),
			("xai", "x_ai"),
		] {
			assert_eq!(normalize_provider(raw), normalized);
		}
		assert_eq!(normalize_provider("anthropic"), "anthropic");
		assert_eq!(normalize_provider(""), "");
	}
}
