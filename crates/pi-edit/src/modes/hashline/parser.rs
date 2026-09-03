//! Token-driven parser for hashline section bodies.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	fmt,
	sync::LazyLock,
};

use regex::Regex;

pub use super::messages::AbsoluteRangeOp;
use super::{
	input::Parsed,
	messages::{
		self, BARE_BODY_AUTO_PIPED_WARNING, BARE_RANGE_AUTO_PUT_WARNING, COLON_ON_REGISTER_PUT,
		COLONLESS_PUT_TAKES_NO_BODY, COLONLESS_SPAN_PUT, CUT_COLON_IGNORED_WARNING,
		CUT_TAKES_NO_BODY, DIFF_OLD_ROWS_IGNORED_WARNING, EMPTY_INSERT, EMPTY_PUT_AUTO_CUT_WARNING,
		MINUS_BULLET_AUTO_PIPED_WARNING, MINUS_ROW_REJECTED, MOVE_TAKES_NO_BODY,
		READ_METADATA_IGNORED_WARNING, REGISTER_PUT_TAKES_NO_BODY, REM_TAKES_NO_BODY,
		REPLACE_PAIR_COALESCED_WARNING, SNAPSHOT_ROWS_AUTO_PUT_WARNING,
	},
	prefixes::{is_read_metadata_line, strip_one_leading_hashline_prefix},
	tokenizer::{BlockTarget, Token, Tokenizer, is_hunk_header_text},
	types::{Anchor, BlockMode, BlockSpan, Cursor, Edit, FileOp, ParsedRange, PasteTarget},
};
use crate::error::EditError;

const MAX_EXPANDED_RANGE_LINES: u32 = 100_000;
static UNIFIED_HUNK_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@").expect("valid regex"));

/// Inverted concrete range with metadata for source-aware enrichment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidAbsoluteRange {
	pub patch_line: u32,
	pub start_line: u32,
	pub end_line:   u32,
	pub op:         AbsoluteRangeOp,
	pub register:   Option<String>,
	pub block:      Option<BlockSpan>,
}
impl InvalidAbsoluteRange {
	/// Format the model-facing absolute-range guidance.
	pub fn message(&self) -> String {
		messages::invalid_absolute_range_message(
			self.patch_line,
			self.start_line,
			self.end_line,
			self.op,
			self.block,
			self.register.as_deref(),
		)
	}

	#[must_use]
	/// Return this error enriched with a proven syntactic block.
	pub fn with_block(&self, block: BlockSpan) -> Self {
		Self { block: Some(block), ..self.clone() }
	}
}

/// Failure raised while lowering hashline tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseFailure {
	InvalidAbsoluteRange(InvalidAbsoluteRange),
	Other(String),
}
impl fmt::Display for ParseFailure {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::InvalidAbsoluteRange(error) => formatter.write_str(&error.message()),
			Self::Other(message) => formatter.write_str(message),
		}
	}
}
impl From<ParseFailure> for EditError {
	fn from(value: ParseFailure) -> Self {
		Self::parse(value.to_string())
	}
}

#[derive(Debug, Clone)]
struct PayloadRow {
	text:     String,
	line_num: u32,
	bare:     bool,
	minus:    bool,
}
#[derive(Debug, Clone)]
struct Pending {
	target:          BlockTarget,
	line_num:        u32,
	payloads:        Vec<PayloadRow>,
	had_colon:       bool,
	deferred_blanks: Vec<PayloadRow>,
}

/// Incremental token-to-edit executor.
pub struct Executor {
	edits:                    Vec<Edit>,
	warnings:                 Vec<String>,
	edit_index:               u32,
	pending:                  Option<Pending>,
	file_op:                  Option<FileOp>,
	terminated:               bool,
	skippable_comments:       Vec<(u32, String)>,
	recovered_snapshot_lines: HashSet<u32>,
}

impl Default for Executor {
	fn default() -> Self {
		Self::new()
	}
}

impl Executor {
	/// Construct an empty executor.
	pub fn new() -> Self {
		Self {
			edits:                    Vec::new(),
			warnings:                 Vec::new(),
			edit_index:               0,
			pending:                  None,
			file_op:                  None,
			terminated:               false,
			skippable_comments:       Vec::new(),
			recovered_snapshot_lines: HashSet::new(),
		}
	}

	/// Consume one classified token.
	pub fn push(&mut self, token: Token) -> Result<(), ParseFailure> {
		self.feed(token)
	}

	/// Finish an authoritative parse and reset the executor.
	pub fn end(&mut self) -> Result<Parsed, ParseFailure> {
		std::mem::take(self).finish(false)
	}

	/// Finish a streaming-tolerant parse and reset the executor.
	pub fn end_streaming(&mut self) -> Result<Parsed, ParseFailure> {
		std::mem::take(self).finish(true)
	}

	/// Discard accumulated parser state.
	pub fn reset(&mut self) {
		*self = Self::new();
	}

	fn warn_once(&mut self, warning: &str) {
		if !self.warnings.iter().any(|entry| entry == warning) {
			self.warnings.push(warning.to_string());
		}
	}

	fn consume_comments(&mut self) -> Result<(), ParseFailure> {
		let comments = std::mem::take(&mut self.skippable_comments);
		for (line_num, text) in comments {
			self.handle_raw(&text, line_num)?;
		}
		Ok(())
	}

	fn feed(&mut self, token: Token) -> Result<(), ParseFailure> {
		if self.terminated {
			return Ok(());
		}
		match token {
			Token::EnvelopeBegin { .. } => self.consume_comments(),
			Token::EnvelopeEnd { .. } => {
				self.consume_comments()?;
				self.terminated = true;
				Ok(())
			},
			Token::Abort { .. } => {
				self.terminated = true;
				Ok(())
			},
			Token::Header { .. } => {
				self.consume_comments()?;
				self.flush_pending()
			},
			Token::Blank { line_num } => {
				self.consume_comments()?;
				self.handle_blank("", line_num);
				Ok(())
			},
			Token::PayloadLiteral { line_num, text } => {
				self.consume_comments()?;
				self.handle_literal(&text, line_num)
			},
			Token::Raw { line_num, text } => {
				if self.pending.is_none() && text.trim_start().starts_with('#') {
					self.skippable_comments.push((line_num, text));
					return Ok(());
				}
				self.consume_comments()?;
				self.handle_raw(&text, line_num)
			},
			Token::OpBlock { line_num, target, had_colon } => {
				self.skippable_comments.clear();
				if let BlockTarget::Replace { range, register } = &target {
					validate_range(*range, line_num, AbsoluteRangeOp::Replace, register.as_deref())?;
				}
				if let BlockTarget::Cut { range, register } = &target {
					validate_range(*range, line_num, AbsoluteRangeOp::Cut, register.as_deref())?;
				}
				if had_colon && matches!(target, BlockTarget::Cut { .. } | BlockTarget::CutBlock { .. })
				{
					self.warn_once(CUT_COLON_IGNORED_WARNING);
				}
				if had_colon
					&& !matches!(target, BlockTarget::Rem | BlockTarget::Move { .. })
					&& target.register().is_some()
				{
					return fail_at(line_num, COLON_ON_REGISTER_PUT);
				}
				match target {
					BlockTarget::Rem => {
						self.flush_pending()?;
						self.set_file_op(FileOp::Rem, line_num)
					},
					BlockTarget::Move { dest } => {
						self.flush_pending()?;
						self.set_file_op(FileOp::Move { dest }, line_num)
					},
					target => {
						self.flush_pending()?;
						self.pending = Some(Pending {
							target,
							line_num,
							payloads: Vec::new(),
							had_colon,
							deferred_blanks: Vec::new(),
						});
						Ok(())
					},
				}
			},
		}
	}

	fn finish(mut self, streaming: bool) -> Result<Parsed, ParseFailure> {
		self.consume_comments()?;
		if streaming {
			let flush = self
				.pending
				.as_ref()
				.is_some_and(|pending| !pending.payloads.is_empty() || complete_bodyless(pending));
			if flush {
				self.flush_pending()?;
			} else {
				self.pending = None;
			}
		} else {
			self.flush_pending()?;
		}
		if matches!(self.file_op, Some(FileOp::Rem)) && !self.edits.is_empty() {
			return Err(ParseFailure::Other(
				"`REM` deletes the whole file and cannot be combined with line ops.".into(),
			));
		}
		self.normalize_overlaps()?;
		Ok(Parsed { edits: self.edits, file_op: self.file_op, warnings: self.warnings })
	}

	fn set_file_op(&mut self, op: FileOp, line_num: u32) -> Result<(), ParseFailure> {
		if self.file_op.is_some() {
			return fail_at(
				line_num,
				"only one file-level op (`REM` or `MV`) per section. Merge them under one header.",
			);
		}
		if matches!(op, FileOp::Rem) && !self.edits.is_empty() {
			return fail_at(line_num, REM_TAKES_NO_BODY);
		}
		self.file_op = Some(op);
		Ok(())
	}

	fn handle_literal(&mut self, text: &str, line_num: u32) -> Result<(), ParseFailure> {
		let Some(pending) = self.pending.as_ref() else {
			if self.file_op.is_some() {
				return fail_at(line_num, MOVE_TAKES_NO_BODY);
			}
			return fail_at(
				line_num,
				&format!(
					"payload line has no preceding hunk header. Got {}.",
					messages::json_quote(&format!("+{text}"))
				),
			);
		};
		if let Some(message) = bodyless_message(&pending.target, pending.had_colon) {
			return fail_at(line_num, message);
		}
		let pending = self.pending.as_mut().expect("checked");
		pending.payloads.append(&mut pending.deferred_blanks);
		if is_hunk_header_text(text) {
			self
				.warnings
				.push(messages::literal_op_row_warning(line_num, text));
		}
		pending.payloads.push(PayloadRow {
			text: text.to_string(),
			line_num,
			bare: false,
			minus: false,
		});
		Ok(())
	}

	fn handle_raw(&mut self, text: &str, line_num: u32) -> Result<(), ParseFailure> {
		if self.pending.is_none() && is_read_metadata_line(text) {
			self.warn_once(READ_METADATA_IGNORED_WARNING);
			return Ok(());
		}
		if let Some(message) = contamination_message(text) {
			return fail_at(line_num, &message);
		}
		if self.file_op.is_some() {
			return fail_at(line_num, MOVE_TAKES_NO_BODY);
		}
		if let Some(pending) = self.pending.as_ref() {
			if text.trim().is_empty() {
				self.handle_blank(text, line_num);
				return Ok(());
			}
			if let Some(message) = bodyless_message(&pending.target, pending.had_colon) {
				return fail_at(line_num, message);
			}
			let minus = text.trim_start().starts_with('-');
			if !minus {
				self.warn_once(BARE_BODY_AUTO_PIPED_WARNING);
			}
			let pending = self.pending.as_mut().expect("checked");
			pending.payloads.append(&mut pending.deferred_blanks);
			pending
				.payloads
				.push(PayloadRow { text: text.to_string(), line_num, bare: true, minus });
			return Ok(());
		}
		if text.trim().is_empty() {
			return Ok(());
		}
		if let Some(range) = parse_bare_range(text) {
			validate_range(range, line_num, AbsoluteRangeOp::Replace, None)?;
			self.pending = Some(Pending {
				target: BlockTarget::Replace { range, register: None },
				line_num,
				payloads: Vec::new(),
				had_colon: true,
				deferred_blanks: Vec::new(),
			});
			self.warn_once(BARE_RANGE_AUTO_PUT_WARNING);
			return Ok(());
		}
		if let Some((line, value)) = parse_snapshot_row(text) {
			if !self.recovered_snapshot_lines.insert(line) {
				return fail_at(line_num, &messages::repeated_snapshot_row_message(line));
			}
			let range = ParsedRange { start: Anchor { line }, end: Anchor { line } };
			self.push_insert(Cursor::BeforeAnchor(Anchor { line }), value, line_num, true);
			self.push_delete_range(range, line_num);
			self.warn_once(SNAPSHOT_ROWS_AUTO_PUT_WARNING);
			return Ok(());
		}
		fail_at(
			line_num,
			&format!(
				"payload line has no preceding hunk header. Use `PUT N.=M:`, `CUT N.=M`, or `PUT \
				 <N:`/`PUT >N:` above the body. Got {}.",
				messages::json_quote(text)
			),
		)
	}

	fn handle_blank(&mut self, text: &str, line_num: u32) {
		let Some(pending) = self.pending.as_mut() else {
			return;
		};
		if bodyless_message(&pending.target, pending.had_colon).is_some()
			|| pending.payloads.is_empty()
		{
			return;
		}
		pending.deferred_blanks.push(PayloadRow {
			text: text.to_string(),
			line_num,
			bare: true,
			minus: false,
		});
	}

	fn flush_pending(&mut self) -> Result<(), ParseFailure> {
		let Some(mut pending) = self.pending.take() else {
			return Ok(());
		};
		self.resolve_minus_rows(&mut pending.payloads)?;
		strip_uniform_bare_prefixes(&mut pending.payloads);
		let line = pending.line_num;
		match pending.target {
			BlockTarget::Rem | BlockTarget::Move { .. } => {},
			BlockTarget::Cut { range, register } => self.push_cut(range, register, line),
			BlockTarget::CutBlock { anchor, register } => {
				self.push_block(anchor, Vec::new(), Some(BlockMode::Cut), register, line);
			},
			BlockTarget::Replace { range, register } => {
				if register.is_some() {
					self.push_paste(PasteTarget::Span { range }, register, line);
				} else if pending.payloads.is_empty() {
					if !pending.had_colon {
						return fail_at(line, COLONLESS_SPAN_PUT);
					}
					self.push_delete_range(range, line);
					self.warn_once(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					for row in pending.payloads {
						self.push_insert(Cursor::BeforeAnchor(range.start), row.text, line, true);
					}
					self.push_delete_range(range, line);
				}
			},
			BlockTarget::Block { anchor, register } => {
				if register.is_some() {
					self.push_block(anchor, Vec::new(), None, register, line);
				} else if pending.payloads.is_empty() {
					if !pending.had_colon {
						return fail_at(line, COLONLESS_SPAN_PUT);
					}
					self.push_block(anchor, Vec::new(), None, None, line);
					self.warn_once(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					self.push_block(
						anchor,
						pending.payloads.into_iter().map(|row| row.text).collect(),
						None,
						None,
						line,
					);
				}
			},
			BlockTarget::InsertAfterBlock { anchor, register } => {
				if register.is_some() || (!pending.had_colon && pending.payloads.is_empty()) {
					self.push_block(anchor, Vec::new(), Some(BlockMode::PasteAfter), register, line);
				} else if pending.payloads.is_empty() {
					return fail_at(line, EMPTY_INSERT);
				} else {
					self.push_block(
						anchor,
						pending.payloads.into_iter().map(|row| row.text).collect(),
						Some(BlockMode::InsertAfter),
						None,
						line,
					);
				}
			},
			target => {
				let (cursor, register) = match target {
					BlockTarget::InsertBefore { anchor, register } => {
						(Cursor::BeforeAnchor(anchor), register)
					},
					BlockTarget::InsertAfter { anchor, register } => {
						(Cursor::AfterAnchor(anchor), register)
					},
					BlockTarget::Bof { register } => (Cursor::Bof, register),
					BlockTarget::Eof { register } => (Cursor::Eof, register),
					_ => unreachable!(),
				};
				if register.is_some() || (!pending.had_colon && pending.payloads.is_empty()) {
					self.push_paste(PasteTarget::Gap { cursor }, register, line);
				} else if pending.payloads.is_empty() {
					return fail_at(line, EMPTY_INSERT);
				} else {
					for row in pending.payloads {
						self.push_insert(cursor, row.text, line, false);
					}
				}
			},
		}
		Ok(())
	}

	fn resolve_minus_rows(&mut self, rows: &mut Vec<PayloadRow>) -> Result<(), ParseFailure> {
		let minus: Vec<_> = rows.iter().filter(|row| row.minus).collect();
		if minus.is_empty() {
			return Ok(());
		}
		let all_bullets = minus.iter().all(|row| markdown_bullet(&row.text));
		let explicit: Vec<_> = rows.iter().filter(|row| !row.bare).collect();
		if all_bullets
			&& (explicit.is_empty() || explicit.iter().any(|row| markdown_bullet(&row.text)))
		{
			self.warn_once(MINUS_BULLET_AUTO_PIPED_WARNING);
			return Ok(());
		}
		if !explicit.is_empty() && !all_bullets {
			rows.retain(|row| !row.minus);
			self.warn_once(DIFF_OLD_ROWS_IGNORED_WARNING);
			return Ok(());
		}
		fail_at(minus[0].line_num, MINUS_ROW_REJECTED)
	}

	const fn next_index(&mut self) -> u32 {
		let index = self.edit_index;
		self.edit_index = self.edit_index.saturating_add(1);
		index
	}

	fn push_insert(&mut self, cursor: Cursor, text: String, line_num: u32, replacement: bool) {
		let index = self.next_index();
		self.edits.push(Edit::Insert {
			cursor,
			text,
			line_num,
			index,
			replacement,
			block_start: None,
		});
	}

	fn push_delete(&mut self, anchor: Anchor, line_num: u32) {
		let index = self.next_index();
		self
			.edits
			.push(Edit::Delete { anchor, line_num, index, old_assertion: None });
	}

	fn push_delete_range(&mut self, range: ParsedRange, line_num: u32) {
		for line in range.start.line..=range.end.line {
			self.push_delete(Anchor { line }, line_num);
		}
	}

	fn push_cut(&mut self, range: ParsedRange, register: Option<String>, line_num: u32) {
		let index = self.next_index();
		self
			.edits
			.push(Edit::Cut { range, register, line_num, index });
		self.push_delete_range(range, line_num);
	}

	fn push_paste(&mut self, at: PasteTarget, register: Option<String>, line_num: u32) {
		let index = self.next_index();
		self
			.edits
			.push(Edit::Paste { at, register, line_num, index, block_start: None });
	}

	fn push_block(
		&mut self,
		anchor: Anchor,
		payloads: Vec<String>,
		mode: Option<BlockMode>,
		register: Option<String>,
		line_num: u32,
	) {
		let index = self.next_index();
		self
			.edits
			.push(Edit::Block { anchor, payloads, mode, register, line_num, index });
	}

	fn normalize_overlaps(&mut self) -> Result<(), ParseFailure> {
		#[derive(Default)]
		struct Hunk {
			lines:     BTreeSet<u32>,
			clipboard: bool,
		}
		let mut hunks: BTreeMap<u32, Hunk> = BTreeMap::new();
		for edit in &self.edits {
			match edit {
				Edit::Cut { line_num, .. } => hunks.entry(*line_num).or_default().clipboard = true,
				Edit::Paste { at: PasteTarget::Span { range }, line_num, .. } => {
					let hunk = hunks.entry(*line_num).or_default();
					hunk.clipboard = true;
					hunk.lines.extend(range.start.line..=range.end.line);
				},
				Edit::Delete { anchor, line_num, .. } => {
					hunks
						.entry(*line_num)
						.or_default()
						.lines
						.insert(anchor.line);
				},
				_ => {},
			}
		}
		let mut owner: HashMap<u32, u32> = HashMap::new();
		let mut dropped = HashSet::new();
		for (&line_num, hunk) in &hunks {
			if hunk.lines.is_empty() {
				continue;
			}
			let overlaps: BTreeSet<u32> = hunk
				.lines
				.iter()
				.filter_map(|line| owner.get(line).copied())
				.collect();
			if overlaps.is_empty() {
				for line in &hunk.lines {
					owner.insert(*line, line_num);
				}
				continue;
			}
			let previous = (overlaps.len() == 1).then(|| *overlaps.first().expect("one"));
			let exact = previous
				.and_then(|prev| {
					hunks
						.get(&prev)
						.map(|old| !old.clipboard && old.lines == hunk.lines)
				})
				.unwrap_or(false);
			if exact {
				let prev = previous.expect("exact");
				dropped.insert(prev);
				owner.retain(|_, value| *value != prev);
				for line in &hunk.lines {
					owner.insert(*line, line_num);
				}
				self.warn_once(REPLACE_PAIR_COALESCED_WARNING);
				continue;
			}
			let first = hunk
				.lines
				.iter()
				.find(|line| owner.contains_key(line))
				.copied()
				.unwrap_or(0);
			let prior = previous.map_or_else(|| "an earlier line".into(), |line| line.to_string());
			return fail_at(
				line_num,
				&format!(
					"anchor line {first} is already targeted by another hunk on line {prior}. Issue \
					 ONE hunk per range; payload is only the final desired content, never a \
					 before/after pair."
				),
			);
		}
		if !dropped.is_empty() {
			self
				.edits
				.retain(|edit| !dropped.contains(&edit.line_num()));
		}
		Ok(())
	}
}

fn validate_range(
	range: ParsedRange,
	line_num: u32,
	op: AbsoluteRangeOp,
	register: Option<&str>,
) -> Result<(), ParseFailure> {
	if range.end.line < range.start.line {
		return Err(ParseFailure::InvalidAbsoluteRange(InvalidAbsoluteRange {
			patch_line: line_num,
			start_line: range.start.line,
			end_line: range.end.line,
			op,
			register: register.map(str::to_owned),
			block: None,
		}));
	}
	let span = range.end.line - range.start.line + 1;
	if span > MAX_EXPANDED_RANGE_LINES {
		return fail_at(
			line_num,
			&format!(
				"{op} range spans {span} lines; the maximum is {MAX_EXPANDED_RANGE_LINES}. Split it \
				 into smaller hunks."
			),
		);
	}
	Ok(())
}
fn fail_at<T>(line: u32, message: &str) -> Result<T, ParseFailure> {
	Err(ParseFailure::Other(format!("line {line}: {message}")))
}
fn bodyless_message(target: &BlockTarget, had_colon: bool) -> Option<&'static str> {
	if matches!(target, BlockTarget::Cut { .. } | BlockTarget::CutBlock { .. }) {
		Some(CUT_TAKES_NO_BODY)
	} else if matches!(target, BlockTarget::Rem | BlockTarget::Move { .. }) {
		None
	} else if target.register().is_some() {
		Some(REGISTER_PUT_TAKES_NO_BODY)
	} else if !had_colon {
		Some(COLONLESS_PUT_TAKES_NO_BODY)
	} else {
		None
	}
}
fn complete_bodyless(pending: &Pending) -> bool {
	matches!(pending.target, BlockTarget::Cut { .. } | BlockTarget::CutBlock { .. })
		|| pending.target.register().is_some()
		|| (!pending.had_colon
			&& matches!(
				pending.target,
				BlockTarget::InsertBefore { .. }
					| BlockTarget::InsertAfter { .. }
					| BlockTarget::InsertAfterBlock { .. }
					| BlockTarget::Bof { .. }
					| BlockTarget::Eof { .. }
			))
}
fn markdown_bullet(text: &str) -> bool {
	let trimmed = text.trim_start();
	trimmed.starts_with("- ")
		&& trimmed[2..]
			.chars()
			.next()
			.is_some_and(|ch| !ch.is_whitespace())
}
fn parse_snapshot_row(text: &str) -> Option<(u32, String)> {
	let trimmed = text.trim_start();
	let split = trimmed.find([':', '|'])?;
	let number = &trimmed[..split];
	if number.starts_with('0') || !number.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	Some((number.parse().ok()?, trimmed[split + 1..].to_string()))
}
fn parse_bare_range(text: &str) -> Option<ParsedRange> {
	let trimmed = text.trim();
	let before = trimmed.strip_suffix(':')?.trim();
	let mut numbers = before
		.split(|ch: char| ch.is_whitespace() || matches!(ch, '-' | '.' | '=' | '…'))
		.filter(|part| !part.is_empty());
	let start: u32 = numbers.next()?.parse().ok()?;
	let end: u32 = numbers.next()?.parse().ok()?;
	if numbers.next().is_some() || start == 0 || end == 0 {
		return None;
	}
	Some(ParsedRange { start: Anchor { line: start }, end: Anchor { line: end } })
}
fn contamination_message(text: &str) -> Option<String> {
	let trimmed = text.trim_start();
	if ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"]
		.iter()
		.any(|prefix| trimmed.starts_with(prefix))
	{
		let preview = if trimmed.chars().count() > 48 {
			format!("{}…", trimmed.chars().take(48).collect::<String>())
		} else {
			trimmed.into()
		};
		return Some(format!(
			"apply_patch sentinel {} is not valid in hashline. File sections start with \
			 `[path#HASH]` (no `Update File:` / `Add File:` keyword). Use `PUT N.=M:`, `CUT N.=M`, \
			 or `PUT <N:`/`PUT >N:` ops.",
			messages::json_quote(&preview)
		));
	}
	if trimmed.starts_with("@@") {
		if UNIFIED_HUNK_RE.is_match(trimmed) {
			return Some(
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `PUT \
				 N.=M:`, `CUT N.=M`, or `PUT <N:`/`PUT >N:` ops."
					.to_string(),
			);
		}
		let preview = if trimmed.chars().count() > 48 {
			format!("{}…", trimmed.chars().take(48).collect::<String>())
		} else {
			trimmed.into()
		};
		return Some(format!(
			"`@@`-bracketed hunk header {} is not valid in hashline. Drop the `@@ ... @@` brackets \
			 and write a header such as `PUT N.=M:`.",
			messages::json_quote(&preview)
		));
	}
	if !trimmed.is_empty()
		&& trimmed
			.bytes()
			.all(|byte| byte.is_ascii_digit() || byte.is_ascii_whitespace())
		&& trimmed.split_whitespace().count() == 1
	{
		return Some(format!(
			"hunk headers need a verb and both endpoints. Use `PUT {0}.={0}:` to replace, or `CUT \
			 {0}.={0}` to delete.",
			trimmed.trim()
		));
	}
	let pieces: Vec<_> = trimmed.trim_end_matches(':').split_whitespace().collect();
	if pieces.len() == 2
		&& pieces
			.iter()
			.all(|piece| piece.bytes().all(|b| b.is_ascii_digit()))
	{
		return Some(format!(
			"bare range hunk header {} is not valid. Hunk headers need a verb: use `PUT N.=M:` or \
			 `CUT N.=M`.",
			messages::json_quote(trimmed)
		));
	}
	None
}
fn strip_uniform_bare_prefixes(rows: &mut [PayloadRow]) {
	let mut saw = false;
	let mut all_literal = true;
	for row in rows
		.iter()
		.filter(|row| row.bare && !row.text.trim().is_empty())
	{
		saw = true;
		let stripped = strip_one_leading_hashline_prefix(&row.text);
		if stripped == row.text {
			return;
		}
		all_literal &= literal_value(&stripped);
	}
	if !saw || all_literal {
		return;
	}
	for row in rows
		.iter_mut()
		.filter(|row| row.bare && !row.text.trim().is_empty())
	{
		row.text = strip_one_leading_hashline_prefix(&row.text);
	}
}
fn literal_value(text: &str) -> bool {
	let value = text.trim().trim_end_matches(',').trim();
	(value.len() >= 2
		&& ((value.starts_with('"') && value.ends_with('"'))
			|| (value.starts_with('\'') && value.ends_with('\''))))
		|| value.parse::<f64>().is_ok()
}

/// Parse a complete hashline section body.
pub fn parse_patch(diff: &str) -> Result<Parsed, ParseFailure> {
	parse_impl(diff, false)
}
/// Parse a partial body while dropping the trailing incomplete operation.
pub fn parse_patch_streaming(diff: &str) -> Result<Parsed, ParseFailure> {
	parse_impl(diff, true)
}
fn parse_impl(diff: &str, streaming: bool) -> Result<Parsed, ParseFailure> {
	let mut tokenizer = Tokenizer::new();
	let mut executor = Executor::new();
	for token in tokenizer
		.feed(diff)
		.map_err(|error| ParseFailure::Other(error.to_string()))?
	{
		executor.feed(token)?;
	}
	for token in tokenizer.end() {
		executor.feed(token)?;
	}
	executor.finish(streaming)
}
