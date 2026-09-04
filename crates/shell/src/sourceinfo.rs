//! Source info.

use std::{
	fmt::{self, Display},
	path::PathBuf,
	sync::Arc,
};

use crate::SourcePosition;

/// Source context.
#[derive(Clone, Debug, Default)]
pub struct SourceInfo {
	/// The name of the source.
	pub source: String,
	/// Optionally indicates a starting location after the beginning of the
	/// source. If `None`, the start is the beginning of the source.
	pub start:  Option<Arc<SourcePosition>>,
}

impl From<&str> for SourceInfo {
	fn from(source: &str) -> Self {
		Self { source: source.to_owned(), start: None }
	}
}

impl From<PathBuf> for SourceInfo {
	fn from(path: PathBuf) -> Self {
		Self { source: path.to_string_lossy().to_string(), start: None }
	}
}

impl Display for SourceInfo {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.source)?;

		if let Some(pos) = &self.start {
			write!(f, ":{},{}", pos.line, pos.column)?;
		}

		Ok(())
	}
}
