//! Edit engine: every edit mode's parsing, matching, in-memory application,
//! and diff generation, plus a streaming [`session::Session`] that turns raw
//! tool-call argument deltas into progressive previews and a final atomic
//! apply through a host-owned writer.
//!
//! # Architecture
//! ```text
//! raw arg deltas ──> stream_json::ArgStream ──> ArgSnapshot
//!                                                  │
//!                     ┌────────────────────────────┴───────────────┐
//!                     ▼                                            ▼
//!            ModeEngine::preview (streaming)              ModeEngine::stage
//!                     │                                            │
//!                     ▼                                            ▼
//!            PreviewBatch (to TUI)              StagedFile[] ──> EditWriter (host)
//! ```
//! Engines are pure over [`files::FileSource`] (a read-through cache honoring
//! [`path_policy::PathPolicy`]) and [`store::EditStore`] (snapshots,
//! clipboard, no-op guard). Error strings are byte-identical to the
//! TypeScript implementation they replace; models are trained on them.

pub mod diff_string;
pub mod engine;
pub mod error;
pub mod files;
pub mod fuzzy;
pub mod modes;
pub mod notebook;
pub mod path_policy;
pub mod session;
pub mod store;
pub mod stream_json;
pub mod text;

pub use engine::{
	EditMode, FileOp, FileOpIntent, HeaderKind, Inspection, ModeEngine, PreviewFile, Resolved,
	StagedFile,
};
pub use error::{EditError, EditResult};
pub use path_policy::{PathPolicy, UrlResolution};
pub use session::{
	ApplyOutcome, ApplyRequest, EditWriter, FileOutcome, PreviewBatch, Session, WriteRequest,
	WriteResponse,
};
pub use store::EditStore;
pub use stream_json::{ArgSnapshot, ArgStream, EditEntry};

/// Prompt text for a mode (the tool description).
pub const fn description(mode: EditMode) -> &'static str {
	match mode {
		EditMode::Replace => include_str!("../prompts/replace.md"),
		EditMode::Patch => include_str!("../prompts/patch.md"),
		EditMode::ApplyPatch => include_str!("../prompts/apply_patch.md"),
		EditMode::Hashline => include_str!("../prompts/hashline.md"),
		EditMode::Sloppy => include_str!("../prompts/sloppy.md"),
	}
}

/// Lark grammar for modes that expose a custom (non-JSON) wire format.
pub const fn grammar(mode: EditMode) -> Option<&'static str> {
	match mode {
		EditMode::ApplyPatch => Some(include_str!("../grammars/apply_patch.lark")),
		EditMode::Hashline => Some(include_str!("../grammars/hashline.lark")),
		EditMode::Sloppy => Some(include_str!("../grammars/sloppy.lark")),
		EditMode::Replace | EditMode::Patch => None,
	}
}

#[cfg(test)]
mod tests {
	use super::{EditMode, description};

	/// The hashline prompt must accept every tool that hands the model a
	/// snapshot tag. A `write` mints a tag of its own and numbers the lines it
	/// wrote; a prompt that named only `read`/`search` would tell the model to
	/// discard that tag and read the file again.
	#[test]
	fn hashline_prompt_accepts_write_issued_tags() {
		let prompt = description(EditMode::Hashline);
		let tag_contract = prompt
			.lines()
			.find(|line| line.contains("`TAG`"))
			.expect("hashline prompt states the tag contract");
		for source in ["`read`", "`search`", "`write`"] {
			assert!(
				tag_contract.contains(source),
				"hashline prompt must accept {source} as a snapshot tag source"
			);
		}
	}
}
