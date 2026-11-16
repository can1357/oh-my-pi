//! Exit notices distinguish early exit/errexit from other shell termination.

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
	for minimized in [false, true] {
		let root = tempfile::tempdir().expect("chain directory");
		let shell = Shell::new(minimized.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
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
	assert_eq!(result.ended_by_exit, false);
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
	assert_eq!(result.ended_by_exit, true);
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
	assert_eq!(result.ended_by_exit, false);
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
			assert_eq!(result.exit_code, Some(code), "{}", src);
			assert_eq!(result.ended_by_exit, expected, "{}", src);
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
			assert_eq!(result.exit_code, Some(code), "{}", src);
			assert_eq!(result.ended_by_exit, expected, "{}", src);
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
		assert_eq!(result.ended_by_exit, false, "{command}");
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
	assert_eq!(result.ended_by_exit, false);
	// A zsh anonymous function: the exit is not at the input's end when a
	// suffix follows (it never runs); alone at the end it is trailing.
	run_exit_case(&shell, "emulate zsh").await;
	let result = run_exit_case(&shell, "() { exit 0; }; printf never").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(result.ended_by_exit, true);
	let result = run_exit_case(&shell, "() { exit 0; }").await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(result.ended_by_exit, false);
	// eval frames unwind to the caller's suffix like function frames.
	let result = run_exit_case(&shell, "eval 'exit 1'; printf never").await;
	assert_eq!(result.exit_code, Some(1));
	assert_eq!(result.ended_by_exit, true);
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
	// Without a condition the loop cannot leave through its test: nothing
	// after it would ever run, not even were the exit not to happen.
	for (command, expected) in
		[("for ((;;)); do exit 1; done", false), ("for ((;;)); do exit 1; done; printf never", false)]
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
	assert_eq!(result.ended_by_exit, true);
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
	assert_eq!(result.ended_by_exit, true);
}
