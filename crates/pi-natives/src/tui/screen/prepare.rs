//! Line preparation: one string projection of each frame row plus the
//! structured sidecar the frame writer needs to emit it.
//!
//! Preparing a row strips the sentinels that must never reach the terminal
//! (cursor markers, extension-link markers), normalizes and fits it to the
//! viewport width, classifies it (image row, OSC 8 hyperlinks, exact ASCII
//! width), and precomputes the bytes written for it. Rows are immutable and
//! shared: a row unchanged since the previous frame — at the same index or
//! scrolled to another — is reused instead of prepared again.

use std::{borrow::Cow, rc::Rc};

use foldhash::HashMap;
use memchr::memmem;

use super::{
	images::{KITTY_PLACEHOLDER_LEAD, has_image_marker_at, is_image_line, utf16_units_started},
	sgr::coalesce_adjacent_sgr,
	text::{
		ansi_sequence_end, normalize_terminal_output, strip_extension_link_markers,
		truncate_to_width, visible_width,
	},
};
use crate::{text::width_config_epoch, tui::types::ImageProtocol};

/// Cursor position marker — an APC (Application Program Command) sequence.
/// This is a zero-width escape sequence that terminals ignore. Components
/// emit this at the cursor position when focused; preparation finds and
/// strips it, and the frame writer positions the hardware cursor there.
pub(crate) const CURSOR_MARKER: &str = "\x1b_pi:c\x07";
/// Full-attribute reset terminating each rendered content row.
pub(crate) const SEGMENT_RESET: &str = "\x1b[0m";
/// Closes any in-flight OSC 8 hyperlink.
pub(crate) const HYPERLINK_CLOSE: &str = "\x1b]8;;\x07";

const ESC: u8 = 0x1b;

// Keep the common short-row path out of native width/truncation. Longer rows
// are fit by visible cells, not source code units, so zero-width-heavy prefixes
// cannot hide visible suffix text that still belongs in the viewport. The
// budgets count UTF-16 code units, as the component layer measures its rows.
const LINE_FIT_MIN_SOURCE_CODE_UNITS: usize = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS: usize = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER: usize = 64;

/// Where a frame row carried a [`CURSOR_MARKER`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Marker {
	/// Index of the row within the prepared lines.
	pub row: usize,
	/// Visible column of the row's first marker.
	pub col: u32,
}

/// One prepared frame row. A row is reusable only under identical raw
/// content, width, width configuration, and image protocol; those are every
/// mutable input to normalization, fitting, classification, and terminal
/// coalescing.
#[derive(Debug)]
pub(crate) struct PreparedLine {
	/// The source row (cursor markers stripped on a stripping pass).
	pub raw:              Rc<str>,
	/// Viewport width the row was fitted to.
	pub width:            u32,
	/// [`width_config_epoch`] when the row was measured.
	pub width_epoch:      u32,
	/// Image protocol the row was classified under.
	pub image_protocol:   Option<ImageProtocol>,
	/// The row as the frame model holds it: stripped, normalized, fitted.
	pub line:             Rc<str>,
	/// The bytes written for the row: `line` with adjacent SGR runs merged.
	pub terminal_content: Rc<str>,
	/// Exact width when the row is printable ASCII plus well-formed CSI/OSC.
	pub ascii_width:      Option<u32>,
	/// The row carries an image for `image_protocol`; it is written verbatim.
	pub is_image:         bool,
	/// The row opens an OSC 8 hyperlink, so its terminator must close it.
	pub has_osc8:         bool,
}

/// The prepared rows of one frame section.
#[derive(Debug, Default)]
pub(crate) struct Prepared {
	/// `rows[i].line`, for diffing and width queries.
	pub lines: Vec<Rc<str>>,
	pub rows:  Vec<Rc<PreparedLine>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LineClassification {
	ascii_width: Option<u32>,
	is_image:    bool,
	has_osc8:    bool,
}

/// Prepares frame rows, reusing the rows of earlier passes.
pub(crate) struct Preparer {
	image_protocol: Option<ImageProtocol>,
	sgr_coalesce:   bool,
	/// Rows of the previous stripping pass by raw content, so a scrolled row
	/// is not re-prepared.
	memo:           HashMap<Rc<str>, Rc<PreparedLine>>,
	/// The emptied index of the pass before, filled by the current stripping
	/// pass and then swapped with `memo`; neither map is reallocated per frame.
	spare:          HashMap<Rc<str>, Rc<PreparedLine>>,
}

impl Preparer {
	/// A preparer classifying image rows for `image_protocol`; `sgr_coalesce`
	/// merges adjacent SGR sequences in the written bytes
	/// (`Facts::sgr_coalesce`).
	pub(crate) fn new(image_protocol: Option<ImageProtocol>, sgr_coalesce: bool) -> Self {
		Self { image_protocol, sgr_coalesce, memo: HashMap::default(), spare: HashMap::default() }
	}

	/// Change the image protocol; rows prepared under another protocol are no
	/// longer reused.
	pub(crate) const fn set_image_protocol(&mut self, image_protocol: Option<ImageProtocol>) {
		self.image_protocol = image_protocol;
	}

	/// Prepare `length` rows of `lines` (missing rows are empty) for a
	/// `width`-column viewport. `previous` holds the rows last prepared for
	/// the same positions: the same row at the same index is checked first,
	/// then the previous stripping pass's rows by content.
	///
	/// With `markers`, every [`CURSOR_MARKER`] is stripped (markers are
	/// internal sentinels and must never reach the terminal) and the position
	/// of each row's first one recorded, bottom-most first; callers pick the
	/// visible one once the window top is known. Without it (history rows)
	/// lines are prepared verbatim. Every reusable entry holds a stripped raw
	/// line, so a row that matches one carries no marker and skips the marker
	/// scan.
	pub(crate) fn prepare_lines<S: AsRef<str>>(
		&mut self,
		lines: &[S],
		width: u32,
		previous: &[Rc<PreparedLine>],
		length: usize,
		mut markers: Option<&mut Vec<Marker>>,
	) -> Prepared {
		let width_epoch = width_config_epoch();
		// Only stripping passes index their rows: a verbatim history row may
		// keep a marker, and reusing it for a viewport row would leak that
		// marker.
		let stripping = markers.is_some();
		let mut prepared = Vec::with_capacity(length);
		let mut rows = Vec::with_capacity(length);
		for index in 0..length {
			let source = lines.get(index).map_or("", |line| line.as_ref());
			let positional = previous.get(index);
			let row = if let Some(row) = self.reusable(positional, source, width, width_epoch) {
				row
			} else {
				let stripped = markers
					.as_deref_mut()
					.and_then(|markers| strip_cursor_markers(source, index, markers));
				let raw = stripped.as_deref().unwrap_or(source);
				stripped
					.is_some()
					.then(|| self.reusable(positional, raw, width, width_epoch))
					.flatten()
					.unwrap_or_else(|| {
						Rc::new(prepare_line(
							raw,
							width,
							width_epoch,
							self.image_protocol,
							self.sgr_coalesce,
						))
					})
			};
			if stripping {
				self.spare.insert(Rc::clone(&row.raw), Rc::clone(&row));
			}
			prepared.push(Rc::clone(&row.line));
			rows.push(row);
		}
		if stripping {
			self.memo.clear();
			std::mem::swap(&mut self.memo, &mut self.spare);
		}
		if let Some(markers) = markers {
			markers.reverse();
		}
		Prepared { lines: prepared, rows }
	}

	fn reusable(
		&self,
		positional: Option<&Rc<PreparedLine>>,
		raw: &str,
		width: u32,
		width_epoch: u32,
	) -> Option<Rc<PreparedLine>> {
		let cached = match positional {
			Some(row) if *row.raw == *raw => row,
			_ => self.memo.get(raw)?,
		};
		(cached.width == width
			&& cached.width_epoch == width_epoch
			&& cached.image_protocol == self.image_protocol)
			.then(|| Rc::clone(cached))
	}
}

/// `source` without its cursor markers, recording the first one's column, or
/// `None` when it carries none.
fn strip_cursor_markers(source: &str, row: usize, markers: &mut Vec<Marker>) -> Option<String> {
	let marker = CURSOR_MARKER.as_bytes();
	let first = memmem::find(source.as_bytes(), marker)?;
	markers.push(Marker { row, col: visible_width(&source[..first]) });
	let mut raw = source.to_owned();
	let mut next = Some(first);
	while let Some(at) = next {
		// The marker is ASCII, so both ends of the cut are character boundaries.
		raw.replace_range(at..at + marker.len(), "");
		// Resume the search just before the splice so a marker that the
		// removal itself joins together is stripped too; reusable rows must
		// stay marker-free.
		let from = at.saturating_sub(marker.len() - 1);
		next = memmem::find(&raw.as_bytes()[from..], marker).map(|found| from + found);
	}
	Some(raw)
}

/// UTF-16 length of `text`.
fn utf16_len(text: &str) -> usize {
	text.bytes().map(utf16_units_started).sum()
}

/// `text` when it is the whole of `raw`, shared; otherwise a copy.
fn share(raw: &Rc<str>, text: &str) -> Rc<str> {
	if std::ptr::eq(text, &**raw) {
		Rc::clone(raw)
	} else {
		Rc::from(text)
	}
}

fn prepare_line(
	raw: &str,
	width: u32,
	width_epoch: u32,
	image_protocol: Option<ImageProtocol>,
	sgr_coalesce: bool,
) -> PreparedLine {
	let raw: Rc<str> = Rc::from(raw);
	let (line, classification) = fit_line(&raw, width, image_protocol);
	let terminal_content = if classification.is_image {
		Rc::clone(&line)
	} else {
		match coalesce_adjacent_sgr(&line, sgr_coalesce) {
			Cow::Borrowed(_) => Rc::clone(&line),
			Cow::Owned(merged) => Rc::from(merged),
		}
	};
	PreparedLine {
		raw,
		width,
		width_epoch,
		image_protocol,
		line,
		terminal_content,
		ascii_width: classification.ascii_width,
		is_image: classification.is_image,
		has_osc8: !classification.is_image && classification.has_osc8,
	}
}

/// The row as the frame model holds it, and its classification.
fn fit_line(
	raw: &Rc<str>,
	width: u32,
	image_protocol: Option<ImageProtocol>,
) -> (Rc<str>, LineClassification) {
	const IMAGE: LineClassification =
		LineClassification { ascii_width: None, is_image: true, has_osc8: false };
	let safe_width = width.max(1);
	let max_source_units = LINE_FIT_MAX_SOURCE_CODE_UNITS.min(
		LINE_FIT_MIN_SOURCE_CODE_UNITS
			.max((safe_width as usize).saturating_mul(LINE_FIT_SOURCE_WIDTH_MULTIPLIER)),
	);
	// Extension link markers exist only for hit-testing; the terminal must
	// never get an openable hyperlink. Strip before fitting (so a cut cannot
	// split one) and before classifying.
	let output = strip_extension_link_markers(raw);

	let fitted;
	let source: &str;
	let mut classification;
	// A UTF-8 string is never shorter than its UTF-16 form.
	if output.len() <= max_source_units || utf16_len(&output) <= max_source_units {
		// The overwhelmingly common path classifies image markers, OSC 8,
		// ANSI validity, OSC 66, non-ASCII, and exact ASCII width together.
		classification = classify_line(&output, safe_width, image_protocol);
		if classification.is_image {
			return (share(raw, &output), IMAGE);
		}
		source = &output;
	} else {
		// Fitting a giant source can discard everything after the visible
		// prefix. Preserve image rows verbatim first, but do not scan the
		// entire source for width/OSC metadata that will immediately vanish.
		if is_image_line(image_protocol, &output) {
			return (share(raw, &output), IMAGE);
		}
		fitted = line_fit_source(&output, safe_width, max_source_units);
		source = &fitted;
		// Fitting can move a marker from outside the raw scan window into the
		// prepared line's window, at which point terminal image dispatch owns
		// it.
		classification = classify_line(source, safe_width, image_protocol);
	}

	let normalized = normalize_terminal_output(source);
	// Normalization only decomposes Thai/Lao AM vowels. It cannot introduce
	// or remove ANSI/image markers, and such a row was already non-ASCII, so
	// the source classification remains exact when normalization allocates.
	let truncated;
	let mut line: &str = &normalized;
	if classification
		.ascii_width
		.unwrap_or_else(|| visible_width(&normalized))
		> width
	{
		truncated = truncate_to_width(&normalized, width);
		line = &truncated;
		classification = classify_line(line, safe_width, image_protocol);
	}
	(share(raw, line), classification)
}

/// A prefix of `raw` that covers `safe_width` visible cells within
/// `max_source_units` UTF-16 code units, terminated by a reset. CSI and OSC
/// sequences are dropped, except OSC 66 spans, whose payload is visible.
fn line_fit_source(raw: &str, safe_width: u32, max_source_units: usize) -> String {
	let bytes = raw.as_bytes();
	let safe_width = safe_width as usize;
	let mut output = String::new();
	// UTF-16 length of `output`.
	let mut units = 0usize;
	let mut cells = 0usize;
	let mut i = 0usize;
	while i < bytes.len() && cells < safe_width {
		let code = bytes[i];
		if code == ESC {
			let Some(end) = ansi_sequence_end(raw, i) else {
				break;
			};
			// OSC 66 (`ESC ] 66 ; META ; TEXT ESC \`) carries visible cells
			// inside the payload.
			if bytes[i + 1..].starts_with(b"]66;") {
				let sequence = &raw[i..end];
				let sequence_units = utf16_len(sequence);
				if units + sequence_units <= max_source_units {
					output.push_str(sequence);
					units += sequence_units;
					cells += visible_width(sequence) as usize;
				}
			}
			i = end;
			continue;
		}

		if (0x20..=0x7e).contains(&code) {
			// Printable-ASCII run: every char here is exactly one cell wide, so
			// the run is copied with a single slice instead of a per-char
			// slice + width call. Stop conditions mirror the general path:
			// width budget (cells), source budget (max_source_units).
			if units >= max_source_units {
				break;
			}
			let cap = i + (safe_width - cells).min(max_source_units - units);
			let mut j = i + 1;
			while j < bytes.len() && j < cap && (0x20..=0x7e).contains(&bytes[j]) {
				j += 1;
			}
			output.push_str(&raw[i..j]);
			cells += j - i;
			units += j - i;
			i = j;
			continue;
		}

		// Every arm above advances over whole characters, so `i` is a
		// character boundary.
		let Some(ch) = raw[i..].chars().next() else {
			break;
		};
		let next = i + ch.len_utf8();
		let char_units = ch.len_utf16();
		let char_width = visible_width(&raw[i..next]) as usize;
		if char_width > 0 && cells + char_width > safe_width {
			break;
		}
		if units + char_units > max_source_units {
			if char_width > 0 {
				break;
			}
			i = next;
			continue;
		}
		if char_width == 0 {
			// Zero-width characters may not eat the source budget the
			// remaining visible cells still need.
			let reserved_units = (safe_width - cells) * 2;
			if units + char_units > max_source_units.saturating_sub(reserved_units) {
				i = next;
				continue;
			}
		}
		output.push_str(&raw[i..next]);
		cells += char_width;
		units += char_units;
		i = next;
	}

	output.push_str(SEGMENT_RESET);
	output
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AnsiState {
	Text,
	Csi,
	Osc,
}

/// One pass classifies every per-row write decision. Image markers are
/// checked before ANSI state consumes their bytes, preserving the "marker
/// anywhere in the protocol window" behavior even inside malformed control
/// strings. Width saturates once it is known to exceed the viewport, while
/// the pass continues for image and OSC 8 markers.
fn classify_line(
	line: &str,
	max_width: u32,
	image_protocol: Option<ImageProtocol>,
) -> LineClassification {
	let bytes = line.as_bytes();
	let mut col = 0u32;
	let mut ascii = true;
	let mut has_osc8 = false;
	let mut state = AnsiState::Text;
	// UTF-16 offset of `bytes[i]`: the image-marker windows count code units.
	let mut unit = 0usize;
	let mut i = 0usize;
	while i < bytes.len() {
		let code = bytes[i];
		if (code == ESC || code == KITTY_PLACEHOLDER_LEAD)
			&& has_image_marker_at(image_protocol, bytes, i, unit)
		{
			return LineClassification { ascii_width: None, is_image: true, has_osc8 };
		}
		if code == ESC && bytes[i + 1..].starts_with(b"]8;") {
			has_osc8 = true;
		}
		unit += utf16_units_started(code);
		i += 1;

		match state {
			AnsiState::Csi => {
				if (0x40..=0x7e).contains(&code) {
					state = AnsiState::Text;
				}
			},
			AnsiState::Osc => {
				if code == 0x07 {
					state = AnsiState::Text;
				} else if code == ESC && bytes.get(i) == Some(&b'\\') {
					state = AnsiState::Text;
					i += 1;
					unit += 1;
				}
			},
			AnsiState::Text if code == ESC => match bytes.get(i) {
				Some(b'[') => {
					state = AnsiState::Csi;
					i += 1;
					unit += 1;
				},
				Some(b']') => {
					// OSC 66 text-sizing spans carry visible payload inside the
					// control string. Defer to `visible_width` for their scaled
					// cells.
					if bytes[i + 1..].starts_with(b"66;") {
						ascii = false;
					}
					state = AnsiState::Osc;
					i += 1;
					unit += 1;
				},
				_ => ascii = false,
			},
			AnsiState::Text => {
				if !(0x20..=0x7e).contains(&code) {
					ascii = false;
				} else if ascii && col <= max_width {
					col += 1;
				}
			},
		}
	}
	if state != AnsiState::Text {
		ascii = false;
	}
	LineClassification { ascii_width: ascii.then_some(col), is_image: false, has_osc8 }
}

#[cfg(test)]
mod tests {
	use super::*;

	fn preparer() -> Preparer {
		Preparer::new(None, true)
	}

	fn prepare_one(preparer: &mut Preparer, line: &str, width: u32) -> Rc<PreparedLine> {
		let mut prepared = preparer.prepare_lines(&[line], width, &[], 1, None);
		prepared.rows.remove(0)
	}

	fn classify(line: &str, max_width: u32) -> LineClassification {
		classify_line(line, max_width, None)
	}

	fn plain(ascii_width: Option<u32>, has_osc8: bool) -> LineClassification {
		LineClassification { ascii_width, is_image: false, has_osc8 }
	}

	// ------------------------------------------------------------------------
	// Classification
	// ------------------------------------------------------------------------

	#[test]
	fn classifies_ascii_rows_with_their_exact_width() {
		assert_eq!(classify("", 80), plain(Some(0), false));
		assert_eq!(classify("hello world", 80), plain(Some(11), false));
		// Well-formed CSI and OSC sequences are zero cells.
		assert_eq!(classify("\x1b[1;31mred\x1b[0m \x1b[Kx", 80), plain(Some(5), false));
		assert_eq!(classify("\x1b]0;title\x07ab\x1b]0;t\x1b\\c", 80), plain(Some(3), false));
	}

	#[test]
	fn ascii_width_saturates_just_past_the_viewport() {
		let row = "x".repeat(200);
		assert_eq!(classify(&row, 80), plain(Some(81), false));
		assert_eq!(classify(&row, 200), plain(Some(200), false));
	}

	#[test]
	fn rows_the_ascii_model_cannot_measure_have_no_width() {
		// Non-ASCII text, control characters, and tabs.
		assert_eq!(classify("│ box", 80), plain(None, false));
		assert_eq!(classify("a\tb", 80), plain(None, false));
		assert_eq!(classify("a\x7fb", 80), plain(None, false));
		// Escapes other than CSI/OSC, and sequences that never terminate.
		assert_eq!(classify("\x1b7saved", 80), plain(None, false));
		assert_eq!(classify("ab\x1b_pi:c\x07", 80), plain(None, false));
		assert_eq!(classify("text\x1b[38;5", 80), plain(None, false));
		assert_eq!(classify("text\x1b]0;title", 80), plain(None, false));
		assert_eq!(classify("text\x1b", 80), plain(None, false));
		// OSC 66 spans carry visible, scaled payload.
		assert_eq!(classify("\x1b]66;s=2;Title\x1b\\", 80), plain(None, false));
	}

	#[test]
	fn finds_hyperlinks_wherever_they_open() {
		assert_eq!(classify("\x1b]8;;https://x\x07link\x1b]8;;\x07", 80), plain(Some(4), true));
		assert_eq!(classify("\x1b]8;id=1;https://x\x1b\\中\x1b]8;;\x1b\\", 80), plain(None, true));
		// OSC 8 is recognized by its introducer only.
		assert_eq!(classify("\x1b]80;x\x07", 80), plain(Some(0), false));
		assert_eq!(classify("\x1b]9;4;3\x07", 80), plain(Some(0), false));
	}

	#[test]
	fn image_markers_win_over_every_other_property() {
		let kitty = Some(ImageProtocol::Kitty);
		let image = LineClassification { ascii_width: None, is_image: true, has_osc8: false };
		assert_eq!(classify_line("\x1b7\x1b[3A\x1b_Ga=p,i=1\x1b\\\x1b8", 80, kitty), image);
		assert_eq!(classify_line("\x1b[38;5;1m\u{10eeee}\u{305}\x1b[39m", 80, kitty), image);
		// A marker inside a malformed control string still counts.
		assert_eq!(classify_line("\x1b]0;title \x1b_Ga=p,i=1\x1b\\", 80, kitty), image);
		// Hyperlinks seen before the marker are reported with it.
		assert_eq!(classify_line("\x1b]8;;u\x07x\x1b_Ga=p\x1b\\", 80, kitty), LineClassification {
			has_osc8: true,
			..image
		});
		// Without the protocol, the same bytes are an unmeasurable text row.
		assert_eq!(classify("\x1b_Ga=p,i=1\x1b\\", 80), plain(None, false));
		assert_eq!(
			classify_line("\x1bP0;1;0q\"1;1;2;6~\x1b\\", 80, Some(ImageProtocol::Sixel)),
			image
		);
		// Past the marker window the row is text.
		let far = format!("{}\x1b_Ga=p\x1b\\", "x".repeat(600));
		assert!(!classify_line(&far, 80, kitty).is_image);
	}

	// ------------------------------------------------------------------------
	// Preparation
	// ------------------------------------------------------------------------

	#[test]
	fn a_row_that_fits_shares_one_string() {
		let row = prepare_one(&mut preparer(), "\x1b[1mhello\x1b[0m", 80);
		assert_eq!(&*row.line, "\x1b[1mhello\x1b[0m");
		assert!(Rc::ptr_eq(&row.raw, &row.line));
		assert!(Rc::ptr_eq(&row.line, &row.terminal_content));
		assert_eq!(row.ascii_width, Some(5));
		assert_eq!((row.width, row.is_image, row.has_osc8), (80, false, false));
		assert_eq!(row.width_epoch, width_config_epoch());
	}

	#[test]
	fn terminal_content_merges_adjacent_sgr_but_the_line_does_not() {
		let source = "a\x1b[39m\x1b[38;2;1;2;3mb";
		let row = prepare_one(&mut preparer(), source, 80);
		assert_eq!(&*row.line, source);
		assert_eq!(&*row.terminal_content, "a\x1b[39;38;2;1;2;3mb");
		let verbatim = prepare_one(&mut Preparer::new(None, false), source, 80);
		assert!(Rc::ptr_eq(&verbatim.line, &verbatim.terminal_content));
	}

	#[test]
	fn over_wide_rows_are_truncated_to_the_viewport() {
		let mut preparer = preparer();
		let ascii = prepare_one(&mut preparer, "\x1b[31mabcdefghij\x1b[0m", 4);
		assert_eq!(&*ascii.line, "\x1b[31mabcd\x1b[0m");
		assert_eq!(ascii.ascii_width, Some(4));
		assert_eq!(&*ascii.raw, "\x1b[31mabcdefghij\x1b[0m");

		let wide = prepare_one(&mut preparer, "中文字符", 5);
		assert_eq!(&*wide.line, "中文");
		assert_eq!(wide.ascii_width, None);

		// An exactly full row is left alone.
		let full = prepare_one(&mut preparer, "abcd", 4);
		assert!(Rc::ptr_eq(&full.raw, &full.line));
		assert_eq!(full.ascii_width, Some(4));

		// A zero-width viewport keeps no visible cell.
		let none = prepare_one(&mut preparer, "abc", 0);
		assert_eq!(&*none.line, "");
	}

	#[test]
	fn thai_and_lao_am_vowels_are_decomposed() {
		let row = prepare_one(&mut preparer(), "น\u{0e33} \x1b[1mx\x1b[0m", 80);
		assert_eq!(&*row.line, "น\u{0e4d}\u{0e32} \x1b[1mx\x1b[0m");
		assert_eq!(&*row.raw, "น\u{0e33} \x1b[1mx\x1b[0m");
		assert_eq!(row.ascii_width, None);
	}

	#[test]
	fn extension_link_markers_never_reach_the_terminal() {
		let source = "see \x1b]8;id=omp-extension-link-3;demo:open\x07label\x1b]8;;\x07 now";
		let row = prepare_one(&mut preparer(), source, 80);
		assert_eq!(&*row.line, "see label now");
		assert_eq!(&*row.terminal_content, "see label now");
		assert!(!row.has_osc8);
		assert_eq!(row.ascii_width, Some(13));
		// The raw row keeps the marker: it is the reuse key.
		assert_eq!(&*row.raw, source);

		let foreign = "\x1b]8;;https://example.com\x07docs\x1b]8;;\x07";
		let row = prepare_one(&mut preparer(), foreign, 80);
		assert_eq!(&*row.line, foreign);
		assert!(row.has_osc8);
	}

	#[test]
	fn image_rows_are_kept_verbatim() {
		let mut preparer = Preparer::new(Some(ImageProtocol::Kitty), true);
		let placement = "\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=5,p=5,c=400,r=4\x1b\\\x1b8";
		let row = prepare_one(&mut preparer, placement, 10);
		assert!(row.is_image);
		assert!(Rc::ptr_eq(&row.raw, &row.line));
		assert!(Rc::ptr_eq(&row.line, &row.terminal_content));
		assert_eq!((row.ascii_width, row.has_osc8), (None, false));
		assert_eq!(row.image_protocol, Some(ImageProtocol::Kitty));

		// A payload far past the fit budget is still an image row, not a
		// truncated one.
		let payload = format!("\x1b_Gf=100,a=T;{}\x1b\\", "A".repeat(100_000));
		let row = prepare_one(&mut preparer, &payload, 10);
		assert!(row.is_image);
		assert_eq!(row.line.len(), payload.len());

		// Without the protocol the same row is text and is cut to the viewport.
		let text = prepare_one(&mut Preparer::new(None, true), placement, 10);
		assert!(!text.is_image);
	}

	// ------------------------------------------------------------------------
	// Giant sources
	// ------------------------------------------------------------------------

	#[test]
	fn giant_ascii_rows_are_fit_by_cells() {
		let source = "x".repeat(100_000);
		let row = prepare_one(&mut preparer(), &source, 80);
		assert_eq!(&*row.line, format!("{}\x1b[0m", "x".repeat(80)));
		assert_eq!(row.ascii_width, Some(80));
		assert_eq!(row.raw.len(), 100_000);
	}

	#[test]
	fn fit_budget_grows_with_the_viewport_and_counts_code_units() {
		// 64 code units per column, at least 4096 and at most 65536.
		let styled = "\x1b[38;2;1;2;3mx".repeat(400);
		assert!(styled.len() > 4096 && styled.len() <= 100 * 64);
		// Within the budget the row keeps its styling and is truncated by width.
		let wide = prepare_one(&mut preparer(), &styled, 100);
		assert!(wide.line.starts_with("\x1b[38;2;1;2;3mx\x1b[38;2;1;2;3mx"));
		assert_eq!(visible_width(&wide.line), 100);
		// Past it the fit drops the escapes and keeps the visible cells.
		let narrow = prepare_one(&mut preparer(), &styled, 40);
		assert_eq!(&*narrow.line, format!("{}\x1b[0m", "x".repeat(40)));

		// 3000 box-drawing characters are 9000 bytes but 3000 code units.
		let boxes = "─".repeat(3000);
		let row = prepare_one(&mut preparer(), &boxes, 20);
		assert_eq!(&*row.line, "─".repeat(20));
	}

	#[test]
	fn zero_width_heavy_prefixes_cannot_hide_visible_text() {
		// More zero-width characters (combining accents) than the whole
		// source budget, then text.
		let source = format!("{}visible", "\u{301}".repeat(10_000));
		let fitted = line_fit_source(&source, 80, 4096);
		assert!(fitted.ends_with("visible\x1b[0m"));
		// Zero-width characters fill the budget only up to the reserve kept
		// for the remaining cells: two code units per column.
		assert_eq!(utf16_len(&fitted), (4096 - 80 * 2) + "visible".len() + SEGMENT_RESET.len());
	}

	#[test]
	fn fitting_keeps_text_sizing_spans_and_stops_at_the_width() {
		let span = "\x1b]66;s=2;Head\x1b\\";
		let fitted = line_fit_source(&format!("\x1b[1m{span}tail{}", "x".repeat(50)), 12, 4096);
		// The SGR is dropped, the span kept (8 cells), then 4 more cells.
		assert_eq!(fitted, format!("{span}tail\x1b[0m"));
		// A wide character that would overflow the last cell ends the fit.
		assert_eq!(line_fit_source("ab中文字", 5, 4096), "ab中\x1b[0m");
		// An unterminated escape ends the fit.
		assert_eq!(line_fit_source("ab\x1b[38;5", 80, 4096), "ab\x1b[0m");
		// Tabs keep their display width.
		assert_eq!(line_fit_source("a\tbcdef", 6, 4096), "a\tbc\x1b[0m");
	}

	#[test]
	fn fitting_respects_the_source_budget() {
		// Visible text stops at the budget.
		assert_eq!(line_fit_source(&"x".repeat(100), 80, 16), format!("{}\x1b[0m", "x".repeat(16)));
		assert_eq!(line_fit_source(&"中".repeat(100), 80, 5), "中中中中中\x1b[0m");
		// A span that does not fit the budget is skipped whole.
		assert_eq!(line_fit_source("ab\x1b]66;s=2;Heading\x1b\\cd", 80, 8), "abcd\x1b[0m");
	}

	// ------------------------------------------------------------------------
	// Cursor markers
	// ------------------------------------------------------------------------

	#[test]
	fn cursor_markers_are_stripped_and_reported_bottom_most_first() {
		let mut preparer = preparer();
		let lines = [
			format!("ab{CURSOR_MARKER}cd"),
			"plain".to_owned(),
			format!("\x1b[1m中文\x1b[0m{CURSOR_MARKER}"),
		];
		let mut markers = Vec::new();
		let prepared = preparer.prepare_lines(&lines, 80, &[], 3, Some(&mut markers));
		assert_eq!(
			prepared
				.lines
				.iter()
				.map(|line| &**line)
				.collect::<Vec<_>>(),
			["abcd", "plain", "\x1b[1m中文\x1b[0m"]
		);
		assert_eq!(markers, [Marker { row: 2, col: 4 }, Marker { row: 0, col: 2 }]);
		assert_eq!(&*prepared.rows[0].raw, "abcd");
	}

	#[test]
	fn a_row_records_only_its_first_marker_and_loses_them_all() {
		let mut preparer = preparer();
		let half = &CURSOR_MARKER[..4];
		let rest = &CURSOR_MARKER[4..];
		// Removing the inner marker joins the halves around it into another.
		let lines = [format!("a{CURSOR_MARKER}b{half}{CURSOR_MARKER}{rest}c{CURSOR_MARKER}")];
		let mut markers = Vec::new();
		let prepared = preparer.prepare_lines(&lines, 80, &[], 1, Some(&mut markers));
		assert_eq!(&*prepared.lines[0], "abc");
		assert_eq!(markers, [Marker { row: 0, col: 1 }]);
	}

	#[test]
	fn verbatim_passes_keep_markers_and_are_not_indexed() {
		let mut preparer = preparer();
		let line = format!("ab{CURSOR_MARKER}cd");
		let history = preparer.prepare_lines(&[&line], 80, &[], 1, None);
		assert_eq!(&*history.lines[0], line);
		// A later stripping pass does not find the verbatim row by content.
		let mut markers = Vec::new();
		let viewport = preparer.prepare_lines(&[&line], 80, &[], 1, Some(&mut markers));
		assert_eq!(&*viewport.lines[0], "abcd");
		assert_eq!(markers.len(), 1);
	}

	// ------------------------------------------------------------------------
	// Reuse
	// ------------------------------------------------------------------------

	#[test]
	fn unchanged_rows_are_reused_by_position() {
		let mut preparer = preparer();
		let lines = ["one", "two", "three"];
		let first = preparer.prepare_lines(&lines, 80, &[], 3, None);
		let second = preparer.prepare_lines(&["one", "TWO", "three"], 80, &first.rows, 3, None);
		assert!(Rc::ptr_eq(&first.rows[0], &second.rows[0]));
		assert!(!Rc::ptr_eq(&first.rows[1], &second.rows[1]));
		assert!(Rc::ptr_eq(&first.rows[2], &second.rows[2]));
		assert!(Rc::ptr_eq(&first.lines[0], &second.lines[0]));
	}

	#[test]
	fn scrolled_rows_are_reused_by_content_after_a_stripping_pass() {
		let mut preparer = preparer();
		let first =
			preparer.prepare_lines(&["one", "two", "three"], 80, &[], 3, Some(&mut Vec::new()));
		let second = preparer.prepare_lines(
			&["two", "three", "four"],
			80,
			&first.rows,
			3,
			Some(&mut Vec::new()),
		);
		assert!(Rc::ptr_eq(&first.rows[1], &second.rows[0]));
		assert!(Rc::ptr_eq(&first.rows[2], &second.rows[1]));
		// The index holds one pass only: a row gone for a frame is prepared
		// again.
		let third = preparer.prepare_lines(&["one"], 80, &[], 1, Some(&mut Vec::new()));
		assert!(!Rc::ptr_eq(&first.rows[0], &third.rows[0]));
	}

	#[test]
	fn a_marker_row_reuses_its_stripped_predecessor() {
		let mut preparer = preparer();
		let mut markers = Vec::new();
		let first = preparer.prepare_lines(&["abcd"], 80, &[], 1, Some(&mut markers));
		assert!(markers.is_empty());
		// The cursor arrives on a row whose stripped content was just painted.
		let line = format!("ab{CURSOR_MARKER}cd");
		let second = preparer.prepare_lines(&[&line], 80, &first.rows, 1, Some(&mut markers));
		assert!(Rc::ptr_eq(&first.rows[0], &second.rows[0]));
		assert_eq!(markers, [Marker { row: 0, col: 2 }]);
	}

	#[test]
	fn width_and_image_protocol_changes_invalidate_reuse() {
		let mut preparer = preparer();
		let first = preparer.prepare_lines(&["row"], 80, &[], 1, Some(&mut Vec::new()));
		let resized = preparer.prepare_lines(&["row"], 100, &first.rows, 1, Some(&mut Vec::new()));
		assert!(!Rc::ptr_eq(&first.rows[0], &resized.rows[0]));
		assert_eq!(resized.rows[0].width, 100);

		preparer.set_image_protocol(Some(ImageProtocol::Sixel));
		let switched = preparer.prepare_lines(&["row"], 100, &resized.rows, 1, Some(&mut Vec::new()));
		assert!(!Rc::ptr_eq(&resized.rows[0], &switched.rows[0]));
		assert_eq!(switched.rows[0].image_protocol, Some(ImageProtocol::Sixel));
	}

	#[test]
	fn missing_rows_are_prepared_as_blank() {
		let mut preparer = preparer();
		let prepared = preparer.prepare_lines(&["only"], 80, &[], 3, None);
		assert_eq!(prepared.lines.len(), 3);
		assert_eq!(&*prepared.lines[1], "");
		assert_eq!(prepared.rows[2].ascii_width, Some(0));
		// A shorter length prepares a prefix.
		let prefix = preparer.prepare_lines(&["a", "b", "c"], 80, &[], 2, None);
		assert_eq!(prefix.rows.len(), 2);
	}
}
