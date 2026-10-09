//! The five edit-mode engines.

use crate::engine::{EditMode, ModeEngine};

pub mod apply_patch;
pub mod hashline;
pub mod patch;
pub mod replace;
pub mod sloppy;

/// Engine for `mode`. Engines are stateless; policy arrives per call.
pub fn engine_for(
	mode: EditMode,
	allow_fuzzy: bool,
	fuzzy_threshold: f64,
	enforce_seen_lines: bool,
) -> Box<dyn ModeEngine> {
	match mode {
		EditMode::Replace => Box::new(replace::ReplaceEngine { allow_fuzzy, fuzzy_threshold }),
		EditMode::Patch => Box::new(patch::PatchEngine { allow_fuzzy, fuzzy_threshold }),
		EditMode::ApplyPatch => {
			Box::new(apply_patch::ApplyPatchEngine { allow_fuzzy, fuzzy_threshold })
		},
		EditMode::Hashline => Box::new(hashline::HashlineEngine { enforce_seen_lines }),
		EditMode::Sloppy => Box::new(sloppy::SloppyEngine { allow_fuzzy, fuzzy_threshold }),
	}
}

/// TTSR digest of a diff body: the `+` rows' text (excluding `+++ ` file
/// headers) joined by `\n`, or `None` when there are no such rows (patch mode
/// distinguishes that from a lone empty `+` row). Callers pick the row
/// splitter because hashline payloads split with `lines()` while diff bodies
/// keep `\r` via `split('\n')`.
pub(crate) fn added_lines<'a>(rows: impl Iterator<Item = &'a str>) -> Option<String> {
	let mut out = None::<String>;
	for line in rows {
		let Some(added) = line.strip_prefix('+') else {
			continue;
		};
		if line.starts_with("+++ ") {
			continue;
		}
		match &mut out {
			Some(out) => {
				out.push('\n');
				out.push_str(added);
			},
			None => out = Some(added.to_owned()),
		}
	}
	out
}
