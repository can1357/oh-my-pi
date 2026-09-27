//! Edit application with boundary repair (`packages/hashline/src/apply.ts`).

use std::{
	collections::{BTreeMap, HashMap, HashSet},
	sync::LazyLock,
};

use regex::Regex;

use super::{
	clipboard::resolve_clipboard_edits,
	messages::{
		BoundarySide, REPLACEMENT_INDENT_AUTO_SHIFT_WARNING, UNRESOLVED_BLOCK_INTERNAL,
		UNRESOLVED_CLIPBOARD_INTERNAL, after_insert_landing_shift_warning,
		after_insert_opener_escape_warning, ambiguous_boundary_echo_message,
		ambiguous_boundary_placement_message, block_insert_landing_shift_warning,
		boundary_variant_repair_warning, edit_broke_parse_warning, textual_boundary_echo_warning,
	},
	syntax::{enclosing_boundaries, node_chain, parses_cleanly},
	types::{Anchor, ApplyResult, BlockResolution, Cursor, Edit},
};
use crate::{error::EditError, store::Clipboard};

/// A line containing only closing delimiters and an optional trailing
/// separator.
pub static STRUCTURAL_CLOSER_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*[)\]}]+[;,]?\s*$").expect("valid structural-closer regex"));

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

fn with_index(edit: &Edit, index: u32) -> Edit {
	match edit {
		Edit::Insert { cursor, text, line_num, replacement, block_start, .. } => Edit::Insert {
			cursor: *cursor,
			text: text.clone(),
			line_num: *line_num,
			index,
			replacement: *replacement,
			block_start: *block_start,
		},
		Edit::Delete { anchor, line_num, old_assertion, .. } => Edit::Delete {
			anchor: *anchor,
			line_num: *line_num,
			index,
			old_assertion: old_assertion.clone(),
		},
		_ => edit.clone(),
	}
}

fn phantom_line(lines: &[String]) -> Option<u32> {
	(lines.len() > 1 && lines.last().is_some_and(String::is_empty)).then_some(lines.len() as u32)
}

fn validate_bounds(edits: &[Edit], lines: &[String]) -> Result<(), EditError> {
	for edit in edits {
		for anchor in anchors(edit) {
			if anchor.line < 1 || anchor.line as usize > lines.len() {
				return Err(EditError::apply(format!(
					"Line {} does not exist (file has {} lines)",
					anchor.line,
					lines.len()
				)));
			}
		}
	}
	Ok(())
}

#[derive(Clone)]
struct ReplacementGroup {
	insert_indices: Vec<usize>,
	delete_indices: Vec<usize>,
	payload:        Vec<String>,
	start:          u32,
	end:            u32,
}

fn replacement_group(edits: &[Edit], start: usize) -> Option<ReplacementGroup> {
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

fn repair_indentation(edits: &mut [Edit], lines: &[String]) -> Vec<String> {
	let mut repaired = false;
	let mut start = 0;
	while start < edits.len() {
		let Some(group) = replacement_group(edits, start) else {
			start += 1;
			continue;
		};
		start = group.delete_indices.last().copied().unwrap_or(start) + 1;
		if group.payload.len() != group.delete_indices.len() {
			continue;
		}
		let preceding = lines
			.get(group.start.saturating_sub(2) as usize)
			.map_or("", String::as_str);
		let source_first = lines
			.get((group.start - 1) as usize)
			.map_or("", String::as_str);
		let payload_first = group.payload.first().map_or("", String::as_str);
		if !preceding.trim_end().ends_with('{')
			|| !indent_deeper(leading_indent(source_first), leading_indent(preceding))
			|| indent_deeper(leading_indent(payload_first), leading_indent(preceding))
		{
			continue;
		}
		let mut shift: Option<&str> = None;
		let mut matches = 0;
		let mut consistent = true;
		for (offset, payload) in group.payload.iter().enumerate() {
			let source = lines
				.get((group.start - 1) as usize + offset)
				.map_or("", String::as_str);
			if source.trim().is_empty() || source.trim_start() != payload.trim_start() {
				continue;
			}
			let source_indent = leading_indent(source);
			let payload_indent = leading_indent(payload);
			if !source_indent.ends_with(payload_indent) {
				consistent = false;
				break;
			}
			let candidate = &source_indent[..source_indent.len() - payload_indent.len()];
			if shift.is_some_and(|old| old != candidate) {
				consistent = false;
				break;
			}
			shift = Some(candidate);
			matches += 1;
		}
		let Some(shift) = shift else { continue };
		if !consistent || shift.is_empty() || matches < 2 || matches * 2 <= group.payload.len() {
			continue;
		}
		for &index in &group.insert_indices {
			if let Edit::Insert { text, .. } = &mut edits[index]
				&& !text.trim().is_empty()
			{
				text.insert_str(0, shift);
			}
		}
		repaired = true;
	}
	if repaired {
		vec![REPLACEMENT_INDENT_AUTO_SHIFT_WARNING.to_owned()]
	} else {
		Vec::new()
	}
}

fn duplicate_leading(group: &ReplacementGroup, lines: &[String]) -> usize {
	let max = group
		.payload
		.len()
		.min(group.start.saturating_sub(1) as usize);
	for count in (1..=max).rev() {
		let source_start = group.start as usize - 1 - count;
		let candidate = &group.payload[..count];
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
fn duplicate_trailing(group: &ReplacementGroup, lines: &[String]) -> usize {
	let max = group
		.payload
		.len()
		.min(lines.len().saturating_sub(group.end as usize));
	for count in (1..=max).rev() {
		let payload = &group.payload[group.payload.len() - count..];
		let source = &lines[group.end as usize..group.end as usize + count];
		if payload.iter().zip(source).all(|(a, b)| a == b)
			&& payload.iter().any(|line| has_content(line))
		{
			return count;
		}
	}
	0
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

fn annotation_echo(lines: &[String], path: Option<&str>, first: u32, last: u32) -> bool {
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

#[derive(Clone, Copy)]
struct Ambiguity {
	start: u32,
	end:   u32,
	side:  BoundarySide,
	count: u32,
}

fn normalize_echoes(
	edits: &[Edit],
	lines: &[String],
	path: Option<&str>,
) -> (Vec<Edit>, Vec<String>, Vec<Ambiguity>) {
	let mut out = Vec::new();
	let mut warnings = Vec::new();
	let mut ambiguities = Vec::new();
	let mut i = 0;
	while i < edits.len() {
		let Some(group) = replacement_group(edits, i) else {
			out.push(with_index(&edits[i], i as u32));
			i += 1;
			continue;
		};
		let leading = duplicate_leading(&group, lines);
		let trailing = duplicate_trailing(&group, lines);
		let range_len = group.delete_indices.len();
		let (mut drop_l, mut drop_t) = (0, 0);
		if leading > 0 && trailing > 0 {
			if group.payload.len().saturating_sub(leading + trailing) == range_len {
				drop_l = leading;
				drop_t = trailing;
			}
		} else if leading > 0
			&& (range_len > 1
				|| annotation_echo(lines, path, group.start - leading as u32, group.start - 1))
		{
			if group.payload.len().saturating_sub(leading) >= range_len {
				drop_l = leading;
			} else {
				ambiguities.push(Ambiguity {
					start: group.start,
					end:   group.end,
					side:  BoundarySide::Leading,
					count: leading as u32,
				});
			}
		} else if trailing > 0
			&& (range_len > 1
				|| annotation_echo(lines, path, group.end + 1, group.end + trailing as u32))
		{
			if group.payload.len().saturating_sub(trailing) >= range_len {
				drop_t = trailing;
			} else {
				ambiguities.push(Ambiguity {
					start: group.start,
					end:   group.end,
					side:  BoundarySide::Trailing,
					count: trailing as u32,
				});
			}
		}
		if drop_l > 0 || drop_t > 0 {
			let inserts = group_inserts(&group, edits);
			out.extend(inserts[drop_l..inserts.len() - drop_t].iter().cloned());
			out.extend(group_deletes(&group, edits));
			warnings.push(textual_boundary_echo_warning(group.start, drop_l as u32, drop_t as u32));
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
	(out, warnings, ambiguities)
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
fn nearest_content(lines: &[String], start: isize, step: isize) -> Option<&str> {
	let mut index = start;
	while index >= 0 && (index as usize) < lines.len() {
		if has_content(&lines[index as usize]) {
			return Some(&lines[index as usize]);
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
fn effective_trailing(group: &ReplacementGroup, edits: &[Edit], lines: &[String]) -> u32 {
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
fn essential(lines: &[String], path: &str, line: u32, baseline: bool) -> bool {
	if !baseline {
		return true;
	}
	let without = lines[..(line - 1) as usize]
		.iter()
		.chain(&lines[line as usize..])
		.cloned()
		.collect::<Vec<_>>()
		.join("\n");
	!parses_cleanly(Some(path), &without)
}

#[derive(Clone)]
struct Variant {
	edits:   Vec<Edit>,
	kept:    usize,
	dropped: usize,
}

fn group_variants(
	group: &ReplacementGroup,
	edits: &[Edit],
	lines: &[String],
	path: &str,
	baseline: bool,
) -> (Vec<Variant>, bool) {
	let inserts = group_inserts(group, edits);
	let deletes = group_deletes(group, edits);
	let trailing = effective_trailing(group, edits, lines);
	let first_essential = essential(lines, path, group.start, baseline);
	let last_essential = if trailing == group.start {
		first_essential
	} else {
		essential(lines, path, trailing, baseline)
	};
	let inner_start = group.start + 1;
	let leading_structure = baseline
		&& inner_start <= trailing
		&& enclosing_boundaries(lines, path, inner_start, trailing).contains(&group.start);
	let drop_j = duplicate_leading(group, lines);
	let drop_k = duplicate_trailing(group, lines);
	let leading_drops: Vec<_> = if drop_j > 0 { vec![0, drop_j] } else { vec![0] };
	let trailing_drops: Vec<_> = if drop_k > 0 { vec![0, drop_k] } else { vec![0] };
	let mut variants = Vec::new();
	let mut ambiguous = false;
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
			let first = lines
				.get((group.start - 1) as usize)
				.map_or("", String::as_str);
			let last = lines
				.get((trailing - 1) as usize)
				.map_or("", String::as_str);
			let mut plans: Vec<(Option<u32>, Option<u32>, usize)> = vec![(None, None, 0)];
			if group.start == trailing {
				let previous = nearest_content(lines, group.start as isize - 2, -1);
				let fits = previous.is_none_or(|line| indent_columns(line) == indent_columns(trail));
				if first_essential && fits && indent_columns(trail) > indent_columns(first) {
					plans.push((None, Some(group.start), 1));
				} else if baseline && first_essential && indent_columns(trail) == indent_columns(first)
				{
					ambiguous = true;
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
						== indent_columns(
							lines
								.get((group.end - 1) as usize)
								.map_or("", String::as_str),
						);
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
				if baseline
					&& first_essential
					&& before_first.is_some_and(|line| indent_columns(first) < indent_columns(line))
					&& indent_columns(lead) > indent_columns(first)
				{
					ambiguous = true;
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
				variants.push(Variant { edits: result, kept, dropped });
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

type RepairedEdits = (Vec<Edit>, Vec<String>);

fn repair_boundaries(
	edits: &[Edit],
	lines: &[String],
	path: Option<&str>,
	baseline: bool,
) -> Result<Option<RepairedEdits>, EditError> {
	let Some(path) = path else { return Ok(None) };
	let mut groups = Vec::new();
	let mut ambiguous = None;
	let mut i = 0;
	while i < edits.len() {
		if let Some(group) = replacement_group(edits, i) {
			let (variants, is_ambiguous) = group_variants(&group, edits, lines, path, baseline);
			if is_ambiguous && ambiguous.is_none() {
				ambiguous = Some((group.start, group.end));
			}
			if !variants.is_empty() {
				groups.push((group.clone(), variants));
			}
			i = group.delete_indices.last().copied().unwrap() + 1;
		} else {
			i += 1;
		}
	}
	if groups.is_empty() {
		if let Some((start, end)) = ambiguous {
			return Err(EditError::apply(ambiguous_boundary_placement_message(start, end)));
		}
		return Ok(None);
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
	let authored = materialize(lines, edits).0;
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
				if let Some((start, end)) = ambiguous {
					return Err(EditError::apply(ambiguous_boundary_placement_message(start, end)));
				}
				return Ok(None);
			}
		} else {
			best = Some((combo, text));
		}
	}
	let Some((combo, _)) = best else {
		if let Some((start, end)) = ambiguous {
			return Err(EditError::apply(ambiguous_boundary_placement_message(start, end)));
		}
		return Ok(None);
	};
	let warnings = groups
		.iter()
		.zip(&combo.choices)
		.filter_map(|((group, variants), choice)| {
			choice.map(|index| {
				let variant = &variants[index];
				boundary_variant_repair_warning(
					group.start,
					variant.kept as u32,
					variant.dropped as u32,
				)
			})
		})
		.collect();
	Ok(Some((splice_variants(edits, &groups, &combo.choices), warnings)))
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
		.filter(|row| has_content(row))
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
	let owned: Vec<_> = rows.iter().map(|row| (*row).to_owned()).collect();
	let mut line = 1_usize;
	while line <= last {
		if !has_content(rows[line - 1]) {
			line += 1;
			continue;
		}
		let end = node_chain(&owned, path, line as u32)
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

fn repair_landings(
	edits: &[Edit],
	lines: &[String],
	path: Option<&str>,
) -> (Vec<Edit>, Vec<String>) {
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
	let mut out = edits.to_vec();
	let mut warnings = Vec::new();
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
			.map_or("", String::as_str);
		let mut outward = None;
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
			if !blocked && landing != group.anchor {
				outward = Some((landing, crossed));
			}
		}
		if let Some((landing, crossed)) = outward {
			for &index in &group.members {
				if let Edit::Insert { cursor, .. } = &mut out[index] {
					*cursor = Cursor::AfterAnchor(Anchor { line: landing });
				}
			}
			warnings.push(after_insert_landing_shift_warning(group.anchor, landing, crossed));
			continue;
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
				if !blocked && landing != group.anchor {
					for &index in &group.members {
						if let Edit::Insert { cursor, .. } = &mut out[index] {
							*cursor = Cursor::AfterAnchor(Anchor { line: landing });
						}
					}
					warnings.push(block_insert_landing_shift_warning(
						block_start,
						group.anchor,
						landing,
					));
				}
			}
		} else if let Some(path) = path {
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
								&& indent_columns(&lines[(node.start_line - 1) as usize]) <= target_cols
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
						let mut trial = out.clone();
						for &index in &group.members {
							if let Edit::Insert { cursor, .. } = &mut trial[index] {
								*cursor = Cursor::AfterAnchor(Anchor { line: landing });
							}
						}
						if parses_cleanly(Some(path), &materialize(lines, &trial).0) {
							out = trial;
							warnings.push(after_insert_opener_escape_warning(group.anchor, landing));
							break;
						}
					}
				}
			}
		}
	}
	(out, warnings)
}

fn materialize(original: &[String], edits: &[Edit]) -> (String, Option<u32>) {
	let mut lines = original.to_vec();
	let mut first = None;
	let mut bof = Vec::new();
	let mut eof = Vec::new();
	let mut buckets: BTreeMap<u32, Vec<(usize, Edit)>> = BTreeMap::new();
	for (index, edit) in edits.iter().enumerate() {
		match edit {
			Edit::Insert { cursor: Cursor::Bof, text, .. } => bof.push(text.clone()),
			Edit::Insert { cursor: Cursor::Eof, text, .. } => eof.push(text.clone()),
			Edit::Insert {
				cursor: Cursor::BeforeAnchor(anchor) | Cursor::AfterAnchor(anchor),
				..
			} => buckets
				.entry(anchor.line)
				.or_default()
				.push((index, edit.clone())),
			Edit::Delete { anchor, .. } => buckets
				.entry(anchor.line)
				.or_default()
				.push((index, edit.clone())),
			_ => {},
		}
	}
	for (line, mut bucket) in buckets.into_iter().rev() {
		bucket.sort_by_key(|(index, _)| *index);
		let index = (line - 1) as usize;
		let current = lines.get(index).cloned().unwrap_or_default();
		let mut before = Vec::new();
		let mut replacements = Vec::new();
		let mut after = Vec::new();
		let mut delete = false;
		for (_, edit) in bucket {
			match edit {
				Edit::Insert { cursor: Cursor::AfterAnchor(_), text, .. } => after.push(text),
				Edit::Insert { text, replacement: true, .. } => replacements.push(text),
				Edit::Insert { text, .. } => before.push(text),
				Edit::Delete { .. } => delete = true,
				_ => {},
			}
		}
		if before.is_empty() && replacements.is_empty() && after.is_empty() && !delete {
			continue;
		}
		let mut replacement = before;
		replacement.extend(replacements);
		if !delete {
			replacement.push(current);
		}
		replacement.extend(after);
		lines.splice(index..=index, replacement);
		first = Some(first.map_or(line, |old: u32| old.min(line)));
	}
	if !bof.is_empty() {
		if lines.len() == 1 && lines[0].is_empty() {
			lines = bof;
		} else {
			lines.splice(0..0, bof);
		}
		first = Some(1);
	}
	if !eof.is_empty() {
		let at = if lines.len() == 1 && lines[0].is_empty() {
			lines = eof;
			1
		} else {
			let index = if lines.last().is_some_and(String::is_empty) {
				lines.len() - 1
			} else {
				lines.len()
			};
			lines.splice(index..index, eof);
			index + 1
		};
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
	let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
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
	for edit in concrete {
		match edit {
			Edit::Block { .. } => return Err(EditError::apply(UNRESOLVED_BLOCK_INTERNAL)),
			Edit::Cut { .. } | Edit::Paste { .. } => {
				return Err(EditError::apply(UNRESOLVED_CLIPBOARD_INTERNAL));
			},
			_ => target.push(edit),
		}
	}
	if let Some(phantom) = phantom_line(&lines) {
		target.retain(|edit| !matches!(edit, Edit::Delete { anchor, .. } if anchor.line == phantom));
	}
	for (index, edit) in target.clone().iter().enumerate() {
		target[index] = with_index(edit, index as u32);
	}
	validate_bounds(&target, &lines)?;
	let indentation_warnings = repair_indentation(&mut target, &lines);
	let (landed, landing_warnings) = repair_landings(&target, &lines, options.path);
	let (normalized, echo_warnings, ambiguities) = normalize_echoes(&landed, &lines, options.path);
	let mut leading = clipboard_warnings;
	leading.extend(indentation_warnings);
	leading.extend(landing_warnings);
	leading.extend(echo_warnings);
	let authored = materialize(&lines, &normalized);
	let baseline = parses_cleanly(options.path, text);
	let authored_parses = parses_cleanly(options.path, &authored.0);
	let finish = |result: (String, Option<u32>), mut warnings: Vec<String>| {
		if !parses_cleanly(options.path, &result.0) && baseline {
			warnings.push(edit_broke_parse_warning(result.1));
		}
		ApplyResult {
			text: result.0,
			first_changed_line: result.1,
			warnings,
			block_resolutions: Vec::<BlockResolution>::new(),
		}
	};
	if authored_parses {
		if let Some(ambiguity) = ambiguities.first() {
			return Err(EditError::apply(ambiguous_boundary_echo_message(
				ambiguity.start,
				ambiguity.end,
				ambiguity.side,
				ambiguity.count,
			)));
		}
		return Ok(finish(authored, leading));
	}
	if let Some((repaired, warnings)) =
		repair_boundaries(&normalized, &lines, options.path, baseline)?
	{
		let result = materialize(&lines, &repaired);
		if parses_cleanly(options.path, &result.0) {
			leading.extend(warnings);
			return Ok(finish(result, leading));
		}
	}
	if let Some(ambiguity) = ambiguities.first() {
		return Err(EditError::apply(ambiguous_boundary_echo_message(
			ambiguity.start,
			ambiguity.end,
			ambiguity.side,
			ambiguity.count,
		)));
	}
	Ok(finish(authored, leading))
}
