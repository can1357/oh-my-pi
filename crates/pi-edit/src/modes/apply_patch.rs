//! `apply_patch` mode: Codex `*** Begin Patch` envelopes expanded to per-file
//! patch entries. Port of `packages/coding-agent/src/edit/apply-patch/*` and
//! `modes/apply-patch.ts`.

use std::{
	collections::{HashMap, HashSet},
	sync::LazyLock,
};

use regex::Regex;

use super::patch::{Operation, PatchEngine, PatchInput, preview_patch, stage_patch};
use crate::{
	engine::{EditMode, FileOpIntent, Inspection, ModeEngine, PreviewFile, StagedFile},
	error::EditError,
	files::FileSource,
	store::EditStore,
	stream_json::{ArgSnapshot, EditEntry},
	text::js_trim,
};

const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
const END_PATCH_MARKER: &str = "*** End Patch";
const ADD_FILE_MARKER: &str = "*** Add File: ";
const DELETE_FILE_MARKER: &str = "*** Delete File: ";
const UPDATE_FILE_MARKER: &str = "*** Update File: ";
const MOVE_TO_MARKER: &str = "*** Move to: ";
const ATOMICITY_NOTICE: &str = "No files were modified — sections apply atomically.";

static PATH_NOISE_FILE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)^\s*\*{3}\s*(?:Add|Update|Delete)\s+File\s*:\s*")
		.expect("valid path-noise regex")
});
static PATH_NOISE_MOVE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)^\s*\*{3}\s*Move\s+to\s*:\s*").expect("valid move-noise regex")
});
static ENVELOPE_PATH: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?m)^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$")
		.expect("valid apply-patch path regex")
});

/// Remove an accidentally nested apply-patch header from a path.
pub fn strip_apply_patch_path_noise(value: &str) -> String {
	let value = PATH_NOISE_FILE.replace(value, "");
	PATH_NOISE_MOVE.replace(&value, "").into_owned()
}

/// One parsed Codex envelope entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPatchEntry {
	/// Authored source path.
	pub path:   String,
	/// Requested file operation.
	pub op:     Operation,
	/// Optional update destination.
	pub rename: Option<String>,
	/// Full create content or update hunks.
	pub diff:   Option<String>,
}

fn parse_error(message: impl Into<String>, line: Option<usize>) -> EditError {
	let message = message.into();
	EditError::parse(match line {
		Some(line) => format!("Line {line}: {message}"),
		None => message,
	})
}

fn parse_with_options(
	patch_text: &str,
	streaming: bool,
) -> Result<Vec<ApplyPatchEntry>, EditError> {
	let mut lines = js_trim(patch_text).split('\n').collect::<Vec<_>>();
	if lines.len() >= 2
		&& matches!(lines[0], "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
		&& js_trim(lines[lines.len() - 1]) == "EOF"
	{
		lines = lines[1..lines.len() - 1].to_vec();
	}
	if lines.is_empty()
		|| lines
			.first()
			.is_none_or(|line| js_trim(line) != BEGIN_PATCH_MARKER)
	{
		return if streaming {
			Ok(Vec::new())
		} else {
			Err(parse_error("The first line of the patch must be '*** Begin Patch'", None))
		};
	}
	let has_end = lines
		.last()
		.is_some_and(|line| js_trim(line) == END_PATCH_MARKER);
	if !has_end && !streaming {
		return Err(parse_error("The last line of the patch must be '*** End Patch'", None));
	}
	let end = if has_end {
		lines.len() - 1
	} else {
		lines.len()
	};
	let mut index = 1;
	let mut output = Vec::new();
	while index < end {
		if js_trim(lines[index]).is_empty() {
			index += 1;
			continue;
		}
		let first = js_trim(lines[index]);
		if let Some(path) = first.strip_prefix(ADD_FILE_MARKER) {
			index += 1;
			let mut content = String::new();
			while index < end {
				let Some(line) = lines[index].strip_prefix('+') else {
					break;
				};
				content.push_str(line);
				content.push('\n');
				index += 1;
			}
			output.push(ApplyPatchEntry {
				path:   path.to_owned(),
				op:     Operation::Create,
				rename: None,
				diff:   Some(content),
			});
			continue;
		}
		if let Some(path) = first.strip_prefix(DELETE_FILE_MARKER) {
			output.push(ApplyPatchEntry {
				path:   path.to_owned(),
				op:     Operation::Delete,
				rename: None,
				diff:   None,
			});
			index += 1;
			continue;
		}
		if let Some(path) = first.strip_prefix(UPDATE_FILE_MARKER) {
			let path = path.to_owned();
			index += 1;
			let mut rename = None;
			if index < end
				&& let Some(destination) = lines[index].strip_prefix(MOVE_TO_MARKER)
			{
				rename = Some(destination.to_owned());
				index += 1;
			}
			let body_start = index;
			while index < end {
				let line = lines[index];
				if line.starts_with("*** Add File:")
					|| line.starts_with("*** Delete File:")
					|| line.starts_with("*** Update File:")
				{
					break;
				}
				index += 1;
			}
			if body_start == index {
				if streaming {
					output.push(ApplyPatchEntry {
						path,
						op: Operation::Update,
						rename,
						diff: Some(String::new()),
					});
					continue;
				}
				return Err(parse_error(
					format!("Update file hunk for path '{path}' is empty"),
					Some(body_start + 1),
				));
			}
			output.push(ApplyPatchEntry {
				path,
				op: Operation::Update,
				rename,
				diff: Some(lines[body_start..index].join("\n")),
			});
			continue;
		}
		if streaming {
			break;
		}
		return Err(parse_error(
			format!(
				"'{first}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', \
				 '*** Delete File: {{path}}', '*** Update File: {{path}}'"
			),
			Some(index + 1),
		));
	}
	Ok(output)
}

/// Parse a complete Codex `apply_patch` envelope.
pub fn parse_apply_patch(patch_text: &str) -> Result<Vec<ApplyPatchEntry>, EditError> {
	parse_with_options(patch_text, false)
}

/// Best-effort parser for a partially streamed envelope.
pub fn parse_apply_patch_streaming(patch_text: &str) -> Result<Vec<ApplyPatchEntry>, EditError> {
	parse_with_options(patch_text, true)
}

/// Format the Codex A/M/D success summary.
pub fn format_apply_codex_patch_summary(
	added: &[String],
	modified: &[String],
	deleted: &[String],
) -> String {
	let mut lines = vec!["Success. Updated the following files:".to_owned()];
	lines.extend(added.iter().map(|path| format!("A {path}")));
	lines.extend(modified.iter().map(|path| format!("M {path}")));
	lines.extend(deleted.iter().map(|path| format!("D {path}")));
	lines.join("\n")
}

fn as_patch_input(entry: &ApplyPatchEntry) -> PatchInput<'_> {
	PatchInput {
		path:   &entry.path,
		op:     entry.op,
		rename: entry.rename.as_deref(),
		diff:   entry.diff.as_deref(),
	}
}

fn as_edit_entry(entry: &ApplyPatchEntry) -> EditEntry {
	EditEntry {
		op: Some(
			match entry.op {
				Operation::Create => "create",
				Operation::Delete => "delete",
				Operation::Update => "update",
			}
			.to_owned(),
		),
		rename: entry.rename.clone(),
		diff: entry.diff.clone(),
		closed: true,
		..EditEntry::default()
	}
}

fn distinct_paths(entries: &[ApplyPatchEntry]) -> usize {
	entries
		.iter()
		.map(|entry| entry.path.as_str())
		.collect::<HashSet<_>>()
		.len()
}

fn wrap_file_error(path: &str, error: EditError, multiple_files: bool) -> EditError {
	if multiple_files {
		EditError::apply(format!("[{path}]: {error}\n{ATOMICITY_NOTICE}"))
	} else {
		error
	}
}

fn stage_entries(
	entries: &[ApplyPatchEntry],
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
) -> Result<Vec<StagedFile>, EditError> {
	if entries.is_empty() {
		return Err(EditError::apply("No files were modified."));
	}
	let multiple_files = distinct_paths(entries) > 1;
	let mut order = Vec::<String>::new();
	let mut groups = HashMap::<String, Vec<&ApplyPatchEntry>>::new();
	for entry in entries {
		if !groups.contains_key(&entry.path) {
			order.push(entry.path.clone());
		}
		groups.entry(entry.path.clone()).or_default().push(entry);
	}
	let engine = PatchEngine { allow_fuzzy, fuzzy_threshold: threshold };
	let mut staged = Vec::with_capacity(groups.len());
	for path in order {
		let group = &groups[&path];
		let result = if group.len() == 1 {
			stage_patch(as_patch_input(group[0]), files, allow_fuzzy, threshold, false)
				.map(|file| vec![file])
		} else {
			// Validate the strict Add File contract against the running state. A
			// preceding delete permits a later add of the same path.
			let resolved = files
				.resolve(&path, group[0].op != Operation::Create)
				.map_err(|error| wrap_file_error(&path, error, multiple_files))?;
			let mut exists = files.exists(&resolved.absolute);
			for entry in group {
				match entry.op {
					Operation::Create if exists => {
						return Err(wrap_file_error(
							&path,
							EditError::apply(format!(
								"Cannot create {path}: file already exists. Use *** Update File to modify \
								 it in place."
							)),
							multiple_files,
						));
					},
					Operation::Create => exists = true,
					Operation::Delete => exists = false,
					Operation::Update => {},
				}
			}
			let args = ArgSnapshot {
				path: Some(path.clone()),
				edits: group.iter().map(|entry| as_edit_entry(entry)).collect(),
				has_edits: true,
				complete: true,
				..ArgSnapshot::default()
			};
			engine.stage(&args, files, &EditStore::new())
		};
		match result {
			Ok(mut files) => staged.append(&mut files),
			Err(error) => return Err(wrap_file_error(&path, error, multiple_files)),
		}
	}
	Ok(staged)
}

fn extract_added_lines(text: &str) -> String {
	text
		.split('\n')
		.filter_map(|line| line.strip_prefix('+').filter(|_| !line.starts_with("+++ ")))
		.collect::<Vec<_>>()
		.join("\n")
}

fn natural_order_previews(input: &str) -> Vec<PreviewFile> {
	let mut order = Vec::<String>::new();
	let mut groups = HashMap::<String, Vec<String>>::new();
	let mut current = None::<String>;
	for raw in input.split('\n') {
		let trimmed = raw.trim_end();
		if matches!(trimmed, BEGIN_PATCH_MARKER | END_PATCH_MARKER | "*** Abort Patch") {
			continue;
		}
		let header = trimmed
			.strip_prefix(ADD_FILE_MARKER)
			.or_else(|| trimmed.strip_prefix(DELETE_FILE_MARKER))
			.or_else(|| trimmed.strip_prefix(UPDATE_FILE_MARKER));
		if let Some(path) = header {
			let path = path.to_owned();
			if !groups.contains_key(&path) {
				order.push(path.clone());
			}
			groups.entry(path.clone()).or_default();
			current = Some(path);
			continue;
		}
		if trimmed.starts_with("*** Move to:") || trimmed.starts_with("*** End of File") {
			continue;
		}
		if let Some(path) = &current
			&& (matches!(raw.as_bytes().first(), Some(b'+' | b'-' | b' ')) || raw.starts_with("@@"))
		{
			groups.get_mut(path).unwrap().push(raw.to_owned());
		}
	}
	order
		.into_iter()
		.filter_map(|path| {
			let body = groups.remove(&path).unwrap_or_default();
			(!body.is_empty()).then(|| PreviewFile {
				display: path,
				diff: Some(body.join("\n")),
				..PreviewFile::default()
			})
		})
		.collect()
}

fn inspect_entries(input: &str) -> (Vec<String>, Vec<(String, String)>, Vec<FileOpIntent>) {
	let paths = ENVELOPE_PATH
		.captures_iter(input)
		.filter_map(|capture| capture.get(1).map(|value| value.as_str().trim().to_owned()))
		.filter(|path| !path.is_empty())
		.collect::<Vec<_>>();
	let entries = parse_apply_patch(input)
		.or_else(|_| parse_apply_patch_streaming(input))
		.unwrap_or_default();
	let mut order = Vec::new();
	let mut digests = HashMap::<String, String>::new();
	let mut file_ops = Vec::new();
	for entry in entries {
		if let Some(diff) = &entry.diff {
			let added = extract_added_lines(diff);
			if !added.is_empty() {
				if !digests.contains_key(&entry.path) {
					order.push(entry.path.clone());
				}
				digests
					.entry(entry.path.clone())
					.and_modify(|current| {
						current.push('\n');
						current.push_str(&added);
					})
					.or_insert(added);
			}
		}
		if entry.op == Operation::Delete {
			file_ops.push(FileOpIntent::Delete { path: entry.path.clone() });
		}
		if let Some(rename) = entry.rename {
			file_ops.push(FileOpIntent::Move { from: entry.path, to: rename });
		}
	}
	let matcher_entries = order
		.into_iter()
		.map(|path| (path.clone(), digests.remove(&path).unwrap()))
		.collect();
	(paths, matcher_entries, file_ops)
}

/// Codex envelope mode engine.
pub struct ApplyPatchEngine {
	/// Whether inexact hunk placement is allowed.
	pub allow_fuzzy:     bool,
	/// Minimum confidence for character-level fallback matching.
	pub fuzzy_threshold: f64,
}

impl ModeEngine for ApplyPatchEngine {
	fn mode(&self) -> EditMode {
		EditMode::ApplyPatch
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Vec<PreviewFile> {
		let Some(input) = args.input.as_deref().filter(|input| !input.is_empty()) else {
			return Vec::new();
		};
		if streaming {
			let Some(last_newline) = input.rfind('\n') else {
				return Vec::new();
			};
			return natural_order_previews(&input[..=last_newline]);
		}
		let entries = match parse_apply_patch(input) {
			Ok(entries) if !entries.is_empty() => entries,
			Ok(_) | Err(_) => match parse_apply_patch_streaming(input) {
				Ok(entries) => entries,
				Err(error) => {
					return vec![PreviewFile {
						error: Some(error.to_string()),
						..PreviewFile::default()
					}];
				},
			},
		};
		if entries.is_empty() {
			return Vec::new();
		}
		let mut seen = HashSet::new();
		entries
			.iter()
			.filter(|entry| seen.insert(entry.path.clone()))
			.map(|entry| {
				preview_patch(
					as_patch_input(entry),
					files,
					self.allow_fuzzy,
					self.fuzzy_threshold,
					false,
				)
			})
			.collect()
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let input = args.input.as_deref().ok_or_else(|| {
			EditError::parse("The first line of the patch must be '*** Begin Patch'")
		})?;
		let entries = parse_apply_patch(input)?;
		stage_entries(&entries, files, self.allow_fuzzy, self.fuzzy_threshold)
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		let Some(input) = args.input.as_deref() else {
			return Inspection::default();
		};
		let (paths, entries, file_ops) = inspect_entries(input);
		Inspection { paths, entries, file_ops }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_heredoc_wrapper() {
		let parsed = parse_apply_patch(
			"<<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\nEOF",
		)
		.unwrap();
		assert_eq!(parsed, vec![ApplyPatchEntry {
			path:   "a.txt".into(),
			op:     Operation::Create,
			rename: None,
			diff:   Some("hello\n".into()),
		}]);
	}

	#[test]
	fn requires_envelope_markers() {
		assert_eq!(
			parse_apply_patch("*** Add File: a")
				.unwrap_err()
				.to_string(),
			"The first line of the patch must be '*** Begin Patch'"
		);
		assert_eq!(
			parse_apply_patch("*** Begin Patch\n*** Add File: a\n+x")
				.unwrap_err()
				.to_string(),
			"The last line of the patch must be '*** End Patch'"
		);
	}

	#[test]
	fn summary_orders_operations() {
		assert_eq!(
			format_apply_codex_patch_summary(&["a".into()], &["m".into()], &["d".into()]),
			"Success. Updated the following files:\nA a\nM m\nD d"
		);
	}
}
