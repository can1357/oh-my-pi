//! Core-owned credential rules.

use omp_core::Str;

use crate::rule::{SecretKind, SecretMode, SecretRule, SecretRuleError};

const CREDENTIAL_PATTERN: &str = concat!(
	"(?:gh[opusr]_[A-Za-z0-9_*]{36,}",
	"|github_pat_[A-Za-z0-9_*]{36,}",
	"|glpat-[A-Za-z0-9_*-]{20,}",
	"|sk-proj-[A-Za-z0-9_*-]{36,}",
	"|sk-ant-[A-Za-z0-9_*-]{36,}",
	"|sk-[A-Za-z0-9_*-]{48,})"
);

/// Returns built-in reversible GitHub, GitLab, `OpenAI`, and Anthropic token
/// rules.
pub fn credential_rules() -> Result<Vec<SecretRule>, SecretRuleError> {
	Ok(vec![
		SecretRule::new(
			SecretKind::Regex,
			SecretMode::Obfuscate,
			CREDENTIAL_PATTERN,
			None,
			Some("i"),
			Some(Str::new_static("Credential")),
		)?
		.with_boundary_guard(),
	])
}

/// Returns a one-way rule protecting the persisted placeholder key itself.
pub fn placeholder_key_rule(key: &str) -> Result<SecretRule, SecretRuleError> {
	SecretRule::new(
		SecretKind::Plain,
		SecretMode::Replace,
		key,
		None,
		None,
		Some(Str::new_static("Placeholder key")),
	)
}

/// Builds the persisted-key-only fallback used when no other rule is active.
pub fn persisted_key_fallback(key: Option<&str>) -> Result<Vec<SecretRule>, SecretRuleError> {
	key.map(placeholder_key_rule)
		.transpose()
		.map(Option::into_iter)
		.map(Iterator::collect)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::obfuscator::SecretObfuscator;

	#[test]
	fn builtin_shapes_round_trip_reversibly() {
		for token in [
			"ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
			"github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
			"glpat-abcdefghijklmnopqrst",
			"sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
			"sk-ant-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
			"sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV",
		] {
			let mut obfuscator =
				SecretObfuscator::new(credential_rules().expect("rules"), "K".repeat(43));
			let masked = obfuscator.obfuscate(token);
			assert_ne!(masked, token);
			assert_eq!(obfuscator.deobfuscate(&masked), token);
		}
	}
}
