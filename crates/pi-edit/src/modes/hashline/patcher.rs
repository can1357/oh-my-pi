//! Section staging: prepare/commit split (`packages/hashline/src/patcher.ts` +
//! `coding-agent/src/edit/hashline/execute.ts`).

use std::{collections::HashMap, path::Path};

use super::{
	apply::{ApplyOptions, EmptyPaste, apply_edits},
	block::{Unresolved, has_block_edit, resolve_block_edits},
	clipboard::validate_clipboard_sequence,
	input::{Parsed, Patch, PatchSection},
	messages::{
		HEADTAIL_DRIFT_WARNING, RevealedLine, UnseenLinesReveal, missing_snapshot_tag_message,
		path_recovered_from_tag_message, unseen_lines_message,
	},
	mismatch::{MismatchDetails, mismatch_error},
	parser::{ParseFailure, parse_patch},
	recovery::{RecoveryArgs, try_recover},
	types::{ApplyResult, BlockOpKind, BlockResolution, Edit, FileOp},
};
use crate::{
	diff_string::{BlockContextSource, generate_diff_string},
	engine::{FileOp as EngineFileOp, HeaderKind, Resolved, StagedFile},
	error::EditError,
	files::FileSource,
	store::{Clipboard, EditStore, file_hash, payload_hash},
};

const SEEN_LINE_REVEAL_CAP: usize = 40;
const SEEN_LINE_REVEAL_MAX_COLUMNS: usize = 512;

#[allow(
	clippy::suspicious_operation_groupings,
	reason = "span start is compared to the authored start line"
)]
fn parse_with_range_diagnostics(
	section: &PatchSection,
	files: &mut dyn FileSource,
) -> Result<Parsed, EditError> {
	match parse_patch(&section.diff) {
		Ok(parsed) => Ok(parsed),
		Err(ParseFailure::InvalidAbsoluteRange(error)) => {
			let enriched = files.read(&section.path).ok().and_then(|read| {
				super::block::native_block_resolver(&section.path, &read.text, error.start_line)
					.filter(|span| span.start == error.start_line && span.end > span.start)
					.map(|span| error.with_block(span))
			});
			Err(ParseFailure::InvalidAbsoluteRange(enriched.unwrap_or(error)).into())
		},
		Err(error) => Err(error.into()),
	}
}

/// Diagnostic for a clean, byte-identical hashline apply.
pub fn no_change_diagnostic(path: &str) -> String {
	format!(
		"Edits to {path} parsed and applied cleanly, but produced no change: your body row(s) are \
		 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the \
		 file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor \
		 first."
	)
}

/// Escalated diagnostic for a repeated identical no-op payload.
pub fn no_change_loop_diagnostic(path: &str, count: u32) -> String {
	format!(
		"STOP. Edits to {path} have been a byte-identical no-op {count} times in a row — the patch \
		 body matches the file at the targeted lines and the soft hint did not break the cycle. \
		 Cease re-issuing this payload. Either the intended change is already on disk (move on), or \
		 your anchor is wrong (re-read the file with `read` to observe the current line numbers and \
		 tag, then author a different edit). This exact payload will keep being rejected until it \
		 changes."
	)
}

fn has_anchor_scoped_edit(edits: &[Edit]) -> bool {
	edits.iter().any(|edit| match edit {
		Edit::Delete { .. } | Edit::Block { .. } | Edit::Cut { .. } => true,
		Edit::Paste { at, .. } => match at {
			super::types::PasteTarget::Span { .. } => true,
			super::types::PasteTarget::Gap { cursor } => matches!(
				cursor,
				super::types::Cursor::BeforeAnchor(_) | super::types::Cursor::AfterAnchor(_)
			),
		},
		Edit::Insert { cursor, .. } => matches!(
			cursor,
			super::types::Cursor::BeforeAnchor(_) | super::types::Cursor::AfterAnchor(_)
		),
	})
}

fn mismatch(
	section: &PatchSection,
	canonical: &Path,
	normalized: &str,
	expected: &str,
	store: &EditStore,
) -> EditError {
	let actual = file_hash(normalized);
	store.record(canonical, normalized, None);
	mismatch_error(&MismatchDetails {
		path:               Some(section.path.clone()),
		expected_file_hash: expected.to_owned(),
		actual_file_hash:   actual,
		file_lines:         normalized.split('\n').map(str::to_owned).collect(),
		anchor_lines:       section.collect_anchor_lines().unwrap_or_default(),
		hash_recognized:    store.by_hash(canonical, expected).is_some(),
	})
}

fn assert_seen_lines(
	section: &PatchSection,
	expected: &str,
	canonical: &Path,
	store: &EditStore,
	text: &str,
) -> Result<(), EditError> {
	let Some(snapshot) = store.by_content(canonical, text) else {
		return Ok(());
	};
	let Some(seen) = snapshot.seen_lines else {
		return Ok(());
	};
	if seen.is_empty() {
		return Ok(());
	}
	let unseen = section
		.collect_anchor_lines()?
		.into_iter()
		.filter(|line| !seen.contains(line))
		.collect::<Vec<_>>();
	if unseen.is_empty() {
		return Ok(());
	}
	let source = snapshot.text.split('\n').collect::<Vec<_>>();
	let mut revealed = Vec::new();
	let mut column_truncated = false;
	for &line in unseen.iter().take(SEEN_LINE_REVEAL_CAP) {
		let Some(value) = usize::try_from(line)
			.ok()
			.and_then(|n| n.checked_sub(1))
			.and_then(|n| source.get(n))
		else {
			continue;
		};
		let chars = value.chars().collect::<Vec<_>>();
		if chars.len() > SEEN_LINE_REVEAL_MAX_COLUMNS {
			revealed.push(RevealedLine {
				line,
				text: chars[..SEEN_LINE_REVEAL_MAX_COLUMNS]
					.iter()
					.collect::<String>()
					+ "…",
			});
			column_truncated = true;
		} else {
			revealed.push(RevealedLine { line, text: (*value).to_owned() });
		}
	}
	let truncated = unseen.len() > revealed.len() || column_truncated;
	if !truncated {
		store.record_seen_lines(
			canonical,
			expected,
			&revealed.iter().map(|item| item.line).collect::<Vec<_>>(),
		);
	}
	Err(EditError::matched(unseen_lines_message(
		section.path.as_str(),
		&unseen,
		expected,
		&UnseenLinesReveal { lines: revealed, truncated },
	)))
}

pub(crate) fn apply_with_recovery(
	section: &PatchSection,
	canonical: &Path,
	normalized: &str,
	edits: &[Edit],
	clipboard: &mut Clipboard,
	store: &EditStore,
	enforce_seen_lines: bool,
) -> Result<ApplyResult, EditError> {
	let expected = section.file_hash.as_deref().unwrap_or_default();
	let live_matches = file_hash(normalized).eq_ignore_ascii_case(expected);
	let stored = store.by_hash(canonical, expected);
	let mut block_resolutions = Vec::new();
	let mut resolve_warnings = Vec::new();
	let resolved = if has_block_edit(edits) {
		let base = if live_matches {
			normalized
		} else if let Some(snapshot) = &stored {
			&snapshot.text
		} else {
			return Err(mismatch(section, canonical, normalized, expected, store));
		};
		resolve_block_edits(
			edits,
			base,
			&section.path,
			Unresolved::Throw,
			&mut |item| block_resolutions.push(item),
			&mut |warning| resolve_warnings.push(warning),
		)?
	} else {
		edits.to_vec()
	};
	validate_clipboard_sequence(&resolved, clipboard)?;
	if live_matches {
		if enforce_seen_lines {
			assert_seen_lines(section, expected, canonical, store, normalized)?;
		}
		let mut result = apply_edits(normalized, &resolved, ApplyOptions {
			clipboard:      Some(clipboard),
			path:           Some(canonical.to_string_lossy().as_ref()),
			on_empty_paste: EmptyPaste::Throw,
		})?;
		result.block_resolutions = block_resolutions;
		resolve_warnings.extend(result.warnings);
		result.warnings = resolve_warnings;
		return Ok(result);
	}
	if !has_anchor_scoped_edit(&resolved) {
		let mut result = apply_edits(normalized, &resolved, ApplyOptions {
			clipboard:      Some(clipboard),
			path:           Some(canonical.to_string_lossy().as_ref()),
			on_empty_paste: EmptyPaste::Throw,
		})?;
		resolve_warnings.push(HEADTAIL_DRIFT_WARNING.to_owned());
		resolve_warnings.extend(result.warnings);
		result.warnings = resolve_warnings;
		return Ok(result);
	}
	if let Some(recovered) = try_recover(store, RecoveryArgs {
		path:         canonical,
		current_text: normalized,
		file_hash:    expected,
		edits:        &resolved,
		clipboard:    Some(clipboard),
	})? {
		resolve_warnings.extend(recovered.warnings);
		return Ok(ApplyResult {
			text:               recovered.text,
			first_changed_line: recovered.first_changed_line,
			warnings:           resolve_warnings,
			block_resolutions:  Vec::new(),
		});
	}
	Err(mismatch(section, canonical, normalized, expected, store))
}

fn format_block_resolution(resolution: &BlockResolution) -> String {
	let (template, suffix) = match resolution.op {
		BlockOpKind::Replace => ("PUT N*:", ""),
		BlockOpKind::InsertAfter => ("PUT >N*:", "; body lands after line "),
		BlockOpKind::Cut => ("CUT N*", ""),
		BlockOpKind::PasteAfter => ("PUT >N*", "; clipboard lands after line "),
	};
	let op = template.replace('N', &resolution.anchor_line.to_string());
	let lines = resolution.end - resolution.start + 1;
	let span = if resolution.start == resolution.end {
		format!("line {}", resolution.start)
	} else {
		format!("lines {}-{}", resolution.start, resolution.end)
	};
	let suffix = if suffix.is_empty() {
		String::new()
	} else {
		format!("{suffix}{}", resolution.end)
	};
	format!("{op} → resolved {span} ({lines} line{}){suffix}", if lines == 1 { "" } else { "s" })
}

pub(crate) fn recover_target(
	section: &PatchSection,
	initial: &Resolved,
	files: &mut dyn FileSource,
	store: &EditStore,
) -> (PatchSection, Resolved) {
	if files.exists(&initial.absolute) {
		return (section.with_path(&section.path), initial.clone());
	}
	let Some(tag) = section.file_hash.as_deref() else {
		return (section.with_path(&section.path), initial.clone());
	};
	let authored_name = initial.absolute.file_name();
	let mut candidates = store
		.find_by_hash(tag)
		.into_iter()
		.filter(|snapshot| {
			snapshot.path.file_name() == authored_name && snapshot.path != initial.absolute
		})
		.map(|snapshot| snapshot.path)
		.collect::<Vec<_>>();
	candidates.sort();
	candidates.dedup();
	if candidates.len() != 1
		|| !files
			.policy()
			.allow_tag_path_recovery(&section.path, &candidates[0])
	{
		return (section.with_path(&section.path), initial.clone());
	}
	let path = candidates.remove(0);
	let display = path.to_string_lossy().into_owned();
	(section.with_path(&display), Resolved { absolute: path, display })
}

/// Stage every parsed hashline section atomically.
pub fn stage_patch(
	patch: &Patch,
	raw_input: &str,
	enforce_seen_lines: bool,
	files: &mut dyn FileSource,
	store: &EditStore,
) -> Result<Vec<StagedFile>, EditError> {
	let mut clipboard = store.start_clipboard_batch();
	let mut staged = Vec::with_capacity(patch.sections.len());
	let mut canonical_paths = HashMap::<std::path::PathBuf, String>::new();
	for original in &patch.sections {
		let parsed = parse_with_range_diagnostics(original, files)?;
		let Some(tag) = original.file_hash.as_deref() else {
			return Err(EditError::apply(missing_snapshot_tag_message(&original.path)));
		};
		let initial = files.resolve(&original.path, false)?;
		let (section, resolved) = recover_target(original, &initial, files, store);
		let read = files.try_read(&resolved)?.ok_or_else(|| {
			EditError::apply(format!(
				"File not found: {}. Use the write tool to create new files.",
				section.path
			))
		})?;
		if section.path != original.path {
			// Warning is attached below once parser/apply warnings are collected.
		}
		if let Some(previous) = canonical_paths.insert(read.canonical.clone(), original.path.clone())
		{
			return Err(EditError::apply(format!(
				"Multiple hashline sections resolve to the same file ({previous} and {}). Merge their \
				 ops under one header before applying.",
				original.path
			)));
		}
		if let Some(FileOp::Move { dest }) = &parsed.file_op {
			let destination = files.resolve(dest, false)?;
			if crate::path_policy::canonical_key(&destination.absolute) == read.canonical {
				return Err(EditError::apply(format!(
					"MV destination is the same as {}.",
					section.path
				)));
			}
		}
		let edits = if matches!(parsed.file_op, Some(FileOp::Rem)) {
			&[][..]
		} else {
			parsed.edits.as_slice()
		};
		let apply = apply_with_recovery(
			&section,
			&read.canonical,
			&read.text,
			edits,
			&mut clipboard,
			store,
			enforce_seen_lines,
		)?;
		let mut warnings = parsed.warnings.clone();
		if section.path != original.path {
			warnings.push(path_recovered_from_tag_message(&original.path, &section.path, tag));
		}
		warnings.extend(apply.warnings.clone());
		let engine_op = match parsed.file_op {
			Some(FileOp::Rem) => EngineFileOp::Delete,
			_ if apply.text == read.text && parsed.file_op.is_none() => EngineFileOp::Noop,
			_ => EngineFileOp::Update,
		};
		let diff = generate_diff_string(&read.text, &apply.text, None, &BlockContextSource {
			path: Some(&section.path),
			lang: None,
		});
		let move_to = if let Some(FileOp::Move { dest }) = &parsed.file_op {
			Some(files.resolve(dest, false)?)
		} else {
			None
		};
		let persisted = if matches!(engine_op, EngineFileOp::Delete | EngineFileOp::Noop) {
			None
		} else {
			Some(read.persist(&apply.text)?)
		};
		let mut item =
			StagedFile::new(section.path.clone(), read.resolved.absolute.clone(), engine_op);
		item.move_to = move_to;
		item.before_raw = Some(read.raw.clone());
		item.before.clone_from(&read.text);
		item.after = apply.text;
		item.persisted = persisted;
		item.diff = diff.diff;
		item.first_changed_line = apply.first_changed_line.or(diff.first_changed_line);
		item.header = HeaderKind::HashlineTag;
		item.before_preview = apply
			.block_resolutions
			.iter()
			.map(format_block_resolution)
			.collect();
		item.warnings = warnings;
		item.record_snapshot = true;
		item.clipboard_after = Some(clipboard.fork());
		if engine_op == EngineFileOp::Noop && patch.sections.len() == 1 {
			let (count, escalate) = store.record_noop(&read.canonical, payload_hash(raw_input));
			if escalate {
				return Err(EditError::apply(no_change_loop_diagnostic(&original.path, count)));
			}
			item.text_override = Some(no_change_diagnostic(&original.path));
		}
		staged.push(item);
	}
	if staged.len() > 1
		&& let Some(item) = staged.iter().find(|item| item.op == EngineFileOp::Noop)
	{
		let canonical = crate::path_policy::canonical_key(&item.absolute);
		let (count, escalate) = store.record_noop(&canonical, payload_hash(raw_input));
		return Err(EditError::apply(if escalate {
			no_change_loop_diagnostic(&item.display, count)
		} else {
			no_change_diagnostic(&item.display)
		}));
	}
	Ok(staged)
}
