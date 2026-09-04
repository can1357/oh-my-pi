//! `scheme://` internal URL references.
//!
//! A `skill://`, `rule://`, `local://`, `omp://`, `memory://`, `agent://`,
//! `artifact://`, … token ending at the cursor offers the resources the
//! application's resolver table can complete for that scheme, fuzzy-ranked
//! by the text typed after the slashes; acceptance inserts the full URL
//! plus a trailing space (like `@` file references).
//!
//! The application supplies resource-relative candidates through
//! [`UrlCompleter`]. The provider passes the live query on every request.

use std::sync::Arc;

use omp_core::{Str, sf};
use omp_tui::{EditorCompletion, Icon, Suggestion, Suggestions};

use super::fuzzy_score;

/// Upper bound on rows surfaced in the dropdown.
const MAX_ROWS: usize = 25;

/// One completable resource under a scheme.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UrlCandidate {
	/// Resource-relative value, e.g. `humanizer` for `skill://humanizer`.
	pub value:       Str,
	/// Optional short label; the value is shown when absent.
	pub label:       Option<Str>,
	/// Explanatory text shown beside the label.
	pub description: Option<Str>,
}

/// Application-supplied candidate source: resources matching `query` under
/// `scheme` (both without `://`), or `None` when the scheme has no
/// completion-capable resolver.
pub type UrlCompleter = Arc<dyn Fn(&str, &str) -> Option<Vec<UrlCandidate>> + Send + Sync>;

/// A `scheme://query` token ending at the cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UrlContext<'a> {
	/// Byte offset of the token start.
	pub start:  usize,
	/// Lowercased scheme, e.g. `local`.
	pub scheme: Str,
	/// Text typed after the slashes so far (host + path); may be empty.
	pub query:  &'a str,
}

/// Whether `character` may continue a URL token: anything but whitespace,
/// quotes, parentheses, and angle brackets.
const fn is_url_char(character: char) -> bool {
	!(character.is_whitespace() || matches!(character, '"' | '\'' | '`' | '(' | ')' | '<' | '>'))
}

/// Whether `character` may precede a URL token.
const fn is_url_boundary(character: char) -> bool {
	character.is_whitespace() || matches!(character, '"' | '\'' | '`' | '(' | '<' | '=')
}

/// Whether `scheme` spells a URL scheme: `[a-z][a-z0-9+.-]*`, any case.
fn is_scheme(scheme: &str) -> bool {
	let mut characters = scheme.chars();
	characters
		.next()
		.is_some_and(|first| first.is_ascii_alphabetic())
		&& characters
			.all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-'))
}

/// Parses the internal URL token ending at `cursor`, if any: a scheme, a
/// colon, one or two slashes, and the partial resource.
#[must_use]
pub fn url_context(text: &str, cursor: usize) -> Option<UrlContext<'_>> {
	let before = text.get(..cursor)?;
	let start = before
		.char_indices()
		.rev()
		.find(|(_, character)| !is_url_char(*character))
		.map_or(0, |(at, character)| at + character.len_utf8());
	if start > 0
		&& !before[..start]
			.chars()
			.next_back()
			.is_some_and(is_url_boundary)
	{
		return None;
	}
	// `=` is both a boundary and a token character (`a=omp://`, and
	// `omp://k=v` alike); use the leftmost boundary whose remainder parses
	// as `scheme:/…`, so try each `=` from the left.
	let token = &before[start..];
	let starts = std::iter::once(start).chain(
		token
			.match_indices('=')
			.map(|(at, equals)| start + at + equals.len()),
	);
	for start in starts {
		let token = &before[start..];
		let Some((scheme, rest)) = token.split_once(':') else {
			continue;
		};
		if !is_scheme(scheme) {
			continue;
		}
		let Some(query) = rest.strip_prefix("//").or_else(|| rest.strip_prefix('/')) else {
			continue;
		};
		return Some(UrlContext { start, scheme: Str::new(scheme.to_ascii_lowercase()), query });
	}
	None
}

/// Decodes `%XX` escapes for matching; the raw value is returned untouched
/// when the encoding is malformed.
fn percent_decode(value: &str) -> Str {
	if !value.contains('%') {
		return Str::new(value);
	}
	let bytes = value.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& let Some(pair) = bytes.get(index + 1..index + 3)
			&& let Some(byte) = u8::from_str_radix(str::from_utf8(pair).unwrap_or("zz"), 16).ok()
		{
			decoded.push(byte);
			index += 3;
		} else {
			decoded.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(decoded).map_or_else(|_| Str::new(value), Str::new)
}

/// Type-indicator icon for a scheme's rows.
fn scheme_icon(scheme: &str) -> Icon {
	match scheme {
		"skill" => Icon::Skill,
		"rule" => Icon::RuleExtension,
		"memory" => Icon::Memory,
		"agent" | "history" => Icon::Agents,
		"artifact" | "local" | "attachment" => Icon::File,
		_ => Icon::Link,
	}
}

/// Internal URL completion over an application-supplied candidate source.
pub struct InternalUrls {
	completer: UrlCompleter,
}

impl InternalUrls {
	/// Builds the provider over `completer`.
	#[must_use]
	pub fn new(completer: UrlCompleter) -> Self {
		Self { completer }
	}
}

impl EditorCompletion for InternalUrls {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		let context = url_context(text, cursor)?;
		let query = context.query.to_ascii_lowercase();
		let scheme = context.scheme.clone();
		let candidates = (self.completer)(&scheme, context.query)?;
		let mut scored: Vec<(u16, usize, &UrlCandidate)> = candidates
			.iter()
			.enumerate()
			.filter_map(|(index, candidate)| {
				// Scheme ownership is one-way: the resolver
				// returns a resource-relative value and this provider adds the
				// scheme exactly once. Reject a producer contract violation
				// instead of ever offering `agent://agent://…`.
				if candidate.value.contains("://") {
					return None;
				}
				let target = percent_decode(&candidate.value).to_ascii_lowercase();
				fuzzy_score(&query, &target).map(|score| (score, index, candidate))
			})
			.collect();
		if scored.is_empty() {
			return None;
		}
		scored.sort_by_key(|(score, index, _)| (std::cmp::Reverse(*score), *index));
		let icon = scheme_icon(&scheme);
		let items = scored
			.into_iter()
			.take(MAX_ROWS)
			.map(|(_, _, candidate)| {
				let value = sf!("{scheme}://{}", candidate.value);
				let mut row = Suggestion::new(
					sf!("{value} "),
					candidate
						.label
						.clone()
						.unwrap_or_else(|| candidate.value.clone()),
				)
				.with_icon(icon);
				if let Some(description) = &candidate.description {
					row = row.with_description(description.clone());
				}
				row
			})
			.collect();
		Some(Suggestions { range: context.start..cursor, items })
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	fn candidate(value: &'static str, description: Option<&'static str>) -> UrlCandidate {
		UrlCandidate {
			value:       Str::new_static(value),
			label:       None,
			description: description.map(Str::new_static),
		}
	}

	fn provider(calls: Arc<AtomicUsize>) -> InternalUrls {
		InternalUrls::new(Arc::new(move |scheme: &str, _query: &str| {
			calls.fetch_add(1, Ordering::Relaxed);
			match scheme {
				"skill" => Some(vec![
					candidate("humanizer", Some("Humanize prose")),
					candidate("local-plan", None),
					candidate("pyo3", Some("PyO3 boundary rules")),
				]),
				"local" => Some(vec![candidate("omp2-plan.md", None)]),
				"ssh" => Some(vec![candidate("alice%40prod", Some("prod"))]),
				_ => None,
			}
		}))
	}

	fn labels(suggestions: &Suggestions) -> Vec<&str> {
		suggestions
			.items
			.iter()
			.map(|item| match item.display() {
				omp_tui::SuggestionDisplay::Text(label) => label.as_str(),
				omp_tui::SuggestionDisplay::Emoji { .. } => unreachable!(),
			})
			.collect()
	}

	#[test]
	fn token_detection_mirrors_pi_url_token_re() {
		assert_eq!(
			url_context("skill://", 8),
			Some(UrlContext { start: 0, scheme: Str::new_static("skill"), query: "" })
		);
		assert_eq!(
			url_context("read Skill:/hum", 15),
			Some(UrlContext { start: 5, scheme: Str::new_static("skill"), query: "hum" })
		);
		assert_eq!(url_context("(local://x", 10).map(|context| context.start), Some(1));
		assert_eq!(url_context("a=omp://", 8).map(|context| context.start), Some(2));
		assert_eq!(
			url_context("x=skill://a=b", 13),
			Some(UrlContext { start: 2, scheme: Str::new_static("skill"), query: "a=b" })
		);
		// Mid-word, no slashes, or a non-scheme word never form a token.
		assert!(url_context("foo/skill://x", 13).is_none());
		assert!(url_context("skill:x", 7).is_none());
		assert!(url_context("1st://x", 7).is_none());
		assert!(url_context("plain text", 10).is_none());
		// The cursor mid-token completes the part before it.
		assert_eq!(url_context("skill://hum tail", 11).map(|context| context.query), Some("hum"));
	}

	#[test]
	fn rows_are_fuzzy_ranked_and_insert_the_full_url_with_a_space() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut urls = provider(Arc::clone(&calls));
		let text = "see skill://";
		let all = urls.suggest(text, text.len()).expect("every skill");
		assert_eq!(all.range, 4..text.len());
		assert_eq!(labels(&all), ["humanizer", "local-plan", "pyo3"]);
		assert_eq!(all.items[0].value(), "skill://humanizer ");
		assert_eq!(all.items[0].description(), Some("Humanize prose"));
		assert_eq!(all.items[0].icon(), Some(Icon::Skill));
		let text = "see skill://lp";
		let fuzzy = urls.suggest(text, text.len()).expect("subsequence match");
		assert_eq!(labels(&fuzzy), ["local-plan"]);
		let text = "see skill://PY";
		let prefix = urls
			.suggest(text, text.len())
			.expect("case-insensitive prefix");
		assert_eq!(labels(&prefix), ["pyo3"]);
		assert!(urls.suggest("see skill://zzz", 15).is_none(), "no match closes");
		// The provider passes the live query to the resolver on every request.
		assert_eq!(calls.load(Ordering::Relaxed), 4);
	}

	#[test]
	fn unknown_schemes_decline_and_scheme_switches_refetch() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut urls = provider(Arc::clone(&calls));
		assert!(urls.suggest("https://exa", 11).is_none());
		assert!(urls.suggest("https://exam", 12).is_none());
		assert_eq!(calls.load(Ordering::Relaxed), 2, "each query reaches the resolver");
		assert!(urls.suggest("https://exam ", 13).is_none());
		assert!(urls.suggest("https://exam h", 14).is_none());
		assert_eq!(calls.load(Ordering::Relaxed), 2, "no URL token, no fetch");
		assert!(urls.suggest("https://", 8).is_none());
		assert_eq!(calls.load(Ordering::Relaxed), 3, "a new token fetches again");
		let rows = urls.suggest("local://", 8).expect("local rows");
		assert_eq!(labels(&rows), ["omp2-plan.md"]);
		assert_eq!(calls.load(Ordering::Relaxed), 4, "a scheme switch fetches");
		let rows = urls.suggest("local://o", 9).expect("live query");
		assert_eq!(rows.items.len(), 1);
		assert_eq!(calls.load(Ordering::Relaxed), 5);
	}

	#[test]
	fn percent_encoded_values_match_their_decoded_form() {
		let mut urls = provider(Arc::new(AtomicUsize::new(0)));
		let text = "ssh://alice@";
		let rows = urls
			.suggest(text, text.len())
			.expect("decoded host matches");
		assert_eq!(rows.items[0].value(), "ssh://alice%40prod ");
		assert_eq!(percent_decode("a%zz"), "a%zz");
	}

	#[test]
	fn scheme_qualified_values_are_rejected_at_the_source_boundary() {
		let mut urls = InternalUrls::new(Arc::new(|scheme: &str, query: &str| {
			assert_eq!(scheme, "agent");
			assert_eq!(query, "fx2");
			Some(vec![candidate("agent://Fx2Composer", None)])
		}));
		assert!(
			urls.suggest("agent://fx2", 11).is_none(),
			"the provider, not the candidate source, owns the scheme prefix"
		);
	}
}
