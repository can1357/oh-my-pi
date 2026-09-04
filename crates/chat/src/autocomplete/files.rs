//! `@` project file references: a bare `@` lists the project root, `@query`
//! fuzzy matches every gitignore-aware project path, and acceptance inserts
//! `@path ` (a directory keeps its trailing `/` so typing can continue).
//!
//! The project is walked once on a background thread; the key path only
//! filters the finished index and answers nothing until it exists.

use std::{
	path::Path,
	sync::{Arc, OnceLock},
	thread,
};

use omp_agent::{file_mention_prefix, file_mention_token_end};
use omp_core::{Str, sf};
use omp_tui::{EditorCompletion, Icon, Suggestion, Suggestions};
use omp_walker::{FileType, WalkRequest};
use smallvec::SmallVec;

use super::fuzzy_score;

/// Upper bound on indexed paths.
const MAX_ENTRIES: usize = 5_000;
/// Rows offered per query.
const MAX_ROWS: usize = 20;

/// One indexed project path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
	/// Root-relative path with `/` separators; directories end in `/`.
	pub path:      Str,
	/// Lowercased `path` for case-insensitive matching.
	lower:         Str,
	/// Whether the entry is a directory.
	pub directory: bool,
}

impl Entry {
	fn new(path: &str, directory: bool) -> Self {
		let path = if directory {
			sf!("{path}/")
		} else {
			Str::new(path)
		};
		let lower = Str::new(&path.to_ascii_lowercase());
		Self { path, lower, directory }
	}
}

/// Shared, write-once project index.
type Index = Arc<OnceLock<Box<[Entry]>>>;

/// Project file completion over a background-built index.
pub struct ProjectFiles {
	index: Index,
}

impl ProjectFiles {
	/// Starts indexing `root` in the background and returns the provider.
	#[must_use]
	pub fn scan(root: &Path) -> Self {
		let index: Index = Arc::new(OnceLock::new());
		let request = WalkRequest::new(root)
			.hidden(false)
			.gitignore(true)
			.skip_git(true)
			.depth(1, 64)
			.limit(MAX_ENTRIES);
		let target = Arc::clone(&index);
		let spawned = thread::Builder::new()
			.name("omp-file-index".into())
			.spawn(move || {
				let entries = request.collect().map_or_else(
					|_| Box::default(),
					|outcome| {
						outcome
							.entries
							.iter()
							.map(|entry| Entry::new(&entry.path, entry.file_type == FileType::Dir))
							.collect()
					},
				);
				let _ = target.set(entries);
			});
		if spawned.is_err() {
			let _ = index.set(Box::default());
		}
		Self { index }
	}

	/// Provider over an already-built index (tests, headless replays).
	#[must_use]
	pub fn from_entries(entries: impl IntoIterator<Item = (Str, bool)>) -> Self {
		let index: Index = Arc::new(OnceLock::new());
		let _ = index.set(
			entries
				.into_iter()
				.map(|(path, directory)| Entry::new(&path, directory))
				.collect(),
		);
		Self { index }
	}

	fn ranked(&self, query: &str) -> SmallVec<&Entry, 8> {
		let Some(entries) = self.index.get() else {
			return SmallVec::new();
		};
		if query.is_empty() {
			// A bare `@` lists the root directory.
			let mut top: SmallVec<&Entry, 8> = entries
				.iter()
				.filter(|entry| {
					entry
						.path
						.trim_end_matches('/')
						.as_bytes()
						.iter()
						.all(|byte| *byte != b'/')
				})
				.collect();
			top.sort_by(|a, b| a.lower.cmp(&b.lower));
			top.truncate(MAX_ROWS);
			return top;
		}
		let query = query.to_ascii_lowercase();
		let mut scored: Vec<(u16, usize, &Entry)> = entries
			.iter()
			.enumerate()
			.filter_map(|(index, entry)| {
				let base = fuzzy_score(&query, entry.lower.trim_end_matches('/'))?;
				// A match on the final path segment outranks one that only
				// spans directories.
				let name = entry
					.lower
					.trim_end_matches('/')
					.rsplit('/')
					.next()
					.unwrap_or_default();
				let bonus = fuzzy_score(&query, name).unwrap_or(0);
				Some((base.saturating_add(bonus), index, entry))
			})
			.collect();
		scored.sort_by_key(|(score, index, _)| (std::cmp::Reverse(*score), *index));
		scored
			.into_iter()
			.take(MAX_ROWS)
			.map(|(_, _, entry)| entry)
			.collect()
	}
}

/// The `@…` token ending at `cursor`, shared with submitted-token parsing.
fn at_prefix(text: &str, cursor: usize) -> Option<usize> {
	file_mention_prefix(text, cursor)
}

impl EditorCompletion for ProjectFiles {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		let start = at_prefix(text, cursor)?;
		let query = &text[start + 1..cursor];
		let ranked = self.ranked(query);
		if ranked.is_empty() {
			return None;
		}
		let items = ranked
			.into_iter()
			.map(|entry| {
				let value = if entry.directory {
					sf!("@{}", entry.path)
				} else {
					sf!("@{} ", entry.path)
				};
				Suggestion::new(value, entry.path.clone()).with_icon(if entry.directory {
					Icon::Folder
				} else {
					Icon::File
				})
			})
			.collect();
		Some(Suggestions { range: start..file_mention_token_end(text, cursor), items })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn provider() -> ProjectFiles {
		ProjectFiles::from_entries([
			(Str::new_static("src"), true),
			(Str::new_static("src/main.rs"), false),
			(Str::new_static("src/lib.rs"), false),
			(Str::new_static("README.md"), false),
			(Str::new_static("docs"), true),
			(Str::new_static("docs/adr/0001.md"), false),
		])
	}

	#[test]
	fn bare_at_lists_the_root_sorted_with_directory_slashes() {
		let mut files = provider();
		let suggestions = files.suggest("look at @", 9).expect("root rows");
		assert_eq!(suggestions.range, 8..9);
		let labels: Vec<&str> = suggestions
			.items
			.iter()
			.map(|item| match item.display() {
				omp_tui::SuggestionDisplay::Text(label) => label.as_str(),
				omp_tui::SuggestionDisplay::Emoji { .. } => unreachable!(),
			})
			.collect();
		assert_eq!(labels, ["docs/", "README.md", "src/"]);
		assert_eq!(suggestions.items[0].value(), "@docs/");
		assert_eq!(suggestions.items[1].value(), "@README.md ");
	}

	#[test]
	fn query_fuzzy_matches_paths_and_prefers_basename_hits() {
		let mut files = provider();
		let suggestions = files.suggest("@main", 5).expect("fuzzy rows");
		assert_eq!(suggestions.items[0].value(), "@src/main.rs ");
		let adr = files.suggest("@adr", 4).expect("directory match");
		assert_eq!(adr.items[0].value(), "@docs/adr/0001.md ");
		assert!(files.suggest("@zzz", 4).is_none());
	}

	#[test]
	fn at_must_start_a_token_and_range_spans_the_live_token() {
		let mut files = provider();
		assert!(files.suggest("mail@src", 8).is_none());
		let suggestions = files.suggest("@sr tail", 3).expect("prefix rows");
		assert_eq!(suggestions.range, 0..3);
		let mid = files.suggest("@srcx", 3).expect("mid-token rows");
		assert_eq!(mid.range, 0..5);
	}

	#[test]
	fn unbuilt_index_answers_nothing() {
		let mut files = ProjectFiles { index: Arc::new(OnceLock::new()) };
		assert!(files.suggest("@", 1).is_none());
	}
}
