//! Pure detection and rendering of unresolved git conflict markers.

use std::{collections::HashMap, ops, sync::Arc};

use omp_core::{CowBytes, Str, sf};
use omp_tool::{Diag, DiagKind};
use parking_lot::Mutex;
use smallvec::SmallVec;

use super::{Fault, resolver::Resolve, selector::ParsedSelector};

const OURS_PREFIX: &str = "<<<<<<<";
const BASE_PREFIX: &str = "|||||||";
const SEPARATOR: &str = "=======";
const THEIRS_PREFIX: &str = ">>>>>>>";

/// One complete unresolved conflict block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictBlock {
	/// One-based line containing the `<<<<<<<` marker.
	pub start_line:     usize,
	/// One-based line containing the `=======` marker.
	pub separator_line: usize,
	/// One-based line containing the `>>>>>>>` marker.
	pub end_line:       usize,
	/// One-based line containing the optional `|||||||` marker.
	pub base_line:      Option<usize>,
	/// Label following the opening marker.
	pub ours_label:     Option<String>,
	/// Label following the optional base marker.
	pub base_label:     Option<String>,
	/// Label following the closing marker.
	pub theirs_label:   Option<String>,
	/// Lines in the ours section, excluding markers.
	pub ours_lines:     Vec<String>,
	/// Lines in the base section for a three-way conflict, excluding markers.
	pub base_lines:     Option<Vec<String>>,
	/// Lines in the theirs section, excluding markers.
	pub theirs_lines:   Vec<String>,
}

/// A conflict block with the stable identifier used by conflict renderers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictEntry {
	/// Identifier shown to the model.
	pub id:    usize,
	/// Captured marker block.
	pub block: ConflictBlock,
}

impl ConflictEntry {
	/// Attaches a renderer-visible identifier to a captured block.
	pub const fn new(id: usize, block: ConflictBlock) -> Self {
		Self { id, block }
	}
}

/// Rendered conflict text together with its unresolved-region count.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedConflicts {
	/// Model-facing text.
	pub text:  String,
	/// Structured harness notices.
	pub diags: SmallVec<Diag, 2>,
	/// Number of complete unresolved regions represented by `text`.
	pub count: usize,
}

/// Options controlling diagnostics emitted for an ordinary file read.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ConflictWarningOptions<'a> {
	/// Total conflicts in the file when `entries` only covers a read window.
	pub total_in_file:  Option<usize>,
	/// Display path used in the `:conflicts` hint for a partial window.
	pub display_path:   Option<&'a str>,
	/// Whether the whole-file scan stopped at its byte cap.
	pub scan_truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
	Idle,
	Ours,
	Base,
	Theirs,
}

#[derive(Debug)]
struct PartialConflict {
	start_line:     usize,
	ours_label:     Option<String>,
	ours_lines:     Vec<String>,
	base_line:      Option<usize>,
	base_label:     Option<String>,
	base_lines:     Option<Vec<String>>,
	separator_line: Option<usize>,
	theirs_lines:   Option<Vec<String>>,
}

/// Scans already-collected lines for complete unresolved conflict blocks.
///
/// `first_line_number` is the one-based number of the first input line. Only
/// strict column-zero markers are recognized. Incomplete or malformed blocks
/// are omitted, while a new valid opener abandons any partial preceding block.
pub fn scan_conflict_lines<'a>(
	lines: impl IntoIterator<Item = &'a str>,
	first_line_number: usize,
) -> Vec<ConflictBlock> {
	let mut blocks = Vec::new();
	let mut phase = Phase::Idle;
	let mut partial: Option<PartialConflict> = None;

	for (offset, raw_line) in lines.into_iter().enumerate() {
		let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
		let line_number = first_line_number + offset;

		if let Some(label) = match_marker(line, OURS_PREFIX) {
			partial = Some(PartialConflict {
				start_line:     line_number,
				ours_label:     nonempty_label(label),
				ours_lines:     Vec::new(),
				base_line:      None,
				base_label:     None,
				base_lines:     None,
				separator_line: None,
				theirs_lines:   None,
			});
			phase = Phase::Ours;
			continue;
		}

		let Some(current) = partial.as_mut() else {
			continue;
		};

		if let Some(label) = match_marker(line, BASE_PREFIX) {
			if phase != Phase::Ours {
				partial = None;
				phase = Phase::Idle;
				continue;
			}
			current.base_line = Some(line_number);
			current.base_label = nonempty_label(label);
			current.base_lines = Some(Vec::new());
			phase = Phase::Base;
			continue;
		}

		if line == SEPARATOR {
			if matches!(phase, Phase::Ours | Phase::Base) {
				current.separator_line = Some(line_number);
				current.theirs_lines = Some(Vec::new());
				phase = Phase::Theirs;
			} else {
				partial = None;
				phase = Phase::Idle;
			}
			continue;
		}

		if let Some(label) = match_marker(line, THEIRS_PREFIX) {
			if phase == Phase::Theirs {
				let completed = partial.take().expect("partial checked above");
				if let (Some(separator_line), Some(theirs_lines)) =
					(completed.separator_line, completed.theirs_lines)
				{
					blocks.push(ConflictBlock {
						start_line: completed.start_line,
						separator_line,
						end_line: line_number,
						base_line: completed.base_line,
						ours_label: completed.ours_label,
						base_label: completed.base_label,
						theirs_label: nonempty_label(label),
						ours_lines: completed.ours_lines,
						base_lines: completed.base_lines,
						theirs_lines,
					});
				}
			} else {
				partial = None;
			}
			phase = Phase::Idle;
			continue;
		}

		match phase {
			Phase::Ours => current.ours_lines.push(line.to_owned()),
			Phase::Base => {
				if let Some(lines) = current.base_lines.as_mut() {
					lines.push(line.to_owned());
				}
			},
			Phase::Theirs => {
				if let Some(lines) = current.theirs_lines.as_mut() {
					lines.push(line.to_owned());
				}
			},
			Phase::Idle => {},
		}
	}

	blocks
}

/// Scans a complete UTF-8 text buffer from line one.
pub fn scan_conflicts(input: &str) -> Vec<ConflictBlock> {
	scan_conflict_lines(input.split('\n'), 1)
}

/// Renders the one-line index row used for one conflict region.
pub fn render_conflict_region(entry: &ConflictEntry, id_width: usize) -> String {
	let block = &entry.block;
	let range = if block.start_line == block.end_line {
		format!("L{}", block.start_line)
	} else {
		format!("L{}-{}", block.start_line, block.end_line)
	};
	let kind = if block.base_lines.is_some() {
		"  (3-way)"
	} else {
		""
	};
	format!("#{:>width$}  {range}{kind}", entry.id, width = id_width)
}

/// Formats the `<path>:conflicts` selector result.
pub fn format_conflict_summary(
	entries: &[ConflictEntry],
	display_path: &str,
	scan_truncated: bool,
) -> String {
	let mut lines = Vec::new();
	let total = entries.len();
	let word = if total == 1 { "conflict" } else { "conflicts" };
	let display_path = if display_path.is_empty() {
		"<file>"
	} else {
		display_path
	};
	lines.push(format!("⚠ {total} unresolved {word} in {display_path}"));
	if scan_truncated {
		lines.push(
			"- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned \
			 prefix."
				.to_owned(),
		);
	}
	if let Some(label) = pick_label(entries, |block| block.ours_label.as_deref()) {
		lines.push(format!("- ours = {label}"));
	}
	if let Some(label) = pick_label(entries, |block| block.theirs_label.as_deref()) {
		lines.push(format!("- theirs = {label}"));
	}
	let any_base = entries.iter().any(|entry| entry.block.base_lines.is_some());
	if any_base {
		let label =
			pick_label(entries, |block| block.base_lines.as_ref().and(block.base_label.as_deref()));
		lines.push(format!("- base = {}", label.unwrap_or("(no label)")));
	}
	lines.push(conflict_resolution_guidance(display_path));
	lines.push(String::new());
	let id_width = entries.last().map_or(1, |entry| entry.id.to_string().len());
	lines.extend(
		entries
			.iter()
			.map(|entry| render_conflict_region(entry, id_width)),
	);
	lines.join("\n")
}

/// Scans and formats a one-line-per-region conflict index for `<file>`.
pub fn render_conflicts(input: &str) -> RenderedConflicts {
	render_conflicts_for_path(input, "<file>", false)
}

/// Scans and formats a one-line-per-region conflict index for a display path.
pub fn render_conflicts_for_path(
	input: &str,
	display_path: &str,
	scan_truncated: bool,
) -> RenderedConflicts {
	let entries = numbered_entries(scan_conflicts(input));
	RenderedConflicts {
		text:  format_conflict_summary(&entries, display_path, scan_truncated),
		diags: SmallVec::new(),
		count: entries.len(),
	}
}

/// Builds structured diagnostics for unresolved conflicts visible in an
/// ordinary read.
pub fn format_conflict_warning(
	entries: &[ConflictEntry],
	options: ConflictWarningOptions<'_>,
) -> SmallVec<Diag, 2> {
	if entries.is_empty() {
		return SmallVec::new();
	}
	let total = options.total_in_file.unwrap_or(entries.len());
	let partial = total > entries.len();
	let word = if total == 1 { "conflict" } else { "conflicts" };
	let guidance_path = options.display_path.unwrap_or("path");
	let text = if partial {
		sf!("{} of {total} unresolved {word} visible in this window.", entries.len())
	} else {
		sf!("{total} unresolved {word} detected.")
	};
	let mut diags = SmallVec::new();
	diags.push(Diag::warn(DiagKind::Conflicts, text).continuation(sf!("{guidance_path}:conflicts")));
	if options.scan_truncated {
		diags.push(Diag::warn(
			DiagKind::PartialScan,
			"Conflict scan hit the byte cap; additional conflicts may exist beyond the scanned \
			 prefix.",
		));
	}
	diags
}

fn conflict_resolution_guidance(display_path: &str) -> String {
	format!(
		"NOTICE: Read `{display_path}:conflicts` for the conflict index and `conflict://<id>` (or \
		 `/ours`, `/base`, `/theirs`, `/both`) for exact sides. Resolve with `write` targeting \
		 `conflict://<id>` and content `@ours`, `@base`, `@theirs`, `@both`, or custom text; \
		 re-read `{display_path}:conflicts` to verify."
	)
}

/// Scans a complete file and returns its ordinary-read diagnostics and count.
pub fn render_conflict_warning(input: &str) -> RenderedConflicts {
	let entries = numbered_entries(scan_conflicts(input));
	RenderedConflicts {
		text:  String::new(),
		diags: format_conflict_warning(&entries, ConflictWarningOptions::default()),
		count: entries.len(),
	}
}

fn numbered_entries(blocks: Vec<ConflictBlock>) -> Vec<ConflictEntry> {
	blocks
		.into_iter()
		.enumerate()
		.map(|(index, block)| ConflictEntry::new(index + 1, block))
		.collect()
}

fn match_marker<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
	let rest = line.strip_prefix(prefix)?;
	if rest.is_empty() {
		return Some("");
	}
	rest.strip_prefix(' ')
}

fn nonempty_label(label: &str) -> Option<String> {
	(!label.is_empty()).then(|| label.to_owned())
}

fn pick_label<'a>(
	entries: &'a [ConflictEntry],
	get: impl Fn(&'a ConflictBlock) -> Option<&'a str>,
) -> Option<&'a str> {
	entries
		.iter()
		.filter_map(|entry| get(&entry.block))
		.find(|label| !label.trim().is_empty())
}

/// One session-registered conflict addressable through `conflict://<id>`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisteredConflict {
	/// Stable session-local numeric identity.
	pub id:           usize,
	/// Display path whose bytes contained the marker block.
	pub display_path: Str,
	/// Captured marker block.
	pub block:        ConflictBlock,
}

#[derive(Default)]
struct RegistryState {
	next_id: usize,
	by_id:   HashMap<usize, RegisteredConflict>,
	by_path: HashMap<Str, Vec<usize>>,
}

/// Session-local conflict registry shared by read and splice-capable tools.
#[derive(Clone, Default)]
pub struct ConflictRegistry(Arc<Mutex<RegistryState>>);

impl ConflictRegistry {
	/// Replaces one path's registrations after a complete-file scan.
	///
	/// Unchanged blocks retain their IDs, so re-reading a file does not
	/// invalidate a pending `conflict://<id>` instruction.
	pub fn refresh(&self, display_path: impl Into<Str>, input: &str) -> Vec<RegisteredConflict> {
		let display_path = display_path.into();
		let blocks = scan_conflicts(input);
		let mut state = self.0.lock();
		let prior_ids = state.by_path.remove(&display_path).unwrap_or_default();
		let mut prior = prior_ids
			.into_iter()
			.filter_map(|id| state.by_id.remove(&id))
			.collect::<Vec<_>>();
		let mut registered = Vec::with_capacity(blocks.len());
		for block in blocks {
			let id = prior
				.iter()
				.position(|entry| entry.block == block)
				.map_or_else(
					|| {
						state.next_id = state.next_id.saturating_add(1).max(1);
						state.next_id
					},
					|index| prior.swap_remove(index).id,
				);
			let entry = RegisteredConflict { id, display_path: display_path.clone(), block };
			state.by_id.insert(id, entry.clone());
			registered.push(entry);
		}
		state
			.by_path
			.insert(display_path, registered.iter().map(|entry| entry.id).collect());
		registered
	}

	/// Returns a registered conflict by session-local ID.
	pub fn get(&self, id: usize) -> Option<RegisteredConflict> {
		self.0.lock().by_id.get(&id).cloned()
	}

	/// Removes a registration after a confirmed splice.
	pub fn remove(&self, id: usize) -> Option<RegisteredConflict> {
		let mut state = self.0.lock();
		let removed = state.by_id.remove(&id)?;
		let path_empty = state
			.by_path
			.get_mut(&removed.display_path)
			.is_some_and(|ids| {
				ids.retain(|candidate| *candidate != id);
				ids.is_empty()
			});
		if path_empty {
			state.by_path.remove(&removed.display_path);
		}
		Some(removed)
	}

	/// Returns current registrations in numeric order.
	pub fn entries(&self) -> Vec<RegisteredConflict> {
		let state = self.0.lock();
		let mut entries = state.by_id.values().cloned().collect::<Vec<_>>();
		entries.sort_unstable_by_key(|entry| entry.id);
		entries
	}
}

/// A conflict-region projection selected by the URL path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConflictScope {
	/// Render all sides with labels and source line locations.
	All,
	/// Render only the current branch.
	Ours,
	/// Render only the merge base.
	Base,
	/// Render only the incoming branch.
	Theirs,
	/// Render current and incoming sides in order.
	Both,
}

/// Parsed `conflict://<id>[/<scope>]` address.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConflictAddress {
	/// Session-local conflict ID.
	pub id:    usize,
	/// Requested region projection.
	pub scope: ConflictScope,
}

/// Parses a conflict URL resource without its `conflict://` prefix.
pub fn parse_conflict_address(resource: &str) -> Result<ConflictAddress, Fault> {
	if resource == "*" {
		return Err(Fault::Invalid {
			message: sf!("conflict://* is write-only; read one conflict ID"),
		});
	}
	let (id, scope) = resource.split_once('/').unwrap_or((resource, ""));
	let id = id
		.parse::<usize>()
		.ok()
		.filter(|id| *id > 0)
		.ok_or_else(|| Fault::Invalid {
			message: sf!("Invalid conflict address 'conflict://{resource}'"),
		})?;
	let scope = match scope.to_ascii_lowercase().as_str() {
		"" => ConflictScope::All,
		"ours" => ConflictScope::Ours,
		"base" => ConflictScope::Base,
		"theirs" => ConflictScope::Theirs,
		"both" => ConflictScope::Both,
		_ => {
			return Err(Fault::Invalid {
				message: sf!("Unknown conflict scope '{scope}'; use ours, base, theirs, or both"),
			});
		},
	};
	Ok(ConflictAddress { id, scope })
}

/// Constructor-owned resolver for session conflict registrations.
#[derive(Clone)]
pub struct ConflictResolver {
	registry: ConflictRegistry,
}

impl ConflictResolver {
	/// Creates a resolver sharing `registry` with conflict-scanning readers.
	pub const fn new(registry: ConflictRegistry) -> Self {
		Self { registry }
	}
}

impl Resolve for ConflictResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		if !matches!(selector, ParsedSelector::None | ParsedSelector::Raw) {
			return Err(Fault::Invalid {
				message: sf!(
					"conflict:// reads accept only :raw; choose /ours, /base, /theirs, or /both",
				),
			});
		}
		let address = parse_conflict_address(resource)?;
		let entry = self.registry.get(address.id).ok_or_else(|| Fault::Source {
			message: sf!("Conflict #{} is no longer registered", address.id),
		})?;
		Ok(CowBytes::from(render_registered(&entry, address.scope).into_bytes()))
	}
}

/// Replacement requested by a conflict splice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConflictReplacement {
	/// Keep the current branch.
	Ours,
	/// Restore the merge base.
	Base,
	/// Keep the incoming branch.
	Theirs,
	/// Keep current then incoming text.
	Both,
	/// Install caller-supplied text.
	Custom(Str),
}

/// A successfully prepared whole-document conflict splice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictSplice {
	/// Complete post-splice UTF-8 document.
	pub text:             Str,
	/// One-based marker range replaced in the current document.
	pub range:            (usize, usize),
	/// Leading replacement lines dropped as an adjacent-context echo.
	pub trimmed_leading:  usize,
	/// Trailing replacement lines dropped as an adjacent-context echo.
	pub trimmed_trailing: usize,
}

/// Parses exact side directives while preserving all custom text verbatim.
pub fn parse_replacement(content: Str) -> ConflictReplacement {
	match content.trim().as_str() {
		"@ours" => ConflictReplacement::Ours,
		"@base" => ConflictReplacement::Base,
		"@theirs" => ConflictReplacement::Theirs,
		"@both" => ConflictReplacement::Both,
		_ => ConflictReplacement::Custom(content),
	}
}

/// Parses a token-only `conflict://*` per-ID directive block.
///
/// Returns `None` when no line is directive-shaped, selecting uniform bulk
/// replacement mode. A partial directive block is rejected rather than being
/// pasted literally into every conflict.
pub fn parse_bulk_directives(
	content: &str,
) -> Result<Option<HashMap<usize, ConflictReplacement>>, Fault> {
	let mut directives = HashMap::new();
	let mut stray = Vec::new();
	let mut saw_directive = false;
	for raw in content.lines() {
		let line = raw.trim();
		if line.is_empty() {
			continue;
		}
		let Some((head, value)) = line.split_once([':', '=']) else {
			stray.push(Str::new(line));
			continue;
		};
		let Some(id) = head
			.trim()
			.strip_prefix('#')
			.unwrap_or(head.trim())
			.parse::<usize>()
			.ok()
			.filter(|id| *id > 0)
		else {
			stray.push(Str::new(line));
			continue;
		};
		let replacement = match value.trim() {
			"@ours" => ConflictReplacement::Ours,
			"@base" => ConflictReplacement::Base,
			"@theirs" => ConflictReplacement::Theirs,
			"@both" => ConflictReplacement::Both,
			_ => {
				stray.push(Str::new(line));
				continue;
			},
		};
		saw_directive = true;
		if directives.insert(id, replacement).is_some() {
			return Err(Fault::Invalid {
				message: sf!("Bulk directive lists conflict #{id} more than once"),
			});
		}
	}
	if !saw_directive {
		return Ok(None);
	}
	if let Some(first) = stray.first() {
		return Err(Fault::Invalid {
			message: sf!(
				"Malformed conflict://* directive block; expected one '<id>: @side' per line (first \
				 invalid line: {first})"
			),
		});
	}
	Ok(Some(directives))
}

/// Applies every selected registration for one file in memory.
///
/// The caller commits `text` once, so any stale/ambiguous/base failure
/// leaves the file unchanged. Duplicate registrations of a block already
/// resolved earlier in this pass are retained in `resolved_ids` and removed
/// together.
pub fn splice_registered_bulk(
	current: &str,
	entries: &[(RegisteredConflict, ConflictReplacement)],
) -> Result<BulkConflictSplice, Fault> {
	let mut ordered = entries.to_vec();
	ordered.sort_unstable_by(|left, right| right.0.block.start_line.cmp(&left.0.block.start_line));
	let mut text = Str::new(current);
	let mut resolved_ids = Vec::with_capacity(ordered.len());
	let mut resolved_blocks = Vec::with_capacity(ordered.len());
	let mut echo_trimmed = 0usize;
	for (entry, replacement) in ordered {
		match splice_registered(&text, &entry, &replacement) {
			Ok(splice) => {
				text = splice.text;
				echo_trimmed = echo_trimmed
					.saturating_add(splice.trimmed_leading)
					.saturating_add(splice.trimmed_trailing);
				resolved_blocks.push(entry.block.clone());
				resolved_ids.push(entry.id);
			},
			Err(_)
				if resolved_blocks
					.iter()
					.any(|block| same_conflict(block, &entry.block)) =>
			{
				resolved_ids.push(entry.id);
			},
			Err(error) => return Err(error),
		}
	}
	Ok(BulkConflictSplice { text, resolved_ids, echo_trimmed })
}

/// Complete preflighted text and registrations for one bulk-conflict file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkConflictSplice {
	/// Complete post-splice UTF-8 document.
	pub text:         Str,
	/// Every live or stale-duplicate registration resolved by this text.
	pub resolved_ids: Vec<usize>,
	/// Total adjacent-context echo lines removed.
	pub echo_trimmed: usize,
}

/// Applies one registered splice to current bytes without clobbering drift.
///
/// When the recorded line range moved, an exact semantic block may be
/// recovered only if it is unique. Duplicate matches are rejected.
pub fn splice_registered(
	current: &str,
	entry: &RegisteredConflict,
	replacement: &ConflictReplacement,
) -> Result<ConflictSplice, Fault> {
	let candidates = scan_conflicts(current)
		.into_iter()
		.filter(|block| same_conflict(block, &entry.block))
		.collect::<Vec<_>>();
	let selected = candidates
		.iter()
		.find(|block| {
			block.start_line == entry.block.start_line && block.end_line == entry.block.end_line
		})
		.or_else(|| (candidates.len() == 1).then(|| &candidates[0]))
		.ok_or_else(|| Fault::Source {
			message: Str::new(if candidates.is_empty() {
				format!("Conflict #{} is stale; its marker block no longer exists", entry.id)
			} else {
				format!(
					"Conflict #{} is ambiguous; {} identical marker blocks exist",
					entry.id,
					candidates.len()
				)
			}),
		})?;
	let range = line_byte_range(current, selected.start_line, selected.end_line)?;
	let had_line_ending = current[range.clone()].ends_with('\n');
	let mut replacement_text = replacement_text(selected, replacement)?;
	while replacement_text.ends_with('\n') {
		replacement_text.pop();
	}
	let mut replacement_lines = replacement_text
		.split('\n')
		.map(|line| line.trim_end_matches('\r').to_owned())
		.collect::<Vec<_>>();
	let (trimmed_leading, trimmed_trailing) =
		trim_boundary_echo(&mut replacement_lines, current, &range, selected);
	replacement_text = replacement_lines.join("\n");
	if had_line_ending && !replacement_text.is_empty() {
		replacement_text.push('\n');
	}
	let mut output = String::with_capacity(current.len() - range.len() + replacement_text.len());
	output.push_str(&current[..range.start]);
	output.push_str(&replacement_text);
	output.push_str(&current[range.end..]);
	Ok(ConflictSplice {
		text: Str::new(output),
		range: (selected.start_line, selected.end_line),
		trimmed_leading,
		trimmed_trailing,
	})
}

const MAX_ECHO_LINES: usize = 12;

fn trim_boundary_echo(
	replacement: &mut Vec<String>,
	current: &str,
	range: &ops::Range<usize>,
	block: &ConflictBlock,
) -> (usize, usize) {
	if replacement.len() <= 1 {
		return (0, 0);
	}
	let expected_balance = {
		let ours = delimiter_balance(&block.ours_lines);
		(ours == delimiter_balance(&block.theirs_lines)).then_some(ours)
	};
	let justified = |lines: &[String], without: &[String]| {
		expected_balance.is_some_and(|expected| {
			delimiter_balance(lines) != expected && delimiter_balance(without) == expected
		})
	};
	let after = current[range.end..]
		.lines()
		.take(MAX_ECHO_LINES)
		.map(|line| line.trim_end_matches('\r').to_owned())
		.collect::<Vec<_>>();
	let mut trimmed_trailing = 0;
	for count in (1..=after.len().min(replacement.len().saturating_sub(1))).rev() {
		let start = replacement.len() - count;
		if replacement[start..] == after[..count]
			&& (count >= 2 || justified(replacement, &replacement[..start]))
		{
			replacement.truncate(start);
			trimmed_trailing = count;
			break;
		}
	}
	let before_all = current[..range.start]
		.lines()
		.rev()
		.take(MAX_ECHO_LINES)
		.map(|line| line.trim_end_matches('\r').to_owned())
		.collect::<Vec<_>>();
	let before = before_all.into_iter().rev().collect::<Vec<_>>();
	let mut trimmed_leading = 0;
	for count in (1..=before.len().min(replacement.len().saturating_sub(1))).rev() {
		let start = before.len() - count;
		if replacement[..count] == before[start..]
			&& (count >= 2 || justified(replacement, &replacement[count..]))
		{
			replacement.drain(..count);
			trimmed_leading = count;
			break;
		}
	}
	(trimmed_leading, trimmed_trailing)
}

fn delimiter_balance(lines: &[String]) -> i32 {
	lines.iter().fold(0, |balance, line| {
		line.bytes().fold(balance, |balance, byte| match byte {
			b'{' | b'(' | b'[' => balance + 1,
			b'}' | b')' | b']' => balance - 1,
			_ => balance,
		})
	})
}

fn render_registered(entry: &RegisteredConflict, scope: ConflictScope) -> String {
	let block = &entry.block;
	let section = |lines: &[String]| lines.join("\n");
	match scope {
		ConflictScope::Ours => section(&block.ours_lines),
		ConflictScope::Base => block.base_lines.as_deref().map(section).unwrap_or_default(),
		ConflictScope::Theirs => section(&block.theirs_lines),
		ConflictScope::Both => join_sides(&block.ours_lines, &block.theirs_lines),
		ConflictScope::All => {
			let mut out = format!(
				"[conflict://{}]\n{}:L{}-L{}\n<<<<<<< {}",
				entry.id,
				entry.display_path,
				block.start_line,
				block.end_line,
				block.ours_label.as_deref().unwrap_or("ours")
			);
			if !block.ours_lines.is_empty() {
				out.push('\n');
				out.push_str(&section(&block.ours_lines));
			}
			if let Some(base) = &block.base_lines {
				out.push_str("\n||||||| ");
				out.push_str(block.base_label.as_deref().unwrap_or("base"));
				if !base.is_empty() {
					out.push('\n');
					out.push_str(&section(base));
				}
			}
			out.push_str("\n=======");
			if !block.theirs_lines.is_empty() {
				out.push('\n');
				out.push_str(&section(&block.theirs_lines));
			}
			out.push_str("\n>>>>>>> ");
			out.push_str(block.theirs_label.as_deref().unwrap_or("theirs"));
			out
		},
	}
}

fn same_conflict(left: &ConflictBlock, right: &ConflictBlock) -> bool {
	left.ours_label == right.ours_label
		&& left.base_label == right.base_label
		&& left.theirs_label == right.theirs_label
		&& left.ours_lines == right.ours_lines
		&& left.base_lines == right.base_lines
		&& left.theirs_lines == right.theirs_lines
}

fn replacement_text(
	block: &ConflictBlock,
	replacement: &ConflictReplacement,
) -> Result<String, Fault> {
	Ok(match replacement {
		ConflictReplacement::Ours => block.ours_lines.join("\n"),
		ConflictReplacement::Base => block
			.base_lines
			.as_ref()
			.ok_or_else(|| Fault::Invalid {
				message: sf!("@base requires a three-way conflict with a base section"),
			})?
			.join("\n"),
		ConflictReplacement::Theirs => block.theirs_lines.join("\n"),
		ConflictReplacement::Both => join_sides(&block.ours_lines, &block.theirs_lines),
		ConflictReplacement::Custom(text) => text.to_string(),
	})
}

fn join_sides(ours: &[String], theirs: &[String]) -> String {
	match (ours.is_empty(), theirs.is_empty()) {
		(true, true) => String::new(),
		(false, true) => ours.join("\n"),
		(true, false) => theirs.join("\n"),
		(false, false) => format!("{}\n{}", ours.join("\n"), theirs.join("\n")),
	}
}

fn line_byte_range(
	input: &str,
	start_line: usize,
	end_line: usize,
) -> Result<ops::Range<usize>, Fault> {
	let mut starts = Vec::with_capacity(input.bytes().filter(|byte| *byte == b'\n').count() + 1);
	starts.push(0);
	for (index, byte) in input.bytes().enumerate() {
		if byte == b'\n' {
			starts.push(index + 1);
		}
	}
	if start_line == 0 || end_line < start_line || end_line > starts.len() {
		return Err(Fault::Source {
			message: sf!("Conflict line range L{start_line}-L{end_line} is stale"),
		});
	}
	let start = starts[start_line - 1];
	let end = starts.get(end_line).copied().unwrap_or(input.len());
	Ok(start..end)
}

#[cfg(test)]
mod tests {
	use omp_tool::DiagKind;

	use super::{
		ConflictRegistry, ConflictReplacement, ConflictScope, ConflictWarningOptions,
		format_conflict_warning, parse_conflict_address, render_registered, splice_registered,
	};

	const CONFLICT: &str =
		"before\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> topic\nafter\n";

	#[test]
	fn registry_retains_ids_and_resolves_scopes() {
		let registry = ConflictRegistry::default();
		let first = registry.refresh("src/lib.rs", CONFLICT);
		let second = registry.refresh("src/lib.rs", CONFLICT);
		assert_eq!(first[0].id, second[0].id);
		assert_eq!(render_registered(&first[0], ConflictScope::Ours), "ours");
		assert_eq!(parse_conflict_address("1/theirs").unwrap().scope, ConflictScope::Theirs);
	}

	#[test]
	fn splice_uses_registered_semantics_and_rejects_stale_content() {
		let registry = ConflictRegistry::default();
		let entry = registry.refresh("src/lib.rs", CONFLICT).remove(0);
		let spliced = splice_registered(CONFLICT, &entry, &ConflictReplacement::Both).unwrap();
		assert_eq!(spliced.text, "before\nours\ntheirs\nafter\n");
		let changed = CONFLICT.replace("ours", "changed");
		assert!(splice_registered(&changed, &entry, &ConflictReplacement::Ours).is_err());
	}

	#[test]
	fn capped_ordinary_scan_emits_conflict_and_partial_scan_diags() {
		let registry = ConflictRegistry::default();
		let entries = registry
			.refresh("src/lib.rs", CONFLICT)
			.into_iter()
			.map(|entry| super::ConflictEntry::new(entry.id, entry.block))
			.collect::<Vec<_>>();
		let diags = format_conflict_warning(&entries, ConflictWarningOptions {
			total_in_file:  Some(1),
			display_path:   Some("src/lib.rs"),
			scan_truncated: true,
		});
		assert_eq!(diags.len(), 2);
		assert_eq!(diags[0].native_kind(), Some(DiagKind::Conflicts));
		assert_eq!(diags[0].severity, omp_tool::Severity::Warn);
		assert_eq!(diags[0].continuation.as_deref(), Some("src/lib.rs:conflicts"));
		assert_eq!(diags[1].native_kind(), Some(DiagKind::PartialScan));
		assert_eq!(diags[1].severity, omp_tool::Severity::Warn);
	}

	#[test]
	fn base_requires_a_three_way_conflict() {
		let registry = ConflictRegistry::default();
		let entry = registry
			.refresh("x", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic\n")
			.remove(0);
		assert!(
			splice_registered(
				"<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic\n",
				&entry,
				&ConflictReplacement::Base,
			)
			.is_err()
		);
	}
}
