//! Centralized error/warning text for the hashline parser, applier, and
//! patcher. Port of `packages/hashline/src/messages.ts`.

use std::{
	collections::{BTreeSet, HashSet},
	fmt::Write,
};

use super::format::format_numbered_line;
pub use super::types::BlockSpan;

const HL_FILE_PREFIX: &str = "[";
const HL_FILE_SUFFIX: &str = "]";
const HL_PAYLOAD_REPLACE: &str = "+";
const HL_PUT_KEYWORD: &str = "PUT";
const HL_CUT_KEYWORD: &str = "CUT";
const HL_FILE_HASH_SEP: &str = "#";
const HL_RANGE_SEP: &str = ".=";

/// Tiny JS-compatible `JSON.stringify(str)` that escapes `"`, `\`, and control
/// characters, emitting other UTF-8 characters as-is.
pub fn json_quote(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 2);
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\x08' => out.push_str("\\b"),
			'\x0C' => out.push_str("\\f"),
			c if (c as u32) < 0x20 => {
				use std::fmt::Write;
				let _ = write!(out, "\\u{:04x}", c as u32);
			},
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// Lines of context shown either side of a hash mismatch.
pub const MISMATCH_CONTEXT: u32 = 2;

/// Line numbers [`format_anchored_context`] displays: each in-range anchor
/// ±[`MISMATCH_CONTEXT`], ascending.
pub fn anchored_context_lines(anchor_lines: &[u32], line_count: usize) -> BTreeSet<u32> {
	let mut display_lines = BTreeSet::new();
	for &line in anchor_lines {
		if line < 1 || (line as usize) > line_count {
			continue;
		}
		let lo = line.saturating_sub(MISMATCH_CONTEXT).max(1);
		let hi = (line + MISMATCH_CONTEXT).min(line_count as u32);
		display_lines.extend(lo..=hi);
	}
	display_lines
}

/// Numbered `LINE:TEXT` rows around `anchor_lines` (±[`MISMATCH_CONTEXT`]),
/// `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
/// contribute no rows.
pub fn format_anchored_context<S: AsRef<str>>(
	anchor_lines: &[u32],
	file_lines: &[S],
) -> Vec<String> {
	let display_lines = anchored_context_lines(anchor_lines, file_lines.len());
	let anchor_set: HashSet<u32> = anchor_lines.iter().copied().collect();
	let mut rows = Vec::new();
	let mut previous: Option<u32> = None;
	for &line_num in &display_lines {
		if let Some(prev) = previous
			&& line_num > prev + 1
		{
			rows.push("...".to_string());
		}
		previous = Some(line_num);
		let marker = if anchor_set.contains(&line_num) {
			"*"
		} else {
			" "
		};
		let text = file_lines
			.get((line_num - 1) as usize)
			.map_or("", |s| s.as_ref());
		rows.push(format!("{marker}{}", format_numbered_line(line_num, text)));
	}
	rows
}

/// Concrete range operation rejected because its absolute end precedes its
/// start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AbsoluteRangeOp {
	Replace,
	Cut,
}

impl std::fmt::Display for AbsoluteRangeOp {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Replace => write!(f, "replace"),
			Self::Cut => write!(f, "cut"),
		}
	}
}

fn reg_suffix(register: Option<&str>) -> String {
	register.map_or_default(|reg| format!(" @{reg}"))
}

fn range_op_single(op: AbsoluteRangeOp, line: u32, register: Option<&str>) -> String {
	let suffix = reg_suffix(register);
	match op {
		AbsoluteRangeOp::Replace => {
			if register.is_some() {
				format!("{HL_PUT_KEYWORD} {line}{suffix}")
			} else {
				format!("{HL_PUT_KEYWORD} {line}:")
			}
		},
		AbsoluteRangeOp::Cut => format!("{HL_CUT_KEYWORD} {line}{suffix}"),
	}
}

fn range_op_range(op: AbsoluteRangeOp, start: u32, end: u32, register: Option<&str>) -> String {
	let suffix = reg_suffix(register);
	match op {
		AbsoluteRangeOp::Replace => {
			if register.is_some() {
				format!("{HL_PUT_KEYWORD} {start}{HL_RANGE_SEP}{end}{suffix}")
			} else {
				format!("{HL_PUT_KEYWORD} {start}{HL_RANGE_SEP}{end}:")
			}
		},
		AbsoluteRangeOp::Cut => format!("{HL_CUT_KEYWORD} {start}{HL_RANGE_SEP}{end}{suffix}"),
	}
}

fn block_form_at(op: AbsoluteRangeOp, line: u32, register: Option<&str>) -> String {
	let suffix = reg_suffix(register);
	match op {
		AbsoluteRangeOp::Replace => {
			if register.is_some() {
				format!("{HL_PUT_KEYWORD} {line}*{suffix}")
			} else {
				format!("{HL_PUT_KEYWORD} {line}*:")
			}
		},
		AbsoluteRangeOp::Cut => format!("{HL_CUT_KEYWORD} {line}*{suffix}"),
	}
}

/// Explain absolute range endpoints and provide safe, non-applying retry forms.
pub fn invalid_absolute_range_message(
	patch_line: u32,
	start: u32,
	end: u32,
	op: AbsoluteRangeOp,
	block: Option<BlockSpan>,
	register: Option<&str>,
) -> String {
	let single = range_op_single(op, start, register);
	let counted_end = start.checked_add(end).and_then(|sum| sum.checked_sub(1));
	let counted = match counted_end {
		Some(counted_end) if counted_end >= start => {
			Some(range_op_range(op, start, counted_end, register))
		},
		_ => None,
	};
	let block_form = block_form_at(op, start, register);
	let mut message = format!(
		"line {patch_line}: Invalid absolute range: start {start}, end {end}. The value after \
		 `{HL_RANGE_SEP}` is an absolute source line, not a line count or replacement length. For \
		 one line use `{single}`."
	);
	if let Some(counted) = counted {
		let _ = write!(message, " For {end} lines starting at {start}, use `{counted}`.");
	}
	if let Some(b) = block
		&& b.start == start
		&& b.end > start
	{
		let _ = write!(
			message,
			" The syntactic block beginning at {start} ends at {}, so `{block_form}` is also valid.",
			b.end
		);
	}
	message
}

/// Optional patch envelope start marker; silently consumed.
pub const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";

/// Optional patch envelope end marker; terminates parsing.
pub const END_PATCH_MARKER: &str = "*** End Patch";

/// Truncation sentinel emitted by an agent loop mid-call. Ends parsing like
/// [`END_PATCH_MARKER`], without a warning.
pub const ABORT_MARKER: &str = "*** Abort";

/// Exact-range duplicate hunks were normalized to the final hunk.
pub const REPLACE_PAIR_COALESCED_WARNING: &str = "Multiple hunks targeted the same exact range; \
                                                  kept only the last. Issue one `PUT` or `CUT` \
                                                  hunk per range.";

/// Bare body rows auto-converted to literal `+` rows.
pub const BARE_BODY_AUTO_PIPED_WARNING: &str =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";

/// A bare row shaped like a hunk or file header that did not parse as one.
///
/// Auto-prefixing it would write a mistyped op (`PUT 789*=821:`) or a
/// malformed second-file header into the file as text.
pub fn malformed_header_row_message(text: &str) -> String {
	format!(
		"{} looks like a hunk or file header but does not parse as one, so it was neither run nor \
		 written. Ops: `PUT N.=M:`, `PUT N*:`, `PUT <N:`, `PUT >N:`, `CUT N.=M`, `CUT N*`, `REM`, \
		 `MV DEST`; a file header is `[PATH#TAG]` alone at the start of a line. If the row is \
		 literal file content, prefix it with `+`.",
		json_quote(text)
	)
}

/// Top-level read-output rows recovered as single-line replacements.
pub const SNAPSHOT_ROWS_AUTO_PUT_WARNING: &str = "Recovered top-level `N:TEXT` snapshot row(s) as \
                                                  single-line `PUT N.=N:` replacements. Use \
                                                  explicit `PUT` headers for reliable edits.";

/// Two or more top-level `N:TEXT` read-output rows named the same source line.
///
/// Each recovered row lowers to a single-line `PUT N.=N:`, so the coalescer
/// would keep only the last and silently drop the others — reject and teach the
/// format instead.
pub fn repeated_snapshot_row_message(line: u32) -> String {
	format!(
		"two or more pasted `{line}:TEXT` read-output rows name line {line}. Such rows are \
		 recovered as single-line `PUT {line}{HL_RANGE_SEP}{line}:` replacements, so repeating a \
		 number would keep only the last row and drop the rest. Write the hunk explicitly: one `PUT \
		 {line}{HL_RANGE_SEP}M:` header covering exactly the lines that change, followed by `+TEXT` \
		 body rows holding their complete final content."
	)
}

/// A `+` body row whose text is itself a valid hunk header.
///
/// The op was written with the payload prefix, so it is inserted into the file
/// as literal text instead of executing. Warned rather than rejected: a literal
/// `CUT …` line is legitimate content in documentation and test fixtures.
pub fn literal_op_row_warning(line: u32, text: &str) -> String {
	format!(
		"line {line}: body row `{HL_PAYLOAD_REPLACE}{text}` is itself a valid hunk header, so it \
		 was inserted into the file as literal text rather than executed. Ops are never \
		 `{HL_PAYLOAD_REPLACE}`-prefixed — drop the `{HL_PAYLOAD_REPLACE}` to run it, and re-issue \
		 if this line landed in the file by mistake."
	)
}

/// Bare range header recovered as an implicit replacement hunk.
pub const BARE_RANGE_AUTO_PUT_WARNING: &str =
	"Recovered a bare `N.=M:` header as `PUT N.=M:`. Prefix replacement ranges with `PUT`.";

/// Copied read-output elision rows were ignored rather than written as source.
pub const READ_METADATA_IGNORED_WARNING: &str =
	"Ignored copied read-output elision row(s). Re-read elided ranges before editing them.";

/// Empty span/block PUT recovered as a delete-only edit.
pub const EMPTY_PUT_AUTO_CUT_WARNING: &str =
	"Interpreted an empty `PUT` body as deletion. Use `CUT N.=M` or `CUT N*` for bodyless deletes.";

/// A bodyless CUT carried a harmless trailing colon.
pub const CUT_COLON_IGNORED_WARNING: &str =
	"Ignored a trailing `:` on bodyless `CUT`. Prefer `CUT N.=M` / `CUT N*` without a colon.";

/// Bare `-` body rows accepted as literal Markdown bullets.
///
/// Only emitted when the hunk is unambiguously a bullet list: every `-` row is
/// bullet-shaped (`- item`) and the body has no unified-diff `+new` counterpart
/// rows.
pub const MINUS_BULLET_AUTO_PIPED_WARNING: &str =
	"Auto-prefixed bare `- ` bullet row(s) as literal content. `-` rows never remove lines — the \
	 range does that; always prefix literal body rows with `+`: `+- item`.";

/// Unified-diff old rows were discarded; explicit `+` rows are final content.
pub const DIFF_OLD_ROWS_IGNORED_WARNING: &str = "Ignored unified-diff `-old` row(s); the range \
                                                 already removes old content, so only `+new` rows \
                                                 were kept.";

/// Unified-diff-style `-` row in a hunk body.
pub const MINUS_ROW_REJECTED: &str = "`-` rows are not valid; the range already names the lines \
                                      being changed. For Markdown bullets or other literal `-` \
                                      lines, prefix the literal row with `+`: `+- item`.";

/// Optional source-aware suggestions appended to block-anchor diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BlockDiagnosticSuggestions {
	/// Closest following multi-line block that begins after the authored anchor.
	pub next_block:      Option<BlockSpan>,
	/// Closest preceding multi-line block whose span contains the authored
	/// anchor.
	pub enclosing_block: Option<BlockSpan>,
}

/// How far block locators reach in the target file's language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockCoverage {
	/// A grammar covers the whole file.
	Full,
	/// No tree-sitter grammar for this file type.
	NoGrammar,
	/// Single-file components (Vue, Svelte, Astro): the grammar leaves
	/// embedded `<script>`/`<style>` sections unparsed.
	NoEmbedded,
}

/// A block-anchored replace/cut could not resolve to a syntactic block.
/// Appends a [`format_anchored_context`] preview when `file_lines` is given.
/// `PUT >N*` never reaches this path; it lowers to `PUT >N`.
pub fn block_unresolved_message(
	line: u32,
	op: AbsoluteRangeOp,
	file_lines: Option<&[&str]>,
	suggestions: &BlockDiagnosticSuggestions,
	register: Option<&str>,
	coverage: BlockCoverage,
) -> String {
	let phrase = block_form_at(op, line, register);
	let fallback = match op {
		AbsoluteRangeOp::Replace => {
			if let Some(reg) = register {
				format!("{HL_PUT_KEYWORD} {line}{HL_RANGE_SEP}M @{reg}")
			} else {
				format!("{HL_PUT_KEYWORD} {line}{HL_RANGE_SEP}M:")
			}
		},
		AbsoluteRangeOp::Cut => {
			if let Some(reg) = register {
				format!("{HL_CUT_KEYWORD} {line}{HL_RANGE_SEP}M @{reg}")
			} else {
				format!("{HL_CUT_KEYWORD} {line}{HL_RANGE_SEP}M")
			}
		},
	};
	let anchor_text =
		file_lines.and_then(|lines| lines.get((line.saturating_sub(1)) as usize).copied());
	let next_block = suggestions.next_block;
	let blank_anchor = anchor_text.is_some_and(|text| text.trim().is_empty());
	let mut message = if let (true, Some(next)) = (blank_anchor, next_block) {
		let retry = block_form_at(op, next.start, register);
		format!(
			"Line {line} is blank; no syntactic block can begin there. The next multi-line block \
			 begins at line {} and ends at line {}. Retry `{retry}`.",
			next.start, next.end
		)
	} else {
		let reason = match coverage {
			BlockCoverage::Full => "(blank/closer line, or parse error)",
			BlockCoverage::NoGrammar => {
				"(block locators need a tree-sitter grammar, and this file type has none)"
			},
			BlockCoverage::NoEmbedded => {
				"(blank/closer line, parse error, or a line inside an embedded `<script>`/`<style>` \
				 section, which block locators do not reach)"
			},
		};
		format!(
			"`{phrase}` could not resolve a syntactic block beginning on line {line} {reason}. Use \
			 `{fallback}` with explicit lines."
		)
	};
	if let Some(enclosing_block) = suggestions.enclosing_block {
		let retry = block_form_at(op, enclosing_block.start, register);
		let _ = write!(
			message,
			" The nearest enclosing multi-line block begins at line {} and ends at line {}; use \
			 `{retry}` to target it.",
			enclosing_block.start, enclosing_block.end
		);
	}
	if let Some(file_lines) = file_lines {
		let context = format_anchored_context(&[line], file_lines);
		if !context.is_empty() {
			message.push_str("\n\n");
			message.push_str(&context.join("\n"));
		}
	}
	message
}

/// Block-anchored edit reached a path with no `BlockResolver` wired in.
pub const BLOCK_RESOLVER_UNAVAILABLE: &str = "Block locators (`N*` in `PUT N*:`, `PUT >N*`, `CUT \
                                              N*`) are not available here (no block resolver \
                                              configured). Use a concrete line range.";

fn closer_lowered_warning(block_form: &str, plain_form: &str) -> String {
	format!(
		"`{block_form}` anchors on a closing delimiter, so it was applied as plain `{plain_form}`. \
		 Anchor on the line that OPENS the construct."
	)
}

fn unresolved_lowered_warning(block_form: &str, line: u32, plain_form: &str) -> String {
	format!(
		"`{block_form}` could not resolve a syntactic block on line {line}, so it was applied as \
		 plain `{plain_form}`. Verify the landing line; anchor on a line that OPENS a construct."
	)
}

/// `PUT >N*:` anchored on a closing-delimiter line; applied as `PUT >N:`.
pub fn insert_after_block_closer_lowered_warning(line: u32) -> String {
	closer_lowered_warning(&format!("PUT >{line}*:"), &format!("PUT >{line}:"))
}

/// `PUT >N*:` anchor unresolvable; applied as `PUT >N:`.
pub fn insert_after_block_unresolved_lowered_warning(line: u32) -> String {
	unresolved_lowered_warning(&format!("PUT >{line}*:"), line, &format!("PUT >{line}:"))
}

/// Register `PUT >N*` anchored on a closing-delimiter line; applied as
/// `PUT >N`.
pub fn paste_after_block_closer_lowered_warning(line: u32) -> String {
	closer_lowered_warning(&format!("PUT >{line}*"), &format!("PUT >{line}"))
}

/// Register `PUT >N*` anchor unresolvable; applied as `PUT >N`.
pub fn paste_after_block_unresolved_lowered_warning(line: u32) -> String {
	unresolved_lowered_warning(&format!("PUT >{line}*"), line, &format!("PUT >{line}"))
}

/// Which boundary side an ambiguous echo appeared on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BoundarySide {
	Leading,
	Trailing,
}

impl std::fmt::Display for BoundarySide {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Leading => write!(f, "leading"),
			Self::Trailing => write!(f, "trailing"),
		}
	}
}

/// A one-sided exact boundary echo cannot cover the selected range.
///
/// With the duplicated body rows set aside, applying it would lose distinct
/// range content, so the edit is rejected. `left_out` is
/// the inclusive span of range rows the body does not cover when the echo is
/// read as a range shifted by `count` lines.
pub fn ambiguous_boundary_echo_message(
	start_line: u32,
	end_line: u32,
	side: BoundarySide,
	count: u32,
	left_out: (u32, u32),
) -> String {
	let where_clause = match side {
		BoundarySide::Leading => {
			format!("opens by restating the {count} line(s) just above the range")
		},
		BoundarySide::Trailing => {
			format!("ends by restating the {count} line(s) just below the range")
		},
	};
	let left_out = line_span(left_out);
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body {where_clause}, but is too \
		 short to be the full final content of the selected range. If the range is off by those \
		 line(s), the body leaves out {left_out}, which this edit would delete. Re-issue with the \
		 range covering exactly the lines that change and the body as their complete final content."
	)
}

/// A body restates the lines next to the range more than once.
///
/// One copy is read as the echo of those lines, and the body still opens (or
/// ends) with them. `left_out` is the inclusive span of range rows the body
/// leaves out once every row that restates a line outside the range is set
/// aside; applying the edit would delete them.
pub fn repeated_boundary_echo_message(
	start_line: u32,
	end_line: u32,
	side: BoundarySide,
	count: u32,
	left_out: (u32, u32),
) -> String {
	let where_clause = match side {
		BoundarySide::Leading => {
			format!("opens by restating the {count} line(s) just above the range more than once")
		},
		BoundarySide::Trailing => {
			format!("ends by restating the {count} line(s) just below the range more than once")
		},
	};
	let left_out = line_span(left_out);
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body {where_clause}. With the \
		 rows that restate lines just outside the range read as those lines, the body is too short \
		 to be the full final content of the selected range: it leaves out {left_out}, which this \
		 edit would delete. Re-issue with the range covering exactly the lines that change and the \
		 body as their complete final content."
	)
}

/// A body restates both neighbouring lines but is too short for the range.
///
/// With both neighbours restated the range cannot be shifted, so the rows
/// left once the restated rows are set aside are the only content the body
/// offers, and they are fewer than the range. `repeated`: the body restates
/// them more than once. `left_out` is the inclusive span of range rows past
/// those rows; applying the edit would delete them.
pub fn two_sided_boundary_echo_message(
	start_line: u32,
	end_line: u32,
	above: u32,
	below: u32,
	repeated: bool,
	left_out: (u32, u32),
) -> String {
	let left_out = line_span(left_out);
	let repeated = if repeated { " more than once" } else { "" };
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body restates both the {above} \
		 line(s) just above and the {below} line(s) just below the range{repeated}, and once the \
		 rows that restate lines outside the range are set aside, the rows left are too few to be \
		 the full final content of the selected range: they leave out {left_out}, which this edit \
		 would delete. Re-issue with the range covering exactly the lines that change and the body \
		 as their complete final content."
	)
}

/// What a patch would do to a range whose body restates a neighbouring line.
///
/// `above` / `below` are the spans of neighbouring lines the body's edge rows
/// repeat; `left_out` is the span of range rows past the rows the body
/// supplies once those copies are set aside. At least one is set.
pub fn boundary_echo_outcome_message(
	start_line: u32,
	end_line: u32,
	above: Option<(u32, u32)>,
	below: Option<(u32, u32)>,
	left_out: Option<(u32, u32)>,
) -> String {
	let mut effects = Vec::new();
	if let Some(span) = above {
		effects.push(format!("write {} (just above the range) a second time", line_span(span)));
	}
	if let Some(span) = below {
		effects.push(format!("write {} (just below the range) a second time", line_span(span)));
	}
	if let Some(span) = left_out {
		effects.push(format!("leave out {} of the range, deleting it", line_span(span)));
	}
	let extend = match (above, below) {
		(Some((first, _)), Some((_, last))) => format!("{first}{HL_RANGE_SEP}{last}"),
		(Some((first, _)), None) => format!("{first}{HL_RANGE_SEP}{end_line}"),
		(None, Some((_, last))) => format!("{start_line}{HL_RANGE_SEP}{last}"),
		(None, None) => format!("{start_line}{HL_RANGE_SEP}{end_line}"),
	};
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body restates lines next to the \
		 range, and as written the result would {}. Nothing was applied. Re-issue with the range \
		 covering exactly the lines that change and the body as their complete final content; if \
		 the repeated line is meant to appear twice, use `PUT {extend}:` and write both copies.",
		effects.join(" and ")
	)
}

fn line_span((first, last): (u32, u32)) -> String {
	if first == last {
		format!("line {first}")
	} else {
		format!("lines {first}-{last}")
	}
}

/// Rejection for a selected edge that may stay on either side of the payload.
///
/// Indentation does not establish which placement was intended. `error_line`
/// is where tree-sitter reports the first syntax error in the patch as
/// written.
pub fn ambiguous_boundary_placement_message(
	start_line: u32,
	end_line: u32,
	error_line: Option<u32>,
) -> String {
	let at = error_line.map_or_default(|line| format!(" (first syntax error near line {line})"));
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: as written the file would no longer \
		 parse{at}. A selected boundary row is required for the file to parse, but the body \
		 indentation does not establish whether it belongs before or after that row. Re-read the \
		 region and re-issue with a range that excludes every unchanged boundary row."
	)
}

/// A one-row replacement fails to parse only because its body ends in a
/// comma the surrounding syntax rejects (the last element of a JSON array).
pub fn trailing_comma_replacement_message(start_line: u32, end_line: u32) -> String {
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body's last non-blank row ends \
		 with a comma that does not parse in place (e.g. a trailing comma before a closing `]` or \
		 `}}`); without that comma this replacement parses. Drop the comma, or include the rows \
		 that should follow it in the same body."
	)
}

/// One replacement's parse-restoring change, suggested by a rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundaryFix {
	pub start:         u32,
	pub end:           u32,
	/// A selected range row the fix keeps instead of replacing.
	pub keep:          Option<u32>,
	/// Leading body rows the fix drops: they repeat the lines just above.
	pub drop_leading:  u32,
	/// Trailing body rows the fix drops: they repeat the lines just below.
	pub drop_trailing: u32,
}

/// Rejection for a patch that breaks a file a boundary change would keep
/// parsing.
///
/// The boundary change keeps a selected row or drops body rows that repeat a
/// neighbour. Nothing is applied: the body is never rewritten.
pub fn boundary_fix_message(fixes: &[BoundaryFix], error_line: Option<u32>) -> String {
	let at = error_line.map_or_default(|line| format!(" (first syntax error near line {line})"));
	let clauses = fixes
		.iter()
		.map(|fix| {
			let (start, end) = (fix.start, fix.end);
			let mut parts = Vec::new();
			if let Some(line) = fix.keep {
				let form = if start == end {
					Some(format!("PUT <{start}:"))
				} else if line == start {
					Some(format!("PUT {}{HL_RANGE_SEP}{end}:", start + 1))
				} else if line == end {
					Some(format!("PUT {start}{HL_RANGE_SEP}{}:", end - 1))
				} else {
					None
				};
				parts.push(form.map_or_else(
					|| format!("line {line} stays after the body"),
					|form| format!("line {line} stays (use `{form}`)"),
				));
			}
			if fix.drop_leading > 0 {
				parts.push(format!(
					"its first {} body row(s), which repeat the line(s) just above the range, are \
					 dropped",
					fix.drop_leading
				));
			}
			if fix.drop_trailing > 0 {
				parts.push(format!(
					"its last {} body row(s), which repeat the line(s) just below the range, are \
					 dropped",
					fix.drop_trailing
				));
			}
			format!("for `PUT {start}{HL_RANGE_SEP}{end}:` {}", parts.join(" and "))
		})
		.collect::<Vec<_>>()
		.join("; ");
	format!(
		"Edit rejected: the file parses now but would not after this edit as written{at}. It parses \
		 if, {clauses}. Nothing was applied. If that is what you meant, re-issue it that way; \
		 otherwise correct the body so the result parses."
	)
}

/// The applied result no longer parses while the pre-edit content did, and a
/// syntax error touches the edited lines.
///
/// Advisory, never a rejection. Tree-sitter grammars have gaps, so a valid
/// construct can read as an error; `error_line` is where it reports one.
pub fn edit_broke_parse_warning(error_line: u32) -> String {
	format!(
		"Tree-sitter parsed this file before the edit but reports a syntax error near line \
		 {error_line} after it, within the edited lines. Re-read that region and fix it if the edit \
		 broke it; if the code is valid, this is a parser limitation and needs no action."
	)
}

/// Internal invariant: `applyEdits` received an unresolved block edit;
/// `resolveBlockEdits` must run first.
pub const UNRESOLVED_BLOCK_INTERNAL: &str =
	"internal error: unresolved block edit reached the applier (resolveBlockEdits was not run).";

/// Internal invariant: clipboard edits must be concrete before application.
pub const UNRESOLVED_CLIPBOARD_INTERNAL: &str = "internal error: unresolved clipboard edit \
                                                 reached the applier (resolveClipboardEdits was \
                                                 not run).";

/// `REM` deletes the whole file and takes no body rows or line ops beyond
/// bodyless `CUT`s, which capture lines into a register first.
pub const REM_TAKES_NO_BODY: &str = "`REM` deletes the whole file and takes no body rows or line \
                                     ops other than bodyless `CUT`s. Issue it alone under the \
                                     header, or after the `CUT`s that capture lines to move.";

/// `MV DEST` does not take body rows. Put line edits above the `MV` row; the
/// destination path follows `MV` on the same line.
pub const MOVE_TAKES_NO_BODY: &str = "`MV DEST` does not take body rows. Put line edits above the \
                                      `MV` row; the destination path follows `MV` on the same \
                                      line.";

/// `CUT` hunk received a body row.
pub const CUT_TAKES_NO_BODY: &str = "`CUT` deletes (and captures) the named lines and takes no \
                                     body rows. To write new content, use `PUT N.=M:` with \
                                     `+TEXT` rows.";

/// Register `PUT` header carried a `:`.
pub const COLON_ON_REGISTER_PUT: &str = "`PUT … @name` pastes the register and never takes `:` — \
                                         the colon promises body rows. Drop the colon (`PUT >40 \
                                         @name`), or drop `@name` and write `+TEXT` body rows.";

/// Register `PUT` hunk received a body row.
pub const REGISTER_PUT_TAKES_NO_BODY: &str = "A register `PUT` pastes captured lines and takes no \
                                              `+` body rows. To write literal text, drop the \
                                              `@name` and use `PUT …:` with body rows.";

/// Colonless `PUT` hunk received a body row.
pub const COLONLESS_PUT_TAKES_NO_BODY: &str = "`PUT` without `:` is clipboard-backed and takes no \
                                               body rows. Add `:` after the locator to write \
                                               literal content (`PUT >40:` then `+TEXT` rows).";

/// Colonless anonymous `PUT` on a span target.
pub const COLONLESS_SPAN_PUT: &str = "Colonless `PUT` is clipboard-backed, and span targets need \
                                      a named register (`PUT 5.=9 @name`); the anonymous register \
                                      pastes only at gaps (`PUT >40`). To write literal content, \
                                      add `:` and `+TEXT` body rows.";

/// Anonymous paste ran with an empty anonymous register.
pub const EMPTY_PASTE: &str = "Nothing to paste: no unlabeled `CUT` precedes this `PUT` in this \
                               call, and the anonymous register never carries across calls. Put \
                               `CUT N.=M` / `CUT N*` above it, or use named registers (`CUT … \
                               @name` → `PUT … @name`) for cross-call moves.";

/// Named paste read a register that holds nothing; a gap paste applies as
/// empty.
pub fn empty_register_paste_warning(name: &str, known: &[&str]) -> String {
	let base = format!(
		"`@{name}` was empty — no `CUT … @{name}` precedes this op in this call and no persisted \
		 register has that name — so nothing was pasted."
	);
	if known.is_empty() {
		base
	} else {
		let available = known
			.iter()
			.map(|k| format!("`@{k}`"))
			.collect::<Vec<_>>()
			.join(", ");
		format!("{base} Available registers: {available}.")
	}
}

/// Named paste over a *span* read a register that holds nothing.
///
/// Pasting empty would delete the span, which the author never asked for —
/// almost always a mistyped or never-captured register name — so the edit is
/// rejected instead.
pub fn empty_register_span_paste_message(name: &str, known: &[&str]) -> String {
	let base = format!(
		"`@{name}` is empty — no `CUT … @{name}` precedes this op in this call and no persisted \
		 register has that name — so pasting it over a range would delete those lines and write \
		 nothing back. Capture the register first (`CUT … @{name}`), or use `CUT` if deleting the \
		 range is what you meant."
	);
	if known.is_empty() {
		base
	} else {
		let available = known
			.iter()
			.map(|k| format!("`@{k}`"))
			.collect::<Vec<_>>()
			.join(", ");
		format!("{base} Available registers: {available}.")
	}
}

/// Unlabeled paste with two or more unlabeled cuts pending.
pub fn ambiguous_anonymous_paste_message(pending: &[&str]) -> String {
	let count = pending.len();
	let joined = pending.join(", ");
	format!(
		"{count} unlabeled `CUT`s are pending ({joined}) — an unlabeled paste cannot tell which one \
		 you meant. Label the moves (`CUT … @name` → `PUT … @name`), or keep at most one unlabeled \
		 `CUT` before each unlabeled paste."
	)
}

/// Clipboard ops in a same-path section merged across another file's section.
///
/// Same-path sections coalesce into their first occurrence, so an interleaved
/// layout would silently reorder the register sequence.
pub const CLIPBOARD_INTERLEAVED_SECTIONS: &str =
	"`CUT`/register-`PUT` ops cannot be used in a file whose sections are interleaved with another \
	 file's: same-path sections merge into the first occurrence, which would reorder the register \
	 sequence. Keep each file's ops under ONE `[path#TAG]` header.";

/// Gap `PUT` with `:` but no body.
pub const EMPTY_INSERT: &str = "`PUT <N:` / `PUT >N:` promises body rows and got none. Write \
                                `+TEXT` rows, or drop the `:` to paste a register (`PUT >N` = \
                                anonymous, `PUT >N @name` = named).";

/// Rejection for a `PUT >N:` body that only parses after the following closers.
///
/// The body is indented shallower than the anchor: the common "anchored on the
/// last line I read instead of after the block" mistake. Gap inserts never
/// move.
pub fn after_insert_landing_message(anchor_line: u32, landing_line: u32, crossed: u32) -> String {
	let s = if crossed == 1 { "" } else { "s" };
	format!(
		"`PUT >{anchor_line}:` rejected: with the body after line {anchor_line} the file would no \
		 longer parse. The body is indented shallower than line {anchor_line} and parses after line \
		 {landing_line}, past {crossed} closing line{s}. Nothing was applied. If it belongs there, \
		 re-issue as `PUT >{landing_line}:`; for the deeper position inside the block, indent the \
		 body to match."
	)
}

/// `PUT >N*:` body indented deeper than the block's closer: the patch as
/// written breaks the parse, and the body parses inside the block. Rejected;
/// `PUT >N*` always lands after the block.
pub fn block_insert_landing_message(
	block_start: u32,
	closer_line: u32,
	landing_line: u32,
) -> String {
	format!(
		"`PUT >{block_start}*:` rejected: it lands after the block's closing line {closer_line}, \
		 where the file would no longer parse. The body is indented deeper than that closer and \
		 parses inside the block, after line {landing_line}. Nothing was applied. If inside was \
		 intended, re-issue as `PUT >{landing_line}:`; otherwise indent the body to sibling depth."
	)
}

/// Plain `PUT >N:` anchored on a block-opener line with a shallower body: the
/// patch as written breaks the parse, and the body parses past the whole
/// block. Rejected; gap inserts never move.
pub fn after_insert_opener_message(anchor_line: u32, landing_line: u32) -> String {
	format!(
		"`PUT >{anchor_line}:` rejected: line {anchor_line} opens a block, so the body would land \
		 inside it, where the file would no longer parse. The body's indentation points outside the \
		 block, and it parses after line {landing_line}, past the whole construct. Nothing was \
		 applied. If it belongs there, re-issue as `PUT >{landing_line}:` or `PUT >{anchor_line}*:`."
	)
}

/// `Recovery`: an external write matched a cached snapshot.
pub const RECOVERY_EXTERNAL_WARNING: &str = "Recovered from a stale file hash using a previous \
                                             read snapshot (file changed externally between read \
                                             and edit).";

/// `Recovery`: a prior in-session edit advanced the hash.
pub const RECOVERY_SESSION_CHAIN_WARNING: &str = "Recovered from a stale file hash using an \
                                                  earlier in-session snapshot (a prior edit in \
                                                  this session advanced the hash).";

/// `Recovery`: stale anchors were relocated to unchanged live lines after
/// drift.
pub const RECOVERY_LINE_REMAP_WARNING: &str = "Recovered by remapping stale line anchors to \
                                               unchanged current lines (file changed since the \
                                               tagged read). Verify the diff matches your intent.";

/// `insert head:`/`insert tail:` applied despite a stale snapshot tag.
/// Head/tail position is content-independent, so drift is non-fatal: apply
/// onto live content and warn instead of hard-failing.
pub const HEADTAIL_DRIFT_WARNING: &str =
	"Applied the `PUT <1:`/`PUT >$:` edit despite a stale snapshot tag (file changed since your \
	 read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

/// Section named a nonexistent path matching a sandbox snapshot's name and
/// tag; the edit was rebound to that file. Surfaced as a warning so the model
/// learns the full path.
pub fn path_recovered_from_tag_message(
	authored_path: &str,
	resolved_path: &str,
	tag: &str,
) -> String {
	format!(
		"Path \"{authored_path}\" does not exist; matched its filename and snapshot tag \
		 {HL_FILE_HASH_SEP}{tag} to {resolved_path} (read earlier this session). Anchor future \
		 edits on {HL_FILE_PREFIX}{resolved_path}{HL_FILE_HASH_SEP}TAG{HL_FILE_SUFFIX}."
	)
}

/// Compress a line list into a sorted `1-4, 7, 10-12` range string.
fn format_line_ranges(lines: &[u32]) -> String {
	let set: BTreeSet<u32> = lines.iter().copied().collect();
	if set.is_empty() {
		return String::new();
	}
	let sorted: Vec<u32> = set.into_iter().collect();
	let mut parts = Vec::new();
	let mut start = sorted[0];
	let mut prev = sorted[0];
	for &current in &sorted[1..] {
		if current == prev + 1 {
			prev = current;
			continue;
		}
		if start == prev {
			parts.push(format!("{start}"));
		} else {
			parts.push(format!("{start}-{prev}"));
		}
		start = current;
		prev = current;
	}
	if start == prev {
		parts.push(format!("{start}"));
	} else {
		parts.push(format!("{start}-{prev}"));
	}
	parts.join(", ")
}

/// One anchored line whose actual content is being surfaced in an error
/// message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealedLine {
	pub line: u32,
	pub text: String,
}

/// A wide unseen anchor cannot be safely promoted by a column-capped reveal.
pub fn wide_unseen_lines_message(section_path: &str, unseen_lines: &[u32]) -> String {
	let ranges = format_line_ranges(unseen_lines);
	let selector = ranges.replace(", ", ",");
	format!(
		"This edit anchors to lines {ranges} of {section_path} that were not fully displayed. Read \
		 `{section_path}:{selector}:raw` for their full content, then re-issue the edit."
	)
}

/// No retained read records whether these over-cap anchor lines were shown
/// whole (process restart or store eviction), so their display may have been
/// cut.
pub fn unverified_wide_lines_message(section_path: &str, wide_lines: &[u32]) -> String {
	let ranges = format_line_ranges(wide_lines);
	let selector = ranges.replace(", ", ",");
	format!(
		"This edit anchors to lines {ranges} of {section_path}, which exceed the display column \
		 cap, and no retained read shows them in full. Read `{section_path}:{selector}:raw` for \
		 their full content, then re-issue the edit."
	)
}

/// Content preview handed to [`unseen_lines_message`].
///
/// `lines` are the unseen anchor lines whose actual file content we surface
/// inline (from the tagged snapshot the caller matched). `truncated` = true
/// means the anchor range exceeded the inline reveal cap; the caller only
/// revealed a prefix and the remaining unseen lines still require a range
/// re-read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnseenLinesReveal {
	pub lines:     Vec<RevealedLine>,
	pub truncated: bool,
}

/// Edit referenced lines never displayed by the cited tag's read.
///
/// Editing lines not read (partial range or collapsed summary) mangles files.
/// When `reveal.lines` is non-empty, the caller has already inlined the actual
/// file content at those lines and merged them into the snapshot's seen-line
/// set, so the message points the model at a straight retry with the same
/// `[path#tag]` header; when the reveal is empty or truncated, the message
/// falls back to instructing a range re-read. `moved` = true means an earlier
/// edit or outside change shifted every unseen line: the model saw the
/// content, only at other numbers.
pub fn unseen_lines_message(
	section_path: &str,
	unseen_lines: &[u32],
	tag: &str,
	moved: bool,
	reveal: &UnseenLinesReveal,
) -> String {
	let ranges = format_line_ranges(unseen_lines);
	let selector = ranges.replace(", ", ",");
	let header = if moved {
		format!(
			"This edit anchors to lines {ranges} of {section_path}, which an earlier change moved: \
			 {HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}{tag}{HL_FILE_SUFFIX} never displayed \
			 them at these numbers, and nothing in the edit identifies the lines there."
		)
	} else {
		format!(
			"This edit anchors to lines {ranges} of {section_path} that \
			 {HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}{tag}{HL_FILE_SUFFIX} never displayed \
			 (it showed a partial range, a search hit, or a folded summary)."
		)
	};
	if reveal.lines.is_empty() {
		return format!(
			"{header} Re-read them in full first with a ranged read like `{section_path}:{selector}` \
			 — it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — \
			 then re-issue the edit."
		);
	}
	let preview = reveal
		.lines
		.iter()
		.map(|r| format!("  {}", format_numbered_line(r.line, &r.text)))
		.collect::<Vec<_>>()
		.join("\n");
	if reveal.truncated {
		return format!(
			"{header} Preview of the actual file content at the first {} unseen \
			 line(s):\n{preview}\nThe range exceeds the inline preview cap — re-read the remainder \
			 with `{section_path}:{selector}` before re-issuing the edit.",
			reveal.lines.len()
		);
	}
	format!(
		"{header} Actual file content at those lines:\n{preview}\nVerify the content matches what \
		 you intend to touch, then re-issue the edit with the same \
		 {HL_FILE_PREFIX}path{HL_FILE_HASH_SEP}tag{HL_FILE_SUFFIX} header — a straight retry now \
		 succeeds without a re-read. If the content does NOT match, fix your line numbers."
	)
}

/// [`unseen_lines_message`]'s fallback for a stale tag.
///
/// The inline reveal cannot carry the lines (one is over the column cap, or
/// there are more than the reveal cap), so they must be read. The file changed
/// since the tag, so a read at the tag's numbers shows other rows; the read and
/// the re-issued edit use the lines' current numbers and the file's current
/// tag.
pub fn stale_unseen_lines_message(
	section_path: &str,
	unseen_lines: &[u32],
	tag: &str,
	live_lines: &[u32],
	live_tag: &str,
	raw: bool,
) -> String {
	let ranges = format_line_ranges(unseen_lines);
	let live_ranges = format_line_ranges(live_lines);
	let selector = live_ranges.replace(", ", ",");
	let raw = if raw { ":raw" } else { "" };
	let live_header =
		format!("{HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}{live_tag}{HL_FILE_SUFFIX}");
	format!(
		"This edit anchors to lines {ranges} of {section_path} that \
		 {HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}{tag}{HL_FILE_SUFFIX} never displayed in \
		 full. The file has changed since that tag: those lines are now lines {live_ranges}, under \
		 {live_header}. Read `{section_path}:{selector}{raw}` for their full content, then re-issue \
		 the edit under {live_header} with current line numbers."
	)
}

/// Op kind of a deferred block edit, for [`block_single_line_message`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BlockOp {
	Replace,
	InsertAfter,
	Cut,
	PasteAfter,
}

fn block_op_form(op: BlockOp, line: u32) -> String {
	match op {
		BlockOp::Replace => format!("{HL_PUT_KEYWORD} {line}*:"),
		BlockOp::InsertAfter => format!("{HL_PUT_KEYWORD} >{line}*:"),
		BlockOp::Cut => format!("{HL_CUT_KEYWORD} {line}*"),
		BlockOp::PasteAfter => format!("{HL_PUT_KEYWORD} >{line}*"),
	}
}

fn block_op_plain(op: BlockOp, line: u32) -> String {
	match op {
		BlockOp::Replace => format!("{HL_PUT_KEYWORD} {line}:"),
		BlockOp::InsertAfter => format!("{HL_PUT_KEYWORD} >{line}:"),
		BlockOp::Cut => format!("{HL_CUT_KEYWORD} {line}"),
		BlockOp::PasteAfter => format!("{HL_PUT_KEYWORD} >{line}"),
	}
}

/// A block-op anchor resolved to a single line: line N is a bare statement,
/// not the opening line of a multi-line construct. The plain op is exact for
/// one line, so reject and point at it.
pub fn block_single_line_message(
	line: u32,
	op: BlockOp,
	enclosing_block: Option<BlockSpan>,
) -> String {
	let form = block_op_form(op, line);
	let plain_form = block_op_plain(op, line);
	let mut message = format!(
		"`{form}` resolved a single-line block — line {line} is a bare statement, not the opening \
		 line of a multi-line construct. For only this statement use `{plain_form}`."
	);
	if let Some(enclosing) = enclosing_block {
		let enclosing_form = block_op_form(op, enclosing.start);
		let _ = write!(
			message,
			" The nearest enclosing multi-line block begins at line {} and ends at line {}; use \
			 `{enclosing_form}` to target it.",
			enclosing.start, enclosing.end
		);
	}
	message
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_format_anchored_context() {
		let lines = [
			"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
			"juliet",
		];
		// Anchors at line 2 and 8 with a gap between 4 and 6.
		let context = format_anchored_context(&[2, 8], &lines);
		assert_eq!(context, vec![
			" 1:alpha",
			"*2:bravo",
			" 3:charlie",
			" 4:delta",
			"...",
			" 6:foxtrot",
			" 7:golf",
			"*8:hotel",
			" 9:india",
			" 10:juliet",
		]);

		// Out-of-range anchor ignored.
		let context_oor = format_anchored_context(&[999], &lines);
		assert!(context_oor.is_empty());
	}

	#[test]
	fn test_invalid_absolute_range_message() {
		// Replace with block span and no register
		let msg = invalid_absolute_range_message(
			12,
			5,
			3,
			AbsoluteRangeOp::Replace,
			Some(BlockSpan { start: 5, end: 10 }),
			None,
		);
		assert_eq!(
			msg,
			"line 12: Invalid absolute range: start 5, end 3. The value after `.=` is an absolute \
			 source line, not a line count or replacement length. For one line use `PUT 5:`. For 3 \
			 lines starting at 5, use `PUT 5.=7:`. The syntactic block beginning at 5 ends at 10, so \
			 `PUT 5*:` is also valid."
		);

		// Cut with register and no block
		let msg_cut =
			invalid_absolute_range_message(10, 4, 1, AbsoluteRangeOp::Cut, None, Some("clip"));
		assert_eq!(
			msg_cut,
			"line 10: Invalid absolute range: start 4, end 1. The value after `.=` is an absolute \
			 source line, not a line count or replacement length. For one line use `CUT 4 @clip`. \
			 For 1 lines starting at 4, use `CUT 4.=4 @clip`."
		);
	}

	#[test]
	fn test_empty_register_paste_warning() {
		// 0 known registers
		let msg_empty = empty_register_paste_warning("temp", &[]);
		assert_eq!(
			msg_empty,
			"`@temp` was empty — no `CUT … @temp` precedes this op in this call and no persisted \
			 register has that name — so nothing was pasted."
		);

		// N known registers
		let msg_known = empty_register_paste_warning("temp", &["foo", "bar"]);
		assert_eq!(
			msg_known,
			"`@temp` was empty — no `CUT … @temp` precedes this op in this call and no persisted \
			 register has that name — so nothing was pasted. Available registers: `@foo`, `@bar`."
		);
	}

	#[test]
	fn test_unseen_lines_message() {
		// Empty reveal
		let msg_empty = unseen_lines_message(
			"src/foo.ts",
			&[5, 6, 7, 10],
			"AB12",
			false,
			&UnseenLinesReveal::default(),
		);
		assert_eq!(
			msg_empty,
			"This edit anchors to lines 5-7, 10 of src/foo.ts that [src/foo.ts#AB12] never displayed \
			 (it showed a partial range, a search hit, or a folded summary). Re-read them in full \
			 first with a ranged read like `src/foo.ts:5-7,10` — it skips summarization and mints a \
			 fresh tag (a plain re-read just re-folds them) — then re-issue the edit."
		);

		// Non-empty reveal, not truncated
		let reveal = UnseenLinesReveal {
			lines:     vec![RevealedLine { line: 5, text: "let x = 1;".to_string() }],
			truncated: false,
		};
		let msg_reveal = unseen_lines_message("src/foo.ts", &[5], "AB12", false, &reveal);
		assert_eq!(
			msg_reveal,
			"This edit anchors to lines 5 of src/foo.ts that [src/foo.ts#AB12] never displayed (it \
			 showed a partial range, a search hit, or a folded summary). Actual file content at \
			 those lines:\n  5:let x = 1;\nVerify the content matches what you intend to touch, then \
			 re-issue the edit with the same [path#tag] header — a straight retry now succeeds \
			 without a re-read. If the content does NOT match, fix your line numbers."
		);

		// Truncated reveal
		let reveal_trunc = UnseenLinesReveal {
			lines:     vec![RevealedLine { line: 5, text: "let x = 1;".to_string() }],
			truncated: true,
		};
		let msg_trunc = unseen_lines_message("src/foo.ts", &[5, 6], "AB12", false, &reveal_trunc);
		assert_eq!(
			msg_trunc,
			"This edit anchors to lines 5-6 of src/foo.ts that [src/foo.ts#AB12] never displayed (it \
			 showed a partial range, a search hit, or a folded summary). Preview of the actual file \
			 content at the first 1 unseen line(s):\n  5:let x = 1;\nThe range exceeds the inline \
			 preview cap — re-read the remainder with `src/foo.ts:5-6` before re-issuing the edit."
		);

		// Lines an earlier change moved
		let msg_moved = unseen_lines_message("src/foo.ts", &[5], "AB12", true, &reveal);
		assert_eq!(
			msg_moved,
			"This edit anchors to lines 5 of src/foo.ts, which an earlier change moved: \
			 [src/foo.ts#AB12] never displayed them at these numbers, and nothing in the edit \
			 identifies the lines there. Actual file content at those lines:\n  5:let x = 1;\nVerify \
			 the content matches what you intend to touch, then re-issue the edit with the same \
			 [path#tag] header — a straight retry now succeeds without a re-read. If the content \
			 does NOT match, fix your line numbers."
		);
	}

	#[test]
	fn test_block_single_line_message() {
		// Without enclosing block
		let msg = block_single_line_message(15, BlockOp::Replace, None);
		assert_eq!(
			msg,
			"`PUT 15*:` resolved a single-line block — line 15 is a bare statement, not the opening \
			 line of a multi-line construct. For only this statement use `PUT 15:`."
		);

		// With enclosing block
		let msg_enc = block_single_line_message(
			15,
			BlockOp::InsertAfter,
			Some(BlockSpan { start: 10, end: 20 }),
		);
		assert_eq!(
			msg_enc,
			"`PUT >15*:` resolved a single-line block — line 15 is a bare statement, not the opening \
			 line of a multi-line construct. For only this statement use `PUT >15:`. The nearest \
			 enclosing multi-line block begins at line 10 and ends at line 20; use `PUT >10*:` to \
			 target it."
		);
	}

	#[test]
	fn test_json_quote() {
		assert_eq!(json_quote("hello \"world\"\n\t\\"), "\"hello \\\"world\\\"\\n\\t\\\\\"");
	}
}
