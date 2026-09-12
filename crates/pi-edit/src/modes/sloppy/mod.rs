//! `sloppy` mode: `<SM:EDIT>`/`<SM:FIND>`/`<SM:PUT>` anchored edits with
//! tolerant matching. Port of `packages/coding-agent/src/edit/sloppy.ts`.

pub mod apply;
pub mod parse;
pub mod types;

pub use types::{InlineSloppyRegion, SloppySection};

use self::{
	apply::{ApplyContext, apply_sloppy},
	parse::split_sloppy_sections,
};
use crate::{
	diff_string::{BlockContextSource, generate_diff_string},
	engine::{EditMode, FileOp, Inspection, ModeEngine, PreviewFile, StagedFile},
	error::EditError,
	files::FileSource,
	store::EditStore,
	stream_json::ArgSnapshot,
};

pub struct SloppyEngine {
	/// Retained for the mode-neutral constructor; sloppy owns its matching
	/// ladder.
	pub allow_fuzzy:     bool,
	/// Retained for the mode-neutral constructor; sloppy owns its matching
	/// thresholds.
	pub fuzzy_threshold: f64,
}

impl SloppyEngine {
	fn sections(args: &ArgSnapshot, streaming: bool) -> Vec<SloppySection> {
		let Some(input) = args.input.as_deref() else {
			return Vec::new();
		};
		let input = if streaming {
			input.rfind('\n').map_or("", |end| &input[..=end])
		} else {
			input
		};
		split_sloppy_sections(input)
	}

	fn missing_target(args: &ArgSnapshot) -> bool {
		args
			.input
			.as_deref()
			.is_some_and(|input| !input.trim().is_empty() && split_sloppy_sections(input).is_empty())
	}
}

impl ModeEngine for SloppyEngine {
	fn mode(&self) -> EditMode {
		EditMode::Sloppy
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Vec<PreviewFile> {
		let _ = (self.allow_fuzzy, self.fuzzy_threshold);
		let sections = Self::sections(args, streaming);
		if sections.is_empty() {
			if !streaming && Self::missing_target(args) {
				return vec![PreviewFile {
					error: Some(
						"Missing file target: start the payload with <SM:EDIT \
						 path=\"relative/path.ts\">."
							.to_owned(),
					),
					..PreviewFile::default()
				}];
			}
			return Vec::new();
		}
		let last = sections.len().saturating_sub(1);
		sections
			.into_iter()
			.enumerate()
			.filter_map(|(index, section)| {
				let read = match files.read(&section.path) {
					Ok(read) => read,
					Err(_error) if streaming && index == last => return None,
					Err(error) => {
						return Some(PreviewFile {
							display: section.path,
							error: Some(error.to_string()),
							..PreviewFile::default()
						});
					},
				};
				let mut notes = Vec::new();
				match apply_sloppy(&read.text, &section.body, ApplyContext {
					path: &read.resolved.display,
					notes: &mut notes,
					store,
					canonical: &read.canonical,
				}) {
					Ok(after) => {
						let output =
							generate_diff_string(&read.text, &after, None, &BlockContextSource {
								path: Some(&read.resolved.display),
								lang: None,
							});
						Some(PreviewFile {
							display: read.resolved.display.clone(),
							diff: Some(output.diff),
							first_changed_line: output.first_changed_line,
							op: Some(FileOp::Update),
							..PreviewFile::default()
						})
					},
					Err(_) if streaming && index == last => None,
					Err(error) => Some(PreviewFile {
						display: read.resolved.display.clone(),
						error: Some(error.to_string()),
						op: Some(FileOp::Update),
						..PreviewFile::default()
					}),
				}
			})
			.collect()
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let _ = (self.allow_fuzzy, self.fuzzy_threshold);
		let input = args.input.as_deref().unwrap_or_default();
		let sections = split_sloppy_sections(input);
		if sections.is_empty() {
			return Err(EditError::parse(
				"Missing file target: start the payload with <SM:EDIT path=\"relative/path.ts\">.",
			));
		}
		let multi_file = sections.len() > 1;
		let mut staged = Vec::with_capacity(sections.len());
		for section in sections {
			let read = files.read(&section.path).map_err(|error| {
				if multi_file {
					EditError::matched(format!(
						"[{}]: {error}\nNo files were modified — sections apply atomically.",
						section.path
					))
				} else {
					error
				}
			})?;
			let mut notes = Vec::new();
			let after = apply_sloppy(&read.text, &section.body, ApplyContext {
				path: &read.resolved.display,
				notes: &mut notes,
				store,
				canonical: &read.canonical,
			})
			.map_err(|error| {
				if multi_file {
					EditError::matched(format!(
						"[{}]: {error}\nNo files were modified — sections apply atomically.",
						read.resolved.display
					))
				} else {
					error
				}
			})?;
			let persisted = read.persist(&after)?;
			let output = generate_diff_string(&read.text, &after, None, &BlockContextSource {
				path: Some(&read.resolved.display),
				lang: None,
			});
			let mut file = StagedFile::new(
				read.resolved.display.clone(),
				read.resolved.absolute.clone(),
				FileOp::Update,
			);
			file.before_raw = Some(read.raw.clone());
			file.before.clone_from(&read.text);
			file.after = after;
			file.persisted = Some(persisted);
			file.diff = output.diff;
			file.first_changed_line = output.first_changed_line;
			file.after_preview = notes;
			staged.push(file);
		}
		Ok(staged)
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		let sections = split_sloppy_sections(args.input.as_deref().unwrap_or_default());
		Inspection {
			paths:    sections
				.iter()
				.map(|section| section.path.clone())
				.collect(),
			entries:  sections
				.into_iter()
				.map(|section| (section.path, section.body))
				.collect(),
			file_ops: Vec::new(),
		}
	}
}
