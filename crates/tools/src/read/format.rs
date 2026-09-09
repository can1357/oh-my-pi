//! Pure text rendering for every `read` text source.

use std::{
	collections::BTreeSet,
	fmt::Write as _,
	path::{MAIN_SEPARATOR, Path},
};

use omp_ast::block::{
	EnclosingBoundaryOptions, LineRange as AstLineRange, enclosing_block_boundaries,
};
use omp_core::{Str, sf};
use omp_edit::modes::hashline::format::{
	format_hashline_header, format_numbered_line, split_addressable_file_lines,
};
use omp_tool::{Diag, DiagKind, Unit};
use smallvec::{SmallVec, smallvec};

use super::selector::{LineRange as SelectorLineRange, ParsedSelector};

/// Source lines added before a range whose start was explicitly constrained.
pub const RANGE_LEADING_CONTEXT_LINES: usize = 1;
/// Source lines added after a range whose end was explicitly constrained.
pub const RANGE_TRAILING_CONTEXT_LINES: usize = 3;
/// Marker inserted between non-contiguous source spans and bracket boundaries.
pub const BRACKET_CONTEXT_ELLIPSIS: &str = "…";

/// A one-based inclusive source span.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LineSpan {
	/// First source line in the span.
	pub start_line: usize,
	/// Last source line in the span.
	pub end_line:   usize,
}

/// One already-bounded source span loaded by a streaming resolver.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResolvedRangeText<'a> {
	/// Original source-line coordinates for `text`.
	pub span: LineSpan,
	/// Exact UTF-8 bytes for the span, including an optional terminal newline.
	pub text: &'a str,
}
/// Exact source-line provenance for one rendered output line.
pub type SourceLines = SmallVec<usize, 2>;
/// Exact source-line provenance for each rendered output line.
///
/// An empty entry denotes framing or ellipses. Most content rows map to one
/// source line; structural renderers may map one row to several lines.
pub type SourceLineMap = Box<[SourceLines]>;

/// Model-facing text plus harness diagnostics kept outside the result body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rendered {
	/// Result data.
	pub text:  Str,
	/// Structured harness notices.
	pub diags: SmallVec<Diag, 2>,
}

/// Optional editable snapshot framing for a text result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SnapshotHeader<'a> {
	/// Workspace-relative or home-shortened path accepted by hashline edit.
	pub anchor: &'a str,
	/// Four-character hashline snapshot tag.
	pub tag:    &'a str,
}

/// Language hints used to enrich a partial read with enclosing boundaries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BlockContextSource<'a> {
	/// Path used to infer a tree-sitter grammar.
	pub path:     Option<&'a str>,
	/// Explicit tree-sitter language alias.
	pub language: Option<&'a str>,
}

/// Options shared by plain, converted, notebook, archive, profile, and web
/// text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextFormatOptions<'a> {
	/// Human-readable resource name used by continuation and bounds notices.
	pub entity_label:  &'a str,
	/// Snapshot header emitted once before editable numbered content.
	pub snapshot:      Option<SnapshotHeader<'a>>,
	/// Path/language hints for bracket-context enrichment.
	pub block_context: BlockContextSource<'a>,
	/// Include one-based source line prefixes when no snapshot requires them.
	pub line_numbers:  bool,
}

impl<'a> TextFormatOptions<'a> {
	/// Construct options for an untagged source with automatic language
	/// inference disabled.
	pub const fn new(entity_label: &'a str) -> Self {
		Self {
			entity_label,
			snapshot: None,
			block_context: BlockContextSource { path: None, language: None },
			line_numbers: true,
		}
	}
}

/// Deterministic output and source-line bookkeeping from [`format_text`].
///
/// The text is complete: read-level formatting never caps lines or bytes.
/// Bounding happens exactly once, in the dispatcher's central spill gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormattedText {
	/// Complete model-facing text.
	pub text:           String,
	/// Structured harness notices collected while formatting.
	pub diags:          SmallVec<Diag, 2>,
	/// Exact source-line provenance for every line in `text`.
	pub source_lines:   SourceLineMap,
	/// Number of addressable lines in the source under the requested raw mode.
	pub total_lines:    usize,
	/// Lines actually exposed, including off-window block-boundary context.
	pub seen_lines:     Box<[usize]>,
	/// Complete source spans selected before block-boundary enrichment.
	pub selected_spans: Box<[LineSpan]>,
	/// Snapshot tag associated with the output, when one was supplied.
	pub snapshot_tag:   Option<Str>,
}

/// One line or elision marker in a bracket-enriched projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineEntry<'a> {
	/// A real source line.
	Line {
		/// One-based source line number.
		line_number: usize,
		/// Verbatim line text.
		text:        &'a str,
		/// Whether this line was added only as an enclosing boundary.
		context:     bool,
	},
	/// A non-contiguous gap between source lines.
	Ellipsis,
}

/// One closed elision span in a structural summary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ElidedRange {
	/// First elided source line.
	pub start: usize,
	/// Last elided source line.
	pub end:   usize,
}

/// Model and display forms of a merged structural-summary brace pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MergedBraceLine {
	/// Hashline-addressed model projection.
	pub model:   String,
	/// Unnumbered display projection.
	pub display: String,
}

/// Return a stable edit anchor for a local path.
///
/// Paths inside `workspace` become workspace-relative. Outside paths remain
/// absolute unless they are under `home`, in which case the prefix becomes `~`.
pub fn format_read_anchor(path: &Path, workspace: &Path, home: Option<&Path>) -> String {
	let display = if path.is_absolute() {
		if let Ok(relative) = path.strip_prefix(workspace) {
			if relative.as_os_str().is_empty() {
				".".to_owned()
			} else {
				relative.to_string_lossy().into_owned()
			}
		} else if let Some(home) = home {
			if let Ok(relative) = path.strip_prefix(home) {
				if relative.as_os_str().is_empty() {
					"~".to_owned()
				} else {
					format!("~/{relative}", relative = relative.to_string_lossy())
				}
			} else {
				path.to_string_lossy().into_owned()
			}
		} else {
			path.to_string_lossy().into_owned()
		}
	} else {
		path.to_string_lossy().into_owned()
	};
	normalize_display_separators(display)
}

/// Format one hashline read header from its already-resolvable anchor and tag.
pub fn format_read_hashline_header(anchor: &str, tag: &str) -> Str {
	format_hashline_header(anchor, tag).into()
}

/// Formats resolver-loaded line spans without rebasing their source numbers.
///
/// This is the bounded counterpart to [`format_text`]: immutable resolvers can
/// index a large source and fetch only the requested byte windows while still
/// receiving the shared numbered/raw range projection.
pub fn format_resolved_ranges(
	pieces: &[ResolvedRangeText<'_>],
	requested: &[SelectorLineRange],
	raw: bool,
	total_lines: usize,
	options: TextFormatOptions<'_>,
) -> Rendered {
	let mut output = String::new();
	let mut diags = SmallVec::new();
	for (piece_index, piece) in pieces.iter().enumerate() {
		if piece_index > 0 {
			output.push_str(if raw { "\n\n…\n\n" } else { "\n…\n" });
		}
		let expected = piece
			.span
			.end_line
			.saturating_sub(piece.span.start_line)
			.saturating_add(1);
		let mut lines = piece.text.split('\n').take(expected);
		for offset in 0..expected {
			let line = lines.next().unwrap_or("");
			if offset > 0 {
				output.push('\n');
			}
			if raw {
				output.push_str(line);
			} else {
				let line_number =
					u32::try_from(piece.span.start_line.saturating_add(offset)).unwrap_or(u32::MAX);
				output.push_str(&format_numbered_line(line_number, line));
			}
		}
	}

	for range in requested {
		let start = usize::try_from(range.start_line).unwrap_or(usize::MAX);
		if start <= total_lines {
			continue;
		}
		let bound = range
			.end_line
			.map_or_else(|| range.start_line.to_string(), |end| format!("{}-{end}", range.start_line));
		diags.push(Diag::warn(
			DiagKind::RangeOutOfBounds,
			sf!(
				"Requested range {bound} is beyond end of {} ({total_lines} lines total).",
				options.entity_label
			),
		));
	}

	if !raw
		&& requested.len() == 1
		&& requested[0].end_line.is_some()
		&& let Some(last) = pieces.last()
		&& last.span.end_line < total_lines
	{
		let remaining = total_lines - last.span.end_line;
		let next_offset = last.span.end_line + 1;
		diags.push(
			Diag::info(
				DiagKind::Pagination,
				sf!("{remaining} lines remain in {}.", options.entity_label),
			)
			.continuation(sf!(":{next_offset}"))
			.omitted(remaining as u64, Unit::Lines),
		);
	}
	Rendered { text: output.into(), diags }
}

/// Render text selected by a parsed path selector.
///
/// Non-raw output always uses hashline-compatible `N:text` rows. A snapshot
/// controls only whether the editable `[anchor#TAG]` header is present. The
/// `Conflicts` selector is dispatched before this function and is treated as a
/// normal read defensively.
pub fn format_text(
	text: &str,
	selector: &ParsedSelector,
	options: TextFormatOptions<'_>,
) -> FormattedText {
	let raw = selector.is_raw();
	let lines: Vec<&str> = if raw {
		text.split('\n').collect()
	} else {
		split_addressable_file_lines(text)
	};
	let total_lines = lines.len();
	let snapshot_tag = options.snapshot.map(|snapshot| Str::new(snapshot.tag));

	if let ParsedSelector::Lines { ranges, .. } = selector
		&& ranges.len() > 1
	{
		return format_multiple_ranges(&lines, ranges, raw, options, total_lines, snapshot_tag);
	}

	let (offset, finite_limit) = selector.offset_limit();
	let requested_start = offset
		.and_then(|line| usize::try_from(line).ok())
		.unwrap_or(1)
		.saturating_sub(1);
	if requested_start >= total_lines {
		let diag = Diag::warn(
			DiagKind::RangeOutOfBounds,
			sf!(
				"Line {} is beyond end of {} ({total_lines} lines total).",
				requested_start + 1,
				options.entity_label
			),
		)
		.continuation(":1");
		return FormattedText {
			text: String::new(),
			diags: smallvec![diag],
			source_lines: Box::new([]),
			total_lines,
			seen_lines: Box::new([]),
			selected_spans: Box::new([]),
			snapshot_tag,
		};
	}

	let requested_end = finite_limit
		.and_then(|limit| usize::try_from(limit).ok())
		.map_or(total_lines, |limit| requested_start.saturating_add(limit).min(total_lines));
	let explicit_start = !raw && offset.is_some_and(|line| line > 1);
	let explicit_end = !raw && finite_limit.is_some();
	let start = if explicit_start {
		requested_start.saturating_sub(RANGE_LEADING_CONTEXT_LINES)
	} else {
		requested_start
	};
	let end = if explicit_end {
		requested_end
			.saturating_add(RANGE_TRAILING_CONTEXT_LINES)
			.min(total_lines)
	} else {
		requested_end
	};
	let start_line = start + 1;
	let mut selected_spans = Vec::new();
	if end > start {
		selected_spans.push(LineSpan { start_line, end_line: end });
	}
	let mut source_lines = Vec::new();
	let mut output;
	if raw {
		output = lines[start..end].join("\n");
		source_lines.extend((start_line..=end).map(single_source_line));
	} else {
		let entries =
			build_line_entries_with_block_context(&lines, &selected_spans, options.block_context);
		source_lines.extend(line_entry_sources(&entries));
		output =
			format_line_entries_mode(&entries, options.line_numbers || options.snapshot.is_some());
		if options.snapshot.is_some() {
			source_lines.insert(0, SmallVec::new());
		}
		prepend_snapshot_header(&mut output, options.snapshot);
	}
	let mut diags = SmallVec::new();
	if !raw && finite_limit.is_some() && end < total_lines {
		let remaining = total_lines - end;
		let next_offset = end + 1;
		diags.push(
			Diag::info(
				DiagKind::Pagination,
				sf!("{remaining} lines remain in {}.", options.entity_label),
			)
			.continuation(sf!(":{next_offset}"))
			.omitted(remaining as u64, Unit::Lines),
		);
	}
	pad_unmapped_to_text(&output, &mut source_lines);
	let seen_lines = source_lines
		.iter()
		.flat_map(|lines| lines.iter().copied())
		.collect::<Vec<_>>();

	FormattedText {
		text: output,
		diags,
		source_lines: source_lines.into_boxed_slice(),
		total_lines,
		seen_lines: seen_lines.into_boxed_slice(),
		selected_spans: selected_spans.into_boxed_slice(),
		snapshot_tag,
	}
}

fn format_multiple_ranges(
	lines: &[&str],
	ranges: &[SelectorLineRange],
	raw: bool,
	options: TextFormatOptions<'_>,
	total_lines: usize,
	snapshot_tag: Option<Str>,
) -> FormattedText {
	let mut visible_spans = Vec::with_capacity(ranges.len());
	let mut out_of_bounds = Vec::new();
	for range in ranges {
		let Ok(start_line) = usize::try_from(range.start_line) else {
			out_of_bounds.push(*range);
			continue;
		};
		if start_line > total_lines {
			out_of_bounds.push(*range);
			continue;
		}
		let end_line = range
			.end_line
			.and_then(|end| usize::try_from(end).ok())
			.unwrap_or(total_lines)
			.min(total_lines);
		visible_spans.push(LineSpan { start_line, end_line });
	}

	let mut source_lines: Vec<SourceLines> = Vec::new();
	let mut diags = SmallVec::new();
	let output = if raw {
		let mut output = String::new();
		for (index, span) in visible_spans.iter().enumerate() {
			if index > 0 {
				output.push_str("\n\n…\n\n");
				source_lines.extend([SmallVec::new(), SmallVec::new(), SmallVec::new()]);
			}
			output.push_str(&lines[span.start_line - 1..span.end_line].join("\n"));
			source_lines.extend((span.start_line..=span.end_line).map(single_source_line));
		}
		output
	} else if visible_spans.is_empty() {
		String::new()
	} else {
		let entries =
			build_line_entries_with_block_context(lines, &visible_spans, options.block_context);
		source_lines.extend(line_entry_sources(&entries));
		let mut formatted =
			format_line_entries_mode(&entries, options.line_numbers || options.snapshot.is_some());
		if options.snapshot.is_some() {
			source_lines.insert(0, SmallVec::new());
		}
		prepend_snapshot_header(&mut formatted, options.snapshot);
		formatted
	};

	for range in out_of_bounds {
		let bound = range
			.end_line
			.map_or_else(|| range.start_line.to_string(), |end| format!("{}-{end}", range.start_line));
		diags.push(Diag::warn(
			DiagKind::RangeOutOfBounds,
			sf!(
				"Requested range {bound} is beyond end of {} ({total_lines} lines total).",
				options.entity_label
			),
		));
	}
	pad_unmapped_to_text(&output, &mut source_lines);
	let seen_lines = source_lines
		.iter()
		.flat_map(|lines| lines.iter().copied())
		.collect::<Vec<_>>();
	FormattedText {
		text: output,
		diags,
		source_lines: source_lines.into_boxed_slice(),
		total_lines,
		seen_lines: seen_lines.into_boxed_slice(),
		selected_spans: visible_spans.into_boxed_slice(),
		snapshot_tag,
	}
}

/// Add syntactic or lexical enclosing boundaries to visible spans.
pub fn build_line_entries_with_block_context<'a>(
	full_lines: &'a [&'a str],
	visible_spans: &[LineSpan],
	source: BlockContextSource<'_>,
) -> Vec<LineEntry<'a>> {
	let spans = normalize_line_spans(visible_spans, full_lines.len());
	let mut visible = BTreeSet::new();
	for span in &spans {
		visible.extend(span.start_line..=span.end_line);
	}
	let context = find_block_context_lines(full_lines, &visible, source);
	let mut all_lines = visible.clone();
	all_lines.extend(context.iter().copied());

	let mut entries = Vec::with_capacity(all_lines.len().saturating_add(spans.len()));
	let mut previous = None;
	for line_number in all_lines {
		if previous.is_some_and(|line| line_number > line + 1) {
			entries.push(LineEntry::Ellipsis);
		}
		entries.push(LineEntry::Line {
			line_number,
			text: full_lines[line_number - 1],
			context: context.contains(&line_number),
		});
		previous = Some(line_number);
	}
	entries
}

/// Render bracket-enriched entries as hashline-compatible numbered text.
pub fn format_line_entries(entries: &[LineEntry<'_>]) -> String {
	format_line_entries_mode(entries, true)
}

fn format_line_entries_mode(entries: &[LineEntry<'_>], line_numbers: bool) -> String {
	let mut output = String::new();
	for (index, entry) in entries.iter().enumerate() {
		if index > 0 {
			output.push('\n');
		}
		match entry {
			LineEntry::Line { line_number, text, .. } if line_numbers => {
				let line_number = u32::try_from(*line_number).unwrap_or(u32::MAX);
				output.push_str(&format_numbered_line(line_number, text));
			},
			LineEntry::Line { text, .. } => output.push_str(text),
			LineEntry::Ellipsis => output.push_str(BRACKET_CONTEXT_ELLIPSIS),
		}
	}
	output
}

/// Render entries without numbering for display metadata.
pub fn line_entries_to_plain_text(entries: &[LineEntry<'_>]) -> String {
	let mut output = String::new();
	for (index, entry) in entries.iter().enumerate() {
		if index > 0 {
			output.push('\n');
		}
		match entry {
			LineEntry::Line { text, .. } => output.push_str(text),
			LineEntry::Ellipsis => output.push_str(BRACKET_CONTEXT_ELLIPSIS),
		}
	}
	output
}

/// Format the concrete recovery diagnostic for a structural summary.
pub fn summary_elision_diag(
	read_path: &str,
	elided_ranges: &[ElidedRange],
	elided_lines: usize,
) -> Option<Diag> {
	if elided_ranges.is_empty() {
		return None;
	}
	let mut selector = String::new();
	for (index, range) in elided_ranges.iter().enumerate() {
		if index > 0 {
			selector.push(',');
		}
		let _ = write!(selector, "{}-{}", range.start, range.end);
	}
	Some(
		Diag::info(
			DiagKind::SummaryElided,
			sf!("{elided_lines} lines elided from structural summary."),
		)
		.continuation(sf!("{read_path}:{selector}"))
		.omitted(elided_lines as u64, Unit::Lines),
	)
}

/// Decide whether an elided structural body can collapse its brace endpoints.
pub fn can_merge_brace_pair(head_line: &str, tail_line: &str) -> bool {
	let Some(opener) = head_line.trim_end().chars().next_back() else {
		return false;
	};
	let closer = match opener {
		'{' => '}',
		'(' => ')',
		'[' => ']',
		_ => return false,
	};
	let tail = tail_line.trim();
	let Some(rest) = tail.strip_prefix(closer) else {
		return false;
	};
	rest
		.chars()
		.all(|ch| matches!(ch, ';' | ',' | ')' | ']' | '}'))
}

/// Merge a structural-summary opener and closer into one addressed row.
pub fn format_merged_brace_line(
	start_line: usize,
	end_line: usize,
	head_text: &str,
	tail_text: &str,
) -> MergedBraceLine {
	let display = format!("{} … {}", head_text.trim_end(), tail_text.trim());
	MergedBraceLine { model: format!("{start_line}-{end_line}:{display}"), display }
}

fn single_source_line(line: usize) -> SourceLines {
	smallvec![line]
}

fn line_entry_sources(entries: &[LineEntry<'_>]) -> Vec<SourceLines> {
	entries
		.iter()
		.map(|entry| match entry {
			LineEntry::Line { line_number, .. } => single_source_line(*line_number),
			LineEntry::Ellipsis => SmallVec::new(),
		})
		.collect()
}

fn rendered_line_count(text: &str) -> usize {
	text.bytes().filter(|byte| *byte == b'\n').count() + 1
}

fn pad_unmapped_to_text(text: &str, source_lines: &mut Vec<SourceLines>) {
	source_lines.resize_with(rendered_line_count(text), SmallVec::new);
}

fn prepend_snapshot_header(output: &mut String, snapshot: Option<SnapshotHeader<'_>>) {
	let Some(snapshot) = snapshot else {
		return;
	};
	let header = format_read_hashline_header(snapshot.anchor, snapshot.tag);
	let mut framed = String::with_capacity(header.len() + 1 + output.len());
	framed.push_str(header.as_ref());
	framed.push('\n');
	framed.push_str(output);
	*output = framed;
}

fn normalize_line_spans(spans: &[LineSpan], total_lines: usize) -> Vec<LineSpan> {
	if total_lines == 0 {
		return Vec::new();
	}
	let mut normalized: Vec<LineSpan> = spans
		.iter()
		.filter_map(|span| {
			let start_line = span.start_line.max(1);
			let end_line = span.end_line.min(total_lines);
			(end_line >= start_line).then_some(LineSpan { start_line, end_line })
		})
		.collect();
	normalized.sort_unstable_by_key(|span| (span.start_line, span.end_line));
	let mut merged: Vec<LineSpan> = Vec::with_capacity(normalized.len());
	for span in normalized {
		if let Some(previous) = merged.last_mut()
			&& span.start_line <= previous.end_line.saturating_add(1)
		{
			previous.end_line = previous.end_line.max(span.end_line);
			continue;
		}
		merged.push(span);
	}
	merged
}

fn find_block_context_lines(
	full_lines: &[&str],
	visible: &BTreeSet<usize>,
	source: BlockContextSource<'_>,
) -> BTreeSet<usize> {
	if visible.is_empty() || (!full_lines.is_empty() && visible.len() >= full_lines.len()) {
		return BTreeSet::new();
	}
	if source.path.is_some() || source.language.is_some() {
		let ranges = visible_set_to_spans(visible)
			.into_iter()
			.filter_map(|span| {
				Some(AstLineRange {
					start_line: u32::try_from(span.start_line).ok()?,
					end_line:   u32::try_from(span.end_line).ok()?,
				})
			})
			.collect();
		let native = enclosing_block_boundaries(EnclosingBoundaryOptions {
			code: full_lines.join("\n"),
			lang: source.language.map(str::to_owned),
			path: source.path.map(str::to_owned),
			ranges,
		});
		if let Ok(Some(boundaries)) = native {
			return boundaries
				.into_iter()
				.map(|line| line as usize)
				.filter(|line| *line > 0 && *line <= full_lines.len() && !visible.contains(line))
				.collect();
		}
	}
	lexical_bracket_context(full_lines, visible)
}

fn visible_set_to_spans(visible: &BTreeSet<usize>) -> Vec<LineSpan> {
	let mut spans: Vec<LineSpan> = Vec::new();
	for &line in visible {
		if let Some(previous) = spans.last_mut()
			&& line <= previous.end_line.saturating_add(1)
		{
			previous.end_line = line;
			continue;
		}
		spans.push(LineSpan { start_line: line, end_line: line });
	}
	spans
}

#[derive(Clone, Copy)]
struct StackEntry {
	opener:      u8,
	line_number: usize,
	visible:     bool,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScannerMode {
	Code,
	Single,
	Double,
	Template,
	BlockComment,
}

fn lexical_bracket_context(full_lines: &[&str], visible: &BTreeSet<usize>) -> BTreeSet<usize> {
	let mut context = BTreeSet::new();
	let mut stack: Vec<StackEntry> = Vec::new();
	let mut mode = ScannerMode::Code;
	let mut escaped = false;

	for (line_index, line) in full_lines.iter().enumerate() {
		let line_number = line_index + 1;
		let line_visible = visible.contains(&line_number);
		let bytes = line.as_bytes();
		let mut index = 0;
		while index < bytes.len() {
			let byte = bytes[index];
			let next = bytes.get(index + 1).copied();
			if mode == ScannerMode::BlockComment {
				if byte == b'*' && next == Some(b'/') {
					mode = ScannerMode::Code;
					index += 2;
				} else {
					index += 1;
				}
				continue;
			}
			if matches!(mode, ScannerMode::Single | ScannerMode::Double | ScannerMode::Template) {
				if escaped {
					escaped = false;
					index += 1;
					continue;
				}
				if byte == b'\\' {
					escaped = true;
					index += 1;
					continue;
				}
				if (mode == ScannerMode::Single && byte == b'\'')
					|| (mode == ScannerMode::Double && byte == b'"')
					|| (mode == ScannerMode::Template && byte == b'`')
				{
					mode = ScannerMode::Code;
				}
				index += 1;
				continue;
			}
			if byte == b'/' && next == Some(b'/') {
				break;
			}
			if byte == b'/' && next == Some(b'*') {
				mode = ScannerMode::BlockComment;
				index += 2;
				continue;
			}
			if byte == b'#'
				&& bytes[..index]
					.iter()
					.all(|byte| matches!(byte, b' ' | b'\t'))
			{
				break;
			}
			match byte {
				b'\'' => mode = ScannerMode::Single,
				b'"' => mode = ScannerMode::Double,
				b'`' => mode = ScannerMode::Template,
				b'(' | b'[' | b'{' => {
					stack.push(StackEntry { opener: byte, line_number, visible: line_visible });
				},
				b')' | b']' | b'}' => {
					let opener = match byte {
						b')' => b'(',
						b']' => b'[',
						_ => b'{',
					};
					if let Some(match_index) = stack.iter().rposition(|entry| entry.opener == opener) {
						let matched = stack[match_index];
						stack.truncate(match_index);
						if line_visible && !matched.visible {
							context.insert(matched.line_number);
						}
						if matched.visible && !line_visible {
							context.insert(line_number);
						}
					}
				},
				_ => {},
			}
			index += 1;
		}
		if matches!(mode, ScannerMode::Single | ScannerMode::Double) {
			mode = ScannerMode::Code;
			escaped = false;
		}
	}
	for line in visible {
		context.remove(line);
	}
	context
}

/// Formats a byte count using the shared byte-size format.
pub(crate) fn format_bytes(bytes: u64) -> String {
	if bytes < 1024 {
		format!("{bytes}B")
	} else if bytes < 1024 * 1024 {
		format!("{:.1}KB", bytes as f64 / 1024.0)
	} else if bytes < 1024 * 1024 * 1024 {
		format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
	} else {
		format!("{:.1}GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
	}
}

fn normalize_display_separators(mut path: String) -> String {
	if MAIN_SEPARATOR != '/' {
		path = path.replace(MAIN_SEPARATOR, "/");
	}
	path
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn out_of_bounds_offset_is_only_a_structured_diag() {
		let selector = super::super::selector::parse_selector(Some("9")).unwrap();
		let rendered = format_text("one\ntwo", &selector, TextFormatOptions::new("file"));
		assert!(rendered.text.is_empty());
		let [diag] = rendered.diags.as_slice() else {
			panic!("out-of-bounds offset emits one diagnostic");
		};
		assert_eq!(diag.native_kind(), Some(DiagKind::RangeOutOfBounds));
		assert_eq!(diag.severity, omp_tool::Severity::Warn);
		assert_eq!(diag.continuation.as_deref(), Some(":1"));
	}

	#[test]
	fn summary_diag_names_the_exact_multi_range_recovery_selector() {
		let diag = summary_elision_diag(
			"src/lib.rs",
			&[ElidedRange { start: 5, end: 16 }, ElidedRange { start: 960, end: 973 }],
			26,
		)
		.expect("elided ranges produce a diagnostic");
		assert_eq!(diag.native_kind(), Some(DiagKind::SummaryElided));
		assert_eq!(diag.severity, omp_tool::Severity::Info);
		assert_eq!(diag.continuation.as_deref(), Some("src/lib.rs:5-16,960-973"));
		assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 26, unit: omp_tool::Unit::Lines }));
	}
}
