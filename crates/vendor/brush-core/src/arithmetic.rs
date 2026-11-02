//! Arithmetic evaluation

use std::borrow::Cow;

use brush_parser::ast;

use crate::{
	ExecutionParameters, Shell, env, expansion, extensions,
	variables::{self, ShellValue, ShellValueUnsetType},
};

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

	/// An indexed array's subscript that is not an expression or does not
	/// evaluate. Unlike other arithmetic errors, it ends the command line in
	/// an arithmetic command too, as in Bash.
	#[error("{0}: bad array subscript")]
	BadSubscript(Box<EvalError>),
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

/// How much native stack one arithmetic evaluation may use while it follows
/// variables whose values are expressions (`k='k+1'` evaluates `k` again and
/// again). Bash refuses such a chain at 1024 levels; here each level costs
/// several frames, and a worker thread's stack ended first, aborting the
/// process. Past this budget the chain is refused as Bash refuses one past
/// 1024 levels, possibly at fewer levels.
const MAX_DEREF_STACK_BYTES: usize = 256 * 1024;

thread_local! {
	/// Where on this thread's stack the outermost arithmetic evaluation began.
	static EVAL_STACK_BASE: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// An address on the current stack frame, to measure how deep evaluation is.
fn stack_position() -> usize {
	let marker = 0_u8;
	std::ptr::addr_of!(marker) as usize
}

/// Marks the outermost evaluation's stack base, and clears it when that
/// evaluation ends, by return or by unwinding.
struct EvalStackBase {
	outermost: bool,
}

impl EvalStackBase {
	fn enter() -> Self {
		let outermost = EVAL_STACK_BASE.with(|base| {
			let outermost = base.get().is_none();
			if outermost {
				base.set(Some(stack_position()));
			}
			outermost
		});
		Self { outermost }
	}
}

impl Drop for EvalStackBase {
	fn drop(&mut self) {
		if self.outermost {
			EVAL_STACK_BASE.with(|base| base.set(None));
		}
	}
}

/// Whether this evaluation has used more native stack than it may.
fn stack_exhausted() -> bool {
	EVAL_STACK_BASE.with(|base| {
		base.get().is_some_and(|base| base.abs_diff(stack_position()) > MAX_DEREF_STACK_BYTES)
	})
}

impl Evaluatable for ast::ArithmeticExpr {
	fn eval(&self, shell: &mut Shell<impl extensions::ShellExtensions>) -> Result<i64, EvalError> {
		let _base = EvalStackBase::enter();
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
			// As in Bash, the value first, then the subscript.
			let expr_eval = eval_expr_impl(rhs, shell, depth)?;
			let place = resolve_place(shell, lvalue, depth)?;
			assign(shell, place, expr_eval)?
		},
		ast::ArithmeticExpr::UnaryAssignment(op, lvalue) => {
			apply_unary_assignment_op(shell, lvalue, *op, depth)?
		},
		ast::ArithmeticExpr::BinaryAssignment(op, lvalue, operand) => {
			// The target's subscript is evaluated once, before the operand.
			let place = resolve_place(shell, lvalue, depth)?;
			let current = deref_place(shell, &place, depth)?;
			let value =
				apply_binary_op(shell, *op, &ast::ArithmeticExpr::Literal(current), operand, depth)?;
			assign(shell, place, value)?
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

/// An assignment target with its subscript already evaluated, so that reading
/// and then writing it (`a[i++] += 1`, `a[i++]++`) evaluates the subscript
/// once, as Bash does.
enum Place<'a> {
	Variable(&'a str),
	Element(&'a str, String),
}

fn resolve_place<'a>(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	lvalue: &'a ast::ArithmeticTarget,
	depth: u32,
) -> Result<Place<'a>, EvalError> {
	Ok(match lvalue {
		ast::ArithmeticTarget::Variable(name) => Place::Variable(name.as_str()),
		ast::ArithmeticTarget::ArrayElement(name, index_expr, subscript) => Place::Element(
			name.as_str(),
			element_key(shell, name, index_expr.as_deref(), subscript, depth)?,
		),
	})
}

fn deref_lvalue(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	lvalue: &ast::ArithmeticTarget,
	depth: u32,
) -> Result<i64, EvalError> {
	let place = resolve_place(shell, lvalue, depth)?;
	deref_place(shell, &place, depth)
}

fn deref_place(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	place: &Place<'_>,
	depth: u32,
) -> Result<i64, EvalError> {
	if stack_exhausted() {
		return Err(EvalError::RecursionLimitExceeded);
	}
	let value_str: Cow<'_, str> = match place {
		Place::Variable(name) => get_var_value(shell, name)?,
		Place::Element(name, key) => shell
			.env()
			.get(name)
			.map_or_else(|| Ok(None), |(_, v)| v.value().get_at(key.as_str(), shell))
			.map_err(|_err| EvalError::FailedToAccessArray)?
			.unwrap_or(Cow::Borrowed("")),
	};

	let mut depth = depth;
	let mut parsed_value = brush_parser::arithmetic::parse(value_str.as_ref())
		.map_err(|_err| EvalError::ParseError(value_str.to_string()))?;

	// A value that names another variable (`a=b`) is followed in a loop rather
	// than by recursion, so a cycle (`k=k`) meets the depth limit, as in Bash,
	// instead of the end of the native stack.
	while let ast::ArithmeticExpr::Reference(ast::ArithmeticTarget::Variable(next)) = &parsed_value {
		depth += 1;
		if depth > MAX_VARIABLE_DEREF_DEPTH {
			return Err(EvalError::RecursionLimitExceeded);
		}
		let text = get_var_value(shell, next.as_str())?.into_owned();
		parsed_value =
			brush_parser::arithmetic::parse(text.as_str()).map_err(|_err| EvalError::ParseError(text))?;
	}

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

/// The element `name[subscript]` names, as Bash takes it: an associative
/// array's key is the subscript as written (`m[k]` is key `k`, `m[i+1]` key
/// `i+1`, `m[src/a.ts]` key `src/a.ts`), and any other variable's index is
/// the subscript's value (`a[i+1]`), which a subscript that is not an
/// expression does not have. Only an index is evaluated, so only an index's
/// side effects happen. An index that fails is a bad subscript; an unset
/// variable under `set -u` and a failed expansion keep their own error.
fn element_key(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	name: &str,
	index_expr: Option<&ast::ArithmeticExpr>,
	subscript: &str,
	depth: u32,
) -> Result<String, EvalError> {
	let associative = shell.env().get(name).is_some_and(|(_, var)| {
		matches!(
			var.value(),
			ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
		)
	});

	if associative {
		return Ok(subscript.to_owned());
	}
	let index = match index_expr {
		Some(index_expr) => eval_expr_impl(index_expr, shell, depth),
		None => Err(EvalError::ParseError(subscript.to_owned())),
	};
	match index {
		Ok(index) => Ok(index.to_string()),
		Err(
			error @ (EvalError::ExpandingUnsetVariable(_)
			| EvalError::FailedToExpandExpression(_)
			| EvalError::BadSubscript(_)),
		) => Err(error),
		Err(error) => Err(EvalError::BadSubscript(Box::new(error))),
	}
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
	let place = resolve_place(shell, lvalue, depth)?;
	let value = deref_place(shell, &place, depth)?;

	let (new_value, result) = match op {
		ast::UnaryAssignmentOperator::PrefixIncrement => {
			let new_value = value.wrapping_add(1);
			(new_value, new_value)
		},
		ast::UnaryAssignmentOperator::PrefixDecrement => {
			let new_value = value.wrapping_sub(1);
			(new_value, new_value)
		},
		ast::UnaryAssignmentOperator::PostfixIncrement => (value.wrapping_add(1), value),
		ast::UnaryAssignmentOperator::PostfixDecrement => (value.wrapping_sub(1), value),
	};
	assign(shell, place, new_value)?;
	Ok(result)
}

fn assign(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	place: Place<'_>,
	value: i64,
) -> Result<i64, EvalError> {
	match place {
		Place::Variable(name) => {
			shell
				.env_mut()
				.update_or_add(
					name,
					variables::ShellValueLiteral::Scalar(value.to_string()),
					|_| Ok(()),
					env::EnvironmentLookup::Anywhere,
					env::EnvironmentScope::Global,
				)
				.map_err(|_err| EvalError::FailedToUpdateEnvironment)?;
		},
		Place::Element(name, key) => {
			shell
				.env_mut()
				.update_or_add_array_element(
					name,
					key,
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
