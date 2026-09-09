//! Unified diff view with pi-parity presentation.
//!
//! Rows carry an optional source line number parsed once by
//! [`DiffLine::parse`], a fixed three-digit-minimum gutter so a streaming diff
//! never reflows rows it already painted, dim indentation glyphs, reverse-video
//! emphasis on the tokens that differ between a paired removed/added line, and
//! syntax highlighting for context rows when the `path` prop names a bundled
//! language.

use std::{fmt::Write as _, iter, ops::Range, path::Path};

use omp_core::{IntoStr, Str};
use similar::{Algorithm, DiffOp, capture_diff_slices};
use smallvec::SmallVec;

use super::{overflow_plan, paint_overflow_footer};
use crate::{
	Icon,
	component::{Component, PaintCtx, Slot, next_slot},
	components::text::paint_rich,
	context::UiContext,
	frame::{Rect, Style},
	markdown::highlight::{self, HighlightStyles},
	markup::Border,
	props::{Prop, PropValue, Props},
	rich::{Pipeline, Prefix, RichSink, RichText, width_config_epoch},
};

/// Display cells one tab occupies.
const TAB_WIDTH: usize = 3;
/// Cells rendered for one expanded tab.
const TAB_SPACES: &str = "   ";
/// Blank cells painted before the tab glyph inside a visualized indent.
const TAB_GLYPH_LEFT: usize = TAB_WIDTH / 2;
/// Blank cells painted after the tab glyph inside a visualized indent.
const TAB_GLYPH_RIGHT: usize = TAB_WIDTH - TAB_GLYPH_LEFT - 1;
/// Digits always reserved in the line-number gutter: a streaming diff whose
/// numbers cross 10 or 100 keeps every already-painted row byte-identical.
const MIN_GUTTER_DIGITS: usize = 3;

/// The type of a line in a diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
	/// A file header or metadata line.
	Header,
	/// An unchanged context line.
	Context,
	/// An added line.
	Add,
	/// A removed line.
	Remove,
	/// A revision-bound diagnostic attached to the diff.
	Diagnostic,
}

/// A single line in a diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
	/// The type of the diff line.
	pub kind:   DiffKind,
	/// Content after the marker and gutter. An empty header is a gap row
	/// standing in for elided source.
	pub text:   Str,
	/// Source line number carried by a canonical `+123|` or legacy `+123 `
	/// gutter, parsed once so painting never re-scans the row.
	pub number: Option<u32>,
}

impl DiffLine {
	/// Classifies one unified-diff source row.
	///
	/// `+`, `-`, and space markers may carry a canonical `123|` gutter or a
	/// legacy `123 ` one; `!` rows are diagnostics; hunk headers, file
	/// metadata, and any other unmarked row stay verbatim as headers, except
	/// blank or `...` rows, which become gap markers.
	pub fn parse(line: &str) -> Self {
		let kind = match line.as_bytes().first() {
			Some(b'+') if !line.starts_with("+++") => DiffKind::Add,
			Some(b'-') if !line.starts_with("---") => DiffKind::Remove,
			Some(b' ') => DiffKind::Context,
			Some(b'!') => {
				let text = line[1..].strip_prefix(' ').unwrap_or(&line[1..]);
				return Self { kind: DiffKind::Diagnostic, text: Str::new(text), number: None };
			},
			_ => {
				let text = match line.trim() {
					"" | "..." | "…" => Str::default(),
					_ => Str::new(line),
				};
				return Self { kind: DiffKind::Header, text, number: None };
			},
		};
		let (number, text) = split_gutter(&line[1..]);
		Self { kind, text: Str::new(text), number }
	}
}

/// Splits a canonical `123|content` or legacy `123 content` gutter off the
/// body of a marked row; rows without a leading number keep their body.
fn split_gutter(body: &str) -> (Option<u32>, &str) {
	let padded = body.trim_start_matches([' ', '\t']);
	let digits = padded.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 {
		return (None, body);
	}
	let Ok(number) = padded[..digits].parse::<u32>() else {
		return (None, body);
	};
	let rest = &padded[digits..];
	rest
		.strip_prefix(['|', '│'])
		.or_else(|| rest.strip_prefix([' ', '\t']))
		.map_or((None, body), |content| (Some(number), content))
}

/// A component that renders a diff with semantic styles.
pub struct DiffView {
	props:              Props,
	slot:               Slot,
	lines:              Vec<DiffLine>,
	rich:               RichText,
	dirty:              bool,
	cached_width:       u16,
	cached_width_epoch: u64,
	cached_revision:    u64,
	cached_context:     Option<u16>,
	cached_colorblind:  bool,
	colorblind:         bool,
}

impl DiffView {
	/// Creates a new empty diff view.
	pub fn new() -> Self {
		Self {
			props:              Props::new(),
			slot:               next_slot(),
			lines:              Vec::new(),
			rich:               RichText::default(),
			dirty:              false,
			cached_width:       0,
			cached_width_epoch: 0,
			cached_revision:    0,
			cached_context:     None,
			cached_colorblind:  false,
			colorblind:         false,
		}
	}

	/// Sets one diff property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends unified-diff source text, one parsed row per line.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		let text = text.into_str();
		self.extend(text.lines().map(DiffLine::parse));
		self
	}

	/// Enables a blue/amber palette in addition to semantic +/- glyphs.
	pub const fn set_colorblind(&mut self, colorblind: bool) {
		self.colorblind = colorblind;
	}

	/// Appends a new unnumbered line to the diff view.
	pub fn push(&mut self, kind: DiffKind, text: impl IntoStr) {
		self
			.lines
			.push(DiffLine { kind, text: text.into_str(), number: None });
		self.dirty = true;
	}

	/// Clears all lines from the diff view.
	///
	/// Returns whether the view contained any lines before clearing.
	pub fn clear(&mut self) -> bool {
		if self.lines.is_empty() {
			return false;
		}
		self.lines.clear();
		self.dirty = true;
		true
	}

	/// Appends multiple lines to the diff view.
	///
	/// Returns whether any lines were added.
	pub fn extend(&mut self, lines: impl IntoIterator<Item = DiffLine>) -> bool {
		let start = self.lines.len();
		self.lines.extend(lines);
		let added = self.lines.len() > start;
		self.dirty |= added;
		added
	}

	/// Replaces all lines in the diff view.
	pub fn replace(&mut self, lines: Vec<DiffLine>) {
		self.lines = lines;
		self.dirty = true;
	}

	fn render(&mut self, ctx: &UiContext, width: u16) {
		let width = width.max(1);
		let width_epoch = width_config_epoch();
		let context = self.props.context();
		if !self.dirty
			&& self.cached_width == width
			&& self.cached_width_epoch == width_epoch
			&& self.cached_revision == ctx.revision
			&& self.cached_context == context
			&& self.cached_colorblind == self.colorblind
		{
			return;
		}
		self.dirty = false;
		self.cached_width = width;
		self.cached_width_epoch = width_epoch;
		self.cached_revision = ctx.revision;
		self.cached_context = context;
		self.cached_colorblind = self.colorblind;
		self.rich.clear();

		let language = self
			.props
			.path()
			.and_then(|path| language_for_path(path))
			.filter(|language| highlight::supports_language(language));
		let mut painter = Painter::new(ctx, width, self.colorblind, &self.lines, language);
		painter.paint_all(&self.lines, context, &mut self.rich);
	}
}

/// Rows the `context` prop keeps, drops, or collapses into a summary.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Elision {
	Show,
	Omit,
	Summary(usize),
}

/// Plans which context rows survive when only `count` unchanged lines are
/// kept beside each change; every other run collapses into one summary row.
fn elision_plan(lines: &[DiffLine], count: usize) -> Vec<Elision> {
	let mut plan = vec![Elision::Show; lines.len()];
	let mut index = 0;
	while index < lines.len() {
		if lines[index].kind != DiffKind::Context {
			index += 1;
			continue;
		}
		let end = lines[index..]
			.iter()
			.position(|line| line.kind != DiffKind::Context)
			.map_or(lines.len(), |offset| index + offset);
		let changed_before =
			index > 0 && matches!(lines[index - 1].kind, DiffKind::Add | DiffKind::Remove);
		let changed_after =
			end < lines.len() && matches!(lines[end].kind, DiffKind::Add | DiffKind::Remove);
		let first_omitted = index + usize::from(changed_before) * count;
		let last_omitted = end.saturating_sub(usize::from(changed_after) * count);
		if first_omitted < last_omitted {
			plan[first_omitted] = Elision::Summary(last_omitted - first_omitted);
			plan[first_omitted + 1..last_omitted].fill(Elision::Omit);
		}
		index = end;
	}
	plan
}

/// Semantic row styles resolved once per render.
#[derive(Clone, Copy)]
struct Palette {
	header:     Style,
	context:    Style,
	add:        Style,
	remove:     Style,
	diagnostic: Style,
	summary:    Style,
}

struct Continuation {
	numbered: Prefix,
	bare:     Prefix,
}

impl Continuation {
	fn new(style: Style, gutter: usize) -> Self {
		const SPACES: &str = "            ";
		let mut numbered = Prefix::default();
		numbered.push(style, &SPACES[..gutter + 2]);
		let mut bare = Prefix::default();
		bare.push(style, " ");
		Self { numbered, bare }
	}

	const fn for_row(&self, numbered: bool) -> &Prefix {
		if numbered { &self.numbered } else { &self.bare }
	}
}

/// Syntax-highlighted context rows, one [`RichText`] row per source line.
struct Highlights {
	rows:   RichText,
	/// Highlighted row for each diff line, `u16::MAX` when unhighlighted.
	row_of: Vec<u16>,
}

/// Paints parsed rows into a [`RichText`].
struct Painter {
	width:           u16,
	gutter:          usize,
	bar:             char,
	palette:         Palette,
	tab_glyph:       &'static str,
	space_glyph:     &'static str,
	gap_glyph:       &'static str,
	prev_number:     Option<u32>,
	scratch:         String,
	add_cont:        Continuation,
	remove_cont:     Continuation,
	context_cont:    Continuation,
	header_cont:     Continuation,
	diagnostic_cont: Continuation,
	summary_cont:    Continuation,
	highlights:      Option<Highlights>,
}

impl Painter {
	fn new(
		ctx: &UiContext,
		width: u16,
		colorblind: bool,
		lines: &[DiffLine],
		language: Option<&str>,
	) -> Self {
		let theme = &ctx.theme;
		let (add, remove) = if colorblind {
			(theme.secondary, theme.accent)
		} else {
			(theme.tool_diff_added, theme.tool_diff_removed)
		};
		let palette = Palette {
			header:     Style::new().fg(theme.tool_diff_context),
			context:    Style::new().fg(theme.tool_diff_context),
			add:        Style::new().fg(add),
			remove:     Style::new().fg(remove),
			diagnostic: Style::new().fg(theme.warn),
			summary:    Style::new().fg(theme.tool_diff_context).italic(),
		};
		let gutter = lines
			.iter()
			.filter_map(|line| line.number)
			.map(decimal_width)
			.max()
			.unwrap_or(0)
			.max(MIN_GUTTER_DIGITS);
		let scratch = String::new();
		let add_cont = Continuation::new(palette.add, gutter);
		let remove_cont = Continuation::new(palette.remove, gutter);
		let context_cont = Continuation::new(palette.context, gutter);
		let header_cont = Continuation::new(palette.header, gutter);
		let diagnostic_cont = Continuation::new(palette.diagnostic, gutter);
		let summary_cont = Continuation::new(palette.summary, gutter);
		let highlights = language
			.map(|language| highlight_context(lines, language, &HighlightStyles::from_theme(theme)));
		Self {
			width,
			gutter,
			bar: ctx.charset.border(Border::Square).5,
			palette,
			tab_glyph: ctx.charset.icon(Icon::DiffIndentTab),
			space_glyph: ctx.charset.icon(Icon::DiffIndentSpace),
			gap_glyph: ctx.charset.icon(Icon::DiffGap),
			prev_number: None,
			scratch,
			add_cont,
			remove_cont,
			context_cont,
			header_cont,
			diagnostic_cont,
			summary_cont,
			highlights,
		}
	}

	fn paint_all(&mut self, lines: &[DiffLine], context: Option<u16>, out: &mut RichText) {
		let plan = context.map(|count| elision_plan(lines, usize::from(count)));
		let mut index = 0;
		while index < lines.len() {
			match plan.as_ref().map_or(Elision::Show, |plan| plan[index]) {
				Elision::Omit => {
					index += 1;
					continue;
				},
				Elision::Summary(omitted) => {
					self.paint_summary(omitted, out);
					index += 1;
					continue;
				},
				Elision::Show => {},
			}
			let line = &lines[index];
			match line.kind {
				DiffKind::Remove => {
					let removed_start = index;
					while index < lines.len() && lines[index].kind == DiffKind::Remove {
						index += 1;
					}
					let added_start = index;
					while index < lines.len() && lines[index].kind == DiffKind::Add {
						index += 1;
					}
					let removed = &lines[removed_start..added_start];
					let added = &lines[added_start..index];
					let (remove, add) = (self.palette.remove, self.palette.add);
					if let ([old], [new]) = (removed, added) {
						let (old_marks, new_marks) = word_marks(&old.text, &new.text);
						self.paint_change(old, remove, '-', &old_marks, true, out);
						self.paint_change(new, add, '+', &new_marks, true, out);
					} else {
						for line in removed {
							self.paint_change(line, remove, '-', &[], false, out);
						}
						for line in added {
							self.paint_change(line, add, '+', &[], false, out);
						}
					}
					continue;
				},
				DiffKind::Add => self.paint_change(line, self.palette.add, '+', &[], false, out),
				DiffKind::Context => self.paint_context(line, index, out),
				DiffKind::Header => self.paint_header(line, out),
				DiffKind::Diagnostic => self.paint_diagnostic(line, out),
			}
			index += 1;
		}
	}

	/// Fills `scratch` with a gutter (`-88│`, `  88│`, or a blanked repeat),
	/// returning whether the row carries a number.
	fn gutter(&mut self, marker: char, number: Option<u32>) -> bool {
		self.scratch.clear();
		let Some(number) = number else {
			self.prev_number = None;
			if marker != '\0' {
				self.scratch.push(marker);
			}
			return false;
		};
		let shown = (self.prev_number != Some(number)).then_some(number);
		self.prev_number = Some(number);
		let label = usize::from(marker != ' ') + shown.map_or(0, decimal_width);
		self
			.scratch
			.extend(iter::repeat_n(' ', (self.gutter + 1).saturating_sub(label)));
		if marker != ' ' {
			self.scratch.push(marker);
		}
		if let Some(number) = shown {
			let _ = write!(self.scratch, "{number}");
		}
		self.scratch.push(self.bar);
		true
	}

	/// Paints one added or removed row. With `expand_tabs`, tabs become spaces
	/// before indentation is visualized, so a
	/// leading tab reads as three dots instead of an arrow.
	fn paint_change(
		&mut self,
		line: &DiffLine,
		style: Style,
		marker: char,
		marks: &[Range<usize>],
		expand_tabs: bool,
		out: &mut RichText,
	) {
		let numbered = self.gutter(marker, line.number);
		let continuation = if style == self.palette.add {
			self.add_cont.for_row(numbered)
		} else {
			self.remove_cont.for_row(numbered)
		};
		let mut wrap = out.wrap_chars_prefixed(self.width, Prefix::empty_ref(), continuation);
		wrap.run(style, &self.scratch);
		let content = line.text.as_str();
		let indent = indent_len(content);
		self.paint_indent(&mut wrap, style.dim(), &content[..indent], expand_tabs);
		paint_marked(&mut wrap, style, content, indent, marks);
		wrap.newline();
	}

	fn paint_context(&mut self, line: &DiffLine, index: usize, out: &mut RichText) {
		let numbered = self.gutter(' ', line.number);
		let style = self.palette.context;
		let continuation = self.context_cont.for_row(numbered);
		let mut wrap = out.wrap_chars_prefixed(self.width, Prefix::empty_ref(), continuation);
		wrap.run(style, &self.scratch);
		let content = line.text.as_str();
		if let Some((rows, row)) = self.highlight_row(index) {
			for (run_style, text) in rows.row_runs(row) {
				paint_plain(&mut wrap, run_style, text);
			}
		} else {
			let indent = indent_len(content);
			self.paint_indent(&mut wrap, style.dim(), &content[..indent], false);
			paint_plain(&mut wrap, style, &content[indent..]);
		}
		wrap.newline();
	}

	fn highlight_row(&self, index: usize) -> Option<(&RichText, u16)> {
		let highlights = self.highlights.as_ref()?;
		let row = *highlights.row_of.get(index)?;
		(row != u16::MAX).then_some((&highlights.rows, row))
	}

	fn paint_header(&mut self, line: &DiffLine, out: &mut RichText) {
		self.prev_number = None;
		let style = self.palette.header;
		let mut wrap =
			out.wrap_chars_prefixed(self.width, Prefix::empty_ref(), self.header_cont.for_row(false));
		if line.text.is_empty() {
			wrap.run(style, self.gap_glyph);
		} else {
			paint_plain(&mut wrap, style, line.text.as_str());
		}
		wrap.newline();
	}

	fn paint_diagnostic(&mut self, line: &DiffLine, out: &mut RichText) {
		self.prev_number = None;
		let style = self.palette.diagnostic;
		let mut wrap = out.wrap_chars_prefixed(
			self.width,
			Prefix::empty_ref(),
			self.diagnostic_cont.for_row(false),
		);
		for (index, physical) in line.text.as_str().split('\n').enumerate() {
			if index > 0 {
				wrap.newline();
			}
			wrap.run(style.bold(), if index == 0 { "! " } else { "  " });
			paint_plain(&mut wrap, style, physical);
		}
		wrap.newline();
	}

	fn paint_summary(&mut self, omitted: usize, out: &mut RichText) {
		self.prev_number = None;
		self.scratch.clear();
		let gap = self.gap_glyph;
		let _ = write!(self.scratch, "{gap} {omitted} unchanged lines {gap}");
		let mut wrap =
			out.wrap_chars_prefixed(self.width, Prefix::empty_ref(), self.summary_cont.for_row(false));
		wrap.run(self.palette.summary, &self.scratch);
		wrap.newline();
	}

	/// Leading tabs paint as a centered arrow and leading spaces as dots, both
	/// dim in the row color.
	fn paint_indent(&self, sink: &mut dyn RichSink, style: Style, indent: &str, expand_tabs: bool) {
		for ch in indent.chars() {
			if ch != '\t' {
				sink.run(style, self.space_glyph);
			} else if expand_tabs {
				for _ in 0..TAB_WIDTH {
					sink.run(style, self.space_glyph);
				}
			} else {
				sink.run(style, &TAB_SPACES[..TAB_GLYPH_LEFT]);
				sink.run(style, self.tab_glyph);
				sink.run(style, &TAB_SPACES[..TAB_GLYPH_RIGHT]);
			}
		}
	}
}

fn decimal_width(number: u32) -> usize {
	number
		.checked_ilog10()
		.map_or(1, |magnitude| magnitude as usize + 1)
}

/// Bytes of leading spaces and tabs.
fn indent_len(text: &str) -> usize {
	text.len() - text.trim_start_matches([' ', '\t']).len()
}

/// Language token for syntax highlighting: the extension, or the bare file
/// name for extensionless files such as `Makefile`.
fn language_for_path(path: &str) -> Option<&str> {
	let path = Path::new(path);
	path
		.extension()
		.or_else(|| path.file_name())
		.and_then(|name| name.to_str())
}

/// Highlights runs of consecutive context rows together so multi-line
/// constructs tokenize with their neighbours. Collapse markers (`...`) are
/// not code and split runs instead of joining them.
fn highlight_context(lines: &[DiffLine], language: &str, styles: &HighlightStyles) -> Highlights {
	let mut highlights =
		Highlights { rows: RichText::default(), row_of: vec![u16::MAX; lines.len()] };
	let mut source = String::new();
	let mut run: SmallVec<usize, 16> = SmallVec::new();
	for (index, line) in lines.iter().enumerate() {
		let collapse = matches!(line.text.as_str(), "..." | "…");
		if line.kind == DiffKind::Context && !collapse {
			if !run.is_empty() {
				source.push('\n');
			}
			source.push_str(line.text.as_str());
			run.push(index);
		} else {
			flush_highlight_run(&mut highlights, &mut source, &mut run, language, styles);
		}
	}
	flush_highlight_run(&mut highlights, &mut source, &mut run, language, styles);
	highlights
}

fn flush_highlight_run(
	highlights: &mut Highlights,
	source: &mut String,
	run: &mut SmallVec<usize, 16>,
	language: &str,
	styles: &HighlightStyles,
) {
	if run.is_empty() {
		return;
	}
	let first = RichText::rows(&highlights.rows);
	highlight::render(source, language, run.len(), styles, &mut highlights.rows);
	for (offset, &index) in run.iter().enumerate() {
		highlights.row_of[index] = first.saturating_add(u16::try_from(offset).unwrap_or(u16::MAX));
	}
	source.clear();
	run.clear();
}

/// Emits `text` with tabs expanded to [`TAB_WIDTH`] cells.
fn paint_plain(sink: &mut dyn RichSink, style: Style, text: &str) {
	for piece in text.split_inclusive('\t') {
		match piece.strip_suffix('\t') {
			Some(head) => {
				sink.run(style, head);
				sink.run(style, TAB_SPACES);
			},
			None => sink.run(style, piece),
		}
	}
}

/// Emits `text[start..]` in the semantic line style, reversing only changed
/// token ranges. Leading indentation remains uninverted.
fn paint_marked(
	sink: &mut dyn RichSink,
	style: Style,
	text: &str,
	start: usize,
	marks: &[Range<usize>],
) {
	let mut cursor = start;
	for mark in marks {
		let mark_start = mark.start.max(start);
		let mark_end = mark.end.max(mark_start).min(text.len());
		if mark_start > cursor {
			paint_plain(sink, style, &text[cursor..mark_start]);
		}
		if mark_end > mark_start {
			paint_plain(sink, style.reverse(), &text[mark_start..mark_end]);
		}
		cursor = cursor.max(mark_end);
	}
	if cursor < text.len() {
		paint_plain(sink, style, &text[cursor..]);
	}
}

type Marks = SmallVec<Range<usize>, 4>;

#[derive(Clone, Copy, Eq, PartialEq)]
enum TokenClass {
	Word,
	Space,
	Other,
}

struct Token<'a> {
	text:  &'a str,
	start: usize,
	class: TokenClass,
}

/// jsdiff's `extendedWordChars`: ASCII alphanumerics, `_`, and Latin letters
/// through Latin Extended Additional. Everything else diffs one code point at
/// a time.
const fn is_word_char(ch: char) -> bool {
	matches!(
		ch as u32,
		0x30..=0x39
			| 0x41..=0x5A
			| 0x5F
			| 0x61..=0x7A
			| 0xAD
			| 0xC0..=0xD6
			| 0xD8..=0xF6
			| 0xF8..=0x2C6
			| 0x2C8..=0x2D7
			| 0x2DE..=0x2FF
			| 0x1E00..=0x1EFF
	)
}

const fn token_class(ch: char) -> TokenClass {
	if is_word_char(ch) {
		TokenClass::Word
	} else if ch.is_whitespace() {
		TokenClass::Space
	} else {
		TokenClass::Other
	}
}

/// jsdiff `diffWords` tokenization: word runs, whitespace runs, and every
/// other code point on its own.
fn tokenize(text: &str) -> Vec<Token<'_>> {
	let mut tokens = Vec::new();
	let mut chars = text.char_indices().peekable();
	while let Some((start, ch)) = chars.next() {
		let class = token_class(ch);
		let mut end = start + ch.len_utf8();
		if class != TokenClass::Other {
			while let Some(&(offset, next)) = chars.peek() {
				if token_class(next) != class {
					break;
				}
				end = offset + next.len_utf8();
				chars.next();
			}
		}
		tokens.push(Token { text: &text[start..end], start, class });
	}
	tokens
}

/// Byte ranges to paint in reverse video on each side of a paired change.
/// Words compare exactly and whitespace never counts as a change.
fn word_marks(old: &str, new: &str) -> (Marks, Marks) {
	let old_tokens = tokenize(old);
	let new_tokens = tokenize(new);
	let old_words = words(&old_tokens);
	let new_words = words(&new_tokens);
	let mut old_changed = vec![false; old_words.len()];
	let mut new_changed = vec![false; new_words.len()];
	for operation in capture_diff_slices(Algorithm::Myers, &old_words, &new_words) {
		match operation {
			DiffOp::Equal { .. } => {},
			DiffOp::Delete { old_index, old_len, .. } => {
				old_changed[old_index..old_index + old_len].fill(true);
			},
			DiffOp::Insert { new_index, new_len, .. } => {
				new_changed[new_index..new_index + new_len].fill(true);
			},
			DiffOp::Replace { old_index, old_len, new_index, new_len } => {
				old_changed[old_index..old_index + old_len].fill(true);
				new_changed[new_index..new_index + new_len].fill(true);
			},
		}
	}
	(marks(&old_tokens, &old_changed), marks(&new_tokens, &new_changed))
}

fn words<'t>(tokens: &[Token<'t>]) -> Vec<&'t str> {
	tokens
		.iter()
		.filter(|token| token.class != TokenClass::Space)
		.map(|token| token.text)
		.collect()
}

/// Merges changed words into inverse ranges. Whitespace joins a range only
/// between two changed words or after a changed final word, so leading
/// indentation and the gap beside kept text stay plain.
fn marks(tokens: &[Token<'_>], changed: &[bool]) -> Marks {
	let mut marks = Marks::new();
	let mut word = 0;
	let mut pending_space: Option<Range<usize>> = None;
	for token in tokens {
		let end = token.start + token.text.len();
		if token.class == TokenClass::Space {
			if word > 0 && changed[word - 1] {
				pending_space = Some(token.start..end);
			}
			continue;
		}
		let is_changed = changed[word];
		word += 1;
		if is_changed {
			let start = pending_space
				.take()
				.map_or(token.start, |space| space.start);
			push_mark(&mut marks, start..end);
		} else {
			pending_space = None;
		}
	}
	if let Some(space) = pending_space {
		push_mark(&mut marks, space);
	}
	marks
}

fn push_mark(marks: &mut Marks, range: Range<usize>) {
	match marks.last_mut() {
		Some(last) if last.end == range.start => last.end = range.end,
		_ => marks.push(range),
	}
}

impl Default for DiffView {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for DiffView {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(1, u16::MAX) // DiffView flows to any width
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.render(ctx, width);
		let natural = RichText::rows(&self.rich);
		self
			.props
			.max_rows()
			.map_or(natural, |max| natural.min(max))
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.render(pc.ctx, rect.width);
		let natural = RichText::rows(&self.rich);
		let plan = overflow_plan(&self.props, natural, rect.height);
		let content_rows = plan.map_or(rect.height, |plan| plan.content_rows);
		paint_rich(
			pc,
			Rect::new(rect.x, rect.y, rect.width, content_rows),
			&self.rich,
			self.props.align(),
		);
		if let Some(plan) = plan {
			paint_overflow_footer(pc, rect, plan);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		UiContext,
		component::{Component, PaintCtx},
		frame::{Frame, Rect, Size},
		test_support::{frame_cell_style, frame_row_text},
	};

	fn paint(component: &mut dyn Component, width: u16, height: u16) -> Frame {
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		component.paint(&mut pc, Rect::new(0, 0, width, height));
		frame
	}

	fn view(text: &str) -> DiffView {
		DiffView::new().text(text)
	}

	fn line(kind: DiffKind, text: &str, number: Option<u32>) -> DiffLine {
		DiffLine { kind, text: Str::new(text), number }
	}

	/// Cell column of the first occurrence of `needle` in row `y`.
	fn column(frame: &Frame, y: u16, needle: &str) -> u16 {
		let row = frame_row_text(frame, y);
		let at = row
			.find(needle)
			.unwrap_or_else(|| panic!("{needle:?} in {row:?}"));
		u16::try_from(row[..at].chars().count()).unwrap()
	}

	#[test]
	fn canonical_and_legacy_diff_lines_parse_line_numbers() {
		assert_eq!(DiffLine::parse("+123|content"), line(DiffKind::Add, "content", Some(123)));
		assert_eq!(DiffLine::parse("-  7|x"), line(DiffKind::Remove, "x", Some(7)));
		assert_eq!(
			DiffLine::parse(" 12|\tindented"),
			line(DiffKind::Context, "\tindented", Some(12))
		);
		assert_eq!(
			DiffLine::parse("- 4│old_name();"),
			line(DiffKind::Remove, "old_name();", Some(4))
		);
		assert_eq!(DiffLine::parse("+123 content"), line(DiffKind::Add, "content", Some(123)));
		assert_eq!(DiffLine::parse("+content"), line(DiffKind::Add, "content", None));
		assert_eq!(
			DiffLine::parse("-\tconst limit = 1;"),
			line(DiffKind::Remove, "\tconst limit = 1;", None)
		);
		assert_eq!(DiffLine::parse(" "), line(DiffKind::Context, "", None));
		assert_eq!(DiffLine::parse("+"), line(DiffKind::Add, "", None));
		assert_eq!(
			DiffLine::parse("@@ -1,2 +1,3 @@"),
			line(DiffKind::Header, "@@ -1,2 +1,3 @@", None)
		);
		assert_eq!(DiffLine::parse("+++ b/file"), line(DiffKind::Header, "+++ b/file", None));
		assert_eq!(DiffLine::parse(""), line(DiffKind::Header, "", None));
		assert_eq!(DiffLine::parse("..."), line(DiffKind::Header, "", None));
		assert_eq!(DiffLine::parse("…"), line(DiffKind::Header, "", None));
		assert_eq!(
			DiffLine::parse("! rustc: unused"),
			line(DiffKind::Diagnostic, "rustc: unused", None)
		);
	}

	#[test]
	fn gutter_reserves_three_digits_and_never_reflows_while_streaming() {
		let ctx = UiContext::default();
		let mut diff = view("+9|nine");
		let first = paint(&mut diff, 20, 4);
		assert_eq!(frame_row_text(&first, 0), "  +9│nine");

		diff.extend([DiffLine::parse("+10|ten"), DiffLine::parse("+100|hundred")]);
		let grown = paint(&mut diff, 20, 4);
		assert_eq!(frame_row_text(&grown, 0), "  +9│nine");
		assert_eq!(frame_row_text(&grown, 1), " +10│ten");
		assert_eq!(frame_row_text(&grown, 2), "+100│hundred");
		let gutter = frame_cell_style(&grown, 3, 0);
		assert!(!gutter.dim, "indentation glyphs, not the gutter, are dim");
		assert_eq!(
			gutter.foreground, ctx.theme.tool_diff_added,
			"gutter uses the semantic added-line color"
		);
		assert!(!frame_cell_style(&grown, 5, 0).dim, "content is not dim");

		let mut pair = view("-5|old\n+5|new\n 6|same\n@@ -9 +9 @@\n 9|far\n+9|inserted");
		let frame = paint(&mut pair, 20, 6);
		assert_eq!(frame_row_text(&frame, 0), "  -5│old");
		assert_eq!(frame_row_text(&frame, 1), "   +│new", "a repeated number is blanked");
		assert_eq!(frame_row_text(&frame, 2), "   6│same");
		assert_eq!(frame_row_text(&frame, 3), "@@ -9 +9 @@", "unparsed rows carry no gutter");
		assert_eq!(frame_row_text(&frame, 4), "   9│far", "a header resets the repeat check");
		assert_eq!(frame_row_text(&frame, 5), "   +│inserted");

		let mut bare = view("-\told\n+\tnew\n same");
		let frame = paint(&mut bare, 20, 3);
		assert_eq!(frame_row_text(&frame, 0), "-···old");
		assert_eq!(frame_row_text(&frame, 1), "+···new");
		assert_eq!(frame_row_text(&frame, 2), " same", "unnumbered rows keep their bare marker");
	}

	#[test]
	fn word_diff_inverse_highlights_changed_tokens_not_leading_whitespace() {
		let mut diff =
			view("-\tconst limit = args.limit ?? 2000;\n+\tconst limit = args.limit ?? 4000;");
		let frame = paint(&mut diff, 60, 2);
		assert_eq!(frame_row_text(&frame, 0), "-···const limit = args.limit ?? 2000;");
		assert_eq!(frame_row_text(&frame, 1), "+···const limit = args.limit ?? 4000;");
		let old = column(&frame, 0, "2000");
		for x in old..old + 4 {
			assert!(frame_cell_style(&frame, x, 0).reverse, "removed token at {x} is inverse");
		}
		assert!(!frame_cell_style(&frame, old - 1, 0).reverse, "gap before the token stays plain");
		assert!(!frame_cell_style(&frame, old + 4, 0).reverse, "kept `;` stays plain");
		assert!(!frame_cell_style(&frame, 1, 0).reverse, "indent glyphs are never inverse");
		assert!(!frame_cell_style(&frame, 4, 0).reverse, "kept `const` stays plain");
		let new = column(&frame, 1, "4000");
		for x in new..new + 4 {
			assert!(frame_cell_style(&frame, x, 1).reverse, "added token at {x} is inverse");
		}
		let ctx = UiContext::default();
		assert_eq!(frame_cell_style(&frame, new, 1).foreground, ctx.theme.ok);
		assert_eq!(frame_cell_style(&frame, old, 0).foreground, ctx.theme.err);

		let mut whole = view("-\tfoo bar\n+\tbaz qux");
		let frame = paint(&mut whole, 20, 2);
		assert_eq!(frame_row_text(&frame, 0), "-···foo bar");
		assert!(!frame_cell_style(&frame, 1, 0).reverse, "leading whitespace is stripped");
		for x in 4..11 {
			assert!(frame_cell_style(&frame, x, 0).reverse, "whole replaced run at {x} is inverse");
		}

		let mut unpaired = view("-one\n-two\n+three");
		let frame = paint(&mut unpaired, 20, 3);
		for y in 0..3 {
			assert!(!frame_cell_style(&frame, 1, y).reverse, "blocks are not word-diffed");
		}

		assert_eq!(
			word_marks("a b c", "a c").0.as_slice(),
			&[2..3],
			"whitespace beside kept text stays plain"
		);
		assert_eq!(
			word_marks("a b ", "a").0.as_slice(),
			&[2..4],
			"whitespace after a changed final word joins the mark"
		);
		assert_eq!(
			word_marks("x = a + b", "x = c - d").0.as_slice(),
			&[4..9],
			"whitespace between changed words joins one mark"
		);
		assert_eq!(word_marks("foo  bar", "foo bar"), (Marks::new(), Marks::new()));
	}

	#[test]
	fn indentation_glyphs_render_tabs_and_spaces_dim() {
		let ctx = UiContext::default();
		let mut diff = view("-\tremoved\n-  also\n+\tadded one\n+  added two");
		let frame = paint(&mut diff, 30, 4);
		assert_eq!(frame_row_text(&frame, 0), "- → removed");
		assert_eq!(frame_row_text(&frame, 1), "-··also");
		assert_eq!(frame_row_text(&frame, 2), "+ → added one");
		assert_eq!(frame_row_text(&frame, 3), "+··added two");
		let arrow = frame_cell_style(&frame, 2, 0);
		assert!(arrow.dim);
		assert_eq!(arrow.foreground, ctx.theme.err);
		let dot = frame_cell_style(&frame, 1, 3);
		assert!(dot.dim);
		assert_eq!(dot.foreground, ctx.theme.ok);
		assert!(!frame_cell_style(&frame, 4, 0).dim, "content after the indent is not dim");

		let mut pair = view("-\tone\n+\ttwo");
		let frame = paint(&mut pair, 20, 2);
		assert_eq!(frame_row_text(&frame, 0), "-···one", "paired rows expand tabs first");
		assert!(frame_cell_style(&frame, 2, 0).dim);

		let mut context = view(" \tkeep\tinner\n \tfinal");
		let frame = paint(&mut context, 20, 2);
		assert_eq!(frame_row_text(&frame, 0), "  → keep   inner", "interior tabs become spaces");
		assert!(frame_cell_style(&frame, 2, 0).dim);
		assert!(!frame_cell_style(&frame, 4, 0).dim);

		let mut gap = view("+1|a\n\n+9|b");
		let frame = paint(&mut gap, 20, 3);
		assert_eq!(frame_row_text(&frame, 1), "…", "a blank row is a gap marker");
	}

	#[test]
	fn diff_language_is_inferred_from_path() {
		assert_eq!(language_for_path("packages/read.ts"), Some("ts"));
		assert_eq!(language_for_path("src/lib.rs"), Some("rs"));
		assert_eq!(language_for_path("Makefile"), Some("Makefile"));
		let ctx = UiContext::default();

		let mut plain = view(" \tfn main() {}");
		let plain_frame = paint(&mut plain, 30, 1);
		assert_eq!(frame_row_text(&plain_frame, 0), "  → fn main() {}");
		assert_eq!(frame_cell_style(&plain_frame, 4, 0).foreground, ctx.theme.tool_diff_context);

		let mut highlighted = DiffView::new()
			.with(Prop::Path, "src/main.rs")
			.text(" \tfn main() {}\n-\tfn old() {}\n+\tfn new() {}");
		let frame = paint(&mut highlighted, 30, 3);
		assert_eq!(frame_row_text(&frame, 0), "    fn main() {}", "highlighted context expands tabs");
		let keyword = frame_cell_style(&frame, 4, 0);
		assert_eq!(keyword.foreground, ctx.theme.accent, "`fn` takes the keyword color");
		assert_eq!(frame_row_text(&frame, 1), "-···fn old() {}");
		assert_eq!(
			frame_cell_style(&frame, 4, 1).foreground,
			ctx.theme.tool_diff_removed,
			"changes keep their semantic +/- colors"
		);
		assert_eq!(frame_cell_style(&frame, 4, 2).foreground, ctx.theme.tool_diff_added);

		let mut unknown = DiffView::new()
			.with(Prop::Path, "notes.zzz")
			.text(" \tfn main() {}");
		let frame = paint(&mut unknown, 30, 1);
		assert_eq!(frame_row_text(&frame, 0), "  → fn main() {}", "unknown languages stay plain");
		assert_eq!(frame_cell_style(&frame, 4, 0).foreground, ctx.theme.tool_diff_context);
	}

	/// The `edit` and `apply_patch` gallery fixtures must paint exactly as
	/// `scripts/qa/fixtures/gallery/tools/{edit,apply_patch}.txt`.
	#[test]
	fn gallery_edit_fixtures_match_pi_rows() {
		let edit = "@@ -88,5 +88,6 @@\n \tconst offset = args.offset ?? 1;\n-\tconst limit = \
		            args.limit ?? 2000;\n+\tconst limit = args.limit ?? 4000;\n \tconst raw = await \
		            Bun.file(path).text();\n-\treturn raw.slice(offset , offset + \
		            limit);\n+\treturn raw.split(\"\\n\").slice(offset - 1, offset - 1 + \
		            limit).join(\"\\n\");";
		let mut diff = DiffView::new()
			.with(Prop::Path, "packages/coding-agent/src/tools/read.ts")
			.text(edit);
		let frame = paint(&mut diff, 98, 7);
		let rows: Vec<String> = (0..7).map(|y| frame_row_text(&frame, y)).collect();
		assert_eq!(rows, [
			"@@ -88,5 +88,6 @@",
			"    const offset = args.offset ?? 1;",
			"-···const limit = args.limit ?? 2000;",
			"+···const limit = args.limit ?? 4000;",
			"    const raw = await Bun.file(path).text();",
			"-···return raw.slice(offset , offset + limit);",
			"+···return raw.split(\"\\n\").slice(offset - 1, offset - 1 + limit).join(\"\\n\");",
		]);

		let patch = "@@ -177,4 +177,4 @@\n /** Count distinct file paths in an edits array. \
		             */\n-function countEditFiles(edits: EditRenderEntry[]): number {\n+function \
		             countDistinctFiles(edits: EditRenderEntry[]): number {\n \treturn new \
		             Set(edits.map(edit => \
		             filePathFromEditEntry(edit.path)).filter(Boolean)).size;\n }\n@@ -467,2 +467,2 \
		             @@\n-\t\tfileCount = countEditFiles(editArgs.edits);\n+\t\tfileCount = \
		             countDistinctFiles(editArgs.edits);";
		let mut diff = DiffView::new()
			.with(Prop::Path, "packages/coding-agent/src/edit/renderer.ts")
			.text(patch);
		let frame = paint(&mut diff, 98, 9);
		let rows: Vec<String> = (0..9).map(|y| frame_row_text(&frame, y)).collect();
		assert_eq!(rows, [
			"@@ -177,4 +177,4 @@",
			" /** Count distinct file paths in an edits array. */",
			"-function countEditFiles(edits: EditRenderEntry[]): number {",
			"+function countDistinctFiles(edits: EditRenderEntry[]): number {",
			"    return new Set(edits.map(edit => \
			 filePathFromEditEntry(edit.path)).filter(Boolean)).size;",
			" }",
			"@@ -467,2 +467,2 @@",
			"-······fileCount = countEditFiles(editArgs.edits);",
			"+······fileCount = countDistinctFiles(editArgs.edits);",
		]);
	}

	#[test]
	fn renders_mixed_hunks_with_semantic_styles() {
		let mut diff = DiffView::new();
		diff.push(DiffKind::Header, "src/main.rs");
		diff.push(DiffKind::Context, "fn main() {");
		diff.push(DiffKind::Remove, "    println!(\"Hello\");");
		diff.push(DiffKind::Add, "    println!(\"World\");");
		diff.push(DiffKind::Context, "}");

		let frame = paint(&mut diff, 40, 5);
		assert_eq!(frame_row_text(&frame, 0), "src/main.rs");
		assert_eq!(frame_row_text(&frame, 1), " fn main() {");
		assert_eq!(frame_row_text(&frame, 2), "-····println!(\"Hello\");");
		assert_eq!(frame_row_text(&frame, 3), "+····println!(\"World\");");
		assert_eq!(frame_row_text(&frame, 4), " }");

		let ctx = UiContext::default();
		assert_eq!(frame_cell_style(&frame, 0, 0).foreground, ctx.theme.tool_diff_context);
		assert_eq!(frame_cell_style(&frame, 1, 1).foreground, ctx.theme.tool_diff_context);
		assert_eq!(frame_cell_style(&frame, 0, 2).foreground, ctx.theme.tool_diff_removed);
		assert_eq!(frame_cell_style(&frame, 0, 3).foreground, ctx.theme.tool_diff_added);
	}

	#[test]
	fn incremental_replacement() {
		let mut diff = DiffView::new();
		diff.push(DiffKind::Add, "a");
		let frame1 = paint(&mut diff, 10, 2);
		assert_eq!(frame_row_text(&frame1, 0), "+a");

		diff.push(DiffKind::Add, "b");
		let frame2 = paint(&mut diff, 10, 2);
		assert_eq!(frame_row_text(&frame2, 1), "+b");

		for i in 0..RichText::rows(&diff.rich) {
			assert!(!diff.rich.row_soft_wrap(i), "wrapped DiffView rows should not be soft");
		}

		diff.replace(vec![line(DiffKind::Remove, "c", None)]);
		let frame3 = paint(&mut diff, 10, 2);
		assert_eq!(frame_row_text(&frame3, 0), "-c");
		assert_eq!(frame_row_text(&frame3, 1), "");

		diff.replace(vec![line(DiffKind::Remove, "d", None)]);
		let frame4 = paint(&mut diff, 10, 2);
		assert_eq!(frame_row_text(&frame4, 0), "-d", "same-length replacement repaints");
	}

	#[test]
	fn unicode_clipping() {
		let mut diff = DiffView::new();
		diff.push(DiffKind::Add, "한글");
		let frame = paint(&mut diff, 4, 2);
		assert_eq!(frame_row_text(&frame, 0), "+한");
		assert_eq!(frame_row_text(&frame, 1), " 글");
	}
	#[test]
	fn max_rows_bounds_wrapped_physical_rows() {
		let mut diff = DiffView::new().with(Prop::MaxRows, 3_u16);
		diff.push(DiffKind::Add, "abcdefghijklmnopqrstuvwxyz");
		diff.push(DiffKind::Add, "another logical line");
		let ctx = UiContext::default();

		assert_eq!(diff.height(&ctx, 8), 3);
	}
	#[test]
	fn overflow_footer_reserves_a_row_and_counts_wrapped_rows() {
		let mut diff = DiffView::new()
			.with(Prop::MaxRows, 3_u16)
			.with(Prop::Overflow, "diff rows");
		diff.push(DiffKind::Add, "abcdefghijklmnopqrstuvwxyz");
		let ctx = UiContext::default();
		assert_eq!(diff.height(&ctx, 8), 3);
		let frame = paint(&mut diff, 8, 3);
		assert_eq!(frame_row_text(&frame, 2), "… 2 more");
	}
	fn paint_with_ctx(
		component: &mut dyn Component,
		ctx: UiContext,
		width: u16,
		height: u16,
	) -> Frame {
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		component.paint(&mut pc, Rect::new(0, 0, width, height));
		frame
	}

	#[test]
	fn verifies_append_cache_matches_fresh_build() {
		let mut incremental = DiffView::new();
		let mut fresh = DiffView::new();
		let ctx = UiContext::default();

		incremental.push(DiffKind::Header, "file.txt");
		let _ = paint_with_ctx(&mut incremental, ctx.clone(), 20, 10);

		incremental.extend(vec![
			line(DiffKind::Context, "line 1", None),
			line(DiffKind::Remove, "line 2", None),
		]);
		let _ = paint_with_ctx(&mut incremental, ctx.clone(), 20, 10);

		incremental.push(DiffKind::Add, "line 3");
		let frame_incremental = paint_with_ctx(&mut incremental, ctx.clone(), 20, 10);

		fresh.extend(vec![
			line(DiffKind::Header, "file.txt", None),
			line(DiffKind::Context, "line 1", None),
			line(DiffKind::Remove, "line 2", None),
			line(DiffKind::Add, "line 3", None),
		]);
		let frame_fresh = paint_with_ctx(&mut fresh, ctx, 20, 10);

		assert_eq!(frame_row_text(&frame_incremental, 0), frame_row_text(&frame_fresh, 0));
		assert_eq!(frame_row_text(&frame_incremental, 1), frame_row_text(&frame_fresh, 1));
		assert_eq!(frame_row_text(&frame_incremental, 2), frame_row_text(&frame_fresh, 2));
		assert_eq!(frame_row_text(&frame_incremental, 3), frame_row_text(&frame_fresh, 3));
	}

	#[test]
	fn clear_and_extend_return_semantic_changes() {
		let mut diff = DiffView::new();
		assert!(!diff.clear());
		assert!(diff.extend(vec![line(DiffKind::Add, "x", None)]));
		assert!(!diff.extend(vec![]));
		assert!(diff.clear());
	}

	#[test]
	fn empty_diff() {
		let mut diff = DiffView::new();
		let frame = paint(&mut diff, 10, 2);
		assert_eq!(frame_row_text(&frame, 0).trim_end(), "");
	}
}
