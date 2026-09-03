//! Stateful line tokenizer for hashline patches.

pub use super::types::ParsedRange;
use super::{
	format::{
		HL_CUT_KEYWORD, HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX,
		HL_MOVE_KEYWORD, HL_PUT_KEYWORD, HL_REM_KEYWORD, describe_anchor_examples,
	},
	messages::{ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER, json_quote},
	types::{Anchor, Cursor},
};
use crate::error::EditError;

/// Locator and optional register parsed from one operation header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockTarget {
	Replace { range: ParsedRange, register: Option<String> },
	Block { anchor: Anchor, register: Option<String> },
	InsertBefore { anchor: Anchor, register: Option<String> },
	InsertAfter { anchor: Anchor, register: Option<String> },
	InsertAfterBlock { anchor: Anchor, register: Option<String> },
	Cut { range: ParsedRange, register: Option<String> },
	CutBlock { anchor: Anchor, register: Option<String> },
	Bof { register: Option<String> },
	Eof { register: Option<String> },
	Rem,
	Move { dest: String },
}

impl BlockTarget {
	/// Return the optional clipboard register.
	pub fn register(&self) -> Option<&str> {
		match self {
			Self::Replace { register, .. }
			| Self::Block { register, .. }
			| Self::InsertBefore { register, .. }
			| Self::InsertAfter { register, .. }
			| Self::InsertAfterBlock { register, .. }
			| Self::Cut { register, .. }
			| Self::CutBlock { register, .. }
			| Self::Bof { register }
			| Self::Eof { register } => register.as_deref(),
			Self::Rem | Self::Move { .. } => None,
		}
	}
}

/// One classified hashline input row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
	Blank { line_num: u32 },
	EnvelopeBegin { line_num: u32 },
	EnvelopeEnd { line_num: u32 },
	Abort { line_num: u32 },
	Header { line_num: u32, path: String, file_hash: Option<String> },
	OpBlock { line_num: u32, target: BlockTarget, had_colon: bool },
	PayloadLiteral { line_num: u32, text: String },
	Raw { line_num: u32, text: String },
}

impl Token {
	/// Return the 1-indexed authored row number.
	pub const fn line_num(&self) -> u32 {
		match self {
			Self::Blank { line_num }
			| Self::EnvelopeBegin { line_num }
			| Self::EnvelopeEnd { line_num }
			| Self::Abort { line_num }
			| Self::Header { line_num, .. }
			| Self::OpBlock { line_num, .. }
			| Self::PayloadLiteral { line_num, .. }
			| Self::Raw { line_num, .. } => *line_num,
		}
	}
}

/// Stateful line-oriented hashline tokenizer.
#[derive(Debug)]
pub struct Tokenizer {
	buffer:        String,
	next_line_num: u32,
	closed:        bool,
}

impl Default for Tokenizer {
	fn default() -> Self {
		Self::new()
	}
}

impl Tokenizer {
	/// Construct an empty tokenizer.
	pub const fn new() -> Self {
		Self { buffer: String::new(), next_line_num: 1, closed: false }
	}

	/// Feed a text chunk and return tokens for complete rows.
	pub fn feed(&mut self, chunk: &str) -> Result<Vec<Token>, EditError> {
		if self.closed {
			return Err(EditError::parse("Tokenizer is closed; call reset() before reusing."));
		}
		if chunk.is_empty() {
			return Ok(Vec::new());
		}
		self.buffer.push_str(chunk);
		let mut tokens = Vec::new();
		while let Some(index) = self.buffer.find('\n') {
			let mut line = self.buffer[..index].to_string();
			if line.ends_with('\r') {
				line.pop();
			}
			self.buffer.drain(..=index);
			tokens.push(classify_line(&line, self.next_line_num));
			self.next_line_num = self.next_line_num.saturating_add(1);
		}
		Ok(tokens)
	}

	/// Close the stream and classify its final unterminated row.
	pub fn end(&mut self) -> Vec<Token> {
		if self.closed {
			return Vec::new();
		}
		self.closed = true;
		if self.buffer.is_empty() {
			return Vec::new();
		}
		let mut line = std::mem::take(&mut self.buffer);
		if line.ends_with('\r') {
			line.pop();
		}
		let token = classify_line(&line, self.next_line_num);
		self.next_line_num = self.next_line_num.saturating_add(1);
		vec![token]
	}

	/// Reset this tokenizer for reuse.
	pub fn reset(&mut self) {
		self.buffer.clear();
		self.next_line_num = 1;
		self.closed = false;
	}

	/// Tokenize one complete string.
	pub fn tokenize_all(&mut self, text: &str) -> Result<Vec<Token>, EditError> {
		self.reset();
		let mut tokens = self.feed(text)?;
		tokens.extend(self.end());
		Ok(tokens)
	}

	/// Classify one already-split row.
	pub fn tokenize(&self, line: &str, line_num: u32) -> Token {
		classify_line(line, line_num)
	}

	/// Whether a row is a complete operation header.
	pub fn is_op(&self, line: &str) -> bool {
		parse_hunk_header(line).is_some()
	}

	/// Whether a row is a valid file header.
	pub fn is_header(&self, line: &str) -> bool {
		parse_header(line).is_some()
	}

	/// Whether a row is a patch envelope or abort marker.
	pub fn is_envelope_marker(&self, line: &str) -> bool {
		marker_line_equals(line, BEGIN_PATCH_MARKER)
			|| marker_line_equals(line, END_PATCH_MARKER)
			|| marker_line_equals(line, ABORT_MARKER)
	}
}

/// Split LF/CRLF text without retaining a terminal empty sentinel.
pub fn split_hashline_lines(text: &str) -> Vec<String> {
	if text.is_empty() {
		return vec![String::new()];
	}
	let mut lines: Vec<String> = text
		.split_inclusive('\n')
		.map(|line| {
			let line = line.strip_suffix('\n').unwrap_or(line);
			line.strip_suffix('\r').unwrap_or(line).to_string()
		})
		.collect();
	if !text.ends_with('\n') && lines.is_empty() {
		lines.push(text.trim_end_matches('\r').to_string());
	}
	lines
}

/// Copy a cursor and its anchor.
pub const fn clone_cursor(cursor: Cursor) -> Cursor {
	cursor
}

/// Parse a positive bare line-number anchor.
pub fn parse_lid(raw: &str, line_num: u32) -> Result<Anchor, EditError> {
	let value = raw.trim();
	if !valid_line_number(value) {
		return Err(EditError::parse_at(
			format!(
				"line {line_num}: expected a line number such as {}; got {}. Use [PATH#hash] from \
				 your latest read for file-version binding.",
				describe_anchor_examples("119"),
				json_quote(raw)
			),
			line_num,
		));
	}
	Ok(Anchor {
		line: value
			.parse()
			.map_err(|_| EditError::parse("line number is too large"))?,
	})
}

/// Whether text is a complete operation header.
pub fn is_hunk_header_text(text: &str) -> bool {
	let lead = text.trim_start();
	[HL_PUT_KEYWORD, HL_CUT_KEYWORD, HL_REM_KEYWORD, HL_MOVE_KEYWORD]
		.iter()
		.any(|keyword| lead.starts_with(keyword))
		&& parse_hunk_header(text).is_some()
}

/// Return canonical metaharness labels for operation headers in payload order.
pub fn op_labels(input: &str) -> Vec<String> {
	let mut tokenizer = Tokenizer::new();
	let Ok(tokens) = tokenizer.tokenize_all(input) else {
		return Vec::new();
	};
	tokens
		.into_iter()
		.filter_map(|token| {
			let Token::OpBlock { target, had_colon, .. } = token else {
				return None;
			};
			Some(op_label(&target, had_colon))
		})
		.collect()
}

const fn put_suffix(
	register: Option<&str>,
	had_colon: bool,
	allows_anonymous_paste: bool,
) -> &'static str {
	if register.is_some() {
		if had_colon {
			" @reg: (invalid)"
		} else {
			" @reg"
		}
	} else if had_colon {
		":"
	} else if allows_anonymous_paste {
		""
	} else {
		" (invalid)"
	}
}
const fn cut_suffix(register: Option<&str>, had_colon: bool) -> &'static str {
	if register.is_some() {
		if had_colon {
			" @reg: (invalid)"
		} else {
			" @reg"
		}
	} else if had_colon {
		": (invalid)"
	} else {
		""
	}
}
fn op_label(target: &BlockTarget, had_colon: bool) -> String {
	match target {
		BlockTarget::Replace { range, register } => format!(
			"PUT {}{}",
			if range.start.line == range.end.line {
				"N.=N"
			} else {
				"N.=M"
			},
			put_suffix(register.as_deref(), had_colon, false)
		),
		BlockTarget::Block { register, .. } => {
			format!("PUT N*{}", put_suffix(register.as_deref(), had_colon, false))
		},
		BlockTarget::InsertBefore { register, .. } => {
			format!("PUT <N{}", put_suffix(register.as_deref(), had_colon, true))
		},
		BlockTarget::InsertAfter { register, .. } => {
			format!("PUT >N{}", put_suffix(register.as_deref(), had_colon, true))
		},
		BlockTarget::Bof { register } => {
			format!("PUT <1{}", put_suffix(register.as_deref(), had_colon, true))
		},
		BlockTarget::Eof { register } => {
			format!("PUT >${}", put_suffix(register.as_deref(), had_colon, true))
		},
		BlockTarget::InsertAfterBlock { register, .. } => {
			format!("PUT >N*{}", put_suffix(register.as_deref(), had_colon, true))
		},
		BlockTarget::Cut { range, register } => format!(
			"CUT {}{}",
			if range.start.line == range.end.line {
				"N.=N"
			} else {
				"N.=M"
			},
			cut_suffix(register.as_deref(), had_colon)
		),
		BlockTarget::CutBlock { register, .. } => {
			format!("CUT N*{}", cut_suffix(register.as_deref(), had_colon))
		},
		BlockTarget::Rem => "REM".to_string(),
		BlockTarget::Move { .. } => "MV".to_string(),
	}
}

fn marker_line_equals(line: &str, marker: &str) -> bool {
	line.trim_end() == marker
}
fn valid_line_number(raw: &str) -> bool {
	!raw.is_empty()
		&& !raw.starts_with('0')
		&& raw.bytes().all(|byte| byte.is_ascii_digit())
		&& raw.parse::<u32>().is_ok()
}

fn parse_number_prefix(raw: &str) -> Option<(u32, usize)> {
	let bytes = raw.as_bytes();
	if bytes
		.first()
		.is_none_or(|byte| !matches!(byte, b'1'..=b'9'))
	{
		return None;
	}
	let mut end = 1;
	while end < bytes.len() && bytes[end].is_ascii_digit() {
		end += 1;
	}
	Some((raw[..end].parse().ok()?, end))
}

fn parse_range(raw: &str, allow_single: bool) -> Option<(ParsedRange, usize, bool)> {
	let leading = raw.len() - raw.trim_start().len();
	let (start, used) = parse_number_prefix(&raw[leading..])?;
	let mut cursor = leading + used;
	let mut saw_non_ws = false;
	while cursor < raw.len() {
		let ch = raw[cursor..].chars().next()?;
		if ch.is_whitespace() || matches!(ch, '-' | '.' | '=' | '…') {
			saw_non_ws |= !ch.is_whitespace();
			cursor += ch.len_utf8();
		} else {
			break;
		}
	}
	if let Some((end, count)) = parse_number_prefix(&raw[cursor..]) {
		cursor += count;
		while cursor < raw.len() && raw.as_bytes()[cursor].is_ascii_whitespace() {
			cursor += 1;
		}
		return Some((
			ParsedRange { start: Anchor { line: start }, end: Anchor { line: end } },
			cursor,
			true,
		));
	}
	if !allow_single {
		return None;
	}
	if saw_non_ws && (cursor == raw.len() || matches!(raw.as_bytes().get(cursor), Some(b':' | b'@')))
	{
		return Some((
			ParsedRange { start: Anchor { line: start }, end: Anchor { line: start } },
			cursor,
			true,
		));
	}
	Some((ParsedRange { start: Anchor { line: start }, end: Anchor { line: start } }, cursor, false))
}

fn parse_register_and_colon(raw: &str, mut target: BlockTarget) -> Option<(BlockTarget, bool)> {
	let mut rest = raw.trim_start();
	if let Some(register_raw) = rest.strip_prefix('@') {
		let name_len = register_raw
			.bytes()
			.take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
			.count();
		if name_len == 0 || name_len > 64 {
			return None;
		}
		let name = register_raw[..name_len].to_string();
		target = with_register(target, Some(name));
		rest = register_raw[name_len..].trim_start();
	}
	let had_colon = rest.starts_with(':');
	if had_colon {
		rest = rest[1..].trim_start();
	}
	if rest.is_empty() {
		Some((target, had_colon))
	} else {
		None
	}
}

fn with_register(target: BlockTarget, register: Option<String>) -> BlockTarget {
	match target {
		BlockTarget::Replace { range, .. } => BlockTarget::Replace { range, register },
		BlockTarget::Block { anchor, .. } => BlockTarget::Block { anchor, register },
		BlockTarget::InsertBefore { anchor, .. } => BlockTarget::InsertBefore { anchor, register },
		BlockTarget::InsertAfter { anchor, .. } => BlockTarget::InsertAfter { anchor, register },
		BlockTarget::InsertAfterBlock { anchor, .. } => {
			BlockTarget::InsertAfterBlock { anchor, register }
		},
		BlockTarget::Cut { range, .. } => BlockTarget::Cut { range, register },
		BlockTarget::CutBlock { anchor, .. } => BlockTarget::CutBlock { anchor, register },
		BlockTarget::Bof { .. } => BlockTarget::Bof { register },
		BlockTarget::Eof { .. } => BlockTarget::Eof { register },
		other => other,
	}
}

fn parse_put_target(raw: &str) -> Option<(BlockTarget, bool)> {
	let rest = raw.trim_start();
	if let Some(after) = rest.strip_prefix('>') {
		let after = after.trim_start();
		if let Some(tail) = after.strip_prefix('$') {
			return parse_register_and_colon(tail, BlockTarget::Eof { register: None });
		}
		let (line, used) = parse_number_prefix(after)?;
		let mut tail = &after[used..];
		let block = tail.starts_with('*');
		if block {
			tail = &tail[1..];
		}
		let target = if block {
			BlockTarget::InsertAfterBlock { anchor: Anchor { line }, register: None }
		} else {
			BlockTarget::InsertAfter { anchor: Anchor { line }, register: None }
		};
		return parse_register_and_colon(tail, target);
	}
	if let Some(after) = rest.strip_prefix('<') {
		let after = after.trim_start();
		let (line, used) = parse_number_prefix(after)?;
		let mut tail = &after[used..];
		if tail.starts_with('*') {
			tail = &tail[1..];
		}
		let target = if line == 1 {
			BlockTarget::Bof { register: None }
		} else {
			BlockTarget::InsertBefore { anchor: Anchor { line }, register: None }
		};
		return parse_register_and_colon(tail, target);
	}
	let (range, used, had_separator) = parse_range(rest, true)?;
	let mut tail = &rest[used..];
	if tail.starts_with('*') {
		if had_separator {
			return None;
		}
		tail = &tail[1..];
		return parse_register_and_colon(tail, BlockTarget::Block {
			anchor:   range.start,
			register: None,
		});
	}
	parse_register_and_colon(tail, BlockTarget::Replace { range, register: None })
}

fn parse_cut_target(raw: &str) -> Option<(BlockTarget, bool)> {
	let rest = raw.trim_start();
	let (range, used, had_separator) = parse_range(rest, true)?;
	let mut tail = &rest[used..];
	if tail.starts_with('*') {
		if had_separator {
			return None;
		}
		tail = &tail[1..];
		return parse_register_and_colon(tail, BlockTarget::CutBlock {
			anchor:   range.start,
			register: None,
		});
	}
	parse_register_and_colon(tail, BlockTarget::Cut { range, register: None })
}

fn keyword_tail<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
	let rest = line.strip_prefix(keyword)?;
	if rest.is_empty()
		|| rest.starts_with(':')
		|| rest.chars().next().is_some_and(char::is_whitespace)
	{
		Some(rest)
	} else {
		None
	}
}

fn parse_hunk_header(line: &str) -> Option<(BlockTarget, bool)> {
	let line = line.trim();
	if let Some(rest) = keyword_tail(line, HL_REM_KEYWORD) {
		return rest.trim().is_empty().then_some((BlockTarget::Rem, false));
	}
	if let Some(rest) = keyword_tail(line, HL_MOVE_KEYWORD) {
		let dest = unquote_path(rest.trim())?;
		return (!dest.is_empty()).then_some((BlockTarget::Move { dest }, false));
	}
	if let Some(rest) = keyword_tail(line, HL_PUT_KEYWORD) {
		return parse_put_target(rest);
	}
	if let Some(rest) = keyword_tail(line, HL_CUT_KEYWORD) {
		return parse_cut_target(rest);
	}
	None
}

fn unquote_path(raw: &str) -> Option<String> {
	if raw.len() >= 2
		&& ((raw.starts_with('"') && raw.ends_with('"'))
			|| (raw.starts_with('\'') && raw.ends_with('\'')))
	{
		return Some(raw[1..raw.len() - 1].to_string());
	}
	if raw.starts_with('"') || raw.starts_with('\'') {
		None
	} else {
		Some(raw.to_string())
	}
}

fn parse_header(line: &str) -> Option<(String, Option<String>)> {
	let line = line.trim_end();
	let body = line
		.strip_prefix(HL_FILE_PREFIX)?
		.strip_suffix(HL_FILE_SUFFIX)?;
	if body.is_empty() {
		return None;
	}
	if let Some((path, hash)) = body.rsplit_once(HL_FILE_HASH_SEP) {
		if path.is_empty()
			|| path.contains('#')
			|| hash.len() != HL_FILE_HASH_LENGTH
			|| !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
		{
			return None;
		}
		return Some((path.to_string(), Some(hash.to_ascii_uppercase())));
	}
	if body.contains('#') {
		None
	} else {
		Some((body.to_string(), None))
	}
}

fn classify_line(line: &str, line_num: u32) -> Token {
	if line.is_empty() {
		return Token::Blank { line_num };
	}
	if marker_line_equals(line, BEGIN_PATCH_MARKER) {
		return Token::EnvelopeBegin { line_num };
	}
	if marker_line_equals(line, END_PATCH_MARKER) {
		return Token::EnvelopeEnd { line_num };
	}
	if marker_line_equals(line, ABORT_MARKER) {
		return Token::Abort { line_num };
	}
	if let Some((path, file_hash)) = parse_header(line) {
		return Token::Header { line_num, path, file_hash };
	}
	if let Some((target, had_colon)) = parse_hunk_header(line) {
		return Token::OpBlock { line_num, target, had_colon };
	}
	if let Some(text) = line.strip_prefix('+') {
		return Token::PayloadLiteral { line_num, text: text.to_string() };
	}
	Token::Raw { line_num, text: line.to_string() }
}
