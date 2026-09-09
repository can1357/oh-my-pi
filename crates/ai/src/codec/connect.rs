//! Shared typed Connect end-stream diagnostics.

use std::collections::BTreeMap;

use omp_core::Str;
use serde::Deserialize;
use serde_json::Value;
use smallvec::SmallVec;
use strum::{AsRefStr, EnumString};

/// Maximum number of Unicode scalar values retained in a display diagnostic.
pub const MAX_CONNECT_DIAGNOSTIC_CHARS: usize = 2_000;

/// Typed source carried by a Connect status detail.
///
/// `AsRef<str>` yields the stable wire label used for display; `FromStr` is
/// infallible because every unrecognized type name lands in `Other`.
#[derive(AsRefStr, Clone, Debug, EnumString, Eq, PartialEq)]
pub enum ConnectDetailSource {
	/// `google.rpc.ErrorInfo` evidence.
	#[strum(serialize = "google.rpc.ErrorInfo")]
	ErrorInfo,
	/// `google.rpc.DebugInfo` evidence.
	#[strum(serialize = "google.rpc.DebugInfo")]
	DebugInfo,
	/// Another explicitly identified detail type.
	#[strum(default, transparent)]
	Other(Str),
	/// A detail without a type identifier.
	#[strum(serialize = "")]
	Unspecified,
}

/// One structured Connect status detail with its source identity preserved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectErrorDetail {
	/// Typed detail source.
	pub(crate) source:   ConnectDetailSource,
	/// Structured detail evidence, preferring `debug` and falling back to
	/// `value`.
	pub(crate) evidence: Value,
}

/// Parsed Connect end-stream status with classification and display evidence
/// separated.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectErrorDiagnostic {
	/// Stable Connect status code.
	pub(crate) code:     Str,
	/// Classification-safe provider message without appended evidence.
	pub(crate) message:  Str,
	/// Structured detail entries in provider order.
	pub(crate) details:  SmallVec<ConnectErrorDetail, 2>,
	/// Unstructured trailer evidence retained only when structured details are
	/// unavailable.
	pub(crate) fallback: Option<Value>,
}

impl ConnectErrorDiagnostic {
	/// Returns a bounded diagnostic with structured or fallback trailer
	/// evidence.
	pub(crate) fn display_message(&self) -> Str {
		self.display_message_with_prefix("Connect error")
	}

	/// Returns a bounded diagnostic using a provider-specific display prefix.
	pub(crate) fn display_message_with_prefix(&self, prefix: &str) -> Str {
		let code = if self.code.is_empty() {
			"unknown"
		} else {
			self.code.as_str()
		};
		let message = if self.message.is_empty() {
			"Unknown error"
		} else {
			self.message.as_str()
		};
		let mut rendered = format!("{prefix} {code}: {message}");
		if !self.details.is_empty() {
			rendered.push_str(" [details: ");
			for (index, detail) in self.details.iter().enumerate() {
				if index != 0 {
					rendered.push_str("; ");
				}
				let source = detail.source.as_ref();
				if !source.is_empty() {
					rendered.push_str(source);
					if !detail.evidence.is_null() {
						rendered.push_str(": ");
					}
				}
				if source.is_empty() || !detail.evidence.is_null() {
					push_json_value(&mut rendered, &detail.evidence);
				}
			}
			rendered.push(']');
		} else if let Some(fallback) = &self.fallback {
			rendered.push_str(" [trailer: ");
			push_json_value(&mut rendered, fallback);
			rendered.push(']');
		}
		truncate_diagnostic(rendered)
	}
}

#[derive(Deserialize)]
struct ConnectEnvelope {
	#[serde(default)]
	error: Option<WireConnectStatus>,
}

#[derive(Deserialize)]
struct WireConnectStatus {
	#[serde(default)]
	code:    Option<Str>,
	#[serde(default)]
	message: Option<Str>,
	#[serde(default)]
	details: Option<Value>,
	#[serde(flatten)]
	extra:   BTreeMap<Str, Value>,
}

/// Parses one Connect end-stream envelope without conflating diagnostics with
/// classification.
pub fn parse_connect_end_stream(
	payload: &[u8],
) -> Result<Option<ConnectErrorDiagnostic>, serde_json::Error> {
	let envelope: ConnectEnvelope = serde_json::from_slice(payload)?;
	let Some(status) = envelope.error else {
		return Ok(None);
	};
	let code = status.code.unwrap_or_default();
	let message = status.message.unwrap_or_default();
	let mut details = SmallVec::<ConnectErrorDetail, 2>::new();
	let mut fallback = None;
	if let Some(value) = status.details {
		if let Value::Array(entries) = value {
			let mut unstructured = Vec::new();
			for entry in entries {
				let Value::Object(mut record) = entry else {
					unstructured.push(entry);
					continue;
				};
				let type_name = record
					.remove("type")
					.or_else(|| record.remove("@type"))
					.and_then(|value| value.as_str().map(Str::new));
				let evidence = record.remove("debug").or_else(|| record.remove("value"));
				if type_name.is_none() && evidence.is_none() {
					unstructured.push(Value::Object(record));
					continue;
				}
				let source = type_name
					.as_deref()
					.and_then(|name| name.parse().ok())
					.unwrap_or(ConnectDetailSource::Unspecified);
				details.push(ConnectErrorDetail { source, evidence: evidence.unwrap_or(Value::Null) });
			}
			if details.is_empty() && !unstructured.is_empty() {
				fallback = Some(Value::Array(unstructured));
			}
		} else {
			fallback = Some(value);
		}
	}
	if details.is_empty() && fallback.is_none() && !status.extra.is_empty() {
		fallback = Some(Value::Object(
			status
				.extra
				.into_iter()
				.map(|(key, value)| (key.as_str().to_owned(), value))
				.collect(),
		));
	}
	Ok(Some(ConnectErrorDiagnostic { code, message, details, fallback }))
}

fn push_json_value(output: &mut String, value: &Value) {
	if let Some(text) = value.as_str() {
		output.push_str(text);
	} else {
		match serde_json::to_string(value) {
			Ok(encoded) => output.push_str(&encoded),
			Err(_) => output.push_str("unavailable"),
		}
	}
}

fn truncate_diagnostic(rendered: String) -> Str {
	if rendered.chars().count() <= MAX_CONNECT_DIAGNOSTIC_CHARS {
		return Str::new(rendered);
	}
	let mut bounded = rendered
		.chars()
		.take(MAX_CONNECT_DIAGNOSTIC_CHARS - 1)
		.collect::<String>();
	bounded.push('…');
	Str::new(bounded)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn preserves_structured_sources_and_value_fallback() {
		let parsed = parse_connect_end_stream(
			br#"{"error":{"code":"invalid_argument","message":"Error","details":[{"type":"google.rpc.ErrorInfo","value":{"reason":"MODEL_UNAVAILABLE"}},{"type":"google.rpc.DebugInfo","debug":{"detail":"field X rejected"}}]}}"#,
		)
		.expect("valid trailer")
		.expect("error status");
		assert_eq!(parsed.details[0].source, ConnectDetailSource::ErrorInfo);
		assert_eq!(parsed.details[0].evidence["reason"], "MODEL_UNAVAILABLE");
		assert_eq!(parsed.details[1].source, ConnectDetailSource::DebugInfo);
		assert!(parsed.display_message().contains("field X rejected"));
	}

	#[test]
	fn detail_source_labels_round_trip_including_unknown_and_absent_types() {
		let parsed = parse_connect_end_stream(
			br#"{"error":{"code":"internal","message":"Error","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","value":{"retry":1}},{"value":{"bare":true}},{"type":"","value":{"empty":true}}]}}"#,
		)
		.expect("valid trailer")
		.expect("error status");
		assert_eq!(
			parsed.details[0].source,
			ConnectDetailSource::Other(Str::new("type.googleapis.com/google.rpc.RetryInfo"))
		);
		assert_eq!(parsed.details[0].source.as_ref(), "type.googleapis.com/google.rpc.RetryInfo");
		assert_eq!(parsed.details[1].source, ConnectDetailSource::Unspecified);
		assert_eq!(parsed.details[2].source, ConnectDetailSource::Unspecified);
		assert_eq!(ConnectDetailSource::ErrorInfo.as_ref(), "google.rpc.ErrorInfo");
		assert_eq!(ConnectDetailSource::DebugInfo.as_ref(), "google.rpc.DebugInfo");
		assert_eq!(ConnectDetailSource::Unspecified.as_ref(), "");
		let rendered = parsed.display_message();
		assert!(rendered.contains("type.googleapis.com/google.rpc.RetryInfo: "));
		assert!(rendered.contains(r#"{"bare":true}"#));
	}

	#[test]
	fn bounds_display_but_not_classification_at_exact_character_limit() {
		let payload = serde_json::json!({
			"error": {
				"code": "invalid_argument",
				"message": "Error",
				"details": [{"type": "google.rpc.DebugInfo", "debug": "x".repeat(4_000)}]
			}
		});
		let parsed = parse_connect_end_stream(&serde_json::to_vec(&payload).expect("payload"))
			.expect("valid trailer")
			.expect("error status");
		assert_eq!(parsed.display_message().chars().count(), MAX_CONNECT_DIAGNOSTIC_CHARS);
		assert!(parsed.display_message().ends_with('…'));
		assert_eq!(parsed.code, "invalid_argument");
		assert_eq!(parsed.message, "Error");
	}
	#[test]
	fn diagnostic_cap_preserves_the_exact_boundary() {
		let exact = truncate_diagnostic("x".repeat(MAX_CONNECT_DIAGNOSTIC_CHARS));
		assert_eq!(exact.chars().count(), MAX_CONNECT_DIAGNOSTIC_CHARS);
		assert!(!exact.ends_with('…'));
		let over = truncate_diagnostic("x".repeat(MAX_CONNECT_DIAGNOSTIC_CHARS + 1));
		assert_eq!(over.chars().count(), MAX_CONNECT_DIAGNOSTIC_CHARS);
		assert!(over.ends_with('…'));
	}

	#[test]
	fn retains_non_array_details_as_fallback_diagnostic() {
		let parsed = parse_connect_end_stream(
			br#"{"error":{"code":"invalid_argument","message":"Error","details":{"reason":"opaque"}}}"#,
		)
		.expect("valid trailer")
		.expect("error status");
		assert!(parsed.details.is_empty());
		assert!(parsed.display_message().contains("opaque"));
	}
}
