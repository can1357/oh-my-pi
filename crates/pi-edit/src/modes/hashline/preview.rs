//! Streaming section previews
//! (`packages/coding-agent/src/edit/hashline/diff.ts`).

use super::{
	apply::EmptyPaste,
	block::{Unresolved, resolve_block_edits},
	clipboard::resolve_clipboard_edits,
	input::{Patch, PatchSection, contains_recognizable_hashline_operations},
	parser::parse_patch_streaming,
	patcher::{apply_with_recovery, recover_target},
	types::{Cursor, Edit, FileOp},
};
use crate::{
	diff_string::{BlockContextSource, generate_diff_string},
	engine::{FileOp as EngineFileOp, PreviewFile},
	files::FileSource,
	store::{Clipboard, EditStore},
};

fn cursor_line(cursor: Cursor, file_line_count: usize) -> u32 {
	match cursor {
		Cursor::Bof => 1,
		Cursor::Eof => u32::try_from(file_line_count)
			.unwrap_or(u32::MAX)
			.saturating_add(1),
		Cursor::BeforeAnchor(anchor) => anchor.line,
		Cursor::AfterAnchor(anchor) => anchor.line.saturating_add(1),
	}
}

fn streaming_diff(
	section: &PatchSection,
	normalized: &str,
	clipboard: &mut Clipboard,
) -> Result<(String, Option<u32>), String> {
	let parsed = parse_patch_streaming(&section.diff).map_err(|error| error.to_string())?;
	let block_resolved = resolve_block_edits(
		&parsed.edits,
		normalized,
		&section.path,
		Unresolved::Drop,
		&mut |_| {},
		&mut |_| {},
	)
	.map_err(|error| error.to_string())?;
	let file_lines = normalized
		.split('\n')
		.map(str::to_owned)
		.collect::<Vec<_>>();
	let mut scratch = clipboard.fork();
	let resolved = match resolve_clipboard_edits(
		&block_resolved,
		&file_lines,
		&mut scratch,
		EmptyPaste::Drop,
		&mut |_| {},
	) {
		Ok(edits) => {
			*clipboard = scratch;
			edits
		},
		Err(_) => block_resolved
			.into_iter()
			.filter(|edit| !matches!(edit, Edit::Cut { .. } | Edit::Paste { .. }))
			.collect(),
	};
	if resolved.is_empty() {
		if parsed.file_op.is_some() {
			return Ok((String::new(), None));
		}
		return Err(format!("No changes would be made to {}.", section.path));
	}
	let mut rows = Vec::new();
	let mut first = None;
	let mut index = 0;
	while index < resolved.len() {
		let op_line = resolved[index].line_num();
		let mut deletes = Vec::new();
		let mut inserts = Vec::new();
		let mut insert_base = None;
		while index < resolved.len() && resolved[index].line_num() == op_line {
			match &resolved[index] {
				Edit::Delete { anchor, .. } => deletes.push(anchor.line),
				Edit::Insert { cursor, text, .. } => {
					insert_base.get_or_insert_with(|| cursor_line(*cursor, file_lines.len()));
					inserts.push(text.clone());
				},
				Edit::Cut { .. } | Edit::Paste { .. } | Edit::Block { .. } => {},
			}
			index += 1;
		}
		deletes.sort_unstable();
		for line in &deletes {
			first.get_or_insert(*line);
			let content = usize::try_from(*line)
				.ok()
				.and_then(|value| value.checked_sub(1))
				.and_then(|value| file_lines.get(value))
				.map_or("", String::as_str);
			rows.push(format!("-{line}|{content}"));
		}
		let mut line = insert_base
			.or_else(|| deletes.first().copied())
			.unwrap_or(1);
		for text in inserts {
			first.get_or_insert(line);
			rows.push(format!("+{line}|{text}"));
			line = line.saturating_add(1);
		}
	}
	if rows.is_empty() {
		Err(format!("No changes would be made to {}.", section.path))
	} else {
		Ok((rows.join("\n"), first))
	}
}

fn preview_section(
	section: &PatchSection,
	streaming: bool,
	files: &mut dyn FileSource,
	store: &EditStore,
	clipboard: &mut Clipboard,
) -> PreviewFile {
	let mut result = PreviewFile { display: section.path.clone(), ..PreviewFile::default() };
	let outcome = (|| {
		let initial = files.resolve(&section.path, false)?;
		let (target, resolved) = recover_target(section, &initial, files, store);
		result.display.clone_from(&target.path);
		let read = files.try_read(&resolved)?.ok_or_else(|| {
			crate::error::EditError::apply(format!("File not found: {}", target.path))
		})?;
		if streaming {
			let (diff, first) = streaming_diff(&target, &read.text, clipboard)
				.map_err(crate::error::EditError::apply)?;
			result.diff = Some(diff);
			result.first_changed_line = first;
			let parsed = parse_patch_streaming(&target.diff)
				.map_err(|error| crate::error::EditError::parse(error.to_string()))?;
			result.op = Some(if matches!(parsed.file_op, Some(FileOp::Rem)) {
				EngineFileOp::Delete
			} else {
				EngineFileOp::Update
			});
			return Ok(());
		}
		let parsed = target.parse()?;
		if target.file_hash.is_none() {
			return Err(crate::error::EditError::apply(
				super::messages::missing_snapshot_tag_message(&target.path),
			));
		}
		let edits = if matches!(parsed.file_op, Some(FileOp::Rem)) {
			&[][..]
		} else {
			parsed.edits.as_slice()
		};
		let applied =
			apply_with_recovery(&target, &read.canonical, &read.text, edits, clipboard, store, false)?;
		result.op = Some(if matches!(parsed.file_op, Some(FileOp::Rem)) {
			EngineFileOp::Delete
		} else {
			EngineFileOp::Update
		});
		result.rename = match &parsed.file_op {
			Some(FileOp::Move { dest }) => Some(dest.clone()),
			_ => None,
		};
		if applied.text == read.text {
			if parsed.file_op.is_some() {
				result.diff = Some(String::new());
				return Ok(());
			}
			return Err(crate::error::EditError::apply(format!(
				"No changes would be made to {}.",
				target.path
			)));
		}
		let diff = generate_diff_string(&read.text, &applied.text, None, &BlockContextSource {
			path: Some(&target.path),
			lang: None,
		});
		result.diff = Some(diff.diff);
		result.first_changed_line = applied.first_changed_line.or(diff.first_changed_line);
		Ok(())
	})();
	if let Err(error) = outcome {
		result.diff = None;
		result.error = Some(error.to_string());
	}
	result
}

/// Compute per-section previews, threading a transactional clipboard in patch
/// order.
pub fn preview_patch(
	patch: &Patch,
	streaming: bool,
	files: &mut dyn FileSource,
	store: &EditStore,
) -> Vec<PreviewFile> {
	let trailing_incomplete = streaming
		&& patch.sections.len() > 1
		&& patch
			.sections
			.last()
			.is_some_and(|section| !contains_recognizable_hashline_operations(&section.diff));
	let count = patch.sections.len() - usize::from(trailing_incomplete);
	let mut clipboard = store.start_clipboard_batch();
	let mut previews = Vec::new();
	for (index, section) in patch.sections.iter().take(count).enumerate() {
		let preview = preview_section(section, streaming, files, store, &mut clipboard);
		if preview.error.is_some() && (streaming || count > 1) && index + 1 == count {
			continue;
		}
		previews.push(preview);
	}
	previews
}

#[cfg(test)]
mod tests {
	use super::cursor_line;
	use crate::modes::hashline::types::{Anchor, Cursor};

	#[test]
	fn cursor_lines_are_one_indexed() {
		assert_eq!(cursor_line(Cursor::Bof, 3), 1);
		assert_eq!(cursor_line(Cursor::Eof, 3), 4);
		assert_eq!(cursor_line(Cursor::AfterAnchor(Anchor { line: 2 }), 3), 3);
	}
}
