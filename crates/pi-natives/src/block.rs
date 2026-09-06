//! Resolve the syntactic block beginning on a source line (tree-sitter).

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct BlockRangeOptions {
	/// Source code to inspect.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
	/// 1-indexed source line the block must begin on.
	pub line: u32,
}

#[napi(object)]
pub struct BlockRange {
	/// 1-indexed inclusive first line of the resolved block.
	pub start_line: u32,
	/// 1-indexed inclusive last line of the resolved block.
	pub end_line:   u32,
}

impl From<pi_ast::block::BlockRange> for BlockRange {
	fn from(value: pi_ast::block::BlockRange) -> Self {
		Self { start_line: value.start_line, end_line: value.end_line }
	}
}

/// Find the outermost named tree-sitter node that begins on `options.line`.
///
/// Returns its 1-indexed inclusive line span, or `null` when the language is
/// unrecognized, the line is out of range / blank, no node begins on that line,
/// or the resolved subtree contains a syntax error.
#[napi]
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	pi_ast::block::block_range_at(pi_ast::block::BlockRangeOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
		line: options.line,
	})
	.map(|range| range.map(Into::into))
	.map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(object)]
pub struct NodeSpan {
	/// 1-indexed inclusive first line of the node.
	pub start_line: u32,
	/// 1-indexed inclusive last content line of the node.
	pub end_line:   u32,
	/// Tree-sitter grammar node kind (e.g. `attribute_item`, `function_item`).
	pub kind:       String,
}

impl From<pi_ast::block::NodeSpan> for NodeSpan {
	fn from(value: pi_ast::block::NodeSpan) -> Self {
		Self { start_line: value.start_line, end_line: value.end_line, kind: value.kind }
	}
}

/// Named-node chain containing `options.line`, innermost-first, excluding the
/// whole-file root.
///
/// Single-line nodes beginning on the line (attributes, decorators) come
/// first, followed by every enclosing construct. ERROR/MISSING recovery nodes
/// are skipped. Returns `null` when the language is unrecognized, the line is
/// out of range / blank, or the source fails to parse entirely.
#[napi]
pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
	pi_ast::block::node_chain_at(pi_ast::block::BlockRangeOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
		line: options.line,
	})
	.map(|chain| chain.map(|spans| spans.into_iter().map(Into::into).collect()))
	.map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(object)]
pub struct LineRange {
	/// 1-indexed inclusive first visible line.
	pub start_line: u32,
	/// 1-indexed inclusive last visible line.
	pub end_line:   u32,
}

#[napi(object)]
pub struct EnclosingBoundaryOptions {
	/// Source code to inspect.
	pub code:   String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:   Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:   Option<String>,
	/// 1-indexed inclusive visible line ranges (the lines actually shown).
	pub ranges: Vec<LineRange>,
}

/// Matching-bracket context for an arbitrary tree-sitter language.
///
/// For each multi-line named node whose span crosses the visible window, return
/// the boundary line sitting *outside* that window (the closer when the opener
/// is shown, the opener when the closer is shown). Covers brace and indentation
/// languages alike using real syntactic spans.
///
/// Returns `null` when the language is unrecognized or the source fails to
/// parse / carries a syntax error (caller should fall back to a lexical scan);
/// a sorted, unique list of 1-indexed boundary lines otherwise.
#[napi]
pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
	pi_ast::block::enclosing_block_boundaries(pi_ast::block::EnclosingBoundaryOptions {
		code:   options.code,
		lang:   options.lang,
		path:   options.path,
		ranges: options
			.ranges
			.into_iter()
			.map(|range| pi_ast::block::LineRange {
				start_line: range.start_line,
				end_line:   range.end_line,
			})
			.collect(),
	})
	.map_err(|error| Error::from_reason(error.to_string()))
}
