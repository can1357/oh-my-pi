//! Symbol outlines for `ast-grep outline`: a file's top-level items (imports,
//! types, functions, variables) and each item's direct members, read off the
//! tree-sitter tree by node kind.

use ast_grep_core::tree_sitter::LanguageExt;
use serde::Serialize;
use tree_sitter::Node;

use crate::SupportLang;

/// Outline symbol category (LSP `DocumentSymbol.kind` names).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolType {
	Module,
	Namespace,
	Package,
	Class,
	Struct,
	Enum,
	Interface,
	Function,
	Method,
	Constructor,
	Property,
	Field,
	EnumMember,
	Variable,
	Constant,
	TypeParameter,
}

impl SymbolType {
	/// Every category, in the order grouped views list them.
	pub const ORDER: &[Self] = &[
		Self::Module,
		Self::Namespace,
		Self::Package,
		Self::Class,
		Self::Struct,
		Self::Enum,
		Self::Interface,
		Self::Function,
		Self::Method,
		Self::Constructor,
		Self::Property,
		Self::Field,
		Self::EnumMember,
		Self::Variable,
		Self::Constant,
		Self::TypeParameter,
	];

	/// The name `--type` takes and grouped views print.
	pub const fn name(self) -> &'static str {
		match self {
			Self::Module => "module",
			Self::Namespace => "namespace",
			Self::Package => "package",
			Self::Class => "class",
			Self::Struct => "struct",
			Self::Enum => "enum",
			Self::Interface => "interface",
			Self::Function => "function",
			Self::Method => "method",
			Self::Constructor => "constructor",
			Self::Property => "property",
			Self::Field => "field",
			Self::EnumMember => "enumMember",
			Self::Variable => "variable",
			Self::Constant => "constant",
			Self::TypeParameter => "typeParameter",
		}
	}

	/// A `--type` value, ignoring case, `-` and `_`.
	pub fn parse(raw: &str) -> Option<Self> {
		let normalized: String = raw
			.chars()
			.filter(|ch| *ch != '-' && *ch != '_')
			.flat_map(char::to_lowercase)
			.collect();
		Self::ORDER
			.iter()
			.copied()
			.find(|symbol| symbol.name().to_lowercase() == normalized)
	}
}

/// Whether an entry is a top-level item or a member of one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryRole {
	Item,
	Member,
}

/// Zero-based line and character column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Position {
	pub line:   usize,
	pub column: usize,
}

/// Byte offsets and positions of an entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
	pub byte_offset: std::ops::Range<usize>,
	pub start:       Position,
	pub end:         Position,
}

/// What an item and a member share.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
	pub role:        EntryRole,
	pub symbol_type: SymbolType,
	pub name:        String,
	pub range:       Range,
	/// The entry's first source line, cut before its body.
	pub signature:   String,
	pub ast_kind:    String,
}

/// One top-level item.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
	#[serde(flatten)]
	pub entry:       Entry,
	pub is_import:   bool,
	pub is_exported: bool,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub members:     Vec<Member>,
}

/// One direct member of an item.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
	#[serde(flatten)]
	pub entry:     Entry,
	pub is_public: bool,
}

/// The top-level items of `source`, each with its direct members.
pub fn outline(source: &str, lang: SupportLang) -> Vec<Item> {
	let root = lang.ast_grep(source);
	let root = root.root().get_inner_node();
	let bytes = source.as_bytes();
	let mut items = Vec::new();
	let mut cursor = root.walk();
	for node in root.named_children(&mut cursor) {
		collect_items(node, bytes, lang, &mut items);
	}
	items
}

/// Items `node` (a direct child of the file, or of a wrapper like
/// `export`, a decorator or a template) declares.
fn collect_items(node: Node<'_>, source: &[u8], lang: SupportLang, items: &mut Vec<Item>) {
	let kind = node.kind();
	if kind.contains("comment") {
		return;
	}
	if kind.starts_with("export") {
		let declarations = declarations_of(node, source);
		if declarations.is_empty() {
			// `export { a, b }`, `export * from "./x"`, `export default value`.
			let mut item = item(node, source, lang, SymbolType::Module, false);
			item.entry.name = node
				.child_by_field_name("source")
				.map_or_else(|| "exports".to_owned(), |from| text(from, source));
			item.is_exported = true;
			items.push(item);
			return;
		}
		for declaration in declarations {
			let start = items.len();
			collect_items(declaration, source, lang, items);
			for item in &mut items[start..] {
				item.is_exported = true;
				item.entry.signature = signature(node, declaration, source);
				item.entry.range = range(node);
			}
		}
		return;
	}
	if matches!(kind, "decorated_definition" | "template_declaration" | "attributed_declaration")
		&& let Some(definition) = node
			.child_by_field_name("definition")
			.or_else(|| last_named_child(node))
	{
		let start = items.len();
		collect_items(definition, source, lang, items);
		for item in &mut items[start..] {
			item.entry.range = range(node);
		}
		return;
	}
	if kind == "expression_statement"
		&& let Some(inner) = node.named_child(0)
	{
		// Python's module-level `NAME = value`.
		if inner.kind() == "assignment" {
			collect_items(inner, source, lang, items);
		}
		return;
	}
	let Some(symbol) = item_symbol(kind, node, source) else {
		return;
	};
	items.push(item(node, source, lang, symbol, is_import_kind(kind)));
}

/// The declarations an `export` statement wraps.
fn declarations_of<'t>(export: Node<'t>, source: &[u8]) -> Vec<Node<'t>> {
	if let Some(declaration) = export.child_by_field_name("declaration") {
		return vec![declaration];
	}
	let mut cursor = export.walk();
	export
		.named_children(&mut cursor)
		.filter(|child| {
			!child.kind().contains("clause") && item_symbol(child.kind(), *child, source).is_some()
		})
		.collect()
}

fn last_named_child(node: Node<'_>) -> Option<Node<'_>> {
	node
		.named_child_count()
		.checked_sub(1)
		.and_then(|index| node.named_child(index))
}

fn is_import_kind(kind: &str) -> bool {
	kind.contains("import")
		|| matches!(
			kind,
			"use_declaration" | "using_directive" | "preproc_include" | "extern_crate_declaration"
		)
}

/// The category of a top-level node, or `None` for statements an outline skips.
fn item_symbol(kind: &str, node: Node<'_>, source: &[u8]) -> Option<SymbolType> {
	if is_import_kind(kind) {
		return Some(SymbolType::Module);
	}
	Some(match kind {
		k if k.contains("namespace") || k == "internal_module" => SymbolType::Namespace,
		k if k.contains("package") => SymbolType::Package,
		"mod_item" | "module" | "module_definition" => SymbolType::Module,
		k if k.contains("interface") || k.contains("trait") || k.contains("protocol") => {
			SymbolType::Interface
		},
		k if k.contains("enum") => SymbolType::Enum,
		k if k.contains("struct") || k == "union_item" || k == "union_specifier" => {
			SymbolType::Struct
		},
		k if k.contains("class") || k == "impl_item" || k == "object_declaration" => {
			SymbolType::Class
		},
		k if k.contains("type_alias")
			|| k == "type_item"
			|| k == "type_declaration"
			|| k == "type_definition" =>
		{
			SymbolType::TypeParameter
		},
		k if k.contains("function") || k.contains("method") || k == "macro_definition" => {
			SymbolType::Function
		},
		"const_item" | "const_declaration" | "static_item" => SymbolType::Constant,
		"lexical_declaration"
		| "variable_declaration"
		| "var_declaration"
		| "let_declaration"
		| "short_var_declaration"
		| "property_declaration"
		| "assignment" => {
			let text = node.utf8_text(source).unwrap_or_default();
			if text.trim_start().starts_with("const ") {
				SymbolType::Constant
			} else {
				SymbolType::Variable
			}
		},
		_ => return None,
	})
}

fn item(
	node: Node<'_>,
	source: &[u8],
	lang: SupportLang,
	symbol: SymbolType,
	is_import: bool,
) -> Item {
	let name = if is_import {
		import_name(node, source)
	} else {
		entry_name(node, source).unwrap_or_else(|| first_line(node, source))
	};
	let is_exported = !is_import && exported_by_convention(node, &name, source, lang);
	let members = if is_import {
		Vec::new()
	} else {
		members(node, source, lang)
	};
	Item {
		entry: Entry {
			role: EntryRole::Item,
			symbol_type: symbol,
			name,
			range: range(node),
			signature: signature(node, node, source),
			ast_kind: node.kind().to_owned(),
		},
		is_import,
		is_exported,
		members,
	}
}

/// Export markers outside an `export` statement: Rust `pub`, Go's capital
/// initial, Java/C#/Kotlin `public`, Python's missing leading underscore.
fn exported_by_convention(node: Node<'_>, name: &str, source: &[u8], lang: SupportLang) -> bool {
	let text = node.utf8_text(source).unwrap_or_default().trim_start();
	match lang {
		SupportLang::Rust => text.starts_with("pub"),
		SupportLang::Go => name.chars().next().is_some_and(char::is_uppercase),
		SupportLang::Java | SupportLang::CSharp | SupportLang::Kotlin | SupportLang::Swift => text
			.split_whitespace()
			.take_while(|word| !word.contains('('))
			.any(|word| word == "public"),
		SupportLang::Python | SupportLang::Ruby => !name.starts_with('_'),
		_ => false,
	}
}

/// What an import imports from: its source/path field, else its text.
fn import_name(node: Node<'_>, source: &[u8]) -> String {
	for field in ["source", "path", "argument", "module_name", "name"] {
		if let Some(child) = node.child_by_field_name(field) {
			return text(child, source);
		}
	}
	first_line(node, source)
}

/// A declaration's name: its `name` field, or a declarator's, or an impl's
/// type.
fn entry_name(node: Node<'_>, source: &[u8]) -> Option<String> {
	for field in ["name", "declarator", "left", "pattern", "type"] {
		let Some(mut child) = node.child_by_field_name(field) else {
			continue;
		};
		// `int *f(void)`: the name sits inside nested declarators.
		while let Some(inner) = child
			.child_by_field_name("declarator")
			.or_else(|| child.child_by_field_name("name"))
		{
			child = inner;
		}
		return Some(text(child, source));
	}
	let mut cursor = node.walk();
	let declarator = node
		.named_children(&mut cursor)
		.find(|child| child.kind().contains("declarator") || child.kind().contains("spec"))?;
	entry_name(declarator, source).or_else(|| Some(text(declarator, source)))
}

/// The direct members of a type-like item: methods, fields, properties,
/// variants.
fn members(node: Node<'_>, source: &[u8], lang: SupportLang) -> Vec<Member> {
	let Some(body) = node.child_by_field_name("body").or_else(|| {
		let mut cursor = node.walk();
		node.named_children(&mut cursor).find(|child| {
			let kind = child.kind();
			kind.ends_with("body")
				|| kind.ends_with("_list")
				|| kind == "block"
				|| kind == "declaration_list"
		})
	}) else {
		return Vec::new();
	};
	let mut members = Vec::new();
	let mut cursor = body.walk();
	for child in body.named_children(&mut cursor) {
		let child = match child.kind() {
			"decorated_definition" => child.child_by_field_name("definition").unwrap_or(child),
			_ => child,
		};
		let Some(symbol) = member_symbol(child.kind()) else {
			continue;
		};
		let Some(name) = entry_name(child, source) else {
			continue;
		};
		let symbol = if symbol == SymbolType::Method
			&& matches!(name.as_str(), "constructor" | "__init__" | "new" | "init")
		{
			SymbolType::Constructor
		} else {
			symbol
		};
		members.push(Member {
			is_public: member_is_public(child, &name, source, lang),
			entry:     Entry {
				role: EntryRole::Member,
				symbol_type: symbol,
				name,
				range: range(child),
				signature: signature(child, child, source),
				ast_kind: child.kind().to_owned(),
			},
		});
	}
	members
}

fn member_symbol(kind: &str) -> Option<SymbolType> {
	Some(match kind {
		k if k.contains("enum_variant")
			|| k == "enumerator"
			|| k == "enum_assignment"
			|| k == "enum_member_declaration" =>
		{
			SymbolType::EnumMember
		},
		k if k.contains("constructor") => SymbolType::Constructor,
		k if k.contains("method") || k.contains("function") => SymbolType::Method,
		k if k.contains("property") || k == "public_field_definition" => SymbolType::Property,
		k if k.contains("field") => SymbolType::Field,
		_ => return None,
	})
}

fn member_is_public(node: Node<'_>, name: &str, source: &[u8], lang: SupportLang) -> bool {
	let text = node.utf8_text(source).unwrap_or_default().trim_start();
	match lang {
		SupportLang::Rust => text.starts_with("pub") || node.kind() == "enum_variant",
		SupportLang::Go => name.chars().next().is_some_and(char::is_uppercase),
		SupportLang::Python | SupportLang::Ruby => {
			!name.starts_with('_') || (name.starts_with("__") && name.ends_with("__"))
		},
		_ => !(name.starts_with('#') || text.starts_with("private") || text.starts_with("protected")),
	}
}

/// The first line of `span`'s text, cut before the body of `node`.
fn signature(span: Node<'_>, node: Node<'_>, source: &[u8]) -> String {
	let end = node
		.child_by_field_name("body")
		.map_or_else(|| span.end_byte(), |body| body.start_byte())
		.max(span.start_byte());
	let text = std::str::from_utf8(&source[span.start_byte()..end]).unwrap_or_default();
	let line = text
		.lines()
		.find(|line| !line.trim().is_empty())
		.unwrap_or_default();
	line
		.trim()
		.trim_end_matches(['{', ':'])
		.trim_end()
		.to_owned()
}

fn first_line(node: Node<'_>, source: &[u8]) -> String {
	text(node, source)
		.lines()
		.next()
		.unwrap_or_default()
		.trim()
		.to_owned()
}

fn text(node: Node<'_>, source: &[u8]) -> String {
	node.utf8_text(source).unwrap_or_default().to_owned()
}

fn range(node: Node<'_>) -> Range {
	let (start, end) = (node.start_position(), node.end_position());
	Range {
		byte_offset: node.start_byte()..node.end_byte(),
		start:       Position { line: start.row, column: start.column },
		end:         Position { line: end.row, column: end.column },
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn names(items: &[Item]) -> Vec<(SymbolType, &str, bool)> {
		items
			.iter()
			.map(|item| (item.entry.symbol_type, item.entry.name.as_str(), item.is_exported))
			.collect()
	}

	#[test]
	fn typescript_items_members_and_exports() {
		let source = "import { a } from \"./a\";\nexport class Parser {\n  parse(input: string) { \
		              return 1; }\n  private recover() {}\n}\nfunction helper() {}\nconst LIMIT = \
		              3;\n";
		let items = outline(source, SupportLang::TypeScript);
		assert_eq!(names(&items), [
			(SymbolType::Module, "\"./a\"", false),
			(SymbolType::Class, "Parser", true),
			(SymbolType::Function, "helper", false),
			(SymbolType::Constant, "LIMIT", false),
		]);
		assert_eq!(items[1].entry.signature, "export class Parser");
		assert_eq!(items[1].entry.range.start.line, 1);
		let members: Vec<(&str, bool)> = items[1]
			.members
			.iter()
			.map(|member| (member.entry.name.as_str(), member.is_public))
			.collect();
		assert_eq!(members, [("parse", true), ("recover", false)]);
	}

	#[test]
	fn rust_items_use_pub_for_exports() {
		let source = "use std::fmt;\npub struct Point { pub x: i32, y: i32 }\nfn private() {}\nimpl \
		              Point {\n    pub fn new() -> Self { todo!() }\n}\n";
		let items = outline(source, SupportLang::Rust);
		assert_eq!(names(&items), [
			(SymbolType::Module, "std::fmt", false),
			(SymbolType::Struct, "Point", true),
			(SymbolType::Function, "private", false),
			(SymbolType::Class, "Point", false),
		]);
		assert_eq!(items[1].members.len(), 2);
		assert_eq!(items[3].members[0].entry.symbol_type, SymbolType::Constructor);
	}
}
