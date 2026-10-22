//! Stale-tag anchor recovery (`packages/hashline/src/recovery.ts`).

use std::{
	collections::{HashMap, HashSet},
	ops::RangeInclusive,
	path::Path,
	sync::Arc,
};

use super::{
	apply::{ApplyOptions, EmptyPaste, apply_edits, replacement_group},
	clipboard::has_clipboard_edit,
	messages::{
		RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING,
		edit_broke_parse_warning,
	},
	syntax::node_chain,
	types::{Anchor, Cursor, Edit, ParsedRange, PasteTarget},
};
use crate::{
	error::EditError,
	fuzzy::similarity,
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

/// Identity of the constructs enclosing `line`: each node's kind paired with
/// the trimmed text of the row it opens, innermost first.
///
/// Positions are useless here — the point is to tell "the list under key `a`"
/// apart from an identically shaped list under key `b`, so the opening row's
/// content carries the identity.
fn enclosing_context(lines: &[&str], path: &str, line: u32) -> Vec<(String, String)> {
	node_chain(lines, path, line)
		.into_iter()
		.filter_map(|span| {
			let opener = lines.get((span.start_line - 1) as usize)?;
			Some((span.kind, opener.trim().to_owned()))
		})
		.collect()
}

/// Whether every remapped anchor still sits in the construct it was authored
/// against.
///
/// The line map is built from a text diff, which only aligns equal rows: an
/// anchor whose row is repeated in the file can therefore map onto the
/// identical row of a sibling construct with a uniform offset and matching
/// neighbors, and the edit lands in the wrong block while every positional
/// check passes. Comparing the enclosing constructs by content rejects those
/// landings. Unparsed or non-source targets report no chain on either side and
/// stay allowed.
fn context_preserved(
	previous: &str,
	current: &str,
	path: &Path,
	authored: &[Edit],
	remapped: &[Edit],
) -> bool {
	let Some(path) = path.to_str() else {
		return true;
	};
	let previous_lines = previous.split('\n').collect::<Vec<_>>();
	let current_lines = current.split('\n').collect::<Vec<_>>();
	let mut checked = HashSet::new();
	for (authored, remapped) in authored.iter().zip(remapped) {
		// The offset is uniform across a remapped patch, so the endpoints of a
		// span pin the interior: parsing every line of a wide CUT would not.
		let authored = edit_anchors(authored);
		let remapped = edit_anchors(remapped);
		let edges = [(authored.first(), remapped.first()), (authored.last(), remapped.last())];
		for (authored, remapped) in edges {
			let (Some(authored), Some(remapped)) = (authored, remapped) else {
				continue;
			};
			if !checked.insert((authored.line, remapped.line)) {
				continue;
			}
			if enclosing_context(&previous_lines, path, authored.line)
				!= enclosing_context(&current_lines, path, remapped.line)
			{
				return false;
			}
		}
	}
	true
}

/// Share of the current lines at its authored numbers a replacement body must
/// keep before it counts as written for them (see [`aimed_at_authored_lines`]).
const AUTHORED_LINES_FLOOR: f64 = 0.5;

/// How much more of those lines than of the remap target the body must keep.
const AUTHORED_LINES_MARGIN: f64 = 0.3;

/// `window chars × body chars` products [`kept_share`] may spend across one
/// recovery; past it the check abstains rather than run quadratic work on a
/// large or many-hunk rewrite.
const KEPT_SHARE_BUDGET: usize = 1 << 23;

/// Minimum trimmed length, in chars, for a line to count as content evidence.
/// Blank lines, closers and one-word rows resemble short bodies by chance.
const KEPT_SHARE_MIN_CHARS: usize = 8;

fn identifies(line: &str) -> bool {
	line.trim().chars().count() >= KEPT_SHARE_MIN_CHARS
}

/// How much of `window` a replacement `body` keeps: each identifying window
/// line scores its best similarity to a body line, any other line scores
/// zero, and the sum is divided by the window length. `None`, leaving
/// `budget` untouched, when the comparison would cost more than is left.
fn kept_share(
	window: &[&str],
	body: &[&str],
	verbatim: &HashSet<&str>,
	budget: &mut usize,
) -> Option<f64> {
	let window_chars: usize = window.iter().map(|line| line.trim().chars().count()).sum();
	let body_chars: usize = body.iter().map(|row| row.chars().count()).sum();
	let cost = window_chars.saturating_mul(body_chars);
	if window.is_empty() || cost > *budget {
		return None;
	}
	*budget -= cost;
	let total: f64 = window
		.iter()
		.map(|line| {
			let line = line.trim();
			if !identifies(line) {
				0.0
			} else if verbatim.contains(line) {
				1.0
			} else {
				body
					.iter()
					.map(|row| similarity(line, row))
					.fold(0.0, f64::max)
			}
		})
		.sum();
	Some(total / window.len() as f64)
}

/// Whether a remapped replacement reads as written for the current lines at
/// its authored numbers rather than for the lines the remap moves it onto.
///
/// The remap is right when the line numbers came from the tagged read. Agents
/// also pair an old tag with numbers taken from an untagged view of the
/// current file (`grep -n`, `sed -n`, a `:raw` read, compiler output); the
/// remap then shifts numbers that were already current, and the body replaces
/// lines the agent never saw there. Such a body keeps much of the current
/// lines at the authored numbers and little of the target. This is a
/// heuristic: a tagged-read rewrite whose new text happens to resemble the
/// lines `offset` away is refused too, at the cost of one retry under the
/// current tag the mismatch reject prints.
fn aimed_at_authored_lines(current: &str, authored: &[Edit], offset: i64) -> bool {
	let mut groups = Vec::new();
	let mut start = 0;
	while start < authored.len() {
		let Some(group) = replacement_group(authored, start) else {
			start += 1;
			continue;
		};
		start = group.delete_indices.last().copied().unwrap_or(start) + 1;
		if group.payload.iter().any(|row| !row.trim().is_empty()) {
			groups.push((group.payload, group.start..=group.end));
		}
	}
	// Shifted inserts and cuts carry no body: skip the file split for them.
	if groups.is_empty() {
		return false;
	}
	let lines = current.split('\n').collect::<Vec<_>>();
	let window = |range: &RangeInclusive<u32>, shift: i64| {
		range
			.clone()
			.map(|line| {
				usize::try_from(i64::from(line) + shift - 1)
					.ok()
					.and_then(|index| lines.get(index).copied())
					.unwrap_or("")
			})
			.collect::<Vec<_>>()
	};
	let mut budget = KEPT_SHARE_BUDGET;
	for (payload, range) in &groups {
		let body = payload
			.iter()
			.map(|row| row.trim())
			.filter(|row| !row.is_empty())
			.collect::<Vec<_>>();
		let target = window(range, offset);
		// A target with no identifying line gives nothing to tell the two
		// readings apart.
		if !target.iter().any(|line| identifies(line)) {
			continue;
		}
		let verbatim = body.iter().copied().collect::<HashSet<_>>();
		let Some(kept) = kept_share(&window(range, 0), &body, &verbatim, &mut budget) else {
			return false;
		};
		if kept < AUTHORED_LINES_FLOOR {
			continue;
		}
		let Some(target_kept) = kept_share(&target, &body, &verbatim, &mut budget) else {
			return false;
		};
		if kept > target_kept + AUTHORED_LINES_MARGIN {
			return true;
		}
	}
	false
}

/// Attempt to rebase stale anchors from a retained snapshot onto current text.
///
/// A shifted remap is refused (falling through to the mismatch reject, which
/// shows the current tag and lines) when a replacement reads as written for
/// the current lines at its authored numbers, or when the remapped edit breaks
/// a file that parsed: both suggest the agent's numbers were already current.
pub fn try_recover(
	store: &EditStore,
	args: RecoveryArgs<'_>,
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
	if !context_preserved(&snapshot.text, args.current_text, args.path, args.edits, &edits) {
		return Ok(None);
	}
	if offset != 0 && aimed_at_authored_lines(args.current_text, args.edits, offset) {
		return Ok(None);
	}
	// The parse check below can refuse after the apply has cut into registers,
	// so clipboard edits run on a fork published only once recovery stands.
	let mut clipboard = args
		.clipboard
		.as_deref()
		.filter(|_| has_clipboard_edit(&edits))
		.map(Clipboard::fork);
	let Ok(applied) = apply_edits(args.current_text, &edits, ApplyOptions {
		clipboard:      clipboard.as_mut(),
		path:           args.path.to_str(),
		on_empty_paste: EmptyPaste::Throw,
	}) else {
		return Ok(None);
	};
	if applied.text == args.current_text {
		return Ok(None);
	}
	if offset != 0
		&& applied
			.warnings
			.contains(&edit_broke_parse_warning(applied.first_changed_line))
	{
		return Ok(None);
	}
	if let (Some(target), Some(clipboard)) = (args.clipboard, clipboard) {
		*target = clipboard;
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
