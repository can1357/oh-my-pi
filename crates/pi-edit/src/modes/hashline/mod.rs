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

use std::sync::LazyLock;

use regex::Regex;

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
			return Err(EditError::apply("No hashline sections found in input."));
		}
		patcher::stage_patch(&patch, input, self.enforce_seen_lines, files, store)
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		inspect_input(args.input.as_deref().unwrap_or_default())
	}
}

static PATH_NOISE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?i)^\s*\*{3}\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*")
		.expect("valid hashline path-noise regex")
});
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?m)^\s*\[([^\]\r\n]+)\]\s*$").expect("valid hashline header regex")
});

fn strip_path_noise(value: &str) -> String {
	PATH_NOISE.replace(value, "").trim().to_owned()
}

fn header_parts(input: &str) -> Vec<(String, usize, usize)> {
	HEADER
		.captures_iter(input)
		.filter_map(|captures| {
			let whole = captures.get(0)?;
			let mut inner = captures.get(1)?.as_str();
			if inner.len() >= 5
				&& inner.as_bytes()[inner.len() - 5] == b'#'
				&& inner[inner.len() - 4..]
					.bytes()
					.all(|byte| byte.is_ascii_hexdigit())
			{
				inner = &inner[..inner.len() - 5];
			}
			let path = strip_path_noise(inner);
			(!path.is_empty()).then_some((path, whole.start(), whole.end()))
		})
		.collect()
}

fn added_lines(body: &str) -> String {
	body
		.lines()
		.filter_map(|line| line.strip_prefix('+').filter(|_| !line.starts_with("+++ ")))
		.collect::<Vec<_>>()
		.join("\n")
}

fn inspect_input(input: &str) -> Inspection {
	let headers = header_parts(input);
	let paths = headers.iter().map(|(path, ..)| path.clone()).collect();
	let mut entries = Vec::<(String, String)>::new();
	for (index, (path, _, body_start)) in headers.iter().enumerate() {
		let body_end = headers
			.get(index + 1)
			.map_or(input.len(), |(_, start, _)| *start);
		let digest = added_lines(&input[*body_start..body_end]);
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
