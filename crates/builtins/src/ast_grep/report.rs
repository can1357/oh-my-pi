//! Self-contained renderer for `ast-grep`'s non-JSON `scan` diagnostics.
//!
//! `ast-grep` prints rule violations with a rich terminal diagnostic renderer.
//! This module reproduces that renderer's observable (uncolored) output so
//! `omp-builtins` no longer depends on the original crate: [`emit`] writes a
//! header, source snippets with carets and multi-line underlines, and notes for
//! a single file.

use core::{cmp, fmt, ops::Range};
use std::{collections::BTreeMap, io};

use core::fmt::Write as _;

/// How much of a diagnostic to render.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DisplayStyle {
	/// Rich rendering with source previews.
	Rich,
	/// Condensed rendering: located header plus notes.
	Medium,
	/// Short rendering: located header only.
	Short,
}

/// The severity level of a diagnostic.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
	/// A help message.
	Help,
	/// A note.
	Note,
	/// A warning.
	Warning,
	/// An error.
	Error,
}

/// A labeled region of the source text.
pub struct Label {
	/// The byte range in the source text that the label covers.
	pub range: Range<usize>,
	/// Whether this is the primary label of the diagnostic.
	pub primary: bool,
	/// An optional message for the underlined region.
	pub message: String,
}

/// One diagnostic to render for a single file.
pub struct Report<'a> {
	/// The user-facing file name shown in the locus header.
	pub file_name: &'a str,
	/// The full source text of the file.
	pub source: &'a str,
	/// The overall severity of the diagnostic.
	pub severity: Severity,
	/// The rule id shown in `[brackets]` after the severity.
	pub code: &'a str,
	/// The diagnostic message.
	pub message: &'a str,
	/// Additional notes shown below the snippet.
	pub notes: &'a [String],
	/// The labeled regions to underline.
	pub labels: &'a [Label],
	/// Which rendering to produce.
	pub display_style: DisplayStyle,
	/// Minimum number of lines shown after a multi-line label starts.
	pub start_context_lines: usize,
	/// Minimum number of lines shown before a multi-line label ends.
	pub end_context_lines: usize,
}

/// Renders `report` into `out`, matching the plain terminal output format.
pub fn emit(out: &mut dyn io::Write, report: &Report<'_>) -> io::Result<()> {
	let mut buffer = String::new();
	match report.display_style {
		DisplayStyle::Rich => render_rich(&mut buffer, report),
		DisplayStyle::Medium => render_short(&mut buffer, report, true),
		DisplayStyle::Short => render_short(&mut buffer, report, false),
	}
	.expect("writing into a String cannot fail");
	out.write_all(buffer.as_bytes())
}

// Box-drawing characters used by the default terminal character set.
const SNIPPET_START: &str = "┌─";
const SOURCE_BORDER_LEFT: char = '│';
const SOURCE_BORDER_LEFT_BREAK: char = '·';
const NOTE_BULLET: char = '=';
const SINGLE_PRIMARY_CARET: char = '^';
const SINGLE_SECONDARY_CARET: char = '-';
const MULTI_PRIMARY_CARET: char = '^';
const MULTI_SECONDARY_CARET: char = '\'';
const MULTI_TOP_LEFT: char = '╭';
const MULTI_TOP: char = '─';
const MULTI_BOTTOM_LEFT: char = '╰';
const MULTI_BOTTOM: char = '─';
const MULTI_LEFT: char = '│';
const POINTER_LEFT: char = '│';
/// Column width used when expanding tab characters.
const TAB_WIDTH: usize = 4;

/// The style of a label: primary labels outrank secondary ones.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum LabelStyle {
	Secondary,
	Primary,
}

/// A single-line label: style, column range, message.
type SingleSpan = (LabelStyle, Range<usize>, String);

/// A multi-line label segment on one source line.
enum MultiSpan {
	/// Start of a label on this line, at the given column.
	Top(usize),
	/// Continuation of a label through this line.
	Left,
	/// End of a label on this line, at the given column, with a message.
	Bottom(usize, String),
}

/// A source line together with the labels that apply to it.
struct LinePlan {
	number: usize,
	range: Range<usize>,
	single: Vec<SingleSpan>,
	multi: Vec<(usize, LabelStyle, MultiSpan)>,
	must_render: bool,
}

/// A character with its byte index and rendered column width.
struct Metric {
	byte_index: usize,
	width: usize,
	ch: char,
	len: usize,
}

/// The severity keyword used in the header.
fn severity_name(severity: Severity) -> &'static str {
	match severity {
		Severity::Error => "error",
		Severity::Warning => "warning",
		Severity::Note => "note",
		Severity::Help => "help",
	}
}

/// The number of decimal digits in `n`.
fn count_digits(n: usize) -> usize {
	if n == 0 { 1 } else { n.ilog10() as usize + 1 }
}

/// Whether two byte ranges overlap.
fn is_overlapping(a: &Range<usize>, b: &Range<usize>) -> bool {
	cmp::max(a.start, b.start) < cmp::min(a.end, b.end)
}

/// Priority of a label style, used to pick the caret when styles overlap.
fn label_priority(style: LabelStyle) -> u8 {
	match style {
		LabelStyle::Secondary => 0,
		LabelStyle::Primary => 1,
	}
}

/// Per-character metrics for a rendered source line.
fn char_metrics(source: &str) -> Vec<Metric> {
	let mut column = 0;
	source
		.char_indices()
		.map(|(byte_index, ch)| {
			let width = match ch {
				'\t' => TAB_WIDTH - (column % TAB_WIDTH),
				_ => xutf::width_char(ch),
			};
			column += width;
			Metric {
				byte_index,
				width,
				ch,
				len: ch.len_utf8(),
			}
		})
		.collect()
}

/// The starting byte index of every line in `source`.
fn line_starts(source: &str) -> Vec<usize> {
	core::iter::once(0).chain(source.match_indices('\n').map(|(i, _)| i + 1)).collect()
}

/// The line index containing `byte_index`.
fn line_index(starts: &[usize], byte_index: usize) -> usize {
	starts.binary_search(&byte_index).unwrap_or_else(|next| next - 1)
}

/// The byte range of line `index`, or `None` when out of bounds.
fn line_range(starts: &[usize], source: &str, index: usize) -> Option<Range<usize>> {
	Some(line_start(starts, source, index)?..line_start(starts, source, index + 1)?)
}

/// The start byte index of line `index`, or `None` when out of bounds.
fn line_start(starts: &[usize], source: &str, index: usize) -> Option<usize> {
	match index.cmp(&starts.len()) {
		cmp::Ordering::Less => Some(starts[index]),
		cmp::Ordering::Equal => Some(source.len()),
		cmp::Ordering::Greater => None,
	}
}

/// The 1-based column number of `byte_index` within `line`.
fn column_number(source: &str, line: &Range<usize>, byte_index: usize) -> usize {
	let end = cmp::min(byte_index, cmp::min(line.end, source.len()));
	(line.start..end)
		.filter(|&i| source.is_char_boundary(i + 1))
		.count()
}

/// Renders the diagnostic header (optionally with a locus).
fn render_header(
	out: &mut String,
	locus: Option<(&str, usize, usize)>,
	severity: Severity,
	code: &str,
	message: &str,
) -> fmt::Result {
	if let Some((name, line, column)) = locus {
		write!(out, "{name}:{line}:{column}: ")?;
	}
	write!(out, "{}", severity_name(severity))?;
	if !code.is_empty() {
		write!(out, "[{code}]")?;
	}
	writeln!(out, ": {message}")
}

/// Renders an empty string of `outer_padding` spaces followed by a space.
fn outer_gutter(out: &mut String, outer_padding: usize) -> fmt::Result {
	write!(out, "{: >1$} ", "", outer_padding)
}

/// Renders a right-aligned line number in the outer gutter.
fn outer_gutter_number(out: &mut String, line_number: usize, outer_padding: usize) -> fmt::Result {
	write!(out, "{line_number: >outer_padding$} ")
}

/// Renders the left source border.
fn border_left(out: &mut String, broken: bool) -> fmt::Result {
	let ch = if broken { SOURCE_BORDER_LEFT_BREAK } else { SOURCE_BORDER_LEFT };
	write!(out, "{ch}")
}

/// Renders an empty inner gutter column.
fn inner_gutter_space(out: &mut String) -> fmt::Result {
	write!(out, "  ")
}

/// Renders an inner gutter column, continuing an underline if active.
fn inner_gutter_column(out: &mut String, underline: Option<LabelStyle>) -> fmt::Result {
	match underline {
		None => write!(out, "  "),
		Some(_) => write!(out, "{MULTI_TOP}{MULTI_TOP}"),
	}
}

/// Renders the left of a multi-line label, optionally continuing an underline.
fn label_multi_left(out: &mut String, underline: Option<LabelStyle>) -> fmt::Result {
	match underline {
		None => write!(out, " ")?,
		Some(_) => write!(out, "{MULTI_TOP}")?,
	}
	write!(out, "{MULTI_LEFT}")
}

/// Renders the inner gutter for every multi-line label column.
fn inner_gutter(
	out: &mut String,
	num_multi: usize,
	multi: &[(usize, LabelStyle, MultiSpan)],
) -> fmt::Result {
	let mut iter = multi.iter().peekable();
	for column in 0..num_multi {
		match iter.peek() {
			Some((index, _, label)) if *index == column => {
				match label {
					MultiSpan::Left | MultiSpan::Bottom(..) => label_multi_left(out, None)?,
					MultiSpan::Top(..) => inner_gutter_space(out)?,
				}
				iter.next();
			},
			Some(_) | None => inner_gutter_space(out)?,
		}
	}
	Ok(())
}

/// Renders an empty source line.
fn render_snippet_empty(
	out: &mut String,
	outer_padding: usize,
	num_multi: usize,
	multi: &[(usize, LabelStyle, MultiSpan)],
) -> fmt::Result {
	outer_gutter(out, outer_padding)?;
	border_left(out, false)?;
	inner_gutter(out, num_multi, multi)?;
	writeln!(out)
}

/// Renders a broken source line marking skipped lines.
fn render_snippet_break(
	out: &mut String,
	outer_padding: usize,
	num_multi: usize,
	multi: &[(usize, LabelStyle, MultiSpan)],
) -> fmt::Result {
	outer_gutter(out, outer_padding)?;
	border_left(out, true)?;
	inner_gutter(out, num_multi, multi)?;
	writeln!(out)
}

/// Renders the top-left border and locus of a snippet.
fn render_snippet_start(
	out: &mut String,
	outer_padding: usize,
	name: &str,
	line: usize,
	column: usize,
) -> fmt::Result {
	outer_gutter(out, outer_padding)?;
	writeln!(out, "{SNIPPET_START} {name}:{line}:{column}")
}

/// Renders a note, wrapping continuation lines in the outer gutter.
fn render_snippet_note(out: &mut String, outer_padding: usize, message: &str) -> fmt::Result {
	for (index, line) in message.lines().enumerate() {
		outer_gutter(out, outer_padding)?;
		if index == 0 {
			write!(out, "{NOTE_BULLET}")?;
		} else {
			write!(out, " ")?;
		}
		writeln!(out, " {line}")?;
	}
	Ok(())
}

/// Renders the carets and hanging messages of single-line labels.
fn caret_pointers(
	out: &mut String,
	max_label_start: usize,
	single: &[SingleSpan],
	trailing: Option<usize>,
	metrics: &[Metric],
) -> fmt::Result {
	for m in metrics {
		let column = m.byte_index..(m.byte_index + m.len);
		let style = hanging_labels(single, trailing)
			.filter(|(_, range, _)| column.contains(&range.start))
			.map(|(style, _, _)| *style)
			.max_by_key(|&style| label_priority(style));
		if style.is_some() {
			write!(out, "{POINTER_LEFT}")?;
		}
		if m.byte_index <= max_label_start {
			let spaces = match style {
				None => 0..m.width,
				Some(_) => 1..m.width,
			};
			for _ in spaces {
				write!(out, " ")?;
			}
		}
	}
	Ok(())
}

/// The labels that need a hanging message rendered beneath the carets.
fn hanging_labels(single: &[SingleSpan], trailing: Option<usize>) -> impl Iterator<Item = &SingleSpan> {
	single
		.iter()
		.enumerate()
		.filter(|(_, (_, _, message))| !message.is_empty())
		.filter(move |(index, _)| trailing.is_none_or(|t| *index != t))
		.map(|(_, label)| label)
}

/// Renders one source line with its single-line and multi-line labels.
fn render_snippet_source(
	out: &mut String,
	outer_padding: usize,
	line_number: usize,
	source: &str,
	single: &[SingleSpan],
	num_multi: usize,
	multi: &[(usize, LabelStyle, MultiSpan)],
) -> fmt::Result {
	let source = source.trim_end_matches(['\n', '\r', '\0'].as_ref());
	let leading = source.len() - source.trim_start().len();

	// Source line with the multi-line gutter on its left.
	outer_gutter_number(out, line_number, outer_padding)?;
	border_left(out, false)?;
	let mut iter = multi.iter().peekable();
	for column in 0..num_multi {
		match iter.peek() {
			Some((index, _, label)) if *index == column => {
				match label {
					MultiSpan::Top(start) if *start <= leading => write!(out, " {MULTI_TOP_LEFT}")?,
					MultiSpan::Top(..) => write!(out, "  ")?,
					MultiSpan::Left | MultiSpan::Bottom(..) => write!(out, " {MULTI_LEFT}")?,
				}
				iter.next();
			},
			Some(_) | None => write!(out, "  ")?,
		}
	}
	write!(out, " ")?;
	for m in char_metrics(source) {
		match m.ch {
			'\t' => {
				for _ in 0..m.width {
					write!(out, " ")?;
				}
			},
			_ => write!(out, "{}", m.ch)?,
		}
	}
	writeln!(out)?;

	// Single-line labels under the source line.
	if !single.is_empty() {
		let mut num_messages = 0;
		let mut max_label_start = 0;
		let mut max_label_end = 0;
		let mut trailing = None;
		for (index, (_, range, message)) in single.iter().enumerate() {
			if !message.is_empty() {
				num_messages += 1;
			}
			max_label_start = cmp::max(max_label_start, range.start);
			max_label_end = cmp::max(max_label_end, range.end);
			if range.end == max_label_end {
				trailing = if message.is_empty() { None } else { Some(index) };
			}
		}
		if let Some(index) = trailing {
			let range = &single[index].1;
			let overlaps = single
				.iter()
				.enumerate()
				.filter(|(other, _)| *other != index)
				.any(|(_, (_, other, _))| is_overlapping(range, other));
			if overlaps {
				trailing = None;
			}
		}

		// Caret line.
		outer_gutter(out, outer_padding)?;
		border_left(out, false)?;
		inner_gutter(out, num_multi, multi)?;
		write!(out, " ")?;
		let mut metrics = char_metrics(source);
		metrics.push(Metric {
			byte_index: source.len(),
			width: 1,
			ch: '\0',
			len: 1,
		});
		for m in &metrics {
			let column = m.byte_index..(m.byte_index + m.len);
			let style = single
				.iter()
				.filter(|(_, range, _)| is_overlapping(range, &column))
				.map(|(style, _, _)| *style)
				.max_by_key(|&style| label_priority(style));
			let caret = match style {
				Some(LabelStyle::Primary) => Some(SINGLE_PRIMARY_CARET),
				Some(LabelStyle::Secondary) => Some(SINGLE_SECONDARY_CARET),
				None if m.byte_index < max_label_end => Some(' '),
				None => None,
			};
			if let Some(ch) = caret {
				for _ in 0..m.width {
					write!(out, "{ch}")?;
				}
			}
		}
		if let Some(index) = trailing {
			write!(out, " {}", single[index].2)?;
		}
		writeln!(out)?;

		// Hanging messages pointing at their carets.
		if num_messages > usize::from(trailing.is_some()) {
			outer_gutter(out, outer_padding)?;
			border_left(out, false)?;
			inner_gutter(out, num_multi, multi)?;
			write!(out, " ")?;
			caret_pointers(out, max_label_start, single, trailing, &metrics)?;
			writeln!(out)?;

			let hanging: Vec<usize> = single
				.iter()
				.enumerate()
				.filter(|(_, (_, _, message))| !message.is_empty())
				.map(|(index, _)| index)
				.filter(|index| trailing.is_none_or(|t| *index != t))
				.collect();
			for &index in hanging.iter().rev() {
				let (_, range, message) = &single[index];
				outer_gutter(out, outer_padding)?;
				border_left(out, false)?;
				inner_gutter(out, num_multi, multi)?;
				write!(out, " ")?;
				let cut = metrics.iter().take_while(|m| m.byte_index < range.start).count();
				caret_pointers(out, max_label_start, single, trailing, &metrics[..cut])?;
				write!(out, "{message}")?;
				writeln!(out)?;
			}
		}
	}

	// Multi-line label carets.
	for (multi_index, (_, label_style, label)) in multi.iter().enumerate() {
		let (style, range, bottom_message) = match label {
			MultiSpan::Left => continue,
			MultiSpan::Top(start) if *start <= leading => continue,
			MultiSpan::Top(range) => (*label_style, range, None),
			MultiSpan::Bottom(range, message) => (*label_style, range, Some(message)),
		};

		outer_gutter(out, outer_padding)?;
		border_left(out, false)?;
		let mut underline: Option<LabelStyle> = None;
		let mut iter = multi.iter().enumerate().peekable();
		for column in 0..num_multi {
			match iter.peek() {
				Some((index, (label_index, style, label))) if *label_index == column => {
					match label {
						MultiSpan::Left => label_multi_left(out, underline)?,
						MultiSpan::Top(..) if multi_index > *index => label_multi_left(out, underline)?,
						MultiSpan::Bottom(..) if multi_index < *index => label_multi_left(out, underline)?,
						MultiSpan::Top(..) if multi_index == *index => {
							underline = Some(*style);
							write!(out, " {MULTI_TOP_LEFT}")?;
						},
						MultiSpan::Bottom(..) if multi_index == *index => {
							underline = Some(*style);
							write!(out, " {MULTI_BOTTOM_LEFT}")?;
						},
						MultiSpan::Top(..) | MultiSpan::Bottom(..) => inner_gutter_column(out, underline)?,
					}
					iter.next();
				},
				Some(_) | None => inner_gutter_column(out, underline)?,
			}
		}

		match bottom_message {
			None => {
				for m in char_metrics(source).iter().take_while(|m| m.byte_index < range + 1) {
					for _ in 0..m.width {
						write!(out, "{MULTI_TOP}")?;
					}
				}
				let caret = match style {
					LabelStyle::Primary => MULTI_PRIMARY_CARET,
					LabelStyle::Secondary => MULTI_SECONDARY_CARET,
				};
				writeln!(out, "{caret}")?;
			},
			Some(message) => {
				for m in char_metrics(source).iter().take_while(|m| m.byte_index < *range) {
					for _ in 0..m.width {
						write!(out, "{MULTI_BOTTOM}")?;
					}
				}
				let caret = match style {
					LabelStyle::Primary => MULTI_PRIMARY_CARET,
					LabelStyle::Secondary => MULTI_SECONDARY_CARET,
				};
				write!(out, "{caret}")?;
				if !message.is_empty() {
					write!(out, " {message}")?;
				}
				writeln!(out)?;
			},
		}
	}
	Ok(())
}

/// Renders a richly formatted diagnostic with source previews.
fn render_rich(out: &mut String, report: &Report<'_>) -> fmt::Result {
	let source = report.source;
	let starts = line_starts(source);

	let mut outer_padding = 0;
	let mut num_multi = 0usize;
	let mut lines: BTreeMap<usize, LinePlan> = BTreeMap::new();

	for label in report.labels {
		let start_line_index = line_index(&starts, label.range.start);
		let start_line_range = line_range(&starts, source, start_line_index).expect("start line exists");
		let end_line_index = line_index(&starts, label.range.end);
		let end_line_range = line_range(&starts, source, end_line_index).expect("end line exists");
		let start_line_number = start_line_index + 1;
		let end_line_number = end_line_index + 1;
		outer_padding = cmp::max(outer_padding, count_digits(start_line_number));
		outer_padding = cmp::max(outer_padding, count_digits(end_line_number));

		let style = if label.primary { LabelStyle::Primary } else { LabelStyle::Secondary };

		if start_line_index == end_line_index {
			let label_start = label.range.start - start_line_range.start;
			let label_end = cmp::max(label.range.end - start_line_range.start, label_start + 1);
			let line = get_or_insert(&mut lines, start_line_index, start_line_range, start_line_number);
			let index = line
				.single
				.binary_search_by(|(_, range, _)| (range.start, range.end).cmp(&(label_start, label_end)))
				.unwrap_or_else(|index| index);
			line.single.insert(index, (style, label_start..label_end, label.message.clone()));
			line.must_render = true;
		} else {
			let label_index = num_multi;
			num_multi += 1;

			let label_start = label.range.start - start_line_range.start;
			let start_line = get_or_insert(&mut lines, start_line_index, start_line_range, start_line_number);
			start_line.multi.push((label_index, style, MultiSpan::Top(label_start)));
			start_line.must_render = true;

			for index in (start_line_index + 1)..end_line_index {
				let range = line_range(&starts, source, index).expect("interior line exists");
				let number = index + 1;
				outer_padding = cmp::max(outer_padding, count_digits(number));
				let line = get_or_insert(&mut lines, index, range, number);
				line.multi.push((label_index, style, MultiSpan::Left));
				line.must_render |= index - start_line_index <= report.start_context_lines
					|| end_line_index - index <= report.end_context_lines;
			}

			let label_end = label.range.end - end_line_range.start;
			let end_line = get_or_insert(&mut lines, end_line_index, end_line_range, end_line_number);
			end_line.multi.push((label_index, style, MultiSpan::Bottom(label_end, label.message.clone())));
			end_line.must_render = true;
		}
	}

	render_header(out, None, report.severity, report.code, report.message)?;

	if !lines.is_empty() {
		// The locus is the primary label with the earliest start, falling back
		// to the earliest secondary label.
		let (mut start, mut style) = (report.labels[0].range.start, label_style_of(&report.labels[0]));
		for label in &report.labels[1..] {
			let label_style = label_style_of(label);
			let (current, new) = (label_priority(style), label_priority(label_style));
			if current < new || (current == new && start > label.range.start) {
				start = label.range.start;
				style = label_style;
			}
		}
		let locus_line = line_index(&starts, start);
		let locus_range = line_range(&starts, source, locus_line).expect("locus line exists");
		let column = column_number(source, &locus_range, start) + 1;
		render_snippet_start(out, outer_padding, report.file_name, locus_line + 1, column)?;
		render_snippet_empty(out, outer_padding, num_multi, &[])?;

		let mut iter = lines.iter().filter(|(_, line)| line.must_render).peekable();
		while let Some((index, line)) = iter.next() {
			let index = *index;
			render_snippet_source(
				out,
				outer_padding,
				line.number,
				&source[line.range.clone()],
				&line.single,
				num_multi,
				&line.multi,
			)?;
			if let Some((next_index, next_line)) = iter.peek() {
				match next_index.checked_sub(index) {
					Some(1) => {},
					Some(2) => {
						let inner = lines.get(&(index + 1)).map_or(&[][..], |line| &line.multi[..]);
						let range = line_range(&starts, source, index + 1).expect("skipped line exists");
						render_snippet_source(out, outer_padding, index + 2, &source[range], &[], num_multi, inner)?;
					},
					Some(_) | None => render_snippet_break(out, outer_padding, num_multi, &next_line.multi)?,
				}
			}
		}

		if !report.notes.is_empty() {
			render_snippet_empty(out, outer_padding, num_multi, &[])?;
		}
	}

	for note in report.notes {
		render_snippet_note(out, outer_padding, note)?;
	}
	writeln!(out)
}

/// The label style of a [`Label`].
fn label_style_of(label: &Label) -> LabelStyle {
	if label.primary { LabelStyle::Primary } else { LabelStyle::Secondary }
}

/// Fetches or inserts the plan for a line.
fn get_or_insert<'a>(
	lines: &'a mut BTreeMap<usize, LinePlan>,
	index: usize,
	range: Range<usize>,
	number: usize,
) -> &'a mut LinePlan {
	lines.entry(index).or_insert_with(|| LinePlan {
		number,
		range,
		single: Vec::new(),
		multi: Vec::new(),
		must_render: false,
	})
}

/// Renders a short or medium diagnostic: located header plus optional notes.
fn render_short(out: &mut String, report: &Report<'_>, show_notes: bool) -> fmt::Result {
	let starts = line_starts(report.source);
	let mut encountered = 0;
	for label in report.labels.iter().filter(|label| label.primary) {
		encountered += 1;
		let index = line_index(&starts, label.range.start);
		let range = line_range(&starts, report.source, index).expect("label line exists");
		let column = column_number(report.source, &range, label.range.start) + 1;
		render_header(
			out,
			Some((report.file_name, index + 1, column)),
			report.severity,
			report.code,
			report.message,
		)?;
	}
	if encountered == 0 {
		render_header(out, None, report.severity, report.code, report.message)?;
	}
	if show_notes {
		for note in report.notes {
			render_snippet_note(out, 0, note)?;
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Case {
		name: &'static str,
		file_name: &'static str,
		source: &'static str,
		severity: Severity,
		code: &'static str,
		message: &'static str,
		notes: Vec<&'static str>,
		labels: Vec<(usize, usize, bool, &'static str)>,
		display_style: DisplayStyle,
		start_context: usize,
		end_context: usize,
	}


	const SRC: &str = "fn main() {\n    let x = 1;\n    let y = 2;\n    println!(\"{x} {y}\");\n}\n";
	const LINES: &str = "a = 1;\nb = 2;\nc = 3;\nd = 4;\ne = 5;\nf = 6;\ng = 7;\n";

	fn idx(source: &str, needle: &str) -> usize {
		source.find(needle).expect("needle present")
	}

	fn span(source: &'static str, needle: &'static str, offset: usize) -> (usize, usize) {
		let start = idx(source, needle) + offset;
		(start, start + needle.len())
	}

	fn cases() -> Vec<Case> {
		vec![
			Case {
				name:             "rich_error_single",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Error,
				code:             "no-unused",
				message:          "unused variable `x`",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = span(SRC, "x = 1", 0);
					(start, end, true, "unused variable `x`")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_warning",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Warning,
				code:             "shadowed",
				message:          "this shadows a previous binding",
				notes:            vec!["rename the binding"],
				labels:           vec![{
					let (start, end) = span(SRC, "let y", 0);
					(start, end, true, "shadowed here")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_note_severity",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Note,
				code:             "style",
				message:          "consider a different style",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = span(SRC, "main", 0);
					(start, end, true, "this function")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_help_severity",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Help,
				code:             "hint",
				message:          "try using a loop",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = span(SRC, "println!", 0);
					(start, end, true, "replace this")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_primary_secondary",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Error,
				code:             "type-mismatch",
				message:          "mismatched types",
				notes:            vec!["expected `i32`, found `&str`"],
				labels:           vec![
					{
						let (start, end) = span(SRC, "x = 1", 0);
						(start, end, true, "expected `i32`")
					},
					{
						let (start, end) = span(SRC, "y = 2", 0);
						(start, end, false, "found `&str`")
					},
				],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_same_line_labels",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Warning,
				code:             "borrow",
				message:          "two labels on one line",
				notes:            vec![],
				labels:           vec![
					{
						let (start, end) = span(SRC, "let x", 0);
						(start, end, true, "first borrow")
					},
					{
						let (start, end) = span(SRC, "x = 1", 0);
						(start, end, false, "second borrow")
					},
				],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_empty_message",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Error,
				code:             "empty",
				message:          "a label with no message",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = span(SRC, "x = 1", 0);
					(start, end, true, "")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_multiline",
				file_name:        "config.txt",
				source:           LINES,
				severity:         Severity::Error,
				code:             "spans",
				message:          "label spans several lines",
				notes:            vec!["a note about the span"],
				labels:           vec![{
					let (start, end) = (idx(LINES, "a = 1"), idx(LINES, "g = 7") + "g = 7".len());
					(start, end, true, "the whole span")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_multiline_ctx0",
				file_name:        "config.txt",
				source:           LINES,
				severity:         Severity::Error,
				code:             "spans",
				message:          "no context lines",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = (idx(LINES, "a = 1"), idx(LINES, "g = 7") + "g = 7".len());
					(start, end, true, "the whole span")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    0,
				end_context:      0,
			},
			Case {
				name:             "rich_multiline_ctx2",
				file_name:        "config.txt",
				source:           LINES,
				severity:         Severity::Warning,
				code:             "spans",
				message:          "two context lines",
				notes:            vec![],
				labels:           vec![{
					let (start, end) = (idx(LINES, "a = 1"), idx(LINES, "g = 7") + "g = 7".len());
					(start, end, true, "the whole span")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    2,
				end_context:      2,
			},
			Case {
				name:             "rich_multiline_secondary",
				file_name:        "config.txt",
				source:           LINES,
				severity:         Severity::Error,
				code:             "spans",
				message:          "secondary span",
				notes:            vec![],
				labels:           vec![
					{
						let (start, end) = span(LINES, "b = 2", 0);
						(start, end, true, "primary middle")
					},
					{
						let (start, end) = (idx(LINES, "a = 1"), idx(LINES, "g = 7") + "g = 7".len());
						(start, end, false, "secondary whole")
					},
				],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "rich_notes",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Note,
				code:             "notes",
				message:          "has several notes",
				notes:            vec!["first note", "multi-line note\nwith a second line"],
				labels:           vec![{
					let (start, end) = span(SRC, "let y", 0);
					(start, end, true, "here")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
			Case {
				name:             "medium_error",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Error,
				code:             "medium",
				message:          "medium diagnostic",
				notes:            vec!["a medium note"],
				labels:           vec![{
					let (start, end) = span(SRC, "x = 1", 0);
					(start, end, true, "primary")
				}],
				display_style:    DisplayStyle::Medium,
				start_context:    0,
				end_context:      0,
			},
			Case {
				name:             "medium_no_primary",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Warning,
				code:             "medium",
				message:          "no primary label",
				notes:            vec!["still a note"],
				labels:           vec![{
					let (start, end) = span(SRC, "x = 1", 0);
					(start, end, false, "secondary")
				}],
				display_style:    DisplayStyle::Medium,
				start_context:    0,
				end_context:      0,
			},
			Case {
				name:             "short_error",
				file_name:        "src/main.rs",
				source:           SRC,
				severity:         Severity::Error,
				code:             "short",
				message:          "short diagnostic",
				notes:            vec!["this note is hidden"],
				labels:           vec![{
					let (start, end) = span(SRC, "x = 1", 0);
					(start, end, true, "primary")
				}],
				display_style:    DisplayStyle::Short,
				start_context:    0,
				end_context:      0,
			},
			Case {
				name:             "rich_tab_expansion",
				file_name:        "src/main.rs",
				source:           "fn f() {\n\tlet x = 1;\n}\n",
				severity:         Severity::Error,
				code:             "tabbed",
				message:          "tab expanded",
				notes:            vec![],
				labels:           vec![{
					let source = "fn f() {\n\tlet x = 1;\n}\n";
					let (start, end) = span(source, "let x", 1);
					(start, end, true, "here")
				}],
				display_style:    DisplayStyle::Rich,
				start_context:    3,
				end_context:      1,
			},
		]
	}

	fn render_ours(case: &Case) -> String {
		let labels: Vec<Label> = case
			.labels
			.iter()
			.map(|&(start, end, primary, message)| Label {
				range: start..end,
				primary,
				message: message.to_owned(),
			})
			.collect();
		let notes: Vec<String> = case.notes.iter().map(|note| (*note).to_owned()).collect();
		let report = Report {
			file_name:          case.file_name,
			source:             case.source,
			severity:           case.severity,
			code:               case.code,
			message:            case.message,
			notes:              &notes,
			labels:             &labels,
			display_style:      case.display_style,
			start_context_lines: case.start_context,
			end_context_lines:  case.end_context,
		};
		let mut out = Vec::new();
		emit(&mut out, &report).expect("write to a Vec cannot fail");
		String::from_utf8(out).expect("renderer emits UTF-8")
	}

	#[test]
	fn golden() {
		for case in cases() {
			assert_eq!(render_ours(&case), expected(case.name), "case `{}` differs", case.name);
		}
	}

	/// The exact output pinned for each case, captured from the renderer this
	/// module replaces.
	fn expected(name: &str) -> &'static str {
		match name {
			"rich_error_single" =>
				"error[no-unused]: unused variable `x`\n  ┌─ src/main.rs:2:9\n  │\n2 │     let x = 1;\n  │         ^^^^^ unused variable `x`\n\n",
			"rich_warning" =>
				"warning[shadowed]: this shadows a previous binding\n  ┌─ src/main.rs:3:5\n  │\n3 │     let y = 2;\n  │     ^^^^^ shadowed here\n  │\n  = rename the binding\n\n",
			"rich_note_severity" =>
				"note[style]: consider a different style\n  ┌─ src/main.rs:1:4\n  │\n1 │ fn main() {\n  │    ^^^^ this function\n\n",
			"rich_help_severity" =>
				"help[hint]: try using a loop\n  ┌─ src/main.rs:4:5\n  │\n4 │     println!(\"{x} {y}\");\n  │     ^^^^^^^^ replace this\n\n",
			"rich_primary_secondary" =>
				"error[type-mismatch]: mismatched types\n  ┌─ src/main.rs:2:9\n  │\n2 │     let x = 1;\n  │         ^^^^^ expected `i32`\n3 │     let y = 2;\n  │         ----- found `&str`\n  │\n  = expected `i32`, found `&str`\n\n",
			"rich_same_line_labels" =>
				"warning[borrow]: two labels on one line\n  ┌─ src/main.rs:2:5\n  │\n2 │     let x = 1;\n  │     ^^^^^----\n  │     │   │\n  │     │   second borrow\n  │     first borrow\n\n",
			"rich_empty_message" =>
				"error[empty]: a label with no message\n  ┌─ src/main.rs:2:9\n  │\n2 │     let x = 1;\n  │         ^^^^^\n\n",
			"rich_multiline" =>
				"error[spans]: label spans several lines\n  ┌─ config.txt:1:1\n  │  \n1 │ ╭ a = 1;\n2 │ │ b = 2;\n3 │ │ c = 3;\n4 │ │ d = 4;\n5 │ │ e = 5;\n6 │ │ f = 6;\n7 │ │ g = 7;\n  │ ╰─────^ the whole span\n  │  \n  = a note about the span\n\n",
			"rich_multiline_ctx0" =>
				"error[spans]: no context lines\n  ┌─ config.txt:1:1\n  │  \n1 │ ╭ a = 1;\n  · │\n7 │ │ g = 7;\n  │ ╰─────^ the whole span\n\n",
			"rich_multiline_ctx2" =>
				"warning[spans]: two context lines\n  ┌─ config.txt:1:1\n  │  \n1 │ ╭ a = 1;\n2 │ │ b = 2;\n3 │ │ c = 3;\n4 │ │ d = 4;\n5 │ │ e = 5;\n6 │ │ f = 6;\n7 │ │ g = 7;\n  │ ╰─────^ the whole span\n\n",
			"rich_multiline_secondary" =>
				"error[spans]: secondary span\n  ┌─ config.txt:2:1\n  │  \n1 │ ╭ a = 1;\n2 │ │ b = 2;\n  │ │ ^^^^^ primary middle\n3 │ │ c = 3;\n4 │ │ d = 4;\n5 │ │ e = 5;\n6 │ │ f = 6;\n7 │ │ g = 7;\n  │ ╰─────' secondary whole\n\n",
			"rich_notes" =>
				"note[notes]: has several notes\n  ┌─ src/main.rs:3:5\n  │\n3 │     let y = 2;\n  │     ^^^^^ here\n  │\n  = first note\n  = multi-line note\n    with a second line\n\n",
			"medium_error" => "src/main.rs:2:9: error[medium]: medium diagnostic\n = a medium note\n",
			"medium_no_primary" => "warning[medium]: no primary label\n = still a note\n",
			"short_error" => "src/main.rs:2:9: error[short]: short diagnostic\n",
			"rich_tab_expansion" =>
				"error[tabbed]: tab expanded\n  ┌─ src/main.rs:2:3\n  │\n2 │     let x = 1;\n  │      ^^^^^ here\n\n",
			_ => panic!("no golden string for `{name}`"),
		}
	}
}
