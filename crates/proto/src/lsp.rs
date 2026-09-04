//! Transport-neutral LSP-compatible value types shared across crate boundaries.
//!
//! The document authority, LSP tools, and envd wire projections consume these
//! values. They live in `omp-proto` because they cross the docserver/tools
//! boundary without carrying document-server runtime or parsing behavior.

use std::{
	collections::{HashMap, HashSet},
	fmt::{self, Display},
};

use omp_core::Str;
use serde::{Deserialize, Serialize};

/// LSP-compatible zero-based position.
#[derive(
	Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
pub struct Position {
	/// Zero-based line.
	pub line:      u32,
	/// Zero-based UTF code-unit offset, in the server's negotiated encoding.
	pub character: u32,
}

impl Display for Position {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}:{}", self.line, self.character)
	}
}

/// LSP-compatible half-open range.
#[derive(
	Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
pub struct Range {
	/// Inclusive start.
	pub start: Position,
	/// Exclusive end.
	pub end:   Position,
}

/// Normalized diagnostic severity, ordered most to least severe.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	strum::Display,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Severity {
	/// Compilation or analysis error.
	#[default]
	Error,
	/// Warning.
	Warning,
	/// Informational finding.
	Information,
	/// Hint.
	Hint,
}

impl Severity {
	/// Converts the LSP numeric severity, treating absent and unknown values as
	/// errors.
	pub const fn from_lsp(value: Option<u64>) -> Self {
		match value {
			Some(2) => Self::Warning,
			Some(3) => Self::Information,
			Some(4) => Self::Hint,
			_ => Self::Error,
		}
	}
}

/// A source-tagged diagnostic independent of its transport.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Diagnostic {
	/// Canonical file URI.
	pub uri:      Str,
	/// Zero-based range.
	pub range:    Range,
	/// Severity.
	pub severity: Severity,
	/// Human-readable message.
	pub message:  Str,
	/// Optional machine code.
	pub code:     Option<Str>,
	/// LSP server, checker, or linter name.
	pub source:   Str,
}

/// Position encodings supported by LSP 3.18.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PositionEncoding {
	/// Characters are counted as UTF-8 code units (bytes).
	Utf8,
	/// Characters are counted as UTF-16 code units.
	#[default]
	Utf16,
	/// Characters are counted as Unicode scalar values.
	Utf32,
}

impl PositionEncoding {
	/// Parses a negotiated LSP position encoding, defaulting unknown values to
	/// UTF-16.
	pub fn from_lsp_name(name: Option<&str>) -> Self {
		match name {
			Some("utf-8") => Self::Utf8,
			Some("utf-32") => Self::Utf32,
			_ => Self::Utf16,
		}
	}

	/// Returns the canonical LSP spelling of this encoding.
	pub const fn as_lsp_name(self) -> &'static str {
		match self {
			Self::Utf8 => "utf-8",
			Self::Utf16 => "utf-16",
			Self::Utf32 => "utf-32",
		}
	}
}

/// Deduplicates cross-source findings by range and message, preserving all
/// source names.
pub fn normalize(mut diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
	let mut positions = HashMap::<(Str, Range, Str), usize>::new();
	let mut output = Vec::<Diagnostic>::with_capacity(diagnostics.len());
	for diagnostic in diagnostics.drain(..) {
		let key = (diagnostic.uri.clone(), diagnostic.range, diagnostic.message.clone());
		if let Some(index) = positions.get(&key).copied() {
			let existing = &mut output[index];
			if !existing
				.source
				.split(",")
				.any(|source| source.trim() == diagnostic.source.as_str())
			{
				let mut sources = existing.source.as_str().split(", ").collect::<HashSet<_>>();
				sources.insert(diagnostic.source.as_str());
				let mut sources = sources.into_iter().collect::<Vec<_>>();
				sources.sort_unstable();
				existing.source = Str::from(sources.join(", "));
			}
			continue;
		}
		positions.insert(key, output.len());
		output.push(diagnostic);
	}
	output.sort_by(|left, right| {
		left
			.severity
			.cmp(&right.severity)
			.then_with(|| left.uri.cmp(&right.uri))
			.then_with(|| left.range.cmp(&right.range))
			.then_with(|| left.message.cmp(&right.message))
	});
	output
}
