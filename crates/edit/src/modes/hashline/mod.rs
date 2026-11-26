//! `hashline` mode: `[path#TAG]` sections of line-anchored ops.
//! Port of the `@oh-my-pi/hashline` engine package plus the coding-agent
//! runner (`edit/hashline/*`).

pub mod apply;
pub mod block;
pub mod clipboard;
pub mod format;
pub mod input;
pub mod messages;
pub mod mismatch;
pub mod parser;
pub mod patcher;
pub mod prefixes;
pub mod preview;
pub mod recovery;
pub mod syntax;
pub mod tokenizer;
pub mod types;

use self::{
	format::is_snapshot_tag,
	input::{Patch, SplitOptions},
	types::FileOp,
};
use crate::{
	engine::{EditMode, FileOpIntent, Inspection, ModeEngine, PreviewFile, StagedFile},
	error::EditError,
	files::FileSource,
	scan,
	store::EditStore,
	stream_json::ArgSnapshot,
};

pub struct HashlineEngine {
	pub enforce_seen_lines: bool,
	/// See [`crate::session::SessionConfig::max_columns`].
	pub max_columns:        usize,
}

impl ModeEngine for HashlineEngine {
	fn mode(&self) -> EditMode {
		EditMode::Hashline
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Vec<PreviewFile> {
		let Some(input) = args.input.as_deref().filter(|input| !input.is_empty()) else {
			return Vec::new();
		};
		match Patch::parse(input, &SplitOptions { cwd: Some(&files.policy().cwd), path: None }) {
			Ok(patch) if !patch.sections.is_empty() => {
				preview::preview_patch(&patch, streaming, files, store)
			},
			Ok(_) => Vec::new(),
			Err(_) if streaming => Vec::new(),
			Err(error) => {
				vec![PreviewFile { error: Some(error.to_string()), ..PreviewFile::default() }]
			},
		}
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let input = args.input.as_deref().unwrap_or_default();
		let patch =
			Patch::parse(input, &SplitOptions { cwd: Some(&files.policy().cwd), path: None })?;
		if patch.sections.is_empty() {
			let path = input::first_header_path(input, &SplitOptions {
				cwd:  Some(&files.policy().cwd),
				path: None,
			});
			return Err(match path {
				Some(path) => patcher::header_only_error(&path, files),
				None => EditError::parse("No hashline sections found in input."),
			});
		}
		patcher::stage_patch(&patch, input, self.enforce_seen_lines, self.max_columns, files, store)
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		inspect_input(args.input.as_deref().unwrap_or_default())
	}
}

/// Strip an `apply_patch` label such as `*** Update File:` from a path.
fn strip_path_noise(value: &str) -> String {
	let value = value.trim_start();
	let path = value.strip_prefix("***").and_then(|rest| {
		let rest = rest.trim_start();
		let (action, target) = match rest.as_bytes().first()?.to_ascii_lowercase() {
			b'a' => ("add", "file"),
			b'u' => ("update", "file"),
			b'd' => ("delete", "file"),
			b'm' => ("move", "to"),
			_ => return None,
		};
		let rest = scan::keyword(rest, action)?;
		let rest = scan::keyword(scan::space(rest)?, target)?;
		rest.trim_start().strip_prefix(':')
	});
	path.unwrap_or(value).trim().to_owned()
}

/// Find bracketed path rows and their full spans in a patch preview.
fn header_parts(input: &str) -> Vec<(String, usize, usize)> {
	let mut headers = Vec::new();
	let mut search = input;
	while !search.is_empty() {
		let row = search.trim_start();
		let (line, next) = row.split_once('\n').unwrap_or((row, ""));
		let Some((inner, _)) = line
			.strip_prefix('[')
			.and_then(|line| line.split_once(']'))
			.filter(|(inner, after)| {
				!inner.is_empty() && !inner.contains('\r') && after.trim_start().is_empty()
			})
		else {
			search = next;
			continue;
		};
		let start = input.len() - search.len();
		let tail = &row[line.len()..];
		let nonblank = tail.trim_start();
		let end = if nonblank.is_empty() {
			input.len()
		} else {
			// Trailing blank rows belong to the header only up to a row ending.
			let whitespace = &tail[..tail.len() - nonblank.len()];
			input.len() - tail.len() + whitespace.rfind('\n').expect("row break")
		};
		let inner = inner
			.rsplit_once('#')
			.filter(|(_, tag)| is_snapshot_tag(tag))
			.map_or(inner, |(path, _)| path);
		let path = strip_path_noise(inner);
		if !path.is_empty() {
			headers.push((path, start, end));
		}
		// After a blank row, the closing boundary can also start the next row.
		search = if end == input.len() || input.as_bytes()[end - 1] == b'\n' {
			&input[end..]
		} else {
			&input[end + 1..]
		};
	}
	headers
}

fn inspect_input(input: &str) -> Inspection {
	let headers = header_parts(input);
	let paths = headers.iter().map(|(path, ..)| path.clone()).collect();
	let mut entries = Vec::<(String, String)>::new();
	for (index, (path, _, body_start)) in headers.iter().enumerate() {
		let body_end = headers
			.get(index + 1)
			.map_or(input.len(), |(_, start, _)| *start);
		let digest = super::added_lines(input[*body_start..body_end].lines()).unwrap_or_default();
		if digest.is_empty() {
			continue;
		}
		if let Some((_, existing)) = entries.iter_mut().find(|(candidate, _)| candidate == path) {
			existing.push('\n');
			existing.push_str(&digest);
		} else {
			entries.push((path.clone(), digest));
		}
	}
	let mut file_ops = Vec::new();
	if let Ok(patch) = Patch::parse(input, &SplitOptions { cwd: None, path: None }) {
		for section in patch.sections {
			if let Ok(Some(op)) = section.file_op() {
				match op {
					FileOp::Rem => file_ops.push(FileOpIntent::Delete { path: section.path.clone() }),
					FileOp::Move { dest } => file_ops
						.push(FileOpIntent::Move { from: section.path.clone(), to: dest.clone() }),
				}
			}
		}
	}
	Inspection { paths, entries, file_ops }
}

#[cfg(test)]
mod tests {
	use super::inspect_input;

	#[test]
	fn inspect_extracts_paths_and_added_lines_from_partial_input() {
		let inspected =
			inspect_input("[*** Update File: src/a.ts#ABCD]\nPUT 1.=1:\n+new\n[src/b.ts]\nCUT 2.=2");
		assert_eq!(inspected.paths, ["src/a.ts", "src/b.ts"]);
		assert_eq!(inspected.entries, [("src/a.ts".into(), "new".into())]);
	}
}
