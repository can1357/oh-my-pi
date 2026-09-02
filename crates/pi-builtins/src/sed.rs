//! `sed` builtin stream editor.
//!
//! Ported from uutils sed 0.1.1.

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
use std::{cell::RefCell, collections::HashMap, rc::Rc};

use crate::sed::error_handling::SedResult;

use crate::sed::{
	error_handling::{ScriptLocation, runtime_error},
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
	/// Shell working directory used to resolve paths embedded in scripts.
	pub cwd:              PathBuf,

	// Other context
	/// Currently processed input file name (not script) in quoted form
	pub input_name:           String,
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
	/// Previously compiled RE, saved for reuse when specifying an empty RE
	pub saved_regex:          Option<Regex>,
	/// Modification of input processing action
	// This is required to avoid doubly borrowing the reader in the 'N'
	// command.
	pub input_action: Option<InputAction>,
	/// Hold space
	pub hold:                 StringSpace,
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
}

#[derive(Clone, Debug)]
/// Elements that shall be appended at the end of each command processing cycle
pub enum AppendElement {
	Text(Rc<str>), // The specified text string
	Path(PathBuf), // The contents of the specified file path
}

#[derive(Clone, Debug, Default, PartialEq)]
/// A space mirroring IOChunk, but only with a String
pub struct StringSpace {
	pub content:     String, // Line content without newline
	pub has_newline: bool,   // True if \n-terminated
}

#[derive(Debug)]
/// Types of address specifications that precede commands
pub enum Address {
	Re(Option<Regex>), // Line that matches (optional) regex
	Line(usize),       // Specific line
	RelLine(usize),    // Relative line
	Last,              // Last line
	StepMatch(usize),  // Lines matching specified step from first
	StepEnd(usize),    // Range ending at specified step from first
}

#[derive(Debug)]
/// A single part of an RE replacement
pub enum ReplacementPart {
	Literal(String), // Normal text
	WholeMatch,      // &
	Group(u32),      // \1 to \9
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

	/// Apply the template to the given RE captures.
	/// Example:
	/// let result = regex.replace_all(input, |caps: &Captures| {
	///    template.apply_captures(&command, caps) });
	/// Returns an error if a backreference in the template was not matched by
	/// the RE.
	pub fn apply_captures(&self, command: &Command, caps: &Captures) -> SedResult<String> {
		let mut result = String::new();

		// Invalid group numbers may end here through (unkown at compile time)
		// reused REs.
		if self.max_group_number > caps.len() - 1 {
			return runtime_error(
				&command.location,
				format!("invalid reference \\{} on command's RHS", self.max_group_number),
			);
		}

		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => result.push_str(s),

				ReplacementPart::WholeMatch => {
					result.push_str(caps.get(0)?.map(|m| m.as_str()).unwrap_or_default());
				},

				ReplacementPart::Group(n) => {
					let i: usize = (*n).try_into().unwrap();
					result.push_str(caps.get(i)?.map(|m| m.as_str()).unwrap_or_default());
				},
			}
		}

		Ok(result)
	}

	/// Apply the template to the given RE single match.
	pub fn apply_match(&self, m: &Match) -> String {
		let mut result = String::new();

		for part in &self.parts {
			match part {
				ReplacementPart::Literal(s) => result.push_str(s),

				ReplacementPart::WholeMatch => result.push_str(m.as_str()),

				ReplacementPart::Group(_) => {
					panic!("unexpected Regex group replacement")
				},
			}
		}
		result
	}
}

#[derive(Debug, Default)]
/// Substitution command
pub struct Substitution {
	pub regex:       Option<Regex>,       // Regular expression
	pub replacement: ReplacementTemplate, // Specified broken-down replacement
	pub occurrence:  usize,               // Which occurrence to substitute
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
	NamedWriter(Rc<RefCell<NamedWriter>>),      // File output for 'w'
	Number(usize),                              // Number for 'l', 'q', 'Q' (GNU)
	Substitution(Box<Substitution>),            // Substitute command 's'
	Text(Rc<str>),                              // Text for 'a', 'c', 'i'
	Transliteration(Box<Transliteration>),      // Transliteration command 'y'
}

#[derive(Debug, Clone)]
/// Action to execute after reading a new input line
pub struct InputAction {
	/// Next command to execute (rather than commands from start)
	pub next_command: Option<Rc<RefCell<Command>>>,
	/// Data to prepend to the read contents
	pub prepend:      String,
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
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps).unwrap();
		assert_eq!(result, "");
	}

	#[test]
	// s/abc/hello/
	fn test_literal_only() {
		let template = ReplacementTemplate::new(vec![ReplacementPart::Literal("hello".into())]);
		let input = &mut IOChunk::new_from_str("abc");
		let caps = caps_for("abc", input);
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps).unwrap();
		assert_eq!(result, "hello");
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
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps).unwrap();
		assert_eq!(result, "got: foo42");
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
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps).unwrap();
		assert_eq!(result, "number: 42");
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
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps).unwrap();
		assert_eq!(result, "key: x, value: 123");
	}

	#[test]
	// s/(\w+):(\d+)/key: \1, value: \3/
	fn test_invalid_group() {
		let template = ReplacementTemplate::new(vec![
			ReplacementPart::Literal("key: ".into()),
			ReplacementPart::Group(1),
			ReplacementPart::Literal(", value: ".into()),
			ReplacementPart::Group(3),
		]);
		let input = &mut IOChunk::new_from_str("x:123");
		let caps = caps_for(r"(\w+):(\d+)", input);
		let cmd = Command::default();

		let result = template.apply_captures(&cmd, &caps);
		assert!(result.is_err());

		let msg = result.unwrap_err().to_string();
		assert!(msg.contains("invalid reference \\3"));
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

use brush_core::openfiles::OpenFile;
use crate::sed::{
	command::{
		Address, Command, CommandData, ProcessingContext, RegexMode, ReplacementPart,
		ReplacementTemplate, Substitution, Transliteration,
	},
	delimited_parser::{parse_char_escape, parse_regex, parse_transliteration},
	error_handling::{ScriptLocation, compilation_error, semantic_error},
	fast_regex::Regex,
	named_writer::NamedWriter,
	script_char_provider::ScriptCharProvider,
	script_line_provider::{ScriptLineProvider, ScriptValue},
};

const DEFAULT_OUTPUT_WIDTH: usize = 60;

const ERR_ADDRESS_0_USAGE: &str =
	"address 0 can only be used with ~step, a second regular expression, or a read command";
const ERR_SANDBOX: &str = "command not allowed with --sandbox";

const ERR_UNKNOWN_OPTION_TO_S: &str = "unknown option to 's'";

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
	cwd: PathBuf,
) -> SedResult<Option<Rc<RefCell<Command>>>> {
	compile_with_provider(ScriptLineProvider::with_stdin(scripts, stdin, cwd), context)
}

fn compile_with_provider(
	mut make_providers: ScriptLineProvider,
	context: &mut ProcessingContext,
) -> SedResult<Option<Rc<RefCell<Command>>>> {

	let mut empty_line = ScriptCharProvider::new("");
	let result = compile_sequence(&mut make_providers, &mut empty_line, context)?;

	// Comment-out the following to show the compiled script.
	#[cfg(any())]
	dbg!(&result);

	// Link branch commands to the target label commands.
	populate_label_map(result.clone(), context)?;
	populate_range_commands(result.clone(), context);
	resolve_branch_targets(result.clone(), context)?;

	// Link the ends of command blocks to their following commands.
	// This converts the tree into a graph, so it must be the last
	// conversion that traverses the structure as a tree.
	if context.parsed_block_nesting > 0 {
		return Err(SedError::new(1, "unmatched `{'"));
	}
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
fn populate_label_map(
	mut cur: Option<Rc<RefCell<Command>>>,
	context: &mut ProcessingContext,
) -> SedResult<()> {
	while let Some(rc_cmd) = cur.take() {
		// Borrow mutably just long enough to inspect/rewire this node
		let cmd = rc_cmd.borrow_mut();

		// Extract any label to insert after borrow ends
		let maybe_label = match &cmd.data {
			CommandData::BranchTarget(Some(sub_head)) => {
				populate_label_map(Some(sub_head.clone()), context)?;
				None
			},
			CommandData::Label(Some(label)) => Some(label.clone()),
			_ => None,
		};

		if let Some(label) = maybe_label
			&& cmd.code == ':'
		{
			if context.label_to_command_map.contains_key(&label) {
				return semantic_error(&cmd.location, format!("duplicate label `{label}'"));
			}
			context.label_to_command_map.insert(label, rc_cmd.clone());
		}

		cur.clone_from(&cmd.next);
	}
	Ok(())
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
					let target = context
						.label_to_command_map
						.get(&label)
						.cloned()
						.ok_or_else(|| {
							semantic_error::<()>(&cmd.location, format!("undefined label `{label}'"))
								.unwrap_err()
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
		if is_line0 && context.posix {
			// 0 starting address is a GNU extension.
			return compilation_error(lines, line, "address 0 is invalid in POSIX mode");
		}
		n_addr += 1;
	}

	line.eat_spaces();
	if n_addr == 1 && !line.eol() && matches!(line.current(), ',' | '~') {
		let is_step_match = line.current() == '~'; // E.g. 0~2: Pick even-numbered lines
		line.advance();
		line.eat_spaces();
		let is_step_end = if line.current() == '~' {
			// E.g. /foo/,~10: Start at foo, include all lines until multiple of 10 is
			// reached.
			line.advance();
			line.eat_spaces();
			true
		} else {
			false
		};

		if (is_step_match || is_step_end) && context.posix {
			// ~ steps are a GNU extension.
			return compilation_error(lines, line, "~step is invalid in POSIX mode");
		}

		// Look for second address.
		if !line.eol() {
			let addr2 = compile_address(lines, line, context)?;
			// Set step_n to the number specified in the (required numeric) address.
			let step_n = if is_step_match || is_step_end {
				match addr2 {
					Address::Line(n) => n,
					_ => {
						return compilation_error(
							lines,
							line,
							"~step can only be specified on numeric addresses",
						);
					},
				}
			} else {
				0 // dummy, not used
			};

			if is_line0 && !matches!(addr2, Address::Re(_)) && !is_step_match {
				return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
			}

			// If needed, transform Address::Line into Address::Step*.
			cmd.addr2 = if is_step_match {
				Some(Address::StepMatch(step_n))
			} else if is_step_end {
				Some(Address::StepEnd(step_n))
			} else {
				Some(addr2)
			};
			n_addr += 1;
		}
	}

	// Zero-address read command check
	if is_line0 && n_addr == 1 {
		// After retrieval of first address, subsequent spaces
		// are consumed unconditionally. By now, the position
		// must be in non-whitespace character or EOL.
		if line.eol() || line.current() != 'r' {
			return compilation_error(lines, line, ERR_ADDRESS_0_USAGE);
		}
	}

	Ok(n_addr)
}

/// Read the line's remaining characters as a file path and return it.
fn read_file_path(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<PathBuf> {
	line.advance(); // Skip the command/w character
	line.eat_spaces(); // Skip any leading whitespace

	let mut path = String::new();
	while !line.eol() {
		path.push(line.current());
		line.advance();
	}

	if path.is_empty() {
		compilation_error(lines, line, "missing file path")
	} else {
		// resolve `r`/`w`/`s///w` file
		// operands against the shell working directory.
		Ok(PathBuf::from(path))
	}
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
			let re = parse_regex(lines, line, regex_mode)?;
			// Skip over delimiter
			line.advance();

			line.eat_spaces();
			if !line.eol() && line.current() == 'I' {
				icase = true;
				line.advance();
			}

			Ok(Address::Re(compile_regex(lines, line, &re, context, icase, false)?))
		},
		'$' => {
			line.advance();
			Ok(Address::Last)
		},
		'+' => {
			line.advance();
			let number = parse_number(lines, line, true)?.unwrap();
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
fn parse_command_ending(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
) -> SedResult<()> {
	if !line.eol() && line.current() == ';' {
		line.advance();
		return Ok(());
	}

	if !line.eol() {
		return compilation_error(
			lines,
			line,
			format!("extra characters at the end of the {} command", cmd.code),
		);
	}

	Ok(())
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups..
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Leaves all other characters as-is.
fn bre_to_ere(pattern: &str) -> String {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

	let mut at_beginning = true;
	let mut previous: Option<char> = None;
	while let Some(c) = chars.next() {
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					result.push('('); // Group start
				},
				Some(')') => {
					chars.next();
					result.push(')'); // Group end
				},
				Some('?') => {
					chars.next();
					result.push('?'); // Quantifier 0 or 1
				},
				Some('+') => {
					chars.next();
					result.push('+'); // Quantifier 1 or more
				},
				Some('|') => {
					chars.next();
					result.push('|'); // Alternation operator
				},
				Some('{') => {
					chars.next();
					result.push('{'); // Brace quantifier start
				},
				Some('}') => {
					chars.next();
					result.push('}'); // Brace quantifier end
				},
				Some(v) if v.is_ascii_digit() => {
					// Back-reference.  In sed BREs these are single-digit
					// (\1-\9) whereas fancy_regex supports multi-digit
					// back-references. Put them in a non-capturing group
					// to avoid having the number extend beyond the single
					// digit. Example: In sed \11 matches group 1 followed
					// by '1', not group 11.
					result.push_str(&format!(r"(?:\{v})"));
					chars.next();
				},
				Some(&next) => {
					// Preserve other escaped characters.
					chars.next();
					result.push('\\');
					result.push(next);
				},
				None => {
					// Trailing backslash; keep it.
					result.push('\\');
				},
			}
		} else {
			match c {
				'+' | '?' | '{' | '}' | '|' | '(' | ')' => {
					// Escape unsupported ERE metacharacters.
					result.push('\\');
					result.push(c);
				},
				'^' if !at_beginning && previous != Some('[') => {
					// In BREs ^ has special meaning at the beginning
					// and as bracket negation.  This heuristic escapes
					// all other uses, which per POSIX are valid in EREs.
					// "the ERE "a^b" is valid, but can never match because
					// the 'a' prevents the expression "^b" from matching
					// starting at the first character."
					// POSIX 9.4.9 ERE Expression Anchoring
					result.push('\\');
					result.push(c);
				},
				'$' if chars.peek().is_some() => {
					// Similarly for $ appearing not at the end.
					result.push('\\');
					result.push(c);
				},
				_ => result.push(c),
			}
		}
		at_beginning = false;
		previous = Some(c);
	}

	result
}

/// Compile the provided regular expression string into a corresponding engine.
/// An empty pattern results in None, which means that the last RE employed
/// at runtime will be used.
fn compile_regex(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	pattern: &str,
	context: &ProcessingContext,
	icase: bool,
	multiline: bool,
) -> SedResult<Option<Regex>> {
	if pattern.is_empty() {
		return Ok(None);
	}

	// Convert basic to extended regular expression if needed.
	let pattern = if context.regex_extended {
		pattern
	} else {
		&bre_to_ere(pattern)
	};

	let mut modifiers = String::new();
	if icase {
		modifiers.push('i');
	}
	if multiline {
		modifiers.push('m');
	}
	let pattern = if modifiers.is_empty() {
		pattern.to_string()
	} else {
		format!("(?{modifiers}){pattern}")
	};

	// Compile into engine.
	let compiled = Regex::new(&pattern).map_err(|e| {
		compilation_error::<Regex>(lines, line, format!("invalid regex '{pattern}': {e}"))
			.unwrap_err()
	})?;

	Ok(Some(compiled))
}

/// Compile a regular expression replacement string.
pub fn compile_replacement(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<ReplacementTemplate> {
	let mut parts = Vec::new();
	let mut literal = String::new();

	let delimiter = line.current();
	line.advance();

	loop {
		while !line.eol() {
			match line.current() {
				'\\' => {
					line.advance();

					// Line input_action
					if line.eol() {
						if let Some(next_line_string) = lines.next_line()? {
							literal.push('\n');
							*line = ScriptCharProvider::new(&next_line_string);
							continue;
						}
						return compilation_error(
							lines,
							line,
							"unterminated substitute replacement (unexpected EOF)",
						);
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

						// Literal \ and &
						'\\' | '&' => {
							literal.push(line.current());
							line.advance();
						},

						// Literal delimiter
						v if v == delimiter => {
							literal.push(line.current());
							line.advance();
						},

						// other escape sequences
						_ => {
							if let Some(decoded) = parse_char_escape(line) {
								literal.push(decoded);
							} else {
								literal.push('\\');
								literal.push(line.current());
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

				'\n' => {
					return compilation_error(
						lines,
						line,
						"unescaped newline inside substitute replacement",
					);
				},

				c if c == delimiter => {
					line.advance(); // skip closing delimiter
					if !literal.is_empty() {
						parts.push(ReplacementPart::Literal(literal));
					}
					return Ok(ReplacementTemplate::new(parts));
				},

				c => {
					literal.push(c);
					line.advance();
				},
			}
		}

		// Fetch next line for continued replacement string
		if let Some(next_line_string) = lines.next_line()? {
			*line = ScriptCharProvider::new(&next_line_string);
		} else {
			return compilation_error(lines, line, "unterminated substitute replacement");
		}
	}
}

// Handles s
fn compile_subst_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // move past 's'

	let delimiter = line.current();
	if delimiter == '\0' || delimiter == '\\' {
		return compilation_error(
			lines,
			line,
			"substitute pattern cannot be delimited by newline or backslash",
		);
	}

	let regex_mode = if context.regex_extended {
		RegexMode::Extended
	} else {
		RegexMode::Basic
	};
	let pattern = parse_regex(lines, line, regex_mode)?;
	let mut subst = Box::new(Substitution::default());

	subst.replacement = compile_replacement(lines, line)?;
	compile_subst_flags(lines, line, &mut subst, context.posix, context.sandbox, Some(&context.cwd))?;

	if pattern.is_empty() && (subst.ignore_case || subst.multiline) {
		return compilation_error(
			lines,
			line,
			"cannot specify modifiers on an empty regular expression",
		);
	}

	// Compile regex with now known modifier flags.
	subst.regex = compile_regex(lines, line, &pattern, context, subst.ignore_case, subst.multiline)?;

	// Catch invalid group references at compile time, if possible.
	if let Some(regex) = &subst.regex
		&& subst.replacement.max_group_number > regex.captures_len() - 1
	{
		return compilation_error(
			lines,
			line,
			format!("invalid reference \\{} on `s' command's RHS", subst.replacement.max_group_number),
		);
	}
	cmd.data = CommandData::Substitution(subst);

	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}

// Handles y
fn compile_trans_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // move past 'y'

	let delimiter = line.current();
	if delimiter == '\0' || delimiter == '\\' {
		return compilation_error(
			lines,
			line,
			"transliteration string cannot be delimited by newline or backslash",
		);
	}

	let source = parse_transliteration(lines, line)?;
	let target = parse_transliteration(lines, line)?;
	if source.chars().count() != target.chars().count() {
		return compilation_error(lines, line, "transliteration strings are not the same length");
	}

	let transliteration = Box::new(Transliteration::from_strings(&source, &target));
	cmd.data = CommandData::Transliteration(transliteration);

	line.advance(); // move past last delimiter
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}

/// Parse the substitution command's optional flags
pub fn compile_subst_flags(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	subst: &mut Substitution,
	posix: bool,
	sandbox: bool,
	cwd: Option<&std::path::Path>,
) -> SedResult<()> {
	let mut seen_g_or_n = false;

	subst.occurrence = 1; // default
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
				if seen_g_or_n {
					return compilation_error(
						lines,
						line,
						"multiple 'g' or numeric flags in substitute command",
					);
				}
				seen_g_or_n = true;
				subst.occurrence = 0;
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
				if posix || sandbox {
					return compilation_error(
						lines,
						line,
						"the 'e' substitute flag is not allowed with --posix or --sandbox",
					);
				}
				subst.execute = true;
				line.advance();
			},

			_c @ '1'..='9' => {
				if seen_g_or_n {
					return compilation_error(
						lines,
						line,
						"multiple 'g' or numeric flags in substitute command",
					);
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
				seen_g_or_n = true;
			},

			'w' => {
				if sandbox {
					return compilation_error(lines, line, ERR_SANDBOX);
				}
				let location = ScriptLocation::at_position(lines, line);
				let mut path = read_file_path(lines, line)?;
				if let Some(cwd) = cwd {
					let normalized = brush_core::sys::fs::normalize_shell_path(&path);
					path = if normalized.is_absolute() {
						normalized.into_owned()
					} else {
						cwd.join(normalized)
					};
				}
				subst.write_file = Some(NamedWriter::new(path, location)?);
				return Ok(()); // 'w' is the last flag allowed
			},

			';' | '\n' => break,

			other => {
				return compilation_error(lines, line, format!("invalid substitute flag: '{other}'"));
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
	context.parsed_block_nesting -= 1;
	line.advance();
	line.eat_spaces();
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Return)
}

// Handles !
fn compile_negation_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance();
	line.eat_spaces();
	if cmd.non_select {
		return compilation_error(lines, line, "negation already applied");
	}
	cmd.non_select = true;
	Ok(CommandHandling::GetNext)
}

/// Compile a command that doesn't take any arguments
// Handles d D g G h H l n N p P q x =
fn compile_empty_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // Skip the command character
	line.eat_spaces(); // Skip any trailing whitespace

	parse_command_ending(lines, line, cmd)?;
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
	let mut path = read_file_path(lines, line)?;
	let normalized = brush_core::sys::fs::normalize_shell_path(&path);
	path = if normalized.is_absolute() {
		normalized.into_owned()
	} else {
		context.cwd.join(normalized)
	};
	cmd.data = CommandData::Path(path);
	Ok(CommandHandling::Continue)
}


// Handles w
fn compile_write_file_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if context.sandbox {
		return compilation_error(lines, line, ERR_SANDBOX);
	}
	let location = ScriptLocation::at_position(lines, line);
	let mut path = read_file_path(lines, line)?;
	let normalized = brush_core::sys::fs::normalize_shell_path(&path);
	path = if normalized.is_absolute() {
		normalized.into_owned()
	} else {
		context.cwd.join(normalized)
	};
	cmd.data = CommandData::NamedWriter(NamedWriter::new(path, location)?);
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
	let block_body = compile_sequence(lines, line, context)?;
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
			return compilation_error(lines, line, "empty label");
		}
		cmd.data = CommandData::Label(None);
	} else {
		cmd.data = CommandData::Label(Some(label));
	}

	line.eat_spaces(); // Skip any trailing whitespace
	parse_command_ending(lines, line, cmd)?;
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

	line.eat_spaces(); // Skip any trailing whitespace
	parse_command_ending(lines, line, cmd)?;
	Ok(CommandHandling::Continue)
}

/// Compile commands that take text as an argument.
// Handles a, c, i
// According to POSIX, these commands expect \ followed by text.
// As a GNU extension the initial \ can be ommitted, and from then on
// character escapes are honored.
fn compile_text_command(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	line.advance(); // Skip the command character.
	line.eat_spaces(); // Skip any leading whitespace.
	if context.posix {
		compile_text_command_posix(lines, line, cmd, context)
	} else {
		compile_text_command_gnu(lines, line, cmd, context)
	}
}

/// Compile commands that take text as an argument (GNU syntax).
// Handles a, c, i; after the command and initial whitespace have been consumed.
// According to POSIX, these commands expect \ followed by text.
// As a GNU extension the initial \ can be ommitted, and from then on
// character escapes are honored.
fn compile_text_command_gnu(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	// True after a \ at the end of a line
	let mut escaped_newline = false;

	if line.eol() {
		return compilation_error(
			lines,
			line,
			format!("command `{}' expects \\ followed by text", cmd.code),
		);
	}

	// Skip optional \.
	if !line.eol() && line.current() == '\\' {
		line.advance();
		escaped_newline = line.eol();
	}

	// Gather replacement text.  Stop on a non-escaped newline.
	let mut text = String::new();
	'text_content: loop {
		if escaped_newline {
			match lines.next_line()? {
				None => {
					break 'text_content;
				},
				Some(line_string) => {
					*line = ScriptCharProvider::new(&line_string);
				},
			}
			escaped_newline = false;
		}

		// Non-escaped newline
		if line.eol() {
			text.push('\n');
			break 'text_content;
		}

		if line.current() == '\\' {
			line.advance();

			if line.eol() {
				escaped_newline = true;
				text.push('\n');
				continue 'text_content;
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

/// Compile commands that take text as an argument (POSIX syntax).
// Handles a, c, i; after the command and initial whitespace have been consumed.
// According to POSIX, these commands expect \ followed by text.
fn compile_text_command_posix(
	lines: &mut ScriptLineProvider,
	line: &mut ScriptCharProvider,
	cmd: &mut Command,
	_context: &mut ProcessingContext,
) -> SedResult<CommandHandling> {
	if line.eol() || line.current() != '\\' {
		return compilation_error(
			lines,
			line,
			format!("command `{}' expects \\ followed by text", cmd.code),
		);
	}

	line.advance(); // Skip \.
	line.eat_spaces(); // Skip any whitespace at the end of \.
	if !line.eol() {
		return compilation_error(
			lines,
			line,
			format!("extra characters after \\ at the end of `{}' command", cmd.code),
		);
	}

	let mut text = String::new();
	while let Some(line) = lines.next_line()? {
		if line.ends_with('\\') {
			// Line ends with \ to escape \n; remove the trailing \.
			text.push_str(&line[..line.len() - 1]);
			text.push('\n');
		} else {
			text.push_str(&line);
			text.push('\n');
			break;
		}
	}

	if text.is_empty() {
		compilation_error(lines, line, "incomplete command")?;
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
		return compilation_error(lines, line, "command expected");
	}

	let ch = line.current();
	let cmd_spec = get_cmd_spec(lines, line, ch, posix)?;

	if n_addr > cmd_spec.n_addr {
		return compilation_error(
			lines,
			line,
			format!("command {} expects up to {} address(es), found {}", ch, cmd_spec.n_addr, n_addr),
		);
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
		'}' => Ok(CommandSpec { n_addr: 0, handler: compile_end_group_command }),
		'a' | 'i' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_text_command })
		},
		'b' | 't' => Ok(CommandSpec { n_addr: 2, handler: compile_label_command }),
		'c' => Ok(CommandSpec { n_addr: 2, handler: compile_text_command }),
		'd' | 'D' | 'g' | 'G' | 'h' | 'H' | 'n' | 'N' | 'p' | 'P' | 'x' => {
			Ok(CommandSpec { n_addr: 2, handler: compile_empty_command })
		},
		'z' if !posix => Ok(CommandSpec { n_addr: 2, handler: compile_empty_command }),
		'l' => Ok(CommandSpec { n_addr: 2, handler: compile_number_command }),
		'q' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_number_command })
		},
		// Q is a GNU extension
		'Q' => Ok(CommandSpec { n_addr: 1, handler: compile_number_command }),
		'r' => {
			Ok(CommandSpec { n_addr: if posix { 1 } else { 2 }, handler: compile_read_file_command })
		},
		's' => Ok(CommandSpec { n_addr: 2, handler: compile_subst_command }),
		'w' => Ok(CommandSpec { n_addr: 2, handler: compile_write_file_command }),
		'y' => Ok(CommandSpec { n_addr: 2, handler: compile_trans_command }),
		_ => compilation_error(lines, line, format!("invalid command code `{cmd_code}'")),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sed::fast_io::IOChunk;

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
		assert_eq!(cmd.n_addr, 0);
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

		assert!(msg.contains("test.sed:42:5: error: unexpected token"));
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

		assert_eq!(msg, "input.txt:3:1: error: invalid command 'x'");
	}

	// get_verified_cmd_spec
	#[test]
	fn test_missing_command_character() {
		let lines = ScriptLineProvider::with_active_state("test.sed", 1);
		let line = char_provider_from("");
		let result = get_verified_cmd_spec(&lines, &line, 0, ctx().posix);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert!(msg.contains("test.sed:1:1: error: command expected"));
	}

	#[test]
	fn test_invalid_command_character() {
		let lines = ScriptLineProvider::with_active_state("script.sed", 2);
		let line = char_provider_from("@");
		let result = get_verified_cmd_spec(&lines, &line, 0, ctx().posix);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert!(msg.contains("script.sed:2:1: error: invalid command code `@'"));
	}

	#[test]
	fn test_too_many_addresses() {
		let lines = ScriptLineProvider::with_active_state("input.sed", 3);
		let line = char_provider_from("q"); // q takes one address
		let result = get_verified_cmd_spec(&lines, &line, 2, true);

		assert!(result.is_err());
		let msg = result.unwrap_err().to_string();
		assert!(msg.contains("input.sed:3:1: error: command q expects up to 1 address(es), found 2"));
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
		assert!(msg.contains("input.sed:1:1: error: command i expects up to 1 address(es), found 2"));
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
	fn dummy_providers() -> (ScriptLineProvider, ScriptCharProvider) {
		make_providers("dummy input")
	}

	#[test]
	fn test_compile_re_basic() {
		let (lines, chars) = dummy_providers();
		let regex = compile_regex(&lines, &chars, "abc", &ctx(), false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&mut IOChunk::new_from_str("abc")).unwrap());
		assert!(!regex.is_match(&mut IOChunk::new_from_str("ABC")).unwrap());
	}

	#[test]
	fn test_compile_re_extended() {
		let (lines, chars) = make_providers("acaa\nbbb\nccc");
		let mut ctx = ctx();
		ctx.regex_extended = true;
		let regex = compile_regex(&lines, &chars, "cc{0,}", &ctx, false, false)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&mut IOChunk::new_from_str("acaa\nccc"))
				.unwrap()
		);
	}

	#[test]
	fn test_compile_re_case_insensitive() {
		let (lines, chars) = dummy_providers();
		let regex = compile_regex(&lines, &chars, "abc", &ctx(), true, false)
			.unwrap()
			.expect("regex should be present");
		assert!(regex.is_match(&mut IOChunk::new_from_str("abc")).unwrap());
		assert!(regex.is_match(&mut IOChunk::new_from_str("ABC")).unwrap());
		assert!(regex.is_match(&mut IOChunk::new_from_str("AbC")).unwrap());
	}

	#[test]
	fn test_compile_re_invalid() {
		let (lines, chars) = dummy_providers();
		let result = compile_regex(&lines, &chars, "a[d", &ctx(), false, false);
		assert!(result.is_err()); // Should fail due to open bracketed expression
	}

	#[test]
	fn test_compile_re_multiline_start() {
		let (lines, chars) = dummy_providers();
		let regex = compile_regex(&lines, &chars, "^bar", &ctx(), false, true)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&mut IOChunk::new_from_str("foo\nbar"))
				.unwrap()
		);
	}

	#[test]
	fn test_compile_re_multiline_end() {
		let (lines, chars) = dummy_providers();
		let regex = compile_regex(&lines, &chars, "foo$", &ctx(), false, true)
			.unwrap()
			.expect("regex should be present");
		assert!(
			regex
				.is_match(&mut IOChunk::new_from_str("foo\nbar"))
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

		assert!(re.is_match(&mut IOChunk::new_from_str("hello")).unwrap());
	}

	#[test]
	fn test_compile_addr_regex_backref_match() {
		let (lines, mut chars) = make_providers(r"/he\(.\)\1o/");
		let addr = compile_address(&lines, &mut chars, &ctx()).unwrap();

		match addr {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&mut IOChunk::new_from_str("hello")).unwrap());
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
				assert!(!re.is_match(&mut IOChunk::new_from_str("helio")).unwrap());
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
				assert!(re.is_match(&mut IOChunk::new_from_str("hello")).unwrap());
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
				assert!(re.is_match(&mut IOChunk::new_from_str("HELLO")).unwrap());
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
				assert!(re.is_match(&mut IOChunk::new_from_str("foo")).unwrap());
				assert!(!re.is_match(&mut IOChunk::new_from_str("bar")).unwrap());
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
				assert!(re.is_match(&mut IOChunk::new_from_str("foo")).unwrap());
				assert!(!re.is_match(&mut IOChunk::new_from_str("bar")).unwrap());
			},
			_ => panic!("expected regex address"),
		}

		match cmd.borrow().addr2.as_ref().unwrap() {
			Address::Re(Some(re)) => {
				assert!(re.is_match(&mut IOChunk::new_from_str("bar")).unwrap());
				assert!(!re.is_match(&mut IOChunk::new_from_str("foo")).unwrap());
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
				assert!(re.is_match(&mut IOChunk::new_from_str("FOO")).unwrap());
				assert!(re.is_match(&mut IOChunk::new_from_str("foo")).unwrap());
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
		assert!(msg.contains("unterminated regular expression"));
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

		assert_eq!(cmd.location.line_number, 1);
		assert_eq!(cmd.location.column_number, 1);
		assert_eq!(cmd.location.input_name.as_ref(), "<script argument 1>");

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
		assert_eq!(cmd.location.line_number, 1);
		assert_eq!(cmd.location.column_number, 1);
		assert_eq!(cmd.location.input_name.as_ref(), "<script argument 1>");

		let binding2 = cmd.next.clone().unwrap();
		let cmd2 = binding2.borrow();
		assert_eq!(cmd2.code, 'q');
		assert_eq!(cmd2.location.line_number, 1);
		assert_eq!(cmd2.location.column_number, 3);
		assert_eq!(cmd2.location.input_name.as_ref(), "<script argument 1>");

		assert!(cmd2.next.is_none());
	}

	// compile_replacement
	#[test]
	fn test_compile_replacement_literal() {
		let (mut lines, mut chars) = make_providers("/hello/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "hello"));
	}

	#[test]
	fn test_compile_replacement_escaped_delimiter() {
		let (mut lines, mut chars) = make_providers(r"/hell\/o/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "hell/o"));
	}

	#[test]
	fn test_compile_replacement_backrefs_and_literal() {
		let (mut lines, mut chars) = make_providers("/prefix \\1 and \\2/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 4);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "prefix "));
		assert!(matches!(&template.parts[1], ReplacementPart::Group(1)));
		assert!(matches!(&template.parts[2], ReplacementPart::Literal(s) if s == " and "));
		assert!(matches!(&template.parts[3], ReplacementPart::Group(2)));
	}

	#[test]
	fn test_compile_replacement_whole_match() {
		let (mut lines, mut chars) = make_providers("/The match was: &/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 2);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "The match was: "));
		assert!(matches!(&template.parts[1], ReplacementPart::WholeMatch));
	}

	#[test]
	fn test_compile_replacement_whole_match_synonym() {
		let (mut lines, mut chars) = make_providers(r"/The match was: \0/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 2);
		assert!(matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "The match was: "));
		assert!(matches!(&template.parts[1], ReplacementPart::WholeMatch));
	}

	#[test]
	fn test_compile_replacement_ampersand() {
		let (mut lines, mut chars) = make_providers("/Simon \\& Garfunkel/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

		assert_eq!(template.parts.len(), 1);
		assert!(
			matches!(&template.parts[0], ReplacementPart::Literal(s) if s == "Simon & Garfunkel")
		);
	}

	#[test]
	fn test_compile_replacement_escape_sequences() {
		let (mut lines, mut chars) = make_providers("/line\\nnewline\\tend/");
		let template = compile_replacement(&mut lines, &mut chars).unwrap();

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

		let template = compile_replacement(&mut provider, &mut chars).unwrap();
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

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert_eq!(subst.occurrence, 0); // 'g' means all occurrences
	}

	#[test]
	fn test_compile_subst_flag_p() {
		let (lines, mut chars) = make_providers("p");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.print_flag);
	}

	#[test]
	fn test_compile_subst_flag_uppercase_i() {
		let (lines, mut chars) = make_providers("I");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.ignore_case);
	}

	#[test]
	fn test_compile_subst_flag_i_lowercase() {
		let (lines, mut chars) = make_providers("i");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.ignore_case);
	}

	#[test]
	fn test_compile_subst_flag_uppercase_m() {
		let (lines, mut chars) = make_providers("M");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.multiline);
	}

	#[test]
	fn test_compile_subst_flag_m_lowercase() {
		let (lines, mut chars) = make_providers("m");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.multiline);
	}

	#[test]
	fn test_compile_subst_flag_number() {
		let (lines, mut chars) = make_providers("3");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert_eq!(subst.occurrence, 3);
	}

	#[test]
	fn test_compile_subst_flag_g_and_number_should_fail() {
		let (lines, mut chars) = make_providers("g3");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap_err();
		assert!(
			err.to_string()
				.contains("multiple 'g' or numeric flags in substitute command")
		);
	}

	#[test]
	fn test_compile_subst_flag_number_and_g_should_fail() {
		let (lines, mut chars) = make_providers("2g");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap_err();
		assert!(
			err.to_string()
				.contains("multiple 'g' or numeric flags in substitute command")
		);
	}

	#[test]
	fn test_compile_subst_flag_w_missing_filename() {
		let (lines, mut chars) = make_providers("w ");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap_err();
		assert!(err.to_string().contains("missing file path"));
	}

	#[test]
	fn test_compile_subst_flag_w_with_filename() {
		let tmp_dir = tempfile::tempdir().expect("failed to create tmp folder");
		let out = tmp_dir.path().join("out.txt");
		let (lines, mut chars) = make_providers(&format!("w {}", out.display()));
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert_eq!(subst.write_file.as_ref().map(|w| w.borrow().path.clone()), Some(out));
	}

	#[test]
	fn test_compile_subst_flag_w_rejected_under_sandbox() {
		let (lines, mut chars) = make_providers("w out.txt");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, true, None).unwrap_err();
		assert!(err.to_string().contains(ERR_SANDBOX));
	}

	#[test]
	fn test_compile_subst_flag_e() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap();
		assert!(subst.execute);
	}

	#[test]
	fn test_compile_subst_flag_e_rejected_under_posix() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, true, false, None).unwrap_err();
		assert!(
			err.to_string()
				.contains("not allowed with --posix or --sandbox")
		);
	}

	#[test]
	fn test_compile_subst_flag_e_rejected_under_sandbox() {
		let (lines, mut chars) = make_providers("e");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, true, None).unwrap_err();
		assert!(
			err.to_string()
				.contains("not allowed with --posix or --sandbox")
		);
	}

	#[test]
	fn test_compile_subst_flag_invalid_flag() {
		let (lines, mut chars) = make_providers("z");
		let mut subst = Substitution::default();

		let err = compile_subst_flags(&lines, &mut chars, &mut subst, false, false, None).unwrap_err();
		assert!(err.to_string().contains("invalid substitute flag"));
	}

	// compile_subst_command
	#[test]
	fn test_compile_subst_invalid_delimiter_backslash() {
		let (mut lines, mut chars) = make_providers("s\\foo\\bar\\");
		let mut cmd = Command::default();
		let mut context = ctx();

		let err = compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(
			err.to_string()
				.contains("substitute pattern cannot be delimited")
		);
	}

	#[test]
	fn test_compile_subst_extra_characters_at_end() {
		let (mut lines, mut chars) = make_providers("s/foo/bar/x");
		let mut cmd = Command::default();
		let mut context = ctx();

		let err = compile_subst_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap_err();
		assert!(err.to_string().contains("invalid substitute flag"));
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

	// bre_to_ere
	#[test]
	fn test_bre_group_translation() {
		assert_eq!(bre_to_ere(r"\(a\?b\+c\|\)"), "(a?b+c|)");
		assert_eq!(bre_to_ere(r"a\(b\)c"), "a(b)c");
	}

	#[test]
	fn test_bre_brace_quantifier_translation() {
		assert_eq!(bre_to_ere(r"\{1,4\}"), "{1,4}");
	}

	#[test]
	fn test_ere_metacharacters_escaped() {
		assert_eq!(bre_to_ere(r"a+b?c{1}|(d)"), r"a\+b\?c\{1\}\|\(d\)");
	}

	#[test]
	fn test_literal_backslashes_preserved() {
		assert_eq!(bre_to_ere(r"foo\\bar"), r"foo\\bar");
		assert_eq!(bre_to_ere(r"\."), r"\.");
	}

	#[test]
	fn test_character_classes_unchanged() {
		assert_eq!(bre_to_ere(r"[a-z]"), "[a-z]");
		assert_eq!(bre_to_ere(r"[^0-9]"), "[^0-9]");
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(bre_to_ere(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_trailing_backslash_is_preserved() {
		assert_eq!(bre_to_ere(r"abc\"), r"abc\");
	}

	#[test]
	fn test_caret_escaped_in_middle() {
		assert_eq!(bre_to_ere(r"^a^[^x]c"), r"^a\^[^x]c");
	}

	#[test]
	fn test_dollar_escaped_in_middle() {
		assert_eq!(bre_to_ere(r"a$c$"), r"a\$c$");
	}

	#[test]
	fn test_bre_back_reference() {
		assert_eq!(bre_to_ere(r"\(.\)\1\(.\)\2"), r"(.)(?:\1)(.)(?:\2)");
	}

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
		assert!(err.to_string().contains("empty label"));
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

		populate_label_map(Some(cmd.clone()), &mut context).unwrap();

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

		populate_label_map(Some(block), &mut context).unwrap();

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
		populate_label_map(head, &mut context).unwrap();

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
		populate_label_map(head, &mut context).unwrap();

		assert_eq!(context.label_to_command_map.len(), 0);
	}

	#[test]
	fn test_label_none_is_ignored() {
		let cmd = command_with_data(CommandData::Label(None));
		let mut context = ProcessingContext::default();

		populate_label_map(Some(cmd), &mut context).unwrap();

		// The map should remain empty since the label is None
		assert_eq!(context.label_to_command_map.len(), 0);
	}

	#[test]
	fn test_duplicate_label_gives_error() {
		let a1 = command_with_data(CommandData::Label(Some("dup".to_string())));
		a1.borrow_mut().code = ':';

		let a2 = command_with_data(CommandData::Label(Some("dup".to_string())));
		a2.borrow_mut().code = ':';

		let head = link_commands(vec![a1, a2]);
		let mut context = ProcessingContext::default();

		let result = populate_label_map(head, &mut context);

		assert!(result.is_err());
		let err = result.unwrap_err().to_string();
		assert!(err.contains("duplicate label `dup'"));
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

		populate_label_map(head.clone(), &mut context).unwrap();
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
		assert!(err.contains("undefined label `nope'"));
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
		populate_label_map(Some(label.clone()), &mut context).unwrap();
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
		let mut chars = make_char_provider("a \\ ");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context).unwrap();
		match &cmd.data {
			CommandData::Text(text) => {
				assert_eq!(text.to_string(), "line1\n");
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
		assert!(err.contains("expects \\ followed by text"));
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
		assert!(err.contains("expects \\ followed by text"));
	}

	#[test]
	fn test_compile_text_command_posix_with_trailing_chars() {
		let mut chars = make_char_provider("a \\ foo");
		let mut lines = make_line_provider(&["line1", "line2"]);
		let mut cmd = Command::default();
		let mut context = ProcessingContext { posix: true, ..Default::default() };

		let result = compile_text_command(&mut lines, &mut chars, &mut cmd, &mut context);
		assert!(result.is_err());
		let err = result.unwrap_err().to_string();
		assert!(err.contains("extra characters after \\"));
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
		assert!(err.to_string().contains("missing file path"));
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
/// While at it, handle escaped characters for the sake of consistency.
fn parse_character_class(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
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

				let mut inner = String::new();
				let mut terminated = false;

				while !line.eol() {
					let c = line.current();
					if c == marker {
						line.advance();
						if !line.eol() && line.current() == ']' {
							line.advance();
							result.push_str(&inner);
							result.push(marker);
							result.push(']');
							terminated = true;
							break;
						}
						// False alarm, just part of the inner name
						inner.push(marker);
					} else {
						inner.push(c);
						line.advance();
					}
				}

				if !terminated {
					return compilation_error(
						lines,
						line,
						"Unterminated POSIX character class, equivalence or collating symbol",
					);
				}

				continue;
			}
			// Not a POSIX construct — treat as literal
			result.push('[');
			result.push(marker);
			line.advance();
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
				result.push(line.current());
				line.advance();
			}
		} else {
			result.push(ch);
			line.advance();
		}
	}

	compilation_error(lines, line, "Unterminated bracket expression")
}

/// Scan and return the opening delimiter of a delimited string
/// Advances the line past the opening delimiter
fn scan_delimiter(lines: &ScriptLineProvider, line: &mut ScriptCharProvider) -> SedResult<char> {
	// Sanity check
	if line.eol() {
		return compilation_error(lines, line, "unexpected end of line".to_string());
	}

	let delimiter = line.current();
	if delimiter == '\\' {
		return compilation_error(lines, line, "\\ cannot be used as a string delimiter");
	}
	line.advance(); // skip the opening delimiter
	Ok(delimiter)
}

/// Parse the regular expression delimited by the current line
/// character and return it as a string.
/// On return, the line is on the closing delimiter.
/// In Basic mode, quantifiers like {m,n} must be escaped (\{m,n\}).
/// In Extended mode, quantifiers like {m,n} don't require escaping.
pub fn parse_regex(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	regex_mode: RegexMode,
) -> SedResult<String> {
	let delimiter = scan_delimiter(lines, line)?;
	let mut result = String::new();
	while !line.eol() {
		match line.current() {
			'[' if delimiter != '[' => {
				let cc = parse_character_class(lines, line)?;
				result.push_str(&cc);
				continue;
			},
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, "unterminated regular expression");
				}
				if line.current() == delimiter {
					// Push escaped delimiter
					result.push(line.current());
					line.advance();
					continue;
				}
				if line.current() == '{' && matches!(regex_mode, RegexMode::Basic) {
					validate_quantifier_structure(lines, line, delimiter, RegexMode::Basic)?;
					let quantifier = validate_quantifier_numbers(lines, line)?;
					result.push('\\');
					result.push('{');
					result.push_str(&quantifier);
					continue;
				}
				if line.current() == '}' {
					result.push('\\');
					result.push('}');
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
			'{' if delimiter != '{' && matches!(regex_mode, RegexMode::Extended) => {
				validate_quantifier_structure(lines, line, delimiter, RegexMode::Extended)?;
				let quantifier = validate_quantifier_numbers(lines, line)?;
				result.push('{');
				result.push_str(&quantifier);
				continue;
			},
			'}' if delimiter != '}' => {
				result.push('}');
				line.advance();
				continue;
			},

			c if c == delimiter => return Ok(result),
			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, "unterminated regular expression")
}

// Check for closing brace and the structure/content.
fn validate_quantifier_structure(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	delimiter: char,
	regex_mode: RegexMode,
) -> SedResult<()> {
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
		return compilation_error(lines, line, "Unmatched \\{");
	}

	if invalid_content_detected {
		return compilation_error(lines, line, invalid_content_error_msg);
	}

	line.set_position(initial_pos);
	Ok(())
}

// Parse an already-structure-validated run of digits into a quantifier bound.
// `validate_quantifier_structure` guarantees the run contains only ASCII
// digits, so the sole failure mode is a value exceeding what fits, which sed
// reports as "Regular expression too big" (same as exceeding RE_DUP_MAX).
fn parse_quantifier_bound(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
	digits: &str,
) -> SedResult<usize> {
	match digits.parse::<usize>() {
		Ok(val) if val <= RE_DUP_MAX => Ok(val),
		_ => compilation_error(lines, line, "Regular expression too big"),
	}
}

// Performs validations on m and/or n values of the quantifier
// and returns the valid content as a string (without braces).
fn validate_quantifier_numbers(
	lines: &ScriptLineProvider,
	line: &mut ScriptCharProvider,
) -> SedResult<String> {
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
	let m_val = if m.is_empty() {
		0
	} else {
		parse_quantifier_bound(lines, line, &m)?
	};
	let n_val = if n.is_empty() {
		None
	} else {
		Some(parse_quantifier_bound(lines, line, &n)?)
	};

	// Validate m <= n if both present.
	if let Some(n_val) = n_val
		&& m_val > n_val
	{
		return compilation_error(lines, line, "Invalid content of \\{\\}");
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
	let delimiter = scan_delimiter(lines, line)?;
	let mut result = String::new();

	while !line.eol() {
		match line.current() {
			'\\' => {
				line.advance();
				if line.eol() {
					return compilation_error(lines, line, "unterminated transliteration string");
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
			c if c == delimiter => return Ok(result),
			c => result.push(c),
		}
		line.advance();
	}
	compilation_error(lines, line, "unterminated transliteration string")
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
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[qr]");
	}

	#[test]
	fn test_negated_class() {
		let mut line = char_provider_from("[^abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[^abc]");
	}

	#[test]
	fn test_leading_close_bracket() {
		let mut line = char_provider_from("[]abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[]abc]");
	}

	#[test]
	fn test_leading_negated_close_bracket() {
		let mut line = char_provider_from("[^]abc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[^]abc]");
	}

	#[test]
	fn test_escaped_character_begin() {
		let mut line = char_provider_from("[\\nabc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[\nabc]");
	}

	#[test]
	fn test_escaped_character_middle() {
		let mut line = char_provider_from("[a\\nbc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[a\nbc]");
	}

	#[test]
	fn test_escaped_character_end() {
		let mut line = char_provider_from("[abc\\n]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[abc\n]");
	}

	#[test]
	fn test_escaped_delimiter() {
		let mut line = char_provider_from("[a\\]bc]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[a\\]bc]");
	}

	#[test]
	fn test_posix_class() {
		let mut line = char_provider_from("[[:digit:]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[[:digit:]]");
	}

	#[test]
	fn test_equivalence_class() {
		let mut line = char_provider_from("[[=a=]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[[=a=]]");
	}

	#[test]
	fn test_collating_symbol() {
		let mut line = char_provider_from("[[.ch.]]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[[.ch.]]");
	}

	#[test]
	fn test_unterminated_class_error() {
		let mut line = char_provider_from("[abc"); // missing closing ]
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line);
		assert!(err.is_err());
	}

	#[test]
	fn test_unterminated_posix_class_error() {
		let mut line = char_provider_from("[[:digit:]");
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line);
		assert!(err.is_err());
	}

	#[test]
	fn test_unterminated_escape_error() {
		let mut line = char_provider_from("[abc\\"); // missing closing ]
		let lines = test_lines();
		let err = parse_character_class(&lines, &mut line);
		assert!(err.is_err());
	}

	#[test]
	fn test_malformed_posix_like_pattern_treated_as_literal() {
		let mut line = char_provider_from("[[x]yz]");
		let lines = test_lines();
		let result = parse_character_class(&lines, &mut line).unwrap();
		assert_eq!(result, "[[x]");
	}

	// parse_regex
	#[test]
	fn test_simple_regex() {
		let (lines, mut line) = make_providers("/abc/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "abc");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escaped_delimiter() {
		let (lines, mut line) = make_providers("/ab\\/c/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "ab/c");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_capture() {
		let (lines, mut line) = make_providers(r"/\(.\)/c/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, r"\(.\)");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escape_sequence() {
		let (lines, mut line) = make_providers("/ab\\n/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "ab\n");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_basic_regex_quantifier() {
		let (lines, mut line) = make_providers("/a\\{2,3\\}/p");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "a\\{2,3\\}");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_basic_regex_with_unmatched_brace_quantifier() {
		let (lines, mut line) = make_providers("/a\\{2,3/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_basic_regex_with_invalid_content() {
		let (lines, mut line) = make_providers("/a\\{2d,3\\}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_quantifier() {
		let (lines, mut line) = make_providers("/a{2,3}/p");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap();
		assert_eq!(parsed, "a{2,3}");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_extended_regex_with_unmatched_brace_quantifier() {
		let (lines, mut line) = make_providers("/a{2,3/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_extended_regex_with_empty_quantifier() {
		let (lines, mut line) = make_providers("/a{}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_whitespace_quantifier() {
		let (lines, mut line) = make_providers("/a{}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_invalid_m() {
		let (lines, mut line) = make_providers("/a{2d,3}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_invalid_n() {
		let (lines, mut line) = make_providers("/a{2,-3}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_extended_regex_with_m_gt_n() {
		let (lines, mut line) = make_providers("/a{3,2}/p");
		let err = parse_regex(&lines, &mut line, RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn errors_on_unterminated_regex() {
		let (lines, mut line) = make_providers("/unterminated");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("unterminated regular expression"));
	}

	#[test]
	fn errors_on_esc_at_re_eol() {
		let (lines, mut line) = make_providers("/foo\\");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("unterminated regular expression"));
	}

	#[test]
	fn errors_on_backslash_delimiter() {
		let (lines, mut line) = make_providers("\\bad");
		let err = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap_err();
		assert!(
			err.to_string()
				.contains("\\ cannot be used as a string delimiter")
		);
	}

	#[test]
	fn test_regex_with_character_class() {
		let (lines, mut line) = make_providers("/[a-z]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "[a-z]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_bracket_delimiter() {
		let (lines, mut line) = make_providers("[abc[");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "abc");
		assert_eq!(line.current(), '[');
	}

	#[test]
	fn test_bracket_regex_with_bracket_delimiter() {
		let (lines, mut line) = make_providers("[a\\[0-9]bc[");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "a[0-9]bc");
		assert_eq!(line.current(), '[');
	}

	#[test]
	fn test_regex_with_escaped_bracket_in_character_class() {
		let (lines, mut line) = make_providers("/[a\\]z]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "[a\\]z]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_delimiter_inside_character_class() {
		let (lines, mut line) = make_providers("/[a/c]/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "[a/c]");
		assert_eq!(line.current(), '/');
	}

	#[test]
	fn test_regex_with_escaped_paren_and_backslash() {
		let (lines, mut line) = make_providers("/\\(\\\\/");
		let parsed = parse_regex(&lines, &mut line, RegexMode::Basic).unwrap();
		assert_eq!(parsed, "\\(\\\\");
		assert_eq!(line.current(), '/');
	}

	// validate_quantifier_structure
	//BRE tests
	#[test]
	fn test_validate_quantifier_structure_bre_valid() {
		let (lines, mut line) = make_providers("{2,3\\}");
		validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Basic).unwrap();
		assert_eq!(line.current(), '{'); // Line should be back on the opening brace
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_unmatched_brace() {
		let (lines, mut line) = make_providers("{2,3");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_empty_content() {
		let (lines, mut line) = make_providers("{\\}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_invalid_char() {
		let (lines, mut line) = make_providers("{2d,3\\}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_bre_with_double_comma() {
		let (lines, mut line) = make_providers("{2,3,\\}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Basic).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	// ERE tests
	#[test]
	fn test_validate_quantifier_structure_ere_valid() {
		let (lines, mut line) = make_providers("{2,3}");
		validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Extended).unwrap();
		assert_eq!(line.current(), '{'); // Line should be back on the opening brace
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_unmatched_brace() {
		let (lines, mut line) = make_providers("{2,3");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Unmatched \\{"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_empty_content() {
		let (lines, mut line) = make_providers("{}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_invalid_char() {
		let (lines, mut line) = make_providers("{2d,3}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_structure_ere_with_double_comma() {
		let (lines, mut line) = make_providers("{2,3,}");
		let err =
			validate_quantifier_structure(&lines, &mut line, '/', RegexMode::Extended).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	// validate_quantifier_numbers
	#[test]
	fn test_validate_quantifier_numbers_with_m() {
		let (lines, mut line) = make_providers("{2}");
		let result = validate_quantifier_numbers(&lines, &mut line).unwrap();
		assert_eq!(result, "2");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_single_comma() {
		let (lines, mut line) = make_providers("{,}");
		let result = validate_quantifier_numbers(&lines, &mut line).unwrap();
		assert_eq!(result, "0,");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_comma_n() {
		let (lines, mut line) = make_providers("{,3}");
		let result = validate_quantifier_numbers(&lines, &mut line).unwrap();
		assert_eq!(result, "0,3");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_valid() {
		let (lines, mut line) = make_providers("{2,3}");
		let result = validate_quantifier_numbers(&lines, &mut line).unwrap();
		assert_eq!(result, "2,3");
		assert_eq!(line.current(), '}');
	}

	#[test]
	fn test_validate_quantifier_numbers_with_m_too_big() {
		let (lines, mut line) = make_providers("{32768}");
		let err = validate_quantifier_numbers(&lines, &mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_n_too_big() {
		let (lines, mut line) = make_providers("{2,32768}");
		let err = validate_quantifier_numbers(&lines, &mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_m_gt_n() {
		let (lines, mut line) = make_providers("{3,2}");
		let err = validate_quantifier_numbers(&lines, &mut line).unwrap_err();
		assert!(err.to_string().contains("Invalid content of \\{\\}"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_leading_comma_n_too_big() {
		// The {,n} form must bound n by RE_DUP_MAX just like {m,n}.
		let (lines, mut line) = make_providers("{,32768}");
		let err = validate_quantifier_numbers(&lines, &mut line).unwrap_err();
		assert!(err.to_string().contains("Regular expression too big"));
	}

	#[test]
	fn test_validate_quantifier_numbers_with_overflowing_m() {
		// A digit run too large for usize is reported as too big, not as
		// invalid content.
		let (lines, mut line) = make_providers("{99999999999999999999999}");
		let err = validate_quantifier_numbers(&lines, &mut line).unwrap_err();
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
				.contains("unterminated transliteration string")
		);
	}

	#[test]
	fn errors_on_esc_at_tr_eol() {
		let (lines, mut line) = make_providers("/foo\\");
		let err = parse_transliteration(&lines, &mut line).unwrap_err();
		assert!(
			err.to_string()
				.contains("unterminated transliteration string")
		);
	}
}
}
pub mod error_handling {
// Parse delimited character sequences
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis

use std::{fmt, io, rc::Rc};

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

	/// Creates an I/O error while retaining its descriptive context.
	pub fn io(_kind: io::ErrorKind, message: impl ToString) -> Self {
		Self::new(2, message)
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

impl From<io::Error> for SedError {
	fn from(error: io::Error) -> Self {
		Self::new(2, error)
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

impl From<fancy_regex::Error> for SedError {
	fn from(error: fancy_regex::Error) -> Self {
		Self::new(2, error)
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
		self.map_err(|error| SedError::new(2, format!("{}: {error}", context())))
	}
}

#[derive(Clone, Debug)]
/// The location in a script where a command is defined.
pub struct ScriptLocation {
	pub input_name: Rc<str>,
	pub line_number: usize,
	pub column_number: usize,
}

impl Default for ScriptLocation {
	fn default() -> Self {
		Self { input_name: Rc::from("<unknown>"), line_number: 1, column_number: 1 }
	}
}

impl ScriptLocation {
	/// Constructs a location from the current script providers.
	pub fn at_position(lines: &ScriptLineProvider, line: &ScriptCharProvider) -> Self {
		Self {
			line_number: lines.get_line_number(),
			column_number: line.get_pos() + 1,
			input_name: Rc::from(lines.get_input_name()),
		}
	}
}

/// Fails with a compile error at the provider location.
pub fn compilation_error<T>(
	lines: &ScriptLineProvider,
	line: &ScriptCharProvider,
	msg: impl ToString,
) -> SedResult<T> {
	Err(SedError::new(
		1,
		format!(
			"{}:{}:{}: error: {}",
			lines.get_input_name(), lines.get_line_number(), line.get_pos() + 1, msg.to_string()
		),
	))
}

fn location_error<T>(location: &ScriptLocation, msg: impl ToString, code: i32) -> SedResult<T> {
	Err(SedError::new(
		code,
		format!(
			"{}:{}:{}: error: {}",
			location.input_name, location.line_number, location.column_number, msg.to_string()
		),
	))
}

/// Fails with a semantic error at the command location.
pub fn semantic_error<T>(location: &ScriptLocation, msg: impl ToString) -> SedResult<T> {
	location_error(location, msg, 1)
}

/// Fails with a runtime error at the command location.
pub fn runtime_error<T>(location: &ScriptLocation, msg: impl ToString) -> SedResult<T> {
	location_error(location, msg, 2)
}

/// Fails with a runtime error including command and input locations.
pub fn input_runtime_error<T>(
	location: &ScriptLocation,
	context: &ProcessingContext,
	msg: impl ToString,
) -> SedResult<T> {
	Err(SedError::new(
		2,
		format!(
			"{}:{}:{}: {}:{} error: {}",
			location.input_name,
			location.line_number,
			location.column_number,
			context.input_name,
			context.line_number,
			msg.to_string()
		),
	))
}
}
pub mod fast_io {
// Zero-copy line-based I/O
//
// Abstractions that allow file lines to be processed and output
// in mmapped memory space.  By coalescing output requests an
// efficient write(2) system call can be issued for them, bypassing
// the copy required for output through BufWriter.
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
	fs::File,
	io::{self, BufRead, BufReader, BufWriter, Read, Write},
	path::PathBuf,
	str,
};

#[cfg(unix)]
use memchr::memchr;
#[cfg(unix)]
use memmap2::Mmap;
use crate::{host::Host, sed::error_handling::SedError};

// Define two cursors for iterating over lines:
// - MmapLineCursor based on mmap(2),
// - ReadLineCursor based on BufReader.

/// Cursor for zero-copy iteration over mmap’d file.
#[cfg(unix)]
pub struct MmapLineCursor<'a> {
	_file: File,     // Mmapped file; kept open while the map is referenced
	data:  &'a [u8], // Mmapped data
	pos:   usize,    // Position within the data
}

#[cfg(unix)]
/// Represents the get_line return: one line plus whether it was the last.
pub struct NextMmapLine<'a> {
	pub content:   &'a [u8],
	pub full_span: &'a [u8],
}

#[cfg(unix)]
impl<'a> MmapLineCursor<'a> {
	fn new(file: File, data: &'a [u8]) -> Self {
		Self { _file: file, data, pos: 0 }
	}

	/// Return the next line, if available, or None.
	fn get_line(&mut self) -> io::Result<Option<NextMmapLine<'a>>> {
		if self.pos >= self.data.len() {
			return Ok(None);
		}

		let start = self.pos;

		let mut end = if let Some(pos) = memchr(b'\n', &self.data[start..]) {
			pos + start
		} else {
			self.data.len()
		};

		if end < self.data.len() {
			end += 1; // include \n in full span
		}

		self.pos = end;
		let full_span = &self.data[start..end];
		let content = if full_span.ends_with(b"\n") {
			&full_span[..full_span.len() - 1]
		} else {
			full_span
		};

		Ok(Some(NextMmapLine { content, full_span }))
	}

	/// Return true if the previously returned line was the last one.
	fn last_line(&mut self) -> io::Result<bool> {
		Ok(self.pos >= self.data.len())
	}
}

/// Buffered line reader from any BufRead input.
pub struct ReadLineCursor {
	reader: Box<dyn BufRead>,
	buffer: String,
}

impl ReadLineCursor {
	/// Construct from anything that implements `Read`.
	fn new<R: Read + 'static>(r: R) -> Self {
		let buf = BufReader::new(r);
		Self { reader: Box::new(buf), buffer: String::new() }
	}


	/// If a line is available, return it and its \n termination.
	fn get_line(&mut self) -> io::Result<Option<(String, bool)>> {
		self.buffer.clear();
		// read_line *includes* the '\n' if present
		let bytes_read = self.reader.read_line(&mut self.buffer)?;
		if bytes_read == 0 {
			return Ok(None);
		}
		// O(1) check whether it ended in '\n'
		let has_newline = self.buffer.ends_with('\n');
		// strip it if you don’t want to expose it to the caller
		if has_newline { self.buffer.pop(); }
		let line = std::mem::take(&mut self.buffer);
		Ok(Some((line, has_newline)))
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
	utf8_verified: Cell<bool>, // True if the contents are valid UTF-8
	content:       IOChunkContent<'a>,
}

impl<'a> IOChunk<'a> {
	/// Construct an IOChunk from the given content
	fn from_content(content: IOChunkContent<'a>) -> Self {
		Self { utf8_verified: Cell::new(false), content }
	}

	/// Clear the object's contents, converting it into Owned if needed.
	pub fn clear(&mut self) {
		self.utf8_verified.set(true);
		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				content.clear();
				*has_newline = false;
			},
			#[cfg(unix)]
			_ => {
				self.content = IOChunkContent::new_owned(String::new(), false);
			},
		}
	}

	/// Return true if the content is empty.
	pub fn is_empty(&self) -> bool {
		self.content.len() == 0
	}

	/// Return true if the content ends with a newline.
	pub fn is_newline_terminated(&self) -> bool {
		match &self.content {
			IOChunkContent::Owned { has_newline, .. } => *has_newline,
			#[cfg(unix)]
			IOChunkContent::MmapInput { full_span, .. } => {
				if let Some(&last) = full_span.last() {
					last == b'\n'
				} else {
					false
				}
			},
		}
	}

	#[cfg(test)]
	/// Create an Owned newline-terminated IOChunk from a string.
	pub fn new_from_str(s: &str) -> Self {
		IOChunk {
			content:       IOChunkContent::new_owned(s.to_string(), true),
			utf8_verified: Cell::new(false),
		}
	}

	/// Set the object's contents to the specified string.
	/// Convert it into Owned if needed.
	pub fn set_to_string(&mut self, new_content: String, add_newline: bool) {
		self.utf8_verified.set(true);
		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				*content = new_content;
				*has_newline = add_newline;
			},
			#[cfg(unix)]
			_ => {
				self.content = IOChunkContent::new_owned(new_content, add_newline);
			},
		}
	}

	/// Return the content as a str.
	pub fn as_str(&self) -> Result<&str, SedError> {
		match &self.content {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => {
				if self.utf8_verified.get() {
					// Use cached result
					Ok(unsafe { self.content.as_str_unchecked() })
				} else {
					let result = str::from_utf8(content);
					self.utf8_verified.set(true);
					result.map_err(|e| SedError::new(2, e.to_string()))
				}
			},
			IOChunkContent::Owned { content, .. } => Ok(content),
		}
	}

	/// Return the raw byte content (always safe).
	pub fn as_bytes(&self) -> &[u8] {
		match &self.content {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => content,
			IOChunkContent::Owned { content, .. } => content.as_bytes(),
		}
	}

	/// Convert content to the Owned variant if it's not already.
	/// Fails if the conversion to UTF-8 fails.
	pub fn ensure_owned(&mut self) -> Result<(), SedError> {
		match &self.content {
			IOChunkContent::Owned { .. } => Ok(()), // already owned
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, full_span, .. } => match std::str::from_utf8(content) {
				Ok(valid_str) => {
					let has_newline = full_span.last().copied() == Some(b'\n');
					self.content = IOChunkContent::new_owned(valid_str.to_string(), has_newline);
					self.utf8_verified.set(true);
					Ok(())
				},
				Err(e) => Err(SedError::new(2, e.to_string())),
			},
		}
	}

	/// Return mutable access to the content and has_newline fields.
	pub fn fields_mut(&mut self) -> Result<(&mut String, &mut bool), SedError> {
		self.ensure_owned()?;

		match &mut self.content {
			IOChunkContent::Owned { content, has_newline, .. } => Ok((content, has_newline)),
			#[allow(unreachable_patterns)]
			_ => unreachable!("ensure_owned should convert to Owned"),
		}
	}
}

/// Data to be written to a file. It can come from the mmapped
/// memory space, in which case it is tracked to allow coalescing
/// and bypassing BufWriter, or it can be other data from the process's
/// memory space.
#[derive(Debug, PartialEq, Eq)]
enum IOChunkContent<'a> {
	#[cfg(unix)]
	MmapInput {
		content:   &'a [u8], // Line without newline
		full_span: &'a [u8], // Line including original newline, if any
	},
	Owned {
		content:     String, // Line content without newline
		has_newline: bool,   // True if \n-terminated
		#[cfg(not(unix))]
		_phantom:    PhantomData<&'a ()>, // Silence E0392 warning
	},
}

impl IOChunkContent<'_> {
	/// Construct a new Owned chunk.
	pub fn new_owned(content: String, has_newline: bool) -> Self {
		#[cfg(unix)]
		return IOChunkContent::Owned { content, has_newline };

		#[cfg(not(unix))]
		return IOChunkContent::Owned {
			content,
			has_newline,
			// Avoid E0063 missing _phantom initialization errors
			_phantom: std::marker::PhantomData,
		};
	}

	#[cfg(unix)]
	unsafe fn as_str_unchecked(&self) -> &str {
		match self {
			IOChunkContent::MmapInput { content, .. } => unsafe {
				std::str::from_utf8_unchecked(content)
			},
			IOChunkContent::Owned { content, .. } => content,
		}
	}

	/// Return the content's length (in bytes or characters).
	pub fn len(&self) -> usize {
		match self {
			#[cfg(unix)]
			IOChunkContent::MmapInput { content, .. } => content.len(),

			IOChunkContent::Owned { content, .. } => content.len(),
		}
	}
}

// upstream's FastCopy (raw-fd metadata
// driving write(2)/copy_file_range(2) output fast paths) is removed, because
// the output writer is a plain `Write` handle without a file descriptor.

/// Unified reader that uses mmap when possible, falls back to buffered reading.
pub enum LineReader<'a> {
	#[cfg(unix)]
	MmapInput {
		_mapped_file: Mmap, // A handle that can derive the mapped file slice
		cursor:      MmapLineCursor<'a>,
	},
	ReadInput(ReadLineCursor),
	#[cfg(not(unix))]
	_Phantom(std::marker::PhantomData<&'a ()>),
}

/// Return a LineReader that uses the ReadInput method fot the specified file.
fn line_reader_read_input(file: File) -> io::Result<LineReader<'static>> {
	let boxed: Box<dyn Read> = Box::new(file);
	let reader = BufReader::new(boxed);
	Ok(LineReader::ReadInput(ReadLineCursor::new(reader)))
}

impl<'a> LineReader<'a> {
	/// Open the specified file for line input.
	// Use "-" to read from the standard input.
	pub fn open_with_host(path: &PathBuf, host: &mut Host) -> io::Result<Self> {
		if path.as_os_str() == "-" {
			// read the context stdin.
			let boxed: Box<dyn Read> = Box::new(host.stdin.file().clone());
			let reader = BufReader::new(boxed);
			return Ok(LineReader::ReadInput(ReadLineCursor::new(reader)));
		}

		// input file operands resolve
		// against the shell working directory.
		let file = File::open(host.resolve(path))?;

		#[cfg(unix)]
		{
			match unsafe { Mmap::map(&file) } {
				Ok(mapped_file) => {
					// SAFETY: mmap owns the data and lives in the same variant
					let slice: &'static [u8] =
						unsafe { std::slice::from_raw_parts(mapped_file.as_ptr(), mapped_file.len()) };
					let cursor = MmapLineCursor::new(file, slice);
					Ok(LineReader::MmapInput { _mapped_file: mapped_file, cursor })
				},
				// Fallback to ReadInput
				Err(_) => line_reader_read_input(file),
			}
		}

		#[cfg(not(unix))]
		{
			line_reader_read_input(file)
		}
	}

	/// Opens a file directly for unit tests.
	#[cfg(test)]
	pub fn open(path: &PathBuf) -> io::Result<Self> {
		let (mut host, _) = Host::for_test("sed", "", ".");
		Self::open_with_host(path, &mut host)
	}

	/// Open the specified file to read as a stream.
	#[cfg(test)]
	pub fn open_stream(path: &PathBuf) -> io::Result<Self> {
		let file = File::open(path)?;
		line_reader_read_input(file)
	}

	/// Return the next line, if available.
	pub fn get_line(&mut self) -> io::Result<Option<IOChunk<'a>>> {
		match self {
			#[cfg(unix)]
			LineReader::MmapInput { cursor, .. } => {
				if let Some(NextMmapLine { content, full_span }) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::MmapInput { content, full_span });

					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			LineReader::ReadInput(cursor) => {
				if let Some((line, _has_newline)) = cursor.get_line()? {
					let chunk = IOChunk::from_content(IOChunkContent::new_owned(line, _has_newline));
					Ok(Some(chunk))
				} else {
					Ok(None)
				}
			},

			#[cfg(not(unix))]
			LineReader::_Phantom(_) => unreachable!("_Phantom should never be constructed"),
		}
	}

	/// Return true if the previously returned line was the last one.
	pub fn last_line(&mut self) -> io::Result<bool> {
		match self {
			#[cfg(unix)]
			LineReader::MmapInput { cursor, .. } => cursor.last_line(),

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

/// An output data chunk from the mmapped file
/// Data elements allow output to be performed through write(2)
/// or through copy_file_range(2).
#[cfg(unix)]
#[derive(Clone)]
struct MmapOutput {
	out_ptr: *const u8, // Start of the output data chunk
	len:     usize,     // Output data chunk size
}

/// Abstraction for outputting data, potentially from the mmapped file
/// Outputs from mmapped data are coalesced and written via the Linux
/// copy_file_range(2) system call without any copying, if possible
/// and worthwhile.  As a fallback write(2) is used, which requires
/// the OS to copy data from the mmapped region to the output file
/// page cache.
/// All other output is buffered and writen via BufWriter.
pub struct OutputBuffer {
	out:               BufWriter<Box<dyn OutputWrite + 'static>>, // Where to write
	line_buffered:     bool, // Flush completed lines for non-file stdout
	#[cfg(unix)]
	max_pending_write: usize,                        /* Max bytes to keep before
	                                                               * flushing */
	#[cfg(unix)]
	mmap_chunk:        Option<MmapOutput>, // Chunk to write
	// True when the last write didn't end with \n; the \n is deferred so
	// that commands like `p` don't emit a spurious newline under -n.
	pending_newline:   bool,
	#[cfg(test)]
	low_level_flushes: usize, // Number of system call flushes
}

/// Threshold above which a coalesced mmap flush counts as a low-level flush
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
	#[cfg(not(unix))]
	pub fn new(w: Box<dyn OutputWrite + 'static>, line_buffered: bool) -> Self {
		Self {
			out: BufWriter::new(w),
			line_buffered,
			pending_newline: false,
			#[cfg(test)]
			low_level_flushes: 0,
		}
	}

	#[cfg(unix)]
	pub fn new(w: Box<dyn OutputWrite + 'static>, line_buffered: bool) -> Self {
		Self {
			out: BufWriter::new(w),
			line_buffered,
			max_pending_write: if line_buffered {
				MAX_PENDING_WRITE_NON_FILE
			} else {
				usize::MAX
			},
			mmap_chunk: None,
			pending_newline: false,
			#[cfg(test)]
			low_level_flushes: 0,
		}
	}

	/// Schedule the specified String or &str for eventual output
	pub fn write_str<S: Into<String>>(&mut self, s: S) -> io::Result<()> {
		let mut s = s.into();
		let has_newline = s.ends_with('\n');
		if has_newline {
			s.truncate(s.len() - 1);
		}
		self.write_chunk(&IOChunk::from_content(IOChunkContent::new_owned(s, has_newline)))
	}

	/// Copy the specified file to the output.
	pub fn copy_file(&mut self, path: &PathBuf) -> io::Result<()> {
		// Flush mmap writes, if any.
		#[cfg(unix)]
		{
			self.flush_mmap(WriteRange::Complete)?;
		}

		let Ok(file) = File::open(path) else {
			// Per POSIX, if the file can't be read treat it as empty.
			return Ok(());
		};

		let mut reader = BufReader::new(file);
		if self.line_buffered {
			let mut buf = [0; 8 * 1024];
			loop {
				let len = reader.read(&mut buf)?;
				if len == 0 {
					break;
				}
				self.out.write_all(&buf[..len])?;
				if buf[..len].contains(&b'\n') {
					self.flush_completed_line()?;
				}
			}
		} else {
			io::copy(&mut reader, &mut self.out)?;
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
		let s =
			std::str::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
		self.write_str(s)?;
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
		if new_chunk.is_empty() && !new_chunk.is_newline_terminated() {
			return Ok(());
		}

		if self.pending_newline {
			self.flush_mmap(WriteRange::Complete)?;
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}

		match &new_chunk.content {
			IOChunkContent::MmapInput { full_span, .. } => {
				let new_ptr = full_span.as_ptr();
				let new_len = full_span.len();

				// Set whether a flush is needed and whether the
				// mmap_chunk needs to be reset to the new input.
				// This avoids calling mmap_chunk (which borrows self)
				// when old_chunk is already borrowed.
				let (flush_action, reset) = if let Some(old_chunk) = self.mmap_chunk.as_mut() {
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
					self.flush_mmap(flush_action)?;
				}
				if reset {
					self.mmap_chunk = Some(MmapOutput { out_ptr: new_ptr, len: new_len });
				}
				self.pending_newline = !new_chunk.is_newline_terminated();
			},

			IOChunkContent::Owned { content, has_newline, .. } => {
				self.flush_mmap(WriteRange::Complete)?;
				self.out.write_all(content.as_bytes())?;
				if *has_newline {
					self.out.write_all(b"\n")?;
				}
				self.pending_newline = !has_newline;
			},
		}

		if self.line_buffered && new_chunk.is_newline_terminated() {
			// Mmap output reaches the BufWriter only here; file-backed mmap
			// output is block-buffered, so this cannot affect its fast path.
			self.flush_mmap(WriteRange::Complete)?;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush any pending mmap data.
	// the raw-fd write(2) and
	// copy_file_range(2) fast paths are removed; the coalesced mmap span is
	// written through the buffered writer. `cover` block alignment is thus
	// irrelevant and every flush writes the complete pending span.
	#[cfg(unix)]
	fn flush_mmap(&mut self, _cover: WriteRange) -> io::Result<()> {
		if let Some(chunk) = self.mmap_chunk.as_mut() {
			#[cfg(test)]
			if chunk.len >= MIN_DIRECT_WRITE {
				self.low_level_flushes += 1;
			}
			let slice = unsafe { std::slice::from_raw_parts(chunk.out_ptr, chunk.len) };
			self.out.write_all(slice)?;
			let written = slice.len();
			chunk.len -= written;
			unsafe { chunk.out_ptr = chunk.out_ptr.add(written) };
		}
		Ok(())
	}

	/// Write a deferred newline if the last output didn't end with one.
	pub fn flush_pending_newline(&mut self) -> io::Result<()> {
		if self.pending_newline {
			self.flush_mmap(WriteRange::Complete)?;
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush everything: pending mmap and buffered data.
	pub fn flush(&mut self) -> io::Result<()> {
		self.flush_mmap(WriteRange::Complete)?; // flush mmap if any
		self.out.flush() // then flush buffered data
	}
}

#[cfg(not(unix))]
impl OutputBuffer {
	/// Schedule the specified output chunk for eventual output
	pub fn write_chunk(&mut self, chunk: &IOChunk) -> io::Result<()> {
		if chunk.is_empty() && !chunk.is_newline_terminated() {
			return Ok(());
		}

		if self.pending_newline {
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}

		match &chunk.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				self.out.write_all(content.as_bytes())?;
				if *has_newline {
					self.out.write_all(b"\n")?;
				}
				self.pending_newline = !has_newline;
				if *has_newline {
					self.flush_completed_line()?;
				}
				Ok(())
			},
		}
	}

	/// Write a deferred newline if the last output didn't end with one.
	pub fn flush_pending_newline(&mut self) -> io::Result<()> {
		if self.pending_newline {
			self.out.write_all(b"\n")?;
			self.pending_newline = false;
			self.flush_completed_line()?;
		}
		Ok(())
	}

	/// Flush everything: pending mmap and buffered data.
	pub fn flush(&mut self) -> io::Result<()> {
		self.out.flush() // then flush buffered data
	}
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
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
	pub fn new_content_mmap_input<'a>(content: &'a [u8], full_span: &'a [u8]) -> IOChunkContent<'a> {
		IOChunkContent::MmapInput { content, full_span }
	}

	#[test]
	fn test_owned_line_output() -> io::Result<()> {
		let tmp = NamedTempFile::new()?;
		{
			let file = tmp.reopen()?;
			let mut out = OutputBuffer::new(Box::new(file), false);
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
	fn test_mmap_line_output_single() -> io::Result<()> {
		use std::{fs, io::Write};

		use tempfile::NamedTempFile;

		// Prepare the input buffer: two lines in one contiguous mmap region
		let mmap_data = b"line one\nline two\n";

		// Write that into a temp file
		let mut input = NamedTempFile::new()?;
		input.write_all(mmap_data)?;
		input.flush()?;
		let input_path = input.path().to_path_buf();

		// Open the reader on that file
		let mut reader = LineReader::open(&input_path)?;

		// Prepare an output temp file and wrap it in our OutputBuffer
		let output = NamedTempFile::new()?;
		let output_path = output.path().to_path_buf();
		let out_file = std::fs::File::create(&output_path)?;
		let mut out = OutputBuffer::new(Box::new(Box::new(out_file)), false);

		// Drain reader → writer
		while let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
		}
		out.flush()?;

		assert_eq!(out.low_level_flushes, 0);

		let written = fs::read(&output_path)?;
		assert_eq!(written.as_slice(), mmap_data);

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
		let mut out = OutputBuffer::new(Box::new(out_file), false);

		// Read the first mmap line ("zero\n") and write it
		if let Some(chunk) = reader.get_line()? {
			out.write_chunk(&chunk)?;
		}

		// Write an owned line ("middle\n")
		out.write_str("middle\n")?;

		// Read the second mmap line ("one\n") and write it
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
		let mut out = OutputBuffer::new(Box::new(out_file), false);
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
		let mut out = OutputBuffer::new(Box::new(out_file), false);
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
		let mut out = OutputBuffer::new(Box::new(out_file), false);
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
		let mut out = OutputBuffer::new(Box::new(out_file), false);
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
			content: IOChunkContent::Owned { content, has_newline, .. },
			utf8_verified,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, "first line");
			assert_eq!(content.len(), 10);
			assert!(has_newline);
			assert!(!utf8_verified.get());
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::Owned");
		}

		if let Some(IOChunk { content: IOChunkContent::Owned { content, has_newline, .. }, .. }) =
			reader.get_line()?
		{
			assert_eq!(content, "second line");
			assert!(has_newline);
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
	fn test_mmap_read() -> std::io::Result<()> {
		// Create temporary file with known contents
		let mut tmp = NamedTempFile::new()?;
		write!(tmp, "first line\nsecond line\nlast line\n")?;
		tmp.flush()?;

		let path = tmp.path().to_path_buf();
		let mut reader = LineReader::open(&path)?;

		// Verify the reader's operation
		if let Some(IOChunk {
			content: IOChunkContent::MmapInput { content, full_span, .. },
			utf8_verified,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, b"first line");
			assert_eq!(content.len(), 10);
			assert_eq!(full_span, b"first line\n");
			assert!(!utf8_verified.get());
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::MapInput");
		}

		if let Some(IOChunk {
			content: IOChunkContent::MmapInput { content, full_span, .. },
			utf8_verified,
			..
		}) = reader.get_line()?
		{
			assert_eq!(content, b"second line");
			assert_eq!(full_span, b"second line\n");
			assert!(!utf8_verified.get());
			assert!(!reader.last_line().unwrap());
		} else {
			panic!("Expected IOChunkContent::MapInput");
		}

		if let Some(content) = reader.get_line()? {
			assert_eq!(content.as_bytes(), b"last line");
			assert_eq!(content.as_str().unwrap(), "last line");
			assert!(content.utf8_verified.get());
			assert!(reader.last_line().unwrap());
			// Cached version
			assert_eq!(content.as_str().unwrap(), "last line");
		} else {
			panic!("Expected IOChunk");
		}

		assert_eq!(reader.get_line()?, None);

		Ok(())
	}

	// is_newline_terminated, is_empty
	#[test]
	fn test_owned_newline_terminated_non_empty() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned("line".to_string(), true));
		assert!(chunk.is_newline_terminated());
		assert!(!chunk.is_empty());
	}

	#[test]
	fn test_owned_newline_terminated_empty() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned(String::new(), true));
		assert!(chunk.is_newline_terminated());
		assert!(chunk.is_empty());
	}

	#[test]
	fn test_owned_not_newline_terminated() {
		let chunk = IOChunk::from_content(IOChunkContent::new_owned("line".to_string(), false));
		assert!(!chunk.is_newline_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_mmap_newline_terminated() {
		let content = b"line";
		let full_span = b"line\n";
		let chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));
		assert!(chunk.is_newline_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_mmap_not_newline_terminated() {
		let content = b"line";
		let full_span = b"line";
		let chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));
		assert!(!chunk.is_newline_terminated());
	}

	#[cfg(unix)]
	#[test]
	fn test_mmap_empty() {
		let content = b"";
		let full_span = b"";
		let chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));
		assert!(!chunk.is_newline_terminated());
	}

	// ensure_owned()
	#[test]
	fn test_ensure_owned_on_owned() {
		let mut chunk =
			IOChunk::from_content(IOChunkContent::new_owned("already owned".to_string(), true));

		let result = chunk.ensure_owned();
		assert!(result.is_ok());

		// Content must be unchanged
		match &chunk.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				assert_eq!(content, "already owned");
				assert!(*has_newline);
			},
			#[cfg(unix)]
			_ => panic!("Expected Owned variant"),
		}
	}

	#[cfg(unix)]
	#[test]
	fn test_ensure_owned_on_mmap_valid_utf8() {
		let content = b"mmap string";
		let full_span = b"mmap string\n";

		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		let result = chunk.ensure_owned();
		assert!(result.is_ok());

		match &chunk.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				assert_eq!(content, "mmap string");
				assert!(*has_newline);
			},
			_ => panic!("Expected Owned variant after ensure_owned"),
		}
	}

	#[cfg(unix)]
	#[test]
	fn test_ensure_owned_on_mmap_valid_utf8_no_newline() {
		let content = b"no newline";
		let full_span = b"no newline";

		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		let result = chunk.ensure_owned();
		assert!(result.is_ok());

		match &chunk.content {
			IOChunkContent::Owned { content, has_newline, .. } => {
				assert_eq!(content, "no newline");
				assert!(!*has_newline);
			},
			_ => panic!("Expected Owned variant after ensure_owned"),
		}
	}

	#[cfg(unix)]
	#[test]
	fn test_ensure_owned_on_mmap_invalid_utf8() {
		let content = b"bad\xFFutf8";
		let full_span = b"bad\xFFutf8\n";

		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		let result = chunk.ensure_owned();
		assert!(result.is_err());
		let err_msg = format!("{}", result.unwrap_err());
		assert!(err_msg.contains("invalid utf-8"), "Unexpected error message: {}", err_msg);
	}

	// fields_mut
	#[test]
	fn test_fields_mut_on_owned() {
		let mut chunk = IOChunk::from_content(IOChunkContent::new_owned("hello".to_string(), false));

		let (s, _) = chunk.fields_mut().unwrap();
		s.push_str(" world");

		assert_eq!(chunk.as_str().unwrap(), "hello world");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_on_mmap_input_valid_utf8() {
		let content = b"foo";
		let full_span = b"foo\n";
		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		{
			let (s, _) = chunk.fields_mut().unwrap();
			s.push_str("bar");
		}

		assert_eq!(chunk.as_str().unwrap(), "foobar");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_on_utf8_multibyte() {
		let content = "Ζωντανά!".as_bytes();
		let full_span = "Ζωντανά!\n".as_bytes();
		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		let (s, _) = chunk.fields_mut().unwrap();
		s.push_str(" Δεδομένα");

		assert_eq!(chunk.as_str().unwrap(), "Ζωντανά! Δεδομένα");
	}

	#[cfg(unix)]
	#[test]
	fn test_fields_mut_invalid_utf8() {
		let content = b"abc\xFF"; // invalid UTF-8
		let full_span = b"abc\xFF\n";
		let mut chunk = IOChunk::from_content(new_content_mmap_input(content, full_span));

		let result = chunk.fields_mut();
		assert!(result.is_err());
		assert!(format!("{}", result.unwrap_err()).contains("invalid utf-8"));
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
			mmap_chunk: None,
			pending_newline: false,
			low_level_flushes: 0,
		};
		(buf, file)
	}

	#[cfg(unix)]
	fn make_mmap_chunk(bytes: &'static [u8]) -> IOChunk<'static> {
		IOChunk {
			utf8_verified: Cell::new(true),
			content:       IOChunkContent::MmapInput { content: bytes, full_span: bytes },
		}
	}

	fn make_owned_chunk(s: &str, has_nl: bool) -> IOChunk<'_> {
		IOChunk {
			utf8_verified: Cell::new(true),
			content:       IOChunkContent::Owned {
				content:                    s.to_string(),
				has_newline:                has_nl,
				#[cfg(not(unix))]
				_phantom:                   std::marker::PhantomData,
			},
		}
	}

	#[cfg(unix)]
	#[test]
	fn mmap_new_chunk_single() {
		let (mut outbuf, _file) = new_for_test(); // OutputBuffer

		let c1 = make_mmap_chunk(b"abc");

		outbuf.write_chunk(&c1).unwrap();

		assert_eq!(outbuf.mmap_chunk.as_ref().unwrap().len, 3);
	}

	#[cfg(unix)]
	#[test]
	fn mmap_new_chunk_and_coalesce() {
		let (mut outbuf, _file) = new_for_test(); // OutputBuffer

		let backing = b"abc\nefg\n"; // contiguous buffer, newline-terminated lines
		let c1 = make_mmap_chunk(&backing[0..4]); // "abc\n"
		let c2 = make_mmap_chunk(&backing[4..8]); // "efg\n"

		outbuf.write_chunk(&c1).unwrap();
		outbuf.write_chunk(&c2).unwrap();

		assert_eq!(outbuf.mmap_chunk.as_ref().unwrap().len, 8);
	}

	#[test]
	#[cfg(unix)]
	fn mmap_not_contiguous_triggers_flush() {
		let (mut buf, _file) = new_for_test();
		let backing = b"abcdefghi";
		let c1 = make_mmap_chunk(&backing[0..4]); // "abcd"
		// Guaranteed non-coalescable.  Surprisingly, on macOS
		// passing two strings resulted in coalescible data.
		let c2 = make_mmap_chunk(&backing[5..9]); // "fghi"

		buf.write_chunk(&c1).unwrap();
		assert_eq!(buf.mmap_chunk.as_ref().unwrap().len, 4);
		buf.write_chunk(&c2).unwrap();
		// No coalescing
		assert_eq!(buf.mmap_chunk.as_ref().unwrap().len, 4);
	}

	#[test]
	#[cfg(unix)]
	fn mmap_coalesce_and_flush_blocks() {
		let (mut buf, _file) = new_for_test();
		buf.max_pending_write = 4;
		let backing = b"abcde\nfgh\n"; // contiguous newline-terminated lines
		let c1 = make_mmap_chunk(&backing[0..6]); // "abcde\n"
		let c2 = make_mmap_chunk(&backing[6..10]); // "fgh\n"

		buf.write_chunk(&c1).unwrap();
		buf.write_chunk(&c2).unwrap();
		// After a flush triggered by exceeding max_pending_write
		assert_eq!(buf.mmap_chunk.as_ref().unwrap().len, 0);
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

	// pending_newline is injected between two no-newline chunks
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

	// flush_pending_newline emits the deferred newline
	#[test]
	fn flush_pending_newline_emits_newline() {
		let (mut buf, mut file) = new_for_test();
		buf.write_chunk(&make_owned_chunk("foo", false)).unwrap();
		assert!(buf.pending_newline);
		buf.flush_pending_newline().unwrap();
		assert!(!buf.pending_newline);
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "foo\n");
	}

	// write_str strips trailing newline and sets pending_newline correctly
	#[test]
	fn write_str_with_trailing_newline() {
		let (mut buf, mut file) = new_for_test();
		buf.write_str("bar\n").unwrap();
		assert!(!buf.pending_newline);
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
		assert!(buf.pending_newline);
		buf.flush_pending_newline().unwrap();
		buf.out.flush().unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let mut out = String::new();
		file.read_to_string(&mut out).unwrap();
		assert_eq!(out, "baz\n");
	}
}
}
pub mod fast_regex {
// A unified interface to byte and fancy Regex
//
// This allows using byte Regex when possible, resorting to the
// slower fancy_regex crate when needed.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{error::Error, sync::LazyLock};

use fancy_regex::{
	CaptureMatches as FancyCaptureMatches, Captures as FancyCaptures, Regex as FancyRegex,
};
use memchr::memmem;
use regex::{
	Regex as RustRegex,
	bytes::{CaptureMatches as ByteCaptureMatches, Captures as ByteCaptures, Regex as ByteRegex},
};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::fast_io::IOChunk;

/// REs requiring the fancy_regex capabilities rather than the
/// faster regex::bytes engine
// False positives only result in a small performance pessimization,
// so this is just a maximally sensitive, good-enough approximation.
// For example, r"\\1" and r"[\1]" will match, whereas only a number
// after an odd number of backslashes and outside a character class
// should match.
static NEEDS_FANCY_RE: LazyLock<RustRegex> =
	LazyLock::new(|| regex::Regex::new(r"\\[1-9]").unwrap());

/// All characters signifying that the match must be handled by an RE
/// rather than by plain string pattern matching.
// These do not include the ^$ metacharacters, which we can easily handle.
// Plain string fixed-string matching is currently faster than Regex
// matching, because Regex always constructs an automaton and needs
// to handle state transitions, whereas plain string matching can
// use tailored CPU string or vectored instructions.
static NEEDS_RE: LazyLock<RustRegex> = LazyLock::new(|| {
	regex::Regex::new(
		r"(?x) # Turn on verbose mode
          ( ^                   # Non-escaped: i.e. at BOL
             | ^[^\\]            # or after a BOL non \
             | [^\\] {2}         # or after two non \ characters
             | \\.               # or after a consumed or escaped \
           )
           (                     # A potentially incompatible match
              [.?|+(\[{*]        # Any magic RE character
                                 # Some are operators so illegal at
                                 # BOL but they should error there,
                                 # not use them as literals.
             | \\[WwDdSsPp]      # Unicode classes
             | \\[AzBb]          # Empty matches
             | \\[0-9]           # Back-references
           )
        ",
	)
	.unwrap()
});

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
	pub fn find<'t>(&self, haystack: &'t [u8]) -> Option<(usize, usize, &'t str)> {
		self.anchored_find(haystack).and_then(|start| {
			let end = start + self.needle.len();
			std::str::from_utf8(&haystack[start..end])
				.ok()
				.map(|s| (start, end, s))
		})
	}

	/// Return all positions and contents of the matched needle.
	pub fn iter<'t>(
		&'t self,
		haystack: &'t [u8],
	) -> Box<dyn Iterator<Item = (usize, usize, &'t str)> + 't> {
		let needle = &self.needle;
		let nlen = needle.len();

		match self.match_type {
			AnchoredMatch::Both | AnchoredMatch::Begin | AnchoredMatch::End => {
				// At most one match; yield it if present
				Box::new(self.find(haystack).into_iter())
			},
			AnchoredMatch::Free => {
				// Multiple potential matches
				Box::new(memmem::find_iter(haystack, needle).filter_map(move |start| {
					let end = start + nlen;
					std::str::from_utf8(&haystack[start..end])
						.ok()
						.map(|s| (start, end, s))
				}))
			},
		}
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

#[derive(Clone, Debug)]
/// A regular expression that can be implemented in diverse efficient ways
pub enum Regex {
	Literal(LiteralMatcher), // Fastest: literal bytes
	Byte(ByteRegex),         // Slower: byte-based RE
	Fancy(FancyRegex),       // Slowest: RE supporting UTF-8 and back-references
}

/// Ensure that a regex matches GNU sed's default semantics for `.`
/// through the appropriate use of the s flag.
pub fn ensure_dotall(pattern: &str) -> String {
	// Add (?s) if no flags present.
	if !pattern.starts_with("(?") {
		return format!("(?s){pattern}");
	}

	let Some(close) = pattern.find(')') else {
		// Malformed inline flag group.
		return pattern.to_owned();
	};

	// Add s flag to ?(...) unless 's' or its complement 'm' is there.
	let flags = &pattern[2..close];

	if flags.contains('m') || flags.contains('s') {
		pattern.to_owned()
	} else {
		format!("(?{flags}s){}", &pattern[close + 1..])
	}
}

impl Regex {
	/// Construct the most efficient RE-like matching engine possible.
	pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
		if NEEDS_FANCY_RE.is_match(pattern) {
			Ok(Self::Fancy(FancyRegex::new(&ensure_dotall(pattern))?))
		} else if NEEDS_RE.is_match(pattern) {
			Ok(Self::Byte(ByteRegex::new(&ensure_dotall(pattern))?))
		} else {
			Ok(Self::Literal(LiteralMatcher::new(&remove_escapes(pattern))))
		}
	}

	/// Check if the regex matches the content of the IOChunk.
	pub fn is_match(&self, chunk: &mut IOChunk) -> SedResult<bool> {
		match self {
			Regex::Literal(m) => Ok(m.is_match(chunk.as_bytes())),
			Regex::Byte(re) => Ok(re.is_match(chunk.as_bytes())),
			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				re.is_match(text)
					.map_err(|e| SedError::new(2, e.to_string()))
			},
		}
	}

	/// Return an iterator over capture groups.
	pub fn captures_iter<'t>(&'t self, chunk: &'t IOChunk) -> SedResult<CaptureMatches<'t>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				Ok(CaptureMatches::Literal(Box::new(
					m.iter(haystack)
						.map(|(start, end, text)| Ok(Captures::Literal(Match { start, end, text }))),
				)))
			},

			Regex::Byte(re) => Ok(CaptureMatches::Byte(re.captures_iter(chunk.as_bytes()))),

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				Ok(CaptureMatches::Fancy(re.captures_iter(text)))
			},
		}
	}

	/// Return the number of capture groups, including group 0.
	pub fn captures_len(&self) -> usize {
		match self {
			Regex::Literal(_) => 1, // Only group 0
			Regex::Byte(re) => re.captures_len(),
			Regex::Fancy(re) => re.captures_len(),
		}
	}

	/// Return the elements of the first capture.
	pub fn captures<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Captures<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Captures::Literal(Match { start, end, text }))),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let bytes = chunk.as_bytes();
				Ok(re.captures(bytes).map(Captures::Byte))
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.captures(text) {
					Ok(Some(caps)) => Ok(Some(Captures::Fancy(caps))),
					Ok(None) => Ok(None),
					Err(e) => Err(SedError::new(2, e.to_string())),
				}
			},
		}
	}

	/// Return a non-capturing result for a single match.
	pub fn find<'t>(&self, chunk: &'t IOChunk) -> SedResult<Option<Match<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Match { start, end, text })),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let haystack = chunk.as_bytes();
				if let Some(m) = re.find(haystack) {
					// Attempt UTF-8 decode for the match region only
					let text = std::str::from_utf8(&haystack[m.start()..m.end()])
						.map_err(|e| SedError::new(2, e.to_string()))?;
					Ok(Some(Match { start: m.start(), end: m.end(), text }))
				} else {
					Ok(None)
				}
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.find(text) {
					Ok(Some(m)) => {
						Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() }))
					},
					Ok(None) => Ok(None),
					Err(e) => Err(SedError::new(2, e.to_string())),
				}
			},
		}
	}
}

/// Unified enum for holding either byte or fancy capture iterators.
pub enum CaptureMatches<'t> {
	Literal(Box<dyn Iterator<Item = SedResult<Captures<'t>>> + 't>),
	Byte(ByteCaptureMatches<'t, 't>),
	Fancy(FancyCaptureMatches<'t, 't>),
}

impl<'t> Iterator for CaptureMatches<'t> {
	type Item = SedResult<Captures<'t>>;

	fn next(&mut self) -> Option<Self::Item> {
		match self {
			CaptureMatches::Literal(iter) => iter.next(),
			CaptureMatches::Byte(iter) => iter.next().map(|caps| Ok(Captures::Byte(caps))),
			CaptureMatches::Fancy(iter) => match iter.next() {
				Some(Ok(caps)) => Some(Ok(Captures::Fancy(caps))),
				Some(Err(e)) => {
					Some(Err(SedError::new(2, format!("error retrieving RE captures: {e}"))))
				},
				None => None,
			},
		}
	}
}

#[derive(Clone, Debug)]
/// Result type for RE capture get(n)
pub struct Match<'t> {
	start: usize,   // Match start
	end:   usize,   // Match end
	text:  &'t str, // Actual match
}

/// Provide interface compatible with Regex::Match.
impl<'t> Match<'t> {
	pub fn start(&self) -> usize {
		self.start
	}

	pub fn end(&self) -> usize {
		self.end
	}

	pub fn as_str(&self) -> &'t str {
		self.text
	}
}

/// Provide interface compatible with Regex::Captures.
pub enum Captures<'t> {
	Literal(Match<'t>), // only group 0
	Byte(ByteCaptures<'t>),
	Fancy(FancyCaptures<'t>),
}

impl<'t> Captures<'t> {
	/// Get capture group at index `i`
	/// Returns Ok(None) if the group didn't match.
	/// Returns Err if UTF-8 conversion fails (in Byte variant).
	pub fn get(&self, i: usize) -> SedResult<Option<Match<'t>>> {
		match self {
			Captures::Literal(m) => Ok(if i == 0 { Some(m.clone()) } else { None }),
			Captures::Byte(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match {
					start: m.start(),
					end:   m.end(),
					text:  std::str::from_utf8(m.as_bytes())
						.map_err(|e| SedError::new(1, e.to_string()))?,
				})),
				None => Ok(None),
			},
			Captures::Fancy(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() })),
				None => Ok(None),
			},
		}
	}

	/// Return the number of capture groups (including group 0).
	pub fn len(&self) -> usize {
		match self {
			Captures::Literal(_) => 1,
			Captures::Byte(caps) => caps.len(),
			Captures::Fancy(caps) => caps.len(),
		}
	}

}

#[cfg(test)]
mod tests {
	use super::*;

	// FANCY_RE
	#[test]
	fn test_needs_fancy_re_matches() {
		let should_match = [
			r"(\w+):\1", // back-reference \1
		];

		for pat in &should_match {
			assert!(NEEDS_FANCY_RE.is_match(pat), "Expected NEEDS_FANCY_RE to match: {pat:?}");
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
			assert!(!NEEDS_FANCY_RE.is_match(pat), "Expected NEEDS_FANCY_RE to NOT match: {pat:?}");
		}
	}

	// NEEDS_RE
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
			assert!(NEEDS_RE.is_match(pat), "Expected NEEDS_RE to match: {pat:?}");
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
			assert!(!NEEDS_RE.is_match(pat), "Expected NEEDS_RE to NOT match: {pat:?}");
		}
	}

	// Regex::new
	#[test]
	fn assert_byte_selection() {
		let re = Regex::new(r"x*").unwrap();
		assert!(matches!(re, Regex::Byte(_)));
	}

	#[test]
	fn assert_fancy() {
		let re = Regex::new(r"(.)\1").unwrap();
		assert!(matches!(re, Regex::Fancy(_)));
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
		assert_eq!(found.2, "✓");
	}

	#[test]
	fn test_literal_matcher_find_location() {
		let matcher = LiteralMatcher::new("abc");
		let haystack = b"___abc___";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, "abc");
	}

	#[test]
	fn test_literal_matcher_find_location_end() {
		let matcher = LiteralMatcher::new("abc$");
		let haystack = b"012abc";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, "abc");
	}

	#[test]
	fn test_literal_matcher_iter_multiple() {
		let matcher = LiteralMatcher::new("test");
		let haystack = b"this test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 3);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test", "test", "test"]);
	}

	#[test]
	fn test_literal_matcher_iter_begin() {
		let matcher = LiteralMatcher::new("^test");
		let haystack = b"test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test"]);
	}

	#[test]
	fn test_literal_matcher_iter_end() {
		let matcher = LiteralMatcher::new("test$");
		let haystack = b"this test is a test of test";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test"]);
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

	#[test]
	fn leaves_malformed_flag_group_unchanged() {
		assert_eq!(ensure_dotall("(?iabc"), "(?iabc");
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

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
	fs,
	path::{Path, PathBuf},
};

use tempfile::NamedTempFile;
use uucore::display::Quotable;

use brush_core::openfiles::OpenFile;
use crate::{
	host::is_regular_file,
	sed::{
		command::ProcessingContext,
		error_handling::{IoContext, SedError, SedResult},
		fast_io::OutputBuffer,
	},
};

/// Context for in-place editing
pub struct InPlace {
	stdout:              OpenFile,
	pub output:          OutputBuffer,
	pub in_place:        bool,
	pub in_place_suffix: Option<String>,
	pub follow_symlinks: bool,
	pub temp_file:       Option<NamedTempFile>,
	pub original_path:   Option<PathBuf>,
}

impl InPlace {
	/// Create an in-place editing engine based on ProcessingContext.
	/// Depending on its settings it may or may not perform in-place
	/// editing, backup the original file, or follow symlinks.
	pub fn new_with_stdout(context: ProcessingContext, stdout: OpenFile) -> Self {
		let line_buffered = !is_regular_file(&stdout);
		Self {
			stdout: stdout.clone(),
			output:          OutputBuffer::new(Box::new(stdout.clone()), line_buffered),
			in_place:        context.in_place,
			in_place_suffix: context.in_place_suffix,
			follow_symlinks: context.follow_symlinks,
			temp_file:       None,
			original_path:   None,
		}
	}

	/// Creates an editing engine backed by an in-memory output for unit tests.
	#[cfg(test)]
	pub fn new(context: ProcessingContext) -> Self {
		let (host, _) = crate::host::Host::for_test("sed", "", ".");
		Self::new_with_stdout(context, host.stdout_clone())
	}

	/// Return an OutputBuffer for outputting the edits to the specified file.
	/// The file may be a symbolic link, which will be processed according
	/// to the context specification.
	pub fn begin(&mut self, file_name: &Path) -> SedResult<&mut OutputBuffer> {
		let resolved = if self.follow_symlinks {
			fs::canonicalize(file_name)
				.map_err_context(|| format!("resolving symlink {}", file_name.quote()))?
		} else {
			file_name.to_path_buf()
		};
		self.begin_resolved(&resolved)
	}

	/// Return an OutputBuffer for outputting the edits to the specified file.
	/// The passed file name should have resolved symbolic links according
	/// to the context settings.
	fn begin_resolved(&mut self, file_name: &Path) -> SedResult<&mut OutputBuffer> {
		if !self.in_place {
			self.output =
				OutputBuffer::new(Box::new(self.stdout.clone()), !is_regular_file(&self.stdout));
			return Ok(&mut self.output);
		}

		let metadata = fs::metadata(file_name).map_err_context(|| {
			format!("error Reading metadata of {} for in-place edit", file_name.quote())
		})?;

		if !metadata.is_file() {
			return Err(SedError::new(
				2,
				format!("cannot in-place edit non-regular file {}", file_name.quote()),
			));
		}

		let dir = file_name.parent().unwrap_or_else(|| Path::new("."));
		let temp_file = NamedTempFile::new_in(dir)
			.map_err_context(|| format!("error creating temporary file in {}", dir.quote()))?;

		// TODO: On Unix use fchown(metadata.{uid,dig}) and fchmod(mode)
		// on let fd = temp_file.as_file().as_raw_fd() when uucore::libc
		// support them.
		#[cfg(unix)]
		{
			let mode = metadata.mode() & 0o7777;
			let perms = fs::Permissions::from_mode(mode);
			fs::set_permissions(temp_file.path(), perms)?;
		}

		let output = OutputBuffer::new(
			Box::new(temp_file.reopen().expect("reopening NamedTempFile")),
			false,
		);
		self.output = output;
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
		let temp = self.temp_file.take().expect("temp_file unset");

		// Backup original if suffix is provided
		if let Some(ref suffix) = self.in_place_suffix {
			let mut backup_path = orig.clone();
			let file_name = backup_path
				.file_name()
				.expect("Missing file name for backup")
				.to_os_string();
			let mut backup_name = file_name;
			backup_name.push(suffix);
			backup_path.set_file_name(backup_name);

			#[cfg(windows)]
			// Try to remove to ensure the rename won't fail on Windows.
			let _ = fs::remove_file(&backup_path);

			fs::rename(&orig, &backup_path).map_err_context(|| {
				format!("error backing up {} to {}", orig.quote(), backup_path.quote())
			})?;
		} else {
			#[cfg(windows)]
			// On Windows delete the original file for temp.persist to work
			if orig.exists() {
				fs::remove_file(&orig).map_err_context(|| {
					format!("error removing original input file {}", orig.quote())
				})?;
			}
		}

		// Atomically replace the original
		match temp.persist(&orig) {
			Ok(_) => {},
			Err(e) => {
				return Err(SedError::io(
					e.error.kind(),
					format!(
						"error persisting temporary file {} to {}",
						e.file.path().quote(),
						orig.quote()
					),
				));
			},
		}

		Ok(())
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
		let buf = inplace.begin(file.path()).unwrap();
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
		let buf = inplace.begin(file.path()).unwrap();
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
		let buf = inplace.begin(link.path()).unwrap();
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
		let buf = inplace.begin(link.path()).unwrap();
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
		let _buf = inplace.begin(Path::new("fake.txt")).unwrap();
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
	fs::{File, OpenOptions},
	io::{BufWriter, Write},
	path::PathBuf,
	rc::Rc,
};

use uucore::display::Quotable;
use crate::sed::error_handling::SedResult;

use crate::sed::error_handling::{ScriptLocation, runtime_error};

thread_local! {
	 /// Global list of all writers that should be flushed at shutdown
	 static FLUSH_LIST: RefCell<Vec<Rc<RefCell<NamedWriter>>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Debug)]
/// Writer that tracks its file name for better error messages
pub struct NamedWriter {
	pub path: PathBuf,
	writer:   BufWriter<File>,
	location: ScriptLocation,
}

impl NamedWriter {
	/// Create a new writer, truncate the file, and register it for flushing.
	pub fn new(path: PathBuf, location: ScriptLocation) -> SedResult<Rc<RefCell<Self>>> {

		let file = OpenOptions::new()
			.create(true)
			.write(true)
			.truncate(true)
			.open(&path)
			.map_err(|e| {
				runtime_error::<()>(&location, format!("creating file {}: {}", path.quote(), e))
					.unwrap_err()
			})?;

		let writer =
			Rc::new(RefCell::new(NamedWriter { path, writer: BufWriter::new(file), location }));

		FLUSH_LIST.with(|list| list.borrow_mut().push(Rc::clone(&writer)));
		Ok(writer)
	}

	/// Write a line to the file with a newline, returning descriptive errors.
	pub fn write_line(&mut self, line: &str) -> SedResult<()> {
		writeln!(self.writer, "{line}").map_err(|e| {
			runtime_error::<()>(&self.location, format!("writing to file {}: {e}", self.path.quote()))
				.unwrap_err()
		})
	}

	/// Flush the writer, returning a descriptive error.
	pub fn flush(&mut self) -> SedResult<()> {
		self.writer.flush().map_err(|e| {
			runtime_error::<()>(
				&self.location,
				format!("writing to file {}: {}", self.path.quote(), e),
			)
			.unwrap_err()
		})
	}
}

/// Flush buffered content to the files and drop the writers, returning
/// descriptive errors.
// the registry is drained (not just
// iterated) so open files do not outlive the invocation on a reused thread.
pub fn flush_all() -> SedResult<()> {
	FLUSH_LIST.with(|cell| {
		for handle in cell.borrow_mut().drain(..) {
			handle.borrow_mut().flush()?;
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

use std::{borrow::Cow, cell::RefCell, path::PathBuf, rc::Rc};

use uucore::display::Quotable;

use crate::host::Host;
use crate::sed::error_handling::{IoContext, SedResult};

use crate::sed::{
	command::{
		Address, AppendElement, Command, CommandData, InputAction, ProcessingContext, Transliteration,
	},
	error_handling::{ScriptLocation, input_runtime_error},
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
	pattern: &mut IOChunk,
	context: &mut ProcessingContext,
	location: &ScriptLocation,
) -> SedResult<bool> {
	match addr {
		Address::Re(re) => {
			let regex = re_or_saved_re(re.as_ref(), context, location)?;
			match regex.is_match(pattern) {
				Ok(result) => Ok(result),
				Err(e) => input_runtime_error(location, context, e.to_string()),
			}
		},

		Address::Line(lineno) => Ok(context.line_number == *lineno),

		// Recognize "$" as the last line of last file. This is consistent
		// with the original 7th Research Edition implementation:
		// https://github.com/dspinellis/unix-history-repo/blob/Research-V7/usr/src/cmd/sed/sed1.c#L665
		// The FreeBSD version checked for subsequent empty files, but this
		// can lead to destructive reads (e.g. from named pipes),
		// and is probably an overkill.
		Address::Last => Ok(reader.last_line()? && (context.last_file || context.separate)),

		_ => panic!("invalid address type in match_address"),
	}
}

#[allow(dead_code)]
/// Return true if the command applies to the given pattern.
fn applies(
	command: &mut Command,
	reader: &mut LineReader,
	pattern: &mut IOChunk,
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
					if match_address(addr2, reader, pattern, context, &command.location)? {
						command.start_line = None;
						context.last_address = true;
					}
					Ok(true)
				},
			}
		} else if let Some(addr1) = &command.addr1 {
			// See if latch must start.
			if match_address(addr1, reader, pattern, context, &command.location)? {
				match addr2 {
					Address::Line(n) if linenum >= *n => {
						context.last_address = true;
					},
					Address::RelLine(n) if *n == 0 => {
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
		Ok(match_address(addr1, reader, pattern, context, &command.location)?)
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
/// Update the saved RE to RE.
fn re_or_saved_re<'a>(
	regex: Option<&Regex>,
	context: &'a mut ProcessingContext,
	location: &ScriptLocation,
) -> SedResult<&'a Regex> {
	if let Some(re) = regex {
		// First time we see this regex: clone it *once* into the context.
		context.saved_regex = Some(re.clone());
		// Return a reference into context.saved_regex.
		Ok(context.saved_regex.as_ref().unwrap())
	} else if let Some(ref saved_re) = context.saved_regex {
		// We already have one: just borrow it.
		Ok(saved_re)
	} else {
		input_runtime_error(location, context, "no previous regular expression")
	}
}

#[cfg(unix)]
fn shell_command(cmd: &str, host: &Host) -> std::process::Command {
	let mut c = std::process::Command::new("sh");
	c.arg("-c").arg(cmd);
	// run relative to the shell's cwd,
	// not the host process cwd. `output()` already keeps the child's stdio
	// away from the host's (stdin closed, stdout/stderr captured).
	c.current_dir(host.cwd());
	c.env_clear().envs(host.env());
	c
}

#[cfg(windows)]
fn shell_command(cmd: &str, host: &Host) -> std::process::Command {
	let mut c = std::process::Command::new("cmd.exe");
	c.arg("/C").arg(cmd);
	// see the unix variant above.
	c.current_dir(host.cwd());
	c.env_clear().envs(host.env());
	c
}

// Fallback if the target OS is neither Windows nor UNIX-like
#[cfg(not(any(unix, windows)))]
fn shell_command(_cmd: &str, _host: &Host) -> std::process::Command {
	unimplemented!("the 'e' substitute flag requires a platform shell (/bin/sh or cmd.exe)");
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

	let mut count = 0;
	let mut last_end = 0;
	let mut result = String::new();
	let mut replaced = false;

	let mut text: Option<&str> = None;

	let regex = re_or_saved_re(sub.regex.as_ref(), context, &command.location)?;

	// The following let block allows a common input_runtime_error to be
	// called once in all cases, and most importantly, to finish the regex
	// mutable borrowing of context, so as to reuse context in the error call.
	let subst_result = match (sub.occurrence, sub.replacement.max_group_number) {
		(1, 0) => {
			// Example: s/foo/bar/: find() is enough.
			match regex.find(pattern) {
				Err(e) => Err(e),
				Ok(Some(m)) => {
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_match(&m);
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()), // No match
			}
		},

		(1, _) => {
			// Example: s/\(.\)\(.\)/\2\1/: captures() is enough.
			match regex.captures(pattern) {
				Err(e) => Err(e),
				Ok(Some(caps)) => {
					let m = caps.get(0)?.unwrap();
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_captures(command, &caps)?;
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()), // No match
			}
		},

		(..) => {
			// Example: s/(.)(.)/\2\1/3: captures_iter() is needed.
			// Iterate over multiple captures of the RE in the pattern.
			'captures: {
				for caps_result in regex.captures_iter(pattern)? {
					let caps = match caps_result {
						Ok(caps) => caps,
						Err(e) => break 'captures Err(e),
					};
					count += 1;

					let m = caps.get(0)?.unwrap();

					// Always write the unmatched text before this match.
					if text.is_none() {
						text = Some(pattern.as_str()?);
					}
					result.push_str(&text.unwrap()[last_end..m.start()]);

					if sub.occurrence == 0 || count == sub.occurrence {
						let replacement = sub.replacement.apply_captures(command, &caps)?;
						result.push_str(&replacement);
						replaced = true;
					} else {
						// Not the target match — leave the match unchanged.
						result.push_str(m.as_str());
					}

					last_end = m.end();

					// Early exit if only a specific occurrence,
					// (likely 1) needed replacing.
					if count == sub.occurrence {
						break 'captures Ok(());
					}
				}
				break 'captures Ok(());
			}
		},
	};

	// Handle errors.
	if let Err(e) = subst_result {
		return input_runtime_error(&command.location, context, e.to_string());
	}

	// Handle substitution success.
	if replaced {
		result.push_str(&text.unwrap()[last_end..]);

		pattern.set_to_string(result, pattern.is_newline_terminated());

		// Execute the pattern space as a shell command if the 'e' flag is set
		if sub.execute {
			let cmd_str = pattern.as_str()?.to_string();
			let output_bytes = shell_command(&cmd_str, host).output().map_err(|e| {
				input_runtime_error::<()>(
					&command.location,
					context,
					format!("failed to execute shell command: {e}"),
				)
				.unwrap_err()
			})?;
			let mut shell_out = String::from_utf8_lossy(&output_bytes.stdout).into_owned();
			if shell_out.ends_with("\r\n") {
				// On windows, both return carriage and newline characters are used
				shell_out.truncate(shell_out.len() - 2);
			} else if shell_out.ends_with('\n') {
				// Strip the trailing newline, as GNU sed does
				shell_out.pop();
			}
			pattern.set_to_string(shell_out, pattern.is_newline_terminated());
		}

		if sub.print_flag {
			write_chunk(output, context, pattern)?;
		}

		// Write to file if needed.
		if let Some(ref writer) = sub.write_file {
			writer.borrow_mut().write_line(pattern.as_str()?)?;
		}
		context.substitution_made = true;
	}

	Ok(())
}

/// Apply the specified transliteration in the provided pattern space.
fn transliterate(pattern: &mut IOChunk, trans: &Transliteration) -> SedResult<()> {
	let text = pattern.as_str()?;
	let mut result = String::with_capacity(text.len());
	let mut replaced = false;

	// Perform the transliteration.
	for ch in text.chars() {
		let mapped = trans.lookup(ch);
		if mapped != ch {
			replaced = true;
		}
		result.push(mapped);
	}

	// Lazy replace.
	if replaced {
		pattern.set_to_string(result, pattern.is_newline_terminated());
	}

	Ok(())
}

/// Output any data queued for output at the end of the cycle.
fn flush_appends(output: &mut OutputBuffer, context: &mut ProcessingContext) -> SedResult<()> {
	for elem in &context.append_elements {
		match elem {
			AppendElement::Text(text) => {
				output.write_str(&**text)?;
			},
			AppendElement::Path(path) => {
				output.copy_file(path)?;
			},
		}
	}
	context.append_elements.clear();
	Ok(())
}

/// List the passed pattern space in unambiguous form.
fn list(output: &mut OutputBuffer, line: &IOChunk, max_width: usize) -> SedResult<()> {
	// Special case for an empty pattern space
	if line.is_empty() {
		if line.is_newline_terminated() {
			output.write_str("$\n")?;
		}
		return Ok(());
	}

	let line = line.as_str()?;
	let mut buff = String::new();
	let mut line_width = 0;

	for ch in line.chars() {
		if ch == '\n' {
			buff.push_str("$\n");
			output.write_str(&buff)?;
			line_width = 0;
			continue;
		}

		let mut char_buff = [0u8; 1];
		let out_str: Cow<str> = match ch {
			'\x07' => Cow::Borrowed(r"\a"),
			'\x08' => Cow::Borrowed(r"\b"),
			'\x0b' => Cow::Borrowed(r"\v"),
			'\x0c' => Cow::Borrowed(r"\f"),
			'\\' => Cow::Borrowed(r"\\"),
			'\r' => Cow::Borrowed(r"\r"),
			'\t' => Cow::Borrowed(r"\t"),
			c if c.is_ascii_control() => Cow::Owned(format!("\\{:03o}", ch as u8)),
			c if c == ' ' || c.is_ascii_graphic() => Cow::Borrowed(ch.encode_utf8(&mut char_buff)),
			c if (c as u32) <= 0xffff => Cow::Owned(format!("\\u{:04X}", c as u32)),
			_ => Cow::Owned(format!("\\U{:08X}", ch as u32)),
		};

		// See if folding is required before adding out_str and terminator.
		let out_len = out_str.len();
		if line_width + out_len + 1 > max_width {
			buff.push_str("\\\n");
			output.write_str(&buff)?;
			line_width = 0;
			buff.clear();
		}
		buff.push_str(out_str.as_ref());
		line_width += out_len;
	}

	if !buff.is_empty() {
		buff.push_str("$\n");
		output.write_str(buff)?;
	}
	Ok(())
}

/// Handle address 0 read at the beginning of each file.
fn process_address_0(
	commands: Option<Rc<RefCell<Command>>>,
	output: &mut OutputBuffer,
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
					output.copy_file(path)?;
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
	process_address_0(commands.clone(), output)?;

	// Loop over the input lines as pattern space.
	'lines: while let Some(mut pattern) = reader.get_line()? {
		// mmap-backed input never
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
				let current_line = pattern.as_str()?;
				let mut combined_lines = action.prepend;
				combined_lines.push('\n');
				combined_lines.push_str(current_line);

				pattern.set_to_string(combined_lines, pattern.is_newline_terminated());
				action.next_command
			} else {
				// Start from the script top.
				commands.clone()
			};

		// Loop over script commands.
		while let Some(command_rc) = current.take() {
			let mut command = command_rc.borrow_mut();

			if !applies(&mut command, reader, &mut pattern, context)? {
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
					if command.addr2.is_none() || context.last_address || reader.last_line()? {
						let text = extract_variant!(command, Text);
						output.write_str(text.as_ref())?;
					}
					break;
				},
				'd' => {
					// Delete the pattern space and start the next cycle.
					pattern.clear();
					break;
				},
				'D' => {
					// Delete up to \n and start a new cycle without new input.
					if let Some(pos) = pattern.as_str()?.find('\n') {
						let (s, _) = pattern.fields_mut()?;
						s.drain(..=pos);
						current.clone_from(&commands);
						continue;
					}
					// Same as d
					pattern.clear();
					break;
				},
				'g' => {
					// Replace pattern with the contents of the hold space.
					pattern.set_to_string(context.hold.content.clone(), context.hold.has_newline);
				},
				'G' => {
					// Append to pattern \n followed by hold space contents.
					let (pat_content, pat_has_newline) = pattern.fields_mut()?;
					pat_content.push('\n');
					pat_content.push_str(&context.hold.content);
					*pat_has_newline = context.hold.has_newline;
				},
				'h' => {
					// Replace hold with the contents of the pattern space.
					context.hold.content = pattern.as_str()?.to_string();
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'H' => {
					// Append to hold \n followed by pattern space contents.
					context.hold.content.push('\n');
					context.hold.content.push_str(pattern.as_str()?);
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'i' => {
					// Write text to standard output.
					let text = extract_variant!(command, Text);
					output.write_str(text.as_ref())?;
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
					// Append to pattern `\n` and the next line
					// Rather than reading input here, which would result
					// in a double borrow on reader, modify the action
					// to perform when the next line is read.
					context.input_action = Some(InputAction {
						next_command: command.next.clone(),
						prepend:      pattern.as_str()?.to_string(),
					});
					continue 'lines;
				},
				'p' => {
					write_chunk(output, context, &pattern)?;
				},
				'P' => {
					let line = pattern.as_str()?;
					if let Some(pos) = line.find('\n') {
						output.write_str(&line[..=pos])?;
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
					// Quit immediatelly.
					host.fail(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					context.quiet = true;
					break;
				},
				'r' => {
					// Copy the file to standard output at a later point.
					let path = extract_variant!(command, Path);
					context
						.append_elements
						.push(AppendElement::Path(path.clone()));
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
					writer.borrow_mut().write_line(pattern.as_str()?)?;
				},
				'x' => {
					// Exchange the contents of the pattern and hold spaces.
					let (pat_content, pat_has_newline) = pattern.fields_mut()?;

					// Swap newline if hold space is logically non-empty.
					if !context.hold.content.is_empty() || context.hold.has_newline {
						std::mem::swap(pat_has_newline, &mut context.hold.has_newline);
					}
					std::mem::swap(pat_content, &mut context.hold.content);
				},
				'y' => {
					let trans = extract_variant!(command, Transliteration);
					transliterate(&mut pattern, trans)?;
				},
				'z' => {
					// Clear the pattern contents, but preserve newline state
					// so automatic printing still emits an empty record.
					let (pat_content, _) = pattern.fields_mut()?;
					pat_content.clear();
				},
				':' => {
					// Branch target; do nothing.
				},
				'=' => {
					// Output current line number.
					output.write_str(format!("{}\n", context.line_number))?;
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

		if context.stop_processing {
			output.flush_pending_newline()?;
			break;
		}
	}

	// Handle any N command remains.
	if context.separate
		&& !context.quiet
		&& let Some(action) = context.input_action.take()
	{
		let mut pending = action.prepend;
		pending.push('\n');
		output.write_str(pending)?;
		if context.unbuffered {
			output.flush()?;
		}
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

	let mut in_place = InPlace::new_with_stdout(context.clone(), host.stdout_clone());
	let last_file_index = files.len() - 1;

	for (index, path) in files.iter().enumerate() {
		context.last_file = index == last_file_index;
		let mut reader = LineReader::open_with_host(path, host)
			.map_err_context(|| format!("error opening input file {}", path.quote()))?;
		let resolved_path = host.resolve(path);
		let output = in_place.begin(&resolved_path)?;

		if context.separate || index == 0 {
			context.line_number = 0;
			reset_latched_address_ranges(&mut context.range_commands);

			// Reset hold space for separate file processing
			context.hold.content.clear();
			context.hold.has_newline = true;
		}

		context.input_name = path.quote().to_string();
		process_file(commands.clone(), &mut reader, output, context, host)?;

		// Handle any N command remains.
		if context.last_file
			&& !context.separate
			&& !context.quiet
			&& let Some(action) = context.input_action.take()
		{
			let mut pending = action.prepend;
			pending.push('\n');
			output.write_str(pending)?;
		}

		in_place.end()?;

		if context.stop_processing {
			break;
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
	fs::File,
	io::{BufRead, BufReader},
	path::PathBuf,
};

use uucore::display::Quotable;

use brush_core::openfiles::OpenFile;
use crate::sed::error_handling::{IoContext, SedResult};

#[derive(Debug, PartialEq)]
/// The specification of a script: through a string or a file
pub enum ScriptValue {
	StringVal(String),
	PathVal(PathBuf),
}

/// The provider of script lines across all specified scripts
/// Scripts can be specified to sed as files or as strings.
pub struct ScriptLineProvider {
	sources: Vec<ScriptValue>,
	state:   State,
	stdin:   Option<OpenFile>,
	cwd:     PathBuf,
}

/// Encapsulation of the script line provider's state
enum State {
	NotStarted, // Processing has not yet started
	Active {
		index:       usize,
		reader:      Box<dyn BufRead>, // Object on which read_line is called
		input_name:  String,           // Input description (path or script string)
		line_number: usize,            // Current line number
	},
	Done, // All scripts have been processed
}

impl ScriptLineProvider {
	/// Construct the script provider from the specified script sources
	#[cfg(test)]
	pub fn new(sources: Vec<ScriptValue>) -> Self {
		Self { sources, state: State::NotStarted, stdin: None, cwd: PathBuf::from(".") }
	}

	/// Constructs a provider with the builtin stdin stream.
	pub fn with_stdin(sources: Vec<ScriptValue>, stdin: OpenFile, cwd: PathBuf) -> Self {
		Self { sources, state: State::NotStarted, stdin: Some(stdin), cwd }
	}

	/// Return the currently processed script line number.
	pub fn get_line_number(&self) -> usize {
		match &self.state {
			State::Active { line_number, .. } => *line_number,
			_ => 0,
		}
	}

	/// Return the currently processed script descriptive name.
	pub fn get_input_name(&self) -> &str {
		match &self.state {
			State::Active { input_name, .. } => input_name.as_str(),
			_ => "",
		}
	}

	/// Return the next script line to process across all scripts.
	pub fn next_line(&mut self) -> SedResult<Option<String>> {
		let mut line = String::new();

		loop {
			let advance = match &mut self.state {
				State::NotStarted => Some(0),
				State::Active { index, reader, line_number, .. } => {
					line.clear();
					let bytes = reader.read_line(&mut line)?;
					if bytes == 0 {
						Some(*index + 1) // finished reading this source
					} else {
						*line_number += 1;
						// Remove trailing newline
						if line.ends_with('\n') {
							line.pop();
						}
						return Ok(Some(line));
					}
				},
				State::Done => {
					return Ok(None);
				},
			};

			if let Some(next_index) = advance {
				self.advance_source(next_index)?;
			}
		}
	}

	// Move to the next available script source.
	fn advance_source(&mut self, next_index: usize) -> SedResult<()> {
		if next_index >= self.sources.len() {
			self.state = State::Done;
			return Ok(());
		}

		match &self.sources[next_index] {
			ScriptValue::StringVal(s) => {
				let cursor = std::io::Cursor::new(s.clone());
				self.state = State::Active {
					index:       next_index,
					reader:      Box::new(BufReader::new(cursor)),
					input_name:  format!("<script argument {}>", next_index + 1),
					line_number: 0,
				};
			},
			ScriptValue::PathVal(p) => {
				if p.to_string_lossy() == "-" {
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(self.stdin.as_ref().expect("stdin stream missing").clone())),
						input_name:  "<stdin>".to_string(),
						line_number: 0,
					};
				} else {
					// resolve `-f` script files against the shell working
					// directory, normalizing MSYS/WSL drive aliases (`/c/...`)
					// to native drive paths first — mirrors `Host::resolve`.
					let normalized = brush_core::sys::fs::normalize_shell_path(p);
					let resolved = if normalized.is_absolute() {
						normalized.into_owned()
					} else {
						self.cwd.join(normalized)
					};
					let file = File::open(resolved)
						.map_err_context(|| format!("error opening script file {}", p.quote()))?;
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(file)),
						input_name:  p.to_string_lossy().to_string(),
						line_number: 0,
					};
				}
			},
		}

		Ok(())
	}
}

impl fmt::Debug for State {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			State::NotStarted => f.debug_struct("NotStarted").finish(),
			State::Done => f.debug_struct("Done").finish(),
			State::Active { index, input_name, line_number, .. } => f
				.debug_struct("Active")
				.field("index", index)
				.field("input_name", input_name)
				.field("line_number", line_number)
				.field("reader", &"<BufRead>")
				.finish(),
		}
	}
}

#[cfg(test)]
impl ScriptLineProvider {
	pub fn with_active_state(input_name: &str, line_number: usize) -> Self {
		Self {
			sources: vec![],
			stdin: None,
			cwd: PathBuf::from("."),
			state:   State::Active {
				input_name: input_name.to_string(),
				line_number,
				index: 0,
				reader: Box::new(BufReader::new(std::io::Cursor::new(Vec::<u8>::new()))),
			},
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
			assert_eq!(provider.get_input_name(), "<script argument 1>");
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l2");
			assert_eq!(provider.get_line_number(), 2);
			assert_eq!(provider.get_input_name(), "<script argument 1>");
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l3");
			assert_eq!(provider.get_line_number(), 1);
			assert_eq!(provider.get_input_name(), "<script argument 2>");
		} else {
			panic!("Expected a line");
		}
	}
}
}

use std::{collections::HashMap, ffi::OsString, io::Write, path::PathBuf};

use brush_core::{ShellExtensions, builtins::Registration};

use clap::{Arg, ArgMatches, Command, arg};

use crate::host::{Host, Utility, format_usage, matches_parser, util};
use crate::sed::error_handling::{SedError, SedResult};

use crate::sed::{
	command::{ProcessingContext, StringSpace},
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
	let mut context = build_context(matches, host.cwd());

	let executable = compiler::compile_with_stdin(scripts, &mut context, host.stdin.file().clone(), host.resolve("."))?;
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
fn build_context(matches: &ArgMatches, cwd: &std::path::Path) -> ProcessingContext {
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
		cwd:              cwd.to_path_buf(),

		// Other context
		input_name:           "<stdin>".to_string(),
		line_number:          0,
		last_address:         false,
		last_line:            false,
		last_file:            false,
		stop_processing:      false,
		saved_regex:          None,
		input_action:         None,
		hold:                 StringSpace { content: String::new(), has_newline: true },
		parsed_block_nesting: 0,
		label_to_command_map: HashMap::new(),
		range_commands:       Vec::new(),
		substitution_made:    false,
		append_elements:      Vec::new(),
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

/// Creates the `sed` builtin registration.
pub(crate) fn sed_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sed, SE>()
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
		let ctx = build_context(&matches, std::path::Path::new("."));

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

		let ctx = build_context(&matches, std::path::Path::new("."));

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
		let ctx = build_context(&matches, std::path::Path::new("."));

		assert!(ctx.regex_extended);
	}

	#[test]
	fn test_in_place_with_suffix() {
		let matches = test_matches(&["-i.bak"]);
		let ctx = build_context(&matches, std::path::Path::new("."));

		assert!(ctx.in_place);
		assert_eq!(ctx.in_place_suffix, Some(".bak".to_string()));
	}

	#[test]
	fn test_bsd_empty_in_place_suffix_with_short_flag_cluster() {
		// clap accepts `-Ei` as `-E -i`, so the BSD empty suffix must be
		// removed from this valid GNU flag cluster as well.
		let matches = test_matches(&["-Ei", "", "s/x/y/", "file.txt"]);
		let ctx = build_context(&matches, std::path::Path::new("."));

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

		let ctx_default = build_context(&matches_default, std::path::Path::new("."));
		let ctx_custom = build_context(&matches_custom, std::path::Path::new("."));

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
	fn builtin_propagates_q_status() {
		let (code, capture) = crate::host::run_util::<Sed>(&["2q42"], "one\ntwo\nthree\n", "/");
		assert_eq!(code, 42);
		assert_eq!(capture.out(), "one\ntwo\n");
	}

	#[test]
	fn builtin_supports_null_records() {
		let (code, capture) = crate::host::run_util::<Sed>(&["-z", "s/a/X/"], "a\0b\0", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.stdout(), b"X\0b\0");
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
}
