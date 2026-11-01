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

	/// Inputs where converting twice, or converting before concatenating,
	/// gives a different answer from converting the value the variable ends
	/// up holding.
	///
	/// **Enumerated rather than listed.** Every character whose uppercase
	/// form is longer than it is — all 103 of them in this Unicode version —
	/// is one of these, because `Capitalize` lowercases and then raises the
	/// first character, so a second pass lowercases everything the first one
	/// expanded: `Sseta` for `SSeta`, `Ffield` for `FFIeld`, `Fflow` for
	/// `FFLow`, `Եւ` for `ԵՒ`, `ʼn` for `ʼN`, `Ἀιeta` for `ἈΙeta`. A test
	/// built from the ones that were reported would have had six of them.
	///
	/// `Σ` is the other shape, and lowercase rather than capitalise:
	/// appended to `a` it is a final sigma, `aς`, and only `aσ` if the value
	/// was converted before it met the `a`.
	///
	/// **The inputs must include one that ends in `Σ`.** Every generated
	/// string here used to end in `eta`, so even `Σeta` had a cased
	/// character after its sigma and the final-sigma rule never applied: a
	/// mutant that prematurely lowercased an incoming `"Σ"` passed this test
	/// while an independent `a += Σ` assertion failed. Enumerating every
	/// mapping does not cover a shape that depends on what **follows**.
	fn premature_conversion_shows(ends: &str) -> Vec<String> {
		let mut inputs: Vec<String> = ('\0'..=char::MAX)
			.filter(|c| c.to_uppercase().count() > 1)
			.map(|c| format!("{c}{ends}"))
			.collect();
		inputs.push(format!("Σ{ends}"));
		inputs.push(format!("İΣ{ends}"));
		inputs.push(String::from("Σ"));
		inputs.push(String::from("İΣ"));
		inputs.push(String::from("ßΣ"));
		inputs
	}

	/// Every route converts a value **once**, and the oracle is the
	/// conversion itself.
	///
	/// Two things this test has had to learn. It must drive the `async`
	/// routes a script takes — an earlier version called the synchronous
	/// assignment and passed 96 comparisons against a head that corrupted
	/// four of six inputs. And the oracle must be **whole-string
	/// conversion**, not another code path: comparing an element against a
	/// scalar assignment cannot see a scalar assignment that is itself
	/// wrong, which is how `x+=ßeta` kept giving `Sseta` for a round longer.
	///
	/// **An oracle that is another code path is not an oracle.** This branch
	/// spent two rounds learning that, and both failures were in this test
	/// rather than in the code it was meant to hold.
	///
	/// Where the single conversion belongs is on [`crate::ShellVariable::assign`];
	/// this compares replacement and scalar append, where the answer is the
	/// conversion of the whole value.
	#[test]
	fn every_route_converts_a_value_once() {
		let compared = on_single_worker(Duration::from_secs(60), || async {
			let shell = Shell::builder().build().await.expect("shell");
			let params = shell.default_exec_params();
			let mut compared = 0;

			for transform in [
				crate::variables::ShellVariableUpdateTransform::Lowercase,
				crate::variables::ShellVariableUpdateTransform::Uppercase,
				crate::variables::ShellVariableUpdateTransform::Capitalize,
			] {
				let converter = crate::variables::ValueConverter::for_transform(transform);
				for input in premature_conversion_shows("eta") {
					let input = input.as_str();
					for base in ["", "a"] {
						// What the attribute means: the conversion of the
						// whole value the variable ends up holding.
						let whole = converter.apply(format!("{base}{input}"));

						let mut scalar = ShellVariable::new(ShellValue::Unset(
							crate::variables::ShellValueUnsetType::Untyped,
						));
						scalar.set_update_transform(transform);
						if !base.is_empty() {
							scalar
								.assign(
									crate::variables::ShellValueLiteral::Scalar(String::from(base)),
									false,
									&params,
								)
								.await
								.expect("the base");
						}
						scalar
							.assign(
								crate::variables::ShellValueLiteral::Scalar(String::from(input)),
								!base.is_empty(),
								&params,
							)
							.await
							.expect("assigned through the divided scalar path");
						assert_eq!(
							scalar.value().to_cow_str(&shell),
							whole,
							"{transform:?} of {base:?} + {input:?} through `assign`"
						);
						compared += 1;

						// `x+=…` on a declared-but-unset scalar: the shape
						// that kept giving `Sseta` after the element paths
						// were fixed, because it appends to nothing and so
						// looks like a replacement until you convert twice.
						if base.is_empty() {
							let mut unset = ShellVariable::new(ShellValue::Unset(
								crate::variables::ShellValueUnsetType::Untyped,
							));
							unset.set_update_transform(transform);
							unset
								.assign(
									crate::variables::ShellValueLiteral::Scalar(String::from(input)),
									true,
									&params,
								)
								.await
								.expect("appended to an unset scalar");
							assert_eq!(
								unset.value().to_cow_str(&shell),
								whole,
								"{transform:?} of {input:?} appended to an unset scalar"
							);
							compared += 1;
						}

						// An element is appended to, so its conversion belongs
						// to the value arriving rather than to the result —
						// which is why this compares replacement only, where
						// the two readings agree and the double conversion
						// lived.
						if !base.is_empty() {
							continue;
						}

						for mut variable in [
							ShellVariable::new(ShellValue::IndexedArray(Default::default())),
							ShellVariable::new(ShellValue::AssociativeArray(Default::default())),
							ShellVariable::new(ShellValue::Unset(
								crate::variables::ShellValueUnsetType::IndexedArray,
							)),
						] {
							variable.set_update_transform(transform);
							variable
								.assign_at_index_divided(
									String::from("0"),
									String::from(input),
									false,
									&params,
								)
								.await
								.expect("assigned through the divided index path");
							assert_eq!(
								variable.value().to_cow_str(&shell),
								whole,
								"{transform:?} of {base:?} + {input:?} at an index"
							);
							compared += 1;
						}
					}
				}
			}

			compared
		})
		.expect("the comparison finished");

		let inputs = premature_conversion_shows("eta").len();
		assert!(inputs >= 100, "every expanding uppercase mapping, not a list: {inputs}");
		assert_eq!(compared, 3 * inputs * 6, "every case ran");
	}

	/// A cancelled assignment leaves the variable as it was, **in kind as
	/// well as in bytes**.
	///
	/// Dividing a mutation means it can be interrupted part way. The
	/// promotion of a scalar to an array used to happen on the way in, so an
	/// interrupted `arr[0]+=x` left the bytes intact and the variable turned
	/// into an array — partial state from an operation that assigned nothing.
	#[test]
	fn a_cancelled_append_leaves_the_variable_as_it_was() {
		const BASE_BYTES: usize = 8 * 1024 * 1024;

		let (kind_kept, bytes_kept) = on_single_worker(Duration::from_secs(60), || async {
			let shell = Shell::builder().build().await.expect("shell");
			let mut params = shell.default_exec_params();
			let cancel = CancellationToken::new();
			params.set_cancel_token(cancel.clone());

			// Cancels once the copy is under way rather than before it: the
			// strided copy yields often enough for this task to run.
			tokio::spawn(async move {
				for _ in 0..4 {
					tokio::task::yield_now().await;
				}
				cancel.cancel();
			});

			let mut variable =
				ShellVariable::new(ShellValue::String("h".repeat(BASE_BYTES)));
			let outcome = variable
				.assign_at_index_divided(String::from("0"), String::from("x"), true, &params)
				.await;
			assert!(outcome.is_err(), "the append was cancelled");

			match variable.value() {
				ShellValue::String(text) => (true, text.len() == BASE_BYTES),
				_ => (false, false),
			}
		})
		.expect("the cancelled append finished");

		assert!(kind_kept, "the variable is still a string, not an array");
		assert!(bytes_kept, "the variable still holds its own bytes");
	}

	/// How long a run keeps its only worker between checkpoints, measured
	/// inside a window the script marks. The measure reads a thread's CPU
	/// clock, which these platforms have.
	#[cfg(unix)]
	mod held_worker {
		use std::{
			alloc::{GlobalAlloc, Layout, System},
			cell::Cell,
			collections::BTreeMap,
			sync::{Mutex, MutexGuard, PoisonError},
		};

		use super::*;
		use crate::{
			ShellState,
			variables::{ShellValueUnsetType, ShellVariableUpdateTransform},
		};

		/// Where the window [`longest_hold`] measures opened and closed. A
		/// script opens it by reading `$open` and closes it by reading `$close`.
		static WINDOW: Mutex<Window> = Mutex::new(Window { opened: None, closed: None });

		/// Serializes the tests that share [`WINDOW`]: `cargo test` runs the
		/// tests of one binary on threads of one process.
		static MEASURED_RUN: Mutex<()> = Mutex::new(());

		struct Window {
			opened: Option<Reading>,
			closed: Option<Reading>,
		}

		fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
			mutex.lock().unwrap_or_else(PoisonError::into_inner)
		}

		/// CPU time the calling thread has used so far, or `None` where its
		/// clock cannot be read.
		///
		/// The runs below have one worker thread, so the difference between two
		/// readings on it is the work the worker did between them. Wall-clock
		/// time would count every stretch the machine took the thread away too.
		fn thread_cpu_time() -> Option<Duration> {
			let mut now = nix::libc::timespec { tv_sec: 0, tv_nsec: 0 };
			// SAFETY: `clock_gettime` writes only the `timespec` it is given.
			let status =
				unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_THREAD_CPUTIME_ID, &raw mut now) };
			(status == 0).then(|| {
				Duration::new(
					u64::try_from(now.tv_sec).unwrap_or_default(),
					u32::try_from(now.tv_nsec).unwrap_or_default(),
				)
			})
		}

		fn worker_cpu_time() -> Duration {
			thread_cpu_time().expect("the thread CPU clock is readable")
		}

		/// The smallest buffer an allocator call on which [`TimesLargeCalls`]
		/// times. Every case below copies tens of megabytes or a million
		/// elements; a call on a buffer that size is one step no checkpoint can
		/// enter, and anything smaller is cheap enough to count against the run.
		const LARGE_BUFFER: usize = 1 << 20;

		std::thread_local! {
			/// CPU time this thread has spent inside allocator calls on buffers
			/// of at least [`LARGE_BUFFER`]. Constant-initialised with no
			/// destructor, so the allocator can reach it at any point in the
			/// thread's life.
			static IN_LARGE_ALLOCATOR_CALLS: Cell<Duration> = const { Cell::new(Duration::ZERO) };
		}

		/// The system allocator, charging the time of each call on a buffer of
		/// at least [`LARGE_BUFFER`] to the thread that made it.
		///
		/// The one step no checkpoint can enter is an allocator call on a
		/// buffer the size of the data — a `realloc` that crosses a power of
		/// two, or the `free` of what an assignment replaced — and that residual
		/// is ruled out of this change. This lets the rule below take exactly
		/// that out of a stretch, rather than guess from where the stretch falls
		/// or how many there are: the longest stretch of an array insertion is
		/// 20.2 ms, and 20.16 ms of it is one call.
		struct TimesLargeCalls;

		impl TimesLargeCalls {
			fn timed<T>(size: usize, call: impl FnOnce() -> T) -> T {
				if size < LARGE_BUFFER {
					return call();
				}
				let started = thread_cpu_time();
				let result = call();
				if let (Some(started), Some(ended)) = (started, thread_cpu_time()) {
					let spent = ended.saturating_sub(started);
					IN_LARGE_ALLOCATOR_CALLS.with(|total| total.set(total.get() + spent));
				}
				result
			}
		}

		// SAFETY: every call is passed to `System` unchanged; timing it reads
		// a clock and a constant thread-local and allocates nothing.
		unsafe impl GlobalAlloc for TimesLargeCalls {
			unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
				// SAFETY: the caller's contract for `alloc`, passed on.
				Self::timed(layout.size(), || unsafe { System.alloc(layout) })
			}

			unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
				// SAFETY: the caller's contract for `alloc_zeroed`, passed on.
				Self::timed(layout.size(), || unsafe { System.alloc_zeroed(layout) })
			}

			unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
				// SAFETY: the caller's contract for `dealloc`, passed on.
				Self::timed(layout.size(), || unsafe { System.dealloc(ptr, layout) });
			}

			unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
				// SAFETY: the caller's contract for `realloc`, passed on.
				Self::timed(layout.size().max(new_size), || unsafe {
					System.realloc(ptr, layout, new_size)
				})
			}
		}

		#[global_allocator]
		static ALLOCATOR: TimesLargeCalls = TimesLargeCalls;

		/// Has glibc's allocator do its bookkeeping inside the calls
		/// [`TimesLargeCalls`] times, so none of it is counted as the run's.
		///
		/// Left to itself, glibc moves the cost of a large buffer out of the
		/// call on it. After a large `free` it raises the size above which it
		/// maps a buffer of its own, so the next one lives on the heap and is
		/// given back by trimming the heap inside some later small `free`; and
		/// it parks small freed blocks and merges them all in one pass when a
		/// later call asks for a large one. Either put 4–7 ms of the allocator's
		/// work inside a call on a few bytes. Mapping every buffer of at least
		/// [`LARGE_BUFFER`], never trimming, and merging each small block when
		/// it is freed keeps that work in the call it belongs to.
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		fn settle_the_allocator() {
			static SETTLED: std::sync::Once = std::sync::Once::new();
			SETTLED.call_once(|| {
				let large = i32::try_from(LARGE_BUFFER).expect("the threshold fits an int");
				for (parameter, value) in [
					(nix::libc::M_MMAP_THRESHOLD, large),
					(nix::libc::M_TRIM_THRESHOLD, i32::MAX),
					(nix::libc::M_MXFAST, 0),
				] {
					// SAFETY: `mallopt` only sets the allocator's parameters.
					let set = unsafe { nix::libc::mallopt(parameter, value) };
					assert_eq!(set, 1, "glibc took allocator parameter {parameter}");
				}
			});
		}

		/// Other allocators keep their own bookkeeping; nothing here has
		/// measured where.
		#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
		const fn settle_the_allocator() {}

		/// The worker's CPU clock, and how much of it went to large allocator
		/// calls.
		#[derive(Clone, Copy)]
		struct Reading {
			cpu:          Duration,
			in_allocator: Duration,
		}

		fn reading() -> Reading {
			Reading {
				cpu:          worker_cpu_time(),
				in_allocator: IN_LARGE_ALLOCATOR_CALLS.with(Cell::get),
			}
		}

		fn open_window(_shell: &dyn ShellState) -> ShellValue {
			lock(&WINDOW).opened.get_or_insert_with(reading);
			ShellValue::String(String::new())
		}

		fn close_window(_shell: &dyn ShellState) -> ShellValue {
			lock(&WINDOW).closed.get_or_insert_with(reading);
			ShellValue::String(String::new())
		}

		/// What [`longest_hold`] measured of one window. Every length is the
		/// worker's CPU time.
		struct Holds {
			/// The longest stretch the run kept the worker, less what it spent
			/// inside allocator calls on large buffers. This is what the rule
			/// bounds.
			longest_held: Duration,
			/// The longest stretch, allocator calls and all.
			longest:      Duration,
			/// How much of the window went to allocator calls on large buffers.
			in_allocator: Duration,
			window:       Duration,
			stretches:    usize,
			succeeded:    bool,
		}

		impl std::fmt::Display for Holds {
			fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				let Self { longest_held, longest, in_allocator, window, stretches, succeeded } = self;
				write!(
					f,
					"longest_held={longest_held:?} longest={longest:?} in_allocator={in_allocator:?} \
					 window={window:?} stretches={stretches} succeeded={succeeded}"
				)
			}
		}

		/// Runs `command` on one worker beside a task that asks for that worker
		/// back each time it gets it, and measures the stretches of the window
		/// between `$open` and `$close` that the run kept the worker.
		///
		/// Every step of the run is ready at once, so the other task gets the
		/// worker only where the run spends a checkpoint, and the stretches
		/// between its turns are the run's stretches without one. That catches
		/// a stretch wherever it falls, however many checkpoints the run spent
		/// before it, which a cancellation raised at the run's first yield
		/// cannot.
		fn longest_hold(command: &str, prepare: fn(&mut Shell<DefaultShellExtensions>)) -> Holds {
			let _serial = lock(&MEASURED_RUN);
			settle_the_allocator();
			*lock(&WINDOW) = Window { opened: None, closed: None };

			let command = command.to_owned();
			let (turns, succeeded) = on_single_worker(Duration::from_secs(600), move || async move {
				let run_done = Arc::new(AtomicBool::new(false));

				let asking_done = run_done.clone();
				let asking = tokio::spawn(async move {
					let mut turns = vec![];
					while !asking_done.load(Ordering::Acquire) {
						turns.push(reading());
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
			let readings = std::iter::once(opened)
				.chain(turns.into_iter().filter(|turn| (opened.cpu..closed.cpu).contains(&turn.cpu)))
				.chain(std::iter::once(closed));
			let mut holds = Holds {
				longest_held: Duration::ZERO,
				longest: Duration::ZERO,
				in_allocator: closed.in_allocator - opened.in_allocator,
				window: closed.cpu - opened.cpu,
				stretches: 0,
				succeeded,
			};
			for (earlier, later) in readings.tuple_windows() {
				let stretch = later.cpu - earlier.cpu;
				let in_allocator = later.in_allocator - earlier.in_allocator;
				holds.longest = holds.longest.max(stretch);
				holds.longest_held = holds.longest_held.max(stretch.saturating_sub(in_allocator));
				holds.stretches += 1;
			}
			holds
		}

		/// The longest the run may keep its worker at a stretch, outside the
		/// allocator calls [`TimesLargeCalls`] times.
		///
		/// A checkpoint yields once the thread has run 1 ms since it last did,
		/// so a stretch is that millisecond plus the work between two readings
		/// of the clock: sixteen element checkpoints, or one byte stride.
		/// Across this module's cases the longest such stretch measured
		/// **1.44 ms optimised and 2.33 ms in a debug build** — four times
		/// under the bound in both. It used to be 11.1 ms in debug, which was
		/// one 64 KiB stride of converting `Σ`; the conversion stride is now
		/// 8 KiB ([`crate::variables`]), because a stride that takes longer
		/// than the hold cannot honour it.
		///
		/// **This is a latency tolerance**: a pass that spends no checkpoint and
		/// runs for less than it is not caught. Every pass measured with its
		/// checkpoints deleted runs longer; the shortest, joining fields onto
		/// the one before them, held the worker 11.1 ms optimised.
		/// [`the_hold_rule_catches_a_checkpoint_free_stretch`] holds the bound
		/// down.
		const LONGEST_ALLOWED_HOLD: Duration =
			Duration::from_millis(if cfg!(debug_assertions) { 10 } else { 4 });

		/// How long the controls below hold the worker: just over
		/// [`LONGEST_ALLOWED_HOLD`], so the bound cannot be raised past them
		/// without a control failing.
		const CONTROL_HOLD: Duration =
			Duration::from_millis(if cfg!(debug_assertions) { 12 } else { 5 });

		/// Asserts that `command` succeeded and that it yielded throughout its
		/// window.
		///
		/// In an optimised build it also asserts that the window is longer than
		/// the bound, so a run that spent no checkpoint in it would fail: a case
		/// that cannot fail measures nothing. A debug build's bound is wider
		/// than the windows of the cases whose work is `memcpy`, which runs as
		/// fast there, so it is not asserted there.
		fn assert_yields_throughout(command: &str, prepare: fn(&mut Shell<DefaultShellExtensions>)) {
			let holds = longest_hold(command, prepare);
			eprintln!("HOLD {command}: {holds}");
			assert!(holds.succeeded, "{command}: the run succeeded");
			assert!(
				cfg!(debug_assertions)
					|| holds.window.saturating_sub(holds.in_allocator) > LONGEST_ALLOWED_HOLD,
				"{command}: the window is too short for a run that spends no checkpoint to fail: \
				 {holds}"
			);
			assert!(
				yields_throughout(&holds),
				"{command}: kept its worker for {:?} outside the allocator: {holds}",
				holds.longest_held
			);
		}

		/// The rule [`assert_yields_throughout`] applies, named so the controls
		/// can apply the same one.
		///
		/// It bounds every stretch, not a share of the window: the rule this
		/// replaced compared the second-longest stretch to the window, so a pass
		/// with its checkpoints deleted, which is one long stretch, was taken
		/// for the allocator step that rule exempted, and padding a window with
		/// work that yields made any stretch a small enough share. Seven
		/// checkpoint deletions passed it.
		fn yields_throughout(holds: &Holds) -> bool {
			holds.longest_held <= LONGEST_ALLOWED_HOLD
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

			// These windows close on the assignment, so each also holds the free
			// of the million expanded elements it replaced: one allocator call
			// of about 20 ms, which the rule takes out of its stretch.
			for (command, prepare) in cases {
				assert_yields_throughout(&command, prepare);
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

			for (command, prepare) in cases {
				assert_yields_throughout(&command, prepare);
			}
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
			for command in cases {
				assert_yields_throughout(&command, prepare);
			}
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

		/// `huge`: one element, `text`.
		fn one_element(shell: &mut Shell<DefaultShellExtensions>, text: String) {
			let values: BTreeMap<u64, String> = std::iter::once((0, text)).collect();
			shell
				.env_mut()
				.set_global("huge", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("huge");
		}

		/// `huge`: a single element of [`ONE_HUGE_ELEMENT_BYTES`].
		fn one_huge(shell: &mut Shell<DefaultShellExtensions>) {
			one_element(shell, "h".repeat(ONE_HUGE_ELEMENT_BYTES));
		}

		/// `huge`: a single element of [`ONE_HUGE_ELEMENT_BYTES`] of `ß`, whose
		/// uppercase form is twice as long, so a case conversion of it cannot
		/// be done in place.
		fn one_sharp(shell: &mut Shell<DefaultShellExtensions>) {
			one_element(shell, "ß".repeat(ONE_HUGE_ELEMENT_BYTES / 2));
		}

		/// `name`, unset, converting what is assigned to it with `transform`.
		fn converting(
			shell: &mut Shell<DefaultShellExtensions>,
			name: &str,
			transform: ShellVariableUpdateTransform,
		) {
			let mut variable = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			variable.set_update_transform(transform);
			shell.env_mut().set_global(name, variable).expect("converting variable");
		}

		/// Charging a step for the bytes it is about to copy counts the work
		/// and does not divide it. One element of half a gigabyte owed over
		/// eight thousand checkpoints, spent every one of them, and then held
		/// the worker for 195 ms inside a single `clone`, because nothing can
		/// interrupt a copy already under way. The copies themselves are now
		/// made a stride at a time, and so is the case conversion that follows
		/// them.
		#[test]
		fn one_huge_element_yields_throughout() {
			let cases: [(String, fn(&mut Shell<DefaultShellExtensions>)); 18] = [
				// Copying the element out of the variable into a field.
				("words=(\"$open\" ${huge[@]}\"$close\"); (( ${#words[@]} == 2 ))".to_owned(), one_huge),
				// Concatenating it into one quoted field.
				("words=(\"$open${huge[*]}$close\"); (( ${#words[@]} == 1 ))".to_owned(), one_huge),
				// Joining it into the one string a scalar holds.
				("joined=\"$open${huge[@]}$close\"; [[ ${joined:0:2} == 'hh' ]]".to_owned(), one_huge),
				// The marker closed after the assignment rather than inside it,
				// so the window also holds the pathname expansion of an unquoted
				// element and the assignment itself.
				("words=(\"$open\" ${huge[@]}); closed=$close; (( ${#words[@]} == 2 ))".to_owned(), one_huge),
				// The same, with the variable's case conversion applied to it.
				(
					"words=(\"$open\" ${huge[@]}); closed=$close; [[ ${words[1]:0:2} == 'SS' ]]"
						.to_owned(),
					|shell| {
						one_sharp(shell);
						converting(shell, "words", ShellVariableUpdateTransform::Uppercase);
					},
				),
				// Lowercasing a run of `Σ`, each final or not by what is around
				// it: the conversion once cut no piece inside such a run, so the
				// whole element was one piece of 1.03 s.
				(
					"words=(\"$open\" ${huge[@]}); closed=$close; [[ ${words[1]:0:1} == 'σ' ]]"
						.to_owned(),
					|shell| {
						one_element(shell, "Σ".repeat(ONE_HUGE_ELEMENT_BYTES / 2));
						converting(shell, "words", ShellVariableUpdateTransform::Lowercase);
					},
				),
				// Assigning a scalar, whose conversion was not divided at all:
				// 94.8 ms for this element.
				(
					"copy=\"${huge[@]}$open\"; closed=$close; [[ ${copy:0:2} == 'SS' ]]".to_owned(),
					|shell| {
						one_sharp(shell);
						converting(shell, "copy", ShellVariableUpdateTransform::Uppercase);
					},
				),
				// A run of case-ignorable characters next to a `Σ`. Deciding
				// whether that one `Σ` is the final form once read the whole
				// value from it: 358 ms with the run before, 355 ms with it
				// after and 712 ms with runs on both sides, inside a single
				// `convert_piece` that the 8 KiB cut could not divide. The
				// hold is not in the conversion anyone asked for; it is in
				// deciding what one character means.
				(
					"words=(\"$open\" ${huge[@]}); closed=$close; [[ ${words[1]:0:1} == 'a' ]]"
						.to_owned(),
					|shell| {
						let marks = "\u{0301}".repeat(ONE_HUGE_ELEMENT_BYTES / 4);
						one_element(shell, format!("A{marks}Σ!"));
						converting(shell, "words", ShellVariableUpdateTransform::Lowercase);
					},
				),
				(
					"words=(\"$open\" ${huge[@]}); closed=$close; [[ ${words[1]:0:1} == 'a' ]]"
						.to_owned(),
					|shell| {
						let marks = "\u{0301}".repeat(ONE_HUGE_ELEMENT_BYTES / 8);
						one_element(shell, format!("A{marks}Σ{marks}!"));
						converting(shell, "words", ShellVariableUpdateTransform::Lowercase);
					},
				),
				// Appending to a converting variable converts the whole result,
				// so the value already in the variable is the other operand and
				// it was walked in one synchronous step. The value here is
				// already in the form the attribute wants, so the 25.2 ms this
				// held was the pass itself rather than any conversion; a `ß`
				// that had work to do held 75.2 ms.
				(
					"x=$open; copy+=x; closed=$close; [[ ${copy:0:1} == 'S' ]]".to_owned(),
					|shell| {
						let mut variable =
							ShellVariable::new(ShellValue::String("S".repeat(ONE_HUGE_ELEMENT_BYTES)));
						variable.set_update_transform(ShellVariableUpdateTransform::Uppercase);
						shell.env_mut().set_global("copy", variable).expect("converting variable");
					},
				),
				// The same for an array element. Appending at an index does not
				// re-convert the element, but it copies it, and one element can
				// be any size: 27.9 ms for an indexed element of 64 MiB, and
				// 60.0 ms for an associative one, which copied it a second time
				// through a `clone` that nothing read.
				(
					"x=$open; huge[0]+=x; closed=$close; [[ ${huge[0]:0:1} == 'h' ]]".to_owned(),
					one_huge,
				),
				(
					"x=$open; assoc[k]+=x; closed=$close; [[ ${assoc[k]:0:1} == 'h' ]]".to_owned(),
					|shell| {
						let values: BTreeMap<String, String> =
							std::iter::once((String::from("k"), "h".repeat(ONE_HUGE_ELEMENT_BYTES)))
								.collect();
						shell
							.env_mut()
							.set_global("assoc", ShellVariable::new(ShellValue::AssociativeArray(values)))
							.expect("assoc");
					},
				),
				// Replacing an element of a converting array, which converted
				// the value twice: once through the divided converter and then
				// again inside the synchronous assignment, 24.8 ms of it in the
				// second pass.
				(
					"arr[0]=$open; arr[1]=\"${huge[@]}\"; closed=$close; \
					 [[ ${arr[1]:0:2} == 'SS' ]]"
						.to_owned(),
					|shell| {
						one_sharp(shell);
						let mut variable = ShellVariable::new(ShellValue::IndexedArray(
							BTreeMap::new(),
						));
						variable.set_update_transform(ShellVariableUpdateTransform::Uppercase);
						shell.env_mut().set_global("arr", variable).expect("converting array");
					},
				),
				// Promoting a scalar to an array on the way to an indexed
				// append copied the whole scalar, before the divided path it
				// leads to had begun: 25.8 ms on 64 MiB. The promotion now
				// moves the string rather than copying it.
				(
					"x=$open; huge[0]+=x; closed=$close; [[ ${huge[0]:0:1} == 'h' ]]".to_owned(),
					|shell| {
						let scalar = ShellVariable::new(ShellValue::String(
							"h".repeat(ONE_HUGE_ELEMENT_BYTES),
						));
						shell.env_mut().set_global("huge", scalar).expect("huge scalar");
					},
				),
				// The same element reached by its other spelling: a scalar
				// appended to a variable that holds an array is an append to
				// element zero, and it took the synchronous route — 25.7 ms
				// indexed, 25.9 ms associative.
				(
					"x=$open; huge+=x; closed=$close; [[ ${huge[0]:0:1} == 'h' ]]".to_owned(),
					one_huge,
				),
				(
					"x=$open; assoc+=x; closed=$close; [[ ${assoc[0]:0:1} == 'h' ]]".to_owned(),
					|shell| {
						let values: BTreeMap<String, String> =
							std::iter::once((String::from("0"), "h".repeat(ONE_HUGE_ELEMENT_BYTES)))
								.collect();
						shell
							.env_mut()
							.set_global("assoc", ShellVariable::new(ShellValue::AssociativeArray(values)))
							.expect("assoc");
					},
				),
				// A variable that converts nothing keeps its buffer and appends
				// in place, which is worth having — but keeping the buffer and
				// copying into it in one call are two different things, and
				// the fast path skipped both: 64 MiB arriving held the worker
				// 24.6 ms inside one `push_str`.
				(
					"copy=$open; copy+=\"${huge[@]}\"; closed=$close; (( ${#copy} > 1000 ))"
						.to_owned(),
					one_huge,
				),
				// A `for` variable is assigned one element of an array per
				// turn, and the loop had execution parameters in hand while
				// taking the synchronous assignment: an uppercase attribute on
				// it held the worker 85.0 ms on a 64 MiB element.
				(
					"x=$open; for arr in \"${huge[@]}\"; do [[ x == x ]]; done; closed=$close"
						.to_owned(),
					|shell| {
						one_sharp(shell);
						converting(shell, "arr", ShellVariableUpdateTransform::Uppercase);
					},
				),
			];

			for (command, prepare) in cases {
				assert_yields_throughout(&command, prepare);
			}
		}

		/// A word whose only glob characters are brackets that never close is
		/// not a pattern, and finding that out read every byte of it in one
		/// step: the grammar took 1.5 s over 64 MiB of text with a `]` at
		/// either end or a `[` at the end, and 8.5 s with the `[` at the start,
		/// where it read every byte after it as a member of a bracket
		/// expression. Each window holds the pathname expansion of that word
		/// and the assignment.
		#[test]
		fn unmatched_brackets_yield_throughout() {
			let cases: [fn(&mut Shell<DefaultShellExtensions>); 4] = [
				|shell| one_element(shell, format!("{}]", "h".repeat(ONE_HUGE_ELEMENT_BYTES))),
				|shell| one_element(shell, format!("]{}", "h".repeat(ONE_HUGE_ELEMENT_BYTES))),
				|shell| one_element(shell, format!("{}[", "h".repeat(ONE_HUGE_ELEMENT_BYTES))),
				|shell| one_element(shell, format!("[{}", "h".repeat(ONE_HUGE_ELEMENT_BYTES))),
			];

			for prepare in cases {
				assert_yields_throughout(
					"words=(\"$open\" ${huge[@]}); closed=$close; (( ${#words[@]} == 2 ))",
					prepare,
				);
			}
		}

		/// A builtin `clap` parses, taking any arguments and doing nothing
		/// with them: it stands in for `printf` and `source`, which the bare
		/// shell lacks.
		#[derive(clap::Parser)]
		struct TakesArguments {
			#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
			_args: Vec<String>,
		}

		impl builtins::Command for TakesArguments {
			type Error = error::Error;

			async fn execute<SE: extensions::ShellExtensions>(
				&self,
				_context: commands::ExecutionContext<'_, SE>,
			) -> Result<ExecutionResult, Self::Error> {
				Ok(ExecutionResult::success())
			}
		}

		/// `huge`, and the builtin `takes`.
		fn one_huge_and_takes(shell: &mut Shell<DefaultShellExtensions>) {
			one_huge(shell);
			shell.register_builtin(
				"takes",
				builtins::builtin::<TakesArguments, DefaultShellExtensions>(),
			);
		}

		/// `many`: 255 elements of one byte stride each, about 16 MiB in all,
		/// with each element `text`; and the builtin `takes`.
		fn many_strides(shell: &mut Shell<DefaultShellExtensions>, text: &str) {
			let values: BTreeMap<u64, String> = (0..255).map(|index| (index, text.to_owned())).collect();
			shell
				.env_mut()
				.set_global("many", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("many");
			shell.register_builtin(
				"takes",
				builtins::builtin::<TakesArguments, DefaultShellExtensions>(),
			);
		}

		/// Steps that are single calls into a library, with nothing inside
		/// them that can yield: `clap` parsing a builtin's arguments (about 52
		/// ms on a 64 MiB one), the regex engine matching a 64 MiB subject
		/// (340 ms), and a function's positional parameters copied before the
		/// copy was charged (26 ms). A parameter's own value was copied the
		/// same way: `"$big"`, `"$1"` and `"${a[0]}"` each held 24.6–25.9 ms in
		/// one `to_string`. The arguments of 255 strides each are the
		/// many-small-arguments shape: the rendering of `BASH_COMMAND` took the
		/// plain join for any count up to 256, 5.5 ms for these, and 240 ms
		/// when `BASH_COMMAND` lowercases what it is given.
		#[test]
		fn library_calls_and_command_lines_yield_throughout() {
			let cases: [(&str, fn(&mut Shell<DefaultShellExtensions>)); 7] = [
				("takes \"$open${huge[0]}\"; closed=$close", one_huge_and_takes),
				("takes \"$open$big\"; closed=$close", |shell| {
					one_huge_and_takes(shell);
					let big = ShellVariable::new(ShellValue::String("h".repeat(ONE_HUGE_ELEMENT_BYTES)));
					shell.env_mut().set_global("big", big).expect("big");
				}),
				("f() { takes \"$open$1\"; }; f \"${huge[@]}\"; closed=$close", one_huge_and_takes),
				("[[ \"$open${huge[0]}\" =~ ^(h*)$ ]]; closed=$close; (( ${#BASH_REMATCH[1]} > 0 ))", one_huge),
				("f() { x=1; }; f \"$open${huge[0]}\"; closed=$close", one_huge),
				("takes \"$open\" \"${many[@]}\"; closed=$close", |shell| {
					many_strides(shell, &"h".repeat(64 << 10));
				}),
				// `declare -l BASH_COMMAND`, which the bare shell cannot say.
				("takes \"$open\" \"${many[@]}\"; closed=$close", |shell| {
					many_strides(shell, &"Σ".repeat(32 << 10));
					let mut command = ShellVariable::new(ShellValue::String(String::new()));
					command.set_update_transform(ShellVariableUpdateTransform::Lowercase);
					shell.env_mut().set_global("BASH_COMMAND", command).expect("BASH_COMMAND");
				}),
			];

			for (command, prepare) in cases {
				assert_yields_throughout(command, prepare);
			}
		}

		/// A subshell inherits a copy of every variable, and `Shell::clone`
		/// made that copy in one step: each pipeline stage, command
		/// substitution and `( … )` of a shell holding a 64 MiB variable held
		/// the worker 25.3 ms before it ran anything. A million-element array
		/// is the many-small-values shape of the same copy, and of the free
		/// when the subshell ends, which held the worker 28 ms; that window
		/// closes after the free.
		#[test]
		fn subshells_of_a_large_environment_yield_throughout() {
			let cases: [(&str, fn(&mut Shell<DefaultShellExtensions>)); 4] = [
				("x=$open; y=$( x=1 ); closed=$close", one_huge),
				("x=$open; ( x=1 ); closed=$close", one_huge),
				("x=$open; f() { x=1; }; f | f; closed=$close", one_huge),
				("x=$open; ( x=1 ); closed=$close", seeded),
			];

			for (command, prepare) in cases {
				assert_yields_throughout(command, prepare);
			}
		}

		/// Replacing a million-element array frees it, one allocator call an
		/// element and nothing a checkpoint can enter: `huge=()` held the
		/// worker 19.5 ms in one poll. The free is off the worker now, so the
		/// window holds almost no work, which [`assert_yields_throughout`]
		/// refuses as a case that cannot fail. This one can, and the second
		/// half shows it: the same free made in place holds the worker past
		/// the bound.
		#[test]
		fn replacing_a_large_array_frees_it_off_the_worker() {
			let command = "x=$open; seed=(); closed=$close";
			let holds = longest_hold(command, seeded);
			eprintln!("HOLD {command}: {holds}");
			assert!(holds.succeeded, "{command}: the run succeeded");
			assert!(yields_throughout(&holds), "{command}: {holds}");

			let _serial = lock(&MEASURED_RUN);
			settle_the_allocator();
			let values: BTreeMap<u64, String> =
				(0..ARRAY_ELEMENTS).map(|index| (index, format!("v{index}"))).collect();
			let before = reading();
			drop(values);
			let after = reading();
			let held = (after.cpu - before.cpu).saturating_sub(after.in_allocator - before.in_allocator);
			eprintln!("FREE in place: {held:?}");
			assert!(held > LONGEST_ALLOWED_HOLD, "freeing in place held the worker only {held:?}");
		}

		/// `zeros`: 64 MiB of `0`, and `n`, a variable with the integer
		/// attribute.
		fn zeros_and_an_integer(shell: &mut Shell<DefaultShellExtensions>) {
			let zeros = ShellVariable::new(ShellValue::String("0".repeat(ONE_HUGE_ELEMENT_BYTES)));
			shell.env_mut().set_global("zeros", zeros).expect("zeros");
			let mut n = ShellVariable::new(ShellValue::String(String::from("0")));
			n.treat_as_integer();
			shell.env_mut().set_global("n", n).expect("n");
		}

		/// Arithmetic over generated text is one parse of all of it: a
		/// literal's subscript of 64 MiB of zeros held the worker 155 ms once
		/// subscripts became arithmetic, and the value of an integer variable
		/// is the same parse.
		#[test]
		fn arithmetic_on_long_text_yields_throughout() {
			let cases: [(&str, fn(&mut Shell<DefaultShellExtensions>)); 3] = [
				("x=([$open$zeros]=v); closed=$close; [[ ${x[0]} == v ]]", zeros_and_an_integer),
				("x[$open$zeros]=v; closed=$close; [[ ${x[0]} == v ]]", zeros_and_an_integer),
				("n=$open$zeros; closed=$close; [[ $n == 0 ]]", zeros_and_an_integer),
			];

			for (command, prepare) in cases {
				assert_yields_throughout(command, prepare);
			}
		}

		/// A long word that does not parse falls back to one whole parse, so
		/// that its error is the whole parse's: a 16 MiB `PS1` that opens a
		/// quote and never closes it held the worker 375 ms in that parse.
		///
		/// **And the stepped parse it replaces is freed off the worker too.**
		/// A million `"h"` pieces before the quote that never closes held the
		/// worker 33.8 ms, 364.5 ms under load, after the fallback had moved:
		/// the pieces the stepped parse had made were freed where it was.
		#[test]
		fn a_prompt_that_does_not_parse_yields_throughout() {
			let _serial = lock(&MEASURED_RUN);
			settle_the_allocator();
			let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
			runtime.block_on(async {
				let specs = [
					("unclosed quote", format!("\"{}", "h".repeat(16 << 20))),
					("a million pieces, then an unclosed quote", format!("{}\"", "\"h\"".repeat(1_000_000))),
				];
				for (shape, spec) in specs {
					let mut shell = Shell::builder().build().await.expect("shell");
					shell.env_mut().set_global("PS1", ShellVariable::new(ShellValue::String(spec))).expect("PS1");
					let (prompt, longest) = longest_poll(shell.compose_prompt()).await;
					eprintln!("PROMPT {shape}: longest_poll={longest:?}");
					assert!(prompt.is_err(), "{shape}: the prompt does not parse");
					assert!(longest <= LONGEST_ALLOWED_HOLD, "{shape}: held the worker {longest:?}");
				}
			});
		}

		/// **What an expression reads is not the expression.** A reference is
		/// a name of a few bytes, and the value it names was copied and parsed
		/// in one step: `x=([zeros]=v)` held the worker 199.3 ms, 536.0 ms
		/// under load, `n=zeros` on an integer 105.1 ms, and `for n in zeros`
		/// 104.9 ms, where the same digits spelled into the expression were
		/// already parsed off the worker.
		#[test]
		fn arithmetic_references_to_long_values_yield_throughout() {
			let cases = [
				"o=$open; x=([zeros]=v); closed=$close; [[ ${x[0]} == v ]]",
				"o=$open; n=zeros; closed=$close; [[ $n == 0 ]]",
				"o=$open; for n in zeros; do :; done; closed=$close; [[ $n == 0 ]]",
				"o=$open; (( m = zeros + 1 )); closed=$close; [[ $m == 1 ]]",
				"o=$open; y=$(( zeros )); closed=$close; [[ $y == 0 ]]",
			];

			for command in cases {
				assert_yields_throughout(command, zeros_and_an_integer);
			}
		}

		/// A provider that takes every path for a directory.
		#[derive(Debug)]
		struct EveryPathIsADirectory;

		#[async_trait::async_trait]
		impl pi_vfs::FileSystem for EveryPathIsADirectory {
			fn is_native_local(&self, path: &std::path::Path) -> bool {
				!pi_vfs::is_virtual_path(path)
			}

			async fn open(
				&self,
				_path: &std::path::Path,
				_options: &pi_vfs::OpenOptions,
			) -> std::io::Result<pi_vfs::File> {
				Err(std::io::ErrorKind::Unsupported.into())
			}

			async fn metadata(&self, _path: &std::path::Path) -> std::io::Result<pi_vfs::Metadata> {
				Ok(std::fs::metadata("/")?.into())
			}

			async fn read_dir(&self, _path: &std::path::Path) -> std::io::Result<pi_vfs::ReadDir> {
				Ok(pi_vfs::ReadDir::from_entries(vec![]))
			}
		}

		/// **What `cd` resolves is the target joined to the working
		/// directory.** Inside an accepted 64 MiB virtual directory, `.`,
		/// `child` and `../sibling` held the worker 63–64 ms, 179–277 ms under
		/// load, because the gate that decides where to resolve measured the
		/// target alone.
		#[test]
		fn a_short_target_in_a_long_directory_yields_throughout() {
			let _serial = lock(&MEASURED_RUN);
			settle_the_allocator();
			let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
			runtime.block_on(async {
				let start = format!("virtual://root/{}/leaf", "x".repeat(ONE_HUGE_ELEMENT_BYTES));
				for target in [".", "child", "../sibling"] {
					let mut shell = Shell::builder().build().await.expect("shell");
					shell.set_filesystem(pi_vfs::Fs::new(Arc::new(EveryPathIsADirectory)));
					shell.set_working_dir(&start).await.expect("the long directory");
					let expected = pi_vfs::normalize_lexically(&pi_vfs::join_path(
						std::path::Path::new(&start),
						std::path::Path::new(target),
					));
					let (changed, longest) = longest_poll(shell.set_working_dir(target)).await;
					eprintln!("CD {target:?} in a long directory: longest_poll={longest:?}");
					changed.expect("cd");
					assert!(shell.working_dir() == expected, "{target:?}: the working directory");
					assert!(
						shell.env().get_str("OLDPWD", &shell).is_some_and(|oldpwd| oldpwd == start),
						"{target:?}: OLDPWD"
					);
					assert!(longest <= LONGEST_ALLOWED_HOLD, "{target:?}: held the worker {longest:?}");
				}
			});
		}

		/// `seed`: 128 elements of `Σ`, `BYTES` long, and `x`, lowercasing
		/// what is assigned to it.
		fn lowercasing_sigma_elements<const BYTES: usize>(shell: &mut Shell<DefaultShellExtensions>) {
			let text = "Σ".repeat(BYTES / 2);
			let values: BTreeMap<u64, String> = (0..128).map(|index| (index, text.clone())).collect();
			shell
				.env_mut()
				.set_global("seed", ShellVariable::new(ShellValue::IndexedArray(values)))
				.expect("seed");
			converting(shell, "x", ShellVariableUpdateTransform::Lowercase);
		}

		/// **A step is cheap only if its work is.** Each step of this loop is
		/// an element-sized one, which reads the thread's clock one time in
		/// sixteen, and each converted up to 64 KiB of `Σ` in one piece: over
		/// 4 ms in five loaded trials of five at 65,534 and 65,536 bytes, where
		/// 65,538, which was divided, held 1.040 ms. A conversion is now divided
		/// above its own stride.
		#[test]
		fn a_loop_of_short_conversions_yields_throughout() {
			let cases: [fn(&mut Shell<DefaultShellExtensions>); 3] = [
				lowercasing_sigma_elements::<32_768>,
				lowercasing_sigma_elements::<65_534>,
				lowercasing_sigma_elements::<65_536>,
			];

			for prepare in cases {
				assert_yields_throughout(
					"o=$open; for x in \"${seed[@]}\"; do :; done; closed=$close; [[ -n $x ]]",
					prepare,
				);
			}
		}

		/// `v0` onwards: a hundred thousand small exported variables.
		fn many_exported(shell: &mut Shell<DefaultShellExtensions>) {
			for index in 0..100_000 {
				let mut variable = ShellVariable::new(ShellValue::String(String::from("x")));
				variable.export();
				shell.env_mut().set_global(format!("v{index}"), variable).expect("exported");
			}
		}

		/// `big`: [`ONE_HUGE_ELEMENT_BYTES`] of `h`, exported.
		fn one_huge_exported(shell: &mut Shell<DefaultShellExtensions>) {
			let mut variable = ShellVariable::new(ShellValue::String("h".repeat(ONE_HUGE_ELEMENT_BYTES)));
			variable.export();
			shell.env_mut().set_global("big", variable).expect("big");
		}

		/// `big`: [`ONE_HUGE_ELEMENT_BYTES`] of `h`.
		fn one_huge_scalar(shell: &mut Shell<DefaultShellExtensions>) {
			let variable = ShellVariable::new(ShellValue::String("h".repeat(ONE_HUGE_ELEMENT_BYTES)));
			shell.env_mut().set_global("big", variable).expect("big");
		}

		/// An exported variable whose name is [`ONE_HUGE_ELEMENT_BYTES`] long.
		fn one_huge_exported_name(shell: &mut Shell<DefaultShellExtensions>) {
			let mut variable = ShellVariable::new(ShellValue::String(String::from("x")));
			variable.export();
			shell.env_mut().set_global("v".repeat(ONE_HUGE_ELEMENT_BYTES), variable).expect("long name");
		}

		/// **What starting a command touches is everything composed into it.**
		/// A hundred thousand small exported variables held the worker
		/// 90.8 ms before `/usr/bin/true`, 418.6 ms under load, though none
		/// was long; an argument or a variable too long for the operating
		/// system is still copied to where the command starts, and refused
		/// there by the spawn rather than by a length check of the shell's.
		/// Inside a function, where a name can be shadowed, a long exported
		/// name was hashed in one call to resolve shadowing: 10.1 ms quiet for
		/// a 64 MiB name with nothing exported inside the function, which
		/// needs no hashing at all, and as long with something exported there.
		#[test]
		fn starting_an_external_command_yields_throughout() {
			let cases: [(&str, fn(&mut Shell<DefaultShellExtensions>)); 6] = [
				("o=$open; /usr/bin/true; closed=$close", many_exported),
				("o=$open; /usr/bin/true; closed=$close", one_huge_exported),
				("o=$open; /usr/bin/true \"$big\"; closed=$close", one_huge_scalar),
				("o=$open; /usr/bin/true \"$big\" \"$big\"; closed=$close", one_huge_scalar),
				("f() { /usr/bin/true; }; o=$open; f; closed=$close", one_huge_exported_name),
				("f() { local -x inner=1; /usr/bin/true; }; o=$open; f; closed=$close", one_huge_exported_name),
			];

			for (command, prepare) in cases {
				assert_yields_throughout(command, prepare);
			}
		}

		/// **A copy of the shell reads no name to hash it.** Every subshell
		/// copies every variable, and the copy hashed each name in one call
		/// as it inserted it into a new map, so an exported variable whose
		/// name is 64 MiB long held the worker for that hash on each
		/// subshell, pipeline stage and command substitution. Each variable
		/// is now placed by the hash it was stored with.
		#[test]
		fn copying_the_shell_yields_throughout() {
			for command in [
				"o=$open; ( : ); closed=$close",
				"o=$open; : | :; closed=$close",
				"o=$open; x=$(:); closed=$close",
			] {
				assert_yields_throughout(command, one_huge_exported_name);
			}
		}

		/// The longest single poll `future` takes, outside the allocator
		/// calls [`TimesLargeCalls`] times.
		async fn longest_poll<F: Future>(future: F) -> (F::Output, Duration) {
			let mut future = std::pin::pin!(future);
			let mut longest = Duration::ZERO;
			let output = std::future::poll_fn(|cx| {
				let before = reading();
				let poll = future.as_mut().poll(cx);
				let after = reading();
				let held = (after.cpu - before.cpu).saturating_sub(after.in_allocator - before.in_allocator);
				longest = longest.max(held);
				poll
			})
			.await;
			(output, longest)
		}

		/// Rendering `BASH_COMMAND` for every shape of command line, the way
		/// each was measured over the bound: arguments of a stride each up to
		/// the old count limit, a `BASH_COMMAND` that lowercases, an expanded
		/// array key and element subscript of 64 MiB, and a million small and
		/// a million empty array assignments. Each renders to what `Display`
		/// writes, and no poll holds the worker past the bound.
		#[test]
		fn every_command_line_shape_renders_within_the_bound() {
			use commands::{CommandArg, ShellForCommand, SimpleCommand};
			use brush_parser::ast;

			let _serial = lock(&MEASURED_RUN);
			settle_the_allocator();
			let word = |value: String| ast::Word { value, loc: None };
			let assignment = |name: ast::AssignmentName, value: ast::AssignmentValue| {
				CommandArg::Assignment(ast::Assignment { name, value, append: false, loc: Default::default() })
			};
			let shapes: Vec<(&str, Vec<CommandArg>)> = vec![
				("strides", (0..256).map(|_| CommandArg::String("h".repeat(64 << 10))).collect()),
				("lowercased", (0..256).map(|_| CommandArg::String("Σ".repeat(32 << 10))).collect()),
				("array key", vec![assignment(
					ast::AssignmentName::VariableName("x".into()),
					ast::AssignmentValue::Array(vec![(Some(word("k".repeat(64 << 20))), word("v".into()))]),
				)]),
				("element subscript", vec![assignment(
					ast::AssignmentName::ArrayElementName("x".into(), "k".repeat(64 << 20)),
					ast::AssignmentValue::Scalar(word("v".into())),
				)]),
				("small assignments", (0..1_000_000)
					.map(|_| assignment(ast::AssignmentName::VariableName("x".into()), ast::AssignmentValue::Scalar(word(String::new()))))
					.collect()),
				("empty arrays", (0..1_000_000)
					.map(|_| assignment(ast::AssignmentName::VariableName("x".into()), ast::AssignmentValue::Array(vec![])))
					.collect()),
			];

			let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
			runtime.block_on(async {
				for (label, args) in shapes {
					let mut shell = Shell::builder().build().await.expect("shell");
					let lowercased = label == "lowercased";
					let mut command_variable = ShellVariable::new(ShellValue::String(String::new()));
					if lowercased {
						command_variable.set_update_transform(ShellVariableUpdateTransform::Lowercase);
					}
					shell.env_mut().set_global("BASH_COMMAND", command_variable).expect("BASH_COMMAND");
					let rendered = args.iter().map(ToString::to_string).join(" ");
					let expected = if lowercased { rendered.to_lowercase() } else { rendered };

					let params = shell.default_exec_params();
					let mut command =
						SimpleCommand::new(ShellForCommand::ParentShell(&mut shell), params, "noop".into(), args);
					let (outcome, longest) = longest_poll(commands::on_preexecute(&mut command)).await;
					outcome.expect("rendered");
					drop(command);

					eprintln!("RENDER {label}: longest_poll={longest:?}");
					assert!(
						shell.env().get_str("BASH_COMMAND", &shell).is_some_and(|value| value == expected),
						"{label}: BASH_COMMAND holds what Display writes"
					);
					assert!(longest <= LONGEST_ALLOWED_HOLD, "{label}: held the worker {longest:?}");
				}
			});
		}

		/// How many steps `steps` takes, and what each costs: a fortieth of
		/// the bound, so sixteen of them — a reading of the clock — stay well
		/// under it and 128 — one turn of Tokio's budget — are far over it.
		const STEPS: usize = 512;
		const STEP: Duration = Duration::from_micros(if cfg!(debug_assertions) { 250 } else { 100 });

		/// The cases' builtin `steps`: [`STEPS`] steps of [`STEP`] of the
		/// thread's CPU time, spending `interp::loop_checkpoint` before each, as
		/// the interpreter's loops do.
		fn steps(
			context: commands::ExecutionContext<'_, DefaultShellExtensions>,
			_args: Vec<commands::CommandArg>,
		) -> builtins::BoxFuture<'_, Result<ExecutionResult, error::Error>> {
			Box::pin(async move {
				for _ in 0..STEPS {
					crate::interp::loop_checkpoint(&context.params).await?;
					spin(STEP);
				}
				Ok(ExecutionResult::success())
			})
		}

		/// A loop whose steps each cost more than Tokio's budget assumes.
		/// Tokio yields once per 128 checkpoints spent, whatever they cost, so
		/// with the thread's clock taken out of `loop_checkpoint`, 128 steps of
		/// 100 µs each held the worker 12.9 ms; with it, a checkpoint yields
		/// about a millisecond in. Every other case's steps are cheap enough
		/// that the budget alone kept them under the bound, so none of them
		/// could tell the clock was gone.
		#[test]
		fn dear_steps_yield_throughout() {
			assert_yields_throughout("x=$open; steps; closed=$close", register_controls);
		}

		/// The controls' builtin. For each argument, in order: `spin` runs
		/// [`CONTROL_HOLD`] of the thread's CPU time without yielding, and
		/// `free` frees the buffer [`set_aside_a_large_buffer`] left, in one
		/// allocator call. Nothing between them yields.
		struct HoldsTheWorker;

		impl builtins::SimpleCommand for HoldsTheWorker {
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
				for arg in args {
					match arg.as_ref() {
						"spin" => spin(CONTROL_HOLD),
						"free" => drop(std::mem::take(&mut *lock(&SET_ASIDE))),
						_ => {},
					}
				}
				Ok(ExecutionResult::success())
			}
		}

		/// Runs `length` of the thread's CPU time. Thread CPU time, not wall
		/// clock: the harness measures the worker's CPU time, so a wall-clock
		/// spin that shares its core with anything else hands back a shorter
		/// stretch than it meant to and the control stops controlling anything.
		fn spin(length: Duration) {
			let until = worker_cpu_time() + length;
			while worker_cpu_time() < until {
				std::hint::spin_loop();
			}
		}

		/// What `holds free` frees: large enough that freeing it is a stretch
		/// of its own.
		static SET_ASIDE: Mutex<Vec<u8>> = Mutex::new(Vec::new());

		/// How long `pads` runs, and how often it yields while it does.
		const PADDING: Duration = Duration::from_millis(if cfg!(debug_assertions) { 500 } else { 200 });
		const PADDING_SLICE: Duration =
			Duration::from_micros(if cfg!(debug_assertions) { 1250 } else { 500 });

		/// The controls' other builtin: [`PADDING`] of the thread's CPU time,
		/// yielding after every [`PADDING_SLICE`] of it — work that yields as
		/// the rule wants, to fill a window with.
		fn pads(
			_context: commands::ExecutionContext<'_, DefaultShellExtensions>,
			_args: Vec<commands::CommandArg>,
		) -> builtins::BoxFuture<'_, Result<ExecutionResult, error::Error>> {
			Box::pin(async {
				let until = worker_cpu_time() + PADDING;
				while worker_cpu_time() < until {
					spin(PADDING_SLICE);
					tokio::task::yield_now().await;
				}
				Ok(ExecutionResult::success())
			})
		}

		fn register_controls(shell: &mut Shell<DefaultShellExtensions>) {
			shell.register_builtin(
				"holds",
				builtins::simple_builtin::<HoldsTheWorker, DefaultShellExtensions>(),
			);
			let asynchronous: [(&str, builtins::CommandExecuteFunc<DefaultShellExtensions>); 2] =
				[("pads", pads), ("steps", steps)];
			for (name, execute_func) in asynchronous {
				shell.register_builtin(name, builtins::Registration {
					execute_func,
					content_func: |_, _, _| Ok(String::new()),
					disabled: false,
					special_builtin: false,
					declaration_builtin: false,
					transparent_background_wrapper: false,
					async_io: true,
				});
			}
		}

		/// [`register_controls`], and a 128 MiB buffer, every page written,
		/// for `holds free` to free.
		fn set_aside_a_large_buffer(shell: &mut Shell<DefaultShellExtensions>) {
			register_controls(shell);
			*lock(&SET_ASIDE) = vec![1; 128 << 20];
		}

		/// The control for the bound.
		///
		/// A bound is a latency tolerance, not evidence that a passing
		/// measurement checkpoints: a loop that spends nothing and runs for less
		/// than the bound passes. This runs one just over it and requires the
		/// rule to reject it, so the bound cannot be raised over a stretch it is
		/// meant to catch without a test saying so.
		#[test]
		fn the_hold_rule_catches_a_checkpoint_free_stretch() {
			let holds = longest_hold("x=$open; holds spin; closed=$close", register_controls);
			eprintln!("CONTROL spin: {holds}");

			assert!(holds.succeeded, "the control run succeeded");
			assert!(holds.longest_held >= CONTROL_HOLD, "the spin was measured: {holds}");
			assert!(
				!yields_throughout(&holds),
				"a {CONTROL_HOLD:?} stretch with no checkpoint is rejected: {holds}"
			);
		}

		/// The control for bounding each stretch rather than its share of the
		/// window.
		///
		/// The rule this replaced rejected two or three 25 ms stretches alone
		/// and accepted the same stretches with 220 ms of work around them that
		/// yielded every millisecond: what a pass with its checkpoints deleted
		/// looks like in the middle of a long expansion. The padding alone must
		/// pass, so what is rejected is the spins.
		#[test]
		fn the_hold_rule_is_not_diluted_by_work_that_yields() {
			let padding = longest_hold("x=$open; pads; closed=$close", register_controls);
			eprintln!("CONTROL padding: {padding}");
			assert!(padding.succeeded, "the padding run succeeded");
			assert!(yields_throughout(&padding), "work that yields passes: {padding}");

			let holds = longest_hold(
				"x=$open; pads; holds spin; pads; holds spin; pads; closed=$close",
				register_controls,
			);
			eprintln!("CONTROL diluted spins: {holds}");
			assert!(holds.succeeded, "the control run succeeded");
			assert!(
				holds.window >= PADDING * 3 && holds.longest_held >= CONTROL_HOLD,
				"the padding and the spins were measured: {holds}"
			);
			assert!(
				!yields_throughout(&holds),
				"a {CONTROL_HOLD:?} stretch is rejected however much yielding work is around it: \
				 {holds}"
			);
		}

		/// The control for taking allocator calls out of a stretch.
		///
		/// It has to see them in this build, with the system allocator: freeing
		/// a large buffer is a stretch the rule passes because almost all of it
		/// is that call. And it has to take out only them: the same free with a
		/// spin after it, no yield between, is rejected.
		#[test]
		fn the_allocator_exemption_is_the_allocator_call_alone() {
			let free = longest_hold("x=$open; holds free; closed=$close", set_aside_a_large_buffer);
			eprintln!("CONTROL free: {free}");
			assert!(free.succeeded, "the free run succeeded");
			assert!(
				free.in_allocator * 4 >= free.longest * 3,
				"the free was measured as allocator time: {free}"
			);
			assert!(yields_throughout(&free), "a stretch that is one allocator call passes: {free}");

			let holds =
				longest_hold("x=$open; holds free spin; closed=$close", set_aside_a_large_buffer);
			eprintln!("CONTROL free then spin: {holds}");
			assert!(holds.succeeded, "the control run succeeded");
			assert!(
				holds.in_allocator > Duration::ZERO && holds.longest_held >= CONTROL_HOLD,
				"the free and the spin were measured: {holds}"
			);
			assert!(
				!yields_throughout(&holds),
				"a spin is rejected even in the stretch of an allocator call: {holds}"
			);
		}
	}
}
