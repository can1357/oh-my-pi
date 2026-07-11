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

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use serde::{Deserialize, Serialize};
use tree_sitter::{Parser, Point, TreeCursor};

use crate::summary::{node_content_end_line, node_start_line, resolve_language};

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

	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(&code, None) else {
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

/// Depth-first walk collecting boundary lines from every multi-line named node
/// that straddles a visible-range edge. A single reused [`TreeCursor`] keeps
/// the traversal allocation-free.
fn collect_boundaries(cursor: &mut TreeCursor<'_>, merged: &[LineRange], out: &mut BTreeSet<u32>) {
	let node = cursor.node();
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
	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(&code, None) else {
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
}
