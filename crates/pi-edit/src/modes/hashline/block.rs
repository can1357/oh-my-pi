//! Block-op resolution via tree-sitter (`packages/hashline/src/block.ts` +
//! `block-resolver.ts`).

use std::{
	collections::{HashMap, VecDeque},
	sync::{LazyLock, Mutex},
};

use pi_ast::block::{BlockRangeOptions, block_range_at};
use xxhash_rust::xxh64::xxh64;

use super::{
	apply::STRUCTURAL_CLOSER_RE,
	messages::{
		AbsoluteRangeOp, BlockDiagnosticSuggestions, BlockOp, block_single_line_message,
		block_unresolved_message, insert_after_block_closer_lowered_warning,
		insert_after_block_unresolved_lowered_warning, paste_after_block_closer_lowered_warning,
		paste_after_block_unresolved_lowered_warning,
	},
	types::{
		Anchor, BlockMode, BlockOpKind, BlockResolution, BlockSpan, Cursor, Edit, ParsedRange,
		PasteTarget,
	},
};
use crate::error::EditError;

const BLOCK_SUGGESTION_SCAN_LIMIT: u32 = 64;
const RESOLUTION_CACHE_MAX: usize = 512;
type CacheKey = (u64, usize, u32, String);
type ResolutionCache = (HashMap<CacheKey, Option<BlockSpan>>, VecDeque<CacheKey>);
static RESOLUTION_CACHE: LazyLock<Mutex<ResolutionCache>> =
	LazyLock::new(|| Mutex::new((HashMap::new(), VecDeque::new())));

/// Behavior when a block anchor cannot be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unresolved {
	/// Reject the patch.
	Throw,
	/// Remove the unresolved block edit from the edit stream.
	Drop,
}

/// Whether an edit stream contains a deferred block operation.
pub fn has_block_edit(edits: &[Edit]) -> bool {
	edits.iter().any(|edit| matches!(edit, Edit::Block { .. }))
}

const fn block_mode(mode: Option<BlockMode>) -> (BlockOp, BlockOpKind) {
	match mode {
		None => (BlockOp::Replace, BlockOpKind::Replace),
		Some(BlockMode::InsertAfter) => (BlockOp::InsertAfter, BlockOpKind::InsertAfter),
		Some(BlockMode::Cut) => (BlockOp::Cut, BlockOpKind::Cut),
		Some(BlockMode::PasteAfter) => (BlockOp::PasteAfter, BlockOpKind::PasteAfter),
	}
}

fn find_next_block(
	anchor_line: u32,
	lines: &[String],
	path: &str,
	text: &str,
) -> Option<BlockSpan> {
	let last = (lines.len() as u32).min(anchor_line.saturating_add(BLOCK_SUGGESTION_SCAN_LIMIT));
	for line in anchor_line.saturating_add(1)..=last {
		if lines
			.get((line - 1) as usize)
			.is_none_or(|value| value.trim().is_empty())
		{
			continue;
		}
		if let Some(span) = native_block_resolver(path, text, line)
			&& span.start == line
			&& span.end > line
		{
			return Some(span);
		}
	}
	None
}

fn find_enclosing_block(
	anchor_line: u32,
	lines: &[String],
	path: &str,
	text: &str,
) -> Option<BlockSpan> {
	let first = anchor_line
		.saturating_sub(BLOCK_SUGGESTION_SCAN_LIMIT)
		.max(1);
	for line in (first..anchor_line).rev() {
		if lines
			.get((line - 1) as usize)
			.is_none_or(|value| value.trim().is_empty())
		{
			continue;
		}
		if let Some(span) = native_block_resolver(path, text, line)
			&& span.start == line
			&& span.end >= anchor_line
			&& span.end > line
		{
			return Some(span);
		}
	}
	None
}

/// Resolve deferred block operations to ordinary edits.
pub fn resolve_block_edits(
	edits: &[Edit],
	text: &str,
	path: &str,
	on_unresolved: Unresolved,
	on_resolved: &mut dyn FnMut(BlockResolution),
	on_warning: &mut dyn FnMut(String),
) -> Result<Vec<Edit>, EditError> {
	if !has_block_edit(edits) {
		return Ok(edits.to_vec());
	}
	let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
	let mut resolved = Vec::new();
	let mut synth_index = 0;
	for edit in edits {
		let Edit::Block { anchor, payloads, mode, register, line_num, .. } = edit else {
			resolved.push(edit.clone());
			continue;
		};
		let (message_op, result_op) = block_mode(*mode);
		let Some(span) = native_block_resolver(path, text, anchor.line) else {
			if matches!(mode, Some(BlockMode::InsertAfter | BlockMode::PasteAfter)) {
				let is_closer = lines
					.get((anchor.line.saturating_sub(1)) as usize)
					.is_some_and(|line| STRUCTURAL_CLOSER_RE.is_match(line));
				if *mode == Some(BlockMode::PasteAfter) {
					on_warning(if is_closer {
						paste_after_block_closer_lowered_warning(anchor.line)
					} else {
						paste_after_block_unresolved_lowered_warning(anchor.line)
					});
					resolved.push(Edit::Paste {
						at:          PasteTarget::Gap { cursor: Cursor::AfterAnchor(*anchor) },
						register:    register.clone(),
						line_num:    *line_num,
						index:       synth_index,
						block_start: None,
					});
					synth_index += 1;
				} else {
					on_warning(if is_closer {
						insert_after_block_closer_lowered_warning(anchor.line)
					} else {
						insert_after_block_unresolved_lowered_warning(anchor.line)
					});
					for payload in payloads {
						resolved.push(Edit::Insert {
							cursor:      Cursor::AfterAnchor(*anchor),
							text:        payload.clone(),
							line_num:    *line_num,
							index:       synth_index,
							replacement: false,
							block_start: None,
						});
						synth_index += 1;
					}
				}
				continue;
			}
			if on_unresolved == Unresolved::Drop {
				continue;
			}
			let next = lines
				.get((anchor.line.saturating_sub(1)) as usize)
				.is_some_and(|line| line.trim().is_empty())
				.then(|| find_next_block(anchor.line, &lines, path, text))
				.flatten();
			let enclosing = next
				.is_none()
				.then(|| find_enclosing_block(anchor.line, &lines, path, text))
				.flatten();
			let suggestions =
				BlockDiagnosticSuggestions { next_block: next, enclosing_block: enclosing };
			let line_refs: Vec<_> = lines.iter().map(String::as_str).collect();
			let range_op = if message_op == BlockOp::Cut {
				AbsoluteRangeOp::Cut
			} else {
				AbsoluteRangeOp::Replace
			};
			return Err(EditError::apply(format!(
				"line {line_num}: {}",
				block_unresolved_message(
					anchor.line,
					range_op,
					Some(&line_refs),
					&suggestions,
					register.as_deref()
				)
			)));
		};
		if span.start == span.end {
			if on_unresolved == Unresolved::Drop {
				continue;
			}
			let enclosing = find_enclosing_block(anchor.line, &lines, path, text);
			return Err(EditError::apply(format!(
				"line {line_num}: {}",
				block_single_line_message(anchor.line, message_op, enclosing)
			)));
		}
		on_resolved(BlockResolution {
			anchor_line: anchor.line,
			start:       span.start,
			end:         span.end,
			op:          result_op,
		});
		match mode {
			Some(BlockMode::PasteAfter) => {
				resolved.push(Edit::Paste {
					at:          PasteTarget::Gap {
						cursor: Cursor::AfterAnchor(Anchor { line: span.end }),
					},
					register:    register.clone(),
					line_num:    *line_num,
					index:       synth_index,
					block_start: Some(span.start),
				});
				synth_index += 1;
			},
			Some(BlockMode::Cut) => {
				resolved.push(Edit::Cut {
					range:    ParsedRange {
						start: Anchor { line: span.start },
						end:   Anchor { line: span.end },
					},
					register: register.clone(),
					line_num: *line_num,
					index:    synth_index,
				});
				synth_index += 1;
				for line in span.start..=span.end {
					resolved.push(Edit::Delete {
						anchor:        Anchor { line },
						line_num:      *line_num,
						index:         synth_index,
						old_assertion: None,
					});
					synth_index += 1;
				}
			},
			Some(BlockMode::InsertAfter) => {
				for payload in payloads {
					resolved.push(Edit::Insert {
						cursor:      Cursor::AfterAnchor(Anchor { line: span.end }),
						text:        payload.clone(),
						line_num:    *line_num,
						index:       synth_index,
						replacement: false,
						block_start: Some(span.start),
					});
					synth_index += 1;
				}
			},
			None if register.is_some() => {
				resolved.push(Edit::Paste {
					at:          PasteTarget::Span {
						range: ParsedRange {
							start: Anchor { line: span.start },
							end:   Anchor { line: span.end },
						},
					},
					register:    register.clone(),
					line_num:    *line_num,
					index:       synth_index,
					block_start: None,
				});
				synth_index += 1;
			},
			None => {
				for payload in payloads {
					resolved.push(Edit::Insert {
						cursor:      Cursor::BeforeAnchor(Anchor { line: span.start }),
						text:        payload.clone(),
						line_num:    *line_num,
						index:       synth_index,
						replacement: true,
						block_start: None,
					});
					synth_index += 1;
				}
				for line in span.start..=span.end {
					resolved.push(Edit::Delete {
						anchor:        Anchor { line },
						line_num:      *line_num,
						index:         synth_index,
						old_assertion: None,
					});
					synth_index += 1;
				}
			},
		}
	}
	Ok(resolved)
}

/// Resolve the enclosing syntax block at a 1-indexed line, memoized by content
/// and path.
pub fn native_block_resolver(path: &str, text: &str, line: u32) -> Option<BlockSpan> {
	let key = (xxh64(text.as_bytes(), 0), text.len(), line, path.to_owned());
	if let Ok(guard) = RESOLUTION_CACHE.lock()
		&& let Some(cached) = guard.0.get(&key)
	{
		return *cached;
	}
	let result = block_range_at(BlockRangeOptions {
		code: text.to_owned(),
		lang: None,
		path: Some(path.to_owned()),
		line,
	})
	.ok()
	.flatten()
	.map(|range| BlockSpan { start: range.start_line, end: range.end_line });
	if let Ok(mut guard) = RESOLUTION_CACHE.lock() {
		if guard.0.len() >= RESOLUTION_CACHE_MAX
			&& let Some(oldest) = guard.1.pop_front()
		{
			guard.0.remove(&oldest);
		}
		guard.1.push_back(key.clone());
		guard.0.insert(key, result);
	}
	result
}
