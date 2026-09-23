//! Centralized error/warning text for the hashline parser, applier, and
//! patcher. Port of `packages/hashline/src/messages.ts`.

use std::{
	collections::{BTreeSet, HashSet},
	fmt::Write,
};

pub use super::types::BlockSpan;

const HL_FILE_PREFIX: &str = "[";
const HL_FILE_SUFFIX: &str = "]";
const HL_PAYLOAD_REPLACE: &str = "+";
const HL_PUT_KEYWORD: &str = "PUT";
const HL_CUT_KEYWORD: &str = "CUT";
const HL_FILE_HASH_SEP: &str = "#";
const HL_RANGE_SEP: &str = ".=";
const HL_LINE_BODY_SEP: &str = ":";

#[inline]
fn format_numbered_line(line_number: u32, line: &str) -> String {
	format!("{line_number}{HL_LINE_BODY_SEP}{line}")
}

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

/// Numbered `LINE:TEXT` rows around `anchor_lines` (±[`MISMATCH_CONTEXT`]),
/// `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
/// contribute no rows.
pub fn format_anchored_context<S: AsRef<str>>(
	anchor_lines: &[u32],
	file_lines: &[S],
) -> Vec<String> {
	let mut display_lines = BTreeSet::new();
	for &line in anchor_lines {
		if line < 1 || (line as usize) > file_lines.len() {
			continue;
		}
		let lo = line.saturating_sub(MISMATCH_CONTEXT).max(1);
		let hi = (line + MISMATCH_CONTEXT).min(file_lines.len() as u32);
		for line_num in lo..=hi {
			display_lines.insert(line_num);
		}
	}
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
	match register {
		Some(reg) => format!(" @{reg}"),
		None => String::new(),
	}
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

/// Replacement body indentation was aligned from unchanged structural rows.
pub const REPLACEMENT_INDENT_AUTO_SHIFT_WARNING: &str =
	"Auto-indented a replacement body to match unchanged structural rows in its source range.";

/// Bare body rows auto-converted to literal `+` rows.
pub const BARE_BODY_AUTO_PIPED_WARNING: &str =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";

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

/// A block-anchored replace/cut could not resolve to a syntactic block.
/// Appends a [`format_anchored_context`] preview when `file_lines` is given.
/// `PUT >N*` never reaches this path; it lowers to `PUT >N`.
pub fn block_unresolved_message(
	line: u32,
	op: AbsoluteRangeOp,
	file_lines: Option<&[&str]>,
	suggestions: &BlockDiagnosticSuggestions,
	register: Option<&str>,
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
	let mut message = match (anchor_text.is_some_and(|text| text.trim().is_empty()), next_block) {
		(true, Some(next)) => {
			let retry = block_form_at(op, next.start, register);
			format!(
				"Line {line} is blank; no syntactic block can begin there. The next multi-line block \
				 begins at line {} and ends at line {}. Retry `{retry}`.",
				next.start, next.end
			)
		},
		_ => {
			format!(
				"`{phrase}` could not resolve a syntactic block beginning on line {line} (unsupported \
				 language, blank/closer line, or parse error). Use `{fallback}` with explicit lines."
			)
		},
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
/// After the duplicated body rows are removed, applying or dropping it would
/// lose distinct range content, so the edit is rejected unless a
/// parse-restoring boundary combination proves another reading.
pub fn ambiguous_boundary_echo_message(
	start_line: u32,
	end_line: u32,
	side: BoundarySide,
	count: u32,
) -> String {
	let where_clause = match side {
		BoundarySide::Leading => {
			format!("opens by restating the {count} line(s) just above the range")
		},
		BoundarySide::Trailing => {
			format!("ends by restating the {count} line(s) just below the range")
		},
	};
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: the body {where_clause}, but is too \
		 short to be the full final content of the selected range. Re-issue with the range covering \
		 exactly the lines that change and the body as their complete final content."
	)
}

/// A syntax-essential selected edge can be retained on either side of the
/// payload, but indentation does not establish which placement was intended.
pub fn ambiguous_boundary_placement_message(start_line: u32, end_line: u32) -> String {
	format!(
		"`PUT {start_line}{HL_RANGE_SEP}{end_line}:` rejected: a selected boundary row is required \
		 for the file to parse, but the body indentation does not establish whether it belongs \
		 before or after that row. Re-read the region and re-issue with a range that excludes every \
		 unchanged boundary row."
	)
}

/// Exact-text boundary rows were removed because the remaining payload covers
/// the selected range and the same rows already survive immediately outside it.
pub fn textual_boundary_echo_warning(start_line: u32, leading: u32, trailing: u32) -> String {
	let mut parts = Vec::new();
	if leading > 0 {
		parts.push(format!("{leading} leading"));
	}
	if trailing > 0 {
		parts.push(format!("{trailing} trailing"));
	}
	let joined = parts.join(" and ");
	format!(
		"Auto-repaired a replacement boundary echo at line {start_line}: dropped {joined} body \
		 line(s) already present outside the range. Issue the body as final content for the \
		 selected range only."
	)
}

/// A replacement range's boundary disposition was corrected by the search.
///
/// Judged by the syntax probe: syntax-essential source boundary rows were
/// retained, or exact body echoes of surviving outside rows were removed. The
/// authored result did not parse and the selected result does.
pub fn boundary_variant_repair_warning(start_line: u32, kept: u32, dropped: u32) -> String {
	let kept_part = if kept == 0 {
		None
	} else {
		Some(format!("retained {kept} syntax-essential source boundary row(s) selected by the range"))
	};
	let dropped_part = if dropped == 0 {
		None
	} else {
		Some(format!("dropped {dropped} body row(s) duplicated just outside the range"))
	};
	let actions: Vec<String> = kept_part.into_iter().chain(dropped_part).collect();
	let action = actions.join(" and ");
	format!(
		"Auto-repaired replacement boundaries at line {start_line}: {action}. The result was \
		 verified by the syntax probe — re-issue with the range covering exactly the changed lines \
		 and the body as their complete final content."
	)
}

/// The applied result no longer parses while the pre-edit content did.
///
/// The patch introduced a syntax error. Advisory, never a rejection — the
/// applier honors the authored edit — but the breakage is machine-confirmed by
/// tree-sitter and surfaced in the same response instead of waiting for a
/// compiler pass.
pub fn edit_broke_parse_warning(first_changed_line: Option<u32>) -> String {
	let at = match first_changed_line {
		Some(line) => format!(" near line {line}"),
		None => String::new(),
	};
	format!(
		"This edit introduced a syntax error{at}: the file parsed before the patch and no longer \
		 does. It was applied exactly as written, so a line number or range endpoint is likely \
		 wrong — re-read the touched region and re-issue a correcting edit."
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

/// `REM` deletes the whole file and takes no body rows or line ops. Issue it
/// alone under the header.
pub const REM_TAKES_NO_BODY: &str = "`REM` deletes the whole file and takes no body rows or line \
                                     ops. Issue it alone under the header.";

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

/// `insert after` body indented shallower than the anchor: the landing slid
/// forward past trailing closer lines — the common "anchored on the last line
/// I read instead of after the block" mistake.
pub fn after_insert_landing_shift_warning(
	anchor_line: u32,
	landing_line: u32,
	crossed: u32,
) -> String {
	let s = if crossed == 1 { "" } else { "s" };
	format!(
		"PUT >{anchor_line}: body indented shallower than the anchor, so the landing moved past \
		 {crossed} closing line{s} to after line {landing_line}. For the deeper position inside the \
		 block, re-issue with the body indented to match."
	)
}

/// `PUT >N*:` body indented deeper than the block's closer: the landing was
/// pulled inside the block — a deeper body almost always means "append inside
/// the block's body".
pub fn block_insert_landing_shift_warning(
	block_start: u32,
	closer_line: u32,
	landing_line: u32,
) -> String {
	format!(
		"PUT >{block_start}*: body indented deeper than closing line {closer_line}, so it was \
		 placed inside the block, after line {landing_line}. `PUT >N*` lands AFTER the block at \
		 sibling depth — if inside was intended, use plain `PUT >{closer_line}:`."
	)
}

/// Plain `PUT >N:` anchored on a block-opener line with a shallower body.
///
/// The landing was moved past the whole block — anchoring on an opener places
/// the body between the opener and its first statement, a position a body at
/// the opener's depth or above never intends.
pub fn after_insert_opener_escape_warning(anchor_line: u32, landing_line: u32) -> String {
	format!(
		"PUT >{anchor_line}: line {anchor_line} opens a block, and the body's indentation claims a \
		 position outside it, so the body was landed after line {landing_line} (verified by the \
		 syntax probe). To insert after a whole construct, anchor on its closing line or use `PUT \
		 >N*:`."
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

/// Disk content after write differs from what was sent (e.g. IDE format on
/// save).
///
/// See `WriteResult.text` — most commonly an ACP-connected editor reformatting
/// the buffer on save (e.g. `format_on_save` with tab/space settings that don't
/// match the file). The recorded snapshot is re-keyed on the real, post-write
/// content so the next edit's tag validation matches reality instead of
/// silently drifting.
pub fn write_drift_warning(path: &str) -> String {
	format!(
		"{path}: the file on disk after this write differs from what was sent — the client \
		 (editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). The \
		 returned snapshot reflects the actual file; re-read before further edits if the extra \
		 changes were unexpected."
	)
}

/// Section omitted the mandatory snapshot tag. Shared by the apply
/// (`Patcher.prepare`) and preview/diff paths so both stay in lockstep.
pub fn missing_snapshot_tag_message(section_path: &str) -> String {
	format!(
		"Missing hashline snapshot tag for {section_path}; use \
		 `{HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}tag{HL_FILE_SUFFIX}` from your latest \
		 read/search output. To create a new file, use the write tool."
	)
}

/// Section named a nonexistent path matching an earlier snapshot's name and
/// tag.
///
/// The model gave the bare filename (or wrong directory) for a file it just
/// read. The edit was rebound to that file's full path. Surfaced as a warning
/// so the model (and user) learn the corrected path and stop reusing the wrong
/// one.
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
/// falls back to instructing a range re-read.
pub fn unseen_lines_message(
	section_path: &str,
	unseen_lines: &[u32],
	tag: &str,
	reveal: &UnseenLinesReveal,
) -> String {
	let ranges = format_line_ranges(unseen_lines);
	let selector = ranges.replace(", ", ",");
	let header = format!(
		"This edit anchors to lines {ranges} of {section_path} that \
		 {HL_FILE_PREFIX}{section_path}{HL_FILE_HASH_SEP}{tag}{HL_FILE_SUFFIX} never displayed (it \
		 showed a partial range, a search hit, or a folded summary)."
	);
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
		let msg_empty =
			unseen_lines_message("src/foo.ts", &[5, 6, 7, 10], "AB12", &UnseenLinesReveal::default());
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
		let msg_reveal = unseen_lines_message("src/foo.ts", &[5], "AB12", &reveal);
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
		let msg_trunc = unseen_lines_message("src/foo.ts", &[5, 6], "AB12", &reveal_trunc);
		assert_eq!(
			msg_trunc,
			"This edit anchors to lines 5-6 of src/foo.ts that [src/foo.ts#AB12] never displayed (it \
			 showed a partial range, a search hit, or a folded summary). Preview of the actual file \
			 content at the first 1 unseen line(s):\n  5:let x = 1;\nThe range exceeds the inline \
			 preview cap — re-read the remainder with `src/foo.ts:5-6` before re-issuing the edit."
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
	fn test_boundary_warnings_and_json_quote() {
		assert_eq!(
			textual_boundary_echo_warning(10, 1, 2),
			"Auto-repaired a replacement boundary echo at line 10: dropped 1 leading and 2 trailing \
			 body line(s) already present outside the range. Issue the body as final content for the \
			 selected range only."
		);
		assert_eq!(
			boundary_variant_repair_warning(10, 2, 1),
			"Auto-repaired replacement boundaries at line 10: retained 2 syntax-essential source \
			 boundary row(s) selected by the range and dropped 1 body row(s) duplicated just outside \
			 the range. The result was verified by the syntax probe — re-issue with the range \
			 covering exactly the changed lines and the body as their complete final content."
		);
		assert_eq!(json_quote("hello \"world\"\n\t\\"), "\"hello \\\"world\\\"\\n\\t\\\\\"");
	}
}
