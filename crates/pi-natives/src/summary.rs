//! Structural source summaries powered by tree-sitter.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct SummaryOptions {
	/// Source code to summarize.
	pub code:               String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:               Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:               Option<String>,
	/// Minimum total node lines before eliding a body/literal node.
	pub min_body_lines:     Option<u32>,
	/// Minimum total comment lines before eliding a multiline block comment.
	pub min_comment_lines:  Option<u32>,
	/// Target visible-line count for BFS unfold. `None` or `0` keeps only
	/// the outermost elisions (no progressive unfolding).
	pub unfold_until_lines: Option<u32>,
	/// Hard ceiling for BFS unfold. Defaults to `unfold_until_lines * 2`
	/// when omitted.
	pub unfold_limit_lines: Option<u32>,
}

#[napi(object)]
pub struct SummarySegment {
	/// "kept" or "elided".
	pub kind:       String,
	/// 1-based inclusive start line.
	pub start_line: u32,
	/// 1-based inclusive end line.
	pub end_line:   u32,
	/// Verbatim text for kept segments; absent for elided segments.
	pub text:       Option<String>,
}

#[napi(object)]
pub struct SummaryResult {
	/// Canonical language name when parsing succeeded.
	pub language:    Option<String>,
	/// True when tree-sitter parsed the source without syntax errors.
	pub parsed:      bool,
	/// True when at least one elision span was emitted.
	pub elided:      bool,
	/// Total source lines.
	pub total_lines: u32,
	/// Kept/elided segments in source order.
	pub segments:    Vec<SummarySegment>,
}

impl From<pi_ast::summary::SummarySegment> for SummarySegment {
	fn from(value: pi_ast::summary::SummarySegment) -> Self {
		Self {
			kind:       value.kind,
			start_line: value.start_line,
			end_line:   value.end_line,
			text:       value.text,
		}
	}
}

impl From<pi_ast::summary::SummaryResult> for SummaryResult {
	fn from(value: pi_ast::summary::SummaryResult) -> Self {
		Self {
			language:    value.language,
			parsed:      value.parsed,
			elided:      value.elided,
			total_lines: value.total_lines,
			segments:    value.segments.into_iter().map(Into::into).collect(),
		}
	}
}

#[napi]
pub fn summarize_code(options: SummaryOptions) -> Result<SummaryResult> {
	pi_ast::summary::summarize_code(pi_ast::summary::SummaryOptions {
		code:               options.code,
		lang:               options.lang,
		path:               options.path,
		min_body_lines:     options.min_body_lines,
		min_comment_lines:  options.min_comment_lines,
		unfold_until_lines: options.unfold_until_lines,
		unfold_limit_lines: options.unfold_limit_lines,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}
