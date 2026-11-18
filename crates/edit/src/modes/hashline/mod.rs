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
	input::{Patch, SplitOptions},
	types::FileOp,
};
use crate::{
	engine::{EditMode, FileOpIntent, Inspection, ModeEngine, PreviewFile, StagedFile},
	error::EditError,
	files::FileSource,
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

fn inspect_input(input: &str) -> Inspection {
	let (headers, patch_end) = input::header_spans(input);
	let paths = headers.iter().map(|(path, ..)| path.clone()).collect();
	let mut entries = Vec::<(String, String)>::new();
	let mut sections = Vec::new();
	for (index, (path, start, body_start)) in headers.iter().enumerate() {
		let body_end = headers
			.get(index + 1)
			.map_or(patch_end, |(_, start, _)| *start);
		super::push_section(&mut sections, path, input[*start..body_end].trim());
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
	super::pair_move_destinations(&mut sections, &file_ops);
	Inspection { paths, entries, file_ops, sections }
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
		assert_eq!(inspected.sections, [
			("src/a.ts".into(), "[*** Update File: src/a.ts#ABCD]\nPUT 1.=1:\n+new".into()),
			("src/b.ts".into(), "[src/b.ts]\nCUT 2.=2".into()),
		]);
	}

	#[test]
	fn an_indented_bracket_row_stays_in_its_file_section() {
		let input = "[settings.toml#ABCD]\nPUT 3.=3:\n+[server]\n  [server.auth]\n+token = \"x\"";
		let inspected = inspect_input(input);
		assert_eq!(inspected.paths, ["settings.toml"]);
		assert_eq!(inspected.entries, [("settings.toml".into(), "[server]\ntoken = \"x\"".into())]);
		assert_eq!(inspected.sections, [("settings.toml".into(), input.into())]);
	}
}
