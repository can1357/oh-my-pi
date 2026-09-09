//! Local-private projection for `AutoQA` issue transport.
//!
//! Raw side-file bytes never cross the transport boundary. This module is the
//! sole projection authority and irreversibly masks credentials before parsing
//! structured findings.

use serde_json::Value;

use crate::redact;

/// Produces a locally redacted JSON value suitable for issue transport.
///
/// Invalid UTF-8 and non-JSON findings remain useful as a redacted JSON string;
/// callers never receive or transport the unprojected bytes.
pub fn project_payload(payload: &[u8]) -> Value {
	let text = String::from_utf8_lossy(payload);
	let redacted = redact::redact_sensitive_credentials(&text);
	serde_json::from_str(&redacted).unwrap_or(Value::String(redacted))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn projection_redacts_before_structured_transport() {
		let token = format!("ghp_{}", "A".repeat(36));
		let payload = format!(r#"{{"report":"failed with {token}"}}"#);
		let projected = project_payload(payload.as_bytes());
		assert!(!projected.to_string().contains(&token));
		assert_eq!(projected["report"], "failed with [REDACTED]");
	}
}
