//! Composer autocomplete providers, chained in precedence:
//! slash commands and their arguments, `#<number>` GitHub references,
//! `#` prompt actions, `scheme://` internal URLs, then `@` project files.
//! The `:emoji` dropdown is the editor's built-in (`omp_tui::Editor`),
//! consulted after every provider declines.

use std::path::Path;

use omp_core::Str;
use omp_tui::{EditorCompletion, Suggestion, Suggestions, TabAction};
use smallvec::SmallVec;

pub mod files;
pub mod github_refs;
pub mod internal_urls;
pub mod prompt_actions;
pub mod slash;

pub use internal_urls::{InternalUrls, UrlCandidate, UrlCompleter};
pub use prompt_actions::{PromptAction, PromptActions};

/// Ordered completion providers: the first one with rows for the current
/// text owns the dropdown, its ghost hint, Tab, and acceptance.
pub struct CompletionChain {
	sources: SmallVec<Box<dyn EditorCompletion>, 5>,
	/// Provider that produced the rows currently shown.
	active:  Option<usize>,
}

impl CompletionChain {
	/// Builds an empty chain.
	#[must_use]
	pub const fn new() -> Self {
		Self { sources: SmallVec::new(), active: None }
	}

	/// Appends a lower-precedence provider.
	#[must_use]
	pub fn source(mut self, source: impl EditorCompletion + 'static) -> Self {
		self.sources.push(Box::new(source));
		self
	}
}

impl Default for CompletionChain {
	fn default() -> Self {
		Self::new()
	}
}

impl EditorCompletion for CompletionChain {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		for (index, source) in self.sources.iter_mut().enumerate() {
			if let Some(suggestions) = source.suggest(text, cursor) {
				self.active = Some(index);
				return Some(suggestions);
			}
		}
		self.active = None;
		None
	}

	fn hint(&mut self, text: &str, cursor: usize) -> Option<Str> {
		self
			.sources
			.iter_mut()
			.find_map(|source| source.hint(text, cursor))
	}

	fn tab(&mut self, text: &str, cursor: usize, selected: Option<&Suggestion>) -> TabAction {
		match self.active.and_then(|index| self.sources.get_mut(index)) {
			Some(source) => source.tab(text, cursor, selected),
			None if selected.is_some() => TabAction::Accept,
			None => TabAction::Pass,
		}
	}

	fn allow_builtin_emoji(&mut self, text: &str, cursor: usize) -> bool {
		self
			.sources
			.iter_mut()
			.all(|source| source.allow_builtin_emoji(text, cursor))
	}

	fn accepted(&mut self, replaced: &str, suggestion: &Suggestion) {
		if let Some(source) = self.active.and_then(|index| self.sources.get_mut(index)) {
			source.accepted(replaced, suggestion);
		}
	}
}

/// The production composer chain.
///
/// Slash commands from `roster`, GitHub references, prompt actions
/// reporting into `actions`, internal URLs from `urls`, and project files
/// under `project_root` (no file provider when the root is unknown).
#[must_use]
pub fn composer_chain(
	roster: Vec<omp_tui::Command>,
	mut actions: PromptActions,
	urls: UrlCompleter,
	project_root: Option<&Path>,
) -> CompletionChain {
	actions.suppress_in_command_args(roster.iter().map(omp_tui::Command::name));
	let chain = CompletionChain::new()
		.source(omp_tui::SlashCommands::new(roster))
		.source(github_refs::GithubRefs)
		.source(actions)
		.source(InternalUrls::new(urls));
	match project_root {
		Some(root) => chain.source(files::ProjectFiles::scan(root)),
		None => chain,
	}
}

/// Whether `at` starts a token: text start, or preceded by whitespace or
/// one of the opening boundary characters (`"'`(<=`).
pub(crate) fn is_token_start(text: &str, at: usize) -> bool {
	text[..at].chars().next_back().is_none_or(|previous| {
		previous.is_whitespace() || matches!(previous, '"' | '\'' | '`' | '(' | '<' | '=')
	})
}

/// Subsequence fuzzy scoring: exact 100, prefix 80,
/// substring 60, otherwise a gap-penalized subsequence score; `None` when
/// the query is not a subsequence of `target`. Both sides are compared as
/// given, so callers lowercase first.
pub(crate) fn fuzzy_score(query: &str, target: &str) -> Option<u16> {
	if query.is_empty() {
		return Some(1);
	}
	if target == query {
		return Some(100);
	}
	if target.starts_with(query) {
		return Some(80);
	}
	if target.contains(query) {
		return Some(60);
	}
	let mut remaining = query.chars();
	let mut wanted = remaining.next()?;
	let mut gaps = 0_u16;
	let mut last_match: Option<usize> = None;
	for (index, character) in target.char_indices() {
		if character != wanted {
			continue;
		}
		if last_match.is_some_and(|last| index > last + 1) {
			gaps = gaps.saturating_add(1);
		}
		last_match = Some(index);
		match remaining.next() {
			Some(next) => wanted = next,
			None => return Some(40_u16.saturating_sub(gaps.saturating_mul(5)).max(1)),
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fuzzy_score_follows_pi_tiers() {
		assert_eq!(fuzzy_score("", "anything"), Some(1));
		assert_eq!(fuzzy_score("copy", "copy"), Some(100));
		assert_eq!(fuzzy_score("cop", "copy line"), Some(80));
		assert_eq!(fuzzy_score("line", "copy line"), Some(60));
		assert_eq!(fuzzy_score("cpl", "copy line"), Some(30));
		assert_eq!(fuzzy_score("xyz", "copy line"), None);
	}

	#[test]
	fn token_boundaries_match_pi() {
		assert!(is_token_start("", 0));
		assert!(is_token_start("see @", 4));
		assert!(is_token_start("(@", 1));
		assert!(!is_token_start("a@", 1));
	}
}
