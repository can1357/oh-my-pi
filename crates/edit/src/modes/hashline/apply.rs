//! Edit application (`packages/hashline/src/apply.ts`).
//!
//! Body rows are applied verbatim. The boundary, echo and landing checks below
//! never rewrite a patch: each either lets it apply as written or rejects it
//! with the change that would make it read as intended.

use std::{
	collections::{HashMap, HashSet},
	sync::LazyLock,
};

use regex::Regex;

use super::{
	clipboard::resolve_clipboard_edits,
	messages::{
		BoundaryFix, BoundarySide, UNRESOLVED_BLOCK_INTERNAL, UNRESOLVED_CLIPBOARD_INTERNAL,
		after_insert_landing_message, after_insert_opener_message, ambiguous_boundary_echo_message,
		ambiguous_boundary_placement_message, block_insert_landing_message,
		boundary_echo_outcome_message, boundary_fix_message, edit_broke_parse_warning,
		repeated_boundary_echo_message, trailing_comma_replacement_message,
		two_sided_boundary_echo_message,
	},
	syntax::{
		enclosing_boundaries, has_syntax_oracle, node_chain, parses_cleanly, syntax_error_spans,
	},
	types::{Anchor, ApplyResult, BlockResolution, Cursor, Edit},
};
use crate::{
	error::{EditError, Rejection},
	store::Clipboard,
};

/// A line containing only closing delimiters and an optional trailing
/// separator.
pub static STRUCTURAL_CLOSER_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*[)\]}]+[;,]?\s*$").expect("valid structural-closer regex"));

/// A C-family preprocessor directive row. Written at column 0 whatever the
/// surrounding depth, so it says nothing about a body's indentation.
static PREPROCESSOR_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif|define|undef|include|pragma|error|warning|line|region|endregion)\b",
	)
	.expect("valid preprocessor regex")
});

/// Behavior when an anonymous paste has no available cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmptyPaste {
	/// Reject the patch.
	Throw,
	/// Drop the unresolved paste, as streaming previews require.
	Drop,
}

/// Context supplied while applying parsed edits.
pub struct ApplyOptions<'a> {
	/// Transactional clipboard shared across sections.
	pub clipboard:      Option<&'a mut Clipboard>,
	/// Display path used to infer the syntax language.
	pub path:           Option<&'a str>,
	/// Behavior for an empty anonymous paste.
	pub on_empty_paste: EmptyPaste,
}

fn anchors(edit: &Edit) -> Vec<Anchor> {
	match edit {
		Edit::Delete { anchor, .. } => vec![*anchor],
		Edit::Insert {
			cursor: Cursor::BeforeAnchor(anchor) | Cursor::AfterAnchor(anchor), ..
		} => vec![*anchor],
		_ => Vec::new(),
	}
}

const fn set_index(edit: &mut Edit, value: u32) {
	if let Edit::Insert { index, .. } | Edit::Delete { index, .. } = edit {
		*index = value;
	}
}

fn with_index(edit: &Edit, index: u32) -> Edit {
	let mut edit = edit.clone();
	set_index(&mut edit, index);
	edit
}

/// The empty row a trailing newline leaves after the last line.
fn phantom_line(lines: &[&str]) -> Option<u32> {
	(lines.len() > 1 && lines.last().is_some_and(|line| line.is_empty()))
		.then_some(lines.len() as u32)
}

fn out_of_range(line: u32, count: usize) -> EditError {
	EditError::rejected(
		Rejection::OutOfRange,
		format!("Line {line} does not exist (file has {count} lines)"),
	)
}

fn validate_bounds(edits: &[Edit], lines: &[&str]) -> Result<(), EditError> {
	for edit in edits {
		for anchor in anchors(edit) {
			if anchor.line < 1 || anchor.line as usize > lines.len() {
				return Err(out_of_range(anchor.line, lines.len()));
			}
		}
	}
	Ok(())
}

/// One `PUT N.=M:` as lowered by the parser: its replacement inserts, then one
/// delete per consumed line, all carrying the op's payload line.
#[derive(Clone)]
pub(super) struct ReplacementGroup {
	insert_indices:            Vec<usize>,
	pub(super) delete_indices: Vec<usize>,
	pub(super) payload:        Vec<String>,
	pub(super) start:          u32,
	pub(super) end:            u32,
}

pub(super) fn replacement_group(edits: &[Edit], start: usize) -> Option<ReplacementGroup> {
	let Edit::Insert { cursor: Cursor::BeforeAnchor(anchor), line_num, replacement: true, .. } =
		edits.get(start)?
	else {
		return None;
	};
	let anchor_line = anchor.line;
	let op_line = *line_num;
	let mut insert_indices = Vec::new();
	let mut payload = Vec::new();
	let mut i = start;
	while let Some(Edit::Insert {
		cursor: Cursor::BeforeAnchor(anchor),
		text,
		line_num,
		replacement: true,
		..
	}) = edits.get(i)
	{
		if anchor.line != anchor_line || *line_num != op_line {
			break;
		}
		insert_indices.push(i);
		payload.push(text.clone());
		i += 1;
	}
	let mut delete_indices = Vec::new();
	let mut expected = anchor_line;
	while let Some(Edit::Delete { anchor, line_num, .. }) = edits.get(i) {
		if anchor.line != expected || *line_num != op_line {
			break;
		}
		delete_indices.push(i);
		expected += 1;
		i += 1;
	}
	if delete_indices.is_empty() {
		return None;
	}
	Some(ReplacementGroup {
		insert_indices,
		delete_indices,
		payload,
		start: anchor_line,
		end: expected - 1,
	})
}

fn leading_indent(line: &str) -> &str {
	let end = line
		.bytes()
		.take_while(|byte| matches!(byte, b' ' | b'\t'))
		.count();
	&line[..end]
}
fn indent_deeper(deeper: &str, shallower: &str) -> bool {
	deeper.len() > shallower.len() && deeper.starts_with(shallower)
}
fn has_content(text: &str) -> bool {
	text.bytes().any(|byte| !matches!(byte, 9..=13 | 32))
}

/// How many of `group`'s first body rows restate the lines just above its
/// range. None when an edit in the batch deletes the line just above: the body
/// then carries that line's content rather than echoing a line that stays.
fn duplicate_leading(group: &ReplacementGroup, edits: &[Edit], lines: &[&str]) -> usize {
	if group.start > 1 && source_deleted(edits, group.start - 1) {
		return 0;
	}
	restated_above(&group.payload, group.start, lines)
}
/// How many of `group`'s last body rows restate the lines just below its
/// range; none when an edit in the batch deletes the line just below.
fn duplicate_trailing(group: &ReplacementGroup, edits: &[Edit], lines: &[&str]) -> usize {
	if source_deleted(edits, group.end + 1) {
		return 0;
	}
	restated_below(&group.payload, group.end, lines)
}
/// How many of `rows`' first rows restate the lines just above line `start`.
fn restated_above(rows: &[String], start: u32, lines: &[&str]) -> usize {
	let max = rows.len().min(start.saturating_sub(1) as usize);
	for count in (1..=max).rev() {
		let source_start = start as usize - 1 - count;
		let candidate = &rows[..count];
		if candidate
			.iter()
			.zip(&lines[source_start..source_start + count])
			.all(|(a, b)| a == b)
			&& candidate.iter().any(|line| has_content(line))
		{
			return count;
		}
	}
	0
}
/// How many of `rows`' last rows restate the lines just below line `end`.
fn restated_below(rows: &[String], end: u32, lines: &[&str]) -> usize {
	let max = rows.len().min(lines.len().saturating_sub(end as usize));
	for count in (1..=max).rev() {
		let payload = &rows[rows.len() - count..];
		let source = &lines[end as usize..end as usize + count];
		if payload.iter().zip(source).all(|(a, b)| a == b)
			&& payload.iter().any(|line| has_content(line))
		{
			return count;
		}
	}
	0
}
/// How many of `rows`' first and last rows restate the lines just above and
/// just below the range `start..=end`. A run that equals the range rows it
/// lands on is content (the file repeats that line), not an echo.
fn restated_edges(rows: &[String], lines: &[&str], start: u32, end: u32) -> (usize, usize) {
	let lands_on = |run: &[String], at: usize| {
		run.iter()
			.zip(&lines[at.min(lines.len())..])
			.all(|(row, line)| row == line)
	};
	let leading = restated_above(rows, start, lines);
	let trailing = restated_below(rows, end, lines);
	(
		if lands_on(&rows[..leading], (start - 1) as usize) {
			0
		} else {
			leading
		},
		if lands_on(&rows[rows.len() - trailing..], (end as usize).saturating_sub(trailing)) {
			0
		} else {
			trailing
		},
	)
}
fn group_inserts(group: &ReplacementGroup, edits: &[Edit]) -> Vec<Edit> {
	group
		.insert_indices
		.iter()
		.map(|&i| edits[i].clone())
		.collect()
}
fn group_deletes(group: &ReplacementGroup, edits: &[Edit]) -> Vec<Edit> {
	group
		.delete_indices
		.iter()
		.map(|&i| edits[i].clone())
		.collect()
}

fn annotation_echo(lines: &[&str], path: Option<&str>, first: u32, last: u32) -> bool {
	let Some(path) = path else { return false };
	(first..=last).all(|line| {
		node_chain(lines, path, line).iter().any(|node| {
			node.start_line == line
				&& node.end_line == line
				&& matches!(
					node.kind.as_str(),
					"attribute_item"
						| "inner_attribute_item"
						| "decorator"
						| "annotation"
						| "marker_annotation"
						| "attribute_list"
				)
		})
	})
}

/// The neighbouring lines a too-short body restates, with their counts.
#[derive(Clone, Copy)]
enum Echoed {
	Leading(u32),
	Trailing(u32),
	/// The lines just above and just below the range.
	Both(u32, u32),
}

#[derive(Clone, Copy)]
struct Ambiguity {
	start:    u32,
	end:      u32,
	echoed:   Echoed,
	/// Range rows the body leaves out: for a one-sided echo, if it means the
	/// range is shifted; for a two-sided one, past the rows between the echoes.
	left_out: (u32, u32),
	/// The body restates the neighbour more than once; this shape is what is
	/// left with one copy set aside.
	repeated: bool,
}

/// The too-short echo shape of `group` given its leading/trailing echo counts.
fn short_echo(group: &ReplacementGroup, drop_j: usize, drop_k: usize) -> Option<Ambiguity> {
	let range_len = group.delete_indices.len();
	let between = group.payload.len().checked_sub(drop_j + drop_k);
	let one_sided_short =
		(drop_j == 0) != (drop_k == 0) && between.is_none_or(|kept| kept < range_len);
	let two_sided_short =
		drop_j > 0 && drop_k > 0 && range_len > 1 && between.is_some_and(|kept| kept < range_len);
	(one_sided_short || two_sided_short).then(|| {
		let kept = between.unwrap_or(0) as u32;
		let (echoed, left_out) = if two_sided_short {
			(Echoed::Both(drop_j as u32, drop_k as u32), (group.start + kept, group.end))
		} else if drop_j > 0 {
			(Echoed::Leading(drop_j as u32), (group.start + kept, group.end))
		} else {
			(Echoed::Trailing(drop_k as u32), (group.start, group.end - kept))
		};
		Ambiguity { start: group.start, end: group.end, echoed, left_out, repeated: false }
	})
}

impl Ambiguity {
	/// The too-short refusal for this group.
	fn refusal(&self) -> EditError {
		let repeated = self.repeated;
		let (start, end, left_out) = (self.start, self.end, self.left_out);
		EditError::rejected(Rejection::AmbiguousBoundary, match self.echoed {
			Echoed::Both(above, below) => {
				two_sided_boundary_echo_message(start, end, above, below, repeated, left_out)
			},
			Echoed::Leading(count) if repeated => {
				repeated_boundary_echo_message(start, end, BoundarySide::Leading, count, left_out)
			},
			Echoed::Trailing(count) if repeated => {
				repeated_boundary_echo_message(start, end, BoundarySide::Trailing, count, left_out)
			},
			Echoed::Leading(count) => {
				ambiguous_boundary_echo_message(start, end, BoundarySide::Leading, count, left_out)
			},
			Echoed::Trailing(count) => {
				ambiguous_boundary_echo_message(start, end, BoundarySide::Trailing, count, left_out)
			},
		})
	}
}

/// Dropping `drop_l`/`drop_t` echo rows would leave the range as it already
/// is. The drop then turns the edit into a no-op, so the only edit the body can
/// mean is the literal one: a new copy of the neighbouring line.
fn drop_is_noop(group: &ReplacementGroup, lines: &[&str], drop_l: usize, drop_t: usize) -> bool {
	let kept = &group.payload[drop_l..group.payload.len() - drop_t];
	let range = &lines[(group.start - 1) as usize..group.end as usize];
	kept.len() == range.len() && kept.iter().zip(range).all(|(row, line)| row == line)
}

/// `edits` without `group`'s first `drop_l` and last `drop_t` body rows.
fn without_echo(
	edits: &[Edit],
	group: &ReplacementGroup,
	drop_l: usize,
	drop_t: usize,
) -> Vec<Edit> {
	let inserts = &group.insert_indices;
	let dropped: HashSet<usize> = inserts[..drop_l]
		.iter()
		.chain(&inserts[inserts.len() - drop_t..])
		.copied()
		.collect();
	edits
		.iter()
		.enumerate()
		.filter(|(index, _)| !dropped.contains(index))
		.map(|(_, edit)| edit.clone())
		.collect()
}

/// Classifies replacement bodies that restate the lines just outside their
/// range (boundary echoes). Nothing is dropped: an echo is either content or a
/// reason to reject. Returns the too-short shapes to refuse, and the start
/// lines of groups whose restated rows are content, because dropping them
/// would leave the range as it is (a no-op) or because the file parses as
/// written and not without them.
fn classify_echoes(
	edits: &[Edit],
	lines: &[&str],
	path: Option<&str>,
	authored_parses: bool,
) -> (Vec<Ambiguity>, Vec<u32>) {
	let mut ambiguities = Vec::new();
	let mut accepted = Vec::new();
	let mut i = 0;
	while i < edits.len() {
		let Some(group) = replacement_group(edits, i) else {
			i += 1;
			continue;
		};
		i = group.delete_indices.last().copied().unwrap() + 1;
		let leading = duplicate_leading(&group, edits, lines);
		let trailing = duplicate_trailing(&group, edits, lines);
		let range_len = group.delete_indices.len();
		let (mut drop_l, mut drop_t) = (0, 0);
		if leading > 0 && trailing > 0 {
			let between = group.payload.len().checked_sub(leading + trailing);
			if between == Some(range_len) {
				drop_l = leading;
				drop_t = trailing;
			} else {
				// With both neighbours restated the range cannot be shifted, and
				// the rows between the echoes are too few for it: no reading
				// keeps the range rows they leave out. A one-row range is left
				// alone, as it is for a one-sided echo: there the body rows are
				// content, not an echo.
				ambiguities.extend(short_echo(&group, leading, trailing));
			}
		} else if leading > 0
			&& (range_len > 1
				|| annotation_echo(lines, path, group.start - leading as u32, group.start - 1))
		{
			if group.payload.len().saturating_sub(leading) >= range_len {
				drop_l = leading;
			} else {
				ambiguities.extend(short_echo(&group, leading, 0));
			}
		} else if trailing > 0
			&& (range_len > 1
				|| annotation_echo(lines, path, group.end + 1, group.end + trailing as u32))
		{
			if group.payload.len().saturating_sub(trailing) >= range_len {
				drop_t = trailing;
			} else {
				ambiguities.extend(short_echo(&group, 0, trailing));
			}
		}
		if drop_l == 0 && drop_t == 0 {
			continue;
		}
		if drop_is_noop(&group, lines, drop_l, drop_t)
			|| (authored_parses
				&& !parses_cleanly(
					path,
					&materialize(lines, &without_echo(edits, &group, drop_l, drop_t)).0,
				)) {
			accepted.push(group.start);
			continue;
		}
		// A body that restates the neighbour more than once keeps a copy once
		// one is set aside; record the too-short shape that copy exposes.
		let mut rest = group.clone();
		rest.payload.drain(..drop_l);
		rest.payload.truncate(rest.payload.len() - drop_t);
		let (j, k) = restated_edges(&rest.payload, lines, group.start, group.end);
		let j = if group.start > 1 && source_deleted(edits, group.start - 1) {
			0
		} else {
			j
		};
		let k = if source_deleted(edits, group.end + 1) {
			0
		} else {
			k
		};
		if range_len > 1
			&& let Some(mut ambiguity) = short_echo(&rest, j, k)
		{
			ambiguity.repeated = true;
			ambiguities.push(ambiguity);
		}
	}
	(ambiguities, accepted)
}

fn indent_columns(line: &str) -> usize {
	let mut column = 0;
	for byte in line.bytes() {
		match byte {
			b' ' => column += 1,
			b'\t' => column += 4 - column % 4,
			_ => break,
		}
	}
	column
}
fn nearest_content<'a>(lines: &[&'a str], start: isize, step: isize) -> Option<&'a str> {
	let mut index = start;
	while index >= 0 && (index as usize) < lines.len() {
		if has_content(lines[index as usize]) {
			return Some(lines[index as usize]);
		}
		index += step;
	}
	None
}
fn payload_edge(payload: &[String], leading: bool) -> Option<&str> {
	if leading {
		payload
			.iter()
			.find(|line| has_content(line))
			.map(String::as_str)
	} else {
		payload
			.iter()
			.rev()
			.find(|line| has_content(line))
			.map(String::as_str)
	}
}
fn source_deleted(edits: &[Edit], line: u32) -> bool {
	edits
		.iter()
		.any(|edit| matches!(edit, Edit::Delete { anchor, .. } if anchor.line == line))
}
fn effective_trailing(group: &ReplacementGroup, edits: &[Edit], lines: &[&str]) -> u32 {
	let mut line = group.end;
	let mut survivor = group.end + 1;
	while line > group.start
		&& survivor as usize <= lines.len()
		&& !source_deleted(edits, survivor)
		&& lines[(line - 1) as usize] == lines[(survivor - 1) as usize]
	{
		line -= 1;
		survivor += 1;
	}
	line
}
fn essential(lines: &[&str], path: &str, line: u32) -> bool {
	let without = lines[..(line - 1) as usize]
		.iter()
		.chain(&lines[line as usize..])
		.copied()
		.collect::<Vec<_>>()
		.join("\n");
	!parses_cleanly(Some(path), &without)
}

/// A boundary change to one replacement group: what the patch would be if it
/// kept a selected row or dropped body rows that repeat a neighbour. Only ever
/// suggested in a rejection, never applied.
#[derive(Clone)]
struct Variant {
	edits:   Vec<Edit>,
	kept:    usize,
	dropped: usize,
	/// The selected range row kept instead of replaced.
	keep:    Option<u32>,
	drop_l:  usize,
	drop_t:  usize,
}

/// Why a replacement group's parse failure has no single suggested fix.
#[derive(Clone, Copy)]
enum Undecided {
	/// A syntax-essential selected row could belong on either side of the body.
	Placement,
	/// The replacement fails to parse only because its last row ends in a comma.
	TrailingComma,
}

/// Whether `replaced` parses once the trailing comma of its last non-blank
/// inserted row is removed (whatever follows the comma stays).
fn parses_without_trailing_comma(replaced: &[Edit], lines: &[&str], path: &str) -> bool {
	let mut stripped = replaced.to_vec();
	let Some(text) = stripped.iter_mut().rev().find_map(|edit| match edit {
		Edit::Insert { text, .. } if has_content(text) => Some(text),
		_ => None,
	}) else {
		return false;
	};
	let Some(comma) = text.trim_end().strip_suffix(',').map(str::len) else {
		return false;
	};
	text.remove(comma);
	parses_cleanly(Some(path), &materialize(lines, &stripped).0)
}

/// The boundary changes that may make a replacement group parse, for a file
/// that parsed before the patch.
fn group_variants(
	group: &ReplacementGroup,
	edits: &[Edit],
	lines: &[&str],
	path: &str,
) -> (Vec<Variant>, Option<Undecided>) {
	let inserts = group_inserts(group, edits);
	let deletes = group_deletes(group, edits);
	let trailing = effective_trailing(group, edits, lines);
	let first_essential = essential(lines, path, group.start);
	let last_essential = if trailing == group.start {
		first_essential
	} else {
		essential(lines, path, trailing)
	};
	let inner_start = group.start + 1;
	let leading_structure = inner_start <= trailing
		&& enclosing_boundaries(lines, path, inner_start, trailing).contains(&group.start);
	let drop_j = duplicate_leading(group, edits, lines);
	let drop_k = duplicate_trailing(group, edits, lines);
	let leading_drops: Vec<_> = if drop_j > 0 { vec![0, drop_j] } else { vec![0] };
	let trailing_drops: Vec<_> = if drop_k > 0 { vec![0, drop_k] } else { vec![0] };
	let mut variants = Vec::new();
	let mut ambiguous = None;
	for drop_l in leading_drops {
		for &drop_t in &trailing_drops {
			let dropped = drop_l + drop_t;
			if dropped >= inserts.len() {
				continue;
			}
			let payload = &group.payload[drop_l..group.payload.len() - drop_t];
			let Some(lead) = payload_edge(payload, true) else {
				continue;
			};
			let Some(trail) = payload_edge(payload, false) else {
				continue;
			};
			let first = lines.get((group.start - 1) as usize).copied().unwrap_or("");
			let last = lines.get((trailing - 1) as usize).copied().unwrap_or("");
			let mut plans: Vec<(Option<u32>, Option<u32>, usize)> = vec![(None, None, 0)];
			if group.start == trailing {
				let previous = nearest_content(lines, group.start as isize - 2, -1);
				let fits = previous.is_none_or(|line| indent_columns(line) == indent_columns(trail));
				if first_essential && fits && indent_columns(trail) > indent_columns(first) {
					plans.push((None, Some(group.start), 1));
				} else if first_essential && indent_columns(trail) == indent_columns(first) {
					let replaced = [inserts.clone(), deletes.clone()].concat();
					if !parses_cleanly(Some(path), &materialize(lines, &replaced).0) {
						// Only a replacement that breaks the file on its own leaves
						// the row's position in question (e.g. a closer swapped for a
						// statement). Swapping an `if` opener, `case` label, or
						// signature for another of the same shape parses fine alone,
						// so a parse failure elsewhere in the batch must not reject
						// it. A body that parses once its trailing comma is gone (the
						// last element of a JSON array) asks no placement question.
						ambiguous = Some(if parses_without_trailing_comma(&replaced, lines, path) {
							Undecided::TrailingComma
						} else {
							Undecided::Placement
						});
					}
				}
			} else {
				let next = nearest_content(lines, group.start as isize, 1);
				let previous = nearest_content(lines, trailing as isize - 2, -1);
				let before_first = nearest_content(lines, group.start as isize - 2, -1);
				let selected_boundary =
					enclosing_boundaries(lines, path, group.start + 1, group.end).contains(&group.start);
				let structural_edge = STRUCTURAL_CLOSER_RE.is_match(first.trim())
					&& indent_columns(first) == indent_columns(lead)
					&& indent_columns(first)
						== indent_columns(lines.get((group.end - 1) as usize).copied().unwrap_or(""));
				let underfilled =
					trailing < group.end && payload.len() < (group.end - group.start + 1) as usize;
				let keeps_leading = first_essential
					&& (leading_structure || selected_boundary || structural_edge || underfilled)
					&& next.is_none_or(|line| {
						if structural_edge {
							indent_columns(lead) >= indent_columns(first)
						} else {
							indent_columns(line) == indent_columns(lead)
						}
					});
				let keeps_trailing = (last_essential || underfilled)
					&& !keeps_leading
					&& indent_columns(trail) > indent_columns(last)
					&& previous.is_none_or(|line| indent_columns(line) == indent_columns(trail));
				if keeps_leading {
					plans.push((Some(group.start), None, 1));
				}
				if keeps_trailing {
					plans.push((None, Some(trailing), 1));
				}
				if first_essential
					&& before_first.is_some_and(|line| indent_columns(first) < indent_columns(line))
					&& indent_columns(lead) > indent_columns(first)
				{
					ambiguous = Some(Undecided::Placement);
				}
			}
			for (before, after, kept) in plans {
				if kept == 0 && dropped == 0 {
					continue;
				}
				if kept > 0
					&& group.delete_indices.len() > 1
					&& payload.len() > group.delete_indices.len()
				{
					continue;
				}
				let mut kept_inserts = inserts[drop_l..inserts.len() - drop_t].to_vec();
				if let Some(line) = before {
					let cursor = if line as usize >= lines.len() {
						Cursor::Eof
					} else {
						Cursor::BeforeAnchor(Anchor { line: line + 1 })
					};
					for edit in &mut kept_inserts {
						if let Edit::Insert { cursor: target, .. } = edit {
							*target = cursor;
						}
					}
				}
				let mut result = kept_inserts;
				result.extend(deletes.iter().filter(|edit| !matches!(edit, Edit::Delete { anchor, .. } if Some(anchor.line) == before || Some(anchor.line) == after)).cloned());
				variants.push(Variant {
					edits: result,
					kept,
					dropped,
					keep: before.or(after),
					drop_l,
					drop_t,
				});
			}
		}
	}
	variants.sort_by_key(|variant| (variant.kept, variant.dropped));
	(variants, ambiguous)
}

fn splice_variants(
	edits: &[Edit],
	groups: &[(ReplacementGroup, Vec<Variant>)],
	choices: &[Option<usize>],
) -> Vec<Edit> {
	let chosen: HashMap<usize, &Variant> = groups
		.iter()
		.zip(choices)
		.filter_map(|((group, variants), choice)| {
			choice.map(|i| (group.insert_indices[0], &variants[i]))
		})
		.collect();
	let mut out = Vec::new();
	let mut i = 0;
	while i < edits.len() {
		let Some(group) = replacement_group(edits, i) else {
			out.push(with_index(&edits[i], i as u32));
			i += 1;
			continue;
		};
		if let Some(variant) = chosen.get(&group.insert_indices[0]) {
			out.extend(variant.edits.clone());
		} else {
			out.extend(
				group
					.insert_indices
					.iter()
					.chain(&group.delete_indices)
					.map(|&idx| with_index(&edits[idx], idx as u32)),
			);
		}
		i = group.delete_indices.last().copied().unwrap() + 1;
	}
	out
}

/// Line of the first syntax error tree-sitter reports in `text`.
fn first_error_line(path: &str, text: &str) -> Option<u32> {
	syntax_error_spans(Some(path), text)
		.first()
		.map(|&(start, _)| start)
}

fn undecided_error(start: u32, end: u32, reason: Undecided, error_line: Option<u32>) -> EditError {
	EditError::rejected(Rejection::AmbiguousBoundary, match reason {
		Undecided::Placement => ambiguous_boundary_placement_message(start, end, error_line),
		Undecided::TrailingComma => trailing_comma_replacement_message(start, end),
	})
}

/// For a patch that breaks a file which parsed, finds the boundary change
/// that makes it parse: keeping a selected row a replacement swallows, or
/// dropping body rows that repeat a neighbouring line. The patch itself is
/// never rewritten: a unique fix becomes a rejection naming it, an undecided
/// placement a rejection explaining it, and anything else applies as written.
fn boundary_fix_rejection(
	edits: &[Edit],
	lines: &[&str],
	path: &str,
	authored: &str,
	literal: &[u32],
) -> Option<EditError> {
	let mut groups = Vec::new();
	let mut ambiguous = None;
	let mut i = 0;
	while i < edits.len() {
		if let Some(group) = replacement_group(edits, i) {
			i = group.delete_indices.last().copied().unwrap() + 1;
			// The body restates a neighbour as content (see `classify_echoes`).
			if literal.contains(&group.start) {
				continue;
			}
			let (variants, group_ambiguity) = group_variants(&group, edits, lines, path);
			if let Some(kind) = group_ambiguity
				&& ambiguous.is_none()
			{
				ambiguous = Some((group.start, group.end, kind));
			}
			if !variants.is_empty() {
				groups.push((group, variants));
			}
		} else {
			i += 1;
		}
	}
	let undecided = |reason: Option<Undecided>| {
		ambiguous.map(|(start, end, kind)| {
			undecided_error(start, end, reason.unwrap_or(kind), first_error_line(path, authored))
		})
	};
	if groups.is_empty() {
		return undecided(None);
	}
	#[derive(Clone)]
	struct Combo {
		choices: Vec<Option<usize>>,
		touched: usize,
		kept:    usize,
		dropped: usize,
	}
	let mut combos = vec![Combo { choices: Vec::new(), touched: 0, kept: 0, dropped: 0 }];
	for (_, variants) in &groups {
		let mut next = Vec::new();
		for combo in &combos {
			let mut none = combo.clone();
			none.choices.push(None);
			next.push(none);
			for (index, variant) in variants.iter().enumerate() {
				let mut one = combo.clone();
				one.choices.push(Some(index));
				one.touched += 1;
				one.kept += variant.kept;
				one.dropped += variant.dropped;
				next.push(one);
			}
		}
		next.sort_by_key(|combo| (combo.touched, combo.kept, combo.dropped));
		next.truncate(512);
		combos = next;
	}
	combos.retain(|combo| combo.touched > 0);
	combos.sort_by_key(|combo| (combo.touched, combo.kept, combo.dropped));
	let mut best: Option<(Combo, String)> = None;
	for combo in combos {
		if best.as_ref().is_some_and(|(value, _)| {
			(combo.touched, combo.kept, combo.dropped) > (value.touched, value.kept, value.dropped)
		}) {
			break;
		}
		let candidate = splice_variants(edits, &groups, &combo.choices);
		let text = materialize(lines, &candidate).0;
		if text == authored || !parses_cleanly(Some(path), &text) {
			continue;
		}
		if let Some((_, best_text)) = &best {
			if *best_text != text {
				// Two fixes parse differently: placement, not the body, is in
				// question.
				return undecided(Some(Undecided::Placement));
			}
		} else {
			best = Some((combo, text));
		}
	}
	let Some((combo, _)) = best else {
		return undecided(None);
	};
	let fixes = groups
		.iter()
		.zip(&combo.choices)
		.filter_map(|((group, variants), choice)| {
			choice.map(|index| {
				let variant = &variants[index];
				BoundaryFix {
					start:         group.start,
					end:           group.end,
					keep:          variant.keep,
					drop_leading:  variant.drop_l as u32,
					drop_trailing: variant.drop_t as u32,
				}
			})
		})
		.collect::<Vec<_>>();
	Some(EditError::rejected(
		Rejection::AmbiguousBoundary,
		boundary_fix_message(&fixes, first_error_line(path, authored)),
	))
}

#[derive(Clone)]
struct InsertGroup {
	anchor:      u32,
	members:     Vec<usize>,
	block_start: Option<u32>,
}
fn body_indent(rows: &[&str]) -> Option<String> {
	let non_blank: Vec<_> = rows
		.iter()
		.copied()
		.filter(|row| has_content(row) && !PREPROCESSOR_RE.is_match(row))
		.collect();
	if non_blank.is_empty()
		|| non_blank
			.iter()
			.all(|row| STRUCTURAL_CLOSER_RE.is_match(row))
	{
		return None;
	}
	let mut target = leading_indent(non_blank[0]).to_owned();
	for row in non_blank {
		let indent = leading_indent(row);
		if indent.starts_with(&target) {
		} else if target.starts_with(indent) {
			indent.clone_into(&mut target);
		} else {
			return None;
		}
	}
	Some(target)
}
fn body_relocatable(rows: &[&str], path: &str) -> bool {
	let Some(last) = rows
		.iter()
		.rposition(|row| has_content(row))
		.map(|index| index + 1)
	else {
		return false;
	};
	let mut line = 1_usize;
	while line <= last {
		if !has_content(rows[line - 1]) {
			line += 1;
			continue;
		}
		let end = node_chain(rows, path, line as u32)
			.into_iter()
			.filter(|span| span.start_line == line as u32)
			.map(|span| span.end_line)
			.max()
			.unwrap_or(0) as usize;
		if end == 0 {
			return false;
		}
		if end >= last {
			return end > line;
		}
		line = end + 1;
	}
	false
}

/// For a patch that breaks a file which parsed, checks each gap insert after
/// line N against where its indentation points: past the closers that follow
/// N, inside the `PUT >N*` block it trails, or past the block line N opens.
/// When the file parses with the body there, the patch is rejected with that
/// landing; gap inserts never move.
fn landing_rejection(edits: &[Edit], lines: &[&str], path: &str) -> Option<EditError> {
	let mut groups: Vec<((u32, u32), InsertGroup)> = Vec::new();
	for (index, edit) in edits.iter().enumerate() {
		if let Edit::Insert {
			cursor: Cursor::AfterAnchor(anchor),
			line_num,
			replacement: false,
			block_start,
			..
		} = edit
		{
			let key = (anchor.line, *line_num);
			if let Some((_, group)) = groups.iter_mut().find(|(candidate, _)| *candidate == key) {
				group.members.push(index);
			} else {
				groups.push((key, InsertGroup {
					anchor:      anchor.line,
					members:     vec![index],
					block_start: *block_start,
				}));
			}
		}
	}
	let targeted: HashSet<u32> = edits
		.iter()
		.flat_map(anchors)
		.map(|anchor| anchor.line)
		.collect();
	let parses_at = |group: &InsertGroup, landing: u32| {
		let mut trial = edits.to_vec();
		for &index in &group.members {
			if let Edit::Insert { cursor, .. } = &mut trial[index] {
				*cursor = Cursor::AfterAnchor(Anchor { line: landing });
			}
		}
		parses_cleanly(Some(path), &materialize(lines, &trial).0)
	};
	let rejected =
		|message: String| Some(EditError::rejected(Rejection::AmbiguousBoundary, message));
	for (_, group) in &groups {
		let rows: Vec<_> = group
			.members
			.iter()
			.filter_map(|&index| {
				if let Edit::Insert { text, .. } = &edits[index] {
					Some(text.as_str())
				} else {
					None
				}
			})
			.collect();
		let Some(target) = body_indent(&rows) else {
			continue;
		};
		let anchor_text = lines
			.get((group.anchor - 1) as usize)
			.copied()
			.unwrap_or("");
		if has_content(anchor_text) && indent_deeper(leading_indent(anchor_text), &target) {
			let mut landing = group.anchor;
			let mut crossed = 0;
			let mut blocked = false;
			for line in group.anchor + 1..=lines.len() as u32 {
				let text = &lines[(line - 1) as usize];
				if !has_content(text) {
					continue;
				}
				if !STRUCTURAL_CLOSER_RE.is_match(text) || !leading_indent(text).starts_with(&target) {
					break;
				}
				if targeted.contains(&line) {
					blocked = true;
					break;
				}
				landing = line;
				crossed += 1;
				if leading_indent(text).len() == target.len() {
					break;
				}
			}
			if !blocked && landing != group.anchor && parses_at(group, landing) {
				return rejected(after_insert_landing_message(group.anchor, landing, crossed));
			}
		}
		if let Some(block_start) = group.block_start {
			if STRUCTURAL_CLOSER_RE.is_match(anchor_text)
				&& indent_deeper(&target, leading_indent(anchor_text))
			{
				let mut landing = group.anchor;
				let mut blocked = false;
				for line in (block_start + 1..=group.anchor).rev() {
					let text = &lines[(line - 1) as usize];
					if !has_content(text) {
						landing = line - 1;
						continue;
					}
					if !STRUCTURAL_CLOSER_RE.is_match(text)
						|| !indent_deeper(&target, leading_indent(text))
					{
						break;
					}
					if line != group.anchor && targeted.contains(&line) {
						blocked = true;
						break;
					}
					landing = line - 1;
				}
				if !blocked && landing != group.anchor && parses_at(group, landing) {
					return rejected(block_insert_landing_message(block_start, group.anchor, landing));
				}
			}
		} else {
			let target_cols = indent_columns(&target);
			if target_cols < indent_columns(anchor_text) {
				let chain = node_chain(lines, path, group.anchor);
				if chain
					.iter()
					.any(|node| node.start_line == group.anchor && node.end_line > group.anchor)
					&& body_relocatable(&rows, path)
				{
					let mut candidates: Vec<_> = chain
						.into_iter()
						.filter(|node| {
							node.end_line > group.anchor
								&& indent_columns(lines[(node.start_line - 1) as usize]) <= target_cols
						})
						.map(|node| node.end_line)
						.collect();
					candidates.sort_unstable();
					candidates.dedup();
					for landing in candidates {
						if targeted
							.iter()
							.any(|line| *line > group.anchor && *line <= landing)
						{
							break;
						}
						if parses_at(group, landing) {
							return rejected(after_insert_opener_message(group.anchor, landing));
						}
					}
				}
			}
		}
	}
	None
}

/// Where an anchored edit lands relative to its anchor line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
	Before,
	Replacement,
	After,
	Delete,
}

fn materialize(original: &[&str], edits: &[Edit]) -> (String, Option<u32>) {
	render(original, edits, None)
}

/// Applies `edits` to `original`. With `spans`, also collects the 1-indexed
/// inclusive result line spans the edits wrote; a pure deletion yields the two
/// lines that now meet at its position.
fn render(
	original: &[&str],
	edits: &[Edit],
	mut spans: Option<&mut Vec<(u32, u32)>>,
) -> (String, Option<u32>) {
	let touched = |before: usize, after: usize| {
		if after > before {
			(before as u32 + 1, after as u32)
		} else {
			((before as u32).max(1), before as u32 + 1)
		}
	};
	let mut first = None;
	let mut bof = Vec::new();
	let mut eof = Vec::new();
	let mut anchored: Vec<(u32, Slot, &str)> = Vec::new();
	for edit in edits {
		let entry = match edit {
			Edit::Insert { cursor: Cursor::Bof, text, .. } => {
				bof.push(text.as_str());
				continue;
			},
			Edit::Insert { cursor: Cursor::Eof, text, .. } => {
				eof.push(text.as_str());
				continue;
			},
			Edit::Insert { cursor: Cursor::AfterAnchor(anchor), text, .. } => {
				(anchor.line, Slot::After, text.as_str())
			},
			Edit::Insert { cursor: Cursor::BeforeAnchor(anchor), text, replacement, .. } => {
				let slot = if *replacement {
					Slot::Replacement
				} else {
					Slot::Before
				};
				(anchor.line, slot, text.as_str())
			},
			Edit::Delete { anchor, .. } => (anchor.line, Slot::Delete, ""),
			_ => continue,
		};
		anchored.push(entry);
	}
	// Stable: edits on one line keep their op order.
	anchored.sort_by_key(|&(line, ..)| line);

	// One ascending pass over borrowed lines; every anchored line becomes
	// before + replacements + itself (unless deleted) + after.
	let mut lines: Vec<&str> =
		Vec::with_capacity(original.len() + anchored.len() + bof.len() + eof.len());
	let mut copied = 0;
	for group in anchored.chunk_by(|left, right| left.0 == right.0) {
		let line = group[0].0;
		let index = (line - 1) as usize;
		let end = index.min(original.len());
		lines.extend_from_slice(&original[copied.min(end)..end]);
		let texts = |slot: Slot| {
			group
				.iter()
				.filter(move |entry| entry.1 == slot)
				.map(|entry| entry.2)
		};
		let before = lines.len();
		lines.extend(texts(Slot::Before));
		lines.extend(texts(Slot::Replacement));
		if !group.iter().any(|entry| entry.1 == Slot::Delete) {
			lines.push(original.get(index).copied().unwrap_or(""));
		}
		lines.extend(texts(Slot::After));
		if let Some(spans) = spans.as_deref_mut() {
			spans.push(touched(before, lines.len()));
		}
		copied = index + 1;
		first.get_or_insert(line);
	}
	if let Some(rest) = original.get(copied..) {
		lines.extend_from_slice(rest);
	}
	if !bof.is_empty() {
		let count = bof.len() as u32;
		if lines.len() == 1 && lines[0].is_empty() {
			lines = bof;
		} else {
			lines.splice(0..0, bof);
		}
		if let Some(spans) = spans.as_deref_mut() {
			for span in spans.iter_mut() {
				*span = (span.0 + count, span.1 + count);
			}
			spans.push((1, count));
		}
		first = Some(1);
	}
	if !eof.is_empty() {
		let count = eof.len();
		let at = if lines.len() == 1 && lines[0].is_empty() {
			lines = eof;
			1
		} else {
			let index = if lines.last().is_some_and(|line| line.is_empty()) {
				lines.len() - 1
			} else {
				lines.len()
			};
			lines.splice(index..index, eof);
			index + 1
		};
		if let Some(spans) = spans {
			spans.push((at as u32, (at + count - 1) as u32));
		}
		first = Some(first.map_or(at as u32, |old| old.min(at as u32)));
	}
	(lines.join("\n"), first)
}

/// Apply parsed edits to LF-normalized text.
pub fn apply_edits(
	text: &str,
	edits: &[Edit],
	mut options: ApplyOptions<'_>,
) -> Result<ApplyResult, EditError> {
	if edits.is_empty() {
		return Ok(ApplyResult { text: text.to_owned(), ..ApplyResult::default() });
	}
	let lines: Vec<&str> = text.split('\n').collect();
	let mut local_clipboard = Clipboard::default();
	let clipboard = options
		.clipboard
		.as_deref_mut()
		.unwrap_or(&mut local_clipboard);
	let mut clipboard_warnings = Vec::new();
	let concrete =
		resolve_clipboard_edits(edits, &lines, clipboard, options.on_empty_paste, &mut |warning| {
			clipboard_warnings.push(warning);
		})?;
	let mut target = Vec::new();
	for edit in concrete.into_owned() {
		match edit {
			Edit::Block { .. } => return Err(EditError::apply(UNRESOLVED_BLOCK_INTERNAL)),
			Edit::Cut { .. } | Edit::Paste { .. } => {
				return Err(EditError::apply(UNRESOLVED_CLIPBOARD_INTERNAL));
			},
			_ => target.push(edit),
		}
	}
	if let Some(phantom) = phantom_line(&lines) {
		// A range may end on the empty row after the trailing newline (it ends
		// at the last line), but a replacement that starts there names no line:
		// with the delete dropped it would append instead.
		if target.iter().any(|edit| {
			matches!(edit, Edit::Insert { cursor: Cursor::BeforeAnchor(anchor), replacement: true, .. } if anchor.line == phantom)
		}) {
			return Err(out_of_range(phantom, lines.len() - 1));
		}
		target.retain(|edit| !matches!(edit, Edit::Delete { anchor, .. } if anchor.line == phantom));
	}
	for (index, edit) in target.iter_mut().enumerate() {
		set_index(edit, index as u32);
	}
	validate_bounds(&target, &lines)?;
	let mut warnings = clipboard_warnings;
	let mut changed = Vec::new();
	let (result, first_changed_line) = render(&lines, &target, Some(&mut changed));
	let baseline = parses_cleanly(options.path, text);
	let authored_parses = parses_cleanly(options.path, &result);
	let (ambiguities, literal) = classify_echoes(&target, &lines, options.path, authored_parses);
	if let Some(ambiguity) = ambiguities.first() {
		return Err(ambiguity.refusal());
	}
	if let Some(error) = echo_outcome(&target, &lines, options.path, &literal) {
		return Err(error);
	}
	let broke_parse = baseline && !authored_parses;
	if broke_parse && let Some(path) = options.path.filter(|path| has_syntax_oracle(path)) {
		if let Some(error) = landing_rejection(&target, &lines, path) {
			return Err(error);
		}
		if let Some(error) = boundary_fix_rejection(&target, &lines, path, &result, &literal) {
			return Err(error);
		}
		if let Some(line) = parse_error_in(path, &result, &changed) {
			warnings.push(edit_broke_parse_warning(line));
		}
	}
	Ok(ApplyResult {
		text: result,
		first_changed_line,
		warnings,
		block_resolutions: Vec::<BlockResolution>::new(),
	})
}

/// The line of the first syntax error in `text` that touches (or borders) one
/// of the `changed` result spans. Tree-sitter often places errors away from
/// their cause or in constructs its grammar lacks; only an error at the edit
/// is worth reporting.
fn parse_error_in(path: &str, text: &str, changed: &[(u32, u32)]) -> Option<u32> {
	syntax_error_spans(Some(path), text)
		.into_iter()
		.find_map(|(error_start, error_end)| {
			changed.iter().find_map(|&(start, end)| {
				(error_start <= end + 1 && error_end + 1 >= start).then(|| error_start.max(start))
			})
		})
}

/// The last echo check, run on the patch as written.
///
/// For every replacement group whose body restates a neighbouring line, refuse
/// if its rows hold a copy of that line at their edge, or are fewer than the
/// range once such copies are set aside: as written, the patch would duplicate
/// or lose lines that no reading of the body asks for. `classify_echoes`
/// refuses the too-short shapes it recognises with a more specific message.
/// A group in `literal` is the range's final content: its neighbour copy is a
/// line the body adds.
fn echo_outcome(
	edits: &[Edit],
	lines: &[&str],
	path: Option<&str>,
	literal: &[u32],
) -> Option<EditError> {
	let mut i = 0;
	while i < edits.len() {
		let Some(group) = replacement_group(edits, i) else {
			i += 1;
			continue;
		};
		i = group.delete_indices.last().copied().unwrap() + 1;
		if literal.contains(&group.start) {
			continue;
		}
		let range_len = group.delete_indices.len();
		let leading = duplicate_leading(&group, edits, lines);
		let trailing = duplicate_trailing(&group, edits, lines);
		// The same conditions under which `classify_echoes` treats the rows as
		// an echo; elsewhere (a one-row range) they are content.
		let echo = if leading > 0 && trailing > 0 {
			range_len > 1 || group.payload.len().checked_sub(leading + trailing) == Some(range_len)
		} else if leading > 0 {
			range_len > 1
				|| annotation_echo(lines, path, group.start - leading as u32, group.start - 1)
		} else {
			trailing > 0
				&& (range_len > 1
					|| annotation_echo(lines, path, group.end + 1, group.end + trailing as u32))
		};
		if !echo {
			continue;
		}
		let (mut above, mut below) = restated_edges(&group.payload, lines, group.start, group.end);
		if leading == 0 {
			above = 0;
		}
		if trailing == 0 {
			below = 0;
		}
		let supplied = group.payload.len().saturating_sub(above + below);
		if above == 0 && below == 0 && supplied >= range_len {
			continue;
		}
		let (start, end) = (group.start, group.end);
		return Some(EditError::rejected(
			Rejection::AmbiguousBoundary,
			boundary_echo_outcome_message(
				start,
				end,
				(above > 0).then(|| (start - above as u32, start - 1)),
				(below > 0).then(|| (end + 1, end + below as u32)),
				(supplied < range_len).then(|| (start + supplied as u32, end)),
			),
		));
	}
	None
}
