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
	///
	/// `N` is sized against [`crate::interp::ELEMENT_CHECKPOINT_STRIDE`]: the
	/// generator spends one checkpoint per stride, and Tokio yields once per
	/// 128 spent, so the range has to be long enough for the generator to
	/// exhaust a budget on its own.
	#[test]
	fn brace_generator_reaches_a_cancellation_task() {
		const ELEMENTS: usize = 256 * crate::interp::ELEMENT_CHECKPOINT_STRIDE;

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

	/// How long a run keeps its only worker between checkpoints, measured
	/// inside a window the script marks. The measure reads a thread's CPU
	/// clock, which these platforms have.
	#[cfg(unix)]
	mod held_worker {
		use std::{
			collections::BTreeMap,
			sync::{Mutex, MutexGuard, PoisonError},
		};

		use super::*;
		use crate::{
			ShellState,
			variables::{ShellValueUnsetType, ShellVariableUpdateTransform},
		};

		/// Where the window [`longest_hold`] measures opened and closed, in the
		/// run's CPU time. A script opens it by reading `$open` and closes it by
		/// reading `$close`.
		static WINDOW: Mutex<Window> = Mutex::new(Window { opened: None, closed: None });

		/// Serializes the tests that share [`WINDOW`]: `cargo test` runs the
		/// tests of one binary on threads of one process.
		static MEASURED_RUN: Mutex<()> = Mutex::new(());

		struct Window {
			opened: Option<Duration>,
			closed: Option<Duration>,
		}

		fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
			mutex.lock().unwrap_or_else(PoisonError::into_inner)
		}

		/// CPU time the calling thread has used so far.
		///
		/// The runs below have one worker thread, so the difference between two
		/// readings on it is the work the worker did between them. Wall-clock
		/// time would count every stretch the machine took the thread away too.
		fn worker_cpu_time() -> Duration {
			let mut now = nix::libc::timespec { tv_sec: 0, tv_nsec: 0 };
			// SAFETY: `clock_gettime` writes only the `timespec` it is given.
			let status =
				unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_THREAD_CPUTIME_ID, &raw mut now) };
			assert_eq!(status, 0, "the thread CPU clock is readable");
			Duration::new(
				u64::try_from(now.tv_sec).expect("seconds"),
				u32::try_from(now.tv_nsec).expect("nanoseconds"),
			)
		}

		fn open_window(_shell: &dyn ShellState) -> ShellValue {
			lock(&WINDOW).opened.get_or_insert_with(worker_cpu_time);
			ShellValue::String(String::new())
		}

		fn close_window(_shell: &dyn ShellState) -> ShellValue {
			lock(&WINDOW).closed.get_or_insert_with(worker_cpu_time);
			ShellValue::String(String::new())
		}

		/// Runs `command` on one worker beside a task that asks for that worker
		/// back each time it gets it, and returns the longest stretch of the
		/// window between `$open` and `$close` that the run kept the worker,
		/// the window's length, and whether the command succeeded.
		///
		/// Every step of the run is ready at once, so the other task gets the
		/// worker only where the run spends a checkpoint, and the stretches
		/// between its turns are the run's stretches without one. That catches
		/// a stretch wherever it falls, however many checkpoints the run spent
		/// before it, which a cancellation raised at the run's first yield
		/// cannot. Both lengths are the worker's CPU time.
		fn longest_hold(
			command: &str,
			prepare: fn(&mut Shell<DefaultShellExtensions>),
		) -> (Duration, Duration, bool) {
			let _serial = lock(&MEASURED_RUN);
			*lock(&WINDOW) = Window { opened: None, closed: None };

			let command = command.to_owned();
			let (turns, succeeded) = on_single_worker(Duration::from_secs(600), move || async move {
				let run_done = Arc::new(AtomicBool::new(false));

				let asking_done = run_done.clone();
				let asking = tokio::spawn(async move {
					let mut turns = vec![];
					while !asking_done.load(Ordering::Acquire) {
						turns.push(worker_cpu_time());
						tokio::task::yield_now().await;
					}
					turns
				});

				let run = tokio::spawn(async move {
					let mut shell = Shell::builder().build().await.expect("shell");
					prepare(&mut shell);
					let window_variables: [(&str, fn(&dyn ShellState) -> ShellValue); 2] =
						[("open", open_window), ("close", close_window)];
					for (name, getter) in window_variables {
						let variable = ShellVariable::new(ShellValue::Dynamic { getter, setter: |_| () });
						shell.env_mut().set_global(name, variable).expect("window variable");
					}
					let params = shell.default_exec_params();
					let succeeded = shell
						.run_string(command, &crate::SourceInfo::default(), &params)
						.await
						.is_ok_and(|result| result.is_success());
					run_done.store(true, Ordering::Release);
					succeeded
				});

				let succeeded = run.await.expect("run task");
				(asking.await.expect("asking task"), succeeded)
			})
			.expect("the measured run finished");

			let window = lock(&WINDOW);
			let opened = window.opened.expect("the command opened the window");
			let closed = window.closed.expect("the command closed the window");
			let longest = std::iter::once(opened)
				.chain(turns.into_iter().filter(|turn| (opened..closed).contains(turn)))
				.chain(std::iter::once(closed))
				.tuple_windows()
				.map(|(earlier, later)| later - earlier)
				.max()
				.unwrap_or_default();
			(longest, closed - opened, succeeded)
		}

		/// The shortest stretch worth failing a test over.
		///
		/// The share rule below is there to catch a whole pass that spends no
		/// checkpoint. It cannot tell one apart from a single allocator step —
		/// a `realloc` that crosses a power of two, or the `free` that follows,
		/// on a buffer of tens of megabytes — which no checkpoint can be put
		/// inside and which is the residual already ruled out of this change.
		///
		/// **This is a latency tolerance, not evidence that a passing
		/// measurement checkpoints**, and the number is taken from measuring
		/// that step rather than chosen: across this module's cases in an
		/// optimised build the longest such stretch is 5.45 ms, so the floor
		/// sits just above it. [`the_hold_rule_catches_a_checkpoint_free_stretch`]
		/// is the control that holds it down — it spins past the floor with no
		/// checkpoint at all and requires the rule to reject it, so the floor
		/// cannot be raised over a stretch it is meant to catch without a test
		/// saying so.
		const SHORTEST_FAILING_HOLD: Duration = Duration::from_millis(6);

		/// How long [`the_hold_rule_catches_a_checkpoint_free_stretch`] holds
		/// the worker: above the floor, and short enough that the control costs
		/// nothing to run.
		const CONTROL_HOLD: Duration = Duration::from_millis(8);

		/// The longest the worker may be held per element a window frees.
		///
		/// Freeing an element is one call to the allocator, measured at 18 ns
		/// in an optimised build; forty leaves room for a slower machine and
		/// still fails a pass over the elements that spends no checkpoint,
		/// which costs an order of magnitude more.
		const LONGEST_HOLD_PER_ELEMENT: Duration = Duration::from_nanos(40);

		/// Asserts each case succeeded and that no stretch of its window kept
		/// the worker longer than freeing `elements` of them allows.
		///
		/// The share rule cannot be used on a window that closes on an
		/// assignment: it also holds the free of the elements the assignment
		/// replaced, one call to the allocator each, and no checkpoint can be
		/// put inside a destructor. That is the residual ruled out of this
		/// change, so what these hold is the rate.
		fn assert_each_yields_throughout(
			cases: impl IntoIterator<Item = (String, fn(&mut Shell<DefaultShellExtensions>))>,
			elements: u64,
		) {
			let allowed = LONGEST_HOLD_PER_ELEMENT * u32::try_from(elements).expect("elements");
			for (command, prepare) in cases {
				let (longest, window, succeeded) = longest_hold(&command, prepare);
				eprintln!("HOLD {command}: longest={longest:?} window={window:?}");
				assert!(succeeded, "{command}: the run succeeded");
				assert!(
					longest < allowed,
					"{command}: kept its worker for {longest:?} of a {window:?} window, over the \
					 {allowed:?} that freeing {elements} elements allows"
				);
			}
		}

		/// Asserts that `command` succeeded and that no stretch of its window
		/// kept the worker for an eighth of the window or more, unless that
		/// stretch is shorter than [`SHORTEST_FAILING_HOLD`]. A pass with no
		/// checkpoint is one stretch as long as the window.
		fn assert_yields_throughout(command: &str, prepare: fn(&mut Shell<DefaultShellExtensions>)) {
			let (longest, window, succeeded) = longest_hold(command, prepare);
			eprintln!("HOLD {command}: longest={longest:?} window={window:?} succeeded={succeeded}");
			assert!(succeeded, "{command}: the run succeeded");
			assert!(
				holds_fairly(longest, window),
				"{command}: kept its worker for {longest:?} of a {window:?} window"
			);
		}

		/// The rule [`assert_yields_throughout`] applies, named so the control
		/// below can apply the same one.
		fn holds_fairly(longest: Duration, window: Duration) -> bool {
			longest * 8 < window || longest < SHORTEST_FAILING_HOLD
		}

		/// How many elements the array window tests copy: enough that one pass
		/// over them is a stretch far longer than a hundred and twenty-eight of
		/// its steps.
		const ARRAY_ELEMENTS: u64 = 1 << 20;

		/// `seed`: `ARRAY_ELEMENTS` distinct values, `v0` onwards.
		fn seeded(shell: &mut Shell<DefaultShellExtensions>) {
			let values: BTreeMap<u64, String> =
				(0..ARRAY_ELEMENTS).map(|index| (index, format!("v{index}"))).collect();
			shell
				.env_mut()
				.set_global("seed", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("seed");
		}

		/// `seed`, and `assoc` declared associative (`declare -A`).
		fn seeded_with_associative(shell: &mut Shell<DefaultShellExtensions>) {
			seeded(shell);
			shell
				.env_mut()
				.set_global(
					"assoc",
					ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::AssociativeArray)),
				)
				.expect("assoc");
		}

		/// `assoc`: `ARRAY_ELEMENTS` entries, `k0=v0` onwards.
		fn associative(shell: &mut Shell<DefaultShellExtensions>) {
			let values: BTreeMap<String, String> =
				(0..ARRAY_ELEMENTS).map(|index| (format!("k{index}"), format!("v{index}"))).collect();
			shell
				.env_mut()
				.set_global("assoc", ShellVariable::new(ShellValue::AssociativeArray(values)))
				.expect("assoc");
		}

		/// Building an array from its expanded elements is one pass over all of
		/// them, and it starts after the last element's expansion has spent its
		/// last checkpoint. With none in the pass, `copy=("${seed[@]}" "$x")`
		/// kept its worker for the whole insertion, and a cancellation raised
		/// meanwhile took effect only once every element was assigned. Each
		/// case opens the window on its last element, so what is left in it is
		/// the insertion: replacing and appending, indexed and associative, and
		/// with the variable's case conversion applied to each element.
		#[test]
		fn array_insertion_yields_throughout() {
			let n = ARRAY_ELEMENTS;
			let cases: [(String, fn(&mut Shell<DefaultShellExtensions>)); 5] = [
				(
					format!(
						"copy=(\"${{seed[@]}}\" \"$open\"); closed=$close; (( ${{#copy[@]}} == {n} + 1 ))"
					),
					seeded,
				),
				(
					format!(
						"copy=(first); copy+=(\"${{seed[@]}}\" \"$open\"); closed=$close; (( \
						 ${{#copy[@]}} == {n} + 2 ))"
					),
					seeded,
				),
				// Unkeyed elements alternate key and value; the last key gets "".
				(
					format!(
						"assoc=(\"${{seed[@]}}\" \"$open\"k); closed=$close; (( ${{#assoc[@]}} == {n} / 2 \
						 + 1 ))"
					),
					seeded_with_associative,
				),
				(
					format!(
						"assoc=([first]=1); assoc+=(\"${{seed[@]}}\" \"$open\"k); closed=$close; (( \
						 ${{#assoc[@]}} == {n} / 2 + 2 ))"
					),
					seeded_with_associative,
				),
				(
					"copy=(\"${seed[@]}\" \"$open\"); closed=$close; [[ ${copy[1]} == V1 ]]".to_owned(),
					|shell| {
						seeded(shell);
						let mut copy = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
						copy.set_update_transform(ShellVariableUpdateTransform::Uppercase);
						shell.env_mut().set_global("copy", copy).expect("copy");
					},
				),
			];

			// The share rule cannot be used here. These windows close on the
			// assignment, so each one also contains the free of the million
			// expanded elements it replaced: a million calls to the allocator,
			// measured at 18 ns each in an optimised build and consistent with
			// the 53 ms a three-million-element map costs. No checkpoint can be
			// put inside a destructor, which is the residual ruled out of this
			// change; what a test can hold is the rate.
			let allowed = LONGEST_HOLD_PER_ELEMENT * u32::try_from(ARRAY_ELEMENTS).unwrap();
			for (command, prepare) in cases {
				let (longest, window, succeeded) = longest_hold(&command, prepare);
				eprintln!("HOLD {command}: longest={longest:?} window={window:?}");
				assert!(succeeded, "{command}: the run succeeded");
				assert!(
					longest < allowed,
					"{command}: kept its worker for {longest:?} of a {window:?} window, over the \
					 {allowed:?} that freeing {ARRAY_ELEMENTS} elements allows"
				);
			}
		}

		/// `${name[@]}` and its kin copied every element in one pass before the
		/// first field was built, so the checkpoint on each field came only
		/// after the copy. Each case opens the window just before the
		/// expansion, after the command's earlier words have spent their
		/// checkpoints.
		#[test]
		fn element_copy_yields_throughout() {
			let n = ARRAY_ELEMENTS;
			let cases: [(String, fn(&mut Shell<DefaultShellExtensions>)); 7] = [
				(
					format!("words=(\"$open\" ${{seed[@]}}\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"),
					seeded,
				),
				(
					format!("words=(\"$open\" ${{!seed[@]}}\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"),
					seeded,
				),
				(
					format!("words=(\"$open\" ${{seed[@]:1}}\"$close\"); (( ${{#words[@]}} == {n} ))"),
					seeded,
				),
				(format!("words=(\"$open\" \"$@\"\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"), |shell| {
					*shell.current_shell_args_mut() =
						(0..ARRAY_ELEMENTS).map(|index| format!("v{index}")).collect();
				}),
				(
					format!("words=(\"$open\" ${{assoc[@]}}\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"),
					associative,
				),
				(
					format!("words=(\"$open\" ${{!assoc[@]}}\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"),
					associative,
				),
				// `${seed@a}` only reads what kind of value `seed` holds, but read
				// it from a copy of the whole array; the copy beside it gives the
				// window a length to measure against.
				(
					format!(
						"words=(\"$open\" ${{seed@a}} ${{seed[@]}}\"$close\"); [[ ${{words[1]}} == a ]] && \
						 (( ${{#words[@]}} == {n} + 2 ))"
					),
					seeded,
				),
			];

			assert_each_yields_throughout(cases, ARRAY_ELEMENTS);
		}

		/// One word piece can stand for millions of fields (`"${seed[@]}"`),
		/// and putting them in their place in the word was one synchronous
		/// pass each: joining them onto the fields before them, marking them
		/// quoted inside double quotes, concatenating them for `"${seed[*]}"`,
		/// and joining them into the one string a scalar holds. All of it ran
		/// after the expansion's last checkpoint, inside one brace element's
		/// single checkpoint. Each case opens the window as late as its pass
		/// allows.
		#[test]
		fn coalescing_yields_throughout() {
			let n = ARRAY_ELEMENTS;
			let cases = [
				// Joining onto the `x` before them: the window opens once the
				// expansion and its quoting are done.
				format!("words=(x\"${{seed[@]}}$open\"\"$close\"); (( ${{#words[@]}} == {n} ))"),
				// Marking each field quoted.
				format!("words=(\"$open${{seed[@]}}$close\"); (( ${{#words[@]}} == {n} ))"),
				// Concatenating them into one field.
				"words=(\"$open${seed[*]}$close\"); (( ${#words[@]} == 1 ))".to_owned(),
				// Joining them into the one string a scalar holds.
				"joined=\"${seed[@]}$open\"; closed=$close; [[ ${joined:0:6} == 'v0 v1 ' ]]".to_owned(),
			];

			let prepare: fn(&mut Shell<DefaultShellExtensions>) = seeded;
			assert_each_yields_throughout(cases.map(|command| (command, prepare)), ARRAY_ELEMENTS);
		}

		/// How large one element is where the byte budget is pinned, and how
		/// few of them there are: 64 steps is a quarter of the step stride, so
		/// a stride counted in steps spends nothing at all across all of them.
		const LARGE_ELEMENT_BYTES: usize = 2 << 20;
		const LARGE_ELEMENTS: u64 = 64;

		/// `bulk`: [`LARGE_ELEMENTS`] elements of [`LARGE_ELEMENT_BYTES`] each.
		fn bulky(shell: &mut Shell<DefaultShellExtensions>) {
			let values: BTreeMap<u64, String> =
				(0..LARGE_ELEMENTS).map(|index| (index, "b".repeat(LARGE_ELEMENT_BYTES))).collect();
			shell
				.env_mut()
				.set_global("bulk", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("bulk");
		}

		/// A step that copies a string does work in that string's length, and a
		/// stride counted in steps says nothing about it: 64 elements of 2 MiB
		/// are a quarter of a step stride and an eighth of a gigabyte, so the
		/// count never reached the stride and the whole copy ran between two
		/// checkpoints. Each case opens the window before the expansion that
		/// copies them, because that is where the length of an element is the
		/// work; what follows it only moves owned values.
		#[test]
		fn large_elements_yield_throughout() {
			let n = LARGE_ELEMENTS;
			let cases = [
				// Copying each element out of the variable into a field.
				format!("words=(\"$open\" ${{bulk[@]}}\"$close\"); (( ${{#words[@]}} == {n} + 1 ))"),
				// Concatenating them into one quoted field.
				"words=(\"$open${bulk[*]}$close\"); (( ${#words[@]} == 1 ))".to_owned(),
				// Joining them into the one string a scalar holds.
				"joined=\"$open${bulk[@]}$close\"; [[ ${joined:0:2} == 'bb' ]]".to_owned(),
			];

			for command in cases {
				assert_yields_throughout(&command, bulky);
			}
		}

		/// One element, far larger than a byte stride.
		const ONE_HUGE_ELEMENT_BYTES: usize = 64 << 20;

		/// `huge`: a single element of [`ONE_HUGE_ELEMENT_BYTES`].
		fn one_huge(shell: &mut Shell<DefaultShellExtensions>) {
			let values: BTreeMap<u64, String> =
				std::iter::once((0, "h".repeat(ONE_HUGE_ELEMENT_BYTES))).collect();
			shell
				.env_mut()
				.set_global("huge", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("huge");
		}

		/// The longest the worker may be held per megabyte of a single element.
		///
		/// The share rule cannot be used here. Every copy on this path is now
		/// divided, and what is left is one allocator step — a `realloc` that
		/// crosses a power of two, or the `free` that follows — whose cost is
		/// proportional to the element, so it is a fixed share of the window
		/// however large the element is. No checkpoint can be put inside
		/// either, which is the residual already ruled out of this change.
		/// What a test can hold is the rate: measured at four tenths of a
		/// millisecond per megabyte before this round and five hundredths
		/// after, so a tenth leaves room for a slower machine and still fails
		/// an undivided copy.
		const LONGEST_HOLD_PER_MIB: Duration = Duration::from_micros(100);

		/// Charging a step for the bytes it is about to copy counts the work
		/// and does not divide it. One element of half a gigabyte owed over
		/// eight thousand checkpoints, spent every one of them, and then held
		/// the worker for 195 ms inside a single `clone`, because nothing can
		/// interrupt a copy already under way. The copies themselves are now
		/// made a stride at a time.
		#[test]
		fn one_huge_element_yields_throughout() {
			let allowed = LONGEST_HOLD_PER_MIB * u32::try_from(ONE_HUGE_ELEMENT_BYTES >> 20).unwrap();
			let cases = [
				// Copying the element out of the variable into a field.
				"words=(\"$open\" ${huge[@]}\"$close\"); (( ${#words[@]} == 2 ))".to_owned(),
				// Concatenating it into one quoted field.
				"words=(\"$open${huge[*]}$close\"); (( ${#words[@]} == 1 ))".to_owned(),
				// Joining it into the one string a scalar holds.
				"joined=\"$open${huge[@]}$close\"; [[ ${joined:0:2} == 'hh' ]]".to_owned(),
			];

			for command in cases {
				let (longest, window, succeeded) = longest_hold(&command, one_huge);
				eprintln!("HOLD {command}: longest={longest:?} window={window:?}");
				assert!(succeeded, "{command}: the run succeeded");
				assert!(
					longest < allowed,
					"{command}: kept its worker for {longest:?} of a {window:?} window, over the \
					 {allowed:?} a divided copy of this size allows"
				);
			}
		}

		/// Spins for [`CONTROL_HOLD`] without yielding, so the harness has a
		/// stretch it must catch.
		struct SpinsWithoutYielding;

		impl builtins::SimpleCommand for SpinsWithoutYielding {
			fn get_content(
				_name: &str,
				_content_type: builtins::ContentType,
				_options: &builtins::ContentOptions,
			) -> Result<String, error::Error> {
				Ok(String::new())
			}

			fn execute<SE: extensions::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
				_context: commands::ExecutionContext<'_, SE>,
				_args: I,
			) -> Result<ExecutionResult, error::Error> {
				let until = std::time::Instant::now() + CONTROL_HOLD;
				while std::time::Instant::now() < until {
					std::hint::spin_loop();
				}
				Ok(ExecutionResult::success())
			}
		}

		/// The control for [`SHORTEST_FAILING_HOLD`].
		///
		/// A floor is a latency tolerance, not evidence that a passing
		/// measurement checkpoints: at five milliseconds, a four-millisecond
		/// loop that spends nothing passed the rule the other tests in this
		/// module rely on. This runs exactly that loop and requires the rule to
		/// reject it, so the floor cannot be raised back over a stretch it is
		/// meant to catch without a test saying so.
		#[test]
		fn the_hold_rule_catches_a_checkpoint_free_stretch() {
			let (longest, window, succeeded) = longest_hold("x=$open; spins; closed=$close", |shell| {
				shell.register_builtin(
					"spins",
					builtins::simple_builtin::<SpinsWithoutYielding, DefaultShellExtensions>(),
				);
			});
			eprintln!("CONTROL longest={longest:?} window={window:?} succeeded={succeeded}");

			assert!(succeeded, "the control run succeeded");
			assert!(
				longest >= CONTROL_HOLD,
				"the spin was measured: {longest:?} of a {window:?} window"
			);
			assert!(
				!holds_fairly(longest, window),
				"a {CONTROL_HOLD:?} stretch with no checkpoint is rejected, not excused by the floor"
			);
		}
	}
}
