//! Shell test conditional expressions

use crate::{ExecutionParameters, Shell, error, extendedtests, extensions};

/// Evaluate the given test expression within the provided shell and
/// execution context. Returns true if the expression evaluates to true,
/// false otherwise.
///
/// # Arguments
///
/// * `expr` - The test expression to evaluate.
/// * `shell` - The shell context in which to evaluate the expression.
/// * `params` - The execution parameters to use during evaluation.
#[async_recursion::async_recursion]
pub async fn eval_expr(
	expr: &brush_parser::ast::TestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match expr {
		brush_parser::ast::TestExpr::False => Ok(false),
		brush_parser::ast::TestExpr::Literal(s) => Ok(!s.is_empty()),
		brush_parser::ast::TestExpr::And(..) | brush_parser::ast::TestExpr::Or(..) => {
			eval_chain(expr, shell, params).await
		},
		brush_parser::ast::TestExpr::Not(expr) => Ok(!eval_expr(expr, shell, params).await?),
		brush_parser::ast::TestExpr::Parenthesized(expr) => eval_expr(expr, shell, params).await,
		brush_parser::ast::TestExpr::UnaryTest(op, operand) => {
			extendedtests::apply_unary_predicate_to_str(op, operand, shell, params).await
		},
		brush_parser::ast::TestExpr::BinaryTest(op, left, right) => {
			extendedtests::apply_binary_predicate_to_strs(op, left.as_str(), right.as_str(), shell)
				.await
		},
	}
}

/// Evaluates `expr`, an `-a` or `-o`, and those nested in its left operand.
///
/// `-a` and `-o` nest to the left: `x -a y -o z` is `(x -a y) -o z`, and a chain of them is a
/// tree as deep as the chain is long. Its left operands are walked in a loop here, so only
/// right operands recurse, and those nest only as deeply as the expression does.
async fn eval_chain(
	expr: &brush_parser::ast::TestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	let (leftmost, chain) = extendedtests::RightOperands::collect(expr, |expr| match expr {
		brush_parser::ast::TestExpr::And(left, right) => Some((true, &**left, &**right)),
		brush_parser::ast::TestExpr::Or(left, right) => Some((false, &**left, &**right)),
		_ => None,
	});

	let mut value = eval_chain_operand(leftmost, shell, params).await?;
	for (is_and, right) in chain.innermost_first() {
		// The right operand is evaluated only when the left one does not decide the result.
		if value == is_and {
			value = eval_chain_operand(right, shell, params).await?;
		}
	}
	Ok(value)
}

/// Evaluates an operand of a chain. A predicate is evaluated here rather than through
/// [`eval_expr`], whose every call allocates a boxed future.
async fn eval_chain_operand(
	expr: &brush_parser::ast::TestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match expr {
		brush_parser::ast::TestExpr::False => Ok(false),
		brush_parser::ast::TestExpr::Literal(s) => Ok(!s.is_empty()),
		brush_parser::ast::TestExpr::UnaryTest(op, operand) => {
			extendedtests::apply_unary_predicate_to_str(op, operand, shell, params).await
		},
		brush_parser::ast::TestExpr::BinaryTest(op, left, right) => {
			extendedtests::apply_binary_predicate_to_strs(op, left.as_str(), right.as_str(), shell)
				.await
		},
		_ => eval_expr(expr, shell, params).await,
	}
}
