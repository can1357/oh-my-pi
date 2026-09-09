//! Mandatory credential masking for telemetry and debug serialization.
//!
//! The credential grammar and placeholder machinery are owned by
//! `omp-secrets`; telemetry exposes only the irreversible projection.

use std::sync::LazyLock;

use omp_secrets::{
	builtins::credential_rules, obfuscator::SecretObfuscator,
	placeholder::placeholder_without_friendly_name,
};
use parking_lot::Mutex;

const MASK_KEY: &str = "omp-observability-private-mask";
const REDACTED: &str = "[REDACTED]";

static CREDENTIAL_MASKER: LazyLock<Option<Mutex<SecretObfuscator>>> = LazyLock::new(|| {
	credential_rules()
		.ok()
		.map(|rules| Mutex::new(SecretObfuscator::new(rules, MASK_KEY)))
});

/// Masks credential-shaped tokens before telemetry or debug materialization.
///
/// Masking is mandatory. If the core credential grammar cannot initialize,
/// this fails closed by replacing the entire value.
pub fn redact_sensitive_credentials(text: &str) -> String {
	let Some(masker) = CREDENTIAL_MASKER.as_ref() else {
		return REDACTED.to_owned();
	};
	collapse_credential_placeholders(&masker.lock().obfuscate(text))
}

fn collapse_credential_placeholders(masked: &str) -> String {
	let mut output = String::with_capacity(masked.len());
	let mut remainder = masked;
	while let Some(start) = remainder.find("$$") {
		output.push_str(&remainder[..start]);
		let candidate = &remainder[start..];
		let Some(relative_end) = candidate[2..].find("$$") else {
			output.push_str(candidate);
			return output;
		};
		let end = relative_end + 4;
		let placeholder = &candidate[..end];
		if placeholder_without_friendly_name(placeholder).is_some() {
			output.push_str(REDACTED);
		} else {
			output.push_str(placeholder);
		}
		remainder = &candidate[end..];
	}
	output.push_str(remainder);
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn redaction_is_on_by_default() {
		let token = format!("gho_{}", "A".repeat(36));
		assert_ne!(redact_sensitive_credentials(&token), token);
	}

	#[test]
	fn redacts_every_token_family_case_insensitively() {
		for token in [
			format!("gho_{}", "A".repeat(36)),
			format!("ghp_{}", "A".repeat(36)),
			format!("ghu_{}", "A".repeat(36)),
			format!("ghs_{}", "A".repeat(36)),
			format!("ghr_{}", "A".repeat(36)),
			format!("github_pat_{}", "A".repeat(36)),
			format!("glpat-{}", "A".repeat(20)),
			format!("sk-proj-{}", "A".repeat(36)),
			format!("sk-ant-{}", "A".repeat(36)),
			format!("SK-{}", "A".repeat(48)),
		] {
			assert_ne!(redact_sensitive_credentials(&token), token, "{token}");
		}
	}

	#[test]
	fn embedded_token_replaces_only_the_token() {
		let token = format!("github_pat_{}", "Ab1_".repeat(9));
		let text = format!("before: {token}; after");
		let masked = redact_sensitive_credentials(&text);
		assert!(masked.starts_with("before: "));
		assert!(masked.ends_with("; after"));
		assert!(!masked.contains(&token));
	}

	#[test]
	fn short_prefix_is_not_redacted() {
		let token = format!("sk-proj-{}", "A".repeat(35));
		assert_eq!(redact_sensitive_credentials(&token), token);
	}

	#[test]
	fn sensitive_left_boundary_prevents_a_match() {
		let token = format!("ghp_{}", "A".repeat(36));
		for adjacent in ['a', 'Z', '0', '_', '*', '-'] {
			let text = format!("{adjacent}{token}");
			assert_eq!(redact_sensitive_credentials(&text), text, "{adjacent:?}");
		}
	}

	#[test]
	fn sensitive_right_boundary_prevents_a_match() {
		// `gh*` bodies do not consume `-`, while the original lookahead still
		// treats it as a credential character and therefore rejects the match.
		let token = format!("ghp_{}", "A".repeat(36));
		let text = format!("{token}-");
		assert_eq!(redact_sensitive_credentials(&text), text);
	}
}
