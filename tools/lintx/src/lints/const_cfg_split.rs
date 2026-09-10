//! `const-cfg-split`: a `const fn` must not carry target-specific blocks.
//!
//! A `#[cfg]` expression inside a const function is easy to make valid on one
//! target and invalid on another. Keep platform splits in ordinary functions so
//! each branch is typechecked without const-evaluation constraints.

use std::ops::Range;

use ra_ap_syntax::ast::{self, AstNode, HasAttrs};

use crate::{
	fix::PathFix,
	lint::{Diagnosis, FileContext, Lint, RealtimeSink},
};

/// Rejects const functions containing cfg-gated blocks.
pub struct ConstCfgSplit;

/// One const function with a cfg-gated block.
pub struct Finding {
	span: Range<usize>,
}

impl Diagnosis for Finding {
	fn span(&self) -> Range<usize> {
		self.span.clone()
	}

	fn message(&self) -> String {
		"`const fn` contains a `#[cfg]` block; split platform-specific bodies into ordinary functions"
			.to_owned()
	}

	fn autofixable(&self) -> bool {
		false
	}

	fn fix(self) -> Option<PathFix> {
		None
	}
}

impl Lint for ConstCfgSplit {
	type Instance = Finding;

	const NAME: &'static str = "const-cfg-split";

	fn detect(&self, ctx: &FileContext<'_>, sink: &mut RealtimeSink<'_, Finding>) {
		for function in ctx.tree.syntax().descendants().filter_map(ast::Fn::cast) {
			if function.const_token().is_none() {
				continue;
			}
			let Some(body) = function.body() else {
				continue;
			};
			if !body
				.syntax()
				.descendants()
				.filter_map(ast::AnyHasAttrs::cast)
				.any(|node| node.attrs().any(|attr| is_cfg_attribute(&attr)))
			{
				continue;
			}

			let range = function.syntax().text_range();
			sink.push(Finding { span: range.start().into()..range.end().into() });
		}
	}
}

fn is_cfg_attribute(attr: &ast::Attr) -> bool {
	attr.simple_name().is_some_and(|name| name == "cfg")
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::ConstCfgSplit;
	use crate::lint::{AnyLint, FileContext};

	fn findings(source: &str) -> Vec<crate::lint::Diag> {
		let context = FileContext::new(Path::new("fixture.rs"), source);
		let mut findings = Vec::new();
		ConstCfgSplit.detect_erased(&context, &mut |diagnosis| findings.push(diagnosis));
		findings
	}

	#[test]
	fn flags_const_fn_with_cfg_block() {
		let source = r#"
        const fn prepare() -> u8 {
            #[cfg(target_os = "linux")]
            {
                1
            }
            0
        }
    "#;

		let findings = findings(source);
		assert_eq!(findings.len(), 1);
		assert_eq!(findings[0].rule, "const-cfg-split");
	}
	#[test]
	fn flags_const_fn_with_cfg_statement() {
		let source = r#"
        const fn current() -> u8 {
            #[cfg(target_os = "linux")]
            return 1;
            0
        }
    "#;

		assert_eq!(findings(source).len(), 1);
	}

	#[test]
	fn ignores_const_fn_without_cfg_block() {
		let source = r#"
        const fn capabilities() -> u8 {
            1
        }
    "#;

		assert!(findings(source).is_empty());
	}
}
