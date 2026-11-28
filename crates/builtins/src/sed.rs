//! `sed` builtin stream editor.
//!
//! Ported from uutils sed 0.1.1.
//!
//! Pattern and hold spaces preserve raw bytes. Regular expressions retain
//! Unicode character semantics on valid UTF-8 and use single-byte C-locale
//! matching on lines that are not valid UTF-8.

// Program entry point and CLI processing
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

pub mod command {
// Definitions for the compiled code data structures
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::path::PathBuf; // For file descriptors and equivalent
use std::{
	cell::RefCell,
	collections::HashMap,
	fmt,
	io::{BufRead, BufReader},
	rc::Rc,
};

use crate::{
	host::{Host, ShellPaths},
	sed::error_handling::SedResult,
};

use crate::sed::{
	error_handling::{ScriptLocation, read_error},
	fast_regex::{Captures, Match, Regex},
	named_writer::NamedWriter,
	script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};

#[derive(Debug, Default, Clone)]
#[allow(dead_code, reason = "upstream options retained for command-line compatibility")]
/// Compilation and processing options provided mostly through the
/// command-line interface
pub struct ProcessingContext {
	// Command-line flags with corresponding names
	pub all_output_files: bool,
	pub debug:            bool,
	pub regex_extended:   bool,
	pub follow_symlinks:  bool,
	pub in_place:         bool,
	pub in_place_suffix:  Option<String>,
	pub length:           usize,
	pub quiet:            bool,
	pub posix:            bool,
	pub separate:         bool,
	pub sandbox:          bool,
	pub unbuffered:       bool,
	pub null_data:        bool,
	/// Resolves paths embedded in scripts (`r`, `w`, `s///w`, `-f`) the way
	/// the shell would open them, and supplies the filesystem that every
	/// sed file access (including `-i`) goes through.
	pub paths:            ShellPaths,

	// Other context
	/// Where GNU locates script errors found at run time: the end of the script.
	pub script_end:           String,
	/// Currently processed input file operand, `-` for standard input
	pub input_name:           PathBuf,
	/// Current input line number
	pub line_number:          usize,
	/// True if this is the last address of a range
	pub last_address:         bool,
	/// True if the line read is the last line
	pub last_line:            bool,
	/// True if the file is the last file of the ones specified
	pub last_file:            bool,
	/// Stop processing further input.
	pub stop_processing:      bool,
	/// Previously compiled RE, saved for reuse when specifying an empty RE.
	/// Shared, never cloned: a cloned `Regex` starts with an empty match cache.
	pub saved_regex:          Option<Rc<Regex>>,
	/// True while the saved RE is one an address supplied and no `s//` has reused.
	pub saved_regex_from_address: bool,
	/// True once a `$` address was checked on the current input's last line,
	/// where GNU reads ahead through the following operands.
	pub looked_past_input:    bool,
	/// Modification of input processing action
	// This is required to avoid doubly borrowing the reader in the 'N'
	// command.
	pub input_action: Option<InputAction>,
	/// Hold space
	pub hold:                 ByteSpace,
	/// Nesting of { } at compile time
	pub parsed_block_nesting: usize,
	/// Command associated with each label
	pub label_to_command_map: HashMap<String, Rc<RefCell<Command>>>,
	/// Commands with a (latchable and resetable) address range
	pub range_commands:       Vec<Rc<RefCell<Command>>>,
	/// True if a substitution was made as specified in the t command
	pub substitution_made:    bool,
	/// Elements to append at the end of each command processing cycle
	pub append_elements:      Vec<AppendElement>,
	/// `R` inputs by file name as written, so commands naming the same file share one handle (GNU).
	pub line_sources:         HashMap<PathBuf, Rc<RefCell<LineSource>>>,
}

impl ProcessingContext {
	/// Return the record separator for this invocation.
	pub(super) fn separator(&self) -> u8 {
		if self.null_data { 0 } else { b'\n' }
	}
}

#[derive(Clone, Debug)]
/// Elements that shall be appended at the end of each command processing cycle
pub enum AppendElement {
	Text(Rc<str>), // The specified text string
	Path(PathBuf), // The contents of the specified file path
	Line(Vec<u8>), // A line read by `R`, written exactly as read
}

/// The file an `R` command reads one line from per execution; it stays open across cycles.
pub struct LineSource {
	path:   PathBuf,
	stdin:  bool,
	reader: LineSourceState,
}

/// Progress of an `R` input: opened on first use, closed at end of file or when unreadable.
enum LineSourceState {
	Unopened,
	Open(Box<dyn BufRead>),
	Closed,
}

impl LineSource {
	/// Creates the input for `path` as the script names it; `stdin` reads the builtin's standard input.
	pub fn new(path: PathBuf, stdin: bool) -> Self {
		Self { path, stdin, reader: LineSourceState::Unopened }
	}

	/// Returns the next line with its terminator, or `None` at end of file or if the file can't be opened.
	pub fn next_line(&mut self, host: &Host, separator: u8) -> SedResult<Option<Vec<u8>>> {
		if matches!(self.reader, LineSourceState::Unopened) {
			self.reader = if self.stdin {
				LineSourceState::Open(Box::new(BufReader::new(host.stdin.file().clone())))
			} else {
				match host.fs().open(host.resolve(&self.path)) {
					Ok(file) => LineSourceState::Open(Box::new(BufReader::new(file))),
					Err(_) => LineSourceState::Closed,
				}
			};
		}
		let LineSourceState::Open(reader) = &mut self.reader else {
			return Ok(None);
		};
		let mut line = Vec::new();
		if reader.read_until(separator, &mut line).map_err(|e| read_error(&self.path, &e))? == 0 {
			self.reader = LineSourceState::Closed;
			return Ok(None);
		}
		Ok(Some(line))
	}
}

impl fmt::Debug for LineSource {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("LineSource").field("path", &self.path).finish_non_exhaustive()
	}
}

#[derive(Clone, Debug, Default, PartialEq)]
/// Owned hold space, with the line terminator stored separately.
pub struct ByteSpace {
	pub content:    Vec<u8>, // Content without the record separator
	pub terminated: bool,    // True if a separator followed the content
}

#[derive(Debug)]
/// Types of address specifications that precede commands
pub enum Address {
	Re(Option<Rc<Regex>>), // Line that matches (optional) regex
	Line(usize),       // Specific line
	RelLine(usize),    // Relative line
	Last,              // Last line
	StepMatch(usize),  // Lines matching specified step from first
	StepEnd(usize),    // Range ending at specified step from first
}

#[derive(Debug)]
/// A single part of an RE replacement
pub enum ReplacementPart {
	Literal(String),      // Normal text
	WholeMatch,           // &
	Group(u32),           // \1 to \9
	Case(CaseConversion), // \U, \L, \E, \u, \l (GNU extension)
	Unconverted(char),    // \ before a non-ASCII character: copied as it is
}

/// A case conversion of the text that follows it in a replacement
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseConversion {
	Upper,     // \U: upper case, until \L or \E
	Lower,     // \L: lower case, until \U or \E
	End,       // \E: no conversion
	UpperNext, // \u: upper case the next character
	LowerNext, // \l: lower case the next character
}

#[derive(Clone, Copy)]
enum Case {
	Upper,
	Lower,
}

impl Case {
	/// Map `ch` as GNU sed's `towupper` and `towlower` do in a UTF-8
	/// locale: by Unicode's simple mapping, one character to one. Where the
	/// full mapping is several characters (`ß`, `ﬁ`), the simple one is the
	/// character itself, apart from the Greek small letters with
	/// ypogegrammeni, whose upper case is the letter with prosgegrammeni,
	/// and `İ`, whose lower case is `i`.
	fn map(self, ch: char) -> char {
		match self {
			Self::Upper => {
				let mut upper = ch.to_uppercase();
				match (upper.next(), upper.next()) {
					(Some(one), None) => one,
					_ => match ch {
						'\u{1f80}'..='\u{1f87}'
						| '\u{1f90}'..='\u{1f97}'
						| '\u{1fa0}'..='\u{1fa7}' => char::from_u32(ch as u32 + 8).unwrap_or(ch),
						'\u{1fb3}' => '\u{1fbc}',
						'\u{1fc3}' => '\u{1fcc}',
						'\u{1ff3}' => '\u{1ffc}',
						_ => ch,
					},
				}
			},
			Self::Lower => {
				let mut lower = ch.to_lowercase();
				match (lower.next(), lower.next()) {
					(Some(one), None) => one,
					_ if ch == '\u{130}' => 'i',
					_ => ch,
				}
			},
		}
	}
}

/// The case conversions in force while a replacement is appended.
#[derive(Default)]
struct CaseState {
	/// `\U` or `\L`, until `\E`
	run:     Option<Case>,
	/// `\u` or `\l`, for the next character appended
	next:    Option<Case>,
	/// `next` has passed over an empty group, which it does once
	carried: bool,
}

impl CaseState {
	fn set(&mut self, conversion: CaseConversion) {
		match conversion {
			CaseConversion::Upper => (self.run, self.next) = (Some(Case::Upper), None),
			CaseConversion::Lower => (self.run, self.next) = (Some(Case::Lower), None),
			CaseConversion::End => (self.run, self.next) = (None, None),
			CaseConversion::UpperNext => (self.next, self.carried) = (Some(Case::Upper), false),
			CaseConversion::LowerNext => (self.next, self.carried) = (Some(Case::Lower), false),
		}
	}

	/// Append one piece of the replacement, converted as GNU sed does: a
	/// byte that is no character is copied, and drops a `\u` or `\l` not
	/// yet used, while `\U` and `\L` go on past it; a NUL ends the
	/// conversion of the piece, whose rest is copied as it is.
	fn append(&mut self, text: &[u8], result: &mut Vec<u8>) {
		if self.run.is_none() && self.next.is_none() {
			// No conversion is pending: copy the piece without reading it.
			result.extend_from_slice(text);
			return;
		}
		if text.is_empty() {
			// An empty group passes a `\u` or `\l` on to what follows it.
			if self.next.is_some() {
				if self.carried {
					self.next = None;
				}
				self.carried = !self.carried;
			}
			return;
		}
		let mut next = self.next.take();
		let mut copied = 0;
		'chunks: for chunk in text.utf8_chunks() {
			for ch in chunk.valid().chars() {
				// Past a `\u` or `\l` alone, the rest is copied as it is.
				let Some(case) = next.take().or(self.run) else {
					break 'chunks;
				};
				if ch == '\0' {
					break 'chunks;
				}
				result.extend_from_slice(case.map(ch).encode_utf8(&mut [0; 4]).as_bytes());
				copied += ch.len_utf8();
			}
			next = None;
			result.extend_from_slice(chunk.invalid());
			copied += chunk.invalid().len();
		}
		result.extend_from_slice(&text[copied..]);
	}

	/// Append an escaped non-ASCII character. GNU sed copies it as it is,
	/// and drops a `\u` or `\l` not yet used, while `\U` and `\L` go on.
	fn append_unconverted(&mut self, ch: char, result: &mut Vec<u8>) {
		self.next = None;
		result.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
	}
}

// The maximum value allowed in regex quantifier
pub const RE_DUP_MAX: usize = 32767;

/// Regex modes (BRE or ERE)
#[derive(Copy, Clone, Debug)]
pub enum RegexMode {
	Basic,
	Extended,
}

#[derive(Debug)]
/// All specified replacements for an RE
pub struct ReplacementTemplate {
	pub parts:            Vec<ReplacementPart>,
	pub max_group_number: usize, // Highest used group number (e.g. 8 for \8)
}

impl Default for ReplacementTemplate {
	/// Create an empty template.
	fn default() -> Self {
		ReplacementTemplate::new(Vec::new())
	}
}

impl ReplacementTemplate {
	/// Construct from the parts
	pub fn new(parts: Vec<ReplacementPart>) -> Self {
		let max_group_number = parts
			.iter()
			.filter_map(|part| match part {
				ReplacementPart::Group(n) => Some(*n),
				_ => None,
			})
			.max()
			.unwrap_or(0);

		Self { parts, max_group_number: max_group_number.try_into().unwrap() }
	}

	/// Append the replacement for a match, using original bytes from its captures;
	/// a group the regex lacks expands to nothing, as in GNU.
	pub fn apply_captures(&self, caps: &Captures, result: &mut Vec<u8>) {
		let mut case = CaseState::default();
		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => case.append(s.as_bytes(), result),
				ReplacementPart::WholeMatch => case.append(caps.get(0).unwrap().as_bytes(), result),
				ReplacementPart::Group(n) => {
					case.append(caps.get(*n as usize).map_or(&[][..], |m| m.as_bytes()), result);
				},
				ReplacementPart::Case(conversion) => case.set(*conversion),
				ReplacementPart::Unconverted(ch) => case.append_unconverted(*ch, result),
			}
		}
	}

	/// Apply the template to the given RE single match.
	pub fn apply_match(&self, m: &Match, result: &mut Vec<u8>) {
		let mut case = CaseState::default();
		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => case.append(s.as_bytes(), result),
				ReplacementPart::WholeMatch => case.append(m.as_bytes(), result),
				ReplacementPart::Group(_) => panic!("unexpected Regex group replacement"),
				ReplacementPart::Case(conversion) => case.set(*conversion),
				ReplacementPart::Unconverted(ch) => case.append_unconverted(*ch, result),
			}
		}
	}
}

#[derive(Debug, Default)]
/// Substitution command
pub struct Substitution {
	pub regex:       Option<Rc<Regex>>,   // Regular expression
	pub replacement: ReplacementTemplate, // Specified broken-down replacement
	pub occurrence:  usize,               // Which occurrence to substitute
	pub global:      bool,                // True if 'g' flag: also replace every later occurrence
	pub print_flag:  bool,                // True if 'p' flag
	pub ignore_case: bool,                // True if 'I' flag
	pub execute:     bool,                // True if 'e' flag (GNU extension)
	pub multiline:   bool,                // True if 'm' or 'M' flag (GNU extension)
	pub write_file:  Option<Rc<RefCell<NamedWriter>>>, // Writer to file if 'w' flag is used
}

/// The block of the first and most common Unicode characters:
/// ASCII, Latin Extended, Greek, Curillic, Coptic, Arabic, etc.
/// It comprises all UCS-2 characters.  We use a fast lookup array for these.
const COMMON_UNICODE: usize = 2048;

#[derive(Debug)]
/// Transliteration command (y)
pub struct Transliteration {
	fast: [char; COMMON_UNICODE],
	slow: HashMap<char, char>,
}

impl Default for Transliteration {
	/// Create a new Transliteration with identity mapping for the fast-path.
	fn default() -> Self {
		let mut fast = ['\0'; COMMON_UNICODE];
		for (i, slot) in fast.iter_mut().enumerate() {
			*slot = char::from_u32(i as u32).unwrap_or('\0');
		}
		Self { fast, slow: HashMap::new() }
	}
}

impl Transliteration {
	/// Create through character mappings from `source` to `target`.
	pub fn from_strings(source: &str, target: &str) -> Self {
		let mut result = Self::default();
		for (from, to) in source.chars().zip(target.chars()) {
			result.insert(from, to);
		}
		result
	}

	/// Set a transliteration mapping from one character to another.
	fn insert(&mut self, from: char, to: char) {
		let cp = from as usize;
		if cp < COMMON_UNICODE {
			self.fast[cp] = to;
		} else {
			self.slow.insert(from, to);
		}
	}

	/// Look up a character transliteration.
	pub fn lookup(&self, ch: char) -> char {
		let cp = ch as usize;
		if cp < COMMON_UNICODE {
			self.fast[cp]
		} else {
			self.slow.get(&ch).copied().unwrap_or(ch)
		}
	}
}

#[derive(Debug)]
/// An internally compiled command.
pub struct Command {
	pub code:       char,                         // Command code
	pub addr1:      Option<Address>,              // Start address
	pub addr2:      Option<Address>,              // End address
	pub non_select: bool,                         // True if '!'
	pub start_line: Option<usize>,                // Start line number (or None if unlatched)
	pub data:       CommandData,                  // Command-specific data
	pub next:       Option<Rc<RefCell<Command>>>, // Pointer to next command
	pub location:   ScriptLocation,               // Command's definition location
}

impl Default for Command {
	fn default() -> Self {
		Command {
			code:       '_',
			addr1:      None,
			addr2:      None,
			non_select: false,
			start_line: None,
			data:       CommandData::None,
			next:       None,
			location:   ScriptLocation::default(),
		}
	}
}

impl Command {
	/// Construct with position information from the given providers.
	pub fn at_position(lines: &ScriptLineProvider, line: &ScriptCharProvider) -> Self {
		Command { location: ScriptLocation::at_position(lines, line), ..Default::default() }
	}
}

#[derive(Debug)]
/// Command-specific data
/// After parsing, t, b Label elements are converted into BranchTarget ones.
pub enum CommandData {
	None,
	BranchTarget(Option<Rc<RefCell<Command>>>), // Commands for 'b', 't', '{'
	Label(Option<String>),                      // Label name for 'b', 't', ':'
	Path(PathBuf),                              // File path for 'r'
	LineSource(Rc<RefCell<LineSource>>),        // Line-at-a-time input for 'R' (GNU)
	NamedWriter(Rc<RefCell<NamedWriter>>),      // File output for 'w'
	Number(usize),                              // Number for 'l', 'q', 'Q' (GNU)
	Substitution(Box<Substitution>),            // Substitute command 's'
	Text(Rc<str>),                              // Text for 'a', 'c', 'i'; command for 'e' (GNU)
	Transliteration(Box<Transliteration>),      // Transliteration command 'y'
}

#[derive(Debug, Clone)]
/// Action to execute after reading a new input line
pub struct InputAction {
	/// Next command to execute (rather than commands from start)
	pub next_command: Option<Rc<RefCell<Command>>>,
	/// Data to prepend to the read contents
	pub prepend:      Vec<u8>,
	/// Whether the pending pattern space had a trailing separator.
	pub terminated:   bool,
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sed::fast_io::IOChunk;

	// Return the captures for the RE applied to the specified string
	fn caps_for<'a>(re: &str, chunk: &'a mut IOChunk) -> Captures<'a> {
		Regex::new(re)
			.unwrap()
			.captures(chunk)
			.unwrap()
			.expect("captures")
	}

	#[test]
	// s/foo//
	fn test_empty_template() {
		let template = ReplacementTemplate::default();
		let input = &mut IOChunk::new_from_str("foo");
		let caps = caps_for("foo", input);

		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert!(result.is_empty());
	}

	#[test]
	// s/abc/hello/
	fn test_literal_only() {
		let template = ReplacementTemplate::new(vec![ReplacementPart::Literal("hello".into())]);
		let input = &mut IOChunk::new_from_str("abc");
		let caps = caps_for("abc", input);

		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert_eq!(result, b"hello");
	}

	#[test]
	// s/foo\d+/got: &/
	fn test_whole_match() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("got: ".into()),
			ReplacementPart::WholeMatch,
		]);
		let input = &mut IOChunk::new_from_str("foo42");
		let caps = caps_for(r"foo\d+", input);

		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert_eq!(result, b"got: foo42");
	}

	#[test]
	// s/foo(\d+)/number: \1/
	fn test_backreference() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("number: ".into()),
			ReplacementPart::Group(1),
		]);
		let input = &mut IOChunk::new_from_str("foo42");
		let caps = caps_for(r"foo(\d+)", input);

		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert_eq!(result, b"number: 42");
	}

	#[test]
	// s/(\w+):(\d+)/key: \1, value: \2/
	fn test_multiple_parts() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("key: ".into()),
			ReplacementPart::Group(1),
			ReplacementPart::Literal(", value: ".into()),
			ReplacementPart::Group(2),
		]);
		let input = &mut IOChunk::new_from_str("x:123");
		let caps = caps_for(r"(\w+):(\d+)", input);

		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert_eq!(result, b"key: x, value: 123");
	}

	#[test]
	// s/(\w+):(\d+)/key: \1, value: \3/
	fn test_missing_group_expands_to_nothing() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("key: ".into()),
			ReplacementPart::Group(1),
			ReplacementPart::Literal(", value: ".into()),
			ReplacementPart::Group(3),
		]);
		let input = &mut IOChunk::new_from_str("x:123");
		let caps = caps_for(r"(\w+):(\d+)", input);

		// A group the reused regex lacks expands to nothing, as in GNU.
		let mut result = Vec::new();
		template.apply_captures(&caps, &mut result);
		assert_eq!(result, b"key: x, value: ");
	}

	// max_group_number
	#[test]
	fn test_max_group_number_with_groups() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("a".into()),
			ReplacementPart::Group(2),
			ReplacementPart::WholeMatch,
			ReplacementPart::Group(5),
			ReplacementPart::Literal("z".into()),
		]);
		assert_eq!(template.max_group_number, 5);
	}

	#[test]
	fn test_max_group_number_without_groups() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("no".into()),
			ReplacementPart::WholeMatch,
			ReplacementPart::Literal("groups".into()),
		]);
		assert_eq!(template.max_group_number, 0);
	}

	// Transliteration
	// Creation and internal functions
	#[test]
	fn test_identity_lookup_fast_path() {
		let t = Transliteration::default();
		assert_eq!(t.lookup('A'), 'A');
		assert_eq!(t.lookup('z'), 'z');
		assert_eq!(t.lookup('\u{07FF}'), '\u{07FF}'); // highest 2-byte UTF-8 char
	}

	#[test]
	fn test_identity_lookup_slow_path() {
		let t = Transliteration::default();
		assert_eq!(t.lookup('\u{0800}'), '\u{0800}'); // just outside fast path
		assert_eq!(t.lookup('\u{1F600}'), '\u{1F600}'); // 😀
	}

	#[test]
	fn test_insert_and_lookup_fast_path() {
		let mut t = Transliteration::default();
		t.insert('a', 'α');
		t.insert('b', 'β');
		assert_eq!(t.lookup('a'), 'α');
		assert_eq!(t.lookup('b'), 'β');
		assert_eq!(t.lookup('c'), 'c'); // unchanged
	}

	#[test]
	fn test_insert_and_lookup_slow_path() {
		let mut t = Transliteration::default();
		t.insert('🦀', 'c'); // U+1F980 Crab emoji -> 'c'
		assert_eq!(t.lookup('🦀'), 'c');
		assert_eq!(t.lookup('🦁'), '🦁'); // unchanged
	}

	#[test]
	fn test_overwrite_mapping() {
		let mut t = Transliteration::default();
		t.insert('x', '1');
		assert_eq!(t.lookup('x'), '1');
		t.insert('x', '2');
		assert_eq!(t.lookup('x'), '2');
	}

	#[test]
	fn test_all_fast_path_mapped_to_space() {
		let mut t = Transliteration::default();
		for cp in 0..COMMON_UNICODE {
			if let Some(ch) = char::from_u32(cp as u32) {
				t.insert(ch, ' ');
			}
		}
		assert_eq!(t.lookup('A'), ' ');
		assert_eq!(t.lookup('\u{07FF}'), ' ');
	}

	// from_strings
	#[test]
	fn test_basic_transliteration() {
		let t = Transliteration::from_strings("abcδ", "1234");

		assert_eq!(t.lookup('a'), '1');
		assert_eq!(t.lookup('b'), '2');
		assert_eq!(t.lookup('c'), '3');
		assert_eq!(t.lookup('δ'), '4');
		assert_eq!(t.lookup('e'), 'e'); // not mapped, fallback
	}

	#[test]
	fn test_unicode_slow_path() {
		let source = "é漢🦀";
		let target = "e文c";
		let t = Transliteration::from_strings(source, target);

		assert_eq!(t.lookup('é'), 'e');
		assert_eq!(t.lookup('漢'), '文');
		assert_eq!(t.lookup('🦀'), 'c');
		assert_eq!(t.lookup('x'), 'x'); // fast fallback
		assert_eq!(t.lookup('文'), '文'); // slow fallback
	}

	#[test]
	fn test_overwrite_fast_path() {
		let t = Transliteration::from_strings("aa", "12");
		assert_eq!(t.lookup('a'), '2'); // last mapping wins
	}
}
}
pub mod compiler {
// Compile the scripts into the internal representation of commands
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{cell::RefCell, mem, path::PathBuf, rc::Rc};

use crate::sed::error_handling::{SedError, SedResult};

use crate::openfile::OpenFile;
use crate::host::ShellPaths;
use crate::sed::{
	command::{
		Address, CaseConversion, Command, CommandData, LineSource, ProcessingContext, RegexMode,
		ReplacementPart, ReplacementTemplate, Substitution, Transliteration,
	},
	delimited_parser::{ERR_UNTERMINATED_Y, parse_char_escape, parse_regex, parse_transliteration},
	error_handling::{
		ScriptLocation, compilation_error, compilation_error_before, compilation_error_through_newline,
		invalid_reference, newline_delimiter_error, semantic_error,
	},
	fast_regex::Regex,
	named_writer::NamedWriter,
	script_char_provider::ScriptCharProvider,
	script_line_provider::{ScriptLineProvider, ScriptValue},
};

const DEFAULT_OUTPUT_WIDTH: usize = 60;

// Diagnostics worded as GNU sed 4.9 (sed/compile.c).
const ERR_ADDRESS_0_USAGE: &str = "invalid usage of line address 0";
const ERR_SANDBOX: &str = "e/r/w commands disabled in sandbox mode";
const ERR_UNKNOWN_OPTION_TO_S: &str = "unknown option to `s'";
const ERR_UNTERMINATED_S: &str = "unterminated `s' command";
const ERR_UNTERMINATED_ADDRESS: &str = "unterminated address regex";
const ERR_MISSING_FILENAME: &str = "missing filename in r/R/w/W commands";
const ERR_EXPECTED_TEXT: &str = "expected \\ after `a', `c' or `i'";

// Handling required after processing a command
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandHandling {
	GetNext,  // Get next command and process that: !
	Return,   // Return from the sequence parser: }
	Continue, // Continue sequence parsing: all other commands
}

/// The type of functions that compile individual commands
type CommandHandler = fn(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling>;

// Command specification
#[derive(Debug, Clone, Copy)]
struct CommandSpec {
	n_addr:  usize,          // Number of supported addresses
	handler: CommandHandler, // Argument-specific command compilation handler
}

/// Compile the scripts into an executable data structure.
#[cfg(test)]
pub fn compile(
	scripts: Vec<ScriptValue>,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	compile_with_provider(ScriptLineProvider::new(scripts), context)
}

/// Compiles scripts with access to the builtin standard input.
pub fn compile_with_stdin(
	scripts: Vec<ScriptValue>,
	context: &mut ProcessingContext,
	stdin: OpenFile,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	let provider = ScriptLineProvider::with_stdin(scripts, stdin, context.paths.clone());
	compile_with_provider(provider, context)
}

fn compile_with_provider(
	mut make_providers: ScriptLineProvider,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {

	let mut empty_line = ScriptCharProvider::new("");
	let result = compile_sequence(&mut make_providers, &mut empty_line, context)?;
	context.script_end = make_providers.end_origin();

	// Comment-out the following to show the compiled script.
	#[cfg(any())]
	dbg!(&result);

	// Link branch commands to the target label commands.
	populate_label_map(result.clone(), context);
	populate_range_commands(result.clone(), context);
	resolve_branch_targets(result.clone(), context)?;

	// Link the ends of command blocks to their following commands.
	// This converts the tree into a graph, so it must be the last
	// conversion that traverses the structure as a tree.
	patch_block_endings(result.clone());

	Ok(result)
}

/// For every Command in the top-level `head` chain, look for
/// `CommandData::BranchTarget(Some(sub_head))` '{' commands.
/// Recursively patch the sub-chain, then splice its tail back to the
/// original “next” pointer of the *parent* (falling back to its own
/// parent_next if its own next was `None`).
fn patch_block_endings(head: Option<Rc<RefCell<Command>>>) {
	fn patch_block_endings_to_parent(
		mut cur: Option<Rc<RefCell<Command>>>,
		parent_next: Option<Rc<RefCell<Command>>>,
	) {
		while let Some(rc_cmd) = cur {
			// Borrow mutably just long enough to inspect/rewire this node
			let cmd = rc_cmd.borrow_mut();
			// Save this node’s own next pointer
			let own_next = cmd.next.clone();
			// Decide what “splice target” to use:
			//   - if this node has its own_next, use that
			//   - otherwise, fall back to parent_next
			let splice_target = own_next.clone().or(parent_next.clone());

			// If it has a sub-block, recurse and then patch its tail
			if let CommandData::BranchTarget(Some(ref sub_head)) = cmd.data
				&& cmd.code == '{'
			{
				// 1) recurse into the sub-chain, passing splice_target
				patch_block_endings_to_parent(Some(sub_head.clone()), splice_target.clone());

				// 2) find the tail of that sub-chain
				let mut tail = sub_head.clone();
				loop {
					let next_in_sub = tail.borrow().next.clone();
					match next_in_sub {
						Some(n) => tail = n,
						None => break,
					}
				}

				// 3) splice the tail’s `.next` to splice_target
				tail.borrow_mut().next.clone_from(&splice_target);
			}

			// drop the borrow before moving on
			drop(cmd);

			// advance to the next sibling in this level
			cur = own_next;
		}
	}

	// top-level has no parent, so pass None
	patch_block_endings_to_parent(head, None);
}

/// Populate the context's label map with references to associated commands.
/// Like GNU sed, a label defined twice resolves to its last definition.
fn populate_label_map(mut cur: Option<Rc<RefCell<Command>>>, context: &mut ProcessingContext) {
	while let Some(rc_cmd) = cur.take() {
		// Borrow mutably just long enough to inspect/rewire this node
		let cmd = rc_cmd.borrow_mut();

		// Extract any label to insert after borrow ends
		let maybe_label = match &cmd.data {
			CommandData::BranchTarget(Some(sub_head)) => {
				populate_label_map(Some(sub_head.clone()), context);
				None
			},
			CommandData::Label(Some(label)) => Some(label.clone()),
			_ => None,
		};

		if let Some(label) = maybe_label
			&& cmd.code == ':'
		{
			context.label_to_command_map.insert(label, rc_cmd.clone());
		}

		cur.clone_from(&cmd.next);
	}
}

/// Populate the context's address range command list with references to
/// associated commands.
fn populate_range_commands(mut cur: Option<Rc<RefCell<Command>>>, context: &mut ProcessingContext) {
	while let Some(rc_cmd) = cur.take() {
		// Borrow mutably just long enough to inspect/rewire this node
		let cmd = rc_cmd.borrow_mut();

		// Recursively process blocks.
		if let CommandData::BranchTarget(Some(sub_head)) = &cmd.data {
			populate_range_commands(Some(Rc::clone(sub_head)), context);
		}

		if cmd.addr2.is_some() {
			// Save detected range command.
			context.range_commands.push(Rc::clone(&rc_cmd));
		}

		cur.clone_from(&cmd.next);
	}
}

/// Replace branch labels with references to the corresponding commands.
/// Raise an error on undefined labels.
fn resolve_branch_targets(
	mut cur: Option<Rc<RefCell<Command>>>,
	context: &mut ProcessingContext,
) -> SedResult<()> {
	while let Some(rc_cmd) = cur.take() {
		// Borrow mutably just long enough to inspect/rewire this node
		let mut cmd = rc_cmd.borrow_mut();

		// Recurse into blocks
		if let CommandData::BranchTarget(Some(sub_head)) = &cmd.data {
			resolve_branch_targets(Some(sub_head.clone()), context)?;
		}

		// Only for 't' or 'b' commands:
		if matches!(cmd.code, 't' | 'b') {
			// Take ownership of the current data
			let old_data = mem::replace(&mut cmd.data, CommandData::None);

			// Build the replacement
			let new_data = match old_data {
				CommandData::Label(Some(label)) => {
					// GNU reports this without a location and with its panic status, 4.
					let target = context
						.label_to_command_map
						.get(&label)
						.cloned()
						.ok_or_else(|| {
							SedError::new(4, format!("can't find label for jump to `{label}'"))
						})?;
					CommandData::BranchTarget(Some(target))
				},
				CommandData::Label(None) => CommandData::BranchTarget(None),
				other => other, // put back anything else unchanged
			};

			// Store it back
			cmd.data = new_data;
		}

		// Advance to the next sibling
		cur.clone_from(&cmd.next);
	}
	Ok(())
}

/// Compile provided scripts into a sequence of commands.
fn compile_sequence(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	let mut head: Option<Rc<RefCell<Command>>> = None;
	let mut tail: Option<Rc<RefCell<Command>>> = None;

	loop {
		line.eat_spaces();

		// According to POSIX: "If the first two characters in the script are
		// "#n", the default output shall be suppressed".
		if !line.eol() && line.current() == '#' && lines.get_line_number() == 1 && line.get_pos() == 0
		{
			line.advance();
			if !line.eol() && line.current() == 'n' {
				context.quiet = true;
			}
			// Ignore rest of line
			while !line.eol() {
				line.advance();
			}
		}

		if line.eol() || line.current() == '#' {
			match lines.next_line()? {
				None => {
					return Ok(head);
				},
				Some(line_string) => {
					*line = ScriptCharProvider::new(&line_string);
				},
			}
			continue;
		} else if line.current() == ';' {
			line.advance();
			continue;
		}

		let mut cmd = Rc::new(RefCell::new(Command::at_position(lines, line)));
		let n_addr = compile_address_range(lines, line, &mut cmd, context)?;
		line.eat_spaces();
		let mut cmd_spec = get_verified_cmd_spec(lines, line, n_addr, context.posix)?;
		// Compile the command according to its specification.
		let mut cmd_mut = cmd.borrow_mut();
		cmd_mut.code = line.current();
		match (cmd_spec.handler)(lines, line, &mut cmd_mut, context)? {
			CommandHandling::GetNext => {
				cmd_spec = get_verified_cmd_spec(lines, line, n_addr, context.posix)?;
				cmd_mut.code = line.current();
				(cmd_spec.handler)(lines, line, &mut cmd_mut, context)?;
			},
			CommandHandling::Return => return Ok(head),
			CommandHandling::Continue => (),
		}
		drop(cmd_mut);

		if let Some(ref t) = tail {
			// there's already a tail: link it
			t.borrow_mut().next = Some(cmd.clone());
		} else {
			// first element: set head
			head = Some(cmd.clone());
		}
		tail = Some(cmd);
	}
}

/// Return true if c is a valid character for specifying a context address
fn is_address_char(c: char) -> bool {
	matches!(c, '0'..='9' | '/' | '\\' | '$')
}

/// Compile a command's optional address range into cmd.
/// Return the number of addresses encountered.
fn compile_address_range(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Rc<RefCell<Command>>,
	context: &ProcessingContext,
) -> SedResult<usize> {
	let mut n_addr = 0;
	let mut cmd = cmd.borrow_mut();

	let mut is_line0 = false;

	line.eat_spaces();
	if !line.eol() && is_address_char(line.current()) {
		let addr1 = compile_address(lines, line, context)?;
		is_line0 = matches!(addr1, Address::Line(0));
		cmd.addr1 = Some(addr1);
		n_addr += 1;
	}

	line.eat_spaces();
	// ~ steps are a GNU extension; under --posix a `~` is an unknown command.
	if n_addr == 1 && !line.eol() && (line.current() == ',' || (line.current() == '~' && !context.posix))
	{
		let is_step_match = line.current() == '~'; // E.g. 0~2: Pick even-numbered lines
		line.advance();
		line.eat_spaces();
		// E.g. /foo/,~10: Start at foo, include all lines until multiple of 10 is reached.
		let is_step_end = !is_step_match && !context.posix && !line.eol() && line.current() == '~';
		if is_step_end {
			line.advance();
			line.eat_spaces();
		}

		if is_step_match || is_step_end {
			// GNU reads a missing step as 0.
			let step = parse_number(lines, line, false)?.unwrap_or(0);
			if is_line0 && is_step_end {
				return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
			}
			cmd.addr2 =
				Some(if is_step_match { Address::StepMatch(step) } else { Address::StepEnd(step) });
		} else {
			if line.eol() || !(is_address_char(line.current()) || line.current() == '+') {
				return compilation_error(lines, line, "unexpected `,'");
			}
			let addr2 = compile_address(lines, line, context)?;
			// Address 0 is a GNU extension that only pairs with a closing regex.
			if is_line0 && (context.posix || !matches!(addr2, Address::Re(_))) {
				return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
			}
			cmd.addr2 = Some(addr2);
		}
		n_addr += 1;
	}

	// Zero-address read command check
	if is_line0 && n_addr == 1 {
		// After retrieval of first address, subsequent spaces
		// are consumed unconditionally. By now, the position
		// must be in non-whitespace character or EOL.
		if context.posix || line.eol() || line.current() != 'r' {
			return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
		}
	}

	Ok(n_addr)
}

/// Read the line's remaining characters as a file path and return it.
fn read_file_path(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<PathBuf> {
	let path = read_argument(line);
	if path.is_empty() {
		compilation_error(lines, line, ERR_MISSING_FILENAME)
	} else {
		// resolve `r`/`w`/`s///w` file
		// operands against the shell working directory.
		Ok(PathBuf::from(path))
	}
}

/// Skip the command character and leading whitespace, and return the rest of the line.
fn read_argument(line: &mut ScriptCharProvider) -> String {
	line.advance(); // Skip the command/w character
	line.eat_spaces(); // Skip any leading whitespace

	let mut argument = String::new();
	while !line.eol() {
		argument.push(line.current());
		line.advance();
	}
	argument
}

/// Compile and return a single range address specification.
// Due to their irregular syntax ~ addresses are returned as Line() and adjusted
// in compile_address_range().
fn compile_address(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	context: &ProcessingContext,
) -> SedResult<Address> {
	let mut icase = false;

	if line.eol() {
		return compilation_error(lines, line, "expected context address");
	}

	match line.current() {
		'\\' | '/' => {
			// Regular expression
			if line.current() == '\\' {
				// The next character is an arbitrary delimiter
				line.advance();
			}
			let regex_mode = if context.regex_extended {
				RegexMode::Extended
			} else {
				RegexMode::Basic
			};
			let re = parse_regex(lines, line, regex_mode, ERR_UNTERMINATED_ADDRESS)?;
			// Skip over delimiter
			line.advance();

			// GNU's `I` and `M` address flags, in any order and spacing; --posix has neither.
			let mut multiline = false;
			loop {
				line.eat_spaces();
				if context.posix || line.eol() {
					break;
				}
				match line.current() {
					'I' => icase = true,
					'M' => multiline = true,
					_ => break,
				}
				line.advance();
			}

			// GNU compiles an address regex before reading the command after it.
			if let Some(msg) = re.error {
				return compilation_error_before(lines, line, msg);
			}
			let regex = compile_regex(&re.pattern, context, icase, multiline)
				.or_else(|msg| compilation_error_before(lines, line, msg))?;
			Ok(Address::Re(regex.map(Rc::new)))
		},
		'$' => {
			line.advance();
			Ok(Address::Last)
		},
		'+' => {
			// GNU reads a missing offset as 0.
			line.advance();
			let number = parse_number(lines, line, false)?.unwrap_or(0);
			Ok(Address::RelLine(number))
		},
		c if c.is_ascii_digit() => {
			let number = parse_number(lines, line, true)?.unwrap();
			Ok(Address::Line(number))
		},
		_ => panic!("invalid context address"),
	}
}

/// Parse and return the decimal number at the current line position.
/// Advance the line to first non-digit or EOL.
/// Issue an error if the number is required.
fn parse_number(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	required: bool,
) -> SedResult<Option<usize>> {
	let mut num_str = String::new();

	while !line.eol() && line.current().is_ascii_digit() {
		num_str.push(line.current());
		line.advance();
	}

	if num_str.is_empty() {
		if required {
			return compilation_error(lines, line, "number expected");
		}
		return Ok(None);
	}

	num_str
		.parse::<usize>()
		.map_err(|_| format!("invalid number '{num_str}'"))
		.map_err(|msg| compilation_error::<usize>(lines, line, msg).unwrap_err())
		.map(Some)
}

/// Parse the end of a command, failing with an error on extra characters.
fn parse_command_ending(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<()> {
	line.eat_spaces();
	// Leave a closing brace for compile_sequence to validate and close the group,
	// and a comment for it to skip. GNU sed recognizes both at a command boundary
	// even under --posix.
	if !line.eol() && matches!(line.current(), '}' | '#') {
		return Ok(());
	}
	if !line.eol() && line.current() == ';' {
		line.advance();
		return Ok(());
	}

	if !line.eol() {
		return compilation_error(lines, line, "extra characters after command");
	}

	Ok(())
}

// The BRE→ERE translation lives in `crate::bre`, shared with `grep`.

/// Compile the provided regular expression string into a corresponding engine.
/// An empty pattern results in None, which means that the last RE employed
/// at runtime will be used.
fn compile_regex(
	pattern: &str,
	context: &ProcessingContext,
	icase: bool,
	multiline: bool,
) -> Result<Option<Regex>, String> {
	if pattern.is_empty() {
		return Ok(None);
	}

	let translated = if context.regex_extended {
		crate::bre::ere_to_rust(pattern, false)
	} else {
		crate::bre::bre_to_ere(pattern, crate::bre::Backrefs::Supported, crate::bre::StackedRepeats::Refused).map(std::borrow::Cow::Owned)
	}
	.map_err(|e| e.gnu_message().to_string())?;
	let multiline_classes;
	let pattern = if multiline {
		multiline_classes = exclude_newline_from_negated_classes(translated.as_ref());
		&multiline_classes
	} else {
		translated.as_ref()
	};

	let mut modifiers = String::new();
	if icase {
		modifiers.push('i');
	}
	if multiline {
		modifiers.push('m');
	}
	let with_modifiers;
	let pattern = if modifiers.is_empty() {
		pattern
	} else {
		with_modifiers = format!("(?{modifiers}){pattern}");
		&with_modifiers
	};

	// Compile into engine; the translation has already refused what glibc refuses.
	let compiled = Regex::new(pattern).map_err(|e| match e.downcast_ref::<::regex::Error>() {
		Some(::regex::Error::CompiledTooBig(_)) => crate::bre::BreError::IntervalTooBig.gnu_message().to_string(),
		_ => e.to_string(),
	})?;

	Ok(Some(compiled))
}

/// Adds `\n` to every negated bracket class of a translated pattern: under
/// `M`, GNU sed's `[^x]` stops at the newlines that separate lines, as `.`
/// does, while the Rust engine's matches them.
fn exclude_newline_from_negated_classes(pattern: &str) -> String {
	let mut result = String::with_capacity(pattern.len() + 8);
	let mut chars = pattern.chars().peekable();
	// Nesting depth inside a bracket class (Rust classes nest).
	let mut depth = 0usize;
	while let Some(c) = chars.next() {
		result.push(c);
		match c {
			'\\' => result.extend(chars.next()),
			'[' => {
				if depth == 0 && chars.next_if_eq(&'^').is_some() {
					result.push_str(r"^\n");
				} else if depth > 0
					&& let Some(caret) = chars.next_if_eq(&'^')
				{
					result.push(caret);
				}
				depth += 1;
				// A `]` right after the opening is a literal member.
				if let Some(close) = chars.next_if_eq(&']') {
					result.push(close);
				}
			},
			']' if depth > 0 => depth -= 1,
			_ => {},
		}
	}
	result
}

/// Compile a regular expression replacement string. Outside `posix` mode
/// `\U`, `\L`, `\E`, `\u` and `\l` convert case, as in GNU sed.
pub fn compile_replacement(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	posix: bool,
) -> SedResult<ReplacementTemplate> {
	let mut parts = Vec::new();
	let mut literal = String::new();

	let delimiter = line.current();
	line.advance();

	while !line.eol() {
		match line.current() {
			c if c == delimiter => {
				line.advance(); // skip closing delimiter
				if !literal.is_empty() {
					parts.push(ReplacementPart::Literal(literal));
				}
				return Ok(ReplacementTemplate::new(parts));
			},

			'\\' => {
				line.advance();

				// An escaped newline continues the replacement on the next line.
				if line.eol() {
					if let Some(next_line_string) = lines.next_line()? {
						literal.push('\n');
						*line = ScriptCharProvider::new(&next_line_string);
						continue;
					}
					return compilation_error(lines, line, ERR_UNTERMINATED_S);
				}

				match line.current() {
					// \0 - \9
					c @ '0'..='9' => {
						let ref_num = c.to_digit(10).unwrap();

						if !literal.is_empty() {
							parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
						}
						if ref_num == 0 {
							parts.push(ReplacementPart::WholeMatch);
						} else {
							parts.push(ReplacementPart::Group(ref_num));
						}
						line.advance();
					},

					// Literal \ and &. As in GNU sed, the escape ends a piece
					// of the replacement, where a case conversion that a NUL
					// ended starts again.
					'\\' | '&' => {
						literal.push(line.current());
						parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
						line.advance();
					},

					// Literal delimiter
					v if v == delimiter => {
						literal.push(line.current());
						line.advance();
					},

					// Case conversion
					c @ ('U' | 'L' | 'E' | 'u' | 'l') if !posix => {
						if !literal.is_empty() {
							parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
						}
						parts.push(ReplacementPart::Case(match c {
							'U' => CaseConversion::Upper,
							'L' => CaseConversion::Lower,
							'E' => CaseConversion::End,
							'u' => CaseConversion::UpperNext,
							_ => CaseConversion::LowerNext,
						}));
						line.advance();
					},

					// other escape sequences; in a replacement GNU reads `\b` as
					// an unknown escape, not as a backspace
					_ => {
						let numeric = matches!(line.current(), 'd' | 'o' | 'x');
						let control = line.current() == 'c';
						let decoded = if line.current() == 'b' {
							None
						} else {
							parse_char_escape(line)
						};
						if let Some(decoded) = decoded {
							literal.push(decoded);
							// GNU reads `\c\\` as one escape, the control character
							// of `\`, so what follows it is plain text.
							if control && decoded == '\x1c' && !line.eol() && line.current() == '\\' {
								line.advance();
							}
							// GNU reads a numeric escape that gives `&` or `\` as
							// `\&` or `\\`, which end a piece.
							if numeric && matches!(decoded, '&' | '\\') {
								parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
							}
						} else {
							// GNU drops the backslash of an unknown escape, which
							// ends a piece of the replacement after its character.
							// It copies an escaped non-ASCII character as it is.
							let c = line.current();
							if c.is_ascii() {
								literal.push(c);
								parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
							} else {
								if !literal.is_empty() {
									parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
								}
								parts.push(ReplacementPart::Unconverted(c));
							}
							line.advance();
						}
					},
				}
			},

			'&' => {
				if !literal.is_empty() {
					parts.push(ReplacementPart::Literal(std::mem::take(&mut literal)));
				}
				parts.push(ReplacementPart::WholeMatch);
				line.advance();
			},

			c => {
				literal.push(c);
				line.advance();
			},
		}
	}

	// An unescaped newline ends the line before the closing delimiter.
	compilation_error(lines, line, ERR_UNTERMINATED_S)
}

// Handles s
fn compile_subst_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // move past 's'
	if line.eol() {
		return newline_delimiter_error(lines, line, ERR_UNTERMINATED_S);
	}

	let regex_mode = if context.regex_extended {
		RegexMode::Extended
	} else {
		RegexMode::Basic
	};
	let parsed = parse_regex(lines, line, regex_mode, ERR_UNTERMINATED_S)?;
	let mut subst = Box::new(Substitution::default());

	subst.replacement = compile_replacement(lines, line, context.posix)?;
	compile_subst_flags(lines, line, &mut subst, context.posix, context.sandbox, &context.paths)?;

	if parsed.pattern.is_empty() && (subst.ignore_case || subst.multiline) {
		return subst_flags_error(lines, line, "cannot specify modifiers on empty regexp");
	}

	// Compile regex with now known modifier flags; GNU reports regex errors here.
	if let Some(msg) = parsed.error {
		return subst_flags_error(lines, line, msg);
	}
	subst.regex = compile_regex(&parsed.pattern, context, subst.ignore_case, subst.multiline)
		.or_else(|msg| subst_flags_error(lines, line, msg))?
		.map(Rc::new);

	// Catch invalid group references at compile time, if possible.
	if let Some(regex) = &subst.regex
		&& subst.replacement.max_group_number > regex.captures_len() - 1
	{
		return subst_flags_error(lines, line, invalid_reference(subst.replacement.max_group_number));
	}
	cmd.data = CommandData::Substitution(subst);

	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Continue)
}

/// Fails with an error GNU raises once an `s` command's flags are read: past a
/// terminating `;` or newline, but before a `}` or `#`.
fn subst_flags_error<T>(lines: &ScriptLineProvider, line: &ScriptCharProvider, msg: impl ToString) -> SedResult<T> {
	if !line.eol() && matches!(line.current(), '}' | '#') {
		compilation_error_before(lines, line, msg)
	} else {
		compilation_error_through_newline(lines, line, msg)
	}
}

// Handles y
fn compile_trans_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // move past 'y'
	if line.eol() {
		return newline_delimiter_error(lines, line, ERR_UNTERMINATED_Y);
	}

	let source = parse_transliteration(lines, line)?;
	let target = parse_transliteration(lines, line)?;
	if source.chars().count() != target.chars().count() {
		return compilation_error(lines, line, "strings for `y' command are different lengths");
	}

	let transliteration = Box::new(Transliteration::from_strings(&source, &target));
	cmd.data = CommandData::Transliteration(transliteration);

	line.advance(); // move past last delimiter
	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Continue)
}

/// Parse the substitution command's optional flags
pub fn compile_subst_flags(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	subst: &mut Substitution,
	posix: bool,
	sandbox: bool,
	paths: &ShellPaths,
) -> SedResult<()> {
	let mut seen_n = false;

	subst.occurrence = 1; // default
	subst.global = false;
	subst.print_flag = false;
	subst.ignore_case = false;
	subst.execute = false;
	subst.multiline = false;
	subst.write_file = None;

	loop {
		line.eat_spaces();
		if line.eol() {
			break;
		}

		match line.current() {
			'g' => {
				if subst.global {
					return compilation_error(lines, line, "multiple `g' options to `s' command");
				}
				subst.global = true;
				line.advance();
			},

			'p' => {
				subst.print_flag = true;
				line.advance();
			},

			'i' | 'I' => {
				if posix {
					return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
				}
				subst.ignore_case = true;
				line.advance();
			},

			'm' | 'M' => {
				if posix {
					return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
				}
				subst.multiline = true;
				line.advance();
			},

			'e' => {
				if sandbox {
					return compilation_error(lines, line, ERR_SANDBOX);
				}
				if posix {
					return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
				}
				subst.execute = true;
				line.advance();
			},

			'0' => {
				return compilation_error(
					lines,
					line,
					"number option to `s' command may not be zero",
				);
			},

			_c @ '1'..='9' => {
				if seen_n {
					return compilation_error(lines, line, "multiple number options to `s' command");
				}

				let mut number = 0usize;
				while !line.eol() && line.current().is_ascii_digit() {
					number = number
						.checked_mul(10)
						.and_then(|n| n.checked_add(line.current().to_digit(10).unwrap() as usize))
						.ok_or_else(|| {
							compilation_error::<()>(lines, line, "overflow in numeric substitute flag")
								.unwrap_err()
						})?;
					line.advance();
				}

				subst.occurrence = number;
				seen_n = true;
			},

			'w' => {
				if sandbox {
					return compilation_error(lines, line, ERR_SANDBOX);
				}
				let path = read_file_path(lines, line)?;
				subst.write_file = Some(NamedWriter::new(path, paths)?);
				return Ok(()); // 'w' is the last flag allowed
			},

			';' | '\n' | '}' | '#' => break,

			_ => {
				return compilation_error(lines, line, ERR_UNKNOWN_OPTION_TO_S);
			},
		}
	}

	Ok(())
}

// Handles }
fn compile_end_group_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.parsed_block_nesting == 0 {
		return compilation_error(lines, line, "unexpected `}'");
	}
	if cmd.addr1.is_some() {
		return compilation_error(lines, line, "`}' doesn't want any addresses");
	}
	context.parsed_block_nesting -= 1;
	line.advance();
	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Return)
}

// Handles !
fn compile_negation_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if cmd.non_select {
		return compilation_error(lines, line, "multiple `!'s");
	}
	line.advance();
	line.eat_spaces();
	cmd.non_select = true;
	Ok(CommandHandling::GetNext)
}

/// Compile a command that doesn't take any arguments
// Handles d D g G h H l n N p P q x =
fn compile_empty_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	_cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // Skip the command character
	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Continue)
}

// Handles r
fn compile_read_file_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	cmd.data = CommandData::Path(read_file_path(lines, line)?);
	Ok(CommandHandling::Continue)
}

// Handles R (GNU)
fn compile_read_line_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	let path = read_file_path(lines, line)?;
	let source = match context.line_sources.get(&path) {
		Some(source) => Rc::clone(source),
		None => {
			let source =
				Rc::new(RefCell::new(LineSource::new(path.clone(), path.as_os_str() == "/dev/stdin")));
			context.line_sources.insert(path, Rc::clone(&source));
			source
		},
	};
	cmd.data = CommandData::LineSource(source);
	Ok(CommandHandling::Continue)
}

// Handles e (GNU): an empty command executes the pattern space.
fn compile_execute_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	cmd.data = CommandData::Text(Rc::from(read_argument(line)));
	Ok(CommandHandling::Continue)
}


// Handles w and W (GNU)
fn compile_write_file_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	let path = read_file_path(lines, line)?;
	cmd.data = CommandData::NamedWriter(NamedWriter::new(path, &context.paths)?);
	Ok(CommandHandling::Continue)
}

// Handles {
fn compile_block_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // move past '{'
	context.parsed_block_nesting += 1;
	let depth = context.parsed_block_nesting;
	let block_body = compile_sequence(lines, line, context)?;
	if context.parsed_block_nesting == depth {
		// GNU reports the innermost unclosed block where it opened, at char 0.
		let location = ScriptLocation { offset: 0, ..cmd.location.clone() };
		return semantic_error(&location, "unmatched `{'");
	}
	cmd.data = CommandData::BranchTarget(block_body);
	Ok(CommandHandling::Continue)
}

// Handles b, t, :
fn compile_label_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	/// Return true if `c` is in the POSIX portable filename character set.
	fn is_portable_filename_char(c: char) -> bool {
		c.is_ascii_alphanumeric()  // A–Z, a–z, 0–9
        || matches!(c, '.' | '_' | '-')
	}

	line.advance(); // Skip the command character
	line.eat_spaces(); // Skip any leading whitespace

	let mut label = String::new();
	while !line.eol() && is_portable_filename_char(line.current()) {
		label.push(line.current());
		line.advance();
	}

	if label.is_empty() {
		if cmd.code == ':' {
			return compilation_error(lines, line, "\":\" lacks a label");
		}
		cmd.data = CommandData::Label(None);
	} else {
		cmd.data = CommandData::Label(Some(label));
	}

	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Continue)
}

/// Return the default `l` command output width.
// the context streams are never a
// terminal, so upstream's terminal_size() width auto-detection is dropped.
fn output_width() -> usize {
	DEFAULT_OUTPUT_WIDTH
}

/// Compile commands that take a number as an argument.
// Handles l q Q
fn compile_number_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // Skip the command character
	line.eat_spaces(); // Skip any leading whitespace

	match parse_number(lines, line, false)? {
		Some(n) => {
			cmd.data = CommandData::Number(n);
		},
		None => match cmd.code {
			'q' | 'Q' => {
				cmd.data = CommandData::Number(0);
			},
			'l' => {
				cmd.data = CommandData::Number(output_width());
			},
			_ => panic!("invalid number-expecting command"),
		},
	}

	parse_command_ending(lines, line)?;
	Ok(CommandHandling::Continue)
}

/// Compile `a`, `c` and `i`, whose text GNU reads after an optional `\` and
/// newline; `\` escapes and continues lines. --posix requires the `\` and text
/// from the same script piece.
fn compile_text_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // Skip the command character.
	line.eat_spaces(); // Skip any leading whitespace.

	if line.eol() || (context.posix && line.current() != '\\') {
		return compilation_error(lines, line, ERR_EXPECTED_TEXT);
	}

	// True after a \ at the end of a line
	let mut escaped_newline = false;

	// Skip optional \.
	if line.current() == '\\' {
		line.advance();
		escaped_newline = line.eol();
	}

	// Gather replacement text.  Stop on a non-escaped newline.
	let mut text = String::new();
	loop {
		if escaped_newline {
			let next_line = if context.posix {
				let incomplete = compilation_error::<()>(lines, line, "incomplete command").unwrap_err();
				Some(lines.next_line_in_source()?.ok_or(incomplete)?)
			} else {
				lines.next_line()?
			};
			match next_line {
				None => break,
				Some(line_string) => *line = ScriptCharProvider::new(&line_string),
			}
			escaped_newline = false;
		}

		// Non-escaped newline
		if line.eol() {
			text.push('\n');
			break;
		}

		if line.current() == '\\' {
			line.advance();

			if line.eol() {
				escaped_newline = true;
				text.push('\n');
				continue;
			}

			if let Some(decoded) = parse_char_escape(line) {
				text.push(decoded);
			} else {
				// Invalid escapes result in the escaped character.
				text.push(line.current());
				line.advance();
			}
		} else {
			text.push(line.current());
			line.advance();
		}
	}
	cmd.data = CommandData::Text(Rc::from(text));
	Ok(CommandHandling::Continue)
}

// Return the specification for the command letter at the current line position
// checking for diverse errors.
fn get_verified_cmd_spec(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	n_addr: usize,
	posix: bool,
) -> SedResult<CommandSpec> {
	if line.eol() {
		return compilation_error(lines, line, "missing command");
	}

	let ch = line.current();
	if ch == '#' && n_addr > 0 {
		return compilation_error(lines, line, "comments don't accept any addresses");
	}
	let cmd_spec = get_cmd_spec(lines, line, ch, posix)?;

	if n_addr > cmd_spec.n_addr {
		let msg = if ch == ':' { ": doesn't want any addresses" } else { "command only uses one address" };
		return compilation_error(lines, line, msg);
	}

	Ok(cmd_spec)
}

// Look up a command addresses and handler by its command code.
fn get_cmd_spec(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	cmd_code: char,
	posix: bool,
) -> SedResult<CommandSpec> {
	match cmd_code {
		'!' => Ok(CommandSpec { n_addr: 2, handler: compile_negation_command }),
		'=' => Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_empty_command }),
		':' => Ok(CommandSpec { n_addr: 0, handler: compile_label_command }),
		'{' => Ok(CommandSpec { n_addr: 2, handler: compile_block_command }),
		// Addresses are rejected by the handler, after the unmatched-brace check (GNU order).
		'}' => Ok(CommandSpec { n_addr: 2, handler: compile_end_group_command }),
		'a' | 'i' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_text_command })
		},
		'b' | 't' => Ok(CommandSpec { n_addr: 2, handler: compile_label_command }),
		'c' => Ok(CommandSpec { n_addr: 2, handler: compile_text_command }),
		'd' | 'D' | 'g' | 'G' | 'h' | 'H' | 'n' | 'N' | 'p' | 'P' | 'x' => {
			Ok(CommandSpec { n_addr: 2, handler: compile_empty_command })
		},
		'z' | 'F' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_empty_command }),
		'e' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_execute_command }),
		'R' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_read_line_command }),
		'l' => Ok(CommandSpec { n_addr: 2, handler: compile_number_command }),
		// Q is a GNU extension
		'q' | 'Q' => Ok(CommandSpec { n_addr: 1, handler: compile_number_command }),
		'r' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_read_file_command })
		},
		's' => Ok(CommandSpec { n_addr: 2, handler: compile_subst_command }),
		'w' => Ok(CommandSpec { n_addr: 2, handler: compile_write_file_command }),
		'W' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_write_file_command }),
		'y' => Ok(CommandSpec { n_addr: 2, handler: compile_trans_command }),
		_ => compilation_error(lines, line, format!("unknown command: `{cmd_code}'")),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sed::{error_handling::ScriptOrigin, fast_io::IOChunk};

	// Return an empty line provider and a char provider for the specified str.
	fn make_providers(input: &str) -> (ScriptLineProvider, ScriptCharProvider) {
		let lines = ScriptLineProvider::new(vec![]); // Empty for tests
		let line = ScriptCharProvider::new(input);
		(lines, line)
	}

	fn make_line_provider(lines: &[&str]) -> ScriptLineProvider {
		let input = lines
			.iter()
			.map(|s| ScriptValue::StringVal((*s).to_string()))
			.collect();
		ScriptLineProvider::new(input)
	}

	fn make_char_provider(input: &str) -> ScriptCharProvider {
		ScriptCharProvider::new(input)
	}

	/// Return a default ProcessingContext for use in tests.
	pub fn ctx() -> ProcessingContext {
		ProcessingContext::default()
	}

	// get_cmd_spec
	#[test]
	fn test_lookup_empty_command() {
		let (lines, line) = make_providers("123abc");
		let cmd = get_cmd_spec(&lines, &line, 'd', false).unwrap();
		assert_eq!(cmd.n_addr, 2);
	}

	#[test]
	fn test_lookup_text_command() {
		let (lines, line) = make_providers("123abc");
		let cmd = get_cmd_spec(&lines, &line, 'a', false).unwrap();
		assert_eq!(cmd.n_addr, 2);
	}

	#[test]
	fn test_lookup_nonselect_command() {
		let (lines, line) = make_providers("123abc");
		let cmd = get_cmd_spec(&lines, &line, '!', false).unwrap();
		assert_eq!(cmd.n_addr, 2);
	}

	#[test]
	fn test_lookup_endgroup_command() {
		let (lines, line) = make_providers("123abc");
		let cmd = get_cmd_spec(&lines, &line, '}', false).unwrap();
		assert_eq!(cmd.n_addr, 2);
	}

	#[test]
	fn test_lookup_invalid_command() {
		let (lines, line) = make_providers("123abc");
		let result = get_cmd_spec(&lines, &line, 'Z', false);
		assert!(result.is_err());
	}

	// Utility to create a ScriptCharProvider from a &str
	fn char_provider_from(s: &str) -> ScriptCharProvider {
		ScriptCharProvider::new(s)
	}

	// compilation_error
	#[test]
	fn test_compilation_error_message_format() {
		let lines = ScriptLineProvider::with_active_state("test.sed", 42);
		let mut line = char_provider_from("whatever");
		line.advance(); // move to position 1
		line.advance(); // move to position 2
		line.advance(); // move to position 3
		line.advance(); // now at position 4

		let msg = "unexpected token";
		let result: SedResult<()> = compilation_error(&lines, &line, msg);

		assert!(result.is_err());

		let err = result.unwrap_err();
		let msg = err.to_string();

		assert_eq!(msg, "file test.sed line 42: unexpected token");
	}

	#[test]
	fn test_compilation_error_with_format_message() {
		let lines = ScriptLineProvider::with_active_state("input.txt", 3);
		let line = char_provider_from("x");
		// We're at position 0

		let result: SedResult<()> =
			compilation_error(&lines, &line, format!("invalid command '{}'", 'x'));

		assert!(result.is_err());

		let err = result.unwrap_err();
		let msg = err.to_string();

		assert_eq!(msg, "file input.txt line 3: invalid command 'x'");
	}

	// get_verified_cmd_spec
	#[test]
	fn test_missing_command_character() {
		let lines = ScriptLineProvider::with_active_state("test.sed", 1);
		let line = char_provider_from("");
		let result = get_verified_cmd_spec(&lines, &line, 0, ctx().posix);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert_eq!(msg, "file test.sed line 1: missing command");
	}

	#[test]
	fn test_invalid_command_character() {
		let lines = ScriptLineProvider::with_active_state("script.sed", 2);
		let line = char_provider_from("@");
		let result = get_verified_cmd_spec(&lines, &line, 0, ctx().posix);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert_eq!(msg, "file script.sed line 2: unknown command: `@'");
	}

	#[test]
	fn test_too_many_addresses() {
		let lines = ScriptLineProvider::with_active_state("input.sed", 3);
		let line = char_provider_from("q"); // q takes one address
		let result = get_verified_cmd_spec(&lines, &line, 2, true);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert_eq!(msg, "file input.sed line 3: command only uses one address");
	}

	#[test]
	fn test_valid_command_spec() {
		let lines = ScriptLineProvider::with_active_state("input.sed", 4);
		let line = char_provider_from("a"); // valid command
		let result = get_verified_cmd_spec(&lines, &line, 2, ctx().posix);
		assert!(result.is_ok());
		let spec = result.unwrap();
		assert_eq!(spec.n_addr, 2);
	}

	#[test]
	fn test_invalid_address_range_posix() {
		let lines = ScriptLineProvider::with_active_state("input.sed", 1);
		let line = char_provider_from("i"); // valid command
		let result = get_verified_cmd_spec(&lines, &line, 2, true);
		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert_eq!(msg, "file input.sed line 1: command only uses one address");
	}

	// parse_number
	#[test]
	fn test_parse_number_basic() {
		let (lines, mut chars) = make_providers("123abc");
		assert_eq!(parse_number(&lines, &mut chars, true).unwrap(), Some(123));
		assert_eq!(chars.current(), 'a'); // Should stop at first non-digit
	}

	#[test]
	fn test_parse_optional_number_missing() {
		let (lines, mut chars) = make_providers(" ;");
		assert_eq!(parse_number(&lines, &mut chars, false).unwrap(), None);
	}

	#[test]
	fn test_parse_number_invalid() {
		let (lines, mut chars) = make_providers("537654897563495734653453434534534534545");
		let err = parse_number(&lines, &mut chars, true).unwrap_err();
		assert!(err.to_string().contains("invalid number"));
	}

	#[test]
	fn test_parse_required_number_missing() {
		let (lines, mut chars) = make_providers("");
		let err = parse_number(&lines, &mut chars, true).unwrap_err();
		assert!(err.to_string().contains("number expected"));
	}

	// compile_re

	#[test]
	fn test_compile_re_basic() {
		let regex = compile_regex("abc", &ctx(), false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&IOChunk::new_from_str("abc")).unwrap());
		assert!(!regex.is_match(&IOChunk::new_from_str("ABC")).unwrap());
	}

	#[test]
	fn test_compile_re_extended() {
		let mut ctx = ctx();
		ctx.regex_extended = true;
		let regex = compile_regex("cc{0,}", &ctx, false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&IOChunk::new_from_str("acaa\nccc"))
				.unwrap()
		);
	}

	#[test]
	fn test_compile_re_basic_leading_plus_is_a_literal() {
		// REGRESSION: `s/^\+/X/` used to substitute at the start of EVERY
		// line, because `\+` became `+` unconditionally and `^+` compiles as
		// `(?:^)+`. Real sed changes only lines that begin with a plus.
		let regex = compile_regex(r"^\+", &ctx(), false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&IOChunk::new_from_str("+added")).unwrap());
		assert!(!regex.is_match(&IOChunk::new_from_str("alpha")).unwrap());
		assert!(!regex.is_match(&IOChunk::new_from_str(" context")).unwrap());
	}

	#[test]
	fn test_compile_re_basic_no_operand_brace_is_rejected() {
		// Real sed refuses this rather than substituting: emitting the
		// operator would give `{1,3}` or, after an anchor, `^{1,3}` - which
		// fancy-regex accepts and matches at every line start.
		for pattern in [r"\{1,3\}", r"^\{1,3\}"] {
			let err = compile_regex(pattern, &ctx(), false, false)
				.expect_err("a brace quantifier with no operand must not compile");
			assert_eq!(err, "Invalid preceding regular expression", "{pattern}");
		}
	}

	#[test]
	fn test_compile_re_basic_caret_is_an_anchor_inside_a_group() {
		// `\(^a\)` anchors in a BRE; escaping the caret matched nothing.
		let regex = compile_regex(r"\(^alpha\)", &ctx(), false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&IOChunk::new_from_str("alpha")).unwrap());
		assert!(!regex.is_match(&IOChunk::new_from_str("xalpha")).unwrap());
	}

	#[test]
	fn test_compile_re_case_insensitive() {
		let regex = compile_regex("abc", &ctx(), true, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&IOChunk::new_from_str("abc")).unwrap());
		assert!(regex.is_match(&IOChunk::new_from_str("ABC")).unwrap());
		assert!(regex.is_match(&IOChunk::new_from_str("AbC")).unwrap());
	}

	#[test]
	fn test_compile_re_invalid() {
		let result = compile_regex("a[d", &ctx(), false, false);
		assert_eq!(result.unwrap_err(), "Unmatched [, [^, [:, [., or [=");
	}

	#[test]
	fn test_compile_re_multiline_start() {
		let regex = compile_regex("^bar", &ctx(), false, true)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&IOChunk::new_from_str("foo\nbar"))
				.unwrap()
		);
	}

	#[test]
	fn test_compile_re_multiline_end() {
		let regex = compile_regex("foo$", &ctx(), false, true)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&IOChunk::new_from_str("foo\nbar"))
				.unwrap()
		);
	}

	// compile_address
	#[test]
	fn test_compile_addr_line_number() {
		let (lines, mut chars) = make_providers("42");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();
		assert!(matches!(addr, Address::Line(42)));
	}

	#[test]
	fn test_compile_addr_relative_line() {
		let (lines, mut chars) = make_providers("+7");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();
		assert!(matches!(addr, Address::RelLine(7)));
	}

	#[test]
	fn test_compile_addr_last_line() {
		let (lines, mut chars) = make_providers("$");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();
		assert!(matches!(addr, Address::Last));
	}

	#[test]
	fn test_compile_addr_regex() {
		let (lines, mut chars) = make_providers("/hello/");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		let Address::Re(Some(re)) = addr else {
			panic!("expected Address::Re(Some(_))");
		};

		assert!(re.is_match(&IOChunk::new_from_str("hello")).unwrap());
	}

	#[test]
	fn test_compile_addr_regex_backref_match() {
		let (lines, mut chars) = make_providers(r"/he\(.\)\1o/");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		match addr {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("hello")).unwrap());
			},
			_ => panic!("expected Address::Re(Some(_))"),
		}
	}

	#[test]
	fn test_compile_addr_regex_backref_no_match() {
		let (lines, mut chars) = make_providers(r"/he\(.\)\1o/");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		match addr {
			Address::Re(Some(re)) => {
				assert!(!re.is_match(&IOChunk::new_from_str("helio")).unwrap());
			},
			_ => panic!("expected Address::Re(Some(_))"),
		}
	}

	#[test]
	fn test_compile_addr_regex_other_delimiter() {
		let (lines, mut chars) = make_providers("\\#hello#");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		match addr {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("hello")).unwrap());
			},
			_ => panic!("expected Address::Re(Some(_))"),
		}
	}

	#[test]
	fn test_compile_addr_regex_with_modifier() {
		let (lines, mut chars) = make_providers("/hello/I");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		match addr {
			Address::Re(Some(re)) => {
				// Case-insensitive
				assert!(re.is_match(&IOChunk::new_from_str("HELLO")).unwrap());
			},
			_ => panic!("expected Address::Re(Some(_))"),
		}
	}

	// compile_address_range
	#[test]
	fn test_compile_single_line_address() {
		let (lines, mut chars) = make_providers("42");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 1);
		assert!(matches!(cmd.borrow().addr1, Some(Address::Line(42))));
	}

	#[test]
	fn test_compile_relative_address_range() {
		let (lines, mut chars) = make_providers("2,+3");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 2);

		assert!(matches!(cmd.borrow().addr1, Some(Address::Line(2))));
		assert!(matches!(cmd.borrow().addr2, Some(Address::RelLine(3))));
	}

	#[test]
	fn test_compile_step_match_address() {
		let (lines, mut chars) = make_providers("0~2");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 2);
		assert!(matches!(cmd.borrow().addr1, Some(Address::Line(0))));
		assert!(matches!(cmd.borrow().addr2, Some(Address::StepMatch(2))));
	}

	#[test]
	fn test_compile_step_end_address() {
		let (lines, mut chars) = make_providers("1,~10");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 2);
		assert!(matches!(cmd.borrow().addr1, Some(Address::Line(1))));
		assert!(matches!(cmd.borrow().addr2, Some(Address::StepEnd(10))));
	}

	#[test]
	fn test_compile_last_address() {
		let (lines, mut chars) = make_providers("$");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 1);
		assert!(matches!(cmd.borrow().addr1, Some(Address::Last)));
	}

	#[test]
	fn test_compile_absolute_address_range() {
		let (lines, mut chars) = make_providers("5,10");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 2);
		assert!(matches!(cmd.borrow().addr1, Some(Address::Line(5))));
		assert!(matches!(cmd.borrow().addr2, Some(Address::Line(10))));
	}

	#[test]
	fn test_compile_regex_address() {
		let (lines, mut chars) = make_providers("/foo/");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 1);

		match cmd.borrow().addr1.as_ref().unwrap() {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("foo")).unwrap());
				assert!(!re.is_match(&IOChunk::new_from_str("bar")).unwrap());
			},
			_ => panic!("expected regex address"),
		}
	}

	#[test]
	fn test_compile_regex_address_range_other_delimiter() {
		let (lines, mut chars) = make_providers("\\#foo# , \\|bar|");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 2);

		match cmd.borrow().addr1.as_ref().unwrap() {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("foo")).unwrap());
				assert!(!re.is_match(&IOChunk::new_from_str("bar")).unwrap());
			},
			_ => panic!("expected regex address"),
		}

		match cmd.borrow().addr2.as_ref().unwrap() {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("bar")).unwrap());
				assert!(!re.is_match(&IOChunk::new_from_str("foo")).unwrap());
			},
			_ => panic!("expected regex address"),
		}
	}

	#[test]
	fn test_compile_regex_with_modifier() {
		let (lines, mut chars) = make_providers("/foo/I");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

		assert_eq!(n_addr, 1);

		match cmd.borrow().addr1.as_ref().unwrap() {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&IOChunk::new_from_str("FOO")).unwrap());
				assert!(re.is_match(&IOChunk::new_from_str("foo")).unwrap());
			},
			_ => panic!("expected regex address"),
		}
	}

	#[test]
	fn test_compile_address_range_error_propagation() {
		let (lines, mut chars) = make_providers("1,/abc");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let result = compile_address_range(&lines, &mut chars, &mut cmd, &ctx());

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert!(msg.contains(ERR_UNTERMINATED_ADDRESS));
	}

	// compile_sequence
	fn empty_line() -> ScriptCharProvider {
		ScriptCharProvider::new("")
	}

	#[test]
	fn test_zero_addr_r_accepted() {
		for input in ["0r", "0  r"] {
			let (lines, mut chars) = make_providers(input);
			let mut cmd = Rc::new(RefCell::new(Command::default()));
			let n_addr = compile_address_range(&lines, &mut chars, &mut cmd, &ctx()).unwrap();

			assert_eq!(n_addr, 1);
			assert!(matches!(cmd.borrow().addr1, Some(Address::Line(0))));
			assert_eq!(chars.current(), 'r');
		}
	}

	// Zero-address with no commands
	#[test]
	fn test_zero_addr_no_commands() {
		let (lines, mut chars) = make_providers("0");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let result = compile_address_range(&lines, &mut chars, &mut cmd, &ctx());

		assert!(result.is_err());
		assert!(
			result
				.unwrap_err()
				.to_string()
				.contains(ERR_ADDRESS_0_USAGE)
		);
	}

	// Zero-address with a command other than 'r' must still be rejected.
	#[test]
	fn test_zero_addr_non_r_rejected() {
		let (lines, mut chars) = make_providers("0p");
		let mut cmd = Rc::new(RefCell::new(Command::default()));
		let result = compile_address_range(&lines, &mut chars, &mut cmd, &ctx());

		assert!(result.is_err());
		assert!(
			result
				.unwrap_err()
				.to_string()
				.contains(ERR_ADDRESS_0_USAGE)
		);
	}

	#[test]
	fn test_compile_sequence_empty_input() {
		let mut provider = make_line_provider(&[]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		assert!(result.is_none());
	}

	#[test]
	fn test_compile_sequence_comment_only() {
		let mut provider = make_line_provider(&["# comment", "   ", ";;"]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		assert!(result.is_none());
	}

	#[test]
	fn test_compile_sequence_single_command() {
		let mut provider = make_line_provider(&["42q"]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		let binding = result.unwrap();
		let cmd = binding.borrow();

		assert_eq!(cmd.code, 'q');
		assert!(!cmd.non_select);

		assert!(matches!(cmd.addr1, Some(Address::Line(42))));
		assert!(cmd.next.is_none());
	}

	#[test]
	fn test_compile_sequence_non_selected_single_command() {
		let mut provider = make_line_provider(&["42!p"]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		let binding = result.unwrap();
		let cmd = binding.borrow();

		assert_eq!(cmd.code, 'p');
		assert!(cmd.non_select);

		assert!(matches!(cmd.addr1, Some(Address::Line(42))));
		assert!(cmd.next.is_none());
	}

	#[test]
	fn test_compile_sequence_multiple_lines() {
		let mut provider = make_line_provider(&["1q", "2d"]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		let binding = result.unwrap();
		let first = binding.borrow();

		assert_eq!(first.code, 'q');
		let binding = first.next.clone().unwrap();
		let second = binding.borrow();
		assert_eq!(second.code, 'd');
		assert!(second.next.is_none());
	}

	#[test]
	fn test_compile_sequence_single_line_multiple_commands() {
		let mut provider = make_line_provider(&["1q;2d"]);
		let mut opts = ctx();

		let result = compile_sequence(&mut provider, &mut empty_line(), &mut opts).unwrap();
		let binding = result.unwrap();
		let first = binding.borrow();

		assert_eq!(first.code, 'q');
		let binding = first.next.clone().unwrap();
		let second = binding.borrow();
		assert_eq!(second.code, 'd');
		assert!(second.next.is_none());
	}

	// compile
	#[test]
	fn test_compile_single_command() {
		let scripts = vec![ScriptValue::StringVal("1q".to_string())];
		let mut opts = ProcessingContext::default();

		let result = compile(scripts, &mut opts).unwrap();
		let binding = result.unwrap();
		let cmd = binding.borrow();

		assert_eq!(cmd.code, 'q');

		assert!(matches!(cmd.addr1, Some(Address::Line(1))));

		assert_eq!(cmd.location.origin, ScriptOrigin::Expression(1));
		assert_eq!(cmd.location.offset, 1);

		assert!(cmd.next.is_none());
	}

	#[test]
	fn test_compile_two_commands() {
		let scripts = vec![ScriptValue::StringVal("l;q".to_string())];
		let mut opts = ProcessingContext::default();

		let result = compile(scripts, &mut opts).unwrap();
		let binding = result.unwrap();
		let cmd = binding.borrow();

		assert_eq!(cmd.code, 'l');
		assert_eq!(cmd.location.origin, ScriptOrigin::Expression(1));
		assert_eq!(cmd.location.offset, 1);

		let binding2 = cmd.next.clone().unwrap();
		let cmd2 = binding2.borrow();
		assert_eq!(cmd2.code, 'q');
		assert_eq!(cmd2.location.origin, ScriptOrigin::Expression(1));
		assert_eq!(cmd2.location.offset, 3);

		assert!(cmd2.next.is_none());
	}

	// compile_replacement
	#[test]
	fn test_compile_replacement_literal() {
		let (mut lines, mut chars) = make_providers("/hello/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "hello"));
	}

	#[test]
	fn test_compile_replacement_escaped_delimiter() {
		let (mut lines, mut chars) = make_providers(r"/hell\/o/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "hell/o"));
	}

	#[test]
	fn test_compile_replacement_backrefs_and_literal() {
		let (mut lines, mut chars) = make_providers("/prefix \\1 and \\2/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 4);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "prefix "));
		assert!(matches!(&template.parts[1], ReplacementPart::Group(1)));
		assert!(matches!(&template.parts[2], ReplacementPart::Literal(s) if s == " and "));
		assert!(matches!(&template.parts[3], ReplacementPart::Group(2)));
	}

	#[test]
	fn test_compile_replacement_whole_match() {
		let (mut lines, mut chars) = make_providers("/The match was: &/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 2);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "The match was: "));
		assert!(matches!(&template.parts[1], ReplacementPart::WholeMatch));
	}

	#[test]
	fn test_compile_replacement_whole_match_synonym() {
		let (mut lines, mut chars) = make_providers(r"/The match was: \0/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 2);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "The match was: "));
		assert!(matches!(&template.parts[1], ReplacementPart::WholeMatch));
	}

	#[test]
	fn test_compile_replacement_ampersand() {
		let (mut lines, mut chars) = make_providers("/Simon \\& Garfunkel/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		let text: String = template
			.parts
			.iter()
			.map(|part| match part {
				ReplacementPart::Literal(s) => s.as_str(),
				other => panic!("unexpected part {other:?}"),
			})
			.collect();
		assert_eq!(text, "Simon & Garfunkel");
	}

	#[test]
	fn test_compile_replacement_escape_sequences() {
		let (mut lines, mut chars) = make_providers("/line\\nnewline\\tend/");
		let template = compile_replacement(&mut lines, &mut chars, false).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(matches!(
			 &template.parts[0],
			 ReplacementPart::Literal(s) if s == "line\nnewline\tend"
		));
	}

	#[test]
	fn test_compile_replacement_line_continuation() {
		let script = vec![
			ScriptValue::StringVal("/first line\\".to_string()),
			ScriptValue::StringVal(" continued/".to_string()),
		];
		let mut provider = ScriptLineProvider::new(script);
		let first_line = provider.next_line().unwrap().unwrap();
		let mut chars = ScriptCharProvider::new(&first_line);

		let template = compile_replacement(&mut provider, &mut chars, false).unwrap();
		assert_eq!(template.parts.len(), 1);
		assert!(matches!(
			 &template.parts[0],
			 ReplacementPart::Literal(s) if s == "first line\n continued"
		));
	}

	// compile_subst_flags
	#[test]
	fn test_compile_subst_flag_g() {
		let (lines, mut chars) = make_providers("g");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.global);
	}

	#[test]
	fn test_compile_subst_flag_p() {
		let (lines, mut chars) = make_providers("p");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.print_flag);
	}

	#[test]
	fn test_compile_subst_flag_uppercase_i() {
		let (lines, mut chars) = make_providers("I");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.ignore_case);
	}

	#[test]
	fn test_compile_subst_flag_i_lowercase() {
		let (lines, mut chars) = make_providers("i");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.ignore_case);
	}

	#[test]
	fn test_compile_subst_flag_uppercase_m() {
		let (lines, mut chars) = make_providers("M");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.multiline);
	}

	#[test]
	fn test_compile_subst_flag_m_lowercase() {
		let (lines, mut chars) = make_providers("m");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.multiline);
	}

	#[test]
	fn test_compile_subst_flag_number() {
		let (lines, mut chars) = make_providers("3");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert_eq!(subst.occurrence, 3);
	}

	#[test]
	fn test_compile_subst_flag_g_and_number_combine() {
		// GNU's `Ng`: replace the Nth match and every later one.
		for flags in ["g3", "3g"] {
			let (lines, mut chars) = make_providers(flags);
			let mut subst = Substitution::default();

			compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
			assert_eq!((subst.occurrence, subst.global), (3, true), "{flags}");
		}
	}

	#[test]
	fn test_compile_subst_flag_repeated_should_fail() {
		for (flags, msg) in [
			("gg", "multiple `g' options to `s' command"),
			("2p3", "multiple number options to `s' command"),
		] {
			let (lines, mut chars) = make_providers(flags);
			let mut subst = Substitution::default();

			let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap_err();
			assert!(err.to_string().contains(msg), "{flags}: {err}");
		}
	}

	#[test]
	fn test_compile_subst_flag_w_missing_filename() {
		let (lines, mut chars) = make_providers("w ");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap_err();
		assert!(err.to_string().contains(ERR_MISSING_FILENAME));
	}

	#[test]
	fn test_compile_subst_flag_w_with_filename() {
		let tmp_dir = tempfile::tempdir().expect("failed to create tmp folder");
		let out = tmp_dir.path().join("out.txt");
		let (lines, mut chars) = make_providers(&format!("w {}", out.display()));
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert_eq!(subst.write_file.as_ref().map(|w| w.borrow().path.clone()), Some(out));
	}

	#[test]
	fn test_compile_subst_flag_w_rejected_under_sandbox() {
		let (lines, mut chars) = make_providers("w out.txt");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, true, &ShellPaths::default()).unwrap_err();
		assert!(err.to_string().contains(ERR_SANDBOX));
	}

	#[test]
	fn test_compile_subst_flag_e() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap();
		assert!(subst.execute);
	}

	#[test]
	fn test_compile_subst_flag_e_rejected_under_posix() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, true, false, &ShellPaths::default()).unwrap_err();
		assert!(err.to_string().contains(ERR_UNKNOWN_OPTION_TO_S));
	}

	#[test]
	fn test_compile_subst_flag_e_rejected_under_sandbox() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, true, &ShellPaths::default()).unwrap_err();
		assert!(err.to_string().contains(ERR_SANDBOX));
	}

	#[test]
	fn test_compile_subst_flag_invalid_flag() {
		let (lines, mut chars) = make_providers("z");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, &ShellPaths::default()).unwrap_err();
		assert!(err.to_string().contains(ERR_UNKNOWN_OPTION_TO_S));
	}

	// compile_subst_command
	#[test]
	fn test_compile_subst_backslash_delimiter() {
		// `sed 's\foo\bar\'` is a valid GNU substitution, not a delimiter error.
		let (mut lines, mut chars) = make_providers("s\\foo\\bar\\");
		let mut cmd = Command::default();
		let mut context = ctx();

		compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		let CommandData::Substitution(subst) = &cmd.data else { panic!("Expected a substitution") };
		assert!(matches!(&subst.replacement.parts[..], [ReplacementPart::Literal(text)] if text == "bar"));
	}

	#[test]
	fn test_compile_subst_extra_characters_at_end() {
		let (mut lines, mut chars) = make_providers("s/foo/bar/x");
		let mut cmd = Command::default();
		let mut context = ctx();

		let err = compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains(ERR_UNKNOWN_OPTION_TO_S));
	}

	#[test]
	fn test_compile_subst_semicolon_indicates_continue() {
		let (mut lines, mut chars) = make_providers("s/foo/bar/;");
		let mut cmd = Command::default();
		let mut context = ctx();

		compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();

		if let CommandData::Substitution(subst) = &cmd.data {
			assert_eq!(subst.replacement.parts.len(), 1);
		} else {
			panic!("Expected CommandData::Substitution");
		}
	}

	#[test]
	fn test_compile_subst_sets_command_data() {
		let (mut lines, mut chars) = make_providers("s/foo/bar/");
		let mut cmd = Command::default();
		let mut context = ctx();

		compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Substitution(subst) => {
				assert_eq!(subst.replacement.parts.len(), 1);
				assert!(
					matches!(&subst.replacement.parts[0], ReplacementPart::Literal(s) if s == "bar")
				);
			},
			_ => panic!("Expected CommandData::Substitution"),
		}
	}

	#[test]
	fn test_compile_subst_invalid_group_reference() {
		let (mut lines, mut chars) = make_providers(r"s/f(o)o/\2/");
		let mut cmd = Command::default();
		let mut context = ctx();

		let err = compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains("invalid reference \\2"));
	}

	// The BRE→ERE translation and its tests live in `crate::bre`.

	// patch_block_endings

	// Create a command with the specified code.
	fn command_with_code(code: char) -> Rc<RefCell<Command>> {
		Rc::new(RefCell::new(Command { code, ..Default::default() }))
	}

	// Link the vector of passed commands into a list, returning head.
	fn link_commands(cmds: Vec<Rc<RefCell<Command>>>) -> Option<Rc<RefCell<Command>>> {
		for i in 0..cmds.len().saturating_sub(1) {
			cmds[i].borrow_mut().next = Some(cmds[i + 1].clone());
		}
		cmds.first().cloned()
	}

	// Return the command codes along the passed linked list.
	fn collect_codes(mut head: Option<Rc<RefCell<Command>>>) -> Vec<char> {
		let mut result = Vec::new();
		while let Some(cmd) = head {
			let cmd_ref = cmd.borrow();
			result.push(cmd_ref.code);
			head = cmd_ref.next.clone();
		}
		result
	}

	#[test]
	fn test_flat_chain() {
		let a = command_with_code('a');
		let b = command_with_code('b');
		let head = link_commands(vec![a, b]);

		patch_block_endings(head.clone());

		assert_eq!(collect_codes(head), vec!['a', 'b']);
	}

	#[test]
	fn test_simple_block_relinks_tail() {
		// a ; { x ; y ; } b
		let a = command_with_code('a');
		let block = command_with_code('{');
		let x = command_with_code('x');
		let y = command_with_code('y');
		let b = command_with_code('b');

		let head = link_commands(vec![a.clone(), block.clone(), b]);
		let sub_head = link_commands(vec![x, y]);
		block.borrow_mut().data = CommandData::BranchTarget(sub_head.clone());

		patch_block_endings(head);

		// Expect x -> y -> b
		assert_eq!(collect_codes(sub_head), vec!['x', 'y', 'b']);
		// Expect a -> { -> b still valid
		assert_eq!(collect_codes(Some(a)), vec!['a', '{', 'b']);
	}

	#[test]
	fn test_empty_block_no_panic() {
		let a = command_with_code('a');
		a.borrow_mut().data = CommandData::BranchTarget(None);

		patch_block_endings(Some(a.clone()));

		assert_eq!(collect_codes(Some(a)), vec!['a']);
	}

	#[test]
	fn test_nested_blocks() {
		// a
		// {
		//   m
		//   {
		//     x
		//     y
		//   }
		//   n
		// }
		// b
		let a = command_with_code('a');
		let b = command_with_code('b');
		let x = command_with_code('x');
		let y = command_with_code('y');
		let m = command_with_code('m');
		let n = command_with_code('n');
		let outer_block = command_with_code('{');
		let inner_block = command_with_code('{');

		let head = link_commands(vec![a, outer_block.clone(), b]);
		let outer = link_commands(vec![m, inner_block.clone(), n]);
		let inner = link_commands(vec![x, y]);
		outer_block.borrow_mut().data = CommandData::BranchTarget(outer.clone());
		inner_block.borrow_mut().data = CommandData::BranchTarget(inner.clone());

		patch_block_endings(head.clone());

		assert_eq!(collect_codes(head), vec!['a', '{', 'b']);
		assert_eq!(collect_codes(inner), vec!['x', 'y', 'n', 'b']);
		assert_eq!(collect_codes(outer), vec!['m', '{', 'n', 'b']);
	}

	#[test]
	fn test_empty_nested_blocks() {
		// a
		// {
		//   {
		//     x
		//   }
		// }
		// b
		let a = command_with_code('a');
		let b = command_with_code('b');
		let x = command_with_code('x');
		let outer_block = command_with_code('{');
		let inner_block = command_with_code('{');

		let head = link_commands(vec![a, outer_block.clone(), b]);
		let outer = link_commands(vec![inner_block.clone()]);
		let inner = link_commands(vec![x]);
		outer_block.borrow_mut().data = CommandData::BranchTarget(outer.clone());
		inner_block.borrow_mut().data = CommandData::BranchTarget(inner.clone());

		patch_block_endings(head.clone());

		assert_eq!(collect_codes(head), vec!['a', '{', 'b']);
		assert_eq!(collect_codes(outer), vec!['{', 'b']);
		assert_eq!(collect_codes(inner), vec!['x', 'b']);
	}

	// compile_read_file_command
	#[test]
	fn test_compile_read_file_command_rejected_under_sandbox() {
		let (mut lines, mut chars) = make_providers("r input.txt");
		let mut cmd = Command::default();
		let mut context = ctx();
		context.sandbox = true;

		let err =
			compile_read_file_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains(ERR_SANDBOX));
	}

	// compile_write_file_command
	#[test]
	fn test_compile_write_file_command_rejected_under_sandbox() {
		let (mut lines, mut chars) = make_providers("w out.txt");
		let mut cmd = Command::default();
		let mut context = ctx();
		context.sandbox = true;

		let err =
			compile_write_file_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains(ERR_SANDBOX));
	}

	// compile_label_command
	#[test]
	fn test_compile_label_command() {
		let (mut lines, mut chars) = make_providers(": foo");
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_label_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Label(label) => {
				let name = label.clone().unwrap();
				assert_eq!(name, "foo");
			},
			_ => panic!("Expected CommandData::Label"),
		}
	}

	#[test]
	fn test_compile_missing_label_command() {
		let (mut lines, mut chars) = make_providers(": ;");
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		cmd.code = ':';
		let err = compile_label_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains("\":\" lacks a label"));
	}

	#[test]
	fn test_compile_empty_label_command() {
		let (mut lines, mut chars) = make_providers("b ;");
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		cmd.code = 'b';
		compile_label_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Label(label) => {
				assert!(label.is_none());
			},
			_ => panic!("Expected CommandData::Label(None)"),
		}
	}

	// populate_label_map
	fn command_with_data(data: CommandData) -> Rc<RefCell<Command>> {
		Rc::new(RefCell::new(Command { data, ..Default::default() }))
	}

	#[test]
	fn test_single_label() {
		let cmd = command_with_data(CommandData::Label(Some("start".to_string())));
		cmd.borrow_mut().code = ':';
		let mut context = ProcessingContext::default();

		populate_label_map(Some(cmd.clone()), &mut context);

		assert_eq!(context.label_to_command_map.len(), 1);
		assert!(context.label_to_command_map.contains_key("start"));
		assert!(Rc::ptr_eq(&context.label_to_command_map["start"], &cmd));
	}

	#[test]
	fn test_label_inside_block() {
		let nested = command_with_data(CommandData::Label(Some("inside".to_string())));
		nested.borrow_mut().code = ':';
		let block = command_with_data(CommandData::BranchTarget(Some(nested.clone())));
		let mut context = ProcessingContext::default();

		populate_label_map(Some(block), &mut context);

		assert_eq!(context.label_to_command_map.len(), 1);
		assert!(context.label_to_command_map.contains_key("inside"));
		assert!(Rc::ptr_eq(&context.label_to_command_map["inside"], &nested));
	}

	#[test]
	fn test_multiple_labels() {
		let a = command_with_data(CommandData::Label(Some("a".to_string())));
		a.borrow_mut().code = ':';
		let b = command_with_data(CommandData::Label(Some("b".to_string())));
		b.borrow_mut().code = ':';
		let head = link_commands(vec![a, b]);

		let mut context = ProcessingContext::default();
		populate_label_map(head, &mut context);

		assert_eq!(context.label_to_command_map.len(), 2);
		assert!(context.label_to_command_map.contains_key("a"));
		assert!(context.label_to_command_map.contains_key("b"));
	}

	#[test]
	fn test_no_labels() {
		let a = command_with_data(CommandData::None);
		let b = command_with_data(CommandData::None);
		let head = link_commands(vec![a, b]);

		let mut context = ProcessingContext::default();
		populate_label_map(head, &mut context);

		assert_eq!(context.label_to_command_map.len(), 0);
	}

	#[test]
	fn test_label_none_is_ignored() {
		let cmd = command_with_data(CommandData::Label(None));
		let mut context = ProcessingContext::default();

		populate_label_map(Some(cmd), &mut context);

		// The map should remain empty since the label is None
		assert_eq!(context.label_to_command_map.len(), 0);
	}

	#[test]
	fn test_duplicate_label_resolves_to_last_definition() {
		// GNU accepts a repeated label and jumps to its last definition.
		let a1 = command_with_data(CommandData::Label(Some("dup".to_string())));
		a1.borrow_mut().code = ':';

		let a2 = command_with_data(CommandData::Label(Some("dup".to_string())));
		a2.borrow_mut().code = ':';

		let head = link_commands(vec![a1, a2.clone()]);
		let mut context = ProcessingContext::default();

		populate_label_map(head, &mut context);

		assert!(Rc::ptr_eq(&context.label_to_command_map["dup"], &a2));
	}

	// populate_range_commands
	fn command_with_range(
		code: char,
		start: usize,
		end: usize,
		data: CommandData,
	) -> Rc<RefCell<Command>> {
		Rc::new(RefCell::new(Command {
			code,
			addr1: Some(Address::Line(start)),
			addr2: Some(Address::Line(end)),
			data,
			..Default::default()
		}))
	}

	#[test]
	fn test_range_address() {
		let cmd = command_with_range('p', 3, 5, CommandData::None);
		let mut context = ProcessingContext::default();
		assert_eq!(context.range_commands.len(), 0);

		populate_range_commands(Some(cmd.clone()), &mut context);

		assert_eq!(context.range_commands.len(), 1);

		// Verify it is the same command
		let rc = &context.range_commands[0];
		assert!(Rc::ptr_eq(rc, &cmd));

		// Verify addresses
		let cmd_ref = rc.borrow();

		assert!(matches!(cmd_ref.addr1, Some(Address::Line(3))));
		assert!(matches!(cmd_ref.addr2, Some(Address::Line(5))));
	}

	#[test]
	fn test_non_range_addresses_do_not_register() {
		let mut context = ProcessingContext::default();

		// Zero-address command
		let cmd0 = Rc::new(RefCell::new(Command {
			code: 'p',
			data: CommandData::None,
			..Default::default()
		}));

		populate_range_commands(Some(cmd0), &mut context);
		assert!(context.range_commands.is_empty());

		// One-address command
		let cmd1 = Rc::new(RefCell::new(Command {
			code: 'p',
			addr1: Some(Address::Line(3)),
			data: CommandData::None,
			..Default::default()
		}));

		populate_range_commands(Some(cmd1), &mut context);
		assert!(context.range_commands.is_empty());
	}

	#[test]
	fn test_range_address_outside_and_inside_block() {
		// Top-level range command: 1,2p
		let outer = command_with_range('p', 1, 2, CommandData::None);

		// Nested range command: 3,5p
		let nested = command_with_range('p', 3, 5, CommandData::None);

		// Block containing the nested range command
		let block = command_with_data(CommandData::BranchTarget(Some(nested.clone())));

		// Link outer -> block
		outer.borrow_mut().next = Some(block);

		let mut context = ProcessingContext::default();
		assert_eq!(context.range_commands.len(), 0);

		populate_range_commands(Some(outer.clone()), &mut context);

		// Two range commands must be found.
		assert_eq!(context.range_commands.len(), 2);

		// Verify both commands are present (order-independent).
		assert!(
			context
				.range_commands
				.iter()
				.any(|rc| Rc::ptr_eq(rc, &outer))
		);
		assert!(
			context
				.range_commands
				.iter()
				.any(|rc| Rc::ptr_eq(rc, &nested))
		);

		let nested_ref = nested.borrow();

		let addr1 = nested_ref.addr1.as_ref().expect("nested addr1 missing");
		assert!(matches!(addr1, Address::Line(3)));

		let addr2 = nested_ref.addr2.as_ref().expect("nested addr2 missing");
		assert!(matches!(addr2, Address::Line(5)));
	}

	// resolve_branch_targets
	#[test]
	fn test_branch_target_resolved() {
		let target = command_with_data(CommandData::Label(Some("end".to_string())));
		target.borrow_mut().code = ':';

		let branch = command_with_data(CommandData::Label(Some("end".to_string())));
		branch.borrow_mut().code = 'b';

		let head = link_commands(vec![branch.clone(), target.clone()]);
		let mut context = ProcessingContext::default();

		populate_label_map(head.clone(), &mut context);
		let result = resolve_branch_targets(head, &mut context);
		assert!(result.is_ok());

		match &branch.borrow().data {
			CommandData::BranchTarget(Some(ptr)) => {
				assert!(Rc::ptr_eq(ptr, &target));
			},
			_ => panic!("Expected BranchTarget(Some(...))"),
		}
	}

	#[test]
	fn test_branch_target_missing_label_gives_error() {
		let branch = command_with_data(CommandData::Label(Some("nope".to_string())));
		branch.borrow_mut().code = 't';

		let mut context = ProcessingContext::default();
		let result = resolve_branch_targets(Some(branch), &mut context);

		assert!(result.is_err());
		let err = result.unwrap_err().to_string();
		assert!(err.contains("can't find label for jump to `nope'"));
	}

	#[test]
	fn test_branch_with_no_label_resolves_to_none() {
		let branch = command_with_data(CommandData::Label(None));
		branch.borrow_mut().code = 'b';

		let mut context = ProcessingContext::default();
		let result = resolve_branch_targets(Some(branch.clone()), &mut context);

		assert!(result.is_ok());
		match &branch.borrow().data {
			CommandData::BranchTarget(None) => {}, // ok
			_ => panic!("Expected BranchTarget(None)"),
		}
	}

	#[test]
	fn test_non_branch_label_is_unchanged() {
		let cmd = command_with_data(CommandData::Label(Some("unchanged".to_string())));
		cmd.borrow_mut().code = 'q'; // not a branch command

		let mut context = ProcessingContext::default();
		let result = resolve_branch_targets(Some(cmd.clone()), &mut context);
		assert!(result.is_ok());

		match &cmd.borrow().data {
			CommandData::Label(Some(label)) => assert_eq!(label, "unchanged"),
			_ => panic!("Expected Label(Some(...)) to remain unchanged"),
		}
	}

	#[test]
	fn test_branch_in_nested_block() {
		let label = command_with_data(CommandData::Label(Some("inner".to_string())));
		label.borrow_mut().code = ':';

		let branch = command_with_data(CommandData::Label(Some("inner".to_string())));
		branch.borrow_mut().code = 't';

		let block = command_with_data(CommandData::BranchTarget(Some(label.clone())));
		let head = link_commands(vec![branch.clone(), block]);

		let mut context = ProcessingContext::default();
		populate_label_map(Some(label.clone()), &mut context);
		let result = resolve_branch_targets(head, &mut context);

		assert!(result.is_ok());
		match &branch.borrow().data {
			CommandData::BranchTarget(Some(ptr)) => assert!(Rc::ptr_eq(ptr, &label)),
			_ => panic!("Expected BranchTarget(Some(...))"),
		}
	}

	// compile_text_command
	#[test]
	fn test_compile_single_line_text_command() {
		let mut chars = make_char_provider("a\\");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "line1\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_posix_spaces_single_line() {
		// GNU --posix keeps the text after `a\` on the same line, a lone space included.
		let mut chars = make_char_provider("a \\ ");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), " \n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_posix_incomplete() {
		let (mut lines, mut chars) = make_providers("i\\");
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };
		let result = compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context);
		let err = result.unwrap_err().to_string();
		assert!(err.contains("incomplete command"));
	}

	#[test]
	fn test_compile_text_command_gnu_optional_backslash() {
		let mut chars = make_char_provider("athere");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "there\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_gnu_optional_backslash_spaces() {
		let mut chars = make_char_provider("a \t there");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "there\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_gnu_no_text() {
		let mut chars = make_char_provider("a");
		let mut lines = make_line_provider(&[]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		let result = compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context);
		assert!(result.is_err());
		let err = result.unwrap_err().to_string();
		assert!(err.contains(ERR_EXPECTED_TEXT));
	}

	#[test]
	fn test_compile_text_command_gnu_optional_backslash_escape_eof() {
		let mut chars = make_char_provider("a\\");
		let mut lines = make_line_provider(&[]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_gnu_no_first_escape() {
		let mut chars = make_char_provider("a\\tom");
		let mut lines = make_line_provider(&[]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "tom\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_gnu_char_escapes() {
		let mut chars = make_char_provider("i\\>\\h\\elll\\bo\\nto\\");
		let mut lines = make_line_provider(&["all\\a", ""]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), ">helll\x08o\nto\nall\x07\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_two_line_text_command() {
		let mut chars = make_char_provider("a\\");
		let mut lines = make_line_provider(&["line1\\", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext::default();

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "line1\nline2\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_posix_without_backslash() {
		let mut chars = make_char_provider("a");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		let result = compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context);
		assert!(result.is_err());
		let err = result.unwrap_err().to_string();
		assert!(err.contains(ERR_EXPECTED_TEXT));
	}

	#[test]
	fn test_compile_text_command_posix_with_trailing_chars() {
		// `sed --posix 'a\ foo'` must append " foo", not fail.
		let mut chars = make_char_provider("a \\ foo");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), " foo\n");
			},
			_ => panic!("Expected CommandData::Text"),
		}
	}

	#[test]
	fn test_compile_text_command_posix_text_from_another_piece_is_incomplete() {
		// `sed --posix -e 'a\' -e text` is GNU's "incomplete command", not an append.
		let mut chars = make_char_provider("a\\");
		let mut lines = make_line_provider(&["line1"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		let err = compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert_eq!(err.to_string(), "-e expression #1, char 2: incomplete command");
	}

	// read_file_path
	#[test]
	fn test_read_existing_file_path() {
		let (lines, mut chars) = make_providers("r /etc/motd");

		let path = read_file_path(&lines, &mut chars).unwrap();
		assert_eq!(path.to_str().unwrap(), "/etc/motd");
	}

	#[test]
	fn test_read_missing_file_path() {
		let (lines, mut chars) = make_providers("w ");

		let err = read_file_path(&lines, &mut chars).unwrap_err();
		assert!(err.to_string().contains(ERR_MISSING_FILENAME));
	}
}
}
pub mod delimited_parser {
// Parse delimited character sequences
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::char;

use crate::sed::error_handling::SedResult;

use crate::sed::{
	command::{RE_DUP_MAX, RegexMode},
	error_handling::compilation_error,
	script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};

/// GNU sed's message for a `y` command missing a delimiter.
pub const ERR_UNTERMINATED_Y: &str = "unterminated `y' command";

/// Return true if c is a valid octal digit
fn is_ascii_octal_digit(c: char) -> bool {
	matches!(c, '0'..='7')
}

/// Parse a numeric character escape and return the corresponding char.
/// Advance line to the first character not part of the escape.
/// ndigits is the number of allowed digits and radix is the value's
/// radix (e.g. 8, 10, 16 for octal, decimal, and hex escapes).
/// For values up to 3 ndigits is the maximum number of allowed digits,
/// for values above 3 ndigits is the exact number of allowed digits.
/// Return `None` if no valid character has been specified.
fn parse_numeric_escape(
	line: &mut ScriptCharProvider,
	is_allowed_char: fn(char) -> bool,
	ndigits: usize,
	radix: u32,
) -> Option<char> {
	let mut valid_chars = Vec::new();

	for _ in 0..ndigits {
		if !line.eol() && is_allowed_char(line.current()) {
			valid_chars.push(line.current());
			line.advance();
		} else {
			break;
		}
	}

	if valid_chars.is_empty() {
		return None;
	}

	if ndigits > 3 && valid_chars.len() != ndigits {
		line.retreat(valid_chars.len());
		return None;
	}

	let char_string: String = valid_chars.into_iter().collect();
	match u32::from_str_radix(&char_string, radix)
		.ok()
		.and_then(char::from_u32)
	{
		Some(decoded) => Some(decoded),
		None => panic!("Unable to decode numeric character escape."),
	}
}

/// Transforms the specified character into the corresponding ASCII
/// control character as follows.
/// - Convert lowercase letters to uppercase
/// - XOR the ASCII value with 0x40 (inverts bit 6)
///
/// Return `None` if the result is not a valid Unicode scalar.
fn create_control_char(x: char) -> Option<char> {
	if !x.is_ascii() {
		return None;
	}

	let c = x.to_ascii_uppercase();

	let transformed = (c as u8) ^ 0x40;
	char::from_u32(u32::from(transformed))
}

/// Parse a character escape valid in all contexts (RE pattern, substitution,
/// transliterarion) and return the corresponding char.
/// At entry line.current() must have advanced after the `\\`.
/// Advance line to the first character not part of the escape.
/// Return `None` if an invalid escape has been specified.
pub fn parse_char_escape(line: &mut ScriptCharProvider) -> Option<char> {
	match line.current() {
		'a' => {
			line.advance();
			Some('\x07')
		},
		'b' => {
			line.advance();
			Some('\x08')
		},
		'f' => {
			line.advance();
			Some('\x0c')
		},
		'n' => {
			line.advance();
			Some('\n')
		},
		'r' => {
			line.advance();
			Some('\r')
		},
		't' => {
			line.advance();
			Some('\t')
		},
		'v' => {
			line.advance();
			Some('\x0b')
		},

		'c' => {
			// Control character escape: \cC
			line.advance(); // move past 'c'
			match create_control_char(line.current()) {
				Some(decoded) => {
					line.advance();
					Some(decoded)
				},
				None => Some('c'),
			}
		},

		'd' => {
			// Decimal escape: \dnnn
			line.advance(); // move past 'd'
			match parse_numeric_escape(line, |c| c.is_ascii_digit(), 3, 10) {
				Some(decoded) => Some(decoded),
				None => Some('d'),
			}
		},

		'o' => {
			// Octal escape: \onnn
			line.advance(); // move past 'o'
			match parse_numeric_escape(line, is_ascii_octal_digit, 3, 8) {
				Some(decoded) => Some(decoded),
				None => Some('o'),
			}
		},

		'u' => {
			// Short Unicode escape \uXXXX (exactly four hex digits)
			line.advance(); // move past 'x'
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 4, 16) {
				Some(decoded) => Some(decoded),
				None => Some('u'),
			}
		},

		'U' => {
			// Short Unicode escape \UXXXXXXXX (exactly eight heax digits)
			line.advance(); // move past 'x'
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 8, 16) {
				Some(decoded) => Some(decoded),
				None => Some('U'),
			}
		},

		'x' => {
			// Hexadecimal escape: \xnn
			line.advance(); // move past 'x'
			match parse_numeric_escape(line, |c| c.is_ascii_hexdigit(), 2, 16) {
				Some(decoded) => Some(decoded),
				None => Some('x'),
			}
		},
		_ => None,
	}
}

/// Parse a POSIX RE character class returning it as a string.
/// This functionality is needed to avoid terminating delimited
/// sequences when a delimiter appears within a character class.
/// Also decode sed's recognized character escapes, but a POSIX bracket
/// expression has no regex escape syntax of its own.
fn parse_character_class(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	unterminated: &str,
) -> SedResult<String> {
	let mut result = String::new();

	assert!(!line.eol() && line.current() == '[', "Invalid character class.");

	line.advance();
	result.push('[');

	// Optional negation
	if !line.eol() && line.current() == '^' {
		result.push('^');
		line.advance();
	}

	// Optional leading ']' inside the class
	if !line.eol() && line.current() == ']' {
		result.push(']');
		line.advance();
	}

	while !line.eol() {
		let ch = line.current();

		if ch == ']' {
			result.push(']');
			line.advance();
			return Ok(result);
		}

		if ch == '[' {
			line.advance();
			if line.eol() {
				result.push('[');
				continue;
			}
			let marker = line.current();
			// POSIX character class, collating symbol, or equivalence
			if marker == ':' || marker == '.' || marker == '=' {
				line.advance();

				result.push('[');
				result.push(marker);

				let mut terminated = false;

				while !line.eol() {
					let c = line.current();
					if c == marker {
						line.advance();
						if !line.eol() && line.current() == ']' {
							line.advance();
							result.push(marker);
							result.push(']');
							terminated = true;
							break;
						}
						// False alarm, just part of the inner name
						result.push(marker);
					} else {
						result.push(c);
						line.advance();
					}
				}

				if !terminated {
					return compilation_error(lines, line, unterminated);
				}

				continue;
			}
			// The next character may itself be a closing bracket or the
			// start of another bracket construct. Do not consume it here.
			result.push('[');
			continue;
		}

		if ch == '\\' {
			// Handle escape sequence
			line.advance();
			if line.eol() {
				break;
			}
			if let Some(decoded) = parse_char_escape(line) {
				result.push(decoded);
			} else {
				result.push('\\');
				if line.current() == '\\' {
					result.push('\\');
					line.advance();
				}
			}
		} else {
			result.push(ch);
			line.advance();
		}
	}

	compilation_error(lines, line, unterminated)
}

/// Scan and return the opening delimiter of a delimited string
/// Advances the line past the opening delimiter
fn scan_delimiter(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	unterminated: &str,
) -> SedResult<char> {
	if line.eol() {
		return compilation_error(lines, line, unterminated);
	}

	let delimiter = line.current();
	line.advance(); // skip the opening delimiter
	Ok(delimiter)
}

/// A delimited regular expression as parsed from the script.
#[derive(Debug)]
pub struct RegexSource {
	/// The pattern, with sed's character escapes decoded.
	pub pattern: String,
	/// An invalid interval; GNU reports it only once the whole command is read.
	pub error:   Option<&'static str>,
}

/// Parse the regular expression delimited by the current line
/// character and return it.
/// On return, the line is on the closing delimiter.
/// In Basic mode, quantifiers like {m,n} must be escaped (\{m,n\}).
/// In Extended mode, quantifiers like {m,n} don't require escaping.
/// A missing closing delimiter fails with `unterminated`.
pub fn parse_regex(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	regex_mode: RegexMode,
	unterminated: &str,
) -> SedResult<RegexSource> {
	let delimiter = scan_delimiter(lines, line, unterminated)?;
	let mut result = String::new();
	let mut error = None;
	while !line.eol() {
		match line.current() {
			// A backslash delimiter ends the regex wherever it appears (GNU).
			c if c == delimiter => return Ok(RegexSource { pattern: result, error }),
			'[' => {
				let cc = parse_character_class(lines, line, unterminated)?;
				result.push_str(&cc);
				continue;
			},
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, unterminated);
				}
				if line.current() == delimiter {
					// Push escaped delimiter
					result.push(line.current());
					line.advance();
					continue;
				}
				if line.current() == '{' && matches!(regex_mode, RegexMode::Basic) {
					match validate_quantifier_structure(line, delimiter, RegexMode::Basic)
						.and_then(|()| validate_quantifier_numbers(line))
					{
						Ok(quantifier) => {
							result.push('\\');
							result.push('{');
							result.push_str(&quantifier);
						},
						Err(msg) => {
							error.get_or_insert(msg);
						},
					}
					continue;
				}
				if line.current() == '}' {
					result.push('\\');
					result.push('}');
					line.advance();
					continue;
				}
				if line.current() == 'b' {
					// In a regex `\b` is a word boundary, never a backspace; GNU sed
					// omits the backspace escape for exactly this conflict.
					result.push_str("\\b");
					line.advance();
					continue;
				}
				// GNU's buffer anchors, which match only at the very start and end
				// of the pattern space, even in multiline mode.
				if let Some(anchor) = match line.current() {
					'`' => Some("\\A"),
					'\'' => Some("\\z"),
					_ => None,
				} {
					result.push_str(anchor);
					line.advance();
					continue;
				}
				if let Some(decoded) = parse_char_escape(line) {
					result.push(decoded);
				} else {
					// Pass through \<any> to RE engine for further treatment
					result.push('\\');
					result.push(line.current());
					line.advance();
				}
				continue;
			},
			'{' if matches!(regex_mode, RegexMode::Extended) => {
				match validate_quantifier_structure(line, delimiter, RegexMode::Extended)
					.and_then(|()| validate_quantifier_numbers(line))
				{
					Ok(quantifier) => {
						result.push('{');
						result.push_str(&quantifier);
					},
					Err(msg) => {
						error.get_or_insert(msg);
					},
				}
				continue;
			},
			'}' => {
				result.push('}');
				line.advance();
				continue;
			},

			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, unterminated)
}

// Check for closing brace and the structure/content.
// On failure the line is left where scanning stopped.
fn validate_quantifier_structure(
	line: &mut ScriptCharProvider,
	delimiter: char,
	regex_mode: RegexMode,
) -> Result<(), &'static str> {
	let invalid_content_error_msg = "Invalid content of \\{\\}";
	let mut found_closing_brace = false;
	let mut seen_comma = false;
	let mut invalid_content_detected = false;
	let mut is_quantifier_empty = true;
	let initial_pos = line.get_pos();
	line.advance();

	while !line.eol() && line.current() != delimiter {
		match regex_mode {
			RegexMode::Extended => {
				// In ERE mode, look for }
				if line.current() == '}' {
					// Empty quantifier {} is not valid
					if is_quantifier_empty {
						invalid_content_detected = true;
					}
					found_closing_brace = true;
					break;
				}
				// Entering means there is no } immediately after the {
				is_quantifier_empty = false;
				// Only digits and one comma allowed
				if line.current() == ',' {
					if seen_comma {
						invalid_content_detected = true;
					}
					seen_comma = true;
				} else if !line.current().is_ascii_digit() {
					invalid_content_detected = true;
				}
				line.advance();
			},
			RegexMode::Basic => {
				// In BRE mode, look for \}
				if line.current() == '\\' {
					line.advance();
					if !line.eol() && line.current() == '}' {
						if is_quantifier_empty {
							invalid_content_detected = true;
						}
						found_closing_brace = true;
					} else {
						invalid_content_detected = true;
					}
					break;
				}
				is_quantifier_empty = false;
				if line.current() == ',' {
					if seen_comma {
						invalid_content_detected = true;
					}
					seen_comma = true;
				} else if !line.current().is_ascii_digit() {
					invalid_content_detected = true;
				}
				line.advance();
			},
		}
	}

	if !found_closing_brace {
		return Err("Unmatched \\{");
	}

	if invalid_content_detected {
		return Err(invalid_content_error_msg);
	}

	line.set_position(initial_pos);
	Ok(())
}

// Parse an already-structure-validated run of digits into a quantifier bound.
// `validate_quantifier_structure` guarantees the run contains only ASCII
// digits, so the sole failure mode is a value exceeding what fits, which sed
// reports as "Regular expression too big" (same as exceeding RE_DUP_MAX).
fn parse_quantifier_bound(digits: &str) -> Result<usize, &'static str> {
	match digits.parse::<usize>() {
		Ok(val) if val <= RE_DUP_MAX => Ok(val),
		_ => Err("Regular expression too big"),
	}
}

// Performs validations on m and/or n values of the quantifier
// and returns the valid content as a string (without braces).
fn validate_quantifier_numbers(line: &mut ScriptCharProvider) -> Result<String, &'static str> {
	line.advance(); // Skip the opening brace.

	// Collect m. It may be empty for the {,n} and {,} forms, which mean {0,n}
	// and {0,} respectively.
	let mut m = String::new();
	while line.current() != ',' && line.current() != '}' && line.current() != '\\' {
		m.push(line.current());
		line.advance();
	}

	// Collect n when a comma is present.
	let has_comma = line.current() == ',';
	let mut n = String::new();
	if has_comma {
		line.advance();
		while line.current() != '}' && line.current() != '\\' {
			n.push(line.current());
			line.advance();
		}
	}

	// An absent m defaults to 0; both m and n are bounded by RE_DUP_MAX.
	let m_val = if m.is_empty() { 0 } else { parse_quantifier_bound(&m)? };
	let n_val = if n.is_empty() { None } else { Some(parse_quantifier_bound(&n)?) };

	// Validate m <= n if both present.
	if let Some(n_val) = n_val
		&& m_val > n_val
	{
		return Err("Invalid content of \\{\\}");
	}

	// Rebuild the validated content (without braces), defaulting an absent m
	// to 0 so the emitted pattern stays well-formed.
	let mut result = if m.is_empty() { "0".to_string() } else { m };
	if has_comma {
		result.push(',');
		result.push_str(&n);
	}

	Ok(result)
}

/// Parse the transliteration string delimited by the current line
/// character and return it as a string.
/// On return the line is on the closing delimiter.
pub fn parse_transliteration(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<String> {
	let delimiter = scan_delimiter(lines, line, ERR_UNTERMINATED_Y)?;
	let mut result = String::new();

	while !line.eol() {
		match line.current() {
			// A backslash delimiter ends the string wherever it appears (GNU).
			c if c == delimiter => return Ok(result),
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, ERR_UNTERMINATED_Y);
				}
				if line.current() == delimiter || line.current() == '\\' {
					// Push only the escaped character
					result.push(line.current());
					line.advance();
					continue;
				}
				if let Some(decoded) = parse_char_escape(line) {
					result.push(decoded);
				} else {
					// Pass through \<any> to tr for literal use
					result.push('\\');
					result.push(line.current());
					line.advance();
				}
				continue;
			},
			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, ERR_UNTERMINATED_Y)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_providers(input: &str) -> (ScriptLineProvider, ScriptCharProvider) {
		let lines = ScriptLineProvider::new(vec![]); // Empty for tests
		let line = ScriptCharProvider::new(input);
		(lines, line)
	}

	// parse_numeric_escape
	#[test]
	fn test_compile_octal_escape() {
		let mut provider = ScriptCharProvider::new("141rest");
		let c = parse_numeric_escape(&mut provider, is_ascii_octal_digit, 3, 8);
		assert_eq!(c, Some('a'));
		assert_eq!(provider.current(), 'r'); // "141" was consumed
	}

	#[test]
	fn test_compile_octal_escape_eol() {
		let mut provider = ScriptCharProvider::new("141");
		let c = parse_numeric_escape(&mut provider, is_ascii_octal_digit, 3, 8);
		assert_eq!(c, Some('a'));
		assert!(provider.eol()); // "141" was consumed
	}

	#[test]
	fn test_compile_decimal_escape() {
		let mut provider = ScriptCharProvider::new("0659");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_digit(), 3, 10);
		assert_eq!(c, Some('A'));
		assert_eq!(provider.current(), '9'); // "65" was consumed
	}

	#[test]
	fn test_compile_decimal_invalid() {
		let mut provider = ScriptCharProvider::new("QR");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_digit(), 3, 10);
		assert_eq!(c, None);
		assert_eq!(provider.current(), 'Q');
	}

	#[test]
	fn test_compile_hex_escape() {
		let mut provider = ScriptCharProvider::new("3cZ");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 2, 16);
		assert_eq!(c, Some('<'));
		assert_eq!(provider.current(), 'Z'); // "41" was consumed
	}

	#[test]
	fn test_compile_hex_escape_truncated() {
		let mut provider = ScriptCharProvider::new("4G");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 2, 16);
		assert_eq!(c, Some('\u{4}')); // Only '4' is valid hex
		assert_eq!(provider.current(), 'G'); // "41" was consumed
	}

	#[test]
	fn test_compile_unicode_escape_short() {
		// U+2665 = '♥'
		let mut provider = ScriptCharProvider::new("26650");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 4, 16);
		assert_eq!(c, Some('♥'));
		assert_eq!(provider.current(), '0'); // "2665" was consumed
	}

	#[test]
	fn test_compile_unicode_escape_short_invalid() {
		let mut provider = ScriptCharProvider::new("123Q");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 4, 16);
		assert_eq!(c, None);
		assert_eq!(provider.current(), '1');
	}

	#[test]
	fn test_compile_unicode_escape_long_invalid() {
		// U+2665 = '♥'
		let mut provider = ScriptCharProvider::new("1234567Q");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 8, 16);
		assert_eq!(c, None);
		assert_eq!(provider.current(), '1');
	}

	#[test]
	fn test_compile_unicode_escape_long() {
		// U+1F600 = 😀
		let mut provider = ScriptCharProvider::new("0001F6009");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_hexdigit(), 8, 16);
		assert_eq!(c, Some('😀'));
		assert_eq!(provider.current(), '9'); // "0001F600" was consumed
	}

	#[test]
	fn test_no_valid_digits() {
		let mut provider = ScriptCharProvider::new("xyz");
		let c = parse_numeric_escape(&mut provider, |c| c.is_ascii_digit(), 3, 10);
		assert_eq!(c, None);
		assert_eq!(provider.current(), 'x'); // No advancement
	}

	// create_control_char
	#[test]
	fn test_lowercase_letter() {
		assert_eq!(create_control_char('z'), Some('\u{1a}')); // 0x5A ^ 0x40 = 0x1A
		assert_eq!(create_control_char('a'), Some('\u{01}')); // 0x41 ^ 0x40 = 0x01
	}

	#[test]
	fn test_uppercase_letter() {
		assert_eq!(create_control_char('Z'), Some('\u{1a}'));
		assert_eq!(create_control_char('A'), Some('\u{01}'));
	}

	#[test]
	fn test_symbol_characters() {
		assert_eq!(create_control_char('{'), Some(';')); // 0x7B ^ 0x40 = 0x3B
		assert_eq!(create_control_char(';'), Some('{')); // 0x3B ^ 0x40 = 0x7B
	}

	#[test]
	fn test_non_ascii_char() {
		// This will not match any transformation and may panic if it overflows
		// But the current function only handles ASCII-safe chars
		assert_eq!(create_control_char('é'), None); // outside ASCII
	}

	#[test]
	fn test_edge_ascii_values() {
		assert_eq!(create_control_char('@'), Some('\0')); // 0x40 ^ 0x40 = 0x00
		assert_eq!(create_control_char('\x7F'), Some('\x3F')); // 0x7F ^ 0x40 = 0x3F
	}

	// parse_char_escape
	fn escape_result_with_current(input: &str) -> (Option<char>, Option<char>) {
		let mut provider = ScriptCharProvider::new(input);
		let result = parse_char_escape(&mut provider);
		let current = if provider.eol() {
			None
		} else {
			Some(provider.current())
		};
		(result, current)
	}

	#[test]
	fn test_standard_escapes_eol() {
		assert_eq!(escape_result_with_current("a"), (Some('\x07'), None));
		assert_eq!(escape_result_with_current("f"), (Some('\x0c'), None));
		assert_eq!(escape_result_with_current("n"), (Some('\n'), None));
		assert_eq!(escape_result_with_current("r"), (Some('\r'), None));
		assert_eq!(escape_result_with_current("t"), (Some('\t'), None));
		assert_eq!(escape_result_with_current("v"), (Some('\x0b'), None));
	}

	#[test]
	fn test_standard_escapes_more() {
		assert_eq!(escape_result_with_current("a."), (Some('\x07'), Some('.')));
		assert_eq!(escape_result_with_current("f."), (Some('\x0c'), Some('.')));
		assert_eq!(escape_result_with_current("n."), (Some('\n'), Some('.')));
		assert_eq!(escape_result_with_current("r."), (Some('\r'), Some('.')));
		assert_eq!(escape_result_with_current("t."), (Some('\t'), Some('.')));
		assert_eq!(escape_result_with_current("v."), (Some('\x0b'), Some('.')));
	}

	#[test]
	fn test_escape_invalid() {
		assert_eq!(escape_result_with_current("zx"), (None, Some('z')));
	}

	#[test]
	fn test_control_escape_valid() {
		assert_eq!(escape_result_with_current("cZ"), (Some('\x1A'), None));
	}

	#[test]
	fn test_control_escape_invalid() {
		assert_eq!(escape_result_with_current("cé"), (Some('c'), Some('é')));
	}

	#[test]
	fn test_decimal_escape_valid() {
		assert_eq!(escape_result_with_current("d065r"), (Some('A'), Some('r')));
	}

	#[test]
	fn test_octal_escape_valid() {
		assert_eq!(escape_result_with_current("o141x"), (Some('a'), Some('x')));
	}

	#[test]
	fn test_hex_escape_valid() {
		assert_eq!(escape_result_with_current("x41;"), (Some('A'), Some(';')));
	}

	#[test]
	fn test_short_unicode_escape_valid() {
		assert_eq!(escape_result_with_current("u2665;"), (Some('♥'), Some(';')));
	}

	#[test]
	fn test_long_unicode_escape_valid() {
		assert_eq!(escape_result_with_current("U0001F600;"), (Some('😀'), Some(';')));
	}

	#[test]
	fn test_decimal_escape_fallback() {
		assert_eq!(escape_result_with_current("d;."), (Some('d'), Some(';')));
	}

	#[test]
	fn test_octal_escape_fallback() {
		assert_eq!(escape_result_with_current("o9x"), (Some('o'), Some('9')));
	}

	#[test]
	fn test_hex_escape_fallback() {
		assert_eq!(escape_result_with_current("xyz"), (Some('x'), Some('y')));
	}

	#[test]
	fn test_unknown_escape() {
		assert_eq!(escape_result_with_current("q"), (None, Some('q')));
	}

	// parse_character_class
	fn char_provider_from(input: &str) -> ScriptCharProvider {
		ScriptCharProvider::new(input)
	}

	fn test_lines() -> ScriptLineProvider {
		ScriptLineProvider::with_active_state("test.sed", 3)
	}

	#[test]
	fn test_basic_character_class() {
		let mut line = char_provider_from("[qr]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[qr]");
	}

	#[test]
	fn test_negated_class() {
		let mut line = char_provider_from("[^abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[^abc]");
	}

	#[test]
	fn test_leading_close_bracket() {
		let mut line = char_provider_from("[]abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[]abc]");
	}

	#[test]
	fn test_leading_negated_close_bracket() {
		let mut line = char_provider_from("[^]abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[^]abc]");
	}

	#[test]
	fn test_escaped_character_begin() {
		let mut line = char_provider_from("[\\nabc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[\nabc]");
	}

	#[test]
	fn test_escaped_character_middle() {
		let mut line = char_provider_from("[a\\nbc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[a\nbc]");
	}

	#[test]
	fn test_escaped_character_end() {
		let mut line = char_provider_from("[abc\\n]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[abc\n]");
	}

	#[test]
	fn test_escaped_delimiter() {
		let mut line = char_provider_from("[a\\]bc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[a\\]");
		assert_eq!(line.current(), 'b');
	}

	#[test]
	fn test_posix_class() {
		let mut line = char_provider_from("[[:digit:]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[[:digit:]]");
	}

	#[test]
	fn test_equivalence_class() {
		let mut line = char_provider_from("[[=a=]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[[=a=]]");
	}

	#[test]
	fn test_collating_symbol() {
		let mut line = char_provider_from("[[.ch.]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[[.ch.]]");
	}

	#[test]
	fn test_unterminated_class_error() {
		let mut line = char_provider_from("[abc"); // missing closing ]
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line, "unterminated");
		assert!(err.is_err());
	}

	#[test]
	fn test_unterminated_posix_class_error() {
		let mut line = char_provider_from("[[:digit:]");
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line, "unterminated");
		assert!(err.is_err());
	}

	#[test]
	fn test_unterminated_escape_error() {
		let mut line = char_provider_from("[abc\\"); // missing closing ]
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line, "unterminated");
		assert!(err.is_err());
	}

	#[test]
	fn test_malformed_posix_like_pattern_treated_as_literal() {
		let mut line = char_provider_from("[[x]yz]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line, "unterminated").unwrap();
		assert_eq!(result, "[[x]");
	}

	// parse_regex
	#[test]
	fn test_simple_regex() {
		let (lines, mut line) = make_providers("/abc/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "abc");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escaped_delimiter() {
		let (lines, mut line) = make_providers("/ab\\/c/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "ab/c");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_capture() {
		let (lines, mut line) = make_providers(r"/\(.\)/c/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, r"\(.\)");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escape_sequence() {
		let (lines, mut line) = make_providers("/ab\\n/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "ab\n");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_basic_regex_quantifier() {
		let (lines, mut line) = make_providers("/a\\{2,3\\}/p");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "a\\{2,3\\}");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_basic_regex_with_unmatched_brace_quantifier() {
		let (lines, mut line) = make_providers("/a\\{2,3/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_basic_regex_with_invalid_content() {
		let (lines, mut line) = make_providers("/a\\{2d,3\\}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_quantifier() {
		let (lines, mut line) = make_providers("/a{2,3}/p");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "a{2,3}");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_extended_regex_with_unmatched_brace_quantifier() {
		let (lines, mut line) = make_providers("/a{2,3/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_extended_regex_with_empty_quantifier() {
		let (lines, mut line) = make_providers("/a{}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_whitespace_quantifier() {
		let (lines, mut line) = make_providers("/a{}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_invalid_m() {
		let (lines, mut line) = make_providers("/a{2d,3}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_invalid_n() {
		let (lines, mut line) = make_providers("/a{2,-3}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_m_gt_n() {
		let (lines, mut line) = make_providers("/a{3,2}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended, "unterminated regular expression").unwrap().error.unwrap();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn errors_on_unterminated_regex() {
		let (lines, mut line) = make_providers("/unterminated");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap_err();
		assert!(err.to_string().contains("unterminated regular expression"));
	}

	#[test]
	fn errors_on_esc_at_re_eol() {
		let (lines, mut line) = make_providers("/foo\\");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap_err();
		assert!(err.to_string().contains("unterminated regular expression"));
	}

	#[test]
	fn backslash_delimiter_ends_the_regex_at_every_backslash() {
		// GNU's `\\a\d` addresses "a"; a backslash cannot escape this delimiter.
		let (lines, mut line) = make_providers("\\a\\\\");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "a");
		assert_eq!(line.current(), '\\');
	}

	#[test]
	fn test_regex_with_character_class() {
		let (lines, mut line) = make_providers("/[a-z]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "[a-z]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_bracket_delimiter() {
		let (lines, mut line) = make_providers("[abc[");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "abc");
		assert_eq!(line.current(), '[');
	}

	#[test]
	fn test_bracket_regex_with_bracket_delimiter() {
		let (lines, mut line) = make_providers("[a\\[0-9]bc[");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "a[0-9]bc");
		assert_eq!(line.current(), '[');
	}

	#[test]
	fn test_regex_with_escaped_bracket_in_character_class() {
		let (lines, mut line) = make_providers("/[a\\]z]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "[a\\]z]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_delimiter_inside_character_class() {
		let (lines, mut line) = make_providers("/[a/c]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "[a/c]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escaped_paren_and_backslash() {
		let (lines, mut line) = make_providers("/\\(\\\\/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic, "unterminated regular expression").unwrap();
		assert_eq!(parsed.pattern, "\\(\\\\");
		assert_eq!(line.current(), '/');
	}

	// validate_quantifier_structure
	//BRE tests
	#[test]
	fn test_validate_quantifier_structure_bre_valid() {
		let mut line = ScriptCharProvider::new("{2,3\\}");
		validate_quantifier_structure(&mut line, '/', RegexMode::Basic).unwrap();
		assert_eq!(line.current(), '{'); // Line should be back on the opening brace
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_unmatched_brace() {
		let mut line = ScriptCharProvider::new("{2,3");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_empty_content() {
		let mut line = ScriptCharProvider::new("{\\}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_invalid_char() {
		let mut line = ScriptCharProvider::new("{2d,3\\}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_double_comma() {
		let mut line = ScriptCharProvider::new("{2,3,\\}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	// ERE tests
	#[test]
	fn test_validate_quantifier_structure_ere_valid() {
		let mut line = ScriptCharProvider::new("{2,3}");
		validate_quantifier_structure(&mut line, '/', RegexMode::Extended).unwrap();
		assert_eq!(line.current(), '{'); // Line should be back on the opening brace
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_unmatched_brace() {
		let mut line = ScriptCharProvider::new("{2,3");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_empty_content() {
		let mut line = ScriptCharProvider::new("{}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_invalid_char() {
		let mut line = ScriptCharProvider::new("{2d,3}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_double_comma() {
		let mut line = ScriptCharProvider::new("{2,3,}");
		let err =
			validate_quantifier_structure(&mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	// validate_quantifier_numbers
	#[test]
	fn test_validate_quantifier_numbers_with_m() {
		let mut line = ScriptCharProvider::new("{2}");
		let result = validate_quantifier_numbers(&mut line).unwrap();
		assert_eq!(result, "2");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_single_comma() {
		let mut line = ScriptCharProvider::new("{,}");
		let result = validate_quantifier_numbers(&mut line).unwrap();
		assert_eq!(result, "0,");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_comma_n() {
		let mut line = ScriptCharProvider::new("{,3}");
		let result = validate_quantifier_numbers(&mut line).unwrap();
		assert_eq!(result, "0,3");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_valid() {
		let mut line = ScriptCharProvider::new("{2,3}");
		let result = validate_quantifier_numbers(&mut line).unwrap();
		assert_eq!(result, "2,3");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_m_too_big() {
		let mut line = ScriptCharProvider::new("{32768}");
		let err = validate_quantifier_numbers(&mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_n_too_big() {
		let mut line = ScriptCharProvider::new("{2,32768}");
		let err = validate_quantifier_numbers(&mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_m_gt_n() {
		let mut line = ScriptCharProvider::new("{3,2}");
		let err = validate_quantifier_numbers(&mut line).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_leading_comma_n_too_big() {
		// The {,n} form must bound n by RE_DUP_MAX just like {m,n}.
		let mut line = ScriptCharProvider::new("{,32768}");
		let err = validate_quantifier_numbers(&mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_overflowing_m() {
		// A digit run too large for usize is reported as too big, not as
		// invalid content.
		let mut line = ScriptCharProvider::new("{99999999999999999999999}");
		let err = validate_quantifier_numbers(&mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	// parse_transliteration
	#[test]
	fn test_simple_transliteration() {
		let (lines, mut line) = make_providers("/abc/");
		let parsed = parse_transliteration(&lines, &mut line).unwrap();
		assert_eq!(parsed, "abc");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_transliteration_with_escaped_delimiter() {
		let (lines, mut line) = make_providers("/ab\\/c/");
		let parsed = parse_transliteration(&lines, &mut line).unwrap();
		assert_eq!(parsed, "ab/c");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_transliteration_with_escaped_backslash() {
		let (lines, mut line) = make_providers("/ab\\\\c/");
		let parsed = parse_transliteration(&lines, &mut line).unwrap();
		assert_eq!(parsed, "ab\\c");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_transliteration_with_escape_sequence() {
		let (lines, mut line) = make_providers("/ab\\n/");
		let parsed = parse_transliteration(&lines, &mut line).unwrap();
		assert_eq!(parsed, "ab\n");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn errors_on_unterminated_transliteration() {
		let (lines, mut line) = make_providers("/unterminated");
		let err = parse_transliteration(&lines, &mut line).unwrap_err();
		assert!(
			err.to_string()
				.contains(ERR_UNTERMINATED_Y)
		);
	}

	#[test]
	fn errors_on_esc_at_tr_eol() {
		let (lines, mut line) = make_providers("/foo\\");
		let err = parse_transliteration(&lines, &mut line).unwrap_err();
		assert!(
			err.to_string()
				.contains(ERR_UNTERMINATED_Y)
		);
	}
}
}
pub mod error_handling {
// Parse delimited character sequences
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis

use std::{fmt, io, path::Path, rc::Rc};

use crate::host::strip_errno;
use crate::sed::{
	command::ProcessingContext, script_char_provider::ScriptCharProvider,
	script_line_provider::ScriptLineProvider,
};

/// Error reported while compiling or executing a sed program.
#[derive(Debug)]
pub struct SedError {
	code: i32,
	message: String,
}

impl SedError {
	/// Creates an error carrying sed's observable exit status.
	pub fn new(code: i32, message: impl ToString) -> Self {
		Self { code, message: message.to_string() }
	}

	/// Returns the exit status associated with this failure.
	pub const fn code(&self) -> i32 {
		self.code
	}
}

impl fmt::Display for SedError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for SedError {}

/// An I/O failure is GNU's panic status, 4.
impl From<io::Error> for SedError {
	fn from(error: io::Error) -> Self {
		Self::new(4, strip_errno(&error))
	}
}

impl From<std::str::Utf8Error> for SedError {
	fn from(error: std::str::Utf8Error) -> Self {
		Self::new(2, error)
	}
}

impl From<std::string::FromUtf8Error> for SedError {
	fn from(error: std::string::FromUtf8Error) -> Self {
		Self::new(2, error)
	}
}

impl From<std::num::ParseIntError> for SedError {
	fn from(error: std::num::ParseIntError) -> Self {
		Self::new(1, error)
	}
}

/// A match the engine gives up on is a serious run-time problem, GNU's status 4.
impl From<fancy_regex::Error> for SedError {
	fn from(error: fancy_regex::Error) -> Self {
		Self::new(4, error)
	}
}

/// Result type used throughout the sed compiler and processor.
pub type SedResult<T> = Result<T, SedError>;

/// Adds a lazily generated message to an I/O failure.
pub trait IoContext<T> {
	/// Maps an I/O error to sed's runtime error while preserving context.
	fn map_err_context(self, context: impl FnOnce() -> String) -> SedResult<T>;
}

impl<T> IoContext<T> for io::Result<T> {
	fn map_err_context(self, context: impl FnOnce() -> String) -> SedResult<T> {
		self.map_err(|error| SedError::new(4, format!("{}: {}", context(), strip_errno(&error))))
	}
}

/// Where a script piece came from, as GNU sed names it in compile diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub enum ScriptOrigin {
	/// The Nth string expression; the script operand is #1.
	Expression(usize),
	/// A `-f` script file, as named on the command line, and a line in it.
	File(Rc<str>, usize),
}

impl Default for ScriptOrigin {
	fn default() -> Self {
		Self::Expression(1)
	}
}

impl ScriptOrigin {
	/// Renders GNU's `-e expression #N, char M` or `file F line L` prefix; `offset` is M.
	pub fn describe(&self, offset: usize) -> String {
		match self {
			Self::Expression(number) => format!("-e expression #{number}, char {offset}"),
			Self::File(name, line) => format!("file {name} line {line}"),
		}
	}
}

#[derive(Clone, Debug, Default)]
/// The location in a script where a command is defined.
pub struct ScriptLocation {
	/// GNU-style origin of the command.
	pub origin: ScriptOrigin,
	/// Bytes of the expression GNU had read at the command.
	pub offset: usize,
}

impl ScriptLocation {
	/// Constructs a location from the current script providers.
	pub fn at_position(lines: &ScriptLineProvider, line: &ScriptCharProvider) -> Self {
		Self { origin: lines.origin().clone(), offset: lines.char_offset(line, true) }
	}
}

/// Fails with a compile error found after reading the current character, in GNU's format.
pub fn compilation_error<T>(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	located_compilation_error(lines, lines.char_offset(line, true), msg)
}

/// Fails with `msg` for a command at the end of its line, whose delimiter
/// would be the newline: GNU locates it past that newline
/// ([`ScriptLineProvider::newline_delimiter_offset`]).
pub fn newline_delimiter_error<T>(
	lines: &mut ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	match lines.newline_delimiter_offset() {
		Some(offset) => located_compilation_error(lines, offset, msg),
		None => compilation_error(lines, line, msg),
	}
}

/// Fails with a compile error found before reading the current character, in GNU's format.
pub fn compilation_error_before<T>(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	located_compilation_error(lines, lines.char_offset(line, false), msg)
}

/// Fails with a compile error found after reading the current character, or
/// the line's newline at its end, in GNU's format.
pub fn compilation_error_through_newline<T>(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	let offset = if line.eol() { lines.line_end_offset() } else { lines.char_offset(line, true) };
	located_compilation_error(lines, offset, msg)
}

fn located_compilation_error<T>(lines: &ScriptLineProvider, offset: usize, msg: impl ToString) -> SedResult<T> {
	let location = lines.origin().describe(offset);
	Err(SedError::new(1, format!("{location}: {}", msg.to_string())))
}

/// Fails with a compile error at a command's recorded location, in GNU's format.
pub fn semantic_error<T>(location: &ScriptLocation, msg: impl ToString) -> SedResult<T> {
	Err(SedError::new(
		1,
		format!("{}: {}", location.origin.describe(location.offset), msg.to_string()),
	))
}

/// Fails with a script error GNU finds only at run time; it locates it at the
/// end of the last script piece.
pub fn script_runtime_error<T>(context: &ProcessingContext, msg: impl ToString) -> SedResult<T> {
	Err(SedError::new(1, format!("{}: {}", context.script_end, msg.to_string())))
}

/// GNU's message for an `s` replacement naming a group its regex lacks.
pub fn invalid_reference(group: usize) -> String {
	format!("invalid reference \\{group} on `s' command's RHS")
}

/// GNU's fatal error for a failed read of the input or `r`/`R` file `name`.
pub fn read_error(name: &Path, error: &io::Error) -> SedError {
	SedError::new(4, format!("read error on {}: {}", name.display(), strip_errno(error)))
}
}
pub mod fast_io {
// Zero-copy line-based I/O
//
// Abstractions that allow file lines to be processed and output
// straight from an owned in-memory copy of the input file.  By
// coalescing output requests a single write can be issued for adjacent
// input lines, bypassing per-line copies into owned strings.
// Search for "main" to see a usage example.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

#[cfg(not(unix))]
use std::marker::PhantomData;
use std::{
	cell::Cell,
	io::{self, BufRead, BufReader, BufWriter, Read, Write},
	path::{Path, PathBuf},
	str,
};

#[cfg(unix)]
use memchr::memchr;
use omp_vfs::BlockingFs;
use crate::host::Host;
use crate::sed::error_handling::{SedResult, read_error};

// Define two cursors for iterating over lines:
// - SliceLineCursor over a file read whole into memory,
// - ReadLineCursor based on BufReader.

/// Cursor for zero-copy iteration over an in-memory file snapshot.
#[cfg(unix)]
pub struct SliceLineCursor<'a> {
	data:      &'a [u8], // Snapshot data
	pos:       usize,
	separator: u8,
}

#[cfg(unix)]
/// Represents the get_line return: one line plus whether it was the last.
pub struct NextSliceLine<'a> {
	pub content:   &'a [u8],
	pub full_span: &'a [u8],
}

#[cfg(unix)]
impl<'a> SliceLineCursor<'a> {
	fn new(data: &'a [u8], separator: u8) -> Self {
		Self { data, pos: 0, separator }
	}

	/// Return the next line, if available, or None.
	fn get_line(&mut self) -> io::Result<Option<NextSliceLine<'a>>> {
		if self.pos >= self.data.len() {
			return Ok(None);
		}

		let start = self.pos;

		let content_end = memchr(self.separator, &self.data[start..])
			.map_or(self.data.len(), |pos| start + pos);
		let end = content_end + usize::from(content_end < self.data.len());
		self.pos = end;
		Ok(Some(NextSliceLine {
			content: &self.data[start..content_end],
			full_span: &self.data[start..end],
		}))
	}

	/// Return true if the previously returned line was the last one.
	fn last_line(&mut self) -> io::Result<bool> {
		Ok(self.pos >= self.data.len())
	}
}

/// Streaming record reader with a reusable pattern buffer.
pub struct ReadLineCursor {
	reader:    BufReader<Box<dyn Read>>,
	buffer:    Vec<u8>,
	separator: u8,
}

impl ReadLineCursor {
	/// Construct from anything that implements `Read`.
	fn new(r: impl Read + 'static, separator: u8, unbuffered: bool) -> Self {
		let r: Box<dyn Read> = Box::new(r);
		// A one-byte capacity avoids read-ahead on pipes under -u.
		let reader = if unbuffered { BufReader::with_capacity(1, r) } else { BufReader::new(r) };
		Self { reader, buffer: Vec::new(), separator }
	}


	/// If a record is available, return it and whether it was terminated.
	fn get_line(&mut self) -> io::Result<Option<(Vec<u8>, bool)>> {
		self.buffer.clear();
		if self.reader.read_until(self.separator, &mut self.buffer)? == 0 {
			return Ok(None);
		}
		let terminated = self.buffer.last() == Some(&self.separator);
		if terminated {
			self.buffer.pop();
		}
		Ok(Some((std::mem::take(&mut self.buffer), terminated)))
	}

	/// Return true if the previously returned line was the last one.
	fn last_line(&mut self) -> io::Result<bool> {
		// FIXME(rust-lang#86423): Replace with BufRead::has_data_left()
		// when/if method becomes stable.
		Ok(self.reader.fill_buf()?.is_empty())
	}
}

/// A chunk of data that is input and can be output, often very efficiently
#[derive(Debug, PartialEq, Eq)]
pub struct IOChunk<'a> {
	utf8_valid: Cell<Option<bool>>,
	content:       IOChunkContent<'a>,
}

impl<'a> IOChunk<'a> {
	/// Construct an IOChunk from the given content
	fn from_content(content: IOChunkContent<'a>) -> Self {
		Self { utf8_valid: Cell::new(None), content }
	}

	/// Clear the object's contents, converting it into Owned if needed.
	pub fn clear(&mut self) {
		self.utf8_valid.set(Some(true));
		match &mut self.content {
			IOChunkContent::Owned { content, terminated, .. } => {
				content.clear();
				*terminated = false;
			},
			#[cfg(unix)]
			_ => {
				self.content = IOChunkContent::new_owned(Vec::new(), false);
			},
		}
	}

	/// Return true if the content is empty.
	pub fn is_empty(&self) -> bool {
		self.content.len() == 0
	}

	/// Return true if the content was followed by a record separator.
	pub fn is_terminated(&self) -> bool {
		match &self.content {
			IOChunkContent::Owned { terminated, .. } => *terminated,
			#[cfg(unix)]
			IOChunkContent::SliceInput { content, full_span } => content.len() < full_span.len(),
		}
	}

	#[cfg(test)]
	/// Create an Owned newline-terminated IOChunk from a string.
	pub fn new_from_str(s: &str) -> Self {
		Self { content: IOChunkContent::new_owned(s.as_bytes().to_vec(), true), utf8_valid: Cell::new(Some(true)) }
	}

	/// Replace the pattern space, reusing an owned buffer when possible.
	pub fn copy_bytes(&mut self, bytes: &[u8], terminated: bool) {
		self.utf8_valid.set(None);
		match &mut self.content {
			IOChunkContent::Owned { content, terminated: old_terminated, .. } => {
				content.clear();
				content.extend_from_slice(bytes);
				*old_terminated = terminated;
			},
			#[cfg(unix)]
			IOChunkContent::SliceInput { .. } => {
				self.content = IOChunkContent::new_owned(bytes.to_vec(), terminated);
			},
		}
	}

	/// Replace the pattern space with raw bytes.
	pub fn set_bytes(&mut self, content: Vec<u8>, terminated: bool) {
		self.utf8_valid.set(None);
		self.content = IOChunkContent::new_owned(content, terminated);
	}

	/// Borrow UTF-8 text only if the original bytes are valid.
	pub fn as_str(&self) -> Option<&str> {
		let bytes = self.as_bytes();
		match self.utf8_valid.get() {
			// SAFETY: the cache is set only after validation (or for known-valid
			// data), and every mutation invalidates it before changing bytes.
			Some(true) => Some(unsafe { str::from_utf8_unchecked(bytes) }),
			Some(false) => None,
			None => {
				let text = str::from_utf8(bytes).ok();
				self.utf8_valid.set(Some(text.is_some()));
				text
			},
		}
	}

	/// Return the raw byte content.
	pub fn as_bytes(&self) -> &[u8] {
		match &self.content {
			#[cfg(unix)]
			IOChunkContent::SliceInput { content, .. } => content,
			IOChunkContent::Owned { content, .. } => content,
		}
	}

	/// Convert a borrowed snapshot line to owned bytes on the first mutation.
	pub fn fields_mut(&mut self) -> (&mut Vec<u8>, &mut bool) {
		#[cfg(unix)]
		if let IOChunkContent::SliceInput { content, full_span } = &self.content {
			self.content = IOChunkContent::new_owned(content.to_vec(), content.len() < full_span.len());
		}
		self.utf8_valid.set(None);
		match &mut self.content {
			IOChunkContent::Owned { content, terminated, .. } => (content, terminated),
			#[cfg(unix)]
			_ => unreachable!("pattern space is owned after conversion"),
		}
	}
}

/// Data to be written to a file. It can come from an in-memory input
/// snapshot, in which case it is tracked to allow coalescing
/// and bypassing BufWriter, or it can be other data from the process's
/// memory space.
#[derive(Debug, PartialEq, Eq)]
enum IOChunkContent<'a> {
	#[cfg(unix)]
	SliceInput {
		content:   &'a [u8], // Record without its separator
		full_span: &'a [u8], // Record with its original separator, if any
	},
	Owned {
		content:    Vec<u8>, // Record without its separator
		terminated: bool,
		#[cfg(not(unix))]
		_phantom:    PhantomData<&'a ()>, // Silence E0392 warning
	},
}

impl IOChunkContent<'_> {
	/// Construct a new Owned chunk.
	pub fn new_owned(content: Vec<u8>, terminated: bool) -> Self {
		#[cfg(unix)]
		return IOChunkContent::Owned { content, terminated };

		#[cfg(not(unix))]
		return IOChunkContent::Owned {
			content,
			terminated,
			// Avoid E0063 missing _phantom initialization errors
			_phantom: std::marker::PhantomData,
		};
	}

	/// Return the content's length in bytes.
	pub fn len(&self) -> usize {
		match self {
			#[cfg(unix)]
			IOChunkContent::SliceInput { content, .. } => content.len(),

			IOChunkContent::Owned { content, .. } => content.len(),
		}
	}
}

// upstream's FastCopy (raw-fd metadata
// driving write(2)/copy_file_range(2) output fast paths) is removed, because
// the output writer is a plain `Write` handle without a file descriptor.

/// Unified reader: regular host files are read whole into memory and served
/// zero-copy; everything else streams through a buffered reader.
pub enum LineReader<'a> {
	#[cfg(unix)]
	SliceInput {
		_data:  Vec<u8>, // Owns the bytes `cursor` borrows
		cursor: SliceLineCursor<'a>,
	},
	ReadInput(ReadLineCursor),
	#[cfg(not(unix))]
	_Phantom(std::marker::PhantomData<&'a ()>),
}

/// Stream an open input using the specified record separator.
fn line_reader_read_input(file: impl Read + 'static, separator: u8, unbuffered: bool) -> LineReader<'static> {
	LineReader::ReadInput(ReadLineCursor::new(file, separator, unbuffered))
}

/// Return a LineReader that serves all of `file`, read into memory up front.
#[cfg(unix)]
fn line_reader_slice_input(mut file: impl Read, separator: u8) -> io::Result<LineReader<'static>> {
	let mut data = Vec::new();
	file.read_to_end(&mut data)?;
	// SAFETY: the heap buffer of `data` is never mutated or reallocated, and it
	// lives in the same variant as the cursor borrowing it.
	let slice: &'static [u8] = unsafe { std::slice::from_raw_parts(data.as_ptr(), data.len()) };
	Ok(LineReader::SliceInput { _data: data, cursor: SliceLineCursor::new(slice, separator) })
}

impl<'a> LineReader<'a> {
	/// Open the specified file for line input.
	// Use "-" to read from the standard input.
	pub fn open_with_host(path: &PathBuf, host: &Host, separator: u8, unbuffered: bool) -> io::Result<Self> {
		if path.as_os_str() == "-" {
			return Ok(line_reader_read_input(host.stdin.file().clone(), separator, unbuffered));
		}

		// input file operands resolve
		// against the shell working directory.
		let file = host.fs().open(host.resolve(path))?;
		if file.metadata().is_ok_and(|meta| meta.is_dir()) {
			return Err(io::Error::new(io::ErrorKind::IsADirectory, "Is a directory"));
		}

		// Regular host files are read whole, never memory-mapped: sed runs in
		// the host process, where truncating a mapped file under it raises
		// SIGBUS and kills the host. Provider files and non-regular host files
		// (pipes, process substitution) stream.
		#[cfg(unix)]
		if !unbuffered && file.native().is_some() && file.metadata().is_ok_and(|meta| meta.is_file()) {
			return line_reader_slice_input(file, separator);
		}

		Ok(line_reader_read_input(file, separator, unbuffered))
	}

	/// Opens a file directly for unit tests.
	#[cfg(test)]
	pub fn open(path: &PathBuf) -> io::Result<Self> {
		let (host, _) = Host::for_test("sed", "", ".");
		Self::open_with_host(path, &host, b'\n', false)
	}

	/// Open the specified file to read as a stream.
	#[cfg(test)]
	pub fn open_stream(path: &PathBuf) -> io::Result<Self> {
		let file = std::fs::File::open(path)?;
		Ok(line_reader_read_input(file, b'\n', false))
	}

	/// Return the next line, if available.
	pub fn get_line(&mut self) -> io::Result<Option<IOChunk<'a>>> {
		match self {
			#[cfg(unix)]
			LineReader::SliceInput { cursor, .. } => {
				if let Some(NextSliceLine { content, full_span }) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::SliceInput { content, full_span });

					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			LineReader::ReadInput(cursor) => {
				if let Some((line, terminated)) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::new_owned(line, terminated));
					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			#[cfg(not(unix))]
			LineReader::_Phantom(_) => unreachable!("_Phantom should never be constructed"),
		}
	}

	/// Return the number of unread bytes fetched by a streaming input.
	pub fn unread_bytes(&self) -> usize {
		match self {
			Self::ReadInput(cursor) => cursor.reader.buffer().len(),
			_ => 0,
		}
	}

	/// Recover the last owned pattern as the buffer for the next input line.
	pub fn recycle(&mut self, chunk: IOChunk<'a>) {
		if let Self::ReadInput(cursor) = self {
			match chunk.content {
				IOChunkContent::Owned { content, .. } => cursor.buffer = content,
				#[cfg(unix)]
				IOChunkContent::SliceInput { .. } => unreachable!("streaming chunks are always owned"),
			}
		}
	}

	/// Return true if the previously returned line was the last one.
	pub fn last_line(&mut self) -> io::Result<bool> {
		match self {
			#[cfg(unix)]
			LineReader::SliceInput { cursor, .. } => cursor.last_line(),

			LineReader::ReadInput(cursor) => cursor.last_line(),

			#[cfg(not(unix))]
			LineReader::_Phantom(_) => unreachable!("_Phantom should never be constructed"),
		}
	}
}

// output goes to plain `Write` handles
// (the context stdout has no raw fd), so upstream's `Write + AsRawFd` bound
// is reduced to `Write` on every platform.
pub trait OutputWrite: Write {}
impl<T: Write> OutputWrite for T {}

/// A pending output span of contiguous lines from an input snapshot.
#[cfg(unix)]
#[derive(Clone)]
struct SliceOutput {
	out_ptr: *const u8, // Start of the output data chunk
	len:     usize,     // Output data chunk size
}

/// Abstraction for outputting data, potentially from an input snapshot.
/// Adjacent snapshot lines are coalesced and written with a single
/// write of the original bytes.
/// All other output is buffered and writen via BufWriter.
pub struct OutputBuffer {
	out:               BufWriter<Box<dyn OutputWrite + 'static>>, // Where to write
	line_buffered:     bool, // Flush completed lines for non-file stdout
	#[cfg(unix)]
	max_pending_write: usize,                        /* Max bytes to keep before
	                                                               * flushing */
	#[cfg(unix)]
	slice_chunk:       Option<SliceOutput>, // Chunk to write
	separator:         u8,
	// Defer a missing terminator until the next output record.
	pending_separator: bool,
	#[cfg(test)]
	low_level_flushes: usize, // Number of system call flushes
}

/// Threshold above which a coalesced snapshot flush counts as a low-level flush
/// in tests (formerly the direct-write threshold of the removed fd path).
#[cfg(all(unix, test))]
const MIN_DIRECT_WRITE: usize = 4 * 1024;

/// Maximum size of a pending write buffer for non-files (likely pipes)
// Once more than the specified bytes accumulate, issue a write.
// This is set to the common size of Linux pipe buffer to maximize
// throughput and liveness across the pipeline.
#[cfg(unix)]
const MAX_PENDING_WRITE_NON_FILE: usize = 64 * 1024;

impl OutputBuffer {
	/// Create buffered output with the invocation's record separator.
	pub fn new(w: Box<dyn OutputWrite + 'static>, line_buffered: bool, separator: u8) -> Self {
		Self {
			out: BufWriter::new(w),
			line_buffered,
			#[cfg(unix)]
			max_pending_write: if line_buffered { MAX_PENDING_WRITE_NON_FILE } else { usize::MAX },
			#[cfg(unix)]
			slice_chunk: None,
			separator,
			pending_separator: false,
			#[cfg(test)]
			low_level_flushes: 0,
		}
	}

	#[cfg(test)]
	/// Schedule script text for output.
	pub fn write_str(&mut self, s: impl AsRef<str>) -> io::Result<()> {
		self.write_bytes(s.as_ref().as_bytes())
	}

	/// Schedule bytes for output without converting or taking ownership of them.
	pub fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
		if let Some(content) = bytes.strip_suffix(&[self.separator]) {
			self.write_owned_content(content, true)
		} else {
			self.write_owned_content(bytes, false)
		}
	}

	/// Write the parsed text of `i` or `c`, replacing its final script newline.
	pub(super) fn write_script_text(&mut self, text: &str) -> io::Result<()> {
		match text.strip_suffix('\n') {
			Some(content) => self.write_owned_content(content.as_bytes(), true),
			None => self.write_owned_content(text.as_bytes(), false),
		}
	}

	/// Write the current input record number and the output separator.
	pub(super) fn write_line_number(&mut self, number: usize) -> io::Result<()> {
		#[cfg(unix)]
		self.flush_slice(WriteRange::Complete)?;
		self.flush_pending_separator()?;
		write!(self.out, "{number}")?;
		self.out.write_all(&[self.separator])?;
		self.flush_completed_line()
	}

	/// Write record content, preserving whether it originally had a terminator.
	pub(super) fn write_owned_content(&mut self, content: &[u8], terminated: bool) -> io::Result<()> {
		if content.is_empty() && !terminated {
			return Ok(());
		}
		#[cfg(unix)]
		self.flush_slice(WriteRange::Complete)?;
		if self.pending_separator {
			self.out.write_all(&[self.separator])?;
			self.flush_completed_line()?;
		}
		self.out.write_all(content)?;
		if terminated {
			self.out.write_all(&[self.separator])?;
			self.flush_completed_line()?;
		}
		self.pending_separator = !terminated;
		Ok(())
	}

	/// Copy the file the script calls `name`, opened through `fs` at `path`, to
	/// the output. A file that can't be opened counts as empty (POSIX); a
	/// directory or a failed read is GNU's fatal `read error`.
	pub fn copy_file(&mut self, fs: &BlockingFs, path: &Path, name: &Path) -> SedResult<()> {
		// Flush snapshot writes, if any.
		#[cfg(unix)]
		{
			self.flush_slice(WriteRange::Complete)?;
		}

		let mut file = match fs.open(path) {
			Ok(file) if file.metadata().is_ok_and(|meta| meta.is_dir()) => {
				return Err(read_error(name, &io::Error::new(io::ErrorKind::IsADirectory, "Is a directory")));
			},
			Ok(file) => file,
			Err(e) if e.kind() == io::ErrorKind::IsADirectory => return Err(read_error(name, &e)),
			Err(_) => return Ok(()),
		};

		self.flush_pending_separator()?;
		let mut buf = [0; 8 * 1024];
		loop {
			let len = match file.read(&mut buf) {
				Ok(0) => break,
				Ok(len) => len,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(e) => return Err(read_error(name, &e)),
			};
			self.out.write_all(&buf[..len])?;
			if self.line_buffered && (buf[..len].contains(&self.separator) || buf[..len].contains(&b'\n')) {
				self.flush_completed_line()?;
			}
		}
		Ok(())
	}

	/// Write raw output without adding or deferring a separator for it.
	pub fn write_raw(&mut self, bytes: &[u8]) -> io::Result<()> {
		if bytes.is_empty() {
			return Ok(());
		}
		self.flush_pending_separator()?;
		#[cfg(unix)]
		self.flush_slice(WriteRange::Complete)?;
		self.out.write_all(bytes)?;
		if bytes.contains(&self.separator) || bytes.contains(&b'\n') {
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush output through a completed line when writing to a non-file stdout.
	fn flush_completed_line(&mut self) -> io::Result<()> {
		if self.line_buffered {
			#[cfg(test)]
			{
				self.low_level_flushes += 1;
			}
			self.out.flush()?;
		}
		Ok(())
	}
}

/// Implementation of the std::io::Write trait
impl Write for OutputBuffer {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.write_bytes(buf)?;
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		self.flush()
	}
}

#[cfg(unix)]
#[derive(Debug, PartialEq)]
enum WriteRange {
	Complete, // Write all specified data.
	Blocks,   // Finish write on a block boundary (to help alignment).
	None,     // No writing is needed.
}

#[cfg(unix)]
impl OutputBuffer {
	/// Schedule the specified output chunk for eventual output
	pub fn write_chunk(&mut self, new_chunk: &IOChunk) -> io::Result<()> {
		if let IOChunkContent::Owned { content, terminated, .. } = &new_chunk.content {
			return self.write_owned_content(content, *terminated);
		}
		if new_chunk.is_empty() && !new_chunk.is_terminated() {
			return Ok(());
		}

		if self.pending_separator {
			self.flush_slice(WriteRange::Complete)?;
			self.out.write_all(&[self.separator])?;
			self.pending_separator = false;
			self.flush_completed_line()?;
		}

		match &new_chunk.content {
			IOChunkContent::SliceInput { full_span, .. } => {
				let new_ptr = full_span.as_ptr();
				let new_len = full_span.len();

				// Set whether a flush is needed and whether the
				// slice_chunk needs to be reset to the new input.
				// This avoids calling slice_chunk (which borrows self)
				// when old_chunk is already borrowed.
				let (flush_action, reset) = if let Some(old_chunk) = self.slice_chunk.as_mut() {
					// Coalesce if adjacent.
					if unsafe { old_chunk.out_ptr.add(old_chunk.len) } == new_ptr {
						// Coalesce.
						old_chunk.len += new_len;
						if old_chunk.len > self.max_pending_write {
							// Too much data; flush some full blocks.
							(WriteRange::Blocks, false)
						} else {
							(WriteRange::None, false)
						}
					} else {
						// Not contiguous
						(WriteRange::Complete, true)
					}
				} else {
					// No chunk yet; start a new one.
					(WriteRange::None, true)
				};

				if flush_action != WriteRange::None {
					self.flush_slice(flush_action)?;
				}
				if reset {
					self.slice_chunk = Some(SliceOutput { out_ptr: new_ptr, len: new_len });
				}
				self.pending_separator = !new_chunk.is_terminated();
			},

			IOChunkContent::Owned { .. } => unreachable!("owned content handled above"),
		}

		if self.line_buffered && new_chunk.is_terminated() {
			// Snapshot output reaches the BufWriter only here; file-backed
			// output is block-buffered, so this cannot affect its fast path.
			self.flush_slice(WriteRange::Complete)?;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush any pending snapshot data.
	// the raw-fd write(2) and
	// copy_file_range(2) fast paths are removed; the coalesced snapshot span is
	// written through the buffered writer. `cover` block alignment is thus
	// irrelevant and every flush writes the complete pending span.
	#[cfg(unix)]
	fn flush_slice(&mut self, _cover: WriteRange) -> io::Result<()> {
		if let Some(chunk) = self.slice_chunk.take() {
			#[cfg(test)]
			if chunk.len >= MIN_DIRECT_WRITE {
				self.low_level_flushes += 1;
			}
			let slice = unsafe { std::slice::from_raw_parts(chunk.out_ptr, chunk.len) };
			self.out.write_all(slice)?;
		}
		Ok(())
	}

	/// Write a deferred newline if the last output didn't end with one.
	pub fn flush_pending_separator(&mut self) -> io::Result<()> {
		if self.pending_separator {
			self.flush_slice(WriteRange::Complete)?;
			self.out.write_all(&[self.separator])?;
			self.pending_separator = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush everything: pending snapshot and buffered data.
	pub fn flush(&mut self) -> io::Result<()> {
		self.flush_slice(WriteRange::Complete)?; // flush snapshot if any
		self.out.flush() // then flush buffered data
	}
}

#[cfg(not(unix))]
impl OutputBuffer {
	/// Schedule the specified output chunk for eventual output
	pub fn write_chunk(&mut self, chunk: &IOChunk) -> io::Result<()> {
		self.write_owned_content(chunk.as_bytes(), chunk.is_terminated())
	}

	/// Write a deferred newline if the last output didn't end with one.
	pub fn flush_pending_separator(&mut self) -> io::Result<()> {
		if self.pending_separator {
			self.out.write_all(&[self.separator])?;
			self.pending_separator = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush everything: pending snapshot and buffered data.
	pub fn flush(&mut self) -> io::Result<()> {
		self.out.flush() // then flush buffered data
	}
}

#[cfg(test)]
mod tests {
	use std::fs::File;
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	use std::io::{self, Write};
	use std::{
		fs,
		io::{Seek, SeekFrom},
	};

	use tempfile::{NamedTempFile, tempfile};

	use super::*;

	/// Helper: produce a 4k-byte Vec of `'.'`s ending in `'\n'`.
	#[cfg(unix)]
	fn make_dot_line_4k() -> Vec<u8> {
		let mut buf = Vec::with_capacity(4096);
		buf.extend(std::iter::repeat_n(b'.', 4095));
		buf.push(b'\n');
		buf
	}

	#[cfg(unix)]
	pub fn new_content_slice_input<'a>(content: &'a [u8], full_span: &'a [u8]) -> IOChunkContent<'a> {
		IOChunkContent::SliceInput { content, full_span }
	}

	#[test]
	fn test_owned_line_output() -> io::Result<()> {
		let tmp = NamedTempFile::new()?;
		{
			let file = tmp.reopen()?;
			let mut out = OutputBuffer::new(Box::new(file), false, b'\n');
			out.write_str("foo\n")?;
			out.write_str("bar\n")?;
			out.flush()?;
			assert_eq!(out.low_level_flushes, 0);
		} // File closes here as it leaves the scope

		let contents = fs::read(tmp.path())?;
		assert_eq!(contents.as_slice(), b"foo\nbar\n");
		Ok(())
	}

	#[test]
	#[cfg(unix)]
	fn test_slice_line_output_single() -> io::Result<()> {
		use std::{fs, io::Write};

		use tempfile::NamedTempFile;

		// Prepare the input buffer: two lines in one contiguous snapshot
		let slice_data = b"line one\nline two\n";

		// Write that into a temp file
		let mut input = NamedTempFile::new()?;
		input.write_all(slice_data)?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open the reader on that file
		let mut reader = LineReader::open(&input_path)?;

		// Prepare an output temp file and wrap it in our OutputBuffer
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = std::fs::File::create(&output_path)?;
		let mut out = OutputBuffer::new(Box::new(Box::new(out_file)), false, b'\n');

		// Drain reader → writer
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
		}
		out.flush()?;

		assert_eq!(out.low_level_flushes, 0);

		let written = fs::read(&output_path)?;
		assert_eq!(written.as_slice(), slice_data);

		Ok(())
	}

	#[test]
	#[cfg(unix)]
	fn test_mixed_output_order_preserved() -> io::Result<()> {
		use std::{fs, fs::File, io::Write};

		use tempfile::NamedTempFile;

		// Prepare an input file containing two lines: "zero\none\n"
		let data = b"zero\none\n";
		let mut input = NamedTempFile::new()?;
		input.write_all(data)?;
		input.flush()?;
		let input_path = input.path().to_path_buf();
		let mut reader = LineReader::open(&input_path)?;

		// Prepare an empty output file
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = File::create(&output_path)?;
		let mut out = OutputBuffer::new(Box::new(out_file), false, b'\n');

		// Read the first snapshot line ("zero\n") and write it
		if let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
		}

		// Write an owned line ("middle\n")
		out.write_str("middle\n")?;

		// Read the second snapshot line ("one\n") and write it
		if let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
		}

		out.flush()?;

		// Since all writes are small (<4K), we expect zero zero copy syscalls
		assert_eq!(out.low_level_flushes, 0);

		// Read both files back and compare
		let expected = {
			let mut v = Vec::new();
			v.extend_from_slice(b"zero\n");
			v.extend_from_slice(b"middle\n");
			v.extend_from_slice(b"one\n");
			v
		};
		let actual = fs::read(&output_path)?;
		assert_eq!(actual, expected);

		Ok(())
	}

	#[test]
	#[cfg(unix)]
	fn test_large_file_zero_copy() -> io::Result<()> {
		// Create and fill the input temp file:
		let mut input = NamedTempFile::new()?;
		write!(input, "first line\nsecond line\n")?;
		let dot_line = make_dot_line_4k();
		input.write_all(&dot_line)?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open reader on input file:
		let mut reader = LineReader::open(&input_path)?;

		// Create the output temp file (empty):
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = File::create(&output_path)?;

		// Wrap it in your OutputBuffer and run the loop:
		let mut out = OutputBuffer::new(Box::new(out_file), false, b'\n');
		let mut nline = 0;
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
			nline += 1;
		}
		assert_eq!(nline, 3);

		out.flush()?;
		assert_eq!(out.low_level_flushes, 1);

		// Verify that files match:
		let expected = fs::read(&input_path)?;
		let actual = fs::read(&output_path)?;
		assert_eq!(actual, expected);
		Ok(())
	}

	#[test]
	#[cfg(unix)]
	fn test_large_file_zero_copy_unterminated() -> io::Result<()> {
		// Create and fill the input temp file:
		let mut input = NamedTempFile::new()?;
		write!(input, "first line\nsecond line\n")?;
		let dot_line = make_dot_line_4k();
		input.write_all(&dot_line)?;
		write!(input, "last line (unterminated)")?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open reader on input file:
		let mut reader = LineReader::open(&input_path)?;

		// Create the output temp file (empty):
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = File::create(&output_path)?;

		// Wrap it in your OutputBuffer and run the loop:
		let mut out = OutputBuffer::new(Box::new(out_file), false, b'\n');
		let mut nline = 0;
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
			nline += 1;
		}
		assert_eq!(nline, 4);

		out.flush()?;
		assert_eq!(out.low_level_flushes, 1);

		// Verify that files match:
		let expected = fs::read(&input_path)?;
		let actual = fs::read(&output_path)?;
		assert_eq!(actual, expected);
		Ok(())
	}

	#[test]
	fn test_small_file_unterminated() -> io::Result<()> {
		// Create and fill the input temp file:
		let mut input = NamedTempFile::new()?;
		write!(input, "first line\nsecond line\nlast line (unterminated)")?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open reader on input file:
		let mut reader = LineReader::open(&input_path)?;

		// Create the output temp file (empty):
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = File::create(&output_path)?;

		// Wrap it in your OutputBuffer and run the loop:
		let mut out = OutputBuffer::new(Box::new(out_file), false, b'\n');
		let mut nline = 0;
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
			nline += 1;
		}
		assert_eq!(nline, 3);

		out.flush()?;
		assert_eq!(out.low_level_flushes, 0);

		// Verify that files match:
		let expected = fs::read(&input_path)?;
		let actual = fs::read(&output_path)?;
		assert_eq!(actual, expected);
		Ok(())
	}

	#[test]
	fn test_small_file_unterminated_stream() -> io::Result<()> {
		// Create and fill the input temp file:
		let mut input = NamedTempFile::new()?;
		write!(input, "first line\nsecond line\nlast line (unterminated)")?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open reader on input file:
		let mut reader = LineReader::open_stream(&input_path)?;

		// Create the output temp file (empty):
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = File::create(&output_path)?;

		// Wrap it in your OutputBuffer and run the loop:
		let mut out = OutputBuffer::new(Box::new(out_file), false, b'\n');
		let mut nline = 0;
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
			nline += 1;
		}
		assert_eq!(nline, 3);

		out.flush()?;
		assert_eq!(out.low_level_flushes, 0);

		// Verify that files match:
		let expected = fs::read(&input_path)?;
		let actual = fs::read(&output_path)?;
		assert_eq!(actual, expected);
		Ok(())
	}

	#[test]
	fn test_stream_read() -> std::io::Result<()> {
		// Create temporary file with known contents
		let mut tmp = NamedTempFile::new()?;
		write!(tmp, "first line\nsecond line\nlast line\n")?;
		tmp.flush()?;

		let path = tmp.path().to_path_buf();
		let mut reader = LineReader::open_stream(&path)?;

		// Verify the reader's operation
		if let Some(IOChunk {
			content: IOChunkContent::Owned { content, terminated, .. },
			utf8_valid,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, b"first line");
			assert_eq!(content.len(), 10);
			assert!(terminated);
			assert_eq!(utf8_valid.get(), None);
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::Owned");
		}

		if let Some(IOChunk { content: IOChunkContent::Owned { content, terminated, .. }, .. }) =
			reader.get_line()?
		{
			assert_eq!(content, b"second line");
			assert!(terminated);
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::Owned");
		}

		if let Some(content) = reader.get_line()? {
			assert_eq!(content.as_str().unwrap(), "last line");
			assert!(reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunk");
		}

		assert_eq!(reader.get_line()?, None);

		Ok(())
	}

	#[test]
	#[cfg(unix)]
	fn test_slice_read() -> std::io::Result<()> {
		// Create temporary file with known contents
		let mut tmp = NamedTempFile::new()?;
		write!(tmp, "first line\nsecond line\nlast line\n")?;
		tmp.flush()?;

		let path = tmp.path().to_path_buf();
		let mut reader = LineReader::open(&path)?;

		// Verify the reader's operation
		if let Some(IOChunk {
			content: IOChunkContent::SliceInput { content, full_span, .. },
			utf8_valid,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, b"first line");
			assert_eq!(content.len(), 10);
			assert_eq!(full_span, b"first line\n");
			assert_eq!(utf8_valid.get(), None);
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::SliceInput");
		}

		if let Some(IOChunk {
			content: IOChunkContent::SliceInput { content, full_span, .. },
			utf8_valid,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, b"second line");
			assert_eq!(full_span, b"second line\n");
			assert_eq!(utf8_valid.get(), None);
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::SliceInput");
		}

		if let Some(content) = reader.get_line()? {
			assert_eq!(content.as_bytes(), b"last line");
			assert_eq!(content.as_str().unwrap(), "last line");
			assert_eq!(content.utf8_valid.get(), Some(true));
			assert!(reader.last_line().unwrap());
			// Cached version
			assert_eq!(content.as_str().unwrap(), "last line");
		} else {
			panic!("Expected IOChunk");
		}

		assert_eq!(reader.get_line()?, None);

		Ok(())
	}

	/// Truncating an input file after sed opened it must not fault the host
	/// process; the reader keeps serving the bytes captured at open. Unix only:
	/// the snapshot is the `SliceInput` path; Windows always streams.
	#[test]
	#[cfg(unix)]
	fn test_file_truncated_after_open() -> io::Result<()> {
		let mut tmp = NamedTempFile::new()?;
		for _ in 0..4 {
			tmp.write_all(&[b'.'; 4095])?;
			tmp.write_all(b"\n")?;
		}
		tmp.flush()?;
		let mut reader = LineReader::open(&tmp.path().to_path_buf())?;
		tmp.as_file().set_len(0)?;

		let mut lines = 0;
		while let Some(chunk) = reader.get_line()? {
			assert_eq!(chunk.as_bytes(), [b'.'; 4095]);
			lines += 1;
		}
		assert_eq!(lines, 4);
		Ok(())
	}

	// is_terminated, is_empty
	#[test]
	fn test_owned_newline_terminated_non_empty() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned(b"line".to_vec(), true));
		assert!(chunk.is_terminated());
		assert!(!chunk.is_empty());
	}

	#[test]
	fn test_owned_newline_terminated_empty() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned(Vec::new(), true));
		assert!(chunk.is_terminated());
		assert!(chunk.is_empty());
	}

	#[test]
	fn test_owned_not_newline_terminated() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned(b"line".to_vec(), false));
		assert!(!chunk.is_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_slice_newline_terminated() {
		let content = b"line";
		let full_span = b"line\n";
		let chunk = IOChunk::from_content(new_content_slice_input(content, full_span));
		assert!(chunk.is_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_slice_not_newline_terminated() {
		let content = b"line";
		let full_span = b"line";
		let chunk = IOChunk::from_content(new_content_slice_input(content, full_span));
		assert!(!chunk.is_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_slice_empty() {
		let content = b"";
		let full_span = b"";
		let chunk = IOChunk::from_content(new_content_slice_input(content, full_span));
		assert!(!chunk.is_terminated());
	}

	// fields_mut
	#[test]
	fn test_fields_mut_on_owned() {
		let mut chunk = IOChunk::from_content(IOChunkContent::new_owned(b"hello".to_vec(), false));

		let (s, _) = chunk.fields_mut();
		s.extend_from_slice(b" world");

		assert_eq!(chunk.as_str().unwrap(), "hello world");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_on_slice_input_valid_utf8() {
		let content = b"foo";
		let full_span = b"foo\n";
		let mut chunk = IOChunk::from_content(new_content_slice_input(content, full_span));

		{
			let (s, _) = chunk.fields_mut();
			s.extend_from_slice(b"bar");
		}

		assert_eq!(chunk.as_str().unwrap(), "foobar");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_on_utf8_multibyte() {
		let content = "Ζωντανά!".as_bytes();
		let full_span = "Ζωντανά!\n".as_bytes();
		let mut chunk = IOChunk::from_content(new_content_slice_input(content, full_span));

		let (s, _) = chunk.fields_mut();
		s.extend_from_slice(" Δεδομένα".as_bytes());

		assert_eq!(chunk.as_str().unwrap(), "Ζωντανά! Δεδομένα");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_invalid_utf8() {
		let content = b"abc\xFF"; // invalid UTF-8
		let full_span = b"abc\xFF\n";
		let mut chunk = IOChunk::from_content(new_content_slice_input(content, full_span));

		assert_eq!(chunk.as_str(), None);
		assert_eq!(chunk.as_str(), None);
		chunk.fields_mut().0.extend_from_slice(b"def");
		assert_eq!(chunk.as_bytes(), b"abc\xffdef");
	}

	///////////////////////////////
	// Unit tests for write_chunk()
	///////////////////////////////

	fn new_for_test() -> (OutputBuffer, std::fs::File) {
		let file = tempfile().unwrap();
		let buf = OutputBuffer {
			out: BufWriter::new(Box::new(file.try_clone().unwrap())),
			line_buffered: false,
			#[cfg(unix)]
			max_pending_write: 8,
			#[cfg(unix)]
			slice_chunk: None,
			separator: b'\n',
			pending_separator: false,
			low_level_flushes: 0,
		};
		(buf, file)
	}

	#[cfg(unix)]
	fn make_slice_chunk(bytes: &'static [u8]) -> IOChunk<'static> {
		let content = bytes.strip_suffix(b"\n").unwrap_or(bytes);
		IOChunk::from_content(IOChunkContent::SliceInput { content, full_span: bytes })
	}

	fn make_owned_chunk(s: &str, has_nl: bool) -> IOChunk<'_> {
		IOChunk {
			utf8_valid: Cell::new(Some(true)),
			content:       IOChunkContent::Owned {
				content:                    s.as_bytes().to_vec(),
				terminated:                has_nl,
				#[cfg(not(unix))]
				_phantom:                   std::marker::PhantomData,
			},
		}
	}

	#[cfg(unix)]
	#[test]
	fn slice_new_chunk_single() {
		let (mut outbuf, _file) = new_for_test(); // OutputBuffer

		let c1 = make_slice_chunk(b"abc");

		outbuf.write_chunk(&c1).unwrap();

		assert_eq!(outbuf.slice_chunk.as_ref().unwrap().len, 3);
	}

	#[cfg(unix)]
	#[test]
	fn slice_new_chunk_and_coalesce() {
		let (mut outbuf, _file) = new_for_test(); // OutputBuffer

		let backing = b"abc\nefg\n"; // contiguous buffer, newline-terminated lines
		let c1 = make_slice_chunk(&backing[0..4]); // "abc\n"
		let c2 = make_slice_chunk(&backing[4..8]); // "efg\n"

		outbuf.write_chunk(&c1).unwrap();
		outbuf.write_chunk(&c2).unwrap();

		assert_eq!(outbuf.slice_chunk.as_ref().unwrap().len, 8);
	}

	#[test]
	#[cfg(unix)]
	fn slice_not_contiguous_triggers_flush() {
		let (mut buf, _file) = new_for_test();
		let backing = b"abcdefghi";
		let c1 = make_slice_chunk(&backing[0..4]); // "abcd"
		// Guaranteed non-coalescable.  Surprisingly, on macOS
		// passing two strings resulted in coalescible data.
		let c2 = make_slice_chunk(&backing[5..9]); // "fghi"

		buf.write_chunk(&c1).unwrap();
		assert_eq!(buf.slice_chunk.as_ref().unwrap().len, 4);
		buf.write_chunk(&c2).unwrap();
		// No coalescing
		assert_eq!(buf.slice_chunk.as_ref().unwrap().len, 4);
	}

	#[test]
	#[cfg(unix)]
	fn slice_coalesce_and_flush_blocks() {
		let (mut buf, _file) = new_for_test();
		buf.max_pending_write = 4;
		let backing = b"abcde\nfgh\n"; // contiguous newline-terminated lines
		let c1 = make_slice_chunk(&backing[0..6]); // "abcde\n"
		let c2 = make_slice_chunk(&backing[6..10]); // "fgh\n"

		buf.write_chunk(&c1).unwrap();
		buf.write_chunk(&c2).unwrap();
		// Exceeding max_pending_write flushes and clears the saved snapshot span.
		assert!(buf.slice_chunk.is_none());
	}

	#[test]
	fn owned_without_newline() {
		let (mut buf, mut file) = new_for_test();
		let chunk = make_owned_chunk("hello", false);
		buf.write_chunk(&chunk).unwrap();

		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();

		assert_eq!(out, "hello");
	}

	#[test]
	fn owned_with_newline() {
		let (mut buf, mut file) = new_for_test();
		let chunk = make_owned_chunk("world", true);
		buf.write_chunk(&chunk).unwrap();

		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();

		assert_eq!(out, "world\n");
	}

	// pending_separator is injected between two no-newline chunks
	#[test]
	fn pending_newline_injected_between_chunks() {
		let (mut buf, mut file) = new_for_test();
		buf.write_chunk(&make_owned_chunk("first", false)).unwrap();
		buf.write_chunk(&make_owned_chunk("second", true)).unwrap();
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "first\nsecond\n");
	}

	// flush_pending_separator emits the deferred newline
	#[test]
	fn flush_pending_newline_emits_newline() {
		let (mut buf, mut file) = new_for_test();
		buf.write_chunk(&make_owned_chunk("foo", false)).unwrap();
		assert!(buf.pending_separator);
		buf.flush_pending_separator().unwrap();
		assert!(!buf.pending_separator);
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "foo\n");
	}

	// write_str strips trailing newline and sets pending_separator correctly
	#[test]
	fn write_str_with_trailing_newline() {
		let (mut buf, mut file) = new_for_test();
		buf.write_str("bar\n").unwrap();
		assert!(!buf.pending_separator);
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "bar\n");
	}

	#[test]
	fn write_str_without_trailing_newline() {
		let (mut buf, mut file) = new_for_test();
		buf.write_str("baz").unwrap();
		assert!(buf.pending_separator);
		buf.flush_pending_separator().unwrap();
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "baz\n");
	}
}
}
pub mod fast_regex {
// Literal, Unicode and raw-byte regular expression matching.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{borrow::Cow, cell::OnceCell, error::Error, ops::ControlFlow};

use fancy_regex::{Captures as FancyCaptures, Regex as FancyRegex};
use memchr::memmem;
use onig::{EncodedBytes, MatchParam, RegexOptions, Region, SearchOptions, Syntax};
use regex::{Captures as UnicodeCaptures, Regex as RustRegex};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::fast_io::IOChunk;

/// Detects `\1` through `\9`, conservatively including escaped backslashes.
fn needs_backreferences(pattern: &str) -> bool {
	let bytes = pattern.as_bytes();
	memchr::memchr_iter(b'\\', bytes).any(|at| matches!(bytes.get(at + 1), Some(b'1'..=b'9')))
}

/// Detects metacharacters and escapes that require more than literal matching.
fn needs_regex(pattern: &str) -> bool {
	let bytes = pattern.as_bytes();
	bytes.iter().enumerate().any(|(at, &b)| {
		let special = match b {
			b'.' | b'?' | b'|' | b'+' | b'(' | b'[' | b'{' | b'*' => true,
			b'\\' => matches!(
				bytes.get(at + 1),
				Some(b'W' | b'w' | b'D' | b'd' | b'S' | b's' | b'P' | b'p' | b'A' | b'z' | b'B' | b'b' | b'0'..=b'9')
			),
			_ => false,
		};
		if !special || at == 0 {
			return special;
		}
		// The preceding escape may consume a backslash, but not a newline.
		match bytes[at - 1] {
			b'\\' => at >= 2 && bytes[at - 2] == b'\\',
			b'\n' => at < 2 || bytes[at - 2] != b'\\',
			_ => true,
		}
	})
}

#[derive(Clone, Debug)]
/// Types of literal string anchored matches
enum AnchoredMatch {
	Begin, // ^...
	End,   // ...$
	Both,  // ^...$
	Free,  // ...
}

#[derive(Clone, Debug)]
/// A fast Regex-like matcher for literal strings using memchr:memmem
pub struct LiteralMatcher {
	needle:     Vec<u8>,       // Bytes without any anchors
	match_type: AnchoredMatch, // Type of anchoring specified
}

impl LiteralMatcher {
	/// Construct a new matcher based on a needle possible with anchors.
	pub fn new(needle: &str) -> Self {
		let needle_bytes = needle.as_bytes();
		if needle_bytes[0] == b'^' && needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::Both,
				needle:     needle_bytes[1..needle_bytes.len() - 1].to_vec(),
			}
		} else if needle_bytes[0] == b'^' {
			LiteralMatcher {
				match_type: AnchoredMatch::Begin,
				needle:     needle_bytes[1..needle_bytes.len()].to_vec(),
			}
		} else if needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::End,
				needle:     needle_bytes[0..needle_bytes.len() - 1].to_vec(),
			}
		} else {
			LiteralMatcher { match_type: AnchoredMatch::Free, needle: needle_bytes.to_vec() }
		}
	}

	/// Returns the start index of a match, if any
	fn anchored_find(&self, haystack: &[u8]) -> Option<usize> {
		let nlen = self.needle.len();
		let hlen = haystack.len();

		match self.match_type {
			AnchoredMatch::Both => {
				if hlen == nlen && haystack == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::Begin => {
				if hlen >= nlen && &haystack[..nlen] == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::End => {
				if hlen >= nlen && &haystack[hlen - nlen..] == self.needle.as_slice() {
					Some(hlen - nlen)
				} else {
					None
				}
			},
			AnchoredMatch::Free => memmem::find(haystack, &self.needle),
		}
	}

	/// Return true if the needle occurs in the haystack.
	pub fn is_match(&self, haystack: &[u8]) -> bool {
		self.anchored_find(haystack).is_some()
	}

	/// Return the position and contents of the matched needle.
	pub fn find<'t>(&self, haystack: &'t [u8]) -> Option<(usize, usize, &'t [u8])> {
		self.anchored_find(haystack).map(|start| {
			let end = start + self.needle.len();
			(start, end, &haystack[start..end])
		})
	}

	/// Return all positions and contents of the matched needle.
	pub fn iter<'t>(&'t self, haystack: &'t [u8]) -> impl Iterator<Item = (usize, usize, &'t [u8])> + 't {
		let free = matches!(self.match_type, AnchoredMatch::Free);
		let anchored = if free { None } else { self.find(haystack) };
		let needle = &self.needle;
		let unanchored = free.then(|| memmem::find_iter(haystack, needle)).into_iter().flatten()
			.map(move |start| {
				let end = start + needle.len();
				(start, end, &haystack[start..end])
			});
		anchored.into_iter().chain(unanchored)
	}
}

/// Return the passed pattern without any backslash escapes.
pub fn remove_escapes(pattern: &str) -> String {
	let mut chars = pattern.chars().peekable();
	let mut result = String::with_capacity(pattern.len());

	while let Some(c) = chars.next() {
		if c == '\\' {
			// Look ahead and consume the next character if present
			if let Some(&next) = chars.peek() {
				result.push(next);
				chars.next(); // consume the peeked char
			}
		} else {
			result.push(c);
		}
	}

	result
}

#[derive(Debug)]
/// Regexes use Unicode character semantics on UTF-8 and C-locale byte
/// semantics on an ill-formed pattern space. Literal matches need no decoding.
pub enum Regex {
	Literal(LiteralMatcher),
	Unicode(RustRegex, RawRegex),
	Fancy(FancyRegex, RawRegex),
}

#[derive(Debug)]
pub struct RawRegex {
	pattern: Box<str>,
	compiled: OnceCell<Result<onig::Regex, onig::Error>>,
}

impl RawRegex {
	fn new(pattern: String) -> Self {
		Self { pattern: pattern.into_boxed_str(), compiled: OnceCell::new() }
	}

	fn compiled(&self) -> SedResult<&onig::Regex> {
		// Oniguruma's single-byte encoding works on arbitrary bytes and, unlike
		// regex::bytes, also supports the backreferences sed accepts in a BRE.
		self.compiled.get_or_init(|| {
			onig::Regex::with_options_and_encoding(
				EncodedBytes::ascii(self.pattern.as_bytes()),
				RegexOptions::REGEX_OPTION_NONE,
				Syntax::perl(),
			)
		}).as_ref().map_err(|e| SedError::new(4, e))
	}
}

fn raw_search(
	re: &onig::Regex,
	text: &[u8],
	at: usize,
	region: Option<&mut Region>,
) -> SedResult<bool> {
	re.search_with_param(
		EncodedBytes::ascii(text),
		at,
		text.len(),
		SearchOptions::SEARCH_OPTION_NONE,
		region,
		MatchParam::default(),
	).map(|m| m.is_some()).map_err(|e| SedError::new(4, e))
}

/// Ensure that a regex matches GNU sed's default semantics for `.`
/// through the appropriate use of the s flag.
pub fn ensure_dotall(pattern: &str) -> String {
	// A leading inline flag group, `(?im)`; not a group such as `(?:a*)?`.
	let flags = pattern
		.strip_prefix("(?")
		.and_then(|rest| rest.find(')').map(|close| (&rest[..close], close + 3)))
		.filter(|(flags, _)| flags.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'));
	let Some((flags, end)) = flags else {
		return format!("(?s){pattern}");
	};

	// Add the s flag unless 's' or its complement 'm' is there.
	if flags.contains('m') || flags.contains('s') {
		pattern.to_owned()
	} else {
		format!("(?{flags}s){}", &pattern[end..])
	}
}

impl Regex {
	/// Construct the most efficient RE-like matching engine possible.
	pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
		if needs_backreferences(pattern) {
			let pattern = ensure_dotall(pattern);
			Ok(Self::Fancy(FancyRegex::new(&pattern)?, RawRegex::new(pattern)))
		} else if needs_regex(pattern) {
			let pattern = ensure_dotall(pattern);
			Ok(Self::Unicode(RustRegex::new(&pattern)?, RawRegex::new(pattern)))
		} else {
			Ok(Self::Literal(LiteralMatcher::new(&remove_escapes(pattern))))
		}
	}

	fn raw_for(&self, chunk: &IOChunk) -> SedResult<Option<&onig::Regex>> {
		match self {
			Self::Unicode(_, raw) | Self::Fancy(_, raw) if chunk.as_str().is_none() => {
				raw.compiled().map(Some)
			},
			_ => Ok(None),
		}
	}

	/// Check if the regex matches the content of the IOChunk.
	pub fn is_match(&self, chunk: &IOChunk) -> SedResult<bool> {
		if let Some(re) = self.raw_for(chunk)? {
			return raw_search(re, chunk.as_bytes(), 0, None);
		}

		match self {
			Self::Literal(m) => Ok(m.is_match(chunk.as_bytes())),
			Self::Unicode(re, _) => Ok(re.is_match(chunk.as_str().unwrap())),
			Self::Fancy(re, _) => Ok(re.is_match(chunk.as_str().unwrap())?),
		}
	}

	/// Visit matches until the callback stops. A byte-mode search reuses the
	/// same capture region for every match, including matches of invalid bytes.
	pub fn visit_captures(
		&self,
		chunk: &IOChunk,
		mut visit: impl FnMut(Captures<'_>) -> SedResult<ControlFlow<()>>,
	) -> SedResult<()> {
		if let Some(re) = self.raw_for(chunk)? {
			let text = chunk.as_bytes();
			let mut region = Region::new();
			let mut at = 0;
			let mut previous_end = None;
			while at <= text.len() && raw_search(re, text, at, Some(&mut region))? {
				let (start, end) = region.pos(0).unwrap();
				at = end + usize::from(start == end);
				if start == end && previous_end == Some(end) {
					continue;
				}
				previous_end = Some(end);
				if visit(Captures::Raw(Cow::Borrowed(&region), text))?.is_break() {
					break;
				}
			}
			return Ok(());
		}

		match self {
			Self::Literal(m) => {
				for (start, end, text) in m.iter(chunk.as_bytes()) {
					if visit(Captures::Literal(Match { start, end, text }))?.is_break() {
						break;
					}
				}
			},
			Self::Unicode(re, _) => {
				for caps in re.captures_iter(chunk.as_str().unwrap()) {
					if visit(Captures::Unicode(caps))?.is_break() {
						break;
					}
				}
			},
			Self::Fancy(re, _) => {
				for caps in re.captures_iter(chunk.as_str().unwrap()) {
					if visit(Captures::Fancy(caps?))?.is_break() {
						break;
					}
				}
			},
		}
		Ok(())
	}

	/// Return the number of capture groups, including group 0.
	pub fn captures_len(&self) -> usize {
		match self {
			Self::Literal(_) => 1,
			Self::Unicode(re, _) => re.captures_len(),
			Self::Fancy(re, _) => re.captures_len(),
		}
	}

	/// Return the elements of the first capture.
	pub fn captures<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Captures<'t>>> {
		let bytes = chunk.as_bytes();
		if let Some(re) = self.raw_for(chunk)? {
			let mut region = Region::new();
			return Ok(raw_search(re, bytes, 0, Some(&mut region))?
				.then_some(Captures::Raw(Cow::Owned(region), bytes)));
		}

		match self {
			Self::Literal(m) => Ok(m.find(bytes)
				.map(|(start, end, text)| Captures::Literal(Match { start, end, text }))),
			Self::Unicode(re, _) => Ok(re.captures(chunk.as_str().unwrap()).map(Captures::Unicode)),
			Self::Fancy(re, _) => Ok(re.captures(chunk.as_str().unwrap())?.map(Captures::Fancy)),
		}
	}

	/// Return a non-capturing result for a single match.
	pub fn find<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Match<'t>>> {
		let bytes = chunk.as_bytes();
		if let Some(re) = self.raw_for(chunk)? {
			let mut region = Region::new();
			return if raw_search(re, bytes, 0, Some(&mut region))? {
				let (start, end) = region.pos(0).unwrap();
				Ok(Some(Match { start, end, text: &bytes[start..end] }))
			} else {
				Ok(None)
			};
		}

		match self {
			Self::Literal(m) => Ok(m.find(bytes).map(|(start, end, text)| Match { start, end, text })),
			Self::Unicode(re, _) => Ok(re.find(chunk.as_str().unwrap())
				.map(|m| Match { start: m.start(), end: m.end(), text: m.as_str().as_bytes() })),
			Self::Fancy(re, _) => Ok(re.find(chunk.as_str().unwrap())?
				.map(|m| Match { start: m.start(), end: m.end(), text: m.as_str().as_bytes() })),
		}
	}
}

#[derive(Clone, Copy, Debug)]
/// Original pattern-space bytes and offsets of a match or capture.
pub struct Match<'t> {
	start: usize,   // Match start
	end:   usize,   // Match end
	text:  &'t [u8],
}

/// Provide interface compatible with Regex::Match.
impl<'t> Match<'t> {
	pub fn start(&self) -> usize {
		self.start
	}

	pub fn end(&self) -> usize {
		self.end
	}

	pub fn as_bytes(&self) -> &'t [u8] {
		self.text
	}
}

/// Provide interface compatible with Regex::Captures.
pub enum Captures<'t> {
	Literal(Match<'t>), // only group 0
	Unicode(UnicodeCaptures<'t>),
	Fancy(FancyCaptures<'t, str>),
	Raw(Cow<'t, Region>, &'t [u8]),
}

impl<'t> Captures<'t> {
	/// Get a capture by index, or None if that group didn't match.
	pub fn get(&self, i: usize) -> Option<Match<'t>> {
		match self {
			Self::Literal(m) => (i == 0).then_some(*m),
			Self::Unicode(caps) => caps.get(i)
				.map(|m| Match { start: m.start(), end: m.end(), text: m.as_str().as_bytes() }),
			Self::Fancy(caps) => caps.get(i)
				.map(|m| Match { start: m.start(), end: m.end(), text: m.as_str().as_bytes() }),
			Self::Raw(region, bytes) => region.pos(i)
				.map(|(start, end)| Match { start, end, text: &bytes[start..end] }),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_needs_fancy_re_matches() {
		let should_match = [
			r"(\w+):\1", // back-reference \1
		];

		for pat in &should_match {
			assert!(needs_backreferences(pat), "Expected needs_backreferences to match: {pat:?}");
		}
	}

	#[test]
	fn test_needs_fancy_re_does_not_match() {
		let should_not_match = [
			r"\ 1", // Non-adjacent
			r"\0",  // Only \[1-9]
			// Simple ASCII
			r"foo",
			r"foo|bar",
			r"^foo[0-9]+bar$",
		];

		for pat in &should_not_match {
			assert!(!needs_backreferences(pat), "Expected needs_backreferences to NOT match: {pat:?}");
		}
	}

	#[test]
	fn test_needs_re_matches() {
		let should_match = [
			r".",       // Single regex wildcard
			r"a+b",     // Regex +
			r"foo|bar", // Regex alternation
			r"abc?",    // Regex optional
			r"a*b",     // Regex star
			r"[abc]",   // Character class
			r"(abc)",   // Group
			r"{1,2}",   // Repetition
			r"\d",      // Class shorthand
			r"\S",      // Class shorthand
			r"\1",      // Backreference
			r"a\Pb",    // Unicode property
		];

		for pat in &should_match {
			assert!(needs_regex(pat), "Expected needs_regex to match: {pat:?}");
		}
	}

	#[test]
	fn test_needs_re_does_not_match() {
		let should_not_match = [
			r"abc",
			r"a\.b", // Escaped dot
			r"hello world",
			r"^abc$",  // Anchors alone
			r"file\.", // Escaped dot
			r"literal123",
			r"\\", // Escaped backslash
		];

		for pat in &should_not_match {
			assert!(!needs_regex(pat), "Expected needs_regex to NOT match: {pat:?}");
		}
	}

	// Regex::new
	#[test]
	fn assert_unicode_selection() {
		let re = Regex::new(r"x*").unwrap();
		assert!(matches!(re, Regex::Unicode(..)));
	}

	#[test]
	fn assert_fancy() {
		let re = Regex::new(r"(.)\1").unwrap();
		assert!(matches!(re, Regex::Fancy(..)));
	}

	#[test]
	fn assert_literal() {
		let re = Regex::new(r"x\.").unwrap();
		assert!(matches!(re, Regex::Literal(_)));
	}

	#[test]
	fn handles_invalid_regex_gracefully() {
		let err = Regex::new("(").unwrap_err().to_string();
		assert!(
			err.contains("unclosed group") || err.contains("error parsing"),
			"Unexpected error: {err:?}"
		);
	}

	// remove_escapes
	#[test]
	fn test_remove_escapes() {
		use super::remove_escapes;

		assert_eq!(remove_escapes("abc"), "abc");
		assert_eq!(remove_escapes(r"a\.c"), "a.c");
		assert_eq!(remove_escapes(r"\\d"), r"\d");
		assert_eq!(remove_escapes(r"\.\*\+\?"), ".*+?");
		assert_eq!(remove_escapes(r"escaped\\backslash"), r"escaped\backslash");
		assert_eq!(remove_escapes(r"trailing\\"), r"trailing\");
	}

	// LiteralMatcher
	#[test]
	fn test_literal_matcher_basic_match() {
		let matcher = LiteralMatcher::new("needle");
		assert!(matcher.is_match(b"this is a needle in a haystack"));
		assert!(!matcher.is_match(b"no match here"));
	}

	#[test]
	fn test_literal_matcher_anchor_start_match() {
		let matcher = LiteralMatcher::new("^needle");
		assert!(matcher.is_match(b"needle in a haystack"));
		assert!(!matcher.is_match(b"no needle match here"));
		assert!(!matcher.is_match(b"no"));
	}

	#[test]
	fn test_literal_matcher_anchor_end_match() {
		let matcher = LiteralMatcher::new("needle$");
		assert!(matcher.is_match(b"In a haystack there's a needle"));
		assert!(!matcher.is_match(b"no needle match here"));
		assert!(!matcher.is_match(b"no"));
	}

	#[test]
	fn test_literal_matcher_anchor_begin_end_match() {
		let matcher = LiteralMatcher::new("^needle$");
		assert!(matcher.is_match(b"needle"));
		assert!(!matcher.is_match(b"no needle match"));
		assert!(!matcher.is_match(b"needle no match"));
		assert!(!matcher.is_match(b"no match needle"));
		assert!(!matcher.is_match(b"nada"));
	}

	#[test]
	fn test_literal_matcher_utf8_match() {
		let matcher = LiteralMatcher::new("✓"); // U+2713 CHECK MARK (3 bytes)
		let haystack = "contains ✓ unicode".as_bytes();
		assert!(matcher.is_match(haystack));
		let found = matcher.find(haystack).unwrap();
		assert_eq!(found.2, "✓".as_bytes());
	}

	#[test]
	fn test_literal_matcher_find_location() {
		let matcher = LiteralMatcher::new("abc");
		let haystack = b"___abc___";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, b"abc");
	}

	#[test]
	fn test_literal_matcher_find_location_end() {
		let matcher = LiteralMatcher::new("abc$");
		let haystack = b"012abc";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, b"abc");
	}

	#[test]
	fn test_literal_matcher_iter_multiple() {
		let matcher = LiteralMatcher::new("test");
		let haystack = b"this test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 3);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, [b"test", b"test", b"test"]);
	}

	#[test]
	fn test_literal_matcher_iter_begin() {
		let matcher = LiteralMatcher::new("^test");
		let haystack = b"test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, [b"test"]);
	}

	#[test]
	fn test_literal_matcher_iter_end() {
		let matcher = LiteralMatcher::new("test$");
		let haystack = b"this test is a test of test";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, [b"test"]);
	}

	#[test]
	fn test_literal_matcher_no_match() {
		let matcher = LiteralMatcher::new("missing");
		let haystack = b"nothing to see here";
		assert!(!matcher.is_match(haystack));
		assert!(matcher.find(haystack).is_none());
		assert_eq!(matcher.iter(haystack).count(), 0);
	}

	#[test]
	fn test_literal_matcher_anchored_no_match() {
		let matcher = LiteralMatcher::new("^see$");
		let haystack = b"nothing to see here";
		assert!(!matcher.is_match(haystack));
		assert!(matcher.find(haystack).is_none());
		assert_eq!(matcher.iter(haystack).count(), 0);
	}

	#[test]
	fn prepends_s_when_no_flag_group() {
		assert_eq!(ensure_dotall("abc"), "(?s)abc");
	}

	#[test]
	fn adds_s_when_no_m_or_s() {
		assert_eq!(ensure_dotall("(?i)abc"), "(?is)abc");
		assert_eq!(ensure_dotall("(?)abc"), "(?s)abc");
		assert_eq!(ensure_dotall("(?:a*)?"), "(?s)(?:a*)?");
	}

	#[test]
	fn leaves_m_unchanged() {
		assert_eq!(ensure_dotall("(?m)abc"), "(?m)abc");
		assert_eq!(ensure_dotall("(?im)abc"), "(?im)abc");
		assert_eq!(ensure_dotall("(?mi)abc"), "(?mi)abc");
	}

	#[test]
	fn leaves_existing_s_unchanged() {
		assert_eq!(ensure_dotall("(?s)abc"), "(?s)abc");
		assert_eq!(ensure_dotall("(?is)abc"), "(?is)abc");
	}

}
}
pub mod in_place {
// Support for in-place editing
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	io,
	path::{Path, PathBuf},
};

#[cfg(unix)]
use omp_vfs::Permissions;
use omp_vfs::{BlockingFs, File, TempOptions};
use uucore::display::Quotable;

use crate::openfile::OpenFile;
use crate::sed::{
	command::ProcessingContext,
	error_handling::{IoContext, SedError, SedResult},
	fast_io::OutputBuffer,
};

/// Sibling file receiving in-place output, created through the injected
/// filesystem and removed through it unless renamed over its target.
pub struct TempFile {
	fs:        BlockingFs,
	path:      PathBuf,
	/// Kept to close explicitly; the output buffer writes through a clone.
	file:      Option<File>,
	persisted: bool,
}

impl TempFile {
	/// Creates a uniquely named file (`create_new`, mode 0600) in `dir`.
	fn create_in(fs: &BlockingFs, dir: &Path) -> io::Result<Self> {
		let (path, file) = fs.create_temp(dir, &TempOptions::new())?;
		Ok(Self { fs: fs.clone(), path, file: Some(file), persisted: false })
	}

	/// Closes the handle, surfacing errors a provider defers to close.
	fn close(&mut self) -> io::Result<()> {
		self.file.take().map_or(Ok(()), File::close)
	}

	/// Renames the file over `target`; on failure it is removed on drop.
	fn persist(&mut self, target: &Path) -> io::Result<()> {
		self.fs.rename(&self.path, target)?;
		self.persisted = true;
		Ok(())
	}
}

impl Drop for TempFile {
	fn drop(&mut self) {
		if self.persisted {
			return;
		}
		// Close before removing: an open handle can block removal (Windows),
		// and dropping a virtual handle would close it asynchronously.
		// Cleanup after an already reported failure; nothing to add.
		let _ = self.close();
		// Same provider without cancellation: an aborted edit must still
		// remove its temporary file.
		let _ = self.fs.for_cleanup().remove_file(&self.path);
	}
}

/// Context for in-place editing
// `output` precedes `temp_file` so on drop the output's handle closes
// before an unpersisted temporary file is removed.
pub struct InPlace {
	stdout:              OpenFile,
	/// Whether stdout is a regular file (block-buffered) rather than a pipe
	/// or stream (line-buffered); classified once by the host.
	stdout_is_file:      bool,
	unbuffered:          bool,
	separator:           u8,
	fs:                  BlockingFs,
	pub output:          OutputBuffer,
	pub in_place:        bool,
	pub in_place_suffix: Option<String>,
	pub follow_symlinks: bool,
	pub temp_file:       Option<TempFile>,
	pub original_path:   Option<PathBuf>,
}

impl InPlace {
	/// Create an in-place editing engine based on ProcessingContext.
	/// Depending on its settings it may or may not perform in-place
	/// editing, backup the original file, or follow symlinks.
	pub fn new_with_stdout(context: ProcessingContext, stdout: OpenFile, stdout_is_file: bool) -> Self {
		Self {
			output: OutputBuffer::new(
				Box::new(stdout.clone()),
				context.unbuffered || !stdout_is_file,
				context.separator(),
			),
			stdout,
			stdout_is_file,
			unbuffered: context.unbuffered,
			separator: context.separator(),
			fs: context.paths.fs().clone(),
			in_place: context.in_place,
			in_place_suffix: context.in_place_suffix,
			follow_symlinks: context.follow_symlinks,
			temp_file: None,
			original_path: None,
		}
	}

	/// Creates an editing engine backed by an in-memory output for unit tests.
	#[cfg(test)]
	pub fn new(context: ProcessingContext) -> Self {
		let (host, _) = crate::host::Host::for_test("sed", "", ".");
		Self::new_with_stdout(context, host.stdout_clone(), host.stdout_is_regular_file())
	}

	/// Return an OutputBuffer for outputting the edits to the specified file,
	/// the operand `name`. The file may be a symbolic link, which will be
	/// processed according to the context specification.
	pub fn begin(&mut self, file_name: &Path, name: &Path) -> SedResult<&mut OutputBuffer> {
		let resolved = if self.follow_symlinks {
			self.fs
				.canonicalize(file_name)
				.map_err_context(|| format!("resolving symlink {}", file_name.quote()))?
		} else {
			file_name.to_path_buf()
		};
		self.begin_resolved(&resolved, name)
	}

	/// Return an OutputBuffer for outputting the edits to the specified file.
	/// The passed file name should have resolved symbolic links according
	/// to the context settings.
	fn begin_resolved(&mut self, file_name: &Path, name: &Path) -> SedResult<&mut OutputBuffer> {
		if !self.in_place {
			return Ok(&mut self.output);
		}

		let metadata = self.fs.metadata(file_name).map_err_context(|| {
			format!("error Reading metadata of {} for in-place edit", file_name.quote())
		})?;

		if !metadata.is_file() {
			return Err(SedError::new(4, format!("couldn't edit {}: not a regular file", name.display())));
		}

		// URL-aware: the parent of `local://out` is `local://`, not `local:`.
		let dir = omp_vfs::parent_path(file_name).unwrap_or_else(|| Path::new("."));
		let temp_file = TempFile::create_in(&self.fs, dir)
			.map_err_context(|| format!("error creating temporary file in {}", dir.quote()))?;

		// TODO: On Unix use fchown(metadata.{uid,dig}) and fchmod(mode)
		// on let fd = temp_file.as_file().as_raw_fd() when uucore::libc
		// support them.
		#[cfg(unix)]
		{
			let mode = metadata.mode() & 0o7777;
			self.fs.set_permissions(&temp_file.path, Permissions::from_mode(mode))?;
		}

		let writer = temp_file.file.as_ref().expect("temporary file open").try_clone()?;
		self.output = OutputBuffer::new(Box::new(writer), self.unbuffered, self.separator);
		self.temp_file = Some(temp_file);
		self.original_path = Some(file_name.to_path_buf());

		Ok(&mut self.output)
	}

	/// Finish (potentially in-place) editing.
	pub fn end(&mut self) -> SedResult<()> {
		self.output.flush()?;

		if !self.in_place {
			return Ok(());
		}

		let orig = self.original_path.take().expect("original_path unset");
		// Every early return below drops `temp`, removing the temporary file.
		let mut temp = self.temp_file.take().expect("temp_file unset");

		// Release the output's handle, then close the last one to surface
		// deferred write errors before the file replaces the original.
		self.output = OutputBuffer::new(
			Box::new(self.stdout.clone()),
			self.unbuffered || !self.stdout_is_file,
			self.separator,
		);
		temp.close()
			.map_err_context(|| format!("error writing temporary file {}", temp.path.quote()))?;

		// Backup original if suffix is provided
		if let Some(suffix) = &self.in_place_suffix {
			let file_name = omp_vfs::file_name(&orig).expect("Missing file name for backup");
			let mut backup_name = file_name.to_os_string();
			backup_name.push(suffix);
			let backup_path = omp_vfs::with_file_name(&orig, backup_name);

			#[cfg(windows)]
			// Try to remove to ensure the rename won't fail on Windows.
			let _ = self.fs.remove_file(&backup_path);

			self.fs.rename(&orig, &backup_path).map_err_context(|| {
				format!("error backing up {} to {}", orig.quote(), backup_path.quote())
			})?;
		} else {
			#[cfg(windows)]
			// On Windows delete the original file for temp.persist to work
			if self.fs.exists(&orig) {
				self.fs.remove_file(&orig).map_err_context(|| {
					format!("error removing original input file {}", orig.quote())
				})?;
			}
		}

		// Atomically replace the original
		temp.persist(&orig).map_err_context(|| {
			format!("error persisting temporary file {} to {}", temp.path.quote(), orig.quote())
		})
	}
}


#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use tempfile::TempDir;

	use super::*;

	// Minimal stand-in for the assert_fs fixture API used by these
	// upstream tests, so tempfile (already a dependency) suffices.
	struct ChildPath(PathBuf);
	impl ChildPath {
		fn path(&self) -> &Path {
			&self.0
		}
	}
	trait PathChild {
		fn child(&self, name: &str) -> ChildPath;
	}
	impl PathChild for TempDir {
		fn child(&self, name: &str) -> ChildPath {
			ChildPath(self.path().join(name))
		}
	}
	use std::{
		fs,
		io::{Read, Write},
		path::Path,
	};

	fn minimal_context() -> ProcessingContext {
		ProcessingContext {
			in_place: false,
			in_place_suffix: None,
			follow_symlinks: false,
			// fill in default values for the rest as needed
			..Default::default()
		}
	}

	fn write_original(file: &Path, content: &str) {
		fs::write(file, content).unwrap();
	}

	fn read_file(file: &Path) -> String {
		let mut contents = String::new();
		fs::File::open(file)
			.unwrap()
			.read_to_string(&mut contents)
			.unwrap();
		contents
	}

	#[test]
	fn test_in_place_editing() {
		let temp = TempDir::new().unwrap();
		let file = temp.child("file.txt");
		write_original(file.path(), "original\n");

		let mut ctx = minimal_context();
		ctx.in_place = true;

		let mut inplace = InPlace::new(ctx);
		let buf = inplace.begin(file.path(), file.path()).unwrap();
		writeln!(buf, "updated").unwrap();
		inplace.end().unwrap();

		assert_eq!(read_file(file.path()), "updated\n");
	}

	#[test]
	fn test_in_place_backup() {
		let temp = TempDir::new().unwrap();
		let file = temp.child("file.txt");
		let backup = temp.child("file.txt.bak");
		write_original(file.path(), "original\n");

		let mut ctx = minimal_context();
		ctx.in_place = true;
		ctx.in_place_suffix = Some(".bak".to_string());

		let mut inplace = InPlace::new(ctx);
		let buf = inplace.begin(file.path(), file.path()).unwrap();
		writeln!(buf, "new content").unwrap();
		inplace.end().unwrap();

		assert_eq!(read_file(file.path()), "new content\n");
		assert_eq!(read_file(backup.path()), "original\n");
	}

	#[cfg(unix)]
	#[test]
	fn test_symlink_follow_true() {
		let temp = TempDir::new().unwrap();
		let real = temp.child("target.txt");
		let link = temp.child("link.txt");

		write_original(real.path(), "real\n");
		std::os::unix::fs::symlink(real.path(), link.path()).unwrap();

		let mut ctx = minimal_context();
		ctx.in_place = true;
		ctx.follow_symlinks = true;

		let mut inplace = InPlace::new(ctx);
		let buf = inplace.begin(link.path(), link.path()).unwrap();
		writeln!(buf, "changed").unwrap();
		inplace.end().unwrap();

		assert_eq!(read_file(real.path()), "changed\n");
		assert!(link.path().exists()); // Symlink still exists
	}

	#[cfg(unix)]
	#[test]
	fn test_symlink_follow_false() {
		let temp = TempDir::new().unwrap();
		let real = temp.child("target.txt");
		let link = temp.child("link.txt");

		write_original(real.path(), "real\n");
		std::os::unix::fs::symlink(real.path(), link.path()).unwrap();

		let mut ctx = minimal_context();
		ctx.in_place = true;
		ctx.follow_symlinks = false;

		let mut inplace = InPlace::new(ctx);
		let buf = inplace.begin(link.path(), link.path()).unwrap();
		writeln!(buf, "linked").unwrap();
		inplace.end().unwrap();

		// real file should remain untouched
		assert_eq!(read_file(real.path()), "real\n");

		// link (symlink path) now contains the new content
		let contents = read_file(link.path());
		assert_eq!(contents, "linked\n");
	}

	#[test]
	fn test_no_in_place_outputs_to_stdout() {
		let mut ctx = minimal_context();
		ctx.in_place = false;

		let mut inplace = InPlace::new(ctx);
		let _buf = inplace.begin(Path::new("fake.txt"), Path::new("fake.txt")).unwrap();
		assert!(inplace.end().is_ok());
	}
}
}
pub mod named_writer {
// An abstraction for output files created on entry and flushed on exit
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	cell::RefCell,
	io::{BufWriter, Write},
	path::PathBuf,
	rc::Rc,
};

use crate::openfile::{DescriptorPath, STDERR_FD, STDOUT_FD};
use omp_vfs::{File, OpenOptions};
use crate::host::{Host, ShellPaths, strip_errno};
use crate::sed::{
	command::ProcessingContext,
	error_handling::{SedError, SedResult},
	fast_io::{IOChunk, OutputBuffer},
};

thread_local! {
	 /// Global list of all writers that should be flushed at shutdown
	 static FLUSH_LIST: RefCell<Vec<Rc<RefCell<NamedWriter>>>> = const { RefCell::new(Vec::new()) };
}

/// Where a `w` file's lines go.
#[derive(Debug)]
enum Target {
	File(BufWriter<File>),
	/// `w /dev/stdout`: sed's own output stream, as GNU sed does, so the lines
	/// interleave with `p` output in order instead of racing it through a
	/// second open of the same file.
	Stdout,
	/// `w /dev/stderr`: sed's own error stream.
	Stderr,
	/// A file already flushed and closed by [`flush_all`].
	Closed,
}

#[derive(Debug)]
/// Writer that tracks its file name for better error messages
pub struct NamedWriter {
	/// The file name as the script spelled it.
	pub path:          PathBuf,
	target:            Target,
	pending_separator: bool,
}

impl NamedWriter {
	/// Return the writer for `path`: the one an earlier `w` or `W` opened for
	/// the same name, as GNU shares them, or a new one that truncates the file
	/// and is registered for flushing.
	///
	/// `paths` resolves `path` the way the shell would open it and supplies
	/// the filesystem that opens it.
	pub fn new(path: PathBuf, paths: &ShellPaths) -> SedResult<Rc<RefCell<Self>>> {
		let shared = FLUSH_LIST.with(|list| list.borrow().iter().find(|writer| writer.borrow().path == path).cloned());
		if let Some(writer) = shared {
			return Ok(writer);
		}

		let target = match DescriptorPath::parse(&path) {
			Some(DescriptorPath::Fd(STDOUT_FD)) => Target::Stdout,
			Some(DescriptorPath::Fd(STDERR_FD)) => Target::Stderr,
			_ => {
				let file = paths
					.fs()
					.open_with(
						paths.resolve(&path),
						OpenOptions::new().create(true).write(true).truncate(true),
					)
					.map_err(|e| {
						SedError::new(4, format!("couldn't open file {}: {}", path.display(), strip_errno(&e)))
					})?;
				Target::File(BufWriter::new(file))
			},
		};

		let writer = Rc::new(RefCell::new(NamedWriter { path, target, pending_separator: false }));

		FLUSH_LIST.with(|list| list.borrow_mut().push(Rc::clone(&writer)));
		Ok(writer)
	}

	/// Write a pattern record to the destination, preserving its terminator.
	pub fn write_line(
		&mut self,
		pattern: &IOChunk,
		output: &mut OutputBuffer,
		context: &ProcessingContext,
		host: &mut Host,
	) -> SedResult<()> {
		if matches!(self.target, Target::Stdout) && !context.in_place {
			return output.write_chunk(pattern).map_err(|e| self.flush_error(&e));
		}
		self.write_record(pattern.as_bytes(), pattern.is_terminated(), output, context, host)
	}

	/// Write the pattern space up to its first record separator, as `W` does;
	/// without one the whole pattern space, keeping its own terminator.
	pub fn write_first_line(
		&mut self,
		pattern: &IOChunk,
		output: &mut OutputBuffer,
		context: &ProcessingContext,
		host: &mut Host,
	) -> SedResult<()> {
		let bytes = pattern.as_bytes();
		match memchr::memchr(context.separator(), bytes) {
			Some(end) => self.write_record(&bytes[..end], true, output, context, host),
			None => self.write_line(pattern, output, context, host),
		}
	}

	/// Write record bytes, followed by the separator when `terminated`.
	fn write_record(
		&mut self,
		bytes: &[u8],
		terminated: bool,
		output: &mut OutputBuffer,
		context: &ProcessingContext,
		host: &mut Host,
	) -> SedResult<()> {
		let pending = &mut self.pending_separator;
		let result = match &mut self.target {
			Target::File(writer) => write_record_to(writer, bytes, terminated, context, pending),
			Target::Stdout if context.in_place => write_record_to(&mut host.stdout, bytes, terminated, context, pending),
			Target::Stdout => output.write_owned_content(bytes, terminated),
			Target::Stderr => write_record_to(&mut host.stderr, bytes, terminated, context, pending),
			Target::Closed => Err(std::io::Error::other("file already closed")),
		};
		result.map_err(|e| self.flush_error(&e))
	}

	/// GNU's fatal error for output this file could not take.
	fn flush_error(&self, error: &std::io::Error) -> SedError {
		SedError::new(4, format!("couldn't flush {}: {}", self.path.display(), strip_errno(error)))
	}

	/// Flush the writer and close its file, returning a descriptive error.
	///
	/// Closing explicitly surfaces errors a filesystem provider reports only
	/// when the handle closes, which dropping it would discard.
	pub fn close(&mut self) -> SedResult<()> {
		let writer = match std::mem::replace(&mut self.target, Target::Closed) {
			Target::File(writer) => writer,
			other => {
				self.target = other;
				return Ok(());
			},
		};
		writer.into_inner().map_err(|e| e.into_error()).and_then(File::close).map_err(|e| self.flush_error(&e))
	}
}

/// Write to a `w` destination other than sed's current output stream.
fn write_record_to(
	writer: &mut impl Write,
	bytes: &[u8],
	terminated: bool,
	context: &ProcessingContext,
	pending_separator: &mut bool,
) -> std::io::Result<()> {
	let separator = [context.separator()];
	if *pending_separator {
		writer.write_all(&separator)?;
	}
	writer.write_all(bytes)?;
	if terminated {
		writer.write_all(&separator)?;
	}
	*pending_separator = !terminated;
	if context.unbuffered {
		writer.flush()?;
	}
	Ok(())
}

/// Flush buffered content to the files and close them, returning
/// descriptive errors.
// the registry is drained (not just
// iterated) so open files do not outlive the invocation on a reused thread.
pub fn flush_all() -> SedResult<()> {
	FLUSH_LIST.with(|cell| {
		for handle in cell.borrow_mut().drain(..) {
			handle.borrow_mut().close()?;
		}

		Ok(())
	})
}

/// Clear the thread-local writer registry. Called at builtin entry so
/// writers registered by a previous invocation on the same thread (one that
/// failed before reaching `flush_all`) cannot leak into this run.
pub fn reset() {
	FLUSH_LIST.with(|cell| cell.borrow_mut().clear());
}
}
pub mod processor {
// Process the files with the compiled scripts
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	cell::RefCell,
	fmt::Write as _,
	io::{self, SeekFrom},
	ops::ControlFlow,
	path::PathBuf,
	process::Command as ProcessCommand,
	rc::Rc,
};

use memchr::memchr;

use crate::host::{Host, ShellPaths, strip_errno};

use crate::sed::{
	command::{
		Address, AppendElement, Command, CommandData, InputAction, ProcessingContext, Transliteration,
	},
	error_handling::{SedError, SedResult, invalid_reference, read_error, script_runtime_error},
	fast_io::{IOChunk, LineReader, OutputBuffer},
	fast_regex::Regex,
	in_place::InPlace,
	named_writer,
};

/// Return the specified command variant or panic.
// Example: let path = extract_variant!(command, Path);
macro_rules! extract_variant {
	($cmd:expr, $variant:ident) => {
		match &$cmd.data {
			CommandData::$variant(inner) => inner,
			_ => panic!(concat!("Expected ", stringify!($variant), " command data")),
		}
	};
}

/// Return true if the passed address matches the current I/O context.
fn match_address(
	addr: &Address,
	reader: &mut LineReader,
	pattern: &IOChunk,
	context: &mut ProcessingContext,
) -> SedResult<bool> {
	match addr {
		Address::Re(re) => re_or_saved_re(re.as_ref(), context, true)?.is_match(pattern),

		Address::Line(lineno) => Ok(context.line_number == *lineno),

		// Recognize "$" as the last line of last file. This is consistent
		// with the original 7th Research Edition implementation:
		// https://github.com/dspinellis/unix-history-repo/blob/Research-V7/usr/src/cmd/sed/sed1.c#L665
		// The FreeBSD version checked for subsequent empty files, but this
		// can lead to destructive reads (e.g. from named pipes),
		// and is probably an overkill.
		Address::Last => {
			let last_line = reader.last_line().map_err(|e| read_error(&context.input_name, &e))?;
			// GNU looks past the following operands here, reading a directory as empty.
			context.looked_past_input |= last_line;
			Ok(last_line && (context.last_file || context.separate))
		},

		_ => panic!("invalid address type in match_address"),
	}
}

#[allow(dead_code)]
/// Return true if the command applies to the given pattern.
fn applies(
	command: &mut Command,
	reader: &mut LineReader,
	pattern: &IOChunk,
	context: &mut ProcessingContext,
) -> SedResult<bool> {
	let linenum = context.line_number;

	let result = if command.addr1.is_none() && command.addr2.is_none() {
		// No address
		Ok(true)
	} else if let Some(addr2) = &command.addr2 {
		// Two addresses
		if let Some(start) = command.start_line {
			// Range is already latched active.
			match addr2 {
				Address::RelLine(n) => {
					if linenum - start > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::Line(n) => {
					// Special case: already ended
					if linenum > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::StepMatch(step) => Ok((linenum - start).is_multiple_of(*step)),
				Address::StepEnd(step) => {
					// Inclusive end on multiple of step
					if linenum.is_multiple_of(*step) {
						command.start_line = None;
					}
					Ok(true)
				},
				_ => {
					if match_address(addr2, reader, pattern, context)? {
						command.start_line = None;
						context.last_address = true;
					}
					Ok(true)
				},
			}
		} else if let Some(addr1) = &command.addr1 {
			// See if latch must start.
			if match_address(addr1, reader, pattern, context)? {
				match addr2 {
					Address::Line(n) if linenum >= *n => {
						context.last_address = true;
					},
					// `addr1,+0` and GNU's `addr1,~0` select the first line only.
					Address::RelLine(0) | Address::StepEnd(0) => {
						context.last_address = true;
					},
					_ => {
						command.start_line = Some(linenum);
					},
				}
				Ok(true)
			} else {
				Ok(false)
			}
		} else {
			Ok(false)
		}
	} else if let Some(addr1) = &command.addr1 {
		// Single address
		Ok(match_address(addr1, reader, pattern, context)?)
	} else {
		// All allowed cases have been covered by the above logic.
		panic!("impossible address combination");
	};

	if command.non_select {
		result.map(|v| !v)
	} else {
		result
	}
}

/// Write the specified chunk to the output for a given processing context.
fn write_chunk(
	output: &mut OutputBuffer,
	context: &ProcessingContext,
	chunk: &IOChunk,
) -> std::io::Result<()> {
	output.write_chunk(chunk)?;

	if context.unbuffered {
		output.flush()?;
	}

	Ok(())
}

/// Return a reference to the current or the saved RE if the RE is None.
/// Update the saved RE to RE, noting whether an address supplied it.
fn re_or_saved_re<'a>(
	regex: Option<&Rc<Regex>>,
	context: &'a mut ProcessingContext,
	from_address: bool,
) -> SedResult<&'a Regex> {
	if let Some(re) = regex {
		// Share the compiled RE rather than cloning it: a cloned `Regex` gets a
		// fresh, empty match cache, so every line would rebuild it from scratch.
		if !context.saved_regex.as_ref().is_some_and(|saved| Rc::ptr_eq(saved, re)) {
			context.saved_regex = Some(Rc::clone(re));
		}
		context.saved_regex_from_address = from_address;
		// Return a reference into context.saved_regex.
		Ok(context.saved_regex.as_deref().unwrap())
	} else if let Some(saved_re) = context.saved_regex.as_deref() {
		// We already have one: just borrow it.
		Ok(saved_re)
	} else {
		script_runtime_error(context, "no previous regular expression")
	}
}

#[cfg(unix)]
fn shell_command(cmd: &[u8], host: &Host) -> io::Result<ProcessCommand> {
	use std::os::unix::ffi::OsStrExt as _;

	let mut c = ProcessCommand::new("sh");
	c.arg("-c").arg(std::ffi::OsStr::from_bytes(cmd));
	// `output()` captures the child's stdio instead of inheriting the TUI's.
	c.current_dir(host.native_cwd()?);
	c.env_clear().envs(host.env());
	Ok(c)
}

#[cfg(windows)]
fn shell_command(cmd: &[u8], host: &Host) -> io::Result<ProcessCommand> {
	let mut c = ProcessCommand::new("cmd.exe");
	c.arg("/C").arg(std::str::from_utf8(cmd).map_err(io::Error::other)?);
	c.current_dir(host.native_cwd()?);
	c.env_clear().envs(host.env());
	Ok(c)
}

// Fallback if the target OS is neither Windows nor UNIX-like
#[cfg(not(any(unix, windows)))]
fn shell_command(_cmd: &[u8], _host: &Host) -> io::Result<ProcessCommand> {
	Err(omp_vfs::unsupported("the 'e' command requires a platform shell"))
}

/// Run `cmd` through the platform shell for `e` or `s///e` and return its standard output.
fn shell_output(cmd: &[u8], host: &Host) -> SedResult<Vec<u8>> {
	shell_command(cmd, host)
		.and_then(|mut shell| shell.output())
		.map(|output| output.stdout)
		.map_err(|_| SedError::new(4, "error in subprocess"))
}

/// Drop one trailing line terminator from shell output that replaces the pattern space.
fn trim_line_end(output: &mut Vec<u8>) {
	if output.ends_with(b"\r\n") {
		output.truncate(output.len() - 2);
	} else if output.ends_with(b"\n") {
		output.pop();
	}
}

/// Perform the specified RE replacement in the provided pattern space.
fn substitute(
	pattern: &mut IOChunk,
	command: &Command,
	context: &mut ProcessingContext,
	output: &mut OutputBuffer,
	host: &mut Host,
) -> SedResult<()> {
	let sub = extract_variant!(command, Substitution);
	// GNU compiles an address regex without its groups and checks them only
	// when an `s//` first reuses it.
	if sub.regex.is_none() && context.saved_regex_from_address {
		let groups = context.saved_regex.as_ref().map_or(0, |saved| saved.captures_len() - 1);
		if sub.replacement.max_group_number > groups {
			return script_runtime_error(context, invalid_reference(sub.replacement.max_group_number));
		}
		context.saved_regex_from_address = false;
	}
	let regex = re_or_saved_re(sub.regex.as_ref(), context, false)?;
	let text = pattern.as_bytes();

	// Leave untouched lines borrowed. Copy unmatched spans only when a
	// replacement is actually selected (not for every preceding match).
	let mut result = Vec::new();
	let mut last_end = 0;
	let mut replaced = false;
	let mut before_match = |result: &mut Vec<u8>, start: usize, end: usize| {
		if !replaced {
			result.reserve(text.len());
			replaced = true;
		}
		result.extend_from_slice(&text[last_end..start]);
		last_end = end;
	};

	let single = sub.occurrence == 1 && !sub.global;
	let subst_result = if single && sub.replacement.max_group_number == 0 {
		regex.find(pattern).map(|matched| {
			if let Some(m) = matched {
				before_match(&mut result, m.start(), m.end());
				sub.replacement.apply_match(&m, &mut result);
			}
		})
	} else if single {
		regex.captures(pattern).and_then(|matched| {
			if let Some(caps) = matched {
				let m = caps.get(0).unwrap();
				before_match(&mut result, m.start(), m.end());
				sub.replacement.apply_captures(&caps, &mut result);
			}
			Ok(())
		})
	} else {
		let mut count = 0;
		regex.visit_captures(pattern, |caps| {
			count += 1;
			// `Ng` replaces the Nth match and every later one (GNU).
			if count == sub.occurrence || (sub.global && count > sub.occurrence) {
				let m = caps.get(0).unwrap();
				before_match(&mut result, m.start(), m.end());
				sub.replacement.apply_captures(&caps, &mut result);
			}
			Ok(if !sub.global && count == sub.occurrence {
				ControlFlow::Break(())
			} else {
				ControlFlow::Continue(())
			})
		})
	};
	subst_result?;
	if !replaced {
		return Ok(());
	}
	result.extend_from_slice(&text[last_end..]);
	pattern.set_bytes(result, pattern.is_terminated());

	if sub.execute {
		let mut shell_out = shell_output(pattern.as_bytes(), host)?;
		trim_line_end(&mut shell_out);
		pattern.set_bytes(shell_out, pattern.is_terminated());
	}

	if sub.print_flag {
		write_chunk(output, context, pattern)?;
	}
	if let Some(writer) = &sub.write_file {
		writer.borrow_mut().write_line(pattern, output, context, host)?;
	}
	context.substitution_made = true;
	Ok(())
}

/// Apply the specified transliteration in the provided pattern space.
fn transliterate(pattern: &mut IOChunk, trans: &Transliteration) {
	let bytes = pattern.as_bytes();
	let mut result = Vec::new();
	let mut chunk_start = 0;
	let mut last_end = 0;
	for chunk in bytes.utf8_chunks() {
		for (offset, ch) in chunk.valid().char_indices() {
			let mapped = trans.lookup(ch);
			if mapped != ch {
				if last_end == 0 {
					result.reserve(bytes.len());
				}
				let start = chunk_start + offset;
				result.extend_from_slice(&bytes[last_end..start]);
				result.extend_from_slice(mapped.encode_utf8(&mut [0; 4]).as_bytes());
				last_end = start + ch.len_utf8();
			}
		}
		chunk_start += chunk.valid().len() + chunk.invalid().len();
	}
	if last_end != 0 {
		result.extend_from_slice(&bytes[last_end..]);
		pattern.set_bytes(result, pattern.is_terminated());
	}
}

/// Output any data queued for output at the end of the cycle.
fn flush_appends(output: &mut OutputBuffer, context: &mut ProcessingContext) -> SedResult<()> {
	for elem in &context.append_elements {
		match elem {
			AppendElement::Text(text) => {
				output.write_raw(text.as_bytes())?;
			},
			AppendElement::Path(path) => {
				output.copy_file(context.paths.fs(), &context.paths.resolve(path), path)?;
			},
			AppendElement::Line(line) => {
				output.write_raw(line)?;
			},
		}
	}
	if context.unbuffered && !context.append_elements.is_empty() {
		output.flush()?;
	}
	context.append_elements.clear();
	Ok(())
}

/// List the passed pattern space in unambiguous form. As GNU sed does, in the
/// C and the C.UTF-8 locale alike, each byte that is not printable ASCII is an
/// escape: a character of several bytes is the octal escape of each (`é` is
/// `\303\251`), and a newline of the pattern space is `\n`. Each folded piece
/// and the final `$` end with the record separator. A `max_width` of 0 folds
/// nothing.
fn list(output: &mut OutputBuffer, line: &IOChunk, max_width: usize) -> SedResult<()> {
	if line.is_empty() && !line.is_terminated() {
		return Ok(());
	}

	let mut buffer = String::new();
	let mut escape = String::new();
	for &byte in line.as_bytes() {
		escape.clear();
		match byte {
			b'\x07' => escape.push_str(r"\a"),
			b'\x08' => escape.push_str(r"\b"),
			b'\n' => escape.push_str(r"\n"),
			b'\x0b' => escape.push_str(r"\v"),
			b'\x0c' => escape.push_str(r"\f"),
			b'\\' => escape.push_str(r"\\"),
			b'\r' => escape.push_str(r"\r"),
			b'\t' => escape.push_str(r"\t"),
			b' '..=b'~' => escape.push(char::from(byte)),
			_ => write!(escape, "\\{byte:03o}").unwrap(),
		}

		if max_width > 0 && buffer.len() + escape.len() + 1 > max_width {
			buffer.push('\\');
			output.write_owned_content(buffer.as_bytes(), true)?;
			buffer.clear();
		}
		buffer.push_str(&escape);
	}
	buffer.push('$');
	output.write_owned_content(buffer.as_bytes(), true)?;
	Ok(())
}

/// Handle address 0 read at the beginning of each file.
fn process_address_0(
	commands: Option<Rc<RefCell<Command>>>,
	output: &mut OutputBuffer,
	paths: &ShellPaths,
) -> SedResult<()> {
	// Prescan for zero-address which must produce output
	// before any input line is read.
	{
		let mut current = commands;
		while let Some(cmd_rc) = current {
			let next = {
				let cmd = cmd_rc.borrow();

				if cmd.code == 'r' && matches!(cmd.addr1, Some(Address::Line(0))) && cmd.addr2.is_none()
				{
					let path = extract_variant!(cmd, Path);
					output.copy_file(paths.fs(), &paths.resolve(path), path)?;
				}

				cmd.next.clone()
			};
			current = next;
		}
	}
	Ok(())
}

#[allow(clippy::cognitive_complexity)]
/// Process a single input file
fn process_file(
	commands: Option<Rc<RefCell<Command>>>,
	reader: &mut LineReader,
	output: &mut OutputBuffer,
	context: &mut ProcessingContext,
	host: &mut Host,
) -> SedResult<()> {
	process_address_0(commands.clone(), output, &context.paths)?;
	let separator = context.separator();

	// Loop over the input lines as pattern space.
	'lines: while let Some(mut pattern) = reader.get_line().map_err(|e| read_error(&context.input_name, &e))? {
		// snapshot-backed input never
		// touches the (cancel-aware) stdin reader, so poll the host cancel
		// flag here to keep long file runs abortable.
		if host.is_cancelled() {
			break;
		}
		context.line_number += 1;
		context.substitution_made = false;
		// Set the script command from which to start.
		let mut current: Option<Rc<RefCell<Command>>> =
			if let Some(action) = context.input_action.take() {
				// Continue processing the `N` command.
				let mut combined_lines = action.prepend;
				combined_lines.push(separator);
				combined_lines.extend_from_slice(pattern.as_bytes());

				pattern.set_bytes(combined_lines, pattern.is_terminated());
				action.next_command
			} else {
				// Start from the script top.
				commands.clone()
			};

		// Loop over script commands.
		while let Some(command_rc) = current.take() {
			let mut command = command_rc.borrow_mut();

			if !applies(&mut command, reader, &pattern, context)? {
				// Advance to next command
				current.clone_from(&command.next);
				continue;
			}

			match command.code {
				'{' => {
					// Block begin; start processing the enclosed ones.
					let body = extract_variant!(command, BranchTarget);
					current.clone_from(body);
					continue;
				},
				'}' => {
					// Block end: continue with the block's patched next.
				},
				'a' => {
					// Write the text to standard output at a later point.
					let text = extract_variant!(command, Text);
					context
						.append_elements
						.push(AppendElement::Text(text.clone()));
				},
				'b' => {
					// Branch to the specified label or end if none is given.
					let target = extract_variant!(command, BranchTarget);
					if target.is_some() {
						// New command to execute
						current.clone_from(target);
						continue;
					}
					// Branch to the end of the script.
					break;
				},
				'c' => {
					// At range end replace pattern space with text and
					// start the next cycle.
					pattern.clear();
					let range_end = command.addr2.is_none()
						|| context.last_address
						|| reader.last_line().map_err(|e| read_error(&context.input_name, &e))?;
					if range_end {
						let text = extract_variant!(command, Text);
						output.write_script_text(text)?;
					}
					break;
				},
				'd' => {
					// Delete the pattern space and start the next cycle.
					pattern.clear();
					break;
				},
				'e' => {
					let shell_cmd = extract_variant!(command, Text);
					if shell_cmd.is_empty() {
						// Replace the pattern space with the output of running it.
						let mut shell_out = shell_output(pattern.as_bytes(), host)?;
						trim_line_end(&mut shell_out);
						pattern.set_bytes(shell_out, pattern.is_terminated());
					} else {
						// Output the command's output before the end-of-cycle print.
						let shell_out = shell_output(shell_cmd.as_bytes(), host)?;
						output.write_raw(&shell_out)?;
					}
				},
				'D' => {
					// Delete the first record and restart without reading input.
					if let Some(pos) = memchr(separator, pattern.as_bytes()) {
						let (s, _) = pattern.fields_mut();
						s.drain(..=pos);
						current.clone_from(&commands);
						continue;
					}
					// Same as d
					pattern.clear();
					break;
				},
				'F' => {
					// Output the input file name, `-` for standard input.
					output.write_owned_content(context.input_name.as_os_str().as_encoded_bytes(), true)?;
				},
				'g' => {
					// Replace pattern with the contents of the hold space.
					pattern.copy_bytes(&context.hold.content, context.hold.terminated);
				},
				'G' => {
					// Append a separator followed by hold space contents.
					let (pat_content, pat_terminated) = pattern.fields_mut();
					pat_content.push(separator);
					pat_content.extend_from_slice(&context.hold.content);
					*pat_terminated = context.hold.terminated;
				},
				'h' => {
					// Replace hold with the contents of the pattern space, reusing
					// the hold buffer.
					context.hold.content.clear();
					context.hold.content.extend_from_slice(pattern.as_bytes());
					context.hold.terminated = pattern.is_terminated();
				},
				'H' => {
					// Append a separator followed by the pattern space contents.
					context.hold.content.push(separator);
					context.hold.content.extend_from_slice(pattern.as_bytes());
					context.hold.terminated = pattern.is_terminated();
				},
				'i' => {
					// Write text to standard output.
					let text = extract_variant!(command, Text);
					output.write_script_text(text)?;
				},
				'l' => {
					let width = *extract_variant!(command, Number);
					list(output, &pattern, width)?;
				},
				'n' => {
					break;
				},
				'N' => {
					flush_appends(output, context)?;
					// Append a separator and the next record.
					// Rather than reading input here, which would result
					// in a double borrow on reader, modify the action
					// to perform when the next line is read. This cycle's
					// `pattern` is discarded, so move its buffer instead of
					// copying the accumulated pattern space each time.
					context.input_action = Some(InputAction {
						next_command: command.next.clone(),
						terminated:   pattern.is_terminated(),
						prepend:      std::mem::take(pattern.fields_mut().0),
					});
					continue 'lines;
				},
				'p' => {
					write_chunk(output, context, &pattern)?;
				},
				'P' => {
					let line = pattern.as_bytes();
					if let Some(pos) = memchr(separator, line) {
						output.write_owned_content(&line[..pos], true)?;
					} else {
						write_chunk(output, context, &pattern)?;
					}
				},
				'q' => {
					// Quit after printing the pattern space.
					host.fail(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					break;
				},
				'Q' => {
					// Quit without printing the pattern space or queued appends.
					host.fail(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					return Ok(());
				},
				'r' => {
					// Copy the file to standard output at a later point.
					let path = extract_variant!(command, Path);
					context
						.append_elements
						.push(AppendElement::Path(path.clone()));
				},
				'R' => {
					// Queue the file's next line, if any, for output at the end of the cycle.
					let source = extract_variant!(command, LineSource);
					if let Some(line) = source.borrow_mut().next_line(host, separator)? {
						context.append_elements.push(AppendElement::Line(line));
					}
				},
				's' => {
					substitute(&mut pattern, &command, context, output, host)?;
				},
				't' if !context.substitution_made => { /* Do nothing. */ },
				't' => {
					// Branch to the specified label or end if none is given
					// if a substitution was made since last cycle or t.
					let target = extract_variant!(command, BranchTarget);
					context.substitution_made = false;
					if target.is_some() {
						// New command to execute
						current.clone_from(target);
						continue;
					}
					// Branch to the end of the script.
					break;
				},
				'w' => {
					// Append the pattern space to the specified file.
					let writer = extract_variant!(command, NamedWriter);
					writer.borrow_mut().write_line(&pattern, output, context, host)?;
				},
				'W' => {
					// Append the pattern space's first line to the specified file.
					let writer = extract_variant!(command, NamedWriter);
					writer.borrow_mut().write_first_line(&pattern, output, context, host)?;
				},
				'x' => {
					// Exchange the contents of the pattern and hold spaces.
					let (pat_content, pat_terminated) = pattern.fields_mut();

					// Swap terminators if hold space is logically non-empty.
					if !context.hold.content.is_empty() || context.hold.terminated {
						std::mem::swap(pat_terminated, &mut context.hold.terminated);
					}
					std::mem::swap(pat_content, &mut context.hold.content);
				},
				'y' => {
					let trans = extract_variant!(command, Transliteration);
					transliterate(&mut pattern, trans);
				},
				'z' => {
					// Clear the pattern contents, but preserve termination state
					// so automatic printing still emits an empty record.
					pattern.copy_bytes(b"", pattern.is_terminated());
				},
				':' => {
					// Branch target; do nothing.
				},
				'=' => {
					// Output current line number.
					output.write_line_number(context.line_number)?;
				},
				// The compilation should supply only valid codes.
				_ => panic!("invalid command code"),
			} // match
			// Advance to next command.
			current.clone_from(&command.next);
		}

		if !context.quiet {
			write_chunk(output, context, &pattern)?;
		}

		flush_appends(output, context)?;
		reader.recycle(pattern);

		if context.stop_processing {
			break;
		}
	}

	Ok(())
}

/// Finish a pending `N` when there is no next record.
fn finish_pending_input(output: &mut OutputBuffer, context: &mut ProcessingContext) -> SedResult<()> {
	if let Some(action) = context.input_action.take()
		&& !context.quiet
	{
		output.write_owned_content(&action.prepend, action.terminated)?;
	}

	Ok(())
}

/// Mark all address ranges non-active (and 0-starting ones as active).
fn reset_latched_address_ranges(range_commands: &mut [Rc<RefCell<Command>>]) {
	for cmd_rc in range_commands.iter() {
		let mut cmd = cmd_rc.borrow_mut();

		cmd.start_line =
            // Check for address-spec line 0 pre-latch extension.
            if let Some(addr1) = &cmd.addr1 && matches!(addr1, Address::Line(0)) {
                Some(0)
            } else {
                None
            };
	}
}

/// Open the next readable input file, returning the directory operands met
/// before it. Unreadable files are reported as GNU does and set exit status 2
/// without stopping the run.
fn open_next_input<'p>(
	paths: &mut std::slice::Iter<'p, PathBuf>,
	host: &mut Host,
	context: &ProcessingContext,
) -> (Vec<(&'p PathBuf, io::Error)>, Option<(&'p PathBuf, LineReader<'static>)>) {
	let mut directories = Vec::new();
	for path in paths.by_ref() {
		match LineReader::open_with_host(path, host, context.separator(), context.unbuffered) {
			Ok(reader) => return (directories, Some((path, reader))),
			Err(e) if e.kind() == io::ErrorKind::IsADirectory => directories.push((path, e)),
			Err(e) => host.error(format_args!("can't read {}: {}", path.display(), strip_errno(&e)), 2),
		}
	}
	(directories, None)
}

/// Fail on directory operands reached as input, as GNU does, unless its `$` or
/// `N` lookahead past the previous file already read them as empty.
fn check_directories(
	directories: Vec<(&PathBuf, io::Error)>,
	lookahead: bool,
	context: &ProcessingContext,
) -> SedResult<()> {
	match directories.into_iter().next() {
		Some((path, _)) if context.in_place => {
			Err(SedError::new(4, format!("couldn't edit {}: not a regular file", path.display())))
		},
		Some((path, error)) if !(lookahead && context.looked_past_input) => Err(read_error(path, &error)),
		_ => Ok(()),
	}
}

/// Process all input files
pub fn process_all_files(
	commands: Option<Rc<RefCell<Command>>>,
	files: Vec<PathBuf>,
	context: &mut ProcessingContext,
	host: &mut Host,
) -> SedResult<()> {
	// the context streams are never a
	// terminal, so upstream's stdout-tty check for auto-unbuffered output is
	// dropped; `-u` alone controls flushing.

	let mut in_place =
		InPlace::new_with_stdout(context.clone(), host.stdout_clone(), host.stdout_is_regular_file());
	// Like GNU, look past unreadable files to tell whether a file holds the
	// last line; per-file processing opens each file only when it is reached.
	let lookahead = !context.separate && !context.in_place;
	let mut paths = files.iter();
	let (mut directories, mut next) = open_next_input(&mut paths, host, context);
	let mut first = true;

	loop {
		check_directories(directories, lookahead, context)?;
		let Some((path, mut reader)) = next.take() else {
			break;
		};
		if lookahead {
			(directories, next) = open_next_input(&mut paths, host, context);
			context.last_file = next.is_none();
		} else {
			directories = Vec::new();
			context.last_file = paths.len() == 0;
		}
		let resolved_path = host.resolve(path);
		let output = in_place.begin(&resolved_path, path)?;

		if context.separate || first {
			first = false;
			context.line_number = 0;
			reset_latched_address_ranges(&mut context.range_commands);

			// Reset hold space for separate file processing
			context.hold.content.clear();
			context.hold.terminated = true;
		}

		context.input_name.clone_from(path);
		context.looked_past_input = false;
		process_file(commands.clone(), &mut reader, output, context, host)?;
		// A pending `N` at the end of a file read ahead into the next one.
		context.looked_past_input |= context.input_action.is_some();

		if context.stop_processing && path.as_os_str() == "-" {
			let unread = reader.unread_bytes();
			if unread != 0 {
				// The shared stdin offset must point just past the last
				// consumed record. Pipes cannot return buffered bytes.
				let _ = host.stdin.file().seek(SeekFrom::Current(-(unread as i64)));
			}
		}
		if context.last_file || context.separate {
			finish_pending_input(output, context)?;
		}

		in_place.end()?;

		if context.stop_processing {
			break;
		}
		if !lookahead {
			(directories, next) = open_next_input(&mut paths, host, context);
		}
	}

	// Flush all output files
	named_writer::flush_all()?;

	Ok(())
}
}
pub mod script_char_provider {
// Provide the script contents character by character
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

#[derive(Debug)]
pub struct ScriptCharProvider {
	line: Vec<char>,
	pos:  usize,
}

impl ScriptCharProvider {
	pub fn new(line_string: &str) -> Self {
		Self { line: line_string.chars().collect(), pos: 0 }
	}

	/// Advances to the next character, if not at end of line.
	pub fn advance(&mut self) {
		if self.pos < self.line.len() {
			self.pos += 1;
		}
	}

	/// Retreats current position by specified number or to beginning.
	pub fn retreat(&mut self, n: usize) {
		self.pos = self.pos.saturating_sub(n);
	}

	/// Sets new current position.
	pub fn set_position(&mut self, pos: usize) {
		self.pos = pos;
	}

	/// Returns the current character. Panics if out of bounds.
	pub fn current(&self) -> char {
		self.line[self.pos]
	}

	/// Returns true if at the end of the line.
	pub fn eol(&self) -> bool {
		self.pos >= self.line.len()
	}

	/// Advances the position past any whitespace characters.
	pub fn eat_spaces(&mut self) {
		while self.pos < self.line.len() && self.line[self.pos].is_whitespace() {
			self.pos += 1;
		}
	}

	/// Return current position
	pub fn get_pos(&self) -> usize {
		self.pos
	}

	/// Returns the UTF-8 byte offset of the current position; GNU counts script bytes.
	pub fn byte_pos(&self) -> usize {
		self.line[..self.pos.min(self.line.len())]
			.iter()
			.map(|c| c.len_utf8())
			.sum()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_basic_navigation() {
		let mut provider = ScriptCharProvider::new("abc");
		assert_eq!(provider.get_pos(), 0);
		assert_eq!(provider.current(), 'a');
		provider.advance();
		assert_eq!(provider.get_pos(), 1);
		assert_eq!(provider.current(), 'b');
		provider.advance();
		assert_eq!(provider.get_pos(), 2);
		assert_eq!(provider.current(), 'c');
		provider.advance();
		assert_eq!(provider.get_pos(), 3);
		assert!(provider.eol());
	}

	#[test]
	#[should_panic]
	fn test_current_panics_out_of_bounds() {
		let mut provider = ScriptCharProvider::new("x");
		provider.advance(); // now at end
		provider.current(); // should panic
	}

	#[test]
	fn test_eat_spaces() {
		let mut provider = ScriptCharProvider::new("   xyz");
		provider.eat_spaces();
		assert_eq!(provider.current(), 'x');
	}

	#[test]
	fn test_eol_on_empty() {
		let provider = ScriptCharProvider::new("");
		assert!(provider.eol());
	}

	#[test]
	fn test_eat_spaces_mixed() {
		let mut provider = ScriptCharProvider::new("  \t\nabc");
		provider.eat_spaces();
		assert_eq!(provider.current(), 'a');
	}

	#[test]
	fn test_retreat_normal() {
		let mut chars = ScriptCharProvider::new("abcdef");
		chars.pos = 4; // simulate position at 'e'
		chars.retreat(2);

		assert_eq!(chars.get_pos(), 2);
		assert_eq!(chars.current(), 'c');
	}

	#[test]
	fn test_retreat_to_start() {
		let mut chars = ScriptCharProvider::new("abcdef");
		chars.pos = 3; // simulate position at 'd'
		chars.retreat(5); // retreat more than current pos

		assert_eq!(chars.get_pos(), 0);
		assert_eq!(chars.current(), 'a');
	}

	#[test]
	fn test_retreat_zero() {
		let mut chars = ScriptCharProvider::new("abcdef");
		chars.pos = 2; // at 'c'
		chars.retreat(0); // retreat by 0

		assert_eq!(chars.get_pos(), 2);
		assert_eq!(chars.current(), 'c');
	}
}
}
pub mod script_line_provider {
//! Provide the script contents line by line
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	fmt,
	io::{self, BufRead, BufReader},
	path::PathBuf,
};

use crate::openfile::OpenFile;
use crate::{
	host::{ShellPaths, strip_errno},
	sed::{
		error_handling::{ScriptOrigin, SedError, SedResult},
		script_char_provider::ScriptCharProvider,
	},
};

#[derive(Debug, PartialEq)]
/// The specification of a script: through a string or a file
pub enum ScriptValue {
	StringVal(String),
	PathVal(PathBuf),
}

/// The provider of script lines across all specified scripts
/// Scripts can be specified to sed as files or as strings.
pub struct ScriptLineProvider {
	sources:         Vec<ScriptValue>,
	state:           State,
	stdin:           Option<OpenFile>,
	paths:           ShellPaths,
	/// String expressions opened so far; GNU numbers them from 1.
	expressions:     usize,
	/// GNU-style origin of the current line, kept after the scripts run out.
	origin:          ScriptOrigin,
	/// Bytes of the current string expression before the current line.
	line_start:      usize,
	/// Bytes of the current line, including its newline.
	line_len:        usize,
	/// Whether the current line ended with a newline.
	line_terminated: bool,
	/// True once every script source has been read.
	exhausted:       bool,
}

/// Encapsulation of the script line provider's state
enum State {
	NotStarted, // Processing has not yet started
	Active {
		index:       usize,
		reader:      Box<dyn BufRead>, // Object on which read_line is called
		line_number: usize,            // Current line number
	},
	Done, // All scripts have been processed
}

impl ScriptLineProvider {
	/// Construct the script provider from the specified script sources
	#[cfg(test)]
	pub fn new(sources: Vec<ScriptValue>) -> Self {
		Self::with_parts(sources, None, ShellPaths::default())
	}

	/// Constructs a provider with the builtin stdin stream.
	pub fn with_stdin(sources: Vec<ScriptValue>, stdin: OpenFile, paths: ShellPaths) -> Self {
		Self::with_parts(sources, Some(stdin), paths)
	}

	fn with_parts(sources: Vec<ScriptValue>, stdin: Option<OpenFile>, paths: ShellPaths) -> Self {
		Self {
			sources,
			state: State::NotStarted,
			stdin,
			paths,
			expressions: 0,
			origin: ScriptOrigin::default(),
			line_start: 0,
			line_len: 0,
			line_terminated: false,
			exhausted: false,
		}
	}

	/// Returns the GNU-style origin of the current script line.
	pub fn origin(&self) -> &ScriptOrigin {
		&self.origin
	}

	/// Returns GNU's `char` count at `line`: expression bytes read, counting the
	/// current character when `consumed`, or the whole expression once the
	/// scripts are exhausted.
	pub fn char_offset(&self, line: &ScriptCharProvider, consumed: bool) -> usize {
		if self.exhausted {
			return self.line_start + self.line_len;
		}
		self.line_start + line.byte_pos() + usize::from(consumed && !line.eol())
	}

	/// Returns GNU's `char` count once the current line and its newline are read.
	pub fn line_end_offset(&self) -> usize {
		self.line_start + self.line_len
	}

	/// Returns GNU's `char` count when a command's delimiter would be the
	/// newline ending the current line: the newline, plus the character after
	/// it unless that is another newline or the end of the source. `None` when
	/// the line has no newline.
	pub fn newline_delimiter_offset(&mut self) -> Option<usize> {
		if !self.line_terminated {
			return None;
		}
		let next = match &mut self.state {
			State::Active { reader, .. } => reader.fill_buf().ok().and_then(|bytes| bytes.first().copied()),
			_ => None,
		};
		Some(self.line_end_offset() + usize::from(next.is_some_and(|byte| byte != b'\n')))
	}

	/// Returns where GNU locates script errors it finds at run time: char 0 of
	/// the last expression, or the line after the last newline of the last file.
	pub fn end_origin(&self) -> String {
		match &self.origin {
			ScriptOrigin::Expression(_) => self.origin.describe(0),
			ScriptOrigin::File(name, line) => {
				ScriptOrigin::File(name.clone(), (line + usize::from(self.line_terminated)).max(1)).describe(0)
			},
		}
	}

	/// Return the currently processed script line number.
	pub fn get_line_number(&self) -> usize {
		match &self.state {
			State::Active { line_number, .. } => *line_number,
			_ => 0,
		}
	}

	/// Return the next script line to process across all scripts.
	pub fn next_line(&mut self) -> SedResult<Option<String>> {
		loop {
			let next_index = match self.state {
				State::NotStarted => 0,
				State::Active { index, .. } => {
					if let Some(line) = self.next_line_in_source()? {
						return Ok(Some(line));
					}
					index + 1
				},
				State::Done => return Ok(None),
			};
			self.advance_source(next_index)?;
		}
	}

	/// Return the next line of the current script source, or `None` at its end.
	pub fn next_line_in_source(&mut self) -> SedResult<Option<String>> {
		let State::Active { reader, line_number, .. } = &mut self.state else {
			return Ok(None);
		};
		let mut line = String::new();
		let bytes = reader.read_line(&mut line)?;
		if bytes == 0 {
			return Ok(None);
		}
		*line_number += 1;
		self.line_start += self.line_len;
		self.line_len = bytes;
		if let ScriptOrigin::File(_, file_line) = &mut self.origin {
			*file_line = *line_number;
		}
		// Remove trailing newline
		self.line_terminated = line.ends_with('\n');
		if self.line_terminated {
			line.pop();
		}
		Ok(Some(line))
	}

	// Move to the next available script source.
	fn advance_source(&mut self, next_index: usize) -> SedResult<()> {
		if next_index >= self.sources.len() {
			self.state = State::Done;
			self.exhausted = true;
			return Ok(());
		}

		self.line_start = 0;
		self.line_len = 0;
		self.line_terminated = false;
		let reader: Box<dyn BufRead> = match &self.sources[next_index] {
			ScriptValue::StringVal(s) => {
				self.expressions += 1;
				self.origin = ScriptOrigin::Expression(self.expressions);
				Box::new(BufReader::new(std::io::Cursor::new(s.clone())))
			},
			ScriptValue::PathVal(p) => {
				self.origin = ScriptOrigin::File(p.to_string_lossy().into(), 0);
				if p.as_os_str() == "-" {
					Box::new(BufReader::new(self.stdin.as_ref().expect("stdin stream missing").clone()))
				} else {
					let file = self.paths.fs().open(self.paths.resolve(p)).map_err(|e| {
						SedError::new(4, format!("couldn't open file {}: {}", p.display(), strip_errno(&e)))
					})?;
					// GNU reads a directory as an empty script.
					if file.metadata().is_ok_and(|meta| meta.is_dir()) {
						Box::new(io::empty())
					} else {
						Box::new(BufReader::new(file))
					}
				}
			},
		};
		self.state = State::Active { index: next_index, reader, line_number: 0 };

		Ok(())
	}
}

impl fmt::Debug for State {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			State::NotStarted => f.debug_struct("NotStarted").finish(),
			State::Done => f.debug_struct("Done").finish(),
			State::Active { index, line_number, .. } => f
				.debug_struct("Active")
				.field("index", index)
				.field("line_number", line_number)
				.finish_non_exhaustive(),
		}
	}
}

#[cfg(test)]
impl ScriptLineProvider {
	pub fn with_active_state(input_name: &str, line_number: usize) -> Self {
		Self {
			state: State::Active {
				line_number,
				index: 0,
				reader: Box::new(BufReader::new(std::io::Cursor::new(Vec::<u8>::new()))),
			},
			origin: ScriptOrigin::File(input_name.into(), line_number),
			..Self::with_parts(vec![], None, ShellPaths::default())
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::Write;

	use tempfile::NamedTempFile;

	use super::*;

	#[test]
	fn test_string_source() {
		let input = vec![
			ScriptValue::StringVal("line one\nline two\n".to_string()),
			ScriptValue::StringVal("line three".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec!["line one", "line two", "line three"]);
	}

	#[test]
	fn test_file_source() {
		let mut temp_file = NamedTempFile::new().unwrap();
		writeln!(temp_file, "file line 1").unwrap();
		writeln!(temp_file, "file line 2").unwrap();

		let input = vec![ScriptValue::PathVal(temp_file.path().to_path_buf())];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec!["file line 1", "file line 2"]);
	}

	#[cfg(windows)]
	#[test]
	fn test_file_source_resolves_msys_drive_alias() {
		let mut temp_file = NamedTempFile::new().unwrap();
		writeln!(temp_file, "aliased line 1").unwrap();
		writeln!(temp_file, "aliased line 2").unwrap();

		let native = temp_file.path().to_string_lossy().replace('\\', "/");
		let (drive, tail) = native
			.split_once(":/")
			.unwrap_or_else(|| panic!("expected drive-qualified temp path, got {native:?}"));
		let alias = format!("/{}/{}", drive.to_ascii_lowercase(), tail);

		let input = vec![ScriptValue::PathVal(PathBuf::from(alias))];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec!["aliased line 1", "aliased line 2"]);
	}

	#[test]
	fn test_mixed_source() {
		let mut temp_file = NamedTempFile::new().unwrap();
		writeln!(temp_file, "file line 1").unwrap();
		writeln!(temp_file, "file line 2").unwrap();
		let temp_file2 = NamedTempFile::new().unwrap();

		let input = vec![
			ScriptValue::PathVal(temp_file.path().to_path_buf()),
			ScriptValue::StringVal("script line 1".to_string()),
			ScriptValue::PathVal(temp_file.path().to_path_buf()),
			ScriptValue::StringVal(String::new()),
			ScriptValue::PathVal(temp_file2.path().to_path_buf()),
			ScriptValue::StringVal("other script line 1".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec![
			"file line 1",
			"file line 2",
			"script line 1",
			"file line 1",
			"file line 2",
			"other script line 1",
		]);
	}

	#[test]
	fn test_getters() {
		let input = vec![
			ScriptValue::StringVal("l1\nl2\n".to_string()),
			ScriptValue::StringVal("l3".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l1");
			assert_eq!(provider.get_line_number(), 1);
			assert_eq!(provider.origin(), &ScriptOrigin::Expression(1));
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l2");
			assert_eq!(provider.get_line_number(), 2);
			assert_eq!(provider.origin(), &ScriptOrigin::Expression(1));
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l3");
			assert_eq!(provider.get_line_number(), 1);
			assert_eq!(provider.origin(), &ScriptOrigin::Expression(2));
		} else {
			panic!("Expected a line");
		}
	}
}
}

use std::{collections::HashMap, ffi::OsString, io::Write, path::PathBuf};

use clap::{Arg, ArgMatches, Command, arg};

use crate::host::{Host, ShellPaths, Utility, format_usage, matches_parser};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::{
	command::{ProcessingContext, ByteSpace},
	processor::process_all_files,
	script_line_provider::ScriptValue,
};

const ABOUT: &str = "Stream editor for filtering and transforming text";
const USAGE: &str = "sed [OPTION]... [script] [file]...";

// the upstream process entry point
// (which printed help to the process stdout and called `std::process::exit`)
// is replaced by this plain function; argument parsing, the no-args help
// path, and exit-code mapping live in the crate-level `run` wrapper.
fn sed_main(matches: &ArgMatches, host: &mut Host) -> SedResult<()> {
	let (scripts, files) = get_scripts_files(matches)?;
	let mut context = build_context(matches, host.paths());

	let executable = compiler::compile_with_stdin(scripts, &mut context, host.stdin.file().clone())?;
	process_all_files(executable, files, &mut context, host)?;
	Ok(())
}

// normalize the BSD/macOS `sed -i ''` idiom before clap parsing,
// following uu-stat's `rewrite_bsd_invocation` precedent.
/// Normalize GNU's attached `-i` backup suffixes and BSD's empty backup
/// suffix. GNU sed's `-i` takes its optional suffix only when directly
/// attached, so a separate non-empty token must stay a script/file operand;
/// scanning stops at `--`.
fn normalize_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut out = Vec::with_capacity(argv.len());
	let mut iter = argv.into_iter().peekable();
	// argv[0] is the command name; never rewritten.
	if let Some(first) = iter.next() {
		out.push(first);
	}
	let mut past_separator = false;
	while let Some(arg) = iter.next() {
		if !past_separator {
			if arg == "--" {
				past_separator = true;
			} else if is_in_place_flag(&arg) && iter.peek().is_some_and(|next| next.is_empty()) {
				// BSD `-i ''` means in-place without a backup, matching GNU
				// bare `-i`; the empty token would otherwise become SCRIPT.
				out.push(arg);
				iter.next();
				continue;
			} else if let Some(s) = arg.to_str()
				&& let Some(suffix) = s.strip_prefix("-i")
				&& !suffix.is_empty()
				&& !suffix.starts_with('=')
			{
				out.push(format!("-i={suffix}").into());
				continue;
			}
		}
		out.push(arg);
	}
	out
}

/// Whether `arg` is a clap-supported short-flag cluster ending in `-i`.
fn is_in_place_flag(arg: &OsString) -> bool {
	let Some(cluster) = arg.to_str().and_then(|arg| arg.strip_prefix('-')) else {
		return false;
	};
	let Some(prefix) = cluster.strip_suffix('i') else {
		return false;
	};

	!cluster.is_empty()
		&& !cluster.starts_with('-')
		&& prefix
			.chars()
			.all(|flag| matches!(flag, 'a' | 'E' | 'r' | 'n' | 's' | 'u' | 'z'))
}

#[allow(clippy::cognitive_complexity)]
fn uu_app() -> Command {
	let util_name = "sed";

	Command::new(util_name)
		.version("0.1.1")
		.about(ABOUT)
		.override_usage(format_usage(USAGE))
		.args_override_self(true)
		.infer_long_args(true)
		.args([
			arg!([script] "Script to execute if not otherwise provided."),
			Arg::new("file")
				.help("Input files")
				.value_parser(clap::value_parser!(PathBuf))
				.num_args(0..),
			Arg::new("all-output-files")
				.long("all-output-files")
				.short('a')
				.help("Create or truncate all output files before processing.")
				.action(clap::ArgAction::SetTrue),
			arg!(--debug "Annotate program execution."),
			Arg::new("regexp-extended")
				.short('E')
				.long("regexp-extended")
				.short_alias('r')
				.help("Use extended regular expressions.")
				.action(clap::ArgAction::SetTrue),
			arg!(-e --expression <SCRIPT> "Add script to executed commands.")
				.action(clap::ArgAction::Append),
			// Access with .get_many::<PathBuf>("file")
			Arg::new("script-file")
				.short('f')
				.long("script-file")
				.help("Specify script file.")
				.value_parser(clap::value_parser!(PathBuf))
				.action(clap::ArgAction::Append),
			Arg::new("follow-symlinks")
				.long("follow-symlinks")
				.help("Follow symlinks when processing in place.")
				.action(clap::ArgAction::SetTrue),
			// Access with .get_one::<String>("in-place")
			Arg::new("in-place")
				.short('i')
				.long("in-place")
				.help("Edit files in place, making a backup if SUFFIX is supplied.")
				.num_args(0..=1)
				// Patched: GNU sed only accepts the backup suffix attached
				// (`-i.bak`, `--in-place=.bak`); without this clap would eat
				// the following script/file operand as the suffix.
				.require_equals(true)
				.default_missing_value(""),
			// Access with .get_one::<u32>("line-length")
			arg!(-l --length <NUM> "Specify the 'l' command line-wrap length.")
				.value_parser(clap::value_parser!(u32)),
			arg!(-n --quiet "Suppress automatic printing of pattern space.").aliases(["silent"]),
			arg!(--posix "Disable non-POSIX extensions."),
			arg!(-s --separate "Consider files as separate rather than as a long stream."),
			arg!(--sandbox "Operate in a sandbox by disabling e/r/w commands."),
			arg!(-u --unbuffered "Load minimal input data and flush output buffers regularly."),
			Arg::new("null-data")
				.short('z')
				.long("null-data")
				.help("Separate lines by NUL characters.")
				.action(clap::ArgAction::SetTrue),
		])
}

// Iterate through script and file arguments specified in matches and
// return vectors of all scripts and input files in the specified order.
// If no script is specified fail with "missing script" error.
fn get_scripts_files(matches: &ArgMatches) -> SedResult<(Vec<ScriptValue>, Vec<PathBuf>)> {
	let mut indexed_scripts: Vec<(usize, ScriptValue)> = Vec::new();
	let mut files: Vec<PathBuf> = Vec::new();

	let script_through_options =
        // The specification of a script: through a string or a file.
        matches.contains_id("expression") || matches.contains_id("script-file");

	if script_through_options {
		// Second and third POSIX usage cases; clap script arg is actually an input file
		// sed [-En] -e script [-e script]... [-f script_file]... [file...]
		// sed [-En] [-e script]... -f script_file [-f script_file]... [file...]
		if let Some(val) = matches.get_one::<String>("script") {
			files.push(PathBuf::from(val.to_owned()));
		}
	} else {
		// First POSIX spec usage case; script is the first arg.
		// sed [-En] script [file...]
		if let Some(val) = matches.get_one::<String>("script") {
			indexed_scripts.push((0, ScriptValue::StringVal(val.to_owned())));
		} else {
			return Err(SedError::new(1, "missing script"));
		}
	}

	// Capture -e occurrences (STRING)
	if let Some(indices) = matches.indices_of("expression") {
		for (idx, val) in indices.zip(matches.get_many::<String>("expression").unwrap_or_default()) {
			indexed_scripts.push((idx, ScriptValue::StringVal(val.to_owned())));
		}
	}

	// Capture -f occurrences (FILE)
	if let Some(indices) = matches.indices_of("script-file") {
		for (idx, val) in indices.zip(
			matches
				.get_many::<PathBuf>("script-file")
				.unwrap_or_default(),
		) {
			indexed_scripts.push((idx, ScriptValue::PathVal(val.to_owned())));
		}
	}

	// Sort by index to preserve argument order.
	indexed_scripts.sort_by_key(|k| k.0);
	// Keep only the values.
	let scripts = indexed_scripts
		.into_iter()
		.map(|(_, value)| value)
		.collect();

	let rest_files: Vec<PathBuf> = matches
		.get_many::<PathBuf>("file")
		.unwrap_or_default()
		.cloned()
		.collect();
	if !rest_files.is_empty() {
		files.extend(rest_files);
	}

	// Read from stdin if no file has been specified.
	if files.is_empty() {
		files.push(PathBuf::from("-"));
	}

	Ok((scripts, files))
}

// Parse CLI flag arguments and return a ProcessingContext struct based on them
fn build_context(matches: &ArgMatches, paths: &ShellPaths) -> ProcessingContext {
	ProcessingContext {
		all_output_files: matches.get_flag("all-output-files"),
		debug:            matches.get_flag("debug"),
		regex_extended:   matches.get_flag("regexp-extended"),
		follow_symlinks:  matches.get_flag("follow-symlinks"),
		in_place:         matches.contains_id("in-place"),
		in_place_suffix:  matches
			.get_one::<String>("in-place")
			.and_then(|s| if s.is_empty() { None } else { Some(s.clone()) }),
		length:           matches.get_one::<u32>("length").map_or(70, |v| *v as usize),
		quiet:            matches.get_flag("quiet"),
		posix:            matches.get_flag("posix"),
		separate:         matches.get_flag("separate"),
		sandbox:          matches.get_flag("sandbox"),
		unbuffered:       matches.get_flag("unbuffered"),
		null_data:        matches.get_flag("null-data"),
		paths:            paths.clone(),

		// Other context
		script_end:           String::new(),
		input_name:           PathBuf::from("-"),
		line_number:          0,
		last_address:         false,
		last_line:            false,
		last_file:            false,
		stop_processing:      false,
		saved_regex:          None,
		saved_regex_from_address: false,
		looked_past_input:    false,
		input_action:         None,
		hold:                 ByteSpace { content: Vec::new(), terminated: true },
		parsed_block_nesting: 0,
		label_to_command_map: HashMap::new(),
		range_commands:       Vec::new(),
		substitution_made:    false,
		append_elements:      Vec::new(),
		line_sources:         HashMap::new(),
	}
}


/// Parsed `sed` invocation.
pub(crate) struct Sed {
	matches: ArgMatches,
}

matches_parser!(Sed, uu_app);

impl Utility for Sed {
	const NAME: &'static str = "sed";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(normalize_args(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		named_writer::reset();
		if !self.matches.args_present() {
			let _ = write!(host.stdout, "{}", uu_app().render_help());
			return 1;
		}
		match sed_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				let code = error.code();
				host.error(error, if code == 0 { 1 } else { code });
				host.exit_code()
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*; // Allows access to private functions/items in this module

	// get_scripts_files

	// Helper function for supplying arguments
	fn get_test_matches(args: &[&str]) -> ArgMatches {
		uu_app()
			.try_get_matches_from(["myapp"].iter().chain(args.iter()))
			.expect("test args parse")
	}

	#[test]
	fn test_script_as_first_argument() {
		let matches = get_test_matches(&["1d", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("1d".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_expression_argument() {
		let matches = get_test_matches(&["-e", "s/foo/bar/", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_script_file_argument() {
		let matches = get_test_matches(&["-f", "script.sed", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::PathVal(PathBuf::from("script.sed"))]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_multiple_files() {
		let matches = get_test_matches(&["-e", "s/foo/bar/", "file1.txt", "file2.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt"), PathBuf::from("file2.txt")]);
	}

	#[test]
	fn test_multiple_files_script() {
		let matches = get_test_matches(&["s/foo/bar/", "file1.txt", "file2.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt"), PathBuf::from("file2.txt")]);
	}

	#[test]
	fn test_stdin_when_no_files() {
		let matches = get_test_matches(&["-e", "s/foo/bar/"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("-")]); // Stdin should be used
	}

	#[test]
	fn test_stdin_when_no_files_script() {
		let matches = get_test_matches(&["s/foo/bar/"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("-")]); // Stdin should be used
	}

	// build_context
	fn test_matches(args: &[&str]) -> ArgMatches {
		let argv = normalize_args(
			["sed"]
				.into_iter()
				.chain(args.iter().copied())
				.map(std::ffi::OsString::from)
				.collect(),
		);
		uu_app()
			.try_get_matches_from(argv)
			.expect("test args parse")
	}

	#[test]
	fn test_defaults() {
		let matches = test_matches(&[]);
		let ctx = build_context(&matches, &ShellPaths::default());

		assert!(!ctx.all_output_files);
		assert!(!ctx.debug);
		assert!(!ctx.regex_extended);
		assert!(!ctx.follow_symlinks);
		assert!(!ctx.in_place);
		assert_eq!(ctx.in_place_suffix, None);
		assert_eq!(ctx.length, 70);
		assert!(!ctx.quiet);
		assert!(!ctx.posix);
		assert!(!ctx.separate);
		assert!(!ctx.sandbox);
		assert!(!ctx.unbuffered);
		assert!(!ctx.null_data);
	}

	#[test]
	fn test_all_flags() {
		let matches = test_matches(&[
			"--all-output-files",
			"--debug",
			"-E",
			"--follow-symlinks",
			"-i",
			"-l",
			"80",
			"-n",
			"--posix",
			"-s",
			"--sandbox",
			"-u",
			"-z",
		]);

		let ctx = build_context(&matches, &ShellPaths::default());

		assert!(ctx.all_output_files);
		assert!(ctx.debug);
		assert!(ctx.regex_extended);
		assert!(ctx.follow_symlinks);
		assert!(ctx.in_place);
		assert!(ctx.in_place_suffix.is_none());
		assert_eq!(ctx.length, 80);
		assert!(ctx.quiet);
		assert!(ctx.posix);
		assert!(ctx.separate);
		assert!(ctx.sandbox);
		assert!(ctx.unbuffered);
		assert!(ctx.null_data);
	}

	#[test]
	fn test_multiple_same_arguments() {
		let matches = test_matches(&["-E", "-r"]);
		let ctx = build_context(&matches, &ShellPaths::default());

		assert!(ctx.regex_extended);
	}

	#[test]
	fn test_in_place_with_suffix() {
		let matches = test_matches(&["-i.bak"]);
		let ctx = build_context(&matches, &ShellPaths::default());

		assert!(ctx.in_place);
		assert_eq!(ctx.in_place_suffix, Some(".bak".to_string()));
	}

	#[test]
	fn test_bsd_empty_in_place_suffix_with_short_flag_cluster() {
		// clap accepts `-Ei` as `-E -i`, so the BSD empty suffix must be
		// removed from this valid GNU flag cluster as well.
		let matches = test_matches(&["-Ei", "", "s/x/y/", "file.txt"]);
		let ctx = build_context(&matches, &ShellPaths::default());

		assert!(ctx.regex_extended);
		assert!(ctx.in_place);
		assert_eq!(ctx.in_place_suffix, None);
		let (scripts, files) = get_scripts_files(&matches).expect("BSD invocation parses");
		assert_eq!(scripts, vec![ScriptValue::StringVal("s/x/y/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file.txt")]);
	}

	#[test]
	fn test_nonempty_token_after_in_place_is_not_consumed() {
		let argv = ["sed", "-i", ".bak", "s/x/y/", "file.txt"]
			.into_iter()
			.map(std::ffi::OsString::from)
			.collect();
		let actual = normalize_args(argv);
		let expected = ["sed", "-i", ".bak", "s/x/y/", "file.txt"]
			.into_iter()
			.map(std::ffi::OsString::from)
			.collect::<Vec<_>>();

		assert_eq!(actual, expected);
	}

	#[test]
	fn test_length_default_and_custom() {
		let matches_default = test_matches(&[]);
		let matches_custom = test_matches(&["-l", "120"]);

		let ctx_default = build_context(&matches_default, &ShellPaths::default());
		let ctx_custom = build_context(&matches_custom, &ShellPaths::default());

		assert_eq!(ctx_default.length, 70);
		assert_eq!(ctx_custom.length, 120);
	}

	#[test]
	fn builtin_substitutes_stdin() {
		let (code, capture) = crate::host::run_util::<Sed>(&["s/hello/world/"], "hello\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "world\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn builtin_processes_invalid_utf8_streams_without_reencoding() {
		let input = b"ab\xffcd\n";
		for (args, stdin, expected) in [
			(&[""][..], &input[..], &input[..]),
			(&["-n", "1,12p"], &b"ab\xff\ncd\xfe"[..], &b"ab\xff\ncd\xfe"[..]),
			(&["s/a/X/"], &input[..], &b"Xb\xffcd\n"[..]),
			(&["s/[bc]/X/g"], &input[..], &b"aX\xffXd\n"[..]),
			(&[r"s/\(.\)c/\1X/"], &input[..], &b"ab\xffXd\n"[..]),
			// A byte that is no UTF-8 character is copied as it is: `\U` goes
			// on past it, and a `\u` before it changes nothing.
			(&[r"s/\(.\)c/\U\1x/"], &input[..], &b"ab\xffXd\n"[..]),
			(&[r"s/\(.\)c/\u\1x/"], &input[..], &b"ab\xffxd\n"[..]),
			(&[r"s/\(.\)\1/X/g"], &b"a\xff\xffb\n"[..], &b"aXb\n"[..]),
			(&["-n", "/c/p"], &input[..], &input[..]),
			(&["-n", "/.cd/p"], &input[..], &input[..]),
			(&["s/./X/g"], &input[..], &b"XXXXX\n"[..]),
			(&["s/./X/g"], "é🙂\n".as_bytes(), &b"XX\n"[..]),
			(&["s/./X/g"], &b"\xc3\xa9\xff\n"[..], &b"XXX\n"[..]),
			(&["y/ad/XY/"], &input[..], &b"Xb\xffcY\n"[..]),
			(&["-n", "l"], &b"ab\xff\t\\cd\x00\xfe\n"[..], &b"ab\\377\\t\\\\cd\\000\\376$\n"[..]),
			(&["-n", "h;z;g;N;P"], &b"ab\xff\ncd\xfe\n"[..], &b"ab\xff\n"[..]),
		] {
			let (mut host, capture) = Host::for_test("sed", stdin, "/");
			let status = Sed { matches: test_matches(args) }.run(&mut host);
			assert_eq!(status, 0, "{args:?}: {}", capture.err());
			assert_eq!(capture.stdout(), expected, "{args:?}");
			assert!(capture.stderr().is_empty(), "{args:?}: {}", capture.err());
		}
	}

	#[test]
	fn builtin_edits_invalid_utf8_in_place() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("input");
		std::fs::write(&path, b"ab\xffcd\nno\xfe match").unwrap();
		let (code, capture) = crate::host::run_util::<Sed>(
			&["-i", "s/[ac]/X/g", "input"], "", dir.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		assert!(capture.stdout().is_empty());
		assert_eq!(std::fs::read(path).unwrap(), b"Xb\xffXd\nno\xfe mXtXh");
	}

	#[test]
	fn builtin_substitutes_literal_posix_bracket_members() {
		for (script, expected) in [
			(r"s/[][\.^$*+?(){}|\\]/_/g", "a_b_c_\n"),
			(r"s/[.^$*+?()[{|\\]/_/g", "a_b_c]\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&["-E", script], "a.b[c]\n", "/");
			assert_eq!((code, capture.out().as_str(), capture.err().as_str()), (0, expected, ""), "{script}");
		}
	}

	#[test]
	fn builtin_substitutes_only_plus_prefixed_lines() {
		// THE OBSERVABLE DEFECT this change exists for, covered end to end:
		// argument parsing, BRE compilation and substitution together.
		// `s/^\+/PLUS/` used to rewrite the start of EVERY line, because
		// `\+` became `+` unconditionally and `^+` compiles as `(?:^)+`.
		let input = "alpha\n+added\n-removed\n context\n+another\n";
		let (code, capture) =
			crate::host::run_util::<Sed>(&[r"s/^\+/PLUS/"], input, "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "alpha\nPLUSadded\n-removed\n context\nPLUSanother\n");
		assert_eq!(capture.err(), "");
	}

	// Failure: `s/a**/X/` and friends were accepted; GNU sed refuses a `*` or
	// interval stacked on another repetition. A following `\?`/`\+` stays legal.
	#[test]
	fn builtin_rejects_stacked_repetition() {
		for (script, char) in [
			(r"s/a**/X/", 8),
			(r"s/a*\{2\}/X/", 12),
			(r"s/a\+*/X/", 9),
			(r"s/a\?\{2\}/X/", 13),
			(r"s/\(a\)**/X/", 12),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "aaab\n", "/");
			assert_eq!(code, 1, "{script}");
			assert_eq!(
				capture.err(),
				format!("sed: -e expression #1, char {char}: Invalid preceding regular expression\n"),
				"{script}"
			);
		}
		for (script, out) in [(r"s/a*\?/X/", "Xb\n"), (r"s/a*\+/X/", "Xb\n"), ("s/^**/X/", "Xaaab\n")] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "aaab\n", "/");
			assert_eq!((code, capture.out().as_str()), (0, out), "{script}");
		}
	}

	// Failure: a newline as the `s`/`y` delimiter was located at the command
	// letter (char 1); GNU counts the newline and the character after it.
	#[test]
	fn builtin_locates_a_newline_delimiter_like_gnu() {
		for (script, location) in [
			("s\na\nb\n", "char 3: unterminated `s'"),
			("y\na\nb\n", "char 3: unterminated `y'"),
			("1s\na\nb\n", "char 4: unterminated `s'"),
			("s\n", "char 2: unterminated `s'"),
			("s\n\n", "char 2: unterminated `s'"),
			("s", "char 1: unterminated `s'"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "a\n", "/");
			assert_eq!(code, 1, "{script:?}");
			assert_eq!(capture.err(), format!("sed: -e expression #1, {location} command\n"), "{script:?}");
		}
	}

	// Failure: `-f DIR` failed with "Is a directory"; GNU reads it as an
	// empty script.
	#[test]
	fn builtin_reads_a_directory_script_as_empty() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::create_dir(dir.path().join("d")).unwrap();
		let (code, capture) = crate::host::run_util::<Sed>(&["-f", "d", "-e", "p"], "a\n", dir.path());
		assert_eq!((code, capture.out().as_str(), capture.err().as_str()), (0, "a\na\n", ""));
	}

	// Failure: under `M`, `[^x]` matched the newline between lines, so
	// `N;s/[^x]*/X/M` replaced both lines instead of the first.
	#[test]
	fn builtin_multiline_negated_class_stops_at_newline() {
		for (script, out) in [
			("N;s/[^x]*/X/M", "X\nb\n"),
			("N;s/a[^x]b/X/M", "a\nb\n"),
			("N;s/a[^x]b/X/", "X\n"),
			("N;s/[^]x]*$/X/M", "X\nb\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "a\nb\n", "/");
			assert_eq!((code, capture.out().as_str()), (0, out), "{script}");
		}
	}

	#[test]
	fn builtin_rejects_a_brace_quantifier_with_no_operand() {
		// Real sed refuses this. Emitting the operator gave `^{1,3}`, which
		// fancy-regex accepts and matches at every line start.
		let (code, capture) =
			crate::host::run_util::<Sed>(&[r"s/^\{1,3\}/X/"], "alpha\n+added\n", "/");
		assert_eq!(code, 1, "must not substitute: {:?}", capture.out());
		assert_eq!(
			capture.err(),
			"sed: -e expression #1, char 13: Invalid preceding regular expression\n"
		);
	}

	#[test]
	fn builtin_treats_only_the_first_caret_of_a_branch_as_an_anchor() {
		// Measured: `sed 's/^^/X/'` rewrites only lines that begin with a
		// literal caret, consuming one of them.
		let (code, capture) = crate::host::run_util::<Sed>(&["s/^^/X/"], "^a\naaa\n^^b\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "Xa\naaa\nX^b\n");
	}

	#[test]
	fn builtin_propagates_q_status() {
		let (code, capture) = crate::host::run_util::<Sed>(&["2q42"], "one\ntwo\nthree\n", "/");
		assert_eq!(code, 42);
		assert_eq!(capture.out(), "one\ntwo\n");
	}

	#[test]
	fn builtin_group_closing_brace_terminates_commands() {
		let swap = "1{h;d};2{G}";
		for args in [&[swap][..], &["--posix", swap][..]] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "one\ntwo\nthree\n", "/");
			assert_eq!(code, 0, "{}", capture.err());
			assert_eq!(capture.out(), "two\none\nthree\n");
		}

		// The first two escaped braces belong to the delimited arguments;
		// only the final two unescaped braces after g close groups.
		let nested = r"1{1{s}\}}x\}}g}};y/x/X/";
		let (code, capture) = crate::host::run_util::<Sed>(&[nested], "}}\nx\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "X}X}\nX\n");

		let (code, capture) = crate::host::run_util::<Sed>(&["1{a text }\n}"], "one\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "one\ntext }\n");
	}

	#[test]
	fn builtin_group_ending_in_substitution_edits_file() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("input");
		std::fs::write(&path, "skip\none\ntwo\nend\n").unwrap();
		let (code, capture) = crate::host::run_util::<Sed>(
			&["-i", r"2{N;s/\n/ /}", "input"],
			"",
			dir.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "");
		assert_eq!(std::fs::read_to_string(path).unwrap(), "skip\none two\nend\n");
	}

	#[test]
	fn builtin_group_ending_rejects_invalid_syntax() {
		for script in ["1{dX}", "1{s/x/y/gX}", "1{p}p", "1{s/x/y/}}", "1{p"] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "x\n", "/");
			assert_ne!(code, 0, "{script}");
			assert_eq!(capture.out(), "", "{script}");
		}
	}

	#[test]
	fn builtin_carries_pattern_and_hold_space_across_cycles() {
		// `:a;N;$!ba` grows the pattern space by one line per cycle; each `N`
		// must carry everything accumulated so far, for stdin and for file
		// input (an in-memory snapshot on unix).
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("in.txt"), "one\ntwo\nthree\n").unwrap();
		let join = r":a;N;$!ba;s/\n/,/g";
		for (args, stdin) in [(&[join][..], "one\ntwo\nthree\n"), (&[join, "in.txt"][..], "")] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, dir.path());
			assert_eq!(code, 0, "{}", capture.err());
			assert_eq!(capture.out(), "one,two,three\n", "{args:?}");
		}
		// `N` with no next line prints the pending pattern space (GNU).
		let (code, capture) = crate::host::run_util::<Sed>(&[r"N;s/\n/+/"], "a\nb\nc\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "a+b\nc\n");
		// `1!G;h;$!d` reverses the input through the hold space.
		let (code, capture) = crate::host::run_util::<Sed>(&["1!G;h;$!d"], "a\nb\nc\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "c\nb\na\n");
	}

	#[test]
	fn builtin_matches_word_boundaries_in_regexes() {
		// `\b` is a word boundary in substitutions and addresses, BRE and ERE alike.
		let (code, capture) =
			crate::host::run_util::<Sed>(&[r"s/\bfoo\b/bar/g"], "foo foobar barfoo foo\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "bar foobar barfoo bar\n");
		let (code, capture) =
			crate::host::run_util::<Sed>(&["-E", r"/\bfoo\b/d"], "foobar\nfoo\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "foobar\n");
	}

	#[test]
	fn builtin_supports_null_records() {
		// Without NUL input splitting only the first record gets a prefix.
		let dir = tempfile::tempdir().unwrap();
		let input = "\0a\0b";
		std::fs::write(dir.path().join("input"), input).unwrap();
		for (args, stdin) in [
			(&["-z", "s/^/>/"][..], input),
			(&["-z", "s/^/>/", "input"][..], ""),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, dir.path());
			assert_eq!(code, 0, "{}", capture.err());
			assert_eq!(capture.stdout(), b">\0>a\0>b", "{args:?}");
		}

		// Newlines inside the one unterminated record are available to the script.
		let (code, capture) =
			crate::host::run_util::<Sed>(&["-z", r"s/\n/,/g"], "1\n2\n3\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.stdout(), b"1,2,3,");
	}

	#[test]
	fn builtin_null_record_commands_use_the_record_separator() {
		// Embedded newlines must not split pattern spaces, and generated output
		// must not append a newline (except for the raw text of `a`).
		for (script, expected) in [
			("N;s/^/>/", ">a\nA\0b\0tail"),
			("N;P;D", "a\nA\0b\0tail"),
			("=", concat!("1\0a\nA\0", "2\0b\0", "3\0tail")),
			("l", "a\\nA$\0a\nA\0b$\0b\0tail$\0tail"),
			("N;l", "a\\nA\\000b$\0a\nA\0b\0tail"),
			("$s/^/last:/", "a\nA\0b\0last:tail"),
			("G", "a\nA\0\0b\0\0tail\0\0"),
			("h;G", "a\nA\0a\nA\0b\0b\0tail\0tail"),
			("i before", "before\0a\nA\0before\0b\0before\0tail"),
			("a after", "a\nA\0after\nb\0after\ntail\0after\n"),
			("c changed", "changed\0changed\0changed\0"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&["-z", script], "a\nA\0b\0tail", "/");
			assert_eq!(code, 0, "{script}: {}", capture.err());
			assert_eq!(capture.stdout(), expected.as_bytes(), "{script}");
		}
	}

	#[test]
	fn l_lists_the_bytes_of_a_character_in_octal() {
		// As in GNU sed 4.9, in the C and the C.UTF-8 locale alike, `l` lists
		// each byte of a character of several bytes as an octal escape, and a
		// newline of the pattern space as `\n`. Folding parts the escapes but
		// splits none, ends each piece with the record separator, and a width
		// of 0 folds nothing.
		for (args, stdin, expected) in [
			(&["-n", "l"][..], "café ok\n", "caf\\303\\251 ok$\n"),
			(&["-n", "l"], "\u{1f980}\n", "\\360\\237\\246\\200$\n"),
			(&["-n", "l 5"], "café ok\n", "caf\\\n\\303\\\n\\251\\\n ok$\n"),
			(&["-n", "l 0"], "café\n", "caf\\303\\251$\n"),
			(&["-n", "N;l"], "x\ny\n", "x\\ny$\n"),
			(&["-zn", "l 2"], "abc\0", "a\\\0b\\\0c$\0"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, "/");
			assert_eq!(
				(code, capture.stdout().as_slice()),
				(0, expected.as_bytes()),
				"{args:?}: {}",
				capture.err()
			);
		}
	}

	#[test]
	fn builtin_edits_relative_path_in_place() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("file.txt"), "x marks\n").unwrap();
		let (code, capture) = crate::host::run_util::<Sed>(
			&["-i", "s/x marks/y marks/", "file.txt"],
			"",
			dir.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(std::fs::read_to_string(dir.path().join("file.txt")).unwrap(), "y marks\n");
	}


	#[test]
	fn builtin_resolves_script_and_write_paths() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("script.sed"), "w output.txt\n").unwrap();
		let (code, capture) =
			crate::host::run_util::<Sed>(&["-n", "-f", "script.sed"], "saved\n", dir.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(std::fs::read(dir.path().join("output.txt")).unwrap(), b"saved\n");
	}

	#[test]
	fn builtin_reports_unreadable_input_and_continues() {
		// GNU names the file with `can't read`, edits the rest, exits 2, and
		// still finds the last line in a file followed only by unreadable ones.
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("f1"), "a\n").unwrap();
		for (args, expected) in
			[(&["p", "missing", "f1"][..], "a\na\n"), (&["-n", "$p", "f1", "missing"][..], "a\n")]
		{
			let (code, capture) = crate::host::run_util::<Sed>(args, "", dir.path());
			assert_eq!(code, 2, "{args:?}");
			assert_eq!(capture.out(), expected, "{args:?}");
			assert_eq!(capture.err(), "sed: can't read missing: No such file or directory\n", "{args:?}");
		}
	}

	#[test]
	fn builtin_reports_script_errors_in_gnu_format() {
		// Scripts written against GNU sed are debugged from these locations:
		// the expression number and the byte GNU had read, or the -f file line.
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("bad.sed"), "s/a/b/\np\ns/a\n").unwrap();
		for (args, expected) in [
			(&["s/a"][..], "-e expression #1, char 3: unterminated `s' command"),
			(&["-e", "p", "-e", "s/a/b/q"][..], "-e expression #2, char 7: unknown option to `s'"),
			(&["p;k"][..], "-e expression #1, char 3: unknown command: `k'"),
			(&["1,2q"][..], "-e expression #1, char 4: command only uses one address"),
			(&["p\n\ns/é"][..], "-e expression #1, char 7: unterminated `s' command"),
			(&["-e", "p", "-e", "1{p"][..], "-e expression #2, char 0: unmatched `{'"),
			(&["s/a\\{1/x/g;p"][..], "-e expression #1, char 11: Unmatched \\{"),
			(&["/a\\{1/p"][..], "-e expression #1, char 6: Unmatched \\{"),
			(&["-f", "bad.sed"][..], "file bad.sed line 3: unterminated `s' command"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "x\n", dir.path());
			assert_eq!((code, capture.err()), (1, format!("sed: {expected}\n")), "{args:?}");
			assert_eq!(capture.out(), "", "{args:?}");
		}

		let (code, capture) = crate::host::run_util::<Sed>(&["b foo"], "x\n", "/");
		assert_eq!((code, capture.err().as_str()), (4, "sed: can't find label for jump to `foo'\n"));
	}

	#[test]
	fn builtin_executes_e_commands() {
		// GNU `e command` prints the output as-is before the cycle's output;
		// bare `e` runs the pattern space and replaces it, minus one newline.
		for (script, stdin, expected) in [
			("1e echo run", "x\n", "run\nx\n"),
			("e printf nonl", "x\n", "nonlx\n"),
			("e", "echo hi\n", "hi\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], stdin, "/");
			assert_eq!((code, capture.out().as_str()), (0, expected), "{script}: {}", capture.err());
		}

		let (code, capture) = crate::host::run_util::<Sed>(&["--sandbox", "e"], "x\n", "/");
		assert_eq!(
			(code, capture.err().as_str()),
			(1, "sed: -e expression #1, char 1: e/r/w commands disabled in sandbox mode\n")
		);
	}

	#[test]
	fn builtin_appends_one_line_per_r_command() {
		// GNU `R` queues the next line of a file kept open across cycles and
		// files; commands naming the same file share it, and EOF queues nothing.
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("r"), "L1\nL2\n").unwrap();
		for (args, stdin, expected) in [
			(&["R /dev/stdin", "r"][..], "1\n2\n", "L1\n1\nL2\n2\n"),
			(&["R r\nR r"][..], "1\n2\n", "1\nL1\nL2\n2\n"),
			(&["R r", "-", "r"][..], "1\n2\n3\n", "1\nL1\n2\nL2\n3\nL1\nL2\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, dir.path());
			assert_eq!((code, capture.out().as_str()), (0, expected), "{args:?}: {}", capture.err());
		}
	}

	#[test]
	fn builtin_substitutes_from_the_nth_match_with_ng() {
		// GNU `s///Ng` replaces the Nth match and every one after it.
		let (code, capture) = crate::host::run_util::<Sed>(&["s/x/y/2g"], "x x x x\n", "/");
		assert_eq!((code, capture.out().as_str()), (0, "x y y y\n"), "{}", capture.err());
	}

	#[test]
	fn builtin_substitutes_empty_matches_around_multibyte_characters() {
		let (code, capture) = crate::host::run_util::<Sed>(&["s/ */_/g"], "café au lait\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "_c_a_f_é_a_u_l_a_i_t_\n");
		let (code, capture) = crate::host::run_util::<Sed>(&["s/x*/-/2"], "éa\n", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "é-a\n");
	}

	#[test]
	fn builtin_reports_regex_errors_in_glibc_wording() {
		// Scripts written for GNU sed are debugged from glibc's regex messages and
		// GNU's char positions, not the engine's own error text.
		for (args, expected) in [
			(&[r"s/\(a/b/"][..], r"char 8: Unmatched ( or \("),
			(&[r"s/a\)/b/"][..], r"char 8: Unmatched ) or \)"),
			(&[r"s/a\{1/b/"][..], r"char 9: Unmatched \{"),
			(&[r"s/\{1\}/b/"][..], "char 10: Invalid preceding regular expression"),
			(&[r"s/a\{x\}/b/"][..], r"char 11: Invalid content of \{\}"),
			(&[r"s/a\{99999\}/b/"][..], "char 15: Regular expression too big"),
			(&["s/[b-a]/b/"][..], "char 10: Invalid range end"),
			(&[r"s/\(a\)\2/b/"][..], "char 12: Invalid back reference"),
			(&["s/[[:foo:]]/b/"][..], "char 14: Invalid character class name"),
			(&["s/[[.ab.]]/b/"][..], "char 13: Invalid collation character"),
			(&[r"s/a\(\)/\2/"][..], r"char 11: invalid reference \2 on `s' command's RHS"),
			(&["-E", "s/(a/b/"][..], r"char 7: Unmatched ( or \("),
			(&["-E", "s/a)/b/"][..], r"char 7: Unmatched ) or \)"),
			(&["-E", "s/a{1/b/"][..], r"char 8: Unmatched \{"),
			(&["-E", "s/*a/b/"][..], "char 7: Invalid preceding regular expression"),
			(&["-E", "s/a|*b/x/"][..], "char 9: Invalid preceding regular expression"),
			(&["-E", "s/a{x}/b/"][..], r"char 9: Invalid content of \{\}"),
			(&["-E", r"s/(a)\2/b/"][..], "char 10: Invalid back reference"),
			(&["-E", r"s/a(b)/\2/"][..], r"char 10: invalid reference \2 on `s' command's RHS"),
			(&["-n", r"/\(a/Ip"][..], r"char 6: Unmatched ( or \("),
			(&["-n", r"/x/,/\(a/Mp"][..], r"char 10: Unmatched ( or \("),
			(&[r"1{s/\(a/b/}"][..], r"char 10: Unmatched ( or \("),
			(&[r"s/\(a/b/g ; p"][..], r"char 11: Unmatched ( or \("),
			(&["s/\\(a/b/\np"][..], r"char 9: Unmatched ( or \("),
			(&["s//x/I;p"][..], "char 7: cannot specify modifiers on empty regexp"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "x\n", "/");
			assert_eq!(
				(code, capture.err()),
				(1, format!("sed: -e expression #1, {expected}\n")),
				"{args:?}"
			);
			assert_eq!(capture.out(), "", "{args:?}");
		}
	}

	#[test]
	fn builtin_writes_the_first_line_with_w_upper() {
		// `W` wrote nothing: GNU writes the pattern space up to its first
		// newline, sharing the file `w` opened for the same name.
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) =
			crate::host::run_util::<Sed>(&["-n", "N;W out\nw out"], "a\nb\nc\n", dir.path());
		assert_eq!((code, capture.err().as_str()), (0, ""));
		assert_eq!(std::fs::read(dir.path().join("out")).unwrap(), b"a\na\nb\n");

		for (args, stdin, expected) in [
			(&["-n", "N;W /dev/stdout"][..], "a\nb", &b"a\n"[..]),
			(&["-n", "W /dev/stdout"][..], "aa", &b"aa"[..]),
			(&["-z", "-n", "N;W /dev/stdout"][..], "a\0b\nc\0", &b"a\0"[..]),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, "/");
			assert_eq!(code, 0, "{args:?}: {}", capture.err());
			assert_eq!(capture.stdout(), expected, "{args:?}");
		}

		let (code, capture) = crate::host::run_util::<Sed>(&["--posix", "W x"], "a\n", "/");
		assert_eq!(
			(code, capture.err().as_str()),
			(1, "sed: -e expression #1, char 1: unknown command: `W'\n")
		);
	}

	#[test]
	fn builtin_prints_the_input_file_name_with_f_upper() {
		// `F` was an unknown command; GNU prints the operand, `-` for stdin.
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("f1"), "a\n").unwrap();
		let (code, capture) = crate::host::run_util::<Sed>(&["F", "f1", "-"], "x\n", dir.path());
		assert_eq!((code, capture.out().as_str()), (0, "f1\na\n-\nx\n"), "{}", capture.err());

		let (code, capture) = crate::host::run_util::<Sed>(&["-z", "F"], "x\n", "/");
		assert_eq!((code, capture.stdout()), (0, b"-\0x\n".to_vec()), "{}", capture.err());

		let (code, capture) = crate::host::run_util::<Sed>(&["--posix", "F"], "x\n", "/");
		assert_eq!(
			(code, capture.err().as_str()),
			(1, "sed: -e expression #1, char 1: unknown command: `F'\n")
		);
	}

	#[test]
	fn builtin_matches_embedded_lines_with_the_m_flag() {
		// Without `M`, `^`/`$` only matched at the ends of a multiline pattern
		// space, and addresses rejected the flag.
		for (args, expected) in [
			(&["N;N;s/^/>/Mg"][..], ">a\n>b\n>c\n"),
			(&["N;N;s/$/</Mg"][..], "a<\nb<\nc<\n"),
			(&["N;N;s/\\`/>/Mg"][..], ">a\nb\nc\n"),
			(&["N;N;s/\\'/</Mg"][..], "a\nb\nc<\n"),
			(&["N;N;s/a.b/X/M"][..], "a\nb\nc\n"),
			(&["-n", "$!{N;N};/^b$/Mp"][..], "a\nb\nc\n"),
			(&["-n", "$!{N;N};/^B$/I M p"][..], "a\nb\nc\n"),
			(&["-n", "$!{N;N};/^b$/p"][..], ""),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "a\nb\nc\n", "/");
			assert_eq!((code, capture.out().as_str()), (0, expected), "{args:?}: {}", capture.err());
		}

		let (code, capture) = crate::host::run_util::<Sed>(&["--posix", "-n", "/x/Mp"], "x\n", "/");
		assert_eq!(
			(code, capture.err().as_str()),
			(1, "sed: -e expression #1, char 4: unknown command: `M'\n")
		);
	}

	#[test]
	fn builtin_accepts_backslash_as_the_delimiter() {
		// `s\a\x\` was refused; in GNU every backslash ends the part instead.
		// An unescaped `&` delimiter likewise ends the replacement.
		for (script, expected) in [
			("s\\a\\x\\", "x\nb\n"),
			("y\\a\\x\\", "x\nb\n"),
			("\\\\a\\d", "b\n"),
			("s&a&X&", "X\nb\n"),
			("s&a&\\&&", "&\nb\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "a\nb\n", "/");
			assert_eq!((code, capture.out().as_str()), (0, expected), "{script}: {}", capture.err());
		}
		for (script, expected) in [
			("s\\a\\\\x\\", "char 6: unknown option to `s'"),
			("y\\a\\\\\\", "char 5: strings for `y' command are different lengths"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "a\n", "/");
			assert_eq!(
				(code, capture.err()),
				(1, format!("sed: -e expression #1, {expected}\n")),
				"{script}"
			);
		}
	}

	#[test]
	fn builtin_posix_text_commands_keep_text_after_the_backslash() {
		// `sed --posix '1a\  text'` failed with "extra characters"; GNU appends it.
		let (code, capture) = crate::host::run_util::<Sed>(&["--posix", "1a\\  text"], "x\n", "/");
		assert_eq!((code, capture.out().as_str()), (0, "x\n  text\n"), "{}", capture.err());

		for (args, expected) in [
			(&["--posix", "1a text"][..], "char 4: expected \\ after `a', `c' or `i'"),
			(&["--posix", "-e", "1a\\", "-e", "  hello"][..], "char 3: incomplete command"),
			(&["--posix", "1a\\  x\\"][..], "char 7: incomplete command"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "x\n", "/");
			assert_eq!(
				(code, capture.err()),
				(1, format!("sed: -e expression #1, {expected}\n")),
				"{args:?}"
			);
		}
	}

	#[test]
	fn builtin_reports_unopenable_files_like_gnu() {
		// A `w` or `-f` file that can't be opened is GNU's "couldn't open file", status 4.
		let dir = tempfile::tempdir().unwrap();
		for args in [&["w missing/x"][..], &["-f", "missing/x"][..]] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "x\n", dir.path());
			assert_eq!(
				(code, capture.out().as_str(), capture.err().as_str()),
				(4, "", "sed: couldn't open file missing/x: No such file or directory\n"),
				"{args:?}"
			);
		}
	}

	#[test]
	fn builtin_reports_directory_operands_like_gnu() {
		// A directory operand was "can't read" and skipped; GNU stops with a read
		// error, unless a `$` check already read past it, and refuses it for -i.
		let dir = tempfile::tempdir().unwrap();
		std::fs::create_dir(dir.path().join("d")).unwrap();
		std::fs::write(dir.path().join("f1"), "a\n").unwrap();
		let read_error = "sed: read error on d: Is a directory\n";
		for (args, out, err, status) in [
			(&["p", "d"][..], "", read_error, 4),
			(&["p", "f1", "d"][..], "a\na\n", read_error, 4),
			(&["-n", "$p", "f1", "d"][..], "a\n", "", 0),
			(&["r d"][..], "x\n", read_error, 4),
			(&["-i", "p", "d"][..], "", "sed: couldn't edit d: not a regular file\n", 4),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, "x\n", dir.path());
			assert_eq!(
				(code, capture.out().as_str(), capture.err().as_str()),
				(status, out, err),
				"{args:?}"
			);
		}
	}

	#[test]
	fn builtin_reports_runtime_script_errors_like_gnu() {
		// These used the old `<script argument N>:L:C` form; GNU locates them at
		// the end of the last script piece.
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("s3.sed"), "p\n\n//p").unwrap();
		std::fs::write(dir.path().join("s1.sed"), "//p\n").unwrap();
		for (args, stdin, out, err) in [
			(&["//p"][..], "x\n", "", "-e expression #1, char 0: no previous regular expression"),
			(&["-e", "p", "-e", "//p"][..], "aa\n", "aa\n", "-e expression #2, char 0: no previous regular expression"),
			(&["-f", "s3.sed"][..], "x\n", "x\n", "file s3.sed line 3: no previous regular expression"),
			(&["-f", "s1.sed"][..], "x\n", "", "file s1.sed line 2: no previous regular expression"),
			(
				&["-n", r"/a/h;s//\1/"][..],
				"aa\n",
				"",
				r"-e expression #1, char 0: invalid reference \1 on `s' command's RHS",
			),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(args, stdin, dir.path());
			assert_eq!(
				(code, capture.out().as_str(), capture.err()),
				(1, out, format!("sed: {err}\n")),
				"{args:?}"
			);
		}

		// A regex reused from another `s` expands its missing groups to nothing.
		let (code, capture) = crate::host::run_util::<Sed>(&[r"s/a/b/;s//\1/"], "aa\n", "/");
		assert_eq!((code, capture.out().as_str()), (0, "b\n"), "{}", capture.err());
	}

	#[test]
	fn case_conversion_maps_one_character_to_one() {
		// GNU sed 4.9's `\U`, `\L`, `\u` and `\l` map each character to one,
		// by Unicode's simple case mappings, as `towupper` and `towlower` do
		// in a UTF-8 locale: `ß` has no one-character upper case and stays.
		for (script, input, expected) in [
			(r"s/a./\U&/", "abc\n", "ABc\n"),
			(r"s/.*/\U&/", "straße\n", "STRAßE\n"),
			(r"s/.*/\u&/", "ß\n", "ß\n"),
			(r"s/.*/\L&/", "STRASSE\n", "strasse\n"),
			(r"s/.*/\L&/", "\u{130}\n", "i\n"),
			(r"s/.*/\l&/", "\u{130}X\n", "iX\n"),
			(r"s/.*/\U&/", "\u{1fb3}\n", "\u{1fbc}\n"),
			(r"s/.*/\u&/", "\u{1fb3}x\n", "\u{1fbc}x\n"),
			// `\u` and `\l` change the next character alone, past one empty
			// group; `\U` and `\L` run on until `\E`.
			(r"s/.*/\L\u&/", "hello world\n", "Hello world\n"),
			(r"s/a/\Ufoo\lBAR/", "ab\n", "FOObARb\n"),
			(r"s/a/\Ufoo\Ebar/", "ab\n", "FOObarb\n"),
			(r"s/\(\)\(H\)/\l\1\2/", "HELLO\n", "hELLO\n"),
			(r"s/\(\)\(\)\(a\)/\u\1\2\3/", "ab\n", "ab\n"),
			// An escaped delimiter is the delimiter, and --posix has no case
			// conversion. `\c\\` is one escape, the control character of `\`,
			// so the `U` after it is plain text.
			(r"sUaU\UU", "aU\n", "UU\n"),
			(r"s/a/\c\\Ux/", "a\n", "\u{1c}Ux\n"),
			// An unknown escape gives its character, which a conversion
			// converts. GNU sed copies an escaped non-ASCII character as it
			// is: it drops a `\u` or `\l` and leaves `\U` and `\L` on.
			(r"s/a/\qabc/", "a\n", "qabc\n"),
			(r"s/a/\u\qabc/", "a\n", "Qabc\n"),
			(r"s/a/\u\éx/", "a\n", "éx\n"),
			(r"s/a/\U\éx/", "a\n", "éX\n"),
			// In a replacement GNU sed reads `\b` as such an unknown escape,
			// not as a backspace.
			(r"s/a/\bx/", "a\n", "bx\n"),
			(r"s/a/\u\bx/", "a\n", "Bx\n"),
			(r"s/a/\U\bx/", "a\n", "BX\n"),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], input, "/");
			let out = capture.out();
			assert_eq!((code, out.as_str()), (0, expected), "{script}: {}", capture.err());
		}
		let (code, capture) = crate::host::run_util::<Sed>(&["--posix", r"s/a/\Ux/"], "ab\n", "/");
		assert_eq!((code, capture.out().as_str()), (0, "Uxb\n"), "{}", capture.err());
		// A NUL ends the conversion of its piece of the replacement, which
		// ends at the next escape: `\&`, `\\` and an unknown escape start
		// another, converted, and so does a numeric escape that gives `&` or
		// `\`, which GNU reads as `\&` or `\\`. Any other character it gives
		// is plain text.
		for (script, expected) in [
			(r"s/a/\Ua\x00bc\&de/", &b"A\0bc&DE\n"[..]),
			(r"s/a/\Ua\x00bc\\de/", &b"A\0bc\\DE\n"[..]),
			(r"s/a/\Ua\x00bc\x26de/", &b"A\0bc&DE\n"[..]),
			(r"s/a/\Ua\x00bc\x5cde/", &b"A\0bc\\DE\n"[..]),
			(r"s/a/\Ua\x00bc\qde/", &b"A\0bcqDE\n"[..]),
			(r"s/a/\Ua\x00bc\éde/", "A\0bcéDE\n".as_bytes()),
			(r"s/a/\Ua\x00bc\d038de/", &b"A\0bc&DE\n"[..]),
			(r"s/a/\Ua\x00bc\o134de/", &b"A\0bc\\DE\n"[..]),
			(r"s/a/\Ua\x00bc\x41de/", &b"A\0bcAde\n"[..]),
		] {
			let (code, capture) = crate::host::run_util::<Sed>(&[script], "a\n", "/");
			let stdout = capture.stdout();
			assert_eq!((code, stdout.as_slice()), (0, expected), "{script}: {}", capture.err());
		}
	}
}
