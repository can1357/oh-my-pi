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
		brush_parser::ast::TestExpr::And(left, right) => {
			Ok(eval_expr(left, shell, params).await? && eval_expr(right, shell, params).await?)
		},
		brush_parser::ast::TestExpr::Or(left, right) => {
			Ok(eval_expr(left, shell, params).await? || eval_expr(right, shell, params).await?)
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

#[cfg(test)]
mod regression {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
			mpsc,
		},
		time::Duration,
	};

	use tokio::sync::oneshot;
	use tokio_util::sync::CancellationToken;

	#[test]
	fn endless_builtin_loop_yields_to_a_cancellation_task() {
		let (result_tx, result_rx) = mpsc::sync_channel(1);

		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_multi_thread()
				.worker_threads(1)
				.enable_all()
				.build()
				.expect("runtime");
			let result = runtime.block_on(async {
				let cancellation = CancellationToken::new();
				let cancellation_task_ran = Arc::new(AtomicBool::new(false));
				let (loop_started_tx, loop_started_rx) = oneshot::channel();

				let loop_cancellation = cancellation.clone();
				let loop_task = tokio::spawn(async move {
					let mut shell = crate::Shell::builder().build().await.expect("shell");
					let mut params = shell.default_exec_params();
					params.set_cancel_token(loop_cancellation);
					loop_started_tx.send(()).expect("cancellation task waits for loop");
					shell
						.run_string(
							"while ((1)); do ((1)); done",
							&crate::SourceInfo::default(),
							&params,
						)
						.await
						.expect("loop parses")
						.is_success()
				});

				let cancellation_task_ran_in_task = cancellation_task_ran.clone();
				let cancellation_task = tokio::spawn(async move {
					loop_started_rx.await.expect("loop starts");
					cancellation_task_ran_in_task.store(true, Ordering::Release);
					cancellation.cancel();
				});

				let loop_succeeded = loop_task.await.expect("loop task");
				cancellation_task.await.expect("cancellation task");
				(!loop_succeeded, cancellation_task_ran.load(Ordering::Acquire))
			});
			result_tx.send(result).expect("test waits for runtime");
		});

		let (interrupted, cancellation_task_ran) = result_rx
			.recv_timeout(Duration::from_secs(2))
			.expect("interpreter did not yield to the cancellation task");
		assert!(cancellation_task_ran, "cancellation task ran on the interpreter runtime");
		assert!(interrupted, "the cancelled loop stopped");
	}
}
