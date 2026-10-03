//! Clipboard edit resolution (`packages/hashline/src/clipboard.ts`).

use super::{
	apply::EmptyPaste,
	messages::{
		EMPTY_PASTE, ambiguous_anonymous_paste_message, empty_register_paste_warning,
		empty_register_span_paste_message,
	},
	types::{Anchor, Cursor, Edit, PasteTarget},
};
use crate::{error::EditError, store::Clipboard};

fn describe_cut(edit: &Edit) -> String {
	let Edit::Cut { range, register, .. } = edit else {
		unreachable!("cut description requires a cut")
	};
	let span = if range.start.line == range.end.line {
		range.start.line.to_string()
	} else {
		format!("{}.={}", range.start.line, range.end.line)
	};
	register
		.as_ref()
		.map_or_else(|| format!("CUT {span}"), |register| format!("CUT {span} @{register}"))
}

/// Whether an edit stream contains an operation that reads or writes a
/// clipboard register.
pub fn has_clipboard_edit(edits: &[Edit]) -> bool {
	edits.iter().any(|edit| match edit {
		Edit::Cut { .. } | Edit::Paste { .. } => true,
		Edit::Block { mode, register, .. } => {
			matches!(mode, Some(super::types::BlockMode::Cut | super::types::BlockMode::PasteAfter))
				|| register.is_some()
		},
		_ => false,
	})
}

fn known_registers(clipboard: &Clipboard) -> Vec<&str> {
	let mut known: Vec<_> = clipboard
		.named
		.as_ref()
		.into_iter()
		.flat_map(|registers| registers.keys().map(String::as_str))
		.collect();
	known.sort_unstable();
	known
}

fn read_register(
	register: Option<&str>,
	span: bool,
	clipboard: &mut Clipboard,
	line_num: u32,
	on_empty_paste: EmptyPaste,
	on_warning: &mut dyn FnMut(String),
) -> Result<Option<Vec<String>>, EditError> {
	if let Some(register) = register {
		if let Some(lines) = clipboard
			.named
			.as_ref()
			.and_then(|named| named.get(register))
		{
			return Ok(Some(lines.clone()));
		}
		if on_empty_paste == EmptyPaste::Drop {
			return Ok(None);
		}
		let known = known_registers(clipboard);
		if span {
			return Err(EditError::apply(format!(
				"line {line_num}: {}",
				empty_register_span_paste_message(register, &known)
			)));
		}
		on_warning(format!("line {line_num}: {}", empty_register_paste_warning(register, &known)));
		return Ok(Some(Vec::new()));
	}

	let pending = clipboard.pending_anon_cuts.as_deref().unwrap_or_default();
	if pending.len() > 1 {
		if on_empty_paste == EmptyPaste::Drop {
			return Ok(None);
		}
		let pending: Vec<_> = pending.iter().map(String::as_str).collect();
		return Err(EditError::apply(format!(
			"line {line_num}: {}",
			ambiguous_anonymous_paste_message(&pending)
		)));
	}
	let Some(lines) = clipboard.lines.clone() else {
		if on_empty_paste == EmptyPaste::Drop {
			return Ok(None);
		}
		return Err(EditError::apply(format!("line {line_num}: {EMPTY_PASTE}")));
	};
	clipboard.pending_anon_cuts = Some(Vec::new());
	Ok(Some(lines))
}

fn write_register(
	edit: &Edit,
	file_lines: &[String],
	clipboard: &mut Clipboard,
) -> Result<(), EditError> {
	let Edit::Cut { range, register, line_num, .. } = edit else {
		unreachable!("register write requires a cut")
	};
	if range.start.line == 0 || range.end.line as usize > file_lines.len() {
		return Err(EditError::apply(format!(
			"line {line_num}: `{}` is out of range (file has {} lines).",
			describe_cut(edit),
			file_lines.len()
		)));
	}
	let captured = file_lines[(range.start.line - 1) as usize..range.end.line as usize].to_vec();
	if let Some(register) = register {
		clipboard
			.named
			.get_or_insert_with(Default::default)
			.insert(register.clone(), captured);
	} else {
		clipboard.lines = Some(captured);
		clipboard
			.pending_anon_cuts
			.get_or_insert_with(Vec::new)
			.push(describe_cut(edit));
	}
	Ok(())
}

/// Lower cut/paste operations into inserts and deletes against the original
/// file lines.
pub fn resolve_clipboard_edits(
	edits: &[Edit],
	file_lines: &[String],
	clipboard: &mut Clipboard,
	on_empty_paste: EmptyPaste,
	on_warning: &mut dyn FnMut(String),
) -> Result<Vec<Edit>, EditError> {
	if !has_clipboard_edit(edits) {
		return Ok(edits.to_vec());
	}
	let mut resolved = Vec::new();
	let mut synth_index = 0;
	for edit in edits {
		match edit {
			Edit::Cut { .. } => write_register(edit, file_lines, clipboard)?,
			Edit::Paste { at, register, line_num, block_start, .. } => {
				let Some(lines) = read_register(
					register.as_deref(),
					matches!(at, PasteTarget::Span { .. }),
					clipboard,
					*line_num,
					on_empty_paste,
					on_warning,
				)?
				else {
					continue;
				};
				match at {
					PasteTarget::Gap { cursor } => {
						for text in lines {
							resolved.push(Edit::Insert {
								cursor: *cursor,
								text,
								line_num: *line_num,
								index: synth_index,
								replacement: false,
								block_start: *block_start,
							});
							synth_index += 1;
						}
					},
					PasteTarget::Span { range } => {
						if range.start.line == 0 || range.end.line as usize > file_lines.len() {
							let register = register
								.as_ref()
								.map_or_else(String::new, |value| format!(" @{value}"));
							return Err(EditError::apply(format!(
								"line {line_num}: `PUT {}.={}{}` is out of range (file has {} lines).",
								range.start.line,
								range.end.line,
								register,
								file_lines.len()
							)));
						}
						let cursor = Cursor::BeforeAnchor(Anchor { line: range.start.line });
						for text in lines {
							resolved.push(Edit::Insert {
								cursor,
								text,
								line_num: *line_num,
								index: synth_index,
								replacement: true,
								block_start: None,
							});
							synth_index += 1;
						}
						for line in range.start.line..=range.end.line {
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
			},
			_ => resolved.push(edit.clone()),
		}
	}
	Ok(resolved)
}

/// Validate anonymous clipboard sequencing without mutating the supplied
/// clipboard.
pub fn validate_clipboard_sequence(edits: &[Edit], clipboard: &Clipboard) -> Result<(), EditError> {
	let mut fork = clipboard.fork();
	for edit in edits {
		match edit {
			Edit::Cut { register, .. } => {
				if let Some(register) = register {
					fork
						.named
						.get_or_insert_with(Default::default)
						.insert(register.clone(), Vec::new());
				} else {
					fork.lines = Some(Vec::new());
					fork
						.pending_anon_cuts
						.get_or_insert_with(Vec::new)
						.push(describe_cut(edit));
				}
			},
			Edit::Paste { at, register, line_num, .. } => {
				read_register(
					register.as_deref(),
					matches!(at, PasteTarget::Span { .. }),
					&mut fork,
					*line_num,
					EmptyPaste::Throw,
					&mut |_| {},
				)?;
			},
			_ => {},
		}
	}
	Ok(())
}
