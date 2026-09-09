//! Arithmetic evaluation

use std::borrow::Cow;

use brush_parser::ast;

use crate::{ExecutionParameters, Shell, env, expansion, extensions, variables};

/// Maximum recursion depth for arithmetic variable dereference chains
/// (e.g., a=b, b=c, c=a would cycle through variable dereferences).
const MAX_VARIABLE_DEREF_DEPTH: u32 = 1024;

/// Represents an error that occurs during evaluation of an arithmetic
/// expression.
#[derive(Debug, thiserror::Error)]
pub enum EvalError {
	/// Division by zero.
	#[error("division by zero")]
	DivideByZero,

	/// Negative exponent.
	#[error("exponent less than 0")]
	NegativeExponent,

	/// Failed to tokenize an arithmetic expression.
	#[error("failed to tokenize expression")]
	FailedToTokenizeExpression,

	/// Failed to expand an arithmetic expression.
	#[error("failed to expand expression: {0}")]
	FailedToExpandExpression(String),

	/// Failed to access an element of an array.
	#[error("failed to access array")]
	FailedToAccessArray,

	/// Failed to update the shell environment in an assignment operator.
	#[error("failed to update environment")]
	FailedToUpdateEnvironment,

	/// Failed to parse an arithmetic expression.
	#[error("failed to parse expression: {0}")]
	ParseError(String),

	/// Error expanding an unset variable.
	#[error("expanding unset variable: {0}")]
	ExpandingUnsetVariable(String),

	/// Expression recursion level exceeded.
	#[error("expression recursion level exceeded")]
	RecursionLimitExceeded,
}

/// Trait implemented by arithmetic expressions that can be evaluated.
pub(crate) trait ExpandAndEvaluate {
	/// Evaluate the given expression, returning the resulting numeric value.
	///
	/// # Arguments
	///
	/// * `shell` - The shell to use for evaluation.
	/// * `trace_if_needed` - Whether to trace the evaluation.
	async fn eval(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
		trace_if_needed: bool,
	) -> Result<i64, EvalError>;
}

impl ExpandAndEvaluate for ast::UnexpandedArithmeticExpr {
	async fn eval(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
		trace_if_needed: bool,
	) -> Result<i64, EvalError> {
		expand_and_eval(shell, params, self.value.as_str(), trace_if_needed).await
	}
}

/// Evaluate the given arithmetic expression, returning the resulting numeric
/// value.
///
/// # Arguments
///
/// * `shell` - The shell to use for evaluation.
/// * `expr` - The unexpanded arithmetic expression to evaluate.
/// * `trace_if_needed` - Whether to trace the evaluation.
pub(crate) async fn expand_and_eval(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	expr: &str,
	trace_if_needed: bool,
) -> Result<i64, EvalError> {
	// Per documentation, first shell-expand it.
	let options = expansion::ExpanderOptions { tilde_expand: false, ..Default::default() };
	let expanded_self = expansion::basic_expand_word_with_options(shell, params, expr, &options)
		.await
		.map_err(|_e| EvalError::FailedToExpandExpression(expr.to_owned()))?;

	// Now parse.
	let expr = brush_parser::arithmetic::parse(&expanded_self)
		.map_err(|_e| EvalError::ParseError(expanded_self))?;

	// Trace if applicable.
	if trace_if_needed && shell.options().print_commands_and_arguments {
		shell
			.trace_command(params, std::format!("(( {expr} ))"))
			.await;
	}

	// Now evaluate.
	expr.eval(shell)
}

/// Trait implemented by evaluatable arithmetic expressions.
pub trait Evaluatable {
	/// Evaluate the given arithmetic expression, returning the resulting numeric
	/// value.
	///
	/// # Arguments
	///
	/// * `shell` - The shell to use for evaluation.
	fn eval(&self, shell: &mut Shell<impl extensions::ShellExtensions>) -> Result<i64, EvalError>;
}

impl Evaluatable for ast::ArithmeticExpr {
	fn eval(&self, shell: &mut Shell<impl extensions::ShellExtensions>) -> Result<i64, EvalError> {
		eval_expr_impl(self, shell, 0)
	}
}

fn eval_expr_impl(
	expr: &ast::ArithmeticExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	depth: u32,
) -> Result<i64, EvalError> {
	let value = match expr {
		ast::ArithmeticExpr::Literal(l) => *l,
		ast::ArithmeticExpr::Reference(lvalue) => deref_lvalue(shell, lvalue, depth)?,
		ast::ArithmeticExpr::UnaryOp(op, operand) => apply_unary_op(shell, *op, operand, depth)?,
		ast::ArithmeticExpr::BinaryOp(op, left, right) => {
			apply_binary_op(shell, *op, left, right, depth)?
		},
		ast::ArithmeticExpr::Conditional(condition, then_expr, else_expr) => {
			let conditional_eval = eval_expr_impl(condition, shell, depth)?;

			// Ensure we only evaluate the branch indicated by the condition.
			if conditional_eval != 0 {
				eval_expr_impl(then_expr, shell, depth)?
			} else {
				eval_expr_impl(else_expr, shell, depth)?
			}
		},
		ast::ArithmeticExpr::Assignment(lvalue, rhs) => {
			let expr_eval = eval_expr_impl(rhs, shell, depth)?;
			assign(shell, lvalue, expr_eval, depth)?
		},
		ast::ArithmeticExpr::UnaryAssignment(op, lvalue) => {
			apply_unary_assignment_op(shell, lvalue, *op, depth)?
		},
		ast::ArithmeticExpr::BinaryAssignment(op, lvalue, operand) => {
			let value = apply_binary_op(
				shell,
				*op,
				&ast::ArithmeticExpr::Reference(lvalue.clone()),
				operand,
				depth,
			)?;
			assign(shell, lvalue, value, depth)?
		},
	};

	Ok(value)
}

fn get_var_value<'a>(
	shell: &'a Shell<impl extensions::ShellExtensions>,
	name: &str,
) -> Result<Cow<'a, str>, EvalError> {
	let value = shell.env_var(name).map(|var| var.resolve_value(shell));

	if let Some(value) = value
		&& value.is_set()
	{
		return Ok(value.to_cow_str(shell).to_string().into());
	}

	if shell.options().treat_unset_variables_as_error {
		return Err(EvalError::ExpandingUnsetVariable(name.into()));
	}

	Ok("".into())
}

fn deref_lvalue(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	lvalue: &ast::ArithmeticTarget,
	depth: u32,
) -> Result<i64, EvalError> {
	let value_str: Cow<'_, str> = match lvalue {
		ast::ArithmeticTarget::Variable(name) => get_var_value(shell, name.as_str())?,
		ast::ArithmeticTarget::ArrayElement(name, index_expr) => {
			let index_str = eval_expr_impl(index_expr, shell, depth)?.to_string();

			shell
				.env()
				.get(name)
				.map_or_else(|| Ok(None), |(_, v)| v.value().get_at(index_str.as_str(), shell))
				.map_err(|_err| EvalError::FailedToAccessArray)?
				.unwrap_or(Cow::Borrowed(""))
		},
	};

	let parsed_value = brush_parser::arithmetic::parse(value_str.as_ref())
		.map_err(|_err| EvalError::ParseError(value_str.to_string()))?;

	// Literals don't need depth tracking — they can't cause recursion.
	// Only increment depth when the parsed value requires further evaluation
	// (i.e., it references other variables), matching bash's behavior.
	if matches!(parsed_value, ast::ArithmeticExpr::Literal(_)) {
		return eval_expr_impl(&parsed_value, shell, depth);
	}

	let new_depth = depth + 1;
	if new_depth > MAX_VARIABLE_DEREF_DEPTH {
		return Err(EvalError::RecursionLimitExceeded);
	}

	eval_expr_impl(&parsed_value, shell, new_depth)
}

fn apply_unary_op(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	op: ast::UnaryOperator,
	operand: &ast::ArithmeticExpr,
	depth: u32,
) -> Result<i64, EvalError> {
	let operand_eval = eval_expr_impl(operand, shell, depth)?;

	match op {
		ast::UnaryOperator::UnaryPlus => Ok(operand_eval),
		ast::UnaryOperator::UnaryMinus => Ok(operand_eval.wrapping_neg()),
		ast::UnaryOperator::BitwiseNot => Ok(!operand_eval),
		ast::UnaryOperator::LogicalNot => Ok(bool_to_i64(operand_eval == 0)),
	}
}

fn apply_binary_op(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	op: ast::BinaryOperator,
	left: &ast::ArithmeticExpr,
	right: &ast::ArithmeticExpr,
	depth: u32,
) -> Result<i64, EvalError> {
	// First, special-case short-circuiting operators. For those, we need
	// to ensure we don't eagerly evaluate both operands. After we
	// get these out of the way, we can easily just evaluate operands
	// for the other operators.
	match op {
		ast::BinaryOperator::LogicalAnd => {
			let left = eval_expr_impl(left, shell, depth)?;
			if left == 0 {
				return Ok(bool_to_i64(false));
			}

			let right = eval_expr_impl(right, shell, depth)?;
			return Ok(bool_to_i64(right != 0));
		},
		ast::BinaryOperator::LogicalOr => {
			let left = eval_expr_impl(left, shell, depth)?;
			if left != 0 {
				return Ok(bool_to_i64(true));
			}

			let right = eval_expr_impl(right, shell, depth)?;
			return Ok(bool_to_i64(right != 0));
		},
		_ => (),
	}

	// The remaining operators unconditionally operate both operands.
	let left = eval_expr_impl(left, shell, depth)?;
	let right = eval_expr_impl(right, shell, depth)?;

	#[expect(clippy::cast_possible_truncation)]
	#[expect(clippy::cast_sign_loss)]
	match op {
		ast::BinaryOperator::Power => {
			if right >= 0 {
				Ok(wrapping_pow_u64(left, right as u64))
			} else {
				Err(EvalError::NegativeExponent)
			}
		},
		ast::BinaryOperator::Multiply => Ok(left.wrapping_mul(right)),
		ast::BinaryOperator::Divide => {
			if right == 0 {
				Err(EvalError::DivideByZero)
			} else {
				Ok(left.wrapping_div(right))
			}
		},
		ast::BinaryOperator::Modulo => {
			if right == 0 {
				Err(EvalError::DivideByZero)
			} else {
				Ok(left.wrapping_rem(right))
			}
		},
		ast::BinaryOperator::Comma => Ok(right),
		ast::BinaryOperator::Add => Ok(left.wrapping_add(right)),
		ast::BinaryOperator::Subtract => Ok(left.wrapping_sub(right)),
		ast::BinaryOperator::ShiftLeft => Ok(left.wrapping_shl(right as u32)),
		ast::BinaryOperator::ShiftRight => Ok(left.wrapping_shr(right as u32)),
		ast::BinaryOperator::LessThan => Ok(bool_to_i64(left < right)),
		ast::BinaryOperator::LessThanOrEqualTo => Ok(bool_to_i64(left <= right)),
		ast::BinaryOperator::GreaterThan => Ok(bool_to_i64(left > right)),
		ast::BinaryOperator::GreaterThanOrEqualTo => Ok(bool_to_i64(left >= right)),
		ast::BinaryOperator::Equals => Ok(bool_to_i64(left == right)),
		ast::BinaryOperator::NotEquals => Ok(bool_to_i64(left != right)),
		ast::BinaryOperator::BitwiseAnd => Ok(left & right),
		ast::BinaryOperator::BitwiseXor => Ok(left ^ right),
		ast::BinaryOperator::BitwiseOr => Ok(left | right),
		ast::BinaryOperator::LogicalAnd => unreachable!("LogicalAnd covered above"),
		ast::BinaryOperator::LogicalOr => unreachable!("LogicalOr covered above"),
	}
}

fn apply_unary_assignment_op(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	lvalue: &ast::ArithmeticTarget,
	op: ast::UnaryAssignmentOperator,
	depth: u32,
) -> Result<i64, EvalError> {
	let value = deref_lvalue(shell, lvalue, depth)?;

	match op {
		ast::UnaryAssignmentOperator::PrefixIncrement => {
			let new_value = value.wrapping_add(1);
			assign(shell, lvalue, new_value, depth)?;
			Ok(new_value)
		},
		ast::UnaryAssignmentOperator::PrefixDecrement => {
			let new_value = value.wrapping_sub(1);
			assign(shell, lvalue, new_value, depth)?;
			Ok(new_value)
		},
		ast::UnaryAssignmentOperator::PostfixIncrement => {
			let new_value = value.wrapping_add(1);
			assign(shell, lvalue, new_value, depth)?;
			Ok(value)
		},
		ast::UnaryAssignmentOperator::PostfixDecrement => {
			let new_value = value.wrapping_sub(1);
			assign(shell, lvalue, new_value, depth)?;
			Ok(value)
		},
	}
}

fn assign(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	lvalue: &ast::ArithmeticTarget,
	value: i64,
	depth: u32,
) -> Result<i64, EvalError> {
	match lvalue {
		ast::ArithmeticTarget::Variable(name) => {
			shell
				.env_mut()
				.update_or_add(
					name.as_str(),
					variables::ShellValueLiteral::Scalar(value.to_string()),
					|_| Ok(()),
					env::EnvironmentLookup::Anywhere,
					env::EnvironmentScope::Global,
				)
				.map_err(|_err| EvalError::FailedToUpdateEnvironment)?;
		},
		ast::ArithmeticTarget::ArrayElement(name, index_expr) => {
			let index_str = eval_expr_impl(index_expr, shell, depth)?.to_string();

			shell
				.env_mut()
				.update_or_add_array_element(
					name.as_str(),
					index_str,
					value.to_string(),
					|_| Ok(()),
					env::EnvironmentLookup::Anywhere,
					env::EnvironmentScope::Global,
				)
				.map_err(|_err| EvalError::FailedToUpdateEnvironment)?;
		},
	}

	Ok(value)
}

const fn bool_to_i64(value: bool) -> i64 {
	if value { 1 } else { 0 }
}

// N.B. We implement our own version of wrapping_pow that takes a 64-bit
// exponent. This seems to be the best way to guarantee that we handle overflow
// cases with exponents correctly.
const fn wrapping_pow_u64(mut base: i64, mut exponent: u64) -> i64 {
	let mut result: i64 = 1;

	while exponent > 0 {
		if exponent % 2 == 1 {
			result = result.wrapping_mul(base);
		}

		base = base.wrapping_mul(base);
		exponent /= 2;
	}

	result
}
