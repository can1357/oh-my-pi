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
		borrow::Cow,
		future::Future,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
			mpsc,
		},
		time::Duration,
	};

	use itertools::Itertools;
	use tokio::sync::oneshot;
	use tokio_util::sync::CancellationToken;

	use crate::{
		ExecutionResult, Shell, ShellValue, ShellVariable, builtins, commands, error,
		extensions::{self, DefaultShellExtensions},
	};

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

	/// Runs `command` alone on a single-worker runtime and reports whether it
	/// succeeded.
	fn alone(command: String, prepare: fn(&mut Shell<DefaultShellExtensions>)) -> bool {
		on_single_worker(Duration::from_secs(60), move || async move {
			let mut shell = Shell::builder().build().await.expect("shell");
			prepare(&mut shell);
			let params = shell.default_exec_params();
			shell
				.run_string(command, &crate::SourceInfo::default(), &params)
				.await
				.is_ok_and(|result| result.is_success())
		})
		.expect("the uncancelled run finished")
	}

	/// Runs `command` on a single-worker runtime with a task that cancels it
	/// the moment it starts, and reports whether it succeeded and what
	/// `inspect` then reads from its shell.
	///
	/// The cancelling task is ready before the run's first step, so the answer
	/// turns on whether the run yields at all, not on how fast it is: a run
	/// that never yields keeps the only worker, nothing can set the token, and
	/// the run reports success as if nobody had asked it to stop.
	fn cancelled_at_once<T: Send + 'static>(
		command: String,
		prepare: fn(&mut Shell<DefaultShellExtensions>),
		inspect: fn(&Shell<DefaultShellExtensions>) -> T,
	) -> (bool, T) {
		on_single_worker(Duration::from_secs(60), move || async move {
			let cancellation = CancellationToken::new();
			let (started_tx, started_rx) = oneshot::channel();

			let run_cancellation = cancellation.clone();
			let run_task = tokio::spawn(async move {
				let mut shell = Shell::builder().build().await.expect("shell");
				prepare(&mut shell);
				let mut params = shell.default_exec_params();
				params.set_cancel_token(run_cancellation);
				started_tx.send(()).expect("the cancelling task waits for the run");
				let succeeded = shell
					.run_string(command, &crate::SourceInfo::default(), &params)
					.await
					.is_ok_and(|result| result.is_success());
				(succeeded, inspect(&shell))
			});

			tokio::spawn(async move {
				started_rx.await.expect("run starts");
				cancellation.cancel();
			});

			run_task.await.expect("run task")
		})
		.expect("the cancelled run finished")
	}

	/// Runs `command` twice — [`alone`], then [`cancelled_at_once`] — and
	/// reports whether each run succeeded.
	fn alone_and_cancelled_at_once(
		command: String,
		prepare: fn(&mut Shell<DefaultShellExtensions>),
	) -> (bool, bool) {
		(alone(command.clone(), prepare), cancelled_at_once(command, prepare, |_| ()).0)
	}

	/// How many `[key]=value` elements the keyed array tests assign.
	const KEYED_ELEMENTS: usize = 2048;

	/// `[0]=v0 [1]=v1 …`: keys and values with no expansion character in them.
	fn keyed_elements() -> String {
		(0..KEYED_ELEMENTS).map(|index| format!("[{index}]=v{index}")).join(" ")
	}

	/// Stands in for `declare`, which the bare shell lacks: a declaration
	/// builtin that succeeds when its last argument carries every keyed
	/// element.
	struct DeclaresKeyedElements;

	impl builtins::SimpleCommand for DeclaresKeyedElements {
		fn get_content(
			_name: &str,
			_content_type: builtins::ContentType,
			_options: &builtins::ContentOptions,
		) -> Result<String, error::Error> {
			Ok(String::new())
		}

		fn execute<SE: extensions::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
			_context: commands::ExecutionContext<'_, SE>,
			args: I,
		) -> Result<ExecutionResult, error::Error> {
			let elements = args.last().map_or(0, |arg| arg.as_ref().matches("]=").count());
			Ok(if elements == KEYED_ELEMENTS {
				ExecutionResult::success()
			} else {
				ExecutionResult::general_error()
			})
		}
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

	/// One `case` arm can carry any number of alternatives (`a|b|…)`), and a
	/// generator writes them as readily as arms. The arm checkpoint above runs
	/// once for the whole list, so this pins the one per alternative.
	#[test]
	fn case_alternatives_reach_a_cancellation_task() {
		const ALTERNATIVES: usize = 2048;

		let alternatives: String = (0..ALTERNATIVES).map(|index| format!("miss{index}|")).collect();
		// The match comes last, so the uncancelled run proves it tried them all.
		let outcome = alone_and_cancelled_at_once(
			format!("case hit in\n{alternatives}hit) matched=1 ;;\nesac\n(( matched == 1 ))"),
			|_| {},
		);

		assert_eq!(outcome, (true, false), "(uncancelled reached the last alternative, cancelled stopped)");
	}

	/// A keyed element (`[k]=v`) expands its key and value as assignment
	/// words, which take a short cut past every expansion checkpoint when they
	/// hold no expansion character. A plain element (the brace tests) goes
	/// through field splitting and its checkpoint instead.
	#[test]
	fn keyed_array_assignment_reaches_a_cancellation_task() {
		let outcome = alone_and_cancelled_at_once(
			format!("values=({}); (( ${{#values[@]}} == {KEYED_ELEMENTS} ))", keyed_elements()),
			|_| {},
		);

		assert_eq!(outcome, (true, false), "(uncancelled assigned them all, cancelled stopped)");
	}

	/// A declaration builtin (`declare`, `local`, `export`, …) has its array
	/// literal expanded on a path of its own, before the builtin runs; the
	/// plain assignment above never reaches it.
	#[test]
	fn declared_keyed_array_reaches_a_cancellation_task() {
		let outcome =
			alone_and_cancelled_at_once(format!("declares values=({})", keyed_elements()), |shell| {
				shell.register_builtin("declares", builtins::Registration {
					declaration_builtin: true,
					..builtins::simple_builtin::<DeclaresKeyedElements, DefaultShellExtensions>()
				});
			});

		assert_eq!(outcome, (true, false), "(uncancelled declared them all, cancelled stopped)");
	}

	/// The brace generator makes every element before the first is expanded,
	/// so the element checkpoint that `brace_expansion_reaches_a_cancellation_task`
	/// pins comes only after all of `{1..N}` exists. Each element here bumps
	/// `n` as it is expanded, so a run that yields inside the generator is
	/// cancelled before `n` is ever set; one that yields only in the element
	/// loop has already expanded a budget's worth.
	#[test]
	fn brace_generator_reaches_a_cancellation_task() {
		const ELEMENTS: usize = 4096;

		let command = format!(
			"values=({{1..{ELEMENTS}}}$((n++))); (( ${{#values[@]}} == {ELEMENTS} && n == {ELEMENTS} ))"
		);
		assert!(alone(command.clone(), |_| {}), "the uncancelled run expanded every element");

		let outcome = cancelled_at_once(command, |_| {}, |shell| {
			shell.env().get_str("n", shell).map(Cow::into_owned)
		});
		assert_eq!(outcome, (false, None), "(cancelled stopped, before expanding any element)");
	}

	/// Field splitting walks the expanded text a character at a time before
	/// the per-field loop runs. One long field with no IFS character in it
	/// has no field boundary at all, so only a checkpoint inside that walk can
	/// yield; every field in the brace tests is short.
	#[test]
	fn field_splitting_reaches_a_cancellation_task() {
		const LENGTH: usize = 1 << 20;

		let outcome = alone_and_cancelled_at_once(
			format!("values=($long); (( ${{#values[@]}} == 1 && ${{#values[0]}} == {LENGTH} ))"),
			|shell| {
				shell
					.env_mut()
					.set_global("long", ShellVariable::new(ShellValue::String("x".repeat(LENGTH))))
					.expect("long value");
				// Globbing would scan the field once more; this test is about splitting.
				shell.options_mut().disable_filename_globbing = true;
			},
		);

		assert_eq!(outcome, (true, false), "(uncancelled split it, cancelled stopped)");
	}

	/// A pipeline starts its stages one after another, and a stage that is
	/// only an assignment completes in place, so nothing in a long pipeline of
	/// them waited on anything.
	#[test]
	fn pipeline_stages_reach_a_cancellation_task() {
		// Each stage boundary holds a pipe open until the stages start, so the
		// count stays well inside a default descriptor limit of 1024.
		const STAGES: usize = 256;

		let pipeline = vec!["stage=1"; STAGES].join(" | ");
		let outcome = alone_and_cancelled_at_once(
			format!("{pipeline}; (( ${{#PIPESTATUS[@]}} == {STAGES} ))"),
			|_| {},
		);

		assert_eq!(outcome, (true, false), "(uncancelled ran every stage, cancelled stopped)");
	}

	/// A command of assignments alone (`a=1 b=2 …`) expands each value
	/// through the same short cut as a keyed element, so neither its item loop
	/// nor its assignment loop reached a checkpoint.
	#[test]
	fn assignment_list_reaches_a_cancellation_task() {
		const ASSIGNMENTS: usize = 2048;

		let assignments = (0..ASSIGNMENTS).map(|index| format!("v{index}={index}")).join(" ");
		let last = ASSIGNMENTS - 1;
		let outcome =
			alone_and_cancelled_at_once(format!("{assignments}; (( v{last} == {last} ))"), |_| {});

		assert_eq!(outcome, (true, false), "(uncancelled assigned them all, cancelled stopped)");
	}
}
