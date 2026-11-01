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
	/// The payload parsed but could not be applied for a reason no
	/// [`Rejection`] names (overlap, invalid op, auto-generated target, …).
	#[error("{0}")]
	Apply(String),
	/// The target is not valid UTF-8 and the operation needs its text.
	/// Existence-only operations (delete, create-existence checks) bypass
	/// decoding and never produce this.
	#[error("{display} is not valid UTF-8 at byte {valid_up_to}; refusing to edit")]
	InvalidUtf8 { display: String, valid_up_to: usize },
	/// A search anchor could not be located in the target text.
	#[error("{0}")]
	Match(String),
	/// Plan mode rejected a working-tree write.
	#[error("{0}")]
	Plan(String),
	/// An internal URL target has no host answer yet. Raised before any
	/// write, so the host can resolve the URL, `provide` it, and retry.
	#[error("Internal URL not resolved yet: {0}")]
	UnresolvedUrl(String),
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
	/// A check refused a payload that parsed; `reason` names the check.
	#[error("{message}")]
	Rejected { reason: Rejection, message: String },
	/// One file's failure in a multi-file call, which writes nothing.
	#[error("[{path}]: {source}\nNo files were modified — sections apply atomically.")]
	InFile { path: String, source: Box<Self> },
}

/// Which check refused an edit whose payload parsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
	/// The section's tag names an earlier version of the file.
	StaleTag,
	/// The tag was never issued in this session.
	UnknownTag,
	/// The tag was issued in this session for a different file.
	OtherFileTag,
	/// The header carries no tag, or a placeholder.
	MissingTag,
	/// A header with no ops under it.
	HeaderOnly,
	/// An op anchors on lines this session has not displayed whole.
	UnseenLines,
	/// An anchor lies past the end of the file.
	OutOfRange,
	/// A replacement's boundary rows leave where it lands undecided.
	AmbiguousBoundary,
	/// The edit leaves the file unchanged.
	NoChange,
	/// The target file does not exist.
	FileNotFound,
}

impl Rejection {
	/// The stable name hosts persist as the edit's `errorKind`.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::StaleTag => "stale_tag",
			Self::UnknownTag => "unknown_tag",
			Self::OtherFileTag => "other_file_tag",
			Self::MissingTag => "missing_tag",
			Self::HeaderOnly => "header_only",
			Self::UnseenLines => "unseen_lines",
			Self::OutOfRange => "out_of_range",
			Self::AmbiguousBoundary => "ambiguous_boundary",
			Self::NoChange => "no_change",
			Self::FileNotFound => "file_not_found",
		}
	}
}

impl EditError {
	/// Every value [`Self::kind`] returns.
	pub const KINDS: &[&str] = &[
		"parse",
		"apply",
		"invalid_utf8",
		"no_match",
		"plan_mode",
		"unresolved_url",
		"io",
		"write_failed",
		"stale_tag",
		"unknown_tag",
		"other_file_tag",
		"missing_tag",
		"header_only",
		"unseen_lines",
		"out_of_range",
		"ambiguous_boundary",
		"no_change",
		"file_not_found",
	];

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

	/// Refusal by a named check, carrying a preformatted message.
	pub fn rejected(reason: Rejection, message: impl Into<String>) -> Self {
		Self::Rejected { reason, message: message.into() }
	}

	/// Whether this rejects an undecodable target.
	pub const fn is_invalid_utf8(&self) -> bool {
		matches!(self, Self::InvalidUtf8 { .. })
	}

	/// Whether this is `File not found` (ENOENT) for the given path.
	pub fn is_not_found(&self) -> bool {
		matches!(self, Self::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
	}

	/// Stable class of this failure, which hosts record beside the message.
	pub fn kind(&self) -> &'static str {
		match self {
			Self::Parse { .. } => "parse",
			Self::Apply(_) => "apply",
			Self::InvalidUtf8 { .. } => "invalid_utf8",
			Self::Match(_) => "no_match",
			Self::Plan(_) => "plan_mode",
			Self::UnresolvedUrl(_) => "unresolved_url",
			Self::Io { .. } if self.is_not_found() => "file_not_found",
			Self::Io { .. } => "io",
			Self::Writer(_) => "write_failed",
			Self::Rejected { reason, .. } => reason.as_str(),
			Self::InFile { source, .. } => source.kind(),
		}
	}
}

/// Convenience alias used throughout the crate.
pub type EditResult<T> = Result<T, EditError>;

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use super::*;

	#[test]
	fn kinds_lists_exactly_what_kind_returns() {
		let rejections = [
			Rejection::StaleTag,
			Rejection::UnknownTag,
			Rejection::OtherFileTag,
			Rejection::MissingTag,
			Rejection::HeaderOnly,
			Rejection::UnseenLines,
			Rejection::OutOfRange,
			Rejection::AmbiguousBoundary,
			Rejection::NoChange,
			Rejection::FileNotFound,
		];
		// No wildcard: a new variant has to be added to `rejections` above.
		for reason in rejections {
			match reason {
				Rejection::StaleTag
				| Rejection::UnknownTag
				| Rejection::OtherFileTag
				| Rejection::MissingTag
				| Rejection::HeaderOnly
				| Rejection::UnseenLines
				| Rejection::OutOfRange
				| Rejection::AmbiguousBoundary
				| Rejection::NoChange
				| Rejection::FileNotFound => {},
			}
		}
		let io = |kind| EditError::Io { path: "a".into(), source: std::io::Error::from(kind) };
		let mut errors = vec![
			EditError::parse("x"),
			EditError::apply("x"),
			EditError::InvalidUtf8 { display: "a".into(), valid_up_to: 0 },
			EditError::matched("x"),
			EditError::Plan("x".into()),
			EditError::UnresolvedUrl("x".into()),
			io(std::io::ErrorKind::NotFound),
			io(std::io::ErrorKind::PermissionDenied),
			EditError::Writer("x".into()),
			EditError::InFile { path: "a".into(), source: Box::new(EditError::apply("x")) },
		];
		errors.extend(rejections.map(|reason| EditError::rejected(reason, "x")));
		let returned: BTreeSet<_> = errors.iter().map(EditError::kind).collect();
		let listed: BTreeSet<_> = EditError::KINDS.iter().copied().collect();
		assert_eq!(listed.len(), EditError::KINDS.len());
		assert_eq!(returned, listed);
	}
}
