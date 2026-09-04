//! Immutable, aligned source documents used by the interactive diff pane.

use std::{fmt::Write as _, ops::Range, path::Path};

use omp_core::{IntoStr, Str, StrMut};
use similar::{Algorithm, DiffOp, capture_diff_slices};
use smallvec::SmallVec;
use strum::{EnumString, IntoStaticStr};
use xutf::{Text, width_char};

use crate::frame::Style;

const INTRALINE_PAIR_LIMIT: usize = 1_500;
const HUNK_CONTEXT: usize = 3;

/// A row's relationship between the old and new documents.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffRowKind {
	/// The same line occurs on both sides.
	Context,
	/// One old line is paired with one changed new line.
	Change,
	/// A line exists only on the new side.
	Add,
	/// A line exists only on the old side.
	Del,
}

/// A display-column range carrying intraline emphasis.
pub type DiffMark = Range<u16>;

/// One syntax-highlighted display-column run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffStyleRun {
	/// First display column in the run.
	pub start: u16,
	/// First display column after the run.
	pub end:   u16,
	/// Style applied to the run.
	pub style: Style,
}

/// One present side of an aligned diff row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffSide {
	/// One-based source line number.
	pub number: u32,
	/// Tab-expanded display text. It never contains terminal escapes.
	pub text:   Str,
	/// Display width in terminal cells.
	pub width:  u16,
	/// Cached, padded line-number gutter.
	pub gutter: Str,
	/// Syntax style runs, expressed in display columns.
	pub styles: Box<[DiffStyleRun]>,
	/// Intraline emphasis ranges, expressed in display columns.
	pub marks:  Box<[DiffMark]>,
}

/// One aligned row in a [`DiffDocument`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffRow {
	/// Relationship between the two sides.
	pub kind: DiffRowKind,
	/// Old side, absent for an added-only row.
	pub old:  Option<DiffSide>,
	/// New side, absent for a deleted-only row.
	pub new:  Option<DiffSide>,
}

/// One source line in file view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffFileLine {
	/// One-based source line number.
	pub number: u32,
	/// Tab-expanded display text.
	pub text:   Str,
	/// Display width in terminal cells.
	pub width:  u16,
	/// Cached, padded line-number gutter.
	pub gutter: Str,
	/// Syntax style runs, expressed in display columns.
	pub styles: Box<[DiffStyleRun]>,
}

/// A tight changed region with three surrounding context lines.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffHunk {
	/// Cached `@@ -a,b +c,d @@` display header.
	pub header:    Str,
	/// Old-side inclusive start and line count.
	pub old_range: (u32, u32),
	/// New-side inclusive start and line count.
	pub new_range: (u32, u32),
	/// Range into [`DiffDocument::rows`] shown by this hunk.
	pub rows:      Range<usize>,
}

/// How [`DiffDocument::build`] treats whitespace and formatting-only changes.
#[derive(Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum DiffWhitespaceMode {
	/// Diff source text exactly.
	#[default]
	Off,
	/// Align lines by trimmed contents.
	Whitespace,
	/// Keep exact alignment but render formatting- and import-only blocks as
	/// context.
	Formatting,
}

/// Options controlling construction of a [`DiffDocument`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DiffBuildOptions {
	/// Whitespace and formatting-only change handling.
	pub whitespace: DiffWhitespaceMode,
	/// Explicit syntax token or extension; the path extension is used when
	/// absent.
	pub language:   Option<Str>,
}

/// Immutable aligned old/new source text and cached display metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffDocument {
	/// Display path associated with the source.
	pub path:             Str,
	/// Full-file aligned rows.
	pub rows:             Vec<DiffRow>,
	/// Tight changed regions.
	pub hunks:            Vec<DiffHunk>,
	/// New-side source lines for file view.
	pub file_lines:       Vec<DiffFileLine>,
	/// Number of added source lines.
	pub additions:        u32,
	/// Number of deleted source lines.
	pub deletions:        u32,
	/// Width reserved for one line-number gutter.
	pub gutter_width:     u16,
	/// Widest source line in display cells.
	pub max_line_width:   u16,
	/// Global aligned row for each one-based new-side line; index zero is
	/// unused.
	pub row_by_new_line:  Vec<Option<usize>>,
	/// Tab-expanded old-side source retained for progressive highlighting.
	pub(crate) old_lines: Vec<Str>,
	/// Tab-expanded new-side source retained for progressive highlighting.
	pub(crate) new_lines: Vec<Str>,
	/// Resolved syntax token for progressive highlighting.
	pub(crate) language:  Option<Str>,
}

impl DiffDocument {
	/// Builds an aligned document from old and new source text.
	pub fn build(old: &str, new: &str, path: &str, options: &DiffBuildOptions) -> Self {
		let old_raw = source_lines(old);
		let new_raw = source_lines(new);
		let old_display: Vec<Str> = old_raw.iter().map(|line| expand_tabs(line)).collect();
		let new_display: Vec<Str> = new_raw.iter().map(|line| expand_tabs(line)).collect();
		let old_basis: Vec<&str> = if options.whitespace == DiffWhitespaceMode::Whitespace {
			old_raw.iter().map(|line| line.trim()).collect()
		} else {
			old_raw.clone()
		};
		let new_basis: Vec<&str> = if options.whitespace == DiffWhitespaceMode::Whitespace {
			new_raw.iter().map(|line| line.trim()).collect()
		} else {
			new_raw.clone()
		};
		let line_max = old_raw.len().max(new_raw.len()).max(1);
		let gutter_width = decimal_width(line_max).max(3) as u16;
		let language = resolved_language(path, options);
		let mut rows = Vec::new();
		let mut intraline_pairs = 0usize;
		for operation in capture_diff_slices(Algorithm::Myers, &old_basis, &new_basis) {
			match operation {
				DiffOp::Equal { old_index, new_index, len } => {
					for offset in 0..len {
						rows.push(make_row(
							DiffRowKind::Context,
							Some(side(old_index + offset, &old_display, None, gutter_width)),
							Some(side(new_index + offset, &new_display, None, gutter_width)),
						));
					}
				},
				DiffOp::Delete { old_index, old_len, .. } => {
					for offset in 0..old_len {
						rows.push(make_row(
							DiffRowKind::Del,
							Some(side(old_index + offset, &old_display, None, gutter_width)),
							None,
						));
					}
				},
				DiffOp::Insert { new_index, new_len, .. } => {
					for offset in 0..new_len {
						rows.push(make_row(
							DiffRowKind::Add,
							None,
							Some(side(new_index + offset, &new_display, None, gutter_width)),
						));
					}
				},
				DiffOp::Replace { old_index, old_len, new_index, new_len } => {
					let paired = old_len.min(new_len);
					for offset in 0..paired {
						let mut old_side = side(old_index + offset, &old_display, None, gutter_width);
						let mut new_side = side(new_index + offset, &new_display, None, gutter_width);
						if intraline_pairs < INTRALINE_PAIR_LIMIT {
							let (old_marks, new_marks) = intraline_marks(&old_side.text, &new_side.text);
							old_side.marks = old_marks;
							new_side.marks = new_marks;
							intraline_pairs += 1;
						}
						rows.push(make_row(DiffRowKind::Change, Some(old_side), Some(new_side)));
					}
					for offset in paired..old_len {
						rows.push(make_row(
							DiffRowKind::Del,
							Some(side(old_index + offset, &old_display, None, gutter_width)),
							None,
						));
					}
					for offset in paired..new_len {
						rows.push(make_row(
							DiffRowKind::Add,
							None,
							Some(side(new_index + offset, &new_display, None, gutter_width)),
						));
					}
				},
			}
		}

		if options.whitespace == DiffWhitespaceMode::Formatting {
			demote_formatting_blocks(&mut rows, language.as_deref());
		}
		let additions = rows
			.iter()
			.map(|row| u32::from(matches!(row.kind, DiffRowKind::Add | DiffRowKind::Change)))
			.sum();
		let deletions = rows
			.iter()
			.map(|row| u32::from(matches!(row.kind, DiffRowKind::Del | DiffRowKind::Change)))
			.sum();
		let hunks = build_hunks(&rows);
		let mut row_by_new_line = vec![None; new_display.len().saturating_add(1)];
		for (index, row) in rows.iter().enumerate() {
			if let Some(side) = &row.new
				&& let Some(slot) = row_by_new_line.get_mut(side.number as usize)
			{
				*slot = Some(index);
			}
		}
		let file_lines = new_display
			.iter()
			.cloned()
			.enumerate()
			.map(|(index, text)| DiffFileLine {
				number: (index + 1) as u32,
				width: cell_width(&text),
				gutter: gutter_label(index + 1, gutter_width),
				styles: Box::default(),
				text,
			})
			.collect();
		let max_line_width = rows
			.iter()
			.flat_map(|row| [row.old.as_ref(), row.new.as_ref()])
			.flatten()
			.map(|side| side.width)
			.max()
			.unwrap_or(0);
		Self {
			path: path.into_str(),
			rows,
			hunks,
			file_lines,
			additions,
			deletions,
			gutter_width,
			max_line_width,
			row_by_new_line,
			old_lines: old_display,
			new_lines: new_display,
			language,
		}
	}

	/// Creates an empty provisional document for append-only line delivery.
	pub(crate) fn begin_stream(path: Str, options: &DiffBuildOptions) -> Self {
		let language = resolved_language(&path, options);
		Self {
			path,
			rows: Vec::new(),
			hunks: Vec::new(),
			file_lines: Vec::new(),
			additions: 0,
			deletions: 0,
			gutter_width: 3,
			max_line_width: 0,
			row_by_new_line: vec![None],
			old_lines: Vec::new(),
			new_lines: Vec::new(),
			language,
		}
	}

	/// Appends complete source lines and returns the first rebuilt row and new
	/// file line.
	pub(crate) fn push_stream(&mut self, old_lines: &[Str], new_lines: &[Str]) -> (usize, usize) {
		let old_start = self.old_lines.len();
		let new_start = self.new_lines.len();
		let stable = old_start.min(new_start);
		self.old_lines.extend(
			old_lines
				.iter()
				.map(|line| expand_tabs(line.as_str().strip_suffix('\r').unwrap_or(line))),
		);
		self.new_lines.extend(
			new_lines
				.iter()
				.map(|line| expand_tabs(line.as_str().strip_suffix('\r').unwrap_or(line))),
		);

		for row in &self.rows[stable..] {
			self.additions = self
				.additions
				.saturating_sub(u32::from(matches!(row.kind, DiffRowKind::Add | DiffRowKind::Change)));
			self.deletions = self
				.deletions
				.saturating_sub(u32::from(matches!(row.kind, DiffRowKind::Del | DiffRowKind::Change)));
		}
		self.rows.truncate(stable);

		let line_max = self.old_lines.len().max(self.new_lines.len()).max(1);
		let next_gutter = decimal_width(line_max).max(3) as u16;
		if next_gutter != self.gutter_width {
			self.gutter_width = next_gutter;
			for row in &mut self.rows {
				if let Some(side) = &mut row.old {
					side.gutter = gutter_label(side.number as usize, next_gutter);
				}
				if let Some(side) = &mut row.new {
					side.gutter = gutter_label(side.number as usize, next_gutter);
				}
			}
			for line in &mut self.file_lines {
				line.gutter = gutter_label(line.number as usize, next_gutter);
			}
		}

		for index in stable..line_max {
			let old = self
				.old_lines
				.get(index)
				.map(|_| side(index, &self.old_lines, None, self.gutter_width));
			let new = self
				.new_lines
				.get(index)
				.map(|_| side(index, &self.new_lines, None, self.gutter_width));
			let kind = match (&old, &new) {
				(Some(old), Some(new)) if old.text == new.text => DiffRowKind::Context,
				(Some(_), Some(_)) => DiffRowKind::Change,
				(Some(_), None) => DiffRowKind::Del,
				(None, Some(_)) => DiffRowKind::Add,
				(None, None) => continue,
			};
			let mut row = make_row(kind, old, new);
			if kind == DiffRowKind::Change
				&& index < INTRALINE_PAIR_LIMIT
				&& let (Some(old), Some(new)) = (&mut row.old, &mut row.new)
			{
				(old.marks, new.marks) = intraline_marks(&old.text, &new.text);
			}
			self.additions = self
				.additions
				.saturating_add(u32::from(matches!(kind, DiffRowKind::Add | DiffRowKind::Change)));
			self.deletions = self
				.deletions
				.saturating_add(u32::from(matches!(kind, DiffRowKind::Del | DiffRowKind::Change)));
			self.rows.push(row);
		}

		for (index, text) in self.new_lines.iter().enumerate().skip(new_start) {
			let width = cell_width(text);
			self.max_line_width = self.max_line_width.max(width);
			self.file_lines.push(DiffFileLine {
				number: (index + 1) as u32,
				text: text.clone(),
				width,
				gutter: gutter_label(index + 1, self.gutter_width),
				styles: Box::default(),
			});
		}
		for text in self.old_lines.iter().skip(old_start) {
			self.max_line_width = self.max_line_width.max(cell_width(text));
		}

		self
			.row_by_new_line
			.truncate(self.new_lines.len().saturating_add(1));
		self
			.row_by_new_line
			.resize(self.new_lines.len().saturating_add(1), None);
		for index in stable..self.new_lines.len() {
			self.row_by_new_line[index + 1] = Some(index);
		}
		(stable, new_start)
	}
}

fn resolved_language(path: &str, options: &DiffBuildOptions) -> Option<Str> {
	options.language.clone().or_else(|| {
		Path::new(path)
			.extension()
			.and_then(|extension| extension.to_str())
			.map(Str::new)
	})
}

fn source_lines(source: &str) -> Vec<&str> {
	if source.is_empty() {
		return Vec::new();
	}
	let source = source.strip_suffix('\n').unwrap_or(source);
	source
		.split('\n')
		.map(|line| line.strip_suffix('\r').unwrap_or(line))
		.collect()
}

fn expand_tabs(line: &str) -> Str {
	if !line.contains('\t') {
		return Str::new(line);
	}
	let mut out = StrMut::with_capacity(line.len().saturating_add(8));
	for part in line.split_inclusive('\t') {
		if let Some(text) = part.strip_suffix('\t') {
			out.push_str(text);
			out.push_str("   ");
		} else {
			out.push_str(part);
		}
	}
	out.freeze()
}

const fn decimal_width(mut value: usize) -> usize {
	let mut width = 1;
	while value >= 10 {
		value /= 10;
		width += 1;
	}
	width
}

fn gutter_label(number: usize, width: u16) -> Str {
	let mut out = StrMut::with_capacity(usize::from(width));
	for _ in decimal_width(number)..usize::from(width) {
		out.push(' ');
	}
	write!(out, "{number}").expect("writing a line number to memory cannot fail");
	out.freeze()
}

fn cell_width(text: &str) -> u16 {
	u16::try_from(text.visible_width()).unwrap_or(u16::MAX)
}

const fn make_row(kind: DiffRowKind, old: Option<DiffSide>, new: Option<DiffSide>) -> DiffRow {
	DiffRow { kind, old, new }
}

fn side(
	index: usize,
	lines: &[Str],
	styles: Option<&[Box<[DiffStyleRun]>]>,
	gutter: u16,
) -> DiffSide {
	let text = lines[index].clone();
	DiffSide {
		number: (index + 1) as u32,
		width: cell_width(&text),
		gutter: gutter_label(index + 1, gutter),
		styles: styles
			.and_then(|lines| lines.get(index))
			.cloned()
			.unwrap_or_default(),
		text,
		marks: Box::default(),
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WordClass {
	Space,
	Word,
	Punctuation,
}

struct WordToken<'a> {
	text:  &'a str,
	start: u16,
	end:   u16,
}

fn word_tokens(text: &str) -> Vec<WordToken<'_>> {
	let mut tokens = Vec::new();
	let mut iter = text.char_indices().peekable();
	let mut column = 0u16;
	while let Some((start, character)) = iter.next() {
		let start_col = column;
		let character_width = u16::try_from(width_char(character)).unwrap_or(u16::MAX);
		column = column.saturating_add(character_width);
		let class = if character.is_whitespace() {
			WordClass::Space
		} else if character.is_alphanumeric() || character == '_' {
			WordClass::Word
		} else {
			WordClass::Punctuation
		};
		let mut end = start + character.len_utf8();
		if character_width <= 1 {
			while let Some(&(offset, next)) = iter.peek() {
				let next_width = u16::try_from(width_char(next)).unwrap_or(u16::MAX);
				let next_class = if next.is_whitespace() {
					WordClass::Space
				} else if next.is_alphanumeric() || next == '_' {
					WordClass::Word
				} else {
					WordClass::Punctuation
				};
				if next_width > 1 || next_class != class {
					break;
				}
				iter.next();
				end = offset + next.len_utf8();
				column = column.saturating_add(next_width);
			}
		}
		tokens.push(WordToken { text: &text[start..end], start: start_col, end: column });
	}
	tokens
}

fn intraline_marks(old: &str, new: &str) -> (Box<[DiffMark]>, Box<[DiffMark]>) {
	let old_tokens = word_tokens(old);
	let new_tokens = word_tokens(new);
	let old_basis: Vec<&str> = old_tokens.iter().map(|token| token.text).collect();
	let new_basis: Vec<&str> = new_tokens.iter().map(|token| token.text).collect();
	let mut old_ranges: SmallVec<DiffMark, 4> = SmallVec::new();
	let mut new_ranges: SmallVec<DiffMark, 4> = SmallVec::new();
	for operation in capture_diff_slices(Algorithm::Myers, &old_basis, &new_basis) {
		match operation {
			DiffOp::Equal { .. } => {},
			DiffOp::Delete { old_index, old_len, .. } => {
				push_token_range(&mut old_ranges, &old_tokens, old_index, old_len);
			},
			DiffOp::Insert { new_index, new_len, .. } => {
				push_token_range(&mut new_ranges, &new_tokens, new_index, new_len);
			},
			DiffOp::Replace { old_index, old_len, new_index, new_len } => {
				push_token_range(&mut old_ranges, &old_tokens, old_index, old_len);
				push_token_range(&mut new_ranges, &new_tokens, new_index, new_len);
			},
		}
	}
	(old_ranges.into_vec().into_boxed_slice(), new_ranges.into_vec().into_boxed_slice())
}

fn push_token_range(
	ranges: &mut SmallVec<DiffMark, 4>,
	tokens: &[WordToken<'_>],
	start: usize,
	len: usize,
) {
	let Some(first) = tokens.get(start) else {
		return;
	};
	let end = tokens[start..start.saturating_add(len)]
		.last()
		.map_or(first.end, |token| token.end);
	if let Some(last) = ranges.last_mut()
		&& first.start <= last.end
	{
		last.end = last.end.max(end);
	} else if end > first.start {
		ranges.push(first.start..end);
	}
}

#[derive(Clone, Copy)]
enum ImportLanguage {
	TypeScript,
	Rust,
	Go,
}

fn import_language(language: Option<&str>) -> Option<ImportLanguage> {
	let language = language?;
	if ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "typescript", "javascript"]
		.iter()
		.any(|candidate| language.eq_ignore_ascii_case(candidate))
	{
		Some(ImportLanguage::TypeScript)
	} else if language.eq_ignore_ascii_case("rs") || language.eq_ignore_ascii_case("rust") {
		Some(ImportLanguage::Rust)
	} else if language.eq_ignore_ascii_case("go") {
		Some(ImportLanguage::Go)
	} else {
		None
	}
}

fn starts_word(line: &str, word: &str) -> bool {
	line.strip_prefix(word).is_some_and(|rest| {
		rest
			.chars()
			.next()
			.is_none_or(|character| !character.is_alphanumeric() && !matches!(character, '_' | '$'))
	})
}

fn import_starter(language: ImportLanguage, line: &str) -> bool {
	match language {
		ImportLanguage::TypeScript => {
			starts_word(line, "import")
				|| (starts_word(line, "export")
					&& line.contains("from")
					&& (line.contains('"') || line.contains('\'')))
		},
		ImportLanguage::Rust => {
			starts_word(line, "use")
				|| line
					.strip_prefix("pub")
					.and_then(|rest| rest.find("use").map(|at| &rest[at..]))
					.is_some_and(|rest| starts_word(rest, "use"))
				|| line.starts_with("extern crate ")
		},
		ImportLanguage::Go => starts_word(line, "import"),
	}
}

fn import_continuation(language: ImportLanguage, line: &str) -> bool {
	match language {
		ImportLanguage::TypeScript => {
			(line.starts_with('}') && line.contains("from"))
				|| line.trim_start_matches("type ").chars().all(|character| {
					character.is_alphanumeric() || matches!(character, '_' | '$' | ',' | ' ' | '\t')
				})
		},
		ImportLanguage::Rust => line.chars().all(|character| {
			character.is_alphanumeric()
				|| matches!(character, '_' | ':' | '*' | '{' | '}' | ',' | ';' | ' ' | '\t')
		}),
		ImportLanguage::Go => {
			matches!(line, "(" | ")")
				|| (line.contains('"')
					&& line.chars().all(|character| {
						character.is_alphanumeric()
							|| matches!(character, '_' | '.' | '"' | '/' | '-' | ' ' | '\t')
					}))
		},
	}
}

fn removable_import(language: ImportLanguage, line: &str) -> bool {
	match language {
		ImportLanguage::TypeScript => {
			((starts_word(line, "import") || starts_word(line, "export"))
				&& (line.contains('"') || line.contains('\'')))
				|| (line.starts_with('}') && line.contains("from"))
		},
		ImportLanguage::Rust => import_starter(language, line) && line.ends_with(';'),
		ImportLanguage::Go => import_starter(language, line) || line == ")" || line.contains('"'),
	}
}

fn stripped_block(rows: &[DiffRow], old: bool, remove: Option<ImportLanguage>) -> String {
	let mut stripped = String::new();
	for row in rows {
		let side = if old {
			row.old.as_ref()
		} else {
			row.new.as_ref()
		};
		let Some(side) = side else {
			continue;
		};
		let line = side.text.trim();
		if remove.is_some_and(|language| removable_import(language, line.as_str())) {
			continue;
		}
		stripped.extend(line.chars().filter(|character| !character.is_whitespace()));
	}
	stripped
}

fn importish_block(rows: &[DiffRow], old: bool, language: ImportLanguage, saw: &mut bool) -> bool {
	for row in rows {
		let side = if old {
			row.old.as_ref()
		} else {
			row.new.as_ref()
		};
		let Some(side) = side else {
			continue;
		};
		let line = side.text.trim();
		if line.is_empty() {
			continue;
		}
		if import_starter(language, line.as_str()) {
			*saw = true;
		} else if !import_continuation(language, line.as_str()) {
			return false;
		}
	}
	true
}

fn demote_formatting_blocks(rows: &mut [DiffRow], language: Option<&str>) {
	let language = import_language(language);
	let mut start = 0;
	while start < rows.len() {
		if rows[start].kind == DiffRowKind::Context {
			start += 1;
			continue;
		}
		let mut end = start + 1;
		while end < rows.len() && rows[end].kind != DiffRowKind::Context {
			end += 1;
		}
		let block = &rows[start..end];
		let whitespace_only = stripped_block(block, true, None) == stripped_block(block, false, None);
		let import_only = language.is_some_and(|language| {
			let mut saw = false;
			let importish = importish_block(block, true, language, &mut saw)
				&& importish_block(block, false, language, &mut saw);
			(importish && saw)
				|| stripped_block(block, true, Some(language))
					== stripped_block(block, false, Some(language))
		});
		if whitespace_only || import_only {
			for row in &mut rows[start..end] {
				row.kind = DiffRowKind::Context;
				if let Some(side) = &mut row.old {
					side.marks = Box::default();
				}
				if let Some(side) = &mut row.new {
					side.marks = Box::default();
				}
			}
		}
		start = end;
	}
}

fn build_hunks(rows: &[DiffRow]) -> Vec<DiffHunk> {
	let changes: Vec<usize> = rows
		.iter()
		.enumerate()
		.filter_map(|(index, row)| (row.kind != DiffRowKind::Context).then_some(index))
		.collect();
	if changes.is_empty() {
		return Vec::new();
	}
	let mut hunks = Vec::new();
	let mut group_start = changes[0];
	let mut group_end = changes[0];
	for &change in &changes[1..] {
		if change <= group_end.saturating_add(HUNK_CONTEXT * 2 + 1) {
			group_end = change;
		} else {
			hunks.push(make_hunk(rows, group_start, group_end));
			group_start = change;
			group_end = change;
		}
	}
	hunks.push(make_hunk(rows, group_start, group_end));
	hunks
}

fn make_hunk(rows: &[DiffRow], first_change: usize, last_change: usize) -> DiffHunk {
	let start = first_change.saturating_sub(HUNK_CONTEXT);
	let end = last_change.saturating_add(HUNK_CONTEXT + 1).min(rows.len());
	let old_before = rows[..start].iter().filter(|row| row.old.is_some()).count() as u32;
	let new_before = rows[..start].iter().filter(|row| row.new.is_some()).count() as u32;
	let old_count = rows[start..end]
		.iter()
		.filter(|row| row.old.is_some())
		.count() as u32;
	let new_count = rows[start..end]
		.iter()
		.filter(|row| row.new.is_some())
		.count() as u32;
	let old_start = old_before.saturating_add(u32::from(old_count > 0));
	let new_start = new_before.saturating_add(u32::from(new_count > 0));
	let mut header = StrMut::with_capacity(48);
	write!(header, "@@ -{old_start},{old_count} +{new_start},{new_count} @@")
		.expect("writing a hunk header to memory cannot fail");
	DiffHunk {
		header:    header.freeze(),
		old_range: (old_start, old_count),
		new_range: (new_start, new_count),
		rows:      start..end,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn options() -> DiffBuildOptions {
		DiffBuildOptions::default()
	}

	#[test]
	fn aligns_changes_and_one_sided_rows() {
		let doc = DiffDocument::build("a\nb\nc\n", "a\nB\nC\nd\n", "x.rs", &options());
		assert_eq!(doc.rows.iter().map(|row| row.kind).collect::<Vec<_>>(), [
			DiffRowKind::Context,
			DiffRowKind::Change,
			DiffRowKind::Change,
			DiffRowKind::Add,
		]);
		assert!(doc.rows[3].old.is_none());
		assert_eq!(doc.additions, 3);
		assert_eq!(doc.deletions, 2);
	}

	#[test]
	fn intraline_marks_use_display_columns() {
		let doc = DiffDocument::build("hello old world", "hello new world", "x.txt", &options());
		assert_eq!(doc.rows[0].old.as_ref().unwrap().marks.as_ref(), [6..9]);
		assert_eq!(doc.rows[0].new.as_ref().unwrap().marks.as_ref(), [6..9]);
	}

	#[test]
	fn tight_hunks_group_nearby_changes() {
		let old = (1..=20)
			.map(|n| n.to_string())
			.collect::<Vec<_>>()
			.join("\n");
		let mut new = (1..=20).map(|n| n.to_string()).collect::<Vec<_>>();
		new[4] = "five".into();
		new[16] = "seventeen".into();
		let doc = DiffDocument::build(&old, &new.join("\n"), "x.txt", &options());
		assert_eq!(doc.hunks.len(), 2);
		assert_eq!(doc.hunks[0].header, "@@ -2,7 +2,7 @@");
	}

	#[test]
	fn whitespace_ignore_preserves_raw_line_numbers() {
		let options =
			DiffBuildOptions { whitespace: DiffWhitespaceMode::Whitespace, language: None };
		let doc = DiffDocument::build(" a\nb", "a\n b", "x.txt", &options);
		assert!(doc.rows.iter().all(|row| row.kind == DiffRowKind::Context));
		assert_eq!(doc.rows[1].old.as_ref().unwrap().number, 2);
		assert_eq!(doc.rows[1].new.as_ref().unwrap().number, 2);
	}

	#[test]
	fn formatting_mode_demotes_reflow_but_preserves_real_changes() {
		let options =
			DiffBuildOptions { whitespace: DiffWhitespaceMode::Formatting, language: None };
		let reflow = DiffDocument::build("call(a, b);", "call(\n a,\n b\n);", "x.rs", &options);
		assert!(
			reflow
				.rows
				.iter()
				.all(|row| row.kind == DiffRowKind::Context)
		);
		assert!(reflow.hunks.is_empty());
		assert_eq!((reflow.additions, reflow.deletions), (0, 0));

		let changed = DiffDocument::build("call(a, b);", "call(a, c);", "x.rs", &options);
		assert!(
			changed
				.rows
				.iter()
				.any(|row| row.kind == DiffRowKind::Change)
		);
	}

	#[test]
	fn formatting_demotion_preserves_real_source_ranges_for_staging() {
		let options =
			DiffBuildOptions { whitespace: DiffWhitespaceMode::Formatting, language: None };
		let doc = DiffDocument::build(
			"call(a, b);\nmid\nvalue = 1;",
			"call(\n a,\n b\n);\nmid\nvalue = 2;",
			"x.rs",
			&options,
		);
		let changed = doc
			.rows
			.iter()
			.find(|row| row.kind == DiffRowKind::Change)
			.expect("real change remains");
		assert_eq!(changed.old.as_ref().map(|side| side.number), Some(3));
		assert_eq!(changed.new.as_ref().map(|side| side.number), Some(6));
		assert_eq!(doc.hunks.len(), 1);
		let hunk = &doc.hunks[0];
		assert!(hunk.old_range.0 <= 3 && 3 < hunk.old_range.0 + hunk.old_range.1);
		assert!(hunk.new_range.0 <= 6 && 6 < hunk.new_range.0 + hunk.new_range.1);
	}

	#[test]
	fn formatting_mode_demotes_language_import_changes() {
		let options =
			DiffBuildOptions { whitespace: DiffWhitespaceMode::Formatting, language: None };
		for (path, old, new) in [
			(
				"x.ts",
				"import { a } from \"a\";\nconst x = 1;",
				"import { b } from \"b\";\nconst x = 1;",
			),
			("x.rs", "use crate::a;\nfn main() {}", "use crate::b;\nfn main() {}"),
			("x.go", "import \"fmt\"\nfunc main() {}", "import \"os\"\nfunc main() {}"),
		] {
			let doc = DiffDocument::build(old, new, path, &options);
			assert!(
				doc.rows.iter().all(|row| row.kind == DiffRowKind::Context),
				"{path} imports should be demoted"
			);
		}
	}

	#[test]
	fn unicode_width_counts_terminal_cells() {
		let doc = DiffDocument::build("漢字", "漢語", "x.txt", &options());
		assert_eq!(doc.rows[0].old.as_ref().unwrap().width, 4);
		assert_eq!(doc.rows[0].new.as_ref().unwrap().marks.as_ref(), [2..4]);
	}
}
