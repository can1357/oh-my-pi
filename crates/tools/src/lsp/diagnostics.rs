//! Bounded diagnostics aggregation and model-visible projection.

use std::collections::BTreeMap;

use omp_core::{Str, StrMut};
use omp_proto::lsp::{Diagnostic, Severity, normalize};
use serde::{Deserialize, Serialize};

/// Maximum explicit file targets from one glob.
pub const MAX_GLOB_TARGETS: usize = 20;
/// Source-independent diagnostics result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DiagnosticResult {
	/// Normalized findings.
	pub diagnostics: Vec<Diagnostic>,
	/// Findings omitted by projection bounds.
	pub omitted:     usize,
	/// Whether every selected source completed.
	pub complete:    bool,
}

impl DiagnosticResult {
	/// Normalizes and sorts findings without applying a second tool-local
	/// output bound. The runtime owns inline projection and artifact spill.
	pub fn new(diagnostics: Vec<Diagnostic>, complete: bool) -> Self {
		Self { diagnostics: normalize(diagnostics), omitted: 0, complete }
	}
}

/// Renders source-tagged findings grouped by folded file path.
pub fn render(result: &DiagnosticResult) -> Str {
	if result.diagnostics.is_empty() {
		return if result.complete {
			Str::from("No diagnostics")
		} else {
			Str::from("No inline diagnostics; deferred collection continues")
		};
	}
	let mut grouped = BTreeMap::<&str, Vec<&Diagnostic>>::new();
	for diagnostic in &result.diagnostics {
		grouped
			.entry(diagnostic.uri.as_str())
			.or_default()
			.push(diagnostic);
	}
	let mut output = StrMut::new("");
	for (path, diagnostics) in grouped {
		output.push_str(path);
		output.push_str("\n");
		for diagnostic in diagnostics {
			output.push_str("  ");
			output.push_str(severity_icon(diagnostic.severity));
			output.push_str(" ");
			output.push_str((diagnostic.range.start.line + 1).to_string().as_str());
			output.push_str(":");
			output.push_str((diagnostic.range.start.character + 1).to_string().as_str());
			output.push_str(" [");
			output.push_str(&diagnostic.source);
			output.push_str("] ");
			output.push_str(&diagnostic.message);
			output.push_str("\n");
		}
	}
	output.freeze()
}

const fn severity_icon(severity: Severity) -> &'static str {
	match severity {
		Severity::Error => "error",
		Severity::Warning => "warning",
		Severity::Information => "info",
		Severity::Hint => "hint",
	}
}
