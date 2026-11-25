//! Sloppy payload parsing: section headers → internal op stream →
//! [`super::types::Operation`]s, including every parse-time recovery.
//! Port of `packages/coding-agent/src/edit/sloppy.ts` lines 1–1650.

use std::{
	borrow::Cow,
	collections::{HashMap, HashSet},
	fmt::Write as _,
	sync::LazyLock,
};

use regex::Regex;

use super::{
	apply::{
		closest_desired_block, diff_shaped_candidates, is_diff_shaped, locate, normalize_text,
		parse_pattern,
	},
	types::{InlineSloppyRegion, Operation, OperationRewrite, Placement, SloppySection, markers},
};
use crate::error::EditError;

const OPENER: &str = markers::OPEN;
const REWRITE_HEADER: &str = markers::PUT;
// JSON keeps literal insertion lines out of legacy rewrite recovery and control
// parsing.
const AFTER_HEADER: &str = "\0AFTER ";
const BEFORE_HEADER: &str = "\0BEFORE ";
// A legacy marked Find is already a complete edit. Keep its pattern opaque
// on the second normalization pass so none of its rows can open another op.
const EMBEDDED_HEADER: &str = "\0EMBEDDED ";
// A Block selector is one literal row on its opener. Replace, like Insert,
// carries a JSON body so literal block edits never enter legacy recovery.
const BLOCK_HEADER: &str = "\0BLOCK ";
const BLOCK_REPLACE_HEADER: &str = "\0LITERAL REPLACE ";
// Body-less actions closing a `*** Find`.
const CUT_LINE: &str = "\0CUT";
const PASTE_AFTER_LINE: &str = "\0PASTE AFTER";
const PASTE_BEFORE_LINE: &str = "\0PASTE BEFORE";
const SELECT_OPEN: &str = markers::SELECT_OPEN;
const SELECT_CLOSE: &str = markers::SELECT_CLOSE;
const SELECT_DIVIDER: &str = markers::SELECT_DIVIDER;
const GAP: &str = markers::GAP;
const ADD_LINE: &str = markers::ADD;
const REMOVE_LINE: &str = markers::REMOVE;

const LITERAL_OPEN: &str = "\0V8LITOPEN\0";
const LITERAL_CLOSE: &str = "\0V8LITCLOSE\0";
const LITERAL_DIVIDER: &str = "\0V8LITDIV\0";

macro_rules! regex {
	($name:ident, $pattern:literal) => {
		static $name: LazyLock<Regex> = LazyLock::new(|| {
			Regex::new($pattern).expect(concat!("valid ", stringify!($name), " regex"))
		});
	};
}

regex!(
	HEADER_RE,
	r"(?iu)^\*{3}[ \t]+(Edit[ \t]+File|Find|(?:(?:Replace|Delete|Cut|Insert(?:[ \t]+(?:Before|After))?|Paste[ \t]+(?:Before|After))[ \t]+)?Block|Replace|Insert[ \t]+After|Insert[ \t]+Before|Cut|Paste[ \t]+After|Paste[ \t]+Before)(:|[ \t]|$)(.*)$"
);
regex!(ENVELOPE_WORDS_RE, r"(?iu)^\s*(?:Begin|End)(?:\s+of)?\s+(?:patch|edits?|file)\b");
regex!(
	ENVELOPE_LINE_RE,
	r"(?iu)^\*{3}\s*(?:(?:Begin|End)(?:\s+of)?\s+(?:patch|edits?|file)|Abort|Update File:|Add File:|Delete File:)"
);
regex!(ENVELOPE_END_RE, r"(?iu)^\*{3}\s*End\b");
regex!(FENCE_LINE_RE, r"^\s*(?:```|~~~)");
regex!(ORDINAL_OPENER_RE, r"^«[1-9]\d*$");
regex!(OUTER_FENCE_RE, r"(?iu)^```(?:text|xml|html|typescript|ts|tsx|javascript|js)?\s*$");
regex!(GLUED_CONTROL_RE, r"^[ \t]*(«\*?|»)([ \t]+\S.*)$");
regex!(SHOWING_LINES_RE, r"(?iu)^\[(?:Showing lines\b|(?:…|\.\.\.)\d+ln elided\b).*\]$");
regex!(ELIDED_LINE_RE, r"^\d+(?:-\d+)?:\s*(?:…|\.\.\.)\s*$");
regex!(
	READ_MORE_NOTICE_RE,
	r"(?iu)^\[\s*(?:\d+\s+)?more\s+lines?\s+in\s+.+\.\s+use\s+.+\s+to\s+continue\]$"
);
regex!(NUMBERED_LINE_RE, r"^\s*\d+\s*[:|]");
regex!(NUMBERED_LITERAL_RE, r#"^\s*\d+\s*[:|]\s*(?:\d|[\"'`])"#);
regex!(SELECTION_ONLY_RE, r"^\x{27EA}([^\x{27EA}\x{27EB}]*)\x{27EB}$");
regex!(REFERENCE_RE, r"^»([1-9]\d*)$");
regex!(BARE_DESIRED_RE, r"\x{27EA}[^\x{27EA}\x{27EB}\x{2502}\n…]+\x{27EB}");
regex!(BARE_DESIRED_CAPTURE_RE, r"\x{27EA}([^\x{27EA}\x{27EB}\x{2502}\n…]+)\x{27EB}");
regex!(UNICODE_TOKEN_RE, r"[\p{L}\p{N}_$]+");
regex!(
	STRAY_DIVIDER_RE,
	r"\x{27EA}([^\x{27EA}\x{27EB}\x{2502}\n]*)\x{27EB}([^\x{27EA}\x{27EB}\x{2502}\n]*)\x{27EB}"
);
regex!(
	DIRECTIVE_RE,
	r"^\x{27EA}([^\x{27EA}\x{27EB}\x{2502}]+)\x{2502}([^\x{27EA}\x{27EB}\x{2502}]*)\x{27EB}$"
);
regex!(EMPTY_SELECTION_TAIL_RE, r"(?:^|\n)[ \t]*\x{27EA}\x{27EB}[ \t]*$");

#[derive(Debug)]
enum Header<'a> {
	Edit {
		path: Option<String>,
		all:  bool,
	},
	/// `*** Find`, or `*** Find all` to change every match of this operation.
	Find {
		all: bool,
	},
	Action(Action),
	Block(BlockAction, &'a str),
	InvalidBlock(&'static str),
}

#[derive(Debug, Clone, Copy)]
enum BlockAction {
	Cut,
	Paste(Placement),
	Delete,
	Replace,
}

impl BlockAction {
	const fn header(self) -> &'static str {
		match self {
			Self::Cut => "*** Cut Block",
			Self::Paste(Placement::Before) => "*** Paste Before Block",
			Self::Paste(Placement::After) => "*** Paste After Block",
			Self::Delete => "*** Delete Block",
			Self::Replace => "*** Replace Block",
		}
	}
}

/// What a `*** Find` is followed by.
#[derive(Debug, Clone, Copy)]
enum Action {
	Replace,
	Insert(Placement),
	Cut,
	Paste(Placement),
}

impl Action {
	/// The `*** ` header naming this action.
	const fn header(self) -> &'static str {
		match self {
			Self::Replace => "*** Replace",
			Self::Insert(at) => at.header(),
			Self::Cut => "*** Cut",
			Self::Paste(at) => at.paste_header(),
		}
	}
}

struct RewriteBody {
	lines:  Vec<String>,
	action: Action,
}

/// The grammar allows one operator per `*** Find`; a second one can only
/// discard the staged body, so refuse the payload instead of silently
/// dropping it.
///
/// The lead phrase is shared with [`is_header_pair_error`] so region
/// extraction can recognize a payload the edit pipeline must report. The full
/// message stays byte-identical: models are trained on these strings.
const CONFLICTING_OPERATORS_LEAD: &str = "*** Find is followed by both";
fn conflicting_operators(staged: &str, incoming: &str) -> EditError {
	parse_error(format!(
		"{CONFLICTING_OPERATORS_LEAD} {staged} and {incoming}. Use exactly one of *** Replace, *** \
		 Insert Before, or *** Insert After per *** Find."
	))
}

const MISSING_ACTION: &str = "Incomplete edit has *** Find but no *** Replace or other action. \
                              Send one complete pair: *** Find with current text, then *** \
                              Replace with new text.";

const OLD_BLOCK_ERROR: &str = "Invalid block edit: standalone *** Block is not supported. Put the \
                               action and opening-line prefix together, e.g. *** Delete Block: \
                               <opening-line prefix>.";
const BLOCK_SELECTOR_ERROR: &str =
	"Invalid block edit: follow the action with a colon and a nonblank opening-line prefix.";
const BLOCK_REPLACE_EMPTY: &str = "Invalid block edit: *** Replace Block needs a nonempty \
                                   replacement body. To delete the block, use *** Delete Block: \
                                   <opening-line prefix>.";
const BLOCK_ALL_ERROR: &str = "Invalid block edit: a block selects one unique opener; drop all.";

/// Region extraction preserves recognizable header errors for the pipeline
/// to report instead of completing the turn with no tool call.
fn is_header_pair_error(error: &EditError) -> bool {
	matches!(error, EditError::Parse { message, .. } if message == MISSING_ACTION
		|| message.starts_with("Invalid block edit:") || message.starts_with(CONFLICTING_OPERATORS_LEAD))
}

/// Internal op-stream prefix carrying a JSON-encoded insertion body.
const fn insert_header(at: Placement) -> &'static str {
	match at {
		Placement::Before => BEFORE_HEADER,
		Placement::After => AFTER_HEADER,
	}
}

/// Internal op-stream line for a paste at `at`.
const fn paste_line(at: Placement) -> &'static str {
	match at {
		Placement::Before => PASTE_BEFORE_LINE,
		Placement::After => PASTE_AFTER_LINE,
	}
}

/// The body-less action an internal op-stream line stands for.
fn bodyless_action(line: &str) -> Option<Action> {
	match line {
		CUT_LINE => Some(Action::Cut),
		PASTE_BEFORE_LINE => Some(Action::Paste(Placement::Before)),
		PASTE_AFTER_LINE => Some(Action::Paste(Placement::After)),
		_ => None,
	}
}

/// Split an internal insertion line into its placement and JSON body.
fn strip_insert_header(line: &str) -> Option<(Placement, &str)> {
	line
		.strip_prefix(AFTER_HEADER)
		.map(|encoded| (Placement::After, encoded))
		.or_else(|| {
			line
				.strip_prefix(BEFORE_HEADER)
				.map(|encoded| (Placement::Before, encoded))
		})
}

#[derive(Debug)]
struct CompiledSection {
	path: String,
	ir:   Vec<String>,
}

fn parse_error(message: impl Into<String>) -> EditError {
	EditError::parse(message)
}

fn js_len(text: &str) -> usize {
	text.encode_utf16().count()
}

fn parse_header(line: &str) -> Option<Header<'_>> {
	let trimmed = line.trim_start();
	if !trimmed.starts_with("***") {
		return None;
	}
	let captures = HEADER_RE.captures(trimmed.trim_end())?;
	let name = captures.get(1)?.as_str().to_ascii_lowercase();
	let tail = &trimmed[captures.get(3)?.start()..];
	if name.ends_with("block") {
		let action = match name.split_ascii_whitespace().next()? {
			"cut" => BlockAction::Cut,
			"delete" => BlockAction::Delete,
			"replace" => BlockAction::Replace,
			"paste" if name.contains("before") => BlockAction::Paste(Placement::Before),
			"paste" => BlockAction::Paste(Placement::After),
			"insert" => {
				return Some(Header::InvalidBlock(
					"Invalid block edit: for insertion use *** Find followed by *** Insert Before or \
					 *** Insert After.",
				));
			},
			_ => return Some(Header::InvalidBlock(OLD_BLOCK_ERROR)),
		};
		if &captures[2] != ":" || tail.trim().is_empty() {
			return Some(Header::InvalidBlock(BLOCK_SELECTOR_ERROR));
		}
		// One optional separator space belongs to the header. Everything else,
		// including source indentation, annotations and trailing spaces, is
		// literal.
		return Some(Header::Block(action, tail.strip_prefix(' ').unwrap_or(tail)));
	}
	let rest = tail.trim();
	if name.starts_with("edit") {
		let (path, all) = if rest.eq_ignore_ascii_case("all") {
			("", true)
		} else if let Some((path, flag)) = rest.rsplit_once(char::is_whitespace)
			&& flag.eq_ignore_ascii_case("all")
		{
			(path.trim_end(), true)
		} else {
			(rest, false)
		};
		let path = if path.is_empty() {
			None
		} else if path.starts_with('"') {
			Some(serde_json::from_str::<String>(path).ok()?).filter(|path| !path.is_empty())
		} else {
			Some(path.to_owned())
		};
		return Some(Header::Edit { path, all });
	}
	if name == "find" && rest.eq_ignore_ascii_case("all") {
		return Some(Header::Find { all: true });
	}
	if !rest.is_empty() {
		return None;
	}
	let at = if name.ends_with("before") {
		Placement::Before
	} else {
		Placement::After
	};
	Some(match name.as_str() {
		"find" => Header::Find { all: false },
		"replace" => Header::Action(Action::Replace),
		"cut" => Header::Action(Action::Cut),
		name if name.starts_with("paste") => Header::Action(Action::Paste(at)),
		_ => Header::Action(Action::Insert(at)),
	})
}

fn envelope_words(line: &str) -> bool {
	ENVELOPE_WORDS_RE.is_match(line)
}

/// These spellings are ambiguous with source text. Never teach them to
/// `parse_header`, which also runs on inline prose and compiled file bodies.
fn file_alias(line: &str) -> Option<&str> {
	let line = line.trim();
	if !line.starts_with("*** ") {
		return None;
	}
	[
		"*** Update File:",
		"*** Begin Edit File:",
		"*** Begin File:",
		"*** Input - File:",
		"*** Patch File:",
	]
	.iter()
	.find_map(|prefix| line.strip_prefix(prefix))
	.map(str::trim)
}

fn foreign_action(line: &str) -> bool {
	let line = line.trim();
	["*** Add File:", "*** Delete File:", "*** Move to:"]
		.iter()
		.any(|prefix| line.starts_with(prefix))
}

fn envelope_line(line: &str) -> bool {
	// File instructions aren't noise. An unaccompanied one in a Find or
	// replacement can itself be the line being edited.
	ENVELOPE_LINE_RE.is_match(line) && file_alias(line).is_none() && !foreign_action(line)
}

/// Remove foreign patch envelopes and the noise following end sentinels.
///
/// Insert bodies are literal, so envelope rows inside them are kept. A closing
/// sentinel (`*** End`, `*** End Patch`, …) ending a Replace or Insert body is
/// never content: before blank or fence lines only it closes the payload, and
/// before a header or envelope row it closes that one body, so the operations
/// after it still apply. Find bodies keep such lines, so a stray one can be
/// matched and removed.
pub fn strip_envelope_noise(lines: Vec<&str>) -> Vec<String> {
	clean_envelope(lines.into_iter().map(str::to_owned).collect())
}

fn clean_envelope(mut lines: Vec<String>) -> Vec<String> {
	let mut result = Vec::with_capacity(lines.len());
	let mut skipping = false;
	let mut inserting = false;
	let mut writing = false;
	let mut index = 0;
	while index < lines.len() {
		let mut line = std::mem::take(&mut lines[index]);
		let header = parse_header(&line);
		if let Some(header) = &header {
			inserting = !skipping
				&& matches!(
					header,
					Header::Action(Action::Insert(_)) | Header::Block(BlockAction::Replace, _)
				);
			writing = inserting || !skipping && matches!(header, Header::Action(Action::Replace));
		} else if writing && ENVELOPE_END_RE.is_match(line.trim()) {
			match lines[index + 1..]
				.iter()
				.find(|rest| !rest.trim().is_empty() && !FENCE_LINE_RE.is_match(rest))
			{
				None => break,
				Some(next) if parse_header(next).is_some() || envelope_line(next.trim()) => {
					index += 1;
					continue;
				},
				Some(_) => {},
			}
		}
		if inserting && header.is_none() {
			result.push(line);
			index += 1;
			continue;
		}
		if line.trim() == "***" && index + 1 < lines.len() && envelope_words(&lines[index + 1]) {
			line = format!("*** {}", lines[index + 1].trim());
			index += 1;
		}
		if envelope_line(line.trim()) {
			skipping = ENVELOPE_END_RE.is_match(line.trim());
			index += 1;
			continue;
		}
		if skipping {
			if matches!(parse_header(&line), Some(Header::Edit { .. })) {
				skipping = false;
				result.push(line);
			}
			index += 1;
			continue;
		}
		result.push(line);
		index += 1;
	}
	result
}

fn trim_blank(buffer: &[String]) -> Vec<String> {
	let start = buffer
		.iter()
		.position(|line| !line.trim().is_empty())
		.unwrap_or(buffer.len());
	let end = buffer
		.iter()
		.rposition(|line| !line.trim().is_empty())
		.map_or(start, |index| index + 1);
	buffer[start..end].to_vec()
}

/// Check a header-authored Find before it loses its provenance in the IR.
fn finish_find(lines: &mut Vec<String>, streaming: bool) -> Result<(), EditError> {
	if lines.iter().any(|line| line.contains(['⟪', '＋', '－'])) {
		let start = lines
			.iter()
			.position(|line| !line.trim().is_empty())
			.unwrap_or(0);
		let source = normalize_block(&lines[start..], Side::Find);
		if has_inline_selection(&source) || has_marker_lines(&source) {
			let encoded = serde_json::to_string(&source).expect("string serialization");
			lines.clear();
			lines.push(format!("{EMBEDDED_HEADER}{encoded}"));
			return Ok(());
		}
	}
	if !streaming {
		return Err(parse_error(MISSING_ACTION));
	}
	lines.clear();
	Ok(())
}

fn section_ir(sections: &mut Vec<CompiledSection>) -> &mut Vec<String> {
	if sections.is_empty() {
		sections.push(CompiledSection { path: String::new(), ir: Vec::new() });
	}
	&mut sections.last_mut().expect("section exists").ir
}

fn compile_block(
	sections: &mut Vec<CompiledSection>,
	action: BlockAction,
	selector: &str,
	body: &[String],
	streaming_tail: bool,
) -> Result<(), EditError> {
	if !matches!(action, BlockAction::Replace) && body.iter().any(|line| !line.trim().is_empty()) {
		return Err(parse_error(format!(
			"Invalid block edit: {} takes no body. Start the next operation with a new header.",
			action.header()
		)));
	}
	let instruction = match action {
		BlockAction::Delete => format!("{BLOCK_REPLACE_HEADER}\"\""),
		BlockAction::Cut => CUT_LINE.to_owned(),
		BlockAction::Paste(at) => paste_line(at).to_owned(),
		BlockAction::Replace => {
			let text = body.join("\n");
			if text.is_empty() {
				return if streaming_tail {
					Ok(())
				} else {
					Err(parse_error(BLOCK_REPLACE_EMPTY))
				};
			}
			let encoded = serde_json::to_string(&text).expect("string serialization");
			format!("{BLOCK_REPLACE_HEADER}{encoded}")
		},
	};
	let ir = section_ir(sections);
	ir.push(format!("{BLOCK_HEADER}{selector}"));
	ir.push(instruction);
	Ok(())
}

fn flush_compiled(
	sections: &mut Vec<CompiledSection>,
	all: bool,
	find_lines: &mut Vec<String>,
	put_lines: &mut Option<RewriteBody>,
) {
	let find = trim_blank(find_lines);
	let put = put_lines.take();
	find_lines.clear();
	if find.is_empty()
		&& put.as_ref().is_none_or(|rewrite| {
			matches!(rewrite.action, Action::Replace)
				&& rewrite.lines.iter().all(|line| line.trim().is_empty())
		}) {
		return;
	}
	let ir = section_ir(sections);
	ir.push(format!("{OPENER}{}", if all { "*" } else { "" }));
	match &put {
		Some(RewriteBody { lines, action: Action::Insert(at) }) => {
			ir.extend(find);
			let mut text = lines.join("\n");
			if !lines.is_empty() {
				text.push('\n');
			}
			ir.push(format!(
				"{}{}",
				insert_header(*at),
				serde_json::to_string(&text).expect("string serialization")
			));
			return;
		},
		Some(RewriteBody { action: Action::Cut, .. }) => {
			ir.extend(find);
			ir.push(CUT_LINE.to_owned());
			return;
		},
		Some(RewriteBody { action: Action::Paste(at), .. }) => {
			ir.extend(find);
			ir.push(paste_line(*at).to_owned());
			return;
		},
		Some(RewriteBody { action: Action::Replace, .. }) | None => {},
	}
	let put = put.map(|rewrite| trim_blank(&rewrite.lines));
	if find.is_empty() {
		if let Some(put) = put {
			ir.extend(put);
		}
		return;
	}
	ir.extend(find);
	if let Some(put) = put {
		ir.push(REWRITE_HEADER.to_owned());
		ir.extend(put);
	}
}

/// Compile payload lines into per-file internal op streams.
fn compile_sections(
	lines: &[String],
	streaming: bool,
	recovered: bool,
) -> Result<Vec<CompiledSection>, EditError> {
	#[derive(Clone, Copy)]
	enum State<'a> {
		Idle,
		Legacy,
		Find,
		Put,
		Block { action: BlockAction, selector: &'a str, body_start: usize },
	}

	let mut sections = Vec::new();
	// `all` holds for the file section (`*** Edit File: path all`), `find_all`
	// for the operation being collected (`*** Find all`).
	let mut all = false;
	let mut find_all = false;
	let mut state = State::Idle;
	let mut find_lines = Vec::new();
	let mut put_lines: Option<RewriteBody> = None;

	for (index, line) in lines.iter().enumerate() {
		let Some(header) = parse_header(line) else {
			match state {
				State::Put => put_lines
					.as_mut()
					.expect("put buffer exists")
					.lines
					.push(line.clone()),
				State::Find | State::Legacy => find_lines.push(line.clone()),
				State::Idle if !line.trim().is_empty() => {
					if recovered {
						return Err(parse_error(
							"Expected a *** Find or block selector before edit text.",
						));
					}
					state = State::Legacy;
					find_lines.push(line.clone());
				},
				State::Idle | State::Block { .. } => {},
			}
			continue;
		};
		if let State::Block { action, selector, body_start } = state {
			compile_block(&mut sections, action, selector, &lines[body_start..index], false)?;
			if let Header::Action(next) = header {
				return Err(parse_error(format!(
					"Invalid block edit: {} already names its action. Start a new selector before {}.",
					action.header(),
					next.header()
				)));
			}
		} else if !matches!(header, Header::Action(_)) {
			if matches!(state, State::Find) {
				finish_find(&mut find_lines, false)?;
			}
			flush_compiled(&mut sections, all || find_all, &mut find_lines, &mut put_lines);
		}
		let action = match header {
			Header::Edit { path, all: next_all } => {
				state = State::Idle;
				if let Some(path) = path {
					sections.push(CompiledSection { path, ir: Vec::new() });
				}
				all = next_all;
				find_all = false;
				continue;
			},
			Header::Find { all: next_all } => {
				state = State::Find;
				find_all = next_all;
				continue;
			},
			Header::Block(action, selector) => {
				if all {
					return Err(parse_error(BLOCK_ALL_ERROR));
				}
				state = State::Block { action, selector, body_start: index + 1 };
				find_all = false;
				continue;
			},
			Header::InvalidBlock(message) => return Err(parse_error(message)),
			Header::Action(action) => action,
		};
		if let Some(staged) = &put_lines {
			return Err(conflicting_operators(staged.action.header(), action.header()));
		}
		if recovered
			&& (!matches!(state, State::Find) || find_lines.iter().all(|row| row.trim().is_empty()))
		{
			return Err(parse_error("An edit action needs its own nonempty *** Find selector."));
		}
		put_lines = Some(RewriteBody { lines: Vec::new(), action });
		if matches!(action, Action::Cut | Action::Paste(_)) {
			// Body-less: the operation is complete at its header.
			flush_compiled(&mut sections, all || find_all, &mut find_lines, &mut put_lines);
			state = State::Idle;
			find_all = false;
		} else {
			state = State::Put;
		}
	}
	if let State::Block { action, selector, body_start } = state {
		compile_block(&mut sections, action, selector, &lines[body_start..], streaming)?;
	} else {
		if matches!(state, State::Find) {
			finish_find(&mut find_lines, streaming)?;
		}
		flush_compiled(&mut sections, all || find_all, &mut find_lines, &mut put_lines);
	}
	Ok(sections)
}

/// Only an explicit tool payload starting in the recovered dialect opts
/// into its aliases. A canonical file's Find/Replace/Insert bodies are
/// source text, not places to discover new targets.
fn tool_lines(input: &str, partial: bool) -> Result<(Vec<String>, bool), EditError> {
	let mut lines: Vec<_> = input.lines().map(str::to_owned).collect();
	let Some(first) = lines.iter().position(|row| !row.trim().is_empty()) else {
		return Ok((lines, false));
	};
	if !lines[first].trim_start().starts_with("***") {
		return Ok((lines, false));
	}
	let wrapper = matches!(lines[first].trim(), "*** Begin" | "*** Input" | "*** Start Patch");
	let start = if wrapper || lines[first].trim() == "*** Begin Patch" {
		(first + 1..lines.len())
			.find(|&index| !lines[index].trim().is_empty())
			.unwrap_or(lines.len())
	} else {
		first
	};
	let recovered = wrapper
		|| lines
			.get(start)
			.is_some_and(|line| file_alias(line).is_some());
	let invalid = || {
		parse_error(
			"Expected an explicit file target followed by a sloppy selector. Use *** Edit File: path \
			 and *** Find.",
		)
	};
	let mixed =
		|| parse_error("Do not mix sloppy selectors and patch hunks or file actions in one edit.");
	if recovered {
		if !lines.get(start).is_some_and(|line| {
			file_alias(line).is_some()
				|| matches!(parse_header(line), Some(Header::Edit { path: Some(_), .. }))
		}) {
			return Err(invalid());
		}
		if start != first {
			lines[first].clear();
		}
		if let Some(end) = lines.iter().rposition(|row| !row.trim().is_empty())
			&& matches!(lines[end].trim(), "*** End" | "*** End Patch")
		{
			lines.truncate(end);
		}
	}

	let mut body_closers = false;
	let mut literal_body = false;
	for index in start..lines.len() {
		let line = lines[index].trim();
		if recovered && line.starts_with("@@") {
			return Err(mixed());
		}
		if !line.starts_with("***") {
			continue;
		}
		if !recovered && let Some(header) = parse_header(line) {
			literal_body = matches!(
				header,
				Header::Action(Action::Insert(_)) | Header::Block(BlockAction::Replace, _)
			);
			continue;
		}
		if recovered && matches!(line, "*** Begin" | "*** Input" | "*** Start Patch") {
			return Err(invalid());
		}
		let next = lines[index + 1..]
			.iter()
			.map(|row| row.trim())
			.find(|row| !row.is_empty());
		let selector =
			|| matches!(next.and_then(parse_header), Some(Header::Find { .. } | Header::Block(..)));
		if foreign_action(line) {
			if recovered
				|| selector()
				|| !literal_body && next.is_some_and(|row| row.starts_with(['+', '@']))
			{
				return Err(mixed());
			}
			continue;
		}
		let alias = file_alias(line);
		if !recovered {
			if alias.is_some()
				&& (selector() || !literal_body && next.is_some_and(|row| row.starts_with("@@")))
			{
				// Could be a second target, not a literal row. Never apply
				// its selector to the preceding canonical file instead.
				return Err(mixed());
			}
			continue;
		}
		if let Some(path) = alias {
			// Don't turn a trailing " all" in an Update File path into an
			// all-matches instruction for a different file.
			let path = if path.starts_with('"') {
				Cow::Owned(serde_json::from_str::<String>(path).map_err(|_| invalid())?)
			} else {
				Cow::Borrowed(path)
			};
			if path.is_empty() || !partial && !selector() {
				return Err(invalid());
			}
			lines[index] = format!("*** Edit File: {}", header_path(&path));
		} else if let Some(Header::Edit { path, .. }) = parse_header(line) {
			if path.is_none() || !partial && !selector() {
				return Err(invalid());
			}
		} else if matches!(line, "*** End" | "*** End Patch")
			&& selector()
			&& matches!(
				lines[..index]
					.iter()
					.rev()
					.find_map(|row| parse_header(row)),
				Some(
					Header::Action(Action::Replace | Action::Insert(_))
						| Header::Block(BlockAction::Replace, _)
				)
			) {
			// The model closed each replacement, not the file. Let the same
			// envelope pass as canonical input remove the intervening marker.
			body_closers = true;
		} else if envelope_line(line) || ENVELOPE_END_RE.is_match(line) {
			return Err(mixed());
		}
	}

	Ok((
		if recovered && !body_closers {
			lines
		} else {
			clean_envelope(lines)
		},
		recovered,
	))
}

/// Split a sloppy payload into ordered, same-path-coalesced file sections.
///
/// Fails when one `*** Find` carries more than one operator: the second
/// operator can only discard the body the first one staged.
pub fn split_sloppy_sections(input: &str) -> Result<Vec<SloppySection>, EditError> {
	split_sloppy_sections_for_preview(input, false)
}

/// A preview may omit a trailing Find without its action or Replace Block
/// without its body.
pub(super) fn split_sloppy_sections_for_preview(
	input: &str,
	streaming: bool,
) -> Result<Vec<SloppySection>, EditError> {
	let mut sections = all_sections(input, streaming)?;
	sections.retain(|section| !section.body.is_empty());
	Ok(sections)
}

/// Includes declared targets without operations so inspection can report a
/// streaming file header without compiling the entire payload a second time.
pub(super) fn all_sections(input: &str, streaming: bool) -> Result<Vec<SloppySection>, EditError> {
	let (mut lines, recovered) = tool_lines(input, streaming)?;
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	if !matches!(
		parse_header(lines.first().map_or("", String::as_str)),
		Some(Header::Edit { path: Some(_), .. })
	) {
		return Ok(Vec::new());
	}
	let sections = compile_sections(&lines, streaming, recovered)?;
	let mut bodies: HashMap<String, Vec<String>> = HashMap::new();
	let mut paths = Vec::new();
	for section in sections {
		if section.path.is_empty() {
			continue;
		}
		if !bodies.contains_key(&section.path) {
			paths.push(section.path.clone());
		}
		bodies.entry(section.path).or_default().extend(section.ir);
	}
	Ok(paths
		.into_iter()
		.map(|path| SloppySection { body: bodies.remove(&path).unwrap_or_default().join("\n"), path })
		.collect())
}

/// File targets visible to the approval gate and renderer before their
/// selectors have actions. A path is not evidence of an executable edit.
pub(super) fn declared_paths(input: &str) -> Vec<String> {
	let mut paths = Vec::new();
	let Ok((lines, _)) = tool_lines(input, true) else {
		return paths;
	};
	let mut headers = lines
		.iter()
		.skip_while(|line| line.trim().is_empty())
		.peekable();
	if !matches!(
		headers.peek().and_then(|line| parse_header(line)),
		Some(Header::Edit { path: Some(_), .. })
	) {
		return paths;
	}
	for line in headers {
		if let Some(Header::Edit { path: Some(path), .. }) = parse_header(line)
			&& !paths.contains(&path)
		{
			paths.push(path);
		}
	}
	paths
}

/// Extract pathful sloppy payloads embedded in prose, using UTF-16 offsets.
pub fn extract_inline_sloppy_regions(text: &str) -> Vec<InlineSloppyRegion> {
	if !text.contains("***") {
		return Vec::new();
	}
	let lines: Vec<&str> = text.split('\n').collect();
	let mut starts = Vec::with_capacity(lines.len());
	let mut position = 0;
	for line in &lines {
		starts.push(position);
		position += line.encode_utf16().count() + 1;
	}
	let text_length = text.encode_utf16().count();
	let line_end =
		|index: usize| (starts[index] + lines[index].encode_utf16().count() + 1).min(text_length);
	let mut regions = Vec::new();
	let mut in_fence = false;
	let mut index = 0;
	while index < lines.len() {
		let line = lines[index];
		if FENCE_LINE_RE.is_match(line) {
			in_fence = !in_fence;
			index += 1;
			continue;
		}
		let opener = (!in_fence).then(|| parse_header(line)).flatten();
		if !matches!(opener, Some(Header::Edit { path: Some(_), .. })) {
			index += 1;
			continue;
		}
		let mut last = index;
		let mut collecting_body = false;
		let mut scan = index + 1;
		while scan < lines.len() {
			if ENVELOPE_END_RE.is_match(lines[scan].trim()) {
				break;
			}
			let Some(header) = parse_header(lines[scan]) else {
				if !collecting_body {
					if lines[scan].trim().is_empty() {
						scan += 1;
						continue;
					}
					break;
				}
				last = scan;
				scan += 1;
				continue;
			};
			// Keep stray body rows on a structural action: the pipeline must
			// report them rather than applying a truncated deletion or move.
			collecting_body =
				!matches!(header, Header::Edit { .. } | Header::Action(Action::Cut | Action::Paste(_)));
			last = scan;
			scan += 1;
		}
		let mut payload = lines[index..=last].join("\n");
		// A literal blank body row immediately before an envelope still has
		// a terminator; without it `str::lines` would drop that row at EOF.
		if collecting_body && last + 1 < lines.len() && matches!(lines[last], "" | "\r") {
			payload.push('\n');
		}
		// A payload the sloppy parser rejects is not an inline sloppy region —
		// except recognizable header errors, which the pipeline must report.
		let recognized = match split_sloppy_sections(&payload) {
			Ok(sections) => !sections.is_empty(),
			Err(error) => is_header_pair_error(&error),
		};
		if recognized {
			regions.push(InlineSloppyRegion { start: starts[index], end: line_end(last), payload });
		}
		index = scan.max(last + 1);
	}
	regions
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenerKind {
	Single,
	All,
	Block,
}

fn parse_opener(line: &str) -> Option<OpenerKind> {
	if line.starts_with(BLOCK_HEADER) {
		return Some(OpenerKind::Block);
	}
	match line.trim() {
		"«" => Some(OpenerKind::Single),
		"«*" => Some(OpenerKind::All),
		_ => None,
	}
}

fn is_ordinal_opener(line: &str) -> bool {
	ORDINAL_OPENER_RE.is_match(line.trim())
}

/// Normalize section headers or internal IR into a canonical op stream.
pub fn normalize_input(input: &str) -> Result<String, EditError> {
	normalize_section(input, false)
}

fn normalize_section(input: &str, streaming: bool) -> Result<String, EditError> {
	let mut lines = clean_envelope(input.lines().map(str::to_owned).collect());
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	if lines
		.first()
		.is_some_and(|line| OUTER_FENCE_RE.is_match(line.trim()))
	{
		lines.remove(0);
		while lines.last().is_some_and(|line| line.trim().is_empty()) {
			lines.pop();
		}
		lines.pop_if(|line| line.trim() == "```");
	}
	if lines.iter().any(|line| parse_header(line).is_some()) {
		lines = compile_sections(&lines, streaming, false)?
			.into_iter()
			.flat_map(|section| section.ir)
			.collect();
	} else {
		lines = lines
			.into_iter()
			.flat_map(|line| {
				GLUED_CONTROL_RE.captures(&line).map_or_else(
					|| vec![line.clone()],
					|captures| vec![captures[1].to_owned(), captures[2].to_owned()],
				)
			})
			.collect();
	}
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	while lines.last().is_some_and(|line| line.trim().is_empty()) {
		lines.pop();
	}
	Ok(lines.join("\n"))
}

/// Which side of an operation a body is, for [`normalize_block`].
#[derive(Clone, Copy)]
enum Side {
	Find,
	/// `numbered_find`: the operation's Find was a [`numbered_copy`], so a
	/// numbered Replace is one too. Without that, a Replace that starts with
	/// digits and `|` or `:` is code (`0 || fallback`), not line numbers.
	Replace {
		numbered_find: bool,
	},
}

/// Line number of a row copied from numbered tool output (`12:text`,
/// `12|text`); `None` when the row is code that merely starts with a number
/// (`0 || x`, `1 |= mask`, `a ? 1 :: b`).
fn copied_line_number(line: &str) -> Option<usize> {
	let prefix = NUMBERED_LINE_RE.find(line)?.as_str();
	if line[prefix.len()..].starts_with([':', '|', '=']) {
		return None;
	}
	prefix
		.trim_start()
		.trim_end_matches([':', '|'])
		.trim_end()
		.parse()
		.ok()
		.filter(|number| *number > 0)
}

/// Whether `line` is a notice or fold row of tool output, never file text.
fn is_read_notice(line: &str) -> bool {
	let trimmed = line.trim();
	SHOWING_LINES_RE.is_match(trimmed)
		|| READ_MORE_NOTICE_RE.is_match(trimmed)
		|| ELIDED_LINE_RE.is_match(trimmed)
}

/// Whether every row of file text carries an ascending line-number prefix,
/// as rows copied from a file read or an edit result do.
fn numbered_copy(lines: &[String]) -> bool {
	let numbers = lines
		.iter()
		.filter(|line| !line.trim().is_empty() && !is_read_notice(line))
		.map(|line| copied_line_number(line))
		.collect::<Option<Vec<_>>>();
	numbers.is_some_and(|numbers| !numbers.is_empty() && numbers.is_sorted_by(|a, b| a < b))
}

fn normalize_block(lines: &[String], side: Side) -> String {
	let rewrite = matches!(side, Side::Replace { .. });
	let mut cleaned: Vec<String> = lines
		.iter()
		.filter(|line| !is_read_notice(line))
		.cloned()
		.collect();
	if !rewrite {
		for line in &mut cleaned {
			if line.trim().is_empty() {
				line.clear();
			}
		}
	}
	while cleaned.last().is_some_and(|line| line.trim().is_empty()) {
		cleaned.pop();
	}
	let has_non_blank = cleaned.iter().any(|line| !line.trim().is_empty());
	let numbered_lines =
		!matches!(side, Side::Replace { numbered_find: false }) && numbered_copy(&cleaned);
	let numbered_literals = has_non_blank
		&& cleaned
			.iter()
			.filter(|line| !line.trim().is_empty())
			.all(|line| NUMBERED_LITERAL_RE.is_match(line));
	let all_non_blank_plus = has_non_blank
		&& cleaned
			.iter()
			.filter(|line| !line.trim().is_empty())
			.all(|line| line.starts_with('+'));
	if numbered_lines && !numbered_literals {
		for line in &mut cleaned {
			*line = NUMBERED_LINE_RE.replace(line, "").into_owned();
		}
	}
	if rewrite {
		if cleaned.first().is_some_and(|line| line.trim() == "//") {
			cleaned.remove(0);
		}
		if cleaned
			.iter()
			.any(|line| marker_line_content(line, REMOVE_LINE).is_some())
			&& cleaned
				.iter()
				.any(|line| marker_line_content(line, ADD_LINE).is_some())
		{
			cleaned.retain(|line| marker_line_content(line, REMOVE_LINE).is_none());
		}
		for line in &mut cleaned {
			if let Some(stripped) = marker_line_content(line, ADD_LINE) {
				*line = stripped;
			}
		}
		let has_old = cleaned
			.iter()
			.any(|line| line.starts_with('-') && !line.starts_with("---"));
		let has_new = cleaned
			.iter()
			.any(|line| line.starts_with('+') && !line.starts_with("+++"));
		if has_old && has_new {
			return cleaned
				.into_iter()
				.filter(|line| !line.starts_with('-') && !line.starts_with("+++"))
				.map(|line| line.strip_prefix('+').unwrap_or(&line).to_owned())
				.collect::<Vec<_>>()
				.join("\n");
		}
		if all_non_blank_plus {
			return cleaned
				.into_iter()
				.map(|line| line.strip_prefix('+').unwrap_or(&line).to_owned())
				.collect::<Vec<_>>()
				.join("\n");
		}
	}
	cleaned.join("\n")
}

fn recover_missing_separator(lines: &[String], content: &str) -> Option<(String, String)> {
	if is_diff_shaped(&lines.join("\n")) {
		return None;
	}
	let mut candidates = Vec::new();
	for split in 1..lines.len() {
		let mut remainder_start = split;
		while lines
			.get(remainder_start)
			.is_some_and(|line| line.trim().is_empty())
		{
			remainder_start += 1;
		}
		if remainder_start >= lines.len() {
			continue;
		}
		let pattern = normalize_block(&lines[..split], Side::Find);
		let rewrite = normalize_block(&lines[remainder_start..], Side::Replace {
			numbered_find: numbered_copy(&lines[..split]),
		});
		if js_len(&pattern) < 4 || rewrite.replace(GAP, "").trim().is_empty() {
			continue;
		}
		if rewrite
			.split('\n')
			.any(|line| !line.trim().is_empty() && line.trim().replace(GAP, "").is_empty())
		{
			continue;
		}
		let occurrences: Vec<usize> = content.match_indices(&pattern).map(|(at, _)| at).collect();
		if occurrences.len() != 1 {
			continue;
		}
		let through_first_rewrite = normalize_block(&lines[..=remainder_start], Side::Find);
		if content[occurrences[0]..].starts_with(&through_first_rewrite) {
			continue;
		}
		if !candidates
			.iter()
			.any(|candidate: &(String, String)| candidate.0 == pattern && candidate.1 == rewrite)
		{
			candidates.push((pattern, rewrite));
		}
	}
	(candidates.len() == 1).then(|| candidates.remove(0))
}

fn recover_alternating_separators(lines: &[String], content: &str) -> Option<Vec<String>> {
	if lines.iter().any(|line| line.trim() == REWRITE_HEADER) {
		return None;
	}
	let headers: Vec<usize> = lines
		.iter()
		.enumerate()
		.filter_map(|(index, line)| parse_opener(line).map(|_| index))
		.collect();
	if headers.len() < 2 || !headers.len().is_multiple_of(2) || headers[0] != 0 {
		return None;
	}
	let normalized_content = normalize_text(content).text;
	let mut recovered = Vec::new();
	for pair in (0..headers.len()).step_by(2) {
		let match_start = headers[pair];
		let rewrite_start = headers[pair + 1];
		let next = headers.get(pair + 2).copied().unwrap_or(lines.len());
		let match_lines = &lines[match_start + 1..rewrite_start];
		let rewrite_lines = &lines[rewrite_start + 1..next];
		let normalized_match = normalize_text(&normalize_block(match_lines, Side::Find)).text;
		let normalized_rewrite = normalize_text(&normalize_block(rewrite_lines, Side::Replace {
			numbered_find: numbered_copy(match_lines),
		}))
		.text;
		if normalized_match.is_empty()
			|| normalized_rewrite.is_empty()
			|| rewrite_lines.iter().any(|line| line.contains(SELECT_OPEN))
			|| !normalized_content.contains(&normalized_match)
			|| normalized_content.contains(&normalized_rewrite)
		{
			return None;
		}
		recovered.push(lines[match_start].clone());
		recovered.extend_from_slice(match_lines);
		recovered.push(REWRITE_HEADER.to_owned());
		recovered.extend_from_slice(rewrite_lines);
	}
	Some(recovered)
}

fn recover_bracket_pairs(lines: &[String], content: &str) -> Option<Vec<String>> {
	let mut items = Vec::new();
	let mut open = None;
	for (index, line) in lines.iter().enumerate() {
		let trimmed = line.trim();
		if parse_opener(line).is_some() {
			if open.is_some() {
				return None;
			}
			open = Some(index);
		} else if trimmed == REWRITE_HEADER {
			items.push((open?, index));
			open = None;
		} else if open.is_none() && !trimmed.is_empty() {
			return None;
		}
	}
	if open.is_some() || items.len() < 2 || !items.len().is_multiple_of(2) {
		return None;
	}
	let normalized_content = normalize_text(content).text;
	let mut recovered = Vec::new();
	for pair in (0..items.len()).step_by(2) {
		let first = items[pair];
		let second = items[pair + 1];
		let match_lines = &lines[first.0 + 1..first.1];
		let rewrite_lines = &lines[second.0 + 1..second.1];
		let normalized_match = normalize_text(&normalize_block(match_lines, Side::Find)).text;
		let normalized_rewrite = normalize_text(&normalize_block(rewrite_lines, Side::Replace {
			numbered_find: numbered_copy(match_lines),
		}))
		.text;
		if normalized_match.is_empty()
			|| normalized_rewrite.is_empty()
			|| rewrite_lines.iter().any(|line| line.contains(SELECT_OPEN))
			|| !normalized_content.contains(&normalized_match)
			|| normalized_content.contains(&normalized_rewrite)
		{
			return None;
		}
		recovered.push(lines[first.0].clone());
		recovered.extend_from_slice(match_lines);
		recovered.push(REWRITE_HEADER.to_owned());
		recovered.extend_from_slice(rewrite_lines);
	}
	Some(recovered)
}

fn has_inline_selection(pattern: &str) -> bool {
	pattern.split(SELECT_OPEN).skip(1).any(|tail| {
		tail
			.split_once(SELECT_CLOSE)
			.map_or(tail, |(selection, _)| selection)
			.contains(SELECT_DIVIDER)
	})
}

fn validate_selection_markers(pattern: &str, operation_number: usize) -> Result<(), EditError> {
	let opens = pattern.matches(SELECT_OPEN).count();
	let closes = pattern.matches(SELECT_CLOSE).count();
	if opens == closes {
		return Ok(());
	}
	Err(parse_error(if opens > closes {
		format!("Operation {operation_number} has an unclosed selection marker ⟪; add closing ⟫.")
	} else {
		format!(
			"Operation {operation_number} has an unmatched closing selection marker ⟫; add opening ⟪."
		)
	}))
}

fn resolve_literal_dividers(selected: &str, operation_number: usize) -> (String, String, String) {
	let dividers: Vec<usize> = selected
		.match_indices(SELECT_DIVIDER)
		.map(|(at, _)| at)
		.collect();
	let advice = format!(
		"Selections containing literal {SELECT_DIVIDER} are ambiguous; state those lines with a \
		 {REWRITE_HEADER} block rewrite instead."
	);
	let last = *dividers.last().expect("called with multiple dividers");
	if last + SELECT_DIVIDER.len() == selected.len() {
		return (
			selected[..last].to_owned(),
			String::new(),
			format!(
				"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} \
				 characters and ended with one; it was read as a deletion of the selected text with \
				 the inner {SELECT_DIVIDER}s literal. {advice}",
				dividers.len()
			),
		);
	}
	if dividers.len() % 2 == 1 {
		let middle = dividers[(dividers.len() - 1) / 2];
		return (
			selected[..middle].to_owned(),
			selected[middle + SELECT_DIVIDER.len()..].to_owned(),
			format!(
				"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} \
				 characters; the middle one was read as the divider and the others as literal text. \
				 {advice}",
				dividers.len()
			),
		);
	}
	(
		selected.to_owned(),
		String::new(),
		format!(
			"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} characters \
			 with no unambiguous divider; it was read as a deletion of the selected text. {advice}",
			dividers.len()
		),
	)
}

fn parse_inline_pattern(
	pattern: &str,
	operation_number: usize,
) -> Result<(String, Vec<String>, Vec<String>), EditError> {
	validate_selection_markers(pattern, operation_number)?;
	let mut pattern_text = String::new();
	let mut replacements = Vec::new();
	let mut notes = Vec::new();
	let mut saw_bare = false;
	let mut saw_inline = false;
	let mut index = 0;
	while index < pattern.len() {
		if pattern[index..].starts_with(SELECT_CLOSE) {
			return Err(parse_error(format!(
				"Operation {operation_number} has an unmatched closing selection marker ⟫; add \
				 opening ⟪."
			)));
		}
		if !pattern[index..].starts_with(SELECT_OPEN) {
			let character = pattern[index..]
				.chars()
				.next()
				.expect("character at boundary");
			pattern_text.push(character);
			index += character.len_utf8();
			continue;
		}
		let selected_start = index + SELECT_OPEN.len();
		let close_relative = pattern[selected_start..]
			.find(SELECT_CLOSE)
			.expect("validated close marker");
		let close = selected_start + close_relative;
		let selected = &pattern[selected_start..close];
		if selected.contains(SELECT_OPEN) {
			return Err(parse_error(format!(
				"Operation {operation_number} has nested selection markers; use one selection per \
				 replacement."
			)));
		}
		if let Some(divider) = selected.find(SELECT_DIVIDER) {
			saw_inline = true;
			if selected[divider + SELECT_DIVIDER.len()..].contains(SELECT_DIVIDER) {
				let (old, desired, note) = resolve_literal_dividers(selected, operation_number);
				pattern_text.push_str(SELECT_OPEN);
				pattern_text.push_str(&old);
				pattern_text.push_str(SELECT_CLOSE);
				replacements.push(desired);
				notes.push(note);
			} else {
				pattern_text.push_str(SELECT_OPEN);
				pattern_text.push_str(&selected[..divider]);
				pattern_text.push_str(SELECT_CLOSE);
				replacements.push(selected[divider + SELECT_DIVIDER.len()..].to_owned());
			}
		} else {
			saw_bare = true;
			pattern_text.push_str(&pattern[index..close + SELECT_CLOSE.len()]);
		}
		index = close + SELECT_CLOSE.len();
	}
	if saw_bare && saw_inline {
		return Err(parse_error(format!(
			"Operation {operation_number} mixes inline and bare selections. Use \
			 {SELECT_OPEN}old{SELECT_DIVIDER}new{SELECT_CLOSE} for every selection, or use a \
			 {REWRITE_HEADER} rewrite for all bare selections."
		)));
	}
	Ok((pattern_text, replacements, notes))
}

fn relocate_selection_lines(pattern_text: &str) -> String {
	let mut lines: Vec<String> = pattern_text.split('\n').map(str::to_owned).collect();
	let mut index = 1;
	while index < lines.len() {
		let previous = lines[index - 1].clone();
		let Some(captures) = SELECTION_ONLY_RE.captures(lines[index].trim()) else {
			index += 1;
			continue;
		};
		if previous.contains(SELECT_OPEN) || previous.contains(GAP) || previous.trim().is_empty() {
			index += 1;
			continue;
		}
		let old = normalize_text(captures.get(1).map_or("", |value| value.as_str())).text;
		if old.is_empty() {
			index += 1;
			continue;
		}
		let normalized = normalize_text(&previous);
		let Some(first) = normalized.text.find(&old) else {
			index += 1;
			continue;
		};
		if normalized.text[first + old.len()..].contains(&old) || normalized.text == old {
			index += 1;
			continue;
		}
		let raw_start = normalized.starts.get(first).copied().unwrap_or(0);
		let raw_end = normalized
			.ends
			.get(first + old.len() - 1)
			.copied()
			.unwrap_or(previous.len());
		lines[index - 1] =
			format!("{}{}{}", &previous[..raw_start], lines[index].trim(), &previous[raw_end..]);
		lines.remove(index);
		index = index.saturating_sub(1).max(1);
	}
	lines.join("\n")
}

fn pattern_reference(pattern: &str) -> Option<String> {
	pattern.split('\n').find_map(|line| {
		REFERENCE_RE
			.captures(line.trim())
			.map(|captures| captures[1].to_owned())
	})
}

fn has_bare_desired(pattern_text: &str) -> bool {
	BARE_DESIRED_RE.is_match(pattern_text)
}

fn embed_bare_desired(pattern_text: &str) -> String {
	BARE_DESIRED_CAPTURE_RE
		.replace_all(pattern_text, "⟪…│$1⟫")
		.into_owned()
}

fn expand_echoed_line_selection(pattern_text: &str, rewrite_text: &str) -> Option<String> {
	let rewrite_lines: Vec<&str> = rewrite_text
		.split('\n')
		.filter(|line| !line.trim().is_empty())
		.collect();
	if rewrite_lines.len() != 1 {
		return None;
	}
	let mut lines: Vec<String> = pattern_text.split('\n').map(str::to_owned).collect();
	let index = lines.iter().position(|line| line.contains(SELECT_OPEN))?;
	let line = lines[index].clone();
	if line.contains(GAP) {
		return None;
	}
	let open = line.find(SELECT_OPEN)?;
	let close = line[open + SELECT_OPEN.len()..].find(SELECT_CLOSE)? + open + SELECT_OPEN.len();
	if line[open + SELECT_OPEN.len()..]
		.matches(SELECT_OPEN)
		.count()
		> 0
		|| lines
			.iter()
			.enumerate()
			.any(|(at, entry)| at != index && entry.contains(SELECT_OPEN))
	{
		return None;
	}
	let prefix = &line[..open];
	let suffix = &line[close + SELECT_CLOSE.len()..];
	if prefix.trim().is_empty() || suffix.contains(SELECT_CLOSE) {
		return None;
	}
	let selected = &line[open + SELECT_OPEN.len()..close];
	if selected.contains(SELECT_DIVIDER)
		|| !normalize_text(rewrite_lines[0])
			.text
			.starts_with(&normalize_text(prefix).text)
	{
		return None;
	}
	lines[index] = format!("{SELECT_OPEN}{prefix}{selected}{suffix}{SELECT_CLOSE}");
	Some(lines.join("\n"))
}

/// Strip a full-line marker while retaining indentation.
pub fn marker_line_content(line: &str, marker: &str) -> Option<String> {
	let indent_len = line.len() - line.trim_start_matches([' ', '\t']).len();
	line[indent_len..]
		.starts_with(marker)
		.then(|| format!("{}{}", &line[..indent_len], &line[indent_len + marker.len()..]))
}

/// Whether a pattern contains any full-line add/remove markers.
pub fn has_marker_lines(pattern_text: &str) -> bool {
	(pattern_text.contains(ADD_LINE) || pattern_text.contains(REMOVE_LINE))
		&& pattern_text.split('\n').any(|line| {
			marker_line_content(line, ADD_LINE).is_some()
				|| marker_line_content(line, REMOVE_LINE).is_some()
		})
}

pub(crate) fn missing_unmarked_lines(content: &str, source_pattern_text: &str) -> Vec<String> {
	let haystack = normalize_text(content).text;
	let mut missing = Vec::new();
	for line in source_pattern_text.split('\n') {
		if marker_line_content(line, ADD_LINE).is_some()
			|| marker_line_content(line, REMOVE_LINE).is_some()
			|| line.contains(SELECT_OPEN)
			|| line.contains(SELECT_CLOSE)
		{
			continue;
		}
		let fragments: Vec<String> = line
			.split(GAP)
			.map(|fragment| normalize_text(fragment).text)
			.filter(|fragment| !fragment.is_empty())
			.collect();
		if !fragments.is_empty()
			&& fragments
				.iter()
				.any(|fragment| !haystack.contains(fragment))
		{
			missing.push(line.trim().to_owned());
		}
	}
	missing
}

fn is_near_variant(anchor: &str, added: &str) -> bool {
	if anchor.contains(SELECT_OPEN) || anchor.trim().is_empty() {
		return false;
	}
	let left = anchor.trim();
	let right = added.trim();
	if left == right || js_len(left) < 4 || js_len(right) < 4 {
		return false;
	}

	let tokens = |line: &str| {
		let mut counts = HashMap::new();
		for token in UNICODE_TOKEN_RE.find_iter(line).map(|item| item.as_str()) {
			*counts.entry(token.to_owned()).or_insert(0usize) += 1;
		}
		counts
	};
	let left_tokens = tokens(left);
	let right_tokens = tokens(right);
	let left_total: usize = left_tokens.values().sum();
	let right_total: usize = right_tokens.values().sum();
	if left_total == 0 || right_total == 0 {
		return false;
	}
	let shared: usize = left_tokens
		.iter()
		.map(|(token, count)| (*count).min(right_tokens.get(token).copied().unwrap_or(0)))
		.sum();
	(2.0 * shared as f64) / (left_total + right_total) as f64 >= 0.8
}

fn encode_literal_markers(text: &str) -> String {
	text
		.replace(SELECT_OPEN, LITERAL_OPEN)
		.replace(SELECT_CLOSE, LITERAL_CLOSE)
		.replace(SELECT_DIVIDER, LITERAL_DIVIDER)
}

pub(super) fn decode_literal_markers(text: &str) -> String {
	text
		.replace(LITERAL_OPEN, SELECT_OPEN)
		.replace(LITERAL_CLOSE, SELECT_CLOSE)
		.replace(LITERAL_DIVIDER, SELECT_DIVIDER)
}

fn wrap_trailing_anchor(out: &mut [String], added: &[String]) -> bool {
	let Some(previous) = out.last().cloned() else {
		return false;
	};
	let close = previous.rfind(SELECT_CLOSE);
	let (head, tail) =
		close.map_or(("", previous.as_str()), |at| previous.split_at(at + SELECT_CLOSE.len()));
	if tail.trim().is_empty()
		|| tail.contains(GAP)
		|| tail.contains(SELECT_DIVIDER)
		|| tail.contains(SELECT_OPEN)
	{
		return false;
	}
	*out.last_mut().expect("non-empty output") = format!(
		"{head}{SELECT_OPEN}{tail}{SELECT_DIVIDER}{tail}\n{}{SELECT_CLOSE}",
		added.join("\n")
	);
	true
}

fn embed_marker_lines(pattern_text: &str) -> String {
	if !has_marker_lines(pattern_text) {
		return pattern_text.to_owned();
	}
	let lines: Vec<&str> = pattern_text.split('\n').collect();
	let mut out: Vec<String> = Vec::new();
	let mut index = 0;
	while index < lines.len() {
		let mut removed = Vec::new();
		while index < lines.len() {
			let Some(line) = marker_line_content(lines[index], REMOVE_LINE) else {
				break;
			};
			removed.push(line);
			index += 1;
		}
		let mut added = Vec::new();
		while index < lines.len() {
			let Some(line) = marker_line_content(lines[index], ADD_LINE) else {
				break;
			};
			added.push(encode_literal_markers(&line));
			index += 1;
		}
		if !removed.is_empty() {
			out.push(format!(
				"{SELECT_OPEN}{}{SELECT_DIVIDER}{}{SELECT_CLOSE}",
				removed.join("\n"),
				added.join("\n")
			));
			continue;
		}
		if added.is_empty() {
			out.push(lines[index].to_owned());
			index += 1;
			continue;
		}
		if added.len() == 1
			&& let Some(anchor) = out.pop_if(|anchor| is_near_variant(anchor, &added[0]))
		{
			out.push(format!("{SELECT_OPEN}{anchor}{SELECT_DIVIDER}{}{SELECT_CLOSE}", added[0]));
			continue;
		}
		let next = lines.get(index).copied();
		let mut lookahead = index;
		while lines
			.get(lookahead)
			.is_some_and(|line| line.trim().is_empty())
		{
			lookahead += 1;
		}
		let gap_below = lines.get(lookahead).is_some_and(|line| line.trim() == GAP);
		if let Some(next) = next {
			if gap_below && wrap_trailing_anchor(&mut out, &added) {
				out.push(next.to_owned());
			} else {
				out.push(format!(
					"{SELECT_OPEN}{SELECT_DIVIDER}{}\n{SELECT_CLOSE}{next}",
					added.join("\n")
				));
			}
			index += 1;
		} else {
			out.push(format!("{SELECT_OPEN}{SELECT_DIVIDER}{}\n{SELECT_CLOSE}", added.join("\n")));
		}
	}
	out.join("\n")
}

fn recover_stray_close_divider(pattern_text: &str) -> Option<String> {
	let opens = pattern_text.matches(SELECT_OPEN).count();
	let closes = pattern_text.matches(SELECT_CLOSE).count();
	if closes <= opens {
		return None;
	}

	let repaired = STRAY_DIVIDER_RE
		.replace_all(pattern_text, "⟪$1│$2⟫")
		.into_owned();
	if repaired == pattern_text
		|| repaired.matches(SELECT_OPEN).count() != repaired.matches(SELECT_CLOSE).count()
	{
		None
	} else {
		Some(repaired)
	}
}

fn recover_directive_rewrite(
	pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
) -> Result<Option<Operation>, EditError> {
	let lines: Vec<&str> = rewrite_text
		.split('\n')
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect();
	if lines.is_empty() {
		return Ok(None);
	}
	let mut unique = Vec::<(String, String)>::new();
	let mut seen = HashSet::new();
	for line in lines {
		let Some(directive) = DIRECTIVE_RE.captures(line) else {
			return Ok(None);
		};
		if seen.insert(directive[1].to_owned()) {
			unique.push((directive[1].to_owned(), directive[2].to_owned()));
		}
	}
	unique.sort_by_key(|entry| std::cmp::Reverse(js_len(&entry.0)));
	let mut segments = vec![(pattern_text.to_owned(), false)];
	let mut matched_any = false;
	for (old, next) in unique {
		let mut rewritten = Vec::new();
		for (segment, locked) in segments {
			if locked {
				rewritten.push((segment, true));
				continue;
			}
			let mut from = 0;
			while let Some(relative) = segment[from..].find(&old) {
				let at = from + relative;
				if at > from {
					rewritten.push((segment[from..at].to_owned(), false));
				}
				rewritten
					.push((format!("{SELECT_OPEN}{old}{SELECT_DIVIDER}{next}{SELECT_CLOSE}"), true));
				matched_any = true;
				from = at + old.len();
			}
			if from < segment.len() {
				rewritten.push((segment[from..].to_owned(), false));
			}
		}
		segments = rewritten;
	}
	if !matched_any {
		return Ok(None);
	}
	let marked: String = segments.into_iter().map(|segment| segment.0).collect();
	let mut operation = create_operation_text(&marked, "", all, operation_number, false)?;
	operation.recovery_note = Some(format!(
		"Note: operation {operation_number}'s REWRITE listed ⟪old│new⟫ directives; they were \
		 applied to every occurrence inside the MATCH. Put selections in the MATCH itself, or state \
		 the final text in REWRITE."
	));
	Ok(Some(operation))
}

fn recover_mixed_rewrite_forms(
	source_pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
) -> Result<Operation, EditError> {
	let (inline_pattern, replacements, inline_notes) =
		parse_inline_pattern(source_pattern_text, operation_number)?;
	let mut current = String::new();
	let mut desired = String::new();
	let mut replacement_index = 0;
	let mut index = 0;
	while let Some(relative) = inline_pattern[index..].find(SELECT_OPEN) {
		let open = index + relative;
		let close = inline_pattern[open + SELECT_OPEN.len()..]
			.find(SELECT_CLOSE)
			.expect("inline pattern was validated")
			+ open
			+ SELECT_OPEN.len();
		let between = &inline_pattern[index..open];
		let selected = &inline_pattern[open + SELECT_OPEN.len()..close];
		current.push_str(between);
		current.push_str(selected);
		desired.push_str(between);
		desired.push_str(
			replacements
				.get(replacement_index)
				.map_or(selected, String::as_str),
		);
		replacement_index += 1;
		index = close + SELECT_CLOSE.len();
	}
	current.push_str(&inline_pattern[index..]);
	desired.push_str(&inline_pattern[index..]);
	let normalized_rewrite = normalize_text(rewrite_text).text;
	let normalized_desired = normalize_text(&desired).text;
	let rewrite_lines: Vec<String> = rewrite_text
		.split('\n')
		.map(|line| normalize_text(line).text)
		.filter(|line| !line.is_empty())
		.collect();
	let echoes_desired = !rewrite_lines.is_empty()
		&& rewrite_lines.len() == replacements.len()
		&& rewrite_lines
			.iter()
			.zip(&replacements)
			.all(|(line, replacement)| *line == normalize_text(replacement).text);
	let redundant = normalized_rewrite.is_empty()
		|| normalized_rewrite == normalized_desired
		|| normalized_rewrite == normalize_text(&current).text
		|| normalized_desired.contains(&normalized_rewrite)
		|| echoes_desired;
	let mixed = format!(
		"Note: operation {operation_number} combined \
		 {SELECT_OPEN}current{SELECT_DIVIDER}desired{SELECT_CLOSE} replacements with a \
		 {REWRITE_HEADER} REWRITE"
	);
	if redundant {
		let mut operation =
			create_operation_text(source_pattern_text, "", all, operation_number, false)?;
		let mut notes = inline_notes;
		notes.push(format!(
			"{mixed}; the REWRITE only restated the inline result and was ignored. Use one form per \
			 operation."
		));
		operation.recovery_note = Some(notes.join("\n"));
		Ok(operation)
	} else {
		let mut operation =
			create_operation_text(&current, rewrite_text, all, operation_number, true)?;
		let mut notes = inline_notes;
		notes.push(format!(
			"{mixed}; the {REWRITE_HEADER} REWRITE was applied as the final text for the match. Use \
			 one form per operation."
		));
		operation.recovery_note = Some(notes.join("\n"));
		Ok(operation)
	}
}

fn create_operation_text(
	source_pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
	has_explicit_rewrite: bool,
) -> Result<Operation, EditError> {
	let mut embedded = embed_marker_lines(source_pattern_text);
	if let Some(repaired) = recover_stray_close_divider(&embedded) {
		let mut operation = create_operation_text(
			&repaired,
			rewrite_text,
			all,
			operation_number,
			has_explicit_rewrite,
		)?;
		source_pattern_text.clone_into(&mut operation.source_pattern_text);
		let note = format!(
			"Note: operation {operation_number} wrote {SELECT_CLOSE} where the {SELECT_DIVIDER} \
			 divider belongs; {SELECT_OPEN}old{SELECT_CLOSE}new{SELECT_CLOSE} was read as \
			 {SELECT_OPEN}old{SELECT_DIVIDER}new{SELECT_CLOSE}."
		);
		operation.recovery_note = Some(
			operation
				.recovery_note
				.map_or_else(|| note.clone(), |prior| format!("{note}\n{prior}")),
		);
		return Ok(operation);
	}
	if !has_explicit_rewrite && has_bare_desired(&embedded) {
		embedded = embed_bare_desired(&embedded);
	}
	if !has_inline_selection(&embedded)
		&& has_explicit_rewrite
		&& let Some(operation) =
			recover_directive_rewrite(&embedded, rewrite_text, all, operation_number)?
	{
		return Ok(operation);
	}
	if has_inline_selection(&embedded) {
		if has_explicit_rewrite {
			return recover_mixed_rewrite_forms(&embedded, rewrite_text, all, operation_number);
		}
		let (inline_pattern, replacements, notes) =
			parse_inline_pattern(&embedded, operation_number)?;
		if replacements.len() == 1
			&& replacements[0].is_empty()
			&& let Some(tail) = EMPTY_SELECTION_TAIL_RE.find(&inline_pattern)
		{
			let remainder = &inline_pattern[..tail.start()];
			if !normalize_text(remainder).text.is_empty() {
				return Ok(Operation {
					pattern_text: remainder.to_owned(),
					source_pattern_text: source_pattern_text.to_owned(),
					rewrite: OperationRewrite::Explicit { text: String::new() },
					all,
					block: false,
					assumed_deletion: false,
					desired_state: false,
					recovery_note: (!notes.is_empty()).then(|| notes.join("\n")),
					whitespace_matched: false,
				});
			}
		}
		if let Some(reference) = pattern_reference(&inline_pattern) {
			return Err(parse_error(format!(
				"{REWRITE_HEADER}{reference} is valid only inside an inline replacement or REWRITE, \
				 never MATCH."
			)));
		}
		return Ok(Operation {
			pattern_text: relocate_selection_lines(&inline_pattern),
			source_pattern_text: source_pattern_text.to_owned(),
			rewrite: OperationRewrite::Inline { replacements },
			all,
			block: false,
			assumed_deletion: false,
			desired_state: false,
			recovery_note: (!notes.is_empty()).then(|| notes.join("\n")),
			whitespace_matched: false,
		});
	}
	if let Some(reference) = pattern_reference(source_pattern_text) {
		return Err(parse_error(format!(
			"{REWRITE_HEADER}{reference} is valid only in REWRITE, never MATCH."
		)));
	}
	if !rewrite_text.trim().is_empty()
		&& let Some(echoed) = expand_echoed_line_selection(source_pattern_text, rewrite_text)
	{
		return Ok(Operation {
			pattern_text: echoed,
			source_pattern_text: source_pattern_text.to_owned(),
			rewrite: OperationRewrite::Explicit { text: rewrite_text.to_owned() },
			all,
			block: false,
			assumed_deletion: false,
			desired_state: false,
			recovery_note: Some(format!(
				"Note: operation {operation_number}'s REWRITE restated the whole selection-bearing \
				 line, so the full line was replaced. A REWRITE after a bare selection replaces only \
				 the selected span; state just the span's new text, or select the whole line."
			)),
			whitespace_matched: false,
		});
	}
	Ok(Operation {
		pattern_text: source_pattern_text.to_owned(),
		source_pattern_text: source_pattern_text.to_owned(),
		rewrite: OperationRewrite::Explicit { text: rewrite_text.to_owned() },
		all,
		block: false,
		assumed_deletion: false,
		desired_state: false,
		recovery_note: None,
		whitespace_matched: false,
	})
}

/// Build and validate one operation from its pattern and rewrite.
pub fn create_operation(
	source_pattern_text: &str,
	rewrite: OperationRewrite,
	all: bool,
	_content: &str,
	operation_number: usize,
) -> Result<Operation, EditError> {
	match rewrite {
		OperationRewrite::Explicit { text } => {
			create_operation_text(source_pattern_text, &text, all, operation_number, true)
		},
		rewrite => {
			literal_operation(source_pattern_text.to_owned(), rewrite, all, false, operation_number)
		},
	}
}

fn literal_operation(
	source: String,
	rewrite: OperationRewrite,
	all: bool,
	block: bool,
	number: usize,
) -> Result<Operation, EditError> {
	if let OperationRewrite::Insert { text, at } = &rewrite
		&& text.is_empty()
	{
		return Err(parse_error(format!(
			"Operation {number} has an empty {}; include the new lines to insert.",
			at.header()
		)));
	}
	Ok(Operation {
		pattern_text: source.clone(),
		source_pattern_text: source,
		rewrite,
		all,
		block,
		assumed_deletion: false,
		desired_state: false,
		recovery_note: None,
		whitespace_matched: false,
	})
}

fn finish_operation(
	lines: &[String],
	end_index: usize,
	path: &str,
	pattern_lines: &[String],
	rewrite_lines: &[String],
	reference_separator: Option<&str>,
	all: bool,
	operations: &mut Vec<Operation>,
) -> Result<(), EditError> {
	let source = normalize_block(pattern_lines, Side::Find);
	let rewrite =
		normalize_block(rewrite_lines, Side::Replace { numbered_find: numbered_copy(pattern_lines) });
	if let Some(reference) = reference_separator.filter(|_| rewrite.trim().is_empty()) {
		if !has_inline_selection(&source) {
			let mut corrected = lines.to_vec();
			if let Some(separator_index) = corrected[..end_index]
				.iter()
				.rposition(|line| line.trim() == reference)
			{
				REWRITE_HEADER.clone_into(&mut corrected[separator_index]);
				corrected.insert(end_index, "{final text}".to_owned());
			}
			return Err(parse_error(format!(
				"{reference} after *** Find reads as the *** Replace separator, leaving *** Replace \
				 empty.\nCopy-ready corrected payload (fill in the final text):\n{}",
				ir_to_payload(&corrected.iter().map(String::as_str).collect::<Vec<_>>(), path)
			)));
		}
		operations.push(create_operation_text(&source, "", all, operations.len() + 1, false)?);
		return Ok(());
	}
	if !has_inline_selection(&source) && !has_marker_lines(&source) {
		let mut body = rewrite_lines.to_vec();
		while body.first().is_some_and(|line| line.trim().is_empty()) {
			body.remove(0);
		}
		while body.last().is_some_and(|line| line.trim().is_empty()) {
			body.pop();
		}
		let add_only = !normalize_text(&source).text.is_empty()
			&& body
				.iter()
				.any(|line| marker_line_content(line, ADD_LINE).is_some())
			&& body
				.iter()
				.all(|line| line.trim().is_empty() || marker_line_content(line, ADD_LINE).is_some());
		if add_only {
			let insertion: Vec<String> = body
				.iter()
				.map(|line| {
					if line.trim().is_empty() {
						ADD_LINE.to_owned()
					} else {
						line.clone()
					}
				})
				.collect();
			let number = operations.len() + 1;
			let mut operation = create_operation_text(
				&format!("{source}\n{}", insertion.join("\n")),
				"",
				all,
				number,
				false,
			)?;
			let note = format!(
				"Note: operation {number}'s REWRITE contained only {ADD_LINE} add lines; they were \
				 inserted after the kept MATCH. Use *** Insert After with only the new lines to \
				 insert after *** Find; *** Replace replaces the match."
			);
			operation.recovery_note = Some(
				operation
					.recovery_note
					.map_or_else(|| note.clone(), |prior| format!("{note}\n{prior}")),
			);
			operations.push(operation);
			return Ok(());
		}
	}
	let number = operations.len() + 1;
	operations.push(create_operation_text(&source, &rewrite, all, number, true)?);
	Ok(())
}

fn finish_pattern(
	lines: &[String],
	end_index: usize,
	content: &str,
	path: &str,
	pattern_lines: &[String],
	all: bool,
	streaming: bool,
	operations: &mut Vec<Operation>,
	pending: &mut Vec<(usize, String)>,
) -> Result<(), EditError> {
	let source = normalize_block(pattern_lines, Side::Find);
	let number = operations.len() + 1;
	if has_inline_selection(&source) || has_marker_lines(&source) || has_bare_desired(&source) {
		operations.push(create_operation_text(&source, "", all, number, false)?);
		return Ok(());
	}
	// A Find whose Replace has not streamed in yet: the recovery ladder below
	// scans the whole file, and its answer would be discarded anyway.
	if streaming {
		return Ok(());
	}
	if let Some((pattern, rewrite)) = recover_missing_separator(pattern_lines, content) {
		operations.push(create_operation_text(&pattern, &rewrite, all, number, true)?);
		return Ok(());
	}
	let mut diff_fallback = None;
	for candidate in diff_shaped_candidates(&source) {
		let Ok(mut operation) = create_operation_text(&candidate, "", all, number, false) else {
			continue;
		};
		operation.recovery_note = Some(format!(
			"Note: operation {number} was written as a unified diff and was applied as inline \
			 changes; state edits as *** Find / *** Replace pairs instead."
		));
		let located = parse_pattern(&operation.pattern_text, number)
			.and_then(|pattern| locate(content, &pattern, &operation, number, "", &[]));
		if located.is_ok() {
			operations.push(operation);
			return Ok(());
		}
		diff_fallback.get_or_insert(operation);
	}
	if let Some(operation) = diff_fallback {
		operations.push(operation);
		return Ok(());
	}
	let normalized_pattern = normalize_text(&source).text;
	let in_file =
		!normalized_pattern.is_empty() && normalize_text(content).text.contains(&normalized_pattern);
	if !source.contains(GAP) {
		let mut desired = create_operation_text(&source, &source, all, number, true)?;
		desired.desired_state = true;
		if let Ok(pattern) = parse_pattern(&desired.pattern_text, number) {
			match locate(content, &pattern, &desired, number, "", &[]) {
				Ok(located) => {
					if let Some(matched) = located.first() {
						let matched_normalized =
							normalize_text(&content[matched.match_start..matched.match_end]).text;
						let matched_units: Vec<u16> = matched_normalized.encode_utf16().collect();
						let mut neighbors_duplicate = false;
						if matched_units.len() >= 8 {
							let before: Vec<u16> = normalize_text(&content[..matched.match_start])
								.text
								.encode_utf16()
								.collect();
							let after: Vec<u16> = normalize_text(&content[matched.match_end..])
								.text
								.encode_utf16()
								.collect();
							for overlap in (8..=matched_units.len()).rev() {
								if before.ends_with(&matched_units[..overlap])
									|| after.starts_with(&matched_units[matched_units.len() - overlap..])
								{
									neighbors_duplicate = true;
									break;
								}
							}
						}
						if neighbors_duplicate {
							desired.recovery_note = Some(format!(
								"Note: operation {number} stated desired text without markers; the \
								 closest matching block was replaced with it. State the current text in \
								 *** Find and the new text in *** Replace."
							));
							operations.push(desired);
							return Ok(());
						}
					}
				},
				Err(ambiguity) if ambiguity.to_string().contains(" is ambiguous: ") => {
					let mut every = desired.clone();
					every.all = true;
					if let Ok(mut matches) = locate(content, &pattern, &every, number, "", &[])
						&& matches.len() == 2
					{
						matches.sort_by_key(|candidate| candidate.match_start);
						let first = &matches[0];
						let second = &matches[1];
						if first.match_end > second.match_start {
							return Err(ambiguity);
						}
						if content[first.match_end..second.match_start]
							.trim()
							.is_empty()
						{
							let span_start = content[..first.match_start]
								.rfind('\n')
								.map_or(0, |at| at + 1);
							let span = &content[span_start..second.match_end];
							let replacement = &content[span_start..first.match_end];
							let mut collapse =
								create_operation_text(span, replacement, false, number, true)?;
							collapse.recovery_note = Some(format!(
								"Note: operation {number} stated desired text that currently appears \
								 twice back-to-back; the duplicate copy was collapsed."
							));
							operations.push(collapse);
							return Ok(());
						}
					}
				},
				Err(_) => {},
			}
		}
		// Text the file already holds is a Find that lost its action, not a
		// statement of desired text: rewriting the nearest other block with it
		// would corrupt the file.
		if !in_file && let Some(closest) = closest_desired_block(content, &source) {
			operations.push(Operation {
				pattern_text:        closest,
				source_pattern_text: source.clone(),
				rewrite:             OperationRewrite::Explicit { text: source.clone() },
				all:                 false,
				block:               false,
				assumed_deletion:    false,
				desired_state:       false,
				recovery_note:       Some(format!(
					"Note: operation {number} stated desired text without markers; the closest \
					 matching block was replaced with it. State the current text in *** Find and the \
					 new text in *** Replace."
				)),
				whitespace_matched:  false,
			});
			return Ok(());
		}
	}
	let context_echo = if in_file {
		"\nIts lines already exist in the file unchanged — if this operation only restated context, \
		 delete it; anchors belong inside the operation that edits them."
	} else {
		""
	};
	let mut corrected = lines[..end_index].to_vec();
	corrected.push(REWRITE_HEADER.to_owned());
	corrected.push("{new text}".to_owned());
	corrected.extend_from_slice(&lines[end_index..]);
	let needs_separator = format!(
		"Operation {number} has *** Find but no *** Replace.{context_echo}\nCopy-ready corrected \
		 payload (fill in the new text):\n{}",
		ir_to_payload(&corrected.iter().map(String::as_str).collect::<Vec<_>>(), path)
	);
	if !source.contains('\n') || js_len(&normalized_pattern) < 24 {
		return Err(parse_error(needs_separator));
	}
	let mut operation = create_operation_text(&source, "", all, number, true)?;
	operation.assumed_deletion = true;
	pending.push((operations.len(), needs_separator));
	operations.push(operation);
	Ok(())
}

/// Rows collected for one side of an operation, with running `⟪`/`⟫` counts
/// and a non-blank flag so each new row costs O(row) instead of re-scanning
/// the block.
#[derive(Default)]
struct Rows {
	lines:       Vec<String>,
	opens:       usize,
	closes:      usize,
	has_content: bool,
}

impl Rows {
	fn push(&mut self, line: &str) {
		self.opens += line.matches(SELECT_OPEN).count();
		self.closes += line.matches(SELECT_CLOSE).count();
		self.has_content |= !line.trim().is_empty();
		self.lines.push(line.to_owned());
	}

	fn clear(&mut self) {
		self.lines.clear();
		self.opens = 0;
		self.closes = 0;
		self.has_content = false;
	}

	const fn balanced(&self) -> bool {
		self.opens == self.closes
	}
}

/// Parse a canonical or taught sloppy payload into operations. `path` is the
/// authored target, echoed in copy-ready payloads inside parse errors.
pub fn parse_operations(
	input: &str,
	content: &str,
	path: &str,
) -> Result<Vec<Operation>, EditError> {
	parse_section(input, content, path, false)
}

/// [`parse_operations`] for one section; while `streaming`, a trailing
/// `*** Find` without its `*** Replace` is dropped instead of recovered.
pub(super) fn parse_section(
	input: &str,
	content: &str,
	path: &str,
	streaming: bool,
) -> Result<Vec<Operation>, EditError> {
	let payload = normalize_section(input, streaming)?;
	let mut lines: Vec<String> = payload.split('\n').map(str::to_owned).collect();
	if parse_opener(lines.first().map_or("", String::as_str)).is_none()
		&& (lines.iter().any(|line| line.trim() == REWRITE_HEADER)
			|| payload.contains(SELECT_OPEN)
			|| payload.contains(SELECT_CLOSE)
			|| has_marker_lines(&payload))
	{
		lines.insert(0, OPENER.to_owned());
	}
	if !lines.iter().any(|line| {
		line.starts_with(BLOCK_HEADER)
			|| line.starts_with(EMBEDDED_HEADER)
			|| strip_insert_header(line).is_some()
	}) {
		lines = recover_alternating_separators(&lines, content).unwrap_or(lines);
		lines = recover_bracket_pairs(&lines, content).unwrap_or(lines);
	}
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum State {
		Outside,
		Pattern,
		Rewrite,
	}
	let mut operations = Vec::new();
	let mut state = State::Outside;
	let mut all = false;
	let mut pattern = Rows::default();
	let mut rewrite = Rows::default();
	let mut reference_separator: Option<String> = None;
	let mut pending = Vec::new();
	// The planner uses the cut's index to resolve its original selector.
	let mut cut: Option<(usize, bool)> = None;
	let mut block: Option<&str> = None;

	for index in 0..lines.len() {
		let line = &lines[index];
		let selector = block.take();
		block = line.strip_prefix(BLOCK_HEADER);
		let parsed_opener = parse_opener(line);
		let trimmed = line.trim();
		let register_reference = REFERENCE_RE.captures(trimmed);
		let literal_action = strip_insert_header(line)
			.map(|(at, body)| (Action::Insert(at), body))
			.or_else(|| {
				line
					.strip_prefix(BLOCK_REPLACE_HEADER)
					.map(|body| (Action::Replace, body))
			})
			.or_else(|| bodyless_action(line).map(|action| (action, "")));
		if let Some((action, encoded)) = literal_action {
			let number = operations.len() + 1;
			let header = action.header();
			if state != State::Pattern || selector.is_none() && !pattern.has_content {
				return Err(parse_error(format!(
					"Operation {number} needs a non-empty *** Find before {header}."
				)));
			}
			let rewrite = match action {
				Action::Replace | Action::Insert(_) => {
					let text = serde_json::from_str(encoded)
						.map_err(|error| parse_error(format!("Invalid {header} body: {error}")))?;
					if let Action::Insert(at) = action {
						if selector.is_some() {
							return Err(parse_error("Invalid internal block instruction."));
						}
						OperationRewrite::Insert { text, at }
					} else if selector.is_some() {
						OperationRewrite::Explicit { text }
					} else {
						return Err(parse_error("Unexpected literal block replacement."));
					}
				},
				Action::Cut | Action::Paste(_) if all => {
					return Err(parse_error(format!(
						"Operation {number}: {header} moves one block; drop all."
					)));
				},
				Action::Cut => {
					if let Some((unpasted, structural)) = cut.replace((number, selector.is_some())) {
						return Err(unpasted_cut(unpasted, structural));
					}
					OperationRewrite::Cut
				},
				Action::Paste(at) => {
					let Some((cut, _)) = cut.take() else {
						if selector.is_some() {
							return Err(parse_error(format!(
								"Operation {number} has {} but nothing is cut. Use *** Cut Block: \
								 <opening-line prefix> first; each cut pastes once.",
								BlockAction::Paste(at).header()
							)));
						}
						return Err(parse_error(format!(
							"Operation {number} has {header} but nothing is cut. Quote the block to move \
							 in a *** Find followed by *** Cut first; each *** Cut pastes once."
						)));
					};
					OperationRewrite::Paste { cut, at }
				},
			};
			let source =
				selector.map_or_else(|| normalize_block(&pattern.lines, Side::Find), str::to_owned);
			if selector.is_some_and(|opener| opener.trim().is_empty()) {
				return Err(parse_error(BLOCK_SELECTOR_ERROR));
			}
			operations.push(literal_operation(source, rewrite, all, selector.is_some(), number)?);
			state = State::Outside;
			continue;
		}
		if selector.is_some() {
			return Err(parse_error("Invalid internal block instruction."));
		}
		if let Some(encoded) = line.strip_prefix(EMBEDDED_HEADER) {
			if state != State::Pattern || pattern.has_content {
				return Err(parse_error("Unexpected embedded edit."));
			}
			let source: String = serde_json::from_str(encoded)
				.map_err(|error| parse_error(format!("Invalid embedded edit: {error}")))?;
			operations.push(create_operation_text(&source, "", all, operations.len() + 1, false)?);
			state = State::Outside;
			continue;
		}
		if is_ordinal_opener(line) {
			return Err(parse_error(format!(
				"{trimmed} is not a valid opener. Use a *** Find that matches once — add context only \
				 the intended match has — or *** Edit File: path all to change every match."
			)));
		}
		if trimmed == format!("{OPENER}{REWRITE_HEADER}") {
			if state == State::Pattern && pattern.has_content {
				state = State::Rewrite;
			}
			continue;
		}
		if parsed_opener.is_none()
			&& (trimmed.starts_with(OPENER)
				|| (trimmed.starts_with(REWRITE_HEADER)
					&& trimmed != REWRITE_HEADER
					&& register_reference.is_none()))
		{
			let json = serde_json::to_string(trimmed).expect("string serialization cannot fail");
			return Err(parse_error(format!(
				"Invalid control line {json}; use only {OPENER}, {OPENER}*, {REWRITE_HEADER}, or \
				 {REWRITE_HEADER}N in REWRITE."
			)));
		}
		if state == State::Outside {
			if let Some(opener) = parsed_opener {
				all = opener == OpenerKind::All;
				pattern.clear();
				rewrite.clear();
				reference_separator = None;
				state = State::Pattern;
			} else if !trimmed.is_empty() {
				return Err(parse_error(format!(
					"Expected a *** Edit File: or *** Find header on input line {}.",
					index + 1
				)));
			}
			continue;
		}
		if state == State::Pattern {
			let balanced = pattern.balanced();
			if trimmed == REWRITE_HEADER
				|| (trimmed == "***" && balanced && pattern.has_content)
				|| (trimmed == SELECT_CLOSE && balanced && pattern.has_content)
			{
				state = State::Rewrite;
			} else if register_reference.is_some() && balanced {
				if !pattern.has_content {
					return Err(parse_error(format!(
						"{trimmed} is valid only in REWRITE, never MATCH."
					)));
				}
				state = State::Rewrite;
				reference_separator = Some(trimmed.to_owned());
			} else if let Some(opener) = parsed_opener {
				if pattern.has_content {
					finish_pattern(
						&lines,
						index,
						content,
						path,
						&pattern.lines,
						all,
						false,
						&mut operations,
						&mut pending,
					)?;
				}
				all = opener == OpenerKind::All;
				pattern.clear();
				rewrite.clear();
				reference_separator = None;
			} else {
				pattern.push(line);
			}
			continue;
		}
		if let Some(opener) = parsed_opener {
			finish_operation(
				&lines,
				index,
				path,
				&pattern.lines,
				&rewrite.lines,
				reference_separator.as_deref(),
				all,
				&mut operations,
			)?;
			all = opener == OpenerKind::All;
			pattern.clear();
			rewrite.clear();
			reference_separator = None;
			state = State::Pattern;
		} else if trimmed == "***" {
		} else if trimmed == REWRITE_HEADER {
			let next_content = lines[index + 1..]
				.iter()
				.find(|entry| !entry.trim().is_empty());
			if next_content.is_some_and(|next| parse_opener(next).is_none()) {
				return Err(parse_error(format!(
					"Operation {} has a second {REWRITE_HEADER} line.",
					operations.len() + 1
				)));
			}
		} else if trimmed == SELECT_CLOSE && rewrite.balanced() {
		} else {
			rewrite.push(line);
		}
	}
	match state {
		State::Rewrite => finish_operation(
			&lines,
			lines.len(),
			path,
			&pattern.lines,
			&rewrite.lines,
			reference_separator.as_deref(),
			all,
			&mut operations,
		)?,
		State::Pattern => finish_pattern(
			&lines,
			lines.len(),
			content,
			path,
			&pattern.lines,
			all,
			streaming,
			&mut operations,
			&mut pending,
		)?,
		State::Outside => {},
	}
	if block.is_some() {
		return Err(parse_error("Invalid internal block instruction."));
	}
	// While streaming, the paste may simply not have arrived yet.
	if let Some((unpasted, structural)) = cut
		&& !streaming
	{
		return Err(unpasted_cut(unpasted, structural));
	}
	if operations.is_empty() {
		return Err(parse_error(
			"Empty patch. Provide *** Find followed by *** Replace, *** Insert Before, or *** Insert \
			 After.",
		));
	}
	for (index, operation) in operations.iter().enumerate() {
		if operation.block {
			continue;
		}
		let rewrites: Vec<&str> = match &operation.rewrite {
			OperationRewrite::Explicit { text } => vec![text],
			OperationRewrite::Insert { .. }
			| OperationRewrite::Cut
			| OperationRewrite::Paste { .. } => continue,
			OperationRewrite::Inline { replacements } => {
				replacements.iter().map(String::as_str).collect()
			},
		};
		for rewrite in rewrites {
			for line in rewrite.split('\n') {
				if let Some(reference) = REFERENCE_RE.captures(line.trim())
					&& reference[1]
						.parse::<usize>()
						.is_ok_and(|number| number > index)
				{
					return Err(parse_error(format!(
						"{REWRITE_HEADER}{} must reference an earlier operation, not self/forward.",
						&reference[1]
					)));
				}
			}
		}
	}
	for (index, message) in pending {
		let normalized_pattern = normalize_text(&operations[index].pattern_text).text;
		let justified = operations.iter().enumerate().any(|(other_index, other)| {
			if other_index == index {
				return false;
			}
			let rewrites: Vec<&str> = match &other.rewrite {
				OperationRewrite::Explicit { text } | OperationRewrite::Insert { text, .. } => {
					vec![text]
				},
				OperationRewrite::Inline { replacements } => {
					replacements.iter().map(String::as_str).collect()
				},
				OperationRewrite::Cut | OperationRewrite::Paste { .. } => Vec::new(),
			};
			rewrites.iter().any(|rewrite| {
				normalize_text(rewrite).text.contains(&normalized_pattern)
					|| rewrite
						.split('\n')
						.any(|line| line.trim() == format!("{REWRITE_HEADER}{}", index + 1))
			})
		});
		if !justified {
			return Err(parse_error(message));
		}
	}
	Ok(operations)
}

fn render_inline_pattern(pattern_text: &str, replacements: &[String]) -> String {
	let mut rendered = String::new();
	let mut replacement_index = 0;
	let mut index = 0;
	while index < pattern_text.len() {
		let Some(relative) = pattern_text[index..].find(SELECT_OPEN) else {
			rendered.push_str(&pattern_text[index..]);
			break;
		};
		let open = index + relative;
		rendered.push_str(&pattern_text[index..open]);
		let close = pattern_text[open + SELECT_OPEN.len()..]
			.find(SELECT_CLOSE)
			.map_or(pattern_text.len(), |at| at + open + SELECT_OPEN.len());
		rendered.push_str(&pattern_text[open..close]);
		rendered.push_str(SELECT_DIVIDER);
		rendered.push_str(&decode_literal_markers(
			replacements
				.get(replacement_index)
				.map_or("", String::as_str),
		));
		rendered.push_str(SELECT_CLOSE);
		replacement_index += 1;
		index = (close + SELECT_CLOSE.len()).min(pattern_text.len());
	}
	rendered
}

fn operation_pattern<'a>(operation: &'a Operation, pattern_text: Option<&'a str>) -> Cow<'a, str> {
	if operation.block {
		return Cow::Borrowed(&operation.source_pattern_text);
	}
	let pattern = pattern_text.unwrap_or(&operation.pattern_text);
	match &operation.rewrite {
		OperationRewrite::Inline { replacements } if pattern != operation.pattern_text => {
			Cow::Owned(render_inline_pattern(pattern, replacements))
		},
		OperationRewrite::Inline { .. } => Cow::Borrowed(&operation.source_pattern_text),
		OperationRewrite::Explicit { .. }
		| OperationRewrite::Insert { .. }
		| OperationRewrite::Cut
		| OperationRewrite::Paste { .. } => Cow::Borrowed(pattern),
	}
}

/// A `*** Cut` whose block no later operation pastes.
fn unpasted_cut(number: usize, structural: bool) -> EditError {
	if structural {
		return parse_error(format!(
			"Operation {number} has *** Cut Block but no paste follows it. Add *** Paste Before \
			 Block: <opening-line prefix> or *** Paste After Block: <opening-line prefix>. To delete \
			 the block instead, use *** Delete Block: <opening-line prefix>."
		));
	}
	parse_error(format!(
		"Operation {number} has *** Cut but no *** Paste Before or *** Paste After follows it. To \
		 delete the block instead, use an empty *** Replace."
	))
}

/// File and `*** Find` headers opening a copy-ready operation; `all` selects
/// every match. Paths ambiguous with the file header's own `all` are quoted.
pub(crate) fn find_opener(path: &str, all: bool) -> String {
	format!("*** Edit File: {}\n*** Find{}", header_path(path), if all { " all" } else { "" })
}

fn header_path(path: &str) -> Cow<'_, str> {
	if path.trim() != path
		|| path.starts_with('"')
		|| path.contains(['\n', '\r'])
		|| path.eq_ignore_ascii_case("all")
		|| path
			.rsplit_once(char::is_whitespace)
			.is_some_and(|(_, flag)| flag.eq_ignore_ascii_case("all"))
	{
		Cow::Owned(serde_json::to_string(path).expect("path serialization"))
	} else {
		Cow::Borrowed(path)
	}
}

fn render_block(out: &mut String, path: &str, selector: &str, action: BlockAction, text: &str) {
	writeln!(out, "*** Edit File: {}\n{}: {selector}", header_path(path), action.header())
		.expect("writing to string");
	if !text.is_empty() {
		out.push_str(text);
		out.push('\n');
	}
}

/// Render internal operations as copy-ready section-delimited edits.
pub fn ir_to_payload(lines: &[&str], path: &str) -> String {
	let mut out = String::new();
	let mut in_find = false;
	let mut rows = lines.iter().copied();
	while let Some(line) = rows.next() {
		if let Some(selector) = line.strip_prefix(BLOCK_HEADER) {
			let instruction = rows.next().unwrap_or_default();
			if let Some(text) = instruction
				.strip_prefix(BLOCK_REPLACE_HEADER)
				.and_then(|encoded| serde_json::from_str::<String>(encoded).ok())
			{
				let action = if text.is_empty() {
					BlockAction::Delete
				} else {
					BlockAction::Replace
				};
				render_block(&mut out, path, selector, action, &text);
			} else {
				let action = match bodyless_action(instruction) {
					Some(Action::Cut) => BlockAction::Cut,
					Some(Action::Paste(at)) => BlockAction::Paste(at),
					_ => continue,
				};
				render_block(&mut out, path, selector, action, "");
			}
			in_find = false;
		} else if let Some(opener) = parse_opener(line) {
			out.push_str(&find_opener(path, opener == OpenerKind::All));
			out.push('\n');
			in_find = true;
		} else if let Some(pattern) = line
			.strip_prefix(EMBEDDED_HEADER)
			.and_then(|encoded| serde_json::from_str::<String>(encoded).ok())
			.filter(|_| in_find)
		{
			out.push_str(&pattern);
			out.push('\n');
			in_find = false;
		} else if let Some(action) = bodyless_action(line).filter(|_| in_find) {
			out.push_str(action.header());
			out.push('\n');
			in_find = false;
		} else if let Some((at, text)) = strip_insert_header(line)
			.and_then(|(at, encoded)| Some((at, serde_json::from_str::<String>(encoded).ok()?)))
			.filter(|_| in_find)
		{
			out.push_str(at.header());
			out.push('\n');
			out.push_str(&text);
			in_find = false;
		} else if line.trim() == REWRITE_HEADER && in_find {
			out.push_str("*** Replace\n");
			in_find = false;
		} else {
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}

/// Render an operation as a copy-ready payload; `all` selects every match.
pub fn operation_payload(
	operation: &Operation,
	path: &str,
	all: bool,
	pattern_text: Option<&str>,
) -> String {
	let pattern = operation_pattern(operation, pattern_text);
	if operation.block {
		let (action, text) = match &operation.rewrite {
			OperationRewrite::Cut => (BlockAction::Cut, ""),
			OperationRewrite::Paste { at, .. } => (BlockAction::Paste(*at), ""),
			OperationRewrite::Explicit { text } if text.is_empty() => (BlockAction::Delete, ""),
			OperationRewrite::Explicit { text } => (BlockAction::Replace, text.as_str()),
			_ => unreachable!("unsupported structural action"),
		};
		let mut out = String::new();
		render_block(&mut out, path, &pattern, action, text);
		return out;
	}
	let open = find_opener(path, all);
	match &operation.rewrite {
		OperationRewrite::Inline { .. } => format!("{open}\n{pattern}\n"),
		OperationRewrite::Insert { text, at } => {
			format!("{open}\n{pattern}\n{}\n{text}", at.header())
		},
		OperationRewrite::Explicit { text } => {
			format!("{open}\n{pattern}\n*** Replace\n{text}")
		},
		OperationRewrite::Cut => format!("{open}\n{pattern}\n*** Cut\n"),
		OperationRewrite::Paste { at, .. } => format!("{open}\n{pattern}\n{}\n", at.paste_header()),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn marker_lines_keep_indentation() {
		assert_eq!(marker_line_content("  ＋value", ADD_LINE).as_deref(), Some("  value"));
		assert!(has_marker_lines("anchor\n  －old"));
	}

	#[test]
	fn operation_payload_restores_inline_desired_text() {
		let operation =
			parse_operations("«\nconst \u{27ea}old\u{2502}new\u{27eb};", "const old;\n", "a.ts")
				.unwrap()
				.remove(0);
		let payload = operation_payload(&operation, "a.ts", true, None);
		let round_trip = parse_operations(&payload, "const old;\n", "a.ts").unwrap();
		assert_eq!(round_trip[0].rewrite, operation.rewrite);
		assert!(round_trip[0].all);
	}
}
