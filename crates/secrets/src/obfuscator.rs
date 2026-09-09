//! Atomic reversible obfuscation and irreversible redaction pipeline.

use std::{
	cmp,
	collections::{HashMap, HashSet},
	fmt,
};

use omp_core::Str;

use crate::{
	placeholder::{
		PlaceholderEntry, PlaceholderRegistry, deobfuscate_placeholders,
		placeholder_without_friendly_name, sanitize_for_collision_check,
	},
	replacement::{
		RegexMatchContext, ensure_distinct_replacement, generate_deterministic_replacement,
		regex_replacement,
	},
	rule::{MIN_OBFUSCATE_SECRET_LEN, SecretKind, SecretMode, SecretRule},
	tracked::{Origin, TrackedText, outside_placeholder_ranges},
};

type KeyProvider = Box<dyn FnOnce() -> String + Send + 'static>;
const IRREVERSIBLE_REPLACEMENT_SEED: &str = "omp-public-irreversible-redaction";

/// A session-local, bidirectional secret transform.
///
/// The transform retains every minted placeholder mapping for the lifetime of
/// the session. Callers must therefore keep one instance for all outbound
/// projections and inbound restoration.
pub struct SecretObfuscator {
	rules:               Vec<SecretRule>,
	key:                 Option<String>,
	key_provider:        Option<KeyProvider>,
	registry:            PlaceholderRegistry,
	plain_placeholders:  HashMap<Str, String>,
	generated_replaces:  HashSet<String>,
	known_secret_shapes: HashSet<String>,
	has_secrets:         bool,
}

impl fmt::Debug for SecretObfuscator {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("SecretObfuscator")
			.field("rule_count", &self.rules.len())
			.field("key_resolved", &self.key.is_some())
			.field("has_secrets", &self.has_secrets)
			.finish_non_exhaustive()
	}
}

impl SecretObfuscator {
	/// Constructs a transform with an already resolved placeholder key.
	pub fn new(rules: Vec<SecretRule>, key: impl Into<String>) -> Self {
		Self::build(rules, Some(key.into()), None)
	}

	/// Constructs a transform whose key is resolved only when a reversible regex
	/// actually matches.
	pub fn with_lazy_key(
		rules: Vec<SecretRule>,
		key_provider: impl FnOnce() -> String + Send + 'static,
	) -> Self {
		Self::build(rules, None, Some(Box::new(key_provider)))
	}

	pub(crate) fn build_irreversible(rules: Vec<SecretRule>) -> Self {
		debug_assert!(rules.iter().all(|rule| rule.mode() == SecretMode::Replace));
		// Regex replacement's last-resort perturbation needs deterministic input,
		// not secret material. A fixed public seed avoids consulting the private
		// placeholder-key authority at an irreversible boundary.
		Self::build(rules, Some(IRREVERSIBLE_REPLACEMENT_SEED.to_owned()), None)
	}

	fn build(
		rules: Vec<SecretRule>,
		key: Option<String>,
		key_provider: Option<KeyProvider>,
	) -> Self {
		let has_secrets = !rules.is_empty();
		let known_secret_shapes = rules
			.iter()
			.filter(|rule| rule.kind() == SecretKind::Plain)
			.map(|rule| sanitize_for_collision_check(rule.content()))
			.collect();
		let mut this = Self {
			rules,
			key,
			key_provider,
			registry: PlaceholderRegistry::new(),
			plain_placeholders: HashMap::new(),
			generated_replaces: HashSet::new(),
			known_secret_shapes,
			has_secrets,
		};
		if this.key.is_some() {
			this.register_key_redaction();
		}
		this.register_plain_placeholders();
		this
	}

	/// Returns whether the snapshot contains any effective rule.
	pub const fn has_secrets(&self) -> bool {
		self.has_secrets
	}

	fn key(&mut self) -> &str {
		if self.key.is_none() {
			let provider_configured = self.key_provider.is_some();
			tracing::debug!(provider_configured, "secret placeholder key access started");
			self.key = Some(
				self
					.key_provider
					.take()
					.map_or_else(String::new, |provider| provider()),
			);
			tracing::debug!(
				provider_configured,
				key_available = self.key.as_ref().is_some_and(|key| !key.is_empty()),
				"secret placeholder key access completed"
			);
			self.register_key_redaction();
		}
		self.key.as_deref().unwrap_or_default()
	}

	fn register_key_redaction(&mut self) {
		let Some(key) = self.key.as_deref() else {
			return;
		};
		if key.is_empty() || self.rules.iter().any(|rule| rule.content() == key) {
			return;
		}
		let replacement = ensure_distinct_replacement(generate_deterministic_replacement(key), key);
		self.generated_replaces.insert(replacement);
	}

	fn register_plain_placeholders(&mut self) {
		if self.key.is_none()
			&& self
				.rules
				.iter()
				.any(|rule| rule.kind() == SecretKind::Plain && rule.mode() == SecretMode::Obfuscate)
		{
			let _ = self.key();
		}
		let Some(key) = self.key.clone() else { return };
		for rule in &self.rules {
			if rule.kind() != SecretKind::Plain || rule.mode() != SecretMode::Obfuscate {
				continue;
			}
			let placeholder =
				self
					.registry
					.register(&key, rule.content(), rule.friendly_name(), false);
			self
				.plain_placeholders
				.insert(Str::new(rule.content()), placeholder);
		}
	}

	fn trusted_placeholder(&self, token: &str) -> bool {
		self.registry.lookup_exact(token).is_some()
	}

	fn lookup_placeholder(&self, token: &str) -> Option<&PlaceholderEntry> {
		if let Some(entry) = self.registry.lookup_exact(token) {
			return Some(entry);
		}
		let body = token.strip_prefix("$$")?.strip_suffix("$$")?;
		let (prefix, _) = body.split_once('_')?;
		let prefix_shape = sanitize_for_collision_check(prefix);
		if self.known_secret_shapes.iter().any(|shape| {
			!shape.is_empty() && (prefix_shape.contains(shape) || shape.contains(&prefix_shape))
		}) {
			return None;
		}
		let alias = placeholder_without_friendly_name(token)?;
		self.registry.lookup_exact(&alias)
	}

	/// Obfuscates one provider-bound text projection.
	///
	/// Complete placeholders minted by this snapshot are atomic, making repeated
	/// calls a fixed point.
	pub fn obfuscate(&mut self, text: &str) -> String {
		if !self.has_secrets || text.is_empty() {
			return text.to_owned();
		}
		let mut tracked = TrackedText::input(text);

		let mut plain_replace = self
			.rules
			.iter()
			.filter(|rule| rule.kind() == SecretKind::Plain && rule.mode() == SecretMode::Replace)
			.collect::<Vec<_>>();
		plain_replace.sort_unstable_by_key(|rule| cmp::Reverse(rule.content().len()));
		for rule in plain_replace {
			let replacement = rule.replacement().map_or_else(
				|| {
					ensure_distinct_replacement(
						generate_deterministic_replacement(rule.content()),
						rule.content(),
					)
				},
				str::to_owned,
			);
			self.generated_replaces.insert(replacement.clone());
			replace_literal_outside(&mut tracked, rule.content(), &replacement, |token| {
				self.trusted_placeholder(token)
			});
		}
		if let Some(key) = self.key.clone().filter(|key| !key.is_empty()) {
			let replacement =
				ensure_distinct_replacement(generate_deterministic_replacement(&key), &key);
			replace_literal_outside(&mut tracked, &key, &replacement, |token| {
				self.trusted_placeholder(token)
			});
		}

		let mut plain_obfuscate = self.plain_placeholders.iter().collect::<Vec<_>>();
		plain_obfuscate.sort_unstable_by_key(|(secret, _)| cmp::Reverse(secret.len()));
		for (secret, placeholder) in plain_obfuscate {
			replace_literal_outside(&mut tracked, secret.as_str(), placeholder, |token| {
				self.trusted_placeholder(token)
			});
		}

		for index in 0..self.rules.len() {
			if self.rules[index].kind() != SecretKind::Regex {
				continue;
			}
			let rule = self.rules[index].clone();
			let Some(regex) = rule.regex() else { continue };
			let source = tracked.as_str().to_owned();
			let outside = outside_placeholder_ranges(&source, |token| self.trusted_placeholder(token))
				.collect::<Vec<_>>();
			let mut replacements = Vec::new();
			for range in outside {
				for found in regex.find_iter(&source[range.clone()]) {
					let start = range.start + found.start();
					let end = range.start + found.end();
					let value = &source[start..end];
					if rule.boundary_guard() && !on_credential_boundary(&source, start, end) {
						continue;
					}
					if value.len() < MIN_OBFUSCATE_SECRET_LEN && rule.mode() == SecretMode::Obfuscate {
						continue;
					}
					let replacement = match rule.mode() {
						SecretMode::Replace => rule.replacement().map_or_else(
							|| {
								let key = self.key().to_owned();
								regex_replacement(
									value,
									regex,
									RegexMatchContext { text: &source, start, end },
									&key,
								)
							},
							str::to_owned,
						),
						SecretMode::Obfuscate => {
							let key = self.key().to_owned();
							self
								.known_secret_shapes
								.insert(sanitize_for_collision_check(value));
							self
								.registry
								.register(&key, value, rule.friendly_name(), false)
						},
					};
					if rule.mode() == SecretMode::Replace {
						self.generated_replaces.insert(replacement.clone());
					}
					replacements.push((start..end, replacement, Origin::Fresh));
				}
			}
			tracked.replace_ranges(&mut replacements);
		}
		tracked.into_string()
	}

	/// Restores only keyed placeholders minted by this session snapshot.
	pub fn deobfuscate(&self, text: &str) -> String {
		deobfuscate_placeholders(text, |placeholder| self.lookup_placeholder(placeholder).cloned())
	}
}

fn replace_literal_outside(
	tracked: &mut TrackedText,
	needle: &str,
	replacement: &str,
	trusted: impl FnMut(&str) -> bool,
) {
	if needle.is_empty() || needle == replacement {
		return;
	}
	let source = tracked.as_str().to_owned();
	let mut replacements = Vec::new();
	for outside in outside_placeholder_ranges(&source, trusted) {
		for (offset, _) in source[outside.clone()].match_indices(needle) {
			let start = outside.start + offset;
			replacements.push((start..start + needle.len(), replacement.to_owned(), Origin::Fresh));
		}
	}
	tracked.replace_ranges(&mut replacements);
}
/// Returns whether `start..end` is not flanked by credential-alphabet bytes.
///
/// Enforces [`SecretRule::boundary_guard`]: the lookaround boundary over
/// `[0-9A-Za-z_*-]`, checked here because the linear-time engine cannot.
fn on_credential_boundary(source: &str, start: usize, end: usize) -> bool {
	let alphabet = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'*' | b'-');
	let left = start
		.checked_sub(1)
		.is_none_or(|index| !alphabet(source.as_bytes()[index]));
	left
		&& source
			.as_bytes()
			.get(end)
			.is_none_or(|byte| !alphabet(*byte))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rule::{SecretKind, SecretMode};

	fn plain(content: &str, mode: SecretMode) -> SecretRule {
		SecretRule::new(SecretKind::Plain, mode, content, None, None, None).expect("rule")
	}

	#[test]
	fn reversible_transform_is_a_fixed_point() {
		let mut obfuscator = SecretObfuscator::new(
			vec![plain("SUPER_SECRET_TOKEN", SecretMode::Obfuscate)],
			"K".repeat(43),
		);
		let once = obfuscator.obfuscate("x SUPER_SECRET_TOKEN y");
		assert_eq!(obfuscator.obfuscate(&once), once);
		assert_eq!(obfuscator.deobfuscate(&once), "x SUPER_SECRET_TOKEN y");
	}

	#[test]
	fn replace_transform_is_a_fixed_point() {
		let mut obfuscator = SecretObfuscator::new(
			vec![plain("SUPER_SECRET_TOKEN", SecretMode::Replace)],
			"K".repeat(43),
		);
		let once = obfuscator.obfuscate("SUPER_SECRET_TOKEN");
		assert_ne!(once, "SUPER_SECRET_TOKEN");
		assert_eq!(obfuscator.obfuscate(&once), once);
	}

	#[test]
	fn regex_discovery_restores_nested_tool_values() {
		let rule = SecretRule::new(
			SecretKind::Regex,
			SecretMode::Obfuscate,
			"tok_[a-z0-9]+",
			None,
			None,
			None,
		)
		.expect("rule");
		let mut obfuscator = SecretObfuscator::new(vec![rule], "K".repeat(43));
		let masked = obfuscator.obfuscate("tok_abcdefgh");
		assert_eq!(obfuscator.deobfuscate(&masked), "tok_abcdefgh");
	}
	#[test]
	fn forged_secret_shaped_alias_prefix_does_not_restore() {
		let mut obfuscator = SecretObfuscator::new(
			vec![plain("SUPER_SECRET_TOKEN", SecretMode::Obfuscate)],
			"K".repeat(43),
		);
		let token = obfuscator.obfuscate("SUPER_SECRET_TOKEN");
		let body = token
			.strip_prefix("$$")
			.and_then(|value| value.strip_suffix("$$"))
			.expect("token");
		let suffix = body.rsplit_once('_').map_or(body, |(_, suffix)| suffix);
		let forged = format!("$$SUPERSECRETTOKEN_{suffix}$$");
		assert_eq!(obfuscator.deobfuscate(&forged), forged);
	}
}
