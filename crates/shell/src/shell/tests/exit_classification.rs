//! Exit notices distinguish early exit/errexit from other shell termination.
//!
//! Continuation input-space matrix:
//! - loops: while/until, word/select/repeat, arithmetic (present/omitted test),
//!   nested records, first/second iteration, condition/body interruption;
//! - suffix: absent, unconditional, &&/||, negated, inside/outside a caller;
//! - layout: semicolon/newline, root/brace/function/eval;
//! - cleanup: active/unentered try, try/always interruption, nested snapshots;
//! - traps: text/function carriers, saved success/failure,
//!   resume-in-place/unwind;
//! - spawns: future work versus an already-running inline stage's continuation.
//!
//! Status expectations follow `loop_note`/`loop_exit`,
//! `always_enter`/`always_end` and trap restoration; loop termination is
//! deliberately not predicted.

use super::*;

async fn run_exit_case(shell: &Shell, command: &str) -> ShellRunResult {
	shell
		.run(
			ShellRunOptions { command: command.into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("shell run")
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_posix_fatal_is_not_an_exit_notice() {
	let _guard = shell_test_lock().lock().await;
	for command in [
		"set +e; set -o posix; readonly x=1; x=2; echo never",
		"set +e; set -o posix; readonly RO=1; RO=2 :; echo never",
		"set +e; set -o posix; : < /no/such/exit-classification-file; echo never",
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_ne!(result.exit_code, Some(0), "{command}");
		assert!(!result.ended_by_exit, "fatal termination is not exit/errexit: {command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_segmented_exec_stops_without_exit_notice() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("chain directory");
	let minimizer = printf_minimizer(&root.path().join("minimizer.toml"), None);
	let shell = Shell::new(Some(ShellOptions { minimizer: Some(minimizer), ..Default::default() }));
	run_exit_case(&shell, "f() { exec /usr/bin/true; }").await;
	let result = run_exit_case(&shell, "f; printf hello; exit 73").await;
	assert_eq!(result.exit_code, Some(0), "exec still terminates the segmented chain");
	assert!(!result.ended_by_exit, "exec does not become exit when a later segment remains");
	assert!(
		!run_exit_case(&shell, "printf hello; printf world")
			.await
			.ended_by_exit
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_cleanup_preserves_first_exit_report() {
	let _guard = shell_test_lock().lock().await;
	for trap in [":", "exit 0", "exec /usr/bin/true"] {
		for (tail, expected) in [("", false), ("; echo never", true)] {
			let shell = Shell::new(None);
			let command = format!("trap '{trap}' EXIT; f() {{ exit 0; }}; f{tail}");
			let result = run_exit_case(&shell, &command).await;
			assert_eq!(result.ended_by_exit, expected, "{command}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_successors_follow_terminating_status() {
	let _guard = shell_test_lock().lock().await;
	for minimized in [
		false,
		#[cfg(unix)]
		true,
	] {
		#[cfg(unix)]
		let root = tempfile::tempdir().expect("chain directory");
		#[cfg(unix)]
		let options = minimized.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		});
		#[cfg(not(unix))]
		let options = None;
		let shell = Shell::new(options);
		for status in [0, 1] {
			for operator in ["&&", "||"] {
				for negated in [false, true] {
					for tail in ["", "; printf tail"] {
						let prefix = if negated { "! " } else { "" };
						let command = format!("{prefix}exit {status} {operator} printf never{tail}");
						let succeeded = (status == 0) != negated;
						let expected = !tail.is_empty() || succeeded == (operator == "&&");
						let result = run_exit_case(&shell, &command).await;
						assert_eq!(result.exit_code, Some(status), "{command}");
						assert_eq!(result.ended_by_exit, expected, "minimized={minimized}: {command}");
					}
				}
			}
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_zsh_captures_suffix_before_function_unwind() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		("f() { exit 0; echo never; }; f", true),
		("f() { exit 0; }; f", false),
		("() { exit 0; echo never; }", true),
		("() { exit 0; }", false),
		("g() { exit 0; }; g; echo never", true),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_composites_set_the_continuation_status() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// An if without else succeeds when its condition fails, so the &&
		// successor WOULD run and was cut short; the || successor would not.
		("if exit 1; then :; fi && printf never", true),
		("if exit 1; then :; fi || printf never", false),
		// A while loop that ends because its condition failed also completes
		// successfully (POSIX: exit status 0 without break).
		("while exit 1; do :; done && printf never", true),
		("while exit 1; do :; done || printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(1), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_negation_crosses_frame_boundaries() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// The negated pipeline inside the function yields failure, so the &&
		// successor would not run and nothing was cut short.
		("f() { ! exit 0; }; f && printf never", false),
		("f() { ! exit 0; }; f || printf never", true),
		("f() { ! ! exit 1; }; f && printf never", false),
		("g() { ! exit 0; }; f() { g; }; f && printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_trap_interruption_keeps_unrun_suffix() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// A DEBUG trap runs before each command: the exit it triggers leaves
		// the following command unrun.
		("trap 'exit 0' DEBUG; printf never", true),
		// An ERR trap firing after a failing command likewise precedes the
		// suffix that never ran.
		("trap 'exit 0' ERR; false; printf never", true),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_zsh_always_cleanup_is_not_cut_input() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		// The only apparent suffix is mandatory cleanup: it runs, so nothing
		// ordinary was cut short.
		("f() { { exit 0; } always { printf cleanup; }; }; f", false),
		// A genuine suffix after the always block remains unrun input.
		("f() { { exit 0; } always { printf cleanup; }; }; f; printf never", true),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_for_loop_keeps_body_status() {
	let _guard = shell_test_lock().lock().await;
	// A for loop's exit status is its last body status, so the || successor
	// would run and was cut short; the && successor would not.
	for (command, expected) in [
		("for x in a; do exit 1; done || printf never", true),
		("for x in a; do exit 1; done && printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(1), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_return_trap_winding_down_is_not_unrun_input() {
	let _guard = shell_test_lock().lock().await;
	// The RETURN trap runs while the function is already leaving: its
	// return command has executed, and nothing ordinary remains.
	let result =
		run_exit_case(&Shell::new(None), "f() { trap 'exit 0' RETURN; return 0; }; f").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_nested_always_stays_cleanup_to_the_outermost_end() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		// The inner always block ends while the outer one still runs: the
		// printf belongs to the outer mandatory cleanup and executes.
		("f() { { exit 0; } always { { :; } always { :; }; printf cleanup; }; }; f", false),
		(
			"f() { { exit 0; } always { { :; } always { :; }; printf cleanup; }; }; f; printf never",
			true,
		),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_always_discards_cleanup_status() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	for (command, expected) in [
		// always_end restores the try-list's status (zero here): the && successor
		// would run and was cut short; the || successor would not.
		("f() { { exit 0; } always { ! :; }; }; f && printf never", true),
		("f() { { exit 0; } always { ! :; }; }; f || printf never", false),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_subshell_in_cleanup_does_not_end_the_walk() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	let result =
		run_exit_case(&shell, "f() { { exit 0; } always { ( : ); }; printf never; }; f").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_exit_trap_child_run_keeps_root_report() {
	let _guard = shell_test_lock().lock().await;
	// A child run the EXIT trap starts (the timeout tool) must not clear
	// the root run's first exit report: the trailing exit at the function's
	// end still classifies as unremarkable.
	let result =
		run_exit_case(&Shell::new(None), "trap 'timeout 1 true' EXIT; f() { exit 0; }; f").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_loop_matrix_operator_pairs() {
	let _guard = shell_test_lock().lock().await;
	// (command, exit status, &&-successor cut short, ||-successor cut short)
	for (command, code, and_cut, or_cut) in [
		// while/until ended by its condition complete with status 0.
		("while exit 1; do :; done", 1, true, false),
		("until exit 0; do :; done", 0, true, false),
		("while exit 2; do :; done", 2, true, false),
		// for/repeat/select exit with the last body status.
		("for x in a; do exit 1; done", 1, false, true),
		("for ((i = 0; i < 1; i++)); do exit 1; done", 1, false, true),
		// An exit inside the loop head's own command leaves the loop's
		// exit status as the condition/command itself left it.
		("while exit 1; do :; break; done", 1, true, false),
	] {
		for (op, expected) in [("&&", and_cut), ("||", or_cut)] {
			let src = format!("{command} {op} printf never");
			let result = run_exit_case(&Shell::new(None), &src).await;
			assert_eq!(result.exit_code, Some(code), "{src}");
			assert_eq!(result.ended_by_exit, expected, "{src}");
		}
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_case_and_else_branches_carry_their_status() {
	let _guard = shell_test_lock().lock().await;
	for (command, code, and_cut, or_cut) in [
		// The matched arm's status is the case's status.
		("case a in a) exit 1;; esac", 1, false, true),
		// The else arm's status is the if's status.
		("if false; then :; else exit 1; fi", 1, false, true),
	] {
		for (op, expected) in [("&&", and_cut), ("||", or_cut)] {
			let src = format!("{command} {op} printf never");
			let result = run_exit_case(&Shell::new(None), &src).await;
			assert_eq!(result.exit_code, Some(code), "{src}");
			assert_eq!(result.ended_by_exit, expected, "{src}");
		}
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_subshells_do_not_end_the_shell() {
	let _guard = shell_test_lock().lock().await;
	for (command, code) in [
		// An exit in a subshell ends the subshell, not the shell: the
		// suffix runs, no exit notice.
		("(exit 0); printf never", 0),
		// The || successor runs (subshell failed) and the run ends with the
		// suffix's own status.
		("(exit 1) || printf never", 0),
		// Command substitution is a subshell too.
		("echo $(exit 1); printf never", 0),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(code), "{command}");
		assert!(!result.ended_by_exit, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_pipeline_and_anonymous_and_eval_frames() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	// exit in a pipeline element ends that element's subshell only: the
	// shell itself keeps running (cat and the suffix both run).
	let result = run_exit_case(&shell, "exit 1 | cat; printf never").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.ended_by_exit);
	// A zsh anonymous function: the exit is not at the input's end when a
	// suffix follows (it never runs); alone at the end it is trailing.
	run_exit_case(&shell, "emulate zsh").await;
	let result = run_exit_case(&shell, "() { exit 0; }; printf never").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit);
	let result = run_exit_case(&shell, "() { exit 0; }").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.ended_by_exit);
	// eval frames unwind to the caller's suffix like function frames.
	let result = run_exit_case(&shell, "eval 'exit 1'; printf never").await;
	assert_eq!(result.exit_code, Some(1));
	assert!(result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_negation_composes_with_composites() {
	let _guard = shell_test_lock().lock().await;
	for (command, expected) in [
		// `!` applies to the whole if: success flips to failure, so the
		// && successor would not run.
		("! if exit 1; then :; fi && printf never", false),
		("! if exit 1; then :; fi || printf never", true),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_runtime_loop_records_seed_the_walk() {
	let _guard = shell_test_lock().lock().await;
	// The loop already holds the first body's status when the exit fires in
	// the second condition test: the restored status selects the successor.
	for (command, expected) in [
		("i=0; while ((i++ == 0)) || exit 1; do false; done || printf never", true),
		("i=0; while ((i++ == 0)) || exit 1; do false; done && printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(1), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_omitted_arithmetic_condition_loops_forever() {
	let _guard = shell_test_lock().lock().await;
	// Owner ruling (option A, structure-based): termination is undecidable
	// and the classifier must not attempt reachability proofs — any
	// submitted command after the interruption counts as unrun input,
	// regardless of whether the loop before it is infinite.
	for (command, expected) in
		[("for ((;;)); do exit 1; done", false), ("for ((;;)); do exit 1; done; printf never", true)]
	{
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(1), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_spawn_parent_continuation_is_followed() {
	let _guard = shell_test_lock().lock().await;
	// A spawned subshell after the exit is descriptor bytecode: the walk
	// resumes at its end and still finds the parent's suffix.
	let result =
		run_exit_case(&Shell::new(None), "{ exit 0; (for ((;0;)); do :; done); printf never; }")
			.await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_unentered_try_always_is_ordinary_input() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	run_exit_case(&shell, "emulate zsh").await;
	// The try block was never entered before the exit: its always-list is
	// unrun input, not already-required cleanup.
	for (command, expected) in [
		("f() { exit 0; { } always { printf never; }; }; f", true),
		// Inside cleanup the try-list's snapshot is restored at the end:
		// the || successor runs (and was cut short); the && would not.
		("f() { { false; } always { exit 0; }; }; f || printf never", true),
		("f() { { false; } always { exit 0; }; }; f && printf never", false),
	] {
		let result = run_exit_case(&shell, command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_trap_restores_interrupted_status() {
	let _guard = shell_test_lock().lock().await;
	// A RETURN trap keeps the interrupted status: return 1 leaves the
	// caller's continuation testing failure, so the || successor would
	// have run.
	for (command, expected) in [
		("f() { trap 'exit 0' RETURN; return 1; }; f || printf never", true),
		("f() { trap 'exit 0' RETURN; return 1; }; f && printf never", false),
	] {
		let result = run_exit_case(&Shell::new(None), command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(result.ended_by_exit, expected, "{command}");
	}
	// A signal trap interrupts between commands: the sole remaining
	// command stays unrun input.
	let result =
		run_exit_case(&Shell::new(None), "trap 'exit 0' USR1; kill -USR1 $$; printf never").await;
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_loop_suffix_is_structural_across_layouts() {
	let _guard = shell_test_lock().lock().await;
	let mut failures = Vec::new();
	for dialect in ["bash", "zsh"] {
		for body in [
			"while true; do exit 1; done",
			"until false; do exit 1; done",
			"for x in a b; do exit 1; done",
			"for ((;;)); do exit 1; done",
			"for ((i=0; i<2; i++)); do exit 1; done",
			"for ((i=0; i<2; i++)); do :; exit 1; done",
			"for ((i=0; i<2; i++)); do if ((i==0)); then exit 1; else printf later; fi; done",
			"for x in a; do for ((;;)); do exit 1; done; done",
		] {
			for separator in ["; ", "\n"] {
				for wrapped in [false, true] {
					for suffix in ["", "printf never"] {
						let code = if suffix.is_empty() {
							body.to_string()
						} else {
							format!("{body}{separator}{suffix}")
						};
						let command = if wrapped {
							format!("f() {{ {code}\n}}; f")
						} else {
							code
						};
						let shell = Shell::new(None);
						run_exit_case(&shell, &format!("emulate {dialect}")).await;
						let result = run_exit_case(&shell, &command).await;
						if result.exit_code != Some(1) || result.ended_by_exit == suffix.is_empty() {
							failures.push(format!("{dialect}: {command:?}: {result:?}"));
						}
					}
				}
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_record_lifecycle_and_cleanup_snapshots() {
	let _guard = shell_test_lock().lock().await;
	let mut failures = Vec::new();
	for (body, succeeded) in [
		("{ { exit 1; } always { :; }; } always { :; }", false),
		("{ { exit 0; } always { :; }; } always { :; }", true),
		("{ { false; } always { exit 0; }; } always { :; }", false),
		("{ { true; } always { exit 1; }; } always { :; }", true),
		("{ for x in a; do { exit 1; } always { :; }; done; } always { :; }", false),
		("{ for x in a; do { exit 0; } always { :; }; done; } always { :; }", true),
	] {
		for (op, expected) in [("&&", succeeded), ("||", !succeeded)] {
			let shell = Shell::new(None);
			run_exit_case(&shell, "emulate zsh").await;
			let command = format!("f() {{ {body}; }}; f {op} printf never");
			let result = run_exit_case(&shell, &command).await;
			if result.ended_by_exit != expected {
				failures.push(format!("{command}: expected {expected}, {result:?}"));
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_spawn_and_trap_carriers() {
	let _guard = shell_test_lock().lock().await;
	let mut failures = Vec::new();
	for (dialect, command, expected) in [
		("bash", "exit 0; ( : )", true),
		("bash", "exit 0; : | :", true),
		("bash", "exit 0; : &", true),
		("bash", "exit 0; coproc { :; }", true),
		("bash", "shopt -s lastpipe; : | exit 0", false),
		("bash", "shopt -s lastpipe; : | exit 0; printf never", true),
		("bash", "shopt -s lastpipe; : | exit 1 && printf never", false),
		("bash", "shopt -s lastpipe; : | exit 1 || printf never", true),
		("zsh", ": | exit 0", false),
		("zsh", ": | exit 0; printf never", true),
		("zsh", "trap 'exit 0' USR1; kill -USR1 $$ && printf never", true),
		("zsh", "trap 'exit 1' USR1; kill -USR1 $$ || printf never", false),
	] {
		let shell = Shell::new(None);
		run_exit_case(&shell, &format!("emulate {dialect}")).await;
		let result = run_exit_case(&shell, command).await;
		if result.ended_by_exit != expected {
			failures.push(format!("{dialect}: {command}: expected {expected}, {result:?}"));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_inline_pipeline_uses_all_pipefail_statuses() {
	let _guard = shell_test_lock().lock().await;
	for dialect in ["bash", "zsh"] {
		for pipefail in [false, true] {
			for left in ["true", "false"] {
				for status in [0, 1] {
					for op in ["&&", "||"] {
						let shell = Shell::new(None);
						run_exit_case(&shell, &format!("emulate {dialect}")).await;
						// Let the first stage finish so its status is runtime fact,
						// not a guess about an in-flight child's eventual result.
						let setting = if pipefail { "-o" } else { "+o" };
						let command = format!(
							"set {setting} pipefail; shopt -s lastpipe; {left} | {{ sleep 0.01; exit \
							 {status}; }} {op} printf never"
						);
						let succeeded = status == 0 && (!pipefail || left == "true");
						let result = run_exit_case(&shell, &command).await;
						assert_eq!(result.exit_code, Some(status), "{dialect}: {command}");
						assert_eq!(
							result.ended_by_exit,
							succeeded == (op == "&&"),
							"{dialect}: {command}"
						);
					}
				}
			}
		}
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_counts_cleanup_only_when_it_is_left_unrun() {
	let _guard = shell_test_lock().lock().await;
	for wrapped in [false, true] {
		for explicit in [false, true] {
			let shell = Shell::new(None);
			run_exit_case(&shell, "emulate zsh").await;
			let interruption = if explicit { "exit 0" } else { "set -e; false" };
			let body = format!("{{ {interruption}; }} always {{ printf cleanup; }}");
			let command = if wrapped {
				format!("f() {{ {body}; }}; f")
			} else {
				body
			};
			let (tx, rx) = flume::unbounded();
			let result = shell
				.run(
					ShellRunOptions { command: command.clone(), ..Default::default() },
					Some(tx),
					CancelToken::default(),
				)
				.await
				.unwrap();
			let cleaned = wrapped && explicit;
			let output: String = rx.try_iter().collect();
			assert_eq!(output, if cleaned { "cleanup" } else { "" }, "{command}");
			assert_eq!(result.ended_by_exit, !cleaned, "{command}");
		}
	}
}

/// Matrix: pipeline attribution must settle sibling statuses before judging
/// the conditional suffix (F1). An unsettled sibling that settles to success
/// leaves `||` unrun either way (no cut-short notice); one that settles to
/// failure under pipefail leaves `||` submitted (notice). Siblings that
/// outlive the settle window keep the conservative unresolved verdict.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_pipeline_sibling_settles_before_attribution() {
	let _guard = shell_test_lock().lock().await;
	for (name, command, expected) in [
		(
			"settle-success",
			"set -o pipefail; shopt -s lastpipe; sleep 0.02 | exit 0 || printf live",
			false,
		),
		(
			"settle-failure",
			"set -o pipefail; shopt -s lastpipe; { sleep 0.02; false; } | exit 0 || printf live",
			true,
		),
		(
			"settle-control",
			"set -o pipefail; shopt -s lastpipe; sleep 0.02 | : || printf live",
			false,
		),
		("no-pipefail", "shopt -s lastpipe; sleep 0.02 | exit 0 || printf live", false),
		(
			"settled-success",
			"set -o pipefail; shopt -s lastpipe; true | { sleep 0.05; exit 0; } || printf live",
			false,
		),
		(
			"early-settled-failure",
			"set -o pipefail; shopt -s lastpipe; false | exit 0 || printf live",
			true,
		),
		("long-sibling", "set -o pipefail; shopt -s lastpipe; sleep 5 | exit 0 || printf live", true),
	] {
		let shell = Shell::new(None);
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.into(), ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("shell run");
		let output: String = rx.try_iter().collect();
		assert!(output.is_empty(), "suffix ran: {command}");
		assert_eq!(result.exit_code, Some(0), "{name}: {command}");
		assert_eq!(result.ended_by_exit, expected, "{name}: {command}");
	}
}

/// Matrix: the unread-source scan must apply alias expansion to raw script
/// words (F2). An alias whose value holds no command leaves nothing to run
/// regardless of layout; a command-valued alias (or a plain word, a quoted
/// word, or expansion being off) still counts as submitted input.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_alias_expanded_unread_source_scan() {
	let _guard = shell_test_lock().lock().await;
	for (name, command, expected) in [
		("empty-newline", "shopt -s expand_aliases\nalias noop=''\nexit 0\nnoop", false),
		("empty-semi", "shopt -s expand_aliases\nalias noop=''\nexit 0; noop", false),
		("comment-newline", "shopt -s expand_aliases\nalias noop='# none'\nexit 0\nnoop", false),
		("comment-semi", "shopt -s expand_aliases\nalias noop='# none'\nexit 0; noop", false),
		("command-newline", "shopt -s expand_aliases\nalias noop=:\nexit 0\nnoop", true),
		("command-semi", "shopt -s expand_aliases\nalias noop=:\nexit 0; noop", true),
		("plain-word-newline", "shopt -s expand_aliases\nexit 0\nnosuchcmd", true),
		("expansion-off", "shopt -u expand_aliases\nalias noop=''\nexit 0\nnoop", true),
		("quoted-word", "shopt -s expand_aliases\nalias noop=''\nexit 0\n'noop'", true),
		("escaped-word", "shopt -s expand_aliases\nalias noop=''\nexit 0\n\\noop", true),
		("chain-empty", "shopt -s expand_aliases\nalias a=b\nalias b=''\nexit 0\na", false),
		("chain-command", "shopt -s expand_aliases\nalias a=b\nalias b=:\nexit 0\na", true),
		("self-alias", "shopt -s expand_aliases\nalias self='self'\nexit 0\nself", true),
		(
			"comment-then-next-line",
			"shopt -s expand_aliases\nalias noted='# n'\nexit 0\nnoted x\n:",
			true,
		),
		("zsh-empty", "emulate zsh\nalias noop=''\nexit 0\nnoop", false),
		(
			"nested-expansion-tail",
			"shopt -s expand_aliases\nalias a='b :'\nalias b=''\nexit 0\na",
			true,
		),
		(
			"nested-comment-tail",
			"shopt -s expand_aliases\nalias a='b\n:'\nalias b='# comment'\nexit 0\na",
			true,
		),
		("repeated-empty-word", "shopt -s expand_aliases\nalias a=''\nexit 0\na a", false),
		("repeated-empty-line", "shopt -s expand_aliases\nalias a=''\nexit 0\na\na", false),
		("partly-quoted-word", "shopt -s expand_aliases\nalias a='# comment'\nexit 0\na''", true),
		("continued-name", "shopt -s expand_aliases\nalias noop=''\nexit 0\nno\\\nop", false),
		("mutual-alias", "shopt -s expand_aliases\nalias a=b\nalias b=a\nexit 0\na", true),
		("pending-active-alias", "shopt -s expand_aliases\nalias a='exit 0\na'\na", true),
		("pending-empty-alias", "shopt -s expand_aliases\nalias a='exit 0\nb'\nalias b=''\na", false),
	] {
		let shell = Shell::new(None);
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.into(), ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("shell run");
		let output: String = rx.try_iter().collect();
		assert!(output.is_empty(), "{name}: suffix ran: {command}");
		assert_eq!(result.ended_by_exit, expected, "{name} (exit {:?}): {command}", result.exit_code);
	}
}

/// Matrix: errexit after a function `return` attributes from the caller's
/// continuation, not the function's already-abandoned suffix (F3). The
/// return committed the frame to unwind; only input that would resume after
/// the call counts. BASH twins pin the shared expectation.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_zsh_errexit_after_return_boundary() {
	let _guard = shell_test_lock().lock().await;
	for (name, dialect, command, expected_exit, expected_output, expected) in [
		(
			"fn-suffix",
			"zsh",
			"emulate zsh\nset -e; f() { return 1; printf unreachable; }; f",
			1,
			"",
			false,
		),
		(
			"caller-suffix",
			"zsh",
			"emulate zsh\nset -e; f() { return 1; }; f; printf live",
			1,
			"",
			true,
		),
		(
			"both-suffixes",
			"zsh",
			"emulate zsh\nset -e; f() { return 1; printf unreachable; }; f; printf live",
			1,
			"",
			true,
		),
		("no-suffix", "zsh", "emulate zsh\nset -e; f() { return 1; }; f", 1, "", false),
		(
			"success-return",
			"zsh",
			"emulate zsh\nset -e; f() { return 0; printf unreachable; }; f; printf live",
			0,
			"live",
			false,
		),
		(
			"errexit-off",
			"zsh",
			"emulate zsh\nset +e; f() { return 1; printf unreachable; }; f",
			1,
			"",
			false,
		),
		("bash-fn-suffix", "bash", "set -e; f() { return 1; printf unreachable; }; f", 1, "", false),
		(
			"bash-caller-suffix",
			"bash",
			"set -e; f() { return 1; printf unreachable; }; f; printf live",
			1,
			"",
			true,
		),
		("bash-no-suffix", "bash", "set -e; f() { return 1; }; f", 1, "", false),
		(
			"zsh-eval-return",
			"zsh",
			"emulate zsh\nset -e; f() { eval 'return 1; printf abandoned'; printf abandoned; }; f",
			1,
			"",
			false,
		),
		(
			"zsh-nested-return",
			"zsh",
			"emulate zsh\nset -e; g() { return 1; printf abandoned; }; f() { g; }; f",
			1,
			"",
			false,
		),
		(
			"zsh-nested-caller",
			"zsh",
			"emulate zsh\nset -e; g() { return 1; printf abandoned; }; f() { g; printf live; }; f",
			1,
			"",
			true,
		),
		(
			"zsh-return-in-loop",
			"zsh",
			"emulate zsh\nset -e; f() { for i in 1; do return 1; printf unreachable; done; }; f; \
			 printf live",
			1,
			"",
			true,
		),
	] {
		for trap in ["", "trap ':' ZERR; ", "TRAPZERR() { :; }; "] {
			if dialect == "bash" && !trap.is_empty() {
				continue;
			}
			let command = command
				.replace("set -e;", &format!("set -e; {trap}"))
				.replace("set +e;", &format!("set +e; {trap}"));
			let shell = Shell::new(None);
			let (tx, rx) = flume::unbounded();
			let result = shell
				.run(
					ShellRunOptions { command: command.clone(), ..Default::default() },
					Some(tx),
					CancelToken::default(),
				)
				.await
				.expect("shell run");
			let output: String = rx.try_iter().collect();
			assert_eq!(output, expected_output, "{name}: {command}");
			assert_eq!(result.exit_code, Some(expected_exit), "{name}: {command}");
			assert_eq!(result.ended_by_exit, expected, "{dialect} {name}: {command}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_restored_parse_carriers_and_controls() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("source directory");
	let path = root.path().join("caller.sh");
	std::fs::write(&path, "g\nnoop").expect("caller source");
	for (setup, expected) in [("shopt -s expand_aliases", true), ("shopt -u expand_aliases", true)] {
		for exiting in [false, true] {
			let transfer = if exiting { "exit 0" } else { ":" };
			let command = format!("alias noop=''\n{setup}\nemulate sh -c '{transfer}'\nnoop");
			let result = run_exit_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(if exiting { 0 } else { 127 }), "{command}");
			assert_eq!(result.ended_by_exit, exiting && expected, "{command}");
		}
	}
	// Scoped/leaking enable and disable, one/nested calls, incremental source
	// versus zsh's saved eval parse snapshot, and non-aborting return controls.
	for scoped in [false, true] {
		for outer in [false, true] {
			for carrier in ["root", "source", "nested-source", "eval", "nested-eval"] {
				for exiting in [false, true] {
					let initial = if outer { "aliases" } else { "noaliases" };
					let changed = if outer { "noaliases" } else { "aliases" };
					let local = if scoped { "localoptions " } else { "" };
					let transfer = if exiting { "exit 0" } else { "return 0" };
					let call = match carrier {
						"root" => "g\nnoop".to_string(),
						"source" => format!(". {}", quote_arg(path.to_str().unwrap())),
						"nested-source" => format!(
							"f() {{ eval {}; }}; f",
							quote_arg(&format!(". {}", quote_arg(path.to_str().unwrap())))
						),
						"eval" => "eval 'g\nnoop'".to_string(),
						_ => "f() { eval 'g\nnoop'; }; f".to_string(),
					};
					let command = format!(
						"emulate zsh\nalias noop=''\nsetopt {initial}\ng() {{ setopt {local}{changed}; \
						 {transfer}; }}\n{call}"
					);
					let effective = if scoped || carrier.contains("eval") {
						outer
					} else {
						!outer
					};
					let result = run_exit_case(&Shell::new(None), &command).await;
					assert_eq!(
						result.exit_code,
						Some(if exiting || effective { 0 } else { 127 }),
						"{command}"
					);
					assert_eq!(result.ended_by_exit, exiting && !effective, "{carrier}: {command}");
				}
			}
		}
	}
	// local - restores POSIX (a set option), not expand_aliases (a shopt).
	// The restored POSIX bit must therefore independently gate alias lookup.
	for scoped in [false, true] {
		for outer in [false, true] {
			for exiting in [false, true] {
				let initial = if outer { "-o" } else { "+o" };
				let changed = if outer { "+o" } else { "-o" };
				let local = if scoped { "local -;" } else { "" };
				let transfer = if exiting { "exit 0" } else { "return 0" };
				let command = format!(
					"set {initial} posix\nshopt -u expand_aliases\nalias noop=''\ng() {{ {local} set \
					 {changed} posix; shopt -u expand_aliases; {transfer}; }}\ng\nnoop"
				);
				let effective = if scoped { outer } else { !outer };
				let result = run_exit_case(&Shell::new(None), &command).await;
				assert_eq!(
					result.exit_code,
					Some(if exiting || effective { 0 } else { 127 }),
					"{command}"
				);
				assert_eq!(result.ended_by_exit, exiting && !effective, "{command}");
			}
		}
	}
}

// A leaking alias change can only affect the unread source, not the other
// commands already compiled in the same unit as the call.
#[tokio::test]
async fn exit_classification_alias_changes_respect_parse_timing() {
	let _guard = shell_test_lock().lock().await;
	for (separator, unrun) in [("; ", true), ("\n", false)] {
		for exiting in [false, true] {
			let transfer = if exiting { "exit 0" } else { "return 0" };
			let command = format!(
				"shopt -u expand_aliases\nalias noop=''\nf() {{ shopt -s expand_aliases; {transfer}; \
				 }}\nf{separator}noop"
			);
			let result = run_exit_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(if !exiting && unrun { 127 } else { 0 }), "{command}");
			assert_eq!(result.ended_by_exit, exiting && unrun, "{command}");
		}
	}
}

#[tokio::test]
async fn exit_classification_restored_caller_parse_context() {
	let _guard = shell_test_lock().lock().await;
	// A function's scoped option change (`setopt localoptions aliases`) must not
	// leak into the parser context that decides whether the caller's unread
	// source holds another command: each caller frame needs its own effective
	// context after counterfactual restoration, not the exiting frame's.
	for (name, command, expected_exit, expected_output, expected) in [
		// Caller has aliases disabled; f re-enables them locally and exits.
		// After restoration `noop` is an unknown word at the caller, so the
		// aborted run leaves unrun input.
		(
			"local-enable-exit-unrun-caller-word",
			"emulate zsh\nalias noop=''\nsetopt noaliases\nf() { setopt localoptions aliases; exit \
			 0; }\nf\nnoop",
			0,
			"",
			true,
		),
		// Control: returning instead of exiting reaches `noop` and fails as a
		// command, proving the caller really keeps aliases disabled.
		(
			"local-enable-return-runs-caller-word",
			"emulate zsh\nalias noop=''\nsetopt noaliases\nf() { setopt localoptions aliases; return \
			 0; }\nf\nnoop",
			127,
			"zsh:6: command not found: noop\n",
			false,
		),
		// Caller has aliases enabled; f disables them locally and exits. After
		// restoration `noop` expands to nothing, so no input was left unrun.
		(
			"local-disable-exit-expands-caller-word",
			"emulate zsh\nalias noop=''\nf() { setopt localoptions noaliases; exit 0; }\nf\nnoop",
			0,
			"",
			false,
		),
		// Control: returning keeps running; `noop` expands to nothing.
		(
			"local-disable-return-expands-caller-word",
			"emulate zsh\nalias noop=''\nf() { setopt localoptions noaliases; return 0; }\nf\nnoop",
			0,
			"",
			false,
		),
	] {
		let shell = Shell::new(None);
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.to_string(), ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("shell run");
		let output: String = rx.try_iter().collect();
		assert_eq!(output, expected_output, "{name}: {command}");
		assert_eq!(result.exit_code, Some(expected_exit), "{name}: {command}");
		assert_eq!(result.ended_by_exit, expected, "{name}: {command}");
	}
}

/// A locale nameref may change without a write to any locale variable.
/// Live execution and the counterfactual parser must agree on that change.
#[tokio::test]
async fn exit_classification_caller_locale_tracks_nameref_target_changes() {
	let _guard = shell_test_lock().lock().await;
	for (outer, inner, multibyte) in [("C", "zh_TW.Big5", true), ("zh_TW.Big5", "C", false)] {
		for scoped in [false, true] {
			for exiting in [false, true] {
				let transfer = if exiting { "exit 0" } else { "return 0" };
				let local = if scoped { "local " } else { "" };
				let command = format!(
					"unset LC_ALL LC_CTYPE LANG\nPI_EXIT_CHARSET={outer}\ndeclare -n \
					 LC_ALL=PI_EXIT_CHARSET\nshopt -s expand_aliases\nalias $'\\xa3'=''\nf() {{ \
					 {local}PI_EXIT_CHARSET={inner}; {transfer}; }}\neval $'f\\n\\xa3\\\\\\n'"
				);
				let result = run_exit_case(&Shell::new(None), &command).await;
				let final_multibyte = multibyte != scoped;
				assert_eq!(
					result.exit_code,
					Some(if !exiting && final_multibyte { 127 } else { 0 }),
					"{command}"
				);
				assert_eq!(result.ended_by_exit, exiting && final_multibyte, "{command}");
			}
		}
	}
}

/// Locale is part of the parser context too: a multibyte trailing backslash
/// is literal, while in C it escapes the newline and leaves an empty alias.
/// Return controls exercise real scope restoration independently of the walk.
#[tokio::test]
async fn exit_classification_restored_caller_charset() {
	let _guard = shell_test_lock().lock().await;
	let mut failures = Vec::new();
	for (charset, byte) in [("zh_TW.Big5", "a3"), ("ja_JP.Shift_JIS", "83"), ("zh_CN.GB18030", "81")]
	{
		for outer_multibyte in [false, true] {
			let outer = if outer_multibyte { charset } else { "C" };
			let inner = if outer_multibyte { "C" } else { charset };
			for variable in ["LC_ALL", "LC_CTYPE", "LANG"] {
				for binding in ["local", "temporary", "leaking", "retained-eval"] {
					for exiting in [false, true] {
						let transfer = if exiting { "exit 0" } else { "return 0" };
						let (body, call) = match binding {
							"local" => (format!("local {variable}={inner}; {transfer}"), "f".into()),
							"temporary" => (transfer.into(), format!("{variable}={inner} f")),
							"leaking" => (format!("{variable}={inner}; {transfer}"), "f".into()),
							_ => (format!("local {variable}={outer}; {transfer}"), "f".into()),
						};
						let prefix = if binding == "retained-eval" {
							format!("{variable}={inner} ")
						} else {
							String::new()
						};
						let command = format!(
							"unset LC_ALL LC_CTYPE LANG\n{variable}={outer}\nshopt -s \
							 expand_aliases\nalias $'\\x{byte}'=''\nf() {{ {body}; }}\n{prefix}eval \
							 $'{call}\\n\\x{byte}\\\\\\n'"
						);
						let multibyte = if matches!(binding, "leaking" | "retained-eval") {
							!outer_multibyte
						} else {
							outer_multibyte
						};
						let shell = Shell::new(None);
						let (tx, rx) = flume::unbounded();
						let result = shell
							.run(
								ShellRunOptions { command: command.clone(), ..Default::default() },
								Some(tx),
								CancelToken::default(),
							)
							.await
							.expect("shell run");
						let output: String = rx.try_iter().collect();
						let expected_code = if !exiting && multibyte { 127 } else { 0 };
						let expected_flag = exiting && multibyte;
						let output_ok = if !exiting && multibyte {
							output.contains("command not found")
						} else {
							output.is_empty()
						};
						if result.exit_code != Some(expected_code)
							|| result.ended_by_exit != expected_flag
							|| !output_ok
						{
							failures.push(format!(
								"{binding}, exiting={exiting}, expected code={expected_code}, \
								 flag={expected_flag}, actual={result:?}, output={output:?}: {command}"
							));
						}
					}
				}
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}
