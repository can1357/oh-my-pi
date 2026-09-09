//! Error type shared by every edit engine.
//!
//! The `Display` output of each variant is the exact model-facing message the
//! TypeScript implementation threw; models are trained on these strings, so
//! engines must reproduce them byte-for-byte.

use std::path::PathBuf;

/// Failure raised while parsing, locating, staging, or writing an edit.
#[derive(Debug, thiserror::Error)]
pub enum EditError {
	/// The wire payload could not be parsed. `line` is the 1-indexed payload
	/// line when the parser knows it.
	#[error("{message}")]
	Parse { message: String, line: Option<u32> },
	/// The payload parsed but could not be applied (missing file, overlap,
	/// invalid op, auto-generated target, no-op, …).
	#[error("{0}")]
	Apply(String),
	/// A search anchor could not be located in the target text.
	#[error("{0}")]
	Match(String),
	/// Plan mode rejected a working-tree write.
	#[error("{0}")]
	Plan(String),
	/// Filesystem failure reading a target.
	#[error("{source}")]
	Io {
		path:   PathBuf,
		#[source]
		source: std::io::Error,
	},
	/// The host writer callback failed; carries its message verbatim.
	#[error("{0}")]
	Writer(String),
}

impl EditError {
	/// Parse failure without a line number.
	pub fn parse(message: impl Into<String>) -> Self {
		Self::Parse { message: message.into(), line: None }
	}

	/// Parse failure at a known payload line.
	pub fn parse_at(message: impl Into<String>, line: u32) -> Self {
		Self::Parse { message: message.into(), line: Some(line) }
	}

	/// Apply failure carrying a preformatted message.
	pub fn apply(message: impl Into<String>) -> Self {
		Self::Apply(message.into())
	}

	/// Match failure carrying a preformatted message.
	pub fn matched(message: impl Into<String>) -> Self {
		Self::Match(message.into())
	}

	/// Whether this is `File not found` (ENOENT) for the given path.
	pub fn is_not_found(&self) -> bool {
		matches!(self, Self::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
	}
}

/// Convenience alias used throughout the crate.
pub type EditResult<T> = Result<T, EditError>;
