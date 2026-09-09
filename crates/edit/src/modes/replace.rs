//! `replace` mode: `old_string` → `new_string` (single or Cursor batch
//! `edits[]`).
//!
//! Port of the executor half of
//! `packages/coding-agent/src/edit/modes/replace.ts`
//! and `executeSinglePathEntries` in `edit/index.ts`. Cursor batches are
//! reported as one aggregate first-state → final-state diff.

use crate::{
	diff_string::{BlockContextSource, generate_diff_string},
	engine::{EditMode, FileOp, Inspection, ModeEngine, PreviewFile, StagedFile},
	error::EditError,
	files::FileSource,
	fuzzy::{
		FindMatchOptions, ReplaceResult, find_match, format_match_error, format_occurrence_error,
		replace_text,
	},
	store::EditStore,
	stream_json::ArgSnapshot,
};

/// Applies exact or optionally fuzzy whole-text replacements.
pub struct ReplaceEngine {
	/// Whether normalized high-confidence matches may be used.
	pub allow_fuzzy:     bool,
	/// Minimum similarity accepted by fuzzy matching.
	pub fuzzy_threshold: f64,
}

impl ReplaceEngine {
	fn replace(
		&self,
		content: &str,
		old_string: &str,
		new_string: &str,
		replace_all: bool,
		path: &str,
	) -> Result<ReplaceResult, EditError> {
		let result = replace_text(
			content,
			old_string,
			new_string,
			self.allow_fuzzy,
			replace_all,
			Some(self.fuzzy_threshold),
		);
		if let Ok(result) = result
			&& result.count > 0
		{
			return Ok(result);
		}

		let outcome = find_match(content, old_string, &FindMatchOptions {
			allow_fuzzy:     self.allow_fuzzy,
			threshold:       Some(self.fuzzy_threshold),
			excluded_ranges: &[],
		});
		if outcome.occurrences.is_some_and(|count| count > 1) {
			return Err(EditError::apply(format_occurrence_error(path, &outcome)));
		}
		Err(EditError::matched(format_match_error(
			path,
			old_string,
			outcome.closest.as_ref(),
			self.allow_fuzzy,
			self.fuzzy_threshold,
			outcome.fuzzy_matches,
		)))
	}

	fn entries(args: &ArgSnapshot) -> Vec<EditEntryRef<'_>> {
		if args.has_edits {
			return args
				.edits
				.iter()
				.map(|entry| EditEntryRef {
					old_string:  entry.old_string.as_deref(),
					new_string:  entry.new_string.as_deref(),
					replace_all: entry.replace_all,
				})
				.collect();
		}
		vec![EditEntryRef {
			old_string:  args.old_string.as_deref(),
			new_string:  args.new_string.as_deref(),
			replace_all: args.replace_all,
		}]
	}

	fn preview_error(display: &str, message: impl Into<String>) -> PreviewFile {
		PreviewFile {
			display: display.to_owned(),
			error: Some(message.into()),
			op: Some(FileOp::Update),
			..PreviewFile::default()
		}
	}
}

#[derive(Clone, Copy)]
struct EditEntryRef<'a> {
	old_string:  Option<&'a str>,
	new_string:  Option<&'a str>,
	replace_all: Option<bool>,
}

impl ModeEngine for ReplaceEngine {
	fn mode(&self) -> EditMode {
		EditMode::Replace
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Vec<PreviewFile> {
		let Some(path) = args.path.as_deref().filter(|path| !path.is_empty()) else {
			return Vec::new();
		};
		let entries = Self::entries(args);
		if entries.is_empty() {
			return Vec::new();
		}
		if streaming && !args.has_edits && args.new_string.is_none() {
			return Vec::new();
		}
		for entry in &entries {
			let Some(old_string) = entry.old_string else {
				return Vec::new();
			};
			if entry.new_string.is_none() {
				return Vec::new();
			}
			if old_string.is_empty() {
				return vec![Self::preview_error(path, "oldText must not be empty.")];
			}
		}
		let read = match files.read(path) {
			Ok(read) => read,
			Err(error) => return vec![Self::preview_error(path, error.to_string())],
		};
		let display = read.resolved.display.clone();
		let before = read.text.clone();
		let mut after = before.clone();
		for entry in entries {
			let old_string = entry.old_string.unwrap_or_default();
			let new_string = entry.new_string.unwrap_or_default();
			match self.replace(
				&after,
				old_string,
				new_string,
				entry.replace_all.unwrap_or(false),
				&display,
			) {
				Ok(result) => after = result.content,
				Err(error) => return vec![Self::preview_error(&display, error.to_string())],
			}
		}
		if before == after {
			return vec![Self::preview_error(
				&display,
				format!(
					"No changes would be made to {display}. The replacement produces identical content."
				),
			)];
		}
		let output = generate_diff_string(&before, &after, None, &BlockContextSource {
			path: Some(&display),
			lang: None,
		});
		vec![PreviewFile {
			display,
			diff: Some(output.diff),
			first_changed_line: output.first_changed_line,
			error: None,
			op: Some(FileOp::Update),
			rename: None,
		}]
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let path = args
			.path
			.as_deref()
			.filter(|path| !path.is_empty())
			.ok_or_else(|| EditError::apply("path is required."))?;
		let entries = Self::entries(args);
		if entries
			.iter()
			.any(|entry| entry.old_string.unwrap_or_default().is_empty())
		{
			return Err(EditError::apply("old_string must not be empty."));
		}
		let read = files.read(path)?;
		let display = read.resolved.display.clone();
		let before = read.text.clone();
		let mut after = before.clone();

		for entry in entries {
			let old_string = entry.old_string.unwrap_or_default();
			let new_string = entry.new_string.unwrap_or_default();
			after = self
				.replace(&after, old_string, new_string, entry.replace_all.unwrap_or(false), &display)?
				.content;
		}
		if before == after {
			return Err(EditError::apply(format!(
				"Edits to {display} resulted in no changes being made."
			)));
		}

		let persisted = read.persist(&after)?;
		let output = generate_diff_string(&before, &after, None, &BlockContextSource {
			path: Some(&display),
			lang: None,
		});
		let mut staged = StagedFile::new(display, read.resolved.absolute.clone(), FileOp::Update);
		staged.before_raw = Some(read.raw.clone());
		staged.before = before;
		staged.after = after;
		staged.persisted = Some(persisted);
		staged.diff = output.diff;
		staged.first_changed_line = output.first_changed_line;
		Ok(vec![staged])
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		let Some(path) = args.path.as_ref().filter(|path| !path.is_empty()) else {
			return Inspection::default();
		};
		Inspection {
			paths:    vec![path.clone()],
			entries:  args
				.new_string
				.as_ref()
				.map_or_else(Vec::new, |new_string| vec![(path.clone(), new_string.clone())]),
			file_ops: Vec::new(),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn engine() -> ReplaceEngine {
		ReplaceEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 }
	}

	#[test]
	fn reports_path_qualified_occurrences() {
		let error = engine()
			.replace("one\none\n", "one", "two", false, "a.txt")
			.unwrap_err();
		assert!(
			error
				.to_string()
				.starts_with("Found 2 occurrences in a.txt")
		);
	}

	#[test]
	fn reports_path_qualified_match_error() {
		let error = engine()
			.replace("alpha\n", "omega", "two", false, "a.txt")
			.unwrap_err();
		assert!(error.to_string().contains("match in a.txt"));
	}
}
