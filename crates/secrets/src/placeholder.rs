use std::{
	cmp,
	collections::{HashMap, HashSet},
	ops::Range,
};

use hmac::{Hmac, Mac as _};
use omp_core::Str;
use sha2::Sha256;

use crate::{
	replacement::{ensure_distinct_replacement, generate_deterministic_replacement},
	rule::{SecretKind, SecretMode, SecretRule},
};

const HASH_CHARS: &[u8; 36] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HASH_LEN: usize = 12;
const MAX_FRIENDLY_NAME_LEN: usize = 32;

/// The ASCII case classification carried by a placeholder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaseHint {
	/// Every cased character is uppercase.
	Upper,
	/// Every cased character is lowercase.
	Lower,
	/// Only the first cased character is uppercase.
	Capitalized,
	/// The value has another mixture of cases.
	Mixed,
}

impl CaseHint {
	const fn suffix(self) -> char {
		match self {
			Self::Upper => 'U',
			Self::Lower => 'L',
			Self::Capitalized => 'C',
			Self::Mixed => 'M',
		}
	}
}

/// Infers the U/L/C/M ASCII case hint.
pub fn infer_case_hint(secret: &str) -> Option<CaseHint> {
	let mut has_upper = false;
	let mut has_lower = false;
	let mut capitalized = true;
	let mut seen_first = false;
	for byte in secret.bytes() {
		let (upper, lower) = (byte.is_ascii_uppercase(), byte.is_ascii_lowercase());
		if !upper && !lower {
			continue;
		}
		if upper {
			has_upper = true;
			if seen_first {
				capitalized = false;
			}
		} else {
			has_lower = true;
			if !seen_first {
				capitalized = false;
			}
		}
		seen_first = true;
	}
	match (has_upper, has_lower, capitalized) {
		(false, false, _) => None,
		(true, false, _) => Some(CaseHint::Upper),
		(false, true, _) => Some(CaseHint::Lower),
		(true, true, true) => Some(CaseHint::Capitalized),
		(true, true, false) => Some(CaseHint::Mixed),
	}
}

/// Removes non-alphanumerics, uppercases, and caps a model-visible label at 32
/// bytes.
pub fn sanitize_friendly_name(name: &str) -> Option<String> {
	let sanitized: String = name
		.bytes()
		.filter(u8::is_ascii_alphanumeric)
		.map(|byte| byte.to_ascii_uppercase() as char)
		.take(MAX_FRIENDLY_NAME_LEN)
		.collect();
	(!sanitized.is_empty()).then_some(sanitized)
}

/// Normalizes arbitrary text for a label/secret collision check.
pub fn sanitize_for_collision_check(value: &str) -> String {
	value
		.bytes()
		.filter(u8::is_ascii_alphanumeric)
		.map(|byte| byte.to_ascii_uppercase() as char)
		.collect()
}

/// Reports whether exposing a sanitized label would expose the secret itself.
pub fn sanitized_label_collides_with_secret(label: &str, secret: &str) -> bool {
	!secret.is_empty()
		&& (label.contains(secret)
			|| (label.len() >= MAX_FRIENDLY_NAME_LEN && secret.starts_with(label)))
}

/// Builds the 12-character, least-significant-digit-first base36 HMAC tag.
pub fn build_hash_base(key: &str, value: &str) -> String {
	let mut mac =
		Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts every key size");
	mac.update(value.as_bytes());
	let digest = mac.finalize().into_bytes();
	let mut value = u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 has eight bytes"));
	let mut tag = String::with_capacity(HASH_LEN);
	for _ in 0..HASH_LEN {
		tag.push(HASH_CHARS[(value % HASH_CHARS.len() as u64) as usize] as char);
		value /= HASH_CHARS.len() as u64;
	}
	tag
}

/// Formats `$$[LABEL_]BASE[:HINT]$$`.
pub fn build_placeholder(hint: Option<CaseHint>, base: &str, label: Option<&str>) -> String {
	let label_len = label.map_or(0, |value| value.len() + 1);
	let mut output =
		String::with_capacity(4 + label_len + base.len() + usize::from(hint.is_some()) * 2);
	output.push_str("$$");
	if let Some(label) = label {
		output.push_str(label);
		output.push('_');
	}
	output.push_str(base);
	if let Some(hint) = hint {
		output.push(':');
		output.push(hint.suffix());
	}
	output.push_str("$$");
	output
}

/// Returns the label-free alias of a labeled placeholder.
pub fn placeholder_without_friendly_name(placeholder: &str) -> Option<String> {
	let body = placeholder.strip_prefix("$$")?.strip_suffix("$$")?;
	let underscore = body.find('_')?;
	let (label, rest) = body.split_at(underscore);
	let rest = &rest[1..];
	if label.is_empty()
		|| !label
			.bytes()
			.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
		|| !valid_base_and_hint(rest)
	{
		return None;
	}
	Some(format!("$${rest}$$"))
}

fn valid_base_and_hint(value: &str) -> bool {
	let (base, hint) = value
		.split_once(':')
		.map_or((value, None), |(base, hint)| (base, Some(hint)));
	base.len() >= 4
		&& base
			.bytes()
			.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
		&& hint.is_none_or(|hint| matches!(hint, "U" | "L" | "C" | "M"))
}
fn valid_placeholder(placeholder: &str) -> bool {
	let Some(body) = placeholder
		.strip_prefix("$$")
		.and_then(|body| body.strip_suffix("$$"))
	else {
		return false;
	};
	let value = body.split_once('_').map_or(body, |(label, value)| {
		if label.is_empty()
			|| !label
				.bytes()
				.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
		{
			return "";
		}
		value
	});
	valid_base_and_hint(value)
}

/// Scanner over syntactically complete keyed placeholders in arbitrary text.
///
/// A rejected candidate resumes at its closing delimiter because that same
/// delimiter may open an immediately adjacent valid placeholder.
#[derive(Clone, Debug)]
pub struct PlaceholderScanner<'a> {
	text:   &'a str,
	cursor: usize,
}

impl<'a> PlaceholderScanner<'a> {
	/// Creates a scanner over one complete message.
	pub const fn new(text: &'a str) -> Self {
		Self { text, cursor: 0 }
	}
}

impl<'a> Iterator for PlaceholderScanner<'a> {
	type Item = (Range<usize>, &'a str);

	fn next(&mut self) -> Option<Self::Item> {
		while self.cursor < self.text.len() {
			let start = self.cursor + self.text[self.cursor..].find("$$")?;
			let body_start = start + 2;
			let Some(relative_end) = self.text[body_start..].find("$$") else {
				self.cursor = self.text.len();
				return None;
			};
			let end = body_start + relative_end + 2;
			let candidate = &self.text[start..end];
			if valid_placeholder(candidate) {
				self.cursor = end;
				return Some((start..end, candidate));
			}
			self.cursor = end - 2;
		}
		None
	}
}

/// Restores complete placeholders across one message, recursively rescanning
/// only when a restored entry is declared recursive.
pub fn deobfuscate_placeholders(
	text: &str,
	mut lookup: impl FnMut(&str) -> Option<PlaceholderEntry>,
) -> String {
	if !text.contains("$$") {
		return text.to_owned();
	}
	let mut current = text.to_owned();
	loop {
		let mut output = String::with_capacity(current.len());
		let mut cursor = 0;
		let mut recursive = false;
		for (range, placeholder) in PlaceholderScanner::new(&current) {
			output.push_str(&current[cursor..range.start]);
			if let Some(entry) = lookup(placeholder) {
				output.push_str(entry.secret.as_str());
				recursive |= entry.recursive;
			} else {
				output.push_str(placeholder);
			}
			cursor = range.end;
		}
		output.push_str(&current[cursor..]);
		if output == current || !recursive || !output.contains("$$") {
			return output;
		}
		current = output;
	}
}

/// One reversible placeholder registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceholderEntry {
	/// Exact secret bytes restored locally.
	pub secret:    Str,
	/// Whether restoration should recursively scan the restored value.
	pub recursive: bool,
}

/// Collision-aware placeholder and alias registry for one immutable secret
/// snapshot.
#[derive(Debug, Default)]
pub struct PlaceholderRegistry {
	entries:       HashMap<String, PlaceholderEntry>,
	bases:         HashMap<String, Str>,
	secret_shapes: HashSet<String>,
}

impl PlaceholderRegistry {
	/// Creates an empty registry.
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers a secret and returns its canonical placeholder.
	pub fn register(
		&mut self,
		key: &str,
		secret: &str,
		friendly_name: Option<&str>,
		recursive: bool,
	) -> String {
		let secret_shape = sanitize_for_collision_check(secret);
		let full_label_shape = friendly_name.map(sanitize_for_collision_check);
		let label = friendly_name.and_then(sanitize_friendly_name).filter(|_| {
			full_label_shape.as_deref().is_some_and(|label| {
				!sanitized_label_collides_with_secret(label, &secret_shape)
					&& !self
						.secret_shapes
						.iter()
						.any(|shape| sanitized_label_collides_with_secret(label, shape))
			})
		});
		let hint = infer_case_hint(secret);
		let mut attempt = 0_u32;
		let placeholder = loop {
			let base = if attempt == 0 {
				build_hash_base(key, secret)
			} else {
				build_hash_base(key, &format!("{secret}\0{attempt}"))
			};
			let candidate = build_placeholder(hint, &base, label.as_deref());
			let base_available = self
				.bases
				.get(&base)
				.is_none_or(|owner| owner.as_str() == secret);
			if base_available
				&& self
					.entries
					.get(&candidate)
					.is_none_or(|entry| entry.secret.as_str() == secret)
			{
				break (candidate, base);
			}
			attempt = attempt.saturating_add(1);
		};
		let (placeholder, base) = placeholder;
		let entry = PlaceholderEntry { secret: Str::new(secret), recursive };
		self.bases.insert(base, entry.secret.clone());
		self.entries.insert(placeholder.clone(), entry.clone());
		if let Some(alias) = placeholder_without_friendly_name(&placeholder) {
			self.entries.entry(alias).or_insert(entry);
		}
		self.secret_shapes.insert(secret_shape);
		placeholder
	}

	/// Looks up only a token registered exactly by this snapshot.
	pub fn lookup_exact(&self, placeholder: &str) -> Option<&PlaceholderEntry> {
		self.entries.get(placeholder)
	}

	/// Looks up either a canonical labeled placeholder or its label-free alias.
	pub fn lookup(&self, placeholder: &str) -> Option<&PlaceholderEntry> {
		self.entries.get(placeholder).or_else(|| {
			placeholder_without_friendly_name(placeholder)
				.as_deref()
				.and_then(|alias| self.entries.get(alias))
		})
	}

	/// Restores registered placeholders across one complete message.
	pub fn deobfuscate(&self, text: &str) -> String {
		deobfuscate_placeholders(text, |placeholder| self.lookup(placeholder).cloned())
	}
}

/// Returns whether one rule can require a persistent placeholder key.
pub fn rule_needs_placeholder_key(rule: &SecretRule) -> bool {
	match rule.mode() {
		SecretMode::Obfuscate => true,
		SecretMode::Replace => rule.kind() == SecretKind::Regex && rule.replacement().is_none(),
	}
}

/// Simulates the ordered plain-replacement phase before deciding to persist a
/// key.
pub fn rules_need_placeholder_key(rules: &[SecretRule]) -> bool {
	let mut phase = Vec::<(&str, String)>::new();
	for rule in rules {
		if rule.kind() != SecretKind::Plain || rule.mode() != SecretMode::Replace {
			continue;
		}
		let generated;
		let replacement = if let Some(replacement) = rule.replacement() {
			replacement
		} else {
			generated = ensure_distinct_replacement(
				generate_deterministic_replacement(rule.content()),
				rule.content(),
			);
			&generated
		};
		if let Some((_, effective)) = phase
			.iter_mut()
			.find(|(content, _)| *content == rule.content())
		{
			*effective = replacement.to_owned();
		} else {
			phase.push((rule.content(), replacement.to_owned()));
		}
	}
	phase.sort_by_key(|(content, _)| cmp::Reverse(content.len()));
	let apply_from = |text: &str, start: usize| {
		phase[start..]
			.iter()
			.fold(text.to_owned(), |value, (content, replacement)| value.replace(content, replacement))
	};
	rules.iter().any(|rule| {
		if !rule_needs_placeholder_key(rule) {
			return false;
		}
		if rule.kind() == SecretKind::Regex {
			return true;
		}
		let content = rule.content();
		apply_from(content, 0).contains(content)
			|| phase.iter().enumerate().any(|(index, (_, replacement))| {
				apply_from(content, index + 1) == content
					&& replacement_can_form_content(&apply_from(replacement, index + 1), content)
			})
	})
}

fn replacement_can_form_content(replacement: &str, content: &str) -> bool {
	if replacement.is_empty() {
		return !content.is_empty();
	}
	if content.contains(replacement) || replacement.contains(content) {
		return true;
	}
	let max_overlap = replacement.len().min(content.len());
	(1..=max_overlap).any(|count| {
		content.starts_with(&replacement[replacement.len() - count..])
			|| content.ends_with(&replacement[..count])
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn placeholder_round_trip_matches_pi_grammar() {
		let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		let mut registry = PlaceholderRegistry::new();
		let placeholder = registry.register(key, "TokenValue123", Some("api-token"), false);
		assert_eq!(placeholder, "$$APITOKEN_XEBY1T87ILH2:M$$");
		assert_eq!(
			registry
				.lookup(&placeholder)
				.expect("canonical")
				.secret
				.as_str(),
			"TokenValue123"
		);
		let alias = placeholder_without_friendly_name(&placeholder).expect("alias");
		assert_eq!(
			registry
				.lookup(&alias)
				.expect("unprefixed alias")
				.secret
				.as_str(),
			"TokenValue123"
		);
	}

	#[test]
	fn sanitizes_and_drops_leaking_label() {
		assert_eq!(sanitize_friendly_name(" open-ai_token ").as_deref(), Some("OPENAITOKEN"));
		let mut registry = PlaceholderRegistry::new();
		let placeholder =
			registry.register("key", "secret-token-123", Some("secret token 123"), false);
		assert!(!placeholder.contains('_'));
	}

	#[test]
	fn classifies_all_case_hints() {
		assert_eq!(infer_case_hint("ABC-123"), Some(CaseHint::Upper));
		assert_eq!(infer_case_hint("abc-123"), Some(CaseHint::Lower));
		assert_eq!(infer_case_hint("Abc-123"), Some(CaseHint::Capitalized));
		assert_eq!(infer_case_hint("aBc-123"), Some(CaseHint::Mixed));
		assert_eq!(infer_case_hint("123"), None);
	}

	#[test]
	fn key_need_simulation_observes_replace_phase_shadowing() {
		let replace = SecretRule::new(
			SecretKind::Plain,
			SecretMode::Replace,
			"secret12",
			Some(Str::new("safe")),
			None,
			None,
		)
		.expect("replace rule");
		let obfuscate =
			SecretRule::new(SecretKind::Plain, SecretMode::Obfuscate, "secret12", None, None, None)
				.expect("obfuscate rule");
		assert!(!rules_need_placeholder_key(&[replace, obfuscate]));
	}
}
