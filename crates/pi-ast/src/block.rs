//! Resolve the syntactic block that begins on a given source line.
//!
//! Powers the hashline `replace block N:` operator: given a 1-indexed line,
//! parse the source with tree-sitter and return the line span of the outermost
//! named node that *begins* on that line (excluding the whole-file root). Brace
//! languages anchor a construct's block to its opening line, so pointing at the
//! line that opens an `if` / `function` / `struct` resolves to that construct's
//! full span; pointing at a continuation line or a lone closing delimiter
//! resolves to nothing.

use std::collections::BTreeSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::{Point, TreeCursor};

use crate::{
	parse_cache::parse_cached,
	summary::{node_content_end_line, node_start_line, resolve_language},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockRange {
	/// 1-indexed inclusive first line of the resolved block.
	pub start_line: u32,
	/// 1-indexed inclusive last line of the resolved block.
	pub end_line:   u32,
}

/// Count of leading space/tab bytes on `row` (0-indexed), i.e. the byte column
/// of the first content character. Returns `None` when `row` is out of range
/// or the line is blank / whitespace-only — there is no block to resolve there.
fn first_content_column(code: &str, row: usize) -> Option<usize> {
	let line = code.split('\n').nth(row)?;
	for (col, byte) in line.bytes().enumerate() {
		if byte != b' ' && byte != b'\t' {
			return Some(col);
		}
	}
	None
}

/// Resolve the block beginning on `options.line`.
///
/// Returns `None` (a soft "no block here", surfaced as a hard error one layer
/// up) when the language is unrecognized, the line is out of range / blank, no
/// node begins on that line, or the resolved subtree contains a syntax error.
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};

	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();

	// Query a one-column-wide range over the first content character rather
	// than a zero-width point. Some grammars (e.g. tree-sitter-swift) insert a
	// zero-width separator node at the start of a statement that follows a
	// blank line. An empty point range at that node's start gets absorbed into
	// the invisible node, which has no children and is not "relevant", so
	// `named_descendant_for_point_range` bubbles back up to the last visible
	// ancestor (the enclosing body, or the file root). That made `replace
	// block` on a line like `var body: some View {` preceded by a blank line
	// resolve to the whole enclosing type body and then fail. Spanning the
	// first character skips the zero-width node (its end is < the range end)
	// and forces the descent into the node that begins on `row`.
	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
		return Ok(None);
	};
	// A leaf whose own start row is earlier than `row` means `point` landed on
	// a continuation line or a closing delimiter of a block that opened earlier
	// — there is no block *beginning* on line N.
	if leaf.start_position().row != row {
		return Ok(None);
	}
	// Climb to the outermost named ancestor that still begins on `row`,
	// excluding the whole-file root. Ancestors can only begin on an earlier
	// row, so the first parent that starts before `row` stops the climb.
	let mut node = leaf;
	while let Some(parent) = node.parent() {
		if parent.id() == root.id() {
			break;
		}
		if parent.start_position().row != row {
			break;
		}
		node = parent;
	}
	// Refuse degenerate error-recovery spans: a missing brace can make
	// tree-sitter wrap a huge region in an ERROR node. Checking only the
	// resolved node's subtree (not the whole file) keeps an unrelated syntax
	// error elsewhere from disabling the feature.
	if node.has_error() {
		return Ok(None);
	}
	Ok(Some(BlockRange {
		start_line: node_start_line(node),
		end_line:   node_content_end_line(node),
	}))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineRange {
	/// 1-indexed inclusive first visible line.
	pub start_line: u32,
	/// 1-indexed inclusive last visible line.
	pub end_line:   u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Sort, drop invalid, and merge adjacent/overlapping ranges so visibility
/// tests can binary-search a non-overlapping list.
fn normalize_ranges(mut ranges: Vec<LineRange>) -> Vec<LineRange> {
	ranges.retain(|range| range.start_line > 0 && range.end_line >= range.start_line);
	ranges.sort_by(|a, b| {
		a.start_line
			.cmp(&b.start_line)
			.then(a.end_line.cmp(&b.end_line))
	});
	let mut merged: Vec<LineRange> = Vec::with_capacity(ranges.len());
	for range in ranges {
		if let Some(last) = merged.last_mut()
			&& range.start_line <= last.end_line.saturating_add(1)
		{
			last.end_line = last.end_line.max(range.end_line);
			continue;
		}
		merged.push(range);
	}
	merged
}

fn is_visible(merged: &[LineRange], line: u32) -> bool {
	merged
		.binary_search_by(|range| {
			if line < range.start_line {
				std::cmp::Ordering::Greater
			} else if line > range.end_line {
				std::cmp::Ordering::Less
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.is_ok()
}

/// Does any visible line fall inside the inclusive line span `[start, end]`?
fn intersects_visible(merged: &[LineRange], start: u32, end: u32) -> bool {
	// `merged` is sorted and non-overlapping, so the first range that can
	// possibly overlap is the first one whose `end_line` reaches `start`.
	let idx = merged.partition_point(|range| range.end_line < start);
	merged.get(idx).is_some_and(|range| range.start_line <= end)
}

/// Depth-first walk collecting boundary lines from every multi-line named node
/// that straddles a visible-range edge. A single reused [`TreeCursor`] keeps
/// the traversal allocation-free.
fn collect_boundaries(cursor: &mut TreeCursor<'_>, merged: &[LineRange], out: &mut BTreeSet<u32>) {
	let node = cursor.node();
	// Prune whole subtrees that cannot contribute. A node contributes only when
	// one of its own endpoint lines is visible, and both of those lines lie
	// inside its raw row span; every descendant's span is contained in this
	// one, so a span holding no visible line rules out this node *and*
	// everything beneath it. Without the prune the walk is O(nodes in file)
	// even though the answer is bounded by the window size — which made the
	// traversal cost roughly twice the parse on a large file.
	let raw_start = node.start_position().row.saturating_add(1) as u32;
	let raw_end = node.end_position().row.saturating_add(1) as u32;
	if !intersects_visible(merged, raw_start, raw_end) {
		return;
	}
	// Skip the whole-file root: its only "boundary" is EOF, never a useful
	// matching line (mirrors `block_range_at` excluding the root).
	if node.is_named() && node.parent().is_some() {
		let start = node_start_line(node);
		let end = node_content_end_line(node);
		if end > start {
			let start_visible = is_visible(merged, start);
			let end_visible = is_visible(merged, end);
			// Opener shown, closer off-window → surface the closer (and vice
			// versa). A node fully inside or fully outside the window adds
			// nothing.
			if start_visible && !end_visible {
				out.insert(end);
			} else if end_visible && !start_visible {
				out.insert(start);
			}
		}
	}
	if cursor.goto_first_child() {
		loop {
			collect_boundaries(cursor, merged, out);
			if !cursor.goto_next_sibling() {
				break;
			}
		}
		cursor.goto_parent();
	}
}

/// Generalize "show the matching bracket" to every tree-sitter block: for each
/// multi-line named node whose span crosses the visible window, return the
/// boundary line sitting *outside* that window.
///
/// - node opens on a visible line but closes past the window → its closing line
/// - node closes on a visible line but opens before the window → its opening
///   line
///
/// Because the trigger is an endpoint *inside* the window, the result is
/// bounded by the window size (not nesting depth), exactly like a bracket scan
/// — but it also covers indentation languages (Python) and uses real syntactic
/// spans.
///
/// Returns `None` when the language is unrecognized or the source fails to
/// parse / carries a syntax error (caller falls back to a lexical bracket
/// scan); `Some(sorted unique boundary lines)` otherwise (possibly empty).
pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
	let EnclosingBoundaryOptions { code, lang, path, ranges } = options;
	let merged = normalize_ranges(ranges);
	if code.is_empty() || merged.is_empty() {
		return Ok(Some(Vec::new()));
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();
	// A file-level syntax error makes error-recovery spans unreliable; defer to
	// the lexical scanner rather than emit boundaries off a broken tree.
	if root.has_error() {
		return Ok(None);
	}

	let mut boundaries = BTreeSet::new();
	let mut cursor = root.walk();
	collect_boundaries(&mut cursor, &merged, &mut boundaries);
	Ok(Some(boundaries.into_iter().collect()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeSpan {
	/// 1-indexed inclusive first line of the node.
	pub start_line: u32,
	/// 1-indexed inclusive last content line of the node.
	pub end_line:   u32,
	/// Tree-sitter grammar node kind (e.g. `attribute_item`, `function_item`).
	pub kind:       String,
}

/// Named-node chain containing `options.line`, innermost-first, excluding the
/// whole-file root.
///
/// The chain descends through the line's first content character, so
/// single-line nodes beginning on the line (attributes, decorators, one-line
/// statements) come first, followed by every enclosing construct up to — but
/// not including — the file root. Callers use it to classify a line by grammar
/// node kind and to enumerate enclosing construct end lines.
///
/// ERROR and MISSING recovery nodes are skipped rather than failing the whole
/// chain: an unrelated syntax error elsewhere in the file leaves healthy
/// ancestors' spans meaningful.
///
/// Returns `None` when the language is unrecognized, the line is out of
/// range / blank, or the source fails to parse entirely.
pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();
	// One-column-wide range for the same zero-width-node reason as
	// `block_range_at` above.
	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
		return Ok(None);
	};
	let mut chain = Vec::new();
	let mut node = Some(leaf);
	while let Some(current) = node {
		if current.id() == root.id() {
			break;
		}
		if current.is_named() && !current.is_error() && !current.is_missing() {
			chain.push(NodeSpan {
				start_line: node_start_line(current),
				end_line:   node_content_end_line(current),
				kind:       current.kind().to_string(),
			});
		}
		node = current.parent();
	}
	Ok(Some(chain))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn resolve(code: &str, path: &str, line: u32) -> Option<BlockRange> {
		block_range_at(BlockRangeOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
			line,
		})
		.expect("block resolution succeeds")
	}

	fn chain(code: &str, path: &str, line: u32) -> Vec<NodeSpan> {
		node_chain_at(BlockRangeOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
			line,
		})
		.expect("chain resolution succeeds")
		.expect("language recognized and line non-blank")
	}

	const RUST_ANNOTATED: &str = "mod m {\n   impl S {\n      #[napi]\n      fn f(&self) -> u32 \
	                              {\n         1\n      }\n   }\n}\n";

	/// A consumer classifying an attribute row must find a single-line
	/// `attribute_item` in the chain at that line.
	#[test]
	fn chain_names_rust_attribute_row() {
		let spans = chain(RUST_ANNOTATED, "x.rs", 3);
		assert!(
			spans
				.iter()
				.any(|s| s.kind == "attribute_item" && s.start_line == 3 && s.end_line == 3),
			"{spans:?}"
		);
	}

	/// A consumer relocating past enclosing constructs needs the chain at a
	/// construct's opening line to carry every enclosing end line,
	/// innermost-first. Wrapper nodes (`block`, `declaration_list`) share end
	/// lines with their construct; consumers dedupe.
	#[test]
	fn chain_orders_enclosing_ends_innermost_first() {
		let spans = chain(RUST_ANNOTATED, "x.rs", 4);
		let mut ends: Vec<u32> = spans
			.iter()
			.filter(|s| s.end_line > 4)
			.map(|s| s.end_line)
			.collect();
		ends.dedup();
		// fn f ends on 6, impl on 7, mod on 8.
		assert_eq!(ends, vec![6, 7, 8]);
	}

	/// TypeScript decorators are children of the declaration they precede; the
	/// chain at the decorator line must still surface the single-line
	/// `decorator` node.
	#[test]
	fn chain_names_ts_decorator_row() {
		let code = "/** d */\n@Injectable()\nclass Service {}\n";
		let spans = chain(code, "x.ts", 2);
		assert!(
			spans
				.iter()
				.any(|s| s.kind == "decorator" && s.start_line == 2 && s.end_line == 2),
			"{spans:?}"
		);
	}

	/// Blank lines carry no chain; unknown languages resolve to `None`.
	#[test]
	fn chain_declines_blank_lines_and_unknown_languages() {
		let blank = node_chain_at(BlockRangeOptions {
			code: "a\n\nb\n".to_string(),
			lang: None,
			path: Some("x.ts".to_string()),
			line: 2,
		})
		.unwrap();
		assert_eq!(blank, None);
		let unknown = node_chain_at(BlockRangeOptions {
			code: "a\n".to_string(),
			lang: None,
			path: Some("x.unknownext".to_string()),
			line: 1,
		})
		.unwrap();
		assert_eq!(unknown, None);
	}

	const TS_EXAMPLE: &str = "function x() {\n  if (y) {\n  }\n}\n";

	#[test]
	fn resolves_inner_if_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_enclosing_function_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 1), Some(BlockRange { start_line: 1, end_line: 4 }));
	}

	#[test]
	fn lone_closing_brace_resolves_to_nothing() {
		// Line 3 is `  }` — the closing delimiter of a block that opened on an
		// earlier line, so no block *begins* there.
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 3), None);
	}

	#[test]
	fn blank_line_resolves_to_nothing() {
		let code = "function x() {\n\n  return 1;\n}\n";
		assert_eq!(resolve(code, "x.ts", 2), None);
	}

	#[test]
	fn out_of_range_line_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 99), None);
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 0), None);
	}

	#[test]
	fn unrecognized_extension_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.unknownext", 2), None);
	}

	#[test]
	fn resolves_zsh_if_block_in_extensionless_rc_file() {
		// Regression: an extensionless shell rc file (`zshrc`/`.zshrc`) must
		// infer the bash grammar so `replace block` / `insert after block`
		// works. Previously `Path::extension` returned `None`, leaving block
		// ops permanently unresolvable on these files.
		let code = "ZSH_COMPDUMP=x\nif [[ -f \"$ZSH_COMPDUMP\" ]]; then\n  compinit -C\nelse\n  \
		            compinit\nfi\n";
		let span = Some(BlockRange { start_line: 2, end_line: 6 });
		assert_eq!(resolve(code, "modules/zsh/zshrc", 2), span);
		assert_eq!(resolve(code, ".zshrc", 2), span);
		assert_eq!(resolve(code, "/home/u/.bashrc", 2), span);
	}

	#[test]
	fn resolves_top_level_python_def() {
		let code = "x = 1\ndef greet():\n    return 1\n";
		assert_eq!(resolve(code, "g.py", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_inner_python_block() {
		// Point at the `for` loop inside the function body. The suite's first
		// statement is `total = 0` (line 2), so the `for` at line 3 is not the
		// suite's first child and climbs only to the `for_statement`, not the
		// whole function suite.
		let code =
			"def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
		assert_eq!(resolve(code, "f.py", 3), Some(BlockRange { start_line: 3, end_line: 4 }));
	}

	#[test]
	fn resolves_nested_block_to_outermost_on_line() {
		// Point at the inner `if` line; it resolves the whole `if` block
		// (header through its closing brace), not just the call inside it.
		let code = "function f() {\n  if (a) {\n    g();\n  }\n}\n";
		assert_eq!(resolve(code, "f.ts", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}

	#[test]
	fn multi_statement_line_resolves_first_statement_node() {
		// `let a = 1; let b = 2;` — pointing at the line resolves the first
		// statement that begins at the line's first content column.
		let code = "let a = 1; let b = 2;\n";
		let range = resolve(code, "m.ts", 1);
		assert!(range.is_some(), "expected a block on a single-statement-bearing line");
		assert_eq!(range.unwrap().start_line, 1);
	}

	#[test]
	fn continuation_line_resolves_to_nothing() {
		// A bare argument-continuation line whose first content does not open a
		// new named node beginning on that row.
		let code = "foo(\n  a,\n  b,\n);\n";
		// Line 2 (`  a,`) is an argument — `a` is an identifier beginning on the
		// row, so it DOES resolve. Use the closing `);` line instead, which is
		// a continuation/closer of the call begun earlier.
		assert_eq!(resolve(code, "c.ts", 4), None);
	}

	#[test]
	fn error_subtree_resolves_to_nothing() {
		// Missing closing brace: the function's subtree carries an ERROR, so we
		// refuse to resolve a degenerate recovery span.
		let code = "function broken() {\n  if (y) {\n}\n";
		assert_eq!(resolve(code, "b.ts", 1), None);
	}

	#[test]
	fn resolves_rust_struct_block() {
		let code = "struct A;\nstruct B {\n    x: u32,\n}\n";
		assert_eq!(resolve(code, "r.rs", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}

	#[test]
	fn resolves_swift_computed_property_after_blank_line() {
		// Regression: a block whose opening line is preceded by a blank line
		// (here the SwiftUI `var body: some View {` computed property) used to
		// resolve to nothing. tree-sitter-swift inserts a zero-width separator
		// node at the start of a statement that follows a blank line; a
		// zero-width point query at the first content column gets absorbed into
		// that invisible node and bubbles back up to the enclosing type body. A
		// one-column-wide query skips the zero-width node and descends into the
		// property that actually begins on the line.
		let code = "struct MenuBarUsage: View {\n    let metric: AccountMetric\n\n    var body: \
		            some View {\n        VStack {\n            Text(\"Usage\")\n        }\n    \
		            }\n}\n";
		assert_eq!(
			resolve(code, "MenuBarUsage.swift", 4),
			Some(BlockRange { start_line: 4, end_line: 8 })
		);
	}

	#[test]
	fn resolves_swift_top_level_decl_after_blank_line() {
		// Same zero-width-separator regression one level up: a top-level
		// declaration following a blank line. Without the fix the query
		// resolved to the whole `source_file` root and was rejected.
		let code = "import Foundation\n\nfunc greet() {\n    print(\"hi\")\n}\n";
		assert_eq!(resolve(code, "g.swift", 3), Some(BlockRange { start_line: 3, end_line: 5 }));
	}

	#[test]
	fn resolves_emacs_lisp_defun_block() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n";
		assert_eq!(resolve(code, "init.el", 1), Some(BlockRange { start_line: 1, end_line: 3 }));
	}
	#[test]
	fn resolves_emacs_lisp_dot_emacs_block() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n";
		assert_eq!(resolve(code, ".emacs", 1), Some(BlockRange { start_line: 1, end_line: 3 }));
	}

	#[test]
	fn resolves_emacs_lisp_macro_style_list_block() {
		let code = "(ert-deftest ogent-zen-test ()\n  \"Doc.\"\n  (should t))\n";
		assert_eq!(
			resolve(code, "test/ogent-zen-tests.el", 1),
			Some(BlockRange { start_line: 1, end_line: 3 })
		);
	}

	#[test]
	fn emacs_lisp_closing_paren_resolves_to_nothing() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name)\n)\n";
		assert_eq!(resolve(code, "init.el", 4), None);
	}

	#[test]
	fn emacs_lisp_visible_opener_surfaces_closer() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (let ((message (format \"Hello %s\" \
		            name)))\n    (message \"%s\" message))\n)\n";
		assert_eq!(boundaries(code, "init.el", &[(1, 1)]), Some(vec![5]));
	}

	#[test]
	fn emacs_lisp_top_level_macro_forms_resolve_as_single_sexprs() {
		let cases = [
			(
				"use-package",
				"(use-package magit\n  :commands (magit-status)\n  :config\n  (setq \
				 magit-save-repository-buffers nil))\n",
				4,
			),
			(
				"with-eval-after-load",
				"(with-eval-after-load 'org\n  (setq org-startup-indented t)\n  (add-hook \
				 'org-mode-hook #'visual-line-mode))\n",
				3,
			),
			(
				"pcase",
				"(pcase major-mode\n  ('emacs-lisp-mode\n   (message \"elisp\"))\n  (_\n   (message \
				 \"other\")))\n",
				5,
			),
		];

		for (name, code, end_line) in cases {
			assert_eq!(
				resolve(code, "init.el", 1),
				Some(BlockRange { start_line: 1, end_line }),
				"{name}"
			);
		}
	}

	#[test]
	fn resolves_emacs_lisp_explicit_language_block() {
		let result = block_range_at(BlockRangeOptions {
			code: "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n".to_string(),
			lang: Some("emacs-lisp".to_string()),
			path: None,
			line: 1,
		})
		.expect("block resolution succeeds");
		assert_eq!(result, Some(BlockRange { start_line: 1, end_line: 3 }));
	}

	fn boundaries(code: &str, path: &str, ranges: &[(u32, u32)]) -> Option<Vec<u32>> {
		enclosing_block_boundaries(EnclosingBoundaryOptions {
			code:   code.to_string(),
			lang:   None,
			path:   Some(path.to_string()),
			ranges: ranges
				.iter()
				.map(|&(start_line, end_line)| LineRange { start_line, end_line })
				.collect(),
		})
		.expect("boundary resolution succeeds")
	}

	const TS_FN: &str = "function outer() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  \
	                     return a + b + c;\n}\nafter();\n";

	#[test]
	fn surfaces_closing_brace_for_visible_opener() {
		// Window is the opening line only; its block closes on line 6.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), Some(vec![6]));
	}

	#[test]
	fn surfaces_opening_brace_for_visible_closer() {
		// Window is the closing line only; its block opens on line 1.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
	}

	#[test]
	fn interior_only_window_adds_no_boundary() {
		// Neither the opener (1) nor the closer (6) is visible, so the bracket
		// scan would add nothing — and neither do we.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
	}

	#[test]
	fn whole_file_window_adds_no_boundary() {
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 7)]), Some(vec![]));
	}

	#[test]
	fn python_indentation_block_uses_syntactic_span() {
		// Python has no closing delimiter — the def's span ends at the last
		// body line. Showing the `def` header surfaces that end line.
		let code = "def greet(name):\n    a = 1\n    b = 2\n    return a + b\n";
		assert_eq!(boundaries(code, "g.py", &[(1, 1)]), Some(vec![4]));
	}

	#[test]
	fn syntax_error_falls_back_to_none() {
		let code = "function broken() {\n  if (y) {\n";
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None);
	}

	#[test]
	fn unrecognized_language_falls_back_to_none() {
		assert_eq!(boundaries(TS_FN, "x.unknownext", &[(1, 1)]), None);
	}

	const MD_DOC: &str = "# H1\nintro\n\n## H2 alpha\nbody a\nmore a\n\n### H3 deep\ndeep \
	                      body\n\n## H2 beta\nbody b\n";

	#[test]
	fn resolves_markdown_h2_to_whole_section() {
		// tree-sitter-md nests the heading and its body (including deeper
		// subsections) in one `section` node, so anchoring the `## H2 alpha`
		// line (4) resolves the whole section — heading through the nested
		// `### H3 deep` and its trailing blank, up to the next `## H2 beta`.
		assert_eq!(resolve(MD_DOC, "plan.md", 4), Some(BlockRange { start_line: 4, end_line: 10 }));
	}

	#[test]
	fn resolves_markdown_h3_to_its_subsection() {
		// A deeper heading resolves only its own subsection, not the enclosing
		// `## H2` — the `### H3 deep` section spans line 8 through its body.
		assert_eq!(resolve(MD_DOC, "plan.md", 8), Some(BlockRange { start_line: 8, end_line: 10 }));
	}

	#[test]
	fn resolves_markdown_h1_to_whole_document_section() {
		// The top-level heading owns every nested section, so `# H1` resolves
		// the entire document body.
		assert_eq!(resolve(MD_DOC, "plan.md", 1), Some(BlockRange { start_line: 1, end_line: 12 }));
	}

	#[test]
	fn markdown_blank_line_resolves_to_nothing() {
		// A blank separator line opens no section.
		assert_eq!(resolve(MD_DOC, "plan.md", 3), None);
	}

	// ── parse cache ───────────────────────────────────────────────────────────
	//
	// These cover the process-global cache end to end. The cache is shared with
	// the rest of this crate's suite running in parallel, so nothing here
	// asserts on occupancy or counters — only on boundary values, which must
	// come out identical no matter what else happens to be resident. Occupancy,
	// eviction, and LRU order are asserted deterministically on private `Cache`
	// instances in `parse_cache::tests`.

	use crate::parse_cache::{MAX_ENTRIES, clear_parse_cache};

	#[test]
	fn repeat_query_yields_identical_boundaries() {
		clear_parse_cache();
		let first = boundaries(TS_FN, "x.ts", &[(1, 1)]);
		let second = boundaries(TS_FN, "x.ts", &[(1, 1)]);

		assert_eq!(first, Some(vec![6]));
		assert_eq!(second, first, "identical input must yield identical boundaries");

		// A different window over the same bytes must still be answered per
		// window: the cache holds the tree, not the boundary list, which is why
		// a result cache would not have worked.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
		assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), first);
	}

	#[test]
	fn same_bytes_under_two_languages_do_not_share_a_tree() {
		// Valid Python, a syntax error as TypeScript. If the language were not
		// part of the cache key, whichever call ran first would answer for both.
		let code = "def greet(name):\n    a = 1\n    return a\n";

		clear_parse_cache();
		let py_cold = boundaries(code, "x.py", &[(1, 1)]);
		clear_parse_cache();
		let ts_cold = boundaries(code, "x.ts", &[(1, 1)]);
		assert_eq!(py_cold, Some(vec![3]));
		assert_eq!(ts_cold, None);

		clear_parse_cache();
		assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
		assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);

		// Reverse order, to rule out an order-dependent answer.
		clear_parse_cache();
		assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);
		assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
	}

	#[test]
	fn single_byte_difference_yields_different_boundaries() {
		// Equal length, one byte apart: the second form replaces the newline
		// after `a()` with `;`, folding four lines into three. The `len` field in
		// the cache key cannot separate these — only the content hash and the
		// verified byte comparison can.
		let four_lines = "function f() {\n  a()\n  b()\n}\n";
		let three_lines = "function f() {\n  a();  b()\n}\n";
		assert_eq!(four_lines.len(), three_lines.len(), "fixtures must be equal length");
		assert_eq!(
			four_lines
				.bytes()
				.zip(three_lines.bytes())
				.filter(|(a, b)| a != b)
				.count(),
			1,
			"fixtures must differ by exactly one byte"
		);

		clear_parse_cache();
		assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
		assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
		// Again with both resident, in the opposite order.
		assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
		assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
	}

	#[test]
	fn syntax_error_stays_none_across_repeat_calls() {
		// The error tree *is* cached, so repeated "does this parse" probes get
		// the speedup too; `None` comes from the caller's own `has_error()` check
		// reading that tree, not from refusing to cache it.
		let code = "function broken() {\n  if (y) {\n";
		clear_parse_cache();
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "first call");
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "second call");
		assert_eq!(boundaries(code, "b.ts", &[(1, 2)]), None, "different window, still none");
	}

	#[test]
	fn cached_error_tree_matches_uncached_verdicts_for_both_callers() {
		// `enclosing_block_boundaries` rejects any file-level error;
		// `block_range_at` rejects only errors inside the resolved subtree. Both
		// now read that verdict off one shared cached tree, so each must still
		// reach the answer it reached from its own cold parse.
		let code = "function ok() {\n  a();\n}\nfunction broken( {\n";

		clear_parse_cache();
		let cold_boundaries = boundaries(code, "x.ts", &[(1, 1)]);
		clear_parse_cache();
		let cold_range = resolve(code, "x.ts", 1);
		assert_eq!(cold_boundaries, None, "a file-level error disables boundaries");

		clear_parse_cache();
		for pass in 0..2 {
			assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), cold_boundaries, "pass {pass}");
			assert_eq!(resolve(code, "x.ts", 1), cold_range, "pass {pass}");
		}
	}

	#[test]
	fn keys_evicted_past_the_cache_bound_still_answer_correctly() {
		// `f{i}` with `i + 1` body lines closes on line `i + 3`, so the expected
		// boundary for a window on line 1 is a function of `i` — a neighbouring
		// entry's tree would produce a visibly wrong answer.
		let sources: Vec<String> = (0..MAX_ENTRIES * 2)
			.map(|i| format!("function f{i}() {{\n{}}}\n", "  step();\n".repeat(i + 1)))
			.collect();
		let expect = |i: usize| Some(vec![i as u32 + 3]);

		clear_parse_cache();
		for (i, source) in sources.iter().enumerate() {
			assert_eq!(boundaries(source, "x.ts", &[(1, 1)]), expect(i), "cold pass {i}");
		}

		// Source 0 was evicted well before the loop ended (twice `MAX_ENTRIES`
		// distinct sources went through a cache holding `MAX_ENTRIES`), so this
		// re-parses. It must answer correctly rather than serve a survivor.
		assert_eq!(boundaries(&sources[0], "x.ts", &[(1, 1)]), expect(0), "evicted key");
		// And the tail, still resident, must not have been disturbed.
		let last = sources.len() - 1;
		assert_eq!(boundaries(&sources[last], "x.ts", &[(1, 1)]), expect(last), "resident key");
	}

	// ── prune equivalence ─────────────────────────────────────────────────────
	//
	// `collect_boundaries` skips subtrees whose raw line span holds no visible
	// line. That is argued to be exact, but the output feeds hashline block
	// resolution, so a silently dropped line corrupts edits rather than just
	// degrading display. The argument is therefore backed by a differential
	// against the pre-prune traversal over the repository's own sources, not by
	// hand-written expectations.

	use std::path::{Path, PathBuf};

	/// The pre-prune traversal, kept verbatim as the differential reference: it
	/// visits every node in the tree.
	fn collect_boundaries_unpruned(
		cursor: &mut TreeCursor<'_>,
		merged: &[LineRange],
		out: &mut BTreeSet<u32>,
	) {
		let node = cursor.node();
		if node.is_named() && node.parent().is_some() {
			let start = node_start_line(node);
			let end = node_content_end_line(node);
			if end > start {
				let start_visible = is_visible(merged, start);
				let end_visible = is_visible(merged, end);
				if start_visible && !end_visible {
					out.insert(end);
				} else if end_visible && !start_visible {
					out.insert(start);
				}
			}
		}
		if cursor.goto_first_child() {
			loop {
				collect_boundaries_unpruned(cursor, merged, out);
				if !cursor.goto_next_sibling() {
					break;
				}
			}
			cursor.goto_parent();
		}
	}

	/// [`enclosing_block_boundaries`] with the unpruned walk substituted in.
	/// Every early return is reproduced in the same order, so the differential
	/// also covers the empty-code, empty-range, unresolved-language and
	/// `has_error` paths.
	fn boundaries_unpruned(code: &str, path: &str, ranges: &[(u32, u32)]) -> Option<Vec<u32>> {
		let merged = normalize_ranges(
			ranges
				.iter()
				.map(|&(start_line, end_line)| LineRange { start_line, end_line })
				.collect(),
		);
		if code.is_empty() || merged.is_empty() {
			return Some(Vec::new());
		}
		let language = resolve_language(None, Some(path))?;
		let tree = parse_cached(code, language).expect("grammar loads")?;
		let root = tree.root_node();
		if root.has_error() {
			return None;
		}
		let mut boundaries = BTreeSet::new();
		let mut cursor = root.walk();
		collect_boundaries_unpruned(&mut cursor, &merged, &mut boundaries);
		Some(boundaries.into_iter().collect())
	}

	/// Range shapes exercised per file: head, middle, tail, a single interior
	/// line, three disjoint windows, the whole file visible, a window entirely
	/// past EOF, and the empty range list.
	fn window_shapes(lines: u32) -> Vec<Vec<(u32, u32)>> {
		let last = lines.max(1);
		let mid = (lines / 2).max(1);
		let tail_start = lines.saturating_sub(20).max(1);
		vec![
			vec![(1, 40.min(last))],
			vec![(mid, (mid + 20).min(last))],
			vec![(tail_start, last)],
			vec![(mid, mid)],
			vec![(1, 5.min(last)), (mid, (mid + 5).min(last)), (tail_start, last)],
			vec![(1, last)],
			vec![(last + 10, last + 20)],
			vec![],
		]
	}

	/// Compare pruned against unpruned output for exact `Option<Vec<u32>>`
	/// equality across every shape. Returns (comparisons, `None` verdicts).
	fn assert_prune_equivalent(code: &str, path: &str) -> (usize, usize) {
		let lines = code.split('\n').count() as u32;
		let mut comparisons = 0;
		let mut none_verdicts = 0;
		for shape in window_shapes(lines) {
			let pruned = boundaries(code, path, &shape);
			let unpruned = boundaries_unpruned(code, path, &shape);
			assert_eq!(pruned, unpruned, "{path} ranges={shape:?}");
			if pruned.is_none() {
				none_verdicts += 1;
			}
			comparisons += 1;
		}
		(comparisons, none_verdicts)
	}

	/// Repository `.ts` / `.py` / `.rs` sources, sorted for determinism. With a
	/// budget, files are taken on a stride so the sample spans the whole tree
	/// instead of one directory, skipping anything over 64 KiB.
	fn repo_files(byte_budget: Option<usize>) -> Vec<PathBuf> {
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		let mut files: Vec<PathBuf> = ignore::WalkBuilder::new(&root)
			.build()
			.filter_map(Result::ok)
			.filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
			.map(ignore::DirEntry::into_path)
			.filter(|path| {
				matches!(path.extension().and_then(std::ffi::OsStr::to_str), Some("ts" | "py" | "rs"))
			})
			.collect();
		files.sort();
		let Some(budget) = byte_budget else {
			return files;
		};
		let stride = (files.len() / 240).max(1);
		let mut picked = Vec::new();
		let mut used = 0;
		for path in files.iter().step_by(stride) {
			let Ok(meta) = std::fs::metadata(path) else {
				continue;
			};
			let len = meta.len() as usize;
			if len == 0 || len > 64 * 1024 {
				continue;
			}
			if used + len > budget {
				break;
			}
			used += len;
			picked.push(path.clone());
		}
		picked
	}

	fn sweep_corpus(files: &[PathBuf]) -> (usize, usize) {
		let mut comparisons = 0;
		let mut none_verdicts = 0;
		for path in files {
			let Ok(code) = std::fs::read_to_string(path) else {
				continue; // non-UTF-8 source; nothing to compare
			};
			let (n, nones) = assert_prune_equivalent(&code, path.to_str().expect("utf-8 path"));
			comparisons += n;
			none_verdicts += nones;
		}
		(comparisons, none_verdicts)
	}

	#[test]
	fn pruned_walk_matches_unpruned_on_repo_corpus_sample() {
		// Sandboxed runners (bazel test) stage only this crate's declared inputs,
		// so the repository corpus this sweep samples is absent (or a symlink
		// farm the walker cannot see through). Both surface as an empty scan —
		// skip then. Whenever the scan finds anything, the evidence assert below
		// still guards against a broken/undersized sample.
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		if !root.join("packages").is_dir() {
			eprintln!("skipping: repository corpus unavailable at {}", root.display());
			return;
		}
		let files = repo_files(Some(768 * 1024));
		if files.is_empty() {
			eprintln!("skipping: repository corpus scan found no sources at {}", root.display());
			return;
		}
		assert!(files.len() > 40, "corpus sample too small to be evidence: {}", files.len());
		let (comparisons, _) = sweep_corpus(&files);
		assert!(comparisons > 300, "expected a broad sweep, got {comparisons} comparisons");
	}

	#[test]
	#[ignore = "full repository sweep; run with `cargo nextest run --release -p pi-ast \
	            --run-ignored ignored-only`"]
	fn pruned_walk_matches_unpruned_on_full_repo_corpus() {
		let files = repo_files(None);
		assert!(files.len() > 3000, "expected the whole corpus, got {}", files.len());
		let (comparisons, _) = sweep_corpus(&files);
		println!("full corpus: {} files, {comparisons} comparisons", files.len());
	}

	#[test]
	fn pruned_walk_matches_unpruned_on_error_and_degenerate_inputs() {
		// The corpus is mostly valid source, so pin the `has_error`,
		// empty-code, empty-range and unresolved-language paths explicitly.
		let cases: &[(&str, &str)] = &[
			("", "x.ts"),
			("\n", "x.ts"),
			("\n\n\n", "x.py"),
			("function broken() {\n  if (y) {\n", "b.ts"),
			("def broken(:\n    pass\n", "b.py"),
			("fn broken( {\n", "b.rs"),
			("function ok() {\n  a();\n}\nfunction broken( {\n", "x.ts"),
			(TS_FN, "x.unknownext"),
		];
		let mut none_verdicts = 0;
		for (code, path) in cases {
			let (_, nones) = assert_prune_equivalent(code, path);
			none_verdicts += nones;
		}
		assert!(none_verdicts > 0, "error / unknown-language cases must exercise the None path");
	}

	/// Large file with a five-level nest in the middle, so a window on the
	/// opening lines has a long chain of closers to surface and the prune has
	/// most of the file to skip. Returns the source and the 1-indexed line of
	/// `function deep() {`.
	fn nested_fixture(pad: usize) -> (String, u32) {
		use std::fmt::Write as _;

		let mut code = String::new();
		for i in 0..pad {
			writeln!(code, "export const pad{i} = {i};").expect("write to String");
		}
		let nest = pad as u32 + 1;
		code.push_str("function deep() {\n");
		code.push_str("\tif (a) {\n");
		code.push_str("\t\twhile (b) {\n");
		code.push_str("\t\t\tfor (;;) {\n");
		code.push_str("\t\t\t\tif (c) {\n");
		code.push_str("\t\t\t\t\tbody();\n");
		code.push_str("\t\t\t\t}\n");
		code.push_str("\t\t\t}\n");
		code.push_str("\t\t}\n");
		code.push_str("\t}\n");
		code.push_str("}\n");
		for i in 0..pad {
			writeln!(code, "export const tail{i} = {i};").expect("write to String");
		}
		(code, nest)
	}

	#[test]
	fn window_deep_inside_nesting_still_returns_the_whole_chain() {
		let (code, nest) = nested_fixture(200);

		// Window covers all five opening lines, which are deep inside a
		// ~411-line file: each construct opens visibly and closes off-window, so
		// the full chain of five closers must come back.
		let openers = [(nest, nest + 4)];
		assert_eq!(
			boundaries(&code, "nested.ts", &openers),
			Some(vec![nest + 6, nest + 7, nest + 8, nest + 9, nest + 10]),
			"closers for every enclosing construct"
		);
		assert_eq!(
			boundaries(&code, "nested.ts", &openers),
			boundaries_unpruned(&code, "nested.ts", &openers)
		);

		// Mirror image: the five closing lines surface the five openers.
		let closers = [(nest + 6, nest + 10)];
		assert_eq!(
			boundaries(&code, "nested.ts", &closers),
			Some(vec![nest, nest + 1, nest + 2, nest + 3, nest + 4])
		);
		assert_eq!(
			boundaries(&code, "nested.ts", &closers),
			boundaries_unpruned(&code, "nested.ts", &closers)
		);

		// A window strictly interior to the nest surfaces nothing — every
		// enclosing node straddles it, so no endpoint is visible. The prune must
		// still descend through those straddling ancestors, which is what the
		// differential over every shape checks.
		assert_eq!(boundaries(&code, "nested.ts", &[(nest + 5, nest + 5)]), Some(vec![]));
		assert_prune_equivalent(&code, "nested.ts");
	}

	/// Count named nodes whose content end line differs from their raw end row,
	/// i.e. nodes ending immediately after a newline.
	fn nodes_with_content_end_before_raw_end(code: &str, path: &str) -> usize {
		let language = resolve_language(None, Some(path)).expect("known language");
		let tree = parse_cached(code, language)
			.expect("grammar loads")
			.expect("tree");
		let mut count = 0;
		let mut stack = vec![tree.root_node()];
		while let Some(node) = stack.pop() {
			let raw_end = node.end_position().row.saturating_add(1) as u32;
			if node.is_named() && node_content_end_line(node) != raw_end {
				count += 1;
			}
			for index in 0..node.child_count() {
				stack.push(node.child(index).expect("child in range"));
			}
		}
		count
	}

	#[test]
	fn content_end_line_before_raw_end_is_still_surfaced() {
		// The inner `def` ends right after `return value\n`, so tree-sitter puts
		// its end position at column 0 of the blank line: raw end row 5, content
		// end line 4. The prune tests the *raw* span, so the node survives a
		// window on either line.
		let code = "def outer():\n    def inner():\n        value = 1\n        return value\n\n    \
		            return inner\n";
		assert!(
			nodes_with_content_end_before_raw_end(code, "x.py") > 0,
			"fixture must actually contain a node whose content end precedes its raw end"
		);

		// Only the content end line is visible: the inner def and its block both
		// close there, so both openers come back.
		assert_eq!(boundaries(code, "x.py", &[(4, 4)]), Some(vec![2, 3]));
		assert_eq!(boundaries(code, "x.py", &[(4, 4)]), boundaries_unpruned(code, "x.py", &[(4, 4)]));

		// And the raw end line (the blank one) on its own.
		assert_eq!(boundaries(code, "x.py", &[(5, 5)]), boundaries_unpruned(code, "x.py", &[(5, 5)]));
		assert_prune_equivalent(code, "x.py");
	}
}
