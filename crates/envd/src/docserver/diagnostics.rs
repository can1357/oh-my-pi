//! LSP diagnostic parsing and document-authority-specific filtering.

use omp_core::Str;
use omp_proto::lsp::{Diagnostic, Position, Range, Severity};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
struct LspRange {
	start: Position,
	end:   Position,
}

#[derive(Clone, Debug, Deserialize)]
struct LspDiagnostic {
	range:    LspRange,
	#[serde(default)]
	severity: Option<u64>,
	#[serde(default)]
	code:     Option<serde_json::Value>,
	message:  Str,
	#[serde(default)]
	source:   Option<Str>,
}

#[derive(Clone, Debug, Deserialize)]
struct PublishedDiagnostics {
	uri:         Str,
	#[serde(default)]
	version:     Option<i64>,
	#[serde(default)]
	diagnostics: Vec<LspDiagnostic>,
}

#[derive(Clone, Debug, Deserialize)]
struct PullDiagnostics {
	kind:  Str,
	#[serde(default)]
	items: Vec<LspDiagnostic>,
}

/// Parses an LSP push-diagnostics notification into canonical diagnostics.
pub fn parse_push(
	payload: &[u8],
	binding: &str,
) -> Result<(Str, Option<i64>, Vec<Diagnostic>), serde_json::Error> {
	let published: PublishedDiagnostics = serde_json::from_slice(payload)?;
	let diagnostics = normalize_lsp_items(&published.uri, binding, published.diagnostics);
	Ok((published.uri, published.version, diagnostics))
}

/// Parses a full LSP 3.17 pull-diagnostic report. Unchanged reports return
/// `None`.
pub fn parse_pull(
	uri: Str,
	payload: &[u8],
	binding: &str,
) -> Result<Option<Vec<Diagnostic>>, serde_json::Error> {
	let report: PullDiagnostics = serde_json::from_slice(payload)?;
	if report.kind.as_str() != "full" {
		return Ok(None);
	}
	Ok(Some(normalize_lsp_items(&uri, binding, report.items)))
}

fn normalize_lsp_items(uri: &Str, binding: &str, items: Vec<LspDiagnostic>) -> Vec<Diagnostic> {
	items
		.into_iter()
		.map(|item| Diagnostic {
			uri:      uri.clone(),
			range:    Range { start: item.range.start, end: item.range.end },
			severity: Severity::from_lsp(item.severity),
			message:  item.message,
			code:     item.code.and_then(code_string),
			source:   item.source.unwrap_or_else(|| Str::from(binding)),
		})
		.collect()
}

fn code_string(value: serde_json::Value) -> Option<Str> {
	match value {
		serde_json::Value::String(value) => Some(Str::from(value)),
		serde_json::Value::Number(value) => Some(Str::from(value.to_string())),
		_ => None,
	}
}

/// Removes diagnostics from orphan TypeScript files when their code requires a
/// project.
pub fn filter_orphan_typescript(diagnostics: &mut Vec<Diagnostic>, has_project_root: bool) {
	if has_project_root {
		return;
	}
	const ORPHAN_CODES: [&str; 7] = ["1375", "1378", "2307", "2580", "2591", "2792", "2867"];
	diagnostics.retain(|diagnostic| {
		let typescript = diagnostic.source.eq_ignore_ascii_case("typescript")
			|| diagnostic
				.source
				.to_ascii_lowercase()
				.contains("typescript");
		!typescript
			|| diagnostic
				.code
				.as_deref()
				.is_none_or(|code| !ORPHAN_CODES.contains(&code))
	});
}
