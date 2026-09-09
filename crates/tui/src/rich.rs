//! Push-based styled rich-text storage and rendering adapters.

use std::{
	iter, mem,
	sync::{
		LazyLock,
		atomic::{AtomicU8, AtomicU64, Ordering},
	},
};

use omp_core::Str;
use smallvec::SmallVec;
use xutf::{Text, width_char};

use crate::{
	context::JamoWidth,
	escape::esc,
	frame::{Color, Style, Underline},
	renderer::push_style_parameters,
};

/// A reusable static space buffer for allocation-free padding.
pub const SPACES: &str = "                                                                 ";
const HANGUL_COMPAT_JAMO_START: char = '\u{3131}';
const HANGUL_COMPAT_JAMO_END: char = '\u{318e}';
const HANGUL_FILLER: char = '\u{3164}';
const JAMO_PLATFORM: u8 = 0;
const JAMO_UNICODE: u8 = 1;
const JAMO_NARROW: u8 = 2;
const JAMO_WIDE: u8 = 3;

static JAMO_WIDTH: AtomicU8 = AtomicU8::new(JAMO_PLATFORM);
static WIDTH_CONFIG_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Hangul Compatibility Jamo width policy currently used by [`cell_width`].
pub fn jamo_width() -> JamoWidth {
	match JAMO_WIDTH.load(Ordering::Relaxed) {
		JAMO_UNICODE => JamoWidth::Unicode,
		JAMO_NARROW => JamoWidth::Narrow,
		JAMO_WIDE => JamoWidth::Wide,
		_ => JamoWidth::Platform,
	}
}

/// Sets the process-wide Hangul Compatibility Jamo width policy.
///
/// Returns whether the policy changed. A change advances
/// [`width_config_epoch`] so geometry and wrapping memos can discard widths
/// measured under the previous policy.
pub fn set_jamo_width(width: JamoWidth) -> bool {
	let encoded = match width {
		JamoWidth::Platform => JAMO_PLATFORM,
		JamoWidth::Unicode => JAMO_UNICODE,
		JamoWidth::Narrow => JAMO_NARROW,
		JamoWidth::Wide => JAMO_WIDE,
	};
	if JAMO_WIDTH.swap(encoded, Ordering::Relaxed) == encoded {
		return false;
	}
	WIDTH_CONFIG_EPOCH.fetch_add(1, Ordering::Relaxed);
	true
}

/// Monotonic generation for every process-wide width-affecting setting.
///
/// Any memo derived from [`cell_width`] must include this value in its key.
pub fn width_config_epoch() -> u64 {
	WIDTH_CONFIG_EPOCH.load(Ordering::Relaxed)
}

fn plain_cell_width(text: &str) -> u16 {
	if text.is_ascii() && text.bytes().all(|byte| !byte.is_ascii_control()) {
		return u16::try_from(text.len()).unwrap_or(u16::MAX);
	}
	let mut width = text.visible_width();
	let policy = jamo_width();
	for character in text
		.chars()
		.filter(|character| (HANGUL_COMPAT_JAMO_START..=HANGUL_COMPAT_JAMO_END).contains(character))
	{
		let unicode_width = width_char(character);
		let target = if character == HANGUL_FILLER {
			0
		} else {
			match policy {
				JamoWidth::Unicode => unicode_width,
				JamoWidth::Narrow => 1,
				JamoWidth::Wide => 2,
				JamoWidth::Platform if cfg!(target_os = "macos") => 1,
				JamoWidth::Platform => unicode_width,
			}
		};
		width = width.saturating_sub(unicode_width).saturating_add(target);
	}
	u16::try_from(width).unwrap_or(u16::MAX)
}

/// Visible width saturated to `u16::MAX`.
///
/// `xutf` supplies cluster-aware Unicode widths and treats East Asian
/// Ambiguous characters as narrow. Compatibility Jamo are corrected by the
/// delta from `xutf`'s own per-character classification to the active terminal
/// policy; U+3164 HANGUL FILLER always remains zero-width. APC strings
/// (`ESC _ ... ST|BEL`), including Kitty placement commands and cursor
/// markers, occupy no terminal cells.
pub fn cell_width(text: &str) -> u16 {
	let Some(mut start) = text.find("\x1b_") else {
		return plain_cell_width(text);
	};
	let mut width = plain_cell_width(&text[..start]);
	loop {
		let payload = start + 2;
		let tail = &text[payload..];
		let bell = tail.find('\x07').map(|end| payload + end + 1);
		let st = tail.find("\x1b\\").map(|end| payload + end + 2);
		let end = match (bell, st) {
			(Some(bell), Some(st)) => bell.min(st),
			(Some(bell), None) => bell,
			(None, Some(st)) => st,
			(None, None) => return width,
		};
		let Some(relative) = text[end..].find("\x1b_") else {
			return width.saturating_add(plain_cell_width(&text[end..]));
		};
		start = end + relative;
		width = width.saturating_add(plain_cell_width(&text[end..start]));
	}
}

fn emit_spaces(sink: &mut dyn RichSink, style: Style, mut count: u16) {
	while count != 0 {
		let take = usize::from(count.min(SPACES.len() as u16));
		sink.run(style, &SPACES[..take]);
		count -= take as u16;
	}
}

/// Receives styled runs and row breaks. `run` text contains neither newlines
/// nor escapes; external ANSI text must cross [`decompose`] exactly once.
pub trait RichSink {
	/// Appends a styled text run to the current row.
	fn run(&mut self, style: Style, text: &str);

	/// Completes the current row and starts another logical row.
	fn newline(&mut self);

	/// Completes the current row at a mid-word soft wrap: the text continues
	/// on the next row purely because it hit the layout width, with no
	/// whitespace collapsed at the break.
	///
	/// Provenance-tracking sinks keep the boundary joinable so the renderer
	/// can re-join it with terminal autowrap; the default treats it as a
	/// [`RichSink::newline`].
	fn soft_wrap(&mut self) {
		self.newline();
	}
}

/// ANSI-materializing boundary sink.
///
/// Each run carries a complete style prefix, so a `String` has no hidden style
/// state. Text passed to this sink is escape-free by the [`RichSink`] contract.
impl RichSink for String {
	fn run(&mut self, style: Style, text: &str) {
		self.push_str(esc!(style_prefix));
		let mut first = false;
		push_style_parameters(self, style, &mut first);
		self.push('m');
		self.push_str(text);
	}

	fn newline(&mut self) {
		self.push_str(esc!(style_reset, "\n"));
	}
}

/// Decomposes external terminal text into maximal escape-free styled slices.
///
/// This is the single ANSI ingress for the rich pipeline: external producers
/// parse once here, and every downstream component may assume its text contains
/// neither escape sequences nor newlines.
pub fn decompose(input: &str, sink: &mut dyn RichSink) {
	let bytes = input.as_bytes();
	let mut style = Style::new();
	let mut clean_start = 0;
	let mut index = 0;

	while index < bytes.len() {
		match bytes[index] {
			b'\n' => {
				emit_clean(input, clean_start, index, style, sink);
				sink.newline();
				index += 1;
				clean_start = index;
			},
			b'\r' => {
				emit_clean(input, clean_start, index, style, sink);
				index += 1;
				if bytes.get(index) == Some(&b'\n') {
					sink.newline();
					index += 1;
				}
				clean_start = index;
			},
			b'\x1b' => {
				emit_clean(input, clean_start, index, style, sink);
				index = consume_escape(input, index, &mut style);
				clean_start = index;
			},
			_ => index += 1,
		}
	}
	emit_clean(input, clean_start, index, style, sink);
}

fn emit_clean(input: &str, start: usize, end: usize, style: Style, sink: &mut dyn RichSink) {
	if start != end {
		sink.run(style, &input[start..end]);
	}
}

fn consume_escape(input: &str, start: usize, style: &mut Style) -> usize {
	let bytes = input.as_bytes();
	let Some(&kind) = bytes.get(start + 1) else {
		return bytes.len();
	};
	match kind {
		b'[' => {
			let mut end = start + 2;
			while let Some(&byte) = bytes.get(end) {
				if (0x40..=0x7e).contains(&byte) {
					if byte == b'm' {
						apply_sgr(&input[start + 2..end], style);
					}
					return end + 1;
				}
				end += 1;
			}
			bytes.len()
		},
		b']' => {
			let mut end = start + 2;
			while let Some(&byte) = bytes.get(end) {
				if byte == b'\x07' {
					return end + 1;
				}
				if byte == b'\x1b' && bytes.get(end + 1) == Some(&b'\\') {
					return end + 2;
				}
				end += 1;
			}
			bytes.len()
		},
		_ => {
			let length = input[start + 1..]
				.chars()
				.next()
				.expect("escape kind exists")
				.len_utf8();
			start + 1 + length
		},
	}
}

fn apply_sgr(parameters: &str, style: &mut Style) {
	let mut parameters = parameters.split(';');
	while let Some(parameter) = parameters.next() {
		let (head, subparameter) = match parameter.split_once(':') {
			Some((head, rest)) => (head, Some(rest)),
			None => (parameter, None),
		};
		let code = if head.is_empty() {
			0
		} else if let Ok(code) = head.parse::<u16>() {
			code
		} else {
			continue;
		};
		// Colon sub-parameters are only understood for underline shapes; other
		// colon forms stay ignored as before.
		if subparameter.is_some() && code != 4 {
			continue;
		}
		match code {
			0 => *style = Style::new(),
			1 => style.bold = true,
			2 => style.dim = true,
			3 => style.italic = true,
			4 => {
				style.underline = match subparameter.and_then(|value| value.split(':').next()) {
					Some("0") => Underline::None,
					Some("3") => Underline::Curly,
					_ => Underline::Straight,
				}
			},
			7 => style.reverse = true,
			9 => style.strikethrough = true,
			22 => {
				style.bold = false;
				style.dim = false;
			},
			23 => style.italic = false,
			24 => style.underline = Underline::None,
			27 => style.reverse = false,
			29 => style.strikethrough = false,
			30..=37 => style.foreground = Color::Indexed((code - 30) as u8),
			39 => style.foreground = Color::Default,
			40..=47 => style.background = Color::Indexed((code - 40) as u8),
			49 => style.background = Color::Default,
			90..=97 => style.foreground = Color::Indexed((code - 90 + 8) as u8),
			100..=107 => style.background = Color::Indexed((code - 100 + 8) as u8),
			38 | 48 => {
				let background = code == 48;
				let color = match parameters
					.next()
					.and_then(|value| value.parse::<u16>().ok())
				{
					Some(5) => parameters
						.next()
						.and_then(|value| value.parse::<u8>().ok())
						.map(Color::Indexed),
					Some(2) => {
						let red = parameters.next().and_then(|value| value.parse::<u8>().ok());
						let green = parameters.next().and_then(|value| value.parse::<u8>().ok());
						let blue = parameters.next().and_then(|value| value.parse::<u8>().ok());
						red.zip(green)
							.zip(blue)
							.map(|((red, green), blue)| Color::Rgb(red, green, blue))
					},
					_ => None,
				};
				if let Some(color) = color {
					if background {
						style.background = color;
					} else {
						style.foreground = color;
					}
				}
			},
			_ => {},
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Run {
	end:   u32,
	style: Style,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RowMeta {
	run_end: u32,
	width:   u16,
	/// The row ended at a mid-word soft wrap and joins onto the next row.
	soft:    bool,
}

/// Flat rendered rich text with coalesced styled runs and row metadata.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RichText {
	text:          String,
	runs:          Vec<Run>,
	rows:          Vec<RowMeta>,
	current_width: u16,
	open:          bool,
}

impl RichText {
	/// Clears all content while retaining allocated storage.
	pub fn clear(&mut self) {
		self.text.clear();
		self.runs.clear();
		self.rows.clear();
		self.current_width = 0;
		self.open = false;
	}

	/// Drops `row` and every following row while retaining the backing arenas.
	///
	/// The next run starts a fresh row. A retained soft-wrap marker therefore
	/// remains connected to a replacement tail appended through [`RichSink`].
	pub(crate) fn truncate_rows(&mut self, rows: u16) {
		let keep = usize::from(rows).min(self.rows.len());
		let run_end = self
			.rows
			.get(keep.wrapping_sub(1))
			.map_or(0, |row| row.run_end as usize);
		let byte_end = self
			.runs
			.get(run_end.wrapping_sub(1))
			.map_or(0, |run| run.end as usize);
		self.text.truncate(byte_end);
		self.runs.truncate(run_end);
		self.rows.truncate(keep);
		self.current_width = 0;
		self.open = false;
	}

	/// Returns retained arena capacities for steady-state allocation tests.
	#[cfg(test)]
	pub(crate) const fn capacities(&self) -> (usize, usize, usize) {
		(self.text.capacity(), self.runs.capacity(), self.rows.capacity())
	}

	/// Returns the number of rendered rows, including a non-empty partial row.
	pub fn rows(&self) -> u16 {
		u16::try_from(self.rows.len())
			.unwrap_or(u16::MAX)
			.saturating_add(u16::from(self.open))
	}

	/// Returns the precomputed terminal-cell width of `row`.
	pub fn row_width(&self, row: u16) -> u16 {
		let index = usize::from(row);
		if let Some(meta) = self.rows.get(index) {
			meta.width
		} else if self.open && index == self.rows.len() {
			self.current_width
		} else {
			0
		}
	}

	fn row_run_bounds(&self, row: u16) -> (usize, usize) {
		let index = usize::from(row);
		if index >= usize::from(self.rows()) {
			return (0, 0);
		}
		let start = index
			.checked_sub(1)
			.and_then(|previous| self.rows.get(previous))
			.map_or(0, |meta| meta.run_end as usize);
		let end = self
			.rows
			.get(index)
			.map_or(self.runs.len(), |meta| meta.run_end as usize);
		(start, end)
	}

	/// Returns the plain text in `row`.
	pub fn row_text(&self, row: u16) -> &str {
		let (run_start, run_end) = self.row_run_bounds(row);
		let byte_start = run_start
			.checked_sub(1)
			.and_then(|index| self.runs.get(index))
			.map_or(0, |run| run.end as usize);
		let byte_end = run_end
			.checked_sub(1)
			.and_then(|index| self.runs.get(index))
			.map_or(byte_start, |run| run.end as usize);
		&self.text[byte_start..byte_end]
	}

	/// Iterates the styled runs in `row`.
	pub fn row_runs(
		&self,
		row: u16,
	) -> impl DoubleEndedIterator<Item = (Style, &str)>
	+ ExactSizeIterator
	+ Clone
	+ iter::FusedIterator
	+ '_ {
		let (start, end) = self.row_run_bounds(row);
		self.runs[start..end]
			.iter()
			.enumerate()
			.map(move |(offset, run)| {
				let index = start + offset;
				let byte_start = index
					.checked_sub(1)
					.and_then(|previous| self.runs.get(previous))
					.map_or(0, |previous| previous.end as usize);
				(run.style, &self.text[byte_start..run.end as usize])
			})
	}

	/// Whether `row` soft-wraps onto the following row: it was broken
	/// mid-word by width alone, so the pair forms one logical line.
	pub fn row_soft_wrap(&self, row: u16) -> bool {
		self
			.rows
			.get(usize::from(row))
			.is_some_and(|meta| meta.soft)
	}

	/// Replays every row, preserving completed versus trailing partial rows.
	pub fn replay(&self, sink: &mut dyn RichSink) {
		for row in 0..self.rows() {
			self.replay_row(row, sink);
			if usize::from(row) < self.rows.len() {
				if self.row_soft_wrap(row) {
					sink.soft_wrap();
				} else {
					sink.newline();
				}
			}
		}
	}

	/// Replays the runs of one row without appending a newline.
	pub fn replay_row(&self, row: u16, sink: &mut dyn RichSink) {
		for (style, text) in self.row_runs(row) {
			sink.run(style, text);
		}
	}

	/// Returns the widest rendered row.
	pub fn widest(&self) -> u16 {
		self
			.rows
			.iter()
			.map(|row| row.width)
			.chain(self.open.then_some(self.current_width))
			.max()
			.unwrap_or(0)
	}
}

impl RichSink for RichText {
	fn run(&mut self, style: Style, text: &str) {
		if text.is_empty() {
			return;
		}
		self.text.push_str(text);
		let end = u32::try_from(self.text.len()).expect("rich text exceeds four gigabytes");
		if self.open && self.runs.last().is_some_and(|run| run.style == style) {
			self.runs.last_mut().expect("last run exists").end = end;
		} else {
			self.runs.push(Run { end, style });
		}
		self.current_width = self.current_width.saturating_add(cell_width(text));
		self.open = true;
	}

	fn newline(&mut self) {
		self.end_row(false);
	}

	fn soft_wrap(&mut self) {
		self.end_row(true);
	}
}
impl RichText {
	fn end_row(&mut self, soft: bool) {
		self.rows.push(RowMeta {
			run_end: u32::try_from(self.runs.len()).expect("rich text has too many runs"),
			width: self.current_width,
			soft,
		});
		self.current_width = 0;
		self.open = false;
	}
}

/// Counts rendered rows and widths without storing their text.
#[derive(Default)]
pub struct Measure {
	/// Number of rows observed, including a non-empty partial row.
	pub rows:   u16,
	/// Width of the widest row observed.
	pub widest: u16,
	current:    u16,
	last:       u16,
	open:       bool,
}

impl RichSink for Measure {
	fn run(&mut self, _style: Style, text: &str) {
		if text.is_empty() {
			return;
		}
		if !self.open {
			self.rows = self.rows.saturating_add(1);
			self.open = true;
		}
		self.current = self.current.saturating_add(cell_width(text));
		self.widest = self.widest.max(self.current);
	}

	fn newline(&mut self) {
		if !self.open {
			self.rows = self.rows.saturating_add(1);
		}
		self.widest = self.widest.max(self.current);
		self.last = self.current;
		self.current = 0;
		self.open = false;
	}
}

impl Measure {
	/// Width of the most recently terminated row, or the open trailing row.
	pub(crate) const fn final_width(&self) -> u16 {
		if self.open { self.current } else { self.last }
	}
}

/// An owned styled hanging prefix.
#[derive(Clone, Debug, Default)]
pub struct Prefix {
	text:  String,
	runs:  SmallVec<(u32, Style), 2>,
	width: u16,
}

impl Prefix {
	/// Appends a styled run to this prefix.
	pub fn push(&mut self, style: Style, text: &str) {
		if text.is_empty() {
			return;
		}
		self.text.push_str(text);
		let end = u32::try_from(self.text.len()).expect("prefix exceeds four gigabytes");
		if self
			.runs
			.last()
			.is_some_and(|(_, run_style)| *run_style == style)
		{
			self.runs.last_mut().expect("last prefix run exists").0 = end;
		} else {
			self.runs.push((end, style));
		}
		self.width = self.width.saturating_add(cell_width(text));
	}

	/// Returns the prefix width in terminal cells.
	pub const fn width(&self) -> u16 {
		self.width
	}

	/// Emits this prefix into `sink`.
	pub fn emit(&self, sink: &mut dyn RichSink) {
		let mut start = 0;
		for (end, style) in &self.runs {
			sink.run(*style, &self.text[start..*end as usize]);
			start = *end as usize;
		}
	}

	/// Returns whether the prefix contains no text.
	pub const fn is_empty(&self) -> bool {
		self.text.is_empty()
	}

	/// Returns a shared empty prefix.
	pub fn empty_ref() -> &'static Self {
		static EMPTY: LazyLock<Prefix> = LazyLock::new(Prefix::default);
		&EMPTY
	}

	fn emit_clipped(&self, width: u16, sink: &mut dyn RichSink) -> bool {
		let mut used = 0_u16;
		let mut start = 0;
		let mut emitted = false;
		'outer: for (end, style) in &self.runs {
			for grapheme in self.text[start..*end as usize].graphemes() {
				let grapheme_width = cell_width(grapheme);
				if used.saturating_add(grapheme_width) > width {
					break 'outer;
				}
				sink.run(*style, grapheme);
				emitted = true;
				used = used.saturating_add(grapheme_width);
			}
			start = *end as usize;
		}
		emitted
	}
}

impl<S: RichSink + ?Sized> RichSink for &mut S {
	fn run(&mut self, style: Style, text: &str) {
		(**self).run(style, text);
	}

	fn newline(&mut self) {
		(**self).newline();
	}

	fn soft_wrap(&mut self) {
		(**self).soft_wrap();
	}
}

/// Functional adapters available on every rich sink.
pub trait Pipeline: RichSink + Sized {
	/// Hard-clips each row to `width`, optionally replacing its final cell with
	/// a marker.
	fn clip(self, width: u16, marker: Option<char>) -> Clip<Self> {
		Clip::new(self, width, marker)
	}

	/// Limits output to at most `max` rows.
	fn rows(self, max: u16) -> Rows<Self> {
		Rows { inner: self, max, seen: 0, truncated: false }
	}

	/// Word-wraps output without prefixes.
	fn wrap(self, width: u16) -> Wrap<'static, Self> {
		self.wrap_prefixed(width, Prefix::empty_ref(), Prefix::empty_ref())
	}
	/// Flows output grapheme-exact to `width` like a bare terminal: every
	/// width break is a byte-preserving [`RichSink::soft_wrap`], so joined
	/// rows reproduce the source exactly in native copy.
	fn wrap_chars(self, width: u16) -> CharWrap<'static, Self> {
		CharWrap {
			inner:        self,
			width:        width.max(1),
			first:        Prefix::empty_ref(),
			cont:         Prefix::empty_ref(),
			line_width:   0,
			emitted:      false,
			continuation: false,
		}
	}

	/// Character-wraps output using first-row and continuation prefixes.
	fn wrap_chars_prefixed<'p>(
		self,
		width: u16,
		first: &'p Prefix,
		cont: &'p Prefix,
	) -> CharWrap<'p, Self> {
		CharWrap {
			inner: self,
			width: width.max(1),
			first,
			cont,
			line_width: 0,
			emitted: false,
			continuation: false,
		}
	}

	/// Word-wraps output using first-row and continuation prefixes.
	fn wrap_prefixed<'p>(self, width: u16, first: &'p Prefix, cont: &'p Prefix) -> Wrap<'p, Self> {
		Wrap::new(self, width, first, cont)
	}

	/// Copies output into `copy` while forwarding it.
	fn tee(self, copy: &mut RichText) -> Tee<'_, Self> {
		Tee { inner: self, copy }
	}

	/// Maps every incoming style.
	fn restyle<F: Fn(Style) -> Style>(self, map: F) -> Restyle<Self, F> {
		Restyle { inner: self, map }
	}

	/// Adds a prefix at the start of every row without wrapping.
	fn prefixed<'p>(self, first: &'p Prefix, cont: &'p Prefix) -> Prefixed<'p, Self> {
		Prefixed { inner: self, first, cont, row: 0, at_start: true }
	}
}

impl<S: RichSink> Pipeline for S {}

/// A terminal-exact wrapping sink adapter.
///
/// Graphemes flow to the exact width with all whitespace preserved.
/// Bare overflows soft-wrap, while non-empty continuations hard-break.
pub struct CharWrap<'p, S: RichSink> {
	inner:        S,
	width:        u16,
	first:        &'p Prefix,
	cont:         &'p Prefix,
	line_width:   u16,
	emitted:      bool,
	continuation: bool,
}

impl<S: RichSink> CharWrap<'_, S> {
	fn start_row(&mut self) {
		if self.emitted {
			return;
		}
		let prefix = if self.continuation {
			self.cont
		} else {
			self.first
		};
		prefix.emit_clipped(self.width, &mut self.inner);
		self.line_width = prefix.width().min(self.width);
		self.emitted = true;
	}
}

impl<S: RichSink> RichSink for CharWrap<'_, S> {
	fn run(&mut self, style: Style, text: &str) {
		for grapheme in text.graphemes() {
			let w = cell_width(grapheme);
			if w > self.width {
				continue;
			}

			self.start_row();

			if w > 0 && self.line_width.saturating_add(w) > self.width {
				if self.cont.width().min(self.width).saturating_add(w) > self.width {
					continue;
				}
				if self.cont.is_empty() {
					self.inner.soft_wrap();
				} else {
					self.inner.newline();
				}
				self.emitted = false;
				self.continuation = true;
				self.start_row();
			}

			self.inner.run(style, grapheme);
			self.line_width = self.line_width.saturating_add(w);
		}
	}

	fn newline(&mut self) {
		self.start_row();
		self.inner.newline();
		self.emitted = false;
		self.continuation = false;
	}

	fn soft_wrap(&mut self) {
		self.start_row();
		if self.cont.is_empty() {
			self.inner.soft_wrap();
		} else {
			self.inner.newline();
		}
		self.emitted = false;
		self.continuation = true;
	}
}

/// A word-wrapping rich sink adapter.
pub struct Wrap<'p, S: RichSink> {
	inner:        S,
	width:        u16,
	first:        &'p Prefix,
	cont:         &'p Prefix,
	word:         String,
	word_runs:    SmallVec<(u32, Style), 4>,
	word_width:   u16,
	gap_text:     String,
	gap_runs:     SmallVec<(u32, Style), 2>,
	gap_width:    u16,
	line_width:   u16,
	emitted:      bool,
	content:      bool,
	continuation: bool,
}

impl<'p, S: RichSink> Wrap<'p, S> {
	const fn new(inner: S, width: u16, first: &'p Prefix, cont: &'p Prefix) -> Self {
		Self {
			inner,
			width,
			first,
			cont,
			word: String::new(),
			word_runs: SmallVec::new(),
			word_width: 0,
			gap_text: String::new(),
			gap_runs: SmallVec::new(),
			gap_width: 0,
			line_width: 0,
			emitted: false,
			content: false,
			continuation: false,
		}
	}

	fn start_row(&mut self) {
		if self.emitted {
			return;
		}
		let prefix = if self.continuation {
			self.cont
		} else {
			self.first
		};
		prefix.emit_clipped(self.width, &mut self.inner);
		self.line_width = prefix.width().min(self.width);
		self.emitted = true;
	}

	fn break_row(&mut self, soft: bool) {
		self.start_row();
		// A prefixed continuation never starts at the break column, so the
		// boundary is only joinable when continuation rows are bare.
		if soft && self.cont.is_empty() {
			self.inner.soft_wrap();
		} else {
			self.inner.newline();
		}
		self.line_width = 0;
		self.emitted = false;
		self.content = false;
		self.continuation = true;
	}

	fn append_word_grapheme(&mut self, style: Style, grapheme: &str) {
		self.word.push_str(grapheme);
		let end = u32::try_from(self.word.len()).expect("wrapped word exceeds four gigabytes");
		if self
			.word_runs
			.last()
			.is_some_and(|(_, run_style)| *run_style == style)
		{
			self.word_runs.last_mut().expect("last word run exists").0 = end;
		} else {
			self.word_runs.push((end, style));
		}
		self.word_width = self.word_width.saturating_add(cell_width(grapheme));
	}

	fn append_gap_grapheme(&mut self, style: Style, grapheme: &str) {
		self.gap_text.push_str(grapheme);
		let end = u32::try_from(self.gap_text.len()).expect("wrapped gap exceeds four gigabytes");
		if self
			.gap_runs
			.last()
			.is_some_and(|(_, run_style)| *run_style == style)
		{
			self.gap_runs.last_mut().expect("last gap run exists").0 = end;
		} else {
			self.gap_runs.push((end, style));
		}
		self.gap_width = self.gap_width.saturating_add(cell_width(grapheme));
	}

	fn emit_gap(&mut self) {
		if self.gap_text.is_empty() {
			emit_spaces(&mut self.inner, Style::new(), 1);
			return;
		}
		let mut start = 0;
		for (end, style) in &self.gap_runs {
			self.inner.run(*style, &self.gap_text[start..*end as usize]);
			start = *end as usize;
		}
	}

	fn clear_gap(&mut self) {
		self.gap_text.clear();
		self.gap_runs.clear();
		self.gap_width = 0;
	}

	fn flush_word(&mut self) {
		if self.word.is_empty() {
			return;
		}
		let word = mem::take(&mut self.word);
		let runs = mem::take(&mut self.word_runs);
		let word_width = mem::take(&mut self.word_width);
		self.start_row();
		let leading_gap = !self.content && !self.gap_text.is_empty();
		if leading_gap {
			self.emit_gap();
			self.line_width = self.line_width.saturating_add(self.gap_width);
			self.content = true;
		}
		let join_gap = if leading_gap {
			0
		} else {
			self.gap_width.max(1)
		};
		if self.content
			&& self
				.line_width
				.saturating_add(join_gap)
				.saturating_add(word_width)
				> self.width
		{
			self.break_row(false);
			self.start_row();
		} else if self.content && !leading_gap {
			self.emit_gap();
			self.line_width = self.line_width.saturating_add(join_gap);
		}

		let mut start = 0;
		for (end, style) in &runs {
			for grapheme in word[start..*end as usize].graphemes() {
				let grapheme_width = cell_width(grapheme);
				if self.content && self.line_width.saturating_add(grapheme_width) > self.width {
					self.break_row(true);
					self.start_row();
				}
				if self.line_width.saturating_add(grapheme_width) <= self.width || self.width != 0 {
					self.inner.run(*style, grapheme);
					self.line_width = self.line_width.saturating_add(grapheme_width);
					self.content = true;
				}
			}
			start = *end as usize;
		}
		self.clear_gap();
		self.word = word;
		self.word.clear();
		self.word_runs = runs;
		self.word_runs.clear();
	}

	/// Flushes the trailing word and partial row, returning the downstream sink.
	pub fn finish(mut self) -> S {
		self.flush_word();
		self.start_row();
		self.inner.newline();
		self.inner
	}
}

impl<S: RichSink> RichSink for Wrap<'_, S> {
	fn run(&mut self, style: Style, text: &str) {
		for grapheme in text.graphemes() {
			if grapheme != "\u{a0}" && grapheme.chars().all(char::is_whitespace) {
				self.flush_word();
				self.append_gap_grapheme(style, grapheme);
			} else {
				self.append_word_grapheme(style, grapheme);
			}
		}
	}

	fn newline(&mut self) {
		self.flush_word();
		self.break_row(false);
		self.clear_gap();
	}
}

/// A per-row hard-clipping sink adapter.
pub struct Clip<S: RichSink> {
	inner:   S,
	width:   u16,
	marker:  Option<char>,
	used:    u16,
	done:    bool,
	pending: Option<(Style, Str, u16)>,
}

impl<S: RichSink> Clip<S> {
	const fn new(inner: S, width: u16, marker: Option<char>) -> Self {
		Self { inner, width, marker, used: 0, done: false, pending: None }
	}

	fn flush_pending(&mut self) {
		if let Some((style, text, _)) = self.pending.take() {
			self.inner.run(style, text.as_str());
		}
	}

	fn truncate(&mut self, fallback_style: Style) {
		self.done = true;
		let style = self
			.pending
			.as_ref()
			.map_or(fallback_style, |pending| pending.0);
		if let Some((_, _, width)) = self.pending.take() {
			self.used = self.used.saturating_sub(width);
		}
		if let Some(marker) = self.marker {
			let mut encoded = [0_u8; 4];
			let marker = marker.encode_utf8(&mut encoded);
			let marker_width = cell_width(marker);
			if marker_width != 0 && self.used.saturating_add(marker_width) <= self.width {
				self.inner.run(style, marker);
				self.used = self.used.saturating_add(marker_width);
			}
		}
	}
}

impl<S: RichSink> RichSink for Clip<S> {
	fn run(&mut self, style: Style, text: &str) {
		if self.done || text.is_empty() {
			return;
		}
		for grapheme in text.graphemes() {
			let grapheme_width = cell_width(grapheme);
			if self.used.saturating_add(grapheme_width) > self.width {
				self.truncate(style);
				break;
			}
			if self.marker.is_some() {
				self.flush_pending();
				self.pending = Some((style, Str::new(grapheme), grapheme_width));
			} else {
				self.inner.run(style, grapheme);
			}
			self.used = self.used.saturating_add(grapheme_width);
		}
	}

	fn newline(&mut self) {
		if !self.done {
			self.flush_pending();
		}
		self.inner.newline();
		self.used = 0;
		self.done = false;
		self.pending = None;
	}

	fn soft_wrap(&mut self) {
		if !self.done {
			self.flush_pending();
		}
		self.inner.soft_wrap();
		self.used = 0;
		self.done = false;
		self.pending = None;
	}
}

impl<S: RichSink> Drop for Clip<S> {
	fn drop(&mut self) {
		if !self.done {
			self.flush_pending();
		}
	}
}

/// A row-limiting sink adapter.
pub struct Rows<S: RichSink> {
	inner:     S,
	max:       u16,
	seen:      u16,
	truncated: bool,
}

impl<S: RichSink> Rows<S> {
	/// Returns whether any output was swallowed after the row limit.
	pub const fn truncated(&self) -> bool {
		self.truncated
	}
}

impl<S: RichSink> RichSink for Rows<S> {
	fn run(&mut self, style: Style, text: &str) {
		if self.seen < self.max {
			self.inner.run(style, text);
		} else if !text.is_empty() {
			self.truncated = true;
		}
	}

	fn newline(&mut self) {
		if self.seen < self.max {
			self.inner.newline();
			self.seen = self.seen.saturating_add(1);
		} else {
			self.truncated = true;
		}
	}

	fn soft_wrap(&mut self) {
		if self.seen < self.max {
			self.inner.soft_wrap();
			self.seen = self.seen.saturating_add(1);
		} else {
			self.truncated = true;
		}
	}
}

/// A sink adapter that forwards and copies all output.
pub struct Tee<'b, S: RichSink> {
	inner: S,
	copy:  &'b mut RichText,
}

impl<S: RichSink> RichSink for Tee<'_, S> {
	fn run(&mut self, style: Style, text: &str) {
		self.inner.run(style, text);
		self.copy.run(style, text);
	}

	fn newline(&mut self) {
		self.inner.newline();
		self.copy.newline();
	}

	fn soft_wrap(&mut self) {
		self.inner.soft_wrap();
		self.copy.soft_wrap();
	}
}

/// A sink adapter that transforms every style.
pub struct Restyle<S: RichSink, F: Fn(Style) -> Style> {
	inner: S,
	map:   F,
}

impl<S: RichSink, F: Fn(Style) -> Style> RichSink for Restyle<S, F> {
	fn run(&mut self, style: Style, text: &str) {
		self.inner.run((self.map)(style), text);
	}

	fn newline(&mut self) {
		self.inner.newline();
	}

	fn soft_wrap(&mut self) {
		self.inner.soft_wrap();
	}
}

/// A sink adapter that emits first-row and continuation prefixes.
pub struct Prefixed<'p, S: RichSink> {
	inner:    S,
	first:    &'p Prefix,
	cont:     &'p Prefix,
	row:      u16,
	at_start: bool,
}

impl<S: RichSink> Prefixed<'_, S> {
	fn prefix(&mut self) {
		if !self.at_start {
			return;
		}
		if self.row == 0 {
			self.first.emit(&mut self.inner);
		} else {
			self.cont.emit(&mut self.inner);
		}
		self.at_start = false;
	}
}

impl<S: RichSink> RichSink for Prefixed<'_, S> {
	fn run(&mut self, style: Style, text: &str) {
		if text.is_empty() {
			return;
		}
		self.prefix();
		self.inner.run(style, text);
	}

	fn newline(&mut self) {
		self.prefix();
		self.inner.newline();
		self.row = self.row.saturating_add(1);
		self.at_start = true;
	}
	// A prefixed continuation row can never be byte-joined to its
	// predecessor, so a soft wrap degrades to a hard row break.
}

#[cfg(test)]
mod tests {
	use super::*;

	fn texts(rich: &RichText) -> Vec<&str> {
		(0..rich.rows()).map(|row| rich.row_text(row)).collect()
	}

	#[test]
	fn decompose_splits_bash_ansi_into_clean_styled_runs() {
		let mut output = RichText::default();
		decompose("plain \x1b[31;1mred\x1b[0m!\n\x1b[38;2;1;2;3mrgb", &mut output);

		assert_eq!(texts(&output), ["plain red!", "rgb"]);
		assert!(texts(&output).iter().all(|text| !text.contains('\x1b')));
		assert_eq!(output.row_runs(0).collect::<Vec<_>>(), [
			(Style::new(), "plain "),
			(Style::new().fg(Color::Indexed(1)).bold(), "red"),
			(Style::new(), "!"),
		]);
		assert_eq!(output.row_runs(1).collect::<Vec<_>>(), [(
			Style::new().fg(Color::Rgb(1, 2, 3)),
			"rgb"
		)]);
	}

	#[test]
	fn decompose_parses_underline_shape_subparameters() {
		let mut output = RichText::default();
		decompose("\x1b[4mline\x1b[24m \x1b[4:3mcurl\x1b[4:0m plain", &mut output);
		assert_eq!(output.row_runs(0).collect::<Vec<_>>(), [
			(Style::new().underline(), "line"),
			(Style::new(), " "),
			(Style::new().undercurl(), "curl"),
			(Style::new(), " plain"),
		]);
	}

	#[test]
	fn string_sink_emits_undercurl_shape_and_color() {
		let mut output = String::new();
		output.run(
			Style::new()
				.undercurl()
				.underline_color(Color::Rgb(255, 95, 95)),
			"typo",
		);
		assert_eq!(output, "\x1b[0;4:3;58:2::255:95:95mtypo");
	}

	#[test]
	fn string_sink_emits_a_complete_style_for_every_run() {
		let mut output = String::new();
		output.run(Style::new(), "a");
		output.run(Style::new().bold().fg(Color::Rgb(1, 2, 3)), "b");
		output.newline();

		assert_eq!(output, "\x1b[0ma\x1b[0;1;38;2;1;2;3mb\x1b[0m\n");
	}

	#[test]
	fn ansi_materialization_round_trips_run_structure() {
		let mut first = RichText::default();
		decompose("a\x1b[3;48;5;12mb\n\x1b[9;94mc", &mut first);
		let mut ansi = String::new();
		first.replay(&mut ansi);
		let mut second = RichText::default();
		decompose(&ansi, &mut second);

		assert_eq!(texts(&first), texts(&second));
		for row in 0..RichText::rows(&first) {
			assert_eq!(
				first.row_runs(row).collect::<Vec<_>>(),
				second.row_runs(row).collect::<Vec<_>>()
			);
		}
	}

	#[test]
	fn decompose_strips_osc_and_non_sgr_csi() {
		let mut output = RichText::default();
		decompose("a\x1b]0;title\x07b\x1b[2Ac\x1b]ignored\x1b\\d", &mut output);
		assert_eq!(texts(&output), ["abcd"]);
	}

	#[test]
	fn decompose_measure_counts_only_visible_cells() {
		let mut measure = Measure::default();
		decompose("a\x1b[31m界\x1b[0m\x1b]0;title\x07\r\nxy\x1b[2A", &mut measure);
		assert_eq!(measure.rows, 2);
		assert_eq!(measure.widest, 3);
	}

	#[test]
	fn chains_row_limit_and_clipping() {
		let mut output = RichText::default();
		{
			let mut sink = (&mut output).rows(2).clip(3, Some('…'));
			for _ in 0..3 {
				sink.run(Style::new(), "abcdef");
				sink.newline();
			}
		}
		assert_eq!(texts(&output), ["ab…", "ab…"]);
	}

	#[test]
	fn tee_makes_identical_copies() {
		let mut forwarded = RichText::default();
		let mut copied = RichText::default();
		{
			let mut sink = (&mut forwarded).tee(&mut copied);
			sink.run(Style::new(), "one");
			sink.newline();
			sink.run(Style::new().bold(), "two");
		}
		assert_eq!(texts(&forwarded), texts(&copied));
		for row in 0..RichText::rows(&forwarded) {
			assert_eq!(
				forwarded.row_runs(row).collect::<Vec<_>>(),
				copied.row_runs(row).collect::<Vec<_>>()
			);
		}
	}

	#[test]
	fn prefixes_first_and_continuation_rows() {
		let mut first = Prefix::default();
		first.push(Style::new(), "> ");
		let mut cont = Prefix::default();
		cont.push(Style::new(), "  ");
		let mut output = RichText::default();
		{
			let mut sink = (&mut output).prefixed(&first, &cont);
			sink.run(Style::new(), "a");
			sink.newline();
			sink.run(Style::new(), "b");
		}
		assert_eq!(texts(&output), ["> a", "  b"]);
	}

	#[test]
	fn mid_word_overflow_records_soft_rows() {
		let mut output = RichText::default();
		let mut wrap = (&mut output).wrap(3);
		wrap.run(Style::new(), "abcdef gh");
		wrap.newline();
		assert_eq!(texts(&output), ["abc", "def", "gh"]);
		assert!(output.row_soft_wrap(0), "a width break inside a word is soft");
		assert!(!output.row_soft_wrap(1), "a word-boundary break collapsed whitespace");
		assert!(!output.row_soft_wrap(2));
	}

	#[test]
	fn prefixed_continuations_never_record_soft_rows() {
		let mut cont = Prefix::default();
		cont.push(Style::new(), "> ");
		let mut output = RichText::default();
		let mut wrap = (&mut output).wrap_prefixed(4, Prefix::empty_ref(), &cont);
		wrap.run(Style::new(), "abcdefgh");
		wrap.newline();
		assert!(RichText::rows(&output) > 1);
		assert!((0..RichText::rows(&output)).all(|row| !output.row_soft_wrap(row)));
	}

	#[test]
	fn char_wrap_flows_exact_and_preserves_whitespace() {
		let mut output = RichText::default();
		{
			let mut wrap = (&mut output).wrap_chars(3);
			wrap.run(Style::new(), "ab cdef");
		}
		assert_eq!(texts(&output), ["ab ", "cde", "f"]);
		assert!(output.row_soft_wrap(0) && output.row_soft_wrap(1));
	}

	#[test]
	fn replay_preserves_soft_rows() {
		let mut original = RichText::default();
		{
			let mut wrap = (&mut original).wrap_chars(3);
			wrap.run(Style::new(), "abcdef");
		}
		let mut copy = RichText::default();
		original.replay(&mut copy);
		assert_eq!(texts(&copy), texts(&original));
		assert!(copy.row_soft_wrap(0));
	}
	#[test]
	fn char_wrap_prefixed_preserves_leading_whitespace_and_hard_wraps() {
		let mut output = RichText::default();
		let mut first = Prefix::default();
		first.push(Style::new(), "> ");
		let mut cont = Prefix::default();
		cont.push(Style::new(), ". ");

		let mut wrap = (&mut output).wrap_chars_prefixed(5, &first, &cont);
		wrap.run(Style::new(), "   a");
		wrap.newline();

		assert_eq!(output.row_text(0), ">    ");
		assert_eq!(output.row_text(1), ". a");

		assert!(!output.row_soft_wrap(0));
	}

	#[test]
	fn char_wrap_prefixed_never_exceeds_requested_width() {
		let mut output = RichText::default();
		let mut first = Prefix::default();
		first.push(Style::new(), ">>>");
		let mut cont = Prefix::default();
		cont.push(Style::new(), "...");

		let mut wrap = (&mut output).wrap_chars_prefixed(2, &first, &cont);
		wrap.run(Style::new(), "abc");
		wrap.newline();

		assert_eq!(texts(&output), [">>"]);
	}

	#[test]
	fn restyle_composes_with_wrap() {
		let changed = Style::new().fg(Color::Indexed(4));
		let mut output = RichText::default();
		let mut wrap = (&mut output).restyle(|_| changed).wrap(3);
		wrap.run(Style::new(), "ab cd");
		wrap.newline();
		assert_eq!(texts(&output), ["ab", "cd"]);
		assert!(output.row_runs(0).all(|(style, _)| style == changed));
	}

	#[test]
	fn dynamic_sink_can_be_chained() {
		let mut output = RichText::default();
		let dynamic: &mut dyn RichSink = &mut output;
		{
			let mut sink = dynamic.rows(1).clip(2, None);
			sink.run(Style::new(), "abc");
			sink.newline();
		}
		assert_eq!(texts(&output), ["ab"]);
	}
	#[test]
	fn apc_sequences_occupy_zero_cells() {
		assert_eq!(cell_width("\x1b_Ga=p,U=1,i=7,p=7,c=9,r=4\x1b\\"), 0);
		assert_eq!(cell_width("x\x1b_cursor-marker\x07y"), 2);
		assert_eq!(cell_width("\x1b_Ga=p,i=1\x1b\\a\x1b_Ga=p,i=2\x1b\\b"), 2,);
	}

	#[test]
	fn jamo_profiles_filler_and_ambiguous_widths() {
		let original = jamo_width();
		let jamo = "ㅁㄴㅇㅂ";

		set_jamo_width(JamoWidth::Unicode);
		assert_eq!(cell_width(jamo), 8);
		assert_eq!(cell_width("\u{3164}"), 0);

		set_jamo_width(JamoWidth::Narrow);
		assert_eq!(cell_width(jamo), 4);
		assert_eq!(cell_width("\u{3164}"), 0);

		set_jamo_width(JamoWidth::Wide);
		assert_eq!(cell_width(jamo), 8);
		assert_eq!(cell_width("\u{3164}"), 0);

		set_jamo_width(JamoWidth::Platform);
		assert_eq!(cell_width(jamo), if cfg!(target_os = "macos") { 4 } else { 8 });
		assert_eq!(cell_width("\u{3164}"), 0);
		assert_eq!(cell_width("©"), 1, "East Asian Ambiguous characters stay narrow");

		set_jamo_width(original);
	}
}
