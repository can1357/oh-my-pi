//! Mode-neutral engine contract.
//!
//! Every edit mode (`replace`, `patch`, `apply_patch`, `hashline`, `sloppy`)
//! implements [`ModeEngine`]: a pure, in-memory transformation from a parsed
//! argument snapshot plus target file contents into staged file states.
//! Nothing here touches the filesystem for writes; the [`crate::session`]
//! drives previews, staging, and the host writer callback.

use std::path::PathBuf;

use crate::{error::EditError, files::FileSource, store::EditStore, stream_json::ArgSnapshot};

/// The edit variants the tool exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EditMode {
	Replace,
	Patch,
	ApplyPatch,
	Hashline,
	Sloppy,
}

impl EditMode {
	/// Wire/settings name (`replace`, `patch`, `apply_patch`, `hashline`,
	/// `sloppy`).
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Replace => "replace",
			Self::Patch => "patch",
			Self::ApplyPatch => "apply_patch",
			Self::Hashline => "hashline",
			Self::Sloppy => "sloppy",
		}
	}

	/// Parse a wire/settings name.
	pub fn parse(name: &str) -> Option<Self> {
		Some(match name {
			"replace" => Self::Replace,
			"patch" => Self::Patch,
			"apply_patch" => Self::ApplyPatch,
			"hashline" => Self::Hashline,
			"sloppy" => Self::Sloppy,
			_ => return None,
		})
	}
}

/// What a staged file does to the filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOp {
	Create,
	Update,
	Delete,
	/// Parsed and applied cleanly but produced no change; nothing is written.
	Noop,
}

impl FileOp {
	/// Wire label (`create` / `update` / `delete`); `Noop` reports as `update`
	/// like the TypeScript result shape did.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Create => "create",
			Self::Update | Self::Noop => "update",
			Self::Delete => "delete",
		}
	}
}

/// A resolved edit target: the absolute filesystem path plus the display
/// path the model authored (after unique-suffix recovery, if any).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
	pub absolute: PathBuf,
	pub display:  String,
}

/// How the model-facing result header for a file is produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HeaderKind {
	/// `[<display>]`.
	#[default]
	Path,
	/// `[<display>#TAG]` where TAG hashes the text that actually landed on
	/// disk (hashline).
	HashlineTag,
}

/// One file's fully computed post-edit state, ready to be written.
#[derive(Debug, Clone)]
pub struct StagedFile {
	/// Display path as authored (after suffix / tag recovery).
	pub display:            String,
	/// Absolute target path.
	pub absolute:           PathBuf,
	pub op:                 FileOp,
	/// Destination for a rename (`*** Move to:` / hashline `MV`). The write
	/// request becomes a `move`; the result reports `Moved to <display>`.
	pub move_to:            Option<Resolved>,
	/// Whether the target existed before the edit.
	pub existed:            bool,
	/// Raw pre-edit bytes as text (BOM and line endings intact; notebook
	/// JSON). `None` for creates.
	pub before_raw:         Option<String>,
	/// LF-normalized, BOM-stripped pre-edit text (editable notebook text).
	pub before:             String,
	/// LF-normalized post-edit text. Equals `before` for `Noop`/`Delete`.
	pub after:              String,
	/// Bytes to persist: BOM + original line endings restored; notebook JSON
	/// serialized. `None` for `Delete`/`Noop`.
	pub persisted:          Option<String>,
	/// Diff reported in structured details (numbered `generate_diff_string`
	/// format for most modes; plain unified diff for `patch`/`apply_patch`).
	pub diff:               String,
	/// Numbered diff the model-facing compact preview is built from when it
	/// differs from `diff` (`patch`/`apply_patch`). `None` uses `diff`.
	pub preview_diff:       Option<String>,
	pub first_changed_line: Option<u32>,
	pub header:             HeaderKind,
	/// Lines rendered between the header and the preview (hashline block
	/// resolutions).
	pub before_preview:     Vec<String>,
	/// Lines rendered after the preview (sloppy recovery notes).
	pub after_preview:      Vec<String>,
	/// Rendered under a trailing `Warnings:` block.
	pub warnings:           Vec<String>,
	/// Replaces the whole rendered text (hashline no-op diagnostic).
	pub text_override:      Option<String>,
	/// Record a fresh snapshot of the written text in the store after the
	/// write lands (hashline) and warn when the persisted text drifted.
	pub record_snapshot:    bool,
	/// Clipboard state to publish once this file's write lands (hashline
	/// `CUT`/`PUT` registers).
	pub clipboard_after:    Option<crate::store::Clipboard>,
}

impl StagedFile {
	/// Minimal staged update; callers fill in the optional fields.
	pub fn new(display: impl Into<String>, absolute: PathBuf, op: FileOp) -> Self {
		Self {
			display: display.into(),
			absolute,
			op,
			move_to: None,
			existed: true,
			before_raw: None,
			before: String::new(),
			after: String::new(),
			persisted: None,
			diff: String::new(),
			preview_diff: None,
			first_changed_line: None,
			header: HeaderKind::Path,
			before_preview: Vec::new(),
			after_preview: Vec::new(),
			warnings: Vec::new(),
			text_override: None,
			record_snapshot: false,
			clipboard_after: None,
		}
	}
}

/// One file's streamed diff preview.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreviewFile {
	/// Display path as authored (after recovery when the engine resolved it).
	pub display:            String,
	pub diff:               Option<String>,
	pub first_changed_line: Option<u32>,
	/// Model-facing error text; mutually exclusive with `diff`.
	pub error:              Option<String>,
	pub op:                 Option<FileOp>,
	pub rename:             Option<String>,
}

/// Static projection of a payload (no filesystem access): target paths, the
/// per-file added-lines digest for stream matchers, and delete/move intents.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Inspection {
	/// Every path the payload targets, one entry per section (duplicates kept).
	pub paths:    Vec<String>,
	/// `(path, digest)` — the digest is the text the edit introduces into that
	/// file (added lines only, no patch grammar). Same-path sections merge.
	pub entries:  Vec<(String, String)>,
	/// Delete / move intents for the ACP permission gate.
	pub file_ops: Vec<FileOpIntent>,
}

/// A destructive file operation a payload declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOpIntent {
	Delete { path: String },
	Move { from: String, to: String },
}

/// A mode engine: pure functions over an argument snapshot.
pub trait ModeEngine: Send + Sync {
	fn mode(&self) -> EditMode;

	/// Per-file diff previews for a (possibly partial) payload. `streaming`
	/// is true while arguments are still arriving; engines trim the trailing
	/// partial section/line and never fail the whole preview on the trailing
	/// section's transient error.
	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Vec<PreviewFile>;

	/// Full parse + locate + apply in memory. All-or-nothing: any failure
	/// stages nothing. Multi-file payloads return one entry per file in
	/// payload order.
	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError>;

	/// Static projection of the payload (no file reads).
	fn inspect(&self, args: &ArgSnapshot) -> Inspection;
}
