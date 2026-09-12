//! Stale-tag anchor recovery (`packages/hashline/src/recovery.ts`).

use std::{
	collections::{HashMap, HashSet},
	path::Path,
	sync::Arc,
};

use super::{
	apply::{ApplyOptions, EmptyPaste, apply_edits},
	messages::{
		RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING,
	},
	types::{Anchor, Cursor, Edit, ParsedRange, PasteTarget},
};
use crate::{
	error::EditError,
	store::{Clipboard, EditStore},
};

/// Inputs for stale-snapshot recovery.
pub struct RecoveryArgs<'a> {
	/// Canonical target path.
	pub path:         &'a Path,
	/// Current LF-normalized file text.
	pub current_text: &'a str,
	/// Requested stale snapshot tag.
	pub file_hash:    &'a str,
	/// Parsed edits anchored against the stale snapshot.
	pub edits:        &'a [Edit],
	/// Transactional clipboard, when the patch uses cut/paste.
	pub clipboard:    Option<&'a mut Clipboard>,
}

/// Successfully recovered application result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryResult {
	/// Recovered post-edit text.
	pub text:               String,
	/// First changed line in the live file.
	pub first_changed_line: Option<u32>,
	/// Recovery banner followed by apply-time warnings.
	pub warnings:           Vec<String>,
}

fn edit_anchors(edit: &Edit) -> Vec<Anchor> {
	match edit {
		Edit::Delete { anchor, .. } | Edit::Block { anchor, .. } => vec![*anchor],
		Edit::Cut { range, .. } => (range.start.line..=range.end.line)
			.map(|line| Anchor { line })
			.collect(),
		Edit::Paste { at: PasteTarget::Span { range }, .. } => (range.start.line..=range.end.line)
			.map(|line| Anchor { line })
			.collect(),
		Edit::Paste { at: PasteTarget::Gap { cursor }, .. } | Edit::Insert { cursor, .. } => {
			match cursor {
				Cursor::BeforeAnchor(anchor) | Cursor::AfterAnchor(anchor) => vec![*anchor],
				Cursor::Bof | Cursor::Eof => Vec::new(),
			}
		},
	}
}

fn build_line_map(previous: &str, current: &str) -> HashMap<u32, u32> {
	let mut map = HashMap::new();
	let mut previous_line = 1_u32;
	let mut current_line = 1_u32;
	for run in pi_diff::line_runs_str(previous, current) {
		if run.added {
			current_line += run.count;
		} else if run.removed {
			previous_line += run.count;
		} else {
			for offset in 0..run.count {
				map.insert(previous_line + offset, current_line + offset);
			}
			previous_line += run.count;
			current_line += run.count;
		}
	}
	map
}

fn duplicated_values(lines: &[&str]) -> HashSet<String> {
	let mut seen = HashSet::new();
	let mut duplicated = HashSet::new();
	for line in lines {
		if !seen.insert(*line) {
			duplicated.insert((*line).to_owned());
		}
	}
	duplicated
}

#[derive(Clone, Copy)]
struct Neighbors {
	before: Option<u32>,
	after:  Option<u32>,
}

fn anchor_neighbors(anchor_lines: &HashSet<u32>, line_count: usize) -> HashMap<u32, Neighbors> {
	let mut sorted: Vec<_> = anchor_lines.iter().copied().collect();
	sorted.sort_unstable();
	let mut neighbors = HashMap::new();
	let mut i = 0;
	while i < sorted.len() {
		let mut j = i;
		while j + 1 < sorted.len() && sorted[j + 1] == sorted[j] + 1 {
			j += 1;
		}
		let start = sorted[i];
		let end = sorted[j];
		let before = (start > 1).then_some(start - 1);
		let after = ((end as usize) < line_count).then_some(end + 1);
		for &line in &sorted[i..=j] {
			neighbors.insert(line, Neighbors { before, after });
		}
		i = j + 1;
	}
	neighbors
}

fn validate_context(
	previous: &str,
	current: &str,
	line_map: &HashMap<u32, u32>,
	edits: &[Edit],
) -> bool {
	let previous_lines: Vec<_> = previous.split('\n').collect();
	let current_lines: Vec<_> = current.split('\n').collect();
	let anchors: HashSet<_> = edits
		.iter()
		.flat_map(edit_anchors)
		.map(|anchor| anchor.line)
		.collect();
	let previous_duplicates = duplicated_values(&previous_lines);
	let current_duplicates = duplicated_values(&current_lines);
	for (line, neighbors) in anchor_neighbors(&anchors, previous_lines.len()) {
		let Some(&mapped) = line_map.get(&line) else {
			return false;
		};
		let previous_value = previous_lines
			.get((line - 1) as usize)
			.copied()
			.unwrap_or("");
		let current_value = current_lines
			.get((mapped - 1) as usize)
			.copied()
			.unwrap_or("");
		if !previous_duplicates.contains(previous_value)
			&& !current_duplicates.contains(current_value)
		{
			let offset = i64::from(mapped) - i64::from(line);
			let after_matches = neighbors.after.is_some_and(|after| {
				line_map
					.get(&after)
					.is_some_and(|&value| i64::from(value) == i64::from(after) + offset)
			});
			let before_matches = neighbors.before.is_some_and(|before| {
				line_map
					.get(&before)
					.is_some_and(|&value| i64::from(value) == i64::from(before) + offset)
			});
			if !after_matches && !before_matches {
				return false;
			}
		} else {
			let mut checked = false;
			if let Some(before) = neighbors.before {
				checked = true;
				if line_map.get(&before).copied() != mapped.checked_sub(line - before) {
					return false;
				}
			}
			if let Some(after) = neighbors.after {
				checked = true;
				if line_map.get(&after).copied() != Some(mapped + (after - line)) {
					return false;
				}
			}
			if !checked {
				return false;
			}
		}
	}
	true
}

fn map_line(line_map: &HashMap<u32, u32>, line: u32, offsets: &mut Vec<i64>) -> Option<u32> {
	let mapped = *line_map.get(&line)?;
	offsets.push(i64::from(mapped) - i64::from(line));
	Some(mapped)
}

fn remap_edits(previous: &str, current: &str, edits: &[Edit]) -> Option<(Vec<Edit>, i64)> {
	let line_map = build_line_map(previous, current);
	if !validate_context(previous, current, &line_map, edits) {
		return None;
	}
	let mut offsets = Vec::new();
	let mut remapped = Vec::with_capacity(edits.len());
	for edit in edits {
		let mapped = match edit {
			Edit::Delete { anchor, line_num, index, old_assertion } => Edit::Delete {
				anchor:        Anchor { line: map_line(&line_map, anchor.line, &mut offsets)? },
				line_num:      *line_num,
				index:         *index,
				old_assertion: old_assertion.clone(),
			},
			Edit::Block { anchor, payloads, mode, register, line_num, index } => Edit::Block {
				anchor:   Anchor { line: map_line(&line_map, anchor.line, &mut offsets)? },
				payloads: payloads.clone(),
				mode:     *mode,
				register: register.clone(),
				line_num: *line_num,
				index:    *index,
			},
			Edit::Cut { range, register, line_num, index } => {
				let start = map_line(&line_map, range.start.line, &mut offsets)?;
				let mut end = start;
				for line in range.start.line + 1..=range.end.line {
					end = map_line(&line_map, line, &mut offsets)?;
				}
				Edit::Cut {
					range:    ParsedRange { start: Anchor { line: start }, end: Anchor { line: end } },
					register: register.clone(),
					line_num: *line_num,
					index:    *index,
				}
			},
			Edit::Paste { at, register, line_num, index, block_start } => {
				let block_start = match block_start {
					Some(line) => Some(map_line(&line_map, *line, &mut offsets)?),
					None => None,
				};
				let at = match at {
					PasteTarget::Span { range } => {
						let start = map_line(&line_map, range.start.line, &mut offsets)?;
						let mut end = start;
						for line in range.start.line + 1..=range.end.line {
							end = map_line(&line_map, line, &mut offsets)?;
						}
						PasteTarget::Span {
							range: ParsedRange {
								start: Anchor { line: start },
								end:   Anchor { line: end },
							},
						}
					},
					PasteTarget::Gap { cursor: Cursor::BeforeAnchor(anchor) } => PasteTarget::Gap {
						cursor: Cursor::BeforeAnchor(Anchor {
							line: map_line(&line_map, anchor.line, &mut offsets)?,
						}),
					},
					PasteTarget::Gap { cursor: Cursor::AfterAnchor(anchor) } => PasteTarget::Gap {
						cursor: Cursor::AfterAnchor(Anchor {
							line: map_line(&line_map, anchor.line, &mut offsets)?,
						}),
					},
					PasteTarget::Gap { cursor } => PasteTarget::Gap { cursor: *cursor },
				};
				Edit::Paste {
					at,
					register: register.clone(),
					line_num: *line_num,
					index: *index,
					block_start,
				}
			},
			Edit::Insert { cursor, text, line_num, index, replacement, block_start } => {
				let block_start = match block_start {
					Some(line) => Some(map_line(&line_map, *line, &mut offsets)?),
					None => None,
				};
				let cursor = match cursor {
					Cursor::BeforeAnchor(anchor) => Cursor::BeforeAnchor(Anchor {
						line: map_line(&line_map, anchor.line, &mut offsets)?,
					}),
					Cursor::AfterAnchor(anchor) => Cursor::AfterAnchor(Anchor {
						line: map_line(&line_map, anchor.line, &mut offsets)?,
					}),
					other => *other,
				};
				Edit::Insert {
					cursor,
					text: text.clone(),
					line_num: *line_num,
					index: *index,
					replacement: *replacement,
					block_start,
				}
			},
		};
		remapped.push(mapped);
	}
	let (&first, rest) = offsets.split_first()?;
	if rest.iter().any(|offset| *offset != first) {
		return None;
	}
	Some((remapped, first))
}

/// Attempt to rebase stale anchors from a retained snapshot onto current text.
pub fn try_recover(
	store: &EditStore,
	mut args: RecoveryArgs<'_>,
) -> Result<Option<RecoveryResult>, EditError> {
	let Some(snapshot) = store.by_hash(args.path, args.file_hash) else {
		return Ok(None);
	};
	let warning = if store
		.head(args.path)
		.is_some_and(|head| Arc::ptr_eq(&head.text, &snapshot.text))
	{
		RECOVERY_EXTERNAL_WARNING
	} else {
		RECOVERY_SESSION_CHAIN_WARNING
	};
	let Some((edits, offset)) = remap_edits(&snapshot.text, args.current_text, args.edits) else {
		return Ok(None);
	};
	let Ok(applied) = apply_edits(args.current_text, &edits, ApplyOptions {
		clipboard:      args.clipboard.take(),
		path:           args.path.to_str(),
		on_empty_paste: EmptyPaste::Throw,
	}) else {
		return Ok(None);
	};
	if applied.text == args.current_text {
		return Ok(None);
	}
	let mut warnings = vec![if offset == 0 {
		warning.to_owned()
	} else {
		RECOVERY_LINE_REMAP_WARNING.to_owned()
	}];
	warnings.extend(applied.warnings);
	Ok(Some(RecoveryResult {
		text: applied.text,
		first_changed_line: applied.first_changed_line,
		warnings,
	}))
}
