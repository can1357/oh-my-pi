//! `enum-str-table`: hand-written enum-to-string tables should use a derived
//! `strum` conversion instead.

use std::ops::Range;

use ra_ap_syntax::ast::{self, AstNode, HasName};

use crate::{
	fix::PathFix,
	lint::{Diagnosis, FileContext, Lint, RealtimeSink},
};

/// Rejects `match self` expressions that map every arm to a string literal.
pub struct EnumStrTable;

/// One hand-written enum-to-string table.
pub struct Finding {
	span: Range<usize>,
}

impl Diagnosis for Finding {
	fn span(&self) -> Range<usize> {
		self.span.clone()
	}

	fn message(&self) -> String {
		"`match self` is an enum-to-string table; derive `strum` instead".to_owned()
	}

	fn autofixable(&self) -> bool {
		false
	}

	fn fix(self) -> Option<PathFix> {
		None
	}
}

impl Lint for EnumStrTable {
	type Instance = Finding;

	const NAME: &'static str = "enum-str-table";

	fn detect(&self, ctx: &FileContext<'_>, sink: &mut RealtimeSink<'_, Finding>) {
		let enum_names = ctx
			.tree
			.syntax()
			.descendants()
			.filter_map(ast::Enum::cast)
			.filter_map(|item| item.name().map(|name| name.text().to_string()))
			.collect::<Vec<_>>();

		for match_expr in ctx
			.tree
			.syntax()
			.descendants()
			.filter_map(ast::MatchExpr::cast)
		{
			if !is_string_table(&match_expr) {
				continue;
			}

			let Some(implementation) = match_expr.syntax().ancestors().find_map(ast::Impl::cast)
			else {
				continue;
			};
			if !is_own_enum_impl(&implementation, &enum_names) {
				continue;
			}
			let Some(function) = match_expr.syntax().ancestors().find_map(ast::Fn::cast) else {
				continue;
			};
			if !is_string_returning(&function) && !is_display_impl(&implementation) {
				continue;
			}

			let range = function.syntax().text_range();
			sink.push(Finding { span: range.start().into()..range.end().into() });
		}
	}
}

/// Whether `match_expr` is an exhaustive-looking map from the receiver to
/// string literals. Guards and non-literal arms keep dynamic logic out of the
/// rule's intentionally narrow shape.
fn is_string_table(match_expr: &ast::MatchExpr) -> bool {
	let Some(scrutinee) = match_expr.expr() else {
		return false;
	};
	if !is_self_expr(&scrutinee) {
		return false;
	}

	let Some(arm_list) = match_expr.match_arm_list() else {
		return false;
	};
	let mut arm_count = 0usize;
	for arm in arm_list.arms() {
		arm_count += 1;
		if arm.guard().is_some() || !arm.expr().is_some_and(|expr| is_string_literal(&expr)) {
			return false;
		}
	}
	arm_count > 0
}

fn is_self_expr(expr: &ast::Expr) -> bool {
	let ast::Expr::PathExpr(path_expr) = expr else {
		return false;
	};
	path_expr
		.path()
		.is_some_and(|path| path.syntax().text().to_string().trim() == "self")
}

fn is_string_literal(expr: &ast::Expr) -> bool {
	matches!(
		 expr,
		 ast::Expr::Literal(literal) if matches!(literal.kind(), ast::LiteralKind::String(_))
	)
}

fn is_string_returning(function: &ast::Fn) -> bool {
	let Some(ty) = function.ret_type().and_then(|ret_type| ret_type.ty()) else {
		return false;
	};
	match ty {
		ast::Type::RefType(reference) => {
			if reference.mut_token().is_some() {
				return false;
			}
			if reference
				.lifetime()
				.is_some_and(|lifetime| lifetime.syntax().text().to_string() != "'static")
			{
				return false;
			}
			is_named_path_type(reference.ty(), "str")
		},
		ast::Type::PathType(path_type) => is_named_path(path_type.path(), &["Str", "String"]),
		_ => false,
	}
}

fn is_named_path_type(ty: Option<ast::Type>, expected: &str) -> bool {
	let Some(ast::Type::PathType(path_type)) = ty else {
		return false;
	};
	is_named_path(path_type.path(), &[expected])
}

fn is_named_path(path: Option<ast::Path>, expected: &[&str]) -> bool {
	path
		.and_then(|path| path.segment())
		.and_then(|segment| segment.name_ref())
		.is_some_and(|name| {
			let actual = name.text().to_string();
			expected.contains(&actual.as_str())
		})
}

fn is_own_enum_impl(implementation: &ast::Impl, enum_names: &[String]) -> bool {
	let Some(ast::Type::PathType(path_type)) = implementation.self_ty() else {
		return false;
	};
	let Some(name) = path_type
		.path()
		.and_then(|path| path.segment())
		.and_then(|segment| segment.name_ref())
	else {
		return false;
	};
	let actual = name.text().to_string();
	enum_names.iter().any(|enum_name| enum_name == &actual)
}

fn is_display_impl(implementation: &ast::Impl) -> bool {
	let Some(ast::Type::PathType(path_type)) = implementation.trait_() else {
		return false;
	};
	is_named_path(path_type.path(), &["Display"])
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::EnumStrTable;
	use crate::lint::{AnyLint, FileContext};

	fn findings(source: &str) -> Vec<crate::lint::Diag> {
		let context = FileContext::new(Path::new("fixture.rs"), source);
		let mut findings = Vec::new();
		EnumStrTable.detect_erased(&context, &mut |diagnosis| findings.push(diagnosis));
		findings
	}

	#[test]
	fn flags_enum_string_table_but_not_foreign_value_match() {
		let source = r#"
        enum Kind { Null, Bool }
        impl Kind {
            const fn name(&self) -> &'static str {
                match self {
                    Self::Null => "null",
                    Self::Bool => "boolean",
                }
            }
        }

        fn value_name(value: &serde_json::Value) -> &'static str {
            match value {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "boolean",
            }
        }
    "#;

		let findings = findings(source);
		assert_eq!(findings.len(), 1);
		assert_eq!(findings[0].rule, "enum-str-table");
		let name_start = source.find("const fn name").unwrap();
		let match_start = source.find("match self").unwrap();
		assert!(findings[0].span.start >= name_start);
		assert!(findings[0].span.start <= match_start);
		assert!(match_start < findings[0].span.end);
	}

	#[test]
	fn flags_single_variant_string_table() {
		let source = r#"
        enum Kind { Only }
        impl Kind {
            fn name(&self) -> &'static str {
                match self {
                    Self::Only => "only",
                }
            }
        }
    "#;

		assert_eq!(findings(source).len(), 1);
	}

	#[test]
	fn flags_literal_match_inside_display_impl() {
		let source = r#"
        enum Kind { Null, Bool }
        impl std::fmt::Display for Kind {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                let label = match self {
                    Self::Null => "null",
                    Self::Bool => "boolean",
                };
                formatter.write_str(label)
            }
        }
    "#;

		assert_eq!(findings(source).len(), 1);
	}

	#[test]
	fn ignores_dynamic_match_arms() {
		let source = r#"
        enum Kind { Null, Bool }
        impl Kind {
            fn name(&self) -> &'static str {
                match self {
                    Self::Null if condition() => "null",
                    Self::Bool => "boolean",
                }
            }
        }
    "#;

		assert!(findings(source).is_empty());
	}
}
