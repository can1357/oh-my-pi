//! Word expansion utilities.

use std::{borrow::Cow, cmp::min, io::Write as _};

use brush_parser::word::{ParameterTransformOp, SubstringMatchKind};
use itertools::Itertools;

use crate::{
	ExecutionParameters, arithmetic,
	arithmetic::ExpandAndEvaluate,
	braceexpansion, commands, env, error, escape, extensions, patterns, prompt,
	shell::Shell,
	sys, trace_categories,
	variables::{self, ShellValue, ShellValueUnsetType, ShellVariable},
};

/// Options to customize the behavior of the word expander.
pub(crate) struct ExpanderOptions {
	/// Whether to perform tilde-expansion.
	pub tilde_expand:                  bool,
	/// Whether to perform brace-expansion.
	pub brace_expand:                  bool,
	/// Whether to perform command substitutions. If disabled, command
	/// substitutions are replaced with an empty string.
	pub execute_command_substitutions: bool,
	/// Whether to perform pathname expansion (globbing). If disabled, glob
	/// patterns are returned as literal strings.
	pub pathname_expand:               bool,
}

impl Default for ExpanderOptions {
	fn default() -> Self {
		Self {
			tilde_expand:                  true,
			brace_expand:                  true,
			execute_command_substitutions: true,
			pathname_expand:               true,
		}
	}
}

#[derive(Debug)]
struct Expansion {
	fields:      Vec<WordField>,
	concatenate: bool,
	from_array:  bool,
	undefined:   bool,
}

impl Default for Expansion {
	fn default() -> Self {
		Self { fields: vec![], concatenate: true, from_array: false, undefined: false }
	}
}

impl From<Expansion> for String {
	fn from(value: Expansion) -> Self {
		// TODO(IFS): Use IFS instead for separator?
		value.fields.into_iter().map(Self::from).join(" ")
	}
}

impl From<String> for Expansion {
	fn from(value: String) -> Self {
		Self { fields: vec![WordField::from(value)], ..Self::default() }
	}
}

impl From<ExpansionPiece> for Expansion {
	fn from(piece: ExpansionPiece) -> Self {
		Self { fields: vec![WordField::from(piece)], ..Self::default() }
	}
}

impl Expansion {
	fn classify(&self) -> ParameterState {
		let non_empty = self
			.fields
			.iter()
			.any(|field| field.0.iter().any(|piece| !piece.as_str().is_empty()));

		if self.undefined {
			ParameterState::Undefined
		} else if non_empty {
			ParameterState::NonZeroLength
		} else {
			ParameterState::DefinedEmptyString
		}
	}

	fn undefined() -> Self {
		Self {
			fields:      vec![WordField::from(String::new())],
			concatenate: true,
			undefined:   true,
			from_array:  false,
		}
	}

	fn polymorphic_len(&self) -> usize {
		if self.from_array {
			self.fields.len()
		} else {
			self.fields.iter().fold(0, |acc, field| acc + field.len())
		}
	}

	fn polymorphic_subslice(&self, index: usize, end: usize) -> Self {
		let len = end - index;

		// If we came from an array, then interpret `index` and `end` as indices
		// into the elements.
		if self.from_array {
			let actual_len = min(len, self.fields.len() - index);
			let fields = self.fields[index..(index + actual_len)].to_vec();

			Self {
				fields,
				concatenate: self.concatenate,
				undefined: self.undefined,
				from_array: self.from_array,
			}
		} else {
			// Otherwise, interpret `index` and `end` as indices into the string contents.
			let mut fields = vec![];

			// Keep track of how far away the interesting data is from the current read
			// offset.
			let mut dist_to_slice = index;
			// Keep track of how many characters are left to be copied.
			let mut left = len;

			// Go through fields, copying the interesting parts.
			for field in &self.fields {
				let mut pieces = vec![];

				for piece in &field.0 {
					// Stop once we've extracted enough characters.
					if left == 0 {
						break;
					}

					// Get the inner string of the piece, and figure out how many
					// characters are in it; make sure to get the *character count*
					// and not just call `.len()` to get the byte count.
					let piece_str = piece.as_str();
					let piece_char_count = piece_str.chars().count();

					// If the interesting data isn't even in this piece yet, then
					// continue until we find it.
					if dist_to_slice >= piece_char_count {
						dist_to_slice -= piece_char_count;
						continue;
					}

					// Figure out how far into this piece we're interested in copying.
					let desired_offset_into_this_piece = dist_to_slice;
					// Figure out how many characters we're going to use from *this* piece.
					let len_from_this_piece =
						min(left, piece_char_count - desired_offset_into_this_piece);

					let new_piece = match piece {
						ExpansionPiece::Unsplittable(s) => ExpansionPiece::Unsplittable(
							s.chars()
								.skip(desired_offset_into_this_piece)
								.take(len_from_this_piece)
								.collect(),
						),
						ExpansionPiece::Splittable(s) => ExpansionPiece::Splittable(
							s.chars()
								.skip(desired_offset_into_this_piece)
								.take(len_from_this_piece)
								.collect(),
						),
					};

					pieces.push(new_piece);

					left -= len_from_this_piece;
					dist_to_slice = 0;
				}

				if !pieces.is_empty() {
					fields.push(WordField(pieces));
				}
			}

			Self {
				fields,
				concatenate: self.concatenate,
				undefined: self.undefined,
				from_array: self.from_array,
			}
		}
	}
}

#[derive(Clone, Debug, Default, PartialEq)]
struct WordField(Vec<ExpansionPiece>);

impl WordField {
	pub const fn new() -> Self {
		Self(vec![])
	}

	pub fn len(&self) -> usize {
		self.0.iter().fold(0, |acc, piece| acc + piece.len())
	}
}

impl From<WordField> for String {
	fn from(field: WordField) -> Self {
		field.0.into_iter().map(Self::from).collect()
	}
}

impl From<WordField> for patterns::Pattern {
	fn from(value: WordField) -> Self {
		let pieces: Vec<_> = value
			.0
			.into_iter()
			.map(patterns::PatternPiece::from)
			.collect();

		Self::from(pieces)
	}
}

impl From<ExpansionPiece> for WordField {
	fn from(piece: ExpansionPiece) -> Self {
		Self(vec![piece])
	}
}

impl From<String> for WordField {
	fn from(value: String) -> Self {
		Self(vec![ExpansionPiece::Splittable(value)])
	}
}

#[derive(Clone, Debug, PartialEq)]
enum ExpansionPiece {
	Unsplittable(String),
	Splittable(String),
}

impl From<ExpansionPiece> for String {
	fn from(piece: ExpansionPiece) -> Self {
		match piece {
			ExpansionPiece::Unsplittable(s) => s,
			ExpansionPiece::Splittable(s) => s,
		}
	}
}

impl From<ExpansionPiece> for patterns::PatternPiece {
	fn from(piece: ExpansionPiece) -> Self {
		match piece {
			ExpansionPiece::Unsplittable(s) => Self::Literal(s),
			ExpansionPiece::Splittable(s) => Self::Pattern(s),
		}
	}
}

impl From<ExpansionPiece> for crate::regex::RegexPiece {
	fn from(piece: ExpansionPiece) -> Self {
		match piece {
			ExpansionPiece::Unsplittable(s) => Self::Literal(s),
			ExpansionPiece::Splittable(s) => Self::Pattern(s),
		}
	}
}

impl ExpansionPiece {
	const fn as_str(&self) -> &str {
		match self {
			Self::Unsplittable(s) => s.as_str(),
			Self::Splittable(s) => s.as_str(),
		}
	}

	const fn len(&self) -> usize {
		match self {
			Self::Unsplittable(s) => s.len(),
			Self::Splittable(s) => s.len(),
		}
	}

	fn make_unsplittable(self) -> Self {
		match self {
			Self::Unsplittable(_) => self,
			Self::Splittable(s) => Self::Unsplittable(s),
		}
	}
}

enum ParameterState {
	Undefined,
	DefinedEmptyString,
	NonZeroLength,
}

/// Applies all basic expansion to the given word, yielding a pattern.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn basic_expand_pattern(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<patterns::Pattern, error::Error> {
	let mut expander = WordExpander::new(shell, params);

	// When expanding patterns, we do not want backslash removal to occur in
	// unquoted contexts, as that would interfere with pattern syntax.
	expander.disable_unquoted_backslash_removal = true;

	expander.basic_expand_pattern(word_str.as_ref()).await
}

/// Applies all basic expansion to the given word, yielding a regex.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn basic_expand_regex(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<crate::regex::Regex, error::Error> {
	let mut expander = WordExpander::new(shell, params);

	// Brace expansion does not appear to be used in regexes.
	expander.disable_brace_expansion = true;

	expander.basic_expand_regex(word_str.as_ref()).await
}

/// Applies all basic expansion to the given word (represented as a string).
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn basic_expand_word(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<String, error::Error> {
	let mut expander = WordExpander::new(shell, params);
	expander.basic_expand_to_str(word_str.as_ref()).await
}

/// Expands a heredoc body.
///
/// Performs parameter expansion, command substitution, and arithmetic expansion
/// on the heredoc content while preserving literal quote characters. Unlike
/// [`basic_expand_word`], this treats `"` and `'` as literal characters rather
/// than quote delimiters.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The heredoc body to expand, as a string.
pub(crate) async fn basic_expand_heredoc_word(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<String, error::Error> {
	let mut expander = WordExpander::new(shell, params);
	expander.heredoc_mode = true;
	expander.disable_brace_expansion = true;
	expander.basic_expand_to_str(word_str.as_ref()).await
}

/// Applies all basic expansion to the given word (represented as a string),
/// with custom expander options.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn basic_expand_word_with_options(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
	options: &ExpanderOptions,
) -> Result<String, error::Error> {
	let mut expander = WordExpander::new_from_options(shell, params, options);
	expander.basic_expand_to_str(word_str.as_ref()).await
}

/// Apply tilde-expansion, parameter expansion, command substitution, and
/// arithmetic expansion; then perform field splitting and pathname expansion on
/// the result.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn full_expand_and_split_word(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<Vec<String>, error::Error> {
	let mut expander = WordExpander::new(shell, params);
	expander.full_expand_with_splitting(word_str.as_ref()).await
}

/// Apply tilde-expansion, parameter expansion, command substitution, and
/// arithmetic expansion; then perform field splitting and pathname expansion on
/// the result.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
/// * `options` - Options to customize the behavior of the expander.
pub(crate) async fn full_expand_and_split_word_with_options(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
	options: &ExpanderOptions,
) -> Result<Vec<String>, error::Error> {
	let mut expander = WordExpander::new_from_options(shell, params, options);
	expander.full_expand_with_splitting(word_str.as_ref()).await
}

/// Expands a word in assignment context (enables tilde-after-colon expansion).
///
/// # Arguments
///
/// * `shell` - The shell in which to perform expansion.
/// * `params` - The execution parameters to use during expansion.
/// * `word_str` - The word to expand, as a string.
pub(crate) async fn basic_expand_assignment_word(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	word_str: impl AsRef<str>,
) -> Result<String, error::Error> {
	let mut expander = WordExpander::new(shell, params);
	expander.parser_options.tilde_expansion_after_colon = true;
	expander.basic_expand_to_str(word_str.as_ref()).await
}

/// Assigns a value to a named parameter.
///
/// # Arguments
///
/// * `shell` - The shell in which to perform the assignment.
/// * `params` - The execution parameters to use during the assignment.
/// * `name` - The name of the parameter to assign to. May be a variable name,
///   or a more complex, assignable parameter expression (e.g., an array
///   element).
/// * `value` - The value to assign to the parameter.
pub async fn assign_to_named_parameter(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	name: &str,
	value: String,
) -> Result<(), error::Error> {
	let parser_options = shell.parser_options();
	let mut expander = WordExpander::new(shell, params);
	let parameter = brush_parser::word::parse_parameter(name, &parser_options)?;
	expander.assign_to_parameter(&parameter, value).await
}

struct WordExpander<'a, SE: extensions::ShellExtensions> {
	/// The shell in which to perform expansion.
	shell: &'a mut Shell<SE>,
	/// The execution parameters to use during expansion.
	params: &'a ExecutionParameters,
	/// The parser options to use during expansion.
	parser_options: brush_parser::ParserOptions,
	/// Whether to disable brace expansion.
	disable_brace_expansion: bool,
	/// Whether to disable command substitutions.
	disable_command_substitutions: bool,
	/// Whether to disable backslash removal in unquoted contexts.
	disable_unquoted_backslash_removal: bool,
	/// Whether to disable pathname expansion (globbing).
	disable_pathname_expansion: bool,
	/// Whether we are currently expanding inside a double-quoted context.
	in_double_quotes: bool,
	/// Whether to use heredoc expansion semantics (literal quotes, no brace
	/// expansion).
	heredoc_mode: bool,
}

impl<'a, SE: extensions::ShellExtensions> WordExpander<'a, SE> {
	pub const fn new(shell: &'a mut Shell<SE>, params: &'a ExecutionParameters) -> Self {
		let parser_options = shell.parser_options();
		Self {
			shell,
			params,
			parser_options,
			disable_brace_expansion: false,
			disable_command_substitutions: false,
			disable_unquoted_backslash_removal: false,
			disable_pathname_expansion: false,
			in_double_quotes: false,
			heredoc_mode: false,
		}
	}

	pub const fn new_from_options(
		shell: &'a mut Shell<SE>,
		params: &'a ExecutionParameters,
		options: &ExpanderOptions,
	) -> Self {
		let mut parser_options = shell.parser_options();

		if !options.tilde_expand {
			parser_options.tilde_expansion_at_word_start = false;
			parser_options.tilde_expansion_after_colon = false;
		}

		Self {
			shell,
			params,
			parser_options,
			disable_brace_expansion: !options.brace_expand,
			disable_command_substitutions: !options.execute_command_substitutions,
			disable_unquoted_backslash_removal: false,
			disable_pathname_expansion: !options.pathname_expand,
			in_double_quotes: false,
			heredoc_mode: false,
		}
	}

	/// Apply tilde-expansion, parameter expansion, command substitution, and
	/// arithmetic expansion.
	pub async fn basic_expand_to_str(&mut self, word: &str) -> Result<String, error::Error> {
		Ok(String::from(self.basic_expand(word).await?))
	}

	async fn basic_expand_opt_pattern(
		&mut self,
		word: Option<String>,
	) -> Result<Option<patterns::Pattern>, error::Error> {
		if let Some(word) = word {
			let pattern = self
				.basic_expand_pattern(&word)
				.await?
				.set_extended_globbing(self.parser_options.enable_extended_globbing);

			Ok(Some(pattern))
		} else {
			Ok(None)
		}
	}

	async fn basic_expand_pattern(&mut self, word: &str) -> Result<patterns::Pattern, error::Error> {
		let expansion = self.basic_expand(word).await?;

		// TODO(IFS): Use IFS instead for separator?
		#[expect(unstable_name_collisions)]
		let pattern_pieces: Vec<_> = expansion
			.fields
			.into_iter()
			.map(|field| {
				field
					.0
					.into_iter()
					.map(patterns::PatternPiece::from)
					.collect::<Vec<_>>()
			})
			.intersperse(vec![patterns::PatternPiece::Literal(String::from(" "))])
			.flatten()
			.collect();

		let pattern = patterns::Pattern::from(pattern_pieces);

		Ok(pattern)
	}

	async fn basic_expand_regex(&mut self, word: &str) -> Result<crate::regex::Regex, error::Error> {
		let expansion = self.basic_expand(word).await?;

		// TODO(IFS): Use IFS instead for separator?
		#[expect(unstable_name_collisions)]
		let regex_pieces: Vec<_> = expansion
			.fields
			.into_iter()
			.map(|field| {
				field
					.0
					.into_iter()
					.map(crate::regex::RegexPiece::from)
					.collect::<Vec<_>>()
			})
			.intersperse(vec![crate::regex::RegexPiece::Literal(String::from(" "))])
			.flatten()
			.collect();

		Ok(crate::regex::Regex::from(regex_pieces)
			.set_case_insensitive(self.shell.options().case_insensitive_conditionals))
	}

	/// Apply tilde-expansion, parameter expansion, command substitution, and
	/// arithmetic expansion; yield pieces that could be further processed.
	async fn basic_expand(&mut self, word: &str) -> Result<Expansion, error::Error> {
		tracing::debug!(target: trace_categories::EXPANSION, "Basic expanding: '{word}'");

		// Quick short circuit to avoid more expensive parsing. The characters below are
		// understood to be the *only* ones indicative of *possible* expansion. There's
		// still a possibility no expansion needs to be done, but that's okay; we'll
		// still yield a correct result.
		let expansion_chars: &[char] = if self.heredoc_mode {
			// Heredoc bodies treat quotes as literal; only $, `, and \ trigger expansion.
			&['$', '`', '\\']
		} else {
			&['$', '`', '\\', '\'', '\"', '~', '{']
		};
		if !word.contains(expansion_chars) {
			return Ok(Expansion::from(ExpansionPiece::Splittable(word.to_owned())));
		}

		// Apply brace expansion first, before anything else (not applicable to heredoc
		// bodies).
		let brace_expanded = self.brace_expand_if_needed(word)?;
		if tracing::enabled!(target: trace_categories::EXPANSION, tracing::Level::DEBUG)
			&& brace_expanded != word
		{
			tracing::debug!(target: trace_categories::EXPANSION, "  => brace expanded to '{brace_expanded}'");
		}

		// Expand: tildes, parameters, command substitutions, arithmetic.
		let pieces = if self.heredoc_mode {
			// Heredoc mode only affects top-level parsing (literal quotes); recursive
			// expansion of parameter words (e.g., ${var:-"default"}) uses normal semantics.
			self.heredoc_mode = false;

			brush_parser::word::parse_heredoc(brace_expanded.as_ref(), &self.parser_options)?
		} else {
			brush_parser::word::parse(brace_expanded.as_ref(), &self.parser_options)?
		};

		let mut expansions = vec![];
		for piece in pieces {
			let piece_expansion = self.expand_word_piece(piece.piece).await?;
			expansions.push(piece_expansion);
		}

		let coalesced = coalesce_expansions(expansions);

		Ok(coalesced)
	}

	/// Expand a word used inside a parameter expansion (like the word in
	/// ${param:+word}). When we're already inside double-quotes, we preserve
	/// literal backslashes and quotes (except those escaped in ways valid in
	/// double-quotes) but still expand parameters, command substitutions, and
	/// arithmetic.
	async fn expand_parameter_word(&mut self, word: &str) -> Result<Expansion, error::Error> {
		if self.in_double_quotes {
			// When inside double-quotes, we need to parse the word with double-quote
			// semantics. If the word already starts with a double-quote, we need to
			// remove those quotes and expand what's inside with normal
			// (non-double-quote) semantics.
			if let Some(stripped) = word.strip_prefix('"')
				&& let Some(inner) = stripped.strip_suffix('"')
			{
				// Remove the surrounding double-quotes and expand the content normally
				// This requires us to temporarily clear in_double_quotes so the inner
				// content gets normal processing.
				let previously_in_double_quotes = self.in_double_quotes;
				self.in_double_quotes = false;

				// Now perform the expansion and make sure to restore the previous state,
				// even if the expansion fails.
				let result = self.basic_expand(inner).await;
				self.in_double_quotes = previously_in_double_quotes;

				result
			} else {
				// Not double-quoted - wrap in double-quotes to get double-quote parsing
				// semantics
				let wrapped = std::format!("\"{word}\"");
				self.basic_expand(&wrapped).await
			}
		} else {
			// When not inside double-quotes, perform normal expansion with quote removal
			self.basic_expand(word).await
		}
	}

	fn brace_expand_if_needed(&self, word: &'a str) -> Result<Cow<'a, str>, error::Error> {
		// We perform a non-authoritative check to see if the string *may* contain
		// braces to expand. There may be false positives, but must be no false
		// negatives.
		if self.disable_brace_expansion
			|| !self.shell.options().perform_brace_expansion
			|| !may_contain_braces_to_expand(word)
		{
			return Ok(word.into());
		}

		let parse_result = brush_parser::word::parse_brace_expansions(word, &self.parser_options);
		if parse_result.is_err() {
			tracing::error!("failed to parse for brace expansion: {parse_result:?}");
			return Ok(word.into());
		}

		let brace_expansion_pieces = parse_result?;
		let Some(brace_expansion_pieces) = brace_expansion_pieces else {
			return Ok(word.into());
		};

		tracing::debug!(target: trace_categories::EXPANSION, "Brace expansion pieces: {brace_expansion_pieces:?}");

		let result = braceexpansion::generate_and_combine_brace_expansions(brace_expansion_pieces)
			.into_iter()
			.map(|s| if s.is_empty() { "\"\"".into() } else { s })
			.join(" ");

		Ok(result.into())
	}

	/// Apply tilde-expansion, parameter expansion, command substitution, and
	/// arithmetic expansion; then perform field splitting and pathname
	/// expansion.
	pub async fn full_expand_with_splitting(
		&mut self,
		word: &str,
	) -> Result<Vec<String>, error::Error> {
		// Perform basic expansion first.
		let basic_expansion = self.basic_expand(word).await?;

		// Then split.
		let fields: Vec<WordField> = self.split_fields(basic_expansion);

		// Now expand pathnames if necessary. This also unquotes as a side effect.
		let mut result = Vec::new();
		for field in fields {
			if self.disable_pathname_expansion || self.shell.options().disable_filename_globbing {
				result.push(String::from(field));
			} else {
				result.extend(self.expand_pathnames_in_field(field)?);
			}
		}

		Ok(result)
	}

	fn split_fields(&self, expansion: Expansion) -> Vec<WordField> {
		let ifs = self.shell.ifs();

		let mut fields: Vec<WordField> = vec![];
		let mut current_field = WordField::new();

		// Go through the fields we have so far.
		for existing_field in expansion.fields {
			for piece in existing_field.0 {
				match piece {
					ExpansionPiece::Unsplittable(_) => current_field.0.push(piece),
					ExpansionPiece::Splittable(s) => {
						for c in s.chars() {
							if ifs.contains(c) {
								if !current_field.0.is_empty() {
									fields.push(std::mem::take(&mut current_field));
								}
							} else {
								match current_field.0.last_mut() {
									Some(ExpansionPiece::Splittable(last)) => last.push(c),
									Some(ExpansionPiece::Unsplittable(_)) | None => {
										current_field
											.0
											.push(ExpansionPiece::Splittable(c.to_string()));
									},
								}
							}
						}
					},
				}
			}

			if !current_field.0.is_empty() {
				fields.push(std::mem::take(&mut current_field));
			}
		}

		fields
	}

	fn expand_pathnames_in_field(&self, field: WordField) -> Result<Vec<String>, error::Error> {
		let pattern = patterns::Pattern::from(field.clone())
			.set_extended_globbing(self.parser_options.enable_extended_globbing)
			.set_case_insensitive(self.shell.options().case_insensitive_pathname_expansion);

		let options = patterns::FilenameExpansionOptions {
			require_dot_in_pattern_to_match_dot_files: !self.shell.options().glob_matches_dotfiles,
		};

		// On error (e.g. malformed pattern), default to NoGlob so the field
		// passes through as a literal rather than triggering failglob.
		let expansion = pattern
			.expand(
				self.shell.working_dir(),
				Some(&patterns::Pattern::accept_all_expand_filter),
				&options,
			)
			.unwrap_or_default();

		if expansion.is_unmatched_glob() && self.shell.options().fail_expansion_on_globs_without_match
		{
			let field_str = String::from(field);
			return Err(error::ErrorKind::NoMatch(field_str).into());
		}

		let paths = expansion.into_paths();
		if paths.is_empty() {
			if self.shell.options().expand_non_matching_patterns_to_null {
				Ok(vec![])
			} else {
				Ok(vec![String::from(field)])
			}
		} else {
			Ok(paths)
		}
	}

	#[async_recursion::async_recursion]
	async fn expand_word_piece(
		&mut self,
		word_piece: brush_parser::word::WordPiece,
	) -> Result<Expansion, error::Error> {
		let expansion: Expansion = match word_piece {
			brush_parser::word::WordPiece::Text(s) => Expansion::from(ExpansionPiece::Splittable(s)),
			brush_parser::word::WordPiece::SingleQuotedText(s) => {
				Expansion::from(ExpansionPiece::Unsplittable(s))
			},
			brush_parser::word::WordPiece::AnsiCQuotedText(s) => {
				let (expanded, _) = escape::expand_backslash_escapes(
					s.as_str(),
					escape::EscapeExpansionMode::AnsiCQuotes,
				)?;
				Expansion::from(ExpansionPiece::Unsplittable(
					String::from_utf8_lossy(expanded.as_slice()).into_owned(),
				))
			},
			brush_parser::word::WordPiece::DoubleQuotedSequence(pieces)
			| brush_parser::word::WordPiece::GettextDoubleQuotedSequence(pieces) => {
				let pieces_is_empty = pieces.is_empty();

				// Save the previous state and set the flag
				let previously_in_double_quotes = self.in_double_quotes;
				self.in_double_quotes = true;

				// Process pieces; don't inspect the result yet, so we can make
				// sure we restore the previous value of the 'in_double_quotes' flag.
				let result = self.process_double_quoted_pieces(pieces).await;

				// Restore the previous state
				self.in_double_quotes = previously_in_double_quotes;

				// Now we can inspect the result.
				let mut fields = result?;

				// If there were no pieces, then make sure we yield a single field containing an
				// empty, unsplittable string.
				if pieces_is_empty {
					fields.push(WordField::from(ExpansionPiece::Unsplittable(String::new())));
				}

				Expansion { fields, concatenate: false, undefined: false, from_array: false }
			},
			brush_parser::word::WordPiece::TildeExpansion(tilde_expr) => Expansion::from(
				ExpansionPiece::Unsplittable(self.expand_tilde_expression(&tilde_expr)?),
			),
			brush_parser::word::WordPiece::ParameterExpansion(p) => {
				self.expand_parameter_expr(p).await?
			},
			brush_parser::word::WordPiece::BackquotedCommandSubstitution(s)
			| brush_parser::word::WordPiece::CommandSubstitution(s) => {
				let mut cmd_output = if !self.disable_command_substitutions {
					commands::invoke_command_in_subshell_and_get_output(self.shell, self.params, s)
						.await?
				} else {
					String::new()
				};

				// Strips null bytes from command substitution output for compatibility.
				if cmd_output.contains('\0') {
					writeln!(
						self.params.stderr(self.shell),
						"warning: command substitution: ignored null byte in input",
					)?;
					cmd_output.retain(|c| c != '\0');
				}

				// We trim trailing newlines, per spec.
				let trimmed_len = cmd_output.trim_end_matches('\n').len();
				cmd_output.truncate(trimmed_len);

				Expansion::from(ExpansionPiece::Splittable(cmd_output))
			},
			brush_parser::word::WordPiece::EscapeSequence(s) => {
				if let Some(escaped) = s.strip_prefix('\\') {
					// If we are *not* in a double-quoted context and we were requested to skip
					// unquoted backslash removal, then we need to skip removing backslashes here.
					if !self.in_double_quotes && self.disable_unquoted_backslash_removal {
						return Ok(Expansion::from(ExpansionPiece::Splittable(s)));
					}

					// Otherwise, we expect a backslash here; remove it.
					Expansion::from(ExpansionPiece::Unsplittable(escaped.to_owned()))
				} else {
					// We don't ever expect this case, as it breaks our invariant--but
					// we handle it to avoid panicking.
					Expansion::from(ExpansionPiece::Unsplittable(s))
				}
			},
			brush_parser::word::WordPiece::ArithmeticExpression(e) => {
				Expansion::from(ExpansionPiece::Splittable(self.expand_arithmetic_expr(e).await?))
			},
		};

		Ok(expansion)
	}

	fn expand_tilde_expression(
		&self,
		tilde_expr: &brush_parser::word::TildeExpr,
	) -> Result<String, error::Error> {
		match tilde_expr {
			brush_parser::word::TildeExpr::Home => {
				if let Some(home_dir) = self.shell.home_dir() {
					Ok(home_dir.to_string_lossy().to_string())
				} else {
					Err(error::ErrorKind::TildeWithoutValidHome.into())
				}
			},
			brush_parser::word::TildeExpr::UserHome(username) => {
				Ok(sys::users::get_user_home_dir(username)
					.map_or_else(|| std::format!("~{username}"), |p| p.to_string_lossy().to_string()))
			},
			brush_parser::word::TildeExpr::WorkingDir => {
				Ok(self.shell.working_dir().to_string_lossy().to_string())
			},
			brush_parser::word::TildeExpr::OldWorkingDir => {
				if let Some(old_pwd) = self.shell.env_str("OLDPWD") {
					Ok(old_pwd.to_string())
				} else {
					Ok(String::from("~-"))
				}
			},
			brush_parser::word::TildeExpr::NthDirFromBottomOfDirStack { n } => {
				let dir_stack_count = self.shell.directory_stack().len();

				if let Some(dir) = self.shell.directory_stack().get(*n) {
					Ok(dir.to_string_lossy().to_string())
				} else if *n == dir_stack_count {
					Ok(self.shell.working_dir().to_string_lossy().to_string())
				} else {
					Ok(std::format!("~-{n}"))
				}
			},
			brush_parser::word::TildeExpr::NthDirFromTopOfDirStack { n, plus_used } => {
				if *n == 0 {
					return Ok(self.shell.working_dir().to_string_lossy().to_string());
				}

				let dir_stack_count = self.shell.directory_stack().len();
				if dir_stack_count >= *n
					&& let Some(dir) = self.shell.directory_stack().get(dir_stack_count - *n)
				{
					return Ok(dir.to_string_lossy().to_string());
				}

				let plus_or_nothing = if *plus_used { "+" } else { "" };
				Ok(std::format!("~{plus_or_nothing}{n}"))
			},
		}
	}

	/// Helper function to process pieces within a double-quoted sequence.
	/// This ensures proper handling of concatenation and field building.
	async fn process_double_quoted_pieces(
		&mut self,
		pieces: Vec<brush_parser::word::WordPieceWithSource>,
	) -> Result<Vec<WordField>, error::Error> {
		let mut fields: Vec<WordField> = vec![];
		let concatenation_joiner = self.shell.get_ifs_first_char();

		for piece in pieces {
			let Expansion { fields: this_fields, concatenate, .. } =
				self.expand_word_piece(piece.piece).await?;

			let fields_to_append = if concatenate {
				#[expect(unstable_name_collisions)]
				let mut concatenated: Vec<ExpansionPiece> = this_fields
					.into_iter()
					.map(|WordField(pieces)| {
						pieces
							.into_iter()
							.map(|piece| piece.make_unsplittable())
							.collect()
					})
					.intersperse(vec![ExpansionPiece::Unsplittable(concatenation_joiner.to_string())])
					.flatten()
					.collect();

				// If there were no pieces, make sure there's an empty string after
				// concatenation.
				if concatenated.is_empty() {
					concatenated.push(ExpansionPiece::Splittable(String::new()));
				}

				vec![WordField(concatenated)]
			} else {
				this_fields
			};

			for (i, WordField(next_pieces)) in fields_to_append.into_iter().enumerate() {
				// Flip to unsplittable.
				let mut next_pieces: Vec<_> = next_pieces
					.into_iter()
					.map(|piece| piece.make_unsplittable())
					.collect();

				if i == 0
					&& let Some(WordField(last_pieces)) = fields.last_mut()
				{
					last_pieces.append(&mut next_pieces);
					continue;
				}

				fields.push(WordField(next_pieces));
			}
		}

		Ok(fields)
	}

	#[expect(clippy::too_many_lines)]
	async fn expand_parameter_expr(
		&mut self,
		expr: brush_parser::word::ParameterExpr,
	) -> Result<Expansion, error::Error> {
		#[expect(clippy::cast_possible_truncation)]
		match expr {
			brush_parser::word::ParameterExpr::Parameter { parameter, indirect } => {
				self.expand_parameter(&parameter, indirect).await
			},
			brush_parser::word::ParameterExpr::UseDefaultValues {
				parameter,
				indirect,
				test_type,
				default_value,
			} => {
				let expanded_parameter = self
					.expand_parameter_allowing_unset(&parameter, indirect)
					.await?;
				let default_value = default_value.as_ref().map_or_else(|| "", |v| v.as_str());

				match (test_type, expanded_parameter.classify()) {
					(_, ParameterState::NonZeroLength)
					| (
						brush_parser::word::ParameterTestType::Unset,
						ParameterState::DefinedEmptyString,
					) => Ok(expanded_parameter),
					_ => Ok(self.expand_parameter_word(default_value).await?),
				}
			},
			brush_parser::word::ParameterExpr::AssignDefaultValues {
				parameter,
				indirect,
				test_type,
				default_value,
			} => {
				let expanded_parameter = self
					.expand_parameter_allowing_unset(&parameter, indirect)
					.await?;
				let default_value = default_value.as_ref().map_or_else(|| "", |v| v.as_str());

				match (test_type, expanded_parameter.classify()) {
					(_, ParameterState::NonZeroLength)
					| (
						brush_parser::word::ParameterTestType::Unset,
						ParameterState::DefinedEmptyString,
					) => Ok(expanded_parameter),
					_ => {
						let expanded_default_value =
							String::from(self.expand_parameter_word(default_value).await?);
						self
							.assign_to_parameter(&parameter, expanded_default_value.clone())
							.await?;
						Ok(Expansion::from(expanded_default_value))
					},
				}
			},
			brush_parser::word::ParameterExpr::IndicateErrorIfNullOrUnset {
				parameter,
				indirect,
				test_type,
				error_message,
			} => {
				let expanded_parameter = self
					.expand_parameter_allowing_unset(&parameter, indirect)
					.await?;
				let error_message = error_message.as_ref().map_or_else(|| "", |v| v.as_str());

				match (test_type, expanded_parameter.classify()) {
					(_, ParameterState::NonZeroLength)
					| (
						brush_parser::word::ParameterTestType::Unset,
						ParameterState::DefinedEmptyString,
					) => Ok(expanded_parameter),
					_ => {
						let result = self.basic_expand_to_str(error_message).await?;
						let err: error::Error = error::ErrorKind::CheckedExpansionError(result).into();

						// Expansion errors are fatal per POSIX spec
						Err(err.into_fatal())
					},
				}
			},
			brush_parser::word::ParameterExpr::UseAlternativeValue {
				parameter,
				indirect,
				test_type,
				alternative_value,
			} => {
				let expanded_parameter = self
					.expand_parameter_allowing_unset(&parameter, indirect)
					.await?;
				let alternative_value = alternative_value
					.as_ref()
					.map_or_else(|| "", |v| v.as_str());

				match (test_type, expanded_parameter.classify()) {
					(_, ParameterState::NonZeroLength)
					| (
						brush_parser::word::ParameterTestType::Unset,
						ParameterState::DefinedEmptyString,
					) => Ok(self.expand_parameter_word(alternative_value).await?),
					_ => Ok(Expansion::from(String::new())),
				}
			},
			brush_parser::word::ParameterExpr::ParameterLength { parameter, indirect } => {
				// In bash, ${#arr[i]} returns 0 for unset elements of a
				// declared array even with `set -u`. But ${#unset_var} still
				// errors. Allow unset only for array element/all-indices
				// access on variables that exist.
				let allow_unset = match &parameter {
					brush_parser::word::Parameter::NamedWithIndex { name, .. }
					| brush_parser::word::Parameter::NamedWithAllIndices { name, .. } => {
						self.shell.env().get(name).is_some()
					},
					_ => false,
				};
				let expansion = if allow_unset {
					self
						.expand_parameter_allowing_unset(&parameter, indirect)
						.await?
				} else {
					self.expand_parameter(&parameter, indirect).await?
				};
				Ok(Expansion::from(expansion.polymorphic_len().to_string()))
			},
			brush_parser::word::ParameterExpr::RemoveSmallestSuffixPattern {
				parameter,
				indirect,
				pattern,
			} => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;
				transform_expansion(expanded_parameter, async |s| {
					patterns::remove_smallest_matching_suffix(s.as_str(), expanded_pattern.as_ref())
						.map(|s| s.to_owned())
				})
				.await
			},
			brush_parser::word::ParameterExpr::RemoveLargestSuffixPattern {
				parameter,
				indirect,
				pattern,
			} => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;
				transform_expansion(expanded_parameter, async |s| {
					patterns::remove_largest_matching_suffix(s.as_str(), expanded_pattern.as_ref())
						.map(|s| s.to_owned())
				})
				.await
			},
			brush_parser::word::ParameterExpr::RemoveSmallestPrefixPattern {
				parameter,
				indirect,
				pattern,
			} => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					patterns::remove_smallest_matching_prefix(s.as_str(), expanded_pattern.as_ref())
						.map(|s| s.to_owned())
				})
				.await
			},
			brush_parser::word::ParameterExpr::RemoveLargestPrefixPattern {
				parameter,
				indirect,
				pattern,
			} => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					patterns::remove_largest_matching_prefix(s.as_str(), expanded_pattern.as_ref())
						.map(|s| s.to_owned())
				})
				.await
			},
			brush_parser::word::ParameterExpr::Substring { parameter, indirect, offset, length } => {
				let mut expanded_parameter = self.expand_parameter(&parameter, indirect).await?;

				// If this is ${@:...} then make sure $0 is in the array being sliced.
				if matches!(
					parameter,
					brush_parser::word::Parameter::Special(
						brush_parser::word::SpecialParameter::AllPositionalParameters { concatenate: _ },
					)
				) {
					let shell_name = self.shell.current_shell_name().unwrap_or_else(|| "".into());

					expanded_parameter
						.fields
						.insert(0, WordField::from(ExpansionPiece::Splittable(shell_name.to_string())));
				}

				#[expect(clippy::cast_possible_wrap)]
				let expanded_parameter_len = expanded_parameter.polymorphic_len() as i64;
				let mut expanded_offset = offset.eval(self.shell, self.params, false).await?;

				// We handle negative indexes as offsets from the end of the element, with -1
				// referencing the last element.
				if expanded_offset < 0 {
					expanded_offset += expanded_parameter_len;

					// If the offset is still negative, then we need to yield an empty slice.
					// We force the offset to the end of the array.
					if expanded_offset < 0 {
						expanded_offset = expanded_parameter_len;
					}
				}

				// Make sure the offset is within the bounds of the item.
				let expanded_offset = min(expanded_offset, expanded_parameter_len);

				let end_offset = if let Some(length) = length {
					let mut expanded_length = length.eval(self.shell, self.params, false).await?;
					if expanded_length < 0 {
						expanded_length += expanded_parameter_len;
					}

					let expanded_length = min(expanded_length, expanded_parameter_len - expanded_offset);

					expanded_offset + expanded_length
				} else {
					expanded_parameter_len
				};

				#[expect(clippy::cast_sign_loss)]
				Ok(expanded_parameter
					.polymorphic_subslice(expanded_offset as usize, end_offset as usize))
			},
			brush_parser::word::ParameterExpr::Transform {
				parameter,
				indirect,
				op: ParameterTransformOp::ToAttributeFlags,
			} => {
				if let (_, _, Some(var)) = self
					.try_resolve_parameter_to_variable(&parameter, indirect)
					.await?
				{
					Ok(var.attribute_flags(self.shell).into())
				} else {
					Ok(String::new().into())
				}
			},
			brush_parser::word::ParameterExpr::Transform {
				parameter,
				indirect,
				op: ParameterTransformOp::ToAssignmentLogic,
			} => {
				if let (Some(name), index, Some(var)) = self
					.try_resolve_parameter_to_variable(&parameter, indirect)
					.await?
				{
					let assignable_value_str = var
						.value()
						.to_assignable_str(index.as_deref(), self.shell)?;

					let mut attr_str = var.attribute_flags(self.shell);
					if attr_str.is_empty() {
						attr_str.push('-');
					}

					match var.value() {
                        ShellValue::IndexedArray(_)
                        | ShellValue::AssociativeArray(_)
                        // TODO(dynamic): confirm this
                        | ShellValue::Dynamic { .. } => {
                            let equals_or_nothing = if assignable_value_str.is_empty() {
                                ""
                            } else {
                                "="
                            };

                            Ok(std::format!(
                            "declare -{attr_str} {name}{equals_or_nothing}{assignable_value_str}"
                        )
                            .into())
                        }
                        ShellValue::String(_) => {
                            Ok(std::format!("{name}={assignable_value_str}").into())
                        }
                        ShellValue::Unset(_) => {
                            Ok(std::format!("declare -{attr_str} {name}").into())
                        }
                    }
				} else {
					Ok(String::new().into())
				}
			},
			brush_parser::word::ParameterExpr::Transform { parameter, indirect, op } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let came_from_undefined = expanded_parameter.undefined;

				//
				// For typing reasons (issues with FnMut and our mut use of self), we can't use
				// transform_expansion. Instead, we inline its logic here.
				//

				let mut transformed_fields = vec![];
				for field in expanded_parameter.fields {
					let s = String::from(field);
					let transformed = self.apply_transform_to(&op, s, came_from_undefined).await?;
					transformed_fields.push(WordField::from(transformed));
				}

				Ok(Expansion {
					fields:      transformed_fields,
					concatenate: expanded_parameter.concatenate,
					from_array:  expanded_parameter.from_array,
					undefined:   expanded_parameter.undefined,
				})
			},
			brush_parser::word::ParameterExpr::UppercaseFirstChar { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					Self::uppercase_first_char(s, expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::UppercasePattern { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					Self::uppercase_pattern(s.as_str(), expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::LowercaseFirstChar { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					Self::lowercase_first_char(s, expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::LowercasePattern { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(expanded_parameter, async |s| {
					Self::lowercase_pattern(s.as_str(), expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::ReplaceSubstring {
				parameter,
				indirect,
				pattern,
				replacement,
				match_kind,
			} => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self
					.basic_expand_pattern(pattern.as_str())
					.await?
					.set_extended_globbing(self.parser_options.enable_extended_globbing)
					.set_case_insensitive(self.shell.options().case_insensitive_conditionals);

				// If no replacement was provided, then we replace with an empty string.
				let replacement = replacement.unwrap_or(String::new());
				let expanded_replacement = self.basic_expand_to_str(&replacement).await?;

				let regex = expanded_pattern.to_regex(
					matches!(match_kind, brush_parser::word::SubstringMatchKind::Prefix),
					matches!(match_kind, brush_parser::word::SubstringMatchKind::Suffix),
				)?;

				transform_expansion(expanded_parameter, async |s| {
					Ok(Self::replace_substring(
						s.as_str(),
						&regex,
						expanded_replacement.as_str(),
						&match_kind,
					))
				})
				.await
			},
			brush_parser::word::ParameterExpr::VariableNames { prefix, concatenate } => {
				if prefix.is_empty() {
					Ok(Expansion::from(String::new()))
				} else {
					let matching_names = self
						.shell
						.env()
						.iter()
						.filter_map(|(name, _)| {
							if name.starts_with(prefix.as_str()) {
								Some(name.to_owned())
							} else {
								None
							}
						})
						.sorted();

					Ok(Expansion {
						fields: matching_names
							.into_iter()
							.map(|name| WordField(vec![ExpansionPiece::Splittable(name)]))
							.collect(),
						concatenate,
						from_array: true,
						undefined: false,
					})
				}
			},
			brush_parser::word::ParameterExpr::MemberKeys { variable_name, concatenate } => {
				let keys = if let Some((_, var)) = self.shell.env().get(variable_name) {
					var.value().element_keys(self.shell)
				} else {
					vec![]
				};

				Ok(Expansion {
					fields: keys
						.into_iter()
						.map(|key| WordField(vec![ExpansionPiece::Splittable(key)]))
						.collect(),
					concatenate,
					from_array: true,
					undefined: false,
				})
			},
		}
	}

	async fn assign_to_parameter(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		value: String,
	) -> Result<(), error::Error> {
		let (variable_name, index) = match parameter {
			brush_parser::word::Parameter::Named(name) => (name, None),
			brush_parser::word::Parameter::NamedWithIndex { name, index } => {
				let is_set_assoc_array = if let Some((_, var)) = self.shell.env().get(name) {
					matches!(
						var.value(),
						ShellValue::AssociativeArray(_)
							| ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
					)
				} else {
					false
				};

				let index_to_use = self
					.expand_array_index(index.as_str(), is_set_assoc_array)
					.await?;
				(name, Some(index_to_use))
			},
			brush_parser::word::Parameter::Positional(_)
			| brush_parser::word::Parameter::NamedWithAllIndices { name: _, concatenate: _ }
			| brush_parser::word::Parameter::Special(_) => {
				return Err(error::ErrorKind::CannotAssignToSpecialParameter.into());
			},
		};

		if let Some(index) = index {
			self.shell.env_mut().update_or_add_array_element(
				variable_name,
				index,
				value,
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)
		} else {
			self.shell.env_mut().update_or_add(
				variable_name,
				variables::ShellValueLiteral::Scalar(value),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)
		}
	}

	async fn try_resolve_parameter_to_variable(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		indirect: bool,
	) -> Result<(Option<String>, Option<String>, Option<ShellVariable>), error::Error> {
		if !indirect {
			Ok(self.try_resolve_parameter_to_variable_without_indirect(parameter))
		} else {
			let expansion = self.expand_parameter(parameter, false).await?;
			let parameter_str: String = expansion.into();
			let inner_parameter =
				brush_parser::word::parse_parameter(parameter_str.as_str(), &self.parser_options)?;
			Ok(self.try_resolve_parameter_to_variable_without_indirect(&inner_parameter))
		}
	}

	fn try_resolve_parameter_to_variable_without_indirect(
		&self,
		parameter: &brush_parser::word::Parameter,
	) -> (Option<String>, Option<String>, Option<ShellVariable>) {
		let (name, index) = match parameter {
			brush_parser::word::Parameter::Positional(_)
			| brush_parser::word::Parameter::Special(_) => (None, None),
			brush_parser::word::Parameter::Named(name) => (Some(name.to_owned()), Some("0".into())),
			brush_parser::word::Parameter::NamedWithIndex { name, index } => {
				(Some(name.to_owned()), Some(index.to_owned()))
			},
			brush_parser::word::Parameter::NamedWithAllIndices { name, concatenate: _concatenate } => {
				(Some(name.to_owned()), None)
			},
		};

		let var = name
			.as_ref()
			.and_then(|name| self.shell.env().get(name).map(|(_, var)| var.clone()));

		(name, index, var)
	}

	fn undefined_expansion(
		&self,
		parameter: &brush_parser::word::Parameter,
		allow_unset_vars: bool,
	) -> Result<Expansion, error::Error> {
		if allow_unset_vars || !self.shell.options().treat_unset_variables_as_error {
			Ok(Expansion::undefined())
		} else {
			let err: error::Error =
				error::ErrorKind::ExpandingUnsetVariable(parameter.to_string()).into();
			Err(err.into_fatal())
		}
	}

	async fn expand_parameter(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		indirect: bool,
	) -> Result<Expansion, error::Error> {
		self
			.expand_parameter_internal(parameter, indirect, false)
			.await
	}

	async fn expand_parameter_allowing_unset(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		indirect: bool,
	) -> Result<Expansion, error::Error> {
		self
			.expand_parameter_internal(parameter, indirect, true)
			.await
	}

	async fn expand_parameter_internal(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		indirect: bool,
		allow_unset_vars: bool,
	) -> Result<Expansion, error::Error> {
		let expansion = self
			.expand_parameter_without_indirect(parameter, allow_unset_vars)
			.await?;
		if !indirect {
			Ok(expansion)
		} else {
			let parameter_str: String = expansion.into();
			let inner_parameter =
				brush_parser::word::parse_parameter(parameter_str.as_str(), &self.parser_options)?;

			self
				.expand_parameter_without_indirect(&inner_parameter, allow_unset_vars)
				.await
		}
	}

	async fn expand_parameter_without_indirect(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		allow_unset_vars: bool,
	) -> Result<Expansion, error::Error> {
		match parameter {
			brush_parser::word::Parameter::Positional(p) => {
				if *p == 0 {
					Ok(self.expand_special_parameter(&brush_parser::word::SpecialParameter::ShellName))
				} else if let Some(parameter) = self.shell.current_shell_args().get((p - 1) as usize) {
					Ok(Expansion::from(parameter.to_owned()))
				} else {
					self.undefined_expansion(parameter, allow_unset_vars)
				}
			},
			brush_parser::word::Parameter::Special(s) => Ok(self.expand_special_parameter(s)),
			brush_parser::word::Parameter::Named(n) => {
				if !env::valid_variable_name(n.as_str()) {
					Err(error::ErrorKind::BadSubstitution(n.clone()).into())
				} else if let Some((_, var)) = self.shell.env().get(n) {
					if matches!(var.value(), ShellValue::Unset(_)) {
						self.undefined_expansion(parameter, allow_unset_vars)
					} else {
						let value = var.value().try_get_cow_str(self.shell);
						if let Some(value) = value {
							Ok(Expansion::from(value.to_string()))
						} else {
							self.undefined_expansion(parameter, allow_unset_vars)
						}
					}
				} else {
					self.undefined_expansion(parameter, allow_unset_vars)
				}
			},
			brush_parser::word::Parameter::NamedWithIndex { name, index } => {
				// First check to see if it's an associative array.
				let is_set_assoc_array = if let Some((_, var)) = self.shell.env().get(name) {
					matches!(
						var.value(),
						ShellValue::AssociativeArray(_)
							| ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
					)
				} else {
					false
				};

				// Figure out which index to use.
				let index_to_use = self
					.expand_array_index(index.as_str(), is_set_assoc_array)
					.await?;

				// Index into the array.
				if let Some((_, var)) = self.shell.env().get(name)
					&& let Ok(Some(value)) = var.value().get_at(index_to_use.as_str(), self.shell)
				{
					Ok(Expansion::from(value.to_string()))
				} else {
					self.undefined_expansion(parameter, allow_unset_vars)
				}
			},
			brush_parser::word::Parameter::NamedWithAllIndices { name, concatenate } => {
				if let Some((_, var)) = self.shell.env().get(name) {
					let values = var.value().element_values(self.shell);

					Ok(Expansion {
						fields:      values
							.into_iter()
							.map(|value| WordField(vec![ExpansionPiece::Splittable(value)]))
							.collect(),
						concatenate: *concatenate,
						from_array:  true,
						undefined:   false,
					})
				} else {
					Ok(Expansion {
						fields:      vec![],
						concatenate: *concatenate,
						from_array:  true,
						undefined:   false,
					})
				}
			},
		}
	}

	async fn expand_array_index(
		&mut self,
		index: &str,
		for_set_associative_array: bool,
	) -> Result<String, error::Error> {
		let index_to_use = if for_set_associative_array {
			self.basic_expand_to_str(index).await?
		} else {
			arithmetic::expand_and_eval(self.shell, self.params, index, false)
				.await?
				.to_string()
		};

		Ok(index_to_use)
	}

	fn expand_special_parameter(
		&self,
		parameter: &brush_parser::word::SpecialParameter,
	) -> Expansion {
		match parameter {
			brush_parser::word::SpecialParameter::AllPositionalParameters { concatenate } => {
				let args = self.shell.current_shell_args().iter();

				Expansion {
					fields:      args
						.into_iter()
						.map(|param| WordField(vec![ExpansionPiece::Splittable(param.to_owned())]))
						.collect(),
					concatenate: *concatenate,
					from_array:  true,
					undefined:   false,
				}
			},
			brush_parser::word::SpecialParameter::PositionalParameterCount => {
				Expansion::from(self.shell.current_shell_args().len().to_string())
			},
			brush_parser::word::SpecialParameter::LastExitStatus => {
				Expansion::from(self.shell.last_exit_status().to_string())
			},
			brush_parser::word::SpecialParameter::CurrentOptionFlags => {
				Expansion::from(self.shell.options().option_flags())
			},
			brush_parser::word::SpecialParameter::ProcessId => {
				Expansion::from(std::process::id().to_string())
			},
			brush_parser::word::SpecialParameter::LastBackgroundProcessId => {
				if let Some(job) = self.shell.jobs().current_job()
					&& let Some(pid) = job.representative_pid()
				{
					return Expansion::from(pid.to_string());
				}
				Expansion::from(String::new())
			},
			brush_parser::word::SpecialParameter::ShellName => Expansion::from(
				self
					.shell
					.current_shell_name()
					.map_or_else(String::new, |name| name.to_string()),
			),
		}
	}

	async fn expand_arithmetic_expr(
		&mut self,
		expr: brush_parser::ast::UnexpandedArithmeticExpr,
	) -> Result<String, error::Error> {
		let value = expr.eval(self.shell, self.params, false).await?;
		Ok(value.to_string())
	}

	fn uppercase_first_char(
		s: String,
		pattern: Option<&patterns::Pattern>,
	) -> Result<String, error::Error> {
		if let Some(first_char) = s.chars().next() {
			let applicable = if let Some(pattern) = pattern {
				pattern.is_empty() || pattern.exactly_matches(first_char.to_string().as_str())?
			} else {
				true
			};

			if applicable {
				if let Some(upper_char) = first_char.to_uppercase().next() {
					let mut result = upper_char.to_string();
					let rest: String = s.chars().skip(1).collect();
					result.push_str(&rest);
					return Ok(result);
				}
			}
		}

		Ok(s)
	}

	fn lowercase_first_char(
		s: String,
		pattern: Option<&patterns::Pattern>,
	) -> Result<String, error::Error> {
		if let Some(first_char) = s.chars().next() {
			let applicable = if let Some(pattern) = pattern {
				pattern.is_empty() || pattern.exactly_matches(first_char.to_string().as_str())?
			} else {
				true
			};

			if applicable {
				if let Some(lower_char) = first_char.to_lowercase().next() {
					let mut result = lower_char.to_string();
					let rest: String = s.chars().skip(1).collect();
					result.push_str(&rest);
					return Ok(result);
				}
			}
		}

		Ok(s)
	}

	fn uppercase_pattern(
		s: &str,
		pattern: Option<&patterns::Pattern>,
	) -> Result<String, error::Error> {
		if let Some(pattern) = pattern {
			if !pattern.is_empty() {
				let regex = pattern.to_regex(false, false)?;
				let result = regex
					.replace_all(s.as_ref(), |caps: &fancy_regex::Captures<'_>| caps[0].to_uppercase());
				Ok(result.into_owned())
			} else {
				Ok(s.to_uppercase())
			}
		} else {
			Ok(s.to_uppercase())
		}
	}

	fn lowercase_pattern(
		s: &str,
		pattern: Option<&patterns::Pattern>,
	) -> Result<String, error::Error> {
		if let Some(pattern) = pattern {
			if !pattern.is_empty() {
				let regex = pattern.to_regex(false, false)?;
				let result = regex
					.replace_all(s.as_ref(), |caps: &fancy_regex::Captures<'_>| caps[0].to_lowercase());
				Ok(result.into_owned())
			} else {
				Ok(s.to_lowercase())
			}
		} else {
			Ok(s.to_lowercase())
		}
	}

	fn replace_substring(
		s: &str,
		regex: &fancy_regex::Regex,
		replacement: &str,
		match_kind: &SubstringMatchKind,
	) -> String {
		match match_kind {
			brush_parser::word::SubstringMatchKind::Prefix
			| brush_parser::word::SubstringMatchKind::Suffix
			| brush_parser::word::SubstringMatchKind::FirstOccurrence => {
				regex.replace(s, replacement).into_owned()
			},

			brush_parser::word::SubstringMatchKind::Anywhere => {
				regex.replace_all(s, replacement).into_owned()
			},
		}
	}

	async fn apply_transform_to(
		&mut self,
		op: &ParameterTransformOp,
		s: String,
		came_from_undefined: bool,
	) -> Result<String, error::Error> {
		match op {
			brush_parser::word::ParameterTransformOp::PromptExpand => {
				prompt::expand_prompt(self.shell, self.params, s).await
			},
			brush_parser::word::ParameterTransformOp::CapitalizeInitial => {
				Ok(to_initial_capitals(s.as_str()))
			},
			brush_parser::word::ParameterTransformOp::ExpandEscapeSequences => {
				let (result, _) = escape::expand_backslash_escapes(
					s.as_str(),
					escape::EscapeExpansionMode::AnsiCQuotes,
				)?;
				Ok(String::from_utf8_lossy(result.as_slice()).into_owned())
			},
			brush_parser::word::ParameterTransformOp::PossiblyQuoteWithArraysExpanded {
				separate_words: _separate_words,
			} => {
				if came_from_undefined {
					Ok(String::new())
				} else {
					// TODO(expansion): This isn't right for arrays.
					// TODO(expansion): This doesn't honor 'separate_words'
					Ok(escape::force_quote(s.as_str(), escape::QuoteMode::SingleQuote))
				}
			},
			brush_parser::word::ParameterTransformOp::Quoted => {
				if came_from_undefined {
					Ok(String::new())
				} else {
					Ok(escape::force_quote(s.as_str(), escape::QuoteMode::SingleQuote))
				}
			},
			brush_parser::word::ParameterTransformOp::ToLowerCase => Ok(s.to_lowercase()),
			brush_parser::word::ParameterTransformOp::ToUpperCase => Ok(s.to_uppercase()),
			brush_parser::word::ParameterTransformOp::ToAssignmentLogic
			| brush_parser::word::ParameterTransformOp::ToAttributeFlags => {
				unreachable!("covered in caller")
			},
		}
	}
}

fn coalesce_expansions(expansions: Vec<Expansion>) -> Expansion {
	expansions
		.into_iter()
		.fold(Expansion::default(), |mut acc, expansion| {
			for (i, mut field) in expansion.fields.into_iter().enumerate() {
				match acc.fields.last_mut() {
					Some(last) if i == 0 => {
						last.0.append(&mut field.0);
					},
					_ => acc.fields.push(field),
				}
			}

			// TODO(expansion): What if expansions have different concatenation values?
			acc.concatenate = expansion.concatenate;
			acc.from_array = expansion.from_array;

			acc
		})
}

fn to_initial_capitals(s: &str) -> String {
	let mut result = String::new();
	let mut capitalize_next = true;

	for c in s.chars() {
		if c.is_whitespace() {
			capitalize_next = true;
			result.push(c);
		} else if capitalize_next {
			result.push_str(c.to_uppercase().to_string().as_str());
			capitalize_next = false;
		} else {
			result.push(c);
		}
	}

	result
}

async fn transform_expansion<F, FReturn>(
	expansion: Expansion,
	mut f: F,
) -> Result<Expansion, error::Error>
where
	F: FnMut(String) -> FReturn,
	FReturn: Future<Output = Result<String, error::Error>>,
{
	let mut transformed_fields = vec![];
	for field in expansion.fields {
		let transformed_field = WordField::from(f(String::from(field)).await?);
		transformed_fields.push(transformed_field);
	}

	Ok(Expansion {
		fields:      transformed_fields,
		concatenate: expansion.concatenate,
		from_array:  expansion.from_array,
		undefined:   expansion.undefined,
	})
}

fn may_contain_braces_to_expand(s: &str) -> bool {
	// This is a completely inaccurate but quick heuristic used to see if
	// it's even worth properly parsing the string to find brace expressions.
	// It's mostly used to avoid more expensive parsing just because we've
	// encountered a brace used in a parameter expansion.
	let mut last_was_unescaped_dollar_sign = false;
	let mut last_was_escape = false;
	let mut saw_opening_brace = false;
	let mut saw_closing_brace = false;
	for c in s.chars() {
		if !last_was_unescaped_dollar_sign {
			if c == '{' {
				saw_opening_brace = true;
			} else if c == '}' {
				saw_closing_brace = true;
				if saw_opening_brace {
					return true;
				}
			}
		}

		last_was_unescaped_dollar_sign = !last_was_escape && c == '$';
		last_was_escape = c == '\\';
	}

	saw_opening_brace && saw_closing_brace
}

#[expect(clippy::panic_in_result_fn)]
#[cfg(test)]
mod tests {
	use anyhow::Result;

	use super::*;

	#[tokio::test]
	async fn test_full_expansion() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();

		assert_eq!(full_expand_and_split_word(&mut shell, &params, "\"\"").await?, vec![""]);
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "a b").await?, vec!["a", "b"]);
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "ab").await?, vec!["ab"]);
		assert_eq!(full_expand_and_split_word(&mut shell, &params, r#""a b""#).await?, vec!["a b"]);
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "").await?, Vec::<String>::new());
		assert_eq!(
			full_expand_and_split_word(&mut shell, &params, "$@").await?,
			Vec::<String>::new()
		);
		assert_eq!(
			full_expand_and_split_word(&mut shell, &params, "$*").await?,
			Vec::<String>::new()
		);

		Ok(())
	}

	/// Regression test: a quoted empty string `""` must survive word expansion
	/// even when `nullglob` is enabled.  Previously, `Pattern::expand()` would
	/// return `NoGlob` for an all-empty pattern, which with nullglob set caused
	/// `expand_pathnames_in_field` to silently discard the empty-string field.
	#[tokio::test]
	async fn test_quoted_empty_string_with_nullglob() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		shell.options_mut().expand_non_matching_patterns_to_null = true; // shopt -s nullglob
		let params = shell.default_exec_params();

		// Quoted empty string must always produce exactly one empty-string field.
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "\"\"").await?, vec![""]);
		// Unquoted empty string (no characters at all) should still produce no fields.
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "").await?, Vec::<String>::new());

		Ok(())
	}

	#[tokio::test]
	async fn test_brace_expansion() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let expander = WordExpander::new(&mut shell, &params);

		assert_eq!(expander.brace_expand_if_needed("abc")?, "abc");
		assert_eq!(expander.brace_expand_if_needed("a{,b}d")?, "ad abd");
		assert_eq!(expander.brace_expand_if_needed("a{b,c}d")?, "abd acd");
		assert_eq!(expander.brace_expand_if_needed("a{1..3}d")?, "a1d a2d a3d");
		assert_eq!(expander.brace_expand_if_needed(r#""{a,b}""#)?, r#""{a,b}""#);
		assert_eq!(expander.brace_expand_if_needed("a{}b")?, "a{}b");
		assert_eq!(expander.brace_expand_if_needed("a{ }b")?, "a{ }b");
		assert_eq!(expander.brace_expand_if_needed("{a,b{1,2}}")?, "a b1 b2");

		Ok(())
	}

	#[tokio::test]
	async fn test_field_splitting() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let expander = WordExpander::new(&mut shell, &params);

		let expansion = Expansion {
			fields: vec![
				WordField(vec![ExpansionPiece::Unsplittable("A".into())]),
				WordField(vec![ExpansionPiece::Unsplittable(String::new())]),
			],
			..Expansion::default()
		};

		let fields = expander.split_fields(expansion);

		assert_eq!(fields, vec![
			WordField(vec![ExpansionPiece::Unsplittable(String::from("A"))]),
			WordField(vec![ExpansionPiece::Unsplittable(String::new())])
		]);

		Ok(())
	}

	#[test]
	fn test_to_initial_capitals() {
		assert_eq!(to_initial_capitals("ab bc cd"), String::from("Ab Bc Cd"));
		assert_eq!(to_initial_capitals(" a "), String::from(" A "));
		assert_eq!(to_initial_capitals(""), String::new());
	}
}
