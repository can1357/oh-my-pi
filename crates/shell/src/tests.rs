//! Shell test conditional expressions

use crate::{ExecutionParameters, Shell, error, extendedtests, extensions, parser::ast::TestExpr};

/// Evaluate the given test expression within the provided shell and
/// execution context. Returns true if the expression evaluates to true,
/// false otherwise.
///
/// # Arguments
///
/// * `expr` - The test expression to evaluate.
/// * `shell` - The shell context in which to evaluate the expression.
/// * `params` - The execution parameters to use during evaluation.
pub fn eval_expr(
	expr: &TestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match expr {
		TestExpr::False => Ok(false),
		TestExpr::Literal(s) => Ok(!s.is_empty()),
		TestExpr::And(left, right) => {
			Ok(eval_expr(left, shell, params)? && eval_expr(right, shell, params)?)
		},
		TestExpr::Or(left, right) => {
			Ok(eval_expr(left, shell, params)? || eval_expr(right, shell, params)?)
		},
		TestExpr::Not(expr) => Ok(!eval_expr(expr, shell, params)?),
		TestExpr::Parenthesized(expr) => eval_expr(expr, shell, params),
		TestExpr::UnaryTest(op, operand) => {
			extendedtests::apply_unary_predicate_to_str(op, operand, shell, params)
		},
		TestExpr::BinaryTest(op, left, right) => {
			extendedtests::apply_binary_predicate_to_strs(op, left.as_str(), right.as_str(), shell)
		},
	}
}
