//! Arithmetic evaluation

use std::borrow::Cow;

use brush_parser::ast;

use crate::{ExecutionParameters, Shell, commands, env, expansion, extensions, interp};

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

	/// A parse handed to a blocking worker did not come back.
	#[error("the expression's parse was abandoned")]
	ParseAbandoned,

	/// The run evaluating the expression was cancelled at one of the
	/// evaluation's checkpoints. Reported as [`crate::error::ErrorKind::Interrupted`],
	/// not as an arithmetic error.
	#[error("interrupted")]
	Interrupted,
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
	// Per documentation, first shell-expand it — as the body of a double-quoted
	// word, as Bash expands arithmetic: a single quote in it is a character
	// no expression holds, so `$(( ' ' ))` and `x[' ']=v` are syntax errors as
	// in Bash, while the double quotes of `$(( "1"+2 ))` are removed. Taking
	// single quotes out first had turned `' '` into a blank expression, which
	// is zero.
	//
	// **An expression with nothing to expand is its own expansion.** Inside
	// double quotes only `$`, `` ` `` and `\` expand and `"` is removed, so
	// text without them comes out as it went in. The quotes added defeat the
	// expander's own test for such a word, so expanding it anyway parsed every
	// expression as a word, however short; with a clock read on every quoted
	// copy, that made arithmetic loops 29–55% slower than on the base.
	let expanded_self = if expr.len() <= interp::DIVIDE_COPY_ABOVE_BYTES
		&& !expr.contains(['$', '`', '\\', '"'])
	{
		expr.to_owned()
	} else {
		// Only a long text is copied in strides: a strided copy spends a
		// checkpoint that reads the thread's CPU clock, a system call.
		let mut quoted = String::with_capacity(expr.len() + 2);
		quoted.push('"');
		if expr.len() <= interp::DIVIDE_COPY_ABOVE_BYTES {
			quoted.push_str(expr);
		} else {
			interp::push_str_in_strides(params, &mut quoted, expr)
				.await
				.map_err(|_e| EvalError::FailedToExpandExpression(String::new()))?;
		}
		quoted.push('"');
		let options = expansion::ExpanderOptions { tilde_expand: false, ..Default::default() };
		expansion::basic_expand_word_with_options(shell, params, &quoted, &options)
			.await
			.map_err(|_e| EvalError::FailedToExpandExpression(expr.to_owned()))?
	};

	// Now parse.
	let expr = parse_expression(expanded_self).await?;

	// Trace if applicable.
	if trace_if_needed && shell.options().print_commands_and_arguments {
		shell
			.trace_command(params, std::format!("(( {expr} ))"))
			.await;
	}

	// Now evaluate.
	evaluate(shell, params, &expr).await
}

/// Evaluates text that is expanded already as an arithmetic expression,
/// without expanding it again: the value of a variable with the integer
/// attribute, as Bash evaluates it. `declare -i x='$y'` is a syntax error in
/// Bash, not the value of `y`, because the value was expanded once on its way
/// to the assignment.
///
/// `assigned` is the variable the value is being assigned to, when it is
/// assigned by name rather than as an element. Bash makes that variable
/// visible before it evaluates the value, so under `set -u` a reference to it
/// reads an unset variable as zero rather than failing: `set -u; declare -i
/// count; count=count+1` sets `count` to 1. Any other unset name still fails.
///
/// # Arguments
///
/// * `shell` - The shell to use for evaluation.
/// * `params` - The execution parameters of the run doing the evaluation.
/// * `assigned` - The variable being assigned by name, if any.
/// * `value` - The expanded value to evaluate.
pub async fn eval_expanded(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	assigned: Option<&str>,
	value: String,
) -> Result<i64, EvalError> {
	let expr = parse_expression(value).await?;
	Evaluator { shell, params, assigned, nodes: 0 }.run(&expr).await
}

/// Parses the arithmetic text a builtin was handed (`let`, a subscript given
/// to `unset`), with the parser's own error: in place, with the parser's
/// cache, up to [`PARSE_IN_PLACE_BYTES`], and otherwise from a copy made in
/// strides, without the cache, off the worker. `let` had parsed every
/// expression in place with the cache, whose key is the whole text: eight
/// distinct 8 MiB expressions peaked at 137 MB through `let` against 33 MB
/// through `declare -i`.
///
/// # Errors
///
/// Returns the parser's error for text that is not an expression,
/// [`crate::error::ErrorKind::Interrupted`] if the run is cancelled while the
/// text is copied, and [`crate::error::ErrorKind::ThreadingError`] if the
/// blocking worker did not run the parse.
pub async fn parse_for_builtin(
	params: &ExecutionParameters,
	text: &str,
) -> Result<ast::ArithmeticExpr, crate::error::Error> {
	if text.len() <= PARSE_IN_PLACE_BYTES {
		return Ok(brush_parser::arithmetic::parse(text)?);
	}
	let owned = interp::clone_in_strides(params, text).await?;
	match parse_uncached_off_worker(owned).await {
		Ok(Ok(parsed)) => Ok(parsed),
		Ok(Err((error, _text))) => Err(error.into()),
		Err(join_error) => Err(crate::error::ErrorKind::ThreadingError(join_error).into()),
	}
}

/// The longest expression parsed in place, on the runtime's worker.
///
/// The threshold is set by what a parse costs, not by what a copy does: the
/// grammar spends about as long on a byte as a case conversion does, so one
/// parse of 64 KiB of digits, the copy stride, held the worker a millisecond
/// quiet and three under load, once for every element of an integer array
/// literal. 8 KiB is the conversion's stride for the same reason
/// ([`crate::variables`]); every expression a script spells out is shorter.
const PARSE_IN_PLACE_BYTES: usize = 8 * 1024;

/// Parses an expanded arithmetic expression, off the runtime's worker when it
/// is longer than [`PARSE_IN_PLACE_BYTES`].
///
/// The parse is one call into a PEG with nothing inside that can yield, and
/// its cached form copies and hashes the whole expression for its key and
/// keeps it: `x=([$big]=v)` with 64 MiB of zeros held the worker for 155 ms
/// in one poll, and 368 ms under load, once its subscript became arithmetic.
/// A short expression is parsed where it is, with the cache; a longer one,
/// which can only be generated, is parsed on a blocking worker without the
/// cache, unless this is one already (see
/// [`commands::builtin_on_blocking_worker`]).
async fn parse_expression(expanded: String) -> Result<ast::ArithmeticExpr, EvalError> {
	if expanded.len() <= PARSE_IN_PLACE_BYTES {
		return brush_parser::arithmetic::parse(&expanded).map_err(|_e| EvalError::ParseError(expanded));
	}
	// The parse error names the text, so the text is kept for it.
	let parsed = parse_uncached_off_worker(expanded).await;
	match parsed {
		Ok(Ok(parsed)) => Ok(parsed),
		Ok(Err((_error, text))) => Err(EvalError::ParseError(text)),
		Err(_) => Err(EvalError::ParseAbandoned),
	}
}

/// What [`parse_uncached_off_worker`] returns: the expression, or the
/// parser's error and the text it could not parse.
type UncachedParse = Result<ast::ArithmeticExpr, (brush_parser::WordParseError, String)>;

/// Parses `text`, which is longer than [`PARSE_IN_PLACE_BYTES`], without the
/// parser's cache — on a blocking worker, or in place on a builtin that is on
/// one already ([`commands::builtin_on_blocking_worker`]). A panic in the
/// parse is resumed here.
async fn parse_uncached_off_worker(text: String) -> Result<UncachedParse, tokio::task::JoinError> {
	let parse = move || match brush_parser::arithmetic::parse_uncached(&text) {
		Ok(parsed) => Ok(parsed),
		Err(error) => Err((error, text)),
	};
	if commands::builtin_on_blocking_worker() {
		return Ok(parse());
	}
	match tokio::task::spawn_blocking(parse).await {
		Err(join_error) if join_error.is_panic() => std::panic::resume_unwind(join_error.into_panic()),
		other => other,
	}
}

/// Evaluates a parsed arithmetic expression, returning the resulting numeric
/// value.
///
/// # Arguments
///
/// * `shell` - The shell to use for evaluation.
/// * `params` - The execution parameters of the run doing the evaluation.
/// * `expr` - The expression to evaluate.
pub async fn evaluate(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	expr: &ast::ArithmeticExpr,
) -> Result<i64, EvalError> {
	Evaluator { shell, params, assigned: None, nodes: 0 }.run(expr).await
}

/// The referenced expressions one evaluation is inside, innermost last, kept
/// while their level is evaluated so that the steps evaluating them can
/// borrow them as they borrow the root.
///
/// **A referenced value that is itself an expression is evaluated on the
/// same explicit stack, not by a nested run.** A nested run is one more poll
/// on the thread's stack per level. A chain of references, such as a cycle,
/// is followed to [`MAX_VARIABLE_DEREF_DEPTH`] levels before it is refused,
/// and at that depth the nested runs overflowed a 2 MiB thread stack and
/// aborted the process.
///
/// **An expression is freed when its level is left**, as a nested run freed
/// it, so the evaluation holds no more of them than it is levels deep. Kept to
/// the end, an expression that reads one a million times would hold a million
/// of them, and free them all in one step.
#[derive(Default)]
struct Kept(std::cell::RefCell<Vec<std::sync::Arc<ast::ArithmeticExpr>>>);

impl Kept {
	/// Keeps `expr` until the matching [`Self::release`], returning it
	/// borrowed.
	fn keep(&self, expr: ast::ArithmeticExpr) -> &ast::ArithmeticExpr {
		let kept = std::sync::Arc::new(expr);
		let pointer = std::sync::Arc::as_ptr(&kept);
		self.0.borrow_mut().push(kept);
		// SAFETY: the value is in an allocation of its own, which the list
		// growing never moves, and nothing takes it mutably. It is freed only
		// with `self`, or by `release`, whose caller holds no reference to it
		// by then; so it lives, unchanged, as long as the reference returned
		// is held.
		unsafe { &*pointer }
	}

	/// Frees the expression kept last.
	///
	/// # Safety
	///
	/// The caller holds no reference [`Self::keep`] returned for it.
	unsafe fn release(&self) {
		drop(self.0.borrow_mut().pop());
	}
}

/// What reading a referenced value comes to: a number, or an expression to
/// evaluate one level deeper.
enum Read {
	Value(i64),
	Expression(ast::ArithmeticExpr),
}

/// One evaluation of a parsed expression: the shell it reads and writes, the
/// run it belongs to, and how many nodes it has evaluated.
///
/// **What an expression reads is not the expression.** A reference is a name,
/// so the expression around it is short, and the value it names can be an
/// expression of any length, which is parsed and evaluated in its turn:
/// `declare -i x; x=big`, with 64 MiB of zero digits in `big`, held the worker
/// 105 ms copying that value and parsing it in one step, and `x=([big]=v)`
/// 199 ms, while the expression that decided where to parse was three bytes.
/// So a referenced value is parsed where its own length allows
/// ([`parse_short`], [`parse_long`]), which can mean awaiting a blocking worker in the
/// middle of an evaluation, and the evaluation spends a checkpoint every
/// [`interp::ELEMENT_CHECKPOINT_STRIDE`] nodes, since a long expression is as
/// many nodes as it is long.
///
/// **An evaluation that can await allocates nothing per node.** The tree is
/// walked on an explicit stack of [`Step`]s, not by recursion: a recursive
/// `async` evaluator boxes a future at every node, and that cost arithmetic
/// 2.4–9.8% of its throughput on the gate machine. The stacks hold their first
/// [`INLINE_STEPS`] entries in place, so an ordinary expression allocates
/// nothing at all. A referenced value that is itself an expression
/// (`a=b+1; (( a ))`) is evaluated on the same stack one level deeper
/// ([`Kept`]).
struct Evaluator<'s, 'p, SE: extensions::ShellExtensions> {
	shell:    &'s mut Shell<SE>,
	params:   &'p ExecutionParameters,
	/// The variable being assigned by name, which `set -u` does not refuse
	/// to read ([`eval_expanded`]).
	assigned: Option<&'p str>,
	nodes:    usize,
}

/// A step [`Evaluator::run`] still has to take. A step that takes values takes
/// them from the top of the run's value stack; one that leaves a value leaves
/// it there.
#[derive(Clone, Copy)]
enum Step<'a> {
	/// Evaluate the node, leaving its value.
	Eval(&'a ast::ArithmeticExpr),
	/// Read the target's value as an expression, leaving its value.
	Deref(&'a ast::ArithmeticTarget),
	/// Take an element's index and read the element of the array named here,
	/// as [`Self::Deref`] reads a variable.
	DerefElement(&'a str),
	/// Take a value and leave the operator applied to it.
	Unary(ast::UnaryOperator),
	/// Take the right operand and then the left, and leave the operator
	/// applied to them.
	Binary(ast::BinaryOperator),
	/// Take the left operand and leave the operator applied to it and this
	/// literal right operand: `i < 100`, `n * 3`, the commonest shape, in one
	/// step instead of three.
	BinaryLiteral(ast::BinaryOperator, i64),
	/// Take the left operand of `&&`: leave `0`, or evaluate this right one as
	/// a truth value.
	And(&'a ast::ArithmeticExpr),
	/// Take the left operand of `||`: leave `1`, or evaluate this right one as
	/// a truth value.
	Or(&'a ast::ArithmeticExpr),
	/// Take a value and leave whether it is not zero.
	Truth,
	/// Take a condition and evaluate the branch it chooses.
	Branch(&'a ast::ArithmeticExpr, &'a ast::ArithmeticExpr),
	/// Assign the value on top to the target, leaving it there. An element's
	/// index is evaluated after the value, as Bash's side effects show.
	Assign(&'a ast::ArithmeticTarget),
	/// Take an element's index and assign the value below it to that element
	/// of the array named here, leaving the value.
	AssignElement(&'a str),
	/// Take the value a unary assignment read, assign the target its new
	/// value, and leave the operator's result.
	UnaryAssign(ast::UnaryAssignmentOperator, &'a ast::ArithmeticTarget),
	/// Take an element's index and then a new value, and assign the value to
	/// that element of the array named here; the result below them stays.
	UnaryAssignElement(&'a str),
	/// Leave a referenced value's expression, one level up, and free it
	/// ([`Kept::release`]).
	Leave,
}

/// How many entries a run's stacks hold in place before they spill to the
/// heap: deeper than any expression a script writes by hand.
const INLINE_STEPS: usize = 16;

/// A stack of `Copy` entries holding its first [`INLINE_STEPS`] in place, so
/// that a shallow evaluation never allocates. Entries past them go to
/// `spilled`, in order.
struct InlineStack<T: Copy> {
	inline:  [T; INLINE_STEPS],
	len:     usize,
	spilled: Vec<T>,
}

impl<T: Copy> InlineStack<T> {
	/// An empty stack, its places filled with `filler`, which is never read.
	fn new(filler: T) -> Self {
		Self { inline: [filler; INLINE_STEPS], len: 0, spilled: Vec::new() }
	}

	fn push(&mut self, entry: T) {
		if self.len < INLINE_STEPS {
			self.inline[self.len] = entry;
		} else {
			self.spilled.push(entry);
		}
		self.len += 1;
	}

	fn pop(&mut self) -> Option<T> {
		let top = self.len.checked_sub(1)?;
		self.len = top;
		if top < INLINE_STEPS { Some(self.inline[top]) } else { self.spilled.pop() }
	}

	fn top(&self) -> Option<T> {
		let top = self.len.checked_sub(1)?;
		if top < INLINE_STEPS { Some(self.inline[top]) } else { self.spilled.last().copied() }
	}
}

impl InlineStack<i64> {
	/// The value on top, which every step that takes one has after it a step
	/// that left one.
	fn take(&mut self) -> i64 {
		match self.pop() {
			Some(value) => value,
			None => unreachable!("a step took a value no earlier step left"),
		}
	}

	/// The value on top, left where it is.
	fn peek(&self) -> i64 {
		match self.top() {
			Some(value) => value,
			None => unreachable!("a step read a value no earlier step left"),
		}
	}
}

impl<SE: extensions::ShellExtensions> Evaluator<'_, '_, SE> {
	/// Evaluates `root` on explicit stacks, spending a checkpoint before every
	/// [`interp::ELEMENT_CHECKPOINT_STRIDE`]-th node.
	async fn run(&mut self, root: &ast::ArithmeticExpr) -> Result<i64, EvalError> {
		let kept = Kept::default();
		// How many referenced values the step being taken is inside.
		let mut depth: u32 = 0;
		let mut steps = InlineStack::new(Step::Truth);
		let mut values = InlineStack::new(0);
		steps.push(Step::Eval(root));

		while let Some(step) = steps.pop() {
			match step {
				Step::Eval(ast::ArithmeticExpr::Literal(value)) => values.push(*value),
				Step::Eval(expr) => {
					self.nodes += 1;
					if self.nodes % interp::ELEMENT_CHECKPOINT_STRIDE == 0 {
						interp::loop_checkpoint(self.params)
							.await
							.map_err(|_interrupted| EvalError::Interrupted)?;
					}
					// A plain reference, the commonest node, is read here rather
					// than scheduled.
					if let ast::ArithmeticExpr::Reference(ast::ArithmeticTarget::Variable(name)) = expr {
						let read = self.read_variable(name).await?;
						Self::enter(&kept, read, &mut depth, &mut steps, &mut values)?;
					} else {
						Self::schedule(&mut steps, expr);
					}
				},
				Step::Deref(ast::ArithmeticTarget::Variable(name)) => {
					let read = self.read_variable(name).await?;
					Self::enter(&kept, read, &mut depth, &mut steps, &mut values)?;
				},
				Step::Deref(ast::ArithmeticTarget::ArrayElement(name, index_expr)) => {
					steps.push(Step::DerefElement(name));
					steps.push(Step::Eval(index_expr));
				},
				Step::DerefElement(name) => {
					let index_str = values.take().to_string();
					let shell = &*self.shell;
					let text = shell
						.env()
						.get(name)
						.map_or_else(|| Ok(None), |(_, v)| v.value().get_at(index_str.as_str(), shell))
						.map_err(|_err| EvalError::FailedToAccessArray)?
						.unwrap_or(Cow::Borrowed(""));
					let referenced = parse_short(text)?;
					let read = resolve(self.params, referenced).await?;
					Self::enter(&kept, read, &mut depth, &mut steps, &mut values)?;
				},
				Step::Leave => {
					depth -= 1;
					// SAFETY: every step that borrows the expression this
					// level evaluated was pushed after this one, so all of them
					// have been taken, and the values are numbers.
					unsafe { kept.release() };
				},
				Step::Unary(op) => {
					let operand = values.take();
					values.push(apply_unary_op(op, operand));
				},
				Step::Binary(op) => {
					let right = values.take();
					let left = values.take();
					values.push(apply_binary_op(op, left, right)?);
				},
				Step::BinaryLiteral(op, right) => {
					let left = values.take();
					values.push(apply_binary_op(op, left, right)?);
				},
				Step::And(right) => {
					if values.take() == 0 {
						values.push(bool_to_i64(false));
					} else {
						steps.push(Step::Truth);
						steps.push(Step::Eval(right));
					}
				},
				Step::Or(right) => {
					if values.take() != 0 {
						values.push(bool_to_i64(true));
					} else {
						steps.push(Step::Truth);
						steps.push(Step::Eval(right));
					}
				},
				Step::Truth => {
					let value = values.take();
					values.push(bool_to_i64(value != 0));
				},
				Step::Branch(then_expr, else_expr) => {
					// Ensure we only evaluate the branch indicated by the condition.
					steps.push(Step::Eval(if values.take() != 0 { then_expr } else { else_expr }));
				},
				Step::Assign(ast::ArithmeticTarget::Variable(name)) => {
					self.assign_variable(name, values.peek())?;
				},
				Step::Assign(ast::ArithmeticTarget::ArrayElement(name, index_expr)) => {
					steps.push(Step::AssignElement(name));
					steps.push(Step::Eval(index_expr));
				},
				Step::AssignElement(name) => {
					let index_str = values.take().to_string();
					self.assign_element(name, index_str, values.peek())?;
				},
				Step::UnaryAssign(op, target) => {
					let value = values.take();
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
					match target {
						ast::ArithmeticTarget::Variable(name) => {
							self.assign_variable(name, new_value)?;
							values.push(result);
						},
						ast::ArithmeticTarget::ArrayElement(name, index_expr) => {
							values.push(result);
							values.push(new_value);
							steps.push(Step::UnaryAssignElement(name));
							steps.push(Step::Eval(index_expr));
						},
					}
				},
				Step::UnaryAssignElement(name) => {
					let index_str = values.take().to_string();
					let new_value = values.take();
					self.assign_element(name, index_str, new_value)?;
				},
			}
		}

		Ok(values.take())
	}

	/// Pushes the steps that evaluate `expr`, a node that is not a literal,
	/// so that they run in the order the recursive evaluation ran them: every
	/// operand left to right, each before the operator that takes it.
	fn schedule<'a>(steps: &mut InlineStack<Step<'a>>, expr: &'a ast::ArithmeticExpr) {
		match expr {
			ast::ArithmeticExpr::Literal(_) => steps.push(Step::Eval(expr)),
			ast::ArithmeticExpr::Reference(target) => steps.push(Step::Deref(target)),
			ast::ArithmeticExpr::UnaryOp(op, operand) => {
				steps.push(Step::Unary(*op));
				steps.push(Step::Eval(operand));
			},
			ast::ArithmeticExpr::BinaryOp(op, left, right) => {
				Self::schedule_binary(steps, *op, Step::Eval(left), right);
			},
			ast::ArithmeticExpr::Conditional(condition, then_expr, else_expr) => {
				steps.push(Step::Branch(then_expr, else_expr));
				steps.push(Step::Eval(condition));
			},
			ast::ArithmeticExpr::Assignment(target, rhs) => {
				steps.push(Step::Assign(target));
				steps.push(Step::Eval(rhs));
			},
			ast::ArithmeticExpr::UnaryAssignment(op, target) => {
				steps.push(Step::UnaryAssign(*op, target));
				steps.push(Step::Deref(target));
			},
			ast::ArithmeticExpr::BinaryAssignment(op, target, operand) => {
				// The target is read as the left operand, then assigned the
				// result, its index evaluated each time.
				steps.push(Step::Assign(target));
				Self::schedule_binary(steps, *op, Step::Deref(target), operand);
			},
		}
	}

	/// Pushes the steps of a binary operator whose left operand `left`
	/// evaluates. `&&` and `||` evaluate the right operand only if the left
	/// does not decide them.
	fn schedule_binary<'a>(
		steps: &mut InlineStack<Step<'a>>,
		op: ast::BinaryOperator,
		left: Step<'a>,
		right: &'a ast::ArithmeticExpr,
	) {
		match (op, right) {
			(ast::BinaryOperator::LogicalAnd, right) => steps.push(Step::And(right)),
			(ast::BinaryOperator::LogicalOr, right) => steps.push(Step::Or(right)),
			// A literal has no side effect, so evaluating it in the step that
			// applies the operator keeps the order.
			(op, ast::ArithmeticExpr::Literal(value)) => steps.push(Step::BinaryLiteral(op, *value)),
			(op, right) => {
				steps.push(Step::Binary(op));
				steps.push(Step::Eval(right));
			},
		}
		steps.push(left);
	}

	/// The value of the variable `name`, read as an expression. A value within
	/// [`PARSE_IN_PLACE_BYTES`] is parsed in place and a number needs nothing
	/// more, which is the usual case, and takes no await.
	async fn read_variable(&self, name: &str) -> Result<Read, EvalError> {
		let exempt = self.assigned == Some(name);
		let referenced = parse_short(referenced_text(self.shell, name, exempt)?)?;
		resolve(self.params, referenced).await
	}

	/// Leaves a referenced value's number, or schedules its expression one
	/// level deeper. Literals don't need depth tracking — they can't cause
	/// recursion — so only an expression counts a level, as in Bash, and one
	/// past [`MAX_VARIABLE_DEREF_DEPTH`] is refused.
	fn enter<'k>(
		kept: &'k Kept,
		read: Read,
		depth: &mut u32,
		steps: &mut InlineStack<Step<'k>>,
		values: &mut InlineStack<i64>,
	) -> Result<(), EvalError> {
		match read {
			Read::Value(value) => values.push(value),
			Read::Expression(expr) => {
				if *depth + 1 > MAX_VARIABLE_DEREF_DEPTH {
					return Err(EvalError::RecursionLimitExceeded);
				}
				*depth += 1;
				steps.push(Step::Leave);
				steps.push(Step::Eval(kept.keep(expr)));
			},
		}
		Ok(())
	}

	fn assign_variable(&mut self, name: &str, value: i64) -> Result<(), EvalError> {
		self.shell
			.env_mut()
			.update_or_add_scalar(
				name,
				value.to_string(),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)
			.map_err(|_err| EvalError::FailedToUpdateEnvironment)
	}

	fn assign_element(&mut self, name: &str, index: String, value: i64) -> Result<(), EvalError> {
		self.shell
			.env_mut()
			.update_or_add_array_element(
				name,
				index,
				value.to_string(),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)
			.map_err(|_err| EvalError::FailedToUpdateEnvironment)
	}
}

const fn apply_unary_op(op: ast::UnaryOperator, operand: i64) -> i64 {
	match op {
		ast::UnaryOperator::UnaryPlus => operand,
		ast::UnaryOperator::UnaryMinus => operand.wrapping_neg(),
		ast::UnaryOperator::BitwiseNot => !operand,
		ast::UnaryOperator::LogicalNot => bool_to_i64(operand == 0),
	}
}

/// A binary operator applied to both its operands: every one but `&&` and
/// `||`, which take their right operand only when the left does not decide
/// them, and which [`Evaluator::run`] applies itself.
fn apply_binary_op(op: ast::BinaryOperator, left: i64, right: i64) -> Result<i64, EvalError> {
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
		ast::BinaryOperator::LogicalAnd => Ok(bool_to_i64(left != 0 && right != 0)),
		ast::BinaryOperator::LogicalOr => Ok(bool_to_i64(left != 0 || right != 0)),
	}
}

/// The text the variable called `name` holds, read in place. Reading it
/// through [`crate::variables::ShellVariable::resolve_value`] copied the
/// whole value first, every element of an array included, to read one string
/// of it. An unset variable reads as empty, and fails under `set -u` unless
/// it is `exempt`, the variable being assigned.
fn referenced_text<'a>(
	shell: &'a Shell<impl extensions::ShellExtensions>,
	name: &str,
	exempt: bool,
) -> Result<Cow<'a, str>, EvalError> {
	if let Some(variable) = shell.env_var(name) {
		match variable.value_in_place(shell) {
			Cow::Borrowed(value) if value.is_set() => return Ok(value.to_cow_str(shell)),
			Cow::Owned(value) if value.is_set() => {
				return Ok(Cow::Owned(value.to_cow_str(shell).into_owned()));
			},
			_ => (),
		}
	}

	if shell.options().treat_unset_variables_as_error && !exempt {
		return Err(EvalError::ExpandingUnsetVariable(name.into()));
	}

	Ok("".into())
}

/// What the text a reference reads comes to, once parsed where that cannot
/// hold the worker.
enum Referenced<'a> {
	/// A number: the usual case.
	Value(i64),
	/// An expression, evaluated one level deeper on the same stack.
	Expression(ast::ArithmeticExpr),
	/// Text longer than [`PARSE_IN_PLACE_BYTES`], for [`parse_long`].
	Long(Cow<'a, str>),
}

/// Parses the text a reference reads in place, with the parser's cache, up
/// to [`PARSE_IN_PLACE_BYTES`]; longer text is left for [`parse_long`], which
/// parses it without the cache. **The gate is the length of the text parsed,
/// not of the expression that named it.**
fn parse_short(text: Cow<'_, str>) -> Result<Referenced<'_>, EvalError> {
	if text.len() > PARSE_IN_PLACE_BYTES {
		return Ok(Referenced::Long(text));
	}
	match brush_parser::arithmetic::parse(&text) {
		Ok(ast::ArithmeticExpr::Literal(value)) => Ok(Referenced::Value(value)),
		Ok(expr) => Ok(Referenced::Expression(expr)),
		Err(_e) => Err(EvalError::ParseError(text.into_owned())),
	}
}

/// Parses long referenced text as [`parse_expression`] parses a long
/// expression, from a copy made in strides.
async fn parse_long(params: &ExecutionParameters, text: Cow<'_, str>) -> Result<ast::ArithmeticExpr, EvalError> {
	let owned = match text {
		Cow::Owned(owned) => owned,
		Cow::Borrowed(borrowed) => interp::clone_in_strides(params, borrowed)
			.await
			.map_err(|_interrupted| EvalError::Interrupted)?,
	};
	parse_expression(owned).await
}

/// What a referenced value's text comes to, its long text parsed off the
/// worker.
async fn resolve(params: &ExecutionParameters, referenced: Referenced<'_>) -> Result<Read, EvalError> {
	Ok(match referenced {
		Referenced::Value(value) => Read::Value(value),
		Referenced::Expression(expr) => Read::Expression(expr),
		Referenced::Long(text) => match parse_long(params, text).await? {
			ast::ArithmeticExpr::Literal(value) => Read::Value(value),
			expr => Read::Expression(expr),
		},
	})
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

#[cfg(test)]
mod tests {
	use super::*;
	use crate::variables::{ShellValue, ShellVariable};

	async fn evaluated(shell: &mut Shell<crate::extensions::DefaultShellExtensions>, text: &str) -> i64 {
		let params = shell.default_exec_params();
		let expr = brush_parser::arithmetic::parse(text).expect("the expression parses");
		evaluate(shell, &params, &expr).await.expect("the expression evaluates")
	}

	fn value(shell: &Shell<crate::extensions::DefaultShellExtensions>, name: &str) -> String {
		shell.env().get_str(name, shell).map(|value| value.into_owned()).unwrap_or_default()
	}

	/// An expression deeper than the evaluator's inline stacks spills to the
	/// heap and still evaluates every operand once, left to right.
	#[tokio::test]
	async fn a_deep_expression_spills_and_keeps_its_order() {
		let mut shell = Shell::builder().build().await.expect("shell");
		shell.env_mut().set_global("i", ShellVariable::new(String::from("5"))).expect("i");
		let nested = (0..40).fold(String::from("i++"), |inner, _| std::format!("1+({inner})"));
		assert_eq!(evaluated(&mut shell, &nested).await, 45);
		assert_eq!(value(&shell, "i"), "6");

		let left_nested = (0..40).fold(String::from("i++"), |inner, _| std::format!("({inner})*1+i++"));
		// Each `i++` yields the value before it: 6 first, then 7 through 46.
		assert_eq!(evaluated(&mut shell, &left_nested).await, (6..=46).sum::<i64>());
		assert_eq!(value(&shell, "i"), "47");
	}

	/// Side effects run in the order the recursive evaluator ran them: a
	/// short-circuit's right operand only when needed, a conditional's chosen
	/// branch only, an element's index after the value assigned to it, and a
	/// compound assignment's index once to read and once to write.
	#[tokio::test]
	async fn side_effects_run_in_order() {
		let mut shell = Shell::builder().build().await.expect("shell");
		shell.env_mut().set_global("i", ShellVariable::new(String::from("0"))).expect("i");
		assert_eq!(evaluated(&mut shell, "0 && i++").await, 0);
		assert_eq!(evaluated(&mut shell, "1 || i++").await, 1);
		assert_eq!(value(&shell, "i"), "0");
		assert_eq!(evaluated(&mut shell, "i ? i++ : (i += 10)").await, 10);
		assert_eq!(value(&shell, "i"), "10");
		assert_eq!(evaluated(&mut shell, "a[i++] = i++").await, 10);
		assert_eq!(value(&shell, "i"), "12");
		assert_eq!(
			shell.env().get("a").and_then(|(_, a)| a.value().get_at("11", &shell).ok().flatten()).as_deref(),
			Some("10")
		);
		let three: std::collections::BTreeMap<u64, String> =
			[(0, "1"), (1, "2"), (2, "3")].into_iter().map(|(key, value)| (key, value.to_owned())).collect();
		shell
			.env_mut()
			.set_global("b", ShellVariable::new(ShellValue::IndexedArray(three)))
			.expect("b");
		shell.env_mut().set_global("j", ShellVariable::new(String::from("0"))).expect("j");
		// Read at `b[0]`, which is 1, and written at `b[1]`.
		assert_eq!(evaluated(&mut shell, "b[j++] += 5").await, 6);
		assert_eq!(value(&shell, "j"), "2");
		assert_eq!(
			shell.env().get("b").and_then(|(_, b)| b.value().get_at("1", &shell).ok().flatten()).as_deref(),
			Some("6")
		);
	}

	/// A referenced value that is itself an expression is evaluated one level
	/// deeper, and a cycle stops at the depth limit.
	#[tokio::test]
	async fn referenced_expressions_nest_and_stop() {
		let mut shell = Shell::builder().build().await.expect("shell");
		shell.env_mut().set_global("x", ShellVariable::new(String::from("y*2"))).expect("x");
		shell.env_mut().set_global("y", ShellVariable::new(String::from("3+z"))).expect("y");
		shell.env_mut().set_global("z", ShellVariable::new(String::from("4"))).expect("z");
		assert_eq!(evaluated(&mut shell, "x + 1").await, 15);

		shell.env_mut().set_global("p", ShellVariable::new(String::from("q"))).expect("p");
		shell.env_mut().set_global("q", ShellVariable::new(String::from("p"))).expect("q");
		let params = shell.default_exec_params();
		let expr = brush_parser::arithmetic::parse("p").expect("parses");
		assert!(matches!(
			evaluate(&mut shell, &params, &expr).await,
			Err(EvalError::RecursionLimitExceeded)
		));
	}

	/// A chain of references as deep as the limit needs no stack per level:
	/// on a thread with half a test thread's stack, 1,000 levels evaluate and
	/// a cycle is refused at the limit. Nesting a run per level overflowed a
	/// 2 MiB stack at the limit and aborted the process.
	#[test]
	fn reference_chains_take_no_stack_per_level() {
		let evaluation = std::thread::Builder::new()
			.stack_size(1024 * 1024)
			.spawn(|| {
				let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
				runtime.block_on(async {
					let mut shell = Shell::builder().build().await.expect("shell");
					for level in 0..1000 {
						let value = if level == 999 { String::from("7") } else { std::format!("v{}+0", level + 1) };
						shell.env_mut().set_global(std::format!("v{level}"), ShellVariable::new(value)).expect("v");
					}
					assert_eq!(evaluated(&mut shell, "v0").await, 7);

					shell.env_mut().set_global("p", ShellVariable::new(String::from("q"))).expect("p");
					shell.env_mut().set_global("q", ShellVariable::new(String::from("p"))).expect("q");
					let params = shell.default_exec_params();
					let expr = brush_parser::arithmetic::parse("p").expect("parses");
					assert!(matches!(
						evaluate(&mut shell, &params, &expr).await,
						Err(EvalError::RecursionLimitExceeded)
					));
				});
			})
			.expect("thread");
		evaluation.join().expect("the evaluation finished without overflowing its stack");
	}
}
