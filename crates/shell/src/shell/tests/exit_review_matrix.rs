//! Final-gate matrix: raw termination status versus a function's outgoing
//! status, conditional-only versus unconditional remaining segments, minimizer
//! on/off; first arithmetic-for header (init/test present/omitted) versus a
//! completed body's loop-back, with/without a caller suffix.

use super::*;

async fn run_case(shell: &Shell, command: &str) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: command.into(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result, rx.try_iter().collect())
}

#[tokio::test]
async fn exit_classification_later_loop_condition_does_not_replay_body() {
	let _guard = shell_test_lock().lock().await;
	for (body, printed, expected) in [
		("while exit 0; do printf body; done", "", true),
		("until exit 1; do printf body; done", "", true),
		("i=0; while ((i++ == 0)) || exit 0; do printf body; done", "body", false),
		("i=0; until ((i++ != 0)) && exit 1; do printf body; done", "body", false),
	] {
		for tail in ["", "; printf tail"] {
			let command = format!("{body}{tail}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(output, printed, "{command}");
			assert_eq!(result.ended_by_exit, expected || !tail.is_empty(), "{command}");
		}
	}
}

#[tokio::test]
async fn exit_classification_err_cleanup_cannot_mask_armed_errexit() {
	let _guard = shell_test_lock().lock().await;
	for (trap, armed, status) in [("export -Z", true, 2), ("export -Z", false, 2), (":", true, 1)] {
		for tail in ["", "; printf never"] {
			let setting = if armed { "-e" } else { "+e" };
			let command = format!("set -o posix; set {setting}; trap '{trap}' ERR; false{tail}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(status), "{command}");
			assert!(!output.contains("never"), "{command}: {output}");
			assert_eq!(result.ended_by_exit, armed && !tail.is_empty(), "{command}");
		}
	}
}

#[tokio::test]
async fn exit_classification_boundary_cleanup_is_not_ordinary_input() {
	let _guard = shell_test_lock().lock().await;
	for (trap, status) in [("exit 7", 7), ("set -e; false", 1)] {
		for (body, cut_short) in [("printf body", false), ("exit 3; printf unrun", true)] {
			let command = format!("trap 'printf cleanup; {trap}; printf unrun' EXIT; {body}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(status), "{command}");
			assert_eq!(output, if cut_short { "cleanup" } else { "bodycleanup" }, "{command}");
			assert_eq!(result.ended_by_exit, cut_short, "{command}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_segmented_continuation_uses_function_status() {
	let _guard = shell_test_lock().lock().await;
	for minimized in [false, true] {
		let root = tempfile::tempdir().expect("minimizer directory");
		for status in [0, 1] {
			for negated in [false, true] {
				let shell = Shell::new(minimized.then(|| ShellOptions {
					minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
					..Default::default()
				}));
				let prefix = if negated { "! " } else { "" };
				// Establish the outgoing status with a non-aborting subshell,
				// independently of the exit-attribution continuation walker.
				let succeeded = (status == 0) != negated;
				let (control, _) = run_case(&shell, &format!("{prefix}(exit {status})")).await;
				assert_eq!(control.exit_code, Some(i32::from(!succeeded)));
				run_case(&shell, &format!("f() {{ {prefix}exit {status}; }}")).await;
				for (suffix, expected) in [
					("", false),
					(" && printf never", succeeded),
					(" && printf never && printf later", succeeded),
					(" && printf never; printf tail", true),
					("; printf tail", true),
				] {
					let command = format!("f{suffix}");
					let (result, output) = run_case(&shell, &command).await;
					assert_eq!(result.exit_code, Some(status), "{prefix}{command}");
					assert!(output.is_empty(), "aborted suffix ran: {command}");
					assert_eq!(
						result.ended_by_exit, expected,
						"minimized={minimized}, negated={negated}, status={status}: {command}"
					);
				}
			}
		}
	}
}

/// The abort-freeze carries the frame's *own* alias table (not the root's)
/// and its grammar options — both can differ from root state, and the
/// suppression wrapper submitted for a conditional tail must be parsed as
/// `{ … } && :` before it can hide the tail.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_abort_freeze_carries_frame_parse_context() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("minimizer directory");
	for segmented in [false, true] {
		let shell = Shell::new(segmented.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		// The frame-local alias `zz='# empty'` hides `zz; printf never` in
		// both modes. The setup leaves the *root* alias absent: a probe
		// reading the root table would find the tail owed where the frame's
		// table hides it.
		let setup = "shopt -s expand_aliases; f() { alias zz='# empty'; }; f";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let result = run_case(&shell, "f; zz; printf never").await.0;
		assert_eq!(result.exit_code, Some(0), "abort status travels through the frame");
		assert!(
			!result.ended_by_exit,
			"segmented={segmented}: the frame's alias table hides the tail"
		);
		// The alias table is shell-global state: an alias installed inside a
		// function persists after it returns (bash semantics). What must not
		// happen is the *abort's frozen table* winning over the live one.
		let alias = run_case(&shell, "shopt -s expand_aliases; zz; printf still-here")
			.await
			.0;
		assert_eq!(alias.exit_code, Some(0), "the live alias table survives the abort");
		// Features: `set -o posix` inside the frame forbids the `function f
		// {}` syntax; if the frozen features did not carry that bit, the
		// same probe would parse the tail differently depending on the mode.
		let setup = "f() { set -o posix; }; f";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let result = run_case(&shell, "f; printf never").await.0;
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.ended_by_exit, "frozen features follow the aborted frame");
		// Suppressed conditional tail: `{ echo never; } && :`. Both paths
		// judge the submitted bytes and find no command: a raw `echo never`
		// probe would falsely report cut-short where the submitted wrapper
		// parses to nothing.
		let result = run_case(&shell, "exit 1 && printf never").await.0;
		assert_eq!(result.exit_code, Some(1));
		assert!(
			!result.ended_by_exit,
			"the probe judges the suppressed bytes the run would submit (segmented={segmented})"
		);
	}
}

/// A boundary `EXIT` trap that itself exits runs after the segment's input
/// ended; the engine still treats the exit as ending the logical call, so a
/// runnable `&&` successor is reported instead of silently dropped. The leg
/// decision is taken from the status the segment's input produced, not the
/// trap's status.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_boundary_trap_exit_reports_the_conditional_tail() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("minimizer directory");
	for segmented in [false, true] {
		let shell = Shell::new(segmented.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		let setup = "f() { trap 'exit 0' EXIT; :; }; g() { trap ':' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (control, control_out) = run_case(&shell, "g && printf hello").await;
		assert_eq!(control_out, "hello", "segmented={segmented}: control reaches the tail");
		assert_eq!(control.exit_code, Some(0));
		assert!(!control.ended_by_exit, "segmented={segmented}: no abort in the control");
		// The single command runs the tail before the trap fires at its end;
		// the segmented chain stops at the cleanup exit and reports the tail
		// it did not run. Neither is silent.
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "f && printf hello").await;
		assert_eq!(output, want_out, "segmented={segmented}: tail execution");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: a skipped conditional tail is never silent"
		);
		// `||` over a succeeding segment: bash runs nothing and nothing was
		// skipped, so no notice.
		let (result, output) = run_case(&shell, "f || printf never").await;
		assert_eq!(output, "", "segmented={segmented}: a succeeding segment skips `||`");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.ended_by_exit, "segmented={segmented}: no work was skipped");
		// A non-zero cleanup exit still reports the tail its own input status
		// would have run (h succeeds), and keeps the trap's status.
		let setup = "h() { trap 'exit 7' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "h && printf hello").await;
		assert_eq!(output, want_out);
		assert_eq!(result.exit_code, Some(7), "segmented={segmented}: the trap's status stands");
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: the leg is judged by the input status"
		);
		// No successor at all: the cleanup status ends the run with nothing
		// owed.
		let (result, output) = run_case(&shell, "h").await;
		assert_eq!(output, "");
		assert_eq!(result.exit_code, Some(7));
		assert!(!result.ended_by_exit, "segmented={segmented}: completed input, no notice");
		// A trap that runs while the input still has commands is a real abort
		// and keeps its notice.
		let (result, output) = run_case(&shell, "trap 'exit 7' EXIT; exit 0; printf never").await;
		assert_eq!(output, "", "segmented={segmented}: the abort hides the rest");
		assert!(
			result.ended_by_exit,
			"segmented={segmented}: a mid-input exit is still reported as cutting work short"
		);
		// A trap that rewrites the alias table must not hide the tail from
		// the report: bash parses the successor under the table the input
		// ended with, before the trap ran. (Last: the alias stays installed.)
		let setup =
			"shopt -s expand_aliases; a() { trap 'alias printf=\"# hidden\"; exit 0' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "a && printf hello").await;
		assert_eq!(output, want_out);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: judged under the input-end alias table"
		);
	}
}

/// The owed-segment probe judges the next physical run's text under the
/// environment that run would install, while the alias table is the live one
/// the next run actually reads. A frozen abort-time table must not override
/// either the locale overlay or the cleanup's alias rewrite.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_owed_segment_probe_uses_next_run_environment() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The alias `git` expands to `中` + a backslash-newline join + `x`: under
	// `C` the join makes the second alias hide the command, under Big5 the
	// backslash belongs to a multibyte character and the command survives.
	let setup = "unset LC_ALL LC_CTYPE LANG\nLANG=C\nshopt -s expand_aliases\nalias 中x='# \
	             empty'\nalias git=\"中\\\\\nx\"";
	assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
	for (body, expected_ended) in [
		("f() { LANG=zh_TW.Big5; exit 0; }; f; git log -1", false),
		("f() { LANG=zh_TW.Big5; return 0; }; f; git log -1", false),
	] {
		let (result, output) = run_case(&shell, body).await;
		assert!(
			!result.ended_by_exit || expected_ended,
			"the next run installs LANG=C; its tail expands away: {body} / {output}"
		);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_initial_arithmetic_header_keeps_unentered_body() {
	let _guard = shell_test_lock().lock().await;
	for header in ["i=0;i<1;i++", ";i<1;i++", "i=0;;i++", ";;"] {
		for suffix in ["", "; printf tail"] {
			let shell = Shell::new(None);
			// Without an exit, this first header reaches the body. A break
			// keeps omitted conditions finite without predicting termination.
			let (_, output) = run_case(
				&shell,
				&format!("i=0; trap ':' DEBUG; for (({header})); do printf body; break; done"),
			)
			.await;
			assert_eq!(output, "body", "header={header}");
			let command = format!(
				"i=0; trap 'exit 0' DEBUG; for (({header})); do printf body; break; done{suffix}"
			);
			let (result, output) = run_case(&shell, &command).await;
			assert_eq!(result.exit_code, Some(0), "{command}");
			assert!(output.is_empty(), "body ran after DEBUG exit: {command}");
			assert!(result.ended_by_exit, "first body was left unrun: {command}");

			// Once the body has reached its final exit, the iteration edge
			// must not count that same body again as new input.
			let command = format!("trap - DEBUG; i=0; for (({header})); do exit 0; done{suffix}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert!(output.is_empty(), "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
	// A DEBUG exit during a later header must not replay the body that
	// already ran; only a submitted suffix outside that loop is new input.
	for header in ["i=0;i<2;i++", ";i<2;i++"] {
		for suffix in ["", "; printf tail"] {
			let command = format!(
				"i=0; trap 'if ((i==1)); then exit 0; fi' DEBUG; for (({header})); do printf body; \
				 done{suffix}"
			);
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(output, "body", "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
}
