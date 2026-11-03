//! Whether Bash reads text with its parser while it expands a word.
//!
//! Reading text forgets the ended jobs a listing reported
//! (`notify_and_cleanup` in `shell_getc`), so the shell must know where
//! Bash reads. Bash 5.2 parses the text of a `$(...)`, `<(...)` or `>(...)`
//! when its extraction of a word for expansion meets it (`xparse_dolparen`,
//! called from `extract_command_subst` and `extract_process_subst`),
//! whether or not it then uses that part of the word. This module ports
//! that extraction from Bash's `braces.c` (`brace_gobbler`) and `subst.c`
//! (`expand_word_internal`, `param_expand`, `parameter_brace_expand`,
//! `extract_dollar_brace_string`, `extract_heredoc_dolbrace_string`,
//! `extract_delimited_string`, `skip_double_quoted`, `skip_matched_pair`,
//! `chk_arithsub`, `expand_arith_string`) and applies it to the word as
//! Bash's parser leaves it, which translates each `$'...'` first
//! (`read_token_word`, `parse_matched_pair` in `parse.y`). What Bash reads
//! only when it uses it, the operand a `${...}` selects, is left to the
//! expansion that uses it (see `expansion.rs`).

use crate::escape;

/// How Bash expands a word, which decides what it extracts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WordContext {
	/// A word Bash brace-expands before it expands it: a command word, a
	/// `for` word, a redirection target, an element of a compound
	/// assignment.
	BraceExpanded,
	/// A word Bash expands without brace expansion: an assignment value, a
	/// `case` word or pattern, a `[[ ]]` operand, a here-string.
	Plain,
	/// A here-document body (`Q_HERE_DOCUMENT`).
	HereDocument,
	/// Arithmetic text (`Q_DOUBLE_QUOTES|Q_ARITH`, without process
	/// substitution).
	Arithmetic,
}

/// Whether expanding `word` in `context` makes Bash read text with its
/// parser: true at the first `$(...)`, `<(...)` or `>(...)` its extraction
/// reads. `posix` is POSIX mode, `brace_expansion` the `-B` option.
pub(crate) fn reads_command_text(
	word: &str,
	context: WordContext,
	posix: bool,
	brace_expansion: bool,
) -> bool {
	let text = match context {
		WordContext::BraceExpanded | WordContext::Plain => normalize_word(word.as_bytes()),
		WordContext::HereDocument | WordContext::Arithmetic => word.as_bytes().to_vec(),
	};
	let scanner = Scanner { s: &text, posix };
	let scan = || -> Result<(), Parsed> {
		if context == WordContext::BraceExpanded && brace_expansion && text.contains(&b'{') {
			scanner.brace_scan()?;
		}
		match context {
			WordContext::HereDocument => scanner.word_scan(Q_HERE_DOCUMENT, false),
			WordContext::Arithmetic => scanner.arith_scan(),
			WordContext::BraceExpanded | WordContext::Plain => scanner.word_scan(0, false),
		}
	};
	scan().is_err()
}

/// The operand of a `%`, `#`, `/`, `^`, `,` or `:` expansion in a
/// here-document as Bash's extraction leaves it
/// (`extract_heredoc_dolbrace_string`), which is what Bash then expands:
/// each `$'...'` at the operand's own level single-quoted, one in a nested
/// `${...}` its value as it is, and each `$"..."` a double-quoted string.
/// `None` when the operand holds neither, or when the extraction read text
/// (the word's own scan counted that, see [`reads_command_text`]).
pub(crate) fn translate_heredoc_operand(operand: &str, posix: bool) -> Option<String> {
	if !operand.contains("$'") && !operand.contains("$\"") {
		return None;
	}
	let mut translated = Vec::with_capacity(operand.len());
	Scanner { s: operand.as_bytes(), posix }
		.extract_heredoc_dolbrace_string(0, SX_POSIXEXP | SX_WORD, Some(&mut translated))
		.ok()?;
	Some(String::from_utf8_lossy(&translated).into_owned())
}

/// Whether Bash reads text with its parser when it expands a here-document
/// operand as [`translate_heredoc_operand`] leaves it, which it does only
/// when it uses the operand: a pattern as `getpattern` expands it
/// (`Q_PATQUOTE`, no process substitution), the offset or length of `:`
/// (`arithmetic`) as `expand_arith_string` does. A nested `${...}` reads
/// its operand as it is extracted, whether or not it uses it.
pub(crate) fn heredoc_operand_reads_command_text(translated: &str, arithmetic: bool, posix: bool) -> bool {
	let scanner = Scanner { s: translated.as_bytes(), posix };
	if arithmetic { scanner.arith_scan() } else { scanner.word_scan(0, true) }.is_err()
}

/// Bash called its parser on the text being scanned (`xparse_dolparen`).
struct Parsed;

/// An index into the text, or the parse that ended the scan.
type Scan = Result<usize, Parsed>;

// Extraction flags, as Bash's `SX_*`.
const SX_NOALLOC: u8 = 1;
const SX_COMMAND: u8 = 2;
const SX_WORD: u8 = 4;
const SX_POSIXEXP: u8 = 8;
const SX_VARNAME: u8 = 16;

// Quoting modes, as Bash's `Q_*`.
const Q_DOUBLE_QUOTES: u8 = 1;
const Q_HERE_DOCUMENT: u8 = 2;
const Q_ARITH: u8 = 4;

// `extract_dollar_brace_string` states, as Bash's `DOLBRACE_*`.
const DOLBRACE_PARAM: u8 = 1;
const DOLBRACE_OP: u8 = 2;
const DOLBRACE_WORD: u8 = 4;
const DOLBRACE_QUOTE: u8 = 0x40;
const DOLBRACE_QUOTE2: u8 = 0x80;

/// The operator characters of `${param op word}`.
const OPERATOR_CHARS: &[u8] = b"#%^,~:-=?+/";

/// The next `extract_dollar_brace_string` state after `c`, at `pos`
/// characters into the expansion; the same in `parse_matched_pair`.
fn next_dolbrace_state(state: u8, c: u8, pos: usize) -> u8 {
	match (state, c) {
		(DOLBRACE_PARAM, b'%' | b'#' | b'^' | b',') if pos > 1 => DOLBRACE_QUOTE,
		(DOLBRACE_PARAM, b'/') if pos > 1 => DOLBRACE_QUOTE2,
		(DOLBRACE_PARAM, c) if OPERATOR_CHARS.contains(&c) => DOLBRACE_OP,
		(DOLBRACE_OP, c) if !OPERATOR_CHARS.contains(&c) => DOLBRACE_WORD,
		(state, _) => state,
	}
}

const fn is_blank(c: u8) -> bool {
	c == b' ' || c == b'\t'
}

/// Bash's extraction over one text.
struct Scanner<'a> {
	s: &'a [u8],
	posix: bool,
}

impl Scanner<'_> {
	/// The byte at `i`, or 0 past the end, as C's string end.
	fn at(&self, i: usize) -> u8 {
		self.s.get(i).copied().unwrap_or(0)
	}

	const fn len(&self) -> usize {
		self.s.len()
	}

	fn starts_with(&self, i: usize, prefix: &[u8]) -> bool {
		self.s.get(i..).is_some_and(|rest| rest.starts_with(prefix))
	}

	/// `brace_gobbler`, which `brace_expand` runs over every part of a word
	/// that holds a `{`: together its passes read the word once from start
	/// to end. Unquoted, and in double quotes, it reads each `$(` (and
	/// unquoted `<(`, `>(`) with `extract_command_subst`; in double quotes a
	/// single quote and a backquote quote nothing.
	fn brace_scan(&self) -> Result<(), Parsed> {
		let mut i = 0;
		let mut quoted = 0_u8;
		let mut pass_next = false;
		while i < self.len() {
			let c = self.s[i];
			if pass_next {
				pass_next = false;
				i += 1;
				continue;
			}
			if c == b'\\' && matches!(quoted, 0 | b'"' | b'`') {
				pass_next = true;
				i += 1;
				continue;
			}
			// `${` is read as `\{`.
			if c == b'$' && self.at(i + 1) == b'{' && quoted != b'\'' {
				pass_next = true;
				i += 1;
				continue;
			}
			let command = if quoted != 0 {
				if c == quoted {
					quoted = 0;
				}
				quoted == b'"' && c == b'$' && self.at(i + 1) == b'('
			} else if matches!(c, b'"' | b'\'' | b'`') {
				quoted = c;
				i += 1;
				continue;
			} else {
				matches!(c, b'$' | b'<' | b'>') && self.at(i + 1) == b'('
			};
			if command {
				i = self.extract_command_subst(i + 2, 0)? + 1;
			} else {
				i += 1;
			}
		}
		Ok(())
	}

	/// `expand_word_internal` in quoting mode `quoted`, for what it reads
	/// whatever the variables hold.
	fn word_scan(&self, quoted: u8, no_process_substitution: bool) -> Result<(), Parsed> {
		let mut i = 0;
		while i < self.len() {
			match self.s[i] {
				b'\\' => i += 2,
				b'<' | b'>'
					if self.at(i + 1) == b'('
						&& quoted & (Q_DOUBLE_QUOTES | Q_HERE_DOCUMENT) == 0
						&& !no_process_substitution
						&& !self.posix =>
				{
					return Err(Parsed);
				},
				b'$' => i = self.param_expand(i, quoted)?,
				b'`' => i = self.string_extract(i + 1, b"`", 0)? + 1,
				b'"' if quoted & (Q_DOUBLE_QUOTES | Q_HERE_DOCUMENT) == 0 || quoted & Q_ARITH != 0 => {
					let end = self.skip_double_quoted(i + 1, 0)?;
					// The extracted text is expanded again in double quotes.
					let content_end = if end > i + 1 && self.s[end - 1] == b'"' { end - 1 } else { end };
					Scanner { s: &self.s[i + 1..content_end], posix: self.posix }
						.word_scan(Q_DOUBLE_QUOTES | (quoted & Q_ARITH), no_process_substitution)?;
					i = end;
				},
				b'\'' if quoted & (Q_DOUBLE_QUOTES | Q_HERE_DOCUMENT) == 0 => {
					i = self.skip_single_quoted(i + 1);
				},
				_ => i += 1,
			}
		}
		Ok(())
	}

	/// `expand_arith_string`: the text is expanded only when it holds a
	/// character that starts an expansion.
	fn arith_scan(&self) -> Result<(), Parsed> {
		if self.s.iter().any(|&c| matches!(c, b'$' | b'`' | b'~')) {
			self.word_scan(Q_DOUBLE_QUOTES | Q_ARITH, true)
		} else {
			Ok(())
		}
	}

	/// `param_expand` at the `$` at `i`; returns the index after the
	/// expansion.
	fn param_expand(&self, i: usize, quoted: u8) -> Scan {
		match self.at(i + 1) {
			b'{' => self.parameter_brace_expand(i + 1, quoted),
			b'(' => {
				// Only a `$((` comes back: anything else is parsed.
				let end = self.extract_command_subst(i + 2, 0)?;
				let text = &self.s[(i + 2).min(self.len())..end.min(self.len())];
				// An arithmetic expansion has its text expanded; any other
				// `$((` is a command substitution its child parses.
				if let [b'(', inner @ .., b')'] = text
					&& chk_arithsub(inner, self.posix)
				{
					Scanner { s: inner, posix: self.posix }.arith_scan()?;
				}
				Ok(end + 1)
			},
			b'[' => {
				let end = self.extract_delimited_string(i + 2, b"$[", b"[", b"]", 0)?;
				Scanner { s: &self.s[(i + 2).min(self.len())..end.min(self.len())], posix: self.posix }
					.arith_scan()?;
				Ok(end + 1)
			},
			_ => Ok(i + 1),
		}
	}

	/// `parameter_brace_expand` at the `{` at `open`: the name, then the
	/// text after the operator, extracted whatever the operator does with
	/// it. Returns the index after the closing `}`.
	fn parameter_brace_expand(&self, open: usize, quoted: u8) -> Scan {
		let start = open + 1;
		let name_end = if self.at(start) == b'#' && (self.at(start + 1).is_ascii_alphabetic() || self.at(start + 1) == b'_')
		{
			self.string_extract(start, b"}", SX_VARNAME)?
		} else {
			self.string_extract(start, b"#%^,~:-=?+/@}", SX_VARNAME)?
		};
		let mut index = name_end;
		if name_end == start && self.at(start) == b'@' {
			index += 1;
		} else if self.at(start) == b'!' && index > start && self.at(index) == b'@' && self.at(index + 1) == b'}' {
			index += 1;
		}
		let special_length = |c: u8| matches!(c, b'-' | b'?' | b'#' | b'@');
		let indirect = |c: u8| (!self.posix && matches!(c, b'#' | b'?')) || matches!(c, b'@' | b'*');
		if (start == index && special_length(self.at(index)))
			|| (start == index && self.at(start) == b'#' && special_length(self.at(start + 1)))
			|| (start + 1 == index && self.at(start) == b'!' && indirect(self.at(index)))
		{
			index = self.string_extract(index + 1, b"#%:-=?+/@}", 0)?;
		}
		let mut c = self.at(index);
		if c != 0 {
			index += 1;
		}
		if c == b':' && matches!(self.at(index), b'-' | b'=' | b'?' | b'+') {
			c = self.at(index);
			if c != 0 {
				index += 1;
			}
		}
		if c == 0 || c == b'}' {
			return Ok(index);
		}
		let flags = if b"%#/^,:".contains(&c) { SX_POSIXEXP | SX_WORD } else { SX_WORD };
		Ok(self.extract_dollar_brace_string(index, quoted, flags)? + 1)
	}

	/// `string_extract`: up to a byte of `charlist`, past backslashed bytes
	/// and, for a name, its subscript.
	fn string_extract(&self, mut i: usize, charlist: &[u8], flags: u8) -> Scan {
		while i < self.len() {
			let c = self.s[i];
			if c == b'\\' {
				if i + 1 < self.len() {
					i += 1;
				} else {
					break;
				}
			} else if flags & SX_VARNAME != 0 && c == b'[' {
				let end = self.skip_matched_pair(i, b'[', b']', 0)?;
				if self.at(end) == b']' {
					i = end;
				}
			} else if charlist.contains(&c) {
				break;
			}
			i += 1;
		}
		Ok(i)
	}

	/// `skip_single_quoted`: the index after the closing quote.
	fn skip_single_quoted(&self, mut i: usize) -> usize {
		while i < self.len() && self.s[i] != b'\'' {
			i += 1;
		}
		if i < self.len() { i + 1 } else { i }
	}

	/// `string_extract_single_quoted`, with `allow_escape` for `$'...'`.
	fn extract_single_quoted(&self, mut i: usize, allow_escape: bool) -> usize {
		let mut pass_next = false;
		while i < self.len() {
			if pass_next {
				pass_next = false;
			} else if allow_escape && self.s[i] == b'\\' {
				pass_next = true;
			} else if self.s[i] == b'\'' {
				break;
			}
			i += 1;
		}
		if i < self.len() { i + 1 } else { i }
	}

	/// `skip_double_quoted` (and `string_extract_double_quoted`, which reads
	/// the same): the index after the closing quote.
	fn skip_double_quoted(&self, mut i: usize, flags: u8) -> Scan {
		let mut pass_next = false;
		let mut backquote = false;
		while i < self.len() {
			let c = self.s[i];
			if pass_next {
				pass_next = false;
			} else if c == b'\\' {
				pass_next = true;
			} else if backquote {
				if c == b'`' {
					backquote = false;
				}
			} else if c == b'`' {
				backquote = true;
			} else if c == b'$' && matches!(self.at(i + 1), b'(' | b'{') {
				let end = if self.at(i + 1) == b'(' {
					self.extract_command_subst(i + 2, SX_NOALLOC | flags)?
				} else {
					self.extract_dollar_brace_string(i + 2, Q_DOUBLE_QUOTES, SX_NOALLOC)?
				};
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			} else if c == b'"' {
				return Ok(i + 1);
			}
			i += 1;
		}
		Ok(i)
	}

	/// `extract_command_subst` after `$(`: a `$((` is extracted as text
	/// (`extract_delimited_string`), anything else is parsed.
	fn extract_command_subst(&self, i: usize, flags: u8) -> Scan {
		if self.at(i) == b'(' {
			self.extract_delimited_string(i, b"$(", b"(", b")", flags | SX_COMMAND)
		} else {
			Err(Parsed)
		}
	}

	/// `extract_delimited_string`: the index of the closer that matches,
	/// or the end of the text.
	fn extract_delimited_string(&self, mut i: usize, opener: &[u8], alt_opener: &[u8], closer: &[u8], flags: u8) -> Scan {
		let mut nesting = 1;
		let mut pass_next = false;
		let mut in_comment = false;
		while nesting > 0 {
			if i >= self.len() {
				return Ok(self.len());
			}
			let c = self.s[i];
			if in_comment {
				if c == b'\n' {
					in_comment = false;
				}
				i += 1;
				continue;
			}
			if pass_next {
				pass_next = false;
				i += 1;
				continue;
			}
			if flags & SX_COMMAND != 0 && c == b'#' && (i == 0 || self.s[i - 1] == b'\n' || is_blank(self.s[i - 1])) {
				in_comment = true;
				i += 1;
				continue;
			}
			if c == b'\\' {
				pass_next = true;
				i += 1;
				continue;
			}
			if flags & SX_COMMAND != 0 && c == b'$' && self.at(i + 1) == b'(' {
				let end = self.extract_command_subst(i + 2, flags | SX_NOALLOC)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if self.starts_with(i, opener) {
				let end = self.extract_delimited_string(i + opener.len(), opener, alt_opener, closer, flags | SX_NOALLOC)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if !alt_opener.is_empty() && self.starts_with(i, alt_opener) {
				let end = self.extract_delimited_string(
					i + alt_opener.len(),
					alt_opener,
					alt_opener,
					closer,
					flags | SX_NOALLOC,
				)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if self.starts_with(i, closer) {
				i += closer.len() - 1;
				nesting -= 1;
				if nesting == 0 {
					break;
				}
			}
			if c == b'`' {
				let end = self.string_extract(i + 1, b"`", flags | SX_NOALLOC)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if c == b'\'' {
				i = self.skip_single_quoted(i + 1);
				continue;
			}
			if c == b'"' {
				i = self.skip_double_quoted(i + 1, 0)?;
				continue;
			}
			i += 1;
		}
		Ok(i)
	}

	/// `extract_dollar_brace_string`: the index of the `}` that ends the
	/// expansion, or the end of the text.
	fn extract_dollar_brace_string(&self, mut i: usize, quoted: u8, flags: u8) -> Scan {
		let mut state = if flags & SX_WORD != 0 { DOLBRACE_WORD } else { DOLBRACE_PARAM };
		if quoted & (Q_HERE_DOCUMENT | Q_DOUBLE_QUOTES) != 0 && flags & SX_POSIXEXP != 0 {
			state = DOLBRACE_QUOTE;
		}
		if quoted == Q_HERE_DOCUMENT && state == DOLBRACE_QUOTE && flags & SX_NOALLOC == 0 {
			return self.extract_heredoc_dolbrace_string(i, flags, None);
		}
		let start = i;
		let mut saved_states = vec![state];
		let mut pass_next = false;
		let mut nesting = 1_usize;
		while i < self.len() {
			let mut c = self.s[i];
			if pass_next {
				pass_next = false;
				i += 1;
				continue;
			}
			if c == b'\\' {
				pass_next = true;
				i += 1;
				continue;
			}
			if c == b'$' && self.at(i + 1) == b'{' {
				if saved_states.len() <= nesting {
					saved_states.resize(nesting + 1, state);
				}
				saved_states[nesting] = state;
				nesting += 1;
				i += 2;
				if state == DOLBRACE_QUOTE || state == DOLBRACE_WORD {
					state = DOLBRACE_PARAM;
				}
				continue;
			}
			if c == b'}' {
				nesting -= 1;
				if nesting == 0 {
					break;
				}
				state = saved_states.get(nesting).copied().unwrap_or(saved_states[0]);
				i += 1;
				continue;
			}
			if c == b'`' {
				let end = self.string_extract(i + 1, b"`", flags | SX_NOALLOC)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if c == b'$' && self.at(i + 1) == b'(' {
				let end = self.extract_command_subst(i + 2, flags | SX_NOALLOC)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
				continue;
			}
			if matches!(c, b'<' | b'>') && self.at(i + 1) == b'(' {
				return Err(Parsed);
			}
			if c == b'"' {
				i = self.skip_double_quoted(i + 1, 0)?;
				continue;
			}
			if c == b'\'' {
				if self.posix && state != DOLBRACE_QUOTE && quoted & (Q_HERE_DOCUMENT | Q_DOUBLE_QUOTES) != 0 {
					i += 1;
				} else {
					i = self.skip_single_quoted(i + 1);
				}
				continue;
			}
			if c == b'[' && state == DOLBRACE_PARAM {
				let end = self.skip_matched_pair(i, b'[', b']', 0)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				if self.s[end] == b']' {
					i = end;
					c = b']';
				}
			}
			i += 1;
			state = next_dolbrace_state(state, c, i - start);
		}
		Ok(i)
	}

	/// `extract_heredoc_dolbrace_string`, which a here-document uses for an
	/// operator that quotes its pattern (`%`, `#`, `/`, `^`, `,`, `:`). With
	/// `operand` it also copies the operand there as Bash's result buffer
	/// holds it: each `$'...'` translated, single-quoted in a pattern and as
	/// it is elsewhere (`DOLBRACE_PARAM`, `DOLBRACE_OP`, `DOLBRACE_WORD`, in
	/// a nested `${...}`). Bash keeps the outer state when a nested `${...}`
	/// ends.
	fn extract_heredoc_dolbrace_string(&self, mut i: usize, flags: u8, mut operand: Option<&mut Vec<u8>>) -> Scan {
		let start = i;
		let mut state = DOLBRACE_QUOTE;
		let mut pass_next = false;
		let mut nesting = 1_usize;
		while i < self.len() {
			let c = self.s[i];
			let from = i;
			if pass_next {
				pass_next = false;
				i += 1;
			} else if c == b'\\' {
				pass_next = true;
				i += 1;
			} else if c == b'$' && self.at(i + 1) == b'\'' {
				if self.posix && state != DOLBRACE_QUOTE && state != DOLBRACE_QUOTE2 {
					i += 2;
				} else {
					let end = self.extract_single_quoted(i + 2, true);
					if let Some(operand) = operand.as_deref_mut() {
						let (_, value) = ansi_c_value(self.s, i + 2);
						if state == DOLBRACE_QUOTE || state == DOLBRACE_QUOTE2 {
							operand.extend_from_slice(&single_quote(&value));
						} else {
							operand.extend_from_slice(&value);
						}
					}
					i = end;
					continue;
				}
			} else if c == b'$' && self.at(i + 1) == b'"' {
				i = self.skip_double_quoted(i + 2, flags)?;
				if let Some(operand) = operand.as_deref_mut() {
					operand.extend_from_slice(&self.s[from + 1..i]);
				}
				continue;
			} else if c == b'$' && self.at(i + 1) == b'{' {
				nesting += 1;
				i += 2;
				if matches!(state, DOLBRACE_QUOTE | DOLBRACE_QUOTE2 | DOLBRACE_WORD) {
					state = DOLBRACE_PARAM;
				}
			} else if c == b'}' {
				nesting -= 1;
				if nesting == 0 {
					break;
				}
				i += 1;
			} else if c == b'`' {
				let end = self.string_extract(i + 1, b"`", flags)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
			} else if c == b'$' && self.at(i + 1) == b'(' {
				let end = self.extract_command_subst(i + 2, flags)?;
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
			} else if matches!(c, b'<' | b'>') && self.at(i + 1) == b'(' {
				return Err(Parsed);
			} else if c == b'\'' && self.posix && state != DOLBRACE_QUOTE {
				i += 1;
			} else if c == b'"' {
				i = self.skip_double_quoted(i + 1, flags)?;
			} else if c == b'\'' {
				i = self.extract_single_quoted(i + 1, false);
			} else {
				i += 1;
				state = next_dolbrace_state(state, c, i - start);
			}
			if let Some(operand) = operand.as_deref_mut() {
				operand.extend_from_slice(&self.s[from..i.min(self.len())]);
			}
		}
		Ok(i)
	}

	/// `skip_matched_pair` (with `skipsubscript` for `[`, `]`): the index of
	/// the matching `close`, or the end of the text.
	fn skip_matched_pair(&self, start: usize, open: u8, close: u8, flags: u8) -> Scan {
		let mut i = start + 1;
		let mut count = 1;
		let mut pass_next = false;
		let mut backquote = false;
		let literal = flags & 1 != 0;
		while i < self.len() {
			let c = self.s[i];
			if pass_next {
				pass_next = false;
				i += 1;
			} else if !literal && c == b'\\' {
				pass_next = true;
				i += 1;
			} else if backquote {
				if c == b'`' {
					backquote = false;
				}
				i += 1;
			} else if !literal && c == b'`' {
				backquote = true;
				i += 1;
			} else if !literal && c == open {
				count += 1;
				i += 1;
			} else if c == close {
				count -= 1;
				if count == 0 {
					break;
				}
				i += 1;
			} else if !literal && c == b'\'' {
				i = self.skip_single_quoted(i + 1);
			} else if !literal && c == b'"' {
				i = self.skip_double_quoted(i + 1, 0)?;
			} else if !literal && c == b'$' && matches!(self.at(i + 1), b'(' | b'{') {
				let after = i + 2;
				if after >= self.len() {
					return Ok(after);
				}
				let end = if self.at(i + 1) == b'(' {
					self.extract_delimited_string(after, b"$(", b"(", b")", SX_NOALLOC | SX_COMMAND)?
				} else {
					self.extract_dollar_brace_string(after, 0, SX_NOALLOC)?
				};
				if end >= self.len() {
					return Ok(self.len());
				}
				i = end + 1;
			} else {
				i += 1;
			}
		}
		Ok(i)
	}
}

/// `chk_arithsub`: whether the text of a `$((...))` has balanced
/// parentheses, so that it is an arithmetic expansion.
fn chk_arithsub(s: &[u8], posix: bool) -> bool {
	let scanner = Scanner { s, posix };
	let mut i = 0;
	let mut count = 0_i64;
	while i < s.len() {
		match s[i] {
			b'(' => count += 1,
			b')' => {
				count -= 1;
				if count < 0 {
					return false;
				}
			},
			_ => {},
		}
		match s[i] {
			b'\\' => i += 2,
			b'\'' => i = scanner.skip_single_quoted(i + 1),
			// A parse in a double-quoted string here is a parse Bash's
			// extraction of the `$((` already made.
			b'"' => match scanner.skip_double_quoted(i + 1, 0) {
				Ok(end) => i = end,
				Err(Parsed) => return true,
			},
			_ => i += 1,
		}
	}
	count == 0
}

/// The word as Bash's parser leaves it for expansion: each `$'...'`
/// outside double quotes becomes the single-quoted string of its value
/// (`read_token_word`), each `$"..."` a double-quoted string, and inside a
/// `${...}` both are translated as `parse_matched_pair` does.
fn normalize_word(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		match s[i] {
			b'\\' => {
				out.extend_from_slice(&s[i..(i + 2).min(s.len())]);
				i += 2;
			},
			b'\'' => {
				let end = Scanner { s, posix: false }.skip_single_quoted(i + 1);
				out.extend_from_slice(&s[i..end]);
				i = end;
			},
			b'"' => i = copy_double_quoted(s, i, &mut out),
			b'`' => i = copy_backquoted(s, i, &mut out),
			b'$' if s.get(i + 1) == Some(&b'\'') => {
				let (end, value) = ansi_c_value(s, i + 2);
				out.extend_from_slice(&single_quote(&value));
				i = end;
			},
			b'$' if s.get(i + 1) == Some(&b'"') => {
				i = copy_double_quoted(s, i + 1, &mut out);
			},
			b'$' if s.get(i + 1) == Some(&b'{') => {
				out.extend_from_slice(b"${");
				i = normalize_dolbrace(s, i + 2, false, &mut out);
			},
			b'$' | b'<' | b'>' if s.get(i + 1) == Some(&b'(') => i = copy_parenthesized(s, i, &mut out),
			b'$' if s.get(i + 1) == Some(&b'[') => i = copy_parenthesized(s, i, &mut out),
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	out
}

/// Copies the double-quoted string at `start` (its `"`), translating each
/// `${...}` inside it as a double-quoted one; a `$'` inside is literal.
fn copy_double_quoted(s: &[u8], start: usize, out: &mut Vec<u8>) -> usize {
	out.push(b'"');
	let mut i = start + 1;
	while i < s.len() {
		match s[i] {
			b'\\' => {
				out.extend_from_slice(&s[i..(i + 2).min(s.len())]);
				i += 2;
			},
			b'"' => {
				out.push(b'"');
				return i + 1;
			},
			b'`' => i = copy_backquoted(s, i, out),
			b'$' if s.get(i + 1) == Some(&b'{') => {
				out.extend_from_slice(b"${");
				i = normalize_dolbrace(s, i + 2, true, out);
			},
			b'$' if matches!(s.get(i + 1), Some(b'(' | b'[')) => i = copy_parenthesized(s, i, out),
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	i
}

/// Copies the backquoted text at `start` as it is.
fn copy_backquoted(s: &[u8], start: usize, out: &mut Vec<u8>) -> usize {
	let end = match (Scanner { s, posix: false }).string_extract(start + 1, b"`", 0) {
		Ok(end) => (end + 1).min(s.len()),
		Err(Parsed) => s.len(),
	};
	out.extend_from_slice(&s[start..end]);
	end
}

/// Copies the `$(...)`, `$((...))`, `$[...]`, `<(...)` or `>(...)` at
/// `start` as it is.
fn copy_parenthesized(s: &[u8], start: usize, out: &mut Vec<u8>) -> usize {
	let scanner = Scanner { s, posix: false };
	let (opener, closer): (&[u8], &[u8]) = if s.get(start + 1) == Some(&b'[') { (b"$[", b"]") } else { (b"$(", b")") };
	let alt: &[u8] = if closer == b"]" { b"[" } else { b"(" };
	let flags = if closer == b")" { SX_COMMAND } else { 0 };
	let end = match scanner.extract_delimited_string(start + 2, opener, alt, closer, flags) {
		Ok(end) => (end + 1).min(s.len()),
		// A command substitution nested in it: the rest of the word is
		// copied as it is.
		Err(Parsed) => s.len(),
	};
	out.extend_from_slice(&s[start..end]);
	end
}

/// Translates the inside of a `${...}` from `start` (after `${`) as
/// `parse_matched_pair` does with `P_DOLBRACE` (`dquote` for one within
/// double quotes), copying it with its closing `}`; returns the index after
/// it.
fn normalize_dolbrace(s: &[u8], start: usize, dquote: bool, out: &mut Vec<u8>) -> usize {
	let mut state = DOLBRACE_PARAM;
	let mut i = start;
	// The text this `${` collected so far, as `retind` in `parse_matched_pair`.
	let group_start = out.len();
	let mut pass_next = false;
	let mut was_dollar = false;
	let mut was_redirect = false;
	while i < s.len() {
		let c = s[i];
		i += 1;
		out.push(c);
		if pass_next {
			pass_next = false;
			continue;
		}
		if c == b'}' {
			return i;
		}
		if c == b'\\' {
			pass_next = true;
		}
		state = next_dolbrace_state(state, c, out.len() - group_start);
		if c == b'\'' && was_dollar {
			// `$'...'`: its value, single-quoted unless the expansion is in
			// double quotes where single quotes are not special.
			out.truncate(out.len() - 2);
			let (end, value) = ansi_c_value(s, i);
			if !dquote || state == DOLBRACE_QUOTE || state == DOLBRACE_QUOTE2 {
				out.extend_from_slice(&single_quote(&value));
			} else {
				out.extend_from_slice(&value);
			}
			i = end;
			was_dollar = false;
			was_redirect = false;
			continue;
		}
		if c == b'"' {
			if was_dollar {
				// `$"..."` is the double-quoted string.
				out.truncate(out.len() - 2);
			} else {
				out.pop();
			}
			i = copy_double_quoted(s, i - 1, out);
		} else if c == b'\'' {
			let end = Scanner { s, posix: false }.skip_single_quoted(i);
			out.extend_from_slice(&s[i..end]);
			i = end;
		} else if c == b'`' {
			out.pop();
			i = copy_backquoted(s, i - 1, out);
		} else if was_dollar && c == b'{' {
			i = normalize_dolbrace(s, i, dquote, out);
		} else if (was_dollar || was_redirect) && matches!(c, b'(' | b'[') {
			out.truncate(out.len() - 2);
			i = copy_parenthesized(s, i - 2, out);
		}
		was_redirect = matches!(c, b'<' | b'>') && !was_redirect;
		was_dollar = c == b'$' && !was_dollar;
	}
	i
}

/// The value of the `$'...'` whose text starts at `start` (after `$'`),
/// with the index after its closing quote. A NUL an escape produced ends
/// Bash's C string there, so the value stops before it; `ansi_c_value_nul`
/// says whether it did.
fn ansi_c_value(s: &[u8], start: usize) -> (usize, Vec<u8>) {
	let (end, mut value) = ansi_c_value_nul(s, start);
	if let Some(nul) = value.iter().position(|&b| b == 0) {
		value.truncate(nul);
	}
	(end, value)
}

/// [`ansi_c_value`] with a NUL an escape produced kept in the value.
fn ansi_c_value_nul(s: &[u8], start: usize) -> (usize, Vec<u8>) {
	let end = Scanner { s, posix: false }.extract_single_quoted(start, true);
	let content_end = if end > start && s.get(end - 1) == Some(&b'\'') { end - 1 } else { end };
	let content = String::from_utf8_lossy(&s[start..content_end]);
	let value = escape::expand_backslash_escapes_keeping_nul(&content, escape::EscapeExpansionMode::AnsiCQuotes)
		.map(|(value, _)| value)
		.unwrap_or_else(|_| content.as_bytes().to_vec());
	(end, value)
}

/// `sh_single_quote`: `'value'`, each `'` in it as `'\''`.
fn single_quote(value: &[u8]) -> Vec<u8> {
	let mut quoted = Vec::with_capacity(value.len() + 2);
	quoted.push(b'\'');
	for &c in value {
		if c == b'\'' {
			quoted.extend_from_slice(b"'\\''");
		} else {
			quoted.push(c);
		}
	}
	quoted.push(b'\'');
	quoted
}

/// The word of `${x:-word}` (and `+`, `=`, `?`) as Bash expands it within
/// double quotes or a here-document. Outside a here-document Bash's parser
/// has first translated the word's `$'...'` strings (see
/// [`translate_operand_ansi_c_strings`]). Then `string_extract_double_quoted`
/// with `SX_STRIPDQ` (`parameter_brace_expand_rhs`) removes each unescaped
/// double quote outside a `$(...)`, `${...}` or backquoted command, keeps a
/// backslash before `$`, `` ` ``, `"`, `\` and a newline inside such quotes
/// and before anything outside them, and drops it otherwise. The result is
/// then expanded as if double-quoted. A single quote is an ordinary
/// character here. The extent of a `$(...)` or `${...}` is the one Bash's
/// parser finds, here brush's word parser. Fails, as Bash's `bad
/// substitution`, when a translated `$'...'` leaves the expansion without
/// its closing `}`.
pub(crate) fn strip_embedded_double_quotes(
	word: &str,
	options: &brush_parser::ParserOptions,
	heredoc: bool,
) -> Result<String, crate::error::Error> {
	let translated;
	let word = if heredoc {
		word
	} else {
		translated = translate_operand_ansi_c_strings(word, options).map_err(|text| {
			crate::error::ErrorKind::BadSubstitution(std::format!("no closing `}}' after `{text}'"))
		})?;
		translated.as_str()
	};
	let mut out = String::with_capacity(word.len());
	let mut dquote = false;
	let mut backquote = false;
	let mut chars = word.char_indices().peekable();
	while let Some((i, c)) = chars.next() {
		if c == '\\' {
			let Some((_, next)) = chars.next() else {
				out.push('\\');
				break;
			};
			if !dquote || matches!(next, '$' | '`' | '"' | '\\' | '\n') {
				out.push('\\');
			}
			out.push(next);
			continue;
		}
		if backquote {
			backquote = c != '`';
			out.push(c);
			continue;
		}
		match c {
			'`' => {
				backquote = true;
				out.push(c);
			},
			'$' if matches!(chars.peek(), Some((_, '(' | '{'))) => {
				let rest = &word[i..];
				let end = substitution_end(rest, options).unwrap_or(rest.len());
				out.push_str(&rest[..end]);
				while chars.peek().is_some_and(|&(j, _)| j < i + end) {
					chars.next();
				}
			},
			'"' => dquote = !dquote,
			c => out.push(c),
		}
	}
	Ok(out)
}

/// The word of a double-quoted `${x:-word}` as Bash's parser leaves it
/// (`parse_matched_pair` with `P_DQUOTE|P_DOLBRACE`): each `$'...'` at the
/// word's own level becomes its value as it is, since single quotes are not
/// special in double quotes, and a later expansion reads that value. One
/// inside a single-quoted or double-quoted string or a backquoted command
/// stays as it is, and so does one inside a nested `$(...)` or `${...}`,
/// whose own expansion translates it. In POSIX mode a single quote in the
/// word quotes nothing, so the parser translates no `$'...'` there.
///
/// Bash then extracts the `${...}` again from the translated text
/// (`extract_dollar_brace_string`), so a value that leaves a quote open, or
/// holds a NUL that ends the parser's text, leaves the expansion without its
/// closing `}`: an error, `bad substitution`.
fn translate_operand_ansi_c_strings(word: &str, options: &brush_parser::ParserOptions) -> Result<String, String> {
	if options.posix_mode || !word.contains("$'") {
		return Ok(word.to_owned());
	}
	let mut out = String::with_capacity(word.len());
	let mut translated = false;
	let mut i = 0;
	while let Some(c) = word[i..].chars().next() {
		let rest = &word[i..];
		let next = rest[c.len_utf8()..].chars().next();
		let len = match (c, next) {
			('\\', Some(escaped)) => 1 + escaped.len_utf8(),
			('\'', _) => rest[1..].find('\'').map_or(rest.len(), |end| end + 2),
			('"', _) => quoted_end(rest, '"', options),
			('`', _) => quoted_end(rest, '`', options),
			('$', Some('\'')) => {
				let (end, value) = ansi_c_value_nul(rest.as_bytes(), 2);
				if value.contains(&0) {
					return Err(out);
				}
				out.push_str(&String::from_utf8_lossy(&value));
				translated = true;
				i += end;
				continue;
			},
			('$', Some('(' | '{')) => substitution_end(rest, options).unwrap_or(rest.len()),
			_ => c.len_utf8(),
		};
		out.push_str(&rest[..len]);
		i += len;
	}
	if translated {
		let mut text = Vec::with_capacity(out.len() + 1);
		text.extend_from_slice(out.as_bytes());
		text.push(b'}');
		let scanner = Scanner { s: &text, posix: false };
		if matches!(scanner.extract_dollar_brace_string(0, Q_DOUBLE_QUOTES, SX_WORD | SX_NOALLOC), Ok(end) if end >= text.len()) {
			return Err(out);
		}
	}
	Ok(out)
}

/// The length of the double-quoted string or backquoted command that starts
/// `text` with `quote`, through its closing quote: a backslash quotes the
/// next character, and in a double-quoted string a `$(...)`, `${...}` or
/// backquoted command is skipped whole.
fn quoted_end(text: &str, quote: char, options: &brush_parser::ParserOptions) -> usize {
	let mut i = 1;
	while let Some(c) = text[i..].chars().next() {
		let rest = &text[i..];
		i += match c {
			'\\' => 1 + rest[1..].chars().next().map_or(0, char::len_utf8),
			c if c == quote => return i + 1,
			'`' if quote == '"' => quoted_end(rest, '`', options),
			'$' if quote == '"' && matches!(rest[1..].chars().next(), Some('(' | '{')) => {
				substitution_end(rest, options).unwrap_or(rest.len())
			},
			c => c.len_utf8(),
		};
	}
	text.len()
}

/// The length of the `$(...)` or `${...}` that starts `text`: the shortest
/// prefix ending in its closer that brush's word parser reads as that one
/// substitution.
fn substitution_end(text: &str, options: &brush_parser::ParserOptions) -> Option<usize> {
	let closer = if text[1..].starts_with('(') { ')' } else { '}' };
	text.char_indices()
		.filter(|&(_, c)| c == closer)
		.map(|(index, _)| index + 1)
		.find(|&end| {
			brush_parser::word::parse(&text[..end], options)
				.is_ok_and(|pieces| pieces.len() == 1 && pieces[0].end_index == end)
		})
}

#[cfg(test)]
mod tests {
	use super::{
		WordContext, heredoc_operand_reads_command_text, reads_command_text, strip_embedded_double_quotes,
		translate_heredoc_operand,
	};

	#[test]
	fn extraction_reads_what_bash_reads() {
		let word = |w: &str| reads_command_text(w, WordContext::BraceExpanded, false, true);
		assert!(word("$(:)"));
		assert!(!word("$((1))"));
		assert!(word("$((1+$(echo 0)))"));
		assert!(!word("$((:); :)"));
		assert!(word("${x:-$(:)}"));
		assert!(!word("${x:-'$(:)'}"));
		assert!(word(r#""${x:-'$(:)'}""#));
		assert!(!word("`$(:)`"));
		assert!(word(r#""${x:-`echo $(:)`}""#));
		assert!(!word(r#""`echo $(:)`""#));
		assert!(word("$[1+$(echo 0)]"));
		assert!(word("${x:-<(:)}"));
		assert!(!word(r"\$(:)"));
		assert!(!word("${x:-$'$(:)'}"));
		assert!(word(r#""${x:-$'\x24(echo 0)'}""#));
		let heredoc = |w: &str| reads_command_text(w, WordContext::HereDocument, false, true);
		assert!(!heredoc("${y:-'$(echo 0)'}"));
		assert!(heredoc("'$(echo 0)'"));
		// A pattern's own `$'...'` is single-quoted; one in a nested `${...}`
		// is its value as it is, which the pattern's expansion reads.
		assert!(!heredoc("${x/${y:-$'$(echo 0)'}}"));
		let operand = |w: &str| translate_heredoc_operand(w, false).expect("translated");
		assert_eq!(operand("${y:-$'$(echo 0)'}"), "${y:-$(echo 0)}");
		assert_eq!(operand(r"$'a\tb'"), "'a\tb'");
		assert_eq!(operand(r"${y#$'a\tb'}"), "${y#'a\tb'}");
		assert_eq!(translate_heredoc_operand("${y:-a}", false), None);
		let reads = |w: &str, arithmetic| heredoc_operand_reads_command_text(&operand(w), arithmetic, false);
		assert!(reads("${y:-$'$(echo 0)'}", false));
		assert!(reads("${y:-$'$(echo 0)'}", true));
		assert!(!reads("$'$(echo 0)'", false));
		assert!(!reads("${y#$'$(echo 0)'}", false));
		assert!(!reads("${y:-'$(echo 0)'}x$'b'", false));
	}

	#[test]
	fn a_double_quoted_operand_translates_its_own_ansi_c_strings() {
		let options = brush_parser::ParserOptions::default();
		let strip = |w: &str| strip_embedded_double_quotes(w, &options, false).ok();
		let ok = |w: &str| Some(w.to_owned());
		assert_eq!(strip(r"$'a\tb'"), ok("a\tb"));
		assert_eq!(strip(r#""$'a\tb'""#), ok("$'atb'"));
		assert_eq!(strip(r#""$'\x24(echo 0)'""#), ok("$'x24(echo 0)'"));
		assert_eq!(strip(r"'$'a\tb''"), ok(r"'$'a\tb''"));
		assert_eq!(strip(r"'a'$'\tb'"), ok("'a'\tb"));
		assert_eq!(strip(r"${y:-$'\t'}"), ok(r"${y:-$'\t'}"));
		assert_eq!(strip(r"$'\x24{x:-Y}'"), ok("${x:-Y}"));
		// A value that leaves a quote open, or holds a NUL, leaves the
		// expansion without its closing brace.
		assert_eq!(strip(r#"$'\"'"#), None);
		assert_eq!(strip(r"$'\''"), None);
		assert_eq!(strip(r"$'\\'"), None);
		assert_eq!(strip(r"$'a\0b'"), None);
		// A here-document's operand is not translated.
		assert_eq!(strip_embedded_double_quotes(r"$'a\tb'", &options, true).ok(), ok(r"$'a\tb'"));
	}
}
