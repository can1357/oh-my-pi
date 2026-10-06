//! Section staging: prepare/commit split (`packages/hashline/src/patcher.ts` +
//! `coding-agent/src/edit/hashline/execute.ts`).

use std::{
	borrow::Cow,
	collections::{BTreeSet, HashMap},
	path::Path,
	sync::Arc,
};

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
	store::{Clipboard, EditStore, Snapshot, file_hash, payload_hash},
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
	// When the tag isn't from this exact path, list the other paths in this
	// session that *did* issue the same tag — so the rejection can name the
	// file the tag was actually for and the model doesn't follow a wrong-tree
	// suggestion.
	let tag_origin_paths: Vec<String> = store
		.paths_with_hash(expected)
		.into_iter()
		.filter(|path| path != canonical)
		.map(|path| path.to_string_lossy().into_owned())
		.collect();
	mismatch_error(&MismatchDetails {
		path: Some(section.path.clone()),
		expected_file_hash: expected.to_owned(),
		actual_file_hash: actual,
		file_lines: normalized.split('\n').map(str::to_owned).collect(),
		anchor_lines: section.collect_anchor_lines().unwrap_or_default(),
		hash_recognized: store.has_hash(canonical, expected),
		tag_origin_paths,
	})
}

/// Minimum trimmed length, in chars, for a current-content line to count as
/// targeting evidence. Short closers (`}`, `});`) repeat everywhere; accepting
/// on those would let stale anchors through.
const SHIFT_RESCUE_EVIDENCE_MIN_CHARS: usize = 8;

/// One replacement op's anchors plus its payload body lines.
struct ReplaceGroup {
	anchors: Vec<u32>,
	body:    Vec<String>,
}

/// Group a section's replacement ops. The parser lowers `PUT a.=b:` to a run
/// of replacement inserts immediately followed by the consumed lines' deletes,
/// so each insert-run/delete-run pair is one op. Pure insertions and cuts
/// carry no replaced content to evidence against, so they form no group.
fn replace_groups(section: &PatchSection) -> Result<Vec<ReplaceGroup>, EditError> {
	let edits = section.edits()?;
	let mut groups = Vec::new();
	let mut cursor = 0;
	while cursor < edits.len() {
		let mut body = Vec::new();
		while let Some(Edit::Insert { text, replacement: true, .. }) = edits.get(cursor) {
			body.push(text.clone());
			cursor += 1;
		}
		let mut anchors = Vec::new();
		while let Some(Edit::Delete { anchor, .. }) = edits.get(cursor) {
			anchors.push(anchor.line);
			cursor += 1;
		}
		if !body.is_empty() && !anchors.is_empty() {
			anchors.sort_unstable();
			groups.push(ReplaceGroup { anchors, body });
		} else if body.is_empty() && anchors.is_empty() {
			cursor += 1;
		}
	}
	Ok(groups)
}

/// Map every current-numbered line back through `old_text → new_text`: the
/// old line it images when it lands inside an unchanged run (`None` for added
/// lines and lines inside rewritten spans). One Myers walk serves every
/// anchor, instead of one full-file diff per line.
fn shifted_images(old_text: &str, new_text: &str) -> Vec<Option<u32>> {
	let old_lines: Vec<&str> = old_text.split('\n').collect();
	let new_lines: Vec<&str> = new_text.split('\n').collect();
	let (old_ids, new_ids) = pi_diff::intern(&old_lines, &new_lines);
	let mut image = vec![None; new_lines.len()];
	let (mut old_line, mut current) = (1_u32, 1_u32);
	for run in pi_diff::myers_diff(&old_ids, &new_ids) {
		if run.added {
			current += run.count;
			continue;
		}
		if run.removed {
			old_line += run.count;
			continue;
		}
		let (mut new_line, mut old) = (current, old_line);
		for _ in 0..run.count {
			if let Some(slot) = image.get_mut(new_line as usize - 1) {
				*slot = Some(old);
			}
			new_line += 1;
			old += 1;
		}
		old_line = old;
		current = new_line;
	}
	image
}

/// One retained version's seen set plus its lines' images in the current
/// text, computed once per rescue instead of once per anchor.
struct VersionMap {
	seen:      Arc<BTreeSet<u32>>,
	same_text: bool,
	image:     Vec<Option<u32>>,
}

/// Snapshot histories newest-first into reusable shift mappings, skipping
/// versions that displayed nothing.
fn version_maps(versions: &[Snapshot], current_text: &str) -> Vec<VersionMap> {
	versions
		.iter()
		.filter_map(|version| {
			let seen = version.seen_lines.clone()?;
			if seen.is_empty() {
				return None;
			}
			if &*version.text == current_text {
				Some(VersionMap { seen, same_text: true, image: Vec::new() })
			} else {
				Some(VersionMap {
					seen,
					same_text: false,
					image: shifted_images(&version.text, current_text),
				})
			}
		})
		.collect()
}

/// True when `line` (current numbering) images a line some retained version
/// displayed: the model saw exactly this content, only at another number.
fn images_seen(maps: &[VersionMap], line: u32) -> bool {
	maps.iter().any(|map| {
		if map.same_text {
			map.seen.contains(&line)
		} else {
			usize::try_from(line)
				.ok()
				.and_then(|n| n.checked_sub(1))
				.and_then(|n| map.image.get(n).copied().flatten())
				.is_some_and(|source| map.seen.contains(&source))
		}
	})
}

/// Trimmed content of current line `line` when it is long enough to serve as
/// evidence and occurs exactly once in the file. Repeated content cannot name
/// which copy an anchor meant: a stale number could image a twin line.
fn unique_evidence<'a>(current_lines: &[&'a str], line: u32) -> Option<&'a str> {
	let content = usize::try_from(line)
		.ok()
		.and_then(|n| n.checked_sub(1))
		.and_then(|n| current_lines.get(n))?
		.trim();
	if content.chars().count() < SHIFT_RESCUE_EVIDENCE_MIN_CHARS {
		return None;
	}
	let occurrences = current_lines
		.iter()
		.filter(|other| other.trim() == content)
		.count();
	(occurrences == 1).then_some(content)
}

fn is_ident_char(c: char) -> bool {
	c.is_alphanumeric() || c == '_'
}

/// True when `body_line` carries `evidence` as a token-bounded span: the line
/// verbatim, or with edits around it (an appended comment, a wrapping call),
/// but never as the prefix of a longer identifier or number (`foo(bar)` is
/// not carried by `foo(bar_baz)`, `= 18` not by `= 180`).
fn line_carries(body_line: &str, evidence: &str) -> bool {
	let starts_ident = evidence.starts_with(is_ident_char);
	let ends_ident = evidence.ends_with(is_ident_char);
	let glued =
		|edge_ident: bool, neighbor: Option<char>| edge_ident && neighbor.is_some_and(is_ident_char);
	body_line.match_indices(evidence).any(|(at, _)| {
		let before = body_line[..at].chars().next_back();
		let after = body_line[at + evidence.len()..].chars().next();
		!glued(starts_ident, before) && !glued(ends_ident, after)
	})
}

/// Body evidence that an op targets `first..=last` as currently numbered: the
/// payload carries the first anchor's current content and, for ranges, the
/// last anchor's current content at or after it. Checking both ends is what
/// rejects stale numbers whichever way lines moved: after lines shift down,
/// a stale range's first line holds content from above the intended range;
/// after lines shift up, its last line holds content from below it. Either
/// way that end's content is absent from the payload.
fn body_targets(body: &[String], current_lines: &[&str], first: u32, last: u32) -> bool {
	let Some(head) = unique_evidence(current_lines, first) else {
		return false;
	};
	let Some(head_at) = body.iter().position(|line| line_carries(line, head)) else {
		return false;
	};
	if first == last {
		return true;
	}
	let Some(tail) = unique_evidence(current_lines, last) else {
		return false;
	};
	body
		.iter()
		.rposition(|line| line_carries(line, tail))
		.is_some_and(|tail_at| tail_at >= head_at)
}

/// Anchors the guard would reject that a shift-aware reading accepts: every
/// unseen anchor of a replacement op images a displayed line of a retained
/// version (same content, older number), and the payload carries the current
/// content of both ends of the unseen span ([`body_targets`]). Stale-numbered
/// anchors fail the payload check and stay rejected, as do anchors no retained
/// version displayed, ends too short or repeated to identify a line, and pure
/// inserts/cuts (no payload to evidence against).
fn rescue_shifted_anchors(
	section: &PatchSection,
	store: &EditStore,
	canonical: &Path,
	current_text: &str,
	unseen: &[u32],
) -> Result<Vec<u32>, EditError> {
	let pending: BTreeSet<u32> = unseen.iter().copied().collect();
	let current_lines: Vec<&str> = current_text.split('\n').collect();
	let maps = version_maps(&store.versions(canonical), current_text);
	let mut rescued = Vec::new();
	for group in replace_groups(section)? {
		let group_unseen: Vec<u32> = group
			.anchors
			.iter()
			.copied()
			.filter(|line| pending.contains(line))
			.collect();
		let (Some(&first), Some(&last)) = (group_unseen.first(), group_unseen.last()) else {
			continue;
		};
		if body_targets(&group.body, &current_lines, first, last)
			&& group_unseen.iter().all(|line| images_seen(&maps, *line))
		{
			rescued.extend(group_unseen);
		}
	}
	Ok(rescued)
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
	let mut unseen = section
		.collect_anchor_lines()?
		.into_iter()
		.filter(|line| !seen.contains(line))
		.collect::<Vec<_>>();
	if unseen.is_empty() {
		return Ok(());
	}
	// A follow-up edit below an earlier shifting edit anchors moved lines at
	// their new numbers. When the payload carries the anchored content, the
	// model targeted the lines as numbered — accept them instead of forcing a
	// wasted reveal round-trip.
	let rescued = rescue_shifted_anchors(section, store, canonical, text, &unseen)?;
	if !rescued.is_empty() {
		let rescued: BTreeSet<u32> = rescued.into_iter().collect();
		unseen.retain(|line| !rescued.contains(line));
		if unseen.is_empty() {
			return Ok(());
		}
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
		Cow::Borrowed(edits)
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

/// When the authored path does not exist, rebind the section to the one
/// stored snapshot with the same content tag and file name. `None` keeps
/// the authored section and target, which callers use by reference.
pub(crate) fn recover_target(
	section: &PatchSection,
	initial: &Resolved,
	files: &mut dyn FileSource,
	store: &EditStore,
) -> Option<(PatchSection, Resolved)> {
	if files.exists(&initial.absolute) {
		return None;
	}
	let tag = section.file_hash.as_deref()?;
	let authored_name = initial.absolute.file_name();
	let mut candidates = store
		.paths_with_hash(tag)
		.into_iter()
		.filter(|path| path.file_name() == authored_name && *path != initial.absolute)
		.collect::<Vec<_>>();
	candidates.sort();
	candidates.dedup();
	if candidates.len() != 1
		|| !files
			.policy()
			.allow_tag_path_recovery(&section.path, &candidates[0])
	{
		return None;
	}
	let path = candidates.remove(0);
	let display = path.to_string_lossy().into_owned();
	Some((section.with_path(&display), Resolved { absolute: path, display }))
}
/// Stage a whole-file delete for a target whose bytes cannot be decoded:
/// existence is proven, but there is no content to diff or snapshot.
#[allow(
	clippy::too_many_arguments,
	reason = "delete staging threads section, resolution, dedup, and clipboard state"
)]
fn undecodable_delete_staged(
	section: &PatchSection,
	resolved: &Resolved,
	original_path: &str,
	tag: &str,
	mut warnings: Vec<String>,
	canonical_paths: &mut HashMap<std::path::PathBuf, String>,
	clipboard: &Clipboard,
) -> Result<StagedFile, EditError> {
	if section.path != original_path {
		warnings.push(path_recovered_from_tag_message(original_path, &section.path, tag));
	}
	if let Some(previous) = canonical_paths
		.insert(crate::path_policy::canonical_key(&resolved.absolute), original_path.to_owned())
	{
		return Err(EditError::apply(format!(
			"Multiple hashline sections resolve to the same file ({previous} and {original_path}). \
			 Merge their ops under one header before applying."
		)));
	}
	let mut item =
		StagedFile::new(section.path.clone(), resolved.absolute.clone(), EngineFileOp::Delete);
	item.header = HeaderKind::HashlineTag;
	item.warnings = warnings;
	item.record_snapshot = true;
	item.clipboard_after = Some(clipboard.fork());
	Ok(item)
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
		let recovered = recover_target(original, &initial, files, store);
		let (section, resolved) = recovered
			.as_ref()
			.map_or((original, &initial), |(section, resolved)| (section, resolved));
		// Whole-file delete needs existence, not text, so an undecodable file
		// stages without its content; anything else still rejects.
		let undecodable_delete = matches!(parsed.file_op, Some(FileOp::Rem));
		let read = match files.try_read(resolved) {
			Ok(read) => read,
			Err(err) if err.is_invalid_utf8() && undecodable_delete => None,
			Err(err) => return Err(err),
		};
		let Some(read) = read else {
			if undecodable_delete && files.exists(&resolved.absolute) {
				staged.push(undecodable_delete_staged(
					section,
					resolved,
					&original.path,
					tag,
					parsed.warnings.clone(),
					&mut canonical_paths,
					&clipboard.fork(),
				)?);
				continue;
			}
			return Err(EditError::apply(format!(
				"File not found: {}. Use the write tool to create new files.",
				section.path
			)));
		};
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
			section,
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
			path:      Some(&section.path),
			lang:      None,
			streaming: false,
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn shifted_images_maps_through_insertions() {
		let image = shifted_images("a\nb\nc\nd", "a\nX\nY\nb\nc\nd");
		assert_eq!(image.as_slice(), &[Some(1), None, None, Some(2), Some(3), Some(4)]);
	}

	#[test]
	fn shifted_images_maps_through_replacements() {
		let image = shifted_images("a\nb\nc", "a\nB1\nB2\nc");
		assert_eq!(image.as_slice(), &[Some(1), None, None, Some(3)]);
	}

	fn body(lines: &[&str]) -> Vec<String> {
		lines.iter().map(|line| (*line).to_owned()).collect()
	}

	#[test]
	fn body_targets_single_anchor_needs_substantial_unique_token_bounded_content() {
		let file = ["let v0060 = 60;", "}", "foo(bar);", "dup_line();", "dup_line();"];
		// Edited line carrying the current content plus an appended comment.
		assert!(body_targets(&body(&["let v0060 = 60; // replay edit"]), &file, 1, 1));
		// Stale anchor: the body carries another line's content.
		assert!(!body_targets(&body(&["let v0058 = 58; // edit"]), &file, 1, 1));
		// Prefix of a longer number / identifier is not the same line.
		assert!(!body_targets(&body(&["let v0060 = 600;"]), &["let v0060 = 60"], 1, 1));
		assert!(!body_targets(&body(&["process(items);"]), &["process(item"], 1, 1));
		assert!(body_targets(&body(&["process(item); // edit"]), &["process(item"], 1, 1));
		// Short closers repeat everywhere and prove nothing.
		assert!(!body_targets(&body(&["}", "x();"]), &file, 2, 2));
		// Repeated content cannot name which copy is meant.
		assert!(!body_targets(&body(&["dup_line(); // edit"]), &file, 4, 4));
	}

	#[test]
	fn body_targets_range_needs_both_ends_in_order() {
		let file = ["let v0001 = 1;", "let v0002 = 2;", "let v0003 = 3;", "let v0004 = 4;"];
		let faithful = body(&["let v0001 = 1;", "let v0002 = 20;", "let v0004 = 4; // edit"]);
		assert!(body_targets(&faithful, &file, 1, 4));
		// Lines shifted up: a stale range ends one line past what the body
		// carries.
		let stale = body(&["let v0001 = 1;", "let v0002 = 2;", "let v0003 = 30;"]);
		assert!(!body_targets(&stale, &file, 1, 4));
		// Tail carried only before the head is not this range.
		let reversed = body(&["let v0004 = 4;", "let v0001 = 1;"]);
		assert!(!body_targets(&reversed, &file, 1, 4));
	}
}

#[cfg(test)]
mod lifecycle {
	use std::path::PathBuf;

	use async_trait::async_trait;
	use tempfile::TempDir;

	use crate::{
		EditMode, EditResult, EditWriter, WriteRequest, WriteResponse,
		path_policy::{PathPolicy, canonical_key},
		session::{ApplyRequest, Session, SessionConfig},
		store::EditStore,
	};

	struct DiskWriter;

	#[async_trait]
	impl EditWriter for DiskWriter {
		async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
			match request.content {
				Some(content) => {
					if let Some(parent) = request.absolute.parent() {
						std::fs::create_dir_all(parent).unwrap();
					}
					std::fs::write(&request.absolute, &content).unwrap();
					Ok(WriteResponse { written: content, diagnostics_json: None })
				},
				None => Ok(WriteResponse::default()),
			}
		}
	}

	struct Lifecycle {
		dir:    TempDir,
		policy: PathPolicy,
		store:  EditStore,
	}

	impl Lifecycle {
		fn new(file: &str, lines: usize) -> Self {
			let dir = TempDir::new().unwrap();
			let mut text = String::new();
			for i in 1..=lines {
				use std::fmt::Write as _;
				writeln!(text, "let v{i:04} = {i};").unwrap();
			}
			std::fs::write(dir.path().join(file), &text).unwrap();
			let policy = PathPolicy {
				cwd:                  dir.path().to_owned(),
				home_dir:             dir.path().to_owned(),
				url_schemes:          Vec::new(),
				url_alias_schemes:    Vec::new(),
				plan_writable_roots:  Vec::new(),
				plan_active:          false,
				block_auto_generated: false,
			};
			Self { dir, policy, store: EditStore::new() }
		}

		fn canonical(&self, file: &str) -> PathBuf {
			canonical_key(&self.dir.path().join(file))
		}

		fn text(&self, file: &str) -> String {
			std::fs::read_to_string(self.dir.path().join(file)).unwrap()
		}

		fn write_text(&self, file: &str, text: &str) {
			std::fs::write(self.dir.path().join(file), text).unwrap();
		}

		fn read(&self, file: &str, seen: &[u32]) -> String {
			self
				.store
				.record(&self.canonical(file), &self.text(file), Some(seen))
		}

		fn head_tag(&self, file: &str) -> String {
			self.store.head(&self.canonical(file)).unwrap().hash
		}

		async fn edit(&self, patch: &str) -> Result<(), String> {
			let mut session = Session::new(
				SessionConfig {
					mode:               EditMode::Hashline,
					policy:             self.policy.clone(),
					allow_fuzzy:        false,
					fuzzy_threshold:    0.0,
					enforce_seen_lines: true,
					raw_input:          true,
				},
				self.store.clone(),
			);
			session.push(patch);
			session.finish();
			session
				.apply(ApplyRequest::default(), &DiskWriter)
				.await
				.map(|_| ())
				.map_err(|err| err.to_string())
		}
	}

	fn all_seen(lines: usize) -> Vec<u32> {
		(1..=lines as u32).collect()
	}

	/// Full read, two inserted lines above, then a replace at the shifted
	/// number carrying the line's content: the vardorvis shape. Applies.
	#[tokio::test]
	async fn faithful_shifted_replace_applies() {
		let ctx = Lifecycle::new("case-a.ts", 30);
		let tag0 = ctx.read("case-a.ts", &all_seen(30));
		ctx.edit(&format!("[case-a.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-a.ts");
		ctx.edit(&format!("[case-a.ts#{tag1}]\nPUT 20.=20:\n+let v0018 = 18; // edited\n"))
			.await
			.unwrap();
		let text = ctx.text("case-a.ts");
		assert_eq!(text.lines().count(), 32);
		assert!(text.lines().nth(19).unwrap().contains("// edited"));
	}

	/// Same setup, but the follow-up reuses the stale pre-shift number.
	/// The body belongs to another line, so the guard still rejects and
	/// the file is untouched.
	#[tokio::test]
	async fn stale_shifted_replace_stays_rejected() {
		let ctx = Lifecycle::new("case-b.ts", 30);
		let tag0 = ctx.read("case-b.ts", &all_seen(30));
		ctx.edit(&format!("[case-b.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let before = ctx.text("case-b.ts");
		let tag1 = ctx.head_tag("case-b.ts");
		let err = ctx
			.edit(&format!("[case-b.ts#{tag1}]\nPUT 18.=18:\n+let v0018 = 18; // edited\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
		assert_eq!(ctx.text("case-b.ts"), before);
	}

	/// Pure insertions carry no replaced content to evidence the boundary
	/// against, so an insert after a shifted line stays rejected.
	#[tokio::test]
	async fn insert_after_shifted_line_stays_rejected() {
		let ctx = Lifecycle::new("case-c.ts", 30);
		let tag0 = ctx.read("case-c.ts", &all_seen(30));
		ctx.edit(&format!("[case-c.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-c.ts");
		let err = ctx
			.edit(&format!("[case-c.ts#{tag1}]\nPUT >18:\n+// later insert\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
	}

	/// Cuts capture no payload body, so a cut on a shifted line stays
	/// rejected.
	#[tokio::test]
	async fn cut_on_shifted_line_stays_rejected() {
		let ctx = Lifecycle::new("case-d.ts", 30);
		let tag0 = ctx.read("case-d.ts", &all_seen(30));
		ctx.edit(&format!("[case-d.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-d.ts");
		let err = ctx
			.edit(&format!("[case-d.ts#{tag1}]\nCUT 20.=20\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
	}

	/// Body evidence alone is not enough: with no shifting edit in the
	/// file's history, an unseen anchor stays rejected even when the
	/// payload guesses its content exactly.
	#[tokio::test]
	async fn unseen_anchor_without_shift_history_stays_rejected() {
		let ctx = Lifecycle::new("case-e.ts", 30);
		let seen: Vec<u32> = (1..=10).collect();
		let tag0 = ctx.read("case-e.ts", &seen);
		let err = ctx
			.edit(&format!("[case-e.ts#{tag0}]\nPUT 25.=25:\n+let v0025 = 25; // edited\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
	}

	/// One section, two ops: the faithful op is rescued while the stale
	/// op is still rejected — and the rejection names only the stale
	/// lines.
	#[tokio::test]
	async fn mixed_section_rejects_only_the_stale_op() {
		let ctx = Lifecycle::new("case-f.ts", 30);
		let tag0 = ctx.read("case-f.ts", &all_seen(30));
		ctx.edit(&format!("[case-f.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-f.ts");
		let err = ctx
			.edit(&format!(
				"[case-f.ts#{tag1}]\nPUT 20.=20:\n+let v0018 = 18; // edited\nPUT 18.=18:\n+let v0018 \
				 = 18; // edited\n"
			))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
		assert!(
			!err.lines().any(|line| line.starts_with("  20:")),
			"faithful line leaked into reveal: {err}"
		);
		assert!(err.contains("  18:let v0016 = 16;"), "stale line missing from reveal: {err}");
	}
	/// A file whose old lines 16 and 18 carry identical content, for the
	/// repeated-content ambiguity probes below.
	fn duplicate_fixture(ctx: &Lifecycle, file: &str) {
		use std::fmt::Write as _;
		let mut text = String::new();
		for i in 1..=30 {
			if i == 16 || i == 18 {
				text.push_str("    return unchanged;\n");
			} else {
				writeln!(text, "let v{i:04} = {i};").unwrap();
			}
		}
		ctx.write_text(file, &text);
	}

	/// Blocking review thread: with duplicated content, a stale anchor images
	/// a *different* line whose identical text also occurs in the payload.
	/// Accepting would silently edit the wrong line, so ambiguity rejects.
	#[tokio::test]
	async fn stale_duplicate_content_stays_rejected() {
		let ctx = Lifecycle::new("case-g.ts", 30);
		duplicate_fixture(&ctx, "case-g.ts");
		let tag0 = ctx.read("case-g.ts", &all_seen(30));
		ctx.edit(&format!("[case-g.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let before = ctx.text("case-g.ts");
		let tag1 = ctx.head_tag("case-g.ts");
		// Stale number for old line 18 (now line 20): line 18 now holds old
		// line 16's identical text, which the payload also carries.
		let err = ctx
			.edit(&format!("[case-g.ts#{tag1}]\nPUT 18.=18:\n+    return unchanged; // edited\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
		assert_eq!(ctx.text("case-g.ts"), before);
	}

	/// Conservative companion: even the correctly shifted anchor on repeated
	/// content rejects, because the evidence cannot name which copy is meant.
	#[tokio::test]
	async fn faithful_duplicate_content_stays_rejected() {
		let ctx = Lifecycle::new("case-h.ts", 30);
		duplicate_fixture(&ctx, "case-h.ts");
		let tag0 = ctx.read("case-h.ts", &all_seen(30));
		ctx.edit(&format!("[case-h.ts#{tag0}]\nPUT >5:\n+// ins a\n+// ins b\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-h.ts");
		let err = ctx
			.edit(&format!("[case-h.ts#{tag1}]\nPUT 20.=20:\n+    return unchanged; // edited\n"))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
	}

	/// Lines shift *up* (a cut above), then a range reuses the stale
	/// pre-shift numbers while restating most of the intended lines. The
	/// first anchor's current content (old line 20) is in the payload, but
	/// the last anchor's (old line 23) is not, so the guard rejects instead
	/// of duplicating old 18-19 and dropping old 22-23.
	#[tokio::test]
	async fn stale_range_after_upward_shift_stays_rejected() {
		let ctx = Lifecycle::new("case-i.ts", 30);
		let tag0 = ctx.read("case-i.ts", &all_seen(30));
		ctx.edit(&format!("[case-i.ts#{tag0}]\nCUT 3.=4\n"))
			.await
			.unwrap();
		let before = ctx.text("case-i.ts");
		let tag1 = ctx.head_tag("case-i.ts");
		let err = ctx
			.edit(&format!(
				"[case-i.ts#{tag1}]\nPUT 18.=21:\n+let v0018 = 180;\n+let v0019 = 19;\n+let v0020 = \
				 20;\n+let v0021 = 210;\n"
			))
			.await
			.unwrap_err();
		assert!(err.contains("never displayed"), "unexpected error: {err}");
		assert_eq!(ctx.text("case-i.ts"), before);
	}

	/// The same edit at the correctly shifted numbers carries both ends'
	/// current content and applies.
	#[tokio::test]
	async fn faithful_range_after_upward_shift_applies() {
		let ctx = Lifecycle::new("case-j.ts", 30);
		let tag0 = ctx.read("case-j.ts", &all_seen(30));
		ctx.edit(&format!("[case-j.ts#{tag0}]\nCUT 3.=4\n"))
			.await
			.unwrap();
		let tag1 = ctx.head_tag("case-j.ts");
		ctx.edit(&format!(
			"[case-j.ts#{tag1}]\nPUT 16.=19:\n+let v0018 = 18; // a\n+let v0019 = 19;\n+let v0020 = \
			 20;\n+let v0021 = 21; // b\n"
		))
		.await
		.unwrap();
		let text = ctx.text("case-j.ts");
		let window: Vec<&str> = text.lines().skip(14).take(6).collect();
		assert_eq!(window, [
			"let v0017 = 17;",
			"let v0018 = 18; // a",
			"let v0019 = 19;",
			"let v0020 = 20;",
			"let v0021 = 21; // b",
			"let v0022 = 22;",
		]);
	}
}
