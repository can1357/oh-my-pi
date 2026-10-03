//! Shell patterns

use std::{collections::VecDeque, path::Path};

use crate::{error, regex, sys, trace_categories};

/// Represents a piece of a shell pattern.
#[derive(Clone, Debug)]
pub(crate) enum PatternPiece {
	/// A pattern that should be interpreted as a shell pattern.
	Pattern(String),
	/// A literal string that should be matched exactly.
	Literal(String),
}

impl PatternPiece {
	pub fn as_str(&self) -> &str {
		match self {
			Self::Pattern(s) => s,
			Self::Literal(s) => s,
		}
	}
}

type PatternWord = Vec<PatternPiece>;

fn component_string(components: &[PatternWord], index: usize) -> Option<String> {
	components
		.get(index)
		.map(|component| component.iter().map(|piece| piece.as_str()).collect())
}

/// Options for filename expansion.
#[derive(Clone, Debug, Default)]
pub(crate) struct FilenameExpansionOptions {
	pub require_dot_in_pattern_to_match_dot_files: bool,
}

/// Returns the `scheme://` root when the pattern's leading components spell a
/// virtual path (`scheme:` then an empty component, from splitting on `/`).
fn url_pattern_root(components: &[PatternWord]) -> Option<std::path::PathBuf> {
	let [first, second, ..] = components else {
		return None;
	};
	if !second.iter().all(|piece| piece.as_str().is_empty()) {
		return None;
	}
	let mut root: String = first.iter().map(|piece| piece.as_str()).collect();
	let scheme_len = root.strip_suffix(':')?.len();
	root.push_str("//");
	let root = std::path::PathBuf::from(root);
	(pi_vfs::url_scheme(&root).map(str::len) == Some(scheme_len)).then_some(root)
}

/// Result of a pattern expansion, distinguishing "no glob metacharacters" from
/// "glob expansion attempted but found no matches".
#[derive(Debug, Default)]
pub(crate) enum PatternExpansionResult {
	/// No glob metacharacters found; no expansion was attempted.
	#[default]
	NoGlob,
	/// Glob expansion was attempted. Contains matching paths (may be empty).
	Expanded(Vec<String>),
}

impl PatternExpansionResult {
	/// Returns the expansion results, regardless of variant.
	pub fn into_paths(self) -> Vec<String> {
		match self {
			Self::NoGlob => vec![],
			Self::Expanded(paths) => paths,
		}
	}

	/// Returns true if glob expansion was attempted but produced no results.
	pub const fn is_unmatched_glob(&self) -> bool {
		matches!(self, Self::Expanded(paths) if paths.is_empty())
	}
}

/// Encapsulates a shell pattern.
#[derive(Clone, Debug)]
pub struct Pattern {
	pieces:                   PatternWord,
	enable_extended_globbing: bool,
	multiline:                bool,
	case_insensitive:         bool,
}

impl Default for Pattern {
	fn default() -> Self {
		Self {
			pieces:                   vec![],
			enable_extended_globbing: false,
			multiline:                true,
			case_insensitive:         false,
		}
	}
}

impl From<PatternWord> for Pattern {
	fn from(pieces: PatternWord) -> Self {
		Self { pieces, ..Default::default() }
	}
}

impl From<&PatternWord> for Pattern {
	fn from(value: &PatternWord) -> Self {
		Self { pieces: value.clone(), ..Default::default() }
	}
}

impl From<&str> for Pattern {
	fn from(value: &str) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value.to_owned())], ..Default::default() }
	}
}

impl From<String> for Pattern {
	fn from(value: String) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value)], ..Default::default() }
	}
}

impl Pattern {
	/// Enables (or disables) extended globbing support for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable extended globbing (extglob).
	#[must_use]
	pub const fn set_extended_globbing(mut self, value: bool) -> Self {
		self.enable_extended_globbing = value;
		self
	}

	/// Enables (or disables) multiline support for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable multiline matching.
	#[must_use]
	pub const fn set_multiline(mut self, value: bool) -> Self {
		self.multiline = value;
		self
	}

	/// Enables (or disables) case-insensitive matching for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable case-insensitive matching.
	#[must_use]
	pub const fn set_case_insensitive(mut self, value: bool) -> Self {
		self.case_insensitive = value;
		self
	}

	/// Returns whether or not the pattern is empty.
	pub fn is_empty(&self) -> bool {
		self.pieces.iter().all(|p| p.as_str().is_empty())
	}

	/// Expands the pattern into a list of matching file paths, reading
	/// directories through `fs`. Patterns rooted at `scheme://` expand within
	/// that virtual namespace.
	///
	/// # Arguments
	///
	/// * `fs` - The filesystem to search.
	/// * `working_dir` - The current working directory, used for relative paths.
	/// * `options` - Expansion options.
	#[expect(clippy::too_many_lines)]
	pub(crate) async fn expand(
		&self,
		fs: &pi_vfs::Fs,
		working_dir: &Path,
		options: &FilenameExpansionOptions,
	) -> Result<PatternExpansionResult, error::Error> {
		// If the pattern has no pieces at all, short-circuit; there's nothing to
		// expand. Note: we intentionally do NOT short-circuit when pieces are present
		// but empty (e.g. from a quoted empty string ""); those fall through to the
		// literal branch below which correctly returns Expanded([""]) instead of
		// NoGlob, preserving the argument even when nullglob is enabled.
		if self.pieces.is_empty() {
			return Ok(PatternExpansionResult::NoGlob);

		// Similarly, if we're *confident* the pattern doesn't require expansion,
		// then we know there's a single expansion (before filtering).
		} else if !self.pieces.iter().any(|piece| {
			matches!(piece, PatternPiece::Pattern(_))
				&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
		}) {
			let concatenated: String = self.pieces.iter().map(|piece| piece.as_str()).collect();

			return Ok(PatternExpansionResult::Expanded(vec![concatenated]));
		}

		tracing::debug!(target: trace_categories::PATTERN, "expanding pattern: {self:?}");

		let mut components: Vec<PatternWord> = vec![];
		for piece in &self.pieces {
			let mut split_result: VecDeque<_> = sys::fs::split_path_for_pattern(piece.as_str())
				.map(|s| match piece {
					PatternPiece::Pattern(_) => PatternPiece::Pattern(s.to_owned()),
					PatternPiece::Literal(_) => PatternPiece::Literal(s.to_owned()),
				})
				.collect();

			if let Some(first_piece) = split_result.pop_front() {
				if let Some(last_component) = components.last_mut() {
					last_component.push(first_piece);
				} else {
					components.push(vec![first_piece]);
				}
			}

			while let Some(piece) = split_result.pop_front() {
				components.push(vec![piece]);
			}
		}

		// Check if the path appears to be absolute by inspecting the first components.
		// On Unix, a leading `/` produces an empty first component. On Windows, a
		// drive-letter prefix like `c:` is also recognized, and a forward-slash
		// MSYS/WSL drive alias (`/d/...`, `/mnt/d/...`) must be translated before
		// `read_dir()` sees the root.
		let starts_with_forward_slash = self
			.pieces
			.iter()
			.find_map(|piece| piece.as_str().as_bytes().first().copied())
			.is_some_and(|byte| byte == b'/');
		let first_component = component_string(&components, 0);
		let second_component = component_string(&components, 1);
		let third_component = component_string(&components, 2);
		let alias_root = first_component.as_deref().and_then(|first| {
			sys::fs::pattern_drive_alias_root(
				starts_with_forward_slash,
				first,
				second_component.as_deref(),
				third_component.as_deref(),
			)
		});
		let (absolute_root, components_to_remove) =
			if let Some(root) = url_pattern_root(&components) {
				// `scheme:` and the empty component between the two slashes.
				(Some(root), 2)
			} else if let Some((root, consumed)) = alias_root {
				(Some(root), consumed)
			} else {
				(
					first_component
						.as_deref()
						.and_then(sys::fs::pattern_path_root),
					1,
				)
			};

		let prefix_to_remove;
		let mut paths_so_far = if let Some(root) = absolute_root {
			prefix_to_remove = None;
			// Skip the component(s) consumed to determine the root.
			drop(components.drain(0..components_to_remove));
			vec![root]
		} else {
			// Build a prefix to remove after glob expansion so results are
			// returned relative to the working directory. The prefix is
			// normalized to use `/` separators because `push_path_for_pattern`
			// also uses `/` on Windows (to avoid `PathBuf::push` drive-letter
			// semantics) — if we left `\` here, the strip_prefix below would
			// miss on Windows and leave results as absolute paths.
			let working_dir_str = working_dir.to_string_lossy();
			let mut working_dir_str =
				sys::fs::normalize_path_separators(&working_dir_str).into_owned();
			if !working_dir_str.ends_with('/') {
				working_dir_str.push('/');
			}

			prefix_to_remove = Some(working_dir_str);
			vec![working_dir.to_path_buf()]
		};

		// URL spelling: an absolute `scheme://` pattern is already spelled
		// percent-encoded, while a relative pattern under a virtual working
		// directory names raw segments (encoded once when joined, decoded back
		// once in the results). Host paths keep their spelling untouched.
		let virtual_spelling = paths_so_far.first().is_some_and(|p| pi_vfs::is_virtual_path(p));
		let raw_relative = virtual_spelling && prefix_to_remove.is_some();
		let match_encoded = virtual_spelling && prefix_to_remove.is_none();

		for component in components {
			if !component.iter().any(|piece| {
				matches!(piece, PatternPiece::Pattern(_))
					&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
			}) {
				let flattened = component
					.iter()
					.map(|piece| piece.as_str())
					.collect::<String>();
				for p in &mut paths_so_far {
					if raw_relative {
						*p = pi_vfs::join_path(p, Path::new(&flattened));
					} else {
						sys::fs::push_path_for_pattern(p, &flattened);
					}
				}
				continue;
			}

			let current_paths = std::mem::take(&mut paths_so_far);
			for current_path in current_paths {
				let subpattern = Self::from(&component)
					.set_extended_globbing(self.enable_extended_globbing)
					.set_case_insensitive(self.case_insensitive);

				let subpattern_starts_with_dot = subpattern
					.pieces
					.first()
					.is_some_and(|piece| piece.as_str().starts_with('.'));

				let allow_dot_files =
					!options.require_dot_in_pattern_to_match_dot_files || subpattern_starts_with_dot;

				let regex = subpattern.to_regex(true, true)?;

				// Matches keep the pattern's spelling (`./`, `../`), but a virtual
				// provider is only asked to list a lexically normalized path.
				let listing = if fs.is_native_local(&current_path) {
					fs.read_dir(&current_path).await
				} else {
					fs.read_dir(pi_vfs::normalize_lexically(&current_path)).await
				};
				let mut matching_paths_in_dir: Vec<_> = match listing {
					Ok(entries) => entries
						.filter_map(Result::ok)
						.filter_map(|entry| {
							let file_name = entry.file_name();
							let name = file_name.to_string_lossy();
							if !allow_dot_files && name.starts_with('.') {
								return None;
							}
							// Raw names match as on any filesystem; a pattern
							// spelled as an absolute URL may also name the
							// encoded segment (`my%20*`).
							let matches = regex.is_match(name.as_ref()).unwrap_or(false)
								|| (match_encoded && {
									let encoded = pi_vfs::encode_segment(&file_name);
									matches!(encoded, std::borrow::Cow::Owned(_))
										&& regex.is_match(&encoded.to_string_lossy()).unwrap_or(false)
								});
							matches.then(|| pi_vfs::child_path(&current_path, &file_name))
						})
						.collect(),
					Err(_) => vec![],
				};

				matching_paths_in_dir.sort();

				paths_so_far.append(&mut matching_paths_in_dir);
			}
		}

		let results: Vec<_> = paths_so_far
			.into_iter()
			.map(|path| {
				// Normalize separators *before* stripping the working-dir
				// prefix so that `prefix_to_remove` (already normalized to
				// use `/`) matches paths that may contain a mix of `\` and
				// `/` on Windows.
				let path_str = path.to_string_lossy();
				let normalized = sys::fs::normalize_path_separators(&path_str);
				let mut path_ref: &str = normalized.as_ref();

				if let Some(prefix_to_remove) = &prefix_to_remove
					&& let Some(stripped) = path_ref.strip_prefix(prefix_to_remove.as_str())
				{
					path_ref = stripped;
				}

				if raw_relative {
					// Back to the raw relative spelling the user typed, so
					// resolving it against the virtual cwd encodes it once.
					return path_ref
						.split('/')
						.map(|segment| {
							pi_vfs::decode_segment(std::ffi::OsStr::new(segment))
								.to_string_lossy()
								.into_owned()
						})
						.collect::<Vec<_>>()
						.join("/");
				}

				path_ref.to_string()
			})
			.collect();

		tracing::debug!(target: trace_categories::PATTERN, "  => results: {results:?}");

		Ok(PatternExpansionResult::Expanded(results))
	}

	/// Converts the pattern to a regular expression string.
	///
	/// # Arguments
	///
	/// * `strict_prefix_match` - Whether or not the pattern should strictly
	///   match the beginning of the string.
	/// * `strict_suffix_match` - Whether or not the pattern should strictly
	///   match the end of the string.
	pub(crate) fn to_regex_str(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<String, error::Error> {
		let mut regex_str = String::new();

		if strict_prefix_match {
			regex_str.push('^');
		}

		let mut current_pattern = String::new();
		for piece in &self.pieces {
			match piece {
				PatternPiece::Pattern(s) => {
					current_pattern.push_str(s);
				},
				PatternPiece::Literal(s) => {
					for c in s.chars() {
						if crate::regex::regex_char_is_special(c) {
							current_pattern.push('\\');
						}
						current_pattern.push(c);
					}
				},
			}
		}

		let regex_piece =
			pattern_to_regex_str(current_pattern.as_str(), self.enable_extended_globbing)?;
		regex_str.push_str(regex_piece.as_str());

		if strict_suffix_match {
			regex_str.push('$');
		}

		Ok(regex_str)
	}

	/// Converts the pattern to a regular expression.
	///
	/// # Arguments
	///
	/// * `strict_prefix_match` - Whether or not the pattern should strictly
	///   match the beginning of the string.
	/// * `strict_suffix_match` - Whether or not the pattern should strictly
	///   match the end of the string.
	pub(crate) fn to_regex(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<fancy_regex::Regex, error::Error> {
		let regex_str = self.to_regex_str(strict_prefix_match, strict_suffix_match)?;

		tracing::debug!(target: trace_categories::PATTERN, "pattern: '{self:?}' => regex: '{regex_str}'");

		let re = regex::compile_regex(regex_str, self.case_insensitive, self.multiline)?;
		Ok(re)
	}

	/// Checks if the pattern exactly matches the given string. An error result
	/// is returned if the pattern is found to be invalid or malformed
	/// during processing.
	///
	/// # Arguments
	///
	/// * `value` - The string to check for a match.
	pub fn exactly_matches(&self, value: &str) -> Result<bool, error::Error> {
		let re = self.to_regex(true, true)?;
		Ok(re.is_match(value)?)
	}
}

/// Checks whether a string contains glob metacharacters that would trigger
/// pathname expansion. Delegates to the pattern parser's grammar, which is
/// the single source of truth for what constitutes a glob metacharacter.
fn requires_expansion(s: &str, enable_extended_globbing: bool) -> bool {
	brush_parser::pattern::pattern_has_glob_metacharacters(s, enable_extended_globbing)
}

fn pattern_to_regex_str(
	pattern: &str,
	enable_extended_globbing: bool,
) -> Result<String, error::Error> {
	Ok(brush_parser::pattern::pattern_to_regex_str(pattern, enable_extended_globbing)?)
}

/// Removes the largest matching prefix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the prefix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_largest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let indices = s.char_indices().rev();
		let mut last_idx = s.len();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in indices {
			let prefix = &s[0..last_idx];
			if re.is_match(prefix)? {
				return Ok(&s[last_idx..]);
			}

			last_idx = idx;
		}
	}
	Ok(s)
}

/// Removes the smallest matching prefix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the prefix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_smallest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let mut indices = s.char_indices();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		while indices.next().is_some() {
			let next_index = indices.offset();
			let prefix = &s[0..next_index];
			if re.is_match(prefix)? {
				return Ok(&s[next_index..]);
			}
		}
	}
	Ok(s)
}

/// Removes the largest matching suffix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the suffix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_largest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}

/// Removes the smallest matching suffix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the suffix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_smallest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices().rev() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}

#[cfg(test)]
#[expect(clippy::panic_in_result_fn)]
mod tests {
	use anyhow::Result;

	use super::*;

	fn pattern_to_exact_regex_str<P>(pattern: P) -> Result<String, error::Error>
	where
		P: Into<Pattern>,
	{
		let pattern: Pattern = pattern
			.into()
			.set_extended_globbing(true)
			.set_multiline(false);

		pattern.to_regex_str(true, true)
	}

	#[test]
	fn test_pattern_translation() -> Result<()> {
		assert_eq!(pattern_to_exact_regex_str("a")?.as_str(), "^a$");
		assert_eq!(pattern_to_exact_regex_str("a*")?.as_str(), "^a.*$");
		assert_eq!(pattern_to_exact_regex_str("a?")?.as_str(), "^a.$");
		assert_eq!(pattern_to_exact_regex_str("a@(b|c)")?.as_str(), "^a(b|c)$");
		assert_eq!(pattern_to_exact_regex_str("a?(b|c)")?.as_str(), "^a(b|c)?$");
		assert_eq!(pattern_to_exact_regex_str("a*(ab|ac)")?.as_str(), "^a(ab|ac)*$");
		assert_eq!(pattern_to_exact_regex_str("a+(ab|ac)")?.as_str(), "^a(ab|ac)+$");
		assert_eq!(pattern_to_exact_regex_str("[ab]")?.as_str(), "^[ab]$");
		assert_eq!(pattern_to_exact_regex_str("[ab]*")?.as_str(), "^[ab].*$");
		assert_eq!(pattern_to_exact_regex_str("[<{().[]*")?.as_str(), r"^[<{().\[].*$");
		assert_eq!(pattern_to_exact_regex_str("[a-d]")?.as_str(), "^[a-d]$");
		assert_eq!(pattern_to_exact_regex_str(r"\*")?.as_str(), r"^\*$");

		Ok(())
	}

	#[test]
	fn test_pattern_word_translation() -> Result<()> {
		assert_eq!(
			pattern_to_exact_regex_str(vec![PatternPiece::Pattern("a*".to_owned())])?.as_str(),
			"^a.*$"
		);
		assert_eq!(
			pattern_to_exact_regex_str(vec![
				PatternPiece::Pattern("a*".to_owned()),
				PatternPiece::Literal("b".to_owned()),
			])?
			.as_str(),
			"^a.*b$"
		);
		assert_eq!(
			pattern_to_exact_regex_str(vec![
				PatternPiece::Literal("a*".to_owned()),
				PatternPiece::Pattern("b".to_owned()),
			])?
			.as_str(),
			r"^a\*b$"
		);

		Ok(())
	}

	#[test]
	fn test_remove_largest_matching_prefix() -> Result<()> {
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("")))?, "ooof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("x")))?, "ooof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o")))?, "oof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o*o")))?, "f");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o*")))?, "");
		assert_eq!(
			remove_largest_matching_prefix("🚀🚀🚀rocket", Some(&Pattern::from("🚀")))?,
			"🚀🚀rocket"
		);
		Ok(())
	}

	#[test]
	fn test_remove_smallest_matching_prefix() -> Result<()> {
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("")))?, "ooof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("x")))?, "ooof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o")))?, "oof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o*o")))?, "of");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o*")))?, "oof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("ooof")))?, "");
		assert_eq!(
			remove_smallest_matching_prefix("🚀🚀🚀rocket", Some(&Pattern::from("🚀")))?,
			"🚀🚀rocket"
		);
		Ok(())
	}

	#[test]
	fn test_remove_largest_matching_suffix() -> Result<()> {
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("")))?, "foo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("x")))?, "foo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("o")))?, "fo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("o*")))?, "f");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("foo")))?, "");
		assert_eq!(
			remove_largest_matching_suffix("rocket🚀🚀🚀", Some(&Pattern::from("🚀")))?,
			"rocket🚀🚀"
		);
		Ok(())
	}

	#[test]
	fn test_remove_smallest_matching_suffix() -> Result<()> {
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("")))?, "fooo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("x")))?, "fooo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o")))?, "foo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o*o")))?, "fo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o*")))?, "foo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("fooo")))?, "");
		assert_eq!(
			remove_smallest_matching_suffix("rocket🚀🚀🚀", Some(&Pattern::from("🚀")))?,
			"rocket🚀🚀"
		);
		Ok(())
	}

	#[test]
	#[expect(clippy::cognitive_complexity)]
	fn test_matching() -> Result<()> {
		assert!(Pattern::from("abc").exactly_matches("abc")?);

		assert!(!Pattern::from("abc").exactly_matches("ABC")?);
		assert!(!Pattern::from("abc").exactly_matches("xabcx")?);
		assert!(!Pattern::from("abc").exactly_matches("")?);
		assert!(!Pattern::from("abc").exactly_matches("abcd")?);
		assert!(!Pattern::from("abc").exactly_matches("def")?);

		assert!(Pattern::from("*").exactly_matches("")?);
		assert!(Pattern::from("*").exactly_matches("abc")?);
		assert!(Pattern::from("*").exactly_matches(" ")?);

		assert!(Pattern::from("a*").exactly_matches("a")?);
		assert!(Pattern::from("a*").exactly_matches("ab")?);
		assert!(Pattern::from("a*").exactly_matches("a ")?);

		assert!(!Pattern::from("a*").exactly_matches("A")?);
		assert!(!Pattern::from("a*").exactly_matches("")?);
		assert!(!Pattern::from("a*").exactly_matches("bc")?);
		assert!(!Pattern::from("a*").exactly_matches("xax")?);
		assert!(!Pattern::from("a*").exactly_matches(" a")?);

		assert!(Pattern::from("*a").exactly_matches("a")?);
		assert!(Pattern::from("*a").exactly_matches("ba")?);
		assert!(Pattern::from("*a").exactly_matches("aa")?);
		assert!(Pattern::from("*a").exactly_matches(" a")?);

		assert!(!Pattern::from("*a").exactly_matches("BA")?);
		assert!(!Pattern::from("*a").exactly_matches("")?);
		assert!(!Pattern::from("*a").exactly_matches("ab")?);
		assert!(!Pattern::from("*a").exactly_matches("xax")?);

		Ok(())
	}

	fn make_extglob(s: &str) -> Pattern {
		let pattern = Pattern::from(s).set_extended_globbing(true);
		let regex_str = pattern.to_regex_str(true, true).unwrap();
		eprintln!("pattern: '{s}' => regex: '{regex_str}'");

		pattern
	}

	#[test]
	fn test_extglob_or_matching() -> Result<()> {
		assert!(make_extglob("@(a|b)").exactly_matches("a")?);
		assert!(make_extglob("@(a|b)").exactly_matches("b")?);

		assert!(!make_extglob("@(a|b)").exactly_matches("")?);
		assert!(!make_extglob("@(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("@(a|b)").exactly_matches("ab")?);

		assert!(!make_extglob("@(a|b)").exactly_matches("")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("ab")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("axb")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("b")?);

		assert!(!make_extglob("@(a*b|b)").exactly_matches("a")?);

		Ok(())
	}

	#[test]
	fn test_extglob_not_matching() -> Result<()> {
		// Basic cases.
		assert!(make_extglob("!(a)").exactly_matches("")?);
		assert!(make_extglob("!(a)").exactly_matches(" ")?);
		assert!(make_extglob("!(a)").exactly_matches("x")?);
		assert!(make_extglob("!(a)").exactly_matches(" a ")?);
		assert!(make_extglob("!(a)").exactly_matches("a ")?);
		assert!(make_extglob("!(a)").exactly_matches("aa")?);
		assert!(!make_extglob("!(a)").exactly_matches("a")?);

		assert!(make_extglob("a!(a)a").exactly_matches("aa")?);
		assert!(make_extglob("a!(a)a").exactly_matches("aaaa")?);
		assert!(make_extglob("a!(a)a").exactly_matches("aba")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("a")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("aaa")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("baaa")?);

		// Alternates.
		assert!(make_extglob("!(a|b)").exactly_matches("c")?);
		assert!(make_extglob("!(a|b)").exactly_matches("ab")?);
		assert!(make_extglob("!(a|b)").exactly_matches("aa")?);
		assert!(make_extglob("!(a|b)").exactly_matches("bb")?);
		assert!(!make_extglob("!(a|b)").exactly_matches("a")?);
		assert!(!make_extglob("!(a|b)").exactly_matches("b")?);

		Ok(())
	}

	#[test]
	fn test_extglob_advanced_not_matching() -> Result<()> {
		assert!(make_extglob("!(a*)").exactly_matches("b")?);
		assert!(make_extglob("!(a*)").exactly_matches("")?);
		assert!(!make_extglob("!(a*)").exactly_matches("a")?);
		assert!(!make_extglob("!(a*)").exactly_matches("abc")?);
		assert!(!make_extglob("!(a*)").exactly_matches("aabc")?);

		Ok(())
	}

	#[test]
	fn test_extglob_not_degenerate_matching() -> Result<()> {
		// Degenerate case.
		assert!(make_extglob("!()").exactly_matches("a")?);
		assert!(!make_extglob("!()").exactly_matches("")?);

		Ok(())
	}

	#[test]
	fn test_extglob_zero_or_more_matching() -> Result<()> {
		assert!(make_extglob("x*(a)x").exactly_matches("xx")?);
		assert!(make_extglob("x*(a)x").exactly_matches("xax")?);
		assert!(make_extglob("x*(a)x").exactly_matches("xaax")?);

		assert!(!make_extglob("x*(a)x").exactly_matches("x")?);
		assert!(!make_extglob("x*(a)x").exactly_matches("xa")?);
		assert!(!make_extglob("x*(a)x").exactly_matches("xxx")?);

		assert!(make_extglob("*(a|b)").exactly_matches("")?);
		assert!(make_extglob("*(a|b)").exactly_matches("a")?);
		assert!(make_extglob("*(a|b)").exactly_matches("b")?);
		assert!(make_extglob("*(a|b)").exactly_matches("aba")?);
		assert!(make_extglob("*(a|b)").exactly_matches("aaa")?);

		assert!(!make_extglob("*(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("*(a|b)").exactly_matches("ca")?);

		Ok(())
	}

	#[test]
	fn test_extglob_one_or_more_matching() -> Result<()> {
		fn make_extglob(s: &str) -> Pattern {
			Pattern::from(s).set_extended_globbing(true)
		}

		assert!(make_extglob("x+(a)x").exactly_matches("xax")?);
		assert!(make_extglob("x+(a)x").exactly_matches("xaax")?);

		assert!(!make_extglob("x+(a)x").exactly_matches("xx")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("x")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("xa")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("xxx")?);

		assert!(make_extglob("+(a|b)").exactly_matches("a")?);
		assert!(make_extglob("+(a|b)").exactly_matches("b")?);
		assert!(make_extglob("+(a|b)").exactly_matches("aba")?);
		assert!(make_extglob("+(a|b)").exactly_matches("aaa")?);

		assert!(!make_extglob("+(a|b)").exactly_matches("")?);
		assert!(!make_extglob("+(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("+(a|b)").exactly_matches("ca")?);

		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xaby")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xababy")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xabababy")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xabababyxabababyxabababy")?);

		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xy")?);
		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xay")?);
		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xyxy")?);

		Ok(())
	}

	#[test]
	fn test_requires_expansion() {
		// Delegates to the PEG grammar; thorough coverage is in brush-parser.
		// Here we just verify the integration works.
		assert!(requires_expansion("*", false));
		assert!(requires_expansion("[abc]", false));
		assert!(!requires_expansion("]", false));
		assert!(!requires_expansion("hello", false));
		assert!(!requires_expansion("@(a)", false));
		assert!(requires_expansion("@(a)", true));
	}

	/// Extracts the `Expanded` payload from a `PatternExpansionResult`,
	/// failing the test via `anyhow::bail!` otherwise. Avoids `panic!` which
	/// is forbidden by the workspace clippy config.
	fn expect_expanded(result: PatternExpansionResult) -> Result<Vec<String>> {
		let PatternExpansionResult::Expanded(paths) = result else {
			anyhow::bail!("expected Expanded, got {result:?}");
		};
		Ok(paths)
	}

	/// Regression test for the Windows prefix-strip mismatch fix.
	///
	/// On Windows (pre-fix), `expand` would build the `prefix_to_remove`
	/// using the platform `MAIN_SEPARATOR` (`\`) while `push_path_for_pattern`
	/// appended components with `/`. The resulting mismatch made the
	/// `strip_prefix` call a no-op, so relative globs produced absolute
	/// paths. This test exercises the expansion path and verifies results
	/// are returned relative to the working directory.
	///
	/// On Unix, the same code path is exercised (both builds go through the
	/// shared `normalize_path_separators` helpers), so this test serves as a
	/// regression guard on both platforms.
	#[tokio::test]
	async fn test_relative_glob_returns_relative_paths() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let sub = scratch.path().join("sub");
		std::fs::create_dir_all(&sub)?;
		std::fs::write(sub.join("a.txt"), "")?;
		std::fs::write(sub.join("b.txt"), "")?;

		let pattern = Pattern::from("sub/*.txt").set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), scratch.path(), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;

		let mut sorted = paths.clone();
		sorted.sort();
		assert_eq!(sorted, vec!["sub/a.txt".to_string(), "sub/b.txt".to_string()]);

		// None of the results should contain the absolute scratch path.
		let scratch_str: String = scratch.path().to_string_lossy().into_owned();
		for p in &paths {
			assert!(
				!p.contains(scratch_str.as_str()),
				"result {p:?} still contains absolute working-dir prefix {scratch_str:?}"
			);
		}

		Ok(())
	}

	/// Verifies absolute-pattern expansion still works after the prefix
	/// handling changes.
	#[tokio::test]
	async fn test_absolute_glob_returns_absolute_paths() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::write(scratch.path().join("one.log"), "")?;
		std::fs::write(scratch.path().join("two.log"), "")?;

		let abs_pattern = format!("{}/*.log", scratch.path().to_string_lossy());
		// Normalize to forward slashes so the test works consistently across
		// platforms; the expander's `pattern_path_root` handles both.
		let abs_pattern = abs_pattern.replace('\\', "/");

		let pattern = Pattern::from(abs_pattern.as_str()).set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), Path::new("/"), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;

		assert_eq!(paths.len(), 2, "unexpected results: {paths:?}");
		let scratch_normalized: String = scratch.path().to_string_lossy().replace('\\', "/");
		for p in &paths {
			// Use a plain byte-level suffix check rather than `Path::extension`
			// since the results are strings and clippy flags `ends_with(".log")`
			// as potentially case-sensitive. We explicitly wrote lowercase files.
			assert!(p.as_bytes().ends_with(b".log"), "unexpected result {p:?}");
			// Should still reference the scratch directory (i.e., absolute).
			assert!(
				p.contains(scratch_normalized.as_str()),
				"absolute result {p:?} should contain {scratch_normalized:?}"
			);
		}

		Ok(())
	}

	/// Serves a fixed `mem://` tree: `a.md`, `b.txt`, `.hidden.md`, and
	/// `dir/c.md`.
	#[derive(Debug)]
	struct MemListing;

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for MemListing {
		async fn open(
			&self,
			_path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> std::io::Result<pi_vfs::File> {
			Err(pi_vfs::unsupported("open"))
		}

		async fn metadata(&self, _path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			Err(std::io::ErrorKind::NotFound.into())
		}

		async fn read_dir(&self, path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			let names: &[&str] = match path.to_str() {
				Some("mem://") => &["a.md", "b.txt", ".hidden.md", "dir"],
				Some("mem://dir") => &["c.md"],
				_ => return Err(std::io::ErrorKind::NotFound.into()),
			};
			let entries: Vec<_> = names
				.iter()
				.map(|name| {
					Ok(pi_vfs::DirEntry::new(
						pi_vfs::child_path(path, std::ffi::OsStr::new(name)),
						(*name).into(),
						None,
					))
				})
				.collect();
			Ok(pi_vfs::ReadDir::from_entries(entries))
		}
	}

	/// A glob rooted at `scheme://` lists that virtual root instead of being
	/// read as a relative `scheme:` directory, and a relative glob in a
	/// virtual working directory keeps results relative to it.
	#[tokio::test]
	async fn test_globs_expand_within_virtual_namespaces() -> Result<()> {
		let fs = pi_vfs::Fs::new(std::sync::Arc::new(MemListing));
		let options = FilenameExpansionOptions { require_dot_in_pattern_to_match_dot_files: true };
		let expand = async |pattern: &str, cwd: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, Path::new(cwd), &options)
				.await?;
			expect_expanded(result)
		};

		assert_eq!(expand("mem://*.md", "/").await?, vec!["mem://a.md".to_string()]);
		assert_eq!(expand("mem://d*/*.md", "/").await?, vec!["mem://dir/c.md".to_string()]);
		assert_eq!(expand("*.md", "mem://dir").await?, vec!["c.md".to_string()]);
		assert_eq!(expand("mem://*.none", "/").await?, Vec::<String>::new());

		Ok(())
	}

	#[cfg(windows)]
	#[tokio::test]
	async fn test_msys_drive_alias_glob_expands_from_drive_root() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::write(scratch.path().join("one.txt"), "")?;
		std::fs::write(scratch.path().join("two.txt"), "")?;

		let scratch_normalized = scratch.path().to_string_lossy().replace('\\', "/");
		let Some((drive, tail)) = scratch_normalized.split_once(":/") else {
			anyhow::bail!("expected drive-qualified temp path, got {scratch_normalized:?}");
		};
		let alias_pattern = format!("/{}/{}/*.txt", drive.to_ascii_lowercase(), tail);

		let pattern = Pattern::from(alias_pattern.as_str()).set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), Path::new("/"), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;
		assert_eq!(paths.len(), 2, "unexpected results: {paths:?}");
		for p in &paths {
			assert!(
				p.contains(scratch_normalized.as_str()),
				"alias result {p:?} should contain native scratch path {scratch_normalized:?}"
			);
		}

		Ok(())
	}
}
