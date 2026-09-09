//! Rust-side credential grant scopes enforced before auth dispatch.

use std::sync::Arc;

use omp_core::Str;
use thiserror::Error;

/// Credential provider glob scope attached to an extension CONTROL session.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CredentialScope {
	allow: Arc<[Str]>,
}

impl CredentialScope {
	/// Builds a scope from manifest `credentials.*` provider globs.
	pub const fn new(allow: Arc<[Str]>) -> Self {
		Self { allow }
	}

	/// Returns whether a provider identifier is permitted by this scope.
	pub fn allows(&self, provider: &str) -> bool {
		self
			.allow
			.iter()
			.any(|pattern| glob_matches(pattern.as_str(), provider))
	}

	/// Refuses a CONTROL credential request outside this scope.
	pub fn enforce(&self, provider: &str) -> Result<(), CredentialScopeError> {
		if self.allows(provider) {
			Ok(())
		} else {
			Err(CredentialScopeError::Denied { provider: Str::new(provider) })
		}
	}
}

/// Independent credential grants for normal use, imports, and raw reveals.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CredentialGrants {
	/// Metadata, lease, storage, and refresh authority.
	pub allow:  CredentialScope,
	/// Authority to adopt an external OAuth credential.
	pub import: CredentialScope,
	/// Authority to reveal raw credential material.
	pub reveal: CredentialScope,
}

/// Rust-side refusal emitted before an unauthorized auth frame reaches storage.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CredentialScopeError {
	/// The requested provider is not covered by the extension grant.
	#[error("credential access denied for provider {provider}")]
	Denied {
		/// Provider identifier from the CONTROL request.
		provider: Str,
	},
}

const fn glob_matches(pattern: &str, value: &str) -> bool {
	let pattern = pattern.as_bytes();
	let value = value.as_bytes();
	let (mut pattern_index, mut value_index) = (0, 0);
	let (mut star, mut retry) = (None, 0);
	while value_index < value.len() {
		if pattern_index < pattern.len()
			&& (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
		{
			pattern_index += 1;
			value_index += 1;
		} else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
			star = Some(pattern_index);
			pattern_index += 1;
			retry = value_index;
		} else if let Some(star_index) = star {
			pattern_index = star_index + 1;
			retry += 1;
			value_index = retry;
		} else {
			return false;
		}
	}
	while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
		pattern_index += 1;
	}
	pattern_index == pattern.len()
}

#[cfg(test)]
mod tests {

	use omp_core::sf;

	use super::CredentialScope;

	#[test]
	fn scope_glob_refuses_unlisted_provider() {
		let scope = CredentialScope::new([sf!("anthropic/*"), sf!("local")].into());
		assert!(scope.enforce("anthropic/claude").is_ok());
		assert!(scope.enforce("openai/gpt").is_err());
	}
}
