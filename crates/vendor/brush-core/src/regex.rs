#![allow(clippy::needless_pass_by_value)]

use std::{borrow::Cow, cell::RefCell};

use cached::Cached;

use crate::{ExecutionParameters, commands, error, interp};

/// Where each capture group of `value` lies, if `pattern` matches it.
type CaptureRanges = Option<Vec<Option<std::ops::Range<usize>>>>;

thread_local! {
	 static REGEX_CACHE: RefCell<cached::SizedCache<(String, bool, bool), fancy_regex::Regex>> =
		  RefCell::new(cached::SizedCache::with_size(64));
}

/// Represents a piece of a regular expression.
#[derive(Clone, Debug)]
pub(crate) enum RegexPiece {
	/// A pattern that should be interpreted as a regular expression.
	Pattern(String),
	/// A literal string that should be matched exactly.
	Literal(String),
}

impl RegexPiece {
	fn to_regex_str(&self) -> Cow<'_, str> {
		match self {
			Self::Pattern(s) => Cow::Borrowed(s.as_str()),
			Self::Literal(s) => escape_literal_regex_piece(s.as_str()),
		}
	}

	/// How many bytes of the piece the pattern is built from. Escaping a
	/// literal only ever adds to that, never takes away.
	fn source_len(&self) -> usize {
		match self {
			Self::Pattern(s) | Self::Literal(s) => s.len(),
		}
	}
}

type RegexWord = Vec<RegexPiece>;

/// Encapsulates a regular expression usable in the shell.
#[derive(Clone, Debug)]
pub struct Regex {
	pieces:           RegexWord,
	case_insensitive: bool,
	multiline:        bool,
}

impl From<RegexWord> for Regex {
	fn from(pieces: RegexWord) -> Self {
		Self { pieces, case_insensitive: false, multiline: false }
	}
}

impl Regex {
	/// Sets the regular expression's case sensitivity.
	///
	/// # Arguments
	///
	/// * `value` - The new case sensitivity value.
	pub const fn set_case_insensitive(mut self, value: bool) -> Self {
		self.case_insensitive = value;
		self
	}

	/// Enables (or disables) multiline support for this pattern.
	/// This enables matching across lines as well as enables `.`
	/// to match newline characters.
	///
	/// # Arguments
	///
	/// * `value` - The new multiline value.
	pub const fn set_multiline(mut self, value: bool) -> Self {
		self.multiline = value;
		self
	}

	/// Computes if the regular expression matches the given string.
	///
	/// # Arguments
	///
	/// * `params` - The execution parameters of the run being matched.
	/// * `value` - The string to check for a match.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled while
	/// the pattern is being built or the groups copied out.
	pub async fn matches(
		&self,
		params: &ExecutionParameters,
		value: String,
	) -> Result<Option<Vec<Option<String>>>, error::Error> {
		let regex_pattern = self.to_regex_pattern(params).await?;
		let (case_insensitive, multiline) = (self.case_insensitive, self.multiline);

		// Compiling and matching are each one call into the regex engine, with
		// nothing inside that can yield: `[[ $huge =~ ^(h*)$ ]]` on a 64 MiB
		// subject held the worker for 340 ms in them. A pattern and subject
		// within one stride between them are matched where they are, which is
		// every match a script spells out; anything longer is matched on a
		// blocking worker, unless this is one already (see
		// [`commands::builtin_on_blocking_worker`]).
		let (value, groups) = if value.len().saturating_add(regex_pattern.len())
			<= interp::DIVIDE_COPY_ABOVE_BYTES
			|| commands::builtin_on_blocking_worker()
		{
			let groups = capture_ranges(regex_pattern, case_insensitive, multiline, &value)?;
			(value, groups)
		} else {
			let matched = tokio::task::spawn_blocking(move || {
				let groups = capture_ranges(regex_pattern, case_insensitive, multiline, &value);
				(value, groups)
			})
			.await;
			match matched {
				Ok((value, groups)) => (value, groups?),
				Err(join_error) if join_error.is_panic() => {
					std::panic::resume_unwind(join_error.into_panic())
				},
				Err(join_error) => return Err(error::ErrorKind::ThreadingError(join_error).into()),
			}
		};
		let Some(groups) = groups else {
			return Ok(None);
		};

		// Every group is a slice of the subject, and the first is the whole
		// match, so copying them out is as long as the subject however short
		// the pattern is. This is the construction behind `BASH_REMATCH`: the
		// assignment that follows is divided already, and before this the whole
		// of it was one step.
		let mut copies = Vec::with_capacity(groups.len());
		let mut budget = interp::ElementBudget::new();
		for group in groups {
			let matched = group.map(|range| &value[range]);
			let due = budget.charge(matched.map_or(0, str::len));
			if due > 0 {
				interp::loop_checkpoints(params, due).await?;
			}
			copies.push(match matched {
				Some(text) if text.len() > interp::DIVIDE_COPY_ABOVE_BYTES => {
					Some(interp::clone_in_strides(params, text).await?)
				},
				Some(text) => Some(text.to_owned()),
				None => None,
			});
		}

		Ok(Some(copies))
	}

	/// Builds the pattern to compile out of the pieces the expansion left.
	///
	/// The test is made on the pieces, before any of them is written out: a
	/// pattern a variable sized is built again on every match, and the escape
	/// pass that builds it is the construction, not the write.
	async fn to_regex_pattern(
		&self,
		params: &ExecutionParameters,
	) -> Result<String, error::Error> {
		let source_len: usize = self.pieces.iter().map(RegexPiece::source_len).sum();
		if source_len <= interp::DIVIDE_COPY_ABOVE_BYTES {
			return Ok(self.pieces.iter().map(|piece| piece.to_regex_str()).collect());
		}

		let mut pattern = String::with_capacity(source_len);
		let mut budget = interp::ElementBudget::new();
		for piece in &self.pieces {
			let due = budget.charge(piece.source_len());
			if due > 0 {
				interp::loop_checkpoints(params, due).await?;
			}
			match piece {
				RegexPiece::Pattern(s) if s.len() > interp::DIVIDE_COPY_ABOVE_BYTES => {
					interp::push_str_in_strides(params, &mut pattern, s.as_str()).await?;
				},
				RegexPiece::Literal(s) if s.len() > interp::DIVIDE_COPY_ABOVE_BYTES => {
					push_escaped_literal_in_strides(params, &mut pattern, s.as_str()).await?;
				},
				piece => pattern.push_str(piece.to_regex_str().as_ref()),
			}
		}

		Ok(pattern)
	}
}

/// Escapes a literal piece onto the end of `out`, spending a checkpoint before
/// each stride of it.
///
/// Escaping reads one character and writes one or two, with nothing carried
/// from one character to the next, so a stride that ends on a character
/// boundary escapes to exactly what the whole piece would have.
async fn push_escaped_literal_in_strides(
	params: &ExecutionParameters,
	out: &mut String,
	s: &str,
) -> Result<(), error::Error> {
	out.reserve(s.len());
	let mut rest = s;
	loop {
		interp::stride_checkpoint(params).await?;
		let mut end = rest.len().min(interp::BYTE_CHECKPOINT_STRIDE);
		// A stride lands mid-character at most three bytes in.
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		for c in piece.chars() {
			if regex_char_is_special(c) {
				out.push('\\');
			}
			out.push(c);
		}
		if remaining.is_empty() {
			return Ok(());
		}
		rest = remaining;
	}
}

/// Compiles `pattern` and finds where its capture groups lie in `value`: the
/// part of a match that is one call into the regex engine.
fn capture_ranges(
	pattern: String,
	case_insensitive: bool,
	multiline: bool,
	value: &str,
) -> Result<CaptureRanges, error::Error> {
	let re = compile_regex(pattern, case_insensitive, multiline)?;
	let Some(captures) = re.captures(value)? else {
		return Ok(None);
	};
	Ok(Some(captures.iter().map(|group| group.map(|m| m.range())).collect()))
}

pub(crate) fn compile_regex(
	regex_str: String,
	case_insensitive: bool,
	multiline: bool,
) -> Result<fancy_regex::Regex, error::Error> {
	// Move regex_str into the key to avoid cloning on cache-hit path.
	let key = (regex_str, case_insensitive, multiline);

	let cached_regex = REGEX_CACHE.with(|cache| cache.borrow_mut().cache_get(&key).cloned());
	if let Some(re) = cached_regex {
		return Ok(re);
	}

	// Handle identified cases where a shell-supported regex isn't supported
	// directly by `fancy_regex` -- specifically, adding missing escape characters.
	let mut regex_str = add_missing_escape_chars_to_regex(key.0.as_str());

	// Handle multiline enablement.
	if multiline {
		// The fancy_regex crate internally seems to have flags that can be used
		// to enable multiline support, but they're not exposed via its
		// RegexBuilder. We instead just prefix with the right flags.
		let updated_str = std::format!("(?ms){regex_str}");
		regex_str = updated_str.into();
	}

	let mut builder = fancy_regex::RegexBuilder::new(regex_str.as_ref());
	builder.case_insensitive(case_insensitive);

	let re = match builder.build() {
		Ok(re) => re,
		Err(e) => return Err(error::ErrorKind::InvalidRegexError(e, regex_str.to_string()).into()),
	};

	// Release borrow on key.0 before moving key into cache_set.
	drop(regex_str);

	REGEX_CACHE.with(|cache| {
		cache.borrow_mut().cache_set(key, re.clone());
	});

	Ok(re)
}

fn add_missing_escape_chars_to_regex(s: &str) -> Cow<'_, str> {
	// We may see a character class with an unescaped '[' (open bracket) character.
	// We need to escape that character.
	let mut in_escape = false;
	let mut in_brackets = false;
	let mut insertion_positions = vec![];

	let mut peekable = s.char_indices().peekable();
	while let Some((byte_offset, c)) = peekable.next() {
		let next_is_colon = peekable.peek().is_some_and(|(_, c)| *c == ':');

		match c {
			'[' if !in_escape && !in_brackets => {
				in_brackets = true;
			},
			'[' if !in_escape && in_brackets && !next_is_colon => {
				// Need to escape.
				insertion_positions.push(byte_offset);
			},
			']' if !in_escape && in_brackets => {
				in_brackets = false;
			},
			_ => (),
		}

		in_escape = !in_escape && c == '\\';
	}

	if insertion_positions.is_empty() {
		return s.into();
	}

	let mut updated = s.to_owned();
	for pos in insertion_positions.iter().rev() {
		updated.insert(*pos, '\\');
	}

	updated.into()
}

fn escape_literal_regex_piece(s: &str) -> Cow<'_, str> {
	let mut result = String::new();

	for c in s.chars() {
		match c {
			c if regex_char_is_special(c) => {
				result.push('\\');
				result.push(c);
			},
			c => result.push(c),
		}
	}

	result.into()
}

pub(crate) const fn regex_char_is_special(c: char) -> bool {
	matches!(c, '\\' | '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}')
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_add_missing_escape_chars_to_regex() {
		// Negative cases -- where we don't need to escape.
		assert_eq!(add_missing_escape_chars_to_regex("a[b]"), "a[b]");
		assert_eq!(add_missing_escape_chars_to_regex(r"a\[b\]"), r"a\[b\]");
		assert_eq!(add_missing_escape_chars_to_regex(r"a[b\[]"), r"a[b\[]");

		// Positive case -- where we need to escape.
		assert_eq!(add_missing_escape_chars_to_regex(r"a[b[]"), r"a[b\[]");
		assert_eq!(add_missing_escape_chars_to_regex(r"a[[]"), r"a[\[]");
	}

	/// Copying the groups out of a match has to see the run's cancellation:
	/// the first group is the whole match, and on a subject of 64 MiB that is
	/// 64 MiB copied in one step.
	#[tokio::test]
	async fn copying_the_groups_sees_the_run_cancellation() -> anyhow::Result<()> {
		let mut params = ExecutionParameters::default();
		let cancel = tokio_util::sync::CancellationToken::new();
		params.set_cancel_token(cancel.clone());
		cancel.cancel();

		let regex = Regex::from(vec![RegexPiece::Pattern(String::from("(x+)"))]);
		let err = regex
			.matches(&params, String::from("xxx"))
			.await
			.expect_err("the match ignored the cancellation");
		assert!(matches!(err.kind(), error::ErrorKind::Interrupted), "unexpected error: {err}");

		Ok(())
	}

	/// Escaping a literal piece in strides escapes it to what escaping it in
	/// one step would have: the characters either side of a stride boundary
	/// are escaped on their own, and a boundary never lands inside one.
	#[tokio::test]
	async fn escaping_a_long_literal_in_strides_gives_the_same_pattern() -> anyhow::Result<()> {
		let params = ExecutionParameters::default();

		// Multi-byte, so that a stride boundary falls inside a character.
		let literal = "a.bé*".repeat(20_000);
		let regex = Regex::from(vec![RegexPiece::Literal(literal)]);

		let plain: String = regex
			.pieces
			.iter()
			.map(|piece| piece.to_regex_str())
			.collect();
		assert_eq!(regex.to_regex_pattern(&params).await?, plain);

		Ok(())
	}

	/// A group as long as the subject comes back whole from the divided copy.
	#[tokio::test]
	async fn a_long_group_comes_back_whole() -> anyhow::Result<()> {
		let params = ExecutionParameters::default();

		let subject = "x".repeat(interp::DIVIDE_COPY_ABOVE_BYTES * 2);
		let regex = Regex::from(vec![RegexPiece::Pattern(String::from("^(x+)$"))]);

		let groups = regex
			.matches(&params, subject.clone())
			.await?
			.expect("the subject did not match");
		assert_eq!(groups.len(), 2);
		assert_eq!(groups[1].as_deref(), Some(subject.as_str()));

		Ok(())
	}
}
