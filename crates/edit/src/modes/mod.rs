//! The five edit-mode engines.

use crate::engine::{EditMode, ModeEngine};

/// Codex-style apply-patch envelope mode.
pub mod apply_patch;
/// Hashline-anchored edit mode.
pub mod hashline;
/// Structured JSON patch mode.
pub mod patch;
/// Exact or fuzzy text replacement mode.
pub mod replace;
/// Tolerant tagged sloppy-edit mode.
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
