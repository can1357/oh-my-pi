//! Pure rendering for directory reads.
//!
//! The application owns traversal and supplies [`DirEntry`] values. This
//! module only assembles, caps, formats, and slices those values.

use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	iter,
	time::{Duration, UNIX_EPOCH},
};

use omp_core::{Str, sf, utc_minute};
use omp_tool::{Diag, DiagKind, Unit};
use smallvec::{SmallVec, smallvec};

/// Maximum directory depth rendered below the root.
pub const MAX_DEPTH: usize = 2;
/// Maximum retained children for each non-root directory.
pub const CHILD_LIMIT: usize = 12;
/// Maximum prompt-tree depth below the root.
pub const PROMPT_MAX_DEPTH: usize = 3;
/// Maximum prompt-tree rows, including the root and elision marker.
pub const PROMPT_LINE_CAP: usize = 120;

/// Filesystem metadata collected by the application for one directory entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirEntry {
	/// Slash-separated path relative to the listed directory.
	pub relative_path: Str,
	/// Whether this entry is a directory.
	pub is_dir:        bool,
	/// File size in bytes. Directory sizes are not rendered.
	pub size:          u64,
	/// Modification time as milliseconds since the Unix epoch.
	pub modified_ms:   u64,
}

/// Fully formatted result of one directory read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryRender {
	/// Model-facing listing.
	pub text:        Str,
	/// Structured harness notices.
	pub diags:       SmallVec<Diag, 2>,
	/// Number of rows in the unsliced listing.
	pub total_lines: usize,
	/// Whether traversal or a per-directory child cap omitted entries.
	pub truncated:   bool,
	/// Resolved path represented by this listing.
	pub root_path:   Str,
	/// Directory listings are projections, never editable file snapshots.
	pub edit_locked: bool,
}

#[derive(Clone, Copy)]
struct EntryRef<'a> {
	entry: &'a DirEntry,
	name:  &'a str,
	depth: usize,
}

struct RenderedLine {
	label: String,
	size:  Option<String>,
	age:   Option<String>,
	depth: usize,
}

/// Render application-supplied directory metadata using read's tree layout.
///
/// `now_ms` is supplied by the caller rather than sampled here, keeping this
/// pure and making relative ages deterministic. `scan_truncated` preserves an
/// incomplete traversal reported by the application. `offset` is one-based
/// and `limit` is a row count; both are applied after the complete tree has
/// been aligned and rendered.
pub fn render_directory(
	root_path: impl Into<Str>,
	entries: &[DirEntry],
	scan_truncated: bool,
	now_ms: u64,
	offset: Option<usize>,
	limit: Option<usize>,
) -> DirectoryRender {
	let root_path = root_path.into();
	let mut by_parent: HashMap<&str, Vec<EntryRef<'_>>> = HashMap::new();
	for entry in entries {
		let path = entry.relative_path.as_str().trim_matches('/');
		if path.is_empty() {
			continue;
		}
		let depth = path.bytes().filter(|byte| *byte == b'/').count() + 1;
		if depth > MAX_DEPTH {
			continue;
		}
		let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
		by_parent
			.entry(parent)
			.or_default()
			.push(EntryRef { entry, name, depth });
	}
	for children in by_parent.values_mut() {
		children.sort_unstable_by(|a, b| a.name.cmp(b.name));
	}

	let mut rows = vec![RenderedLine { label: ".".into(), size: None, age: None, depth: 0 }];
	let mut truncated = scan_truncated;
	let mut diags = SmallVec::new();
	render_children("", 0, &by_parent, now_ms, &mut rows, &mut truncated, &mut diags);
	let formatted = format_lines(&rows);
	let base = if rows.len() <= 1 {
		"(empty directory)".to_owned()
	} else {
		formatted
	};
	let all_lines: Vec<&str> = base.split('\n').collect();
	let total_lines = all_lines.len();

	if offset.is_none() && limit.is_none() {
		return DirectoryRender {
			root_path,
			text: base.into(),
			diags,
			total_lines,
			truncated,
			edit_locked: true,
		};
	}

	let start = offset.unwrap_or(1).saturating_sub(1);
	if start >= total_lines {
		diags.push(
			Diag::warn(
				DiagKind::RangeOutOfBounds,
				sf!("Line {} is beyond end of listing ({total_lines} lines total).", start + 1),
			)
			.continuation(":1"),
		);
		return DirectoryRender {
			root_path,
			text: Str::new_static(""),
			diags,
			total_lines,
			truncated,
			edit_locked: true,
		};
	}
	let end = limit.map_or(total_lines, |count| start.saturating_add(count).min(total_lines));
	let text = all_lines[start..end].join("\n");
	if end < total_lines {
		let remaining = total_lines - end;
		diags.push(
			Diag::info(DiagKind::Pagination, sf!("{remaining} lines remain in listing."))
				.continuation(sf!(":{}", end + 1))
				.omitted(remaining as u64, Unit::Lines),
		);
	}
	DirectoryRender {
		root_path,
		text: text.into(),
		diags,
		total_lines,
		truncated,
		edit_locked: true,
	}
}

fn render_children<'a>(
	parent: &str,
	parent_depth: usize,
	by_parent: &HashMap<&'a str, Vec<EntryRef<'a>>>,
	now_ms: u64,
	rows: &mut Vec<RenderedLine>,
	truncated: &mut bool,
	diags: &mut SmallVec<Diag, 2>,
) {
	let Some(all) = by_parent.get(parent) else {
		return;
	};
	let retained = if parent_depth > 0 {
		all.len().min(CHILD_LIMIT)
	} else {
		all.len()
	};
	for child in &all[..retained] {
		render_entry(*child, parent, by_parent, now_ms, rows, truncated, diags);
	}
	if retained == all.len() {
		return;
	}

	*truncated = true;
	let omitted = all.len() - retained;
	diags.push(
		Diag::info(DiagKind::LimitReached, sf!("{omitted} directory entries omitted."))
			.omitted(omitted as u64, Unit::Entries),
	);
}

fn render_entry<'a>(
	node: EntryRef<'a>,
	parent: &str,
	by_parent: &HashMap<&'a str, Vec<EntryRef<'a>>>,
	now_ms: u64,
	rows: &mut Vec<RenderedLine>,
	truncated: &mut bool,
	diags: &mut SmallVec<Diag, 2>,
) {
	let suffix = if node.entry.is_dir { "/" } else { "" };
	rows.push(RenderedLine {
		label: format!("{}- {}{suffix}", "  ".repeat(node.depth), node.name),
		size:  (!node.entry.is_dir).then(|| format_bytes(node.entry.size)),
		age:   format_age(now_ms.saturating_sub(node.entry.modified_ms) / 1_000),
		depth: node.depth,
	});
	if !node.entry.is_dir || node.depth >= MAX_DEPTH {
		return;
	}
	let child_path = if parent.is_empty() {
		node.name.to_owned()
	} else {
		format!("{parent}/{}", node.name)
	};
	render_children(&child_path, node.depth, by_parent, now_ms, rows, truncated, diags);
}

/// Renders the deterministic workspace tree embedded in the prompt.
///
/// The caller supplies a gitignore-aware, hidden-filtered scan. Entries are
/// ordered by recency, capped to twelve children per directory and depth three,
/// timestamped to stable UTC minutes, then trimmed deepest-first to 120 rows.
pub fn render_prompt_directory(
	root_path: impl Into<Str>,
	entries: &[DirEntry],
	scan_truncated: bool,
) -> DirectoryRender {
	let root_path = root_path.into();
	let mut by_parent: HashMap<&str, Vec<EntryRef<'_>>> = HashMap::new();
	for entry in entries {
		let path = entry.relative_path.as_str().trim_matches('/');
		if path.is_empty() {
			continue;
		}
		let depth = path.bytes().filter(|byte| *byte == b'/').count() + 1;
		if depth > PROMPT_MAX_DEPTH {
			continue;
		}
		let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
		by_parent
			.entry(parent)
			.or_default()
			.push(EntryRef { entry, name, depth });
	}
	for children in by_parent.values_mut() {
		children.sort_unstable_by(|left, right| {
			right
				.entry
				.modified_ms
				.cmp(&left.entry.modified_ms)
				.then_with(|| left.name.cmp(right.name))
		});
	}

	let mut rows = vec![RenderedLine { label: ".".into(), size: None, age: None, depth: 0 }];
	let mut truncated = scan_truncated;
	render_prompt_children("", 0, &by_parent, &mut rows, &mut truncated);
	let before_cap = rows.len();
	apply_prompt_line_cap(&mut rows);
	truncated |= rows.len() != before_cap;
	let total_lines = rows.len();
	DirectoryRender {
		text: if total_lines <= 1 {
			"(empty directory)".into()
		} else {
			format_lines(&rows).into()
		},
		diags: smallvec![],
		total_lines,
		truncated,
		root_path,
		edit_locked: true,
	}
}

fn render_prompt_children<'a>(
	parent: &str,
	parent_depth: usize,
	by_parent: &HashMap<&'a str, Vec<EntryRef<'a>>>,
	rows: &mut Vec<RenderedLine>,
	truncated: &mut bool,
) {
	let Some(all) = by_parent.get(parent) else {
		return;
	};
	let (recent, oldest, omitted) = if all.len() > CHILD_LIMIT {
		*truncated = true;
		(&all[..CHILD_LIMIT - 1], all.last(), all.len() - CHILD_LIMIT)
	} else {
		(all.as_slice(), None, 0)
	};
	for child in recent {
		render_prompt_entry(*child, parent, by_parent, rows, truncated);
	}
	if omitted > 0 {
		rows.push(RenderedLine {
			label: format!("{}- … {omitted} more", "  ".repeat(parent_depth + 1)),
			size:  None,
			age:   None,
			depth: parent_depth + 1,
		});
	}
	if let Some(oldest) = oldest {
		render_prompt_entry(*oldest, parent, by_parent, rows, truncated);
	}
}

fn render_prompt_entry<'a>(
	node: EntryRef<'a>,
	parent: &str,
	by_parent: &HashMap<&'a str, Vec<EntryRef<'a>>>,
	rows: &mut Vec<RenderedLine>,
	truncated: &mut bool,
) {
	let suffix = if node.entry.is_dir { "/" } else { "" };
	let age = utc_minute(UNIX_EPOCH + Duration::from_millis(node.entry.modified_ms))
		.ok()
		.filter(|value| !value.is_empty());
	rows.push(RenderedLine {
		label: format!("{}- {}{suffix}", "  ".repeat(node.depth), node.name),
		size: (!node.entry.is_dir).then(|| format_bytes(node.entry.size)),
		age,
		depth: node.depth,
	});
	if !node.entry.is_dir || node.depth >= PROMPT_MAX_DEPTH {
		return;
	}
	let child_path = if parent.is_empty() {
		node.name.to_owned()
	} else {
		format!("{parent}/{}", node.name)
	};
	render_prompt_children(&child_path, node.depth, by_parent, rows, truncated);
}

fn apply_prompt_line_cap(rows: &mut Vec<RenderedLine>) {
	if rows.len() <= PROMPT_LINE_CAP {
		return;
	}
	let target = PROMPT_LINE_CAP - 1;
	let remove_count = rows.len() - target;
	let mut removable = rows
		.iter()
		.enumerate()
		.filter(|(_, row)| row.depth > 1)
		.map(|(index, row)| (index, row.depth))
		.collect::<Vec<_>>();
	removable
		.sort_unstable_by(|left, right| right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)));
	let removed = removable
		.into_iter()
		.take(remove_count)
		.map(|(index, _)| index)
		.collect::<HashSet<_>>();
	let count = removed.len();
	let mut index = 0;
	rows.retain(|_| {
		let keep = !removed.contains(&index);
		index += 1;
		keep
	});
	if count > 0 {
		rows.push(RenderedLine {
			label: format!("[…{count}ln elided…]"),
			size:  None,
			age:   None,
			depth: 0,
		});
	}
}

/// Renders a flat, deterministic directory-mention listing with relative ages.
pub fn render_directory_mention(entries: &[DirEntry], now_ms: u64, limit: usize) -> Str {
	let mut entries = entries.iter().collect::<Vec<_>>();
	entries.sort_unstable_by(|left, right| {
		left
			.relative_path
			.as_str()
			.to_ascii_lowercase()
			.cmp(&right.relative_path.as_str().to_ascii_lowercase())
			.then_with(|| left.relative_path.cmp(&right.relative_path))
	});
	let retained = entries.len().min(limit);
	if retained == 0 {
		return "(empty directory)".into();
	}
	let mut output = String::new();
	for (index, entry) in entries[..retained].iter().enumerate() {
		if index > 0 {
			output.push('\n');
		}
		output.push_str(entry.relative_path.as_str());
		if entry.is_dir {
			output.push('/');
		}
		if let Some(age) = format_age(now_ms.saturating_sub(entry.modified_ms) / 1_000) {
			let _ = write!(output, " ({age})");
		}
	}
	if retained < entries.len() {
		let _ = write!(
			output,
			"\n\n[{limit} entries limit reached. Use limit={} for more]",
			limit.saturating_mul(2)
		);
	}
	output.into()
}

fn format_lines(rows: &[RenderedLine]) -> String {
	let max_label_len = rows
		.iter()
		.map(|row| xutf::width_str(&row.label))
		.max()
		.unwrap_or(0);
	let mut output = String::new();
	for (index, row) in rows.iter().enumerate() {
		if index > 0 {
			output.push('\n');
		}
		let Some(age) = &row.age else {
			output.push_str(&row.label);
			continue;
		};
		output.push_str(&row.label);
		output.extend(iter::repeat_n(' ', max_label_len - xutf::width_str(&row.label) + 2));
		let size = row.size.as_deref().unwrap_or("");
		output.push_str(size);
		output.extend(iter::repeat_n(' ', 8usize.saturating_sub(size.len())));
		output.push_str("  ");
		output.push_str(age);
	}
	output
}

fn format_bytes(bytes: u64) -> String {
	const KB: f64 = 1024.0;
	const MB: f64 = 1024.0 * 1024.0;
	const GB: f64 = 1024.0 * 1024.0 * 1024.0;
	match bytes {
		0..=1023 => format!("{bytes}B"),
		1024..=1_048_575 => format!("{:.1}KB", bytes as f64 / KB),
		1_048_576..=1_073_741_823 => format!("{:.1}MB", bytes as f64 / MB),
		_ => format!("{:.1}GB", bytes as f64 / GB),
	}
}

fn format_age(seconds: u64) -> Option<String> {
	if seconds == 0 {
		return None;
	}
	let minutes = seconds / 60;
	let hours = minutes / 60;
	let days = hours / 24;
	let weeks = days / 7;
	let months = days / 30;
	Some(if months > 0 {
		format!("{months}mo ago")
	} else if weeks > 0 {
		format!("{weeks}w ago")
	} else if days > 0 {
		format!("{days}d ago")
	} else if hours > 0 {
		format!("{hours}h ago")
	} else if minutes > 0 {
		format!("{minutes}m ago")
	} else {
		"just now".to_owned()
	})
}

#[cfg(test)]
mod tests {
	use omp_tool::DiagKind;

	use super::*;

	#[test]
	fn entries_are_alphabetical_and_directories_have_slashes() {
		let entries = [
			DirEntry {
				relative_path: "zeta.txt".into(),
				is_dir:        false,
				size:          3,
				modified_ms:   9_000,
			},
			DirEntry {
				relative_path: "alpha".into(),
				is_dir:        true,
				size:          0,
				modified_ms:   1_000,
			},
			DirEntry {
				relative_path: "alpha/b.txt".into(),
				is_dir:        false,
				size:          2,
				modified_ms:   8_000,
			},
			DirEntry {
				relative_path: "alpha/a.txt".into(),
				is_dir:        false,
				size:          1,
				modified_ms:   7_000,
			},
		];
		let rendered = render_directory("root", &entries, false, 10_000, None, None);
		let alpha = rendered.text.find("- alpha/").unwrap();
		let nested_a = rendered.text.find("- a.txt").unwrap();
		let nested_b = rendered.text.find("- b.txt").unwrap();
		let zeta = rendered.text.find("- zeta.txt").unwrap();
		assert!(alpha < nested_a && nested_a < nested_b && nested_b < zeta);
		assert!(rendered.edit_locked);
	}

	#[test]
	fn listing_ranges_emit_structured_pagination_and_bounds_diags() {
		let entries = [DirEntry {
			relative_path: "a.txt".into(),
			is_dir:        false,
			size:          1,
			modified_ms:   0,
		}];
		let page = render_directory("root", &entries, false, 10_000, Some(1), Some(1));
		assert_eq!(page.text, ".");
		let [diag] = page.diags.as_slice() else {
			panic!("bounded listing emits one pagination diagnostic");
		};
		assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
		assert_eq!(diag.severity, omp_tool::Severity::Info);
		assert_eq!(diag.continuation.as_deref(), Some(":2"));
		assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 1, unit: omp_tool::Unit::Lines }));

		let beyond = render_directory("root", &entries, false, 10_000, Some(3), Some(1));
		assert!(beyond.text.is_empty());
		let [diag] = beyond.diags.as_slice() else {
			panic!("out-of-range listing emits one bounds diagnostic");
		};
		assert_eq!(diag.native_kind(), Some(DiagKind::RangeOutOfBounds));
		assert_eq!(diag.severity, omp_tool::Severity::Warn);
		assert_eq!(diag.continuation.as_deref(), Some(":1"));
	}

	#[test]
	fn same_input_is_deterministic_across_input_order() {
		let mut entries = vec![
			DirEntry {
				relative_path: "b".into(),
				is_dir:        false,
				size:          2,
				modified_ms:   2,
			},
			DirEntry {
				relative_path: "a".into(),
				is_dir:        false,
				size:          1,
				modified_ms:   1,
			},
		];
		let first = render_directory("root", &entries, false, 10_000, None, None);
		entries.reverse();
		let second = render_directory("root", &entries, false, 10_000, None, None);
		assert_eq!(first, second);
	}

	#[test]
	fn prompt_mode_uses_utc_minutes_and_deepest_first_cap() {
		let mut entries = Vec::new();
		for group in 0..15 {
			entries.push(DirEntry {
				relative_path: format!("group-{group:02}").into(),
				is_dir:        true,
				size:          0,
				modified_ms:   1_735_689_600_000 + group,
			});
			for child in 0..12 {
				entries.push(DirEntry {
					relative_path: format!("group-{group:02}/child-{child:02}").into(),
					is_dir:        true,
					size:          0,
					modified_ms:   1_735_689_600_000 + child,
				});
				entries.push(DirEntry {
					relative_path: format!("group-{group:02}/child-{child:02}/leaf.txt").into(),
					is_dir:        false,
					size:          4,
					modified_ms:   1_735_689_600_000 + child,
				});
			}
		}
		let rendered = render_prompt_directory("root", &entries, false);
		assert!(rendered.total_lines <= PROMPT_LINE_CAP);
		assert!(rendered.truncated);
		assert!(rendered.text.contains("2025-01-01 00:00"));
		assert!(rendered.text.contains("ln elided"));
	}
}
