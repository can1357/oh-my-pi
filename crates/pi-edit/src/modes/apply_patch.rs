//! `apply_patch` mode: Codex `*** Begin Patch` envelopes expanded to per-file
//! patch entries. Port of `packages/coding-agent/src/edit/apply-patch/*` and
//! `modes/apply-patch.ts`.

use std::{
	collections::{HashMap, HashSet},
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
};

use regex::Regex;

use super::patch::{Operation, PatchEngine, PatchInput, stage_patch};
use crate::{
	engine::{
		EditMode, FileOp, FileOpIntent, Inspection, ModeEngine, PreviewFile, Resolved, StagedFile,
	},
	error::{EditError, Rejection},
	files::{FileRead, FileSource},
	notebook::{is_notebook_path, notebook_to_editable_text},
	path_policy::{PathPolicy, canonical_key},
	store::EditStore,
	stream_json::{ArgSnapshot, EditEntry},
	text::{LineEnding, detect_line_ending, js_trim, normalize_to_lf, strip_bom},
};

const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
const END_PATCH_MARKER: &str = "*** End Patch";
const ADD_FILE_MARKER: &str = "*** Add File: ";
const DELETE_FILE_MARKER: &str = "*** Delete File: ";
const UPDATE_FILE_MARKER: &str = "*** Update File: ";
const MOVE_TO_MARKER: &str = "*** Move to: ";

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
				if streaming || rename.is_some() {
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
		path:        &entry.path,
		op:          entry.op,
		rename:      entry.rename.as_deref(),
		diff:        entry.diff.as_deref(),
		first_match: true,
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

/// Prefix a multi-file failure with its path. An unresolved internal URL
/// stays typed so the host can resolve it and retry.
fn wrap_file_error(path: &str, error: EditError, multiple_files: bool) -> EditError {
	if multiple_files && !matches!(error, EditError::UnresolvedUrl(_)) {
		EditError::InFile { path: path.to_owned(), source: Box::new(error) }
	} else {
		error
	}
}

enum VirtualFile {
	Raw(String),
	Read(Arc<FileRead>),
}

/// The ordered envelope's read-through namespace. Disk remains untouched until
/// every section has staged; tombstones prevent suffix recovery from reviving
/// a path that an earlier section deleted or moved.
struct VirtualFiles<'a> {
	source: &'a mut dyn FileSource,
	state:  HashMap<PathBuf, Option<VirtualFile>>,
}

impl VirtualFiles<'_> {
	fn record(&mut self, file: &StagedFile) {
		if file.op == FileOp::Delete || file.move_to.is_some() {
			self.state.insert(canonical_key(&file.absolute), None);
		}
		if let Some(raw) = &file.persisted {
			let target = file
				.move_to
				.as_ref()
				.map_or(&file.absolute, |to| &to.absolute);
			self
				.state
				.insert(canonical_key(target), Some(VirtualFile::Raw(raw.clone())));
		}
	}
}

impl FileSource for VirtualFiles<'_> {
	fn policy(&self) -> &PathPolicy {
		self.source.policy()
	}

	fn resolve(&mut self, authored: &str, must_exist: bool) -> Result<Resolved, EditError> {
		let resolved = self.source.resolve(authored, false)?;
		if self.state.contains_key(&canonical_key(&resolved.absolute)) || !must_exist {
			return Ok(resolved);
		}
		self.source.resolve(authored, true)
	}

	fn exists(&mut self, absolute: &Path) -> bool {
		self
			.state
			.get(&canonical_key(absolute))
			.map_or_else(|| self.source.exists(absolute), Option::is_some)
	}

	fn read(&mut self, authored: &str) -> Result<Arc<FileRead>, EditError> {
		let resolved = self.resolve(authored, true)?;
		self.try_read(&resolved)?.ok_or_else(|| {
			EditError::rejected(
				Rejection::FileNotFound,
				format!("File not found: {}", resolved.display),
			)
		})
	}

	fn try_read(&mut self, resolved: &Resolved) -> Result<Option<Arc<FileRead>>, EditError> {
		let key = canonical_key(&resolved.absolute);
		let Some(state) = self.state.remove(&key) else {
			return self.source.try_read(resolved);
		};
		let read = match state {
			None => {
				self.state.insert(key, None);
				return Ok(None);
			},
			Some(VirtualFile::Read(read)) => read,
			Some(VirtualFile::Raw(raw)) => {
				if let Some(message) = self
					.policy()
					.auto_generated_message(&resolved.display, &raw.as_bytes()[..raw.len().min(1024)])
				{
					return Err(EditError::apply(message));
				}
				let is_notebook = is_notebook_path(&resolved.absolute);
				let (bom, body) = strip_bom(&raw);
				let ending = if is_notebook {
					LineEnding::Lf
				} else {
					detect_line_ending(body)
				};
				let (bom, text) = if is_notebook {
					let text = notebook_to_editable_text(&raw, &resolved.display)
						.map_err(|error| EditError::apply(error.to_string()))?;
					("", normalize_to_lf(&text).into_owned())
				} else {
					(bom, normalize_to_lf(body).into_owned())
				};
				Arc::new(FileRead {
					resolved: resolved.clone(),
					canonical: key.clone(),
					raw,
					bom,
					ending,
					text,
					is_notebook,
				})
			},
		};
		self
			.state
			.insert(key, Some(VirtualFile::Read(Arc::clone(&read))));
		Ok(Some(read))
	}

	fn clear(&mut self) {
		self.state.clear();
		self.source.clear();
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
	let mut files = VirtualFiles { source: files, state: HashMap::new() };
	let engine = PatchEngine { allow_fuzzy, fuzzy_threshold: threshold, first_match: true };
	let mut staged = Vec::with_capacity(entries.len());
	let mut index = 0;
	while index < entries.len() {
		let start = index;
		let path = &entries[start].path;
		index += 1;
		// Only adjacent, non-moving sections may coalesce. A move must publish
		// its source and destination state before any later section is read.
		if entries[start].rename.is_none() {
			while index < entries.len()
				&& entries[index].path == *path
				&& entries[index].rename.is_none()
			{
				index += 1;
			}
		}
		let group = &entries[start..index];
		let result = if group.len() == 1 {
			stage_patch(as_patch_input(&group[0]), &mut files, allow_fuzzy, threshold, false)
				.map(|file| vec![file])
		} else {
			// Validate the strict Add File contract against the running state. A
			// preceding delete permits a later add of the same path.
			let resolved = files
				.resolve(path, group[0].op != Operation::Create)
				.map_err(|error| wrap_file_error(path, error, multiple_files))?;
			let mut exists = files.exists(&resolved.absolute);
			for entry in group {
				match entry.op {
					Operation::Create if exists => {
						return Err(wrap_file_error(
							path,
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
				edits: group.iter().map(as_edit_entry).collect(),
				has_edits: true,
				complete: true,
				..ArgSnapshot::default()
			};
			engine.stage(&args, &mut files, &EditStore::new())
		};
		match result {
			Ok(mut next) => {
				if index < entries.len() {
					for file in &next {
						files.record(file);
					}
				}
				staged.append(&mut next);
			},
			Err(error) => return Err(wrap_file_error(path, error, multiple_files)),
		}
	}
	Ok(staged)
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
			let added = super::added_lines(diff.split('\n')).unwrap_or_default();
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
		match stage_entries(&entries, files, self.allow_fuzzy, self.fuzzy_threshold) {
			Ok(staged) => staged
				.into_iter()
				.map(|file| PreviewFile {
					display:            file.display,
					diff:               file.preview_diff.or(Some(file.diff)),
					first_changed_line: file.first_changed_line,
					error:              None,
					op:                 Some(file.op),
					rename:             file.move_to.map(|destination| destination.display),
				})
				.collect(),
			Err(error) => {
				vec![PreviewFile { error: Some(error.to_string()), ..PreviewFile::default() }]
			},
		}
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
