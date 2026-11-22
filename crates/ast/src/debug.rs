//! `ast-grep --debug-query` dumps of a query's syntax tree.

use std::fmt::Write as _;

use ast_grep_core::{Language, tree_sitter::LanguageExt};
use tree_sitter::{Node, TreeCursor};

use crate::SupportLang;

/// `source`'s tree-sitter tree, one node per line as `field: kind
/// (row,col)-(row,col)`: named nodes only (`--debug-query=ast`) or every node
/// (`cst`).
pub fn dump_tree(source: &str, lang: SupportLang, named_only: bool) -> String {
	let root = lang.ast_grep(source);
	let node = root.root().get_inner_node();
	let mut out = String::new();
	dump_cursor(&mut node.walk(), named_only, 0, &mut out);
	out
}

/// `source`'s tree as an S-expression (`--debug-query=sexp`).
pub fn dump_sexp(source: &str, lang: SupportLang) -> String {
	lang.ast_grep(source).root().get_inner_node().to_sexp()
}

fn dump_cursor(cursor: &mut TreeCursor<'_>, named_only: bool, depth: usize, out: &mut String) {
	let node = cursor.node();
	if named_only && !node.is_named() {
		return;
	}
	out.push_str(&"  ".repeat(depth));
	if let Some(field) = cursor.field_name() {
		out.push_str(field);
		out.push_str(": ");
	}
	if node.is_missing() {
		out.push_str("MISSING ");
	}
	out.push_str(node.kind());
	let (start, end) = (node.start_position(), node.end_position());
	let _ = writeln!(out, " ({},{})-({},{})", start.row, start.column, end.row, end.column);
	if cursor.goto_first_child() {
		loop {
			dump_cursor(cursor, named_only, depth + 1, out);
			if !cursor.goto_next_sibling() {
				break;
			}
		}
		cursor.goto_parent();
	}
}

/// The pattern node `pattern` matches with, as `--debug-query=pattern` prints
/// it.
///
/// That is its tree below the wrappers that have a single child: metavariables
/// as `MetaVar $NAME`, named leaves as `kind text`, other named nodes as
/// `kind`, and anonymous tokens as their text.
pub fn dump_pattern(pattern: &str, lang: SupportLang) -> String {
	let processed = lang.pre_process_pattern(pattern);
	let root = lang.ast_grep(&*processed);
	let mut node = root.root().get_inner_node();
	while node.child_count() == 1
		&& let Some(child) = node.child(0)
	{
		node = child;
	}
	let source = processed.as_bytes();
	let mut out = String::new();
	dump_pattern_node(node, source, lang, 0, &mut out);
	out
}

fn dump_pattern_node(
	node: Node<'_>,
	source: &[u8],
	lang: SupportLang,
	depth: usize,
	out: &mut String,
) {
	if node.is_missing() {
		return;
	}
	let text = node.utf8_text(source).unwrap_or_default();
	let (expando, meta) = (lang.expando_char(), lang.meta_var_char());
	let text = if expando == meta {
		text.to_owned()
	} else {
		text.replace(expando, &meta.to_string())
	};
	out.push_str(&"  ".repeat(depth));
	if lang.extract_meta_var(&text).is_some() {
		out.push_str("MetaVar ");
		out.push_str(&text);
		out.push('\n');
		return;
	}
	let leaf = node.child_count() == 0;
	match (node.is_named(), leaf) {
		(true, true) => {
			let _ = writeln!(out, "{} {text}", node.kind());
		},
		(true, false) => {
			let _ = writeln!(out, "{}", node.kind());
		},
		(false, _) => {
			let _ = writeln!(out, "{text}");
		},
	}
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		dump_pattern_node(child, source, lang, depth + 1, out);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ast_dump_lists_named_nodes_with_fields_and_positions() {
		let dumped = dump_tree("var a = 123", SupportLang::TypeScript, true);
		assert_eq!(
			dumped.trim(),
			"program (0,0)-(0,11)\n  variable_declaration (0,0)-(0,11)\n    variable_declarator \
			 (0,4)-(0,11)\n      name: identifier (0,4)-(0,5)\n      value: number (0,8)-(0,11)"
		);
	}

	#[test]
	fn pattern_dump_marks_metavariables() {
		let dumped = dump_pattern("console.log($MSG)", SupportLang::JavaScript);
		assert_eq!(
			dumped.trim(),
			"call_expression\n  member_expression\n    identifier console\n    .\n    \
			 property_identifier log\n  arguments\n    (\n    MetaVar $MSG\n    )"
		);
	}
}
