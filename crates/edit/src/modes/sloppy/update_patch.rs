//! A foreign update hunk must not pass through sloppy's marker recovery or
//! Codex's first-match patch placement. Parse the entire tool argument first,
//! then place each hunk exactly once against the original file.

use std::collections::HashSet;

use crate::{
	engine::Inspection,
	error::{EditError, EditResult, Rejection},
	files::{FileRead, FileSource},
};

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const UPDATE: &str = "*** Update File: ";

pub(super) struct Update<'a> {
	path: &'a str,
	/// Complete hunk rows, including their `@@` separators and diff prefixes.
	rows: Vec<&'a str>,
}

/// `None` delegates to sloppy. Dispatch only on the first section's shape:
/// a later `@@` in a Find or Insert body is not a patch opener.
pub(super) fn parse(input: &str) -> Option<EditResult<Vec<Update<'_>>>> {
	let mut lines = input
		.lines()
		.skip_while(|line| line.trim().is_empty())
		.peekable();
	let _ = lines.next_if_eq(&BEGIN);
	let first = *lines.peek()?;
	if first.starts_with("*** Add File:") || first.starts_with("*** Delete File:") {
		return Some(Err(EditError::parse("Sloppy patches only support Update File hunks.")));
	}
	if !first.starts_with("*** Update File:") {
		return None;
	}
	let body = lines.clone().skip(1).find(|line| !line.trim().is_empty())?;
	if body.starts_with("*** Move to:") {
		return Some(Err(EditError::parse("Sloppy patches cannot move files.")));
	}
	body.starts_with("@@").then(|| parse_updates(lines))
}

fn parse_updates<'a>(
	mut lines: std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> EditResult<Vec<Update<'a>>> {
	let mut updates = Vec::new();
	loop {
		let header = lines.next().unwrap_or_default();
		if header == END && lines.all(|line| line.trim().is_empty()) {
			return Ok(updates);
		}
		let path = header
			.strip_prefix(UPDATE)
			.filter(|path| !path.is_empty() && *path == path.trim())
			.ok_or_else(|| {
				EditError::parse("Expected an explicit *** Update File: path or a final *** End Patch.")
			})?;
		let mut rows = Vec::new();
		while lines.next_if_eq(&"@@").is_some() {
			rows.push("@@");
			let mut has_old = false;
			let mut has_change = false;
			while let Some(row) = lines.next_if(|row| row.starts_with([' ', '-', '+'])) {
				has_old |= !row.starts_with('+');
				has_change |= !row.starts_with(' ');
				rows.push(row);
			}
			if !has_old || !has_change {
				return Err(EditError::parse(format!(
					"Each @@ hunk in {path} needs old or context lines and a change."
				)));
			}
		}
		if rows.is_empty() {
			return Err(EditError::parse(format!("Expected a complete @@ hunk in {path}.")));
		}
		updates.push(Update { path, rows });
	}
}

pub(super) fn inspect(input: &str, parsed: EditResult<Vec<Update<'_>>>) -> Inspection {
	let mut inspection = Inspection::default();
	let Ok(updates) = parsed else {
		// A partially streamed payload may already name more than one file.
		// Prefixes are significant: ` *** Update File: ...` is context.
		inspection.paths.extend(input.lines().filter_map(|line| {
			line
				.strip_prefix(UPDATE)
				.filter(|path| !path.is_empty())
				.map(str::to_owned)
		}));
		return inspection;
	};
	for update in updates {
		inspection.paths.push(update.path.to_owned());
		let mut added = update.rows.iter().filter_map(|row| row.strip_prefix('+'));
		let mut digest = added.next().unwrap_or_default().to_owned();
		for row in added {
			digest.push('\n');
			digest.push_str(row);
		}
		inspection.entries.push((update.path.to_owned(), digest));
	}
	inspection
}

impl Update<'_> {
	fn apply(&self, text: &str) -> EditResult<String> {
		let lines: Vec<_> = text.split_terminator('\n').collect();
		let mut after = String::with_capacity(text.len());
		let mut old = Vec::new();
		let mut cursor = 0;
		for hunk in self.rows[1..].split(|row| *row == "@@") {
			old.clear();
			old.extend(
				hunk
					.iter()
					.filter(|row| !row.starts_with('+'))
					.map(|row| &row[1..]),
			);
			let mut matches = lines
				.windows(old.len())
				.enumerate()
				.filter(|(_, window)| *window == old.as_slice());
			let Some((start, _)) = matches.next() else {
				return Err(EditError::apply(format!(
					"Failed to find exact hunk lines in {}.",
					self.path
				)));
			};
			if matches.next().is_some() {
				return Err(EditError::apply(format!(
					"Ambiguous hunk in {}: provide more context lines.",
					self.path
				)));
			}
			if start < cursor {
				return Err(EditError::apply(format!(
					"Overlapping or out-of-order hunks in {}.",
					self.path
				)));
			}
			let replacement = hunk
				.iter()
				.filter(|row| !row.starts_with('-'))
				.map(|row| &row[1..]);
			for row in lines[cursor..start].iter().copied().chain(replacement) {
				after.push_str(row);
				after.push('\n');
			}
			cursor = start + old.len();
		}
		for row in &lines[cursor..] {
			after.push_str(row);
			after.push('\n');
		}
		if !text.ends_with('\n') {
			after.pop();
		}
		if after == text {
			return Err(EditError::apply(format!("Patch makes no change in {}.", self.path)));
		}
		Ok(after)
	}
}

/// In particular, don't ask the host to invent a suffix match for a missing
/// target. Two authored paths resolving to one file cannot stage two writes.
pub(super) fn map_files<T>(
	updates: &[Update<'_>],
	files: &mut dyn FileSource,
	mut map: impl FnMut(&FileRead, String) -> EditResult<T>,
) -> EditResult<Vec<T>> {
	let mut seen = HashSet::new();
	updates
		.iter()
		.map(|update| {
			let resolved = files.resolve(update.path, false)?;
			if resolved.display != update.path {
				return Err(EditError::parse(format!(
					"Expected a literal file path, not {}.",
					update.path
				)));
			}
			let read = files.try_read(&resolved)?.ok_or_else(|| {
				EditError::rejected(Rejection::FileNotFound, format!("File not found: {}", update.path))
			})?;
			if updates.len() > 1 && !seen.insert(read.canonical.clone()) {
				return Err(EditError::parse(format!("Repeated patch target: {}.", update.path)));
			}
			map(&read, update.apply(&read.text)?)
		})
		.collect()
}
