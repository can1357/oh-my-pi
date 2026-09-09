//! Generated firehose-to-semconv mapping.
//!
//! This module is intentionally expressed entirely in terms of
//! [`crate::attrs`] constants. Python bindings consume this table rather than
//! carrying a second literal vocabulary.

use omp_core::Str;

use crate::attrs::{gen_ai, omp_firehose, omp_gen_ai};

/// One event-field path and its stable OpenTelemetry attribute key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SemconvMapping {
	/// Canonical firehose field path.
	pub field: &'static str,
	/// Stable semantic-convention attribute key.
	pub key:   &'static str,
}

/// Generated mapping from typed firehose fields to existing attribute keys.
pub const SEMCONV: &[SemconvMapping] = &[
	SemconvMapping { field: "model_request.requested_model", key: gen_ai::REQUEST_MODEL },
	SemconvMapping { field: "model_request.served_model", key: gen_ai::RESPONSE_MODEL },
	SemconvMapping { field: "model_request.provider", key: gen_ai::PROVIDER_NAME },
	SemconvMapping {
		field: "model_request.upstream_provider",
		key:   omp_gen_ai::RESPONSE_UPSTREAM_PROVIDER,
	},
	SemconvMapping { field: "model_request.ttft_ms", key: gen_ai::RESPONSE_TIME_TO_FIRST_CHUNK },
	SemconvMapping { field: "model_request.step", key: omp_gen_ai::AGENT_STEP_NUMBER },
	SemconvMapping { field: "model_request.core_tools", key: omp_gen_ai::REQUEST_AVAILABLE_TOOLS },
	SemconvMapping { field: "model_request.effort", key: omp_gen_ai::REQUEST_REASONING_EFFORT },
	SemconvMapping { field: "model_request.tool_choice", key: omp_gen_ai::REQUEST_TOOL_CHOICE },
	SemconvMapping { field: "tokens.input", key: gen_ai::USAGE_INPUT_TOKENS },
	SemconvMapping { field: "tokens.output", key: gen_ai::USAGE_OUTPUT_TOKENS },
	SemconvMapping { field: "tokens.cache_read", key: gen_ai::USAGE_CACHE_READ_INPUT_TOKENS },
	SemconvMapping { field: "tokens.cache_write", key: gen_ai::USAGE_CACHE_CREATION_INPUT_TOKENS },
	SemconvMapping { field: "tokens.reasoning", key: gen_ai::USAGE_REASONING_OUTPUT_TOKENS },
	SemconvMapping { field: "tokens.total", key: omp_gen_ai::USAGE_TOTAL_TOKENS },
	SemconvMapping { field: "prompt.digest", key: omp_gen_ai::PROMPT_DIGEST },
	SemconvMapping { field: "prompt.changed", key: omp_gen_ai::PROMPT_CHANGED_SLOTS },
	SemconvMapping {
		field: "prompt.prefix_stable_bytes",
		key:   omp_gen_ai::PROMPT_PREFIX_STABLE_BYTES,
	},
	SemconvMapping { field: "prompt.cache_key", key: omp_gen_ai::CACHE_KEY },
	SemconvMapping { field: "tool_call.rev", key: omp_firehose::TOOL_REV },
	SemconvMapping { field: "tool_call.place", key: omp_firehose::TOOL_PLACE },
	SemconvMapping { field: "tool_call.target", key: omp_firehose::TOOL_TARGET },
	SemconvMapping { field: "tool_call.projection_bytes", key: omp_firehose::TOOL_PROMPT_BYTES },
	SemconvMapping { field: "tool_call.repairs", key: omp_firehose::TOOL_REPAIRS },
	SemconvMapping { field: "compaction.reason", key: omp_firehose::COMPACTION_REASON },
	SemconvMapping { field: "artifact_spill.artifact_id", key: omp_firehose::ARTIFACT_ID },
	SemconvMapping { field: "issue_report.issue_id", key: omp_firehose::ISSUE_ID },
	SemconvMapping { field: "capability_degraded.intent", key: omp_firehose::CONSTRAINT_INTENT },
	SemconvMapping { field: "capability_degraded.granted", key: omp_firehose::CONSTRAINT_GRANTED },
	SemconvMapping { field: "tool_call.status", key: omp_gen_ai::TOOL_STATUS },
];

/// Error returned for a metric name outside the extension-owned namespace.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("extension telemetry instrument names must use the omp.ext.<id>. prefix")]
pub struct ExtensionMetricNameError;

/// Prefixes an extension instrument below its non-shadowable namespace.
///
/// # Errors
/// Returns [`ExtensionMetricNameError`] when either component is empty or the
/// supplied name is already in a reserved namespace.
pub fn extension_metric_key(
	extension_id: &str,
	name: &str,
) -> Result<Str, ExtensionMetricNameError> {
	if extension_id.is_empty()
		|| name.is_empty()
		|| name.starts_with("omp.")
		|| name.starts_with("gen_ai.")
	{
		return Err(ExtensionMetricNameError);
	}
	Ok(Str::from(format!("omp.ext.{extension_id}.{name}")))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extension_keys_cannot_shadow_builtin_series() {
		assert_eq!(
			extension_metric_key("acme.trace", "latency")
				.unwrap()
				.as_str(),
			"omp.ext.acme.trace.latency"
		);
		assert!(extension_metric_key("acme.trace", "omp.agent.tool.calls").is_err());
	}
}
