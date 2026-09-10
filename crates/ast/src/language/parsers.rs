//! Tree-sitter parser functions for all supported languages.

use ast_grep_core::tree_sitter::TSLanguage;

///Returns the tree-sitter language for this parser.
pub fn language_astro() -> TSLanguage {
	tree_sitter_astro::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_bash() -> TSLanguage {
	tree_sitter_bash::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_c() -> TSLanguage {
	tree_sitter_c::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_clojure() -> TSLanguage {
	tree_sitter_clojure::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_cmake() -> TSLanguage {
	tree_sitter_cmake::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_cpp() -> TSLanguage {
	tree_sitter_cpp::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_c_sharp() -> TSLanguage {
	tree_sitter_c_sharp::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_dart() -> TSLanguage {
	tree_sitter_dart::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_css() -> TSLanguage {
	tree_sitter_css::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_diff() -> TSLanguage {
	tree_sitter_diff::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_dockerfile() -> TSLanguage {
	tree_sitter_dockerfile::language()
}
///Returns the tree-sitter language for this parser.
pub fn language_elixir() -> TSLanguage {
	tree_sitter_elixir::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_elisp() -> TSLanguage {
	tree_sitter_elisp::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_erlang() -> TSLanguage {
	tree_sitter_erlang::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_fortran() -> TSLanguage {
	tree_sitter_fortran::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_go() -> TSLanguage {
	tree_sitter_go::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_graphql() -> TSLanguage {
	tree_sitter_graphql::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_haskell() -> TSLanguage {
	tree_sitter_haskell::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_hcl() -> TSLanguage {
	tree_sitter_hcl::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_html() -> TSLanguage {
	tree_sitter_html::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_ini() -> TSLanguage {
	tree_sitter_ini::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_java() -> TSLanguage {
	tree_sitter_java::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_javascript() -> TSLanguage {
	tree_sitter_javascript::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_json() -> TSLanguage {
	tree_sitter_json::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_just() -> TSLanguage {
	tree_sitter_just::language().into()
}
///Returns the tree-sitter language for this parser.
pub fn language_julia() -> TSLanguage {
	tree_sitter_julia::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_kotlin() -> TSLanguage {
	tree_sitter_kotlin::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_lua() -> TSLanguage {
	tree_sitter_lua::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_make() -> TSLanguage {
	tree_sitter_make::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_markdown() -> TSLanguage {
	tree_sitter_md::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_nix() -> TSLanguage {
	tree_sitter_nix::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_objc() -> TSLanguage {
	tree_sitter_objc::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_ocaml() -> TSLanguage {
	tree_sitter_ocaml::LANGUAGE_OCAML.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_odin() -> TSLanguage {
	tree_sitter_odin::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_php() -> TSLanguage {
	tree_sitter_php::LANGUAGE_PHP_ONLY.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_powershell() -> TSLanguage {
	tree_sitter_powershell::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_proto() -> TSLanguage {
	tree_sitter_proto::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_python() -> TSLanguage {
	tree_sitter_python::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_r() -> TSLanguage {
	tree_sitter_r::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_regex() -> TSLanguage {
	tree_sitter_regex::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_ruby() -> TSLanguage {
	tree_sitter_ruby::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_rust() -> TSLanguage {
	tree_sitter_rust::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_scala() -> TSLanguage {
	tree_sitter_scala::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_solidity() -> TSLanguage {
	tree_sitter_solidity::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_sql() -> TSLanguage {
	tree_sitter_sql::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_starlark() -> TSLanguage {
	tree_sitter_starlark::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_svelte() -> TSLanguage {
	tree_sitter_svelte::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_swift() -> TSLanguage {
	tree_sitter_swift::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_toml() -> TSLanguage {
	tree_sitter_toml_ng::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_tsx() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TSX.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_typescript() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_tlaplus() -> TSLanguage {
	tree_sitter_tlaplus::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_verilog() -> TSLanguage {
	tree_sitter_verilog::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_vue() -> TSLanguage {
	tree_sitter_vue::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_xml() -> TSLanguage {
	tree_sitter_xml::LANGUAGE_XML.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_yaml() -> TSLanguage {
	tree_sitter_yaml::LANGUAGE.into()
}
///Returns the tree-sitter language for this parser.
pub fn language_zig() -> TSLanguage {
	tree_sitter_zig::LANGUAGE.into()
}
