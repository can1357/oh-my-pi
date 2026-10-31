//! Word expansion utilities.

use std::{borrow::Cow, cmp::min};

use brush_parser::word::{ParameterTransformOp, SubstringMatchKind};
use itertools::Itertools;

use crate::{
	ExecutionParameters, arithmetic,
	arithmetic::ExpandAndEvaluate,
	braceexpansion, commands, env, error, escape, extensions, interp, patterns, prompt,
	shell::Shell,
	sys, trace_categories,
	variables::{ShellValue, ShellValueUnsetType},
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

	/// Appends `next` as if its text directly followed this expansion's: its
	/// first field joins this one's last, and the rest follow.
	///
	/// `next` can hold a field for every element of an array (`${name[@]}`),
	/// and this runs after the expansion that made them has spent its last
	/// checkpoint, so the fields placed spend one every
	/// [`interp::ELEMENT_CHECKPOINT_STRIDE`]. A call that places none one at a
	/// time (no fields, or nothing to join them onto, when they move over
	/// whole) spends one too, being a step of its caller's loop over the pieces
	/// of a word.
	async fn coalesce(&mut self, next: Self, params: &ExecutionParameters) -> Result<(), error::Error> {
		if self.fields.is_empty() || next.fields.is_empty() {
			interp::loop_checkpoint(params).await?;
			if self.fields.is_empty() {
				self.fields = next.fields;
			}
		} else {
			let mut budget = interp::ElementBudget::new();
			for (index, field) in next.fields.into_iter().enumerate() {
				// Joining onto the field before it copies that field's pieces.
				let due = budget.charge(if index == 0 { field.len() } else { 0 });
				if due > 0 {
					interp::loop_checkpoints(params, due).await?;
				}
				join_or_push(&mut self.fields, index == 0, field.0);
			}
		}

		// TODO(expansion): What if expansions have different concatenation values?
		self.concatenate = next.concatenate;
		self.from_array = next.from_array;

		Ok(())
	}

	fn polymorphic_len(&self) -> usize {
		if self.from_array {
			self.fields.len()
		} else {
			self.fields.iter().fold(0, |acc, field| acc + field.len())
		}
	}

	/// Returns elements `index..end` of an array's expansion, or characters
	/// `index..end` of anything else.
	///
	/// An array's expansion has a field per element, so taking a range of them
	/// spends a checkpoint every [`interp::ELEMENT_CHECKPOINT_STRIDE`] fields
	/// up to the end of the range.
	async fn polymorphic_subslice(
		self,
		index: usize,
		end: usize,
		params: &ExecutionParameters,
	) -> Result<Self, error::Error> {
		let len = end - index;

		// If we came from an array, then interpret `index` and `end` as indices
		// into the elements.
		if self.from_array {
			let mut fields = Vec::with_capacity(min(len, self.fields.len() - index));
			for (position, field) in self.fields.into_iter().enumerate().take(end) {
				interp::element_checkpoint(params, position).await?;
				if position >= index {
					fields.push(field);
				}
			}

			Ok(Self {
				fields,
				concatenate: self.concatenate,
				undefined: self.undefined,
				from_array: self.from_array,
			})
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

			Ok(Self {
				fields,
				concatenate: self.concatenate,
				undefined: self.undefined,
				from_array: self.from_array,
			})
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

/// Puts `pieces` at the end of `fields`: onto the last field when `join` is
/// set and there is one, else as a field of their own.
fn join_or_push(fields: &mut Vec<WordField>, join: bool, mut pieces: Vec<ExpansionPiece>) {
	match fields.last_mut() {
		Some(WordField(last)) if join => last.append(&mut pieces),
		_ => fields.push(WordField(pieces)),
	}
}

/// The expansion of one parameter's value: a copy of it, made in strides above
/// one.
///
/// A value is as long as whatever was assigned to it. `"$big"`, `"$1"` and
/// `"${a[0]}"` each copied a 64 MiB value in one `to_string`, holding the
/// worker 24.6–25.9 ms, while `"${a[@]}"` already copied the same element in
/// strides.
async fn copied_value(params: &ExecutionParameters, value: &str) -> Result<Expansion, error::Error> {
	Ok(Expansion::from(if value.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
		interp::clone_in_strides(params, value).await?
	} else {
		value.to_owned()
	}))
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

/// Whether `text` holds any of `chars`, spending a checkpoint before each
/// stride of it.
///
/// `str::contains` over a word that a variable sized is a hold of its own: the
/// short circuit in [`WordExpander::basic_expand`] reads a 16 MiB prompt end
/// to end before it can decide there is nothing in it to expand.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way.
async fn contains_any_in_strides(
	params: &ExecutionParameters,
	text: &str,
	chars: &[char],
) -> Result<bool, error::Error> {
	let mut rest = text;
	while !rest.is_empty() {
		interp::stride_checkpoint(params).await?;
		let mut end = rest.len().min(interp::BYTE_CHECKPOINT_STRIDE);
		// A stride lands mid-character at most three bytes in.
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		if piece.contains(chars) {
			return Ok(true);
		}
		rest = remaining;
	}
	Ok(false)
}

/// Parses `word` into its pieces a step at a time, spending a checkpoint
/// before each step.
///
/// For a word above [`interp::DIVIDE_COPY_ABOVE_BYTES`]: such a word is not
/// one anybody typed but one a variable made, a prompt above all, which is
/// expanded before every command. The word grammar is a PEG that tries every
/// other kind of piece at every character of a literal, so the whole parse of
/// a 16 MiB prompt holds the worker for hundreds of milliseconds. A step
/// covers one byte stride of the word or one element stride of pieces, and
/// the pieces are the ones the whole parse gives.
///
/// The whole-word cache [`brush_parser::word::parse`] keeps is left to the
/// ordinary word on purpose: its key is the word, so a word this long would be
/// copied and hashed in one step on every expansion to look it up, and its
/// pieces cloned out of it on every hit.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way,
/// and the error [`brush_parser::word::parse`] gives for a word it cannot
/// parse.
async fn parse_word_in_strides(
	params: &ExecutionParameters,
	word: &str,
	options: &brush_parser::ParserOptions,
) -> Result<Vec<brush_parser::word::WordPieceWithSource>, error::Error> {
	let mut parse = brush_parser::word::SteppedParse::new(word, options);
	// A piece the grammar is handed is one call, and one that fails can read to
	// the end of the word: the parse is abandoned rather than hand the grammar
	// more than a stride, and the word is then parsed whole, off the worker.
	parse.limit_grammar_reach(interp::BYTE_CHECKPOINT_STRIDE);
	loop {
		interp::stride_checkpoint(params).await?;
		if !parse.step(interp::BYTE_CHECKPOINT_STRIDE, interp::ELEMENT_CHECKPOINT_STRIDE) {
			break;
		}
	}
	if parse.failed() {
		return parse_whole_off_worker(params, word, options, brush_parser::word::parse_uncached).await;
	}
	Ok(parse.finish()?)
}

/// The whole parse of a long word that the stepped parse could not finish, on
/// a blocking worker: one it found does not parse, or one with a piece that
/// would have handed the grammar more than a stride.
///
/// The answer has to be the one the whole parse gives, so the stepped parse
/// falls back to it: an error path pays one parse rather than reproducing the
/// grammar's error values, and a piece the grammar reads whole is read by it
/// in the whole word instead. That parse is one call into the grammar with
/// nothing inside that can yield: a 16 MiB `PS1` that opens a quote and never
/// closes it held the worker 375 ms in it, 630 ms under load, and a `$((\))`
/// before 16 MiB 281 ms. So it runs on a blocking worker, unless this is one
/// already (see [`commands::builtin_on_blocking_worker`]), from a copy of the
/// word made in strides.
async fn parse_whole_off_worker<T: Send + 'static>(
	params: &ExecutionParameters,
	word: &str,
	options: &brush_parser::ParserOptions,
	parse: fn(&str, &brush_parser::ParserOptions) -> Result<T, brush_parser::WordParseError>,
) -> Result<T, error::Error> {
	if commands::builtin_on_blocking_worker() {
		return Ok(parse(word, options)?);
	}
	let word = interp::clone_in_strides(params, word).await?;
	let options = options.clone();
	match tokio::task::spawn_blocking(move || parse(&word, &options)).await {
		Ok(parsed) => Ok(parsed?),
		Err(join_error) if join_error.is_panic() => std::panic::resume_unwind(join_error.into_panic()),
		Err(join_error) => Err(error::ErrorKind::ThreadingError(join_error).into()),
	}
}

/// Parses `word` for brace expansion a step at a time, spending a checkpoint
/// before each step: [`parse_word_in_strides`] for the brace grammar, which a
/// long word reaches first whenever it holds a `{` and a `}`. The inner result
/// is the one [`brush_parser::word::parse_brace_expansions`] gives.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way.
async fn parse_brace_expansions_in_strides(
	params: &ExecutionParameters,
	word: &str,
	options: &brush_parser::ParserOptions,
) -> Result<
	Result<Option<Vec<brush_parser::word::BraceExpressionOrText>>, brush_parser::WordParseError>,
	error::Error,
> {
	let mut parse = brush_parser::word::SteppedBraceParse::new(word, options);
	parse.limit_grammar_reach(interp::BYTE_CHECKPOINT_STRIDE);
	loop {
		interp::stride_checkpoint(params).await?;
		if !parse.step(interp::BYTE_CHECKPOINT_STRIDE, interp::ELEMENT_CHECKPOINT_STRIDE) {
			break;
		}
	}
	if parse.needs_whole_parse() {
		// The whole brace parse's error is the inner result, not the run's.
		let whole = |word: &str, options: &brush_parser::ParserOptions| {
			Ok(brush_parser::word::parse_brace_expansions(word, options))
		};
		return parse_whole_off_worker(params, word, options, whole).await;
	}
	Ok(parse.finish())
}

/// [`env::valid_variable_name`], spending a checkpoint before each stride of
/// `name`.
///
/// Every character a name may hold is ASCII, so the test is made on bytes: a
/// byte of a multi-byte character is never a letter, a digit or `_`.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way.
pub async fn valid_variable_name_in_strides(
	params: &ExecutionParameters,
	name: &str,
) -> Result<bool, error::Error> {
	let bytes = name.as_bytes();
	if !bytes.first().is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_') {
		return Ok(false);
	}
	for stride in bytes.chunks(interp::BYTE_CHECKPOINT_STRIDE) {
		interp::stride_checkpoint(params).await?;
		if !stride.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_') {
			return Ok(false);
		}
	}
	Ok(true)
}

/// The variable [`env::ShellEnvironment::get`] finds for `name`, for a name
/// above [`interp::DIVIDE_COPY_ABOVE_BYTES`].
///
/// `get` hashes the name once for every scope it looks in, which for a name of
/// 16 MiB is milliseconds in one step. The names of the variables visible are
/// compared with it instead: a name of another length is passed over without
/// reading it, and one of the same length is compared a stride at a time.
/// Visible means the innermost scope's variable of each name, which is the one
/// `get` returns.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way.
async fn variable_by_long_name<'e>(
	params: &ExecutionParameters,
	environment: &'e env::ShellEnvironment,
	name: &str,
) -> Result<Option<&'e crate::variables::ShellVariable>, error::Error> {
	let candidates: Vec<_> = environment
		.iter()
		.filter(|(candidate, _)| candidate.len() == name.len())
		.collect();
	for (candidate, var) in candidates {
		let mut same = true;
		for (ours, theirs) in candidate
			.as_bytes()
			.chunks(interp::BYTE_CHECKPOINT_STRIDE)
			.zip(name.as_bytes().chunks(interp::BYTE_CHECKPOINT_STRIDE))
		{
			interp::stride_checkpoint(params).await?;
			if ours != theirs {
				same = false;
				break;
			}
		}
		if same {
			return Ok(Some(var));
		}
	}
	Ok(None)
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
	expander.assign_to_parameter(&parameter, value).await.map(|_| ())
}

/// How many characters and pieces field splitting walks between two
/// checkpoints. A checkpoint costs nothing next to this many steps, and since
/// the cooperative budget lasts 128 checkpoints the walk still yields every
/// 32 Ki steps.
const FIELD_SPLITTING_STRIDE: usize = 256;

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
		let expansion = self.basic_expand(word).await?;
		self.join_fields(expansion).await
	}

	/// Joins the fields of `expansion` into one string, separated by spaces.
	///
	/// `x="${name[@]}"` joins a field for every element of the array, after the
	/// expansion has spent its last checkpoint, so the fields joined spend one
	/// every [`interp::ELEMENT_CHECKPOINT_STRIDE`] — and a field larger than a
	/// byte stride is copied in strides rather than merely charged for, since
	/// one of them can be of any size.
	async fn join_fields(&self, expansion: Expansion) -> Result<String, error::Error> {
		let mut joined = String::new();
		let mut budget = interp::ElementBudget::new();
		for (index, field) in expansion.fields.into_iter().enumerate() {
			let long = field.len() > interp::DIVIDE_COPY_ABOVE_BYTES;
			if !long {
				let due = budget.charge(field.len());
				if due > 0 {
					interp::loop_checkpoints(self.params, due).await?;
				}
			}
			// TODO(IFS): Use IFS instead for separator?
			if index > 0 {
				joined.push(' ');
			}
			for piece in field.0 {
				if long {
					interp::push_str_in_strides(self.params, &mut joined, piece.as_str()).await?;
				} else {
					joined.push_str(piece.as_str());
				}
			}
		}

		Ok(joined)
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
		let expandable = if word.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
			contains_any_in_strides(self.params, word, expansion_chars).await?
		} else {
			word.contains(expansion_chars)
		};
		if !expandable {
			// The word is its own expansion, and copying it is the whole of
			// the work left: a prompt of 16 MiB reaches here with nothing in it
			// to expand and copies all of it in one step.
			let copied = if word.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
				interp::clone_in_strides(self.params, word).await?
			} else {
				word.to_owned()
			};
			return Ok(Expansion::from(ExpansionPiece::Splittable(copied)));
		}

		// Apply brace expansion first, before anything else (not applicable to
		// heredoc bodies). Each resulting element is an independent word: bash
		// runs tilde/parameter/command/arithmetic expansion on EVERY element, so
		// a tilde that begins any element (e.g. `~/{a,b}` -> `~/a` and `~/b`)
		// must expand — not only the first. Parsing the space-joined result as a
		// single word left every element after the first with a literal leading
		// `~` (issue #5819).
		let brace_expanded_words = self.brace_expand_words(word).await?;
		if tracing::enabled!(target: trace_categories::EXPANSION, tracing::Level::DEBUG)
			&& !(brace_expanded_words.len() == 1 && brace_expanded_words[0] == word)
		{
			tracing::debug!(target: trace_categories::EXPANSION, "  => brace expanded to {brace_expanded_words:?}");
		}

		// Expand each brace element separately (tildes, parameters, command
		// substitutions, arithmetic), separating elements with a splittable
		// space so downstream field splitting yields one field per element.
		// Each expansion coalesces into the result as it is made. That spends
		// checkpoints of its own rather than leaning on this element's: one
		// piece can stand for a field per element of an array, and by the time
		// they are joined in, this element's checkpoint is far behind.
		let mut coalesced = Expansion::default();
		for (index, element) in brace_expanded_words.iter().enumerate() {
			// A brace range sets this count, not the script: `{1..3000000}` is
			// one word in, three million out, and every step below is ready on
			// a native filesystem.
			interp::loop_checkpoint(self.params).await?;
			if index > 0 {
				let separator = Expansion::from(ExpansionPiece::Splittable(String::from(" ")));
				coalesced.coalesce(separator, self.params).await?;
			}

			let pieces = if self.heredoc_mode {
				// Heredoc mode only affects top-level parsing (literal quotes);
				// recursive expansion of parameter words (e.g., ${var:-"default"})
				// uses normal semantics.
				self.heredoc_mode = false;

				brush_parser::word::parse_heredoc(element.as_ref(), &self.parser_options)?
			} else if element.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
				parse_word_in_strides(self.params, element.as_ref(), &self.parser_options).await?
			} else {
				brush_parser::word::parse(element.as_ref(), &self.parser_options)?
			};

			for piece in pieces {
				let piece_expansion = self.expand_word_piece(piece.piece).await?;
				coalesced.coalesce(piece_expansion, self.params).await?;
			}
		}

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

	/// Perform brace expansion on `word`, returning each expanded element as a
	/// separate word. When brace expansion doesn't apply (disabled, no braces,
	/// or a parse failure), the original word is returned as the sole element.
	///
	/// Empty brace elements (e.g. from `{,b}`) are returned as a quoted empty
	/// string (`""`) so they survive as empty fields, matching bash.
	///
	/// The generator spends a checkpoint on each word it makes, so a range
	/// such as `{1..3000000}` can be cancelled before the last one exists.
	async fn brace_expand_words(&self, word: &'a str) -> Result<Vec<Cow<'a, str>>, error::Error> {
		// We perform a non-authoritative check to see if the string *may* contain
		// braces to expand. There may be false positives, but must be no false
		// negatives.
		if self.disable_brace_expansion || !self.shell.options().perform_brace_expansion {
			return Ok(vec![word.into()]);
		}
		let long = word.len() > interp::DIVIDE_COPY_ABOVE_BYTES;
		let may_contain_braces = if long {
			may_contain_braces_to_expand_in_strides(self.params, word).await?
		} else {
			may_contain_braces_to_expand(word)
		};
		if !may_contain_braces {
			return Ok(vec![word.into()]);
		}

		let parse_result = if long {
			parse_brace_expansions_in_strides(self.params, word, &self.parser_options).await?
		} else {
			brush_parser::word::parse_brace_expansions(word, &self.parser_options)
		};
		if parse_result.is_err() {
			tracing::error!("failed to parse for brace expansion: {parse_result:?}");
			return Ok(vec![word.into()]);
		}

		let brace_expansion_pieces = parse_result?;
		let Some(brace_expansion_pieces) = brace_expansion_pieces else {
			return Ok(vec![word.into()]);
		};
		// With no brace expression in it, a word is one text piece, which the
		// generator would copy back into the word in one step.
		if long
			&& !brace_expansion_pieces
				.iter()
				.any(|piece| matches!(piece, brush_parser::word::BraceExpressionOrText::Expr(_)))
		{
			return Ok(vec![word.into()]);
		}

		tracing::debug!(target: trace_categories::EXPANSION, "Brace expansion pieces: {brace_expansion_pieces:?}");

		let words = braceexpansion::generate_and_combine_brace_expansions(
			brace_expansion_pieces,
			self.params,
		)
		.await?
		.into_iter()
		.map(|s| if s.is_empty() { Cow::Borrowed("\"\"") } else { Cow::Owned(s) })
		.collect();

		Ok(words)
	}

	/// Convenience wrapper over [`Self::brace_expand_words`] that joins the
	/// expanded elements back into a single space-separated string.
	#[cfg(test)]
	async fn brace_expand_if_needed(&self, word: &'a str) -> Result<Cow<'a, str>, error::Error> {
		let mut words = self.brace_expand_words(word).await?;
		if words.len() == 1 {
			Ok(words.remove(0))
		} else {
			Ok(Cow::Owned(words.join(" ")))
		}
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
		let fields: Vec<WordField> = self.split_fields(basic_expansion).await?;

		// Now expand pathnames if necessary. This also unquotes as a side effect.
		let mut result = Vec::new();
		let mut budget = interp::ElementBudget::new();
		for field in fields {
			// One field per brace element or array element; the unquoting below
			// rewrites its text, and a field that globs spends the walk's own
			// checkpoints while it does.
			let due = budget.charge(field.len());
			if due > 0 {
				interp::loop_checkpoints(self.params, due).await?;
			}
			if self.disable_pathname_expansion || self.shell.options().disable_filename_globbing {
				// Only a field that cannot be unquoted in one step goes through
				// the dividing path: calling an `async` function on every field
				// of a million-element array costs more than the checkpoints.
				result.push(if field.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
					self.unquote_in_strides(field).await?
				} else {
					String::from(field)
				});
			} else {
				result.extend(self.expand_pathnames_in_field(field).await?);
			}
		}

		Ok(result)
	}

	/// Splits `expansion` into fields at the characters in IFS.
	///
	/// The text comes from run-time data, not the script, and a single field
	/// can be any length, so the walk spends a checkpoint every
	/// [`FIELD_SPLITTING_STRIDE`] characters and pieces rather than once per
	/// field.
	async fn split_fields(&self, expansion: Expansion) -> Result<Vec<WordField>, error::Error> {
		let ifs = self.shell.ifs();

		let mut fields: Vec<WordField> = vec![];
		let mut current_field = WordField::new();
		// Characters and pieces walked since the last checkpoint.
		let mut steps = 0;

		// Go through the fields we have so far.
		for existing_field in expansion.fields {
			for piece in existing_field.0 {
				if steps == FIELD_SPLITTING_STRIDE {
					steps = 0;
					interp::loop_checkpoint(self.params).await?;
				}
				steps += 1;
				match piece {
					ExpansionPiece::Unsplittable(_) => current_field.0.push(piece),
					ExpansionPiece::Splittable(s) => {
						for c in s.chars() {
							if steps == FIELD_SPLITTING_STRIDE {
								steps = 0;
								interp::loop_checkpoint(self.params).await?;
							}
							steps += 1;
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

		Ok(fields)
	}

	/// Copies a field a stride at a time, keeping each piece's quoting.
	///
	/// A field holds one array element, or one brace element, and either can be
	/// of any size; a single `clone` of one held the worker for the whole copy.
	async fn clone_field_in_strides(&self, field: &WordField) -> Result<WordField, error::Error> {
		let mut pieces = Vec::with_capacity(field.0.len());
		for piece in &field.0 {
			let text = interp::clone_in_strides(self.params, piece.as_str()).await?;
			pieces.push(match piece {
				ExpansionPiece::Splittable(_) => ExpansionPiece::Splittable(text),
				ExpansionPiece::Unsplittable(_) => ExpansionPiece::Unsplittable(text),
			});
		}

		Ok(WordField(pieces))
	}

	/// Joins a field's pieces into the string it stands for, a stride at a
	/// time. `String::from(field)` does the same in one copy, which one array
	/// element of any size turns into a stretch nothing can interrupt.
	async fn unquote_in_strides(&self, field: WordField) -> Result<String, error::Error> {
		let mut text = String::new();
		for piece in &field.0 {
			interp::push_str_in_strides(self.params, &mut text, piece.as_str()).await?;
		}

		Ok(text)
	}

	async fn expand_pathnames_in_field(
		&self,
		field: WordField,
	) -> Result<Vec<String>, error::Error> {
		// One field can be of any size, and `Pattern` needs its own copy while
		// the field itself is still needed below. Only a copy too large to make
		// in one step is divided; the `async` call to divide it costs more than
		// the copy does for an ordinary field.
		let copied = if field.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
			self.clone_field_in_strides(&field).await?
		} else {
			field.clone()
		};
		let pattern = patterns::Pattern::from(copied)
			.set_extended_globbing(self.parser_options.enable_extended_globbing)
			.set_case_insensitive(self.shell.options().case_insensitive_pathname_expansion);

		let options = patterns::FilenameExpansionOptions {
			require_dot_in_pattern_to_match_dot_files: !self.shell.options().glob_matches_dotfiles,
			globstar: self.shell.options().enable_star_star_glob,
			cancel: self.params.cancel_token(),
		};

		let expansion =
			match pattern.expand(self.shell.filesystem(), self.shell.working_dir(), &options).await {
				Ok(expansion) => expansion,
				// A cancelled run stops here instead of running the command with
				// the word left literal.
				Err(err) if matches!(err.kind(), error::ErrorKind::Interrupted) => return Err(err),
				// On error (e.g. malformed pattern), default to NoGlob so the
				// field passes through as a literal rather than triggering failglob.
				Err(_) => patterns::PatternExpansionResult::default(),
			};

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
				// As above: divided only when one step cannot do it.
				Ok(vec![if field.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
					self.unquote_in_strides(field).await?
				} else {
					String::from(field)
				}])
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
					self
						.params
						.stderr(self.shell)
						.write_all_async(b"warning: command substitution: ignored null byte in input\n")
						.await?;
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
	///
	/// One piece can stand for a field per element of an array
	/// (`"${name[@]}"`), and quoting them comes after the expansion that made
	/// them has spent its last checkpoint, so each field quoted spends one. A
	/// piece with no fields spends one too, being a step of this loop.
	async fn process_double_quoted_pieces(
		&mut self,
		pieces: Vec<brush_parser::word::WordPieceWithSource>,
	) -> Result<Vec<WordField>, error::Error> {
		let mut fields: Vec<WordField> = vec![];
		let concatenation_joiner = self.shell.get_ifs_first_char();

		for piece in pieces {
			let Expansion { fields: this_fields, concatenate, .. } =
				self.expand_word_piece(piece.piece).await?;

			if this_fields.is_empty() {
				interp::loop_checkpoint(self.params).await?;
			}

			// The piece's first field joins the field before it.
			if concatenate {
				// Every field, joined by IFS's first character, makes one quoted
				// string; with no fields, an empty one.
				let mut concatenated = String::new();
				let mut budget = interp::ElementBudget::new();
				for (index, field) in this_fields.into_iter().enumerate() {
					// Every piece of the field is copied into `concatenated`, and
					// one field can be of any size.
					let long = field.len() > interp::DIVIDE_COPY_ABOVE_BYTES;
					if !long {
						let due = budget.charge(field.len());
						if due > 0 {
							interp::loop_checkpoints(self.params, due).await?;
						}
					}
					let WordField(pieces) = field;
					if index > 0 {
						concatenated.push(concatenation_joiner);
					}
					for piece in pieces {
						if long {
							interp::push_str_in_strides(self.params, &mut concatenated, piece.as_str())
								.await?;
						} else {
							concatenated.push_str(piece.as_str());
						}
					}
				}
				join_or_push(&mut fields, true, vec![ExpansionPiece::Unsplittable(concatenated)]);
			} else {
				let mut budget = interp::ElementBudget::new();
				for (index, field) in this_fields.into_iter().enumerate() {
					// The first field's pieces are copied onto the one before it.
					let due = budget.charge(if index == 0 { field.len() } else { 0 });
					if due > 0 {
						interp::loop_checkpoints(self.params, due).await?;
					}
					let WordField(pieces) = field;
					let pieces = pieces.into_iter().map(ExpansionPiece::make_unsplittable).collect();
					join_or_push(&mut fields, index == 0, pieces);
				}
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
						let expanded_default_value = self.expand_parameter_word(default_value).await?;
						let expanded_default_value = self.join_fields(expanded_default_value).await?;
						// The default is whatever the word expanded to, so the
						// copy the expansion keeps is divided.
						let kept = interp::clone_in_strides(self.params, &expanded_default_value).await?;
						let evaluated =
							self.assign_to_parameter(&parameter, expanded_default_value).await?;
						Ok(Expansion::from(evaluated.unwrap_or(kept)))
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
				transform_expansion(self.params, expanded_parameter, async |s| {
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
				transform_expansion(self.params, expanded_parameter, async |s| {
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

				transform_expansion(self.params, expanded_parameter, async |s| {
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

				transform_expansion(self.params, expanded_parameter, async |s| {
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
				expanded_parameter
					.polymorphic_subslice(expanded_offset as usize, end_offset as usize, self.params)
					.await
			},
			brush_parser::word::ParameterExpr::Transform {
				parameter,
				indirect,
				op: ParameterTransformOp::ToAttributeFlags,
			} => {
				let (name, _) = self.try_resolve_parameter_to_variable(&parameter, indirect).await?;
				let flags = name
					.and_then(|name| {
						self.shell.env().get(&name).map(|(_, var)| var.attribute_flags(self.shell))
					})
					.unwrap_or_default();
				Ok(flags.into())
			},
			brush_parser::word::ParameterExpr::Transform {
				parameter,
				indirect,
				op: ParameterTransformOp::ToAssignmentLogic,
			} => {
				let (name, index) = self.try_resolve_parameter_to_variable(&parameter, indirect).await?;
				if let Some(name) = name
					&& let Some((_, var)) = self.shell.env().get(&name)
				{
					// A value is as long as the script made it, and quoting it
					// and joining it to its name are each a pass over it:
					// `: "${big@A}"` held the worker 102 ms on 64 MiB. A value,
					// or the element an index names, is quoted and joined a
					// stride at a time.
					let value = var.value();
					let quoted = match (value, index.as_deref()) {
						(ShellValue::String(s), _) => Some(s.as_str().into()),
						(ShellValue::IndexedArray(_) | ShellValue::AssociativeArray(_), Some(index)) => {
							match value.get_at(index, self.shell) {
								Ok(Some(element)) => Some(element),
								_ => None,
							}
						},
						_ => None,
					};
					let assignable_value_str = match quoted {
						Some(text) => {
							escape::force_quote_divided(self.params, &text, escape::QuoteMode::SingleQuote)
								.await?
						},
						None if matches!(
							value,
							ShellValue::IndexedArray(_) | ShellValue::AssociativeArray(_)
						) =>
						{
							if index.is_some() {
								String::new()
							} else {
								value
									.format_divided(
										crate::variables::FormatStyle::DeclarePrint,
										self.shell,
										self.params,
									)
									.await?
							}
						},
						None => value.to_assignable_str(index.as_deref(), self.shell)?,
					};

					let mut attr_str = var.attribute_flags(self.shell);
					if attr_str.is_empty() {
						attr_str.push('-');
					}

					let text = match value {
                        ShellValue::IndexedArray(_)
                        | ShellValue::AssociativeArray(_)
                        // TODO(dynamic): confirm this
                        | ShellValue::Dynamic { .. } => {
                            let equals_or_nothing = if assignable_value_str.is_empty() {
                                ""
                            } else {
                                "="
                            };
                            let head = std::format!("declare -{attr_str} {name}{equals_or_nothing}");
                            joined_in_strides(self.params, &head, &assignable_value_str).await?
                        }
                        ShellValue::String(_) => {
                            joined_in_strides(self.params, &std::format!("{name}="), &assignable_value_str).await?
                        }
                        ShellValue::Unset(_) => std::format!("declare -{attr_str} {name}"),
                    };
					Ok(text.into())
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
				let mut budget = interp::ElementBudget::new();
				for field in expanded_parameter.fields {
					// `${name[@]…}` transforms one field per array element, and
					// the transform rewrites its whole text.
					let due = budget.charge(field.len());
					if due > 0 {
						interp::loop_checkpoints(self.params, due).await?;
					}
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

				transform_expansion(self.params, expanded_parameter, async |s| {
					Self::uppercase_first_char(s, expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::UppercasePattern { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(self.params, expanded_parameter, async |s| {
					Self::uppercase_pattern(s.as_str(), expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::LowercaseFirstChar { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(self.params, expanded_parameter, async |s| {
					Self::lowercase_first_char(s, expanded_pattern.as_ref())
				})
				.await
			},
			brush_parser::word::ParameterExpr::LowercasePattern { parameter, indirect, pattern } => {
				let expanded_parameter = self.expand_parameter(&parameter, indirect).await?;
				let expanded_pattern = self.basic_expand_opt_pattern(pattern).await?;

				transform_expansion(self.params, expanded_parameter, async |s| {
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

				transform_expansion(self.params, expanded_parameter, async |s| {
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
				let fields = if let Some((_, var)) = self.shell.env().get(variable_name) {
					self.element_fields(var.value(), true).await?
				} else {
					vec![]
				};

				Ok(Expansion { fields, concatenate, from_array: true, undefined: false })
			},
		}
	}

	async fn assign_to_parameter(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		value: String,
	) -> Result<Option<String>, error::Error> {
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

		// A variable with the integer attribute takes the value's arithmetic
		// value, as Bash gives it to `printf -v n 4*4` and `${n:=2+3}`, and
		// that value is returned, since `${n:=2+3}` expands to it.
		let integer =
			self.shell.env().get(variable_name).is_some_and(|(_, var)| var.is_treated_as_integer());
		let (value, evaluated) = if integer {
			let value = crate::variables::integer_value(self.shell, value).await?;
			(value.clone(), Some(value))
		} else {
			(value, None)
		};

		// Both of these assign a value the caller sized, and this is an
		// `async` caller with execution parameters: it takes the divided
		// route.
		if let Some(index) = index {
			self.shell
				.env_mut()
				.update_or_add_array_element_divided(
					variable_name,
					index,
					value,
					|_| Ok(()),
					env::EnvironmentLookup::Anywhere,
					env::EnvironmentScope::Global,
					self.params,
				)
				.await?;
		} else {
			self.shell
				.env_mut()
				.update_or_add(
					variable_name,
					crate::variables::ShellValueLiteral::Scalar(value),
					|_| Ok(()),
					env::EnvironmentLookup::Anywhere,
					env::EnvironmentScope::Global,
					self.params,
				)
				.await?;
		}
		Ok(evaluated)
	}

	/// Returns the name of the variable `parameter` refers to, and the index it
	/// names in it, if any.
	///
	/// Callers read the variable where it is stored: a copy of an array costs
	/// a pass over every element.
	async fn try_resolve_parameter_to_variable(
		&mut self,
		parameter: &brush_parser::word::Parameter,
		indirect: bool,
	) -> Result<(Option<String>, Option<String>), error::Error> {
		if !indirect {
			Ok(Self::try_resolve_parameter_to_variable_without_indirect(parameter))
		} else {
			let expansion = self.expand_parameter(parameter, false).await?;
			let parameter_str = self.join_fields(expansion).await?;
			let inner_parameter =
				brush_parser::word::parse_parameter(parameter_str.as_str(), &self.parser_options)?;
			Ok(Self::try_resolve_parameter_to_variable_without_indirect(&inner_parameter))
		}
	}

	fn try_resolve_parameter_to_variable_without_indirect(
		parameter: &brush_parser::word::Parameter,
	) -> (Option<String>, Option<String>) {
		match parameter {
			brush_parser::word::Parameter::Positional(_)
			| brush_parser::word::Parameter::Special(_) => (None, None),
			brush_parser::word::Parameter::Named(name) => (Some(name.to_owned()), Some("0".into())),
			brush_parser::word::Parameter::NamedWithIndex { name, index } => {
				(Some(name.to_owned()), Some(index.to_owned()))
			},
			brush_parser::word::Parameter::NamedWithAllIndices { name, concatenate: _concatenate } => {
				(Some(name.to_owned()), None)
			},
		}
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
			let parameter_str = self.join_fields(expansion).await?;
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
					self.expand_special_parameter(&brush_parser::word::SpecialParameter::ShellName).await
				} else if let Some(parameter) = self.shell.current_shell_args().get((p - 1) as usize) {
					copied_value(self.params, parameter).await
				} else {
					self.undefined_expansion(parameter, allow_unset_vars)
				}
			},
			brush_parser::word::Parameter::Special(s) => self.expand_special_parameter(s).await,
			brush_parser::word::Parameter::Named(n) => {
				// A name is as long as the text after a `$` that a variable made:
				// `$PWD` followed by 16 MiB of letters is one name.
				let long = n.len() > interp::DIVIDE_COPY_ABOVE_BYTES;
				let valid = if long {
					valid_variable_name_in_strides(self.params, n).await?
				} else {
					env::valid_variable_name(n.as_str())
				};
				if !valid {
					return Err(error::ErrorKind::BadSubstitution(n.clone()).into());
				}
				let var = if long {
					variable_by_long_name(self.params, self.shell.env(), n).await?
				} else {
					self.shell.env().get(n).map(|(_, var)| var)
				};
				if let Some(var) = var {
					if matches!(var.value(), ShellValue::Unset(_)) {
						self.undefined_expansion(parameter, allow_unset_vars)
					} else {
						let value = var.value().try_get_cow_str(self.shell);
						if let Some(value) = value {
							copied_value(self.params, &value).await
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
					copied_value(self.params, &value).await
				} else {
					self.undefined_expansion(parameter, allow_unset_vars)
				}
			},
			brush_parser::word::Parameter::NamedWithAllIndices { name, concatenate } => {
				let fields = if let Some((_, var)) = self.shell.env().get(name) {
					self.element_fields(var.value(), false).await?
				} else {
					vec![]
				};

				Ok(Expansion { fields, concatenate: *concatenate, from_array: true, undefined: false })
			},
		}
	}

	/// One field per element of `value`, or per key when `keys` is set:
	/// `${name[@]}` and `${!name[@]}`.
	///
	/// Each element is copied as its field is made, with a checkpoint: an
	/// array can hold any number of elements, and copying them waits on
	/// nothing. A dynamic value is resolved once, as
	/// [`crate::ShellVariable::resolve_value`] does.
	async fn element_fields(
		&self,
		value: &ShellValue,
		keys: bool,
	) -> Result<Vec<WordField>, error::Error> {
		let resolved;
		let value = if let ShellValue::Dynamic { getter, .. } = value {
			resolved = getter(&*self.shell);
			&resolved
		} else {
			value
		};

		match value {
			ShellValue::Unset(_) | ShellValue::Dynamic { .. } => Ok(vec![]),
			ShellValue::String(_) if keys => Ok(vec![WordField::from(String::from("0"))]),
			ShellValue::String(s) => Ok(vec![WordField::from(
				interp::clone_in_strides(self.params, s.as_str()).await?,
			)]),
			ShellValue::IndexedArray(array) if keys => {
				fields_from(self.params, array.keys().map(u64::to_string)).await
			},
			ShellValue::IndexedArray(array) => {
				fields_copied_from(self.params, array.values().map(String::as_str)).await
			},
			ShellValue::AssociativeArray(array) if keys => {
				fields_copied_from(self.params, array.keys().map(String::as_str)).await
			},
			ShellValue::AssociativeArray(array) => {
				fields_copied_from(self.params, array.values().map(String::as_str)).await
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

	async fn expand_special_parameter(
		&self,
		parameter: &brush_parser::word::SpecialParameter,
	) -> Result<Expansion, error::Error> {
		let expansion = match parameter {
			brush_parser::word::SpecialParameter::AllPositionalParameters { concatenate } => {
				Expansion {
					fields:      fields_copied_from(
						self.params,
						self.shell.current_shell_args().iter().map(String::as_str),
					)
					.await?,
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
				self.shell.last_background_pid().map_or_else(
					|| Expansion::from(String::new()),
					|pid| Expansion::from(pid.to_string()),
				)
			},
			brush_parser::word::SpecialParameter::ShellName => Expansion::from(
				self
					.shell
					.current_shell_name()
					.map_or_else(String::new, |name| name.to_string()),
			),
		};

		Ok(expansion)
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
				to_initial_capitals_divided(self.params, &s).await
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
					escape::force_quote_divided(self.params, s.as_str(), escape::QuoteMode::SingleQuote).await
				}
			},
			brush_parser::word::ParameterTransformOp::Quoted => {
				if came_from_undefined {
					Ok(String::new())
				} else {
					escape::force_quote_divided(self.params, s.as_str(), escape::QuoteMode::SingleQuote).await
				}
			},
			// The attributes' own conversions, a stride at a time for a long
			// value: `${big@U}` held the worker 25.9 ms on 64 MiB in one step.
			brush_parser::word::ParameterTransformOp::ToLowerCase => {
				crate::variables::ValueConverter::convert_divided(
					crate::variables::ShellVariableUpdateTransform::Lowercase,
					s,
					self.params,
				)
				.await
			},
			brush_parser::word::ParameterTransformOp::ToUpperCase => {
				crate::variables::ValueConverter::convert_divided(
					crate::variables::ShellVariableUpdateTransform::Uppercase,
					s,
					self.params,
				)
				.await
			},
			brush_parser::word::ParameterTransformOp::ToAssignmentLogic
			| brush_parser::word::ParameterTransformOp::ToAttributeFlags => {
				unreachable!("covered in caller")
			},
		}
	}
}

/// `${name@u}`: each character after whitespace, and the first, in its
/// uppercase form. The state between characters is one flag, carried from
/// stride to stride, so a long value is converted a stride at a time with
/// exactly the result of one pass.
async fn to_initial_capitals_divided(params: &ExecutionParameters, s: &str) -> Result<String, error::Error> {
	let mut result = String::with_capacity(s.len());
	let mut capitalize_next = true;
	let mut rest = s;
	while !rest.is_empty() {
		if s.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
			interp::stride_checkpoint(params).await?;
		}
		let mut end = rest.len().min(interp::BYTE_CHECKPOINT_STRIDE);
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		for c in piece.chars() {
			if c.is_whitespace() {
				capitalize_next = true;
				result.push(c);
			} else if capitalize_next {
				result.extend(c.to_uppercase());
				capitalize_next = false;
			} else {
				result.push(c);
			}
		}
		rest = remaining;
	}
	Ok(result)
}

/// Makes a field of each of `values`: there is one for every element of an
/// array or every positional parameter, and making one only moves a value the
/// caller already owns, so they spend a checkpoint every
/// [`interp::ELEMENT_CHECKPOINT_STRIDE`].
///
/// Use [`fields_copied_from`] where the values have to be copied out of
/// something the shell owns; one of them can be of any size.
async fn fields_from(
	params: &ExecutionParameters,
	values: impl Iterator<Item = String>,
) -> Result<Vec<WordField>, error::Error> {
	let mut fields = Vec::with_capacity(values.size_hint().0);
	let mut budget = interp::ElementBudget::new();
	for value in values {
		let due = budget.charge(0);
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		fields.push(WordField::from(value));
	}

	Ok(fields)
}

/// Makes a field of a copy of each of `values`, dividing a copy too large to
/// make in one step rather than only charging for it.
async fn fields_copied_from<'a>(
	params: &ExecutionParameters,
	values: impl Iterator<Item = &'a str>,
) -> Result<Vec<WordField>, error::Error> {
	let mut fields = Vec::with_capacity(values.size_hint().0);
	let mut budget = interp::ElementBudget::new();
	for value in values {
		if value.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
			fields.push(WordField::from(interp::clone_in_strides(params, value).await?));
			continue;
		}
		let due = budget.charge(value.len());
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		fields.push(WordField::from(value.to_owned()));
	}

	Ok(fields)
}

/// `head` followed by `tail`, with `tail`, which can be any length, copied a
/// stride at a time.
async fn joined_in_strides(
	params: &ExecutionParameters,
	head: &str,
	tail: &str,
) -> Result<String, error::Error> {
	let mut text = String::with_capacity(head.len() + tail.len());
	text.push_str(head);
	interp::push_str_in_strides(params, &mut text, tail).await?;
	Ok(text)
}

async fn transform_expansion<F, FReturn>(
	params: &ExecutionParameters,
	expansion: Expansion,
	mut f: F,
) -> Result<Expansion, error::Error>
where
	F: FnMut(String) -> FReturn,
	FReturn: Future<Output = Result<String, error::Error>>,
{
	let mut transformed_fields = vec![];
	let mut budget = interp::ElementBudget::new();
	for field in expansion.fields {
		// One field per array element when the parameter is an array, and the
		// transform rewrites its whole text.
		let due = budget.charge(field.len());
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
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
	let mut scan = BraceScan::default();
	scan.found_in(s) || scan.verdict()
}

/// [`may_contain_braces_to_expand`], spending a checkpoint before each stride
/// of `s`: the heuristic reads the whole of a word with no brace in it, and a
/// prompt of 16 MiB is such a word.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way.
async fn may_contain_braces_to_expand_in_strides(
	params: &ExecutionParameters,
	s: &str,
) -> Result<bool, error::Error> {
	let mut scan = BraceScan::default();
	let mut rest = s;
	while !rest.is_empty() {
		interp::stride_checkpoint(params).await?;
		let mut end = rest.len().min(interp::BYTE_CHECKPOINT_STRIDE);
		// A stride lands mid-character at most three bytes in.
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		if scan.found_in(piece) {
			return Ok(true);
		}
		rest = remaining;
	}
	Ok(scan.verdict())
}

/// What [`may_contain_braces_to_expand`] has seen so far, so that a word can be
/// read in pieces.
#[derive(Default)]
struct BraceScan {
	last_was_unescaped_dollar_sign: bool,
	last_was_escape:                bool,
	saw_opening_brace:              bool,
	saw_closing_brace:              bool,
}

impl BraceScan {
	/// Reads `s`, the text that follows whatever was read before, and returns
	/// true as soon as it finds a closing brace after an opening one.
	fn found_in(&mut self, s: &str) -> bool {
		// This is a completely inaccurate but quick heuristic used to see if
		// it's even worth properly parsing the string to find brace expressions.
		// It's mostly used to avoid more expensive parsing just because we've
		// encountered a brace used in a parameter expansion.
		for c in s.chars() {
			if !self.last_was_unescaped_dollar_sign {
				if c == '{' {
					self.saw_opening_brace = true;
				} else if c == '}' {
					self.saw_closing_brace = true;
					if self.saw_opening_brace {
						return true;
					}
				}
			}

			self.last_was_unescaped_dollar_sign = !self.last_was_escape && c == '$';
			self.last_was_escape = c == '\\';
		}
		false
	}

	/// The answer for everything read, once it has all been read.
	const fn verdict(&self) -> bool {
		self.saw_opening_brace && self.saw_closing_brace
	}
}

#[expect(clippy::panic_in_result_fn)]
#[cfg(test)]
mod tests {
	use anyhow::Result;

	use super::*;
	use crate::ShellVariable;

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

	/// `shopt -s globstar` must reach pathname expansion: `**` then recurses.
	/// Without it `**/*.rs` is `*/*.rs`, which matches nothing here and stays
	/// literal, as in bash.
	#[tokio::test]
	async fn test_globstar_option_reaches_pathname_expansion() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::create_dir_all(scratch.path().join("a/b"))?;
		std::fs::write(scratch.path().join("a/b/f.rs"), "")?;
		std::fs::write(scratch.path().join("g.rs"), "")?;

		let mut shell = crate::shell::Shell::builder().build().await?;
		shell.set_working_dir(scratch.path()).await?;
		let params = shell.default_exec_params();
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "**/*.rs").await?, vec!["**/*.rs"]);

		shell.options_mut().enable_star_star_glob = true; // shopt -s globstar
		let params = shell.default_exec_params();
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "**/*.rs").await?, vec!["a/b/f.rs", "g.rs"]);

		Ok(())
	}

	/// A cancelled run must reach the `**` walk, which then ends the expansion
	/// with an interrupt instead of running the command on a literal word.
	#[tokio::test]
	async fn test_globstar_walk_sees_the_run_cancellation() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::create_dir_all(scratch.path().join("a/b"))?;
		std::fs::write(scratch.path().join("a/b/f.rs"), "")?;

		let mut shell = crate::shell::Shell::builder().build().await?;
		shell.set_working_dir(scratch.path()).await?;
		shell.options_mut().enable_star_star_glob = true; // shopt -s globstar
		let mut params = shell.default_exec_params();
		let cancel = tokio_util::sync::CancellationToken::new();
		params.set_cancel_token(cancel.clone());
		cancel.cancel();

		let err = full_expand_and_split_word(&mut shell, &params, "**/*.rs")
			.await
			.expect_err("expansion ignored the cancellation");
		assert!(matches!(err.kind(), error::ErrorKind::Interrupted), "unexpected error: {err}");

		Ok(())
	}

	#[tokio::test]
	async fn test_brace_expansion() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let expander = WordExpander::new(&mut shell, &params);

		assert_eq!(expander.brace_expand_if_needed("abc").await?, "abc");
		assert_eq!(expander.brace_expand_if_needed("a{,b}d").await?, "ad abd");
		assert_eq!(expander.brace_expand_if_needed("a{b,c}d").await?, "abd acd");
		assert_eq!(expander.brace_expand_if_needed("a{1..3}d").await?, "a1d a2d a3d");
		assert_eq!(expander.brace_expand_if_needed(r#""{a,b}""#).await?, r#""{a,b}""#);
		assert_eq!(expander.brace_expand_if_needed("a{}b").await?, "a{}b");
		assert_eq!(expander.brace_expand_if_needed("a{ }b").await?, "a{ }b");
		assert_eq!(expander.brace_expand_if_needed("{a,b{1,2}}").await?, "a b1 b2");

		Ok(())
	}

	/// Regression test for issue #5819: a tilde that begins each element of a
	/// brace expansion must expand independently. Brace expansion joins its
	/// elements before the tilde/parameter/... pass, so `~/{a,b}` must yield
	/// `<HOME>/a` and `<HOME>/b` — not `<HOME>/a` followed by a literal `~/b`.
	#[tokio::test]
	async fn test_tilde_expands_for_every_brace_element() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		shell
			.env_mut()
			.set_global("HOME", ShellVariable::new(ShellValue::String("/home/user".to_string())))?;
		let params = shell.default_exec_params();

		assert_eq!(
			full_expand_and_split_word(&mut shell, &params, "~/project/{a,b}").await?,
			vec!["/home/user/project/a", "/home/user/project/b"],
		);
		// A bare `~/{a,b}` (tilde immediately followed by the brace) must also
		// expand on both elements.
		assert_eq!(
			full_expand_and_split_word(&mut shell, &params, "~/{a,b}").await?,
			vec!["/home/user/a", "/home/user/b"],
		);

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

		let fields = expander.split_fields(expansion).await?;

		assert_eq!(fields, vec![
			WordField(vec![ExpansionPiece::Unsplittable(String::from("A"))]),
			WordField(vec![ExpansionPiece::Unsplittable(String::new())])
		]);

		Ok(())
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn last_background_pid_is_inherited_by_nested_shells() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let result = shell
			.run_string("/bin/sleep 0.1 &", &crate::SourceInfo::default(), &params)
			.await?;
		assert!(result.is_success());
		let pid = shell.last_background_pid().expect("background process PID").to_string();

		for word in [
			r#""$(/bin/echo "$!" | /bin/cat)""#,
			r#""$( (/bin/echo "$!") )""#,
			r#""$(/bin/echo "$!")""#,
		] {
			assert_eq!(
				full_expand_and_split_word(&mut shell, &params, word).await?,
				vec![pid.clone()],
				"nested expansion: {word}"
			);
			assert_eq!(shell.last_background_pid().map(|pid| pid.to_string()), Some(pid.clone()));
		}
		shell.jobs_mut().wait_all().await?;
		assert_eq!(full_expand_and_split_word(&mut shell, &params, "\"$!\"").await?, vec![pid]);
		Ok(())
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn nested_background_child_shadows_only_in_its_own_shell() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		shell
			.run_string("/bin/sleep 0.1 &", &crate::SourceInfo::default(), &params)
			.await?;
		let parent = shell.last_background_pid().expect("background process PID").to_string();

		for word in [
			// `/bin/sleep`, not `/bin/true`, which macOS keeps in `/usr/bin`.
			r#""$(/bin/sleep 0 & /bin/echo "$!")""#,
			r#""$( (/bin/sleep 0 & /bin/echo "$!") )""#,
		] {
			let child = full_expand_and_split_word(&mut shell, &params, word).await?;
			assert_eq!(child.len(), 1, "nested expansion: {word}");
			assert!(child[0].parse::<i32>().is_ok(), "child PID: {}", child[0]);
			assert_ne!(child[0], parent, "new child must shadow inherited PID");
			assert_eq!(shell.last_background_pid().map(|pid| pid.to_string()), Some(parent.clone()));
		}
		shell.jobs_mut().wait_all().await?;
		Ok(())
	}

	/// A word long enough to take the stepped parse, with every kind of piece
	/// in it and literal text longer than a stride on either side of them.
	fn long_word_with_every_kind_of_piece() -> String {
		let literal = "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES);
		std::format!(
			"$PWD{literal}\"{literal}$v ${{v}} `echo b` $(echo c)\"'{literal}'$'{literal}\\x41'\\$~:~\
			 {literal}$((1+2))$[3]$\"g\"é"
		)
	}

	#[tokio::test]
	async fn a_long_word_parses_to_the_pieces_the_whole_parse_gives() -> Result<()> {
		let shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let options = shell.parser_options();
		let word = long_word_with_every_kind_of_piece();

		let stepped = parse_word_in_strides(&params, &word, &options).await?;
		let whole = brush_parser::word::parse(&word, &options)?;
		// The pieces compare for equality only where the parser is built for
		// its own tests or with `serde`.
		assert_eq!(std::format!("{stepped:?}"), std::format!("{whole:?}"));

		Ok(())
	}

	#[tokio::test]
	async fn a_long_word_expands_to_the_text_the_whole_parse_gives() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		shell.env_mut().set_global("v", ShellVariable::new("val"))?;
		let params = shell.default_exec_params();
		let literal = "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES + 1);

		let word = std::format!("{literal}\"$v ${{v}}\"'$v'$'\\x41'\\$\"{literal}\"$v");
		let expanded = basic_expand_word(&mut shell, &params, &word).await?;
		assert_eq!(expanded, std::format!("{literal}val val$vA${literal}val"));

		Ok(())
	}

	/// `$` and a name of any length is one parameter; the variable it names is
	/// found without hashing the name, and a variable whose name is the same
	/// length and differs only at its end is not taken for it.
	#[tokio::test]
	async fn a_long_variable_name_finds_only_the_variable_it_names() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let name = std::format!("PWD{}", "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES));
		let near = std::format!("PWD{}x", "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES - 1));
		shell.env_mut().set_global(near, ShellVariable::new("near"))?;
		let params = shell.default_exec_params();
		let word = std::format!("${name}/");

		assert_eq!(basic_expand_word(&mut shell, &params, &word).await?, "/");
		shell.env_mut().set_global(name.as_str(), ShellVariable::new("found"))?;
		assert_eq!(basic_expand_word(&mut shell, &params, &word).await?, "found/");

		Ok(())
	}

	/// Each loop over a long word spends a checkpoint, so a cancelled run stops
	/// before it reaches the end of the word.
	#[tokio::test]
	async fn a_long_word_sees_the_run_cancellation() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let name = "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES + 1024);
		shell.env_mut().set_global(name.as_str(), ShellVariable::new("v"))?;
		let options = shell.parser_options();
		let mut params = shell.default_exec_params();
		let cancel = tokio_util::sync::CancellationToken::new();
		params.set_cancel_token(cancel.clone());
		cancel.cancel();
		let word = std::format!("${name}");

		let interrupted = |err: &error::Error| matches!(err.kind(), error::ErrorKind::Interrupted);
		let err = parse_word_in_strides(&params, &word, &options)
			.await
			.expect_err("the parse ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");
		let err = may_contain_braces_to_expand_in_strides(&params, &word)
			.await
			.expect_err("the brace scan ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");
		let err = valid_variable_name_in_strides(&params, &name)
			.await
			.expect_err("the name check ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");
		let err = parse_brace_expansions_in_strides(&params, &word, &options)
			.await
			.expect_err("the brace parse ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");
		let err = variable_by_long_name(&params, shell.env(), &name)
			.await
			.expect_err("the lookup ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");
		let err = basic_expand_word(&mut shell, &params, &word)
			.await
			.expect_err("the expansion ignored the cancellation");
		assert!(interrupted(&err), "unexpected error: {err}");

		Ok(())
	}

	/// A long word with a brace expression in it expands to the words the whole
	/// brace parse gives, and one whose braces match nothing is left whole.
	#[tokio::test]
	async fn a_long_word_brace_expands_to_what_the_whole_parse_gives() -> Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let options = shell.parser_options();
		let literal = "h".repeat(interp::DIVIDE_COPY_ABOVE_BYTES);
		let listed = std::format!("x{{a,{literal}}}{literal}\"{{c,d}}\"{{1..2}}");
		let unmatched = std::format!("{{{literal}}}{literal}{{a}}");

		let pieces = brush_parser::word::parse_brace_expansions(&listed, &options)?
			.expect("the word has brace expressions");
		let whole = braceexpansion::generate_and_combine_brace_expansions(pieces, &params).await?;
		let expander = WordExpander::new(&mut shell, &params);
		let stepped = expander.brace_expand_words(&listed).await?;
		assert_eq!(stepped, whole);
		assert_eq!(expander.brace_expand_words(&unmatched).await?, vec![unmatched.as_str()]);

		Ok(())
	}

	/// The brace heuristic read a stride at a time gives the answer it gives
	/// read whole, with the characters it remembers from one character to the
	/// next on either side of a stride boundary.
	#[tokio::test]
	async fn the_brace_heuristic_in_strides_gives_the_same_answer() -> Result<()> {
		let shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let cases = [
			"${a}", "\\${a}", "\\\\${a}", "{a}", "}{", "{", "}", "a{b}c", "${a}{b}", "$${a}", "é{é}", "$é{}",
			"h",
		];
		for shift in 0..4 {
			let pad = "h".repeat(interp::BYTE_CHECKPOINT_STRIDE - shift);
			for case in cases {
				for word in [std::format!("{pad}{case}{pad}"), std::format!("{case}{pad}{pad}")] {
					assert_eq!(
						may_contain_braces_to_expand_in_strides(&params, &word).await?,
						may_contain_braces_to_expand(&word),
						"{case} at {shift}"
					);
				}
			}
		}

		Ok(())
	}

	#[tokio::test]
	async fn test_to_initial_capitals() -> Result<()> {
		let params = ExecutionParameters::default();
		assert_eq!(to_initial_capitals_divided(&params, "ab bc cd").await?, "Ab Bc Cd");
		assert_eq!(to_initial_capitals_divided(&params, " a ").await?, " A ");
		assert_eq!(to_initial_capitals_divided(&params, "").await?, "");
		// A value longer than a stride, with whitespace and a character whose
		// uppercase form is longer than it on each side of a stride's end,
		// gives what one pass over it gives.
		let pad = "x".repeat(interp::BYTE_CHECKPOINT_STRIDE - 2);
		let long = std::format!("{pad} ß ﬃ \tß{pad}ß");
		let one_pass: String = {
			let mut out = String::new();
			let mut next = true;
			for c in long.chars() {
				if c.is_whitespace() {
					next = true;
					out.push(c);
				} else if next {
					out.extend(c.to_uppercase());
					next = false;
				} else {
					out.push(c);
				}
			}
			out
		};
		assert_eq!(to_initial_capitals_divided(&params, &long).await?, one_pass);
		Ok(())
	}
}
