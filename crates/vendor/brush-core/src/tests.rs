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
		future::Future,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
			mpsc,
		},
		time::Duration,
	};

	use tokio::sync::oneshot;
	use tokio_util::sync::CancellationToken;

	use crate::{Shell, extensions::DefaultShellExtensions};

	/// Runs `work` on a runtime with a single worker — the shape that turns a
	/// task holding its worker into a stall instead of a slowdown — and gives
	/// up after `timeout`.
	///
	/// A run that never finishes leaves its thread behind on purpose: a worker
	/// parked with no yield point cannot be taken back.
	fn on_single_worker<T, F>(
		timeout: Duration,
		work: impl FnOnce() -> F + Send + 'static,
	) -> Option<T>
	where
		T: Send + 'static,
		F: Future<Output = T>,
	{
		let (result_tx, result_rx) = mpsc::sync_channel(1);
		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_multi_thread()
				.worker_threads(1)
				.enable_all()
				.build()
				.expect("runtime");
			let _ = result_tx.send(runtime.block_on(work()));
		});
		result_rx.recv_timeout(timeout).ok()
	}

	/// Runs `command` on a single-worker runtime twice — once alone, once with
	/// a task that cancels it the moment it starts — and reports whether each
	/// run succeeded.
	///
	/// The cancelling task is ready before the run's first step, so the second
	/// answer turns on whether the run yields at all, not on how fast it is: a
	/// run that never yields keeps the only worker, nothing can set the token,
	/// and the run reports success as if nobody had asked it to stop.
	fn alone_and_cancelled_at_once(
		command: String,
		prepare: fn(&mut Shell<DefaultShellExtensions>),
	) -> (bool, bool) {
		let alone_command = command.clone();
		let alone = on_single_worker(Duration::from_secs(60), move || async move {
			let mut shell = Shell::builder().build().await.expect("shell");
			prepare(&mut shell);
			let params = shell.default_exec_params();
			shell
				.run_string(alone_command, &crate::SourceInfo::default(), &params)
				.await
				.is_ok_and(|result| result.is_success())
		})
		.expect("the uncancelled run finished");

		let cancelled = on_single_worker(Duration::from_secs(60), move || async move {
			let cancellation = CancellationToken::new();
			let (started_tx, started_rx) = oneshot::channel();

			let run_cancellation = cancellation.clone();
			let run_task = tokio::spawn(async move {
				let mut shell = Shell::builder().build().await.expect("shell");
				prepare(&mut shell);
				let mut params = shell.default_exec_params();
				params.set_cancel_token(run_cancellation);
				started_tx.send(()).expect("the cancelling task waits for the run");
				shell
					.run_string(command, &crate::SourceInfo::default(), &params)
					.await
					.is_ok_and(|result| result.is_success())
			});

			tokio::spawn(async move {
				started_rx.await.expect("run starts");
				cancellation.cancel();
			});

			run_task.await.expect("run task")
		})
		.expect("the cancelled run finished");

		(alone, cancelled)
	}

	#[test]
	fn endless_builtin_loop_yields_to_a_cancellation_task() {
		let cancellation_task_ran = Arc::new(AtomicBool::new(false));
		let ran_in_runtime = cancellation_task_ran.clone();

		let interrupted = on_single_worker(Duration::from_secs(2), move || async move {
			let cancellation = CancellationToken::new();
			let (loop_started_tx, loop_started_rx) = oneshot::channel();

			let loop_cancellation = cancellation.clone();
			let loop_task = tokio::spawn(async move {
				let mut shell = Shell::builder().build().await.expect("shell");
				let mut params = shell.default_exec_params();
				params.set_cancel_token(loop_cancellation);
				loop_started_tx.send(()).expect("cancellation task waits for loop");
				shell
					.run_string("while ((1)); do ((1)); done", &crate::SourceInfo::default(), &params)
					.await
					.expect("loop parses")
					.is_success()
			});

			let cancellation_task = tokio::spawn(async move {
				loop_started_rx.await.expect("loop starts");
				ran_in_runtime.store(true, Ordering::Release);
				cancellation.cancel();
			});

			let loop_succeeded = loop_task.await.expect("loop task");
			cancellation_task.await.expect("cancellation task");
			!loop_succeeded
		})
		.expect("interpreter did not yield to the cancellation task");

		assert!(
			cancellation_task_ran.load(Ordering::Acquire),
			"cancellation task ran on the interpreter runtime"
		);
		assert!(interrupted, "the cancelled loop stopped");
	}

	/// A `**` walk reads a native directory with synchronous calls, so until it
	/// spent the cooperative budget it never returned to the scheduler and ran
	/// to the end of the tree whatever its deadline said.
	#[test]
	fn globstar_walk_reaches_a_cancellation_task() {
		const ENTRIES: usize = 1024;

		let dir = tempfile::tempdir().expect("temp dir");
		for index in 0..ENTRIES {
			std::fs::write(dir.path().join(format!("entry-{index}")), b"").expect("fixture entry");
		}

		// The arithmetic command makes the uncancelled run prove it enumerated
		// the tree rather than merely exiting zero.
		let command =
			format!("matches=({}/**); (( ${{#matches[@]}} >= {ENTRIES} ))", dir.path().display());
		let outcome = alone_and_cancelled_at_once(command, |shell| {
			shell.options_mut().enable_star_star_glob = true;
		});

		assert_eq!(outcome, (true, false), "(uncancelled walked the tree, cancelled stopped)");
	}

	/// Brace expansion sets its own count: `{1..100000}` is one word in and a
	/// hundred thousand out, and every step that expands them is ready on a
	/// native filesystem, so the whole expansion ran before anything could stop
	/// it — and it runs before the `for` clause's own checkpoint.
	#[test]
	fn brace_expansion_reaches_a_cancellation_task() {
		const ELEMENTS: usize = 100_000;

		let outcome = alone_and_cancelled_at_once(
			format!("values=({{1..{ELEMENTS}}}); (( ${{#values[@]}} == {ELEMENTS} ))"),
			|_| {},
		);

		assert_eq!(outcome, (true, false), "(uncancelled expanded them all, cancelled stopped)");
	}

	/// A `case` scans its arms until one matches, expanding a pattern for each.
	/// The scan read the cancellation token on every arm but never yielded, so
	/// on one worker nothing could set that token while it ran.
	#[test]
	fn case_arm_scan_reaches_a_cancellation_task() {
		const ARMS: usize = 2048;

		let arms: String = (0..ARMS).map(|index| format!("miss{index}) ;;\n")).collect();
		let outcome = alone_and_cancelled_at_once(format!("case hit in\n{arms}esac"), |_| {});

		assert_eq!(outcome, (true, false), "(uncancelled scanned every arm, cancelled stopped)");
	}
}
