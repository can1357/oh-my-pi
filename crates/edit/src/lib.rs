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

/// jsdiff-compatible diff algorithms.
pub mod diff;
/// Model-facing numbered and unified diff rendering.
pub mod diff_string;
/// Shared mode-engine contracts and staged-file types.
pub mod engine;
/// Edit error and result types.
pub mod error;
/// Read-only file-source abstractions and caching.
pub mod files;
/// Exact, normalized, and fuzzy matching helpers.
pub mod fuzzy;
/// Implementations of the five edit modes.
pub mod modes;
/// Notebook projection and serialization.
pub mod notebook;
/// Path resolution and write-policy enforcement.
pub mod path_policy;
/// Streaming preview, staging, and host-write orchestration.
pub mod session;
/// Snapshot, clipboard, and no-op state.
pub mod store;
/// Incremental JSON argument recovery.
pub mod stream_json;
/// Text normalization and UTF-16 helpers.
pub mod text;

pub use diff::{SpanEdit, span_edits};
pub use diff_string::{COLLAPSED_DIFF_ROWS, PinnedMyersWindow};
pub use engine::{
	EditMode, FileOp, FileOpIntent, HeaderKind, Inspection, ModeEngine, PreviewFile, Resolved,
	StagedFile,
};
pub use error::{EditError, EditResult};
pub use path_policy::PathPolicy;
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
