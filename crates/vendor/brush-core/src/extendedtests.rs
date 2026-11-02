use std::path::Path;

use brush_parser::ast;

use crate::{
	ExecutionParameters, Shell, ShellFd, arithmetic, env, error, escape, expansion, extensions,
	namedoptions, pathsearch, patterns, regex,
	sys::users,
	variables::{self, ArrayLiteral},
};

const S_ISUID: u32 = 0o4000;
const S_ISGID: u32 = 0o2000;
const S_ISVTX: u32 = 0o1000;

/// Metadata of `operand` (resolved against the shell's working directory),
/// following symlinks; `None` when it cannot be read.
async fn file_metadata(
	shell: &Shell<impl extensions::ShellExtensions>,
	operand: &str,
) -> Option<pi_vfs::Metadata> {
	shell
		.filesystem()
		.metadata(shell.absolute_path(Path::new(operand)))
		.await
		.ok()
}

/// Whether the current user may access `operand` in the requested ways.
async fn file_accessible(
	shell: &Shell<impl extensions::ShellExtensions>,
	operand: &str,
	read: bool,
	write: bool,
) -> bool {
	shell
		.filesystem()
		.access(shell.absolute_path(Path::new(operand)), read, write, false)
		.await
		.is_ok()
}

/// Evaluates a `[[ ]]` expression. Only an expression nested under `!`, in parentheses, or
/// as an operand of `&&` or `||` that is not a predicate goes through
/// [`eval_nested_extended_test_expr`], which allocates a boxed future per call.
pub(crate) async fn eval_extended_test_expr(
	expr: &ast::ExtendedTestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match expr {
		ast::ExtendedTestExpr::And(..) | ast::ExtendedTestExpr::Or(..) => {
			eval_extended_test_chain(expr, shell, params).await
		},
		ast::ExtendedTestExpr::Not(expr) => {
			let result = !eval_nested_extended_test_expr(expr, shell, params).await?;
			Ok(result)
		},
		ast::ExtendedTestExpr::Parenthesized(expr) => {
			eval_nested_extended_test_expr(expr, shell, params).await
		},
		ast::ExtendedTestExpr::UnaryTest(..) | ast::ExtendedTestExpr::BinaryTest(..) => {
			eval_chain_operand(expr, shell, params).await
		},
	}
}

#[async_recursion::async_recursion]
async fn eval_nested_extended_test_expr(
	expr: &ast::ExtendedTestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	eval_extended_test_expr(expr, shell, params).await
}

/// Evaluates `expr`, an `&&` or `||`, and those nested in its left operand.
///
/// `&&` and `||` nest to the left: `a && b || c` is `(a && b) || c`, and a chain of them is a
/// tree as deep as the chain is long. Its left operands are walked in a loop here, so only
/// right operands recurse, and those nest only as deeply as the expression does.
async fn eval_extended_test_chain(
	expr: &ast::ExtendedTestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	let (leftmost, chain) = RightOperands::collect(expr, |expr| match expr {
		ast::ExtendedTestExpr::And(left, right) => Some((true, &**left, &**right)),
		ast::ExtendedTestExpr::Or(left, right) => Some((false, &**left, &**right)),
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

/// Evaluates an operand of a chain. A predicate is evaluated here, in the caller's future;
/// anything else is nested, and recurses through a boxed future.
async fn eval_chain_operand(
	expr: &ast::ExtendedTestExpr,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match expr {
		ast::ExtendedTestExpr::UnaryTest(op, operand) => {
			apply_unary_predicate(op, operand, shell, params).await
		},
		ast::ExtendedTestExpr::BinaryTest(op, left, right) => {
			apply_binary_predicate(op, left, right, shell, params).await
		},
		_ => eval_nested_extended_test_expr(expr, shell, params).await,
	}
}

/// The right operands of a chain of `&&` and `||` (or `-a` and `-o`), outermost first, each
/// with whether its operator is `&&`. The first few are kept on the stack, so that the short
/// chains of everyday tests allocate nothing.
pub(crate) struct RightOperands<'a, E> {
	inline: [(bool, &'a E); 8],
	len: usize,
	spilled: Vec<(bool, &'a E)>,
}

impl<'a, E> RightOperands<'a, E> {
	/// Walks `expr` down its left operands while `split` takes a node apart into whether its
	/// operator is `&&`, its left operand and its right operand. Returns the leftmost operand
	/// and the right operands passed on the way.
	pub(crate) fn collect(
		expr: &'a E,
		split: impl Fn(&'a E) -> Option<(bool, &'a E, &'a E)>,
	) -> (&'a E, Self) {
		// The slots no operand is pushed to hold `expr`; they are never read.
		let mut chain = Self { inline: [(false, expr); 8], len: 0, spilled: Vec::new() };
		let mut leftmost = expr;
		while let Some((is_and, left, right)) = split(leftmost) {
			if let Some(slot) = chain.inline.get_mut(chain.len) {
				*slot = (is_and, right);
				chain.len += 1;
			} else {
				chain.spilled.push((is_and, right));
			}
			leftmost = left;
		}
		(leftmost, chain)
	}

	/// The right operands, innermost (first evaluated) first.
	pub(crate) fn innermost_first(&self) -> impl Iterator<Item = (bool, &'a E)> + '_ {
		self.spilled.iter().rev().chain(self.inline[..self.len].iter().rev()).copied()
	}
}

async fn apply_unary_predicate(
	op: &ast::UnaryPredicate,
	operand: &ast::Word,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	let expanded_operand = expansion::basic_expand_word(shell, params, operand).await?;

	if shell.options().print_commands_and_arguments {
		shell
			.trace_command(
				params,
				std::format!(
					"[[ {op} {} ]]",
					escape::quote_if_needed(&expanded_operand, escape::QuoteMode::SingleQuote)
				),
			)
			.await;
	}

	apply_unary_predicate_to_str(op, expanded_operand.as_str(), shell, params).await
}

#[expect(clippy::too_many_lines)]
pub(crate) async fn apply_unary_predicate_to_str(
	op: &ast::UnaryPredicate,
	operand: &str,
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match op {
		ast::UnaryPredicate::StringHasNonZeroLength => Ok(!operand.is_empty()),
		ast::UnaryPredicate::StringHasZeroLength => Ok(operand.is_empty()),
		ast::UnaryPredicate::FileExists => Ok(file_metadata(shell, operand).await.is_some()),
		ast::UnaryPredicate::FileExistsAndIsBlockSpecialFile => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.file_type().is_block_device())),
		ast::UnaryPredicate::FileExistsAndIsCharSpecialFile => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.file_type().is_char_device())),
		ast::UnaryPredicate::FileExistsAndIsDir => {
			Ok(file_metadata(shell, operand).await.is_some_and(|md| md.is_dir()))
		},
		ast::UnaryPredicate::FileExistsAndIsRegularFile => {
			Ok(file_metadata(shell, operand).await.is_some_and(|md| md.is_file()))
		},
		ast::UnaryPredicate::FileExistsAndIsSetgid => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.mode() & S_ISGID != 0)),
		ast::UnaryPredicate::FileExistsAndIsSymlink => {
			let path = shell.absolute_path(Path::new(operand));
			Ok(shell.filesystem().is_symlink(path).await)
		},
		ast::UnaryPredicate::FileExistsAndHasStickyBit => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.mode() & S_ISVTX != 0)),
		ast::UnaryPredicate::FileExistsAndIsFifo => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.file_type().is_fifo())),
		ast::UnaryPredicate::FileExistsAndIsReadable => {
			Ok(file_accessible(shell, operand, true, false).await)
		},
		ast::UnaryPredicate::FileExistsAndIsNotZeroLength => {
			Ok(file_metadata(shell, operand).await.is_some_and(|md| md.len() > 0))
		},
		ast::UnaryPredicate::FdIsOpenTerminal => {
			// Trim whitespace before parsing, matching bash behavior.
			if let Ok(fd) = operand.trim().parse::<ShellFd>() {
				if let Some(open_file) = params.try_fd(shell, fd) {
					Ok(open_file.is_terminal())
				} else {
					Ok(false)
				}
			} else {
				Ok(false)
			}
		},
		ast::UnaryPredicate::FileExistsAndIsSetuid => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.mode() & S_ISUID != 0)),
		ast::UnaryPredicate::FileExistsAndIsWritable => {
			Ok(file_accessible(shell, operand, false, true).await)
		},
		ast::UnaryPredicate::FileExistsAndIsExecutable => {
			let path = shell.absolute_path(Path::new(operand));
			Ok(pathsearch::is_executable(shell.filesystem(), &path).await)
		},
		ast::UnaryPredicate::FileExistsAndOwnedByEffectiveGroupId => {
			let Some(md) = file_metadata(shell, operand).await else {
				return Ok(false);
			};
			// A file whose owner the filesystem does not report is not ours.
			let Some(gid) = md.gid() else {
				return Ok(false);
			};
			Ok(gid == users::get_effective_gid()?)
		},
		ast::UnaryPredicate::FileExistsAndModifiedSinceLastRead => {
			let Some(md) = file_metadata(shell, operand).await else {
				return Ok(false);
			};
			Ok(md.modified()? > md.accessed()?)
		},
		ast::UnaryPredicate::FileExistsAndOwnedByEffectiveUserId => {
			let Some(md) = file_metadata(shell, operand).await else {
				return Ok(false);
			};
			// A file whose owner the filesystem does not report is not ours.
			let Some(uid) = md.uid() else {
				return Ok(false);
			};
			Ok(uid == users::get_effective_uid()?)
		},
		ast::UnaryPredicate::FileExistsAndIsSocket => Ok(file_metadata(shell, operand)
			.await
			.is_some_and(|md| md.file_type().is_socket())),
		ast::UnaryPredicate::ShellOptionEnabled => {
			let shopt_name = operand;
			if let Some(option) =
				namedoptions::options(namedoptions::ShellOptionKind::SetO).get(shopt_name)
			{
				Ok(option.get(shell.options()))
			} else {
				Ok(false)
			}
		},
		ast::UnaryPredicate::ShellVariableIsSetAndAssigned => Ok(shell.env().is_set(operand)),
		ast::UnaryPredicate::ShellVariableIsSetAndNameRef => match shell.env().get(operand) {
			Some((_, reffed)) => Ok(reffed.value().is_set() && reffed.is_treated_as_nameref()),
			None => Ok(false),
		},
	}
}

#[expect(clippy::too_many_lines)]
async fn apply_binary_predicate(
	op: &ast::BinaryPredicate,
	left: &ast::Word,
	right: &ast::Word,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<bool, error::Error> {
	match op {
		ast::BinaryPredicate::StringMatchesRegex => {
			let s = expansion::basic_expand_word(shell, params, left).await?;
			let regex = expansion::basic_expand_regex(shell, params, right)
				.await?
				.set_multiline(true);

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {s} {op} {right} ]]"))
					.await;
			}

			let (matches, captures) = match regex.matches(s.as_str()) {
				Ok(Some(captures)) => (true, captures),
				Ok(None) => (false, vec![]),
				// If we can't compile the regex, don't abort the whole operation but make sure to
				// report it.
				// TODO(test): Docs indicate we should yield 2 on an invalid regex (not 1).
				Err(e) => {
					tracing::warn!("error using regex: {}", e);
					(false, vec![])
				},
			};

			let captures_value = variables::ShellValueLiteral::Array(ArrayLiteral(
				captures
					.into_iter()
					.map(|c| (None, c.unwrap_or_default()))
					.collect(),
			));

			shell.env_mut().update_or_add(
				"BASH_REMATCH",
				captures_value,
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;

			Ok(matches)
		},
		ast::BinaryPredicate::StringExactlyMatchesString => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left == right)
		},
		ast::BinaryPredicate::StringDoesNotExactlyMatchString => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left != right)
		},
		ast::BinaryPredicate::StringContainsSubstring => {
			let s = expansion::basic_expand_word(shell, params, left).await?;
			let substring = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {s} {op} {substring} ]]"))
					.await;
			}

			Ok(s.contains(substring.as_str()))
		},
		ast::BinaryPredicate::FilesReferToSameDeviceAndInodeNumbers => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			files_refer_to_same_device_and_inode_numbers(shell, &left, &right).await
		},
		ast::BinaryPredicate::LeftFileIsNewerOrExistsWhenRightDoesNot => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			left_file_is_newer_or_exists_when_right_does_not(shell, &left, &right).await
		},
		ast::BinaryPredicate::LeftFileIsOlderOrDoesNotExistWhenRightDoes => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			left_file_is_older_or_does_not_exist_when_right_does(shell, &left, &right).await
		},
		ast::BinaryPredicate::LeftSortsBeforeRight => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			// TODO(test): According to docs, should be lexicographical order of the current
			// locale.
			Ok(left < right)
		},
		ast::BinaryPredicate::LeftSortsAfterRight => {
			let left = expansion::basic_expand_word(shell, params, left).await?;
			let right = expansion::basic_expand_word(shell, params, right).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			// TODO(test): According to docs, should be lexicographical order of the current
			// locale.
			Ok(left > right)
		},
		ast::BinaryPredicate::ArithmeticEqualTo => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left == right)
		},
		ast::BinaryPredicate::ArithmeticNotEqualTo => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left != right)
		},
		ast::BinaryPredicate::ArithmeticLessThan => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left < right)
		},
		ast::BinaryPredicate::ArithmeticLessThanOrEqualTo => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left <= right)
		},
		ast::BinaryPredicate::ArithmeticGreaterThan => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left > right)
		},
		ast::BinaryPredicate::ArithmeticGreaterThanOrEqualTo => {
			let left = arithmetic::expand_and_eval(shell, params, left.value.as_str(), false).await?;
			let right =
				arithmetic::expand_and_eval(shell, params, right.value.as_str(), false).await?;

			if shell.options().print_commands_and_arguments {
				shell
					.trace_command(params, std::format!("[[ {left} {op} {right} ]]"))
					.await;
			}

			Ok(left >= right)
		},
		// N.B. The "=", "==", and "!=" operators don't compare 2 strings; they check
		// for whether the lefthand operand (a string) is matched by the righthand
		// operand (treated as a shell pattern).
		// TODO(test): implement case-insensitive matching if relevant via shopt options
		// (nocasematch).
		ast::BinaryPredicate::StringExactlyMatchesPattern => {
			let s = expansion::basic_expand_word(shell, params, left).await?;
			let pattern = expansion::basic_expand_pattern(shell, params, right)
				.await?
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_conditionals);

			if shell.options().print_commands_and_arguments {
				let expanded_right = expansion::basic_expand_word(shell, params, right).await?;
				let escaped_right =
					escape::quote_if_needed(expanded_right.as_str(), escape::QuoteMode::BackslashEscape);
				shell
					.trace_command(params, std::format!("[[ {s} {op} {escaped_right} ]]"))
					.await;
			}

			pattern.exactly_matches(s.as_str())
		},
		ast::BinaryPredicate::StringDoesNotExactlyMatchPattern => {
			let s = expansion::basic_expand_word(shell, params, left).await?;
			let pattern = expansion::basic_expand_pattern(shell, params, right)
				.await?
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_conditionals);

			if shell.options().print_commands_and_arguments {
				let expanded_right = expansion::basic_expand_word(shell, params, right).await?;
				let escaped_right =
					escape::quote_if_needed(expanded_right.as_str(), escape::QuoteMode::BackslashEscape);
				shell
					.trace_command(params, std::format!("[[ {s} {op} {escaped_right} ]]"))
					.await;
			}

			let eq = pattern.exactly_matches(s.as_str())?;
			Ok(!eq)
		},
	}
}

pub(crate) async fn apply_binary_predicate_to_strs(
	op: &ast::BinaryPredicate,
	left: &str,
	right: &str,
	shell: &Shell<impl extensions::ShellExtensions>,
) -> Result<bool, error::Error> {
	match op {
		ast::BinaryPredicate::FilesReferToSameDeviceAndInodeNumbers => {
			files_refer_to_same_device_and_inode_numbers(shell, left, right).await
		},
		ast::BinaryPredicate::LeftFileIsNewerOrExistsWhenRightDoesNot => {
			left_file_is_newer_or_exists_when_right_does_not(shell, left, right).await
		},
		ast::BinaryPredicate::LeftFileIsOlderOrDoesNotExistWhenRightDoes => {
			left_file_is_older_or_does_not_exist_when_right_does(shell, left, right).await
		},
		ast::BinaryPredicate::LeftSortsBeforeRight => {
			// TODO(test): According to docs, should be lexicographical order of the current
			// locale.
			Ok(left < right)
		},
		ast::BinaryPredicate::LeftSortsAfterRight => {
			// TODO(test): According to docs, should be lexicographical order of the current
			// locale.
			Ok(left > right)
		},
		ast::BinaryPredicate::ArithmeticEqualTo => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left == right))
		},
		ast::BinaryPredicate::ArithmeticNotEqualTo => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left != right))
		},
		ast::BinaryPredicate::ArithmeticLessThan => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left < right))
		},
		ast::BinaryPredicate::ArithmeticLessThanOrEqualTo => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left <= right))
		},
		ast::BinaryPredicate::ArithmeticGreaterThan => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left > right))
		},
		ast::BinaryPredicate::ArithmeticGreaterThanOrEqualTo => {
			Ok(apply_test_binary_arithmetic_predicate(left, right, |left, right| left >= right))
		},
		ast::BinaryPredicate::StringExactlyMatchesPattern => {
			let pattern = patterns::Pattern::from(right)
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_conditionals);

			pattern.exactly_matches(left)
		},
		ast::BinaryPredicate::StringDoesNotExactlyMatchPattern => {
			let pattern = patterns::Pattern::from(right)
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_conditionals);

			let eq = pattern.exactly_matches(left)?;
			Ok(!eq)
		},
		ast::BinaryPredicate::StringExactlyMatchesString => Ok(left == right),
		ast::BinaryPredicate::StringDoesNotExactlyMatchString => Ok(left != right),
		ast::BinaryPredicate::StringContainsSubstring => Ok(left.contains(right)),
		ast::BinaryPredicate::StringMatchesRegex => {
			let re = regex::compile_regex(
				right.to_owned(),
				shell.options().case_insensitive_conditionals,
				true,
			)?;
			Ok(re.is_match(left)?)
		},
	}
}

fn apply_test_binary_arithmetic_predicate(
	left: &str,
	right: &str,
	op: fn(i64, i64) -> bool,
) -> bool {
	// We trim leading/trailing whitespace (including newlines) before parsing
	// integers.
	let left: Result<i64, _> = left.trim().parse();
	let right: Result<i64, _> = right.trim().parse();

	if let (Ok(left), Ok(right)) = (left, right) {
		op(left, right)
	} else {
		false
	}
}

async fn left_file_is_older_or_does_not_exist_when_right_does(
	shell: &Shell<impl extensions::ShellExtensions>,
	left: &str,
	right: &str,
) -> Result<bool, error::Error> {
	match (file_metadata(shell, left).await, file_metadata(shell, right).await) {
		(Some(m1), Some(m2)) => Ok(m1.modified()? < m2.modified()?),
		(None, Some(_)) => Ok(true),
		_ => Ok(false),
	}
}

async fn left_file_is_newer_or_exists_when_right_does_not(
	shell: &Shell<impl extensions::ShellExtensions>,
	left: &str,
	right: &str,
) -> Result<bool, error::Error> {
	match (file_metadata(shell, left).await, file_metadata(shell, right).await) {
		(Some(m1), Some(m2)) => Ok(m1.modified()? > m2.modified()?),
		(Some(_), None) => Ok(true),
		_ => Ok(false),
	}
}

async fn files_refer_to_same_device_and_inode_numbers(
	shell: &Shell<impl extensions::ShellExtensions>,
	left: &str,
	right: &str,
) -> Result<bool, error::Error> {
	if !file_accessible(shell, left, true, false).await
		|| !file_accessible(shell, right, true, false).await
	{
		return Ok(false);
	}

	// Identity comes from the filesystem; paths it cannot identify are never
	// the same file.
	Ok(shell
		.filesystem()
		.same_file(shell.absolute_path(Path::new(left)), shell.absolute_path(Path::new(right)))
		.await?)
}
